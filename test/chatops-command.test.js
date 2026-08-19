/**
 * Contract tests for the ChatOps command grammar and trust boundary
 * (issue #777) — docs/chatops-command-grammar-contract.md.
 *
 * These pin the recognition layer's decisions: what counts as the candidate
 * line, what the grammar accepts/rejects, and the outcome each gate produces.
 * They intentionally never touch a provider, a store, or dispatch — the
 * module under test has none of those.
 */
import {
  MAX_CHATOPS_COMMENT_BODY_CHARS,
  extractCandidateCommandLine,
  parseChatOpsCommandLine,
  recognizeChatOpsComment,
  parseChatOpsMarkerBody,
  isAuthenticatedChatOpsMarker,
  looksLikeCommandAttempt,
  isPubliclyRespondable,
} from '../dist/core/chatops-command.js';

function comment(overrides = {}) {
  return {
    author: 'alice',
    body: '/grant',
    createdAt: '2026-08-13T00:00:00Z',
    updatedAt: '2026-08-13T00:00:00Z',
    ...overrides,
  };
}

const TRUST = { authorAllowlist: ['alice'], automationLogins: ['bot-account'] };
const VERBS = new Set(['grant', 'status']);

// ---------------------------------------------------------------------------
// §3 Parsing exclusions
// ---------------------------------------------------------------------------

