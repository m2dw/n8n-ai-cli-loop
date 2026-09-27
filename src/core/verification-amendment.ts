import { createHash } from "crypto";
import type { AiTask, StoreResult, TaskEvent, TaskKey, TaskPhase, TaskStatus } from "./task.js";
import type { OutboxEffect, TaskStore } from "./task-store.js";
import type { ResolvedSession } from "./session.js";
import {
  enqueueStatusLabelEffects,
  enqueueVerificationAmendmentGateSupersededEffect,
  sessionRedactionPaths,
  workItemOutbox,
} from "./outbox-effects.js";
import { makeOutboxKey } from "./outbox.js";
import { OutboxEffectCollector } from "./phase-runner.js";
import { sanitizeBody } from "./text-sanitize.js";
import { matchesConfiguredVerificationCommand } from "./tool-request-continuation.js";
import {
  buildVerificationAmendmentComment,
  renderVerificationAmendmentComment,
  verificationAmendmentCommentIdempotencyKey,
  verificationAmendmentCommentMarker,
  verificationAmendmentGateSummary,
  type VerificationAmendmentPublicSlot,
} from "./verification-amendment-publication.js";
import {
  isVerificationSlotInvalidated,
  VERIFICATION_EVIDENCE_BINDING_CONTEXT_KEY,
} from "./verification-evidence.js";

/**
 * Task-scoped verification plan revisions and amendments — the persistence
 * slice (issue #1038, docs/verification-amendment-contract.md §15 slice A2).
 *
 * This module owns the durable shape of the operator-owned amendment record
 * and the two atomic writes over it:
 *
 * - the append-only revision chain plus the mutable plan checkpoint, stored
 *   together under ONE task-context key (§5.5) — no new column, table, or
 *   `TaskStore` method, so tasks written before this module exist unchanged
 *   and remain readable (absent key = no revisions, no checkpoint);
 * - {@link applyVerificationAmendmentRevision} — append one revision and
 *   replace the checkpoint in one compare-and-swap on `AiTask.revision`, with
 *   the §7.1 status re-check riding the same transaction and one bounded
 *   `verification.amendment.applied` audit event (§12.1);
 * - {@link rebaseVerificationPlanCheckpoint} — re-anchor the checkpoint to a
 *   moved session baseline (§6.4 rule 5) without touching any revision,
 *   consuming no ordinal, with one `verification.amendment.rebased` event.
 *
 * Continuation routing (§9, issue #1043) also lives in the apply: a revision
 * whose `continuation` is `"review"` or `"implementation"` re-queues the task
 * `{status: "queued", phase: <continuation>}` in the SAME transaction that
 * persists the amended plan and its digest (§9.2 rule 2), so a claim can never
 * observe a re-queued task with a stale plan. The re-queue also invalidates
 * the stale review-park state the amendment corrects
 * ({@link VERIFICATION_CONTINUATION_CLEARED_CONTEXT_KEYS}) — the recorded
 * missing-command list and the per-command status snapshot the next review
 * recomputes from the amended plan — and, when the caller supplies the
 * resolved session, enqueues the label effects of the shipped `{queued,
 * <phase>}` edges in the same transaction, so the success-only stack-ready
 * marker of the review that parked the task cannot outlive its re-queue.
 * `manualVerificationEvidence` entries are preserved (§8.1: no amendment
 * deletes evidence), with the §8.3 rule 1 per-slot invalidation record
 * appended to every passing entry a requirement-layer `replace` supersedes —
 * admissibility is then decided per slot at consumption. A continuation the
 * §9.2 table withholds for the task's row refuses the whole revision (§9.2
 * rule 3).
 *
 * Public reporting (§12.2, issue #1044) is enqueued from the same transaction:
 * one work-item comment per applied revision, keyed on `revisionId` and on no
 * run identifier. What that comment SAYS is projected by
 * `core/verification-amendment-publication.ts` over the resulting plan, which
 * the applying surface supplies exactly as it supplies `slotCounts` — this
 * module owns the atomicity of the publication, not its wording.
 *
 * Deliberately NOT here (later slices): effective-plan resolution (§6),
 * `revisionId`/`requestKey` derivation (§5.3 rules 1–2 — callers supply the
 * derived values and this module validates their form), and the operator CLI
 * (§11). The one §5.1 identity rule implemented here is `commandId`
 * derivation, because the audit event names every operation by its `commandId`
 * and an `add` operation does not carry one.
 */

/**
 * The task-context key holding the whole §5.5 record: the append-only
 * `revisions` chain and the mutable `checkpoint`, as one block. One key for
 * both parts because their integrity is joint — a chain with no checkpoint
 * beside it, or a checkpoint whose `appliedThroughOrdinal` disagrees with the
 * chain, is a half-applied write and fails closed (§5.5).
 */
export const VERIFICATION_AMENDMENTS_CONTEXT_KEY = "verificationAmendments";

/** §12.1: one task event per applied revision. Free-form `TaskEvent.type`. */
export const VERIFICATION_AMENDMENT_APPLIED_EVENT = "verification.amendment.applied";

/** §12.1: one task event per checkpoint rebase. Free-form `TaskEvent.type`. */
export const VERIFICATION_AMENDMENT_REBASED_EVENT = "verification.amendment.rebased";

/**
 * Bounds (issue #1038: no unbounded revision history in task context; commands
 * and operator text bounded). The chain is append-only and never compacted
 * (§5.3 rule 6), so the only admissible bound is a refusal to grow further —
 * never truncation of what is stored. Oversized INPUT is refused whole;
 * nothing already persisted is ever rewritten to fit.
 */
export const MAX_VERIFICATION_AMENDMENT_REVISIONS = 200;
export const MAX_VERIFICATION_AMENDMENT_OPERATIONS = 50;
export const MAX_VERIFICATION_AMENDMENT_REASON_CHARS = 2000;
/**
 * Command bytes are stored verbatim (§2 — never rewritten, collapsed, or
 * truncated), so the cap rejects rather than trims.
 */
export const MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS = 4000;
export const MAX_VERIFICATION_AMENDMENT_ACTOR_ID_CHARS = 128;
export const MAX_VERIFICATION_AMENDMENT_NAME_CHARS = 128;
export const MAX_VERIFICATION_SESSION_BASELINE_ENTRIES = 100;

