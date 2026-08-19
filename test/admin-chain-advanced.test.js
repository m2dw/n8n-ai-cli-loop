/**
 * `admin chain fork|merge` (issue #893), exercised end-to-end against a real
 * SQLite chain registry and the same stateful fake `gh` the linear-command
 * suite uses (`admin-chain-edit.test.js`).
 *
 * What is pinned here is the SEQUENCE — `chain-advanced.test.js` already
 * covers what the plans decide. Specifically: a preview writes nothing at all;
 * a fork removes the boundary relationships, writes the bridge, shrinks the
 * chain, registers the segment as an accepted in-sync chain (or detaches a
 * single Issue with no new identity), and restores the labels; a merge draws
 * the boundary, accepts the combined graph under the target's ID, retires the
 * source so every handle it had resolves to the target, and restores the
 * labels; a partial provider failure leaves GitHub half-moved, the registry
 * untouched, and the Issues suspended with a recovery plan; a retry finishes
 * the operation instead of duplicating it — including the merged-but-not-
 * retired state, which resumes with the retirement alone; and a concurrent
 * GitHub edit is caught by the read-back rather than imported.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteChainRegistryStore } from '../dist/index.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;
const NOW = '2026-08-09T10:00:00.000Z';
const STATUS_LABEL = 'status:needs-implementation';
const AGENT_LABEL = 'agent:claude';

/**
 * The same `gh` stand-in as `admin-chain-edit.test.js`: relationships in
 * `blocked-<n>.json`, labels in `labels-<n>.json`, failure injection by
 * environment variable.
 */
