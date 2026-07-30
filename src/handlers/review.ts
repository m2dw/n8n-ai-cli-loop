import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { AiTask } from "../core/task.js";
import type { PhaseHandler, PhaseHandlerContext, PhaseHandlerResult } from "../core/phase-runner.js";
import { defaultCommandRunner } from "./command-runner.js";
import type { CommandRunner } from "./command-runner.js";
import { classifyReviewOutput, BLOCKING_PATTERNS } from "../core/review-classifier.js";
import { classifyQuotaExhaustion, resolveRetryDelayOverrideMsForCategory, describeFailureCategory } from "../core/quota-classifier.js";
import { extractAgentFailureDiagnostic } from "../core/agent-diagnostics.js";
import { runArtifactDir, writeAssignmentFailureArtifact, ARTIFACT_DIR_PENDING_CONTEXT_FIELD } from "./artifact-dir.js";
import { agentForPhase, readResolvedAssignment } from "../core/assignment.js";
import { resolvePrContext, branchName } from "./pr-helpers.js";
import { ghRunnerFromCommandRunner } from "../providers/github/gh-runner.js";
import { resolveSessionRepoHost } from "../providers/repo-host-factory.js";
import type { SessionRepoHost } from "../providers/repo-host-factory.js";
import { parseShellTokens, buildIssueVerificationStatus, type IssueRequiredVerification, type ManualVerificationEntry } from "./verification.js";
import { extractIssueVerificationCommands } from "./issue-verification-extractor.js";
import { clearPrepareSentinel, ensureEnvironmentPrepared } from "./environment-prepare.js";
import { labelsToReviewStrength, type ReviewStrength } from "../core/github-intake.js";
import type { CodexConfig } from "../core/session.js";
import { resolveCodexContextMode, resolveCodexModel, providerForAgent } from "./codex-context-mode.js";
import { resolveIssueWorktree, removeWorktree, IssueWorktreeLock, issueLockScope, canonicalizePath, isPathInside } from "./worktree.js";
import { resolveWorktreeRoot, issueWorktreePath } from "../core/worktree-paths.js";
import { checkReviewAdmission } from "./review-admission.js";
import { type DiffClassification, classifyDiffFromUnified } from "../core/review-diff-context.js";

// ---------------------------------------------------------------------------
// Agent command selection
// ---------------------------------------------------------------------------

export interface ResolvedReviewProfile {
  phase: "review";
  agentId: string;
  cmd: string;
  /** Sanitized argv — excludes prompt content (--title value for Codex; stdin for Claude). */
  argv: string[];
  /**
   * Source of the model selection.
   * `cli-default` — Codex, unset (compatibility mode: the Codex CLI's own
   *   config/default selects the model; not explicitly passed by this handler).
   * `session-config` — Codex, resolved from `session.codex.model`.
   * `env` — Codex (`CODEX_MODEL`) or Claude (`CLAUDE_MODEL`).
   * `label` | `default` — Claude (model explicitly selected by this handler).
   */
  modelSource: "cli-default" | "session-config" | "env" | "label" | "default";
  /** Resolved model name — the literal "cli-default" for Codex compatibility mode. */
  model?: string;
  /** Resolved effort/reasoning-strength tier passed to the agent. */
  effort?: string;
  /** Source of the effort selection. */
  effortSource?: "env" | "label" | "complexity" | "default";
  reviewStrength: ReviewStrength;
  reviewStrengthSource: "label" | "complexity" | "default";
  /**
   * Source of the review binary path. Present for Gemini/Antigravity ("env" when
   * ANTIGRAVITY_BIN was set, "cli-default" otherwise). Absent for Codex.
   */
  cmdSource?: "env" | "cli-default";
  /** Company/provider backing the agent (e.g. "anthropic", "openai", "google"). */
  provider: string;
  /**
   * Codex context-mode status. `enabled`/`unset` for Codex; `n/a` for agents that
   * have no context-mode capability (Claude, Gemini/Antigravity).
   */
  contextMode: "enabled" | "unset" | "n/a";
  /** Source of the context-mode decision. */
  contextModeSource: "session" | "env" | "default";
  /** Resolved Codex context-mode invocation overrides, recorded when enabled. */
  contextModeConfig?: string[];
}

function resolveClaudeReviewProfile(
  reviewStrength: ReviewStrength,
  reviewStrengthSource: "label" | "complexity" | "default",
): { cmd: string; baseArgs: string[]; resolvedProfile: ResolvedReviewProfile } {
  const envModel = process.env["CLAUDE_MODEL"];
  const envEffort = process.env["CLAUDE_EFFORT"];

  const defaultModel = reviewStrength === "high" ? "opus" : "sonnet";
  const model = envModel ?? defaultModel;
  const modelSource: ResolvedReviewProfile["modelSource"] = envModel
    ? "env"
    : reviewStrengthSource === "default"
    ? "default"
    : "label";

  const defaultEffort = reviewStrength === "low" ? "low"
    : reviewStrength === "high" ? "high"
    : reviewStrengthSource === "label" ? "medium"
    : "high";
  const effort = envEffort ?? defaultEffort;
  const effortSource: "env" | "label" | "default" = envEffort
    ? "env"
    : reviewStrengthSource === "default"
    ? "default"
    : "label";

  const argv = ["-p", "--model", model, "--effort", effort];
  const resolvedProfile: ResolvedReviewProfile = {
    phase: "review", agentId: "claude", cmd: "claude", argv,
    model, modelSource, effort, effortSource,
    reviewStrength, reviewStrengthSource,
    provider: providerForAgent("claude"),
    // Context-mode is a Codex-only capability; never applies to Claude (issue #376).
    contextMode: "n/a", contextModeSource: "default",
  };
  return { cmd: "claude", baseArgs: argv, resolvedProfile };
}

// Resolve the explicit Codex `model_reasoning_effort` level for the review lane.
// `CODEX_EFFORT` (when set) wins outright, mirroring the implementation lane's
// `CODEX_EFFORT` precedence. Otherwise the resolved `reviewStrength` maps to an
// explicit level for ALL three cases — this is the issue #609 fix: previously
// the "default" tier (both a genuine `review:medium` label and the no-label
// case) passed no `-c model_reasoning_effort` flag at all, silently inheriting
// whatever the operator's global Codex CLI config happened to default to.
// A "default" tier now resolves deterministically:
//   - an explicit `review:medium` label -> "medium" (the label's own request)
//   - no relevant label (or an unrecognized one, e.g. `review:xhigh` alone)
//     -> "high", mirroring Claude's own review default
//     (`resolveClaudeReviewProfile` below: `reviewStrengthSource === "label" ?
//     "medium" : "high"`), so an unlabeled review is not left to chance either.
function resolveCodexReviewEffort(
  reviewStrength: ReviewStrength,
  reviewStrengthSource: "label" | "complexity" | "default",
  env: NodeJS.ProcessEnv = process.env,
): { effort: "low" | "medium" | "high"; source: "env" | "label" | "complexity" | "default" } {
  const envEffort = env["CODEX_EFFORT"];
  if (envEffort) {
    const level = envEffort === "low" ? "low" : envEffort === "medium" ? "medium" : "high";
    return { effort: level, source: "env" };
  }
  if (reviewStrength === "high") return { effort: "high", source: reviewStrengthSource };
  if (reviewStrength === "low") return { effort: "low", source: reviewStrengthSource };
  return reviewStrengthSource === "label"
    ? { effort: "medium", source: "label" }
    : { effort: "high", source: reviewStrengthSource };
}

function reviewCommand(
  agentId: string | undefined,
  baseBranch: string,
  reviewStrength: ReviewStrength,
  reviewStrengthSource: "label" | "complexity" | "default",
  codex?: CodexConfig,
): { cmd: string; baseArgs: string[]; resolvedProfile: ResolvedReviewProfile } | { error: string } {
  const agent = agentId ?? "codex";
  if (agent === "codex") {
    // Resolve context-mode BEFORE building argv so an invalid/unavailable
    // configuration fails the run with a clear error before the agent is invoked
    // (issue #376). When unset the Codex argv is unchanged.
    const ctxMode = resolveCodexContextMode(codex);
    if (ctxMode.status === "error") {
      return { error: ctxMode.error };
    }
    // Resolved BEFORE argv so --model (a global Codex option, issue #609) can be
    // spliced ahead of the `review` subcommand, same positioning rule as --profile.
    const modelResolution = resolveCodexModel(codex);
    const codexEffort = resolveCodexReviewEffort(reviewStrength, reviewStrengthSource);
    // `--profile`/`--model` are GLOBAL Codex options, not `codex review` options,
    // so they must precede the `review` subcommand (`codex --model x review …`).
    // Splicing them after `review` makes Codex fail argument parsing before the
    // review starts. The `-c` overrides are accepted after the subcommand and
    // stay there alongside the effort `-c` (issue #376 review follow-up).
    const argv: string[] = [];
    if (modelResolution.source !== "unset") {
      argv.push("--model", modelResolution.model);
    }
    if (ctxMode.status === "enabled" && ctxMode.profile) {
      argv.push("--profile", ctxMode.profile);
    }
    argv.push("review", "--base", baseBranch);
    argv.push("-c", `model_reasoning_effort=${codexEffort.effort}`);
    if (ctxMode.status === "enabled") {
      for (const entry of ctxMode.config) argv.push("-c", entry);
    }
    const resolvedProfile: ResolvedReviewProfile = {
      phase: "review", agentId: agent, cmd: "codex", argv,
      model: modelResolution.model,
      modelSource: modelResolution.source === "unset" ? "cli-default" : modelResolution.source,
      effort: codexEffort.effort,
      effortSource: codexEffort.source,
      reviewStrength, reviewStrengthSource,
      provider: providerForAgent("codex"),
      contextMode: ctxMode.status === "enabled" ? "enabled" : "unset",
      contextModeSource: ctxMode.source,
      ...(ctxMode.status === "enabled"
        ? { contextModeConfig: [...(ctxMode.profile ? [`profile=${ctxMode.profile}`] : []), ...ctxMode.config] }
        : {}),
    };
    return { cmd: "codex", baseArgs: argv, resolvedProfile };
  }
  if (agent === "gemini") {
    // Antigravity/Gemini review contract:
    //   Binary: ANTIGRAVITY_BIN env var when set, otherwise "agy".
    //   Invocation: <bin> --print "<prompt>"   (non-interactive output mode)
    //   Prompt: review brief + PR diff passed BOTH as the positional argument and
    //           via stdin, mirroring the established Antigravity research contract
    //           (`agy --print "$(cat "$PROMPT")"` with the prompt also on stdin).
    //           Some `agy` builds read the prompt only from the positional
    //           argument, so stdin-only delivery can run the review without the
    //           brief or diff and produce empty/irrelevant output. The runner uses
    //           execFileSync (argv-style spawn, no shell), so the prompt is never
    //           shell-quoted or word-split; the embedded diff is bounded by
    //           MAX_REVIEW_DIFF_CHARS to keep the argv under ARG_MAX.
    //   Diff: the handler fetches `git diff <baseBranch>` after checking out the
    //         PR branch and embeds it in the prompt so the agent sees what
    //         changed without having to resolve the base branch itself.
    const envBin = process.env["ANTIGRAVITY_BIN"];
    const bin = envBin ?? "agy";
    const cmdSource: "env" | "cli-default" = envBin ? "env" : "cli-default";
    const resolvedProfile: ResolvedReviewProfile = {
      phase: "review", agentId: agent, cmd: bin,
      argv: ["--print"],  // sanitized — excludes stdin prompt content
      modelSource: "cli-default", cmdSource,
      reviewStrength, reviewStrengthSource,
      provider: providerForAgent("gemini"),
      // Context-mode is a Codex-only capability; never applies to Gemini (issue #376).
      contextMode: "n/a", contextModeSource: "default",
    };
    return { cmd: bin, baseArgs: ["--print"], resolvedProfile };
  }
  if (agent === "claude") {
    return resolveClaudeReviewProfile(reviewStrength, reviewStrengthSource);
  }
  return { error: `Unsupported review agent: ${agent}. Supported: codex, claude, gemini` };
}

// ---------------------------------------------------------------------------
// Review base vs. PR merge base (issue #667)
//
// Two distinct concepts, kept separate on purpose:
//
//   PR merge base   — every PR, dependency-started or not, targets the session
//                      base branch (`main` by default; issue #228/#242). Step 0
//                      below confirms the PR's live `baseRefName` actually is
//                      the session base, blocking for a human on a PR still
//                      targeting the blocker branch (the #216/#217 trap).
//
//   Review diff base — for a plain task this is also the session base. But a
//                      dependency-started task's branch was created FROM the
//                      blocker PR head (issue #208), which is typically not
//                      yet merged into the session base — so diffing against
//                      the session base would review the whole cumulative
//                      stack (every predecessor's changes plus this issue's)
//                      as if it all belonged to this issue. The diff base for
//                      a dependency-started task is instead the exact
//                      predecessor commit (`dependencyBase.baseHeadSha`)
//                      implementation recorded when it created the branch —
//                      never inferred from a live `blockedBy` relation, which
//                      can close or change by review time. Missing or
//                      non-ancestor metadata fails the review closed rather
//                      than silently falling back to the cumulative diff.
//
// One PR review therefore diffs `<predecessor-head>...HEAD` while still
// targeting `<session-base>` for merge — see `reviewBase` / `dependencyBase`
// below and Step 3.4's ancestry guard.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Review loop cap helpers
// ---------------------------------------------------------------------------

const DEFAULT_MAX_REVIEW_CYCLES = 10;

// Maximum number of review→conflict_resolution→review cycles before escalating
// to human (issue #540). A separate cap from the conflict-resolution attempt cap
// (which bounds verification failures inside conflict_resolution). This cap bounds
// how many times a resolved conflict can still trigger the conflict lane in review.
const DEFAULT_MAX_CONFLICT_REVIEW_CYCLES = 2;

// ---------------------------------------------------------------------------
// SQLite storage bound for reviewFeedback
//
// The review output stored in task.context (persisted to SQLite) is bounded so
// that a verbose codex run cannot grow the context column without limit.
// The outbox layer applies its own tighter display bound (3000 chars) when
// composing GitHub comments, so this value should be larger — enough to preserve
// full actionable findings for the implementation handler while still enforcing
// an upper ceiling on database row size.
// ---------------------------------------------------------------------------

const MAX_REVIEW_FEEDBACK_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Review context (issue/task requirements passed to the reviewer)
//
// The reviewer must evaluate requirement fit, not only generic code quality,
// so the diff is reviewed against the issue body and acceptance criteria
// (issue #174). The issue body is bounded independently of the stored-feedback
// cap because this text travels as a CLI argument value.
// ---------------------------------------------------------------------------

const MAX_REVIEW_CONTEXT_BODY_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Gemini/Antigravity review diff bound
//
// The PR diff is embedded in the Gemini stdin prompt so the agent sees what
// changed. This cap keeps the stdin payload below typical ARG_MAX limits and
// avoids excessively large blobs for monorepo diffs.
// ---------------------------------------------------------------------------

