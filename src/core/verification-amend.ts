import type { AiTask, TaskKey, TaskPhase, TaskStatus } from "./task.js";
import type { ResolvedSession } from "./session.js";
import {
  applyVerificationAmendmentRevision,
  rebaseVerificationPlanCheckpoint,
  validateVerificationAmendmentOperations,
  validateVerificationAmendmentState,
  verificationAmendmentStatusRefusal,
  MAX_VERIFICATION_AMENDMENT_REASON_CHARS,
  VERIFICATION_AMENDMENTS_CONTEXT_KEY,
  type VerificationAmendmentContinuation,
  type VerificationAmendmentOperation,
  type VerificationAmendmentRevision,
  type VerificationAmendmentState,
  type VerificationAmendmentStore,
  type VerificationPlanCheckpoint,
  type VerificationPlanSessionBaselineEntry,
} from "./verification-amendment.js";
import {
  buildEffectiveRequirementStatus,
  buildVerificationSessionBaseline,
  proposeVerificationRevision,
  reconcileVerificationPlan,
  verificationPlanSlotCounts,
  type EffectiveRequirementVerification,
  type EffectiveVerificationPlan,
  type EffectiveVerificationSlot,
  type FullSuiteRequirementDeclaration,
  type ManualVerificationEvidenceLike,
} from "./verification-plan.js";
import { verificationAmendmentPublicSlots } from "./verification-amendment-publication.js";
import {
  defaultVerificationContinuation,
  deriveVerificationRequestKey,
  deriveVerificationRevisionId,
  VERIFICATION_REQUEST_KEY_PATTERN,
  type VerificationRefreshExtractor,
} from "./verification-refresh.js";

/**
 * The task-scoped operator surface of `docs/verification-amendment-contract.md`
 * §11 (§15 slice A4, issue #1042), minus its argv: reading a task's effective
 * verification plan, authoring an operator-typed revision against it, and
 * returning an amended task to its unamended baseline.
 *
 * Everything here is orchestration over the shipped pieces and nothing more.
 * The effective plan comes from `core/verification-plan.ts` (#1039), the write
 * from `core/verification-amendment.ts` (#1038), and the §5.3 rules 1–2
 * derivations from `core/verification-refresh.ts` (#1041) — so the CLI holds no
 * copy of plan resolution, digesting, or the §7 refusals, and the two operator
 * entry points (`amend` and `reset`) reach the store through exactly one path.
 *
 * The order of checks mirrors {@link refreshIssueVerification} deliberately,
 * because it is normative rather than incidental: every refusal decidable
 * without the plan is decided first, then the §5.3 rule 3 replay lookup, then
 * the §7.1 status table, then the plan, then the §7.3 rule 3 digest guard, then
 * the composition, and only then the write. A refusal at any step writes
 * nothing and consumes no ordinal.
 *
 * Continuation (§9, issue #1043): an applying `amend` takes the operator's
 * typed `--continue` value, or its row's §9.2 default when none was typed —
 * `"review"` on the two re-queueable review-lane rows, `"none"` everywhere
 * else. A non-`none` continuation re-queues the task
 * `{status: "queued", phase: <continuation>}` inside the SAME store
 * transaction that persists the amended plan (§9.2 rule 2, enforced by
 * `applyVerificationAmendmentRevision`), and a typed route on a row the table
 * parks refuses before anything is composed (§9.2 rule 3). The revision and
 * the §12.1 event record the continuation actually taken.
 */

// ---------------------------------------------------------------------------
// The read-only view (§11's `plan`, shipped as `task-verification show`)
// ---------------------------------------------------------------------------

/** How the stored record classified against the live inputs (§6.4 rule 3). */
export type TaskVerificationReconciliation = "unamended" | "consistent" | "drifted";

/** §6.4 rule 4 dispositions, by identity only — never by command bytes. */
export interface TaskVerificationDrift {
  previousPlanDigest: string;
  previousSessionBaselineDigest: string;
  planDigest: string;
  sessionBaselineDigest: string;
  masked: readonly string[];
  orphaned: readonly string[];
}

