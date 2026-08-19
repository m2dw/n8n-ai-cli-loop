/**
 * Contract tests for the ChatOps binding of the operation-dispatch port
 * (issue #783) — docs/operation-dispatch-port-contract.md §9.
 *
 * Two claims are pinned here. First, the trusted execution context for one
 * dispatch attempt is built from ledger-scope facts only — never from the
 * comment body, which is what keeps a comment from retargeting another
 * session or another issue. Second, the result→ledger-event mapping is total,
 * introduces no new ledger event, and lands on the transition rows
 * docs/chatops-execution-ledger-contract.md §7 already numbers.
 */
import {
  chatOpsDispatchDisposition,
  chatOpsOperationContext,
  chatOpsOperationRequestId,
} from '../dist/core/chatops-operation-dispatch.js';
import { chatOpsLedgerKey } from '../dist/core/chatops-identity.js';
import { applyChatOpsLedgerEvent } from '../dist/core/chatops-execution-ledger.js';
import {
  operationExecuted,
  operationFailed,
  operationRejected,
  validateOperationContext,
} from '../dist/core/operation-port.js';

const IDENTITY = {
  sessionId: 'session-1',
  provider: 'github-issues',
  providerEndpoint: 'github.com',
  providerOwner: 'm2dw',
  providerRepo: 'n8n-ai-cli-loop-ai',
};

function attempt(overrides = {}) {
  return {
    identity: IDENTITY,
    issueNumber: 783,
    commentId: 'c-1',
    authorLogin: 'alice',
    attempt: 1,
    confirmed: true,
    ...overrides,
  };
}

/** A ledger row parked in `dispatching`, the state the port is invoked from. */
function dispatchingRow() {
  const claimed = applyChatOpsLedgerEvent(null, { kind: 'claim' }, 'c-1');
  expect(claimed.applied).toBe(true);
  const dispatching = applyChatOpsLedgerEvent(
    claimed.next,
    { kind: 'begin-dispatch', epoch: 7, nowMs: 1_000 },
    'c-1',
  );
  expect(dispatching.applied).toBe(true);
  return dispatching.next;
}

describe('the trusted context comes from the ledger scope, not the comment', () => {
  test('it names the chatops surface, the first-seen author, and the scope tuple', () => {
    const context = chatOpsOperationContext(attempt());
    expect(context).toEqual({
      surface: 'chatops',
      actor: { kind: 'human', id: 'alice' },
      sessionId: 'session-1',
      issueNumber: 783,
      requestId: `${chatOpsLedgerKey(IDENTITY, 783, 'c-1')}#1`,
      confirmed: true,
      deadlineMs: null,
    });
    expect(validateOperationContext(context)).toBeNull();
  });

  test('the session comes from the identity, so a comment cannot retarget another one', () => {
    const other = chatOpsOperationContext(
      attempt({ identity: { ...IDENTITY, sessionId: 'session-2' } }),
    );
    expect(other.sessionId).toBe('session-2');
    // The only way to change the session is to change the ledger scope: the
    // attempt has no session field of its own, so a caller cannot pass one
    // alongside an identity and have it win.
    expect(chatOpsOperationContext({ ...attempt(), sessionId: 'session-3' }).sessionId).toBe(
      'session-1',
    );
  });

  test('confirmation is an input, never defaulted by this layer', () => {
    expect(chatOpsOperationContext(attempt({ confirmed: false })).confirmed).toBe(false);
    expect(chatOpsOperationContext(attempt({ confirmed: true })).confirmed).toBe(true);
  });

  test('an advisory deadline is passed through, absent by default', () => {
    expect(chatOpsOperationContext(attempt()).deadlineMs).toBeNull();
    expect(chatOpsOperationContext(attempt({ deadlineMs: 30_000 })).deadlineMs).toBe(30_000);
  });

  test('a missing author or a non-positive attempt is a defect, not a default', () => {
    expect(() => chatOpsOperationContext(attempt({ authorLogin: '  ' }))).toThrow(/first-seen author/);
    expect(() => chatOpsOperationContext(attempt({ attempt: 0 }))).toThrow(/positive integer/);
    expect(() => chatOpsOperationContext(attempt({ attempt: 1.5 }))).toThrow(/positive integer/);
  });
});

