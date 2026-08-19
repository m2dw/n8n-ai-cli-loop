/**
 * Structural tests for docs/chatops-comment-cursor-contract.md (issue #781).
 *
 * The document is the behavioral contract for how a session discovers issue
 * comments and how far a durable cursor over them may advance. A rule that
 * silently drifts out of the document — or out of the module that implements
 * it — is exactly how a valid command gets permanently skipped, so these
 * tests pin the claims a reader must be able to rely on: the total ordering,
 * the completeness conditions, the failure taxonomy, the invariants, and the
 * required scenarios.
 *
 * Assertions run against a whitespace-normalized copy — the document is
 * hard-wrapped prose, so a claim can straddle a line break today and be
 * reflowed tomorrow.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8').replace(/\s+/g, ' ');
}

const doc = read('docs/chatops-comment-cursor-contract.md');
const core = read('src/core/chatops-comment-cursor.ts');

describe('docs/chatops-comment-cursor-contract.md — status and scope', () => {
  test('is marked implemented at the discovery layer and names its module', () => {
    expect(doc).toMatch(/Status: \*\*approved design, implemented at the discovery layer\*\*/);
    expect(doc).toMatch(/src\/core\/chatops-comment-cursor\.ts/);
  });

  test('builds on the identity and grammar contracts instead of re-deriving them', () => {
    expect(doc).toMatch(/docs\/chatops-identity-contract\.md/);
    expect(doc).toMatch(/docs\/chatops-command-grammar-contract\.md/);
    expect(core).toMatch(/chatops-identity-contract\.md/);
  });

  test('supersedes the cursor/pagination portion of the earlier attempts', () => {
    expect(doc).toMatch(/supersedes the cursor\/pagination portion of #778 and of #696 \/ PR #776/i);
  });

  test('excludes the execution ledger, replay, polling, and dispatch', () => {
    expect(doc).toMatch(/The execution ledger/);
    expect(doc).toMatch(/Replay after a restore/);
    expect(doc).toMatch(/\*\*Polling\*\*/);
    expect(doc).toMatch(/\*\*Operation dispatch and trust tiers\*\*/);
  });
});

describe('total ordering (§3)', () => {
  test('the order key is the creation instant plus the comment id as tie-break', () => {
    expect(doc).toMatch(/orderKey\(comment\) = \(createdAtMs, commentId\)/);
    expect(doc).toMatch(/breaks ties, which is what makes the order \*\*total\*\*/);
  });

  test('ids compare numerically, never lexically or as floats', () => {
    expect(doc).toMatch(/shorter string is smaller, equal length compares lexically/);
    expect(doc).toMatch(/Number\.MAX_SAFE_INTEGER/);
    expect(core).toMatch(/Number\.MAX_SAFE_INTEGER/);
  });

  test('ordering is on createdAt, because updatedAt moves under an edit', () => {
    expect(doc).toMatch(/Why `createdAt` and not `updatedAt`/);
    expect(doc).toMatch(/`createdAt` is immutable for a given comment/);
  });

  test('a timestamp without a timezone designator has no position in the order', () => {
    expect(doc).toMatch(/with an explicit timezone designator/);
    expect(core).toMatch(/explicit timezone/);
  });

  test('calendar fields are range checked, not normalized into a plausible instant', () => {
    expect(doc).toMatch(/The calendar fields are range checked, not merely shape checked/);
    expect(doc).toMatch(/`2026-02-30T00:00:00Z` becomes March 2/);
    expect(core).toMatch(/does not exist/);
  });
});

describe('cursor and lower bound (§4, §6.1)', () => {
  test('the cursor is exclusive and monotonic non-decreasing', () => {
    expect(doc).toMatch(/\*\*Exclusive\.\*\* Every comment with `orderKey <= cursor`/);
    expect(doc).toMatch(/\*\*Monotonic non-decreasing\.\*\*/);
  });

  test('the durable row carries an initialization sentinel beside the position', () => {
    expect(doc).toMatch(/The initialization sentinel/);
    expect(doc).toMatch(/\*\*`initialized: true, cursor: null`\*\* — the bootstrap window was empty/);
    expect(doc).toMatch(/Collapsing the first two states would create a permanent skip/);
    expect(core).toMatch(/export interface ChatOpsCursorState/);
    expect(core).toMatch(/export const CHATOPS_UNINITIALIZED_CURSOR_STATE/);
  });

  test('the since bound is one second below the cursor, and says why', () => {
    expect(doc).toMatch(/minus one second/);
    expect(doc).toMatch(/CHATOPS_SCAN_SINCE_MARGIN_MS/);
    expect(doc).toMatch(/under-fetching loses a command permanently/);
    expect(core).toMatch(/export const CHATOPS_SCAN_SINCE_MARGIN_MS = 1000;/);
  });

  test('the since filter is an optimization, never the completeness argument', () => {
    expect(doc).toMatch(/The filter is an optimization, never the completeness argument/);
  });

  test('the provider-behavior assumptions are pinned as read-from-docs, not verified', () => {
    expect(doc).toMatch(/\*\*Pinned assumption\.\*\*/);
    expect(doc).toMatch(/not verified against a live endpoint by this issue/);
  });
});

