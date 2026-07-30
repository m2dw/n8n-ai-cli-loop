/**
 * public-export.mjs
 *
 * Production-quality private-to-public snapshot export command (issue
 * #768, building on the local-only Copybara PoC from issue #767). Hides
 * Copybara/Java argument plumbing behind `npm run public:export` (a
 * no-public-side-effect dry run) and `npm run public:publish -- --yes`
 * (an explicit, separately-confirmed operator action).
 *
 * Unlike scripts/copybara-export.mjs, which only ever stages local
 * temporary Git repositories, this wrapper:
 *   - resolves the export revision from the PRIVATE REMOTE's `main` branch
 *     explicitly (via `git ls-remote`), never the operator's current
 *     branch or working tree state;
 *   - bare-clones the PUBLIC remote's actual current state as the SQUASH
 *     baseline, so the very first bootstrap run lands on top of its real
 *     (unrelated) history without a force-push or `git reset --hard`;
 *   - downloads/caches the pinned jar explicitly (scripts/copybara-jar-cache.mjs)
 *     rather than requiring an operator to pass one in by hand;
 *   - on `--publish`, pushes the validated SQUASH commit to a DEDICATED
 *     branch on the public remote (never `main`/`master`) and creates or
 *     updates a public Pull Request via `gh`.
 *
 * See docs/copybara-public-export.md for authentication, cache location,
 * failure recovery, and repeat-execution semantics.
 *
 * Run: node scripts/public-export.mjs --private-remote <url> --public-remote <url> [options]
 */

import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_CONFIG_TEMPLATE,
  DEFAULT_PIN_PATH,
  checkJavaVersion,
  defaultRunner,
  loadPin,
  runExport,
  runGit,
} from './copybara-export.mjs';
import { displayMatch } from './copybara-validate.mjs';
import { DEFAULT_CACHE_DIR, defaultDownload, ensureCachedJar } from './copybara-jar-cache.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

export const DEFAULT_BRANCH = 'copybara/public-sync';
export const DEFAULT_PR_BASE = 'main';

// ---------------------------------------------------------------------------
// Remote revision resolution — the private remote's actual `main`, never a
// local checkout or the operator's current/dirty branch.
// ---------------------------------------------------------------------------

const FULL_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;

/** Resolve `rev` to an exact commit SHA on `remoteUrl` via `git ls-remote`. */
export function resolveRemoteRevision({ remoteUrl, rev }, runner = defaultRunner) {
  if (FULL_SHA_PATTERN.test(rev)) return rev.toLowerCase();
  const result = runner.run('git', ['ls-remote', '--exit-code', remoteUrl, `refs/heads/${rev}`], {});
  if (result.exitCode !== 0) return null;
  const line = result.stdout.split('\n').find((l) => l.trim().length > 0);
  if (!line) return null;
  return line.split('\t')[0].trim();
}

/**
 * Read the `GitOrigin-RevId:` trailer off the current tip of `branch` on
 * `remoteUrl`, without ever checking out a working tree. Used to make
 * `--publish` idempotent: rerunning against the same private source
 * revision must not push a duplicate commit or open a duplicate PR.
 */
export function readRemoteBranchOriginRevId({ remoteUrl, branch, scratchDir }, runner = defaultRunner) {
  mkdirSync(scratchDir, { recursive: true });
  runGit(runner, ['init', '--quiet', '--bare', scratchDir], REPO_ROOT);
  const fetchResult = runner.run('git', ['fetch', '--quiet', '--depth', '1', remoteUrl, branch], { cwd: scratchDir });
  if (fetchResult.exitCode !== 0) return { exists: false, sourceRev: null, headSha: null };
  const headSha = runGit(runner, ['rev-parse', 'FETCH_HEAD'], scratchDir);
  const message = runGit(runner, ['log', '-1', '--format=%B', 'FETCH_HEAD'], scratchDir);
  const match = /GitOrigin-RevId:\s*(\S+)/.exec(message);
  return { exists: true, sourceRev: match ? match[1] : null, headSha };
}

