/**
 * Contract tests for the ChatOps result layer (issue #1024) —
 * docs/chatops-result-contract.md §3-§7.
 *
 * Three properties are pinned here, each one a rule the document states cannot
 * be left to an implementation's discretion:
 *
 * 1. The `(kind, dispatched)` projection is total over every terminal-for-
 *    automation ledger disposition, and `dispatched` is read off `attempts` —
 *    never inferred from the state or the handoff reason (§4.2, §4.3,
 *    invariant 9).
 * 2. A published comment's leading line is the pinned, grammar-ineligible
 *    header, so no operation summary — however crafted — can be recognized as a
 *    new command (§5.1, §7.1, invariant 14).
 * 3. A `reason` outside its `(kind, dispatched)` domain is malformed (§7.2).
 */
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  CHATOPS_HANDOFF_CORRECTION_HEADER,
  CHATOPS_RESULT_KINDS,
  CHATOPS_SUMMARY_HEADER,
  CHATOPS_UNDISPATCHED_REASONS,
  chatOpsDispatchResultOutcome,
  chatOpsHandoffOutcome,
  chatOpsLedgerDisposition,
  chatOpsMarkerBody,
  chatOpsOperatorResolvedOutcome,
  chatOpsReconciledFromMarkerOutcome,
  chatOpsRetryBudgetExhaustedOutcome,
  chatOpsUndispatchedOutcome,
  renderChatOpsHandoffCorrectionComment,
  renderChatOpsSummaryComment,
  sanitizeChatOpsPublicText,
  validateChatOpsPublicOutcome,
} from '../dist/core/chatops-result.js';
import {
  isAuthenticatedChatOpsMarker,
  parseChatOpsMarkerBody,
  recognizeChatOpsComment,
} from '../dist/core/chatops-command.js';
import {
  operationExecuted,
  operationFailed,
  operationRejected,
} from '../dist/core/operation-port.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function row(overrides = {}) {
  return {
    commentId: '101',
    state: 'acknowledged',
    outcome: 'executed',
    attempts: 1,
    epoch: 1,
    attemptStartedAtMs: 1_000,
    ackPublication: 'published',
    ackAttempts: 0,
    reconcileAttempts: 0,
    evidence: [],
    evidenceTruncated: false,
    evidenceClaims: 0,
    evidenceAcks: 0,
    handoff: null,
    detail: null,
    ...overrides,
  };
}

describe('chatops result kinds (§3)', () => {
  test('the kind set is exactly the five the contract closes', () => {
    expect([...CHATOPS_RESULT_KINDS]).toEqual([
      'success',
      'rejection',
      'retryable-failure',
      'ambiguous-execution',
      'human-handoff',
    ]);
  });

  test('the undispatched reason set is exactly the nine §4.1 names', () => {
    expect([...CHATOPS_UNDISPATCHED_REASONS]).toEqual([
      'unauthorized-author',
      'malformed',
      'ambiguous-edit',
      'unsupported-command',
      'unsupported-operation',
      'invalid-argument',
      'bootstrap-backlog',
      'chatops-disabled',
      'marker-comment',
    ]);
  });
});

