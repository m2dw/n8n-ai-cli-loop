/**
 * Issue #976: the PUBLIC projection of a committed refinement progress
 * milestone (docs/issue-refinement-contract.md §15 progress milestones, §16).
 *
 * Issue #975 made refinement progress a persisted contract: eight bounded
 * boundaries, a deterministic `milestoneId`, a durable dedupe ledger, and a
 * commit that rides with the authoritative task transition. What it deliberately
 * did NOT do is publish any of it — so an Issue in refinement still showed a
 * human nothing between `status:needs-refinement` and whatever terminal notice
 * §13 eventually posted, and "where is this Issue now" remained an
 * `admin task-status` question.
 *
 * This module closes that gap and nothing else. It is a RENDERER over the #975
 * contract:
 *
 *  - **It consumes milestones, it does not derive them.** There is no second
 *    projection over the fine-grained `refinement.*` audit events here, and no
 *    state machine: a milestone that was committed gets a comment, and an event
 *    that produced no milestone (a poll, an eligibility hold, a predecessor
 *    wait, an unchanged retry check) has nothing to reach this module with.
 *  - **The type is the redaction boundary.** {@link RefinementProgressComment}
 *    carries only fields §16 permits. `sourceFingerprint` and
 *    `predecessorFingerprint` — both present on the milestone — are absent from
 *    it on purpose, so no later edit to the renderer can publish one by
 *    accident. Neither can a prompt, a transcript, an artifact path, or an
 *    absolute path: the milestone has no field one could have travelled in.
 *  - **It fails closed on anything it does not recognise.** A milestone from a
 *    newer `schemaVersion`, an unknown `kind`, or a `retry_scheduled` with no
 *    authoritative deadline is REFUSED with a diagnostic
 *    ({@link RefinementProgressCommentRefusal}) rather than guessed into a
 *    public comment. The refusal is recorded as a task event by the committing
 *    layer, so the gap is diagnosable instead of silent.
 *
 * Delivery, ordering, and idempotency belong to the outbox: one append-only
 * comment per milestone, keyed on the milestone id plus this projection's fixed
 * version (see {@link refinementProgressCommentIdempotencyKey}), enqueued in the
 * same transaction as the milestone it publishes.
 */

import { createHash } from "crypto";

import type {
  RefinementProgressMilestone,
  RefinementProgressMilestoneKind,
  RefinementProgressNextAction,
} from "./issue-refinement-progress.js";
import {
  REFINEMENT_PROGRESS_MILESTONE_KINDS,
  REFINEMENT_PROGRESS_NEXT_ACTIONS,
  REFINEMENT_PROGRESS_SCHEMA_VERSION,
} from "./issue-refinement-progress.js";

// ---------------------------------------------------------------------------
// Projection identity
// ---------------------------------------------------------------------------

/**
 * The literal that marks an outbox row as a progress comment's. Fixed, and part
 * of the dedupe key — never the wording, which is free to change without
 * re-publishing anything.
 */
export const REFINEMENT_PROGRESS_COMMENT_PROJECTION = "refinement-progress";

/**
 * The version of THIS projection — the comment, not the milestone.
 *
 * It is a separate number from `REFINEMENT_PROGRESS_SCHEMA_VERSION` because the
 * two version different things: the milestone contract versions what is
 * PERSISTED, this versions what is PUBLISHED. A future comment that must be
 * re-posted for milestones committed after the change bumps this; a change that
 * only rewords an existing comment must not, or every milestone committed after
 * the rewording would publish under a fresh key beside a comment that already
 * says the same thing.
 */
export const REFINEMENT_PROGRESS_COMMENT_VERSION = 1;

/**
 * The idempotency key of one milestone's comment.
 *
 * Derived from the session, the Issue, this projection's fixed
 * name/version, and the milestone's DETERMINISTIC id — and from nothing else.
 * No run id, no timestamp, no attempt-of-the-attempt, no rendered wording: the
 * whole point of #975's derived `milestoneId` is that a replayed phase
 * transition, a process restart, and a claim-loss recovery all recompute it
 * byte for byte, so a key built on it dedupes the second delivery at the outbox
 * without needing to know that a replay happened.
 *
 * The session id leads, as it does for every other work-item key in this
 * codebase, so one database serving several sessions cannot collide two Issues
 * that happen to share a number.
 */
