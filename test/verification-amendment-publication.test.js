/**
 * §12.2 public reporting of an applied verification amendment (issue #1044,
 * docs/verification-amendment-contract.md §15 slice A7).
 *
 * These cases pin the PROJECTION and its bounds: what a comment is keyed on
 * (the revision, never a run), what it is allowed to say, that a retirement and
 * a restoration are each named explicitly with the not-a-pass statement beside
 * them, and that the run-summary projection reports an amended plan at the
 * human gate. Delivery and atomicity are pinned by the e2e suite.
 */
import {
  buildVerificationAmendmentComment,
  renderVerificationAmendmentComment,
  verificationAmendmentCommentIdempotencyKey,
  verificationAmendmentCommentMarker,
  verificationAmendmentGateSummary,
  publicSafeVerificationAmendmentGateSummary,
  verificationAmendmentPublicSlots,
  VERIFICATION_AMENDMENT_NAMES_WITHHELD_REASON,
  MAX_VERIFICATION_AMENDMENT_COMMENT_CHARS,
  MAX_VERIFICATION_AMENDMENT_LABEL_CHARS,
  MAX_VERIFICATION_AMENDMENT_LISTED_SLOTS,
  MAX_VERIFICATION_AMENDMENT_PUBLISHED_REASON_CHARS,
  VERIFICATION_AMENDMENT_COMMENT_PROJECTION,
  VERIFICATION_AMENDMENT_COMMENT_VERSION,
  VERIFICATION_RETIREMENT_NOT_A_PASS,
  VERIFICATION_EXECUTION_LAYER_NOT_YET_RUN,
} from '../dist/index.js';
import { renderHumanGateSummary } from '../dist/core/human-gate-summary.js';

function slot(overrides = {}) {
  return {
    commandId: 'req:0123456789abcdef',
    layer: 'requirement',
    label: 'npm test',
    state: 'active',
    ...overrides,
  };
}

function revision(overrides = {}) {
  return {
    revisionId: 'vamd-00112233445566aa',
    revisionOrdinal: 3,
    source: 'admin-cli',
    reason: 'the Issue named the wrong command',
    operations: [],
    planDigest: 'a'.repeat(64),
    continuation: 'review',
    ...overrides,
  };
}

describe('verification amendment comment — identity', () => {
  test('the key names the revision, the projection, and no run identifier', () => {
    const key = verificationAmendmentCommentIdempotencyKey({
      sessionId: 'addon-dev',
      issueNumber: 42,
      revisionId: 'vamd-00112233445566aa',
    });
    expect(key).toBe(
      `addon-dev:42:${VERIFICATION_AMENDMENT_COMMENT_PROJECTION}:v${VERIFICATION_AMENDMENT_COMMENT_VERSION}:vamd-00112233445566aa`,
    );
    // Re-deriving it is the whole retry story: same inputs, same key, one row.
    expect(
      verificationAmendmentCommentIdempotencyKey({
        sessionId: 'addon-dev',
        issueNumber: 42,
        revisionId: 'vamd-00112233445566aa',
      }),
    ).toBe(key);
    // A different revision is a different comment.
    expect(
      verificationAmendmentCommentIdempotencyKey({
        sessionId: 'addon-dev',
        issueNumber: 42,
        revisionId: 'vamd-ffffffffffffffff',
      }),
    ).not.toBe(key);
  });

  test('the delivery marker is derived from the key and never carries the session id', () => {
    const key = verificationAmendmentCommentIdempotencyKey({
      sessionId: 'secret-session',
      issueNumber: 7,
      revisionId: 'vamd-00112233445566aa',
    });
    const marker = verificationAmendmentCommentMarker(key);
    expect(marker).toMatch(/^<!-- ai-verification-amendment key=[0-9a-f]{16} -->$/);
    expect(marker).not.toContain('secret-session');
    expect(verificationAmendmentCommentMarker(key)).toBe(marker);
  });
});