describe('the §4.2 projection', () => {
  test('an acknowledged row takes its kind from the outcome', () => {
    expect(chatOpsLedgerDisposition(row({ outcome: 'executed' })).kind).toBe('success');
    expect(chatOpsLedgerDisposition(row({ outcome: 'rejected' })).kind).toBe('rejection');
    expect(chatOpsLedgerDisposition(row({ outcome: 'error' })).kind).toBe('retryable-failure');
  });

  test('a zero-attempt acknowledged row keeps its kind but reports dispatched: false', () => {
    // Ledger row 21 can resolve a row that never left `claimed`, so `acknowledged`
    // alone never proves a port attempt began (§4.2, §4.3).
    const zero = chatOpsLedgerDisposition(row({ attempts: 0, epoch: null, attemptStartedAtMs: null }));
    expect(zero).toEqual({ kind: 'success', dispatched: false, handoffReason: null });
  });

  test('an abandoned acknowledgement is a human handoff at either dispatched value', () => {
    expect(chatOpsLedgerDisposition(row({ ackPublication: 'abandoned' }))).toEqual({
      kind: 'human-handoff',
      dispatched: true,
      handoffReason: 'ack-publication-abandoned',
    });
    expect(
      chatOpsLedgerDisposition(row({ ackPublication: 'abandoned', attempts: 0 })).dispatched,
    ).toBe(false);
  });

  test('the three execution-uncertain reasons are ambiguous-execution at attempts >= 1', () => {
    for (const reason of ['dispatch-crash-unresolved', 'reconcile-inconclusive', 'conflicting-evidence']) {
      expect(
        chatOpsLedgerDisposition(
          row({ state: 'ambiguous', outcome: null, handoff: { reason, detail: null, fenceScope: false } }),
        ),
      ).toEqual({ kind: 'ambiguous-execution', dispatched: true, handoffReason: reason });
    }
  });

  test('a zero-attempt fence reason is a human handoff, not an ambiguous execution', () => {
    for (const reason of ['ledger-regression', 'restore-detected', 'witness-missing']) {
      const zero = chatOpsLedgerDisposition(
        row({
          state: 'ambiguous',
          outcome: null,
          attempts: 0,
          handoff: { reason, detail: null, fenceScope: true },
        }),
      );
      expect(zero).toEqual({ kind: 'human-handoff', dispatched: false, handoffReason: reason });
      const dispatched = chatOpsLedgerDisposition(
        row({ state: 'ambiguous', outcome: null, handoff: { reason, detail: null, fenceScope: true } }),
      );
      expect(dispatched.kind).toBe('ambiguous-execution');
      expect(dispatched.dispatched).toBe(true);
    }
  });

  test('a rejected row is always an undispatched rejection', () => {
    expect(chatOpsLedgerDisposition(row({ state: 'rejected', outcome: null, attempts: 0 }))).toEqual({
      kind: 'rejection',
      dispatched: false,
      handoffReason: null,
    });
  });

  test('a mid-flight row has no terminal-for-automation disposition yet', () => {
    for (const state of ['claimed', 'dispatching', 'retry_scheduled', 'awaiting_ack']) {
      expect(chatOpsLedgerDisposition(row({ state }))).toBeNull();
    }
  });
});

describe('summary composition (§7.1)', () => {
  test('a dispatched result reads the operation summary', () => {
    const outcome = chatOpsDispatchResultOutcome(operationExecuted('ran the approved command'), []);
    expect(outcome).toMatchObject({ kind: 'success', dispatched: true, reason: null });
    expect(outcome.summary).toContain('ran the approved command');
  });

  test('a port rejection carries the OperationRejectionReason verbatim', () => {
    const outcome = chatOpsDispatchResultOutcome(
      operationRejected('not-permitted', 'the tier forbids this command'),
      [],
    );
    expect(outcome).toMatchObject({ kind: 'rejection', dispatched: true, reason: 'not-permitted' });
  });

  test('a port failure becomes a retryable failure', () => {
    const outcome = chatOpsDispatchResultOutcome(operationFailed('timeout', 'none', 'gave up'), []);
    expect(outcome).toMatchObject({ kind: 'retryable-failure', dispatched: true, reason: 'timeout' });
  });

  test('rows 10, 16, and 21 use fixed sentences, never an operation summary', () => {
    expect(chatOpsRetryBudgetExhaustedOutcome([])).toMatchObject({
      kind: 'retryable-failure',
      dispatched: true,
      reason: 'retry-budget-exhausted',
    });
    expect(chatOpsOperatorResolvedOutcome('rejected', 0, [])).toMatchObject({
      kind: 'rejection',
      dispatched: false,
      reason: 'operator-resolved',
    });
    // An `executed` resolution stays inside `success`'s always-null reason domain.
    expect(chatOpsOperatorResolvedOutcome('executed', 2, [])).toMatchObject({
      kind: 'success',
      dispatched: true,
      reason: null,
    });
    expect(chatOpsReconciledFromMarkerOutcome('error', [])).toMatchObject({
      kind: 'retryable-failure',
      dispatched: true,
      reason: 'reconciled-from-marker',
    });
  });

  test('every undispatched reason produces a well-formed outcome naming only the reason', () => {
    for (const reason of CHATOPS_UNDISPATCHED_REASONS) {
      const outcome = chatOpsUndispatchedOutcome(reason, []);
      expect(outcome.kind).toBe('rejection');
      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe(reason);
      expect(outcome.summary.length).toBeGreaterThan(0);
      expect(validateChatOpsPublicOutcome(outcome)).toBeNull();
    }
  });

  test('a zero-attempt handoff reads the handoff template at dispatched: false', () => {
    const outcome = chatOpsHandoffOutcome('witness-missing', 0, []);
    expect(outcome).toMatchObject({ kind: 'human-handoff', dispatched: false, reason: 'witness-missing' });
    expect(validateChatOpsPublicOutcome(outcome)).toBeNull();
  });
});

