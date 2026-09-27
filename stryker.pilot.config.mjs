/**
 * Issue #1111 — the opt-in, scoped StrykerJS configuration for the Test
 * Maintenance Pilot (slice 3/8). Nothing in the default verification path reads
 * this file: `npm test`, `pretest`, `npm run package` and per-PR CI never
 * mention mutation testing, and the file name is deliberately NOT the name
 * Stryker discovers on its own (`stryker.conf.json` / `stryker.config.mjs`), so
 * a bare `npx stryker run` in this checkout finds no configuration at all.
 * Every run is an explicit `node scripts/mutation-pilot.mjs` (or an explicit
 * `stryker run stryker.pilot.config.mjs`).
 *
 * ## Scope
 *
 * The scope is the one #1110 selected and its independent review accepted
 * (`docs/metrics/test-maintenance-candidates.md` §5): two small modules and the
 * four in-process test files that are counted as evidence for them. It is not
 * the repository. Widening it is a scope change, not a configuration tweak.
 *
 * ## Why the configuration looks like this
 *
 * The repository's tests import the COMPILED output (`../dist/index.js`,
 * `../dist/cli/admin.js`) — 263 of 316 test files do, and none imports `src/`.
 * A mutant therefore only reaches a test through a real TypeScript build, and
 * four settings exist to make that true and provable:
 *
 *   1. `dist` is gitignored, and Stryker's sandbox honours `.gitignore`. It is
 *      also named in `ignorePatterns` so the guarantee does not depend on that.
 *      The sandbox starts with NO `dist/`, so a stale build cannot answer for a
 *      mutated source: if `buildCommand` failed, there would be nothing to
 *      import and every test would error rather than pass silently.
 *   2. `buildCommand` runs `scripts/mutation-build.mjs`, which runs the
 *      project's own `tsc` over the project's own `tsconfig.json` with the
 *      sandbox as the working directory, and then checks that every mutated
 *      source actually emitted instrumented JavaScript into `dist/`. Both the
 *      wrapper and the compiler are named by ABSOLUTE path in the checkout (see
 *      `buildCommandFor`). `--noEmitOnError false` is a sandbox-only override
 *      on the command line: `tsconfig.json` keeps `noEmitOnError: true` for the
 *      real build, while the sandbox still emits JavaScript if the instrumented
 *      tree does not type-check. Declarations and source maps are off because
 *      nothing in the test path reads them.
 *   3. `disableTypeChecks` is a glob over the compiled sources, NOT `false`.
 *      Stryker's instrumentation is not valid TypeScript — it assigns to its own
 *      `stryNS_*`/`stryCov_*`/`stryMutAct_*` function declarations and calls
 *      them with arguments they do not declare — so `tsc` reports errors like
 *      TS2630/TS2554 for a file it instrumented. `--noEmitOnError false` does
 *      not rescue that: it changes whether JavaScript is *emitted*, never the
 *      exit code, and `tsc` still exits 2, which Stryker treats as a failed
 *      build. Stryker's answer is to prepend `// @ts-nocheck` to the sandbox
 *      copies (it does this by default, for the same reason); this
 *      configuration scopes that to `src/**\/*.ts`, the only files
 *      `tsconfig.json` compiles, so the sandbox's test files stay byte-identical
 *      to the checkout's.
 *   4. `jest.enableFindRelatedTests` is **false**. Jest's `--findRelatedTests`
 *      walks the module graph from the changed file; because the tests import
 *      `dist/` and never `src/`, it would relate a mutated `src/core/*.ts` to
 *      ZERO test files and report every mutant as surviving. That failure mode
 *      is silent and would be indistinguishable from weak tests, so the option
 *      is pinned off rather than left at its default.
 *
 * `inPlace` is false (Stryker's default, pinned here anyway): the checkout is
 * never mutated, so an unrelated dirty file in the working tree is never at
 * risk. All Stryker state lives under `.mutation/` (gitignored).
 *
 * ## What is deliberately NOT configured
 *
 *   - No `dashboard` reporter and no API key: reports stay on this machine.
 *   - `thresholds.break` is null. A mutation score is supporting evidence, not
 *     an acceptance gate, and this pilot must never be able to "pass" by
 *     lowering a threshold.
 *   - `incremental` is off by default. Incremental mode reuses results from a
 *     previous run, which is exactly wrong for a before/after comparison; the
 *     driver only enables it on explicit request, for iterating on the harness.
 *     Even then the state file is keyed by mode and by everything that decides a
 *     verdict — scope, coverage analysis, deadline, Jest configuration and the
 *     executing toolchain (`INCREMENTAL_DIR`, `INCREMENTAL_IDENTITY_KEYS`) — so a
 *     run never inherits verdicts from a different test selection, a different
 *     timeout or a different tool version.
 *   - No `@stryker-mutator/typescript-checker`. It would discard mutants that
 *     do not type-check, which changes the mutant population between runs
 *     depending on unrelated type changes.
 *
 * Reference: https://stryker-mutator.io/docs/stryker-js/configuration/
 * and https://stryker-mutator.io/docs/stryker-js/incremental/
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

/** The two modules #1110 selected to mutate. Not a glob: exactly these files. */
export const PILOT_MUTATE = ['src/core/chain-linear.ts', 'src/core/tool-request-grant.ts'];

