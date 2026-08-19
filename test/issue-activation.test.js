/**
 * Reusable automation-label activation/suspension (issue #787): pure
 * execution-label resolution plus the suspend/activate service functions,
 * exercised against a fake WorkItemProvider and an in-memory
 * IssueActivationStore.
 */
import {
  resolveExecutionLabelSet,
  planSuspend,
  planActivate,
  suspendIssueAutomation,
  activateIssueAutomation,
  suspensionLabelOwner,
  suspensionLabelsOwnedBy,
} from '../dist/index.js';

const NOW = '2026-07-28T10:00:00.000Z';
const LATER = '2026-07-28T10:05:00.000Z';

function fakeSession(overrides = {}) {
  return {
    sessionId: 's1',
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    ...overrides,
  };
}

function fakeProvider(
  initialLabels,
  { failGetItem, failGetItemOnCall = [], failRemove = [], failAdd = [], onGetItem, onBeforeRemove } = {},
) {
  let labels = [...initialLabels];
  let getItemCalls = 0;
  return {
    getItem() {
      getItemCalls++;
      // Lets a test simulate a concurrent actor mutating labels out-of-band
      // at a specific `getItem` call (e.g. between the initial read and a
      // later re-verification read), by index.
      if (onGetItem) onGetItem(getItemCalls, (label) => (labels = labels.filter((l) => l !== label)));
      if (failGetItem || failGetItemOnCall.includes(getItemCalls)) {
        return { ok: false, error: 'gh issue view failed' };
      }
      return { ok: true, value: { labels: [...labels] } };
    },
    transitionItem(_issueNumber, transition) {
      if (transition.kind === 'remove-label') {
        if (failRemove.includes(transition.label)) {
          return { ok: false, error: `remove failed: ${transition.label}` };
        }
        // Lets a test simulate a concurrent actor removing THIS SAME label in
        // the instant between the caller's own pre-removal re-verification
        // read and this delete request landing — the window the re-read
        // alone cannot close (issue #787 review).
        if (onBeforeRemove) onBeforeRemove(transition.label, (label) => (labels = labels.filter((l) => l !== label)));
        if (!labels.includes(transition.label)) {
          // Mirrors both real providers: removing an already-absent label is
          // reported as `ok: true` with `alreadyAbsent: true`, not credited
          // as a removal this call performed.
          return { ok: true, alreadyAbsent: true };
        }
        labels = labels.filter((l) => l !== transition.label);
        return { ok: true };
      }
      if (failAdd.includes(transition.label)) {
        return { ok: false, error: `add failed: ${transition.label}` };
      }
      if (!labels.includes(transition.label)) labels.push(transition.label);
      return { ok: true };
    },
    currentLabels: () => [...labels],
  };
}

function memoryStore() {
  const map = new Map();
  return {
    async getSuspension(sessionId, issueNumber) {
      return map.get(`${sessionId}:${issueNumber}`);
    },
    async putSuspension(record) {
      const key = `${record.sessionId}:${record.issueNumber}`;
      const nextRev = (map.get(key)?.rev ?? 0) + 1;
      map.set(key, { ...record, rev: nextRev });
    },
    async clearSuspension(sessionId, issueNumber) {
      map.delete(`${sessionId}:${issueNumber}`);
    },
    // Keyed on a store-owned monotonic `rev`, not `updatedAt` (issue #787
    // review) — mirrors SqliteIssueActivationStore's CAS contract so tests
    // against this in-memory store exercise the real predicate shape.
    async putSuspensionIfUnchanged(record, expectedRev) {
      const key = `${record.sessionId}:${record.issueNumber}`;
      const current = map.get(key);
      if (current?.rev !== expectedRev) return false;
      const nextRev = (current?.rev ?? 0) + 1;
      map.set(key, { ...record, rev: nextRev });
      return true;
    },
    async clearSuspensionIfUnchanged(sessionId, issueNumber, expectedRev) {
      const key = `${sessionId}:${issueNumber}`;
      const current = map.get(key);
      if (current?.rev !== expectedRev) return false;
      map.delete(key);
      return true;
    },
    size: () => map.size,
  };
}

/** Wraps a memoryStore so a hook can run arbitrary mutations (simulating a
 * concurrent operation) at the moment a CAS write is attempted, and/or force
 * `putSuspensionIfUnchanged` to reject (simulating a store fault). */
