/**
 * Pure PR-identity contract shared by the Orchestration and Execution layers.
 *
 * `handlers/pr-helpers.ts` owns the *host-touching* PR lookups (`findOpenPr`,
 * `resolveFixPr`, `adoptExistingPrForHead` — all of which take a
 * `RepoHostProvider`). The three helpers below touch nothing: they are the
 * branch-naming convention and two readers of already-recorded task context.
 * They live here so a `core/` module can use them without a runtime import
 * from `handlers/` (DOMAIN.md §2.3 — Orchestration "Depends on: nothing"),
 * the same way #883 moved `ARTIFACT_DIR_PENDING_CONTEXT_FIELD` into
 * `core/artifact-dir-contract.ts`. `handlers/pr-helpers.ts` re-exports all
 * three unchanged, so its existing importers are unaffected.
 */
import type { AiTask } from "./task.js";

export function branchName(issueNumber: number): string {
  return `ai/issue-${issueNumber}`;
}

export function resolvePrContext(task: AiTask): { prUrl?: string; branch?: string } {
  const ctx = task.context as Record<string, unknown>;
  return {
    prUrl: typeof ctx.prUrl === "string" ? ctx.prUrl : undefined,
    branch: typeof ctx.branch === "string" ? ctx.branch : undefined,
  };
}

// Extract a PR number from a GitHub (`/pull/<n>`) or Gitea (`/pulls/<n>`) URL.
// Mirrors the extraction other callers (outbox-effects, conflict-resolution) apply
// to `task.context.prUrl` so the selector handed to a provider is backend-neutral.
export function extractPrNumber(prUrl: string): number | undefined {
  const m = prUrl.match(/\/pulls?\/(\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}
