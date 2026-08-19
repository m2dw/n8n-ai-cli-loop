/**
 * Contract tests for the ChatOps execution ledger and its crash/restore
 * replay behavior (issue #782) — docs/chatops-execution-ledger-contract.md.
 *
 * These pin the acceptance criteria: the state machine has no silent replay
 * path, restore is detected and fails closed, external markers are trusted
 * only after identity *and* payload validation, and an ambiguous outcome is
 * surfaced to an operator rather than dispatched blindly.
 */
import {
  CHATOPS_EVIDENCE_QUIESCENCE_MS,
  CHATOPS_LEDGER_DETAIL_MAX_CHARS,
  CHATOPS_MAX_ACK_PUBLICATION_ATTEMPTS,
  CHATOPS_MAX_DISPATCH_ATTEMPTS,
  CHATOPS_MAX_EVIDENCE_REFS,
  CHATOPS_MAX_RECONCILE_ATTEMPTS,
  CHATOPS_NO_CONTRACT_ROW,
  CHATOPS_TERMINAL_LEDGER_STATES,
  applyChatOpsLedgerEvent,
  assessChatOpsLedgerEpoch,
  boundChatOpsDetail,
  chatOpsEvidenceTargetResolver,
  chatOpsReconciliationSinceBound,
  collectChatOpsExecutionEvidence,
  mergeChatOpsEvidence,
  reconcileChatOpsLedgerScope,
  validateChatOpsLoginSeparation,
} from '../dist/core/chatops-execution-ledger.js';

const AUTOMATION = ['loop-bot'];

