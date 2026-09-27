import { createHash } from "crypto";
import { matchesConfiguredVerificationCommand } from "./tool-request-continuation.js";
import {
  evaluateVerificationEvidenceBinding,
  isVerificationSlotInvalidated,
  type VerificationEvidenceBindingBlock,
  type VerificationEvidenceRejection,
} from "./verification-evidence.js";
import {
  canonicalJsonStringify,
  deriveExecutionCommandId,
  deriveRequirementCommandId,
  deriveSessionBaselineDigest,
  validateVerificationAmendmentOperations,
  validateVerificationAmendmentState,
  MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS,
  MAX_VERIFICATION_AMENDMENT_NAME_CHARS,
  MAX_VERIFICATION_SESSION_BASELINE_ENTRIES,
  type VerificationAmendmentLayer,
  type VerificationAmendmentOperation,
  type VerificationAmendmentState,
  type VerificationPlanCheckpointInput,
  type VerificationPlanSessionBaselineEntry,
  type VerificationPlanSlotCounts,
} from "./verification-amendment.js";

/**
 * Effective verification plan resolution — the resolution half of
 * `docs/verification-amendment-contract.md` §15 slice A1 (issue #1039), on top
 * of the §5.5 persistence slice (issue #1038, `core/verification-amendment.ts`).
 *
 * One deterministic, side-effect-free resolver for the three requirement-side
 * ownership layers of §3.1, so review, the admin CLI, and any later UI cannot
 * disagree about what a task verifies:
 *
 * - {@link resolveEffectiveVerificationPlan} — §6.1–§6.3: the live
 *   `session.verification` map, the intake-pinned Issue-derived requirements,
 *   and the applied task-amendment chain resolved into one ordered plan with
 *   stable §5.1 slot identities, per-slot origin and amendment metadata, and
 *   the §5.4 `planDigest`;
 * - {@link proposeVerificationRevision} — the authoring side of §5.2/§5.3 rule
 *   7: operations validated and composed sequentially against the plan state
 *   their predecessors produced, all-or-nothing, with every §5.2 refusal
 *   condition returned explicitly rather than silently dropped;
 * - {@link reconcileVerificationPlan} — §6.4 rule 3's three-way
 *   consistent/drifted/unreconciled classification with its rule 4
 *   dispositions, so an authorized `session.verification` edit rebases (§6.4
 *   rule 5) while a hand-edited task row fails closed;
 * - {@link buildEffectiveRequirementStatus} — §6.2 rule 3's satisfaction test,
 *   which reuses the shipped `matchesConfiguredVerificationCommand`
 *   equivalence rule verbatim (§13.2) and adds only the §8.3 rule 2 per-slot
 *   invalidation clause.
 *
 * Purity is normative in both directions (§6): resolution reads no live
 * provider state, no agent output, and no evidence, and it writes nothing —
 * it classifies and reports, and only a surface that already holds a write
 * transaction records the result. Nothing here executes a command or mutates
 * task state, and no agent-authored byte reaches an operation (§3.3).
 *
 * Deliberately NOT here (later slices): the `revisionId`/`requestKey`
 * derivations (§5.3 rules 1–2), the operator CLI (§11), continuation routing
 * (§9), refresh-from-Issue (§10), and public reporting (§12.2). The
 * intake-time Issue extraction stays where it is — the caller passes the
 * pinned `extractIssueVerificationCommands(context.body)` result in, so this
 * module is provider-neutral and never re-reads a live Issue.
 */

/** §5.4: the closed slot-state set. `"orphaned"` is a report, never a state. */
export type VerificationSlotState = "active" | "retired";

/**
 * Which layer a slot entered the plan from (§3.1). It is the slot's ORIGIN,
 * not its current owner: a `session-default` slot whose bytes an amendment
 * `replace`d keeps `origin: "session-default"` and reports the amendment in
 * {@link EffectiveVerificationSlot.amendments}, because §3.2's overlay never
 * rewrites the layer a slot came from.
 */
export type VerificationSlotOrigin = "session-default" | "issue-requirement" | "task-amendment";

/** One applied (or projected) operation recorded against a slot, in order. */
export interface VerificationSlotAmendmentRecord {
  /** Absent for an operation projected by {@link proposeVerificationRevision}. */
  revisionId?: string;
  revisionOrdinal: number;
  /** Index of the operation within its revision — the §5.2 recorded order. */
  operationIndex: number;
  kind: VerificationAmendmentOperation["kind"];
}

/** One addressable position in the effective plan (§2 "plan slot"). */
export interface EffectiveVerificationSlot {
  /** §5.1: `exec:<name>` or `req:<16 lowercase hex>`; identifies the SLOT. */
  commandId: string;
  layer: VerificationAmendmentLayer;
  /** Execution layer only: the operator name that keys the run artifact. */
  name?: string;
  state: VerificationSlotState;
  /** §2 command bytes, verbatim — what the runner would execute. */
  command: string;
  origin: VerificationSlotOrigin;
  /** The bytes the slot entered the plan with; differs after a `replace`. */
  originCommand: string;
  /** True when any applied operation touched this slot. */
  amended: boolean;
  amendments: readonly VerificationSlotAmendmentRecord[];
}

/**
 * §6.4 rule 4 dispositions and the §5.1/§6.1 identity detections. Every one is
 * a REPORT: resolution is total (§6.3), so none of them refuses, and none
 * carries command bytes — a caller building a §12.1 event copies identities.
 */
export type VerificationPlanNote =
  /**
   * §6.1 step 1: a live `session.verification` entry whose `exec:<name>`
   * identity an execution-layer `add` already claims. It materializes no slot;
   * the task-local slot owns the identity (invariant 20).
   */
  | { kind: "masked_session_entry"; commandId: string; name: string; maskedByRevisionId: string }
  /**
   * §6.4 rule 4: chain operations naming a slot the plan does not contain —
   * the removed-`session.verification`-key case. The operations are inert
   * (§6.1 step 2), stay in the append-only chain, and replay onto the slot if
   * the key returns. Never resurrected from the recorded baseline.
   */
  | {
      kind: "orphaned_slot";
      commandId: string;
      layer: VerificationAmendmentLayer;
      operations: readonly VerificationSlotAmendmentRecord[];
    }
  /** §5.1: two byte-identical source commands collapsed into one slot. */
  | { kind: "duplicate_command"; commandId: string; layer: VerificationAmendmentLayer; occurrences: number }
  /**
   * A replayed `add` whose identity a slot already holds. Authoring refuses
   * this (§5.2), so a recorded chain should never carry one; when it does,
   * resolution stays total and materializes NO second slot — one `commandId`
   * is never two slots (invariant 20).
   */
  | { kind: "colliding_add"; commandId: string; layer: VerificationAmendmentLayer; revisionId: string; operationIndex: number }
  /**
   * Two same-layer slots whose bytes differ but which are equivalent under the
   * shipped `matchesConfiguredVerificationCommand` rule (§13.2) — e.g. a
   * command and its `bash -lc '<cmd>'` wrapper. Two slots by §5.1 (identity is
   * byte-preserving), one check by the matcher: advisory, never a refusal.
   */
  | { kind: "ambiguous_equivalence"; layer: VerificationAmendmentLayer; commandIds: readonly [string, string] };