describe('the request id identifies exactly one attempt', () => {
  test('it is the ledger key plus the attempt number', () => {
    expect(chatOpsOperationRequestId(attempt())).toBe(`${chatOpsLedgerKey(IDENTITY, 783, 'c-1')}#1`);
  });

  test('different attempts, comments, issues, and sessions never share one', () => {
    const ids = new Set([
      chatOpsOperationRequestId(attempt()),
      chatOpsOperationRequestId(attempt({ attempt: 2 })),
      chatOpsOperationRequestId(attempt({ commentId: 'c-2' })),
      chatOpsOperationRequestId(attempt({ issueNumber: 784 })),
      chatOpsOperationRequestId(attempt({ identity: { ...IDENTITY, sessionId: 'session-2' } })),
    ]);
    expect(ids.size).toBe(5);
  });
});

describe('result → ledger event mapping (contract §9.2)', () => {
  test('an executed operation is a definite executed outcome', () => {
    const disposition = chatOpsDispatchDisposition(operationExecuted('resolved 1 request'));
    expect(disposition).toMatchObject({
      kind: 'record',
      event: { kind: 'dispatch-result', outcome: 'executed' },
    });
  });

  test('every rejection is a definite rejected outcome', () => {
    for (const reason of [
      'unknown-operation',
      'invalid-request',
      'invalid-context',
      'not-permitted',
      'precondition-failed',
      'conflict',
    ]) {
      expect(chatOpsDispatchDisposition(operationRejected(reason, 'nope'))).toMatchObject({
        kind: 'record',
        event: { kind: 'dispatch-result', outcome: 'rejected' },
      });
    }
  });

  test('a proven-effect-free internal defect is acknowledged as an error, not retried', () => {
    expect(chatOpsDispatchDisposition(operationFailed('internal', 'none', 'bad state'))).toMatchObject({
      kind: 'record',
      event: { kind: 'dispatch-result', outcome: 'error' },
    });
  });

  test('a proven-effect-free transient failure takes the ledger retry path', () => {
    for (const reason of ['unavailable', 'timeout']) {
      expect(chatOpsDispatchDisposition(operationFailed(reason, 'none', 'provider down'))).toMatchObject({
        kind: 'record',
        event: { kind: 'reconciled', verdict: { kind: 'no-effect' } },
      });
    }
  });

  test('an indeterminate effect records nothing and defers to reconciliation', () => {
    for (const reason of ['unavailable', 'timeout', 'internal']) {
      const disposition = chatOpsDispatchDisposition(operationFailed(reason, 'unknown', 'lost the connection'));
      expect(disposition.kind).toBe('reconcile');
      expect(disposition.event).toBeUndefined();
      expect(disposition.detail).toMatch(/lost the connection/);
    }
  });

  test('the mapping carries the operation summary into the ledger detail', () => {
    expect(chatOpsDispatchDisposition(operationExecuted('resolved 1 request')).detail).toMatch(
      /resolved 1 request/,
    );
    expect(
      chatOpsDispatchDisposition(operationRejected('precondition-failed', 'no such request')).detail,
    ).toMatch(/precondition-failed: no such request/);
  });
});

describe('every mapped event is one the ledger already defines', () => {
  test('executed, rejected, and error land on row 8 from dispatching', () => {
    for (const result of [
      operationExecuted('done'),
      operationRejected('precondition-failed', 'nope'),
      operationFailed('internal', 'none', 'bad state'),
    ]) {
      const disposition = chatOpsDispatchDisposition(result);
      expect(disposition.kind).toBe('record');
      const transition = applyChatOpsLedgerEvent(dispatchingRow(), disposition.event, 'c-1');
      expect(transition.applied).toBe(true);
      expect(transition.row).toBe(8);
      expect(transition.next.state).toBe('awaiting_ack');
    }
  });

  test('a transient no-effect failure lands on row 9 and schedules the bounded retry', () => {
    const disposition = chatOpsDispatchDisposition(operationFailed('unavailable', 'none', 'down'));
    const transition = applyChatOpsLedgerEvent(dispatchingRow(), disposition.event, 'c-1');
    expect(transition.applied).toBe(true);
    expect(transition.row).toBe(9);
    expect(transition.next.state).toBe('retry_scheduled');
    // The write-ahead already counted this attempt; the retry path does not
    // count it again, so #782 §11.1's claims-vs-attempts predicate stays true.
    expect(transition.next.attempts).toBe(1);
  });

  test('an indeterminate result leaves the row dispatching, which is what reconciliation expects', () => {
    const disposition = chatOpsDispatchDisposition(operationFailed('timeout', 'unknown', 'no answer'));
    expect(disposition.kind).toBe('reconcile');
    expect(dispatchingRow().state).toBe('dispatching');
  });
});
