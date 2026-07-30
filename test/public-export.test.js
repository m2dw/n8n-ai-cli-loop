import { jest } from '@jest/globals';
import {
  DEFAULT_BRANCH,
  DEFAULT_PR_BASE,
  buildPrBody,
  buildPrTitle,
  checkSyncBranchMergedViaPr,
  ensurePullRequest,
  extractBaselineLine,
  main,
  parseArgs,
  parseGithubRepoSlug,
  readExistingPrBody,
  readRemoteBranchOriginRevId,
  recoverBaselineFromMergedPr,
  redactCredentialsInText,
  resolveRemoteRevision,
  runPublicExport,
  validateOpts,
} from '../scripts/public-export.mjs';
import { defaultRunner, sha256File } from '../scripts/copybara-export.mjs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'public-export-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
}

function initRepo(dir, { bare = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const args = ['init', '-q', '-b', 'main'];
  if (bare) args.push('--bare');
  execFileSync('git', [...args, dir]);
  if (!bare) {
    writeFileSync(join(dir, 'README.md'), '# repo\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'initial'], dir);
  }
  return dir;
}

function fileUrl(path) {
  return `file://${path}`;
}

/** Simulate a real `migrate` invocation pushing one SQUASH commit, with a
 * GitOrigin-RevId trailer, into the bare destination repo. */
function pushSquashCommit(destBareDir, branch, sourceRev, mutate) {
  const scratch = mkdtempSync(join(tmpdir(), 'public-export-push-sim-'));
  execFileSync('git', ['clone', '--quiet', destBareDir, scratch], { encoding: 'utf8' });
  git(['checkout', '-q', '-B', branch], scratch);
  mutate(scratch);
  git(['add', '-A'], scratch);
  git(['commit', '-q', '-m', `Public snapshot export\n\nGitOrigin-RevId: ${sourceRev}\n`], scratch);
  // --force: mirrors the real migrate step (scripts/public-export.mjs's own
  // `git push --force`), which always pushes a fresh squash commit — never
  // one built on top of the branch's previous tip. Without --force here, a
  // second simulated squash commit onto a branch this helper already pushed
  // once (e.g. re-using "copybara/public-sync" after an intervening,
  // unrelated push to "main" — see the issue #800 P1 review fix (second
  // pass) test) is rejected as non-fast-forward, even though that is exactly
  // what a real repeat export does.
  git(['push', '-q', '--force', destBareDir, `${branch}:${branch}`], scratch);
  rmSync(scratch, { recursive: true, force: true });
}

function makeJarAndPin(dir, { jarBytes = 'jar-bytes', javaMinVersion = 21 } = {}) {
  const jarPath = join(dir, 'copybara.jar');
  writeFileSync(jarPath, jarBytes);
  const pinPath = join(dir, 'PIN.json');
  writeFileSync(pinPath, JSON.stringify({ release: 'v1', jarSha256: sha256File(jarPath), downloadUrl: null, javaMinVersion }));
  return { jarPath, pinPath };
}

function makeConfigTemplate(dir) {
  const configTemplate = join(dir, 'copy.bara.sky');
  writeFileSync(
    configTemplate,
    [
      'origin = "__COPYBARA_ORIGIN_URL__"',
      'ref = "__COPYBARA_ORIGIN_REF__"',
      'dest = "__COPYBARA_DEST_URL__"',
      'branch = "__COPYBARA_DEST_REF__"',
    ].join('\n') + '\n'
  );
  return configTemplate;
}

function makeRunner({ javaVersion = 'openjdk version "21.0.3"', migrateExitCode = 0, migrateStderr = '', forcePushExitCode = null, ghHandler } = {}) {
  return {
    run(cmd, args, opts = {}) {
      if (cmd === 'java' && args[0] === '-version') {
        return { stdout: '', stderr: javaVersion, exitCode: 0 };
      }
      if (cmd === 'java' && args[0] === '-jar') {
        if (migrateExitCode === 0) {
          const originDir = join(opts.cwd, 'origin');
          const sourceRev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: originDir, encoding: 'utf8' }).trim();
          // Vary the simulated migrate output by sourceRev so a re-export
          // still produces a genuinely new commit even when the destination
          // already carries identical content from a prior simulated push
          // (e.g. a prior sync PR already merged the same 'hello' content
          // into --pr-base) — matching a real transform, whose output tracks
          // the source revision it was run against.
          pushSquashCommit(join(opts.cwd, 'destination'), 'main', sourceRev, (scratch) => {
            writeFileSync(join(scratch, 'exported.txt'), `hello ${sourceRev}\n`);
          });
        }
        return { stdout: '', stderr: migrateStderr, exitCode: migrateExitCode };
      }
      if (cmd === 'git' && args[0] === 'push' && args.includes('--force') && forcePushExitCode !== null) {
        return { stdout: '', stderr: 'simulated push failure', exitCode: forcePushExitCode };
      }
      if (cmd === 'gh') {
        return ghHandler ? ghHandler(args) : { stdout: '', stderr: 'gh not stubbed in this test', exitCode: 1 };
      }
      return defaultRunner.run(cmd, args, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// parseArgs — unknown options fail closed
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('fails closed on an unknown option', () => {
    const result = parseArgs(['--dry-run-typo']);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unknown option/);
  });

  test('a misspelled --dry-run cannot set --publish (fails closed instead of being ignored)', () => {
    const result = parseArgs(['--dryrun', '--private-remote', 'x', '--public-remote', 'y']);
    expect(result.ok).toBe(false);
    expect(result.opts).toBeUndefined();
  });

  test('fails closed when a value-taking option is missing its value', () => {
    const result = parseArgs(['--private-remote']);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/requires a value/);
  });

  test('defaults rev/branch/pr-base when not given', () => {
    const result = parseArgs(['--private-remote', 'a', '--public-remote', 'b']);
    expect(result.ok).toBe(true);
    expect(result.opts.rev).toBe('main');
    expect(result.opts.branch).toBe(DEFAULT_BRANCH);
    expect(result.opts.prBase).toBe(DEFAULT_PR_BASE);
  });

  test('parses --publish and --yes as flags', () => {
    const result = parseArgs(['--private-remote', 'a', '--public-remote', 'b', '--publish', '--yes']);
    expect(result.opts.publish).toBe(true);
    expect(result.opts.yes).toBe(true);
  });

  test('parses --init-history as a flag and --last-rev as a value option', () => {
    const result = parseArgs(['--private-remote', 'a', '--public-remote', 'b', '--init-history', '--last-rev', 'abc123']);
    expect(result.opts.initHistory).toBe(true);
    expect(result.opts.lastRev).toBe('abc123');
  });
});

// ---------------------------------------------------------------------------
// validateOpts — publication requires an explicit flag AND confirmation,
// and never targets the public repo's own default branch.
// ---------------------------------------------------------------------------