/** §6.3: the execution set followed by the requirement set, each in order. */
export interface EffectiveVerificationPlan {
  execution: readonly EffectiveVerificationSlot[];
  requirement: readonly EffectiveVerificationSlot[];
  /** §5.4: `sha256(canonicalJson(plan))` over the plan and nothing else. */
  planDigest: string;
  /** The highest `revisionOrdinal` this plan replayed; 0 for an unamended task. */
  appliedThroughOrdinal: number;
  notes: readonly VerificationPlanNote[];
}

/**
 * The durable inputs of §6. `sessionVerification` is the LIVE map (§6.1 step
 * 1); `issueRequirements` is the intake-pinned
 * `extractIssueVerificationCommands(context.body)` result (§6.2 step 1);
 * `amendments` is the raw task-context block, validated here so a malformed
 * chain fails closed (§5.5) instead of resolving to a plausible-looking plan.
 */
export interface EffectiveVerificationPlanInput {
  sessionVerification?: Record<string, string> | readonly VerificationPlanSessionBaselineEntry[];
  issueRequirements?: readonly string[];
  amendments?: unknown;
}

/** Which input a {@link resolveEffectiveVerificationPlan} refusal names. */
export type VerificationPlanInputRefusal =
  | "session_verification"
  | "issue_requirements"
  | "amendment_state";

export type ResolveEffectiveVerificationPlanResult =
  | { status: "resolved"; plan: EffectiveVerificationPlan }
  /**
   * An input that cannot be represented as a plan — an empty command, a name
   * no `exec:<name>` identity can be formed from, a malformed chain. Refused
   * explicitly and named; never dropped, never coerced to a default.
   */
  | { status: "invalid"; reason: VerificationPlanInputRefusal; detail: string };

/** §5.1: the execution-layer name rule, applied to every `exec:` identity. */
const EXECUTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Bound on the requirement layer. The extractor's output is bounded by the
 * Issue body, so this only refuses input a body could never legitimately
 * produce; the execution layer reuses the §5.5 session-baseline bound so a
 * resolvable session map is always a recordable baseline.
 */
export const MAX_VERIFICATION_PLAN_REQUIREMENTS = 200;