/** §5.1: an execution-layer name is a path component of a run artifact. */
const EXECUTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** §5.3 rule 2: the operator-suppliable request-key character rule. */
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** §5.3 rule 1: `"vamd-" + 16 lowercase hex`. */
const REVISION_ID_PATTERN = /^vamd-[0-9a-f]{16}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const EXEC_COMMAND_ID_PATTERN = /^exec:[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const REQ_COMMAND_ID_PATTERN = /^req:[0-9a-f]{16}$/;

export type VerificationAmendmentLayer = "execution" | "requirement";

/** §5.3: closed set. `"chatops"` is reserved by §17 — no verb exists yet. */
export type VerificationAmendmentSource = "admin-cli" | "chatops" | "issue-refresh";

export type VerificationAmendmentContinuation = "review" | "implementation" | "none";

/** §3.3: the actor of every revision is an operator; the kind set is closed. */
export interface VerificationAmendmentActor {
  kind: "operator";
  id: string;
}

/**
 * §5.2: the closed, exact-field serialized operation. The field set of each
 * variant is normative — `revisionId` is derived from the canonical encoding
 * of this shape — so validation refuses an unrecognized `kind` or `layer`, a
 * missing required field, and an unexpected extra field alike.
 */
export type VerificationAmendmentOperation =
  | { kind: "replace"; commandId: string; command: string; reason: string }
  | { kind: "add"; layer: "execution"; name: string; command: string; reason: string }
  | { kind: "add"; layer: "requirement"; command: string; reason: string }
  | { kind: "retire"; commandId: string; reason: string }
  | { kind: "restore"; commandId: string; reason: string }
  | { kind: "annotate"; commandId: string; reason: string };

/** §5.3: one applied revision. Every field is immutable once written. */
export interface VerificationAmendmentRevision {
  revisionId: string;
  /** 1-based, contiguous, assigned by the write — never by the caller. */
  revisionOrdinal: number;
  /** The caller-stable idempotency key; unique per task row (§5.3 rule 1). */
  requestKey: string;
  scope: "task";
  source: VerificationAmendmentSource;
  actor: VerificationAmendmentActor;
  reason: string;
  operations: readonly VerificationAmendmentOperation[];
  basePlanDigest: string;
  planDigest: string;
  sessionBaselineDigest: string;
  continuation: VerificationAmendmentContinuation;
  createdAt: string;
  /** The `AiTask.revision` the CAS write observed. */
  observedTaskRevision: number;
  /** §10 rule 6: present iff `source === "issue-refresh"`. */
  issueBodyDigest?: string;
}

/** §6.4 rule 1: one `{name, command}` pair of the observed session layer. */
export interface VerificationPlanSessionBaselineEntry {
  name: string;
  command: string;
}

/**
 * §5.5: the one mutable part of the stored record — the present-tense plan.
 * Replaced wholesale by an applied revision or a rebase, never edited in
 * place, and it never returns to absent once the first revision exists.
 */
export interface VerificationPlanCheckpoint {
  planDigest: string;
  sessionBaseline: readonly VerificationPlanSessionBaselineEntry[];
  sessionBaselineDigest: string;
  appliedThroughOrdinal: number;
  updatedAt: string;
  updatedBy: "revision" | "rebase";
}

/** The whole persisted block under {@link VERIFICATION_AMENDMENTS_CONTEXT_KEY}. */
export interface VerificationAmendmentState {
  revisions: readonly VerificationAmendmentRevision[];
  checkpoint: VerificationPlanCheckpoint;
}

/** §5.1: the execution layer's `commandId` reuses the operator's name. */
export function deriveExecutionCommandId(name: string): string {
  return `exec:${name}`;
}

/**
 * §5.1: the requirement layer's `commandId`, hashed once over the identity
 * form — the command bytes VERBATIM. No trimming beyond what the bytes
 * already carry, no case folding, no whitespace collapsing: two commands that
 * differ in interior whitespace occupy two slots. (This is deliberately NOT
 * `tool-request-grant.ts`'s `normalizeCommand`, which collapses unquoted
 * space runs.)
 */
export function deriveRequirementCommandId(command: string): string {
  return `req:${sha256Hex(command).slice(0, 16)}`;
}

/**
 * The §5.2/§5.4 canonical JSON encoding: UTF-8, object keys sorted
 * lexicographically at every level, array order preserved, no insignificant
 * whitespace, absent (`undefined`) object fields omitted rather than encoded
 * as `null`. Shared vocabulary for every digest this contract defines; the
 * later resolution slice hashes the same encoding.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? "null" : canonicalJsonStringify(entry))).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError(`canonicalJsonStringify: unsupported value of type ${typeof value}`);
}

/** §6.4 rule 1: `sha256(canonicalJson(sessionBaseline))`, lowercase hex. */
export function deriveSessionBaselineDigest(
  entries: readonly VerificationPlanSessionBaselineEntry[],
): string {
  return sha256Hex(
    canonicalJsonStringify(entries.map((entry) => ({ name: entry.name, command: entry.command }))),
  );
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The exact-field-set check of §5.2: a field the variant does not list is not
 * permitted, and a field it lists is required. A present-but-`undefined`
 * field counts as unexpected — canonical JSON cannot represent it, so it
 * could only diverge the stored bytes from the hashed ones.
 */
function exactFieldsProblem(
  record: Record<string, unknown>,
  path: string,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    if (!(field in record)) return `${path}: missing required field "${field}"`;
  }
  for (const key of Object.keys(record)) {
    if (!fields.includes(key)) return `${path}: unexpected field "${key}"`;
  }
  return undefined;
}

function commandIdProblem(value: unknown, path: string): string | undefined {
  if (typeof value !== "string") return `${path}.commandId: not a string`;
  if (!EXEC_COMMAND_ID_PATTERN.test(value) && !REQ_COMMAND_ID_PATTERN.test(value)) {
    return `${path}.commandId: not an "exec:<name>" or "req:<16 lowercase hex>" identity`;
  }
  return undefined;
}

/**
 * §2: command bytes are end-trimmed by the authoring surface and otherwise
 * verbatim. Untrimmed input is refused rather than trimmed here — trimming at
 * this layer would persist bytes different from the ones the caller hashed
 * into `revisionId`.
 */
function commandBytesProblem(value: unknown, path: string): string | undefined {
  if (typeof value !== "string") return `${path}.command: not a string`;
  if (value.length === 0) return `${path}.command: empty`;
  if (value !== value.trim()) return `${path}.command: not end-trimmed`;
  if (value.length > MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS) {
    return `${path}.command: exceeds ${MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS} chars`;
  }
  return undefined;
}

/** §5.2 rule 1: mandatory, non-empty after trimming, bounded. */
function reasonProblem(value: unknown, path: string): string | undefined {
  if (typeof value !== "string") return `${path}.reason: not a string`;
  if (value.trim().length === 0) return `${path}.reason: empty after trimming`;
  if (value.length > MAX_VERIFICATION_AMENDMENT_REASON_CHARS) {
    return `${path}.reason: exceeds ${MAX_VERIFICATION_AMENDMENT_REASON_CHARS} chars`;
  }
  return undefined;
}

function operationProblem(value: unknown, path: string): string | undefined {
  if (!isPlainObject(value)) return `${path}: not an object`;
  const kind = value.kind;
  if (kind === "replace") {
    return (
      exactFieldsProblem(value, path, ["kind", "commandId", "command", "reason"]) ??
      commandIdProblem(value.commandId, path) ??
      commandBytesProblem(value.command, path) ??
      reasonProblem(value.reason, path)
    );
  }
  if (kind === "add") {
    const layer = value.layer;
    if (layer === "execution") {
      const shape =
        exactFieldsProblem(value, path, ["kind", "layer", "name", "command", "reason"]) ??
        commandBytesProblem(value.command, path) ??
        reasonProblem(value.reason, path);
      if (shape) return shape;
      if (typeof value.name !== "string" || !EXECUTION_NAME_PATTERN.test(value.name)) {
        return `${path}.name: violates the §5.1 character rule`;
      }
      if (value.name.length > MAX_VERIFICATION_AMENDMENT_NAME_CHARS) {
        return `${path}.name: exceeds ${MAX_VERIFICATION_AMENDMENT_NAME_CHARS} chars`;
      }
      return undefined;
    }
    if (layer === "requirement") {
      // §5.2: a requirement-layer `add` carries no `name` and no `commandId` —
      // its identity is derived at application time (§5.1).
      return (
        exactFieldsProblem(value, path, ["kind", "layer", "command", "reason"]) ??
        commandBytesProblem(value.command, path) ??
        reasonProblem(value.reason, path)
      );
    }
    return `${path}.layer: unrecognized layer`;
  }
  if (kind === "retire" || kind === "restore" || kind === "annotate") {
    return (
      exactFieldsProblem(value, path, ["kind", "commandId", "reason"]) ??
      commandIdProblem(value.commandId, path) ??
      reasonProblem(value.reason, path)
    );
  }
  return `${path}.kind: unrecognized operation kind`;
}

function operationsProblem(value: unknown, path: string): string | undefined {
  if (!Array.isArray(value)) return `${path}: not an array`;
  if (value.length === 0) return `${path}: empty — a revision carries at least one operation`;
  if (value.length > MAX_VERIFICATION_AMENDMENT_OPERATIONS) {
    return `${path}: exceeds ${MAX_VERIFICATION_AMENDMENT_OPERATIONS} operations`;
  }
  for (let i = 0; i < value.length; i += 1) {
    const problem = operationProblem(value[i], `${path}[${i}]`);
    if (problem) return problem;
  }
  return undefined;
}

export type VerificationAmendmentOperationsValidation =
  | { valid: true; operations: readonly VerificationAmendmentOperation[] }
  | { valid: false; detail: string };

/**
 * Validate a proposed operation list against the §5.2 schema — the exact field
 * set of each variant, the mandatory non-empty `reason`, the verbatim command
 * bytes, and the execution-layer name rule — and return the typed list.
 *
 * The authoring surface (`core/verification-plan.ts`, issue #1039) parses the
 * operator's input here so the shape a revision is composed from, hashed over,
 * and persisted with is one shape validated by one rule. An unrecognized
 * `kind` or `layer`, an absent required field, and an unexpected extra field
 * each fail closed, and by §5.3 rule 7 the whole revision with them.
 */
export function validateVerificationAmendmentOperations(
  value: unknown,
): VerificationAmendmentOperationsValidation {
  const problem = operationsProblem(value, "operations");
  if (problem) return { valid: false, detail: problem };
  return { valid: true, operations: value as readonly VerificationAmendmentOperation[] };
}

function digestProblem(value: unknown, path: string): string | undefined {
  if (typeof value !== "string" || !SHA256_HEX_PATTERN.test(value)) {
    return `${path}: not a 64-char lowercase hex sha256 digest`;
  }
  return undefined;
}

/**
 * §5.3/§5.5: `createdAt`/`updatedAt` are ISO-8601 UTC. Parseability is not
 * the rule — `Date.parse` also accepts locale-ish and offset forms whose
 * meaning is environment-dependent — the canonical `Date#toISOString`
 * representation is, checked by exact round-trip.
 */
function timestampProblem(value: unknown, path: string): string | undefined {
  if (typeof value !== "string") return `${path}: not a string`;
  const timeMs = Date.parse(value);
  if (!Number.isFinite(timeMs) || new Date(timeMs).toISOString() !== value) {
    return `${path}: not an ISO-8601 UTC timestamp in the canonical Date#toISOString form`;
  }
  return undefined;
}

function actorProblem(value: unknown, path: string): string | undefined {
  if (!isPlainObject(value)) return `${path}: not an object`;
  if (value.kind !== "operator") return `${path}.kind: not "operator"`;
  if (typeof value.id !== "string" || value.id.trim().length === 0) return `${path}.id: empty`;
  if (value.id.length > MAX_VERIFICATION_AMENDMENT_ACTOR_ID_CHARS) {
    return `${path}.id: exceeds ${MAX_VERIFICATION_AMENDMENT_ACTOR_ID_CHARS} chars`;
  }
  return undefined;
}

const AMENDMENT_SOURCES: readonly VerificationAmendmentSource[] = [
  "admin-cli",
  "chatops",
  "issue-refresh",
];

const AMENDMENT_CONTINUATIONS: readonly VerificationAmendmentContinuation[] = [
  "review",
  "implementation",
  "none",
];

/**
 * The shared field checks of one revision record — everything except the
 * write-assigned `revisionOrdinal`/`createdAt`/`observedTaskRevision`, which
 * the stored-record validator checks on top.
 */
function revisionCoreProblem(record: Record<string, unknown>, path: string): string | undefined {
  if (typeof record.revisionId !== "string" || !REVISION_ID_PATTERN.test(record.revisionId)) {
    return `${path}.revisionId: not "vamd-" + 16 lowercase hex`;
  }
  if (typeof record.requestKey !== "string" || !REQUEST_KEY_PATTERN.test(record.requestKey)) {
    return `${path}.requestKey: violates the §5.3 rule 2 character rule`;
  }
  if (record.scope !== "task") return `${path}.scope: not "task" (§4 rule 2)`;
  if (!AMENDMENT_SOURCES.includes(record.source as VerificationAmendmentSource)) {
    return `${path}.source: unrecognized source`;
  }
  if (!AMENDMENT_CONTINUATIONS.includes(record.continuation as VerificationAmendmentContinuation)) {
    return `${path}.continuation: unrecognized continuation`;
  }
  // §10 rule 6: `issueBodyDigest` iff the revision came from a refresh.
  if (record.source === "issue-refresh") {
    const problem = digestProblem(record.issueBodyDigest, `${path}.issueBodyDigest`);
    if (problem) return problem;
  } else if (record.issueBodyDigest !== undefined) {
    return `${path}.issueBodyDigest: only an issue-refresh revision carries one`;
  }
  return (
    actorProblem(record.actor, `${path}.actor`) ??
    reasonProblem(record.reason, path) ??
    operationsProblem(record.operations, `${path}.operations`) ??
    digestProblem(record.basePlanDigest, `${path}.basePlanDigest`) ??
    digestProblem(record.planDigest, `${path}.planDigest`) ??
    digestProblem(record.sessionBaselineDigest, `${path}.sessionBaselineDigest`)
  );
}

function storedRevisionProblem(value: unknown, path: string): string | undefined {
  if (!isPlainObject(value)) return `${path}: not an object`;
  if (!Number.isSafeInteger(value.revisionOrdinal) || (value.revisionOrdinal as number) < 1) {
    return `${path}.revisionOrdinal: not a positive integer`;
  }
  if (!Number.isSafeInteger(value.observedTaskRevision) || (value.observedTaskRevision as number) < 0) {
    return `${path}.observedTaskRevision: not a non-negative integer`;
  }
  return (
    timestampProblem(value.createdAt, `${path}.createdAt`) ?? revisionCoreProblem(value, path)
  );
}

function sessionBaselineProblem(value: unknown, path: string): string | undefined {
  if (!Array.isArray(value)) return `${path}: not an array`;
  if (value.length > MAX_VERIFICATION_SESSION_BASELINE_ENTRIES) {
    return `${path}: exceeds ${MAX_VERIFICATION_SESSION_BASELINE_ENTRIES} entries`;
  }
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (!isPlainObject(entry)) return `${path}[${i}]: not an object`;
    if (typeof entry.name !== "string" || entry.name.length === 0) {
      return `${path}[${i}].name: empty`;
    }
    if (entry.name.length > MAX_VERIFICATION_AMENDMENT_NAME_CHARS) {
      return `${path}[${i}].name: exceeds ${MAX_VERIFICATION_AMENDMENT_NAME_CHARS} chars`;
    }
    if (typeof entry.command !== "string") return `${path}[${i}].command: not a string`;
    if (entry.command.length > MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS) {
      return `${path}[${i}].command: exceeds ${MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS} chars`;
    }
  }
  return undefined;
}

