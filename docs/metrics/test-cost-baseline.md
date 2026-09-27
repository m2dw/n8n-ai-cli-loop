# Test-cost baseline (Test Maintenance Pilot, slice 1)

Issue #1109. This is a maintenance report: it changes no test, assertion,
default worker count or workflow behaviour, and it runs no mutation testing.

## Status: one complete baseline (build + two complete Jest runs)

| Field | Value |
|---|---|
| Tested SHA | `9b278b20dea296a136704d02bb56e3247927fdd9`, clean worktree (checked before the build; the post-build recheck below was added after this run). It is the activation reference `a9391bf72e3c826258e990285e9954a3e0fad40a` (PR #1148) plus only this slice's `.gitignore` line, script, script test and this report, so the only suite not present at `a9391bf7` is `test-cost-baseline-script.test.js`. |
| Measured at | 2026-09-13 17:53–18:04 UTC |
| Command | `nohup node scripts/test-cost-baseline.mjs --repeat 2 --max-workers 4 > .test-cost/run.log 2>&1 < /dev/null &` |
| Runtime | Node v22.6.0, npm 10.8.2, Jest 29.7.0, TypeScript 6.0.3 |
| Host | darwin 24.6.0 arm64, 8 CPUs, 24576 MB; shared with other projects (not exclusive) |
| Jest workers | 4 (`--maxWorkers=4`; the project default is unchanged) |
| Runs | build: complete; test run 1: complete; test run 2: complete; interrupted runs: 0 |

### Build and test cost, kept apart

| Phase | Command | State | Wall time | 1/5/15-min load before → after | Free memory after |
|---|---|---|---|---|---|
| build | `npm run build` | complete (exit 0) | 6.4 s | 3.08/2.83/2.89 → 3.00/2.82/2.88 | 855 MB |
| test run 1 | `node --experimental-vm-modules node_modules/.bin/jest --json --outputFile=.test-cost/jest-run-1.json --maxWorkers=4` | complete (exit 0) | 334.2 s | 3.00/2.82/2.88 → 4.58/3.96/3.44 | 2594 MB |
| test run 2 | same, `jest-run-2.json` | complete (exit 0) | 334.1 s | 4.58/3.96/3.44 → 6.83/5.58/4.34 | 2626 MB |

The test runs call Jest directly, so no build time is inside the 334 s. `npm
test` would add `pretest` (the build) on top.

| Run | Suites | Tests | Passed | Failed | Skipped | Sum of suite durations | Suites > 10 s / > 30 s / > 60 s |
|---|---|---|---|---|---|---|---|
| 1 | 311 (1 skipped suite) | 13387 | 13379 | 0 | 8 | 1332.1 s | 36 / 17 / 2 |
| 2 | 311 (1 skipped suite) | 13387 | 13379 | 0 | 8 | 1330.2 s | 33 / 14 / 3 |

Suite durations are Jest's per-file wall time (`endTime - startTime`, module
load included). Four workers run suites in parallel, so the sum is about four
times the wall time and does not add up to it. The median suite took under
0.2 s. The 20 slowest suites account for 856 s (run 1) and 937 s (run 2) of
the sum, about two thirds of it.

Failures: none in either run. Flake candidates: none observed. Two identical
passing runs cannot rule out flakes.

### Top 20 suites by median duration (both complete runs)

| Suite (`test/`) | Tests | Median | Max | Samples |
|---|---|---|---|---|
| `admin-chain-edit.test.js` | 53 | 172.8 s | 219.4 s | 2 |
| `review-dispute-default-path-e2e.test.js` | 23 | 62.0 s | 89.7 s | 2 |
| `run-one-phase-cli.test.js` | 33 | 53.2 s | 82.9 s | 2 |
| `admin-tool-request-direct-review.test.js` | 15 | 47.2 s | 63.0 s | 2 |
| `admin-tool-request.test.js` | 50 | 39.2 s | 40.6 s | 2 |
| `codex-structured-review.test.js` | 42 | 37.8 s | 43.9 s | 2 |
| `admin-chain-advanced.test.js` | 8 | 37.5 s | 52.3 s | 2 |
| `admin-review-verification-refresh.test.js` | 13 | 34.6 s | 55.0 s | 2 |
| `admin-tool-request-grant.test.js` | 72 | 32.7 s | 33.8 s | 2 |
| `issue-refinement-observability.test.js` | 34 | 29.8 s | 30.7 s | 2 |
| `admin-cli.test.js` | 201 | 28.9 s | 34.9 s | 2 |
| `admin-tool-request-run.test.js` | 18 | 28.7 s | 30.3 s | 2 |
| `admin-task-reconcile-merged.test.js` | 27 | 28.2 s | 46.3 s | 2 |
| `admin-chain-inspect.test.js` | 22 | 28.0 s | 35.0 s | 2 |
| `admin-n8n-deploy.test.js` | 35 | 27.2 s | 34.7 s | 2 |
| `admin-review-verification.test.js` | 38 | 26.2 s | 43.6 s | 2 |
| `admin-context-mode-status.test.js` | 17 | 25.8 s | 50.2 s | 2 |
| `admin-chain-sync.test.js` | 24 | 23.9 s | 32.9 s | 2 |
| `public-export.test.js` | 81 | 23.6 s | 24.7 s | 2 |
| `admin-retention.test.js` | 11 | 23.3 s | 28.7 s | 2 |

