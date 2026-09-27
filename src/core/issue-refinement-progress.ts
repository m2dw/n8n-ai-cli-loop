/**
 * Issue refinement progress milestones — the stable, versioned observability
 * projection over the fine-grained `refinement.*` audit events (issue #975,
 * docs/issue-refinement-contract.md §15).
 *
 * The refinement lane already records everything it does: eligibility, the
 * snapshot, every role turn, every malformed retry, every process failure,
 * acceptance, application, activation, and the handoff. That record is a
 * DIAGNOSTIC log — its vocabulary is open-ended by design, its fields are
 * whatever each transition needed, and consumers that want to say "where is
 * this Issue now" would each have to re-derive the answer from it and would
 * each get it slightly wrong.
 *
 * This module is the other half: a bounded, typed, deterministically-derived
 * sequence of the eight boundaries that actually matter to somebody watching
 * an Issue. It is a PROJECTION, not a second state machine — it reads the
 * events the lane already emits plus the authoritative phase transition
 * result, and it decides nothing the lane has not already decided.
 *
 * Three properties carry the design:
 *
 *  - **Deterministic identity.** {@link computeRefinementMilestoneId} hashes
 *    task/refinement identity together with the semantic transition (round,
 *    role, attempt, kind, transition literal) and NOTHING else — no clock, no
 *    randomness, no runId. Replaying the same semantic transition after a
 *    retry, a process restart, or a claim-loss recovery reproduces the same
 *    id, which is what makes suppression possible at all.
 *  - **Durable suppression.** The ids already emitted live on the refinement
 *    context block ({@link RefinementProgressLedger}), committed in the SAME
 *    task transaction as the milestones themselves. An in-memory set would
 *    forget across the restart the contract has to survive. The ledger is
 *    bounded by {@link refinementProgressLedgerCap}, derived from the §8 caps
 *    that already bound the lane, so it cannot become an unbounded history in
 *    `task.context`.
 *  - **Bounded, sanitized fields.** Every value that reaches a milestone is
 *    either a closed-set literal, a counter, or a slug-sanitized identifier
 *    with a hard length cap. Raw agent output, prompts, artifact paths, local
 *    filesystem paths, and free prose have no field to travel in.
 *
 * What this module does NOT do: publish anything (issue #976 owns the outbox
 * effects and the GitHub comment), render anything (issue #977 owns admin/UI),
 * or replace/rename a single existing `refinement.*` event.
 */

import { createHash } from "crypto";

import type { IssueRefinementLimits, RefinementHandoffReason, RefinementState } from "./issue-refinement.js";
import { REFINEMENT_HANDOFF_REASONS, isRefinementState } from "./issue-refinement.js";
import { REFINEMENT_CONFIDENCE_LEVELS } from "./issue-refinement-loop.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Bumped when the persisted shape changes in a way a reader must notice.
 * Stamped on every milestone AND on the ledger, so a consumer that meets a
 * newer producer can refuse rather than guess.
 */
export const REFINEMENT_PROGRESS_SCHEMA_VERSION = 1;

/**
 * The one task-event type every milestone is persisted as. A single type keeps
 * the log queryable by kind (`data.kind`) without inventing eight more event
 * names beside the audit vocabulary §15 already closes.
 */
export const REFINEMENT_PROGRESS_EVENT_TYPE = "refinement.progress.milestone";

/**
 * The eight coarse boundaries (issue #975). Deliberately smaller than the
 * audit vocabulary: a malformed-output retry, a stale restart, an eligibility
 * hold, and an idle poll are all things the lane records and none of them are
 * progress.
 */
export const REFINEMENT_PROGRESS_MILESTONE_KINDS = [
  /** Refinement became eligible and actually began. Emitted once. */
  "started",
  /** A refiner sub-turn completed with a well-formed contract. */
  "refiner_completed",
  /** A critic sub-turn completed; `result` carries the verdict. */
  "critic_completed",
  /** A transient failure committed a delayed retry with a real deadline. */
  "retry_scheduled",
  /** Refiner/critic agreement was accepted. */
  "accepted",
  /** The accepted refinement was applied and implementation activation completed. */
  "activated",
  /** Refinement reached a terminal human decision point. */
  "human_handoff",
  /** Refinement ended in a non-retryable terminal failure. */
  "failed",
] as const;