interface MutableSlot {
  commandId: string;
  layer: VerificationAmendmentLayer;
  name?: string;
  state: VerificationSlotState;
  command: string;
  origin: VerificationSlotOrigin;
  originCommand: string;
  amendments: VerificationSlotAmendmentRecord[];
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function freezeSlot(slot: MutableSlot): EffectiveVerificationSlot {
  return {
    commandId: slot.commandId,
    layer: slot.layer,
    ...(slot.name !== undefined ? { name: slot.name } : {}),
    state: slot.state,
    command: slot.command,
    origin: slot.origin,
    originCommand: slot.originCommand,
    amended: slot.amendments.length > 0,
    amendments: slot.amendments.map((record) => ({ ...record })),
  };
}

function thawSlot(slot: EffectiveVerificationSlot): MutableSlot {
  return {
    commandId: slot.commandId,
    layer: slot.layer,
    ...(slot.name !== undefined ? { name: slot.name } : {}),
    state: slot.state,
    command: slot.command,
    origin: slot.origin,
    originCommand: slot.originCommand,
    amendments: slot.amendments.map((record) => ({ ...record })),
  };
}

/**
 * §2: the command bytes an operator authored, with leading and trailing
 * whitespace removed and NOTHING else changed. Interior whitespace may sit
 * inside a quoted argument, where it is data, so it is never collapsed.
 */
function commandBytes(value: string): string {
  return value.trim();
}

export type VerificationSessionBaselineResult =
  | {
      status: "ok";
      sessionBaseline: readonly VerificationPlanSessionBaselineEntry[];
      sessionBaselineDigest: string;
    }
  | { status: "invalid"; detail: string };

/**
 * §6.4 rule 1 / §5.5: the ordered `{name, command}` snapshot of the session
 * layer an applying surface records on the checkpoint, with its digest.
 * Exported so the baseline a write stores is derived by exactly the
 * normalization resolution reads, and a later drift comparison can never fire
 * on a trimming difference. Attribution only — nothing executes from it.
 */
export function buildVerificationSessionBaseline(
  sessionVerification: Record<string, string> | readonly VerificationPlanSessionBaselineEntry[],
): VerificationSessionBaselineResult {
  const normalized = normalizeSessionEntries(sessionVerification);
  if ("detail" in normalized) return { status: "invalid", detail: normalized.detail };
  return {
    status: "ok",
    sessionBaseline: normalized.entries,
    sessionBaselineDigest: deriveSessionBaselineDigest(normalized.entries),
  };
}

function normalizeSessionEntries(
  input: Record<string, string> | readonly VerificationPlanSessionBaselineEntry[] | undefined,
): { entries: VerificationPlanSessionBaselineEntry[] } | { detail: string } {
  const pairs: Array<{ name: unknown; command: unknown }> = [];
  if (input === undefined) {
    // §6.3: an absent session map is an empty execution layer, not an error.
  } else if (Array.isArray(input)) {
    for (const raw of input as readonly unknown[]) {
      const entry = raw as { name?: unknown; command?: unknown } | null;
      if (entry === null || typeof entry !== "object") {
        return { detail: `sessionVerification[${pairs.length}]: not an object` };
      }
      pairs.push({ name: entry.name, command: entry.command });
    }
  } else if (typeof input === "object") {
    for (const [name, command] of Object.entries(input as Record<string, string>)) {
      pairs.push({ name, command });
    }
  } else {
    return { detail: "sessionVerification: not a map or entry list" };
  }

  if (pairs.length > MAX_VERIFICATION_SESSION_BASELINE_ENTRIES) {
    return {
      detail: `sessionVerification: ${pairs.length} entries exceeds the ${MAX_VERIFICATION_SESSION_BASELINE_ENTRIES}-entry bound`,
    };
  }

  const entries: VerificationPlanSessionBaselineEntry[] = [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    const { name, command } = pair;
    if (typeof name !== "string" || !EXECUTION_NAME_PATTERN.test(name)) {
      // A name no `exec:<name>` identity can be formed from is unamendable
      // (§5.1) and unsafe as the `verification-<name>.log` path component
      // (#918 §11.1), so it is refused rather than resolved into a slot no
      // operation could ever name.
      return { detail: `sessionVerification: name "${String(name)}" violates the §5.1 character rule` };
    }
    if (name.length > MAX_VERIFICATION_AMENDMENT_NAME_CHARS) {
      return { detail: `sessionVerification["${name}"]: name exceeds ${MAX_VERIFICATION_AMENDMENT_NAME_CHARS} chars` };
    }
    if (seen.has(name)) {
      return { detail: `sessionVerification: duplicate name "${name}"` };
    }
    seen.add(name);
    if (typeof command !== "string") {
      return { detail: `sessionVerification["${name}"]: command is not a string` };
    }
    const bytes = commandBytes(command);
    if (bytes.length === 0) {
      // §5.2 refuses empty command bytes on an operation; an empty session
      // value is the same unrepresentable thing arriving from the other
      // layer, and dropping it silently would hide a broken session entry.
      return { detail: `sessionVerification["${name}"]: empty command` };
    }
    if (bytes.length > MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS) {
      return { detail: `sessionVerification["${name}"]: command exceeds ${MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS} chars` };
    }
    entries.push({ name, command: bytes });
  }
  return { entries };
}

function normalizeIssueRequirements(
  input: readonly string[] | undefined,
): { commands: string[] } | { detail: string } {
  if (input === undefined) return { commands: [] };
  if (!Array.isArray(input)) return { detail: "issueRequirements: not an array" };
  if (input.length > MAX_VERIFICATION_PLAN_REQUIREMENTS) {
    return {
      detail: `issueRequirements: ${input.length} entries exceeds the ${MAX_VERIFICATION_PLAN_REQUIREMENTS}-entry bound`,
    };
  }
  const commands: string[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const value = input[i];
    if (typeof value !== "string") return { detail: `issueRequirements[${i}]: not a string` };
    const bytes = commandBytes(value);
    if (bytes.length === 0) return { detail: `issueRequirements[${i}]: empty command` };
    if (bytes.length > MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS) {
      return { detail: `issueRequirements[${i}]: exceeds ${MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS} chars` };
    }
    commands.push(bytes);
  }
  return { commands };
}

/** The layer an operation addresses, read off the `commandId` prefix (§5.1). */
function commandIdLayer(commandId: string): VerificationAmendmentLayer {
  return commandId.startsWith("exec:") ? "execution" : "requirement";
}

/** The identity an `add` materializes (§5.1); derived, never supplied. */
export function deriveAddedCommandId(
  operation: Extract<VerificationAmendmentOperation, { kind: "add" }>,
): string {
  return operation.layer === "execution"
    ? deriveExecutionCommandId(operation.name)
    : deriveRequirementCommandId(operation.command);
}

interface ReplayTarget {
  execution: MutableSlot[];
  requirement: MutableSlot[];
}

function slotsOfLayer(target: ReplayTarget, layer: VerificationAmendmentLayer): MutableSlot[] {
  return layer === "execution" ? target.execution : target.requirement;
}

/**
 * §6.1 step 2 / §6.2 step 2: replay one recorded operation. Replay NEVER
 * refuses — §6.3's totality holds over every recorded chain — so an operation
 * whose target slot is absent is inert and reported, and an `add` whose
 * identity a slot already holds materializes nothing.
 */
function replayOperation(
  target: ReplayTarget,
  operation: VerificationAmendmentOperation,
  record: VerificationSlotAmendmentRecord,
  notes: VerificationPlanNote[],
  orphaned: Map<string, { layer: VerificationAmendmentLayer; operations: VerificationSlotAmendmentRecord[] }>,
): void {
  if (operation.kind === "add") {
    const commandId = deriveAddedCommandId(operation);
    const slots = slotsOfLayer(target, operation.layer);
    if (slots.some((slot) => slot.commandId === commandId)) {
      notes.push({
        kind: "colliding_add",
        commandId,
        layer: operation.layer,
        revisionId: record.revisionId ?? "",
        operationIndex: record.operationIndex,
      });
      return;
    }
    const command = commandBytes(operation.command);
    slots.push({
      commandId,
      layer: operation.layer,
      ...(operation.layer === "execution" ? { name: operation.name } : {}),
      state: "active",
      command,
      origin: "task-amendment",
      originCommand: command,
      amendments: [record],
    });
    return;
  }

  const layer = commandIdLayer(operation.commandId);
  const slot = slotsOfLayer(target, layer).find((entry) => entry.commandId === operation.commandId);
  if (!slot) {
    const existing = orphaned.get(operation.commandId);
    if (existing) existing.operations.push(record);
    else orphaned.set(operation.commandId, { layer, operations: [record] });
    return;
  }
  slot.amendments.push(record);
  if (operation.kind === "replace") slot.command = commandBytes(operation.command);
  else if (operation.kind === "retire") slot.state = "retired";
  else if (operation.kind === "restore") slot.state = "active";
  // `annotate` changes neither bytes, state, nor position (§6.1 step 2).
}

/** §5.4: the digest input — entries in resolution order, execution first. */
function planDigestOf(execution: readonly MutableSlot[], requirement: readonly MutableSlot[]): string {
  const digestEntries = (slots: readonly MutableSlot[]): Array<Record<string, string>> =>
    slots.map((slot) => ({ commandId: slot.commandId, state: slot.state, command: slot.command }));
  return sha256Hex(
    canonicalJsonStringify({
      execution: digestEntries(execution),
      requirement: digestEntries(requirement),
    }),
  );
}

/**
 * Detect same-layer slots that the shipped equivalence rule cannot tell apart
 * (§13.2). Cross-layer equivalence is the DESIGNED satisfaction path (§6.2
 * rule 3) and is never an ambiguity; byte-equal same-layer slots cannot exist,
 * because identical bytes collapse to one identity (§5.1).
 */
function ambiguityNotes(slots: readonly MutableSlot[], layer: VerificationAmendmentLayer): VerificationPlanNote[] {
  const notes: VerificationPlanNote[] = [];
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      const a = slots[i];
      const b = slots[j];
      if (a.command === b.command) continue;
      if (
        matchesConfiguredVerificationCommand(a.command, b.command) ||
        matchesConfiguredVerificationCommand(b.command, a.command)
      ) {
        notes.push({ kind: "ambiguous_equivalence", layer, commandIds: [a.commandId, b.commandId] });
      }
    }
  }
  return notes;
}

