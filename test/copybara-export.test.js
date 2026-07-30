import {
  parseJavaMajorVersion,
  checkJavaVersion,
  sha256File,
  loadPin,
  verifyPin,
  capturePin,
  renderConfig,
  prepareOriginRepo,
  prepareDestinationRepo,
  checkoutDestinationForValidation,
  buildMigrateArgs,
  revResolvesInRepo,
  revIsAncestor,
  runExport,
  defaultRunner,
  main,
  MIN_JAVA_MAJOR_VERSION,
} from '../scripts/copybara-export.mjs';
import { jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'copybara-export-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
}

function initRepo(dir, { withCommit = true } = {}) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  if (withCommit) {
    writeFileSync(join(dir, 'README.md'), '# repo\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'initial'], dir);
  }
  return dir;
}

/**
 * Simulate what a real `java -jar ... migrate` invocation does to the
 * destination: push one commit into the **bare** destination repo, the way
 * `git.destination` actually writes (never by editing files directly inside
 * a checked-out worktree, which the bare receive target does not have).
 */
function pushSnapshotCommit(destBareDir, branch, mutate) {
  const scratch = mkdtempSync(join(tmpdir(), 'copybara-push-sim-'));
  execFileSync('git', ['clone', '--quiet', destBareDir, scratch], { encoding: 'utf8' });
  // -B creates the branch if the clone left HEAD unborn (empty bare repo) or
  // resets it in place if it already exists (populated baseline) — safe
  // either way for a scratch clone with no local changes to lose.
  git(['checkout', '-q', '-B', branch], scratch);
  mutate(scratch);
  git(['add', '-A'], scratch);
  git(['commit', '-q', '-m', 'Public snapshot export'], scratch);
  git(['push', '-q', destBareDir, `${branch}:${branch}`], scratch);
  rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// parseJavaMajorVersion
// ---------------------------------------------------------------------------

describe('parseJavaMajorVersion', () => {
  test('parses modern version scheme', () => {
    expect(parseJavaMajorVersion('openjdk version "21.0.3" 2024-04-16')).toBe(21);
  });

  test('parses legacy 1.x version scheme', () => {
    expect(parseJavaMajorVersion('java version "1.8.0_401"')).toBe(8);
  });

  test('returns null for unparseable output', () => {
    expect(parseJavaMajorVersion('command not found')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkJavaVersion
// ---------------------------------------------------------------------------

describe('checkJavaVersion', () => {
  function stubRunner(result) {
    return { run: () => result };
  }

  test('ok:true when the version meets the minimum', () => {
    const runner = stubRunner({ stdout: '', stderr: 'openjdk version "21.0.3" 2024-04-16', exitCode: 0 });
    const check = checkJavaVersion(runner);
    expect(check).toEqual({ ok: true, major: 21, reason: null, raw: expect.any(String) });
  });

  test('ok:false when the version is below the minimum', () => {
    const runner = stubRunner({ stdout: '', stderr: 'openjdk version "17.0.1" 2023-01-01', exitCode: 0 });
    const check = checkJavaVersion(runner, MIN_JAVA_MAJOR_VERSION);
    expect(check.ok).toBe(false);
    expect(check.major).toBe(17);
    expect(check.reason).toMatch(/17.*21/);
  });

  test('ok:false when java is not on PATH', () => {
    const runner = stubRunner({ stdout: '', stderr: 'java: command not found', exitCode: 127 });
    const check = checkJavaVersion(runner);
    expect(check.ok).toBe(false);
    expect(check.major).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sha256File
// ---------------------------------------------------------------------------

describe('sha256File', () => {
  test('matches an independently computed sha256', () => {
    const file = join(tmpDir, 'a.bin');
    writeFileSync(file, 'hello world');
    const expected = createHash('sha256').update('hello world').digest('hex');
    expect(sha256File(file)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// loadPin / verifyPin / capturePin
// ---------------------------------------------------------------------------

describe('loadPin', () => {
  test('parses a well-formed pin file', () => {
    const pinPath = join(tmpDir, 'PIN.json');
    writeFileSync(pinPath, JSON.stringify({ release: 'v1', jarSha256: 'abc', javaMinVersion: 21 }));
    expect(loadPin(pinPath)).toEqual({ release: 'v1', jarSha256: 'abc', javaMinVersion: 21 });
  });

  test('throws on a pin file missing a required field', () => {
    const pinPath = join(tmpDir, 'PIN.json');
    writeFileSync(pinPath, JSON.stringify({ release: 'v1', jarSha256: 'abc' }));
    expect(() => loadPin(pinPath)).toThrow(/javaMinVersion/);
  });
});

describe('verifyPin', () => {
  test('fails closed on an unpopulated (null) pin', () => {
    const result = verifyPin({ release: null, jarSha256: null }, join(tmpDir, 'nonexistent.jar'));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not populated/);
  });

  test('fails closed when the jar file does not exist', () => {
    const result = verifyPin({ release: 'v1', jarSha256: 'deadbeef' }, join(tmpDir, 'missing.jar'));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not found/);
  });

  test('fails closed on a checksum mismatch', () => {
    const jarPath = join(tmpDir, 'copybara.jar');
    writeFileSync(jarPath, 'not-really-a-jar');
    const result = verifyPin({ release: 'v1', jarSha256: 'deadbeef' }, jarPath);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/checksum mismatch/);
  });

  test('ok:true when the checksum matches', () => {
    const jarPath = join(tmpDir, 'copybara.jar');
    writeFileSync(jarPath, 'not-really-a-jar');
    const expected = sha256File(jarPath);
    const result = verifyPin({ release: 'v1', jarSha256: expected }, jarPath);
    expect(result).toEqual({ ok: true, reason: null });
  });
});

describe('capturePin', () => {
  test('captures the sha256 of a given jar under the given release name', () => {
    const jarPath = join(tmpDir, 'copybara.jar');
    writeFileSync(jarPath, 'jar-bytes');
    const pin = capturePin({ release: 'copybara-20260101', jarPath });
    expect(pin.release).toBe('copybara-20260101');
    expect(pin.jarSha256).toBe(sha256File(jarPath));
    expect(pin.javaMinVersion).toBe(MIN_JAVA_MAJOR_VERSION);
  });
});

// ---------------------------------------------------------------------------
// renderConfig
// ---------------------------------------------------------------------------

describe('renderConfig', () => {
  test('substitutes every placeholder token', () => {
    const template = join(tmpDir, 'copy.bara.sky');
    writeFileSync(template, 'origin = "__ORIGIN__"\ndest = "__DEST__"\n');
    const rendered = renderConfig(template, { ORIGIN: 'file:///a', DEST: 'file:///b' });
    expect(rendered).toBe('origin = "file:///a"\ndest = "file:///b"\n');
  });

  test('throws when a placeholder is left unsubstituted', () => {
    const template = join(tmpDir, 'copy.bara.sky');
    writeFileSync(template, 'origin = "__ORIGIN__"\ndest = "__DEST__"\n');
    expect(() => renderConfig(template, { ORIGIN: 'file:///a' })).toThrow(/__DEST__/);
  });
});

// ---------------------------------------------------------------------------
// prepareOriginRepo / prepareDestinationRepo — real git fixtures
// ---------------------------------------------------------------------------

describe('prepareOriginRepo', () => {
  test('clones the source repo and resolves the checked-out revision', () => {
    const source = initRepo(join(tmpDir, 'source'));
    const originDir = join(tmpDir, 'origin');
    const { dir, resolvedRev } = prepareOriginRepo({ sourceRepoPath: source, originDir });
    expect(dir).toBe(originDir);
    expect(resolvedRev).toBe(git(['rev-parse', 'HEAD'], source).trim());
  });

  test('checks out a specific rev when given a second commit', () => {
    const source = initRepo(join(tmpDir, 'source'));
    const firstRev = git(['rev-parse', 'HEAD'], source).trim();
    writeFileSync(join(source, 'b.txt'), 'b\n');
    git(['add', '-A'], source);
    git(['commit', '-q', '-m', 'second'], source);

    const originDir = join(tmpDir, 'origin');
    const { resolvedRev } = prepareOriginRepo({ sourceRepoPath: source, rev: firstRev, originDir });
    expect(resolvedRev).toBe(firstRev);
  });
});

describe('prepareDestinationRepo', () => {
  test('creates an empty bare repo when no baseline is given', () => {
    const destDir = join(tmpDir, 'dest');
    prepareDestinationRepo({ baselinePath: null, destDir });
    expect(git(['rev-parse', '--is-bare-repository'], destDir).trim()).toBe('true');
    let error;
    try {
      execFileSync('git', ['log', '--oneline'], { cwd: destDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(String(error.stderr)).toMatch(/does not have any commits yet|unknown revision/);
  });

  test('rejects a push to a non-bare destination (regression guard for denyCurrentBranch)', () => {
    // A real Copybara migration pushes over file://; a non-bare destination
    // with `main` checked out rejects that push by default. This pins the
    // reason prepareDestinationRepo must create a bare repo.
    const nonBareDest = initRepo(join(tmpDir, 'non-bare-dest'));
    // Clone (rather than initRepo a second independent history) so the push
    // below is a guaranteed fast-forward: this isolates the denyCurrentBranch
    // rejection from an unrelated-histories rejection, which would otherwise
    // also print "rejected" but for a different reason.
    const scratch = join(tmpDir, 'pusher');
    execFileSync('git', ['clone', '--quiet', nonBareDest, scratch], { encoding: 'utf8' });
    git(['commit', '--allow-empty', '-q', '-m', 'second'], scratch);
    let error;
    try {
      git(['push', '-q', nonBareDest, 'main:main'], scratch);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(String(error.stderr)).toMatch(/rejected/i);
    expect(String(error.stderr)).toMatch(/checked out branch|current branch/i);
  });

  test('preserves the baseline repo unrelated root history without a force-push', () => {
    const baseline = initRepo(join(tmpDir, 'baseline'));
    git(['commit', '--allow-empty', '-q', '-m', 'baseline second commit'], baseline);
    const baselineLog = git(['log', '--format=%H'], baseline).trim().split('\n');

    const destDir = join(tmpDir, 'dest');
    prepareDestinationRepo({ baselinePath: baseline, destDir });
    expect(git(['rev-parse', '--is-bare-repository'], destDir).trim()).toBe('true');
    const destLog = git(['log', '--format=%H'], destDir).trim().split('\n');
    expect(destLog).toEqual(baselineLog);
  });
});

describe('checkoutDestinationForValidation', () => {
  test('clones the pushed branch out of a bare destination into a working tree', () => {
    const destDir = join(tmpDir, 'dest');
    prepareDestinationRepo({ baselinePath: null, destDir });
    pushSnapshotCommit(destDir, 'main', (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hello\n');
    });

    const checkoutDir = join(tmpDir, 'dest-checkout');
    const { dir } = checkoutDestinationForValidation({ destDir, branch: 'main', checkoutDir });
    expect(dir).toBe(checkoutDir);
    expect(git(['rev-parse', '--is-bare-repository'], checkoutDir).trim()).toBe('false');
    expect(readFileSync(join(checkoutDir, 'exported.txt'), 'utf8')).toBe('hello\n');
  });
});

// ---------------------------------------------------------------------------
// buildMigrateArgs
// ---------------------------------------------------------------------------

describe('buildMigrateArgs', () => {
  test('builds the java -jar migrate invocation', () => {
    expect(buildMigrateArgs({ jarPath: '/tmp/copybara.jar', configPath: '/tmp/copy.bara.sky', workflowName: 'wf' }))
      .toEqual(['-jar', '/tmp/copybara.jar', 'migrate', '/tmp/copy.bara.sky', 'wf']);
  });

  test('appends extraArgs (issue #800 baseline flags) after the workflow name', () => {
    expect(
      buildMigrateArgs({ jarPath: '/tmp/copybara.jar', configPath: '/tmp/copy.bara.sky', workflowName: 'wf', extraArgs: ['--init-history'] })
    ).toEqual(['-jar', '/tmp/copybara.jar', 'migrate', '/tmp/copy.bara.sky', 'wf', '--init-history']);
  });
});

// ---------------------------------------------------------------------------
// revResolvesInRepo
// ---------------------------------------------------------------------------

describe('revResolvesInRepo', () => {
  test('true for a commit reachable in the repo, false for an unknown sha', () => {
    const repo = initRepo(join(tmpDir, 'resolve-check'));
    const head = git(['rev-parse', 'HEAD'], repo).trim();
    expect(revResolvesInRepo(defaultRunner, repo, head)).toBe(true);
    expect(revResolvesInRepo(defaultRunner, repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// revIsAncestor (issue #800 P2) — a rev that merely EXISTS in the repo (e.g.
// reachable only via an unrelated divergent branch after a force-push) must
// not be accepted as a valid prior baseline; it has to be an actual ancestor.
// ---------------------------------------------------------------------------

describe('revIsAncestor', () => {
  test('true when the rev is an actual ancestor, false for a divergent commit that merely exists', () => {
    const repo = initRepo(join(tmpDir, 'ancestor-check'));
    const base = git(['rev-parse', 'HEAD'], repo).trim();
    git(['checkout', '-q', '-b', 'feature'], repo);
    writeFileSync(join(repo, 'feature.txt'), 'x\n');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'feature commit'], repo);
    const divergentRev = git(['rev-parse', 'HEAD'], repo).trim();
    git(['checkout', '-q', 'main'], repo);
    writeFileSync(join(repo, 'main2.txt'), 'y\n');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'main commit'], repo);
    const mainRev = git(['rev-parse', 'HEAD'], repo).trim();

    expect(revIsAncestor(defaultRunner, repo, base, mainRev)).toBe(true);
    expect(revIsAncestor(defaultRunner, repo, divergentRev, mainRev)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runExport — orchestration, fail-closed at every stage
// ---------------------------------------------------------------------------

function makeJavaStubRunner({ javaVersion = 'openjdk version "21.0.3"', migrateExitCode = 0, migrateStderr = '', destBranch = 'main' }) {
  return {
    run(cmd, args, opts) {
      if (cmd === 'java' && args[0] === '-version') {
        return { stdout: '', stderr: javaVersion, exitCode: 0 };
      }
      if (cmd === 'java' && args[0] === '-jar') {
        if (migrateExitCode === 0) {
          // Simulate the real jar's git.destination push: one commit landed
          // in the bare destination repo, not files written on disk there.
          pushSnapshotCommit(join(opts.cwd, 'destination'), destBranch, (scratch) => {
            writeFileSync(join(scratch, 'exported.txt'), 'hello\n');
          });
        }
        return { stdout: '', stderr: migrateStderr, exitCode: migrateExitCode };
      }
      return defaultRunner.run(cmd, args, opts);
    },
  };
}

describe('runExport', () => {
  function baseOpts(overrides = {}) {
    const source = initRepo(join(tmpDir, 'source'));
    const jarPath = join(tmpDir, 'copybara.jar');
    writeFileSync(jarPath, 'jar-bytes');
    const pinPath = join(tmpDir, 'PIN.json');
    writeFileSync(pinPath, JSON.stringify({ release: 'v1', jarSha256: sha256File(jarPath), javaMinVersion: 21 }));
    const configTemplate = join(tmpDir, 'copy.bara.sky');
    writeFileSync(
      configTemplate,
      'origin = "__COPYBARA_ORIGIN_URL__"\nref = "__COPYBARA_ORIGIN_REF__"\ndest = "__COPYBARA_DEST_URL__"\nbranch = "__COPYBARA_DEST_REF__"\n'
    );
    return {
      sourceRepoPath: source,
      workdir: join(tmpDir, 'work'),
      jarPath,
      pinPath,
      configTemplate,
      ...overrides,
    };
  }

  test('fails closed at the java stage when Java is too old', () => {
    const runner = makeJavaStubRunner({ javaVersion: 'openjdk version "17.0.1"' });
    const result = runExport(baseOpts(), runner);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('java');
  });

  test('fails closed at the pin stage on an unpopulated pin', () => {
    const opts = baseOpts();
    writeFileSync(opts.pinPath, JSON.stringify({ release: null, jarSha256: null, javaMinVersion: 21 }));
    const runner = makeJavaStubRunner({});
    const result = runExport(opts, runner);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('pin');
  });

  test('fails closed at the migrate stage when the jar invocation exits nonzero', () => {
    const runner = makeJavaStubRunner({ migrateExitCode: 1, migrateStderr: 'boom' });
    const result = runExport(baseOpts(), runner);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('migrate');
    expect(result.reason).toMatch(/boom/);
  });

  test('fails closed at the validate stage when the transformed tree has a leak', () => {
    const opts = baseOpts();
    const runner = {
      run(cmd, args, rOpts) {
        if (cmd === 'java' && args[0] === '-version') return { stdout: '', stderr: 'openjdk version "21.0.3"', exitCode: 0 };
        if (cmd === 'java' && args[0] === '-jar') {
          // Simulate Copybara having pushed an unsafe file into the bare
          // destination repo (a real migrate invocation pushes commits, it
          // never writes files directly into a non-bare worktree there).
          pushSnapshotCommit(join(rOpts.cwd, 'destination'), 'main', (scratch) => {
            writeFileSync(join(scratch, 'leaked.md'), 'built at /Users/alice/repo\n');
          });
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return defaultRunner.run(cmd, args, rOpts);
      },
    };
    const result = runExport(opts, runner);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('validate');
    expect(result.findings.length).toBeGreaterThan(0);
  });

  test('succeeds end-to-end when every stage is clean', () => {
    const runner = makeJavaStubRunner({});
    const result = runExport(baseOpts(), runner);
    expect(result.ok).toBe(true);
    expect(result.javaMajor).toBe(21);
    expect(result.pinRelease).toBe('v1');
    expect(git(['rev-parse', '--is-bare-repository'], result.destDir).trim()).toBe('true');
    expect(readFileSync(join(result.destCheckoutDir, 'exported.txt'), 'utf8')).toBe('hello\n');
  });

  test('--init-history renders as a migrate flag and is recorded in the baseline result', () => {
    let capturedArgs = null;
    const stub = makeJavaStubRunner({});
    const runner = {
      run(cmd, args, rOpts) {
        if (cmd === 'java' && args[0] === '-jar') capturedArgs = args;
        return stub.run(cmd, args, rOpts);
      },
    };
    const result = runExport({ ...baseOpts(), initHistory: true }, runner);
    expect(result.ok).toBe(true);
    expect(result.baseline).toEqual({ mode: 'init-history' });
    expect(capturedArgs).toContain('--init-history');
  });

  test('--last-rev resolving in the origin repo renders as a migrate flag and is recorded in the baseline result', () => {
    const opts = baseOpts();
    const priorRev = git(['rev-parse', 'HEAD'], opts.sourceRepoPath).trim();
    let capturedArgs = null;
    const stub = makeJavaStubRunner({});
    const runner = {
      run(cmd, args, rOpts) {
        if (cmd === 'java' && args[0] === '-jar') capturedArgs = args;
        return stub.run(cmd, args, rOpts);
      },
    };
    const result = runExport({ ...opts, lastRev: priorRev }, runner);
    expect(result.ok).toBe(true);
    expect(result.baseline).toEqual({ mode: 'last-rev', lastRev: priorRev, resolved: true });
    expect(capturedArgs).toEqual(expect.arrayContaining(['--last-rev', priorRev]));
  });

  test('fails closed at the baseline stage on an unresolved --last-rev, without invoking migrate', () => {
    const opts = baseOpts();
    let jarInvoked = false;
    const stub = makeJavaStubRunner({});
    const runner = {
      run(cmd, args, rOpts) {
        if (cmd === 'java' && args[0] === '-jar') jarInvoked = true;
        return stub.run(cmd, args, rOpts);
      },
    };
    const result = runExport({ ...opts, lastRev: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }, runner);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('baseline');
    expect(result.reason).toMatch(/does not resolve/);
    expect(result.reason).toMatch(/Do not retry with --force/);
    expect(jarInvoked).toBe(false);
  });

  test('fails closed at the baseline stage on a --last-rev that resolves but is not an ancestor of the resolved source revision (issue #800 P2)', () => {
    const opts = baseOpts();
    const source = opts.sourceRepoPath;
    git(['checkout', '-q', '-b', 'feature'], source);
    writeFileSync(join(source, 'feature.txt'), 'x\n');
    git(['add', '-A'], source);
    git(['commit', '-q', '-m', 'feature commit'], source);
    const divergentRev = git(['rev-parse', 'HEAD'], source).trim();
    git(['checkout', '-q', 'main'], source);
    writeFileSync(join(source, 'main2.txt'), 'y\n');
    git(['add', '-A'], source);
    git(['commit', '-q', '-m', 'main commit'], source);

    let jarInvoked = false;
    const stub = makeJavaStubRunner({});
    const runner = {
      run(cmd, args, rOpts) {
        if (cmd === 'java' && args[0] === '-jar') jarInvoked = true;
        return stub.run(cmd, args, rOpts);
      },
    };
    const result = runExport({ ...opts, lastRev: divergentRev }, runner);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('baseline');
    expect(result.reason).toMatch(/not an ancestor/);
    expect(result.reason).toMatch(/Do not retry with --force/);
    expect(jarInvoked).toBe(false);
  });

  test('fails closed at the baseline stage when --init-history and --last-rev are both given', () => {
    const opts = baseOpts();
    const runner = makeJavaStubRunner({});
    const result = runExport({ ...opts, initHistory: true, lastRev: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }, runner);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('baseline');
    expect(result.reason).toMatch(/mutually exclusive/);
  });

  test('fails closed at the java stage when the pin requires a newer Java than MIN_JAVA_MAJOR_VERSION', () => {
    const opts = baseOpts();
    writeFileSync(opts.pinPath, JSON.stringify({ release: 'v1', jarSha256: sha256File(opts.jarPath), javaMinVersion: 99 }));
    const runner = makeJavaStubRunner({ javaVersion: 'openjdk version "21.0.3"' });
    const result = runExport(opts, runner);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('java');
    expect(result.reason).toMatch(/21.*99/);
  });

  test('two successive runs against the same baseline both stay bounded (no unrelated-root reset)', () => {
    const source = initRepo(join(tmpDir, 'source'));
    const jarPath = join(tmpDir, 'copybara.jar');
    writeFileSync(jarPath, 'jar-bytes');
    const pinPath = join(tmpDir, 'PIN.json');
    writeFileSync(pinPath, JSON.stringify({ release: 'v1', jarSha256: sha256File(jarPath), javaMinVersion: 21 }));
    const configTemplate = join(tmpDir, 'copy.bara.sky');
    writeFileSync(configTemplate, 'origin = "__COPYBARA_ORIGIN_URL__"\ndest = "__COPYBARA_DEST_URL__"\n');

    // The real jar is unavailable in this sandbox (see
    // docs/copybara-export-poc.md#limitations), so this stub pushes a
    // snapshot commit into the bare destination repo on every "-jar migrate"
    // invocation, standing in for the single SQUASH commit the real Copybara
    // jar would push, to exercise the wrapper's baseline-chaining behavior.
    let snapshotCounter = 0;
    function makeSquashSimulatingRunner(workdir) {
      return {
        run(cmd, args, opts) {
          if (cmd === 'java' && args[0] === '-version') return { stdout: '', stderr: 'openjdk version "21.0.3"', exitCode: 0 };
          if (cmd === 'java' && args[0] === '-jar') {
            const destDir = join(workdir, 'destination');
            snapshotCounter += 1;
            pushSnapshotCommit(destDir, 'main', (scratch) => {
              writeFileSync(join(scratch, 'snapshot.txt'), `exported #${snapshotCounter}\n`);
            });
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          return defaultRunner.run(cmd, args, opts);
        },
      };
    }

    const workdir1 = join(tmpDir, 'work1');
    const firstResult = runExport(
      { sourceRepoPath: source, workdir: workdir1, jarPath, pinPath, configTemplate },
      makeSquashSimulatingRunner(workdir1)
    );
    expect(firstResult.ok).toBe(true);
    const firstDestRev = git(['rev-parse', 'HEAD'], firstResult.destDir).trim();

    // Second run uses the first run's destination as the new baseline —
    // this models "re-running from a newer source revision" bounded on the
    // previous export rather than starting a new unrelated root history.
    writeFileSync(join(source, 'c.txt'), 'c\n');
    git(['add', '-A'], source);
    git(['commit', '-q', '-m', 'second'], source);

    const workdir2 = join(tmpDir, 'work2');
    const secondResult = runExport(
      { sourceRepoPath: source, workdir: workdir2, baselinePath: firstResult.destDir, jarPath, pinPath, configTemplate },
      makeSquashSimulatingRunner(workdir2)
    );
    expect(secondResult.ok).toBe(true);
    expect(secondResult.sourceRev).not.toBe(firstResult.sourceRev);

    const destLog = git(['log', '--format=%H'], secondResult.destDir).trim().split('\n');
    // The baseline's own commit must still be an ancestor — a bounded
    // update landed on top of it, not a fresh orphan history.
    expect(destLog).toContain(firstDestRev);
    expect(destLog.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// main — CLI
// ---------------------------------------------------------------------------

describe('main', () => {
  test('returns 2 and prints usage when required args are missing', () => {
    expect(main([])).toBe(2);
  });

  test('issue #800 P2: returns 2 and does not run the export when --last-rev is given no value', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = main(['--source-repo', '/tmp/whatever', '--jar', '/tmp/whatever.jar', '--last-rev']);
      expect(code).toBe(2);
      expect(errorSpy.mock.calls.some((c) => /--last-rev.*requires a value/.test(c.join(' ')))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
