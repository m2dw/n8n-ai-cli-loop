/**
 * GitHub-derived L1/L2 intervention signal detection (issue #589).
 *
 * Scans already-fetched GitHub activity — issue/PR comments and commits on
 * automation branches — and emits candidate intervention signals classified
 * according to the taxonomy in intervention-taxonomy.ts.
 *
 * This module is pure (no I/O). Callers supply already-fetched GitHub data;
 * the actual `gh`/API calls live in the CLI or provider layer. Keeping
 * classification pure makes identity-separation rules independently testable.
 *
 * Identity separation follows the same pattern as github-app-review.ts:
 *   - Bot accounts (GitHub `authorType === "Bot"` or `[bot]` login suffix) are
 *     always excluded from human-signal candidates.
 *   - Explicitly configured automation actor logins are also excluded.
 *   - Commits are identified via GitHub login (authoritative) or, if absent,
 *     by author email (less reliable).
 *
 * Limitation — shared Git identity:
 *   When a human and the automation agent share the same GitHub login or Git
 *   author email (e.g. a personal account is used for both manual commits and
 *   automated pushes), commit authorship cannot be resolved from metadata alone.
 *   Set `AutomationActorConfig.sharedIdentity = true` to opt into this mode:
 *   all commits on the branch are emitted as `unknown` / `candidate` rather than
 *   being silently misclassified as L2. A warning is emitted per issue. Manual
 *   review of the commit timeline is the only reliable resolution in this case.
 *
 * Output safety:
 *   No local artifact paths (worktree paths, absolute file paths) appear in scan
 *   output. Comment URLs must be GitHub permalinks; the caller is responsible for
 *   not passing local paths in input fields.
 *
 * Classification direction (from issue #589):
 *   - Human comments that redirect, clarify, or supplement automation after
 *     queue entry are `issue_comment_guidance` / `pr_comment_guidance` → L1.
 *   - Human-authored commits on automation branches are
 *     `human_commit_on_ai_branch` → L2 (confirmed when identity is clear).
 *   - Closed-without-merge PRs are recorded as `closed_unmerged` outcomes, not
 *     as interventions. A PR abandonment does not by itself prove human action.
 *   - Review/fix comments from configured automation actors are automation
 *     self-repair, not human intervention.
 */

import { classifyIntervention } from "./intervention-taxonomy.js";
import type { InterventionClassification } from "./intervention-taxonomy.js";
import { isBotAuthor } from "./github-app-review.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** A single comment on a GitHub issue or PR, as supplied by the caller. */
export interface GhScanComment {
  /** GitHub comment id (for dedup by callers). */
  id?: string;
  /** GitHub login of the comment author. Empty string when unknown. */
  author: string;
  /** GitHub account type for the author ("Bot" | "User" | ...). */
  authorType?: string;
  /** Comment body text. */
  body: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /**
   * GitHub permalink to the comment.
   * Must be a GitHub URL — must NOT contain local worktree or filesystem paths.
   */
  url?: string;
}

/** A single commit on a GitHub PR branch, as supplied by the caller. */
export interface GhScanCommit {
  /** Full commit SHA. */
  sha: string;
  /**
   * GitHub login of the commit author, when available via the GitHub Commits API.
   * This is the most reliable identity source; prefer it over authorEmail.
   */
  authorLogin?: string;
  /** GitHub account type for the author ("Bot" | "User" | ...). */
  authorType?: string;
  /**
   * Git commit author email. Less reliable than authorLogin because it can be
   * spoofed, shared, or absent. Used as a secondary signal when authorLogin is
   * not available.
   */
  authorEmail?: string;
  /** ISO-8601 commit timestamp. */
  committedAt: string;
}

/** State of a PR review submission. */
export type GhPrReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

/** An individual inline review comment attached to a PR review. */
export interface GhScanReviewComment {
  id?: string;
  /** GitHub login of the comment author. Empty string when unknown. */
  author: string;
  /** GitHub account type ("Bot" | "User" | ...). */
  authorType?: string;
  /** Comment body text. */
  body: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /**
   * GitHub permalink to the comment.
   * Must be a GitHub URL — must NOT contain local worktree or filesystem paths.
   */
  url?: string;
}

