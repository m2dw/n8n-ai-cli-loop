/**
 * Runtime validation for the review-dispute contracts (issue #836,
 * docs/review-dispute-contract.md §2, §3, §4, §8.1, §10.1, §12).
 *
 * Everything here fails closed, and everything here is about a RECORD: its
 * shape, its own fields' agreement, and its relation to the single lineage it
 * names. §12's malformed cases that this module decides are an unparseable
 * structured block, an unknown enum token, a missing or unknown field, an
 * unresolvable evidence reference, an `affectedBoundary` outside the repository,
 * a record for an unknown lineage, a record addressing a superseded version, a
 * `fixed` disposition in a run with no file changes, a `revise` without
 * predecessor or changed fields, an arbiter verdict outside the four tokens or
 * without a confidence, and an oversized payload.
 *
 * The §12 cases that read the TRANSITION table rather than the record — whether
 * the named lineage is in a state that accepts this record, whether a §6.1
 * rebuttal, reconsideration, or arbitration budget is still open, and whether a
 * persisted combination of state and counters is one the §7 rows could have
 * produced — belong to the transition orchestration Issue (#840), which owns the
 * counters they read. Their failure reasons are still declared below, so the two
 * halves of the vocabulary cannot drift.
 *
 * Nothing here mutates protocol state; this module only ever returns a verdict
 * about a record.
 *
 * Failure details are content-free: a field path plus, where useful, an observed
 * length, count, or version number. Never a fragment of the rejected value,
 * because a rejected record is agent-authored text that may end up in a log.
 */

import {
  ABSOLUTE_MAX_VERSION,
  APPLIED_TRANSITION_DIGEST_CHARS,
  APPLIED_TRANSITION_DIGEST_RE,
  ARBITER_VERDICTS,
  DISPUTE_ACTOR_ROLES,
  EVIDENCE_REF_KINDS,
  FINDING_FIELD_NAMES,
  FINDING_SEVERITIES,
  IMPLEMENTATION_DISPOSITIONS,
  LINEAGE_STATES,
  MAX_AFFECTED_BOUNDARY_CHARS,
  MAX_AGENT_ID_CHARS,
  MAX_APPLIED_TRANSITIONS_PER_LINEAGE,
  MAX_ARGUMENT_CHARS,
  MAX_DISPOSITIONS_PER_RUN,
  MAX_DOC_SECTION_CHARS,
  MAX_EVIDENCE_LINE,
  MAX_EVIDENCE_PATH_CHARS,
  MAX_EVIDENCE_QUOTE_CHARS,
  MAX_EVIDENCE_REFS_PER_RECORD,
  MAX_FINDINGS_PER_REVIEW,
  MAX_FINDING_TEXT_CHARS,
  MAX_LINEAGES_PER_TASK,
  MAX_MODEL_CHARS,
  MAX_NOTE_CHARS,
  MAX_RATIONALE_CHARS,
  MAX_RUN_ID_CHARS,
  MAX_TEST_EVIDENCE_ITEMS,
  MAX_TEST_NAME_CHARS,
  MAX_WHY_NO_CHANGE_CHARS,
  REBUTTAL_REASONS,
  REVIEWER_RECONSIDERATIONS,
  REVIEW_DISPUTE_CONTEXT_MAX_BYTES,
  REVIEW_DISPUTE_DEFAULT_LIMITS,
  REVIEW_DISPUTE_RECORD_MAX_BYTES,
  REVISION_KINDS,
  REVIEW_STRUCTURE_MODES,
  RUNNER_OWNED_FINDING_FIELDS,
  isLineageState,
  isTerminalLineageState,
  reviewStructureAllowsZeroChange,
} from "./review-dispute.js";
import { isLineageId, stableStringify } from "./review-dispute-lineage.js";
import type {
  ArbiterVerdictRecord,
  CandidateFinding,
  DispositionRecord,
  DisputeRecord,
  EvidenceRef,
  FindingAdmissionStamp,
  FindingBody,
  FindingFieldName,
  LineageCounters,
  LineageDisputeRun,
  PersistedLineage,
  ReconsiderationRecord,
  ReviewDisputeContext,
  ReviewDisputeLimits,
  ReviewFinding,
  ReviewerMeta,
  RevisionRecord,
} from "./review-dispute.js";

// ---------------------------------------------------------------------------
// Closed failure vocabulary
//
// The whole §12 vocabulary, including the five reasons this module never raises
// itself — `not-actionable-state`, `dispute-on-binding`,
// `rebuttal-slot-consumed`, `reconsideration-slot-consumed`, and
// `arbitration-passes-exhausted`. Those name transition prerequisites, which
// #840 owns; the vocabulary is declared here, once, so its emitter cannot invent
// a reason of its own.
// ---------------------------------------------------------------------------

export const REVIEW_DISPUTE_FAILURE_REASONS = [
  "unparseable",
  "payload-too-large",
  "not-an-object",
  "unknown-field",
  "missing-field",
  "unknown-enum",
  "invalid-type",
  "field-too-long",
  "too-many-items",
  "malformed-encoding",
  "invalid-evidence-ref",
  "unresolvable-evidence",
  "boundary-outside-repository",
  "unknown-lineage",
  "not-actionable-state",
  "dispute-on-binding",
  "stale-version",
  "invalid-version",
  "duplicate-lineage",
  "duplicate-version",
  "rebuttal-slot-consumed",
  "reconsideration-slot-consumed",
  "arbitration-passes-exhausted",
  "fixed-without-diff",
  "invalid-revision",
  "invalid-state-record",
] as const;
export type ReviewDisputeFailureReason = (typeof REVIEW_DISPUTE_FAILURE_REASONS)[number];

export interface ReviewDisputeFailure {
  reason: ReviewDisputeFailureReason;
  /** Content-free locator: a field path plus an observed length/count/version. */
  detail: string | null;
}

export type ReviewDisputeResult<T> = { ok: true; value: T } | { ok: false; failure: ReviewDisputeFailure };

class RecordError extends Error {
  constructor(readonly failure: ReviewDisputeFailure) {
    super(failure.reason);
  }
}

function fail(reason: ReviewDisputeFailureReason, detail: string | null): never {
  throw new RecordError({ reason, detail });
}

function guard<T>(fn: () => T): ReviewDisputeResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (err instanceof RecordError) return { ok: false, failure: err.failure };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Primitive checks
// ---------------------------------------------------------------------------

/**
 * Reject text the runner cannot safely re-encode or re-render: C0/C1 control
 * characters (which can hide content from a human reading an artifact) and lone
 * surrogates (which do not survive a UTF-8 round trip, so serialization would
 * not be stable). Written as a code-point scan so no control byte has to appear
 * in this source file.
 */
function hasMalformedEncoding(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
    if (code >= 0x7f && code <= 0x9f) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  // An absent embedded record is a MISSING field, not a malformed one: §3.2 and
  // §4.2 require the dispute/revision block, and the two cases read differently
  // in a diagnostic.
  if (value === undefined || value === null) fail("missing-field", path);
  if (typeof value !== "object" || Array.isArray(value)) fail("not-an-object", path);
  return value as Record<string, unknown>;
}

function requireClosedFields(obj: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(obj)) {
    // The unknown key is agent-chosen text, so only its position is recorded.
    if (!allowed.includes(key)) fail("unknown-field", path);
  }
}

function requireString(value: unknown, path: string, max: number): string {
  if (value === undefined || value === null) fail("missing-field", path);
  if (typeof value !== "string") fail("invalid-type", `${path}:not-a-string`);
  if (value.trim() === "") fail("missing-field", `${path}:empty`);
  if (hasMalformedEncoding(value)) fail("malformed-encoding", path);
  if (value.length > max) fail("field-too-long", `${path}:${value.length}`);
  return value;
}

function optionalString(value: unknown, path: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, path, max);
}

function requireBoolean(value: unknown, path: string): boolean {
  if (value === undefined) fail("missing-field", path);
  if (typeof value !== "boolean") fail("invalid-type", `${path}:not-a-boolean`);
  return value;
}

function requireInteger(value: unknown, path: string, min: number, max: number): number {
  if (value === undefined || value === null) fail("missing-field", path);
  if (typeof value !== "number" || !Number.isInteger(value)) fail("invalid-type", `${path}:not-an-integer`);
  if (value < min || value > max) fail("invalid-type", `${path}:out-of-range:${value}`);
  return value;
}

function requireEnum<T extends string>(value: unknown, path: string, tokens: readonly T[]): T {
  if (value === undefined || value === null) fail("missing-field", path);
  if (typeof value !== "string" || !(tokens as readonly string[]).includes(value)) fail("unknown-enum", path);
  return value as T;
}

