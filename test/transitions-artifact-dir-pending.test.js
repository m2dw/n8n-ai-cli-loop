import { applyTaskPatch } from '../dist/core/transitions.js';

// Issue #611 review (P2): a failed assignment/admission records
// `artifactDirPending: true` alongside its own (never-created) `artifactDir`.
// Because context patches are merged, a later handler run that reaches its
// own mkdirSync/isSafeArtifactDirAfterRun success and patches `artifactDir`
// to a real, validated path must not leave that stale `true` in place — or
// restore's artifact-reference check keeps skipping the now-real path
// forever, resurrecting a dangling reference once it's later removed.
// `applyTaskPatch` centralizes the fix so every phase handler benefits
// without each call site having to remember to clear the marker itself.

function baseTask(context = {}) {
  return {
    sessionId: 's1',
    issueNumber: 1,
    status: 'queued',
    phase: 'implementation',
    priority: 'normal',
    attempts: {},
    context,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 0,
  };
}

describe('applyTaskPatch artifactDirPending auto-clear', () => {
  test('clears a stale pending marker when a later patch sets artifactDir without repeating it', () => {
    const task = baseTask({ artifactDir: '/artifacts/runs/attempt-1', artifactDirPending: true });

    const patched = applyTaskPatch(task, {
      context: { artifactDir: '/artifacts/runs/attempt-2', outcome: 'success' },
    });

    expect(patched.context.artifactDir).toBe('/artifacts/runs/attempt-2');
    expect(patched.context.artifactDirPending).toBe(false);
  });

  test('leaves an explicit pending: true untouched (a genuine pre-creation failure)', () => {
    const task = baseTask({});

    const patched = applyTaskPatch(task, {
      context: { artifactDir: '/artifacts/runs/attempt-1', artifactDirPending: true },
    });

    expect(patched.context.artifactDirPending).toBe(true);
  });

  test('leaves pending untouched when the patch does not mention artifactDir at all', () => {
    const task = baseTask({ artifactDir: '/artifacts/runs/attempt-1', artifactDirPending: true });

    const patched = applyTaskPatch(task, { context: { someOtherField: 1 } });

    expect(patched.context.artifactDir).toBe('/artifacts/runs/attempt-1');
    expect(patched.context.artifactDirPending).toBe(true);
  });

  test('a patch that spreads the existing context forward (unchanged artifactDir) keeps the existing pending value', () => {
    const task = baseTask({ artifactDir: '/artifacts/runs/attempt-1', artifactDirPending: true });

    const patched = applyTaskPatch(task, {
      context: { ...task.context, reviewRunArtifactDir: '/artifacts/runs/review-1' },
    });

    expect(patched.context.artifactDir).toBe('/artifacts/runs/attempt-1');
    expect(patched.context.artifactDirPending).toBe(true);
  });
});
