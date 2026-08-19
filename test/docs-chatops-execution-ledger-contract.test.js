/**
 * Structural tests for docs/chatops-execution-ledger-contract.md (issue #782).
 *
 * The document is the behavioral contract for how a discovered command becomes
 * an executed one, and for what happens when the process dies or the database
 * is restored from an older backup. A rule that silently drifts out of the
 * document — or out of the module that implements it — is exactly how a
 * command gets executed twice, so these tests pin the claims a reader must be
 * able to rely on: the numbered transition table, the transaction boundaries,
 * the guarantee wording, the invariants, and the required scenarios.
 *
 * Assertions run against a whitespace-normalized copy — the document is
 * hard-wrapped prose, so a claim can straddle a line break today and be
 * reflowed tomorrow. The transition table is read from the raw text instead,
 * because its rows are line-oriented.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function raw(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

function read(rel) {
  return raw(rel).replace(/\s+/g, ' ');
}

const DOC_PATH = 'docs/chatops-execution-ledger-contract.md';
const doc = read(DOC_PATH);
const docLines = raw(DOC_PATH).split('\n');
const core = read('src/core/chatops-execution-ledger.ts');

const tableRows = docLines.filter((line) => /^\| \d+ \|/.test(line));

describe(`${DOC_PATH} — status and scope`, () => {
  test('is marked implemented at the decision layer and names its module', () => {
    expect(doc).toMatch(/Status: \*\*approved design, implemented at the decision layer\*\*/);
    expect(doc).toMatch(/src\/core\/chatops-execution-ledger\.ts/);
  });

  test('builds on the grammar, identity, and cursor contracts instead of re-deriving them', () => {
    expect(doc).toMatch(/docs\/chatops-command-grammar-contract\.md/);
    expect(doc).toMatch(/docs\/chatops-identity-contract\.md/);
    expect(doc).toMatch(/docs\/chatops-comment-cursor-contract\.md/);
    expect(core).toMatch(/chatops-comment-cursor\.ts/);
  });

  test('supersedes the ledger/replay portion of the earlier attempts', () => {
    expect(doc).toMatch(/supersedes the ledger\/replay portion of #778 and of #696 \/ PR #776/i);
  });

  test('names the failure it exists to prevent: a local key does not survive a restore', () => {
    expect(doc).toMatch(
      /a local idempotency key alone cannot make execution at-most-once across a crash or a restore/i,
    );
  });

  test('excludes the dispatch port, polling, the schema, and task routing', () => {
    expect(doc).toMatch(/\*\*The operation-dispatch port\*\*/);
    expect(doc).toMatch(/\*\*Polling\*\*/);
    expect(doc).toMatch(/\*\*The SQLite schema\*\*/);
    expect(doc).toMatch(/\*\*Task routing\*\*/);
  });
});

describe('guarantee wording (§4)', () => {
  test('the four guarantees are stated separately, not collapsed', () => {
    expect(doc).toMatch(/\*\*Local ledger transitions are exactly-once\.\*\*/);
    expect(doc).toMatch(/\*\*Dispatch of an external effect is at-most-once, not exactly-once\.\*\*/);
    expect(doc).toMatch(/\*\*Retry is deduplicated, not redelivery\.\*\*/);
    expect(doc).toMatch(/\*\*Provider reconciliation is best-effort\.\*\*/);
  });

  test('there is deliberately no at-least-once or guaranteed-execution promise', () => {
    expect(doc).toMatch(/there is deliberately \*\*no\s+at-least-once guarantee\*\*/i);
    expect(doc).toMatch(
      /\*\*Not offered, explicitly:\*\* cross-system atomicity, exactly-once execution/,
    );
  });

  test('the provider capability table is the stated basis, including what is missing', () => {
    expect(doc).toMatch(/Transaction spanning local state and a provider write \| \*\*No\*\*/);
    expect(doc).toMatch(/Idempotency key or conditional-create on comment POST \| \*\*No\*\*/);
    expect(doc).toMatch(/Comment deletion by a repo administrator \| \*\*Possible\*\*/);
    expect(doc).toMatch(/\*\*Pinned assumption\.\*\*/);
    expect(doc).toMatch(/not verified against a live endpoint by this issue/);
  });
});

