/**
 * Lifecycle tests for the runner-owned permission overlay in the GLOBAL
 * Antigravity CLI settings (issue #830, docs/antigravity-workspace-settings.md
 * §2.5).
 *
 * This is the layer `agy` 1.1.9 actually consults, and it is shared with
 * unrelated user configuration, so what these pin is not "the rules are there"
 * but everything around it: that only workspace-scoped read rules are
 * installed, that unrelated settings survive byte-for-byte, that the entries are
 * removed again on release, that a crashed run's entries are reclaimed rather
 * than left behind, and that a concurrent run is never stripped of its grants.
 */
import { execFileSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Worker } from 'worker_threads';
import {
  prepareAntigravityWorkspaceSettings,
  releaseAntigravityWorkspaceSettings,
  verifyPreparedWorkspaceSettings,
} from '../dist/handlers/antigravity-workspace.js';
import { AntigravityWorkspaceSettingsError } from '../dist/core/antigravity-workspace-settings.js';

const OVERLAY_DIR = 'n8n-ai-cli-loop-overlays';
/** A pid that cannot be running: above every platform's pid_max. */
const DEAD_PID = 2_147_483_646;

let tmpDir;
let globalDir;
let globalSettingsPath;
let foreignCount;

function initRepo(root) {
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'initial'], { cwd: root });
  return realpathSync.native(root);
}

const prepare = (root, overrides = {}) =>
  prepareAntigravityWorkspaceSettings({
    workspaceRoot: root,
    cmdSource: 'cli-default',
    globalSettingsPath,
    probeCliVersion: () => '1.1.9',
    ...overrides,
  });

const readGlobal = () => JSON.parse(readFileSync(globalSettingsPath, 'utf8'));
const journals = () => (existsSync(join(globalDir, OVERLAY_DIR)) ? readdirSync(join(globalDir, OVERLAY_DIR)) : []);

/**
 * Stand in for another still-installed overlay: one workspace-scoped read rule
 * in the store plus the journal claiming it, owned by a process that is
 * demonstrably alive but is not this one (the test runner's parent). Returns the
 * journal's file name.
 */
function foreignOverlay(workspaceRoot, pid = process.ppid, createdAt = new Date().toISOString()) {
  const document = existsSync(globalSettingsPath) ? readGlobal() : {};
  const containers = {
    permissionsWasAbsent: document.permissions === undefined,
    allowWasAbsent: document.permissions?.allow === undefined,
    denyWasAbsent: document.permissions?.deny === undefined,
  };
  const rule = `read_file(${workspaceRoot}/**)`;
  document.permissions = {
    allow: [...(document.permissions?.allow ?? []), rule],
    deny: [...(document.permissions?.deny ?? [])],
  };
  writeFileSync(globalSettingsPath, JSON.stringify(document, null, 2) + '\n');
  mkdirSync(join(globalDir, OVERLAY_DIR), { recursive: true });
  const name = `foreign-${foreignCount++}.json`;
  writeFileSync(join(globalDir, OVERLAY_DIR, name), JSON.stringify({
    version: 1,
    workspaceRoot,
    pid,
    createdAt,
    claim: { allow: [rule], deny: [] },
    foreign: { allow: [], deny: [] },
    containers,
    suspended: { allow: [] },
  }, null, 2) + '\n');
  return name;
}

function refusal(fn) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AntigravityWorkspaceSettingsError);
    return err;
  }
  throw new Error('expected a refusal');
}

const refusalReason = (fn) => refusal(fn).reason;

/** An ISO timestamp older than the 12-hour overlay TTL. */
const pastTtl = () => new Date(Date.now() - 13 * 60 * 60 * 1_000).toISOString();

/**
 * The revoking helper: it waits for `triggerPath` to appear, writes `revoked`
 * over the store, and hands the lock over by removing it.
 *
 * It runs on a worker thread because preparation waits for the store's lock
 * synchronously — the test's own thread is inside that wait and cannot service
 * an event loop — and it signals readiness through shared memory rather than the
 * file system, which is what lets the parent block on it deterministically.
 */
const REVOKER_SOURCE = `
const { existsSync, writeFileSync, rmSync } = require('fs');
const { workerData } = require('worker_threads');
const { ready, triggerPath, settingsPath, revoked, lockPath, delayMs } = workerData;
const revoke = () => {
  // The revocation is on disk before the lock is handed over, so the run under
  // test can never take the lock and read the pre-revocation document.
  writeFileSync(settingsPath, revoked);
  rmSync(lockPath, { force: true });
};
const watch = () => {
  if (existsSync(triggerPath)) { setTimeout(revoke, delayMs); return; }
  setTimeout(watch, 5);
};
watch();
// Readiness last: it now means "watching", not merely "started".
Atomics.store(ready, 0, 1);
Atomics.notify(ready, 0);
`;

/**
 * Start the revoking helper and block until it is genuinely watching.
 *
 * The helper has to act *during* a synchronous preparation, and it has to be
 * running before that preparation starts: the runner gives up on a contended
 * lock after ten seconds, so a helper still starting up inside that window would
 * fail the test as a lock the runner never got rather than as the race it is
 * about.
 *
 * A worker thread is what makes that wait deterministic. Readiness is a shared
 * memory write this thread blocks on, and the helper is a thread rather than a
 * process: no interpreter is spawned, nothing is resolved from disk, and the
 * handshake does not queue behind Jest's own parallel workers the way the
 * earlier construction's twenty-second wait for a spawned helper's readiness
 * file did (issue #830 review). The thread also cannot outlive this process.
 *
 * The bound below is a deadlock backstop, not a startup budget: it is three
 * orders of magnitude above a thread bootstrap and exists only so a helper that
 * cannot run at all fails the test by name, instead of blocking this thread past
 * every timer Jest would otherwise fire.
 */
function startRevoker({ triggerPath, settingsPath, revoked, lockPath, delayMs = 0 }) {
  const ready = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(REVOKER_SOURCE, {
    eval: true,
    workerData: { ready, triggerPath, settingsPath, revoked, lockPath, delayMs },
  });
  // The watch loop runs until the test terminates it; it must not be what keeps
  // this process alive.
  worker.unref();
  if (Atomics.wait(ready, 0, 0, 30_000) === 'timed-out' && Atomics.load(ready, 0) === 0) {
    void worker.terminate();
    throw new Error('the revoker thread never signalled readiness');
  }
  return worker;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'antigravity-overlay-'));
  globalDir = join(tmpDir, 'cli');
  mkdirSync(globalDir, { recursive: true });
  globalSettingsPath = join(globalDir, 'settings.json');
  foreignCount = 0;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