/**
 * The four test files #1110 counts as evidence for those modules. All four run
 * the production code inside the Jest worker (pure imports, or `runAdmin`), so
 * an active mutant is observable from them. `admin-tool-request-run.test.js`
 * and `tool-request-run-operation.test.js` reach the same sources and are
 * deliberately absent (§5 "Reaches the pilot sources but excluded").
 */
export const PILOT_TESTS = [
  'test/chain-linear.test.js',
  'test/admin-chain-edit.test.js',
  'test/tool-request-grant.test.js',
  'test/admin-tool-request-grant.test.js',
];

/**
 * The smoke scope: `normalizeCommand`'s declarations, its `flushPendingSpace`
 * helper and the scan loop header (`src/core/tool-request-grant.ts:73-84`).
 * Every statement in that range is directly asserted by the first four cases of
 * the pure suite ("trims and collapses internal whitespace", "preserves
 * whitespace inside quoted arguments", ...), so a mutant that reaches the
 * executed code is expected to be killed. A survivor here is far more likely to
 * mean the mutant never reached `dist/` than that the tests are weak, which is
 * what makes this a usable check on the harness itself.
 */
export const SMOKE_MUTATE = ['src/core/tool-request-grant.ts:73-84'];
export const SMOKE_TESTS = ['test/tool-request-grant.test.js'];

/**
 * Issue #1112 — the frozen baseline scope: a bounded line range **inside each of
 * the two accepted sources**, judged by all four accepted test files.
 *
 * This is the one narrowing #1110 §5 allows ("a narrower mutate range inside the
 * same two files ... is the only allowed reduction, and it must be stated"), and
 * it exists because the whole-file scope does not fit a bounded run: #1111's dry
 * run instrumented 742 mutants over 1147 source lines against a 181.3 s pass over
 * the four suites, a reference cost of ≈ 37 h serial / ≈ 18.7 h at the default
 * concurrency of 2 (`docs/metrics/mutation-pilot-harness.md` §6). Nothing else
 * was reduced: the four test files are unchanged, the mutators are unchanged, and
 * `PILOT_MUTATE` still bounds which files may appear here at all.
 *
 * Both ranges hold **whole functions**, chosen for the contracts the later slices
 * would put at risk. The boundaries are function boundaries and nothing else: a
 * range that stopped short of a function's own refusal messages would drop the
 * mutants least likely to be killed, which is score-chasing by scope selection.
 *
 *   - `src/core/chain-linear.ts:329-359` — `edgeKey`, `compareEdges`, `linkEdges`
 *     and `resolveRoots`. Edge identity, edge ordering, the line a chain is built
 *     from and the root a `prepend` attaches to. `planLinearChainEdit` and
 *     `verifyLinearChainReadBack` are both built out of these four, so every case
 *     in the pure suite *and* in `admin-chain-edit.test.js` — the costliest suite,
 *     and the *optimize* candidate — reaches them through the public API.
 *   - `src/core/tool-request-grant.ts:237-244` — `grantStatus`, the grant lifetime
 *     decision (exhaustion before expiry). It is the security-relevant contract
 *     behind the *consolidate* candidate (§3.9), asserted directly by
 *     `tool-request-grant.test.js` and reached by `admin-tool-request-grant.test.js`
 *     through `tool-request-run.ts`'s exhausted-grant path — which is what makes
 *     per-suite detection comparable later.
 *
 * **These are not the largest regions that would fit; they are regions whose
 * worst case fits.** An earlier freeze of this constant took
 * `verifyLinearChainReadBack` whole (`chain-linear.ts:796-859`) together with
 * `grantStatus` and `grantMatches` (`tool-request-grant.ts:237-288`). Its dry run
 * measured **137 mutants**, and the cost gate in
 * `docs/metrics/mutation-pilot-baseline.md` §4 refused it. That measurement is
 * kept in the report rather than discarded: it is why this range is smaller, and
 * what a later slice would have to pay to widen it back.
 *
 * **Frozen.** `docs/metrics/mutation-pilot-baseline.md` publishes these ranges
 * with the rest of the run identity, and both halves of any before/after
 * comparison must use them unchanged. Moving a line above either range shifts its
 * contents without changing the text here, so the baseline report records the
 * revision the ranges were resolved at, and the mutants by source location,
 * operator, original and replacement rather than by index.
 */
