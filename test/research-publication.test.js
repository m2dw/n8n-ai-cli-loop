/**
 * Unit tests for the Research Publication contract (issue #834,
 * docs/research-publication-contract.md).
 *
 * These pin the deterministic half of the feature: policy resolution, envelope
 * extraction, closed-schema validation, the sanitization pipeline, and
 * rendering. The handler/outbox integration lives in
 * test/research-publication-handler.test.js.
 *
 * The governing property throughout is that the ONLY publishable string this
 * module can produce comes from a well-formed envelope — every failure mode
 * returns `ok: false`, and none of them yields text derived from the
 * surrounding transcript.
 */
import {
  DEFAULT_PUBLICATION_MAX_CHARS,
  PUBLICATION_WITHHOLD_PHRASES,
  PUBLICATION_MAX_CHARS_CEILING,
  PUBLICATION_MAX_CHARS_FLOOR,
  RESEARCH_PUBLICATION_MARKER,
  RESEARCH_PUBLICATION_END_MARKER,
  RESEARCH_PUBLICATION_FAILED_STATUS,
  buildResearchPublication,
  extractPublicationEnvelope,
  publicationInstructions,
  publicationWithholdReason,
  renderPublicationMarkdown,
  resolvePublicationPolicy,
} from '../dist/core/research-publication.js';
import {
  closeOpenMarkdownFences,
  neutralizeClosingKeywords,
} from '../dist/core/text-sanitize.js';

const REPO_ROOT = '/Users/tester/work/repo';
const ARTIFACT_ROOT = '/Users/tester/work/repo/.n8n-artifacts';
const RUN_DIR = `${ARTIFACT_ROOT}/runs/run-1`;

const BUILD_OPTS = {
  maxChars: DEFAULT_PUBLICATION_MAX_CHARS,
  configuredPaths: [REPO_ROOT, ARTIFACT_ROOT, RUN_DIR],
  deniedLocationSegments: ['.n8n-artifacts'],
};

/** Wrap a payload object (or raw string) in one publication block. */
function envelope(payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return `${RESEARCH_PUBLICATION_MARKER}\n${body}\n${RESEARCH_PUBLICATION_END_MARKER}`;
}

/** A minimal valid publication payload with `overrides` merged into it. */
function payload(overrides = {}) {
  return { publication: { version: 1, summary: 'The cache is invalidated twice per request.', ...overrides } };
}

function build(stdout, opts = {}) {
  return buildResearchPublication({ findingsText: stdout, ...BUILD_OPTS, ...opts });
}

// ---------------------------------------------------------------------------
// Policy resolution
// ---------------------------------------------------------------------------

describe('resolvePublicationPolicy', () => {
  test('defaults to local_only with the contract default budget', () => {
    expect(resolvePublicationPolicy(undefined)).toEqual({
      mode: 'local_only',
      maxChars: DEFAULT_PUBLICATION_MAX_CHARS,
      allowUntrustedInputs: false,
    });
    expect(resolvePublicationPolicy({})).toEqual({
      mode: 'local_only',
      maxChars: DEFAULT_PUBLICATION_MAX_CHARS,
      allowUntrustedInputs: false,
    });
  });

  test('accepts sanitized_summary and an explicit budget', () => {
    expect(resolvePublicationPolicy({ mode: 'sanitized_summary', maxChars: 12000 })).toEqual({
      mode: 'sanitized_summary',
      maxChars: 12000,
      allowUntrustedInputs: false,
    });
  });

  test('only a literal true acknowledges untrusted inputs', () => {
    // The acknowledgment is the one switch that lets a report derived from
    // unvetted inputs reach GitHub, so a truthy near-miss must not enable it.
    expect(resolvePublicationPolicy({ allowUntrustedInputs: true }).allowUntrustedInputs).toBe(true);
    for (const value of [undefined, false, 'true', 1, {}]) {
      expect(resolvePublicationPolicy({ allowUntrustedInputs: value }).allowUntrustedInputs).toBe(false);
    }
  });

  test('an unrecognized mode fails closed to local_only', () => {
    // A typo, or a mode from a newer configuration, must never publish MORE
    // than it was meant to.
    expect(resolvePublicationPolicy({ mode: 'raw_output' }).mode).toBe('local_only');
    expect(resolvePublicationPolicy({ mode: 'SANITIZED_SUMMARY' }).mode).toBe('local_only');
  });

  test('maxChars is clamped to the module floor and ceiling', () => {
    expect(resolvePublicationPolicy({ maxChars: 1 }).maxChars).toBe(PUBLICATION_MAX_CHARS_FLOOR);
    expect(resolvePublicationPolicy({ maxChars: 10_000_000 }).maxChars).toBe(PUBLICATION_MAX_CHARS_CEILING);
    expect(resolvePublicationPolicy({ maxChars: 0.5 }).maxChars).toBe(DEFAULT_PUBLICATION_MAX_CHARS);
    expect(resolvePublicationPolicy({ maxChars: Number.NaN }).maxChars).toBe(DEFAULT_PUBLICATION_MAX_CHARS);
  });
});

