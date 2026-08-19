/**
 * `admin chain new|append|prepend` (issue #791), exercised end-to-end against a
 * real SQLite chain registry (#788) and a stateful fake `gh` that models the
 * three things these commands touch: `blocked by` Issue Relationships, Issue
 * labels, and the reads of both.
 *
 * What is pinned here is the SEQUENCE — `chain-linear.test.js` already covers
 * what the plan decides. Specifically: a preview writes nothing at all; an
 * apply suspends execution labels before the first relationship write and
 * restores them only after the registry has the verified graph; a partial
 * provider failure leaves GitHub half-drawn, the registry untouched, and the
 * Issues suspended (so they are diagnosable but not executable) with a recovery
 * plan; a retry finishes the edit instead of duplicating it; and a GitHub edit
 * that lands while the command runs is caught by the read-back rather than
 * imported.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { SqliteChainRegistryStore, buildFrozenPrefix, chainGraphFingerprint } from '../dist/index.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;
/** Importable from a child script written into the temp dir, unlike a bare path. */
const LIB_URL = new URL('../dist/index.js', import.meta.url).href;
/** Lets a child script written into the temp dir load this repo's better-sqlite3. */
const requireFrom = createRequire(import.meta.url);
const NOW = '2026-08-09T10:00:00.000Z';
const STATUS_LABEL = 'status:needs-implementation';
const AGENT_LABEL = 'agent:claude';

/**
 * A `gh` stand-in with durable state: relationships in `blocked-<n>.json`,
 * labels in `labels-<n>.json`. Failure injection is by environment variable so
 * one binary serves every scenario.
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
// The other end of the same relationship, derived from the same files so the two
// directions can never disagree: every Issue whose blocker list names \`n\`.
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
  const race = process.env.FAKE_GH_RACE_SCRIPT;
  if (race && !fs.existsSync(at('raced'))) {
    fs.writeFileSync(at('raced'), '1');
    require('child_process').execFileSync(process.execPath, [race], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  if (process.env.FAKE_GH_FAIL_BLOCKED_BY === n) { process.stderr.write('boom'); process.exit(1); }
  // Which end of the relationship is being asked for is in the query itself.
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
      // A concurrent GitHub editor, run exactly once right after the first
      // relationship this command writes lands.
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
      const current = blockers(n);
      if (!current.some((b) => b.number === blocker)) { process.stderr.write('HTTP 404 no such dependency'); process.exit(1); }
      setBlockers(n, current.filter((b) => b.number !== blocker));
      process.exit(0);
    }
    if (rest === '/labels' && method === 'POST') {
      const name = fieldValue('labels[]');
      if (process.env.FAKE_GH_FAIL_LABEL_ADD === name) { process.stderr.write('HTTP 500 label add refused'); process.exit(1); }
      const current = labels(n);
      if (!current.includes(name)) current.push(name);
      setLabels(n, current);
      // The mirror of FAKE_GH_AFTER_SUSPEND_SCRIPT, on the way back: a one-shot
      // hook that fires the moment an execution label has actually gone back
      // on, for what can happen to a claim DURING step 7.
      const afterAdd = process.env.FAKE_GH_AFTER_LABEL_ADD_SCRIPT;
      if (afterAdd && !fs.existsSync(at('restored'))) {
        fs.writeFileSync(at('restored'), '1');
        require('child_process').execFileSync(process.execPath, [afterAdd], { stdio: ['ignore', 'ignore', 'inherit'] });
      }
      process.exit(0);
    }
    const labelRemoval = /^\\/labels\\/(.+)$/.exec(rest);
    if (labelRemoval && method === 'DELETE') {
      const name = decodeURIComponent(labelRemoval[1]);
      const current = labels(n);
      if (!current.includes(name)) { process.stderr.write('HTTP 404 label absent'); process.exit(1); }
      setLabels(n, current.filter((l) => l !== name));
      // A one-shot hook that fires the moment automation has actually been
      // suspended, for faults the command has to survive with its recovery plan
      // intact.
      const post = process.env.FAKE_GH_AFTER_SUSPEND_SCRIPT;
      if (post && !fs.existsSync(at('suspended'))) {
        fs.writeFileSync(at('suspended'), '1');
        require('child_process').execFileSync(process.execPath, [post], { stdio: ['ignore', 'ignore', 'inherit'] });
      }
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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-chain-edit-test-'));
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

/** A chain of `20 -> 21` with 21 as its head, accepted, and mirrored on GitHub. */
async function seedAcceptedChain() {
  const members = [
    { issueNumber: 20, role: 'node' },
    { issueNumber: 21, role: 'head' },
  ];
  const edges = [{ blockerIssueNumber: 20, blockedIssueNumber: 21 }];
  const created = await store.createChain({
    sessionId: 'addon-dev',
    headIssueNumber: 21,
    members,
    edges,
    now: NOW,
  });
  if (!created.ok) throw new Error(`createChain failed: ${created.code}`);
  const accepted = await store.setAcceptedRevision(created.value.chain.chainId, created.value.chain.graphRevision, { now: NOW });
  if (!accepted.ok) throw new Error(`setAcceptedRevision failed: ${accepted.code}`);
  seedBlockedBy(21, [{ number: 20, state: 'open' }]);
  seedBlockedBy(20, []);
  return created.value.chain.chainId;
}

describe('admin chain new|append|prepend — argument handling', () => {
  test('rejects unknown options', () => {
    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--bogus']);
    expect(r.code).toBe(1);
  }, 30_000);

  test('rejects a misspelled --yes rather than silently previewing', () => {
    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yess']);
    expect(r.code).toBe(1);
    expect(parse(r).error).toContain('--yess');
  }, 30_000);

  test('chain new requires a session selector', () => {
    const r = run(['chain', 'new', '10,11', ...dbArgs()]);
    expect(r.code).toBe(1);
    expect(parse(r).error).toContain('--session-id or --session-ref is required');
  }, 30_000);

  test('chain append requires a chain reference and issues', () => {
    const r = run(['chain', 'append', 'chain_21', ...dbArgs()]);
    expect(r.code).toBe(1);
    expect(parse(r).error).toContain('chain reference and issue number');
  }, 30_000);

  test('refuses a third positional argument', () => {
    const r = run(['chain', 'new', '10,11', 'name', 'extra', ...dbArgs(), '--session-id', 'addon-dev']);
    expect(r.code).toBe(1);
    expect(parse(r).error).toContain('Unexpected argument: extra');
  }, 30_000);

  test('refuses a malformed chain name before touching anything', () => {
    const r = run(['chain', 'new', '10,11', 'not a name', ...dbArgs(), '--session-id', 'addon-dev']);
    expect(r.code).toBe(1);
    expect(parse(r).error).toContain('Invalid chain name');
  }, 30_000);

  test('reports not_found for an unknown chain-ref', () => {
    const r = run(['chain', 'append', 'chain_999', '30', ...dbArgs()]);
    expect(r.code).toBe(1);
    expect(parse(r).reason).toBe('not_found');
  }, 30_000);

  test('rejects a repeated Issue number instead of quietly collapsing it', async () => {
    // The list is a SEQUENCE: `10,11,10` asks for a cycle, and executing it as
    // `10,11` would apply a graph the operator never described (issue #791
    // review).
    const r = run(['chain', 'new', '10,11,10', ...dbArgs(), '--session-id', 'addon-dev']);
    expect(r.code).toBe(1);
    expect(parse(r).error).toContain('#10 is named more than once');
    expect(await store.listChains()).toEqual([]);

    const chainId = await seedAcceptedChain();
    const appended = run(['chain', 'append', chainId, '22,22', ...dbArgs()]);
    expect(appended.code).toBe(1);
    expect(parse(appended).error).toContain('#22 is named more than once');
  }, 30_000);
});

