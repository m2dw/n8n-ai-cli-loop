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