export type RefinementProgressMilestoneKind =
  (typeof REFINEMENT_PROGRESS_MILESTONE_KINDS)[number];

/**
 * What the lane is waiting for after this milestone — machine-readable, so a
 * consumer never parses a sentence to decide whether to page somebody.
 */
export const REFINEMENT_PROGRESS_NEXT_ACTIONS = [
  "await_refiner",
  "await_critic",
  "await_retry",
  "await_acceptance",
  "await_application",
  "await_implementation",
  "await_human",
] as const;

export type RefinementProgressNextAction =
  (typeof REFINEMENT_PROGRESS_NEXT_ACTIONS)[number];

export const REFINEMENT_PROGRESS_ROLES = ["refiner", "critic"] as const;
export type RefinementProgressRole = (typeof REFINEMENT_PROGRESS_ROLES)[number];

/** Bounded agent/provider/model/effort metadata for a role-scoped milestone. */
export interface RefinementProgressAgentRecord {
  agentId: string;
  provider: string;
  model: string | null;
  effort: string | null;
  /** `env` | `default` — where the model came from, when the source is known. */
  modelSource?: string;
  effortSource?: string;
}

/**
 * One persisted progress boundary. Every field is bounded and structured;
 * there is deliberately no field a prompt, a transcript, an artifact path, or
 * a credential could travel in.
 */
export interface RefinementProgressMilestone {
  schemaVersion: number;
  /** Deterministic; see {@link computeRefinementMilestoneId}. */
  milestoneId: string;
  kind: RefinementProgressMilestoneKind;
  /** Task/Issue identity. */
  issueNumber: number;
  /** §6 target-Issue source fingerprint — the refinement's stable identity. */
  sourceFingerprint: string;
  /** §6 predecessor fingerprint (the refinement "revision"), when captured. */
  predecessorFingerprint: string | null;
  /** The refinement state at this boundary. */
  state: RefinementState;
  round?: number;
  role?: RefinementProgressRole;
  attempt?: number;
  agent?: RefinementProgressAgentRecord;
  /** Wall-clock cost of the sub-turn this milestone closes, when known. */
  durationMs?: number;
  /** Closed-set outcome literal (a critic verdict, a refiner confidence). */
  result?: string;
  /** Closed-set handoff reason, for the terminal kinds. */
  reason?: string;
  /** Content-free failure classification literal. */
  failureClass?: string;
  nextAction: RefinementProgressNextAction;
  /**
   * The AUTHORITATIVE committed `notBefore` for a `retry_scheduled`
   * milestone — stamped by whoever commits the delayed task transition, never
   * estimated by the projection (which cannot know the delay policy in force).
   */
  retryNotBefore?: string;
  humanActionRequired: boolean;
  occurredAt: string;
}

// ---------------------------------------------------------------------------
// Bounded field discipline
// ---------------------------------------------------------------------------

/** Hard cap for any identifier-shaped field (agent, provider, model, effort). */
export const REFINEMENT_PROGRESS_MAX_IDENTIFIER_CHARS = 64;
/** Hard cap for a classification slug (`failureClass`). */
export const REFINEMENT_PROGRESS_MAX_SLUG_CHARS = 40;

/**
 * Accept a string ONLY if it is already an identifier — `[A-Za-z0-9._:-]`
 * within the length cap — and drop it otherwise.
 *
 * Validating beats scrubbing here, and the difference is not cosmetic. A
 * scrubber that strips the disallowed characters out of
 * `creds-dir/creds "token=sk-live-1234"` returns a path-free, quote-free,
 * space-free slug that still CONTAINS the token; every real value this field
 * ever holds (`claude`, `openai`, `claude-opus-5`, `high`, `usage_quota`) is
 * an identifier already, so anything that is not one is not a mangled
 * identifier — it is something that does not belong in a milestone at all.
 */
