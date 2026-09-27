/**
 * `admin agent-profile refresh` (issue #914) — the §11.6 safe update path of
 * docs/agent-runtime-profiles-contract.md.
 *
 * The paths the issue makes load-bearing are all here:
 *
 *   - **Preview** — the default invocation proposes a diff and writes nothing.
 *   - **No-change** — an overlay already matching the recommendation (or no
 *     overlay at all) applies to nothing, writes nothing, creates nothing.
 *   - **Apply** — `--yes` rewrites only the tool-managed values, records the
 *     provenance block, backs the previous file up first, and provably leaves
 *     every resolved setting unchanged (equal effective digests).
 *   - **Discovery-unavailable** — `--offline`, and CLIs that are missing,
 *     degrade to the bundled recommended catalog with the source reported;
 *     a live listing from an installed CLI flags removed models. Listings
 *     are scoped to the executable that produced them: a profile is never
 *     judged by another binary's inventory, and every declared profile is
 *     inventoried — a profile only a pin reaches included.
 *   - **Concurrent edit** — a catalog edited while the discovery probes ran
 *     refuses the apply (`refresh-conflict`) instead of being overwritten,
 *     and the whole check-and-replace runs under an exclusive lock file: a
 *     lock another refresh holds refuses the apply outright (the preview
 *     stays available), and a settled run never leaves its lock behind. The
 *     conflict re-read is the last step before the rename — after the
 *     staging and the backup work — so an edit landing at any point up to
 *     the replacement is caught, never verified against stale bytes.
 *   - **Permissions** — the applied file carries the previous catalog's
 *     exact permission bits; a `0600` catalog never widens under the umask.
 *     Ownership rides along: a group-scoped catalog keeps its owner and
 *     group, not just the bits that reference them. The backup obeys the
 *     same rule — created owner-only, then given the catalog's exact
 *     owner, group, and bits. An extended ACL rides along too: a `deny` (or
 *     `allow`) entry that mode bits and ownership cannot express survives
 *     on the replacement and on the backup — and entries the DIRECTORY
 *     hands a fresh file (a macOS `file_inherit` ACE, a POSIX default ACL)
 *     are stripped from both before their contents land, so a refresh
 *     neither drops a grant the catalog carried nor gains one it did not.
 *   - **Symlinked catalog** — a configured path that is a symlink applies
 *     through to the shared target; the link survives the rename and the
 *     backup and lock live beside the target.
 *   - **Deprecated model** — an operator profile pinning a model the release
 *     no longer recommends is flagged and preserved.
 *   - **Rollback** — restoring the printed backup restores the previous file
 *     and the previous effective catalog.
 */
