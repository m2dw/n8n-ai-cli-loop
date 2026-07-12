/**
 * Intervention taxonomy for autonomy metrics (issue #587).
 *
 * Defines what counts as a human intervention in the AI development loop,
 * what planned human actions are explicitly excluded, and how ambiguous
 * signals are represented.
 *
 * Classification rules:
 *
 *   Do NOT count:
 *     - Human issue creation / goal setting
 *     - Final human merge approval
 *     - Explicit planned human gates that are part of the workflow contract
 *
 *   Count:
 *     - L1: Human guidance through Issue/PR comments that redirect or
 *            supplement automation after queue entry.
 *     - L2: Human hands-on code work (human-authored commits on an automation
 *            branch, manual conflict/CI fix commits).
 *     - L3: Human rescue / operation (recover commands, human-review-return,
 *            Tool Request resolution, quarantine, task recreation, manual
 *            DB/state repair).
 *
 *   Ambiguous:
 *     - 'candidate' — signal present but cannot be definitively classified
 *                     without additional context; requires manual review.
 *
 * Review/fix-loop counts are tracked separately via ReviewFixLoopRecord and
 * must NOT be folded into the human-intervention counters.
 *
 * Later aggregation code should import these constants and helpers rather than
 * duplicating signal-name strings.
 */

// ---------------------------------------------------------------------------
// Level constants
// ---------------------------------------------------------------------------

/** L1 — Human guidance via comments after the issue entered the queue. */
export const INTERVENTION_L1 = "l1" as const;

/** L2 — Human hands-on code work on an automation-owned branch. */
export const INTERVENTION_L2 = "l2" as const;

/** L3 — Human rescue or operational action to unblock a stuck issue. */
export const INTERVENTION_L3 = "l3" as const;

/**
 * Ambiguous / candidate signal.
 * The event could be an intervention but may also be a planned action or
 * coincidental human touch. Requires manual classification or a narrower rule.
 */
export const INTERVENTION_CANDIDATE = "candidate" as const;

/**
 * Explicitly NOT an intervention (planned human action).
 * Actions that are part of the workflow contract and must be excluded from
 * intervention counts: issue creation, merge approval, declared human gates.
 */
export const INTERVENTION_NONE = "none" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All possible classification outcomes, including non-intervention. */
export type InterventionLevel =
  | typeof INTERVENTION_L1
  | typeof INTERVENTION_L2
  | typeof INTERVENTION_L3
  | typeof INTERVENTION_CANDIDATE
  | typeof INTERVENTION_NONE;

/** Subset of levels that increment the human-intervention counter. */
export type CountableInterventionLevel =
  | typeof INTERVENTION_L1
  | typeof INTERVENTION_L2
  | typeof INTERVENTION_L3;

/**
 * Observable signal kinds recognised by the taxonomy.
 *
 * Aggregation code maps raw events to one of these kinds before calling
 * `classifyIntervention`, so that signal-name strings live in a single place.
 */
export type InterventionSignalKind =
  // --- L1: human guidance ---
  | "issue_comment_guidance"      // Clarifying/redirecting comment on the issue
  | "pr_comment_guidance"         // Redirecting PR review comment
  // --- L2: human code work ---
  | "human_commit_on_ai_branch"   // Human-authored commit on automation branch
  | "manual_conflict_fix_commit"  // Manually-authored merge-conflict resolution
  | "manual_ci_fix_commit"        // Human CI-fix commit on the PR branch
  // --- L3: human rescue / operations ---
  | "admin_recover"               // admin worktree recover / admin recover
  | "human_review_return"         // admin human-review-return
  | "tool_request_resolution"     // admin tool-request grant / manual-done
  | "quarantine"                  // task quarantined by human
  | "task_recreation"             // human recreates or re-queues a failed task
  | "manual_db_repair"            // direct DB / loop-state manipulation
  // --- planned human actions (not interventions) ---
  | "issue_creation"              // human creates the issue / sets goal
  | "merge_approval"              // human clicks the merge button (planned gate)
  | "planned_human_gate"          // any other workflow-contract human gate
  // --- ambiguous ---
  | "unknown";                    // cannot be classified without more context

