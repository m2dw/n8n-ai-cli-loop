/**
 * Verification evidence binding (issue #1040) — bind manual verification
 * evidence to the plan revision and the reviewed commit it actually tested.
 *
 * A verification command may pass before the operator corrects the plan or
 * before implementation changes the branch. Reusing that result after the
 * command, the plan, or the reviewed commit changes would produce a false
 * pass, so evidence is valid only for the identities it was recorded against —
 * the `docs/verification-execution-contract.md` §8.2 rule 3 posture ("evidence
 * binds to identities, not to time"), applied to the operator-attested
 * `manualVerificationEvidence` layer.
 *
 * The binding an evidence entry carries (all recorded at `admin
 * review-verification resolve` time, from the block the review escalation
 * recorded — see {@link VERIFICATION_EVIDENCE_BINDING_CONTEXT_KEY}):
 *
 * - `planDigest` / `planRevisionOrdinal` — the §5.4 digest and applied-through
 *   ordinal of the effective verification plan the evidence was recorded
 *   under (`docs/verification-amendment-contract.md`). Provenance: they answer
 *   "which plan revision did this evidence test" after the fact.
 * - `commandId` — the §5.1 stable identity of the requirement slot the
 *   evidence was recorded FOR. Identity, never bytes: a slot whose bytes an
 *   amendment `replace`d keeps its `commandId`, so the binding survives a
 *   correction while the byte-equivalence check below rejects the stale
 *   result.
 * - `headSha` — the reviewed branch HEAD the escalating review run had
 *   checked out. Evidence recorded at one commit says nothing about another.
 *
 * The admissibility rule ({@link evaluateVerificationEvidenceBinding}) — an
 * entry satisfies a requirement slot only when EVERY check passes, and the
 * callers additionally require the shipped `matchesConfiguredVerificationCommand`
 * equivalence against the slot's CURRENT bytes (the only equivalence rule;
 * a renamed or similar-looking command is never inferred equivalent):
 *
 * 1. the entry passed (`exitCode === 0`) — failed evidence never satisfies
 *    anything and keeps routing through the implementation-fix semantics;
 * 2. the entry carries a well-formed binding — legacy evidence that lacks it
 *    is conservatively inadmissible (`legacy_unbound`), never migrated by
 *    guesswork; the operator re-records it through the resolve surface,
 *    which now stamps the binding;
 * 3. the current effective plan is resolvable and contains the slot — an
 *    unresolvable plan or a slot no longer in the plan fails closed
 *    (`plan_unresolvable` / `slot_not_in_plan`): a removed command is never
 *    marked passed;
 * 4. the recorded identity names the slot under evaluation
 *    (`identity_mismatch` otherwise) — evidence recorded for one slot never
 *    satisfies a different or later-added slot, whatever its bytes;
 * 5. no §8.3 per-slot invalidation record names the slot
 *    (`slot_invalidated`) — the amendment-contract rule, unchanged; a
 *    malformed `invalidations` value cannot prove the slot was NOT
 *    invalidated and fails closed the same way;
 * 6. the reviewed HEAD is known and equals the recorded one
 *    (`head_unresolvable` / `head_mismatch`) — implementation changes after
 *    the evidence was recorded make it stale, and stale evidence fails
 *    closed rather than being deleted (§8.1: invalidation never destroys the
 *    record).
 *
 * What this deliberately does NOT do:
 *
 * - It never deletes evidence. Inadmissible entries stay in the task context;
 *   the shipped #622-P1 clearing on the fix-mode requeue is unchanged and is
 *   the only clearing path.
 * - It does not require the recorded `planDigest` to equal the current one.
 *   The amendment contract's §8.3 preservation rules permit evidence to
 *   survive a plan change that leaves its own slot untouched (`add` on
 *   another slot invalidates nothing), so preservation is per slot identity:
 *   the identity, byte-equivalence, invalidation, and HEAD checks decide, and
 *   the recorded digest is provenance for the audit trail.
 * - It adds no amendment operation, no revision, and no store method; it is a
 *   pure admissibility rule the status builders consult.
 */

/**
 * Task-context key of the block a review escalation records so the resolve
 * surface can stamp evidence with the binding the review actually tested:
 * `{ headSha?, planDigest?, planRevisionOrdinal?, commandIds? }`, where
 * `commandIds` maps each active requirement slot's current command bytes to
 * its §5.1 `commandId`.
 */
export const VERIFICATION_EVIDENCE_BINDING_CONTEXT_KEY = "verificationEvidenceBinding";

/** Bound on a recorded `commandId` (`req:<16 hex>` today; kept general). */
export const MAX_VERIFICATION_EVIDENCE_COMMAND_ID_CHARS = 200;

/** Bound on the escalation block's `commandIds` map. */
export const MAX_VERIFICATION_EVIDENCE_COMMAND_IDS = 500;

/** Bound on a `commandIds` key — mirrors the amendment command-byte bound. */
export const MAX_VERIFICATION_EVIDENCE_COMMAND_CHARS = 4000;

