/**
 * Runner-side preparation tests for the bounded Antigravity workspace settings
 * (issue #826, docs/antigravity-workspace-settings.md §1, §3, §6, §7).
 *
 * These run against real temporary git repositories: the refusals this layer
 * owes (tracked file, symlink, escape, dirty worktree, untrusted workspace) are
 * only meaningful against real index and ignore state.
 */
import { execFileSync } from 'child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  prepareAntigravityWorkspaceSettings,
  releaseAntigravityWorkspaceSettings,
  verifyPreparedWorkspaceSettings,
  defaultGlobalSettingsPath,
  nodeCliVersionProbe,
  nodeWorkspaceGitProbe,
} from '../dist/handlers/antigravity-workspace.js';
import {
  AntigravityWorkspaceSettingsError,
  WORKSPACE_SETTINGS_POLICY_VERSION,
  renderWorkspaceSettings,
  buildResearchWorkspaceSettings,
  workspaceSettingsSha256,
} from '../dist/core/antigravity-workspace-settings.js';

let tmpDir;
let repoRoot;
let realRoot;
let globalSettingsPath;

function git(args, cwd = repoRoot) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
}

function initRepo({ gitignore } = {}) {
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  writeFileSync(join(repoRoot, 'README.md'), '# fixture\n');
  if (gitignore) writeFileSync(join(repoRoot, '.gitignore'), gitignore);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial']);
}

function writeGlobalSettings(document) {
  writeFileSync(globalSettingsPath, JSON.stringify(document, null, 2) + '\n');
}

function trustedGlobalSettings(extra = {}) {
  writeGlobalSettings({ theme: 'dark', ...extra, trustedWorkspaces: [realRoot] });
}

/** The installed CLI is version-gated (issue #830 §6.3); these tests answer the
 * probe with the reconciled version instead of spawning the real binary. */
const prepare = (overrides = {}) =>
  prepareAntigravityWorkspaceSettings({
    workspaceRoot: repoRoot,
    cmdSource: 'cli-default',
    globalSettingsPath,
    probeCliVersion: () => '1.1.9',
    ...overrides,
  });

const readGlobal = () => JSON.parse(readFileSync(globalSettingsPath, 'utf8'));

function refusalReason(fn) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AntigravityWorkspaceSettingsError);
    return err.reason;
  }
  throw new Error('expected a refusal');
}