describe('states and transition table (§6, §7)', () => {
  const states = [
    'claimed',
    'dispatching',
    'awaiting_ack',
    'retry_scheduled',
    'rejected',
    'acknowledged',
    'ambiguous',
  ];

  test.each(states)('the state %s is documented and implemented', (state) => {
    expect(doc).toMatch(new RegExp(`\`${state}\``));
    expect(core).toMatch(new RegExp(`"${state}"`));
  });

  test('the module declares no ledger state the document does not list', () => {
    const declared = core.match(/export type ChatOpsLedgerState =([^;]+);/);
    expect(declared).not.toBeNull();
    const names = (declared[1].match(/"([a-z_]+)"/g) ?? []).map((m) => m.replace(/"/g, ''));
    expect(names.length).toBe(states.length);
    for (const name of names) expect(states).toContain(name);
  });

  test('the transition table is numbered contiguously from 1 to 24', () => {
    expect(tableRows).toHaveLength(24);
    const numbers = tableRows.map((line) => Number(/^\| (\d+) \|/.exec(line)[1]));
    expect(numbers).toEqual(Array.from({ length: 24 }, (_unused, i) => i + 1));
  });

  test('every table row is a single line, so a row number cites one rule', () => {
    for (const line of tableRows) {
      expect(line.trimEnd().endsWith('|')).toBe(true);
      expect(line.split('|').length).toBeGreaterThanOrEqual(6);
    }
  });

  test('the crash-recovery rows are exhaustive and have no default branch', () => {
    expect(doc).toMatch(
      /Rows 9, 10, 11, 12, and 13 are the entire crash-recovery surface/,
    );
    expect(doc).toMatch(/There is no default, no "assume it failed"/);
    expect(doc).toMatch(
      /no path from `dispatching` back to `dispatching`-with-a-fresh-attempt/,
    );
  });

  test('terminal rows are never re-opened except by a recorded operator', () => {
    expect(doc).toMatch(/\*\*Terminal means terminal\.\*\*/);
    expect(doc).toMatch(/the difference between an escape hatch and a silent replay path/);
    expect(core).toMatch(/export const CHATOPS_CLOSED_LEDGER_STATES/);
  });
});

describe('transaction boundaries and effect ordering (§8)', () => {
  test.each([['T1'], ['T2'], ['T3'], ['T4']])('%s is defined', (name) => {
    expect(doc).toMatch(new RegExp(`\\*\\*${name} —`));
  });

  test('nothing external ever runs inside a transaction', () => {
    expect(doc).toMatch(
      /Nothing external is ever inside a transaction; nothing local straddles one/,
    );
    expect(doc).toMatch(/\*\*Nothing external may happen before this commit returns\.\*\*/);
  });

  test('the claim marker precedes the operation, which is what makes absence a proof', () => {
    expect(doc).toMatch(/\*\*Only if step 1 returned success\*\*, invoke the operation/);
    expect(doc).toMatch(
      /the \*absence\* of a claim marker over a complete, quiesced window proves the operation never began/,
    );
  });

  test('T1 gives every comment at or below the cursor a ledger row', () => {
    expect(doc).toMatch(/every comment at or below the cursor has exactly one ledger row/);
  });
});

describe('epoch witness and restore (§9.2, §12)', () => {
  test.each([
    ['consistent'],
    ['witness-behind'],
    ['restore-detected'],
    ['witness-missing'],
  ])('the epoch verdict %s is documented and implemented', (verdict) => {
    expect(doc).toMatch(new RegExp(`\`${verdict}\``));
    expect(core).toMatch(new RegExp(`"${verdict}"`));
  });

  test('the witness lives outside the database, which restore does not replace', () => {
    expect(doc).toMatch(/mirrored to a small file outside the database/);
    expect(doc).toMatch(/restore swaps the DB file and its\s+`-wal`\/`-shm` sidecars, never the artifact tree/);
  });

  test('a failed witness write aborts the attempt before any external call', () => {
    expect(doc).toMatch(/\*\*the attempt is aborted before any external call\*\*/);
  });

  test('the write order is database-then-witness, and the doc says why', () => {
    expect(doc).toMatch(/The asymmetry is deliberate and is why the write order is DB-then-witness/);
    expect(doc).toMatch(/train operators to clear fences reflexively/);
    expect(core).toMatch(/export function assessChatOpsLedgerEpoch/);
  });

  test('a fence never clears itself', () => {
    expect(doc).toMatch(/There is no timeout, no retry budget, and no automatic clear/);
    expect(doc).toMatch(/a fence that expires on its own is a silent replay path with a\s+delay/i);
  });

  test('both restore detectors run independently', () => {
    expect(doc).toMatch(/\*\*Both detectors run, independently\.\*\*/);
    expect(doc).toMatch(/Neither is sufficient alone/);
  });
});

describe('evidence validation (§10)', () => {
  test('authentication alone is not enough — payload and ordering are validated', () => {
    expect(doc).toMatch(/Authentication is necessary but not sufficient/);
    expect(doc).toMatch(/is this marker evidence about this\s+specific ledger row/);
    expect(core).toMatch(/export function collectChatOpsExecutionEvidence/);
  });

  test.each([
    ['unknown-target'],
    ['evidence-precedes-target'],
    ['conflicting-outcome'],
  ])('the evidence defect %s is documented and implemented', (defect) => {
    expect(doc).toMatch(new RegExp(`\`${defect}\``));
    expect(core).toMatch(new RegExp(`"${defect}"`));
  });

  test('multiplicity is collected, because the restore detector compares counts', () => {
    expect(doc).toMatch(/it reports\s+multiplicity/);
    expect(doc).toMatch(/collapsing it into a boolean would discard the restore detector/);
  });

  test('a forged marker can neither suppress a command nor fence a scope', () => {
    expect(doc).toMatch(/Forged and look-alike markers are inert/);
    expect(doc).toMatch(/\*\*cannot fence a scope\.\*\*/);
    expect(doc).toMatch(/no commenter can fence anything/);
  });

  test('command authors and automation identities must be disjoint', () => {
    expect(doc).toMatch(
      /requires `chatOps\.authorAllowlist` and `chatOps\.automationLogins` to be disjoint/,
    );
    expect(core).toMatch(/export function validateChatOpsLoginSeparation/);
  });

  test('absence is proof only over a complete, quiesced window', () => {
    expect(doc).toMatch(/Absence as proof, and the quiescence delay/);
    expect(doc).toMatch(/CHATOPS_EVIDENCE_QUIESCENCE_MS/);
    expect(core).toMatch(/export const CHATOPS_EVIDENCE_QUIESCENCE_MS = 60_000;/);
  });

  test('the quiescence delay is a floor callers may raise but never lower', () => {
    expect(doc).toMatch(/The delay is therefore a \*\*floor, not a default\*\*/);
    expect(doc).toMatch(/is rejected outright rather than clamped/);
    expect(core).toMatch(/function resolveQuiescenceMs/);
    expect(core).toMatch(/may only be raised above/);
  });

  test('the reconciliation window is widened past the cursor, and evidence persists', () => {
    expect(doc).toMatch(/The reconciliation window is not the cursor window/);
    expect(doc).toMatch(/chatOpsReconciliationSinceBound/);
    expect(doc).toMatch(/Persisted refs are additive/);
    expect(core).toMatch(/export function chatOpsReconciliationSinceBound/);
  });
});

describe('regression, retry, and handoff (§11, §13)', () => {
  test('the regression predicate is stated and one-directional', () => {
    expect(doc).toMatch(/claims > attempts \|\| \(acks > 0 && attempts === 0\)/);
    expect(doc).toMatch(/The predicate is deliberately one-directional/);
    expect(doc).toMatch(/The ledger being \*ahead\* of the world is safe/);
  });

  test('a regression fences the whole scope, not just the row that tripped it', () => {
    expect(doc).toMatch(/Any regression fences the entire fence scope/);
    expect(doc).toMatch(/is a sample, not the extent of the damage/);
  });

  test('incomplete reconciliation data stalls rather than guesses', () => {
    expect(doc).toMatch(/Fail-closed here means \*stall\*, not \*guess\*/);
    expect(core).toMatch(/export const CHATOPS_MAX_RECONCILE_ATTEMPTS = 3;/);
  });

  test('automatic retry has explicit preconditions and a cap', () => {
    expect(doc).toMatch(/An automatic retry requires all of/);
    expect(doc).toMatch(/CHATOPS_MAX_DISPATCH_ATTEMPTS/);
    expect(core).toMatch(/export const CHATOPS_MAX_DISPATCH_ATTEMPTS = 3;/);
  });

  test('an operator-authorized retry is the only replay path, and it is recorded', () => {
    expect(doc).toMatch(
      /Row 22 is the only way a command that \*may\* have executed is ever dispatched\s+again/,
    );
    expect(doc).toMatch(/it is not silent/);
    expect(doc).toMatch(/Both halves of that record are \*\*mandatory and enforced\*\*/);
    expect(doc).toMatch(/retry authorized by\s+<operator>: <reason>/);
    expect(core).toMatch(/"operator-record-required"/);
  });

  test('an operator resolution stays publishable instead of going straight terminal', () => {
    expect(doc).toMatch(/\*\*Every `acknowledged` row has settled its marker\.\*\*/);
    expect(doc).toMatch(
      /an operator resolution \(row 21\) lands in `awaiting_ack` rather than\s+directly in `acknowledged`/,
    );
  });

  test.each([
    ['dispatch-crash-unresolved'],
    ['reconcile-inconclusive'],
    ['ledger-regression'],
    ['restore-detected'],
    ['witness-missing'],
    ['conflicting-evidence'],
    ['ack-publication-abandoned'],
    ['operator-escalation'],
  ])('the handoff reason %s is documented and implemented', (reason) => {
    expect(doc).toMatch(new RegExp(`\`${reason}\``));
    expect(core).toMatch(new RegExp(`"${reason}"`));
  });

  test('handoff reasons are a closed set, and ambiguity is never resolved by acting', () => {
    expect(doc).toMatch(/\*\*Handoff reasons are a closed set\*\*, not free text/);
    expect(doc).toMatch(/the ledger must \*never\* resolve an ambiguity by acting/);
  });
});

describe('bounded evidence and observability (§14)', () => {
  test('evidence refs are bounded while counts stay exact', () => {
    expect(doc).toMatch(/CHATOPS_MAX_EVIDENCE_REFS/);
    expect(doc).toMatch(/a truncated view never reads as a complete one/);
    expect(doc).toMatch(/a truncated count would silently disarm the restore detector/);
    expect(core).toMatch(/export const CHATOPS_MAX_EVIDENCE_REFS = 8;/);
  });

  test('no comment body is copied into the ledger', () => {
    expect(doc).toMatch(/No comment body is ever copied into a detail\s+string/);
    expect(doc).toMatch(
      /stores \*\*no copy of the comment body, author, or\s+timestamps\*\*/,
    );
  });

  test('refusals are emitted as events, not dropped', () => {
    expect(doc).toMatch(/Refusals are events too/);
    expect(doc).toMatch(
      /would make the fail-closed behavior\s+indistinguishable from a hang/,
    );
    expect(core).toMatch(/"chatops\.ledger\.refused"/);
  });
});

describe('persistence requirements and invariants (§15, §16)', () => {
  test('one row per ledger scope, by typed columns, with guarded compare-and-set', () => {
    expect(doc).toMatch(/\*\*One ledger row per ledger scope, enforced by the primary key\*\*/);
    expect(doc).toMatch(/\*\*Every transition is a guarded compare-and-set\*\*/);
    expect(doc).toMatch(/"both advanced it" is "both dispatched it"/);
  });

  test('the fence is durable, and the witness file is retention-exempt', () => {
    expect(doc).toMatch(/\*\*The fence is a durable row\*\*/);
    expect(doc).toMatch(/\*\*The epoch witness file is exempt from artifact retention sweeps\.\*\*/);
  });

  test.each([
    ['L1', /One ledger row per comment, forever/],
    ['L2', /Every comment at or below the cursor has a ledger row/],
    ['L3', /No external effect precedes its write-ahead/],
    ['L4', /A retry happens only on proof of no effect/],
    ['L5', /The ledger is never behind the world without fencing/],
    ['L6', /Terminal states are never re-opened automatically/],
    ['L7', /Unauthenticated input changes nothing/],
    ['L8', /Ambiguity is surfaced, never resolved by acting/],
    ['L9', /Local transitions are exactly-once; external dispatch is at-most-once/],
    ['L10', /No row becomes terminal owing an unpublishable marker/],
  ])('%s is stated', (id, pattern) => {
    expect(doc).toMatch(new RegExp(`\\*\\*${id} —`));
    expect(doc).toMatch(pattern);
  });
});

describe('required scenarios (§17)', () => {
  test.each([
    ['crash before dispatch', /Crash after claim but before dispatch/],
    ['crash before ack', /Crash after dispatch but before acknowledgement persistence/],
    ['older restore', /Database restore predating a successful dispatch/],
    ['forged marker', /Forged acknowledgement marker from an untrusted author/],
    ['missing reconciliation data', /Missing or incomplete provider reconciliation data/],
    ['duplicate observation', /Duplicate candidate observation after restart/],
  ])('the required scenario %s has its own section', (_label, pattern) => {
    expect(doc).toMatch(pattern);
  });

  test('the pre-dispatch crash is safe, and the doc says exactly why', () => {
    expect(doc).toMatch(
      /it is safe \*because\* T2 is\s+a separate, later transaction than T1/,
    );
  });

  test('the restore scenario names both detectors and dispatches nothing', () => {
    expect(doc).toMatch(/Two independent detectors fire/);
    expect(doc).toMatch(/Nothing dispatches; every non-terminal row becomes\s+`ambiguous`/);
  });
});
