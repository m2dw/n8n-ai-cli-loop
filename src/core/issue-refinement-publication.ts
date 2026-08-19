/**
 * Issue #936: the PUBLIC half of a terminal refinement handoff
 * (docs/issue-refinement-contract.md §13 items 3–4, §16).
 *
 * §13 says a handoff does four things. Three of them are local and
 * transactional — status `ready_for_human`, the persisted `handoffReason`, and
 * the `refinement.escalated.human` audit event — and the loop and the apply
 * walk already do all three. The fourth is public: the session's ready-for-human
 * label, plus exactly one comment carrying the handoff reason literal and the
 * §16 fields. Without it a stopped lane is discoverable only through
 * `admin task-status`, which is what the #697 pilot actually hit: task
 * `ready_for_human` / `escalated_human` / `agent_unavailable`, and an Issue
 * still showing nothing but `status:needs-refinement`.
 *
 * This module is the projection that decides what leaves the loop, and — like
 * the review-dispute publication it is modelled on — it is deliberately a
 * projection rather than a reader:
 *
 *  - WHEN. {@link publishableRefinementHandoff} publishes only for a block that
 *    reached `escalated_human` with a recognised handoff reason **in this
 *    delivery**. Every non-terminal outcome (a hold, an agent retry below the
 *    cap, a stale restart, a row-22 commit point) and the `activated` terminal
 *    state contribute nothing, so no intermediate state is announced.
 *  - WHAT. The body is rendered from a {@link RefinementHandoffPublication},
 *    whose fields are literals, counters, and configured agent/model/effort
 *    identifiers. Refined prose, agent reasoning, provider error text, snapshot
 *    excerpts, artifact and worktree paths, and run/session/task identifiers are
 *    not filtered out of the body — none of them is reachable from the value
 *    being rendered (§16). The run id in particular is deliberately absent: §16
 *    forbids run identifiers, so "run metadata" here means the resolved role
 *    metadata (agent id, provider, model, effort), which is configuration, not a
 *    correlation id.
 *
 * The label and the comment are enqueued as ordinary outbox effects in the same
 * durable transition as the block (see `enqueueRefinementHandoffEffects`), so a
 * dispatch failure leaves a visible pending/delayed/dead row for
 * `admin outbox list` rather than silently dropping the handoff notice. §13's
 * "the handoff stands even when its comment cannot be delivered" is exactly that
 * shape: the local half is already committed, and the public half retries on its
 * own budget.
 */

import { createHash } from "crypto";

import type {
  IssueRefinementLimits,
  RefinementContextBlock,
  RefinementCounters,
  RefinementHandoffReason,
} from "./issue-refinement.js";
import {
  DEFAULT_REFINEMENT_MARKER_LABEL,
  ISSUE_REFINEMENT_DEFAULT_LIMITS,
  ISSUE_REFINEMENT_LIMIT_KEYS,
  isRefinementHandoffReason,
  readRefinementContextBlock,
} from "./issue-refinement.js";
import type { RefinementLoopContextBlock, RefinementRoleRunRecord } from "./issue-refinement-loop.js";

/**
 * The maximum size of a rendered handoff comment.
 *
 * Every field is already a literal or a counter, so this is a backstop rather
 * than the primary bound: a session that configures an absurd agent/model name
 * still cannot publish an unbounded comment.
 */
export const MAX_HANDOFF_COMMENT_CHARS = 4000;

/** Longest single literal (agent id, model, effort) rendered into a cell. */
const MAX_LITERAL_CHARS = 80;

/**
 * Marks the lane that posted a comment, for humans and for future scans.
 *
 * Deliberately NOT under `REFINEMENT_COMMENT_MARKER_PREFIX`
 * (`<!-- ai-refinement:comment fingerprint=…`): the application walk scans Issue
 * comments for that prefix to decide whether its own §11 step-4 audit comment
 * already landed, and a handoff comment answering to that scan would make an
 * apply run believe it had already published.
 */
export const REFINEMENT_HANDOFF_MARKER = "<!-- ai-refinement:handoff -->";