describe('admin chain new', () => {
  test('preview writes nothing — no relationship, no label, no chain', async () => {
    seedLabels(11, [STATUS_LABEL, AGENT_LABEL, 'kind:bug']);
    const r = run(['chain', 'new', '10,11,12', ...dbArgs(), '--session-id', 'addon-dev']);
    expect(r.code).toBe(0);
    const payload = parse(r);
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe('would_apply');
    expect(payload.plannedEdges.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`)).toEqual(['10->11', '11->12']);
    expect(payload.graph.headIssueNumber).toBe(12);
    const eleven = payload.labels.find((l) => l.issueNumber === 11);
    expect(eleven.suspended.sort()).toEqual([AGENT_LABEL, STATUS_LABEL].sort());

    expect(readBlockedBy(11)).toEqual([]);
    expect(readBlockedBy(12)).toEqual([]);
    expect(readLabels(11)).toEqual([AGENT_LABEL, 'kind:bug', STATUS_LABEL].sort());
    expect(await store.listChains()).toEqual([]);
  }, 30_000);

  test('apply creates the relationships, registers the accepted graph, and restores the labels', async () => {
    seedLabels(10, [STATUS_LABEL, AGENT_LABEL]);
    seedLabels(11, [STATUS_LABEL, AGENT_LABEL, 'kind:bug']);
    seedLabels(12, []);
    const r = run(['chain', 'new', '10,11,12', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(r.code).toBe(0);
    const payload = parse(r);
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe('applied');
    expect(payload.chainId).toBe('chain_12');
    expect(payload.appliedEdges.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`)).toEqual(['10->11', '11->12']);

    // GitHub holds the line, in the right direction.
    expect(readBlockedBy(11)).toEqual([10]);
    expect(readBlockedBy(12)).toEqual([11]);

    // The registry holds the verified graph as its accepted revision.
    const graph = await store.getChain('chain_12');
    expect(graph.chain.acceptedRevision).toBe(graph.chain.graphRevision);
    expect(graph.chain.headIssueNumber).toBe(12);
    expect(graph.edges.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`).sort()).toEqual(['10->11', '11->12']);
    // The graph was read back from GitHub before it was persisted, so the chain
    // is genuinely in sync — it must not sit in `chain list --sync-status unknown`.
    expect(graph.chain.syncStatus).toBe('in_sync');
    expect(graph.chain.syncedAt).toBeDefined();

    // Labels are exactly where they started: suspended for the mutation, then
    // restored — and nothing that was not an execution label was touched.
    expect(readLabels(10)).toEqual([AGENT_LABEL, STATUS_LABEL].sort());
    expect(readLabels(11)).toEqual([AGENT_LABEL, 'kind:bug', STATUS_LABEL].sort());
    const restored = payload.labels.find((l) => l.issueNumber === 11);
    expect(restored.suspended.sort()).toEqual([AGENT_LABEL, STATUS_LABEL].sort());
    expect(restored.restored.sort()).toEqual([AGENT_LABEL, STATUS_LABEL].sort());
    expect(restored.withheld).toEqual([]);
  }, 30_000);

  test('the human rendering names the planned edges and the label changes', () => {
    seedLabels(11, [STATUS_LABEL]);
    // Operator-facing by default: no --json, so this is the text an operator
    // actually reads before deciding to pass --yes.
    const r = run(['chain', 'new', '10,11', '--db-path', dbPath, '--sessions-path', sessionsPath, '--session-id', 'addon-dev']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('10->11');
    expect(r.stdout).toContain('would suspend');
    expect(r.stdout).toContain(STATUS_LABEL);
    expect(r.stdout).toContain('Run with --yes to apply.');
  }, 30_000);

  test('a name becomes an alias, and a taken one is refused before anything is created', async () => {
    const first = run(['chain', 'new', '10,11', 'auth-work', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(first.code).toBe(0);
    expect(await store.resolveChainHandle('auth-work')).toBe('chain_11');

    const second = run(['chain', 'new', '30,31', 'auth-work', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(second.code).toBe(1);
    expect(parse(second).error).toContain('already resolves to chain chain_11');
    expect(readBlockedBy(31)).toEqual([]);
    expect(await store.resolveChainHandle('chain_31')).toBeUndefined();
  }, 30_000);

  test('a name taken by a creation that runs mid-edit leaves no chain, so the retry is a real one', async () => {
    seedLabels(10, [STATUS_LABEL]);
    seedLabels(11, [STATUS_LABEL]);

    // The step-0 claim serializes two runs of THIS command, but chain IDs and
    // aliases share one namespace (#788) and a creation that takes no claim —
    // an intake registering a candidate, an unnamed `chain new` whose head is
    // #42 — can still occupy `chain_42` after the name was checked as free.
    // The name is registered by the same transaction that allocates the chain's
    // ID precisely so that losing this race creates nothing (issue #791
    // review).
    const raceScript = join(tmpDir, 'race-alias.mjs');
    const dist = new URL('../dist/index.js', import.meta.url).href;
    writeFileSync(
      raceScript,
      `import { SqliteChainRegistryStore } from ${JSON.stringify(dist)};
const store = new SqliteChainRegistryStore(${JSON.stringify(dbPath)});
const created = await store.createChain({ sessionId: 'addon-dev', headIssueNumber: 42, now: ${JSON.stringify(NOW)} });
store.close();
if (!created.ok) { console.error(created.code); process.exit(1); }
`,
      'utf8',
    );

    const r = run(
      ['chain', 'new', '10,11', 'chain_42', ...dbArgs(), '--session-id', 'addon-dev', '--yes'],
      { FAKE_GH_RACE_SCRIPT: raceScript },
    );
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.ok).toBe(false);
    expect(payload.failure.kind).toBe('store_error');
    expect(payload.failure.message).toContain('alias_taken');
    expect(payload.failure.remediation).toContain('different name');

    // No chain was created for these Issues — not an accepted one reporting
    // success with a follow-up warning, and not one whose existence would make
    // the retry refuse. The name belongs to the run that won the race.
    expect((await store.listChains()).map((c) => c.chainId)).toEqual(['chain_42']);
    expect(await store.resolveChainHandle('chain_42')).toBe('chain_42');
    // GitHub holds what was drawn, automation stays off, and the answer says so.
    expect(readBlockedBy(11)).toEqual([10]);
    expect(readLabels(11)).toEqual([]);
    expect(payload.failure.recovery.join(' ')).toContain('admin issue activate');

    const retry = run(['chain', 'new', '10,11', 'auth-work', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(retry.code).toBe(0);
    const done = parse(retry);
    expect(done.status).toBe('applied');
    expect(await store.resolveChainHandle('auth-work')).toBe(done.chainId);
    const graph = await store.getChain(done.chainId);
    expect(graph.chain.acceptedRevision).toBe(graph.chain.graphRevision);
    expect(readLabels(11)).toEqual([STATUS_LABEL]);
  }, 30_000);

  test('a retry of a named `chain new` finishes its own leftover instead of reading the name as taken', async () => {
    seedLabels(10, [STATUS_LABEL]);
    seedLabels(11, [STATUS_LABEL]);
    // What a `chain new auth-work` leaves when the acceptance did not land: the
    // chain owns the Issues, carries the name, and has never been accepted. The
    // documented recovery is to re-run the same command, so the name resolving
    // to this chain must read as the retry it is, not as a collision.
    const created = await store.createChain({
      sessionId: 'addon-dev',
      headIssueNumber: 11,
      members: [
        { issueNumber: 10, role: 'node' },
        { issueNumber: 11, role: 'head' },
      ],
      edges: [{ blockerIssueNumber: 10, blockedIssueNumber: 11 }],
      title: 'auth-work',
      alias: 'auth-work',
      source: 'admin chain new',
      now: NOW,
    });
    expect(created.ok).toBe(true);
    seedBlockedBy(11, [{ number: 10, state: 'open' }]);

    const retry = run(['chain', 'new', '10,11', 'auth-work', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(retry.code).toBe(0);
    const done = parse(retry);
    expect(done.status).toBe('applied');
    expect(done.chainId).toBe(created.value.chain.chainId);
    expect((await store.listChains()).length).toBe(1);
    expect(await store.resolveChainHandle('auth-work')).toBe(done.chainId);
    const graph = await store.getChain(done.chainId);
    expect(graph.chain.acceptedRevision).toBe(graph.chain.graphRevision);
  }, 30_000);

  test('naming an unnamed leftover on the retry finishes it in that same run', async () => {
    seedLabels(10, [STATUS_LABEL]);
    seedLabels(11, [STATUS_LABEL]);
    // The leftover of an UNNAMED `chain new`: it carries no alias, so the retry
    // registers the name onto the chain it is finishing. That write bumps the
    // chain row, and the acceptance that follows compares against the revision
    // this run read before it — so without a refresh the retry conflicts with
    // itself and demands a second one for nothing (issue #791 review).
    const created = await store.createChain({
      sessionId: 'addon-dev',
      headIssueNumber: 11,
      members: [
        { issueNumber: 10, role: 'node' },
        { issueNumber: 11, role: 'head' },
      ],
      edges: [{ blockerIssueNumber: 10, blockedIssueNumber: 11 }],
      source: 'admin chain new',
      now: NOW,
    });
    expect(created.ok).toBe(true);
    expect(created.value.chain.title).toBeUndefined();
    seedBlockedBy(11, [{ number: 10, state: 'open' }]);

    const retry = run(['chain', 'new', '10,11', 'auth-work', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(retry.code).toBe(0);
    const done = parse(retry);
    expect(done.status).toBe('applied');
    expect(done.chainId).toBe(created.value.chain.chainId);
    expect((await store.listChains()).length).toBe(1);
    expect(await store.resolveChainHandle('auth-work')).toBe(done.chainId);
    const graph = await store.getChain(done.chainId);
    // Accepted on the first retry, and holding the name it was given.
    expect(graph.chain.acceptedRevision).toBe(graph.chain.graphRevision);
    expect(graph.chain.title).toBe('auth-work');
    // Acceptance succeeded, so automation came back on.
    expect(readLabels(11)).toEqual([STATUS_LABEL]);
  }, 30_000);

  test('a registry write that lands while the retry runs is a conflict, not an overwrite', async () => {
    seedLabels(11, [STATUS_LABEL]);
    const created = await store.createChain({
      sessionId: 'addon-dev',
      headIssueNumber: 11,
      members: [
        { issueNumber: 10, role: 'node' },
        { issueNumber: 11, role: 'head' },
      ],
      edges: [{ blockerIssueNumber: 10, blockedIssueNumber: 11 }],
      source: 'admin chain new',
      now: NOW,
    });
    expect(created.ok).toBe(true);
    seedBlockedBy(11, [{ number: 10, state: 'open' }]);

    // Another registry writer — a `chain sync`, say — moves this chain the
    // moment the retry's first execution label comes off: after the revision
    // its plan is guarded by was read, and after the GitHub state that revision
    // is supposed to describe. The naming write used to be unguarded, which
    // folded that change into the revision handed to the acceptance and let a
    // stale plan overwrite the newer graph instead of conflicting (issue #791
    // review).
    const concurrent = join(tmpDir, 'concurrent-registry-write.cjs');
    writeFileSync(
      concurrent,
      `const Database = require(${JSON.stringify(requireFrom.resolve('better-sqlite3'))});
const db = new Database(${JSON.stringify(dbPath)});
db.prepare("UPDATE dependency_chain SET title = 'renamed by sync', rev = rev + 1 WHERE chain_id = ?").run(
  ${JSON.stringify(created.value.chain.chainId)},
);
db.close();
`,
      'utf8',
    );

    const retry = run(
      ['chain', 'new', '10,11', 'auth-work', ...dbArgs(), '--session-id', 'addon-dev', '--yes'],
      { FAKE_GH_AFTER_SUSPEND_SCRIPT: concurrent },
    );
    expect(retry.code).toBe(1);
    const payload = parse(retry);
    expect(payload.failure.kind).toBe('conflict');
    expect(payload.failure.transient).toBe(true);

    // Nothing of this run's landed: the name is unregistered, the other
    // writer's state stands, and the chain is still the unaccepted one a retry
    // can finish.
    expect(await store.resolveChainHandle('auth-work')).toBeUndefined();
    const graph = await store.getChain(created.value.chain.chainId);
    expect(graph.chain.title).toBe('renamed by sync');
    expect(graph.chain.acceptedRevision).toBeUndefined();

    // Failed after the suspension, so the labels stay off and the answer says
    // which command puts them back.
    expect(readLabels(11)).toEqual([]);
    expect(payload.failure.recovery.join(' ')).toContain('admin issue activate');
  }, 30_000);

  test('an ID collision walks the deterministic suffix sequence', async () => {
    const first = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(first.code).toBe(0);
    expect(parse(first).chainId).toBe('chain_11');

    // Chain IDs and aliases share one namespace (#788), so an alias occupying
    // the ID a new head would derive is a genuine collision. The next chain
    // headed by #13 must take the next candidate in the fixed sequence rather
    // than an invented name.
    const alias = await store.putChainAlias({ alias: 'chain_13', chainId: 'chain_11', now: NOW });
    expect(alias.ok).toBe(true);

    const second = run(['chain', 'new', '12,13', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(second.code).toBe(0);
    expect(parse(second).chainId).toBe('chain_13_2');
  }, 30_000);

  test('refuses an Issue another chain already owns, naming the advanced merge operation', async () => {
    const created = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(created.code).toBe(0);
    seedLabels(30, [STATUS_LABEL]);

    const r = run(['chain', 'new', '30,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.failure.kind).toBe('structural');
    expect(payload.failure.message).toContain('#11 (chain_11)');
    expect(payload.failure.remediation).toContain('#893');
    // Refused before the first write: nothing suspended, nothing drawn.
    expect(payload.failure.recovery).toEqual([]);
    expect(readLabels(30)).toEqual([STATUS_LABEL]);
    expect(readBlockedBy(11)).toEqual([10]);
  }, 30_000);

  test('a transient provider read refuses the whole edit without suspending anything', () => {
    seedLabels(11, [STATUS_LABEL]);
    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes'], {
      FAKE_GH_FAIL_BLOCKED_BY: '11',
    });
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.failure.kind).toBe('provider_error');
    expect(payload.failure.transient).toBe(true);
    expect(readLabels(11)).toEqual([STATUS_LABEL]);
    expect(readBlockedBy(11)).toEqual([]);
  }, 30_000);
});

describe('admin chain append / prepend', () => {
  test('append extends past the head and moves it', async () => {
    const chainId = await seedAcceptedChain();
    seedLabels(22, [STATUS_LABEL, AGENT_LABEL]);

    const r = run(['chain', 'append', chainId, '22,23', ...dbArgs(), '--yes']);
    expect(r.code).toBe(0);
    const payload = parse(r);
    expect(payload.status).toBe('applied');
    expect(readBlockedBy(22)).toEqual([21]);
    expect(readBlockedBy(23)).toEqual([22]);

    const graph = await store.getChain(chainId);
    expect(graph.chain.headIssueNumber).toBe(23);
    expect(graph.chain.acceptedRevision).toBe(graph.chain.graphRevision);
    expect(graph.members.map((m) => m.issueNumber).sort((a, b) => a - b)).toEqual([20, 21, 22, 23]);
    expect(readLabels(22)).toEqual([AGENT_LABEL, STATUS_LABEL].sort());
  }, 30_000);

  test('append accepts a session assertion and refuses a wrong one', async () => {
    const chainId = await seedAcceptedChain();
    const ok = run(['chain', 'append', chainId, '22', ...dbArgs(), '--session-id', 'addon-dev']);
    expect(ok.code).toBe(0);
    const wrong = run(['chain', 'append', chainId, '22', ...dbArgs(), '--session-id', 'other-session']);
    expect(wrong.code).toBe(1);
    expect(parse(wrong).error).toContain('belongs to session addon-dev');
  }, 30_000);

  test('prepend attaches ahead of the root and leaves the head alone', async () => {
    const chainId = await seedAcceptedChain();
    const r = run(['chain', 'prepend', chainId, '18,19', ...dbArgs(), '--yes']);
    expect(r.code).toBe(0);
    expect(readBlockedBy(19)).toEqual([18]);
    expect(readBlockedBy(20)).toEqual([19]);

    const graph = await store.getChain(chainId);
    expect(graph.chain.headIssueNumber).toBe(21);
    expect(graph.members.map((m) => m.issueNumber).sort((a, b) => a - b)).toEqual([18, 19, 20, 21]);
  }, 30_000);

  test('refuses to append past a head that already blocks an unregistered Issue', async () => {
    // The live fork the registry cannot show (issue #791 review): #21 is the
    // chain's head and, on GitHub, blocks #99 — an Issue no chain owns. That
    // edge is in neither the registry nor any member's `blocked by` set, so an
    // observation built from incoming relationships alone would wave the append
    // through and leave `21 -> 22` beside `21 -> 99`.
    const chainId = await seedAcceptedChain();
    seedBlockedBy(99, [{ number: 21, state: 'open' }]);
    seedLabels(21, [STATUS_LABEL, AGENT_LABEL]);
    seedLabels(22, [STATUS_LABEL]);

    const r = run(['chain', 'append', chainId, '22', ...dbArgs(), '--yes']);
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.failure.kind).toBe('structural');
    expect(payload.failure.message).toContain('already blocks #99');
    expect(payload.failure.remediation).toContain('#893');

    // Refused before the first write, so nothing moved: no relationship, no
    // label, and the chain still ends where it did.
    expect(readBlockedBy(22)).toEqual([]);
    expect(readBlockedBy(99)).toEqual([21]);
    expect(readLabels(21)).toEqual([AGENT_LABEL, STATUS_LABEL].sort());
    expect(readLabels(22)).toEqual([STATUS_LABEL]);
    const graph = await store.getChain(chainId);
    expect(graph.chain.headIssueNumber).toBe(21);
    expect(graph.members.map((m) => m.issueNumber).sort((a, b) => a - b)).toEqual([20, 21]);
  }, 30_000);

  test('a frozen prefix blocks a prepend but not a downstream append', async () => {
    const chainId = await seedAcceptedChain();
    const graph = await store.getChain(chainId);
    const snapshotGraph = {
      members: graph.members.map((m) => ({ issueNumber: m.issueNumber, role: m.role })),
      edges: graph.edges.map((e) => ({ blockerIssueNumber: e.blockerIssueNumber, blockedIssueNumber: e.blockedIssueNumber })),
    };
    // #21 has started: its ancestry is pinned.
    const frozen = await store.putFrozenPrefix(
      buildFrozenPrefix({
        sessionId: 'addon-dev',
        issueNumber: 21,
        chainId,
        graph: snapshotGraph,
        graphRevision: graph.chain.graphRevision,
        graphFingerprint: chainGraphFingerprint(snapshotGraph),
        base: { kind: 'default', baseRef: 'main' },
        frozenAt: NOW,
      }),
    );
    expect(frozen.ok).toBe(true);

    const prepend = run(['chain', 'prepend', chainId, '19', ...dbArgs(), '--yes']);
    expect(prepend.code).toBe(1);
    const refused = parse(prepend);
    expect(refused.failure.kind).toBe('frozen_prefix');
    expect(readBlockedBy(20)).toEqual([]);

    const append = run(['chain', 'append', chainId, '22', ...dbArgs(), '--yes']);
    expect(append.code).toBe(0);
    expect(readBlockedBy(22)).toEqual([21]);
  }, 30_000);
});

describe('admin chain edit — failure and recovery', () => {
  test('a partial relationship failure leaves GitHub half-drawn, the registry untouched, and the Issues suspended', async () => {
    seedLabels(10, [STATUS_LABEL]);
    seedLabels(11, [STATUS_LABEL, AGENT_LABEL]);
    seedLabels(12, [STATUS_LABEL]);

    const r = run(['chain', 'new', '10,11,12', ...dbArgs(), '--session-id', 'addon-dev', '--yes'], {
      FAKE_GH_FAIL_DEP: '11:12',
    });
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.failure.kind).toBe('relationship_error');
    expect(payload.appliedEdges.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`)).toEqual(['10->11']);

    // The first relationship landed; the second did not.
    expect(readBlockedBy(11)).toEqual([10]);
    expect(readBlockedBy(12)).toEqual([]);
    // Nothing was registered from a graph GitHub does not hold.
    expect(await store.listChains()).toEqual([]);
    // Automation stays off, so the half-linked Issues cannot be picked up.
    expect(readLabels(11)).toEqual([]);
    expect(readLabels(12)).toEqual([]);
    expect(payload.failure.recovery.join(' ')).toContain('admin issue activate');

    // Retry: the relationship that already exists is not re-created, the
    // missing one is, and the edit completes.
    const retry = run(['chain', 'new', '10,11,12', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(retry.code).toBe(0);
    const done = parse(retry);
    expect(done.status).toBe('applied');
    expect(done.appliedEdges.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`)).toEqual(['11->12']);
    expect(readBlockedBy(12)).toEqual([11]);
    const graph = await store.getChain('chain_12');
    expect(graph.chain.acceptedRevision).toBe(graph.chain.graphRevision);
    // The labels the first run suspended are restored by the run that finished
    // the edit — the suspension record survived the failure.
    expect(readLabels(11)).toEqual([AGENT_LABEL, STATUS_LABEL].sort());
    expect(readLabels(12)).toEqual([STATUS_LABEL]);
  }, 30_000);

  test('a suspension another operation is holding survives the edit instead of being lifted by it', async () => {
    seedLabels(10, [STATUS_LABEL, AGENT_LABEL]);
    seedLabels(11, [STATUS_LABEL]);

    // An operator parks #10 for reasons of their own, before any chain work.
    const parked = run([
      'issue', 'suspend', '10',
      '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbPath, '--json', '--yes',
    ]);
    expect(parked.code).toBe(0);
    expect(readLabels(10)).toEqual([]);

    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(r.code).toBe(0);
    const payload = parse(r);
    expect(payload.status).toBe('applied');
    expect(readBlockedBy(11)).toEqual([10]);

    // #11's own labels come back — the edit suspended those itself. #10 stays
    // parked: this edit took nothing off it, so ending somebody else's
    // suspension (and making the Issue eligible again) is not its call.
    expect(readLabels(11)).toEqual([STATUS_LABEL]);
    expect(readLabels(10)).toEqual([]);
    const ten = payload.labels.find((l) => l.issueNumber === 10);
    expect(ten.suspended).toEqual([]);
    expect(ten.restored).toEqual([]);
    expect(ten.withheld.sort()).toEqual([AGENT_LABEL, STATUS_LABEL].sort());
  }, 30_000);

  test('a retry restores the chain endpoint the interrupted run suspended', async () => {
    // The boundary edge 21->22 lands and the run then fails on 22->23. The retry
    // finds 21->22 already there, so it has nothing to write for #21 — and must
    // still hand #21 its labels back, or the append succeeds while the old head
    // stays permanently ineligible (issue #791 review).
    const chainId = await seedAcceptedChain();
    seedLabels(21, [STATUS_LABEL, AGENT_LABEL]);
    seedLabels(22, [STATUS_LABEL]);
    seedLabels(23, [STATUS_LABEL]);

    const first = run(['chain', 'append', chainId, '22,23', ...dbArgs(), '--yes'], {
      FAKE_GH_FAIL_DEP: '22:23',
    });
    expect(first.code).toBe(1);
    expect(parse(first).failure.kind).toBe('relationship_error');
    expect(readBlockedBy(22)).toEqual([21]);
    expect(readBlockedBy(23)).toEqual([]);
    expect(readLabels(21)).toEqual([]);

    const retry = run(['chain', 'append', chainId, '22,23', ...dbArgs(), '--yes']);
    expect(retry.code).toBe(0);
    const done = parse(retry);
    expect(done.status).toBe('applied');
    // The retry READ 21->22 back off GitHub, so it is not an addition the plan
    // proposes at all — #21 is in scope because the edit links it, not because
    // there is anything left to write for it.
    expect(done.plannedEdges.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`)).toEqual(['22->23']);
    expect(done.alreadyPresentEdges).toEqual([]);
    expect(done.appliedEdges.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`)).toEqual(['22->23']);
    expect(readLabels(21)).toEqual([AGENT_LABEL, STATUS_LABEL].sort());
    expect(readLabels(22)).toEqual([STATUS_LABEL]);
    expect(readLabels(23)).toEqual([STATUS_LABEL]);
  }, 30_000);

  test('a retry hands back the labels it removed into a record another operation opened', async () => {
    // #10 is parked by an operator (record opened by THAT operation), the status
    // label comes back, and the chain edit then removes it into the same record.
    // The retry has to recognize that one label as its own — attribution kept
    // only at record level would leave it withheld for good (issue #791 review).
    seedLabels(10, [STATUS_LABEL, AGENT_LABEL]);
    seedLabels(11, [STATUS_LABEL]);
    const parked = run([
      'issue', 'suspend', '10',
      '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbPath, '--json', '--yes',
    ]);
    expect(parked.code).toBe(0);
    seedLabels(10, [STATUS_LABEL]);

    const first = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes'], {
      FAKE_GH_FAIL_DEP: '10:11',
    });
    expect(first.code).toBe(1);
    expect(parse(first).failure.kind).toBe('relationship_error');
    expect(readLabels(10)).toEqual([]);

    const retry = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(retry.code).toBe(0);
    const done = parse(retry);
    expect(done.status).toBe('applied');
    expect(readBlockedBy(11)).toEqual([10]);
    // The label the edit took off #10 is back; the one the operator's own
    // suspension holds is not, and it is still on record.
    expect(readLabels(10)).toEqual([STATUS_LABEL]);
    expect(readLabels(11)).toEqual([STATUS_LABEL]);
    const ten = done.labels.find((l) => l.issueNumber === 10);
    expect(ten.restored).toEqual([STATUS_LABEL]);
    expect(ten.withheld).toEqual([AGENT_LABEL]);
  }, 30_000);

  test('a retry finishes the chain a failed `chain new` left unaccepted, rather than refusing its own leftover', async () => {
    seedLabels(10, [STATUS_LABEL]);
    seedLabels(11, [STATUS_LABEL]);
    // Exactly what a `chain new` leaves when the relationships were drawn and
    // read back but the acceptance did not land: the chain owns the Issues and
    // has never been accepted.
    const created = await store.createChain({
      sessionId: 'addon-dev',
      headIssueNumber: 11,
      members: [
        { issueNumber: 10, role: 'node' },
        { issueNumber: 11, role: 'head' },
      ],
      edges: [{ blockerIssueNumber: 10, blockedIssueNumber: 11 }],
      source: 'chain-linear new',
      now: NOW,
    });
    expect(created.ok).toBe(true);
    expect(created.value.chain.acceptedRevision).toBeUndefined();
    seedBlockedBy(11, [{ number: 10, state: 'open' }]);

    const retry = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(retry.code).toBe(0);
    const done = parse(retry);
    expect(done.status).toBe('applied');
    // The same identity is finished — not a second chain over the same Issues.
    expect(done.chainId).toBe(created.value.chain.chainId);
    expect((await store.listChains()).length).toBe(1);
    const graph = await store.getChain(created.value.chain.chainId);
    expect(graph.chain.acceptedRevision).toBe(graph.chain.graphRevision);
    expect(graph.chain.headIssueNumber).toBe(11);
    expect(readBlockedBy(11)).toEqual([10]);
    expect(readLabels(10)).toEqual([STATUS_LABEL]);
    expect(readLabels(11)).toEqual([STATUS_LABEL]);
  }, 30_000);

  test('an unaccepted chain over DIFFERENT Issues is still another chain, not a leftover to resume', async () => {
    seedLabels(10, [STATUS_LABEL]);
    // Unaccepted, but it also holds #12 — adopting it would silently drop a
    // member this command never named.
    const created = await store.createChain({
      sessionId: 'addon-dev',
      headIssueNumber: 12,
      members: [
        { issueNumber: 11, role: 'node' },
        { issueNumber: 12, role: 'head' },
      ],
      edges: [{ blockerIssueNumber: 11, blockedIssueNumber: 12 }],
      now: NOW,
    });
    expect(created.ok).toBe(true);

    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.failure.kind).toBe('structural');
    expect(payload.failure.message).toContain(`#11 (${created.value.chain.chainId})`);
    expect(payload.failure.remediation).toContain('#893');
    expect(readLabels(10)).toEqual([STATUS_LABEL]);
    expect(readBlockedBy(11)).toEqual([]);
  }, 30_000);

  test('recovery never offers the broad activation for an Issue another operation also suspended', async () => {
    seedLabels(10, [STATUS_LABEL, AGENT_LABEL]);
    seedLabels(11, [STATUS_LABEL]);

    // Another operation parks #10 (recording both labels), and the status label
    // is put back on the Issue afterwards — so this edit removes one label into
    // a record it does not own.
    const parked = run([
      'issue', 'suspend', '10',
      '--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--db-path', dbPath, '--json', '--yes',
    ]);
    expect(parked.code).toBe(0);
    seedLabels(10, [STATUS_LABEL]);

    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes'], {
      FAKE_GH_FAIL_DEP: '10:11',
    });
    expect(r.code).toBe(1);
    const recovery = parse(r).failure.recovery.join(' ');
    // #11's record is this edit's alone, so the command is offered for it...
    expect(recovery).toContain('admin issue activate 11 --session-id addon-dev --yes');
    // ...and never as a command for #10, whose record would also restore the
    // other operation's label and lift a suspension this edit does not own.
    expect(recovery).not.toContain('activate 10,11');
    expect(recovery).not.toContain('activate 10 --session-id');
    expect(recovery).toContain('do NOT run `admin issue activate 10`');
    expect(recovery).toContain(AGENT_LABEL);
  }, 30_000);

  test('a label stranded by a failed suspension record asks for a manual re-add, not activation', async () => {
    seedLabels(10, []);
    seedLabels(11, [STATUS_LABEL]);

    // Every write to the suspension table fails while reads keep working: #787
    // cannot commit the record documenting its removal, so it compensates by
    // re-adding the label — and that re-add is refused too. The label is then
    // off the Issue with no record naming it, which no activation can undo
    // (issue #791 review).
    const db = new Database(dbPath);
    db.exec(
      `CREATE TABLE IF NOT EXISTS issue_automation_suspension (
         session_id TEXT NOT NULL, issue_number INTEGER NOT NULL, labels TEXT NOT NULL,
         operation_id TEXT NOT NULL, label_operations TEXT, suspended_at TEXT NOT NULL,
         updated_at TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1,
         PRIMARY KEY (session_id, issue_number));
       CREATE TRIGGER refuse_suspension_insert BEFORE INSERT ON issue_automation_suspension
         BEGIN SELECT RAISE(ABORT, 'disk full'); END;
       CREATE TRIGGER refuse_suspension_update BEFORE UPDATE ON issue_automation_suspension
         BEGIN SELECT RAISE(ABORT, 'disk full'); END;`,
    );
    db.close();

    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes'], {
      FAKE_GH_FAIL_LABEL_ADD: STATUS_LABEL,
    });
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.failure.kind).toBe('label_error');
    expect(payload.labels.find((l) => l.issueNumber === 11).error).toContain('manual recovery required');

    const recovery = payload.failure.recovery.join(' ');
    expect(recovery).toContain(`#11 lost label(s) ${STATUS_LABEL}`);
    expect(recovery).toContain('re-add them to #11 by hand');
    // Activation restores a record; there is none, so it is never offered as
    // the fix — it would read as a repair that silently did nothing.
    expect(recovery).not.toContain('admin issue activate 11 --session-id');

    // The label really is gone, no record exists, and the edit stopped before
    // its first GitHub or registry write.
    expect(readLabels(11)).toEqual([]);
    expect(readBlockedBy(11)).toEqual([]);
    expect(await store.listChains()).toEqual([]);
  }, 30_000);

  test('a store fault after the suspension is answered with the recovery plan, not a stack trace', async () => {
    seedLabels(10, [STATUS_LABEL]);
    seedLabels(11, [STATUS_LABEL, AGENT_LABEL]);

    // The frozen-prefix table disappears from under the command the instant the
    // first execution label comes off, standing in for the faults no step
    // models — a SQLite busy timeout, an I/O error. Before the guard around
    // steps 3-7 this rejection escaped the command entirely: every affected
    // Issue was already stripped of its labels, and the operator was handed an
    // unhandled failure that named none of them (issue #791 review).
    const sabotage = join(tmpDir, 'break-frozen-prefix.cjs');
    writeFileSync(
      sabotage,
      `const Database = require(${JSON.stringify(requireFrom.resolve('better-sqlite3'))});
const db = new Database(${JSON.stringify(dbPath)});
db.exec('ALTER TABLE dependency_chain_frozen_prefix RENAME TO dependency_chain_frozen_prefix_gone');
db.close();
`,
      'utf8',
    );

    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes'], {
      FAKE_GH_AFTER_SUSPEND_SCRIPT: sabotage,
    });
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.ok).toBe(false);
    expect(payload.status).toBe('failed');
    expect(payload.failure.kind).toBe('store_error');
    expect(payload.failure.transient).toBe(true);
    expect(payload.failure.message).toContain('after automation was suspended');
    expect(payload.failure.message).toContain('dependency_chain_frozen_prefix');

    // The whole point: the answer names the Issues whose automation is off and
    // the command that turns it back on.
    const recovery = payload.failure.recovery.join(' ');
    expect(recovery).toContain('#10');
    expect(recovery).toContain('#11');
    expect(recovery).toContain('admin issue activate 10,11 --session-id addon-dev --yes');
    expect(payload.labels.map((l) => l.issueNumber).sort()).toEqual([10, 11]);

    // And the state it describes is the real one: labels off, registry
    // untouched, so the Issues are diagnosable but not executable.
    expect(readLabels(10)).toEqual([]);
    expect(readLabels(11)).toEqual([]);
    expect(await store.listChains()).toEqual([]);
  }, 30_000);

  test('a GitHub edit that lands mid-run is caught by the read-back, not imported', async () => {
    seedLabels(11, [STATUS_LABEL]);
    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes'], {
      // #77 starts blocking #11 the moment this command's own write lands.
      FAKE_GH_INJECT_AFTER_WRITE: '77:11',
    });
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.failure.kind).toBe('structural');
    expect(payload.failure.message).toContain('77->11');
    expect(await store.listChains()).toEqual([]);
    expect(payload.failure.recovery.join(' ')).toContain('admin issue activate');
    expect(readLabels(11)).toEqual([]);
  }, 30_000);

  test('a label that cannot be restored is reported as a non-executable state, with the graph applied', async () => {
    seedLabels(11, [STATUS_LABEL]);
    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes'], {
      FAKE_GH_FAIL_LABEL_ADD: STATUS_LABEL,
    });
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.status).toBe('applied');
    expect(payload.failure.kind).toBe('label_error');
    expect(payload.failure.transient).toBe(true);
    // The edit itself is complete on both sides...
    expect(readBlockedBy(11)).toEqual([10]);
    const graph = await store.getChain('chain_11');
    expect(graph.chain.acceptedRevision).toBe(graph.chain.graphRevision);
    // ...but the Issue is not executable, and the answer says how to fix that.
    expect(readLabels(11)).toEqual([]);
    expect(payload.labels.find((l) => l.issueNumber === 11).withheld).toEqual([STATUS_LABEL]);
    expect(payload.failure.recovery.join(' ')).toContain('admin issue activate');
  }, 30_000);

  test('a chain that moves while GitHub is being read is refused rather than overwritten', async () => {
    const chainId = await seedAcceptedChain();
    const raceScript = join(tmpDir, 'race.mjs');
    const dist = new URL('../dist/index.js', import.meta.url).href;
    writeFileSync(
      raceScript,
      `import { SqliteChainRegistryStore } from ${JSON.stringify(dist)};
const store = new SqliteChainRegistryStore(${JSON.stringify(dbPath)});
const result = await store.setChainSyncState(${JSON.stringify(chainId)}, {
  status: 'error', error: 'recorded by a newer run', now: '2026-08-09T11:00:00.000Z',
});
store.close();
if (!result.ok) { console.error(result.code); process.exit(1); }
`,
      'utf8',
    );

    const r = run(['chain', 'append', chainId, '22', ...dbArgs(), '--yes'], { FAKE_GH_RACE_SCRIPT: raceScript });
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.failure.kind).toBe('conflict');
    expect(payload.failure.transient).toBe(true);
    const graph = await store.getChain(chainId);
    expect(graph.chain.headIssueNumber).toBe(21);
    expect(graph.members.map((m) => m.issueNumber).sort((a, b) => a - b)).toEqual([20, 21]);
  }, 30_000);
});