const settingsPath = () => join(repoRoot, '.gemini', 'settings.json');
const readSettings = () => JSON.parse(readFileSync(settingsPath(), 'utf8'));

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'antigravity-workspace-'));
  repoRoot = join(tmpDir, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  realRoot = realpathSync.native(repoRoot);
  globalSettingsPath = join(tmpDir, 'antigravity-cli-settings.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

describe('workspace settings preparation — generation', () => {
  test('writes a research-only profile for a canonical repository', () => {
    initRepo();
    trustedGlobalSettings();
    const prepared = prepare();

    expect(prepared.policyVersion).toBe(WORKSPACE_SETTINGS_POLICY_VERSION);
    expect(prepared.relativePath).toBe('.gemini/settings.json');
    const written = readFileSync(settingsPath(), 'utf8');
    expect(prepared.settingsSha256).toBe(workspaceSettingsSha256(written));
    expect(written).toBe(renderWorkspaceSettings(buildResearchWorkspaceSettings({ workspaceRoot: realRoot })));

    const settings = readSettings();
    expect(settings.tools.core).toContain('read_file');
    expect(settings.tools.exclude).toContain('run_shell_command');
    expect(settings.autoAccept).toBe(false);
  });

  test('scopes every path-bearing rule to the resolved workspace root', () => {
    initRepo();
    trustedGlobalSettings();
    prepare();
    const { allow, deny } = readSettings().permissions;
    expect(allow).toContain(`read_file(${realRoot}/**)`);
    for (const rule of [...allow, ...deny]) {
      const match = /^[a-z_]+\((.*)\)$/.exec(rule);
      if (!match) continue;
      expect(match[1] === realRoot || match[1].startsWith(`${realRoot}/`)).toBe(true);
    }
  });

  test('regenerating replaces a stale or malformed pre-existing file whole', () => {
    initRepo();
    trustedGlobalSettings();
    mkdirSync(join(repoRoot, '.gemini'));
    writeFileSync(settingsPath(), '{ this is not json, and it grants everything');
    const first = prepare();
    expect(readSettings().permissions.allow.length).toBeGreaterThan(0);

    // A previous run's broader profile must not survive into the next one.
    writeFileSync(settingsPath(), JSON.stringify({ autoAccept: true, permissions: { allow: ['run_shell_command'] } }));
    const second = prepare();
    expect(second.settingsSha256).toBe(first.settingsSha256);
    expect(readSettings().autoAccept).toBe(false);
    expect(readSettings().permissions.allow).not.toContain('run_shell_command');
  });

  test('an operator-overridden binary refuses rather than writing an unvetted profile', () => {
    initRepo();
    trustedGlobalSettings();
    expect(refusalReason(() => prepare({ cmdSource: 'env' }))).toBe('unvetted-cli-binary');
    expect(existsSync(settingsPath())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Launch-time re-verification (§1)
// ---------------------------------------------------------------------------

describe('workspace settings verification at launch — issue #826', () => {
  const prepared = () => {
    initRepo();
    trustedGlobalSettings();
    return prepare();
  };

  test('accepts the file preparation just generated', () => {
    const record = prepared();
    expect(() => verifyPreparedWorkspaceSettings(repoRoot, record)).not.toThrow();
  });

  test('refuses a profile renamed away and replaced with a broader regular file', () => {
    const record = prepared();
    // What `agy` would load: it resolves the pathname itself at startup, so the
    // descriptor preparation verified says nothing about this file.
    rmSync(settingsPath());
    writeFileSync(settingsPath(), JSON.stringify({
      autoAccept: true,
      permissions: { allow: ['run_shell_command', 'write_file'], deny: [] },
    }, null, 2) + '\n');

    expect(refusalReason(() => verifyPreparedWorkspaceSettings(repoRoot, record)))
      .toBe('settings-replaced-before-launch');
    // Read-only: the unexplained file is refused, never repaired in place.
    expect(readSettings().autoAccept).toBe(true);
  });

  test('refuses a same-size replacement, so the check is content and not length', () => {
    const record = prepared();
    const swapped = readFileSync(settingsPath(), 'utf8').replace('"autoAccept": false', '"autoAccept": TRUE!');
    expect(swapped.length).toBe(record.settingsBytes);
    writeFileSync(settingsPath(), swapped);

    expect(refusalReason(() => verifyPreparedWorkspaceSettings(repoRoot, record)))
      .toBe('settings-replaced-before-launch');
  });

  test('refuses a settings file swapped for a symlink after preparation', () => {
    const record = prepared();
    const outside = join(tmpDir, 'broader.json');
    writeFileSync(outside, JSON.stringify({ permissions: { allow: ['run_shell_command'] } }));
    rmSync(settingsPath());
    symlinkSync(outside, settingsPath());

    expect(refusalReason(() => verifyPreparedWorkspaceSettings(repoRoot, record))).toBe('settings-symlink');
  });

  test('refuses a `.gemini` swapped for a symlink after preparation', () => {
    const record = prepared();
    const outsideDir = join(tmpDir, 'elsewhere');
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, 'settings.json'), readFileSync(settingsPath(), 'utf8'));
    rmSync(join(repoRoot, '.gemini'), { recursive: true });
    symlinkSync(outsideDir, join(repoRoot, '.gemini'));

    // Even though the linked-to file has identical bytes, the container is not
    // the prepared one, so the profile is not the runner's to vouch for.
    expect(refusalReason(() => verifyPreparedWorkspaceSettings(repoRoot, record))).toBe('settings-dir-symlink');
  });

  test('refuses when the prepared file is gone entirely', () => {
    const record = prepared();
    rmSync(settingsPath());
    expect(refusalReason(() => verifyPreparedWorkspaceSettings(repoRoot, record)))
      .toBe('settings-replaced-before-launch');
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('workspace settings preparation — refusals', () => {
  test('a tracked settings file refuses the run and is left untouched', () => {
    execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
    mkdirSync(join(repoRoot, '.gemini'));
    writeFileSync(settingsPath(), '{"repositoryOwned": true}\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'tracked settings']);
    trustedGlobalSettings();

    expect(refusalReason(() => prepare())).toBe('settings-tracked-by-git');
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{"repositoryOwned": true}\n');
  });

  test('a symlinked .gemini directory refuses the run', () => {
    initRepo();
    trustedGlobalSettings();
    const outside = join(tmpDir, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(repoRoot, '.gemini'));

    expect(refusalReason(() => prepare())).toBe('settings-dir-symlink');
    expect(existsSync(join(outside, 'settings.json'))).toBe(false);
  });

  test('a symlinked settings file refuses the run and writes nothing through the link', () => {
    initRepo();
    trustedGlobalSettings();
    mkdirSync(join(repoRoot, '.gemini'));
    const target = join(tmpDir, 'escape.json');
    writeFileSync(target, 'original\n');
    symlinkSync(target, settingsPath());

    expect(refusalReason(() => prepare())).toBe('settings-symlink');
    expect(readFileSync(target, 'utf8')).toBe('original\n');
  });

  test('a .gemini swapped for a symlink after the path checks refuses and writes nothing through it', () => {
    // The parent-directory race: `O_NOFOLLOW` on `settings.json` protects only
    // the final component, so preparation has to re-validate the directory it
    // is about to write into against a descriptor it pinned itself.
    initRepo({ gitignore: '.gemini/\n' });
    trustedGlobalSettings();
    const outside = join(tmpDir, 'outside');
    mkdirSync(outside);
    const victim = join(outside, 'settings.json');
    writeFileSync(victim, 'original\n');

    // The last read-only probe before the write is the ignore check, so the
    // swap lands exactly in the window the earlier checks leave open.
    const real = nodeWorkspaceGitProbe();
    const racingProbe = {
      ...real,
      isIgnored(root, relPath) {
        const answer = real.isIgnored(root, relPath);
        if (!existsSync(join(repoRoot, '.gemini'))) symlinkSync(outside, join(repoRoot, '.gemini'));
        return answer;
      },
    };

    expect(refusalReason(() => prepare({ git: racingProbe }))).toBe('settings-dir-symlink');
    expect(readFileSync(victim, 'utf8')).toBe('original\n');
    expect(lstatSync(join(repoRoot, '.gemini')).isSymbolicLink()).toBe(true);
  });

  test('a workspace root that does not resolve refuses', () => {
    trustedGlobalSettings();
    expect(refusalReason(() => prepare({ workspaceRoot: join(tmpDir, 'missing') })))
      .toBe('workspace-root-unresolvable');
  });

  test('a relative workspace root refuses before any filesystem access', () => {
    trustedGlobalSettings();
    expect(refusalReason(() => prepare({ workspaceRoot: 'repo' }))).toBe('workspace-root-not-absolute');
  });

  test('a workspace that is not a git repository refuses', () => {
    trustedGlobalSettings();
    expect(refusalReason(() => prepare())).toBe('git-probe-failed');
  });
});

// ---------------------------------------------------------------------------
// Git hygiene
// ---------------------------------------------------------------------------

describe('workspace settings preparation — git hygiene', () => {
  test('leaves no dirty-worktree result and no tracked change', () => {
    initRepo();
    trustedGlobalSettings();
    prepare();
    expect(git(['status', '--porcelain'])).toBe('');
    expect(git(['diff', '--stat'])).toBe('');
    expect(git(['ls-files', '--', '.gemini'])).toBe('');
  });

  test('registers the exclusion locally, never in a committed .gitignore', () => {
    initRepo();
    trustedGlobalSettings();
    const prepared = prepare();
    expect(prepared.gitIgnored).toBe('runner-exclude');
    const excludePath = join(repoRoot, '.git', 'info', 'exclude');
    expect(readFileSync(excludePath, 'utf8')).toContain('/.gemini/settings.json');
    expect(existsSync(join(repoRoot, '.gitignore'))).toBe(false);

    // Idempotent: a second preparation adds no duplicate entry, and still
    // reports the runner — not the repository — as the source of the exclusion.
    expect(prepare().gitIgnored).toBe('runner-exclude');
    const entries = readFileSync(excludePath, 'utf8').split('\n').filter((l) => l.trim() === '/.gemini/settings.json');
    expect(entries).toHaveLength(1);
  });

  test('an invalid profile configuration refuses before the exclude file is touched', () => {
    // A configuration refusal must leave no persistent workspace-side change,
    // so the profile is built and validated before the ignore entry is written.
    initRepo();
    trustedGlobalSettings();
    const excludePath = join(repoRoot, '.git', 'info', 'exclude');
    const before = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : null;

    const denyGlobs = Array.from({ length: 33 }, (_, i) => `secret-${i}/**`);
    expect(refusalReason(() => prepare({ denyGlobs }))).toBe('operator-glob-budget-exceeded');

    const after = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : null;
    expect(after).toBe(before);
    expect(existsSync(settingsPath())).toBe(false);
    expect(git(['status', '--porcelain'])).toBe('');
  });

  test('a repository that already ignores the file is left alone', () => {
    initRepo({ gitignore: '.gemini/\n' });
    trustedGlobalSettings();
    const prepared = prepare();
    expect(prepared.gitIgnored).toBe('repository');
    const excludePath = join(repoRoot, '.git', 'info', 'exclude');
    const exclude = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    expect(exclude).not.toContain('/.gemini/settings.json');
    expect(git(['status', '--porcelain'])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

describe('workspace settings preparation — trust', () => {
  test('an untrusted workspace fails closed instead of being granted silently', () => {
    initRepo();
    writeGlobalSettings({ theme: 'dark', trustedWorkspaces: ['/somewhere/else'] });
    expect(refusalReason(() => prepare())).toBe('workspace-not-trusted');
    expect(existsSync(settingsPath())).toBe(false);
    // Nothing was written: no trust entry, and no permission overlay either.
    expect(readGlobal()).toEqual({ theme: 'dark', trustedWorkspaces: ['/somewhere/else'] });
  });

  test('an exact entry in the legacy trustedFolders map still grants trust', () => {
    initRepo();
    writeGlobalSettings({ trustedFolders: { [realRoot]: 'TRUST_FOLDER' } });
    const prepared = prepare();
    expect(prepared.trust.status).toBe('trusted-exact');
    expect(prepared.trust.representation).toBe('trustedFolders');
    expect(prepared.trust.registered).toBe(false);
    // The legacy container is read, never rewritten.
    expect(readGlobal().trustedWorkspaces).toBeUndefined();
  });

  test('an invalid profile configuration refuses before the trust store is written', () => {
    initRepo();
    writeGlobalSettings({ theme: 'dark' });
    const denyGlobs = Array.from({ length: 33 }, (_, i) => `secret-${i}/**`);

    expect(refusalReason(() => prepare({ denyGlobs, registerTrust: true }))).toBe('operator-glob-budget-exceeded');
    expect(JSON.parse(readFileSync(globalSettingsPath, 'utf8'))).toEqual({ theme: 'dark' });
  });

  test('an explicitly distrusted workspace refuses', () => {
    initRepo();
    writeGlobalSettings({ trustedFolders: { [realRoot]: 'DO_NOT_TRUST' } });
    expect(refusalReason(() => prepare())).toBe('workspace-distrusted');
  });

  test('opt-in registration adds only the exact workspace and preserves unrelated settings', () => {
    initRepo();
    writeGlobalSettings({
      theme: 'dark',
      selectedAuthType: 'oauth',
      trustedWorkspaces: ['/somewhere/else'],
      trustedFolders: { '/legacy/repo': 'TRUST_FOLDER' },
    });
    const prepared = prepare({ registerTrust: true });
    expect(prepared.trust.registered).toBe(true);
    expect(prepared.trust.status).toBe('trusted-exact');
    expect(prepared.trust.representation).toBe('trustedWorkspaces');

    const after = readGlobal();
    expect(after.theme).toBe('dark');
    expect(after.selectedAuthType).toBe('oauth');
    // Written in the representation agy 1.1.9 uses; the legacy map is untouched.
    expect(after.trustedWorkspaces).toEqual(['/somewhere/else', realRoot]);
    expect(after.trustedFolders).toEqual({ '/legacy/repo': 'TRUST_FOLDER' });
    // No parent-directory trust is introduced for the workspace's ancestors.
    expect(after.trustedWorkspaces).not.toContain(tmpDir);
    expect(after.trustedWorkspaces).not.toContain(realpathSync.native(tmpDir));
  });

  test('an already-trusted workspace keeps its trust entries untouched', () => {
    initRepo();
    trustedGlobalSettings();
    const before = readFileSync(globalSettingsPath, 'utf8');
    const prepared = prepare({ registerTrust: true });
    expect(prepared.trust.registered).toBe(false);
    expect(prepared.trust.status).toBe('trusted-exact');
    expect(readGlobal().trustedWorkspaces).toEqual([realRoot]);

    // The only change is the run's own permission overlay, and releasing it
    // restores the operator's file byte-for-byte.
    releaseAntigravityWorkspaceSettings(prepared);
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(before);
  });

  test('an unparseable global settings document is never replaced or repaired', () => {
    initRepo();
    writeFileSync(globalSettingsPath, '{ half a document');
    expect(refusalReason(() => prepare({ registerTrust: true }))).toBe('trust-store-unreadable');
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe('{ half a document');
  });

  test('an unknown trust status in the global store fails closed', () => {
    initRepo();
    writeGlobalSettings({ trustedFolders: { [realRoot]: 'TRUST_EVERYTHING' } });
    expect(refusalReason(() => prepare())).toBe('schema-drift');
  });

  test('a trustedWorkspaces container of the wrong shape fails closed', () => {
    initRepo();
    writeGlobalSettings({ trustedWorkspaces: { [realRoot]: true } });
    expect(refusalReason(() => prepare())).toBe('schema-drift');
    expect(existsSync(settingsPath())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Installed-CLI version gate (§6.3, issue #830)
// ---------------------------------------------------------------------------

describe('workspace settings preparation — installed-CLI version gate', () => {
  test('an unsupported installed CLI refuses before anything is written', () => {
    initRepo();
    trustedGlobalSettings();
    const before = readFileSync(globalSettingsPath, 'utf8');

    expect(refusalReason(() => prepare({ probeCliVersion: () => 'agy version 1.1.8' })))
      .toBe('unsupported-cli-version');
    expect(existsSync(settingsPath())).toBe(false);
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(before);
    expect(git(['status', '--porcelain'])).toBe('');
  });

  test('a CLI that cannot report a version refuses rather than being assumed compatible', () => {
    initRepo();
    trustedGlobalSettings();
    expect(refusalReason(() => prepare({ probeCliVersion: () => 'agy (dev build)' })))
      .toBe('cli-version-unreadable');
    expect(existsSync(settingsPath())).toBe(false);
  });

  test('the reconciled version is recorded on the prepared profile', () => {
    initRepo();
    trustedGlobalSettings();
    expect(prepare({ probeCliVersion: () => 'agy version 1.1.9' }).cliVersion).toBe('1.1.9');
  });

  test('the default probe executes the binary rather than trusting the environment', () => {
    // A value left set from an earlier session would keep answering the gate for
    // a binary nobody probed — including one upgraded or replaced since (issue
    // #830 review). The probe therefore has no environment override at all.
    const previous = process.env['ANTIGRAVITY_CLI_VERSION'];
    try {
      process.env['ANTIGRAVITY_CLI_VERSION'] = '1.1.9';
      const probe = nodeCliVersionProbe(join(tmpDir, 'no-such-agy'));
      expect(refusalReason(probe)).toBe('cli-version-unreadable');
    } finally {
      if (previous === undefined) delete process.env['ANTIGRAVITY_CLI_VERSION'];
      else process.env['ANTIGRAVITY_CLI_VERSION'] = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// Store location
// ---------------------------------------------------------------------------

describe('workspace settings preparation — global store location', () => {
  test('honours ANTIGRAVITY_CLI_SETTINGS and otherwise uses the CLI default', () => {
    const previous = process.env['ANTIGRAVITY_CLI_SETTINGS'];
    try {
      process.env['ANTIGRAVITY_CLI_SETTINGS'] = globalSettingsPath;
      expect(defaultGlobalSettingsPath()).toBe(globalSettingsPath);
      delete process.env['ANTIGRAVITY_CLI_SETTINGS'];
      expect(defaultGlobalSettingsPath().endsWith('/.gemini/antigravity-cli/settings.json')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['ANTIGRAVITY_CLI_SETTINGS'];
      else process.env['ANTIGRAVITY_CLI_SETTINGS'] = previous;
    }
  });

  test('a run that will launch the CLI refuses a store the CLI does not load', () => {
    // `globalSettingsPath` only moves where the RUNNER writes; `agy` still reads
    // its own store. Preparing an alternate file for a real invocation would
    // report a verified profile for a permission set the agent never sees
    // (issue #830 review). A real invocation is one that does not answer the
    // version probe by injection.
    initRepo();
    trustedGlobalSettings();
    const before = readFileSync(globalSettingsPath, 'utf8');

    const reason = refusalReason(() => prepareAntigravityWorkspaceSettings({
      workspaceRoot: repoRoot,
      cmdSource: 'cli-default',
      globalSettingsPath,
      registerTrust: true,
    }));

    expect(reason).toBe('global-settings-not-canonical');
    // Refused before anything is written — and before the binary is even
    // probed, so the refusal does not depend on a locally installed CLI.
    expect(existsSync(settingsPath())).toBe(false);
    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(before);
    expect(git(['status', '--porcelain'])).toBe('');
  });

  test('ANTIGRAVITY_CLI_SETTINGS cannot redirect a run that will launch the CLI either', () => {
    initRepo();
    trustedGlobalSettings();
    const previous = process.env['ANTIGRAVITY_CLI_SETTINGS'];
    try {
      process.env['ANTIGRAVITY_CLI_SETTINGS'] = globalSettingsPath;
      expect(refusalReason(() => prepareAntigravityWorkspaceSettings({
        workspaceRoot: repoRoot,
        cmdSource: 'cli-default',
        registerTrust: true,
      }))).toBe('global-settings-not-canonical');
    } finally {
      if (previous === undefined) delete process.env['ANTIGRAVITY_CLI_SETTINGS'];
      else process.env['ANTIGRAVITY_CLI_SETTINGS'] = previous;
    }
    expect(existsSync(settingsPath())).toBe(false);
  });

  test('the refusal names no path, so the bounded artifact stays path-free', () => {
    initRepo();
    trustedGlobalSettings();
    let error = null;
    try {
      prepareAntigravityWorkspaceSettings({
        workspaceRoot: repoRoot,
        cmdSource: 'cli-default',
        globalSettingsPath,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(AntigravityWorkspaceSettingsError);
    expect(error.reason).toBe('global-settings-not-canonical');
    // The detail is copied into research-workspace-settings.json (§8), which
    // never records an absolute path.
    expect(error.detail).not.toContain(globalSettingsPath);
    expect(error.detail).not.toContain(tmpDir);
  });

  test('a global store inside the workspace refuses before it is read', () => {
    initRepo();
    // The generated profile grants read over the whole workspace, so a store
    // placed under it would be readable by the headless agent.
    const inside = join(repoRoot, 'cli-settings.json');
    writeFileSync(inside, JSON.stringify({ trustedFolders: { [realRoot]: 'TRUST_FOLDER' } }));

    expect(refusalReason(() => prepare({ globalSettingsPath: inside, registerTrust: true })))
      .toBe('trust-store-inside-workspace');
    expect(existsSync(settingsPath())).toBe(false);
  });

  test('a global store at the generated settings path refuses instead of colliding', () => {
    initRepo();
    // The collision case: registration would write the trust document to the
    // exact path the workspace profile then overwrites.
    const collision = settingsPath();

    expect(refusalReason(() => prepare({ globalSettingsPath: collision, registerTrust: true })))
      .toBe('trust-store-inside-workspace');
    expect(existsSync(collision)).toBe(false);
    expect(git(['status', '--porcelain'])).toBe('');
  });

  test('a global store reaching the workspace through a symlink refuses', () => {
    initRepo();
    const link = join(tmpDir, 'link-to-repo');
    symlinkSync(realRoot, link);
    const throughLink = join(link, 'nested', 'cli-settings.json');

    expect(refusalReason(() => prepare({ globalSettingsPath: throughLink, registerTrust: true })))
      .toBe('trust-store-inside-workspace');
    expect(existsSync(join(repoRoot, 'nested'))).toBe(false);
  });

  test('a not-yet-created store outside the workspace is still accepted', () => {
    initRepo();
    const pending = join(tmpDir, 'store', 'nested', 'settings.json');

    const prepared = prepare({ globalSettingsPath: pending, registerTrust: true });
    expect(prepared.trust.registered).toBe(true);
    expect(JSON.parse(readFileSync(pending, 'utf8')).trustedWorkspaces).toEqual([realRoot]);

    // Releasing leaves the store the runner created with trust only — the
    // grants do not outlive the run.
    releaseAntigravityWorkspaceSettings(prepared);
    expect(JSON.parse(readFileSync(pending, 'utf8'))).toEqual({ trustedWorkspaces: [realRoot] });
  });

  test('the generated file is a regular file, not a link', () => {
    initRepo();
    trustedGlobalSettings();
    prepare();
    expect(lstatSync(settingsPath()).isSymbolicLink()).toBe(false);
    expect(lstatSync(settingsPath()).isFile()).toBe(true);
  });
});