describe('reason domains (§7.2)', () => {
  test('an out-of-domain reason is rejected as malformed', () => {
    expect(
      validateChatOpsPublicOutcome({ kind: 'success', dispatched: true, reason: 'timeout', summary: 'x' }),
    ).toMatch(/success carries no reason/);
    expect(
      validateChatOpsPublicOutcome({
        kind: 'rejection',
        dispatched: false,
        reason: 'not-permitted',
        summary: 'x',
      }),
    ).toMatch(/outside its domain/);
    expect(
      validateChatOpsPublicOutcome({
        kind: 'ambiguous-execution',
        dispatched: false,
        reason: 'ledger-regression',
        summary: 'x',
      }),
    ).toMatch(/never reported at dispatched=false/);
  });

  test('an in-domain reason validates', () => {
    expect(
      validateChatOpsPublicOutcome({
        kind: 'rejection',
        dispatched: true,
        reason: 'unknown-operation',
        summary: 'x',
      }),
    ).toBeNull();
  });
});

describe('visibility pipeline (§6)', () => {
  test('a configured path, a token shape, a closing keyword, and raw HTML are all neutralized', () => {
    const dirty =
      'wrote /Users/someone/repo/.artifacts/out.txt with ghp_abcdefghijklmnopqrstuvwxyz0123456789 fixes #12 <script>';
    const clean = sanitizeChatOpsPublicText(dirty, ['/Users/someone/repo']);
    expect(clean).not.toContain('/Users/someone/repo');
    expect(clean).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(clean).not.toMatch(/fixes #12/);
    expect(clean).not.toContain('<script>');
  });

  test('a summary is bounded at the operation summary limit', () => {
    const clean = sanitizeChatOpsPublicText('x'.repeat(5000), []);
    // 500 characters of content plus `enforceCommentVisibility`'s own visible
    // truncation marker — the point is that an unbounded upstream summary can
    // never reach a comment, not the exact suffix length.
    expect(clean.length).toBeLessThan(600);
    expect(clean).toContain('truncated');
  });
});

describe('marker and summary separation (§5, §5.1)', () => {
  const AUTOMATION = ['loop-bot'];

  test('a marker body is exactly canonical and nothing else', () => {
    expect(chatOpsMarkerBody('101')).toBe('<!-- chatops-claimed:101 -->');
    expect(chatOpsMarkerBody('101', 'executed')).toBe('<!-- chatops-ack:101:executed -->');
    for (const body of [chatOpsMarkerBody('101'), chatOpsMarkerBody('101', 'error')]) {
      expect(isAuthenticatedChatOpsMarker({ author: 'loop-bot', body }, AUTOMATION)).toBe(true);
    }
  });

  test('a summary comment is never authenticated as a marker', () => {
    const body = renderChatOpsSummaryComment(
      chatOpsDispatchResultOutcome(operationExecuted('done'), []),
    );
    expect(parseChatOpsMarkerBody(body)).toBeNull();
    expect(isAuthenticatedChatOpsMarker({ author: 'loop-bot', body }, AUTOMATION)).toBe(false);
  });

  test('a summary whose operation prose looks like a command is still malformed to the grammar', () => {
    // The whole point of the pinned header: `OperationResult.summary` is
    // untrusted prose with no restriction against beginning with a `/`.
    const body = renderChatOpsSummaryComment(
      chatOpsDispatchResultOutcome(operationExecuted('/grant --disposition commit'), []),
    );
    expect(body.split('\n')[0]).toBe(CHATOPS_SUMMARY_HEADER);
    const recognition = recognizeChatOpsComment(
      { author: 'alice', body, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { authorAllowlist: ['alice'], automationLogins: AUTOMATION },
      new Set(['grant', 'resolve']),
    );
    expect(recognition.kind).toBe('malformed');
  });

  test('the handoff correction comment carries its own pinned header', () => {
    const body = renderChatOpsHandoffCorrectionComment('operator-escalation', []);
    expect(body.split('\n')[0]).toBe(CHATOPS_HANDOFF_CORRECTION_HEADER);
    expect(parseChatOpsMarkerBody(body)).toBeNull();
  });

  test('both header literals match the contract document byte for byte', () => {
    const doc = readFileSync(resolve(ROOT, 'docs/chatops-result-contract.md'), 'utf8').replace(
      /\s+/g,
      ' ',
    );
    expect(doc).toContain(`CHATOPS_SUMMARY_HEADER = "${CHATOPS_SUMMARY_HEADER}"`);
    expect(doc).toContain(
      `CHATOPS_HANDOFF_CORRECTION_HEADER = "${CHATOPS_HANDOFF_CORRECTION_HEADER}"`,
    );
    expect(CHATOPS_SUMMARY_HEADER.startsWith('/')).toBe(false);
    expect(CHATOPS_HANDOFF_CORRECTION_HEADER.startsWith('/')).toBe(false);
  });
});
