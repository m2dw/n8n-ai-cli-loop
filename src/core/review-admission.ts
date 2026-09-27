/**
 * Review-admission preflight (issue #681).
 *
 * This is pure policy over `task.context` — no network, no filesystem, no
 * repo-host provider — so it belongs to the Orchestration layer (DOMAIN.md
 * §2.3). It lived in `handlers/review-admission.ts` until issue #1029 needed
 * it from `core/tool-request-run.ts`, which may not runtime-import from
 * `handlers/`; that module is now a re-export of this one, so the review
 * handler and `cli/run-one-phase.ts` are unaffected.
 */
import type { AiTask } from "./task.js";
import { hasUnresolvedToolRequest } from "./tool-request.js";
import { extractPrNumber } from "./pr-context.js";

/**
 * How a predecessor HEAD was authoritatively accepted (issue #1165, decision
 * D5). `stack-ready` is the success-specific review-passed marker; the commit it
 * was granted at is the one the predecessor's own final-stage grant names
 * (#1094 §8 step 5), which is what binds the acceptance to a reviewed commit
 * rather than to a label a later force-push would carry along. An equivalent
 * authoritative successful-completion signal would be added here rather than
 * inferred at a read site.
 */
export const DEPENDENCY_BASE_ACCEPTANCE_EVIDENCE = ["stack-ready"] as const;

export type DependencyBaseAcceptanceEvidence = (typeof DEPENDENCY_BASE_ACCEPTANCE_EVIDENCE)[number];

/**
 * The dependency flow's attestation that it incorporated one exact predecessor
 * commit, and that the predecessor was accepted at that commit. Recorded beside
 * `baseHeadSha` by the implementation phase, never derived from a ref: a fetch
 * or a moved branch tip supplies no acceptance, so it can never advance an
 * Issue base (issue #1165 D5).
 */
export interface DependencyBaseAcceptance {
  sha: string;
  evidence: DependencyBaseAcceptanceEvidence;
}

export interface DependencyReviewBase {
  sha: string;
  refName?: string;
  /**
   * Present only when the dependency flow recorded an acceptance for this exact
   * head (issue #1165 D5). Absent on pre-#1165 metadata, which therefore never
   * advances a recorded Issue base.
   */
  accepted?: DependencyBaseAcceptance;
}

/**
 * Parse `context.dependencyBase` into the durable predecessor review-base
 * metadata a dependency-started task's implementation phase recorded when it
 * created the branch (issue #667). `missing: true` means a `dependencyBase`
 * object IS present but carries no `baseHeadSha` — pre-#667 or otherwise
 * incomplete metadata with no durable start point to reproduce the review
 * diff base from. A task with no `dependencyBase` at all (not dependency-
 * started) reports `missing: false` with no `base`.
 *
 * `baseHeadAccepted` is parsed alongside it (issue #1165 D5) and is admitted
 * only when it names a non-empty SHA and one of the closed evidence kinds; a
 * malformed or absent attestation simply leaves `accepted` unset, exactly as a
 * pre-#1165 record does, so nothing about review admission changes.
 */
export function resolveDependencyReviewBase(context: unknown): { base?: DependencyReviewBase; missing: boolean } {
  const raw =
    typeof context === "object" && context !== null
      ? (context as Record<string, unknown>)["dependencyBase"]
      : undefined;
  const obj = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (obj === undefined) return { missing: false };
  const sha =
    typeof obj["baseHeadSha"] === "string" && (obj["baseHeadSha"] as string).trim().length > 0
      ? (obj["baseHeadSha"] as string).trim()
      : undefined;
  if (sha === undefined) return { missing: true };
  const refName = typeof obj["baseHeadRefName"] === "string" ? (obj["baseHeadRefName"] as string).trim() : undefined;
  return { base: { sha, refName, ...(parseDependencyBaseAcceptance(obj["baseHeadAccepted"]) ?? {}) }, missing: false };
}

/** The `baseHeadAccepted` attestation, or nothing when it is absent or malformed. */
function parseDependencyBaseAcceptance(raw: unknown): { accepted: DependencyBaseAcceptance } | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const sha = typeof obj["sha"] === "string" ? obj["sha"].trim() : "";
  const evidence = obj["evidence"];
  if (sha.length === 0) return undefined;
  if (typeof evidence !== "string" || !(DEPENDENCY_BASE_ACCEPTANCE_EVIDENCE as readonly string[]).includes(evidence)) {
    return undefined;
  }
  return { accepted: { sha, evidence: evidence as DependencyBaseAcceptanceEvidence } };
}