/**
 * Resolve the effective plan (§6) from the live session map, the intake-pinned
 * Issue requirements, and the applied amendment chain.
 *
 * Deterministic and total: identical inputs produce the same ordered plan and
 * the same digest, and an empty session map, an absent Issue body, and an
 * empty chain resolve to a well-defined empty plan with a digest (§6.3). An
 * empty plan is not "verification passed".
 */
export function resolveEffectiveVerificationPlan(
  input: EffectiveVerificationPlanInput,
): ResolveEffectiveVerificationPlanResult {
  const session = normalizeSessionEntries(input.sessionVerification);
  if ("detail" in session) return { status: "invalid", reason: "session_verification", detail: session.detail };
  const requirements = normalizeIssueRequirements(input.issueRequirements);
  if ("detail" in requirements) {
    return { status: "invalid", reason: "issue_requirements", detail: requirements.detail };
  }
  const validation = validateVerificationAmendmentState(input.amendments);
  if (!validation.valid) return { status: "invalid", reason: "amendment_state", detail: validation.detail };
  const state: VerificationAmendmentState | undefined = validation.state;

  const notes: VerificationPlanNote[] = [];

  // §6.1 step 1: which `exec:<name>` identities a task-local `add` already
  // claims. Keyed on the `add` being PRESENT in the chain, not on the state of
  // the slot it created — retiring the task-local slot does not unmask the
  // session entry (§6.1 step 1).
  const claimedExecutionIds = new Map<string, string>();
  for (const revision of state?.revisions ?? []) {
    for (const operation of revision.operations) {
      if (operation.kind === "add" && operation.layer === "execution") {
        const commandId = deriveExecutionCommandId(operation.name);
        if (!claimedExecutionIds.has(commandId)) claimedExecutionIds.set(commandId, revision.revisionId);
      }
    }
  }

  const execution: MutableSlot[] = [];
  for (const entry of session.entries) {
    const commandId = deriveExecutionCommandId(entry.name);
    const maskedBy = claimedExecutionIds.get(commandId);
    if (maskedBy !== undefined) {
      notes.push({ kind: "masked_session_entry", commandId, name: entry.name, maskedByRevisionId: maskedBy });
      continue;
    }
    execution.push({
      commandId,
      layer: "execution",
      name: entry.name,
      state: "active",
      command: entry.command,
      origin: "session-default",
      originCommand: entry.command,
      amendments: [],
    });
  }

  // §6.2 step 1 / §5.1: two byte-identical source commands collapse to one
  // slot — the plan is a set of checks, and the same check written twice is
  // one check. The collapse is reported, never silent.
  const requirement: MutableSlot[] = [];
  const duplicateCounts = new Map<string, number>();
  for (const command of requirements.commands) {
    const commandId = deriveRequirementCommandId(command);
    const existing = requirement.find((slot) => slot.commandId === commandId);
    if (existing) {
      duplicateCounts.set(commandId, (duplicateCounts.get(commandId) ?? 1) + 1);
      continue;
    }
    requirement.push({
      commandId,
      layer: "requirement",
      state: "active",
      command,
      origin: "issue-requirement",
      originCommand: command,
      amendments: [],
    });
  }
  for (const [commandId, occurrences] of duplicateCounts) {
    notes.push({ kind: "duplicate_command", commandId, layer: "requirement", occurrences });
  }

  // §6.1 step 2: ascending `revisionOrdinal`, and within a revision every
  // operation in its recorded order. Last write wins PER SLOT, not per plan.
  const target: ReplayTarget = { execution, requirement };
  const orphaned = new Map<string, { layer: VerificationAmendmentLayer; operations: VerificationSlotAmendmentRecord[] }>();
  for (const revision of state?.revisions ?? []) {
    for (let index = 0; index < revision.operations.length; index += 1) {
      replayOperation(
        target,
        revision.operations[index],
        {
          revisionId: revision.revisionId,
          revisionOrdinal: revision.revisionOrdinal,
          operationIndex: index,
          kind: revision.operations[index].kind,
        },
        notes,
        orphaned,
      );
    }
  }
  for (const [commandId, entry] of orphaned) {
    notes.push({ kind: "orphaned_slot", commandId, layer: entry.layer, operations: entry.operations });
  }

  notes.push(...ambiguityNotes(execution, "execution"), ...ambiguityNotes(requirement, "requirement"));

  return {
    status: "resolved",
    plan: {
      execution: execution.map(freezeSlot),
      requirement: requirement.map(freezeSlot),
      planDigest: planDigestOf(execution, requirement),
      appliedThroughOrdinal: state?.revisions.length ?? 0,
      notes,
    },
  };
}

/**
 * §6.1 step 3: the active execution slots, in order, as the shipped
 * `VerificationCommands` map the runner executes. Retired slots are EXCLUDED,
 * never credited (§8.4 rule 2).
 */
export function effectiveVerificationCommands(plan: EffectiveVerificationPlan): Record<string, string> {
  const commands: Record<string, string> = {};
  for (const slot of plan.execution) {
    if (slot.state !== "active") continue;
    if (slot.name === undefined) continue;
    commands[slot.name] = slot.command;
  }
  return commands;
}

/** §12.1: the active/retired counts per layer an applied event carries. */
export function verificationPlanSlotCounts(plan: EffectiveVerificationPlan): VerificationPlanSlotCounts {
  const count = (slots: readonly EffectiveVerificationSlot[]): { active: number; retired: number } => ({
    active: slots.filter((slot) => slot.state === "active").length,
    retired: slots.filter((slot) => slot.state === "retired").length,
  });
  return { execution: count(plan.execution), requirement: count(plan.requirement) };
}

