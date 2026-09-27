import { createHash } from "crypto";
import { matchesConfiguredVerificationCommand } from "./tool-request-continuation.js";
import type { AiTask, TaskKey } from "./task.js";
import type { ResolvedSession } from "./session.js";
import {
  applyVerificationAmendmentRevision,
  canonicalJsonStringify,
  deriveRequirementCommandId,
  rebaseVerificationPlanCheckpoint,
  validateVerificationAmendmentState,
  verificationAmendmentStatusRefusal,
  verificationContinuationRequeueRow,
  MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS,
  MAX_VERIFICATION_AMENDMENT_REASON_CHARS,
  VERIFICATION_AMENDMENTS_CONTEXT_KEY,
  type VerificationAmendmentContinuation,
  type VerificationAmendmentOperation,
  type VerificationAmendmentRevision,
  type VerificationAmendmentSource,
  type VerificationAmendmentState,
  type VerificationAmendmentStore,
  type VerificationPlanCheckpoint,
  type VerificationPlanSessionBaselineEntry,
} from "./verification-amendment.js";
import { verificationAmendmentPublicSlots } from "./verification-amendment-publication.js";
import {
  buildVerificationSessionBaseline,
  proposeVerificationRevision,
  reconcileVerificationPlan,
  verificationPlanSlotCounts,
  type EffectiveVerificationPlan,
  type EffectiveVerificationSlot,
} from "./verification-plan.js";

/**
 * Refresh a task's verification requirements from the LIVE Issue —
 * `docs/verification-amendment-contract.md` §10 (§15 slice A6, issue #1041),
 * on top of the §5.5 persistence slice (#1038) and the §6 resolution slice
 * (#1039).
 *
 * A refresh is a **source** for an ordinary revision, not a second mechanism
 * (§10 opening): it re-reads the Issue body through a provider-neutral port,
 * re-runs the shipped extractor over it, diffs the result against the
 * **effective** requirement layer, and proposes a revision carrying
 * requirement-layer operations only. It then goes through §5–§7 like any other
 * revision — same validation, same CAS, same audit event, same refusals, and
 * the same §5.3 rule 3 replay recognition, which runs ahead of every plan
 * comparison so a retried apply is reported as the repeat it is rather than as
 * the §10 rule 7 no-op its own first attempt made it look like.
 *
 * What this module deliberately does NOT do, because §10 forbids it:
 *
 * - it never writes `context.body`, the title, labels, the phase, or any
 *   implementation-scope field (§10 rule 1) — the intake snapshot stays pinned
 *   and the amendment layer is what makes the corrected requirement effective;
 * - it never emits a `replace` (§10 rule 3) — a lineage-preserving correction
 *   is a judgment only an operator can make, so it stays an explicit `amend`;
 * - it never applies a retirement without an explicit opt-in (§10 rule 4);
 * - it never applies a partial diff: a provider failure, a missing Issue, a
 *   body with no supported section, or a diff the §10 rule 3 matcher cannot
 *   map refuses the whole refresh and consumes no ordinal (§10 rule 5).
 *
 * Provider neutrality is structural: the only live read is
 * {@link VerificationRefreshIssueSource.readIssue}, whose shape is
 * `{ number, body }` and nothing else, and the extractor arrives as an
 * injected function so this module keeps the core↛handlers direction the §6
 * resolver established. A session whose work-item provider has no adapter is
 * an explicit `unsupported_provider` refusal, never a silent skip.
 *
 * Continuation (§9, issue #1043): the refresh grammar carries no `--continue`,
 * so an applied refresh takes its row's §9.2 DEFAULT —
 * {@link defaultVerificationContinuation} — and records the route it took. On
 * the two re-queueable review-lane rows that is `"review"`: the apply
 * re-queues `{queued, review}` in the same transaction that persists the
 * amended plan (§9.2 rule 2). Everywhere else the row records `"none"` and
 * the task stays exactly where its owning surface put it (§9.2 rule 3).
 */

// ---------------------------------------------------------------------------
// The provider-neutral live read (§10 rule 1)
// ---------------------------------------------------------------------------

/**
 * A live work-item read, in provider-neutral terms. Exactly the projection §10
 * consumes: the item's number and its raw body. No labels, no title, no state
 * — a port that cannot read them is the cheapest proof that a refresh cannot
 * act on them (§10 rule 1).
 */
export interface VerificationRefreshIssueRead {
  number: number;
  /** The raw body text. Absent or empty when the item has no body. */
  body?: string | undefined;
}

/**
 * The one live dependency of a refresh. Read-only by construction.
 *
 * Failures THROW rather than resolving to an empty body: an unread Issue must
 * never be read as "the Issue requires nothing", which is precisely the input
 * that would propose retiring every requirement (§10 rule 5).
 */
export interface VerificationRefreshIssueSource {
  readIssue(issueNumber: number): Promise<VerificationRefreshIssueRead>;
}

/** The extractor projection §10 rule 1 consumes; injected, never imported. */
export type VerificationRefreshExtractor = (body: string) => {
  commands: readonly string[];
  sectionFound: boolean;
};

// ---------------------------------------------------------------------------
// §5.3 rules 1–2: the derivations the authoring surfaces share
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * §5.2: the identity form of an operation list — the canonical serialization
 * with every operation's `reason` omitted **and nothing else omitted**. Both
 * §5.3 derivations hash this, so retyping a reason on a retry can never
 * manufacture a new revision identity or a new request key.
 */
export function verificationOperationsIdentityForm(
  operations: readonly VerificationAmendmentOperation[],
): unknown[] {
  return operations.map((operation) => {
    const { reason: _reason, ...rest } = operation as unknown as Record<string, unknown>;
    return rest;
  });
}

export interface VerificationRevisionIdInput {
  sessionId: string;
  issueNumber: number;
  requestKey: string;
  basePlanDigest: string;
  operations: readonly VerificationAmendmentOperation[];
}

/**
 * §5.3 rule 1: `"vamd-" + sha256(canonicalJson({sessionId, issueNumber,
 * requestKey, basePlanDigest, operations})).slice(0, 16)`, over the identity
 * form of the operations.
 *
 * It excludes every reason, the actor, the timestamp, the continuation, every
 * run identifier, and — normatively — `revisionOrdinal`, which is assigned at
 * write time: hashing it would give every retry of an applied-but-
 * unacknowledged invocation a fresh id, the exact duplicate the request key
 * exists to prevent.
 */
export function deriveVerificationRevisionId(input: VerificationRevisionIdInput): string {
  const digest = sha256Hex(
    canonicalJsonStringify({
      sessionId: input.sessionId,
      issueNumber: input.issueNumber,
      requestKey: input.requestKey,
      basePlanDigest: input.basePlanDigest,
      operations: verificationOperationsIdentityForm(input.operations),
    }),
  );
  return `vamd-${digest.slice(0, 16)}`;
}