const MAX_REVIEW_DIFF_CHARS = 50_000;

// ---------------------------------------------------------------------------
// Diff classification file-list cap
//
// The diff classification section is embedded in the review prompt which is
// also passed as a positional argv argument for Gemini (`agy --print`). An
// unbounded join of every changed path can exceed ARG_MAX on large-file-count
// PRs even when the diff body itself is within MAX_REVIEW_DIFF_CHARS. Cap each
// per-category list and append a "(+N more)" suffix when truncated.
// ---------------------------------------------------------------------------

const MAX_CLASSIFICATION_FILES_PER_CATEGORY = 30;

/** Render a file list capped at MAX_CLASSIFICATION_FILES_PER_CATEGORY. */
function renderFileList(files: string[]): string {
  if (files.length <= MAX_CLASSIFICATION_FILES_PER_CATEGORY) return files.join(", ");
  const shown = files.slice(0, MAX_CLASSIFICATION_FILES_PER_CATEGORY);
  return `${shown.join(", ")} (+${files.length - MAX_CLASSIFICATION_FILES_PER_CATEGORY} more)`;
}

function boundIssueBody(body: string): string {
  if (body.length <= MAX_REVIEW_CONTEXT_BODY_CHARS) return body;
  return body.slice(0, MAX_REVIEW_CONTEXT_BODY_CHARS) + "\n\n…(issue body truncated for review context)";
}

interface ReviewContextInput {
  issueNumber: number;
  title: string;
  url?: string;
  labels: string[];
  body?: string;
  prUrl?: string;
  branch?: string;
  verificationResults: { name: string; passed: boolean }[];
  /** Verification commands explicitly required by the issue body. */
  issueRequiredVerifications?: IssueRequiredVerification[];
  /** Predecessor/dependency issues whose outputs are pre-existing baseline. */
  dependencies?: { issueNumber: number; url?: string }[];
  /**
   * When true, this review immediately follows a conflict_resolution phase. The
   * review brief adds a post-conflict section instructing the reviewer to check
   * for one-sided resolutions. Raw rationale fields are never passed here; the
   * reviewer receives only the note that this is a post-conflict review (issue #540).
   */
  postConflictReview?: boolean;
}

/**
 * Build the structured review brief handed to the review agent. The first line
 * doubles as the human-readable PR title; the remainder gives the reviewer the
 * issue requirements, predecessor context, verification results, and explicit
 * instructions to check requirement fit, code quality, guardrail changes, and
 * scope fit.
 */
function buildReviewContext(input: ReviewContextInput): string {
  const lines: string[] = [`Issue #${input.issueNumber}: ${input.title}`];
  if (input.url) lines.push(`Issue URL: ${input.url}`);
  if (input.labels.length > 0) lines.push(`Labels: ${input.labels.join(", ")}`);
  if (input.prUrl) lines.push(`PR: ${input.prUrl}`);
  else if (input.branch) lines.push(`Branch: ${input.branch}`);

  if (input.dependencies && input.dependencies.length > 0) {
    lines.push("", "## Predecessor Issues");
    for (const dep of input.dependencies) {
      lines.push(`- Issue #${dep.issueNumber}${dep.url ? ` (${dep.url})` : ""}`);
    }
    lines.push(
      "",
      "Changes from predecessor issues are pre-existing baseline.",
      "Do not flag predecessor outputs as unauthorized additions in the current issue scope.",
    );
  }

  const body = input.body?.trim();
  if (body) {
    lines.push("", "## Issue Requirements", "", boundIssueBody(body));
  }

  if (input.issueRequiredVerifications && input.issueRequiredVerifications.length > 0) {
    lines.push("", "## Issue-Required Verification");
    for (const v of input.issueRequiredVerifications) {
      const label =
        v.status === "passed"
          ? "passed ✅"
          : v.status === "failed"
          ? `failed ❌${v.exitCode !== undefined ? ` (exit ${v.exitCode})` : ""}${v.failureSummary ? `\n  ${v.failureSummary}` : ""}`
          : "not run ⚠️";
      lines.push(`- \`${v.command}\`: ${label}`);
    }
    const notRunCount = input.issueRequiredVerifications.filter((v) => v.status === "not_run").length;
    const failedCount = input.issueRequiredVerifications.filter((v) => v.status === "failed").length;
    if (notRunCount > 0) {
      lines.push("", `**⚠️ ${notRunCount} required command(s) not run — review MUST NOT pass cleanly.**`);
    }
    if (failedCount > 0) {
      lines.push("", `**❌ ${failedCount} required command(s) failed — review MUST NOT pass cleanly.**`);
    }
  }

  if (input.verificationResults.length > 0) {
    lines.push("", "## Verification Results");
    for (const v of input.verificationResults) {
      lines.push(`- ${v.name}: ${v.passed ? "passed" : "failed"}`);
    }
  }

  lines.push(
    "",
    "## Review Instructions",
    "",
    "Evaluate the PR diff against ALL dimensions:",
    "1. Requirement fit — does the diff satisfy the issue requirements and acceptance criteria above? Treat any unmet, missing, or misunderstood acceptance criterion as a blocking [P1] finding.",
    "2. Code quality — bugs, regressions, missing or inadequate tests, and maintainability. Mark any blocking bug or regression with [P2] so it is tracked as a blocking finding.",
    "3. Guardrail and tooling changes — deleted CI/CD workflows, test files, or agent instruction files require explicit justification tied to the issue scope. Flag unexplained deletions as [P1]. New or modified guardrail files should be reviewed for correctness and intentionality.",
    "4. Scope fit — changes outside the issue scope should be flagged unless they are clearly incidental cleanup or pre-existing baseline from a predecessor issue listed above.",
  );

  if (input.postConflictReview) {
    lines.push(
      "",
      "## Post-Conflict-Resolution Review",
      "",
      "This PR was recently resolved from a merge conflict. In addition to the standard dimensions above, pay particular attention to:",
      "1. **One-sided resolution** — does the merged result preserve meaningful intent from both sides? If either side's contribution appears to have been silently discarded, flag it as [P1].",
      "2. **Discarded behavior** — if the resolution drops or alters behavior from either the PR or the base branch without a clear justification, flag it as [P1].",
      "",
      "Do NOT flag the absence of merge-conflict markers (`<<<<<<<`, `>>>>>>>`) — their absence is expected after a successful conflict resolution.",
      "Do NOT reference internal merge rationale files, local artifact paths, or structured resolution fields in your findings.",
    );
  }

  return lines.join("\n");
}

/**
 * Build the full review prompt for Claude and Gemini: combines the structured
 * review brief (issue requirements + instructions) with structured diff
 * classification sections (when available) and the raw PR diff so the reviewer
 * has all context for requirement-fit and code-quality evaluation without
 * external tool access. The prompt is passed via stdin to `claude -p` and as
 * a positional argument + stdin to `agy --print`.
 */
function buildClaudeReviewPrompt(
  reviewBrief: string,
  diff: string,
  diffClassification?: DiffClassification,
): string {
  const lines = [reviewBrief];

  if (diffClassification) {
    const { added, modified, deleted, renamed, guardrail } = diffClassification;
    const totalFiles = added.length + modified.length + deleted.length + renamed.length;
    if (totalFiles > 0) {
      lines.push("", "## Diff Classification");
      if (added.length > 0) lines.push(`**Added (${added.length}):** ${renderFileList(added)}`);
      if (modified.length > 0) lines.push(`**Modified (${modified.length}):** ${renderFileList(modified)}`);
      if (deleted.length > 0) lines.push(`**Deleted (${deleted.length}):** ${renderFileList(deleted)}`);
      if (renamed.length > 0) {
        lines.push(`**Renamed (${renamed.length}):** ${renderFileList(renamed.map((r) => `${r.from} -> ${r.to}`))}`);
      }
    }

    const hasGuardrail =
      guardrail.added.length + guardrail.modified.length + guardrail.deleted.length + guardrail.renamed.length > 0;
    if (hasGuardrail) {
      lines.push("", "## Guardrail and Tooling Changes");
      if (guardrail.deleted.length > 0)
        lines.push(
          `**DELETED (${guardrail.deleted.length}) [requires justification]:** ${renderFileList(guardrail.deleted)}`,
        );
      if (guardrail.added.length > 0)
        lines.push(`**ADDED (${guardrail.added.length}):** ${renderFileList(guardrail.added)}`);
      if (guardrail.modified.length > 0)
        lines.push(`**MODIFIED (${guardrail.modified.length}):** ${renderFileList(guardrail.modified)}`);
      if (guardrail.renamed.length > 0)
        lines.push(
          `**RENAMED (${guardrail.renamed.length}):** ${renderFileList(guardrail.renamed.map((r) => `${r.from} -> ${r.to}`))}`,
        );
      if (guardrail.deleted.length > 0) {
        lines.push(
          "",
          "Deleted guardrail files require justification tied to the issue scope.",
          "Flag any unexplained deletion as [P1].",
        );
      }
    }
  }

  lines.push("", "## PR Diff");
  if (diff.trim()) {
    lines.push("", "```diff", diff.trim(), "```");
  } else {
    lines.push("", "(empty diff — no changes detected against base branch)");
  }
  return lines.join("\n");
}

function boundReviewFeedback(text: string): string {
  if (text.length <= MAX_REVIEW_FEEDBACK_CHARS) return text;

  // When the text contains blocking findings, ensure they are included in the
  // stored slice. Find the position of the first blocking marker and slice from
  // just before it so the actionable findings survive truncation.
  let firstMatchIndex = -1;
  for (const p of BLOCKING_PATTERNS) {
    // Use a cloned regex to avoid stateful lastIndex issues with /g flags
    const m = text.search(p);
    if (m !== -1 && (firstMatchIndex === -1 || m < firstMatchIndex)) {
      firstMatchIndex = m;
    }
  }

  if (firstMatchIndex !== -1) {
    // Include up to 500 chars of context before the first finding
    const sliceStart = Math.max(0, firstMatchIndex - 500);
    const tail = text.slice(sliceStart);
    if (tail.length <= MAX_REVIEW_FEEDBACK_CHARS) {
      return "…(truncated preamble)\n\n" + tail;
    }
    // Tail itself exceeds the cap — keep the first MAX chars so the initial
    // findings are always present
    return "…(truncated)\n\n" + tail.slice(0, MAX_REVIEW_FEEDBACK_CHARS) + "\n\n…(truncated for storage)";
  }

  return text.slice(0, MAX_REVIEW_FEEDBACK_CHARS) + "\n\n…(truncated for storage)";
}

/**
 * Compute the review loop state for a needs_fix outcome.
 *
 * completedCycles: how many needs_fix cycles have been completed (including this one).
 * capReached: whether we've hit the cap and should hand off to human.
 * escalatedEffort: if set, pass this effort level to the next implementation run.
 */
function reviewLoopState(
  task: AiTask,
  maxCycles: number,
): { completedCycles: number; capReached: boolean; escalatedEffort?: string } {
  const prior = typeof task.context["reviewCycles"] === "number" ? task.context["reviewCycles"] : 0;
  const completedCycles = prior + 1;
  if (completedCycles >= maxCycles) {
    return { completedCycles, capReached: true };
  }
  const escalatedEffort = completedCycles === maxCycles - 1 ? "high" : undefined;
  return { completedCycles, capReached: false, escalatedEffort };
}

/**
 * Compute the conflict-review loop state for a conflict outcome after conflict_resolution.
 *
 * Tracks how many times this review has returned `conflict` after a preceding
 * conflict_resolution success (issue #540). Prevents unbounded
 * review → conflict_resolution → review cycling.
 */
function conflictReviewLoopState(
  task: AiTask,
  maxCycles: number,
): { completedCycles: number; capReached: boolean } {
  const prior = typeof task.context["conflictReviewCycles"] === "number" ? task.context["conflictReviewCycles"] : 0;
  const completedCycles = prior + 1;
  return { completedCycles, capReached: completedCycles >= maxCycles };
}

// ---------------------------------------------------------------------------
// Review phase handler factory
//
// Orchestration order (mirrors n8n review lane):
//   1. git status --porcelain — fail if working tree is dirty
//   2. git checkout <baseBranch> && git pull --ff-only
//   3. gh pr checkout <PR number or branch> — check out PR branch
//   4. Run each session.verification command — fail if any fails
//   5. codex review --base <reviewBase> --title "<issue/task review brief>"
//      `reviewBase` is the session base branch (`main`) for a plain task, or the
//      recorded predecessor head for a dependency-started task (issue #667) — the
//      PR itself still targets the session base (issue #242). The brief carries
//      the issue requirements + acceptance criteria so the reviewer checks
//      requirement fit, not only generic code quality.
//   6. Write artifacts, return success -> ready_for_human
// ---------------------------------------------------------------------------

