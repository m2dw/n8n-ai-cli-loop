/**
 * `admin refinement recover` — §13's operator recovery command (issue #980,
 * docs/issue-refinement-contract.md §13, §12 row 36).
 *
 * The one documented way out of `ready_for_human` / phase `refinement` /
 * `escalated_human`. Before this existed, the transition it performs was
 * reachable only by editing SQLite by hand (issue #951), which is exactly the
 * kind of repair a supported command should own: it is a NORMAL recovery, not
 * an exceptional one — §13's whole design is that no automatic transition
 * leaves `escalated_human`, so every retry is a deliberate operator action.
 *
 * Shape, in the same order the command evaluates it:
 *
 *  1. Resolve the session (`--session-ref` or `--session-id`, the shared admin
 *     selector) and take the issue-scoped `<session>::issue-<n>` worktree lock —
 *     the SAME lock `run-one-phase` and `admin refinement run` serialize this
 *     Issue under, so a recovery can never race the lane it is resetting. The
 *     lock is taken for a PREVIEW too: a preview that reported a row a running
 *     phase was mid-way through moving would be reporting fiction.
 *  2. Refuse anything §13 does not permit — status, phase, block, state, live
 *     claim — before any read of GitHub.
 *  3. Read the live labels and evaluate §13's label precondition (the row-1
 *     admissible shape). A preview always REPORTS the observed labels; an apply
 *     refuses on a bad shape rather than half-performing.
 *  4. Without `--yes`, print the plan and stop. With `--yes`, commit the row-36
 *     reset, its `refinement.recovery.applied` event, the retirement of the
 *     handoff's own ready-for-human label ADD, and the ready-for-human label
 *     removal in ONE store transaction — refused in full, and retryable, if that
 *     label add is being dispatched at that instant (issue #980 review).
 *
 * Write surface, stated once: one task row, one event, one outbox row enqueued,
 * and one outbox row retired — the handoff's label add, which would otherwise
 * be free to retry after the removal dispatched and re-mark a recovered task as
 * needing a human (issue #980 review). No agent runs, no Issue body write, no
 * comment, no label ADD, and no artifact — the only GitHub call the command
 * makes itself is the read in step 3.
 */

import { randomBytes } from "crypto";

import {
  describeUnresolvedSessionId,
  JsonSessionRegistry,
} from "../registries/json-session-registry.js";
import type { ResolvedSession } from "../core/session.js";
import type { TaskStore, OutboxEffect } from "../core/task-store.js";
import type { TaskEvent } from "../core/task.js";
import { OutboxEffectCollector } from "../core/phase-runner.js";
import {
  enqueueRefinementRecoveryEffects,
  refinementRecoverySupersessionEffects,
} from "../core/outbox-effects.js";
import { resolveRefinementLabels } from "../core/issue-refinement.js";
import type {
  RefinementRecoveryLabelObservation,
  RefinementRecoveryPlan,
} from "../core/issue-refinement-recovery.js";
import {
  evaluateRefinementRecoveryLabels,
  evaluateRefinementRecoveryTarget,
  planRefinementRecovery,
  refinementRecoveryEvent,
} from "../core/issue-refinement-recovery.js";
import { IssueWorktreeLock } from "../handlers/worktree.js";
import type { AcquireResult } from "../stores/repo-lock-store.js";
import { defaultCommandRunner } from "../handlers/command-runner.js";
import { ghRunnerFromCommandRunner } from "../providers/github/gh-runner.js";
import type { GhRunner as ProviderGhRunner } from "../providers/github/gh-runner.js";
import { resolveGhRunner } from "../providers/github/github-app-auth.js";
import { createGhRefinementReads, runGhViaRunner } from "./github-intake.js";
import { parseCommonOptions } from "./admin-command.js";
import type { OutputMode } from "./cli-io.js";
import { die, report } from "./cli-io.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface RefinementRecoverArgs {
  sessionId: string;
  issueNumber: number;
  sessionsPath: string;
  dbPath: string | undefined;
  /** Issue-lock directory override; default is the runner's shared lock dir. */
  lockDir: string | undefined;
  /** §13: previews by default, mutates only with `--yes`. */
  apply: boolean;
}