/**
 * §6.4 rule 4: the dispositions a rebase event reports, by identity only.
 *
 * These are the ones RESOLUTION can see — the §6.1 step 1 mask and the
 * orphaned slot — because they are properties of the live inputs alone. The
 * remaining rule 4 masked case, a session entry whose bytes changed under a
 * `replace`d slot, is baseline-relative and is added by
 * {@link reconcileVerificationPlan}.
 */
export function verificationPlanDispositions(plan: EffectiveVerificationPlan): {
  masked: readonly string[];
  orphaned: readonly string[];
} {
  const masked: string[] = [];
  const orphaned: string[] = [];
  for (const note of plan.notes) {
    if (note.kind === "masked_session_entry") masked.push(note.commandId);
    else if (note.kind === "orphaned_slot") orphaned.push(note.commandId);
  }
  return { masked, orphaned };
}

// ---------------------------------------------------------------------------
// Authoring: §5.2's operation table and §5.3 rule 7's sequential composition
// ---------------------------------------------------------------------------

export type VerificationRevisionRefusal =
  | "invalid_operation"
  | "unknown_slot"
  | "slot_retired"
  | "slot_active"
  | "duplicate_slot"
  | "no_op"
  | "pinned_entry";

export interface ProposeVerificationRevisionInput {
  /** The plan the revision is authored against — its digest is the base. */
  plan: EffectiveVerificationPlan;
  /** Raw operations; validated against the §5.2 schema before composition. */
  operations: unknown;
  /**
   * §5.2 rule 6 / §6.1 rule 4: the `"verification.pinned"` (#915) identities
   * this task carries, as `commandId`s. An operation naming one refuses the
   * whole revision — correcting an approved plan entry is approval renewal.
   */
  pinnedCommandIds?: readonly string[];
  /** Labels the projected slot records; the derivations belong to §11's slice. */
  revisionId?: string;
}

export type ProposeVerificationRevisionResult =
  | {
      status: "ok";
      /** The validated operations, exactly as they will be recorded. */
      operations: readonly VerificationAmendmentOperation[];
      /** The plan the operations produce (§5.3 rule 5). */
      plan: EffectiveVerificationPlan;
      /** §5.3 rule 4: the digest of the plan the operator read. */
      basePlanDigest: string;
      /** §5.3 rule 5: the digest of the plan they get. */
      planDigest: string;
    }
  /**
   * §5.3 rule 7: the whole revision refuses — nothing is written, no ordinal
   * is consumed, and partial application is never a permitted outcome.
   */
  | {
      status: "refused";
      reason: VerificationRevisionRefusal;
      detail: string;
      /** Which operation refused, in recorded order. */
      operationIndex?: number;
    };

/**
 * Validate and compose one proposed revision against a resolved plan.
 *
 * Every operation is validated against the plan state its predecessors IN THE
 * SAME REVISION produced, in recorded order (§5.3 rule 7) — never against the
 * base plan — so `restore S` then `replace S` is valid, `replace S` then
 * `retire S` is valid and leaves the replaced bytes in state `retired`, and
 * `retire S` then `replace S` refuses the whole revision.
 *
 * Nothing here writes: the caller derives `revisionId`/`requestKey` (§5.3
 * rules 1–2) and commits through `applyVerificationAmendmentRevision`.
 */
export function proposeVerificationRevision(
  input: ProposeVerificationRevisionInput,
): ProposeVerificationRevisionResult {
  const parsed = validateVerificationAmendmentOperations(input.operations);
  if (!parsed.valid) {
    return { status: "refused", reason: "invalid_operation", detail: parsed.detail };
  }
  const operations = parsed.operations;
  const pinned = new Set(input.pinnedCommandIds ?? []);

  const execution = input.plan.execution.map(thawSlot);
  const requirement = input.plan.requirement.map(thawSlot);
  const target: ReplayTarget = { execution, requirement };
  const revisionOrdinal = input.plan.appliedThroughOrdinal + 1;

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const record: VerificationSlotAmendmentRecord = {
      ...(input.revisionId !== undefined ? { revisionId: input.revisionId } : {}),
      revisionOrdinal,
      operationIndex: index,
      kind: operation.kind,
    };
    const refusal = applyAuthoredOperation(target, operation, record, pinned, index);
    if (refusal) return refusal;
  }

  const planDigest = planDigestOf(execution, requirement);
  return {
    status: "ok",
    operations,
    plan: {
      execution: execution.map(freezeSlot),
      requirement: requirement.map(freezeSlot),
      planDigest,
      appliedThroughOrdinal: revisionOrdinal,
      // The input-derived dispositions (masked, orphaned, duplicate,
      // colliding) are properties of the resolution inputs, which a proposal
      // does not touch, so they carry over; only the equivalence detections
      // are recomputed over the produced bytes.
      notes: [
        ...input.plan.notes.filter((note) => note.kind !== "ambiguous_equivalence"),
        ...ambiguityNotes(execution, "execution"),
        ...ambiguityNotes(requirement, "requirement"),
      ],
    },
    basePlanDigest: input.plan.planDigest,
    planDigest,
  };
}

function applyAuthoredOperation(
  target: ReplayTarget,
  operation: VerificationAmendmentOperation,
  record: VerificationSlotAmendmentRecord,
  pinned: ReadonlySet<string>,
  index: number,
): Extract<ProposeVerificationRevisionResult, { status: "refused" }> | undefined {
  const refuse = (
    reason: VerificationRevisionRefusal,
    detail: string,
  ): Extract<ProposeVerificationRevisionResult, { status: "refused" }> => ({
    status: "refused",
    reason,
    detail,
    operationIndex: index,
  });

  if (operation.kind === "add") {
    const commandId = deriveAddedCommandId(operation);
    if (pinned.has(commandId)) {
      return refuse("pinned_entry", `${commandId} is a "verification.pinned" entry (§5.2 rule 6)`);
    }
    const slots = slotsOfLayer(target, operation.layer);
    const existing = slots.find((slot) => slot.commandId === commandId);
    if (existing) {
      return refuse(
        "duplicate_slot",
        existing.state === "retired"
          ? `${commandId} already names a retired slot — reinstating it is "restore", never "add" (§5.2)`
          : `${commandId} already names a slot in the plan`,
      );
    }
    const command = commandBytes(operation.command);
    slots.push({
      commandId,
      layer: operation.layer,
      ...(operation.layer === "execution" ? { name: operation.name } : {}),
      state: "active",
      command,
      origin: "task-amendment",
      originCommand: command,
      amendments: [record],
    });
    return undefined;
  }

  const commandId = operation.commandId;
  if (pinned.has(commandId)) {
    return refuse("pinned_entry", `${commandId} is a "verification.pinned" entry (§5.2 rule 6)`);
  }
  const layer = commandIdLayer(commandId);
  const slot = slotsOfLayer(target, layer).find((entry) => entry.commandId === commandId);
  if (!slot) return refuse("unknown_slot", `${commandId} names no slot in the plan`);

  if (operation.kind === "replace") {
    if (slot.state === "retired") {
      return refuse("slot_retired", `${commandId} is retired — restore it first, in this revision or an earlier one`);
    }
    const command = commandBytes(operation.command);
    if (command === slot.command) {
      return refuse("no_op", `${commandId} already carries these bytes — a no-op is not a revision`);
    }
    slot.command = command;
  } else if (operation.kind === "retire") {
    if (slot.state === "retired") return refuse("slot_retired", `${commandId} is already retired`);
    slot.state = "retired";
  } else if (operation.kind === "restore") {
    if (slot.state === "active") return refuse("slot_active", `${commandId} is already active`);
    slot.state = "active";
  }
  slot.amendments.push(record);
  return undefined;
}

