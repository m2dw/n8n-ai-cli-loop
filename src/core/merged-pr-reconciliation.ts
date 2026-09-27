/**
 * Merged-PR task reconciliation — the operation core (issue #1047).
 *
 * Implements docs/merged-pr-reconciliation-contract.md (issue #1046): given a
 * task's **exact recorded pull request**, decide the §7 outcome for the row
 * and — for the two writing outcomes — commit the §8 transition, the §9.1
 * audit event, and the §9.4 operator-visible comment atomically through
 * `TaskStore.completePhaseWithEffects` (the transactional shape issue
 * #701/#608 established; §8.4 names it).
 *
 * Boundaries, straight from the contract:
 *
 *   - **Provider data only, never prose** (§5.3): the decision reads the
 *     provider's structured `number`/`url`/`headRefName`/`state` echo of the
 *     recorded PR. It never parses CLI output, and a failed read is a
 *     refusal, never "not merged" (§12.1).
 *   - **Exact recorded identity** (§4): `task.context.prUrl` is the identity.
 *     Nothing is ever inferred from the Issue number, the `ai/issue-<n>`
 *     branch convention, or a search for merged PRs.
 *   - **Lifecycle metadata only** (§13): the complete set of writes is the
 *     task row's status/context patch, one `task.merged_pr_reconciled` event,
 *     and one work-item comment effect. No worktree, branch, file, label, or
 *     work-item state is touched, and no lock is taken (§11.6).
 *   - **Fail closed** (§12): every uncertainty — unsupported host, missing
 *     identity, provider error, identity mismatch, unusable claim metadata,
 *     malformed disposition history, lost CAS — refuses and writes nothing,
 *     leaving the row byte-identical (§7.2 R5).
 *
 * No CLI parsing and no admin UI live here; the operator command is a
 * separate slice (contract §17 slice 3). Neighbouring
 * `core/pr-reconciliation.ts` (#998) decides a different question —
 * PR-creation-retry adoption of an OPEN PR — and deliberately shares no code
 * path with this module (§15.2).
 */
import type { AiTask, TaskEvent, TaskExpected, TaskKey, TaskPatch } from "./task.js";
import type { TaskStore } from "./task-store.js";
import type { RepoHostProviderKind, ResolvedSession } from "./session.js";
import { extractPrNumber, resolvePrContext } from "./pr-context.js";
import { isClaimExpired } from "./transitions.js";
import { hasUnresolvedToolRequest } from "./tool-request.js";
import { sanitizeBody } from "./text-sanitize.js";
import { sessionRedactionPaths, workItemOutbox } from "./outbox-effects.js";
import { OutboxEffectCollector } from "./phase-runner.js";
import { makeOutboxKey } from "./outbox.js";

/** Closed outcome vocabulary — exactly the six §3 values, never widened. */
export type MergedPrReconciliationOutcome =
  | "reconciled"
  | "recorded-terminal"
  | "already-reconciled"
  | "noop-done"
  | "active"
  | "refused";

/** Closed refusal vocabulary — exactly the ten §3 values, never widened. */
export type MergedPrReconciliationRefusal =
  | "missing-pr-identity"
  | "pr-lookup-failed"
  | "identity-mismatch"
  | "not-merged"
  | "active-recovery-required"
  | "invalid-claim-metadata"
  | "malformed-disposition-history"
  | "tool-request-unresolved"
  | "stale-state"
  | "store-refused";

/**
 * Preview is the caller's default posture (§11.1 — the operator surface must
 * preview unless an explicit apply flag is given); this core takes the mode
 * explicitly so neither behavior is ever reached by accident. A preview
 * performs every read — including the live provider read — and no write, and
 * reports the exact outcome the apply would produce (§11.2). It is not a
 * promise: an apply re-evaluates from scratch (§11.3).
 */
export type MergedPrReconciliationMode = "preview" | "apply";

/** The task-context key holding the §9.2 append-only disposition history. */
export const MERGED_PR_RECONCILIATIONS_CONTEXT_KEY = "mergedPrReconciliations";

/** The single new task event type (§9.1). Appended only by writing outcomes. */
export const TASK_MERGED_PR_RECONCILED_EVENT = "task.merged_pr_reconciled";

