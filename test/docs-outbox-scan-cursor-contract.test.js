/**
 * Structural tests for docs/outbox-scan-cursor-contract.md (issue #819).
 *
 * The document is the behavioral contract for the persisted three-cursor outbox
 * scan. A cursor rule that silently drifts out of the document is exactly how a
 * pending row gets permanently skipped, so these tests pin the claims a reader
 * must be able to rely on: the three roles, the key derivation and its
 * injectivity argument, the advancement rules, the invariants, the required
 * situations, and the compatibility statement.
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

const doc = read('docs/outbox-scan-cursor-contract.md');
const dispatcher = read('src/handlers/gh-dispatcher.ts');
const cli = read('src/cli/dispatch-outbox.ts');
const admin = read('src/cli/admin.ts');
const store = read('src/stores/sqlite-outbox-store.ts');

describe('docs/outbox-scan-cursor-contract.md — status and scope', () => {
  test('is marked as implemented behavior, not a proposal', () => {
    expect(doc).toMatch(/Status: \*\*implemented\*\*/);
    expect(doc).toMatch(/behavioral contract, not a proposal/);
  });

  test('names the modules it governs', () => {
    expect(doc).toMatch(/src\/handlers\/gh-dispatcher\.ts/);
    expect(doc).toMatch(/src\/core\/outbox-scan-cursor\.ts/);
    expect(doc).toMatch(/src\/cli\/dispatch-outbox\.ts/);
  });

  test('excludes cursor removal, cursor creation and schema redesign', () => {
    expect(doc).toMatch(/removing persisted cursors/);
    expect(doc).toMatch(/creating a cursor row that does not already exist/);
    expect(doc).toMatch(/outbox schema redesign/);
  });

  test('includes retry-triggered cursor rewind as implemented behavior (issue #820)', () => {
    // Was explicitly out of scope until #820 implemented it — the document must
    // now specify it rather than defer it, or an operator retry can strand the
    // very row it was run to recover.
    expect(doc).toMatch(/issue #820 adds retry-triggered cursor rewind/i);
    expect(doc).toMatch(/src\/stores\/sqlite-outbox-store\.ts/);
    expect(doc).toMatch(/src\/cli\/admin\.ts/);
  });

  test('states why a cursor exists at all: fresh process, bounded run, real progress', () => {
    expect(doc).toMatch(/fresh process each time/);
    expect(doc).toMatch(/\*\*permanently stranded row\*\*/);
    expect(doc).toMatch(/`id > afterId`/);
  });
});