/**
 * Two chain edits that overlap must not run at once (issue #791 review). The
 * hazard is not the relationship writes — those are idempotent — but the pair of
 * steps around them: the second edit finds the execution labels already removed,
 * so it owns nothing and can restore nothing, and the first edit hands them back
 * while the second is still drawing relationships. The Issue becomes eligible
 * for pickup half-way through an edit. A chain name is claimed across the same
 * span — the check that it is free and its registration — so a second run
 * asking for it is turned away before it starts; what makes the name itself
 * safe is that the registry takes it in the same transaction that allocates the
 * chain ID, which the named-race test above pins.
 *
 * The other edit is stood in for by claiming the scope directly: a second CLI
 * process would have to be held mid-run to reproduce it, and what is being
 * pinned is the refusal, not the scheduler.
 */
describe('admin chain edit — overlapping edits', () => {
  const OTHER_OWNER = 'other-run-0000';

  /** Claim a scope as a chain edit that is still running would. */
  async function holdScope(scope, now = new Date().toISOString()) {
    const held = await store.acquireChainEditLocks({
      scopes: [scope],
      ownerId: OTHER_OWNER,
      operationId: 'admin chain new-90,91',
      now,
    });
    expect(held.ok).toBe(true);
  }

  /** True when `scope` is claimed by nobody. Probing takes it, so it is released again. */
  async function scopeIsFree(scope) {
    const probe = await store.acquireChainEditLocks({
      scopes: [scope],
      ownerId: 'probe-0000',
      operationId: 'probe',
      now: new Date().toISOString(),
    });
    if (probe.ok) await store.releaseChainEditLocks([scope], 'probe-0000');
    return probe.ok;
  }

  test('an edit overlapping a running one is refused before it suspends anything', async () => {
    seedLabels(10, [STATUS_LABEL]);
    seedLabels(11, [STATUS_LABEL, AGENT_LABEL]);
    await holdScope('issue:addon-dev:11');

    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.failure.kind).toBe('lock_contended');
    expect(payload.failure.transient).toBe(true);
    expect(payload.failure.message).toContain('issue #11');
    expect(payload.failure.message).toContain('admin chain new-90,91');

    // Refused at step 0: no label moved, no relationship drawn, no chain row —
    // and so nothing for the recovery plan to unwind.
    expect(readLabels(10)).toEqual([STATUS_LABEL]);
    expect(readLabels(11)).toEqual([AGENT_LABEL, STATUS_LABEL].sort());
    expect(readBlockedBy(11)).toEqual([]);
    expect(await store.listChains()).toEqual([]);
    expect(payload.failure.recovery.join(' ')).not.toContain('admin issue activate');

    // The refusal took nothing, so the Issue it did not overlap on is untouched.
    expect(await scopeIsFree('issue:addon-dev:10')).toBe(true);
  }, 30_000);

  test('an edit gives its claims back when it finishes, so the next one can run', async () => {
    seedLabels(11, [STATUS_LABEL]);
    const first = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(first.code).toBe(0);

    expect(await scopeIsFree('issue:addon-dev:10')).toBe(true);
    expect(await scopeIsFree('issue:addon-dev:11')).toBe(true);

    // And an append over the same chain — which claims the existing members too
    // — is not blocked by the run that created it.
    const second = run(['chain', 'append', 'chain_11', '12', ...dbArgs(), '--yes']);
    expect(second.code).toBe(0);
    expect(parse(second).status).toBe('applied');
  }, 30_000);

  test('a failed edit gives its claims back too, so the documented retry can actually run', async () => {
    seedLabels(11, [STATUS_LABEL]);
    const r = run(['chain', 'new', '10,11,12', ...dbArgs(), '--session-id', 'addon-dev', '--yes'], {
      FAKE_GH_FAIL_DEP: '11:12',
    });
    expect(r.code).toBe(1);
    expect(parse(r).failure.kind).toBe('relationship_error');

    for (const n of [10, 11, 12]) {
      expect(await scopeIsFree(`issue:addon-dev:${n}`)).toBe(true);
    }
  }, 30_000);

  test('a chain name is held for the whole edit, so a concurrent run cannot take it', async () => {
    seedLabels(31, [STATUS_LABEL]);
    await holdScope('alias:auth-work');

    const r = run(['chain', 'new', '30,31', 'auth-work', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.failure.kind).toBe('lock_contended');
    expect(payload.failure.message).toContain('the chain name "auth-work"');
    expect(payload.failure.remediation).toContain('chain name');

    // The loser of the race no longer ends up with an accepted chain and no
    // alias: it never wrote anything at all.
    expect(readBlockedBy(31)).toEqual([]);
    expect(readLabels(31)).toEqual([STATUS_LABEL]);
    expect(await store.listChains()).toEqual([]);
  }, 30_000);

  test('a claim released after the edit lets the name be checked and registered as one step', async () => {
    const first = run(['chain', 'new', '10,11', 'auth-work', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(first.code).toBe(0);
    expect(await store.resolveChainHandle('auth-work')).toBe('chain_11');
    expect(await scopeIsFree('alias:auth-work')).toBe(true);
  }, 30_000);

  test('a claim left behind by a crashed edit is taken over once it goes stale', async () => {
    seedLabels(11, [STATUS_LABEL]);
    // Yesterday: far past the staleness window, so the run that took it is gone.
    await holdScope('issue:addon-dev:11', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes']);
    expect(r.code).toBe(0);
    expect(parse(r).status).toBe('applied');
    expect(readBlockedBy(11)).toEqual([10]);
  }, 30_000);

  test('an edit whose claim changes hands mid-run stops instead of writing alongside the taker', async () => {
    seedLabels(10, [STATUS_LABEL]);
    seedLabels(11, [STATUS_LABEL, AGENT_LABEL]);

    // The scopes are taken over the moment the first execution label comes off.
    // A heartbeat cannot catch this on its own: every `gh` call is a
    // `spawnSync`, so a provider slow enough to carry the run past the
    // staleness window blocks the event loop and no timer fires at all. Before
    // the claim was re-asserted between mutations, the losing run went on
    // suspending, relating and restoring the same Issues the taker now owns
    // (issue #791 review).
    const steal = join(tmpDir, 'steal-claim.cjs');
    writeFileSync(
      steal,
      `const Database = require(${JSON.stringify(requireFrom.resolve('better-sqlite3'))});
const db = new Database(${JSON.stringify(dbPath)});
db.prepare("UPDATE dependency_chain_edit_lock SET owner_id = ?, operation_id = ?").run(
  ${JSON.stringify(OTHER_OWNER)},
  'admin chain append-11,40',
);
db.close();
`,
      'utf8',
    );

    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes'], {
      FAKE_GH_AFTER_SUSPEND_SCRIPT: steal,
    });
    expect(r.code).toBe(1);
    const payload = parse(r);
    expect(payload.failure.kind).toBe('lock_contended');
    expect(payload.failure.transient).toBe(true);
    expect(payload.failure.message).toContain('issue #11');

    // Stopped before the first relationship write, so GitHub holds nothing this
    // run drew and the registry holds no chain.
    expect(readBlockedBy(11)).toEqual([]);
    expect(readBlockedBy(10)).toEqual([]);
    expect(await store.listChains()).toEqual([]);

    // #10's labels came off before the takeover, so they stay off — the other
    // edit is mid-sequence on it — and the answer names it and the command that
    // restores it. #11 was never suspended at all: the claim is re-asserted
    // between the Issues of the loop, so the run stopped before its labels came
    // off rather than after.
    expect(readLabels(10)).toEqual([]);
    expect(readLabels(11)).toEqual([AGENT_LABEL, STATUS_LABEL].sort());
    expect(payload.failure.recovery.join(' ')).toContain('admin issue activate 10');

    // And the claim it lost is left with its new owner rather than released out
    // from under the run that now holds it.
    expect(await scopeIsFree('issue:addon-dev:11')).toBe(false);
  }, 30_000);

  test('a run blocked in a provider call keeps its claim, however stale the clock says it is', async () => {
    seedLabels(10, [STATUS_LABEL]);
    seedLabels(11, [STATUS_LABEL]);

    // The other edit does not fake anything: it goes through the real
    // acquisition, from a real second process, at a clock two hours past the
    // staleness window — while this run is blocked inside a `gh` call and
    // firing no heartbeat at all. Age alone would hand it the scope in the
    // middle of the first run's mutation, and the first run would carry on
    // writing relationships and handing execution labels back on Issues the
    // second one now owned (issue #791 review).
    const probe = join(tmpDir, 'takeover-probe.mjs');
    writeFileSync(
      probe,
      `import { writeFileSync } from 'fs';
import { SqliteChainRegistryStore } from ${JSON.stringify(LIB_URL)};
const store = new SqliteChainRegistryStore(${JSON.stringify(dbPath)});
const result = await store.acquireChainEditLocks({
  scopes: ['issue:addon-dev:11'],
  ownerId: ${JSON.stringify(OTHER_OWNER)},
  operationId: 'admin chain append-11,40',
  now: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
});
store.close();
writeFileSync(${JSON.stringify(join(stateDir, 'takeover.json'))}, JSON.stringify(result), 'utf8');
`,
      'utf8',
    );

    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes'], {
      FAKE_GH_AFTER_SUSPEND_SCRIPT: probe,
    });
    expect(r.code).toBe(0);
    expect(parse(r).status).toBe('applied');

    const attempt = JSON.parse(readFileSync(join(stateDir, 'takeover.json'), 'utf8'));
    expect(attempt.ok).toBe(false);
    expect(attempt.heldBy.operationId).toContain('admin chain new');
    // What refused it was the owning process, named on the claim.
    expect(attempt.heldBy.pid).toBeGreaterThan(0);

    // And the run that kept its claim finished the edit and handed the labels
    // back itself.
    expect(readBlockedBy(11)).toEqual([10]);
    expect(readLabels(10)).toEqual([STATUS_LABEL]);
    expect(readLabels(11)).toEqual([STATUS_LABEL]);
  }, 30_000);

  test('a claim lost between two restores stops step 7 instead of relabelling the next Issue', async () => {
    seedLabels(10, [STATUS_LABEL]);
    seedLabels(11, [STATUS_LABEL]);

    // The scopes change hands the moment the FIRST Issue's execution label goes
    // back on. Checking the claim once before step 7 cannot catch this: each
    // restore is its own blocking provider call, so the answer from before #10
    // says nothing about #11, and the run used to hand #11 its labels back in
    // the middle of the edit that now owns it (issue #791 review).
    const steal = join(tmpDir, 'steal-during-restore.cjs');
    writeFileSync(
      steal,
      `const Database = require(${JSON.stringify(requireFrom.resolve('better-sqlite3'))});
const db = new Database(${JSON.stringify(dbPath)});
db.prepare("UPDATE dependency_chain_edit_lock SET owner_id = ?, operation_id = ?, owner_pid = NULL, owner_host = NULL").run(
  ${JSON.stringify(OTHER_OWNER)},
  'admin chain append-11,40',
);
db.close();
`,
      'utf8',
    );

    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev', '--yes'], {
      FAKE_GH_AFTER_LABEL_ADD_SCRIPT: steal,
    });
    expect(r.code).toBe(1);
    const payload = parse(r);

    // The graph itself landed — step 6 committed before the claim was lost —
    // so the edit stands and only the labels are unresolved.
    expect(payload.status).toBe('applied');
    expect(payload.ok).toBe(false);
    expect(payload.failure.kind).toBe('lock_contended');
    expect(readBlockedBy(11)).toEqual([10]);

    // #10 was restored before the takeover; #11 stays suspended, which is what
    // keeps it out of the loop's reach while the other edit runs.
    expect(readLabels(10)).toEqual([STATUS_LABEL]);
    expect(readLabels(11)).toEqual([]);
    expect(payload.labels.find((l) => l.issueNumber === 10).restored).toEqual([STATUS_LABEL]);
    expect(payload.labels.find((l) => l.issueNumber === 11).restored).toEqual([]);

    // The recovery plan names both halves: what to hand back later, and what
    // this run had already handed back before it noticed.
    const recovery = payload.failure.recovery.join(' ');
    expect(recovery).toContain('admin issue activate 11');
    expect(recovery).toContain('admin issue suspend 10');
    expect(recovery).not.toContain('admin issue activate 10');
  }, 30_000);

  test('a preview neither claims a scope nor is blocked by one', async () => {
    seedLabels(11, [STATUS_LABEL]);
    await holdScope('issue:addon-dev:11');

    const r = run(['chain', 'new', '10,11', ...dbArgs(), '--session-id', 'addon-dev']);
    expect(r.code).toBe(0);
    expect(parse(r).status).toBe('would_apply');
    // A preview writes nothing, so it has nothing to protect and must not block
    // the apply it is a preview of.
    expect(await scopeIsFree('issue:addon-dev:10')).toBe(true);
  }, 30_000);
});
