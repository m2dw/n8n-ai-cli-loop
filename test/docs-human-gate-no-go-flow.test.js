/**
 * Contract tests for docs/human-gate-no-go-flow.md (issue #747).
 *
 * The Human Gate No-go flow is specified as documentation before any
 * implementation lands, so these tests are the only mechanical check that the
 * spec stays internally consistent AND consistent with the contracts it claims
 * to be built on. They are deliberately not "does the doc contain a nice
 * sentence" tests; each one fails on a specific class of contradiction the
 * issue calls out:
 *
 *   - contradictory state names (the superseded PR #556 vocabulary reappearing,
 *     or the state/disposition sets drifting apart between sections);
 *   - missing required `humanGate` fields;
 *   - stale gate reuse (a new gate inheriting resolved feedback or apply
 *     metadata);
 *   - unsafe recovery (a live gate requeued by generic recovery, or terminal
 *     dispositions becoming recoverable — checked against the real
 *     `RECOVERABLE_STATUSES` constant, not just the prose);
 *   - unsafe command construction (free-form text reaching a suggested
 *     command);
 *   - naming a port method, task status, or store result code that does not
 *     exist in the current tree.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const doc = read('docs/human-gate-no-go-flow.md');
const reviewReturnDoc = read('docs/human-review-return-flow.md');
const taskTs = read('src/core/task.ts');
const taskStoreTs = read('src/core/task-store.ts');
const outboxTs = read('src/core/outbox.ts');
const adminTs = read('src/cli/admin.ts');

/** Text between two headings (end exclusive); `endMarker` omitted means to EOF. */
function section(startMarker, endMarker) {
  const start = doc.indexOf(startMarker);
  if (start === -1) throw new Error(`section start not found: ${startMarker}`);
  const from = start + startMarker.length;
  if (endMarker === undefined) return doc.slice(from);
  const end = doc.indexOf(endMarker, from);
  if (end === -1) throw new Error(`section end not found: ${endMarker}`);
  return doc.slice(from, end);
}

