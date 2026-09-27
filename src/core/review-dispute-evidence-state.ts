/**
 * Issue #956: the PERSISTED state of §7.1's one bounded, dual-party evidence
 * round (docs/review-dispute-contract.md §3.3, §7.1, §9, §10.1–§10.3, §12).
 *
 * #951/#955 put a round record in `task.context` so that two evidence-collection
 * runs — one implementer-side, one reviewer-side — could accumulate into the one
 * row 22 the RUNNER applies, and so that a re-delivered claim replays a party's
 * answer instead of collecting it twice. That record held what the dispatcher
 * needed at the time: a run id, an attempt, and a count of admitted attachments
 * per lineage.
 *
 * What it did not hold is the rest of the lifecycle. A record that only ever
 * appears once a party has FINISHED cannot say that a party is mid-run, that a
 * run ended in a way another attempt may retry, or WHAT the finished run
 * admitted — and the last of those is the one the arbitration bundle (#957 and
 * the runtime issues after it) actually needs: §7.1's evidence turn exists to
 * put the admitted §3.3 references in front of the arbiter on the re-presented
 * case, and a count cannot be re-presented.
 *
 * So this module is the one home of that state, and #955's record is not
 * replaced by it — it is the record this module reads, writes, and extends:
 *
 *  - **one source of truth.** `review-dispute-dispatch.ts` no longer declares the
 *    shape; it imports it from here and re-exports the names #955 published, so
 *    every existing caller and every existing test keeps its import and its
 *    semantics. Dispatch completion, completed-party replay, and row-22
 *    idempotency stay exactly where #955 put them.
 *  - **absence is the compatible default.** A party with no record has not
 *    started; a record with no `status` is a COMPLETED party (the only kind #955
 *    could write); a round with no `round` number is round 1. A block written
 *    before this module existed therefore migrates by being read, and a record
 *    this module writes for a count-only completion is byte-identical to the one
 *    #955 wrote — which is what keeps a task mid-round across an upgrade.
 *  - **the count stays derivable.** `attachments` remains the admitted count and
 *    remains authoritative; `references` is the optional detail beside it, and
 *    when both are present they must agree. Nothing has to open an artifact to
 *    learn what row 22 will record.
 *  - **nothing unbounded, nothing unsafe.** Every field is a literal, a counter,
 *    a bounded id, or a §3.3 reference in its persisted form; the run's bytes
 *    travel as §10.2 artifacts and are named here by base name and digest only.
 *    No absolute path, no prompt, no agent output, no excerpt. An `issue_quote`
 *    reference is persisted as a digest and a length rather than its span,
 *    because §10.1 keeps prose out of the context column and §10.3 keeps
 *    evidence content out of events — the quote itself is in the artifact, and
 *    the digest is what makes the two comparable.
 *
 * Purity: no store, no filesystem, no GitHub, no agent, no clock. Every function
 * here is a value in, a value out; nothing in this module dispatches a run or
 * invokes anything.
 */

import { createHash } from "crypto";
import type { EvidenceRef } from "./review-dispute.js";
import {
  MAX_DISPUTE_SUB_TURN_ATTEMPT,
  MAX_EVIDENCE_QUOTE_CHARS,
  MAX_EVIDENCE_REFS_PER_RECORD,
  MAX_LINEAGES_PER_TASK,
  MAX_RUN_ID_CHARS,
  REVIEW_DISPUTE_LIMIT_SPECS,
  REVIEW_DISPUTE_RECORD_MAX_BYTES,
} from "./review-dispute.js";
import type { ReviewDisputeFailure, ReviewDisputeResult } from "./review-dispute-validation.js";
import { validateEvidenceRef } from "./review-dispute-validation.js";
import { isLineageId, serializeRecord } from "./review-dispute-lineage.js";
import type { EvidenceCollectionParty } from "./review-dispute-turn.js";
import { EVIDENCE_COLLECTION_PARTIES } from "./review-dispute-turn.js";
import type { DisputeArtifact } from "./review-dispute-persistence.js";

// ---------------------------------------------------------------------------
// Where the record lives
// ---------------------------------------------------------------------------

/**
 * The task-context key the in-flight evidence round's per-party record lives
 * under (issue #955).
 *
 * A record rather than a §10.1 field on purpose: the block is the debate's
 * durable state and §10.1 has no place for "one of two runs has answered". What
 * this key holds is bookkeeping BETWEEN the two evidence-collection runs, it is
 * spent the moment row 22 closes the round, and it is written by the same
 * completion transaction as everything else the sub-turn produced — so it can
 * never be on file describing a round the block does not have.
 */
export const REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY = "reviewDisputeEvidenceRound";

// ---------------------------------------------------------------------------
// Lifecycle vocabulary
// ---------------------------------------------------------------------------

/**
 * Where one party's collection stands for one lineage.
 *
 * Four states and no history: §7.1 authorizes ONE bounded round per lineage, so
 * the record answers "where is this party now" and never "what did every
 * previous attempt do". A retry replaces its predecessor's record rather than
 * appending to it, which is what keeps the round bounded by the §6.1 limits
 * instead of by how many times a run happened to be redelivered.
 *
 *  - `not_started` — no run has been recorded. Represented by the ABSENCE of a
 *    party entry, which is also the state every pre-#956 block is in for a party
 *    that has not answered, so nothing had to be written for this to be readable.
 *  - `running` — a run was dispatched under a known run id and attempt and has
 *    not delivered. It is not an answer: the round is not complete, and the party
 *    is still the one a dispatcher must run.
 *  - `recoverable` — a run ended without a delivered result in a way a later
 *    attempt may retry (§12's park, a delay, a timeout). Nothing was charged: no
 *    §6.1 counter moves for a party run, so the record exists to say WHICH
 *    attempt stopped, not to spend anything.
 *  - `completed` — the party's run delivered, and what it admitted is on the
 *    record. Zero admitted attachments is a completed party (§7.1: "the runner
 *    records the admitted attachments (possibly none)"), never a missing one.
 */
export const DISPUTE_EVIDENCE_PARTY_STATES = ["not_started", "running", "recoverable", "completed"] as const;
export type DisputeEvidencePartyState = (typeof DISPUTE_EVIDENCE_PARTY_STATES)[number];

/**
 * The subset of {@link DISPUTE_EVIDENCE_PARTY_STATES} a persisted run record may
 * carry. `not_started` is deliberately absent: it is the absence of the record.
 */
export const DISPUTE_EVIDENCE_RUN_STATUSES = ["running", "recoverable", "completed"] as const;
export type DisputeEvidenceRunStatus = (typeof DISPUTE_EVIDENCE_RUN_STATUSES)[number];

/**
 * What a record with no `status` means.
 *
 * `completed`, because a #955 record was only ever written for a party whose run
 * had delivered its counts. Reading an older record as anything else would make
 * a finished party look unfinished and re-run it — the one thing #955's replay
 * exists to prevent — so the default is not a convenience, it is the migration.
 */
export const DEFAULT_EVIDENCE_RUN_STATUS: DisputeEvidenceRunStatus = "completed";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * The most §3.3 attachments one party may admit for one lineage.
 *
 * The same ceiling §2.1/§3.2 records carry (`MAX_EVIDENCE_REFS_PER_RECORD`),
 * because an evidence-collection run produces exactly what those records carry —
 * evidence references — and a bound that differed would let the round smuggle a
 * bigger evidence set into the arbiter's bundle than a dispute itself may.
 */
export const MAX_EVIDENCE_ATTACHMENTS_PER_PARTY = MAX_EVIDENCE_REFS_PER_RECORD;

