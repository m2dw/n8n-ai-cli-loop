/**
 * Review-admission preflight (issue #681) — moved to `core/review-admission.ts`
 * by issue #1029 (it is pure policy over `task.context`, and `core/` may not
 * runtime-import from `handlers/`). This module re-exports it unchanged so the
 * review handler, `cli/run-one-phase.ts`, and `test/review-admission.test.js`
 * keep their existing import path.
 */
export {
  checkReviewAdmission,
  resolveDependencyReviewBase,
  DEPENDENCY_BASE_ACCEPTANCE_EVIDENCE,
  type DependencyBaseAcceptance,
  type DependencyBaseAcceptanceEvidence,
  type DependencyReviewBase,
  type ReviewAdmissionResult,
} from "../core/review-admission.js";
