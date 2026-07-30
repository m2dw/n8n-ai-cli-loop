import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MemoryTaskStore } from '../dist/index.js';
import { collectActiveTasks } from '../dist/cli/admin-ui.js';

// Issue #613/P1: `TaskStore` gained listSessionTasks/recoverTask/recoverHandoff/
// recoverCapHandoff/clearTaskDelay so admin code can be typed against the port
// instead of the concrete `SqliteTaskStore` adapter (docs/admin-task-handoff-
// ports-contract.md §10/§11). These tests pin the two invariants that
// promotion is supposed to establish.

describe('TaskStore composition-root confinement (issue #613/P1, §11 item 7)', () => {
  // Only these five files are permitted to construct `SqliteTaskStore` — each
  // is its own composition root (admin.ts/admin-ui.ts for the admin surface;
  // enqueue-task.ts/github-intake.ts/run-one-phase.ts are independent CLI
  // entrypoints, out of this document's charter). No other source file may
  // import the concrete adapter as a value: a future admin resource module
  // that does so would silently reintroduce the dependency this port exists
  // to remove.
  const ALLOWED_IMPORTERS = new Set([
    'src/cli/admin.ts',
    'src/cli/admin-ui.ts',
    'src/cli/enqueue-task.ts',
    'src/cli/github-intake.ts',
    'src/cli/run-one-phase.ts',
  ]);

  test('no other source file imports SqliteTaskStore', () => {
    const grep = execFileSync(
      'grep',
      ['-rl', '--include=*.ts', 'SqliteTaskStore', join(process.cwd(), 'src')],
      { encoding: 'utf8' },
    );
    const importers = grep
      .split('\n')
      .filter(Boolean)
      .map((p) => p.slice(process.cwd().length + 1))
      .filter((rel) => {
        const contents = readFileSync(join(process.cwd(), rel), 'utf8');
        return /import\s+\{[^}]*SqliteTaskStore/.test(contents);
      });

    expect(new Set(importers)).toEqual(ALLOWED_IMPORTERS);
  });
});

describe('admin-ui read path typed against TaskStore (issue #613/P1, §11 item 8)', () => {
  test('collectActiveTasks accepts a MemoryTaskStore (not just SqliteTaskStore)', async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTask({ sessionId: 'addon-dev', issueNumber: 1, phase: 'implementation', now: '2026-06-06T00:00:00.000Z' });

    const tasks = await collectActiveTasks(store, ['addon-dev']);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].issueNumber).toBe(1);
  });
});
