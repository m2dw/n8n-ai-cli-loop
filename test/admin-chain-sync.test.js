/**
 * `admin chain sync` (issue #892): the mutating GitHub-to-registry import,
 * exercised end-to-end against a real SQLite-backed chain registry (#788) and
 * the same stateful fake `gh` binary `chain validate` (#789) is tested with.
 *
 * The properties pinned here are the ones the side-effect contract names: a
 * valid import lands atomically, an invalid one leaves the previously accepted
 * graph exactly where it was, transient provider failures are told apart from
 * structural graph failures, and `--all` reports every failure while still
 * importing the chains that pass.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteChainRegistryStore, buildFrozenPrefix } from '../dist/index.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;
const NOW = '2026-08-08T10:00:00.000Z';

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
  // A second writer, run exactly once while the command under test is reading
  // GitHub — the window an overlapping run genuinely lands in.
  const race = process.env.FAKE_GH_RACE_SCRIPT;
  if (race && !fs.existsSync(path.join(stateDir, 'raced'))) {
    fs.writeFileSync(path.join(stateDir, 'raced'), '1');
    // Nothing of the child's may reach stdout: that stream is the GraphQL
    // response the command under test parses.
    require('child_process').execFileSync(process.execPath, [race], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
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

function writeSessions(sessions) {
  writeFileSync(sessionsPath, JSON.stringify({ sessions }), 'utf8');
}

function session(overrides = {}) {
  return {
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
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-chain-sync-test-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  binDir = join(tmpDir, 'bin');
  stateDir = join(tmpDir, 'gh-state');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(tmpDir, 'repo'), { recursive: true });
  writeFileSync(join(binDir, 'gh'), FAKE_GH_SOURCE, 'utf8');
  chmodSync(join(binDir, 'gh'), 0o755);
  writeSessions([session()]);
  store = new SqliteChainRegistryStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function dbArgs() {
  return ['--db-path', dbPath, '--sessions-path', sessionsPath];
}

/**
 * A script the fake `gh` runs mid-read, standing in for a concurrent
 * `chain sync` that has already recorded its own verdict about this chain.
 */
function writeRaceScript(chainId) {
  const scriptPath = join(tmpDir, 'race.mjs');
  const dist = new URL('../dist/index.js', import.meta.url).href;
  writeFileSync(
    scriptPath,
    `import { SqliteChainRegistryStore } from ${JSON.stringify(dist)};
const store = new SqliteChainRegistryStore(${JSON.stringify(dbPath)});
const result = await store.setChainSyncState(${JSON.stringify(chainId)}, {
  status: 'error',
  error: 'recorded by a newer run',
  now: '2026-08-08T11:00:00.000Z',
});
store.close();
if (!result.ok) { console.error(result.code); process.exit(1); }
`,
    'utf8',
  );
  return scriptPath;
}

/**
 * A script the fake `gh` runs mid-read, standing in for a task starting while
 * this command talks to GitHub: it freezes the chain's head against the graph
 * the command is about to replace. Nothing it writes touches a chain row, which
 * is precisely why the import's compare-and-set cannot notice it.
 */
function writeFreezeScript(created) {
  const scriptPath = join(tmpDir, 'freeze.mjs');
  const dist = new URL('../dist/index.js', import.meta.url).href;
  const snapshotInput = {
    sessionId: 'addon-dev',
    issueNumber: 777,
    chainId: created.chain.chainId,
    graph: { members: created.members, edges: created.edges },
    graphRevision: created.chain.graphRevision,
    graphFingerprint: created.chain.graphFingerprint,
    base: { kind: 'default', baseRef: 'main' },
    frozenAt: NOW,
  };
  writeFileSync(
    scriptPath,
    `import { SqliteChainRegistryStore, buildFrozenPrefix } from ${JSON.stringify(dist)};
const store = new SqliteChainRegistryStore(${JSON.stringify(dbPath)});
const result = await store.putFrozenPrefix(buildFrozenPrefix(${JSON.stringify(snapshotInput)}));
store.close();
if (!result.ok) { console.error(result.code); process.exit(1); }
`,
    'utf8',
  );
  return scriptPath;
}