// ---------------------------------------------------------------------------
// §6.2 rule 3: satisfaction, on the shipped equivalence semantics
// ---------------------------------------------------------------------------

/** §8.3 rule 1: one per-slot inadmissibility record on a manual entry. */
export interface EvidenceSlotInvalidation {
  /** The requirement slot the entry stops satisfying (§5.1). */
  commandId: string;
  /** The §5.3 `revisionId` that did it. */
  supersededByRevision: string;
}

/**
 * The structural shape this module needs of a `manualVerificationEvidence`
 * entry. Deliberately minimal so the shipped `ManualVerificationEntry` (which
 * carries output, timestamps, and a source) satisfies it unchanged. The
 * optional issue-#1040 binding fields are `unknown` because persisted entries
 * are untrusted input; `core/verification-evidence.ts` validates them.
 */
export interface ManualVerificationEvidenceLike {
  command: string;
  exitCode: number;
  /** §8.3 rule 1: append-only, empty for an entry nothing has superseded. */
  invalidations?: readonly EvidenceSlotInvalidation[];
  /** Issue #1040: digest of the effective plan the entry was recorded under. */
  planDigest?: unknown;
  /** Issue #1040: `appliedThroughOrdinal` of that plan. */
  planRevisionOrdinal?: unknown;
  /** Issue #1040: §5.1 identity of the slot the entry was recorded for. */
  commandId?: unknown;
  /** Issue #1040: the reviewed branch HEAD the entry was recorded against. */
  headSha?: unknown;
}

// ---------------------------------------------------------------------------
// The execution → requirement satisfaction relation (§6.2 rule 3, and
// `docs/changed-file-verification-contract.md` §6 rule 5 — issue #1166)
// ---------------------------------------------------------------------------

/**
 * The operator's declaration that the bound test suite entry discharges Issue
 * requirements written with other command text.
 *
 * It is carried as plain data rather than read from the session here, so this
 * module keeps no dependency on the staged-verification block and every surface
 * that relates an execution slot to a requirement — the review gate, the stage
 * selection and the stage bundle — applies ONE rule.
 */
export interface FullSuiteRequirementDeclaration {
  /** The `session.verification` key the suite binding names. */
  readonly boundKey: string;
  /** The declared Issue-requirement command texts, verbatim. */
  readonly requirementCommands: readonly string[];
}

/**
 * §6.2 rule 3's satisfaction test between one active EXECUTION slot and one
 * requirement command, with issue #1166's declared alias.
 *
 * The shipped rule is unchanged and is still tried first: the slot's own
 * command against the requirement under `matchesConfiguredVerificationCommand`.
 * The declaration adds nothing generic — it is consulted only for the slot the
 * operator BOUND as the test suite, and only against command texts the operator
 * wrote down. No npm alias, script name, project file or agent judgment takes
 * part, so the rule stays language-neutral: `npm test` is equivalent to
 * `npm run test:files` here only because an operator said so for one entry of
 * one session.
 *
 * What it does NOT do is supply evidence. A requirement matched through the
 * declaration is still satisfied only by whatever the caller's own rule admits
 * — a proven execution record, an admissible manual attestation — exactly as a
 * requirement matched by the slot's own bytes is.
 */
export function executionSatisfiesRequirement(
  execution: Pick<EffectiveVerificationSlot, "name" | "command">,
  requirementCommand: string,
  declaration?: FullSuiteRequirementDeclaration,
): boolean {
  if (matchesConfiguredVerificationCommand(execution.command, requirementCommand)) return true;
  if (declaration === undefined || execution.name !== declaration.boundKey) return false;
  return declaration.requirementCommands.some((declared) =>
    matchesConfiguredVerificationCommand(declared, requirementCommand),
  );
}

/** §8.4 rule 1: `retired` is a state distinct from `passed` and `not_run`. */
export type EffectiveRequirementStatus = "passed" | "not_run" | "retired";

export interface EffectiveRequirementVerification {
  commandId: string;
  command: string;
  state: VerificationSlotState;
  status: EffectiveRequirementStatus;
  /** How an active slot was satisfied; absent when it was not. */
  satisfiedBy?: "execution" | "manual-evidence";
  /**
   * Issue #1040: why matching-but-inadmissible evidence was rejected, distinct
   * reasons in evaluation order. Present only under binding enforcement, and
   * only when at least one matching entry was rejected.
   */
  evidenceRejections?: readonly VerificationEvidenceRejection[];
}

/**
 * Issue #1040: what evidence recorded during this run must be bound to. When
 * passed to {@link buildEffectiveRequirementStatus}, manual evidence is
 * admitted only under the full `core/verification-evidence.ts` binding rule
 * (plan resolvability, slot identity, §8.3 invalidations, reviewed HEAD);
 * omitted, the shipped pre-#1040 semantics apply unchanged.
 */
export interface EffectiveRequirementEvidenceExpectations {
  /** The reviewed HEAD of the current run; absent = unresolvable, fail closed. */
  headSha?: string;
}