describe('docs/outbox-scan-cursor-contract.md — the three roles', () => {
  test('defines floor as the lower bound protecting delayed or retryable rows', () => {
    expect(doc).toMatch(/`floor` \| the dispatch identity, verbatim \| The lower bound that preserves visibility of delayed or retryable rows/);
  });

  test('defines fwd as the protected-zone end driving near-range forward progress', () => {
    expect(doc).toMatch(/`fwd` \(protected-zone end\) \| `<len>:<identity>:fwd`/);
    expect(doc).toMatch(/Forward progress through the near\/current range/);
  });

  test('defines bulk as bounded scanning through older or foreign backlog', () => {
    expect(doc).toMatch(/`bulk` \| `<len>:<identity>:bulk` \| Bounded scanning through older or foreign backlog/);
  });

  test('explains why two cursors were not enough', () => {
    expect(doc).toMatch(/\*\*Why three and not two\.\*\*/);
    expect(doc).toMatch(/pinned at the second delayed row's position/);
  });

  test('defines the protected zone as the re-walked span', () => {
    expect(doc).toMatch(/\*\*Protected zone\*\* \| The id span `\(floor, zoneEnd\]` re-walked in full every run/);
  });
});

describe('docs/outbox-scan-cursor-contract.md — key derivation', () => {
  test('names one shared derivation and forbids building keys elsewhere', () => {
    expect(doc).toMatch(/### 4\.1 One shared derivation/);
    expect(doc).toMatch(/owns the only derivation\. No other module may build a `scan_key` string/);
    expect(doc).toMatch(/deriveOwnershipScanCursorKey/);
    expect(doc).toMatch(/deriveScanCursorKey/);
  });

  test('defines the ownership scope as sessionId plus the repository/provider tuple', () => {
    expect(doc).toMatch(/\[ sessionId, githubOwner, githubName, giteaOwner\|null, giteaRepo\|null, giteaBaseUrl\|null \]/);
    expect(doc).toMatch(/`sessionId` alone is \*\*not\*\* a sufficient scope/);
    expect(doc).toMatch(/`giteaBaseUrl` participates/);
  });

  test('argues identity injectivity from the JSON encoding', () => {
    expect(doc).toMatch(/### 4\.3 Injectivity of the identity/);
    expect(doc).toMatch(/That encoding is injective/);
    expect(doc).toMatch(/no component's content can be mistaken for a delimiter/);
  });

  test('requires a length prefix on the derived keys and explains the suffix collision', () => {
    expect(doc).toMatch(/### 4\.4 Injectivity of the per-role key/);
    expect(doc).toMatch(/\*\*length-prefixed\*\*, not suffixed: `<len>:<identity>:<role>`/);
    expect(doc).toMatch(/identities `foo` and `foo::fwd`/);
    expect(doc).toMatch(/permanently skip its own older pending rows/);
  });

  // The floor key is the identity verbatim, so its key space is "any string":
  // an argument that only covers the derived space would leave identity
  // `3:foo:fwd` addressing identity `foo`'s fwd cursor.
  test('closes the floor-versus-derived collision with a normative rejection rule', () => {
    expect(doc).toMatch(/### 4\.5 Cross-role disjointness/);
    expect(doc).toMatch(/\*\*Normative rule\.\*\* A dispatch identity MUST NOT have the derived-key shape/);
    expect(doc).toMatch(/MUST NOT be empty/);
    expect(doc).toMatch(/rejects both with a `TypeError`/);
    expect(doc).toMatch(/the guarantee is total/);
    expect(doc).toMatch(/disjoint by first byte/);
  });

  test('states that a scope change orphans the old key on purpose', () => {
    expect(doc).toMatch(/### 4\.6 Configuration changes orphan the old key/);
    expect(doc).toMatch(/\*\*intentional orphaning\*\*, not a migration/);
    expect(doc).toMatch(/never looked up again/);
    expect(doc).toMatch(/scanning restarts at row 1/);
    expect(doc).toMatch(/confirmed foreign under the \*old\* filter/);
  });
});

describe('docs/outbox-scan-cursor-contract.md — read path and budget', () => {
  test('discards a fwd or bulk value at or behind the floor', () => {
    expect(doc).toMatch(/\*\*Stale invalidation\.\*\*/);
    expect(doc).toMatch(/carries no information the floor does not already carry/);
  });

  test('defines the budget and why the default bound needs a cursor', () => {
    expect(doc).toMatch(/`scanLimit` \| `opts\.scanLimit`, else `pageSize \* 10` when an identity is set, else `Infinity`/);
    expect(doc).toMatch(/\*\*The default bound is only safe with a cursor\.\*\*/);
    expect(doc).toMatch(/Cursorless dispatch therefore defaults to an unbounded scan/);
  });

  test('reserves Phase B budget only when Phase A consumed the whole scanLimit', () => {
    expect(doc).toMatch(/\*\*Phase B keeps a reserve\.\*\*/);
    expect(doc).toMatch(/\*\*only when Phase A actually consumed the whole `scanLimit`\*\*/);
    expect(doc).toMatch(/never exceeds a caller-supplied `scanLimit`/);
  });
});

describe('docs/outbox-scan-cursor-contract.md — scanning phases', () => {
  test('describes Phase A as a full re-walk of the protected zone', () => {
    expect(doc).toMatch(/### 7\.1 Phase A — re-walk what is still owned/);
    expect(doc).toMatch(/walk `\(floorAfterId, zoneEndAfterId\]`/);
    expect(doc).toMatch(/fetch exactly one row after `floorAfterId`/);
  });

  test('advances the zone cursor only through rows actually examined', () => {
    expect(doc).toMatch(/\*\*only through rows actually examined\*\*/);
    expect(doc).toMatch(/recorded as incomplete/);
  });

  test('forbids resuming from bulk after an incomplete zone walk', () => {
    expect(doc).toMatch(/\*\*Exception — incomplete zone walk\.\*\*/);
    expect(doc).toMatch(/`bulkAfterId` must \*\*not\*\* be used to resume/);
    expect(doc).toMatch(/larger `scanLimit` that walked past the whole zone in one pass/);
    expect(doc).toMatch(/forget those rows permanently/);
  });

  test('states delayed rows must be seen by the scan rather than filtered in SQL', () => {
    expect(doc).toMatch(/does \*\*not\*\* filter by due-time in SQL/);
    expect(doc).toMatch(/must still be \*seen\*/);
  });
});

describe('docs/outbox-scan-cursor-contract.md — advancement rules', () => {
  test('defines the floor rule and its monotonicity', () => {
    expect(doc).toMatch(/nextFloor = stillOpen\.length > 0 \? stillOpen\[0\] - 1 : scanExtentId/);
    expect(doc).toMatch(/Never advances past the earliest still-open owned row/);
    expect(doc).toMatch(/Monotonic non-decreasing/);
  });

  test('defines the fwd rule as inclusive and grow-only when the walk is incomplete', () => {
    expect(doc).toMatch(/\*\*Inclusive, not exclusive\.\*\*/);
    expect(doc).toMatch(/\*\*An incomplete walk may only grow the zone\.\*\*/);
    expect(doc).toMatch(/\*\*At most one row still open leaves the value stale on purpose\.\*\*/);
  });

  test('defines the bulk rule as ungated by open rows and guarded against regression', () => {
    expect(doc).toMatch(/nextBulk = max\(scanExtentId \?\? 0, persisted bulk value \?\? 0\)/);
    expect(doc).toMatch(/\*\*never gated by how many rows remain open\*\*/);
    expect(doc).toMatch(/\*\*Monotonic non-decreasing\*\*, guarded by the `max`/);
  });

  test('states no cursor is written while the maintenance lock is held', () => {
    expect(doc).toMatch(/### 8\.4 Maintenance lock/);
    expect(doc).toMatch(/no cursor is written/);
    expect(doc).toMatch(/store's own in-transaction guard/);
    expect(doc).toMatch(/A refusal is non-destructive/);
  });
});

describe('docs/outbox-scan-cursor-contract.md — invariants', () => {
  test('states the safety property first and names all seven invariants', () => {
    expect(doc).toMatch(/\*\*I1 — No owned pending row is permanently skipped\.\*\*/);
    for (const id of ['I2', 'I3', 'I4', 'I5', 'I6', 'I7']) {
      expect(doc).toMatch(new RegExp(`\\*\\*${id} —`));
    }
  });

  test('states that every still-open row is inside the protected zone, not just its ends', () => {
    expect(doc).toMatch(/not just the first and last/);
  });

  test('justifies skipping a region by prior confirmation plus immutable payloads', () => {
    expect(doc).toMatch(/a row's payload never changes, so it cannot become owned later/);
    expect(doc).toMatch(/A filter change is a scope change/);
  });

  test('states an unexamined row is never treated as confirmed', () => {
    expect(doc).toMatch(/I7 — An unexamined row is never treated as confirmed/);
  });
});

describe('docs/outbox-scan-cursor-contract.md — required situations', () => {
  test('covers multiple delayed rows', () => {
    expect(doc).toMatch(/### 10\.1 Multiple delayed rows/);
    expect(doc).toMatch(/`floor` stops before the earliest; `fwd` reaches the latest/);
  });

  test('covers retry, dead-letter, cancellation and a lost claim', () => {
    expect(doc).toMatch(/### 10\.2 Retry/);
    expect(doc).toMatch(/dead-lettered \(retry budget exhausted\), or cancelled/);
    expect(doc).toMatch(/counted as resolved \*\*only\*\* if it is confirmed sent or dead-lettered/);
  });

  test('covers a foreign backlog crossed in bounded steps', () => {
    expect(doc).toMatch(/### 10\.3 Foreign backlog/);
    expect(doc).toMatch(/each run bounded, the sequence of runs monotone/);
  });

  test('covers scan and page limits changing between runs, in both directions', () => {
    expect(doc).toMatch(/### 10\.4 Scan and page limits change between runs/);
    expect(doc).toMatch(/are \*\*not\*\* persisted/);
    expect(doc).toMatch(/\*\*Shrinking\*\* the budget/);
    expect(doc).toMatch(/\*\*Growing\*\* the budget/);
    expect(doc).toMatch(/never used to skip a zone the current run could not finish walking/);
  });

  test('covers an ownership scope change', () => {
    expect(doc).toMatch(/### 10\.5 Ownership scope change/);
    expect(doc).toMatch(/orphaned and unread/);
  });
});

describe('docs/outbox-scan-cursor-contract.md — compatibility', () => {
  test('states no migration is required or performed', () => {
    expect(doc).toMatch(/\*\*No migration is required, and none is performed\.\*\*/);
  });

  test('pins the floor key as byte-identical to the pre-#819 key', () => {
    expect(doc).toMatch(/byte-identical to the key issue #606 persisted/);
    expect(doc).toMatch(/reproduces the `JSON\.stringify` tuple the CLI built inline before issue #819, byte for byte/);
  });

  test('states missing fwd/bulk rows read as unset in the conservative direction', () => {
    expect(doc).toMatch(/simply read as unset, which is the conservative direction/);
  });

  test('states the schema is unchanged and orphaned rows need no cleanup', () => {
    expect(doc).toMatch(/No schema change: `outbox_scan_cursor` is unchanged/);
    expect(doc).toMatch(/no cleanup step exists or is needed/);
  });
});

describe('docs/outbox-scan-cursor-contract.md — test matrix', () => {
  test('names the test files that carry the coverage', () => {
    expect(doc).toMatch(/test\/outbox-scan-cursor-contract\.test\.js/);
    expect(doc).toMatch(/test\/outbox-scan-cursor-key\.test\.js/);
    expect(doc).toMatch(/test\/docs-outbox-scan-cursor-contract\.test\.js/);
    expect(doc).toMatch(/test\/gh-dispatcher\.test\.js/);
    expect(doc).toMatch(/test\/outbox-retry-cursor-rewind\.test\.js/);
    expect(doc).toMatch(/test\/admin-outbox\.test\.js/);
  });

  test('requires the acceptance cases named by the issue', () => {
    expect(doc).toMatch(/Several simultaneously delayed owned rows/);
    expect(doc).toMatch(/Foreign backlog crossed over successive bounded runs/);
    expect(doc).toMatch(/reduced between runs over a large zone/);
    expect(doc).toMatch(/Ownership scope repointed to another repository/);
    expect(doc).toMatch(/Identity pairs such as `foo` \/ `foo::fwd`/);
    expect(doc).toMatch(/Pre-#819 cursor row read by the current code/);
    expect(doc).toMatch(/Operator retry of a row older than the cursors/);
    expect(doc).toMatch(/Retry whose compare-and-set loses a race/);
    expect(doc).toMatch(/Retry when a cursor role has no persisted row/);
  });
});

describe('docs/outbox-scan-cursor-contract.md — retry-triggered rewind (§13)', () => {
  test('states the stranding an un-rewound retry would cause', () => {
    expect(doc).toMatch(/`admin outbox retry` is the one operation that moves a \*\*row\*\* backward/);
    expect(doc).toMatch(/no future scan for that identity ever looks at it again/);
  });

  test('pins the five rewind rules, including the >= boundary and absent-stays-absent', () => {
    expect(doc).toMatch(/R1 — Rewind at or past\.\*\* A cursor row whose `after_id >= id` is set to `id - 1`/);
    expect(doc).toMatch(/`>=` and not `>`: the scan predicate is strict/);
    expect(doc).toMatch(/R2 — Never overshoot/);
    expect(doc).toMatch(/R3 — Absent stays absent\.\*\* A role with no persisted row is left with none/);
    expect(doc).toMatch(/This is an `UPDATE`, never an upsert/);
    expect(doc).toMatch(/R4 — All or nothing\.\*\* The row update and every rewind commit in \*\*one\*\* SQLite transaction/);
    expect(doc).toMatch(/R5 — Only a real recovery rewinds/);
  });

  test('states that a lost race or maintenance refusal leaves every cursor unchanged', () => {
    expect(doc).toMatch(/all leave every cursor byte-for-byte unchanged/);
  });

  test('derives the retry scope from session configuration, not an operator flag', () => {
    expect(doc).toMatch(/the dispatch identity resolved from the retrying session's configuration/);
    expect(doc).toMatch(/the same tuple, through the same `deriveOwnershipScanCursorKey`/);
  });

  test('argues the rewind preserves I1/I4 and the fencing/idempotency guarantees', () => {
    expect(doc).toMatch(/I1 is strengthened, not weakened/);
    expect(doc).toMatch(/I4 still holds/);
    expect(doc).toMatch(/Fencing is untouched/);
    expect(doc).toMatch(/retrying an already-pending row is still a no-op/);
  });

  test('keeps the preview non-mutating while reporting the affected roles', () => {
    expect(doc).toMatch(/without `--yes` stays non-mutating and additionally reports whether a rewind is required/);
    expect(doc).toMatch(/which \*\*existing\*\* cursor roles it would affect/);
  });
});

describe('docs/outbox-scan-cursor-contract.md — fencing the racing drain (§13.5)', () => {
  test('states why the retry transaction alone is not enough', () => {
    // The transaction makes the row update and the rewind inseparable; it does
    // nothing about a drain that read the cursors before either happened and
    // writes its stale extent back afterwards.
    expect(doc).toMatch(/does \*\*not\*\* make them survive a dispatch run that was already in flight/);
    expect(doc).toMatch(/the pre-retry cursor position restored, the recovered row stranded again/);
  });

  test('pins the five fencing rules', () => {
    expect(doc).toMatch(/F1 — One generation per identity/);
    expect(doc).toMatch(/F2 — Every committed retry bumps it\.\*\* A retry that supplies a cursor scope and commits/);
    expect(doc).toMatch(/whether or not any cursor row actually moved/);
    expect(doc).toMatch(/F3 — Cursor writes carry the observed generation/);
    expect(doc).toMatch(/reads the generation at scan start, \*\*before\*\* it reads the cursors/);
    expect(doc).toMatch(/F4 — A stale generation refuses the write/);
    expect(doc).toMatch(/F5 — Refusal is non-destructive/);
  });

  test('keeps the comparison inside the same transaction as the write it guards', () => {
    expect(doc).toMatch(/comparing outside it would only move the race/);
    expect(store).toMatch(/SELECT epoch FROM outbox_scan_cursor_fence WHERE scan_key = \?/);
    expect(store).toMatch(/ON CONFLICT\(scan_key\) DO UPDATE SET epoch = epoch \+ 1/);
  });

  test('the dispatcher reads the fence before the cursors and passes it to every write', () => {
    // Order is the rule, so it is pinned in the source: a fence read placed
    // after the cursor reads would pass the check while holding pre-rewind
    // values.
    const fenceRead = dispatcher.indexOf('const cursorFenceEpoch =');
    const floorRead = dispatcher.indexOf('const floorAfterId =');
    expect(fenceRead).toBeGreaterThan(-1);
    expect(floorRead).toBeGreaterThan(fenceRead);
    expect(dispatcher).toMatch(/identityKey: floorKey, epoch: cursorFenceEpoch/);
  });
});

describe('docs/outbox-scan-cursor-contract.md — cross-references', () => {
  test('the dispatcher points at this contract', () => {
    expect(dispatcher).toMatch(/docs\/outbox-scan-cursor-contract\.md/);
  });

  test('the CLI points at this contract and uses the shared derivation', () => {
    expect(cli).toMatch(/docs\/outbox-scan-cursor-contract\.md/);
    expect(cli).toMatch(/deriveOwnershipScanCursorKey/);
  });

  test('the admin CLI derives the retry cursor scope with the same shared helpers', () => {
    // An inline key here is the drift that would let `outbox retry` rewind a
    // row the dispatcher never reads (issue #820).
    expect(admin).toMatch(/deriveOwnershipScanCursorKey/);
    expect(admin).toMatch(/planScanCursorRewind/);
    expect(admin).not.toMatch(/cursorIdentityKey: JSON\.stringify\(/);
  });

  test('the store derives all three role keys with the shared helper', () => {
    expect(store).toMatch(/scanCursorKeysFor/);
    expect(store).toMatch(/OUTBOX_SCAN_CURSOR_ROLES/);
    expect(store).toMatch(/UPDATE outbox_scan_cursor SET after_id = \? WHERE scan_key = \? AND after_id >= \?/);
  });

  test('neither module builds a derived cursor key inline any more', () => {
    expect(dispatcher).not.toMatch(/`\$\{floorKey!\.length\}:\$\{floorKey\}/);
    expect(cli).not.toMatch(/scanCursorKey = JSON\.stringify\(/);
  });

  test('contains no absolute filesystem paths', () => {
    expect(doc).not.toMatch(/\/Users\//);
    expect(doc).not.toMatch(/\/home\/[a-z]/);
  });
});