With two samples, the median is the mean of the two runs. A large gap
between median and max (for example `admin-chain-edit.test.js`,
`admin-context-mode-status.test.js`) points to sensitivity to host load or
to which suites share the workers at the same moment. It is not a
per-test cost.

### How this table was produced

The run's own `.test-cost/report.md` printed every per-suite duration as
`unknown` and ranked nothing. The script read `perfStats`, but Jest's `--json`
output has `startTime`/`endTime` instead. The script now reads those fields,
and a focused test covers them. The table above was computed from the same
raw `.test-cost/jest-run-1.json` and `jest-run-2.json` by that rule
(`endTime - startTime`, median over the two runs, top 20). No run was
repeated or re-selected. Replaying the command below at the fixed script
produces the same kind of table directly.

### Earlier interrupted attempts (not baseline data)

Eight earlier attempts ran the same command in the foreground through a
Tool Request guided-run. Each was stopped by that executor's fixed 120 s
deadline (`spawnSync /bin/sh ETIMEDOUT`) at about 113 s into test run 1, after
builds of 6.6–6.9 s. The script recorded them as `interrupted
(parent-signal:SIGTERM)`, and no per-suite value from them is used here. The
suite times those runs printed came from whichever suites were scheduled first.
They are superseded by the complete runs above. The ninth attempt started the
same command detached (`nohup … &`), so the executor's call still reported
`ETIMEDOUT`, but the measurement ran to completion under the script's own
limits.

## Replayable commands

Use a clean checkout of the SHA you are measuring. Other projects may be using
the host, so run the commands as they are and record the load; do not stop
unrelated processes.

```sh
git rev-parse HEAD
npm ci                       # only if node_modules is missing or stale
node scripts/test-cost-baseline.mjs --repeat 2 --max-workers 4
```

A full run takes about 11–12 minutes on this host. That doesn't fit a
short-deadline executor such as guided-run (120 s), so start the same command
detached there. The run keeps its own 15/45 minute limits:

```sh
mkdir -p .test-cost && nohup node scripts/test-cost-baseline.mjs --repeat 2 --max-workers 4 > .test-cost/run.log 2>&1 < /dev/null &
```

The run is finished when `.test-cost/run.log` ends with the `wrote …` line.

- The build (`npm run build`) is timed on its own, once. Jest then runs
  directly with `node --experimental-vm-modules node_modules/jest/bin/jest.js --json
  --outputFile=.test-cost/jest-run-N.json`, so `pretest` never adds build time
  to a test measurement. (The measured rows above were recorded with the
  equivalent POSIX shim `node_modules/.bin/jest`.) npm and Jest are started
  without a shell, through their JavaScript entry points on Windows.
- Worktree cleanliness is recorded twice: once before anything runs
  (`worktreeDirty`) and once after the build, before the first measured run
  (`worktreeDirtyAfterBuild`, with the changed paths). The build regenerates the
  checked-in workflow JSON when it is stale, so without the second check a report
  could claim a clean, commit-identical measurement of code that no longer matches
  the recorded commit. The second check ignores only the individual files this
  script writes (`baseline.json`, `report.md`, `jest-run-N.json`), never the whole
  `--out` directory, so pointing `--out` at a tracked directory cannot hide a
  regenerated tracked file that sits beside them.
- `--repeat` is capped at 3. The defaults are 15 minutes for the build and 45
  minutes per test run, so the total time is bounded. A run that times out, is
  killed or leaves no JSON is marked `interrupted`, and all of its per-suite
  values stay `unknown`. The suite Jest printed last is never blamed for the
  timeout.
- Leave out `--max-workers` to measure with Jest's default. The worker count is
  recorded either way (on the default path, the count Jest resolves from the
  host's available parallelism), and the default path is unchanged. Arguments in
  the recorded commands are shell-quoted when needed so they replay verbatim. A value above the
  process's available parallelism (which honours CPU affinity and container
  quotas) is rejected.
- A failure counts as a flake candidate only if the same test passed in another
  complete run. If another run never executed it (for example, its suite failed
  to load), the failure is listed as unclassified.
