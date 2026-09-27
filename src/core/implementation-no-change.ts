/**
 * Issue #1125: the explained no-change fix turn.
 *
 * An existing-PR fix run whose implementer edits nothing is normally a failure
 * (`produced no file changes`, `handlers/implementation.ts` step `diff-check`),
 * and for a FRESH implementation it must stay one. But a fix turn answering
 * review or verification feedback can legitimately end with no new edit: the
 * failure does not reproduce, the repair is already committed on the branch, a
 * human finished the work, the cause was environmental, or the finding itself
 * is mistaken. Today those runs die before the runner's own verification can
 * say anything, so the PR never returns to review.
 *
 * This module is the *decision* half of that correction, and nothing else:
 *
 *  - it parses ONE declaration out of the agent's output — the same fenced
 *    ```` ```json ```` envelope #837/#843 already use, validated with #836's
 *    evidence-reference validator and resolved by #842's read-only resolver, so
 *    no second evidence format or evidence service enters the system;
 *  - it answers ONE question for the caller: may this fix run end with zero file
 *    changes, and if not, exactly why not.
 *
 * What it deliberately does NOT do: run verification (the runner owns that, and
 * an admitted declaration is a licence to REACH verification, never to skip or
 * pass it), decide a disposition, move a lineage, clear a finding, or select a
 * phase. A structured review with lineages awaiting a §3.1 disposition is
 * answered by the Review Dispute protocol's own §3.4 zero-change rule
 * (`review-fix-disposition-response.ts`) and never by this module — the caller
 * passes `structuredDispositionPending` and this module refuses, so the two
 * paths can never both admit the same run.
 *
 * Pure and side-effect-free: every I/O the decision needs (evidence resolution,
 * the branch-history probe, the published-revision probe) arrives as an
 * injected predicate.
 */
import {
  MAX_EVIDENCE_QUOTE_CHARS,
  MAX_EVIDENCE_REFS_PER_RECORD,
  MAX_WHY_NO_CHANGE_CHARS,
  REVIEW_DISPUTE_RECORD_MAX_BYTES,
  type EvidenceRef,
} from "./review-dispute.js";
import { validateEvidenceRef, type EvidenceRefResolver } from "./review-dispute-validation.js";

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

/**
 * Why no further edit is needed.
 *
 * A closed token set, because the token is recorded in task context and read
 * back by the review continuation and by operators — free prose there would be
 * unfilterable. It is NOT an allowlist of acceptable situations: `other` exists
 * precisely so a legitimate case nobody enumerated can still be declared, and
 * the token never decides admission on its own. The explanation, the quoted
 * feedback, the resolvable evidence, and the runner's own verification do.
 */
export const NO_CHANGE_REASONS = [
  /** The reported failure does not reproduce on this revision. */
  "not_reproducing",
  /** The fix is already committed on this branch (by an earlier run or another actor). */
  "already_committed",
  /** A human completed the work outside the loop. */
  "human_completed",
  /** The cause is environmental/infrastructural and needs no code edit. */
  "environmental",
  /** The feedback rests on a mistaken premise; the implementer rebuts it. */
  "feedback_mistaken",
  /** Anything else the five tokens above do not describe. */
  "other",
] as const;

export type NoChangeReason = (typeof NO_CHANGE_REASONS)[number];

/** Bound on the prose explanation — the same bound §3.2's `whyNoChange` carries. */
export const MAX_NO_CHANGE_EXPLANATION_CHARS = MAX_WHY_NO_CHANGE_CHARS;

/** Bound on the quoted feedback excerpt — the same bound an `issue_quote` carries. */
export const MAX_NO_CHANGE_FEEDBACK_QUOTE_CHARS = MAX_EVIDENCE_QUOTE_CHARS;

/**
 * Floor on the explanation, in normalized characters.
 *
 * "Nothing to do." is not an explanation, and admitting one would be inferring
 * success from a generic phrase — the exact thing this path must not do. The
 * floor is deliberately low: it rejects the empty gesture, not brevity.
 */
export const MIN_NO_CHANGE_EXPLANATION_CHARS = 80;

/**
 * Floor on the quoted feedback excerpt, in normalized characters.
 *
 * The quote is what ties the declaration to the feedback THIS turn is
 * answering, and it is verified by containment against that feedback. A
 * two-word quote would be contained in almost any text and would tie the
 * declaration to nothing.
 */
export const MIN_NO_CHANGE_FEEDBACK_QUOTE_CHARS = 24;