export function parseRefinementRecoverArgs(
  argv: string[],
): RefinementRecoverArgs | { error: string } {
  // The shared admin selector, so `--session-ref ai-cli-loop` resolves exactly
  // as it does for every other operator command — §13 writes the command that
  // way, and issue #951 hit the gap by typing it that way.
  // Exactly one Issue, stated rather than assumed: the shared tokenizer keeps
  // the LAST value of a repeated flag, so `--issue-number 950 --issue-number
  // 951` would silently recover only one of the two an operator meant to name.
  // A recovery is a state reset; guessing which row it applies to is not an
  // option this command offers.
  if (argv.filter((a) => a === "--issue-number").length > 1) {
    return { error: "--issue-number must be given exactly once" };
  }
  const opts = parseCommonOptions(argv, {
    session: "required",
    issueNumber: "required",
    booleanFlags: ["yes"],
    valueFlags: ["lock-dir"],
  });
  if ("error" in opts) return { error: opts.error };
  return {
    sessionId: opts.sessionId,
    issueNumber: opts.issueNumber!,
    sessionsPath: opts.sessionsPath,
    dbPath: opts.dbPath,
    lockDir: opts.args["lock-dir"],
    apply: opts.flags.has("yes"),
  };
}

// ---------------------------------------------------------------------------
// Refusal text
// ---------------------------------------------------------------------------

/**
 * Every refusal says what was observed AND what the operator does next. A §13
 * refusal is the ordinary outcome of running this command against the wrong
 * row, so it is not an error message so much as a routing decision.
 */
function targetRefusalText(
  refusal: string,
  issueNumber: number,
  observed: { status?: string; phase?: string; state?: string | undefined },
): string {
  switch (refusal) {
    case "task_not_found":
      return `No task found for issue #${issueNumber} in this session.`;
    case "status_not_ready_for_human":
      return (
        `Task for issue #${issueNumber} is '${observed.status}', not 'ready_for_human'. `
        + "§13 recovery acts only on a task parked at a refinement handoff; nothing was changed."
      );
    case "phase_not_refinement":
      return (
        `Task for issue #${issueNumber} is at phase '${observed.phase}', not 'refinement'. `
        + "This command recovers the refinement lane only."
      );
    case "no_refinement_block":
      return (
        `Task for issue #${issueNumber} carries no context.refinement block, so it never `
        + "entered the refinement lane and has no §13 handoff to recover."
      );
    case "state_not_escalated_human":
      return (
        `Refinement state for issue #${issueNumber} is '${observed.state}', not 'escalated_human'. `
        + (observed.state === "pending"
          ? "This row is already recovered (or was never escalated) and is waiting for its next "
            + "refinement run; re-running recovery would reset an attempt that is live."
          : "Only a terminal handoff is recoverable; an attempt still in flight is left alone.")
      );
    case "task_claimed":
      return (
        `Task for issue #${issueNumber} is claimed by a live run and §13 refuses a claimed task. `
        + "Wait for the run to finish, or release the claim with `admin recover` once its lease expires."
      );
    default:
      return `Task for issue #${issueNumber} is not recoverable (${refusal}).`;
  }
}

function labelRefusalText(observation: RefinementRecoveryLabelObservation): string {
  if (observation.refusal === "marker_label_absent") {
    return (
      `\`${observation.markerLabel}\` is not on the Issue. §13 recovery returns the row to 'pending', `
      + "and row 2 refuses to admit an Issue that does not carry the marker: re-add "
      + `\`${observation.markerLabel}\` first`
      + (observation.executableStatusLabels.length > 0
        ? `, and remove the executable status label(s) ${observation.executableStatusLabels.join(", ")} `
          + "beside it (removal first, then the marker, so the Issue never carries both)."
        : ".")
    );
  }
  if (observation.refusal === "executable_status_label_present") {
    return (
      `The Issue carries executable status label(s) ${observation.executableStatusLabels.join(", ")} `
      + `beside \`${observation.markerLabel}\`. That is the both-markers shape §3 refuses outright — `
      + "remove the executable status label(s) before recovering."
    );
  }
  return "";
}

// ---------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------

interface RecoverReportInput {
  sessionId: string;
  issueNumber: number;
  applied: boolean;
  previousHandoffReason: string | null;
  recoveries: number;
  labels: RefinementRecoveryLabelObservation;
  reset: RefinementRecoveryPlan["reset"];
  /**
   * The label the removal will name: what the handoff recorded as having added,
   * or the session's configured one for a block written before that record
   * (issue #980 review). `null` only when there is neither.
   */
  readyForHumanLabel: string | null;
  /**
   * Idempotency keys of the handoff's own effects this recovery retires — the
   * ready-for-human label ADD, so a copy of it that never dispatched cannot
   * re-apply the label after the row is queued again (issue #980 review).
   * Empty when no label was ever added (none recorded, none configured) or the
   * block recorded no handoff reason.
   */
  supersededHandoffKeys: string[];
  refinementEnabled: boolean;
}