function checkpointProblem(value: unknown, path: string): string | undefined {
  if (!isPlainObject(value)) return `${path}: not an object`;
  const shape =
    digestProblem(value.planDigest, `${path}.planDigest`) ??
    sessionBaselineProblem(value.sessionBaseline, `${path}.sessionBaseline`) ??
    digestProblem(value.sessionBaselineDigest, `${path}.sessionBaselineDigest`) ??
    timestampProblem(value.updatedAt, `${path}.updatedAt`);
  if (shape) return shape;
  if (!Number.isSafeInteger(value.appliedThroughOrdinal) || (value.appliedThroughOrdinal as number) < 1) {
    return `${path}.appliedThroughOrdinal: not a positive integer`;
  }
  if (value.updatedBy !== "revision" && value.updatedBy !== "rebase") {
    return `${path}.updatedBy: not "revision" | "rebase"`;
  }
  // The recorded digest must cover the recorded baseline: the baseline exists
  // for the §6.4 drift test, which is a digest comparison, so a pair that
  // disagrees internally is unusable — corruption, not drift.
  const derived = deriveSessionBaselineDigest(
    value.sessionBaseline as readonly VerificationPlanSessionBaselineEntry[],
  );
  if (derived !== value.sessionBaselineDigest) {
    return `${path}.sessionBaselineDigest: does not cover the recorded sessionBaseline`;
  }
  return undefined;
}

export type VerificationAmendmentStateValidation =
  | { valid: true; state: VerificationAmendmentState | undefined }
  | { valid: false; detail: string };

/**
 * Validate the stored block under {@link VERIFICATION_AMENDMENTS_CONTEXT_KEY}.
 *
 * Absence is the pre-first-revision default and is valid (§5.5 rule 5): a
 * legacy task, or one never amended, reads as `state: undefined` and keeps
 * its shipped behavior. Everything else fails CLOSED per §5.5 — a chain that
 * does not parse, an ordinal gap, a duplicate `requestKey` or `revisionId`, a
 * chain with no checkpoint beside it, or a checkpoint whose
 * `appliedThroughOrdinal` differs from the chain's highest ordinal is
 * refused, never coerced to a default, never silently repaired, and never
 * overwritten. Validation details name field paths only — never command
 * bytes or operator prose.
 */
export function validateVerificationAmendmentState(
  value: unknown,
): VerificationAmendmentStateValidation {
  const path = VERIFICATION_AMENDMENTS_CONTEXT_KEY;
  if (value === undefined) return { valid: true, state: undefined };
  if (!isPlainObject(value)) return { valid: false, detail: `${path}: not an object` };

  const revisions = value.revisions;
  if (!Array.isArray(revisions)) return { valid: false, detail: `${path}.revisions: not an array` };
  if (revisions.length === 0) {
    // The block comes into existence with the first revision; an empty chain
    // means a write landed half applied.
    return { valid: false, detail: `${path}.revisions: empty — the block exists only with a first revision` };
  }
  if (revisions.length > MAX_VERIFICATION_AMENDMENT_REVISIONS) {
    // Issue #1038 bounded-history invariant: no admissible write grows the
    // chain past the cap, so an over-limit stored chain is corruption and
    // fails closed here — before any entry is trusted or iterated — rather
    // than surviving reads until a later apply happens to report chain_full.
    return {
      valid: false,
      detail: `${path}.revisions: ${revisions.length} entries exceeds the ${MAX_VERIFICATION_AMENDMENT_REVISIONS}-revision bound`,
    };
  }
  const requestKeys = new Set<string>();
  const revisionIds = new Set<string>();
  for (let i = 0; i < revisions.length; i += 1) {
    const entryPath = `${path}.revisions[${i}]`;
    const problem = storedRevisionProblem(revisions[i], entryPath);
    if (problem) return { valid: false, detail: problem };
    const record = revisions[i] as unknown as VerificationAmendmentRevision;
    // §5.5: stored in ascending ordinal, contiguous from 1 — a gap fails closed.
    if (record.revisionOrdinal !== i + 1) {
      return { valid: false, detail: `${entryPath}.revisionOrdinal: expected ${i + 1}, found ${record.revisionOrdinal}` };
    }
    if (requestKeys.has(record.requestKey)) {
      return { valid: false, detail: `${entryPath}.requestKey: duplicate — a requestKey is unique per task row (§5.3 rule 1)` };
    }
    requestKeys.add(record.requestKey);
    if (revisionIds.has(record.revisionId)) {
      return { valid: false, detail: `${entryPath}.revisionId: duplicate` };
    }
    revisionIds.add(record.revisionId);
  }

  if (value.checkpoint === undefined) {
    return { valid: false, detail: `${path}.checkpoint: absent beside a revision chain (§5.5)` };
  }
  const checkpointIssue = checkpointProblem(value.checkpoint, `${path}.checkpoint`);
  if (checkpointIssue) return { valid: false, detail: checkpointIssue };
  const checkpoint = value.checkpoint as unknown as VerificationPlanCheckpoint;
  if (checkpoint.appliedThroughOrdinal !== revisions.length) {
    return {
      valid: false,
      detail: `${path}.checkpoint.appliedThroughOrdinal: ${checkpoint.appliedThroughOrdinal} differs from the chain's highest ordinal ${revisions.length} (§5.5)`,
    };
  }
  // §5.5 rule 3: a checkpoint landed by a revision carries THAT revision's
  // planDigest — the final one's, since `appliedThroughOrdinal` matches the
  // chain head. Only a rebase may move the checkpoint digest away from the
  // chain, so a divergence under `updatedBy: "revision"` is a partial or
  // tampered apply and fails closed like any other §5.5 violation.
  const finalRevision = revisions[revisions.length - 1] as unknown as VerificationAmendmentRevision;
  if (checkpoint.updatedBy === "revision" && checkpoint.planDigest !== finalRevision.planDigest) {
    return {
      valid: false,
      detail: `${path}.checkpoint.planDigest: differs from the final revision's planDigest under updatedBy "revision" (§5.5 rule 3)`,
    };
  }

  return {
    valid: true,
    state: {
      revisions: revisions as unknown as readonly VerificationAmendmentRevision[],
      checkpoint,
    },
  };
}