/**
 * Issue #1040: the binding block a review escalation records in task context
 * (`VERIFICATION_EVIDENCE_BINDING_CONTEXT_KEY`) so `admin review-verification
 * resolve` can stamp evidence with the identities the review actually tested:
 * the plan digest and ordinal, and each ACTIVE requirement slot's current
 * command bytes mapped to its §5.1 identity. Retired slots are excluded — a
 * removed command must never become recordable-as-passed through the block.
 *
 * Bytes carried by MORE than one active slot (an amendment can leave two
 * slots byte-identical) never enter the byte-keyed map: whichever entry
 * survived the overwrite would silently claim the other slot's evidence, and
 * the resolve surface could then bind only one of the two identities, leaving
 * the other slot's handoff unclearable by the advertised manual-evidence flow
 * (issue #1043 review, P2). They are listed in `ambiguousCommands` instead,
 * so the resolve refuses them explicitly and names the repair.
 */
export function buildVerificationEvidenceBindingBlock(
  plan: EffectiveVerificationPlan,
  headSha?: string,
): VerificationEvidenceBindingBlock {
  const commandIds: Record<string, string> = {};
  const ambiguousCommands: string[] = [];
  for (const slot of plan.requirement) {
    if (slot.state !== "active") continue;
    if (ambiguousCommands.includes(slot.command)) continue;
    if (Object.prototype.hasOwnProperty.call(commandIds, slot.command)) {
      delete commandIds[slot.command];
      ambiguousCommands.push(slot.command);
      continue;
    }
    commandIds[slot.command] = slot.commandId;
  }
  return {
    ...(headSha !== undefined ? { headSha } : {}),
    planDigest: plan.planDigest,
    planRevisionOrdinal: plan.appliedThroughOrdinal,
    commandIds,
    ...(ambiguousCommands.length > 0 ? { ambiguousCommands } : {}),
  };
}

/**
 * §6.2 rule 3: a requirement slot is `passed` when a value of the effective
 * EXECUTION set matches it under the shipped
 * `matchesConfiguredVerificationCommand` rule (§13.2 — reused verbatim, never
 * redefined), or when a passing (exit 0) manual evidence entry matches it and
 * carries no §8.3 rule 1 invalidation record naming that slot's `commandId`.
 * Otherwise `not_run`. Retired slots are excluded from the gate and reported
 * `retired`, never `passed` and never `not_run` (§8.4).
 *
 * On a task with no amendments this is the shipped
 * `buildIssueVerificationStatus` behavior, slot for slot: the effective
 * execution set is then exactly `session.verification`, and no slot is
 * retired or invalidated.
 *
 * With `evidenceExpectations` (issue #1040), a manual entry additionally
 * satisfies a slot only when the `core/verification-evidence.ts` binding rule
 * admits it for that slot — recorded identity, §8.3 invalidations, and the
 * reviewed HEAD all checked, legacy unbound evidence conservatively rejected.
 * The matching rule itself stays `matchesConfiguredVerificationCommand`,
 * applied to the slot's CURRENT bytes, so a replaced slot rejects stale
 * evidence while a resolver-proven-equivalent form still matches.
 *
 * With `fullSuite` (issue #1166) the execution side of the match is
 * {@link executionSatisfiesRequirement}, so the bound suite entry also
 * satisfies the requirement texts the operator declared for it. Nothing else
 * changes: the manual-evidence rule, the invalidation clause and the retired
 * state are untouched, and without the declaration this is the shipped
 * behavior byte for byte.
 */