describe('verification amendment comment — projection', () => {
  test('an execution slot publishes its NAME and a requirement slot its bytes', () => {
    const slots = verificationAmendmentPublicSlots({
      execution: [{ commandId: 'exec:test', name: 'test', command: 'npm test --silent', state: 'active' }],
      requirement: [{ commandId: 'req:abc', command: 'npm run e2e', state: 'retired' }],
    });
    expect(slots).toEqual([
      { commandId: 'exec:test', layer: 'execution', label: 'test', state: 'active' },
      { commandId: 'req:abc', layer: 'requirement', label: 'npm run e2e', state: 'retired' },
    ]);
    // The execution command bytes are a session default — infrastructure, not a
    // statement about this Issue — and are deliberately not published.
    expect(JSON.stringify(slots)).not.toContain('--silent');
  });

  test('operation labels come from the plan the revision PRODUCED', () => {
    const comment = buildVerificationAmendmentComment({
      revision: revision({
        operations: [
          { kind: 'replace', commandId: 'req:abc', command: 'npm run e2e -- --ci', reason: 'typo' },
          { kind: 'retire', commandId: 'exec:test', reason: 'superseded' },
          { kind: 'add', layer: 'requirement', command: 'npm run lint', reason: 'missing gate' },
        ],
      }),
      slots: [
        slot({ commandId: 'exec:test', layer: 'execution', label: 'test', state: 'retired' }),
        slot({ commandId: 'req:abc', label: 'npm run e2e -- --ci' }),
        slot({ commandId: 'req:def', label: 'npm run lint' }),
      ],
    });
    expect(comment.operations).toEqual([
      { kind: 'replace', layer: 'requirement', label: 'npm run e2e -- --ci', commandId: 'req:abc' },
      { kind: 'retire', layer: 'execution', label: 'test', commandId: 'exec:test' },
      { kind: 'add', layer: 'requirement', label: 'npm run lint', commandId: 'req:def' },
    ]);
    expect(comment.active.map((s) => s.commandId)).toEqual(['req:abc', 'req:def']);
    expect(comment.retired.map((s) => s.commandId)).toEqual(['exec:test']);
    expect(comment.retiredByThisRevision).toHaveLength(1);
    expect(comment.restoredByThisRevision).toHaveLength(0);
  });

  test('an operation naming a slot the plan no longer carries falls back to its identity', () => {
    const comment = buildVerificationAmendmentComment({
      revision: revision({ operations: [{ kind: 'annotate', commandId: 'exec:gone', reason: 'note' }] }),
      slots: [],
    });
    expect(comment.operations[0]).toEqual({
      kind: 'annotate',
      layer: 'execution',
      label: 'exec:gone',
      commandId: 'exec:gone',
    });
  });

  test('labels and reasons are bounded and single-line', () => {
    const comment = buildVerificationAmendmentComment({
      revision: revision({ reason: `why\nover\nmany lines ${'x'.repeat(2000)}` }),
      slots: [slot({ label: 'npm test '.repeat(80) })],
    });
    expect(comment.reason).not.toContain('\n');
    expect(comment.reason.length).toBeLessThanOrEqual(501);
    expect(comment.active[0].label.length).toBeLessThanOrEqual(MAX_VERIFICATION_AMENDMENT_LABEL_CHARS);
  });
});