/**
 * A PR review submission (state + body + inline comments), as supplied by the caller.
 * Includes both `CHANGES_REQUESTED` reviews and inline review comments.
 */
export interface GhScanReview {
  id?: string;
  /** GitHub login of the review author. */
  author: string;
  /** GitHub account type ("Bot" | "User" | ...). */
  authorType?: string;
  /**
   * Review state.
   * APPROVED reviews are excluded from L1 detection (planned human gate).
   * CHANGES_REQUESTED reviews are always emitted as L1 (structural signal, not keyword-based).
   * COMMENTED / DISMISSED reviews with a non-empty body are emitted as unknown/candidate.
   */
  state: GhPrReviewState;
  /** Main review body (may be empty for inline-only reviews). */
  body: string;
  /** ISO-8601 timestamp when the review was submitted. */
  submittedAt: string;
  /**
   * GitHub permalink to the review.
   * Must be a GitHub URL — must NOT contain local worktree or filesystem paths.
   */
  url?: string;
  /** Inline review comments attached to this review. */
  comments?: GhScanReviewComment[];
}

/** State of a PR at the time of scanning. */
export type GhPrOutcomeState = "open" | "merged" | "closed_unmerged";

/** Scan input for a single issue/PR pair. */
export interface GhIssueScanInput {
  /** Issue number being scanned. */
  issueNumber: number;
  /**
   * ISO-8601 timestamp when automation queued this issue (first claimed it).
   * Issue comments created at or before this time are excluded from L1 detection
   * (they predate automation and cannot be responses to it).
   */
  queuedAt: string;
  /** Comments on the GitHub issue thread (not PR reviews). */
  issueComments?: GhScanComment[];
  /**
   * Top-level comments on the PR conversation thread.
   * PR review comments are handled separately by github-app-review.ts for the
   * human-review-return flow; this field is for general PR discussion comments.
   */
  prComments?: GhScanComment[];
  /**
   * PR review submissions (state, body, inline comments).
   * Includes `CHANGES_REQUESTED` reviews and inline review comments, which are
   * normal L1 guidance signals. `APPROVED` reviews are excluded automatically.
   */
  prReviews?: GhScanReview[];
  /** Commits on the automation-owned PR branch. */
  prCommits?: GhScanCommit[];
  /** Current state of the PR, if one exists for this issue. */
  prOutcome?: GhPrOutcomeState;
}

// ---------------------------------------------------------------------------
// Automation identity configuration
// ---------------------------------------------------------------------------

/**
 * Configured automation actor identities.
 *
 * Used to distinguish human activity from bot/agent activity when GitHub's own
 * `authorType` field is not sufficient (e.g. when the automation runs under a
 * regular GitHub User account rather than a GitHub App / Bot account).
 */
