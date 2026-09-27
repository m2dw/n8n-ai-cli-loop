import { readFileSync } from 'fs';
import { join } from 'path';

// Contract for issue #1015: Metrics must run on a predictable daily cadence
// and on explicit operator request, not on every push to main (~10 min/run,
// stacked-PR merges produced many redundant runs against a single commit).

const WORKFLOW_PATH = join(process.cwd(), '.github/workflows/metrics.yml');

function loadWorkflow() {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

// Extract the `on:` trigger block (from the `on:` line up to the next
// top-level key, e.g. `jobs:`) without pulling in a YAML parser dependency —
// this workflow's trigger section is a small, fully-controlled shape.
function extractTriggerBlock(yaml) {
  const lines = yaml.split('\n');
  const startIndex = lines.findIndex(line => /^on:/.test(line));
  if (startIndex === -1) {
    throw new Error('metrics.yml has no top-level `on:` trigger block');
  }
  const rest = lines.slice(startIndex + 1);
  const endOffset = rest.findIndex(line => /^\S/.test(line));
  const block = endOffset === -1 ? rest : rest.slice(0, endOffset);
  return [lines[startIndex], ...block].join('\n');
}

describe('Metrics workflow trigger policy (#1015)', () => {
  const yaml = loadWorkflow();
  const triggerBlock = extractTriggerBlock(yaml);

  test('does not trigger on push', () => {
    expect(triggerBlock).not.toMatch(/^\s*push:/m);
  });

  test('supports manual workflow_dispatch', () => {
    expect(triggerBlock).toMatch(/^\s*workflow_dispatch:/m);
  });

  test('runs once daily via schedule at a non-round UTC minute', () => {
    const scheduleMatch = triggerBlock.match(/^\s*schedule:\s*$/m);
    expect(scheduleMatch).not.toBeNull();

    const cronMatches = [...triggerBlock.matchAll(/cron:\s*'([^']+)'/g)];
    expect(cronMatches).toHaveLength(1);

    const [minute, hour, dayOfMonth, month, dayOfWeek] = cronMatches[0][1].split(/\s+/);
    // A once-daily cadence means every field except minute/hour is a wildcard.
    expect(dayOfMonth).toBe('*');
    expect(month).toBe('*');
    expect(dayOfWeek).toBe('*');
    expect(hour).not.toBe('*');
    // Non-round minute avoids herding onto the same minute as everyone
    // else's on-the-hour scheduled workflows.
    expect(minute).not.toBe('0');
  });

  test('preserves the guarded bot-commit step with [skip ci]', () => {
    expect(yaml).toContain('npm run metrics');
    expect(yaml).toContain('git diff --cached --quiet');
    expect(yaml).toContain('[skip ci]');
    expect(yaml).toContain('git push');
  });

  test('commits only the generated metric artifacts', () => {
    expect(yaml).toMatch(/git add docs\/metrics\/latest\.md docs\/metrics\/latest\.json docs\/metrics\/badges\//);
  });
});
