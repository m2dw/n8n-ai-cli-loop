/**
 * `admin issue activate|suspend` (issue #787): CLI wiring for the reusable
 * automation-label activation/suspension service, exercised end-to-end
 * against a stateful fake `gh` binary.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;

// A stateful fake `gh` that tracks per-issue labels as a JSON array under
// FAKE_GH_STATE_DIR/issue-<n>.json, so a suspend/activate round trip can be
// observed end-to-end (view -> label add/remove -> view again) without a
// live GitHub connection. Written as a Node script (not a shell script) so
// path/JSON parsing is exact rather than regex-fragile.
const FAKE_GH_SOURCE = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const stateDir = process.env.FAKE_GH_STATE_DIR;
function stateFile(n) { return path.join(stateDir, 'issue-' + n + '.json'); }
function readLabels(n) {
  try { return JSON.parse(fs.readFileSync(stateFile(n), 'utf8')); } catch { return []; }
}
function writeLabels(n, labels) { fs.writeFileSync(stateFile(n), JSON.stringify(labels)); }

if (argv[0] === 'issue' && argv[1] === 'view') {
  const n = argv[2];
  if (process.env.FAKE_GH_FAIL_VIEW === n) { process.stderr.write('boom'); process.exit(1); }
  const labels = readLabels(n);
  process.stdout.write(JSON.stringify({ labels: labels.map((name) => ({ name })) }));
  process.exit(0);
}
if (argv[0] === 'api') {
  const resource = argv[1];
  const methodIdx = argv.indexOf('--method');
  const method = methodIdx >= 0 ? argv[methodIdx + 1] : 'GET';
  const m = resource.match(/^repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)\\/labels(?:\\/(.+))?$/);
  if (!m) process.exit(1);
  const n = m[1];
  const labelFromPath = m[2] ? decodeURIComponent(m[2]) : undefined;
  if (method === 'POST') {
    const fieldIdx = argv.indexOf('--field');
    const field = fieldIdx >= 0 ? argv[fieldIdx + 1] : '';
    const label = field.replace(/^labels\\[\\]=/, '');
    if (process.env.FAKE_GH_FAIL_ADD === label) { process.stderr.write('boom'); process.exit(1); }
    const labels = readLabels(n);
    if (!labels.includes(label)) labels.push(label);
    writeLabels(n, labels);
    process.stdout.write('[]');
    process.exit(0);
  }
  if (method === 'DELETE') {
    if (process.env.FAKE_GH_FAIL_REMOVE === labelFromPath) { process.stderr.write('boom'); process.exit(1); }
    const labels = readLabels(n).filter((l) => l !== labelFromPath);
    writeLabels(n, labels);
    process.exit(0);
  }
  process.exit(1);
}
process.exit(1);
`;

let tmpDir;
let dbPath;
let sessionsPath;
let binDir;
let stateDir;

function writeSession(overrides = {}) {
  const session = {
    sessionId: 'addon-dev',
    repoKey: 'some-repo',
    repoRoot: join(tmpDir, 'repo'),
    githubRepo: 'm2dw/some-repo',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: {},
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    ...overrides,
  };
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [session] }), 'utf8');
  return session;
}

function seedIssueLabels(issueNumber, labels) {
  writeFileSync(join(stateDir, `issue-${issueNumber}.json`), JSON.stringify(labels), 'utf8');
}

function readIssueLabels(issueNumber) {
  try {
    return JSON.parse(readFileSync(join(stateDir, `issue-${issueNumber}.json`), 'utf8'));
  } catch {
    return [];
  }
}

function run(args, envOverrides = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_GH_STATE_DIR: stateDir,
        ...envOverrides,
      },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function parse(result) {
  return JSON.parse(result.stdout.trim());
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-issue-activation-test-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  binDir = join(tmpDir, 'bin');
  stateDir = join(tmpDir, 'gh-state');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  // `gh` is spawned with the session's repoRoot as its cwd; it must exist.
  mkdirSync(join(tmpDir, 'repo'), { recursive: true });
  writeFileSync(join(binDir, 'gh'), FAKE_GH_SOURCE, 'utf8');
  chmodSync(join(binDir, 'gh'), 0o755);
  writeSession();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function commonArgs() {
  // `issue activate`/`issue suspend` default to human-readable output
  // (operator-facing preview/--yes convention); pass --json for stable
  // structured assertions.
  return ['--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbPath, '--json'];
}

describe('admin issue suspend', () => {
  test('rejects unknown options without touching gh', () => {
    const r = run(['issue', 'suspend', '101', ...commonArgs(), '--bogus']);
    expect(r.code).toBe(1);
  });

  test('requires an issue number list', () => {
    const r = run(['issue', 'suspend', ...commonArgs()]);
    expect(r.code).toBe(1);
  });

  test('preview (no --yes) reports what would be removed without mutating labels', () => {
    seedIssueLabels(101, ['status:needs-implementation', 'agent:claude', 'ai:blocked']);
    const r = run(['issue', 'suspend', '101', ...commonArgs()]);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.dryRun).toBe(true);
    expect(out.results[0].removed.sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    // Nothing actually mutated.
    expect(readIssueLabels(101).sort()).toEqual(['agent:claude', 'ai:blocked', 'status:needs-implementation']);
  });

  test('--yes removes execution labels and preserves unrelated ones', () => {
    seedIssueLabels(101, ['status:needs-implementation', 'agent:claude', 'ai:blocked', 'priority:high']);
    const r = run(['issue', 'suspend', '101', ...commonArgs(), '--yes']);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.results[0].removed.sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    expect(out.results[0].preserved.sort()).toEqual(['ai:blocked', 'priority:high']);
    expect(readIssueLabels(101).sort()).toEqual(['ai:blocked', 'priority:high']);
  });

  test('is idempotent: a repeated --yes call reports the standing suspension and changes nothing further', () => {
    seedIssueLabels(101, ['status:needs-implementation', 'agent:claude']);
    run(['issue', 'suspend', '101', ...commonArgs(), '--yes']);
    const r = run(['issue', 'suspend', '101', ...commonArgs(), '--yes']);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.results[0].removed).toEqual([]);
    expect(out.results[0].alreadySuspended).toBe(true);
    expect(out.results[0].restorable.sort()).toEqual(['agent:claude', 'status:needs-implementation']);
  });

  test('handles multiple issues in one command, each independently', () => {
    seedIssueLabels(101, ['status:needs-implementation', 'agent:claude']);
    seedIssueLabels(102, ['status:needs-review', 'agent:codex', 'priority:low']);
    const r = run(['issue', 'suspend', '101,102', ...commonArgs(), '--yes']);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.results).toHaveLength(2);
    expect(readIssueLabels(101)).toEqual([]);
    expect(readIssueLabels(102)).toEqual(['priority:low']);
  });

  test('preview after a partial-failure suspend reports the full restorable set, not just the newly-removed label(s)', () => {
    seedIssueLabels(101, ['status:needs-implementation', 'agent:claude']);
    // First --yes run removes status:needs-implementation but fails to
    // remove agent:claude, leaving a standing suspension record for just
    // status:needs-implementation.
    run(['issue', 'suspend', '101', ...commonArgs(), '--yes'], { FAKE_GH_FAIL_REMOVE: 'agent:claude' });
    expect(readIssueLabels(101)).toEqual(['agent:claude']);

    // A subsequent preview must show what --yes would actually restore: the
    // union of the standing record (status:needs-implementation) and the
    // label this run would newly remove (agent:claude) — not just the latter.
    const r = run(['issue', 'suspend', '101', ...commonArgs()]);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.dryRun).toBe(true);
    expect(out.results[0].removed).toEqual(['agent:claude']);
    expect(out.results[0].restorable.sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    // Preview must not mutate.
    expect(readIssueLabels(101)).toEqual(['agent:claude']);
  });

  test('a per-issue failure does not block the rest of the batch, and the command exits non-zero', () => {
    seedIssueLabels(101, ['status:needs-implementation']);
    seedIssueLabels(102, ['status:needs-review']);
    const r = run(['issue', 'suspend', '101,102', ...commonArgs(), '--yes'], { FAKE_GH_FAIL_VIEW: '101' });
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.results.find((x) => x.issueNumber === 101).ok).toBe(false);
    expect(out.results.find((x) => x.issueNumber === 102).ok).toBe(true);
    expect(readIssueLabels(102)).toEqual([]);
  });

  test('a per-issue store exception (not a returned outcome) does not block the rest of the batch (issue #787 review)', () => {
    seedIssueLabels(101, ['status:needs-implementation']);
    seedIssueLabels(102, ['status:needs-review']);
    // Corrupt issue 101's `labels` column so a later read throws instead of
    // returning a value or a `{ ok: false }` outcome — simulating a
    // locked/corrupt row rather than a provider-reported failure.
    const db = new Database(dbPath);
    db.exec(
      `CREATE TABLE IF NOT EXISTS issue_automation_suspension (
         session_id TEXT NOT NULL, issue_number INTEGER NOT NULL, labels TEXT NOT NULL,
         operation_id TEXT NOT NULL, suspended_at TEXT NOT NULL, updated_at TEXT NOT NULL,
         rev INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (session_id, issue_number))`,
    );
    db.prepare(
      `INSERT INTO issue_automation_suspension
         (session_id, issue_number, labels, operation_id, suspended_at, updated_at, rev)
       VALUES ('addon-dev', 101, 'not-json', 'op-seed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)`,
    ).run();
    db.close();

    const r = run(['issue', 'suspend', '101,102', ...commonArgs(), '--yes']);
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.results).toHaveLength(2);
    expect(out.results.find((x) => x.issueNumber === 101).ok).toBe(false);
    expect(out.results.find((x) => x.issueNumber === 102).ok).toBe(true);
    expect(readIssueLabels(102)).toEqual([]);
  });
});

describe('admin issue activate', () => {
  test('restores exactly what a prior suspend removed', () => {
    seedIssueLabels(101, ['status:needs-implementation', 'agent:claude', 'ai:blocked']);
    run(['issue', 'suspend', '101', ...commonArgs(), '--yes']);
    expect(readIssueLabels(101).sort()).toEqual(['ai:blocked']);

    const r = run(['issue', 'activate', '101', ...commonArgs(), '--yes']);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.results[0].added.sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    expect(readIssueLabels(101).sort()).toEqual(['agent:claude', 'ai:blocked', 'status:needs-implementation']);
  });

  test('is a safe no-op when nothing was suspended', () => {
    seedIssueLabels(101, ['priority:high']);
    const r = run(['issue', 'activate', '101', ...commonArgs(), '--yes']);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.results[0].alreadyActive).toBe(true);
    expect(readIssueLabels(101)).toEqual(['priority:high']);
  });

  test('preview (no --yes) reports what would be restored without mutating labels', () => {
    seedIssueLabels(101, ['status:needs-implementation', 'agent:claude']);
    run(['issue', 'suspend', '101', ...commonArgs(), '--yes']);
    expect(readIssueLabels(101)).toEqual([]);

    const r = run(['issue', 'activate', '101', ...commonArgs()]);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.dryRun).toBe(true);
    expect(out.results[0].added.sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    // Preview must not mutate: the state file is still empty.
    expect(readIssueLabels(101)).toEqual([]);
  });
});
