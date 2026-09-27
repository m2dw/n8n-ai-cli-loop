/**
 * Structural tests for docs/merged-pr-reconciliation-contract.md
 * (issue #1046).
 *
 * The document is the authoritative contract for reconciling a task whose
 * EXACT recorded pull request has already been merged by an operator, back
 * into the task lifecycle — independently of `admin worktree cleanup`.
 * Issue #1046 is a pure specification: no production code changes with it,
 * so these tests pin the document's own claims against drift — the exact
 * recorded PR identity requirement and its never-inferred rule, the live
 * `MERGED` signal, the explicit statement that `ready_for_human` is a
 * common case and not an eligibility requirement, the 26-row normative
 * outcome table with a row for every `TaskStatus` — including the residual
 * rows that close the `claimed`/`running` branch over unusable claim
 * metadata — and its fixed precedence,
 * the `done` target and the preserved `failed`/`cancelled` history, the
 * cross-gate refusal that keeps an unresolved Tool Request closable only
 * through its own resolution surfaces (and the accurate description of what
 * `admin recover`/`TaskStore.recoverTask` actually screen for), the
 * closed audit record and the single new task event, the schema and
 * fail-closed refusal that keep a malformed persisted disposition history
 * from being read, coerced, or overwritten, idempotency,
 * preview/apply, CAS staleness, the fail-closed conditions (provider
 * errors, missing identity, closed-unmerged PRs, unsupported providers),
 * the lifecycle-metadata-only mutation boundary, and the promise that
 * `admin worktree cleanup` is unchanged and gains no `--include-merged`.
 *
 * They are structural only, mirroring the doc-only pin pattern used for
 * docs/unattended-tool-request-contract.md (#919) and
 * docs/verification-execution-contract.md (#918): they pin what the
 * document says, not whether a runtime implements it. The operation core
 * that issue #1047 added (src/core/merged-pr-reconciliation.ts) is pinned
 * behaviorally by test/merged-pr-reconciliation.test.js, and the operator
 * command that issue #1048 added (`admin task reconcile-merged`) by
 * test/admin-task-reconcile-merged.test.js.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Assertions run against a whitespace-normalized copy: the document is
// hard-wrapped prose, so a claim can straddle a line break today and be
// reflowed tomorrow. Normalizing means these tests pin what the document
// says, not how it happens to be wrapped. Row-count assertions use the raw
// text, where "one row per line" is itself the pinned property.
function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8').replace(/\s+/g, ' ');
}

const DOC_PATH = 'docs/merged-pr-reconciliation-contract.md';
const doc = read(DOC_PATH);
const rawDoc = readFileSync(resolve(ROOT, DOC_PATH), 'utf8');
const featureStatus = readFileSync(resolve(ROOT, 'docs/feature-status.md'), 'utf8');
const worktrees = read('docs/per-issue-worktrees.md');

describe(`${DOC_PATH} — status and scope`, () => {
  test('is marked approved design with the core and the operator command implemented', () => {
    expect(doc).toMatch(
      /Status: \*\*approved design, operation core and operator command implemented\*\* \(contract: issue #1046; core: issue #1047; command: issue #1048\)/,
    );
  });

  test('states what #1046 delivered and what #1047/#1048 added', () => {
    expect(doc).toMatch(
      /Issue #1046 delivered this document and its structural contract tests \(`test\/docs-merged-pr-reconciliation-contract\.test\.js`\) only, with no runtime behavior\./,
    );
    expect(doc).toMatch(
      /Issue #1047 added the callable operation core \(`src\/core\/merged-pr-reconciliation\.ts`\)/,
    );
    expect(doc).toMatch(
      /Issue #1048 added the operator command \(§17 slice 3\), `admin task reconcile-merged`/,
    );
    // §16 is still open: the merge commit is absent from every record.
    expect(doc).toMatch(
      /The optional `PullRequest\.mergeCommit` provider field \(§16\) has not landed, so there is still no provider field and the merge commit stays absent from every record\./,
    );
  });

  test('defers to the neighbouring contracts it does not redefine', () => {
    expect(doc).toMatch(
      /fixed by `docs\/per-issue-worktrees\.md`\. This contract changes no classification and adds no cleanup flag/,
    );
    expect(doc).toMatch(
      /fixed by issue #608 \(`TaskStore\.cancelTask`, `admin task cancel`, `admin task reconcile-closed`\)/,
    );
    expect(doc).toMatch(
      /fixed by `src\/core\/pr-reconciliation\.ts` \(issue #998\)/,
    );
    expect(doc).toMatch(/fixed by `docs\/human-gate-no-go-flow\.md` \(#747, design-only\)/);
    expect(doc).toMatch(
      /fixed by `admin recover` and `TaskStore\.recoverTask` \(`RECOVERABLE_STATUSES` = `\["failed", "claimed", "running"\]`\)/,
    );
  });
});

describe(`${DOC_PATH} — closed vocabulary (§3)`, () => {
  test('the outcome set is closed at six values', () => {
    expect(doc).toMatch(
      /`"reconciled" \| "recorded-terminal" \| "already-reconciled" \| "noop-done" \| "active" \| "refused"`/,
    );
  });

  test('the refusal set is closed at ten values', () => {
    expect(doc).toMatch(/`MergedPrReconciliationRefusal` is exactly \(ten values\):/);
    expect(doc).toMatch(
      /`"missing-pr-identity" \| "pr-lookup-failed" \| "identity-mismatch" \| "not-merged" \| "active-recovery-required" \| "invalid-claim-metadata" \| "malformed-disposition-history" \| "tool-request-unresolved" \| "stale-state" \| "store-refused"`/,
    );
  });

  test('the command-level refusal is separate and decided once', () => {
    expect(doc).toMatch(
      /decided once, for the whole invocation, before any task is examined: `"unsupported-provider"`/,
    );
  });

  test('no phase-runner vocabulary is added', () => {
    expect(doc).toMatch(
      /adds no `TaskStatus`, `TaskPhase`, `PhaseRunOutcome`, or `PhaseHandlerResult` member at all/,
    );
  });
});

describe(`${DOC_PATH} — PR identity (§4)`, () => {
  test('the recorded identity is required and never derived', () => {
    expect(doc).toMatch(
      /The unit of reconciliation is \*\*the pull request this task recorded\*\*, never "the Issue", never "a PR that mentions the Issue"/,
    );
    expect(doc).toMatch(
      /A task with no `prUrl`, or with a `prUrl` from which no number can be extracted, is refused `"missing-pr-identity"` — never reconciled/,
    );
  });

  test('every inference route is explicitly excluded', () => {
    expect(doc).toMatch(
      /a bare Issue number; the head-branch convention `ai\/issue-<n>` \(`branchName`\); a search for merged PRs referencing the Issue; the newest merged PR on the base branch; a closing keyword in a PR body/,
    );
    expect(doc).toMatch(
      /`findPullRequestForWorkItem` owns the branch-name convention and is therefore \*\*not\*\* an admissible source of identity here/,
    );
  });

  test('the provider must echo the recorded identity', () => {
    expect(doc).toMatch(
      /Any disagreement is `"identity-mismatch"` — a refusal, never a correction of the recorded identity/,
    );
  });

  test('absent provider fields fail closed', () => {
    expect(doc).toMatch(
      /\*\*4\.4 Absent fields are refusals, not passes\.\*\* A provider response missing `state` has not confirmed a merge/,
    );
  });
});

describe(`${DOC_PATH} — the authoritative signal (§5)`, () => {
  test('a live MERGED read is the only completion signal', () => {
    expect(doc).toMatch(
      /A \*\*live\*\* provider read reporting the PR state `MERGED` is the authoritative external completion signal for the current development workflow/,
    );
    expect(doc).toMatch(
      /not a local `git branch --merged`, not the presence of the commits on the base branch, not a human comment saying "merged", not a closed Issue/,
    );
  });

  test('a cached state is not a signal', () => {
    expect(doc).toMatch(
      /A `state` cached in task context, or carried over from an earlier run, is not a signal/,
    );
  });

  test('provider data decides, never prose', () => {
    expect(doc).toMatch(
      /It never parses CLI error text or human-facing output\. This is the #998 discipline, inherited verbatim: error prose is not a contract/,
    );
  });

  test('the comparison is exactly MERGED and is never widened', () => {
    expect(doc).toMatch(
      /`OPEN` and `CLOSED` are both `"not-merged"`\./,
    );
    expect(doc).toMatch(
      /A host whose vocabulary cannot express `MERGED` is handled at §12\.4, never by widening this comparison/,
    );
  });
});

describe(`${DOC_PATH} — eligibility (§6)`, () => {
  test('ready_for_human is a common case, not a requirement', () => {
    expect(doc).toMatch(
      /\*\*6\.1 `ready_for_human` is a common case, not a requirement\.\*\*/,
    );
    expect(doc).toMatch(/It carries no special authority here, and an implementation must not gate on it/);
    expect(doc).toMatch(/`queued` and `blocked` are equally eligible/);
  });

  test('a live Issue lock withholds every writing outcome', () => {
    expect(doc).toMatch(
      /`IssueWorktreeLock\.inspect` reporting `locked: true` with `stale: false` means a run may be touching that Issue right now/,
    );
    expect(doc).toMatch(/reconciliation never releases it/);
  });

  test('claimed/running defers to recovery and has no force flag', () => {
    expect(doc).toMatch(
      /\*\*6\.3 A `claimed`\/`running` row is never reconciled\.\*\*/,
    );
    expect(doc).toMatch(
      /the result is the refusal `"active-recovery-required"`: `admin recover` owns `RECOVERABLE_STATUSES`, and two writers CAS-ing the same row with no shared lock is exactly the race this contract refuses to enter/,
    );
    expect(doc).toMatch(/There is no force flag for this refusal\./);
  });

  // `ownerRunId` and `leaseExpiresAt` are both optional on `AiTask`, and
  // `isClaimExpired` reports `false` for an absent or unparsable lease. Without
  // an explicit outcome, a `claimed`/`running` row carrying such metadata would
  // match neither "valid claim" nor "expired lease" and its behavior would be
  // left to the implementation, around a possibly still-running task.
  test('unusable claim metadata has its own fail-closed refusal', () => {
    expect(doc).toMatch(
      /\*\*6\.3\.1 Unusable claim metadata is its own refusal\.\*\* §6\.3's two cases are not exhaustive over the rows the store can actually hold\./,
    );
    expect(doc).toMatch(
      /`AiTask\.ownerRunId` and `AiTask\.leaseExpiresAt` are both optional, so a `claimed`\/`running` row can carry \*\*neither\*\* a valid claim \*\*nor\*\* a demonstrably expired lease: `leaseExpiresAt` absent, `leaseExpiresAt` unparsable, or `ownerRunId` absent while a lease is still in the future\./,
    );
    expect(doc).toMatch(
      /it returns `false` outright when the field is absent, and `Date\.parse` of an unparsable value is `NaN`, so `NaN <= Date\.parse\(now\)` is `false` as well/,
    );
    expect(doc).toMatch(
      /With no live Issue lock, every such row is refused `"invalid-claim-metadata"`\./,
    );
    expect(doc).toMatch(
      /any `claimed`\/`running` row that matches neither of §6\.3's cases lands here, so the pair is closed and no inconsistent row is left to implementation choice/,
    );
  });

  // The refusal is deliberately NOT `"active-recovery-required"`: both
  // `admin recover`'s candidate filter and `TaskStore.recoverTask`'s own guard
  // key on `isClaimExpired`, so recovery skips exactly this row.
  test('the new refusal is disjoint from active-recovery-required, with an honest remedy', () => {
    expect(doc).toMatch(
      /`admin recover` selects candidates with `t\.status === "failed" \|\| isClaimExpired\(t, now\)`, and `TaskStore\.recoverTask` independently refuses a `claimed`\/`running` row with `conflict` unless `isClaimExpired` is true\./,
    );
    expect(doc).toMatch(
      /recovery silently skips it; routing the operator there would name a remedy that does nothing/,
    );
    expect(doc).toMatch(
      /The row is treated as \*\*potentially live\*\* regardless — a claim whose lease write was lost is exactly the shape of a run still holding the task — so it is never reconciled and never written/,
    );
    expect(doc).toMatch(
      /\*\*No such repair surface exists today\*\*, and this contract adds none: teaching `recoverTask` to treat unusable claim metadata as expired is a change to recovery, not to reconciliation, and it is out of scope here\./,
    );
    expect(doc).toMatch(
      /§13\.3 still prohibits hand-editing the row as the routine answer\. There is no force flag for this refusal either\./,
    );
  });

  // The recovery path this contract defers to does NOT screen Tool Requests:
  // `admin recover` selects on status + lease expiry and `TaskStore.recoverTask`
  // requeues on the same two facts. Only `recoverHandoff` (the
  // `--from ready_for_human` path) refuses `tool_request_unresolved`. The
  // document must describe that split correctly, or an implementer would
  // assume recovery pre-filters a row that arrives at §7 row 1 with a live
  // request still attached.
  test('the deferred-to recovery path is described as it actually behaves', () => {
    expect(doc).toMatch(
      /`TaskStore\.recoverTask` moves every row it recovers to `queued` \(rows 1–2 of §7\), which this contract then handles\. It decides that from status and lease expiry \*\*alone\*\* — it does not consult `hasUnresolvedToolRequest`, so today an expired `claimed`\/`running` row carrying an unresolved Tool Request \*is\* requeued and arrives at row 1 with the request still live\./,
    );
    expect(doc).toMatch(
      /Only `TaskStore\.recoverHandoff` — the `admin recover --from ready_for_human` path — refuses that case, with `tool_request_unresolved` \(#677\)\./,
    );
    expect(doc).toMatch(
      /§6\.4, not recovery, is what stops a requeued row with a live request from being reconciled/,
    );
  });

  // Cross-gate rule (#677): a live Tool Request closes only through its own
  // resolution surfaces. Reconciling a row to `done` around one strands it,
  // because the resolver's reject→manual-done resume is pinned to
  // `ready_for_human` + `implementation`.
  test('an unresolved Tool Request refuses every writing outcome', () => {
    expect(doc).toMatch(
      /\*\*6\.4 An unresolved Tool Request refuses every writing outcome\.\*\* A task whose context carries a live Tool Request \(`hasUnresolvedToolRequest`, #677 — the authority, and at most one exists per task\) is refused `"tool-request-unresolved"`\./,
    );
    expect(doc).toMatch(
      /A live request closes \*\*only\*\* through its own resolution surfaces — `admin tool-request resolve` \(`manual-done`\/`reject`\) and `admin tool-request grant`\./,
    );
    expect(doc).toMatch(
      /the `manual-done`-after-`reject` resume in `src\/core\/tool-request-resolve\.ts` fires only while `task\.status === "ready_for_human"` and `task\.phase === "implementation"`/,
    );
    expect(doc).toMatch(
      /A reconciliation that moved such a row to `done` would therefore strand the request permanently: the resolver deliberately refuses to requeue a completed task, and no other surface closes it\./,
    );
  });

  test('the Tool Request refusal composes with §7 at a fixed point', () => {
    expect(doc).toMatch(
      /\*\*6\.4\.2 How it composes with §7\.\*\* The refusal is row 17, at precedence step 5 \(§7\.1\): after the `done` short-circuit, after the idempotency check, after every execution-safety row, and before any provider read\./,
    );
    expect(doc).toMatch(
      /It therefore displaces exactly the five writing rows — 1, 3, 5, 12, and 14 — and nothing else\./,
    );
    expect(doc).toMatch(
      /It applies to `failed` and `cancelled` as well: `recorded-terminal` is a write, and a live request on a terminal row is still a request only its own surfaces may close\./,
    );
  });

  test('worktree contents never gate a lifecycle transition', () => {
    expect(doc).toMatch(
      /Not the phase, not the attempt counts, not the presence of a dirty worktree, not unpushed commits, not the age of the row/,
    );
    // The unresolved Tool Request moved OUT of the non-gating list in §6.5 —
    // it is a refusal now (§6.4), so it must not be listed as ignorable.
    expect(doc).not.toMatch(/not unpushed commits, not an unresolved Tool Request/);
    expect(doc).toMatch(
      /they never decide a lifecycle transition/,
    );
  });
});