export const BASELINE_MUTATE = ['src/core/chain-linear.ts:329-359', 'src/core/tool-request-grant.ts:237-244'];

/**
 * TypeScript's JavaScript entry point, relative to the package root.
 * `node_modules/.bin/tsc` is a shell shim on Windows, which `node` cannot
 * execute — the same reason `scripts/test-cost-baseline.mjs` spells out
 * `node_modules/jest/bin/jest.js`.
 */
export const TSC_ENTRY = 'node_modules/typescript/bin/tsc';

/**
 * The sandbox build wrapper, relative to the package root. It is a plain
 * `.mjs` file with no dependency outside Node's standard library and this
 * module, so it runs fine in a sandbox that has no `node_modules` yet.
 */
export const MUTATION_BUILD_ENTRY = 'scripts/mutation-build.mjs';

/**
 * The compiler flags the sandbox build adds to the project's own tsconfig.
 * Command line only: the checked-in `tsconfig.json` is never edited.
 *   - `--noEmitOnError false` so an instrumented tree still emits JavaScript.
 *   - `--declaration false` because declaration emit has its own diagnostics
 *     that `// @ts-nocheck` does not suppress, and nothing imports the `.d.ts`.
 *   - `--sourceMap false` because nothing in the test path reads the maps.
 */
export const TSC_ARGS = ['-p', 'tsconfig.json', '--noEmitOnError', 'false', '--declaration', 'false', '--sourceMap', 'false'];

/**
 * The identifier Stryker's instrumentation puts in every file it mutated
 * (`stryMutAct_<hash>`); the hash is deliberately not part of the marker. Its
 * presence in the COMPILED output is what proves a mutant reached the
 * JavaScript the tests import, rather than only the `src` tree they do not.
 */
export const INSTRUMENTATION_MARKER = 'stryMutAct_';

/**
 * The checkout this configuration file lives in — never the sandbox copy.
 * Stryker loads the configuration from the working directory *before* it fills
 * the sandbox, so `import.meta.url` here is always the checkout path.
 */
export const PROJECT_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Absolute path to the compiler the sandbox build will execute. */
export function resolveTscEntry(root = PROJECT_ROOT) {
  return join(root, TSC_ENTRY);
}

/** Absolute path to the build wrapper Stryker runs inside the sandbox. */
export function resolveBuildEntry(root = PROJECT_ROOT) {
  return join(root, MUTATION_BUILD_ENTRY);
}

/**
 * Where Stryker must prepend `// @ts-nocheck` in the sandbox: exactly the files
 * `tsconfig.json` compiles (`include: ["src/**\/*.ts"]`). Absolute, because
 * Stryker resolves a relative pattern against the process's working directory
 * and matches it against absolute file names — the same reason the build
 * command spells out the compiler's path.
 */