/**
 * Determine whether the dedicated sync branch's prior export PR has already
 * merged into `prBase`, using GitHub's own PR state as the authoritative
 * source — never commit message text.
 *
 * issue #800 P1 review fix: an earlier revision of this check searched
 * `--pr-base`'s commit history for the recorded source revision as text
 * (either the `GitOrigin-RevId:` trailer or this tool's own PR body, which
 * a default GitHub squash message includes). That is unreliable: GitHub
 * lets the person merging edit or replace the squash commit message (e.g.
 * choosing "PR title only"), which need retain neither string — the search
 * then reports "not merged" for a PR that in fact merged, so the export
 * stages from the now-stale dedicated sync branch and the next PR presents
 * whatever `--pr-base` gained since the merge as deletions.
 *
 * issue #800 P1 review fix (second pass): querying `gh pr list --head
 * <branch> --base <prBase> --state merged` by branch name alone is also
 * unreliable once the dedicated sync branch is *reused* — its name doesn't
 * change across export runs, but its tip does. A PR's `headRefName` stays
 * "branch" forever even after it merges, so once any PR from this branch has
 * ever merged, that same query keeps matching it — even after the branch has
 * since been force-pushed to a new tip backing a newer, still-open PR. That
 * stale positive would make the export stage from `--pr-base` and drop the
 * open PR's prior content. Instead, this matches PRs by the sync branch's
 * *current* tip commit (`headSha`, from `readRemoteBranchOriginRevId`) via
 * `headRefOid`, and reports the state of that specific PR — not of whatever
 * PR historically had this branch name. If that can't be determined (no repo
 * slug, `gh` unavailable/unauthenticated, unexpected output, or no PR matches
 * the current tip at all), this fails closed rather than guessing either way
 * — guessing "not merged" risks the stale-branch deletions above; guessing
 * "merged" risks staging from `--pr-base` and dropping an actually-still-open
 * PR's content.
 */
export function checkSyncBranchMergedViaPr({ runner = defaultRunner, repoSlug, branch, prBase, headSha }) {
  if (!repoSlug) {
    return {
      ok: false,
      reason:
        'could not determine "owner/repo" from --public-remote (expected a github.com URL) — pass --repo-slug to check whether the dedicated sync branch\'s prior PR has already merged',
    };
  }
  const list = runner.run(
    'gh',
    ['pr', 'list', '--repo', repoSlug, '--head', branch, '--base', prBase, '--state', 'all', '--json', 'number,state,headRefOid'],
    {}
  );
  if (list.exitCode !== 0) {
    return {
      ok: false,
      reason: `gh pr list failed while checking whether "${branch}" has already merged into "${prBase}": ${list.stderr || list.stdout}`,
    };
  }
  let prs;
  try {
    prs = JSON.parse(list.stdout);
  } catch {
    return {
      ok: false,
      reason: `gh pr list returned non-JSON output while checking whether "${branch}" has already merged into "${prBase}"`,
    };
  }
  if (!Array.isArray(prs)) {
    return {
      ok: false,
      reason: `gh pr list returned non-JSON output while checking whether "${branch}" has already merged into "${prBase}"`,
    };
  }
  const current = prs.find((pr) => pr.headRefOid === headSha);
  if (!current) {
    return {
      ok: false,
      reason:
        `no pull request from "${branch}" into "${prBase}" matches the sync branch's current tip (${headSha}) — cannot ` +
        'tell whether that revision has already merged from a historical PR that may share the branch name; ' +
        'confirm the PR state manually and re-run',
    };
  }
  return { ok: true, merged: current.state === 'MERGED' };
}

/**
 * Recover the baseline when the dedicated sync branch itself no longer
 * exists on the public remote (issue #800 P1 review fix).
 *
 * `readRemoteBranchOriginRevId` reports `exists: false` both for a
 * genuinely first export AND for a repository where GitHub's "automatically
 * delete head branches" setting removed the sync branch the moment its
 * prior export PR merged. Treating the latter as a first export would force
 * every ordinary repeat run to supply `--init-history`/`--last-rev` by hand
 * again, forever, which contradicts the intended repeat-run flow. Before
 * failing closed, look for this tool's own most recently merged PR from
 * `branch` into `prBase` — `gh` retains a merged PR's `headRefName` and body
 * even after the branch ref is deleted — and read back the source revision
 * it recorded (the same `- Private source revision: \`<sha>\`` line
 * `buildPrBody` writes). If none is found, this is a genuine first export.
 */