describe(`${DOC_PATH} — the normative outcome table (§7)`, () => {
  const tableSection = rawDoc
    .split('### 7.1 Precedence')[0]
    .split('## 7. The normative outcome table')[1];
  const rows = tableSection.match(/^\| \d+ \|/gm) ?? [];

  test('carries exactly 26 single-line rows, numbered in order', () => {
    expect(rows).toHaveLength(26);
    rows.forEach((row, i) => expect(row).toBe(`| ${i + 1} |`));
  });

  test('every TaskStatus appears in the table', () => {
    for (const status of [
      'queued',
      'claimed',
      'running',
      'blocked',
      'ready_for_human',
      'done',
      'failed',
      'cancelled',
    ]) {
      expect(tableSection).toContain(`| \`${status}\` |`);
    }
  });

  test('only queued/blocked/ready_for_human reconcile to done', () => {
    expect(tableSection).toContain(
      '| 1 | `queued` | eligible (§6), no live lock | `reconciled` | status → `done`, disposition record, event, comment |',
    );
    expect(tableSection).toContain('| 3 | `blocked` | eligible (§6), no live lock | `reconciled` | as row 1 |');
    expect(tableSection).toContain(
      '| 5 | `ready_for_human` | eligible (§6), no live lock | `reconciled` | as row 1 |',
    );
  });

  test('claimed and running report active or refuse to recovery', () => {
    expect(tableSection).toContain('| 7 | `claimed` | valid claim or live Issue lock | `active` | none |');
    expect(tableSection).toContain(
      '| 8 | `claimed` | expired lease and no live lock | `refused` `"active-recovery-required"` | none |',
    );
    expect(tableSection).toContain('| 9 | `running` | valid claim or live Issue lock | `active` | none |');
    expect(tableSection).toContain(
      '| 10 | `running` | expired lease and no live lock | `refused` `"active-recovery-required"` | none |',
    );
  });

  // Rows 24/25 are the residual of rows 7–10: without them a `claimed` or
  // `running` row whose lease is absent or unparsable falls through the table.
  test('the claimed/running branch has a residual row and no fall-through', () => {
    expect(tableSection).toContain(
      '| 24 | `claimed` | no live lock, and neither a valid claim nor a demonstrably expired lease (§6.3.1) | `refused` `"invalid-claim-metadata"` | none |',
    );
    expect(tableSection).toContain(
      '| 25 | `running` | no live lock, and neither a valid claim nor a demonstrably expired lease (§6.3.1) | `refused` `"invalid-claim-metadata"` | none |',
    );
    expect(doc).toMatch(
      /Rows 24 and 25 are the residual of rows 7–10: they match a `claimed`\/`running` row only after both the valid-claim and the expired-lease conditions have failed, so the `claimed`\/`running` branch has no fall-through \(§6\.3\.1\)\./,
    );
  });

  test('done is an informative no-op that writes nothing', () => {
    expect(tableSection).toContain('| 11 | `done` | always | `noop-done` | none |');
  });

  test('failed and cancelled record the disposition and preserve their status', () => {
    expect(tableSection).toContain(
      '| 12 | `failed` | eligible (§6), no live lock | `recorded-terminal` | disposition record, event, comment; status and phase preserved |',
    );
    expect(tableSection).toContain(
      '| 14 | `cancelled` | eligible (§6), no live lock | `recorded-terminal` | as row 12 |',
    );
  });

  test('the fail-closed rows are present', () => {
    expect(tableSection).toContain(
      '| 18 | any | no recorded PR identity (§4.1) | `refused` `"missing-pr-identity"` | none |',
    );
    expect(tableSection).toContain(
      '| 19 | any | the provider read failed | `refused` `"pr-lookup-failed"` | none |',
    );
    expect(tableSection).toContain(
      '| 21 | any | provider state is not `MERGED`, or absent | `refused` `"not-merged"` | none |',
    );
    expect(tableSection).toContain(
      '| 22 | any | the row moved between observation and write — the CAS lost (§11.4) | `refused` `"stale-state"` | none |',
    );
  });

  // The cross-gate refusal is a row of its own so no writing row can be
  // reached with a live Tool Request attached (§6.4).
  test('the unresolved Tool Request row scopes to the writing rows', () => {
    expect(tableSection).toContain(
      '| 17 | any writing row (1, 3, 5, 12, 14) | the task context carries an unresolved Tool Request (§6.4) | `refused` `"tool-request-unresolved"` | none |',
    );
  });

  // A lost CAS has exactly one outcome. Row 22 owns it; row 23 is reserved
  // for a store refusal that is NOT a CAS conflict, so an implementation can
  // always return one contract-compliant result for a concurrent update.
  test('a lost CAS and a store refusal are disjoint rows', () => {
    expect(tableSection).toContain(
      '| 23 | any | the store refused the write for a reason that is not a lost CAS (`maintenance_locked`, §8.5) | `refused` `"store-refused"` | none |',
    );
    expect(tableSection).not.toContain('CAS lost, `maintenance_locked`');
  });

  test('the idempotency row keys on the full identity, not the PR number', () => {
    expect(tableSection).toContain(
      '| 16 | any | a disposition record whose full identity key (§10.1) equals the currently recorded one already exists | `already-reconciled` | none |',
    );
  });

  // `TaskContext` is `Record<string, unknown>` and `--context-json` merges an
  // arbitrary object into it, so `context.mergedPrReconciliations` can hold a
  // value this contract never wrote. Without row 26 an implementation would be
  // free to overwrite it (destroying a preserved context field) or to misread
  // it as empty (duplicating the audit record and the operator comment).
  test('a malformed disposition history is its own row, ahead of the idempotency read', () => {
    expect(tableSection).toContain(
      '| 26 | any except `done` | `context.mergedPrReconciliations` is present and is not a valid disposition history (§9.2.4) | `refused` `"malformed-disposition-history"` | none |',
    );
    expect(doc).toMatch(
      /\*\*Rows 26 then 16\*\* \(the disposition history\), from the task row alone and in that order: the history is \*validated\* before it is \*read\*\./,
    );
    expect(doc).toMatch(
      /A malformed history cannot answer "has this PR already been reconciled", so no conclusion may be drawn from it — including `already-reconciled`\./,
    );
    expect(doc).toMatch(
      /It also outranks the execution-safety rows: the defect must be repaired whatever the run does, and answering `active` would hide a data defect that is still there once the run ends\./,
    );
    expect(doc).toMatch(
      /Row 26 excludes `done` because row 11 short-circuits first and reads no history at all\./,
    );
  });

  test('precedence is fixed, cheap-first, and short-circuits done', () => {
    expect(doc).toMatch(
      /\*\*Session provider support\*\* \(§12\.4\) is decided once, before any task is read/,
    );
    expect(doc).toMatch(
      /It short-circuits first, so a finished task never consumes a provider call and never reports `active`/,
    );
    expect(doc).toMatch(
      /decided from the task row and the Issue lock, with no provider call\. A live run is reported as such whether or not its PR is merged/,
    );
    expect(doc).toMatch(
      /\*\*Row 17\*\* \(`"tool-request-unresolved"`\): the cross-gate refusal of §6\.4, decided from the task row with no provider call, after every non-writing row has had its chance to match\./,
    );
    expect(doc).toMatch(/\*\*Identity and signal\*\* \(rows 18 → 19 → 20 → 21\), in that order/);
    expect(doc).toMatch(/\*\*The write\*\* \(rows 22, 23\)/);
  });

  test('the six table rules stand', () => {
    expect(doc).toMatch(
      /\*\*R1 — Every status is covered\.\*\* The eight `TaskStatus` values each appear in at least one row\. There is no default, no "other", and no status whose behavior is left to the implementation\./,
    );
    expect(doc).toMatch(
      /\*\*R2 — Only three statuses transition\.\*\* `queued`, `blocked`, and `ready_for_human` are the only statuses whose \*status\* changes, and the only status they change to is `done`/,
    );
    expect(doc).toMatch(
      /\*\*R3 — Terminal history is preserved\.\*\*/,
    );
    expect(doc).toMatch(
      /a merged PR does not retroactively make a failure a success/,
    );
    expect(doc).toMatch(
      /\*\*R4 — Active means report, never act\.\*\* `active` and `"active-recovery-required"` write nothing at all — no record, no event, no comment/,
    );
    expect(doc).toMatch(
      /\*\*R5 — Refusals never partially apply\.\*\* A refusal leaves the task byte-identical to how it was found/,
    );
    expect(doc).toMatch(
      /\*\*R6 — Coverage is per row, not per status\.\*\* Every status is covered by rows whose conditions are exhaustive over the rows the store can hold, including inconsistent ones\./,
    );
    expect(doc).toMatch(
      /rows 7–10 plus the residual rows 24–25 leave no `claimed`\/`running` row unmatched, so unusable claim metadata has a named outcome \(§6\.3\.1\) rather than an implementation-chosen one/,
    );
  });
});