export interface AutomationActorConfig {
  /**
   * GitHub logins that are automation actors, in addition to bot accounts
   * detected by the `[bot]` suffix or `authorType === "Bot"`.
   * Comparison is case-insensitive.
   */
  actorLogins?: string[];
  /**
   * Git commit author emails treated as automation actors.
   * Used as a secondary identity check when `authorLogin` is absent on a commit.
   * Comparison is case-insensitive.
   */
  actorEmails?: string[];
  /**
   * When false, disables the GitHub `authorType === "Bot"` marker as a bot
   * detection signal. Defaults to `true` (the marker is trusted).
   * Set to `false` only in tests that need to override the marker behavior.
   */
  trustBotType?: boolean;
  /**
   * Set to `true` when a human and the automation agent share the same GitHub
   * login or Git author email.
   *
   * In this mode all commits on the branch are emitted as `unknown` / candidate
   * signals rather than being misclassified as confirmed L2. A per-issue warning
   * is also emitted in the scan result. Manual review of commit timestamps and
   * PR activity is the only reliable resolution strategy.
   */
  sharedIdentity?: boolean;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** A detected L1/L2 candidate intervention signal from GitHub activity. */
export interface GhInterventionSignal {
  /** Issue number the signal belongs to. */
  issueNumber: number;
  /** Intervention classification (level, signal kind, reason). */
  classification: InterventionClassification;
  /** ISO-8601 timestamp of the triggering event, when available. */
  detectedAt?: string;
  /**
   * GitHub login of the actor.
   * Never contains local artifact paths or filesystem paths.
   */
  author?: string;
  /**
   * One-line human-readable summary for audit output and diagnostics.
   * Contains only GitHub-relative identifiers (issue number, login, short SHA).
   */
  context?: string;
  /**
   * True when the actor's identity cannot be reliably resolved (shared human/
   * automation identity or missing identity information on the commit).
   * Signals with this flag set should be reviewed manually before counting.
   */
  identityAmbiguous?: boolean;
}

/**
 * A PR that was closed without being merged.
 * Reported separately from intervention signals — a closed-unmerged PR is a
 * failed/abandoned outcome, not necessarily a human intervention on its own.
 */
export interface GhClosedUnmergedOutcome {
  issueNumber: number;
  outcome: "closed_unmerged";
}

/** Combined scan result for one or more issues. */
export interface GhScanResult {
  /** Candidate L1/L2 intervention signals detected across all scanned issues. */
  signals: GhInterventionSignal[];
  /**
   * PRs that were closed without merging.
   * Callers should treat these as potential failure outcomes, not as counted
   * human interventions, unless additional context confirms human action.
   */
  closedUnmergedOutcomes: GhClosedUnmergedOutcome[];
  /**
   * Diagnostic warnings (e.g. shared-identity limitation notices).
   * Not errors — the scan still completes; these require manual follow-up.
   */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildExcludedLoginSet(config: AutomationActorConfig): Set<string> {
  return new Set((config.actorLogins ?? []).map((l) => l.toLowerCase()));
}

function buildExcludedEmailSet(config: AutomationActorConfig): Set<string> {
  return new Set((config.actorEmails ?? []).map((e) => e.toLowerCase()));
}

function isAutomationComment(
  comment: GhScanComment,
  config: AutomationActorConfig,
  excludedLogins: Set<string>,
): boolean {
  // Pass authorType only when trustBotType is enabled; the [bot] login suffix
  // check inside isBotAuthor runs regardless so conventional bot logins are
  // always excluded.
  const authorType = config.trustBotType !== false ? comment.authorType : undefined;
  if (isBotAuthor(comment.author, authorType)) return true;
  // In shared-identity mode the login is shared between human and automation;
  // callers emit these as ambiguous candidates rather than excluding them.
  if (!config.sharedIdentity && comment.author && excludedLogins.has(comment.author.toLowerCase())) return true;
  return false;
}

/**
 * Returns true when a comment body contains language consistent with
 * redirecting, clarifying, or supplementing automation — the L1 guidance
 * definition from the taxonomy.
 *
 * Short acknowledgements, LGTM-style phrases, and merge-approval statements
 * are explicitly excluded: the taxonomy classifies those as `merge_approval` /
 * `planned_human_gate` (not interventions), not as L1 guidance.
 *
 * Comments that match neither pattern are ambiguous; callers should emit
 * `unknown` (candidate) rather than a definite L1 signal.
 */
export function looksLikeGuidance(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;

  // Single-phrase non-guidance responses: acknowledgements, LGTM-variants,
  // merge approvals. The taxonomy excludes these from L1 intervention counts.
  const PLAIN_NON_GUIDANCE =
    /^(?:thanks?(?:\s+you)?|lgtm|looks?\s+good(?:\s+to\s+me)?|approved?|merged?|great(?:\s+work)?|nice(?:\s+(?:work|job))?|well\s+done|sounds?\s+good|perfect|ok(?:ay)?|done|resolved?|ship\s+it|[👍✅🎉]+)[\s!.]*$/i;
  if (PLAIN_NON_GUIDANCE.test(trimmed)) return false;

  // Guidance indicators: imperative or request language, or explicit direction
  // / clarification content that supplements or redirects automation.
  const GUIDANCE_KEYWORDS =
    /\b(?:please|can\s+you|could\s+you|don['']?t|do\s+not|avoid|instead|fix|change|update|revert|refactor|add|remove|clarify|explain|reconsider|ensure|make\s+sure|need\s+to|must|wrong|incorrect|missing|should)\b/i;
  return GUIDANCE_KEYWORDS.test(trimmed);
}

// ---------------------------------------------------------------------------
// Scanning functions
// ---------------------------------------------------------------------------

/**
 * Scan issue comments for L1 signals.
 *
 * Only comments created AFTER `queuedAt` are considered — comments that
 * predate automation cannot be responses to its work.
 */
export function scanIssueComments(
  issueNumber: number,
  comments: GhScanComment[],
  queuedAt: string,
  config: AutomationActorConfig,
): GhInterventionSignal[] {
  const excludedLogins = buildExcludedLoginSet(config);
  const queuedMs = Date.parse(queuedAt);

  return comments.flatMap((c): GhInterventionSignal[] => {
    const createdMs = Date.parse(c.createdAt);
    if (!Number.isNaN(queuedMs) && !Number.isNaN(createdMs) && createdMs <= queuedMs) {
      return [];
    }
    if (isAutomationComment(c, config, excludedLogins)) return [];

    if (!c.author) {
      return [
        {
          issueNumber,
          classification: classifyIntervention("unknown"),
          detectedAt: c.createdAt,
          context: `Issue #${issueNumber}: issue comment — author unresolved`,
          identityAmbiguous: true,
        },
      ];
    }

    // Shared-identity login in actorLogins: cannot distinguish human from automation.
    if (config.sharedIdentity && excludedLogins.has(c.author.toLowerCase())) {
      return [
        {
          issueNumber,
          classification: classifyIntervention("unknown"),
          detectedAt: c.createdAt,
          author: c.author,
          context: `Issue #${issueNumber}: comment by @${c.author} — shared identity, authorship unresolvable`,
          identityAmbiguous: true,
        },
      ];
    }

    return [
      {
        issueNumber,
        classification: classifyIntervention("unknown"),
        detectedAt: c.createdAt,
        author: c.author,
        context: `Issue #${issueNumber}: comment by @${c.author}`,
      },
    ];
  });
}

/**
 * Scan PR top-level comments for L1 signals.
 *
 * Only comments created AFTER `queuedAt` are considered — comments predating
 * automation queue entry cannot be responses to its work.
 */
export function scanPrComments(
  issueNumber: number,
  comments: GhScanComment[],
  queuedAt: string,
  config: AutomationActorConfig,
): GhInterventionSignal[] {
  const excludedLogins = buildExcludedLoginSet(config);
  const queuedMs = Date.parse(queuedAt);

  return comments.flatMap((c): GhInterventionSignal[] => {
    const createdMs = Date.parse(c.createdAt);
    if (!Number.isNaN(queuedMs) && !Number.isNaN(createdMs) && createdMs <= queuedMs) {
      return [];
    }
    if (isAutomationComment(c, config, excludedLogins)) return [];

    if (!c.author) {
      return [
        {
          issueNumber,
          classification: classifyIntervention("unknown"),
          detectedAt: c.createdAt,
          context: `Issue #${issueNumber}: PR comment — author unresolved`,
          identityAmbiguous: true,
        },
      ];
    }

    // Shared-identity login in actorLogins: cannot distinguish human from automation.
    if (config.sharedIdentity && excludedLogins.has(c.author.toLowerCase())) {
      return [
        {
          issueNumber,
          classification: classifyIntervention("unknown"),
          detectedAt: c.createdAt,
          author: c.author,
          context: `Issue #${issueNumber}: PR comment by @${c.author} — shared identity, authorship unresolvable`,
          identityAmbiguous: true,
        },
      ];
    }

    return [
      {
        issueNumber,
        classification: classifyIntervention("unknown"),
        detectedAt: c.createdAt,
        author: c.author,
        context: `Issue #${issueNumber}: PR comment by @${c.author}`,
      },
    ];
  });
}

/**
 * Scan PR reviews (state, body, inline comments) for L1 signals.
 *
 * Classification rules:
 *   - `APPROVED` reviews → skipped (planned human gate, not an intervention).
 *   - `CHANGES_REQUESTED` → always emitted as `pr_comment_guidance` (L1), even
 *     when the review body is empty — the review state itself is guidance.
 *   - `COMMENTED` / `DISMISSED` with a non-empty body → emitted as `unknown`
 *     (candidate). Semantic intent is left to the aggregation layer, not
 *     resolved by keyword heuristics. Reviews with an empty body and no inline
 *     comments emit no review-level signal.
 *   - Inline review comments → checked per-comment (author may differ from the
 *     review author); emitted as `unknown` (candidate).
 *   - Automation-authored reviews and inline comments are excluded.
 */
export function scanPrReviews(
  issueNumber: number,
  reviews: GhScanReview[],
  queuedAt: string,
  config: AutomationActorConfig,
): GhInterventionSignal[] {
  const excludedLogins = buildExcludedLoginSet(config);
  const queuedMs = Date.parse(queuedAt);
  const signals: GhInterventionSignal[] = [];

  for (const review of reviews) {
    const reviewMs = Date.parse(review.submittedAt);
    if (!Number.isNaN(queuedMs) && !Number.isNaN(reviewMs) && reviewMs <= queuedMs) {
      continue;
    }

    // PENDING reviews are unsubmitted drafts — ignore entirely.
    if (review.state === "PENDING") {
      continue;
    }

    const isApproved = review.state === "APPROVED";
    const isChangesRequested = review.state === "CHANGES_REQUESTED";

    // Review-level signal — check review author.
    const reviewAuthorType = config.trustBotType !== false ? review.authorType : undefined;
    const reviewIsBotOrExcluded =
      isBotAuthor(review.author, reviewAuthorType) ||
      (!config.sharedIdentity && !!review.author && excludedLogins.has(review.author.toLowerCase()));
    const reviewIsSharedLogin =
      config.sharedIdentity && !!review.author && excludedLogins.has(review.author.toLowerCase());

    if (!isApproved && !reviewIsBotOrExcluded) {
      if (!review.author) {
        signals.push({
          issueNumber,
          classification: classifyIntervention("unknown"),
          detectedAt: review.submittedAt,
          context: `Issue #${issueNumber}: PR review (${review.state}) — author unresolved`,
          identityAmbiguous: true,
        });
      } else if (reviewIsSharedLogin) {
        signals.push({
          issueNumber,
          classification: classifyIntervention("unknown"),
          detectedAt: review.submittedAt,
          author: review.author,
          context: `Issue #${issueNumber}: PR ${review.state} review by @${review.author} — shared identity, authorship unresolvable`,
          identityAmbiguous: true,
        });
      } else if (isChangesRequested || review.body?.trim()) {
        const signal = isChangesRequested ? "pr_comment_guidance" : "unknown";
        signals.push({
          issueNumber,
          classification: classifyIntervention(signal),
          detectedAt: review.submittedAt,
          author: review.author,
          context: `Issue #${issueNumber}: PR ${review.state} review by @${review.author}`,
        });
      }
    }

    // Inline review comments — each has its own author identity check and cutoff.
    for (const rc of review.comments ?? []) {
      const rcCreatedMs = Date.parse(rc.createdAt);
      if (!Number.isNaN(queuedMs) && !Number.isNaN(rcCreatedMs) && rcCreatedMs <= queuedMs) {
        continue;
      }

      const rcAuthorType = config.trustBotType !== false ? rc.authorType : undefined;
      const rcIsBotOrExcluded =
        isBotAuthor(rc.author, rcAuthorType) ||
        (!config.sharedIdentity && !!rc.author && excludedLogins.has(rc.author.toLowerCase()));
      const rcIsSharedLogin =
        config.sharedIdentity && !!rc.author && excludedLogins.has(rc.author.toLowerCase());

      if (rcIsBotOrExcluded) continue;

      if (!rc.author) {
        signals.push({
          issueNumber,
          classification: classifyIntervention("unknown"),
          detectedAt: rc.createdAt,
          context: `Issue #${issueNumber}: PR inline review comment — author unresolved`,
          identityAmbiguous: true,
        });
      } else if (rcIsSharedLogin) {
        signals.push({
          issueNumber,
          classification: classifyIntervention("unknown"),
          detectedAt: rc.createdAt,
          author: rc.author,
          context: `Issue #${issueNumber}: PR inline review comment by @${rc.author} — shared identity, authorship unresolvable`,
          identityAmbiguous: true,
        });
      } else {
        signals.push({
          issueNumber,
          classification: classifyIntervention("unknown"),
          detectedAt: rc.createdAt,
          author: rc.author,
          context: `Issue #${issueNumber}: PR inline review comment by @${rc.author}`,
        });
      }
    }
  }

  return signals;
}

/**
 * Scan commits on an automation-owned PR branch for L2 signals.
 *
 * Classification rules (checked in order):
 *   - Bot suffix (`[bot]`) or bot authorType → excluded (no signal emitted).
 *   - Configured automation actor (login or email) → excluded (no signal emitted).
 *   - `sharedIdentity` is true → `unknown` (candidate) for surviving commits.
 *   - `authorLogin` present, not bot/automation → `human_commit_on_ai_branch` (L2, confirmed).
 *   - `authorLogin` absent, `authorEmail` present and not in automation list
 *     → `unknown` (candidate; email-only identity is less reliable).
 *   - No identity information → `unknown` (candidate).
 */
export function scanPrCommits(
  issueNumber: number,
  commits: GhScanCommit[],
  config: AutomationActorConfig,
): GhInterventionSignal[] {
  const excludedLogins = buildExcludedLoginSet(config);
  const excludedEmails = buildExcludedEmailSet(config);

  return commits.flatMap((commit): GhInterventionSignal[] => {
    const sha7 = commit.sha.slice(0, 7);

    const login = commit.authorLogin;
    const email = commit.authorEmail;

    if (login) {
      // Bot by type or [bot] suffix → automation, skip.  Pass authorType only
      // when trustBotType is enabled; the [bot] suffix check always runs.
      const authorType = config.trustBotType !== false ? commit.authorType : undefined;
      if (isBotAuthor(login, authorType)) return [];
      // Configured automation login → skip.
      // Exception: when sharedIdentity is enabled, the shared automation
      // account may appear in actorLogins but commits must still surface as
      // ambiguous candidates — silently dropping them defeats the contract
      // that all non-bot commits require manual review in this mode.
      if (excludedLogins.has(login.toLowerCase()) && !config.sharedIdentity) return [];
      // Shared identity: bot/actor checks passed but authorship is still unresolvable.
      if (config.sharedIdentity) {
        return [
          {
            issueNumber,
            classification: classifyIntervention("unknown"),
            detectedAt: commit.committedAt,
            author: login,
            context: `Issue #${issueNumber}: commit ${sha7} — shared identity, authorship unresolvable`,
            identityAmbiguous: true,
          },
        ];
      }
      // Human-authored commit — confirmed L2.
      return [
        {
          issueNumber,
          classification: classifyIntervention("human_commit_on_ai_branch"),
          detectedAt: commit.committedAt,
          author: login,
          context: `Issue #${issueNumber}: commit ${sha7} by @${login}`,
        },
      ];
    }

    if (email) {
      // Configured automation email → skip.
      // Exception: when sharedIdentity is enabled, the shared account may be
      // listed in actorEmails but the commit must still surface as an ambiguous
      // candidate — same reasoning as the login exclusion above.
      if (excludedEmails.has(email.toLowerCase()) && !config.sharedIdentity) return [];
      // Email not in exclusion list but no login → identity uncertain.
      // The raw email is omitted: commit metadata is untrusted and may contain
      // local artifact paths; the candidate signal is preserved without it.
      return [
        {
          issueNumber,
          classification: classifyIntervention("unknown"),
          detectedAt: commit.committedAt,
          context: `Issue #${issueNumber}: commit ${sha7} — login unavailable, email-only identity`,
          identityAmbiguous: true,
        },
      ];
    }

    // No identity information at all.
    return [
      {
        issueNumber,
        classification: classifyIntervention("unknown"),
        detectedAt: commit.committedAt,
        context: `Issue #${issueNumber}: commit ${sha7} — no identity information`,
        identityAmbiguous: true,
      },
    ];
  });
}

/**
 * Scan a single issue for L1/L2 signals and PR outcome.
 */
export function scanIssue(
  input: GhIssueScanInput,
  config: AutomationActorConfig,
): { signals: GhInterventionSignal[]; closedUnmergedOutcomes: GhClosedUnmergedOutcome[]; warnings: string[] } {
  const signals: GhInterventionSignal[] = [];
  const warnings: string[] = [];

  if (input.issueComments?.length) {
    signals.push(
      ...scanIssueComments(input.issueNumber, input.issueComments, input.queuedAt, config),
    );
  }

  if (input.prComments?.length) {
    signals.push(...scanPrComments(input.issueNumber, input.prComments, input.queuedAt, config));
  }

  if (input.prReviews?.length) {
    signals.push(...scanPrReviews(input.issueNumber, input.prReviews, input.queuedAt, config));
  }

  if (input.prCommits?.length) {
    if (config.sharedIdentity) {
      warnings.push(
        `Issue #${input.issueNumber}: human and automation share a shared Git identity — ` +
          `commit authorship cannot be resolved; all commits reported as candidate/unknown. ` +
          `Manual review of commit timestamps is required.`,
      );
    }
    signals.push(...scanPrCommits(input.issueNumber, input.prCommits, config));
  }

  const closedUnmergedOutcomes: GhClosedUnmergedOutcome[] = [];
  if (input.prOutcome === "closed_unmerged") {
    closedUnmergedOutcomes.push({
      issueNumber: input.issueNumber,
      outcome: "closed_unmerged",
    });
  }

  return { signals, closedUnmergedOutcomes, warnings };
}

/**
 * Reporting date range for filtering emitted signals by event timestamp.
 *
 * Both bounds are inclusive. Omit a bound to leave that end open.
 * Signals whose `detectedAt` timestamp falls outside the range are dropped.
 * Signals with no `detectedAt` are always included (no timestamp to filter by).
 */
export interface GhScanDateRange {
  /** ISO-8601 inclusive start of the reporting window. */
  start?: string;
  /** ISO-8601 inclusive end of the reporting window. */
  end?: string;
}

function isWithinRange(timestamp: string | undefined, range: GhScanDateRange): boolean {
  if (!timestamp) return true;
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts)) return true;
  if (range.start !== undefined) {
    const startMs = Date.parse(range.start);
    if (!Number.isNaN(startMs) && ts < startMs) return false;
  }
  if (range.end !== undefined) {
    const endMs = Date.parse(range.end);
    if (!Number.isNaN(endMs) && ts > endMs) return false;
  }
  return true;
}