export function recoverBaselineFromMergedPr({ runner = defaultRunner, repoSlug, branch, prBase }) {
  if (!repoSlug) {
    return {
      ok: false,
      reason:
        'could not determine "owner/repo" from --public-remote (expected a github.com URL) — pass --repo-slug to recover the baseline from a previously merged export PR',
    };
  }
  const list = runner.run(
    'gh',
    ['pr', 'list', '--repo', repoSlug, '--head', branch, '--base', prBase, '--state', 'merged', '--json', 'number,body,mergedAt'],
    {}
  );
  if (list.exitCode !== 0) {
    return {
      ok: false,
      reason: `gh pr list failed while looking for a previously merged export PR from "${branch}" into "${prBase}": ${list.stderr || list.stdout}`,
    };
  }
  let prs;
  try {
    prs = JSON.parse(list.stdout);
  } catch {
    prs = null;
  }
  if (!Array.isArray(prs)) {
    return {
      ok: false,
      reason: `gh pr list returned non-JSON output while looking for a previously merged export PR from "${branch}" into "${prBase}"`,
    };
  }
  if (prs.length === 0) {
    return { ok: false, reason: `no previously merged export PR found from "${branch}" into "${prBase}"` };
  }
  const latest = prs.slice().sort((a, b) => new Date(b.mergedAt) - new Date(a.mergedAt))[0];
  const match = /Private source revision:\s*`([0-9a-fA-F]+)`/.exec(latest.body ?? '');
  if (!match) {
    return {
      ok: false,
      reason: `merged PR #${latest.number} from "${branch}" into "${prBase}" does not carry a recognizable source revision line`,
    };
  }
  return { ok: true, sourceRev: match[1], prNumber: latest.number };
}

// ---------------------------------------------------------------------------
// GitHub PR creation/update — a thin `gh` CLI wrapper, no GitHub SDK/token
// handling of our own; `gh` resolves auth from its own config or
// GH_TOKEN/GITHUB_TOKEN, which is never read or logged here.
// ---------------------------------------------------------------------------

/**
 * git/gh error output sometimes echoes the remote URL back verbatim (e.g.
 * "fatal: unable to access 'https://user:token@host/...'"). Strip any
 * userinfo component before a failure reason is ever printed, so a
 * credential embedded in --private-remote/--public-remote can't end up in
 * this tool's own logs.
 */
export function redactCredentialsInText(text) {
  return String(text).replace(/:\/\/[^/@\s]+@/g, '://[REDACTED]@');
}

/** Extract "owner/repo" from a github.com remote URL (https, ssh, or scp-like). */
export function parseGithubRepoSlug(remoteUrl) {
  const match = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remoteUrl);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function buildPrTitle(sourceRev) {
  return `Public snapshot export: ${sourceRev.slice(0, 12)}`;
}

/**
 * Body text is deliberately limited to the source revision (a SHA — not a
 * local path or secret), the branch/base names, and a fixed validation
 * statement (we only ever reach here after scanTree passed) — never a
 * local workdir path, a remote URL, or anything from copybara-jar-cache's
 * download step.
 */
export function buildPrBody({ sourceRev, branch, base, alreadyPublished, baseline, baselineLine }) {
  const lines = [
    'Automated private-to-public snapshot export.',
    '',
    `- Private source revision: \`${sourceRev}\``,
  ];
  if (baseline?.mode === 'init-history') {
    lines.push('- Baseline: established via `--init-history` (the destination\'s current tip was treated as the pre-export baseline).');
  } else if (baseline?.mode === 'last-rev') {
    lines.push(
      `- Baseline: ${baseline.auto ? 'recorded automatically from the previous export on this sync branch' : 'set explicitly via `--last-rev`'} (\`${baseline.lastRev}\`).`
    );
  } else if (baselineLine) {
    // Idempotent rerun (issue #800 P2): no local export ran this time, so
    // there is no fresh `baseline` decision to describe — carry forward the
    // exact line the initial publish recorded rather than silently dropping
    // it when `gh pr edit` overwrites the PR body.
    lines.push(baselineLine);
  }
  lines.push(
    '- Validation: clean — no personal paths, credentials, private repository identifiers, or forbidden paths found in the transformed tree.',
    `- Sync branch: \`${branch}\` -> \`${base}\``,
    '',
    'No private commit history or commit messages are included in this export.'
  );
  if (alreadyPublished) {
    lines.push('', 'No content changes since the previous export of this revision; this run only confirmed the pull request is up to date.');
  }
  return lines.join('\n');
}

