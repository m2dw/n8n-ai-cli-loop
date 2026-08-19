/**
 * Helpers for enqueuing GitHub side-effect entries after a handler completes.
 *
 * Rules:
 *  - implementation success → comment with prUrl; coarse labels: none (queued for review)
 *                           → if session.labels.needsReview configured: add needsReview, remove needsImplementation
 *                           → remove agentImplementation label (session.labels.agentImplementation or "agent:claude")
 *                           → if session.labels.agentReview configured: add agentReview
 *                           → remove needsFix label (session.labels.needsFix or derived from task.context.labels)
 *  - implementation failure → comment with error
 *  - implementation blocked → comment; coarse label: readyForHuman; remove needsImplementation + agentImplementation labels
 *  - implementation tool_request → comment (requested command/reason/files/next action); coarse label: readyForHuman; remove needsImplementation + agentImplementation labels (issue #291)
 *  - review success        → comment; coarse label: readyForHuman; remove needsReview + agentReview labels
 *  - review blocked        → comment with classification reason; coarse label: readyForHuman; remove needsReview + agentReview labels
 *  - review needs_fix      → comment; if session.labels.needsReview configured: remove needsReview, remove agentReview
 *                           → add needsFix label (session.labels.needsFix or hardcoded "status:needs-fix"), add agentImplementation
 *  - any task → readyForHuman status → add readyForHuman label
 *  - any task → blocked status       → add blocked label
 */

import type { AiTask, TaskKey, TaskPhase, TaskStatus } from "./task.js";
import type { ResolvedSession, WorkItemProviderKind } from "./session.js";
import type { OutboxStore, OutboxEnqueueInput, OutboxEntry } from "./outbox.js";
import type { OutboxEffect, TaskStore } from "./task-store.js";
import type { PhaseDelayKind, PhaseHandlerResult } from "./phase-runner.js";
import type { AgentFailureKind } from "./agent-diagnostics.js";
import { makeOutboxKey } from "./outbox.js";
import { agentForPhase, readResolvedAssignment } from "./assignment.js";
import { redactCommand } from "./tool-request.js";
import { enqueueRepoHostPrComment, enqueueRepoHostPrSummary } from "./outbox-visibility.js";
import { boundedExcerpt, fencedDetailsExcerpt, sanitizeBody } from "./text-sanitize.js";
import { realpathSync } from "fs";
import { resolveWorktreeRoot } from "./worktree-paths.js";
import { renderPrSummary, PR_SUMMARY_MARKER } from "./pr-summary.js";
import {
  PUBLICATION_WITHHOLD_PHRASES,
  RESEARCH_PUBLICATION_FAILED_STATUS,
} from "./research-publication.js";
import type { PublicationWithholdReason } from "./research-publication.js";
import { renderHumanGateSummary, HUMAN_GATE_MARKER } from "./human-gate-summary.js";
import type { DisputeTransitionApplication } from "./review-dispute-transition.js";
import {
  disputeOutcomeIdempotencyKey,
  disputePublicationTarget,
  publishableDisputeOutcomes,
  renderDisputeOutcomeComment,
} from "./review-dispute-publication.js";
import {
  REFINEMENT_HANDOFF_COMMENT_UNDELIVERABLE_EVENT,
  publishableRefinementHandoffFromContext,
  refinementHandoffCommentMarker,
  refinementHandoffEffectFromKey,
  refinementHandoffIdempotencyKey,
  renderRefinementHandoffComment,
} from "./issue-refinement-publication.js";
import type { DiffClassification } from "./review-diff-context.js";
import type { IssueRequiredVerification } from "../handlers/verification.js";

/**
 * Absolute filesystem roots to redact from any published comment for a session:
 * the repo checkout, the artifact root, and — when per-issue worktrees are in use
 * — the managed worktree state root (issue #400). Passing the worktree root here
 * guarantees a local worktree path is stripped from public comments even when it
 * lives under a non-standard top-level directory the generic heuristic misses.
 */
