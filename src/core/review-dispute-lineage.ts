/**
 * Lineage identity, version rules, the deterministic material-revision check,
 * and stable serialization for the review-dispute protocol (issue #836,
 * docs/review-dispute-contract.md §2.2, §2.3, §5, §10.2).
 *
 * Everything here is a pure function of recorded values. That is the point of
 * §5: materiality is decided by the RUNNER, structurally, never by the reviewer
 * who authored the revision (`materialityClaim` is audit input only) and never
 * by a second AI call. The same applies to lineage identity — a duplicate is
 * detected by comparing recorded fields, so the same two findings always
 * classify the same way.
 */

import { createHash } from "crypto";
import {
  ABSOLUTE_MAX_VERSION,
  MAX_LINEAGES_PER_TASK,
  REVIEW_DISPUTE_CONTEXT_MAX_BYTES,
  REVIEW_DISPUTE_RECORD_MAX_BYTES,
  isTerminalLineageState,
} from "./review-dispute.js";
import type {
  CandidateFinding,
  EvidenceRef,
  FindingBody,
  FindingFieldName,
  LineageState,
  PersistedLineage,
  ReviewDisputeContext,
  ReviewFinding,
  RevisionRecord,
} from "./review-dispute.js";
import type { ReviewDisputeResult } from "./review-dispute-validation.js";

// ---------------------------------------------------------------------------
// Normalization primitives
// ---------------------------------------------------------------------------

/** §5: values are compared "normalized for whitespace". */
function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * The wording-insensitive form: lowercase, punctuation dropped, single spaces.
 *
 * This is the deterministic proxy for §5's "wording-only edits" and "restating
 * the same failureScenario in different words" — two texts with the same words
 * in a different order or with different punctuation are a rewording, and a
 * rewording is never material.
 *
 * Only punctuation and symbols are dropped: the protocol places no script
 * restriction on finding prose, so letters and digits are kept for EVERY
 * script. Stripping non-ASCII here would collapse a whole Japanese (or Greek, or
 * Cyrillic) finding to the empty string, which would give unrelated findings the
 * same identity hash and make every revision of one look like a rewording.
 * NFKC first, so compatibility forms of the same text normalize alike.
 *
 * In a script written without spaces the whole run is one token, so a pure
 * reordering reads as a changed claim rather than a rewording. That errs toward
 * §5's escalating outcome (arbitration or a successor version), never toward
 * silently ending a debate.
 */
