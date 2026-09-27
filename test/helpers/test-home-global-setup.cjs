/**
 * Jest `globalSetup` — create this run's test-owned HOME (issue #1063).
 *
 * Runs once, in the Jest main process, before any worker is forked, and mutates
 * the REAL environment: jest-worker forks children with `{...process.env}`, so
 * every worker — and every child a test spawns without an explicit `env` —
 * inherits the isolated home. `setupFiles` re-applies the same values inside each
 * worker's sandboxed copy of `process.env`; see test/helpers/test-home.js.
 *
 * CommonJS on purpose. Jest loads this hook with `requireOrImportModule`, which
 * tries `require()` first and only falls back to `import()` on `ERR_REQUIRE_ESM`.
 * On a Node that enables `require(esm)` the require succeeds and hands Jest a
 * module namespace where it expects a function ("globalSetup file must export a
 * function"). A `.cjs` wrapper that dynamically imports the ESM helper behaves
 * the same way on every Node version.
 */
module.exports = async function setupTestHome() {
  const { applyTestHomeEnv, createTestHomeRoot } = await import('./test-home.js');
  applyTestHomeEnv(process.env, createTestHomeRoot());
};