/** A git commit id: full SHA-1 (40 hex) or SHA-256 (64 hex), lowercase. */
const COMMIT_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** A SHA-256 plan digest: 64 lowercase hex characters. */
const PLAN_DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * Normalize a value to a lowercase commit SHA, or `undefined` when it is not
 * one. Conservative by design: a value that is not recognizably a commit id
 * is treated as absent, so a malformed recording can never accidentally
 * compare equal.
 */
export function normalizeCommitSha(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return COMMIT_SHA_RE.test(normalized) ? normalized : undefined;
}

/** The binding fields a fully bound evidence entry carries (issue #1040). */
export interface VerificationEvidenceBinding {
  /** §5.4 digest of the effective plan the evidence was recorded under. */
  planDigest: string;
  /** `appliedThroughOrdinal` of that plan; 0 for an unamended task. */
  planRevisionOrdinal: number;
  /** §5.1 identity of the requirement slot the evidence was recorded for. */
  commandId: string;
  /** The reviewed branch HEAD the evidence was recorded against. */
  headSha: string;
}

/**
 * The structural shape the evaluator needs of a `manualVerificationEvidence`
 * entry: the shipped fields plus the optional #1040 binding. Structural so the
 * shipped `ManualVerificationEntry` — and any persisted legacy entry —
 * satisfies it unchanged.
 */
export interface BoundVerificationEvidenceLike {
  command: string;
  exitCode: number;
  planDigest?: unknown;
  planRevisionOrdinal?: unknown;
  commandId?: unknown;
  headSha?: unknown;
  /**
   * §8.3 rule 1 per-slot invalidation records; empty/absent when none.
   * `unknown` because persisted entries are untrusted input —
   * {@link isVerificationSlotInvalidated} validates the shape.
   */
  invalidations?: unknown;
}

/**
 * What the current run expects evidence to be bound to. Every field is
 * optional because every one can be unresolvable — and an unresolvable
 * expectation fails closed rather than waving the entry through.
 */
export interface VerificationEvidenceExpectations {
  /** The reviewed HEAD of the current run; absent when unresolvable. */
  headSha?: string;
  /** The current effective plan digest; absent when the plan is unresolvable. */
  planDigest?: string;
  /**
   * The §5.1 identity of the requirement slot under evaluation; absent when
   * the slot is not in the current effective plan.
   */
  commandId?: string;
}

/**
 * Why an entry was rejected, most actionable reason first. A closed set;
 * values are persisted in task context and surfaced in escalation messages,
 * so renaming one is a contract change.
 */
export type VerificationEvidenceRejection =
  | "failed_exit"
  | "legacy_unbound"
  | "plan_unresolvable"
  | "slot_not_in_plan"
  | "identity_mismatch"
  | "slot_invalidated"
  | "head_unresolvable"
  | "head_mismatch";

export type VerificationEvidenceVerdict =
  | { admissible: true; binding: VerificationEvidenceBinding }
  | { admissible: false; reason: VerificationEvidenceRejection };

/**
 * Read an entry's recorded binding, or `undefined` when any field is missing
 * or malformed — a partially or wrongly recorded binding is indistinguishable
 * from tampering and is treated exactly like legacy evidence: inadmissible.
 */
export function readVerificationEvidenceEntryBinding(
  entry: BoundVerificationEvidenceLike,
): VerificationEvidenceBinding | undefined {
  const headSha = normalizeCommitSha(entry.headSha);
  if (headSha === undefined) return undefined;
  const planDigest = entry.planDigest;
  if (typeof planDigest !== "string" || !PLAN_DIGEST_RE.test(planDigest)) return undefined;
  const ordinal = entry.planRevisionOrdinal;
  if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 0) return undefined;
  const commandId = entry.commandId;
  if (
    typeof commandId !== "string" ||
    commandId.trim().length === 0 ||
    commandId !== commandId.trim() ||
    commandId.length > MAX_VERIFICATION_EVIDENCE_COMMAND_ID_CHARS
  ) {
    return undefined;
  }
  return { planDigest, planRevisionOrdinal: ordinal, commandId, headSha };
}

/**
 * §8.3 rule 1 check over an UNTRUSTED persisted `invalidations` value: does a
 * mark name `commandId`? Fail closed on shape: a value that is present but not
 * an array, or a mark that is not an object carrying a string `commandId`, is
 * indistinguishable from a corrupted record that could have named this slot —
 * it answers "invalidated" rather than throwing or waving the entry through.
 * Only `undefined` means "no invalidation records".
 */
export function isVerificationSlotInvalidated(invalidations: unknown, commandId: string): boolean {
  if (invalidations === undefined) return false;
  if (!Array.isArray(invalidations)) return true;
  return invalidations.some((mark) => {
    if (mark === null || typeof mark !== "object") return true;
    const marked = (mark as { commandId?: unknown }).commandId;
    return typeof marked !== "string" || marked === commandId;
  });
}

/**
 * The #1040 admissibility rule (module header, checks 1–6). Byte equivalence
 * against the slot's current command is the CALLER's check — the shipped
 * `matchesConfiguredVerificationCommand` rule, applied where the slot bytes
 * live — so this evaluator owns exactly the binding half.
 */