/**
 * One §9.2 disposition entry / §9.1 event payload. `prUrl` + `prNumber` are
 * the §10.1 identity key; the remaining fields are bounded audit metadata.
 * Unknown fields on a persisted entry are preserved verbatim and never
 * validated (§9.2.5), hence the open index signature.
 */
export interface MergedPrDispositionRecord {
  prUrl: string;
  prNumber: number;
  [field: string]: unknown;
}

export type MergedPrDispositionHistoryValidation =
  | { valid: true; entries: MergedPrDispositionRecord[] }
  | { valid: false; detail: string };

/**
 * §10.1 identity-key separator between `prNumber` and `prUrl`. NUL occurs in
 * neither field, so the joined key collides only on a true identity match.
 * Built via `String.fromCharCode(0)` — never written as a raw byte — so this
 * file stays a normal text source to Git and review tooling.
 */
const IDENTITY_KEY_SEPARATOR = String.fromCharCode(0);

/**
 * Validate `context.mergedPrReconciliations` against the §9.2.4 schema before
 * anything reads it. A valid history is either absent (`undefined` — the
 * normal pre-first-reconciliation shape, reported here as zero entries) or a
 * JSON array whose every element is an object carrying a non-empty string
 * `prUrl` and an integer `prNumber`, with no two elements sharing one §10.1
 * identity key. Anything else is malformed, and per §9.2.6 it is never
 * repaired, coerced, or read as an empty list — the caller refuses
 * `"malformed-disposition-history"` and writes nothing.
 */
export function validateMergedPrDispositionHistory(value: unknown): MergedPrDispositionHistoryValidation {
  if (value === undefined) return { valid: true, entries: [] };
  if (!Array.isArray(value)) {
    return {
      valid: false,
      detail: `the persisted value is not an array (got ${value === null ? "null" : typeof value})`,
    };
  }
  const seen = new Set<string>();
  const entries: MergedPrDispositionRecord[] = [];
  for (let i = 0; i < value.length; i++) {
    const element: unknown = value[i];
    if (typeof element !== "object" || element === null || Array.isArray(element)) {
      return { valid: false, detail: `element ${i} is not an object` };
    }
    const record = element as Record<string, unknown>;
    if (typeof record.prUrl !== "string" || record.prUrl.length === 0) {
      return { valid: false, detail: `element ${i} carries no non-empty string prUrl` };
    }
    if (typeof record.prNumber !== "number" || !Number.isInteger(record.prNumber)) {
      return { valid: false, detail: `element ${i} carries no integer prNumber` };
    }
    const key = `${record.prNumber}${IDENTITY_KEY_SEPARATOR}${record.prUrl}`;
    if (seen.has(key)) {
      return { valid: false, detail: `two entries share one identity key (${record.prUrl} #${record.prNumber})` };
    }
    seen.add(key);
    entries.push(element as MergedPrDispositionRecord);
  }
  return { valid: true, entries };
}

/**
 * §12.4 — decided once per invocation, before any task is read. Only a repo
 * host whose PR `state` can distinguish *merged* from *closed-unmerged* can
 * supply the §5 signal. Today that is exactly `github` (`MERGED` vs `CLOSED`);
 * `GiteaRepoHostProvider` maps `state` verbatim from Gitea's `open`/`closed`,
 * so a merged Gitea PR is indistinguishable from a closed-unmerged one and the
 * host is refused outright — widening the §5.4 comparison instead is
 * prohibited. The reserved kinds have no runtime provider and fail closed.
 */
export function assessMergedPrProviderSupport(
  kind: RepoHostProviderKind,
): { supported: true } | { supported: false; reason: "unsupported-provider"; message: string } {
  if (kind === "github") return { supported: true };
  if (kind === "gitea") {
    return {
      supported: false,
      reason: "unsupported-provider",
      message:
        'the "gitea" repo host reports PR state verbatim as open/closed, so a merged PR is ' +
        "indistinguishable from a closed-unmerged one; it cannot supply the MERGED signal " +
        "(docs/merged-pr-reconciliation-contract.md §12.4)",
    };
  }
  return {
    supported: false,
    reason: "unsupported-provider",
    message: `the "${kind}" repo host has no runtime provider and cannot supply the MERGED signal`,
  };
}

