// Issue #1097 — staged verification configuration and legacy compatibility
// (slice S2 of docs/staged-verification-contract.md §13), as rewritten by
// issue #1155.
//
// Pins the operator-owned session block and its fail-closed load: §5.3's
// `enabled`, #1096's `maxStageRecoveryAttempts` / `environmentIdentity` and
// #1152's `testSuite` binding — together with the compatibility promise that a
// session written before this chain loads and resolves to today's behavior.
//
// Issue #1155 deleted the group-selection settings — `selectable`, `finalOnly`,
// `selectionTimeoutMs`, `selectionAdapter`, `resultAdapters` and
// `resultTimeoutMs` — with the policy they configured. They are not migrated,
// aliased or specially detected; they are simply no longer in the closed field
// set, so the `unknown_field` rule refuses a session still carrying one. That
// refusal is pinned below because it is what the operator's own removal of the
// settings is checked against.
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  JsonSessionRegistry,
  validateStagedVerificationConfig,
  cloneStagedVerificationConfig,
  resolveStagedVerificationSettings,
  StagedVerificationConfigError,
  STAGED_VERIFICATION_SETTING_KEYS,
  DEFAULT_MAX_STAGE_RECOVERY_ATTEMPTS,
  MAX_STAGE_ENVIRONMENT_IDENTITY_CHARS,
  MAX_TEST_SUITE_REQUIREMENT_COMMAND_CHARS,
  TEST_SUITE_ADAPTER_KINDS,
} from '../dist/index.js';

const NAMES = ['test', 'lint', 'e2e'];

const validate = (block, names = NAMES) =>
  validateStagedVerificationConfig(block, 'stagedVerification', names);