/**
 * Pull the literal `- Baseline: ...` line back out of a previously generated
 * PR body (issue #800 P2), so an idempotent `--publish` rerun — which skips
 * the local export entirely and therefore has no fresh `baseline` decision
 * to describe — can carry it forward into the regenerated body instead of
 * silently losing it when `gh pr edit` overwrites the old one.
 */
export function extractBaselineLine(body) {
  const match = /^- Baseline:.*$/m.exec(body ?? '');
  return match ? match[0] : null;
}

/** Fetch the current body of the PR for `branch`, or null if it can't be read (no PR yet, no repo slug, gh failure). */
export function readExistingPrBody({ runner = defaultRunner, repoSlug, branch }) {
  if (!repoSlug) return null;
  const view = runner.run('gh', ['pr', 'view', branch, '--repo', repoSlug, '--json', 'body'], {});
  if (view.exitCode !== 0) return null;
  try {
    return JSON.parse(view.stdout).body ?? null;
  } catch {
    return null;
  }
}

export function ensurePullRequest({ runner = defaultRunner, repoSlug, branch, base, title, body }) {
  if (!repoSlug) {
    return { ok: false, reason: 'could not determine "owner/repo" from --public-remote (expected a github.com URL)' };
  }
  const view = runner.run('gh', ['pr', 'view', branch, '--repo', repoSlug, '--json', 'number,url,state'], {});
  if (view.exitCode === 0) {
    let info;
    try {
      info = JSON.parse(view.stdout);
    } catch {
      return { ok: false, reason: `gh pr view returned non-JSON output: ${view.stdout.slice(0, 200)}` };
    }
    if (info.state === 'OPEN') {
      const edit = runner.run(
        'gh',
        ['pr', 'edit', String(info.number), '--repo', repoSlug, '--title', title, '--body', body],
        {}
      );
      if (edit.exitCode !== 0) return { ok: false, reason: edit.stderr || edit.stdout };
      return { ok: true, action: 'updated', number: info.number, url: info.url };
    }
  }
  const create = runner.run(
    'gh',
    ['pr', 'create', '--repo', repoSlug, '--base', base, '--head', branch, '--title', title, '--body', body],
    {}
  );
  if (create.exitCode !== 0) return { ok: false, reason: create.stderr || create.stdout };
  const url = create.stdout.trim().split('\n').filter(Boolean).pop();
  return { ok: true, action: 'created', url };
}

// ---------------------------------------------------------------------------
// Argument parsing — unknown options fail closed; publication requires both
// an explicit --publish flag AND a separate --yes confirmation, and never
// targets the public repo's own default branch.
// ---------------------------------------------------------------------------

const FLAGS_WITH_VALUE = new Set([
  '--private-remote',
  '--public-remote',
  '--repo-slug',
  '--rev',
  '--branch',
  '--pr-base',
  '--jar',
  '--jar-cache-dir',
  '--pin',
  '--config',
  '--workdir',
  '--pr-title',
  '--workflow',
  '--last-rev',
]);
const FLAGS_WITHOUT_VALUE = new Set(['--dry-run', '--publish', '--yes', '--init-history']);
const KNOWN_FLAGS = new Set([...FLAGS_WITH_VALUE, ...FLAGS_WITHOUT_VALUE]);