/**
 * The pull-request fields the decision reads, declared structurally so this
 * module depends on nothing outside `core/` (the providers' `PullRequest` is
 * assignable). `mergeCommit` anticipates the optional §16 provider slice; it
 * is recorded only when the provider actually reported a string, and its
 * absence never blocks reconciliation and is never filled in.
 */
export interface MergedPrProviderPullRequest {
  number?: number;
  url?: string;
  headRefName?: string;
  state?: string;
  mergeCommit?: string;
}

export type MergedPrProviderRead =
  | { ok: true; value: MergedPrProviderPullRequest }
  | { ok: false; error: string };

/** The slice of the session repo host this operation consumes. */
export interface MergedPrRepoHostPort {
  kind: RepoHostProviderKind;
  getPullRequest(selector: string): MergedPrProviderRead;
}

/**
 * The slice of `IssueWorktreeLock` this operation consumes (§6.2). A live
 * lock is `locked: true` with `stale` not `true`; a stale lock is crashed-run
 * residue that does not protect the row — and is never released here (§13.2).
 */
export interface MergedPrIssueLockPort {
  inspect(sessionId: string, issueNumber: number, now?: string): { locked: boolean; stale: boolean | null };
}

export interface MergedPrReconciliationDeps {
  store: TaskStore;
  repoHost: MergedPrRepoHostPort;
  issueLock: MergedPrIssueLockPort;
  /** Used only to address and sanitize the §9.4 work-item comment effect. */
  session: ResolvedSession;
}

export interface MergedPrReconciliationRequest {
  sessionId: string;
  issueNumber: number;
  mode: MergedPrReconciliationMode;
  /** Run identity stamped on the event and the comment's outbox key. */
  runId: string;
  /** Observation clock; defaults to the wall clock. */
  now?: string;
}

export type MergedPrTaskReconciliationResult =
  /** §12.4 command-level refusal — decided before the task row is even read. */
  | { outcome: "unsupported-provider"; message: string }
  /** Addressing error: no task row exists for the requested key. Outside §7, which maps statuses. */
  | { outcome: "task-not-found"; message: string }
  | { outcome: "noop-done" }
  | { outcome: "already-reconciled"; prUrl: string; prNumber: number }
  | { outcome: "active"; reason: "issue-lock" | "valid-claim"; message: string }
  | {
      outcome: "refused";
      refusal: MergedPrReconciliationRefusal;
      message: string;
      /**
       * The provider's `state` for the recorded PR, as it was read — reporting
       * metadata for the operator surface (issue #1048), which has to show the
       * live PR state beside the refusal without a second provider call.
       *
       * Present only for the refusals decided AFTER a successful §4.3 read
       * (`identity-mismatch`, `not-merged`) and only when the provider actually
       * reported a state. The decision never reads this back, and its absence is
       * never a signal: a missing state is already the `"not-merged"` refusal
       * §4.4 requires.
       */
      providerState?: string;
    }
  | { outcome: "reconciled"; applied: boolean; record: MergedPrDispositionRecord; task?: AiTask }
  | { outcome: "recorded-terminal"; applied: boolean; record: MergedPrDispositionRecord; task?: AiTask };

/**
 * Evaluate the §7 table for one task and, in `apply` mode, commit the writing
 * outcome atomically. Rows are evaluated in exactly the §7.1 precedence
 * order; the first matching row wins, and every refusal writes nothing.
 */