export function disableTypeChecksFor(root = PROJECT_ROOT) {
  return join(root, 'src/**/*.ts');
}

/**
 * Stryker runs `buildCommand` through execa's *command* form (`execaCommand`,
 * i.e. execa's exported `parseCommandString`), which has no shell. That parser
 * trims the string, splits it on runs of spaces and, when a token ends in a
 * backslash, drops that ONE backslash and merges the next token back in with a
 * single space. Nothing else is special: a backslash anywhere else — `\\`
 * included — is passed through literally, and it never unescapes anything.
 *
 * So the complete escape for this parser is a backslash before each space, and
 * nothing more. Doubling backslashes, as a shell escape would, is wrong here: it
 * would turn `C:\Work\repo` into an argument with twice the separators. A
 * backslash already in the value before a space still round-trips (`a\ b`
 * becomes `a\\ b`, the parser drops only the last backslash). What the parser
 * cannot represent is refused instead of mangled: a value ending in a backslash
 * (it would swallow the delimiter after it) and one with whitespace at either
 * edge (the trim and the space-run split would eat it).
 */
export function escapeCommandToken(value) {
  const text = String(value);
  if (text === '' || /^\s|\s$/.test(text) || text.endsWith('\\')) {
    throw new Error(`cannot represent ${JSON.stringify(text)} as one execa command token`);
  }
  return text.split(' ').join('\\ ');
}

/**
 * The sandbox build: `scripts/mutation-build.mjs`, which runs the project's own
 * tsconfig with `TSC_ARGS` and then proves the mutated sources reached `dist/`.
 * The wrapper exists because `tsc` exits 2 on a type error whatever
 * `--noEmitOnError` says, so a bare `tsc` command turns any diagnostic in the
 * instrumented tree into a failed Stryker run with no mutant tested. The
 * wrapper accepts a non-zero exit only when the JavaScript the tests import was
 * emitted AND carries the instrumentation, and fails loudly otherwise.
 *
 * Both paths are ABSOLUTE in the checkout, and that is load bearing rather than
 * a style choice. `Sandbox.init()` in @stryker-mutator/core
 * 8.7.x is `fillSandbox()` → `runBuildCommand()` → `symlinkNodeModulesIfNeeded()`
 * — the build runs BEFORE `node_modules` is linked into the sandbox, and
 * `node_modules` is excluded from the sandbox copy besides. The pin moved to
 * the 10.x line in #1185; absolute paths do not depend on that order, so they
 * stay correct whether or not a later release keeps it. A sandbox-relative
 * `node node_modules/typescript/bin/tsc` therefore fails with MODULE_NOT_FOUND,
 * no `dist/` is emitted, and the run dies before a single mutant is tested.
 * Relying instead on `tsc` from `PATH` would work only by accident: Stryker
 * builds that `PATH` with `npmRunPathEnv()` at the *parent's* working directory,
 * which is an implementation detail that would stop pointing at the checkout the
 * moment it is corrected to use the sandbox.
 *
 * The working directory is still the sandbox, so `-p tsconfig.json` reads the
 * sandbox's (instrumented) sources and emits the sandbox's `dist/`. Type
 * resolution reaches the checkout's `node_modules` by the ordinary upward walk,
 * because the sandbox lives under `tempDirName` inside the checkout.
 */
export function buildCommandFor(root = PROJECT_ROOT) {
  return `node ${escapeCommandToken(resolveBuildEntry(root))}`;
}

export const BUILD_COMMAND = buildCommandFor();

/** Default directory for every artifact this harness produces (gitignored). */
export const DEFAULT_OUT = '.mutation';

/**
 * Stryker's `timeoutFactor`. A mutant's deadline is
 * `timeoutFactor × netTime + timeoutMS + overhead`, where `netTime` is the
 * covering tests' time in the dry run — so `timeoutMs` is only the additive
 * baseline, and a summary must record this factor for a `Timeout` verdict to be
 * interpretable.
 */
export const DEFAULT_TIMEOUT_FACTOR = 2;