/**
 * Scan multiple issues for L1/L2 signals and PR outcomes.
 *
 * Callers control which issues are included (e.g. filter by session label before
 * passing `inputs`). Per-issue `queuedAt` gates L1 comment detection to the
 * post-automation window.
 *
 * The optional `range` parameter filters emitted signals by their `detectedAt`
 * timestamp. Comments or commits that fall outside the window are dropped even
 * when the containing issue is included in `inputs`. This is necessary because
 * the same issue can span reporting periods. Closed-unmerged outcomes are not
 * filtered by range (they represent current PR state, not a timestamped event).
 */
export function scanSession(
  inputs: GhIssueScanInput[],
  config: AutomationActorConfig,
  range?: GhScanDateRange,
): GhScanResult {
  const signals: GhInterventionSignal[] = [];
  const closedUnmergedOutcomes: GhClosedUnmergedOutcome[] = [];
  const warnings: string[] = [];

  for (const input of inputs) {
    const result = scanIssue(input, config);
    const filteredSignals = range
      ? result.signals.filter((s) => isWithinRange(s.detectedAt, range))
      : result.signals;
    signals.push(...filteredSignals);
    closedUnmergedOutcomes.push(...result.closedUnmergedOutcomes);
    warnings.push(...result.warnings);
  }

  return { signals, closedUnmergedOutcomes, warnings };
}