/** A chain whose revision 1 is already the accepted graph. */
async function createAcceptedChain(overrides = {}) {
  const result = await store.createChain({
    sessionId: 'addon-dev',
    headIssueNumber: 777,
    now: NOW,
    ...overrides,
  });
  if (!result.ok) throw new Error(`createChain failed: ${result.code} ${result.detail ?? ''}`);
  const accepted = await store.setAcceptedRevision(result.value.chain.chainId, result.value.chain.graphRevision, {
    now: NOW,
  });
  if (!accepted.ok) throw new Error(`setAcceptedRevision failed: ${accepted.code}`);
  return result.value;
}

describe('admin chain sync — argument handling', () => {
  test('rejects unknown options', () => {
    const r = run(['chain', 'sync', 'chain_777', ...dbArgs(), '--bogus']);
    expect(r.code).toBe(1);
  }, 30_000);

  test('rejects a misspelled --yes rather than silently previewing', () => {
    const r = run(['chain', 'sync', 'chain_777', ...dbArgs(), '--yess']);
    expect(r.code).toBe(1);
  }, 30_000);

  test('requires a chain-ref or --all', () => {
    const r = run(['chain', 'sync', ...dbArgs(), '--json']);
    expect(r.code).toBe(1);
    expect(parse(r).error).toContain('chain-ref is required');
  }, 30_000);

  test('refuses a chain-ref together with --all', () => {
    const r = run(['chain', 'sync', 'chain_777', '--all', ...dbArgs(), '--json']);
    expect(r.code).toBe(1);
    expect(parse(r).error).toContain('not both');
  }, 30_000);

  test('refuses a second positional argument', () => {
    const r = run(['chain', 'sync', 'chain_777', 'chain_778', ...dbArgs(), '--json']);
    expect(r.code).toBe(1);
    expect(parse(r).error).toContain('Unexpected argument: chain_778');
  }, 30_000);

  test('refuses a session filter alongside a chain-ref', () => {
    const r = run(['chain', 'sync', 'chain_777', '--session-id', 'addon-dev', ...dbArgs(), '--json']);
    expect(r.code).toBe(1);
    expect(parse(r).error).toContain('only apply with --all');
  }, 30_000);

  test('reports not_found for an unknown chain-ref', () => {
    const r = run(['chain', 'sync', 'chain_999', ...dbArgs(), '--json']);
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not_found');
  }, 30_000);
});

