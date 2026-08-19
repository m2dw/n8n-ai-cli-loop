/**
 * Contract tests for the durable ChatOps comment cursor and complete scan
 * window (issue #781) — docs/chatops-comment-cursor-contract.md.
 *
 * These pin the acceptance criteria: the cursor cannot permanently skip a
 * valid command at a timestamp boundary, advancement requires a complete
 * documented scan window, pagination/overlap behavior is deterministic,
 * first-seen input is durable, and any failure to prove completeness fails
 * closed without advancing state.
 */
import {
  CHATOPS_COMMENT_ID_RE,
  CHATOPS_MAX_SCAN_PAGES,
  CHATOPS_SCAN_SINCE_MARGIN_MS,
  CHATOPS_UNINITIALIZED_CURSOR_STATE,
  buildChatOpsFirstSeenRecord,
  chatOpsCursorFromComment,
  chatOpsCursorOrderKey,
  chatOpsScanFetchFailure,
  chatOpsScanSinceBound,
  compareChatOpsCommentIds,
  compareChatOpsCommentOrderKeys,
  deriveChatOpsCommentOrderKey,
  evaluateChatOpsScanWindow,
  indexAuthenticatedChatOpsMarkers,
  parseChatOpsTimestamp,
  planChatOpsBootstrap,
  reconcileChatOpsFirstSeen,
  selectChatOpsCandidates,
} from '../dist/core/chatops-comment-cursor.js';
import { MAX_CHATOPS_COMMENT_BODY_CHARS } from '../dist/core/chatops-command.js';

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

/** A single-page, end-of-list scan. */
function onePage(comments) {
  return [{ comments, hasMore: false }];
}

function completeWindow(pages, cursor = null) {
  const window = evaluateChatOpsScanWindow({ cursor, pages });
  if (window.kind !== 'complete') {
    throw new Error(`expected a complete window, got ${window.reason}: ${window.detail}`);
  }
  return window;
}

// ---------------------------------------------------------------------------
// §3 Total ordering
// ---------------------------------------------------------------------------