function comment(id, createdAt, overrides = {}) {
  return {
    id,
    author: 'alice',
    body: 'hello',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function marker(id, createdAt, body) {
  return comment(id, createdAt, { author: 'loop-bot', body });
}

function row(overrides = {}) {
  return {
    commentId: '10',
    state: 'claimed',
    outcome: null,
    attempts: 0,
    epoch: null,
    attemptStartedAtMs: null,
    ackPublication: 'not-required',
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

function apply(current, event, context = {}) {
  return applyChatOpsLedgerEvent(current, event, current?.commentId ?? '10', context);
}

describe('transition table — claim and refusal (§7 rows 1-5)', () => {
  test('row 1: a dispatchable candidate becomes a claim with no attempts', () => {
    const result = apply(null, { kind: 'claim' });
    expect(result.applied).toBe(true);
    expect(result.row).toBe(1);
    expect(result.next.state).toBe('claimed');
    expect(result.next.attempts).toBe(0);
    expect(result.next.epoch).toBeNull();
  });

  test('row 2: a refusal is terminal immediately and never dispatches', () => {
    const result = apply(null, { kind: 'refuse', reason: 'bootstrap-backlog' });
    expect(result.applied).toBe(true);
    expect(result.row).toBe(2);
    expect(result.next.state).toBe('rejected');
    expect(result.next.detail).toBe('bootstrap-backlog');
  });

  test('row 3: a fenced scope writes no new claim', () => {
    const result = apply(null, { kind: 'claim' }, { fenced: true });
    expect(result.applied).toBe(false);
    expect(result.row).toBe(3);
    expect(result.refusal.reason).toBe('scope-fenced');
  });

  test('row 3: a fenced scope starts no dispatch, from claimed or retry', () => {
    for (const state of ['claimed', 'retry_scheduled']) {
      const result = apply(row({ state, attempts: state === 'claimed' ? 0 : 1 }), {
        kind: 'begin-dispatch',
        epoch: 4,
        nowMs: 1000,
      }, { fenced: true });
      expect(result.applied).toBe(false);
      expect(result.row).toBe(3);
      expect(result.refusal.reason).toBe('scope-fenced');
    }
  });

  test('row 4: duplicate observation after a restart is an idempotent no-op', () => {
    const current = row({ state: 'claimed' });
    const result = apply(current, { kind: 'claim' });
    expect(result.applied).toBe(true);
    expect(result.row).toBe(4);
    expect(result.next).toEqual(current);
  });

  test('row 5: a terminal row is never re-claimed, whatever rediscovery says', () => {
    for (const state of ['rejected', 'acknowledged']) {
      const result = apply(row({ state }), { kind: 'claim' });
      expect(result.applied).toBe(false);
      expect(result.row).toBe(5);
      expect(result.refusal.reason).toBe('terminal-row');
    }
  });
});

describe('transition table — dispatch and crash recovery (§7 rows 6-16)', () => {
  test('row 6: the write-ahead moves attempts and epoch before any effect', () => {
    const result = apply(row(), { kind: 'begin-dispatch', epoch: 7, nowMs: 5_000 });
    expect(result.applied).toBe(true);
    expect(result.row).toBe(6);
    expect(result.next.state).toBe('dispatching');
    expect(result.next.attempts).toBe(1);
    expect(result.next.epoch).toBe(7);
    expect(result.next.attemptStartedAtMs).toBe(5_000);
  });

  test('row 7: any non-terminal row can be escalated, and carries a handoff', () => {
    for (const state of ['claimed', 'dispatching', 'awaiting_ack', 'retry_scheduled']) {
      const result = apply(row({ state, attempts: 1 }), {
        kind: 'escalate',
        reason: 'operator-escalation',
        detail: 'operator asked',
      });
      expect(result.applied).toBe(true);
      expect(result.row).toBe(7);
      expect(result.next.state).toBe('ambiguous');
      expect(result.next.handoff).toEqual({
        reason: 'operator-escalation',
        detail: 'operator asked',
        fenceScope: false,
      });
    }
  });

  test('row 8: the outcome is recorded before the marker is published', () => {
    const result = apply(row({ state: 'dispatching', attempts: 1 }), {
      kind: 'dispatch-result',
      outcome: 'executed',
    });
    expect(result.applied).toBe(true);
    expect(result.row).toBe(8);
    expect(result.next.state).toBe('awaiting_ack');
    expect(result.next.outcome).toBe('executed');
    expect(result.next.ackPublication).toBe('pending');
  });

  test('row 9: proven no effect is the only automatic path into retry', () => {
    const result = apply(row({ state: 'dispatching', attempts: 1 }), {
      kind: 'reconciled',
      verdict: { kind: 'no-effect' },
    });
    expect(result.applied).toBe(true);
    expect(result.row).toBe(9);
    expect(result.next.state).toBe('retry_scheduled');
    expect(result.next.attempts).toBe(1);
  });

  test('row 10: a claim plus an ack marker resolves without re-posting anything', () => {
    const result = apply(row({ state: 'dispatching', attempts: 1 }), {
      kind: 'reconciled',
      verdict: { kind: 'acked', outcome: 'executed' },
    });
    expect(result.applied).toBe(true);
    expect(result.row).toBe(10);
    expect(result.next.state).toBe('acknowledged');
    expect(result.next.outcome).toBe('executed');
    expect(result.next.ackPublication).toBe('published');
  });

  test('row 11: a claim marker with no ack is ambiguous, never retried', () => {
    const result = apply(row({ state: 'dispatching', attempts: 1 }), {
      kind: 'reconciled',
      verdict: { kind: 'claim-only' },
    });
    expect(result.applied).toBe(true);
    expect(result.row).toBe(11);
    expect(result.next.state).toBe('ambiguous');
    expect(result.next.handoff.reason).toBe('dispatch-crash-unresolved');
  });

  test('rows 12 and 13: inconclusive reconciliation is bounded, then surfaced', () => {
    let current = row({ state: 'dispatching', attempts: 1 });
    for (let i = 1; i < CHATOPS_MAX_RECONCILE_ATTEMPTS; i += 1) {
      const step = apply(current, { kind: 'reconciled', verdict: { kind: 'inconclusive' } });
      expect(step.row).toBe(12);
      expect(step.next.state).toBe('dispatching');
      expect(step.next.reconcileAttempts).toBe(i);
      current = step.next;
    }
    const last = apply(current, { kind: 'reconciled', verdict: { kind: 'inconclusive' } });
    expect(last.row).toBe(13);
    expect(last.next.state).toBe('ambiguous');
    expect(last.next.handoff.reason).toBe('reconcile-inconclusive');
  });

  test('row 14: re-entering dispatch without a verdict is refused', () => {
    const result = apply(row({ state: 'dispatching', attempts: 1 }), {
      kind: 'begin-dispatch',
      epoch: 9,
      nowMs: 9_000,
    });
    expect(result.applied).toBe(false);
    expect(result.row).toBe(14);
    expect(result.refusal.reason).toBe('dispatch-in-flight');
  });

  test('row 15: a retry reuses the row and keeps counting attempts', () => {
    const result = apply(row({ state: 'retry_scheduled', attempts: 1 }), {
      kind: 'begin-dispatch',
      epoch: 8,
      nowMs: 8_000,
    });
    expect(result.applied).toBe(true);
    expect(result.row).toBe(15);
    expect(result.next.state).toBe('dispatching');
    expect(result.next.attempts).toBe(2);
  });

  test('row 16: exhausting the attempt cap acknowledges an error, not an ambiguity', () => {
    const result = apply(
      row({ state: 'retry_scheduled', attempts: CHATOPS_MAX_DISPATCH_ATTEMPTS }),
      { kind: 'begin-dispatch', epoch: 8, nowMs: 8_000 },
    );
    expect(result.applied).toBe(true);
    expect(result.row).toBe(16);
    expect(result.next.state).toBe('awaiting_ack');
    expect(result.next.outcome).toBe('error');
  });
});

describe('transition table — publication, fence, operator (§7 rows 17-23)', () => {
  test('row 17: publishing the marker completes the row', () => {
    const result = apply(row({ state: 'awaiting_ack', outcome: 'executed', ackPublication: 'pending' }), {
      kind: 'ack-published',
    });
    expect(result.row).toBe(17);
    expect(result.next.state).toBe('acknowledged');
    expect(result.next.ackPublication).toBe('published');
  });

  test('rows 18 and 19: publication is retried, then abandoned with a handoff', () => {
    let current = row({ state: 'awaiting_ack', outcome: 'executed', ackPublication: 'pending' });
    for (let i = 1; i < CHATOPS_MAX_ACK_PUBLICATION_ATTEMPTS; i += 1) {
      const step = apply(current, { kind: 'ack-publish-failed' });
      expect(step.row).toBe(18);
      expect(step.next.state).toBe('awaiting_ack');
      expect(step.next.ackAttempts).toBe(i);
      current = step.next;
    }
    const last = apply(current, { kind: 'ack-publish-failed' });
    expect(last.row).toBe(19);
    expect(last.next.state).toBe('acknowledged');
    expect(last.next.ackPublication).toBe('abandoned');
    expect(last.next.handoff.reason).toBe('ack-publication-abandoned');
  });

  test('row 20: a fence moves every non-terminal row at once', () => {
    for (const state of ['claimed', 'dispatching', 'awaiting_ack', 'retry_scheduled']) {
      const result = apply(row({ state, attempts: 1 }), {
        kind: 'fence',
        reason: 'restore-detected',
        detail: 'witness ahead',
      });
      expect(result.applied).toBe(true);
      expect(result.row).toBe(20);
      expect(result.next.state).toBe('ambiguous');
      expect(result.next.handoff).toEqual({
        reason: 'restore-detected',
        detail: 'witness ahead',
        fenceScope: true,
      });
    }
  });

  test('row 21: only a recorded operator decision resolves an ambiguity', () => {
    const result = apply(row({ state: 'ambiguous', attempts: 1 }), {
      kind: 'operator-resolve',
      outcome: 'executed',
      operator: 'moto',
    });
    expect(result.row).toBe(21);
    expect(result.next.state).toBe('awaiting_ack');
    expect(result.next.outcome).toBe('executed');
    expect(result.next.handoff).toBeNull();
    expect(result.next.detail).toContain('moto');
  });

  test('row 21: a resolved row still owes a marker, and can still publish it', () => {
    // The bug this pins: making the row terminal here would strand
    // ackPublication at "pending"/"not-required" with no transition left that
    // could ever publish the marker (§6, L10).
    for (const ackPublication of ['not-required', 'pending']) {
      const resolved = apply(
        row({ state: 'ambiguous', attempts: 1, ackPublication, ackAttempts: 4 }),
        { kind: 'operator-resolve', outcome: 'executed', operator: 'moto' },
      );
      expect(resolved.next.ackPublication).toBe('pending');
      expect(resolved.next.ackAttempts).toBe(0);

      const published = apply(resolved.next, { kind: 'ack-published' });
      expect(published.applied).toBe(true);
      expect(published.row).toBe(17);
      expect(published.next.state).toBe('acknowledged');
      expect(published.next.ackPublication).toBe('published');
    }
  });

  test('row 21: a resolution without an operator identity is refused', () => {
    for (const operator of ['', '   ', undefined]) {
      const result = apply(row({ state: 'ambiguous', attempts: 1 }), {
        kind: 'operator-resolve',
        outcome: 'executed',
        operator,
      });
      expect(result.applied).toBe(false);
      expect(result.row).toBe(21);
      expect(result.refusal.reason).toBe('operator-record-required');
    }
  });

  test('row 22: an operator-authorized retry preserves attempts', () => {
    const result = apply(row({ state: 'ambiguous', attempts: 2 }), {
      kind: 'operator-retry',
      operator: 'moto',
      reason: 'confirmed on the provider that nothing ran',
    });
    expect(result.row).toBe(22);
    expect(result.next.state).toBe('retry_scheduled');
    expect(result.next.attempts).toBe(2);
    expect(result.next.handoff).toBeNull();
  });

  test('row 22: the sole replay path records both who authorized it and why', () => {
    const result = apply(row({ state: 'ambiguous', attempts: 2 }), {
      kind: 'operator-retry',
      operator: '  moto  ',
      reason: 'confirmed on the provider that nothing ran',
    });
    expect(result.applied).toBe(true);
    expect(result.next.detail).toContain('moto');
    expect(result.next.detail).toContain('confirmed on the provider that nothing ran');
  });

  test('row 22: a retry missing an identity or a reason is refused, not applied', () => {
    const cases = [
      { operator: 'moto', reason: '' },
      { operator: 'moto', reason: '   ' },
      { operator: 'moto' },
      { operator: '', reason: 'because' },
      { reason: 'because' },
    ];
    for (const fields of cases) {
      const result = apply(row({ state: 'ambiguous', attempts: 2 }), {
        kind: 'operator-retry',
        ...fields,
      });
      expect(result.applied).toBe(false);
      expect(result.row).toBe(22);
      expect(result.refusal.reason).toBe('operator-record-required');
    }
  });

  test('an ambiguous row refuses every automatic event', () => {
    for (const event of [
      { kind: 'begin-dispatch', epoch: 1, nowMs: 1 },
      { kind: 'reconciled', verdict: { kind: 'no-effect' } },
      { kind: 'dispatch-result', outcome: 'executed' },
    ]) {
      const result = apply(row({ state: 'ambiguous', attempts: 1 }), event);
      expect(result.applied).toBe(false);
      expect(result.row).toBe(21);
    }
  });

  test('row 23: nothing re-opens a fully terminal row', () => {
    for (const state of ['acknowledged', 'rejected']) {
      for (const event of [
        { kind: 'begin-dispatch', epoch: 1, nowMs: 1 },
        { kind: 'fence', reason: 'restore-detected' },
        { kind: 'operator-retry', operator: 'moto', reason: 'operator judged it safe' },
      ]) {
        const result = apply(row({ state }), event);
        expect(result.applied).toBe(false);
        expect(result.row).toBe(23);
        expect(result.refusal.reason).toBe('terminal-row');
      }
    }
  });

  test('an event needing a row, sent without one, cites no contract row', () => {
    const result = apply(null, { kind: 'begin-dispatch', epoch: 1, nowMs: 1 });
    expect(result.applied).toBe(false);
    expect(result.row).toBe(CHATOPS_NO_CONTRACT_ROW);
    expect(result.refusal.reason).toBe('no-row');
  });

  test('terminal states are exactly the three the contract names', () => {
    expect([...CHATOPS_TERMINAL_LEDGER_STATES].sort()).toEqual([
      'acknowledged',
      'ambiguous',
      'rejected',
    ]);
  });
});

describe('epoch witness (§9.2)', () => {
  test('agreement is consistent and needs no repair', () => {
    expect(assessChatOpsLedgerEpoch(5, 5)).toMatchObject({
      verdict: 'consistent',
      fence: false,
      healWitness: false,
    });
  });

  test('a witness behind the ledger is a crash, self-healed without a fence', () => {
    expect(assessChatOpsLedgerEpoch(6, 5)).toMatchObject({
      verdict: 'witness-behind',
      fence: false,
      healWitness: true,
    });
  });

  test('a ledger behind the witness is a restore, and fences everything', () => {
    const assessment = assessChatOpsLedgerEpoch(4, 5);
    expect(assessment.verdict).toBe('restore-detected');
    expect(assessment.fence).toBe(true);
    expect(assessment.handoffReason).toBe('restore-detected');
  });

  test('no witness and no dispatch history is benign', () => {
    expect(assessChatOpsLedgerEpoch(0, null)).toMatchObject({
      verdict: 'consistent',
      fence: false,
    });
  });

  test('a missing witness after a dispatch fences until an operator re-seeds it', () => {
    expect(assessChatOpsLedgerEpoch(3, null)).toMatchObject({
      verdict: 'witness-missing',
      fence: true,
      handoffReason: 'witness-missing',
    });
  });

  test('a negative or non-integer epoch is rejected rather than interpreted', () => {
    expect(() => assessChatOpsLedgerEpoch(-1, 0)).toThrow(/non-negative integer/);
    expect(() => assessChatOpsLedgerEpoch(1, 1.5)).toThrow(/non-negative integer/);
  });
});

describe('evidence collection (§10)', () => {
  const command = comment('10', '2026-08-14T12:00:00Z');

  function collect(comments, logins = AUTOMATION, extra = []) {
    const all = [command, ...comments, ...extra];
    return collectChatOpsExecutionEvidence(all, logins, chatOpsEvidenceTargetResolver(all));
  }

  test('an authenticated claim marker above its target is evidence', () => {
    const evidence = collect([marker('11', '2026-08-14T12:00:05Z', '<!-- chatops-claimed:10 -->')]);
    expect(evidence.byTarget.get('10')).toMatchObject({ claims: 1, acks: 0 });
    expect(evidence.markerCommentIds.has('11')).toBe(true);
    expect(evidence.defects).toEqual([]);
  });

  test('multiplicity is counted exactly, not collapsed to a boolean', () => {
    const evidence = collect([
      marker('11', '2026-08-14T12:00:05Z', '<!-- chatops-claimed:10 -->'),
      marker('12', '2026-08-14T12:00:06Z', '<!-- chatops-claimed:10 -->'),
    ]);
    expect(evidence.byTarget.get('10').claims).toBe(2);
  });

  test('a marker naming a comment this scope has no record of is a defect', () => {
    const evidence = collect([marker('11', '2026-08-14T12:00:05Z', '<!-- chatops-claimed:99 -->')]);
    expect(evidence.byTarget.size).toBe(0);
    expect(evidence.defects[0]).toMatchObject({ reason: 'unknown-target', targetCommentId: '99' });
  });

  test('a marker that does not sort above its target is a defect', () => {
    const evidence = collect([marker('5', '2026-08-14T11:59:00Z', '<!-- chatops-claimed:10 -->')]);
    expect(evidence.byTarget.size).toBe(0);
    expect(evidence.defects[0].reason).toBe('evidence-precedes-target');
  });

  test('a look-alike marker from a non-automation author is not evidence at all', () => {
    const forged = comment('11', '2026-08-14T12:00:05Z', {
      author: 'mallory',
      body: '<!-- chatops-ack:10:executed -->',
    });
    const evidence = collect([forged]);
    expect(evidence.byTarget.size).toBe(0);
    expect(evidence.markerCommentIds.size).toBe(0);
    expect(evidence.defects).toEqual([]);
  });

  test('acknowledgement markers that disagree conflict rather than pick a winner', () => {
    const evidence = collect([
      marker('11', '2026-08-14T12:00:05Z', '<!-- chatops-ack:10:executed -->'),
      marker('12', '2026-08-14T12:00:06Z', '<!-- chatops-ack:10:rejected -->'),
    ]);
    const target = evidence.byTarget.get('10');
    expect(target.conflicting).toBe(true);
    expect(target.outcome).toBeNull();
    expect(evidence.defects[0].reason).toBe('conflicting-outcome');
  });

  test('a target below the window is resolved from first-seen, not rejected', () => {
    const below = marker('11', '2026-08-14T12:00:05Z', '<!-- chatops-claimed:10 -->');
    const resolver = chatOpsEvidenceTargetResolver([below], (id) =>
      id === '10' ? { createdAt: '2026-08-14T12:00:00Z' } : null,
    );
    const evidence = collectChatOpsExecutionEvidence([below], AUTOMATION, resolver);
    expect(evidence.byTarget.get('10').claims).toBe(1);
    expect(evidence.defects).toEqual([]);
  });

  test('refs are bounded while counts stay exact', () => {
    const markers = [];
    for (let i = 0; i < CHATOPS_MAX_EVIDENCE_REFS + 4; i += 1) {
      const minute = String(1 + i).padStart(2, '0');
      markers.push(marker(String(20 + i), `2026-08-14T12:${minute}:00Z`, '<!-- chatops-claimed:10 -->'));
    }
    const target = collect(markers).byTarget.get('10');
    expect(target.refs).toHaveLength(CHATOPS_MAX_EVIDENCE_REFS);
    expect(target.refsTruncated).toBe(true);
    expect(target.claims).toBe(CHATOPS_MAX_EVIDENCE_REFS + 4);
  });
});

describe('reconciliation and ledger regression (§11)', () => {
  const command = comment('10', '2026-08-14T12:00:00Z');
  const nowMs = Date.parse('2026-08-14T13:00:00Z');

  function evidenceFor(markers) {
    const all = [command, ...markers];
    return collectChatOpsExecutionEvidence(all, AUTOMATION, chatOpsEvidenceTargetResolver(all));
  }

  function reconcile(rows, markers, overrides = {}) {
    return reconcileChatOpsLedgerScope({
      rows,
      evidence: evidenceFor(markers),
      windowComplete: true,
      nowMs,
      ...overrides,
    });
  }

  test('more claim markers than attempts fences the whole scope', () => {
    const result = reconcile(
      [row({ commentId: '10', state: 'claimed', attempts: 0 })],
      [marker('11', '2026-08-14T12:00:05Z', '<!-- chatops-claimed:10 -->')],
    );
    expect(result.rows[0].regressed).toBe(true);
    expect(result.fence).toBe(true);
    expect(result.fenceReason).toBe('ledger-regression');
  });

  test('an acknowledgement with no recorded attempt fences too', () => {
    const result = reconcile(
      [row({ commentId: '10', state: 'claimed', attempts: 0 })],
      [marker('11', '2026-08-14T12:00:05Z', '<!-- chatops-ack:10:executed -->')],
    );
    expect(result.fence).toBe(true);
  });

  test('the ledger being ahead of the world is not a regression', () => {
    const result = reconcile(
      [row({ commentId: '10', state: 'dispatching', attempts: 2, attemptStartedAtMs: nowMs - 1 })],
      [marker('11', '2026-08-14T12:00:05Z', '<!-- chatops-claimed:10 -->')],
    );
    expect(result.rows[0].regressed).toBe(false);
    expect(result.fence).toBe(false);
  });

  test('row 24: evidence naming a comment with no ledger row fences the scope', () => {
    const result = reconcile([], [marker('11', '2026-08-14T12:00:05Z', '<!-- chatops-claimed:10 -->')]);
    expect(result.orphanEvidence).toEqual(['10']);
    expect(result.fence).toBe(true);
    expect(result.fenceReason).toBe('ledger-regression');
  });

  test('a claim marker with no ack yields the claim-only verdict', () => {
    const result = reconcile(
      [row({ commentId: '10', state: 'dispatching', attempts: 1, attemptStartedAtMs: nowMs - 1 })],
      [marker('11', '2026-08-14T12:00:05Z', '<!-- chatops-claimed:10 -->')],
    );
    expect(result.rows[0].verdict).toEqual({ kind: 'claim-only' });
  });

  test('a claim plus an ack yields the acked verdict with its outcome', () => {
    const result = reconcile(
      [row({ commentId: '10', state: 'dispatching', attempts: 1, attemptStartedAtMs: nowMs - 1 })],
      [
        marker('11', '2026-08-14T12:00:05Z', '<!-- chatops-claimed:10 -->'),
        marker('12', '2026-08-14T12:00:06Z', '<!-- chatops-ack:10:executed -->'),
      ],
    );
    expect(result.rows[0].verdict).toEqual({ kind: 'acked', outcome: 'executed' });
  });
});

describe('quiescence and incomplete data (§10.4, §11.3)', () => {
  const started = Date.parse('2026-08-14T12:00:00Z');
  const empty = collectChatOpsExecutionEvidence([], AUTOMATION, () => null);

  function verdict({ nowMs, windowComplete = true }) {
    return reconcileChatOpsLedgerScope({
      rows: [row({ state: 'dispatching', attempts: 1, attemptStartedAtMs: started })],
      evidence: empty,
      windowComplete,
      nowMs,
    }).rows[0].verdict;
  }

  test('absence before the quiescence delay proves nothing', () => {
    expect(verdict({ nowMs: started + CHATOPS_EVIDENCE_QUIESCENCE_MS - 1 }).kind).toBe(
      'inconclusive',
    );
  });

  test('absence after the quiescence delay proves the operation never began', () => {
    expect(verdict({ nowMs: started + CHATOPS_EVIDENCE_QUIESCENCE_MS })).toEqual({
      kind: 'no-effect',
    });
  });

  test('an incomplete window is never proof, however long ago the attempt was', () => {
    expect(
      verdict({ nowMs: started + CHATOPS_EVIDENCE_QUIESCENCE_MS * 100, windowComplete: false }).kind,
    ).toBe('inconclusive');
  });

  test('the quiescence delay may be raised but never lowered', () => {
    // A shorter delay would let `no-effect` — the only automatic retry — be
    // reached before a just-posted claim marker could become visible.
    for (const quiescenceMs of [0, -1, 1_000, CHATOPS_EVIDENCE_QUIESCENCE_MS - 1, NaN, Infinity]) {
      expect(() =>
        reconcileChatOpsLedgerScope({
          rows: [row({ state: 'dispatching', attempts: 1, attemptStartedAtMs: started })],
          evidence: empty,
          windowComplete: true,
          nowMs: started + CHATOPS_EVIDENCE_QUIESCENCE_MS,
          quiescenceMs,
        }),
      ).toThrow(/may only be raised above/);
    }

    const raised = reconcileChatOpsLedgerScope({
      rows: [row({ state: 'dispatching', attempts: 1, attemptStartedAtMs: started })],
      evidence: empty,
      windowComplete: true,
      nowMs: started + CHATOPS_EVIDENCE_QUIESCENCE_MS,
      quiescenceMs: CHATOPS_EVIDENCE_QUIESCENCE_MS * 2,
    });
    expect(raised.rows[0].verdict.kind).toBe('inconclusive');
  });
});

describe('persisted evidence is additive (§10.5)', () => {
  test('a marker that disappears between passes lowers no count', () => {
    const persisted = row({
      state: 'dispatching',
      attempts: 1,
      attemptStartedAtMs: 0,
      evidenceClaims: 1,
      evidenceAcks: 1,
      evidence: [
        { markerCommentId: '11', kind: 'claimed', outcome: null, createdAt: '2026-08-14T12:00:05Z' },
        {
          markerCommentId: '12',
          kind: 'ack',
          outcome: 'executed',
          createdAt: '2026-08-14T12:00:06Z',
        },
      ],
    });
    const result = reconcileChatOpsLedgerScope({
      rows: [persisted],
      evidence: collectChatOpsExecutionEvidence([], AUTOMATION, () => null),
      windowComplete: true,
      nowMs: CHATOPS_EVIDENCE_QUIESCENCE_MS * 10,
    });
    expect(result.rows[0].row.evidenceClaims).toBe(1);
    expect(result.rows[0].verdict).toEqual({ kind: 'acked', outcome: 'executed' });
  });

  test('merging never re-adds a ref already recorded', () => {
    const ref = {
      markerCommentId: '11',
      kind: 'claimed',
      outcome: null,
      createdAt: '2026-08-14T12:00:05Z',
    };
    const merged = mergeChatOpsEvidence(row({ evidence: [ref], evidenceClaims: 1 }), {
      targetCommentId: '10',
      claims: 1,
      acks: 0,
      outcome: null,
      conflicting: false,
      refs: [ref],
      refsTruncated: false,
    });
    expect(merged.evidence).toHaveLength(1);
    expect(merged.evidenceClaims).toBe(1);
  });
});

describe('reconciliation lower bound (§10.5)', () => {
  test('the bound covers the earliest open write-ahead, not the cursor', () => {
    const rows = [
      row({ commentId: '10', state: 'dispatching', attemptStartedAtMs: Date.parse('2026-08-14T12:00:05Z') }),
      row({ commentId: '11', state: 'awaiting_ack', attemptStartedAtMs: Date.parse('2026-08-14T12:30:00Z') }),
    ];
    expect(chatOpsReconciliationSinceBound(rows, '2026-08-14T20:00:00Z')).toBe(
      '2026-08-14T12:00:04Z',
    );
  });

  test('terminal rows do not widen the scan', () => {
    const rows = [
      row({ state: 'acknowledged', attemptStartedAtMs: Date.parse('2020-01-01T00:00:00Z') }),
    ];
    expect(chatOpsReconciliationSinceBound(rows, '2026-08-14T20:00:00Z')).toBe(
      '2026-08-14T20:00:00Z',
    );
  });

  test('a scope with nothing open falls back to the cursor bound, including null', () => {
    expect(chatOpsReconciliationSinceBound([], null)).toBeNull();
  });
});

describe('bounded operator surfaces and login separation (§14, §10.3)', () => {
  test('detail strings are truncated and say so', () => {
    const bounded = boundChatOpsDetail('x'.repeat(CHATOPS_LEDGER_DETAIL_MAX_CHARS + 50));
    expect(bounded).toContain('(truncated)');
    expect(bounded.startsWith('x'.repeat(CHATOPS_LEDGER_DETAIL_MAX_CHARS))).toBe(true);
    expect(boundChatOpsDetail(null)).toBeNull();
  });

  test('a command author may never also be an automation identity', () => {
    expect(validateChatOpsLoginSeparation(['alice', 'Loop-Bot'], ['loop-bot'])).toEqual([
      'loop-bot',
    ]);
    expect(validateChatOpsLoginSeparation(['alice'], ['loop-bot'])).toEqual([]);
  });
});