export interface VerificationRequestKeyInput {
  sessionId: string;
  issueNumber: number;
  source: VerificationAmendmentSource;
  /** The `--continue` value exactly as typed; `null` when the flag is absent. */
  requestedContinuation: VerificationAmendmentContinuation | null;
  operations: readonly VerificationAmendmentOperation[];
}

/**
 * §5.3 rule 2: the derived request key,
 * `sha256(canonicalJson({sessionId, issueNumber, source,
 * requestedContinuation, operations}))` over the same identity form.
 *
 * `basePlanDigest` is deliberately NOT an input. The invocation this key has
 * to survive is the one whose `--yes` committed and whose response was lost:
 * the operator reruns the same command line and now reads the plan their own
 * first attempt produced. A key that hashed the base plan would derive a
 * different value on that second read and let the amendment apply twice.
 */
export function deriveVerificationRequestKey(input: VerificationRequestKeyInput): string {
  return sha256Hex(
    canonicalJsonStringify({
      sessionId: input.sessionId,
      issueNumber: input.issueNumber,
      source: input.source,
      requestedContinuation: input.requestedContinuation,
      operations: verificationOperationsIdentityForm(input.operations),
    }),
  );
}

/** §11 rule 3: the character rule an operator-supplied token must satisfy. */
export const VERIFICATION_REQUEST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * §9.2: the default continuation the task's row takes — `"review"` on the two
 * re-queueable review-lane rows, `"none"` everywhere else. Since issue #1043
 * this is the route an applying revision actually takes when the operator
 * types no `--continue`; a row the table parks defaults to `"none"`, and no
 * flag can unpark it (§9.2 rule 3). The row test itself is
 * {@link verificationContinuationRequeueRow}, shared with the apply-time
 * guard so the reported default and the enforced route cannot drift.
 */
export function defaultVerificationContinuation(
  task: Pick<AiTask, "status" | "phase">,
): VerificationAmendmentContinuation {
  return verificationContinuationRequeueRow(task) ? "review" : "none";
}

// ---------------------------------------------------------------------------
// §10 rule 3: the matcher
// ---------------------------------------------------------------------------

/** A live command that an active slot already carries; produces no operation. */
export interface VerificationRefreshUnchanged {
  commandId: string;
  /** The live text that matched. */
  liveCommand: string;
  /** The slot's effective bytes — differ from `liveCommand` under equivalence. */
  planCommand: string;
}

/** A live command that reinstates a retired slot (§10 rule 3 cases 2 and 3). */
export interface VerificationRefreshRestore {
  commandId: string;
  liveCommand: string;
  /** The bytes the slot returns with; a `restore` never rewrites them. */
  reinstatedCommand: string;
  matchedBy: "bytes" | "identity";
  /**
   * §10 rule 3 case 3: a retired slot's bytes may have been corrected before
   * its retirement, so a restoration can reinstate bytes that differ from the
   * live text. Reported, and STILL no `replace` (§10 rule 3).
   */
  reinstatedBytesDiffer: boolean;
}

/** A live command no slot holds (§10 rule 3 case 4). */
export interface VerificationRefreshAdd {
  /** The identity the `add` will materialize (§5.1), derived from the bytes. */
  commandId: string;
  command: string;
}

/** An active slot the live Issue no longer names (§10 rule 3 case 5). */
export interface VerificationRefreshRetirement {
  commandId: string;
  command: string;
}

export interface VerificationRefreshDiff {
  unchanged: readonly VerificationRefreshUnchanged[];
  restores: readonly VerificationRefreshRestore[];
  adds: readonly VerificationRefreshAdd[];
  /** §10 rule 4: proposed, never applied without the explicit opt-in. */
  proposedRetirements: readonly VerificationRefreshRetirement[];
}

export type VerificationRefreshDiffResult =
  | { status: "ok"; diff: VerificationRefreshDiff }
  /** §10 rule 5: a diff the rules cannot map refuses the refresh whole. */
  | { status: "ambiguous"; detail: string };

interface MatchableSlot {
  slot: EffectiveVerificationSlot;
  consumed: boolean;
}

/**
 * The §13.2 equivalence, applied symmetrically.
 *
 * The shipped rule is directional — it unwraps a `bash -lc '<cmd>'` on its
 * FIRST argument — and either side of this comparison can be the wrapped one:
 * the plan may carry the wrapper an operator amended in, or the Issue may
 * write it. A miss in either direction would read the Issue's demand as
 * live-only and its own slot as plan-only, producing exactly the
 * duplicate-and-retire pair §10 rule 3 case 1 exists to prevent, so both
 * directions are tried — the same closure `ambiguityNotes` uses in the §6
 * resolver.
 */
function equivalent(a: string, b: string): boolean {
  return matchesConfiguredVerificationCommand(a, b) || matchesConfiguredVerificationCommand(b, a);
}

/**
 * Diff the live commands against the effective requirement layer (§10 rule 3).
 *
 * Matching is one-to-one and runs in the rule's order as three passes over the
 * still-unmatched live commands — active-by-bytes, retired-by-bytes,
 * retired-by-identity — each consuming live commands in extraction order and
 * slots in resolution order. Execution-layer slots are never read: a refresh
 * projects the Issue, and the Issue owns no execution-layer entry (§3.1).
 */