/**
 * Where Stryker builds its sandbox, relative to `--out`. `cleanTempDir` removes
 * it after an orderly run, but a run killed before Stryker can clean up leaves a
 * whole copy of the checkout behind; `scripts/mutation-pilot.mjs` prunes those on
 * the next run, which is why the name is shared rather than written out twice.
 */
export const TEMP_DIR_NAME = 'stryker-tmp';
/** Prefix Stryker gives each sandbox directory inside `TEMP_DIR_NAME`. */
export const SANDBOX_PREFIX = 'sandbox-';
/**
 * Where `--incremental` keeps the state it reuses between runs: a directory
 * inside the run's OWN report directory, holding one file per mutation/test
 * scope. It is a full mutation report — every mutant, with the source it was
 * made from — so it is one of the raw artifacts the preflight must prove Git
 * excludes. The name is shared rather than written out twice for exactly that
 * reason: a check that asks about a path this config no longer writes would pass
 * while the real file stayed committable.
 *
 * One file per `<out>` would be wrong, and quietly so. Stryker reuses a stored
 * result whenever the mutant still matches the source it was made from; with
 * `coverageAnalysis: 'off'` there is no coverage matrix, so nothing in that
 * comparison can notice that the run which stored the result had a DIFFERENT
 * test selection. A smoke run and a pilot run sharing one state file therefore
 * hand each other verdicts their own suites never produced — a pilot keeping a
 * smoke survivor without ever running the three extra suites, or a smoke run
 * reporting kills that only a pilot-only test made. The same is true of the
 * deadline, which decides a verdict directly (`Timeout` counts as detected) —
 * and of the worker count that deadline is measured under.
 * Mode and the full run identity decide the path, so state is only ever reused
 * by a run that would have produced it; see `INCREMENTAL_IDENTITY_KEYS`.
 */
export const INCREMENTAL_DIR = 'incremental';

/**
 * Paths the sandbox must not receive. `dist` is the important one (see the
 * header); the rest are local artifact directories that would only make the
 * sandbox larger and slower to create. Stryker also applies its own defaults
 * and the repository `.gitignore` on top of these.
 */
export const IGNORE_PATTERNS = ['dist', '.mutation', '.test-cost', '.n8n-artifacts', 'coverage'];

/**
 * `IGNORE_PATTERNS` plus the run's own `--out`, when that lies inside the
 * checkout under another name than `.mutation`.
 *
 * Stryker reads the sandbox's files from the checkout itself, and it excludes
 * only the current mode's own report files and its temp directory — not the
 * rest of `<out>`. An in-tree `--out reports/pilot` would otherwise put the live
 * `run.log`, the run spec and every earlier mode's HTML, JSON and incremental
 * reports into every sandbox. The pattern is anchored to the root (a leading
 * `/`) and has minimatch's special characters escaped, so it names that one
 * directory and nothing that merely shares its name. An `--out` outside the
 * checkout is never read into a sandbox and adds nothing; neither does one that
 * IS the checkout, which would exclude every file.
 */
export function ignorePatternsFor(out, root = PROJECT_ROOT) {
  const rel = relative(resolve(root), resolve(root, String(out)));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return IGNORE_PATTERNS;
  const posix = rel.split(sep).join('/');
  if (IGNORE_PATTERNS.includes(posix)) return IGNORE_PATTERNS;
  return [...IGNORE_PATTERNS, `/${posix.replace(/[\\*?[\]{}()]/g, '\\$&')}`];
}

/** Statuses the mutation-testing report schema uses for a mutant the harness could not evaluate. */
export const ERROR_STATUSES = ['CompileError', 'RuntimeError'];

/** Keys a run spec may set. Anything else is a typo or an attempt to widen the run. */
export const RUN_SPEC_KEYS = [
  'mutate',
  'testFiles',
  'out',
  'label',
  'concurrency',
  'timeoutMs',
  'timeoutFactor',
  'coverageAnalysis',
  'incremental',
  'dryRunOnly',
];

/**
 * The bound from #1110 §5, enforced where it cannot be bypassed: every mutate
 * entry must name one of the two accepted sources (a trailing `:from-to` line
 * range is the only narrowing the issue allows), and every test file must come
 * from the accepted four. A whole-repository pass is not a configuration this
 * module can produce.
 */
