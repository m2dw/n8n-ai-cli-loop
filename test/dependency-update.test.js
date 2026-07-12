import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseDependencyUpdateRequest,
  runDependencyUpdate,
} from '../dist/handlers/dependency-update.js';

// ---------------------------------------------------------------------------
// Sequence runner: each call to run() consumes one queued result.
// ---------------------------------------------------------------------------
function sequenceRunner(steps) {
  const calls = [];
  let i = 0;
  return {
    calls,
    run(cmd, args, opts) {
      const result = steps[i] ?? { stdout: '', stderr: 'unexpected call', exitCode: 1 };
      calls.push({ cmd, args, opts, result });
      i++;
      return result;
    },
  };
}

const CONFIG = (overrides = {}) => ({
  enabled: true,
  triggerPaths: ['package.json'],
  expectedOutputs: ['package-lock.json'],
  command: 'npm install --package-lock-only --ignore-scripts',
  timeoutMs: 120000,
  ...overrides,
});

let tmpDir;
let artifactDir;

function writeManifest(manifest) {
  writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}
function readManifest() {
  return JSON.parse(readFileSync(join(tmpDir, 'package.json'), 'utf8'));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dep-update-test-'));
  artifactDir = tmpDir;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseDependencyUpdateRequest
// ---------------------------------------------------------------------------
describe('parseDependencyUpdateRequest', () => {
  test('parses npm install with an explicit version', () => {
    const r = parseDependencyUpdateRequest('npm install mail-auth-signal@^0.3.0');
    expect(r).toEqual({ manager: 'npm', packages: [{ name: 'mail-auth-signal', version: '^0.3.0' }] });
  });

  test('parses the `npm i` and `npm add` aliases', () => {
    expect(parseDependencyUpdateRequest('npm i left-pad@1.3.0').packages).toEqual([{ name: 'left-pad', version: '1.3.0' }]);
    expect(parseDependencyUpdateRequest('npm add left-pad@1.3.0').packages).toEqual([{ name: 'left-pad', version: '1.3.0' }]);
  });

  test('keeps the scope on a scoped package and splits on the version @', () => {
    const r = parseDependencyUpdateRequest('npm install @scope/pkg@^1.2.3');
    expect(r.packages).toEqual([{ name: '@scope/pkg', version: '^1.2.3' }]);
  });

  test('maps save-target flags to their manifest section', () => {
    expect(parseDependencyUpdateRequest('npm install --save-dev jest@^29').section).toBe('devDependencies');
    expect(parseDependencyUpdateRequest('npm install -D jest@^29').section).toBe('devDependencies');
    expect(parseDependencyUpdateRequest('npm install --save-peer react@^18').section).toBe('peerDependencies');
    expect(parseDependencyUpdateRequest('npm install --save-optional foo@1.0.0').section).toBe('optionalDependencies');
    expect(parseDependencyUpdateRequest('npm install -O foo@1.0.0').section).toBe('optionalDependencies');
    expect(parseDependencyUpdateRequest('npm install --save-prod foo@1.0.0').section).toBe('dependencies');
  });

  test('no section flag leaves section undefined (manager default applies)', () => {
    expect(parseDependencyUpdateRequest('npm install left-pad@1.3.0').section).toBeUndefined();
  });

  test('records a save-target/scope flag the manifest edit cannot represent', () => {
    expect(parseDependencyUpdateRequest('npm install --no-save foo@1.0.0').unsupportedFlag).toBe('--no-save');
    expect(parseDependencyUpdateRequest('npm install --global foo@1.0.0').unsupportedFlag).toBe('--global');
    expect(parseDependencyUpdateRequest('npm install -g foo@1.0.0').unsupportedFlag).toBe('-g');
  });

  test('records a target-changing workspace/prefix flag (inline value)', () => {
    expect(parseDependencyUpdateRequest('npm install --workspace=packages/app left-pad@1.3.0').unsupportedFlag)
      .toBe('--workspace=packages/app');
    expect(parseDependencyUpdateRequest('npm install --prefix=packages/app left-pad@1.3.0').unsupportedFlag)
      .toBe('--prefix=packages/app');
  });

  test('records a target-changing workspace/prefix flag (short + space-separated value)', () => {
    expect(parseDependencyUpdateRequest('npm install -w packages/app left-pad@1.3.0').unsupportedFlag).toBe('-w');
    expect(parseDependencyUpdateRequest('npm install -C packages/app left-pad@1.3.0').unsupportedFlag).toBe('-C');
    expect(parseDependencyUpdateRequest('npm install --workspaces left-pad@1.3.0').unsupportedFlag).toBe('--workspaces');
  });

  test('ignores --workspaces=false (npm treats it as root, not a workspace target)', () => {
    expect(parseDependencyUpdateRequest('npm install --workspaces=false left-pad@1.3.0').unsupportedFlag)
      .toBeUndefined();
  });

  test('rejects truthy --flag=value boolean forms of global/no-save', () => {
    expect(parseDependencyUpdateRequest('npm install --global=true foo@1.0.0').unsupportedFlag).toBe('--global=true');
    expect(parseDependencyUpdateRequest('npm install --no-save=true foo@1.0.0').unsupportedFlag).toBe('--no-save=true');
    expect(parseDependencyUpdateRequest('npm install --global=1 foo@1.0.0').unsupportedFlag).toBe('--global=1');
  });

  test('ignores a falsy --flag=value boolean form (npm treats it as not set)', () => {
    expect(parseDependencyUpdateRequest('npm install --global=false foo@1.0.0').unsupportedFlag).toBeUndefined();
  });

  test('rejects --save=false (npm equivalent of --no-save)', () => {
    expect(parseDependencyUpdateRequest('npm install --save=false foo@1.0.0').unsupportedFlag).toBe('--save=false');
    expect(parseDependencyUpdateRequest('npm install --save=0 foo@1.0.0').unsupportedFlag).toBe('--save=0');
  });

  test('ignores the eligible truthy/bare --save form (the default this path relies on)', () => {
    expect(parseDependencyUpdateRequest('npm install --save foo@1.0.0').unsupportedFlag).toBeUndefined();
    expect(parseDependencyUpdateRequest('npm install --save=true foo@1.0.0').unsupportedFlag).toBeUndefined();
  });

  test('rejects --location=global/user (npm equivalent of a global install)', () => {
    expect(parseDependencyUpdateRequest('npm install --location=global foo@1.0.0').unsupportedFlag)
      .toBe('--location=global');
    expect(parseDependencyUpdateRequest('npm install --location=user foo@1.0.0').unsupportedFlag)
      .toBe('--location=user');
  });

  test('ignores --location=project (the ordinary local install)', () => {
    expect(parseDependencyUpdateRequest('npm install --location=project foo@1.0.0').unsupportedFlag).toBeUndefined();
  });

  test('rejects target-changing flags with falsy-looking values (value is a target, not a boolean)', () => {
    // `--prefix`/`--workspace` take a string target; a falsy-looking value is
    // still a real target, so it must not fall through to the root manifest.
    expect(parseDependencyUpdateRequest('npm install --prefix=false foo@1.0.0').unsupportedFlag)
      .toBe('--prefix=false');
    expect(parseDependencyUpdateRequest('npm install --workspace=0 foo@1.0.0').unsupportedFlag)
      .toBe('--workspace=0');
    expect(parseDependencyUpdateRequest('npm install --prefix= foo@1.0.0').unsupportedFlag)
      .toBe('--prefix=');
  });

  test('records a package with no pinned version (version undefined)', () => {
    const r = parseDependencyUpdateRequest('npm install left-pad');
    expect(r.packages).toEqual([{ name: 'left-pad' }]);
  });

  test('returns undefined for a non-install command or a bare install', () => {
    expect(parseDependencyUpdateRequest('npm test')).toBeUndefined();
    expect(parseDependencyUpdateRequest('npm install')).toBeUndefined();
    expect(parseDependencyUpdateRequest('rm -rf /')).toBeUndefined();
  });

  test('recognizes a non-npm ecosystem (cargo) for routing', () => {
    const r = parseDependencyUpdateRequest('cargo add serde@1.0');
    expect(r).toMatchObject({ manager: 'cargo', packages: [{ name: 'serde', version: '1.0' }] });
  });
});

// ---------------------------------------------------------------------------
// runDependencyUpdate — successful dependency sync
// ---------------------------------------------------------------------------
describe('runDependencyUpdate — successful dependency sync', () => {
  test('edits the manifest and runs the session sync command, returning passed', () => {
    writeManifest({ name: 'p', dependencies: { existing: '^1.0.0' } });
    const runner = sequenceRunner([
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },                         // dep-sync git status (before)
      { stdout: 'updated lockfile', stderr: '', exitCode: 0 },                          // npm install --package-lock-only ...
      { stdout: ' M package.json\n M package-lock.json\n', stderr: '', exitCode: 0 },   // dep-sync git status (after)
    ]);
    const out = runDependencyUpdate(runner, CONFIG(), 'npm install mail-auth-signal@^0.3.0', tmpDir, artifactDir);

    expect(out).toMatchObject({ handled: true, passed: true, manager: 'npm', manifestPath: 'package.json' });
    expect(out.packages).toEqual([{ name: 'mail-auth-signal', version: '^0.3.0', section: 'dependencies' }]);
    expect(out.sync).toMatchObject({ ran: true, passed: true, producedExpectedOutputs: ['package-lock.json'] });

    // The manifest now reflects the requested version (durable result).
    expect(readManifest().dependencies['mail-auth-signal']).toBe('^0.3.0');
    // The EXACT session-pinned command ran — never the agent's `npm install <pkg>`.
    const npmCall = runner.calls[1];
    expect(npmCall.cmd).toBe('npm');
    expect(npmCall.args).toEqual(['install', '--package-lock-only', '--ignore-scripts']);
  });

  test('updates a package in-place and records its previous version', () => {
    writeManifest({ name: 'p', dependencies: { 'left-pad': '^1.2.0' } });
    const runner = sequenceRunner([
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },
      { stdout: 'ok', stderr: '', exitCode: 0 },
      { stdout: ' M package.json\n M package-lock.json\n', stderr: '', exitCode: 0 },
    ]);
    const out = runDependencyUpdate(runner, CONFIG(), 'npm install left-pad@^1.3.0', tmpDir, artifactDir);
    expect(out.passed).toBe(true);
    expect(out.packages).toEqual([{ name: 'left-pad', version: '^1.3.0', section: 'dependencies', previousVersion: '^1.2.0' }]);
    expect(readManifest().dependencies['left-pad']).toBe('^1.3.0');
  });

  test('adds a --save-dev package to devDependencies', () => {
    writeManifest({ name: 'p' });
    const runner = sequenceRunner([
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },
      { stdout: 'ok', stderr: '', exitCode: 0 },
      { stdout: ' M package.json\n M package-lock.json\n', stderr: '', exitCode: 0 },
    ]);
    const out = runDependencyUpdate(runner, CONFIG(), 'npm install --save-dev jest@^29.7.0', tmpDir, artifactDir);
    expect(out.passed).toBe(true);
    expect(out.packages[0].section).toBe('devDependencies');
    expect(readManifest().devDependencies['jest']).toBe('^29.7.0');
  });

  test('adds a --save-peer package to peerDependencies (not dependencies)', () => {
    writeManifest({ name: 'p' });
    const runner = sequenceRunner([
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },
      { stdout: 'ok', stderr: '', exitCode: 0 },
      { stdout: ' M package.json\n M package-lock.json\n', stderr: '', exitCode: 0 },
    ]);
    const out = runDependencyUpdate(runner, CONFIG(), 'npm install --save-peer react@^18.0.0', tmpDir, artifactDir);
    expect(out.passed).toBe(true);
    expect(out.packages[0].section).toBe('peerDependencies');
    expect(readManifest().peerDependencies['react']).toBe('^18.0.0');
    // It was NOT silently written to the default `dependencies` section.
    expect(readManifest().dependencies).toBeUndefined();
  });

  test('honors an explicit save target by moving an existing package between sections', () => {
    writeManifest({ name: 'p', dependencies: { foo: '^1.0.0' } });
    const runner = sequenceRunner([
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },
      { stdout: 'ok', stderr: '', exitCode: 0 },
      { stdout: ' M package.json\n M package-lock.json\n', stderr: '', exitCode: 0 },
    ]);
    const out = runDependencyUpdate(runner, CONFIG(), 'npm install --save-dev foo@2.0.0', tmpDir, artifactDir);
    expect(out.passed).toBe(true);
    expect(out.packages[0]).toMatchObject({ name: 'foo', version: '2.0.0', section: 'devDependencies', previousVersion: '^1.0.0' });
    // npm moves the package to the requested block; the old entry is removed.
    expect(readManifest().devDependencies['foo']).toBe('2.0.0');
    expect(readManifest().dependencies).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// runDependencyUpdate — unchanged dependency state
// ---------------------------------------------------------------------------
describe('runDependencyUpdate — unchanged dependency state', () => {
  test('does not run a sync and hands off when the dependency is already satisfied and the tree is clean', () => {
    writeManifest({ name: 'p', dependencies: { 'mail-auth-signal': '^0.3.0' } });
    // git status (before) reports a clean tree: the manifest already matches and
    // nothing is dirty, so the sync is a no-op (ran: false).
    const runner = sequenceRunner([
      { stdout: '', stderr: '', exitCode: 0 },
    ]);
    const out = runDependencyUpdate(runner, CONFIG(), 'npm install mail-auth-signal@^0.3.0', tmpDir, artifactDir);

    expect(out).toMatchObject({ handled: true, passed: false });
    expect(out.failure.kind).toBe('unchanged');
    expect(out.packages).toEqual([]);
    // Only the git-status dirtiness probe ran — the sync command itself was never spawned.
    expect(runner.calls.some((c) => c.cmd === 'npm')).toBe(false);
    // The manifest is unchanged.
    expect(readManifest().dependencies['mail-auth-signal']).toBe('^0.3.0');
  });

  test('syncs the lockfile when the agent already edited the manifest to the requested version', () => {
    // The agent added the dependency to package.json before emitting the install
    // request, so applyManifest writes nothing — but the manifest is dirty and the
    // lockfile is stale. The handler must sync, not discard the edit as unchanged.
    writeManifest({ name: 'p', dependencies: { 'mail-auth-signal': '^0.3.0' } });
    const runner = sequenceRunner([
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },                  // git status (before): manifest dirty
      { stdout: 'ok', stderr: '', exitCode: 0 },                                // npm install --package-lock-only
      { stdout: ' M package.json\n M package-lock.json\n', stderr: '', exitCode: 0 }, // git status (after)
    ]);
    const out = runDependencyUpdate(runner, CONFIG(), 'npm install mail-auth-signal@^0.3.0', tmpDir, artifactDir);

    expect(out).toMatchObject({ handled: true, passed: true });
    expect(out.sync).toMatchObject({ ran: true, passed: true });
    // The agent's manifest edit was preserved (not reverted).
    expect(readManifest().dependencies['mail-auth-signal']).toBe('^0.3.0');
    // The session-pinned sync command actually ran to regenerate the lockfile.
    expect(runner.calls.some((c) => c.cmd === 'npm')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runDependencyUpdate — command failure
// ---------------------------------------------------------------------------
describe('runDependencyUpdate — command failure', () => {
  test('surfaces a sync-failed handoff when the sync command exits non-zero', () => {
    writeManifest({ name: 'p' });
    const runner = sequenceRunner([
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 },                    // git status (before)
      { stdout: '', stderr: 'npm ERR! 404 Not Found: no-such-pkg', exitCode: 1 }, // npm install fails
    ]);
    const out = runDependencyUpdate(runner, CONFIG(), 'npm install no-such-pkg@^9.9.9', tmpDir, artifactDir);

    expect(out).toMatchObject({ handled: true, passed: false });
    expect(out.failure.kind).toBe('sync-failed');
    expect(out.failure.message).toContain('404 Not Found');
    expect(out.sync).toMatchObject({ ran: true, passed: false });
    // The manifest was still edited (the applied package is reported for audit).
    expect(out.packages).toEqual([{ name: 'no-such-pkg', version: '^9.9.9', section: 'dependencies' }]);
  });

  test('hands off (manifest-error) when the manifest is missing', () => {
    // No package.json written.
    const runner = sequenceRunner([]);
    const out = runDependencyUpdate(runner, CONFIG(), 'npm install left-pad@^1.3.0', tmpDir, artifactDir);
    expect(out).toMatchObject({ handled: true, passed: false });
    expect(out.failure.kind).toBe('manifest-error');
    expect(runner.calls).toHaveLength(0);
  });

  test('refuses an unsafe (lifecycle-running) configured sync command', () => {
    writeManifest({ name: 'p' });
    const runner = sequenceRunner([
      { stdout: ' M package.json\n', stderr: '', exitCode: 0 }, // git status (before)
    ]);
    const out = runDependencyUpdate(
      runner,
      CONFIG({ command: 'npm install' }),
      'npm install left-pad@^1.3.0',
      tmpDir,
      artifactDir,
    );
    expect(out.passed).toBe(false);
    expect(out.failure.kind).toBe('sync-failed');
    expect(out.failure.message).toContain('allowLifecycleScripts');
    // The unsafe command was never spawned.
    expect(runner.calls.some((c) => c.cmd === 'npm')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runDependencyUpdate — not eligible (generic handoff)
// ---------------------------------------------------------------------------
describe('runDependencyUpdate — not eligible for the trusted path', () => {
  test('unsupported project type (cargo) against an npm config', () => {
    writeManifest({ name: 'p' });
    const runner = sequenceRunner([]);
    const out = runDependencyUpdate(runner, CONFIG(), 'cargo add serde@1.0', tmpDir, artifactDir);
    expect(out).toEqual({ handled: false, reason: 'unsupported-manager' });
    expect(runner.calls).toHaveLength(0);
  });

  test('a non-install command is not a dependency update', () => {
    const out = runDependencyUpdate(sequenceRunner([]), CONFIG(), 'npm run build', tmpDir, artifactDir);
    expect(out).toEqual({ handled: false, reason: 'not-a-dependency-update' });
  });

  test('not-configured when the session has no dependencySync', () => {
    const out = runDependencyUpdate(sequenceRunner([]), undefined, 'npm install left-pad@^1.3.0', tmpDir, artifactDir);
    expect(out).toEqual({ handled: false, reason: 'not-configured' });
  });

  test('not-configured when dependencySync is disabled', () => {
    const out = runDependencyUpdate(sequenceRunner([]), CONFIG({ enabled: false }), 'npm install left-pad@^1.3.0', tmpDir, artifactDir);
    expect(out).toEqual({ handled: false, reason: 'not-configured' });
  });

  test('missing-version when the request pins no version', () => {
    writeManifest({ name: 'p' });
    const out = runDependencyUpdate(sequenceRunner([]), CONFIG(), 'npm install left-pad', tmpDir, artifactDir);
    expect(out).toEqual({ handled: false, reason: 'missing-version' });
  });

  test('non-concrete-version when the request pins a mutable dist-tag or wildcard', () => {
    writeManifest({ name: 'p' });
    const runner = sequenceRunner([]);
    // Includes mutable dist-tags that embed digits (`beta2`, `next-18`): a tag
    // is non-concrete even though it contains a digit, because it begins with a
    // letter rather than a version number.
    for (const cmd of [
      'npm install foo@latest',
      'npm install foo@beta',
      'npm install foo@next',
      'npm install foo@*',
      'npm install foo@x',
      'npm install foo@beta2',
      'npm install foo@next-18',
      // A range whose first alternative is concrete but later includes an
      // unbounded wildcard is still non-concrete: validating only the first
      // character would let the mutable `*` be written into the manifest.
      'npm install "foo@^1.0.0 || *"',
      'npm install "foo@1.2.3 || x"',
      'npm install "foo@>=1.0.0 || latest"',
      // Trailing/empty alternatives are not concrete either.
      'npm install "foo@1.2.3 ||"',
    ]) {
      expect(runDependencyUpdate(runner, CONFIG(), cmd, tmpDir, artifactDir))
        .toEqual({ handled: false, reason: 'non-concrete-version' });
    }
    // The dist-tag was never written into the manifest, and no command ran.
    expect(runner.calls).toHaveLength(0);
    expect(readManifest()).toEqual({ name: 'p' });
  });

  test('unsupported-flag (--no-save / --global) hands off without editing the manifest', () => {
    writeManifest({ name: 'p' });
    const runner = sequenceRunner([]);
    expect(runDependencyUpdate(runner, CONFIG(), 'npm install --no-save foo@1.0.0', tmpDir, artifactDir))
      .toEqual({ handled: false, reason: 'unsupported-flag' });
    expect(runDependencyUpdate(runner, CONFIG(), 'npm install --global foo@1.0.0', tmpDir, artifactDir))
      .toEqual({ handled: false, reason: 'unsupported-flag' });
    // No command ran and the manifest was never touched.
    expect(runner.calls).toHaveLength(0);
    expect(readManifest()).toEqual({ name: 'p' });
  });

  test('unsupported-flag (--save=false / --location=global equivalents) hands off without editing the manifest', () => {
    writeManifest({ name: 'p' });
    const runner = sequenceRunner([]);
    expect(runDependencyUpdate(runner, CONFIG(), 'npm install --save=false foo@1.0.0', tmpDir, artifactDir))
      .toEqual({ handled: false, reason: 'unsupported-flag' });
    expect(runDependencyUpdate(runner, CONFIG(), 'npm install --location=global foo@1.0.0', tmpDir, artifactDir))
      .toEqual({ handled: false, reason: 'unsupported-flag' });
    // No command ran and the manifest was never touched.
    expect(runner.calls).toHaveLength(0);
    expect(readManifest()).toEqual({ name: 'p' });
  });

  test('unsupported-flag (workspace/prefix target) hands off without editing the root manifest', () => {
    writeManifest({ name: 'p' });
    const runner = sequenceRunner([]);
    expect(runDependencyUpdate(runner, CONFIG(), 'npm install --workspace=packages/app foo@1.0.0', tmpDir, artifactDir))
      .toEqual({ handled: false, reason: 'unsupported-flag' });
    expect(runDependencyUpdate(runner, CONFIG(), 'npm install --prefix=packages/app foo@1.0.0', tmpDir, artifactDir))
      .toEqual({ handled: false, reason: 'unsupported-flag' });
    expect(runDependencyUpdate(runner, CONFIG(), 'npm install -w packages/app foo@1.0.0', tmpDir, artifactDir))
      .toEqual({ handled: false, reason: 'unsupported-flag' });
    // The root manifest must not gain the workspace-targeted dependency.
    expect(runner.calls).toHaveLength(0);
    expect(readManifest()).toEqual({ name: 'p' });
  });
});
