// Issue #1152 fixture: a tiny plain-CommonJS Jest project. Its test files end
// in `.test.cjs`, which this repository's own Jest `testMatch` never collects,
// so the fixture only runs when a test copies it out and drives it through the
// test-file adapter.
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.cjs'],
  // Plain CommonJS needs no Babel; loading it only slows every spawned Jest.
  transform: {},
  watchman: false,
};