export function evaluateVerificationEvidenceBinding(
  entry: BoundVerificationEvidenceLike,
  expectations: VerificationEvidenceExpectations,
): VerificationEvidenceVerdict {
  if (entry.exitCode !== 0) return { admissible: false, reason: "failed_exit" };
  const binding = readVerificationEvidenceEntryBinding(entry);
  if (binding === undefined) return { admissible: false, reason: "legacy_unbound" };
  if (expectations.planDigest === undefined) return { admissible: false, reason: "plan_unresolvable" };
  if (expectations.commandId === undefined) return { admissible: false, reason: "slot_not_in_plan" };
  if (binding.commandId !== expectations.commandId) {
    return { admissible: false, reason: "identity_mismatch" };
  }
  if (isVerificationSlotInvalidated(entry.invalidations, expectations.commandId)) {
    return { admissible: false, reason: "slot_invalidated" };
  }
  const expectedHead = normalizeCommitSha(expectations.headSha);
  if (expectedHead === undefined) return { admissible: false, reason: "head_unresolvable" };
  if (binding.headSha !== expectedHead) return { admissible: false, reason: "head_mismatch" };
  return { admissible: true, binding };
}

/**
 * The block a review escalation records in task context
 * ({@link VERIFICATION_EVIDENCE_BINDING_CONTEXT_KEY}). Fields are optional so
 * a partially resolvable escalation (e.g. HEAD unresolvable) still records
 * what it could; the resolve surface fails closed on what is missing.
 */
export interface VerificationEvidenceBindingBlock {
  headSha?: string;
  planDigest?: string;
  planRevisionOrdinal?: number;
  /** Active requirement slot command bytes → §5.1 `commandId`. */
  commandIds?: Readonly<Record<string, string>>;
  /**
   * Issue #1043 review (P2): active requirement command bytes carried by MORE
   * than one slot. A single byte-keyed `commandIds` entry cannot say which
   * slot such bytes attest, so they are excluded from the map and listed
   * here; the resolve surface refuses them explicitly rather than binding
   * evidence to whichever slot survived a byte-keyed overwrite.
   */
  ambiguousCommands?: readonly string[];
}

/**
 * Parse a raw task-context binding block. Conservative: a block with ANY
 * malformed field is rejected whole (`undefined`), because a half-trusted
 * block could stamp evidence with a wrong identity — the exact false pass
 * this module exists to prevent. Absent optional fields are fine.
 */
export function readVerificationEvidenceBindingBlock(
  raw: unknown,
): VerificationEvidenceBindingBlock | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const block: {
    headSha?: string;
    planDigest?: string;
    planRevisionOrdinal?: number;
    commandIds?: Record<string, string>;
    ambiguousCommands?: string[];
  } = {};

  if (record["headSha"] !== undefined) {
    const headSha = normalizeCommitSha(record["headSha"]);
    if (headSha === undefined) return undefined;
    block.headSha = headSha;
  }
  if (record["planDigest"] !== undefined) {
    const planDigest = record["planDigest"];
    if (typeof planDigest !== "string" || !PLAN_DIGEST_RE.test(planDigest)) return undefined;
    block.planDigest = planDigest;
  }
  if (record["planRevisionOrdinal"] !== undefined) {
    const ordinal = record["planRevisionOrdinal"];
    if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 0) return undefined;
    block.planRevisionOrdinal = ordinal;
  }
  if (record["commandIds"] !== undefined) {
    const rawIds = record["commandIds"];
    if (rawIds === null || typeof rawIds !== "object" || Array.isArray(rawIds)) return undefined;
    const entries = Object.entries(rawIds as Record<string, unknown>);
    if (entries.length > MAX_VERIFICATION_EVIDENCE_COMMAND_IDS) return undefined;
    const commandIds: Record<string, string> = {};
    for (const [command, commandId] of entries) {
      if (command.length === 0 || command.length > MAX_VERIFICATION_EVIDENCE_COMMAND_CHARS) return undefined;
      if (
        typeof commandId !== "string" ||
        commandId.trim().length === 0 ||
        commandId !== commandId.trim() ||
        commandId.length > MAX_VERIFICATION_EVIDENCE_COMMAND_ID_CHARS
      ) {
        return undefined;
      }
      commandIds[command] = commandId;
    }
    block.commandIds = commandIds;
  }
  if (record["ambiguousCommands"] !== undefined) {
    const rawAmbiguous = record["ambiguousCommands"];
    if (!Array.isArray(rawAmbiguous)) return undefined;
    if (rawAmbiguous.length > MAX_VERIFICATION_EVIDENCE_COMMAND_IDS) return undefined;
    const ambiguousCommands: string[] = [];
    for (const command of rawAmbiguous) {
      if (
        typeof command !== "string" ||
        command.length === 0 ||
        command.length > MAX_VERIFICATION_EVIDENCE_COMMAND_CHARS
      ) {
        return undefined;
      }
      ambiguousCommands.push(command);
    }
    block.ambiguousCommands = ambiguousCommands;
  }
  return block;
}
