/**
 * The in-memory ChatOps store and fake comment port the pass tests drive
 * (issues #1024, #1031).
 *
 * Lifted out of `test/chatops-runtime.test.js` when `chatops-tool-request-operations.test.js`
 * needed the same harness: this is a faithful port implementation rather than a
 * stub — it enforces the two rules the SQLite store does (first-seen rows are
 * insert-only, an epoch is allocated only by the transaction that spends it),
 * and those are exactly the properties the at-most-once guarantee rests on. Two
 * copies of it would be two chances for one of them to stop enforcing them.
 *
 * `createChatOpsHarness` binds the three fixture constants a suite chooses
 * (identity key, work item, base instant) so the store's test-only inspection
 * helpers can default to them.
 */

// Read from the compiled core rather than restated, so a change to the sentinel
// cannot leave this harness silently disagreeing with the runtime about what
// "never initialized" looks like.
import { CHATOPS_UNINITIALIZED_CURSOR_STATE } from '../../dist/core/chatops-comment-cursor.js';

/**
 * Build the harness for one suite's fixture constants.
 *
 * @param {{identityKey: string, issue: number, baseMs: number}} fixture
 */
export function createChatOpsHarness(fixture) {
  const { identityKey: IDENTITY_KEY, issue: ISSUE, baseMs: BASE_MS } = fixture;

  function scopeKey(scope) {
    return `${scope.identityKey}#${scope.issueNumber}`;
  }

  function createMemoryStore() {
    const cursors = new Map();
    const firstSeen = new Map();
    const ledger = new Map();
    const audits = new Map();
    const fences = new Map();
    const epochs = new Map();
    const effects = new Map();
    const reservations = new Map();

    const scoped = (map, scope) => {
      const key = scopeKey(scope);
      if (!map.has(key)) map.set(key, new Map());
      return map.get(key);
    };

    /**
     * How many more writes succeed before the store starts refusing with the
     * maintenance-lock error a `prune`/`restore` produces (issue #818). `Infinity`
     * — the default — is an ordinary, unlocked store.
     *
     * Modelled as a countdown rather than a boolean so a test can put the lock
     * exactly where it hurts: acquired *between* two of one pass's transactions,
     * which is the case an entry-time check would miss.
     */
    let writesBeforeLock = Infinity;

    function guardMaintenance() {
      if (writesBeforeLock > 0) {
        writesBeforeLock -= 1;
        return;
      }
      const err = new Error('Refusing ChatOps write: a maintenance lock is held on this database');
      err.code = 'maintenance_locked';
      throw err;
    }

    function apply(scope, input) {
      const key = scopeKey(scope);
      if (input.cursor !== undefined) cursors.set(key, input.cursor);
      for (const record of input.firstSeen ?? []) {
        const table = scoped(firstSeen, scope);
        // Insert-only: a collision is a re-observation, never an overwrite.
        if (!table.has(record.commentId)) table.set(record.commentId, record);
      }
      for (const row of input.rows ?? []) scoped(ledger, scope).set(row.commentId, row);
      for (const record of input.audit ?? []) {
        if (!audits.has(key)) audits.set(key, []);
        audits.get(key).push(record);
      }
      for (const effect of input.effects ?? []) {
        if (!effects.has(effect.idempotencyKey)) effects.set(effect.idempotencyKey, effect);
      }
      for (const commentId of input.releaseAckReservations ?? []) {
        scoped(reservations, scope).delete(commentId);
      }
      if (input.fence !== undefined) {
        const fenceKey =
          input.fence.grain === 'session' ? `${scope.identityKey}#session` : key;
        if (input.fence.record === null) fences.delete(fenceKey);
        else fences.set(fenceKey, input.fence.record);
      }
    }

    return {
      backendId: 'memory:chatops',
      async getEpoch(identityKey) {
        return epochs.get(identityKey) ?? 0;
      },
      async loadScope(scope) {
        const key = scopeKey(scope);
        const rows = [...(ledger.get(key)?.values() ?? [])];
        const seen = [...(firstSeen.get(key)?.values() ?? [])];
        const tracked = new Set(rows.map((row) => row.commentId));
        return {
          cursor: cursors.get(key) ?? CHATOPS_UNINITIALIZED_CURSOR_STATE,
          rows,
          pendingFirstSeen: seen.filter((r) => !r.bootstrap && !tracked.has(r.commentId)),
          ackReservations: [...(reservations.get(key)?.values() ?? [])],
          issueFence: fences.get(key) ?? null,
          sessionFence: fences.get(`${scope.identityKey}#session`) ?? null,
          lastActivityAt: null,
        };
      },
      async getFirstSeen(scope, commentId) {
        return firstSeen.get(scopeKey(scope))?.get(commentId);
      },
      async listIssueNumbers() {
        return [ISSUE];
      },
      async commit(scope, input) {
        guardMaintenance();
        apply(scope, input);
      },
      async commitWithEpoch(scope, build) {
        // Before the epoch is allocated, exactly like the SQLite store: a refused
        // write-ahead must not consume one.
        guardMaintenance();
        const next = (epochs.get(scope.identityKey) ?? 0) + 1;
        // `build` sees the rows as stored right now, exactly as the SQLite store's
        // re-read under `BEGIN IMMEDIATE` does, so a caller holding a stale copy
        // can notice and decline.
        const persisted = [...(ledger.get(scopeKey(scope))?.values() ?? [])];
        // The fences are re-read here too: one committed after the caller's
        // `loadScope` is exactly the one a write-ahead must still refuse.
        const input = build(next, persisted, {
          issue: fences.get(scopeKey(scope)) ?? null,
          session: fences.get(`${scope.identityKey}#session`) ?? null,
        });
        if (input === null) return null;
        epochs.set(scope.identityKey, next);
        apply(scope, input);
        return next;
      },
      async commitCompareAndSwap(scope, build) {
        guardMaintenance();
        // Same re-read, no epoch: `build` decides from the rows as stored right
        // now, so a verdict is never applied to a snapshot an overlapping pass
        // has already moved past.
        const persisted = [...(ledger.get(scopeKey(scope))?.values() ?? [])];
        const input = build(persisted, {
          issue: fences.get(scopeKey(scope)) ?? null,
          session: fences.get(`${scope.identityKey}#session`) ?? null,
        });
        if (input === null) return false;
        apply(scope, input);
        return true;
      },
      async reserveAckPublication(scope, commentId, accept) {
        // One holder at a time, decided from the row as stored right now — the
        // same mutual exclusion the SQLite store gets from the reservation
        // table's primary key inside `BEGIN IMMEDIATE`.
        guardMaintenance();
        const held = scoped(reservations, scope);
        if (held.has(commentId)) return false;
        const row = ledger.get(scopeKey(scope))?.get(commentId);
        if (!accept(row)) return false;
        held.set(commentId, {
          commentId,
          ackAttempts: row?.ackAttempts ?? 0,
          reservedAt: new Date(BASE_MS).toISOString(),
        });
        return true;
      },
      async listAudit(scope, commentId) {
        const all = audits.get(scopeKey(scope)) ?? [];
        return commentId === undefined
          ? [...all]
          : all.filter((r) => r.ledgerScope.commentId === commentId);
      },
      close() {},
      /**
       * Let `n` more writes through, then refuse every one after that the way a
       * store under a `prune`/`restore` maintenance lock does.
       */
      lockMaintenanceAfter(n) {
        writesBeforeLock = n;
      },
      // Test-only inspection.
      rowsFor(issueNumber = ISSUE) {
        return [...(ledger.get(`${IDENTITY_KEY}#${issueNumber}`)?.values() ?? [])];
      },
      row(commentId, issueNumber = ISSUE) {
        return ledger.get(`${IDENTITY_KEY}#${issueNumber}`)?.get(commentId);
      },
      auditFor(commentId, issueNumber = ISSUE) {
        return (audits.get(`${IDENTITY_KEY}#${issueNumber}`) ?? []).filter(
          (r) => r.ledgerScope.commentId === commentId,
        );
      },
      effects() {
        return [...effects.values()];
      },
      cursorFor(issueNumber = ISSUE) {
        return cursors.get(`${IDENTITY_KEY}#${issueNumber}`);
      },
      reservationsFor(issueNumber = ISSUE) {
        return [...(reservations.get(`${IDENTITY_KEY}#${issueNumber}`)?.values() ?? [])];
      },
      reserve(commentId, issueNumber = ISSUE) {
        scoped(reservations, { identityKey: IDENTITY_KEY, issueNumber }).set(commentId, {
          commentId,
          ackAttempts: 0,
          reservedAt: new Date(BASE_MS).toISOString(),
        });
      },
      fenceFor(issueNumber = ISSUE) {
        return fences.get(`${IDENTITY_KEY}#${issueNumber}`) ?? fences.get(`${IDENTITY_KEY}#session`);
      },
    };
  }

  function comment(id, author, body, offsetSeconds, editedOffsetSeconds) {
    const createdAt = new Date(BASE_MS + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const updatedAt =
      editedOffsetSeconds === undefined
        ? createdAt
        : new Date(BASE_MS + editedOffsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return { id: String(id), author, body, createdAt, updatedAt };
  }

  /**
   * A provider whose comment list is ascending, canonically identified, and
   * end-of-list-signalled — the three §6 requirements. Posted comments are
   * appended to the list, so a second pass sees the markers the first pass wrote,
   * which is what makes the replay and reconciliation cases real rather than
   * simulated.
   */
  function createFakePort(initial, options = {}) {
    const comments = [...initial];
    const posted = [];
    let nextId = 1000;
    let clock = 100;
    return {
      comments,
      posted,
      alwaysHasMore: options.alwaysHasMore === true,
      postFailure: options.postFailure ?? null,
      async listComments(request) {
        if (options.listFailure) return { ok: false, error: options.listFailure };
        if (this.alwaysHasMore) {
          return { ok: true, page: { comments: [], hasMore: true } };
        }
        const start = (request.page - 1) * request.perPage;
        const slice = comments.slice(start, start + request.perPage);
        return { ok: true, page: { comments: slice, hasMore: start + slice.length < comments.length } };
      },
      async postComment(issueNumber, body) {
        const failure = typeof this.postFailure === 'function' ? this.postFailure(body) : this.postFailure;
        if (failure) return { ok: false, error: failure };
        posted.push({ issueNumber, body });
        nextId += 1;
        clock += 10;
        comments.push(comment(nextId, 'loop-bot', body, clock));
        return { ok: true };
      },
    };
  }

  return { scopeKey, createMemoryStore, comment, createFakePort };
}