/**
 * The store surface these operations need — the shipped port methods only
 * (§5.5: "no new store method is required"; the write is an ordinary CAS on
 * `AiTask.revision` through `completePhaseWithEffects`, which lands the
 * context patch and the audit event in one transaction on both backends).
 */
export type VerificationAmendmentStore = Pick<TaskStore, "getTask" | "completePhaseWithEffects">;

export type VerificationAmendmentStateRead =
  | { status: "ok"; task: AiTask; state: VerificationAmendmentState | undefined }
  | { status: "not_found" }
  | { status: "malformed"; detail: string };

/** Read one task's revision chain and checkpoint; fails closed on malformed state. */
export async function readVerificationAmendmentState(
  store: Pick<TaskStore, "getTask">,
  key: TaskKey,
): Promise<VerificationAmendmentStateRead> {
  const task = await store.getTask(key);
  if (!task) return { status: "not_found" };
  const validation = validateVerificationAmendmentState(
    task.context?.[VERIFICATION_AMENDMENTS_CONTEXT_KEY],
  );
  if (!validation.valid) return { status: "malformed", detail: validation.detail };
  return { status: "ok", task, state: validation.state };
}

/**
 * The caller-computed fields of one revision. The write assigns
 * `revisionOrdinal`, `createdAt`, and `observedTaskRevision`; the derivations
 * of `revisionId`/`requestKey` and every digest belong to the authoring
 * surface (later slices) and are validated here by form only.
 */
export interface VerificationAmendmentRevisionInput {
  revisionId: string;
  requestKey: string;
  source: VerificationAmendmentSource;
  actor: VerificationAmendmentActor;
  reason: string;
  operations: readonly VerificationAmendmentOperation[];
  basePlanDigest: string;
  planDigest: string;
  sessionBaselineDigest: string;
  continuation: VerificationAmendmentContinuation;
  issueBodyDigest?: string;
}

/**
 * The checkpoint values the write lands (§5.5 rule 3): the applying surface's
 * `session.verification` snapshot and its digest. `appliedThroughOrdinal`,
 * `updatedAt`, and `updatedBy` are assigned by the write.
 */
export interface VerificationPlanCheckpointInput {
  planDigest: string;
  sessionBaseline: readonly VerificationPlanSessionBaselineEntry[];
  sessionBaselineDigest: string;
}

/**
 * §12.1: the applied event carries the counts of active and retired slots per
 * layer. Counting requires the resolved plan, which only the applying surface
 * holds — resolution is out of this slice — so the counts are an input.
 */
export interface VerificationPlanSlotCounts {
  execution: { active: number; retired: number };
  requirement: { active: number; retired: number };
}

export interface ApplyVerificationAmendmentInput {
  store: VerificationAmendmentStore;
  key: TaskKey;
  /**
   * The `AiTask.revision` the invocation read its plan at. The CAS guard: a
   * task that moved since — any transition, any competing amendment — refuses
   * stale with nothing written (§7.3 rule 1).
   */
  observedTaskRevision: number;
  revision: VerificationAmendmentRevisionInput;
  checkpoint: VerificationPlanCheckpointInput;
  slotCounts: VerificationPlanSlotCounts;
  /**
   * §8.3 rule 1: the pre-revision EFFECTIVE bytes of the requirement slots
   * this revision touches, keyed by §5.1 `commandId`. Required for every
   * requirement-layer `replace` the revision carries — the write refuses
   * `invalid_input` when a replaced slot's bytes are missing — because the
   * evidence those bytes admitted must be invalidated in the SAME CAS that
   * persists the replacement. The byte mismatch alone only hides the old
   * evidence: the §6.2 rule 3 evaluator matches by content and deliberately
   * ignores plan-digest equality, so a later revision restoring the old bytes
   * would re-admit a superseded pass without a rerun.
   */
  baseRequirementCommands?: Readonly<Record<string, string>>;
  /**
   * The task's resolved session (issue #1043 review). A routing revision
   * re-queues a task whose Issue may still carry the labels of the park it
   * corrects — most critically the success-only stack-ready marker applied by
   * the passing review, which `dependency-plan.ts` accepts as
   * implementation-complete on its own. When supplied, the re-queue enqueues
   * the stack-ready removal and the lane-label swap for the routed phase
   * (the same `enqueueStatusLabelEffects` rows the shipped `{queued, review}`
   * / `{queued, implementation}` edges produce) atomically with the
   * transition. Optional so non-routing writes need no session; the operator
   * surfaces (§11) always pass it.
   */
  session?: ResolvedSession;
  /**
   * §12.2 (issue #1044): the resulting plan, projected onto the public slot
   * list the amendment comment names. Supplied by the applying surface for the
   * same reason `slotCounts` is — resolution is not this slice's job — and the
   * comment is enqueued through the outbox in the SAME transaction as the
   * revision, so a committed amendment can never lack its public record and a
   * refused one can never post. Requires `session`: without a resolved session
   * there is no work item to address. Delivery, and every retry of it, belongs
   * to the outbox from that point on; a publication failure never rolls back an
   * amendment that is already committed.
   *
   * The same slots project the §12.2 gate summary, so a record-only revision
   * applied to a task parked at the human merge gate also supersedes that PR's
   * stale handoff summary from here (issue #1044 review, P1).
   */
  publication?: { slots: readonly VerificationAmendmentPublicSlot[] };
  runId?: string;
  now?: string;
}

export type VerificationAmendmentRefusalReason =
  | "not_found"
  | "invalid_input"
  | "malformed_state"
  | "task_active"
  | "task_terminal"
  /** §9.2 rule 3: a non-`none` continuation on a row the table parks. */
  | "continuation_not_permitted"
  | "chain_full"
  | "store_rejected";

export type ApplyVerificationAmendmentOutcome =
  /** Appended + checkpoint replaced + event, in one transaction. */
  | {
      status: "applied";
      task: AiTask;
      revision: VerificationAmendmentRevision;
      checkpoint: VerificationPlanCheckpoint;
      event: TaskEvent;
    }
  /**
   * §5.3 rule 3: the requestKey already names an applied revision. Nothing
   * was written, no ordinal consumed, no event appended; the stored revision
   * is reported. A repeat, not a refusal.
   */
  | { status: "replay"; revision: VerificationAmendmentRevision; checkpoint: VerificationPlanCheckpoint }
  /**
   * §7.3 rule 2: recoverable and specific — the observed and current task
   * revision and the observed and current plan digest, so the operator can
   * re-read and re-issue. Nothing was written.
   */
  | {
      status: "stale";
      observedTaskRevision: number;
      currentTaskRevision?: number;
      observedPlanDigest: string;
      currentPlanDigest?: string;
      current?: AiTask;
    }
  | {
      status: "refused";
      reason: VerificationAmendmentRefusalReason;
      detail: string;
      taskStatus?: TaskStatus;
      ownerRunId?: string;
    }
  /** Retryable whole-file maintenance contention (issue #818); nothing wrong with the task. */
  | { status: "maintenance_locked" };

/** §7.1: the statuses on which amendment is permitted — a closed set. */
const AMENDABLE_STATUSES: readonly TaskStatus[] = ["queued", "blocked", "ready_for_human"];

/**
 * §9.2: whether the task's row permits a post-amendment re-queue at all. Only
 * the two review-lane parks do — `ready_for_human`/`review` (the Step 4.5
 * missing-command handoff) and `blocked`/`review`. A `queued` task and a park
 * outside `review` are `Recorded only` rows: the amendment lands, and the task
 * stays where the surface that owns it put it (§9.2 rule 3 — no continuation
 * unparks a task the table keeps parked). This predicate is the single copy of
 * that row test; `defaultVerificationContinuation` and the apply-time guard
 * both read it, so the reported default and the enforced route cannot drift.
 */
export function verificationContinuationRequeueRow(
  task: Pick<AiTask, "status" | "phase">,
): boolean {
  return (task.status === "ready_for_human" || task.status === "blocked") && task.phase === "review";
}