/**
 * How many CONSECUTIVE explained no-change fix turns a task may take before the
 * path refuses and the run falls back to today's failure (a human handoff).
 *
 * The reviewer decides whether an explanation answers its feedback, so a second
 * exchange is legitimate: the reviewer may sharpen the finding and the
 * implementer may answer the sharpened version. An endless ping-pong is not —
 * each round costs a full review run and converges on nothing. The counter is
 * consecutive: a fix turn that commits a real diff clears it, so a task that
 * keeps making progress is never bounded by this at all.
 */
export const MAX_CONSECUTIVE_NO_CHANGE_FIX_TURNS = 2;

/** `task.context` key carrying the last admitted declaration (bounded). */
export const NO_CHANGE_CONTEXT_FIELD = "implementationNoChange";

/** `task.context` key carrying the consecutive-turn counter. */
export const NO_CHANGE_TURNS_CONTEXT_FIELD = "noChangeFixTurns";

/** The implementer's answer to "why does this turn need no edit?". */
export interface NoChangeDeclaration {
  reason: NoChangeReason;
  /** A verbatim excerpt of the feedback this turn answers. */
  addressedFeedback: string;
  /** Why no further edit is needed, bounded prose. */
  explanation: string;
  /** §3.3 references, every one of which must resolve read-only. */
  evidenceRefs: EvidenceRef[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export const NO_CHANGE_FAILURE_REASONS = [
  /** No declaration block at all — the ordinary "the agent just did nothing" run. */
  "absent",
  /** A fenced `json` block this parser could not read at all. */
  "unparseable",
  /** A fenced `json` body past the #836 payload bound. */
  "payload-too-large",
  /** More than one declaration — picking a winner would silently drop the other. */
  "too-many-items",
  /** A field is missing, mistyped, out of bounds, or unknown. */
  "invalid-record",
  /** The explanation is below {@link MIN_NO_CHANGE_EXPLANATION_CHARS}. */
  "explanation-too-short",
  /** `addressedFeedback` is not an excerpt of the feedback this turn answers. */
  "feedback-not-quoted",
  /** At least one evidence reference did not resolve read-only. */
  "unresolvable-evidence",
] as const;

export type NoChangeFailureReason = (typeof NO_CHANGE_FAILURE_REASONS)[number];

export interface NoChangeFailure {
  reason: NoChangeFailureReason;
  /** A content-free locator (field path, ref index). Never agent prose. */
  detail: string | null;
}

export type NoChangeParseResult =
  | { ok: true; declaration: NoChangeDeclaration }
  | { ok: false; failure: NoChangeFailure };

export interface NoChangeParseInput {
  /** The agent's raw stdout/stderr. */
  response: string;
  /**
   * The feedback text THIS fix prompt rendered — review feedback, and the
   * continuation's verification output when one was rendered. `addressedFeedback`
   * is checked for containment against it, so a declaration cannot cite feedback
   * the run was never given.
   */
  feedback: string;
  /** #842's read-only §3.3 resolver, over the checkout the agent left behind. */
  resolveEvidenceRef: EvidenceRefResolver;
}

/** The closed field set of a declaration object. */
const DECLARATION_FIELDS = [
  "noChangeRequired",
  "reason",
  "addressedFeedback",
  "explanation",
  "evidenceRefs",
] as const;

/** Built fresh per call: a module-level global regex carries `lastIndex`. */
function jsonBlockPattern(): RegExp {
  return /```[ \t]*json[ \t]*\r?\n([\s\S]*?)```/gi;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function fail(reason: NoChangeFailureReason, detail: string | null): NoChangeParseResult {
  return { ok: false, failure: { reason, detail } };
}

/**
 * Read the single no-change declaration out of an agent response.
 *
 * Fail-closed on every ambiguity, because the alternative to a clean answer is
 * not a guess — it is today's `produced no file changes` failure, which is
 * already the safe outcome:
 *
 *  - a fenced `json` body that is not valid JSON, or is past the #836 payload
 *    bound, fails the whole response even when another fence carries a clean
 *    declaration: the unreadable one may well BE the declaration (truncated,
 *    oversized), and skipping it would silently pick a winner between two
 *    candidates — the one nobody can read being the one dropped;
 *  - a `json` block that parses but carries no `noChangeRequired` key is
 *    IGNORED, not fatal: an implementer may quote a config object or a test
 *    fixture in its write-up, and a readable object with no claim in it is
 *    recognizably not a declaration;
 *  - two declarations are `too-many-items`. The prompt asks for exactly one.
 */
export function parseNoChangeDeclaration(input: NoChangeParseInput): NoChangeParseResult {
  const pattern = jsonBlockPattern();
  const candidates: Record<string, unknown>[] = [];
  let unreadable: NoChangeFailure | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input.response)) !== null) {
    const body = match[1]!;
    if (Buffer.byteLength(body, "utf8") > REVIEW_DISPUTE_RECORD_MAX_BYTES) {
      unreadable ??= { reason: "payload-too-large", detail: "no-change-block" };
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      unreadable ??= { reason: "unparseable", detail: "no-change-block:invalid-json" };
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, "noChangeRequired")) continue;
    candidates.push(obj);
  }
  if (unreadable !== null) return { ok: false, failure: unreadable };
  if (candidates.length === 0) return fail("absent", "response:no-declaration-block");
  if (candidates.length > 1) return fail("too-many-items", `declarations:${candidates.length}`);

  const obj = candidates[0]!;
  for (const key of Object.keys(obj)) {
    if (!(DECLARATION_FIELDS as readonly string[]).includes(key)) {
      return fail("invalid-record", `declaration.${key}:unknown-field`);
    }
  }
  if (obj["noChangeRequired"] !== true) {
    return fail("invalid-record", "declaration.noChangeRequired:not-true");
  }
  const reason = obj["reason"];
  if (typeof reason !== "string" || !(NO_CHANGE_REASONS as readonly string[]).includes(reason)) {
    return fail("invalid-record", "declaration.reason");
  }
  const quote = obj["addressedFeedback"];
  if (typeof quote !== "string" || quote.length > MAX_NO_CHANGE_FEEDBACK_QUOTE_CHARS) {
    return fail("invalid-record", "declaration.addressedFeedback");
  }
  const explanation = obj["explanation"];
  if (typeof explanation !== "string" || explanation.length > MAX_NO_CHANGE_EXPLANATION_CHARS) {
    return fail("invalid-record", "declaration.explanation");
  }
  const rawRefs = obj["evidenceRefs"];
  if (!Array.isArray(rawRefs) || rawRefs.length < 1 || rawRefs.length > MAX_EVIDENCE_REFS_PER_RECORD) {
    return fail("invalid-record", "declaration.evidenceRefs");
  }
  const evidenceRefs: EvidenceRef[] = [];
  for (let i = 0; i < rawRefs.length; i++) {
    const validated = validateEvidenceRef(rawRefs[i], `declaration.evidenceRefs[${i}]`);
    if (!validated.ok) return fail("invalid-record", validated.failure.detail);
    evidenceRefs.push(validated.value);
  }

  // Content checks last: they are the ones whose refusal is about substance
  // rather than shape, and reporting a shape problem as a substance problem
  // would send an operator looking in the wrong place.
  const normalizedExplanation = normalize(explanation);
  if (normalizedExplanation.length < MIN_NO_CHANGE_EXPLANATION_CHARS) {
    return fail("explanation-too-short", `chars:${normalizedExplanation.length}`);
  }
  const normalizedQuote = normalize(quote);
  if (normalizedQuote.length < MIN_NO_CHANGE_FEEDBACK_QUOTE_CHARS) {
    return fail("feedback-not-quoted", `chars:${normalizedQuote.length}`);
  }
  if (!normalize(input.feedback).includes(normalizedQuote)) {
    return fail("feedback-not-quoted", "not-an-excerpt");
  }

  // §3.3's posture, applied here: a reference the runner cannot confirm is a
  // reference that does not resolve, and one unresolved reference sinks the
  // declaration. "Unverified" and "verified present" must never be the same
  // admission when the admission is what lets a zero-diff run continue.
  for (let i = 0; i < evidenceRefs.length; i++) {
    if (!input.resolveEvidenceRef(evidenceRefs[i]!)) {
      return fail("unresolvable-evidence", `declaration.evidenceRefs[${i}]`);
    }
  }

  return {
    ok: true,
    declaration: {
      reason: reason as NoChangeReason,
      addressedFeedback: quote.trim(),
      explanation: explanation.trim(),
      evidenceRefs,
    },
  };
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export const NO_CHANGE_REFUSAL_REASONS = [
  /** Not a fix/continuation turn — a fresh implementation keeps today's failure. */
  "not-a-fix-turn",
  /** The Review Dispute protocol owns this run's zero-change question (§3.4). */
  "structured-dispositions-pending",
  /** A live Tool Request handoff is authoritative over any no-change claim. */
  "unresolved-tool-request",
  /** {@link MAX_CONSECUTIVE_NO_CHANGE_FIX_TURNS} consecutive turns already spent. */
  "turn-cap-reached",
  /** The response carried no admissible declaration; see `failure`. */
  "declaration-refused",
  /** The branch carries no commits of this Issue's own beyond its start point. */
  "no-issue-commits",
  /** The branch-history probe could not answer; inconclusive is not admitted. */
  "branch-probe-failed",
  /** Local `HEAD` is not the PR head on origin: local-only commits are not reviewable. */
  "revision-unpublished",
  /** The published PR head could not be resolved; an unconfirmed revision is not admitted. */
  "published-revision-probe-failed",
] as const;