function renderRecover(input: RecoverReportInput, mode: OutputMode): string {
  const lines: string[] = [
    input.applied
      ? `Refinement recovery APPLIED — ${input.sessionId} #${input.issueNumber}`
      : `Refinement recovery PREVIEW — ${input.sessionId} #${input.issueNumber}`,
    "",
    "  task:            ready_for_human / refinement / escalated_human",
    `  handoff reason:  ${input.previousHandoffReason ?? "(none recorded)"}`,
    `  recovery:        #${input.recoveries}`,
    `  issue labels:    ${input.labels.labels.length > 0 ? input.labels.labels.join(", ") : "(none)"}`,
    `  marker:          ${input.labels.markerLabel} ${input.labels.markerPresent ? "present" : "ABSENT"}`,
    `  executable:      ${
      input.labels.executableStatusLabels.length > 0
        ? input.labels.executableStatusLabels.join(", ")
        : "(none — admissible)"
    }`,
    "",
    input.applied ? "  Reset performed:" : "  Reset that would be performed:",
    ...input.reset.cleared.map((c) => `    clear    ${c}`),
    ...input.reset.preserved.map((p) => `    preserve ${p}`),
    "",
    input.readyForHumanLabel === null
      ? "  ready-for-human label: (none recorded by the handoff, none configured — nothing to remove)"
      : input.applied
        ? `  ready-for-human label: '${input.readyForHumanLabel}' removal enqueued on the outbox`
        : `  ready-for-human label: '${input.readyForHumanLabel}' would be removed through the outbox`,
  ];
  // The handoff's own label add is retired in the same transaction; without it,
  // an add still sitting on the outbox could re-apply the label after the task
  // is queued again (issue #980 review).
  for (const key of input.supersededHandoffKeys) {
    lines.push(
      input.applied
        ? `  handoff label add:     cancelled if still undelivered (${key})`
        : `  handoff label add:     would be cancelled if still undelivered (${key})`,
    );
  }
  if (!input.refinementEnabled) {
    lines.push(
      "",
      "  NOTE: issueRefinement.enabled is not true for this session. The row will sit at",
      "  queued/refinement until the lane is enabled again — recovery still clears the handoff.",
    );
  }
  if (!input.applied) {
    lines.push(
      "",
      "  Nothing was changed. Re-run with --yes to apply.",
    );
  } else {
    lines.push(
      "",
      "  The next refinement run captures a fresh predecessor snapshot and starts with the refiner.",
    );
  }
  if (mode.verbose) {
    lines.push("", "  §12 row 36, docs/issue-refinement-contract.md §13.");
  }
  return lines.join("\n");
}

