/**
 * Pure, deterministic classifier for Codex review output.
 *
 * Conservative rule priority (first match wins):
 *   1. conflict  — strong, structural evidence of a real Git merge conflict
 *   2. needs_fix — P1/P2 / "blocking" findings, or an unmet issue requirement
 *                  / acceptance criterion called out by the reviewer
 *   3. success   — output present and no blocking findings detected
 *   4. blocked   — empty/ambiguous output (human needed)
 */

export type ReviewClassification = "success" | "needs_fix" | "conflict" | "blocked";

export interface ClassificationDetail {
  classification: ReviewClassification;
  hasBlockingFindings: boolean;
  hasConflictSignal: boolean;
  findingCount: number;
  reason: string;
}

// Strong, structural evidence of a *real* Git merge conflict.
//
// Generic prose such as "merge conflict" or "cannot merge" is intentionally NOT
// matched here. The codex review output is freeform discussion of the diff and
// routinely contains conflict-related words when the PR is about conflict-handling
// code, or when failing test names / assertions include strings such as
// "merge conflict in codex output" or "conflict_resolution" (issue #168).
// Matching that prose produced false human escalations even when the PR branch
// was perfectly mergeable. We therefore require reliable evidence: actual Git
// conflict markers, Git's own conflict output, or Git's merge-failure messages.
const CONFLICT_PATTERNS = [
  /^<{7}(?: |$)/m, // <<<<<<< HEAD  (Git conflict marker at line start)
  /^>{7}(?: |$)/m, // >>>>>>> branch (Git conflict marker at line start)
  /^CONFLICT \([^)]*\):/m, // git: "CONFLICT (content): Merge conflict in <file>"
  /^Automatic merge failed/im, // git merge failure summary line
  /merging is not possible because you have unmerged files/i, // git unmerged-files error
];

// P1/P2 priority markers and generic "blocking" language.
// Use bracketed [P1]/[P2] as the canonical finding format to avoid
// matching negative statements like "No P1/P2 findings found."
export const PRIORITY_BLOCKING_PATTERNS = [
  /\[P[12]\]/,
  /\bblocking\s+finding/i,
  /\bcritical\s+finding/i,
  /\bblocker\b/i,
];

// Requirement-fit signals: the reviewer states that the diff fails to satisfy
// an issue requirement or acceptance criterion. These are treated as blocking
// so a clean-but-wrong implementation cannot pass review (issue #174). The
// patterns require a "miss"-style verb adjacent to the requirement/criterion
// noun so plain mentions ("all acceptance criteria are met") do not match.
export const REQUIREMENT_MISS_PATTERNS = [
  /\b(?:miss(?:es|ing|ed)?|unmet|unsatisfied|unaddressed|incomplete|not\s+(?:met|satisfied|addressed|implemented|fulfilled))\b[\s\S]{0,60}?\bacceptance\s+criteri/i,
  /\bacceptance\s+criteri\w*\b[\s\S]{0,60}?\b(?:miss(?:es|ing|ed)?|unmet|unsatisfied|unaddressed|incomplete|not\s+(?:met|satisfied|addressed|implemented|fulfilled))\b/i,
  /\bdoes\s+not\s+(?:meet|satisfy|fulfill|address|implement)\b[\s\S]{0,40}?\b(?:acceptance\s+criteri|requirement)/i,
  /\b(?:missing|unmet|unsatisfied|unaddressed)\s+requirement/i,
];

// Combined set used both for classification and for locating the first
// actionable finding when bounding stored review feedback.
export const BLOCKING_PATTERNS = [
  ...PRIORITY_BLOCKING_PATTERNS,
  ...REQUIREMENT_MISS_PATTERNS,
];

// Signals that the reviewer explicitly requests human input
const HUMAN_INPUT_PATTERNS = [
  /human\s+(review|decision|judgment|input)\s+required/i,
  /needs?\s+human\s+(review|decision)/i,
  /escalate\s+to\s+human/i,
  /manual\s+review\s+required/i,
];

/**
 * Structural evidence of a real Git merge conflict anywhere in the text.
 *
 * Exported so a caller that classifies only PART of a review run's output (issue
 * #841 scopes the prose rules to the text outside the structured envelope) can
 * still test the COMPLETE output for a conflict, which is the one signal no
 * reviewer statement can argue with.
 */
export function hasConflictSignal(output: string): boolean {
  return CONFLICT_PATTERNS.some((p) => p.test(output.trim()));
}

export function classifyReviewOutput(output: string): ClassificationDetail {
  const text = output.trim();

  if (text.length === 0) {
    return {
      classification: "blocked",
      hasBlockingFindings: false,
      hasConflictSignal: false,
      findingCount: 0,
      reason: "Empty review output — cannot classify confidently",
    };
  }

  if (hasConflictSignal(text)) {
    return {
      classification: "conflict",
      hasBlockingFindings: false,
      hasConflictSignal: true,
      findingCount: 0,
      reason: "Review output contains merge-conflict signals",
    };
  }

  const hasPriorityBlocking = PRIORITY_BLOCKING_PATTERNS.some((p) => p.test(text));
  const hasRequirementMiss = REQUIREMENT_MISS_PATTERNS.some((p) => p.test(text));
  if (hasPriorityBlocking || hasRequirementMiss) {
    // Count distinct P1/P2 markers as a rough finding count
    const findingCount = (text.match(/\[P[12]\]/g) ?? []).length || 1;
    return {
      classification: "needs_fix",
      hasBlockingFindings: true,
      hasConflictSignal: false,
      findingCount,
      reason: hasPriorityBlocking
        ? "Review output contains blocking (P1/P2) findings"
        : "Review output reports an unmet issue requirement or acceptance criterion",
    };
  }

  const needsHuman = HUMAN_INPUT_PATTERNS.some((p) => p.test(text));
  if (needsHuman) {
    return {
      classification: "blocked",
      hasBlockingFindings: false,
      hasConflictSignal: false,
      findingCount: 0,
      reason: "Review output requests human judgment",
    };
  }

  // Output present, no blocking markers → clean review
  return {
    classification: "success",
    hasBlockingFindings: false,
    hasConflictSignal: false,
    findingCount: 0,
    reason: "No blocking findings detected in review output",
  };
}