describe('publicationWithholdReason', () => {
  // The gate is provenance-level (§5.1): every research run is Issue-originated,
  // so the only thing that can release a report is the operator's explicit
  // acknowledgment. There is no per-field trust input to pass in.
  test('withholds by provenance whenever the acknowledgment is absent', () => {
    expect(publicationWithholdReason({ allowUntrustedInputs: false })).toBe('untrusted-provenance');
    expect(publicationWithholdReason(resolvePublicationPolicy({ mode: 'sanitized_summary' })))
      .toBe('untrusted-provenance');
  });

  test('the acknowledgment is the only thing that releases the report', () => {
    expect(publicationWithholdReason({ allowUntrustedInputs: true })).toBeNull();
    expect(publicationWithholdReason(
      resolvePublicationPolicy({ mode: 'sanitized_summary', allowUntrustedInputs: true }),
    )).toBeNull();
  });

  test('ignores everything except a literal true', () => {
    // A near-miss acknowledgment must not open the channel, and no other
    // property of the run may be consulted to open it either — the checklist
    // this replaced was unsound precisely because it could be satisfied by
    // omission.
    for (const value of [undefined, false, 'true', 1, {}, null]) {
      expect(publicationWithholdReason({ allowUntrustedInputs: value })).toBe('untrusted-provenance');
    }
    expect(publicationWithholdReason({
      allowUntrustedInputs: false,
      bodyIncluded: false,
      metadataIncluded: false,
      evidenceEnabled: false,
      workspaceSettingsEnabled: false,
    })).toBe('untrusted-provenance');
  });

  test('the reason vocabulary is a single provenance literal with a fixed phrase', () => {
    expect(Object.keys(PUBLICATION_WITHHOLD_PHRASES)).toEqual(['untrusted-provenance']);
    const phrase = PUBLICATION_WITHHOLD_PHRASES['untrusted-provenance'];
    expect(typeof phrase).toBe('string');
    expect(phrase.length).toBeGreaterThan(0);
    // Names the provenance, not an enumerated field of the work item.
    expect(phrase).toContain('originated from a GitHub Issue');
  });
});

// ---------------------------------------------------------------------------
// Envelope extraction
// ---------------------------------------------------------------------------

