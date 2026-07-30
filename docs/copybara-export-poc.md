# Copybara private-to-public SQUASH export — prototype (#767)

## Goal

Prove that a pinned [Copybara](https://github.com/google/copybara) release can
generate a repeatable, reviewable SQUASH snapshot from the private
source-of-truth repository's `main` tree — the sole source of truth for
synchronized files — while preserving intended public-only files and failing
closed on unsafe output. This prototype runs only against **local temporary
Git repositories**; it never talks to `github.com/m2dw/n8n-ai-cli-loop`.

## Non-goals

- No push to `m2dw/n8n-ai-cli-loop`, no public branch or PR creation, no
  reverse import of public PRs.
- No full TypeScript reimplementation of Copybara. The wrapper only does
  argument/config plumbing and local `git` staging; every step that actually
  transforms file content is delegated to the real `java -jar` invocation.
- No direct publication from n8n.

## Files in this prototype

| Path | Purpose |
|------|---------|
| `copybara/copy.bara.sky` | Minimal SQUASH `core.workflow` config (template — see [Config templating](#config-templating)) |
| `copybara/PIN.json` | Pinned release name + jar SHA-256, unpopulated by default (see [Pinning](#pinning)) |
| `scripts/copybara-export.mjs` | Reproducible wrapper: Java gate → pin verification → local repo staging → `migrate` invocation → validation |
| `scripts/copybara-validate.mjs` | Post-transform leak-check, usable standalone or via the wrapper |

## Reproducible command

```sh
node scripts/copybara-export.mjs \
  --source-repo /path/to/private-repo-checkout \
  --rev main \
  --jar /path/to/copybara_deploy.jar \
  --workdir /tmp/copybara-poc-1
```

This creates `$workdir/origin` (a local clone of `--source-repo` at `--rev`)
and `$workdir/destination` — a **bare** repo, empty unless `--dest-baseline
<path>` is given (see
[Initial baseline](#initial-baseline-bootstrapping-the-existing-public-history)) —
renders `copybara/copy.bara.sky` against those two paths, and runs `java -jar
<jar> migrate <rendered-config> private_to_public_squash`. `git.destination`
pushes its SQUASH commit into `$workdir/destination` over `file://`; the
destination must stay bare because Git's default
`receive.denyCurrentBranch=refuse` rejects a push that updates the branch
currently checked out in a non-bare repository. After `migrate` succeeds, the
wrapper clones the pushed branch out of `$workdir/destination` into
`$workdir/destination-checkout` (a normal working tree) and runs
`scripts/copybara-validate.mjs` against that checkout — `scanTree` is a plain
filesystem walk and has nothing to read inside a bare repo. Any failure (Java
too old, pin unverified, `migrate` exits nonzero, or the validator finds an
unsafe path/pattern) exits nonzero and nothing is considered exported — see
[Verification](#verification) for how to exercise each stage.

The exported private revision is recorded on the destination commit via
Copybara's `GitOrigin-RevId:` trailer (standard Copybara SQUASH behavior) —
no private commit history or commit messages are carried over, only the tree
state at that one revision.

## Java requirement

Java 21 or newer is required. `scripts/copybara-export.mjs` runs `java
-version` and fails closed (`stage: "java"`) before touching any repository
if the runtime is missing or older than 21. The effective minimum is
`copybara/PIN.json`'s `javaMinVersion`, not the wrapper's hardcoded
`MIN_JAVA_MAJOR_VERSION` — the pin is loaded before the Java gate runs, so a
populated pin that requires a newer Java than 21 is enforced here rather than
failing later inside the pinned jar.

## Pinning

Copybara does not publish a regular versioned-release cadence with published
checksums the way most CLIs do; the common pattern is to build from a pinned
upstream commit or use a jar someone has already built. `copybara/PIN.json`
enforces a **trust-on-first-use** pin: the wrapper computes the SHA-256 of
whatever jar `--jar` points at and refuses to run (`stage: "pin"`) unless it
matches `jarSha256` in the pin file.

```json
{
  "release": null,
  "jarSha256": null,
  "downloadUrl": null,
  "javaMinVersion": 21
}
```

`downloadUrl` (added in #768) is optional: when set, `scripts/copybara-jar-cache.mjs`
downloads and caches the jar automatically for `scripts/public-export.mjs`
(see [docs/copybara-public-export.md](copybara-public-export.md)); either
way, `jarSha256` is what is actually trusted — a populated `downloadUrl`
never bypasses the checksum check below.

`copybara/PIN.json` ships **unpopulated** in this repository. This PoC was
authored in a sandboxed environment without network egress, so no jar could
be downloaded and no checksum could be independently verified — shipping a
fabricated checksum would be worse than shipping none, since it would look
verified when it isn't. An operator populates the pin once, locally:

1. Download the intended Copybara release/build from the official
   `google/copybara` project through a channel you trust (a tagged GitHub
   release asset, or a Bazel build pinned at an exact upstream commit SHA).
2. Independently confirm the provenance of that jar (e.g. against the
   release page, or by rebuilding it yourself from the pinned commit).
3. Capture the pin:

   ```js
   import { capturePin } from './scripts/copybara-export.mjs';
   import { writeFileSync } from 'fs';
   writeFileSync(
     'copybara/PIN.json',
     JSON.stringify(capturePin({ release: '<release-or-commit-id>', jarPath: '/path/to/copybara_deploy.jar' }), null, 2) + '\n'
   );
   ```

4. Commit the populated `copybara/PIN.json` as its own reviewable change.
   Every future `copybara-export.mjs` run — including in CI — then fails
   closed the moment the local jar's checksum stops matching.

## Config templating

`copybara/copy.bara.sky` is a template, not a config Copybara reads directly.
It contains four `__TOKEN__` placeholders
(`__COPYBARA_ORIGIN_URL__`, `__COPYBARA_ORIGIN_REF__`,
`__COPYBARA_DEST_URL__`, `__COPYBARA_DEST_REF__`). `scripts/copybara-export.mjs`
substitutes them with the `file://` paths of the local temporary repos it
just staged and writes the result to `$workdir/copy.bara.sky` before
invoking `migrate`. Substitution fails closed (throws) if any placeholder is
left over, so a typo'd token name cannot silently reach Copybara as a literal
string. This keeps the checked-in config free of any machine-specific path
while still being simple, reviewable Starlark.

## File ownership policy

`copy.bara.sky` defines three path lists:

- `DESTINATION_OWNED_PATHS` — `docs/metrics/latest.md`, `docs/metrics/latest.json`,
  `docs/metrics/badges/**`. These are generated by the **public repository's
  own CI**, not by this export. They are excluded from both `origin_files`
  and `destination_files`, so a SQUASH neither deletes them (absent from
  `origin_files`) nor overwrites them (absent from `destination_files`) —
  the public repo's independently-generated metrics survive the migration
  unchanged, per this issue's scope decision to preserve destination-owned
  generated output rather than overwrite it from the private side.
- `PRIVATE_ONLY_PATHS` — currently `docs/DOMAIN.md` and `docs/design/**`.
  This is a **human-curated policy, not something Copybara can infer**: it
  reflects that these paths hold internal architecture/threat-model
  reasoning rather than user-facing material. Whoever adds a new top-level
  internal-only doc must add it here — see
  [Limitations](#limitations-for-productionization).
- `LOCAL_ARTIFACT_PATHS` — `.n8n-artifacts/**`, `node_modules/**`,
  `coverage/**`, `dist/**`, `.env*`. Mostly redundant with `.gitignore`
  (`git.origin()` only ever sees tracked files) but listed explicitly so the
  export policy is legible on its own.

`scripts/copybara-validate.mjs` re-checks `docs/DOMAIN.md` and `docs/design/**`
as forbidden paths independently of the config (defense in depth against
config drift), alongside content-based rules — see
[Post-transform validation](#post-transform-validation).

## README public mirror note

Previously the public mirror carried a "this is a public snapshot" note that
was hand-edited directly on the public repository and never fed back to the
private source of truth — an uncontrolled public-only fork of `README.md`.
That note now lives in the private `README.md` itself (see the top of this
repository's README) so it flows through the SQUASH export automatically,
like every other file, instead of needing a separate manual edit on the
public side each time the mirror is refreshed.

## Initial baseline: bootstrapping the existing public history

The current public repository has an **unrelated Git history** from the
private repository (it was created as a one-off manual snapshot). SQUASH
mode does not require shared history between origin and destination: each
run produces exactly one new commit as a normal child of the destination
branch's current tip, built from the origin tree state at the requested
revision. Concretely, this means:

- The very first SQUASH run against the real public repository's current
  `main` (cloned locally, read-only, as the destination baseline — never
  the live remote) simply adds one bounded commit on top of its existing
  tip. **No `git reset --hard`, orphan branch, or force-push is required or
  performed anywhere in this prototype.**
- `scripts/copybara-export.mjs --dest-baseline <path-to-a-local-clone-of-the-existing-public-repo>`
  models exactly this: `prepareDestinationRepo` **bare**-clones the baseline
  as-is (unrelated history included — a bare clone copies branch refs
  straight across, unlike a normal clone's `refs/remotes/origin/*`) and
  Copybara's `migrate` step pushes its SQUASH commit as a normal child of
  that clone's current tip.
- Re-running with `--dest-baseline` pointed at the *previous* run's
  `destination` directory (the bare repo, not the validation checkout)
  demonstrates the steady-state case: a bounded, single-commit update per
  run, not a new unrelated root each time. This is exercised by the "two
  successive runs" test in `test/copybara-export.test.js`.

Productionizing this step still requires a human decision about exactly
which public commit to treat as the frozen baseline and a one-time real
`git push` of that first bounded commit (or, more conservatively, a manually
reviewed PR against the public repo) — this prototype stops at the local
bare `destination` repo by design (see Non-goals).

That human decision turned out to matter more than this prototype assumed:
the real `java -jar ... migrate` invocation additionally refuses to run
against a destination baseline whose tip has no (or a stale) `GitOrigin-RevId`
trailer it can resolve, rather than silently treating it as a fresh SQUASH
target the way the local git plumbing above does. `scripts/public-export.mjs`
handles this explicitly via `--init-history`/`--last-rev` — see [First
baseline](copybara-public-export.md#first-baseline-issue-800) in the
production doc (issue #800).

## Post-transform validation

`scripts/copybara-validate.mjs` walks the transformed destination tree (the
`$workdir/destination-checkout` working tree the wrapper clones out of the
bare `$workdir/destination` repo after `migrate` pushes to it) and fails
closed (nonzero exit) on:

- **Personal absolute paths** — macOS-style user directories, Linux home
  directories, and Windows user directories.
- **Credentials** — private key blocks, GitHub/npm/Slack tokens, AWS access
  key IDs, and quoted secret/API-key-shaped assignments.
- **Internal-only repository identifiers** — the private repository's name,
  which carries an `-ai` suffix the public mirror's name does not, and must
  never appear literally in exported output.
- **Files that must never be published** — `.n8n-artifacts/**`, `.env*`,
  stored git credentials, private key/certificate files by name or
  extension, and (defense in depth) `docs/DOMAIN.md` / `docs/design/**`.

`test/**` is exempt from the content rules above (path-based rules still
apply there) since this repository's own tests deliberately contain
realistic-looking placeholder paths, keys, and tokens as fixture data —
see [Limitations](#limitations-for-productionization).

Run it standalone against any directory: `node scripts/copybara-validate.mjs <dir>`.
It is also run automatically as the last stage of `copybara-export.mjs`.

`migrate` pushes into the bare `destination` repo *before* this check runs,
so a failing validation would otherwise leave the unsafe commit sitting on
`destination`'s branch — reusable by a subsequent `--dest-baseline` run or by
the eventual manual publication step, despite the command reporting failure.
On a validation failure the wrapper (`quarantineFailedPush` in
`copybara-export.mjs`) rolls the destination branch back to its pre-migrate
state (or deletes it if the branch was unborn) and moves the rejected commit
to `refs/quarantine/<branch>-<sha>` in the same bare repo, where it stays
reachable for forensics but is no longer the branch tip.

## Verification

This maps to the Verification checklist in issue #767:

1. **Copybara configuration validation** — once a pinned jar is available:
   `java -jar <jar> validate copybara/copy.bara.sky` (this PoC's authoring
   environment has no Java/network access — see
   [Limitations](#limitations-for-productionization) — so this exact command
   has not been executed here; the wrapper's `checkJavaVersion`/`verifyPin`
   gates ensure it cannot be skipped in a real run).
2. **Two successive local-only SQUASH migrations** — run the reproducible
   command above twice with two **separate, empty** `--workdir` directories
   (each run's `prepareOriginRepo`/`prepareDestinationRepo` clone into
   `$workdir/origin` and `$workdir/destination`, which must not already
   exist), the second time with `--dest-baseline` pointed at the *first*
   run's `destination` directory:

   ```sh
   node scripts/copybara-export.mjs \
     --source-repo /path/to/private-repo-checkout --rev main \
     --jar /path/to/copybara_deploy.jar --workdir /tmp/copybara-poc-1

   node scripts/copybara-export.mjs \
     --source-repo /path/to/private-repo-checkout --rev main \
     --jar /path/to/copybara_deploy.jar --workdir /tmp/copybara-poc-2 \
     --dest-baseline /tmp/copybara-poc-1/destination
   ```

   Reusing the same `--workdir` for both runs fails: the second run's clones
   would target the still-populated `origin`/`destination`/
   `destination-checkout` directories from the first run. Modeled and
   asserted in `test/copybara-export.test.js` ("two successive runs..."),
   which likewise uses a fresh workdir per run.
3. **Tree comparison against the intended public file set** — `diff -rq
   $workdir/origin $workdir/destination-checkout` (excluding `.git`) should
   show differences only for paths in `PRIVATE_ONLY_PATHS`,
   `LOCAL_ARTIFACT_PATHS`, and `DESTINATION_OWNED_PATHS`. (`$workdir/destination`
   itself is bare and has no working tree to diff against — see
   [Reproducible command](#reproducible-command).)
4. **Adversarial leak-check fixture** — `test/copybara-validate.test.js`
   seeds personal paths, credential-shaped strings, the private repo
   identifier, and forbidden paths/extensions, and asserts
   `scanTree(...).ok === false` with matching findings for each.
5. **`npm test`** — exercises all of the above logic without requiring Java
   or Copybara to be installed (see next section).

## Limitations for productionization

- **Pin is unpopulated in this PoC.** No network egress was available while
  authoring this prototype, so `copybara/PIN.json` ships with `release` and
  `jarSha256` set to `null`. An operator must run the pin-bootstrap procedure
  above against a real, independently-verified jar before the first real
  export — the wrapper fails closed until then.
- **Copybara's own release cadence is irregular.** Unlike most CLIs it does
  not consistently publish versioned, checksummed release artifacts;
  building from a pinned upstream commit SHA may be a more durable pin than
  a downloaded jar. Evaluate both before committing to one in production.
- **`PRIVATE_ONLY_PATHS` is a human-curated allowlist-by-exclusion**, not
  something Copybara or the validator can derive from content. A new
  internal-only doc that isn't added to this list will still reach the
  public mirror unless it happens to trip a content rule in
  `copybara-validate.mjs`. Treat the validator as a safety net, not a
  substitute for reviewing new top-level docs before they're added.
- **Credential detection is pattern-based**, matching known token shapes and
  a conservative "quoted secret-looking assignment" heuristic. It will not
  catch novel or obfuscated secret formats.
- **This prototype's own test suite cannot exercise the real jar** (no Java
  in the authoring sandbox), so `test/copybara-export.test.js` injects a
  stub command runner that simulates a successful/failing `java -jar`
  invocation to test the wrapper's orchestration logic. That stub is test
  infrastructure only — it intentionally does not implement Copybara's
  transform semantics and must not be mistaken for one. Real runs always
  require the actual pinned jar.
- **No push, branch, or PR creation exists yet.** Landing the first real
  bootstrap commit on the public repository, and every export after it,
  remains a deliberate, separately-authorized, separately-reviewed action —
  by design, this issue only proves the local-only mechanics.
- **`test/**` content is exempt from every `CONTENT_RULES` check.** Because
  `origin_files` exports this repository's own tests, and the test suite
  deliberately contains realistic-looking absolute paths, PEM-shaped
  placeholder key blocks, and token-shaped placeholder strings as fixture
  data (see "Privacy and prerequisites" above), a literal scan of the
  transformed tree over its own tests would reject a normal export of this
  very repository. `scripts/copybara-validate.mjs` exempts `test/**` from
  content scanning accordingly (path-based rules, e.g. `.pem`/`id_rsa` by
  name, still apply there). Two non-test files that document the same
  placeholder-path convention in prose/comments
  (`docs/idea-to-implementation.md`, `src/core/text-sanitize.ts`,
  `src/core/tool-request.ts`) are exempted from the personal-path rules
  only. A production rollout should narrow this to actual fixture files
  rather than the whole `test/` directory, or move fixture data that must
  stay off the public mirror into `PRIVATE_ONLY_PATHS`.

## `npm test`

`node --experimental-vm-modules node_modules/.bin/jest` (via `npm test`)
covers `scripts/copybara-validate.mjs` and `scripts/copybara-export.mjs` in
full, using real local `git` fixtures (this repository's existing test
convention) for the git-staging logic and injected stub runners for the
Java/Copybara invocation points that cannot be exercised without those
external tools installed.
