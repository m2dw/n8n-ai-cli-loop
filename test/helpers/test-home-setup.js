/**
 * Jest `setupFiles` — pin this worker's sandbox environment at the run's
 * test-owned HOME (issue #1063).
 *
 * `setupFiles` run before the test file is imported, which is the whole point:
 * the managed defaults (`DEFAULT_SESSIONS_PATH`, `DEFAULT_DB_PATH`,
 * `DEFAULT_LOCK_DIR`, `DEFAULT_WORKTREE_ROOT`, `DEFAULT_WORKTREE_LOCK_DIR`) are
 * module-load-time constants, so the environment has to be right *before*
 * `dist/index.js` is imported or they capture the operator's home instead.
 *
 * Jest hands each test file a copy of `process.env`, so this re-application is
 * not redundant with `globalSetup`: the copy is seeded from the real environment
 * (already pinned there) but a test may overwrite it, and `--runInBand` or a
 * hand-rolled config could reach here by a different route. Failing loudly when
 * the root is missing is deliberate — silently falling back to the operator's
 * home is exactly the behaviour this file exists to remove.
 */
import { applyTestHomeEnv, ensureTestHome, isTestHomeRoot, TEST_HOME_ROOT_ENV } from './test-home.js';

const root = process.env[TEST_HOME_ROOT_ENV];
if (!isTestHomeRoot(root)) {
  throw new Error(
    `${TEST_HOME_ROOT_ENV} is not a test-owned home root (got ${String(root)}). ` +
      'Jest must run with the globalSetup in package.json ' +
      '(test/helpers/test-home-global-setup.cjs); without it the suite would read and ' +
      "write the operator's real HOME.",
  );
}

ensureTestHome(root);
applyTestHomeEnv(process.env, root);
