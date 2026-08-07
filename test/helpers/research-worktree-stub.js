// Shared stubs for the research phase's worktree seams (issue #855).
//
// Research materializes a per-run worktree detached at the freshly fetched
// origin/<base> commit and runs the agent there. The handler tests that predate
// that change (artifacts, outcomes, prompts, denials, publication, workspace
// settings) are about the handler's own logic, not about git, so they inject
// these stubs: `prepare` hands back the session `repoRoot` as the workspace
// path, which keeps every existing cwd/path assertion meaningful, and the lock
// stub keeps tests off the real `~/.local/state` lock directory.
//
// The real lifecycle — fetch, SHA resolution, detached creation, cleanup — is
// covered against real git repositories in test/research-worktree.test.js.

/** A base SHA that is shaped like a real one, so format checks stay honest. */
export const STUB_BASE_SHA = 'a'.repeat(40);

/**
 * Worktree runtime + issue lock stubs plus a call log.
 *
 * @param {object} [opts]
 * @param {string} [opts.workspacePath] Path handed back as the workspace root;
 *   defaults to the `repoRoot` the handler asked to prepare from.
 * @param {object} [opts.prepareFailure] `{ stage, error }` to fail preparation.
 * @param {boolean} [opts.lockHeld] When true, the issue lock refuses to acquire.
 */
export function stubResearchWorktree(opts = {}) {
  const calls = { prepare: [], release: [], acquire: [], release_lock: [] };
  const runtime = {
    prepare(input) {
      calls.prepare.push(input);
      if (opts.prepareFailure) {
        return { ok: false, stage: opts.prepareFailure.stage, error: opts.prepareFailure.error };
      }
      return {
        ok: true,
        workspace: {
          path: opts.workspacePath ?? input.repoRoot,
          worktreeId: `${input.sessionId}/issue-${input.issueNumber}/research-${input.runId}`,
          baseBranch: input.baseBranch,
          baseRef: `refs/remotes/origin/${input.baseBranch}`,
          baseSha: STUB_BASE_SHA,
        },
      };
    },
    release(input) {
      calls.release.push(input);
      return { ok: true, removed: true };
    },
  };
  const issueLock = {
    acquire(ownerId, sessionId, issueNumber) {
      calls.acquire.push({ ownerId, sessionId, issueNumber });
      if (opts.lockHeld) {
        return { locked: false, ownerContextId: 'other-run', ownerStartedAt: '2026-08-07T00:00:00.000Z' };
      }
      return { locked: true, ownerContextId: ownerId, ownerStartedAt: '2026-08-07T00:00:00.000Z' };
    },
    release(ownerId, sessionId, issueNumber) {
      calls.release_lock.push({ ownerId, sessionId, issueNumber });
      return { released: true };
    },
  };
  return { runtime, issueLock, calls };
}

/**
 * Wrap `createResearchHandler` so the existing positional call sites keep
 * working while the worktree seams are stubbed.
 */
export function researchHandlerFactory(createResearchHandler, opts = {}) {
  return (context, runner, evidenceRuntime, prepareWorkspace, verifyWorkspace, releaseWorkspace) => {
    const stub = stubResearchWorktree(opts);
    return createResearchHandler(
      context,
      runner,
      evidenceRuntime,
      prepareWorkspace,
      verifyWorkspace,
      releaseWorkspace,
      { runtime: stub.runtime, issueLock: stub.issueLock },
    );
  };
}