describe(`${DOC_PATH} — the applied transition (§8)`, () => {
  test('the target is done with the phase unchanged, never cancelled', () => {
    expect(doc).toMatch(
      /`reconciled` sets `status: "done"` and leaves `phase` unchanged/,
    );
    expect(doc).toMatch(
      /No new status is introduced, and `cancelled` is never used/,
    );
  });

  test('reconciliation is named as the first writer of done', () => {
    expect(doc).toMatch(
      /No runtime path writes `done` today — `nextPhaseAfter` \(`src\/core\/transitions\.ts`\) never returns it, no handler patches it, and every occurrence in `src\/` is a read/,
    );
    expect(doc).toMatch(
      /An implementation must not "fix" the reads to accommodate a different target status/,
    );
  });

  test('the terminal record issues no status or phase patch', () => {
    expect(doc).toMatch(
      /It issues no status patch and no phase patch, and it removes or rewrites no other context field/,
    );
  });

  test('the write, the event, and the comment commit together', () => {
    expect(doc).toMatch(
      /commit in \*\*one\*\* transaction, in the shape `completePhaseWithEffects` and `cancelTaskWithEffects` already establish \(issue #701\/#608\)/,
    );
    expect(doc).toMatch(
      /A crash must not be able to leave a task `done` with no record of why/,
    );
  });

  test('a held maintenance lock refuses the whole call', () => {
    expect(doc).toMatch(
      /Under a held maintenance lock the whole call refuses with `"store-refused"` and touches nothing \(issue #818\)/,
    );
  });
});

describe(`${DOC_PATH} — audit (§9)`, () => {
  test('exactly one new task event exists and only writing outcomes append it', () => {
    expect(doc).toMatch(
      /Exactly \*\*one\*\* new task event type exists: `task\.merged_pr_reconciled`/,
    );
    expect(doc).toMatch(
      /never by `active`, `noop-done`, `already-reconciled`, or any refusal/,
    );
  });

  test('the required audit fields are all present and closed', () => {
    const auditSection = rawDoc.split('### 9.2')[0].split('### 9.1 The event')[1];
    for (const field of [
      'prNumber',
      'prUrl',
      'providerState',
      'mergeCommit',
      'observedAt',
      'previousStatus',
      'previousPhase',
      'outcome',
    ]) {
      expect(auditSection).toContain(`| \`${field}\` |`);
    }
    expect(doc).toMatch(/`data` carries, and is closed at:/);
  });

  test('the disposition history is append-only and rides on terminal rows too', () => {
    expect(doc).toMatch(
      /persisted on the task as one entry in `task\.context\.mergedPrReconciliations` — an \*\*append-only, identity-keyed list\*\*, never a single value/,
    );
    expect(doc).toMatch(
      /which is how a `failed` or `cancelled` task carries the external merged disposition without losing its status/,
    );
  });

  // A superseding PR on an already-terminal task must be storable: one value
  // could hold only one of the two dispositions, and overwriting the first
  // would erase the terminal history R3/§13 protect.
  test('a second terminal disposition is appended beside the first, never merged or refused', () => {
    expect(doc).toMatch(
      /At most one entry exists per key.*No entry is ever rewritten in place, removed, reordered, or merged into another/,
    );
    expect(doc).toMatch(
      /reaches `recorded-terminal` a second time \(row 12\/14\) and appends B's entry \*\*beside\*\* A's/,
    );
    expect(doc).toMatch(
      /Refusing the second merge is equally wrong: B really was merged, and the disposition would go unrecorded/,
    );
    expect(doc).toMatch(
      /Reconciliation never prunes, truncates, or compacts it; nothing else may either/,
    );
  });

  // The persisted list is a plain context key on an untyped context bag, so
  // the contract has to say what a readable history IS before it can promise
  // append-only preservation of one.
  test('the disposition history has an explicit schema, with absence valid', () => {
    expect(doc).toMatch(
      /\*\*9\.2\.4 The history is validated before it is read\.\*\* `TaskContext` is `Record<string, unknown>` \(`src\/core\/task\.ts`\) and nothing validates its members/,
    );
    expect(doc).toMatch(
      /`admin enqueue-task --context-json` merges an arbitrary JSON object into a new task's context after checking only that the argument is a JSON \*object\*/,
    );
    expect(doc).toMatch(
      /\*\*absent\*\* — the key is not present\. That means "no disposition recorded", is the normal shape of a task before its first reconciliation, and is never a refusal/,
    );
    expect(doc).toMatch(
      /a JSON \*\*array\*\*, possibly empty, in which every element is a JSON object carrying a non-empty string `prUrl` and an integer `prNumber`, and no two elements share the same §10\.1 identity key/,
    );
  });

  test('every malformed shape is enumerated and named as one refusal', () => {
    expect(doc).toMatch(
      /Anything else is \*\*malformed\*\* and the task is refused `"malformed-disposition-history"` \(§12\.6\.2\): a present value that is not an array — including `null`, a string \(even one whose text is JSON\), a number, a boolean, or an object — an element that is not an object, an element whose `prUrl` or `prNumber` is absent or of the wrong type or whose `prUrl` is empty, or two entries sharing one identity key, which §9\.2\.1 says cannot exist\./,
    );
  });

  test('validation is whole-list, and unknown entry fields stay tolerated', () => {
    expect(doc).toMatch(
      /\*\*9\.2\.5 Validation is whole-list, and tolerant only of unknown fields\.\*\* One malformed element refuses the whole task\./,
    );
    expect(doc).toMatch(
      /the entry an implementation would skip is exactly the one that might already record this PR, and skipping it turns row 16 into a duplicate append — a second audit record and a second operator-visible comment for one merge/,
    );
    expect(doc).toMatch(
      /an element carrying fields \*\*beyond\*\* §9\.1's is not malformed: unknown fields are preserved verbatim and never validated/,
    );
    expect(doc).toMatch(
      /only the identity key must be readable, because only the key decides row 16/,
    );
  });

  test('a malformed history is never repaired, and the remedy is stated honestly', () => {
    expect(doc).toMatch(
      /\*\*9\.2\.6 A malformed history is never repaired, coerced, or replaced\.\*\* An implementation must not wrap a lone object in an array, must not `JSON\.parse` a string that looks like a list, must not drop, truncate, or normalize the value, and must not treat it as an empty list and append beside it\./,
    );
    expect(doc).toMatch(
      /The refusal writes nothing at all, so the row is left byte-identical \(§7\.2 R5\)\./,
    );
    expect(doc).toMatch(
      /\*\*No supported task-context repair surface exists today\*\*, and this contract adds none: a `context` patch command is a change to task-context management, not to reconciliation, and it is out of scope here\./,
    );
    expect(doc).toMatch(
      /Until one lands the refusal is terminal for this contract, which is the fail-closed outcome §12\.5 requires, and §13\.3 still prohibits hand-editing the row as the routine answer\./,
    );
  });

  test('local paths and synthesized merge commits are never recorded', () => {
    expect(doc).toMatch(
      /No `repoRoot`, no `artifactRoot`, no worktree path, in the event, the record, or the comment/,
    );
    expect(doc).toMatch(
      /`sanitizeBody\(body, sessionRedactionPaths\(session\)\)`, exactly as `admin task cancel` \/ `task reconcile-closed` already do/,
    );
    expect(doc).toMatch(/\*\*Never a synthesized merge commit\.\*\* Absent stays absent/);
  });

  test('the comment mutates no label', () => {
    expect(doc).toMatch(
      /\*\*No label mutation is performed\*\* — the `admin task cancel` reason applies unchanged/,
    );
    expect(doc).toMatch(
      /intake reads work-item state only, never local task status/,
    );
  });
});

describe(`${DOC_PATH} — idempotency (§10)`, () => {
  test('a repeat on the same PR writes nothing', () => {
    expect(doc).toMatch(
      /is `already-reconciled`: it writes nothing, appends no event, and posts no comment/,
    );
  });

  test('the key is the full (prUrl, prNumber) identity, never the number alone', () => {
    expect(doc).toMatch(
      /\*\*10\.1 The key is the complete PR identity\.\*\* It is the pair `\(prUrl, prNumber\)`, both compared verbatim/,
    );
    expect(doc).toMatch(
      /whose `prUrl` \*\*and\*\* `prNumber` both equal the currently recorded ones is `already-reconciled`/,
    );
    expect(doc).toMatch(
      /a key that stored only `prNumber` would report `already-reconciled` for a `prUrl` that now points at a \*different repository's\* PR that happens to carry the same number/,
    );
  });

  test('the idempotency check never runs over an unvalidated history', () => {
    expect(doc).toMatch(
      /The check runs only against a history §9\.2\.4 has already validated; it is never evaluated over an unvalidated value, and a value it cannot validate is row 26, not "no entry found"\./,
    );
  });

  test('the key excludes the outcome, the time, and any run id', () => {
    expect(doc).toMatch(
      /The key deliberately excludes the outcome, the observation time, and any run id/,
    );
  });

  test('a superseding PR is evaluated afresh and no entry is overwritten', () => {
    expect(doc).toMatch(
      /the identities differ, so §7 is evaluated afresh\. A row the earlier reconciliation left `done` short-circuits at row 11 \(`noop-done`\); a `failed` or `cancelled` row reaches row 12\/14 again and \*\*appends\*\* the new PR's entry beside the old one \(§9\.2\.2\)\. An entry is never overwritten in place\./,
    );
  });
});

describe(`${DOC_PATH} — preview, apply, and staleness (§11)`, () => {
  test('preview is the default and performs no write', () => {
    expect(doc).toMatch(
      /An invocation previews unless an explicit apply flag is given/,
    );
    expect(doc).toMatch(
      /A preview performs every read — including the live provider read — and performs \*\*no\*\* write/,
    );
  });

  test('a preview is not a promise', () => {
    expect(doc).toMatch(
      /The apply re-reads the task row and re-evaluates §7 from scratch\. Any conclusion carried over from the preview is a defect\./,
    );
  });

  test('the write is CAS and a lost CAS is stale-state, never a retry loop', () => {
    expect(doc).toMatch(
      /The transition CAS-es on the `\(status, phase, ownerRunId, revision\)` observed during this invocation's read/,
    );
    expect(doc).toMatch(
      /if a run claims the row between the safety check and the write, the expected status no longer matches and the write loses/,
    );
    expect(doc).toMatch(
      /Never a retry loop, never a re-read-and-force, never a widened expectation/,
    );
  });

  // Without `revision` the CAS misses a concurrent write that moved the very
  // identity the reconciliation was decided from — `context.prUrl` — while
  // leaving status/phase/ownerRunId alone.
  test('revision is a required CAS component, not an optional one', () => {
    expect(doc).toMatch(/\*\*`revision` is not optional\.\*\*/);
    expect(doc).toMatch(
      /a patch that rewrites `context\.prUrl` to a different PR, or rewrites the disposition history of §9\.2, while leaving `status`, `phase`, and `ownerRunId` untouched/,
    );
    expect(doc).toMatch(
      /An implementation may substitute an equivalent whole-row identity snapshot, but never a narrower expectation/,
    );
  });

  test('stale-state and store-refused are disjoint with distinct remedies', () => {
    expect(doc).toMatch(
      /A lost CAS is \*\*never\*\* `"store-refused"`: the two refusals are disjoint, and `"store-refused"` is reserved for a store refusal that is not a CAS conflict — today exactly §8\.5's `maintenance_locked`/,
    );
    expect(doc).toMatch(
      /a stale row wants a re-run, a held maintenance lock wants a wait/,
    );
  });

  test('reconciliation takes no lock because it touches no filesystem', () => {
    expect(doc).toMatch(
      /it acquires neither the Issue worktree lock nor the repo lock/,
    );
  });
});

describe(`${DOC_PATH} — fail-closed conditions (§12)`, () => {
  test('a failed provider read never becomes "not merged"', () => {
    expect(doc).toMatch(
      /"The PR is not merged" is never inferred from a failed read, and a failed read never falls back to a second lookup strategy/,
    );
  });

  test('a closed-unmerged PR is refused and routed to the cancellation surface', () => {
    expect(doc).toMatch(
      /Closing a PR is not completing work, and this contract has no outcome for it: the operator's route for an abandoned Issue is `admin task reconcile-closed` \(#608\), which cancels/,
    );
  });

  test('an unsupported provider refuses the whole invocation, with Gitea named', () => {
    expect(doc).toMatch(
      /the whole invocation refuses with `"unsupported-provider"` before any task is examined/,
    );
    expect(doc).toMatch(
      /`GiteaRepoHostProvider` maps `state` verbatim from Gitea's `open`\/`closed`, so a merged Gitea PR is indistinguishable from a closed-unmerged one/,
    );
    expect(doc).toMatch(
      /Widening §5\.4 to treat `closed` as merged would cancel-by-merge every abandoned PR on that host, and is prohibited/,
    );
  });

  test('a live Tool Request is a refusal, not an advisory', () => {
    expect(doc).toMatch(
      /\*\*12\.6 Unresolved Tool Requests\.\*\* A live Tool Request is `"tool-request-unresolved"` \(§6\.4\), never a note on an otherwise applied reconciliation and never a warning the operator may ignore\./,
    );
  });

  test('unusable claim metadata is a refusal, never a pass', () => {
    expect(doc).toMatch(
      /\*\*12\.6\.1 Unusable claim metadata\.\*\* A `claimed`\/`running` row whose claim is neither valid nor demonstrably expired is `"invalid-claim-metadata"` \(§6\.3\.1\), never a pass, never folded into `"active-recovery-required"`, and never reconciled on the assumption that a missing lease means a dead run\./,
    );
  });

  test('a malformed disposition history fails closed and is never rewritten', () => {
    expect(doc).toMatch(
      /\*\*12\.6\.2 Malformed disposition history\.\*\* A present `context\.mergedPrReconciliations` that is not a valid disposition history \(§9\.2\.4\) is `"malformed-disposition-history"`\. It is never repaired, never coerced, never overwritten, and never read as an empty list/,
    );
    expect(doc).toMatch(
      /appending would risk a duplicate record and a duplicate operator-visible comment for one merge, and overwriting would destroy a context field this contract promises to preserve/,
    );
  });

  test('no force flag overrides a refusal', () => {
    expect(doc).toMatch(
      /\*\*12\.7 No force flag\.\*\* No flag overrides `"not-merged"`, `"identity-mismatch"`, `"missing-pr-identity"`, `"active-recovery-required"`, `"invalid-claim-metadata"`, `"malformed-disposition-history"`, or `"tool-request-unresolved"`/,
    );
  });
});

describe(`${DOC_PATH} — mutation boundary (§13)`, () => {
  test('the complete set of writes is enumerated', () => {
    expect(doc).toMatch(
      /The complete set of writes is: the task row's `status`\/`context` patch, one task event, and one work-item comment effect/,
    );
  });

  test('nothing on disk or on the work item is ever mutated', () => {
    expect(doc).toMatch(
      /never removes a worktree, never releases or force-releases a lock, never deletes or creates a branch, never runs any `git` write, never deletes a file, never prunes an artifact directory, never mutates a label, and never closes, reopens, or edits a work item/,
    );
    expect(doc).toMatch(/There is no flag that makes it do any of these\./);
  });

  test('direct SQLite editing is prohibited as the normal path', () => {
    expect(doc).toMatch(
      /\*\*13\.3 Direct SQLite editing is not the normal path\.\*\*/,
    );
    expect(doc).toMatch(
      /so the merge becomes invisible to audit and to the intervention metrics/,
    );
  });
});

describe(`${DOC_PATH} — worktree cleanup is unchanged (§14)`, () => {
  test('cleanup performs no merged-PR scan, provider call, or advisory', () => {
    expect(doc).toMatch(
      /Cleanup performs \*\*no\*\* merged-PR scan, makes \*\*no\*\* provider call, and prints \*\*no\*\* merged-PR advisory/,
    );
  });

  test('the active status set is unchanged', () => {
    expect(doc).toMatch(
      /`ACTIVE_TASK_STATUSES` stays exactly `queued`\/`claimed`\/`running`\/`blocked`\/`ready_for_human`, and an awaiting-human task's durable Issue worktree is still never removed/,
    );
  });

  test('no --include-merged flag is added', () => {
    expect(doc).toMatch(
      /\*\*14\.3 No `--include-merged`\.\*\* No flag is added to cleanup by this contract or by any implementation of it\./,
    );
  });

  test('the composition is incidental and neither command invokes the other', () => {
    expect(doc).toMatch(
      /Cleanup never learns that a merge is why\. Reconciliation never learns that a worktree exists\./,
    );
    expect(doc).toMatch(
      /Neither command invokes the other, and an operator may run either alone/,
    );
  });
});

describe(`${DOC_PATH} — neighbouring surfaces (§15)`, () => {
  test('cancellation is explicitly prohibited as a merge representation', () => {
    expect(doc).toMatch(
      /Using either to represent a successful external merge is prohibited/,
    );
    expect(doc).toMatch(
      /it corrupts the L3 intervention signal that distinguishes abandoned work from delivered work/,
    );
  });

  test('#998 stays a different problem with no shared code path', () => {
    expect(doc).toMatch(
      /`"not-open"` is one of its refusals\. This contract decides whether a task may be completed because its recorded PR is \*\*merged\*\*/,
    );
    expect(doc).toMatch(
      /the name similarity must not become an invitation to merge them/,
    );
  });

  test('the Human Gate stays the normal route', () => {
    expect(doc).toMatch(
      /Reconciliation is the \*\*irregular\*\* path/,
    );
    expect(doc).toMatch(
      /must not make reconciliation a prerequisite for the gate/,
    );
  });

  test('the Tool Request resolution surfaces stay the only route out', () => {
    expect(doc).toMatch(
      /### 15\.4 A Tool Request closes only through its own surfaces/,
    );
    expect(doc).toMatch(
      /`TaskStore\.recoverHandoff` returns `tool_request_unresolved` \(#677\), the Human Gate refuses feedback and `apply` on the same condition \(`docs\/human-gate-no-go-flow\.md` §6\.1\), review admission and retention both exclude the task \(`src\/core\/review-admission\.ts`, `src\/core\/retention\.ts`\)\. §6\.4 adds this contract to that list\./,
    );
    // The one surface that does not check it is named, so no implementer
    // mistakes today's `recoverTask` behavior for the intended rule.
    expect(doc).toMatch(
      /The one surface that does \*\*not\*\* check it is `TaskStore\.recoverTask` \(§6\.3\) — that is a description of today's behavior, not a licence to copy it\./,
    );
  });
});

describe(`${DOC_PATH} — the merge-commit port gap (§16)`, () => {
  test('the gap is stated honestly against the shipped provider types', () => {
    expect(doc).toMatch(
      /`PullRequest` \(`src\/providers\/types\.ts`\) carries no merge commit, and the GitHub provider's `PR_FIELDS` does not request one, so \*\*today the merge commit is always absent\*\*/,
    );
  });

  test('absence never blocks and is never filled in', () => {
    expect(doc).toMatch(
      /\*\*Absence never blocks reconciliation\*\* — `MERGED` is the signal/,
    );
    expect(doc).toMatch(
      /never derived from a local `git log`, never taken from the base-branch tip, and never guessed from the PR head/,
    );
  });
});

describe(`${DOC_PATH} — decomposition and invariants (§17–§19)`, () => {
  const decompSection = rawDoc
    .split('## 18. Invariants')[0]
    .split('## 17. Implementation decomposition (proposal)')[1];
  const rows = decompSection.match(/^\| \d+ \|/gm) ?? [];

  test('the decomposition is a proposal that creates no Issues', () => {
    expect(doc).toMatch(/\*\*No implementation Issues are created by this document\.\*\*/);
    expect(doc).toMatch(
      /it awaits human approval, and the tracker — not this document — assigns numbers and may re-cut the slices/,
    );
  });

  test('carries exactly 5 slices, numbered in order', () => {
    expect(rows).toHaveLength(5);
    rows.forEach((row, i) => expect(row).toBe(`| ${i + 1} |`));
  });

  test('the sixteen invariants stand', () => {
    const invariants = rawDoc.split('## 19. Contract tests')[0].split('## 18. Invariants')[1];
    for (let i = 1; i <= 16; i++) {
      expect(invariants).toContain(`**I${i}**`);
    }
    expect(doc).toMatch(
      /\*\*I16\*\* A present `context\.mergedPrReconciliations` that is not a valid disposition history \(§9\.2\.4\) is refused `"malformed-disposition-history"` before it is read for idempotency; it is never coerced, repaired, overwritten, or read as an empty list\./,
    );
    expect(doc).toMatch(
      /\*\*I13\*\* The write CAS-es on the observed `revision` as well as `\(status, phase, ownerRunId\)`, and a lost CAS is always `"stale-state"` and never `"store-refused"`/,
    );
    expect(doc).toMatch(
      /\*\*I14\*\* The disposition history is append-only and keyed by the complete PR identity `\(prUrl, prNumber\)`; no entry is ever overwritten, removed, or keyed by the PR number alone/,
    );
    expect(doc).toMatch(
      /\*\*I3\*\* `ready_for_human` is never an eligibility requirement/,
    );
    expect(doc).toMatch(
      /\*\*I4\*\* Every `TaskStatus` has an explicit outcome in §7; there is no default branch/,
    );
    expect(doc).toMatch(
      /\*\*I7\*\* `claimed` and `running` are never reconciled, including when their claim metadata is unusable: that row is refused `"invalid-claim-metadata"`, never treated as an expired claim\./,
    );
    expect(doc).toMatch(
      /\*\*I15\*\* A task carrying an unresolved Tool Request is never written by reconciliation; it is refused `"tool-request-unresolved"`, and the request closes only through `tool-request resolve`\/`grant`/,
    );
    expect(doc).toMatch(
      /\*\*I11\*\* `admin worktree cleanup` gains no flag, no provider call, and no advisory output/,
    );
  });

  test('the docs pin names this test file and the command test file', () => {
    expect(doc).toMatch(/test\/docs-merged-pr-reconciliation-contract\.test\.js/);
    expect(doc).toMatch(/test\/admin-task-reconcile-merged\.test\.js/);
  });

  // §14.6 (issue #1048): the disk-pressure sequence is documented as
  // guidance, and explicitly NOT as a coupling — the whole point of §14 is
  // that cleanup is unchanged and neither command invokes the other.
  test('§14.6 states the three-stage disk-pressure sequence as a recommendation only', () => {
    expect(doc).toMatch(
      /\*\*14\.6 The disk-pressure sequence is a recommendation, in three stages\.\*\*/,
    );
    expect(doc).toMatch(
      /\(1\) run the ordinary `admin worktree cleanup`; \(2\) only if more space must still be reclaimed, preview `admin task reconcile-merged` and then apply it with `--yes`; \(3\) run the same, unchanged `admin worktree cleanup` again/,
    );
    expect(doc).toMatch(
      /it adds no flag, no automatic invocation, and no ordering requirement to either command/,
    );
  });
});

describe(`${DOC_PATH} — delivery notes in neighbouring documents`, () => {
  test('docs/feature-status.md carries an available row for the contract', () => {
    const heading = '#### Merged-PR task reconciliation';
    const idx = featureStatus.indexOf(heading);
    expect(idx).toBeGreaterThan(-1);
    const nextIdx = featureStatus.indexOf('\n#### ', idx + heading.length);
    const block = featureStatus
      .slice(idx, nextIdx === -1 ? featureStatus.length : nextIdx)
      .replace(/\s+/g, ' ');
    expect(block).toMatch(/\*\*Status:\*\* `available`/);
    expect(block).toMatch(/merged-pr-reconciliation-contract\.md/);
    expect(block).toMatch(/no `--include-merged`/);
    expect(block).toMatch(/admin task reconcile-merged/);
  });

  test('docs/per-issue-worktrees.md records that cleanup performs no merged-PR scan', () => {
    expect(worktrees).toMatch(
      /`cleanup` performs no merged-PR scan, makes no provider call, and prints no merged-PR advisory/,
    );
    expect(worktrees).toMatch(/merged-pr-reconciliation-contract\.md/);
  });

  test('docs/per-issue-worktrees.md documents the two-stage disk-space workflow', () => {
    expect(worktrees).toMatch(/admin task reconcile-merged/);
    expect(worktrees).toMatch(
      /run `cleanup`; if more space must still be reclaimed, preview and apply `admin task reconcile-merged`; then run the same, unchanged `cleanup` again/,
    );
  });
});