/** What an operator is shown about one task's verification plan. */
export interface TaskVerificationPlanView {
  taskStatus: TaskStatus;
  taskPhase: TaskPhase;
  reconciliation: TaskVerificationReconciliation;
  plan: EffectiveVerificationPlan;
  /** §6.2 rule 3 / §8.4: `passed` | `not_run` | `retired`, per requirement slot. */
  requirementStatus: readonly EffectiveRequirementVerification[];
  revisions: readonly VerificationAmendmentRevision[];
  checkpoint?: VerificationPlanCheckpoint;
  defaultContinuation: VerificationAmendmentContinuation;
  /**
   * §7.1: whether an amendment would be admitted right now, with the refusal
   * an applying invocation would produce. A read never refuses on it — the
   * point of the view is to explain why the mutation would.
   */
  amendable: boolean;
  amendmentRefusal?: { reason: "task_active" | "task_terminal"; detail: string };
  /** Present only when the reconciliation classified `drifted`. */
  drift?: TaskVerificationDrift;
  /**
   * The task context the view was resolved from (issue #1107), so a caller can
   * project the staged verification state against the SAME read as the plan.
   */
  taskContext?: Record<string, unknown>;
}

export type TaskVerificationViewRefusal =
  | "task_not_found"
  | "invalid_plan"
  /** §11 rule 6: the stored digest reconciles against no recorded input. */
  | "unreconciled";

export type TaskVerificationViewOutcome =
  | { status: "ok"; view: TaskVerificationPlanView }
  | { status: "refused"; reason: TaskVerificationViewRefusal; detail: string };

export interface TaskVerificationDeps {
  store: VerificationAmendmentStore;
  /** The shipped extractor, injected so core never imports handlers. */
  extract: VerificationRefreshExtractor;
}

export interface TaskVerificationViewInput {
  key: TaskKey;
  /** The LIVE session-default map (§6.1 step 1). */
  sessionVerification?: Record<string, string> | readonly VerificationPlanSessionBaselineEntry[];
  /**
   * Issue #1166: the session's declared full-suite requirement alias, so the
   * reported requirement status is the one the lanes gate on. Omitted, the
   * report is the shipped command-bytes-only answer.
   */
  fullSuite?: FullSuiteRequirementDeclaration;
}

/** The §6 resolution inputs of one task: live session map, pinned body, chain. */
function planInputOf(
  task: AiTask,
  extract: VerificationRefreshExtractor,
  sessionVerification: TaskVerificationViewInput["sessionVerification"],
): { sessionVerification: TaskVerificationViewInput["sessionVerification"]; issueRequirements: readonly string[]; amendments: unknown } {
  const context = (task.context ?? {}) as Record<string, unknown>;
  const pinnedBody = typeof context.body === "string" ? context.body : "";
  return {
    sessionVerification,
    // §6.2 step 1: the INTAKE-pinned body, never a live read. `show` and
    // `amend` are not refresh surfaces and never consult a provider.
    issueRequirements: extract(pinnedBody).commands,
    amendments: context[VERIFICATION_AMENDMENTS_CONTEXT_KEY],
  };
}

/** The stored chain, or `undefined` when the task carries none or a broken one. */
function storedAmendmentChain(task: AiTask): VerificationAmendmentState | undefined {
  const validation = validateVerificationAmendmentState(
    task.context?.[VERIFICATION_AMENDMENTS_CONTEXT_KEY],
  );
  return validation.valid ? validation.state : undefined;
}

function manualEvidenceOf(task: AiTask): readonly ManualVerificationEvidenceLike[] {
  const context = (task.context ?? {}) as Record<string, unknown>;
  const raw = context["manualVerificationEvidence"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ManualVerificationEvidenceLike =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { command?: unknown }).command === "string" &&
      typeof (entry as { exitCode?: unknown }).exitCode === "number",
  );
}

/**
 * Resolve and classify one task's verification plan without writing anything.
 *
 * A `drifted` classification is REPORTED here and nothing is re-anchored: §11
 * rule 1 makes this surface read-only, and §6.4 rule 5's rebase belongs to the
 * applying paths that already hold a write. An `unreconciled` record refuses
 * (§11 rule 6) rather than being shown as if it were a plan.
 */