export function createReviewHandler(
  context: PhaseHandlerContext,
  runner: CommandRunner = defaultCommandRunner,
  // Injectable so the per-issue worktree materialization (issue #456) can be
  // stubbed in tests, mirroring the implementation handler's resolveWorktree seam.
  resolveWorktree: typeof resolveIssueWorktree = resolveIssueWorktree,
  // Issue-scoped advisory lock that serializes one issue's worktree execution.
  // Injectable so tests point it at a temp lock dir; in production it defaults to
  // the managed lock dir `admin doctor` already inspects.
  issueLock?: IssueWorktreeLock,
  // Injectable repo-host resolver so tests can exercise a non-GitHub (e.g. Gitea)
  // provider — whose PR reads go over a synchronous HTTP client that cannot be
  // driven from a same-process test server — without a live backend. Defaults to
  // the real config-driven resolver, so production is unchanged.
  resolveRepoHost: typeof resolveSessionRepoHost = resolveSessionRepoHost,
  // When set, the phase runner already acquired the issue-scoped worktree lock under
  // this owner ID before invoking this handler. The handler must NOT acquire the lock
  // itself — that would see it already held and return `blocked` (issue #515). The
  // phase runner is also responsible for releasing the lock after the handler returns,
  // so no `releaseLock` is registered. Leave undefined when calling this handler
  // directly (e.g. in tests) so it acquires and releases the lock as usual.
  phaseLockOwnerId?: string,
): PhaseHandler {
  return async (task: AiTask): Promise<PhaseHandlerResult> => {
    const { session, runId } = context;
    const maxCycles = session.reviewLoop?.maxCycles ?? DEFAULT_MAX_REVIEW_CYCLES;
    const artifactDir = runArtifactDir(session.artifactRoot, runId);
    // `cwd` starts at the canonical checkout (`session.repoRoot`); the worktree
    // setup below always materializes the per-issue worktree and switches `cwd`
    // to run there instead (issue #456).
    let cwd = session.repoRoot;

    // issue #681: a single review-admission preflight gates entry into this
    // handler before any side effect — repo-host resolve, worktree lock or
    // materialization, artifact writes, or the review agent invocation. It
    // requires durable evidence (computable from `task.context` alone) that
    // the task is actually ready for review: no unresolved implementation
    // Tool Request (issue #677 — a live handoff is authoritative over
    // whatever queued this review run, e.g. a mistaken `admin recover` or a
    // stale/conflicting GitHub review label), a durable PR reference with a
    // resolvable head, and — for a dependency-started task — the predecessor
    // review-base metadata (issue #667). In production this SAME check also
    // runs as `runNextPhase`'s `admitPhase` hook (wired in run-one-phase.ts),
    // BEFORE the issue lock is taken or the worktree is resolved, so a
    // rejection there never reaches this handler and never touches the lock,
    // worktree, or Tool Request context. The copy here is a defense-in-depth
    // backstop for a caller that invokes this handler function directly
    // (bypassing the runner's admission gate, e.g. a test or an alternate
    // wiring) — a `failed`/`blocked` result at this point still cannot
    // overwrite the real `ready_for_human`/`implementation` handoff row since
    // nothing has been resolved, locked, checked out, or written yet. See
    // `review-admission.ts`.
    const admission = checkReviewAdmission(task);
    if (!admission.ok) {
      if (admission.result === "failed") {
        return {
          result: "failed",
          context: { artifactDir, [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true },
          error: admission.error,
        };
      }
      return {
        result: "blocked",
        context: { artifactDir, [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true },
        message: admission.message,
      };
    }

    const agentId = agentForPhase(task, session, "review");
    const baseBranch = session.baseBranch ?? "main";
    const ctx = task.context as Record<string, unknown>;
    const taskLabels = Array.isArray(ctx.labels) ? ctx.labels as string[] : [];
    const { prUrl: recordedPrUrl, branch: recordedBranch } = resolvePrContext(task);
    // Mutable so a worktree review can persist the head it resolves from PR metadata
    // (issue #457 review, P2): a `prUrl`-only task records no `branch`, so without this
    // every downstream return context — and the Tool Request handoff that reads
    // `context.branch` via `resolveToolRequestWorkBranch` — would fall back to
    // `ai/issue-<n>` instead of the actual (non-conventional) PR head.
    let branch = recordedBranch;
    // Mutable for the mirror case (issue #447 review, P2): a branch-only GitHub selector
    // that resolves to a FORKED PR routes `branch` to the synthetic `ai/pr-<n>` head, which
    // is not a real PR selector. Persisting the resolved PR URL below lets every downstream
    // return context — the outbox timeline comment and a later `human-review-return` — target
    // the real fork PR instead of a synthetic branch with no open PR.
    let prUrl = recordedPrUrl;
    // Resolve the session's repo-host provider so PR reads route through the
    // configured backend. For `github` this resolves the same `gh` executor the
    // handler used before (operator session, or a GitHub App token-injecting
    // runner): `sessionRepoHost.ghRunner` is that executor and the gh-specific
    // steps below (PR-base/mergeability reads, `gh pr checkout`) use it unchanged.
    // For a non-GitHub host (e.g. `gitea`) no `gh` runner is resolved — those
    // steps fall back to the provider seam / plain local git — so a `gitea`
    // repo-host session no longer fails here resolving unsupported GitHub auth
    // from its `api-token` mode.
    let sessionRepoHost: SessionRepoHost;
    try {
      sessionRepoHost = await resolveRepoHost(session.repoHostProvider, {
        githubRepo: session.githubRepo,
        cwd,
        ghRunnerFallback: ghRunnerFromCommandRunner(runner),
      });
    } catch (err) {
      return {
        result: "failed",
        context: { artifactDir, [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true, prUrl, branch },
        error: `Failed to resolve repo-host provider: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    // Issue #456: per-issue worktree review. The review always runs INSIDE the issue
    // worktree (materialized below) instead of the canonical checkout, so it never
    // collides with the held `ai/issue-<n>` branch and concurrent reviews for
    // different issues never mutate the shared canonical checkout. A worktree
    // session never advances the worktree's local `main`, so a worktree review
    // diffs against the freshly-fetched `origin/<base>`.
    // The PR itself always targets the session base branch (`main`), including a
    // dependency-started PR whose branch was created from a blocker head (issue
    // #242); Step 0 below confirms the PR's live base actually is the session base
    // before reviewing. But the REVIEW DIFF BASE is a separate concept (issue #667):
    // a dependency-started branch was built on top of the blocker PR head, which is
    // typically not yet merged into the session base, so diffing against the session
    // base would review the whole cumulative stack (predecessor + current issue) as
    // if it were all this issue's change. Resolve the diff base from the durable
    // `dependencyBase.baseHeadSha` metadata the implementation phase recorded when it
    // created the branch (issue #667) — never from a live `blockedBy` relation, which
    // can close or change by review time — so the diff is `<predecessor-head>...HEAD`
    // for a dependency-started task and `<session-base>...HEAD` otherwise.
    // The review-admission preflight (issue #681) already parsed and validated
    // `context.dependencyBase` before any side effect ran — a dependency-started
    // task with no durable `baseHeadSha` never reaches this point (it fails
    // closed in `checkReviewAdmission` above). Reuse its result instead of
    // re-parsing.
    const dependencyReviewBaseSha = admission.dependencyReviewBase?.sha;
    const dependencyReviewBaseRefName = admission.dependencyReviewBase?.refName;
    const reviewBase = dependencyReviewBaseSha ?? `origin/${baseBranch}`;
    const { strength: reviewStrength, source: reviewStrengthSource } = labelsToReviewStrength(taskLabels);
    const cmdSpec = reviewCommand(agentId, reviewBase, reviewStrength, reviewStrengthSource, session.codex);
    if ("error" in cmdSpec) {
      // Skip the artifact write when it would land INSIDE the not-yet-materialized
      // issue worktree (issue #729 review, P2 — mirrors the implementation handler's
      // issue #732 fix). `writeAssignmentFailureArtifact` `mkdirSync(artifactDir, {
      // recursive: true })`s eagerly, and this check runs before the worktree setup
      // below materializes it. When `session.artifactRoot` is configured inside that
      // future worktree path (issue #629), the eager mkdir would leave a non-empty
      // directory tree at the target `git worktree add` requires empty — so a later
      // run, after the operator fixes the agent assignment, would fail to materialize
      // the worktree at all. Computing the future worktree path is pure (no git side
      // effect), so this check is safe to run before materialization; a
      // root-resolution failure here just means materialization would have failed
      // closed on the same error anyway, so fall back to the normal write.
      let artifactDirInsideFutureWorktree = false;
      try {
        const futureWorktreeRoot = resolveWorktreeRoot({ sessionRoot: session.worktrees?.root });
        const futureWorktreePath = canonicalizePath(
          issueWorktreePath(futureWorktreeRoot, task.sessionId, task.issueNumber),
        );
        artifactDirInsideFutureWorktree = isPathInside(canonicalizePath(artifactDir), futureWorktreePath);
      } catch {
        artifactDirInsideFutureWorktree = false;
      }
      if (!artifactDirInsideFutureWorktree) {
        writeAssignmentFailureArtifact(artifactDir, {
          phase: "review", agentId, sessionId: task.sessionId, issueNumber: task.issueNumber, runId, error: cmdSpec.error,
        });
      }
      return {
        result: "failed",
        error: cmdSpec.error,
        context: {
          artifactDir,
          [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true,
          assignmentError: { phase: "review", agent: agentId ?? null },
        },
      };
    }
    const resolvedProfile = cmdSpec.resolvedProfile;

    // The issue-scoped worktree lock is held across the whole review and released in
    // the `finally` below — on every return path AND on a thrown writeFileSync — so
    // the next phase for this issue is never blocked by a leaked lock (the lock
    // store's stale window is 24h, so a leak is not self-healing in any practical
    // time). `releaseLock` stays undefined when `phaseLockOwnerId` is set — the phase
    // runner already acquired the lock and owns releasing it (issue #515) — otherwise
    // this handler acquires and releases it itself (issue #456).
    let releaseLock: (() => void) | undefined;
    const reviewLockScope = issueLockScope(task.sessionId, task.issueNumber);

    // Path of the materialized per-issue review worktree. Set when the worktree is
    // created below; consumed by the conflict handoff.
    let worktreePath: string | undefined;

    // True when the review worktree was materialized on the SYNTHETIC `ai/pr-<n>`
    // branch (a GitHub PR-url-only review whose head is fetched from `refs/pull/<n>/head`
    // rather than checked out by the `ai/issue-<n>` convention — see `usePrHeadRef`).
    // That synthetic name deliberately differs from the PR's real `headRefName`, so a
    // downstream `needs_fix` implementation phase (which resolves the worktree on the
    // real `headRefName`) cannot reuse this worktree path — `resolveIssueWorktree`
    // refuses a path already checked out on a different branch. The `needs_fix` return
    // below removes the worktree in that case so the fix phase re-materializes cleanly
    // (issue #459 review, P2).
    let worktreeOnSyntheticPrBranch = false;

    // True when the worktree review confirmed the PR head is a forked
    // (cross-repository) head. A forked head lives on the contributor's fork, which
    // the automated implementation-fix and conflict-resolution handlers cannot push
    // back to — they refuse forked heads outright. So a forked PR whose review yields
    // a blocking outcome (`needs_fix` / `conflict`) must be handed to a human rather
    // than auto-queued into a downstream phase that would deterministically fail
    // (issue #459 review, P2). Set when the synthetic `ai/pr-<n>` path resolves the
    // worktree onto a forked (cross-repository) PR head.
    let prIsCrossRepository = false;

    // Free the per-issue review worktree so the held PR branch is released for a
    // downstream phase that runs on a DIFFERENT branch (issue #456). A `conflict`
    // result queues `conflict_resolution`, which runs in `session.repoRoot` and does
    // `git checkout -B <prBranch>`; Git refuses a branch already checked out in another
    // worktree, so a worktree-mode review must remove its worktree before returning
    // `conflict` — otherwise the conflicted PR is queued into a phase that immediately
    // fails. A `needs_fix` after a synthetic `ai/pr-<n>` review uses it too: the fix
    // phase resolves the worktree on the real `headRefName`, which the resolver refuses
    // while this path is still checked out on `ai/pr-<n>` (issue #459 review, P2). Force
    // so any residual untracked files cannot block removal (review reads/verifies only;
    // nothing in the worktree is worth preserving once the PR is routed onward, and the
    // work is safe on origin). Returns the path + error on failure (worktree left in
    // place) so the caller can escalate to a human instead of queuing a doomed phase.
    // The advisory lock is released independently in the `finally`.
    //
    // The `retained: true` outcome (issue #729 review, P1) is DISTINCT from `ok:
    // true`: the worktree was intentionally left in place (holding the PR branch)
    // rather than actually freed, so callers must treat it like a failure to free —
    // NOT like a successful release — or they would queue a downstream phase
    // (`conflict_resolution`, or an implementation fix onto the real PR head) onto a
    // branch this worktree still holds, which fails immediately.
    const freeReviewWorktree = ():
      | { ok: true }
      | { ok: false; retained: true; path: string }
      | { ok: false; retained?: false; error: string; path: string } => {
      if (worktreePath === undefined) return { ok: true };
      const path = worktreePath;
      // `session.artifactRoot` may be configured to live INSIDE the managed issue
      // worktree (issue #729 review, P1 — mirrors the implementation handler's issue
      // #732 fix). Force-removing the worktree in that configuration would delete the
      // artifact tree this run is about to report as `artifactDir` before the caller
      // returns it, and there is no relocation target that is both durable AND still
      // under `artifactRoot` (its own directory lives inside the tree being removed).
      // Leave the worktree — and its branch — exactly where they already are instead
      // of freeing it. A downstream `conflict_resolution` resolves its own worktree via
      // the same `resolveIssueWorktree`, which tolerates reusing an existing worktree
      // still on the expected (same) branch, so that path is unaffected. A synthetic
      // `ai/pr-<n>` review's `needs_fix` handoff resolves the fix worktree on a
      // DIFFERENT branch (the PR's real head), so retaining this worktree there instead
      // fails that fix phase closed on the branch mismatch rather than losing artifacts —
      // preserving durable state takes priority over that narrower case re-materializing
      // cleanly. Report this as `retained`, not `ok: true` — the branch is still held
      // here, so the caller must escalate to a human instead of queuing the doomed
      // downstream phase (issue #729 review, P1).
      if (isPathInside(canonicalizePath(session.artifactRoot), canonicalizePath(path))) {
        return { ok: false, retained: true, path };
      }
      const freed = removeWorktree(session.repoRoot, path, { force: true, runner });
      if (!freed.ok) return { ok: false, error: freed.error, path };
      worktreePath = undefined;
      return { ok: true };
    };
    // Render a human-actionable message for a `freeReviewWorktree` failure —
    // whether the worktree was `retained` (artifactRoot lives inside it) or removal
    // genuinely `error`ed — for a given downstream-phase description (issue #729
    // review, P1).
    const describeWorktreeFreeFailure = (
      freed: { ok: false; retained?: boolean; error?: string; path: string },
      downstreamPhaseDetail: string,
    ): string =>
      freed.retained
        ? `the review worktree at ${freed.path} could not be freed because \`artifactRoot\` is configured inside it, leaving the PR branch checked out there. ${downstreamPhaseDetail} Preserving the worktree's artifacts takes priority over releasing the branch, so escalating to human instead of queuing a phase that would immediately fail. Relocate \`artifactRoot\` outside the managed worktree, or manually copy out the artifacts and remove the worktree (e.g. \`git worktree remove --force ${freed.path}\`), before retrying.`
        : `freeing the issue worktree at ${freed.path} failed, leaving the PR branch checked out there: ${freed.error}. ${downstreamPhaseDetail} Escalating to human instead of queuing a phase that would immediately fail. Remove the worktree manually (e.g. \`git worktree remove --force ${freed.path}\`) before retrying.`;

    // Before any `needs_fix` handoff, remove a SYNTHETIC `ai/pr-<n>` review worktree
    // (issue #459 review, P2). The implementation fix phase resolves the worktree on the
    // PR's real `headRefName`, but `resolveIssueWorktree` refuses to reuse this path while
    // it is still checked out on the synthetic `ai/pr-<n>` branch — wedging the supported
    // PR-url-only review/fix cycle. Removing it lets the fix phase re-materialize cleanly
    // on the real head. Returns a `blocked` result (escalate to human) when the synthetic
    // worktree exists but cannot be removed, else `undefined` so the caller proceeds with
    // its `needs_fix` return. A no-op for non-synthetic reviews (their fix phase reuses the
    // worktree on the same branch).
    const releaseSyntheticWorktreeForFix = (
      extraContext: Record<string, unknown>,
    ): PhaseHandlerResult | undefined => {
      if (!worktreeOnSyntheticPrBranch) return undefined;
      const freed = freeReviewWorktree();
      if (freed.ok) return undefined;
      const prNum = prUrl ? extractPrNumber(prUrl) : undefined;
      return {
        result: "blocked",
        context: { artifactDir, prUrl, branch, resolvedProfile, reviewLockScope, ...extraContext },
        message: `Review requires fixes, but ${describeWorktreeFreeFailure(freed, `The implementation fix phase resolves the worktree on the PR's real head and Git refuses a path already checked out on another branch (currently \`ai/pr-${prNum ?? "<n>"}\`).`)}`,
      };
    };
    // Release a SYNTHETIC `ai/pr-<n>` review worktree before an EARLY terminal human
    // handoff (issue #472 review, P2). The Step 0 dependency-base and Step 1 dirty-tree
    // checks — and the post-review cleanup-failure guard — can `blocked`-exit after the
    // synthetic worktree is materialized but before the post-classification synthetic
    // cleanup below. Leaving the issue path checked out on `ai/pr-<n>` wedges a later
    // human-requested implementation fix: that phase resolves the worktree on the PR's
    // real `headRefName` and `resolveIssueWorktree` refuses a path held on a different
    // branch. Release it here so the fix phase re-materializes cleanly. When removal
    // itself fails, append that to the human message rather than swallowing the leftover.
    // A no-op for non-synthetic reviews (their fix phase reuses the worktree on the same
    // branch).
    const withSyntheticWorktreeReleased = (
      blocked: Exclude<PhaseHandlerResult, { result: "failed" }>,
    ): PhaseHandlerResult => {
      if (!worktreeOnSyntheticPrBranch) return blocked;
      // Never force-remove a DIRTY synthetic worktree on an early handoff (issue #472
      // review, P2). `freeReviewWorktree` frees it via `git worktree remove --force
      // --force`, which would delete staged/untracked leftovers from an interrupted
      // review before a human can inspect or recover them. The Step 0 dependency-base
      // block runs BEFORE the Step 1 dirty preflight, so a dirty reused `ai/pr-<n>`
      // worktree would otherwise be deleted here instead of preserved; the post-review
      // cleanup-failure guard reaches this helper on an un-cleanable tree too. When the
      // worktree holds uncommitted changes, leave it in place and surface its path —
      // mirroring the Step 1 dirty-preflight handoff. Those dirty contents ARE the
      // reason for the human handoff; a human clears the dirty state (and removes the
      // worktree) before returning the task to implementation.
      if (worktreePath !== undefined) {
        const dirtyCheck = runner.run("git", ["status", "--porcelain"], { cwd: worktreePath });
        if (dirtyCheck.exitCode === 0 && dirtyCheck.stdout.trim().length > 0) {
          const prNum = prUrl ? extractPrNumber(prUrl) : undefined;
          const priorMessage = "message" in blocked && blocked.message ? blocked.message : "";
          return {
            ...blocked,
            message: `${priorMessage} The synthetic \`ai/pr-${prNum ?? "<n>"}\` review worktree at ${worktreePath} holds uncommitted changes and is left in place so they can be inspected or recovered; once the work is saved, remove it manually (e.g. \`git worktree remove --force ${worktreePath}\`) before returning this task to implementation.`.trim(),
          };
        }
      }
      const freed = freeReviewWorktree();
      if (freed.ok) return blocked;
      const prNum = prUrl ? extractPrNumber(prUrl) : undefined;
      const priorMessage = "message" in blocked && blocked.message ? blocked.message : "";
      return {
        ...blocked,
        message: `${priorMessage} Additionally, ${describeWorktreeFreeFailure(freed, `A later human-requested implementation fix resolves the worktree on the PR's real head and Git refuses a path already checked out on another branch (currently \`ai/pr-${prNum ?? "<n>"}\`).`)}`.trim(),
      };
    };

    // Convert a blocking review outcome into a human handoff when the PR head is a
    // forked (cross-repository) head (issue #459 review, P2). The automated
    // implementation-fix (`needs_fix`) and conflict-resolution (`conflict`) phases
    // cannot push commits back to a contributor's fork — those handlers refuse forked
    // heads — so auto-queuing them would deterministically fail the next phase instead
    // of relaying the review feedback to a human. Returns a `blocked` result carrying
    // the same review-feedback context (so the handoff is actionable) for a forked PR,
    // else `undefined` so same-repository PRs keep their auto-queue lanes. The review
    // worktree is already freed by the caller (`releaseSyntheticWorktreeForFix` for
    // `needs_fix`, `freeReviewWorktree` for `conflict`) before this handoff, matching
    // the other terminal human handoffs.
    const forkedPrHandoff = (
      intended: "needs_fix" | "conflict",
      context: Record<string, unknown>,
    ): PhaseHandlerResult | undefined => {
      if (!prIsCrossRepository) return undefined;
      const prNum = prUrl ? extractPrNumber(prUrl) : undefined;
      const blocker = intended === "conflict" ? "merge conflicts" : "changes requiring fixes";
      const phase = intended === "conflict" ? "conflict-resolution" : "implementation-fix";
      // The outcome is a human `blocked` handoff, NOT an auto-queued fix/conflict lane.
      // The caller's context still carries the raw review `classification` (`needs_fix` /
      // `conflict`); re-label it `blocked` so downstream consumers keying off
      // `context.classification` don't route the escalated PR into the very phase this
      // handoff exists to avoid (issue #459 review, P2).
      return {
        result: "blocked",
        context: { ...context, classification: "blocked" },
        message: `Review of forked PR #${prNum ?? "<n>"} found ${blocker}, but the automated ${phase} phase cannot push to the contributor's fork (forked heads are refused there). Escalating to a human to relay the review feedback to the contributor instead of queuing a phase that would deterministically fail.`,
      };
    };

    // Assigned once the worktree is materialized below, alongside the `artifactDir`
    // mkdir + review-context.json write (issue #729 review, P1) — declared here so
    // the review-brief/prompt code further below (which runs after this whole setup
    // block completes) can still read `title` though it is scoped inside the bare
    // block that materializes the worktree. Every path that skips the assignment
    // returns before reaching that later code, but it is typed as possibly
    // `undefined` (rather than asserted) since TS cannot prove that across this
    // function's control flow.
    let title: string | undefined;

    try {
    // ---- Issue #456: per-issue worktree review setup ----------------------------
    // Reviewing from the canonical checkout would (a) collide with the held
    // `ai/issue-<n>` branch on `git checkout` / `gh pr checkout` (Git refuses a
    // branch already checked out in another worktree), and (b) let concurrent reviews
    // for different issues mutate the shared canonical checkout at the same time. So
    // review serializes on the issue-scoped worktree lock — the same scope `admin
    // doctor` reports — and runs inside the per-issue worktree, which is already on
    // the PR head. Different issues use different worktrees + lock scopes, so a
    // review never touches the canonical checkout and two issues never collide.
    {
      if (phaseLockOwnerId === undefined) {
        // No pre-acquired lock: acquire it here and register release for the finally.
        // When phaseLockOwnerId IS set the phase runner holds the lock already (issue
        // #515) — skip acquire and release; the phase runner releases after we return.
        const lock = issueLock ?? new IssueWorktreeLock();
        const acquired = lock.acquire(runId, task.sessionId, task.issueNumber);
        if (!acquired.locked) {
          // Another execution owns this issue's worktree; reviewing now could mutate a
          // worktree it owns. Fail closed to a human, surfacing the held scope/owner so
          // the lock contention is visible in the task event + lock diagnostics.
          return {
            result: "blocked",
            context: { artifactDir, [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true, prUrl, branch, resolvedProfile, reviewLockScope, reviewLockHeldBy: acquired.ownerContextId },
            message: `Issue #${task.issueNumber} review skipped: worktree lock '${reviewLockScope}' is held by ${acquired.ownerContextId} (since ${acquired.ownerStartedAt}) — another execution owns this issue's worktree. Escalating to human.`,
          };
        }
        releaseLock = () => { lock.release(runId, task.sessionId, task.issueNumber); };
      }

      // Pick the branch the worktree must check out (issue #456 review, P2). A
      // recorded `branch` is authoritative. Otherwise, when only a `prUrl` is
      // recorded, the PR head may be NON-conventional (an externally-created PR whose
      // head is not `ai/issue-<n>`). `gh pr checkout <number>` would resolve this
      // input by checking out the PR number, so the worktree path must materialize
      // the SAME head — assuming the convention would fetch a nonexistent
      // `ai/issue-<n>` branch or review the wrong one. Resolve the live head from the
      // PR metadata (number preferred over the raw URL so the selector is
      // backend-neutral, matching the other PR reads here) and fail closed if it
      // cannot be resolved.
      // A GitHub worktree review needs a PR selector (recorded `prUrl` or `branch`)
      // exactly like `gh pr checkout`, which fails `No PR URL or branch` rather than
      // checking out `ai/issue-<n>` by convention (issue #456 review, P2).
      // Materializing the convention branch here would let a worktree review promote a
      // task to `ready_for_human` with no PR to hand off. Non-GitHub hosts keep the
      // head-branch convention, so this guard is GitHub-only. Fail closed before
      // touching any branch.
      if (sessionRepoHost.ghRunner && branch === undefined && prUrl === undefined) {
        return {
          result: "failed",
          context: { artifactDir, [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true, prUrl, branch, resolvedProfile, reviewLockScope },
          error: `No PR URL or branch in task context for issue #${task.issueNumber}; cannot materialize review worktree`,
        };
      }
      // The LOCAL worktree branch name (and the `origin/<branch>` remote-tracking ref
      // the PR head is fetched into below) is independent of the PR's own head ref name.
      // For a GitHub PR resolved from its number we fetch the head from
      // `refs/pull/<n>/head` (see `prHeadFetchSource`), so the local name is ours to
      // choose — and MUST NOT be the PR's `headRefName`: a forked PR's head ref is the
      // contributor's branch name, which is commonly `main` (or another branch that
      // already exists locally). Adopting it would make the resolver reuse/detach the
      // base repo's local branch and then `git pull origin pull/<n>/head` fast-forward it
      // to the PR head, leaving the base branch checked out in the issue worktree and
      // contaminating later phases; a colliding name can also overwrite an `origin/<head>`
      // tracking ref with the PR head. Use a synthetic per-PR name instead. Non-GitHub
      // hosts resolve the head as a real `origin` branch via the convention (and fetch it
      // by name), so they keep `headRefName` (issue #459 review, P1).
      const worktreePrNumber = prUrl ? extractPrNumber(prUrl) : undefined;
      const ghPrByNumber = Boolean(sessionRepoHost.ghRunner) && worktreePrNumber !== undefined;
      // Validate any recorded `branch` against the live PR before trusting it whenever
      // `prUrl` is present (issue #459 review, P1; issue #447 review, P2). A forked PR's
      // head ref name is the contributor's branch name — commonly `main` (or another branch
      // that already exists locally) — so a task that records `branch: 'main'` for a fork
      // would otherwise make the `rev-parse`/`pull` below operate on the local/origin base
      // branch instead of `refs/pull/<n>/head`, running the review against — and promoting
      // — the base branch rather than the PR head. Even a CONVENTIONAL `ai/issue-<n>`
      // branch must be validated when `prUrl` is set: the recorded branch may be stale, or
      // a fork's head branch may coincidentally use that naming, making it unsafe to bypass
      // the live PR read. The PR is read by number (backend-neutral) so a confirmed
      // cross-repository head reroutes to the synthetic `ai/pr-<n>` path even though
      // `branch` is set.
      const validateRecordedBranch =
        ghPrByNumber && branch !== undefined;
      let prHeadRefName: string | undefined;
      // The PR number a branch-only GitHub selector resolves to (issue #447 review, P2).
      // With no `prUrl` there is no number to parse for the synthetic `pull/<n>/head`
      // path; capture it from the branch PR read below so a forked branch-only PR can
      // still route through that path instead of fetching the base repo's origin branch.
      let branchOnlyPrNumber: number | undefined;
      // The PR URL that same branch-only read resolves to (issue #447 review, P2). A
      // branch-only forked PR records no `prUrl`, so capture the real one here to persist
      // once `branch` is routed to the synthetic `ai/pr-<n>` head (below), keeping the
      // outbox comment and any return-to-fix pointed at the actual fork PR.
      let branchOnlyPrUrl: string | undefined;
      if ((branch === undefined && prUrl) || validateRecordedBranch) {
        const prSelector = worktreePrNumber ?? (prUrl as string);
        const prRead = sessionRepoHost.provider.getPullRequest(prSelector);
        if (!prRead.ok) {
          return {
            result: "failed",
            context: { artifactDir, [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true, prUrl, branch, resolvedProfile, reviewLockScope },
            error: `Failed to resolve PR head for issue #${task.issueNumber} from ${prUrl} (selector ${prSelector}) to materialize the review worktree: ${prRead.error}`,
          };
        }
        prHeadRefName = prRead.value.headRefName;
        prIsCrossRepository = prRead.value.isCrossRepository === true;
      }
      // Validate a branch-only GitHub selector has an OPEN PR before materializing the
      // worktree (issue #447 review, P2). With a recorded `branch` but no `prUrl` there is
      // no PR number to resolve, so `validateRecordedBranch` above is false and GitHub is
      // never consulted — the path just fetches `origin/<branch>` and reviews it.
      // `gh pr checkout <branch>` instead FAILS when the branch is stale or has no
      // open PR, so a review never runs against a branch with no PR to hand off.
      // Without this check a stale branch would review green and promote the task
      // to human handoff with NO open PR. So ask the provider (backend-neutral
      // `getPullRequest`, `gh pr view <branch>` here) whether the recorded branch still has
      // an OPEN PR, and fail closed when the read fails (no PR for the branch) or the PR is
      // closed/merged — matching `gh pr checkout`'s failure mode. State is compared
      // leniently (treat absent as open) exactly like the recorded-PR fix guard. GitHub-only:
      // non-`gh` hosts keep the head-branch convention and have no branch-checkout gate to mirror.
      if (sessionRepoHost.ghRunner && branch !== undefined && prUrl === undefined) {
        const branchPrRead = sessionRepoHost.provider.getPullRequest(branch);
        if (!branchPrRead.ok) {
          return {
            result: "failed",
            context: { artifactDir, [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true, prUrl, branch, resolvedProfile, reviewLockScope },
            error: `No open PR found for branch '${branch}' (issue #${task.issueNumber}) to materialize the review worktree: ${branchPrRead.error}`,
          };
        }
        if (branchPrRead.value.state !== undefined && branchPrRead.value.state.toLowerCase() !== "open") {
          return {
            result: "failed",
            context: { artifactDir, [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true, prUrl, branch, resolvedProfile, reviewLockScope },
            error: `Recorded branch '${branch}' for issue #${task.issueNumber} has a ${branchPrRead.value.state.toLowerCase()} PR, not an open one; refusing to review a branch with no open PR to hand off.`,
          };
        }
        // A forked (cross-repository) PR head does NOT live on `origin`, so its recorded
        // `branch` is the contributor's ref name — commonly `main` (or another branch that
        // already exists on origin). Fetching `origin/<branch>` for it would review the
        // BASE repository's branch, not the fork's PR head (issue #447 review, P2). This
        // read already reveals both the fork flag and the PR number, so capture them to
        // route a forked branch-only PR through the synthetic `pull/<n>/head` path below
        // (GitHub publishes every head there, forked or not) rather than discarding them
        // and fetching the wrong origin branch.
        prIsCrossRepository = branchPrRead.value.isCrossRepository === true;
        branchOnlyPrNumber = branchPrRead.value.number;
        branchOnlyPrUrl = branchPrRead.value.url;
      }
      // A non-conventional recorded `branch` that the live PR confirms is a SAME-repository
      // head must still MATCH the PR's `headRefName` to be trusted. A stale or mistyped
      // `branch` would otherwise make the fetch/`rev-parse`/review below operate on that
      // (wrong) origin branch while the result still points at the PR URL — promoting code
      // that is not actually in the PR (`gh pr checkout <number>` would instead check out
      // the PR head by number). When the recorded name disagrees with the live head,
      // materialize the PR head by its ref via the synthetic path rather than trusting the
      // recorded name (issue #459 review, P2).
      const recordedBranchMismatch =
        validateRecordedBranch && prHeadRefName !== undefined && branch !== prHeadRefName;
      // The PR number that identifies the synthetic `pull/<n>/head`. Prefer the number
      // parsed from a recorded `prUrl`; fall back to the number the branch-only PR read
      // resolved so a forked branch-only PR (no `prUrl`) can still reach the synthetic
      // path instead of fetching the base repo's origin branch (issue #447 review, P2).
      const effectivePrNumber = worktreePrNumber ?? branchOnlyPrNumber;
      // A GitHub PR resolved by number takes the synthetic `ai/pr-<n>` path when no
      // branch is recorded, when the validated PR is a forked (cross-repository) head
      // whose recorded `branch` must NOT be trusted (whether the fork was confirmed from a
      // recorded `prUrl` or from a branch-only PR read), or when the recorded
      // same-repository `branch` does not match the live PR head (issue #459 review,
      // P1/P2; issue #447 review, P2).
      const usePrHeadRef =
        Boolean(sessionRepoHost.ghRunner) &&
        effectivePrNumber !== undefined &&
        (branch === undefined || prIsCrossRepository || recordedBranchMismatch);
      // Fail closed on a FORKED (cross-repository) PR head that the synthetic
      // `pull/<n>/head` path above does NOT cover (issue #447 review, P2). GitHub
      // cross-repository heads route to `usePrHeadRef` and fetch `pull/<n>/head`, so they
      // are safe. But a non-GitHub host (e.g. Gitea) resolves a `prUrl`-only head as an
      // ordinary `origin` branch via the head-branch convention, adopting the PR's
      // `headRefName` as `issueBranch` below. A fork's head ref name is the contributor's
      // branch name — commonly `main` (or another branch that already exists on origin) —
      // so fetching `origin/<headRefName>` would pull the BASE repository's branch, not the
      // fork's PR head: the review would run against, and mark ready, code that is NOT in
      // the PR. The provider reports the confirmed cross-repository flag but nothing else
      // consumes it here, so refuse the review until the PR head repository/remote is
      // carried through, mirroring the implementation fix guard (issue #456 review, P2).
      if (prIsCrossRepository && !usePrHeadRef) {
        return {
          result: "failed",
          context: { artifactDir, [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true, prUrl, branch, resolvedProfile, reviewLockScope },
          error:
            `Refusing to review issue #${task.issueNumber}${effectivePrNumber !== undefined ? ` on PR #${effectivePrNumber}` : ""} in a worktree: its head is on a fork (a cross-repository PR head lives on the contributor's fork, not origin), so resolving it as the origin branch '${prHeadRefName ?? ""}' would review the base repository's branch instead of the PR head. Carry the PR head repository/remote through before reviewing forked PRs on this host.`,
        };
      }
      let issueBranch = usePrHeadRef
        ? `ai/pr-${effectivePrNumber}`
        : (branch ?? branchName(task.issueNumber));
      // Adopt the PR's head ref name as the local branch only for hosts that fetch the
      // head by that origin branch name (non-GitHub convention), and only for a
      // `prUrl`-only handoff — a recorded `branch` (conventional or validated same-repo)
      // is already authoritative. GitHub fetches by the PR ref, so it keeps the synthetic
      // `ai/pr-<n>` name set above (issue #459, P1).
      if (branch === undefined && !usePrHeadRef && prHeadRefName) {
        issueBranch = prHeadRefName;
      }
      // Resolve the ref to fetch the PR head FROM (issue #456 review, P2). When the task
      // records a `branch`, that head is our own `ai/issue-<n>` branch pushed to `origin`
      // by implementation, so fetch it by name as before. But a PR-url-only review may be
      // a PR whose head is NOT a branch on `origin` (a forked PR); `git fetch origin
      // <head>` would fail for it. GitHub publishes every PR head — including forked-PR
      // heads — under `refs/pull/<n>/head`, which is what `gh pr checkout <n>` fetches, so
      // fetch by that PR ref whenever the head is GitHub-resolved from the PR number
      // alone. Non-GitHub hosts (no `gh` runner) resolve the head as an ordinary origin
      // branch via the convention, so they keep the branch fetch.
      const prHeadFetchSource =
        usePrHeadRef
          ? `pull/${effectivePrNumber}/head`
          : issueBranch;
      // Persist the resolved (possibly non-conventional) PR head so every downstream
      // return context — and the Tool Request handoff that reads `context.branch` via
      // `resolveToolRequestWorkBranch` — targets the real head instead of falling back
      // to `ai/issue-<n>` (issue #457 review, P2). Reassigned only AFTER the
      // `branch === undefined` checks above (which distinguish a recorded branch from a
      // head resolved from the PR number) so it cannot perturb the fetch-source choice.
      branch = issueBranch;
      // A branch-only forked PR just replaced `branch` with the synthetic `ai/pr-<n>` head
      // (`usePrHeadRef` above), which is not a real branch or PR selector. Persist the PR URL
      // the branch read resolved so every downstream return context carries it: on success the
      // outbox posts the PR timeline comment and a `human-review-return` targets the real fork
      // PR, instead of resolving a synthetic branch with no open PR (issue #447 review, P2).
      if (prUrl === undefined && usePrHeadRef && branchOnlyPrUrl !== undefined) {
        prUrl = branchOnlyPrUrl;
      }
      // Refresh `origin/<base>` so the worktree review diffs against a current base — a
      // worktree session never advances local `main`. Fetch runs in the canonical repo
      // whose object store the worktree shares; it updates a remote-tracking ref only
      // and never mutates the canonical checkout. Use an explicit
      // `+<base>:refs/remotes/origin/<base>` refspec (issue #457 review, P2): a bare
      // `git fetch origin <base>` only updates `FETCH_HEAD` when the clone's
      // `remote.origin.fetch` does not track `<base>` (e.g. a single-branch clone),
      // which would leave `origin/<base>` stale or missing while the fetch still
      // reports success — and `reviewBase` below diffs against `origin/<base>`.
      const fetchBase = runner.run("git", ["fetch", "origin", `+${baseBranch}:refs/remotes/origin/${baseBranch}`], { cwd: session.repoRoot });
      if (fetchBase.exitCode !== 0) {
        return {
          result: "failed",
          context: { artifactDir, [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true, prUrl, branch, resolvedProfile, reviewLockScope },
          error: `git fetch origin ${baseBranch} (refresh worktree review base) failed (exit ${fetchBase.exitCode}): ${(fetchBase.stderr || fetchBase.stdout).slice(0, 300)}`,
        };
      }
      // On a fresh/single-branch clone the local `ai/issue-<n>` ref may be absent even
      // though the PR head is pushed (a different worker reviews, or implementation
      // removed its worktree and the branch after pushing). Recover the PR head into
      // its remote-tracking ref so resolveWorktree materializes the worktree FROM
      // `origin/<branch>` rather than creating it empty from the base. With the local
      // branch present (the common reuse case) skip the fetch so a behind-origin head
      // still reaches the resolver's fast-forward-tolerant path instead of tripping its
      // divergence guard.
      const localIssueBranchExists =
        runner.run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${issueBranch}`], { cwd: session.repoRoot }).exitCode === 0;
      if (!localIssueBranchExists) {
        const fetchPrHead = runner.run("git", ["fetch", "origin", `${prHeadFetchSource}:refs/remotes/origin/${issueBranch}`], { cwd: session.repoRoot });
        if (fetchPrHead.exitCode !== 0) {
          return {
            result: "failed",
            context: { artifactDir, [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true, prUrl, branch, resolvedProfile, reviewLockScope },
            error: `git fetch origin ${prHeadFetchSource} (materialize review worktree from PR head) failed (exit ${fetchPrHead.exitCode}): ${(fetchPrHead.stderr || fetchPrHead.stdout).slice(0, 300)}`,
          };
        }
      }
      const materialized = resolveWorktree({
        repoRoot: session.repoRoot,
        sessionId: task.sessionId,
        issueNumber: task.issueNumber,
        branch: issueBranch,
        baseRef: `origin/${baseBranch}`,
        // Review only reads + verifies the PR head, so a behind-origin (fast-forwardable)
        // head is acceptable; opt into the resolver's fast-forward tolerance instead of
        // failing closed on a merely-behind local ref. Genuine divergence is still rejected.
        allowFastForward: true,
        ...(session.worktrees?.root ? { worktreeRoot: session.worktrees.root } : {}),
        runner,
      });
      if (!materialized.ok) {
        return {
          result: "failed",
          context: { artifactDir, [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true, prUrl, branch, resolvedProfile, reviewLockScope },
          error: `Failed to prepare issue #${task.issueNumber} review worktree: ${materialized.error}`,
        };
      }
      cwd = materialized.path;
      worktreePath = materialized.path;
      // Record whether this worktree sits on the synthetic `ai/pr-<n>` branch so a
      // downstream `needs_fix` knows to remove it before the fix phase resolves the
      // worktree on the real `headRefName` (issue #459 review, P2).
      worktreeOnSyntheticPrBranch = usePrHeadRef;

      // Create the artifact dir AFTER worktree materialization, not before (issue
      // #729 review, P1 — mirrors the implementation handler's issue #732 fix): a
      // session may configure `artifactRoot` to live INSIDE the managed worktree
      // (issue #629), a path that does not exist until `resolveWorktree` above runs
      // `git worktree add`. Creating it earlier would pre-populate that path with an
      // empty directory tree, and `git worktree add` refuses to materialize a
      // worktree at an already-existing, non-empty target.
      try {
        mkdirSync(artifactDir, { recursive: true });
      } catch (err) {
        return {
          result: "failed",
          context: { resolvedProfile },
          error: `Failed to create artifact dir: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      title = typeof ctx.title === "string" ? ctx.title : `Issue #${task.issueNumber}`;

      // Write context snapshot before agent invocation so interrupted runs retain audit metadata.
      // Include the full persisted assignment (flow, source, resolvedAt, all phase
      // agents) so the run dir is self-describing, not just the per-phase resolvedProfile.
      const assignment = readResolvedAssignment(task);
      writeFileSync(
        join(artifactDir, "review-context.json"),
        JSON.stringify({
          issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId, prUrl, branch, title, resolvedProfile,
          // Operator diagnostics (issue #667): the PR's merge target vs. the diff base
          // this run actually reviewed against — distinct for a dependency-started task.
          prMergeBase: baseBranch, reviewDiffBase: reviewBase,
          ...(dependencyReviewBaseSha !== undefined
            ? { dependencyReviewBase: { sha: dependencyReviewBaseSha, refName: dependencyReviewBaseRefName } }
            : {}),
          ...(assignment ? { assignment } : {}),
        }, null, 2),
        "utf8",
      );

      // git worktrees don't inherit gitignored directories from the canonical
      // checkout. Symlink node_modules from the canonical root so npm lifecycle
      // scripts (tsc, jest) resolve without a separate npm install in the worktree.
      // Only create the symlink when node_modules is gitignored in this worktree;
      // in repos that do not ignore it the symlink would appear as an untracked
      // path and trip the preflight dirty check.
      const worktreeNodeModules = join(materialized.path, "node_modules");
      const canonicalNodeModules = join(session.repoRoot, "node_modules");
      if (!existsSync(worktreeNodeModules) && existsSync(canonicalNodeModules)) {
        const ignored = runner.run("git", ["check-ignore", "-q", "node_modules"], { cwd: materialized.path });
        if (ignored.exitCode === 0) {
          try { symlinkSync(canonicalNodeModules, worktreeNodeModules, "dir"); } catch { /* non-fatal */ }
        }
      }

      // Reconcile a REUSED local branch with the live PR head before verifying or
      // reviewing (issue #456 review, P1). `allowFastForward: true` lets the resolver
      // accept a local `<issueBranch>` that is merely BEHIND origin, but it leaves the
      // worktree checked out on that stale local commit. Without this fast-forward, a
      // follow-up another worker/operator pushed to the PR branch would never be
      // reviewed and the PR could be approved against old contents. `git pull origin
      // <branch> --ff-only` fetches the live head and advances the worktree onto it —
      // the same reconciliation the implementation worktree path performs — and still
      // fails closed on a genuinely diverged (non-fast-forwardable) head. Only the
      // reused-branch case needs it: a branch the resolver created fresh from
      // `origin/<branch>` already sits at the PR head.
      if (materialized.branchReused) {
        const pullHead = runner.run("git", ["pull", "origin", prHeadFetchSource, "--ff-only"], { cwd });
        if (pullHead.exitCode !== 0) {
          return {
            result: "failed",
            context: { artifactDir, prUrl, branch, resolvedProfile, reviewLockScope },
            error: `git pull origin ${prHeadFetchSource} --ff-only (reconcile review worktree with the live PR head) failed (exit ${pullHead.exitCode}): ${(pullHead.stderr || pullHead.stdout).slice(0, 300)}`,
          };
        }
        // `--ff-only` advances a BEHIND worktree onto the live PR head, but it is a
        // successful no-op when the reused branch is instead AHEAD of `origin/<branch>`
        // (local-only commits after a failed/manual local commit or a remote reset).
        // That would leave HEAD past the live PR head and let review approve commits
        // that were never pushed. The `pull` set `FETCH_HEAD` to the live remote head,
        // so refuse the review when `HEAD` carries any commit the remote head does not
        // (issue #456 review, P2).
        const aheadOfRemote = runner.run("git", ["rev-list", "--count", "FETCH_HEAD..HEAD"], { cwd });
        if (aheadOfRemote.exitCode !== 0) {
          return {
            result: "failed",
            context: { artifactDir, prUrl, branch, resolvedProfile, reviewLockScope },
            error: `git rev-list --count FETCH_HEAD..HEAD (confirm review worktree is on the live PR head) failed (exit ${aheadOfRemote.exitCode}): ${(aheadOfRemote.stderr || aheadOfRemote.stdout).slice(0, 300)}`,
          };
        }
        const localAhead = Number.parseInt(aheadOfRemote.stdout.trim(), 10);
        if (!Number.isFinite(localAhead) || localAhead > 0) {
          return {
            result: "failed",
            context: { artifactDir, prUrl, branch, resolvedProfile, reviewLockScope },
            error: `Review worktree branch ${issueBranch} is ${Number.isFinite(localAhead) ? localAhead : "an unknown number of"} commit(s) ahead of the live PR head (origin/${issueBranch}); refusing to review local-only commits that are not in the PR.`,
          };
        }
      }
    }

    // Step 0: Live-base safety check for dependency-started PRs
    //
    // New dependency-started PRs target the session base branch (`main`) like any
    // other PR, so reviewing against `main` is correct (issue #242). But a PR
    // created under the PRIOR stacked-base flow may still actually target the
    // blocker branch on GitHub. Marking such a PR `ready_for_human` after a review
    // diffed against `main` is unsafe: merging it would deliver into the blocker
    // branch and hide the dependent change from `main` (the #216/#217 trap).
    //
    // So whenever `dependencyBase` metadata is present, confirm the PR's live
    // `baseRefName` is the session base before proceeding. If it still targets the
    // blocker branch — or the base cannot be confirmed — block for a human to
    // retarget the PR base to the session base rather than silently approving it.
    if (ctx.dependencyBase && typeof ctx.dependencyBase === "object") {
      const prSelector = prUrl ? extractPrNumber(prUrl) ?? branch : branch;
      if (!prSelector) {
        return withSyntheticWorktreeReleased({
          result: "blocked",
          context: { artifactDir, prUrl, branch, resolvedProfile },
          message: `Dependency-started task for issue #${task.issueNumber} has no PR URL or branch; cannot confirm the live PR base targets the session base (${baseBranch}) — escalating to human.`,
        });
      }
      // Read the PR's live base ref through the configured repo host.
      //
      // GitHub: the exact `gh pr view` call is preserved — scoped to the configured
      // repo (`--repo`) like every other PR lookup here (without it `gh` resolves
      // the default repo from the checkout, which can be a fork/remote mismatch and
      // query the wrong repo), and run through the resolved `gh` runner so it
      // authenticates as the GitHub App when configured (the raw runner would drop
      // the App token and query under the operator's unrelated credentials).
      //
      // Non-GitHub (e.g. Gitea): the provider resolves the PR by the head-branch
      // convention (`ai/issue-<n>`) and returns its live base ref.
      let liveBase: string | undefined;
      let liveBaseDetail: string;
      if (sessionRepoHost.ghRunner) {
        const viewResult = sessionRepoHost.ghRunner.run(["pr", "view", prSelector, "--repo", session.githubRepo, "--json", "baseRefName"], { cwd });
        if (viewResult.exitCode === 0) {
          try {
            const parsed = JSON.parse(viewResult.stdout) as { baseRefName?: unknown };
            if (typeof parsed.baseRefName === "string") liveBase = parsed.baseRefName;
          } catch {
            liveBase = undefined;
          }
        }
        liveBaseDetail = `\`gh pr view ${prSelector} --repo ${session.githubRepo} --json baseRefName\` (exit ${viewResult.exitCode})`;
      } else {
        const found = sessionRepoHost.provider.findPullRequestForWorkItem(task.issueNumber);
        if (found.kind === "found" && typeof found.pullRequest.baseRefName === "string") {
          liveBase = found.pullRequest.baseRefName;
        }
        liveBaseDetail =
          found.kind === "failed"
            ? `repo-host PR lookup failed: ${found.error}`
            : found.kind === "none"
            ? `no open PR found for issue #${task.issueNumber}`
            : "PR base ref was not reported by the repo host";
      }
      if (liveBase === undefined) {
        return withSyntheticWorktreeReleased({
          result: "blocked",
          context: { artifactDir, prUrl, branch, resolvedProfile },
          message: `Could not confirm the live PR base for dependency-started issue #${task.issueNumber}: ${liveBaseDetail}. Reviewing against ${baseBranch} is only safe once the PR base is confirmed — escalating to human.`,
        });
      }
      if (liveBase !== baseBranch) {
        return withSyntheticWorktreeReleased({
          result: "blocked",
          context: { artifactDir, prUrl, branch, livePrBase: liveBase, resolvedProfile },
          message: `Dependency-started PR for issue #${task.issueNumber} still targets the blocker branch \`${liveBase}\` instead of the session base \`${baseBranch}\`. This PR was created under the prior stacked-base flow; merging it would deliver into the blocker branch and hide the dependent change from \`${baseBranch}\` (the #216/#217 trap). Retarget the PR base to \`${baseBranch}\` before review — escalating to human.`,
        });
      }
    }

    // Step 1: Preflight dirty check
    // A dirty tree must be treated as a hard block: the implementation handler
    // also rejects dirty trees at its own preflight, so requeueing as needs_fix
    // would immediately fail there without making any progress.
    const statusResult = runner.run("git", ["status", "--porcelain"], { cwd });
    if (statusResult.stdout.trim().length > 0) {
      const dirtyFiles = statusResult.stdout.trim().slice(0, 500);
      const reviewFeedback = `Working tree is dirty before review — uncommitted changes must be committed or removed:\n${dirtyFiles}`;
      // Do NOT release the synthetic `ai/pr-<n>` review worktree on this dirty-preflight
      // handoff (issue #472 review, P1). `withSyntheticWorktreeReleased` frees it via
      // `git worktree remove --force --force`, which would delete the very
      // uncommitted/staged/untracked changes that triggered this dirty-tree escalation
      // (e.g. leftover output from an interrupted review) before a human can inspect or
      // recover them. Unlike the other early handoffs — which release a CLEAN synthetic
      // worktree so a later fix phase can re-materialize it on the PR's real head — here
      // the dirty contents ARE the reason for the human handoff, so the worktree is left
      // in place and its path surfaced for manual inspection. A human clears the dirty
      // state (and removes the worktree) before returning the task to implementation.
      const preservedWorktreeNote =
        worktreeOnSyntheticPrBranch && worktreePath !== undefined
          ? ` The synthetic \`ai/pr-<n>\` review worktree at ${worktreePath} is left in place so its uncommitted changes can be inspected or recovered; once the work is saved, remove it manually (e.g. \`git worktree remove --force ${worktreePath}\`) before returning this task to implementation.`
          : "";
      return {
        result: "blocked",
        context: {
          artifactDir,
          reviewFeedback,
          resolvedProfile,
        },
        message: `Working tree is dirty before review — escalating to human. Dirty files: ${dirtyFiles.slice(0, 200)}${preservedWorktreeNote}`,
      };
    }

    // Steps 2 and 3 (reset to base branch, checkout PR branch) are not needed: the
    // per-issue worktree materialized above is already checked out on the PR head,
    // and the review base is the freshly-fetched `origin/<base>` rather than local
    // `main` (issue #456).

    // Step 3.4: Validate the dependency review base is an ancestor of HEAD (issue
    // #667). Runs after the worktree checkout above, so `HEAD` is the actual
    // reviewed commit. `dependencyReviewBaseSha` was recorded
    // by implementation when it created this issue's branch; if the predecessor
    // branch was since force-pushed/rebased, the recorded commit was pruned, or the
    // checkout never had it, fail closed rather than let `reviewBase` silently fall
    // back to a `git diff` that errors or — worse — resolves to something else. The
    // predecessor commit is normally already present locally (it is an ancestor of
    // the fetched issue branch); the ref fetch below is a fallback for a checkout
    // that never pulled it in.
    if (dependencyReviewBaseSha !== undefined) {
      const haveSha = runner.run("git", ["cat-file", "-e", `${dependencyReviewBaseSha}^{commit}`], { cwd });
      if (haveSha.exitCode !== 0 && dependencyReviewBaseRefName) {
        runner.run(
          "git",
          ["fetch", "origin", `+${dependencyReviewBaseRefName}:refs/remotes/origin/${dependencyReviewBaseRefName}`],
          { cwd },
        );
      }
      const isAncestor = runner.run("git", ["merge-base", "--is-ancestor", dependencyReviewBaseSha, "HEAD"], { cwd });
      if (isAncestor.exitCode !== 0) {
        return withSyntheticWorktreeReleased({
          result: "blocked",
          context: { artifactDir, prUrl, branch, resolvedProfile, reviewLockScope },
          message: `Recorded dependency review base ${dependencyReviewBaseSha}${dependencyReviewBaseRefName ? ` (${dependencyReviewBaseRefName})` : ""} for issue #${task.issueNumber} is not an ancestor of HEAD (exit ${isAncestor.exitCode}); the recorded predecessor commit is missing, stale, or unreachable. Refusing to fall back to a cumulative review against ${baseBranch} — escalating to human.`,
        });
      }
    }

    // Step 3.5: Runner-owned environment preparation (issue #511). Ensures the
    // full runtime dependency tree is materialized in this checkout before
    // running verification. Uses the same stamp/skip logic as the implementation
    // handler, so a review running in a worktree already prepared by an earlier
    // implementation run skips cheaply. Failure is fail-closed: a broken prepare
    // is surfaced here rather than as a cryptic verification failure.
    const reviewEnvPrepare = ensureEnvironmentPrepared({
      config: session.environmentPrepare,
      cwd,
      worktreeIdentity: cwd,
      artifactRoot: session.artifactRoot,
      artifactDir,
      runner,
    });
    if (reviewEnvPrepare.status === "failed") {
      return {
        result: "failed",
        context: { artifactDir, resolvedProfile },
        error: `Environment preparation failed (exit ${reviewEnvPrepare.exitCode ?? 1}) before review verification: ${(reviewEnvPrepare.output ?? "").slice(0, 500)}`,
      };
    }

    // Diff classification computed before the verification loop so that verification-failure
    // early returns carry file-level change data in the PR summary (issue #506). Non-fatal:
    // the summary renders "Not available" when the diff cannot be obtained. For Claude/Gemini
    // the diff bytes are re-fetched below where the review agent needs the full content.
    let diffClassification: DiffClassification | undefined;
    {
      const preDiffResult = runner.run("git", ["diff", `${reviewBase}...HEAD`], { cwd, maxBuffer: 10 * 1024 * 1024 });
      if (preDiffResult.exitCode === 0) {
        diffClassification = classifyDiffFromUnified(preDiffResult.stdout);
      }
    }

    // Step 4: Run verification commands
    // A failing command returns early below, so any command reached past the
    // loop is recorded as passed for the review brief.
    let issueRequiredVerifications: IssueRequiredVerification[] | undefined;
    const verificationEntries = Object.entries(session.verification);
    const verificationResults: { name: string; passed: boolean }[] = [];
    for (const [name, command] of verificationEntries) {
      const [verCmd, ...verArgs] = parseShellTokens(command);
      const verResult = runner.run(verCmd, verArgs, { cwd });
      const logFile = join(artifactDir, `review-verification-${name}.log`);
      writeFileSync(logFile, verResult.stdout + verResult.stderr, "utf8");
      if (verResult.exitCode !== 0) {
        const verificationOutput = (verResult.stdout + verResult.stderr).trim();
        const verificationFeedback = boundReviewFeedback(`Verification '${name}' failed (exit ${verResult.exitCode}):\n${verificationOutput}`);
        writeFileSync(
          join(artifactDir, "review-result.json"),
          JSON.stringify({ issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId, success: false, step: `verification:${name}` }, null, 2),
          "utf8",
        );
        const verOutput = [verResult.stdout, verResult.stderr].filter(Boolean).join("\n").trim();
        const reviewFeedback = boundReviewFeedback(`Verification '${name}' failed (exit ${verResult.exitCode}):\n${verOutput}`);
        const verLoopState = reviewLoopState(task, maxCycles);
        if (verLoopState.capReached) {
          // Free a synthetic `ai/pr-<n>` review worktree even on the cap handoff (issue
          // #459 review, P2): the cap escalates to a human who later requeues
          // implementation, which resolves the worktree on the PR's real `headRefName` —
          // and `resolveIssueWorktree` refuses the path while it is still checked out on
          // the synthetic branch. Same release as the non-cap fix handoff below; a no-op
          // for non-synthetic reviews.
          const syntheticBlocked = releaseSyntheticWorktreeForFix({
            reviewFeedback,
            verificationFeedback,
            verificationFailedStep: name,
            verificationFailure: { name, exitCode: verResult.exitCode },
            reviewCycles: verLoopState.completedCycles,
            reviewLoopCapReached: true,
            reviewLoopMaxCycles: maxCycles,
          });
          if (syntheticBlocked) return syntheticBlocked;
          const capMessage = `Review loop cap reached after ${verLoopState.completedCycles}/${maxCycles} blocking cycles (verification failure) — escalating to human.`;
          return {
            result: "blocked",
            context: {
              artifactDir,
              prUrl,
              branch,
              reviewFeedback,
              verificationFeedback,
              verificationFailedStep: name,
              verificationFailure: { name, exitCode: verResult.exitCode },
              reviewCycles: verLoopState.completedCycles,
              reviewLoopCapReached: true,
              reviewLoopMaxCycles: maxCycles,
              resolvedProfile,
              ...(diffClassification !== undefined ? { diffClassification } : {}),
            },
            message: capMessage,
          };
        }
        // Free a synthetic `ai/pr-<n>` review worktree before the fix handoff so the
        // implementation phase can re-materialize it on the PR's real head (issue #459
        // review, P2). Escalates to a human if it cannot be removed.
        const syntheticBlocked = releaseSyntheticWorktreeForFix({
          reviewFeedback,
          verificationFeedback,
          verificationFailedStep: name,
          verificationFailure: { name, exitCode: verResult.exitCode },
        });
        if (syntheticBlocked) return syntheticBlocked;
        const needsFixContext = {
          artifactDir,
          prUrl,
          branch,
          labels: taskLabels,
          reviewFeedback,
          verificationFeedback,
          verificationFailedStep: name,
          verificationFailure: { name, exitCode: verResult.exitCode },
          reviewCycles: verLoopState.completedCycles,
          resolvedProfile,
          ...(verLoopState.escalatedEffort !== undefined ? { escalatedEffort: verLoopState.escalatedEffort } : {}),
          ...(diffClassification !== undefined ? { diffClassification } : {}),
        };
        const forkBlocked = forkedPrHandoff("needs_fix", needsFixContext);
        if (forkBlocked) return forkBlocked;
        return {
          result: "needs_fix",
          context: needsFixContext,
          message: `Verification '${name}' failed (exit ${verResult.exitCode}): ${verOutput.slice(0, 300)}`,
        };
      }
      verificationResults.push({ name, passed: true });
    }

    // Step 4.5: Block if issue-required verification commands were not run.
    // Parse the issue body for explicit verification commands (e.g. inside a
    // "Verification" or "Test Plan" section). Any required command whose string
    // does not match a session.verification value is marked "not_run" — meaning
    // neither the implementation nor the review verification step executed it.
    // A single missing command routes to "blocked" so a human can add the command
    // to session.verification and retry.
    {
      const issueBody = typeof ctx.body === "string" ? ctx.body : undefined;
      if (issueBody) {
        const requiredCommands = extractIssueVerificationCommands(issueBody);
        if (requiredCommands.length > 0) {
          const rawManualEvidence = ctx.manualVerificationEvidence;
          const manualEvidence = Array.isArray(rawManualEvidence) ? (rawManualEvidence as ManualVerificationEntry[]) : undefined;
          const verifications = buildIssueVerificationStatus(requiredCommands, session.verification, manualEvidence);
          issueRequiredVerifications = verifications;
          const notRun = verifications.filter((v) => v.status === "not_run");
          if (notRun.length > 0) {
            writeFileSync(
              join(artifactDir, "review-result.json"),
              JSON.stringify({
                issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
                success: false, step: "issue-verification:not-run",
              }, null, 2),
              "utf8",
            );
            return withSyntheticWorktreeReleased({
              result: "blocked",
              context: {
                artifactDir,
                prUrl,
                branch,
                labels: taskLabels,
                issueRequiredVerifications: verifications,
                missingVerificationCommands: notRun.map((v) => v.command),
                resolvedProfile,
                ...(diffClassification !== undefined ? { diffClassification } : {}),
              },
              message: `Issue requires verification command(s) that were not run: ${notRun.map((v) => v.command).join(", ")}. Add the missing commands to session.verification or arrange to run them before review.`,
            });
          }
        }
      }
    }

    // Step 5: Review agent invocation
    // Pass the issue/task context as the review brief so the reviewer checks
    // requirement fit (issue body + acceptance criteria) and not only generic
    // code quality. For Codex, the brief is passed via --title; for Claude and
    // Gemini, the brief and PR diff are concatenated and passed via stdin.
    const body = typeof ctx.body === "string" ? ctx.body : undefined;
    const url = typeof ctx.url === "string" ? ctx.url : undefined;
    // Surface predecessor/dependency issues so the reviewer does not mistake
    // pre-existing baseline (introduced by a prior issue) for current-issue
    // additions. Both ctx.blockedBy (set by intake) and ctx.dependencyRecheck.blockedBy
    // (set on a dependency recheck) carry the same BlockedByEntry shape.
    const rawBlockedBy = (Array.isArray(ctx.blockedBy) ? ctx.blockedBy
      : Array.isArray((ctx.dependencyRecheck as Record<string, unknown> | undefined)?.["blockedBy"])
        ? (ctx.dependencyRecheck as Record<string, unknown>)["blockedBy"]
        : []) as { issueNumber?: unknown }[];
    const reviewDependencies = rawBlockedBy
      .filter((b) => typeof b.issueNumber === "number")
      .map((b) => ({ issueNumber: b.issueNumber as number }));
    // True when this review immediately follows a conflict_resolution success (issue #540).
    // Triggers conflict-specific review instructions and loop-cap tracking. Raw rationale
    // fields are never passed here; only this boolean reaches the review prompt.
    const postConflictReview = ctx["postConflictReview"] === true;
    const reviewBrief = buildReviewContext({
      issueNumber: task.issueNumber,
      title: title ?? `Issue #${task.issueNumber}`,
      url,
      labels: taskLabels,
      body,
      prUrl,
      branch,
      verificationResults,
      ...(issueRequiredVerifications !== undefined ? { issueRequiredVerifications } : {}),
      ...(reviewDependencies.length > 0 ? { dependencies: reviewDependencies } : {}),
      ...(postConflictReview ? { postConflictReview: true } : {}),
    });

    let reviewPromptArtifact: string;
    let reviewRunArgs: string[];
    let reviewStdin: string | undefined;
    // Whether the Gemini prompt was given a truncated diff. A clean Gemini output
    // over a truncated diff cannot certify the full PR (see the success guard below).
    let geminiDiffTruncated = false;

    if (cmdSpec.resolvedProfile.agentId === "claude" || cmdSpec.resolvedProfile.agentId === "gemini") {
      // Capture the PR diff so the prompt-driven agents have the full picture;
      // --base is handled by Codex internally, but Claude and Gemini are given the
      // diff in the prompt (Claude via stdin; Gemini via positional arg + stdin).
      const diffResult = runner.run("git", ["diff", `${reviewBase}...HEAD`], { cwd, maxBuffer: 10 * 1024 * 1024 });
      if (diffResult.exitCode !== 0) {
        return {
          result: "failed",
          context: { resolvedProfile },
          error: `Failed to capture PR diff for ${cmdSpec.resolvedProfile.agentId} review (exit ${diffResult.exitCode}): ${(diffResult.stderr || diffResult.stdout).slice(0, 300)}`,
        };
      }
      geminiDiffTruncated =
        cmdSpec.resolvedProfile.agentId === "gemini" && diffResult.stdout.length > MAX_REVIEW_DIFF_CHARS;
      const diff = geminiDiffTruncated
        ? `${diffResult.stdout.slice(0, MAX_REVIEW_DIFF_CHARS)}\n\n…(diff truncated)`
        : diffResult.stdout;
      // Parse the full diff (before Gemini truncation) to classify added/modified/deleted/renamed
      // files. Classification is derived from the complete diff so the guardrail section is
      // accurate even when the diff body is truncated for Gemini.
      diffClassification = classifyDiffFromUnified(diffResult.stdout);
      const stdinPrompt = buildClaudeReviewPrompt(reviewBrief, diff, diffClassification);
      reviewPromptArtifact = stdinPrompt;
      // Claude (`claude -p`) reads the prompt only from stdin. Gemini/Antigravity
      // follows the research contract `agy --print "<prompt>"`, where the prompt
      // is the positional argument; some builds ignore stdin, so passing it only
      // on stdin would run the review without the brief/diff. Send it both ways
      // for Gemini (argv-style spawn, so no shell quoting) and stdin-only for
      // Claude.
      reviewRunArgs = cmdSpec.resolvedProfile.agentId === "gemini"
        ? [...cmdSpec.baseArgs, stdinPrompt]
        : cmdSpec.baseArgs;
      reviewStdin = stdinPrompt;
    } else {
      // Codex: pass the review brief as the --title argument.
      // Codex resolves the diff internally via --base, so the diff text is not
      // passed as input. diffClassification was already computed before Step 4.
      reviewPromptArtifact = reviewBrief;
      reviewRunArgs = [...cmdSpec.baseArgs, "--title", reviewBrief];
      reviewStdin = undefined;
    }

    writeFileSync(join(artifactDir, "review-prompt.md"), reviewPromptArtifact, "utf8");
    const reviewResult = runner.run(cmdSpec.cmd, reviewRunArgs, {
      cwd, ...(reviewStdin !== undefined ? { stdin: reviewStdin } : {}),
    });

    writeFileSync(join(artifactDir, "review-output.md"), reviewResult.stdout || reviewResult.stderr, "utf8");

    const reviewOutputPath = join(artifactDir, "review-output.md");

    // Step 5.5: Post-review worktree cleanup (runs regardless of review exit code)
    // codex may leave staged changes, modified tracked files, or untracked files as
    // residue. Capture them as additional feedback, then restore the working tree so
    // subsequent handlers start clean. This must run before the early return below so
    // a failed review does not leave the repo dirty for the next execution.
    const postReviewStatus = runner.run("git", ["status", "--porcelain"], { cwd });
    let reviewResidue: string | undefined;
    if (postReviewStatus.stdout.trim().length > 0) {
      const diffResult = runner.run("git", ["diff", "HEAD"], { cwd });
      reviewResidue = diffResult.stdout.trim() || postReviewStatus.stdout.trim().slice(0, 2000);
      writeFileSync(join(artifactDir, "review-residue.diff"), reviewResidue, "utf8");
      // Fully restore the worktree. `git checkout -- .` only reverts unstaged
      // modifications to tracked files; it leaves staged changes and untracked
      // files behind. The downstream conflict-resolution handler rejects any
      // dirty `git status --porcelain`, so a partial cleanup would hand a
      // `conflict` result to a human instead of the resolver. `git reset --hard`
      // unstages and reverts tracked changes; `git clean -fd` removes untracked
      // files and directories.
      const resetResult = runner.run("git", ["reset", "--hard", "HEAD"], { cwd });
      const cleanResult = runner.run("git", ["clean", "-fd"], { cwd });
      // `git clean -fd` removes ALL untracked files that are not gitignored. If
      // environmentPrepare materialised files not covered by .gitignore (e.g. a
      // non-gitignored node_modules/), they were just deleted. Invalidate the
      // worktree-lifetime sentinel so the next phase re-runs prepare rather than
      // relying on a stamp that now misrepresents the checkout state.
      if (session.environmentPrepare?.enabled) {
        clearPrepareSentinel(cwd);
      }
      // Confirm the cleanup actually produced a clean tree; only then is it safe
      // to proceed (and, for a conflict result, to queue the resolver).
      const recheck = runner.run("git", ["status", "--porcelain"], { cwd });
      if (resetResult.exitCode !== 0 || cleanResult.exitCode !== 0 || recheck.stdout.trim().length > 0) {
        const dirtyFiles = (recheck.stdout.trim() || postReviewStatus.stdout.trim()).slice(0, 500);
        return withSyntheticWorktreeReleased({
          result: "blocked",
          context: {
            artifactDir,
            reviewOutputPath,
            reviewResidue,
            reviewFeedback: boundReviewFeedback(
              `Review agent left dirty working tree that could not be cleaned:\n${dirtyFiles}`,
            ),
            resolvedProfile,
          },
          message: `Review left dirty worktree (cleanup failed) — escalating to human. Files: ${dirtyFiles.slice(0, 200)}`,
        });
      }
    }

    if (reviewResult.exitCode !== 0) {
      // Capture whatever output exists so the outbox comment can include it.
      const reviewFailureOutput = (reviewResult.stdout || reviewResult.stderr).trim();
      // Quota/rate-limit exhaustion is recoverable on its own (issue #25): the
      // review agent ran out of its usage window, so delay the retry rather than
      // failing the task.
      const quota = classifyQuotaExhaustion(extractAgentFailureDiagnostic(agentId, reviewResult, { cmdSource: resolvedProfile.cmdSource }));
      writeFileSync(
        join(artifactDir, "review-result.json"),
        JSON.stringify({
          issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
          exitCode: reviewResult.exitCode, success: false,
          ...(quota.isQuotaExhaustion ? { delayed: true, quotaSignal: quota.signal } : {}),
          step: `${resolvedProfile.agentId}-review`,
        }, null, 2),
        "utf8",
      );
      if (quota.isQuotaExhaustion) {
        return {
          result: "delayed",
          context: { artifactDir, reviewOutputPath, resolvedProfile, quotaSignal: quota.signal, category: quota.category },
          message: `Review agent (${agentId}) hit a ${describeFailureCategory(quota.category)} condition (signal: "${quota.signal}"); delaying retry`,
          retryAfterMs: resolveRetryDelayOverrideMsForCategory(quota.category),
          category: quota.category,
        };
      }
      return {
        result: "failed",
        context: {
          artifactDir,
          reviewOutputPath,
          resolvedProfile,
          ...(reviewFailureOutput ? { reviewFailureOutput } : {}),
        },
        error: `Review agent (${agentId}) exited ${reviewResult.exitCode}: ${(reviewResult.stderr || reviewResult.stdout).slice(0, 500)}`,
      };
    }

    // Classify the review output
    const classification = classifyReviewOutput(reviewResult.stdout || reviewResult.stderr);

    writeFileSync(
      join(artifactDir, "review-result.json"),
      JSON.stringify({
        issueNumber: task.issueNumber,
        sessionId: task.sessionId,
        runId,
        agentId,
        exitCode: 0,
        success: true,
        artifactDir,
        prMergeBase: baseBranch,
        reviewDiffBase: reviewBase,
        ...classification,
      }, null, 2),
      "utf8",
    );

    const reviewOutput = reviewResult.stdout || reviewResult.stderr;

    // When the review agent left residue, append the diff as suggested changes so
    // the implementation agent has concrete guidance alongside the review text.
    const reviewFeedbackText = reviewResidue
      ? `${reviewOutput}\n\n## Suggested Changes (review agent edits)\n\n\`\`\`diff\n${reviewResidue}\n\`\`\``
      : reviewOutput;

    if (classification.classification === "needs_fix") {
      // Auto-requeue: return needs_fix so phase-runner transitions the task back
      // to queued implementation. Capture the full review output as reviewFeedback
      // so the fix prompt can include actionable findings.
      // Guard: if the review output is empty the classifier returns "blocked" above,
      // so here we can always trust reviewOutput is non-empty.
      const loopState = reviewLoopState(task, maxCycles);
      if (loopState.capReached) {
        // Free a synthetic `ai/pr-<n>` review worktree even on the cap handoff (issue
        // #459 review, P2): the cap escalates to a human who later requeues
        // implementation, which resolves the worktree on the PR's real `headRefName` —
        // and `resolveIssueWorktree` refuses the path while it is still checked out on
        // the synthetic branch. Same release as the non-cap fix handoff below; a no-op
        // for non-synthetic reviews.
        const syntheticBlocked = releaseSyntheticWorktreeForFix({
          reviewAgentUsed: agentId,
          reviewFeedback: boundReviewFeedback(reviewFeedbackText),
          reviewOutputPath,
          reviewCycles: loopState.completedCycles,
          reviewLoopCapReached: true,
          reviewLoopMaxCycles: maxCycles,
          ...(reviewResidue !== undefined ? { reviewResidue } : {}),
          ...classification,
        });
        if (syntheticBlocked) return syntheticBlocked;
        const capMessage = `Review loop cap reached after ${loopState.completedCycles}/${maxCycles} blocking cycles — escalating to human.`;
        return {
          result: "blocked",
          context: {
            artifactDir,
            reviewAgentUsed: agentId,
            prUrl,
            branch,
            reviewFeedback: boundReviewFeedback(reviewFeedbackText),
            reviewOutputPath,
            reviewCycles: loopState.completedCycles,
            reviewLoopCapReached: true,
            reviewLoopMaxCycles: maxCycles,
            resolvedProfile,
            ...(reviewResidue !== undefined ? { reviewResidue } : {}),
            ...(diffClassification !== undefined ? { diffClassification } : {}),
            ...classification,
          },
          message: capMessage,
        };
      }
      // Free a synthetic `ai/pr-<n>` review worktree before the fix handoff so the
      // implementation phase can re-materialize it on the PR's real head (issue #459
      // review, P2). Escalates to a human if the synthetic worktree cannot be removed.
      const syntheticBlocked = releaseSyntheticWorktreeForFix({
        reviewAgentUsed: agentId,
        ...(reviewResidue !== undefined ? { reviewResidue } : {}),
        ...classification,
      });
      if (syntheticBlocked) return syntheticBlocked;
      const needsFixContext = {
        artifactDir,
        reviewAgentUsed: agentId,
        prUrl,
        branch,
        labels: taskLabels,
        reviewFeedback: boundReviewFeedback(reviewFeedbackText),
        reviewOutputPath,
        reviewCycles: loopState.completedCycles,
        resolvedProfile,
        ...(loopState.escalatedEffort !== undefined ? { escalatedEffort: loopState.escalatedEffort } : {}),
        ...(reviewResidue !== undefined ? { reviewResidue } : {}),
        ...(diffClassification !== undefined ? { diffClassification } : {}),
        ...classification,
        // Reset conflict-review tracking so a subsequent implementation→review cycle
        // does not inherit the post-conflict loop counter (issue #540).
        postConflictReview: null,
        conflictReviewCycles: null,
      };
      const forkBlocked = forkedPrHandoff("needs_fix", needsFixContext);
      if (forkBlocked) return forkBlocked;
      return {
        result: "needs_fix",
        context: needsFixContext,
        message: classification.reason,
      };
    }

    if (classification.classification === "conflict") {
      // Every PR targets the session base branch (`main`), including a
      // dependency-started PR (issue #242). A merge conflict is therefore always
      // a conflict against `main`, which the conflict-resolution handler resolves
      // by merging `main` into the PR branch. Route to the conflict-resolution
      // lane (the thin runner queues `conflict_resolution` for a `conflict`
      // result). Returning `blocked` here would instead escalate straight to a
      // human and never exercise the resolver.
      //
      // Issue #540: post-conflict loop guard. When this review immediately follows a
      // conflict_resolution success (`postConflictReview: true`), track how many times
      // the conflict lane has been re-entered. If the cap is reached, escalate to human
      // instead of queuing another conflict_resolution that is unlikely to converge.
      const maxConflictReviewCycles = session.conflictResolutionLoop?.maxReviewCycles ?? DEFAULT_MAX_CONFLICT_REVIEW_CYCLES;
      const conflictLoopState = postConflictReview
        ? conflictReviewLoopState(task, maxConflictReviewCycles)
        : undefined;
      //
      // Free the review worktree first (issue #456): conflict_resolution runs in
      // the canonical checkout and checks out the PR branch, which Git refuses
      // while the worktree still holds it. If removal fails, escalate to a human
      // rather than queue a phase that would immediately fail on the held branch.
      const freed = freeReviewWorktree();
      if (!freed.ok) {
        return {
          result: "blocked",
          context: {
            artifactDir, reviewAgentUsed: agentId, prUrl, branch, resolvedProfile, reviewLockScope,
            ...(reviewResidue !== undefined ? { reviewResidue } : {}),
            ...classification,
          },
          message: `Review found merge conflicts, but ${describeWorktreeFreeFailure(freed, "conflict_resolution runs in the canonical checkout and Git refuses a branch already held by another worktree.")}`,
        };
      }
      if (conflictLoopState?.capReached) {
        return {
          result: "blocked",
          context: {
            artifactDir, reviewAgentUsed: agentId, prUrl, branch, resolvedProfile,
            conflictReviewCycles: conflictLoopState.completedCycles,
            conflictReviewLoopCapReached: true,
            conflictReviewLoopMaxCycles: maxConflictReviewCycles,
            ...(reviewResidue !== undefined ? { reviewResidue } : {}),
            ...classification,
          },
          message: `Conflict-review loop cap reached after ${conflictLoopState.completedCycles}/${maxConflictReviewCycles} cycle(s) — this PR has been returned from conflict_resolution to review and still shows merge-conflict signals. Escalating to human.`,
        };
      }
      const conflictContext = {
        artifactDir, reviewAgentUsed: agentId, prUrl, branch, resolvedProfile,
        ...(reviewResidue !== undefined ? { reviewResidue } : {}),
        ...(conflictLoopState !== undefined ? { conflictReviewCycles: conflictLoopState.completedCycles } : {}),
        ...classification,
      };
      const forkBlocked = forkedPrHandoff("conflict", conflictContext);
      if (forkBlocked) return forkBlocked;
      return {
        result: "conflict",
        context: conflictContext,
        message: classification.reason,
      };
    }

    // Free a SYNTHETIC `ai/pr-<n>` review worktree before any terminal human handoff
    // (issue #459 review, P2). The `needs_fix`/`conflict` paths above already release it;
    // every remaining outcome — `success`, `blocked`, and the Gemini live-mergeability
    // gate below — hands the task to a human. The synthetic name deliberately differs from
    // the PR's real `headRefName`, so if a human later returns the task to implementation
    // fixes, that phase resolves the worktree on the real `headRefName` and
    // `resolveIssueWorktree` refuses this path while it is still checked out on
    // `ai/pr-<n>` — wedging the PR-url-only review/fix cycle. Removing it now (the review
    // only read/verified the head; nothing here is worth preserving) lets the fix phase
    // re-materialize cleanly. The Gemini merge check below queries `gh pr view` in
    // `session.repoRoot` rather than the worktree, so it is unaffected by this removal.
    // Escalate to a human when the synthetic worktree cannot be removed. A no-op for
    // non-synthetic reviews.
    if (worktreeOnSyntheticPrBranch) {
      const freed = freeReviewWorktree();
      if (!freed.ok) {
        const prNum = prUrl ? extractPrNumber(prUrl) : undefined;
        return {
          result: "blocked",
          context: {
            artifactDir, reviewAgentUsed: agentId, prUrl, branch, resolvedProfile, reviewLockScope,
            ...(reviewResidue !== undefined ? { reviewResidue } : {}),
            ...classification,
          },
          message: `Review completed (${classification.classification}) but ${describeWorktreeFreeFailure(freed, `A later human-requested implementation fix resolves the worktree on the PR's real head and Git refuses a path already checked out on another branch (currently \`ai/pr-${prNum ?? "<n>"}\`).`)}`,
        };
      }
    }

    // For Gemini: the three-dot diff (merge-base diff) intentionally excludes
    // base-branch changes that landed after the fork, so a clean Gemini review
    // output cannot rule out conflicts introduced since the fork point. Live
    // mergeability from GitHub is therefore the only guard against those
    // conflicts before a Gemini-reviewed PR is promoted to ready_for_human.
    //
    // Fail closed: only a *confirmed* mergeable result promotes to success. A
    // confirmed conflict routes to conflict_resolution; anything that leaves
    // mergeability unconfirmed — missing selector, `gh` failure, unparsable
    // JSON, or an UNKNOWN/unset mergeable state — blocks for a human rather
    // than reaching them as falsely approved. (Codex/Claude reviews diff
    // against the live base and are unaffected.)
    if (resolvedProfile.agentId === "gemini" && classification.classification === "success") {
      const mergeContext = {
        artifactDir, reviewAgentUsed: agentId, prUrl, branch,
        ...(reviewResidue !== undefined ? { reviewResidue } : {}),
        ...classification,
      };
      // A truncated diff means any blocking change after the cutoff was never shown
      // to Gemini, so a clean output cannot certify the full PR. Unlike the
      // Claude/Codex paths (which review the full captured diff), the Gemini prompt
      // is bounded by MAX_REVIEW_DIFF_CHARS; fail closed to a human rather than
      // promoting a partially reviewed PR to ready_for_human (issue #264 review
      // follow-up). needs_fix/conflict outcomes are handled above and are unaffected
      // — only a clean pass is unsafe to trust on a truncated diff.
      if (geminiDiffTruncated) {
        return {
          result: "blocked",
          context: mergeContext,
          message: `Gemini review passed but the PR diff exceeded ${MAX_REVIEW_DIFF_CHARS} chars and was truncated before review — escalating to human rather than marking ready_for_human, since blocking changes after the cutoff were never shown to Gemini.`,
        };
      }
      const blockedForUnconfirmedMerge = (detail: string): PhaseHandlerResult => ({
        result: "blocked",
        context: mergeContext,
        message: `Gemini review passed but live PR mergeability could not be confirmed (${detail}) — escalating to human rather than marking ready_for_human, since the Gemini diff cannot see base-branch changes since the fork.`,
      });

      // Read live mergeability through the configured repo host.
      //
      // GitHub: the exact `gh pr view --json mergeable,mergeStateStatus` call,
      // scoped to the configured repo and run through the resolved `gh` runner.
      //
      // Non-GitHub (e.g. Gitea): resolve the PR by the head-branch convention.
      // Gitea exposes only a coarse boolean `mergeable` (mapped by the provider to
      // MERGEABLE/CONFLICTING/UNKNOWN) and has no `mergeStateStatus`, so the gate
      // below degrades safely: a confirmed CONFLICTING still routes to conflict
      // resolution and anything short of a confirmed MERGEABLE fails closed to a
      // human rather than auto-promoting to ready_for_human.
      let mergeData: { mergeable?: unknown; mergeStateStatus?: unknown };
      if (sessionRepoHost.ghRunner) {
        const prSelector = prUrl ? (extractPrNumber(prUrl) ?? branch) : branch;
        if (!prSelector) {
          return blockedForUnconfirmedMerge("no PR number or branch available to query mergeability");
        }
        const mergeCheckResult = sessionRepoHost.ghRunner.run(
          ["pr", "view", prSelector, "--repo", session.githubRepo, "--json", "mergeable,mergeStateStatus"],
          // Run in the canonical checkout, not the review worktree: a SYNTHETIC `ai/pr-<n>`
          // worktree is removed before this gate (issue #459 review, P2), so its path may
          // no longer exist. `--repo` makes the query repo-explicit and cwd-independent.
          { cwd: session.repoRoot },
        );
        if (mergeCheckResult.exitCode !== 0) {
          return blockedForUnconfirmedMerge(`\`gh pr view ${prSelector}\` exited ${mergeCheckResult.exitCode}`);
        }
        try {
          mergeData = JSON.parse(mergeCheckResult.stdout) as { mergeable?: unknown; mergeStateStatus?: unknown };
        } catch {
          return blockedForUnconfirmedMerge("mergeability response was not valid JSON");
        }
      } else {
        const found = sessionRepoHost.provider.findPullRequestForWorkItem(task.issueNumber);
        if (found.kind === "failed") {
          return blockedForUnconfirmedMerge(`repo-host PR lookup failed: ${found.error}`);
        }
        if (found.kind === "none") {
          return blockedForUnconfirmedMerge(`no open PR found for issue #${task.issueNumber}`);
        }
        mergeData = {
          mergeable: found.pullRequest.mergeable,
          ...(found.pullRequest.mergeStateStatus !== undefined
            ? { mergeStateStatus: found.pullRequest.mergeStateStatus }
            : {}),
        };
      }
      if (mergeData.mergeable === "CONFLICTING" || mergeData.mergeStateStatus === "DIRTY") {
        // Apply the same conflict-review loop cap as the classifier `conflict`
        // branch (issue #540): the live mergeability check can also return a
        // conflict signal, and without this guard a postConflictReview cycle
        // that still shows CONFLICTING/DIRTY will re-queue conflict_resolution
        // indefinitely without ever hitting the cap.
        const maxGeminiConflictCycles = session.conflictResolutionLoop?.maxReviewCycles ?? DEFAULT_MAX_CONFLICT_REVIEW_CYCLES;
        const geminiConflictLoopState = postConflictReview
          ? conflictReviewLoopState(task, maxGeminiConflictCycles)
          : undefined;
        if (geminiConflictLoopState?.capReached) {
          return {
            result: "blocked",
            context: {
              ...mergeContext,
              conflictReviewCycles: geminiConflictLoopState.completedCycles,
              conflictReviewLoopCapReached: true,
              conflictReviewLoopMaxCycles: maxGeminiConflictCycles,
            },
            message: `Conflict-review loop cap reached after ${geminiConflictLoopState.completedCycles}/${maxGeminiConflictCycles} cycle(s) — Gemini review passed but the PR still shows merge-conflict signals (mergeable=${String(mergeData.mergeable)}, mergeStateStatus=${String(mergeData.mergeStateStatus)}). Escalating to human.`,
          };
        }
        const geminiConflictContext = {
          ...mergeContext,
          ...(geminiConflictLoopState !== undefined ? { conflictReviewCycles: geminiConflictLoopState.completedCycles } : {}),
        };
        // Free the review worktree before the conflict handoff (issue #456): the
        // canonical conflict_resolution checkout collides with the PR branch while
        // the worktree holds it. On removal failure, escalate to a human rather
        // than queue a phase that would immediately fail on the held branch.
        const freed = freeReviewWorktree();
        if (!freed.ok) {
          return {
            result: "blocked",
            context: geminiConflictContext,
            message: `Gemini review passed but PR has unresolved merge conflicts (mergeable=${String(mergeData.mergeable)}, mergeStateStatus=${String(mergeData.mergeStateStatus)}); ${describeWorktreeFreeFailure(freed, "conflict_resolution runs in the canonical checkout and Git refuses a branch already held by another worktree.")}`,
          };
        }
        const forkBlocked = forkedPrHandoff("conflict", geminiConflictContext);
        if (forkBlocked) return forkBlocked;
        return {
          result: "conflict",
          context: geminiConflictContext,
          message: `Gemini review passed but PR has unresolved merge conflicts (mergeable=${String(mergeData.mergeable)}, mergeStateStatus=${String(mergeData.mergeStateStatus)}) — routing to conflict resolution.`,
        };
      }
      if (mergeData.mergeable !== "MERGEABLE") {
        // UNKNOWN (GitHub still computing) or any other unrecognized state: not a
        // confirmed conflict, but not confirmed mergeable either — fail closed.
        return blockedForUnconfirmedMerge(`mergeable=${String(mergeData.mergeable)}, mergeStateStatus=${String(mergeData.mergeStateStatus)}`);
      }
      // Confirmed mergeable — fall through to the success return below.
    }

    // success or blocked (empty/ambiguous output)
    // Clear post-conflict tracking so a subsequent human requeue or
    // implementation→review cycle does not inherit conflict-specific prompts
    // or a stale cycle count (issue #540, P2).
    return {
      result: classification.classification,
      context: {
        artifactDir, reviewAgentUsed: agentId, prUrl, branch, resolvedProfile,
        // Operator diagnostics (issue #667): the PR's merge target vs. the diff base
        // this run actually reviewed against — distinct for a dependency-started task.
        prMergeBase: baseBranch, reviewDiffBase: reviewBase,
        ...(reviewResidue !== undefined ? { reviewResidue } : {}),
        ...(diffClassification !== undefined ? { diffClassification } : {}),
        ...(issueRequiredVerifications !== undefined ? { issueRequiredVerifications } : {}),
        ...classification,
        postConflictReview: null,
        conflictReviewCycles: null,
      },
      message: classification.reason,
    };
    } finally {
      // Release the issue worktree lock on every path (no-op when the phase runner
      // already owns the lock, i.e. `phaseLockOwnerId` is set), so the next phase
      // for this issue is never blocked (issue #456).
      releaseLock?.();
    }
  };
}

function extractPrNumber(prUrl: string): string | undefined {
  // GitHub PR URLs use `/pull/<n>`; Gitea uses `/pulls/<n>`. Accept both so a
  // worktree review with only a `prUrl` resolves to a numeric selector the
  // provider can use, instead of passing the full URL to getPullRequest.
  const m = prUrl.match(/\/pulls?\/(\d+)/);
  return m ? m[1] : undefined;
}
