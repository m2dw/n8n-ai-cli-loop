# Public snapshot export — production command (#768)

## Goal

Give an operator a single, reviewable command to prepare and (separately)
publish an update to the public mirror
[`m2dw/n8n-ai-cli-loop`](https://github.com/m2dw/n8n-ai-cli-loop), without
exposing raw Java/Copybara arguments and without ever touching the public
repository's `main` branch directly. This builds on the local-only Copybara
mechanics proven in [docs/copybara-export-poc.md](copybara-export-poc.md)
(read that first for how the SQUASH migration, file-ownership policy, and
`scripts/copybara-validate.mjs` leak check work — this document only covers
what changes to make that mechanism production-safe).

## Commands

```sh
# Dry run — the default, and the only thing this command does unless told
# otherwise. No push, no PR, no side effect on either remote beyond reading
# their current state.
npm run public:export -- \
  --private-remote git@github.com:<org>/<private-repo>.git \
  --public-remote git@github.com:m2dw/n8n-ai-cli-loop.git

# Publish — a separate, explicit operator action. Requires --yes in
# addition to the --publish this npm script already passes.
npm run public:publish -- \
  --private-remote git@github.com:<org>/<private-repo>.git \
  --public-remote git@github.com:m2dw/n8n-ai-cli-loop.git \
  --yes
```

Both commands resolve the export revision from the **private remote's**
`main` branch (`git ls-remote`, default `--rev main`) — never the
operator's current branch or a dirty local worktree — and validate the
transformed tree before doing anything else. `public:publish` additionally
pushes the validated commit to a **dedicated** branch on the public remote
(default `copybara/public-sync`, see `--branch`) and creates or updates a
Pull Request against the public repository's base branch (default `main`,
see `--pr-base`). Neither command ever pushes to the public repository's
own `main`/`master` — `scripts/public-export.mjs`'s argument validation
rejects `--branch main` and `--branch master` outright.

Every option is documented in `node scripts/public-export.mjs` with no
arguments (prints usage and exits 2).

## First baseline (issue #800)

Copybara determines what changed by resolving a `GitOrigin-RevId:` trailer
off the destination's current tip. The public destination's own history
predates this tool — or may carry a trailer left over from an unrelated
one-off snapshot — so letting Copybara resolve it there is exactly what
produces its `Cannot resolve reference ...` / `Cannot find last imported
revision` failure. `scripts/public-export.mjs` never lets that happen: it
always renders an explicit `--init-history` or `--last-rev` into the
underlying `migrate` invocation itself, chosen in priority order:

1. `--init-history`/`--last-rev` passed explicitly by the operator (see
   below).
2. The `GitOrigin-RevId` this tool already recorded on its own dedicated
   sync branch's current tip, from a previous run — read via
   `readRemoteBranchOriginRevId` and independently re-verified to still
   resolve in the private origin before being trusted. This is what makes
   every run *after* the first ordinary, with no repeated flags.
3. If the dedicated sync branch no longer exists at all (e.g. the public
   repository has GitHub's "Automatically delete head branches" setting on,
   which removes it the moment its export PR merges), the source revision
   recorded on that merged PR's own body is recovered instead, via
   `recoverBaselineFromMergedPr` (`gh pr list --state merged`) — so an
   ordinary repeat run stays ordinary even after the branch is gone, with no
   repeated `--init-history`/`--last-rev`.
4. Neither of the above: the very first export ever attempted against a
   given public remote/branch — fails closed at the `baseline` stage with an
   actionable message, before Java or the jar are even touched.

The exact first-run command (works identically as a dry run or with
`--publish --yes`; a dry run only ever reads the public remote, so it is
safe to use to preview or intentionally re-establish the baseline):

```sh
npm run public:export -- \
  --private-remote git@github.com:<org>/<private-repo>.git \
  --public-remote git@github.com:m2dw/n8n-ai-cli-loop.git \
  --init-history
```