const FAKE_GH_SOURCE = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const stateDir = process.env.FAKE_GH_STATE_DIR;
const ID_BASE = 900000;
const at = (f) => path.join(stateDir, f);
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(at(file), 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) { fs.writeFileSync(at(file), JSON.stringify(value), 'utf8'); }
const blockers = (n) => readJson('blocked-' + n + '.json', []);
const setBlockers = (n, v) => writeJson('blocked-' + n + '.json', v);
function blocking(n) {
  const out = [];
  for (const file of fs.readdirSync(stateDir)) {
    const m = /^blocked-(\\d+)\\.json$/.exec(file);
    if (!m) continue;
    const dependent = Number(m[1]);
    if (blockers(dependent).some((b) => b.number === n)) out.push({ number: dependent, state: 'open' });
  }
  return out.sort((a, b) => a.number - b.number);
}
const labels = (n) => readJson('labels-' + n + '.json', []);
const setLabels = (n, v) => writeJson('labels-' + n + '.json', v);
function fieldValue(name) {
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '-f' || argv[i] === '-F' || argv[i] === '--field') && argv[i + 1] && argv[i + 1].startsWith(name + '=')) {
      return argv[i + 1].slice(name.length + 1);
    }
  }
  return undefined;
}
function opt(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

if (argv[0] === 'issue' && argv[1] === 'view') {
  process.stdout.write(JSON.stringify({ labels: labels(Number(argv[2])).map((name) => ({ name })) }));
  process.exit(0);
}

if (argv[0] === 'api' && argv[1] === 'graphql') {
  const n = fieldValue('number');
  if (process.env.FAKE_GH_FAIL_BLOCKED_BY === n) { process.stderr.write('boom'); process.exit(1); }
  const outgoing = (fieldValue('query') || '').includes('blocking(');
  const page = { nodes: outgoing ? blocking(Number(n)) : blockers(Number(n)), pageInfo: { hasNextPage: false, endCursor: null } };
  process.stdout.write(JSON.stringify({
    data: { repository: { issue: outgoing ? { blocking: page } : { blockedBy: page } } },
  }));
  process.exit(0);
}

if (argv[0] === 'api') {
  const route = argv[1];
  const method = opt('--method') || 'GET';
  const m = /^repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)(.*)$/.exec(route);
  if (m) {
    const n = Number(m[1]);
    const rest = m[2];
    if (rest === '' && argv.includes('--jq')) { process.stdout.write(String(ID_BASE + n)); process.exit(0); }
    if (rest === '/dependencies/blocked_by' && method === 'POST') {
      const blocker = Number(fieldValue('issue_id')) - ID_BASE;
      if (process.env.FAKE_GH_FAIL_DEP === blocker + ':' + n) { process.stderr.write('HTTP 500 dependency write refused'); process.exit(1); }
      const current = blockers(n);
      if (current.some((b) => b.number === blocker)) { process.stderr.write('HTTP 422 already exists'); process.exit(1); }
      current.push({ number: blocker, state: 'open' });
      setBlockers(n, current);
      const inject = process.env.FAKE_GH_INJECT_AFTER_WRITE;
      if (inject && !fs.existsSync(at('injected'))) {
        fs.writeFileSync(at('injected'), '1');
        const [b, d] = inject.split(':').map(Number);
        const list = blockers(d);
        list.push({ number: b, state: 'open' });
        setBlockers(d, list);
      }
      process.exit(0);
    }
    const removal = /^\\/dependencies\\/blocked_by\\/(\\d+)$/.exec(rest);
    if (removal && method === 'DELETE') {
      const blocker = Number(removal[1]) - ID_BASE;
      if (process.env.FAKE_GH_FAIL_DEP_REMOVE === blocker + ':' + n) { process.stderr.write('HTTP 500 dependency delete refused'); process.exit(1); }
      const current = blockers(n);
      if (!current.some((b) => b.number === blocker)) { process.stderr.write('HTTP 404 no such dependency'); process.exit(1); }
      setBlockers(n, current.filter((b) => b.number !== blocker));
      process.exit(0);
    }
    if (rest === '/labels' && method === 'POST') {
      const name = fieldValue('labels[]');
      const current = labels(n);
      if (!current.includes(name)) current.push(name);
      setLabels(n, current);
      process.exit(0);
    }
    const labelRemoval = /^\\/labels\\/(.+)$/.exec(rest);
    if (labelRemoval && method === 'DELETE') {
      const name = decodeURIComponent(labelRemoval[1]);
      const current = labels(n);
      if (!current.includes(name)) { process.stderr.write('HTTP 404 label absent'); process.exit(1); }
      setLabels(n, current.filter((l) => l !== name));
      process.exit(0);
    }
  }
}
process.stderr.write('unhandled fake gh call: ' + argv.join(' '));
process.exit(1);
`;

let tmpDir;
let dbPath;
let sessionsPath;
let binDir;
let stateDir;
let store;

function session() {
  return {
    sessionId: 'addon-dev',
    repoKey: 'some-repo',
    repoRoot: join(tmpDir, 'repo'),
    githubRepo: 'm2dw/some-repo',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
    verification: {},
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  };
}

function seedBlockedBy(issueNumber, blockers) {
  writeFileSync(join(stateDir, `blocked-${issueNumber}.json`), JSON.stringify(blockers), 'utf8');
}

function readBlockedBy(issueNumber) {
  const file = join(stateDir, `blocked-${issueNumber}.json`);
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')).map((b) => b.number).sort((a, b) => a - b);
}

function seedLabels(issueNumber, labels) {
  writeFileSync(join(stateDir, `labels-${issueNumber}.json`), JSON.stringify(labels), 'utf8');
}

function readLabels(issueNumber) {
  const file = join(stateDir, `labels-${issueNumber}.json`);
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')).slice().sort();
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

function dbArgs() {
  return ['--db-path', dbPath, '--sessions-path', sessionsPath, '--json'];
}

function edgeKeys(edges) {
  return edges.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`).sort();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-chain-advanced-test-'));
  dbPath = join(tmpDir, 'dev_loop.db');
  sessionsPath = join(tmpDir, 'sessions.json');
  binDir = join(tmpDir, 'bin');
  stateDir = join(tmpDir, 'gh-state');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(tmpDir, 'repo'), { recursive: true });
  writeFileSync(join(binDir, 'gh'), FAKE_GH_SOURCE, 'utf8');
  chmodSync(join(binDir, 'gh'), 0o755);
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [session()] }), 'utf8');
  store = new SqliteChainRegistryStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A linear chain, accepted, mirrored on GitHub; returns its chain ID. */
async function seedLine(issues, extra = {}) {
  const head = issues[issues.length - 1];
  const members = issues.map((n) => ({ issueNumber: n, role: n === head ? 'head' : 'node' }));
  const edges = issues.slice(1).map((n, i) => ({ blockerIssueNumber: issues[i], blockedIssueNumber: n }));
  const created = await store.createChain({
    sessionId: 'addon-dev',
    headIssueNumber: head,
    members,
    edges,
    now: NOW,
    ...extra,
  });
  if (!created.ok) throw new Error(`createChain failed: ${created.code}`);
  const accepted = await store.setAcceptedRevision(created.value.chain.chainId, created.value.chain.graphRevision, { now: NOW });
  if (!accepted.ok) throw new Error(`setAcceptedRevision failed: ${accepted.code}`);
  seedBlockedBy(issues[0], []);
  for (let i = 1; i < issues.length; i += 1) {
    seedBlockedBy(issues[i], [{ number: issues[i - 1], state: 'open' }]);
  }
  return created.value.chain.chainId;
}