function sanitizeIdentifier(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > maxChars) return null;
  return /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function memberOf<T extends string>(value: unknown, set: readonly T[]): T | undefined {
  return typeof value === "string" && (set as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function readRole(value: unknown): RefinementProgressRole | undefined {
  return memberOf(value, REFINEMENT_PROGRESS_ROLES);
}

/**
 * The handoff reason as a CLOSED-set literal. An unrecognized reason becomes
 * `unknown` rather than passing an arbitrary string through: the field exists
 * so a consumer can branch on it, and a value outside the set is not something
 * any consumer can branch on anyway.
 */
function readHandoffReason(value: unknown): RefinementHandoffReason | "unknown" {
  return memberOf(value, REFINEMENT_HANDOFF_REASONS) ?? "unknown";
}

/** Bounded agent metadata, or absent when the event carried none. */
function readAgent(data: Record<string, unknown>): RefinementProgressAgentRecord | undefined {
  const agentId = sanitizeIdentifier(data["agentId"], REFINEMENT_PROGRESS_MAX_IDENTIFIER_CHARS);
  const provider = sanitizeIdentifier(data["provider"], REFINEMENT_PROGRESS_MAX_IDENTIFIER_CHARS);
  if (!agentId || !provider) return undefined;
  const modelSource = sanitizeIdentifier(data["modelSource"], REFINEMENT_PROGRESS_MAX_SLUG_CHARS);
  const effortSource = sanitizeIdentifier(data["effortSource"], REFINEMENT_PROGRESS_MAX_SLUG_CHARS);
  return {
    agentId,
    provider,
    model: sanitizeIdentifier(data["model"], REFINEMENT_PROGRESS_MAX_IDENTIFIER_CHARS),
    effort: sanitizeIdentifier(data["effort"], REFINEMENT_PROGRESS_MAX_SLUG_CHARS),
    ...(modelSource ? { modelSource } : {}),
    ...(effortSource ? { effortSource } : {}),
  };
}

// ---------------------------------------------------------------------------
// Deterministic identity
// ---------------------------------------------------------------------------

/** Chars of the SHA-256 kept for a milestone id — 128 bits of collision room. */
export const REFINEMENT_MILESTONE_ID_CHARS = 32;

export interface RefinementMilestoneIdentity {
  issueNumber: number;
  /** §6 target-Issue fingerprint: stable for the life of one refinement. */
  sourceFingerprint: string;
  kind: RefinementProgressMilestoneKind;
  round?: number | undefined;
  role?: RefinementProgressRole | undefined;
  attempt?: number | undefined;
  /**
   * The semantic transition this milestone projects — the source event literal,
   * discriminated where one literal can mean two things. NOT the runId, not a
   * timestamp: the whole point is that a replay recomputes it byte for byte.
   */
  transition: string;
}

/**
 * The id a semantic transition always hashes to.
 *
 * Every component is either a stable identity (Issue number, source
 * fingerprint) or a semantic coordinate the lane's own counters produce
 * (round, role, attempt, kind, transition). Nothing here can move between two
 * deliveries of the same transition, which is precisely the property
 * suppression is built on. `predecessorFingerprint` is deliberately EXCLUDED:
 * it is re-derived on every snapshot, so including it would mint a fresh
 * `started` id for a resumed run whose snapshot happened to re-read a
 * predecessor mid-update.
 */
export function computeRefinementMilestoneId(identity: RefinementMilestoneIdentity): string {
  const canonical = [
    "refinement-progress",
    `v${REFINEMENT_PROGRESS_SCHEMA_VERSION}`,
    `issue:${identity.issueNumber}`,
    `source:${identity.sourceFingerprint}`,
    `kind:${identity.kind}`,
    `round:${identity.round ?? "-"}`,
    `role:${identity.role ?? "-"}`,
    `attempt:${identity.attempt ?? "-"}`,
    `transition:${identity.transition}`,
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, REFINEMENT_MILESTONE_ID_CHARS);
}

// ---------------------------------------------------------------------------
// The durable dedupe ledger
// ---------------------------------------------------------------------------

/**
 * The block-resident suppression record: the milestone ids already committed
 * for this refinement, in emission order. Ids only — the milestones themselves
 * live in the task event log, and duplicating them here is exactly the
 * unbounded `task.context` history issue #975 forbids.
 */
export interface RefinementProgressLedger {
  schemaVersion: number;
  emitted: string[];
  updatedAt: string;
}

/** Blocks written before this slice carry no ledger; that is a valid state. */
export interface RefinementProgressLedgerHolder {
  progressMilestones?: RefinementProgressLedger | undefined;
}

/**
 * The upper bound on distinct milestones one refinement can produce, derived
 * from the §8 caps rather than picked: the terminal kinds are one each, every
 * round contributes a refiner and a critic completion, and every role in every
 * round can schedule up to `maxAgentFailuresPerRole` retries. Rounds are
 * counted with the stale-restart allowance because `counters.rounds` is never
 * reset by a restart — a restarted refinement continues numbering upward.
 *
 * A small headroom absorbs the terminal kinds and any future boundary without
 * making the cap load-bearing for correctness.
 */
export const REFINEMENT_PROGRESS_LEDGER_HEADROOM = 8;

export function refinementProgressLedgerCap(limits: IssueRefinementLimits): number {
  const rounds =
    Math.max(1, nonNegativeInteger(limits.maxRefinementRoundsPerIssue) ?? 1)
    + (nonNegativeInteger(limits.maxStaleRestartsPerIssue) ?? 0)
    + 1;
  const perRound = 2 + 2 * (nonNegativeInteger(limits.maxAgentFailuresPerRole) ?? 0);
  return REFINEMENT_PROGRESS_LEDGER_HEADROOM + rounds * perRound;
}

/**
 * Read the ledger tolerantly. A block from before this slice, a block whose
 * ledger was written by a NEWER schema, and a block carrying garbage all read
 * as "nothing suppressed yet" — the milestones are an observability
 * projection, and refusing to run refinement because a projection's bookkeeping
 * is unreadable would be the wrong trade.
 */
export function readRefinementProgressLedger(
  holder: RefinementProgressLedgerHolder | undefined,
): string[] {
  const ledger = holder?.progressMilestones;
  if (!ledger || typeof ledger !== "object") return [];
  if (ledger.schemaVersion !== REFINEMENT_PROGRESS_SCHEMA_VERSION) return [];
  if (!Array.isArray(ledger.emitted)) return [];
  return ledger.emitted.filter((id): id is string => typeof id === "string" && id !== "");
}

/**
 * Append newly-emitted ids, keeping the ledger within `cap`. Overflow drops the
 * OLDEST entries: the derived cap is a true upper bound for one refinement, so
 * this cannot be reached by a lane running within its own §8 limits, and if a
 * future boundary ever pushes past it, re-emitting the earliest milestone of a
 * long-finished round is a far smaller failure than an unbounded context blob.
 */
export function appendRefinementProgressLedger(
  existing: readonly string[],
  added: readonly string[],
  cap: number,
  now: string,
): RefinementProgressLedger {
  const merged = [...existing];
  for (const id of added) {
    if (!merged.includes(id)) merged.push(id);
  }
  const bounded = cap > 0 && merged.length > cap ? merged.slice(merged.length - cap) : merged;
  return {
    schemaVersion: REFINEMENT_PROGRESS_SCHEMA_VERSION,
    emitted: bounded,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/** One `refinement.*` audit event, as the loop/apply runners produce them. */
export interface RefinementProgressSourceEvent {
  type: string;
  data?: Record<string, unknown> | undefined;
}

/**
 * The authoritative phase transition result the projection describes.
 *
 * Passing the transition — rather than reading intent out of the events — is
 * what keeps the milestones honest about the two things the events alone
 * cannot say: whether a retry was really COMMITTED (with a real deadline
 * behind it) rather than merely attempted, and whether the run ended
 * non-retryably.
 */
export type RefinementProgressResult = "success" | "blocked" | "delayed" | "failed";

/**
 * Whether this transition actually committed a §12 rows 38/40 role retry.
 *
 * The marker is the persisted resumable position: `pendingRetry` is written by
 * exactly the outcome that defers a role re-run, and by nothing else. An
 * eligibility hold and a transient snapshot read failure are `delayed` too and
 * carry none, which is precisely why they must not mint a `retry_scheduled`
 * milestone — neither is progress, and neither has a role waiting to resume.
 */
function retryCommitted(block: RefinementProgressBlockView): boolean {
  return block.pendingRetry !== undefined && block.pendingRetry !== null;
}

/** The block fields the projection reads. Structural, so every block fits. */
export interface RefinementProgressBlockView extends RefinementProgressLedgerHolder {
  state: RefinementState;
  sourceFingerprint: string;
  predecessorFingerprint: string | null;
  limits: IssueRefinementLimits;
  /** §17 rows 38/40 resumable position; presence is the retry-committed marker. */
  pendingRetry?: unknown;
}

export interface RefinementProgressProjectionInput {
  issueNumber: number;
  /** The POST-run block, i.e. the one this transition is committing. */
  block: RefinementProgressBlockView;
  /** The run's `refinement.*` audit events, in emission order. */
  events: readonly RefinementProgressSourceEvent[];
  result: RefinementProgressResult;
  /** Fallback timestamp for a milestone whose source event carried none. */
  now: string;
}

/** Terminal kinds are the two that need a human to look at the Issue. */
const HUMAN_ACTION_KINDS: ReadonlySet<RefinementProgressMilestoneKind> = new Set<
  RefinementProgressMilestoneKind
>(["human_handoff", "failed"]);

interface MilestoneDraft {
  kind: RefinementProgressMilestoneKind;
  transition: string;
  nextAction: RefinementProgressNextAction;
  state?: RefinementState | undefined;
  round?: number | undefined;
  role?: RefinementProgressRole | undefined;
  attempt?: number | undefined;
  /**
   * The attempt number that participates in the IDENTITY, as opposed to the
   * one merely reported. Set only where a round can cross the same boundary
   * more than once — a `retry_scheduled` per failed attempt. A role's single
   * completion per round is deliberately identified WITHOUT it: a re-run that
   * happens to succeed on a different attempt than the delivery it replaces is
   * the same semantic transition, and hashing the attempt in would let a
   * non-deterministic agent mint a duplicate for it.
   */
  idAttempt?: number | undefined;
  agent?: RefinementProgressAgentRecord | undefined;
  durationMs?: number | undefined;
  result?: string | undefined;
  reason?: string | undefined;
  failureClass?: string | undefined;
  occurredAt?: string | undefined;
}

/**
 * Map one audit event to the progress boundaries it crosses — zero for most of
 * them. This is the ENTIRE noise boundary: an event with no case here (a
 * malformed-output retry, a stale restart, an eligibility refusal, the
 * row-22 commit point, the body write, the audit comment) contributes nothing,
 * which is how polling, holds, duplicate intake, and internal churn stay out of
 * the milestone stream without a suppression list to maintain.
 */
function draftsForEvent(
  event: RefinementProgressSourceEvent,
  retryIsCommitted: boolean,
): MilestoneDraft[] {
  const data = event.data ?? {};
  const rawAt = data["at"];
  const rawState = data["state"];
  const at = typeof rawAt === "string" ? rawAt : undefined;
  const state = isRefinementState(rawState) ? rawState : undefined;
  const round = positiveInteger(data["round"]);
  const common = { occurredAt: at, state };

  switch (event.type) {
    case "refinement.snapshot.captured":
      // The run is past eligibility, past role resolution, and has spent a
      // snapshot: refinement did not merely become runnable, it began.
      return [{ ...common, kind: "started", transition: event.type, nextAction: "await_refiner" }];

    case "refinement.draft.recorded":
      return [
        {
          ...common,
          kind: "refiner_completed",
          transition: event.type,
          nextAction: "await_critic",
          round,
          role: "refiner",
          attempt: positiveInteger(data["attempt"]),
          agent: readAgent(data),
          durationMs: nonNegativeInteger(data["durationMs"]),
          result: memberOf(data["confidence"], REFINEMENT_CONFIDENCE_LEVELS),
        },
      ];

    case "refinement.critique.revise":
      return [
        {
          ...common,
          kind: "critic_completed",
          transition: event.type,
          // The objections go back to the refiner for another bounded round.
          nextAction: "await_refiner",
          round,
          role: "critic",
          attempt: positiveInteger(data["attempt"]),
          agent: readAgent(data),
          durationMs: nonNegativeInteger(data["durationMs"]),
          result: "revise",
        },
      ];

    case "refinement.critique.passed":
      // One event, two boundaries: the critic's turn closed, and the pair
      // agreed. A consumer that only wants "is it agreed" reads the second
      // without having to know that a `pass` verdict implies acceptance.
      return [
        {
          ...common,
          kind: "critic_completed",
          transition: event.type,
          nextAction: "await_acceptance",
          round,
          role: "critic",
          attempt: positiveInteger(data["attempt"]),
          agent: readAgent(data),
          durationMs: nonNegativeInteger(data["durationMs"]),
          result: "pass",
        },
        {
          ...common,
          kind: "accepted",
          transition: event.type,
          nextAction: "await_application",
          round,
          result: memberOf(data["criticConfidence"], REFINEMENT_CONFIDENCE_LEVELS),
        },
      ];

    case "refinement.agent.failed": {
      // A retryable process failure is progress ONLY once the transition
      // committing the delayed retry says so — the same event is emitted for a
      // failure whose run then escalated, and a "retry scheduled" milestone
      // with no scheduled retry behind it is worse than none.
      if (data["retryable"] !== true) return [];
      if (!retryIsCommitted) return [];
      return [
        {
          ...common,
          kind: "retry_scheduled",
          transition: event.type,
          nextAction: "await_retry",
          round,
          role: readRole(data["role"]),
          attempt: positiveInteger(data["attempt"]),
          idAttempt: positiveInteger(data["attempt"]),
          agent: readAgent(data),
          durationMs: nonNegativeInteger(data["durationMs"]),
          failureClass: sanitizeIdentifier(data["failureKind"], REFINEMENT_PROGRESS_MAX_SLUG_CHARS) ?? "unknown",
        },
      ];
    }

    case "refinement.activated":
      return [
        {
          ...common,
          kind: "activated",
          transition: event.type,
          nextAction: "await_implementation",
        },
      ];

    case "refinement.escalated.human":
      return [
        {
          ...common,
          kind: "human_handoff",
          transition: event.type,
          nextAction: "await_human",
          round,
          role: readRole(data["role"]),
          attempt: positiveInteger(data["attempt"]),
          reason: readHandoffReason(data["reason"]),
          failureClass: sanitizeIdentifier(data["failureKind"], REFINEMENT_PROGRESS_MAX_SLUG_CHARS) ?? undefined,
        },
      ];

    default:
      return [];
  }
}

/**
 * Project the milestones this transition adds, suppressing everything the
 * ledger already carries.
 *
 * The suppression is intentionally applied at the END, after drafting: a
 * replayed run re-derives the identical drafts, and the ledger is what makes
 * the second delivery a no-op. Within one projection the same id can only be
 * drafted twice by a run that emitted the same transition twice, which the
 * `seen` set collapses for the same reason.
 */
export function projectRefinementProgress(
  input: RefinementProgressProjectionInput,
): RefinementProgressMilestone[] {
  const { block, issueNumber, now } = input;
  const drafts: MilestoneDraft[] = [];
  const retryIsCommitted = input.result === "delayed" && retryCommitted(block);
  for (const event of input.events) {
    drafts.push(...draftsForEvent(event, retryIsCommitted));
  }
  if (input.result === "failed") {
    // No audit event carries a non-retryable phase failure — it is a fact about
    // the TRANSITION, not about anything the lane's own walk recorded. One
    // literal, so a task that somehow fails twice at this phase still records
    // one terminal milestone.
    drafts.push({
      kind: "failed",
      transition: REFINEMENT_PHASE_FAILED_TRANSITION,
      nextAction: "await_human",
      failureClass: REFINEMENT_PHASE_FAILED_CLASS,
    });
  }

  const seen = new Set(readRefinementProgressLedger(block));
  const milestones: RefinementProgressMilestone[] = [];
  for (const draft of drafts) {
    const milestoneId = computeRefinementMilestoneId({
      issueNumber,
      sourceFingerprint: block.sourceFingerprint,
      kind: draft.kind,
      round: draft.round,
      role: draft.role,
      attempt: draft.idAttempt,
      transition: draft.transition,
    });
    if (seen.has(milestoneId)) continue;
    seen.add(milestoneId);
    milestones.push({
      schemaVersion: REFINEMENT_PROGRESS_SCHEMA_VERSION,
      milestoneId,
      kind: draft.kind,
      issueNumber,
      sourceFingerprint: block.sourceFingerprint,
      predecessorFingerprint: block.predecessorFingerprint,
      state: draft.state ?? block.state,
      ...(draft.round !== undefined ? { round: draft.round } : {}),
      ...(draft.role !== undefined ? { role: draft.role } : {}),
      ...(draft.attempt !== undefined ? { attempt: draft.attempt } : {}),
      ...(draft.agent !== undefined ? { agent: draft.agent } : {}),
      ...(draft.durationMs !== undefined ? { durationMs: draft.durationMs } : {}),
      ...(draft.result !== undefined ? { result: draft.result } : {}),
      ...(draft.reason !== undefined ? { reason: draft.reason } : {}),
      ...(draft.failureClass !== undefined ? { failureClass: draft.failureClass } : {}),
      nextAction: draft.nextAction,
      humanActionRequired: HUMAN_ACTION_KINDS.has(draft.kind),
      occurredAt: draft.occurredAt ?? now,
    });
  }

  return milestones;
}

// ---------------------------------------------------------------------------
// The retry deadline — owned by whoever commits the transition
// ---------------------------------------------------------------------------

/**
 * Stamp the AUTHORITATIVE committed `notBefore` onto every `retry_scheduled`
 * milestone, and drop any that has none.
 *
 * The projection cannot compute this: the delay is the committing layer's
 * (phase-runner applies its own quota cool-down for a §17 role retry, the
 * admin path mirrors it), and a handler-side estimate would be a different
 * number from the one the task row actually carries — which is exactly the
 * value an operator reads to know when the Issue wakes up. A milestone that
 * reaches a commit path with no deadline therefore has nothing to state and is
 * DROPPED rather than published half-true — and, because the ledger is built
 * from the survivors, dropping it does not suppress the real one later.
 */
export function stampRefinementRetryDeadline(
  milestones: readonly RefinementProgressMilestone[],
  notBefore: string | null | undefined,
): RefinementProgressMilestone[] {
  const stamped: RefinementProgressMilestone[] = [];
  for (const milestone of milestones) {
    if (milestone.kind !== "retry_scheduled") {
      stamped.push(milestone);
      continue;
    }
    if (typeof notBefore !== "string" || notBefore === "") continue;
    stamped.push({ ...milestone, retryNotBefore: notBefore });
  }
  return stamped;
}

// ---------------------------------------------------------------------------
// The commit shape — projection, deadline, ledger, and the events to append
// ---------------------------------------------------------------------------

/** The one transition literal a non-retryable phase failure hashes under. */
export const REFINEMENT_PHASE_FAILED_TRANSITION = "refinement.phase.failed";

/**
 * Its failure class. Deliberately coarse: the runner knows the transition
 * failed and nothing more, and the handler's own error string is prose — the
 * one thing a milestone field may never carry.
 */
export const REFINEMENT_PHASE_FAILED_CLASS = "phase_failed";

export interface RefinementProgressCommitInput {
  issueNumber: number;
  /**
   * The context patch this transition is about to commit. The refinement block
   * is read out of it — NOT out of the pre-run task — because the block being
   * committed is the one the milestones describe, and the ledger has to travel
   * back out in the very same patch.
   */
  context: Record<string, unknown> | undefined;
  /** The run's `refinement.*` audit events, in emission order. */
  events: readonly RefinementProgressSourceEvent[];
  result: RefinementProgressResult;
  /** The committed task `notBefore`, when this transition delays the task. */
  notBefore?: string | null | undefined;
  now: string;
}

export interface RefinementProgressCommit {
  /** New, deadline-stamped milestones, in order. Never empty. */
  milestones: RefinementProgressMilestone[];
  /** The caller's context patch with the updated ledger merged onto the block. */
  context: Record<string, unknown>;
}

/**
 * Read the refinement block out of a context patch, tolerantly.
 *
 * Anything that is not a block carrying the two identity fields the milestone
 * contract needs — the §6 source fingerprint and the §8 limits that bound the
 * ledger — reads as absent, and absent means no milestones. That is the right
 * failure: this is an observability projection, and a run must never fail, nor
 * a transition be refused, because a block could not be projected.
 */
export function readRefinementProgressBlock(
  context: Record<string, unknown> | undefined,
): RefinementProgressBlockView | null {
  const candidate = context?.["refinement"];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const block = candidate as Record<string, unknown>;
  const state = block["state"];
  if (!isRefinementState(state)) return null;
  const sourceFingerprint = block["sourceFingerprint"];
  if (typeof sourceFingerprint !== "string" || sourceFingerprint === "") return null;
  const limits = block["limits"];
  if (!limits || typeof limits !== "object") return null;
  const predecessorFingerprint = block["predecessorFingerprint"];
  return {
    state,
    sourceFingerprint,
    predecessorFingerprint:
      typeof predecessorFingerprint === "string" ? predecessorFingerprint : null,
    limits: limits as IssueRefinementLimits,
    ...(block["pendingRetry"] !== undefined ? { pendingRetry: block["pendingRetry"] } : {}),
    ...(block["progressMilestones"] !== undefined
      ? { progressMilestones: block["progressMilestones"] as RefinementProgressLedger }
      : {}),
  };
}

/**
 * Everything a committing layer needs in one call: the new milestones with the
 * authoritative retry deadline already on them, and the context patch to
 * commit in their place.
 *
 * Returns `null` when there is nothing to commit — no readable block, or every
 * projected milestone already suppressed by the ledger — so the caller keeps
 * its own patch untouched and appends no events. That null is the normal case
 * for a polling tick, an eligibility hold, a duplicate intake, and a replayed
 * delivery.
 */
export function prepareRefinementProgressCommit(
  input: RefinementProgressCommitInput,
): RefinementProgressCommit | null {
  const block = readRefinementProgressBlock(input.context);
  if (!block) return null;
  const projected = projectRefinementProgress({
    issueNumber: input.issueNumber,
    block,
    events: input.events,
    result: input.result,
    now: input.now,
  });
  const milestones = stampRefinementRetryDeadline(projected, input.notBefore);
  if (milestones.length === 0) return null;
  const ledger = appendRefinementProgressLedger(
    readRefinementProgressLedger(block),
    milestones.map((m) => m.milestoneId),
    refinementProgressLedgerCap(block.limits),
    input.now,
  );
  const contextPatch = input.context ?? {};
  const blockPatch = contextPatch["refinement"] as Record<string, unknown>;
  return {
    milestones,
    context: { ...contextPatch, refinement: { ...blockPatch, progressMilestones: ledger } },
  };
}

/**
 * The task event one milestone is persisted as. The milestone IS the payload:
 * every field is already bounded and sanitized, so there is nothing left to
 * decide at the event boundary.
 */
export function refinementProgressEvent(milestone: RefinementProgressMilestone): {
  type: string;
  data: Record<string, unknown>;
} {
  return {
    type: REFINEMENT_PROGRESS_EVENT_TYPE,
    data: { ...milestone } as unknown as Record<string, unknown>,
  };
}
