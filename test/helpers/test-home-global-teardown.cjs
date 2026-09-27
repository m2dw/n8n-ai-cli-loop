/**
 * Jest `globalTeardown` — remove this run's test-owned HOME (issue #1063).
 *
 * Deletes only the root `globalSetup` created, and only after
 * `removeTestHomeRoot` has confirmed it looks like one. A refusal is raised
 * rather than swallowed: it means the run was about to delete a directory it
 * does not own, which is worth failing over even though nothing was removed.
 *
 * See test/helpers/test-home-global-setup.cjs for why this is CommonJS.
 */
module.exports = async function teardownTestHome() {
  const { TEST_HOME_ROOT_ENV, removeTestHomeRoot } = await import('./test-home.js');
  const root = process.env[TEST_HOME_ROOT_ENV];
  if (!root) return;
  const outcome = removeTestHomeRoot(root);
  if (!outcome.removed) throw new Error(outcome.reason);
};
