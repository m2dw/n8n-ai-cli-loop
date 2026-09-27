/**
 * The Gitea binding of the ChatOps comment port (issue #1032).
 *
 * `chatops-comment-cursor.test.js` pins what a *set of pages* has to look like
 * before a window counts as complete; this file pins the half that produces
 * those pages from a real Gitea REST shape, and the one place the two adapters
 * legitimately differ:
 *
 *   - a self-hosted Gitea clamps the page size, so `hasMore` may only be
 *     derived from an EMPTY page — deriving it from a short one would advance
 *     the cursor past comments nothing ever read;
 *   - every provider failure (auth, rate limit, 5xx, a dead connection) is
 *     *reported*, never thrown, so the pass leaves the window unproven and
 *     retries instead of crashing mid-dispatch;
 *   - the API token never reaches an error string, even when the instance
 *     echoes it back in a response body.
 *
 * Everything runs against a fake synchronous transport — no live Gitea instance
 * and no subprocess — with one deliberate exception: the last block exercises
 * the port's real default transport against a local socket that never answers,
 * because "the scheduled pass cannot block forever" is only provable there.
 */
import { createServer } from 'node:http';
import { GiteaChatOpsCommentPort } from '../dist/providers/gitea/gitea-chatops-comment-port.js';
import { fetchChatOpsScanPages } from '../dist/core/chatops-comment-port.js';
import { evaluateChatOpsScanWindow } from '../dist/core/chatops-comment-cursor.js';

/** A fake synchronous HTTP transport: records requests, returns queued responses. */
function fakeHttp(responses) {
  const calls = [];
  let i = 0;
  const fn = (req) => {
    calls.push(req);
    const next = responses[i] ?? { status: 599, statusText: 'unexpected call', body: '' };
    i += 1;
    if (typeof next === 'function') return next(req);
    return next;
  };
  fn.calls = calls;
  return fn;
}

const TOKEN = '0123456789abcdef0123456789abcdef01234567'; // 40-char hex (Gitea PAT shape)

const BASE = {
  baseUrl: 'https://gitea.example.com',
  owner: 'ai-private',
  repo: 'work-items',
  token: TOKEN,
};