function requireArray(value: unknown, path: string, max: number, minItems: number): unknown[] {
  if (value === undefined || value === null) fail("missing-field", path);
  if (!Array.isArray(value)) fail("invalid-type", `${path}:not-an-array`);
  if (value.length < minItems) fail("missing-field", `${path}:${value.length}`);
  if (value.length > max) fail("too-many-items", `${path}:${value.length}`);
  return value;
}

/**
 * §2.2: lineage ids are runner-minted, so a persisted key or a stamped id that
 * is not one is a corrupted record, never a lineage.
 *
 * Enforcing the minted format is also what keeps a parsed context from carrying
 * an inherited entry: `__proto__`, `constructor`, and every other prototype key
 * fails this test before it can be written into (or read out of) a lineage map.
 */
function requireLineageId(value: unknown, path: string, reason: ReviewDisputeFailureReason): string {
  const id = requireString(value, path, 80);
  if (!isLineageId(id)) fail(reason, `${path}:format`);
  return id;
}

/**
 * Look a lineage up by id, on OWN properties only.
 *
 * A record naming `__proto__` or `toString` must resolve to nothing rather than
 * to an inherited member of `Object.prototype`, and an id that could never have
 * been minted names no lineage either — both are `unknown-lineage`, which is the
 * §12 malformed outcome for a record addressed to a lineage that does not exist.
 */
function lookupLineage(
  lineages: Readonly<Record<string, PersistedLineage>>,
  lineageId: string,
  path: string,
): PersistedLineage {
  if (!isLineageId(lineageId)) fail("unknown-lineage", `${path}.lineageId`);
  if (!Object.prototype.hasOwnProperty.call(lineages, lineageId)) fail("unknown-lineage", `${path}.lineageId`);
  const lineage = lineages[lineageId];
  if (lineage === undefined) fail("unknown-lineage", `${path}.lineageId`);
  return lineage;
}

// ---------------------------------------------------------------------------
// §2.1 Repository-relative locations
// ---------------------------------------------------------------------------

/** A strict repository-relative path: no spaces, no traversal, no other OS. */
const REPO_PATH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

function isCleanRepoPath(value: string): boolean {
  if (!REPO_PATH_RE.test(value)) return false;
  const segments = value.split("/");
  return !segments.some((segment) => segment === "" || segment === "." || segment === "..");
}

/** An optional `:line` / `:line-line` suffix on a boundary's location token. */
const BOUNDARY_LINE_SUFFIX_RE = /:\d+(?:-\d+)?$/;

/** The boundary's leading token: a repository-relative path, line range aside. */
function isBoundaryLocationToken(token: string): boolean {
  return isCleanRepoPath(token.replace(BOUNDARY_LINE_SUFFIX_RE, ""));
}

/**
 * Every other token of a boundary names a member or qualifier of that location —
 * `#enqueue`, a section name — and so may not name a location itself. Without a
 * path separator, a home prefix, or a traversal, a token cannot spell a
 * filesystem path of any shape, which is what §11 needs to hold for the WHOLE
 * published value rather than for its first token.
 */
function isBoundaryMemberToken(token: string): boolean {
  if (token.includes("/") || token.includes("\\")) return false;
  if (token.startsWith("~")) return false;
  return !token.includes("..");
}

/**
 * §2.1 admission normalization for `affectedBoundary`.
 *
 * An absolute path *under the execution root* is rewritten to its
 * repository-relative form; anything that still names a location outside the
 * repository afterwards — an absolute filesystem path or a `..` escape — is
 * malformed. This runs BEFORE schema validation, and it is what lets §11
 * guarantee that no admitted lineage can carry a local filesystem path into a
 * public comment.
 *
 * Pure string work: nothing is stat'ed, so the same input always normalizes the
 * same way regardless of what exists on disk.
 *
 * The value may name a module or API surface rather than a bare path (§2.1), so
 * a `#member` suffix and internal spaces are tolerated — but every token is
 * checked, not just the leading one: the location token must be
 * repository-relative, and no other token may name a location at all.
 */