export type ReviewAdmissionResult =
  | { ok: true; dependencyReviewBase?: DependencyReviewBase }
  | { ok: false; result: "failed"; error: string }
  | { ok: false; result: "blocked"; message: string };

/**
 * Review-admission preflight (issue #681). Runs before ANY review-phase side
 * effect — repo-host resolution, worktree lock/materialization, git/gh calls,
 * artifact writes, or the review agent invocation — and requires durable
 * evidence, computable from `task.context` alone (no network or filesystem
 * access), that the task is actually ready for review:
 *
 *  1. No unresolved implementation Tool Request (issue #677) — a live handoff
 *     is authoritative over whatever queued this review run (a mistaken
 *     `admin recover`, a stale/conflicting GitHub review label, etc.).
 *  2. A durable PR reference (`prUrl` or `branch`) is recorded — otherwise
 *     there is no open PR to review or hand off.
 *  3. That reference resolves to a head selector — a PR number parsed from
 *     `prUrl`, or an explicit `branch` — otherwise the recorded `prUrl`
 *     cannot identify which commits to check out.
 *  4. A dependency-started task (`context.dependencyBase` present) carries
 *     the predecessor `baseHeadSha` the implementation phase recorded when it
 *     created the branch (issue #667) — otherwise there is no durable review
 *     diff boundary to reproduce, and reviewing against the session base
 *     would silently include the predecessor's not-yet-merged changes.
 *
 * A rejection here never touches the issue branch, worktree, Tool Request
 * context, or any partial implementation artifact — nothing has been
 * resolved, locked, checked out, or written yet.
 */
export function checkReviewAdmission(task: AiTask): ReviewAdmissionResult {
  const context = task.context as Record<string, unknown>;

  if (hasUnresolvedToolRequest(context)) {
    return {
      ok: false,
      result: "failed",
      error:
        `Issue #${task.issueNumber} has an unresolved implementation Tool Request; refusing to run review. ` +
        `Resolve it first with 'admin tool-request resolve' or 'admin tool-request grant'.`,
    };
  }

  const prUrl = typeof context["prUrl"] === "string" ? (context["prUrl"] as string) : undefined;
  const branchRaw = typeof context["branch"] === "string" ? (context["branch"] as string) : undefined;
  const branch = branchRaw !== undefined && branchRaw.trim().length > 0 ? branchRaw.trim() : undefined;

  if (prUrl === undefined && branch === undefined) {
    return {
      ok: false,
      result: "failed",
      error:
        `No PR URL or branch in task context for issue #${task.issueNumber}; refusing to run review with no PR ` +
        `to hand off. Run implementation first (status:needs-implementation), or record the PR reference via ` +
        `'admin tool-request grant' / 'admin human-review-return' before retrying.`,
    };
  }

  const prNumber = prUrl !== undefined ? extractPrNumber(prUrl) : undefined;
  if (branch === undefined && (prNumber === undefined || prNumber <= 0)) {
    return {
      ok: false,
      result: "failed",
      error:
        `PR reference '${prUrl}' in task context for issue #${task.issueNumber} does not resolve to a PR number ` +
        `and no branch is recorded; refusing to run review with no resolvable PR head. Correct the recorded ` +
        `prUrl or set an explicit branch in the task context before retrying.`,
    };
  }

  const { base: dependencyReviewBase, missing: dependencyReviewBaseMissing } = resolveDependencyReviewBase(context);
  if (dependencyReviewBaseMissing) {
    return {
      ok: false,
      result: "blocked",
      message:
        `Dependency-started issue #${task.issueNumber} has recorded dependency-start metadata with no predecessor ` +
        `head SHA (dependencyBase.baseHeadSha); there is no durable start point to reproduce the review diff base ` +
        `from. Reviewing against the session base would include the predecessor's not-yet-merged changes as if ` +
        `they belonged to this issue — escalating to human instead of running a misleading cumulative review. ` +
        `Re-run implementation to record dependency-start metadata (issue #667).`,
    };
  }

  return { ok: true, ...(dependencyReviewBase !== undefined ? { dependencyReviewBase } : {}) };
}