export function refinementProgressCommentIdempotencyKey(input: {
  sessionId: string;
  issueNumber: number;
  milestoneId: string;
}): string {
  return [
    input.sessionId,
    String(input.issueNumber),
    REFINEMENT_PROGRESS_COMMENT_PROJECTION,
    `v${REFINEMENT_PROGRESS_COMMENT_VERSION}`,
    input.milestoneId,
  ].join(":");
}

/**
 * The undiscriminated marker every progress comment opens with. Useful to a
 * human reading the Issue and to a future scan; the DELIVERY-side check uses the
 * per-row marker below.
 */
export const REFINEMENT_PROGRESS_COMMENT_MARKER = "<!-- ai-refinement:progress -->";

/**
 * The delivery-side idempotency marker of one progress comment.
 *
 * The outbox key deduplicates the durable ROW; it says nothing about the
 * external comment. A dispatcher that posts and then loses its claim before
 * `markSent` — a crash, a lease expiry mid-call, an operator `outbox retry` on a
 * row whose POST actually landed — leaves the row for a later attempt, and a
 * second attempt that just posts appends a duplicate to an append-only history
 * that can never be edited back. The marker closes that window from the outside
 * (see `hasItemCommentWithMarker` in the dispatcher): a comment already carrying
 * it IS this row's delivery.
 *
 * Derived from the row's key — which is derived from the milestone id — so it
 * identifies THIS milestone and does not swallow the next one. Hashed rather
 * than embedded because the key carries the session id, which §16 never
 * publishes.
 */
export function refinementProgressCommentMarker(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16);
  return `<!-- ai-refinement:progress key=${digest} -->`;
}

// ---------------------------------------------------------------------------
// The publishable model
// ---------------------------------------------------------------------------

/**
 * The maximum size of a rendered progress comment.
 *
 * Every field is a closed-set literal, a counter, or a sanitized identifier
 * already bounded by #975, so this is a backstop and not the primary bound —
 * deliberately much smaller than the handoff comment's, because a progress note
 * is a line or two of structured facts and an Issue collects one per boundary.
 */
export const MAX_PROGRESS_COMMENT_CHARS = 1500;

/** Longest single literal (agent id, model, effort, state) rendered into a cell. */
const MAX_LITERAL_CHARS = 80;

/**
 * One role's published metadata: configuration literals only, never a run id.
 * Mirrors the handoff comment's rule (§16) — "run metadata" here means which
 * agent was configured to do the work, not which run did it.
 */
export interface RefinementProgressCommentAgent {
  agentId: string;
  provider: string;
  model: string | null;
  effort: string | null;
}

/**
 * Everything a progress comment may carry, and nothing else.
 *
 * Note what is NOT here: `sourceFingerprint`, `predecessorFingerprint`,
 * `milestoneId`, `occurredAt`, and `schemaVersion`. The fingerprints are §16's
 * explicit prohibition; the id and the schema version are internal correlation
 * data with no reader on GitHub (the comment's own position in the Issue is its
 * chronology, and the marker already carries the identity the delivery path
 * needs).
 */
export interface RefinementProgressComment {
  issueNumber: number;
  kind: RefinementProgressMilestoneKind;
  /** The refinement state literal at this boundary. */
  state: string;
  round: number | null;
  role: string | null;
  attempt: number | null;
  agent: RefinementProgressCommentAgent | null;
  durationMs: number | null;
  result: string | null;
  reason: string | null;
  failureClass: string | null;
  nextAction: RefinementProgressNextAction;
  /** Present exactly when the milestone is a `retry_scheduled`. */
  retryNotBefore: string | null;
  humanActionRequired: boolean;
}

/** Why a milestone could not be turned into a comment. Literals only. */
export interface RefinementProgressCommentRefusal {
  code:
    | "unsupported_schema_version"
    | "unknown_kind"
    | "missing_retry_deadline"
    | "malformed_milestone";
  /** An actionable, content-free diagnostic. Never carries milestone prose. */
  detail: string;
  /** The milestone's id when it had a usable one — the operator's handle on it. */
  milestoneId: string | null;
  issueNumber: number | null;
}

export type RefinementProgressCommentProjection =
  | { publishable: true; comment: RefinementProgressComment }
  | { publishable: false; refusal: RefinementProgressCommentRefusal };