export function normalizeAffectedBoundary(
  raw: unknown,
  repoRoot?: string,
  path = "affectedBoundary",
): ReviewDisputeResult<string> {
  return guard(() => {
    const value = requireString(raw, path, MAX_AFFECTED_BOUNDARY_CHARS).trim();
    let candidate = value.replace(/\s+/g, " ");
    if (candidate.includes("\\")) fail("boundary-outside-repository", `${path}:backslash`);
    if (/^[A-Za-z]:[\\/]/.test(candidate)) fail("boundary-outside-repository", `${path}:drive-letter`);
    if (candidate.startsWith("~")) fail("boundary-outside-repository", `${path}:home-relative`);
    if (candidate.startsWith("/")) {
      const root = repoRoot?.replace(/\/+$/, "");
      if (!root || !(candidate === root || candidate.startsWith(`${root}/`))) {
        fail("boundary-outside-repository", `${path}:absolute`);
      }
      candidate = candidate === root ? "" : candidate.slice(root.length + 1);
    }
    candidate = candidate.replace(/^\.\//, "");
    if (candidate === "" || candidate === ".") fail("boundary-outside-repository", `${path}:empty`);
    // The WHOLE value is checked, not just its leading token. §11 publishes the
    // string verbatim, so a value like `src/core/outbox.ts ../../secret.txt`,
    // `src/core/outbox.ts#/etc/passwd`, or `file:///etc/passwd` would otherwise
    // pass admission on the strength of a clean first token and carry a local
    // path into a public comment.
    const [locationSection, ...memberSections] = candidate.split("#");
    const locationTokens = locationSection!.split(" ").filter((token) => token !== "");
    if (locationTokens.length === 0) fail("boundary-outside-repository", `${path}:empty`);
    const location = locationTokens[0]!;
    if (!isBoundaryLocationToken(location)) {
      const detail = location.split("/").includes("..") ? "traversal" : "location";
      fail("boundary-outside-repository", `${path}:${detail}`);
    }
    const memberTokens = [...locationTokens.slice(1), ...memberSections.flatMap((section) => section.split(" "))];
    for (const token of memberTokens) {
      if (token !== "" && !isBoundaryMemberToken(token)) fail("boundary-outside-repository", `${path}:member`);
    }
    return candidate;
  });
}

// ---------------------------------------------------------------------------
// §3.3 Evidence references
// ---------------------------------------------------------------------------

const EVIDENCE_REF_FIELDS: Record<EvidenceRef["kind"], readonly string[]> = {
  file: ["kind", "path", "startLine", "endLine"],
  test: ["kind", "name"],
  doc_section: ["kind", "path", "section"],
  issue_quote: ["kind", "quote"],
};

function validateEvidenceRefValue(raw: unknown, path: string): EvidenceRef {
  const obj = requireObject(raw, path);
  const kind = requireEnum(obj["kind"], `${path}.kind`, EVIDENCE_REF_KINDS);
  requireClosedFields(obj, EVIDENCE_REF_FIELDS[kind], path);
  switch (kind) {
    case "file": {
      const filePath = requireString(obj["path"], `${path}.path`, MAX_EVIDENCE_PATH_CHARS);
      if (!isCleanRepoPath(filePath)) fail("invalid-evidence-ref", `${path}.path`);
      const startLine = requireInteger(obj["startLine"], `${path}.startLine`, 1, MAX_EVIDENCE_LINE);
      const endLine = requireInteger(obj["endLine"], `${path}.endLine`, 1, MAX_EVIDENCE_LINE);
      if (endLine < startLine) fail("invalid-evidence-ref", `${path}.endLine:before-start`);
      return { kind, path: filePath, startLine, endLine };
    }
    case "test": {
      return { kind, name: requireString(obj["name"], `${path}.name`, MAX_TEST_NAME_CHARS) };
    }
    case "doc_section": {
      const docPath = requireString(obj["path"], `${path}.path`, MAX_EVIDENCE_PATH_CHARS);
      // §3.3: "a named section of a contract document under `docs/`".
      if (!isCleanRepoPath(docPath) || !docPath.startsWith("docs/")) {
        fail("invalid-evidence-ref", `${path}.path:not-under-docs`);
      }
      return { kind, path: docPath, section: requireString(obj["section"], `${path}.section`, MAX_DOC_SECTION_CHARS) };
    }
    case "issue_quote": {
      return { kind, quote: requireString(obj["quote"], `${path}.quote`, MAX_EVIDENCE_QUOTE_CHARS) };
    }
  }
}

/** Validate one §3.3 evidence reference. Shape only; resolution is separate. */
export function validateEvidenceRef(raw: unknown, path = "evidenceRef"): ReviewDisputeResult<EvidenceRef> {
  return guard(() => validateEvidenceRefValue(raw, path));
}

function validateEvidenceRefs(raw: unknown, path: string): EvidenceRef[] {
  const items = requireArray(raw, path, MAX_EVIDENCE_REFS_PER_RECORD, 1);
  return items.map((item, i) => validateEvidenceRefValue(item, `${path}[${i}]`));
}

/**
 * §3.3: the runner resolves every reference read-only, under the repository
 * evidence contract's admission posture (bounded, tracked-file scope, no
 * symlinks, no network, nothing executed).
 *
 * Resolution needs I/O, so this module takes it as an injected predicate rather
 * than performing it: the resolver belongs to the pipeline (#842), while the
 * requirement that a record cannot be admitted without one is a contract fact
 * and is therefore expressed here — {@link admitFinding},
 * {@link admitDisposition}, and {@link admitReconsideration} all take it as a
 * REQUIRED option, so no caller can admit an unresolvable-evidence record by
 * omission.
 */
export type EvidenceRefResolver = (ref: EvidenceRef) => boolean;

// ---------------------------------------------------------------------------
// §2.1 Findings
// ---------------------------------------------------------------------------

const CANDIDATE_FINDING_FIELDS: readonly string[] = [
  "lineageId",
  "version",
  ...FINDING_FIELD_NAMES,
  // Runner-owned fields are KNOWN names, not unknown ones: §2.1 says a
  // reviewer-supplied value is ignored and logged, never admitted — which is a
  // different outcome from the unknown-field rejection above.
  "humanGate",
  "reviewerMeta",
];

export interface ValidatedCandidateFinding {
  candidate: CandidateFinding;
  /**
   * §2.1: runner-owned fields the agent supplied. They are dropped, never
   * admitted; the caller logs them.
   */
  ignoredRunnerOwnedFields: string[];
}

function validateCandidateFindingValue(raw: unknown, path: string, repoRoot?: string): ValidatedCandidateFinding {
  const obj = requireObject(raw, path);
  requireClosedFields(obj, CANDIDATE_FINDING_FIELDS, path);

  const ignoredRunnerOwnedFields: string[] = [];
  for (const field of RUNNER_OWNED_FINDING_FIELDS) {
    // `lineageId` is the one runner-owned field an agent may ECHO (§2.2), so it
    // is not ignored — it is validated below and used to attach, never to mint.
    if (field === "lineageId") continue;
    if (obj[field] !== undefined) ignoredRunnerOwnedFields.push(field);
  }

  const lineageIdRaw = obj["lineageId"];
  const lineageId = lineageIdRaw === undefined ? undefined : requireString(lineageIdRaw, `${path}.lineageId`, 80);

  const boundary = normalizeAffectedBoundary(obj["affectedBoundary"], repoRoot, `${path}.affectedBoundary`);
  if (!boundary.ok) throw new RecordError(boundary.failure);

  const candidate: CandidateFinding = {
    ...(lineageId !== undefined ? { lineageId } : {}),
    version: requireInteger(obj["version"], `${path}.version`, 1, ABSOLUTE_MAX_VERSION),
    severity: requireEnum(obj["severity"], `${path}.severity`, FINDING_SEVERITIES),
    violatedContract: requireString(obj["violatedContract"], `${path}.violatedContract`, MAX_FINDING_TEXT_CHARS),
    preconditions: requireString(obj["preconditions"], `${path}.preconditions`, MAX_FINDING_TEXT_CHARS),
    failureScenario: requireString(obj["failureScenario"], `${path}.failureScenario`, MAX_FINDING_TEXT_CHARS),
    affectedBoundary: boundary.value,
    requiredOutcome: requireString(obj["requiredOutcome"], `${path}.requiredOutcome`, MAX_FINDING_TEXT_CHARS),
    evidenceRefs: validateEvidenceRefs(obj["evidenceRefs"], `${path}.evidenceRefs`),
  };
  return { candidate, ignoredRunnerOwnedFields };
}

/**
 * Validate a §2.1 candidate finding — what a review run emits.
 *
 * The required-field rule is checked against the AGENT-authored fields only: a
 * first finding is never malformed for lacking a runner-owned field (§2.1).
 */
export function validateCandidateFinding(
  raw: unknown,
  opts: { path?: string; repoRoot?: string } = {},
): ReviewDisputeResult<ValidatedCandidateFinding> {
  return guard(() => validateCandidateFindingValue(raw, opts.path ?? "finding", opts.repoRoot));
}

/**
 * A full ISO-8601 calendar date-time with an EXPLICIT UTC offset.
 *
 * `Date.parse` accepts locale-dependent forms (`December 17, 1995 03:24:00`)
 * and offset-less fragments (`2026`), so it cannot stand in for the format
 * check: `ReviewerMeta.timestamp` is persisted audit data and must be readable
 * the same way everywhere it is later compared or published. The offset is
 * required for the same reason — a bare local time is not a point in time.
 */
const ISO_TIMESTAMP_RE =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * Does the day named by an ISO date actually exist in that month?
 *
 * `ISO_TIMESTAMP_RE` bounds the day by shape alone (01–31), so a date that
 * never occurred — `2026-02-29`, `2026-04-31` — still matches, and `Date.parse`
 * then ROLLS it into the following month rather than rejecting it. Admitting
 * that would persist audit metadata claiming a calendar day that never
 * happened, so the day is checked against the month it names.
 *
 * The instant is built field-wise via `setUTCFullYear` rather than `Date.UTC`
 * because the latter remaps two-digit years into the 1900s, which would reject
 * a well-formed year below 0100. The offset is irrelevant here: calendar
 * validity is a property of the local date the record spells out.
 */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(0, 0, 0, 0);
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function validateReviewerMeta(raw: unknown, path: string): ReviewerMeta {
  const obj = requireObject(raw, path);
  requireClosedFields(obj, ["agentId", "model", "effort", "reviewRunId", "timestamp"], path);
  const timestamp = requireString(obj["timestamp"], `${path}.timestamp`, 40);
  // The format decides admission; `Date.parse` stays only so a value that no
  // engine can turn into an instant is never recorded. The format check runs
  // first, so the date fields sit at fixed offsets once it passes.
  if (!ISO_TIMESTAMP_RE.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    fail("invalid-type", `${path}.timestamp:not-an-iso-timestamp`);
  }
  if (
    !isRealCalendarDate(
      Number(timestamp.slice(0, 4)),
      Number(timestamp.slice(5, 7)),
      Number(timestamp.slice(8, 10)),
    )
  ) {
    fail("invalid-type", `${path}.timestamp:not-an-iso-timestamp`);
  }
  const model = optionalString(obj["model"], `${path}.model`, MAX_MODEL_CHARS);
  const effort = optionalString(obj["effort"], `${path}.effort`, MAX_MODEL_CHARS);
  return {
    agentId: requireString(obj["agentId"], `${path}.agentId`, MAX_AGENT_ID_CHARS),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    reviewRunId: requireString(obj["reviewRunId"], `${path}.reviewRunId`, MAX_RUN_ID_CHARS),
    timestamp,
  };
}

/**
 * What this admission IS, per §2.2, and therefore which version it may carry.
 *
 * §2.3: `version` starts at 1 and increments by exactly 1, only via a `revise`.
 * The admissible version is consequently a property of the runner's admission
 * decision, never of the agent-authored record — so it is supplied here rather
 * than trusted from the candidate:
 *
 *  - `new` — a freshly minted lineage (the §2.2 `new` admission) or the single
 *    `supersedes` successor of §2.2. Both begin at version 1.
 *  - `attach` — a re-raise against a live lineage: the admitted record is that
 *    lineage's CURRENT version, since only a `revise` may advance it. The
 *    recorded version itself is supplied, because §2.3 makes it immutable — the
 *    re-raise attaches to it and never rewrites it.
 *  - `revision` — the §4.2 successor record: exactly `predecessorVersion + 1`.
 */
export type FindingAdmissionKind =
  | { kind: "new" }
  | { kind: "attach"; current: ReviewFinding }
  | { kind: "revision"; predecessorVersion: number };

export interface FindingAdmissionContext {
  /** §2.2/§2.3: the admission decision that fixes the admissible version. */
  admission: FindingAdmissionKind;
  /**
   * §2.1/§3.3: `evidenceRefs` are "one or more RESOLVABLE evidence references",
   * and §12 makes an unresolvable reference malformed for any record. Admission
   * is where that is enforced for a finding, under the same read-only posture a
   * dispute is held to, so an ungrounded finding never opens a lineage.
   */
  resolveEvidenceRef: EvidenceRefResolver;
  path?: string;
  repoRoot?: string;
}

function expectedAdmissionVersion(admission: FindingAdmissionKind, path: string): number {
  switch (admission.kind) {
    case "new":
      return 1;
    case "attach": {
      const current = requireObject(admission.current, `${path}.current`);
      return requireInteger(current["version"], `${path}.current.version`, 1, ABSOLUTE_MAX_VERSION);
    }
    case "revision":
      return (
        requireInteger(admission.predecessorVersion, `${path}.predecessorVersion`, 1, ABSOLUTE_MAX_VERSION - 1) + 1
      );
  }
}

export interface AdmittedFinding {
  /** The record of the lineage's version-of-record after this admission. */
  finding: ReviewFinding;
  /**
   * §2.3: on an `attach`, the §2.1 fields whose values the re-raise changed.
   * The recorded version is immutable, so a changed body is DISCARDED rather
   * than admitted; the caller logs it. Always empty for a `new` or `revision`
   * admission, which write a version of their own.
   */
  discardedChangedFields: FindingFieldName[];
}

/**
 * §2.3: the recorded fields a candidate would have changed.
 *
 * Compared on the stable serialization of each §2.1 field, so `evidenceRefs`
 * compares by value and member order inside a reference never matters.
 */
function changedFindingFields(current: FindingBody, candidate: FindingBody): FindingFieldName[] {
  return FINDING_FIELD_NAMES.filter((field) => stableStringify(current[field]) !== stableStringify(candidate[field]));
}

/**
 * §2.1 admission: the runner augments a candidate with the three runner-owned
 * fields and the required-field rule is then checked against the AUGMENTED
 * record. A reviewer-supplied value for a runner-owned field never survives —
 * the stamp always wins.
 *
 * Three things beyond the candidate schema are decided here because admission is
 * the trust boundary into an open lineage: the version must be the one the
 * admission decision allows (§2.3 — otherwise a first finding could enter as
 * version 2 and take version 2's routing without ever being revised), an
 * `attach` may not rewrite the version it attaches to (§2.3 again — the only way
 * to change a field is a §4.2 `revise`), and every evidence reference of a
 * newly written version must resolve (§3.3, §12).
 */
export function admitFinding(
  candidate: CandidateFinding,
  stamp: FindingAdmissionStamp,
  ctx: FindingAdmissionContext,
): ReviewDisputeResult<AdmittedFinding> {
  const path = ctx.path ?? "finding";
  return guard(() => {
    // Re-validate the candidate: admission is the trust boundary, and a caller
    // may hand over a record it built itself rather than one this module vetted.
    // The echoed `lineageId` is dropped first — the stamp is the only source of
    // the admitted one (§2.1).
    const unstamped: Record<string, unknown> = { ...candidate };
    delete unstamped["lineageId"];
    const { candidate: clean } = validateCandidateFindingValue(unstamped, path, ctx.repoRoot);
    const expectedVersion = expectedAdmissionVersion(ctx.admission, `${path}.admission`);
    if (clean.version !== expectedVersion) fail("invalid-version", `${path}.version:${clean.version}`);
    const lineageId = requireLineageId(stamp.lineageId, `${path}.lineageId`, "invalid-state-record");

    if (ctx.admission.kind === "attach") {
      // §2.2 + §2.3: the re-raise attaches to a version that already exists and
      // is immutable, so NOTHING new is admitted here — the record of that
      // version is returned unchanged. Without this, a later review could emit
      // the same identity tuple with different `preconditions`, a different
      // `requiredOutcome`, or different evidence and have it accepted at the
      // current version, which is exactly the silent change §2.3 reserves for a
      // §4.2 `revise`.
      //
      // The candidate's references are not resolved because none of them enter
      // the protocol; the returned record's own references were resolved when
      // that version was admitted.
      const current = ctx.admission.current;
      if (current.lineageId !== lineageId) fail("invalid-state-record", `${path}.admission.current.lineageId`);
      return { finding: current, discardedChangedFields: changedFindingFields(current, clean) };
    }

    for (const [i, ref] of clean.evidenceRefs.entries()) {
      if (!ctx.resolveEvidenceRef(ref)) fail("unresolvable-evidence", `${path}.evidenceRefs[${i}]`);
    }
    return {
      finding: {
        ...clean,
        lineageId,
        humanGate: requireBoolean(stamp.humanGate, `${path}.humanGate`),
        reviewerMeta: validateReviewerMeta(stamp.reviewerMeta, `${path}.reviewerMeta`),
      },
      discardedChangedFields: [],
    };
  });
}

/**
 * Reject duplicated ids and versions inside one admitted set (§2.2, §2.3).
 *
 * Two records for the same `lineageId` + `version` cannot both be the immutable
 * version-of-record, and two different versions of the same lineage inside one
 * review emission would mean the lineage advanced without a `revise`.
 */
export function validateFindingSet(findings: readonly ReviewFinding[]): ReviewDisputeResult<ReviewFinding[]> {
  return guard(() => {
    if (findings.length > MAX_FINDINGS_PER_REVIEW) {
      fail("too-many-items", `findings:${findings.length}`);
    }
    const seenLineages = new Set<string>();
    const seenVersions = new Set<string>();
    for (const finding of findings) {
      const versionKey = `${finding.lineageId}@${finding.version}`;
      if (seenVersions.has(versionKey)) fail("duplicate-version", `findings:${versionKey}`);
      seenVersions.add(versionKey);
      if (seenLineages.has(finding.lineageId)) fail("duplicate-lineage", `findings:${finding.lineageId}`);
      seenLineages.add(finding.lineageId);
    }
    return [...findings];
  });
}

/**
 * §2.3: versions start at 1, increment by exactly 1, and are immutable.
 *
 * A recorded history must therefore be a contiguous 1..n run with no repeats —
 * anything else means a version was overwritten or skipped.
 */
export function validateLineageVersionHistory(
  versions: readonly ReviewFinding[],
): ReviewDisputeResult<ReviewFinding[]> {
  return guard(() => {
    if (versions.length === 0) fail("missing-field", "versions:empty");
    if (versions.length > ABSOLUTE_MAX_VERSION) fail("too-many-items", `versions:${versions.length}`);
    const lineageId = versions[0]!.lineageId;
    const sorted = [...versions].sort((a, b) => a.version - b.version);
    sorted.forEach((finding, index) => {
      if (finding.lineageId !== lineageId) fail("duplicate-lineage", `versions[${index}].lineageId`);
      if (finding.version !== index + 1) fail("duplicate-version", `versions[${index}].version:${finding.version}`);
    });
    return sorted;
  });
}

// ---------------------------------------------------------------------------
// §3 Dispositions and disputes
// ---------------------------------------------------------------------------

const DISPUTE_FIELDS = [
  "challenged",
  "rebuttalReason",
  "argument",
  "evidenceRefs",
  "testEvidence",
  "whyNoChange",
] as const;
const DISPOSITION_FIELDS = ["lineageId", "version", "disposition", "note", "dispute"] as const;

function validateDisputeValue(raw: unknown, path: string): DisputeRecord {
  const obj = requireObject(raw, path);
  requireClosedFields(obj, DISPUTE_FIELDS, path);
  const challenged = requireObject(obj["challenged"], `${path}.challenged`);
  requireClosedFields(challenged, ["lineageId", "version"], `${path}.challenged`);
  const testEvidenceRaw = obj["testEvidence"];
  const testEvidence =
    testEvidenceRaw === undefined
      ? undefined
      : requireArray(testEvidenceRaw, `${path}.testEvidence`, MAX_TEST_EVIDENCE_ITEMS, 0).map((item, i) =>
          requireString(item, `${path}.testEvidence[${i}]`, MAX_TEST_NAME_CHARS),
        );
  return {
    challenged: {
      lineageId: requireString(challenged["lineageId"], `${path}.challenged.lineageId`, 80),
      version: requireInteger(challenged["version"], `${path}.challenged.version`, 1, ABSOLUTE_MAX_VERSION),
    },
    rebuttalReason: requireEnum(obj["rebuttalReason"], `${path}.rebuttalReason`, REBUTTAL_REASONS),
    argument: requireString(obj["argument"], `${path}.argument`, MAX_ARGUMENT_CHARS),
    // §3.2: REQUIRED — an unsupported assertion is not a dispute.
    evidenceRefs: validateEvidenceRefs(obj["evidenceRefs"], `${path}.evidenceRefs`),
    ...(testEvidence !== undefined ? { testEvidence } : {}),
    whyNoChange: requireString(obj["whyNoChange"], `${path}.whyNoChange`, MAX_WHY_NO_CHANGE_CHARS),
  };
}

function validateDispositionValue(raw: unknown, path: string): DispositionRecord {
  const obj = requireObject(raw, path);
  requireClosedFields(obj, DISPOSITION_FIELDS, path);
  const disposition = requireEnum(obj["disposition"], `${path}.disposition`, IMPLEMENTATION_DISPOSITIONS);
  const note = optionalString(obj["note"], `${path}.note`, MAX_NOTE_CHARS);
  const lineageId = requireString(obj["lineageId"], `${path}.lineageId`, 80);
  const version = requireInteger(obj["version"], `${path}.version`, 1, ABSOLUTE_MAX_VERSION);

  if (disposition === "review_disputed") {
    // §3.2: a `review_disputed` disposition MUST embed a dispute record.
    const dispute = validateDisputeValue(obj["dispute"], `${path}.dispute`);
    if (dispute.challenged.lineageId !== lineageId || dispute.challenged.version !== version) {
      fail("invalid-type", `${path}.dispute.challenged:mismatch`);
    }
    return { lineageId, version, disposition, ...(note !== undefined ? { note } : {}), dispute };
  }
  if (obj["dispute"] !== undefined) fail("unknown-field", `${path}.dispute:not-a-dispute`);
  return { lineageId, version, disposition, ...(note !== undefined ? { note } : {}) };
}

/** Validate a §3.1 disposition record structurally, with no lineage context. */
export function validateDispositionRecord(raw: unknown, path = "disposition"): ReviewDisputeResult<DispositionRecord> {
  return guard(() => validateDispositionValue(raw, path));
}

export interface DispositionAdmissionContext {
  /** The persisted lineages of `task.context.reviewDispute` (§10.1). */
  lineages: Readonly<Record<string, PersistedLineage>>;
  /** §3.4: a `fixed` disposition requires a diff. */
  runProducedFileChanges: boolean;
  /** §3.3: every evidence reference must resolve for a dispute to be admitted. */
  resolveEvidenceRef: EvidenceRefResolver;
}

export interface AdmittedDisposition {
  record: DispositionRecord;
  lineage: PersistedLineage;
  /** §3.3: only an ADMITTED dispute consumes the version's single rebuttal slot. */
  consumesRebuttal: boolean;
}

/**
 * Validate a §3.1 disposition against the lineage it names (§3, §12).
 *
 * Record-level only: the disposition must be well formed, must name a lineage
 * that exists, must address that lineage's CURRENT version (§2.3 makes older
 * ones immutable), and — when it disputes — must carry resolvable evidence
 * (§3.3). A `fixed` in a run with no diff is malformed by §3.4 and is rejected
 * here too, since that is a property of the record and the run, not of the
 * transition table.
 *
 * Whether the lineage's state ACCEPTS this disposition (§7.1 rule 2, row 24) and
 * whether the version's §6.1 rebuttal slot is still free are transition
 * prerequisites, and #840 owns them along with the counters they read. Every
 * rejection here leaves the lineage exactly where it was.
 */
export function admitDisposition(
  raw: unknown,
  ctx: DispositionAdmissionContext,
  path = "disposition",
): ReviewDisputeResult<AdmittedDisposition> {
  return guard(() => {
    const record = validateDispositionValue(raw, path);
    const lineage = lookupLineage(ctx.lineages, record.lineageId, path);
    if (record.version !== lineage.version) fail("stale-version", `${path}.version:${record.version}`);
    // §3.4: in a fix run that produced no file changes, every `fixed`
    // disposition is malformed and is rejected BEFORE any state transition.
    if (record.disposition === "fixed" && !ctx.runProducedFileChanges) {
      fail("fixed-without-diff", `${path}.disposition`);
    }

    let consumesRebuttal = false;
    if (record.disposition === "review_disputed") {
      for (const [i, ref] of record.dispute!.evidenceRefs.entries()) {
        if (!ctx.resolveEvidenceRef(ref)) fail("unresolvable-evidence", `${path}.dispute.evidenceRefs[${i}]`);
      }
      consumesRebuttal = true;
    }
    return { record, lineage, consumesRebuttal };
  });
}

/** Bound the number of disposition records one fix run may carry. */
export function validateDispositionSet(
  records: readonly DispositionRecord[],
): ReviewDisputeResult<DispositionRecord[]> {
  return guard(() => {
    if (records.length > MAX_DISPOSITIONS_PER_RUN) fail("too-many-items", `dispositions:${records.length}`);
    const seen = new Set<string>();
    for (const record of records) {
      // §3.1: exactly one disposition per finding version in the prompt.
      if (seen.has(record.lineageId)) fail("duplicate-lineage", `dispositions:${record.lineageId}`);
      seen.add(record.lineageId);
    }
    return [...records];
  });
}

// ---------------------------------------------------------------------------
// §4 Reconsideration and revision
// ---------------------------------------------------------------------------

const RECONSIDERATION_FIELDS = ["lineageId", "version", "reconsideration", "rationale", "revision"] as const;
const REVISION_FIELDS = [
  "predecessorVersion",
  "changedFields",
  "revisionKind",
  "materialityClaim",
  "successor",
] as const;

function validateRevisionValue(raw: unknown, path: string, repoRoot: string | undefined): RevisionRecord {
  const obj = requireObject(raw, path);
  requireClosedFields(obj, REVISION_FIELDS, path);
  const predecessorVersion = requireInteger(
    obj["predecessorVersion"], `${path}.predecessorVersion`, 1, ABSOLUTE_MAX_VERSION,
  );
  // §4.2 / §12: a `revise` that lists no changed fields is malformed.
  const changedRaw = requireArray(obj["changedFields"], `${path}.changedFields`, FINDING_FIELD_NAMES.length, 1);
  const changedFields: FindingFieldName[] = [];
  for (const [i, item] of changedRaw.entries()) {
    const field = requireEnum(item, `${path}.changedFields[${i}]`, FINDING_FIELD_NAMES);
    if (changedFields.includes(field)) fail("invalid-revision", `${path}.changedFields[${i}]:duplicate`);
    changedFields.push(field);
  }
  // The successor is a §2.1 candidate under the same rules; the runner re-stamps
  // the runner-owned fields at admission of each version.
  const { candidate } = validateCandidateFindingValue(obj["successor"], `${path}.successor`, repoRoot);
  // §4.2: the successor sits at `predecessorVersion + 1`. This ceiling is the
  // ABSOLUTE one, never the session's version budget: under
  // `MAX_VERSIONS_PER_LINEAGE = 1` the successor is still required and still
  // feeds the §5 check — it is simply never persisted (row 26).
  if (candidate.version !== predecessorVersion + 1) {
    fail("invalid-revision", `${path}.successor.version:${candidate.version}`);
  }
  return {
    predecessorVersion,
    changedFields,
    revisionKind: requireEnum(obj["revisionKind"], `${path}.revisionKind`, REVISION_KINDS),
    materialityClaim: requireBoolean(obj["materialityClaim"], `${path}.materialityClaim`),
    successor: candidate,
  };
}

function validateReconsiderationValue(
  raw: unknown,
  path: string,
  repoRoot: string | undefined,
): ReconsiderationRecord {
  const obj = requireObject(raw, path);
  requireClosedFields(obj, RECONSIDERATION_FIELDS, path);
  const lineageId = requireString(obj["lineageId"], `${path}.lineageId`, 80);
  const version = requireInteger(obj["version"], `${path}.version`, 1, ABSOLUTE_MAX_VERSION);
  const reconsideration = requireEnum(obj["reconsideration"], `${path}.reconsideration`, REVIEWER_RECONSIDERATIONS);
  const rationale = requireString(obj["rationale"], `${path}.rationale`, MAX_RATIONALE_CHARS);
  if (reconsideration === "revise") {
    const revision = validateRevisionValue(obj["revision"], `${path}.revision`, repoRoot);
    // §4.2: the predecessor must be the disputed version.
    if (revision.predecessorVersion !== version) {
      fail("invalid-revision", `${path}.revision.predecessorVersion:${revision.predecessorVersion}`);
    }
    if (revision.successor.lineageId !== undefined && revision.successor.lineageId !== lineageId) {
      fail("invalid-revision", `${path}.revision.successor.lineageId:mismatch`);
    }
    return { lineageId, version, reconsideration, rationale, revision };
  }
  if (obj["revision"] !== undefined) fail("unknown-field", `${path}.revision:not-a-revise`);
  return { lineageId, version, reconsideration, rationale };
}

/** Validate a §4.1 reconsideration record structurally, with no lineage context. */
export function validateReconsiderationRecord(
  raw: unknown,
  opts: { path?: string; repoRoot?: string } = {},
): ReviewDisputeResult<ReconsiderationRecord> {
  return guard(() => validateReconsiderationValue(raw, opts.path ?? "reconsideration", opts.repoRoot));
}

export interface ReconsiderationAdmissionContext {
  lineages: Readonly<Record<string, PersistedLineage>>;
  /**
   * §3.3 / §12: the successor candidate of a `revise` (§4.2) is a §2.1 finding,
   * and an unresolvable evidence reference is malformed for ANY record. The
   * successor is what the §5 check reads and what the arbiter is shown, so its
   * references are resolved here — REQUIRED, exactly like a dispute's, so no
   * caller can admit a revision onto unresolvable evidence by omission.
   */
  resolveEvidenceRef: EvidenceRefResolver;
  repoRoot?: string;
}

export interface AdmittedReconsideration {
  record: ReconsiderationRecord;
  lineage: PersistedLineage;
}

/**
 * Validate a §4.1 reconsideration against the lineage it names.
 *
 * Record-level only, like {@link admitDisposition}: shape, an existing lineage,
 * that lineage's current version, and resolvable successor evidence. Whether the
 * lineage is in the state that awaits a reviewer turn (§7.1 rule 2) and whether
 * a §6.1 reconsideration round is still available are transition prerequisites
 * owned by #840.
 *
 * A `revise` carries a §2.1 successor candidate, so this is where its evidence is
 * resolved (§3.3, §12) — the same posture a dispute is held to.
 */
export function admitReconsideration(
  raw: unknown,
  ctx: ReconsiderationAdmissionContext,
  path = "reconsideration",
): ReviewDisputeResult<AdmittedReconsideration> {
  return guard(() => {
    const record = validateReconsiderationValue(raw, path, ctx.repoRoot);
    const lineage = lookupLineage(ctx.lineages, record.lineageId, path);
    if (record.version !== lineage.version) fail("stale-version", `${path}.version:${record.version}`);
    // §3.3, §12: the successor's evidence must resolve before the revision is
    // admitted. A revision that reaches arbitration — non-material (row 12), or
    // material with no version budget left (row 26) — would otherwise carry
    // references to files or tests that do not exist.
    if (record.revision !== undefined) {
      for (const [i, ref] of record.revision.successor.evidenceRefs.entries()) {
        if (!ctx.resolveEvidenceRef(ref)) {
          fail("unresolvable-evidence", `${path}.revision.successor.evidenceRefs[${i}]`);
        }
      }
    }
    return { record, lineage };
  });
}

// ---------------------------------------------------------------------------
// §8.1 Arbiter verdicts
// ---------------------------------------------------------------------------

const VERDICT_FIELDS = ["lineageId", "version", "verdict", "confidence", "rationale"] as const;

/** Bounds the §8.1 shape scan, so a deeply nested payload cannot be the cost. */
const MAX_FINDING_SHAPE_SCAN_DEPTH = 8;

/**
 * §8.1: "any additional finding-shaped content in arbiter output is ignored and
 * logged, never admitted into the protocol."
 *
 * Ignored, not rejected — so an arbiter that volunteers a `newFinding` beside an
 * otherwise valid verdict still returns a decisive verdict, instead of becoming
 * a malformed attempt that burns a §6.1 pass and pushes the lineage toward
 * escalation. Any other unknown field is still malformed: the rule is about the
 * arbiter naming unrelated findings, not a licence for arbitrary output.
 *
 * Decided structurally, on the key or the value: a key that names a finding, a
 * key that IS a §2.1 finding field, or a value that is (or contains, at any
 * bounded depth) an object carrying a §2.1 finding field or a key that names a
 * finding.
 */
function carriesFindingFields(value: unknown, depth = 0): boolean {
  if (depth > MAX_FINDING_SHAPE_SCAN_DEPTH) return false;
  if (Array.isArray(value)) return value.some((item) => carriesFindingFields(item, depth + 1));
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (FINDING_FIELD_NAMES.some((field) => Object.prototype.hasOwnProperty.call(obj, field))) return true;
  // "contains" is the operative word: an arbiter that buries the volunteered
  // finding under a wrapper (`analysis: { newFinding: { severity: "P1" } }`) is
  // still naming a finding, and §8.1 has that ignored. Checking only the
  // wrapper's own keys would instead make it an unknown field, burning a §6.1
  // malformed attempt on an otherwise decisive verdict.
  return Object.keys(obj).some(
    (key) => key.toLowerCase().includes("finding") || carriesFindingFields(obj[key], depth + 1),
  );
}

function isFindingShapedField(key: string, value: unknown): boolean {
  if (key.toLowerCase().includes("finding")) return true;
  if ((FINDING_FIELD_NAMES as readonly string[]).includes(key)) return true;
  return carriesFindingFields(value);
}

export interface ValidatedArbiterVerdict {
  record: ArbiterVerdictRecord;
  /** §8.1: finding-shaped fields that were dropped. The caller logs them. */
  ignoredFindingShapedFields: string[];
}

function validateVerdictValue(raw: unknown, path: string): ValidatedArbiterVerdict {
  const obj = requireObject(raw, path);
  const ignoredFindingShapedFields: string[] = [];
  for (const key of Object.keys(obj)) {
    if ((VERDICT_FIELDS as readonly string[]).includes(key)) continue;
    if (isFindingShapedField(key, obj[key])) {
      ignoredFindingShapedFields.push(key);
      continue;
    }
    // The unknown key is agent-chosen text, so only its position is recorded.
    fail("unknown-field", path);
  }
  const confidence = obj["confidence"];
  // §12: an arbiter verdict without a confidence is malformed.
  if (confidence === undefined || confidence === null) fail("missing-field", `${path}.confidence`);
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    fail("invalid-type", `${path}.confidence:not-a-number`);
  }
  if (confidence < 0 || confidence > 1) fail("invalid-type", `${path}.confidence:out-of-range`);
  return {
    record: {
      lineageId: requireString(obj["lineageId"], `${path}.lineageId`, 80),
      version: requireInteger(obj["version"], `${path}.version`, 1, ABSOLUTE_MAX_VERSION),
      verdict: requireEnum(obj["verdict"], `${path}.verdict`, ARBITER_VERDICTS),
      confidence,
      rationale: requireString(obj["rationale"], `${path}.rationale`, MAX_RATIONALE_CHARS),
    },
    ignoredFindingShapedFields,
  };
}