export function diffIssueVerificationRefresh(input: {
  plan: EffectiveVerificationPlan;
  liveCommands: readonly string[];
}): VerificationRefreshDiffResult {
  const live = input.liveCommands.map((command) => command.trim()).filter((command) => command !== "");
  const slots: MatchableSlot[] = input.plan.requirement.map((slot) => ({ slot, consumed: false }));
  const matched = new Array<boolean>(live.length).fill(false);

  const unchanged: VerificationRefreshUnchanged[] = [];
  const restores: VerificationRefreshRestore[] = [];

  // Pass 1 (§10 rule 3 case 1): an ACTIVE slot whose current effective bytes
  // the live command matches. This is what lets an earlier `replace` survive a
  // refresh — the slot keeps A's commandId while carrying B's bytes, so an
  // Issue that now names B matches it and produces no operation at all.
  for (let i = 0; i < live.length; i += 1) {
    if (matched[i]) continue;
    const candidate = slots.find(
      (entry) => !entry.consumed && entry.slot.state === "active" && equivalent(entry.slot.command, live[i]),
    );
    if (!candidate) continue;
    candidate.consumed = true;
    matched[i] = true;
    unchanged.push({
      commandId: candidate.slot.commandId,
      liveCommand: live[i],
      planCommand: candidate.slot.command,
    });
  }

  // Pass 2 (case 2): a RETIRED slot whose current bytes match — the Issue is
  // asking for a check the plan already has, so it comes back rather than
  // being duplicated.
  for (let i = 0; i < live.length; i += 1) {
    if (matched[i]) continue;
    const candidate = slots.find(
      (entry) => !entry.consumed && entry.slot.state === "retired" && equivalent(entry.slot.command, live[i]),
    );
    if (!candidate) continue;
    candidate.consumed = true;
    matched[i] = true;
    restores.push({
      commandId: candidate.slot.commandId,
      liveCommand: live[i],
      reinstatedCommand: candidate.slot.command,
      matchedBy: "bytes",
      reinstatedBytesDiffer: candidate.slot.command !== live[i],
    });
  }

  // Pass 3 (case 3): a RETIRED slot whose `req:` identity the live command
  // derives. The slot's bytes may have been corrected before its retirement,
  // so the reinstated bytes can differ from the live text; that difference is
  // reported and still emits no `replace`.
  for (let i = 0; i < live.length; i += 1) {
    if (matched[i]) continue;
    const commandId = deriveRequirementCommandId(live[i]);
    const candidate = slots.find(
      (entry) => !entry.consumed && entry.slot.state === "retired" && entry.slot.commandId === commandId,
    );
    if (!candidate) continue;
    candidate.consumed = true;
    matched[i] = true;
    restores.push({
      commandId: candidate.slot.commandId,
      liveCommand: live[i],
      reinstatedCommand: candidate.slot.command,
      matchedBy: "identity",
      reinstatedBytesDiffer: candidate.slot.command !== live[i],
    });
  }

  // Case 4: everything still unmatched is an `add`. Its identity is derived
  // from its own bytes (§5.1), so a collision with a slot an earlier pass
  // already consumed is a diff the rules cannot map — two live commands
  // equivalent under §13.2 but not byte-identical, one of which took the only
  // slot. §5.2 would refuse the `add`; refusing here names the real cause
  // (§10 rule 5) instead of surfacing an authoring error.
  const adds: VerificationRefreshAdd[] = [];
  const addedIds = new Set<string>();
  for (let i = 0; i < live.length; i += 1) {
    if (matched[i]) continue;
    const commandId = deriveRequirementCommandId(live[i]);
    const collidingSlot = slots.find((entry) => entry.slot.commandId === commandId);
    if (collidingSlot) {
      return {
        status: "ambiguous",
        detail:
          `live command \`${live[i]}\` derives ${commandId}, which already names a plan slot that another ` +
          `live command matched under the shipped equivalence rule — the refresh cannot decide which live ` +
          `command owns that slot. Reconcile the Issue's verification section, or correct the slot with an ` +
          `explicit amendment.`,
      };
    }
    if (addedIds.has(commandId)) {
      return {
        status: "ambiguous",
        detail: `live command \`${live[i]}\` derives ${commandId} twice in one refresh`,
      };
    }
    addedIds.add(commandId);
    adds.push({ commandId, command: live[i] });
  }

  // Case 5: an unmatched ACTIVE slot is a PROPOSED retirement. An unmatched
  // retired slot produces nothing — it is already retired.
  const proposedRetirements: VerificationRefreshRetirement[] = slots
    .filter((entry) => !entry.consumed && entry.slot.state === "active")
    .map((entry) => ({ commandId: entry.slot.commandId, command: entry.slot.command }));

  return { status: "ok", diff: { unchanged, restores, adds, proposedRetirements } };
}

/**
 * The operations a diff applies, in a deterministic order: restores first
 * (they reinstate identities an `add` must not collide with), then adds, then
 * the retirements — only when the opt-in permits them (§10 rule 4).
 *
 * Every operation carries the invocation's reason: §5.2 rule 1 makes the
 * revision-level statement the reason of every operation that does not carry
 * one of its own, and a refresh authors no per-operation reason.
 */
export function verificationRefreshOperations(
  diff: VerificationRefreshDiff,
  options: { reason: string; allowRetire: boolean },
): VerificationAmendmentOperation[] {
  const operations: VerificationAmendmentOperation[] = [];
  for (const restore of diff.restores) {
    operations.push({ kind: "restore", commandId: restore.commandId, reason: options.reason });
  }
  for (const add of diff.adds) {
    operations.push({ kind: "add", layer: "requirement", command: add.command, reason: options.reason });
  }
  if (options.allowRetire) {
    for (const retirement of diff.proposedRetirements) {
      operations.push({ kind: "retire", commandId: retirement.commandId, reason: options.reason });
    }
  }
  return operations;
}

// ---------------------------------------------------------------------------
// §5.3 rules 1 and 3: replay recognition, ahead of every plan comparison
// ---------------------------------------------------------------------------

/**
 * The task's stored revision chain, or `undefined` when it carries none.
 *
 * A chain that does not validate also reads as `undefined` here. Malformed
 * stored state is the §11 rule 6 refusal the resolution step raises, and the
 * replay lookup must never be the surface that reads past a broken chain — it
 * simply finds nothing and lets that refusal happen.
 */
function storedAmendmentChain(task: AiTask): VerificationAmendmentState | undefined {
  const validation = validateVerificationAmendmentState(
    task.context?.[VERIFICATION_AMENDMENTS_CONTEXT_KEY],
  );
  return validation.valid ? validation.state : undefined;
}

/**
 * Recognize a keyless rerun of an already-applied refresh (§5.3 rules 1 and 3).
 *
 * The §5.3 rule 2 derivation is caller-stable for an `amend`, whose operations
 * are typed on the command line. A refresh's operations are NOT typed: they are
 * what its own read of the live Issue diffed out of the plan. So the invocation
 * this key has to survive — the one whose `--yes` committed and whose response
 * was lost — cannot re-derive the key it wrote: its rerun reads the plan its own
 * first attempt produced, diffs out nothing, and would derive a key over an
 * empty operation list.
 *
 * The stored revision is therefore recognized from the other direction. A
 * recorded `issue-refresh` revision is this rerun's own first attempt when it
 * pinned the same live body (§10 rule 6) **and** its recorded `requestKey` is
 * exactly what §5.3 rule 2 derives from the operations it recorded — which is
 * the proof that the key was derived rather than operator-supplied, and so that
 * a keyless rerun is the same request rather than a new one. An operator who
 * supplied a distinct `--request-key` asked for a distinct request and is not
 * matched here (§5.3 rule 3). The scan runs newest-first, so the reported
 * revision is the last one that read this body.
 *
 * This can only widen a `no_change` into a replay, never an apply into one: it
 * is consulted solely on the empty diff, where there is by construction nothing
 * left to apply. The main path reaches it with that diff in hand; the
 * active-task guard, which refuses before the plan is resolved, must first
 * establish the same precondition via {@link refreshInvocationIsExhausted} —
 * the body digest alone matches any later keyless refresh of an unchanged
 * body, including one whose own operation set differs (issue #1043 review).
 */