describe('extractPublicationEnvelope', () => {
  test('finds the single block amid surrounding agent chatter', () => {
    const stdout = [
      'Reading src/cache.ts …',
      '[tool] search pattern="invalidate"',
      '## Findings',
      'The cache is invalidated twice.',
      envelope(payload()),
      'Done. Total tokens: 1234.',
    ].join('\n');
    const result = extractPublicationEnvelope(stdout);
    expect(result.kind).toBe('payload');
    expect(JSON.parse(result.payload)).toEqual(payload());
  });

  test('no block at all is missing-envelope', () => {
    expect(extractPublicationEnvelope('just some findings')).toEqual({
      kind: 'failure',
      failure: { reason: 'missing-envelope', detail: null },
    });
  });

  test('two blocks fail closed rather than letting the last one win', () => {
    const stdout = `${envelope(payload({ summary: 'first' }))}\n${envelope(payload({ summary: 'second' }))}`;
    const result = extractPublicationEnvelope(stdout);
    expect(result.kind).toBe('failure');
    expect(result.failure.reason).toBe('duplicate-envelope');
    expect(result.failure.detail).toBe('blocks:2');
  });

  test('a duplicate emitted early is still seen (the whole output is scanned)', () => {
    const filler = 'chatter line\n'.repeat(5000);
    const stdout = `${envelope(payload())}\n${filler}${envelope(payload())}`;
    expect(extractPublicationEnvelope(stdout).failure.reason).toBe('duplicate-envelope');
  });

  test('an unterminated block is malformed, not missing', () => {
    const stdout = `${RESEARCH_PUBLICATION_MARKER}\n{"publication":{"summary":"x"}}`;
    expect(extractPublicationEnvelope(stdout)).toEqual({
      kind: 'failure',
      failure: { reason: 'malformed-envelope', detail: 'unterminated-block' },
    });
  });

  test('a second opening marker inside an open block is malformed', () => {
    const stdout = [
      RESEARCH_PUBLICATION_MARKER,
      '{"publication":{"summary":"x"}}',
      RESEARCH_PUBLICATION_MARKER,
      '{"publication":{"summary":"y"}}',
      RESEARCH_PUBLICATION_END_MARKER,
    ].join('\n');
    expect(extractPublicationEnvelope(stdout).failure.reason).toBe('malformed-envelope');
  });

  test('markers are recognized only as whole lines', () => {
    const inline = `prose ${RESEARCH_PUBLICATION_MARKER} {"publication":{}} ${RESEARCH_PUBLICATION_END_MARKER}`;
    expect(extractPublicationEnvelope(inline).failure.reason).toBe('missing-envelope');
  });

  test('a CRLF-producing CLI still terminates the block', () => {
    const stdout = `${RESEARCH_PUBLICATION_MARKER}\r\n{"publication":{"summary":"x"}}\r\n${RESEARCH_PUBLICATION_END_MARKER}\r`;
    expect(extractPublicationEnvelope(stdout).kind).toBe('payload');
  });

  test('a stray end marker with no opener is chatter, not a block', () => {
    expect(extractPublicationEnvelope(`findings\n${RESEARCH_PUBLICATION_END_MARKER}\n`).failure.reason)
      .toBe('missing-envelope');
  });

  test('an oversized payload is rejected before it is parsed', () => {
    const huge = JSON.stringify({ publication: { summary: 'x'.repeat(70 * 1024) } });
    const result = extractPublicationEnvelope(envelope(huge));
    expect(result.kind).toBe('failure');
    expect(result.failure.reason).toBe('envelope-too-large');
    expect(result.failure.detail).toMatch(/^bytes:\d+$/);
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('buildResearchPublication — schema validation', () => {
  test('a well-formed envelope yields a rendered report', () => {
    const result = build(envelope(payload({
      title: 'Double cache invalidation',
      findings: [{ title: 'Two invalidations', detail: 'Both middlewares clear the entry.', confidence: 'high' }],
      recommendation: 'Move invalidation into one middleware.',
      openQuestions: ['Does the CDN layer re-add the entry?'],
      references: [{ label: 'the second invalidation', location: 'src/cache.ts:42' }],
    })));
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.markdown).toContain('### Double cache invalidation');
    expect(result.markdown).toContain('The cache is invalidated twice per request.');
    expect(result.markdown).toContain('**Two invalidations**');
    expect(result.markdown).toContain('_(confidence: high)_');
    expect(result.markdown).toContain('#### Recommendation');
    expect(result.markdown).toContain('Does the CDN layer re-add the entry?');
    expect(result.markdown).toContain('`src/cache.ts:42`');
  });

  test('nothing outside the envelope reaches the rendered report', () => {
    const stdout = [
      'SECRET-CHATTER-BEFORE',
      '[tool] read /etc/shadow',
      envelope(payload()),
      'SECRET-CHATTER-AFTER',
    ].join('\n');
    const result = build(stdout);
    expect(result.ok).toBe(true);
    expect(result.markdown).not.toContain('SECRET-CHATTER-BEFORE');
    expect(result.markdown).not.toContain('SECRET-CHATTER-AFTER');
    expect(result.markdown).not.toContain('shadow');
  });

  test('a missing summary is rejected', () => {
    const result = build(envelope({ publication: { version: 1 } }));
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'schema-invalid', detail: 'publication.summary:required' });
  });

  test('a non-JSON payload is malformed', () => {
    const result = build(envelope('not json at all'));
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'malformed-envelope', detail: 'not-json' });
  });

  test('an extra top-level key is rejected', () => {
    const result = build(envelope({ publication: { summary: 'x' }, extra: 1 }));
    expect(result.ok).toBe(false);
    expect(result.failure.reason).toBe('unsupported-field');
  });

  test('an unrecognized publication field is rejected, never ignored', () => {
    const result = build(envelope(payload({ artifactPath: '/tmp/run/research-output.md' })));
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'unsupported-field', detail: 'publication' });
  });

  test('the failure detail never echoes the rejected field name or value', () => {
    const result = build(envelope(payload({ MY_SECRET_FIELD: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })));
    expect(JSON.stringify(result.failure)).not.toMatch(/MY_SECRET_FIELD|ghp_/);
  });

  test('an unsupported version is rejected', () => {
    expect(build(envelope(payload({ version: 2 }))).failure.reason).toBe('schema-invalid');
  });

  test('an unsupported confidence value is rejected', () => {
    const result = build(envelope(payload({
      findings: [{ title: 't', detail: 'd', confidence: 'certain' }],
    })));
    expect(result.ok).toBe(false);
    expect(result.failure.detail).toBe('publication.findings[0].confidence:unsupported');
  });

  test('a non-string summary is rejected', () => {
    expect(build(envelope({ publication: { summary: 42 } })).failure.detail)
      .toBe('publication.summary:not-a-string');
  });

  test('a non-array findings value is rejected', () => {
    expect(build(envelope(payload({ findings: 'lots' }))).failure.detail)
      .toBe('publication.findings:not-an-array');
  });
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