function raceableMemoryStore(base = memoryStore()) {
  let onPutAttempt;
  let onClearAttempt;
  let failNextPutMessage;
  let failNextGetMessage;
  return {
    ...base,
    async getSuspension(sessionId, issueNumber) {
      if (failNextGetMessage !== undefined) {
        const message = failNextGetMessage;
        failNextGetMessage = undefined;
        throw new Error(message);
      }
      return base.getSuspension(sessionId, issueNumber);
    },
    async putSuspensionIfUnchanged(record, expectedRev) {
      if (onPutAttempt) {
        const hook = onPutAttempt;
        onPutAttempt = undefined;
        await hook();
      }
      if (failNextPutMessage !== undefined) {
        const message = failNextPutMessage;
        failNextPutMessage = undefined;
        throw new Error(message);
      }
      return base.putSuspensionIfUnchanged(record, expectedRev);
    },
    async clearSuspensionIfUnchanged(sessionId, issueNumber, expectedRev) {
      if (onClearAttempt) {
        const hook = onClearAttempt;
        onClearAttempt = undefined;
        await hook();
      }
      return base.clearSuspensionIfUnchanged(sessionId, issueNumber, expectedRev);
    },
    runBeforeNextPut(hook) {
      onPutAttempt = hook;
    },
    runBeforeNextClear(hook) {
      onClearAttempt = hook;
    },
    failNextPutWith(message) {
      failNextPutMessage = message ?? 'simulated store fault';
    },
    failNextGetWith(message) {
      failNextGetMessage = message ?? 'simulated store fault';
    },
  };
}

describe('resolveExecutionLabelSet', () => {
  test('resolves the built-in fallback labels when the session configures none', () => {
    const set = resolveExecutionLabelSet(fakeSession());
    expect(set.agentLabels.sort()).toEqual(['agent:claude', 'agent:codex', 'agent:gemini']);
    expect(set.statusLabels.sort()).toEqual(
      [
        'status:needs-implementation',
        'status:needs-fix',
        'status:needs-review',
        'status:research-needed',
        'status:content-needed',
        'status:needs-conflict-resolution',
      ].sort(),
    );
  });

  test('a session-configured lane label is included alongside the literal github-intake gate (issue #787 review)', () => {
    const session = fakeSession({
      labels: {
        active: 'ai:active',
        blocked: 'ai:blocked',
        readyForHuman: 'ai:ready-for-human',
        needsImplementation: 'lane:impl-needed',
      },
    });
    const set = resolveExecutionLabelSet(session);
    // Both the configured alias AND the literal `status:needs-implementation`
    // must be present: `github-intake`'s labelsToPhase gate always checks the
    // literal, never a session's configured alias, so suspending only the
    // alias would leave the real gate on the Issue.
    expect(set.statusLabels).toContain('lane:impl-needed');
    expect(set.statusLabels).toContain('status:needs-implementation');
  });
});