function normalizeWording(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function wordMultiset(value: string): string {
  return normalizeWording(value).split(" ").filter(Boolean).sort().join(" ");
}

/**
 * §5: "line-number movement within the same `affectedBoundary`" is never
 * material, so a line or line-range suffix is not part of the boundary's
 * identity.
 *
 * The suffix belongs to the LOCATION token — the one §2.1/§12 normalization
 * validates as a repository-relative path — and a boundary may name a member
 * after it, either with `#` or after a space (`src/core/a.ts:10-20#run`). So the
 * range is cut from that token rather than from the end of the string: anchored
 * at the end it would survive a member selector, and the same boundary with
 * moved line numbers would then get a different identity, be classified as a
 * material change (§5), and mint a second lineage for one alleged defect (§2.2).
 */
export function boundaryIdentity(affectedBoundary: string): string {
  const normalized = normalizeWhitespace(affectedBoundary);
  const memberStart = normalized.search(/[\s#]/);
  const location = memberStart === -1 ? normalized : normalized.slice(0, memberStart);
  const members = memberStart === -1 ? "" : normalized.slice(memberStart);
  return location.replace(/:\d+(?:-\d+)?$/, "") + members;
}

// ---------------------------------------------------------------------------
// §2.2 Lineage identity and minting
// ---------------------------------------------------------------------------

/**
 * §2.2: the identity tuple of a finding — `violatedContract`,
 * `affectedBoundary`, `failureScenario`. A new structured finding that
 * structurally duplicates a live lineage attaches to it rather than opening a
 * second debate about the same alleged defect.
 *
 * The prose halves are compared wording-insensitively, but the boundary is only
 * whitespace- and line-suffix-normalized — its case is part of its identity. A
 * repository path or API surface may be case-distinct (`src/Foo.ts` and
 * `src/foo.ts` are two files on a case-sensitive checkout, `run` and `Run` two
 * members), so folding case here would attach a finding about one to the live
 * lineage of the other. It would also disagree with §5, where that same
 * boundary change is a material revision.
 */
export function findingIdentityKey(finding: Pick<FindingBody, "violatedContract" | "affectedBoundary" | "failureScenario">): string {
  return [
    normalizeWording(finding.violatedContract),
    boundaryIdentity(finding.affectedBoundary),
    normalizeWording(finding.failureScenario),
  ].join(" |#| ");
}

/** A short, stable, opaque digest of the identity tuple. */
export function findingIdentityHash(
  finding: Pick<FindingBody, "violatedContract" | "affectedBoundary" | "failureScenario">,
): string {
  return createHash("sha256").update(findingIdentityKey(finding), "utf8").digest("hex").slice(0, 12);
}

/** Lineage ids are runner-minted and filename-safe (§10.2 artifact names). */
export const LINEAGE_ID_RE = /^ln-[0-9a-f]{12}(?:-[1-9][0-9]{0,2})?$/;

export function isLineageId(value: unknown): value is string {
  return typeof value === "string" && LINEAGE_ID_RE.test(value);
}

/**
 * §2.2: the runner mints the lineage id; agents never do.
 *
 * The id is derived from the identity tuple, so it is stable across
 * reconsideration and versions — a `revise` produces a new VERSION, never a new
 * lineage. A suffix is appended only when the base id is already taken, which is
 * exactly the §2.2 `supersedes` case: a `resolved_fixed` lineage that never
 * consumed a rebuttal may be succeeded by a fresh version-1 lineage for the same
 * identity, and the two must be distinguishable in the audit record.
 */
export function mintLineageId(
  finding: Pick<FindingBody, "violatedContract" | "affectedBoundary" | "failureScenario">,
  takenIds: Iterable<string> = [],
): string {
  const base = `ln-${findingIdentityHash(finding)}`;
  const taken = new Set(takenIds);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix <= 999; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable in practice: MAX_LINEAGES_PER_TASK bounds the set long before
  // 999 successors of a single identity could exist.
  throw new Error(`unable to mint a lineage id for ${base}`);
}

/**
 * Recover the §2.2 identity hash a lineage id was minted from — the exact
 * inverse of {@link mintLineageId}, or `null` for a value that is not one.
 *
 * A persisted lineage (§10.1) records no finding prose, so its identity hash
 * cannot be recomputed from the record. It does not need to be: the id IS the
 * hash, plus the optional successor suffix. Deriving it back is what lets a later
 * review match a candidate against the bounded lineages it has on file, and
 * keeping the derivation beside its inverse is what keeps the two from drifting.
 */
export function lineageIdentityHash(lineageId: string): string | null {
  if (!isLineageId(lineageId)) return null;
  return lineageId.slice("ln-".length, "ln-".length + 12);
}

/** What the classifier needs to know about an existing lineage. */
export interface LineageIdentityEntry {
  lineageId: string;
  /** {@link findingIdentityHash} of the lineage's current finding version. */
  identityHash: string;
  state: LineageState;
  /**
   * Whether the lineage ever consumed a rebuttal. §7 (note on rows 1/5/23):
   * only a `resolved_fixed` lineage that never consumed one may be superseded;
   * otherwise the re-raise records `reopen_requested` and escalates.
   */
  rebuttalConsumed: boolean;
  /**
   * §2.2 `supersedes`: the predecessor this lineage succeeded, when it is itself
   * the single successor of a terminal one. Following these links is what makes
   * the successor rule single-use — see {@link currentLineageEntry}.
   */
  supersedes?: string;
}

export type CandidateAdmission =
  /** §2.2: the candidate duplicates a live lineage and attaches to it. */
  | { kind: "attach"; lineageId: string }
  /** A genuinely new alleged defect; the runner mints the id. */
  | { kind: "new"; lineageId: string }
  /** §2.2/§7: the single successor path out of a `resolved_fixed` lineage. */
  | { kind: "supersedes"; lineageId: string; predecessorLineageId: string }
  /** §6.4: dropped from blocking consideration and recorded in the audit log. */
  | { kind: "drop"; reason: "terminal-duplicate"; lineageId: string }
  /** An echoed lineage id that names no known lineage: agents never mint ids. */
  | { kind: "reject"; reason: "unknown-lineage-echo" };

/**
 * Decide what happens to a candidate finding at admission (§2.2, §6.4).
 *
 * Terminal lineages are immutable, so a duplicate of one is never re-admitted
 * into it. Exactly one successor path exists, and this function is where that
 * single exception is expressed.
 */
export function classifyCandidateAdmission(
  candidate: Pick<CandidateFinding, "violatedContract" | "affectedBoundary" | "failureScenario" | "lineageId">,
  known: readonly LineageIdentityEntry[],
): CandidateAdmission {
  const takenIds = known.map((entry) => entry.lineageId);

  if (candidate.lineageId !== undefined) {
    const echoed = known.find((entry) => entry.lineageId === candidate.lineageId);
    // §2.2: agents only ECHO lineage ids. An id naming nothing cannot attach.
    if (echoed === undefined) return { kind: "reject", reason: "unknown-lineage-echo" };
    return classifyAgainst([currentLineageEntry(echoed, known)], candidate, takenIds);
  }

  const hash = findingIdentityHash(candidate);
  const matches = known.filter((entry) => entry.identityHash === hash);
  if (matches.length === 0) return { kind: "new", lineageId: mintLineageId(candidate, takenIds) };

  // A matched lineage may already have been superseded; the debate that is still
  // live — or terminal with the successor slot already spent — is the one at the
  // end of the `supersedes` chain, not the entry the identity hash happened to
  // match first.
  const currents: LineageIdentityEntry[] = [];
  for (const match of matches) {
    const current = currentLineageEntry(match, known);
    if (!currents.some((entry) => entry.lineageId === current.lineageId)) currents.push(current);
  }
  return classifyAgainst(currents, candidate, takenIds);
}

/**
 * Walk `supersedes` links forward to the lineage that currently represents this
 * identity (§2.2).
 *
 * Without this, a terminal predecessor whose successor already consumed its
 * rebuttal would still look eligible for supersession, and the "exactly one
 * successor path" rule could be bypassed once per re-raise. The `seen` set makes
 * a corrupted cyclic record terminate rather than hang.
 */
function currentLineageEntry(
  entry: LineageIdentityEntry,
  known: readonly LineageIdentityEntry[],
): LineageIdentityEntry {
  const seen = new Set<string>([entry.lineageId]);
  let current = entry;
  for (;;) {
    const successor = known.find((other) => other.supersedes === current.lineageId && !seen.has(other.lineageId));
    if (successor === undefined) return current;
    seen.add(successor.lineageId);
    current = successor;
  }
}

function classifyAgainst(
  currents: readonly LineageIdentityEntry[],
  candidate: Pick<CandidateFinding, "violatedContract" | "affectedBoundary" | "failureScenario">,
  takenIds: readonly string[],
): CandidateAdmission {
  // A live current lineage always wins: §2.2 attaches a duplicate rather than
  // opening a second debate about the same alleged defect.
  const live = currents.find((entry) => !isTerminalLineageState(entry.state));
  if (live !== undefined) return { kind: "attach", lineageId: live.lineageId };

  // Supersession is available only when EVERY current terminal duplicate allows
  // it; one that does not is the §6.4 drop, so the single successor path cannot
  // be re-entered through a stale sibling.
  const blocked = currents.find((entry) => !(entry.state === "resolved_fixed" && !entry.rebuttalConsumed));
  if (blocked !== undefined) return { kind: "drop", reason: "terminal-duplicate", lineageId: blocked.lineageId };

  const predecessor = currents[currents.length - 1]!;
  return {
    kind: "supersedes",
    lineageId: mintLineageId(candidate, takenIds),
    predecessorLineageId: predecessor.lineageId,
  };
}

/** §10.1: the context block is bounded by a fixed lineage count. */
export function lineageBudgetExhausted(context: ReviewDisputeContext): boolean {
  return Object.keys(context.lineages).length >= MAX_LINEAGES_PER_TASK;
}

// ---------------------------------------------------------------------------
// §2.3 Version rules
// ---------------------------------------------------------------------------

/** §2.3: any reference to a version other than the lineage's current one is stale. */
export function isStaleVersion(lineage: Pick<PersistedLineage, "version">, referencedVersion: number): boolean {
  return referencedVersion !== lineage.version;
}

export type PredecessorProblem =
  | "predecessor-not-found"
  | "predecessor-not-current"
  | "predecessor-ambiguous"
  | "successor-not-incremental"
  | "successor-version-exists";

export interface PredecessorCheck {
  ok: boolean;
  problem?: PredecessorProblem;
  predecessor?: ReviewFinding;
}

/**
 * §2.3, §4.2: a revision names exactly ONE existing predecessor, which must be
 * the lineage's current version, and its successor sits at exactly
 * `predecessorVersion + 1`.
 *
 * The successor bound is the ABSOLUTE version ceiling rather than the session's
 * (possibly lowered) budget: under `MAX_VERSIONS_PER_LINEAGE = 1` the successor
 * is still required and still feeds the §5 check — it is just never persisted
 * (row 26).
 */
export function checkPredecessor(
  versions: readonly ReviewFinding[],
  revision: Pick<RevisionRecord, "predecessorVersion" | "successor">,
): PredecessorCheck {
  const matches = versions.filter((finding) => finding.version === revision.predecessorVersion);
  if (matches.length === 0) return { ok: false, problem: "predecessor-not-found" };
  if (matches.length > 1) return { ok: false, problem: "predecessor-ambiguous" };
  const predecessor = matches[0]!;
  const current = versions.reduce((max, finding) => Math.max(max, finding.version), 0);
  if (predecessor.version !== current) return { ok: false, problem: "predecessor-not-current", predecessor };
  if (revision.successor.version !== predecessor.version + 1 || revision.successor.version > ABSOLUTE_MAX_VERSION) {
    return { ok: false, problem: "successor-not-incremental", predecessor };
  }
  // §2.3: a version is immutable once recorded, so a successor may never land
  // on a version number that already exists.
  if (versions.some((finding) => finding.version === revision.successor.version)) {
    return { ok: false, problem: "successor-version-exists", predecessor };
  }
  return { ok: true, predecessor };
}

// ---------------------------------------------------------------------------
// §5 Material-revision rules (deterministic)
// ---------------------------------------------------------------------------

export const MATERIALITY_CLASSIFICATIONS = ["material", "non_material", "ambiguous"] as const;
export type MaterialityClassification = (typeof MATERIALITY_CLASSIFICATIONS)[number];

export const FIELD_CHANGE_CLASSIFICATIONS = [
  /** Values compare equal once normalized for whitespace: the entry is ignored. */
  "unchanged",
  /** Same words, different order or punctuation: §5 "wording-only edits". */
  "reworded",
  /** Changed, but not a §5 material field (severity, line movement, evidence). */
  "non_material",
  /** A listed field changed in content the runner can verify. */
  "material",
  /** Changed in phrasing the runner cannot classify; §5 routes it to arbitration. */
  "ambiguous",
] as const;
export type FieldChangeClassification = (typeof FIELD_CHANGE_CLASSIFICATIONS)[number];

export interface FieldChange {
  field: FindingFieldName;
  classification: FieldChangeClassification;
  /** Whether the reviewer listed the field in `changedFields` (§4.2). */
  declared: boolean;
}

export interface MaterialityResult {
  classification: MaterialityClassification;
  changes: FieldChange[];
  materialFields: FindingFieldName[];
  ambiguousFields: FindingFieldName[];
  /** §5: declared entries whose values compare equal are ignored. */
  ignoredDeclaredFields: FindingFieldName[];
  /**
   * Fields that actually differ but were not declared. The decision is made on
   * recorded VALUES, so an undeclared change cannot hide a material revision;
   * the discrepancy is reported for the audit record.
   */
  undeclaredChangedFields: FindingFieldName[];
  /** §10.3 audit event for this classification. */
  auditEvent: "dispute.revision.material" | "dispute.revision.non_material" | "dispute.revision.ambiguous";
}

export interface MaterialityOptions {
  /**
   * §5: `evidenceRefs` is material only "when the added executable evidence
   * invalidates a prior premise of the rebuttal (a new test name or file/line
   * whose resolution contradicts a dispute evidence reference)".
   *
   * Deciding that requires resolving the added references against the rebuttal,
   * which is I/O this module does not do. Without the predicate an evidence-only
   * change is NOT material — the conservative direction, since a non-material
   * revision still routes to arbitration (row 12) rather than ending the debate.
   */
  addedEvidenceInvalidatesRebuttal?: (addedRefs: EvidenceRef[]) => boolean;
}

function evidenceKey(ref: EvidenceRef): string {
  switch (ref.kind) {
    case "file":
      return `file:${ref.path}:${ref.startLine}-${ref.endLine}`;
    case "test":
      return `test:${normalizeWhitespace(ref.name)}`;
    case "doc_section":
      return `doc:${ref.path}#${normalizeWhitespace(ref.section)}`;
    case "issue_quote":
      return `quote:${normalizeWording(ref.quote)}`;
  }
}

/**
 * Classify one prose field.
 *
 * Three deterministic tiers, each answering to a sentence of §5:
 *
 *  1. equal after whitespace normalization → `unchanged` ("a `changedFields`
 *     entry whose values compare equal is ignored");
 *  2. same word multiset → `reworded` ("wording-only edits" and "restating the
 *     same failureScenario in different words" are never material);
 *  3. the successor contains the predecessor's whole normalized text →
 *     `ambiguous`. Pure addition is exactly the case the runner cannot decide:
 *     §5 lists "added examples" as never material, while an added precondition
 *     narrows scope and would be material. Undecidable goes to arbitration.
 *
 * Anything else is a changed claim. For `failureScenario` that is still
 * `ambiguous` — §5's own example of what the structural check cannot decide is
 * "a rewritten `failureScenario` that may or may not describe the same
 * scenario". For the other listed prose fields it is `material`.
 */
function classifyProseChange(before: string, after: string, ambiguousWhenRewritten: boolean): FieldChangeClassification {
  if (normalizeWhitespace(before) === normalizeWhitespace(after)) return "unchanged";
  if (wordMultiset(before) === wordMultiset(after)) return "reworded";
  const beforeWords = normalizeWording(before);
  const afterWords = normalizeWording(after);
  if (beforeWords !== "" && afterWords.includes(beforeWords)) return "ambiguous";
  return ambiguousWhenRewritten ? "ambiguous" : "material";
}

function classifyFieldChange(
  field: FindingFieldName,
  before: FindingBody,
  after: FindingBody,
  opts: MaterialityOptions,
): FieldChangeClassification {
  switch (field) {
    // §5 "Never material: ... severity-only changes".
    case "severity":
      return before.severity === after.severity ? "unchanged" : "non_material";
    case "affectedBoundary": {
      const beforeId = boundaryIdentity(before.affectedBoundary);
      const afterId = boundaryIdentity(after.affectedBoundary);
      if (beforeId === afterId) {
        // Same boundary; only a line range moved — §5 "line-number movement
        // within the same `affectedBoundary`".
        return normalizeWhitespace(before.affectedBoundary) === normalizeWhitespace(after.affectedBoundary)
          ? "unchanged"
          : "non_material";
      }
      // A different file/module/API surface is a verifiable structural change.
      return "material";
    }
    case "evidenceRefs": {
      const beforeKeys = new Set(before.evidenceRefs.map(evidenceKey));
      const afterKeys = new Set(after.evidenceRefs.map(evidenceKey));
      const added = after.evidenceRefs.filter((ref) => !beforeKeys.has(evidenceKey(ref)));
      const removed = before.evidenceRefs.filter((ref) => !afterKeys.has(evidenceKey(ref)));
      if (added.length === 0 && removed.length === 0) return "unchanged";
      if (added.length > 0 && opts.addedEvidenceInvalidatesRebuttal?.(added) === true) return "material";
      return "non_material";
    }
    case "failureScenario":
      return classifyProseChange(before.failureScenario, after.failureScenario, true);
    case "violatedContract":
      return classifyProseChange(before.violatedContract, after.violatedContract, false);
    case "preconditions":
      return classifyProseChange(before.preconditions, after.preconditions, false);
    case "requiredOutcome":
      return classifyProseChange(before.requiredOutcome, after.requiredOutcome, false);
  }
}

/**
 * §5: decide whether a revision is material, structurally.
 *
 * Every §2.1 field is compared, not only the declared ones: the decision is
 * made on recorded values (§5), so omitting a field from `changedFields` can
 * neither hide a material change nor manufacture one. `materialityClaim` is
 * never read here — the interested party does not grade its own revision
 * (§14.2).
 */
export function classifyRevisionMateriality(
  predecessor: FindingBody,
  revision: Pick<RevisionRecord, "changedFields" | "successor">,
  opts: MaterialityOptions = {},
): MaterialityResult {
  const declared = new Set<FindingFieldName>(revision.changedFields);
  const changes: FieldChange[] = [];
  const materialFields: FindingFieldName[] = [];
  const ambiguousFields: FindingFieldName[] = [];
  const ignoredDeclaredFields: FindingFieldName[] = [];
  const undeclaredChangedFields: FindingFieldName[] = [];

  const fields: FindingFieldName[] = [
    "severity",
    "violatedContract",
    "preconditions",
    "failureScenario",
    "affectedBoundary",
    "requiredOutcome",
    "evidenceRefs",
  ];
  for (const field of fields) {
    const classification = classifyFieldChange(field, predecessor, revision.successor, opts);
    const isDeclared = declared.has(field);
    changes.push({ field, classification, declared: isDeclared });
    if (classification === "unchanged") {
      if (isDeclared) ignoredDeclaredFields.push(field);
      continue;
    }
    if (!isDeclared) undeclaredChangedFields.push(field);
    if (classification === "material") materialFields.push(field);
    if (classification === "ambiguous") ambiguousFields.push(field);
  }

  const classification: MaterialityClassification =
    materialFields.length > 0 ? "material" : ambiguousFields.length > 0 ? "ambiguous" : "non_material";
  return {
    classification,
    changes,
    materialFields,
    ambiguousFields,
    ignoredDeclaredFields,
    undeclaredChangedFields,
    auditEvent:
      classification === "material"
        ? "dispute.revision.material"
        : classification === "ambiguous"
          ? "dispute.revision.ambiguous"
          : "dispute.revision.non_material",
  };
}

// ---------------------------------------------------------------------------
// §10.2 Stable serialization and artifact names
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys in sorted order, `undefined` members dropped.
 *
 * Two structurally equal records therefore serialize to byte-identical text,
 * which is what makes an artifact diff meaningful and a context write
 * idempotent (#844). Output is ordinary JSON, so `JSON.parse` round-trips it.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = stableValue(source[key]);
    }
    return out;
  }
  return value;
}

/** Serialize a record for a local artifact, bounded (§10.2). */
export function serializeRecord(
  value: unknown,
  maxBytes = REVIEW_DISPUTE_RECORD_MAX_BYTES,
): ReviewDisputeResult<string> {
  const json = stableStringify(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maxBytes) {
    return { ok: false, failure: { reason: "payload-too-large", detail: `record:${bytes}` } };
  }
  return { ok: true, value: json };
}

/** Serialize the §10.1 context block, bounded by its own (tighter) budget. */
export function serializeReviewDisputeContext(context: ReviewDisputeContext): ReviewDisputeResult<string> {
  return serializeRecord(context, REVIEW_DISPUTE_CONTEXT_MAX_BYTES);
}

export const REVIEW_FINDINGS_ARTIFACT = "review-findings.json";
export const FIX_DISPOSITIONS_ARTIFACT = "fix-dispositions.json";

/**
 * §10.2 per-lineage artifact names.
 *
 * The lineage id is validated rather than interpolated blindly: it is the only
 * variable part of a filesystem path this contract produces, and a runner-minted
 * id always matches {@link LINEAGE_ID_RE}, so a value that does not is a bug or
 * a smuggled path, never a name to write to.
 */
function lineageArtifactName(prefix: string, lineageId: string, extension = "json"): string {
  if (!isLineageId(lineageId)) throw new Error(`invalid lineage id for an artifact name: ${prefix}`);
  return `${prefix}-${lineageId}.${extension}`;
}

export function disputeArtifactName(lineageId: string): string {
  return lineageArtifactName("dispute", lineageId);
}

export function reconsiderationArtifactName(lineageId: string): string {
  return lineageArtifactName("reconsideration", lineageId);
}

/**
 * The RAW reviewer-reconsideration output of one lineage (issue #838).
 *
 * A sibling of {@link reconsiderationArtifactName}, deliberately distinct from
 * it: that file holds the VALIDATED §4.1 record, this one holds the agent's
 * unvalidated bytes exactly as they were produced. Keeping the two apart is what
 * lets §10.2 retain a debuggable transcript of a malformed run without ever
 * letting unvalidated prose be mistaken for an admitted record — and the `.txt`
 * extension states that the content is not parseable JSON by contract.
 */
export function reconsiderationRawArtifactName(lineageId: string): string {
  return lineageArtifactName("reconsideration-raw", lineageId, "txt");
}

/**
 * The reviewer-reconsideration run's STANDARD ERROR, when the agent wrote to
 * both streams (issue #838).
 *
 * A separate file rather than a section of the raw transcript: §10.2 promises
 * the raw artifact holds the agent's bytes exactly as produced, and merging two
 * streams behind a runner-authored banner would break that promise for both —
 * the reader could no longer tell an injected delimiter from one the agent
 * printed. Only a completely empty stdout leaves nothing to separate, and this
 * file is then not written at all: the raw artifact holds stderr, which is also
 * what was parsed. A stdout carrying only whitespace still carried bytes, so it
 * stays the raw artifact and stderr lands here even though stderr was parsed.
 */
export function reconsiderationStderrArtifactName(lineageId: string): string {
  return lineageArtifactName("reconsideration-stderr", lineageId, "txt");
}

/**
 * The reviewer-reconsideration run's RUNNER diagnostic, when the agent's
 * subprocess failed to run at all — a timeout, a buffer overflow, a missing
 * command (issue #838 review, P2).
 *
 * The counterpart of the two files above, and the reason they can keep their
 * promise: those hold the agent's bytes and nothing else, so bytes the agent
 * never wrote need a file that says so in its name. Without it a spawn-level
 * failure would either be silently dropped or — worse — persisted as though the
 * reviewer had printed it. Local-only and never a record, on the same terms as
 * every other §10.2 artifact.
 */
export function reconsiderationRunnerErrorArtifactName(lineageId: string): string {
  return lineageArtifactName("reconsideration-runner-error", lineageId, "txt");
}

export function arbitrationArtifactName(lineageId: string): string {
  return lineageArtifactName("arbitration", lineageId);
}

/**
 * The §8.2 BUNDLE manifest of one arbitration run (issue #846).
 *
 * A sibling of {@link arbitrationArtifactName} rather than a section of it,
 * because the two have different lifetimes: the verdict artifact exists only
 * when a verdict was admitted, while the manifest describes what the arbiter was
 * SHOWN and is written before it answers. A malformed arbitration — the case
 * where "what did it actually see?" matters most — would otherwise leave no
 * record of its bundle at all. The verdict artifact still embeds the manifest, so
 * an admitted record remains self-contained (§10.2).
 */
export function arbitrationBundleArtifactName(lineageId: string): string {
  return lineageArtifactName("arbitration-bundle", lineageId);
}

/**
 * The RAW arbiter output of one lineage (issue #846).
 *
 * The arbitration counterpart of {@link reconsiderationRawArtifactName}, on
 * exactly its terms: the agent's unvalidated bytes as produced, written before
 * the answer is parsed, never re-read by the protocol, and never published. The
 * `.txt` extension states that the content is not parseable JSON by contract.
 */
export function arbitrationRawArtifactName(lineageId: string): string {
  return lineageArtifactName("arbitration-raw", lineageId, "txt");
}

/** The arbitration run's STANDARD ERROR, when the agent wrote to both streams. */
export function arbitrationStderrArtifactName(lineageId: string): string {
  return lineageArtifactName("arbitration-stderr", lineageId, "txt");
}

/**
 * The arbitration run's RUNNER diagnostic, when the agent's subprocess failed to
 * run at all — a timeout, an output-buffer overflow, a missing command.
 *
 * It exists so the two transcripts above can keep their promise: bytes the agent
 * never wrote are never appended to them, because a runner diagnostic persisted
 * as arbiter output would read as a verdict nobody returned.
 */
export function arbitrationRunnerErrorArtifactName(lineageId: string): string {
  return lineageArtifactName("arbitration-runner-error", lineageId, "txt");
}

// ---------------------------------------------------------------------------
// §11 Public-comment projection
// ---------------------------------------------------------------------------

/**
 * The at-most content §11 allows in a public comment: lineage id, severity, the
 * admission-normalized `affectedBoundary`, the outcome literal, and counts.
 *
 * This is a data projection, not a renderer — publication and operator controls
 * are issue #848. It exists here so the schema can be shown to support bounded
 * publication: every field is a literal or a number the runner owns, and no
 * prose, evidence content, or local path can reach it, because a lineage record
 * holds none.
 */
export interface PublicLineageOutcome {
  lineageId: string;
  severity: PersistedLineage["severity"];
  affectedBoundary: string;
  outcome: NonNullable<PersistedLineage["outcome"]>;
  versions: number;
  arbitrationPasses: number;
}

/**
 * Project a terminal lineage into its publishable outcome, or `null` when the
 * lineage is not publishable.
 *
 * §11: a comment is posted only on lineage resolution or human escalation.
 * `binding` is not a resolution and never receives its own comment — it is
 * published later, when rows 23–24 take it to a terminal state.
 */
export function publicLineageOutcome(lineage: PersistedLineage): PublicLineageOutcome | null {
  if (!isTerminalLineageState(lineage.state) || lineage.outcome === undefined) return null;
  return {
    lineageId: lineage.lineageId,
    severity: lineage.severity,
    affectedBoundary: lineage.affectedBoundary,
    outcome: lineage.outcome,
    versions: lineage.version,
    arbitrationPasses: lineage.counters.arbitrationPasses,
  };
}