export function assertScope(mutate, testFiles) {
  if (!Array.isArray(mutate) || mutate.length === 0) throw new Error('mutate must be a non-empty array');
  if (!Array.isArray(testFiles) || testFiles.length === 0) throw new Error('testFiles must be a non-empty array');
  for (const entry of mutate) {
    const file = String(entry).split(':')[0];
    if (!PILOT_MUTATE.includes(file)) {
      throw new Error(`mutate entry outside the accepted #1110 scope: ${entry} (allowed: ${PILOT_MUTATE.join(', ')})`);
    }
  }
  for (const file of testFiles) {
    if (!PILOT_TESTS.includes(file)) {
      throw new Error(`test file outside the accepted #1110 scope: ${file} (allowed: ${PILOT_TESTS.join(', ')})`);
    }
  }
}

/**
 * One run's parameters, handed over by `scripts/mutation-pilot.mjs` through a
 * file path in `MUTATION_PILOT_SPEC`. Indirection rather than a generated
 * config file so the configuration Stryker loads always sits at the repository
 * root, where its relative paths (`mutate`, `tempDirName`, report file names)
 * resolve the same way whatever base Stryker picks. With no spec set, this file
 * is the full pilot configuration on its own.
 */
export function loadRunSpec(env = process.env, read = (path) => readFileSync(path, 'utf8')) {
  const specPath = env.MUTATION_PILOT_SPEC;
  if (!specPath) return {};
  const spec = JSON.parse(read(specPath));
  const unknown = Object.keys(spec).filter((key) => !RUN_SPEC_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`unknown run-spec key(s): ${unknown.join(', ')}`);
  return spec;
}

/** Read the project's Jest configuration so the sandbox run cannot drift from it. */
export function projectJestConfig(manifest = readManifest()) {
  const jest = manifest.jest;
  if (!jest || typeof jest !== 'object') {
    throw new Error('package.json has no "jest" configuration to derive the pilot run from');
  }
  return jest;
}

function readManifest() {
  return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
}

/**
 * Everything that decides which mutants a run produces and what verdict each one
 * gets. Two runs agreeing on all of it would have produced each other's results,
 * and only those may share incremental state.
 *
 *   - `mutate` / `testFiles`: the mutated sources and the selection that judges
 *     them.
 *   - `coverageAnalysis`: how much of that selection each mutant actually runs.
 *   - `timeoutMs` / `timeoutFactor`: the deadline a mutant is judged against.
 *     Stryker counts a `Timeout` as a DETECTION, so the deadline decides the
 *     verdict just as directly as the assertions do — a mutant that only ran
 *     long under a 5 s deadline is `Timeout` (detected) there and may be
 *     `Survived` at 60 s. Reusing the first verdict under the second deadline
 *     reports a detection no test made and no run under these settings ever
 *     observed, which is exactly the misreading this pilot must not publish.
 *   - `concurrency`: the other half of that same deadline. The budget is
 *     wall-clock, and these suites spawn real `git`, `/bin/sh` and a fake `gh`
 *     per call, so how many mutants run at once decides how much of the host a
 *     test actually gets. A mutant that only reached `Timeout` because eight
 *     workers were contending is a detection the assertions never made, and
 *     inheriting it into a one-worker run publishes it as one. It is in the
 *     identity for the same reason `timeoutMs` is: it moves verdicts.
 *   - `jestConfig`: the project's Jest configuration the scoped run inherits
 *     (setup files, environment, module handling) — a change there changes what
 *     every test does.
 *   - `toolchain`: what actually executes the run — see `harnessToolchain`.
 *     Stryker reuses a stored status whenever the source and test files are
 *     unchanged; it does not notice that the Stryker, Jest runner, Jest,
 *     TypeScript or Node that produced it has since been upgraded, or that the
 *     harness configuration or sandbox build changed. The summary records the
 *     versions installed NOW, so inheriting across such a change would attribute
 *     verdicts to tools that never produced them.
 *
 * The order is fixed here rather than left to an object literal because the
 * digest is taken over the serialized form: two callers writing the same fields
 * in a different order must not get two different state files.
 */