export type NoChangeRefusalReason = (typeof NO_CHANGE_REFUSAL_REASONS)[number];

/**
 * What the caller's Git probe found on the PR head: commits belonging to this
 * Issue beyond the branch start point (`has-issue-commits`), a branch carrying
 * nothing of its own (`no-issue-commits` — an empty branch, or one holding only
 * a predecessor's commits), or an unanswerable probe (`unknown`).
 */
export type BranchCommitProbe = "has-issue-commits" | "no-issue-commits" | "unknown";

/**
 * What the caller's publication probe found: local `HEAD` is exactly the freshly
 * fetched PR head (`published`, carrying the revision a reviewer would read),
 * differs from it (`unpublished` — an earlier fix that committed but whose push
 * failed leaves local-only commits the PR does not contain), or could not be
 * resolved at all (`unknown`).
 *
 * This is the no-change path's equivalent of the Tool Request resume path's
 * ahead-of-origin refusal: that path continues from a branch only when origin
 * confirms it, and this path returns a revision to review only when origin
 * confirms it. It matters more here than anywhere else, because an admitted
 * no-change turn pushes NOTHING — nothing later reconciles the branch with
 * origin, so an unpublished commit would be verified, reported, and reviewed
 * without ever reaching the PR.
 */
export type PublishedRevisionProbe =
  | { status: "published"; revision: string }
  | { status: "unpublished"; detail: string | null }
  | { status: "unknown"; detail: string | null };