/** First column of every markdown table row whose first cell is a `backticked_token`. */
function firstColumnTokens(text) {
  return [...text.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
}

/** Every `backticked_lowercase_token` in a chunk of text. */
function backtickedTokens(text) {
  return [...text.matchAll(/`([a-z][a-z_]*)`/g)].map((m) => m[1]);
}

/**
 * Members of a TypeScript `export type X = "a" | "b";` union.
 *
 * Terminated on the blank line after the declaration rather than on the first
 * `;`: `TaskStatus`'s trailing comment contains a semicolon, so a `;`-anchored
 * match silently truncates the union before `"cancelled"` — exactly the kind of
 * false agreement these tests exist to prevent.
 */
function unionMembers(source, typeName) {
  const m = source.match(new RegExp(`export type ${typeName} =([\\s\\S]*?)\\n\\n`));
  if (!m) throw new Error(`union not found: ${typeName}`);
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

/** Body of a TypeScript `export interface X { ... }` declaration. */
function interfaceBody(source, name) {
  const start = source.indexOf(`export interface ${name} {`);
  if (start === -1) throw new Error(`interface not found: ${name}`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end);
}

const CANONICAL_STATES = ['open', 'applying', 'apply_failed', 'held', 'resolved'];
const CANONICAL_DISPOSITIONS = [
  'continue_fix',
  'continue_fix_recreate_pr',
  'split_followup',
  'supersede',
  'close_not_planned',
  'hold_for_discussion',
];

describe('docs/human-gate-no-go-flow.md — provenance', () => {
  test('declares itself the replacement for #554 / PR #556 and marks PR #556 non-authoritative', () => {
    expect(doc).toMatch(/replaces issue #554 and PR #556/i);
    expect(doc).toMatch(/PR #556[\s\S]{0,400}must not be\s*\n?merged or copied/i);
  });

  test('names the current-tree sources it is reconciled against', () => {
    for (const anchor of [
      'src/core/task.ts',
      'src/core/task-store.ts',
      'src/core/outbox.ts',
      'src/stores/sqlite-task-store.ts',
      'src/cli/admin.ts',
      'admin-task-handoff-ports-contract.md',
      'DOMAIN.md',
    ]) {
      expect(doc).toContain(anchor);
    }
  });

  test('is documentation-only: no CLI/store/provider code is changed here', () => {
    expect(doc).toMatch(/documentation-only issue/i);
  });
});

describe('docs/human-gate-no-go-flow.md — one canonical state vocabulary', () => {
  const stateTable = section('**Gate states**', '**Dispositions**');
  const applyTable = section('5. Gate state admits this call:', '`gate_resolved` is the idempotency');
  const recovery = section('### 7.3 Recovery eligibility', '## 8. Advice');

  test('the gate-state table declares exactly the canonical states', () => {
    expect(firstColumnTokens(stateTable).sort()).toEqual([...CANONICAL_STATES].sort());
  });

  test("apply's eligibility table covers exactly the same states — no drift between sections", () => {
    expect(firstColumnTokens(applyTable).sort()).toEqual([...CANONICAL_STATES].sort());
  });

  test('every canonical state has a documented recovery consequence', () => {
    for (const state of CANONICAL_STATES) {
      expect(recovery).toContain(`\`${state}\``);
    }
  });

  test('no-go documents an effect for every prior state', () => {
    const noGoTable = section('**Effect, by prior state:**', 'This is the stale-gate rule');
    for (const state of CANONICAL_STATES) {
      expect(noGoTable).toContain(`\`${state}\``);
    }
  });

  // The superseded PR #556 vocabulary. Re-introducing any of these means two
  // competing state models are live in one document again.
  const RETIRED_TOKENS = [
    'no_go_pending',
    'disposition_applied',
    'pending_discussion',
    'keep_pending_discussion',
    'applying_failed',
    'continue_same_issue',
    'continue_same_issue_recreate_pr',
    'split_followup_issue',
    'supersede_with_new_issue',
    'humanGateSource',
    'noGoFeedback',
  ];
  for (const token of RETIRED_TOKENS) {
    test(`does not reintroduce the superseded token \`${token}\``, () => {
      expect(doc).not.toContain(token);
    });
  }
});

describe('docs/human-gate-no-go-flow.md — one canonical disposition vocabulary', () => {
  const dispositionList = section('**Dispositions** —', '**Operations** —');
  const dispositionTable = section('### 7.1 Disposition table', '### 7.2 Step semantics');

  test('the vocabulary section declares exactly the canonical dispositions', () => {
    expect(backtickedTokens(dispositionList).sort()).toEqual([...CANONICAL_DISPOSITIONS].sort());
  });

  test('the disposition table declares exactly the same set', () => {
    expect(firstColumnTokens(dispositionTable).sort()).toEqual(
      [...CANONICAL_DISPOSITIONS].sort(),
    );
  });

  test('every disposition row states precondition, gating, steps, and resulting task/item/PR state', () => {
    for (const disposition of CANONICAL_DISPOSITIONS) {
      const row = dispositionTable
        .split('\n')
        .find((line) => line.startsWith(`| \`${disposition}\` |`));
      expect(row).toBeDefined();
      // 7 columns: disposition | precondition | destructive | steps | task | item | PR
      const cells = row.split(/(?<!\\)\|/).slice(1, -1);
      expect(cells).toHaveLength(7);
      for (const cell of cells) expect(cell.trim().length).toBeGreaterThan(0);
    }
  });

  test('every destructive disposition is gated on --yes', () => {
    for (const disposition of [
      'continue_fix_recreate_pr',
      'split_followup',
      'supersede',
      'close_not_planned',
    ]) {
      expect(doc).toMatch(new RegExp(`\`${disposition}\``));
    }
    const security = section('## 9. Security constraints', '## 10. Mutation boundary');
    expect(security).toMatch(/`--yes` is required for/);
    for (const disposition of [
      'continue_fix_recreate_pr',
      'split_followup',
      'supersede',
      'close_not_planned',
    ]) {
      expect(security).toContain(`\`${disposition}\``);
    }
  });
});

describe('docs/human-gate-no-go-flow.md — two-operation UX is preserved', () => {
  test('exactly two mutating commands, plus a read-only inspector', () => {
    expect(doc).toMatch(/admin\.js human-gate no-go/);
    expect(doc).toMatch(/admin\.js human-gate apply/);
    expect(doc).toMatch(/human-gate show/);
    expect(doc).toMatch(/two-operation model is fixed/i);
  });

  test('no-go records editable feedback and returns advice; apply applies the disposition', () => {
    expect(doc).toMatch(/Record \(or edit\) operator No-go feedback and return advice/i);
    expect(doc).toMatch(/Apply the selected disposition/i);
  });

  test('advice generation is part of no-go, not a third mutating command', () => {
    expect(doc).toMatch(/Advice generation is \*\*part of `no-go`\*\*/);
  });
});

describe('docs/human-gate-no-go-flow.md — persisted humanGate fields', () => {
  const fields = section('## 3. Persisted `humanGate` fields', '## 4. Task events');

  const REQUIRED_FIELDS = [
    'gateId',
    'state',
    'feedback',
    'feedbackSource',
    'feedbackRecordedAt',
    'feedbackMeta',
    'openedAt',
    'updatedAt',
    'advice',
    'adviceError',
    'disposition',
    'appliedAt',
    'appliedBy',
    'pendingOperation',
  ];
  for (const field of REQUIRED_FIELDS) {
    test(`documents the \`${field}\` field`, () => {
      expect(fields).toMatch(new RegExp(`\\| \`${field}\` \\|`));
    });
  }

  test('documents source/audit provenance for both the feedback and the decision', () => {
    expect(fields).toMatch(/`operator_input`/);
    expect(fields).toMatch(/`operator_editor`/);
    expect(fields).toMatch(/`github-app-no-go`/);
    expect(fields).toMatch(/`operator_cli`/);
  });

  test('documents initialization of a first gate', () => {
    expect(fields).toMatch(/\*\*Initialization\.\*\*[\s\S]{0,400}`gateId: 1`/);
  });
});

describe('docs/human-gate-no-go-flow.md — a new gate cannot inherit a resolved one', () => {
  const fields = section('## 3. Persisted `humanGate` fields', '## 4. Task events');

  test('the reset rule clears every decision and apply field and bumps gateId', () => {
    const reset = fields.slice(fields.indexOf('**Reset.**'), fields.indexOf('**Audit is append-only'));
    expect(reset).toMatch(/`gateId: prev \+ 1`/);
    for (const cleared of [
      'advice',
      'adviceError',
      'disposition',
      'appliedAt',
      'appliedBy',
      'pendingOperation',
    ]) {
      expect(reset).toContain(`\`${cleared}\``);
    }
    expect(reset).toMatch(/\*\*no\*\*/);
  });

  test('feedback pre-population is allowed only for an unresolved (open) gate', () => {
    expect(doc).toMatch(/pre-population is allowed only for an unresolved \(`open`\) gate/i);
  });

  test('held and resolved gates start a NEW gateId rather than being edited in place', () => {
    const noGoTable = section('**Effect, by prior state:**', 'This is the stale-gate rule');
    for (const line of noGoTable.split('\n')) {
      if (line.startsWith('| `held` |') || line.startsWith('| `resolved` |')) {
        expect(line).toMatch(/\*\*new\*\* gate, full reset/);
        expect(line).toMatch(/`prev \+ 1`/);
        expect(line).toMatch(/No — empty template/);
      }
    }
  });

  test('whole-object replacement is mandatory so the reset is adapter-independent', () => {
    const boundary = section('## 2. `task.context.humanGate` is workflow state', '## 3. Persisted');
    expect(boundary).toMatch(/Whole-object replacement is mandatory/i);
    expect(boundary).toMatch(/partial merge is forbidden/i);
    expect(boundary).toMatch(/applyTaskPatch/);
  });
});

describe('docs/human-gate-no-go-flow.md — advice never outlives its feedback', () => {
  const noGo = section('## 5. `admin.js human-gate no-go`', '## 6. `admin.js human-gate apply`');
  const fields = section('## 3. Persisted `humanGate` fields', '## 4. Task events');

  // Without this, `--no-ai`, a failed generation, or a crash between the two
  // writes leaves the PREVIOUS feedback's recommendation on screen for feedback
  // that no longer exists.
  test('editing an open gate clears advice and adviceError in the feedback write itself', () => {
    const write = noGo.slice(noGo.indexOf('**Write.**'), noGo.indexOf('**Advice** is generated'));
    expect(write).toMatch(/feedback write always clears prior advice/i);
    expect(write).toMatch(/no\*\* `advice` and \*\*no\*\* `adviceError` key/);
    expect(write).toMatch(/before advice generation is attempted/i);
  });

  test('the clear is required for --no-ai and for failed or in-flight generation alike', () => {
    const write = noGo.slice(noGo.indexOf('**Write.**'), noGo.indexOf('**Advice** is generated'));
    expect(write).toMatch(/`--no-ai`/);
    expect(write).toMatch(/adviceError/);
    expect(write).toMatch(/still in flight|mid-generation/i);
  });

  test('a lost advice CAS leaves no advice rather than the old one', () => {
    expect(noGo).toMatch(/left with no advice rather than with the\s*\n?old one/i);
  });

  test('the field table states the invariant too, not only the command section', () => {
    for (const line of fields.split('\n')) {
      if (line.startsWith('| `advice` |')) expect(line).toMatch(/after any feedback write/i);
      if (line.startsWith('| `adviceError` |')) expect(line).toMatch(/cleared by a feedback write/i);
    }
  });

  test('the open-gate row of the no-go effect table records the clear', () => {
    const noGoTable = section('**Effect, by prior state:**', 'This is the stale-gate rule');
    const openRow = noGoTable.split('\n').find((l) => l.startsWith('| `open` |'));
    expect(openRow).toMatch(/advice cleared/i);
  });
});

describe('docs/human-gate-no-go-flow.md — a repeated hold is genuinely a no-op', () => {
  const eligibility = section('### 6.1 Eligibility', '### 6.2 Claim');
  const idempotency = section('### 6.5 Idempotency', '## 7. Dispositions');
  const steps = section('### 7.2 Step semantics', '### 7.3 Recovery eligibility');

  // A no-op that still claims the gate, posts a status comment, and emits
  // another human_gate.held event is not a no-op.
  test('the short-circuit happens BEFORE the claim, so no gate write occurs', () => {
    expect(eligibility).toMatch(/### 6\.1\.1 Pre-claim no-op/);
    expect(eligibility).toMatch(/before the claim \(§6\.2\)/);
    expect(eligibility).toMatch(/writes nothing, enqueues nothing, and emits no event/i);
  });

  test('it names the duplicate effects it exists to prevent', () => {
    const noop = eligibility.slice(eligibility.indexOf('### 6.1.1'));
    expect(noop).toMatch(/`human_gate\.apply_claimed`/);
    expect(noop).toMatch(/`record_hold`/);
    expect(noop).toMatch(/`human_gate\.held`/);
  });

  test('the short-circuit is per-gate and only for an already-held hold', () => {
    const noop = eligibility.slice(eligibility.indexOf('### 6.1.1'));
    expect(noop).toMatch(/`humanGate\.gateId` is the gate the call resolved/);
    expect(noop).toMatch(/`humanGate\.state` is `held`/);
    expect(noop).toMatch(/`apply_failed`\) is not mistaken for a completed one/);
    // Any other disposition against a held gate is a real decision.
    expect(noop).toMatch(/runs the full flow/i);
  });

  test('the eligibility table points at the no-op instead of promising it generically', () => {
    const applyTable = section('5. Gate state admits this call:', '`gate_resolved` is the idempotency');
    const heldRow = applyTable.split('\n').find((l) => l.startsWith('| `held` |'));
    expect(heldRow).toMatch(/§6\.1\.1/);
    expect(heldRow).toMatch(/before\*\* the claim/);
  });

  test('idempotency mechanisms and record_hold both reference the short-circuit', () => {
    expect(idempotency).toMatch(/Pre-claim short-circuit/);
    expect(steps).toMatch(/short-circuited before the claim/);
    expect(steps).toMatch(/once per hold decision, not once per invocation/);
  });
});

describe('docs/human-gate-no-go-flow.md — recreate_branch needs handler support that does not exist', () => {
  const steps = section('### 7.2 Step semantics', '### 7.3 Recovery eligibility');
  const gaps = section('## 11. Port gaps', '## 12. Output modes');

  // The directive is inert on main. If this ever changes, the doc's
  // "required change" framing is stale and must be revisited.
  test('implementationRestart is genuinely unread by the current tree', () => {
    expect(read('src/handlers/implementation.ts')).not.toMatch(/implementationRestart/);
  });

  test('the doc calls handler support a required change, not existing routing', () => {
    expect(steps).toMatch(/required handler change, not existing routing/i);
    expect(steps).toMatch(/does not\s+read `implementationRestart` anywhere/i);
    expect(steps).toMatch(/resolveFixPr/);
    expect(steps).toMatch(/would be\s*\n?\s*indistinguishable from `continue_fix`/i);
  });

  test('the required change is enumerated, including clearing the consumed directive', () => {
    expect(steps).toMatch(/fresh start ref from the base branch/i);
    expect(steps).toMatch(/creating a new PR rather than reusing `context\.prUrl`/i);
    expect(steps).toMatch(/clearing `implementationRestart` once consumed/i);
  });

  test('until it lands the disposition fails closed rather than degrading to continue_fix', () => {
    expect(steps).toMatch(/`continue_fix_recreate_pr` is refused as "not yet\s*\n?\s*supported"/);
    expect(steps).toMatch(/Degrading it into a plain `continue_fix` is not permitted/);
    expect(gaps).toContain('`continue_fix_recreate_pr`');
    expect(gaps).toMatch(/not\s*\n?\s*shippable with them/i);
  });

  test('the PR-close gap lists recreate_pr among what it blocks', () => {
    const closeRow = gaps.split('\n').find((l) => l.startsWith('| Close a pull request |'));
    expect(closeRow).toContain('continue_fix_recreate_pr');
  });

  test('the follow-up issue plan schedules it after the PR-close port', () => {
    const plan = section('## 14. Follow-up implementation issues');
    expect(plan).toMatch(/\*\*`continue_fix_recreate_pr`\*\* — on top of issue 5's PR close/);
    // Issue 4 ships only the dispositions that need nothing new.
    const nonDestructive = plan.slice(plan.indexOf('4. **`human-gate apply`, non-destructive**'));
    expect(nonDestructive.slice(0, nonDestructive.indexOf('5. **Host ports**'))).not.toContain(
      'continue_fix_recreate_pr',
    );
  });
});

describe('docs/human-gate-no-go-flow.md — recovery safety', () => {
  const recovery = section('### 7.3 Recovery eligibility', '## 8. Advice');

  test('a live gate refuses generic handoff recovery with a dedicated code', () => {
    expect(recovery).toMatch(/`human_gate_unresolved`/);
    expect(recovery).toMatch(/recoverHandoff/);
    expect(recovery).toMatch(/recoverCapHandoff/);
  });

  test('the refusal is previewed by --dry-run so a preview never over-promises', () => {
    expect(recovery).toMatch(/`--dry-run`/);
    expect(recovery).toMatch(/recoverSkipReason/);
  });

  test('terminal dispositions land on cancelled and are structurally unrecoverable', () => {
    expect(recovery).toMatch(/`supersede`[\s\S]{0,200}`close_not_planned`[\s\S]{0,400}`cancelled`/);
    expect(recovery).toMatch(/No implementation may add `cancelled` to\s*\n?`RECOVERABLE_STATUSES`/);
    expect(recovery).toMatch(/never restartable by generic recovery/i);
  });

  test('a resolved gate does NOT block a later independent handoff recovery', () => {
    expect(recovery).toMatch(/a later, independent handoff is a normal recovery target/i);
  });

  test("admin.ts's RECOVERABLE_STATUSES still excludes cancelled and ready_for_human", () => {
    const m = adminTs.match(/const RECOVERABLE_STATUSES = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const statuses = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    expect(statuses).toEqual(['failed', 'claimed', 'running']);
    expect(statuses).not.toContain('cancelled');
    expect(statuses).not.toContain('ready_for_human');
  });
});

describe('docs/human-gate-no-go-flow.md — suggested commands are allowlisted, not interpolated', () => {
  const advice = section('### 8.2 Deriving `suggestedCommand`', '## 9. Security constraints');

  test('commands come from a static template table keyed by the validated disposition', () => {
    expect(advice).toMatch(/static template table\s*\n?keyed by the validated disposition token/i);
    for (const disposition of CANONICAL_DISPOSITIONS) {
      expect(advice).toContain(`--disposition ${disposition}`);
    }
  });

  test('only structurally typed values are substituted', () => {
    expect(advice).toMatch(/`<sessionId>`/);
    expect(advice).toMatch(/`<issueNumber>`/);
    expect(advice).toMatch(/not any value appearing in feedback or advice/i);
  });

  test('free-form operator or GitHub text can never enter a suggested command', () => {
    expect(advice).toMatch(/No free-form interpolation/i);
    for (const forbidden of ['feedback', 'feedbackMeta', 'reason', 'informationNeeded']) {
      expect(advice).toContain(`\`${forbidden}\``);
    }
    expect(advice).toMatch(/GitHub comment text[\s\S]{0,120}must never appear inside\s*\n?`suggestedCommand`/i);
    expect(advice).toMatch(/fixed literal placeholder/i);
  });

  test('model-authored command strings are discarded, and nothing auto-executes advice', () => {
    expect(advice).toMatch(/No model-authored commands/i);
    expect(advice).toMatch(/Nothing in the loop executes it/i);
  });

  test('malformed advice is rejected wholesale rather than stored partially', () => {
    const record = section('### 8.1 Advice record', '### 8.2 Deriving');
    expect(record).toMatch(/Fail closed on malformed advice/i);
    expect(record).toMatch(/Partial advice is never\s*\n?stored/i);
  });
});

describe('docs/human-gate-no-go-flow.md — idempotency, concurrency, retry', () => {
  test('repeat apply against a resolved gate is a refusal, not a second mutation', () => {
    expect(doc).toMatch(/`gate_resolved` is the idempotency\s*\n?\s*backstop/i);
    expect(doc).toMatch(/Idempotent-by-refusal/i);
  });

  test('a resumed apply skips completed steps and reuses recorded step results', () => {
    const idem = section('### 6.5 Idempotency', '## 7. Dispositions');
    expect(idem).toMatch(/never re-runs a step in `completedSteps`/);
    expect(idem).toMatch(/`stepResults`/);
  });

  // A host create followed by a separate `stepResults` commit has a crash
  // window in between: the item exists, the step still looks incomplete. Step
  // skipping cannot close it, so every item-creating step needs a stable key
  // and a reconcile — for follow-up items exactly as much as for the
  // replacement item.
  test('step skipping alone is not claimed to prevent duplicate items', () => {
    const idem = section('### 6.5 Idempotency', '## 7. Dispositions');
    expect(idem).toMatch(/by itself it says nothing about a step\s*\n?\s*that ran on the host and crashed before its commit/i);
    expect(idem).toMatch(/Reconcile-before-create/);
    expect(idem).toMatch(/second copy of follow-up item `i`/);
  });

  test('every item-creating step is keyed and reconciles before creating', () => {
    const steps = section('### 7.2 Step semantics', '### 7.3 Recovery eligibility');
    const rule = steps.slice(
      steps.indexOf('Item creation is reconcile-before-create'),
      steps.indexOf('**`cancel_task`**'),
    );
    expect(rule).toMatch(/`create_followup_item`/);
    expect(rule).toMatch(/`create_replacement_item`/);
    expect(rule).toMatch(/is \*\*not\*\* sufficient on its\s*\n?\s*own/i);
    expect(rule).toMatch(/would create a duplicate/i);
    expect(rule).toMatch(
      /`human-gate:<sessionId>:<issueNumber>:<gateId>:<stepId>`/,
    );
    expect(rule).toMatch(/never from feedback text/i);
    expect(rule).toMatch(/Found → adopt that number into `stepResults`/);
    expect(rule).toMatch(/DOMAIN\.md` §2\.3/);
    expect(rule).toMatch(/never retried blind/i);
    // Neither creating step may restate a weaker rule of its own.
    for (const step of ['create_followup_item', 'create_replacement_item']) {
      const bullet = steps
        .split('\n- ')
        .find((b) => b.startsWith(`**\`${step}`));
      expect(bullet).toBeDefined();
      expect(bullet).toMatch(/under the\s+rule above/i);
    }
  });

  test('the marker key is per-item and per-gate, so a later gate never adopts an older item', () => {
    const steps = section('### 7.2 Step semantics', '### 7.3 Recovery eligibility');
    expect(steps).toMatch(/`<stepId>` is the step ID/);
    expect(steps).toMatch(/unique per item, stable across attempts of the same gate/i);
    expect(steps).toMatch(/never\s*\n?\s*collides with an earlier `gateId`/i);
  });

  test('the host lookup the reconcile needs is named as a missing port, not assumed', () => {
    const gaps = section('## 11. Port gaps', '## 12. Output modes');
    expect(gaps).toMatch(/Find a work item by marker/i);
    expect(gaps).toMatch(/`listCandidateItems` is a queue-selection query/);
    expect(gaps).toMatch(/create and the find land \*\*together\*\*/i);
    expect(gaps).toMatch(/idempotency key the host enforces/i);
    // The claim that no such lookup exists must stay true of the real port.
    const providers = read('src/providers/types.ts');
    const workItem = interfaceBody(providers, 'WorkItemProvider');
    expect(workItem).not.toMatch(/\bfindItem\s*\(|\bsearchItems\s*\(/);
  });

  test('the runId is pinned to the gate so resumed outbox effects dedup', () => {
    const idem = section('### 6.5 Idempotency', '## 7. Dispositions');
    expect(idem).toMatch(/pinned to the gate rather than minted\s*\n?per invocation/i);
    expect(idem).toMatch(/makeOutboxKey/);
    expect(idem).toMatch(/INSERT OR IGNORE/);
  });

  test('a crashed apply is recovered by lease takeover, never by admin recover', () => {
    const stale = section('### 6.4 Stale-apply recovery', '### 6.5 Idempotency');
    expect(stale).toMatch(/`leaseExpiresAt`/);
    expect(stale).toMatch(/\*\*not\*\* performed by\s*\n?`admin recover`/);
    expect(stale).toMatch(/--abandon-pending-operation/);
  });

  test('every write is CAS-guarded on the row-level revision, with no rival counter', () => {
    const conc = section('### 10.2 Concurrency', '### 10.3 Store result codes');
    expect(conc).toMatch(/`AiTask\.revision`/);
    expect(conc).toMatch(/no second revision counter inside\s*\n?`humanGate`/i);
    expect(conc).toMatch(/`updatedAt` alone is insufficient/i);
  });

  test('every concurrent-operation race has a documented rejection outcome', () => {
    const conc = section('### 10.2 Concurrency', '### 10.3 Store result codes');
    for (const outcome of [
      'human_gate_conflict',
      'apply_in_progress',
      'not_at_human_gate',
      'human_gate_unresolved',
    ]) {
      expect(conc).toContain(`\`${outcome}\``);
    }
  });
});

describe('docs/human-gate-no-go-flow.md — mutation boundary matches the real ports', () => {
  const boundary = section('### 10.1 Every mutation', '### 10.2 Concurrency');

  test('every TaskStore/OutboxStore method the doc names exists on the interface', () => {
    const referenced = [...doc.matchAll(/`(TaskStore|OutboxStore)\.([A-Za-z]+)(?:\(\))?`/g)];
    expect(referenced.length).toBeGreaterThan(0);
    const bodies = {
      TaskStore: interfaceBody(taskStoreTs, 'TaskStore'),
      OutboxStore: interfaceBody(outboxTs, 'OutboxStore'),
    };
    for (const [, iface, method] of referenced) {
      expect(bodies[iface]).toMatch(new RegExp(`\\b${method}\\s*\\(`));
    }
  });

  test('the mutation table routes gate writes through transitionTask and cancels atomically', () => {
    expect(boundary).toMatch(/`TaskStore\.transitionTask\(\)`/);
    expect(boundary).toMatch(/`TaskStore\.cancelTaskWithEffects\(\)`/);
    expect(boundary).toMatch(/`TaskStore\.appendEvent\(\)`/);
    expect(boundary).toMatch(/`OutboxStore\.enqueue\(\)`/);
    expect(boundary).toMatch(/workItemOutbox\(outboxStore, session\)/);
  });

  test('direct SQLite writes and bypassing the TaskStore boundary are forbidden', () => {
    expect(boundary).toMatch(/Raw `better-sqlite3` access/i);
    expect(boundary).toMatch(/bypasses `TaskStore`/);
    expect(boundary).toMatch(/rather than the\s*\n?`TaskStore` interface/);
  });

  test('every task status the doc asserts is a real TaskStatus', () => {
    const statuses = unionMembers(taskTs, 'TaskStatus');
    for (const claimed of ['ready_for_human', 'queued', 'cancelled', 'claimed', 'running']) {
      expect(doc).toContain(`\`${claimed}\``);
      expect(statuses).toContain(claimed);
    }
  });

  test('every store result code the doc calls existing really exists today', () => {
    const codes = unionMembers(taskTs, 'StoreResultCode');
    const block = section('Existing codes this flow relies on', 'Required addition');
    const claimed = backtickedTokens(block);
    expect(claimed.length).toBeGreaterThanOrEqual(4);
    for (const code of claimed) expect(codes).toContain(code);
  });

  test('human_gate_unresolved is declared as a required addition, not as existing', () => {
    const codes = unionMembers(taskTs, 'StoreResultCode');
    expect(codes).not.toContain('human_gate_unresolved');
    expect(doc).toMatch(/Required addition for the implementing issue: \*\*`human_gate_unresolved`\*\*/);
  });

  test('command-layer reason codes are kept out of StoreResultCode', () => {
    const codes = unionMembers(taskTs, 'StoreResultCode');
    const cliTokens = [
      'not_at_human_gate',
      'no_gate',
      'apply_in_progress',
      'pending_operation_mismatch',
      'gate_resolved',
      'empty_feedback',
      'human_gate_conflict',
    ];
    for (const token of cliTokens) {
      expect(doc).toContain(`\`${token}\``);
      expect(codes).not.toContain(token);
    }
    expect(doc).toMatch(/must not be\s*\n?added to `StoreResultCode`/);
  });
});

describe('docs/human-gate-no-go-flow.md — port gaps are named, not papered over', () => {
  const gaps = section('## 11. Port gaps', '## 12. Output modes');

  test('names the host capabilities that do not exist on main', () => {
    expect(gaps).toMatch(/Create a work item/i);
    expect(gaps).toMatch(/Find a work item by marker/i);
    expect(gaps).toMatch(/Close a work item/i);
    expect(gaps).toMatch(/Close a pull request/i);
  });

  test('the claimed gaps are true of the current provider surface', () => {
    const providers = read('src/providers/types.ts');
    const workItem = interfaceBody(providers, 'WorkItemProvider');
    const repoHost = interfaceBody(providers, 'RepoHostProvider');
    // If any of these ever land, this doc's staging advice is stale and must be revised.
    expect(workItem).not.toMatch(/\bcreateItem\s*\(|\bcreateWorkItem\s*\(/);
    expect(workItem).not.toMatch(/\bcloseItem\s*\(|\bcloseWorkItem\s*\(/);
    expect(repoHost).not.toMatch(/\bclosePullRequest\s*\(/);
    expect(providers).toMatch(/export type WorkItemTransition =\s*\n\s*\| \{ kind: "add-label"/);
  });

  test('blocked dispositions fail closed instead of degrading into partial application', () => {
    expect(gaps).toMatch(/rejected with an\s*\n?\s*actionable "not yet supported" error/i);
    expect(gaps).toMatch(/never silently degraded/i);
    for (const disposition of ['split_followup', 'supersede', 'close_not_planned']) {
      expect(gaps).toContain(`\`${disposition}\``);
    }
  });

  test('reconcile-closed is named as a backstop, not a substitute', () => {
    expect(gaps).toMatch(/`admin task reconcile-closed`/);
    expect(gaps).toMatch(/not a\s*\n?substitute for the ports above/i);
  });
});

describe('docs/human-gate-no-go-flow.md — fix-mode continuation reuses the existing path', () => {
  const steps = section('### 7.2 Step semantics', '### 7.3 Recovery eligibility');

  test('requeue_fix_mode reuses enqueueFixModeRequeue rather than inventing a path', () => {
    expect(steps).toMatch(/enqueueFixModeRequeue/);
    expect(steps).toMatch(/`reviewFeedback`/);
  });

  test('the gate finalize and the requeue commit in the same transitionTask call', () => {
    expect(steps).toMatch(/the same `transitionTask\(\)` call/);
    expect(steps).toMatch(/requeued into fix mode while the gate still reads\s*\n?\s*`open`/);
  });

  test('the accepted non-atomic suffix is inherited, not silently strengthened', () => {
    expect(steps).toMatch(/ports contract §4/);
    expect(steps).toMatch(/does not strengthen that\s*\n?\s*guarantee/i);
  });

  test('admin performs no git writes; branch recreation stays in Execution', () => {
    expect(steps).toMatch(/`implementationRestart`/);
    expect(steps).toMatch(/no git writes/i);
    expect(steps).toMatch(/Execution mechanics/);
  });
});

describe('docs/human-gate-no-go-flow.md — untrusted input handling', () => {
  const security = section('## 9. Security constraints', '## 10. Mutation boundary');

  test('feedback is bounded and sanitized with the shared helpers', () => {
    expect(security).toMatch(/untrusted input/i);
    expect(security).toMatch(/4 000 characters/);
    expect(security).toMatch(/8 000 hard cap/);
    expect(security).toMatch(/boundedExcerpt/);
    expect(security).toMatch(/sanitizeBody\(text,\s*\n?\s*sessionRedactionPaths\(session\)\)/);
  });

  test('raw feedback is never echoed to a public surface', () => {
    expect(security).toMatch(/Never echoed verbatim/i);
  });

  test('the shared helpers it names actually exist', () => {
    const sanitize = read('src/core/text-sanitize.ts');
    expect(sanitize).toMatch(/export function boundedExcerpt\s*\(/);
    expect(sanitize).toMatch(/export function sanitizeBody\s*\(/);
  });
});

describe('docs/human-gate-no-go-flow.md — gate audit trail', () => {
  const events = section('## 4. Task events', '## 5. `admin.js human-gate no-go`');

  test('every gate mutation emits exactly one event carrying gateId', () => {
    expect(events).toMatch(/always carries `gateId`/i);
    for (const type of [
      'human_gate.opened',
      'human_gate.feedback_updated',
      'human_gate.advice_recorded',
      'human_gate.apply_claimed',
      'human_gate.step_completed',
      'human_gate.apply_failed',
      'human_gate.abandoned',
      'human_gate.held',
      'human_gate.resolved',
    ]) {
      expect(events).toContain(`\`${type}\``);
    }
  });

  // The advice write is a second mutation of `humanGate` on a normal, fully
  // successful `no-go`. Without its own event it would be the one gate write
  // absent from the append-only history the section above promises.
  test('the advice write has an event of its own, and no gate write is exempt', () => {
    expect(events).toMatch(/no exemptions/i);
    expect(events).toMatch(/`human_gate\.advice_recorded`[\s\S]{0,200}`adviceError`/);
    const noGo = section('## 5. `admin.js human-gate no-go`', '## 6. `admin.js human-gate apply`');
    const advice = noGo.slice(noGo.indexOf('**Advice**'));
    expect(advice).toMatch(/`human_gate\.advice_recorded`/);
    expect(advice).toMatch(/not exempt from §4's one-event rule/i);
    // Skipping advice skips the event too — no event without a mutation.
    expect(events).toMatch(/`--no-ai`[\s\S]{0,200}emits no `human_gate\.advice_recorded` event/);
  });

  test('humanGate holds only the current gate; history lives in events', () => {
    expect(doc).toMatch(/Audit is append-only elsewhere/i);
  });
});

describe('docs/human-gate-no-go-flow.md — gate writes and their events are atomic', () => {
  const atomicity = section('### 4.1 The gate write and its event', '## 5. `admin.js human-gate no-go`');

  test('the gate write and its event are required to commit in one transaction', () => {
    expect(atomicity).toMatch(/single task-store transaction/i);
    expect(atomicity).toMatch(/A lost CAS writes neither/i);
  });

  test('it admits that the TaskStore on main cannot satisfy the rule', () => {
    expect(atomicity).toMatch(/`transitionTask\(\)` and\s*\n?\s*`appendEvent\(\)` are separate calls/);
    expect(atomicity).toMatch(/`completePhaseWithEffects\(\)`/);
    expect(atomicity).toMatch(/not used by any admin command/i);
    expect(atomicity).toMatch(/cannot satisfy the\s*\n?\s*rule with the current surface/i);
  });

  test('the required primitive is a method on the existing TaskStore port, and does not exist yet', () => {
    expect(atomicity).toMatch(/`transitionTaskWithEvent\(key, expected, patch, event\)`/);
    expect(atomicity).toMatch(/not a new store, table, or interface/i);
    expect(atomicity).toMatch(/`SqliteTaskStore` and `MemoryTaskStore`/);
    // If it ever lands, the "required addition" framing (and §14 item 1) is stale.
    expect(interfaceBody(taskStoreTs, 'TaskStore')).not.toMatch(/\btransitionTaskWithEvent\s*\(/);
    // ...and the primitives it is modelled on really are atomic today.
    expect(taskStoreTs).toMatch(/completePhaseWithEffects\s*\(/);
    expect(taskStoreTs).toMatch(/cancelTaskWithEffects\s*\(/);
  });

  test('the interim non-atomic shape has documented repair semantics, not silence', () => {
    expect(atomicity).toMatch(/at most\* one event per mutation/i);
    expect(atomicity).toMatch(/task\s*\n?\s*row is the sole authority for gate state/i);
    expect(atomicity).toMatch(/event missing \(crash\s*\n?\s*window\)/);
    expect(atomicity).toMatch(/never back-filled with a fabricated timestamp/i);
    expect(atomicity).toMatch(/The event is never appended before the transition\s*\n?\s*commits/i);
  });

  test('every gate mutation in the doc goes through the atomic commit, not two calls', () => {
    const boundary = section('### 10.1 Every mutation', '### 10.2 Concurrency');
    expect(boundary).toMatch(/never standalone/i);
    const noGo = section('## 5. `admin.js human-gate no-go`', '## 6. `admin.js human-gate apply`');
    expect(noGo).toMatch(/atomic transition-plus-event commit \(§4\.1\)/);
    const claim = section('### 6.2 Claim', '### 6.3 Execute and finalize');
    expect(claim).toMatch(/atomic transition-plus-event commit \(§4\.1\)/);
    const execute = section('### 6.3 Execute and finalize', '### 6.4 Stale-apply recovery');
    expect(execute).toMatch(/atomic transition-plus-event commit \(§4\.1\)/);
  });

  test('the fix-mode requeue commits its gate event with the transition, without over-claiming the rest', () => {
    const steps = section('### 7.2 Step semantics', '### 7.3 Recovery eligibility');
    expect(steps).toMatch(/committed together with the `human_gate\.resolved` event/);
    // The outbox half stays non-atomic — this doc must not silently strengthen it.
    expect(steps).toMatch(/outbox rows in a different store/i);
    expect(steps).toMatch(/ports contract §4/);
  });

  // `supersede` and `close_not_planned` end at `cancel_task`. If that step is
  // not also the finalize, the only remaining shapes are a second write after
  // the task is already `cancelled` (a crash window that can never be
  // repaired, because a cancelled task is unrecoverable by §7.3) or a gate
  // left at `applying` forever. The doc must fuse them.
  test('terminal cancellation finalizes the gate in the same commit, not a second write', () => {
    const steps = section('### 7.2 Step semantics', '### 7.3 Recovery eligibility');
    const cancelStep = steps.slice(steps.indexOf('- **`cancel_task`**'));
    expect(cancelStep).toMatch(/also their finalize/i);
    expect(cancelStep).toMatch(/`state:\s*\n?\s*"resolved"`/);
    expect(cancelStep).toMatch(/`task\.cancelled`[\s\S]{0,80}`human_gate\.resolved`/);
    expect(cancelStep).toMatch(/\*\*no\*\*\s*\n?\s*`pendingOperation` key/);
    // §6.3's generic finalize must not contradict it by demanding an extra commit.
    const execute = section('### 6.3 Execute and finalize', '### 6.4 Stale-apply recovery');
    expect(execute).toMatch(/never a commit against an already-terminal task/i);
    expect(execute).toMatch(/`cancel_task` step is itself the finalize/);
  });

  test("the doc's claim that today's cancelTaskWithEffects cannot carry it is true of the real port", () => {
    const atomicity = section('### 4.1 The gate write and its event', '## 5. `admin.js human-gate no-go`');
    expect(atomicity).toMatch(/`cancelTaskWithEffects\(\)`/);
    expect(atomicity).toMatch(/cannot carry a gate finalize/i);
    expect(atomicity).toMatch(/`humanGate\.state: "resolved"` nor `human_gate\.resolved`/);
    expect(atomicity).toMatch(/widens the existing\s*\n?\s*`cancelTaskWithEffects\(\)`/i);

    const params = taskStoreTs.match(/cancelTaskWithEffects\(([\s\S]*?)\):\s*Promise/);
    expect(params).not.toBeNull();
    const [, signature] = params;
    // Exactly the three limitations §4.1 names. If any of these ever land, the
    // "required addition" framing (and §14 item 1) is stale and must be revised.
    expect(signature).toMatch(/options:\s*\{ reason\?: string; now\?: string \}/);
    expect(signature).not.toMatch(/\bexpected\b/);
    expect(signature).not.toMatch(/\bcontext\b/);
    expect(signature).toMatch(/event:\s*TaskEvent,/);
    expect(signature).not.toMatch(/TaskEvent\[\]/);
    // ...and the sqlite adapter really does merge nothing but cancel metadata.
    const sqliteTs = read('src/stores/sqlite-task-store.ts');
    const applyCancel = sqliteTs.slice(sqliteTs.indexOf('#applyCancel('));
    expect(applyCancel).toMatch(/\.\.\.current\.context,[\s\S]{0,60}cancelledAt: now/);
    expect(applyCancel.slice(0, applyCancel.indexOf('UPDATE tasks'))).not.toMatch(/options\.context/);
  });

  test('the widened cancellation primitive is specified concretely, not gestured at', () => {
    const steps = section('### 7.2 Step semantics', '### 7.3 Recovery eligibility');
    const cancelStep = steps.slice(steps.indexOf('- **`cancel_task`**'));
    // A caller-supplied context patch, committed in the same UPDATE as the status flip.
    expect(cancelStep).toMatch(/`options\.context`/);
    expect(cancelStep).toMatch(/same `UPDATE`\*\* that sets `status = 'cancelled'`/);
    // A CAS guard, so a lost race writes nothing at all.
    expect(cancelStep).toMatch(/`options\.expected`/);
    expect(cancelStep).toMatch(/same `IMMEDIATE` transaction, before the `UPDATE`/);
    expect(cancelStep).toMatch(/`\{ ok: false, code:\s*\n?\s*"conflict", current \}`/);
    expect(cancelStep).toMatch(/no cancellation, no gate finalize, no events, no\s*\n?\s*outbox rows/i);
    // An ordered event list, so both required audit effects fit in one commit.
    expect(cancelStep).toMatch(/`TaskEvent \\\| TaskEvent\[\]`/);
    expect(cancelStep).toMatch(/inserted in array order/i);
    // Existing callers keep their semantics.
    expect(cancelStep).toMatch(/backward compatible/i);
    expect(cancelStep).toMatch(/`already_cancelled`/);
    for (const caller of ['admin task cancel', 'admin task reconcile-closed']) {
      expect(cancelStep).toContain(`\`${caller}\``);
    }
    expect(adminTs).toMatch(/cancelTaskWithEffects\s*\(/);
  });

  test('terminal dispositions are blocked on the widening, in both the gap list and the issue plan', () => {
    const gaps = section('## 11. Port gaps', '## 12. Output modes');
    expect(gaps).toMatch(/`cancelTaskWithEffects\(\)` cannot commit a gate finalize/);
    expect(gaps).toMatch(/blocks `supersede` and `close_not_planned`/);
    const plan = section('## 14. Follow-up implementation issues');
    expect(plan).toMatch(/widen `cancelTaskWithEffects` in both adapters/);
    expect(plan).toMatch(/`options\.context`[\s\S]{0,60}`options\.expected`/);
    expect(plan).toMatch(/a stale `expected\.revision` writes nothing at all/);
    expect(plan).toMatch(/require the widened `cancelTaskWithEffects` from issue 1/);
  });
});

describe('docs/human-review-return-flow.md — shared feedback-source vocabulary', () => {
  test('declares the human_gate_no_go source and links to the Human Gate spec', () => {
    expect(reviewReturnDoc).toMatch(/`human_gate_no_go`/);
    expect(reviewReturnDoc).toContain('human-gate-no-go-flow.md');
  });

  test('the Human Gate spec uses the same token for the fix-mode handoff', () => {
    expect(doc).toMatch(/`reviewFeedbackSource` is `human_gate_no_go`/);
  });
});