/** ISO-8601 instant, as `leaseExpiry`/`toISOString` produce it. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function literal(value: unknown, maxChars = MAX_LITERAL_CHARS): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) return null;
  return trimmed;
}

function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function publishedAgent(milestone: RefinementProgressMilestone): RefinementProgressCommentAgent | null {
  const agent = milestone.agent;
  if (!agent || typeof agent !== "object") return null;
  const agentId = literal(agent.agentId);
  if (agentId === null) return null;
  return {
    agentId,
    provider: literal(agent.provider) ?? "unknown",
    model: literal(agent.model),
    effort: literal(agent.effort),
  };
}

/**
 * The comment a committed milestone publishes, or the refusal that says why it
 * publishes none.
 *
 * The three refusals are all "this producer knows something this renderer does
 * not", and every one of them fails CLOSED:
 *
 *  - a `schemaVersion` this build does not implement may have re-used a field
 *    for something else, so its values cannot be trusted into a public comment;
 *  - an unrecognised `kind` has no wording, and inventing one ("refinement
 *    reached a milestone") tells the reader strictly less than the silence plus
 *    the diagnostic does;
 *  - a `retry_scheduled` with no `retryNotBefore` cannot state the one fact the
 *    comment exists for — when the Issue wakes up — and #975 already drops such
 *    a milestone before commit, so reaching here means the contract was
 *    bypassed, not that the deadline is merely unknown.
 *
 * A milestone that is not an object, or that carries no usable id/Issue number,
 * is refused the same way: there is nothing to key a durable row on.
 */