describe('admin chain fork', () => {
  test('preview writes nothing — no relationship, no label, no registry row', async () => {
    const chainId = await seedLine([20, 21, 22]);
    seedLabels(21, [STATUS_LABEL, AGENT_LABEL, 'kind:bug']);
    const r = run(['chain', 'fork', chainId, '21', '1', ...dbArgs()]);
    expect(r.code).toBe(0);
    const payload = parse(r);
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe('would_apply');
    expect(payload.detach).toBe(true);
    expect(edgeKeys(payload.plannedRemovals)).toEqual(['20->21', '21->22']);
    expect(edgeKeys(payload.plannedAdditions)).toEqual(['20->22']);
    const preview = payload.labels.find((l) => l.issueNumber === 21);
    expect(preview.suspended.sort()).toEqual([AGENT_LABEL, STATUS_LABEL].sort());

    expect(readBlockedBy(21)).toEqual([20]);
    expect(readBlockedBy(22)).toEqual([21]);
    expect(readLabels(21)).toEqual([AGENT_LABEL, 'kind:bug', STATUS_LABEL].sort());
    const graph = await store.getChain(chainId);
    expect(graph.members.map((m) => m.issueNumber)).toEqual([20, 21, 22]);
    expect(graph.chain.graphRevision).toBe(1);
  }, 30_000);

  test('apply extracts a mid-chain segment into a named, accepted, in-sync chain', async () => {
    const chainId = await seedLine([20, 21, 22, 23, 24]);
    seedLabels(21, [STATUS_LABEL, AGENT_LABEL]);
    seedLabels(22, [STATUS_LABEL, AGENT_LABEL, 'kind:bug']);
    seedLabels(23, [STATUS_LABEL]);
    seedLabels(24, [AGENT_LABEL]);

    const r = run(['chain', 'fork', chainId, '22', '2', '--name', 'split-work', ...dbArgs(), '--yes']);
    expect(r.code).toBe(0);
    const payload = parse(r);
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe('applied');
    expect(payload.segmentIssues).toEqual([22, 23]);
    expect(payload.newChainId).toBe('chain_23');
    expect(edgeKeys(payload.appliedEdges)).toEqual(['21->24']);
    expect(edgeKeys(payload.removedEdges)).toEqual(['21->22', '23->24']);

    // GitHub holds exactly the post-fork state: boundary severed, bridge in
    // place, segment internals untouched.
    expect(readBlockedBy(22)).toEqual([]);
    expect(readBlockedBy(23)).toEqual([22]);
    expect(readBlockedBy(24)).toEqual([21]);

    // The forked chain shrank and stayed accepted and in sync.
    const remaining = await store.getChain(chainId);
    expect(remaining.members.map((m) => m.issueNumber)).toEqual([20, 21, 24]);
    expect(remaining.chain.headIssueNumber).toBe(24);
    expect(remaining.chain.acceptedRevision).toBe(remaining.chain.graphRevision);
    expect(remaining.chain.syncStatus).toBe('in_sync');
    expect(edgeKeys(remaining.edges)).toEqual(['20->21', '21->24']);

    // The segment is its own accepted chain, carrying the requested name.
    const segment = await store.getChain('chain_23');
    expect(segment.members.map((m) => m.issueNumber)).toEqual([22, 23]);
    expect(segment.chain.headIssueNumber).toBe(23);
    expect(segment.chain.acceptedRevision).toBe(segment.chain.graphRevision);
    expect(segment.chain.syncStatus).toBe('in_sync');
    expect(await store.resolveChainHandle('split-work')).toBe('chain_23');

    // Labels went off for the mutation and came back, non-execution labels
    // untouched.
    expect(readLabels(21)).toEqual([AGENT_LABEL, STATUS_LABEL].sort());
    expect(readLabels(22)).toEqual([AGENT_LABEL, 'kind:bug', STATUS_LABEL].sort());
    expect(readLabels(23)).toEqual([STATUS_LABEL]);
    expect(readLabels(24)).toEqual([AGENT_LABEL]);
  }, 30_000);

  test('apply detaches a single root Issue without a new chain identity', async () => {
    const chainId = await seedLine([20, 21, 22]);
    seedLabels(20, [STATUS_LABEL, AGENT_LABEL]);

    const r = run(['chain', 'fork', chainId, '20', '1', ...dbArgs(), '--yes']);
    expect(r.code).toBe(0);
    const payload = parse(r);
    expect(payload.ok).toBe(true);
    expect(payload.detach).toBe(true);
    expect(payload.newChainId).toBeUndefined();
    expect(edgeKeys(payload.removedEdges)).toEqual(['20->21']);
    expect(payload.appliedEdges).toEqual([]);

    expect(readBlockedBy(21)).toEqual([]);
    const remaining = await store.getChain(chainId);
    expect(remaining.members.map((m) => m.issueNumber)).toEqual([21, 22]);
    // The detached Issue belongs to no chain — that takes an explicit request.
    expect(await store.listChains()).toHaveLength(1);
    expect(await store.listChainsForIssue(20)).toEqual([]);
    expect(readLabels(20)).toEqual([AGENT_LABEL, STATUS_LABEL].sort());
  }, 30_000);
});