describe('planSuspend / planActivate', () => {
  test('planSuspend separates execution labels from everything else', () => {
    const diff = planSuspend(fakeSession(), [
      'status:needs-implementation',
      'agent:claude',
      'ai:blocked',
      'priority:high',
    ]);
    expect(diff.removed.sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    expect(diff.preserved.sort()).toEqual(['ai:blocked', 'priority:high']);
    expect(diff.restorable).toEqual(diff.removed);
  });

  test('planActivate only adds restorable labels not already present', () => {
    const diff = planActivate(['status:needs-implementation', 'agent:claude'], ['agent:claude', 'priority:high']);
    expect(diff.added).toEqual(['status:needs-implementation']);
    expect(diff.preserved).toEqual(['agent:claude', 'priority:high']);
  });
});

describe('suspendIssueAutomation', () => {
  test('removes execution labels, preserves unrelated/human labels, and records a restorable set', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['status:needs-implementation', 'agent:claude', 'ai:blocked', 'priority:high']);
    const store = memoryStore();

    const outcome = await suspendIssueAutomation(session, provider, store, 101, 'op-1', NOW);

    expect(outcome.ok).toBe(true);
    expect(outcome.removed.sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    expect(outcome.preserved.sort()).toEqual(['ai:blocked', 'priority:high']);
    expect(outcome.restorable.sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    expect(provider.currentLabels().sort()).toEqual(['ai:blocked', 'priority:high']);

    const record = await store.getSuspension('s1', 101);
    expect(record.labels.sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    expect(record.operationId).toBe('op-1');
    expect(record.suspendedAt).toBe(NOW);
  });

  test('is idempotent: a repeated call with nothing left to remove reports the standing suspension without rewriting the store', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['status:needs-implementation', 'agent:claude']);
    const store = memoryStore();

    await suspendIssueAutomation(session, provider, store, 101, 'op-1', NOW);
    const before = await store.getSuspension('s1', 101);

    const second = await suspendIssueAutomation(session, provider, store, 101, 'op-2', LATER);
    expect(second.ok).toBe(true);
    expect(second.removed).toEqual([]);
    expect(second.alreadySuspended).toBe(true);
    expect(second.restorable.sort()).toEqual(['agent:claude', 'status:needs-implementation']);

    const after = await store.getSuspension('s1', 101);
    expect(after).toEqual(before);
  });

  test('merging into an existing record leaves its attribution with the operation that opened it (issue #791 review)', async () => {
    const session = fakeSession();
    // `agent:claude` is already suspended by op-1; `status:*` is still on the
    // Issue (re-applied by hand, say) and comes off in op-2.
    const provider = fakeProvider(['status:needs-implementation', 'ai:blocked']);
    const store = memoryStore();
    await store.putSuspension({
      sessionId: 's1',
      issueNumber: 101,
      labels: ['agent:claude'],
      operationId: 'op-1',
      suspendedAt: NOW,
      updatedAt: NOW,
    });

    const outcome = await suspendIssueAutomation(session, provider, store, 101, 'op-2', LATER);

    expect(outcome.ok).toBe(true);
    expect(outcome.removed).toEqual(['status:needs-implementation']);
    const record = await store.getSuspension('s1', 101);
    expect(record.labels.sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    // op-2 added to op-1's suspension; it did not take it over, so a later
    // op-2-scoped restore cannot claim op-1's label as its own.
    expect(record.operationId).toBe('op-1');
    expect(record.suspendedAt).toBe(NOW);
  });

  test('a partial failure never marks a still-present label restorable, and a retry completes it', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['status:needs-implementation', 'agent:claude'], {
      failRemove: ['agent:claude'],
    });
    const store = memoryStore();

    const first = await suspendIssueAutomation(session, provider, store, 101, 'op-1', NOW);
    expect(first.ok).toBe(false);
    expect(first.error).toContain('agent:claude');
    expect(first.removed).toEqual(['status:needs-implementation']);
    expect(first.restorable).toEqual(['status:needs-implementation']);
    expect(provider.currentLabels()).toEqual(['agent:claude']);

    const recordAfterFirst = await store.getSuspension('s1', 101);
    expect(recordAfterFirst.labels).toEqual(['status:needs-implementation']);

    // Retry against the Issue's real remaining state (the transient failure
    // cleared): only the still-present label is targeted, and the restorable
    // set accumulates both labels.
    const retryProvider = fakeProvider(['agent:claude']);
    const second = await suspendIssueAutomation(session, retryProvider, store, 101, 'op-2', LATER);
    expect(second.ok).toBe(true);
    expect(second.removed).toEqual(['agent:claude']);
    expect(second.restorable.sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    expect(retryProvider.currentLabels()).toEqual([]);
  });

  test('a getItem read failure fails closed without touching the store', async () => {
    const session = fakeSession();
    const provider = fakeProvider([], { failGetItem: true });
    const store = memoryStore();

    const outcome = await suspendIssueAutomation(session, provider, store, 101, 'op-1', NOW);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
    expect(store.size()).toBe(0);
  });

  test('does not record a label as restorable if another actor already removed it before this call attempts it (issue #787 review)', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['status:needs-implementation', 'agent:claude'], {
      // Simulate an external actor removing `agent:claude` between the
      // initial read (getItem call 1) and the pre-removal re-verification
      // (getItem call 2) — both GitHub and Gitea treat removing an
      // already-absent label as success, so without re-verification this
      // would be wrongly credited to this operation and become restorable.
      onGetItem: (callIndex, removeLabel) => {
        if (callIndex === 2) removeLabel('agent:claude');
      },
    });
    const store = memoryStore();

    const outcome = await suspendIssueAutomation(session, provider, store, 101, 'op-1', NOW);

    expect(outcome.ok).toBe(true);
    expect(outcome.removed).toEqual(['status:needs-implementation']);
    expect(outcome.restorable).toEqual(['status:needs-implementation']);
    expect(provider.currentLabels()).toEqual([]);

    const record = await store.getSuspension('s1', 101);
    expect(record.labels).toEqual(['status:needs-implementation']);
  });

  test('does not record a label as restorable when the removal races another actor between the re-verification read and the delete itself (issue #787 review)', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['status:needs-implementation', 'agent:claude'], {
      // The pre-removal re-verification read still sees `agent:claude`
      // present, but an external actor removes it in the instant between
      // that read and this call's own DELETE request landing. Both real
      // providers report the resulting 404 as `ok: true` — only
      // `alreadyAbsent` distinguishes "someone else already removed this"
      // from "this call removed it".
      onBeforeRemove: (label, removeLabel) => {
        if (label === 'agent:claude') removeLabel('agent:claude');
      },
    });
    const store = memoryStore();

    const outcome = await suspendIssueAutomation(session, provider, store, 101, 'op-1', NOW);

    expect(outcome.ok).toBe(true);
    expect(outcome.removed).toEqual(['status:needs-implementation']);
    expect(outcome.restorable).toEqual(['status:needs-implementation']);
    expect(provider.currentLabels()).toEqual([]);

    const record = await store.getSuspension('s1', 101);
    expect(record.labels).toEqual(['status:needs-implementation']);
  });

  test('recheck happens before EACH deletion, not only once before the whole loop (issue #787 review)', async () => {
    const session = fakeSession();
    const provider = fakeProvider(
      ['status:needs-implementation', 'status:needs-fix', 'status:needs-review'],
      {
        // Simulate an external actor removing `status:needs-review` partway
        // through the loop — after the first label's own removal, but before
        // the loop reaches `status:needs-review`'s turn. A single snapshot
        // taken once before the loop cannot see this; only a re-read
        // immediately before each deletion can.
        onGetItem: (callIndex, removeLabel) => {
          if (callIndex === 3) removeLabel('status:needs-review');
        },
      },
    );
    const store = memoryStore();

    const outcome = await suspendIssueAutomation(session, provider, store, 101, 'op-1', NOW);

    expect(outcome.ok).toBe(true);
    expect(outcome.removed.sort()).toEqual(['status:needs-fix', 'status:needs-implementation']);
    expect(outcome.restorable.sort()).toEqual(['status:needs-fix', 'status:needs-implementation']);
    expect(provider.currentLabels()).toEqual([]);
  });

  test('a pre-removal re-verification read failure fails closed without removing any label', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['status:needs-implementation', 'agent:claude'], { failGetItemOnCall: [2] });
    const store = memoryStore();

    const outcome = await suspendIssueAutomation(session, provider, store, 101, 'op-1', NOW);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
    expect(outcome.removed).toEqual([]);
    expect(provider.currentLabels().sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    expect(await store.getSuspension('s1', 101)).toBeUndefined();
  });

  test('a merged record attributes each label to the operation that removed it (issue #791 review)', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['status:needs-implementation']);
    const store = memoryStore();

    // `op-1` opens the record by taking the status label...
    await suspendIssueAutomation(session, provider, store, 101, 'op-1', NOW);
    // ...and an agent label arrives afterwards, which `op-2` is the one to take.
    provider.transitionItem(101, { kind: 'add-label', label: 'agent:claude' });
    await suspendIssueAutomation(session, provider, store, 101, 'op-2', LATER);

    const record = await store.getSuspension('s1', 101);
    expect(record.labels.sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    // The record still belongs to whoever opened it...
    expect(record.operationId).toBe('op-1');
    // ...but each label names the operation that owes it back, so `op-2` can
    // recognize its own on a retry instead of finding a record it does not own.
    expect(suspensionLabelOwner(record, 'status:needs-implementation')).toBe('op-1');
    expect(suspensionLabelOwner(record, 'agent:claude')).toBe('op-2');
    expect(suspensionLabelsOwnedBy(record, 'op-2')).toEqual(['agent:claude']);
    expect(suspensionLabelsOwnedBy(record, 'op-1')).toEqual(['status:needs-implementation']);
  });

  test('a label taken off, put back, and taken off again belongs to the operation that removed it last', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['status:needs-implementation']);
    const store = memoryStore();

    await suspendIssueAutomation(session, provider, store, 101, 'op-1', NOW);
    provider.transitionItem(101, { kind: 'add-label', label: 'status:needs-implementation' });
    await suspendIssueAutomation(session, provider, store, 101, 'op-2', LATER);

    const record = await store.getSuspension('s1', 101);
    expect(suspensionLabelOwner(record, 'status:needs-implementation')).toBe('op-2');
    expect(suspensionLabelsOwnedBy(record, 'op-1')).toEqual([]);
  });

  test('a record written before per-label attribution existed reads as the record-level operation', async () => {
    const store = memoryStore();
    await store.putSuspension({
      sessionId: 's1',
      issueNumber: 101,
      labels: ['status:needs-implementation', 'agent:claude'],
      operationId: 'op-legacy',
      suspendedAt: NOW,
      updatedAt: NOW,
    });

    const record = await store.getSuspension('s1', 101);
    expect(suspensionLabelOwner(record, 'agent:claude')).toBe('op-legacy');
    expect(suspensionLabelsOwnedBy(record, 'op-legacy').sort()).toEqual([
      'agent:claude',
      'status:needs-implementation',
    ]);
    expect(suspensionLabelsOwnedBy(record, 'op-other')).toEqual([]);
  });
});

