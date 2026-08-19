import {
  GiteaWorkItemProvider,
  redactGiteaSecrets,
  resolveGiteaToken,
  buildGiteaApiUrl,
  GiteaAuthConfigError,
} from '../dist/index.js';

// A fake synchronous HTTP transport: records every request and returns queued
// responses in order. No live Gitea server is involved.
function fakeHttp(responses) {
  const calls = [];
  let i = 0;
  const fn = (req) => {
    calls.push(req);
    const r = responses[i] ?? { status: 599, statusText: 'unexpected call', body: '' };
    i++;
    return r;
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
  return { status: 200, statusText: 'OK', body: typeof body === 'string' ? body : JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// listCandidateItems
// ---------------------------------------------------------------------------

describe('GiteaWorkItemProvider — listCandidateItems', () => {
  test('lists open issues, excludes PRs, flattens labels, and hits the right endpoint', () => {
    const http = fakeHttp([
      ok([
        { number: 5, title: 'Impl A', html_url: 'https://gitea.example.com/ai-private/work-items/issues/5', body: 'do it', labels: [{ id: 1, name: 'agent:claude' }, { id: 2, name: 'status:needs-implementation' }] },
        { number: 6, title: 'A PR', html_url: 'u', labels: [], pull_request: { merged: false } },
        { number: 7, title: 'No body', html_url: 'u7', labels: null },
      ]),
      // A non-empty page is never assumed final (the server may clamp the page
      // size), so the listing pages once more to an empty page to confirm the end.
      ok([]),
    ]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });

    const items = provider.listCandidateItems(50);

    expect(items).toEqual([
      { number: 5, title: 'Impl A', url: 'https://gitea.example.com/ai-private/work-items/issues/5', labels: ['agent:claude', 'status:needs-implementation'], body: 'do it' },
      { number: 7, title: 'No body', url: 'u7', labels: [] },
    ]);
    const req = http.calls[0];
    expect(req.method).toBe('GET');
    expect(req.url).toContain('/api/v1/repos/ai-private/work-items/issues');
    expect(req.url).toContain('type=issues');
    expect(req.url).toContain('state=open');
    expect(req.url).toContain('limit=50');
    // Token rides in the Authorization header only (Gitea `token` scheme).
    expect(req.headers.Authorization).toBe(`token ${TOKEN}`);
  });

  test('bounds an over-long issue body', () => {
    const http = fakeHttp([ok([{ number: 1, title: 't', html_url: 'u', labels: [], body: 'x'.repeat(50) }]), ok([])]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http, maxBodyChars: 10 });
    const [item] = provider.listCandidateItems(10);
    expect(item.body.startsWith('xxxxxxxxxx')).toBe(true);
    expect(item.body.endsWith('…(truncated)')).toBe(true);
    expect(item.body.length).toBeLessThan(50);
  });

  test('throws on a non-2xx response (fail closed)', () => {
    const http = fakeHttp([{ status: 401, statusText: 'Unauthorized', body: 'bad token' }]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    expect(() => provider.listCandidateItems(10)).toThrow(/Gitea issue list failed \(HTTP 401\)/);
  });

  test('keeps paging after a short page and stops on an empty page (page-cap safe)', () => {
    // A page shorter than the requested size is NOT proof the list is exhausted: a
    // self-hosted Gitea whose max page size is below the requested limit returns a
    // short *full* page even when more issues remain. Termination keys on an empty
    // page, so a short first page still triggers a page=2 fetch that confirms the
    // end. Were a short page treated as the last, eligible issues on later pages
    // would be silently dropped.
    const http = fakeHttp([ok([{ number: 1, title: 't', html_url: 'u', labels: [] }]), ok([])]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    expect(provider.listCandidateItems(50)).toHaveLength(1);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0].url).toContain('page=1');
    expect(http.calls[1].url).toContain('page=2');
  });

  test('paginates past a full first page and includes later candidates, capped at limit', () => {
    // Gitea caps a page at 50; a full first page must trigger page=2. With a
    // requested limit above the page size, an eligible issue on the second page
    // must still be collected, and the result must not exceed the requested limit.
    const firstPage = Array.from({ length: 50 }, (_, k) => ({ number: k + 1, title: `t${k + 1}`, html_url: `u${k + 1}`, labels: [] }));
    const secondPage = Array.from({ length: 50 }, (_, k) => ({ number: 51 + k, title: `t${51 + k}`, html_url: `u${51 + k}`, labels: [] }));
    const http = fakeHttp([ok(firstPage), ok(secondPage)]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });

    const items = provider.listCandidateItems(55);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0].url).toContain('page=1');
    expect(http.calls[1].url).toContain('page=2');
    expect(items).toHaveLength(55);
    // A candidate that only exists on the second page is enqueued…
    expect(items.some((i) => i.number === 55)).toBe(true);
    // …and the result is capped at the requested limit.
    expect(items.some((i) => i.number === 56)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getItem
// ---------------------------------------------------------------------------

describe('GiteaWorkItemProvider — getItem', () => {
  test('returns the label set', () => {
    const http = fakeHttp([ok({ number: 3, labels: [{ id: 1, name: 'status:needs-review' }] })]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    expect(provider.getItem(3)).toEqual({ ok: true, value: { labels: ['status:needs-review'] } });
    expect(http.calls[0].url).toContain('/repos/ai-private/work-items/issues/3');
  });

  test('returns ok:false on failure', () => {
    const http = fakeHttp([{ status: 404, statusText: 'Not Found', body: '' }]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    expect(provider.getItem(3).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// commentItem
// ---------------------------------------------------------------------------

describe('GiteaWorkItemProvider — commentItem', () => {
  test('posts a JSON comment body to the comments endpoint', () => {
    const http = fakeHttp([{ status: 201, statusText: 'Created', body: '{}' }]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    expect(provider.commentItem(10, 'phase complete')).toEqual({ ok: true });
    const req = http.calls[0];
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/repos/ai-private/work-items/issues/10/comments');
    expect(JSON.parse(req.body)).toEqual({ body: 'phase complete' });
    expect(req.headers['Content-Type']).toBe('application/json');
  });

  test('returns ok:false on failure', () => {
    const http = fakeHttp([{ status: 500, statusText: 'err', body: 'boom' }]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    expect(provider.commentItem(10, 'x').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transitionItem (Gitea label-id semantics)
// ---------------------------------------------------------------------------

const LABELS = [{ id: 7, name: 'ai:active' }, { id: 8, name: 'ai:blocked' }];

describe('GiteaWorkItemProvider — transitionItem', () => {
  test('add-label resolves the label id then posts it', () => {
    const http = fakeHttp([ok(LABELS), { status: 200, statusText: 'OK', body: '[]' }]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    expect(provider.transitionItem(5, { kind: 'add-label', label: 'ai:active' })).toEqual({ ok: true });
    expect(http.calls[0].url).toContain('/repos/ai-private/work-items/labels');
    expect(http.calls[1].method).toBe('POST');
    expect(http.calls[1].url).toContain('/issues/5/labels');
    expect(JSON.parse(http.calls[1].body)).toEqual({ labels: [7] });
  });

  test('add-label fails clearly when the workflow label does not exist on the repo', () => {
    // The lookup pages to an empty page to *prove* the label is absent (a short
    // page alone is not proof when the server can clamp the page size).
    const http = fakeHttp([ok(LABELS), ok([])]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    const result = provider.transitionItem(5, { kind: 'add-label', label: 'ai:missing' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Gitea label not found: "ai:missing"/);
    // The label lookup exhausts the list (page + empty page); no mutation attempted.
    expect(http.calls).toHaveLength(2);
  });

  test('remove-label resolves the id then DELETEs it', () => {
    const http = fakeHttp([ok(LABELS), { status: 204, statusText: 'No Content', body: '' }]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    expect(provider.transitionItem(5, { kind: 'remove-label', label: 'ai:blocked' })).toEqual({ ok: true });
    expect(http.calls[1].method).toBe('DELETE');
    expect(http.calls[1].url).toContain('/issues/5/labels/8');
  });

  test('remove-label is a no-op success when the label is absent from the repo', () => {
    // The lookup pages to an empty page to prove absence; with no matching label
    // the removal is a no-op success and no DELETE is issued.
    const http = fakeHttp([ok(LABELS), ok([])]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    expect(provider.transitionItem(5, { kind: 'remove-label', label: 'ai:gone' })).toEqual({ ok: true, alreadyAbsent: true });
    expect(http.calls).toHaveLength(2); // label lookup only (page + empty page); no DELETE
  });

  test('remove-label tolerates a 404 from the delete', () => {
    const http = fakeHttp([ok(LABELS), { status: 404, statusText: 'Not Found', body: '' }]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    expect(provider.transitionItem(5, { kind: 'remove-label', label: 'ai:active' })).toEqual({ ok: true, alreadyAbsent: true });
  });

  test('add-label returns ok:false when the label lookup itself fails', () => {
    const http = fakeHttp([{ status: 500, statusText: 'err', body: 'down' }]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    expect(provider.transitionItem(5, { kind: 'add-label', label: 'ai:active' }).ok).toBe(false);
  });

  test('label lookup paginates past a full first page and finds a label on page 2', () => {
    // A full first page (50 labels) must trigger a page=2 lookup, or a workflow
    // label beyond the first page reads as missing and the transition fails (add) /
    // silently no-ops (remove). Because Gitea may clamp the page size below the
    // requested value, the lookup never infers exhaustion from a short page — it
    // pages until the label is found or an empty page is returned.
    const fullFirstPage = Array.from({ length: 50 }, (_, k) => ({ id: k + 1, name: `noise-${k}` }));
    const secondPage = [{ id: 777, name: 'ai:active' }];
    const http = fakeHttp([ok(fullFirstPage), ok(secondPage), { status: 200, statusText: 'OK', body: '[]' }]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });

    expect(provider.transitionItem(5, { kind: 'add-label', label: 'ai:active' })).toEqual({ ok: true });
    expect(http.calls).toHaveLength(3);
    expect(http.calls[0].url).toContain('page=1');
    // The lookup requests Gitea's default max page size so a normal instance needs
    // the fewest round-trips.
    expect(http.calls[0].url).toContain('limit=50');
    expect(http.calls[1].url).toContain('page=2');
    expect(http.calls[2].method).toBe('POST');
    expect(JSON.parse(http.calls[2].body)).toEqual({ labels: [777] });
  });

  test('label lookup fails closed when every page up to the cap is full (possible truncation)', () => {
    // 50 full pages of 50 labels (the effective cap), none matching: the list may
    // extend past the cap, so the lookup must not report the label as absent —
    // that would make a remove a silent no-op and an add fail with the wrong
    // reason.
    const fullPage = Array.from({ length: 50 }, (_, k) => ({ id: k + 1, name: `noise-${k}` }));
    const http = fakeHttp(Array.from({ length: 50 }, () => ok(fullPage)));
    const provider = new GiteaWorkItemProvider({ ...BASE, http });

    const result = provider.transitionItem(5, { kind: 'remove-label', label: 'ai:active' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot confirm whether label "ai:active" exists/);
    expect(http.calls).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// Transport-level failures (DNS / connection refused/reset)
//
// The transport throws ONLY on a transport-level failure; a non-2xx HTTP
// response is a normal return. A throw must not escape a mutation method, or
// dispatchOutbox would abort the whole CLI on a transient Gitea outage instead
// of leaving the row pending (retryable). Read methods keep failing/fail-closed.
// ---------------------------------------------------------------------------

describe('GiteaWorkItemProvider — transport failures stay within the contract', () => {
  // A transport that throws like the default (subprocess) transport does when the
  // host is unreachable, rather than returning an envelope.
  function throwingHttp(message = 'connect ECONNREFUSED 10.0.0.1:443') {
    const calls = [];
    const fn = () => {
      calls.push(1);
      throw new Error(message);
    };
    fn.calls = calls;
    return fn;
  }

  test('commentItem reports a retryable ok:false instead of throwing', () => {
    const http = throwingHttp();
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    let result;
    expect(() => {
      result = provider.commentItem(10, 'phase complete');
    }).not.toThrow();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/transport error/);
  });

  test('transitionItem (add-label) reports ok:false when the label lookup transport fails', () => {
    const http = throwingHttp();
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    let result;
    expect(() => {
      result = provider.transitionItem(5, { kind: 'add-label', label: 'ai:active' });
    }).not.toThrow();
    expect(result.ok).toBe(false);
  });

  test('transitionItem (remove-label) reports ok:false when the DELETE transport fails', () => {
    // The label resolves on the first call, then the DELETE transport throws: a
    // transport failure must NOT be swallowed as the 404 no-op success.
    const calls = [];
    let i = 0;
    const http = (req) => {
      calls.push(req);
      if (i++ === 0) return ok(LABELS);
      throw new Error('connection reset by peer');
    };
    http.calls = calls;
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    let result;
    expect(() => {
      result = provider.transitionItem(5, { kind: 'remove-label', label: 'ai:active' });
    }).not.toThrow();
    expect(result.ok).toBe(false);
  });

  test('a transport error never leaks the token into the failure string', () => {
    const http = throwingHttp(`connect failed for token ${TOKEN}`);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    const result = provider.commentItem(10, 'x');
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain(TOKEN);
    expect(result.error).toContain('[redacted]');
  });

  test('read methods keep throwing / fail closed on a transport error', async () => {
    const provider = new GiteaWorkItemProvider({ ...BASE, http: throwingHttp() });
    expect(() => provider.listCandidateItems(10)).toThrow(/transport error/);
    await expect(provider.getDependencies(3)).rejects.toThrow(/transport error/);
  });
});

// ---------------------------------------------------------------------------
// getDependencies (native Gitea issue dependencies)
// ---------------------------------------------------------------------------

describe('GiteaWorkItemProvider — getDependencies', () => {
  test('maps native dependencies to BlockedByEntry', async () => {
    const http = fakeHttp([ok([{ number: 11, state: 'closed' }, { number: 12, state: 'open' }]), ok([])]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    await expect(provider.getDependencies(3)).resolves.toEqual([
      { issueNumber: 11, state: 'closed' },
      { issueNumber: 12, state: 'open' },
    ]);
    expect(http.calls[0].url).toContain('/issues/3/dependencies');
  });

  test('throws (fail closed) on a non-2xx response', async () => {
    const http = fakeHttp([{ status: 403, statusText: 'Forbidden', body: 'dependencies disabled' }]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    await expect(provider.getDependencies(3)).rejects.toThrow(/Gitea issue dependencies read failed \(HTTP 403\)/);
  });

  test('keeps paging after a short page and stops on an empty page (page-cap safe)', async () => {
    // A short page is not proof of exhaustion when the server clamps the page size
    // below the request, so a short page still triggers a next-page fetch; only an
    // empty page ends the read. Treating a short page as complete could miss an
    // open blocker on a later page and let a dependent start work (fail-closed gate).
    const http = fakeHttp([ok([{ number: 12, state: 'open' }]), ok([])]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    await expect(provider.getDependencies(3)).resolves.toEqual([{ issueNumber: 12, state: 'open' }]);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0].url).toContain('page=1');
    expect(http.calls[1].url).toContain('page=2');
  });

  test('paginates beyond the first page and finds a later open blocker', async () => {
    // The page size is 50; a full first page must trigger a second fetch. An open
    // blocker that lives only on the second page must still be seen, or a
    // dependent could start work despite the dependency (fail-closed gate).
    const firstPage = Array.from({ length: 50 }, (_, k) => ({ number: 100 + k, state: 'closed' }));
    const secondPage = [{ number: 999, state: 'open' }];
    // The second page is short but non-empty, so the read pages once more to an
    // empty page before declaring the list exhausted.
    const http = fakeHttp([ok(firstPage), ok(secondPage), ok([])]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });

    const deps = await provider.getDependencies(3);
    expect(http.calls).toHaveLength(3);
    expect(http.calls[0].url).toContain('page=1');
    expect(http.calls[1].url).toContain('page=2');
    expect(http.calls[2].url).toContain('page=3');
    expect(deps).toHaveLength(51);
    expect(deps).toContainEqual({ issueNumber: 999, state: 'open' });
  });

  test('fails closed when every page up to the cap is full (possible truncation)', async () => {
    // 50 pages of 50 closed deps each: the list may extend past the cap, so the
    // read must throw rather than report "no open blocker" from a truncated set.
    const fullPage = Array.from({ length: 50 }, (_, k) => ({ number: k + 1, state: 'closed' }));
    const http = fakeHttp(Array.from({ length: 50 }, () => ok(fullPage)));
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    await expect(provider.getDependencies(3)).rejects.toThrow(/refusing to treat a truncated dependency list as complete/);
    expect(http.calls).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// getDependents — the outgoing end of the same relationship (issue #791 review)
// ---------------------------------------------------------------------------

describe('GiteaWorkItemProvider — getDependents', () => {
  test('reads /blocks and maps the issues this one blocks', async () => {
    const http = fakeHttp([ok([{ number: 99, state: 'open' }]), ok([])]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    await expect(provider.getDependents(3)).resolves.toEqual([{ issueNumber: 99, state: 'open' }]);
    expect(http.calls[0].url).toContain('/issues/3/blocks');
    // Same paging discipline as the blocked-by read: only an empty page ends it.
    expect(http.calls).toHaveLength(2);
  });

  test('throws (fail closed) on a non-2xx response', async () => {
    const http = fakeHttp([{ status: 403, statusText: 'Forbidden', body: 'dependencies disabled' }]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    await expect(provider.getDependents(3)).rejects.toThrow(/Gitea issue blocks read failed \(HTTP 403\)/);
  });
});

// ---------------------------------------------------------------------------
// Dependency relationship writes (issue #791)
// ---------------------------------------------------------------------------

describe('GiteaWorkItemProvider — dependency relationships', () => {
  test('adds a `blocked by` relationship by the blocker\'s issue index', async () => {
    const http = fakeHttp([ok({})]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });

    expect(await provider.addDependency(11, 10)).toEqual({ ok: true, changed: true });
    expect(http.calls[0].method).toBe('POST');
    expect(http.calls[0].url).toBe('https://gitea.example.com/api/v1/repos/ai-private/work-items/issues/11/dependencies');
    // Gitea's `IssueMeta` body, NOT GitHub's `issue_id`: the blocker is named by
    // its repository-scoped index, and owner/repo are carried so Gitea resolves
    // it against this repository instead of treating it as a cross-repository
    // dependency (which it refuses unless that feature is enabled).
    expect(JSON.parse(http.calls[0].body)).toEqual({ index: 10, owner: 'ai-private', repo: 'work-items' });
  });

  test('a duplicate add and an absent removal are both the requested end state', async () => {
    const http = fakeHttp([
      { status: 409, statusText: 'Conflict', body: 'dependency already exists' },
      { status: 404, statusText: 'Not Found', body: 'no such dependency' },
      // The 404 is believed only after the dependency list confirms it: #10 is
      // not among #11's blockers.
      ok([]),
    ]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    expect(await provider.addDependency(11, 10)).toEqual({ ok: true, changed: false });
    expect(await provider.removeDependency(11, 10)).toEqual({ ok: true, changed: false });
    expect(http.calls[1].method).toBe('DELETE');
    expect(http.calls[2].method).toBe('GET');
    expect(http.calls[2].url).toContain('/issues/11/dependencies');
  });

  test('removes a `blocked by` relationship and verifies it is gone', async () => {
    const http = fakeHttp([ok({}), ok([{ number: 12, state: 'open' }]), ok([])]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });

    expect(await provider.removeDependency(11, 10)).toEqual({ ok: true, changed: true });
    expect(http.calls[0].method).toBe('DELETE');
    // Gitea removes a dependency on the *collection* with the same `IssueMeta`
    // body as the add — it has no `.../dependencies/{id}` route like GitHub's.
    expect(http.calls[0].url).toBe('https://gitea.example.com/api/v1/repos/ai-private/work-items/issues/11/dependencies');
    expect(JSON.parse(http.calls[0].body)).toEqual({ index: 10, owner: 'ai-private', repo: 'work-items' });
  });

  test('a 404 removal that left the relationship in place is a failure, not a success', async () => {
    // 404 is also what a Gitea that routes the delete differently (or one whose
    // transport dropped the DELETE body) answers while the blocker stays put.
    // Reporting the requested end state here would record a removal that never
    // happened, so the dependency list is the last word.
    const http = fakeHttp([
      { status: 404, statusText: 'Not Found', body: 'no such dependency' },
      ok([{ number: 10, state: 'open' }]),
      ok([]),
    ]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });

    const result = await provider.removeDependency(11, 10);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('#11 blocked by #10');
    expect(result.error).toContain('still listed');
  });

  test('a 2xx removal the server did not apply is a failure too', async () => {
    const http = fakeHttp([ok({}), ok([{ number: 10, state: 'open' }]), ok([])]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });

    const result = await provider.removeDependency(11, 10);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('still listed');
  });

  test('an unverifiable removal is reported as a failure, with the token redacted', async () => {
    const http = fakeHttp([
      { status: 404, statusText: 'Not Found', body: 'no such dependency' },
      { status: 403, statusText: 'Forbidden', body: `dependencies disabled ${TOKEN}` },
    ]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });

    const result = await provider.removeDependency(11, 10);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('could not be verified');
    expect(result.error).not.toContain(TOKEN);
  });

  test('a real failure is reported rather than thrown, with the token redacted', async () => {
    const http = fakeHttp([{ status: 500, statusText: 'Server Error', body: `boom ${TOKEN}` }]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    const result = await provider.addDependency(11, 10);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('#11 blocked by #10');
    expect(result.error).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Token redaction — no secret reaches an error message
// ---------------------------------------------------------------------------

describe('GiteaWorkItemProvider — token redaction', () => {
  test('a response body echoing the token never leaks it into the thrown error', () => {
    const http = fakeHttp([{ status: 401, statusText: 'Unauthorized', body: `invalid token ${TOKEN}` }]);
    const provider = new GiteaWorkItemProvider({ ...BASE, http });
    let message = '';
    try {
      provider.listCandidateItems(10);
    } catch (err) {
      message = err.message;
    }
    expect(message).not.toContain(TOKEN);
    expect(message).toContain('[redacted]');
  });

  test('redactGiteaSecrets masks 40-char hex tokens and explicit secrets', () => {
    expect(redactGiteaSecrets(`leak ${TOKEN}`, [])).toBe('leak [redacted]');
    expect(redactGiteaSecrets('leak sekret-value-here', ['sekret-value-here'])).toBe('leak [redacted]');
  });
});

// ---------------------------------------------------------------------------
// resolveGiteaToken — secret indirection, no inline material
// ---------------------------------------------------------------------------

describe('resolveGiteaToken', () => {
  test('resolves from an environment variable name', () => {
    expect(resolveGiteaToken({ mode: 'api-token', tokenEnv: 'GT' }, { env: { GT: 'secret' } })).toBe('secret');
  });

  test('throws GiteaAuthConfigError when the env var is unset', () => {
    expect(() => resolveGiteaToken({ mode: 'api-token', tokenEnv: 'GT' }, { env: {} })).toThrow(GiteaAuthConfigError);
  });

  test('resolves from a credential key via the injected resolver', () => {
    expect(resolveGiteaToken({ mode: 'api-token', tokenKey: 'vault/gitea' }, { resolveKey: () => 'from-vault' })).toBe('from-vault');
  });

  test('throws when a tokenKey is used without a resolver', () => {
    expect(() => resolveGiteaToken({ mode: 'api-token', tokenKey: 'vault/gitea' })).toThrow(GiteaAuthConfigError);
  });

  test('rejects a non api-token auth mode', () => {
    expect(() => resolveGiteaToken({ mode: 'gh' })).toThrow(GiteaAuthConfigError);
  });
});

// ---------------------------------------------------------------------------
// buildGiteaApiUrl
// ---------------------------------------------------------------------------

describe('buildGiteaApiUrl', () => {
  test('defaults the API path to /api/v1 and appends the query', () => {
    expect(buildGiteaApiUrl('https://gitea.example.com', undefined, '/repos/o/r/issues', { state: 'open' }))
      .toBe('https://gitea.example.com/api/v1/repos/o/r/issues?state=open');
  });

  test('honors a custom api path and trims trailing slashes', () => {
    expect(buildGiteaApiUrl('https://gitea.example.com/', '/custom/api/', '/repos/o/r/labels'))
      .toBe('https://gitea.example.com/custom/api/repos/o/r/labels');
  });
});