export async function describeTaskVerificationPlan(
  deps: TaskVerificationDeps,
  input: TaskVerificationViewInput,
): Promise<TaskVerificationViewOutcome> {
  const task = await deps.store.getTask(input.key);
  if (!task) {
    return {
      status: "refused",
      reason: "task_not_found",
      detail: `no task for ${input.key.sessionId}#${input.key.issueNumber}`,
    };
  }

  const reconciliation = reconcileVerificationPlan(
    planInputOf(task, deps.extract, input.sessionVerification),
  );
  if (reconciliation.status === "invalid") {
    return { status: "refused", reason: "invalid_plan", detail: `${reconciliation.reason}: ${reconciliation.detail}` };
  }
  if (reconciliation.status === "unreconciled") {
    return {
      status: "refused",
      reason: "unreconciled",
      detail: `${reconciliation.detail} — refusing without repairing (§11 rule 6)`,
    };
  }

  const chain = storedAmendmentChain(task);
  const inadmissible = verificationAmendmentStatusRefusal(task);
  const view: TaskVerificationPlanView = {
    taskStatus: task.status,
    taskPhase: task.phase,
    reconciliation: reconciliation.status,
    plan: reconciliation.plan,
    requirementStatus: buildEffectiveRequirementStatus(
      reconciliation.plan,
      manualEvidenceOf(task),
      undefined,
      input.fullSuite,
    ),
    revisions: chain?.revisions ?? [],
    ...(chain !== undefined ? { checkpoint: chain.checkpoint } : {}),
    defaultContinuation: defaultVerificationContinuation(task),
    amendable: inadmissible === undefined,
    ...(inadmissible !== undefined
      ? { amendmentRefusal: { reason: inadmissible.reason, detail: inadmissible.detail } }
      : {}),
    ...(reconciliation.status === "drifted"
      ? {
          drift: {
            previousPlanDigest: reconciliation.previousPlanDigest,
            previousSessionBaselineDigest: reconciliation.previousSessionBaselineDigest,
            planDigest: reconciliation.checkpoint.planDigest,
            sessionBaselineDigest: reconciliation.checkpoint.sessionBaselineDigest,
            masked: reconciliation.dispositions.masked,
            orphaned: reconciliation.dispositions.orphaned,
          },
        }
      : {}),
    ...(task.context !== undefined ? { taskContext: task.context } : {}),
  };
  return { status: "ok", view };
}

// ---------------------------------------------------------------------------
// §11's `amend`
// ---------------------------------------------------------------------------

export type TaskVerificationAmendRefusal =
  | "invalid_reason"
  | "invalid_request_key"
  /** The typed operation list does not satisfy the §5.2 schema. */
  | "invalid_operations"
  /** §9.2 rule 3: a continuation the row's default does not permit. */
  | "continuation_not_permitted"
  | "invalid_plan"
  | "unreconciled"
  /** §7.3 rule 3: `--expect-plan-digest` named a plan this is not. */
  | "plan_digest_mismatch"
  /** §5.2/§5.3 rule 7: the composed revision refuses; nothing partial applies. */
  | "invalid_revision"
  | "task_not_found"
  | "task_active"
  | "task_terminal"
  | "chain_full"
  | "malformed_state"
  | "rebase_failed"
  | "store_rejected";

/** What the operator is shown, in both the preview and the applied report. */
export interface TaskVerificationAmendReport {
  operations: readonly VerificationAmendmentOperation[];
  basePlanDigest: string;
  planDigest: string;
  /** §9.2: the default continuation of the task's row. */
  defaultContinuation: VerificationAmendmentContinuation;
  /** The `--continue` value exactly as typed; `null` when the flag was absent. */
  requestedContinuation: VerificationAmendmentContinuation | null;
  /**
   * The continuation an apply takes (issue #1043): the typed value, or the
   * row default when none was typed. `"review"`/`"implementation"` re-queue
   * `{queued, <continuation>}` in the plan-persisting transaction; `"none"`
   * records the revision and routes nothing.
   */
  continuation: VerificationAmendmentContinuation;
  requestKey: string;
  revisionId: string;
}

export type TaskVerificationAmendOutcome =
  /** Nothing written; this is what `--yes` would apply. */
  | { status: "preview"; report: TaskVerificationAmendReport; basePlan: EffectiveVerificationPlan; plan: EffectiveVerificationPlan }
  | {
      status: "applied";
      report: TaskVerificationAmendReport;
      basePlan: EffectiveVerificationPlan;
      plan: EffectiveVerificationPlan;
      revision: VerificationAmendmentRevision;
      checkpoint: VerificationPlanCheckpoint;
      /**
       * The task as the apply left it (issue #1043): re-queued
       * `{queued, <continuation>}` when the revision routed, otherwise
       * unchanged in status and phase — the explicit outcome for a revision
       * that was accepted but, per its row, not re-queued.
       */
      task: AiTask;
    }
  /** §5.3 rule 3: this request already names an applied revision. */
  | { status: "replay"; revision: VerificationAmendmentRevision; checkpoint: VerificationPlanCheckpoint }
  | {
      status: "stale";
      observedTaskRevision: number;
      currentTaskRevision?: number;
      observedPlanDigest: string;
      currentPlanDigest?: string;
    }
  | { status: "refused"; reason: TaskVerificationAmendRefusal; detail: string }
  | { status: "maintenance_locked" };