export interface NoChangeAdmissionInput {
  /** True for a fix/continuation turn on a positively identified open PR. */
  fixMode: boolean;
  /** True when a structured review has lineages awaiting a §3.1 disposition. */
  structuredDispositionPending: boolean;
  /** True when `task.context` carries an unresolved Tool Request handoff. */
  unresolvedToolRequest: boolean;
  /** Consecutive explained no-change turns this task has already taken. */
  priorNoChangeTurns: number;
  /**
   * This run's declaration, injected as a thunk: parsing can reach the evidence
   * resolver, whose first call captures the checkout's tracked-file index. A run
   * this module is going to refuse on a cheaper ground — a fresh implementation
   * above all — must not pay for that capture, and must not change its Git
   * command sequence merely because this path exists.
   */
  parseDeclaration: () => NoChangeParseResult;
  /**
   * The branch-history probe, injected as a thunk for the same reason and spent
   * last: a run with no admissible declaration must not pay for a `git
   * fetch`/`git diff` to learn it was going to fail anyway.
   */
  probeBranchCommits: () => BranchCommitProbe;
  /**
   * The publication probe, injected and spent LAST because it is the only step
   * that talks to the remote. It also yields the revision an admitted turn
   * hands forward, so the admitted revision is BY CONSTRUCTION the one origin
   * confirmed rather than a separately read local `HEAD`.
   */
  probePublishedRevision: () => PublishedRevisionProbe;
  /** Override for {@link MAX_CONSECUTIVE_NO_CHANGE_FIX_TURNS}, for tests. */
  maxConsecutiveTurns?: number;
}

export type NoChangeAdmission =
  | { admitted: true; declaration: NoChangeDeclaration; turn: number; revision: string }
  | { admitted: false; reason: NoChangeRefusalReason; failure?: NoChangeFailure; detail: string | null };

function refuse(
  reason: NoChangeRefusalReason,
  detail: string | null,
  failure?: NoChangeFailure,
): NoChangeAdmission {
  return { admitted: false, reason, detail, ...(failure ? { failure } : {}) };
}

/**
 * Decide whether this zero-diff run may continue to verification.
 *
 * Ordered cheapest-first, and every refusal is terminal: the caller's fallback
 * is the unchanged `produced no file changes` failure, so nothing here has to
 * invent an outcome — it only has to be sure before saying yes.
 */
