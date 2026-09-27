/**
 * Unit tests for the persisted party provenance §8.3 measures an arbiter against
 * (issue #955 review, P1; docs/review-dispute-contract.md §8.3).
 *
 * The arbitration sub-turn runs phases after the runs it arbitrates, so it can
 * only know who the parties were from what those runs wrote down. Three
 * properties are pinned here, because together they are what keeps the
 * independence check about the DEBATE rather than about the session, without
 * letting the record itself become an attack on the check:
 *
 *  - a run's identity survives as an AGENT ID, which is what names the run that
 *    argued and is the only field this protocol can validate against a closed
 *    tuple;
 *  - the key is merged, never assigned, so the review run's half and the fix
 *    run's half cannot evict each other through a shallow context merge;
 *  - everything read back is untrusted: the provider is re-derived from the
 *    validated id rather than believed, and the model — which nothing here can
 *    authenticate — stays unknown, which can only make §8.3 stricter
 *    (`same-provider-model-unknown`), never laxer.
 */
import {
  REVIEW_DISPUTE_PARTIES_CONTEXT_FIELD,
  REVIEW_DISPUTE_PARTY_ROLES,
  canonicalizeDisputeParty,
  mergeDisputeParties,
  readDisputeParty,
  summarizeDisputeParty,
} from '../dist/core/review-dispute-parties.js';
import { evaluateArbiterCandidates, knownModel } from '../dist/core/review-arbiter-profile.js';
import { readReconsiderationSummaryParty } from '../dist/core/review-dispute-reconsiderations.js';