describe('admin chain merge', () => {
  test('append draws the boundary, keeps the target ID, retires the source, restores labels', async () => {
    const targetId = await seedLine([20, 21]);
    const sourceId = await seedLine([30, 31], { alias: 'feature-x' });
    seedLabels(21, [STATUS_LABEL, AGENT_LABEL]);
    seedLabels(30, [STATUS_LABEL, AGENT_LABEL]);
    seedLabels(31, ['kind:bug']);

    const r = run(['chain', 'merge', targetId, sourceId, '--position', 'append', ...dbArgs(), '--yes']);
    expect(r.code).toBe(0);
    const payload = parse(r);
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe('applied');
    expect(payload.chainId).toBe(targetId);
    expect(edgeKeys(payload.appliedEdges)).toEqual(['21->30']);
    expect(payload.retirement).toEqual({
      retiredChainId: sourceId,
      intoChainId: targetId,
      movedAliases: ['feature-x'],
    });

    expect(readBlockedBy(30)).toEqual([21]);

    // The target keeps its ID and holds the combined accepted graph, head
    // moved to the source's.
    const merged = await store.getChain(targetId);
    expect(merged.members.map((m) => m.issueNumber)).toEqual([20, 21, 30, 31]);
    expect(merged.chain.headIssueNumber).toBe(31);
    expect(merged.chain.acceptedRevision).toBe(merged.chain.graphRevision);
    expect(merged.chain.syncStatus).toBe('in_sync');

    // Every handle the source ever had resolves to the target.
    expect(await store.getChain(sourceId)).toBeUndefined();
    expect(await store.resolveChainHandle(sourceId)).toBe(targetId);
    expect(await store.resolveChainHandle('feature-x')).toBe(targetId);

    expect(readLabels(21)).toEqual([AGENT_LABEL, STATUS_LABEL].sort());
    expect(readLabels(30)).toEqual([AGENT_LABEL, STATUS_LABEL].sort());
    expect(readLabels(31)).toEqual(['kind:bug']);

    // A second run has nothing to merge: the source ref now names the target.
    const again = run(['chain', 'merge', targetId, sourceId, '--position', 'append', ...dbArgs(), '--yes']);
    expect(again.code).toBe(1);
    expect(parse(again).error).toContain('merged and retired');
  }, 30_000);

  test('prepend attaches ahead of the target root and leaves the head in place', async () => {
    const targetId = await seedLine([20, 21]);
    const sourceId = await seedLine([30, 31]);

    const r = run(['chain', 'merge', targetId, sourceId, '--position', 'prepend', ...dbArgs(), '--yes']);
    expect(r.code).toBe(0);
    const payload = parse(r);
    expect(payload.ok).toBe(true);
    expect(edgeKeys(payload.appliedEdges)).toEqual(['31->20']);

    expect(readBlockedBy(20)).toEqual([31]);
    const merged = await store.getChain(targetId);
    expect(merged.chain.headIssueNumber).toBe(21);
    expect(merged.members.map((m) => m.issueNumber)).toEqual([20, 21, 30, 31]);
    expect(await store.resolveChainHandle(sourceId)).toBe(targetId);
  }, 30_000);

  test('a failed relationship write leaves a diagnosable, non-executable state a retry finishes', async () => {
    const targetId = await seedLine([20, 21]);
    const sourceId = await seedLine([30, 31]);
    seedLabels(21, [STATUS_LABEL, AGENT_LABEL]);
    seedLabels(30, [STATUS_LABEL]);

    const failed = run(['chain', 'merge', targetId, sourceId, '--position', 'append', ...dbArgs(), '--yes'], {
      FAKE_GH_FAIL_DEP: '21:30',
    });
    expect(failed.code).toBe(1);
    const failure = parse(failed);
    expect(failure.ok).toBe(false);
    expect(failure.failure.kind).toBe('relationship_error');
    expect(failure.failure.recovery.join(' ')).toContain('Re-run');

    // Automation stays off — diagnosable, not executable — and neither GitHub
    // nor the registry gained the merge.
    expect(readLabels(21)).toEqual([]);
    expect(readLabels(30)).toEqual([]);
    expect(readBlockedBy(30)).toEqual([]);
    const target = await store.getChain(targetId);
    expect(target.members.map((m) => m.issueNumber)).toEqual([20, 21]);
    expect(await store.getChain(sourceId)).toBeDefined();

    // The retry converges: it re-reads GitHub, finishes the write, commits,
    // retires, and lifts exactly the suspension the interrupted run left.
    const retried = run(['chain', 'merge', targetId, sourceId, '--position', 'append', ...dbArgs(), '--yes']);
    expect(retried.code).toBe(0);
    expect(parse(retried).ok).toBe(true);
    expect(readBlockedBy(30)).toEqual([21]);
    expect(await store.resolveChainHandle(sourceId)).toBe(targetId);
    expect(readLabels(21)).toEqual([AGENT_LABEL, STATUS_LABEL].sort());
    expect(readLabels(30)).toEqual([STATUS_LABEL]);
  }, 30_000);

  test('a concurrent GitHub edit is caught by the read-back, not imported', async () => {
    const targetId = await seedLine([20, 21]);
    const sourceId = await seedLine([30, 31]);
    seedLabels(30, [STATUS_LABEL]);

    const r = run(['chain', 'merge', targetId, sourceId, '--position', 'append', ...dbArgs(), '--yes'], {
      FAKE_GH_INJECT_AFTER_WRITE: '19:30',
    });
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.failure.kind).toBe('structural');
    expect(payload.failure.message).toContain('gained');
    expect(payload.failure.message).toContain('19->30');

    // The registry was not updated from a state nobody planned, and the
    // Issues stay suspended for the operator who has to reconcile it.
    const target = await store.getChain(targetId);
    expect(target.members.map((m) => m.issueNumber)).toEqual([20, 21]);
    expect(await store.getChain(sourceId)).toBeDefined();
    expect(readLabels(30)).toEqual([]);
  }, 30_000);

  test('a merge interrupted after acceptance resumes with the retirement alone', async () => {
    // The state an interrupted merge leaves: the target already accepted the
    // combined graph under its own ID; the source is still registered.
    const members = [20, 21, 30, 31].map((n) => ({ issueNumber: n, role: n === 31 ? 'head' : 'node' }));
    const edges = [
      { blockerIssueNumber: 20, blockedIssueNumber: 21 },
      { blockerIssueNumber: 21, blockedIssueNumber: 30 },
      { blockerIssueNumber: 30, blockedIssueNumber: 31 },
    ];
    const target = await store.createChain({
      sessionId: 'addon-dev',
      chainId: 'chain_21',
      headIssueNumber: 31,
      members,
      edges,
      now: NOW,
    });
    expect(target.ok).toBe(true);
    expect((await store.setAcceptedRevision('chain_21', 1, { now: NOW })).ok).toBe(true);
    const source = await store.createChain({
      sessionId: 'addon-dev',
      chainId: 'chain_31',
      headIssueNumber: 31,
      members: [
        { issueNumber: 30, role: 'node' },
        { issueNumber: 31, role: 'head' },
      ],
      edges: [{ blockerIssueNumber: 30, blockedIssueNumber: 31 }],
      now: NOW,
    });
    expect(source.ok).toBe(true);
    expect((await store.setAcceptedRevision('chain_31', 1, { now: NOW })).ok).toBe(true);
    seedBlockedBy(20, []);
    seedBlockedBy(21, [{ number: 20, state: 'open' }]);
    seedBlockedBy(30, [{ number: 21, state: 'open' }]);
    seedBlockedBy(31, [{ number: 30, state: 'open' }]);

    const r = run(['chain', 'merge', 'chain_21', 'chain_31', '--position', 'append', ...dbArgs(), '--yes']);
    expect(r.code).toBe(0);
    const payload = parse(r);
    expect(payload.ok).toBe(true);
    expect(payload.plannedAdditions).toEqual([]);
    expect(payload.retirement.retiredChainId).toBe('chain_31');

    expect(await store.resolveChainHandle('chain_31')).toBe('chain_21');
    const merged = await store.getChain('chain_21');
    expect(merged.members.map((m) => m.issueNumber)).toEqual([20, 21, 30, 31]);
    expect(merged.chain.acceptedRevision).toBe(merged.chain.graphRevision);
  }, 30_000);
});