export function admitNoChangeRun(input: NoChangeAdmissionInput): NoChangeAdmission {
  if (!input.fixMode) return refuse("not-a-fix-turn", null);
  if (input.structuredDispositionPending) return refuse("structured-dispositions-pending", null);
  if (input.unresolvedToolRequest) return refuse("unresolved-tool-request", null);
  const cap = input.maxConsecutiveTurns ?? MAX_CONSECUTIVE_NO_CHANGE_FIX_TURNS;
  const turn = input.priorNoChangeTurns + 1;
  if (turn > cap) return refuse("turn-cap-reached", `${input.priorNoChangeTurns}/${cap}`);
  const parse = input.parseDeclaration();
  if (!parse.ok) {
    return refuse("declaration-refused", parse.failure.detail, parse.failure);
  }
  const probe = input.probeBranchCommits();
  if (probe === "no-issue-commits") return refuse("no-issue-commits", null);
  if (probe === "unknown") return refuse("branch-probe-failed", null);
  // Last, and only for a run everything else already admits: the revision this
  // turn would return to review has to be the one the PR actually shows. An
  // admitted no-change turn commits and pushes nothing, so a local-only commit
  // would otherwise be verified and reviewed while the PR still holds the old
  // head.
  const published = input.probePublishedRevision();
  if (published.status === "unpublished") return refuse("revision-unpublished", published.detail);
  if (published.status === "unknown") return refuse("published-revision-probe-failed", published.detail);
  return { admitted: true, declaration: parse.declaration, turn, revision: published.revision };
}

/**
 * Read the consecutive-turn counter back out of `task.context`.
 *
 * Anything that is not a non-negative integer reads as 0: a corrupted counter
 * must not silently raise the cap, and it cannot lower it below the first turn
 * either.
 */
export function noChangeTurnsSpent(context: Record<string, unknown> | undefined): number {
  const raw = context?.[NO_CHANGE_TURNS_CONTEXT_FIELD];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return 0;
  return raw;
}

// ---------------------------------------------------------------------------
// The continuation record
// ---------------------------------------------------------------------------

/**
 * What an admitted no-change turn hands forward: the declaration, the exact
 * revision the runner verified, and the feedback the turn was answering.
 *
 * This is the whole payload of "no additional changes; verified and returned
 * for review" — it is not an approval, carries no disposition, and clears no
 * finding. The reviewer reads it and decides.
 */
export interface NoChangeContinuation {
  reason: NoChangeReason;
  addressedFeedback: string;
  explanation: string;
  evidenceRefs: EvidenceRef[];
  /** The commit the runner's verification actually ran against. */
  revision: string;
  /** The run that produced the declaration. */
  runId: string;
  /** 1-based index of this turn in the consecutive no-change sequence. */
  turn: number;
  /** The feedback this turn answered, bounded for storage. */
  feedback: string;
}

/** Storage bound on the carried-forward feedback excerpt. */
export const MAX_NO_CHANGE_CARRIED_FEEDBACK_CHARS = 4_000;

export function buildNoChangeContinuation(input: {
  declaration: NoChangeDeclaration;
  revision: string;
  runId: string;
  turn: number;
  feedback: string;
}): NoChangeContinuation {
  const feedback = input.feedback.trim();
  return {
    reason: input.declaration.reason,
    addressedFeedback: input.declaration.addressedFeedback,
    explanation: input.declaration.explanation,
    evidenceRefs: input.declaration.evidenceRefs,
    revision: input.revision,
    runId: input.runId,
    turn: input.turn,
    feedback:
      feedback.length > MAX_NO_CHANGE_CARRIED_FEEDBACK_CHARS
        ? `${feedback.slice(0, MAX_NO_CHANGE_CARRIED_FEEDBACK_CHARS)}\n…(truncated for storage)`
        : feedback,
  };
}

/**
 * Read a continuation back out of `task.context`, or `undefined` when the value
 * is absent or does not validate.
 *
 * Fail-closed by omission: a malformed record simply does not reach the review
 * prompt, exactly as a run that never declared anything would not. Nothing
 * downstream is entitled to act on a half-readable one.
 */