describe('buildResearchPublication — per-field bounds', () => {
  test('an oversized summary fails closed and reports the observed length', () => {
    const result = build(envelope(payload({ summary: 'x'.repeat(4001) })));
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'field-too-long', detail: 'publication.summary:4001' });
  });

  test('an oversized finding detail fails closed', () => {
    const result = build(envelope(payload({
      findings: [{ title: 't', detail: 'y'.repeat(801) }],
    })));
    expect(result.failure).toEqual({ reason: 'field-too-long', detail: 'publication.findings[0].detail:801' });
  });

  test('too many findings fails closed', () => {
    const findings = Array.from({ length: 13 }, (_, i) => ({ title: `t${i}`, detail: 'd' }));
    expect(build(envelope(payload({ findings }))).failure).toEqual({
      reason: 'field-too-long',
      detail: 'publication.findings:13',
    });
  });

  test('too many references fails closed', () => {
    const references = Array.from({ length: 21 }, (_, i) => ({ label: `l${i}`, location: `src/a${i}.ts` }));
    expect(build(envelope(payload({ references }))).failure.reason).toBe('field-too-long');
  });

  test('a rendered report over maxChars is bounded rather than dropped', () => {
    const result = build(envelope(payload({ summary: 'w'.repeat(3000) })), { maxChars: 500 });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.markdown).toContain('…(truncated)');
    expect(result.markdown.startsWith('w'.repeat(100))).toBe(true);
  });

  test('a bounded report stays within maxChars, marker and fence repair included', () => {
    // The truncation marker is appended after the slice, so cutting at exactly
    // maxChars would publish more than the operator configured.
    const result = build(envelope(payload({ summary: 'w'.repeat(3000) })), { maxChars: 500 });
    expect(result.markdown.length).toBeLessThanOrEqual(500);
  });

  test('a cut inside a fenced block is closed and still fits maxChars', () => {
    const result = build(envelope(payload({
      summary: `\`\`\`js\n${'const x = 1;\n'.repeat(200)}\`\`\``,
    })), { maxChars: 600 });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(600);
    expect((result.markdown.match(/^```/gm) ?? []).length % 2).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

describe('buildResearchPublication — malformed encodings', () => {
  test('a NUL byte in a field fails closed', () => {
    const result = build(envelope({ publication: { summary: `bad${String.fromCharCode(0)}value` } }));
    expect(result.failure).toEqual({ reason: 'malformed-encoding', detail: 'publication.summary' });
  });

  test('a C0 control character fails closed', () => {
    const result = build(envelope({ publication: { summary: `bad${String.fromCharCode(7)}value` } }));
    expect(result.failure.reason).toBe('malformed-encoding');
  });

  test('a lone surrogate fails closed', () => {
    const result = build(envelope({ publication: { summary: `bad${String.fromCharCode(0xd800)}value` } }));
    expect(result.failure.reason).toBe('malformed-encoding');
  });

  test('ordinary newlines, tabs, and astral characters are accepted', () => {
    const result = build(envelope(payload({ summary: 'line one\n\tline two 🎯 done' })));
    expect(result.ok).toBe(true);
    expect(result.markdown).toContain('🎯');
  });
});

// ---------------------------------------------------------------------------
// Reference locations
// ---------------------------------------------------------------------------

describe('buildResearchPublication — reference locations', () => {
  const withLocation = (location) => build(envelope(payload({ references: [{ label: 'l', location }] })));

  test.each([
    ['src/cache.ts'],
    ['src/cache.ts:42'],
    ['src/cache.ts:42-88'],
    ['docs/research-publication-contract.md'],
    ['https://github.com/m2dw/repo/issues/834'],
  ])('accepts %s', (location) => {
    expect(withLocation(location).ok).toBe(true);
  });

  test.each([
    ['/Users/tester/work/repo/src/cache.ts'],
    ['/etc/passwd'],
    ['~/notes.md'],
    ['C:/Users/tester/cache.ts'],
    ['file:///Users/tester/cache.ts'],
    ['http://example.com/x'],
    ['../outside/secret.ts'],
    ['src/../../etc/passwd'],
    ['src/cache.ts with a comment'],
    [''],
  ])('rejects %s as an unpublishable location', (location) => {
    const result = withLocation(location);
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'invalid-location', detail: 'publication.references[0].location' });
  });

  test.each([
    ['https://example.test/`</code><details>'],
    ['https://example.test/a`b'],
    ['https://exa`mple.test/x'],
    ['https://example.test/<img>'],
    ['https://example.test/a"b'],
    ['https://example.test/a\\b'],
    ['https://example.test/{a}'],
    ['https://example.test/a|b'],
  ])('rejects the https location %s rather than let it escape its code span', (location) => {
    // The renderer wraps a location in a code span. A backtick inside one would
    // close that span early and let the rest of the location be read as Markdown
    // or HTML, which could hide the report sections rendered after it. None of
    // these characters are legal in a URI, so the location fails closed.
    const result = withLocation(location);
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'invalid-location', detail: 'publication.references[0].location' });
  });

  test.each([
    ['https://example.test/a/b?q=1&r=2#frag'],
    ["https://example.test/path_(with)-'punctuation'!"],
    ['https://example.test:8443/a%20b'],
    ['https://example.test/@scope/pkg'],
  ])('still accepts the ordinary https location %s', (location) => {
    expect(withLocation(location).ok).toBe(true);
  });

  test.each([
    ['https://alice:password@example.test/x'],
    ['https://ghp_abcdefghijklmnopqrstuvwxyz012345@example.test/x'],
    ['https://alice@example.test:8443/a%20b'],
  ])('rejects the https location %s rather than publish its userinfo', (location) => {
    // Userinfo is a credential with no shape of its own, so no shape-based
    // redactor reaches it. A reference that needs a password to resolve is not
    // one a reader of the Issue can follow, so the form fails closed instead of
    // being rewritten.
    const result = withLocation(location);
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'invalid-location', detail: 'publication.references[0].location' });
  });

  test.each([
    ['https://github.com'],
    ['https://example.test:8443'],
    ['https://example.test?source=x'],
    ['https://example.test#frag'],
    ['https://example.test/'],
  ])('accepts the root https location %s', (location) => {
    // Everything after the authority is optional. One unpublishable reference
    // rejects the whole envelope, so demanding a path would cost the entire
    // report over a URL a reader can follow unchanged.
    expect(withLocation(location).ok).toBe(true);
  });

  test('a root https reference is published in a report, not swapped for the failure status', () => {
    const result = build(envelope(payload({ references: [{ label: 'Upstream', location: 'https://github.com' }] })));
    expect(result.ok).toBe(true);
    expect(result.markdown).toContain('https://github.com');
    expect(result.markdown).not.toContain(RESEARCH_PUBLICATION_FAILED_STATUS);
  });

  test('rejects a repo-relative location carrying a credential shape', () => {
    // A location is agent-authored text like every other field, so a token
    // inside one must not reach the comment. Redaction leaves brackets a
    // repository path cannot contain, so the reference fails closed instead of
    // being published half-rewritten.
    const result = withLocation('src/ghp_abcdefghijklmnopqrstuvwxyz012345.ts');
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'invalid-location', detail: 'publication.references[0].location' });
  });

  test('rejects a repo-relative location carrying a standalone API key', () => {
    // The same fail-closed path as above, for a key shape with no introducing
    // keyword — the one an agent can pick up from a config file.
    const result = withLocation('src/AIzaSyD-abcdefghijklmnopqrstuvwxyz12345.ts');
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ reason: 'invalid-location', detail: 'publication.references[0].location' });
  });

  test('an https location carrying a token is redacted, not published verbatim', () => {
    const result = withLocation('https://example.com/x?token=ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(result.ok).toBe(true);
    expect(result.markdown).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(result.report.references[0].location).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(result.markdown).toContain('[redacted]');
  });

  test.each([
    ['https://example.test/x?access_token=sekritvalue', 'sekritvalue'],
    ['https://example.test/x?q=1&api-key=abc123', 'abc123'],
    ['https://example.test/x#id_token=jwtish.value', 'jwtish.value'],
    ['https://example.test/x?sig=YmFzZTY0', 'YmFzZTY0'],
    ['https://example.test/x?password=hunter2', 'hunter2'],
  ])('redacts the credential query parameter in %s', (location, secret) => {
    // A query credential is opaque bytes, so only the parameter *name* marks
    // it. The reference stays publishable — the value does not.
    const result = withLocation(location);
    expect(result.ok).toBe(true);
    expect(result.markdown).not.toContain(secret);
    expect(result.report.references[0].location).not.toContain(secret);
    expect(result.report.references[0].location).toContain('[redacted]');
  });

  test('leaves an ordinary query parameter intact while redacting the credential beside it', () => {
    const result = withLocation('https://example.test/search?q=cache&access_token=sekritvalue&page=2');
    expect(result.ok).toBe(true);
    expect(result.report.references[0].location).toBe(
      'https://example.test/search?q=cache&access_token=[redacted]&page=2',
    );
  });

  test.each([
    // `;` and `,` are ordinary query-value data, so a value must be redacted
    // through to the next `&` — cutting at `;` would publish the tail of a live
    // credential as an unrecognized suffix.
    ['https://example.test/x?access_token=first;second', 'second'],
    ['https://example.test/x?access_token=first,second', 'second'],
    // A later `?` is data too, not a second query.
    ['https://example.test/x?access_token=first?second', 'second'],
    // …and so is a `;`-separated credential inside another parameter's value:
    // detection is looser than the value boundary, so this over-redacts `q`
    // rather than publishing the token.
    ['https://example.test/x?q=cache;access_token=second', 'second'],
    // Percent-encoded and `+`-encoded names decode to the same credential name.
    ['https://example.test/x?api%6Bey=unpatternedsecretvalue', 'unpatternedsecretvalue'],
    ['https://example.test/x?access%5Ftoken=unpatternedsecretvalue', 'unpatternedsecretvalue'],
    ['https://example.test/x?%61pi%2Dkey=unpatternedsecretvalue', 'unpatternedsecretvalue'],
    // Doubly encoded, caught at an intermediate decoding stage.
    ['https://example.test/x?api%256Bey=unpatternedsecretvalue', 'unpatternedsecretvalue'],
    // Fragment parameters are parsed the same way (OAuth implicit flow).
    ['https://example.test/x#access_token=first;second&state=1', 'second'],
  ])('redacts the whole credential value in %s', (location, leftover) => {
    const result = withLocation(location);
    expect(result.ok).toBe(true);
    expect(result.report.references[0].location).not.toContain(leftover);
    expect(result.report.references[0].location).toContain('[redacted]');
    expect(result.markdown).not.toContain(leftover);
  });

  test('a `&` really does end the credential value', () => {
    // The only delimiter a URL guarantees. What follows it is a separate
    // parameter, so redacting past it would drop unrelated citation context.
    const result = withLocation('https://example.test/x?sig=abc&page=2');
    expect(result.report.references[0].location).toBe('https://example.test/x?sig=[redacted]&page=2');
  });

  test('an empty credential parameter is left as-is', () => {
    const result = withLocation('https://example.test/x?token=&page=2');
    expect(result.ok).toBe(true);
    expect(result.report.references[0].location).toBe('https://example.test/x?token=&page=2');
  });

  test('rejects a location inside the run artifact directory', () => {
    // The artifact/run directory is named explicitly: a repo-relative reference
    // to it is otherwise indistinguishable from a legitimate source path.
    expect(withLocation('.n8n-artifacts/runs/run-1/research-output.md').failure.reason).toBe('invalid-location');
  });
});

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