describe('global permission overlay — installation (issue #830)', () => {
  test('installs the workspace-scoped read rules the headless CLI actually applies', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');

    const prepared = prepare(root);
    expect(prepared.globalOverlay.installed).toBe(true);

    const { allow, deny } = readGlobal().permissions;
    for (const tool of ['glob', 'list_directory', 'read_file', 'read_many_files', 'search_file_content']) {
      expect(allow).toContain(`${tool}(${root})`);
      expect(allow).toContain(`${tool}(${root}/**)`);
    }
    expect(allow).toHaveLength(prepared.globalOverlay.allowRuleCount);
    // Every installed rule is scoped to the exact workspace: no parent grant,
    // no unscoped grant, nothing outside the run's own worktree.
    for (const rule of [...allow, ...deny]) {
      const match = /^[a-z_]+\((.*)\)$/.exec(rule);
      expect(match).not.toBeNull();
      expect(match[1] === root || match[1].startsWith(`${root}/`)).toBe(true);
    }
    // Sensitive paths inside the workspace stay denied.
    expect(deny).toContain(`read_file(${root}/**/.env)`);
  });

  test('grants no write, command, network, or credential capability globally', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    prepare(root);

    const { allow, deny } = readGlobal().permissions;
    for (const tool of ['write_file', 'replace', 'run_shell_command', 'web_fetch', 'google_web_search', 'save_memory']) {
      expect(allow.some((rule) => rule.startsWith(`${tool}(`))).toBe(false);
      expect(allow).not.toContain(tool);
      // Unscoped tool-name denies are NOT installed globally either: they would
      // change the CLI's behaviour for every other workspace on the machine.
      expect(deny).not.toContain(tool);
    }
  });

  test('an operator’s own grants are suspended for the run, not inherited', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    const original = {
      trustedWorkspaces: [root],
      permissions: {
        allow: ['run_shell_command', 'write_file', 'read_file(/home/dev/secrets/**)'],
      },
    };
    writeFileSync(globalSettingsPath, JSON.stringify(original, null, 2) + '\n');

    const prepared = prepare(root);
    const { allow } = readGlobal().permissions;
    // The global layer is the one headless `agy` applies, so anything left in it
    // is a capability of this invocation — and the workspace document's denies
    // cannot take it back. A read-only research run therefore holds nothing but
    // the runner's own workspace-scoped read rules.
    expect(allow).not.toContain('run_shell_command');
    expect(allow).not.toContain('write_file');
    expect(allow).not.toContain('read_file(/home/dev/secrets/**)');
    expect(allow.every((rule) => rule.includes(root))).toBe(true);
    // The launch-time check refuses if one is re-admitted in the window.
    expect(() => verifyPreparedWorkspaceSettings(root, prepared)).not.toThrow();
    writeFileSync(globalSettingsPath, JSON.stringify({
      ...original,
      permissions: { allow: [...allow, 'run_shell_command'] },
    }, null, 2) + '\n');
    expect(refusalReason(() => verifyPreparedWorkspaceSettings(root, prepared)))
      .toBe('settings-replaced-before-launch');

    releaseAntigravityWorkspaceSettings(prepared);
    expect(readGlobal().permissions.allow).toEqual(original.permissions.allow);
  });

  test('nothing is installed when a refusal fires first', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ theme: 'dark' }, null, 2) + '\n');
    // Untrusted, registration not opted in.
    expect(refusalReason(() => prepare(root))).toBe('workspace-not-trusted');
    expect(readGlobal()).toEqual({ theme: 'dark' });
    expect(journals()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

describe('global permission overlay — release (issue #830)', () => {
  test('restores an unrelated store byte-for-byte, formatting included', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    // Four-space indent, unrelated keys, an unrelated permission rule, and a
    // trust entry for another repository: none of it is the runner's to change.
    const original = JSON.stringify(
      {
        theme: 'dark',
        selectedAuthType: 'oauth',
        permissions: { allow: ['read_file(/home/dev/notes)'], deny: ['run_shell_command'] },
        trustedWorkspaces: ['/somewhere/else', root],
      },
      null,
      4,
    ) + '\n';
    writeFileSync(globalSettingsPath, original);

    const prepared = prepare(root);
    expect(readGlobal().permissions.allow).toContain(`read_file(${root}/**)`);

    releaseAntigravityWorkspaceSettings(prepared);
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(original);
    expect(journals()).toHaveLength(0);
  });

  test('a minified store is neither expanded for the run nor left expanded after it', () => {
    // `JSON.stringify(document, null, 2)` is not the only way a valid store may
    // be written. Re-rendering one that was minified would rewrite every byte of
    // an operator's file for the duration of the run, and the release would then
    // have only the expanded form to restore from (issue #830 review).
    const root = initRepo(join(tmpDir, 'repo'));
    const original = `{"theme":"dark","trustedWorkspaces":["${root}"]}`;
    writeFileSync(globalSettingsPath, original);

    const prepared = prepare(root);
    const during = readFileSync(globalSettingsPath, 'utf8');
    expect(during).toContain(`read_file(${root}/**)`);
    expect(during.includes('\n')).toBe(false);
    // Nothing had to be copied: this store renders back to itself.
    const journalPath = join(globalDir, OVERLAY_DIR, journals()[0]);
    expect(JSON.parse(readFileSync(journalPath, 'utf8')).baseline).toBeUndefined();

    releaseAntigravityWorkspaceSettings(prepared);
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(original);
  });

  test('a store whose bytes re-rendering cannot reproduce still comes back exactly', () => {
    // Spacing `JSON.stringify` does not produce, so installation cannot avoid
    // re-rendering the file: the original bytes are recorded in the journal and
    // written back verbatim once the document is semantically back to them.
    const root = initRepo(join(tmpDir, 'repo'));
    const original = `{"theme": "caf\\u00e9", "trustedWorkspaces": ["${root}"]}\n`;
    writeFileSync(globalSettingsPath, original);

    const prepared = prepare(root);
    expect(readGlobal().permissions.allow).toContain(`read_file(${root}/**)`);
    const journalPath = join(globalDir, OVERLAY_DIR, journals()[0]);
    expect(JSON.parse(readFileSync(journalPath, 'utf8')).baseline).toBe(original);

    releaseAntigravityWorkspaceSettings(prepared);
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(original);
    expect(journals()).toHaveLength(0);
  });

  test('a crashed run’s recorded original survives the reclaim that removes its rules', () => {
    // The store on disk is no longer the restore target once a crashed run's
    // rules have been taken out of it, so the formatting only its journal holds
    // is carried forward by the run that reclaims it.
    const root = initRepo(join(tmpDir, 'repo'));
    const abandoned = join(tmpDir, 'gone');
    const original = `{"theme": "caf\\u00e9", "trustedWorkspaces": ["${root}"]}\n`;
    writeFileSync(globalSettingsPath, `{"theme":"café","trustedWorkspaces":["${root}"],`
      + `"permissions":{"allow":["read_file(${abandoned}/**)"],"deny":[]}}\n`);
    mkdirSync(join(globalDir, OVERLAY_DIR), { recursive: true });
    writeFileSync(join(globalDir, OVERLAY_DIR, 'abandoned.json'), JSON.stringify({
      version: 1,
      workspaceRoot: abandoned,
      pid: DEAD_PID,
      createdAt: new Date().toISOString(),
      baseline: original,
      claim: { allow: [`read_file(${abandoned}/**)`], deny: [] },
      foreign: { allow: [], deny: [] },
      containers: { permissionsWasAbsent: true, allowWasAbsent: true, denyWasAbsent: true },
    }, null, 2) + '\n');

    const prepared = prepare(root);
    expect(prepared.globalOverlay.reclaimed).toBe(1);

    releaseAntigravityWorkspaceSettings(prepared);
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(original);
    expect(journals()).toHaveLength(0);
  });

  test('a co-tenant’s recorded original outlives the co-tenant that recorded it', () => {
    // Two runs on the same workspace are co-tenants, and the first one out takes
    // its journal — and with it the only copy of a formatting no serialiser
    // reproduces — away with it. The second therefore carries that baseline into
    // its own journal at install time, so whichever run is last out still has
    // the operator's bytes to restore (issue #830 review).
    const root = initRepo(join(tmpDir, 'repo'));
    const original = `{"theme": "caf\\u00e9", "trustedWorkspaces": ["${root}"]}\n`;
    const rule = `read_file(${root}/**)`;
    // The store as the first run on this workspace left it: re-rendered, because
    // those bytes cannot be reproduced, with its own rule installed.
    writeFileSync(globalSettingsPath, JSON.stringify({
      theme: 'café',
      trustedWorkspaces: [root],
      permissions: { allow: [rule], deny: [] },
    }, null, 2) + '\n');
    mkdirSync(join(globalDir, OVERLAY_DIR), { recursive: true });
    const coTenant = join(globalDir, OVERLAY_DIR, 'co-tenant.json');
    writeFileSync(coTenant, JSON.stringify({
      version: 1,
      workspaceRoot: root,
      // Alive, and not this process: a genuine second run on this workspace.
      pid: process.ppid,
      createdAt: new Date(Date.now() - 1_000).toISOString(),
      baseline: original,
      claim: { allow: [rule], deny: [] },
      foreign: { allow: [], deny: [] },
      containers: { permissionsWasAbsent: true, allowWasAbsent: true, denyWasAbsent: true },
      suspended: { allow: [] },
    }, null, 2) + '\n');

    const prepared = prepare(root);
    const ours = journals().find((name) => name !== 'co-tenant.json');
    expect(JSON.parse(readFileSync(join(globalDir, OVERLAY_DIR, ours), 'utf8')).baseline).toBe(original);

    // The co-tenant releases first: the rules stay, because this run claims them
    // too, and its journal goes — taking its copy of those bytes with it.
    rmSync(coTenant);

    releaseAntigravityWorkspaceSettings(prepared);
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(original);
    expect(journals()).toHaveLength(0);
  });

  test('leaves a rule the operator already had', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    const original = {
      permissions: { allow: [`read_file(${root}/**)`] },
      trustedWorkspaces: [root],
    };
    writeFileSync(globalSettingsPath, JSON.stringify(original, null, 2) + '\n');

    const prepared = prepare(root);
    releaseAntigravityWorkspaceSettings(prepared);
    expect(readGlobal()).toEqual(original);
  });

  test('an identical rule the operator adds mid-run survives the release', () => {
    // The overlay installs ONE copy of each rule it did not already find, and
    // one copy is all it may take back out (issue #830 review). A rule the
    // operator writes into their own store while the run is live is not
    // `foreign` — it was not there at installation — so a set-based removal
    // would delete their copy along with the runner's, silently undoing an edit
    // the runner never owned.
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');

    const prepared = prepare(root);
    const rule = `read_file(${root}/**)`;
    const during = readGlobal();
    expect(during.permissions.allow.filter((entry) => entry === rule)).toHaveLength(1);
    during.permissions.allow.push(rule);
    writeFileSync(globalSettingsPath, JSON.stringify(during, null, 2) + '\n');

    releaseAntigravityWorkspaceSettings(prepared);
    // Exactly one copy went: the operator's is still there, and nothing else of
    // the runner's overlay survived it.
    expect(readGlobal().permissions.allow).toEqual([rule]);
    expect(journals()).toHaveLength(0);
  });

  test('is idempotent and a no-op once the journal is gone', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    const prepared = prepare(root);

    releaseAntigravityWorkspaceSettings(prepared);
    const after = readFileSync(globalSettingsPath, 'utf8');
    releaseAntigravityWorkspaceSettings(prepared);
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(after);
    expect(readGlobal().permissions).toBeUndefined();
  });

  test('re-preparing for the same workspace supersedes its own overlay', () => {
    // Preparation runs once per headless invocation (every evidence turn), so a
    // long-lived runner must not accumulate claims only a later run can clear.
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');

    prepare(root);
    prepare(root);
    const third = prepare(root);
    expect(journals()).toHaveLength(1);

    releaseAntigravityWorkspaceSettings(third);
    expect(readGlobal()).toEqual({ trustedWorkspaces: [root] });
    expect(journals()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrency and crash safety
// ---------------------------------------------------------------------------

describe('global permission overlay — concurrency and crash safety (issue #830)', () => {
  test('a second workspace never shares the global permission set, it waits and fails closed', () => {
    // The store's rules are what `agy` applies to WHICHEVER invocation is
    // running, so an overlay live for repo-b would hand repo-a's agent read
    // access to repo-b by absolute path (issue #830 review). Different
    // workspaces therefore take turns instead of merging their grants.
    const first = initRepo(join(tmpDir, 'repo-a'));
    const second = initRepo(join(tmpDir, 'repo-b'));
    const original = JSON.stringify({ trustedWorkspaces: [first, second] }, null, 2) + '\n';
    writeFileSync(globalSettingsPath, original);

    const foreign = foreignOverlay(second);
    expect(refusalReason(() => prepare(first))).toBe('global-overlay-contended');
    // The other workspace's overlay is left exactly as it was, and nothing of
    // this run was installed or journalled.
    expect(readGlobal().permissions.allow).toEqual([`read_file(${second}/**)`]);
    expect(journals()).toEqual([foreign]);

    // Once it releases, the next workspace gets the store to itself.
    rmSync(join(globalDir, OVERLAY_DIR, foreign), { force: true });
    writeFileSync(globalSettingsPath, original);
    const prepared = prepare(first);
    expect(readGlobal().permissions.allow).toContain(`read_file(${first}/**)`);
    expect(readGlobal().permissions.allow.some((rule) => rule.includes(second))).toBe(false);
    releaseAntigravityWorkspaceSettings(prepared);
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(original);
  }, 30_000);

  test('a concurrent run on the SAME workspace is a co-tenant, not contention', () => {
    // Identical scope: nothing crosses the exact-workspace boundary, so the two
    // runs share the rules and the last one out removes them.
    const root = initRepo(join(tmpDir, 'repo'));
    const original = JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n';
    writeFileSync(globalSettingsPath, original);

    const peer = foreignOverlay(root);
    const prepared = prepare(root);
    expect(prepared.globalOverlay.installed).toBe(true);
    expect(prepared.globalOverlay.reclaimed).toBe(0);
    expect(() => verifyPreparedWorkspaceSettings(root, prepared)).not.toThrow();

    // Releasing this run leaves the peer's claim in place.
    releaseAntigravityWorkspaceSettings(prepared);
    expect(readGlobal().permissions.allow).toEqual([`read_file(${root}/**)`]);
    expect(journals()).toEqual([peer]);
  });

  test('a surface key the operator changed under a co-tenant overlay is not handed over', () => {
    // Co-tenants hand the operator's tool-surface values along in their journals
    // rather than re-reading a store that already carries the runner's
    // registration (issue #832 review). A key edited while one is installed is
    // in nobody's journal, so writing over it would leave whichever run is last
    // out restoring the value from before the edit.
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');

    // A genuine co-tenant: this workspace's own overlay, reattributed to a
    // process that is alive but is not this one — a journal carrying this pid
    // would be superseded rather than read as a concurrent run.
    const coTenant = prepare(root);
    const [name] = journals();
    const journalPath = join(globalDir, OVERLAY_DIR, name);
    const record = JSON.parse(readFileSync(journalPath, 'utf8'));
    record.pid = process.ppid;
    writeFileSync(journalPath, JSON.stringify(record, null, 2) + '\n');

    // The operator registers a tool source of their own while it is installed.
    const edit = { theirs: { command: '/usr/local/bin/tool-server' } };
    writeFileSync(globalSettingsPath, JSON.stringify({ ...readGlobal(), mcpServers: edit }, null, 2) + '\n');

    const err = refusal(() => prepare(root));
    expect(err.reason).toBe('global-overlay-contended');
    // Actionable: the key that could not be handed over, and the journal holding
    // it — file name only, never its directory.
    expect(err.detail).toContain('mcpServers');
    expect(err.detail).toContain(name);
    // Nothing of the refused run was installed or journalled, and the edit stands.
    expect(journals()).toEqual([name]);
    expect(readGlobal().mcpServers).toEqual(edit);

    // The co-tenant's own release leaves a key it no longer recognizes exactly
    // as found, so the edit outlives the overlay that was live when it was made.
    releaseAntigravityWorkspaceSettings(coTenant);
    expect(readGlobal()).toEqual({ trustedWorkspaces: [root], mcpServers: edit });

    // And the retry, now with the store to itself, records it as the operator's
    // and puts it back — which is what backing off bought.
    const retried = prepare(root);
    expect(readGlobal().mcpServers).toEqual({});
    releaseAntigravityWorkspaceSettings(retried);
    expect(readGlobal()).toEqual({ trustedWorkspaces: [root], mcpServers: edit });
    expect(journals()).toHaveLength(0);
  }, 30_000);

  test('an overlay this process leaked for another workspace is superseded, not inherited', () => {
    // The journal names the worker's long-lived pid, so nothing else on the
    // machine would treat it as abandoned before the 12-hour TTL. The next
    // preparation in that same process is what clears it (issue #830 review).
    const root = initRepo(join(tmpDir, 'repo'));
    const leaked = initRepo(join(tmpDir, 'repo-leaked'));
    const original = JSON.stringify({ trustedWorkspaces: [root, leaked] }, null, 2) + '\n';
    writeFileSync(globalSettingsPath, original);
    const leakedJournal = foreignOverlay(leaked, process.pid);

    const prepared = prepare(root);
    expect(journals()).toHaveLength(1);
    expect(journals()).not.toContain(leakedJournal);
    const { allow } = readGlobal().permissions;
    expect(allow.some((rule) => rule.includes(leaked))).toBe(false);
    expect(allow).toContain(`read_file(${root}/**)`);

    releaseAntigravityWorkspaceSettings(prepared);
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(original);
    expect(journals()).toHaveLength(0);
  });

  test('another workspace’s grants in the store at launch fail the run closed', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    const other = join(tmpDir, 'repo-other');
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    const prepared = prepare(root);
    expect(() => verifyPreparedWorkspaceSettings(root, prepared)).not.toThrow();

    // Another workspace's overlay appears in the store alongside ours — the
    // exact state exclusivity is meant to prevent. Whatever is installed when
    // the agent starts is what the agent may do, so this is not launched under.
    foreignOverlay(other);

    expect(refusalReason(() => verifyPreparedWorkspaceSettings(root, prepared)))
      .toBe('settings-replaced-before-launch');
    releaseAntigravityWorkspaceSettings(prepared);
  });

  test('a crashed run’s entries are reclaimed by the next preparation', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    const abandoned = join(tmpDir, 'gone');
    // What a killed run leaves behind: its rules in the store and a journal
    // naming them, with a pid that is no longer running.
    writeFileSync(globalSettingsPath, JSON.stringify({
      trustedWorkspaces: [root],
      permissions: { allow: [`read_file(${abandoned}/**)`], deny: [] },
    }, null, 2) + '\n');
    mkdirSync(join(globalDir, OVERLAY_DIR), { recursive: true });
    writeFileSync(join(globalDir, OVERLAY_DIR, 'abandoned.json'), JSON.stringify({
      version: 1,
      workspaceRoot: abandoned,
      pid: DEAD_PID,
      createdAt: new Date().toISOString(),
      claim: { allow: [`read_file(${abandoned}/**)`], deny: [] },
      foreign: { allow: [], deny: [] },
      containers: { permissionsWasAbsent: true, allowWasAbsent: true, denyWasAbsent: true },
    }, null, 2) + '\n');

    const prepared = prepare(root);
    expect(prepared.globalOverlay.reclaimed).toBe(1);
    expect(readGlobal().permissions.allow.some((rule) => rule.includes(abandoned))).toBe(false);
    expect(journals()).toEqual([expect.not.stringContaining('abandoned')]);

    releaseAntigravityWorkspaceSettings(prepared);
    // The crashed run's containers are restored too: nothing of it survives.
    expect(readGlobal()).toEqual({ trustedWorkspaces: [root] });
  });

  test('a reclaimed claim is never applied a second time', () => {
    // A reclaim reverts a crashed run's rules exactly once. The claim it acted
    // on must not outlive that revert as something a later preparation can apply
    // again: an operator who writes the same rule back afterwards owns it, and a
    // second revert would take it away on the next run (issue #830 review).
    const root = initRepo(join(tmpDir, 'repo'));
    const abandoned = join(tmpDir, 'gone');
    const rule = `read_file(${abandoned}/**)`;
    writeFileSync(globalSettingsPath, JSON.stringify({
      trustedWorkspaces: [root],
      permissions: { allow: [rule], deny: [] },
    }, null, 2) + '\n');
    mkdirSync(join(globalDir, OVERLAY_DIR), { recursive: true });
    writeFileSync(join(globalDir, OVERLAY_DIR, 'abandoned.json'), JSON.stringify({
      version: 1,
      workspaceRoot: abandoned,
      pid: DEAD_PID,
      createdAt: new Date().toISOString(),
      claim: { allow: [rule], deny: [] },
      foreign: { allow: [], deny: [] },
      containers: { permissionsWasAbsent: true, allowWasAbsent: true, denyWasAbsent: true },
    }, null, 2) + '\n');

    const first = prepare(root);
    expect(first.globalOverlay.reclaimed).toBe(1);
    // The operator decides they want that rule after all, while this run holds
    // the store.
    const during = readGlobal();
    during.permissions.allow.push(rule);
    writeFileSync(globalSettingsPath, JSON.stringify(during, null, 2) + '\n');
    releaseAntigravityWorkspaceSettings(first);
    expect(readGlobal().permissions.allow).toEqual([rule]);

    // And it is still theirs a run later: nothing re-applies the reclaimed claim.
    const second = prepare(root);
    expect(second.globalOverlay.reclaimed).toBe(0);
    releaseAntigravityWorkspaceSettings(second);
    expect(readGlobal().permissions.allow).toEqual([rule]);
    expect(journals()).toHaveLength(0);
  });

  test('a live run’s overlay is never reclaimed by another preparation', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');

    // A co-tenant on the same workspace, owned by a process that is alive: its
    // workspace still exists and its pid still answers, so it is not reclaimed.
    const peer = foreignOverlay(root);
    const prepared = prepare(root);
    expect(prepared.globalOverlay.reclaimed).toBe(0);
    expect(journals()).toContain(peer);
    releaseAntigravityWorkspaceSettings(prepared);
    expect(readGlobal().permissions.allow).toContain(`read_file(${root}/**)`);
  });

  test('an overlay older than the TTL is NOT reclaimed while its owner is alive', () => {
    // Age is not liveness (issue #830 review). A research run that has been
    // going for more than twelve hours is still an agent operating under the
    // rules its journal names, so reclaiming it here would strip a live run of
    // its grants and let the next preparation install another workspace's rules
    // underneath it.
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    const elderly = foreignOverlay(root, process.ppid, pastTtl());

    const prepared = prepare(root);
    expect(prepared.globalOverlay.reclaimed).toBe(0);
    expect(journals()).toContain(elderly);
    // Its claim survives this run's own release, exactly as a fresh peer's does.
    releaseAntigravityWorkspaceSettings(prepared);
    expect(readGlobal().permissions.allow).toEqual([`read_file(${root}/**)`]);
    expect(journals()).toEqual([elderly]);
  });

  test('a long-lived foreign overlay is contended, and a possibly-recycled pid is named', () => {
    // Same rule from the other side: another workspace's elderly overlay blocks
    // this run rather than being taken over. Because liveness now follows the
    // owning process and nothing else, an inherited pid could otherwise block
    // every later run silently — so the refusal names the journal to remove.
    const root = initRepo(join(tmpDir, 'repo'));
    const other = initRepo(join(tmpDir, 'repo-other'));
    const original = JSON.stringify({ trustedWorkspaces: [root, other] }, null, 2) + '\n';
    writeFileSync(globalSettingsPath, original);
    const elderly = foreignOverlay(other, process.ppid, pastTtl());

    const err = refusal(() => prepare(root));
    expect(err.reason).toBe('global-overlay-contended');
    expect(err.detail).toContain(elderly);
    expect(err.detail).toMatch(/may have been reused/);
    // A journal file NAME, never a path: this detail reaches a bounded artifact.
    expect(err.detail).not.toContain(globalDir);

    // Nothing of this run was installed, and the blocker is untouched.
    expect(readGlobal().permissions.allow).toEqual([`read_file(${other}/**)`]);
    expect(journals()).toEqual([elderly]);
  }, 30_000);

  test('a lock left behind by a dead process is taken over, not waited on', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    const lockPath = `${globalSettingsPath}.n8n-ai-cli-loop.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, at: new Date().toISOString() }) + '\n');

    const prepared = prepare(root);
    expect(prepared.globalOverlay.installed).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    releaseAntigravityWorkspaceSettings(prepared);
  });

  test('a failed replacement leaves the previous turn’s journal reclaimable', () => {
    // Every evidence turn re-prepares. If the replacement journal cannot be
    // written, the entries the previous turn installed are still in the store,
    // so the journal naming them must survive: it is the only handle by which
    // they can be released or reclaimed.
    const root = initRepo(join(tmpDir, 'repo'));
    const original = JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n';
    writeFileSync(globalSettingsPath, original);

    const first = prepare(root);
    const [firstJournal] = journals();
    expect(firstJournal).toBeDefined();

    const overlayDirPath = join(globalDir, OVERLAY_DIR);
    chmodSync(overlayDirPath, 0o500);
    try {
      expect(refusalReason(() => prepare(root))).toBe('global-settings-write-failed');
      expect(journals()).toEqual([firstJournal]);
    } finally {
      chmodSync(overlayDirPath, 0o700);
    }

    // The store still carries the first turn's entries, and its handle still
    // removes them: nothing was orphaned by the failed turn.
    expect(readGlobal().permissions.allow).toContain(`read_file(${root}/**)`);
    releaseAntigravityWorkspaceSettings(first);
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(original);
    expect(journals()).toHaveLength(0);
  });

  test('a lock held by a live process is waited on, never taken over', () => {
    // A critical section slower than the staleness window is still a critical
    // section: evicting its holder would admit a second writer to the store.
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    const lockPath = `${globalSettingsPath}.n8n-ai-cli-loop.lock`;
    // This test's own pid: demonstrably alive, and the lock is long expired.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
    const longAgo = new Date(Date.now() - 10 * 60 * 1_000);
    utimesSync(lockPath, longAgo, longAgo);

    expect(refusalReason(() => prepare(root))).toBe('global-settings-locked');
    expect(existsSync(lockPath)).toBe(true);
    expect(journals()).toHaveLength(0);
    expect(readGlobal().permissions).toBeUndefined();
  }, 30_000);

  test('a takeover already in progress is never raced', () => {
    // Two contenders can reach the same "this lock is abandoned" conclusion. If
    // both then unlinked by path, the loser would delete the lock the winner had
    // already replaced it with and both would enter the critical section
    // (issue #830 review). Only one process may be unlinking at a time.
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    const lockPath = `${globalSettingsPath}.n8n-ai-cli-loop.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, at: new Date().toISOString() }) + '\n');
    // Another contender is mid-takeover of exactly this lock.
    writeFileSync(`${lockPath}.takeover`, '');

    expect(refusalReason(() => prepare(root))).toBe('global-settings-locked');
    // The lock the other contender is working on was not unlinked by this one.
    expect(existsSync(lockPath)).toBe(true);
    expect(journals()).toHaveLength(0);
    expect(readGlobal().permissions).toBeUndefined();
  }, 30_000);

  test('a takeover marker left behind by a crash is reaped, not honoured forever', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    const lockPath = `${globalSettingsPath}.n8n-ai-cli-loop.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, at: new Date().toISOString() }) + '\n');
    const takeoverPath = `${lockPath}.takeover`;
    writeFileSync(takeoverPath, '');
    // The marker guards a handful of syscalls, so this one outlived its owner.
    const longAgo = new Date(Date.now() - 10 * 60 * 1_000);
    utimesSync(takeoverPath, longAgo, longAgo);

    const prepared = prepare(root);
    expect(prepared.globalOverlay.installed).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(takeoverPath)).toBe(false);
    releaseAntigravityWorkspaceSettings(prepared);
  }, 30_000);

  test('an expired lock is taken over even when its holder is unknown', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    const lockPath = `${globalSettingsPath}.n8n-ai-cli-loop.lock`;
    writeFileSync(lockPath, 'not json\n');
    const longAgo = new Date(Date.now() - 10 * 60 * 1_000);
    utimesSync(lockPath, longAgo, longAgo);

    expect(prepare(root).globalOverlay.installed).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('a global overlay stripped between preparation and launch fails the run closed', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    const prepared = prepare(root);
    expect(() => verifyPreparedWorkspaceSettings(root, prepared)).not.toThrow();

    // Something edits the store between preparation and launch: the CLI would
    // apply a permission set the runner never authored.
    writeFileSync(globalSettingsPath, JSON.stringify({
      trustedWorkspaces: [root],
      permissions: { allow: [], deny: [] },
    }, null, 2) + '\n');
    expect(refusalReason(() => verifyPreparedWorkspaceSettings(root, prepared)))
      .toBe('settings-replaced-before-launch');
  });

  test('a store that is not JSON is never repaired, replaced, or overlaid', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, '{ half a document');
    expect(refusalReason(() => prepare(root))).toBe('trust-store-unreadable');
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe('{ half a document');
    expect(journals()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Damaged journals
// ---------------------------------------------------------------------------

describe('global permission overlay — damaged journals (issue #830 review)', () => {
  const writeJournal = (name, content) => {
    mkdirSync(join(globalDir, OVERLAY_DIR), { recursive: true });
    const path = join(globalDir, OVERLAY_DIR, name);
    writeFileSync(path, content);
    return path;
  };

  test('an unparseable journal is never treated as absent', () => {
    // A journal is the only record of rules that may be installed right now.
    // Skipping it discards the claim, and no later reclaim could remove those
    // entries — the TTL cannot help, because the TTL is read from the journal.
    const root = initRepo(join(tmpDir, 'repo'));
    const original = JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n';
    writeFileSync(globalSettingsPath, original);
    const damaged = writeJournal('damaged.json', '{"version":1,"workspaceRoot":"/gone","claim":{"allow":["read');

    expect(refusalReason(() => prepare(root))).toBe('global-overlay-journal-damaged');
    // Nothing installed, nothing deleted: the file stays for the operator.
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(original);
    expect(existsSync(damaged)).toBe(true);
    expect(journals()).toEqual(['damaged.json']);
  });

  test('a journal whose claim shape the revert path cannot act on is damaged too', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    // Valid JSON, valid header, but `claim.deny` is missing: accepting it would
    // crash the very release it exists to make deterministic.
    writeJournal('half-shaped.json', JSON.stringify({
      version: 1,
      workspaceRoot: root,
      pid: process.ppid,
      createdAt: new Date().toISOString(),
      claim: { allow: [`read_file(${root}/**)`] },
      foreign: { allow: [], deny: [] },
      containers: { permissionsWasAbsent: true, allowWasAbsent: true, denyWasAbsent: true },
    }, null, 2) + '\n');

    expect(refusalReason(() => prepare(root))).toBe('global-overlay-journal-damaged');
    expect(readGlobal().permissions).toBeUndefined();
  });

  test('a journal whose container flags the revert path needs are missing is damaged', () => {
    // `containers` decides whether the restored document keeps the operator's
    // `permissions` container and its lists. An absent or non-boolean flag reads
    // as "the operator had none", so a journal shaped like any of these would
    // make a reclaim delete configuration the runner does not own — on the
    // strength of a file the runner never wrote (issue #830 review).
    const root = initRepo(join(tmpDir, 'repo'));
    const original = JSON.stringify({
      trustedWorkspaces: [root],
      permissions: { allow: ['read_file(/home/dev/notes)'], deny: [] },
    }, null, 2) + '\n';
    const shapes = [
      {},
      [],
      { permissionsWasAbsent: true, allowWasAbsent: true },
      { permissionsWasAbsent: 'yes', allowWasAbsent: true, denyWasAbsent: true },
    ];
    shapes.forEach((containers, index) => {
      writeFileSync(globalSettingsPath, original);
      const path = writeJournal(`containers-${index}.json`, JSON.stringify({
        version: 1,
        workspaceRoot: root,
        // Dead, so an accepted journal would be reclaimed — and its claim is the
        // operator's own rule.
        pid: DEAD_PID,
        createdAt: new Date().toISOString(),
        claim: { allow: ['read_file(/home/dev/notes)'], deny: [] },
        foreign: { allow: [], deny: [] },
        containers,
      }, null, 2) + '\n');

      expect(refusalReason(() => prepare(root))).toBe('global-overlay-journal-damaged');
      // Nothing installed, nothing reverted, and the file is left for the
      // operator rather than taken out of the bookkeeping.
      expect(readFileSync(globalSettingsPath, 'utf8')).toBe(original);
      expect(existsSync(path)).toBe(true);
      rmSync(path);
    });
  });

  test('a surface record that cannot account for every suspended key is damaged', () => {
    // Well-formed but incomplete (issue #832 review). A record naming fewer keys
    // than the overlay replaced would pass validation while describing none of
    // them: launch verification would check nothing, the release would restore
    // nothing, and the runner's own `tools` / `mcpServers` / `autoAccept`
    // registration would be left behind in the operator's store as if it were
    // theirs. Only a record that can undo the whole installation is acted on.
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    const prepared = prepare(root);
    const [name] = journals();
    const path = join(globalDir, OVERLAY_DIR, name);
    const intact = JSON.parse(readFileSync(path, 'utf8'));
    const shapes = [
      { installed: {}, suspended: [] },
      // Every key suspended, but nothing recorded as installed to match them.
      { installed: {}, suspended: intact.surface.suspended },
      // One key dropped from each half.
      {
        installed: { ...intact.surface.installed, mcpServers: undefined },
        suspended: intact.surface.suspended.filter((entry) => entry.key !== 'mcpServers'),
      },
      // A duplicate cannot stand in for the key it displaced.
      {
        installed: intact.surface.installed,
        suspended: [...intact.surface.suspended.slice(1), intact.surface.suspended[1]],
      },
    ];
    for (const surface of shapes) {
      writeFileSync(path, JSON.stringify({ ...intact, surface }, null, 2) + '\n');
      expect(refusalReason(() => verifyPreparedWorkspaceSettings(root, prepared)))
        .toBe('settings-replaced-before-launch');
      expect(refusalReason(() => releaseAntigravityWorkspaceSettings(prepared)))
        .toBe('global-overlay-journal-damaged');
      // Refused, not silently released: the registration is still installed and
      // the file is still there for the operator.
      expect(readGlobal().tools).toEqual(intact.surface.installed.tools);
      expect(readGlobal().mcpServers).toEqual(intact.surface.installed.mcpServers);
      expect(existsSync(path)).toBe(true);
    }

    // The intact record the runner actually writes is accepted, and releases.
    writeFileSync(path, JSON.stringify(intact, null, 2) + '\n');
    releaseAntigravityWorkspaceSettings(prepared);
    expect(readGlobal().tools).toBeUndefined();
  });

  test('a journal damaged after preparation fails the launch and the release loudly', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    const prepared = prepare(root);
    expect(() => verifyPreparedWorkspaceSettings(root, prepared)).not.toThrow();

    // Installation refuses while any journal is unreadable, so one appearing
    // here means the store was disturbed mid-run: the agent is not launched
    // under a permission set whose bookkeeping nobody can account for.
    const [name] = journals();
    writeFileSync(join(globalDir, OVERLAY_DIR, name), '{ truncated');
    expect(refusalReason(() => verifyPreparedWorkspaceSettings(root, prepared)))
      .toBe('settings-replaced-before-launch');
    // And this run's own damaged journal is reported rather than counted as a
    // release that removed nothing — the entries are still in the store.
    expect(refusalReason(() => releaseAntigravityWorkspaceSettings(prepared)))
      .toBe('global-overlay-journal-damaged');
    expect(readGlobal().permissions.allow).toContain(`read_file(${root}/**)`);
  });

  test('release still removes this run’s entries when another journal is damaged', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    const prepared = prepare(root);
    writeJournal('damaged.json', 'not json at all');

    releaseAntigravityWorkspaceSettings(prepared);
    // Our own grants are gone; the damaged file is left exactly where it was.
    expect(readGlobal().permissions?.allow ?? []).not.toContain(`read_file(${root}/**)`);
    expect(journals()).toEqual(['damaged.json']);
  });
});

// ---------------------------------------------------------------------------
// Journals that cannot be deleted
// ---------------------------------------------------------------------------

describe('global permission overlay — undeletable journals (issue #830 review)', () => {
  const overlayDirPath = () => join(globalDir, OVERLAY_DIR);

  /** A journal of THIS process, in the state the removal fallback leaves behind
   * when the file itself cannot be unlinked: retired, so the record survives but
   * the claim does not. `settled` additionally says the entries it names are
   * already back out of the store — the shape a *completed* release leaves. */
  const retiredJournalOfThisProcess = (workspaceRoot, { name = 'retired.json', settled = false } = {}) => {
    mkdirSync(overlayDirPath(), { recursive: true });
    const path = join(overlayDirPath(), name);
    writeFileSync(path, JSON.stringify({
      version: 1,
      workspaceRoot,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      claim: { allow: [`read_file(${workspaceRoot}/**)`], deny: [] },
      foreign: { allow: [], deny: [] },
      containers: { permissionsWasAbsent: true, allowWasAbsent: true, denyWasAbsent: true },
      suspended: { allow: [] },
      retired: true,
      ...(settled ? { settled: true } : {}),
    }, null, 2) + '\n');
    return path;
  };

  test('a retired journal of this process is not a live claim on the rules it names', () => {
    // A superseded evidence-turn journal whose file could not be unlinked
    // carries this very process's pid, so nothing else on the machine would ever
    // call it abandoned. Left live it would make this run's own release hold the
    // overlay in place for a claim nobody owns — while the handler recorded a
    // clean release. Retiring it is what keeps the release honest.
    const root = initRepo(join(tmpDir, 'repo'));
    const original = JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n';
    writeFileSync(globalSettingsPath, original);

    const prepared = prepare(root);
    const stale = retiredJournalOfThisProcess(root);

    releaseAntigravityWorkspaceSettings(prepared);
    // The store is back exactly as it was found: nothing was held for the
    // leftover, and the operator's document is untouched.
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(original);
    // The record itself is kept, not discarded: it still names rules a later
    // pass may have to account for.
    expect(existsSync(stale)).toBe(true);
  });

  test('a retired journal is reclaimed like any other overlay whose run is over', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    // Its rule is in the store, and its owner is this (alive) process.
    writeFileSync(globalSettingsPath, JSON.stringify({
      trustedWorkspaces: [root],
      permissions: { allow: [`read_file(${root}/**)`], deny: [] },
    }, null, 2) + '\n');
    const stale = retiredJournalOfThisProcess(root);

    const prepared = prepare(root);
    expect(prepared.globalOverlay.reclaimed).toBe(1);
    expect(existsSync(stale)).toBe(false);

    releaseAntigravityWorkspaceSettings(prepared);
    expect(readGlobal()).toEqual({ trustedWorkspaces: [root] });
    expect(journals()).toHaveLength(0);
  });

  test('a journal retired after a completed release is deleted, never reverted again', () => {
    // The other half of the fallback: when the unlink fails *after* the release
    // has already taken the entries out, what survived is a record of work that
    // is done. If the operator then adds a matching workspace-scoped rule of
    // their own, a second revert would silently take it away — so a settled
    // journal is only ever deleted (issue #830 review).
    const root = initRepo(join(tmpDir, 'repo'));
    const operatorRule = `read_file(${root}/**)`;
    const original = { trustedWorkspaces: [root], permissions: { allow: [operatorRule], deny: [] } };
    writeFileSync(globalSettingsPath, JSON.stringify(original, null, 2) + '\n');
    const settled = retiredJournalOfThisProcess(root, { name: 'settled.json', settled: true });

    const prepared = prepare(root);
    // Nothing was reclaimed: the release those entries belonged to is over, and
    // the operator's own rule is not this journal's leftovers.
    expect(prepared.globalOverlay.reclaimed).toBe(0);
    expect(existsSync(settled)).toBe(false);

    releaseAntigravityWorkspaceSettings(prepared);
    expect(readGlobal()).toEqual(original);
    expect(journals()).toHaveLength(0);
  });

  test('a superseded journal that can be neither removed nor retired fails the run closed', () => {
    // The fallback has a floor: if the record can be neither deleted nor
    // downgraded, the claim keeps reading as live, so the run must refuse rather
    // than install a second overlay on top of it.
    const root = initRepo(join(tmpDir, 'repo'));
    const original = JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n';
    writeFileSync(globalSettingsPath, original);

    const first = prepare(root);
    const [firstJournal] = journals();
    const during = readFileSync(globalSettingsPath, 'utf8');

    chmodSync(overlayDirPath(), 0o500);
    try {
      const err = refusal(() => prepare(root));
      expect(err.reason).toBe('global-settings-write-failed');
      // A journal file NAME, never a path: this detail reaches a bounded artifact.
      expect(err.detail).toContain(firstJournal);
      expect(err.detail).not.toContain(globalDir);
      // Nothing was written: the store still carries exactly the first turn's
      // entries, and the journal claiming them is intact.
      expect(readFileSync(globalSettingsPath, 'utf8')).toBe(during);
      expect(journals()).toEqual([firstJournal]);
    } finally {
      chmodSync(overlayDirPath(), 0o700);
    }

    // And that first turn's handle still removes them.
    releaseAntigravityWorkspaceSettings(first);
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(original);
    expect(journals()).toHaveLength(0);
  });

  test('a journal retired after preparation fails the launch closed', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    writeFileSync(globalSettingsPath, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    const prepared = prepare(root);
    expect(() => verifyPreparedWorkspaceSettings(root, prepared)).not.toThrow();

    // The claim was given up between preparation and launch — the same
    // condition as a journal that was removed outright.
    const path = join(globalDir, OVERLAY_DIR, journals()[0]);
    writeFileSync(path, JSON.stringify({
      ...JSON.parse(readFileSync(path, 'utf8')),
      retired: true,
    }, null, 2) + '\n');
    expect(refusalReason(() => verifyPreparedWorkspaceSettings(root, prepared)))
      .toBe('settings-replaced-before-launch');
  });
});

// ---------------------------------------------------------------------------
// The store the CLI loads, re-derived at launch
// ---------------------------------------------------------------------------

describe('global permission overlay — canonical store at launch (issue #830 review)', () => {
  test('a canonical store symlink repointed after preparation fails the launch closed', () => {
    // The canonical pathname may be a symlink, and preparation keys everything
    // off the target it resolved to. Repointing that link afterwards moves the
    // store without touching a byte of the old one: this run's journal and rules
    // are all still there and all still verify, while `agy` reads the NEW target
    // and would run under whatever it carries — here, an unrelated shell and
    // write grant. The launch check therefore re-derives the store the CLI loads
    // and refuses when it is no longer the one the overlay lives in.
    const root = initRepo(join(tmpDir, 'repo'));
    const home = join(tmpDir, 'home');
    const canonicalDir = join(home, '.gemini', 'antigravity-cli');
    mkdirSync(canonicalDir, { recursive: true });
    const canonical = join(canonicalDir, 'settings.json');
    const storeInUse = join(tmpDir, 'store-in-use.json');
    const storeElsewhere = join(tmpDir, 'store-elsewhere.json');
    const original = JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n';
    writeFileSync(storeInUse, original);
    writeFileSync(storeElsewhere, JSON.stringify({
      trustedWorkspaces: [root],
      permissions: { allow: ['run_shell_command', 'write_file'], deny: [] },
    }, null, 2) + '\n');
    symlinkSync(storeInUse, canonical);

    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const settings = prepareAntigravityWorkspaceSettings({
        workspaceRoot: root,
        cmdSource: 'cli-default',
        globalSettingsPath: canonical,
        probeCliVersion: () => '1.1.9',
      });
      // A run that executes the binary records this; the injected probe is the
      // only reason a fixture does not, and it is what exempts fixtures from the
      // canonical-store requirement on both ends of the lifecycle.
      settings.releaseHandle.launchesCli = true;
      expect(() => verifyPreparedWorkspaceSettings(root, settings)).not.toThrow();

      rmSync(canonical);
      symlinkSync(storeElsewhere, canonical);
      expect(refusalReason(() => verifyPreparedWorkspaceSettings(root, settings)))
        .toBe('settings-replaced-before-launch');
      // Read-only, as every launch check is: the store this run prepared still
      // carries its overlay, and the operator's other file is untouched.
      expect(JSON.parse(readFileSync(storeInUse, 'utf8')).permissions.allow)
        .toContain(`read_file(${root}/**)`);
      expect(JSON.parse(readFileSync(storeElsewhere, 'utf8')).permissions.allow)
        .toEqual(['run_shell_command', 'write_file']);

      // A fixture run launches no CLI, so the store it named is still the one it
      // is verified against.
      settings.releaseHandle.launchesCli = false;
      expect(() => verifyPreparedWorkspaceSettings(root, settings)).not.toThrow();

      releaseAntigravityWorkspaceSettings(settings);
      expect(readFileSync(storeInUse, 'utf8')).toBe(original);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});

// ---------------------------------------------------------------------------
// Trust registration under the store's lock
// ---------------------------------------------------------------------------

describe('global permission overlay — trust registration races (issue #830 review)', () => {
  test('a revocation landing before the lock refuses the run, it is not overwritten', () => {
    // Trust is evaluated once on an unlocked read, and registration then takes
    // the lock. An operator revoking this workspace inside that window must
    // refuse the run: appending to `trustedWorkspaces` on the strength of the
    // earlier snapshot would overwrite an explicit revocation with a grant and
    // launch the agent under it. The locked document decides.
    const root = initRepo(join(tmpDir, 'repo'));
    const untrusted = JSON.stringify({ theme: 'dark' }, null, 2) + '\n';
    writeFileSync(globalSettingsPath, untrusted);

    // Preparation blocks synchronously on the lock, so the revocation has to
    // come from another thread of control: this one holds the lock (a live
    // holder is waited on, never taken over) and hands it over only once the
    // entry is in.
    //
    // The helper is started and waited for BEFORE the lock exists, so its
    // startup is paid outside the ten seconds the runner is willing to wait for
    // a contended lock, and the wait for it is a shared-memory handshake rather
    // than a race against an interpreter booting (`startRevoker`). Once watching
    // it picks up the lock file itself and revokes shortly after it appears, so
    // the revocation is pinned to this run's arrival rather than to a wall-clock
    // guess.
    //
    // Either interleaving proves the same thing and neither can flake: the
    // runner can only read the store under the lock, and the lock is not free
    // until the revocation is on disk, so the locked read never sees the
    // pre-revocation document. A run slow enough to reach even its unlocked read
    // late simply refuses one step earlier, for the same reason.
    const lockPath = `${globalSettingsPath}.n8n-ai-cli-loop.lock`;
    const revoked = JSON.stringify({ theme: 'dark', trustedFolders: { [root]: 'DO_NOT_TRUST' } }, null, 2) + '\n';
    const revoker = startRevoker({
      triggerPath: lockPath,
      settingsPath: globalSettingsPath,
      revoked,
      lockPath,
      delayMs: 500,
    });
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
      expect(refusalReason(() => prepare(root, { registerTrust: true }))).toBe('workspace-distrusted');
      // The revocation survived, no trust entry was appended over it, and
      // nothing was installed.
      expect(readFileSync(globalSettingsPath, 'utf8')).toBe(revoked);
      expect(journals()).toHaveLength(0);
      expect(existsSync(join(root, '.gemini', 'settings.json'))).toBe(false);
    } finally {
      void revoker.terminate();
    }
    // Generous: this budget has to cover the runner's own ten-second lock wait
    // on a loaded machine, not the half-second the assertion actually turns on.
  }, 60_000);

  test('a revocation landing before the overlay lock refuses an already-trusted workspace', () => {
    // The companion race: an already-trusted workspace skips registration
    // entirely, so the ONLY lock this run takes is the overlay's. A revocation
    // landing in that window is preserved by the merge — which is precisely why
    // it cannot be left to the merge alone to notice it. The installer
    // re-evaluates trust on the locked document and refuses, instead of
    // reporting a successful preparation and invoking `agy` under an explicit
    // `DO_NOT_TRUST` (issue #830 review).
    const root = initRepo(join(tmpDir, 'repo'));
    const trusted = JSON.stringify({ theme: 'dark', trustedWorkspaces: [root] }, null, 2) + '\n';
    writeFileSync(globalSettingsPath, trusted);

    // Same construction as above — the helper is watching before this run starts,
    // so its startup is paid outside the runner's lock wait — but it watches for
    // the workspace profile rather than for the lock. That file is written
    // *after* the unlocked trust read and *before* the overlay lock is taken, so
    // the revocation is pinned to the exact window this test is about: the run
    // has already decided the workspace is trusted, and has not yet installed
    // anything. The lock below is held by this process until the helper hands it
    // over, so the runner cannot reach the store before then.
    const lockPath = `${globalSettingsPath}.n8n-ai-cli-loop.lock`;
    const profilePath = join(root, '.gemini', 'settings.json');
    const revoked = JSON.stringify(
      { theme: 'dark', trustedWorkspaces: [root], trustedFolders: { [root]: 'DO_NOT_TRUST' } },
      null,
      2,
    ) + '\n';
    const revoker = startRevoker({
      triggerPath: profilePath,
      settingsPath: globalSettingsPath,
      revoked,
      lockPath,
    });
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
      expect(refusalReason(() => prepare(root))).toBe('workspace-distrusted');
      // The revocation survived untouched and no permission entry was installed
      // on top of it.
      expect(readFileSync(globalSettingsPath, 'utf8')).toBe(revoked);
      expect(journals()).toHaveLength(0);
      // The refusal comes after the workspace profile is written, so the file
      // may still be there — but it is excluded, and the target repository is
      // clean on this failure path too.
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()).toBe('');
    } finally {
      void revoker.terminate();
    }
  }, 60_000);

  test('a trust grant WITHDRAWN before the overlay lock refuses the run too', () => {
    // The same window, but the operator removes the grant instead of writing an
    // explicit `DO_NOT_TRUST`. That leaves the workspace merely `untrusted`, so
    // a recheck that only looks for `distrusted` would install the overlay and
    // launch `agy` against a workspace nobody trusts — the exact fail-closed
    // requirement the unlocked read in step 6 enforces (issue #830 review).
    const root = initRepo(join(tmpDir, 'repo'));
    const trusted = JSON.stringify({ theme: 'dark', trustedWorkspaces: [root] }, null, 2) + '\n';
    writeFileSync(globalSettingsPath, trusted);

    const lockPath = `${globalSettingsPath}.n8n-ai-cli-loop.lock`;
    const profilePath = join(root, '.gemini', 'settings.json');
    // Withdrawn, not revoked: the workspace is simply absent from the list.
    const withdrawn = JSON.stringify({ theme: 'dark', trustedWorkspaces: [] }, null, 2) + '\n';
    const revoker = startRevoker({
      triggerPath: profilePath,
      settingsPath: globalSettingsPath,
      revoked: withdrawn,
      lockPath,
    });
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
      expect(refusalReason(() => prepare(root))).toBe('workspace-not-trusted');
      // The withdrawal survived untouched — no trust entry was re-appended and
      // no permission entry was installed on top of it.
      expect(readFileSync(globalSettingsPath, 'utf8')).toBe(withdrawn);
      expect(journals()).toHaveLength(0);
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()).toBe('');
    } finally {
      void revoker.terminate();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Symlinked global store
// ---------------------------------------------------------------------------

describe('global permission overlay — symlinked store (issue #830 review)', () => {
  test('is updated through the link, which survives install and release', () => {
    // Operators whose dotfiles are a repository symlink this file. A rename onto
    // the link would replace the LINK and orphan the real settings file.
    const root = initRepo(join(tmpDir, 'repo'));
    const dotfiles = join(tmpDir, 'dotfiles');
    mkdirSync(dotfiles, { recursive: true });
    const target = join(dotfiles, 'antigravity-settings.json');
    const original = JSON.stringify({ theme: 'dark', trustedWorkspaces: [root] }, null, 2) + '\n';
    writeFileSync(target, original);
    symlinkSync(target, globalSettingsPath);

    const prepared = prepare(root);
    expect(lstatSync(globalSettingsPath).isSymbolicLink()).toBe(true);
    expect(realpathSync.native(globalSettingsPath)).toBe(realpathSync.native(target));
    expect(JSON.parse(readFileSync(target, 'utf8')).permissions.allow)
      .toContain(`read_file(${root}/**)`);

    releaseAntigravityWorkspaceSettings(prepared);
    expect(lstatSync(globalSettingsPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  test('the lock is taken on the file itself, not on the name it was reached by', () => {
    // A runner naming the store through the link and one naming its target write
    // the SAME file. If the lock identity followed the input pathname they would
    // hold different locks, so both could install an overlay for their own
    // workspace into the one permission set their agents share (issue #830
    // review). A peer's lock on the resolved target must therefore block a run
    // that reaches the store through the link.
    const root = initRepo(join(tmpDir, 'repo'));
    const dotfiles = join(tmpDir, 'dotfiles');
    mkdirSync(dotfiles, { recursive: true });
    const target = join(dotfiles, 'antigravity-settings.json');
    writeFileSync(target, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    symlinkSync(target, globalSettingsPath);

    const lockPath = `${realpathSync.native(target)}.n8n-ai-cli-loop.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
    const longAgo = new Date(Date.now() - 10 * 60 * 1_000);
    utimesSync(lockPath, longAgo, longAgo);

    expect(refusalReason(() => prepare(root))).toBe('global-settings-locked');
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8')).permissions).toBeUndefined();
  }, 30_000);

  test('journals are written beside the store itself, where the other runner looks', () => {
    // Same reason as above for the other half of the exclusivity check: a
    // journal filed beside the link would be invisible to a run that named the
    // target, which would then see no live overlay and install its own.
    const root = initRepo(join(tmpDir, 'repo'));
    const dotfiles = join(tmpDir, 'dotfiles');
    mkdirSync(dotfiles, { recursive: true });
    const target = join(dotfiles, 'antigravity-settings.json');
    writeFileSync(target, JSON.stringify({ trustedWorkspaces: [root] }, null, 2) + '\n');
    symlinkSync(target, globalSettingsPath);

    const prepared = prepare(root);
    expect(readdirSync(join(dotfiles, OVERLAY_DIR))).toHaveLength(1);
    expect(existsSync(join(globalDir, OVERLAY_DIR))).toBe(false);

    releaseAntigravityWorkspaceSettings(prepared);
    expect(readdirSync(join(dotfiles, OVERLAY_DIR))).toHaveLength(0);
  });

  test('a link with no target is refused, never created', () => {
    const root = initRepo(join(tmpDir, 'repo'));
    const missing = join(tmpDir, 'missing-settings.json');
    symlinkSync(missing, globalSettingsPath);

    // Registration is the first write, so this is refused before anything is
    // created at an unexamined location.
    expect(refusalReason(() => prepare(root, { registerTrust: true })))
      .toBe('global-settings-write-failed');
    expect(existsSync(missing)).toBe(false);
  });
});