/** Validate an §8.1 verdict record structurally, with no lineage context. */
export function validateArbiterVerdict(raw: unknown, path = "verdict"): ReviewDisputeResult<ValidatedArbiterVerdict> {
  return guard(() => validateVerdictValue(raw, path));
}

export interface VerdictAdmissionContext {
  lineages: Readonly<Record<string, PersistedLineage>>;
}

export interface AdmittedVerdict {
  record: ArbiterVerdictRecord;
  lineage: PersistedLineage;
  /** §8.1: finding-shaped fields that were ignored. The caller logs them. */
  ignoredFindingShapedFields: string[];
}

/**
 * Validate an §8.1 verdict against the lineage it names.
 *
 * Record-level only: shape, an existing lineage, and that lineage's current
 * version. Whether the lineage is actually awaiting arbitration and whether a
 * §6.1 arbitration pass remains are transition prerequisites owned by #840,
 * which also owns the `malformedArbiterAttempts` counter that a rejection here
 * feeds (§12, rows 20–21). This function never touches a counter.
 */
export function admitArbiterVerdict(
  raw: unknown,
  ctx: VerdictAdmissionContext,
  path = "verdict",
): ReviewDisputeResult<AdmittedVerdict> {
  return guard(() => {
    const { record, ignoredFindingShapedFields } = validateVerdictValue(raw, path);
    const lineage = lookupLineage(ctx.lineages, record.lineageId, path);
    if (record.version !== lineage.version) fail("stale-version", `${path}.version:${record.version}`);
    return { record, lineage, ignoredFindingShapedFields };
  });
}