describe('verification amendment comment — rendering', () => {
  test('a retirement is named with the not-a-pass statement beside it', () => {
    const body = renderVerificationAmendmentComment(
      buildVerificationAmendmentComment({
        revision: revision({
          operations: [{ kind: 'retire', commandId: 'req:abc', reason: 'flaky in CI' }],
          reason: 'the e2e suite cannot run here',
        }),
        slots: [
          slot({ commandId: 'exec:test', layer: 'execution', label: 'test' }),
          slot({ commandId: 'req:abc', label: 'npm run e2e', state: 'retired' }),
        ],
      }),
      '<!-- marker -->',
    );
    expect(body).toContain('<!-- marker -->');
    expect(body).toContain('Verification plan amended — revision 3');
    expect(body).toContain('the e2e suite cannot run here');
    expect(body).toContain('This revision removed 1 check(s):');
    expect(body).toContain('`npm run e2e`');
    expect(body).toContain(VERIFICATION_RETIREMENT_NOT_A_PASS);
    // §12.2: no run identifier, no output, no local path.
    expect(body).not.toMatch(/runId|artifact|\/Users\//);
  });

  // Issue #1044 review (P1): the reason is the one operator-authored string
  // both projections render as prose. Markdown passes raw HTML through, so an
  // unmatched `<!--` in it would comment out everything the renderer appends
  // after the head — including the removal §8.4 rule 1 exists to publish.
  test('raw HTML in the reason cannot hide the disclosures that follow it', () => {
    const comment = buildVerificationAmendmentComment({
      revision: revision({
        operations: [{ kind: 'retire', commandId: 'req:abc', reason: 'flaky in CI' }],
        reason: 'nothing to see <!-- <script>alert(1)</script>',
      }),
      slots: [slot({ commandId: 'req:abc', label: 'npm run e2e', state: 'retired' })],
    });
    expect(comment.reason).not.toContain('<');
    expect(comment.reason).toContain('&lt;!--');

    const body = renderVerificationAmendmentComment(comment, '<!-- marker -->');
    // The marker is the renderer's own; the reason opens no comment of its own.
    expect(body.match(/<!--/g)).toHaveLength(1);
    expect(body).toContain('nothing to see &lt;!--');
    expect(body).toContain('This revision removed 1 check(s):');
    expect(body).toContain(VERIFICATION_RETIREMENT_NOT_A_PASS);

    // And the same at the human gate, which renders the reason as prose too.
    const gate = renderHumanGateSummary({
      issueNumber: 42,
      prNumber: 7,
      phase: 'review',
      phaseResult: 'success',
      runId: 'run-1',
      verificationAmendment: verificationAmendmentGateSummary(
        {
          revisions: [
            revision({
              operations: [{ kind: 'retire', commandId: 'req:abc', reason: 'flaky in CI' }],
              reason: 'nothing to see <!-- hidden',
            }),
          ],
        },
        [slot({ commandId: 'req:abc', label: 'npm run e2e', state: 'retired' })],
      ),
    });
    expect(gate).not.toContain('see <!--');
    expect(gate).toContain('&lt;!--');
    expect(gate).toContain('Retired — not run, not passed (1)');
  });

  test('a restoration is named too, and an unamended-plan comment states no removal', () => {
    const body = renderVerificationAmendmentComment(
      buildVerificationAmendmentComment({
        revision: revision({
          operations: [{ kind: 'restore', commandId: 'req:abc', reason: 'the runner is back' }],
        }),
        slots: [slot({ commandId: 'req:abc', label: 'npm run e2e' })],
      }),
    );
    expect(body).toContain('This revision restored 1 check(s):');
    expect(body).not.toContain(VERIFICATION_RETIREMENT_NOT_A_PASS);
  });

  // An execution-layer slot kept being executed the whole time it was retired,
  // so its restoration changes the recorded plan and nothing about what runs.
  // Calling it a "restored check" beside the line saying execution-layer
  // entries do not control Step 4 would report it two ways at once (issue
  // #1044 review, P2).
  test('an execution-layer restoration is reported as a recorded-plan change, not a restored check', () => {
    const body = renderVerificationAmendmentComment(
      buildVerificationAmendmentComment({
        revision: revision({
          operations: [{ kind: 'restore', commandId: 'exec:lint', reason: 'the record should show it' }],
        }),
        slots: [slot({ commandId: 'exec:lint', layer: 'execution', label: 'lint' })],
      }),
    );
    expect(body).not.toContain('This revision restored 1 check(s):');
    expect(body).toContain('This revision restored 1 execution-layer entry(ies) in the recorded plan');
    expect(body).toContain(VERIFICATION_EXECUTION_LAYER_NOT_YET_RUN);
  });

  // A revision that restores one slot in each layer states each in its own
  // terms rather than folding both into a single count.
  test('a mixed restoration splits the two layers into their own disclosures', () => {
    const body = renderVerificationAmendmentComment(
      buildVerificationAmendmentComment({
        revision: revision({
          operations: [
            { kind: 'restore', commandId: 'req:abc', reason: 'the runner is back' },
            { kind: 'restore', commandId: 'exec:lint', reason: 'and the record should match' },
          ],
        }),
        slots: [
          slot({ commandId: 'req:abc', label: 'npm run e2e' }),
          slot({ commandId: 'exec:lint', layer: 'execution', label: 'lint' }),
        ],
      }),
    );
    expect(body).toContain('This revision restored 1 check(s):');
    expect(body).toContain('This revision restored 1 execution-layer entry(ies) in the recorded plan');
  });

  test('the plan lists are capped and the overflow is stated, never silently dropped', () => {
    const many = Array.from({ length: MAX_VERIFICATION_AMENDMENT_LISTED_SLOTS + 5 }, (_, i) =>
      slot({ commandId: `req:${i}`, label: `npm run check-${i}` }),
    );
    const body = renderVerificationAmendmentComment(
      buildVerificationAmendmentComment({ revision: revision(), slots: many }),
    );
    expect(body).toContain('_(+5 more)_');
    expect(body.length).toBeLessThanOrEqual(MAX_VERIFICATION_AMENDMENT_COMMENT_CHARS);
  });

  // Review Step 4 still executes the raw `session.verification` entries, and
  // Step 4.5 credits only what Step 4 ran. Until the execution layer is consumed
  // there, a task-local execution entry is a PLAN change — publishing it as a
  // check this task now runs would be the §12.2 misstatement pointed the other
  // way.
  test('an execution-layer entry is published as a plan change, never as a check that runs', () => {
    const body = renderVerificationAmendmentComment(
      buildVerificationAmendmentComment({
        revision: revision({
          operations: [
            { kind: 'add', layer: 'execution', name: 'lint', command: 'npm run lint', reason: 'local only' },
          ],
        }),
        slots: [
          slot({ commandId: 'req:abc', label: 'npm test' }),
          slot({ commandId: 'exec:lint', layer: 'execution', label: 'lint' }),
        ],
      }),
    );
    expect(body).toContain('**Required checks in the amended plan (1)**');
    expect(body).toContain('**Execution-layer plan entries (1)**');
    expect(body).toContain(VERIFICATION_EXECUTION_LAYER_NOT_YET_RUN);
    expect(body).not.toContain('Checks this task now runs');
    expect(body).not.toContain('What the loop runs and');
  });

  // Step 4 executes the session's configured commands and reads no amendment, so
  // retiring an EXECUTION slot stops nothing. Publishing it under "not run, not
  // passed" would make the comment contradict the summary printed beside it
  // (issue #1044 review, P2) — and publishing it as "still run by the session"
  // would credit a task-local entry the session never ran (P1). It says only
  // that session execution is unchanged.
  test('a retired execution slot is published as a plan change, never as no-longer-run', () => {
    const body = renderVerificationAmendmentComment(
      buildVerificationAmendmentComment({
        revision: revision({
          operations: [{ kind: 'retire', commandId: 'exec:lint', reason: 'noisy' }],
        }),
        slots: [
          slot({ commandId: 'req:abc', label: 'npm test' }),
          slot({ commandId: 'exec:lint', layer: 'execution', label: 'lint', state: 'retired' }),
        ],
      }),
    );
    expect(body).toContain('**Retired in the recorded plan — session execution unchanged (1)**');
    expect(body).toContain('This revision retired 1 execution-layer entry(ies) in the recorded plan');
    expect(body).toContain('what this session executes is unchanged');
    expect(body).toContain(VERIFICATION_EXECUTION_LAYER_NOT_YET_RUN);
    // Never the claim that retiring it left a check running: an execution slot
    // an `--add-execution` created under a name `session.verification` does not
    // hold was never executed by the loop (issue #1044 review, P1).
    expect(body).not.toContain('the session still runs them');
    expect(body).not.toContain('still executed by this session');
    // The §8.4 rule 1 statement is about the requirement layer, and this
    // revision retired nothing there.
    expect(body).not.toContain('**Retired — not run, not passed');
    expect(body).not.toContain(VERIFICATION_RETIREMENT_NOT_A_PASS);
    expect(body).not.toContain('This revision removed 1 check(s)');
  });

  test('a mixed retirement separates the two layers rather than merging the counts', () => {
    const body = renderVerificationAmendmentComment(
      buildVerificationAmendmentComment({
        revision: revision({
          operations: [
            { kind: 'retire', commandId: 'req:abc', reason: 'cannot run here' },
            { kind: 'retire', commandId: 'exec:lint', reason: 'noisy' },
          ],
        }),
        slots: [
          slot({ commandId: 'req:abc', label: 'npm run e2e', state: 'retired' }),
          slot({ commandId: 'exec:lint', layer: 'execution', label: 'lint', state: 'retired' }),
        ],
      }),
    );
    expect(body).toContain('**Retired — not run, not passed (1)**');
    expect(body).toContain('**Retired in the recorded plan — session execution unchanged (1)**');
    expect(body).toContain('This revision removed 1 check(s):');
    expect(body).toContain('This revision retired 1 execution-layer entry(ies)');
    expect(body).toContain(VERIFICATION_RETIREMENT_NOT_A_PASS);
    expect(body).toContain(VERIFICATION_EXECUTION_LAYER_NOT_YET_RUN);
  });

  test('a purely requirement-layer revision states nothing about the execution layer', () => {
    const body = renderVerificationAmendmentComment(
      buildVerificationAmendmentComment({
        revision: revision({
          operations: [{ kind: 'replace', commandId: 'req:abc', command: 'npm test', reason: 'typo' }],
        }),
        slots: [slot({ commandId: 'req:abc', label: 'npm test' })],
      }),
    );
    expect(body).not.toContain(VERIFICATION_EXECUTION_LAYER_NOT_YET_RUN);
  });

  // The bound is spent on the plan listings, never on the disclosures: slicing a
  // finished body would drop exactly the removals §12.2 exists to publish.
  test('bounding a large plan keeps every retirement disclosure and the not-a-pass statement', () => {
    const wide = (i) => `npm run check-${i}-${'x'.repeat(MAX_VERIFICATION_AMENDMENT_LABEL_CHARS - 40)}`;
    const active = Array.from({ length: MAX_VERIFICATION_AMENDMENT_LISTED_SLOTS }, (_, i) =>
      slot({ commandId: `req:a${i}`, label: wide(i) }),
    );
    const retired = Array.from({ length: 3 }, (_, i) =>
      slot({ commandId: `req:r${i}`, label: wide(100 + i), state: 'retired' }),
    );
    const body = renderVerificationAmendmentComment(
      buildVerificationAmendmentComment({
        revision: revision({
          reason: 'z'.repeat(MAX_VERIFICATION_AMENDMENT_PUBLISHED_REASON_CHARS),
          operations: retired.map((s) => ({ kind: 'retire', commandId: s.commandId, reason: 'withdrawn' })),
        }),
        slots: [...active, ...retired],
      }),
    );
    expect(body.length).toBeLessThanOrEqual(MAX_VERIFICATION_AMENDMENT_COMMENT_CHARS);
    // The head alone would already have overrun the bound before the tail was
    // reached, so this is the case the old final slice silently destroyed.
    expect(body).toContain('This revision removed 3 check(s):');
    expect(body).toContain('**Retired — not run, not passed (3)**');
    expect(body).toContain(VERIFICATION_RETIREMENT_NOT_A_PASS);
    // Whatever gave way says how much of it did, and no entry is cut in half.
    expect(body).toMatch(/_\(\+\d+ more\)_/);
    expect(body.endsWith(VERIFICATION_RETIREMENT_NOT_A_PASS)).toBe(true);
  });

  // The disclosures are mandatory, but their inline NAME lists are not: four of
  // them naming long labels at the inline cap used to consume the whole bound,
  // leaving the assembled body over the cap and the fallback rebuilding it from
  // head and tail alone — a comment with neither its Operations section nor its
  // resulting plan (issue #1044 review, P2). The names give way, the sections
  // and the counts do not.
  test('a revision that fills every disclosure still reports its operations and resulting plan', () => {
    const wide = (i) => `npm run check-${i}-${'x'.repeat(MAX_VERIFICATION_AMENDMENT_LABEL_CHARS - 40)}`;
    const retiredReq = Array.from({ length: 4 }, (_, i) =>
      slot({ commandId: `req:r${i}`, label: wide(100 + i), state: 'retired' }),
    );
    const retiredExec = Array.from({ length: 4 }, (_, i) =>
      slot({ commandId: `exec:r${i}`, layer: 'execution', label: wide(200 + i), state: 'retired' }),
    );
    const restoredReq = Array.from({ length: 4 }, (_, i) =>
      slot({ commandId: `req:s${i}`, label: wide(300 + i) }),
    );
    const restoredExec = Array.from({ length: 4 }, (_, i) =>
      slot({ commandId: `exec:s${i}`, layer: 'execution', label: wide(400 + i) }),
    );
    const body = renderVerificationAmendmentComment(
      buildVerificationAmendmentComment({
        revision: revision({
          reason: 'z'.repeat(MAX_VERIFICATION_AMENDMENT_PUBLISHED_REASON_CHARS),
          operations: [
            ...[...retiredReq, ...retiredExec].map((s) => ({
              kind: 'retire',
              commandId: s.commandId,
              reason: 'withdrawn',
            })),
            ...[...restoredReq, ...restoredExec].map((s) => ({
              kind: 'restore',
              commandId: s.commandId,
              reason: 'reinstated',
            })),
          ],
        }),
        slots: [...retiredReq, ...retiredExec, ...restoredReq, ...restoredExec],
      }),
    );
    expect(body.length).toBeLessThanOrEqual(MAX_VERIFICATION_AMENDMENT_COMMENT_CHARS);
    // Every mandatory count, with its true total.
    expect(body).toContain('This revision removed 4 check(s):');
    expect(body).toContain('This revision retired 4 execution-layer entry(ies)');
    expect(body).toContain('This revision restored 4 check(s):');
    expect(body).toContain('This revision restored 4 execution-layer entry(ies)');
    // And both halves of the §12.2 reporting contract: the operations applied
    // and the plan they produced, each stating its own count.
    expect(body).toContain('**Operations (16)**');
    expect(body).toContain('**Required checks in the amended plan (4)**');
    expect(body).toContain('**Execution-layer plan entries (4)**');
    expect(body).toContain('**Retired — not run, not passed (4)**');
    expect(body).toContain('**Retired in the recorded plan — session execution unchanged (4)**');
    expect(body).toContain(VERIFICATION_RETIREMENT_NOT_A_PASS);
    // Whatever gave way says how much of it did.
    expect(body).toMatch(/_\(\+\d+ more/);
    expect(body.endsWith(VERIFICATION_EXECUTION_LAYER_NOT_YET_RUN)).toBe(true);
  });

  test('a pipe in a command cannot break out of the table cell', () => {
    const body = renderVerificationAmendmentComment(
      buildVerificationAmendmentComment({
        revision: revision({ reason: 'a | b' }),
        slots: [slot({ label: 'sh -c "a | b"' })],
      }),
    );
    expect(body).toContain('| Reason | a \\| b |');
    expect(body).toContain('sh -c "a \\| b"');
  });
});

describe('verification amendment — human gate / run metadata summary', () => {
  test('an unamended task produces no summary at all', () => {
    expect(verificationAmendmentGateSummary(undefined)).toBeUndefined();
    expect(verificationAmendmentGateSummary({ revisions: [] })).toBeUndefined();
  });

  test('the summary reports the latest revision and everything now retired', () => {
    const summary = verificationAmendmentGateSummary(
      { revisions: [revision({ revisionOrdinal: 1 }), revision({ revisionOrdinal: 2, reason: 'latest' })] },
      [
        slot({ commandId: 'exec:test', layer: 'execution', label: 'test' }),
        slot({ commandId: 'req:abc', label: 'npm run e2e', state: 'retired' }),
      ],
    );
    expect(summary).toMatchObject({
      revisionCount: 2,
      latestOrdinal: 2,
      latestReason: 'latest',
      latestSource: 'admin-cli',
      activeCount: 1,
      retiredTotal: 1,
      retiredLabels: ['npm run e2e'],
    });
  });

  // The gate reads the reconciled LIVE plan, which a session-default drift can
  // move past the latest revision's own checkpoint. Reporting the revision's
  // digest beside counts taken from the live plan would name a plan nobody
  // gated on as the effective one (issue #1044 review, P2).
  test('the summary publishes the digest of the plan it was given, not the revision it came from', () => {
    const reconciled = 'f'.repeat(64);
    const summary = verificationAmendmentGateSummary(
      { revisions: [revision({ planDigest: 'a'.repeat(64) })] },
      [slot({ commandId: 'req:abc', label: 'npm test' })],
      reconciled,
    );
    expect(summary.planDigest).toBe(reconciled);
    // A caller that resolved no plan has nothing better to report than the
    // revision's own digest, and still reports one.
    expect(verificationAmendmentGateSummary({ revisions: [revision()] }).planDigest).toBe('a'.repeat(64));
  });

  // Retiring an execution slot changes nothing Step 4 does, so it is counted and
  // worded apart from the requirement-layer removals the gate blocks on — as a
  // recorded plan change, never as a check that ran (issue #1044 review, P1).
  test('the summary separates execution-layer retirements from the not-run set', () => {
    const summary = verificationAmendmentGateSummary({ revisions: [revision()] }, [
      slot({ commandId: 'req:abc', label: 'npm run e2e', state: 'retired' }),
      slot({ commandId: 'exec:lint', layer: 'execution', label: 'lint', state: 'retired' }),
      slot({ commandId: 'req:def', label: 'npm test' }),
    ]);
    expect(summary).toMatchObject({
      retiredTotal: 1,
      retiredLabels: ['npm run e2e'],
      executionRetiredTotal: 1,
      executionRetiredLabels: ['lint'],
      activeCount: 1,
    });

    const body = renderHumanGateSummary({
      issueNumber: 42,
      phase: 'review',
      phaseResult: 'success',
      runId: 'run-1',
      verificationNames: ['lint'],
      verificationPassed: true,
      verificationAmendment: summary,
    });
    expect(body).toContain('Retired — not run, not passed (1)');
    expect(body).toContain('Retired in the recorded plan — session execution unchanged (1)');
    expect(body).toContain('neither stopped a command from running nor asserts that one ran');
    expect(body).toContain(
      '- [ ] The execution-layer entry(ies) retired above are intended (recorded only — the ' +
        "session's configured commands still decide what runs)",
    );
    // Never "the session still runs them": a task-local execution entry added
    // under a name `session.verification` does not hold was never run by the
    // loop, so crediting it at the merge gate is the P1 misstatement.
    expect(body).not.toContain('still executed (1)');
    expect(body).not.toContain('the session still runs them');
    expect(body).not.toContain('so they were run and');
  });

  // Step 4 runs `session.verification` and Step 4.5 credits only what it ran,
  // so an execution-layer entry an amendment added or replaced has neither run
  // nor been credited. Counting it among the "active check(s)" at the merge
  // gate would imply a check ran when it did not (issue #1044 review, P1).
  test('the active count is split by layer, and an execution-only amendment still states the limitation', () => {
    const summary = verificationAmendmentGateSummary(
      {
        revisions: [
          revision({
            operations: [
              { kind: 'add', layer: 'execution', name: 'smoke', command: 'npm run smoke', reason: 'task-local' },
            ],
          }),
        ],
      },
      [
        slot({ commandId: 'req:def', label: 'npm test' }),
        slot({ commandId: 'exec:smoke', layer: 'execution', label: 'smoke' }),
      ],
    );
    expect(summary).toMatchObject({
      // The combined total is unchanged for any reader that wants it...
      activeCount: 2,
      // ...but only the requirement slot is a check this review gated on.
      activeRequirementCount: 1,
      activeExecutionCount: 1,
      executionAmended: true,
      retiredTotal: 0,
      executionRetiredTotal: 0,
    });

    const body = renderHumanGateSummary({
      issueNumber: 42,
      phase: 'review',
      phaseResult: 'success',
      runId: 'run-1',
      verificationNames: ['test'],
      verificationPassed: true,
      verificationAmendment: summary,
    });
    expect(body).toContain('1 active required check(s) gated at review');
    expect(body).not.toContain('(2 active');
    expect(body).toContain('Execution-layer plan entries (1)');
    // Nothing was retired, so the retirement lines stay absent — and the
    // limitation is stated all the same.
    expect(body).not.toContain('Retired — not run, not passed');
    expect(body).toContain("changed the plan's **execution-layer** entries");
    expect(body).toContain('- [ ] The execution-layer plan change(s) above are intended');
  });

  // A requirement-only amendment says nothing about the execution layer, and a
  // pre-split persisted summary still reports a number rather than `undefined`.
  test('a requirement-only amendment omits the execution-layer statements', () => {
    const summary = verificationAmendmentGateSummary(
      {
        revisions: [
          revision({ operations: [{ kind: 'retire', commandId: 'req:abc', reason: 'flaky' }] }),
        ],
      },
      [
        slot({ commandId: 'req:abc', label: 'npm run e2e', state: 'retired' }),
        slot({ commandId: 'req:def', label: 'npm test' }),
      ],
    );
    expect(summary.executionAmended).toBe(false);
    expect(summary.activeExecutionCount).toBe(0);

    const gate = (amendment) =>
      renderHumanGateSummary({
        issueNumber: 42,
        phase: 'review',
        phaseResult: 'success',
        runId: 'run-1',
        verificationPassed: true,
        verificationAmendment: amendment,
      });
    const body = gate(summary);
    expect(body).toContain('1 active required check(s) gated at review');
    expect(body).not.toContain('Execution-layer plan entries');
    expect(body).not.toContain("changed the plan's **execution-layer** entries");

    // A summary persisted before the split was carried has no layer counts; the
    // renderer reports the combined total it does have.
    const legacy = { ...summary };
    delete legacy.activeRequirementCount;
    delete legacy.activeExecutionCount;
    delete legacy.executionAmended;
    expect(gate(legacy)).toContain('1 active required check(s) gated at review');
  });

  // A split-provider session tracks work items on a private host and opens PRs
  // on a public one: the reason and the command labels are private work-item
  // text, the counts are not (issue #1044 review, P1).
  test('the public-safe aggregate keeps every count and drops every name', () => {
    const summary = verificationAmendmentGateSummary({ revisions: [revision({ reason: 'internal customer name' })] }, [
      slot({ commandId: 'req:abc', label: 'npm run private-suite', state: 'retired' }),
      slot({ commandId: 'exec:lint', layer: 'execution', label: 'lint', state: 'retired' }),
      slot({ commandId: 'req:def', label: 'npm test' }),
    ]);
    const safe = publicSafeVerificationAmendmentGateSummary(summary);
    expect(safe).toMatchObject({
      revisionCount: 1,
      latestOrdinal: 3,
      latestSource: 'admin-cli',
      latestReason: VERIFICATION_AMENDMENT_NAMES_WITHHELD_REASON,
      retiredTotal: 1,
      retiredLabels: [],
      executionRetiredTotal: 1,
      executionRetiredLabels: [],
      namesWithheld: true,
      activeCount: 1,
    });

    const body = renderHumanGateSummary({
      issueNumber: 42,
      prNumber: 7,
      phase: 'review',
      phaseResult: 'success',
      runId: 'run-1',
      verificationPassed: true,
      verificationAmendment: safe,
    });
    // The removal is still disclosed at the merge decision; only its name is not.
    expect(body).toContain('Retired — not run, not passed (1)');
    expect(body).toContain('names withheld');
    expect(body).not.toContain('npm run private-suite');
    expect(body).not.toContain('internal customer name');
  });

  // The merge decision is the last point a hidden removal can still do damage,
  // so the count the gate prints is the plan's TRUE retired total — never the
  // length of the bounded label list.
  test('the summary carries the true retired total and the gate names the overflow', () => {
    const many = Array.from({ length: MAX_VERIFICATION_AMENDMENT_LISTED_SLOTS + 5 }, (_, i) =>
      slot({ commandId: `req:${i}`, label: `npm run check-${i}`, state: 'retired' }),
    );
    const summary = verificationAmendmentGateSummary({ revisions: [revision()] }, many);
    expect(summary.retiredTotal).toBe(MAX_VERIFICATION_AMENDMENT_LISTED_SLOTS + 5);
    expect(summary.retiredLabels).toHaveLength(MAX_VERIFICATION_AMENDMENT_LISTED_SLOTS);

    const body = renderHumanGateSummary({
      issueNumber: 42,
      phase: 'review',
      phaseResult: 'success',
      runId: 'run-1',
      verificationPassed: true,
      verificationAmendment: summary,
    });
    expect(body).toContain(
      `Retired — not run, not passed (${MAX_VERIFICATION_AMENDMENT_LISTED_SLOTS + 5})`,
    );
    expect(body).toContain('_(+5 more — see `admin task-verification show`)_');
    expect(body).toContain('- [ ] The operator-retired verification command(s) above are intentionally not run');
  });

  test('a summary persisted before the total was carried still reports the labels it has', () => {
    const body = renderHumanGateSummary({
      issueNumber: 42,
      phase: 'review',
      phaseResult: 'success',
      runId: 'run-1',
      verificationPassed: true,
      verificationAmendment: {
        revisionCount: 1,
        latestOrdinal: 1,
        latestRevisionId: 'vamd-00112233445566aa',
        latestSource: 'admin-cli',
        latestReason: 'legacy projection',
        planDigest: 'a'.repeat(64),
        retiredLabels: ['npm run e2e'],
        activeCount: 1,
      },
    });
    expect(body).toContain('Retired — not run, not passed (1)');
    expect(body).not.toContain('undefined');
  });

  test('the human gate summary states the amendment and asks for the removal to be confirmed', () => {
    const body = renderHumanGateSummary({
      issueNumber: 42,
      prNumber: 7,
      phase: 'review',
      phaseResult: 'success',
      runId: 'run-1',
      verificationNames: ['test'],
      verificationPassed: true,
      verificationAmendment: {
        revisionCount: 2,
        latestOrdinal: 2,
        latestRevisionId: 'vamd-00112233445566aa',
        latestSource: 'admin-cli',
        latestReason: 'the e2e suite cannot run here',
        planDigest: 'a'.repeat(64),
        retiredTotal: 1,
        retiredLabels: ['npm run e2e'],
        activeCount: 1,
      },
    });
    expect(body).toContain("This task's verification plan was amended by an operator");
    expect(body).toContain('the e2e suite cannot run here');
    expect(body).toContain('Retired — not run, not passed (1)');
    expect(body).toContain('`npm run e2e`');
    expect(body).toContain('- [ ] The operator-retired verification command(s) above are intentionally not run');
  });

  test('an unamended review leaves the gate summary exactly as it was', () => {
    const body = renderHumanGateSummary({
      issueNumber: 42,
      prNumber: 7,
      phase: 'review',
      phaseResult: 'success',
      runId: 'run-1',
      verificationNames: ['test'],
      verificationPassed: true,
    });
    expect(body).not.toContain('verification plan was amended');
    expect(body).not.toContain('The operator amendment to the verification plan is intended');
  });

  test('an amendment with nothing retired still says the plan moved', () => {
    const body = renderHumanGateSummary({
      issueNumber: 42,
      prNumber: 7,
      phase: 'review',
      phaseResult: 'success',
      runId: 'run-1',
      verificationPassed: true,
      verificationAmendment: {
        revisionCount: 1,
        latestOrdinal: 1,
        latestRevisionId: 'vamd-00112233445566aa',
        latestSource: 'issue-refresh',
        latestReason: 'imported the corrected command',
        planDigest: 'b'.repeat(64),
        retiredTotal: 0,
        retiredLabels: [],
        activeCount: 2,
      },
    });
    expect(body).toContain('verification plan was amended by an operator');
    expect(body).toContain('`issue-refresh`');
    expect(body).toContain('- [ ] The operator amendment to the verification plan is intended');
    expect(body).not.toContain('Retired — not run, not passed');
  });
});