export function parseArgs(argv) {
  const opts = { rev: 'main', branch: DEFAULT_BRANCH, prBase: DEFAULT_PR_BASE };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!KNOWN_FLAGS.has(flag)) {
      return { ok: false, reason: `unknown option "${flag}"` };
    }
    if (FLAGS_WITH_VALUE.has(flag)) {
      const value = argv[++i];
      if (value === undefined) return { ok: false, reason: `option "${flag}" requires a value` };
      switch (flag) {
        case '--private-remote': opts.privateRemote = value; break;
        case '--public-remote': opts.publicRemote = value; break;
        case '--repo-slug': opts.repoSlug = value; break;
        case '--rev': opts.rev = value; break;
        case '--branch': opts.branch = value; break;
        case '--pr-base': opts.prBase = value; break;
        case '--jar': opts.jarPath = value; break;
        case '--jar-cache-dir': opts.jarCacheDir = value; break;
        case '--pin': opts.pinPath = value; break;
        case '--config': opts.configPath = value; break;
        case '--workdir': opts.workdir = value; break;
        case '--pr-title': opts.prTitle = value; break;
        case '--workflow': opts.workflowName = value; break;
        case '--last-rev': opts.lastRev = value; break;
      }
    } else {
      switch (flag) {
        case '--dry-run': opts.dryRun = true; break;
        case '--publish': opts.publish = true; break;
        case '--yes': opts.yes = true; break;
        case '--init-history': opts.initHistory = true; break;
      }
    }
  }
  return { ok: true, opts };
}

