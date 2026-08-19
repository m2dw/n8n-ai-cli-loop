/**
 * Unit tests for arbiter execution-profile resolution (issue #839,
 * docs/review-dispute-contract.md §8.3).
 *
 * The contract is the authority; these tests pin the resolver against it. Four
 * properties are asserted over and over, because together they ARE the
 * provider-independence contract:
 *
 *  - candidate order is the configured order, and the first candidate
 *    independent of BOTH parties wins;
 *  - a same-provider candidate needs the explicit opt-in AND a model provably
 *    different from both parties — missing model metadata is never proof;
 *  - every unusable candidate is passed over with its own reason code, and is
 *    never substituted for by the reviewer, the implementer, or a guess;
 *  - when nothing acceptable remains the answer is a typed human handoff at §7
 *    row 19, not a party winning by default.
 *
 * The materiality decision that routes a lineage here is #845's and is pinned by
 * `review-revision-decision.test.js`; what is pinned here is that this layer
 * CONSUMES that typed intent rather than re-deciding it.
 */
import {
  ARBITER_CANDIDATE_AGENT_IDS,
  DEFAULT_ARBITER_MIN_CONFIDENCE,
  REVIEW_DISPUTE_DEFAULT_LIMITS,
  resolveReviewDisputeSettings,
} from '../dist/core/review-dispute.js';
import { decideRevision } from '../dist/core/review-revision-decision.js';
import {
  ARBITER_CLAUDE_NO_TOOLS_ARGS,
  ARBITER_REJECTION_REASONS,
  ARBITER_SUPPORTED_AGENTS,
  ARBITER_UNAVAILABLE_ROW,
  DEFAULT_ARBITER_CLAUDE_MODEL,
  DEFAULT_ARBITER_EFFORT,
  MAX_ARBITER_CANDIDATES,
  createArbiterCandidateResolver,
  evaluateArbiterCandidates,
  isArbiterAgentId,
  knownModel,
  resolveArbiterAgentMetadata,
  resolveArbiterExecutionProfile,
  validateArbiterMetadata,
} from '../dist/core/review-arbiter-profile.js';

const LINEAGE_ID = 'ln-0123456789ab';

/** The canonical agent -> company mapping every resolved profile records. */
const PROVIDER = { claude: 'anthropic', codex: 'openai', gemini: 'google' };

/**
 * A stub candidate resolver. Each entry is either a profile spec (model/provider
 * overrides) or a failure; anything unnamed resolves to `candidate-not-found`,
 * so a test never accidentally depends on an agent it did not describe.
 */
function stubResolver(table) {
  return (agentId) => {
    const entry = table[agentId];
    if (entry === undefined) return { ok: false, reason: 'candidate-not-found' };
    if (entry.fail) return { ok: false, reason: entry.fail, detail: entry.detail };
    return {
      ok: true,
      profile: {
        agentId,
        provider: entry.provider ?? PROVIDER[agentId],
        cmd: entry.cmd ?? agentId,
        argv: entry.argv ?? ['-p'],
        ...(entry.model === undefined ? {} : { model: entry.model }),
        modelSource: entry.modelSource ?? 'default',
        ...(entry.effort === undefined ? {} : { effort: entry.effort }),
        effortSource: 'default',
        ...(entry.budget === undefined ? {} : { maxBudgetUsd: entry.budget }),
        budgetSource: 'default',
        toolPolicy: 'no-tools',
      },
    };
  };
}

function policy(overrides = {}) {
  return {
    providers: ['gemini', 'codex'],
    allowSameProvider: false,
    minConfidence: DEFAULT_ARBITER_MIN_CONFIDENCE,
    ...overrides,
  };
}

/** Evaluate against the default parties: Claude implemented, Codex reviewed. */
function evaluate({ table = {}, implementation, review, ...overrides } = {}) {
  return evaluateArbiterCandidates({
    policy: policy(overrides),
    implementation: implementation ?? { agentId: 'claude', model: 'fable-5' },
    review: review ?? { agentId: 'codex', model: 'gpt-5-codex' },
    resolveCandidate: stubResolver(table),
  });
}

