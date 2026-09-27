# Staged verification — operator guide

Status: **operator guide for the shipped, opt-in staged verification
(issue #1107; rewritten for issue #1155, corrected for issue #1167).** It adds
no behavior of its own. The
lifecycle is fixed by
[staged-verification-contract.md](staged-verification-contract.md) (#1094),
the changed-file / full-suite replacement of the retired selection policy by
[changed-file-verification-contract.md](changed-file-verification-contract.md)
(#1158), and evidence identity and recovery by
[verification-evidence-validity-contract.md](verification-evidence-validity-contract.md)
(#1096). Where this guide and a contract disagree, the contract wins.

What ships today, in one paragraph: with `stagedVerification.enabled`, the
implementation lane runs a **loop** stage over the **entire required set** of
non-test checks, and after the review agent approves, the review lane runs a
**final** stage over that same set at the approved head. With a `testSuite`
binding the test suite itself leaves both and is run by the changed-file stages
instead: Stage 1 executes the Issue's changed and retained test files, and
Stage 2 the whole suite at the approved head. `status:stack-ready` is published
only by the completion that records a complete, passed, full-set final bundle
bound to that head. See `docs/feature-status.md` for the gaps.

Issue #1155 removed the group-selection settings — `selectable`, `finalOnly`,
`selectionTimeoutMs`, `selectionAdapter`, `resultAdapters` and
`resultTimeoutMs` — together with the selection adapter, the result adapter and
the `.ai-cli-loop/verification.json` project file. There is no migration,
alias, deprecation warning or compatibility mode: a session that still carries
one of those settings **does not load**, and the operator removes it.

## 1. Configuration

Everything is opt-in and fail-closed at session load. No per-Issue edit of
`sessions.json` is ever needed: the per-Issue state (bundles, the Issue base,
retained test files, recovery counters) is runner-owned task context.

`sessions.json` (the authorizing layer — commands live only here):

```json
{
  "verification": {
    "lint": "npm run lint",
    "typecheck": "npm run typecheck",
    "test": "npm run test:files"
  },
  "stagedVerification": {
    "enabled": true,
    "maxStageRecoveryAttempts": 3,
    "environmentIdentity": "node22-linux-x86_64",
    "testSuite": {
      "test": { "adapter": "jest", "setupCommand": "npm run build", "argumentSeparator": "--" }
    }
  }
}
```

That is the whole closed field set: `enabled`, `maxStageRecoveryAttempts`,
`environmentIdentity` and `testSuite`. Any other key refuses the session.

Rules worth restating:

- **No setting can omit a required check.** Every required **non-test** check
  is selected into every stage, and nothing the repository contains can add or
  remove one. Selected is not the same as executed: a stage stops at its first
  failure or timeout, and the final stage skips the non-test checks outright
  when the full suite did not pass — each unreached check is then recorded as
  an accounted `not-run` with `first-failure-stop`, never dropped. What no
  configuration can do is make a required check absent from the stage's
  accounting. The one entry that ever leaves a stage is the bound test suite, which
  the changed-file stages run instead — Stage 1 the Issue's own test files,
  Stage 2 the whole suite at the approved head. That is a relocation, not an
  omission: no cycle before approval runs the whole suite, and no approval
  grants without it.
- `enabled: true` is "enabled and correct": the loop stage takes the required
  non-test checks and records a bundle beside them, and the final stage takes
  the same set again at the approved head before stack-ready.
- `testSuite` is **required** whenever `enabled` is `true`, because the
  changed-file contract replaces the retired selection policy rather than
  sitting beside it — there is no policy left to fall back to.
- **The minimum that loads** is the block above: a `verification` map, `enabled:
  true`, and a `testSuite` naming one key of that map with an implemented
  adapter. `maxStageRecoveryAttempts` and `environmentIdentity` are optional
  and default (3, and no declared environment).

## 2. Generic command integration

For the **non-test** checks a project needs nothing beyond its commands. Any
executable that exits `0` on success is a check: `make lint`, `cargo clippy`,
`go vet ./...`, `./gradlew checkstyleMain`, `ruff check .`. The runner owns the
spawn, the deadline, the `verification-<name>.log` artifact and the verdict; it
never parses a check's output to decide a verdict.

**A non-test check must not run tests, including transitively — and neither
must the suite's `setupCommand`.** The runner classifies by binding, not by
inspecting what a command does: everything except the bound `testSuite` entry
is selected into every stage, and the `setupCommand` runs ahead of Stage 1's
file discovery, so a command on either side that reaches the test suite through
its own task graph puts the whole suite back before approval and defeats the
narrowing this guide describes. Watch for aggregate targets in particular —
`./gradlew check` depends on `test` in the standard Java plugin, and `make all`
or an `npm run verify` umbrella script usually reaches a test target. The same
trap catches a `setupCommand` pointed at a broad build target: name the
specific non-test task, and the specific compile/prepare task, instead.

**The test suite is the exception, and it is what decides who can enable this
today.** Stage 1 has to name individual files and read a per-file machine
result, so the bound entry needs an implemented adapter rather than an exit
status. That set is closed and currently holds exactly two members, `jest` and
`vitest` (`TEST_SUITE_ADAPTER_KINDS` in `src/core/staged-verification-config.ts`;
Vitest since #1174). A
project whose suite no implemented adapter drives cannot set `enabled: true` at
all: `testSuite` is required, and an adapter name nothing implements refuses at
load rather than failing at launch. That is a missing adapter, not a
configuration mistake. The rest of this guide shows a Jest suite; §3.1 covers
what differs for Vitest.

## 3. The test suite binding

The one thing an operator declares beyond the checks themselves is which
`session.verification` entry is the test suite, and which implemented adapter
drives it:

```json
{
  "verification": {
    "typecheck": "npm run typecheck",
    "test": "npm run test:files"
  },
  "stagedVerification": {
    "enabled": true,
    "testSuite": {
      "test": { "adapter": "jest", "setupCommand": "npm run build", "argumentSeparator": "--" }
    }
  }
}
```

- The key must name exactly one existing `session.verification` entry. Two keys,
  zero keys, or a key that resolves to no command each refuse the session.
- `adapter` must name an implemented adapter; a name nothing implements refuses
  at load rather than failing at launch.
- `setupCommand` runs as its own step before the suite command in both stages,
  so changed sources are built before the tests consume them. It never receives
  the file selection, so a target that reaches the suite through its own task
  graph runs the whole suite unnarrowed — see §2.
- `argumentSeparator` is the token placed between the suite command and the
  adapter's arguments — `--` for a package-manager script that forwards
  arguments only after it.
- `requirementCommands` is optional and declares which **Issue-requirement**
  command texts this entry discharges, when the Issues say one thing and the
  binding runs another:

  ```json
  "test": {
    "adapter": "jest",
    "setupCommand": "npm run build",
    "argumentSeparator": "--",
    "requirementCommands": ["npm test"]
  }
  ```

  Without it, an Issue requiring `npm test` against a binding that runs
  `npm run test:files` matches no configured command, so review blocks on a
  missing command before Stage 2 can run. With it, that requirement reads
  *pending Stage 2* and is satisfied only by a complete, passing Stage 2 — it
  declares an identity, never evidence. Nothing is inferred: no `package.json`
  is read and no script name resolved, so declare only commands this entry's
  full run actually performs. A declared command another `session.verification`
  entry already runs refuses the session, and the declaration is part of the
  binding's identity, so adding or changing it invalidates earlier stage
  evidence.

**What the binding costs.** Every stage pays its `setupCommand` once plus one
discovery launch (`--listTests`) before a single test file runs — including a
cycle whose selection turns out to be empty. A pre-approval cycle costs
`setup + discovery + selected files` where it used to cost `setup + whole
suite`, and Stage 2 costs `setup + discovery + whole suite` — discovery only
lists files, so a failing Stage 2 pays for one whole-suite execution, not two.
A second whole-suite execution arrives only when a later fix earns another
approval and reaches Stage 2 again.
Two consequences for the binding: bind the cheapest suite command that still
produces what the tests read, and keep the rebuild in `setupCommand` rather than
in the suite command — a suite command that rebuilds on every launch builds
twice per stage, because a stage launches it twice (discovery, then the files).

**The binding is the only configuration a stage run attests.** A session that
binds no suite declares nothing here, which is a configuration fact rather than
a failure; changing or dropping a binding invalidates evidence taken under the
old one.

### 3.1 A Vitest suite

The minimal operator-authored binding for a Vitest project (issue #1174):

```json
{
  "verification": {
    "typecheck": "npm run typecheck",
    "test": "npx vitest"
  },
  "stagedVerification": {
    "enabled": true,
    "testSuite": {
      "test": { "adapter": "vitest", "setupCommand": "npm run build" }
    }
  }
}
```

The stages, selection, retained files, D1–D6 and `requirementCommands` behave
exactly as for Jest; only how the tooling is asked and read differs
(`docs/changed-file-verification-contract.md` §6 rule 6). What an operator has
to know:

- **Supported: Vitest 3, from 3.2.** Other versions are not supported. Nothing
  probes the installed version, so an unsupported one shows up as an
  unreadable report or a refused run, never as a pass.
- **The suite command invokes the Vitest executable itself** — `npx vitest`,
  `pnpm exec vitest`, `node node_modules/vitest/vitest.mjs` — with no
  subcommand, because the adapter supplies `vitest list` for discovery and
  `vitest run` for a run. Anything after the executable must be a
  `--name=value` or `--no-name` option (`npx vitest --config=vitest.unit.mjs`).
  **A package script such as `npm test` or `npm run test:unit --` is refused**,
  because its body might already say `vitest run`. An Issue that requires
  `npm test` is matched through `requirementCommands`, as for Jest. Watch mode,
  `--changed`, `--shard`, the UI and the reporter options are refused too.
  The runner launches the command without a shell, so `cd pkg && npx vitest`
  or `NODE_ENV=test npx vitest` is refused unless it is the command string of
  an `sh -c` wrapper; `env NODE_ENV=test npx vitest` works either way.
  Every refusal happens before anything launches and says why.
- **No `argumentSeparator`** unless the command is `npm exec vitest`, where npm
  consumes it. Anywhere else a `--` would reach Vitest itself.
- **Each test file belongs to exactly one configured project.** Vitest's JSON
  result names a file by path alone, so a file two projects both run cannot be
  told apart; discovery refuses that configuration with the file and the
  projects named.
- **The run's reporters are `default` and `json`**, replacing the configured
  ones for the stage run: Vitest cannot add a reporter beside them. A reporter
  the project relies on for its pass/fail decision is not consulted.
- **What Vitest adds to the cost.** Vitest has no exact-path option — a file
  argument also selects every file whose path contains it — so every Stage 1
  run first asks `vitest list` which files its arguments select, and runs no
  test unless that is exactly the selection. A similarly named file is
  refused rather than run, with the file named. That is one more listing launch
  per Stage 1 run; Stage 2 passes no file and pays nothing extra.

## 4. Reading the status

`admin task-verification show --session-id <id> --issue-number <n>` (add
`--json` for machine callers) prints the effective plan and, for an opted-in
session or a task that retains stage state, the stage view. The JSON payload
gains one additive `stagedVerification` key; a session that has not opted in
gets a byte-identical payload. No new command family exists.

`stagedVerification.progress` is the answer to "what does this Issue actually
have?":

| Progress state | Meaning |
| --- | --- |
| `disabled` | Staged verification is off; the shipped verification applies |
| `no-final-evidence` | No final stage has run; a review approval is not yet verified |
| `final-running` | A final stage run is allocated with no bundle — in flight, or a confirmed-terminated run re-running under `maxStageRecoveryAttempts`; an allocation the next claim cannot confirm terminated parks as `termination-unknown` instead (contract §5 rule 3) |
| `final-pending` | The review approved a head; waiting on the full required set at that head |
| `final-withheld` | The latest final stage did not earn stack-ready |
| `final-passed` | Completed final evidence: the full required set passed at the approved head |
| `final-invalidated` | A granting bundle exists, but the plan changed since and it no longer binds |

**Review approval alone is never `final-passed`.** The Human Gate summary of an
opted-in session carries the same distinction on the PR as a single line —
`⏳ pending`, `⏳ withheld (<reason>)`, `❌ <outcome>` or `✅ passed` — with
counts and the full-set flag only.
A final stage that withholds stack-ready (`blocked`) or fails (`needs_fix`)
rewrites the same sticky summary, so an earlier passing body never stays in place.

Example text output (bounded; digests shortened here for width):

```text
  staged verification: enabled — final-withheld: the latest final stage did not earn stack-ready
    required checks (what a final stage runs): 3
    last loop 1/implementation/loop/0: passed, complete, 2/3 required selected (without the test suite), 8120ms
      passed 2, failed 0, timed-out 0, not-run 0, unknown 0; head unknown, plan 3f1c…
      - exec:lint (lint): passed (exit 0, 900ms)
      - exec:integration (integration): passed (exit 0, 7200ms)
      not selected (not known to pass): exec:unit
    last final 1/review/final/0: code-failed, INCOMPLETE, 3/3 required selected (full set), 64200ms — row 9 repair
      passed 1, failed 1, timed-out 0, not-run 1, unknown 0; head 9ab0…, plan 3f1c…
      - exec:lint (lint): passed (exit 0, 850ms)
      - exec:unit (unit): failed (exit 1, 63300ms)
      - exec:integration (integration): not-run (first-failure-stop)
    last final record: recorded
    retained test files: 1
      - tests/unit/test_rounding.py (added by 1/review/final/0)
    recovery: final streak 0/3, loop streak 0/3
```

What each part reports:

- **Selected vs required.** `selected/required` and `not selected (not known to
  pass)`. The only check that ever leaves a stage is the bound test suite entry,
  which the changed-file stages run instead — and it is never reported as
  passing on a cycle where only some of its files ran.
- **Durations and outcomes** come from the ordinary runs the lanes already
  made. Nothing here launches an audit job, a schedule or a re-run.
- **Retained test files.** Files a failed Stage 2 kept; each stays selected by
  Stage 1 until the Issue completes, even after it passes. `OVERFLOWED` means
  nobody can say which obligations are open, so Stage 1 selection is
  unavailable.
- **Evidence invalidation.** `invalidated by:` lists fixed codes:
  `plan-digest-changed` (an amendment or Issue refresh moved the plan),
  `launch-identity-unknown:<component>` and `recheck-<kind>:<component>` (the
  end-of-run re-check disagreed — a moved head, an edited tree, a changed
  session or environment declaration).
- **Redaction.** Ids, operator-authored check names, verdicts, counts,
  durations, digests, SHAs and fixed codes only. No output tail, no log path, no
  command bytes; the failing output lives in the run's log artifacts.

## 5. Recovery examples

**Nothing below is repaired automatically except where it says so.** The runner
re-runs exactly what these rows say it re-runs and parks otherwise; there is no
background retry, no repair job and no self-healing of a parked Issue.

- **A failing final stage** (`final-withheld`, row 9/10). Nothing to do by hand:
  the task returns to the fix loop with the failing set. The next loop stage
  runs the entire required set of non-test checks again, so nothing a failure
  left unproven can be selected away; a failing Stage 2 additionally retains the
  test files that failed, and they stay selected by Stage 1 until the Issue
  completes.
- **A confirmed host failure or interruption** (`incomplete`, or
  `infrastructure` for a recognized host-failure exit; row 11/13). The
  recorded evidence proves the run launched no process, or that every process
  it launched terminated — only that proof authorizes an automatic re-run
  (contract §5 rule 3). The next claim re-runs that stage from the beginning:
  at the live revision for Stage 1, at the same approved revision for Stage 2,
  no agent turn, under `maxStageRecoveryAttempts`. If the task is waiting on a
  retry backoff and the host is fixed, `admin task clear-delay --session-id
  <id> --issue-number <n> --yes` makes it eligible now.
- **A park after `maxStageRecoveryAttempts`** (`recovery: final streak 3/3`).
  Fix the host or environment first; the worktree is preserved. Then requeue
  through the lane's existing human handoff, as for any parked task.
- **`final-invalidated` after an amendment.** Expected: evidence binds to the
  plan it ran under. The next review approval runs a new final stage. To change
  what is required, amend the plan with `admin task-verification amend` —
  never by editing `sessions.json` or the database.
- **A crash with no recorded result** (`termination-unknown`; a run allocated
  in either stage whose ledger entry never reached `recorded` — a worker that
  died mid-run, for example). Nothing in the shipped stage-run ledger proves
  the old process ended: a dead worker, a superseded allocation, code review
  approving the revision, or simply no visible process is never that proof
  (contract §5 rule 3). This applies identically to Stage 1 and Stage 2 — a
  final stage's approved head is not termination evidence either. The next
  claim closes the open allocation as `termination-unknown` and parks before
  any check launches; nothing is credited to the dead run and nothing re-runs
  by itself. Requeue through the lane's human handoff once the host is fixed.
- **A Stage 1 that executed only skipped test files** (`empty`, contract §3
  R10). Not a pass and not a failure — nothing was proven — so the cycle
  continues to review and Stage 2 stays mandatory. There is nothing to do, and
  a green-looking `empty` never discharges a full-suite requirement.
- **A Stage 2 that executed only skipped test files** (`no-evidence`). The
  Issue parks with its worktree preserved and the run is **never** repeated
  automatically. A suite that skips everything at the approved head is a
  project condition the runner will not guess at — a filter left in place, an
  environment guard, a misconfigured pattern. Fix the cause, then requeue
  through the lane's human handoff.
- **The Issue base after a predecessor update** (D5). The base advances only
  when the predecessor's own task row records a granting Stage 2 at exactly the
  head this Issue fetched; a blocker branch that merely moved, or one that kept
  a stale `status:stack-ready`, never advances it. On an advance every bundle
  this Issue recorded is dropped — loop and final, including one a live grant
  rested on — and a pending approval is evicted, so the revision is reviewed
  again and Stage 2 re-run against the new base. Retained test files survive
  untouched. Nothing to do by hand; the status simply reads `no-final-evidence`
  again.
- **`stage state UNREADABLE`.** Nothing is credited and nothing is repaired
  automatically. Inspect with `show --json` and treat it as a runner defect.

## 6. This repository — TypeScript/Jest

Enabling staged verification here is an operator decision made once in
`sessions.json`; the repository does not enable itself, and a session that has
not opted in is unaffected.

**Implemented is not activated.** Everything in this section is shipped code
with the block below as its only remaining input — and **no session in this
repository carries that block today**. Until an operator adds it, this
repository's own loop runs `npm test` as an ordinary verification command on
every cycle, exactly as it did before the chain, and nothing described here is
in effect. The runner never edits a live session
([changed-file-verification-contract.md](changed-file-verification-contract.md)
§10.1 D4), so no Issue can close that step from inside.

```json
{
  "verification": {
    "typecheck": "npm run typecheck",
    "test": "npm run test:files",
    "package": "npm run package"
  },
  "stagedVerification": {
    "enabled": true,
    "testSuite": {
      "test": {
        "adapter": "jest",
        "setupCommand": "npm run build",
        "argumentSeparator": "--",
        "requirementCommands": ["npm test"]
      }
    }
  }
}
```

Every loop and final stage runs `npm run typecheck` and `npm run package`. The
test entry leaves both and is run by the changed-file stages: Stage 1 executes
the test files this Issue added or modified, union the files an earlier Stage 2
run left failing; Stage 2 runs the whole suite at the approved head, once Stage
1 has passed and code review has approved the same revision.

**The one piece of project-side wiring (#1156).** `package.json` gained a
`test:files` script — the same Jest invocation as `test`, without the `pretest`
lifecycle hook. That is all of it: no selection adapter, no result adapter, no
project verification file, no category list. The reason is arithmetic rather
than policy. `npm test` rebuilds through `pretest` on every invocation, and a
stage launches the suite command twice (discovery, then the selected files), so
binding `npm test` would build twice per Stage 1 and twice per Stage 2. Binding
`npm run test:files` with `setupCommand: "npm run build"` builds **once** per
stage, before discovery, which is what the setup step exists for. Nothing else
about `npm test` changes: it stays the command AGENTS.md requires and the one CI
runs.

**The second piece (#1166): `"requirementCommands": ["npm test"]`.** Ordinary
Issues here require `npm test`, because that is what
[AGENTS.md](../AGENTS.md) §Verification asks contributors to run. The binding
above launches `npm run test:files`, which is a different command text, so
without this declaration every such Issue reads `npm test` as a required command
no configured check runs: review blocks before Stage 2, and the whole-suite
requirement can never be discharged. The declaration says, explicitly and only
for this entry, that a complete Stage 2 of it *is* the `npm test` the Issue
requires. It does not make the two commands equivalent anywhere else, and it
grants nothing on its own — the requirement stays pending until a complete
passing Stage 2 at the approved revision records it. Existing tasks need no
amendment: the relation is read from the session at gate time, so a task whose
requirement slots were persisted before the declaration is covered by it too.

Two things to know about the setup command here:

- `npm run build` also regenerates the committed workflow JSONs. That is
  deliberate and harmless while they are in sync, because `dist/` is ignored and
  an in-sync regeneration leaves the working tree byte-identical. An Issue that
  edits `scripts/build-parent-child-workflow.mjs` without committing the
  regenerated JSONs moves the working-tree identity *during* the stage, which
  the contract records as `stale` and re-runs at the live revision — the same
  outcome AGENTS.md already asks for, reached automatically.
- Binding `npm run build:lib` instead would be faster but wrong: some suites
  read the n8n node build and the generated workflow JSONs.

Issue #1155 retired the project integration that measured the old policy —
`scripts/loop-selection.mjs`, `scripts/staged-verification-baseline.mjs`, the
committed `.ai-cli-loop/verification.json` pin and
`test/loop-selection-adapter.test.js` are deleted, and nothing replaces them.
The changed-file stages need no project-side selection adapter, because they
select nothing beyond the Issue's own changed and retained test files.

**Validation.** `test/changed-file-verification-e2e.test.js` drives the
contract's §7 trace on a real project: a plain-CommonJS (non-TypeScript) Jest
project in a real git repository, with this repository's own installed Jest
doing discovery, the selected run and the machine result, and with the lanes
driven through the real orchestration path — the phase runner over a durable
SQLite store and the shipped review handler. It covers a selected-file pass,
review approval, a failing full suite, the retained failing file on the next
loop, a passing full suite and the stack-ready grant, plus a rejected review
that runs no full suite at all. Issue #1167 extended it with the three cases
this section's configuration depends on, over the same real Jest: an Issue
requiring `npm test` against the differently spelled binding (blocked
undeclared, pending then passed once declared), the accepted-predecessor base
advance (D5), and the all-skipped Stage 1 (`empty`) and Stage 2
(`no-evidence`) results (D6). `test/staged-verification-e2e.test.js` covers
the same lifecycle for the **non-test** checks over opaque `sh` commands,
together with the legacy path, a store restart, cross-Issue isolation and an
operator amendment.

**Measuring it.** `scripts/changed-file-stage-timing.mjs` prints the selected
file list, the argv of every launched command, the Stage 1 and Stage 2
durations, the build and discovery cost, and the host conditions they were taken
under. It is opt-in and run by hand — nothing in `npm test`, `npm run package`
or CI invokes it, and it changes no commit, label, publication or configuration:

```sh
npm run build
node scripts/changed-file-stage-timing.mjs --base-branch main
```

It exits 0 only when the measurement itself completed. A red test suite is a
measured result and exits 0; a stage that never executed a test file — an
unresolved retained selection in Stage 1, a failed setup, discovery or
runnable-file report in Stage 2 — is reported as `INCOMPLETE`, with the
durations taken so far, and exits nonzero.

The published results, their limitations and what is still missing are in
[changed-file-verification-validation.md](changed-file-verification-validation.md).
On this repository, measured there on 2026-09-18 for a three-test-file change
out of a 315-file inventory: 36.8 s for a pre-approval cycle — 28.4 s of
selected files plus 8.4 s of build and discovery — against 779.0 s for the whole
suite, which still runs in full after approval.

**Those numbers are historical, not fresh evidence.** They are one pass, on one
shared host, at head `60cb22dc` — a revision that predates the D5/D6 corrections
(#1165), the declared full-suite requirement (#1166) and this document's own
correction (#1167). Nothing has re-measured them since, and no Issue in this
chain promises a timing. Read them as an order of magnitude for a localized
change on that host, and re-run the script above on the head and machine you
actually care about before quoting a number. **One sample is not a performance
guarantee.**

**Limitations.** Stage 1 runs the Issue's own changed and retained test files,
so a defect only some other test file would catch is found by Stage 2, one
review cycle later. What is guaranteed is narrower than "the same detection in
every cycle": stack-ready is never published without a complete, passing,
full-set final stage — the whole test suite included — at the approved head, and
CI's own full verification remains an independent final safeguard that nothing
here narrows. A failing check carries its bounded output tail only.

## 7. Out of scope

No automated test deletion or restructuring, no mutation-testing engine, no
periodic audit scheduler, no cross-project concurrency scheduler, and no new
admin command family. Heavy test maintenance stays a separate project
operation.