describe('activateIssueAutomation', () => {
  test('restores exactly the suspended labels and clears the suspension record', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['ai:blocked', 'priority:high']);
    const store = memoryStore();
    await store.putSuspension({
      sessionId: 's1',
      issueNumber: 101,
      labels: ['status:needs-implementation', 'agent:claude'],
      operationId: 'op-1',
      suspendedAt: NOW,
      updatedAt: NOW,
    });

    const outcome = await activateIssueAutomation(session, provider, store, 101, LATER);
    expect(outcome.ok).toBe(true);
    expect(outcome.added.sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    expect(outcome.restorable).toEqual([]);
    expect(provider.currentLabels().sort()).toEqual([
      'agent:claude',
      'ai:blocked',
      'priority:high',
      'status:needs-implementation',
    ]);
    expect(await store.getSuspension('s1', 101)).toBeUndefined();
  });

  test('onlyLabels restores what the caller suspended and leaves the rest of the record standing (issue #791 review)', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['ai:blocked']);
    const store = memoryStore();
    // A merged record: `status:*` came off in somebody else's operation,
    // `agent:claude` in this caller's.
    await store.putSuspension({
      sessionId: 's1',
      issueNumber: 101,
      labels: ['status:needs-implementation', 'agent:claude'],
      operationId: 'op-1',
      suspendedAt: NOW,
      updatedAt: NOW,
    });

    const outcome = await activateIssueAutomation(session, provider, store, 101, LATER, {
      onlyLabels: ['agent:claude'],
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.added).toEqual(['agent:claude']);
    // Still withheld, and still on record for whoever suspended it.
    expect(outcome.restorable).toEqual(['status:needs-implementation']);
    expect(provider.currentLabels().sort()).toEqual(['agent:claude', 'ai:blocked']);
    const record = await store.getSuspension('s1', 101);
    expect(record.labels).toEqual(['status:needs-implementation']);
    expect(record.operationId).toBe('op-1');
  });

  test('onlyLabels naming nothing on the record leaves the Issue and the record exactly as they were', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['ai:blocked']);
    const store = memoryStore();
    await store.putSuspension({
      sessionId: 's1',
      issueNumber: 101,
      labels: ['status:needs-implementation'],
      operationId: 'op-1',
      suspendedAt: NOW,
      updatedAt: NOW,
    });
    const before = await store.getSuspension('s1', 101);

    const outcome = await activateIssueAutomation(session, provider, store, 101, LATER, {
      onlyLabels: ['agent:claude'],
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.added).toEqual([]);
    expect(outcome.restorable).toEqual(['status:needs-implementation']);
    expect(provider.currentLabels()).toEqual(['ai:blocked']);
    expect(await store.getSuspension('s1', 101)).toEqual(before);
  });

  test('is a safe no-op when nothing is suspended, and never calls the provider mutation path', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['priority:high']);
    const store = memoryStore();

    const outcome = await activateIssueAutomation(session, provider, store, 101, NOW);
    expect(outcome.ok).toBe(true);
    expect(outcome.alreadyActive).toBe(true);
    expect(outcome.added).toEqual([]);
    expect(provider.currentLabels()).toEqual(['priority:high']);
  });

  test('revalidates labels immediately before clearing the suspension record, rather than trusting the stale pre-add read (issue #787 review)', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['status:needs-implementation', 'agent:claude'], {
      // Both suspended labels are already present on the Issue at the first
      // `getItem` read, so `diff.added` is empty and `agent:claude` is never
      // re-added. An external actor removes `agent:claude` right after that
      // read — call 2 is the re-verification read taken immediately before
      // deciding what is still missing.
      onGetItem: (callIndex, removeLabel) => {
        if (callIndex === 2) removeLabel('agent:claude');
      },
    });
    const store = memoryStore();
    await store.putSuspension({
      sessionId: 's1',
      issueNumber: 101,
      labels: ['status:needs-implementation', 'agent:claude'],
      operationId: 'op-1',
      suspendedAt: NOW,
      updatedAt: NOW,
    });

    const outcome = await activateIssueAutomation(session, provider, store, 101, LATER);

    expect(outcome.ok).toBe(true);
    // `agent:claude` looked present at the stale first read, so it was never
    // targeted for add-label — but it is actually gone. The record must
    // still carry it as restorable rather than being cleared.
    expect(outcome.added).toEqual([]);
    expect(outcome.restorable).toEqual(['agent:claude']);

    const record = await store.getSuspension('s1', 101);
    expect(record.labels).toEqual(['agent:claude']);
  });

  test('a partial failure keeps only the still-missing label suspended, and a retry completes it', async () => {
    const session = fakeSession();
    const provider = fakeProvider([], { failAdd: ['agent:claude'] });
    const store = memoryStore();
    await store.putSuspension({
      sessionId: 's1',
      issueNumber: 101,
      labels: ['status:needs-implementation', 'agent:claude'],
      operationId: 'op-1',
      suspendedAt: NOW,
      updatedAt: NOW,
    });

    const first = await activateIssueAutomation(session, provider, store, 101, LATER);
    expect(first.ok).toBe(false);
    expect(first.added).toEqual(['status:needs-implementation']);
    expect(first.restorable).toEqual(['agent:claude']);

    const recordAfterFirst = await store.getSuspension('s1', 101);
    expect(recordAfterFirst.labels).toEqual(['agent:claude']);

    const retryProvider = fakeProvider(['status:needs-implementation']);
    const second = await activateIssueAutomation(session, retryProvider, store, 101, '2026-07-28T10:10:00.000Z');
    expect(second.ok).toBe(true);
    expect(second.added).toEqual(['agent:claude']);
    expect(second.restorable).toEqual([]);
    expect(retryProvider.currentLabels().sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    expect(await store.getSuspension('s1', 101)).toBeUndefined();
  });
});