// ---------------------------------------------------------------------------
// §10.1 Persisted context
// ---------------------------------------------------------------------------

const COUNTER_FIELDS = [
  "rebuttals",
  "reconsiderations",
  "arbitrationPasses",
  "malformedArbiterAttempts",
  "evidenceRoundsUsed",
] as const;

const PERSISTED_LINEAGE_FIELDS = [
  "lineageId",
  "state",
  "version",
  "counters",
  "rebuttedVersions",
  "disputeRuns",
  "appliedTransitions",
  "humanGate",
  "severity",
  "affectedBoundary",
  "outcome",
  "supersedes",
  "reopenRequested",
] as const;

/** #844: the closed shape of one `disputeRuns` entry. */
const LINEAGE_DISPUTE_RUN_FIELDS = ["version", "runId"] as const;

const CONTEXT_FIELDS = ["version", "reviewStructure", "lineages", "pendingReReview", "resolvedWithoutChanges"] as const;

/**
 * §6.1: the per-lineage ceiling of each counter.
 *
 * These are the same numbers the protocol spends at runtime, so a restored
 * record cannot claim a budget the session never had. Passing the session's
 * resolved limits matters because a session may LOWER any of them: with the
 * defaults an `arbitration_pending` lineage may have returned two verdicts, but
 * under `maxArbitrationPassesPerLineage: 1` a record saying it returned two is a
 * corrupted write, and restoring it would resume — or audit — a run that spent
 * more of the debate than the protocol allowed it to.
 *
 * `rebuttals` is the one per-VERSION limit (§4.1), so its per-lineage ceiling is
 * the product: at most one rebuttal for each version the lineage could mint.
 */