function findDerivedRefreshReplay(input: {
  chain: VerificationAmendmentState;
  key: TaskKey;
  issueBodyDigest: string;
}): VerificationAmendmentRevision | undefined {
  for (let i = input.chain.revisions.length - 1; i >= 0; i -= 1) {
    const revision = input.chain.revisions[i];
    if (revision.source !== "issue-refresh") continue;
    if (revision.issueBodyDigest !== input.issueBodyDigest) continue;
    const derived = deriveVerificationRequestKey({
      sessionId: input.key.sessionId,
      issueNumber: input.key.issueNumber,
      source: "issue-refresh",
      requestedContinuation: null,
      operations: revision.operations,
    });
    if (derived === revision.requestKey) return revision;
  }
  return undefined;
}

/**
 * Whether the plan moved off the digest an apply is guarded on because THIS
 * invocation's own committed revision moved it — the §5.3 rule 1 lost-response
 * retry, seen from the plan guard's side. The recognition is
 * {@link findDerivedRefreshReplay}'s, plus the one fact the guard needs: the
 * recorded revision was applied ON the plan being guarded with, so its
 * `basePlanDigest` is exactly the expected digest. A revision applied by anyone
 * else — or by this command line against some other plan — fails that test and
 * the guard stands.
 *
 * Decided independently of whether the rerun is *reported* as a replay: a
 * withheld retirement suppresses that report (§10 rule 4 needs somewhere to put
 * the difference, and the replay shape has none) without making the rerun any
 * less of a repeat of an apply that already landed.
 */
function refreshRetryMovedPlanOffExpected(input: {
  chain: VerificationAmendmentState | undefined;
  key: TaskKey;
  issueBodyDigest: string;
  expectedPlanDigest: string | undefined;
}): boolean {
  if (input.chain === undefined || input.expectedPlanDigest === undefined) return false;
  const applied = findDerivedRefreshReplay({
    chain: input.chain,
    key: input.key,
    issueBodyDigest: input.issueBodyDigest,
  });
  return applied !== undefined && applied.basePlanDigest === input.expectedPlanDigest;
}

/**
 * Whether THIS invocation, re-derived read-only from the same snapshot inputs
 * the main path uses, has nothing left to apply — the empty-diff precondition
 * {@link findDerivedRefreshReplay} is only sound under. The test is that the
 * live commands map to `unchanged` entries ONLY: a restore, an add, or a
 * proposed retirement each means the current invocation asks for something the
 * recorded revision did not apply — e.g. a rerun that now carries
 * `--allow-retire` over a retirement set the first refresh never touched
 * (issue #1043 review, P2) — so it is a NEW request the `task_active` refusal
 * must still answer, not a lost-response repeat. A proposed retirement blocks
 * recognition under either opt-in, mirroring the main path's suppression:
 * applied it is a new operation, withheld it is the §10 rule 4 difference the
 * replay shape has nowhere to report. An input this re-derivation cannot
 * cleanly resolve — no supported live section, an unresolvable plan, an
 * ambiguous diff — reads as not-exhausted, and the caller falls back to the
 * refusal, which is decidable without any of it. Everything here is a read;
 * nothing is written on any path.
 */
function refreshInvocationIsExhausted(input: {
  task: AiTask;
  sessionVerification: IssueVerificationRefreshInput["sessionVerification"];
  extract: VerificationRefreshExtractor;
  liveBody: string;
}): boolean {
  const extraction = input.extract(input.liveBody);
  if (!extraction.sectionFound) return false;
  const context = (input.task.context ?? {}) as Record<string, unknown>;
  const pinnedBody = typeof context.body === "string" ? context.body : "";
  const reconciliation = reconcileVerificationPlan({
    sessionVerification: input.sessionVerification,
    issueRequirements: input.extract(pinnedBody).commands,
    amendments: context[VERIFICATION_AMENDMENTS_CONTEXT_KEY],
  });
  if (reconciliation.status === "invalid" || reconciliation.status === "unreconciled") return false;
  const diffed = diffIssueVerificationRefresh({
    plan: reconciliation.plan,
    liveCommands: extraction.commands,
  });
  if (diffed.status === "ambiguous") return false;
  return (
    diffed.diff.restores.length === 0 &&
    diffed.diff.adds.length === 0 &&
    diffed.diff.proposedRetirements.length === 0
  );
}

// ---------------------------------------------------------------------------
// The refresh itself
// ---------------------------------------------------------------------------

export interface IssueVerificationRefreshDeps {
  store: VerificationAmendmentStore;
  /**
   * The live read. Absent means the session's provider has no adapter, which
   * is an explicit `unsupported_provider` refusal — never a silent skip and
   * never an empty-body read.
   */
  source?: VerificationRefreshIssueSource | undefined;
  extract: VerificationRefreshExtractor;
}

export interface IssueVerificationRefreshInput {
  key: TaskKey;
  /** The LIVE session-default map (§6.1 step 1). */
  sessionVerification?: Record<string, string> | readonly VerificationPlanSessionBaselineEntry[];
  /** §5.3: the operator this revision is recorded against. */
  actorId: string;
  /** §11 rule 3: mandatory, non-empty after trimming. */
  reason: string;
  /** §10 rule 4: apply the proposed retirements too. */
  allowRetire?: boolean;
  /** Preview by default (§11 rule 1); `true` writes. */
  apply?: boolean;
  /** §11 rule 3: the operator's stable handle; derived when absent. */
  requestKey?: string | undefined;
  /**
   * The `issueBodyDigest` a previous preview reported. When supplied, a live
   * body that no longer hashes to it refuses `stale_preview` with nothing
   * written — the concurrent-Issue-edit guard between preview and apply.
   */
  expectedIssueBodyDigest?: string | undefined;
  /**
   * The `basePlanDigest` a previous preview reported. When supplied, an
   * effective plan that no longer hashes to it refuses `stale_preview` with
   * nothing written.
   *
   * The Issue-body guard above is not enough on its own (issue #1044 review,
   * P2): a refresh diffs the live Issue against the TASK's effective plan, so a
   * concurrent `amend` moves the diff — different adds, different retirements —
   * while the Issue body, and therefore its digest, is untouched. Without this
   * the apply would then record a revision the operator never previewed, and
   * with `--allow-retire` it could retire a requirement they never saw proposed.
   */
  expectedPlanDigest?: string | undefined;
  /** §5.2 rule 6: the `"verification.pinned"` identities this task carries. */
  pinnedCommandIds?: readonly string[];
  /** Named in the unsupported-provider refusal; reporting only. */
  providerKind?: string;
  /**
   * The task's resolved session (issue #1043 review). A refresh whose row
   * default routes `{queued, review}` passes it through to the apply, which
   * enqueues the stack-ready removal and the lane-label swap atomically with
   * the re-queue. The CLI always supplies it.
   */
  session?: ResolvedSession;
  runId?: string;
  now?: string;
}