/** Result of classifying a single observed event. */
export interface InterventionClassification {
  /** Assigned intervention level (or 'none' / 'candidate'). */
  level: InterventionLevel;
  /** The signal kind that drove the classification. */
  signal: InterventionSignalKind;
  /** True when this event should increment the human-intervention counter. */
  countsAsIntervention: boolean;
  /** Human-readable explanation for audit trails and debugging. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Review / fix-loop record (reported separately from intervention count)
// ---------------------------------------------------------------------------

/**
 * Tracks AI-driven review → fix cycles for a single issue.
 *
 * Review/fix loops are a quality signal about the implementation effort and
 * must NOT be added to human-intervention counts. Aggregation code records
 * them in a separate field alongside (but distinct from) intervention counts.
 */
export interface ReviewFixLoopRecord {
  /** Number of AI-driven review → fix cycles completed for this issue. */
  cycleCount: number;
  /** True when the loop terminated because a human stepped in (L1–L3). */
  terminatedByHuman: boolean;
}

// ---------------------------------------------------------------------------
// Classification table
// ---------------------------------------------------------------------------

const SIGNAL_LEVELS: Record<InterventionSignalKind, InterventionLevel> = {
  // L1
  issue_comment_guidance: INTERVENTION_L1,
  pr_comment_guidance: INTERVENTION_L1,
  // L2
  human_commit_on_ai_branch: INTERVENTION_L2,
  manual_conflict_fix_commit: INTERVENTION_L2,
  manual_ci_fix_commit: INTERVENTION_L2,
  // L3
  admin_recover: INTERVENTION_L3,
  human_review_return: INTERVENTION_L3,
  tool_request_resolution: INTERVENTION_L3,
  quarantine: INTERVENTION_L3,
  task_recreation: INTERVENTION_L3,
  manual_db_repair: INTERVENTION_L3,
  // Planned — not interventions
  issue_creation: INTERVENTION_NONE,
  merge_approval: INTERVENTION_NONE,
  planned_human_gate: INTERVENTION_NONE,
  // Ambiguous
  unknown: INTERVENTION_CANDIDATE,
};

const SIGNAL_REASONS: Record<InterventionSignalKind, string> = {
  issue_comment_guidance:
    "Human added guidance or direction to the issue after automation began (L1)",
  pr_comment_guidance:
    "Human PR review comment redirected or supplemented automation (L1)",
  human_commit_on_ai_branch:
    "Human-authored commit detected on an automation-owned branch (L2)",
  manual_conflict_fix_commit:
    "Human manually resolved a merge conflict on the PR branch (L2)",
  manual_ci_fix_commit:
    "Human pushed a CI-fix commit to the automation branch (L2)",
  admin_recover:
    "Human ran an admin recover or worktree-recover command (L3)",
  human_review_return:
    "Human ran admin human-review-return to unblock a stalled task (L3)",
  tool_request_resolution:
    "Human resolved a Tool Request (grant or manual-done) (L3)",
  quarantine:
    "Human quarantined the task (L3)",
  task_recreation:
    "Human recreated or re-queued a failed task (L3)",
  manual_db_repair:
    "Human manually repaired database or loop state (L3)",
  issue_creation:
    "Human created the issue or set the goal — not an intervention (planned action)",
  merge_approval:
    "Human approved the final merge — not an intervention (planned gate)",
  planned_human_gate:
    "Explicit workflow-contract human gate — not an intervention",
  unknown:
    "Signal cannot be classified without more context (candidate)",
};

// ---------------------------------------------------------------------------
// Classification helper
// ---------------------------------------------------------------------------

/**
 * Classify an observed signal kind into an intervention level.
 *
 * The returned `countsAsIntervention` flag is the canonical test for whether
 * the event should increment the human-intervention counter.
 */
export function classifyIntervention(
  signal: InterventionSignalKind,
): InterventionClassification {
  const level = SIGNAL_LEVELS[signal];
  const countsAsIntervention = isCountableIntervention(level);
  const reason = SIGNAL_REASONS[signal];
  return { level, signal, countsAsIntervention, reason };
}

// ---------------------------------------------------------------------------
// Predicate helpers
// ---------------------------------------------------------------------------

/** True for any level that increments the intervention counter (L1, L2, L3). */
export function isCountableIntervention(
  level: InterventionLevel,
): level is CountableInterventionLevel {
  return (
    level === INTERVENTION_L1 ||
    level === INTERVENTION_L2 ||
    level === INTERVENTION_L3
  );
}

/** True when the level represents a planned (non-intervention) human action. */
export function isPlannedHumanAction(level: InterventionLevel): boolean {
  return level === INTERVENTION_NONE;
}

/** True when the level is ambiguous and needs further review. */
export function isCandidate(level: InterventionLevel): boolean {
  return level === INTERVENTION_CANDIDATE;
}