export function buildEffectiveRequirementStatus(
  plan: EffectiveVerificationPlan,
  manualEvidence?: readonly ManualVerificationEvidenceLike[],
  evidenceExpectations?: EffectiveRequirementEvidenceExpectations,
  fullSuite?: FullSuiteRequirementDeclaration,
): EffectiveRequirementVerification[] {
  const executed = plan.execution.filter((slot) => slot.state === "active");
  const evidence = manualEvidence ?? [];
  return plan.requirement.map((slot): EffectiveRequirementVerification => {
    if (slot.state === "retired") {
      return { commandId: slot.commandId, command: slot.command, state: "retired", status: "retired" };
    }
    if (executed.some((value) => executionSatisfiesRequirement(value, slot.command, fullSuite))) {
      return {
        commandId: slot.commandId,
        command: slot.command,
        state: "active",
        status: "passed",
        satisfiedBy: "execution",
      };
    }
    const candidates = evidence.filter((candidate) =>
      matchesConfiguredVerificationCommand(candidate.command, slot.command),
    );
    if (evidenceExpectations === undefined) {
      const entry = candidates.find(
        (candidate) =>
          candidate.exitCode === 0 &&
          !isVerificationSlotInvalidated(candidate.invalidations, slot.commandId),
      );
      if (entry) {
        return {
          commandId: slot.commandId,
          command: slot.command,
          state: "active",
          status: "passed",
          satisfiedBy: "manual-evidence",
        };
      }
      return { commandId: slot.commandId, command: slot.command, state: "active", status: "not_run" };
    }
    const rejections: VerificationEvidenceRejection[] = [];
    for (const candidate of candidates) {
      const verdict = evaluateVerificationEvidenceBinding(candidate, {
        headSha: evidenceExpectations.headSha,
        planDigest: plan.planDigest,
        commandId: slot.commandId,
      });
      if (verdict.admissible) {
        return {
          commandId: slot.commandId,
          command: slot.command,
          state: "active",
          status: "passed",
          satisfiedBy: "manual-evidence",
        };
      }
      if (!rejections.includes(verdict.reason)) rejections.push(verdict.reason);
    }
    return {
      commandId: slot.commandId,
      command: slot.command,
      state: "active",
      status: "not_run",
      ...(rejections.length > 0 ? { evidenceRejections: rejections } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// §6.4: session-default drift and the three-way reconciliation
// ---------------------------------------------------------------------------

export type ReconcileVerificationPlanInput = EffectiveVerificationPlanInput;

export type VerificationPlanReconciliation =
  /**
   * §5.5 rule 5: a task with no revision has no checkpoint and needs none —
   * resolution is total, so there is nothing to reconcile against.
   */
  | { status: "unamended"; plan: EffectiveVerificationPlan }
  /** The baseline did not move and the recomputation reproduces the digest. */
  | { status: "consistent"; plan: EffectiveVerificationPlan }
  /**
   * §6.4 rule 3: the session layer moved. NOT a refusal — proceed on the live
   * plan and rebase (rule 5). A plan-neutral drift classifies here too, so the
   * checkpoint is re-anchored and the dispositions reported even when the two
   * plan digests are equal.
   */
  | {
      status: "drifted";
      plan: EffectiveVerificationPlan;
      /** The values a rebase writes onto the checkpoint (§6.4 rule 5). */
      checkpoint: VerificationPlanCheckpointInput;
      previousPlanDigest: string;
      previousSessionBaselineDigest: string;
      /**
       * §6.4 rule 4, by identity only: every masked session entry — both the
       * §6.1 step 1 `add` collision and the baseline-relative change under a
       * `replace`d slot — and every orphaned slot.
       */
      dispositions: { masked: readonly string[]; orphaned: readonly string[] };
    }
  /**
   * §6.4 rule 3: the stored digest is derivable from no recorded input, so it
   * was written outside this surface. Refuse, fail closed, repair nothing.
   */
  | { status: "unreconciled"; detail: string }
  | { status: "invalid"; reason: VerificationPlanInputRefusal; detail: string };

/**
 * §6.4 rule 4 bullet 2: session entries whose bytes changed under a slot a
 * revision `replace`d. The amendment still wins (§3.2) — which is exactly why
 * the change has to be reported, so the operator who fixed the session sees
 * why this task is unaffected and can reverse the amendment with a further
 * revision (§5.3 rule 6).
 *
 * The disposition is baseline-relative, so only reconciliation can compute it:
 * resolution (§6.1) reads the live `session.verification` map and nothing else,
 * and cannot tell a changed entry from one that was always these bytes. A
 * changed entry under a slot no amendment gave bytes to is rule 4 bullet 1 —
 * the live bytes simply win, and there is nothing masked to report. A changed
 * entry whose identity an execution-layer `add` claims materializes no slot at
 * all and is already reported by the §6.1 step 1 note.
 *
 * "Changed" is relative to the RECORDED baseline, so a key absent from it
 * counts: a key that was removed while its slot was replaced, rebased away,
 * and has now returned with different bytes is masked by the replay of that
 * same `replace`, and an audit that skipped it would show no reason the
 * returning session command did not take effect.
 */
function maskedSessionReplacements(
  plan: EffectiveVerificationPlan,
  recordedBaseline: readonly VerificationPlanSessionBaselineEntry[],
  liveBaseline: readonly VerificationPlanSessionBaselineEntry[],
): string[] {
  const recorded = new Map(recordedBaseline.map((entry) => [entry.name, entry.command]));
  const masked: string[] = [];
  for (const entry of liveBaseline) {
    // Byte-identical to the recorded baseline is no change at all, so there is
    // nothing this reconciliation newly hides. Both sides are normalized by
    // `commandBytes`, so the comparison never fires on trimming alone.
    if (recorded.get(entry.name) === entry.command) continue;
    const commandId = deriveExecutionCommandId(entry.name);
    const slot = plan.execution.find((candidate) => candidate.commandId === commandId);
    if (!slot) continue;
    if (!slot.amendments.some((record) => record.kind === "replace")) continue;
    // A `replace` in the slot's history does not by itself mask the live
    // entry: a session edit that lands ON the replacement's bytes leaves the
    // live value effective. Only resolved bytes that DIFFER hide it.
    if (slot.command === entry.command) continue;
    masked.push(commandId);
  }
  return masked;
}

/**
 * Classify a task's stored plan state against its live inputs (§6.4 rule 3),
 * in the contract's order: `unreconciled` first, then `drifted`, then
 * `consistent`. The three are exhaustive and disjoint, the stored
 * `planDigest` is always the CHECKPOINT's (§5.5 rule 1), and the baseline test
 * is rule 2's — the digest of the live `session.verification` against the
 * stored `sessionBaselineDigest`, never the plan digest, so a session change
 * the effective plan does not show still rebases.
 *
 * Pure: it classifies and reports. Only a surface that already holds a write
 * transaction records the result (§6, §6.4 rule 5).
 */
export function reconcileVerificationPlan(
  input: ReconcileVerificationPlanInput,
): VerificationPlanReconciliation {
  const live = resolveEffectiveVerificationPlan(input);
  if (live.status === "invalid") return live;

  const validation = validateVerificationAmendmentState(input.amendments);
  // Already proven valid by the resolve above; narrow for the checkpoint read.
  if (!validation.valid) return { status: "invalid", reason: "amendment_state", detail: validation.detail };
  const state = validation.state;
  if (!state) return { status: "unamended", plan: live.plan };

  const checkpoint = state.checkpoint;
  const liveBaseline = normalizeSessionEntries(input.sessionVerification);
  if ("detail" in liveBaseline) {
    return { status: "invalid", reason: "session_verification", detail: liveBaseline.detail };
  }
  const liveBaselineDigest = deriveSessionBaselineDigest(liveBaseline.entries);

  if (live.plan.planDigest !== checkpoint.planDigest) {
    // Replay the same chain over the RECORDED baseline, with `context.body`
    // unchanged as it always is. If that does not reproduce the stored digest
    // either, no recorded input derives it.
    const replayed = resolveEffectiveVerificationPlan({
      ...input,
      sessionVerification: checkpoint.sessionBaseline,
    });
    if (replayed.status !== "resolved" || replayed.plan.planDigest !== checkpoint.planDigest) {
      return {
        status: "unreconciled",
        detail: `stored planDigest ${checkpoint.planDigest} is reproduced neither by the live inputs (${live.plan.planDigest}) nor by a replay over the recorded session baseline`,
      };
    }
  }

  if (liveBaselineDigest !== checkpoint.sessionBaselineDigest) {
    const resolved = verificationPlanDispositions(live.plan);
    // The two masked sources are disjoint by construction — the §6.1 step 1
    // note fires only where NO slot materialized — but the merge dedupes so
    // one identity is never reported twice.
    const masked = [...resolved.masked];
    for (const commandId of maskedSessionReplacements(
      live.plan,
      checkpoint.sessionBaseline,
      liveBaseline.entries,
    )) {
      if (!masked.includes(commandId)) masked.push(commandId);
    }
    return {
      status: "drifted",
      plan: live.plan,
      checkpoint: {
        planDigest: live.plan.planDigest,
        sessionBaseline: liveBaseline.entries,
        sessionBaselineDigest: liveBaselineDigest,
      },
      previousPlanDigest: checkpoint.planDigest,
      previousSessionBaselineDigest: checkpoint.sessionBaselineDigest,
      dispositions: { masked, orphaned: resolved.orphaned },
    };
  }

  return { status: "consistent", plan: live.plan };
}