function reasons(evaluation) {
  return evaluation.rejections.map((r) => `${r.candidate}:${r.reason}`);
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe('arbiter vocabulary', () => {
  test('the supported agent ids are the SAME tuple the session boundary validates', () => {
    expect(ARBITER_SUPPORTED_AGENTS).toEqual(ARBITER_CANDIDATE_AGENT_IDS);
    expect([...ARBITER_SUPPORTED_AGENTS]).toEqual(['claude', 'codex', 'gemini']);
    for (const agent of ARBITER_SUPPORTED_AGENTS) expect(isArbiterAgentId(agent)).toBe(true);
    for (const other of ['anthropic', 'openai', 'google', 'GPT', '', 'claude ', 7, null]) {
      expect(isArbiterAgentId(other)).toBe(false);
    }
  });

  test('every rejection reason is a distinct literal', () => {
    expect(new Set(ARBITER_REJECTION_REASONS).size).toBe(ARBITER_REJECTION_REASONS.length);
  });

  test('the unavailable row is §7 row 19', () => {
    expect(ARBITER_UNAVAILABLE_ROW).toBe(19);
  });

  test('an unresolved model token proves nothing; a real name normalizes', () => {
    for (const absent of [undefined, null, '', '   ', 'cli-default', 'CLI-Default', 'n/a', 'unknown', 'unset']) {
      expect(knownModel(absent)).toBeNull();
    }
    expect(knownModel('  Opus  ')).toBe('opus');
    expect(knownModel('gpt-5-codex')).toBe('gpt-5-codex');
  });
});

// ---------------------------------------------------------------------------
// Configuration boundary
// ---------------------------------------------------------------------------

describe('candidate list validation at the resolved boundary (§8.3)', () => {
  test('agent ids are accepted and kept in configured order', () => {
    const resolved = resolveReviewDisputeSettings({
      enabled: true,
      arbiter: { providers: ['gemini', 'claude', 'codex'] },
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.settings.arbiter.providers).toEqual(['gemini', 'claude', 'codex']);
  });

  test('a provider DISPLAY name is refused: the field holds agent ids', () => {
    const resolved = resolveReviewDisputeSettings({
      enabled: true,
      arbiter: { providers: ['anthropic', 'codex'] },
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.errors).toEqual([
      expect.objectContaining({ path: 'reviewDispute.arbiter.providers[0]', code: 'not-an-agent-id' }),
    ]);
  });

  test('each unusable entry is reported with its own index', () => {
    const resolved = resolveReviewDisputeSettings({
      enabled: true,
      arbiter: { providers: ['claude', 'gpt-5', 'gemini', 'llama'] },
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.errors.map((e) => e.path)).toEqual([
      'reviewDispute.arbiter.providers[1]',
      'reviewDispute.arbiter.providers[3]',
    ]);
  });

  test('an empty list still loads; it is a selection-time human handoff, not a load error', () => {
    const resolved = resolveReviewDisputeSettings({ enabled: true, arbiter: { providers: [] } });
    expect(resolved.ok).toBe(true);
    expect(resolved.settings.arbiter.providers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Selection policy
// ---------------------------------------------------------------------------

describe('cross-provider selection (§8.3)', () => {
  test('a three-provider case selects the first candidate independent of BOTH parties', () => {
    // Claude implemented and Codex reviewed, so only Google is independent —
    // and it is listed last, behind two candidates that overlap a party.
    const evaluation = evaluate({
      providers: ['claude', 'codex', 'gemini'],
      table: { claude: {}, codex: {}, gemini: {} },
    });
    expect(evaluation.selected.agentId).toBe('gemini');
    expect(evaluation.selected.provider).toBe('google');
    expect(evaluation.selected.candidateIndex).toBe(2);
    expect(evaluation.selected.sameProviderFallback).toBe(false);
    expect(evaluation.selected.sharedProviderWith).toEqual([]);
    expect(reasons(evaluation)).toEqual([
      'claude:same-provider-not-allowed',
      'codex:same-provider-not-allowed',
    ]);
  });

  test('candidate order decides between two acceptable candidates, and stops there', () => {
    const parties = { implementation: { agentId: 'claude', model: 'fable-5' }, review: { agentId: 'claude', model: 'opus' } };
    const first = evaluate({ ...parties, providers: ['gemini', 'codex'], table: { gemini: {}, codex: {} } });
    const second = evaluate({ ...parties, providers: ['codex', 'gemini'], table: { gemini: {}, codex: {} } });
    expect(first.selected.agentId).toBe('gemini');
    expect(second.selected.agentId).toBe('codex');
    // The candidate behind the winner is never resolved, so it never appears.
    expect(first.rejections).toEqual([]);
    expect(second.rejections).toEqual([]);
  });

  test('the party a candidate overlaps is recorded, both parties when it overlaps both', () => {
    const evaluation = evaluate({
      implementation: { agentId: 'codex', model: 'gpt-5-codex' },
      review: { agentId: 'codex', model: 'gpt-5' },
      providers: ['codex'],
      table: { codex: {} },
    });
    expect(evaluation.selected).toBeNull();
    expect(evaluation.rejections).toEqual([
      { index: 0, candidate: 'codex', reason: 'same-provider-not-allowed', detail: 'implementation+review' },
    ]);
  });

  test('reviewer identity comes from the supplied review-run profile, not a session default', () => {
    // The session default reviewer would be Codex; this run actually used
    // Gemini, so Gemini must not be selectable and Codex must be.
    const evaluation = evaluate({
      implementation: { agentId: 'claude', model: 'fable-5' },
      review: { agentId: 'gemini', model: 'gemini-3.1-pro' },
      providers: ['gemini', 'codex'],
      table: { gemini: {}, codex: {} },
    });
    expect(evaluation.selected.agentId).toBe('codex');
    expect(reasons(evaluation)).toEqual(['gemini:same-provider-not-allowed']);
  });

  test('provider comes off the RESOLVED profile, not the agent id', () => {
    // A resolver that reports a different company for `gemini` is honored: the
    // overlap is decided on what the profile says, not on the canonical mapping.
    const evaluation = evaluate({
      implementation: { agentId: 'claude', model: 'fable-5' },
      review: { agentId: 'codex', model: 'gpt-5-codex' },
      providers: ['gemini'],
      table: { gemini: { provider: 'anthropic' } },
    });
    expect(evaluation.selected).toBeNull();
    expect(reasons(evaluation)).toEqual(['gemini:same-provider-not-allowed']);
  });

  test('a party with no profile metadata still resolves a provider from its agent id', () => {
    const evaluation = evaluate({
      implementation: { agentId: 'claude' },
      review: { agentId: 'codex' },
      providers: ['gemini'],
      table: { gemini: {} },
    });
    expect(evaluation.implementation).toEqual({
      role: 'implementation', agentId: 'claude', provider: 'anthropic', model: null,
    });
    expect(evaluation.review).toEqual({
      role: 'review', agentId: 'codex', provider: 'openai', model: null,
    });
    expect(evaluation.selected.agentId).toBe('gemini');
  });
});

describe('same-provider fallback (§8.3)', () => {
  const parties = {
    implementation: { agentId: 'claude', model: 'fable-5' },
    review: { agentId: 'codex', model: 'gpt-5-codex' },
  };

  test('without the opt-in an overlapping candidate is refused even with a different model', () => {
    const evaluation = evaluate({
      ...parties,
      providers: ['claude'],
      allowSameProvider: false,
      table: { claude: { model: 'opus' } },
    });
    expect(evaluation.selected).toBeNull();
    expect(reasons(evaluation)).toEqual(['claude:same-provider-not-allowed']);
  });

  test('with the opt-in and a provably different model it is selected, and says so', () => {
    const evaluation = evaluate({
      ...parties,
      providers: ['claude'],
      allowSameProvider: true,
      table: { claude: { model: 'opus' } },
    });
    expect(evaluation.selected.agentId).toBe('claude');
    expect(evaluation.selected.sameProviderFallback).toBe(true);
    expect(evaluation.selected.sharedProviderWith).toEqual(['implementation']);
  });

  test('cross-provider is still preferred when the opt-in is on', () => {
    const evaluation = evaluate({
      ...parties,
      providers: ['gemini', 'claude'],
      allowSameProvider: true,
      table: { gemini: { model: 'gemini-3.1-pro' }, claude: { model: 'opus' } },
    });
    expect(evaluation.selected.agentId).toBe('gemini');
    expect(evaluation.selected.sameProviderFallback).toBe(false);
  });

  test('only a literal true opens the fallback', () => {
    for (const value of [undefined, false, 'true', 1]) {
      const evaluation = evaluate({
        ...parties,
        providers: ['claude'],
        allowSameProvider: value,
        table: { claude: { model: 'opus' } },
      });
      expect(evaluation.selected).toBeNull();
    }
  });

  test("the implementer's own model is refused", () => {
    const evaluation = evaluate({
      ...parties,
      providers: ['claude'],
      allowSameProvider: true,
      table: { claude: { model: 'Fable-5' } },
    });
    expect(evaluation.selected).toBeNull();
    expect(reasons(evaluation)).toEqual(['claude:same-model-as-implementation']);
  });

  test("the reviewer's own model is refused, even across a provider boundary", () => {
    // The candidate overlaps the IMPLEMENTER's provider, but §8.3 requires a
    // model different from BOTH parties — so the reviewer's model is refused too.
    const evaluation = evaluate({
      ...parties,
      providers: ['claude'],
      allowSameProvider: true,
      table: { claude: { model: 'gpt-5-codex' } },
    });
    expect(evaluation.selected).toBeNull();
    expect(reasons(evaluation)).toEqual(['claude:same-model-as-review']);
  });

  test('missing model metadata is never proof of a different model', () => {
    const cases = [
      ['candidate', { ...parties, table: { claude: {} } }],
      ['candidate', { ...parties, table: { claude: { model: 'cli-default' } } }],
      [
        'implementation',
        {
          implementation: { agentId: 'claude' },
          review: parties.review,
          table: { claude: { model: 'opus' } },
        },
      ],
      [
        'review',
        {
          implementation: parties.implementation,
          review: { agentId: 'codex', model: 'cli-default' },
          table: { claude: { model: 'opus' } },
        },
      ],
    ];
    for (const [detail, scenario] of cases) {
      const evaluation = evaluate({ ...scenario, providers: ['claude'], allowSameProvider: true });
      expect(evaluation.selected).toBeNull();
      expect(evaluation.rejections).toEqual([
        { index: 0, candidate: 'claude', reason: 'same-provider-model-unknown', detail },
      ]);
    }
  });
});

describe('unusable candidates fail closed with typed reasons', () => {
  test.each([
    ['unsupported-role', 'no-no-tools-invocation'],
    ['cli-unavailable', 'gemini'],
    ['cli-probe-indeterminate', 'gemini'],
    ['profile-error', 'effort:invalid'],
    ['candidate-not-found', undefined],
  ])('a %s candidate is passed over, never substituted for', (reason, detail) => {
    const table = reason === 'candidate-not-found' ? {} : { gemini: { fail: reason, detail } };
    const evaluation = evaluate({ providers: ['gemini'], table });
    expect(evaluation.selected).toBeNull();
    expect(evaluation.rejections).toEqual([
      { index: 0, candidate: 'gemini', reason, detail: detail ?? null },
    ]);
  });

  test('an unusable candidate does not stop a later acceptable one', () => {
    const evaluation = evaluate({
      implementation: { agentId: 'claude', model: 'fable-5' },
      review: { agentId: 'claude', model: 'opus' },
      providers: ['gemini', 'codex'],
      table: { gemini: { fail: 'cli-unavailable' }, codex: {} },
    });
    expect(evaluation.selected.agentId).toBe('codex');
    expect(reasons(evaluation)).toEqual(['gemini:cli-unavailable']);
  });

  test('a non-agent-id entry that bypassed the config boundary fails closed', () => {
    const evaluation = evaluate({ providers: ['anthropic', 42, 'gemini'], table: { gemini: {} } });
    expect(evaluation.selected.agentId).toBe('gemini');
    expect(evaluation.rejections).toEqual([
      { index: 0, candidate: 'anthropic', reason: 'not-an-agent-id', detail: null },
      { index: 1, candidate: null, reason: 'not-an-agent-id', detail: null },
    ]);
  });

  test('a repeated candidate is resolved once; the first position decides', () => {
    let calls = 0;
    const evaluation = evaluateArbiterCandidates({
      policy: policy({ providers: ['codex', 'codex', 'gemini'] }),
      implementation: { agentId: 'claude', model: 'fable-5' },
      review: { agentId: 'codex', model: 'gpt-5-codex' },
      resolveCandidate: (agentId) => {
        calls += 1;
        return stubResolver({ codex: {}, gemini: {} })(agentId);
      },
    });
    expect(calls).toBe(2);
    expect(evaluation.selected.agentId).toBe('gemini');
    expect(evaluation.rejections).toEqual([
      { index: 0, candidate: 'codex', reason: 'same-provider-not-allowed', detail: 'review' },
      { index: 1, candidate: 'codex', reason: 'duplicate-candidate', detail: 'first-at:0' },
    ]);
  });

  test('a list longer than the bound is truncated, and says so rather than silently', () => {
    const providers = Array.from({ length: MAX_ARBITER_CANDIDATES + 2 }, () => 'codex');
    const evaluation = evaluate({ providers, table: { codex: {} } });
    expect(evaluation.selected).toBeNull();
    expect(evaluation.rejections).toHaveLength(MAX_ARBITER_CANDIDATES + 1);
    expect(evaluation.rejections.at(-1)).toEqual({
      index: MAX_ARBITER_CANDIDATES,
      candidate: null,
      reason: 'candidate-limit-exceeded',
      detail: `configured:${MAX_ARBITER_CANDIDATES + 2}`,
    });
  });

  test('resolution is deterministic: same inputs, same selection and same rejections', () => {
    const scenario = {
      providers: ['anthropic', 'claude', 'codex', 'gemini'],
      table: { claude: { model: 'opus' }, codex: {}, gemini: {} },
    };
    expect(JSON.stringify(evaluate(scenario))).toBe(JSON.stringify(evaluate(scenario)));
  });
});

// ---------------------------------------------------------------------------
// The default candidate resolver
// ---------------------------------------------------------------------------

describe('the default candidate resolver', () => {
  test('Claude resolves to a no-tools invocation with its strong-tier defaults', () => {
    const resolve = createArbiterCandidateResolver({ env: {} });
    const resolved = resolve('claude');
    expect(resolved.ok).toBe(true);
    expect(resolved.profile).toMatchObject({
      agentId: 'claude',
      provider: 'anthropic',
      cmd: 'claude',
      model: DEFAULT_ARBITER_CLAUDE_MODEL,
      modelSource: 'default',
      effort: DEFAULT_ARBITER_EFFORT,
      effortSource: 'default',
      budgetSource: 'default',
      toolPolicy: 'no-tools',
    });
    expect(resolved.profile.maxBudgetUsd).toBeUndefined();
    for (const arg of ARBITER_CLAUDE_NO_TOOLS_ARGS) expect(resolved.profile.argv).toContain(arg);
    expect(resolved.profile.argv.slice(0, 2)).toEqual(['-p', '--tools']);
    expect(resolved.profile.argv).toEqual(
      expect.arrayContaining(['--model', DEFAULT_ARBITER_CLAUDE_MODEL, '--effort', DEFAULT_ARBITER_EFFORT]),
    );
  });

  test('the documented env overrides are honored and recorded as `env`', () => {
    const resolve = createArbiterCandidateResolver({
      env: { CLAUDE_MODEL: 'sonnet', CLAUDE_EFFORT: 'medium', CLAUDE_MAX_BUDGET_USD: '4.50' },
    });
    const resolved = resolve('claude');
    expect(resolved.profile).toMatchObject({
      model: 'sonnet', modelSource: 'env', effort: 'medium', effortSource: 'env',
      maxBudgetUsd: '4.50', budgetSource: 'env',
    });
    expect(resolved.profile.argv).toEqual(expect.arrayContaining(['--max-budget-usd', '4.50']));
  });

  test('an unusable model/effort/budget is a profile-error, before any invocation', () => {
    for (const [env, detail] of [
      [{ CLAUDE_EFFORT: 'turbo' }, 'effort:invalid'],
      [{ CLAUDE_MODEL: '   ' }, 'model:invalid'],
      [{ CLAUDE_MODEL: 'x'.repeat(200) }, 'model:too-long'],
      [{ CLAUDE_MAX_BUDGET_USD: 'free' }, 'budget:invalid'],
      [{ CLAUDE_MAX_BUDGET_USD: '0' }, 'budget:invalid'],
    ]) {
      const resolved = createArbiterCandidateResolver({ env })('claude');
      expect(resolved).toEqual({ ok: false, reason: 'profile-error', detail });
    }
  });

  test('an agent with no defined no-tools invocation is unsupported for the role (§8.2)', () => {
    const resolve = createArbiterCandidateResolver({ env: {} });
    for (const agent of ['codex', 'gemini']) {
      expect(resolve(agent)).toEqual({
        ok: false, reason: 'unsupported-role', detail: 'no-no-tools-invocation',
      });
    }
  });

  test('an unrecognized agent id is reported as candidate-not-found', () => {
    expect(createArbiterCandidateResolver({ env: {} })('llama')).toEqual({
      ok: false, reason: 'candidate-not-found', detail: 'unknown-agent',
    });
  });

  test('CLI availability is an injected fact; an unproven CLI rejects', () => {
    for (const answer of [true, 'available']) {
      const available = createArbiterCandidateResolver({ env: {}, cliAvailable: () => answer });
      expect(available('claude').ok).toBe(true);
    }
    for (const answer of [false, undefined, 'unavailable']) {
      const resolve = createArbiterCandidateResolver({ env: {}, cliAvailable: () => answer });
      expect(resolve('claude')).toEqual({ ok: false, reason: 'cli-unavailable', detail: 'claude' });
    }
  });

  test('a probe that never answered is its own reason, not a missing CLI (#897)', () => {
    // The candidate is still refused — an unverified CLI is not an arbiter — but
    // under a code that says "ask again", not "install something". Collapsing the
    // two is what let host contention read as a permanent misconfiguration.
    const resolve = createArbiterCandidateResolver({ env: {}, cliAvailable: () => 'indeterminate' });
    expect(resolve('claude')).toEqual({ ok: false, reason: 'cli-probe-indeterminate', detail: 'claude' });
  });

  test('the role gate precedes availability, so an unsupported agent is never probed', () => {
    const probed = [];
    const resolve = createArbiterCandidateResolver({
      env: {},
      cliAvailable: (agent) => {
        probed.push(agent);
        return true;
      },
    });
    expect(resolve('codex').reason).toBe('unsupported-role');
    expect(probed).toEqual([]);
  });
});

describe('provider-specific metadata rules', () => {
  test('Codex reads session.codex.model, with CODEX_MODEL taking precedence (#609)', () => {
    expect(resolveArbiterAgentMetadata('codex', {}, {})).toMatchObject({
      provider: 'openai', cmd: 'codex', model: 'cli-default', modelSource: 'cli-default',
      effort: DEFAULT_ARBITER_EFFORT, effortSource: 'default',
    });
    expect(
      resolveArbiterAgentMetadata('codex', { codex: { model: 'gpt-5-codex' } }, {}),
    ).toMatchObject({ model: 'gpt-5-codex', modelSource: 'session-config' });
    expect(
      resolveArbiterAgentMetadata('codex', { codex: { model: 'gpt-5-codex' } }, { CODEX_MODEL: 'gpt-5' }),
    ).toMatchObject({ model: 'gpt-5', modelSource: 'env' });
  });

  test('Gemini reads the Antigravity model and records the binary source', () => {
    expect(resolveArbiterAgentMetadata('gemini', {}, {})).toMatchObject({
      provider: 'google', cmd: 'agy', cmdSource: 'cli-default',
      model: 'cli-default', modelSource: 'cli-default',
    });
    expect(
      resolveArbiterAgentMetadata(
        'gemini',
        { antigravity: { model: 'Gemini 3.1 Pro (Low)' } },
        { ANTIGRAVITY_BIN: '/opt/agy' },
      ),
    ).toMatchObject({
      cmd: '/opt/agy', cmdSource: 'env', model: 'Gemini 3.1 Pro (Low)', modelSource: 'session-config',
    });
  });

  test('metadata validation accepts a display-name model but refuses unusable values', () => {
    const base = resolveArbiterAgentMetadata('gemini', { antigravity: { model: 'Gemini 3.1 Pro (Low)' } }, {});
    expect(validateArbiterMetadata(base)).toBeNull();
    expect(validateArbiterMetadata({ ...base, cmd: '' })).toBe('cmd:invalid');
    expect(validateArbiterMetadata({ ...base, provider: ' ' })).toBe('provider:missing');
    expect(validateArbiterMetadata({ ...base, model: `opus${String.fromCharCode(10)}--evil` })).toBe('model:invalid');
    expect(validateArbiterMetadata({ ...base, effort: 'turbo' })).toBe('effort:invalid');
    expect(validateArbiterMetadata({ ...base, maxBudgetUsd: '-1' })).toBe('budget:invalid');
  });
});

// ---------------------------------------------------------------------------
// The resolution, driven by #845's typed intent
// ---------------------------------------------------------------------------

const REVIEWER_META = {
  agentId: 'codex',
  model: 'gpt-5-codex',
  reviewRunId: 'run-42',
  timestamp: '2026-08-05T10:00:00.000Z',
};

function findingBody(overrides = {}) {
  return {
    version: 1,
    severity: 'P1',
    violatedContract: 'Acceptance criterion 3: the arbiter must be independent of both parties.',
    preconditions: 'A dispute reaches arbitration.',
    failureScenario: 'The reviewer judges its own finding.',
    affectedBoundary: 'src/core/review-arbiter-profile.ts',
    requiredOutcome: 'A cross-provider arbiter is selected, or a human decides.',
    evidenceRefs: [],
    ...overrides,
  };
}

/**
 * #845's row 12: a revision the §5 structural check calls non-material routes
 * the lineage to arbitration and grants no further debate round. The successor
 * restates the predecessor field for field, so nothing is material.
 */
function arbitrationDecision() {
  const record = {
    lineageId: LINEAGE_ID,
    version: 1,
    reconsideration: 'revise',
    rationale: 'Restating the same finding; nothing about it has changed.',
    revision: {
      predecessorVersion: 1,
      changedFields: ['requiredOutcome'],
      revisionKind: 'restated',
      materialityClaim: false,
      successor: findingBody({ version: 2 }),
    },
  };
  return decideRevision({
    admitted: {
      record,
      lineage: {
        lineageId: LINEAGE_ID,
        state: 'disputed',
        version: 1,
        counters: {
          rebuttals: 1, reconsiderations: 0, arbitrationPasses: 0,
          malformedArbiterAttempts: 0, evidenceRoundsUsed: 0,
        },
        rebuttedVersions: [1],
        humanGate: false,
        severity: 'P1',
        affectedBoundary: 'src/core/review-arbiter-profile.ts',
      },
    },
    versions: [{ ...findingBody(), lineageId: LINEAGE_ID, humanGate: false, reviewerMeta: REVIEWER_META }],
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
  });
}

function settings({ enabled = true, ...arbiter } = {}) {
  return {
    enabled,
    limits: REVIEW_DISPUTE_DEFAULT_LIMITS,
    arbiter: policy(arbiter),
  };
}

describe('resolveArbiterExecutionProfile', () => {
  test('consumes #845\'s arbitration intent without re-deciding materiality', () => {
    const decision = arbitrationDecision();
    expect(decision.intent).toBe('arbitration');
    expect(decision.row).toBe(12);
    const resolution = resolveArbiterExecutionProfile({
      decision,
      settings: settings({ providers: ['gemini'] }),
      implementation: { agentId: 'claude', model: 'fable-5' },
      review: { agentId: 'codex', model: 'gpt-5-codex' },
      resolveCandidate: stubResolver({ gemini: { model: 'gemini-3.1-pro' } }),
    });
    expect(resolution).toMatchObject({
      kind: 'selected',
      lineageId: LINEAGE_ID,
      profile: {
        role: 'arbiter',
        phase: 'review',
        agentId: 'gemini',
        provider: 'google',
        model: 'gemini-3.1-pro',
        minConfidence: DEFAULT_ARBITER_MIN_CONFIDENCE,
        sameProviderFallback: false,
      },
    });
    // Everything #846 needs to invoke exactly this profile without resolving
    // assignment again.
    expect(resolution.profile.implementation).toEqual({
      role: 'implementation', agentId: 'claude', provider: 'anthropic', model: 'fable-5',
    });
    expect(resolution.profile.review).toEqual({
      role: 'review', agentId: 'codex', provider: 'openai', model: 'gpt-5-codex',
    });
    expect(resolution.profile.toolPolicy).toBe('no-tools');
    expect(Array.isArray(resolution.profile.argv)).toBe(true);
  });

  test('the configured minConfidence travels on the selected profile', () => {
    const resolution = resolveArbiterExecutionProfile({
      decision: arbitrationDecision(),
      settings: settings({ providers: ['gemini'], minConfidence: 0.9 }),
      implementation: { agentId: 'claude' },
      review: { agentId: 'codex' },
      resolveCandidate: stubResolver({ gemini: {} }),
    });
    expect(resolution.profile.minConfidence).toBe(0.9);
  });

  test('a non-arbitration intent resolves nothing', () => {
    for (const intent of ['final_implementation_response', 'no_revision', 'rejected']) {
      const resolution = resolveArbiterExecutionProfile({
        decision: { intent, lineageId: LINEAGE_ID },
        settings: settings({ providers: ['gemini'] }),
        implementation: { agentId: 'claude' },
        review: { agentId: 'codex' },
        resolveCandidate: stubResolver({ gemini: {} }),
      });
      expect(resolution).toEqual({
        kind: 'not_applicable', lineageId: LINEAGE_ID, reason: 'not-arbitration-intent', rejections: [],
      });
    }
  });

  test('a disabled dispute protocol resolves nothing, even for an arbitration intent', () => {
    const resolution = resolveArbiterExecutionProfile({
      decision: arbitrationDecision(),
      settings: settings({ enabled: false, providers: ['gemini'] }),
      implementation: { agentId: 'claude' },
      review: { agentId: 'codex' },
      resolveCandidate: () => {
        throw new Error('the resolver must not be consulted with the protocol off');
      },
    });
    expect(resolution).toEqual({
      kind: 'not_applicable', lineageId: LINEAGE_ID, reason: 'dispute-disabled', rejections: [],
    });
  });

  test('an empty candidate list is a human handoff at row 19, not a party winning', () => {
    const resolution = resolveArbiterExecutionProfile({
      decision: arbitrationDecision(),
      settings: settings({ providers: [] }),
      implementation: { agentId: 'claude' },
      review: { agentId: 'codex' },
      resolveCandidate: stubResolver({}),
    });
    expect(resolution).toEqual({
      kind: 'human_handoff',
      lineageId: LINEAGE_ID,
      reason: 'no-candidates',
      row: ARBITER_UNAVAILABLE_ROW,
      rejections: [],
    });
  });

  test('exhausted candidates are a human handoff carrying every bounded reason', () => {
    const resolution = resolveArbiterExecutionProfile({
      decision: arbitrationDecision(),
      settings: settings({ providers: ['claude', 'codex', 'gemini'] }),
      implementation: { agentId: 'claude', model: 'fable-5' },
      review: { agentId: 'codex', model: 'gpt-5-codex' },
      resolveCandidate: stubResolver({ claude: {}, codex: {}, gemini: { fail: 'cli-unavailable' } }),
    });
    expect(resolution.kind).toBe('human_handoff');
    expect(resolution.reason).toBe('no-acceptable-candidate');
    expect(resolution.row).toBe(ARBITER_UNAVAILABLE_ROW);
    expect(resolution.rejections.map((r) => r.reason)).toEqual([
      'same-provider-not-allowed', 'same-provider-not-allowed', 'cli-unavailable',
    ]);
  });

  test('the reviewer and the implementer are never selected by default', () => {
    // Both parties are listed as candidates and both would be independent of the
    // OTHER party alone; neither is acceptable, and nothing is chosen.
    const resolution = resolveArbiterExecutionProfile({
      decision: arbitrationDecision(),
      settings: settings({ providers: ['claude', 'codex'], allowSameProvider: true }),
      implementation: { agentId: 'claude', model: 'opus' },
      review: { agentId: 'codex', model: 'gpt-5-codex' },
      resolveCandidate: stubResolver({ claude: { model: 'opus' }, codex: { model: 'gpt-5-codex' } }),
    });
    expect(resolution.kind).toBe('human_handoff');
    expect(resolution.rejections.map((r) => r.reason)).toEqual([
      'same-model-as-implementation', 'same-model-as-review',
    ]);
  });
});