/**
 * §15's event for a handoff whose public comment could not be delivered (§12 row
 * 46). The one refinement event that belongs to no §12 state row: the delivery
 * fails long after the transition committed, so nothing in the state machine is
 * still running to emit it.
 */
export const REFINEMENT_HANDOFF_COMMENT_UNDELIVERABLE_EVENT =
  "refinement.handoff.comment.undeliverable";

/**
 * The DELIVERY-side idempotency marker of one handoff comment.
 *
 * The outbox idempotency key deduplicates the durable row; it says nothing about
 * the external comment. A dispatcher that posts the comment and then loses its
 * claim — a crash, a lease expiry mid-call, an operator `outbox retry` on a row
 * whose delivery actually landed — leaves the same pending row for a later
 * attempt, and a second attempt that just posts would publish a second copy of
 * a handoff §16 caps at one. The marker closes that window from the outside: the
 * dispatcher looks for it on the Issue and treats a comment already carrying it
 * as this row's own delivery (see `hasItemCommentWithMarker`).
 *
 * It is derived from the row's idempotency key rather than being the fixed
 * {@link REFINEMENT_HANDOFF_MARKER}, so it identifies THIS handoff: a later
 * handoff on the same Issue for a different reason carries a different marker
 * and is not swallowed by the first one's comment. The key is hashed rather than
 * embedded because it carries the session id, which §16 never publishes.
 *
 * This is a delivery precondition, not an authentication. A commenter who could
 * guess the digest could pre-empt the notice, the same exposure the §11 step-4
 * audit comment answers with a persisted random nonce; there is no such nonce
 * here, because a handoff must be publishable from a completion that persists
 * nothing but the block itself. The failure mode is a suppressed notice on an
 * Issue an attacker already writes to, against a duplicate the contract forbids
 * outright — and the handoff's local record (status, reason, audit event) is
 * unaffected either way.
 */
export function refinementHandoffCommentMarker(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16);
  return `<!-- ai-refinement:handoff key=${digest} -->`;
}

/**
 * The next operator action per handoff reason (§13).
 *
 * Every entry names something an operator can actually do today: inspect a
 * surface that exists, change a label, change session config, or edit the Issue.
 * None of them names `admin refinement recover`, which §13 specifies but which
 * this build does not implement yet — publishing a command that does not exist
 * would send the reader in a circle, and so would "re-run refinement", which no
 * supported command can do from a terminal state. Each entry therefore covers
 * only what is specific to its reason; how to leave the state at all is stated
 * once, in the shared footer of the rendered comment.
 */
export const REFINEMENT_HANDOFF_NEXT_ACTIONS: Record<RefinementHandoffReason, string> = {
  fan_in_exceeded:
    "This Issue has more predecessors than the refinement lane will read. Reduce its `blocked by` set, or split the Issue.",
  chain_disagreement:
    "The Issue's live dependency edges disagree with its accepted chain revision. Reconcile them with `admin chain show` and `admin chain sync`.",
  not_chain_scoped:
    "This Issue is not registered in a chain, so the lane has no accepted topology to refine against. Register it (`admin chain new` / `admin chain append`), or refine the Issue by hand.",
  malformed_refiner_output:
    "The refiner agent returned unusable output up to its attempt cap. Correct the agent's configuration, or refine the Issue by hand.",
  malformed_critic_output:
    "The critic agent returned unusable output up to its attempt cap. Correct the agent's configuration, or refine the Issue by hand.",
  topology_change_required:
    "Both agents asked for a blocking topology change (a split, or a dependency edit). Apply it by hand — this lane never rewrites topology itself.",
  no_convergence:
    "The refiner and the critic did not converge within the round cap. Refine the Issue by hand, or raise `issueRefinement.limits.maxRefinementRoundsPerIssue`.",
  critique_blocked:
    "The critic blocked the draft outright. Read the recorded objections with `admin task-status --issue-number <n> --verbose` and address them in the Issue.",
  stale_inputs:
    "The Issue or one of its predecessors changed while the lane was running. Re-check the inputs before the lane runs again.",
  unexpected_managed_region:
    "The Issue body already carries a managed refinement region this lane did not write. Remove or reconcile that region.",
  malformed_managed_region:
    "The managed refinement region in the Issue body is malformed (its marker pair does not parse). Repair or remove the region.",
  managed_region_modified:
    "The managed refinement region was edited outside the lane. Keep the edit and remove the markers, or restore the region.",
  no_independent_critic:
    "No independent critic could be resolved: the lane needs a second agent that is not the refiner. Configure `issueRefinement.agents.critic`, or opt into `allowSameProvider`.",
  effect_undeliverable:
    "A GitHub write for this Issue exhausted its retry budget. Inspect it with `admin outbox list` and recover it with `admin outbox retry --id <n>`.",
  agent_unavailable:
    "The refinement agent could not be run (quota, timeout, or a missing CLI). Check it with `admin session-doctor` and restore the agent.",
  marker_precondition_failed:
    "The label transition did not land as expected, so the Issue's labels no longer match what the lane assumed. Restore them: the refinement marker present, and no executable `status:*` label beside it.",
  execution_marker_conflict:
    "The refinement marker was applied to an Issue that was already executing another phase. Remove one of the two markers so the Issue routes to exactly one lane.",
};