export function publishableRefinementProgressComment(
  milestone: RefinementProgressMilestone,
): RefinementProgressCommentProjection {
  if (!milestone || typeof milestone !== "object") {
    return {
      publishable: false,
      refusal: {
        code: "malformed_milestone",
        detail: "progress milestone is not an object; nothing to publish or key a row on",
        milestoneId: null,
        issueNumber: null,
      },
    };
  }
  const milestoneId = literal(milestone.milestoneId, 128);
  const issueNumber =
    typeof milestone.issueNumber === "number" && Number.isInteger(milestone.issueNumber)
      && milestone.issueNumber > 0
      ? milestone.issueNumber
      : null;
  if (milestoneId === null || issueNumber === null) {
    return {
      publishable: false,
      refusal: {
        code: "malformed_milestone",
        detail:
          "progress milestone carries no usable milestoneId/issueNumber; "
          + "a comment for it could be neither addressed nor deduplicated",
        milestoneId,
        issueNumber,
      },
    };
  }
  if (milestone.schemaVersion !== REFINEMENT_PROGRESS_SCHEMA_VERSION) {
    return {
      publishable: false,
      refusal: {
        code: "unsupported_schema_version",
        detail:
          `progress milestone schemaVersion ${String(milestone.schemaVersion)} is not the `
          + `${REFINEMENT_PROGRESS_COMMENT_PROJECTION} v${REFINEMENT_PROGRESS_COMMENT_VERSION} `
          + `projection's supported version ${REFINEMENT_PROGRESS_SCHEMA_VERSION}; `
          + "upgrade the publisher or read the milestone with `admin task-status --verbose`",
        milestoneId,
        issueNumber,
      },
    };
  }
  if (!(REFINEMENT_PROGRESS_MILESTONE_KINDS as readonly string[]).includes(milestone.kind)) {
    return {
      publishable: false,
      refusal: {
        code: "unknown_kind",
        detail:
          `progress milestone kind is not one of the ${REFINEMENT_PROGRESS_MILESTONE_KINDS.length} `
          + "published boundaries; refusing to guess wording for it — read the milestone with "
          + "`admin task-status --verbose`",
        milestoneId,
        issueNumber,
      },
    };
  }
  const retryNotBefore = literal(milestone.retryNotBefore, 40);
  if (milestone.kind === "retry_scheduled" && (retryNotBefore === null || !ISO_INSTANT.test(retryNotBefore))) {
    return {
      publishable: false,
      refusal: {
        code: "missing_retry_deadline",
        detail:
          "retry_scheduled milestone carries no authoritative ISO-8601 retryNotBefore; "
          + "the committing layer must stamp the task notBefore it actually wrote",
        milestoneId,
        issueNumber,
      },
    };
  }
  // `nextAction` is a closed set on the milestone, but it is read back out of a
  // persisted event on some paths; an unrecognised value is dropped to the kind's
  // own default rather than published, and never refuses the whole comment —
  // "what happens next" is the least load-bearing line in the note.
  const nextAction = (REFINEMENT_PROGRESS_NEXT_ACTIONS as readonly string[]).includes(
    milestone.nextAction,
  )
    ? milestone.nextAction
    : DEFAULT_NEXT_ACTIONS[milestone.kind];
  return {
    publishable: true,
    comment: {
      issueNumber,
      kind: milestone.kind,
      state: literal(milestone.state) ?? "unknown",
      round: counter(milestone.round),
      role: literal(milestone.role, 24),
      attempt: counter(milestone.attempt),
      agent: publishedAgent(milestone),
      durationMs: counter(milestone.durationMs),
      result: literal(milestone.result, 40),
      reason: literal(milestone.reason, 40),
      failureClass: literal(milestone.failureClass, 40),
      nextAction,
      retryNotBefore: milestone.kind === "retry_scheduled" ? retryNotBefore : null,
      humanActionRequired: milestone.humanActionRequired === true,
    },
  };
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/**
 * The headline per boundary. Short, stable, and deliberately free of anything
 * the structured table below already states — a reader scanning an Issue's
 * comment history reads these eight lines as the story of the refinement.
 */
export const REFINEMENT_PROGRESS_COMMENT_HEADLINES: Record<
  RefinementProgressMilestoneKind,
  string
> = {
  started: "🔎 **Issue refinement started.**",
  refiner_completed: "✍️ **Refiner sub-turn completed.**",
  critic_completed: "🧐 **Critic sub-turn completed.**",
  retry_scheduled: "⏳ **Refinement retry scheduled.**",
  accepted: "🤝 **Refined Issue contract accepted.**",
  activated: "🚀 **Refinement applied — implementation activated.**",
  human_handoff: "🛑 **Refinement stopped and needs a human.**",
  failed: "🛑 **Refinement failed and needs a human.**",
};

/** What the lane is waiting for, in words, beside the machine-readable literal. */
export const REFINEMENT_PROGRESS_NEXT_ACTION_PHRASES: Record<
  RefinementProgressNextAction,
  string
> = {
  await_refiner: "waiting for the refiner",
  await_critic: "waiting for the critic",
  await_retry: "waiting for the scheduled retry",
  await_acceptance: "waiting for acceptance",
  await_application: "waiting to apply the accepted refinement",
  await_implementation: "waiting for implementation to pick the Issue up",
  await_human: "waiting for a human",
};

/**
 * The `nextAction` each boundary falls back to when the persisted one is not a
 * recognised literal. Every entry is what the lane can only be doing after that
 * boundary, so the fallback states a fact rather than a guess.
 */
const DEFAULT_NEXT_ACTIONS: Record<RefinementProgressMilestoneKind, RefinementProgressNextAction> = {
  started: "await_refiner",
  refiner_completed: "await_critic",
  critic_completed: "await_acceptance",
  retry_scheduled: "await_retry",
  accepted: "await_application",
  activated: "await_implementation",
  human_handoff: "await_human",
  failed: "await_human",
};

/**
 * Bound and flatten one literal for a markdown table cell.
 *
 * Not a sanitizer: every value reaching here is a closed-set literal or an
 * identifier #975 already validated character-by-character. It only keeps a
 * newline or a pipe from breaking the table. Path and secret redaction is the
 * visibility layer's, applied to the whole body on the way into the outbox.
 */
function cell(value: string): string {
  const flat = value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").replace(/`/g, "'");
  return flat.length > MAX_LITERAL_CHARS ? `${flat.slice(0, MAX_LITERAL_CHARS - 1)}…` : flat;
}

/** `1m 20s` / `4s`, or `null` when the milestone recorded no duration. */
function duration(ms: number | null): string | null {
  if (ms === null) return null;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function agentCell(agent: RefinementProgressCommentAgent): string {
  const parts = [`\`${cell(agent.agentId)}\``, `provider \`${cell(agent.provider)}\``];
  if (agent.model) parts.push(`model \`${cell(agent.model)}\``);
  if (agent.effort) parts.push(`effort \`${cell(agent.effort)}\``);
  return parts.join(", ");
}

/**
 * What "a human has to act" actually means at the two terminal boundaries.
 *
 * They are not the same fact and must not read as if they were. A
 * `human_handoff` is the lane stopping deliberately: §13 posts its own comment
 * carrying the reason literal and the supported next step, so this note points
 * at it rather than restating it. A `failed` is the phase transition itself
 * ending non-retryably — no handoff comment exists, and the row an operator
 * needs is the task's. A milestone that somehow flags human action at any other
 * boundary gets the sentence that is true of all of them and claims nothing
 * more.
 */
function humanActionSentence(kind: RefinementProgressMilestoneKind): string {
  if (kind === "human_handoff") {
    return "**Human action required.** Nothing in this lane leaves this state on its own; the "
      + "handoff comment on this Issue carries the reason and the supported next step.";
  }
  if (kind === "failed") {
    return "**Human action required.** The refinement phase ended non-retryably, so no automatic "
      + "retry follows. Inspect the task row with `admin task-status` before re-running the lane.";
  }
  return "**Human action required.** Refinement is not going to move this Issue further on its own.";
}

/**
 * Render one append-only progress comment.
 *
 * A headline, a table of exactly the rows the milestone actually carries, and —
 * for the two terminal boundaries — the sentence that says a human has to act.
 * An absent optional field contributes NO row: `undefined`, `null`, and invented
 * prose are all worse than the reader simply not seeing a line, which is the one
 * reading that is never wrong.
 *
 * There is no free-text section and no link to anything local, and callers must
 * not append to the returned body.
 */
export function renderRefinementProgressComment(
  comment: RefinementProgressComment,
  marker: string = REFINEMENT_PROGRESS_COMMENT_MARKER,
): string {
  const rows: string[] = [
    `| Milestone | \`${cell(comment.kind)}\` |`,
    `| Refinement state | \`${cell(comment.state)}\` |`,
  ];
  if (comment.round !== null) rows.push(`| Round | ${comment.round} |`);
  if (comment.role !== null) {
    rows.push(
      `| Role | \`${cell(comment.role)}\`${comment.attempt !== null ? ` (attempt ${comment.attempt})` : ""} |`,
    );
  } else if (comment.attempt !== null) {
    rows.push(`| Attempt | ${comment.attempt} |`);
  }
  if (comment.result !== null) rows.push(`| Result | \`${cell(comment.result)}\` |`);
  if (comment.reason !== null) rows.push(`| Reason | \`${cell(comment.reason)}\` |`);
  if (comment.failureClass !== null) rows.push(`| Failure class | \`${cell(comment.failureClass)}\` |`);
  if (comment.agent !== null) rows.push(`| Agent | ${agentCell(comment.agent)} |`);
  const took = duration(comment.durationMs);
  if (took !== null) rows.push(`| Duration | ${took} |`);
  if (comment.retryNotBefore !== null) {
    rows.push(`| Retry not before | \`${cell(comment.retryNotBefore)}\` (UTC) |`);
  }
  rows.push(
    `| Next | ${REFINEMENT_PROGRESS_NEXT_ACTION_PHRASES[comment.nextAction]} `
      + `(\`${cell(comment.nextAction)}\`) |`,
  );

  const lines = [
    marker,
    REFINEMENT_PROGRESS_COMMENT_HEADLINES[comment.kind],
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...rows,
  ];
  if (comment.humanActionRequired) {
    lines.push("", humanActionSentence(comment.kind));
  }
  const body = lines.join("\n");
  return body.length > MAX_PROGRESS_COMMENT_CHARS
    ? `${body.slice(0, MAX_PROGRESS_COMMENT_CHARS - 1)}…`
    : body;
}

// ---------------------------------------------------------------------------
// The diagnostic for a milestone that publishes nothing
// ---------------------------------------------------------------------------

/**
 * §15's event for a committed milestone whose public comment could not be
 * projected (issue #976).
 *
 * A refusal is not a delivery failure — the outbox never saw a row — so no
 * dead-lettered row exists to find it in. The task event log is therefore the
 * only place the gap can be recorded, and it is recorded in the SAME transaction
 * as the milestone it belongs to, so a milestone and the note saying it was not
 * published can never disagree about whether either happened.
 */
export const REFINEMENT_PROGRESS_COMMENT_UNPUBLISHABLE_EVENT =
  "refinement.progress.comment.unpublishable";

/** The task event one refusal is recorded as. Literals only (§15). */
export function refinementProgressCommentUnpublishableEvent(
  refusal: RefinementProgressCommentRefusal,
): { type: string; message: string; data: Record<string, unknown> } {
  return {
    type: REFINEMENT_PROGRESS_COMMENT_UNPUBLISHABLE_EVENT,
    message: refusal.detail,
    data: {
      code: refusal.code,
      // Carried in `data` as well as in `message`: not every commit path maps a
      // handler event's message onto the task event, and the diagnostic is the
      // whole point of the record.
      detail: refusal.detail,
      projection: REFINEMENT_PROGRESS_COMMENT_PROJECTION,
      projectionVersion: REFINEMENT_PROGRESS_COMMENT_VERSION,
      ...(refusal.milestoneId !== null ? { milestoneId: refusal.milestoneId } : {}),
      ...(refusal.issueNumber !== null ? { issueNumber: refusal.issueNumber } : {}),
    },
  };
}