describe('buildResearchPublication — sanitization', () => {
  test('absolute local paths are redacted from every free-text field', () => {
    const result = build(envelope(payload({
      title: `see ${REPO_ROOT}/src/cache.ts`,
      summary: `The run wrote ${RUN_DIR}/research-output.md and read /etc/hosts.`,
      findings: [{ title: `at ${REPO_ROOT}`, detail: `stack trace from ${ARTIFACT_ROOT}/x.log` }],
      recommendation: `move it out of ${REPO_ROOT}/tmp`,
      openQuestions: [`what is in /var/log/agy.log?`],
    })));
    expect(result.ok).toBe(true);
    expect(result.markdown).not.toContain(REPO_ROOT);
    expect(result.markdown).not.toContain(ARTIFACT_ROOT);
    expect(result.markdown).not.toContain('/etc/hosts');
    expect(result.markdown).not.toContain('/var/log');
    expect(result.markdown).toContain('<path>');
  });

  test('credential-shaped values are redacted', () => {
    const result = build(envelope(payload({
      summary: 'The worker exports ghp_abcdefghijklmnopqrstuvwxyz012345 and sends Authorization: Bearer sk-abcdefgh12345678.',
    })));
    expect(result.markdown).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(result.markdown).not.toContain('sk-abcdefgh12345678');
    expect(result.markdown).toContain('[redacted]');
  });

  test('a standalone API key with no introducing keyword is redacted', () => {
    // `sanitized_summary` publishes agent-composed prose, so a key the agent
    // read out of a config file can appear bare in a sentence — no `token`/
    // `Bearer` introducer and no GitHub-shaped prefix to key redaction off.
    const result = build(envelope(payload({
      title: 'key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 in config',
      summary: 'The worker boots with sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 in its environment.',
      findings: [{ title: 'AKIAIOSFODNN7EXAMPLE is hard-coded', detail: 'and so is xoxb-1234567890-abcdefghijkl' }],
      recommendation: 'rotate api_key = "vT7bQ2xLp9Kd" first',
      openQuestions: ['is AIzaSyD-abcdefghijklmnopqrstuvwxyz12345 still live?'],
    })));
    expect(result.ok).toBe(true);
    expect(result.markdown).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(result.markdown).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.markdown).not.toContain('xoxb-1234567890-abcdefghijkl');
    expect(result.markdown).not.toContain('vT7bQ2xLp9Kd');
    expect(result.markdown).not.toContain('AIzaSyD-abcdefghijklmnopqrstuvwxyz12345');
    expect(result.markdown).toContain('[redacted]');
  });

  test('an unclosed HTML comment cannot comment out the sections the runner appends', () => {
    const result = build(envelope(payload({
      summary: 'Looks complete. <!--',
      findings: [{ title: 'still visible', detail: 'and not commented out' }],
      references: [{ label: 'the call site', location: 'src/cache.ts:42' }],
    })));
    expect(result.ok).toBe(true);
    // The comment opener is escaped, so everything the renderer owns after the
    // summary — headings, references, and (in the composed comment) the
    // truncation note and run metadata — is still real Markdown.
    expect(result.markdown).not.toContain('<!--');
    expect(result.markdown).toContain('&lt;!--');
    expect(result.markdown).toContain('#### Findings');
    expect(result.markdown).toContain('#### References');
  });

  test('raw HTML tags in free-text fields are escaped, not honoured', () => {
    const result = build(envelope(payload({
      title: '<span>t</span>',
      summary: 'hidden below\n<div style="display:none">',
      findings: [{ title: '<b>f</b>', detail: '<img src=x>' }],
      openQuestions: ['<details>'],
    })));
    expect(result.ok).toBe(true);
    expect(result.markdown).not.toMatch(/<(?:span|div|b|img|details)\b/);
    expect(result.markdown).toContain('&lt;div style="display:none">');
    expect(result.markdown).toContain('&lt;details>');
  });

  test('HTML inside code spans and fenced blocks is left as written', () => {
    // Escaping there would show a literal `&lt;` to the reader, and Markdown
    // does not interpret HTML inside code in the first place.
    const result = build(envelope(payload({
      summary: 'the `<div>` wrapper:\n\n```html\n<div>x</div>\n```',
    })));
    expect(result.ok).toBe(true);
    expect(result.markdown).toContain('the `<div>` wrapper:');
    expect(result.markdown).toContain('```html\n<div>x</div>\n```');
  });

  test('GitHub closing keywords are neutralized', () => {
    const result = build(envelope(payload({
      summary: 'This fixes #12 and closes m2dw/other#7.',
      findings: [{ title: 'resolves #99', detail: 'Fixed: https://github.com/m2dw/repo/issues/5' }],
    })));
    expect(result.markdown).not.toMatch(/fixes #12/i);
    expect(result.markdown).not.toMatch(/closes m2dw\/other#7/i);
    expect(result.markdown).not.toMatch(/resolves #99/i);
    expect(result.markdown).toContain('fixes (see #12)');
    expect(result.markdown).toContain('closes (see m2dw/other#7)');
  });

  test('an unterminated code fence in one field cannot swallow later sections', () => {
    const result = build(envelope(payload({
      summary: '```js\nconst leak = true;',
      findings: [{ title: 'still rendered', detail: 'visible' }],
    })));
    expect(result.ok).toBe(true);
    // The fence the agent opened is closed before the runner-owned Findings
    // heading, so the heading is real Markdown and not fenced-off text.
    const fenceCount = (result.markdown.match(/^```/gm) ?? []).length;
    expect(fenceCount % 2).toBe(0);
    expect(result.markdown.indexOf('#### Findings')).toBeGreaterThan(result.markdown.lastIndexOf('```'));
  });

  test('a balanced fence is left exactly as written', () => {
    const result = build(envelope(payload({ summary: '```js\nconst ok = 1;\n```' })));
    expect(result.markdown).toContain('```js\nconst ok = 1;\n```');
  });

  test('a multi-line title is collapsed so it cannot introduce structure', () => {
    const result = build(envelope(payload({ title: 'line one\n## injected heading' })));
    expect(result.markdown.split('\n')[0]).toBe('### line one ## injected heading');
  });

  test('a summary left empty by sanitization fails closed instead of publishing a bare heading', () => {
    // A path-only summary still leaves the `<path>` placeholder behind, so it
    // is content and publishes…
    const redactedOnly = build(envelope({ publication: { summary: REPO_ROOT } }));
    expect(redactedOnly.ok).toBe(true);
    expect(redactedOnly.markdown).toBe('<path>');
    // …but a summary with nothing left at all does not.
    const empty = build(envelope({ publication: { summary: '   \n  ' } }));
    expect(empty.ok).toBe(false);
    expect(empty.failure).toEqual({ reason: 'empty-report', detail: 'publication.summary' });
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('renderPublicationMarkdown', () => {
  test('omits every section the report does not carry', () => {
    const markdown = renderPublicationMarkdown({
      summary: 'Just a summary.',
      findings: [],
      openQuestions: [],
      references: [],
    });
    expect(markdown).toBe('Just a summary.');
  });

  test('renders reference locations as code spans, never as links', () => {
    const markdown = renderPublicationMarkdown({
      summary: 's',
      findings: [],
      openQuestions: [],
      references: [{ label: 'the call site', location: 'src/cache.ts:42' }],
    });
    expect(markdown).toContain('- the call site — `src/cache.ts:42`');
    expect(markdown).not.toContain('](');
  });
});

// ---------------------------------------------------------------------------
// Prompt section and fixed status
// ---------------------------------------------------------------------------

describe('publicationInstructions', () => {
  test('states the single-block rule, the closed schema, and the prohibitions', () => {
    const text = publicationInstructions();
    expect(text).toContain(RESEARCH_PUBLICATION_MARKER);
    expect(text).toContain(RESEARCH_PUBLICATION_END_MARKER);
    expect(text).toMatch(/EXACTLY ONE publication block/);
    expect(text).toMatch(/Two blocks publish neither/);
    expect(text).toMatch(/unrecognized field discards the whole block/i);
    expect(text).toMatch(/never an absolute path/i);
    expect(text).toMatch(/closing keywords/i);
    expect(text).toMatch(/Raw HTML and HTML comments are escaped/);
  });
});

describe('RESEARCH_PUBLICATION_FAILED_STATUS', () => {
  test('is fixed public-safe text with no reason code or path', () => {
    expect(RESEARCH_PUBLICATION_FAILED_STATUS).toMatch(/did not pass validation/);
    expect(RESEARCH_PUBLICATION_FAILED_STATUS).not.toMatch(/envelope|schema-invalid|\//);
  });
});

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

describe('closeOpenMarkdownFences', () => {
  test('leaves balanced text untouched', () => {
    const text = 'a\n```\ncode\n```\nb';
    expect(closeOpenMarkdownFences(text)).toBe(text);
  });

  test('closes an unterminated fence', () => {
    expect(closeOpenMarkdownFences('a\n```js\ncode')).toBe('a\n```js\ncode\n```');
  });

  test('closes with a fence at least as long as the opener', () => {
    expect(closeOpenMarkdownFences('````\ncode')).toBe('````\ncode\n````');
  });

  test('recognizes tilde fences and does not cross fence characters', () => {
    expect(closeOpenMarkdownFences('~~~\ncode')).toBe('~~~\ncode\n~~~');
    expect(closeOpenMarkdownFences('~~~\ncode\n```')).toBe('~~~\ncode\n```\n~~~');
  });

  test('ignores an inline triple-backtick span', () => {
    const text = 'see ```literal``` here';
    expect(closeOpenMarkdownFences(text)).toBe(text);
  });
});

describe('neutralizeClosingKeywords', () => {
  test.each([
    ['fixes #12', 'fixes (see #12)'],
    ['Fixed: #12', 'Fixed (see #12)'],
    ['closes m2dw/repo#7', 'closes (see m2dw/repo#7)'],
    ['resolve https://github.com/m2dw/repo/issues/5', 'resolve (see https://github.com/m2dw/repo/issues/5)'],
  ])('%s -> %s', (input, expected) => {
    expect(neutralizeClosingKeywords(input)).toBe(expected);
  });

  test('is idempotent', () => {
    const once = neutralizeClosingKeywords('fixes #12');
    expect(neutralizeClosingKeywords(once)).toBe(once);
  });

  test('leaves a bare reference and non-keyword prose alone', () => {
    expect(neutralizeClosingKeywords('see #12 for detail')).toBe('see #12 for detail');
    expect(neutralizeClosingKeywords('a prefix fix is needed')).toBe('a prefix fix is needed');
  });
});