describe('comment ordering (§3)', () => {
  test('identical timestamps are ordered by comment id, not left equal', () => {
    const a = deriveChatOpsCommentOrderKey(comment('10', '2026-01-01T00:00:05Z'));
    const b = deriveChatOpsCommentOrderKey(comment('11', '2026-01-01T00:00:05Z'));
    expect(a.createdAtMs).toBe(b.createdAtMs);
    expect(compareChatOpsCommentOrderKeys(a, b)).toBeLessThan(0);
    expect(compareChatOpsCommentOrderKeys(b, a)).toBeGreaterThan(0);
    expect(compareChatOpsCommentOrderKeys(a, a)).toBe(0);
  });

  test('ids compare numerically, not lexically', () => {
    expect(compareChatOpsCommentIds('9', '10')).toBeLessThan(0);
    expect(compareChatOpsCommentIds('10', '9')).toBeGreaterThan(0);
    expect(compareChatOpsCommentIds('100', '100')).toBe(0);
  });

  test('ids past Number.MAX_SAFE_INTEGER stay distinct and ordered', () => {
    const lo = '9007199254740992'; // 2 ** 53
    const hi = '9007199254740993'; // 2 ** 53 + 1, not representable as a double
    expect(Number(lo)).toBe(Number(hi)); // a float compare would collapse them
    expect(compareChatOpsCommentIds(lo, hi)).toBeLessThan(0);
  });

  test.each([['0'], ['1'], ['42'], ['9007199254740993']])('%s is a canonical id', (id) => {
    expect(CHATOPS_COMMENT_ID_RE.test(id)).toBe(true);
  });

  test.each([['007'], ['-1'], ['1.0'], ['abc'], [''], ['1 ']])('%s is rejected as an id', (id) => {
    expect(CHATOPS_COMMENT_ID_RE.test(id)).toBe(false);
    expect(() => compareChatOpsCommentIds(id, '1')).toThrow(/canonical decimal/);
  });

  test('a timestamp without a timezone designator is rejected', () => {
    expect(() => parseChatOpsTimestamp('2026-01-01T00:00:00')).toThrow(/explicit timezone/);
  });

  test('offset and Z spellings of the same instant compare equal', () => {
    expect(parseChatOpsTimestamp('2026-01-01T09:00:00+09:00')).toBe(
      parseChatOpsTimestamp('2026-01-01T00:00:00Z'),
    );
  });

  test.each([['not-a-date'], ['2026-01-01'], ['1735689600'], ['']])(
    '%s is rejected as a timestamp',
    (value) => {
      expect(() => parseChatOpsTimestamp(value)).toThrow();
    },
  );

  test.each([
    ['2026-02-30T00:00:00Z'], // Date.parse would roll this over to March 2
    ['2026-13-01T00:00:00Z'],
    ['2026-01-00T00:00:00Z'],
    ['2026-01-01T24:00:00Z'],
    ['2026-01-01T00:60:00Z'],
    ['2026-01-01T00:00:60Z'],
    ['2026-01-01T00:00:00+25:00'],
    ['2026-01-01T00:00:00+00:60'],
  ])('%s names a calendar value that does not exist and is rejected', (value) => {
    expect(() => parseChatOpsTimestamp(value)).toThrow(/does not exist/);
  });

  test('a real leap day is accepted and a fake one is not', () => {
    expect(parseChatOpsTimestamp('2028-02-29T00:00:00Z')).toBe(Date.parse('2028-02-29T00:00:00Z'));
    expect(() => parseChatOpsTimestamp('2026-02-29T00:00:00Z')).toThrow(/does not exist/);
    expect(() => parseChatOpsTimestamp('2100-02-29T00:00:00Z')).toThrow(/does not exist/);
    expect(parseChatOpsTimestamp('2000-02-29T00:00:00Z')).toBe(Date.parse('2000-02-29T00:00:00Z'));
  });

  test('a calendar-invalid timestamp fails the window instead of being normalized', () => {
    const window = evaluateChatOpsScanWindow({
      cursor: null,
      pages: onePage([comment('1', '2026-02-30T00:00:00Z')]),
    });
    expect(window.kind).toBe('incomplete');
    expect(window.reason).toBe('malformed-timestamp');
  });

  test('a malformed comment has no position in the order', () => {
    expect(() => deriveChatOpsCommentOrderKey({ id: '07', createdAt: '2026-01-01T00:00:00Z' })).toThrow();
    expect(() => deriveChatOpsCommentOrderKey({ id: '7', createdAt: 'yesterday' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// §4/§6.1 Cursor and the since bound
// ---------------------------------------------------------------------------

describe('cursor and scan lower bound (§4, §6.1)', () => {
  test('the since bound sits one second below the cursor, at second precision', () => {
    const cursor = chatOpsCursorFromComment(comment('10', '2026-01-01T00:00:05Z'));
    expect(CHATOPS_SCAN_SINCE_MARGIN_MS).toBe(1000);
    expect(chatOpsScanSinceBound(cursor)).toBe('2026-01-01T00:00:04Z');
  });

  test('a sub-second cursor instant floors to a whole second', () => {
    const cursor = chatOpsCursorFromComment(comment('10', '2026-01-01T00:00:05.750Z'));
    expect(chatOpsScanSinceBound(cursor)).toBe('2026-01-01T00:00:04Z');
  });

  test('bootstrap has no lower bound', () => {
    expect(chatOpsScanSinceBound(null)).toBeNull();
  });

  test('a negative margin is refused', () => {
    const cursor = chatOpsCursorFromComment(comment('10', '2026-01-01T00:00:05Z'));
    expect(() => chatOpsScanSinceBound(cursor, -1)).toThrow(/non-negative/);
  });

  test('the cursor keeps createdAt verbatim alongside the parsed instant', () => {
    const cursor = chatOpsCursorFromComment(comment('10', '2026-01-01T09:00:00+09:00'));
    expect(cursor.createdAt).toBe('2026-01-01T09:00:00+09:00');
    expect(cursor.createdAtMs).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(chatOpsCursorOrderKey(cursor)).toEqual({
      createdAtMs: Date.parse('2026-01-01T00:00:00Z'),
      commentId: '10',
    });
  });

  test('the comment the cursor sits on is dropped on the next scan; its twin is not', () => {
    // Acceptance criterion: no permanent skip at a timestamp boundary.
    const first = comment('10', '2026-01-01T00:00:05Z');
    const twin = comment('11', '2026-01-01T00:00:05Z');
    const cursor = chatOpsCursorFromComment(first);

    // The loose `since` bound re-delivers both; only the twin is new.
    const window = completeWindow(onePage([first, twin]), cursor);
    expect(window.comments.map((c) => c.id)).toEqual(['11']);
    expect(window.droppedAtOrBelowCursor).toBe(1);
    expect(window.nextCursor).toEqual(chatOpsCursorFromComment(twin));
  });

  test('a window with nothing new leaves the cursor untouched (I3)', () => {
    const first = comment('10', '2026-01-01T00:00:05Z');
    const cursor = chatOpsCursorFromComment(first);
    const window = completeWindow(onePage([first]), cursor);
    expect(window.comments).toEqual([]);
    expect(window.nextCursor).toBe(cursor);
  });
});

// ---------------------------------------------------------------------------
// §5 Complete scan window
// ---------------------------------------------------------------------------

describe('scan window completeness (§5)', () => {
  test('a single end-of-list page is a complete bootstrap window', () => {
    const window = completeWindow(onePage([comment('1', '2026-01-01T00:00:01Z')]));
    expect(window.bootstrap).toBe(true);
    expect(window.pagesRead).toBe(1);
    expect(window.nextCursor.commentId).toBe('1');
  });

  test('a truncated last page fails closed and advances nothing', () => {
    const result = evaluateChatOpsScanWindow({
      cursor: null,
      pages: [{ comments: [comment('1', '2026-01-01T00:00:01Z')], hasMore: true }],
    });
    expect(result.kind).toBe('incomplete');
    expect(result.reason).toBe('pages-truncated');
    expect(result.retryable).toBe(true);
    expect(result.nextCursor).toBeUndefined();
  });

  test('a page following an end-of-list page is a caller defect', () => {
    const result = evaluateChatOpsScanWindow({
      cursor: null,
      pages: [
        { comments: [comment('1', '2026-01-01T00:00:01Z')], hasMore: false },
        { comments: [comment('2', '2026-01-01T00:00:02Z')], hasMore: false },
      ],
    });
    expect(result.reason).toBe('trailing-page-after-end');
    expect(result.retryable).toBe(false);
  });

  test('an empty page list is incomplete', () => {
    const result = evaluateChatOpsScanWindow({ cursor: null, pages: [] });
    expect(result.reason).toBe('no-pages');
  });

  test('the page guard fails closed rather than advancing over a prefix (§5.2)', () => {
    const pages = [];
    for (let i = 1; i <= 4; i += 1) {
      pages.push({ comments: [comment(String(i), `2026-01-01T00:00:0${i}Z`)], hasMore: i < 4 });
    }
    const result = evaluateChatOpsScanWindow({ cursor: null, pages, maxPages: 3 });
    expect(result.reason).toBe('page-budget-exhausted');
    expect(result.retryable).toBe(false);
    expect(CHATOPS_MAX_SCAN_PAGES).toBe(200);
  });

  test('comments spanning several pages are flattened in ascending order', () => {
    const window = completeWindow([
      { comments: [comment('1', '2026-01-01T00:00:01Z'), comment('2', '2026-01-01T00:00:02Z')], hasMore: true },
      { comments: [comment('3', '2026-01-01T00:00:03Z')], hasMore: false },
    ]);
    expect(window.comments.map((c) => c.id)).toEqual(['1', '2', '3']);
    expect(window.pagesRead).toBe(2);
  });

  test('a malformed id or timestamp anywhere fails the whole window', () => {
    const badId = evaluateChatOpsScanWindow({
      cursor: null,
      pages: onePage([comment('01', '2026-01-01T00:00:01Z')]),
    });
    expect(badId.reason).toBe('malformed-comment-id');

    const badCreated = evaluateChatOpsScanWindow({
      cursor: null,
      pages: onePage([comment('1', 'whenever')]),
    });
    expect(badCreated.reason).toBe('malformed-timestamp');

    const badUpdated = evaluateChatOpsScanWindow({
      cursor: null,
      pages: onePage([comment('1', '2026-01-01T00:00:01Z', { updatedAt: 'later' })]),
    });
    expect(badUpdated.reason).toBe('malformed-timestamp');
  });

  test('a caller-reported fetch failure uses the same incomplete shape', () => {
    const failure = chatOpsScanFetchFailure('HTTP 502 on page 2');
    expect(failure.kind).toBe('incomplete');
    expect(failure.reason).toBe('page-fetch-failed');
    expect(failure.retryable).toBe(true);
  });

  test('maxPages must be a positive integer', () => {
    expect(() =>
      evaluateChatOpsScanWindow({ cursor: null, pages: onePage([]), maxPages: 0 }),
    ).toThrow(/positive integer/);
  });
});

// ---------------------------------------------------------------------------
// §7 Overlap, duplicates, unstable ordering
// ---------------------------------------------------------------------------

describe('overlap and ordering stability (§7)', () => {
  test('overlapping pages are deduped, keeping the first copy', () => {
    const c2 = comment('2', '2026-01-01T00:00:02Z', { body: 'original' });
    const c2Again = comment('2', '2026-01-01T00:00:02Z', { body: 'edited mid-scan', updatedAt: '2026-01-01T00:00:09Z' });
    const window = completeWindow([
      { comments: [comment('1', '2026-01-01T00:00:01Z'), c2], hasMore: true },
      { comments: [c2Again, comment('3', '2026-01-01T00:00:03Z')], hasMore: false },
    ]);
    expect(window.comments.map((c) => c.id)).toEqual(['1', '2', '3']);
    expect(window.droppedDuplicates).toBe(1);
    expect(window.comments[1].body).toBe('original');
  });

  test('the same id returned with a different createdAt is an identity conflict', () => {
    const result = evaluateChatOpsScanWindow({
      cursor: null,
      pages: [
        { comments: [comment('1', '2026-01-01T00:00:01Z')], hasMore: true },
        { comments: [comment('1', '2026-01-01T00:00:07Z')], hasMore: false },
      ],
    });
    expect(result.reason).toBe('identity-conflict');
    expect(result.retryable).toBe(false);
  });

  test('a previously unseen comment behind the frontier fails closed', () => {
    const result = evaluateChatOpsScanWindow({
      cursor: null,
      pages: [
        { comments: [comment('5', '2026-01-01T00:00:05Z')], hasMore: true },
        { comments: [comment('3', '2026-01-01T00:00:03Z')], hasMore: false },
      ],
    });
    expect(result.reason).toBe('unstable-ordering');
    expect(result.retryable).toBe(true);
  });

  test('a page whose own comments are not strictly ascending fails closed', () => {
    const result = evaluateChatOpsScanWindow({
      cursor: null,
      pages: onePage([comment('5', '2026-01-01T00:00:05Z'), comment('3', '2026-01-01T00:00:03Z')]),
    });
    expect(result.reason).toBe('page-out-of-order');
    expect(result.retryable).toBe(false);
  });

  test('a page repeating an id within itself fails closed', () => {
    const c = comment('5', '2026-01-01T00:00:05Z');
    const result = evaluateChatOpsScanWindow({ cursor: null, pages: onePage([c, c]) });
    expect(result.reason).toBe('page-out-of-order');
  });

  test('a comment appended during pagination lands at the end and is picked up', () => {
    // §14.3: with ascending order a concurrent post can only appear last.
    const window = completeWindow([
      { comments: [comment('1', '2026-01-01T00:00:01Z')], hasMore: true },
      { comments: [comment('2', '2026-01-01T00:00:02Z'), comment('3', '2026-01-01T00:00:09Z')], hasMore: false },
    ]);
    expect(window.comments.map((c) => c.id)).toEqual(['1', '2', '3']);
    expect(window.nextCursor.commentId).toBe('3');
  });
});

// ---------------------------------------------------------------------------
// §8 Bootstrap
// ---------------------------------------------------------------------------

describe('bootstrap (§8)', () => {
  const existing = [
    comment('1', '2026-01-01T00:00:01Z', { body: 'ordinary discussion' }),
    comment('2', '2026-01-01T00:00:02Z', { body: '/grant --on-changes commit' }),
    comment('3', '2026-01-01T00:00:03Z', { body: '/nonsense $(rm -rf /)' }),
  ];

  test('a never-scanned scope bootstraps and reads from the beginning', () => {
    expect(CHATOPS_UNINITIALIZED_CURSOR_STATE).toEqual({ initialized: false, cursor: null });
    const window = evaluateChatOpsScanWindow({
      cursor: CHATOPS_UNINITIALIZED_CURSOR_STATE.cursor,
      initialized: CHATOPS_UNINITIALIZED_CURSOR_STATE.initialized,
      pages: onePage(existing),
    });
    expect(window.bootstrap).toBe(true);
    expect(chatOpsScanSinceBound(CHATOPS_UNINITIALIZED_CURSOR_STATE.cursor)).toBeNull();
  });

  test('every pre-existing comment is recorded, flagged, and never dispatched', () => {
    const plan = planChatOpsBootstrap(completeWindow(onePage(existing)));
    expect(plan.records.map((r) => r.commentId)).toEqual(['1', '2', '3']);
    expect(plan.records.every((r) => r.bootstrap)).toBe(true);
    expect(plan.cursor.commentId).toBe('3');
  });

  test('skipped command attempts are reported, so the skip is not silent', () => {
    const plan = planChatOpsBootstrap(completeWindow(onePage(existing)));
    expect(plan.skippedCommandAttempts).toEqual([
      { commentId: '2', author: 'alice', createdAt: '2026-01-01T00:00:02Z' },
      { commentId: '3', author: 'alice', createdAt: '2026-01-01T00:00:03Z' },
    ]);
  });

  test('an issue with no comments still marks the scope initialized (§4.1)', () => {
    const plan = planChatOpsBootstrap(completeWindow(onePage([])));
    expect(plan.cursor).toBeNull();
    expect(plan.state).toEqual({ initialized: true, cursor: null });
    expect(plan.records).toEqual([]);
    expect(plan.skippedCommandAttempts).toEqual([]);
  });

  test('a command posted after an empty bootstrap is a candidate, not backlog', () => {
    const plan = planChatOpsBootstrap(completeWindow(onePage([])));
    const posted = comment('1', '2026-01-01T00:00:01Z', { body: '/grant' });
    const window = evaluateChatOpsScanWindow({
      cursor: plan.state.cursor,
      initialized: plan.state.initialized,
      pages: onePage([posted]),
    });
    expect(window.kind).toBe('complete');
    // Not a bootstrap: the sentinel says this scope was already scanned, so
    // the comment is dispatchable rather than recorded as pre-existing.
    expect(window.bootstrap).toBe(false);
    expect(window.comments.map((c) => c.id)).toEqual(['1']);
    expect(() => planChatOpsBootstrap(window)).toThrow(/no prior cursor/);
    expect(window.nextState).toEqual({ initialized: true, cursor: window.nextCursor });
  });

  test('an uninitialized scope with a cursor position is refused as contradictory', () => {
    expect(() =>
      evaluateChatOpsScanWindow({
        cursor: chatOpsCursorFromComment(existing[0]),
        initialized: false,
        pages: onePage(existing),
      }),
    ).toThrow(/uninitialized/);
  });

  test('every complete window reports an initialized next state', () => {
    const empty = completeWindow(onePage([]));
    expect(empty.nextState).toEqual({ initialized: true, cursor: null });
    const full = completeWindow(onePage(existing));
    expect(full.nextState).toEqual({ initialized: true, cursor: full.nextCursor });
  });

  test('a command posted after bootstrap is a candidate', () => {
    const plan = planChatOpsBootstrap(completeWindow(onePage(existing)));
    const fresh = comment('4', '2026-01-01T00:01:00Z', { body: '/grant' });
    const window = completeWindow(onePage([...existing, fresh]), plan.cursor);
    expect(window.comments.map((c) => c.id)).toEqual(['4']);
  });

  test('planning a bootstrap from a non-bootstrap window is refused', () => {
    const cursor = chatOpsCursorFromComment(existing[0]);
    const window = completeWindow(onePage(existing), cursor);
    expect(() => planChatOpsBootstrap(window)).toThrow(/no prior cursor/);
  });
});

// ---------------------------------------------------------------------------
// §9 First-seen records
// ---------------------------------------------------------------------------

describe('first-seen records (§9)', () => {
  const c = comment('7', '2026-01-01T00:00:07Z', { body: '/grant' });

  test('a record captures the immutable first-seen fields', () => {
    const record = buildChatOpsFirstSeenRecord(c, { bootstrap: false });
    expect(record).toMatchObject({
      commentId: '7',
      author: 'alice',
      createdAt: '2026-01-01T00:00:07Z',
      updatedAt: '2026-01-01T00:00:07Z',
      body: '/grant',
      bodyLength: 6,
      bootstrap: false,
    });
    expect(record.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('an over-long body is not stored but is still hashed', () => {
    const big = comment('8', '2026-01-01T00:00:08Z', {
      body: 'x'.repeat(MAX_CHATOPS_COMMENT_BODY_CHARS + 1),
    });
    const record = buildChatOpsFirstSeenRecord(big, { bootstrap: false });
    expect(record.body).toBeNull();
    expect(record.bodyLength).toBe(MAX_CHATOPS_COMMENT_BODY_CHARS + 1);
    expect(record.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a body at exactly the limit is stored', () => {
    const atLimit = comment('9', '2026-01-01T00:00:09Z', {
      body: 'x'.repeat(MAX_CHATOPS_COMMENT_BODY_CHARS),
    });
    expect(buildChatOpsFirstSeenRecord(atLimit, { bootstrap: false }).body).not.toBeNull();
  });

  test('a malformed comment cannot become a record', () => {
    expect(() => buildChatOpsFirstSeenRecord(comment('0x1', '2026-01-01T00:00:01Z'), { bootstrap: false })).toThrow();
    expect(() => buildChatOpsFirstSeenRecord(comment('1', '2026'), { bootstrap: false })).toThrow();
  });

  test('re-observing an unchanged comment reconciles as unchanged', () => {
    const record = buildChatOpsFirstSeenRecord(c, { bootstrap: false });
    expect(reconcileChatOpsFirstSeen(record, c)).toEqual({ kind: 'unchanged' });
  });

  test('an edit after first observation is reported, never written back', () => {
    const record = buildChatOpsFirstSeenRecord(c, { bootstrap: false });
    const edited = { ...c, body: '/grant --confirm-discard', updatedAt: '2026-01-01T00:05:00Z' };
    const result = reconcileChatOpsFirstSeen(record, edited);
    expect(result.kind).toBe('edited-after-first-seen');
    // The stored record is untouched: #777 §6's first-seen body still wins.
    expect(record.body).toBe('/grant');
  });

  test('a body change with an unchanged updatedAt is still an edit', () => {
    const record = buildChatOpsFirstSeenRecord(c, { bootstrap: false });
    const result = reconcileChatOpsFirstSeen(record, { ...c, body: '/grant --allow-unexpected' });
    expect(result.kind).toBe('edited-after-first-seen');
  });

  test.each([
    ['createdAt', { createdAt: '2026-01-01T00:00:08Z' }],
    ['author', { author: 'mallory' }],
  ])('a changed %s is an identity conflict, not an edit', (_field, overrides) => {
    const record = buildChatOpsFirstSeenRecord(c, { bootstrap: false });
    const result = reconcileChatOpsFirstSeen(record, { ...c, ...overrides });
    expect(result.kind).toBe('identity-conflict');
  });

  test('reconciling two different comments is a programming error', () => {
    const record = buildChatOpsFirstSeenRecord(c, { bootstrap: false });
    expect(() => reconcileChatOpsFirstSeen(record, comment('8', '2026-01-01T00:00:08Z'))).toThrow(
      /different comments/,
    );
  });
});

// ---------------------------------------------------------------------------
// §10 Candidate selection
// ---------------------------------------------------------------------------

describe('candidate selection (§10)', () => {
  test('comments with a first-seen record are not re-offered', () => {
    const window = completeWindow(
      onePage([
        comment('1', '2026-01-01T00:00:01Z'),
        comment('2', '2026-01-01T00:00:02Z'),
        comment('3', '2026-01-01T00:00:03Z'),
      ]),
    );
    const recorded = new Set(['1', '3']);
    const selection = selectChatOpsCandidates(window, (id) => recorded.has(id));
    expect(selection.candidates.map((c) => c.id)).toEqual(['2']);
    expect(selection.alreadyObserved).toEqual(['1', '3']);
  });

  test('a scan re-run after a crash between records and cursor advance offers nothing twice', () => {
    // §14.5: records landed, the cursor did not. The re-scan sees them again.
    const comments = [comment('1', '2026-01-01T00:00:01Z'), comment('2', '2026-01-01T00:00:02Z')];
    const first = completeWindow(onePage(comments));
    const recorded = new Set(first.comments.map((c) => c.id));
    const rerun = completeWindow(onePage(comments)); // cursor still null
    expect(rerun.comments.map((c) => c.id)).toEqual(['1', '2']);
    expect(selectChatOpsCandidates(rerun, (id) => recorded.has(id)).candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §5.1 Markers across page boundaries
// ---------------------------------------------------------------------------

describe('authenticated marker discovery (§5.1)', () => {
  const automation = ['loop-bot'];

  test('a marker on the page after its command is in the same window', () => {
    const window = completeWindow([
      {
        comments: [
          comment('1', '2026-01-01T00:00:01Z', { body: 'discussion' }),
          comment('2', '2026-01-01T00:00:02Z', { body: '/grant' }),
        ],
        hasMore: true,
      },
      {
        comments: [
          comment('3', '2026-01-01T00:00:03Z', {
            author: 'loop-bot',
            body: '<!-- chatops-claimed:2 -->',
          }),
          comment('4', '2026-01-01T00:00:04Z', {
            author: 'loop-bot',
            body: '<!-- chatops-ack:2:executed -->',
          }),
        ],
        hasMore: false,
      },
    ]);
    const index = indexAuthenticatedChatOpsMarkers(window.comments, automation);
    expect(index.claimed.has('2')).toBe(true);
    expect(index.acked.get('2')).toBe('executed');
    expect([...index.markerCommentIds].sort()).toEqual(['3', '4']);
  });

  test('a look-alike marker from a non-automation author is not indexed', () => {
    const window = completeWindow(
      onePage([
        comment('1', '2026-01-01T00:00:01Z', { body: '/grant' }),
        comment('2', '2026-01-01T00:00:02Z', {
          author: 'mallory',
          body: '<!-- chatops-ack:1:executed -->',
        }),
      ]),
    );
    const index = indexAuthenticatedChatOpsMarkers(window.comments, automation);
    expect(index.acked.size).toBe(0);
    expect(index.markerCommentIds.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §11 Fail-closed
// ---------------------------------------------------------------------------

describe('fail-closed advancement (§11, I4)', () => {
  const cursor = chatOpsCursorFromComment(comment('1', '2026-01-01T00:00:01Z'));
  const cases = [
    ['no-pages', []],
    ['pages-truncated', [{ comments: [comment('2', '2026-01-01T00:00:02Z')], hasMore: true }]],
    [
      'trailing-page-after-end',
      [
        { comments: [comment('2', '2026-01-01T00:00:02Z')], hasMore: false },
        { comments: [comment('3', '2026-01-01T00:00:03Z')], hasMore: false },
      ],
    ],
    ['malformed-comment-id', onePage([comment('02', '2026-01-01T00:00:02Z')])],
    ['malformed-timestamp', onePage([comment('2', 'soon')])],
    [
      'page-out-of-order',
      onePage([comment('3', '2026-01-01T00:00:03Z'), comment('2', '2026-01-01T00:00:02Z')]),
    ],
    [
      'unstable-ordering',
      [
        { comments: [comment('5', '2026-01-01T00:00:05Z')], hasMore: true },
        { comments: [comment('4', '2026-01-01T00:00:04Z')], hasMore: false },
      ],
    ],
    [
      'identity-conflict',
      [
        { comments: [comment('2', '2026-01-01T00:00:02Z')], hasMore: true },
        { comments: [comment('2', '2026-01-01T00:00:06Z')], hasMore: false },
      ],
    ],
  ];

  test.each(cases)('%s carries no cursor, comments, or records', (reason, pages) => {
    const result = evaluateChatOpsScanWindow({ cursor, pages });
    expect(result.kind).toBe('incomplete');
    expect(result.reason).toBe(reason);
    expect(result.nextCursor).toBeUndefined();
    expect(result.comments).toBeUndefined();
    expect(typeof result.detail).toBe('string');
    expect(result.detail.length).toBeGreaterThan(0);
    expect(typeof result.retryable).toBe('boolean');
  });

  test('only transient conditions are marked retryable', () => {
    const retryable = new Set(['pages-truncated', 'unstable-ordering']);
    for (const [reason, pages] of cases) {
      const result = evaluateChatOpsScanWindow({ cursor, pages });
      expect(result.retryable).toBe(retryable.has(reason));
    }
    expect(chatOpsScanFetchFailure('boom').retryable).toBe(true);
  });
});