export function validateOpts(opts) {
  if (!opts.privateRemote) return { ok: false, reason: 'missing required --private-remote <url>' };
  if (!opts.publicRemote) return { ok: false, reason: 'missing required --public-remote <url>' };
  if (opts.dryRun && opts.publish) return { ok: false, reason: '--dry-run and --publish are mutually exclusive' };
  if (opts.publish && !opts.yes) return { ok: false, reason: '--publish requires --yes to confirm public mutation' };
  if (opts.yes && !opts.publish) return { ok: false, reason: '--yes has no effect without --publish' };
  if (opts.initHistory && opts.lastRev) {
    return { ok: false, reason: '--init-history and --last-rev are mutually exclusive — choose one explicit baseline mechanism' };
  }
  if (opts.branch === opts.prBase || opts.branch === 'main' || opts.branch === 'master') {
    return {
      ok: false,
      reason: `--branch must not be the public repository's default branch ("${opts.branch}") — publication only ever targets a dedicated sync branch`,
    };
  }
  return { ok: true, opts };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Dry run (opts.publish falsy) performs the complete local pipeline —
 * resolve revision, Java preflight, jar cache/download, migrate, validate —
 * and stops: prepareOriginRepo/prepareDestinationRepo only ever read from
 * the private/public remotes (clone/bare-clone), never push to them, so
 * nothing above is a public side effect regardless of --publish.
 *
 * --publish additionally pushes the validated commit to a dedicated branch
 * on the public remote and creates/updates a PR. If the public remote's
 * dedicated branch already carries this exact source revision (checked
 * before doing any of the local migrate/validate work), the run is a no-op
 * beyond confirming the PR is still open and up to date.
 *
 * Baseline selection (issue #800): Copybara determines what changed by
 * resolving a `GitOrigin-RevId` trailer, and the public destination's own
 * history predates this tool (or may carry a trailer left over from an
 * unrelated one-off snapshot) — resolving it there is exactly what produces
 * the "Cannot resolve reference"/"Cannot find last imported revision"
 * failure this issue is about. This tool never lets Copybara try that: it
 * always renders an explicit `--init-history` or `--last-rev` into the
 * migrate invocation instead (scripts/copybara-export.mjs#runExport), taken
 * from, in priority order:
 *   1. `--init-history`/`--last-rev` passed explicitly by the operator.
 *   2. The `GitOrigin-RevId` this tool itself already recorded on the
 *      dedicated sync branch's current tip, from a previous run — this is
 *      what makes every run *after* the first ordinary, with no repeated
 *      flags (`readRemoteBranchOriginRevId` against `opts.branch`, already
 *      used for --publish idempotency below, doubles as this baseline
 *      source, and `runExport` independently re-verifies it still resolves
 *      in the origin before trusting it).
 *   3. Neither: this is the first export ever attempted against this public
 *      remote/branch — fails closed at the `baseline` stage with an
 *      actionable message, before Java/the jar are even touched.
 */
export async function runPublicExport(opts, deps = {}) {
  const runner = deps.runner ?? defaultRunner;
  const download = deps.download ?? defaultDownload;

  const workdir = resolve(opts.workdir ?? mkdtempSync(join(tmpdir(), 'public-export-')));
  mkdirSync(workdir, { recursive: true });

  const pinPath = resolve(opts.pinPath ?? DEFAULT_PIN_PATH);
  const pin = loadPin(pinPath);

  const rev = opts.rev ?? 'main';
  const sourceRev = resolveRemoteRevision({ remoteUrl: opts.privateRemote, rev }, runner);
  if (!sourceRev) {
    return { ok: false, stage: 'resolve-rev', reason: `could not resolve "${rev}" on the private remote` };
  }

  // Always read the sync branch's own recorded state — used both for
  // --publish idempotency below and (for both dry-run and --publish) to
  // auto-derive the baseline `--last-rev`, so an operator only ever needs
  // --init-history/--last-rev on the very first export against a given
  // public remote/branch.
  const existing = readRemoteBranchOriginRevId(
    { remoteUrl: opts.publicRemote, branch: opts.branch, scratchDir: join(workdir, 'branch-check') },
    runner
  );
  const alreadyPublished = Boolean(opts.publish) && existing.exists && existing.sourceRev === sourceRev;
  const repoSlug = opts.repoSlug ?? parseGithubRepoSlug(opts.publicRemote);

  let exportResult = null;
  let exportDestBranch = opts.branch;
  let syncBranchMerged = false;
  if (!alreadyPublished) {
    let initHistory = Boolean(opts.initHistory);
    let lastRev = opts.lastRev ?? null;
    let baselineAuto = false;
    if (!initHistory && !lastRev) {
      if (existing.exists && existing.sourceRev) {
        lastRev = existing.sourceRev;
        baselineAuto = true;
      } else {
        // issue #800 P1 review fix: the dedicated sync branch may be absent
        // not because this is a first export, but because GitHub's
        // "automatically delete head branches" setting removed it the
        // moment its prior export PR merged. Recover the baseline from that
        // merged PR's own recorded source revision before concluding this is
        // genuinely a first export.
        const recovered = recoverBaselineFromMergedPr({ runner, repoSlug, branch: opts.branch, prBase: opts.prBase });
        if (recovered.ok) {
          lastRev = recovered.sourceRev;
          baselineAuto = true;
        } else {
          return {
            ok: false,
            stage: 'baseline',
            reason:
              `no previous export was found on the dedicated sync branch "${opts.branch}" of the public remote, and none could be recovered from a previously merged export PR either (${recovered.reason}) — this looks like the first export against this destination, and the public destination's own history cannot be safely used to infer one (see issue #800). ` +
              'Re-run with --init-history (recommended for a first baseline) or --last-rev <private-sha> to select the starting revision explicitly. Do not retry with --force.',
            sourceRev,
          };
        }
      }
    }

    // Repeat exports (issue #800 P1): once the dedicated sync branch already
    // carries a prior export, ITS tip — not --pr-base, which may not contain
    // an as-yet-unmerged prior sync PR — is the tree the selected baseline
    // revision was actually diffed against. Basing a repeat export on
    // --pr-base while diffing from a --last-rev that only exists on the sync
    // branch produces a destination tree that is missing everything the prior
    // export already carried. Only a genuinely first export (nothing recorded
    // on the sync branch yet) lands on top of --pr-base's real (unrelated)
    // public history.
    //
    // But once that prior sync PR has actually merged, --pr-base has already
    // advanced to include it (and possibly other, unrelated changes since).
    // The sync branch tip is then stale: staging on top of it would produce a
    // head that omits whatever --pr-base gained after the merge (including
    // destination-owned paths), and the resulting PR would show those as
    // reversions — a squash merge would then apply those removals to the
    // public branch. issue #800 P1 review fix: this is checked via GitHub's
    // own PR state (`checkSyncBranchMergedViaPr`), not by searching commit
    // message text, and fails closed (stage "merge-check") rather than
    // guessing when that can't be determined.
    if (existing.exists && existing.sourceRev) {
      const mergeCheck = checkSyncBranchMergedViaPr({ runner, repoSlug, branch: opts.branch, prBase: opts.prBase, headSha: existing.headSha });
      if (!mergeCheck.ok) {
        return { ok: false, stage: 'merge-check', reason: mergeCheck.reason, sourceRev };
      }
      syncBranchMerged = mergeCheck.merged;
    }
    exportDestBranch = existing.exists && !syncBranchMerged ? opts.branch : opts.prBase;

    const java = checkJavaVersion(runner, pin.javaMinVersion);
    if (!java.ok) return { ok: false, stage: 'java', reason: java.reason };

    let jarPath;
    if (opts.jarPath) {
      jarPath = resolve(opts.jarPath);
    } else {
      const cached = await ensureCachedJar({ pin, cacheDir: opts.jarCacheDir ?? DEFAULT_CACHE_DIR, download });
      if (!cached.ok) return { ok: false, stage: cached.stage ?? 'jar-cache', reason: cached.reason };
      jarPath = cached.jarPath;
    }

    exportResult = runExport(
      {
        sourceRepoPath: opts.privateRemote,
        rev: sourceRev,
        baselinePath: opts.publicRemote,
        destBranch: exportDestBranch,
        jarPath,
        pinPath,
        configTemplate: opts.configPath ?? DEFAULT_CONFIG_TEMPLATE,
        workflowName: opts.workflowName,
        workdir,
        initHistory,
        lastRev,
      },
      runner
    );
    if (!exportResult.ok) return exportResult;
    if (exportResult.baseline && baselineAuto) exportResult.baseline.auto = true;
  }

  if (!opts.publish) {
    return { ok: true, mode: 'dry-run', sourceRev, destCheckoutDir: exportResult.destCheckoutDir, baseline: exportResult.baseline };
  }

  const title = opts.prTitle ?? buildPrTitle(sourceRev);

  if (alreadyPublished) {
    const baselineLine = extractBaselineLine(readExistingPrBody({ runner, repoSlug, branch: opts.branch }));
    const pr = ensurePullRequest({
      runner,
      repoSlug,
      branch: opts.branch,
      base: opts.prBase,
      title,
      body: buildPrBody({ sourceRev, branch: opts.branch, base: opts.prBase, alreadyPublished: true, baselineLine }),
    });
    if (!pr.ok) return { ok: false, stage: 'pr', reason: pr.reason, sourceRev };
    return { ok: true, mode: 'publish', alreadyPublished: true, sourceRev, pr };
  }

  // issue #800 P1 review fix: the merge check above ran before the
  // Java/download/export work, which can take long enough for the prior sync
  // PR to merge in the meantime. `exportDestBranch` was already chosen off
  // that now-stale read, so re-check the authoritative PR state right before
  // the force-push — the last possible moment to catch it — and fail closed
  // rather than push a tree staged against a base that has since moved.
  if (existing.exists && existing.sourceRev) {
    const revalidate = checkSyncBranchMergedViaPr({ runner, repoSlug, branch: opts.branch, prBase: opts.prBase, headSha: existing.headSha });
    if (!revalidate.ok) {
      return { ok: false, stage: 'merge-check', reason: revalidate.reason, sourceRev };
    }
    if (revalidate.merged !== syncBranchMerged) {
      return {
        ok: false,
        stage: 'merge-check-stale',
        reason:
          `the sync branch "${opts.branch}"'s merge status into "${opts.prBase}" changed while this export was running ` +
          `(was ${syncBranchMerged ? 'merged' : 'not yet merged'}, is now ${revalidate.merged ? 'merged' : 'not yet merged'}). ` +
          'The export staged above was built for the earlier state and may be missing changes since made to the base, or may omit the base entirely. ' +
          'Re-run the export (this will re-select the destination branch against current state) before publishing. Do not retry with --force.',
        sourceRev,
      };
    }
  }

  const pushResult = runner.run(
    'git',
    ['push', '--quiet', '--force', opts.publicRemote, `refs/heads/${exportDestBranch}:refs/heads/${opts.branch}`],
    { cwd: exportResult.destDir }
  );
  if (pushResult.exitCode !== 0) {
    return { ok: false, stage: 'push', reason: pushResult.stderr || pushResult.stdout, sourceRev };
  }

  const pr = ensurePullRequest({
    runner,
    repoSlug,
    branch: opts.branch,
    base: opts.prBase,
    title,
    body: buildPrBody({ sourceRev, branch: opts.branch, base: opts.prBase, alreadyPublished: false, baseline: exportResult.baseline }),
  });
  if (!pr.ok) return { ok: false, stage: 'pr', reason: pr.reason, sourceRev };

  return { ok: true, mode: 'publish', alreadyPublished: false, sourceRev, pr, baseline: exportResult.baseline };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.error(
    [
      'Usage: node scripts/public-export.mjs --private-remote <url> --public-remote <url> [options]',
      '',
      'Dry run (default, no public side effects):',
      '  npm run public:export -- --private-remote <url> --public-remote <url>',
      '',
      'Publish (explicit operator action):',
      '  npm run public:publish -- --private-remote <url> --public-remote <url> --yes',
      '',
      'Options:',
      '  --rev <ref>              branch on the private remote to export (default: main)',
      '  --branch <name>          dedicated public sync branch (default: copybara/public-sync)',
      '  --pr-base <branch>       public base branch for the PR (default: main)',
      '  --repo-slug <owner/repo> override "owner/repo" for gh (default: parsed from --public-remote)',
      '  --jar <path>             use an explicit local jar instead of the cache',
      '  --jar-cache-dir <dir>    override the jar cache directory',
      '  --pin <path>             override copybara/PIN.json',
      '  --config <path>          override copybara/copy.bara.sky',
      '  --workdir <dir>          override the local scratch workdir',
      '  --pr-title <title>       override the generated PR title',
      '  --workflow <name>        override the Copybara workflow name',
      '  --init-history           first-baseline: treat the public destination\'s current tip as the pre-export baseline (mutually exclusive with --last-rev)',
      '  --last-rev <sha>         first-baseline: pin the exact private revision Copybara should diff from (mutually exclusive with --init-history)',
      '  --publish                push a dedicated sync branch and open/update a PR (requires --yes)',
      '  --yes                    confirm --publish',
      '  --dry-run                explicit no-op (this is the default when --publish is absent)',
    ].join('\n')
  );
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(`public-export: ${parsed.reason}`);
    printUsage();
    return 2;
  }
  const validated = validateOpts(parsed.opts);
  if (!validated.ok) {
    console.error(`public-export: ${validated.reason}`);
    return 2;
  }

  const result = await runPublicExport(validated.opts);
  if (!result.ok) {
    console.error(`public-export: FAILED at stage "${result.stage}" — ${redactCredentialsInText(result.reason)}`);
    if (result.findings) {
      for (const f of result.findings) {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        console.error(`  [${f.rule}] ${loc} — ${f.description}: ${displayMatch(f)}`);
      }
    }
    return 1;
  }

  if (result.mode === 'dry-run') {
    console.log(`public-export: DRY RUN OK — source revision ${result.sourceRev} validated clean.`);
    console.log(`  transformed tree (local only, not pushed): ${result.destCheckoutDir}`);
    console.log('  re-run with --publish --yes to push a dedicated sync branch and open/update a PR.');
  } else {
    console.log(`public-export: PUBLISHED — source revision ${result.sourceRev}`);
    console.log(`  ${result.alreadyPublished ? 'already up to date' : 'pushed dedicated sync branch'}; PR ${result.pr.action}: ${result.pr.url ?? '(unknown URL)'}`);
  }
  if (result.baseline?.mode === 'init-history') {
    console.log('  baseline: --init-history (destination tip treated as the pre-export baseline)');
  } else if (result.baseline?.mode === 'last-rev') {
    console.log(`  baseline: --last-rev ${result.baseline.lastRev}${result.baseline.auto ? ' (recorded automatically from the previous export)' : ' (explicit)'}`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