/**
 * One role's published metadata: configuration literals only, never a run id.
 *
 * `agentId` and `provider` are typed as plain strings rather than as the `AgentId`
 * union they were written from. The record they are read back out of is persisted
 * task context: an older build, a hand-edited block, or a session whose agent set
 * has since changed can present anything at all there, and a value that is not a
 * current `AgentId` is still the honest answer to "which agent did this attempt
 * resolve". {@link publishedRole} guarantees only what the renderer actually
 * needs — that both are non-empty strings.
 */
export interface RefinementHandoffRole {
  agentId: string;
  provider: string;
  model: string | null;
  effort: string | null;
  invocations: number;
}

/**
 * Everything §16 permits a handoff comment to carry, and nothing else.
 *
 * The type IS the redaction boundary: a field that does not exist here cannot
 * be rendered, so no later edit to the renderer can leak prose, a path, or a
 * correlation id into a public comment by accident.
 */
export interface RefinementHandoffPublication {
  issueNumber: number;
  /** The lane phase this handoff stopped in — always `refinement`. */
  phase: "refinement";
  /** The terminal §1 state literal. */
  state: "escalated_human";
  reason: RefinementHandoffReason;
  counters: RefinementCounters;
  limits: IssueRefinementLimits;
  refiner: RefinementHandoffRole | null;
  critic: RefinementHandoffRole | null;
  /** §13 item 2: whether the coarse marker is expected to still be on the Issue. */
  markerLabel: string;
  markerRetained: boolean;
}

/**
 * The four reasons that can be raised AFTER §11 step 5 already removed the
 * marker (§13, "A handoff raised after the marker removal landed cannot leave
 * the marker in place, and says so"). For these the comment must not claim the
 * marker is still there — it may not be, and telling an operator otherwise
 * would send them to the recovery path with the wrong precondition.
 */
const MARKER_MAY_BE_GONE: ReadonlySet<RefinementHandoffReason> = new Set<RefinementHandoffReason>([
  "marker_precondition_failed",
  "stale_inputs",
  "managed_region_modified",
  "effect_undeliverable",
]);

/**
 * One published literal, or `null` when the persisted field is not one.
 *
 * The §15 execution record is typed, but it is READ back out of persisted task
 * context, and `readRefinementContextBlock` accepts any block carrying a
 * recognised `state` — so `execution.refiner` can be `{}`, or carry a number, a
 * nested object, or an empty string where a literal belongs (an older build, a
 * hand-edited block, a partially-written record). The renderer calls
 * `String.prototype.replace` on these values, so an unchecked non-string field
 * throws — inside the completion transaction, abandoning a terminal handoff that
 * was otherwise ready to commit and leaving the task `running` with no audit
 * trail. Same defensive posture as {@link publishedCounters}, for the same
 * reason.
 */