/** The stable JSON payload, built once so preview and apply cannot diverge. */
function recoverJson(
  input: RecoverReportInput,
  refusal: string | null,
): Record<string, unknown> {
  return {
    ok: true,
    command: "refinement-recover",
    sessionId: input.sessionId,
    issueNumber: input.issueNumber,
    applied: input.applied,
    refusal,
    previousHandoffReason: input.previousHandoffReason,
    recoveries: input.recoveries,
    labels: input.labels,
    reset: input.reset,
    readyForHumanLabel: input.readyForHumanLabel,
    supersededHandoffKeys: input.supersededHandoffKeys,
    refinementEnabled: input.refinementEnabled,
    ...(input.applied
      ? {
          event: "refinement.recovery.applied",
          taskStatus: "queued",
          taskPhase: "refinement",
          refinementState: "pending",
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

async function resolveSession(
  sessionId: string,
  sessionsPath: string,
): Promise<ResolvedSession | { error: string }> {
  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    return {
      error: `Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const session = await registry.getSessionById(sessionId);
  if (!session) {
    return { error: describeUnresolvedSessionId(registry, sessionId, sessionsPath) };
  }
  return session;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * Injection seams; every default is the production path except `store`, which
 * has no default here — the admin composition root constructs the concrete
 * adapter (issue #613/P1 confinement).
 */
export interface RefinementRecoverDeps {
  store: TaskStore;
  /** Live label read; defaults to the session's configured `gh` identity. */
  readIssueLabels?: (issueNumber: number) => Promise<readonly string[]>;
  /** Issue-scoped execution lock; defaults to the shared runner lock directory. */
  issueLock?: IssueWorktreeLock;
  now?: () => number;
  runId?: string;
}

export async function runRefinementRecover(
  args: RefinementRecoverArgs,
  deps: RefinementRecoverDeps,
): Promise<void> {
  const session = await resolveSession(args.sessionId, args.sessionsPath);
  if ("error" in session) {
    die(session.error);
    return;
  }

  const store = deps.store;
  const key = { sessionId: session.sessionId, issueNumber: args.issueNumber };
  const runId = deps.runId ?? `refine-recover-${randomBytes(6).toString("hex")}`;

  // The same issue lock `admin refinement run` takes, and for the same reason:
  // a phase runner tick that owns this Issue is mid-attempt, and neither the
  // preview's report nor the apply's CAS may be evaluated against a row that is
  // being moved underneath them.
  const issueLock = deps.issueLock ?? new IssueWorktreeLock(args.lockDir);
  let acquisition: AcquireResult;
  try {
    acquisition = issueLock.acquire(runId, session.sessionId, args.issueNumber);
  } catch (err) {
    die(
      `Failed to acquire the issue lock for issue #${args.issueNumber}: `
        + `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (!acquisition.locked) {
    die(
      `issue #${args.issueNumber} is already running (worktree lock held by `
        + `${acquisition.ownerContextId} since ${acquisition.ownerStartedAt}); `
        + "wait for that run to finish, or release a stale lock with `admin worktree release-lock`.",
    );
    return;
  }
  const releaseLock = (): void => {
    try {
      issueLock.release(runId, session.sessionId, args.issueNumber);
    } catch {
      /* ignore — leaked locks are recovered by TTL/admin */
    }
  };
  // `die` exits without unwinding, so the `finally` below never runs on a
  // refusal path: release explicitly first.
  const dieLocked = (message: string): never => {
    releaseLock();
    die(message);
  };

  try {
    const nowMs = deps.now ? deps.now() : Date.now();
    const now = new Date(nowMs).toISOString();
    const task = await store.getTask(key);
    const target = evaluateRefinementRecoveryTarget(task, now);
    if (!target.ok) {
      dieLocked(
        targetRefusalText(target.refusal, args.issueNumber, {
          ...(task ? { status: task.status, phase: task.phase } : {}),
          state: target.state,
        }),
      );
      return;
    }

    const laneLabels = resolveRefinementLabels(session.labels);
    const markerLabel = target.block.markerLabel ?? laneLabels.marker;

    // Same posture as `admin refinement run`: the read runs as the session's
    // configured work-item identity, and a non-GitHub work-item provider has no
    // gh-backed adapter to build, so it fails closed rather than shelling `gh`
    // against a repo it does not serve.
    const buildLabelReader = async (): Promise<(n: number) => Promise<readonly string[]>> => {
      const workItemKind = session.workItemProvider?.provider ?? "github-issues";
      if (workItemKind !== "github-issues") {
        dieLocked(
          `Refinement recovery cannot read Issue labels for work-item provider "${workItemKind}"; `
            + "§13's label precondition is unverifiable here, so nothing was changed.",
        );
      }
      let runner: ProviderGhRunner;
      try {
        runner = await resolveGhRunner(
          session.workItemProvider?.auth ?? { mode: "gh" },
          ghRunnerFromCommandRunner(defaultCommandRunner),
        );
      } catch (err) {
        return dieLocked(
          `Failed to resolve GitHub provider auth: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const reads = createGhRefinementReads({
        githubRepo: session.githubRepo,
        runGh: runGhViaRunner(runner, session.repoRoot),
      });
      return async (issueNumber: number) => (await reads.readIssue(issueNumber)).labels;
    };
    const readLabels = deps.readIssueLabels ?? (await buildLabelReader());

    let observation: RefinementRecoveryLabelObservation;
    try {
      observation = evaluateRefinementRecoveryLabels(await readLabels(args.issueNumber), markerLabel);
    } catch (err) {
      // A label read that fails is NOT "no labels": §13's precondition is
      // unverifiable, and applying against an unknown shape is the half-performed
      // recovery the contract refuses.
      dieLocked(
        `Failed to read the labels of issue #${args.issueNumber}: `
          + `${err instanceof Error ? err.message : String(err)}; nothing was changed.`,
      );
      return;
    }

    const plan = planRefinementRecovery({ block: target.block, now });
    // The label the handoff actually ADDED wins over the session's current
    // config: `labels.readyForHuman` may have been renamed since the escalation,
    // and this removal compensates for that specific add (issue #980 review). A
    // block written before the record existed falls back to config, which is the
    // value its own handoff read.
    const readyForHumanLabel =
      plan.previousHandoffLabel ?? (session.labels["readyForHuman"] as string | undefined) ?? null;
    // Built once, here, so the preview names the row the apply will retire —
    // and so the two can never derive a different key (issue #980 review). The
    // handoff being undone was raised at the ordinal before this recovery's.
    const supersessions = refinementRecoverySupersessionEffects(
      session,
      key,
      {
        reason: plan.previousHandoffReason,
        recoveries: plan.recoveries - 1,
        appliedLabel: plan.previousHandoffLabel,
      },
      now,
    );
    const payload: RecoverReportInput = {
      sessionId: session.sessionId,
      issueNumber: args.issueNumber,
      applied: false,
      previousHandoffReason: plan.previousHandoffReason,
      recoveries: plan.recoveries,
      labels: observation,
      reset: plan.reset,
      readyForHumanLabel,
      supersededHandoffKeys: supersessions.map((e) => e.idempotencyKey),
      refinementEnabled: session.issueRefinement?.enabled === true,
    };

    if (observation.refusal !== null) {
      // A PREVIEW still reports the observed shape and names the missing step
      // (§13: "the preview reports the observed labels and names the missing
      // step"); only an apply is refused outright.
      if (args.apply) {
        dieLocked(labelRefusalText(observation));
        return;
      }
      report(
        recoverJson(payload, observation.refusal),
        (mode) =>
          renderRecover(payload, mode)
          + `\n\n  REFUSED (${observation.refusal}): ${labelRefusalText(observation)}`,
      );
      return;
    }

    if (!args.apply) {
      report(recoverJson(payload, null), (mode) => renderRecover(payload, mode));
      return;
    }

    // The row-36 transition, in ONE transaction: the reset block, the requeue,
    // the audit event, the retirement of the handoff's own label add, and the
    // label removal. `completePhaseWithEffects` is the same boundary `admin
    // refinement run` commits through — a reset that landed without its event
    // would be an unrepairable gap, because the second run would refuse the (now
    // `pending`) row.
    const event = refinementRecoveryEvent({
      issueNumber: args.issueNumber,
      previousHandoffReason: plan.previousHandoffReason,
      recoveries: plan.recoveries,
      markerLabel,
    });
    const collector = new OutboxEffectCollector();
    await enqueueRefinementRecoveryEffects(
      collector, session, key, plan.recoveries, now, plan.previousHandoffLabel,
    );
    // Retirement BEFORE the removal, in the order an operator would reason about
    // it: stop the add that is still owed, then take off the one that landed.
    // Both are in the same transaction, so the order is documentation rather
    // than mechanism — but a set that only ever compensated would let a delayed
    // add retry after the removal dispatched (issue #980 review).
    const effects: OutboxEffect[] = [...supersessions, ...collector.effects];
    const taskEvent: TaskEvent = {
      task: key,
      type: event.type,
      runId,
      data: event.data,
      createdAt: now,
    };
    const committed = await store.completePhaseWithEffects(
      {
        key,
        // CAS on the row this command actually read and reported on: a tick that
        // moved it while the labels were being read loses this write entirely
        // rather than resetting an attempt that has since restarted.
        expected: { revision: task!.revision },
        patch: {
          status: "queued",
          phase: "refinement",
          context: { refinement: plan.block },
          // §13's "task delay, lease, owner, and last error" — the row must be
          // immediately claimable, not held behind the handoff's leftovers.
          notBefore: undefined,
          ownerRunId: undefined,
          leaseExpiresAt: undefined,
          lastError: undefined,
          now,
        },
        event: taskEvent,
      },
      effects,
    );
    if (!committed.ok) {
      // `effect_in_flight` is contention, not a wrong row: the handoff's own
      // label add is being dispatched at this instant, and cancelling it could
      // not stop the request already on the wire — which would land AFTER this
      // recovery's removal and leave the Issue marked as needing a human (issue
      // #980 review). Nothing was written; the same command succeeds once that
      // attempt resolves, so the operator is told to wait rather than to fix
      // something.
      dieLocked(
        committed.code === "effect_in_flight"
          ? `The ready-for-human label add from the handoff on issue #${args.issueNumber} is being `
            + "dispatched right now, so recovery would race it: the add could land after this "
            + "command's removal and leave the label on a requeued task. Nothing was changed — "
            + "re-run in a few seconds, once that dispatch attempt has finished."
          : `Refinement recovery was refused by the store (${committed.code}); nothing was persisted — `
            + "the reset, its audit event, and the label removal land together or not at all. "
            + "Re-run against the current row.",
      );
      return;
    }

    const applied: RecoverReportInput = { ...payload, applied: true };
    report(recoverJson(applied, null), (mode) => renderRecover(applied, mode));
  } finally {
    releaseLock();
  }
}