/**
 * The stale review-park state a §9.2 re-queue invalidates (issue #1043): the
 * recorded missing-command list (whose repeat is exactly the loop the
 * amendment exists to break), the per-command status snapshot, and the
 * evidence-binding block the escalation recorded against the pre-amendment
 * plan. All three are derived state a fresh review run recomputes from the
 * amended plan. `manualVerificationEvidence` is deliberately NOT here: no
 * amendment deletes evidence (§8.1) — preserved entries are re-judged per slot
 * by the binding rule at consumption, so only still-valid evidence satisfies
 * the corrected plan (entries a requirement-layer `replace` supersedes carry
 * the §8.3 rule 1 invalidation record instead, appended by the apply itself).
 * `reviewCycles`/`reviewLoopCapReached` are not here
 * either: the review-loop caps are owned by the review lane and a re-queue
 * neither spends nor refunds them.
 */
export const VERIFICATION_CONTINUATION_CLEARED_CONTEXT_KEYS: readonly string[] = [
  "missingVerificationCommands",
  "issueRequiredVerifications",
  VERIFICATION_EVIDENCE_BINDING_CONTEXT_KEY,
];

/**
 * The §7.1 status test, as a value. `applyVerificationAmendmentRevision`
 * re-evaluates it inside its own transaction — that is the authoritative guard
 * (§7.3 rule 1) — but a caller that can write, or report success, BEFORE
 * reaching it needs the same answer first (§10 rule 7's no-difference exit and
 * §6.4 rule 5's checkpoint rebase are both such callers). Exported so those
 * paths refuse on exactly the same statuses with exactly the same message,
 * rather than growing a second, drifting copy of the table.
 *
 * Returns `undefined` when the status is amendable.
 */
export function verificationAmendmentStatusRefusal(task: {
  status: TaskStatus;
  ownerRunId?: string | undefined;
}): { reason: "task_active" | "task_terminal"; detail: string; taskStatus: TaskStatus; ownerRunId?: string } | undefined {
  if (task.status === "claimed" || task.status === "running") {
    const owner = task.ownerRunId ? ` (ownerRunId ${task.ownerRunId})` : "";
    return {
      reason: "task_active",
      detail: `task is ${task.status}${owner}; an owner holds a resolved plan — retry after the run completes, or recover a run that will never finish`,
      taskStatus: task.status,
      ...(task.ownerRunId !== undefined ? { ownerRunId: task.ownerRunId } : {}),
    };
  }
  if (!AMENDABLE_STATUSES.includes(task.status)) {
    // §7.2 rule 5: `done`/`failed`/`cancelled` refuse because the task is
    // FINISHED, with a message distinguishable from the active-task one, and
    // the closed permitted set means any status this table never admitted
    // fails closed the same way rather than falling through.
    return {
      reason: "task_terminal",
      detail: `task is terminal (${task.status}); reactivate it through the shipped recovery surface first, then amend`,
      taskStatus: task.status,
    };
  }
  return undefined;
}

function amendmentInputProblem(input: ApplyVerificationAmendmentInput): string | undefined {
  // A caller-supplied write timestamp must satisfy the same rule the
  // stored-record validator applies on read — otherwise this write would
  // persist a record that every subsequent read classifies as malformed,
  // blocking all further amendments.
  if (input.now !== undefined) {
    const nowIssue = timestampProblem(input.now, "now");
    if (nowIssue) return nowIssue;
  }
  if (!Number.isSafeInteger(input.observedTaskRevision) || input.observedTaskRevision < 0) {
    return "observedTaskRevision: not a non-negative integer";
  }
  // The input deliberately omits the write-assigned fields; `scope` is fixed
  // at `"task"` (§4 rule 2) so the shared validator sees the stored shape.
  const revision = revisionCoreProblem(
    { ...(input.revision as unknown as Record<string, unknown>), scope: "task" },
    "revision",
  );
  if (revision) return revision;
  // §8.3 rule 1: a requirement-layer `replace` cannot land without the
  // superseded slot's pre-replace bytes — without them the evidence those
  // bytes admitted cannot be invalidated in the same CAS, and a later
  // revision restoring the old bytes would re-admit the superseded pass.
  // A slot a preceding `add` in the SAME revision introduced has no
  // pre-revision bytes to demand: sequential composition (§5.3 rule 7)
  // makes add-then-replace a valid revision, and the add itself supplies
  // the superseded bytes.
  for (let index = 0; index < input.revision.operations.length; index += 1) {
    const operation = input.revision.operations[index];
    if (operation.kind !== "replace" || commandIdLayer(operation.commandId) !== "requirement") continue;
    if (supersededRequirementCommand(input.revision.operations, index, input.baseRequirementCommands) === undefined) {
      return `baseRequirementCommands: missing the pre-revision bytes of replaced requirement slot ${operation.commandId} (§8.3 rule 1)`;
    }
  }
  const checkpoint = checkpointInputProblem(input.checkpoint);
  if (checkpoint) return checkpoint;
  // §5.5 rule 3: the checkpoint an applied revision lands carries THAT
  // revision's planDigest — there is no admissible divergence. (The baseline
  // digests MAY differ: a plan-neutral session drift rebased in the same flow
  // leaves the revision authored over the old baseline while the checkpoint
  // snapshots the live one.)
  if (input.checkpoint.planDigest !== input.revision.planDigest) {
    return "checkpoint.planDigest: differs from revision.planDigest (§5.5 rule 3)";
  }
  return slotCountsProblem(input.slotCounts);
}

function checkpointInputProblem(input: VerificationPlanCheckpointInput): string | undefined {
  const shape =
    digestProblem(input.planDigest, "checkpoint.planDigest") ??
    sessionBaselineProblem(input.sessionBaseline, "checkpoint.sessionBaseline") ??
    digestProblem(input.sessionBaselineDigest, "checkpoint.sessionBaselineDigest");
  if (shape) return shape;
  if (deriveSessionBaselineDigest(input.sessionBaseline) !== input.sessionBaselineDigest) {
    return "checkpoint.sessionBaselineDigest: does not cover checkpoint.sessionBaseline (§6.4 rule 1)";
  }
  return undefined;
}

function slotCountsProblem(counts: VerificationPlanSlotCounts): string | undefined {
  for (const layer of ["execution", "requirement"] as const) {
    for (const state of ["active", "retired"] as const) {
      const count = counts?.[layer]?.[state];
      if (!Number.isSafeInteger(count) || count < 0) {
        return `slotCounts.${layer}.${state}: not a non-negative integer`;
      }
    }
  }
  return undefined;
}

function commandIdLayer(commandId: string): VerificationAmendmentLayer {
  return commandId.startsWith("exec:") ? "execution" : "requirement";
}

/**
 * §8.3 rule 1 under sequential composition (§5.3 rule 7): the bytes a
 * requirement-layer `replace` at `replaceIndex` supersedes. A slot that
 * existed before the revision supersedes its caller-supplied pre-revision
 * bytes; a slot a preceding `add` in the SAME revision introduced supersedes
 * that add's bytes — the only durable form evidence could have matched, since
 * no intermediate state of one atomic revision is observable outside it.
 * Returns `undefined` only when neither source names the target — the §8.3
 * rule 1 refusal case.
 */
function supersededRequirementCommand(
  operations: readonly VerificationAmendmentOperation[],
  replaceIndex: number,
  baseRequirementCommands: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const operation = operations[replaceIndex];
  if (operation.kind !== "replace") return undefined;
  const preRevision = baseRequirementCommands?.[operation.commandId];
  if (typeof preRevision === "string") return preRevision;
  for (let index = replaceIndex - 1; index >= 0; index -= 1) {
    const preceding = operations[index];
    if (
      preceding.kind === "add" &&
      preceding.layer === "requirement" &&
      deriveRequirementCommandId(preceding.command) === operation.commandId
    ) {
      return preceding.command;
    }
  }
  return undefined;
}

/**
 * §8.3 rules 1–3: append the per-slot invalidation record to every passing
 * manual evidence entry a requirement-layer `replace` supersedes, preserving
 * each entry byte for byte otherwise (§8.1 — nothing is deleted, nothing is
 * rewritten, the list is append-only).
 *
 * An entry is superseded for slot S when it could have satisfied S before the
 * replacement: it passed (`exitCode === 0`) and either its command matches S's
 * pre-replacement bytes under the gate's own `matchesConfiguredVerificationCommand`
 * rule (§6.2 rule 3), or its issue-#1040 binding names S's `commandId`
 * directly (evidence recorded under a resolver-equivalent form). An entry
 * already invalidated for S keeps its earlier record untouched (§8.3 rule 3),
 * and an entry whose `invalidations` value is malformed is left alone — the
 * fail-closed reader already refuses it for every slot, and §8.1 forbids
 * rewriting what is stored.
 *
 * Returns the stamped array, or `undefined` when no entry needed a record, so
 * a revision with nothing to supersede leaves the context key untouched.
 */