export function sessionRedactionPaths(session: ResolvedSession): string[] {
  const paths = [session.repoRoot, session.artifactRoot];
  // `resolveWorktreeRoot` now rejects a relative root (issue #400). A relative
  // root is not an absolute on-disk path that could leak into a comment anyway,
  // so a misconfiguration here must never break comment publishing — fall back to
  // the generic absolute-path stripping in `sanitizeBody` instead of throwing.
  try {
    const worktreeRoot = resolveWorktreeRoot({ sessionRoot: session.worktrees?.root });
    paths.push(worktreeRoot);
    // git reports the symlink-resolved checkout path, so a worktree path copied
    // into a published message (e.g. `admin tool-request resolve --message`) may
    // carry the canonical root rather than the configured one. Redact that too,
    // since the generic path heuristic can miss non-standard top-level dirs.
    try {
      const canonicalRoot = realpathSync(worktreeRoot);
      if (canonicalRoot !== worktreeRoot) paths.push(canonicalRoot);
    } catch {
      // Root not yet on disk (config-only) — nothing canonical to redact.
    }
  } catch {
    // Intentionally ignored: no absolute worktree root to redact explicitly.
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Format a duration in milliseconds as a human-readable string.
 * Returns "unknown" when ms is undefined (timing unavailable).
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "unknown";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Extract numeric PR number from a GitHub pull URL, e.g. ".../pull/42" → 42. */
function extractPrNumberFromUrl(prUrl: string): number | undefined {
  // Accept both GitHub's `/pull/<n>` and Gitea's `/pulls/<n>` PR URL forms so a
  // Gitea repo-host PR comment is enqueued (and then dispatched through the Gitea
  // provider) instead of being silently dropped at enqueue time. The optional `s`
  // does not change matching for GitHub URLs.
  const m = prUrl.match(/\/pulls?\/(\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}

// ---------------------------------------------------------------------------
// Work-item provider routing
//
// Phase-completion comments and coarse label transitions are work-item side
// effects: they belong on the session's configured work-item tracker, not
// necessarily on the GitHub repo host. The enqueue blocks below were written
// against GitHub Issues and emit legacy `gh:comment` / `gh:label:*` rows. For a
// GitHub work-item session that is exactly right and stays byte-for-byte
// unchanged. For a non-GitHub provider (e.g. `gitea-issues`) those legacy rows
// would be handed a failing GitHub runner by the dispatcher and stay pending
// forever, so each is rewritten here to the provider-neutral `workitem:*` topic
// — carrying the provider kind and the work-item repo's owner/name — so it is
// dispatched through that provider instead.
// ---------------------------------------------------------------------------

/**
 * Rewrite a legacy GitHub work-item enqueue (`gh:comment` / `gh:label:add` /
 * `gh:label:remove`) to the provider-neutral `workitem:*` topic for a non-GitHub
 * work-item provider, retargeting it at the work-item repo's `owner`/`repo` and
 * tagging it with the provider `kind`. The idempotency key and `now` are
 * preserved unchanged so dedup is identical on upgrade. Any other topic (e.g. a
 * `repohost:pr-comment` row, which publishes to the repo host) passes through
 * untouched so its GitHub routing is never altered.
 */
function rewriteWorkItemEnqueue(
  input: OutboxEnqueueInput,
  provider: WorkItemProviderKind,
  owner: string,
  repo: string,
): OutboxEnqueueInput {
  const { idempotencyKey, payload, now } = input;
  switch (payload.topic) {
    case "gh:comment":
      return {
        idempotencyKey,
        topic: "workitem:comment",
        // `dedupeMarker` travels with the body it is embedded in (issue #936):
        // a rewritten row that dropped it would lose its delivery-side
        // one-comment guarantee on exactly the providers whose comment API this
        // rewrite exists to reach.
        payload: {
          topic: "workitem:comment",
          provider,
          owner,
          repo,
          issueNumber: payload.issueNumber,
          body: payload.body,
          ...(payload.dedupeMarker !== undefined ? { dedupeMarker: payload.dedupeMarker } : {}),
        },
        now,
      };
    case "gh:label:add":
    case "gh:label:remove":
      return {
        idempotencyKey,
        topic: "workitem:transition",
        payload: {
          topic: "workitem:transition",
          provider,
          owner,
          repo,
          issueNumber: payload.issueNumber,
          transition: {
            kind: payload.topic === "gh:label:add" ? "add-label" : "remove-label",
            label: payload.label,
          },
        },
        now,
      };
    default:
      return input;
  }
}

/**
 * Wrap an {@link OutboxStore} so work-item side effects enqueued through it route
 * to the session's configured work-item provider. For a GitHub work-item session
 * the original store is returned unchanged (legacy `gh:*` topics, GitHub
 * owner/repo — identical observable behavior). For a non-GitHub provider the
 * returned store rewrites each `gh:comment` / `gh:label:*` enqueue to the
 * provider-neutral `workitem:*` topic targeting the work-item repo (the Gitea
 * `owner`/`repo` for a `gitea-issues` session) so comments and label transitions
 * reach the private work item instead of stranding behind the dispatcher's
 * failing GitHub runner. `repohost:*` rows enqueued through the same store (the
 * review-phase public PR comment) pass through unchanged.
 */
export function workItemOutbox(outboxStore: OutboxStore, session: ResolvedSession): OutboxStore {
  const wi = session.workItemProvider;
  const provider = wi.provider;
  if (provider === "github-issues") return outboxStore;
  const owner = provider === "gitea-issues" && wi.gitea ? wi.gitea.owner : session.githubOwner;
  const repo = provider === "gitea-issues" && wi.gitea ? wi.gitea.repo : session.githubName;
  const enqueueEffects = outboxStore.enqueueEffects?.bind(outboxStore);
  const getScanCursorFence = outboxStore.getScanCursorFence?.bind(outboxStore);
  return {
    // Forwarded for the same reason as the lock read below (issue #818 review
    // follow-up): rewriting a row's address does not change which database it
    // lands in, so the wrapper must report the wrapped store's backend
    // identity. Reporting `undefined` would tell a caller pairing this with a
    // task store on that same file that they share nothing, and it would write
    // the effects a second time, outside the transaction that already covers
    // them.
    backendId: outboxStore.backendId,
    // Forwarded, not dropped (issue #818): this wrapper only rewrites where a
    // work-item row is addressed — a wrapped store must still report the same
    // maintenance-lock state as the store underneath it, or a caller holding
    // the wrapper would read "unlocked" for a database that is under
    // maintenance. Resolves to `false` when the wrapped store has no such lock.
    isMaintenanceLocked: () =>
      outboxStore.isMaintenanceLocked ? outboxStore.isMaintenanceLocked() : Promise.resolve(false),
    enqueue: (input) => outboxStore.enqueue(rewriteWorkItemEnqueue(input, provider, owner, repo)),
    // Rewritten and forwarded as one batch (issue #818 review follow-up), so a
    // wrapped store does not cost its caller the all-or-nothing effect-set
    // transaction underneath. Omitted entirely when the wrapped store has none,
    // which leaves the caller on the same per-effect fallback it would use
    // without this wrapper.
    ...(enqueueEffects
      ? {
          enqueueEffects: (effects: OutboxEffect[]) =>
            enqueueEffects(
              effects.map((effect) =>
                effect.kind === "enqueue"
                  ? { ...effect, input: rewriteWorkItemEnqueue(effect.input, provider, owner, repo) }
                  : effect,
              ),
            ),
        }
      : {}),
    replacePendingPrSummary: (input, key) => outboxStore.replacePendingPrSummary(input, key),
    listPending: (limit) => outboxStore.listPending(limit),
    listPendingEntries: (opts) => outboxStore.listPendingEntries(opts),
    markSent: (id, sentAt, claimToken) => outboxStore.markSent(id, sentAt, claimToken),
    markFailed: (id, error, now, claimToken) => outboxStore.markFailed(id, error, now, claimToken),
    getScanCursor: (key) => outboxStore.getScanCursor(key),
    // The fence is forwarded whole (issue #820 review follow-up): dropping it
    // here would silently turn a fenced cursor write back into the
    // unconditional upsert it replaced, so a dispatch running through this
    // wrapper could re-strand a row an operator retry just recovered. The
    // getter is forwarded only when the wrapped store has one, so a store
    // without fence support still reports "no capability" rather than a
    // fabricated generation 0 that would make every stale write look current.
    ...(getScanCursorFence ? { getScanCursorFence } : {}),
    setScanCursor: (key, id, fence) => outboxStore.setScanCursor(key, id, fence),
    getById: (id) => outboxStore.getById(id),
    listUnsent: () => outboxStore.listUnsent(),
    retryEntry: (id, now, opts) => outboxStore.retryEntry(id, now, opts),
    cancelEntry: (id, now) => outboxStore.cancelEntry(id, now),
    claimForDispatch: (id, now) => outboxStore.claimForDispatch(id, now),
    renewClaim: (id, claimedAt, now) => outboxStore.renewClaim(id, claimedAt, now),
  };
}

// ---------------------------------------------------------------------------
// Coarse label side effects based on new task status
// ---------------------------------------------------------------------------

const STATUS_LABEL: Partial<Record<TaskStatus, keyof Pick<ResolvedSession["labels"], "active" | "blocked" | "readyForHuman">>> = {
  running: "active",
  blocked: "blocked",
  ready_for_human: "readyForHuman",
};

const ALL_COARSE_LABEL_KEYS: Array<keyof Pick<ResolvedSession["labels"], "active" | "blocked" | "readyForHuman">> =
  ["active", "blocked", "readyForHuman"];

// Stack-readiness marker (issue #208, #242). The dependency resolver must not
// trust `readyForHuman` as an implementation-complete signal, because this
// codebase also applies `readyForHuman` to escalated (non-passing) reviews.
// Downstream dependents therefore need a distinct success-only signal that this
// blocker is implementation-complete and its reviewed PR head is a usable branch
// start point. This marker, applied on every passing review, provides it. Must
// match the default passed to resolveDependencyExecutionPlan() in
// src/handlers/implementation.ts.
const STACK_READY_LABEL_DEFAULT = "status:stack-ready";

export async function enqueueStatusLabelEffects(
  outboxStore: OutboxStore,
  session: ResolvedSession,
  task: AiTask,
  newStatus: TaskStatus,
  nextPhase: TaskPhase,
  runId: string,
  now: string,
  phase?: TaskPhase,
  result?: PhaseHandlerResult,
): Promise<void> {
  // Route every label transition below through the session's work-item provider.
  // No-op passthrough for a GitHub session; for a non-GitHub provider each
  // `gh:label:*` enqueue is rewritten to a `workitem:transition` row on the
  // work-item repo (see workItemOutbox). The owner/repo passed to each enqueue
  // are overridden by the wrapper for non-GitHub providers, so they remain the
  // GitHub repo here only for the unchanged GitHub path.
  outboxStore = workItemOutbox(outboxStore, session);
  const owner = session.githubOwner;
  const repo = session.githubName;

  const labelKey = STATUS_LABEL[newStatus];
  if (labelKey) {
    const addLabel = session.labels[labelKey];

    // Remove the other two coarse labels (ignore if absent — dispatcher treats 404 as ok)
    for (const key of ALL_COARSE_LABEL_KEYS) {
      if (key === labelKey) continue;
      const label = session.labels[key];
      if (!label) continue;
      await outboxStore.enqueue({
        idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", label),
        topic: "gh:label:remove",
        payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label },
        now,
      });
    }

    // Add the target label
    await outboxStore.enqueue({
      idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:add", addLabel),
      topic: "gh:label:add",
      payload: { topic: "gh:label:add", owner, repo, issueNumber: task.issueNumber, label: addLabel },
      now,
    });
  }

  // Review success → tag the issue with the stack-readiness marker (issue #208).
  // This is the success-specific signal the dependency resolver keys on to decide
  // a blocker is a usable stacking base. It is applied on EVERY passing review,
  // not only a stacked one: a non-stacked blocker that passes review is just as
  // usable a base as a stacked one, and — crucially — the resolver must NOT trust
  // the readyForHuman label for this, because readyForHuman is also applied when a
  // review is ESCALATED to a human (loop-cap, ambiguous output, unconfirmable
  // stacked base) without passing. Keying stacking on readyForHuman would let a
  // dependent stack on a blocker whose review failed; keying it on this
  // success-only marker excludes those escalations (issue #208 review follow-up).
  const isReviewSuccess = phase === "review" && result?.result === "success";
  const stackReadyLabel = (session.labels["stackReady"] as string | undefined) ?? STACK_READY_LABEL_DEFAULT;
  if (isReviewSuccess) {
    await outboxStore.enqueue({
      idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:add", stackReadyLabel),
      topic: "gh:label:add",
      payload: { topic: "gh:label:add", owner, repo, issueNumber: task.issueNumber, label: stackReadyLabel },
      now,
    });
  } else if (phase === "review") {
    // A review run that does NOT pass (needs_fix / conflict / blocked escalation)
    // means this PR is no longer a usable stacking base, so clear any stale
    // stack-ready marker left by a previous passing review — the PR is no longer
    // implementation-complete. This is the path that excludes review escalations:
    // a blocked/escalated review carries readyForHuman (for human attention) but
    // must never look stack-ready to the resolver. Downstream intake must not keep
    // treating this blocker as a usable stacking base and stack new dependents on
    // it (issue #208 review follow-up). Removal of an absent label is a no-op for
    // the dispatcher (404 treated as ok).
    await outboxStore.enqueue({
      idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", stackReadyLabel),
      topic: "gh:label:remove",
      payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label: stackReadyLabel },
      now,
    });

    // A review that requeues the task for more work (needs_fix → queued
    // implementation, conflict → queued conflict-resolution) maps to a `queued`
    // status that has no coarse-label entry, so the coarse-label block above is
    // skipped and a `readyForHuman` marker left by a *previous* passing review is
    // never cleared. The dependency resolver treats `readyForHuman` as
    // implementation-complete (src/handlers/dependency-plan.ts), so a downstream
    // dependent could still stack on a blocker PR that now needs fixes. Clear the
    // ready-for-human marker too whenever this review is sending the PR back for
    // more work (issue #208 review follow-up). We must NOT clear it when the
    // review itself escalates to a human (newStatus === "ready_for_human"), since
    // the coarse-label block above is intentionally adding it there.
    const readyForHumanLabel = session.labels["readyForHuman"] as string | undefined;
    if (readyForHumanLabel && newStatus !== "ready_for_human") {
      await outboxStore.enqueue({
        idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", readyForHumanLabel),
        topic: "gh:label:remove",
        payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label: readyForHumanLabel },
        now,
      });
    }
  } else if (phase === "implementation" && result?.result === "success") {
    // A fresh implementation/fix run pushes new commits onto the PR head that
    // have NOT passed review, so this PR is no longer a usable stacking base
    // until it is reviewed again. Clear any stack-ready marker left by a prior
    // passing review. The review-only cleanup path above is never reached when
    // an already-`status:stack-ready` issue is requeued straight into
    // implementation/fix (e.g. a maintainer adds `status:needs-fix` after
    // requesting changes), so without this the marker would remain stale and the
    // dependency resolver would keep treating the blocker as stack-ready while
    // its latest commits sit unreviewed — letting downstream dependents stack on
    // unreviewed changes (issue #208 review follow-up). Removal of an absent
    // label is a no-op for the dispatcher (404 treated as ok).
    await outboxStore.enqueue({
      idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", stackReadyLabel),
      topic: "gh:label:remove",
      payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label: stackReadyLabel },
      now,
    });
  }

  // Remove queue labels on terminal outcomes so the issue is no longer treated
  // as queued by label-driven scans.  Review-lane labels are cleared for all
  // ready_for_human transitions; implementation-lane labels are also cleared
  // when the implementation phase ends in a blocked (escalated) result so that
  // the issue does not linger in the implementation intake queue.
  //
  // A dependency-started PR that passes review is no longer held as `blocked`:
  // it targets the session base branch and follows the normal ready_for_human
  // handoff (issue #242), so the review-lane cleanup below is reached via the
  // ready_for_human branch like any other passing review.
  if (newStatus === "ready_for_human") {
    const needsReview = session.labels["needsReview"] as string | undefined;
    const sessionAgentReview = session.labels["agentReview"] as string | undefined;
    const resolvedReviewAgentId = agentForPhase(task, session, "review");
    // Use the assignment-aware resolved agent id first (covers assignment-profile
    // routing, task.reviewAgent, and session defaults), falling back to the raw
    // session label only when no agent is resolvable via the profile chain.
    const agentReview: string | undefined = resolvedReviewAgentId ? `agent:${resolvedReviewAgentId}` : sessionAgentReview;
    const reviewAgentFallbackLabel: string = resolvedReviewAgentId ? `agent:${resolvedReviewAgentId}` : "agent:codex";
    // Remove the review status label as the review exits the queue. Under the
    // minimal label config the implementation→review requeue added the default
    // `status:needs-review` (see the queued→review block) even though
    // `session.labels.needsReview` is unset, so a literal-only removal would leave
    // the human-ready issue still carrying `status:needs-review`. Combined with any
    // lingering agent label, a later label-driven intake/recovery scan would treat
    // the issue as queued for review again. Fall back to the same default when the
    // review phase hands off so the status label is cleared regardless of session
    // config (issue #264 review follow-up). Mirrors the implementation-lane default
    // cleanup below. Removal of an absent label is a no-op for the dispatcher.
    const needsReviewLabelToRemove: string | undefined =
      phase === "review" ? (needsReview ?? "status:needs-review") : needsReview;
    if (needsReviewLabelToRemove) {
      await outboxStore.enqueue({
        idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", needsReviewLabelToRemove),
        topic: "gh:label:remove",
        payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label: needsReviewLabelToRemove },
        now,
      });
    }
    if (agentReview || needsReview) {
      const reviewAgentLabel: string = agentReview ?? reviewAgentFallbackLabel;
      await outboxStore.enqueue({
        idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", reviewAgentLabel),
        topic: "gh:label:remove",
        payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label: reviewAgentLabel },
        now,
      });
    }

    // Clear implementation-lane labels on the ready_for_human path so the issue no
    // longer matches the implementation intake rule. Two cases reach here:
    //   1. A blocked (escalated) implementation phase.
    //   2. A review that hands the PR to a human (pass or escalation). In the
    //      lane-swap case — a Codex implementation routed to Gemini review under a
    //      minimal/assignment label config — the issue still carries the stale
    //      implementation `agent:codex` label and `status:needs-implementation`
    //      that were added only so the review agent wins intake. The review-lane
    //      cleanup above removes the resolved *review* agent label (e.g.
    //      agent:gemini), but without this the stale implementation labels survive a
    //      passing review; since labelsToPhase() keys on an agent:* label, a
    //      lingering agent:codex paired with status:needs-review/-implementation
    //      lets later scans reclassify the already-approved issue back into Codex
    //      review/implementation instead of a clean human handoff (issue #264).
    // The implementation agent label is resolved via agentForPhase (mirroring the
    // review block above) so the *actual* implementation agent is removed —
    // agent:codex in the lane swap, not just the session-default agentImplementation
    // label. For the review lane-swap, the default status:needs-implementation is
    // cleared even under the minimal config (where the session omits the key).
    if (
      phase === "review" ||
      (phase === "implementation" &&
        (result?.result === "blocked" || result?.result === "tool_request"))
    ) {
      const sessionNeedsImplementation = session.labels["needsImplementation"] as string | undefined;
      const sessionAgentImplementation = session.labels["agentImplementation"] as string | undefined;
      const resolvedImplAgentId = agentForPhase(task, session, "implementation");
      // Fall back to the default status:needs-implementation when the session omits
      // the key for both the review lane-swap (above) and the implementation Tool
      // Request handoff: the implementation queue added the default label under a
      // minimal config (the registry only requires active/blocked/readyForHuman), so
      // a literal-only removal would leave the ready-for-human issue still carrying
      // status:needs-implementation and advertising runnable implementation work
      // (issue #291 review follow-up).
      const needsImplementation: string | undefined =
        phase === "review" || result?.result === "tool_request"
          ? (sessionNeedsImplementation ?? "status:needs-implementation")
          : sessionNeedsImplementation;
      const agentImplementation: string | undefined = resolvedImplAgentId
        ? `agent:${resolvedImplAgentId}`
        : sessionAgentImplementation;
      const implAgentFallbackLabel: string = resolvedImplAgentId ? `agent:${resolvedImplAgentId}` : "agent:claude";
      if (needsImplementation) {
        await outboxStore.enqueue({
          idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", needsImplementation),
          topic: "gh:label:remove",
          payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label: needsImplementation },
          now,
        });
      }
      if (agentImplementation || needsImplementation) {
        const implAgentLabel: string = agentImplementation ?? (task.implementationAgent ? `agent:${task.implementationAgent}` : implAgentFallbackLabel);
        await outboxStore.enqueue({
          idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", implAgentLabel),
          topic: "gh:label:remove",
          payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label: implAgentLabel },
          now,
        });
      }
      // A Tool Request emitted while addressing review feedback leaves the issue
      // in the fix lane: it carries the needs-fix status, not needs-implementation.
      // The implementation-status removal above is then a no-op, so also remove the
      // configured/default needsFix label for the tool_request handoff. Otherwise the
      // ready-for-human issue keeps a fix-queue status that can later pair with an
      // agent label and advertise runnable fix work (issue #291 review follow-up).
      // Resolution mirrors the implementation→review needs-fix cleanup below.
      if (result?.result === "tool_request") {
        const needsFix: string | undefined = (() => {
          const configured = session.labels["needsFix"] as string | undefined;
          if (configured) return configured;
          const ctxLabels = task.context["labels"];
          if (Array.isArray(ctxLabels)) {
            const found = (ctxLabels as unknown[]).find(
              (l): l is string => typeof l === "string" && l.includes("needs-fix"),
            );
            if (found) return found;
          }
          return "status:needs-fix";
        })();
        if (needsFix) {
          await outboxStore.enqueue({
            idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", needsFix),
            topic: "gh:label:remove",
            payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label: needsFix },
            now,
          });
        }
      }
    }

    // When conflict resolution escalates a non-auto-resolvable conflict (binary
    // or modify/delete) to a human, clear the conflict-resolution lane labels so
    // the issue is no longer advertised as pending automated conflict resolution
    // while it actually awaits human judgement.
    //
    // This whole block is gated by `newStatus === "ready_for_human"` (the
    // enclosing `if` above), so it never runs for a report-only-mode admission
    // rejection (issue #532 review): `nextPhaseAfter` holds that case at
    // `blocked`, not `ready_for_human` (transitions.ts), specifically so these
    // queue labels stay in place for intake to reactivate later. Do not widen
    // this condition to also match `newStatus === "blocked"` — that would strip
    // the labels the reactivation path depends on. See the
    // "conflict_resolution report-only admission hold" tests in
    // phase-runner-outbox.test.js for the pinned regression coverage.
    if (phase === "conflict_resolution" && result?.result === "blocked") {
      const needsConflictResolution =
        (session.labels["needsConflictResolution"] as string | undefined) ?? "status:needs-conflict-resolution";
      const conflictInProgress =
        (session.labels["conflictResolutionInProgress"] as string | undefined) ?? "status:conflict-resolution-in-progress";
      for (const label of [needsConflictResolution, conflictInProgress]) {
        await outboxStore.enqueue({
          idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", label),
          topic: "gh:label:remove",
          payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label },
          now,
        });
      }
      // When the blocked result is a repeated semantic-conflict escalation, also add
      // the conflict-resolution-failed label so the issue appears in the failed lane.
      if (result.context?.["conflictResolutionVerificationCapReached"] === true) {
        const conflictResolutionFailed =
          (session.labels["conflictResolutionFailed"] as string | undefined) ?? "status:conflict-resolution-failed";
        await outboxStore.enqueue({
          idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:add", conflictResolutionFailed),
          topic: "gh:label:add",
          payload: { topic: "gh:label:add", owner, repo, issueNumber: task.issueNumber, label: conflictResolutionFailed },
          now,
        });
      }
    }

    // Research is terminal in the transition model — nextPhaseAfter("research", …)
    // hands off to a human (ready_for_human); it never auto-advances to another
    // phase. Clear the research-lane labels so the stale agent:<researchAgent> +
    // status:research-needed pair does not linger on the issue after the human
    // takes over. If the issue is later queued for a Codex review, a lingering
    // agent:gemini research label would otherwise make labelsToPhase() route the
    // review to Gemini — the agent:codex review rule is suppressed whenever
    // agent:gemini is present (the review lane-swap guard in github-intake.ts) —
    // persisting the wrong reviewer (issue #264 review follow-up). The research
    // agent label is resolved via agentForPhase so the *actual* research agent is
    // removed; the status falls back to the default when the session omits the key.
    // Removal of an absent label is a no-op for the dispatcher (404 treated as ok).
    if (phase === "research") {
      const resolvedResearchAgentId = agentForPhase(task, session, "research");
      const researchAgentLabel: string | undefined = resolvedResearchAgentId
        ? `agent:${resolvedResearchAgentId}`
        : (session.labels["agentResearch"] as string | undefined);
      const needsResearch: string =
        (session.labels["needsResearch"] as string | undefined) ?? "status:research-needed";
      const researchLabelsToRemove: string[] = [
        needsResearch,
        ...(researchAgentLabel ? [researchAgentLabel] : []),
      ];
      for (const label of researchLabelsToRemove) {
        await outboxStore.enqueue({
          idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", label),
          topic: "gh:label:remove",
          payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label },
          now,
        });
      }
    }


  }

  // When a conflict-resolution run fails (agent failure, verification failure,
  // push failure, or any blocked/failed path that aborted after merge state),
  // the DB task is marked `failed`. Clear the conflict-resolution lane labels and
  // flag the failure so intake/public state no longer advertises a runnable
  // resolver lane (status:needs-conflict-resolution / -in-progress) for an issue
  // whose automated resolution actually failed.
  if (newStatus === "failed" && phase === "conflict_resolution") {
    const needsConflictResolution =
      (session.labels["needsConflictResolution"] as string | undefined) ?? "status:needs-conflict-resolution";
    const conflictInProgress =
      (session.labels["conflictResolutionInProgress"] as string | undefined) ?? "status:conflict-resolution-in-progress";
    for (const label of [needsConflictResolution, conflictInProgress]) {
      await outboxStore.enqueue({
        idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", label),
        topic: "gh:label:remove",
        payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label },
        now,
      });
    }
    const conflictResolutionFailed =
      (session.labels["conflictResolutionFailed"] as string | undefined) ?? "status:conflict-resolution-failed";
    await outboxStore.enqueue({
      idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:add", conflictResolutionFailed),
      topic: "gh:label:add",
      payload: { topic: "gh:label:add", owner, repo, issueNumber: task.issueNumber, label: conflictResolutionFailed },
      now,
    });
  }

  // When a content-research run fails, remove the content-research lane labels
  // so the issue is no longer advertised as a runnable content-research task.
  // Failure is a terminal outcome: the task transitions to `failed` and will not
  // automatically retry. Without this cleanup, the stale agent:gemini +
  // status:content-needed pair would cause intake scans to re-enqueue the same
  // task. A failing content-research result has already written diagnostics to
  // the local artifact directory; nothing is published to GitHub beyond a fixed
  // outcome status comment (docs/content-research-mvp-contract.md §Public-Status Contract).
  if (newStatus === "failed" && phase === "content_research") {
    const resolvedContentResearchAgentId = agentForPhase(task, session, "research");
    const contentResearchAgentLabel: string | undefined = resolvedContentResearchAgentId
      ? `agent:${resolvedContentResearchAgentId}`
      : (session.labels["agentContentResearch"] as string | undefined);
    const needsContentResearch: string =
      (session.labels["needsContentResearch"] as string | undefined) ?? "status:content-needed";
    const contentResearchLabelsToRemove: string[] = [
      needsContentResearch,
      ...(contentResearchAgentLabel ? [contentResearchAgentLabel] : []),
    ];
    for (const label of contentResearchLabelsToRemove) {
      await outboxStore.enqueue({
        idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", label),
        topic: "gh:label:remove",
        payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label },
        now,
      });
    }
  }

  // Sync review-queue labels when task is re-queued for a new phase.
  // Only emitted when the optional label keys are present in the session config.
  if (newStatus === "queued") {
    const needsReview = session.labels["needsReview"] as string | undefined;
    const needsImplementation = session.labels["needsImplementation"] as string | undefined;
    const sessionAgentReview = session.labels["agentReview"] as string | undefined;
    const resolvedReviewAgentId = agentForPhase(task, session, "review");
    const reviewAgentFallbackLabel: string = resolvedReviewAgentId ? `agent:${resolvedReviewAgentId}` : "agent:codex";
    // Prefer a task-level agent (persisted assignment or direct task field) over the
    // static session label. Session defaults are excluded here — they inform
    // reviewAgentFallbackLabel but must not override an explicitly configured label.
    const taskAssignedReviewAgent = readResolvedAssignment(task)?.reviewAgent ?? task.reviewAgent;
    const agentReview: string | undefined = taskAssignedReviewAgent
      ? `agent:${taskAssignedReviewAgent}`
      : sessionAgentReview;
    const sessionAgentImplementation = session.labels["agentImplementation"] as string | undefined;
    // Prefer a task-level agent (persisted assignment or direct task field) over the
    // static session label, mirroring agentReview above. Under the minimal label
    // config a Codex implementation → Gemini review task carries no
    // agentImplementation session key, so the fix-requeue add and the
    // review→implementation removal below would otherwise fall back to agent:claude
    // and advertise/persist the wrong worker for label-driven recovery/intake even
    // though the DB task continues with Codex (issue #264 review follow-up).
    const taskAssignedImplementationAgent =
      readResolvedAssignment(task)?.implementationAgent ?? task.implementationAgent;
    const agentImplementation: string | undefined = taskAssignedImplementationAgent
      ? `agent:${taskAssignedImplementationAgent}`
      : sessionAgentImplementation;

    if (nextPhase === "review") {
      // Implementation succeeded → queued for review: swap queue labels
      if (needsImplementation) {
        await outboxStore.enqueue({
          idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", needsImplementation),
          topic: "gh:label:remove",
          payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label: needsImplementation },
          now,
        });
      }
      // Also remove the needs-fix label so intake won't re-select the implementation lane.
      // Prefer the configured session key; fall back to scanning context labels from intake.
      const needsFixLabel: string | undefined = (() => {
        const configured = session.labels["needsFix"] as string | undefined;
        if (configured) return configured;
        const ctxLabels = task.context["labels"];
        if (Array.isArray(ctxLabels)) {
          const found = (ctxLabels as unknown[]).find(
            (l): l is string => typeof l === "string" && l.includes("needs-fix"),
          );
          if (found) return found;
        }
        // Fall back to the same default used when auto-adding the label on requeue.
        return "status:needs-fix";
      })();
      if (needsFixLabel) {
        await outboxStore.enqueue({
          idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", needsFixLabel),
          topic: "gh:label:remove",
          payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label: needsFixLabel },
          now,
        });
      }
      // Swap agent labels so github-intake recognises the issue as a review queue entry.
      // Always remove the implementation agent label so a stale agent:<impl> never
      // lingers after moving to review. Remove the label of the agent that actually
      // ran implementation, which is the persisted-assignment owner
      // (`agentImplementation` already prefers context.assignment.implementationAgent
      // over the legacy task.implementationAgent column). Using the legacy column here
      // would remove the wrong label when assignment and column disagree — e.g. an
      // assignment of implementationAgent:"gemini" with a column of "codex" would drop
      // agent:codex and leave a stale agent:gemini beside the queued review labels,
      // misleading labelsToPhase() into selecting the wrong reviewer (issue #292).
      const implAgentLabelToRemove: string = agentImplementation ?? "agent:claude";
      await outboxStore.enqueue({
        idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", implAgentLabelToRemove),
        topic: "gh:label:remove",
        payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label: implAgentLabelToRemove },
        now,
      });
      // Add the review-queue labels as a pair. The agent label must never be
      // emitted without a review status label: a persisted context.assignment
      // always carries a reviewAgent, so `agentReview` is truthy for every
      // intake-created task even under the minimal label config. The previous code
      // added the status label only when the needsReview session key was set but
      // added the agent label whenever `agentReview` was truthy — so under the
      // minimal config it left the issue advertising status:needs-implementation +
      // agent:<reviewAgent> with no review status label. The next intake scan —
      // labelsToPhase() checks the review rule before the implementation rule —
      // would then re-enqueue implementation instead of review (or leave a Gemini
      // review task unadvertised). Emitting the default review status label
      // alongside the agent label keeps review winning regardless of any
      // unconfigured status:needs-implementation that lingers on the issue. The
      // gate stays `needsReview || agentReview` so a bare session with no review
      // agent (e.g. research-only flows) still emits no review-queue labels.
      if (needsReview || agentReview) {
        const reviewLabelToAdd: string = needsReview ?? "status:needs-review";
        const reviewAgentLabelToAdd: string = agentReview ?? reviewAgentFallbackLabel;
        for (const label of [reviewLabelToAdd, reviewAgentLabelToAdd]) {
          await outboxStore.enqueue({
            idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:add", label),
            topic: "gh:label:add",
            payload: { topic: "gh:label:add", owner, repo, issueNumber: task.issueNumber, label },
            now,
          });
        }
      }
      // NOTE (issue #292): the implementation-agent label is intentionally NOT
      // re-added here. `context.assignment.implementationAgent` is the source of
      // truth for implementation ownership, so the review queue must not use an
      // `agent:*` label as an assignment-persistence mechanism. The `needs_fix`
      // requeue below restores the implementation agent from the persisted
      // assignment, not from a lingering label.
      // When this re-queue follows a conflict-resolution success, swap the
      // conflict-resolution lane labels for the review lane labels so
      // intake/public state advertises the newly queued review instead of a
      // pending conflict resolution.
      if (phase === "conflict_resolution") {
        // Guarantee the default review-queue labels are present. The shared
        // review-queue block above only adds them when needsReview is configured
        // or a review agent is resolved (session key or persisted assignment);
        // a conflict-resolution task with neither would otherwise add nothing
        // under the minimal session config. The review→conflict path falls back to
        // the same defaults when removing them, so without this the issue would be
        // left with no GitHub lane label while a review task is queued. Enqueuing
        // is idempotent with the shared block adds.
        const reviewLabelToAdd: string = needsReview ?? "status:needs-review";
        const reviewAgentLabelToAdd: string = agentReview ?? reviewAgentFallbackLabel;
        for (const label of [reviewLabelToAdd, reviewAgentLabelToAdd]) {
          await outboxStore.enqueue({
            idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:add", label),
            topic: "gh:label:add",
            payload: { topic: "gh:label:add", owner, repo, issueNumber: task.issueNumber, label },
            now,
          });
        }
        const needsConflictResolution =
          (session.labels["needsConflictResolution"] as string | undefined) ?? "status:needs-conflict-resolution";
        const conflictInProgress =
          (session.labels["conflictResolutionInProgress"] as string | undefined) ?? "status:conflict-resolution-in-progress";
        for (const label of [needsConflictResolution, conflictInProgress]) {
          await outboxStore.enqueue({
            idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", label),
            topic: "gh:label:remove",
            payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label },
            now,
          });
        }
      }
    } else if (nextPhase === "conflict_resolution") {
      // Review detected a real merge conflict → queued for the conflict-resolution
      // lane. Swap the review-queue labels for the conflict-resolution intake
      // label so public/intake state matches the new in-process phase.
      //
      // Always remove the review-queue labels, falling back to the default
      // review lane labels (status:needs-review / agent:codex) when the optional
      // needsReview/agentReview session keys are absent. A review task can enter
      // via the default GitHub labels even under the minimal session config; if
      // we skipped removal there, the issue would keep both lane label sets and
      // labelsToPhase() — which checks the review rule before the conflict-
      // resolution rule — would re-select review on the next intake scan instead
      // of the resolver. Mirrors the unconditional implementation-agent removal
      // in the review→implementation path above.
      const needsReviewLabelToRemove: string = needsReview ?? "status:needs-review";
      await outboxStore.enqueue({
        idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", needsReviewLabelToRemove),
        topic: "gh:label:remove",
        payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label: needsReviewLabelToRemove },
        now,
      });
      const reviewAgentLabelToRemove: string = agentReview ?? reviewAgentFallbackLabel;
      await outboxStore.enqueue({
        idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", reviewAgentLabelToRemove),
        topic: "gh:label:remove",
        payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label: reviewAgentLabelToRemove },
        now,
      });
      const needsConflictResolution: string =
        (session.labels["needsConflictResolution"] as string | undefined) ?? "status:needs-conflict-resolution";
      await outboxStore.enqueue({
        idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:add", needsConflictResolution),
        topic: "gh:label:add",
        payload: { topic: "gh:label:add", owner, repo, issueNumber: task.issueNumber, label: needsConflictResolution },
        now,
      });
    } else if (nextPhase === "implementation" && phase !== "implementation") {
      // Review needs_fix → queued for implementation: swap queue labels.
      //
      // Excluded: the implementation lane requeueing ITSELF after a
      // verification failure the agent may keep fixing (issue #934). That task
      // never left the lane, so its labels already say what they need to say —
      // adding `status:needs-fix` would advertise a fix lane for an issue that
      // may have no PR at all, and re-enqueue the same label writes on every
      // automatic retry, which is GitHub churn for a state change no operator
      // needs to see.
      //
      // Always remove the review-queue labels, falling back to the default
      // review lane labels (status:needs-review / agent:codex) when the optional
      // needsReview/agentReview session keys are absent. The shared review-queue
      // block adds the fallback status:needs-review under the minimal session
      // config, so a conditional removal here would leave the issue carrying both
      // status:needs-review and status:needs-fix after the review agent label is
      // removed. Mirrors the conflict-resolution and ready-for-human cleanup
      // paths so GitHub state reflects the implementation queue.
      const needsReviewLabelToRemove: string = needsReview ?? "status:needs-review";
      await outboxStore.enqueue({
        idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", needsReviewLabelToRemove),
        topic: "gh:label:remove",
        payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label: needsReviewLabelToRemove },
        now,
      });
      const reviewAgentLabelToRemove: string = agentReview ?? reviewAgentFallbackLabel;
      await outboxStore.enqueue({
        idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", reviewAgentLabelToRemove),
        topic: "gh:label:remove",
        payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label: reviewAgentLabelToRemove },
        now,
      });
      const needsFixLabel: string =
        (session.labels["needsFix"] as string | undefined) ?? "status:needs-fix";
      await outboxStore.enqueue({
        idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:add", needsFixLabel),
        topic: "gh:label:add",
        payload: { topic: "gh:label:add", owner, repo, issueNumber: task.issueNumber, label: needsFixLabel },
        now,
      });
      const resolvedImplAgent = readResolvedAssignment(task)?.implementationAgent ?? task.implementationAgent;
      const implAgentLabel: string =
        (resolvedImplAgent ? `agent:${resolvedImplAgent}` : null) ?? agentImplementation ?? "agent:claude";
      await outboxStore.enqueue({
        idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:add", implAgentLabel),
        topic: "gh:label:add",
        payload: { topic: "gh:label:add", owner, repo, issueNumber: task.issueNumber, label: implAgentLabel },
        now,
      });
    } else if (nextPhase === "content_draft") {
      // content_research succeeded → queued for content_draft: clear the
      // content-research lane labels so intake scans do not re-route the issue
      // back to content_research while the draft phase is running (same risk as
      // the research lane, issue #264). Removal of an absent label is a no-op
      // for the dispatcher (404 treated as ok).
      const resolvedContentResearchAgentId = agentForPhase(task, session, "research");
      const contentResearchAgentLabel: string | undefined = resolvedContentResearchAgentId
        ? `agent:${resolvedContentResearchAgentId}`
        : (session.labels["agentContentResearch"] as string | undefined);
      const needsContentResearch: string =
        (session.labels["needsContentResearch"] as string | undefined) ?? "status:content-needed";
      const contentResearchLabelsToRemove: string[] = [
        needsContentResearch,
        ...(contentResearchAgentLabel ? [contentResearchAgentLabel] : []),
      ];
      for (const label of contentResearchLabelsToRemove) {
        await outboxStore.enqueue({
          idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:label:remove", label),
          topic: "gh:label:remove",
          payload: { topic: "gh:label:remove", owner, repo, issueNumber: task.issueNumber, label },
          now,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Run metadata block
// ---------------------------------------------------------------------------

function agentDisplayName(agentId: string): string {
  if (agentId === "claude") return "Claude";
  if (agentId === "codex") return "Codex";
  if (agentId === "gemini" || agentId === "agy") return "Gemini";
  return agentId;
}

function agentCompany(agentId: string): string {
  if (agentId === "claude") return "Anthropic";
  if (agentId === "codex") return "OpenAI";
  if (agentId === "gemini" || agentId === "agy") return "Google";
  return "unknown";
}

/**
 * Build a compact `<details>` block from the resolved agent profile so
 * operators can audit provider, model, and effort from the GitHub timeline
 * without opening local artifacts. Returns an empty string when no profile
 * is available so callers can unconditionally concatenate it.
 */
function buildRunMetadataBlock(
  phase: TaskPhase,
  runId: string,
  resolvedProfile: Record<string, unknown> | undefined,
  durationMs?: number,
): string {
  if (!resolvedProfile) return "";

  const agentId = typeof resolvedProfile.agentId === "string" ? resolvedProfile.agentId : "unknown";
  const modelSource = typeof resolvedProfile.modelSource === "string" ? resolvedProfile.modelSource : undefined;
  const model = typeof resolvedProfile.model === "string" ? resolvedProfile.model : undefined;
  const effort = typeof resolvedProfile.effort === "string" ? resolvedProfile.effort : undefined;
  const effortSource = typeof resolvedProfile.effortSource === "string" ? resolvedProfile.effortSource : undefined;
  // Review profiles carry reviewStrength/reviewStrengthSource rather than effort/effortSource.
  const reviewStrength = typeof resolvedProfile.reviewStrength === "string" ? resolvedProfile.reviewStrength : undefined;
  const reviewStrengthSource = typeof resolvedProfile.reviewStrengthSource === "string" ? resolvedProfile.reviewStrengthSource : undefined;

  const modelDisplay = (modelSource === "cli-default" || model === "cli-default") ? "CLI default"
    : model ?? "unknown";
  // Only show model source when it carries actionable information (env override or label pick).
  const showModelSource = modelSource !== undefined && modelSource !== "cli-default" && modelSource !== "default";

  const displayEffort = effort ?? reviewStrength;
  const displayEffortSource = effortSource ?? reviewStrengthSource;

  const lines: string[] = [
    `<details>`,
    `<summary>Run metadata</summary>`,
    ``,
    `- Phase: ${phase}`,
    `- Agent: ${agentDisplayName(agentId)}`,
    `- Company: ${agentCompany(agentId)}`,
    `- Model: ${modelDisplay}`,
  ];
  if (showModelSource) {
    lines.push(`- Model source: ${modelSource}`);
  }
  if (displayEffort !== undefined) {
    lines.push(`- Effort: ${displayEffort}`);
    if (displayEffortSource) {
      lines.push(`- Effort source: ${displayEffortSource}`);
    }
  } else {
    lines.push(`- Effort: not exposed`);
  }
  lines.push(`- Run ID: ${runId}`);
  lines.push(`- Duration: ${formatDuration(durationMs)}`);
  lines.push(``, `</details>`);

  return "\n\n" + lines.join("\n");
}

// ---------------------------------------------------------------------------
// Quota / rate-limit delay comment (issue #352)
//
// When a phase is delayed because the agent reported a retryable quota/rate-limit
// condition (handler returns `delayed` → phase.delayed / notBefore), publish a
// concise GitHub-facing status comment so operators can see *why* the issue went
// quiet without inspecting the local DB/events. The comment is deliberately
// minimal and public-safe: it names only the phase, the agent, and an absolute
// retry timestamp — never the raw agent output, the matched quota signal, local
// paths, or any artifact reference.
// ---------------------------------------------------------------------------

/**
 * Map a task phase to the agent-assignment slot used to resolve its agent.
 *
 * `content_draft` and `content_review` are mapped to the `research` slot, not
 * `implementation`/`review`, because that is the slot their handlers actually
 * resolve through (see `agentForPhase(task, session, "research")` in
 * content-draft.ts and content-review.ts) — the content workflow has no
 * dedicated draft/review agent config and reuses the single research-agent
 * assignment for every content phase.
 */
function phaseToAgentKind(phase: TaskPhase): Parameters<typeof agentForPhase>[2] {
  switch (phase) {
    case "review":
      return "review";
    case "conflict_resolution":
      return "conflictResolution";
    case "research":
    case "content_research":
    case "content_draft":
    case "content_review":
      return "research";
    case "implementation":
    case "planner":
    default:
      return "implementation";
  }
}

/**
 * Format a `notBefore` ISO instant as an unambiguous absolute timestamp for a
 * public comment. The stored value is always a UTC ISO-8601 string (it comes
 * from leaseExpiry()), so we surface it verbatim with an explicit `UTC` suffix
 * rather than a relative ("in 2 hours") phrasing that drifts as the comment ages.
 */
function formatRetryTimestamp(notBefore: string): string {
  const parsed = new Date(notBefore);
  if (Number.isNaN(parsed.getTime())) return notBefore;
  // "2026-06-07T12:00:00.000Z" → "2026-06-07 12:00:00 UTC"
  const iso = parsed.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/**
 * Category-appropriate title/reason copy for the quota-delay comment (issue
 * #672). `category` is undefined for callers that have not classified a
 * normalized category (or that pre-date issue #671) — that case keeps the
 * original generic "quota/rate-limit" wording. A `provider_capacity` failure
 * is deliberately never worded as the caller having exhausted a usage quota.
 */
function quotaDelayCommentCopy(category: AgentFailureKind | undefined): { title: string; reason: string } {
  switch (category) {
    case "usage_quota":
      return { title: "Agent usage quota delay", reason: "reported it has exhausted its usage quota" };
    case "rate_limit":
      return { title: "Agent rate-limit delay", reason: "reported a rate-limit condition" };
    case "provider_capacity":
      return { title: "Provider capacity delay", reason: "reported the upstream provider is at capacity" };
    default:
      return { title: "Agent quota/rate-limit delay", reason: "reported a retryable quota/rate-limit condition" };
  }
}

/**
 * The delayed run's title and explanatory sentence.
 *
 * `transient_verification` (issue #897) is NOT an agent failure: the agent
 * never ran. Wording it with the quota copy would tell an operator that the
 * agent reported a quota condition it never reported — the same class of
 * misattribution #897 exists to remove, only this time in public.
 */
function delayCommentCopy(
  kind: PhaseDelayKind | undefined,
  category: AgentFailureKind | undefined,
  agentName: string,
  phase: TaskPhase,
): { title: string; sentence: string } {
  if (kind === "transient_verification") {
    return {
      title: "Transient verification delay",
      sentence:
        `The workflow delayed the next \`${phase}\` attempt because a verification command failed on an `
        + `indeterminate CLI availability probe — a timeout or a refused process spawn on the runner host. `
        + `That is a condition of the machine, not of this change, so no fix has been requested.`,
    };
  }
  const { title, reason } = quotaDelayCommentCopy(category);
  return { title, sentence: `The workflow delayed the next \`${phase}\` attempt because ${agentName} ${reason}.` };
}

export async function enqueueQuotaDelayCommentEffect(
  outboxStore: OutboxStore,
  session: ResolvedSession,
  task: AiTask,
  phase: TaskPhase,
  notBefore: string,
  now: string,
  category?: AgentFailureKind,
  kind?: PhaseDelayKind,
): Promise<void> {
  // Route this quota-delay status comment through the session's work-item
  // provider. No-op passthrough for a GitHub session; for a non-GitHub provider
  // the `gh:comment` enqueue is rewritten to a `workitem:comment` row on the
  // work-item repo (see workItemOutbox) so it reaches the private work item
  // instead of stranding behind the dispatcher's failing GitHub runner.
  outboxStore = workItemOutbox(outboxStore, session);
  const owner = session.githubOwner;
  const repo = session.githubName;

  const agentId = agentForPhase(task, session, phaseToAgentKind(phase));
  const agentName = agentId ? agentDisplayName(agentId) : "the agent";
  const retryTime = formatRetryTimestamp(notBefore);
  const { title, sentence } = delayCommentCopy(kind, category, agentName, phase);

  const body = sanitizeBody(
    `⏳ **${title}**\n\n` +
      `${sentence}\n\n` +
      `Expected retry time: \`${retryTime}\`.\n\n` +
      `No manual action is required unless we want to bypass the wait by changing the agent ` +
      `assignment or manually clearing the delay.`,
    sessionRedactionPaths(session),
  );

  // Idempotency keys off the retry deadline (notBefore), NOT the runId: while a
  // delay is active the scheduler keeps ticking but the task is skipped until
  // notBefore, and a later re-claim that hits quota again computes a *new*
  // notBefore. Keying on notBefore therefore yields exactly one comment per
  // distinct delay window — no duplicate on repeated ticks, and a fresh comment
  // only when the expected retry time actually changes (issue #352).
  await outboxStore.enqueue({
    idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, "gh:comment", "quota-delay", notBefore),
    topic: "gh:comment",
    payload: { topic: "gh:comment", owner, repo, issueNumber: task.issueNumber, body },
    now,
  });
}

// ---------------------------------------------------------------------------
// Comment side effects based on handler result
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Slack notification side effects (issue #465)
// ---------------------------------------------------------------------------

/**
 * Enqueue a `slack:notification` outbox entry when the session has Slack
 * notifications configured and the task is transitioning to `ready_for_human`
 * or `failed` (issues #465, #529). The entry is idempotent on `runId` — the
 * same run's notification is de-duped at INSERT time so dispatcher retries
 * never re-post to Slack. The enqueued payload contains only public-safe fields
 * (session id, issue number, phase, reason/lastError, public GitHub URLs) and
 * the env-var NAME for the webhook — never the URL itself or any local path.
 *
 * Callers must guard on the target transition status before calling. This
 * function checks `session.notifications?.slack?.enabled` and returns early if
 * Slack is not configured, so the guard is safe but not redundant — it prevents
 * enqueuing for non-notifiable statuses.
 */
export async function enqueueSlackNotificationEffect(
  outboxStore: OutboxStore,
  session: ResolvedSession,
  task: AiTask,
  phase: TaskPhase,
  result: PhaseHandlerResult,
  runId: string,
  now: string,
): Promise<void> {
  const slack = session.notifications?.slack;
  if (!slack?.enabled || !slack.webhookUrlEnv) return;

  const ctx = result.context ?? {};
  // Fall back to the task's already-merged context so that prUrl stored from a
  // previous phase (e.g. fix-mode impl) is included even when the failed result
  // only carries { artifactDir, resolvedProfile } and no prUrl of its own.
  const rawPrUrl = typeof ctx.prUrl === "string"
    ? ctx.prUrl
    : typeof task.context?.prUrl === "string" ? task.context.prUrl : undefined;
  // PR URLs are public GitHub URLs and safe to include; strip any accidental
  // local-path contamination via sanitizeBody as a belt-and-suspenders guard.
  const prUrl = rawPrUrl
    ? sanitizeBody(rawPrUrl, sessionRedactionPaths(session)).trim() || undefined
    : undefined;

  // reason may carry agent output — sanitize and bound before storing so no
  // local path, artifact reference, or oversized agent output is ever persisted
  // in the Slack notification payload.
  // For failed results the human-readable detail is in `result.error`; for all
  // other variants it is in `result.message`. Both are optional and sanitized.
  const rawReason =
    result.result === "failed"
      ? result.error
      : "message" in result && typeof result.message === "string"
        ? result.message
        : undefined;
  const sanitizedReason = rawReason
    ? sanitizeBody(rawReason, sessionRedactionPaths(session)).trim()
    : undefined;
  // content_research / content_draft / content_review public-status contract:
  // Slack notifications must carry only fixed outcome/status values — variable
  // diagnostics (result.error, stderr, validation text, findings) must not be forwarded.
  const reason = (phase === "content_research" || phase === "content_draft" || phase === "content_review")
    ? undefined
    : sanitizedReason
      ? boundedExcerpt(sanitizedReason, 500)
      : undefined;

  const transition: "ready_for_human" | "failed" =
    result.result === "failed" ? "failed" : "ready_for_human";

  const issueUrl = `https://github.com/${session.githubOwner}/${session.githubName}/issues/${task.issueNumber}`;

  await outboxStore.enqueue({
    idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "slack:notification"),
    topic: "slack:notification",
    payload: {
      topic: "slack:notification",
      owner: session.githubOwner,
      repo: session.githubName,
      webhookUrlEnv: slack.webhookUrlEnv,
      sessionId: session.sessionId,
      issueNumber: task.issueNumber,
      phase,
      transition,
      ...(reason !== undefined ? { reason } : {}),
      issueUrl,
      ...(prUrl !== undefined ? { prUrl } : {}),
    },
    now,
  });
}

export async function enqueueHandlerCommentEffect(
  outboxStore: OutboxStore,
  session: ResolvedSession,
  task: AiTask,
  phase: TaskPhase,
  result: PhaseHandlerResult,
  runId: string,
  now: string,
  durationMs?: number,
): Promise<void> {
  // Route the Tier 1 work-item comment below through the session's work-item
  // provider. No-op passthrough for a GitHub session; for a non-GitHub provider
  // the `gh:comment` enqueue is rewritten to a `workitem:comment` row on the
  // work-item repo (see workItemOutbox). The Tier 2 public PR comment still
  // enqueues a `repohost:pr-comment` row (via enqueueRepoHostPrComment below),
  // which the wrapper passes through unchanged so it stays on the repo host.
  outboxStore = workItemOutbox(outboxStore, session);
  const owner = session.githubOwner;
  const repo = session.githubName;
  // context is present on both success/blocked and failed results
  const ctx = result.context ?? {};

  let body: string | undefined;
  // Semantic-conflict safe comments must not expose run/session/internal IDs.
  let suppressRunMetadata = false;
  // For review phase, the issue-side and PR-side comments use different subject references.
  // Issue-side: "PR #Y" (the issue number is already in the URL/title — show new info instead).
  // PR-side: "issue #X" (provides useful cross-reference context from the PR timeline).
  let prBody: string | undefined;

  if (phase === "research") {
    if (result.result === "success") {
      // Security (issue #794 review): when the prompt interpolated an untrusted
      // Issue body, the research handler withholds `researchOutput` from this
      // context entirely — a body-steered agent could otherwise echo local
      // secrets/config into its stdout, and this comment is published to the
      // public GitHub issue. Fall back to a fixed-status message in that case;
      // findings stay available locally in research-output.md.
      const bodyIncluded = ctx.bodyIncluded === true;
      // issue #806 (§10.1 of docs/research-evidence-contract.md): when
      // repository evidence was enabled for the run, served file content can
      // reach agent stdout, so the excerpt is suppressed even for an Issue
      // with no body. The two conditions are ORed; neither is narrowed.
      const evidenceEnabled = ctx.evidenceEnabled === true;
      // issue #826: the runner-owned workspace permission profile lets the
      // agent read and search the workspace with its own tools, so repository
      // content can reach stdout on a run with no body and no evidence
      // channel. Suppressed the same way; the conditions are ORed and none is
      // narrowed.
      const workspaceSettingsEnabled = ctx.workspaceSettingsEnabled === true;
      const researchOutput = typeof ctx.researchOutput === "string" ? ctx.researchOutput : "";
      const excerptSection = researchOutput
        ? `\n\n<details>\n<summary>Research findings</summary>\n\n\`\`\`\n${boundedExcerpt(researchOutput, 3000)}\n\`\`\`\n</details>`
        : "";
      // issue #834 review: `sanitized_summary` is gated at the level of the
      // run's PROVENANCE, not of the three flags above — a research run is
      // Issue-originated, so its inputs are untrusted whether or not any
      // particular work-item field reached the prompt. When the handler withheld
      // a validated report it names that reason, so the comment explains itself
      // instead of falling through to a bare "Research complete." A `local_only`
      // session never sets the field, so its comment is unchanged.
      const withheldPublicationReason =
        typeof ctx.researchPublicationWithheld === "object" && ctx.researchPublicationWithheld !== null
          ? (ctx.researchPublicationWithheld as Record<string, unknown>).reason
          : undefined;
      const withheldPublicationBecause =
        typeof withheldPublicationReason === "string"
          && Object.hasOwn(PUBLICATION_WITHHOLD_PHRASES, withheldPublicationReason)
          ? PUBLICATION_WITHHOLD_PHRASES[withheldPublicationReason as PublicationWithholdReason]
          : undefined;
      const withheldBecause = withheldPublicationBecause ?? (evidenceEnabled
        ? "repository evidence was enabled for the run"
        : workspaceSettingsEnabled
          ? "a workspace read-only permission profile was enabled for the run"
          : "the Issue body was included as agent input");
      // issue #834: under the `sanitized_summary` publication policy the
      // handler has already extracted a closed-schema publication envelope from
      // the agent's findings and validated, sanitized, and rendered it. That
      // report — never raw stdout — is what gets published. Its own gate is
      // stricter than the flags above: the handler only puts the report in the
      // context when the operator has explicitly accepted the untrusted
      // provenance of an Issue-originated run (`allowUntrustedInputs`), because
      // a steered agent can place a secret inside a well-formed envelope that
      // known-pattern redaction cannot recognize. When it stayed local, no
      // field is set here and the fixed "recorded locally" status below is what
      // gets posted. Both publication branches are entered only when the handler
      // put the corresponding field in the context, so a `local_only` session
      // reaches neither and its comment is unchanged.
      const publication: Record<string, unknown> =
        typeof ctx.researchPublication === "object" && ctx.researchPublication !== null
          ? ctx.researchPublication as Record<string, unknown>
          : {};
      const publishedReport = typeof publication.report === "string" ? publication.report.trim() : "";
      const publicationFailed =
        typeof ctx.researchPublicationFailed === "object" && ctx.researchPublicationFailed !== null;
      if (publishedReport) {
        const truncationNote = publication.truncated === true
          ? "\n\n_(report truncated to the configured publication size budget)_"
          : "";
        body =
          `🔬 **Research complete** for issue #${task.issueNumber}.\n\n${publishedReport}${truncationNote}`;
      } else if (publicationFailed) {
        // Fixed public-safe status. The closed-vocabulary reason names runner
        // internals an Issue reader cannot act on, so it stays in the local
        // diagnostic; raw stdout/stderr is never a fallback here.
        body =
          `🔬 **Research complete** for issue #${task.issueNumber}. ${RESEARCH_PUBLICATION_FAILED_STATUS}`;
      } else {
        body = bodyIncluded || evidenceEnabled || workspaceSettingsEnabled || withheldPublicationBecause
          ? `🔬 **Research complete** for issue #${task.issueNumber}. Findings recorded locally (not published here because ${withheldBecause}).`
          : `🔬 **Research complete** for issue #${task.issueNumber}.${excerptSection}`;
      }
    } else if (result.result === "failed") {
      body = `❌ **Research failed** for issue #${task.issueNumber}.\n\nError: ${result.error}`;
    }
  } else if (phase === "content_research") {
    // Public-status contract (docs/content-research-mvp-contract.md §Public-Status Contract):
    // Only fixed outcome/status text is published. Research findings, agent output,
    // stderr excerpts, validation text, and local paths must never appear here.
    suppressRunMetadata = true;
    if (result.result === "success") {
      body = `✅ **Content research complete** for issue #${task.issueNumber}.`;
    } else if (result.result === "failed") {
      body = `❌ **Content research failed** for issue #${task.issueNumber}.`;
    }
  } else if (phase === "content_draft") {
    // Public-status contract (docs/content-draft-mvp-contract.md §Outcome enums):
    // Only the fixed outcome enum is published. Draft text, editorial findings,
    // fix feedback, source excerpts, validation text, and local paths must never appear here.
    // The outcome enum must appear in every GitHub-visible update so callers can
    // distinguish input_invalid from draft_failed.
    suppressRunMetadata = true;
    if (result.result === "success") {
      body = `✅ **Content draft complete** for issue #${task.issueNumber}. Outcome: \`draft_complete\`.`;
    } else if (result.result === "failed") {
      const draftOutcome = ctx.outcome === "input_invalid" ? "input_invalid" : "draft_failed";
      body = `❌ **Content draft failed** for issue #${task.issueNumber}. Outcome: \`${draftOutcome}\`.`;
    }
  } else if (phase === "content_review") {
    // Public-status contract (docs/content-review-mvp-contract.md §Public-Status Contract):
    // Only fixed outcome/status text is published. Editorial findings, fix feedback,
    // draft text, source excerpts, validation text, and local paths must never appear here.
    suppressRunMetadata = true;
    if (result.result === "success") {
      body = `✅ **Content review passed** for issue #${task.issueNumber}. Ready for human review. Outcome: \`success\`.`;
    } else if (result.result === "needs_fix") {
      // The task (already transitioned by the time this runs) tells us which
      // outcome actually happened: the editorial cycle cap
      // (DEFAULT_MAX_CONTENT_REVIEW_CYCLES in transitions.ts) may have sent this
      // `needs_fix` straight to a human handoff instead of back to content_draft,
      // and the public status must not claim an automated revision is coming
      // when none will run.
      body =
        task.status === "ready_for_human"
          ? `🔄 **Content review: needs revision** for issue #${task.issueNumber}. Editorial cycle limit reached — escalated for human review. Outcome: \`needs_fix\`.`
          : `🔄 **Content review: needs revision** for issue #${task.issueNumber}. Returned to draft phase. Outcome: \`needs_fix\`.`;
    } else if (result.result === "failed" || result.result === "blocked") {
      body = `❌ **Content review blocked** for issue #${task.issueNumber}. Outcome: \`blocked\`.`;
    }
  } else if (phase === "implementation") {
    if (result.result === "success") {
      const prUrl = typeof ctx.prUrl === "string" ? ctx.prUrl : "(no PR URL)";
      const prNum = typeof ctx.prUrl === "string" ? extractPrNumberFromUrl(ctx.prUrl) : undefined;
      const subjectRef = prNum !== undefined ? `PR #${prNum}` : `issue #${task.issueNumber}`;
      body = `✅ **Implementation complete** for ${subjectRef}.\n\nPR: ${prUrl}`;
    } else if (result.result === "failed") {
      body = `❌ **Implementation failed** for issue #${task.issueNumber}.\n\nError: ${result.error}`;
    } else if (result.result === "blocked") {
      const reason = typeof result.message === "string" ? result.message : "Open dependency blockers detected";
      body = `🚫 **Implementation blocked** for issue #${task.issueNumber} — escalated to human.\n\nReason: ${reason}`;
    } else if (result.result === "tool_request") {
      // Disallowed-command Tool Request handoff (issue #291). Surface what the
      // agent asked for so an operator can act, WITHOUT echoing any server-side
      // path (sanitizeBody redacts the body below before it is enqueued).
      //
      // Duplicate suppression (issue #300): if `toolRequestRepeatKind` is set,
      // either suppress the comment entirely (unresolved duplicate — the first
      // request is already visible) or replace it with a diagnostic (resolved
      // duplicate — operator marked done but repo state did not change).
      const repeatKind = typeof ctx.toolRequestRepeatKind === "string"
        ? ctx.toolRequestRepeatKind
        : undefined;

      if (repeatKind !== "unresolved-duplicate") {
        const tr = (typeof ctx.toolRequest === "object" && ctx.toolRequest !== null
          ? ctx.toolRequest
          : {}) as Record<string, unknown>;
        // Public comment shows the REDACTED display command, never the exact one
        // (docs/tool-request-and-dependency-sync.md §2.4). If no display form was
        // stored (e.g. a malformed/externally produced handler context), re-redact
        // the exact command rather than echoing it verbatim — sanitizeBody only
        // removes paths, so a secret flag value (e.g. `--token=SECRET`) would
        // otherwise leak despite the exact-vs-display contract.
        const displayCommand =
          typeof tr.displayCommand === "string" && tr.displayCommand.trim().length > 0
            ? tr.displayCommand.trim()
            : typeof tr.command === "string" && tr.command.trim().length > 0
              ? redactCommand(tr.command.trim())
              : "(unspecified)";
        // Every other field here is also agent-controlled free text, so a secret
        // (e.g. `ghp_...` or `Authorization: Bearer ...`) could ride in `reason`,
        // `expectedFiles`, or `suggestedAction` just as easily as in the command.
        // sanitizeBody below only strips paths, so run each through redactCommand
        // too before interpolating it into the public comment.
        const reason = typeof tr.reason === "string" && tr.reason.trim().length > 0
          ? redactCommand(tr.reason.trim())
          : "(no reason provided)";
        const expectedFiles = Array.isArray(tr.expectedFiles) && tr.expectedFiles.length > 0
          ? (tr.expectedFiles as unknown[])
              .filter((f): f is string => typeof f === "string")
              .map((f) => redactCommand(f))
              .join(", ")
          : "(none specified)";
        const necessity = tr.necessity === "optional" ? "optional" : "required";
        const suggestedAction = typeof tr.suggestedAction === "string" && tr.suggestedAction.trim().length > 0
          ? redactCommand(tr.suggestedAction.trim())
          : "Review the request and resolve it manually.";
        // Dependency-update handoff (issue #302). When the trusted dependency-sync
        // path recognized the install but could NOT safely satisfy it (already
        // satisfied, a manifest error, or a sync failure), explain that the workflow
        // tried the dependency-sync path and why it stopped — so the operator sees
        // this is a dependency-specific handoff, not just an ungranted command. Every
        // field is agent/handler-derived free text, so redact like the others.
        const du = (typeof ctx.dependencyUpdate === "object" && ctx.dependencyUpdate !== null
          ? ctx.dependencyUpdate
          : undefined) as Record<string, unknown> | undefined;
        const duFailure = du && typeof du.failure === "object" && du.failure !== null
          ? (du.failure as Record<string, unknown>)
          : undefined;
        if (du && duFailure) {
          const kind = typeof duFailure.kind === "string" ? redactCommand(duFailure.kind) : "failed";
          const detail = typeof duFailure.message === "string" && duFailure.message.trim().length > 0
            ? redactCommand(duFailure.message.trim())
            : "(no detail)";
          const manager = typeof du.manager === "string" ? redactCommand(du.manager) : "the package manager";
          body =
            `🛠️ **Dependency update could not be applied automatically** for issue #${task.issueNumber} — escalated to human.\n\n` +
            `The workflow recognized a ${manager} dependency-update request and tried its trusted ` +
            `dependency-sync path (edit the manifest, regenerate the lockfile), but stopped without ` +
            `committing.\n\n` +
            `- **Requested command**: \`${displayCommand}\`\n` +
            `- **Reason**: ${reason}\n` +
            `- **Why it stopped** (${kind}): ${detail}\n` +
            `- **Necessity**: ${necessity}\n\n` +
            `Resolve it manually (for an already-satisfied dependency, the agent can proceed without ` +
            `the install). An operator can review unresolved requests with \`admin tool-request list\` ` +
            `and unblock with \`admin tool-request resolve\`.`;
        } else {
          const detailLines =
            `- **Requested command**: \`${displayCommand}\`\n` +
            `- **Reason**: ${reason}\n` +
            `- **Expected changed files**: ${expectedFiles}\n` +
            `- **Necessity**: ${necessity}\n` +
            `- **Suggested next action**: ${suggestedAction}\n\n` +
            `An operator can review unresolved requests with \`admin tool-request list\` and unblock with ` +
            `\`admin tool-request resolve\`.`;

          if (repeatKind === "resolved-duplicate") {
            body =
              `🛠️ **Repeated Tool Request** for issue #${task.issueNumber} — the previous manual completion did not change the target repository state.\n\n` +
              `The implementation agent requested the same command again after the previous request was marked manually done. ` +
              `The workflow did **not** run it.\n\n` +
              detailLines;
          } else {
            body =
              `🛠️ **Implementation needs a disallowed command** for issue #${task.issueNumber} — escalated to human.\n\n` +
              `The implementation agent stopped because it needs a command outside its allowed tool set. ` +
              `The workflow did **not** run it.\n\n` +
              detailLines;
          }
        }
      }
      // If repeatKind === "unresolved-duplicate", body remains undefined — no
      // public comment is posted, but task events and artifacts are still recorded.
    }
  } else if (phase === "conflict_resolution") {
    const prUrl = typeof ctx.prUrl === "string" ? ctx.prUrl : undefined;
    const prNum = prUrl ? extractPrNumberFromUrl(prUrl) : undefined;
    const subjectRef = prNum !== undefined ? `PR #${prNum}` : `issue #${task.issueNumber}`;
    if (result.result === "success") {
      const conflictResolution = typeof ctx.conflictResolution === "object" && ctx.conflictResolution !== null
        ? ctx.conflictResolution as Record<string, unknown>
        : undefined;
      const isClean = conflictResolution?.clean === true;
      const conflictedFiles = Array.isArray(ctx.conflictedFiles) ? ctx.conflictedFiles as string[] : [];
      const resolutionDetail = isClean
        ? "clean base merge (no conflicted files)"
        : conflictedFiles.length > 0
          ? `agent-assisted (${conflictedFiles.length} file(s) resolved: ${conflictedFiles.slice(0, 5).join(", ")}${conflictedFiles.length > 5 ? `, …and ${conflictedFiles.length - 5} more` : ""})`
          : "agent-assisted";
      body = `✅ **Conflict resolved** for ${subjectRef} — returning to review.\n\nResolution: ${resolutionDetail}`;
    } else if (result.result === "blocked") {
      if (ctx.conflictResolutionVerificationCapReached === true) {
        // Repeated same-kind verification failure — escalated to human (issue #536/#537).
        const attempts = typeof ctx.conflictResolutionVerificationAttempts === "number"
          ? ctx.conflictResolutionVerificationAttempts : "?";
        const maxAttempts = typeof ctx.conflictResolutionMaxAttempts === "number"
          ? ctx.conflictResolutionMaxAttempts : "?";
        const semanticConflict = typeof ctx.semanticConflict === "object" && ctx.semanticConflict !== null
          ? ctx.semanticConflict as Record<string, unknown>
          : undefined;
        const prBranch = typeof ctx.branch === "string" ? ctx.branch : "the PR branch";
        const baseBranch = session.baseBranch ?? "main";
        const verCmd = semanticConflict && typeof semanticConflict.verificationCommand === "string"
          ? redactCommand(semanticConflict.verificationCommand)
          : "verification";
        const verCmdName = semanticConflict && typeof semanticConflict.verificationCommandName === "string"
          ? semanticConflict.verificationCommandName : undefined;
        const exitCode = semanticConflict && typeof semanticConflict.exitCode === "number"
          ? semanticConflict.exitCode : undefined;
        const failedTests = Array.isArray(semanticConflict?.["failedTests"])
          ? (semanticConflict!["failedTests"] as string[]) : [];
        const conflictedFiles = Array.isArray(ctx.conflictedFiles) ? ctx.conflictedFiles as string[] : [];
        const verLabel = verCmdName ? `\`${verCmdName}\` (\`${verCmd}\`)` : `\`${verCmd}\``;
        const exitDisplay = exitCode !== undefined ? ` — exited ${exitCode}` : ` — non-zero exit`;
        let b =
          `🛑 **Conflict resolution escalated** for ${subjectRef}.\n\n` +
          `Conflict markers may have been resolved, but verification still failed after ${attempts}/${maxAttempts} attempt(s). ` +
          `A semantic conflict is suspected between \`${prBranch}\` and \`${baseBranch}\`.\n\n` +
          `**Verification:** ${verLabel}${exitDisplay}`;
        if (conflictedFiles.length > 0) {
          const fileList = conflictedFiles.slice(0, 10).map(f => `- \`${f}\``).join("\n");
          const more = conflictedFiles.length > 10 ? `\n- …and ${conflictedFiles.length - 10} more` : "";
          b += `\n\n**Conflicted files (${conflictedFiles.length}):**\n${fileList}${more}`;
        }
        if (failedTests.length > 0) {
          const testList = failedTests.slice(0, 10).map(t => `- ${t}`).join("\n");
          const more = failedTests.length > 10 ? `\n- …and ${failedTests.length - 10} more` : "";
          b += `\n\n**Failed tests (${failedTests.length}):**\n${testList}${more}`;
        }
        b +=
          `\n\n**Suggested next actions:**\n` +
          `- Inspect and resolve the semantic conflict between \`${prBranch}\` and \`${baseBranch}\` manually.\n` +
          `- For complex merge semantics, consider using an AI-assisted integration tool (e.g. Codex) for analysis.\n` +
          `- If the PR changes are fundamentally incompatible with \`${baseBranch}\`, consider splitting the issue into smaller independent parts.\n` +
          `- If the feature interaction is irreconcilable, a redesign of one or both sides may be required.`;
        body = b;
        suppressRunMetadata = true;
      } else {
        // Non-auto-resolvable conflict (binary or modify/delete) handed off to a human.
        const reason = typeof result.message === "string" ? result.message : "Conflict requires human judgement";
        body = `⚠️ **Conflict resolution handed off to human** for ${subjectRef}.\n\nThis merge conflict is not safely auto-resolvable.\n\nReason: ${reason}`;
      }
    } else if (result.result === "failed") {
      const semanticConflict = typeof ctx.semanticConflict === "object" && ctx.semanticConflict !== null
        ? ctx.semanticConflict as Record<string, unknown>
        : undefined;
      if (semanticConflict) {
        const prBranch = typeof ctx.branch === "string" ? ctx.branch : "the PR branch";
        const baseBranch = session.baseBranch ?? "main";
        const verCmd = typeof semanticConflict.verificationCommand === "string"
          ? redactCommand(semanticConflict.verificationCommand)
          : "verification";
        const verCmdName = typeof semanticConflict.verificationCommandName === "string"
          ? semanticConflict.verificationCommandName : undefined;
        const exitCode = typeof semanticConflict.exitCode === "number"
          ? semanticConflict.exitCode : undefined;
        const failedTests = Array.isArray(semanticConflict["failedTests"])
          ? (semanticConflict["failedTests"] as string[]) : [];
        const conflictedFiles = Array.isArray(ctx.conflictedFiles) ? ctx.conflictedFiles as string[] : [];
        const verLabel = verCmdName ? `\`${verCmdName}\` (\`${verCmd}\`)` : `\`${verCmd}\``;
        const exitDisplay = exitCode !== undefined ? ` — exited ${exitCode}` : ` — non-zero exit`;
        let b: string;
        if (failedTests.length > 0) {
          b = `❌ **Conflict resolution failed** for ${subjectRef}.\n\n` +
            `Conflict markers may have been resolved, but verification still failed for \`${prBranch}\` against \`${baseBranch}\`: ` +
            `${verLabel}${exitDisplay}. A semantic conflict is suspected — human review is required.`;
        } else {
          b = `❌ **Conflict resolution failed** for ${subjectRef}.\n\n` +
            `Conflict resolution was attempted for \`${prBranch}\` against \`${baseBranch}\`. ` +
            `Verification failed (${verLabel}${exitDisplay}) but no named test failures were captured — ` +
            `this may indicate a dependency or environment setup issue. Human review is required.`;
        }
        if (conflictedFiles.length > 0) {
          const fileList = conflictedFiles.slice(0, 10).map(f => `- \`${f}\``).join("\n");
          const more = conflictedFiles.length > 10 ? `\n- …and ${conflictedFiles.length - 10} more` : "";
          b += `\n\n**Conflicted files (${conflictedFiles.length}):**\n${fileList}${more}`;
        }
        if (failedTests.length > 0) {
          const testList = failedTests.slice(0, 10).map(t => `- ${t}`).join("\n");
          const more = failedTests.length > 10 ? `\n- …and ${failedTests.length - 10} more` : "";
          b += `\n\n**Failed tests (${failedTests.length}):**\n${testList}${more}`;
        }
        b +=
          `\n\n**Suggested next actions:**\n` +
          `- Inspect and resolve the conflict between \`${prBranch}\` and \`${baseBranch}\` manually.\n` +
          `- For complex merge semantics, consider using an AI-assisted integration tool (e.g. Codex) for analysis.\n` +
          `- If the PR changes are fundamentally incompatible with \`${baseBranch}\`, consider splitting the issue into smaller independent parts.\n` +
          `- If the feature interaction is irreconcilable, a redesign of one or both sides may be required.`;
        body = b;
        suppressRunMetadata = true;
      } else {
        body = `❌ **Conflict resolution failed** for ${subjectRef}.`;
      }
    }
  } else if (phase === "review") {
    const reviewPrUrl = typeof task.context?.prUrl === "string" ? task.context.prUrl : undefined;
    const reviewPrNum = reviewPrUrl ? extractPrNumberFromUrl(reviewPrUrl) : undefined;
    // Issue-side: show PR number (issue number is redundant on the issue page)
    const issueSideRef = reviewPrNum !== undefined ? `PR #${reviewPrNum}` : `issue #${task.issueNumber}`;
    // PR-side: show issue number (provides cross-reference context from the PR timeline)
    const prSideRef = `issue #${task.issueNumber}`;
    const needsSeparatePrBody = reviewPrNum !== undefined;

    if (result.result === "success") {
      // A dependency-started PR targets the session base branch (`main`) like any
      // other PR, so a passing review is a normal mergeable result — no stacked /
      // retarget caveat is emitted (issue #242).
      body = `✅ **Review passed** for ${issueSideRef}.`;
      if (needsSeparatePrBody) prBody = `✅ **Review passed** for ${prSideRef}.`;
    } else if (result.result === "needs_fix") {
      const reason = typeof result.message === "string" ? result.message : "Review found blocking findings";
      const reviewFeedback = typeof ctx.reviewFeedback === "string" ? ctx.reviewFeedback : "";
      const excerptSection = reviewFeedback
        ? fencedDetailsExcerpt("Review findings excerpt", reviewFeedback, 3000)
        : "";
      body = `🔄 **Review found blocking findings for ${issueSideRef} — automatically requeuing to fix mode.**\n\nReason: ${reason}${excerptSection}`;
      // Public PR comment (Tier 2) must be a public-safe summary. Omit BOTH the
      // raw review-findings excerpt AND the `Reason:` line: `reason` can carry the
      // first 300 chars of raw verification stdout/stderr (handlers/review.ts) or
      // the AI classifier's reason, neither of which is public-safe. The full
      // detail stays on the Tier 1 work-item comment only.
      if (needsSeparatePrBody) prBody = `🔄 **Review found blocking findings for ${prSideRef} — automatically requeuing to fix mode.**`;
    } else if (result.result === "conflict") {
      const reason = typeof result.message === "string" ? result.message : "Merge conflict detected";
      body = `⚠️ **Merge conflict detected for ${issueSideRef} — handing off to automated conflict resolution.**\n\nReason: ${reason}`;
      if (needsSeparatePrBody) prBody = `⚠️ **Merge conflict detected for ${prSideRef} — handing off to automated conflict resolution.**\n\nReason: ${reason}`;
    } else if (result.result === "blocked") {
      const reason = typeof result.message === "string" ? result.message : "Review requires human attention";
      const isCapReached = ctx.reviewLoopCapReached === true;
      const isConflictReviewCapReached = ctx.conflictReviewLoopCapReached === true;
      if (isCapReached) {
        const completedCycles = typeof ctx.reviewCycles === "number" ? ctx.reviewCycles : "?";
        const maxCycles = typeof ctx.reviewLoopMaxCycles === "number" ? ctx.reviewLoopMaxCycles : "?";
        const capNote = `\n\nAutomatic implementation/review has been paused to avoid further quota consumption.\nNext suggested action: inspect the latest PR manually, split or redesign the issue, or run a stronger model deliberately.`;
        const reviewFeedback = typeof ctx.reviewFeedback === "string" ? ctx.reviewFeedback : "";
        const excerptSection = reviewFeedback
          ? fencedDetailsExcerpt("Latest review findings", reviewFeedback, 3000)
          : "";
        body = `🛑 **Review loop cap reached** for ${issueSideRef}.\n\nBlocking review cycles: ${completedCycles}/${maxCycles}.${capNote}${excerptSection}`;
        // Public PR comment (Tier 2): omit the raw latest-review-findings excerpt.
        if (needsSeparatePrBody) prBody = `🛑 **Review loop cap reached** for ${prSideRef}.\n\nBlocking review cycles: ${completedCycles}/${maxCycles}.${capNote}`;
      } else if (isConflictReviewCapReached) {
        // Conflict-review loop cap: the PR was returned from conflict_resolution to review
        // multiple times and still shows merge-conflict signals (issue #540). Public comments
        // contain no raw rationale fields — only the cycle count and generic guidance.
        const completedCycles = typeof ctx.conflictReviewCycles === "number" ? ctx.conflictReviewCycles : "?";
        const maxCycles = typeof ctx.conflictReviewLoopMaxCycles === "number" ? ctx.conflictReviewLoopMaxCycles : "?";
        body =
          `🛑 **Conflict-review loop cap reached** for ${issueSideRef}.\n\n` +
          `This PR has been returned from conflict resolution to review ${completedCycles}/${maxCycles} time(s) and still shows merge-conflict signals.\n\n` +
          `**Suggested next actions:**\n` +
          `- Inspect the PR manually to identify why the conflict persists after automated resolution.\n` +
          `- Consider resolving the conflict manually, then re-queue.\n` +
          `- If the changes are fundamentally incompatible, consider splitting or redesigning the issue.`;
        if (needsSeparatePrBody) prBody =
          `🛑 **Conflict-review loop cap reached** for ${prSideRef}.\n\n` +
          `This PR has been returned from conflict resolution to review ${completedCycles}/${maxCycles} time(s) and still shows merge-conflict signals. Manual inspection required.`;
      } else {
        const conflictNote = ctx.classification === "conflict" ? "\n\nConflict handling is not automated — resolve the merge conflict manually, then re-queue." : "";
        body = `⚠️ **Review escalated to human** for ${issueSideRef}.\n\nReason: ${reason}${conflictNote}`;
        if (needsSeparatePrBody) prBody = `⚠️ **Review escalated to human** for ${prSideRef}.\n\nReason: ${reason}${conflictNote}`;
      }
    } else if (result.result === "failed") {
      const reviewFailureOutput = typeof ctx.reviewFailureOutput === "string" ? ctx.reviewFailureOutput : "";
      const outputExcerpt = reviewFailureOutput
        ? `\n\n<details>\n<summary>Review output excerpt</summary>\n\n\`\`\`\n${boundedExcerpt(reviewFailureOutput, 3000)}\n\`\`\`\n</details>`
        : "";
      body = `❌ **Review failed** for ${issueSideRef}.\n\nError: ${result.error}${outputExcerpt}`;
      // Public PR comment (Tier 2): omit BOTH the raw review-output excerpt AND the
      // `Error:` line. `result.error` carries the first 500 chars of raw review-agent
      // stderr/stdout (handlers/review.ts), which is not public-safe. Post only a
      // generic failure summary; the detailed error stays on the Tier 1 work-item
      // comment only.
      if (needsSeparatePrBody) prBody = `❌ **Review failed** for ${prSideRef}.`;
    }
  }

  if (!body) return;

  const resolvedProfileCtx = typeof ctx.resolvedProfile === "object" && ctx.resolvedProfile !== null
    ? ctx.resolvedProfile as Record<string, unknown>
    : undefined;
  const metadataBlock = suppressRunMetadata ? "" : buildRunMetadataBlock(phase, runId, resolvedProfileCtx, durationMs);

  body = sanitizeBody(body + metadataBlock, sessionRedactionPaths(session));

  await outboxStore.enqueue({
    idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:comment", phase, result.result),
    topic: "gh:comment",
    payload: { topic: "gh:comment", owner, repo, issueNumber: task.issueNumber, body },
    now,
  });

  // For review phase outcomes, also post to the PR timeline so reviewers see the result
  // without navigating back to the issue. Use the PR-specific body (with issue reference).
  //
  // This is a public repo-host (Tier 2) comment, so it MUST route through the
  // configured RepoHostProvider — not the work-item provider. Enqueue it as a
  // `repohost:pr-comment` row so the dispatcher resolves it with the repo-host
  // runner (`repoHostProvider.auth`); in a split-auth session the public PR
  // comment is therefore never posted under the private work-item identity.
  // `enqueueRepoHostPrComment` applies the same path sanitization (plus the
  // Tier-2 bound) the legacy inline enqueue did. `body` is already sanitized and
  // carries the metadata block; `prBody` is the raw PR-specific text to which the
  // helper applies the visibility policy.
  if (phase === "review") {
    const prUrl = typeof task.context?.prUrl === "string" ? task.context.prUrl : undefined;
    const prNumber = prUrl ? extractPrNumberFromUrl(prUrl) : undefined;
    if (prNumber !== undefined) {
      const prCommentBody = prBody !== undefined ? prBody + metadataBlock : body;
      await enqueueRepoHostPrComment(outboxStore, {
        provider: session.repoHostProvider.provider,
        owner,
        repo,
        prNumber,
        // Retain the legacy "gh:comment" idempotency-key token so dedup behavior
        // is exactly equivalent to the previous PR enqueue — only the auth
        // routing changes, not which logical event the key identifies.
        idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "gh:comment", phase, result.result, "pr"),
        body: prCommentBody,
        configuredPaths: sessionRedactionPaths(session),
        now,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// PR change summary sticky comment (issue #506)
// ---------------------------------------------------------------------------

/**
 * Enqueue a sticky PR change summary comment for the human merge gate.
 *
 * Fires after implementation success and after any review outcome that touches
 * the PR (success, needs_fix, blocked). The dispatcher upserts the comment —
 * editing the existing sticky comment in place rather than posting a new one —
 * so the human maintainer always sees the latest change summary without a
 * scrolling wall of bot comments.
 *
 * Only enqueued when a PR number can be resolved from the result context or
 * task context. Silently no-ops when no PR URL is available (e.g. a blocked
 * implementation that never created a PR).
 */
export async function enqueuePrSummaryEffect(
  outboxStore: OutboxStore,
  session: ResolvedSession,
  task: AiTask,
  phase: TaskPhase,
  result: PhaseHandlerResult,
  runId: string,
  now: string,
): Promise<void> {
  // Only fire for phases and results where a PR exists and a summary is useful.
  const shouldEnqueue =
    (phase === "implementation" && result.result === "success") ||
    (phase === "review" &&
      (result.result === "success" || result.result === "needs_fix" || result.result === "blocked"));
  if (!shouldEnqueue) return;

  // Resolve the PR number from the result context first, then the task context.
  const ctx = result.context ?? {};
  const rawPrUrl =
    typeof ctx.prUrl === "string"
      ? ctx.prUrl
      : typeof task.context?.prUrl === "string"
        ? task.context.prUrl
        : undefined;
  const prNumber = rawPrUrl ? extractPrNumberFromUrl(rawPrUrl) : undefined;
  if (prNumber === undefined) return;

  const owner = session.githubOwner;
  const repo = session.githubName;

  // Extract diff classification from the review result context (available for
  // Claude/Gemini reviews only; Codex reviews do not capture it in the context).
  const rawDiffClassification =
    typeof ctx.diffClassification === "object" && ctx.diffClassification !== null
      ? (ctx.diffClassification as DiffClassification)
      : undefined;

  // Extract issue-required verification status from the result context (set by
  // the review handler at Step 4.5 and carried in the success/blocked contexts).
  const rawIssueRequiredVerifications = Array.isArray(ctx.issueRequiredVerifications)
    ? (ctx.issueRequiredVerifications as IssueRequiredVerification[])
    : undefined;

  // Extract verification info for implementation success and review results.
  let verificationNames: string[] | undefined;
  let verificationPassed: boolean | undefined;
  if (phase === "implementation" && result.result === "success") {
    const v = session.verification;
    if (v) {
      const names = Object.keys(v).filter((k) => Boolean(v[k]));
      if (names.length > 0) {
        verificationNames = names;
        // Implementation succeeds only after verification passes.
        verificationPassed = true;
      }
    }
  } else if (phase === "review") {
    const v = session.verification;
    if (v) {
      const names = Object.keys(v).filter((k) => Boolean(v[k]));
      if (names.length > 0) {
        const failure =
          typeof ctx.verificationFailure === "object" && ctx.verificationFailure !== null
            ? (ctx.verificationFailure as { name: string })
            : undefined;
        if (failure) {
          // Only the failed command (and preceding ones) ran; report just the failed one.
          verificationNames = [failure.name];
          verificationPassed = false;
        } else {
          verificationNames = names;
        }
        if (!failure && (result.result === "success" || result.result === "needs_fix")) {
          // success/needs_fix without a verificationFailure marker means Step 4
          // (verification) ran before the review agent and all commands passed.
          verificationPassed = true;
        }
        // For blocked without verificationFailure the verification state is unknown;
        // leave verificationPassed as undefined.
      }
    }
  }

  // Only include the issue title when the work-item tracker is on the same
  // public surface as the PR (both GitHub). In split-provider sessions the
  // work-item title comes from a private tracker and must not be published on
  // the public PR.
  const issueTitle =
    session.workItemProvider.provider === "github-issues" &&
    typeof task.context?.title === "string" &&
    task.context.title.trim().length > 0
      ? task.context.title.trim()
      : undefined;

  const body = renderPrSummary({
    issueNumber: task.issueNumber,
    issueTitle,
    phase,
    phaseResult: result.result,
    runId,
    diffClassification: rawDiffClassification,
    verificationNames,
    verificationPassed,
    ...(rawIssueRequiredVerifications !== undefined &&
      session.workItemProvider.provider === "github-issues"
      ? { issueRequiredVerifications: rawIssueRequiredVerifications }
      : {}),
  });

  await enqueueRepoHostPrSummary(outboxStore, {
    provider: session.repoHostProvider.provider,
    owner,
    repo,
    prNumber,
    idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "repohost:pr-summary"),
    marker: PR_SUMMARY_MARKER,
    body,
    configuredPaths: sessionRedactionPaths(session),
    now,
  });
}

/**
 * Enqueue the Human Gate Decision Summary sticky PR comment (issue #552).
 *
 * Fires only when an AI review passes (`phase === "review"` and
 * `result.result === "success"`), which is the moment the task transitions to
 * `ready_for_human`. The comment is updated rather than duplicated on repeated
 * review passes via `replacePendingPrSummary` + a distinct `HUMAN_GATE_MARKER`.
 * Silently no-ops when no PR URL is available.
 */
export async function enqueueHumanGateSummaryEffect(
  outboxStore: OutboxStore,
  session: ResolvedSession,
  task: AiTask,
  phase: TaskPhase,
  result: PhaseHandlerResult,
  runId: string,
  now: string,
  durationMs?: number,
): Promise<void> {
  if (phase !== "review" || result.result !== "success") return;

  const ctx = result.context ?? {};
  const rawPrUrl =
    typeof ctx.prUrl === "string"
      ? ctx.prUrl
      : typeof task.context?.prUrl === "string"
        ? task.context.prUrl
        : undefined;
  const prNumber = rawPrUrl ? extractPrNumberFromUrl(rawPrUrl) : undefined;
  if (prNumber === undefined) return;

  const owner = session.githubOwner;
  const repo = session.githubName;

  const rawDiffClassification =
    typeof ctx.diffClassification === "object" && ctx.diffClassification !== null
      ? (ctx.diffClassification as DiffClassification)
      : undefined;

  const rawBranch = typeof ctx.branch === "string" ? ctx.branch : undefined;
  const reviewAgentUsed = typeof ctx.reviewAgentUsed === "string" ? ctx.reviewAgentUsed : undefined;
  const classifierReason = typeof ctx.reason === "string" ? ctx.reason : undefined;
  const resolvedProfile =
    typeof ctx.resolvedProfile === "object" && ctx.resolvedProfile !== null
      ? (ctx.resolvedProfile as Record<string, unknown>)
      : undefined;

  // Verification info: review succeeds only when all configured verification
  // commands passed in Step 4 (same derivation as enqueuePrSummaryEffect).
  let verificationNames: string[] | undefined;
  let verificationPassed: boolean | undefined;
  const v = session.verification;
  if (v) {
    const names = Object.keys(v).filter((k) => Boolean(v[k]));
    if (names.length > 0) {
      verificationNames = names;
      verificationPassed = true;
    }
  }

  // Only include the issue title when the work-item tracker is on the same
  // public surface as the PR (both GitHub). In split-provider sessions the
  // work-item title comes from a private tracker and must not be published.
  const issueTitle =
    session.workItemProvider.provider === "github-issues" &&
    session.repoHostProvider.provider === "github" &&
    typeof task.context?.title === "string" &&
    task.context.title.trim().length > 0
      ? task.context.title.trim()
      : undefined;

  const body = renderHumanGateSummary({
    issueNumber: task.issueNumber,
    issueTitle,
    prNumber,
    branch: rawBranch,
    phase,
    phaseResult: result.result,
    runId,
    diffClassification: rawDiffClassification,
    verificationNames,
    verificationPassed,
    reviewAgentUsed,
    classifierReason,
    resolvedProfile,
    durationMs,
  });

  await enqueueRepoHostPrSummary(outboxStore, {
    provider: session.repoHostProvider.provider,
    owner,
    repo,
    prNumber,
    idempotencyKey: makeOutboxKey(session.sessionId, task.issueNumber, runId, "repohost:human-gate"),
    marker: HUMAN_GATE_MARKER,
    body,
    configuredPaths: sessionRedactionPaths(session),
    now,
  });
}

// ---------------------------------------------------------------------------
// Review-dispute outcome comments (issue #848, §11)
// ---------------------------------------------------------------------------

/**
 * The repository a public repo-host comment must be addressed to.
 *
 * The dispatcher builds the repo-host provider from the row's own
 * `owner`/`repo` (`gh-dispatcher.ts`, `repohost:pr-comment`), so the address
 * has to name the *code* repository the configured provider actually serves.
 * For `github` that is `githubRepo`, unchanged. For `gitea` the code repo is
 * declared explicitly in `repoHostProvider.gitea` and may differ from
 * `githubRepo` entirely (a self-hosted instance has no implicit relationship to
 * it), so addressing a Gitea row with `githubOwner`/`githubName` would post the
 * outcome to the wrong repository or 404 forever. Mirrors the work-item side's
 * resolution in {@link workItemOutbox}.
 *
 * Falls back to the GitHub tuple when a `gitea` provider carries no block —
 * `validateSession` rejects that combination, so this is only a type-level
 * guard, not a supported configuration.
 */
function repoHostCommentTarget(session: ResolvedSession): { owner: string; repo: string } {
  const rh = session.repoHostProvider;
  if (rh.provider === "gitea" && rh.gitea) return { owner: rh.gitea.owner, repo: rh.gitea.repo };
  return { owner: session.githubOwner, repo: session.githubName };
}

/**
 * Enqueue the bounded §11 comment for a review-dispute transition, if that
 * transition resolved or escalated anything.
 *
 * Everything policy-shaped is decided in `review-dispute-publication.ts` (which
 * lineages may be published, what a body may contain, what the idempotency key
 * is keyed on); this function only addresses the result and hands it to the
 * outbox. That split is deliberate: the §11 rules are pure and testable without
 * a store, while the choice of provider/topic is a delivery detail that belongs
 * with the other effect builders.
 *
 * Delivery is PR-first. When the task has a current PR the comment lands there,
 * as a Tier 2 public repo-host comment; otherwise it lands on the work item,
 * routed through the session's configured provider exactly like every other
 * `gh:comment` enqueue here. Only one of the two ever receives it, so a lineage
 * resolution is never announced twice in different words.
 *
 * The whole builder is a no-op unless the session actually enabled the protocol:
 * a session with `reviewDispute.enabled: false` never produces a transition to
 * publish, and gating here as well keeps a stray application (a legacy task
 * carrying a block written while the flag was on, say) from publishing under a
 * configuration that has since turned the protocol off.
 */
export async function enqueueDisputeOutcomeEffects(
  outboxStore: OutboxStore,
  session: ResolvedSession,
  task: AiTask,
  application: DisputeTransitionApplication | undefined,
  now: string,
  prUrlOverride?: string,
): Promise<void> {
  if (session.reviewDispute?.enabled !== true) return;
  if (application === undefined) return;

  const outcomes = publishableDisputeOutcomes(application);
  if (outcomes.length === 0) return;

  const body = renderDisputeOutcomeComment(outcomes);
  const target = disputePublicationTarget(task, prUrlOverride);
  const configuredPaths = sessionRedactionPaths(session);

  if (target.kind === "pr") {
    // One comment carrying every lineage this delivery resolved, rather than one
    // per lineage: the §11 fields are per-lineage, but a run that resolves three
    // findings at once has produced ONE outcome for the reader, and three
    // comments would be exactly the public noise the policy bounds. The
    // idempotency key still names a single lineage — the first, in the sorted
    // order the projection fixes — so a re-derived completion dedupes against
    // itself while a later delivery resolving a different lineage does not.
    const prTarget = repoHostCommentTarget(session);
    await enqueueRepoHostPrComment(outboxStore, {
      provider: session.repoHostProvider.provider,
      owner: prTarget.owner,
      repo: prTarget.repo,
      prNumber: target.prNumber,
      idempotencyKey: disputeOutcomeIdempotencyKey({
        sessionId: session.sessionId,
        issueNumber: task.issueNumber,
        surface: "pr",
        outcome: outcomes[0],
      }),
      body,
      configuredPaths,
      now,
    });
    return;
  }

  // No PR yet — the work item is the fallback surface. Routed through
  // `workItemOutbox` so a non-GitHub work-item provider receives a
  // `workitem:comment` row instead of a `gh:comment` the dispatcher's GitHub
  // runner would fail forever.
  const workItemStore = workItemOutbox(outboxStore, session);
  await workItemStore.enqueue({
    idempotencyKey: disputeOutcomeIdempotencyKey({
      sessionId: session.sessionId,
      issueNumber: task.issueNumber,
      surface: "work-item",
      outcome: outcomes[0],
    }),
    topic: "gh:comment",
    payload: {
      topic: "gh:comment",
      owner: session.githubOwner,
      repo: session.githubName,
      issueNumber: target.issueNumber,
      body: sanitizeBody(body, configuredPaths),
    },
    now,
  });
}

// ---------------------------------------------------------------------------
// Terminal refinement handoffs (issue #936, §13 items 3–4)
// ---------------------------------------------------------------------------

/**
 * Enqueue the public half of a terminal refinement handoff: the session's
 * ready-for-human label, then one bounded comment carrying the handoff reason.
 *
 * This is the ONLY effect the refinement lane enqueues. §13 is explicit that
 * everything else about the lane stays local until the application walk performs
 * its own writes through the apply port, and the phase runner keeps the generic
 * completion builders (handler comment, coarse status labels, PR summary,
 * human-gate summary) off this phase for exactly that reason. A handoff is the
 * one refinement outcome with an operator on the other end of it, and before
 * this builder existed that operator had no GitHub-side signal at all — the
 * Issue kept only `status:needs-refinement` and looked, from GitHub, like a task
 * still waiting its turn (issue #936).
 *
 * Three properties are load-bearing:
 *
 *  - **Same transaction as the transition.** Both effects are collected into the
 *    completion the block rides in, so a handoff cannot commit without its
 *    publication being durable alongside it (issue #701's transactional-outbox
 *    guarantee).
 *  - **No marker removal, no executable status.** §13 item 2: the coarse marker
 *    is deliberately left where it is, and adding `status:needs-implementation`
 *    beside it would produce the both-markers combination §3 refuses. This
 *    builder therefore only ever ADDS the ready-for-human label.
 *  - **Retry-safe by key, not by luck.** Both keys are run-independent
 *    (`refinementHandoffIdempotencyKey`), so a phase re-run after a lost CAS
 *    re-derives the same two rows and the outbox dedupes them. A dispatch
 *    failure leaves a visible pending/delayed/dead row for `admin outbox list`,
 *    which §13 prefers over a silently omitted notice: the handoff itself
 *    already stands on its local record.
 *
 * Routed through {@link workItemOutbox} like every other work-item effect, so a
 * non-GitHub work-item session publishes to its own tracker rather than
 * stranding a `gh:*` row behind a failing GitHub runner.
 */
export async function enqueueRefinementHandoffEffects(
  outboxStore: OutboxStore,
  session: ResolvedSession,
  task: Pick<AiTask, "issueNumber">,
  /**
   * The context patch this completion is PERSISTING, not the task's stored
   * context: the publication gate is "escalated in this delivery", so a claimed
   * task that was already `escalated_human` before the run — the loop's
   * `refused` path — must not re-announce a handoff an earlier run published.
   */
  context: Record<string, unknown> | undefined,
  now: string,
): Promise<void> {
  const publication = publishableRefinementHandoffFromContext(task.issueNumber, context);
  if (publication === null) return;

  const workItemStore = workItemOutbox(outboxStore, session);
  const owner = session.githubOwner;
  const repo = session.githubName;

  // §13 item 3, before item 4: the label is the cheap, structured signal an
  // operator's saved search keys on, so it is enqueued first and does not wait
  // behind the comment if only one of the two can be dispatched.
  const readyForHumanLabel = session.labels["readyForHuman"] as string | undefined;
  if (readyForHumanLabel) {
    await workItemStore.enqueue({
      idempotencyKey: refinementHandoffIdempotencyKey({
        sessionId: session.sessionId,
        issueNumber: task.issueNumber,
        reason: publication.reason,
        effect: "label",
      }),
      topic: "gh:label:add",
      payload: {
        topic: "gh:label:add",
        owner,
        repo,
        issueNumber: task.issueNumber,
        label: readyForHumanLabel,
      },
      now,
    });
  }

  // §13 item 4. `sanitizeBody` is defence in depth rather than the bound: the
  // rendered body is built from literals and counters only (§16), so there is
  // nothing here for it to redact unless a session configured an agent id or
  // model that looks like a path.
  //
  // `dedupeMarker` carries §16's "never two" past the durable row and into the
  // delivery itself: the idempotency key stops a second ROW, but a dispatcher
  // that posted this comment and then lost its claim before `markSent` leaves
  // the first row pending, and the retry would post a second copy. The marker is
  // the first line of the rendered body, so a delivery that landed is
  // recognisable on the Issue itself (see `refinementHandoffCommentMarker`).
  const commentKey = refinementHandoffIdempotencyKey({
    sessionId: session.sessionId,
    issueNumber: task.issueNumber,
    reason: publication.reason,
    effect: "comment",
  });
  const marker = refinementHandoffCommentMarker(commentKey);
  await workItemStore.enqueue({
    idempotencyKey: commentKey,
    topic: "gh:comment",
    payload: {
      topic: "gh:comment",
      owner,
      repo,
      issueNumber: task.issueNumber,
      body: sanitizeBody(renderRefinementHandoffComment(publication, marker), sessionRedactionPaths(session)),
      dedupeMarker: marker,
    },
    now,
  });
}

/**
 * Record §12 row 46 — the handoff comment proved undeliverable — against the
 * task that raised the handoff. Returns whether an event was written.
 *
 * §13 is explicit that a handoff whose comment cannot be delivered still stands,
 * and that no replacement comment is attempted. What it must NOT be is silent:
 * the dead-lettered outbox row is the only trace that the Issue was supposed to
 * carry a notice, and an operator reading the task — `admin task-status`, the
 * event stream — would otherwise see a `ready_for_human` refinement task whose
 * public half simply never appeared, with nothing saying so. §15 names
 * `refinement.handoff.comment.undeliverable` for exactly this, and it is the one
 * refinement event no §12 state row can emit, because the delivery fails long
 * after the transition committed.
 *
 * Called from the two places a row reaches a terminal delivery state: the
 * dispatcher, when `markFailed` exhausts the retry budget, and `admin outbox
 * cancel`, when an operator retires the row by hand — plus the repair sweep
 * below. It is deliberately at-most-once per row: a later `outbox retry` that
 * dead-letters the row a second time records nothing new, because the fact
 * ("this comment could not be delivered") has not changed. The event carries
 * literals only (§15) — never the provider error text, which is already on the
 * outbox row and may name a host or a path.
 *
 * "At most once" is the store's guarantee, not this function's: none of those
 * callers holds a task transaction, and two of them run in separate processes —
 * an `outbox cancel` can land in the middle of a drain's repair sweep, and two
 * drains can overlap. A read of the event list followed by an append would let
 * both observe an empty history and both write (issue #936 review, P2), so the
 * check and the write are handed to `appendEventOnce` as one atomic operation,
 * keyed on the row's idempotency key — the identity of the effect that failed.
 */
export async function recordRefinementHandoffCommentUndeliverable(
  store: Pick<TaskStore, "getTask" | "appendEventOnce">,
  entry: Pick<OutboxEntry, "idempotencyKey">,
  disposition: "dead_lettered" | "cancelled",
  now: string,
): Promise<boolean> {
  const target = refinementHandoffEffectFromKey(entry.idempotencyKey);
  // Only the comment: the label add of §13 item 3 has no row-46 counterpart —
  // it publishes no text an operator would go looking for — and every other
  // outbox row belongs to some other lane entirely.
  if (target === null || target.effect !== "comment") return false;

  const key: TaskKey = { sessionId: target.sessionId, issueNumber: target.issueNumber };
  // A task that no longer exists (retention, an operator `task cancel` that
  // disposed the row) has nothing to append to; the outbox row itself remains
  // the record.
  const task = await store.getTask(key);
  if (!task) return false;

  // `idempotencyKey` is both the event's own field and its uniqueness key, so
  // the record and the thing that makes it unrepeatable cannot drift apart. A
  // task with several handoff comments across its life (different reasons, so
  // different keys) still records each one exactly once.
  return await store.appendEventOnce(
    {
      task: key,
      type: REFINEMENT_HANDOFF_COMMENT_UNDELIVERABLE_EVENT,
      data: {
        issueNumber: target.issueNumber,
        refinementState: "escalated_human",
        handoffReason: target.reason,
        disposition,
        idempotencyKey: entry.idempotencyKey,
      },
      createdAt: now,
    },
    { field: "idempotencyKey", value: entry.idempotencyKey },
  );
}

/**
 * Whether an outbox row is a terminal handoff COMMENT row — one that
 * {@link recordRefinementHandoffCommentUndeliverable} would write an event for
 * if the event is not already there.
 *
 * Split out so a caller can decide whether any repair work exists at all before
 * opening a task store: an ordinary drain, where nothing is dead-lettered and
 * nothing belongs to this lane, must keep touching exactly the tables it did
 * before (P2 review follow-up to issue #936).
 */
export function isUnpublishedRefinementHandoffComment(
  entry: Pick<OutboxEntry, "idempotencyKey" | "sentAt" | "deadLetterAt">,
): boolean {
  if (entry.sentAt !== undefined) return false;
  if (entry.deadLetterAt === undefined) return false;
  return refinementHandoffEffectFromKey(entry.idempotencyKey)?.effect === "comment";
}

/**
 * Re-derive §12 row 46 for every terminal handoff comment row that is missing
 * it, and record what is missing.
 *
 * The dead-letter itself is the durable fact; the audit event is a second write
 * against a different table, and the two cannot be made atomic — the row is
 * dead-lettered by the dispatcher (or cancelled by an operator) and the event is
 * appended after, outside any shared transaction. So the write that follows can
 * fail on its own: a busy SQLite file, a crash between the two, a `cancel` whose
 * append raised after `cancelEntry` committed. Each of those would otherwise
 * lose the record permanently, because a dead-lettered row is never selected for
 * dispatch again and so its one-shot hook never fires again (P2 review
 * follow-up).
 *
 * This is the repair: the rows themselves ARE the durable repair record. They
 * stay listable (`listUnsent`) until pruned, they carry the idempotency key the
 * event is derived from, and `cancelledAt` still says which disposition it was —
 * so any later run can reconstruct exactly the event the failed one owed, with
 * no extra state to persist. Called on every dispatch run; per-row recording is
 * atomically at-most-once (see `recordRefinementHandoffCommentUndeliverable`),
 * so a repaired row is a no-op from then on — including when two overlapping
 * sweeps, or a sweep and an `outbox cancel`, repair the same row at once.
 *
 * One row's failure does not stop the sweep: the failures are returned so the
 * caller can report them, and the rows they belong to are simply repaired by a
 * later run.
 */
export async function repairRefinementHandoffCommentUndeliverable(
  store: Pick<TaskStore, "getTask" | "appendEventOnce">,
  entries: readonly Pick<OutboxEntry, "id" | "idempotencyKey" | "sentAt" | "deadLetterAt" | "cancelledAt">[],
  now: string,
): Promise<{ recorded: number; errors: { id: number; error: string }[] }> {
  let recorded = 0;
  const errors: { id: number; error: string }[] = [];
  for (const entry of entries) {
    if (!isUnpublishedRefinementHandoffComment(entry)) continue;
    try {
      // A cancelled row is dead-lettered too, so the disposition is read from
      // `cancelledAt` rather than from how this sweep found the row: an operator
      // decision and an exhausted retry budget are different facts to an
      // operator reading the event back.
      const disposition = entry.cancelledAt !== undefined ? "cancelled" : "dead_lettered";
      if (await recordRefinementHandoffCommentUndeliverable(store, entry, disposition, now)) recorded++;
    } catch (err) {
      errors.push({
        id: entry.id,
        error: `handoff audit record failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return { recorded, errors };
}