describe('admin chain sync — importing', () => {
  test('previews by default and writes nothing; --yes imports and revisions atomically', async () => {
    const created = await createAcceptedChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [],
    });
    const chainId = created.chain.chainId;
    // GitHub now says 778 blocks 777 — a change the registry has not seen.
    seedBlockedBy(777, [{ number: 778, state: 'OPEN' }]);
    seedBlockedBy(778, []);

    const preview = run(['chain', 'sync', chainId, ...dbArgs(), '--json']);
    expect(preview.code).toBe(0);
    const previewOut = parse(preview);
    expect(previewOut.ok).toBe(true);
    expect(previewOut.applied).toBe(false);
    expect(previewOut.chains[0].status).toBe('would_import');
    expect(previewOut.chains[0].expectedEdges).toEqual([]);
    expect(previewOut.chains[0].observedEdges).toEqual([
      { blockerIssueNumber: 778, blockedIssueNumber: 777 },
    ]);

    // A preview is a preview: no graph, revision, or sync metadata moved.
    let record = await store.getChainRecord(chainId);
    expect(record.graphRevision).toBe(created.chain.graphRevision);
    expect(record.graphFingerprint).toBe(created.chain.graphFingerprint);
    expect(record.syncStatus).toBe('unknown');
    expect(record.syncedAt).toBeUndefined();

    const applied = run(['chain', 'sync', chainId, ...dbArgs(), '--yes', '--json']);
    expect(applied.code).toBe(0);
    const out = parse(applied);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.imported).toBe(1);
    expect(out.chains[0].status).toBe('imported');

    const graph = await store.getChain(chainId);
    expect(graph.edges.map((e) => [e.blockerIssueNumber, e.blockedIssueNumber])).toEqual([[778, 777]]);
    record = graph.chain;
    expect(record.graphRevision).toBe(created.chain.graphRevision + 1);
    expect(record.acceptedRevision).toBe(record.graphRevision);
    expect(record.graphFingerprint).not.toBe(created.chain.graphFingerprint);
    expect(out.chains[0].importedRevision).toBe(record.graphRevision);
    expect(out.chains[0].importedFingerprint).toBe(record.graphFingerprint);
    expect(record.syncStatus).toBe('in_sync');
    expect(record.syncedAt).toBeDefined();
  }, 30_000);

  test('an already-current chain is reported in sync without manufacturing a revision', async () => {
    const created = await createAcceptedChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }],
    });
    const chainId = created.chain.chainId;
    seedBlockedBy(777, [{ number: 778, state: 'OPEN' }]);
    seedBlockedBy(778, []);

    const preview = run(['chain', 'sync', chainId, ...dbArgs(), '--json']);
    expect(parse(preview).chains[0].status).toBe('would_remain_in_sync');

    const applied = run(['chain', 'sync', chainId, ...dbArgs(), '--yes', '--json']);
    expect(applied.code).toBe(0);
    const out = parse(applied);
    expect(out.ok).toBe(true);
    expect(out.inSync).toBe(1);
    expect(out.chains[0].status).toBe('in_sync');

    const record = await store.getChainRecord(chainId);
    expect(record.graphRevision).toBe(created.chain.graphRevision);
    expect(record.acceptedRevision).toBe(created.chain.graphRevision);
    expect(record.syncStatus).toBe('in_sync');
  }, 30_000);

  test('resolves the chain by alias, like show and validate do', async () => {
    const created = await createAcceptedChain({
      members: [{ issueNumber: 777, role: 'head' }],
      edges: [],
    });
    const chainId = created.chain.chainId;
    await store.putChainAlias({ alias: 'billing', chainId, now: NOW });
    seedBlockedBy(777, []);

    const r = run(['chain', 'sync', 'billing', ...dbArgs(), '--yes', '--json']);
    expect(r.code).toBe(0);
    expect(parse(r).chains[0].chainId).toBe(chainId);
  }, 30_000);

  test('an import clears the syncError a previous failed run recorded', async () => {
    const created = await createAcceptedChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [],
    });
    const chainId = created.chain.chainId;
    await store.setChainSyncState(chainId, { status: 'error', error: 'previous failure', now: NOW });
    seedBlockedBy(777, [{ number: 778, state: 'OPEN' }]);
    seedBlockedBy(778, []);

    const r = run(['chain', 'sync', chainId, ...dbArgs(), '--yes', '--json']);
    expect(r.code).toBe(0);
    const record = await store.getChainRecord(chainId);
    expect(record.syncStatus).toBe('in_sync');
    expect(record.syncError).toBeUndefined();
  }, 30_000);
});