export const INCREMENTAL_IDENTITY_KEYS = [
  'mutate',
  'testFiles',
  'coverageAnalysis',
  'timeoutMs',
  'timeoutFactor',
  'concurrency',
  'jestConfig',
  'toolchain',
];

/** The installed packages whose versions decide how a run executes. */
export const TOOLCHAIN_PACKAGES = ['@stryker-mutator/core', '@stryker-mutator/jest-runner', 'jest', 'typescript'];

/**
 * The harness files that decide how a run executes: this configuration, the
 * sandbox build wrapper and the compiler configuration it builds with. Hashed by
 * content, so an edit to any of them starts fresh incremental state.
 */
export const TOOLCHAIN_FILES = ['stryker.pilot.config.mjs', 'scripts/mutation-build.mjs', 'tsconfig.json'];

/**
 * The `toolchain` half of the incremental identity: the Node version, each
 * `TOOLCHAIN_PACKAGES` version as installed under `root`, and a content hash of
 * each `TOOLCHAIN_FILES` entry. Something that cannot be read is recorded as
 * `absent` rather than skipped, so it still names a distinct identity — and one
 * that changes the moment it becomes readable.
 */
export function harnessToolchain(root = PROJECT_ROOT, { read = (path) => readFileSync(path, 'utf8'), node = process.version } = {}) {
  const attempt = (fn) => {
    try {
      return fn();
    } catch {
      return 'absent';
    }
  };
  return {
    node,
    packages: Object.fromEntries(
      TOOLCHAIN_PACKAGES.map((name) => [
        name,
        attempt(() => JSON.parse(read(join(root, 'node_modules', name, 'package.json'))).version ?? 'unknown'),
      ]),
    ),
    files: Object.fromEntries(
      TOOLCHAIN_FILES.map((file) => [file, attempt(() => createHash('sha256').update(read(join(root, file))).digest('hex'))]),
    ),
  };
}

/**
 * The digest naming one run's incremental state — see `INCREMENTAL_IDENTITY_KEYS`
 * for what goes into it.
 *
 * A missing field throws rather than being skipped. `JSON.stringify` drops an
 * `undefined` value, so an omitted setting would silently produce the digest of
 * a run that did not declare it — and hand its verdicts to a run that declares
 * something else. That failure is invisible in the output (the run simply reuses
 * state) so it has to be impossible at the call.
 *
 * A digest rather than a readable name because the inputs are lists of paths
 * with line ranges. It is not a security boundary — it only has to differ when
 * the identity differs — so a truncated SHA-256 is ample.
 */
export function incrementalScopeDigest(identity) {
  const missing = INCREMENTAL_IDENTITY_KEYS.filter((key) => identity?.[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`incremental identity is missing verdict-affecting setting(s): ${missing.join(', ')}`);
  }
  const scope = JSON.stringify(Object.fromEntries(INCREMENTAL_IDENTITY_KEYS.map((key) => [key, identity[key]])));
  return createHash('sha256').update(scope).digest('hex').slice(0, 16);
}

/**
 * The incremental state file for one run: inside that run's report directory (so
 * a mode never reads another mode's state) and named for its identity digest (so
 * a widened or narrowed scope — or a changed deadline — under the same mode
 * starts fresh instead of inheriting verdicts the new settings never produced).
 * See `INCREMENTAL_DIR` and `INCREMENTAL_IDENTITY_KEYS`.
 */
export function incrementalFileFor({ out, label, ...identity }) {
  return `${out}/${label}/${INCREMENTAL_DIR}/${incrementalScopeDigest(identity)}.json`;
}

/**
 * Restrict a Jest run to exactly the scoped test files. Exact paths are valid
 * `testMatch` patterns, and `<rootDir>` resolves inside Stryker's sandbox, so
 * the scoped run reads the sandbox's copies rather than the checkout's.
 */
export function jestTestMatch(testFiles) {
  return testFiles.map((file) => `<rootDir>/${file}`);
}