describe('preservation of unrelated labels across a full suspend/activate cycle', () => {
  test('ai:blocked and other human-applied labels survive untouched', async () => {
    const session = fakeSession();
    const provider = fakeProvider([
      'status:needs-review',
      'agent:codex',
      'ai:blocked',
      'priority:high',
      'good-first-issue',
    ]);
    const store = memoryStore();

    await suspendIssueAutomation(session, provider, store, 202, 'op-1', NOW);
    expect(provider.currentLabels().sort()).toEqual(['ai:blocked', 'good-first-issue', 'priority:high']);

    await activateIssueAutomation(session, provider, store, 202, LATER);
    expect(provider.currentLabels().sort()).toEqual([
      'agent:codex',
      'ai:blocked',
      'good-first-issue',
      'priority:high',
      'status:needs-review',
    ]);
  });
});

describe('concurrency and persistence-failure safety (review follow-up)', () => {
  test('activate never clobbers a suspension record a concurrent operation committed after it read', async () => {
    const session = fakeSession();
    const provider = fakeProvider([]);
    const store = raceableMemoryStore();
    await store.putSuspension({
      sessionId: 's1',
      issueNumber: 101,
      labels: ['status:needs-implementation'],
      operationId: 'op-1',
      suspendedAt: NOW,
      updatedAt: NOW,
    });

    // Fires the instant activate attempts its CAS clear (matching the record
    // it read at NOW) — simulates a concurrent `suspend` committing a newer
    // record for a different label in between activate's read and its write.
    store.runBeforeNextClear(async () => {
      await store.putSuspension({
        sessionId: 's1',
        issueNumber: 101,
        labels: ['agent:claude'],
        operationId: 'op-2',
        suspendedAt: NOW,
        updatedAt: LATER,
      });
    });

    const outcome = await activateIssueAutomation(session, provider, store, 101, LATER);

    expect(outcome.ok).toBe(true);
    // Retried against the concurrently-committed record instead of losing
    // it: both the pre-race and the concurrently-suspended label end up
    // restored, and the record is cleared rather than left stranded.
    expect(outcome.added.sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    expect(provider.currentLabels().sort()).toEqual(['agent:claude', 'status:needs-implementation']);
    expect(await store.getSuspension('s1', 101)).toBeUndefined();
  });

  test('a suspension-record persistence failure compensates the label removals rather than stranding them', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['status:needs-implementation', 'agent:claude', 'ai:blocked']);
    const store = raceableMemoryStore();
    store.failNextPutWith('disk full');

    const outcome = await suspendIssueAutomation(session, provider, store, 101, 'op-1', NOW);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('disk full');
    // Compensated: the labels this call removed were re-added, so the Issue
    // is back to its pre-operation state instead of suspended with no
    // restorable record.
    expect(outcome.removed).toEqual([]);
    expect(outcome.restorable).toEqual([]);
    // Compensation succeeded, so nothing is stranded and the caller has no
    // manual re-add to report (issue #791 review).
    expect(outcome.strandedLabels).toBeUndefined();
    expect(provider.currentLabels().sort()).toEqual(['agent:claude', 'ai:blocked', 'status:needs-implementation']);
    expect(await store.getSuspension('s1', 101)).toBeUndefined();
  });

  test('a post-CAS re-read failure after a lost race compensates rather than stranding the removed labels (issue #787 review)', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['status:needs-implementation', 'agent:claude']);
    const store = raceableMemoryStore();

    // The first CAS attempt loses the race to a concurrent write, and the
    // follow-up re-read persistSuspensionRecord issues to retry then fails
    // outright (e.g. SQLite busy/I/O error) instead of returning a record.
    store.runBeforeNextPut(async () => {
      await store.putSuspension({
        sessionId: 's1',
        issueNumber: 101,
        labels: ['other:label'],
        operationId: 'op-concurrent',
        suspendedAt: NOW,
        updatedAt: NOW,
      });
      store.failNextGetWith('database is locked');
    });

    const outcome = await suspendIssueAutomation(session, provider, store, 101, 'op-1', NOW);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('database is locked');
    // Compensated: the labels this call removed were re-added rather than
    // left absent with no restorable record.
    expect(outcome.removed).toEqual([]);
    expect(provider.currentLabels().sort()).toEqual(['agent:claude', 'status:needs-implementation']);
  });

  test('when compensation itself cannot fully restore, the failure clearly names the stranded label(s)', async () => {
    const session = fakeSession();
    const provider = fakeProvider(['status:needs-implementation', 'agent:claude'], { failAdd: ['agent:claude'] });
    const store = raceableMemoryStore();
    store.failNextPutWith('disk full');

    const outcome = await suspendIssueAutomation(session, provider, store, 101, 'op-1', NOW);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('manual recovery required');
    expect(outcome.error).toContain('agent:claude');
    expect(outcome.removed).toEqual(['agent:claude']);
    // Called out separately so a caller can tell this apart from an ordinary
    // failed suspend: no record names these labels, so activation cannot bring
    // them back and only a manual re-add will (issue #791 review).
    expect(outcome.strandedLabels).toEqual(['agent:claude']);
    expect(provider.currentLabels()).toEqual(['status:needs-implementation']);
    expect(await store.getSuspension('s1', 101)).toBeUndefined();
  });
});
