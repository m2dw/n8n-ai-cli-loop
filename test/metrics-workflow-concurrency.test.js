import { readFileSync } from 'fs';
import { join } from 'path';

// Contract for issue #1016: superseded Metrics runs must be cancelled so
// that scheduled/workflow_dispatch overlap can never race two writers to
// the `git push` step (non-fast-forward push rejections observed in the
// August sample — see issue #1016).

const WORKFLOW_PATH = join(process.cwd(), '.github/workflows/metrics.yml');

function loadWorkflow() {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

// Extract a named top-level block (from `<key>:` up to the next top-level
// key) without pulling in a YAML parser dependency, mirroring the approach
// in metrics-workflow-trigger.test.js.
function extractTopLevelBlock(yaml, key) {
  const lines = yaml.split('\n');
  const startIndex = lines.findIndex(line => new RegExp(`^${key}:`).test(line));
  if (startIndex === -1) {
    throw new Error(`metrics.yml has no top-level \`${key}:\` block`);
  }
  const rest = lines.slice(startIndex + 1);
  const endOffset = rest.findIndex(line => /^\S/.test(line));
  const block = endOffset === -1 ? rest : rest.slice(0, endOffset);
  return [lines[startIndex], ...block].join('\n');
}

describe('Metrics workflow concurrency policy (#1016)', () => {
  const yaml = loadWorkflow();

  test('declares a top-level concurrency block', () => {
    expect(yaml).toMatch(/^concurrency:\s*$/m);
  });

  test('uses a stable group not keyed on the triggering event', () => {
    const block = extractTopLevelBlock(yaml, 'concurrency');
    const groupMatch = block.match(/^\s*group:\s*(.+)\s*$/m);
    expect(groupMatch).not.toBeNull();

    const group = groupMatch[1].trim();
    // Stable: no interpolation of github.event_name / github.run_id / a
    // matrix value, which would put schedule and workflow_dispatch runs
    // into different lanes and defeat cancellation between them.
    expect(group).not.toMatch(/event_name/);
    expect(group).not.toMatch(/run_id/);
    expect(group).not.toMatch(/matrix\./);
  });

  test('enables cancel-in-progress so superseded runs are cancelled outright', () => {
    const block = extractTopLevelBlock(yaml, 'concurrency');
    expect(block).toMatch(/^\s*cancel-in-progress:\s*true\s*$/m);
  });

  test('the concurrency block precedes jobs and covers the whole workflow', () => {
    const concurrencyIndex = yaml.indexOf('\nconcurrency:');
    const jobsIndex = yaml.indexOf('\njobs:');
    expect(concurrencyIndex).toBeGreaterThan(-1);
    expect(jobsIndex).toBeGreaterThan(-1);
    expect(concurrencyIndex).toBeLessThan(jobsIndex);
  });
});