function literal(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * One role's published metadata, or `null` when the record names no agent.
 *
 * A record whose `agentId` is missing or malformed identifies nothing an
 * operator could act on, so it publishes as "not resolved" rather than as a
 * half-rendered row — the same reading an absent record gets. A record that DOES
 * name an agent still publishes when its other fields are malformed: which agent
 * ran is the field the reader needs, and `provider` falls back to the explicit
 * `unknown` literal rather than silently claiming a provider the block never
 * recorded.
 */
function publishedRole(record: RefinementRoleRunRecord | null | undefined): RefinementHandoffRole | null {
  if (!record || typeof record !== "object") return null;
  const agentId = literal(record.agentId);
  if (agentId === null) return null;
  return {
    agentId,
    provider: literal(record.provider) ?? "unknown",
    model: literal(record.model),
    effort: literal(record.effort),
    invocations: count(record.invocations),
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Counters and limits, read DEFENSIVELY.
 *
 * `readRefinementContextBlock` is tolerant by design — it accepts any object
 * carrying a recognised `state` — so a block written by an older build, or
 * hand-edited by an operator, can reach the renderer without the §8 sub-records.
 * A missing counter must not throw here: this builder runs inside the completion
 * transaction, and throwing would abandon a handoff that is otherwise ready to
 * commit. Zeroes are the honest reading of "the block does not record this".
 */
function publishedCounters(block: RefinementContextBlock): RefinementCounters {
  const c = block.counters as Partial<RefinementCounters> | undefined;
  return {
    rounds: count(c?.rounds),
    malformedAttempts: {
      refiner: count(c?.malformedAttempts?.refiner),
      critic: count(c?.malformedAttempts?.critic),
    },
    agentFailures: {
      refiner: count(c?.agentFailures?.refiner),
      critic: count(c?.agentFailures?.critic),
    },
    staleRestarts: count(c?.staleRestarts),
  };
}

/**
 * The handoff this delivery may publish, or `null`.
 *
 * Callers pass the block the completing run is PERSISTING (its context patch),
 * not the task's current block: a claimed task whose block was already
 * `escalated_human` before this run — the loop's `refused` path — announces
 * nothing, because it escalated (and published) on an earlier run.
 *
 * A block carrying `escalated_human` with no recognised handoff reason is not
 * published either. It cannot be rendered without inventing a reason literal,
 * and the local half of the handoff (status, event, persisted state) still
 * stands on its own.
 */
export function publishableRefinementHandoff(
  issueNumber: number,
  block: RefinementContextBlock | RefinementLoopContextBlock | undefined,
): RefinementHandoffPublication | null {
  if (!block || block.state !== "escalated_human") return null;
  const reason = block.handoffReason;
  if (!isRefinementHandoffReason(reason)) return null;
  const execution = (block as RefinementLoopContextBlock).execution;
  const limits = (block.limits ?? {}) as Partial<IssueRefinementLimits>;
  return {
    issueNumber,
    phase: "refinement",
    state: "escalated_human",
    reason,
    counters: publishedCounters(block),
    limits: ISSUE_REFINEMENT_LIMIT_KEYS.reduce((acc, key) => {
      // A configured `0` is meaningful for three of the §8 limits (the stale
      // restart, the comment window, the process-failure retry are simply
      // unavailable at 0), so only an ABSENT limit falls back to the default.
      const configured = limits[key];
      acc[key] = typeof configured === "number" && Number.isFinite(configured)
        ? configured
        : ISSUE_REFINEMENT_DEFAULT_LIMITS[key];
      return acc;
    }, {} as IssueRefinementLimits),
    refiner: publishedRole(execution?.refiner),
    critic: publishedRole(execution?.critic),
    markerLabel:
      typeof block.markerLabel === "string" && block.markerLabel.length > 0
        ? block.markerLabel
        : DEFAULT_REFINEMENT_MARKER_LABEL,
    markerRetained: !MARKER_MAY_BE_GONE.has(reason),
  };
}

/** The publication for a completing task's context patch, or `null`. */
export function publishableRefinementHandoffFromContext(
  issueNumber: number,
  context: Record<string, unknown> | undefined,
): RefinementHandoffPublication | null {
  return publishableRefinementHandoff(issueNumber, readRefinementContextBlock(context));
}

/**
 * The literal that marks an idempotency key as a handoff effect's, and the only
 * thing {@link refinementHandoffEffectFromKey} recognises a row by. Shared by the
 * builder and the parser so the two can never drift apart.
 */
const REFINEMENT_HANDOFF_KEY_TOKEN = "refinement-handoff";

/**
 * The handoff effect an outbox row's idempotency key belongs to, or `null`.
 *
 * The reverse of {@link refinementHandoffIdempotencyKey}, and the only way a
 * dispatcher — which sees rows, not tasks — can tell that the row it just
 * dead-lettered was a handoff's public half and record §12 row 46 against the
 * task that raised it. Parsed from the RIGHT: every field after the session id
 * is a closed literal, while the session id itself is operator-chosen and may
 * contain the separator, so a left-to-right split would misread it.
 *
 * Every component is validated (a recognised reason, a positive integer Issue
 * number, a known effect, a non-empty session id) — an unrecognised key is not
 * this lane's row and must not have an event written against some other task.
 */
export function refinementHandoffEffectFromKey(idempotencyKey: string): {
  sessionId: string;
  issueNumber: number;
  reason: RefinementHandoffReason;
  effect: "comment" | "label";
} | null {
  const parts = idempotencyKey.split(":");
  if (parts.length < 5) return null;
  const rawEffect = parts[parts.length - 1];
  const reason = parts[parts.length - 2];
  const token = parts[parts.length - 3];
  const issue = parts[parts.length - 4];
  const sessionId = parts.slice(0, parts.length - 4).join(":");
  if (token !== REFINEMENT_HANDOFF_KEY_TOKEN) return null;
  const effect: "comment" | "label" | null =
    rawEffect === "comment" ? "comment" : rawEffect === "label" ? "label" : null;
  if (effect === null) return null;
  if (!isRefinementHandoffReason(reason)) return null;
  if (sessionId.length === 0) return null;
  const issueNumber = Number(issue);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return null;
  return { sessionId, issueNumber, reason, effect };
}

/**
 * The idempotency key of a handoff effect.
 *
 * Keyed on the session, the Issue, the handoff reason, and which effect it is —
 * never on the run id. A phase whose completion CAS is lost re-runs and
 * re-derives the same escalation (issue #701 relies on exactly that), and a
 * run-scoped key would publish the same handoff a second time. §13's "exactly
 * one comment per handoff" is enforced here, at the outbox, rather than by
 * hoping the phase never retries.
 *
 * The reason is part of the key rather than a bare `refinement-handoff` literal
 * so that a *different* handoff — a later attempt that stopped for a different
 * cause — is still published instead of being swallowed by the first one's key.
 *
 * What the key deliberately does NOT distinguish is a second attempt that
 * stopped for the SAME reason. Today that is unreachable: nothing leaves
 * `escalated_human` automatically (§13), and the recovery command that would
 * return the block to `pending` is specified but not implemented here — so two
 * same-reason handoffs on one Issue cannot occur. When recovery lands it must
 * fold its own attempt discriminator into this key, or the retried attempt's
 * handoff will dedupe against the comment the first one already posted.
 */
export function refinementHandoffIdempotencyKey(input: {
  sessionId: string;
  issueNumber: number;
  reason: RefinementHandoffReason;
  effect: "comment" | "label";
}): string {
  return [
    input.sessionId,
    String(input.issueNumber),
    REFINEMENT_HANDOFF_KEY_TOKEN,
    input.reason,
    input.effect,
  ].join(":");
}

/**
 * Bound and flatten one literal for a markdown table cell.
 *
 * Not a sanitizer: every value reaching this point is a closed-set literal or a
 * configured identifier. It only keeps a newline or a pipe from breaking the
 * table, and caps a pathological config value. Path and secret redaction is the
 * visibility layer's, applied to the whole body on the way into the outbox.
 */
function cell(value: string): string {
  const flat = value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").replace(/`/g, "'");
  return flat.length > MAX_LITERAL_CHARS ? `${flat.slice(0, MAX_LITERAL_CHARS - 1)}…` : flat;
}

function roleCell(role: RefinementHandoffRole | null): string {
  if (role === null) return "not resolved";
  const parts = [`\`${cell(role.agentId)}\``, `provider \`${cell(role.provider)}\``];
  if (role.model) parts.push(`model \`${cell(role.model)}\``);
  if (role.effort) parts.push(`effort \`${cell(role.effort)}\``);
  parts.push(`${role.invocations} invocation(s)`);
  return parts.join(", ");
}

/**
 * Render the §13/§16 handoff comment.
 *
 * A fixed table of literals and counts, one "next step" paragraph selected by
 * the reason, a sentence on where the marker stands, and the exit §13 gives an
 * operator today. There is no free-text section, no excerpt, and no link to
 * anything local; callers must not append to it.
 *
 * `marker` is the first line of the body and is what the delivery path matches
 * on ({@link refinementHandoffCommentMarker}). It defaults to the undiscriminated
 * {@link REFINEMENT_HANDOFF_MARKER} so the renderer stays usable on its own; the
 * enqueue path always passes the row's own marker, because a comment that does
 * not carry it cannot be recognised as already delivered.
 */
export function renderRefinementHandoffComment(
  publication: RefinementHandoffPublication,
  marker: string = REFINEMENT_HANDOFF_MARKER,
): string {
  const c = publication.counters;
  const l = publication.limits;
  const lines = [
    marker,
    "🛑 **Issue refinement stopped and needs a human.**",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Phase | \`${publication.phase}\` |`,
    `| Refinement state | \`${publication.state}\` |`,
    `| Handoff reason | \`${publication.reason}\` |`,
    `| Rounds used | ${c.rounds} / ${l.maxRefinementRoundsPerIssue} |`,
    `| Malformed output (refiner / critic) | ${c.malformedAttempts.refiner} / ${c.malformedAttempts.critic}`
      + ` (cap ${l.maxMalformedAttemptsPerRole}) |`,
    `| Agent process failures (refiner / critic) | ${c.agentFailures.refiner} / ${c.agentFailures.critic}`
      + ` (cap ${l.maxAgentFailuresPerRole}) |`,
    `| Stale restarts | ${c.staleRestarts} / ${l.maxStaleRestartsPerIssue} |`,
    `| Refiner | ${roleCell(publication.refiner)} |`,
    `| Critic | ${roleCell(publication.critic)} |`,
    "",
    `**Next step.** ${REFINEMENT_HANDOFF_NEXT_ACTIONS[publication.reason]}`,
    "",
    publication.markerRetained
      ? `\`${cell(publication.markerLabel)}\` is deliberately left in place and no executable \`status:*\` `
        + "label was added, so this Issue cannot drift into implementation while a human is deciding."
      : `This handoff was raised after the lane had already started moving labels, so \`${cell(publication.markerLabel)}\` `
        + "may no longer be on the Issue; check the current labels before acting. The task row itself still holds "
        + "the Issue out of implementation.",
    "",
    "**No automatic transition leaves this state.** To hand the Issue to implementation yourself: remove the "
      + "refinement marker **first**, then add `status:needs-implementation` (never both at once), and dispose of "
      + "this task row with `admin task cancel`. Refining the Issue again is an explicit operator recovery step "
      + "(§13 of the refinement contract) — nothing re-enters this lane on its own.",
  ];
  const body = lines.join("\n");
  return body.length > MAX_HANDOFF_COMMENT_CHARS
    ? `${body.slice(0, MAX_HANDOFF_COMMENT_CHARS - 1)}…`
    : body;
}