describe('admin chain sync — refusals preserve the accepted graph', () => {
  test('a cycle observed on GitHub is refused with expected/observed edges and a remediation direction', async () => {
    const created = await createAcceptedChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [],
    });
    const chainId = created.chain.chainId;
    seedBlockedBy(777, [{ number: 778, state: 'OPEN' }]);
    seedBlockedBy(778, [{ number: 777, state: 'OPEN' }]);

    const r = run(['chain', 'sync', chainId, ...dbArgs(), '--yes', '--json']);
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.failed).toBe(1);
    const result = out.chains[0];
    expect(result.status).toBe('failed');
    expect(result.failure.kind).toBe('structural');
    expect(result.failure.transient).toBe(false);
    expect(result.failure.diagnostics.some((d) => d.code === 'cycle')).toBe(true);
    expect(result.failure.remediation).toContain('Direction: GitHub -> registry');
    expect(result.expectedEdges).toEqual([]);
    expect(result.observedEdges).toHaveLength(2);

    // The last-known-good graph is exactly what it was.
    const graph = await store.getChain(chainId);
    expect(graph.edges).toEqual([]);
    expect(graph.chain.graphRevision).toBe(created.chain.graphRevision);
    expect(graph.chain.acceptedRevision).toBe(created.chain.graphRevision);
    expect(graph.chain.graphFingerprint).toBe(created.chain.graphFingerprint);
    // A structural refusal is a durable fact about the observed graph, so it is
    // recorded where `chain list --sync-status error` finds it.
    expect(graph.chain.syncStatus).toBe('error');
    expect(graph.chain.syncError).toContain('not a valid chain graph');
  }, 30_000);

  test('a blocker GitHub names that is not a chain member is refused', async () => {
    const created = await createAcceptedChain({
      members: [{ issueNumber: 777, role: 'head' }],
      edges: [],
    });
    const chainId = created.chain.chainId;
    seedBlockedBy(777, [{ number: 901, state: 'OPEN' }]);

    const r = run(['chain', 'sync', chainId, ...dbArgs(), '--yes', '--json']);
    expect(r.code).toBe(1);
    const result = parse(r).chains[0];
    expect(result.failure.kind).toBe('structural');
    expect(result.failure.diagnostics.some((d) => d.code === 'missing_member' && d.issues.includes(901))).toBe(true);

    const graph = await store.getChain(chainId);
    expect(graph.edges).toEqual([]);
    expect(graph.chain.graphRevision).toBe(created.chain.graphRevision);
  }, 30_000);

  test('an inaccessible member is a transient provider failure, not a structural one, and records no sync error', async () => {
    const created = await createAcceptedChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }],
    });
    const chainId = created.chain.chainId;
    seedBlockedBy(778, []);

    const r = run(['chain', 'sync', chainId, ...dbArgs(), '--yes', '--json'], { FAKE_GH_FAIL_BLOCKED_BY: '777' });
    expect(r.code).toBe(1);
    const result = parse(r).chains[0];
    expect(result.status).toBe('failed');
    expect(result.failure.kind).toBe('provider_error');
    expect(result.failure.transient).toBe(true);
    expect(result.failure.providerErrors[0].issueNumber).toBe(777);
    // Crucially: the half-read graph is never imported, so the frozen edge
    // into #777 is not deleted.
    expect(result.failure.diagnostics).toBeUndefined();

    const graph = await store.getChain(chainId);
    expect(graph.edges.map((e) => [e.blockerIssueNumber, e.blockedIssueNumber])).toEqual([[778, 777]]);
    expect(graph.chain.graphRevision).toBe(created.chain.graphRevision);
    expect(graph.chain.acceptedRevision).toBe(created.chain.graphRevision);
    // A provider outage says nothing durable about this chain, so it must not
    // poison `chain list --sync-status error`.
    expect(graph.chain.syncStatus).toBe('unknown');
    expect(graph.chain.syncError).toBeUndefined();
  }, 30_000);

  test('a frozen-prefix conflict is refused and the frozen graph survives', async () => {
    const created = await createAcceptedChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }],
    });
    const chainId = created.chain.chainId;
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

    // GitHub has dropped the frozen ancestor edge.
    seedBlockedBy(777, []);
    seedBlockedBy(778, []);

    const r = run(['chain', 'sync', chainId, ...dbArgs(), '--yes', '--json']);
    expect(r.code).toBe(1);
    const result = parse(r).chains[0];
    expect(result.failure.kind).toBe('frozen_prefix');
    expect(result.failure.transient).toBe(false);
    expect(result.failure.violations.some((v) => v.code === 'ancestor_removed')).toBe(true);
    expect(result.failure.remediation).toContain('frozen');
    expect(result.expectedEdges).toEqual([{ blockerIssueNumber: 778, blockedIssueNumber: 777 }]);
    expect(result.observedEdges).toEqual([]);

    const graph = await store.getChain(chainId);
    expect(graph.edges.map((e) => [e.blockerIssueNumber, e.blockedIssueNumber])).toEqual([[778, 777]]);
    expect(graph.chain.acceptedRevision).toBe(created.chain.graphRevision);
    expect(graph.chain.syncStatus).toBe('error');
  }, 30_000);

  test('a frozen prefix the observed graph honours does not block the import', async () => {
    const created = await createAcceptedChain({
      members: [
        { issueNumber: 777, role: 'head' },
        { issueNumber: 778 },
        { issueNumber: 779 },
      ],
      edges: [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }],
    });
    const chainId = created.chain.chainId;
    await store.putFrozenPrefix(
      buildFrozenPrefix({
        sessionId: 'addon-dev',
        issueNumber: 777,
        chainId,
        graph: { members: created.members, edges: created.edges },
        graphRevision: created.chain.graphRevision,
        graphFingerprint: created.chain.graphFingerprint,
        base: { kind: 'default', baseRef: 'main' },
        frozenAt: NOW,
      }),
    );

    // GitHub keeps the frozen ancestor edge and adds one wholly downstream of
    // the started Issue — an ordinary edit, and the commit-point re-check of
    // the frozen prefixes must not mistake it for a conflict.
    seedBlockedBy(777, [{ number: 778, state: 'OPEN' }]);
    seedBlockedBy(778, []);
    seedBlockedBy(779, [{ number: 777, state: 'OPEN' }]);

    const r = run(['chain', 'sync', chainId, ...dbArgs(), '--yes', '--json']);
    expect(r.code).toBe(0);
    expect(parse(r).chains[0].status).toBe('imported');

    const graph = await store.getChain(chainId);
    expect(graph.edges.map((e) => [e.blockerIssueNumber, e.blockedIssueNumber])).toEqual([
      [777, 779],
      [778, 777],
    ]);
    expect(graph.chain.acceptedRevision).toBe(graph.chain.graphRevision);
    expect(graph.chain.syncStatus).toBe('in_sync');
  }, 30_000);

  test('a prefix frozen while GitHub is being read still refuses the import', async () => {
    const created = await createAcceptedChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [{ blockerIssueNumber: 778, blockedIssueNumber: 777 }],
    });
    const chainId = created.chain.chainId;

    // GitHub has dropped the ancestor edge, and nothing is frozen when the run
    // starts — so the plan sees a clean import.
    seedBlockedBy(777, []);
    seedBlockedBy(778, []);

    const r = run(['chain', 'sync', chainId, ...dbArgs(), '--yes', '--json'], {
      // ...and a task starts mid-read, pinning #777 to the very edge this
      // import would delete. Freezing writes no chain row, so `expectedRev`
      // cannot catch it: only the frozen-prefix read taken inside the pointer
      // move's own transaction can.
      FAKE_GH_RACE_SCRIPT: writeFreezeScript(created),
    });

    expect(r.code).toBe(1);
    const result = parse(r).chains[0];
    expect(result.status).toBe('failed');
    // Reported exactly as a freeze the plan had seen would have been, down to
    // the edge-level violations.
    expect(result.failure.kind).toBe('frozen_prefix');
    expect(result.failure.transient).toBe(false);
    expect(result.failure.violations.some((v) => v.code === 'ancestor_removed')).toBe(true);

    const graph = await store.getChain(chainId);
    // The pointer — the only thing that decides which graph is last known good
    // — never moved, so the started task's frozen ancestry is still the
    // accepted one, and the observed graph is on record as what it is: a
    // candidate the registry declined to accept.
    expect(graph.chain.acceptedRevision).toBe(created.chain.graphRevision);
    // The label written for a pointer move that did not happen is back to what
    // the revision actually is.
    expect((await store.getChainRevision(chainId, graph.chain.graphRevision)).state).toBe('candidate');
    expect(graph.chain.graphRevision).toBeGreaterThan(created.chain.graphRevision);
    expect(graph.chain.syncStatus).toBe('error');
  }, 30_000);

  test('a verdict about a graph that has since moved does not overwrite newer sync state', async () => {
    const created = await createAcceptedChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [],
    });
    const chainId = created.chain.chainId;
    // A cycle, so this run refuses structurally and tries to record `error`.
    seedBlockedBy(777, [{ number: 778, state: 'OPEN' }]);
    seedBlockedBy(778, [{ number: 777, state: 'OPEN' }]);

    const r = run(['chain', 'sync', chainId, ...dbArgs(), '--yes', '--json'], {
      FAKE_GH_RACE_SCRIPT: writeRaceScript(chainId),
    });
    expect(r.code).toBe(1);
    const result = parse(r).chains[0];
    // The refusal itself stands — it is a fact about the graph this run saw.
    expect(result.status).toBe('failed');
    expect(result.failure.kind).toBe('structural');
    // The metadata write is guarded by the row the verdict was reached about,
    // so the newer run's record survives and the lost write is reported.
    expect(result.followUpFailure.code).toBe('conflict');

    const record = await store.getChainRecord(chainId);
    expect(record.syncStatus).toBe('error');
    expect(record.syncError).toBe('recorded by a newer run');
    // And the accepted graph is still untouched, guard or no guard.
    expect(record.acceptedRevision).toBe(created.chain.graphRevision);
  }, 30_000);

  test('a chain whose owning session cannot supply a provider fails without touching the registry', async () => {
    const created = await createAcceptedChain({
      sessionId: 'ghost-session',
      members: [{ issueNumber: 777, role: 'head' }],
      edges: [],
    });
    const chainId = created.chain.chainId;

    const r = run(['chain', 'sync', chainId, ...dbArgs(), '--yes', '--json']);
    expect(r.code).toBe(1);
    const result = parse(r).chains[0];
    expect(result.failure.kind).toBe('session_error');

    const record = await store.getChainRecord(chainId);
    expect(record.graphRevision).toBe(created.chain.graphRevision);
    expect(record.syncStatus).toBe('unknown');
  }, 30_000);
});