describe('validateOpts', () => {
  function baseOpts(overrides = {}) {
    return { privateRemote: 'a', publicRemote: 'b', rev: 'main', branch: DEFAULT_BRANCH, prBase: 'main', ...overrides };
  }

  test('requires --private-remote', () => {
    const result = validateOpts({ publicRemote: 'b' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/--private-remote/);
  });

  test('requires --public-remote', () => {
    const result = validateOpts({ privateRemote: 'a' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/--public-remote/);
  });

  test('rejects --dry-run combined with --publish', () => {
    const result = validateOpts(baseOpts({ dryRun: true, publish: true, yes: true }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mutually exclusive/);
  });

  test('rejects --publish without --yes', () => {
    const result = validateOpts(baseOpts({ publish: true }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/--yes/);
  });

  test('rejects --yes without --publish', () => {
    const result = validateOpts(baseOpts({ yes: true }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/--publish/);
  });

  test('rejects a --branch equal to --pr-base', () => {
    const result = validateOpts(baseOpts({ branch: 'main', prBase: 'main', publish: true, yes: true }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/default branch/);
  });

  test('rejects --branch master even when --pr-base differs', () => {
    const result = validateOpts(baseOpts({ branch: 'master', prBase: 'main', publish: true, yes: true }));
    expect(result.ok).toBe(false);
  });

  test('accepts a well-formed dry-run request', () => {
    expect(validateOpts(baseOpts()).ok).toBe(true);
  });

  test('accepts a well-formed publish request', () => {
    expect(validateOpts(baseOpts({ publish: true, yes: true })).ok).toBe(true);
  });

  test('rejects --init-history combined with --last-rev', () => {
    const result = validateOpts(baseOpts({ initHistory: true, lastRev: 'abc123' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mutually exclusive/);
  });

  test('accepts --init-history alone', () => {
    expect(validateOpts(baseOpts({ initHistory: true })).ok).toBe(true);
  });

  test('accepts --last-rev alone', () => {
    expect(validateOpts(baseOpts({ lastRev: 'abc123' })).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveRemoteRevision — resolves the remote's actual branch tip, not a
// local working tree.
// ---------------------------------------------------------------------------

describe('resolveRemoteRevision', () => {
  test('resolves a branch name to the remote HEAD sha via ls-remote', () => {
    const repo = initRepo(join(tmpDir, 'repo'));
    const expected = git(['rev-parse', 'HEAD'], repo).trim();
    const resolved = resolveRemoteRevision({ remoteUrl: fileUrl(repo), rev: 'main' });
    expect(resolved).toBe(expected);
  });

  test('passes a full 40-char sha through unchanged without contacting the remote', () => {
    const sha = 'a'.repeat(40);
    const runner = { run: () => { throw new Error('should not be called'); } };
    expect(resolveRemoteRevision({ remoteUrl: 'file:///nonexistent', rev: sha }, runner)).toBe(sha);
  });

  test('returns null when the branch does not exist on the remote', () => {
    const repo = initRepo(join(tmpDir, 'repo'));
    expect(resolveRemoteRevision({ remoteUrl: fileUrl(repo), rev: 'does-not-exist' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readRemoteBranchOriginRevId
// ---------------------------------------------------------------------------

describe('readRemoteBranchOriginRevId', () => {
  test('returns exists:false when the branch does not exist yet', () => {
    const bare = initRepo(join(tmpDir, 'bare'), { bare: true });
    const result = readRemoteBranchOriginRevId({
      remoteUrl: fileUrl(bare),
      branch: 'copybara/public-sync',
      scratchDir: join(tmpDir, 'scratch'),
    });
    expect(result).toEqual({ exists: false, sourceRev: null, headSha: null });
  });

  test('extracts the GitOrigin-RevId trailer and head SHA off the branch tip', () => {
    const bare = initRepo(join(tmpDir, 'bare'), { bare: true });
    pushSquashCommit(bare, 'copybara/public-sync', 'deadbeef1234', (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hi\n');
    });
    const expectedSha = git(['rev-parse', 'refs/heads/copybara/public-sync'], bare).trim();
    const result = readRemoteBranchOriginRevId({
      remoteUrl: fileUrl(bare),
      branch: 'copybara/public-sync',
      scratchDir: join(tmpDir, 'scratch'),
    });
    expect(result).toEqual({ exists: true, sourceRev: 'deadbeef1234', headSha: expectedSha });
  });
});

// ---------------------------------------------------------------------------
// checkSyncBranchMergedViaPr (issue #800 P1 review fix)
// ---------------------------------------------------------------------------

describe('checkSyncBranchMergedViaPr', () => {
  function ghListRunner(handler) {
    return {
      run(cmd, args) {
        if (cmd === 'gh' && args[1] === 'list') return handler(args);
        throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
      },
    };
  }

  test('reports merged:true when the PR matching the current branch tip (headRefOid) has merged, regardless of commit message content', () => {
    const runner = ghListRunner((args) => {
      expect(args).toEqual([
        'pr', 'list', '--repo', 'o/r', '--head', 'copybara/public-sync', '--base', 'main',
        '--state', 'all', '--json', 'number,state,headRefOid',
      ]);
      return { stdout: JSON.stringify([{ number: 7, state: 'MERGED', headRefOid: 'sha-current' }]), stderr: '', exitCode: 0 };
    });
    const result = checkSyncBranchMergedViaPr({ runner, repoSlug: 'o/r', branch: 'copybara/public-sync', prBase: 'main', headSha: 'sha-current' });
    expect(result).toEqual({ ok: true, merged: true });
  });

  test('reports merged:false when the PR matching the current branch tip is still open', () => {
    const runner = ghListRunner(() => ({
      stdout: JSON.stringify([{ number: 7, state: 'OPEN', headRefOid: 'sha-current' }]),
      stderr: '',
      exitCode: 0,
    }));
    const result = checkSyncBranchMergedViaPr({ runner, repoSlug: 'o/r', branch: 'copybara/public-sync', prBase: 'main', headSha: 'sha-current' });
    expect(result).toEqual({ ok: true, merged: false });
  });

  test('issue #800 P1 review fix (second pass): a historical merged PR from a reused branch name does not shadow the current open PR at a newer tip', () => {
    // The branch was reused: PR #7 (headRefOid "sha-old") already merged, and
    // the branch has since been force-pushed to "sha-current", which backs a
    // newer, still-open PR #9. A query keyed only on branch name would match
    // #7 and wrongly report merged:true.
    const runner = ghListRunner(() => ({
      stdout: JSON.stringify([
        { number: 7, state: 'MERGED', headRefOid: 'sha-old' },
        { number: 9, state: 'OPEN', headRefOid: 'sha-current' },
      ]),
      stderr: '',
      exitCode: 0,
    }));
    const result = checkSyncBranchMergedViaPr({ runner, repoSlug: 'o/r', branch: 'copybara/public-sync', prBase: 'main', headSha: 'sha-current' });
    expect(result).toEqual({ ok: true, merged: false });
  });

  test('fails closed when no PR matches the sync branch\'s current tip at all', () => {
    const runner = ghListRunner(() => ({
      stdout: JSON.stringify([{ number: 7, state: 'MERGED', headRefOid: 'sha-old' }]),
      stderr: '',
      exitCode: 0,
    }));
    const result = checkSyncBranchMergedViaPr({ runner, repoSlug: 'o/r', branch: 'copybara/public-sync', prBase: 'main', headSha: 'sha-current' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/current tip/);
  });

  test('fails closed when no repo slug can be determined', () => {
    const result = checkSyncBranchMergedViaPr({ runner: ghListRunner(() => { throw new Error('must not be called'); }), repoSlug: null, branch: 'copybara/public-sync', prBase: 'main', headSha: 'sha-current' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/owner\/repo/);
  });

  test('fails closed when gh itself fails (not authenticated, no network, etc.)', () => {
    const runner = ghListRunner(() => ({ stdout: '', stderr: 'gh: authentication required', exitCode: 1 }));
    const result = checkSyncBranchMergedViaPr({ runner, repoSlug: 'o/r', branch: 'copybara/public-sync', prBase: 'main', headSha: 'sha-current' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/authentication required/);
  });

  test('fails closed on non-JSON gh output instead of guessing', () => {
    const runner = ghListRunner(() => ({ stdout: 'not json', stderr: '', exitCode: 0 }));
    const result = checkSyncBranchMergedViaPr({ runner, repoSlug: 'o/r', branch: 'copybara/public-sync', prBase: 'main', headSha: 'sha-current' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/non-JSON/);
  });
});

// ---------------------------------------------------------------------------
// recoverBaselineFromMergedPr (issue #800 P1 review fix)
// ---------------------------------------------------------------------------

describe('recoverBaselineFromMergedPr', () => {
  function ghListRunner(handler) {
    return {
      run(cmd, args) {
        if (cmd === 'gh' && args[1] === 'list') return handler(args);
        throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
      },
    };
  }

  test('recovers the source revision recorded on the most recently merged export PR', () => {
    const runner = ghListRunner((args) => {
      expect(args).toEqual([
        'pr', 'list', '--repo', 'o/r', '--head', 'copybara/public-sync', '--base', 'main',
        '--state', 'merged', '--json', 'number,body,mergedAt',
      ]);
      return {
        stdout: JSON.stringify([
          { number: 3, mergedAt: '2026-01-01T00:00:00Z', body: buildPrBody({ sourceRev: 'a'.repeat(40), branch: 'copybara/public-sync', base: 'main' }) },
          { number: 5, mergedAt: '2026-02-01T00:00:00Z', body: buildPrBody({ sourceRev: 'b'.repeat(40), branch: 'copybara/public-sync', base: 'main' }) },
        ]),
        stderr: '',
        exitCode: 0,
      };
    });
    const result = recoverBaselineFromMergedPr({ runner, repoSlug: 'o/r', branch: 'copybara/public-sync', prBase: 'main' });
    expect(result).toEqual({ ok: true, sourceRev: 'b'.repeat(40), prNumber: 5 });
  });

  test('fails closed when no merged export PR is found (a genuine first export)', () => {
    const runner = ghListRunner(() => ({ stdout: '[]', stderr: '', exitCode: 0 }));
    const result = recoverBaselineFromMergedPr({ runner, repoSlug: 'o/r', branch: 'copybara/public-sync', prBase: 'main' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no previously merged export PR/);
  });

  test('fails closed when no repo slug can be determined', () => {
    const result = recoverBaselineFromMergedPr({
      runner: ghListRunner(() => { throw new Error('must not be called'); }),
      repoSlug: null,
      branch: 'copybara/public-sync',
      prBase: 'main',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/owner\/repo/);
  });

  test('fails closed when gh itself fails', () => {
    const runner = ghListRunner(() => ({ stdout: '', stderr: 'gh: authentication required', exitCode: 1 }));
    const result = recoverBaselineFromMergedPr({ runner, repoSlug: 'o/r', branch: 'copybara/public-sync', prBase: 'main' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/authentication required/);
  });

  test('fails closed on non-JSON gh output instead of guessing', () => {
    const runner = ghListRunner(() => ({ stdout: 'not json', stderr: '', exitCode: 0 }));
    const result = recoverBaselineFromMergedPr({ runner, repoSlug: 'o/r', branch: 'copybara/public-sync', prBase: 'main' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/non-JSON/);
  });

  test('fails closed when the merged PR body has no recognizable source revision line', () => {
    const runner = ghListRunner(() => ({
      stdout: JSON.stringify([{ number: 3, mergedAt: '2026-01-01T00:00:00Z', body: 'some unrelated PR body' }]),
      stderr: '',
      exitCode: 0,
    }));
    const result = recoverBaselineFromMergedPr({ runner, repoSlug: 'o/r', branch: 'copybara/public-sync', prBase: 'main' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not carry a recognizable source revision/);
  });
});

// ---------------------------------------------------------------------------
// parseGithubRepoSlug
// ---------------------------------------------------------------------------

describe('redactCredentialsInText', () => {
  test('strips a credential embedded in a URL', () => {
    expect(redactCredentialsInText("fatal: unable to access 'https://x-access-token:ghp_secret123@github.com/o/r.git/'")).toBe(
      "fatal: unable to access 'https://[REDACTED]@github.com/o/r.git/'"
    );
  });

  test('leaves text without embedded credentials unchanged', () => {
    expect(redactCredentialsInText('non-fast-forward')).toBe('non-fast-forward');
  });
});

describe('parseGithubRepoSlug', () => {
  test('parses an ssh-style URL', () => {
    expect(parseGithubRepoSlug('git@github.com:m2dw/n8n-ai-cli-loop.git')).toBe('m2dw/n8n-ai-cli-loop');
  });

  test('parses an https URL without .git', () => {
    expect(parseGithubRepoSlug('https://github.com/m2dw/n8n-ai-cli-loop')).toBe('m2dw/n8n-ai-cli-loop');
  });

  test('returns null for a non-github URL', () => {
    expect(parseGithubRepoSlug('https://example.invalid/foo/bar.git')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildPrTitle / buildPrBody — never a local path or credential
// ---------------------------------------------------------------------------

describe('buildPrTitle', () => {
  test('includes a shortened source revision', () => {
    expect(buildPrTitle('abc123def4567890')).toBe('Public snapshot export: abc123def456');
  });
});

describe('buildPrBody', () => {
  test('includes the source revision and validation summary, never a local path', () => {
    const body = buildPrBody({ sourceRev: 'abc123', branch: 'copybara/public-sync', base: 'main', alreadyPublished: false });
    expect(body).toMatch(/abc123/);
    expect(body).toMatch(/Validation: clean/);
    expect(body).not.toMatch(/\/(Users|home)\//);
    expect(body).not.toMatch(/tmp/);
  });

  test('notes when a rerun found no content changes', () => {
    const body = buildPrBody({ sourceRev: 'abc123', branch: 'b', base: 'main', alreadyPublished: true });
    expect(body).toMatch(/no content changes/i);
  });

  test('records an --init-history baseline decision', () => {
    const body = buildPrBody({ sourceRev: 'abc123', branch: 'b', base: 'main', alreadyPublished: false, baseline: { mode: 'init-history' } });
    expect(body).toMatch(/--init-history/);
  });

  test('records an auto-derived --last-rev baseline decision', () => {
    const body = buildPrBody({
      sourceRev: 'abc123',
      branch: 'b',
      base: 'main',
      alreadyPublished: false,
      baseline: { mode: 'last-rev', lastRev: 'def456', auto: true },
    });
    expect(body).toMatch(/def456/);
    expect(body).toMatch(/automatically/);
  });

  test('says nothing about the baseline when none was needed', () => {
    const body = buildPrBody({ sourceRev: 'abc123', branch: 'b', base: 'main', alreadyPublished: false });
    expect(body).not.toMatch(/[Bb]aseline/);
  });

  test('falls back to a carried-over baselineLine when no fresh baseline decision was made (issue #800 P2)', () => {
    const body = buildPrBody({
      sourceRev: 'abc123',
      branch: 'b',
      base: 'main',
      alreadyPublished: true,
      baselineLine: '- Baseline: set explicitly via `--last-rev` (`def456`).',
    });
    expect(body).toMatch(/- Baseline: set explicitly via `--last-rev` \(`def456`\)\./);
  });
});

// ---------------------------------------------------------------------------
// extractBaselineLine / readExistingPrBody (issue #800 P2)
// ---------------------------------------------------------------------------

describe('extractBaselineLine', () => {
  test('extracts the literal Baseline line from a full PR body', () => {
    const body = buildPrBody({ sourceRev: 'abc123', branch: 'b', base: 'main', alreadyPublished: false, baseline: { mode: 'init-history' } });
    expect(extractBaselineLine(body)).toBe("- Baseline: established via `--init-history` (the destination's current tip was treated as the pre-export baseline).");
  });

  test('returns null when there is no baseline line', () => {
    expect(extractBaselineLine('Automated private-to-public snapshot export.\n\n- Private source revision: `abc123`')).toBeNull();
  });

  test('returns null for null/undefined input', () => {
    expect(extractBaselineLine(null)).toBeNull();
    expect(extractBaselineLine(undefined)).toBeNull();
  });
});

describe('readExistingPrBody', () => {
  test('returns null when there is no repo slug', () => {
    expect(readExistingPrBody({ runner: defaultRunner, repoSlug: null, branch: 'b' })).toBeNull();
  });

  test('returns the body on a successful gh pr view', () => {
    const runner = { run: () => ({ stdout: JSON.stringify({ body: 'hello' }), stderr: '', exitCode: 0 }) };
    expect(readExistingPrBody({ runner, repoSlug: 'o/r', branch: 'b' })).toBe('hello');
  });

  test('returns null when gh fails or returns non-JSON', () => {
    const failing = { run: () => ({ stdout: '', stderr: 'no pull requests found', exitCode: 1 }) };
    expect(readExistingPrBody({ runner: failing, repoSlug: 'o/r', branch: 'b' })).toBeNull();
    const malformed = { run: () => ({ stdout: 'not json', stderr: '', exitCode: 0 }) };
    expect(readExistingPrBody({ runner: malformed, repoSlug: 'o/r', branch: 'b' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ensurePullRequest
// ---------------------------------------------------------------------------

describe('ensurePullRequest', () => {
  test('creates a PR when none exists yet', () => {
    const runner = {
      run(cmd, args) {
        if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
        if (args[1] === 'create') return { stdout: 'https://github.com/o/r/pull/7\n', stderr: '', exitCode: 0 };
        throw new Error(`unexpected gh call: ${args.join(' ')}`);
      },
    };
    const result = ensurePullRequest({ runner, repoSlug: 'o/r', branch: 'b', base: 'main', title: 't', body: 'x' });
    expect(result).toEqual({ ok: true, action: 'created', url: 'https://github.com/o/r/pull/7' });
  });

  test('updates an existing open PR instead of creating a duplicate', () => {
    const runner = {
      run(cmd, args) {
        if (args[1] === 'view') return { stdout: JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' }), stderr: '', exitCode: 0 };
        if (args[1] === 'edit') return { stdout: '', stderr: '', exitCode: 0 };
        throw new Error(`unexpected gh call: ${args.join(' ')}`);
      },
    };
    const result = ensurePullRequest({ runner, repoSlug: 'o/r', branch: 'b', base: 'main', title: 't', body: 'x' });
    expect(result).toEqual({ ok: true, action: 'updated', number: 7, url: 'https://github.com/o/r/pull/7' });
  });

  test('creates a new PR when a previous one was closed', () => {
    const runner = {
      run(cmd, args) {
        if (args[1] === 'view') return { stdout: JSON.stringify({ number: 5, url: 'https://github.com/o/r/pull/5', state: 'CLOSED' }), stderr: '', exitCode: 0 };
        if (args[1] === 'create') return { stdout: 'https://github.com/o/r/pull/8\n', stderr: '', exitCode: 0 };
        throw new Error(`unexpected gh call: ${args.join(' ')}`);
      },
    };
    const result = ensurePullRequest({ runner, repoSlug: 'o/r', branch: 'b', base: 'main', title: 't', body: 'x' });
    expect(result).toEqual({ ok: true, action: 'created', url: 'https://github.com/o/r/pull/8' });
  });

  test('fails closed when the repo slug cannot be determined', () => {
    const result = ensurePullRequest({ runner: defaultRunner, repoSlug: null, branch: 'b', base: 'main', title: 't', body: 'x' });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runPublicExport — end-to-end orchestration
// ---------------------------------------------------------------------------

describe('runPublicExport', () => {
  function makeFixtures() {
    const privateRepo = initRepo(join(tmpDir, 'private'));
    // Not bare: represents the real public GitHub repo, which always has
    // committed baseline history. This is only ever read (bare-cloned as a
    // SQUASH baseline) or pushed to on a brand-new dedicated branch, never
    // "main" itself, so it never needs denyCurrentBranch protection here.
    const publicRepo = initRepo(join(tmpDir, 'public'));
    const { jarPath, pinPath } = makeJarAndPin(tmpDir);
    const configPath = makeConfigTemplate(tmpDir);
    return { privateRepo, publicRepo, jarPath, pinPath, configPath };
  }

  function baseOpts(fixtures, overrides = {}) {
    return {
      privateRemote: fileUrl(fixtures.privateRepo),
      publicRemote: fileUrl(fixtures.publicRepo),
      // The fixture "public remote" is a local file:// repo (see makeFixtures
      // above), which cannot be parsed as a github.com URL — pass the
      // owner/repo explicitly, exactly as an operator would for a
      // non-github.com --public-remote (e.g. an SSH alias or mirror).
      repoSlug: 'o/r',
      rev: 'main',
      branch: 'copybara/public-sync',
      prBase: 'main',
      jarPath: fixtures.jarPath,
      pinPath: fixtures.pinPath,
      configPath: fixtures.configPath,
      ...overrides,
    };
  }

  // issue #800 P1 review fix: merge status is now checked via an
  // authoritative `gh pr list --state all` call keyed on the sync branch's
  // *current* tip commit (headRefOid), not by branch name alone — so these
  // stubs read the sync branch's actual current tip out of the fixture
  // "public remote" at call time (mirroring what a real `gh pr list` would
  // report for a PR whose head is that exact commit) rather than hard-coding
  // a SHA the test can't otherwise predict.
  function currentSyncBranchSha(fixtures, branch = 'copybara/public-sync') {
    try {
      return git(['rev-parse', `refs/heads/${branch}`], fixtures.publicRepo).trim();
    } catch {
      return null;
    }
  }
  function ghNotMergedHandler(fixtures, branch = 'copybara/public-sync') {
    return (args) => {
      if (args[1] === 'list') {
        const headSha = currentSyncBranchSha(fixtures, branch);
        return { stdout: JSON.stringify([{ number: 1, state: 'OPEN', headRefOid: headSha }]), stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
  }
  function ghMergedHandler(fixtures, branch = 'copybara/public-sync') {
    return (args) => {
      if (args[1] === 'list') {
        const headSha = currentSyncBranchSha(fixtures, branch);
        return { stdout: JSON.stringify([{ number: 1, state: 'MERGED', headRefOid: headSha }]), stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
  }

  test('dry run validates cleanly and never touches the public remote', async () => {
    const fixtures = makeFixtures();
    const baselineMainSha = git(['rev-parse', 'refs/heads/main'], fixtures.publicRepo).trim();
    const ghHandler = jest.fn();
    const runner = makeRunner({ ghHandler });

    const result = await runPublicExport(baseOpts(fixtures, { workdir: join(tmpDir, 'work-dry'), initHistory: true }), { runner });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('dry-run');
    expect(result.sourceRev).toBe(git(['rev-parse', 'HEAD'], fixtures.privateRepo).trim());
    expect(result.baseline).toEqual({ mode: 'init-history' });
    expect(ghHandler).not.toHaveBeenCalled();
    // The public bare repo's main ref is untouched, and no sync branch exists.
    expect(git(['rev-parse', 'refs/heads/main'], fixtures.publicRepo).trim()).toBe(baselineMainSha);
    let branchExists = true;
    try {
      git(['rev-parse', '--verify', 'refs/heads/copybara/public-sync'], fixtures.publicRepo);
    } catch {
      branchExists = false;
    }
    expect(branchExists).toBe(false);
  });

  test('publish pushes a dedicated branch and creates a PR, never touching the public main', async () => {
    const fixtures = makeFixtures();
    const baselineMainSha = git(['rev-parse', 'refs/heads/main'], fixtures.publicRepo).trim();
    const ghHandler = jest.fn((args) => {
      if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
      if (args[1] === 'create') return { stdout: 'https://github.com/o/r/pull/1\n', stderr: '', exitCode: 0 };
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });
    const runner = makeRunner({ ghHandler });

    const result = await runPublicExport(
      baseOpts(fixtures, { workdir: join(tmpDir, 'work-publish'), publish: true, yes: true, initHistory: true }),
      { runner }
    );

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('publish');
    expect(result.alreadyPublished).toBe(false);
    expect(result.pr).toEqual({ ok: true, action: 'created', url: 'https://github.com/o/r/pull/1' });
    expect(result.baseline).toEqual({ mode: 'init-history' });

    // main on the public remote must be exactly untouched.
    expect(git(['rev-parse', 'refs/heads/main'], fixtures.publicRepo).trim()).toBe(baselineMainSha);
    // The dedicated branch now carries the source revision trailer.
    const message = git(['log', '-1', '--format=%B', 'refs/heads/copybara/public-sync'], fixtures.publicRepo);
    expect(message).toMatch(new RegExp(`GitOrigin-RevId: ${result.sourceRev}`));
    // The PR body records the baseline decision.
    const createArgs = ghHandler.mock.calls.map((c) => c[0]).find((a) => a[1] === 'create');
    const body = createArgs[createArgs.indexOf('--body') + 1];
    expect(body).toMatch(/--init-history/);
  });

  test('re-running publish for the same source revision is idempotent (no duplicate push, PR updated not duplicated)', async () => {
    const fixtures = makeFixtures();
    let jarInvocations = 0;
    const ghHandlerFirst = (args) => {
      if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
      if (args[1] === 'create') return { stdout: 'https://github.com/o/r/pull/1\n', stderr: '', exitCode: 0 };
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const runnerFirst = makeRunner({ ghHandler: ghHandlerFirst });
    const wrappedFirst = {
      run(cmd, args, opts) {
        if (cmd === 'java' && args[0] === '-jar') jarInvocations += 1;
        return runnerFirst.run(cmd, args, opts);
      },
    };

    const first = await runPublicExport(
      baseOpts(fixtures, { workdir: join(tmpDir, 'work-first'), publish: true, yes: true, initHistory: true }),
      { runner: wrappedFirst }
    );
    expect(first.ok).toBe(true);
    expect(jarInvocations).toBe(1);

    const ghHandlerSecond = jest.fn((args) => {
      if (args[1] === 'view') {
        return { stdout: JSON.stringify({ number: 1, url: 'https://github.com/o/r/pull/1', state: 'OPEN' }), stderr: '', exitCode: 0 };
      }
      if (args[1] === 'edit') return { stdout: '', stderr: '', exitCode: 0 };
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });
    const runnerSecond = makeRunner({ ghHandler: ghHandlerSecond });
    const wrappedSecond = {
      run(cmd, args, opts) {
        if (cmd === 'java' && args[0] === '-jar') jarInvocations += 1;
        return runnerSecond.run(cmd, args, opts);
      },
    };

    const second = await runPublicExport(
      baseOpts(fixtures, { workdir: join(tmpDir, 'work-second'), publish: true, yes: true }),
      { runner: wrappedSecond }
    );

    expect(second.ok).toBe(true);
    expect(second.alreadyPublished).toBe(true);
    expect(second.sourceRev).toBe(first.sourceRev);
    expect(second.pr).toEqual({ ok: true, action: 'updated', number: 1, url: 'https://github.com/o/r/pull/1' });
    // No second migrate invocation — the idempotent path skips the local pipeline entirely.
    expect(jarInvocations).toBe(1);
  });

  test('a validation failure leaves the public repository unchanged', async () => {
    const fixtures = makeFixtures();
    const baselineMainSha = git(['rev-parse', 'refs/heads/main'], fixtures.publicRepo).trim();
    const runner = {
      run(cmd, args, opts = {}) {
        if (cmd === 'java' && args[0] === '-version') return { stdout: '', stderr: 'openjdk version "21.0.3"', exitCode: 0 };
        if (cmd === 'java' && args[0] === '-jar') {
          const originDir = join(opts.cwd, 'origin');
          const sourceRev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: originDir, encoding: 'utf8' }).trim();
          pushSquashCommit(join(opts.cwd, 'destination'), 'main', sourceRev, (scratch) => {
            writeFileSync(join(scratch, 'leaked.md'), 'built at /Users/alice/repo\n');
          });
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd === 'gh') throw new Error('gh must not be invoked when validation fails');
        return defaultRunner.run(cmd, args, opts);
      },
    };

    const result = await runPublicExport(
      baseOpts(fixtures, { workdir: join(tmpDir, 'work-invalid'), publish: true, yes: true, initHistory: true }),
      { runner }
    );

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('validate');
    expect(git(['rev-parse', 'refs/heads/main'], fixtures.publicRepo).trim()).toBe(baselineMainSha);
    let branchExists = true;
    try {
      git(['rev-parse', '--verify', 'refs/heads/copybara/public-sync'], fixtures.publicRepo);
    } catch {
      branchExists = false;
    }
    expect(branchExists).toBe(false);
  });

  test('fails closed at the java stage before touching the public remote', async () => {
    const fixtures = makeFixtures();
    const baselineMainSha = git(['rev-parse', 'refs/heads/main'], fixtures.publicRepo).trim();
    const runner = makeRunner({ javaVersion: 'openjdk version "17.0.1"' });

    const result = await runPublicExport(baseOpts(fixtures, { workdir: join(tmpDir, 'work-java'), initHistory: true }), { runner });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('java');
    expect(git(['rev-parse', 'refs/heads/main'], fixtures.publicRepo).trim()).toBe(baselineMainSha);
  });

  test('fails closed at the checksum stage when the pinned jar cache download does not match', async () => {
    const fixtures = makeFixtures();
    // Drop the explicit jarPath so the jar-cache download path is exercised,
    // and point the pin at a downloadUrl whose bytes will not match jarSha256.
    const pinPath = join(tmpDir, 'PIN-download.json');
    writeFileSync(
      pinPath,
      JSON.stringify({ release: 'v2', jarSha256: 'a'.repeat(64), downloadUrl: 'https://example.invalid/copybara.jar', javaMinVersion: 21 })
    );
    const runner = makeRunner({});
    const download = jest.fn(async (url, destPath) => writeFileSync(destPath, 'wrong-bytes'));

    const result = await runPublicExport(
      baseOpts(fixtures, { workdir: join(tmpDir, 'work-checksum'), pinPath, jarPath: undefined, jarCacheDir: join(tmpDir, 'jar-cache'), initHistory: true }),
      { runner, download }
    );

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('checksum');
  });

  test('fails closed at the push stage without creating a PR', async () => {
    const fixtures = makeFixtures();
    const baselineMainSha = git(['rev-parse', 'refs/heads/main'], fixtures.publicRepo).trim();
    const ghHandler = jest.fn();
    const runner = makeRunner({ forcePushExitCode: 1, ghHandler });

    const result = await runPublicExport(
      baseOpts(fixtures, { workdir: join(tmpDir, 'work-push-fail'), publish: true, yes: true, initHistory: true }),
      { runner }
    );

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('push');
    expect(ghHandler).not.toHaveBeenCalled();
    expect(git(['rev-parse', 'refs/heads/main'], fixtures.publicRepo).trim()).toBe(baselineMainSha);
  });

  test('fails closed when the requested rev does not exist on the private remote', async () => {
    const fixtures = makeFixtures();
    const runner = makeRunner({});
    const result = await runPublicExport(
      baseOpts(fixtures, { workdir: join(tmpDir, 'work-rev'), rev: 'does-not-exist' }),
      { runner }
    );
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('resolve-rev');
  });

  // -------------------------------------------------------------------------
  // Baseline selection (issue #800) — first baseline, valid existing
  // baseline, and unresolved/stale baseline refusal.
  // -------------------------------------------------------------------------

  test('first baseline: fails closed before touching Java when no prior export is recorded and no baseline flag is given', async () => {
    const fixtures = makeFixtures();
    let javaInvoked = false;
    const runner = makeRunner({});
    const wrapped = {
      run(cmd, args, opts) {
        if (cmd === 'java') javaInvoked = true;
        return runner.run(cmd, args, opts);
      },
    };

    const result = await runPublicExport(baseOpts(fixtures, { workdir: join(tmpDir, 'work-first-baseline') }), { runner: wrapped });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('baseline');
    expect(result.reason).toMatch(/--init-history/);
    expect(result.reason).toMatch(/Do not retry with --force/);
    expect(javaInvoked).toBe(false);
  });

  test('valid existing baseline: a genuinely new private commit auto-derives --last-rev from the sync branch, no operator flag needed', async () => {
    const fixtures = makeFixtures();
    const priorRev = git(['rev-parse', 'HEAD'], fixtures.privateRepo).trim();
    // Record `priorRev` as this tool's own previous export on the dedicated
    // sync branch, mirroring what a real --publish run leaves behind.
    pushSquashCommit(fixtures.publicRepo, 'copybara/public-sync', priorRev, (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hello\n');
    });
    // The private main advances — a genuinely new export.
    writeFileSync(join(fixtures.privateRepo, 'CHANGED.md'), 'update\n');
    git(['add', '-A'], fixtures.privateRepo);
    git(['commit', '-q', '-m', 'update'], fixtures.privateRepo);

    let capturedMigrateArgs = null;
    const runner = makeRunner({ ghHandler: ghNotMergedHandler(fixtures) });
    const wrapped = {
      run(cmd, args, opts) {
        if (cmd === 'java' && args[0] === '-jar') capturedMigrateArgs = args;
        return runner.run(cmd, args, opts);
      },
    };

    const result = await runPublicExport(baseOpts(fixtures, { workdir: join(tmpDir, 'work-auto-baseline') }), { runner: wrapped });

    expect(result.ok).toBe(true);
    expect(result.sourceRev).not.toBe(priorRev);
    expect(result.baseline).toEqual({ mode: 'last-rev', lastRev: priorRev, resolved: true, auto: true });
    expect(capturedMigrateArgs).toEqual(expect.arrayContaining(['--last-rev', priorRev]));
  });

  test('unresolved/stale baseline refusal: a recorded sync-branch trailer that no longer resolves fails closed without --force', async () => {
    const fixtures = makeFixtures();
    pushSquashCommit(fixtures.publicRepo, 'copybara/public-sync', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hello\n');
    });

    let migrateInvoked = false;
    const runner = makeRunner({ ghHandler: ghNotMergedHandler(fixtures) });
    const wrapped = {
      run(cmd, args, opts) {
        if (cmd === 'java' && args[0] === '-jar') migrateInvoked = true;
        return runner.run(cmd, args, opts);
      },
    };

    const result = await runPublicExport(baseOpts(fixtures, { workdir: join(tmpDir, 'work-stale-baseline') }), { runner: wrapped });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('baseline');
    expect(result.reason).toMatch(/does not resolve/);
    expect(result.reason).toMatch(/Do not retry with --force/);
    expect(migrateInvoked).toBe(false);
  });

  test('repeat export (issue #800 P1): destination baseline is staged from the existing sync branch, not --pr-base', async () => {
    const fixtures = makeFixtures();
    const priorRev = git(['rev-parse', 'HEAD'], fixtures.privateRepo).trim();
    // A prior export already landed on the dedicated sync branch (its PR may
    // still be open/unmerged) — --pr-base ("main") does not contain it.
    pushSquashCommit(fixtures.publicRepo, 'copybara/public-sync', priorRev, (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hello\n');
    });
    writeFileSync(join(fixtures.privateRepo, 'CHANGED.md'), 'update\n');
    git(['add', '-A'], fixtures.privateRepo);
    git(['commit', '-q', '-m', 'update'], fixtures.privateRepo);

    const cloneBranchArgs = [];
    const runner = makeRunner({ ghHandler: ghNotMergedHandler(fixtures) });
    const wrapped = {
      run(cmd, args, opts) {
        if (cmd === 'git' && args[0] === 'clone' && args.includes('--branch')) {
          cloneBranchArgs.push(args[args.indexOf('--branch') + 1]);
        }
        return runner.run(cmd, args, opts);
      },
    };

    const result = await runPublicExport(baseOpts(fixtures, { workdir: join(tmpDir, 'work-repeat-destbranch') }), { runner: wrapped });

    expect(result.ok).toBe(true);
    // The post-migrate validation checkout must read the sync branch, the
    // one the --last-rev baseline was actually diffed against — not main.
    expect(cloneBranchArgs).toContain('copybara/public-sync');
    expect(cloneBranchArgs).not.toContain('main');
  });

  test('repeat export after the prior sync PR merged (issue #800 P1 review fix): stages from --pr-base, not the stale sync branch', async () => {
    const fixtures = makeFixtures();
    const priorRev = git(['rev-parse', 'HEAD'], fixtures.privateRepo).trim();
    // The dedicated sync branch still carries the prior export's trailer...
    pushSquashCommit(fixtures.publicRepo, 'copybara/public-sync', priorRev, (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hello\n');
    });
    // ...but that prior sync PR has since been squash-merged into --pr-base
    // ("main"), which now carries the same trailer plus base-only content
    // the sync branch never had. The fixture "public remote" has main
    // checked out (see makeFixtures), so allow this push to update the
    // checked-out branch and its worktree in place, as a real Git host does.
    git(['config', 'receive.denyCurrentBranch', 'updateInstead'], fixtures.publicRepo);
    pushSquashCommit(fixtures.publicRepo, 'main', priorRev, (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hello\n');
      writeFileSync(join(scratch, 'base-only.txt'), 'base content\n');
    });
    writeFileSync(join(fixtures.privateRepo, 'CHANGED.md'), 'update\n');
    git(['add', '-A'], fixtures.privateRepo);
    git(['commit', '-q', '-m', 'update'], fixtures.privateRepo);

    const cloneBranchArgs = [];
    const runner = makeRunner({ ghHandler: ghMergedHandler(fixtures) });
    const wrapped = {
      run(cmd, args, opts) {
        if (cmd === 'git' && args[0] === 'clone' && args.includes('--branch')) {
          cloneBranchArgs.push(args[args.indexOf('--branch') + 1]);
        }
        return runner.run(cmd, args, opts);
      },
    };

    const result = await runPublicExport(baseOpts(fixtures, { workdir: join(tmpDir, 'work-repeat-merged') }), { runner: wrapped });

    expect(result.ok).toBe(true);
    // The auto-derived baseline is still the sync branch's own recorded
    // revision — only the tree staged for the diff moves to --pr-base.
    expect(result.baseline).toEqual({ mode: 'last-rev', lastRev: priorRev, resolved: true, auto: true });
    expect(cloneBranchArgs).toContain('main');
    expect(cloneBranchArgs).not.toContain('copybara/public-sync');
  });

  test('repeat export after GitHub auto-deletes the merged sync branch (issue #800 P1 review fix): baseline recovers from the merged PR, no repeated flags needed', async () => {
    const fixtures = makeFixtures();
    const priorRev = git(['rev-parse', 'HEAD'], fixtures.privateRepo).trim();
    // The prior sync PR merged into --pr-base ("main")...
    git(['config', 'receive.denyCurrentBranch', 'updateInstead'], fixtures.publicRepo);
    pushSquashCommit(fixtures.publicRepo, 'main', priorRev, (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hello\n');
    });
    // ...and GitHub's "automatically delete head branches" setting removed
    // "copybara/public-sync" the moment it merged — it never exists on the
    // public remote here, unlike the still-present-but-stale scenario above.
    writeFileSync(join(fixtures.privateRepo, 'CHANGED.md'), 'update\n');
    git(['add', '-A'], fixtures.privateRepo);
    git(['commit', '-q', '-m', 'update'], fixtures.privateRepo);

    const cloneBranchArgs = [];
    const ghHandler = jest.fn((args) => {
      if (args[1] === 'list') {
        return {
          stdout: JSON.stringify([
            {
              number: 1,
              mergedAt: '2026-01-01T00:00:00Z',
              body: buildPrBody({ sourceRev: priorRev, branch: 'copybara/public-sync', base: 'main' }),
            },
          ]),
          stderr: '',
          exitCode: 0,
        };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });
    const runner = makeRunner({ ghHandler });
    const wrapped = {
      run(cmd, args, opts) {
        if (cmd === 'git' && args[0] === 'clone' && args.includes('--branch')) {
          cloneBranchArgs.push(args[args.indexOf('--branch') + 1]);
        }
        return runner.run(cmd, args, opts);
      },
    };

    const result = await runPublicExport(baseOpts(fixtures, { workdir: join(tmpDir, 'work-recover-deleted-branch') }), { runner: wrapped });

    expect(result.ok).toBe(true);
    // The recovered baseline is the merged PR's own recorded source
    // revision, exactly as if the sync branch had survived.
    expect(result.baseline).toEqual({ mode: 'last-rev', lastRev: priorRev, resolved: true, auto: true });
    // Nothing recorded on a live sync branch, so the destination tree is
    // staged from --pr-base, which already carries the merged content.
    expect(cloneBranchArgs).toContain('main');
    expect(cloneBranchArgs).not.toContain('copybara/public-sync');
    expect(ghHandler).toHaveBeenCalled();
  });

  test('repeat export after the merged sync PR is no longer the base tip (issue #800 P1 review fix): merge is still detected from history, not just the tip', async () => {
    const fixtures = makeFixtures();
    const priorRev = git(['rev-parse', 'HEAD'], fixtures.privateRepo).trim();
    // The dedicated sync branch still carries the prior export's trailer...
    pushSquashCommit(fixtures.publicRepo, 'copybara/public-sync', priorRev, (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hello\n');
    });
    // ...that prior sync PR merged into --pr-base ("main")...
    git(['config', 'receive.denyCurrentBranch', 'updateInstead'], fixtures.publicRepo);
    pushSquashCommit(fixtures.publicRepo, 'main', priorRev, (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hello\n');
    });
    // ...and --pr-base has since advanced further with another public-only
    // commit, so the merge is now buried in history instead of at the tip —
    // exactly the scenario a depth-1 tip-only read misses.
    git(['checkout', '-q', 'main'], fixtures.publicRepo);
    writeFileSync(join(fixtures.publicRepo, 'base-only.txt'), 'base content\n');
    git(['add', '-A'], fixtures.publicRepo);
    git(['commit', '-q', '-m', 'unrelated public change'], fixtures.publicRepo);

    writeFileSync(join(fixtures.privateRepo, 'CHANGED.md'), 'update\n');
    git(['add', '-A'], fixtures.privateRepo);
    git(['commit', '-q', '-m', 'update'], fixtures.privateRepo);

    const cloneBranchArgs = [];
    const runner = makeRunner({ ghHandler: ghMergedHandler(fixtures) });
    const wrapped = {
      run(cmd, args, opts) {
        if (cmd === 'git' && args[0] === 'clone' && args.includes('--branch')) {
          cloneBranchArgs.push(args[args.indexOf('--branch') + 1]);
        }
        return runner.run(cmd, args, opts);
      },
    };

    const result = await runPublicExport(baseOpts(fixtures, { workdir: join(tmpDir, 'work-repeat-merged-advanced') }), { runner: wrapped });

    expect(result.ok).toBe(true);
    // The merge is detected even though it is no longer --pr-base's tip, so
    // the export stages from --pr-base (which carries base-only.txt) rather
    // than the stale sync branch (which would omit it).
    expect(result.baseline).toEqual({ mode: 'last-rev', lastRev: priorRev, resolved: true, auto: true });
    expect(cloneBranchArgs).toContain('main');
    expect(cloneBranchArgs).not.toContain('copybara/public-sync');
  });

  test('issue #800 P1 review fix (second pass): a historical merged PR on a reused sync branch name does not shadow the currently open PR at the newer tip', async () => {
    const fixtures = makeFixtures();
    const firstRev = git(['rev-parse', 'HEAD'], fixtures.privateRepo).trim();
    // An earlier export's sync-branch PR already merged into --pr-base...
    pushSquashCommit(fixtures.publicRepo, 'copybara/public-sync', firstRev, (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hello\n');
    });
    const mergedTipSha = currentSyncBranchSha(fixtures);
    git(['config', 'receive.denyCurrentBranch', 'updateInstead'], fixtures.publicRepo);
    pushSquashCommit(fixtures.publicRepo, 'main', firstRev, (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hello\n');
    });
    // ...and the same branch NAME has since been reused for a newer export
    // whose PR is still open — the branch's tip has moved on from the
    // commit that merged, but a name-only query would still find PR #1.
    writeFileSync(join(fixtures.privateRepo, 'CHANGED.md'), 'update\n');
    git(['add', '-A'], fixtures.privateRepo);
    git(['commit', '-q', '-m', 'update'], fixtures.privateRepo);
    const secondRev = git(['rev-parse', 'HEAD'], fixtures.privateRepo).trim();
    pushSquashCommit(fixtures.publicRepo, 'copybara/public-sync', secondRev, (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hello more\n');
    });
    const openTipSha = currentSyncBranchSha(fixtures);

    // The private source advances again for this run.
    writeFileSync(join(fixtures.privateRepo, 'THIRD.md'), 'third\n');
    git(['add', '-A'], fixtures.privateRepo);
    git(['commit', '-q', '-m', 'third update'], fixtures.privateRepo);

    const cloneBranchArgs = [];
    const runner = makeRunner({
      ghHandler: (args) => {
        if (args[1] === 'list') {
          return {
            stdout: JSON.stringify([
              { number: 1, state: 'MERGED', headRefOid: mergedTipSha },
              { number: 2, state: 'OPEN', headRefOid: openTipSha },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        throw new Error(`unexpected gh call: ${args.join(' ')}`);
      },
    });
    const wrapped = {
      run(cmd, args, opts) {
        if (cmd === 'git' && args[0] === 'clone' && args.includes('--branch')) {
          cloneBranchArgs.push(args[args.indexOf('--branch') + 1]);
        }
        return runner.run(cmd, args, opts);
      },
    };

    const result = await runPublicExport(baseOpts(fixtures, { workdir: join(tmpDir, 'work-repeat-reused-branch') }), { runner: wrapped });

    expect(result.ok).toBe(true);
    // The currently open PR (#2) backs the sync branch's actual tip — the
    // historical merged PR (#1) sharing the branch name must not shadow it
    // into staging from --pr-base, which would drop PR #2's prior content.
    expect(cloneBranchArgs).toContain('copybara/public-sync');
    expect(cloneBranchArgs).not.toContain('main');
  });

  test('merge status that cannot be authoritatively determined fails closed (issue #800 P1 review fix) rather than guessing', async () => {
    const fixtures = makeFixtures();
    const priorRev = git(['rev-parse', 'HEAD'], fixtures.privateRepo).trim();
    pushSquashCommit(fixtures.publicRepo, 'copybara/public-sync', priorRev, (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hello\n');
    });
    writeFileSync(join(fixtures.privateRepo, 'CHANGED.md'), 'update\n');
    git(['add', '-A'], fixtures.privateRepo);
    git(['commit', '-q', '-m', 'update'], fixtures.privateRepo);

    let migrateInvoked = false;
    const runner = makeRunner({
      ghHandler: (args) => {
        if (args[1] === 'list') return { stdout: '', stderr: 'gh: authentication required', exitCode: 1 };
        throw new Error(`unexpected gh call: ${args.join(' ')}`);
      },
    });
    const wrapped = {
      run(cmd, args, opts) {
        if (cmd === 'java' && args[0] === '-jar') migrateInvoked = true;
        return runner.run(cmd, args, opts);
      },
    };

    const result = await runPublicExport(baseOpts(fixtures, { workdir: join(tmpDir, 'work-merge-check-fails') }), { runner: wrapped });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('merge-check');
    expect(result.reason).toMatch(/authentication required/);
    expect(migrateInvoked).toBe(false);
  });

  test('issue #800 P1 review fix: revalidates merge state before publishing so a mid-run merge does not push a stale sync-branch diff', async () => {
    const fixtures = makeFixtures();
    const priorRev = git(['rev-parse', 'HEAD'], fixtures.privateRepo).trim();
    // A prior export already recorded on the dedicated sync branch...
    pushSquashCommit(fixtures.publicRepo, 'copybara/public-sync', priorRev, (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hello\n');
    });
    writeFileSync(join(fixtures.privateRepo, 'CHANGED.md'), 'update\n');
    git(['add', '-A'], fixtures.privateRepo);
    git(['commit', '-q', '-m', 'update'], fixtures.privateRepo);

    // ...whose PR is reported OPEN on the merge check that runs before the
    // Java/download/export work, but has merged by the time the code
    // re-checks right before the force-push — simulating a merge landing
    // mid-run.
    let listCalls = 0;
    let pushInvoked = false;
    const runner = makeRunner({
      ghHandler: (args) => {
        if (args[1] === 'list') {
          listCalls += 1;
          const headSha = currentSyncBranchSha(fixtures);
          const state = listCalls === 1 ? 'OPEN' : 'MERGED';
          return { stdout: JSON.stringify([{ number: 1, state, headRefOid: headSha }]), stderr: '', exitCode: 0 };
        }
        throw new Error(`unexpected gh call: ${args.join(' ')}`);
      },
    });
    const wrapped = {
      run(cmd, args, opts) {
        if (cmd === 'git' && args[0] === 'push' && args.includes('--force')) pushInvoked = true;
        return runner.run(cmd, args, opts);
      },
    };

    const result = await runPublicExport(
      baseOpts(fixtures, { workdir: join(tmpDir, 'work-merge-revalidate-stale'), publish: true, yes: true }),
      { runner: wrapped }
    );

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('merge-check-stale');
    expect(result.reason).toMatch(/changed while this export was running/);
    expect(pushInvoked).toBe(false);
    expect(listCalls).toBe(2);
  });

  test('a genuine repeat --publish (source advanced, prior PR still open) pushes from the sync branch it diffed against, not --pr-base', async () => {
    const fixtures = makeFixtures();
    const ghHandlerFirst = (args) => {
      if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
      if (args[1] === 'create') return { stdout: 'https://github.com/o/r/pull/1\n', stderr: '', exitCode: 0 };
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const first = await runPublicExport(
      baseOpts(fixtures, { workdir: join(tmpDir, 'work-repeat-publish-first'), publish: true, yes: true, initHistory: true }),
      { runner: makeRunner({ ghHandler: ghHandlerFirst }) }
    );
    expect(first.ok).toBe(true);

    // Private source advances while the first sync PR is still open/unmerged.
    writeFileSync(join(fixtures.privateRepo, 'CHANGED.md'), 'update\n');
    git(['add', '-A'], fixtures.privateRepo);
    git(['commit', '-q', '-m', 'update'], fixtures.privateRepo);

    const ghHandlerSecond = (args) => {
      if (args[1] === 'list') return ghNotMergedHandler(fixtures)(args);
      if (args[1] === 'view') return { stdout: JSON.stringify({ number: 1, url: 'https://github.com/o/r/pull/1', state: 'OPEN' }), stderr: '', exitCode: 0 };
      if (args[1] === 'edit') return { stdout: '', stderr: '', exitCode: 0 };
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const runnerSecond = makeRunner({ ghHandler: ghHandlerSecond });
    const pushArgsSeen = [];
    const wrapped = {
      run(cmd, args, opts) {
        if (cmd === 'git' && args[0] === 'push' && args.includes('--force')) {
          pushArgsSeen.push(args);
        }
        return runnerSecond.run(cmd, args, opts);
      },
    };

    const second = await runPublicExport(
      baseOpts(fixtures, { workdir: join(tmpDir, 'work-repeat-publish-second'), publish: true, yes: true }),
      { runner: wrapped }
    );

    expect(second.ok).toBe(true);
    expect(second.alreadyPublished).toBe(false);
    const forcePush = pushArgsSeen.find((a) => a.includes(fileUrl(fixtures.publicRepo)));
    expect(forcePush).toBeDefined();
    expect(forcePush[forcePush.length - 1]).toBe('refs/heads/copybara/public-sync:refs/heads/copybara/public-sync');
  });

  test('idempotent rerun (issue #800 P2): the PR body baseline line survives even though no local export ran', async () => {
    const fixtures = makeFixtures();
    const ghHandlerFirst = (args) => {
      if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
      if (args[1] === 'create') return { stdout: 'https://github.com/o/r/pull/1\n', stderr: '', exitCode: 0 };
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    let capturedCreateBody = null;
    const wrappedFirst = {
      run(cmd, args, opts) {
        if (cmd === 'gh' && args[1] === 'create') {
          capturedCreateBody = args[args.indexOf('--body') + 1];
        }
        return makeRunner({ ghHandler: ghHandlerFirst }).run(cmd, args, opts);
      },
    };
    const first = await runPublicExport(
      baseOpts(fixtures, { workdir: join(tmpDir, 'work-provenance-first'), publish: true, yes: true, initHistory: true }),
      { runner: wrappedFirst }
    );
    expect(first.ok).toBe(true);
    expect(capturedCreateBody).toMatch(/- Baseline:/);

    const ghHandlerSecond = (args) => {
      if (args[1] === 'view') {
        return { stdout: JSON.stringify({ number: 1, url: 'https://github.com/o/r/pull/1', state: 'OPEN', body: capturedCreateBody }), stderr: '', exitCode: 0 };
      }
      if (args[1] === 'edit') return { stdout: '', stderr: '', exitCode: 0 };
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    let capturedEditBody = null;
    const wrappedSecond = {
      run(cmd, args, opts) {
        if (cmd === 'gh' && args[1] === 'edit') {
          capturedEditBody = args[args.indexOf('--body') + 1];
        }
        return makeRunner({ ghHandler: ghHandlerSecond }).run(cmd, args, opts);
      },
    };

    const second = await runPublicExport(
      baseOpts(fixtures, { workdir: join(tmpDir, 'work-provenance-second'), publish: true, yes: true }),
      { runner: wrappedSecond }
    );

    expect(second.ok).toBe(true);
    expect(second.alreadyPublished).toBe(true);
    expect(capturedEditBody).toMatch(/- Baseline:.*--init-history/);
  });

  test('an explicit --last-rev overrides a stale recorded trailer', async () => {
    const fixtures = makeFixtures();
    const priorRev = git(['rev-parse', 'HEAD'], fixtures.privateRepo).trim();
    pushSquashCommit(fixtures.publicRepo, 'copybara/public-sync', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', (scratch) => {
      writeFileSync(join(scratch, 'exported.txt'), 'hello\n');
    });

    const runner = makeRunner({ ghHandler: ghNotMergedHandler(fixtures) });
    const result = await runPublicExport(
      baseOpts(fixtures, { workdir: join(tmpDir, 'work-override-baseline'), lastRev: priorRev }),
      { runner }
    );

    expect(result.ok).toBe(true);
    expect(result.baseline).toEqual({ mode: 'last-rev', lastRev: priorRev, resolved: true });
  });
});

// ---------------------------------------------------------------------------
// main — CLI usage errors
// ---------------------------------------------------------------------------

describe('main', () => {
  test('returns 2 and does not run anything when required args are missing', async () => {
    expect(await main([])).toBe(2);
  });

  test('returns 2 on an unknown option', async () => {
    expect(await main(['--nope'])).toBe(2);
  });
});