export async function reconcileMergedPrTask(
  request: MergedPrReconciliationRequest,
  deps: MergedPrReconciliationDeps,
): Promise<MergedPrTaskReconciliationResult> {
  // §7.1 step 1 — session provider support, before any task is read (§12.4).
  const support = assessMergedPrProviderSupport(deps.repoHost.kind);
  if (!support.supported) return { outcome: "unsupported-provider", message: support.message };

  const now = request.now ?? new Date().toISOString();
  const key: TaskKey = { sessionId: request.sessionId, issueNumber: request.issueNumber };
  const task = await deps.store.getTask(key);
  if (!task) {
    return {
      outcome: "task-not-found",
      message: `no task exists for issue #${request.issueNumber} in session "${request.sessionId}"`,
    };
  }

  // §7.1 step 2 — row 11: a finished task is an informative no-op that never
  // consumes a provider call and never reports `active`.
  if (task.status === "done") return { outcome: "noop-done" };

  // §7.1 step 3 — rows 26 then 16, from the task row alone and in that order:
  // the history is validated before it is read (§9.2.4), and a value that
  // cannot be validated is row 26, never "no entry found" (§10.1).
  const history = validateMergedPrDispositionHistory(task.context[MERGED_PR_RECONCILIATIONS_CONTEXT_KEY]);
  if (!history.valid) {
    return refusal(
      "malformed-disposition-history",
      `context.${MERGED_PR_RECONCILIATIONS_CONTEXT_KEY} is not a valid disposition history: ` +
        `${history.detail}. It is never repaired or overwritten here (§9.2.6); restore or remove ` +
        `the value through whichever surface wrote it, then re-run.`,
    );
  }

  const { prUrl, branch } = resolvePrContext(task);
  const prNumber = prUrl === undefined ? undefined : extractPrNumber(prUrl);
  if (prUrl !== undefined && prNumber !== undefined) {
    // Row 16 — the idempotency key is the complete recorded identity
    // (prUrl, prNumber), both compared verbatim (§10.1); the number alone is
    // deliberately not the key (§10.1.1).
    const already = history.entries.some((entry) => entry.prUrl === prUrl && entry.prNumber === prNumber);
    if (already) return { outcome: "already-reconciled", prUrl, prNumber };
  }

  // §7.1 step 4 — execution safety, from the task row and the Issue lock,
  // with no provider call. A live run is reported as such whether or not its
  // PR is merged (§6.2/§6.3).
  const lock = deps.issueLock.inspect(request.sessionId, request.issueNumber, now);
  const liveLock = lock.locked === true && lock.stale !== true;
  if (task.status === "claimed" || task.status === "running") {
    const hasOwner = typeof task.ownerRunId === "string" && task.ownerRunId.length > 0;
    const leaseAtMs = task.leaseExpiresAt === undefined ? Number.NaN : Date.parse(task.leaseExpiresAt);
    const validClaim = hasOwner && Number.isFinite(leaseAtMs) && leaseAtMs > Date.parse(now);
    if (validClaim || liveLock) {
      // Rows 7/9.
      return {
        outcome: "active",
        reason: validClaim ? "valid-claim" : "issue-lock",
        message: validClaim
          ? `run "${task.ownerRunId}" holds a valid claim (lease expires ${task.leaseExpiresAt})`
          : `a live Issue lock is held for issue #${request.issueNumber}`,
      };
    }
    if (isClaimExpired(task, now)) {
      // Rows 8/10 — recovery owns an expired claimed/running row; two writers
      // CAS-ing the same row with no shared lock is exactly the race this
      // contract refuses to enter (§6.3). No force flag exists.
      return refusal(
        "active-recovery-required",
        `the ${task.status} row's lease expired at ${task.leaseExpiresAt} and no live Issue lock ` +
          `protects it; recover it with \`admin recover\` (it re-queues, which reconciliation then handles)`,
      );
    }
    // Rows 24/25 — the residual branch: neither a valid claim nor a
    // demonstrably expired lease (§6.3.1). Treated as potentially live and
    // never reconciled; recovery does not own this row either (§6.3.2).
    return refusal(
      "invalid-claim-metadata",
      `the ${task.status} row carries neither a valid claim nor a demonstrably expired lease ` +
        `(ownerRunId: ${task.ownerRunId ?? "<absent>"}, leaseExpiresAt: ${task.leaseExpiresAt ?? "<absent>"}); ` +
        `it is treated as potentially live and is never reconciled (§6.3.1)`,
    );
  }
  if (liveLock) {
    // Rows 2/4/6/13/15 — every writing outcome is withheld under a live lock.
    return {
      outcome: "active",
      reason: "issue-lock",
      message: `a live Issue lock is held for issue #${request.issueNumber}`,
    };
  }

  // §7.1 step 5 — row 17: the cross-gate Tool Request refusal (§6.4), decided
  // from the task row with no provider call. It displaces exactly the five
  // writing rows — including `recorded-terminal` on failed/cancelled — and a
  // live request closes only through its own resolution surfaces (§15.4).
  if (hasUnresolvedToolRequest(task.context)) {
    return refusal(
      "tool-request-unresolved",
      "the task carries an unresolved Tool Request; resolve it via `admin tool-request resolve`/" +
        "`grant` first, then re-run reconciliation",
    );
  }

  // §7.1 step 6 — identity and signal, rows 18 → 19 → 20 → 21.
  if (prUrl === undefined || prNumber === undefined) {
    return refusal(
      "missing-pr-identity",
      prUrl === undefined
        ? "the task records no context.prUrl; the recorded PR identity is required and never derived (§4.2)"
        : `no PR number can be extracted from the recorded prUrl "${prUrl}"`,
    );
  }
  const observedAt = now;
  const read = deps.repoHost.getPullRequest(String(prNumber));
  if (!read.ok) {
    // §12.1 — never inferred as "not merged", never a second lookup strategy.
    return refusal("pr-lookup-failed", `the live provider read failed: ${read.error}`);
  }
  const pr = read.value;
  // Reporting metadata only (issue #1048) — see the `providerState` field note.
  const observedState = typeof pr.state === "string" ? pr.state : undefined;
  // §4.3/§4.4 — the provider must echo the recorded identity; absent fields
  // are refusals, not passes, and a disagreement is never a correction.
  if (typeof pr.number !== "number" || pr.number !== prNumber) {
    return refusal(
      "identity-mismatch",
      `the provider returned PR number ${pr.number ?? "<unreported>"}, not the recorded #${prNumber}`,
      observedState,
    );
  }
  if (typeof pr.url !== "string" || pr.url !== prUrl) {
    return refusal(
      "identity-mismatch",
      `the provider returned URL ${pr.url ?? "<unreported>"}, not the recorded ${prUrl}`,
      observedState,
    );
  }
  if (branch !== undefined && pr.headRefName !== branch) {
    return refusal(
      "identity-mismatch",
      `the provider returned head "${pr.headRefName ?? "<unreported>"}", not the recorded branch "${branch}"`,
      observedState,
    );
  }
  // §5.4 — compared case-insensitively against exactly MERGED; OPEN and
  // CLOSED are both not-merged, and a closed-unmerged PR is routed to
  // `admin task reconcile-closed`, which cancels (§12.3).
  if (typeof pr.state !== "string" || pr.state.toUpperCase() !== "MERGED") {
    return refusal(
      "not-merged",
      pr.state === undefined
        ? `the provider reported no state for PR #${prNumber}; absence has not confirmed a merge (§4.4)`
        : `PR #${prNumber} is ${pr.state}, not MERGED; a closed-unmerged PR is handled by ` +
            "`admin task reconcile-closed`, never here (§12.3)",
      observedState,
    );
  }

  // §7.1 step 7 — status routing (rows 1, 3, 5, 12, 14). Every status is
  // accounted for above; only these five remain.
  const transitionsToDone =
    task.status === "queued" || task.status === "blocked" || task.status === "ready_for_human";
  const keepsTerminalStatus = task.status === "failed" || task.status === "cancelled";
  if (!transitionsToDone && !keepsTerminalStatus) {
    // §12.5 — an unnamed case is surfaced, never guessed. Unreachable for a
    // well-formed store; a raw row carrying a status outside `TaskStatus`
    // lands here instead of being silently written.
    throw new Error(`merged-PR reconciliation reached an unnamed task status "${task.status as string}"`);
  }
  const outcome: "reconciled" | "recorded-terminal" = transitionsToDone ? "reconciled" : "recorded-terminal";

  // The §9.1/§9.2 record — one bounded entry, identical fields on the event.
  // `mergeCommit` is present only when the provider reported one (§16); it is
  // never derived locally and never synthesized (§9.3).
  const record: MergedPrDispositionRecord = {
    prUrl,
    prNumber,
    providerState: pr.state,
    ...(typeof pr.mergeCommit === "string" && pr.mergeCommit.length > 0
      ? { mergeCommit: pr.mergeCommit }
      : {}),
    observedAt,
    previousStatus: task.status,
    previousPhase: task.phase,
    outcome,
  };

  // §11.1/§11.2 — a preview performed every read above and performs no write.
  if (request.mode === "preview") return { outcome, applied: false, record };

  const event: TaskEvent = {
    task: key,
    type: TASK_MERGED_PR_RECONCILED_EVENT,
    runId: request.runId,
    message:
      outcome === "reconciled"
        ? `externally merged PR ${prUrl} reconciled: ${task.status} -> done`
        : `external merge of ${prUrl} recorded; terminal status ${task.status} preserved`,
    data: { ...record },
    createdAt: now,
  };

  // §9.4 — exactly one bounded comment, through the outbox, in the same
  // transaction as the write. No label mutation, ever. The body names the PR,
  // the previous status and phase, and the outcome, and passes through
  // `sanitizeBody` with the session redaction paths so no local path leaks —
  // exactly as `admin task cancel` / `task reconcile-closed` already do.
  let commentBody =
    outcome === "reconciled"
      ? `✅ **Task reconciled — recorded pull request merged externally.**\n\n` +
        `Pull request: ${prUrl} (#${prNumber}, provider state \`${pr.state}\`).\n` +
        `Previous status: \`${task.status}\` (phase: \`${task.phase}\`).\n\n` +
        `The task is now \`done\` and no further automation will run for it.`
      : `📌 **External merge recorded — terminal task status preserved.**\n\n` +
        `Pull request: ${prUrl} (#${prNumber}, provider state \`${pr.state}\`).\n` +
        `Status: \`${task.status}\` (phase: \`${task.phase}\`) — unchanged; the merged disposition ` +
        `was appended to the task's reconciliation history.`;
  commentBody = sanitizeBody(commentBody, sessionRedactionPaths(deps.session));
  const collector = new OutboxEffectCollector();
  await workItemOutbox(collector, deps.session).enqueue({
    idempotencyKey: makeOutboxKey(
      request.sessionId,
      request.issueNumber,
      request.runId,
      "gh:comment",
      "merged-pr-reconciliation",
    ),
    topic: "gh:comment",
    payload: {
      topic: "gh:comment",
      owner: deps.session.githubOwner,
      repo: deps.session.githubName,
      issueNumber: request.issueNumber,
      body: commentBody,
    },
    now,
  });

  // §11.4 — the CAS names everything observed during this invocation's read:
  // (status, phase, ownerRunId, revision). `ownerRunId` is set explicitly even
  // when absent so an absent claim is asserted absent, and `revision` is what
  // catches a concurrent write that moved the identity this reconciliation
  // was decided from while leaving the other three untouched.
  const expected: TaskExpected = {
    status: task.status,
    phase: task.phase,
    ownerRunId: task.ownerRunId,
    revision: task.revision,
  };
  // §8.1/§8.3 — `reconciled` sets `done` and leaves the phase unchanged;
  // `recorded-terminal` patches only the disposition history. The context
  // patch shallow-merges, so every other context field is preserved (R3), and
  // the history is append-only: the new entry lands beside the validated
  // existing entries, none of which is rewritten (§9.2.1).
  const nextHistory = [...history.entries, record];
  const patch: TaskPatch =
    outcome === "reconciled"
      ? { status: "done", context: { [MERGED_PR_RECONCILIATIONS_CONTEXT_KEY]: nextHistory }, now }
      : { context: { [MERGED_PR_RECONCILIATIONS_CONTEXT_KEY]: nextHistory }, now };

  // §8.4 — the patch, the event, and the comment effect commit in ONE
  // transaction; §8.5 — a held maintenance lock refuses the whole call.
  const committed = await deps.store.completePhaseWithEffects(
    { key, expected, patch, event },
    collector.effects,
  );
  if (!committed.ok) {
    if (committed.code === "conflict" || committed.code === "not_found") {
      // Row 22 / §11.5 — a lost CAS is stale-state: never retried here, never
      // widened, never conflated with a store refusal. The operator re-runs
      // and the fresh read routes the row through §7 again.
      return refusal(
        "stale-state",
        "the task changed between this invocation's read and the write; re-run reconciliation",
      );
    }
    // Row 23 — a store refusal that is not a lost CAS (today exactly
    // `maintenance_locked`, §8.5). The row is untouched; the operator waits
    // for maintenance to release and re-runs.
    return refusal(
      "store-refused",
      `the store refused the write (${committed.code}); nothing was changed — re-run once the cause clears`,
    );
  }
  return { outcome, applied: true, record, task: committed.value };
}

function refusal(
  refusalCode: MergedPrReconciliationRefusal,
  message: string,
  providerState?: string,
): { outcome: "refused"; refusal: MergedPrReconciliationRefusal; message: string; providerState?: string } {
  return {
    outcome: "refused",
    refusal: refusalCode,
    message,
    ...(providerState !== undefined ? { providerState } : {}),
  };
}
