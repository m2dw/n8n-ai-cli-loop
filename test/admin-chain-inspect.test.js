/**
 * `admin chain list|show|validate` (issue #789): read-only inspection and
 * GitHub-relationship validation over the dependency-chain registry (#788),
 * exercised end-to-end against a real SQLite-backed registry and a stateful
 * fake `gh` binary (for `validate`'s GraphQL `blockedBy` reads).
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteChainRegistryStore, buildFrozenPrefix } from '../dist/index.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;
const NOW = '2026-08-08T10:00:00.000Z';

// A stateful fake `gh` whose only job is to answer `gh api graphql` calls for
// the `blockedBy` query with a per-issue list of blockers configured under
// FAKE_GH_STATE_DIR/blocked-<n>.json, so `admin chain validate` can be
// exercised end-to-end without a live GitHub connection.
const FAKE_GH_SOURCE = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const stateDir = process.env.FAKE_GH_STATE_DIR;
function blockedFile(n) { return path.join(stateDir, 'blocked-' + n + '.json'); }
function readBlockers(n) {
  try { return JSON.parse(fs.readFileSync(blockedFile(n), 'utf8')); } catch { return []; }
}
function flagValue(name) {
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '-f' || argv[i] === '-F') && argv[i + 1] && argv[i + 1].startsWith(name + '=')) {
      return argv[i + 1].slice(name.length + 1);
    }
  }
  return undefined;
}
if (argv[0] === 'api' && argv[1] === 'graphql') {
  const n = flagValue('number');
  if (process.env.FAKE_GH_FAIL_BLOCKED_BY === n) { process.stderr.write('boom'); process.exit(1); }
  const blockers = readBlockers(n);
  process.stdout.write(JSON.stringify({
    data: { repository: { issue: { blockedBy: { nodes: blockers, pageInfo: { hasNextPage: false, endCursor: null } } } } },
  }));
  process.exit(0);
}
process.exit(1);
`;

let tmpDir;
let dbPath;
let sessionsPath;
let binDir;
let stateDir;
let store;

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

function seedBlockedBy(issueNumber, blockers) {
  writeFileSync(join(stateDir, `blocked-${issueNumber}.json`), JSON.stringify(blockers), 'utf8');
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
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-chain-inspect-test-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  binDir = join(tmpDir, 'bin');
  stateDir = join(tmpDir, 'gh-state');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(tmpDir, 'repo'), { recursive: true });
  writeFileSync(join(binDir, 'gh'), FAKE_GH_SOURCE, 'utf8');
  chmodSync(join(binDir, 'gh'), 0o755);
  writeSession();
  store = new SqliteChainRegistryStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function dbArgs() {
  return ['--db-path', dbPath, '--sessions-path', sessionsPath];
}

async function createChain(overrides = {}) {
  const result = await store.createChain({
    sessionId: 'addon-dev',
    headIssueNumber: 777,
    now: NOW,
    ...overrides,
  });
  if (!result.ok) throw new Error(`createChain failed: ${result.code} ${result.detail ?? ''}`);
  return result.value;
}

describe('admin chain list', () => {
  test('rejects unknown options', () => {
    const r = run(['chain', 'list', ...dbArgs(), '--bogus']);
    expect(r.code).toBe(1);
  });

  test('lists chains across sessions by default', async () => {
    await createChain({ sessionId: 's1', headIssueNumber: 1 });
    await createChain({ sessionId: 's2', headIssueNumber: 2 });
    const r = run(['chain', 'list', '--db-path', dbPath, '--json']);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.count).toBe(2);
    expect(out.chains.map((c) => c.chainId).sort()).toEqual(['chain_1', 'chain_2']);
  });

  test('filters by --session-id', async () => {
    await createChain({ sessionId: 's1', headIssueNumber: 1 });
    await createChain({ sessionId: 's2', headIssueNumber: 2 });
    const r = run(['chain', 'list', '--db-path', dbPath, '--session-id', 's1', '--json']);
    const out = parse(r);
    expect(out.count).toBe(1);
    expect(out.chains[0].chainId).toBe('chain_1');
  });

  test('filters by --sync-status', async () => {
    await createChain({ sessionId: 's1', headIssueNumber: 1 });
    const other = await createChain({ sessionId: 's1', headIssueNumber: 2 });
    await store.setChainSyncState(other.chain.chainId, { status: 'error', error: 'boom', now: NOW });
    const r = run(['chain', 'list', '--db-path', dbPath, '--sync-status', 'error', '--json']);
    const out = parse(r);
    expect(out.count).toBe(1);
    expect(out.chains[0].chainId).toBe('chain_2');
    expect(out.chains[0].syncError).toBe('boom');
  });

  test('defaults to human-readable output; --json gives structured output', async () => {
    await createChain({ sessionId: 's1', headIssueNumber: 1, title: 'Some feature' });
    const human = run(['chain', 'list', '--db-path', dbPath]);
    expect(human.code).toBe(0);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout).toContain('chain_1');
    expect(human.stdout).toContain('Some feature');

    const json = run(['chain', 'list', '--db-path', dbPath, '--json']);
    const out = parse(json);
    expect(out.ok).toBe(true);
  });
});

describe('admin chain show', () => {
  test('reports not_found for an unknown chain-ref', () => {
    const r = run(['chain', 'show', 'chain_999', '--db-path', dbPath, '--json']);
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not_found');
  });

  test('requires a chain-ref positional', () => {
    const r = run(['chain', 'show', '--db-path', dbPath]);
    expect(r.code).toBe(1);
  });

  test('shows members, edges, aliases, and frozen prefixes; resolves by alias too', async () => {
    const created = await createChain({
      sessionId: 's1',
      headIssueNumber: 777,
      title: 'Feature X',
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }],
    });
    const chainId = created.chain.chainId;
    await store.putChainAlias({ alias: 'feature-x', chainId, now: NOW });
    const snapshot = buildFrozenPrefix({
      sessionId: 's1',
      issueNumber: 777,
      chainId,
      graph: { members: created.members, edges: created.edges },
      graphRevision: created.chain.graphRevision,
      graphFingerprint: created.chain.graphFingerprint,
      base: { kind: 'default', baseRef: 'main' },
      frozenAt: NOW,
    });
    const put = await store.putFrozenPrefix(snapshot);
    expect(put.ok).toBe(true);

    // Resolve by the stable chain ID.
    const byId = parse(run(['chain', 'show', chainId, '--db-path', dbPath, '--json']));
    expect(byId.ok).toBe(true);
    expect(byId.chain.title).toBe('Feature X');
    expect(byId.members.map((m) => m.issueNumber).sort()).toEqual([777, 778]);
    expect(byId.edges).toEqual([{ chainId, blockerIssueNumber: 778, blockedIssueNumber: 777, createdAt: NOW }]);
    expect(byId.aliases.map((a) => a.alias)).toEqual(['feature-x']);
    expect(byId.frozenPrefixes).toHaveLength(1);
    expect(byId.frozenPrefixes[0].issueNumber).toBe(777);
    expect(byId.topologicalOrder).toEqual([778, 777]);

    // Resolve the same chain by its alias.
    const byAlias = parse(run(['chain', 'show', 'feature-x', '--db-path', dbPath, '--json']));
    expect(byAlias.chainId).toBe(chainId);

    const human = run(['chain', 'show', chainId, '--db-path', dbPath]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('feature-x');
    expect(human.stdout).toContain('778 -> 777');
  });
});

describe('admin chain validate', () => {
  test('reports not_found for an unknown chain-ref', () => {
    const r = run(['chain', 'validate', 'chain_999', ...dbArgs(), '--json']);
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not_found');
  });

  test('ok: true when GitHub matches the accepted registry graph exactly', async () => {
    const created = await createChain({
      sessionId: 'addon-dev',
      headIssueNumber: 777,
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }],
    });
    const chainId = created.chain.chainId;
    await store.setAcceptedRevision(chainId, created.chain.graphRevision, { now: NOW });
    seedBlockedBy(777, [{ number: 778, state: 'OPEN' }]);
    seedBlockedBy(778, []);

    const r = run(['chain', 'validate', chainId, ...dbArgs(), '--json']);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.structural.ok).toBe(true);
    expect(out.drift.equivalent).toBe(true);
    expect(out.revision.status).toBe('current');
    expect(out.frozenPrefix.registry.ok).toBe(true);
    expect(out.frozenPrefix.observed.ok).toBe(true);
    expect(out.providerErrors).toEqual([]);
  });

  test('reports drift when GitHub has an edge the registry does not', async () => {
    const created = await createChain({
      sessionId: 'addon-dev',
      headIssueNumber: 777,
      members: [{ issueNumber: 777 }, { issueNumber: 778 }],
      edges: [],
    });
    const chainId = created.chain.chainId;
    seedBlockedBy(777, [{ number: 778, state: 'OPEN' }]);
    seedBlockedBy(778, []);

    const r = run(['chain', 'validate', chainId, ...dbArgs(), '--json']);
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.drift.equivalent).toBe(false);
    const edgeMismatch = out.drift.diagnostics.find((d) => d.code === 'edge_mismatch');
    expect(edgeMismatch).toBeDefined();
    expect(edgeMismatch.observedEdges).toEqual([{ blockerIssueNumber: 778, blockedIssueNumber: 777 }]);
  });

  test('reports a structural cycle found only in the observed GitHub graph', async () => {
    const created = await createChain({
      sessionId: 'addon-dev',
      headIssueNumber: 777,
      members: [{ issueNumber: 777 }, { issueNumber: 778 }],
      edges: [],
    });
    const chainId = created.chain.chainId;
    // GitHub reports each blocking the other.
    seedBlockedBy(777, [{ number: 778, state: 'OPEN' }]);
    seedBlockedBy(778, [{ number: 777, state: 'OPEN' }]);

    const r = run(['chain', 'validate', chainId, ...dbArgs(), '--json']);
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.structural.ok).toBe(false);
    expect(out.structural.diagnostics.some((d) => d.code === 'cycle')).toBe(true);
  });

  test('reports a missing_member when GitHub names a blocker that is not a declared chain member', async () => {
    const created = await createChain({
      sessionId: 'addon-dev',
      headIssueNumber: 777,
      members: [{ issueNumber: 777 }],
      edges: [],
    });
    const chainId = created.chain.chainId;
    // 778 blocks 777 on GitHub, but 778 was never declared a member of this chain.
    seedBlockedBy(777, [{ number: 778, state: 'OPEN' }]);

    const r = run(['chain', 'validate', chainId, ...dbArgs(), '--json']);
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.structural.diagnostics.some((d) => d.code === 'missing_member' && d.issues.includes(778))).toBe(true);
  });

  test('a per-member provider fetch failure is reported separately from structural findings', async () => {
    const created = await createChain({
      sessionId: 'addon-dev',
      headIssueNumber: 777,
      members: [{ issueNumber: 777 }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }],
    });
    const chainId = created.chain.chainId;
    await store.setAcceptedRevision(chainId, created.chain.graphRevision, { now: NOW });
    seedBlockedBy(778, []);
    // No blocked-777.json seeded; instead force the fake gh to fail issue 777.

    const r = run(['chain', 'validate', chainId, ...dbArgs(), '--json'], { FAKE_GH_FAIL_BLOCKED_BY: '777' });
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.providerErrors).toHaveLength(1);
    expect(out.providerErrors[0].issueNumber).toBe(777);
    // The fetch failure is not folded into the structural diagnostics list.
    expect(out.structural.ok).toBe(true);
    // Nor into drift or the observed-side frozen-prefix check: the observed
    // graph is missing every edge into #777, so both are indeterminate
    // rather than a false conflict.
    expect(out.drift.indeterminate).toBe(true);
    expect(out.frozenPrefix.observed.indeterminate).toBe(true);
  });

  test('a provider failure does not report a false frozen-prefix conflict from the incomplete observed graph', async () => {
    // Reproduces the review scenario: #778 -> #777 is both registered and
    // frozen, but #777's GitHub fetch fails, so the observed graph never
    // learns whether that edge still exists on GitHub.
    const created = await createChain({
      sessionId: 'addon-dev',
      headIssueNumber: 777,
      members: [{ issueNumber: 777 }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }],
    });
    const chainId = created.chain.chainId;
    await store.setAcceptedRevision(chainId, created.chain.graphRevision, { now: NOW });
    const snapshot = buildFrozenPrefix({
      sessionId: 'addon-dev',
      issueNumber: 777,
      chainId,
      graph: { members: created.members, edges: created.edges },
      graphRevision: created.chain.graphRevision,
      graphFingerprint: created.chain.graphFingerprint,
      base: { kind: 'default', baseRef: 'main' },
      frozenAt: NOW,
    });
    await store.putFrozenPrefix(snapshot);
    seedBlockedBy(778, []);
    // No blocked-777.json seeded; force the fake gh to fail issue 777 instead
    // of reporting it as having no blockers (which would look like the
    // frozen ancestor edge was dropped).

    const r = run(['chain', 'validate', chainId, ...dbArgs(), '--json'], { FAKE_GH_FAIL_BLOCKED_BY: '777' });
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.providerErrors).toHaveLength(1);
    // The registry-side check is unaffected (it never reads GitHub) and
    // still passes; only the observed-side check is indeterminate.
    expect(out.frozenPrefix.registry.ok).toBe(true);
    expect(out.frozenPrefix.observed.indeterminate).toBe(true);
    expect(out.frozenPrefix.observed.ok).toBeUndefined();
    expect(out.drift.indeterminate).toBe(true);
    expect(out.drift.equivalent).toBeUndefined();
  });

  test('reports an unaccepted revision as not current', async () => {
    const created = await createChain({
      sessionId: 'addon-dev',
      headIssueNumber: 777,
      members: [{ issueNumber: 777 }],
      edges: [],
    });
    const chainId = created.chain.chainId;
    seedBlockedBy(777, []);

    const r = run(['chain', 'validate', chainId, ...dbArgs(), '--json']);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.revision.status).toBe('unaccepted');
    expect(out.revision.acceptedRevision).toBeNull();
  });

  test('reports a frozen-prefix conflict when GitHub drops a frozen ancestor edge', async () => {
    const created = await createChain({
      sessionId: 'addon-dev',
      headIssueNumber: 777,
      members: [{ issueNumber: 777 }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }],
    });
    const chainId = created.chain.chainId;
    await store.setAcceptedRevision(chainId, created.chain.graphRevision, { now: NOW });
    const snapshot = buildFrozenPrefix({
      sessionId: 'addon-dev',
      issueNumber: 777,
      chainId,
      graph: { members: created.members, edges: created.edges },
      graphRevision: created.chain.graphRevision,
      graphFingerprint: created.chain.graphFingerprint,
      base: { kind: 'default', baseRef: 'main' },
      frozenAt: NOW,
    });
    await store.putFrozenPrefix(snapshot);

    // GitHub now reports 777 as having no blockers at all — the frozen
    // ancestor 778 is gone.
    seedBlockedBy(777, []);
    seedBlockedBy(778, []);

    const r = run(['chain', 'validate', chainId, ...dbArgs(), '--json']);
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.frozenPrefix.observed.ok).toBe(false);
    expect(out.frozenPrefix.observed.violations.some((v) => v.code === 'ancestor_removed')).toBe(true);
  });

  test('never mutates the registry: repeated validation leaves revision, sync state, and fingerprints unchanged', async () => {
    const created = await createChain({
      sessionId: 'addon-dev',
      headIssueNumber: 777,
      members: [{ issueNumber: 777 }],
      edges: [],
    });
    const chainId = created.chain.chainId;
    seedBlockedBy(777, []);

    run(['chain', 'validate', chainId, ...dbArgs(), '--json']);
    run(['chain', 'validate', chainId, ...dbArgs(), '--json']);

    const record = await store.getChainRecord(chainId);
    expect(record.graphRevision).toBe(created.chain.graphRevision);
    expect(record.graphFingerprint).toBe(created.chain.graphFingerprint);
    expect(record.syncStatus).toBe('unknown');
    expect(record.syncCheckedAt).toBeUndefined();
    expect(record.syncedAt).toBeUndefined();
    expect(record.rev).toBe(created.chain.rev);
  });

  test('defaults to human-readable output; --json gives structured output', async () => {
    const created = await createChain({
      sessionId: 'addon-dev',
      headIssueNumber: 777,
      members: [{ issueNumber: 777 }],
      edges: [],
    });
    const chainId = created.chain.chainId;
    await store.setAcceptedRevision(chainId, created.chain.graphRevision, { now: NOW });
    seedBlockedBy(777, []);

    const human = run(['chain', 'validate', chainId, ...dbArgs()]);
    expect(human.code).toBe(0);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout).toContain('OK');

    const json = run(['chain', 'validate', chainId, ...dbArgs(), '--json']);
    expect(parse(json).ok).toBe(true);
  });
});