describe('extractCandidateCommandLine — exclusions', () => {
  test('a plain single-line command survives', () => {
    expect(extractCandidateCommandLine('/grant')).toBe('/grant');
  });

  test('prose before a command line means the command is never the candidate', () => {
    expect(extractCandidateCommandLine('context or explanation\n/grant')).toBe('context or explanation');
  });

  test('a fenced command (column 0) is excluded', () => {
    const body = ['```', '/grant', '```'].join('\n');
    expect(extractCandidateCommandLine(body)).toBeNull();
  });

  test('a fence indented by 0-3 spaces still excludes its contents', () => {
    for (const indent of [0, 1, 2, 3]) {
      const pad = ' '.repeat(indent);
      const body = [`${pad}\`\`\``, '/grant', `${pad}\`\`\``].join('\n');
      expect(extractCandidateCommandLine(body)).toBeNull();
    }
  });

  test('4+ space indentation is not a fence and is excluded as indented code instead', () => {
    const body = ['    ```', '    /grant', '    ```'].join('\n');
    expect(extractCandidateCommandLine(body)).toBeNull();
  });

  test('a non-terminating closing-fence lookalike stays inside the fence', () => {
    const body = ['```', '```not-a-close', '/grant', '```'].join('\n');
    expect(extractCandidateCommandLine(body)).toBeNull();
  });

  test('indented code block (4 spaces) excludes a command line', () => {
    const body = '    /grant';
    expect(extractCandidateCommandLine(body)).toBeNull();
  });

  test('tab indentation counts as 4 columns for the indented-code rule', () => {
    const body = '\t/grant';
    expect(extractCandidateCommandLine(body)).toBeNull();
  });

  test('a block-quoted line is excluded', () => {
    expect(extractCandidateCommandLine('> /grant')).toBeNull();
  });

  test('a block-quote lazy continuation line is excluded even without its own >', () => {
    const body = ['> quoted explanation', '/grant'].join('\n');
    expect(extractCandidateCommandLine(body)).toBeNull();
  });

  test('a blank line ends block-quote lazy continuation', () => {
    const body = ['> quoted explanation', '', '/grant'].join('\n');
    expect(extractCandidateCommandLine(body)).toBe('/grant');
  });

  test('an inline-code-span-only line is excluded', () => {
    expect(extractCandidateCommandLine('`/grant`')).toBeNull();
  });

  test('a comment with only excluded content yields no candidate', () => {
    const body = ['```', '/grant', '```'].join('\n');
    expect(extractCandidateCommandLine(body)).toBeNull();
  });

  test('leading blank lines are skipped, not treated as the (failing) candidate', () => {
    expect(extractCandidateCommandLine('\n\n/grant')).toBe('/grant');
  });

  test('a body of only blank lines yields no candidate', () => {
    expect(extractCandidateCommandLine('\n\n')).toBeNull();
  });

  test('an empty body yields no candidate', () => {
    expect(extractCandidateCommandLine('')).toBeNull();
  });

  test('a body over the bound is rejected without being scanned', () => {
    const body = `${'x'.repeat(MAX_CHATOPS_COMMENT_BODY_CHARS)}\n/grant`;
    expect(extractCandidateCommandLine(body)).toBeNull();
  });

  test('a body at exactly the bound is still scanned', () => {
    const body = '/grant' + ' '.repeat(MAX_CHATOPS_COMMENT_BODY_CHARS - 6);
    expect(extractCandidateCommandLine(body)).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// §2 Grammar
// ---------------------------------------------------------------------------

describe('parseChatOpsCommandLine — grammar', () => {
  test('a bare verb parses with empty argv', () => {
    expect(parseChatOpsCommandLine('/grant')).toEqual({ verb: 'grant', argv: [] });
  });

  test('a space-separated flag/value pair parses as two argv entries', () => {
    expect(parseChatOpsCommandLine('/grant --on-changes commit')).toEqual({
      verb: 'grant',
      argv: ['--on-changes', 'commit'],
    });
  });

  test('--flag=value expands identically to the space-separated form', () => {
    expect(parseChatOpsCommandLine('/grant --on-changes=commit')).toEqual(
      parseChatOpsCommandLine('/grant --on-changes commit'),
    );
  });

  test('--flag="quoted value" expands to a two-entry argv preserving the space', () => {
    expect(parseChatOpsCommandLine('/grant --message="hello world"')).toEqual({
      verb: 'grant',
      argv: ['--message', 'hello world'],
    });
  });

  test('a bare flag with no value parses as a single argv entry', () => {
    expect(parseChatOpsCommandLine('/grant --confirm-discard')).toEqual({
      verb: 'grant',
      argv: ['--confirm-discard'],
    });
  });

  test('multiple tokens preserve order', () => {
    expect(parseChatOpsCommandLine('/grant --confirm-discard --allow-unexpected')).toEqual({
      verb: 'grant',
      argv: ['--confirm-discard', '--allow-unexpected'],
    });
  });

  test('a quoted bare value parses without its quotes', () => {
    expect(parseChatOpsCommandLine('/grant "some value"')).toEqual({
      verb: 'grant',
      argv: ['some value'],
    });
  });

  test('leading/trailing whitespace on the line is trimmed', () => {
    expect(parseChatOpsCommandLine('   /grant  ')).toEqual({ verb: 'grant', argv: [] });
  });

  test('a line not starting with / is not a command', () => {
    expect(parseChatOpsCommandLine('grant')).toBeNull();
  });

  test('an unterminated quote is malformed', () => {
    expect(parseChatOpsCommandLine('/grant --message="unterminated')).toBeNull();
  });

  test('a value glued to a closing quote is malformed', () => {
    expect(parseChatOpsCommandLine('/grant "abc"def')).toBeNull();
  });

  test('--flag= with nothing after it is malformed', () => {
    expect(parseChatOpsCommandLine('/grant --on-changes=')).toBeNull();
  });

  test('a bare --flag=value whose value starts with -- is malformed', () => {
    expect(parseChatOpsCommandLine('/grant --message=--yes')).toBeNull();
  });

  test('a quoted --flag="value" whose value starts with -- is malformed', () => {
    expect(parseChatOpsCommandLine('/grant --message="--yes"')).toBeNull();
  });

  test('a quoted positional whose value starts with -- is malformed', () => {
    expect(parseChatOpsCommandLine('/grant "--yes"')).toBeNull();
  });

  test('junk glued directly after the verb with no separator is malformed', () => {
    expect(parseChatOpsCommandLine('/grant"x"')).toBeNull();
  });

  test.each(['$', '`', '|', ';', '&', '<', '>', '(', ')', '{', '}'])(
    'a shell metacharacter (%s) anywhere in the line rejects the whole comment',
    (ch) => {
      expect(parseChatOpsCommandLine(`/grant --message=foo${ch}bar`)).toBeNull();
    },
  );

  test('single-character verbs are rejected (verb requires at least 2 characters)', () => {
    expect(parseChatOpsCommandLine('/g')).toBeNull();
  });

  test('an empty line is not a command', () => {
    expect(parseChatOpsCommandLine('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §4/§5/§6 Recognition outcomes
// ---------------------------------------------------------------------------

describe('recognizeChatOpsComment — outcomes', () => {
  test('a well-formed command from an allowlisted, unedited author is recognized', () => {
    expect(recognizeChatOpsComment(comment(), TRUST, VERBS)).toEqual({
      kind: 'command',
      command: { verb: 'grant', argv: [] },
    });
  });

  test('a non-allowlisted author is rejected before parsing runs', () => {
    expect(recognizeChatOpsComment(comment({ author: 'mallory' }), TRUST, VERBS)).toEqual({
      kind: 'unauthorized-author',
    });
  });

  test('author allowlist comparison is case-insensitive', () => {
    expect(recognizeChatOpsComment(comment({ author: 'ALICE' }), TRUST, VERBS)).toEqual({
      kind: 'command',
      command: { verb: 'grant', argv: [] },
    });
  });

  test('a malformed body from an allowlisted author is rejected as malformed, not unauthorized', () => {
    expect(recognizeChatOpsComment(comment({ body: 'not a command' }), TRUST, VERBS)).toEqual({
      kind: 'malformed',
    });
  });

  test('an unsupported verb is rejected by name', () => {
    expect(recognizeChatOpsComment(comment({ body: '/nonexistent-verb' }), TRUST, VERBS)).toEqual({
      kind: 'unsupported-command',
      verb: 'nonexistent-verb',
    });
  });

  test('an edited-before-first-seen well-formed command is ambiguous, not executed', () => {
    const edited = comment({ updatedAt: '2026-08-13T00:00:01Z' });
    expect(recognizeChatOpsComment(edited, TRUST, VERBS)).toEqual({ kind: 'ambiguous-edit' });
  });

  test('a malformed comment that happens to also be edited is still malformed, not ambiguous', () => {
    const edited = comment({ body: 'not a command', updatedAt: '2026-08-13T00:00:01Z' });
    expect(recognizeChatOpsComment(edited, TRUST, VERBS)).toEqual({ kind: 'malformed' });
  });

  test('a second surviving line is never reached even for an allowlisted author', () => {
    const twoLines = comment({ body: 'please see below\n/grant' });
    expect(recognizeChatOpsComment(twoLines, TRUST, VERBS)).toEqual({ kind: 'malformed' });
  });
});

// ---------------------------------------------------------------------------
// §7 Acknowledgement markers
// ---------------------------------------------------------------------------

describe('marker parsing and authentication', () => {
  test('a canonical claim marker parses', () => {
    expect(parseChatOpsMarkerBody('<!-- chatops-claimed:123 -->')).toEqual({
      kind: 'claimed',
      commentId: '123',
    });
  });

  test('a canonical ack marker parses with its outcome', () => {
    expect(parseChatOpsMarkerBody('<!-- chatops-ack:123:executed -->')).toEqual({
      kind: 'ack',
      commentId: '123',
      outcome: 'executed',
    });
  });

  test('a marker embedded inside other text does not parse', () => {
    expect(parseChatOpsMarkerBody('note: <!-- chatops-claimed:123 --> done')).toBeNull();
  });

  test('a leading-zero id does not parse (not the canonical decimal form)', () => {
    expect(parseChatOpsMarkerBody('<!-- chatops-claimed:0123 -->')).toBeNull();
  });

  test('an authentic marker requires both exact body and automation authorship', () => {
    const marker = { author: 'bot-account', body: '<!-- chatops-claimed:123 -->' };
    expect(isAuthenticatedChatOpsMarker(marker, TRUST.automationLogins)).toBe(true);
  });

  test('a right-shaped marker from a non-automation author is not authenticated', () => {
    const marker = { author: 'alice', body: '<!-- chatops-claimed:123 -->' };
    expect(isAuthenticatedChatOpsMarker(marker, TRUST.automationLogins)).toBe(false);
  });

  test('automation authorship alone does not authenticate a non-canonical body', () => {
    const marker = { author: 'bot-account', body: 'claimed 123' };
    expect(isAuthenticatedChatOpsMarker(marker, TRUST.automationLogins)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §10 Bounded input and public response
// ---------------------------------------------------------------------------

describe('public response policy', () => {
  test('a candidate line starting with / looks like a command attempt', () => {
    expect(looksLikeCommandAttempt('/grant --bogus"')).toBe(true);
  });

  test('ordinary prose does not look like a command attempt', () => {
    expect(looksLikeCommandAttempt('just talking about /etc/passwd here')).toBe(false);
  });

  test('unauthorized-author is never publicly respondable', () => {
    expect(isPubliclyRespondable({ kind: 'unauthorized-author' }, '/grant')).toBe(false);
  });

  test('malformed prose (no leading /) is not publicly respondable', () => {
    expect(isPubliclyRespondable({ kind: 'malformed' }, 'not a command')).toBe(false);
  });

  test('malformed but clearly attempted (leading /) is publicly respondable', () => {
    expect(isPubliclyRespondable({ kind: 'malformed' }, '/grant --bogus"')).toBe(true);
  });

  test('ambiguous-edit, unsupported-command, and command are all publicly respondable', () => {
    expect(isPubliclyRespondable({ kind: 'ambiguous-edit' }, '/grant')).toBe(true);
    expect(isPubliclyRespondable({ kind: 'unsupported-command', verb: 'x' }, '/x')).toBe(true);
    expect(isPubliclyRespondable({ kind: 'command', command: { verb: 'grant', argv: [] } }, '/grant')).toBe(true);
  });
});