describe('complete scan window (§5)', () => {
  test('completeness requires reaching the end of the comment list', () => {
    expect(doc).toMatch(/The final page reports \*\*no further pages\*\*/);
    expect(doc).toMatch(/Only a complete window may advance the cursor/);
  });

  test('a page boundary never separates a command from its marker', () => {
    expect(doc).toMatch(/Why completeness must reach the end of the list/);
    expect(doc).toMatch(/indexAuthenticatedChatOpsMarkers/);
    expect(core).toMatch(/export function indexAuthenticatedChatOpsMarkers/);
  });

  test('the page cap is a guard that fails closed, not a budget that advances', () => {
    expect(doc).toMatch(/The page guard is a guard, not a budget/);
    expect(doc).toMatch(/never partial progress/);
    expect(core).toMatch(/export const CHATOPS_MAX_SCAN_PAGES = 200;/);
    expect(doc).toMatch(/CHATOPS_MAX_SCAN_PAGES` \(200\)/);
  });
});

describe('provider-port capabilities (§6)', () => {
  test.each([
    [/\*\*Ascending order by creation\.\*\*/],
    [/\*\*Stable, canonical ids\.\*\*/],
    [/\*\*Explicit end-of-list signal\.\*\*/],
    [/\*\*Inclusive lower bound \(optional\)\.\*\*/],
    [/\*\*Verbatim `createdAt`\/`updatedAt` in one spelling\.\*\*/],
  ])('requires %s', (pattern) => {
    expect(doc).toMatch(pattern);
  });

  test('descending pagination is refused outright', () => {
    expect(doc).toMatch(/there is no descending-order mode/);
  });
});

describe('failure taxonomy (§11)', () => {
  const reasons = [
    'page-fetch-failed',
    'no-pages',
    'pages-truncated',
    'trailing-page-after-end',
    'page-budget-exhausted',
    'malformed-comment-id',
    'malformed-timestamp',
    'page-out-of-order',
    'unstable-ordering',
    'identity-conflict',
  ];

  test.each(reasons)('%s is documented and implemented', (reason) => {
    expect(doc).toMatch(new RegExp(`\`${reason}\``));
    expect(core).toMatch(new RegExp(`"${reason}"`));
  });

  test('the module defines no reason the document does not list', () => {
    const declared = core.match(/\| "([a-z-]+)"/g) ?? [];
    const names = declared.map((m) => m.replace(/\| "|"/g, ''));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(reasons).toContain(name);
  });

  test('no incomplete result advances anything', () => {
    expect(doc).toMatch(/\*\*No incomplete result advances anything\*\*/);
    expect(doc).toMatch(/A partial advance is the one outcome the fail-closed rule exists to forbid/);
  });

  test('retry is bounded and escalated rather than looped forever', () => {
    expect(doc).toMatch(/Retry must be bounded and escalated rather than looped forever/);
  });
});

describe('bootstrap, first-seen, and candidates (§8-§10)', () => {
  test('bootstrap records everything, dispatches nothing, and reports the skip', () => {
    expect(doc).toMatch(/\*\*No pre-existing comment is ever dispatched at bootstrap\.\*\*/);
    expect(doc).toMatch(/skippedCommandAttempts/);
    expect(doc).toMatch(/not a \*\*silent\*\* one/);
    expect(core).toMatch(/skippedCommandAttempts/);
  });

  test('bootstrap happens once per scope, empty comment list included', () => {
    expect(doc).toMatch(/\*\*Bootstrap happens exactly once per scope\*\*/);
    expect(doc).toMatch(/an empty bootstrap is still a\s+bootstrap/);
    expect(core).toMatch(/initialized: true/);
  });

  test('first-seen records are write-once and bounded', () => {
    expect(doc).toMatch(/\*\*Write-once\.\*\*/);
    expect(doc).toMatch(/\*\*Body storage is bounded\.\*\*/);
    expect(doc).toMatch(/MAX_CHATOPS_COMMENT_BODY_CHARS/);
    expect(core).toMatch(/MAX_CHATOPS_COMMENT_BODY_CHARS/);
  });

  test('content drift is an edit; id-level drift is a conflict', () => {
    expect(doc).toMatch(/edited-after-first-seen/);
    expect(doc).toMatch(/identity-conflict/);
    expect(core).toMatch(/export function reconcileChatOpsFirstSeen/);
  });

  test('scan-boundary deduplication makes no execution claim', () => {
    expect(doc).toMatch(/This is deduplication of discovery, not of execution/);
    expect(doc).toMatch(/is not "this command has already run"/);
  });

  test('a complete window commits atomically with its first-seen rows', () => {
    expect(doc).toMatch(/A complete window commits atomically/);
    expect(doc).toMatch(/single transaction/);
  });
});

describe('invariants and required situations (§13, §14)', () => {
  test.each([
    ['I1', /No valid command is permanently skipped/],
    ['I2', /The order is total/],
    ['I3', /The cursor is monotonic non-decreasing/],
    ['I4', /An incomplete window changes nothing/],
    ['I5', /A comment yields a first-seen record at most once/],
    ['I6', /Frontier acceptance is strictly increasing/],
    ['I7', /A marker is in the same window as its command/],
    ['I8', /Discovery makes no execution claim/],
  ])('%s is stated', (id, pattern) => {
    expect(doc).toMatch(new RegExp(`\\*\\*${id} —`));
    expect(doc).toMatch(pattern);
  });

  test.each([
    ['identical timestamps', /Multiple comments with identical timestamps/],
    ['page-boundary marker', /Command at the end of one page, marker on the next/],
    ['concurrent arrival', /New comments arriving during pagination/],
    ['overlapping pages', /Provider returning overlapping pages/],
    ['restart', /Restart midway through a scan/],
    ['bootstrap backlog', /Initial bootstrap after commands already exist/],
  ])('the required scenario %s has its own section', (_label, pattern) => {
    expect(doc).toMatch(pattern);
  });
});