`--init-history` treats the public destination's current tip as the
pre-Copybara baseline — the recommended choice the first time this tool is
ever pointed at a given public remote/branch. If the exact private revision
the destination's current content actually corresponds to is known, pin it
explicitly instead (mutually exclusive with `--init-history`):

```sh
npm run public:export -- \
  --private-remote git@github.com:<org>/<private-repo>.git \
  --public-remote git@github.com:m2dw/n8n-ai-cli-loop.git \
  --last-rev <known-private-sha>
```

Neither flag ever causes `--force` to be passed to Copybara, and neither
touches the public repository — see [Safety contract](#safety-contract).
The selected baseline mechanism (and, once recorded, the auto-derived
`--last-rev` used by every later run) is reported in the command's own
output and recorded in the PR body's `- Baseline:` line.

If a later run unexpectedly fails at the `baseline` stage — its own
previously recorded `GitOrigin-RevId` no longer resolves in the private
origin (e.g. the private history was rewritten) — that is reported as a
distinct, actionable failure rather than retried automatically; see
`baseline` in the [Failure recovery](#failure-recovery) table.

## Safety contract

- **Dry run is the default.** `--publish` is required to do anything beyond
  local validation, and `--publish` additionally requires `--yes`. Passing
  neither, or mistyping either flag, cannot publish: unknown options fail
  closed (`public-export: unknown option "..."`, exit 2, nothing executed),
  and there is no flag whose *absence* enables publication — only its
  explicit presence does.
- **A failed validation leaves the public repository untouched.** The
  transformed tree is validated (`scripts/copybara-validate.mjs`, reused
  unchanged from #767) before any push is attempted; the push step itself
  never runs unless the underlying `runExport` pipeline returned `ok: true`.
- **No credentials or local paths in generated output.** The PR title/body
  (`buildPrTitle`/`buildPrBody` in `scripts/public-export.mjs`) contain only
  the private source revision SHA, the branch/base names, and a fixed
  validation statement — never a local workdir path, a remote URL, or
  anything from the jar download step. `gh` resolves its own credentials
  (see Authentication below); this tool never reads, logs, or forwards a
  token itself.
- **The dedicated sync branch is force-pushed by design.** Each publish
  builds a fresh SQUASH commit on top of the public remote's *current*
  `main` (its baseline), which generally isn't an ancestor of the previous
  sync branch push — a plain push would be rejected as non-fast-forward.
  This is safe specifically because the branch is single-purpose and fully
  owned by this tool; the force-push target is validated to never be
  `main`/`master`.

## Authentication

- **Git access to both remotes**: whatever `git` on the operator's `PATH`
  already uses (SSH agent, credential helper, etc.) — `--private-remote`/
  `--public-remote` are passed straight to `git clone`/`git fetch`/`git
  push`, so any URL your existing `git` setup can already read/write to
  works here.
- **GitHub PR creation and merge-status checks**: the `gh` CLI, which must
  already be authenticated (`gh auth login`, or `GH_TOKEN`/`GITHUB_TOKEN` in
  the environment) with permission to read and open/edit pull requests on
  the public repository. This script never touches that credential directly
  — it only ever invokes `gh pr view` / `gh pr create` / `gh pr edit` / `gh
  pr list` and lets `gh` resolve auth on its own. The `owner/repo` slug
  passed to `gh` is parsed from `--public-remote` when it is a `github.com`
  URL; pass `--repo-slug owner/repo` explicitly if `--public-remote` is
  something `gh` can't parse that way (an SSH host alias, a mirror, etc.).
  Once a previous export is recorded on the dedicated sync branch, every run
  (dry run included) needs a working `gh` to authoritatively check whether
  that prior sync PR has already merged (see [Repeat
  execution](#repeat-execution-idempotency)); this is a read, never a
  mutation, so it does not conflict with "dry run means no public-side
  effects".

## Cache location

The pinned Copybara jar (see [Pinning](copybara-export-poc.md#pinning) in
the PoC doc — the pin format is unchanged) is cached at
`~/.cache/n8n-ai-cli-loop/copybara/copybara-<release>.jar` by default
(`DEFAULT_CACHE_DIR` in `scripts/copybara-jar-cache.mjs`; override with
`--jar-cache-dir`). This lives outside the repository tree and is never
committed. The cache is only ever populated by `scripts/public-export.mjs`
itself, on demand — **never by `npm install`** — and only when
`copybara/PIN.json` has both `jarSha256` and `downloadUrl` populated; a jar
already present in the cache is still re-verified against `jarSha256` on
every run, and a stale/corrupted entry (checksum no longer matches) is
deleted and re-downloaded rather than reused. If `downloadUrl` is not set,
download the pinned release manually and pass `--jar <path>` instead — the
checksum is verified either way.

## Failure recovery

Every stage fails closed and reports which stage failed
(`public-export: FAILED at stage "<stage>" — <reason>`):

| Stage | Meaning | Recovery |
|---|---|---|
| `resolve-rev` | Could not resolve `--rev` on the private remote | Check `--private-remote`/`--rev`, and that the branch exists |
| `java` | Java runtime missing or older than the pin's `javaMinVersion` | Install/upgrade Java, no repository state touched |
| `pin` | `copybara/PIN.json` unpopulated, or the resolved jar's checksum doesn't match it | Run the pin bootstrap (see PoC doc), or fix `--jar`/`--jar-cache-dir` |
| `download` / `checksum` | Jar download failed, or the downloaded jar's checksum doesn't match the pin | Re-run (transient network failure), or the pin/`downloadUrl` disagree — treat as a pin integrity problem, do not relax the check |
| `migrate` | The pinned jar's `migrate` invocation exited nonzero | See the printed Copybara stderr; the local bare destination's rejected commit is quarantined (`refs/quarantine/...`), nothing is pushed anywhere |
| `validate` | The transformed tree has a leak/forbidden path | See the printed findings; same quarantine as `migrate` |
| `push` | `git push` to the public remote's dedicated branch failed | Re-run once the underlying issue (auth, connectivity) is fixed — safe to retry, see Idempotency below |
| `pr` | `gh pr create`/`gh pr edit` failed after a successful push | The branch is already updated on the public remote; re-running is a no-op push (idempotent, see below) that retries only the PR step |
| `baseline` | No `--init-history`/`--last-rev` baseline could be established (issue #800) — no previous export is recorded on the dedicated sync branch, none could be recovered from a previously merged export PR either (e.g. the branch was auto-deleted on merge and no merged PR is found — see item 3 in [First baseline](#first-baseline-issue-800)), or a recorded/explicit `GitOrigin-RevId` no longer resolves against the private remote | See [First baseline](#first-baseline-issue-800): re-run with `--init-history` or `--last-rev <sha>`. Never retried automatically and never with `--force` — a stale trailer usually means the private history was rewritten or the wrong remote was passed, both of which need a human decision |
| `merge-check` | Could not authoritatively determine whether the PR backing the dedicated sync branch's current tip has already merged into `--pr-base` (issue #800 P1 review fix) — no repo slug, `gh` not installed/authenticated, an unexpected `gh pr list` response, or no PR at all matches the sync branch's current tip commit (second-pass review fix) | Fix `gh` auth/connectivity (or pass `--repo-slug`), or confirm the PR state manually if the branch's current tip genuinely has no matching PR, then re-run. Never guessed either way — see [Repeat execution](#repeat-execution-idempotency) |
| `merge-check-stale` | The sync branch's merge status into `--pr-base` changed between the pre-export check and the re-check done immediately before the force-push (issue #800 P1 review fix) — the prior sync PR merged (or, less likely, was un-merged) while the Java/download/export work for this run was still in progress, so the tree staged above no longer matches the destination branch it was diffed against | The export already staged is not pushed. Simply re-run (dry run or `--publish`); the destination branch will be re-selected against current state. Never retried automatically and never with `--force` |

In every failure case, nothing has been pushed to the public repository's
`main`, and the dedicated sync branch is only ever updated after a clean
`validate` stage.

## Repeat execution (idempotency)

Before doing any local work, every run (dry run or `--publish`) checks the
public remote's dedicated branch's current tip for its `GitOrigin-RevId:`
trailer (the Copybara-standard marker of which private revision produced
it — see the PoC doc). This same read doubles as the baseline auto-derivation
described in [First baseline](#first-baseline-issue-800). For `--publish`
specifically: if that revision already matches the private remote's current
`main`, the run is a no-op beyond confirming the pull request is still open
and up to date (`alreadyPublished: true` in the result, and the PR body
notes "no content changes since the previous export"). This means:

- Re-running `npm run public:publish` after the private `main` hasn't moved
  never creates a duplicate commit or a duplicate PR.
- Re-running after a `push`/`pr`-stage failure (see table above) safely
  retries from wherever it left off, since the check above is based on the
  public remote's actual current state, not local state.
- If the dedicated sync branch already carries a prior export, every run
  also asks GitHub (`gh pr list --head <branch> --base <pr-base> --state
  all --json number,state,headRefOid`) whether the PR backing the sync
  branch's *current* tip commit has actually merged — never by searching
  commit message text, since GitHub lets a squash merge's commit message be
  edited or replaced (issue #800 P1 review fix), and never by branch name
  alone, since the dedicated branch is reused across runs: a PR that merged
  against an older tip keeps that `headRefName` forever, so a name-only
  query would still match it even after the branch has moved on to a newer,
  still-open PR (issue #800 P1 review fix, second pass). Matching is done
  against `headRefOid` (the sync branch's actual current tip, from
  `readRemoteBranchOriginRevId`), so only the PR that actually backs that
  tip decides the outcome. If it has merged, the next export stages from
  `--pr-base` (which already contains the merge and anything since); if not,
  it stages from the sync branch's own tip. If no PR matches the current tip
  at all, or the check can't otherwise be determined, the run fails closed at
  the `merge-check` stage rather than guessing (see table above).
- A genuinely new private `main` commit always produces a new SQUASH commit
  and updates the existing PR's branch (`gh pr edit` on the still-open PR
  from a previous run, rather than opening a second PR against the same
  base).
- For `--publish`, this merge check runs a second time immediately before the
  force-push, since the Java/download/export work in between can take long
  enough for the prior sync PR to merge mid-run (issue #800 P1 review fix). If
  the merge status has changed since the first check, the run fails closed at
  the `merge-check-stale` stage (see table above) instead of pushing a tree
  staged against a base that has since moved.

## Initial bootstrap

The very first run against the real public repository bare-clones
`--public-remote` as-is, unrelated history included (see [Initial
baseline](copybara-export-poc.md#initial-baseline-bootstrapping-the-existing-public-history)
in the PoC doc for the low-level mechanics), and the new SQUASH commit lands
as a normal child of its current tip on the dedicated sync branch — never an
orphan branch, `git reset --hard`, or force-push of `main` itself.

Unlike the PoC's `--dest-baseline` case, that first run does **not** work
automatically: the public destination's pre-existing history has no
Copybara-managed `GitOrigin-RevId` this tool can trust (see issue #798's
follow-up, issue #800), so it requires the explicit `--init-history`/
`--last-rev` baseline decision described in [First baseline](#first-baseline-issue-800).

## Scope note

This command is intentionally standalone: it does not integrate with this
repository's handlers, `TaskStore`, phase routing, Human Gate, or n8n
workflow execution. Publication is always a deliberate, separately-invoked
operator action (`npm run public:publish -- --yes ...`), never an automatic
side effect of the agent loop.