function stampSupersededRequirementEvidence(
  rawEvidence: unknown,
  operations: readonly VerificationAmendmentOperation[],
  baseRequirementCommands: Readonly<Record<string, string>> | undefined,
  revisionId: string,
): unknown[] | undefined {
  if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) return undefined;
  // One record per slot per entry (§8.3 rule 3): dedupe the revision's
  // replace targets by commandId before matching.
  const superseded = new Map<string, string>();
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation.kind !== "replace" || commandIdLayer(operation.commandId) !== "requirement") continue;
    const previous = supersededRequirementCommand(operations, index, baseRequirementCommands);
    if (previous !== undefined && !superseded.has(operation.commandId)) {
      superseded.set(operation.commandId, previous);
    }
  }
  if (superseded.size === 0) return undefined;
  let stampedAny = false;
  const stamped = rawEvidence.map((entry): unknown => {
    if (typeof entry !== "object" || entry === null) return entry;
    const record = entry as {
      command?: unknown;
      exitCode?: unknown;
      commandId?: unknown;
      invalidations?: unknown;
    };
    if (typeof record.command !== "string" || record.exitCode !== 0) return entry;
    if (record.invalidations !== undefined && !Array.isArray(record.invalidations)) return entry;
    const additions: { commandId: string; supersededByRevision: string }[] = [];
    for (const [commandId, previousCommand] of superseded) {
      if (isVerificationSlotInvalidated(record.invalidations, commandId)) continue;
      if (
        !matchesConfiguredVerificationCommand(record.command, previousCommand) &&
        record.commandId !== commandId
      ) {
        continue;
      }
      additions.push({ commandId, supersededByRevision: revisionId });
    }
    if (additions.length === 0) return entry;
    stampedAny = true;
    const existing = Array.isArray(record.invalidations) ? record.invalidations : [];
    return { ...record, invalidations: [...existing, ...additions] };
  });
  return stampedAny ? stamped : undefined;
}

/**
 * §12.1: the event names every operation by kind, `commandId`, and layer —
 * and carries no command bytes, no reasons, no operator prose. An `add`
 * carries no `commandId` of its own, so the identity is derived here (§5.1).
 */
function operationEventEntries(
  operations: readonly VerificationAmendmentOperation[],
): Array<{ kind: string; commandId: string; layer: VerificationAmendmentLayer }> {
  return operations.map((operation) => {
    if (operation.kind === "add") {
      const commandId =
        operation.layer === "execution"
          ? deriveExecutionCommandId(operation.name)
          : deriveRequirementCommandId(operation.command);
      return { kind: operation.kind, commandId, layer: operation.layer };
    }
    return {
      kind: operation.kind,
      commandId: operation.commandId,
      layer: commandIdLayer(operation.commandId),
    };
  });
}

function copySessionBaseline(
  entries: readonly VerificationPlanSessionBaselineEntry[],
): VerificationPlanSessionBaselineEntry[] {
  // Field-by-field so no unvalidated extra caller field reaches the row.
  return entries.map((entry) => ({ name: entry.name, command: entry.command }));
}

/**
 * Apply one amendment revision atomically (§5.3 rule 7, §5.5 rule 3, §7).
 *
 * Order of checks, and why it is normative:
 * 1. input validation — a structurally invalid revision writes nothing;
 * 2. malformed stored state fails closed, never repaired (§5.5);
 * 3. replay recognition on `requestKey` BEFORE any plan or staleness
 *    comparison (§5.3 rules 1/3), so a lost-response retry is a replay even
 *    when its own first attempt already moved the plan — and even when the
 *    task has since been claimed — then a `revisionId` already applied under
 *    a DIFFERENT requestKey refuses (§5.3 rule 1: the write-side mirror of
 *    the read validator's duplicate-id check);
 * 4. the §7.1 status table — `claimed`/`running` refuse unconditionally (an
 *    owner holds a resolved plan in memory), terminal statuses refuse with a
 *    distinguishable message naming the recovery surface;
 * 5. the §9.2 continuation row (issue #1043) — a routing revision on a row
 *    the table parks refuses whole, or reports `stale` when the row moved
 *    since the caller's read;
 * 6. the bounded-chain refusal (issue #1038: no unbounded history);
 * 7. the base-plan link — a revision authored against a plan the checkpoint
 *    no longer shows is stale (§7.3 rule 2), named by both digests;
 * 8. one `completePhaseWithEffects` call carrying the context patch — the
 *    amended chain plus the §8.3 rule 1 evidence invalidation a
 *    requirement-layer `replace` requires — plus, for a routing revision, the
 *    `{queued, <continuation>}` re-queue, the stale-park-state invalidation
 *    (§9.2 rule 2), and the label effects of the routed edge (stack-ready
 *    removal and lane swap, when the session is supplied) — and the §12.1
 *    event, CAS-guarded on `AiTask.revision` with the observed status
 *    re-checked inside the same transaction (§7.3 rule 1). A refused CAS
 *    leaves no partial write — no revision, no ordinal consumed, no event,
 *    no re-queue, no effect.
 */