function ok(body) {
  return {
    status: 200,
    statusText: 'OK',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/** One Gitea comment as its REST API returns it. */
function comment(id, overrides = {}) {
  return {
    id,
    body: `body ${id}`,
    user: { login: 'alice' },
    created_at: `2026-03-01T10:0${id % 10}:00Z`,
    updated_at: `2026-03-01T10:0${id % 10}:00Z`,
    ...overrides,
  };
}

const PAGE = { issueNumber: 42, since: null, page: 1, perPage: 100 };

// ---------------------------------------------------------------------------
// listComments — request shape
// ---------------------------------------------------------------------------

describe('GiteaChatOpsCommentPort — listComments request', () => {
  test('hits the issue-comments endpoint with page/limit and the token header', async () => {
    const http = fakeHttp([ok([comment(1)])]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    await port.listComments({ ...PAGE, page: 3, perPage: 50 });

    const req = http.calls[0];
    expect(req.method).toBe('GET');
    expect(req.url).toContain('/api/v1/repos/ai-private/work-items/issues/42/comments');
    expect(req.url).toContain('page=3');
    expect(req.url).toContain('limit=50');
    // The token travels in the header only, under Gitea's `token` scheme —
    // never on a query string, where it would land in the instance's access log.
    expect(req.headers.Authorization).toBe(`token ${TOKEN}`);
    expect(req.url).not.toContain(TOKEN);
  });

  test('forwards `since` when the cursor supplies one, and omits it otherwise', async () => {
    const http = fakeHttp([ok([]), ok([])]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    await port.listComments({ ...PAGE, since: '2026-03-01T09:59:59Z' });
    await port.listComments({ ...PAGE, since: null });

    // Verbatim RFC 3339, NOT epoch seconds. Gitea declares this parameter
    // `type: string, format: date-time` and parses it with
    // `time.Parse(time.RFC3339, ...)` before converting to `updated_unix`; the
    // integer its internal name suggests fails that parse and takes the page
    // request to 422, which would make every scan a permanent
    // `page-fetch-failed` instead of a bounded window. `chatOpsScanSinceBound`
    // already emits exactly this spelling, so nothing is reformatted here.
    expect(http.calls[0].url).toContain('since=2026-03-01T09%3A59%3A59Z');
    expect(http.calls[0].url).not.toMatch(/since=\d+(&|$)/);
    expect(http.calls[1].url).not.toContain('since=');
  });

  test('honours a non-default apiPath', async () => {
    const http = fakeHttp([ok([])]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, apiPath: '/gitea/api/v1', http });

    await port.listComments(PAGE);

    expect(http.calls[0].url).toContain('/gitea/api/v1/repos/ai-private/work-items/issues/42/comments');
  });
});

// ---------------------------------------------------------------------------
// listComments — conversion and the end-of-list signal
// ---------------------------------------------------------------------------

describe('GiteaChatOpsCommentPort — listComments conversion', () => {
  test('converts a Gitea comment to the observed shape, timestamps verbatim', async () => {
    const http = fakeHttp([
      ok([
        {
          id: 7,
          body: '/grant --disposition commit',
          user: { login: 'alice' },
          created_at: '2026-03-01T10:00:00Z',
          // A genuinely edited comment: the two spellings must stay distinct,
          // because #777 §6 reads their inequality as "edited".
          updated_at: '2026-03-01T10:05:00+09:00',
        },
      ]),
    ]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const result = await port.listComments(PAGE);

    expect(result.ok).toBe(true);
    expect(result.page.comments).toEqual([
      {
        id: '7',
        author: 'alice',
        body: '/grant --disposition commit',
        createdAt: '2026-03-01T10:00:00Z',
        updatedAt: '2026-03-01T10:05:00+09:00',
      },
    ]);
  });

  test('a numeric id becomes the canonical decimal string the cursor requires', async () => {
    const http = fakeHttp([ok([comment(101)])]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const result = await port.listComments(PAGE);

    expect(result.page.comments[0].id).toBe('101');
  });

  test('an int64 id past 2^53 survives the decode exactly', async () => {
    // Gitea ids are int64. `JSON.parse` would round 9007199254740993 to
    // ...992 — a DIFFERENT comment's identity — and the cursor, the ledger row
    // and the acknowledgement marker would all then name the wrong comment.
    // The payload is handed over as raw text so the rounding cannot happen in
    // the fixture instead of in the adapter.
    const raw =
      '[{"id":9007199254740993,"body":"b","user":{"login":"alice"},' +
      '"created_at":"2026-03-01T10:00:00Z","updated_at":"2026-03-01T10:00:00Z"},' +
      '{"id":9007199254740992,"body":"b","user":{"login":"alice"},' +
      '"created_at":"2026-03-01T10:00:00Z","updated_at":"2026-03-01T10:00:00Z"}]';
    const http = fakeHttp([ok(raw)]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const result = await port.listComments(PAGE);

    expect(result.ok).toBe(true);
    expect(result.page.comments.map((c) => c.id)).toEqual([
      '9007199254740993',
      '9007199254740992',
    ]);
  });

  test('ordinary numbers, floats and digits inside strings are decoded unchanged', async () => {
    // The precision pre-pass rewrites only oversized integer literals: a body
    // that merely contains digits, and a nested float, must survive verbatim.
    const raw =
      '[{"id":101,"body":"deploy 9007199254740993 at 1.5\\" scale","user":{"login":"alice"},' +
      '"created_at":"2026-03-01T10:00:00Z","updated_at":"2026-03-01T10:00:00Z",' +
      '"weight":-1.25e3}]';
    const http = fakeHttp([ok(raw)]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const result = await port.listComments(PAGE);

    expect(result.ok).toBe(true);
    expect(result.page.comments[0].id).toBe('101');
    expect(result.page.comments[0].body).toBe('deploy 9007199254740993 at 1.5" scale');
  });

  test('a non-empty page reports hasMore even when it is shorter than requested', async () => {
    // The regression this pins: a self-hosted Gitea clamps `limit` to its own
    // max page size, so a FULL page routinely comes back short. Reading that as
    // the end of the list would advance the cursor over every comment behind it.
    const http = fakeHttp([ok([comment(1), comment(2)])]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const result = await port.listComments({ ...PAGE, perPage: 100 });

    expect(result.page.comments).toHaveLength(2);
    expect(result.page.hasMore).toBe(true);
  });

  test('an empty page is the only end-of-list signal', async () => {
    const http = fakeHttp([ok([])]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const result = await port.listComments(PAGE);

    expect(result.page.comments).toEqual([]);
    expect(result.page.hasMore).toBe(false);
  });

  test('a comment with no author fails the page rather than defaulting one', async () => {
    // The author is the entire trust gate (#777 §5): a comment that cannot be
    // attributed must not be placed in the window at all.
    const http = fakeHttp([ok([comment(1), { ...comment(2), user: null }])]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const result = await port.listComments(PAGE);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/comment 2 carries no author login/);
  });

  test('a comment with no created_at/updated_at pair fails the page', async () => {
    const http = fakeHttp([ok([{ ...comment(3), updated_at: undefined }])]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const result = await port.listComments(PAGE);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/comment 3 carries no created_at\/updated_at pair/);
  });

  test('a missing body becomes an empty string, not a dropped comment', async () => {
    const http = fakeHttp([ok([{ ...comment(4), body: null }])]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const result = await port.listComments(PAGE);

    expect(result.ok).toBe(true);
    expect(result.page.comments[0].body).toBe('');
  });

  test('non-JSON and non-array payloads are reported, not thrown', async () => {
    const http = fakeHttp([ok('<html>502 Bad Gateway</html>'), ok({ message: 'nope' })]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const nonJson = await port.listComments(PAGE);
    const nonArray = await port.listComments(PAGE);

    expect(nonJson.ok).toBe(false);
    expect(nonJson.error).toMatch(/non-JSON output/);
    expect(nonArray.ok).toBe(false);
    expect(nonArray.error).toMatch(/non-array payload/);
  });
});

// ---------------------------------------------------------------------------
// listComments — provider failures
// ---------------------------------------------------------------------------

describe('GiteaChatOpsCommentPort — provider failures', () => {
  test.each([
    ['authentication', 401, 'Unauthorized'],
    ['authorization', 403, 'Forbidden'],
    ['rate limit', 429, 'Too Many Requests'],
    ['provider', 500, 'Internal Server Error'],
  ])('%s failures are reported with their status, not thrown', async (_label, status, statusText) => {
    const http = fakeHttp([{ status, statusText, body: '' }]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const result = await port.listComments(PAGE);

    expect(result.ok).toBe(false);
    expect(result.error).toContain(`HTTP ${status}`);
    expect(result.error).toContain(statusText);
  });

  test('a transport-level failure is reported as a status-0 envelope', async () => {
    const http = fakeHttp([
      () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:3000');
      },
    ]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const result = await port.listComments(PAGE);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 0');
    expect(result.error).toContain('ECONNREFUSED');
  });

  test('an unusable base URL is reported rather than thrown out of the scan', async () => {
    const http = fakeHttp([ok([])]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, baseUrl: 'not a url', http });

    const result = await port.listComments(PAGE);

    expect(result.ok).toBe(false);
    expect(http.calls).toHaveLength(0);
  });

  test('the API token never reaches an error string, even when echoed back', async () => {
    const http = fakeHttp([
      { status: 401, statusText: 'Unauthorized', body: `token ${TOKEN} is invalid` },
    ]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const result = await port.listComments(PAGE);

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain(TOKEN);
    expect(result.error).toContain('[redacted]');
  });

  /**
   * A response body whose echoed credential straddles the 200-character
   * error-detail cutoff.
   *
   * Redaction has to run on the COMPLETE body and bound it afterwards: every
   * redaction rule matches a *whole* credential, so a body cut mid-token stops
   * matching all of them and the surviving prefix reaches the pass note. Here
   * the token is embedded bare — no `token`/`Bearer` prefix to fall back on —
   * and starts at character 174, so slicing first would leave `key=012345…`, a
   * 26-hex fragment that matches neither the configured secret nor the 40-hex
   * pattern. The `TAIL_MARKER` assertions prove the bound is still applied,
   * just second.
   */
  const straddling = (tail) =>
    `${'x'.repeat(170)}key=${TOKEN} ${tail} ${'y'.repeat(40)} TAIL_MARKER`;

  test('a token straddling the error-detail cutoff is redacted whole, not sliced', async () => {
    const http = fakeHttp([
      { status: 401, statusText: 'Unauthorized', body: straddling('is invalid') },
    ]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const result = await port.listComments(PAGE);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('[redacted]');
    expect(result.error).not.toContain(TOKEN);
    // No fragment of the credential, however short, may survive.
    expect(result.error).not.toContain(TOKEN.slice(0, 4));
    expect(result.error).not.toContain('TAIL_MARKER');
  });

  test('the same ordering holds on the non-JSON branch', async () => {
    // Status 200 with a body that cannot parse: this reaches the separate
    // error string built around the JSON failure, which bounds the body too.
    const http = fakeHttp([{ status: 200, statusText: 'OK', body: straddling('<html>') }]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const result = await port.listComments(PAGE);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('non-JSON');
    expect(result.error).toContain('[redacted]');
    expect(result.error).not.toContain(TOKEN);
    expect(result.error).not.toContain(TOKEN.slice(0, 4));
    expect(result.error).not.toContain('TAIL_MARKER');
  });
});

// ---------------------------------------------------------------------------
// postComment
// ---------------------------------------------------------------------------

describe('GiteaChatOpsCommentPort — postComment', () => {
  test('posts the marker body verbatim, with nothing appended', async () => {
    const http = fakeHttp([{ status: 201, statusText: 'Created', body: '{"id":9}' }]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });
    const marker = '<!-- chatops:ack v1 comment=7 -->';

    const result = await port.postComment(42, marker);

    expect(result).toEqual({ ok: true });
    const req = http.calls[0];
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/api/v1/repos/ai-private/work-items/issues/42/comments');
    // Byte-for-byte: an adapter that wrapped or annotated the body would
    // destroy every marker's authenticity (docs/chatops-result-contract.md §5.1).
    expect(JSON.parse(req.body)).toEqual({ body: marker });
    expect(req.headers['Content-Type']).toBe('application/json');
  });

  test('a failed post is reported, redacted, and never thrown', async () => {
    const http = fakeHttp([
      { status: 403, statusText: 'Forbidden', body: `token ${TOKEN} cannot write` },
      () => {
        throw new Error('socket hang up');
      },
    ]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const denied = await port.postComment(42, 'body');
    const dropped = await port.postComment(42, 'body');

    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('HTTP 403');
    expect(denied.error).not.toContain(TOKEN);
    // A *thrown* post would escape the dispatch attempt mid-flight instead of
    // leaving the ledger row `dispatching` for the next pass to reconcile.
    expect(dropped.ok).toBe(false);
    expect(dropped.error).toContain('socket hang up');
  });
});

// ---------------------------------------------------------------------------
// The port under the bounded page walk (the shape the pass actually uses)
// ---------------------------------------------------------------------------

describe('GiteaChatOpsCommentPort — bounded page walk', () => {
  test('walks clamped pages to the empty page and proves one complete window', async () => {
    // Two short "full" pages from a clamped instance, then the empty page that
    // ends the list. Stopping at page 1 would have skipped comments 3 and 4.
    const http = fakeHttp([ok([comment(1), comment(2)]), ok([comment(3), comment(4)]), ok([])]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const fetched = await fetchChatOpsScanPages(port, 42, null, { perPage: 100 });

    expect(fetched.ok).toBe(true);
    expect(fetched.pages).toHaveLength(3);
    const window = evaluateChatOpsScanWindow({ cursor: null, pages: fetched.pages });
    expect(window.kind).toBe('complete');
    expect(window.comments.map((c) => c.id)).toEqual(['1', '2', '3', '4']);
    expect(window.nextCursor.commentId).toBe('4');
    expect(http.calls.map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2', '3']);
  });

  test('a mid-walk failure leaves the window incomplete, so nothing may advance', async () => {
    const http = fakeHttp([
      ok([comment(1), comment(2)]),
      { status: 429, statusText: 'Too Many Requests', body: '' },
    ]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const fetched = await fetchChatOpsScanPages(port, 42, null, { perPage: 100 });

    expect(fetched.ok).toBe(false);
    expect(fetched.incomplete.kind).toBe('incomplete');
    expect(fetched.incomplete.reason).toBe('page-fetch-failed');
    // Retryable: the next pass reads the same window again from the same cursor.
    expect(fetched.incomplete.retryable).toBe(true);
  });

  test('an instance that never returns an empty page exhausts the budget rather than truncating', async () => {
    // A Gitea that ignored `page` entirely would keep answering with the same
    // non-empty list. That must fail the window closed, not silently advance
    // the cursor over a prefix.
    const http = fakeHttp(Array.from({ length: 6 }, () => ok([comment(1)])));
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const fetched = await fetchChatOpsScanPages(port, 42, null, { perPage: 100, maxPages: 3 });

    expect(fetched.ok).toBe(true);
    expect(fetched.pages).toHaveLength(3);
    const window = evaluateChatOpsScanWindow({ cursor: null, pages: fetched.pages, maxPages: 3 });
    expect(window.kind).toBe('incomplete');
    expect(window.reason).toBe('pages-truncated');
  });

  test('an empty comment list is one complete window with nothing in it', async () => {
    const http = fakeHttp([ok([])]);
    const port = new GiteaChatOpsCommentPort({ ...BASE, http });

    const fetched = await fetchChatOpsScanPages(port, 42, null, { perPage: 100 });
    const window = evaluateChatOpsScanWindow({ cursor: null, pages: fetched.pages });

    expect(http.calls).toHaveLength(1);
    expect(window.kind).toBe('complete');
    expect(window.comments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Default transport — the pass is bounded
// ---------------------------------------------------------------------------

describe('GiteaChatOpsCommentPort — default transport bound', () => {
  /**
   * A ChatOps pass is scheduled, so every failure has to become a *reported*
   * pass result the next invocation retries from. A Gitea that accepts the TCP
   * connection and then never answers is the case the shared unbounded
   * transport cannot survive: `spawnSync` would block forever and the scan step
   * would neither fail nor complete. The port therefore builds its own bounded
   * transport, and this test is the only one in the file that runs the real
   * one.
   *
   * The listener never writes a response — it does not even need a request
   * handler, since `spawnSync` blocks this process's event loop while the child
   * waits. The kernel completes the handshake from the backlog; nothing more
   * ever arrives.
   */
  test('a server that accepts but never answers is reported, not waited on forever', async () => {
    const server = createServer(() => {
      /* deliberately never responds */
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port: tcpPort } = server.address();
    try {
      const port = new GiteaChatOpsCommentPort({
        ...BASE,
        baseUrl: `http://127.0.0.1:${tcpPort}`,
        timeoutMs: 1_000,
      });

      const started = Date.now();
      const result = await port.listComments(PAGE);
      const elapsed = Date.now() - started;

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/timed out after 1000ms/);
      // HTTP 0 is the synthetic transport-failure envelope; `fetchChatOpsScanPages`
      // turns it into one retryable `page-fetch-failed` window that advances
      // no cursor.
      expect(result.error).toMatch(/HTTP 0/);
      expect(elapsed).toBeLessThan(20_000);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 30_000);
});