function counterCeilings(limits: ReviewDisputeLimits): Record<(typeof COUNTER_FIELDS)[number], number> {
  return {
    rebuttals: limits.maxRebuttalsPerVersion * limits.maxVersionsPerLineage,
    reconsiderations: limits.maxReconsiderationsPerLineage,
    arbitrationPasses: limits.maxArbitrationPassesPerLineage,
    malformedArbiterAttempts: limits.maxMalformedArbiterAttemptsPerLineage,
    evidenceRoundsUsed: limits.maxEvidenceRoundsPerLineage,
  };
}

function validateCounters(raw: unknown, path: string, limits: ReviewDisputeLimits): LineageCounters {
  const obj = requireObject(raw, path);
  requireClosedFields(obj, COUNTER_FIELDS, path);
  const ceilings = counterCeilings(limits);
  const counters = {} as LineageCounters;
  for (const field of COUNTER_FIELDS) {
    counters[field] = requireInteger(obj[field], `${path}.${field}`, 0, ceilings[field]);
  }
  return counters;
}

function validatePersistedLineageValue(
  raw: unknown,
  key: string,
  path: string,
  limits: ReviewDisputeLimits,
): PersistedLineage {
  const obj = requireObject(raw, path);
  requireClosedFields(obj, PERSISTED_LINEAGE_FIELDS, path);
  // §2.2: the id is runner-minted. Checking the minted format here is also what
  // keeps a prototype key (`__proto__`, `constructor`, …) out of a persisted
  // lineage map, whichever side of the pair carries it.
  const lineageId = requireLineageId(obj["lineageId"], `${path}.lineageId`, "invalid-state-record");
  if (lineageId !== key) fail("invalid-state-record", `${path}.lineageId:key-mismatch`);
  const stateRaw = obj["state"];
  if (!isLineageState(stateRaw)) fail("unknown-enum", `${path}.state`);
  const state = stateRaw;
  // §6.1: the version a PERSISTED lineage may have reached is bounded by the
  // session's `MAX_VERSIONS_PER_LINEAGE`, not by {@link ABSOLUTE_MAX_VERSION}.
  // The two differ whenever a session lowers the limit, and only the lowered
  // one describes what this session could have minted: under
  // `maxVersionsPerLineage: 1` row 11 never fires, so a version-2 record is a
  // final-response version the session explicitly disabled — restoring it would
  // resume the debate one round past where the operator closed it. The absolute
  // ceiling stays the bound for a SUCCESSOR candidate (§4.2, row 26), which is
  // still required and still validated at `predecessorVersion + 1` under the
  // lowered limit precisely because it is never persisted as a version.
  const maxVersion = limits.maxVersionsPerLineage;
  const version = requireInteger(obj["version"], `${path}.version`, 1, maxVersion);
  const counters = validateCounters(obj["counters"], `${path}.counters`, limits);

  const rebuttedRaw = requireArray(obj["rebuttedVersions"], `${path}.rebuttedVersions`, maxVersion, 0);
  const rebuttedVersions: number[] = [];
  for (const [i, item] of rebuttedRaw.entries()) {
    const value = requireInteger(item, `${path}.rebuttedVersions[${i}]`, 1, maxVersion);
    if (rebuttedVersions.includes(value)) fail("invalid-state-record", `${path}.rebuttedVersions[${i}]:duplicate`);
    // A rebuttal can only have been recorded against a version that exists, and
    // versions are minted in order, so nothing above the lineage's current
    // version is reachable. Admitting one would silently spend the future
    // version's single §4.1 rebuttal slot before that version is ever raised.
    if (value > version) fail("invalid-state-record", `${path}.rebuttedVersions[${i}]:future-version`);
    rebuttedVersions.push(value);
  }
  // The redundancy between the counter and the list is deliberate, and checking
  // it here is the point: a record whose two halves disagree is corrupted, and a
  // corrupted record must never decide whether a rebuttal slot is still free.
  if (counters.rebuttals !== rebuttedVersions.length) {
    fail("invalid-state-record", `${path}.counters.rebuttals:${counters.rebuttals}`);
  }

  // #844: the run identity behind each consumed rebuttal slot. Optional, because
  // a block written before dispute persistence existed carries none; when
  // present it must describe exactly the slots `rebuttedVersions` already
  // records. A run entry for a version whose slot is NOT consumed would claim a
  // rebuttal the counters deny, and a second entry for one version would make
  // the idempotency key ambiguous — both are corrupted records, and a corrupted
  // record must never decide whether a retried delivery is a replay or a new
  // rebuttal.
  const disputeRunsRaw = obj["disputeRuns"];
  let disputeRuns: LineageDisputeRun[] | undefined;
  if (disputeRunsRaw !== undefined) {
    const items = requireArray(disputeRunsRaw, `${path}.disputeRuns`, rebuttedVersions.length, 0);
    const runs: LineageDisputeRun[] = [];
    for (const [i, item] of items.entries()) {
      const entryPath = `${path}.disputeRuns[${i}]`;
      const entry = requireObject(item, entryPath);
      requireClosedFields(entry, LINEAGE_DISPUTE_RUN_FIELDS, entryPath);
      const entryVersion = requireInteger(entry["version"], `${entryPath}.version`, 1, maxVersion);
      if (!rebuttedVersions.includes(entryVersion)) {
        fail("invalid-state-record", `${entryPath}.version:not-rebutted`);
      }
      if (runs.some((run) => run.version === entryVersion)) {
        fail("invalid-state-record", `${entryPath}.version:duplicate`);
      }
      runs.push({
        version: entryVersion,
        runId: requireString(entry["runId"], `${entryPath}.runId`, MAX_RUN_ID_CHARS),
      });
    }
    disputeRuns = runs;
  }

  // #840: the applied-transition ledger. Optional, because a block written
  // before the transition layer existed carries none. Every entry is an opaque
  // fixed-width digest and the entries are distinct: a duplicate would be a
  // ledger that records one delivery twice, which says nothing more than one
  // entry does and would let a corrupted record consume the bounded list.
  const appliedRaw = obj["appliedTransitions"];
  let appliedTransitions: string[] | undefined;
  if (appliedRaw !== undefined) {
    const items = requireArray(appliedRaw, `${path}.appliedTransitions`, MAX_APPLIED_TRANSITIONS_PER_LINEAGE, 0);
    const digests: string[] = [];
    for (const [i, item] of items.entries()) {
      const entryPath = `${path}.appliedTransitions[${i}]`;
      const digest = requireString(item, entryPath, APPLIED_TRANSITION_DIGEST_CHARS);
      if (!APPLIED_TRANSITION_DIGEST_RE.test(digest)) fail("invalid-state-record", `${entryPath}:not-a-digest`);
      if (digests.includes(digest)) fail("invalid-state-record", `${entryPath}:duplicate`);
      digests.push(digest);
    }
    appliedTransitions = digests;
  }

  const outcomeRaw = obj["outcome"];
  let outcome: PersistedLineage["outcome"];
  if (outcomeRaw !== undefined) {
    if (!isLineageState(outcomeRaw)) fail("unknown-enum", `${path}.outcome`);
    if (!isTerminalLineageState(outcomeRaw)) fail("unknown-enum", `${path}.outcome:not-terminal`);
    // §11: the outcome literal IS the lineage's terminal state.
    if (outcomeRaw !== state) fail("invalid-state-record", `${path}.outcome:state-mismatch`);
    outcome = outcomeRaw;
  } else if (isTerminalLineageState(state)) {
    fail("missing-field", `${path}.outcome`);
  }

  const boundary = normalizeAffectedBoundary(obj["affectedBoundary"], undefined, `${path}.affectedBoundary`);
  if (!boundary.ok) throw new RecordError(boundary.failure);

  const humanGate = requireBoolean(obj["humanGate"], `${path}.humanGate`);
  // Each field above is checked against itself and against the record's other
  // fields. Whether the COMBINATION is one the §7 table could have reached under
  // this session's limits — an `open` lineage whose current version is already
  // rebutted, a `binding` one with no arbitration pass behind it, a state only a
  // limit-disabled row reaches — is a property of the transition machine, and
  // that check belongs to #840 along with the counters it reads. This module
  // stops at the record.

  // §2.2: the predecessor of a successor lineage is itself a runner-minted id.
  // Admission WALKS this link to decide which lineage currently represents an
  // identity, so a value that could never name a lineage must not survive the
  // record — whether the link resolves is checked across the map below.
  const supersedesRaw = obj["supersedes"];
  const supersedes =
    supersedesRaw === undefined
      ? undefined
      : requireLineageId(supersedesRaw, `${path}.supersedes`, "invalid-state-record");
  if (supersedes === lineageId) fail("invalid-state-record", `${path}.supersedes:self`);

  const reopenRaw = obj["reopenRequested"];
  const reopenRequested = reopenRaw === undefined ? undefined : requireBoolean(reopenRaw, `${path}.reopenRequested`);
  // §6.4: `reopen_requested` is recorded on a TERMINAL lineage and routes to
  // human escalation only; on a live lineage it would be a second, undefined
  // path into the debate.
  if (reopenRequested === true && !isTerminalLineageState(state)) {
    fail("invalid-state-record", `${path}.reopenRequested:non-terminal`);
  }

  return {
    lineageId,
    state,
    version,
    counters,
    rebuttedVersions,
    ...(disputeRuns !== undefined ? { disputeRuns } : {}),
    ...(appliedTransitions !== undefined ? { appliedTransitions } : {}),
    humanGate,
    severity: requireEnum(obj["severity"], `${path}.severity`, FINDING_SEVERITIES),
    affectedBoundary: boundary.value,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(supersedes !== undefined ? { supersedes } : {}),
    ...(reopenRequested !== undefined ? { reopenRequested } : {}),
  };
}