export async function applyVerificationAmendmentRevision(
  input: ApplyVerificationAmendmentInput,
): Promise<ApplyVerificationAmendmentOutcome> {
  const now = input.now ?? new Date().toISOString();

  const inputIssue = amendmentInputProblem(input);
  if (inputIssue) return { status: "refused", reason: "invalid_input", detail: inputIssue };

  const task = await input.store.getTask(input.key);
  if (!task) {
    return {
      status: "refused",
      reason: "not_found",
      detail: `no task for ${input.key.sessionId}#${input.key.issueNumber}`,
    };
  }

  const stored = validateVerificationAmendmentState(
    task.context?.[VERIFICATION_AMENDMENTS_CONTEXT_KEY],
  );
  if (!stored.valid) {
    return { status: "refused", reason: "malformed_state", detail: stored.detail };
  }
  const state = stored.state;

  const replayed = state?.revisions.find(
    (revision) => revision.requestKey === input.revision.requestKey,
  );
  if (replayed && state) {
    return { status: "replay", revision: replayed, checkpoint: state.checkpoint };
  }

  // Write-side mirror of the read validator's duplicate-ID check: §5.3 rule 1
  // derives a distinct `revisionId` from every distinct requestKey, so an
  // input reusing an applied revision's id under a new requestKey is a caller
  // derivation error. Committing it would persist a chain every subsequent
  // read classifies as malformed, refusing all further amendments.
  const collided = state?.revisions.find(
    (revision) => revision.revisionId === input.revision.revisionId,
  );
  if (collided) {
    return {
      status: "refused",
      reason: "invalid_input",
      detail: `revision.revisionId: duplicate — already names applied revision ordinal ${collided.revisionOrdinal} under a different requestKey (§5.3 rule 1)`,
    };
  }

  const inadmissible = verificationAmendmentStatusRefusal(task);
  if (inadmissible) {
    return { status: "refused", ...inadmissible };
  }

  // §9.2 rules 2–3 (issue #1043): a routing revision is admitted only on a row
  // the continuation table re-queues. The check runs against THIS function's
  // own task read, and the CAS below pins that read — so a row that moved
  // after the caller derived its continuation is reported `stale` (the
  // recoverable truth) rather than as a table violation, and a row that never
  // permitted the route refuses with nothing written.
  if (input.revision.continuation !== "none" && !verificationContinuationRequeueRow(task)) {
    if (task.revision !== input.observedTaskRevision) {
      return {
        status: "stale",
        observedTaskRevision: input.observedTaskRevision,
        currentTaskRevision: task.revision,
        observedPlanDigest: input.revision.basePlanDigest,
        ...(state !== undefined ? { currentPlanDigest: state.checkpoint.planDigest } : {}),
        current: task,
      };
    }
    return {
      status: "refused",
      reason: "continuation_not_permitted",
      detail:
        `continuation "${input.revision.continuation}" is not permitted for a ` +
        `${task.status}/${task.phase} task: the §9.2 row for it parks the task, and no ` +
        `continuation unparks it (§9.2 rule 3)`,
    };
  }

  if ((state?.revisions.length ?? 0) >= MAX_VERIFICATION_AMENDMENT_REVISIONS) {
    return {
      status: "refused",
      reason: "chain_full",
      detail: `revision chain already carries ${MAX_VERIFICATION_AMENDMENT_REVISIONS} revisions`,
    };
  }

  if (state && input.revision.basePlanDigest !== state.checkpoint.planDigest) {
    return {
      status: "stale",
      observedTaskRevision: input.observedTaskRevision,
      currentTaskRevision: task.revision,
      observedPlanDigest: input.revision.basePlanDigest,
      currentPlanDigest: state.checkpoint.planDigest,
      current: task,
    };
  }

  const revisionOrdinal = (state?.revisions.length ?? 0) + 1;
  const revision: VerificationAmendmentRevision = {
    revisionId: input.revision.revisionId,
    revisionOrdinal,
    requestKey: input.revision.requestKey,
    scope: "task",
    source: input.revision.source,
    actor: { kind: "operator", id: input.revision.actor.id },
    reason: input.revision.reason,
    operations: input.revision.operations.map((operation) => ({ ...operation })),
    basePlanDigest: input.revision.basePlanDigest,
    planDigest: input.revision.planDigest,
    sessionBaselineDigest: input.revision.sessionBaselineDigest,
    continuation: input.revision.continuation,
    createdAt: now,
    observedTaskRevision: input.observedTaskRevision,
    ...(input.revision.issueBodyDigest !== undefined
      ? { issueBodyDigest: input.revision.issueBodyDigest }
      : {}),
  };
  const checkpoint: VerificationPlanCheckpoint = {
    planDigest: input.checkpoint.planDigest,
    sessionBaseline: copySessionBaseline(input.checkpoint.sessionBaseline),
    sessionBaselineDigest: input.checkpoint.sessionBaselineDigest,
    appliedThroughOrdinal: revisionOrdinal,
    updatedAt: now,
    updatedBy: "revision",
  };
  const nextState: VerificationAmendmentState = {
    revisions: [...(state?.revisions ?? []), revision],
    checkpoint,
  };

  const event: TaskEvent = {
    task: input.key,
    type: VERIFICATION_AMENDMENT_APPLIED_EVENT,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    // §12.1: names, identities, digests, and counts only — no command bytes,
    // no reasons, no output. The bytes live in the durable revision record.
    data: {
      revisionId: revision.revisionId,
      revisionOrdinal: revision.revisionOrdinal,
      scope: revision.scope,
      source: revision.source,
      actorId: revision.actor.id,
      operations: operationEventEntries(revision.operations),
      basePlanDigest: revision.basePlanDigest,
      planDigest: revision.planDigest,
      slotCounts: {
        execution: { ...input.slotCounts.execution },
        requirement: { ...input.slotCounts.requirement },
      },
      continuation: revision.continuation,
    },
    createdAt: now,
  };

  // §9.2 rule 2 (issue #1043): the re-queue rides the SAME transaction as the
  // plan persist — the amended chain, the checkpoint, the status/phase move,
  // and the stale-park-state invalidation commit together or not at all, so a
  // claim can never observe a re-queued task with a stale plan, and a crash
  // can never leave the amendment landed but the task still parked.
  const continuation = input.revision.continuation;
  const routedPhase: TaskPhase | undefined =
    continuation === "review" ? "review" : continuation === "implementation" ? "implementation" : undefined;
  const clearedParkState: Record<string, undefined> = {};
  if (routedPhase !== undefined) {
    for (const contextKey of VERIFICATION_CONTINUATION_CLEARED_CONTEXT_KEYS) {
      clearedParkState[contextKey] = undefined;
    }
  }

  // §8.3 rules 1–3: the replacement and the invalidation of the evidence it
  // supersedes are one write. The entries are preserved — the record is
  // appended, never substituted for them (§8.1) — and stamping from THIS
  // function's own task read keeps the marks coherent with the CAS below: a
  // row that moved since refuses the whole write, marks included.
  const supersededEvidence = stampSupersededRequirementEvidence(
    task.context?.["manualVerificationEvidence"],
    revision.operations,
    input.baseRequirementCommands,
    revision.revisionId,
  );

  // Issue #1043 review: a routed re-queue leaves a row whose Issue may still
  // carry the labels of the park it corrects — most critically the
  // success-only stack-ready marker a passing review applied, which
  // `dependency-plan.ts` accepts as implementation-complete on its own. The
  // removal and the lane-label swap for the routed phase ride the SAME
  // transaction as the transition, exactly as a phase completion's effects do
  // (issue #701): a marker removal enqueued as a separate best-effort write
  // could crash into a queued task whose PR still advertises stack-ready,
  // letting dependents branch from it while its amended verification is
  // pending. The rows are the shipped `enqueueStatusLabelEffects` ones, so
  // this edge and the runner's own `{queued, <phase>}` edges cannot drift.
  const collector = new OutboxEffectCollector();
  if (routedPhase !== undefined && input.session !== undefined) {
    await enqueueStatusLabelEffects(
      collector,
      input.session,
      task,
      "queued",
      routedPhase,
      input.runId ?? revision.revisionId,
      now,
      task.phase,
    );
    // Issue #1043 review (P2): `queued` has no coarse-label entry, so the
    // shared helper's removals on this edge are the review-lane markers only
    // (stack-ready, ready-for-human) — a `blocked/review` park's coarse
    // `blocked` label would survive the re-queue, and no later
    // `{queued, <phase>}` runner edge removes it either, leaving the work item
    // advertising blocked and queued at once indefinitely. Retract it on the
    // same collector so the removal rides the SAME transaction as the
    // transition, routed through `workItemOutbox` exactly as the helper's own
    // rows are so a non-GitHub provider sees its `workitem:transition` form.
    if (task.status === "blocked") {
      const blockedLabel = input.session.labels.blocked;
      await workItemOutbox(collector, input.session).enqueue({
        idempotencyKey: makeOutboxKey(
          input.session.sessionId,
          task.issueNumber,
          input.runId ?? revision.revisionId,
          "gh:label:remove",
          blockedLabel,
        ),
        topic: "gh:label:remove",
        payload: {
          topic: "gh:label:remove",
          owner: input.session.githubOwner,
          repo: input.session.githubName,
          issueNumber: task.issueNumber,
          label: blockedLabel,
        },
        now,
      });
    }
  }

  // §12.2 (issue #1044): one comment per APPLIED revision, on the work item,
  // keyed on `revisionId` and on no run identifier. It rides this same
  // transaction — a revision that commits without its public record would be
  // exactly the silent plan change the contract exists to prevent — and every
  // path that returns before the write (a refusal, a replay, a lost CAS) posts
  // nothing, because the effect never reaches the store. Routed through
  // `workItemOutbox` so a non-GitHub work-item provider receives its own
  // `workitem:comment` form rather than a `gh:comment` its runner cannot send.
  if (input.publication !== undefined && input.session !== undefined) {
    const idempotencyKey = verificationAmendmentCommentIdempotencyKey({
      sessionId: input.session.sessionId,
      issueNumber: task.issueNumber,
      revisionId: revision.revisionId,
    });
    const marker = verificationAmendmentCommentMarker(idempotencyKey);
    const body = renderVerificationAmendmentComment(
      buildVerificationAmendmentComment({ revision, slots: input.publication.slots }),
      marker,
    );
    await workItemOutbox(collector, input.session).enqueue({
      idempotencyKey,
      topic: "gh:comment",
      payload: {
        topic: "gh:comment",
        owner: input.session.githubOwner,
        repo: input.session.githubName,
        issueNumber: task.issueNumber,
        // §11 rule 7 / §12.2: a requirement command is Issue text and can name a
        // local path, so the rendered body goes through the same redaction the
        // operator surface's own output does before it is ever published.
        body: sanitizeBody(body, sessionRedactionPaths(input.session)),
        dedupeMarker: marker,
      },
      now,
    });

    // Issue #1044 review (P1): a RECORD-ONLY amendment moves no status, so a
    // task parked at the human merge gate stays parked — and the sticky Human
    // Gate Decision Summary on its PR keeps showing the verification pass of
    // the plan this revision just replaced, omitting whatever it retired. The
    // work-item comment above does not reach that reader: the merge button is on
    // the PR. Supersede the summary in the SAME transaction, so the amendment
    // and the invalidation of the handoff it stales commit together.
    //
    // Only for `routedPhase === undefined`: a routing continuation re-queues the
    // task and swaps its labels, which retracts the handoff outright, and the
    // review it queues renders a fresh summary of the amended plan.
    //
    // And only for a revision that actually MOVED the plan (issue #1044 review,
    // P2). The superseding body's whole claim is that the summary gated on a
    // plan that is no longer the effective one; an `annotate` changes neither
    // bytes, state, nor position (§6.1 step 2), so its revision resolves to the
    // same `planDigest` it based on and the verification result beside the merge
    // button is still a result about the effective plan. Replacing a valid
    // summary with a "not reviewed" notice there would retract a live handoff
    // over a comment. The digest is the exact test — it is the plan's identity
    // (§5.4), so any retire, restore, add or byte-changing replace trips it, and
    // only the net no-ops (an annotate, an operation on an orphaned slot) do not.
    const planMoved = revision.basePlanDigest !== revision.planDigest;
    if (
      planMoved &&
      routedPhase === undefined &&
      task.status === "ready_for_human" &&
      task.phase === "review"
    ) {
      const summary = verificationAmendmentGateSummary(
        nextState,
        input.publication.slots,
        revision.planDigest,
      );
      if (summary !== undefined) {
        await enqueueVerificationAmendmentGateSupersededEffect(
          collector,
          input.session,
          task,
          summary,
          revision.revisionId,
          now,
        );
      }
    }
  }
  const effects: OutboxEffect[] = collector.effects;

  const committed = await input.store.completePhaseWithEffects(
    {
      key: input.key,
      // The CAS: `revision` is the monotonic write counter, so ANY concurrent
      // transition — a claim, a competing amendment — refuses this write in
      // full. Pinning `status` alongside it is the §7.1 re-check evaluated
      // inside the store's transaction rather than on this function's read.
      expected: { status: task.status, revision: input.observedTaskRevision },
      patch: {
        context: {
          [VERIFICATION_AMENDMENTS_CONTEXT_KEY]: nextState,
          ...(supersededEvidence !== undefined
            ? { manualVerificationEvidence: supersededEvidence }
            : {}),
          ...clearedParkState,
        },
        ...(routedPhase !== undefined
          ? {
              status: "queued" as const,
              phase: routedPhase,
              ownerRunId: undefined,
              leaseExpiresAt: undefined,
              lastError: undefined,
            }
          : {}),
        now,
      },
      event,
    },
    effects,
  );
  if (committed.ok) {
    return { status: "applied", task: committed.value, revision, checkpoint, event };
  }
  return mapCommitFailure(committed, input.observedTaskRevision, input.revision);
}