describe('review dispute party provenance (issue #955 review)', () => {
  test('the context key and the two roles are the contract', () => {
    expect(REVIEW_DISPUTE_PARTIES_CONTEXT_FIELD).toBe('reviewDisputeParties');
    expect([...REVIEW_DISPUTE_PARTY_ROLES]).toEqual(['implementation', 'review']);
  });

  // -------------------------------------------------------------------------
  // summarizeDisputeParty — the projection of a profile resolved IN THIS RUN
  // -------------------------------------------------------------------------

  test('a resolved profile is projected to exactly the three fields §8.3 compares', () => {
    // Deliberately a full review-lane profile: everything except the three
    // fields is dropped, so the key stays a bounded §10.1 citizen.
    expect(
      summarizeDisputeParty({
        phase: 'review',
        agentId: 'claude',
        cmd: 'claude',
        argv: ['-p', '--model', 'opus'],
        model: 'opus',
        modelSource: 'default',
        effort: 'high',
        provider: 'anthropic',
        reviewStrength: 'high',
      }),
    ).toEqual({ agentId: 'claude', provider: 'anthropic', model: 'opus' });
  });

  test('an absent provider or model is omitted rather than invented', () => {
    // The Gemini review profile carries no `model` at all. Omitting it is what
    // makes §8.3 treat the party's model as unknown; a placeholder would let a
    // same-provider candidate "prove" it differs from a party nobody named.
    expect(summarizeDisputeParty({ agentId: 'gemini', provider: 'google' })).toEqual({
      agentId: 'gemini',
      provider: 'google',
    });
    expect(summarizeDisputeParty({ agentId: 'codex' })).toEqual({ agentId: 'codex' });
  });

  test('a value that names no agent is not a party', () => {
    for (const value of [undefined, null, 'claude', 42, [], {}, { agentId: '' }, { agentId: '   ' }, { agentId: 7 }]) {
      expect(summarizeDisputeParty(value)).toBeUndefined();
    }
  });

  test('an over-long field is dropped, never truncated', () => {
    // A truncated model name would compare unequal to itself and could pass
    // §8.3's "provably different model" test against a party running the very
    // same model. Dropping it costs proof, which fails closed.
    const long = 'm'.repeat(65);
    expect(summarizeDisputeParty({ agentId: 'claude', provider: 'anthropic', model: long })).toEqual({
      agentId: 'claude',
      provider: 'anthropic',
    });
    expect(summarizeDisputeParty({ agentId: long, provider: 'anthropic' })).toBeUndefined();
    // 64 is inside the bound.
    expect(summarizeDisputeParty({ agentId: 'claude', model: 'm'.repeat(64) })?.model).toHaveLength(64);
  });

  test('a CLI-default model travels verbatim and is read as UNKNOWN downstream', () => {
    // The Codex lane records `cli-default` when the CLI's own config picks the
    // model. It is recorded as written — normalizing it here would put two
    // spellings of "unknown" in the codebase — and #839 is what refuses to
    // compare it.
    expect(summarizeDisputeParty({ agentId: 'codex', model: 'cli-default' })).toEqual({
      agentId: 'codex',
      model: 'cli-default',
    });
    expect(knownModel('cli-default')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // readDisputeParty — the untrusted read back out of task context
  // -------------------------------------------------------------------------

  test('each role is read independently out of task context, as an id alone', () => {
    const raw = {
      implementation: { agentId: 'codex', provider: 'openai', model: 'gpt-5' },
      review: { agentId: 'claude', provider: 'anthropic', model: 'opus' },
    };
    // Even a record whose provider and model are exactly right is reduced: this
    // process cannot tell that record apart from one an altered task supplied,
    // so nothing beyond the validated id is believed.
    expect(readDisputeParty(raw, 'implementation')).toEqual({ agentId: 'codex' });
    expect(readDisputeParty(raw, 'review')).toEqual({ agentId: 'claude' });
  });

  test('P1: a forged provider or model does not survive the read', () => {
    // The two fields a §8.3 bypass needs: a provider that hides the overlap with
    // the actual party, and a model that manufactures the "provably different
    // model" the same-provider opt-in requires.
    expect(
      canonicalizeDisputeParty({ agentId: 'claude', provider: 'openai', model: 'gpt-5' }),
    ).toEqual({ agentId: 'claude' });
    expect(readDisputeParty({ review: { agentId: 'claude', provider: 'not-a-provider' } }, 'review')).toEqual({
      agentId: 'claude',
    });
  });

  test('P1: an id outside the runner closed tuple is not a party', () => {
    // A bounded string is not an agent id. §8.3 has no provider to derive for a
    // name this runner cannot resolve, so the record is dropped and the caller
    // falls back or parks — never measures independence against a label.
    for (const agentId of ['anthropic', 'claude-code', 'CLAUDE', 'gpt-5', 'x']) {
      expect(canonicalizeDisputeParty({ agentId })).toBeUndefined();
    }
    expect(['claude', 'codex', 'gemini'].map((agentId) => canonicalizeDisputeParty({ agentId }))).toEqual([
      { agentId: 'claude' },
      { agentId: 'codex' },
      { agentId: 'gemini' },
    ]);
  });

  test('a malformed or absent record yields no party at all', () => {
    for (const raw of [undefined, null, 'reviewDisputeParties', [], { review: 'claude' }, { review: null }]) {
      expect(readDisputeParty(raw, 'review')).toBeUndefined();
    }
  });

  test('one malformed half does not take the other down with it', () => {
    const raw = { implementation: { agentId: 42 }, review: { agentId: 'claude', provider: 'anthropic' } };
    expect(readDisputeParty(raw, 'implementation')).toBeUndefined();
    expect(readDisputeParty(raw, 'review')).toEqual({ agentId: 'claude' });
  });

  // -------------------------------------------------------------------------
  // mergeDisputeParties — why the key survives two writers
  // -------------------------------------------------------------------------

  test('a half-key write carries the other half forward', () => {
    // Task context merges shallowly: the fix run returning only its own half
    // would REPLACE the whole key and drop the reviewer's identity — the exact
    // provenance loss this key exists to prevent.
    const stored = { review: { agentId: 'claude', provider: 'anthropic', model: 'opus' } };
    expect(
      mergeDisputeParties(stored, { implementation: { agentId: 'codex', provider: 'openai', model: 'gpt-5' } }),
    ).toEqual({ implementation: { agentId: 'codex' }, review: { agentId: 'claude' } });
  });

  test('P1: what is written down is the id, not the metadata behind it', () => {
    // Canonicalized on the way IN as well as out: a provider or a model is a
    // first-hand fact only inside the run that resolved it, and recording a
    // claim this protocol has already decided never to believe would only invite
    // a later reader to believe it.
    expect(
      mergeDisputeParties(undefined, { review: { agentId: 'claude', provider: 'anthropic', model: 'opus' } }),
    ).toEqual({ review: { agentId: 'claude' } });
    // An unrecognised id is not written down at all.
    expect(mergeDisputeParties(undefined, { review: { agentId: 'acme', provider: 'anthropic' } })).toEqual({});
  });

  test('a re-run overwrites its own half and only its own', () => {
    const stored = {
      implementation: { agentId: 'codex', model: 'gpt-5' },
      review: { agentId: 'claude', model: 'sonnet' },
    };
    expect(mergeDisputeParties(stored, { review: { agentId: 'gemini', model: 'opus' } })).toEqual({
      implementation: { agentId: 'codex' },
      review: { agentId: 'gemini' },
    });
  });

  test('an empty patch preserves — and re-validates — whatever was stored', () => {
    expect(mergeDisputeParties({ review: { agentId: 'claude' }, implementation: { agentId: 9 } }, {})).toEqual({
      review: { agentId: 'claude' },
    });
    expect(mergeDisputeParties(undefined, {})).toEqual({});
  });

  // -------------------------------------------------------------------------
  // readReconsiderationSummaryParty — recovering the reviewer of record (P1)
  //
  // The summary #838/#952 write carries the profile that actually ran the
  // reconsideration; that — not the current review lane — is the reviewer whose
  // record the arbiter rules on. Its own admission rules (the lineage it names,
  // the version it recorded, the malformed shapes it refuses) are pinned in
  // test/review-dispute-reconsiderations.test.js. What matters HERE is that it
  // passes the same canonicalizing boundary as the parties key, which the §8.3
  // selections below are what demonstrate.
  // -------------------------------------------------------------------------

  /** The reviewer sub-turn's summary, as the arbitration run reads it back. */
  const reviewerOfRecord = (profile) =>
    readReconsiderationSummaryParty({ lineageId: 'L1', version: 1, profile }, 'L1', 1);

  // -------------------------------------------------------------------------
  // What the provenance BUYS: the §8.3 selection it feeds
  // -------------------------------------------------------------------------

  const policy = (overrides = {}) => ({
    providers: ['claude'],
    allowSameProvider: true,
    minConfidence: 0.7,
    ...overrides,
  });
  const resolveCandidate = (agentId) => ({
    ok: true,
    profile: {
      agentId,
      cmd: agentId,
      argv: [],
      provider: 'anthropic',
      model: 'opus',
      modelSource: 'session-config',
      effort: 'high',
      effortSource: 'default',
      toolPolicy: 'no-tools',
    },
  });

  test('a party with no model rejects every same-provider candidate', () => {
    // Which is what a party read back out of task context always is. The
    // configured `allowSameProvider` fallback is inadmissible for it and the
    // debate escalates through row 19 instead of being arbitrated by a candidate
    // whose difference from the party rests on the party's own record.
    const evaluation = evaluateArbiterCandidates({
      policy: policy(),
      implementation: { agentId: 'claude' },
      review: { agentId: 'claude' },
      resolveCandidate,
    });
    expect(evaluation.selected).toBeNull();
    expect(evaluation.rejections.map((r) => r.reason)).toEqual(['same-provider-model-unknown']);
  });

  test('P1: a forged model cannot buy a same-provider candidate its way in', () => {
    // The record claims models that differ from the candidate's `opus`. Believed,
    // both parties would be "provably different" and Anthropic would arbitrate an
    // Anthropic-vs-Anthropic debate; read through the boundary, the models are
    // unknown and the candidate is refused.
    const evaluation = evaluateArbiterCandidates({
      policy: policy(),
      implementation: readDisputeParty(
        { implementation: { agentId: 'claude', provider: 'anthropic', model: 'sonnet' } },
        'implementation',
      ),
      review: reviewerOfRecord({ agentId: 'claude', provider: 'anthropic', model: 'haiku' }),
      resolveCandidate,
    });
    expect(evaluation.selected).toBeNull();
    expect(evaluation.rejections).toEqual([
      { index: 0, candidate: 'claude', reason: 'same-provider-model-unknown', detail: 'implementation' },
    ]);
  });

  test('P1: a forged provider cannot hide that the candidate IS the party', () => {
    // The stored implementer claims OpenAI while actually being the Anthropic
    // agent the candidate resolves to. Believing the record would make the
    // overlap invisible and select the party's own provider as its judge — with
    // the provider derived from the validated id instead, the overlap is seen and
    // the strict policy refuses it.
    const forged = readDisputeParty(
      { implementation: { agentId: 'claude', provider: 'openai', model: 'gpt-5' } },
      'implementation',
    );
    expect(forged).toEqual({ agentId: 'claude' });
    const evaluation = evaluateArbiterCandidates({
      policy: policy({ allowSameProvider: false }),
      implementation: forged,
      review: { agentId: 'gemini', provider: 'google', model: 'pro' },
      resolveCandidate,
    });
    expect(evaluation.implementation).toEqual({
      role: 'implementation',
      agentId: 'claude',
      provider: 'anthropic',
      model: null,
    });
    expect(evaluation.selected).toBeNull();
    expect(evaluation.rejections.map((r) => r.reason)).toEqual(['same-provider-not-allowed']);
  });

  test('P1: the reviewer of record still rules out a candidate the CURRENT lane would allow', () => {
    // The reconsideration ran on Anthropic; the session has since been
    // reconfigured to review with Codex. Measuring against the current lane
    // would accept an Anthropic arbiter as cross-provider — the independence
    // violation P1 names.
    const reviewOfRecord = reviewerOfRecord({ agentId: 'claude', provider: 'anthropic', model: 'opus' });
    const currentLane = summarizeDisputeParty({ agentId: 'codex', provider: 'openai', model: 'gpt-5' });

    const againstRecord = evaluateArbiterCandidates({
      policy: policy({ allowSameProvider: false }),
      implementation: { agentId: 'codex', provider: 'openai', model: 'gpt-5' },
      review: reviewOfRecord,
      resolveCandidate,
    });
    expect(againstRecord.selected).toBeNull();
    expect(againstRecord.rejections.map((r) => r.reason)).toEqual(['same-provider-not-allowed']);

    const againstCurrentLane = evaluateArbiterCandidates({
      policy: policy({ allowSameProvider: false }),
      implementation: { agentId: 'codex', provider: 'openai', model: 'gpt-5' },
      review: currentLane,
      resolveCandidate,
    });
    expect(againstCurrentLane.selected).toMatchObject({ agentId: 'claude', sameProviderFallback: false });
  });
});