/**
 * Build a complete, JSON-serializable Stryker configuration for one run.
 *
 * `coverageAnalysis` defaults to `off`: every mutant runs the whole scoped test
 * selection. That is the slower option and the only one whose result needs no
 * assumption about whether Stryker's per-test coverage hooks attribute
 * correctly through this repository's native-ESM Jest setup and through
 * `runAdmin`. `perTest` is reachable (`--coverage-analysis perTest`) but its
 * scores must be compared against an `off` run before they are used as
 * evidence — an unattributed test looks like "no coverage", which is
 * indistinguishable from a real coverage gap.
 */
export function pilotStrykerConfig({
  mutate = PILOT_MUTATE,
  testFiles = PILOT_TESTS,
  out = DEFAULT_OUT,
  label = 'pilot',
  concurrency = 2,
  timeoutMs = 60_000,
  timeoutFactor = DEFAULT_TIMEOUT_FACTOR,
  coverageAnalysis = 'off',
  incremental = false,
  dryRunOnly = false,
  jestConfig = projectJestConfig(),
  toolchain = harnessToolchain(),
} = {}) {
  assertScope(mutate, testFiles);
  const reportDir = `${out}/${label}`;
  return {
    $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
    packageManager: 'npm',
    plugins: ['@stryker-mutator/jest-runner'],
    // Exactly the accepted scope. Never a glob over `src/`.
    mutate,
    buildCommand: BUILD_COMMAND,
    testRunner: 'jest',
    // Jest here runs native ESM (`"type": "module"`, untransformed `.js`
    // tests), which needs the VM-modules flag in the test-runner process.
    testRunnerNodeArgs: ['--experimental-vm-modules'],
    jest: {
      projectType: 'custom',
      // The project's own Jest configuration, read from package.json so it
      // cannot drift, plus the scope restriction. `globalSetup`/`setupFiles`
      // come along: without them the test-owned HOME (#1063) is missing and
      // every test file throws instead of reading the operator's real home.
      config: { ...jestConfig, testMatch: jestTestMatch(testFiles) },
      // See the header: leaving this at its default would relate a mutated
      // `src/*.ts` to zero test files, because the tests import `dist/`.
      enableFindRelatedTests: false,
    },
    coverageAnalysis,
    dryRunOnly,
    // The checkout is never mutated; all state lives in the sandbox.
    inPlace: false,
    ignorePatterns: ignorePatternsFor(out),
    // Required, not cosmetic: the instrumented sources do not type-check, and
    // `tsc` exits non-zero on a diagnostic however `--noEmitOnError` is set, so
    // `false` here fails the sandbox build before a single mutant is tested.
    // Narrower than Stryker's default (`{test,src,lib}/**`): only the files
    // `tsconfig.json` compiles, so the sandbox's test files stay byte-identical
    // to the checkout's.
    disableTypeChecks: disableTypeChecksFor(),
    concurrency,
    // A generous per-test deadline on purpose: Stryker counts a timeout as a
    // KILL, so a tight deadline manufactures detections that the assertions
    // never made. The pilot suites include real `git`, real `/bin/sh` and a
    // fake `gh` process per call.
    timeoutMS: timeoutMs,
    timeoutFactor,
    tempDirName: `${out}/${TEMP_DIR_NAME}`,
    cleanTempDir: true,
    // No `dashboard`: nothing leaves this machine.
    reporters: ['clear-text', 'progress', 'json', 'html'],
    jsonReporter: { fileName: `${reportDir}/mutation.json` },
    htmlReporter: { fileName: `${reportDir}/mutation.html` },
    incremental,
    // Per mode, per scope AND per verdict-affecting setting: see
    // `INCREMENTAL_DIR` for why one file under `<out>` lets two different test
    // selections answer for each other, and `INCREMENTAL_IDENTITY_KEYS` for why
    // the deadline — both its length and the worker count it is measured under —
    // belongs in the name alongside the scope.
    incrementalFile: incrementalFileFor({
      out,
      label,
      mutate,
      testFiles,
      coverageAnalysis,
      timeoutMs,
      timeoutFactor,
      concurrency,
      jestConfig,
      toolchain,
    }),
    // Reporting only. A mutation score is evidence, never an acceptance gate.
    thresholds: { high: 80, low: 60, break: null },
  };
}

export default pilotStrykerConfig(loadRunSpec());