describe('admin chain sync --all', () => {
  test('imports the valid chains and reports every failed one in the same run', async () => {
    const good = await createAcceptedChain({
      headIssueNumber: 100,
      members: [{ issueNumber: 100, role: 'head' }, { issueNumber: 101 }],
      edges: [],
    });
    const bad = await createAcceptedChain({
      headIssueNumber: 200,
      members: [{ issueNumber: 200, role: 'head' }, { issueNumber: 201 }],
      edges: [],
    });
    seedBlockedBy(100, [{ number: 101, state: 'OPEN' }]);
    seedBlockedBy(101, []);
    // A cycle for the second chain.
    seedBlockedBy(200, [{ number: 201, state: 'OPEN' }]);
    seedBlockedBy(201, [{ number: 200, state: 'OPEN' }]);

    const r = run(['chain', 'sync', '--all', ...dbArgs(), '--yes', '--json']);
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.ok).toBe(false);
    expect(out.count).toBe(2);
    expect(out.imported).toBe(1);
    expect(out.failed).toBe(1);

    const goodResult = out.chains.find((c) => c.chainId === good.chain.chainId);
    expect(goodResult.status).toBe('imported');
    const badResult = out.chains.find((c) => c.chainId === bad.chain.chainId);
    expect(badResult.status).toBe('failed');
    expect(badResult.failure.kind).toBe('structural');

    // The valid chain landed; the invalid one kept its accepted graph.
    const goodGraph = await store.getChain(good.chain.chainId);
    expect(goodGraph.edges.map((e) => [e.blockerIssueNumber, e.blockedIssueNumber])).toEqual([[101, 100]]);
    const badGraph = await store.getChain(bad.chain.chainId);
    expect(badGraph.edges).toEqual([]);
    expect(badGraph.chain.acceptedRevision).toBe(bad.chain.graphRevision);
  }, 30_000);

  test('one chain whose members cannot be read does not stop the others being checked', async () => {
    const reachable = await createAcceptedChain({
      headIssueNumber: 100,
      members: [{ issueNumber: 100, role: 'head' }, { issueNumber: 101 }],
      edges: [],
    });
    const unreachable = await createAcceptedChain({
      headIssueNumber: 300,
      members: [{ issueNumber: 300, role: 'head' }],
      edges: [],
    });
    seedBlockedBy(100, [{ number: 101, state: 'OPEN' }]);
    seedBlockedBy(101, []);

    const r = run(['chain', 'sync', '--all', ...dbArgs(), '--yes', '--json'], { FAKE_GH_FAIL_BLOCKED_BY: '300' });
    expect(r.code).toBe(1);
    const out = parse(r);
    expect(out.imported).toBe(1);
    expect(out.failed).toBe(1);
    expect(out.chains.find((c) => c.chainId === unreachable.chain.chainId).failure.kind).toBe('provider_error');

    const graph = await store.getChain(reachable.chain.chainId);
    expect(graph.edges.map((e) => [e.blockerIssueNumber, e.blockedIssueNumber])).toEqual([[101, 100]]);
  }, 30_000);

  test("--session-id restricts the run to one session's chains", async () => {
    // Distinct repoKey: the session registry quarantines every entry in a
    // repoKey collision, which would make both sessions unresolvable.
    writeSessions([session(), session({ sessionId: 'other-dev', repoKey: 'other-repo' })]);
    const mine = await createAcceptedChain({
      headIssueNumber: 100,
      members: [{ issueNumber: 100, role: 'head' }, { issueNumber: 101 }],
      edges: [],
    });
    const theirs = await createAcceptedChain({
      sessionId: 'other-dev',
      headIssueNumber: 200,
      members: [{ issueNumber: 200, role: 'head' }, { issueNumber: 201 }],
      edges: [],
    });
    seedBlockedBy(100, [{ number: 101, state: 'OPEN' }]);
    seedBlockedBy(101, []);
    seedBlockedBy(200, [{ number: 201, state: 'OPEN' }]);
    seedBlockedBy(201, []);

    const r = run(['chain', 'sync', '--all', '--session-id', 'addon-dev', ...dbArgs(), '--yes', '--json']);
    expect(r.code).toBe(0);
    const out = parse(r);
    expect(out.count).toBe(1);
    expect(out.chains[0].chainId).toBe(mine.chain.chainId);

    // The other session's chain was never touched.
    const untouched = await store.getChain(theirs.chain.chainId);
    expect(untouched.edges).toEqual([]);
    expect(untouched.chain.syncStatus).toBe('unknown');
  }, 30_000);
});