export type IssueVerificationRefreshRefusal =
  /** The session's work-item provider has no refresh adapter. */
  | "unsupported_provider"
  /** The live read failed. Never read as "the Issue requires nothing". */
  | "provider_error"
  | "issue_not_found"
  /** No supported verification section in the live body (§10 rule 5). */
  | "missing_section"
  /** The live body moved since the preview this apply was authored against. */
  | "stale_preview"
  | "invalid_reason"
  | "invalid_request_key"
  /** An input the §6 resolver cannot represent as a plan. */
  | "invalid_plan"
  /** §11 rule 6: the stored digest reconciles against no recorded input. */
  | "unreconciled"
  /** §10 rule 5: a diff the §10 rule 3 matcher cannot map. */
  | "ambiguous_diff"
  /** §5.2/§5.3 rule 7: the proposed revision refuses. */
  | "invalid_revision"
  | "task_not_found"
  | "task_active"
  | "task_terminal"
  | "chain_full"
  | "malformed_state"
  | "rebase_failed"
  | "store_rejected";

/** What the operator is shown, in both the preview and the applied report. */
export interface IssueVerificationRefreshReport {
  issueNumber: number;
  /** §10 rule 6: SHA-256 over the raw fetched body, provider-neutral. */
  issueBodyDigest: string;
  liveCommands: readonly string[];
  diff: VerificationRefreshDiff;
  /** §10 rule 4: the retirements this invocation is withholding. */
  withheldRetirements: readonly VerificationRefreshRetirement[];
  operations: readonly VerificationAmendmentOperation[];
  basePlanDigest: string;
  planDigest: string;
  /** §9.2: the default continuation of the task's row. */
  defaultContinuation: VerificationAmendmentContinuation;
  /**
   * The continuation an apply takes (issue #1043): the row default, since the
   * refresh grammar has no `--continue`. `"review"` re-queues; `"none"`
   * records only and the task stays parked or queued where it was.
   */
  continuation: VerificationAmendmentContinuation;
  requestKey: string;
  revisionId: string;
}

export type IssueVerificationRefreshOutcome =
  /** Nothing written; this is what `--yes` would apply. */
  | { status: "preview"; report: IssueVerificationRefreshReport; plan: EffectiveVerificationPlan }
  | {
      status: "applied";
      report: IssueVerificationRefreshReport;
      plan: EffectiveVerificationPlan;
      revision: VerificationAmendmentRevision;
      checkpoint: VerificationPlanCheckpoint;
      /**
       * The task as the apply left it (issue #1043): re-queued
       * `{queued, review}` when the revision's continuation routed, otherwise
       * unchanged in status and phase. What the surface reports as the
       * explicit routing outcome.
       */
      task: AiTask;
    }
  /**
   * §5.3 rule 3: this request already names an applied revision. A repeat, not
   * a refusal — nothing was written and no ordinal consumed. Reported for an
   * applying invocation whose `--request-key` the chain already carries, and
   * for the keyless retry whose own first attempt left it nothing to diff
   * ({@link findDerivedRefreshReplay}); either way it precedes the §10 rule 7
   * no-op, so a retry is never reported as one.
   */
  | { status: "replay"; revision: VerificationAmendmentRevision; checkpoint: VerificationPlanCheckpoint }
  /**
   * §10 rule 7: no difference to apply — no revision, no ordinal, no event.
   * `withheldRetirements` is non-empty when the only difference is one the
   * opt-in withheld, which is reported rather than silently dropped (§10 rule 4).
   * A retried apply that recognizes its own revision is a `replay` instead.
   */
  | {
      status: "no_change";
      issueNumber: number;
      issueBodyDigest: string;
      liveCommands: readonly string[];
      diff: VerificationRefreshDiff;
      withheldRetirements: readonly VerificationRefreshRetirement[];
      planDigest: string;
      defaultContinuation: VerificationAmendmentContinuation;
    }
  | {
      status: "stale";
      observedTaskRevision: number;
      currentTaskRevision?: number;
      observedPlanDigest: string;
      currentPlanDigest?: string;
    }
  | {
      status: "refused";
      reason: IssueVerificationRefreshRefusal;
      detail: string;
      /** Present on the outcomes that could compute one before refusing. */
      issueBodyDigest?: string;
    }
  | { status: "maintenance_locked" };

/**
 * §10 rule 6: the pinned read. SHA-256 over the RAW fetched body, before any
 * extraction, so "which text was this derived from" stays answerable and the
 * value reads the same for every provider.
 */
export function deriveIssueBodyDigest(body: string): string {
  return sha256Hex(body);
}

const NOT_FOUND_PATTERN = /not found|could not resolve|no such issue|404/i;

/**
 * Read the live Issue, diff it against the effective requirement layer, and —
 * with `apply` — commit the difference as one `issue-refresh` revision.
 *
 * Order of checks, and why: every refusal that can be decided WITHOUT touching
 * the provider is decided first (reason, request key, the supplied-key replay,
 * and — for an applying invocation — the §7.1 task status), then the live read,
 * then the body-level refusals, then the plan, then the diff, then the derived-
 * key replay the empty diff can hide, and only then the write. A refusal at any
 * step writes nothing and consumes no ordinal. One read-only exception: before
 * an ACTIVE-task refusal is returned to a keyless apply that carries a
 * revision chain, the live body is read once to recognize the §5.3 derived-key
 * replay (issue #1043 review) — a failed read falls back to the refusal, which
 * needs no provider.
 */