/**
 * How many unresolvable references one party's run may report having dropped.
 *
 * §7.1: "an unresolvable reference is dropped and logged, never a run failure".
 * The COUNT is the log entry that survives into task context; bounding it by the
 * same ceiling keeps a run that returned a thousand unresolvable references from
 * writing a thousand into the context column.
 */
export const MAX_EVIDENCE_DROPPED_PER_PARTY = MAX_EVIDENCE_REFS_PER_RECORD;

/**
 * How many §10.2 artifacts one party's run may name.
 *
 * Exactly the four names {@link evidenceArtifactNames} mints for a (party,
 * lineage) pair: the record, the raw transcript, the stderr transcript, and the
 * runner's own diagnostic. A run cannot produce a fifth, so a record naming one
 * is describing a file this protocol did not write.
 */
export const MAX_EVIDENCE_ARTIFACT_REFS_PER_PARTY = 4;

/**
 * The highest evidence-round number a record may carry.
 *
 * §6.1's `MAX_EVIDENCE_ROUNDS_PER_LINEAGE` is 1 and session config may only
 * LOWER a limit, never raise it — so one is also the absolute ceiling, exactly
 * as `ABSOLUTE_MAX_VERSION` is derived for versions. The number is still carried
 * through the keys below because a round-blind key could not distinguish a
 * second round from a redelivery of the first if the limit were ever raised.
 */
export const ABSOLUTE_MAX_EVIDENCE_ROUNDS = REVIEW_DISPUTE_LIMIT_SPECS.maxEvidenceRoundsPerLineage.default;

/** The round a record with no `round` number describes: §7.1's single round. */
export const DEFAULT_EVIDENCE_ROUND = 1;

/** A §10.2 artifact base name is bounded, like every other persisted string. */
export const MAX_EVIDENCE_ARTIFACT_NAME_CHARS = 160;

/**
 * A `recoverable` record's reason token.
 *
 * A closed-vocabulary-shaped token (the dispatcher's own failure kind, most
 * plausibly) rather than prose: it is persisted, it reaches the operator
 * projection, and §10.3 admits literals only. The pattern is the enforcement —
 * a value with a space, a slash, or a colon in it is a sentence, a path, or a
 * detail locator, and none of those may be written here.
 */
export const MAX_EVIDENCE_RUN_REASON_CHARS = 48;
export const EVIDENCE_RUN_REASON_RE = /^[a-z][a-z0-9_]*$/;