function mapCommitFailure(
  committed: Extract<StoreResult<AiTask>, { ok: false }>,
  observedTaskRevision: number,
  revision: Pick<VerificationAmendmentRevisionInput, "requestKey" | "basePlanDigest">,
): ApplyVerificationAmendmentOutcome {
  if (committed.code === "maintenance_locked") return { status: "maintenance_locked" };
  if (committed.code === "not_found") {
    return { status: "refused", reason: "not_found", detail: "task disappeared before the write" };
  }
  if (committed.code === "conflict") {
    const current = committed.current;
    if (current) {
      // §5.3 rule 3 under a genuine race: if the row this CAS lost to already
      // carries this requestKey — the caller's own first attempt landed — the
      // repeat is a replay, not a stale refusal.
      const currentState = validateVerificationAmendmentState(
        current.context?.[VERIFICATION_AMENDMENTS_CONTEXT_KEY],
      );
      if (currentState.valid && currentState.state) {
        const replayed = currentState.state.revisions.find(
          (entry) => entry.requestKey === revision.requestKey,
        );
        if (replayed) {
          return { status: "replay", revision: replayed, checkpoint: currentState.state.checkpoint };
        }
      }
      return {
        status: "stale",
        observedTaskRevision,
        currentTaskRevision: current.revision,
        observedPlanDigest: revision.basePlanDigest,
        currentPlanDigest: currentState.valid ? currentState.state?.checkpoint.planDigest : undefined,
        current,
      };
    }
    return {
      status: "stale",
      observedTaskRevision,
      observedPlanDigest: revision.basePlanDigest,
    };
  }
  return {
    status: "refused",
    reason: "store_rejected",
    detail: `store refused the write (${committed.code})`,
  };
}

export interface RebaseVerificationPlanCheckpointInput {
  store: VerificationAmendmentStore;
  key: TaskKey;
  /** The `AiTask.revision` the rebasing surface observed. */
  observedTaskRevision: number;
  /** The live values the checkpoint re-anchors to (§6.4 rule 5). */
  checkpoint: VerificationPlanCheckpointInput;
  /**
   * The §6.4 rule 4 dispositions, by `commandId` and never by command bytes:
   * session entries masked by a task-local slot, and slots orphaned by a
   * removed session key.
   */
  dispositions?: { masked?: readonly string[]; orphaned?: readonly string[] };
  runId?: string;
  now?: string;
}

export type RebaseVerificationPlanCheckpointOutcome =
  | { status: "rebased"; task: AiTask; checkpoint: VerificationPlanCheckpoint; event: TaskEvent }
  | { status: "stale"; observedTaskRevision: number; currentTaskRevision?: number; current?: AiTask }
  | {
      status: "refused";
      reason: "not_found" | "invalid_input" | "malformed_state" | "no_chain" | "store_rejected";
      detail: string;
    }
  | { status: "maintenance_locked" };

function dispositionListProblem(
  value: readonly string[] | undefined,
  path: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return `${path}: not an array`;
  if (value.length > MAX_VERIFICATION_SESSION_BASELINE_ENTRIES + MAX_VERIFICATION_AMENDMENT_REVISIONS) {
    return `${path}: unreasonably long`;
  }
  for (let i = 0; i < value.length; i += 1) {
    const problem = commandIdProblem(value[i], `${path}[${i}]`);
    if (problem) return problem;
  }
  return undefined;
}

/**
 * Re-anchor the checkpoint after an observed session-default change (§6.4
 * rule 5). Writes the checkpoint and one `verification.amendment.rebased`
 * event and NOTHING else: no revision is created or rewritten, no ordinal is
 * consumed — `appliedThroughOrdinal` is carried over unchanged. The event is
 * the only history a rebase leaves (§12.1), so it carries both baseline
 * digests, both plan digests, and the dispositions.
 *
 * No §7.1 status gate applies: a rebase is not an amendment, and the contract
 * names the phase runner resolving the plan AT CLAIM TIME as a rebasing
 * surface. The ordinary CAS on `AiTask.revision` is the whole guard.
 */
export async function rebaseVerificationPlanCheckpoint(
  input: RebaseVerificationPlanCheckpointInput,
): Promise<RebaseVerificationPlanCheckpointOutcome> {
  const now = input.now ?? new Date().toISOString();

  // Same rule as the apply path: a stored `updatedAt` that fails the read-side
  // timestamp rule would render the whole block malformed on the next read.
  const inputIssue =
    (input.now !== undefined ? timestampProblem(input.now, "now") : undefined) ??
    checkpointInputProblem(input.checkpoint) ??
    dispositionListProblem(input.dispositions?.masked, "dispositions.masked") ??
    dispositionListProblem(input.dispositions?.orphaned, "dispositions.orphaned");
  if (inputIssue) return { status: "refused", reason: "invalid_input", detail: inputIssue };
  if (!Number.isSafeInteger(input.observedTaskRevision) || input.observedTaskRevision < 0) {
    return { status: "refused", reason: "invalid_input", detail: "observedTaskRevision: not a non-negative integer" };
  }

  const task = await input.store.getTask(input.key);
  if (!task) {
    return {
      status: "refused",
      reason: "not_found",
      detail: `no task for ${input.key.sessionId}#${input.key.issueNumber}`,
    };
  }
  const stored = validateVerificationAmendmentState(
    task.context?.[VERIFICATION_AMENDMENTS_CONTEXT_KEY],
  );
  if (!stored.valid) {
    return { status: "refused", reason: "malformed_state", detail: stored.detail };
  }
  if (!stored.state) {
    // §5.5 rule 5: a task with no revision has no checkpoint and needs none —
    // there is nothing to re-anchor.
    return { status: "refused", reason: "no_chain", detail: "task carries no revision chain, so no checkpoint exists to rebase" };
  }
  const previous = stored.state.checkpoint;
  if (input.checkpoint.sessionBaselineDigest === previous.sessionBaselineDigest) {
    // §6.4 rule 2: drift is a baseline-digest difference, and only drift
    // rebases. (The PLAN digests may legitimately be equal — a plan-neutral
    // drift rebases like any other.)
    return { status: "refused", reason: "invalid_input", detail: "sessionBaselineDigest unchanged — the session layer did not move, so there is nothing to rebase" };
  }

  const checkpoint: VerificationPlanCheckpoint = {
    planDigest: input.checkpoint.planDigest,
    sessionBaseline: copySessionBaseline(input.checkpoint.sessionBaseline),
    sessionBaselineDigest: input.checkpoint.sessionBaselineDigest,
    appliedThroughOrdinal: previous.appliedThroughOrdinal,
    updatedAt: now,
    updatedBy: "rebase",
  };
  const event: TaskEvent = {
    task: input.key,
    type: VERIFICATION_AMENDMENT_REBASED_EVENT,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    // §12.1: digests and commandIds only — never command bytes. The mutable
    // checkpoint keeps no history of its own, so this event is the record of
    // which digests were replaced by which.
    data: {
      previousSessionBaselineDigest: previous.sessionBaselineDigest,
      sessionBaselineDigest: checkpoint.sessionBaselineDigest,
      previousPlanDigest: previous.planDigest,
      planDigest: checkpoint.planDigest,
      masked: [...(input.dispositions?.masked ?? [])],
      orphaned: [...(input.dispositions?.orphaned ?? [])],
    },
    createdAt: now,
  };

  const committed = await input.store.completePhaseWithEffects(
    {
      key: input.key,
      expected: { revision: input.observedTaskRevision },
      patch: {
        context: {
          [VERIFICATION_AMENDMENTS_CONTEXT_KEY]: {
            revisions: stored.state.revisions,
            checkpoint,
          } satisfies VerificationAmendmentState,
        },
        now,
      },
      event,
    },
    [],
  );
  if (committed.ok) return { status: "rebased", task: committed.value, checkpoint, event };
  if (committed.code === "maintenance_locked") return { status: "maintenance_locked" };
  if (committed.code === "conflict") {
    return {
      status: "stale",
      observedTaskRevision: input.observedTaskRevision,
      currentTaskRevision: committed.current?.revision,
      current: committed.current,
    };
  }
  if (committed.code === "not_found") {
    return { status: "refused", reason: "not_found", detail: "task disappeared before the write" };
  }
  return {
    status: "refused",
    reason: "store_rejected",
    detail: `store refused the write (${committed.code})`,
  };
}
