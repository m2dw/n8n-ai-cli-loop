/**
 * Context key a handler sets to `true` alongside `artifactDir` (issue #611
 * review) whenever it returns before ever reaching its own `mkdirSync` /
 * `isSafeArtifactDirAfterRun` sequence — an admission, repo-host-resolve, or
 * agent-assignment failure, for instance. In every one of those states
 * `artifactDir` names a path that was never created, so restore's
 * artifact-reference validation (`sqlite-backup-store.ts`) must skip that
 * field instead of rejecting the snapshot for a directory that never existed
 * in the first place.
 *
 * Declared in `core/` — not `handlers/artifact-dir.ts`, which re-exports it
 * for its existing consumers — so that `core/transitions.ts` (Orchestration)
 * does not depend at runtime on an Execution-layer module (issue #883;
 * DOMAIN.md §1.2).
 */
export const ARTIFACT_DIR_PENDING_CONTEXT_FIELD = "artifactDirPending";

/**
 * Context key naming the run directory that holds the §10.2 dispute records
 * (`dispute-<lineageId>.json`) a fix run wrote (issue #952).
 *
 * A dedicated, never-overwritten reference for the same reason `reviewArtifactDir`
 * is one (issue #837 review, P2): the reviewer's reconsideration turn runs one or
 * more phases later, and the plain `artifactDir` key is rewritten by every run
 * that touches the task — including a review run that blocks before it reaches
 * its own agent. Without a dedicated field the rebuttal being reconsidered would
 * become unreadable after any intervening completion.
 *
 * Declared here, beside the pending marker, so both the Execution-layer artifact
 * helpers and `ARTIFACT_DIR_CONTEXT_FIELDS` name one constant.
 */
export const DISPUTE_ARTIFACT_DIR_CONTEXT_FIELD = "disputeArtifactDir";

/**
 * Context key naming the run directory that holds the §10.2 reconsideration
 * records (`reconsideration-<lineageId>.json`) the reviewer's sub-turn wrote
 * (issue #955).
 *
 * The arbitration sub-turn runs in a LATER review-phase run, and §8.2's bundle
 * re-presents the reviewer's record beside the implementer's rebuttal — so the
 * reviewer turn's own directory has to survive every completion in between, for
 * exactly the reason {@link DISPUTE_ARTIFACT_DIR_CONTEXT_FIELD} does.
 */
export const RECONSIDERATION_ARTIFACT_DIR_CONTEXT_FIELD = "reconsiderationArtifactDir";