export async function refreshIssueVerification(
  deps: IssueVerificationRefreshDeps,
  input: IssueVerificationRefreshInput,
): Promise<IssueVerificationRefreshOutcome> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return { status: "refused", reason: "invalid_reason", detail: "--reason is required and must not be empty (§11 rule 3)" };
  }
  if (reason.length > MAX_VERIFICATION_AMENDMENT_REASON_CHARS) {
    return {
      status: "refused",
      reason: "invalid_reason",
      detail: `--reason exceeds ${MAX_VERIFICATION_AMENDMENT_REASON_CHARS} chars`,
    };
  }
  if (input.requestKey !== undefined && !VERIFICATION_REQUEST_KEY_PATTERN.test(input.requestKey)) {
    return {
      status: "refused",
      reason: "invalid_request_key",
      detail: "--request-key must match /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/ (§5.3 rule 2)",
    };
  }
  if (!deps.source) {
    return {
      status: "refused",
      reason: "unsupported_provider",
      detail:
        `refreshing verification requirements from the live Issue is not supported for the ` +
        `"${input.providerKind ?? "unknown"}" work-item provider; no adapter reads its item bodies`,
    };
  }

  // The task is read BEFORE the provider so a refresh against a task that does
  // not exist never reaches the network, and so the plan, the CAS revision,
  // and the §7.1 status all come from one snapshot.
  const task = await deps.store.getTask(input.key);
  if (!task) {
    return {
      status: "refused",
      reason: "task_not_found",
      detail: `no task for ${input.key.sessionId}#${input.key.issueNumber}`,
    };
  }

  // §5.3 rules 1 and 3: replay recognition precedes every plan comparison —
  // and, exactly as on the write side, the §7.1 status table — so a
  // lost-response retry is a repeat however far the task moved since. An
  // operator-supplied `--request-key` is caller-stable by construction (§5.3
  // rule 2), so an applying invocation carrying one the chain already names is
  // reported here without touching the provider at all; the retry whose key was
  // DERIVED is recognized further down, where the live read it needs exists —
  // or, when the §7.1 guard would otherwise report it `task_active`, by the
  // read-only recognition inside that guard (issue #1043 review).
  //
  // A preview is exempt: it writes nothing on any path, so the diff it exists to
  // show stays more useful than a repeat notice.
  const chain = storedAmendmentChain(task);
  if (input.apply === true && input.requestKey !== undefined && chain) {
    const replayed = chain.revisions.find((revision) => revision.requestKey === input.requestKey);
    if (replayed) {
      return { status: "replay", revision: replayed, checkpoint: chain.checkpoint };
    }
  }

  // §7.1 and §7.2 rules 1–2: an APPLYING refresh refuses on an active or
  // terminal task here, before anything can be written and before the provider
  // is touched. `applyVerificationAmendmentRevision` re-checks this inside its
  // transaction and that check stays authoritative, but two paths below reach a
  // successful return or a write without ever calling it: a refresh that finds
  // no difference returns `no_change` directly (§10 rule 7), which would report
  // an active-task apply as an allowed success and exit zero against §7.2 rule
  // 4; and a §6.4 rule 5 checkpoint rebase commits a checkpoint and an event
  // first, which would mutate an in-flight task the apply then refuses,
  // breaking §7.2 rule 2's "nothing is stored".
  //
  // A preview is exempt: like `plan`, it is a read that writes nothing on any
  // status, and §11 rule 5 has it exit zero.
  if (input.apply === true) {
    const inadmissible = verificationAmendmentStatusRefusal(task);
    if (inadmissible) {
      // §5.3 rules 1 and 3 on the DERIVED key (issue #1043 review, P2): a
      // keyless refresh whose row default re-queued `{queued, review}` can be
      // claimed by a worker before the lost-response retry arrives, and that
      // retry carries no key the supplied-key lookup above could match.
      // Recognize it from the live body BEFORE the active-task refusal
      // reports an applied request as refused — but only when the CURRENT
      // invocation itself has nothing left to apply: the stored revision's
      // digest and its own derived key match ANY later keyless refresh of an
      // unchanged body, including one whose operation set differs (a rerun
      // that now carries `--allow-retire`, most concretely), and such an
      // invocation is a new request the refusal must still answer, not a
      // repeat. Recognition is a read — it writes nothing — and a failed
      // live read, like an input the read-only re-derivation cannot cleanly
      // resolve, falls back to the refusal, which is decidable without the
      // provider. A TERMINAL task is not matched here: that state is
      // permanent, so a much-later keyless refresh against an unchanged body
      // is plausibly a new request, and the recovery-surface refusal stays
      // the actionable answer.
      if (inadmissible.reason === "task_active" && input.requestKey === undefined && chain) {
        let liveBody: string | undefined;
        try {
          const activeRead = await deps.source.readIssue(input.key.issueNumber);
          liveBody = typeof activeRead.body === "string" ? activeRead.body : "";
        } catch {
          liveBody = undefined;
        }
        if (liveBody !== undefined) {
          const replayed = findDerivedRefreshReplay({
            chain,
            key: input.key,
            issueBodyDigest: deriveIssueBodyDigest(liveBody),
          });
          if (
            replayed &&
            refreshInvocationIsExhausted({
              task,
              sessionVerification: input.sessionVerification,
              extract: deps.extract,
              liveBody,
            })
          ) {
            return { status: "replay", revision: replayed, checkpoint: chain.checkpoint };
          }
        }
      }
      return { status: "refused", reason: inadmissible.reason, detail: inadmissible.detail };
    }
  }

  let read: VerificationRefreshIssueRead;
  try {
    read = await deps.source.readIssue(input.key.issueNumber);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "refused",
      reason: NOT_FOUND_PATTERN.test(message) ? "issue_not_found" : "provider_error",
      detail: `live Issue read failed: ${message}`,
    };
  }

  const body = typeof read.body === "string" ? read.body : "";
  const issueBodyDigest = deriveIssueBodyDigest(body);
  if (input.expectedIssueBodyDigest !== undefined && input.expectedIssueBodyDigest !== issueBodyDigest) {
    return {
      status: "refused",
      reason: "stale_preview",
      detail:
        `the Issue body changed since the preview: expected ${input.expectedIssueBodyDigest}, ` +
        `read ${issueBodyDigest}. Re-run the preview and apply the difference you actually saw.`,
      issueBodyDigest,
    };
  }

  const extraction = deps.extract(body);
  if (!extraction.sectionFound) {
    return {
      status: "refused",
      reason: "missing_section",
      detail:
        `the live Issue body has no supported verification section (Verification, Test Plan, ` +
        `Acceptance Criteria, or Verify), so it states no requirement to import. Refusing rather than ` +
        `reading an unparseable body as "this Issue requires nothing" (§10 rule 5).`,
      issueBodyDigest,
    };
  }
  for (const command of extraction.commands) {
    if (command.trim().length > MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS) {
      // Bounded here rather than at the §5.2 authoring step so the refusal
      // names the LIVE Issue as the source of the unrepresentable input.
      return {
        status: "refused",
        reason: "invalid_plan",
        detail: `a live verification command exceeds ${MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS} chars`,
        issueBodyDigest,
      };
    }
  }

  // The pinned intake extraction stays the requirement-layer input (§6.2 step
  // 1). The live body is NEVER substituted for it — that substitution is the
  // silent-scope-change §10 rule 1 forbids; the diff below is the only path
  // from the live text into the plan.
  const context = (task.context ?? {}) as Record<string, unknown>;
  const pinnedBody = typeof context.body === "string" ? context.body : "";
  const planInput = {
    sessionVerification: input.sessionVerification,
    issueRequirements: deps.extract(pinnedBody).commands,
    amendments: context[VERIFICATION_AMENDMENTS_CONTEXT_KEY],
  };

  const reconciliation = reconcileVerificationPlan(planInput);
  if (reconciliation.status === "invalid") {
    return {
      status: "refused",
      reason: "invalid_plan",
      detail: `${reconciliation.reason}: ${reconciliation.detail}`,
      issueBodyDigest,
    };
  }
  if (reconciliation.status === "unreconciled") {
    return {
      status: "refused",
      reason: "unreconciled",
      detail: `${reconciliation.detail} — refusing without repairing (§11 rule 6)`,
      issueBodyDigest,
    };
  }
  const plan = reconciliation.plan;

  const baseline = buildVerificationSessionBaseline(input.sessionVerification ?? {});
  if (baseline.status === "invalid") {
    return { status: "refused", reason: "invalid_plan", detail: `session_verification: ${baseline.detail}`, issueBodyDigest };
  }

  const diffed = diffIssueVerificationRefresh({ plan, liveCommands: extraction.commands });
  if (diffed.status === "ambiguous") {
    return { status: "refused", reason: "ambiguous_diff", detail: diffed.detail, issueBodyDigest };
  }
  const diff = diffed.diff;
  const allowRetire = input.allowRetire === true;
  const withheldRetirements = allowRetire ? [] : diff.proposedRetirements;
  const operations = verificationRefreshOperations(diff, { reason, allowRetire });
  const defaultContinuation = defaultVerificationContinuation(task);

  // The second half of the preview guard (issue #1044 review, P2): the plan the
  // operations above were derived from. The Issue-body digest cannot stand in
  // for it — a refresh diffs the live Issue against the TASK's effective plan,
  // so a concurrent `amend` moves the diff while the body, and therefore its
  // digest, is untouched. Nothing is written and no ordinal is consumed when it
  // refuses, exactly as the Issue-digest refusal above.
  const stalePlanDigestRefusal = (): IssueVerificationRefreshOutcome | undefined => {
    if (input.expectedPlanDigest === undefined || input.expectedPlanDigest === plan.planDigest) {
      return undefined;
    }
    return {
      status: "refused",
      reason: "stale_preview",
      detail:
        `the task's effective verification plan changed since the preview: expected ` +
        `${input.expectedPlanDigest}, resolved ${plan.planDigest}. A refresh is diffed against ` +
        `the task's own plan, so this apply would record a different set of operations from the ` +
        `one previewed — whatever the live Issue says. Re-run the preview and apply what you ` +
        `actually saw.`,
      issueBodyDigest,
    };
  };

  if (operations.length === 0) {
    // Issue #1044 review (P2): an empty operation set is NOT a licence to skip
    // the plan guard. A concurrent `amend` can make the live Issue and the
    // effective plan agree after the preview was taken, and the apply then
    // reaches here with a digest the operator never saw — reporting success for
    // a plan that moved is exactly what the guard exists to prevent. The one
    // bypass is the retry whose OWN committed apply moved the plan: its digest
    // has necessarily moved, and refusing there would report a lost-response
    // repeat as a concurrent-edit conflict. That is recognized from the chain,
    // not from the emptiness of the diff, and not from whether the rerun is
    // reported as a replay — a withheld retirement suppresses the replay report
    // below while leaving the rerun the same repeat.
    //
    // The guard runs BEFORE the replay lookup, not after it (issue #1044
    // review, P2). Both are pure reads, so the order is free; but the lookup
    // matches ANY earlier keyless refresh of this same body, and an unrelated
    // one is not the retry the bypass is for. Apply refresh B, `amend` in a new
    // requirement, preview a refresh that retires it, and let a second amendment
    // retire it first: the diff is now empty, the plan is a digest the operator
    // never saw, and running the lookup first would answer `--expect-plan-digest`
    // with a zero-exit replay of B — reporting B's ordinal for a plan B was
    // never applied to. Whether B's `basePlanDigest` is the guarded digest is
    // precisely what tells the retry from the coincidence, and that is the test
    // {@link refreshRetryMovedPlanOffExpected} makes.
    if (
      !(
        input.apply === true &&
        input.requestKey === undefined &&
        refreshRetryMovedPlanOffExpected({
          chain,
          key: input.key,
          issueBodyDigest,
          expectedPlanDigest: input.expectedPlanDigest,
        })
      )
    ) {
      const stalePlanOnNoChange = stalePlanDigestRefusal();
      if (stalePlanOnNoChange) return stalePlanOnNoChange;
    }

    // §5.3 rules 1 and 3 outrank §10 rule 7 on a RETRIED apply. A refresh whose
    // `--yes` committed and whose response was lost reruns into the plan it
    // itself produced and finds nothing left to do, which is indistinguishable
    // by content from a refresh that never applied anything. Naming the stored
    // revision is what tells those two apart — and it still writes nothing,
    // consumes no ordinal, and appends no event, so it remains the no-op §10
    // rule 7 describes, reported as the repeat it is rather than as a bare
    // "no change" the operator cannot act on. Reached only once the guard above
    // has agreed the plan is either the previewed one or the one this request's
    // own commit produced.
    //
    // A withheld retirement suppresses this recognition: the rerun then still
    // carries a difference `--allow-retire` would apply, so it is not merely a
    // repeat, and §10 rule 4 requires that difference in the output — which the
    // replay shape has nowhere to put. A supplied key is matched earlier and
    // unconditionally, because §5.3 rule 1 puts that lookup ahead of the plan.
    if (input.apply === true && input.requestKey === undefined && chain && withheldRetirements.length === 0) {
      const replayed = findDerivedRefreshReplay({ chain, key: input.key, issueBodyDigest });
      if (replayed) {
        return { status: "replay", revision: replayed, checkpoint: chain.checkpoint };
      }
    }

    // §10 rule 7 and §10 rule 4: no revision either way — but a withheld
    // retirement is still reported, never dropped from the output.
    return {
      status: "no_change",
      issueNumber: read.number,
      issueBodyDigest,
      liveCommands: extraction.commands,
      diff,
      withheldRetirements,
      planDigest: plan.planDigest,
      defaultContinuation,
    };
  }

  // An apply that still has something to write against a plan the operator did
  // not preview. The recognized-replay bypass above never reaches here: that
  // rerun derives no operations at all.
  const stalePlan = stalePlanDigestRefusal();
  if (stalePlan) return stalePlan;

  const proposed = proposeVerificationRevision({
    plan,
    operations,
    ...(input.pinnedCommandIds !== undefined ? { pinnedCommandIds: input.pinnedCommandIds } : {}),
  });
  if (proposed.status === "refused") {
    return {
      status: "refused",
      reason: "invalid_revision",
      detail:
        `${proposed.reason}: ${proposed.detail}` +
        (proposed.operationIndex !== undefined ? ` (operation ${proposed.operationIndex})` : ""),
      issueBodyDigest,
    };
  }

  // §5.3 rules 1–2. `requestedContinuation` is `null`: the refresh grammar
  // (§11) carries no `--continue`, so nothing was typed.
  const requestKey =
    input.requestKey ??
    deriveVerificationRequestKey({
      sessionId: input.key.sessionId,
      issueNumber: input.key.issueNumber,
      source: "issue-refresh",
      requestedContinuation: null,
      operations: proposed.operations,
    });
  const revisionId = deriveVerificationRevisionId({
    sessionId: input.key.sessionId,
    issueNumber: input.key.issueNumber,
    requestKey,
    basePlanDigest: proposed.basePlanDigest,
    operations: proposed.operations,
  });

  const report: IssueVerificationRefreshReport = {
    issueNumber: read.number,
    issueBodyDigest,
    liveCommands: extraction.commands,
    diff,
    withheldRetirements,
    operations: proposed.operations,
    basePlanDigest: proposed.basePlanDigest,
    planDigest: proposed.planDigest,
    defaultContinuation,
    // Issue #1043: no `--continue` exists here, so the row default IS the
    // route. §9.2 rule 3 needs no refusal arm on this surface — a parked or
    // queued row's default is `"none"`, which routes nothing.
    continuation: defaultContinuation,
    requestKey,
    revisionId,
  };

  if (input.apply !== true) {
    return { status: "preview", report, plan: proposed.plan };
  }

  // §6.4 rule 5: an authorized session-default edit rebases rather than
  // refusing. Without this the apply below would read the moved live plan
  // against a checkpoint that predates the edit and refuse as stale, which is
  // exactly the outcome rule 5 exists to prevent.
  let observedTaskRevision = task.revision;
  if (reconciliation.status === "drifted") {
    const rebased = await rebaseVerificationPlanCheckpoint({
      store: deps.store,
      key: input.key,
      observedTaskRevision,
      checkpoint: reconciliation.checkpoint,
      dispositions: reconciliation.dispositions,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    if (rebased.status === "maintenance_locked") return { status: "maintenance_locked" };
    if (rebased.status === "stale") {
      return {
        status: "stale",
        observedTaskRevision,
        ...(rebased.currentTaskRevision !== undefined ? { currentTaskRevision: rebased.currentTaskRevision } : {}),
        observedPlanDigest: proposed.basePlanDigest,
      };
    }
    if (rebased.status === "refused") {
      return {
        status: "refused",
        reason: "rebase_failed",
        detail: `re-anchoring the plan checkpoint to the live session defaults failed (${rebased.reason}): ${rebased.detail}`,
        issueBodyDigest,
      };
    }
    observedTaskRevision = rebased.task.revision;
  }

  const applied = await applyVerificationAmendmentRevision({
    store: deps.store,
    key: input.key,
    observedTaskRevision,
    revision: {
      revisionId,
      requestKey,
      source: "issue-refresh",
      actor: { kind: "operator", id: input.actorId },
      reason,
      operations: proposed.operations,
      basePlanDigest: proposed.basePlanDigest,
      planDigest: proposed.planDigest,
      sessionBaselineDigest: baseline.sessionBaselineDigest,
      // §9.2 (issue #1043): the row default is the route a refresh takes, and
      // the apply below re-queues `{queued, review}` in the same transaction
      // when it is `"review"`. The recorded continuation is the one taken.
      continuation: defaultContinuation,
      issueBodyDigest,
    },
    checkpoint: {
      planDigest: proposed.planDigest,
      sessionBaseline: baseline.sessionBaseline,
      sessionBaselineDigest: baseline.sessionBaselineDigest,
    },
    slotCounts: verificationPlanSlotCounts(proposed.plan),
    // No `baseRequirementCommands`: a refresh never emits `replace` (§10 rule
    // 3), and the apply refuses any revision that carries one without them.
    // §12.2 (issue #1044): a refresh is an ordinary revision on the reporting
    // side too — one comment naming the plan it produced, keyed on its
    // `revisionId`, enqueued in the same transaction as the write.
    publication: { slots: verificationAmendmentPublicSlots(proposed.plan) },
    ...(input.session !== undefined ? { session: input.session } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  if (applied.status === "applied") {
    return {
      status: "applied",
      report,
      plan: proposed.plan,
      revision: applied.revision,
      checkpoint: applied.checkpoint,
      task: applied.task,
    };
  }
  if (applied.status === "replay") {
    return { status: "replay", revision: applied.revision, checkpoint: applied.checkpoint };
  }
  if (applied.status === "maintenance_locked") return { status: "maintenance_locked" };
  if (applied.status === "stale") {
    return {
      status: "stale",
      observedTaskRevision: applied.observedTaskRevision,
      ...(applied.currentTaskRevision !== undefined ? { currentTaskRevision: applied.currentTaskRevision } : {}),
      observedPlanDigest: applied.observedPlanDigest,
      ...(applied.currentPlanDigest !== undefined ? { currentPlanDigest: applied.currentPlanDigest } : {}),
    };
  }
  return {
    status: "refused",
    reason: refusalFor(applied.reason),
    detail: applied.detail,
    issueBodyDigest,
  };
}

function refusalFor(
  reason:
    | "not_found"
    | "invalid_input"
    | "malformed_state"
    | "task_active"
    | "task_terminal"
    | "continuation_not_permitted"
    | "chain_full"
    | "store_rejected",
): IssueVerificationRefreshRefusal {
  switch (reason) {
    case "not_found":
      return "task_not_found";
    case "invalid_input":
      return "invalid_revision";
    case "malformed_state":
      return "malformed_state";
    case "task_active":
      return "task_active";
    case "task_terminal":
      return "task_terminal";
    // Unreachable from a refresh — the continuation it records is derived
    // from the same task read whose `revision` the apply CAS pins, so a row
    // that moved reports `stale` first — but the mapping stays total.
    case "continuation_not_permitted":
      return "invalid_revision";
    case "chain_full":
      return "chain_full";
    default:
      return "store_rejected";
  }
}