export function readNoChangeContinuation(context: unknown): NoChangeContinuation | undefined {
  const raw =
    typeof context === "object" && context !== null
      ? (context as Record<string, unknown>)[NO_CHANGE_CONTEXT_FIELD]
      : undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const reason = obj["reason"];
  const addressedFeedback = obj["addressedFeedback"];
  const explanation = obj["explanation"];
  const revision = obj["revision"];
  const runId = obj["runId"];
  const turn = obj["turn"];
  const feedback = obj["feedback"];
  if (typeof reason !== "string" || !(NO_CHANGE_REASONS as readonly string[]).includes(reason)) return undefined;
  if (typeof addressedFeedback !== "string" || addressedFeedback.trim() === "") return undefined;
  if (typeof explanation !== "string" || explanation.trim() === "") return undefined;
  if (typeof revision !== "string" || revision.trim() === "") return undefined;
  if (typeof runId !== "string" || runId.trim() === "") return undefined;
  if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 1) return undefined;
  if (typeof feedback !== "string") return undefined;
  const rawRefs = obj["evidenceRefs"];
  if (!Array.isArray(rawRefs) || rawRefs.length > MAX_EVIDENCE_REFS_PER_RECORD) return undefined;
  const evidenceRefs: EvidenceRef[] = [];
  for (const item of rawRefs) {
    const validated = validateEvidenceRef(item);
    if (!validated.ok) return undefined;
    evidenceRefs.push(validated.value);
  }
  return {
    reason: reason as NoChangeReason,
    addressedFeedback,
    explanation,
    evidenceRefs,
    revision,
    runId,
    turn,
    feedback,
  };
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

/**
 * Render one §3.3 reference the way the fix prompt documents it, so the example
 * the agent reads and the shape the parser accepts cannot drift.
 */
function evidenceExample(kind: string): string {
  switch (kind) {
    case "file":
      return '{ "kind": "file", "path": "src/foo.ts", "startLine": 10, "endLine": 24 }';
    case "doc_section":
      return '{ "kind": "doc_section", "path": "docs/some-contract.md", "section": "§4 Retry policy" }';
    case "issue_quote":
      return '{ "kind": "issue_quote", "quote": "exact text from the Issue body" }';
    default:
      return "";
  }
}

/**
 * The fix-prompt section that tells the implementer how to end a turn with no
 * edit — the request half of this module's response half.
 *
 * Rendered ONLY for a fix turn with no structured dispositions pending; with
 * dispositions pending the §3.1 contract is rendered instead and owns the same
 * question, so the two instructions are never in the same prompt.
 */
export function buildNoChangePromptSection(opts: {
  resolvableEvidenceKinds: readonly string[];
}): string[] {
  const examples = opts.resolvableEvidenceKinds.map(evidenceExample).filter((e) => e !== "");
  return [
    "",
    "## If No Further Change Is Needed",
    "",
    "Normally this turn ends with edits. If — and only if — you conclude that the feedback above requires no",
    "further edit (the reported failure does not reproduce, the fix is already committed on this branch, a human",
    "already completed the work, the cause is environmental, or the feedback rests on a mistaken premise), do not",
    "invent a cosmetic change. Declare it instead, as the LAST thing in your response, in a single fenced block:",
    "",
    "```json",
    "{",
    '  "noChangeRequired": true,',
    `  "reason": ${NO_CHANGE_REASONS.map((r) => `"${r}"`).join(" | ")},`,
    '  "addressedFeedback": "a verbatim excerpt of the feedback above that this declaration answers",',
    '  "explanation": "why no further edit is needed, specific to this repository and this feedback",',
    '  "evidenceRefs": [ … ]',
    "}",
    "```",
    "",
    `- \`addressedFeedback\` must be copied verbatim from the feedback above (at least ${MIN_NO_CHANGE_FEEDBACK_QUOTE_CHARS} characters).`,
    `  A declaration that quotes nothing from it is rejected, and the run fails as "produced no file changes".`,
    `- \`explanation\` must be at least ${MIN_NO_CHANGE_EXPLANATION_CHARS} characters and specific. "Nothing to do" is rejected.`,
    `- \`evidenceRefs\` must hold 1–${MAX_EVIDENCE_REFS_PER_RECORD} references that the runner can verify read-only. Usable kinds here:`,
    ...examples.map((e) => `    ${e}`),
    "  Every reference must resolve — a path that is not tracked, a line range past the end of the file, or a",
    "  quote that is not in the Issue body sinks the whole declaration.",
    "- Do NOT claim a verification command passed as your evidence. The runner runs the configured verification",
    "  commands itself after you exit, and its result — not yours — decides whether this PR returns to review.",
    "- Emit exactly one such block, and none at all if you did make edits.",
  ];
}