export interface TaskVerificationAmendInput {
  key: TaskKey;
  /** The LIVE session-default map (§6.1 step 1). */
  sessionVerification?: Record<string, string> | readonly VerificationPlanSessionBaselineEntry[];
  /** §5.3: the operator this revision is recorded against. */
  actorId: string;
  /** §11 rule 3: the revision-level reason; mandatory and non-empty. */
  reason: string;
  /**
   * The operations exactly as the surface parsed them, each already carrying
   * its own `reason` (its `--op-reason`, or the revision-level `--reason`
   * materialized onto it per §5.2 rule 1). Validated here against the §5.2
   * schema before anything else touches them.
   */
  operations: unknown;
  /** §11 rule 3 / §5.3 rule 2: `null` when `--continue` was not typed. */
  requestedContinuation?: VerificationAmendmentContinuation | null;
  /** Preview by default (§11 rule 1); `true` writes. */
  apply?: boolean;
  /** §11 rule 3: the operator's stable handle; derived when absent. */
  requestKey?: string | undefined;
  /** §7.3 rule 3: a hard guard on the plan this revision is authored against. */
  expectedPlanDigest?: string | undefined;
  /** §5.2 rule 6: the `"verification.pinned"` identities this task carries. */
  pinnedCommandIds?: readonly string[];
  /**
   * The task's resolved session (issue #1043 review). An applying revision
   * whose continuation routes passes it through to the store write, which
   * enqueues the stack-ready removal and the lane-label swap of the routed
   * `{queued, <phase>}` edge atomically with the re-queue — without it the
   * re-queued task's Issue keeps advertising the parked review's success-only
   * stack-ready marker. The CLI always supplies it.
   */
  session?: ResolvedSession;
  runId?: string;
  now?: string;
}

/**
 * The operator-typed fields every revision-authoring invocation carries,
 * independent of the operations it ends up composing.
 *
 * Shared with the reset, whose no-change path never reaches the amend below:
 * a malformed `--request-key` or an overlong `--reason` is bad input whether or
 * not the plan happens to have anything left to undo, and reporting it as
 * success would let the surface's own contract go unenforced (§11 rule 3,
 * §5.3 rule 2).
 */
function refuseInvalidAmendmentRequest(input: {
  reason: string;
  requestKey?: string | undefined;
}): { status: "refused"; reason: TaskVerificationAmendRefusal; detail: string } | undefined {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return {
      status: "refused",
      reason: "invalid_reason",
      detail: "--reason is required and must not be empty or whitespace-only (§11 rule 3)",
    };
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
  return undefined;
}

/**
 * Author one operator-typed revision against a task's effective plan (§11's
 * `amend`), previewing by default and applying under `--yes`.
 *
 * The §5.3 rule 2 request key is derivable BEFORE the plan is read, because an
 * `amend`'s operations are typed on the command line rather than diffed out of
 * anything. That is what lets the replay lookup run ahead of the §7.1 status
 * table and every digest comparison: an invocation whose `--yes` committed and
 * whose response was lost reruns into the plan it produced itself, and is
 * reported as the repeat it is instead of refusing as stale or applying twice.
 */