/**
 * §2.2: check the `supersedes` links across the whole map.
 *
 * A record on its own can only say that its predecessor id is well formed;
 * whether the link is real is a property of the context. Candidate admission
 * walks these links forward to find the lineage that currently represents an
 * identity (`classifyCandidateAdmission`), so a dangling, shared, or
 * cyclic link decides that question against the wrong lineage — attaching a
 * candidate to a lineage that does not exist, or spending one predecessor's
 * successor path twice — instead of failing closed here.
 *
 * Structure only: which lineage STATE may be superseded, and what the
 * predecessor's counters must show, are transition rules and belong to #840.
 */
function validateSupersedesTopology(lineages: Record<string, PersistedLineage>, path: string): void {
  const superseded = new Set<string>();
  for (const [key, entry] of Object.entries(lineages)) {
    const predecessorId = entry.supersedes;
    if (predecessorId === undefined) continue;
    // Own-property lookup only: the map is null-prototype and its keys are
    // minted ids, so anything else names no lineage.
    if (!Object.prototype.hasOwnProperty.call(lineages, predecessorId)) {
      fail("invalid-state-record", `${path}[${key}].supersedes:unknown`);
    }
    // "Exactly one successor path" (§2.2): two successors of one predecessor is
    // that path spent twice, which is the bound the rule exists to hold.
    if (superseded.has(predecessorId)) {
      fail("invalid-state-record", `${path}[${key}].supersedes:duplicate-successor`);
    }
    superseded.add(predecessorId);
  }
  // Each lineage now has at most one predecessor and at most one successor, so
  // the links form chains — unless a corrupted record closes one into a cycle,
  // which has no oldest lineage and no current one.
  for (const key of Object.keys(lineages)) {
    const seen = new Set<string>([key]);
    let current = lineages[key]?.supersedes;
    while (current !== undefined) {
      if (seen.has(current)) fail("invalid-state-record", `${path}[${key}].supersedes:cycle`);
      seen.add(current);
      current = lineages[current]?.supersedes;
    }
  }
}