- The output goes to `.test-cost/`, which is gitignored: raw Jest JSON,
  `baseline.json` and `report.md`. Paths in the summary are relative to the
  checkout, with `<home>` and `<tmp>` masked. Check `report.md` before copying
  any of it here. Nothing is uploaded.

### Staged-verification workload (estimate, kept separate)

Staged verification is not turned on here, and no session settings were
changed. The #1108 count-based replay this section originally cited no longer
exists: issue #1155 retired the group-selection policy and removed
`scripts/staged-verification-baseline.mjs` with it, so there is no check-count
estimator to feed wall times to. No staged-workload estimate is produced by
this slice.

The estimator that does ship today is the bounded, opt-in stage stopwatch from
issue #1156, which measures the two changed-file stages instead of deriving
them from counts:

```sh
node scripts/changed-file-stage-timing.mjs --base-branch main \
  --json .test-cost/stage-timing.json
```

It runs only when an operator invokes it, needs a branch with changed test
files to have a Stage 1 to measure, and reports Stage 2 as the whole suite —
so its Stage 2 number is the same full-suite cost measured above, not an
additional workload. `--skip-full` measures Stage 1 alone. Nothing in this
slice ran it; the figures above remain ordinary full-suite cost only.

For reference, the full-suite wall time this report measured is 340.5 s: build
6.4 s plus the 334.1 s test run. `npm test` and `npm run package` both include
the build. Typecheck time was not measured.

## Static inventory at `a9391bf7` (measured counts, not durations)

| Metric | Count | Replay |
|---|---|---|
| Test files (`test/*.test.js`) | 310 | `ls test/*.test.* \| wc -l` |
| `test`/`it` call sites | 12607 | `rg -o -e "^\s*(?:test\|it)(?:\.each)?\s*[(\`]" test --glob '*.test.*' \| wc -l` |
| `describe` call sites | 2233 | same pattern with `describe` |
| Files importing `child_process` | 77 | `rg -l child_process test --glob '*.test.*' \| wc -l` |
| Files using `mkdtemp` (temporary directories/repos) | 152 | `rg -l mkdtemp …` |
| Files running `git init` | 28 | `rg -l -e "\['init'\|'init'," …` |
| Files using SQLite | 99 | `rg -l "better-sqlite3\|Sqlite" …` |
| Files calling `runNextPhase` (full phase pipeline) | 33 | `rg -l runNextPhase …` |
| Files referencing `dist/cli` or `dist/index.js` (a lower bound on suites needing a prior build) | 154 | `rg -l "dist/cli\|dist/index.js" …` |
| Files using the in-process admin harness (#1018) | 11 | `rg -l helpers/admin-cli …` |

Call sites count the tests written in the source. They don't count tests at
runtime: `test.each` expands into several, and skipped tests are included.
The measured runtime count is 13387 tests in 311 suites.

Files with the most subprocess call sites (`spawnSync|spawn|execFileSync|execFile|execSync|fork(`):
`admin-tool-request.test.js` 63, `admin-tool-request-grant.test.js` 61,
`implementation-handler.test.js` 16, `admin-agent-profile-refresh.test.js` 10,
`worktree.test.js` 8, `research-worktree.test.js` 7,
`antigravity-cli-smoke.test.js` 7. A call site is not the same as a process
started. A helper called in a loop starts many processes from one site, and
some sites never run.

Files with the most `git init` sites: `worktree.test.js` 7,
`implementation-handler.test.js` 6, `admin-cli.test.js` 3.

Shared setup: a single Jest `globalSetup` creates the test-owned HOME (#1063),
and a per-worker `setupFiles` hook re-applies it. No global build step runs
inside Jest. Every suite that imports `dist/` depends on the earlier
`npm run build`.

Most of the measured top 20 are `admin-*` CLI suites that start `dist/` CLI
processes or temporary repositories. That matches the static indicators, but
the static counts alone did not predict the order: for example,
`admin-chain-edit.test.js` is not among the highest subprocess call-site
counts. Later slices should rank by the measured table, not by the static
counts.

## Limitations

- Two complete runs on one shared host at four workers. Load rose during
  the runs (1-min 3.00 → 6.83), and other projects were active. Suite times
  depend on worker count and contention, and two samples give no spread
  estimate.
- Per-suite duration is wall time inside a worker, module load included. It
  is not CPU time and not per-test cost. The script does not collect
  child-process CPU or RSS usage.
- Zero failures and zero flake candidates in two runs is an observation, not
  proof that there are no flakes.
- Typecheck (`npm run typecheck`) and package time were not measured
  separately. Package is approximated by the build time.
- Static counts are rough proxies: patterns can match comments or strings,
  and helpers hide spawns behind a single call site.