/** Twelve hex characters: the short-digest form §2.2 and #840 already mint. */
export const EVIDENCE_DIGEST_RE = /^[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// §10.2 artifact names and safe references
// ---------------------------------------------------------------------------

/**
 * The §10.2 artifacts one party's evidence-collection run may write.
 *
 * Party-scoped, unlike every other per-lineage artifact name in
 * `review-dispute-lineage.ts`, because §7.1 dispatches TWO runs for one lineage
 * and the two must not overwrite each other's record or transcript. The
 * `-raw` / `-stderr` / `-runner-error` trio carries exactly the meaning its
 * `reconsideration-` and `arbitration-` counterparts do: the agent's bytes as
 * produced, one file per stream, and a separately named file for bytes the
 * RUNNER wrote about a subprocess that never ran.
 */
export const EVIDENCE_ARTIFACT_KINDS = ["record", "raw", "stderr", "runner_error"] as const;
export type EvidenceArtifactKind = (typeof EVIDENCE_ARTIFACT_KINDS)[number];

const EVIDENCE_ARTIFACT_SPECS: Readonly<Record<EvidenceArtifactKind, { prefix: string; extension: string }>> = {
  record: { prefix: "evidence", extension: "json" },
  raw: { prefix: "evidence-raw", extension: "txt" },
  stderr: { prefix: "evidence-stderr", extension: "txt" },
  runner_error: { prefix: "evidence-runner-error", extension: "txt" },
};

/**
 * Mint one artifact name, or refuse to.
 *
 * The lineage id and the party are the only variable parts of a filesystem name
 * this contract produces, so both are checked rather than interpolated: a
 * runner-minted lineage id always matches `LINEAGE_ID_RE` and a party is always
 * one of §7.1's two, so a value that is neither is a bug or a smuggled path —
 * never a name to write to. This throws for the same reason
 * `lineageArtifactName` does: a caller that reached it with an unchecked value
 * has a fault its own guards should have caught, and returning a "safe" fallback
 * name would write the run's record to a file nothing goes looking for.
 */
export function evidenceArtifactName(
  party: EvidenceCollectionParty,
  lineageId: string,
  kind: EvidenceArtifactKind = "record",
): string {
  if (!EVIDENCE_COLLECTION_PARTIES.includes(party)) {
    throw new Error(`invalid evidence party for an artifact name: ${kind}`);
  }
  if (!isLineageId(lineageId)) throw new Error(`invalid lineage id for an artifact name: ${kind}`);
  const spec = Object.prototype.hasOwnProperty.call(EVIDENCE_ARTIFACT_SPECS, kind)
    ? EVIDENCE_ARTIFACT_SPECS[kind]
    : undefined;
  if (spec === undefined) throw new Error(`unknown evidence artifact kind: ${String(kind)}`);
  return `${spec.prefix}-${party}-${lineageId}.${spec.extension}`;
}

/** Every name one party's run for one lineage may write, in a stable order. */
export function evidenceArtifactNames(party: EvidenceCollectionParty, lineageId: string): readonly string[] {
  return EVIDENCE_ARTIFACT_KINDS.map((kind) => evidenceArtifactName(party, lineageId, kind));
}

/** Is this one of the four names this protocol mints for that party and lineage? */
export function isEvidenceArtifactName(
  name: unknown,
  party: EvidenceCollectionParty,
  lineageId: string,
): boolean {
  if (typeof name !== "string") return false;
  if (!EVIDENCE_COLLECTION_PARTIES.includes(party) || !isLineageId(lineageId)) return false;
  return evidenceArtifactNames(party, lineageId).includes(name);
}

/**
 * A safe persisted reference to one §10.2 artifact.
 *
 * A base NAME, a content digest, and a byte length — never a directory, never an
 * absolute path, never the bytes. The artifact directory belongs to the run that
 * wrote the file and is local by contract (§10.2), so a persisted reference that
 * carried it would put a local path in the SQLite context column and in every
 * event and summary projected from it. The digest is what makes the reference
 * useful anyway: a later consumer can tell the file it opens IS the one this run
 * wrote, without the record ever having held its content.
 */
export interface DisputeEvidenceArtifactRef {
  /** Base name only, from {@link evidenceArtifactName}. */
  name: string;
  /** Twelve hex characters of sha256 over the exact bytes written. */
  digest: string;
  /** The byte length of those bytes, so a truncated file is recognizable. */
  bytes: number;
}

function shortDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

/** The safe reference to an artifact whose bytes the caller is about to write. */
export function evidenceArtifactRef(artifact: DisputeArtifact): DisputeEvidenceArtifactRef {
  return {
    name: artifact.name,
    digest: shortDigest(artifact.content),
    bytes: Buffer.byteLength(artifact.content, "utf8"),
  };
}

/**
 * A base name that could have been minted for an evidence run, checked without
 * knowing which lineage it belongs to.
 *
 * Deliberately weaker than {@link isEvidenceArtifactName} and used where the
 * lineage is not in hand (reading a record back): what it enforces is the part
 * that matters for safety — a bounded BASE name with no separator, no traversal,
 * no drive prefix and no NUL, carrying this protocol's own prefix — rather than
 * the exact identity, which the writer already checked.
 */
export function isEvidenceArtifactBaseName(name: unknown): name is string {
  if (typeof name !== "string" || name === "" || name.length > MAX_EVIDENCE_ARTIFACT_NAME_CHARS) return false;
  if (name.includes("/") || name.includes("\\") || name.includes(":") || name.includes("\0")) return false;
  if (name === "." || name === "..") return false;
  return name.startsWith("evidence-");
}

// ---------------------------------------------------------------------------
// §3.3 references, in their persisted form
// ---------------------------------------------------------------------------

/**
 * One admitted §3.3 reference, as task context may hold it.
 *
 * Three of the four kinds are the reference itself: a repo-relative path with a
 * line range, a test name, a `docs/` section — all bounded, all already
 * repository-relative by §3.3's own validation, none of them content.
 *
 * The fourth is not. An `issue_quote` IS a span of prose, and §10.1 puts prose
 * in artifacts rather than in the context column while §10.3 keeps evidence
 * content out of events entirely. So the quote is persisted as its digest and
 * its length: the reference stays identifiable (two runs quoting the same span
 * produce the same digest, which is what a replay comparison needs), the arbiter
 * still receives the span itself from the §10.2 artifact, and no excerpt reaches
 * a context column, an event, or a comment.
 */
export type PersistedEvidenceRef =
  | { kind: "file"; path: string; startLine: number; endLine: number }
  | { kind: "test"; name: string }
  | { kind: "doc_section"; path: string; section: string }
  | { kind: "issue_quote"; quoteDigest: string; quoteChars: number };

/** Project an admitted §3.3 reference into the form context may hold. */
export function toPersistedEvidenceRef(ref: EvidenceRef): PersistedEvidenceRef {
  switch (ref.kind) {
    case "file":
      return { kind: "file", path: ref.path, startLine: ref.startLine, endLine: ref.endLine };
    case "test":
      return { kind: "test", name: ref.name };
    case "doc_section":
      return { kind: "doc_section", path: ref.path, section: ref.section };
    case "issue_quote":
      return { kind: "issue_quote", quoteDigest: shortDigest(ref.quote), quoteChars: ref.quote.length };
  }
}

/**
 * A content-free identity for one persisted reference.
 *
 * Two references that name the same evidence hash to the same value, which is
 * how a redelivered run's references can be compared with the ones already on
 * file without either being re-read or re-published.
 */
export function persistedEvidenceRefDigest(ref: PersistedEvidenceRef): string {
  const parts: readonly string[] =
    ref.kind === "file"
      ? [ref.kind, ref.path, String(ref.startLine), String(ref.endLine)]
      : ref.kind === "test"
        ? [ref.kind, ref.name]
        : ref.kind === "doc_section"
          ? [ref.kind, ref.path, ref.section]
          : [ref.kind, ref.quoteDigest, String(ref.quoteChars)];
  // The delimiter is the one byte no reference field may contain, written as an
  // escape so this source file stays text rather than binary to git.
  return shortDigest(parts.join("\0"));
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * One party's evidence-collection run, for one lineage.
 *
 * The three required fields are #955's and are unchanged. Everything added by
 * #956 is optional AND defaults to what a #955 record meant, so the two forms
 * are the same record read at two moments rather than two records.
 */
export interface DisputeEvidencePartyRun {
  /** The party run's derived run id (`DisputeSubTurnIdentity.runId`). */
  runId: string;
  attempt: number;
  /**
   * How many §3.3 attachments that run admitted for this lineage, AFTER
   * resolution dropped the unresolvable ones. Zero is a valid round (§7.1: "the
   * runner records the admitted attachments (possibly none)").
   *
   * Authoritative and always present: row 22 records this number, and a reader
   * that wants it must never have to open an artifact or count a list that an
   * older block does not carry.
   */
  attachments: number;
  /**
   * Where the run stands. Absent means {@link DEFAULT_EVIDENCE_RUN_STATUS} —
   * `completed` — which is the only thing a #955 record could have been.
   */
  status?: DisputeEvidenceRunStatus;
  /**
   * The admitted references themselves, when the run recorded them.
   *
   * Absent is "not recorded" (a #955 record, or a run that kept its detail in
   * the artifact alone); an EMPTY array is a completed run that admitted none,
   * which §7.1 explicitly allows and which must stay distinguishable from the
   * first. When present the list must have exactly `attachments` entries — the
   * count is what row 22 records, and a list that disagreed with it would make
   * the record say two different things about one run.
   */
  references?: PersistedEvidenceRef[];
  /** §7.1: how many returned references failed §3.3 resolution and were dropped. */
  dropped?: number;
  /** Safe references to the §10.2 files this run produced. Never their bytes. */
  artifacts?: DisputeEvidenceArtifactRef[];
  /**
   * Why a `recoverable` run stopped, as one bounded token. Meaningless — and
   * refused — on any other status: a completed run's outcome is its attachments.
   */
  reason?: string;
}

/** One lineage's in-flight round. */
export interface DisputeEvidenceLineageRound {
  /**
   * The lineage version the round is being collected against. A version that has
   * moved since means the finding was revised under the round, and the party
   * records collected against the old one no longer describe it — they are
   * dropped and the round restarts, which costs nothing: party runs consume no
   * §6.1 counter.
   */
  version: number;
  /**
   * Which §6.1 evidence round this is, 1-based. Absent means
   * {@link DEFAULT_EVIDENCE_ROUND}, the only round §6.1's default limit allows —
   * and the only thing a #955 record could have described.
   */
  round?: number;
  parties: Partial<Record<EvidenceCollectionParty, DisputeEvidencePartyRun>>;
  /**
   * The derived run id row 22 was applied under, once the round closed.
   *
   * Present only after the round is spent. It is what keeps a redelivery of the
   * closing run converging (same run id → the same synthesized row, which #840's
   * ledger recognizes) while a LATER round for the same lineage starts from an
   * empty record rather than closing itself on the previous round's parties.
   */
  recordedRunId?: string;
}

export interface DisputeEvidenceRoundState {
  /** Keyed by lineage id. Entries for lineages outside a turn are left alone. */
  lineages: Record<string, DisputeEvidenceLineageRound>;
}

export type DisputeEvidenceRoundStateResult =
  | { ok: true; value: DisputeEvidenceRoundState }
  | { ok: false; failure: ReviewDisputeFailure };

/** What a write to the record produced, or why the record refused it. */
export type DisputeEvidenceRoundWriteResult = DisputeEvidenceRoundStateResult;

export function emptyEvidenceRound(): DisputeEvidenceRoundState {
  // Null-prototype for the same reason #840's `copyLineages` uses one: lineage
  // ids are runner-minted, but on a plain object a prototype key would set the
  // prototype instead of adding an entry.
  return { lineages: Object.create(null) as Record<string, DisputeEvidenceLineageRound> };
}

// ---------------------------------------------------------------------------
// Deterministic keys
// ---------------------------------------------------------------------------

/**
 * One evidence round's stable identity, without a party (issue #963).
 *
 * Three coordinates and deliberately no more: the lineage names the finding
 * under debate, the version names the revision of it the round is collected
 * against (§2.2 — a material revision mints a successor version, so a revised
 * finding is a DIFFERENT identity by construction), and the round number names
 * which §7 row-16 arbitration request opened it (the Nth `insufficient_evidence`
 * verdict opens the Nth round, and §6.1's default budget allows exactly one).
 * The task is the implicit fourth coordinate: this record lives in the task's
 * own context column, so two tasks can never share a round.
 *
 * Nothing volatile is in it — no claim id, no attempt, no timestamp — which is
 * what makes it STABLE: a restart, a transient retry, and a lost claim all
 * re-derive the same key, and a party recorded under it is recognized as already
 * answered instead of being run again.
 */
export interface EvidenceRoundCoordinates {
  lineageId: string;
  /** The finding version the round is collected against. */
  version: number;
  /** 1-based §6.1 round; defaults to {@link DEFAULT_EVIDENCE_ROUND}. */
  round?: number;
}

/**
 * The deterministic key of one evidence round: `<lineageId>@<version>/e<round>`.
 *
 * The party-free PREFIX of {@link evidencePartyRunKey}, and derived by it, so
 * the round a party run belongs to and the round's own identity cannot drift
 * apart. A key, not an identifier to persist: the record stores the version and
 * the round number, and this is what a consumer builds from them.
 */
export function evidenceRoundKey(coordinates: EvidenceRoundCoordinates): string {
  return `${coordinates.lineageId}@${coordinates.version}/e${coordinates.round ?? DEFAULT_EVIDENCE_ROUND}`;
}

/** The content-free digest of that key, in #840's own twelve-hex form. */
export function evidenceRoundDigest(coordinates: EvidenceRoundCoordinates): string {
  return shortDigest(evidenceRoundKey(coordinates));
}

/**
 * One party run's coordinates: everything that distinguishes it from every other
 * run this protocol may dispatch for the same debate.
 */
export interface EvidencePartyRunCoordinates {
  lineageId: string;
  /** The finding version the round is collected against. */
  version: number;
  party: EvidenceCollectionParty;
  attempt: number;
  /** The sub-turn's derived run id, not the claim's. */
  runId: string;
  /** 1-based; defaults to {@link DEFAULT_EVIDENCE_ROUND}. */
  round?: number;
}

/**
 * The deterministic key of one party's run.
 *
 * `<lineageId>@<version>/e<round>:<party>.<attempt>#<runId>` — #840's transition
 * key with the three coordinates a party run adds. Every part is derived, so a
 * redelivered claim re-derives the same key byte for byte; and no two of §7.1's
 * runs can share one, which is the property that keeps the second party's run
 * from being read as a redelivery of the first.
 *
 * A key, not an identifier to persist: what the record stores is the run id and
 * the attempt, and this is what a consumer builds from them when it needs one
 * string — a manifest entry, a log line, the input to {@link evidencePartyRunDigest}.
 */
export function evidencePartyRunKey(coordinates: EvidencePartyRunCoordinates): string {
  const { lineageId, version, party, attempt, runId } = coordinates;
  const round = coordinates.round ?? DEFAULT_EVIDENCE_ROUND;
  return `${evidenceRoundKey({ lineageId, version, round })}:${party}.${attempt}#${runId}`;
}

/** The content-free digest of that key, in #840's own twelve-hex form. */
export function evidencePartyRunDigest(coordinates: EvidencePartyRunCoordinates): string {
  return shortDigest(evidencePartyRunKey(coordinates));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

class EvidenceRecordError extends Error {
  constructor(readonly failure: ReviewDisputeFailure) {
    super(failure.reason);
  }
}

function refuse(reason: ReviewDisputeFailure["reason"], detail: string): never {
  throw new EvidenceRecordError({ reason, detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, max: number, min = 0): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function requireInteger(value: unknown, at: string, max: number, min = 0): number {
  const parsed = boundedInteger(value, max, min);
  if (parsed === null) refuse("invalid-type", at);
  return parsed;
}

function requireRunId(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim() === "") refuse("invalid-type", at);
  if (value.length > MAX_RUN_ID_CHARS) refuse("field-too-long", `${at}:${value.length}`);
  return value;
}

function parsePersistedEvidenceRefValue(raw: unknown, at: string): PersistedEvidenceRef {
  if (!isRecord(raw)) refuse("invalid-type", at);
  if (raw.kind === "issue_quote") {
    // The one kind whose persisted form is NOT the reference: a digest and a
    // length stand in for the span, so it is validated here rather than by the
    // §3.3 shape validator, which would demand the quote itself.
    const digest = raw.quoteDigest;
    if (typeof digest !== "string" || !EVIDENCE_DIGEST_RE.test(digest)) refuse("invalid-evidence-ref", `${at}.quoteDigest`);
    const chars = boundedInteger(raw.quoteChars, MAX_EVIDENCE_QUOTE_CHARS, 1);
    if (chars === null) refuse("invalid-evidence-ref", `${at}.quoteChars`);
    if (raw.quote !== undefined) {
      // A record carrying the span itself was written by something that did not
      // project it. Refusing is the fail-closed direction: silently dropping the
      // field would admit a block whose OTHER fields may carry content too.
      refuse("unknown-field", `${at}.quote`);
    }
    return { kind: "issue_quote", quoteDigest: digest, quoteChars: chars };
  }
  // Every other kind IS its persisted form, so §3.3's own shape validator is the
  // check — one implementation of "is this a reference", never a second one that
  // could drift from it.
  const validated = validateEvidenceRef(raw, at);
  if (!validated.ok) throw new EvidenceRecordError(validated.failure);
  return toPersistedEvidenceRef(validated.value);
}

function parseArtifactRef(raw: unknown, at: string): DisputeEvidenceArtifactRef {
  if (!isRecord(raw)) refuse("invalid-type", at);
  const name = raw.name;
  if (!isEvidenceArtifactBaseName(name)) refuse("invalid-type", `${at}.name`);
  const digest = raw.digest;
  if (typeof digest !== "string" || !EVIDENCE_DIGEST_RE.test(digest)) refuse("invalid-type", `${at}.digest`);
  const bytes = requireInteger(raw.bytes, `${at}.bytes`, Number.MAX_SAFE_INTEGER);
  return { name, digest, bytes };
}

function parsePartyRun(raw: unknown, at: string): DisputeEvidencePartyRun {
  if (!isRecord(raw)) refuse("invalid-type", at);
  const runId = requireRunId(raw.runId, `${at}.runId`);
  const attempt = requireInteger(raw.attempt, `${at}.attempt`, MAX_DISPUTE_SUB_TURN_ATTEMPT);

  let status: DisputeEvidenceRunStatus | undefined;
  const rawStatus = raw.status;
  if (rawStatus !== undefined) {
    const known: readonly string[] = DISPUTE_EVIDENCE_RUN_STATUSES;
    if (typeof rawStatus !== "string" || !known.includes(rawStatus)) refuse("unknown-enum", `${at}.status`);
    status = rawStatus as DisputeEvidenceRunStatus;
  }
  const effective = status ?? DEFAULT_EVIDENCE_RUN_STATUS;
  const completed = effective === "completed";

  const attachments = requireInteger(raw.attachments, `${at}.attachments`, MAX_EVIDENCE_ATTACHMENTS_PER_PARTY);
  // A run that has not delivered has admitted nothing. A record claiming
  // otherwise describes an answer nobody returned, and it would be counted by
  // row 22 as one.
  if (!completed && attachments !== 0) refuse("invalid-state-record", `${at}.attachments:${effective}`);

  let references: PersistedEvidenceRef[] | undefined;
  const rawReferences = raw.references;
  if (rawReferences !== undefined) {
    if (!completed) refuse("invalid-state-record", `${at}.references:${effective}`);
    if (!Array.isArray(rawReferences)) refuse("invalid-type", `${at}.references`);
    if (rawReferences.length > MAX_EVIDENCE_ATTACHMENTS_PER_PARTY) {
      refuse("too-many-items", `${at}.references:${rawReferences.length}`);
    }
    references = rawReferences.map((ref, index) => parsePersistedEvidenceRefValue(ref, `${at}.references[${index}]`));
    // The count is what row 22 records; the list is the detail beside it. A
    // record whose two halves disagree cannot be resolved in either direction
    // without inventing evidence or discarding it.
    if (references.length !== attachments) refuse("invalid-state-record", `${at}.references:${references.length}`);
  }

  let dropped: number | undefined;
  if (raw.dropped !== undefined) {
    dropped = requireInteger(raw.dropped, `${at}.dropped`, MAX_EVIDENCE_DROPPED_PER_PARTY);
  }

  let artifacts: DisputeEvidenceArtifactRef[] | undefined;
  const rawArtifacts = raw.artifacts;
  if (rawArtifacts !== undefined) {
    if (!Array.isArray(rawArtifacts)) refuse("invalid-type", `${at}.artifacts`);
    if (rawArtifacts.length > MAX_EVIDENCE_ARTIFACT_REFS_PER_PARTY) {
      refuse("too-many-items", `${at}.artifacts:${rawArtifacts.length}`);
    }
    artifacts = rawArtifacts.map((ref, index) => parseArtifactRef(ref, `${at}.artifacts[${index}]`));
  }

  let reason: string | undefined;
  const rawReason = raw.reason;
  if (rawReason !== undefined) {
    if (effective !== "recoverable") refuse("invalid-state-record", `${at}.reason:${effective}`);
    if (typeof rawReason !== "string") refuse("invalid-type", `${at}.reason`);
    if (rawReason.length > MAX_EVIDENCE_RUN_REASON_CHARS) refuse("field-too-long", `${at}.reason:${rawReason.length}`);
    if (!EVIDENCE_RUN_REASON_RE.test(rawReason)) refuse("invalid-type", `${at}.reason:format`);
    reason = rawReason;
  }

  return {
    runId,
    attempt,
    attachments,
    ...(status === undefined ? {} : { status }),
    ...(references === undefined ? {} : { references }),
    ...(dropped === undefined ? {} : { dropped }),
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * Read an evidence-round record back, or say why it is not one this protocol
 * could have written.
 *
 * The record round-trips through `task.context` as JSON, so it is validated on
 * the way in like every other persisted value this protocol reads: an entry that
 * cannot be admitted fails the dispatch closed rather than being silently
 * dropped, because dropping it is exactly the bug that would let ONE party's run
 * close a two-party round.
 *
 * Nothing is rewritten on the way through. A #955 count-only record parses to
 * itself — same fields, same bytes when re-serialized — and its meaning comes
 * from the defaults the accessors below apply, not from fields materialized
 * here. That is what makes the migration total: an upgraded runner reading a
 * mid-round block sees precisely what wrote it.
 */
export function parseDisputeEvidenceRoundState(value: unknown): DisputeEvidenceRoundStateResult {
  if (value === undefined || value === null) return { ok: true, value: emptyEvidenceRound() };
  if (!isRecord(value)) return { ok: false, failure: { reason: "invalid-type", detail: "evidenceRound" } };
  if (value.lineages === undefined) return { ok: true, value: emptyEvidenceRound() };
  if (!isRecord(value.lineages)) return { ok: false, failure: { reason: "invalid-type", detail: "evidenceRound.lineages" } };

  const state = emptyEvidenceRound();
  try {
    const lineageIds = Object.keys(value.lineages);
    // A round covers lineages the §10.1 block already bounds, so a record naming
    // more than a task may hold is describing a debate this protocol could not
    // have had — and it is the one dimension of this record that is otherwise
    // open-ended.
    if (lineageIds.length > MAX_LINEAGES_PER_TASK) {
      refuse("too-many-items", `evidenceRound.lineages:${lineageIds.length}`);
    }
    for (const [lineageId, entry] of Object.entries(value.lineages)) {
      const at = `evidenceRound.lineages[${lineageId}]`;
      if (!isRecord(entry)) refuse("invalid-type", at);
      const version = requireInteger(entry.version, `${at}.version`, Number.MAX_SAFE_INTEGER, 1);
      const round =
        entry.round === undefined
          ? undefined
          : requireInteger(entry.round, `${at}.round`, ABSOLUTE_MAX_EVIDENCE_ROUNDS, 1);
      if (!isRecord(entry.parties)) refuse("invalid-type", `${at}.parties`);

      const parties: Partial<Record<EvidenceCollectionParty, DisputeEvidencePartyRun>> = {};
      for (const [party, run] of Object.entries(entry.parties)) {
        if (!EVIDENCE_COLLECTION_PARTIES.includes(party as EvidenceCollectionParty)) {
          refuse("unknown-enum", `${at}.parties.${party}`);
        }
        parties[party as EvidenceCollectionParty] = parsePartyRun(run, `${at}.parties.${party}`);
      }

      const recordedRunId =
        entry.recordedRunId === undefined ? undefined : requireRunId(entry.recordedRunId, `${at}.recordedRunId`);

      state.lineages[lineageId] = {
        version,
        ...(round === undefined ? {} : { round }),
        parties,
        ...(recordedRunId === undefined ? {} : { recordedRunId }),
      };
    }
  } catch (err) {
    if (err instanceof EvidenceRecordError) return { ok: false, failure: err.failure };
    throw err;
  }
  return { ok: true, value: state };
}

/**
 * The upper bound on the serialized round record.
 *
 * The structural bounds above are the real limit — lineages, parties, references
 * per party, artifacts per party are each capped — and this is the check that
 * they add up to something a context column may hold. A record that exceeds it
 * is refused rather than truncated: a truncated round is one whose parties or
 * counts have silently changed, which is the same fault as losing a party's
 * answer.
 */
export const REVIEW_DISPUTE_EVIDENCE_ROUND_MAX_BYTES = REVIEW_DISPUTE_RECORD_MAX_BYTES;

/** Serialize the round record deterministically, bounded (§10.1). */
export function serializeEvidenceRoundState(state: DisputeEvidenceRoundState): ReviewDisputeResult<string> {
  return serializeRecord(state, REVIEW_DISPUTE_EVIDENCE_ROUND_MAX_BYTES);
}

/**
 * The round record a task carries, from its own context. A convenience for the
 * caller that dispatches these turns: the key is this module's, and re-deriving
 * it at the call site is how the two drift.
 */
export function readDisputeEvidenceRoundState(
  taskContext: Record<string, unknown> | undefined,
): DisputeEvidenceRoundStateResult {
  if (taskContext === undefined) return { ok: true, value: emptyEvidenceRound() };
  return parseDisputeEvidenceRoundState(
    Object.prototype.hasOwnProperty.call(taskContext, REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY)
      ? taskContext[REVIEW_DISPUTE_EVIDENCE_ROUND_CONTEXT_KEY]
      : undefined,
  );
}

// ---------------------------------------------------------------------------
// Accessors (where every default lives)
// ---------------------------------------------------------------------------

/** One lineage's entry, by own property: an inherited key names no lineage. */
export function disputeEvidenceRoundEntry(
  state: DisputeEvidenceRoundState,
  lineageId: string,
): DisputeEvidenceLineageRound | undefined {
  return Object.prototype.hasOwnProperty.call(state.lineages, lineageId) ? state.lineages[lineageId] : undefined;
}

/** Which round an entry describes; absent is §7.1's single round. */
export function disputeEvidenceRoundNumber(entry: DisputeEvidenceLineageRound): number {
  return entry.round ?? DEFAULT_EVIDENCE_ROUND;
}

/** One run record's status; absent is `completed`, which is what #955 wrote. */
export function disputeEvidenceRunStatus(run: DisputeEvidencePartyRun): DisputeEvidenceRunStatus {
  return run.status ?? DEFAULT_EVIDENCE_RUN_STATUS;
}

/** Where one party stands for one lineage. No entry at all is `not_started`. */
export function disputeEvidencePartyState(
  entry: DisputeEvidenceLineageRound | undefined,
  party: EvidenceCollectionParty,
): DisputeEvidencePartyState {
  const run = entry?.parties[party];
  return run === undefined ? "not_started" : disputeEvidenceRunStatus(run);
}

/** The party's own run record, whatever state it is in. */
export function disputeEvidencePartyRun(
  entry: DisputeEvidenceLineageRound | undefined,
  party: EvidenceCollectionParty,
): DisputeEvidencePartyRun | undefined {
  return entry?.parties[party];
}

/**
 * Has every §7.1 party COMPLETED for this lineage?
 *
 * Completion, not presence: a party mid-run or waiting on a retry has a record
 * and has not answered, and a round closed on one would record attachments
 * nobody collected. A block written before #956 carries only completed records,
 * so this is the same answer #955 gave for every record it could read.
 */
export function disputeEvidenceRoundComplete(entry: DisputeEvidenceLineageRound | undefined): boolean {
  if (entry === undefined) return false;
  return EVIDENCE_COLLECTION_PARTIES.every((party) => disputeEvidencePartyState(entry, party) === "completed");
}

/** Every party's admitted attachments for one lineage — what row 22 records. */
export function disputeEvidenceAttachmentsRecorded(entry: DisputeEvidenceLineageRound): number {
  return EVIDENCE_COLLECTION_PARTIES.reduce((total, party) => {
    const run = entry.parties[party];
    return total + (run !== undefined && disputeEvidenceRunStatus(run) === "completed" ? run.attachments : 0);
  }, 0);
}

/**
 * Every admitted reference one lineage's round retained, in party order.
 *
 * The empty array is a real answer twice over: a round that admitted none, and a
 * round whose records are #955's count-only form. The two are distinguished by
 * {@link disputeEvidenceAttachmentsRecorded}, which never lost the count.
 */
export function disputeEvidenceReferences(entry: DisputeEvidenceLineageRound): PersistedEvidenceRef[] {
  const refs: PersistedEvidenceRef[] = [];
  for (const party of EVIDENCE_COLLECTION_PARTIES) {
    const run = entry.parties[party];
    if (run === undefined || disputeEvidenceRunStatus(run) !== "completed") continue;
    for (const ref of run.references ?? []) refs.push(ref);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Resuming a round (issue #963)
// ---------------------------------------------------------------------------

/**
 * Is this party's admitted answer on file for THIS round identity?
 *
 * The question a resuming dispatcher asks before it invokes anyone, answered
 * from the durable record alone — never from an agent's account of what it did.
 * Four facts have to agree, and each `false` is a different reason the party is
 * still owed a run:
 *
 *  - an entry exists at all — absence is `not_started`;
 *  - its version is the round's ({@link EvidenceRoundCoordinates}): a record
 *    collected against a version the lineage has left describes a finding that
 *    was materially revised under the round, and §2.2's successor version IS the
 *    new round identity, so the stale answer recognizes nothing;
 *  - its round number is the round's, for the same reason at the §6.1 axis;
 *  - the round is unspent (`recordedRunId` absent): a spent record is a PREVIOUS
 *    round, and a later one starts from an empty record rather than reusing it;
 *  - the party COMPLETED. A `running` or `recoverable` record is an invocation
 *    fact, not an answer — it says which attempt stopped, and the party is still
 *    the one a dispatcher must run.
 */
export function disputeEvidencePartyAnswered(
  entry: DisputeEvidenceLineageRound | undefined,
  party: EvidenceCollectionParty,
  coordinates: EvidenceRoundCoordinates,
): boolean {
  if (entry === undefined) return false;
  if (entry.version !== coordinates.version) return false;
  if (disputeEvidenceRoundNumber(entry) !== (coordinates.round ?? DEFAULT_EVIDENCE_ROUND)) return false;
  if (entry.recordedRunId !== undefined) return false;
  return disputeEvidencePartyState(entry, party) === "completed";
}

/**
 * What a resuming dispatcher must do next for one evidence turn.
 *
 *  - `collect` — this party is still owed a run for at least one covered
 *    lineage. §7.1 dispatches one run per party covering every lineage, so a
 *    party is owed as a whole: partially-on-file answers are the invocation
 *    layer's to reconcile, not a reason to run half a party.
 *  - `record` — both parties' answers are on file for every covered lineage,
 *    none of them spent. No invocation is owed; dispatching either party
 *    replays the record and row 22 closes the round (#951's `round_complete`
 *    recognition).
 *  - `none` — there is no lineage to collect for.
 */
export type EvidenceCollectionPartySelection =
  | { kind: "collect"; party: EvidenceCollectionParty }
  | { kind: "record" }
  | { kind: "none" };

/**
 * Which party a resuming dispatcher runs next, from the durable record alone.
 *
 * Deterministic and stable across restarts: parties are considered in §7.1's
 * declared order, so a fresh round always starts with the implementer and a
 * partial round resumes with the FIRST party still owed — never both, and never
 * the one whose admitted answer is already on file (issue #963). A lineage whose
 * record is stale (a revised version, a spent round) recognizes no answer, so a
 * materially revised finding restarts from the implementer under the new round
 * identity, which costs nothing: party runs consume no §6.1 counter.
 */
export function selectEvidenceCollectionParty(
  state: DisputeEvidenceRoundState,
  lineages: readonly EvidenceRoundCoordinates[],
): EvidenceCollectionPartySelection {
  if (lineages.length === 0) return { kind: "none" };
  for (const party of EVIDENCE_COLLECTION_PARTIES) {
    const owed = lineages.some(
      (coordinates) =>
        !disputeEvidencePartyAnswered(disputeEvidenceRoundEntry(state, coordinates.lineageId), party, coordinates),
    );
    if (owed) return { kind: "collect", party };
  }
  return { kind: "record" };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function copyState(state: DisputeEvidenceRoundState): DisputeEvidenceRoundState {
  const next = emptyEvidenceRound();
  for (const [lineageId, entry] of Object.entries(state.lineages)) next.lineages[lineageId] = entry;
  return next;
}

/**
 * The predecessor entry this write may build on, or none.
 *
 * #955's rule, unchanged and now in one place: a record collected against a
 * version the lineage has left describes a finding that was revised under the
 * round, and one a DIFFERENT run has already spent is a previous round. Either
 * is replaced rather than continued — which costs nothing, because a party run
 * consumes no §6.1 counter — so a spent round can never close a new one on its
 * predecessor's parties. The round number joins the comparison for the same
 * reason the version is in it.
 */
function carriedEntry(
  prior: DisputeEvidenceLineageRound | undefined,
  version: number,
  round: number,
  runId: string,
): DisputeEvidenceLineageRound | undefined {
  if (prior === undefined) return undefined;
  if (prior.version !== version) return undefined;
  if (disputeEvidenceRoundNumber(prior) !== round) return undefined;
  if (prior.recordedRunId !== undefined && prior.recordedRunId !== runId) return undefined;
  return prior;
}

function checkCoordinates(coordinates: EvidencePartyRunCoordinates): ReviewDisputeFailure | null {
  const { lineageId, party, runId } = coordinates;
  if (typeof lineageId !== "string" || lineageId === "") {
    return { reason: "invalid-type", detail: "evidenceRound.lineageId" };
  }
  if (!EVIDENCE_COLLECTION_PARTIES.includes(party)) {
    return { reason: "unknown-enum", detail: `evidenceRound.party:${String(party)}` };
  }
  if (boundedInteger(coordinates.version, Number.MAX_SAFE_INTEGER, 1) === null) {
    return { reason: "invalid-type", detail: "evidenceRound.version" };
  }
  if (boundedInteger(coordinates.round ?? DEFAULT_EVIDENCE_ROUND, ABSOLUTE_MAX_EVIDENCE_ROUNDS, 1) === null) {
    return { reason: "invalid-type", detail: `evidenceRound.round:${String(coordinates.round)}` };
  }
  if (boundedInteger(coordinates.attempt, MAX_DISPUTE_SUB_TURN_ATTEMPT) === null) {
    return { reason: "invalid-type", detail: `evidenceRound.attempt:${String(coordinates.attempt)}` };
  }
  if (typeof runId !== "string" || runId.trim() === "") {
    return { reason: "invalid-type", detail: "evidenceRound.runId" };
  }
  if (runId.length > MAX_RUN_ID_CHARS) return { reason: "field-too-long", detail: `evidenceRound.runId:${runId.length}` };
  return null;
}

/**
 * Write one party's run record for one lineage.
 *
 * Every writer below funnels through here, so the carry-forward rule, the
 * bounds, and the "a run record only ever replaces its own party's" property are
 * decided once. The state handed in is never mutated: the round record is a
 * value the caller commits inside its own transaction, and a writer that mutated
 * it would move state before the transaction that owns the decision ran.
 */
function writePartyRun(
  state: DisputeEvidenceRoundState,
  coordinates: EvidencePartyRunCoordinates,
  run: DisputeEvidencePartyRun,
): DisputeEvidenceRoundWriteResult {
  const invalid = checkCoordinates(coordinates);
  if (invalid !== null) return { ok: false, failure: invalid };

  const round = coordinates.round ?? DEFAULT_EVIDENCE_ROUND;
  const prior = disputeEvidenceRoundEntry(state, coordinates.lineageId);
  const carried = carriedEntry(prior, coordinates.version, round, coordinates.runId);

  const parties: Partial<Record<EvidenceCollectionParty, DisputeEvidencePartyRun>> = { ...carried?.parties };
  parties[coordinates.party] = run;

  const next = copyState(state);
  next.lineages[coordinates.lineageId] = {
    version: coordinates.version,
    // Written only when it is not the default, so a record for §7.1's single
    // round is byte-identical to the one #955 wrote for it.
    ...(round === DEFAULT_EVIDENCE_ROUND ? {} : { round }),
    parties,
    ...(carried?.recordedRunId === undefined ? {} : { recordedRunId: carried.recordedRunId }),
  };
  return { ok: true, value: next };
}

/**
 * A party run is about to be dispatched: record it as `running`.
 *
 * Optional by design — #955's dispatch records a party only once it has
 * answered, and that is still a complete and correct round — but it is what lets
 * an interrupted phase tell "this party never ran" from "this party ran and we
 * never learned the outcome". The first may be dispatched as-is; the second is a
 * new attempt.
 */
export function beginEvidencePartyRun(
  state: DisputeEvidenceRoundState,
  coordinates: EvidencePartyRunCoordinates,
): DisputeEvidenceRoundWriteResult {
  return writePartyRun(state, coordinates, {
    runId: coordinates.runId,
    attempt: coordinates.attempt,
    attachments: 0,
    status: "running",
  });
}

/**
 * A party run stopped without delivering, and another attempt may take its
 * place.
 *
 * Nothing is charged and nothing is admitted: the record says which attempt
 * stopped and, in one bounded token, why. It is not an answer, so the round
 * stays incomplete and the party stays the one a dispatcher must run.
 */
export function markEvidencePartyRunRecoverable(
  state: DisputeEvidenceRoundState,
  coordinates: EvidencePartyRunCoordinates,
  reason?: string,
): DisputeEvidenceRoundWriteResult {
  if (reason !== undefined) {
    if (reason.length > MAX_EVIDENCE_RUN_REASON_CHARS) {
      return { ok: false, failure: { reason: "field-too-long", detail: `evidenceRound.reason:${reason.length}` } };
    }
    if (!EVIDENCE_RUN_REASON_RE.test(reason)) {
      return { ok: false, failure: { reason: "invalid-type", detail: "evidenceRound.reason:format" } };
    }
  }
  return writePartyRun(state, coordinates, {
    runId: coordinates.runId,
    attempt: coordinates.attempt,
    attachments: 0,
    status: "recoverable",
    ...(reason === undefined ? {} : { reason }),
  });
}

/**
 * What one completed party run admitted.
 *
 * `references` are the §3.3 references as the resolver admitted them; they are
 * projected into their persisted form here, so no caller has to know that an
 * `issue_quote` is persisted as a digest. `attachments` may be given instead
 * (the #955 count-only form) or alongside, and when both are present they must
 * agree.
 */
export interface EvidenceAdmittedResult {
  /** Defaults to `references.length`, or to 0 when neither is given. */
  attachments?: number;
  references?: readonly EvidenceRef[];
  /** §7.1: references the run returned that did not resolve and were dropped. */
  dropped?: number;
  artifacts?: readonly DisputeEvidenceArtifactRef[];
}

/**
 * A party's run delivered: record what it admitted.
 *
 * The one write that makes a round completable, and the only one that may carry
 * a result. Zero admitted attachments with an EMPTY reference list is a valid
 * completed party — §7.1 says the runner records the admitted attachments
 * "(possibly none)" — and it is deliberately distinguishable from a count-only
 * record, which carries no list at all.
 */
export function completeEvidencePartyRun(
  state: DisputeEvidenceRoundState,
  coordinates: EvidencePartyRunCoordinates,
  result: EvidenceAdmittedResult = {},
): DisputeEvidenceRoundWriteResult {
  let references: PersistedEvidenceRef[] | undefined;
  if (result.references !== undefined) {
    if (result.references.length > MAX_EVIDENCE_ATTACHMENTS_PER_PARTY) {
      return {
        ok: false,
        failure: { reason: "too-many-items", detail: `evidenceRound.references:${result.references.length}` },
      };
    }
    references = [];
    for (const [index, ref] of result.references.entries()) {
      // Admitted by §3.3's own validator before it is persisted: a reference
      // this module cannot read back is one it must not write, or the very next
      // dispatch would refuse the record this one produced.
      const validated = validateEvidenceRef(ref, `evidenceRound.references[${index}]`);
      if (!validated.ok) return { ok: false, failure: validated.failure };
      references.push(toPersistedEvidenceRef(validated.value));
    }
  }

  const attachments = result.attachments ?? references?.length ?? 0;
  if (boundedInteger(attachments, MAX_EVIDENCE_ATTACHMENTS_PER_PARTY) === null) {
    return { ok: false, failure: { reason: "too-many-items", detail: `evidenceRound.attachments:${String(attachments)}` } };
  }
  if (references !== undefined && references.length !== attachments) {
    return {
      ok: false,
      failure: { reason: "invalid-state-record", detail: `evidenceRound.references:${references.length}` },
    };
  }
  if (result.dropped !== undefined && boundedInteger(result.dropped, MAX_EVIDENCE_DROPPED_PER_PARTY) === null) {
    return { ok: false, failure: { reason: "too-many-items", detail: `evidenceRound.dropped:${String(result.dropped)}` } };
  }

  let artifacts: DisputeEvidenceArtifactRef[] | undefined;
  if (result.artifacts !== undefined) {
    if (result.artifacts.length > MAX_EVIDENCE_ARTIFACT_REFS_PER_PARTY) {
      return {
        ok: false,
        failure: { reason: "too-many-items", detail: `evidenceRound.artifacts:${result.artifacts.length}` },
      };
    }
    artifacts = [];
    for (const [index, ref] of result.artifacts.entries()) {
      const at = `evidenceRound.artifacts[${index}]`;
      if (!isEvidenceArtifactBaseName(ref?.name)) return { ok: false, failure: { reason: "invalid-type", detail: `${at}.name` } };
      if (typeof ref.digest !== "string" || !EVIDENCE_DIGEST_RE.test(ref.digest)) {
        return { ok: false, failure: { reason: "invalid-type", detail: `${at}.digest` } };
      }
      if (boundedInteger(ref.bytes, Number.MAX_SAFE_INTEGER) === null) {
        return { ok: false, failure: { reason: "invalid-type", detail: `${at}.bytes` } };
      }
      artifacts.push({ name: ref.name, digest: ref.digest, bytes: ref.bytes });
    }
  }

  return writePartyRun(state, coordinates, {
    runId: coordinates.runId,
    attempt: coordinates.attempt,
    attachments,
    // `completed` is the default a reader applies, so it is omitted: a count-only
    // completion writes the same three fields #955 wrote, and a block that
    // round-trips through an older reader is unchanged by the trip.
    ...(references === undefined ? {} : { references }),
    ...(result.dropped === undefined ? {} : { dropped: result.dropped }),
    ...(artifacts === undefined ? {} : { artifacts }),
  });
}

/**
 * Row 22 was applied for this lineage under this run: mark the round spent.
 *
 * The record keeps the run id that closed it, so a redelivery of the closing run
 * re-derives the same row (and #840's ledger recognizes it) while a later round
 * for that lineage starts from an empty record rather than closing itself on
 * this one's parties.
 */
export function markEvidenceRoundRecorded(
  state: DisputeEvidenceRoundState,
  lineageId: string,
  runId: string,
): DisputeEvidenceRoundState {
  const entry = disputeEvidenceRoundEntry(state, lineageId);
  if (entry === undefined) return state;
  const next = copyState(state);
  next.lineages[lineageId] = { ...entry, recordedRunId: runId };
  return next;
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * What the operator projection may report a party to be.
 *
 * The four persisted states plus one the record itself has no token for: a
 * status field that is present and unreadable. The projection reads tolerantly
 * and a record whose status cannot be read is exactly the case an operator is
 * looking at the output for — reporting it as `completed`, which is what an
 * ABSENT status means, would tell them a party answered when nothing says so.
 */
export type DisputeEvidencePartyStatusState = DisputeEvidencePartyState | "unreadable";

/** One party's line in the operator view. Literals and counters only. */
export interface DisputeEvidencePartyStatus {
  party: EvidenceCollectionParty;
  state: DisputeEvidencePartyStatusState;
  /** Absent on a party that never started. */
  attempt: number | null;
  attachments: number;
  /** How many admitted references the record RETAINED, never the references. */
  references: number;
  dropped: number;
  /** How many §10.2 artifacts the run named. Names stay out of the projection. */
  artifacts: number;
  /** A `recoverable` run's bounded reason token, when it recorded one. */
  reason: string | null;
}

/** One lineage's round, as an operator surface may show it. */
export interface DisputeEvidenceRoundStatus {
  lineageId: string;
  version: number | null;
  round: number;
  complete: boolean;
  /** Row 22 has already been applied for this round. */
  recorded: boolean;
  attachmentsRecorded: number;
  parties: DisputeEvidencePartyStatus[];
}

function tolerantCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Project a task's evidence-round record for an operator, TOLERANTLY.
 *
 * The same posture `review-dispute-status.ts` takes with the §10.1 block: a
 * record an operator most needs to see is the one that failed validation, so
 * this reader refuses nothing and invents nothing — a field it cannot read is
 * reported as absent or zero rather than defaulted to a plausible value. It
 * reads the raw context value rather than a parsed state for exactly that
 * reason.
 *
 * Nothing here is content: counts, literals, a version, and the two party
 * states. The references themselves, their paths, the quotes' digests, and the
 * artifact names all stay out — an operator surface is a publication surface
 * (§11), and this projection is the one place the round could have leaked into
 * one.
 */
/**
 * One party's round progress, as an operator line (issue #965).
 *
 * Shared by `admin dispute status` and the admin UI so the two surfaces cannot
 * disagree about what a partial round looks like. It answers the two questions a
 * stalled round actually raises — *which party is still owed*, and *why the last
 * attempt stopped* — and answers them with the projection's own bounded values:
 * the state token, the attempt number, the attachment COUNT, and the recoverable
 * run's bounded reason token. No reference, no digest, no artifact name, no path.
 */
export function formatEvidenceParty(party: DisputeEvidencePartyStatus): string {
  return (
    `${party.party}=${party.state}(${party.attachments})`
    + (party.attempt === null ? "" : `@${party.attempt}`)
    + (party.reason === null ? "" : ` [${party.reason}]`)
  );
}

export function projectEvidenceRoundStatus(value: unknown): DisputeEvidenceRoundStatus[] {
  if (!isRecord(value) || !isRecord(value.lineages)) return [];
  const out: DisputeEvidenceRoundStatus[] = [];
  for (const lineageId of Object.keys(value.lineages).sort()) {
    const entry = value.lineages[lineageId];
    if (!isRecord(entry)) continue;
    const rawParties = isRecord(entry.parties) ? entry.parties : {};
    const parties: DisputeEvidencePartyStatus[] = EVIDENCE_COLLECTION_PARTIES.map((party) => {
      const run = isRecord(rawParties[party]) ? (rawParties[party] as Record<string, unknown>) : null;
      const known: readonly string[] = DISPUTE_EVIDENCE_RUN_STATUSES;
      const rawStatus = run === null ? undefined : run.status;
      const status: DisputeEvidencePartyStatusState =
        run === null
          ? "not_started"
          : rawStatus === undefined
            ? DEFAULT_EVIDENCE_RUN_STATUS
            : typeof rawStatus === "string" && known.includes(rawStatus)
              ? (rawStatus as DisputeEvidenceRunStatus)
              : "unreadable";
      return {
        party,
        state: status,
        attempt: run !== null && typeof run.attempt === "number" ? run.attempt : null,
        attachments: run === null ? 0 : tolerantCount(run.attachments),
        references: run !== null && Array.isArray(run.references) ? run.references.length : 0,
        dropped: run === null ? 0 : tolerantCount(run.dropped),
        artifacts: run !== null && Array.isArray(run.artifacts) ? run.artifacts.length : 0,
        reason: run !== null && typeof run.reason === "string" ? run.reason : null,
      };
    });
    out.push({
      lineageId,
      version: typeof entry.version === "number" ? entry.version : null,
      round: typeof entry.round === "number" ? entry.round : DEFAULT_EVIDENCE_ROUND,
      complete: parties.every((p) => p.state === "completed"),
      recorded: typeof entry.recordedRunId === "string" && entry.recordedRunId !== "",
      attachmentsRecorded: parties.reduce((total, p) => total + (p.state === "completed" ? p.attachments : 0), 0),
      parties,
    });
  }
  return out;
}

/**
 * The bounded per-lineage summary a §10.3 audit payload may carry.
 *
 * Derived from an ADMITTED record rather than from the raw value, because an
 * event is written by the run that just produced the state and that state has
 * already been validated by then. Counts and literals only — no reference, no
 * artifact name, no run id beyond the one the caller already publishes.
 */
export function summarizeEvidenceRound(entry: DisputeEvidenceLineageRound): Record<string, unknown> {
  const parties: Record<string, unknown> = {};
  for (const party of EVIDENCE_COLLECTION_PARTIES) {
    const run = entry.parties[party];
    if (run === undefined) continue;
    parties[party] = {
      state: disputeEvidenceRunStatus(run),
      attempt: run.attempt,
      attachments: run.attachments,
      ...(run.references === undefined ? {} : { references: run.references.length }),
      ...(run.dropped === undefined ? {} : { dropped: run.dropped }),
      ...(run.artifacts === undefined ? {} : { artifacts: run.artifacts.length }),
      ...(run.reason === undefined ? {} : { reason: run.reason }),
    };
  }
  return {
    version: entry.version,
    round: disputeEvidenceRoundNumber(entry),
    complete: disputeEvidenceRoundComplete(entry),
    recorded: entry.recordedRunId !== undefined,
    attachmentsRecorded: disputeEvidenceAttachmentsRecorded(entry),
    parties,
  };
}