export async function amendTaskVerification(
  deps: TaskVerificationDeps,
  input: TaskVerificationAmendInput,
): Promise<TaskVerificationAmendOutcome> {
  const reason = input.reason.trim();
  const invalidRequest = refuseInvalidAmendmentRequest({ reason: input.reason, requestKey: input.requestKey });
  if (invalidRequest) return invalidRequest;

  const parsed = validateVerificationAmendmentOperations(input.operations);
  if (!parsed.valid) {
    return { status: "refused", reason: "invalid_operations", detail: parsed.detail };
  }
  const operations = parsed.operations;
  const requestedContinuation = input.requestedContinuation ?? null;

  const task = await deps.store.getTask(input.key);
  if (!task) {
    return {
      status: "refused",
      reason: "task_not_found",
      detail: `no task for ${input.key.sessionId}#${input.key.issueNumber}`,
    };
  }

  // §5.3 rules 1–2. The key is over the operations' reason-free identity form,
  // so retyping a reason on a retry cannot manufacture a second revision.
  const requestKey =
    input.requestKey ??
    deriveVerificationRequestKey({
      sessionId: input.key.sessionId,
      issueNumber: input.key.issueNumber,
      source: "admin-cli",
      requestedContinuation,
      operations,
    });

  // §5.3 rules 1 and 3: replay recognition precedes the §7.1 status table and
  // every plan comparison. A preview is exempt — it writes nothing on any path,
  // so the composition it exists to show stays more useful than a repeat notice.
  const chain = storedAmendmentChain(task);
  if (input.apply === true && chain) {
    const replayed = chain.revisions.find((revision) => revision.requestKey === requestKey);
    if (replayed) {
      return { status: "replay", revision: replayed, checkpoint: chain.checkpoint };
    }
  }

  // §7.1/§7.2: an APPLYING amendment refuses on an active or terminal task
  // before anything can be written. `applyVerificationAmendmentRevision`
  // re-checks this inside its transaction and that check stays authoritative;
  // this one exists because the §6.4 rule 5 rebase below commits a checkpoint
  // and an event first, and must never touch an in-flight task.
  if (input.apply === true) {
    const inadmissible = verificationAmendmentStatusRefusal(task);
    if (inadmissible) {
      return { status: "refused", reason: inadmissible.reason, detail: inadmissible.detail };
    }
  }

  // §9.2 rule 3: no continuation unparks a task the table parks. `none` is
  // always typeable; `review`/`implementation` are refused on a `none`-default
  // row rather than silently downgraded.
  const defaultContinuation = defaultVerificationContinuation(task);
  if (
    requestedContinuation !== null &&
    requestedContinuation !== "none" &&
    defaultContinuation === "none"
  ) {
    return {
      status: "refused",
      reason: "continuation_not_permitted",
      detail:
        `--continue ${requestedContinuation} is not permitted for a ${task.status}/${task.phase} task: ` +
        `the §9.2 row for it parks the task, and no continuation unparks it (§9.2 rule 3)`,
    };
  }
  // §9.2 (issue #1043): the route this revision takes — the typed value, or
  // the row default. The refusal above already excluded every combination the
  // table withholds, and `applyVerificationAmendmentRevision` re-checks the
  // row inside its own read before the CAS-pinned write.
  const continuation = requestedContinuation ?? defaultContinuation;

  const reconciliation = reconcileVerificationPlan(
    planInputOf(task, deps.extract, input.sessionVerification),
  );
  if (reconciliation.status === "invalid") {
    return { status: "refused", reason: "invalid_plan", detail: `${reconciliation.reason}: ${reconciliation.detail}` };
  }
  if (reconciliation.status === "unreconciled") {
    return {
      status: "refused",
      reason: "unreconciled",
      detail: `${reconciliation.detail} — refusing without repairing (§11 rule 6)`,
    };
  }
  const plan = reconciliation.plan;

  // §7.3 rule 3: a hard guard, checked before composition so a mismatch refuses
  // even where the CAS would have passed.
  if (input.expectedPlanDigest !== undefined && input.expectedPlanDigest !== plan.planDigest) {
    return {
      status: "refused",
      reason: "plan_digest_mismatch",
      detail:
        `--expect-plan-digest named ${input.expectedPlanDigest}, but the effective plan is ` +
        `${plan.planDigest}. Re-read the plan with \`task-verification show\` and re-issue.`,
    };
  }

  const baseline = buildVerificationSessionBaseline(input.sessionVerification ?? {});
  if (baseline.status === "invalid") {
    return { status: "refused", reason: "invalid_plan", detail: `session_verification: ${baseline.detail}` };
  }

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
    };
  }

  const revisionId = deriveVerificationRevisionId({
    sessionId: input.key.sessionId,
    issueNumber: input.key.issueNumber,
    requestKey,
    basePlanDigest: proposed.basePlanDigest,
    operations: proposed.operations,
  });

  const report: TaskVerificationAmendReport = {
    operations: proposed.operations,
    basePlanDigest: proposed.basePlanDigest,
    planDigest: proposed.planDigest,
    defaultContinuation,
    requestedContinuation,
    continuation,
    requestKey,
    revisionId,
  };

  if (input.apply !== true) {
    return { status: "preview", report, basePlan: plan, plan: proposed.plan };
  }

  // §6.4 rule 5: an authorized session-default edit rebases rather than
  // refusing; without it the apply below would refuse as stale against a
  // checkpoint that predates the edit.
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
      source: "admin-cli",
      actor: { kind: "operator", id: input.actorId },
      reason,
      operations: proposed.operations,
      basePlanDigest: proposed.basePlanDigest,
      planDigest: proposed.planDigest,
      sessionBaselineDigest: baseline.sessionBaselineDigest,
      continuation,
    },
    checkpoint: {
      planDigest: proposed.planDigest,
      sessionBaseline: baseline.sessionBaseline,
      sessionBaselineDigest: baseline.sessionBaselineDigest,
    },
    slotCounts: verificationPlanSlotCounts(proposed.plan),
    // §8.3 rule 1: the pre-revision bytes of every requirement slot, so a
    // `replace` invalidates the evidence its superseded bytes admitted inside
    // the same CAS. The whole layer is passed rather than a filtered subset —
    // the apply selects what its operations name, and a second filtering rule
    // here could only drift from it.
    baseRequirementCommands: Object.fromEntries(
      plan.requirement.map((slot) => [slot.commandId, slot.command] as const),
    ),
    // §12.2 (issue #1044): the public comment names the plan this revision
    // PRODUCES, so the projection is taken from the composed plan rather than
    // the one it was authored against. The write enqueues it in the same
    // transaction; a preview never reaches here and posts nothing.
    publication: { slots: verificationAmendmentPublicSlots(proposed.plan) },
    ...(input.session !== undefined ? { session: input.session } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  if (applied.status === "applied") {
    return {
      status: "applied",
      report,
      basePlan: plan,
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
  switch (applied.reason) {
    case "not_found":
      return { status: "refused", reason: "task_not_found", detail: applied.detail };
    case "invalid_input":
      return { status: "refused", reason: "invalid_revision", detail: applied.detail };
    case "malformed_state":
      return { status: "refused", reason: "malformed_state", detail: applied.detail };
    case "task_active":
      return { status: "refused", reason: "task_active", detail: applied.detail };
    case "task_terminal":
      return { status: "refused", reason: "task_terminal", detail: applied.detail };
    case "continuation_not_permitted":
      return { status: "refused", reason: "continuation_not_permitted", detail: applied.detail };
    case "chain_full":
      return { status: "refused", reason: "chain_full", detail: applied.detail };
    default:
      return { status: "refused", reason: "store_rejected", detail: applied.detail };
  }
}

// ---------------------------------------------------------------------------
// `reset`: the append-only return to the unamended baseline
// ---------------------------------------------------------------------------

/** One slot a reset would put back the way the unamended plan had it. */
export interface TaskVerificationResetEntry {
  commandId: string;
  layer: "execution" | "requirement";
  /** The slot's current effective bytes. */
  command: string;
  /** The bytes it entered the plan with; the target of a revert. */
  originCommand: string;
}

/**
 * What a reset would do, split by the kind of change each slot needs.
 *
 * The split matters because only one of the three weakens the plan: a
 * `retirement` removes a check the task currently runs, and is therefore the
 * one withheld without an explicit opt-in.
 */
export interface TaskVerificationResetDiff {
  /** Retired session-default/Issue slots an operator retired; a `restore`. */
  restores: readonly TaskVerificationResetEntry[];
  /** Slots whose bytes a `replace` moved; reverted to their origin bytes. */
  reverts: readonly TaskVerificationResetEntry[];
  /** Task-local `add`ed slots; retired, because an `add` cannot be un-added. */
  retirements: readonly TaskVerificationResetEntry[];
}

function resetEntry(slot: EffectiveVerificationSlot): TaskVerificationResetEntry {
  return {
    commandId: slot.commandId,
    layer: slot.layer,
    command: slot.command,
    originCommand: slot.originCommand,
  };
}

/**
 * Diff an effective plan against the plan its own inputs would resolve to with
 * no amendment applied (§6.1/§6.2 without the chain).
 *
 * The reset is expressed in the §5.2 operation vocabulary and nothing else,
 * because the chain is append-only (§5.3 rule 6): a reversal is a new revision,
 * never a deletion of the revisions it reverses. So a retired slot is
 * `restore`d, a replaced slot is `replace`d back to its origin bytes, and a
 * task-local `add` is `retire`d — the slot stays in the plan, reported
 * `retired`, which §8.4 rule 1 is explicit is not a passing result.
 *
 * A slot an `annotate` touched needs nothing, and an orphaned slot (§6.4 rule
 * 4) is absent from the plan and therefore already inert.
 */
export function diffTaskVerificationReset(plan: EffectiveVerificationPlan): TaskVerificationResetDiff {
  const restores: TaskVerificationResetEntry[] = [];
  const reverts: TaskVerificationResetEntry[] = [];
  const retirements: TaskVerificationResetEntry[] = [];
  for (const slot of [...plan.execution, ...plan.requirement]) {
    if (!slot.amended) continue;
    if (slot.origin === "task-amendment") {
      // The slot exists only because a revision added it. Retiring it is the
      // closest the operation set comes to un-adding it, and it is a removal.
      if (slot.state === "active") retirements.push(resetEntry(slot));
      continue;
    }
    if (slot.state === "retired") restores.push(resetEntry(slot));
    if (slot.command !== slot.originCommand) reverts.push(resetEntry(slot));
  }
  return { restores, reverts, retirements };
}

/**
 * The operations a reset applies, in the only order that composes (§5.3 rule
 * 7): every `restore` first — a `replace` on a retired slot refuses — then the
 * reverts, then the retirements the opt-in permits.
 *
 * Every operation carries the invocation's reason: §5.2 rule 1 makes the
 * revision-level statement the reason of each operation that carries none of
 * its own, and a reset authors no per-operation reason.
 */
export function taskVerificationResetOperations(
  diff: TaskVerificationResetDiff,
  options: { reason: string; allowRetire: boolean },
): VerificationAmendmentOperation[] {
  const operations: VerificationAmendmentOperation[] = [];
  for (const entry of diff.restores) {
    operations.push({ kind: "restore", commandId: entry.commandId, reason: options.reason });
  }
  for (const entry of diff.reverts) {
    operations.push({
      kind: "replace",
      commandId: entry.commandId,
      command: entry.originCommand,
      reason: options.reason,
    });
  }
  if (options.allowRetire) {
    for (const entry of diff.retirements) {
      operations.push({ kind: "retire", commandId: entry.commandId, reason: options.reason });
    }
  }
  return operations;
}

export type TaskVerificationResetOutcome =
  | TaskVerificationAmendOutcome
  /**
   * The plan already matches its unamended baseline, or the only difference is
   * one the opt-in withheld. No revision, no ordinal, no event — and the
   * withheld difference is reported rather than silently dropped.
   */
  | { status: "no_change"; planDigest: string };

/**
 * A reset's outcome together with what it read.
 *
 * The diff is reported for every outcome a plan was resolved for — preview,
 * apply, and no-change alike — so the surface never has to resolve the plan a
 * second time to explain what the reset would touch. It is absent only when the
 * refusal happened before a plan existed (an unknown task, an unresolvable
 * input, an unreconciled record).
 */
export interface TaskVerificationResetResult {
  outcome: TaskVerificationResetOutcome;
  diff?: TaskVerificationResetDiff;
  /** The removals this invocation is withholding (§8.4: never silent). */
  withheldRetirements?: readonly TaskVerificationResetEntry[];
}

export interface TaskVerificationResetInput {
  key: TaskKey;
  sessionVerification?: Record<string, string> | readonly VerificationPlanSessionBaselineEntry[];
  actorId: string;
  reason: string;
  /** Also retire the task-local slots an `add` created; withheld without it. */
  allowRetire?: boolean;
  apply?: boolean;
  requestKey?: string | undefined;
  expectedPlanDigest?: string | undefined;
  pinnedCommandIds?: readonly string[];
  /** Forwarded to the amend (issue #1043 review): a routed reset needs the
   * same atomic stack-ready/lane-label effects as a hand-typed revision. */
  session?: ResolvedSession;
  runId?: string;
  now?: string;
}

/**
 * Return an amended task to its unamended baseline as one ordinary revision.
 *
 * A reset is not a second mechanism and not a deletion: it reads the effective
 * plan, derives the §5.2 operations that undo the chain's effect, and goes
 * through {@link amendTaskVerification} like anything an operator could have
 * typed by hand — including §9.2 continuation (issue #1043): a reset types no
 * `--continue`, so an applied reset takes its row's default route, re-queuing
 * a review-lane park to `{queued, review}` exactly as an equivalent hand-typed
 * revision would. The plan it read is passed on as `--expect-plan-digest`, so a
 * plan that moves between the read and the write refuses rather than resetting
 * against something the operator never saw.
 *
 * §11 binds every rule to this spelling too, so a reset whose `--yes` committed
 * and whose response was lost is a §5.3 rule 3 replay like any other revision:
 * the supplied request key is looked up on the chain before the §7.1 status
 * table, before the digest guard, and before the nothing-to-do path, and the
 * stored revision is reported. Only a supplied key can be recognized — a reset's
 * operations are derived from the plan, so its own success erases the content a
 * derived key would be computed from, which is why the preview names the key to
 * pass back. Without one, a retry reads a plan already at its baseline and
 * reports `no_change`.
 */
export async function resetTaskVerification(
  deps: TaskVerificationDeps,
  input: TaskVerificationResetInput,
): Promise<TaskVerificationResetResult> {
  // Checked here as well as in the amend below, because a reset that finds
  // nothing to undo never reaches the amend and must still refuse malformed
  // input rather than reporting an unvalidated no-op as success (§11 rule 3,
  // §5.3 rule 2).
  const invalidRequest = refuseInvalidAmendmentRequest({ reason: input.reason, requestKey: input.requestKey });
  if (invalidRequest) return { outcome: invalidRequest };
  const described = await describeTaskVerificationPlan(deps, {
    key: input.key,
    ...(input.sessionVerification !== undefined ? { sessionVerification: input.sessionVerification } : {}),
  });
  if (described.status === "refused") {
    return { outcome: { status: "refused", reason: described.reason, detail: described.detail } };
  }
  const plan = described.view.plan;
  const allowRetire = input.allowRetire === true;
  const diff = diffTaskVerificationReset(plan);
  const withheldRetirements = allowRetire ? [] : diff.retirements;

  // §5.3 rules 1 and 3: replay recognition precedes the §7.1 status table, the
  // digest guard, and the nothing-to-do path below — all three of which would
  // otherwise hide a reset that already committed, because a reset's success
  // erases the operations it derives and moves the plan its own preview named.
  // A preview is exempt for the same reason an `amend` preview is: it writes
  // nothing, so showing the composition stays more useful than a repeat notice.
  // It sits after the read rather than ahead of it — unlike an `amend`, a reset
  // has no operations before the plan is resolved — which costs nothing: the
  // refusals above are an unknown task and a chain no input explains, and a
  // reset's own success produces neither.
  if (input.apply === true && input.requestKey !== undefined) {
    const checkpoint = described.view.checkpoint;
    const replayed = described.view.revisions.find((revision) => revision.requestKey === input.requestKey);
    if (replayed && checkpoint !== undefined) {
      return { outcome: { status: "replay", revision: replayed, checkpoint }, diff, withheldRetirements };
    }
  }

  // §7.1/§7.2 rule 4: an APPLYING reset refuses on an active or terminal task
  // even when it would have had nothing to do. Without this check the
  // nothing-to-do path below would report an active-task apply as an allowed
  // success and exit zero — the exact hole §7.2 rule 4 closes.
  if (input.apply === true && described.view.amendmentRefusal !== undefined) {
    return {
      outcome: {
        status: "refused",
        reason: described.view.amendmentRefusal.reason,
        detail: described.view.amendmentRefusal.detail,
      },
      diff,
      withheldRetirements,
    };
  }

  if (input.expectedPlanDigest !== undefined && input.expectedPlanDigest !== plan.planDigest) {
    return {
      outcome: {
        status: "refused",
        reason: "plan_digest_mismatch",
        detail:
          `--expect-plan-digest named ${input.expectedPlanDigest}, but the effective plan is ` +
          `${plan.planDigest}. Re-read the plan with \`task-verification show\` and re-issue.`,
      },
      diff,
      withheldRetirements,
    };
  }

  const operations = taskVerificationResetOperations(diff, { reason: input.reason, allowRetire });
  if (operations.length === 0) {
    return { outcome: { status: "no_change", planDigest: plan.planDigest }, diff, withheldRetirements };
  }

  const outcome = await amendTaskVerification(deps, {
    key: input.key,
    ...(input.sessionVerification !== undefined ? { sessionVerification: input.sessionVerification } : {}),
    actorId: input.actorId,
    reason: input.reason,
    operations,
    requestedContinuation: null,
    ...(input.apply !== undefined ? { apply: input.apply } : {}),
    ...(input.requestKey !== undefined ? { requestKey: input.requestKey } : {}),
    // The plan this reset was derived from is the plan it may be applied
    // against, and no other — an operator-supplied guard was already checked
    // against the same value above.
    expectedPlanDigest: plan.planDigest,
    ...(input.pinnedCommandIds !== undefined ? { pinnedCommandIds: input.pinnedCommandIds } : {}),
    ...(input.session !== undefined ? { session: input.session } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return { outcome, diff, withheldRetirements };
}