/** Assert the block refuses, and return the thrown error for further checks. */
function expectRefusal(block, refusal, names = NAMES) {
  let thrown;
  try {
    validate(block, names);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(StagedVerificationConfigError);
  expect(thrown.refusal).toBe(refusal);
  return thrown;
}

describe('stagedVerification session block (§5.3, #1096 §7.3, #1152 §6 rule 5)', () => {
  test('accepts the fully specified block verbatim, defaulting nothing', () => {
    const config = validate({
      enabled: true,
      maxStageRecoveryAttempts: 2,
      environmentIdentity: 'node20-macos-arm64',
      testSuite: { test: { adapter: 'jest', setupCommand: 'npm run build', argumentSeparator: '--' } },
    });

    expect(config).toEqual({
      enabled: true,
      maxStageRecoveryAttempts: 2,
      environmentIdentity: 'node20-macos-arm64',
      testSuite: { test: { adapter: 'jest', setupCommand: 'npm run build', argumentSeparator: '--' } },
    });
  });

  test('the closed field set is exactly the four surviving settings (#1155)', () => {
    expect([...STAGED_VERIFICATION_SETTING_KEYS]).toEqual([
      'enabled',
      'maxStageRecoveryAttempts',
      'environmentIdentity',
      'testSuite',
    ]);
  });

  test('an unknown field refuses the session rather than being ignored', () => {
    const error = expectRefusal({ enabled: true, enable: true }, 'unknown_field');
    // The message names the closed set, so an operator can see what they meant.
    for (const key of STAGED_VERIFICATION_SETTING_KEYS) {
      expect(error.message).toContain(key);
    }
  });

  // #1155: no migration, no alias, no deprecation warning, no compatibility
  // mode. Each retired setting is just gone from the closed set, and a session
  // that still declares one does not load — including alongside a valid suite
  // binding, so half a retired policy can never reach a phase.
  test.each([
    ['selectable', ['test', 'e2e']],
    ['finalOnly', ['e2e']],
    ['selectionTimeoutMs', 30000],
    ['selectionAdapter', 'node scripts/loop-selection.mjs'],
    ['resultAdapters', { 'jest-v1': 'node scripts/loop-jest-result.mjs' }],
    ['resultTimeoutMs', 15000],
  ])('the retired group-selection setting %s refuses as an unknown field', (field, value) => {
    const error = expectRefusal({ [field]: value }, 'unknown_field');
    expect(error.path).toBe(`stagedVerification.${field}`);
    expectRefusal(
      { enabled: true, testSuite: { test: { adapter: 'jest' } }, [field]: value },
      'unknown_field',
    );
  });

  test('the block itself must be an object', () => {
    expectRefusal(['test'], 'not_an_object');
    expectRefusal(true, 'not_an_object');
  });

  test('enabled must be a boolean', () => {
    expectRefusal({ enabled: 'true' }, 'invalid_enabled');
  });

  test('maxStageRecoveryAttempts must be a positive integer', () => {
    expectRefusal({ maxStageRecoveryAttempts: 0 }, 'invalid_budget');
    expectRefusal({ maxStageRecoveryAttempts: -1 }, 'invalid_budget');
    expectRefusal({ maxStageRecoveryAttempts: 1.5 }, 'invalid_budget');
    expectRefusal({ maxStageRecoveryAttempts: '30000' }, 'invalid_budget');
    expect(validate({ maxStageRecoveryAttempts: 1 }).maxStageRecoveryAttempts).toBe(1);
  });

  test('environmentIdentity is an opaque but bounded single-line token (#1096 §4.5)', () => {
    expect(validate({ environmentIdentity: 'anything-opaque' }).environmentIdentity)
      .toBe('anything-opaque');
    expectRefusal({ environmentIdentity: '' }, 'invalid_environment_identity');
    expectRefusal({ environmentIdentity: 42 }, 'invalid_environment_identity');
    expectRefusal({ environmentIdentity: 'two\nlines' }, 'invalid_environment_identity');
    expectRefusal(
      { environmentIdentity: 'x'.repeat(MAX_STAGE_ENVIRONMENT_IDENTITY_CHARS + 1) },
      'invalid_environment_identity',
    );
  });

  test('validation never widens authorization: it only ever refuses', () => {
    // Every name the block may carry has to already be a `session.verification`
    // key, so a session with no verification commands can name nothing.
    expectRefusal({ enabled: true, testSuite: { test: { adapter: 'jest' } } }, 'unresolvable_name', []);
    expect(validate({ enabled: false }, [])).toEqual({ enabled: false });
  });
});

// Issue #1152 — the operator-owned suite binding
// (docs/changed-file-verification-contract.md §6 rule 5, §10.1 D4).
describe('stagedVerification.testSuite — the suite binding', () => {
  const SUITE = { test: { adapter: 'jest' } };

  test('an enabled block must bind the suite; nothing guesses it', () => {
    const error = expectRefusal({ enabled: true }, 'missing_test_suite');
    expect(error.path).toBe('stagedVerification.testSuite');
    // Even with a key literally named `test` available, absence refuses: #1155
    // left no selection policy for an enabled session to fall back to.
    expectRefusal({ enabled: true, maxStageRecoveryAttempts: 2 }, 'missing_test_suite');
  });

  test('a disabled or absent block needs no binding', () => {
    expect(validate({})).toEqual({});
    expect(validate({ enabled: false })).toEqual({ enabled: false });
  });

  test('exactly one session.verification key with an implemented adapter is accepted', () => {
    expect(validate({ enabled: true, testSuite: SUITE })).toEqual({ enabled: true, testSuite: SUITE });
    expect(resolveStagedVerificationSettings(validate({ enabled: true, testSuite: SUITE })).testSuite)
      .toEqual({ key: 'test', adapter: 'jest' });
  });

  test('an empty binding or more than one key refuses', () => {
    expectRefusal({ enabled: true, testSuite: {} }, 'invalid_test_suite');
    expectRefusal(
      { enabled: true, testSuite: { test: { adapter: 'jest' }, e2e: { adapter: 'jest' } } },
      'invalid_test_suite',
    );
    expectRefusal({ enabled: true, testSuite: 'test' }, 'invalid_test_suite');
    expectRefusal({ enabled: true, testSuite: ['test'] }, 'invalid_test_suite');
  });

  test('a key that is not a session.verification key refuses', () => {
    const error = expectRefusal({ enabled: true, testSuite: { unit: { adapter: 'jest' } } }, 'unresolvable_name');
    expect(error.message).toContain('unit');
  });

  // Issue #1174: the second implemented adapter, beside an unchanged `jest`.
  test('vitest is an implemented adapter, and the closed set names exactly jest and vitest', () => {
    expect(TEST_SUITE_ADAPTER_KINDS).toEqual(['jest', 'vitest']);
    const vitest = { test: { adapter: 'vitest', setupCommand: 'npm run build' } };
    expect(validate({ enabled: true, testSuite: vitest })).toEqual({ enabled: true, testSuite: vitest });
    expect(resolveStagedVerificationSettings(validate({ enabled: true, testSuite: vitest })).testSuite)
      .toEqual({ key: 'test', adapter: 'vitest', setupCommand: 'npm run build' });
    const error = expectRefusal({ enabled: true, testSuite: { test: { adapter: 'Vitest' } } }, 'invalid_test_adapter');
    expect(error.message).toContain('expected one of: jest, vitest');
  });

  test('a missing or unimplemented adapter refuses', () => {
    expectRefusal({ enabled: true, testSuite: { test: {} } }, 'invalid_test_adapter');
    expectRefusal({ enabled: true, testSuite: { test: { adapter: 'mocha' } } }, 'invalid_test_adapter');
    expectRefusal({ enabled: true, testSuite: { test: 'jest' } }, 'invalid_test_adapter');
  });

  test('unknown fields, an empty setup command and a malformed separator refuse', () => {
    expectRefusal({ testSuite: { test: { adapter: 'jest', command: 'npx jest' } } }, 'unknown_field');
    expectRefusal({ testSuite: { test: { adapter: 'jest', setupCommand: '  ' } } }, 'invalid_adapter_command');
    expectRefusal({ testSuite: { test: { adapter: 'jest', argumentSeparator: '' } } }, 'invalid_argument_separator');
    expectRefusal({ testSuite: { test: { adapter: 'jest', argumentSeparator: '-- x' } } }, 'invalid_argument_separator');
  });

  // A suite key is an opaque operator-chosen `session.verification` key, so one
  // that collides with an `Object.prototype` property still has to survive as a
  // real own entry through validation, the copy and the defaulting layer.
  test('a suite key that collides with Object.prototype is kept as an own entry', () => {
    const config = validate(
      JSON.parse('{"enabled": true, "testSuite": {"__proto__": {"adapter": "jest"}}}'),
      ['__proto__'],
    );
    expect(Object.keys(config.testSuite)).toEqual(['__proto__']);
    expect(config.testSuite['__proto__']).toEqual({ adapter: 'jest' });
    expect(Object.keys(cloneStagedVerificationConfig(config).testSuite)).toEqual(['__proto__']);
    expect(resolveStagedVerificationSettings(config).testSuite)
      .toEqual({ key: '__proto__', adapter: 'jest' });
  });

  test('the binding is copied, never shared', () => {
    const config = validate({ enabled: true, testSuite: { test: { adapter: 'jest', setupCommand: 'make' } } });
    const clone = cloneStagedVerificationConfig(config);
    clone.testSuite.test.setupCommand = 'rm -rf /';
    expect(config.testSuite.test.setupCommand).toBe('make');
  });
});

// Issue #1166 — the operator's declaration of which Issue-requirement command
// texts the bound entry discharges (contract §6 rule 5). It is a declaration
// about one entry, never a general equivalence rule, so validation refuses
// every shape that would make it one.
describe('stagedVerification.testSuite.requirementCommands — the declared full-suite requirement', () => {
  const COMMANDS = { test: 'npm run test:files', lint: 'npm run lint', e2e: 'npm run e2e' };
  const declaring = (requirementCommands) => ({
    enabled: true,
    testSuite: { test: { adapter: 'jest', requirementCommands } },
  });
  const validateWithCommands = (block) =>
    validateStagedVerificationConfig(block, 'stagedVerification', NAMES, COMMANDS);

  test('an absent declaration is the shipped binding, unchanged', () => {
    const config = validate({ enabled: true, testSuite: { test: { adapter: 'jest' } } });
    expect(config.testSuite.test.requirementCommands).toBeUndefined();
    expect(resolveStagedVerificationSettings(config).testSuite.requirementCommands).toBeUndefined();
  });

  test('a declared list is kept verbatim and reaches the resolved binding', () => {
    const config = validateWithCommands(declaring(['npm test']));
    expect(config.testSuite.test.requirementCommands).toEqual(['npm test']);
    expect(resolveStagedVerificationSettings(config).testSuite).toEqual({
      key: 'test',
      adapter: 'jest',
      requirementCommands: ['npm test'],
    });
  });

  test('a non-array, an empty list, a blank, multi-line or over-long entry, and a repeat all refuse', () => {
    expectRefusal(declaring('npm test'), 'invalid_requirement_commands');
    // Present-but-empty declares nothing while looking like a declaration.
    const empty = expectRefusal(declaring([]), 'invalid_requirement_commands');
    expect(empty.message).toContain('remove the field to declare none');
    expectRefusal(declaring(['  ']), 'invalid_requirement_commands');
    expectRefusal(declaring([42]), 'invalid_requirement_commands');
    expectRefusal(declaring(['npm test\nrm -rf /']), 'invalid_requirement_commands');
    expectRefusal(declaring([`npm ${'x'.repeat(MAX_TEST_SUITE_REQUIREMENT_COMMAND_CHARS)}`]), 'invalid_requirement_commands');
    const repeat = expectRefusal(declaring(['npm test', 'npm test']), 'invalid_requirement_commands');
    expect(repeat.path).toBe('stagedVerification.testSuite.test.requirementCommands[1]');
  });

  // The narrow safety rule: the suite must never discharge a requirement that
  // another configured check's own record owns.
  test('a command another session.verification entry already runs refuses the session', () => {
    const error = expectRefusalWithCommands(declaring(['npm run lint']), 'invalid_requirement_commands');
    expect(error.message).toContain('lint');
    // The shell-wrapper form of that same command is the same command.
    expectRefusalWithCommands(declaring(["bash -lc 'npm run lint'"]), 'invalid_requirement_commands');
    // The bound entry's OWN command is redundant, not a collision.
    expect(validateWithCommands(declaring(['npm run test:files'])).testSuite.test.requirementCommands)
      .toEqual(['npm run test:files']);
  });

  test('the declaration is copied, never shared', () => {
    const config = validateWithCommands(declaring(['npm test']));
    const clone = cloneStagedVerificationConfig(config);
    clone.testSuite.test.requirementCommands.push('rm -rf /');
    expect(config.testSuite.test.requirementCommands).toEqual(['npm test']);
  });

  function expectRefusalWithCommands(block, refusal) {
    let thrown;
    try {
      validateWithCommands(block);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StagedVerificationConfigError);
    expect(thrown.refusal).toBe(refusal);
    return thrown;
  }
});

describe('resolveStagedVerificationSettings — defaults and legacy compatibility', () => {
  test('an absent block resolves to today’s behavior (§10 rule 1)', () => {
    expect(resolveStagedVerificationSettings(undefined)).toEqual({
      enabled: false,
      maxStageRecoveryAttempts: DEFAULT_MAX_STAGE_RECOVERY_ATTEMPTS,
    });
  });

  test('an absent block and an explicitly disabled one resolve identically', () => {
    expect(resolveStagedVerificationSettings({ enabled: false }))
      .toEqual(resolveStagedVerificationSettings(undefined));
  });

  test('an enabled block resolves the suite and defaults only the recovery budget', () => {
    const settings = resolveStagedVerificationSettings(
      validate({ enabled: true, testSuite: { test: { adapter: 'jest' } } }),
    );
    expect(settings).toEqual({
      enabled: true,
      maxStageRecoveryAttempts: DEFAULT_MAX_STAGE_RECOVERY_ATTEMPTS,
      testSuite: { key: 'test', adapter: 'jest' },
    });
    expect(settings.environmentIdentity).toBeUndefined();
  });

  // #1155: enabling the feature can never weaken verification. There is no
  // resolved setting left that could narrow a stage's non-test checks — a stage
  // runs the entire required set.
  test('nothing resolved can narrow the required set (§5.3)', () => {
    const settings = resolveStagedVerificationSettings(
      validate({ enabled: true, testSuite: { test: { adapter: 'jest' } } }),
    );
    expect(Object.keys(settings).sort()).toEqual([
      'enabled',
      'maxStageRecoveryAttempts',
      'testSuite',
    ]);
    expect(settings.selectable).toBeUndefined();
    expect(settings.finalOnly).toBeUndefined();
    expect(settings.resultAdapters).toBeUndefined();
    expect(settings.selectionAdapter).toBeUndefined();
  });

  test('the resolved suite binding is a copy, not the config’s own object', () => {
    const config = validate({ enabled: true, testSuite: { test: { adapter: 'jest', setupCommand: 'make' } } });
    const settings = resolveStagedVerificationSettings(config);
    settings.testSuite.setupCommand = 'rm -rf /';
    expect(config.testSuite.test.setupCommand).toBe('make');
  });
});

describe('session load boundary (JsonSessionRegistry)', () => {
  let tmpDir;
  let jsonPath;

  const SESSION = {
    sessionId: 'workflow-dev',
    repoKey: 'n8n-ai-cli-loop',
    repoRoot: '/Users/moto/git/n8n-ai-cli-loop',
    githubRepo: 'm2dw/n8n-ai-cli-loop',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'codex', reviewAgent: 'claude' },
    verification: { test: 'npm test', lint: 'npm run lint' },
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
  };
  const SUITE = { test: { adapter: 'jest', argumentSeparator: '--' } };

  const writeSession = (stagedVerification) => {
    const session = stagedVerification === undefined ? SESSION : { ...SESSION, stagedVerification };
    writeFileSync(jsonPath, JSON.stringify({ sessions: [session] }), 'utf8');
  };

  const invalidEntry = () =>
    new JsonSessionRegistry(jsonPath).getDiagnostics().find((d) => d.kind === 'invalid_entry');

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'staged-verification-config-test-'));
    jsonPath = join(tmpDir, 'sessions.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a session with no stagedVerification block loads unchanged', async () => {
    writeSession(undefined);
    const registry = new JsonSessionRegistry(jsonPath);
    expect(registry.getDiagnostics().filter((d) => d.kind === 'invalid_entry')).toEqual([]);
    const session = await registry.getSessionById('workflow-dev');
    expect(session.stagedVerification).toBeUndefined();
    expect(session.verification).toEqual({ test: 'npm test', lint: 'npm run lint' });
  });

  test('a valid staged plan is carried onto the resolved session', async () => {
    writeSession({ enabled: true, environmentIdentity: 'node20', testSuite: SUITE });
    const registry = new JsonSessionRegistry(jsonPath);
    const session = await registry.getSessionById('workflow-dev');
    expect(session.stagedVerification).toEqual({
      enabled: true,
      environmentIdentity: 'node20',
      testSuite: SUITE,
    });
  });

  test('the resolved block is a copy: mutating it cannot change the next read', async () => {
    writeSession({ enabled: true, testSuite: SUITE });
    const registry = new JsonSessionRegistry(jsonPath);
    const first = await registry.getSessionById('workflow-dev');
    first.stagedVerification.enabled = false;
    first.stagedVerification.testSuite.test.adapter = 'mocha';
    const second = await registry.getSessionById('workflow-dev');
    expect(second.stagedVerification).toEqual({ enabled: true, testSuite: SUITE });
  });

  test('an enabled block with no suite binding refuses the session at load (#1152)', () => {
    writeSession({ enabled: true });
    const invalid = invalidEntry();
    expect(invalid).toBeDefined();
    expect(invalid.message).toContain('testSuite');
  });

  test('an unresolvable suite key refuses the session at load', () => {
    writeSession({ enabled: true, testSuite: { typecheck: { adapter: 'jest' } } });
    const invalid = invalidEntry();
    expect(invalid).toBeDefined();
    expect(invalid.message).toContain('typecheck');
  });

  test('a retired group-selection setting refuses the session at load (#1155)', () => {
    writeSession({ enabled: true, testSuite: SUITE, selectable: ['test'] });
    const invalid = invalidEntry();
    expect(invalid).toBeDefined();
    expect(invalid.message).toContain('selectable');
  });

  test('an unknown stagedVerification field refuses the session at load', () => {
    writeSession({ enabled: true, selectableChecks: ['test'] });
    const invalid = invalidEntry();
    expect(invalid).toBeDefined();
    expect(invalid.message).toContain('selectableChecks');
  });

  test('a zero maxStageRecoveryAttempts refuses the session at load (#1096 §7.3 rule 5)', () => {
    writeSession({ enabled: true, maxStageRecoveryAttempts: 0 });
    const invalid = invalidEntry();
    expect(invalid).toBeDefined();
    expect(invalid.message).toContain('maxStageRecoveryAttempts');
  });
});