describe('admin chain sync — output modes', () => {
  test('defaults to human-readable output; --json gives structured output', async () => {
    const created = await createAcceptedChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [],
    });
    const chainId = created.chain.chainId;
    seedBlockedBy(777, [{ number: 778, state: 'OPEN' }]);
    seedBlockedBy(778, []);

    const human = run(['chain', 'sync', chainId, ...dbArgs()]);
    expect(human.code).toBe(0);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout).toContain('preview (pass --yes to apply)');
    expect(human.stdout).toContain(chainId);

    const json = run(['chain', 'sync', chainId, ...dbArgs(), '--json']);
    expect(parse(json).ok).toBe(true);
  }, 30_000);

  test('a human-mode failure prints the diagnostics, both edge sets, and the remediation', async () => {
    const created = await createAcceptedChain({
      members: [{ issueNumber: 777, role: 'head' }, { issueNumber: 778 }],
      edges: [],
    });
    const chainId = created.chain.chainId;
    seedBlockedBy(777, [{ number: 778, state: 'OPEN' }]);
    seedBlockedBy(778, [{ number: 777, state: 'OPEN' }]);

    const human = run(['chain', 'sync', chainId, ...dbArgs(), '--yes']);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain('[structural]');
    expect(human.stdout).toContain('expected edges (registry)');
    expect(human.stdout).toContain('observed edges (GitHub)');
    expect(human.stdout).toContain('remediation:');
    expect(human.stdout).toContain('No accepted graph was changed');
  }, 30_000);
});
