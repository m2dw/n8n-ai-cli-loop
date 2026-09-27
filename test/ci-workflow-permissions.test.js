import { readFileSync } from 'fs';
import { join } from 'path';

// Contract for issue #1189: the CI workflow declares an explicit
// least-privilege GITHUB_TOKEN (contents: read), grants no write scope, does
// not persist checkout credentials, and keeps its push/pull_request triggers
// and npm test contract unchanged.

const WORKFLOW_PATH = join(process.cwd(), '.github/workflows/ci.yml');

function loadWorkflow() {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

// Extract a top-level block (from `<key>:` up to the next top-level key)
// without pulling in a YAML parser dependency.
function extractTopLevelBlock(yaml, key) {
  const lines = yaml.split('\n');
  const startIndex = lines.findIndex(line => new RegExp(`^${key}:`).test(line));
  if (startIndex === -1) {
    throw new Error(`ci.yml has no top-level \`${key}:\` block`);
  }
  const rest = lines.slice(startIndex + 1);
  const endOffset = rest.findIndex(line => /^\S/.test(line));
  const block = endOffset === -1 ? rest : rest.slice(0, endOffset);
  return [lines[startIndex], ...block].join('\n');
}

function withoutComments(block) {
  return block
    .split('\n')
    .filter(line => !/^\s*#/.test(line) && line.trim() !== '')
    .join('\n');
}

describe('CI workflow token permissions (#1189)', () => {
  const yaml = loadWorkflow();

  test('declares a top-level permissions block with contents: read only', () => {
    const block = withoutComments(extractTopLevelBlock(yaml, 'permissions'));
    expect(block).toBe('permissions:\n  contents: read');
  });

  test('grants no write permission anywhere', () => {
    expect(yaml).not.toMatch(/:\s*write\b/);
    expect(yaml).not.toMatch(/write-all/);
  });

  test('does not persist checkout credentials', () => {
    expect(yaml).toMatch(/uses: actions\/checkout@v4\n\s+with:\n(?:\s+#.*\n)*\s+persist-credentials: false/);
  });

  test('keeps push (main) and pull_request triggers', () => {
    const triggers = withoutComments(extractTopLevelBlock(yaml, 'on'));
    expect(triggers).toBe('on:\n  push:\n    branches: [main]\n  pull_request:');
  });

  test('keeps the npm ci / npm test contract', () => {
    expect(yaml).toMatch(/- run: npm ci\n\s+- run: npm test\s*$/);
  });
});