/**
 * Validate one persisted §10.1 lineage record.
 *
 * `limits` are the session's resolved §6.1 limits; the defaults are used when a
 * caller has none, since a session may only lower them.
 */
export function validatePersistedLineage(
  raw: unknown,
  key: string,
  path = "lineage",
  limits: ReviewDisputeLimits = REVIEW_DISPUTE_DEFAULT_LIMITS,
): ReviewDisputeResult<PersistedLineage> {
  return guard(() => validatePersistedLineageValue(raw, key, path, limits));
}

/**
 * Validate the whole `task.context.reviewDispute` block (§10.1).
 *
 * Bounded by construction: at most {@link MAX_LINEAGES_PER_TASK} lineages, each
 * a fixed-shape record of literals and capped counters, so the serialized block
 * cannot grow across review cycles.
 *
 * `limits` are the session's resolved §6.1 limits, against which the persisted
 * counters are checked; the defaults are used when a caller has none.
 */
export function validateReviewDisputeContext(
  raw: unknown,
  path = "reviewDispute",
  limits: ReviewDisputeLimits = REVIEW_DISPUTE_DEFAULT_LIMITS,
): ReviewDisputeResult<ReviewDisputeContext> {
  return guard((): ReviewDisputeContext => {
    const obj = requireObject(raw, path);
    requireClosedFields(obj, CONTEXT_FIELDS, path);
    if (obj["version"] !== 1) fail("invalid-state-record", `${path}.version`);
    const reviewStructure = requireEnum(obj["reviewStructure"], `${path}.reviewStructure`, REVIEW_STRUCTURE_MODES);
    const lineagesRaw = requireObject(obj["lineages"], `${path}.lineages`);
    const keys = Object.keys(lineagesRaw);
    if (keys.length > MAX_LINEAGES_PER_TASK) fail("too-many-items", `${path}.lineages:${keys.length}`);
    // A null-prototype map, keyed only by ids that could have been minted (§2.2).
    // Both halves matter: without the key check a parsed `__proto__` entry looks
    // like a valid lineage, and without the null prototype writing it back would
    // mutate the map's prototype instead of adding an own entry — leaving a
    // context whose lineage is invisible to serialization but still resolvable
    // by a direct lookup. A key that is not a minted id fails closed instead.
    const lineages = Object.create(null) as Record<string, PersistedLineage>;
    for (const key of keys) {
      requireLineageId(key, `${path}.lineages:key`, "invalid-state-record");
      lineages[key] = validatePersistedLineageValue(lineagesRaw[key], key, `${path}.lineages[${key}]`, limits);
    }
    // Only once every record is in the map can the links BETWEEN them be checked.
    validateSupersedesTopology(lineages, `${path}.lineages`);
    const pendingRaw = obj["pendingReReview"];
    const resolvedRaw = obj["resolvedWithoutChanges"];
    const pendingReReview = pendingRaw === undefined ? undefined : requireBoolean(pendingRaw, `${path}.pendingReReview`);
    const resolvedWithoutChanges =
      resolvedRaw === undefined ? undefined : requireBoolean(resolvedRaw, `${path}.resolvedWithoutChanges`);
    // The block's own three fields still have to agree with each other: a
    // `resolvedWithoutChanges` run has nothing left to re-review, and §13 keeps a
    // legacy or mixed review's prose blocking, so neither combination is a record
    // this protocol writes. Whether the flag is consistent with the LINEAGE MAP —
    // §7.1 rule 4's "every lineage terminal in a no-change-required outcome" —
    // reads the transition table's rule order across every lineage, and that check
    // belongs to #840.
    if (resolvedWithoutChanges === true) {
      if (pendingReReview === true) fail("invalid-state-record", `${path}.resolvedWithoutChanges:pending-re-review`);
      if (!reviewStructureAllowsZeroChange(reviewStructure)) {
        fail("invalid-state-record", `${path}.resolvedWithoutChanges:${reviewStructure}`);
      }
    }
    return {
      version: 1,
      reviewStructure,
      lineages,
      ...(pendingReReview === undefined ? {} : { pendingReReview }),
      ...(resolvedWithoutChanges === undefined ? {} : { resolvedWithoutChanges }),
    };
  });
}

// ---------------------------------------------------------------------------
// Bounded payload parsing
// ---------------------------------------------------------------------------

/**
 * Parse a serialized record, bounding it BEFORE `JSON.parse` sees it.
 *
 * Size is checked on the raw bytes rather than on the parsed value so an
 * oversized payload never gets allocated as an object graph first.
 */
export function parseBoundedJson(
  payload: string,
  maxBytes = REVIEW_DISPUTE_RECORD_MAX_BYTES,
  path = "payload",
): ReviewDisputeResult<unknown> {
  return guard(() => {
    const bytes = Buffer.byteLength(payload, "utf8");
    if (bytes > maxBytes) fail("payload-too-large", `${path}:${bytes}`);
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      fail("unparseable", path);
    }
  });
}

/** Parse and validate a serialized §10.1 context block under its own bound. */
export function parseReviewDisputeContext(
  payload: string,
  limits: ReviewDisputeLimits = REVIEW_DISPUTE_DEFAULT_LIMITS,
): ReviewDisputeResult<ReviewDisputeContext> {
  const parsed = parseBoundedJson(payload, REVIEW_DISPUTE_CONTEXT_MAX_BYTES, "reviewDispute");
  if (!parsed.ok) return parsed;
  return validateReviewDisputeContext(parsed.value, "reviewDispute", limits);
}

/** §10.3: the actor roles an audit event may carry. Exported for event emitters. */
export function isDisputeActorRole(value: unknown): boolean {
  return typeof value === "string" && (DISPUTE_ACTOR_ROLES as readonly string[]).includes(value);
}

/** Exported for callers that need the state vocabulary at runtime (e.g. admin CLI). */
export const LINEAGE_STATE_TOKENS: readonly string[] = LINEAGE_STATES;