import {
  chmodSync,
  chownSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { runAdmin } from './helpers/admin-cli.js';

let tmpDir;
let sessionsPath;
let catalogPath;

const CLEAN_ENV = {
  AGENT_PROFILES_FILE: undefined,
  CLAUDE_MODEL: undefined,
  CLAUDE_EFFORT: undefined,
  CLAUDE_MAX_BUDGET_USD: undefined,
  CODEX_MODEL: undefined,
  CODEX_EFFORT: undefined,
  ANTIGRAVITY_BIN: undefined,
};

function run(args, env = {}) {
  return runAdmin(args, { env: { ...CLEAN_ENV, ...env } });
}

function writeSessions() {
  const sessions = {
    sessions: [
      {
        sessionId: 'addon-dev',
        repoKey: 'test-repo',
        repoRoot: join(tmpDir, 'repo'),
        githubRepo: 'm2dw/test-repo',
        artifactDir: '.n8n-artifacts',
        baseBranch: 'main',
        defaults: { implementationAgent: 'claude', reviewAgent: 'codex' },
        verification: { test: 'true' },
        labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
      },
    ],
  };
  writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
}

function writeCatalog(document) {
  writeFileSync(catalogPath, JSON.stringify(document, null, 2));
}

/**
 * Profile entries pointing EVERY profile a provider's *effective* catalog
 * declares — the built-ins included — at one binary under tmpDir. The refresh
 * resolves an executable for every declared profile (a profile no binding
 * references is still reachable through a pin), so a case that wants
 * deterministic discovery on any host must rebind the built-in profiles'
 * binaries too — otherwise the probes would consult whatever `claude` or
 * `codex` the host happens to install.
 */
function allProfileBinaries(builtinProfileNames, binary) {
  return Object.fromEntries(
    ['probe-test', ...builtinProfileNames].map((name) => [name, { binary }]),
  );
}
const ANTHROPIC_BUILTIN_PROFILE_NAMES = [
  'claude-light',
  'claude-normal',
  'claude-strong',
  'claude-maximum',
];
const OPENAI_BUILTIN_PROFILE_NAMES = ['codex-light', 'codex-normal', 'codex-high'];

async function refresh(extraArgs = [], env = {}) {
  return run(['agent-profile', 'refresh', '--sessions-path', sessionsPath, ...extraArgs], env);
}

async function listDigest() {
  const res = await run(['agent-profile', 'list', '--sessions-path', sessionsPath, '--json']);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).catalog.digest;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-agent-profile-refresh-'));
  sessionsPath = join(tmpDir, 'sessions.json');
  catalogPath = join(tmpDir, 'agent-profiles.json');
  writeSessions();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('preview and no-change paths', () => {
  test('no catalog file: reports the built-ins apply, proposes nothing, creates nothing even with --yes', async () => {
    const res = await refresh(['--offline', '--yes', '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.changed).toBe(false);
    expect(payload.applied).toBe(false);
    expect(payload.backupPath).toBeNull();
    expect(payload.catalog.source).toBe('builtin');
    expect(payload.updateSource).toBe('bundled');
    expect(existsSync(catalogPath)).toBe(false);
    expect(readdirSync(tmpDir).filter((f) => f.includes('.bak'))).toEqual([]);
  });

  test('a redundant override previews as a proposed removal and the file is untouched', async () => {
    writeCatalog({
      schemaVersion: 1,
      providers: { anthropic: { profiles: { 'claude-strong': { model: 'opus', budget: '25' } } } },
    });
    const before = readFileSync(catalogPath, 'utf8');
    const res = await refresh(['--offline', '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.changed).toBe(true);
    expect(payload.applied).toBe(false);
    expect(payload.backupPath).toBeNull();
    const removals = payload.changes.filter((c) => c.op === 'remove');
    expect(removals.map((c) => c.target)).toEqual([
      'providers.anthropic.profiles.claude-strong.model',
    ]);
    expect(removals[0].before).toBe('opus');
    // The actionable diff names both halves: what is removed and what is kept.
    expect(payload.findings.map((f) => f.kind).sort()).toEqual([
      'redundant-override',
      'stale-override',
    ]);
    expect(readFileSync(catalogPath, 'utf8')).toBe(before);
    expect(readdirSync(tmpDir).filter((f) => f.includes('.bak'))).toEqual([]);
  });

  test('an overlay of purely operator values is a no-change: --yes applies nothing and writes nothing', async () => {
    writeCatalog({
      schemaVersion: 1,
      providers: { anthropic: { profiles: { 'claude-strong': { model: 'fable' } } } },
    });
    const before = readFileSync(catalogPath, 'utf8');
    const res = await refresh(['--offline', '--yes', '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.changed).toBe(false);
    expect(payload.applied).toBe(false);
    expect(payload.findings.map((f) => f.kind)).toEqual(['stale-override']);
    expect(readFileSync(catalogPath, 'utf8')).toBe(before);
    expect(readdirSync(tmpDir).filter((f) => f.includes('.bak'))).toEqual([]);
  });

  test('human-readable output is the default and names the posture', async () => {
    const res = await refresh(['--offline']);
    expect(res.code).toBe(0);
    expect(() => JSON.parse(res.stdout)).toThrow();
    expect(res.stdout).toContain('Agent profile refresh: no changes');
    expect(res.stdout).toContain('cli discovery: skipped (--offline)');
  });

  test('an unknown option is rejected, per the shared admin CLI parsing contract', async () => {
    const res = await refresh(['--force']);
    expect(res.code).toBe(1);
  });

  test('an invalid overlay refuses with its §12.2 reason instead of refreshing it', async () => {
    writeCatalog({ schemaVersion: 1, providers: { anthropic: { qualityBinding: {} } } });
    const res = await refresh(['--offline', '--json']);
    expect(res.code).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('catalog-invalid');
  });
});

describe('deprecated-model detection', () => {
  test('an operator profile pinning a model the release no longer recommends is flagged and preserved', async () => {
    writeCatalog({
      schemaVersion: 1,
      providers: {
        anthropic: {
          profiles: { 'claude-strong-2025-01-01': { model: 'claude-2', effort: 'high' } },
        },
      },
    });
    const before = readFileSync(catalogPath, 'utf8');
    const res = await refresh(['--offline', '--yes', '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.changed).toBe(false);
    const removed = payload.findings.filter((f) => f.kind === 'removed-model');
    expect(removed).toHaveLength(1);
    expect(removed[0].target).toBe('providers.anthropic.profiles.claude-strong-2025-01-01.model');
    expect(removed[0].disposition).toBe('advisory');
    expect(
      payload.findings.find((f) => f.kind === 'operator-addition').disposition,
    ).toBe('preserved');
    expect(readFileSync(catalogPath, 'utf8')).toBe(before);
  });
});

describe('apply, backup, and rollback', () => {
  test('--yes applies the tool-managed removals, records provenance, backs up first, and preserves every resolved setting', async () => {
    writeCatalog({
      schemaVersion: 1,
      providers: {
        anthropic: { profiles: { 'claude-strong': { model: 'opus', budget: '25' } } },
        openai: { qualityBindings: { normal: 'codex-high' } },
      },
    });
    const originalBytes = readFileSync(catalogPath, 'utf8');
    const digestBefore = await listDigest();

    const res = await refresh(['--offline', '--yes', '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.changed).toBe(true);
    expect(payload.applied).toBe(true);
    expect(payload.digest.proposed).toBe(payload.digest.current);
    expect(payload.refreshRecord).toMatchObject({
      updateSource: 'bundled',
      recommendedCatalogVersion: expect.stringMatching(/^builtin-/),
    });

    // The backup holds the previous file, byte for byte.
    expect(payload.backupPath).toContain('agent-profiles.json.bak-');
    expect(readFileSync(payload.backupPath, 'utf8')).toBe(originalBytes);

    // The rewritten file: redundant values gone, operator value kept, the
    // provenance block recorded — and it is a valid catalog this CLI reads.
    const rewritten = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(rewritten.refresh.updateSource).toBe('bundled');
    expect(rewritten.providers.anthropic.profiles['claude-strong']).toEqual({ budget: '25' });
    expect(rewritten.providers.openai).toBeUndefined();

    // A refresh cannot silently alter active provider settings.
    expect(await listDigest()).toBe(digestBefore);

    // The redundant model now resolves from the built-in layer again.
    const list = await run(['agent-profile', 'list', '--sessions-path', sessionsPath, '--json']);
    const anthropic = JSON.parse(list.stdout).providers.find((p) => p.provider === 'anthropic');
    const strong = anthropic.profiles.find((p) => p.name === 'claude-strong');
    expect(strong.settings).toContainEqual({
      setting: 'model',
      value: 'opus',
      source: 'catalog-builtin',
    });
    expect(strong.settings).toContainEqual({
      setting: 'budget',
      value: '25',
      source: 'catalog-overlay',
    });

    // A second refresh is the no-change path: nothing further to manage.
    const again = await refresh(['--offline', '--yes', '--json']);
    const againPayload = JSON.parse(again.stdout);
    expect(againPayload.changed).toBe(false);
    expect(againPayload.applied).toBe(false);
    // Exactly one backup exists — the second run wrote nothing.
    expect(readdirSync(tmpDir).filter((f) => f.includes('.bak'))).toHaveLength(1);

    // Rollback: restore the backup over the catalog path.
    copyFileSync(payload.backupPath, catalogPath);
    expect(readFileSync(catalogPath, 'utf8')).toBe(originalBytes);
    expect(await listDigest()).toBe(digestBefore);
    const restored = await run(['agent-profile', 'list', '--sessions-path', sessionsPath, '--json']);
    const restoredStrong = JSON.parse(restored.stdout)
      .providers.find((p) => p.provider === 'anthropic')
      .profiles.find((p) => p.name === 'claude-strong');
    expect(restoredStrong.settings).toContainEqual({
      setting: 'model',
      value: 'opus',
      source: 'catalog-overlay',
    });
  });

  test('applied output names the backup and the rollback path in text mode', async () => {
    writeCatalog({
      schemaVersion: 1,
      providers: { google: { qualityBindings: { strong: 'agy-strong' } } },
    });
    const res = await refresh(['--offline', '--yes']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Agent profile refresh: applied');
    expect(res.stdout).toContain('backup of the previous file:');
    expect(res.stdout).toContain('rollback: restore the backup');
  });
});

describe('apply-transaction protection', () => {
  // A catalog whose redundant model override makes `--offline --yes` reach
  // the apply step — the same fixture the apply suite above uses.
  const changeableCatalog = {
    schemaVersion: 1,
    providers: {
      anthropic: { profiles: { 'claude-strong': { model: 'opus', budget: '25' } } },
    },
  };

  test('--yes preserves the catalog permission bits and removes its lock when done', async () => {
    writeCatalog(changeableCatalog);
    chmodSync(catalogPath, 0o600);

    const res = await refresh(['--offline', '--yes', '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.applied).toBe(true);

    // A 0600 catalog stays 0600: the staged replacement carries the previous
    // file's exact mode bits instead of the process umask's default, so a
    // refresh can neither widen nor narrow who reads the catalog.
    expect(statSync(catalogPath).mode & 0o777).toBe(0o600);
    // The backup answers to the same rule: created owner-only and then given
    // the catalog's exact bits, never the umask's wider default.
    expect(statSync(payload.backupPath).mode & 0o777).toBe(0o600);
    // The transaction's lock does not outlive the apply.
    expect(existsSync(`${catalogPath}.refresh-lock`)).toBe(false);
  });

  test('a symlinked catalog path applies through to the shared target and the link survives', async () => {
    // The configured path is a symlink into a shared directory. The apply
    // must rewrite the target the reads followed — renaming a regular file
    // over the link would report success while leaving the shared document
    // unchanged and disconnecting this configuration from its future updates.
    const sharedDir = join(tmpDir, 'shared');
    mkdirSync(sharedDir);
    const targetPath = join(sharedDir, 'team-agent-profiles.json');
    writeFileSync(targetPath, JSON.stringify(changeableCatalog, null, 2));
    const originalBytes = readFileSync(targetPath, 'utf8');
    symlinkSync(targetPath, catalogPath);

    const res = await refresh(['--offline', '--yes', '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.applied).toBe(true);

    // The configured path is still the same symlink ...
    expect(lstatSync(catalogPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(catalogPath)).toBe(targetPath);
    // ... the shared target holds the refreshed document ...
    const rewritten = JSON.parse(readFileSync(targetPath, 'utf8'));
    expect(rewritten.refresh.updateSource).toBe('bundled');
    expect(rewritten.providers.anthropic.profiles['claude-strong']).toEqual({ budget: '25' });
    // ... and the backup of the previous document sits beside the target,
    // with no staging, backup, or lock remains beside the link.
    expect(payload.backupPath).toContain('team-agent-profiles.json.bak-');
    expect(readFileSync(payload.backupPath, 'utf8')).toBe(originalBytes);
    expect(readdirSync(tmpDir).filter((f) => f.includes('.bak') || f.includes('.tmp'))).toEqual([]);
    expect(existsSync(`${targetPath}.refresh-lock`)).toBe(false);
    expect(existsSync(`${catalogPath}.refresh-lock`)).toBe(false);
  });

  test('--yes preserves the catalog owner and group, not only its mode bits', async () => {
    if (typeof process.getgroups !== 'function' || typeof process.getuid !== 'function') return;
    writeCatalog(changeableCatalog);
    chmodSync(catalogPath, 0o640);
    // Re-group the catalog to a supplementary group the test user belongs to
    // but that a freshly staged file would not carry; a single-group host has
    // no observable difference to stage and proves nothing either way.
    const inheritedGid = statSync(catalogPath).gid;
    let expectedGid;
    for (const gid of process.getgroups()) {
      if (gid === inheritedGid) continue;
      try {
        chownSync(catalogPath, process.getuid(), gid);
        expectedGid = gid;
        break;
      } catch {
        // Not a permitted target group on this host; try the next membership.
      }
    }
    if (expectedGid === undefined) return;

    const res = await refresh(['--offline', '--yes', '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.applied).toBe(true);

    // The replacement carries the catalog's owner, group, and mode bits, so
    // exactly who could read the 0640 file before the apply can read it
    // after — mode bits alone would silently rebind the group grant.
    const after = statSync(catalogPath);
    expect(after.uid).toBe(process.getuid());
    expect(after.gid).toBe(expectedGid);
    expect(after.mode & 0o777).toBe(0o640);

    // The backup holds the pre-refresh contents under the same principals: a
    // plain copy would keep the 0640 bits but this process's default group,
    // handing the catalog's contents to a group it never named.
    const backup = statSync(payload.backupPath);
    expect(backup.uid).toBe(process.getuid());
    expect(backup.gid).toBe(expectedGid);
    expect(backup.mode & 0o777).toBe(0o640);
  });

  test('an ACL-protected catalog keeps its ACL on the replacement and the backup (macOS)', async () => {
    // Mode bits and uid/gid do not describe an access control list: before
    // the issue #914 review fix, refreshing a 0644 catalog carrying
    // `user:nobody deny read` succeeded with that rule silently gone from
    // both the catalog and the backup.
    if (process.platform !== 'darwin') return;
    writeCatalog(changeableCatalog);
    const ace = 'user:nobody deny read';
    const set = spawnSync('/bin/chmod', ['+a', ace, catalogPath], { encoding: 'utf8' });
    if (set.error !== undefined || set.status !== 0) return; // No ACL support on this filesystem; nothing to prove.

    // The assertions compare displayed entries, not the string handed to
    // chmod: current macOS renders a plain POSIX principal as its bare
    // compatibility UUID (`FFFFEEEE-DDDD-CCCC-BBBB-AAAAFFFFFFFE deny read`)
    // whenever its UUID-to-name translation fails, so the deny rule must
    // survive under whichever spelling this machine displays — and the
    // refresh must replay that spelling through chmod, which accepts no
    // UUID where a name goes (fourth round of the issue #914 ACL review).
    const aclEntriesOf = (path) =>
      spawnSync('/bin/ls', ['-lde', path], { encoding: 'utf8' })
        .stdout.split('\n')
        .filter((line) => /^ *\d+: /.test(line))
        .map((line) => line.replace(/^ *\d+: /, '').trim());
    const before = aclEntriesOf(catalogPath);
    expect(before).toHaveLength(1);
    expect(before[0]).toContain('deny read');

    const res = await refresh(['--offline', '--yes', '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.applied).toBe(true);

    expect(aclEntriesOf(catalogPath)).toEqual(before);
    expect(aclEntriesOf(payload.backupPath)).toEqual(before);
  });

  test('an ACL-protected catalog keeps its ACL on the replacement and the backup (Linux)', async () => {
    // The POSIX flavor of the same guarantee: an `allow`-style named-user
    // entry set with setfacl must survive the replacement — dropping it
    // silently revokes a reader the catalog itself named.
    if (process.platform !== 'linux') return;
    writeCatalog(changeableCatalog);
    const set = spawnSync('setfacl', ['-m', 'user:nobody:r', catalogPath], { encoding: 'utf8' });
    if (set.error !== undefined || set.status !== 0) return; // No acl tools or fs support; nothing to prove.

    const res = await refresh(['--offline', '--yes', '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.applied).toBe(true);

    const aclOf = (path) => spawnSync('getfacl', ['--omit-header', path], { encoding: 'utf8' }).stdout;
    expect(aclOf(catalogPath)).toContain('user:nobody:r--');
    expect(aclOf(payload.backupPath)).toContain('user:nobody:r--');
  });

  test('a directory-inherited ACL does not ride onto the replacement or the backup (macOS)', async () => {
    // The inverse of the preservation guarantee above (issue #914 review,
    // second round): `mode: 0o600` on the exclusive create governs only the
    // mode bits. A directory ACE carrying `file_inherit` lands on every file
    // born inside the directory, so before this fix refreshing an ACL-free
    // 0600 catalog gave both the replacement and the backup an inherited
    // `user:nobody allow read` grant — no chmod removes it, and with no
    // catalog ACL captured, nothing restored it away.
    if (process.platform !== 'darwin') return;
    writeCatalog(changeableCatalog);
    chmodSync(catalogPath, 0o600);
    // The ACE goes on the DIRECTORY, after the catalog already exists: the
    // catalog itself stays ACL-free; only files created later inherit.
    const set = spawnSync('/bin/chmod', ['+a', 'user:nobody allow read,file_inherit', tmpDir], {
      encoding: 'utf8',
    });
    if (set.error !== undefined || set.status !== 0) return; // No ACL support on this filesystem; nothing to prove.
    const aclEntriesOf = (path) =>
      spawnSync('/bin/ls', ['-lde', path], { encoding: 'utf8' })
        .stdout.split('\n')
        .filter((line) => /^ *\d+: /.test(line));
    // Prove the premise on this filesystem: a fresh file really does inherit.
    const probePath = join(tmpDir, 'inherit-probe');
    writeFileSync(probePath, '', { mode: 0o600 });
    const probeInherited = aclEntriesOf(probePath).length > 0;
    rmSync(probePath);
    if (!probeInherited) return; // The directory ACE does not propagate here; nothing to prove.

    const res = await refresh(['--offline', '--yes', '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.applied).toBe(true);

    // Neither the replaced catalog nor the backup carries any ACL entry: the
    // inherited grant was stripped from each file before its contents landed.
    expect(aclEntriesOf(catalogPath)).toEqual([]);
    expect(aclEntriesOf(payload.backupPath)).toEqual([]);
    expect(statSync(catalogPath).mode & 0o777).toBe(0o600);
  });

  test('a catalog that itself carries an inherited ACL entry keeps it on the replacement and the backup (macOS)', async () => {
    // Third round of the issue #914 ACL review: a catalog created beneath an
    // ACL-inheriting directory is born with an entry `ls -lde` spells
    // `group:everyone inherited allow read`. chmod accepts no `inherited`
    // token inside an entry, so re-creating the captured spelling verbatim
    // with `+a#` failed (`Unknown tag type 'inherited'`) and `--yes` refused
    // every such catalog. The marker is carried by the `+ai#` mode instead,
    // and the entry must survive the replacement with its inherited state —
    // not demoted to an explicit grant the directory can no longer manage.
    if (process.platform !== 'darwin') return;
    // The ACE goes on the DIRECTORY before the catalog exists, so the catalog
    // written next inherits it; the preservation test above covers the
    // explicit-entry flavor, and the test above this one covers entries only
    // the *fresh* files inherit.
    const set = spawnSync('/bin/chmod', ['+a', 'group:everyone allow read,file_inherit', tmpDir], {
      encoding: 'utf8',
    });
    if (set.error !== undefined || set.status !== 0) return; // No ACL support on this filesystem; nothing to prove.
    writeCatalog(changeableCatalog);
    const aclEntriesOf = (path) =>
      spawnSync('/bin/ls', ['-lde', path], { encoding: 'utf8' })
        .stdout.split('\n')
        .filter((line) => /^ *\d+: /.test(line))
        .map((line) => line.replace(/^ *\d+: /, '').trim());
    // Prove the premise on this filesystem: the catalog really was born
    // carrying an inherited entry.
    const before = aclEntriesOf(catalogPath);
    if (!before.some((entry) => entry.includes(' inherited '))) return; // The directory ACE does not propagate here; nothing to prove.

    const res = await refresh(['--offline', '--yes', '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.applied).toBe(true);

    // Both files carry the catalog's exact entries, inherited marker and all.
    expect(aclEntriesOf(catalogPath)).toEqual(before);
    expect(aclEntriesOf(payload.backupPath)).toEqual(before);
  });

  test('a directory default ACL does not ride onto the replacement or the backup (Linux)', async () => {
    // The POSIX flavor of the same inverse guarantee: a default ACL on the
    // directory stamps its entries onto every file created inside it, so an
    // ACL-free catalog's replacement and backup would each gain a
    // `user:nobody:r--` reader the catalog never named.
    if (process.platform !== 'linux') return;
    writeCatalog(changeableCatalog);
    chmodSync(catalogPath, 0o600);
    const set = spawnSync('setfacl', ['-d', '-m', 'user:nobody:r', tmpDir], { encoding: 'utf8' });
    if (set.error !== undefined || set.status !== 0) return; // No acl tools or fs support; nothing to prove.
    const aclOf = (path) =>
      spawnSync('getfacl', ['--omit-header', path], { encoding: 'utf8' }).stdout;
    // Prove the premise on this filesystem: a fresh file really does inherit.
    const probePath = join(tmpDir, 'inherit-probe');
    writeFileSync(probePath, '', { mode: 0o600 });
    const probeInherited = aclOf(probePath).includes('user:nobody');
    rmSync(probePath);
    if (!probeInherited) return; // The default ACL does not propagate here; nothing to prove.

    const res = await refresh(['--offline', '--yes', '--json']);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.applied).toBe(true);

    expect(aclOf(catalogPath)).not.toContain('user:nobody');
    expect(aclOf(payload.backupPath)).not.toContain('user:nobody');
    expect(statSync(catalogPath).mode & 0o777).toBe(0o600);
  });

  test('a held refresh lock refuses the apply and touches nothing; the preview stays available', async () => {
    writeCatalog(changeableCatalog);
    const before = readFileSync(catalogPath, 'utf8');
    const lockPath = `${catalogPath}.refresh-lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 0, startedAt: '2026-09-11T00:00:00.000Z' }) + '\n');

    const res = await refresh(['--offline', '--yes', '--json']);
    expect(res.code).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('refresh-conflict');

    // Nothing staged, backed up, or replaced — and the foreign lock is not
    // this run's to remove.
    expect(readFileSync(catalogPath, 'utf8')).toBe(before);
    expect(readdirSync(tmpDir).filter((f) => f.includes('.bak') || f.includes('.tmp'))).toEqual([]);
    expect(existsSync(lockPath)).toBe(true);

    // The lock guards the apply, not the read-only preview.
    const preview = await refresh(['--offline', '--json']);
    expect(preview.code).toBe(0);
    const previewPayload = JSON.parse(preview.stdout);
    expect(previewPayload.changed).toBe(true);
    expect(previewPayload.applied).toBe(false);
  });
});

/**
 * Does this refresh payload carry a probe outcome the host starved rather than
 * answered? Issue #897 keeps that split typed all the way to the payload: a
 * starved `--version` probe reports `indeterminate` (never `unavailable`), and
 * a starved model listing degrades that binary to the bundled comparison with
 * "transiently unanswerable" in the inventory reason. Both are facts about the
 * host at one moment — a full parallel Jest run forks thousands of children
 * and can hold a `/bin/sh` fixture past the models probe's 10s deadline — so
 * the discovery cases must not read them as the CLI's answer. Determinate
 * outcomes (`unavailable`, "could not be read") never match here: those are
 * exactly what the cases below must keep failing on.
 */
function discoveryWasStarved(payload) {
  return (
    payload.capabilityDiscovery.results.some((r) => r.status === 'indeterminate') ||
    payload.modelInventory.some((r) => r.reason.includes('transiently unanswerable'))
  );
}

/**
 * Refresh (as a preview — no `--yes`), asking again when the host starved a
 * discovery probe instead of answering it. Re-running is safe: a preview
 * writes nothing. `answered` is false only when every attempt starved; the
 * caller then declines to assert rather than report a thrashing host as a
 * discovery defect — degrading a starved probe to the bundled source is the
 * CLI behaving as designed, and the wrong fact for a case about what an
 * answered listing reports.
 */
async function refreshUntilDiscoveryAnswered(attempts = 2) {
  let res;
  let payload = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    res = await refresh(['--json']);
    if (res.code !== 0) return { res, payload: null, answered: true };
    payload = JSON.parse(res.stdout);
    if (!discoveryWasStarved(payload)) return { res, payload, answered: true };
    // Loud on purpose: a case that stops asserting has to be visible in the
    // run it happened in, not discovered later as coverage that went away.
    console.warn(
      `agent-profile refresh discovery starved on attempt ${attempt}/${attempts} — ` +
        'a probe reported a transient host condition, not a CLI answer',
    );
  }
  return { res, payload, answered: false };
}

/**
 * The Jest budget for a case that may run the refresh twice with probes that
 * each own a 10s deadline (mirrors codex-structured-review.test.js): the
 * default 30s would turn a tolerated retry into an untolerated Jest timeout,
 * which is the failure the helper above exists to avoid.
 */
const STARVATION_TOLERANT_TIMEOUT_MS = 120_000;

describe('discovery', () => {
  test('missing CLIs degrade to the bundled source; an installed one supplies a live listing that flags removed models', async () => {
    // Deterministic on any host: every provider's binary points into tmpDir.
    // The fake `agy` answers both probes; claude/codex do not exist.
    const fakeAgy = join(tmpDir, 'fake-agy');
    writeFileSync(
      fakeAgy,
      '#!/bin/sh\n' +
        'if [ "$1" = "--version" ]; then echo "agy 1.2.3"; exit 0; fi\n' +
        'if [ "$1" = "models" ]; then echo "Gemini 3.1 Pro (Low)"; echo "Gemini 3.1 Pro (High)"; exit 0; fi\n' +
        'exit 1\n',
      { mode: 0o755 },
    );
    const binding = (name) => ({ light: name, normal: name, strong: name, maximum: name });
    writeCatalog({
      schemaVersion: 1,
      providers: {
        anthropic: {
          profiles: allProfileBinaries(ANTHROPIC_BUILTIN_PROFILE_NAMES, join(tmpDir, 'no-such-claude')),
          qualityBindings: binding('probe-test'),
        },
        openai: {
          capabilities: { binary: 'free' },
          profiles: allProfileBinaries(OPENAI_BUILTIN_PROFILE_NAMES, join(tmpDir, 'no-such-codex')),
          qualityBindings: binding('probe-test'),
        },
        google: {
          profiles: {
            'agy-light': { binary: fakeAgy },
            'agy-normal': { binary: fakeAgy },
            'agy-strong': { binary: fakeAgy, model: 'Old Model' },
            'agy-maximum': { binary: fakeAgy },
          },
        },
      },
    });
    const { res, payload, answered } = await refreshUntilDiscoveryAnswered();
    if (!answered) return; // Every attempt starved; the warnings above say so.
    expect(res.code).toBe(0);

    // Version probes: informational, per provider, deterministic.
    expect(payload.capabilityDiscovery.probed).toBe(true);
    const byProvider = Object.fromEntries(
      payload.capabilityDiscovery.results.map((r) => [r.provider, r]),
    );
    expect(byProvider.anthropic.status).toBe('unavailable');
    expect(byProvider.openai.status).toBe('unavailable');
    expect(byProvider.google.status).toBe('available');
    expect(byProvider.google.version).toBe('1.2.3');

    // Inventory sources: live where the bounded listing answered, bundled
    // elsewhere, and the aggregate is honest about the mix.
    const inventory = Object.fromEntries(payload.modelInventory.map((r) => [r.provider, r]));
    expect(inventory.google.source).toBe('live');
    expect(inventory.google.models).toEqual(['Gemini 3.1 Pro (Low)', 'Gemini 3.1 Pro (High)']);
    expect(inventory.anthropic.source).toBe('bundled');
    expect(inventory.openai.source).toBe('bundled');
    expect(payload.updateSource).toBe('mixed');

    // The live listing flags the configured model it does not contain —
    // advisory, preserved, and never a proposed value.
    const removed = payload.findings.filter((f) => f.kind === 'removed-model');
    expect(removed).toHaveLength(1);
    expect(removed[0].target).toBe('providers.google.profiles.agy-strong.model');
    expect(removed[0].disposition).toBe('advisory');
    expect(payload.changed).toBe(false);
  }, STARVATION_TOLERANT_TIMEOUT_MS);

  test('a truncated model listing flags nothing as removed and reports its incompleteness', async () => {
    // The fake `agy` lists more models than the interpreter's 64-name bound,
    // and the configured model is the 65th — explicitly listed by the CLI,
    // absent from the carried prefix. Before the issue #914 review fix that
    // absence produced a false removed-model finding; the truncated prefix
    // must prove nothing absent, and the truncation must stay visible in the
    // inventory reason instead of being read as a complete inventory.
    const fakeAgy = join(tmpDir, 'fake-agy');
    writeFileSync(
      fakeAgy,
      '#!/bin/sh\n' +
        'if [ "$1" = "--version" ]; then echo "agy 1.2.3"; exit 0; fi\n' +
        'if [ "$1" = "models" ]; then i=0; while [ $i -lt 70 ]; do echo "model-$i"; i=$((i+1)); done; exit 0; fi\n' +
        'exit 1\n',
      { mode: 0o755 },
    );
    writeCatalog({
      schemaVersion: 1,
      providers: {
        anthropic: {
          profiles: allProfileBinaries(ANTHROPIC_BUILTIN_PROFILE_NAMES, join(tmpDir, 'no-such-claude')),
        },
        openai: {
          capabilities: { binary: 'free' },
          profiles: allProfileBinaries(OPENAI_BUILTIN_PROFILE_NAMES, join(tmpDir, 'no-such-codex')),
        },
        google: {
          profiles: {
            'agy-light': { binary: fakeAgy },
            'agy-normal': { binary: fakeAgy },
            'agy-strong': { binary: fakeAgy, model: 'model-64' },
            'agy-maximum': { binary: fakeAgy },
          },
        },
      },
    });
    const { res, payload, answered } = await refreshUntilDiscoveryAnswered();
    if (!answered) return; // Every attempt starved; the warnings above say so.
    expect(res.code).toBe(0);

    const inventory = Object.fromEntries(payload.modelInventory.map((r) => [r.provider, r]));
    expect(inventory.google.source).toBe('live');
    expect(inventory.google.models).toHaveLength(64);
    expect(inventory.google.reason).toContain('only the first 64 listed models were kept');
    expect(inventory.google.reason).toContain('not exhaustive');
    expect(payload.findings.filter((f) => f.kind === 'removed-model')).toEqual([]);
  }, STARVATION_TOLERANT_TIMEOUT_MS);

  test('model inventories stay scoped to the binary that supplied them when profiles split across executables', async () => {
    // Two installed executables with disjoint model offerings: light/normal
    // resolve to binary A, strong/maximum to binary B.
    const fakeAgyA = join(tmpDir, 'fake-agy-a');
    const fakeAgyB = join(tmpDir, 'fake-agy-b');
    const fakeAgyScript = (version, model) =>
      '#!/bin/sh\n' +
      `if [ "$1" = "--version" ]; then echo "agy ${version}"; exit 0; fi\n` +
      `if [ "$1" = "models" ]; then echo "${model}"; exit 0; fi\n` +
      'exit 1\n';
    writeFileSync(fakeAgyA, fakeAgyScript('1.0.0', 'Model A'), { mode: 0o755 });
    writeFileSync(fakeAgyB, fakeAgyScript('2.0.0', 'Model B'), { mode: 0o755 });
    const binding = (name) => ({ light: name, normal: name, strong: name, maximum: name });
    writeCatalog({
      schemaVersion: 1,
      providers: {
        anthropic: {
          profiles: allProfileBinaries(ANTHROPIC_BUILTIN_PROFILE_NAMES, join(tmpDir, 'no-such-claude')),
          qualityBindings: binding('probe-test'),
        },
        openai: {
          capabilities: { binary: 'free' },
          profiles: allProfileBinaries(OPENAI_BUILTIN_PROFILE_NAMES, join(tmpDir, 'no-such-codex')),
          qualityBindings: binding('probe-test'),
        },
        google: {
          profiles: {
            'agy-light': { binary: fakeAgyA, model: 'Model A' },
            'agy-normal': { binary: fakeAgyA },
            'agy-strong': { binary: fakeAgyB, model: 'Model B' },
            'agy-maximum': { binary: fakeAgyB, model: 'Gone Model' },
          },
        },
      },
    });
    const { res, payload, answered } = await refreshUntilDiscoveryAnswered();
    if (!answered) return; // Every attempt starved; the warnings above say so.
    expect(res.code).toBe(0);

    // Each profile is judged by its own executable's listing: 'Model B' is
    // absent from binary A's answer, but the profile configuring it runs
    // binary B — which offers it — so only the model no listing of its own
    // binary contains is flagged.
    const removed = payload.findings.filter((f) => f.kind === 'removed-model');
    expect(removed.map((f) => f.target)).toEqual([
      'providers.google.profiles.agy-maximum.model',
    ]);

    // Both executables were queried — not just the first one that listed.
    const googleProbes = payload.capabilityDiscovery.results.filter((r) => r.provider === 'google');
    expect(googleProbes.map((r) => r.binary)).toEqual([fakeAgyA, fakeAgyB]);
    const inventory = payload.modelInventory.find((r) => r.provider === 'google');
    expect(inventory.source).toBe('live');
    expect(inventory.models).toEqual(['Model A', 'Model B']);
  }, STARVATION_TOLERANT_TIMEOUT_MS);

  test('a profile no quality level binds is still probed and judged by its own executable', async () => {
    // Operator-created profiles reachable only through a session pin: no
    // binding names them, but a pinned run would execute their binary, so the
    // refresh must inventory them too — probing that executable rather than
    // skipping it, and judging their models against its live listing rather
    // than degrading them to the bundled fallback while it answers.
    const fakeAgy = join(tmpDir, 'fake-agy');
    const fakePinned = join(tmpDir, 'fake-agy-pinned');
    const fakeAgyScript = (version, model) =>
      '#!/bin/sh\n' +
      `if [ "$1" = "--version" ]; then echo "agy ${version}"; exit 0; fi\n` +
      `if [ "$1" = "models" ]; then echo "${model}"; exit 0; fi\n` +
      'exit 1\n';
    writeFileSync(fakeAgy, fakeAgyScript('1.2.3', 'Gemini 3.1 Pro (Low)'), { mode: 0o755 });
    writeFileSync(fakePinned, fakeAgyScript('9.9.9', 'Pinned Model'), { mode: 0o755 });
    const binding = (name) => ({ light: name, normal: name, strong: name, maximum: name });
    writeCatalog({
      schemaVersion: 1,
      providers: {
        anthropic: {
          profiles: allProfileBinaries(ANTHROPIC_BUILTIN_PROFILE_NAMES, join(tmpDir, 'no-such-claude')),
          qualityBindings: binding('probe-test'),
        },
        openai: {
          capabilities: { binary: 'free' },
          profiles: allProfileBinaries(OPENAI_BUILTIN_PROFILE_NAMES, join(tmpDir, 'no-such-codex')),
          qualityBindings: binding('probe-test'),
        },
        google: {
          profiles: {
            'agy-light': { binary: fakeAgy },
            'agy-normal': { binary: fakeAgy },
            'agy-strong': { binary: fakeAgy },
            'agy-maximum': { binary: fakeAgy },
            // Reachable only through a pin, with its own executable ...
            'agy-pinned': { binary: fakePinned, model: 'Pinned Model' },
            // ... and one whose model no listing of its own binary offers.
            'agy-orphan': { binary: fakePinned, model: 'Vanished Model' },
          },
        },
      },
    });
    const { res, payload, answered } = await refreshUntilDiscoveryAnswered();
    if (!answered) return; // Every attempt starved; the warnings above say so.
    expect(res.code).toBe(0);

    // The pin-only profiles' executable was version-probed alongside the
    // bound profiles' one, not skipped because no binding reaches it.
    const googleProbes = payload.capabilityDiscovery.results.filter((r) => r.provider === 'google');
    expect(googleProbes.map((r) => r.binary)).toEqual([fakeAgy, fakePinned]);
    expect(googleProbes[1].status).toBe('available');
    expect(googleProbes[1].version).toBe('9.9.9');

    // Its model listing joined the live inventory ...
    const inventory = payload.modelInventory.find((r) => r.provider === 'google');
    expect(inventory.source).toBe('live');
    expect(inventory.models).toEqual(['Gemini 3.1 Pro (Low)', 'Pinned Model']);

    // ... and each pin-only profile is judged by that listing: the model its
    // own executable offers raises nothing, the vanished one is flagged —
    // advisory and preserved, never a proposed value.
    const removed = payload.findings.filter((f) => f.kind === 'removed-model');
    expect(removed.map((f) => f.target)).toEqual(['providers.google.profiles.agy-orphan.model']);
    expect(removed[0].disposition).toBe('advisory');
    expect(payload.changed).toBe(false);
  }, STARVATION_TOLERANT_TIMEOUT_MS);
});

describe('concurrent edits during discovery', () => {
  test('--yes refuses when the catalog changed while the probes ran, and overwrites nothing', async () => {
    // The fake CLI edits the catalog file when its models listing is probed —
    // after the refresh has read the file, before it applies. The apply must
    // notice and refuse rather than replace the newer document with a plan
    // derived from the earlier read.
    const fakeAgy = join(tmpDir, 'fake-agy');
    const editedPath = join(tmpDir, 'edited.json');
    const binding = (name) => ({ light: name, normal: name, strong: name, maximum: name });
    const original = {
      schemaVersion: 1,
      providers: {
        anthropic: {
          profiles: allProfileBinaries(ANTHROPIC_BUILTIN_PROFILE_NAMES, join(tmpDir, 'no-such-claude')),
          qualityBindings: binding('probe-test'),
        },
        openai: {
          capabilities: { binary: 'free' },
          profiles: allProfileBinaries(OPENAI_BUILTIN_PROFILE_NAMES, join(tmpDir, 'no-such-codex')),
          qualityBindings: binding('probe-test'),
        },
        google: {
          profiles: {
            // The redundant printTimeout makes the plan a change, so --yes
            // reaches the apply step.
            'agy-light': { binary: fakeAgy, providerOptions: { printTimeout: '15m' } },
            'agy-normal': { binary: fakeAgy },
            'agy-strong': { binary: fakeAgy },
            'agy-maximum': { binary: fakeAgy },
          },
        },
      },
    };
    const edited = JSON.parse(JSON.stringify(original));
    edited.providers.anthropic.profiles['probe-test'].budget = '99';
    writeFileSync(editedPath, JSON.stringify(edited, null, 2));
    writeFileSync(
      fakeAgy,
      '#!/bin/sh\n' +
        'if [ "$1" = "--version" ]; then echo "agy 1.2.3"; exit 0; fi\n' +
        `if [ "$1" = "models" ]; then cp "${editedPath}" "${catalogPath}"; echo "Gemini 3.1 Pro (Low)"; exit 0; fi\n` +
        'exit 1\n',
      { mode: 0o755 },
    );
    // The models probe IS the concurrent edit, so this case needs that probe
    // answered. A host that starves it (#897) never runs the `cp`, leaving the
    // apply with nothing to refuse — a fact about the host, not about the
    // conflict check. Re-seed the fixture and ask again; a determinate
    // non-refusal falls straight through to the assertions below.
    const leftovers = () =>
      readdirSync(tmpDir).filter(
        (f) => f.includes('.bak') || f.includes('.tmp') || f.includes('.refresh-lock'),
      );
    const attempts = 2;
    let res;
    let payload;
    let answered = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // An attempt that applied rewrote the catalog and left a backup behind;
      // the retry has to start from the same bytes the first one did.
      for (const f of leftovers()) rmSync(join(tmpDir, f), { force: true });
      writeCatalog(original);
      res = await refresh(['--yes', '--json']);
      payload = res.stdout.trim().startsWith('{') ? JSON.parse(res.stdout) : null;
      if (res.code === 1 || payload === null || !discoveryWasStarved(payload)) {
        answered = true;
        break;
      }
      // Loud on purpose: see refreshUntilDiscoveryAnswered.
      console.warn(
        `agent-profile refresh concurrent-edit probe starved on attempt ${attempt}/${attempts} — ` +
          'the catalog was never edited, so the apply had no conflict to refuse',
      );
    }
    if (!answered) return; // Every attempt starved; the warnings above say so.

    expect(res.code).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('refresh-conflict');
    // The concurrent edit survives untouched; nothing applied, nothing
    // backed up, no staged temp file left behind — and the refusing run
    // released its own transaction lock.
    const after = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(after.providers.anthropic.profiles['probe-test'].budget).toBe('99');
    expect(after.providers.google.profiles['agy-light'].providerOptions).toEqual({
      printTimeout: '15m',
    });
    expect(leftovers()).toEqual([]);

    // Re-running against the settled file plans from the current bytes and
    // applies cleanly: the operator's concurrent edit is preserved, only the
    // tool-managed redundancy goes.
    const again = await refresh(['--offline', '--yes', '--json']);
    expect(again.code).toBe(0);
    const againPayload = JSON.parse(again.stdout);
    expect(againPayload.applied).toBe(true);
    const rewritten = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(rewritten.providers.anthropic.profiles['probe-test'].budget).toBe('99');
    expect(rewritten.providers.google.profiles['agy-light']).toEqual({ binary: fakeAgy });
  }, STARVATION_TOLERANT_TIMEOUT_MS);
});
