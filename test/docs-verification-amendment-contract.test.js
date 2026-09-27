/**
 * Structural tests for docs/verification-amendment-contract.md
 * (issue #1037).
 *
 * The document is the authoritative contract for correcting verification
 * requirements after task intake: the four ownership layers
 * (session-default, issue-requirement, task-amendment, execution-evidence)
 * with one precedence order, task-scoped amendment as the initial mutation
 * scope, the revision model with its stable command identity and plan
 * digest, the admissible task states and the fail-closed refusal on
 * claimed/running, the evidence invalidation rules that delete nothing, the
 * default continuation back to review, the verification-only
 * refresh-from-Issue semantics, and the operator-surface, audit, and
 * GitHub-visible reporting requirements.
 *
 * Issue #1037 is a pure specification: no production code changes with it,
 * so these tests pin the document's own claims against drift — not whether
 * a runtime implements them. They are structural only, mirroring the
 * doc-only pin pattern used for docs/verification-execution-contract.md
 * (#918), docs/unattended-tool-request-contract.md (#919), and
 * docs/merged-pr-reconciliation-contract.md (#1046). The delivery notes
 * that land alongside the contract — docs/environment-prepare-contract.md
 * §3, docs/verification-execution-contract.md §16, and the
 * docs/feature-status.md row — are pinned at the end.
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

const DOC_PATH = 'docs/verification-amendment-contract.md';
const doc = read(DOC_PATH);
const rawDoc = readFileSync(resolve(ROOT, DOC_PATH), 'utf8');
const envPrepare = read('docs/environment-prepare-contract.md');
const execution = read('docs/verification-execution-contract.md');
const featureStatus = readFileSync(resolve(ROOT, 'docs/feature-status.md'), 'utf8');

/** Raw text of one `## <n>. ...` section, up to the next `## ` heading. */
function section(headingPrefix) {
  const idx = rawDoc.indexOf(`\n## ${headingPrefix}`);
  expect(idx).toBeGreaterThan(-1);
  const next = rawDoc.indexOf('\n## ', idx + 4);
  return rawDoc.slice(idx, next === -1 ? rawDoc.length : next);
}

function countMatches(text, re) {
  return (text.match(re) ?? []).length;
}

describe(`${DOC_PATH} — required headings`, () => {
  // The section numbers are load-bearing: this document and its neighbours
  // cross-reference each other by §number, so renumbering a section silently
  // breaks every pointer at it.
  const HEADINGS = [
    '# Operator-owned verification amendment and revision contract',
    '## 1. Why this contract — the gap it closes',
    '## 2. Terminology',
    '## 3. The four ownership layers and their precedence',
    '## 4. Task-scoped amendment is the initial mutation scope',
    '## 5. The revision model',
    '## 6. Resolving the effective plan',
    '## 7. Admissible task states',
    '## 8. Evidence invalidation and preservation',
    '## 9. Continuation after an amendment',
    '## 10. Refresh from the Issue',
    '## 11. Operator surface requirements',
    '## 12. Audit and reporting',
    '## 13. Compatibility',
    '## 14. Invariants',
    '## 15. Implementation decomposition proposal',
    '## 16. Test seams and matrix',
    '## 17. Non-goals and forward pointers',
  ];

  test('carries every required top-level heading, in order', () => {
    const found = rawDoc
      .split('\n')
      .filter((line) => /^#{1,2} /.test(line))
      .map((line) => line.trimEnd());
    expect(found).toEqual(HEADINGS);
  });

  const SUBHEADINGS = [
    '### 3.1 The layers',
    '### 3.2 Precedence',
    '### 3.3 Agents may propose; agents may never amend',
    '### 5.1 Stable command identity',
    '### 5.2 The operation set',
    '### 5.3 The revision record',
    '### 5.4 The plan digest',
    '### 5.5 Persistence',
    '### 6.1 The effective execution set',
    '### 6.2 The effective requirement set',
    '### 6.3 Ordering and totality',
    '### 6.4 Session-default drift and the task baseline',
    '### 7.1 The state table (normative)',
    '### 7.2 How `claimed` and `running` fail closed',
    '### 7.3 Concurrency',
    '### 8.1 The preservation rule comes first',
    '### 8.2 Execution-layer amendments',
    '### 8.3 Requirement-layer amendments',
    '### 8.4 Removal is never success',
    '### 8.5 What this contract does not change about evidence',
    '### 9.1 The default is review, not implementation',
    '### 9.2 The continuation table (normative)',
    '### 12.1 Local audit',
    '### 12.2 GitHub-visible reporting',
    '### 13.1 `admin review-verification resolve`',
    '### 13.2 The shipped extractor and matching semantics',
    '### 13.3 #918 runner-owned verification',
    '### 13.4 Tool Request continuation (#918 §10, #919)',
    '### 13.5 Session configuration',
    '### 13.6 Phase transitions and admission',
  ];

  test('carries every required subheading, in order', () => {
    const found = rawDoc
      .split('\n')
      .filter((line) => /^### /.test(line))
      .map((line) => line.trimEnd());
    expect(found).toEqual(SUBHEADINGS);
  });
});

describe(`${DOC_PATH} — status and scope`, () => {
  test('is marked approved design with the resolution, persistence, evidence-binding, refresh, operator-surface, and continuation slices implemented', () => {
    expect(doc).toContain(
      'Status: **approved design, resolution and persistence implemented, evidence binding wired, refresh-from-Issue shipped, task operator surface shipped, continuation wired** (contract: issue #1037; persistence: issue #1038; resolution: issue #1039; evidence binding: issue #1040; refresh: issue #1041; operator surface: issue #1042; continuation: issue #1043).',
    );
  });

  test('states what #1037 delivered and what #1038, #1039, #1040, and #1041 added', () => {
    expect(doc).toContain(
      'Issue #1037 delivered this document and its structural contract tests (`test/docs-verification-amendment-contract.test.js`) only, with no runtime behavior.',
    );
    expect(doc).toContain(
      'Issue #1038 added the §5.5 persistence slice (§15 slice A2, `src/core/verification-amendment.ts`)',
    );
    expect(doc).toContain(
      'no behavioral change to the shipped loop, which does not read the new state yet.',
    );
    expect(doc).toContain(
      'Issue #1039 added the §6 resolution half of §15 slice A1 (`src/core/verification-plan.ts`)',
    );
    expect(doc).toContain(
      'a pure core module that reads no live provider state, writes nothing, and executes nothing.',
    );
    expect(doc).toContain(
      'Issue #1040 added the evidence-binding slice (`src/core/verification-evidence.ts`)',
    );
    expect(doc).toContain(
      'records the effective plan digest and revision ordinal, the §5.1 slot identity it was recorded for, and the reviewed branch HEAD',
    );
    expect(doc).toContain(
      'the #918 §8.2 rule 3 posture ("evidence binds to identities, not to time") applied to the operator-attested evidence layer, as evidence-layer bookkeeping in the §8.5 sense, changing no §8 amendment rule.',
    );
    expect(doc).toContain(
      'Legacy evidence that lacks the binding is conservatively inadmissible, and stale evidence fails closed, never deleted (§8.1).',
    );
    expect(doc).toContain(
      'at the time of #1040 the gate itself still read the raw inputs (slice A3 landed later, with issue #1043), so what a task verified was unchanged while what evidence may satisfy it was bound to the plan revision and commit it actually tested.',
    );
    expect(doc).toContain(
      'Issue #1041 added the §10 refresh slice (§15 slice A6, `src/core/verification-refresh.ts` and `admin review-verification refresh`) together with the §5.3 rules 1–2 `revisionId`/`requestKey` derivations it needs',
    );
    expect(doc).toContain(
      'It previews by default, emits no `replace`, withholds every retirement without `--allow-retire`, records the `issueBodyDigest` it read, and refuses whole — writing nothing and consuming no ordinal — on an unsupported provider, a provider failure, a missing Issue, a body with no supported verification section, a body that moved since the preview, or a diff the §10 rule 3 matcher cannot map.',
    );
    expect(doc).toContain(
      'The intake-time body, title, labels, phase, and every other task field stay exactly as intake pinned them (§10 rule 1).',
    );
    expect(doc).toContain(
      'Issue #1042 added the rest of the §11 operator surface (§15 slice A4, `src/core/verification-amend.ts` and the `admin task-verification` commands): the read-only effective-plan view, the operator-typed revision with its order-sensitive operation grammar, and a `reset` that returns an amended plan to its unamended baseline as one ordinary revision.',
    );
    expect(doc).toContain(
      'Each mutation previews by default, applies only under `--yes`, reports both plan digests, and refuses whole — writing nothing and consuming no ordinal — on a claimed, running, or terminal task, a stale plan, a `--expect-plan-digest` mismatch, a pinned entry, or an invalid operation, including when it would otherwise have had nothing to do.',
    );
    expect(doc).toContain(
      'Issue #1043 wired §9 continuation and the requirement half of slice A3.',
    );
    expect(doc).toContain(
      'A `"review"` or `"implementation"` continuation re-queues the task `{queued, <continuation>}` inside the same CAS-guarded transaction that persists the amended plan and its digest (§9.2 rule 2), invalidating the stale missing-command list, per-command status snapshot, and evidence-binding block the park recorded — while `manualVerificationEvidence` is preserved untouched (§8.1) — and a route the table withholds refuses with nothing written (§9.2 rule 3).',
    );
    expect(doc).toContain(
      'Review Step 4.5 now gates on the effective requirement layer: active slots gate at their current bytes, each evaluated under its own slot identity, retired slots are excluded and reported `retired`, never passed (§8.4), and an unresolvable plan on a task carrying recorded amendments blocks review outright — only an unamended task falls back to the raw inputs, where they are exactly the shipped gate.',
    );
    expect(doc).toContain(
      'Review Step 4 still executes the raw `session.verification` values — the execution half of slice A3 is a later change, and the gate deliberately credits no execution-layer `add` it did not run.',
    );
    expect(doc).toContain(
      'Issue #1044 landed the §12.2 reporting slice (§15 slice A7): an applied revision posts one bounded work-item comment, idempotency-keyed on its `revisionId` and carrying no run identifier, enqueued through the outbox in the same transaction as the write, naming every retirement and restoration beside the statement that a retired command is not a passing result, and changing no label — while a refusal, a replay, and a rebase post nothing.',
    );
    expect(doc).toContain(
      "The human gate's run summary states that the plan was amended and what it no longer checks, `admin ui` drives the same §11 commands with the same preview-then-confirm posture, and `admin review-verification resolve` refuses a command an amendment orphaned (§13.1).",
    );
  });

  test('declares itself the authority and requires policy changes to land here first', () => {
    expect(doc).toContain(
      'Follow-up implementation issues reference this specification and MUST NOT redefine its policy; a change of policy is a change to this document first.',
    );
  });

  test('defers to the fixed predecessor contracts it consumes', () => {
    expect(doc).toContain('fixed by `docs/environment-prepare-contract.md` §3.1–§3.3');
    expect(doc).toContain('fixed by `docs/verification-execution-contract.md` (#918)');
    expect(doc).toContain('fixed by `docs/preflight-execution-plan-contract.md` (#915)');
    expect(doc).toContain('fixed by `docs/single-host-execution-backend-contract.md` (#917)');
    expect(doc).toContain('fixed by `docs/unattended-tool-request-contract.md` (#919)');
    expect(doc).toContain(
      'fixed by `docs/admin-cli-contract.md` and `docs/admin-cli-parsing-contract.md`',
    );
  });

  test('defers Issue-body rewriting to the refinement contract and never writes one', () => {
    expect(doc).toContain(
      '**Progressive Issue refinement** — `docs/issue-refinement-contract.md` owns rewriting an Issue body and its managed region. This contract never writes an Issue body (§10 rule 1).',
    );
  });

  test('reuses the shipped extractor and matching semantics as a baseline it never redefines', () => {
    expect(doc).toContain(
      'the shipped `extractIssueVerificationCommands` / `buildIssueVerificationStatus` behavior',
    );
    expect(doc).toContain('the `matchesConfiguredVerificationCommand` rule shared with #918 §10.2');
    expect(doc).toContain('is the recorded baseline this contract reuses, never redefines.');
  });

  test('§1 names the gap: the requirement is pinned at intake and resolve records evidence only', () => {
    expect(doc).toContain('**The Issue-derived requirement is pinned at intake.**');
    expect(doc).toContain(
      "**`review-verification resolve` records evidence, not requirements.**",
    );
    expect(doc).toContain('**Removal is indistinguishable from success.**');
    expect(doc).toContain('**No revision identity.**');
  });
});

describe(`${DOC_PATH} — closed sets (§2)`, () => {
  test('the layer set is closed', () => {
    expect(doc).toContain(
      'The layer set is **closed**: `"session-default"` | `"issue-requirement"` | `"task-amendment"` | `"execution-evidence"` (§3). Adding a layer is a change to this document first.',
    );
  });

  test('the amendment operation set is closed and carries the reversal operation', () => {
    expect(doc).toContain(
      'The operation set is **closed**: `"replace"` | `"add"` | `"retire"` | `"restore"` | `"annotate"` (§5.2). Adding an operation is a change to this document first.',
    );
    expect(doc).toContain(
      'Its serialized shape is fixed by §5.2 so that two implementations derive the same `revisionId` for the same amendment.',
    );
  });

  test('the mutation scope set is closed at "task" this cycle', () => {
    expect(doc).toContain(
      'The scope set is **closed at `"task"` this cycle**: `"task"` is the only supported value (§4).',
    );
  });

  test('command bytes are preserved: only the ends are trimmed, never interior whitespace', () => {
    expect(doc).toContain(
      'with leading and trailing whitespace removed and **nothing else changed**. No case folding, no shell parsing, no shell-wrapper unwrapping, and **no collapsing of interior whitespace**',
    );
    expect(doc).toContain(
      'trimming the ends is safe because a shell ignores them, but an interior run of spaces or tabs may sit inside a quoted argument, where it is data.',
    );
    // Asserted against the raw text on purpose: the normalized copy would
    // collapse the two-space example into the one-space one, which is the
    // exact conflation this rule exists to forbid.
    expect(rawDoc).toContain("`printf 'a  b'`");
    expect(doc).toContain(
      'are two different commands and this contract keeps them that way.',
    );
    expect(doc).toContain(
      'The command bytes are what a slot stores, what the plan digest covers, what a report prints, and what the runner executes; no surface defined here ever hands a rewritten command to #918.',
    );
  });

  test('identity is a separate, byte-preserving representation, never a matching rule', () => {
    expect(doc).toContain(
      'It is a representation *separate* from the command bytes so that identity can never be confused with execution, and it is defined as **the command bytes verbatim**: it trims nothing further, folds no case, and collapses no whitespace, precisely so two commands that differ in shell-significant bytes cannot collapse into one slot.',
    );
    expect(doc).toContain(
      'Identity is a distinct concern from equivalence *matching*, which stays the shipped `matchesConfiguredVerificationCommand` semantics (§13.2).',
    );
  });

  test('distinguishes the plan digest from #918 setFingerprint in the terminology', () => {
    expect(doc).toContain(
      'the SHA-256 over the canonical JSON of the effective plan (§5.4). It is a function of the plan alone: not of revisions, reasons, actors, or timestamps.',
    );
  });
});

describe(`${DOC_PATH} — the four ownership layers and precedence (§3)`, () => {
  test('the layer table carries exactly one row per closed-set member', () => {
    expect(
      countMatches(
        rawDoc,
        /^\| `(?:session-default|issue-requirement|task-amendment|execution-evidence)` \| /gm,
      ),
    ).toBe(4);
  });

  test('names each layer owner and scope', () => {
    expect(doc).toContain('| Session operator | `sessions.json`, `session.verification` | Session |');
    expect(doc).toContain('| Issue author, as pinned at intake |');
    expect(doc).toContain('| Task operator | Task context, append-only (§5.5) | Task |');
    expect(doc).toContain('| Runner, or operator attesting an execution |');
  });

  test('separates what must be checked from what was checked', () => {
    expect(doc).toContain(
      'The first three layers say **what must be checked**. The fourth says **what was checked, and how it came out**.',
    );
    expect(doc).toContain(
      'that is why it can record that a command ran and cannot correct a command that should never have been required.',
    );
  });

  test('§3.2 fixes the precedence order and excludes evidence from it', () => {
    expect(doc).toContain(
      '1. **`task-amendment`** — the latest applied revision that touches the slot.',
    );
    expect(doc).toContain(
      "2. **The slot's origin layer** — `session-default` for an `exec:` slot, `issue-requirement` for a `req:` slot.",
    );
    expect(doc).toContain('`execution-evidence` never participates in precedence.');
    expect(doc).toContain(
      '**Evidence never becomes a requirement, and an amendment never becomes evidence.**',
    );
  });

  test('§3.2 makes the amendment an overlay that never rewrites its origin', () => {
    expect(doc).toContain(
      'A task-scoped amendment **overlays**; it never rewrites its origin. `session.verification` is not edited (§4 rule 3) and `context.body` is not rewritten (§10 rule 1).',
    );
    expect(doc).toContain(
      'Last write wins **per slot**, not per plan: a revision touching `exec:test` leaves `exec:lint` exactly as the previous revision left it.',
    );
  });

  test('§3.3 lets agents propose and never amend', () => {
    expect(doc).toContain('An agent may **propose** verification');
    expect(doc).toContain('A proposal is inert text.');
    expect(doc).toContain(
      'An agent may **never** author, amend, retire, reorder, or skip an amendment. No agent-authored byte becomes an operation, a `commandId`, a `reason`, or an actor, and no agent transcript triggers a revision.',
    );
  });

  test('§3.3 closes the actor kind at operator and reserves no agent actor', () => {
    expect(doc).toContain('The `actor.kind` set is **closed at `"operator"`** this cycle.');
    expect(doc).toContain(
      'There is no agent actor to record and none is reserved.',
    );
    expect(doc).toContain('Nothing here creates an agent-visible amendment API.');
  });
});

describe(`${DOC_PATH} — task-scoped mutation scope (§4)`, () => {
  test('task is the only supported scope and is recorded explicitly', () => {
    expect(doc).toContain('**`"task"` is the only supported mutation scope this cycle.**');
    expect(doc).toContain(
      'Every revision records `scope: "task"`, so a later session-scope mechanism (§17) is an added value in a closed set rather than a reinterpretation of existing records.',
    );
  });

  test('no task-scoped correction mutates sessions.json', () => {
    expect(doc).toContain('**No task-scoped correction mutates `sessions.json`.**');
    expect(doc).toContain(
      'No amendment surface reads-modifies-writes the session registry, adds a key to `session.verification`, or edits the file in any way.',
    );
  });

  test('distinguishes task-local emergency correction from session-default management', () => {
    expect(doc).toContain(
      '**Task-scoped amendment is the emergency correction, not the management surface.**',
    );
    expect(doc).toContain(
      'It is deliberately unsuited to fleet management: it has no cross-task application, no template, and no inheritance.',
    );
    expect(doc).toContain('**Repetition is a signal, not a workflow.**');
    expect(doc).toContain('an advisory line, never a refusal, and never an automatic session write.');
  });

  test('amendments are task-row scoped and never copied between rows', () => {
    expect(doc).toContain('**Amendments are task-row scoped, not attempt scoped.**');
    expect(doc).toContain(
      're-intaking the Issue as a new task row starts from an unamended plan. A revision is never copied between task rows.',
    );
  });
});

describe(`${DOC_PATH} — the revision model (§5)`, () => {
  test('§5.1 identifies a slot, not bytes', () => {
    expect(doc).toContain(
      '`commandId` identifies a **slot**, not bytes. Correcting the bytes is the entire point of an amendment, so an identity derived from the current bytes would dissolve on first use.',
    );
  });

  test('§5.1 fixes both identity forms', () => {
    expect(doc).toContain(
      '**Execution layer.** `commandId = "exec:" + name`, where `name` is the `session.verification` key.',
    );
    expect(doc).toContain(
      '**Requirement layer.** `commandId = "req:" + sha256(command identity form).slice(0, 16)`, lowercase hex, computed **once**, when the slot first enters the task\'s plan',
    );
    expect(doc).toContain(
      'It is thereafter immutable: a `replace` that corrects the bytes keeps the `commandId`',
    );
  });

  test('§5.1 keeps commands that differ in shell-significant bytes in separate slots', () => {
    expect(doc).toContain(
      'The identity form is the command bytes verbatim (§2), so identity is **byte-preserving**: it never collapses interior whitespace and therefore never merges two commands that a shell would run differently.',
    );
    expect(doc).toContain(
      'Two commands that differ only in interior whitespace are **not** the same check under this rule — without shell parsing the difference may be data — so they occupy two slots',
    );
  });

  test('§5.1 fixes the execution-layer name rule and says why it is not cosmetic', () => {
    expect(doc).toContain('The name must match `/^[A-Za-z0-9][A-Za-z0-9._:-]*$/`');
    expect(doc).toContain(
      'The character rule is not cosmetic: the name becomes a path component of a run artifact.',
    );
  });

  test('§5.1 binds the add collision check to the plan it was authored over', () => {
    // A `session.verification` key added after the `add` landed names a slot
    // the authoring check never saw; §6.1 step 1 resolves it, and nothing
    // retroactively refuses the recorded revision.
    expect(doc).toContain(
      '**The collision check is an authoring-time check against the plan the revision was authored over**, and it is the only collision this contract refuses.',
    );
    expect(doc).toContain(
      'It cannot bind the future: a `session.verification` key added after the `add` was applied names a slot the check never saw, and a recorded revision is never retroactively refused (§5.3 rule 6).',
    );
    expect(doc).toContain(
      "§6.1 step 1 resolves that later collision in the task-local slot's favour and reports the session entry masked; nothing about it reaches back into the chain.",
    );
  });

  test('§5.2 carries exactly one table row per operation', () => {
    // Anchored on each row's own verb so the §8.3 evidence table — which
    // keys on the same five operation names — cannot inflate the count.
    expect(
      countMatches(
        rawDoc,
        /^\| `(?:replace|add|retire|restore|annotate)` \| (?:Substitutes|Introduces|Marks|Returns|Records) /gm,
      ),
    ).toBe(5);
    expect(doc).toContain(
      '| `restore` | Returns a `retired` slot to `active`, keeping its `commandId`, its position, and its bytes | `commandId`, `reason` | the slot does not exist; the slot is already `active` |',
    );
  });

  test('§5.2 makes reason mandatory on every operation', () => {
    expect(doc).toContain(
      '**`reason` is mandatory on every operation** and must be non-empty after trimming. There is no default reason and no empty-reason path, and no reason is ever inferred from the operation, the command, or the Issue.',
    );
    expect(doc).toContain('An amendment without a stated reason is an unauditable amendment.');
  });

  test('§5.2 lets one revision-level reason satisfy every operation that lacks its own', () => {
    // Otherwise a multi-operation `amend` with a single `--reason` (§11)
    // could not satisfy the per-operation requirement at all.
    expect(doc).toContain(
      'the revision-level `--reason` (§11 rule 3) **satisfies this rule for every operation that does not carry its own**, and the applying surface materializes it onto each of them, so the persisted operation always carries a non-empty, operator-authored `reason` of its own.',
    );
    expect(doc).toContain(
      'A per-operation reason, when supplied, wins for that operation and for no other.',
    );
  });

  test('§5.2 makes retirement reversible through restore, the only way back', () => {
    expect(doc).toContain('**`retire` is reversible, and `restore` is its reversal.**');
    expect(doc).toContain(
      'No amendment this contract defines is one-way: a mistaken retirement — or a requirement the Issue reintroduces (§10 rule 3) — is reinstated by a `restore` naming the same `commandId`, which returns the slot to `active` at its original position with its original bytes and its whole history intact.',
    );
    expect(doc).toContain(
      'Correcting the bytes of a retired slot is `restore` then `replace`; within a single revision the operations apply in their recorded order (§6.1 step 2), so both may sit in one revision.',
    );
    expect(doc).toContain(
      'Because `add` refuses a `commandId` that collides with a retired slot, `restore` is the *only* way a retired slot returns, and §5.3 rule 6\'s promise that a mistaken amendment is reversed by a later revision therefore holds for retirement as well.',
    );
  });

  test('§5.2 defines the serialized operation as a closed discriminated union', () => {
    expect(doc).toContain(
      '**The serialized operation.** `VerificationAmendmentOperation` is a closed discriminated union on `kind`. Its serialized shape is normative, because `revisionId` is derived from it (§5.3 rule 1) and two implementations that encode it differently would derive different ids for the same amendment:',
    );
    expect(doc).toContain('type VerificationAmendmentOperation =');
    expect(doc).toContain('| { kind: "replace"; commandId: string; command: string; reason: string }');
    expect(doc).toContain(
      '| { kind: "add"; layer: "execution"; name: string; command: string; reason: string }',
    );
    expect(doc).toContain('| { kind: "add"; layer: "requirement"; command: string; reason: string }');
    expect(doc).toContain('| { kind: "retire"; commandId: string; reason: string }');
    expect(doc).toContain('| { kind: "restore"; commandId: string; reason: string }');
    expect(doc).toContain('| { kind: "annotate"; commandId: string; reason: string };');
  });

  test('§5.2 fixes the operation field sets, the canonical encoding, and the identity form', () => {
    expect(doc).toContain(
      '**The field set of each variant is exact.** A field the variant does not list is not permitted, and a field it lists is required — there is no optional field in any variant.',
    );
    expect(doc).toContain(
      'An `add` carries `layer` always and `name` **iff** `layer === "execution"`; a requirement-layer `add` carries no `name`, and its `commandId` is derived at application time (§5.1) rather than supplied.',
    );
    expect(doc).toContain(
      '**`command` and `name` are verbatim.** `command` carries the command bytes of §2 — trimmed at the ends, otherwise unaltered',
    );
    expect(doc).toContain(
      '**Canonical JSON is the encoding**: UTF-8, object keys sorted lexicographically at every level, array order preserved, no insignificant whitespace, and absent fields omitted rather than encoded as `null` or `""`.',
    );
    expect(doc).toContain(
      '**The identity form of an operation omits `reason` and nothing else.** It is what `revisionId` hashes (§5.3 rule 1), so retyping a reason on a retry cannot manufacture a new revision identity',
    );
    expect(doc).toContain(
      '**An unrecognized `kind`, an unrecognized `layer`, an absent required field, or an unexpected extra field fails closed**: the operation is refused and, by §5.3 rule 7, the whole revision with it.',
    );
  });

  test('§5.2 keeps retire from being deletion or success', () => {
    expect(doc).toContain(
      '**`retire` is not deletion.** A retired slot stays in the plan, in the digest (with `state: "retired"`), in the audit record, and in every report. Nothing in this contract removes a slot from a plan.',
    );
    expect(doc).toContain(
      '**`retire` is never success** (§8.4). It changes what is required; it asserts nothing about what passed.',
    );
  });

  test('§5.2 defines no reorder operation and refuses operations on pinned entries', () => {
    expect(doc).toContain('**There is no `reorder` operation.**');
    expect(doc).toContain(
      '**No operation targets a `"verification.pinned"` entry.** #915 plan-approval entries are approval-governed; an operation naming one refuses the whole revision (§6.1 rule 4).',
    );
  });

  test('§5.3 pins the revision record shape', () => {
    expect(doc).toContain('interface VerificationAmendmentRevision {');
    expect(doc).toContain('requestKey: string; // the caller-stable invocation key (§5.3 rule 2)');
    expect(doc).toContain(
      'sessionBaselineDigest: string; // the session-default layer it was authored over (§6.4)',
    );
    expect(doc).toContain('scope: "task"; // §4 rule 2');
    expect(doc).toContain('source: "admin-cli" | "chatops" | "issue-refresh";');
    expect(doc).toContain('actor: { kind: "operator"; id: string };');
    expect(doc).toContain('basePlanDigest: string; // the plan this revision was authored against');
    expect(doc).toContain('planDigest: string; // the plan this revision produces');
    expect(doc).toContain('continuation: "review" | "implementation" | "none";');
    expect(doc).toContain('observedTaskRevision: number; // the AiTask.revision the CAS write observed');
    expect(doc).toContain(
      'issueBodyDigest?: string; // §10 rule 6; iff source === "issue-refresh"',
    );
  });

  test('§5.3 makes requestKey the idempotency key and revisionId the content address', () => {
    expect(doc).toContain(
      '**`requestKey` is the idempotency key; `revisionId` names what was applied.**',
    );
    // The lookup has to precede the plan recomputation, or a retry of a
    // committed-but-unacknowledged amendment rereads the amended plan and
    // fails the base-digest comparison instead of being recognized.
    expect(doc).toContain(
      'Replay recognition looks the task\'s chain up on `(sessionId, issueNumber, requestKey)`, and it does so **before** the plan is recomputed, before `basePlanDigest` is compared, and before the §7.3 staleness check runs, so a retry is recognized as a replay (rule 3) even when its own first attempt already moved the plan.',
    );
    expect(doc).toContain(
      'A `requestKey` is therefore unique per task row: two distinct revisions on one task never carry the same key.',
    );
    expect(doc).toContain(
      '`revisionId = "vamd-" + sha256(canonicalJson({ sessionId, issueNumber, requestKey, basePlanDigest, operations})).slice(0, 16)`, where `operations` is the §5.2 identity form of the operation list — the canonical serialization with every operation\'s `reason` omitted.',
    );
    expect(doc).toContain(
      'It is the **content address of an applied revision**, and it is what downstream keys reference — the §12.2 public comment, the §8.3 per-slot evidence invalidation record, every report.',
    );
    expect(doc).toContain(
      'It is **not** what a retry is matched on: a retry that rereads an already-amended plan reads a different `basePlanDigest` and would derive a different id from the same command line.',
    );
    // The continuation exclusion is direct only: a derived requestKey
    // carries the typed `--continue`, so two routing-different requests
    // are two revisions rather than one replayed one.
    expect(doc).toContain(
      'That exclusion is **direct**: a *derived* `requestKey` carries the requested continuation (rule 2), so two otherwise-identical invocations that differ only in `--continue` present different keys and therefore earn different ids — which is correct, because they are two requests, not one amendment described twice.',
    );
  });

  test('§5.3 keeps the write-time ordinal out of the retry identity', () => {
    // The ordinal is assigned when the revision lands, so hashing it would
    // give a retry of an applied-but-unacknowledged invocation a fresh id —
    // and a repeated `annotate`, which moves neither the plan nor its
    // digest, would append twice while presenting the same base digest.
    expect(doc).toContain('**`revisionOrdinal` is deliberately not an input to either.**');
    expect(doc).toContain(
      'The ordinal is assigned at write time, so hashing it would give every retry of an applied-but-unacknowledged invocation a fresh id — which is exactly the duplicate `requestKey` exists to prevent, and which bites hardest on the one operation that changes neither the plan nor its digest: a repeated `annotate` would otherwise be appended twice, once per attempt, while presenting the same `basePlanDigest` both times.',
    );
  });

  test('§5.3 derives the request key from caller-stable inputs, excluding the base plan digest', () => {
    expect(doc).toContain(
      '**`requestKey` is the caller\'s stable handle on one invocation, and is derived from caller-stable inputs alone.**',
    );
    expect(doc).toContain(
      'It is operator-supplied through `--request-key <token>` (§11 rule 3) and, when absent, **derived** as `sha256(canonicalJson({sessionId, issueNumber, source, requestedContinuation, operations}))` over the same identity form, so an operator who simply reruns an unchanged command line after a lost response reuses it without knowing the flag exists.',
    );
    // `--continue` changes the routing effect, so it is part of the
    // request identity; the *resolved* default is not, because it reads
    // task state and would break the lost-response retry.
    expect(doc).toContain(
      '**`requestedContinuation` is the `--continue` value exactly as typed, and `null` when the flag is absent.**',
    );
    expect(doc).toContain(
      'an `annotate --continue none` and the same annotation with `--continue implementation` are two different requests — one records, one records and routes — and a key blind to the flag would derive one value for both, so the second would be silently reported as a replay and its routing never taken.',
    );
    expect(doc).toContain(
      'The *resolved* continuation of §9.2 rule 3 is deliberately not hashed: the resolution reads the task\'s state, so hashing it would put a non-caller-stable value into the key and break the lost-response retry the moment the first attempt moved the task.',
    );
    // The lost-response retry rereads the plan its own first attempt
    // produced; a key hashing that plan would derive a fresh value and
    // double-apply.
    expect(doc).toContain(
      '**`basePlanDigest` is deliberately not an input to the derivation.**',
    );
    expect(doc).toContain(
      'A key that hashed the base plan would derive a different value on that second read, miss the stored revision, and let the amendment apply a second time — or be refused as stale or as a no-op — instead of being reported as the replay it is.',
    );
    expect(doc).toContain(
      'The key must be computable from what the caller typed, never from what the caller\'s earlier attempt changed; an operator-supplied token has that property by construction.',
    );
    expect(doc).toContain(
      'A supplied token must be non-empty after trimming and must match `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/`; a violation exits non-zero and mutates nothing (§11 rule 2).',
    );
  });

  test('§5.3 recognizes a repeat as a replay that writes nothing and exits zero', () => {
    expect(doc).toContain('**A repeat is recognized, not reapplied.**');
    expect(doc).toContain(
      'An invocation whose `requestKey` already appears on the task\'s revision chain is a **replay**: nothing is written, no `revisionOrdinal` is consumed, no event is appended, no comment is posted, and no continuation is re-taken.',
    );
    expect(doc).toContain(
      'The surface reports the stored revision — its `revisionId`, its `revisionOrdinal`, and the `planDigest` it produced — and exits **zero**; a replay is a repeat, not a refusal (§11 rule 5).',
    );
    expect(doc).toContain(
      'Because the lookup precedes every plan comparison (rule 1), a replay is never reported as stale, as a no-op, or as a fresh amendment, however far the plan moved between the two attempts.',
    );
    expect(doc).toContain(
      'The cost of a key that ignores the base plan is that a *deliberate* second application of the same operations — in practice the plan-neutral one, a second `annotate` whose new wording the identity form drops with every other `reason` — is indistinguishable by content from a retry, and so requires an explicit distinct `--request-key`; that flag is the only way to ask for one, and the replay report names it.',
    );
  });

  test('§5.3 makes a stale base plan digest a refusal, measured against the live plan', () => {
    expect(doc).toContain('**`basePlanDigest` is what the operator saw.**');
    expect(doc).toContain(
      'A revision whose `basePlanDigest` does not equal the current plan\'s digest at write time is **stale** and is refused (§7.3) — but only once the rule 3 replay lookup has found no match, so a lost-response retry is a replay rather than a stale refusal.',
    );
    expect(doc).toContain(
      '"The current plan\'s digest" is the digest recomputed from the live inputs and the chain (§6.4 rule 6), never the stored one, so a session-configuration change between the read and the write refuses as stale rather than landing on a plan the operator never saw.',
    );
  });

  test('§5.3 makes the record append-only and revisions atomic', () => {
    expect(doc).toContain(
      '**The record is append-only.** A revision is never rewritten, reordered, merged, compacted, or removed. Correcting a mistaken amendment is a new revision that reverses it, with its own reason — never an edit of the old one.',
    );
    expect(doc).toContain('partial application is never a permitted outcome.');
  });

  // The reviewed contradiction: §5.2 permits `replace` on an active slot,
  // operations apply in recorded order, and `retire` retains the slot — so
  // `replace S` then `retire S` composes, and calling it invalid left two
  // readings of the same amendment.
  test('§5.3 rule 7 composes operations sequentially, not against the base plan', () => {
    expect(doc).toContain('**Composition is sequential; atomicity is all-or-nothing.**');
    expect(doc).toContain(
      'Every operation of a revision is validated against the plan state its predecessors *in the same revision* produced, in recorded order (§6.1 step 2) — never against the base plan.',
    );
    expect(doc).toContain(
      '`replace S` then `retire S` is **valid too**, and produces one slot carrying the replaced bytes in state `retired` — `retire` retains the slot rather than removing it (§5.2 rule 2), so nothing the `replace` wrote is undone, and the §5.4 digest records the new bytes with `state: "retired"`.',
    );
    expect(doc).toContain(
      'Neither ordering of a valid pair is rewritten, reordered, or collapsed: the recorded order is the applied order, and replay (§6.1 step 2) reproduces it.',
    );
  });

  test('§5.3 rule 7 lists the refusing compositions against the intermediate state', () => {
    expect(doc).toContain(
      '**A composition whose later operation meets its own §5.2 refusal condition against that intermediate state refuses.**',
    );
    expect(doc).toContain(
      'The cases are exactly the table\'s, read against the intermediate state: `retire S` then `replace S` (the slot is `retired` when the replace reads it — `restore` it first), `retire S` twice or `restore S` twice (the second finds the state it wants already set), an `add` whose `commandId` collides with one an earlier `add` in the same revision created, and a `replace` whose bytes equal what an earlier operation in the same revision left on the slot (still a no-op, and a no-op is still not a revision).',
    );
    expect(doc).toContain(
      'When any operation refuses, **the whole revision refuses**: nothing is written, no `revisionOrdinal` is consumed, no event is appended, and partial application is never a permitted outcome.',
    );
    // The pre-review wording called `replace`-then-`retire` an invalid
    // composition, which contradicted §5.2 rule 2's "retire is not deletion".
    expect(doc).not.toContain('a `replace` of a slot a later `retire` in the same revision removes');
  });

  test('§5.4 fixes the plan digest object and its exclusions', () => {
    expect(doc).toContain('`planDigest = sha256(canonicalJson(plan))`');
    expect(doc).toContain(
      '{ "execution": [ { "commandId": "exec:test", "state": "active", "command": "npm test" } ], "requirement": [ { "commandId": "req:0f3b…", "state": "retired", "command": "npm run e2e" } ] }',
    );
    expect(doc).toContain('`state` is `"active"` | `"retired"` — a closed set.');
    expect(doc).toContain(
      '`command` is the slot\'s command bytes (§2), verbatim — the digest is taken over what the runner would execute, not over a rewritten form of it, so two plans whose commands differ in shell-significant bytes have different digests.',
    );
    expect(doc).toContain(
      'The digest covers **the plan and nothing else**: no revision ids, no reasons, no actors, no timestamps, no evidence.',
    );
    expect(doc).toContain(
      'Two different revision paths that arrive at the same plan therefore produce the same digest',
    );
  });

  test('§5.4 separates planDigest from #918 setFingerprint', () => {
    expect(doc).toContain("It is **not** #918's `setFingerprint`.");
    expect(doc).toContain(
      'The two are different digests over different things; neither is derived from the other, and an implementation must not substitute one for the other.',
    );
  });

  test('§5.5 requires no new column, table, status, phase, or store method', () => {
    expect(doc).toContain(
      '**No new column, table, `TaskStatus`, `TaskPhase`, or store method is required.** The amendment is task context plus one task event (§12.1); the write is an ordinary compare-and-swap on `AiTask.revision`.',
    );
  });

  test('§5.5 records the session baseline on the checkpoint', () => {
    expect(doc).toContain(
      '**The session baseline lives on the checkpoint** — the `sessionBaseline` snapshot and its `sessionBaselineDigest` (§6.4 rule 1) — so that a later `session.verification` change is attributable to the session layer instead of being read as task-row corruption.',
    );
  });

  test('§5.5 splits the append-only chain from one mutable plan checkpoint', () => {
    // The reviewed gap: a rebase (§6.4 rule 5) has to move the digest
    // reconciliation compares against, and the only digest field defined
    // before this split lived on an append-only revision record.
    expect(doc).toContain(
      'The stored state has **two parts with two different mutability rules**, and conflating them is the one way this record corrupts itself:',
    );
    expect(doc).toContain(
      '**The revision chain** — stored in ascending `revisionOrdinal`, append-only. Every field of every `VerificationAmendmentRevision` (§5.3) is immutable once written, its `basePlanDigest`, its `planDigest`, and its `sessionBaselineDigest` included: each records what was true when *that* revision was applied, and nothing — not a later revision, not a §6.4 rule 5 rebase — ever rewrites one (§5.3 rule 6).',
    );
    expect(doc).toContain(
      '**The plan checkpoint** — exactly one per task, **mutable**, replaced wholesale by the surface that applies a revision or performs a rebase. It is stored in the same task context as the chain and so introduces no column of its own:',
    );
    for (const field of [
      'planDigest: string; // §5.4, over the plan §6 resolves *now*',
      'sessionBaseline: readonly { name: string; command: string }[]; // §6.4 rule 1',
      'sessionBaselineDigest: string; // sha256(canonicalJson(sessionBaseline))',
      'appliedThroughOrdinal: number; // the highest revisionOrdinal the checkpoint covers',
      'updatedBy: "revision" | "rebase"; // a closed set',
    ]) {
      expect(doc).toContain(field);
    }
  });

  test('§5.5 points every reconciliation at the checkpoint, never at a revision', () => {
    expect(doc).toContain('**"The stored `planDigest`" always means the checkpoint\'s.**');
    expect(doc).toContain(
      'Every reconciliation in this document — §6.4 rule 3, §11 rule 6 — compares against `checkpoint.planDigest` and against no revision\'s.',
    );
    expect(doc).toContain(
      'A revision\'s `planDigest` is *history*: the plan that revision produced, over the session baseline it was authored over, and it stays correct forever precisely because nothing updates it. The checkpoint is the present tense: the plan the task is understood to be running under right now.',
    );
  });

  test('§5.5 confines a rebase to the checkpoint and names both forbidden alternatives', () => {
    expect(doc).toContain('**A rebase writes the checkpoint and nothing else.**');
    expect(doc).toContain(
      '§6.4 rule 5\'s re-anchoring replaces `planDigest`, `sessionBaseline`, and `sessionBaselineDigest` with the live values and sets `updatedBy: "rebase"`, leaving `appliedThroughOrdinal` unchanged — no revision was applied, so no ordinal was consumed. It touches no revision record.',
    );
    expect(doc).toContain(
      'Without this split a rebase would have to either overwrite the newest revision\'s `planDigest`, corrupting the append-only audit record, or leave a stale digest in place, making every later reconciliation compare against the pre-drift plan and refuse a task whose plan is correct. Both are forbidden; the checkpoint is what makes neither necessary.',
    );
  });

  test('§5.5 writes chain and checkpoint in one transaction, and needs neither before the first revision', () => {
    expect(doc).toContain('**An applied revision writes both, in one transaction.**');
    expect(doc).toContain(
      'The revision is appended and the checkpoint is replaced in the same CAS write, with that revision\'s `planDigest`, the `session.verification` snapshot observed inside the transaction (§6.4 rule 1), `appliedThroughOrdinal = revisionOrdinal`, and `updatedBy: "revision"`. There is no commit boundary between the two, so they cannot diverge.',
    );
    expect(doc).toContain(
      '**A task with no revision has no checkpoint**, and needs none: resolution is total (§6.3), so the plan is whatever §6 computes from the live inputs and there is nothing to reconcile against. The checkpoint comes into existence with the first revision (§6.4 rule 1) and never returns to absent.',
    );
  });

  test('§5.5 fails closed on malformed persisted state but not on attributable drift', () => {
    expect(doc).toContain(
      'Malformed persisted state — a chain that does not parse, an ordinal gap, or a stored digest that reconciles against **neither** the live inputs nor the recorded session baseline (§6.4 rule 3) — **fails closed** (§11 rule 6): it is refused, never coerced to a default, never silently repaired, and never overwritten.',
    );
    expect(doc).toContain(
      'A stored digest that reconciles against the baseline is authorized session drift, not malformed state, and is rebased rather than refused (§6.4 rule 5).',
    );
    expect(doc).toContain(
      'The checkpoint has **two malformed forms of its own**, and they fail closed the same way: a chain that carries revisions with no checkpoint beside it, and a checkpoint whose `appliedThroughOrdinal` differs from the chain\'s highest `revisionOrdinal`. Each says a write landed half applied, which rule 3\'s single transaction makes impossible; neither is repaired by recomputing the missing half.',
    );
  });
});

describe(`${DOC_PATH} — effective plan resolution (§6)`, () => {
  test('resolution is deterministic, total, and reads no live or agent input', () => {
    expect(doc).toContain(
      'It is a pure function of `(session.verification, context.body, the revision chain, the recorded session baseline)`; it reads no live provider state, no agent output, and no evidence.',
    );
    expect(doc).toContain(
      'It is also **pure in the other direction**: resolving a plan writes nothing, so the reconciliation of §6.4 classifies and reports, and only a surface that already holds a write transaction records the result.',
    );
    expect(doc).toContain(
      'Resolution is total: an empty `session.verification`, an absent `context.body`, an empty revision chain, and any combination of them resolve to a well-defined (possibly empty) plan with a well-defined digest.',
    );
  });

  test('§6.1 preserves #918 §5.1 ordering and its non-derivation rule', () => {
    expect(doc).toContain(
      '#918 §5.1 rule 3\'s non-derivation rule holds unchanged, because an amendment is operator *authored*, never derived — no issue text, agent output, PR content, or auto-detection contributes a command.',
    );
    expect(doc).toContain(
      '`add` appends a new `exec:<name>` slot after every slot already in the set, so additions accumulate in revision-then-operation order.',
    );
  });

  test('§6.1 masks a session key that collides with a task-local add', () => {
    // The reviewed gap: an operator adds `exec:lint` task-locally, the
    // session configuration later declares a `lint` key, and a replay that
    // materialized both would put two slots with one `commandId` — one log
    // artifact, one failure message — into the plan.
    expect(doc).toContain(
      '**A session entry whose `exec:<name>` identity is already claimed by an execution-layer `add` in the applied chain materializes no slot here.**',
    );
    expect(doc).toContain(
      "The task-local slot owns the identity — §3.2's precedence, applied to a collision the authoring check could not have seen because the session key did not exist when the `add` was authored (§5.1) — and the session entry is reported **masked by** that `add` revision (§6.4 rule 4).",
    );
    expect(doc).toContain(
      'This is the only case in which step 1 skips a live `session.verification` entry, and it exists because the two alternatives are both worse: materializing the entry as well would put two slots with one `commandId` in the plan, sharing one `verification-<name>.log` artifact (#918 §11.1) and one failure message, and refusing resolution would wedge an amended task on a session edit the operator made in good faith for every other task in the session — against §6.3\'s totality.',
    );
    expect(doc).toContain(
      '**Masking is keyed on the `add` being present in the chain, not on the state of the slot it created**: retiring the task-local slot does not unmask the session entry and swap its bytes back into the plan, because a retirement asserts what must not run, not which bytes should run instead.',
    );
    expect(doc).toContain(
      'An operator who decides the session bytes are the right ones adopts them with a `replace` on the task-local slot, which is recorded, reasoned, and visible like every other amendment.',
    );
    expect(doc).toContain(
      'Because step 1 skips a colliding session entry, the replay never produces two slots with one `commandId`, and the added slot keeps its append position rather than moving to the declaration position of the session key that arrived after it.',
    );
  });

  test('§6.1 restores a retired slot in place rather than appending it', () => {
    expect(doc).toContain(
      '`restore exec:<name>` sets a `retired` slot\'s state back to `active`; the slot keeps its original position and bytes, so a restored command returns to the set exactly where it left it, never appended at the end.',
    );
  });

  test('§6.1 makes an operation against an absent slot inert rather than a refusal', () => {
    // Resolution replays a recorded chain and must stay total (§6.3), so a
    // stored operation whose slot no longer exists is skipped, never
    // materialized out of the recorded baseline.
    expect(doc).toContain(
      '**An operation whose target slot is not in the set when the replay reaches it is inert**: it is skipped, it changes no bytes, state, or position, and resolution continues past it.',
    );
    expect(doc).toContain(
      'It never materializes a slot that step 1 did not produce and no `add` created, and it never refuses — §6.3\'s totality holds over every recorded chain.',
    );
    expect(doc).toContain(
      'This is the removed-`session.verification`-key case, and §6.4 rule 4 reports the slot **orphaned**. Only *authoring* refuses an operation against an absent slot (§5.2, §5.3 rule 7); replaying an already-recorded chain does not.',
    );
  });

  test('§6.1 never touches a pinned entry', () => {
    expect(doc).toContain(
      '**Amendments never precede, displace, reorder, or modify a `"verification.pinned"` entry.** An operation naming a pinned entry refuses the revision (§5.2 rule 6). Correcting an approved plan entry is #915\'s approval renewal, not an amendment.',
    );
  });

  test('§6.1 makes a task-scoped add standing operator authorization', () => {
    expect(doc).toContain(
      '**A task-scoped `add` is standing operator authorization, scoped to one task.**',
    );
    expect(doc).toContain(
      'It requires no Tool Request, no grant, and no per-run approval, and it changes no tier, backend, or class: the added command resolves as `"verification.run"` exactly as a session entry does.',
    );
  });

  test('§6.1 names the common correction as an execution-layer add', () => {
    expect(doc).toContain(
      'The fix is an **execution-layer `add`** naming the command, not a requirement-layer edit — the requirement was right, the executable set was incomplete.',
    );
  });

  test('§6.2 keeps the shipped satisfaction semantics and writes no status', () => {
    expect(doc).toContain(
      'Satisfaction is computed at review time by the shipped `buildIssueVerificationStatus` semantics, unchanged',
    );
    expect(doc).toContain(
      'or when a passing (exit 0) `manualVerificationEvidence` entry matches it **and carries no §8.3 rule 1 invalidation record naming that slot\'s `commandId`** — the one clause §8.3 rule 2 adds, and the only one;',
    );
    expect(doc).toContain(
      'Retired slots are excluded from the gate and reported `retired` (§8.4), never `passed` and never `not_run`.',
    );
    expect(doc).toContain(
      '**Resolution never writes a status.** An amendment can make a slot satisfiable; only a later review run\'s evaluation makes it satisfied. No amendment path writes `passed` into any status field, ever.',
    );
  });

  test('§6.3 keeps an empty plan from reading as a pass', () => {
    expect(doc).toContain(
      'An empty plan is not an error and is not "verification passed"; it is a plan with nothing in it, and #918 §8.1\'s trivially-`passed` empty-set rule governs execution unchanged.',
    );
  });

  test('§6.4 names the collision a task baseline exists to resolve', () => {
    // Without a baseline, a legitimate `session.verification` fix would make
    // every amended task in the session look hand-edited and be refused.
    expect(doc).toContain(
      'Both rules are right, and without a recorded baseline they collide: an authorized session edit would be indistinguishable from a tampered task row, and every amended task in the session would be refused for a plan that is perfectly correct.',
    );
    expect(doc).toContain(
      'The **session baseline** resolves the collision by making drift *attributable* instead of assumed hostile.',
    );
  });

  test('§6.4 records the baseline on the checkpoint and executes nothing from it', () => {
    expect(doc).toContain('**The baseline is recorded on the checkpoint.**');
    expect(doc).toContain(
      'the write creates the §5.5 plan checkpoint and records `sessionBaseline` on it — the ordered `{name, command}` pairs of `session.verification` as observed inside that transaction, command bytes verbatim (§2) — and `sessionBaselineDigest = sha256(canonicalJson(sessionBaseline))`.',
    );
    expect(doc).toContain(
      'The baseline is a copy of operator input kept for attribution only: nothing executes from it, and it is never a second source of truth for what to run.',
    );
  });

  test('§6.4 defines drift and keeps a hand edit from wearing its name', () => {
    expect(doc).toContain('**Drift is defined, not inferred.**');
    expect(doc).toContain(
      'The session-default layer has drifted for a task when the digest of the live `session.verification` differs from the stored `sessionBaselineDigest`.',
    );
    expect(doc).toContain(
      'a stored `planDigest` that disagrees while the baseline digest matches is not drift, it is a hand edit.',
    );
  });

  test('§6.4 classifies reconciliation three ways and refuses only the corrupt one', () => {
    expect(doc).toContain(
      '**Reconciliation is three-way, and only one outcome is corruption.**',
    );
    expect(doc).toContain(
      '- **unreconciled** — recomputing §6 over the live inputs and the chain disagrees with the stored `planDigest`, *and* replaying the same chain over the recorded `sessionBaseline` (with `context.body` unchanged, as it always is) does not reproduce it either.',
    );
    expect(doc).toContain(
      '- **drifted** — the state is not `unreconciled` and the baseline test says the session layer moved. Proceed on the **live** plan and rebase (rule 5). This is **not** a refusal, and an implementation that refuses here is refusing a correct plan.',
    );
    expect(doc).toContain(
      '- **consistent** — the baseline test says the session layer did not move, and the recomputation reproduces the stored `planDigest`. Proceed, and rebase nothing.',
    );
    expect(doc).toContain(
      'Only the first outcome is the hand-edit refusal §11 rule 6 describes.',
    );
    expect(doc).toContain(
      'Throughout, **the stored `planDigest` is the checkpoint\'s** (§5.5 rule 1) — never a revision\'s, which records history and is not a statement about the plan now — and **the baseline test is rule 2\'s**: the digest of the live `session.verification` against the stored `sessionBaselineDigest`.',
    );
  });

  // The reviewed gap: with `consistent` evaluated first and keyed on the plan
  // digest, a session edit that §6.1 step 1 masks reproduced the checkpoint
  // digest, bypassed `drifted`, and silently skipped the promised re-anchor,
  // report, and event.
  test('§6.4 makes a plan-neutral session change drift on the baseline, not the plan digest', () => {
    expect(doc).toContain('**The classification is on the baseline, not on the plan digest.**');
    expect(doc).toContain(
      'A session change that leaves the effective plan byte-identical still classifies `drifted` — above all the §6.1 step 1 mask, where a session key arriving under an execution-layer `add` materializes no slot and so moves no digest at all.',
    );
    expect(doc).toContain(
      'Such a **plan-neutral drift** re-anchors the checkpoint and reports its rule 4 disposition exactly as a plan-visible one does; only the rebase\'s `planDigest` is then unchanged (rule 5).',
    );
    expect(doc).toContain(
      'Testing the plan digest first would classify precisely these changes `consistent`, leaving the checkpoint anchored to a `sessionBaseline` the session no longer has, skipping the promised masked-entry report and its `verification.amendment.rebased` event, and deferring the drift until some later edit happened to move the plan — at which point the recorded baseline would be two session edits behind and the rule 4 dispositions would be computed against the wrong "before".',
    );
    expect(doc).toContain(
      '**A plan-neutral drift rebases like any other**: the two `sessionBaselineDigest`s in the event differ, the two `planDigest`s are equal, the checkpoint is re-anchored all the same, and the event is then the only record that the session layer moved under this task — which is why the rebase is driven by rule 3\'s baseline test and never skipped for want of a digest change.',
    );
  });

  test('§6.4 states that the three classifications are exhaustive and disjoint', () => {
    expect(doc).toContain(
      'The three are exhaustive and disjoint. When the baseline digest matches, the live session entries and the recorded baseline are the same input, so the live recomputation and the baseline replay agree and the outcome is `consistent` or `unreconciled`; when it differs, the outcome is `drifted` or `unreconciled`.',
    );
  });

  test('§6.4 fixes the per-slot dispositions, including masked and orphaned slots', () => {
    expect(doc).toContain(
      '**Precedence is unchanged under drift, and every disposition is reported.**',
    );
    expect(doc).toContain(
      'the reconciliation reports the session change as **masked by** the revision that named the slot, so the operator who fixed the session sees why this task is unaffected and can reverse the amendment with a further revision (§5.3 rule 6);',
    );
    // §6.1 step 1 materializes execution slots from the live session map
    // alone, so a stored `replace` cannot keep a slot whose session key is
    // gone — the disposition has to say orphaned, not survives.
    expect(doc).toContain(
      'a session key that disappeared — an **execution-layer `add` slot is unaffected**: it is task-local, the chain itself materializes it (§6.1 step 2), and it has no session origin to lose.',
    );
    expect(doc).toContain(
      'A slot that exists only because `session.verification` declared it **leaves the plan and is reported orphaned**, and it does so *even when a revision `replace`d, retired, restored, or annotated it*: §6.1 step 1 materializes execution slots from the live `session.verification` map and from nothing else, so with the key gone there is no base slot for those operations to apply to and they are inert (§6.1 step 2).',
    );
    expect(doc).toContain(
      'An implementation must **not** resurrect the slot from the recorded `sessionBaseline` — the baseline is attribution-only input that nothing executes from (rule 1), and a plan assembled partly from it would run bytes the operator has since deleted from the session.',
    );
    expect(doc).toContain(
      '`orphaned` is a reporting term, never a slot state: the slot is simply absent from the plan and from the digest, its operations stay in the append-only chain, and if the key returns the chain replays onto it again — resolution always replays from scratch (§6.1), so the returning slot regains its `replace`d bytes and its retired-or-restored state, and can neither lose nor collide with the operations recorded against it;',
    );
    expect(doc).toContain(
      'No disposition deletes a revision, rewrites an operation, invents one, or writes a status (§6.2 rule 4).',
    );
  });

  test('§6.4 gives an arriving session key that collides with an add the masked disposition', () => {
    expect(doc).toContain(
      'a session key that appeared — an ordinary new `exec:` slot, `active`, at its declaration position (§6.1 step 1) — **unless its `exec:<name>` collides with an execution-layer `add` already in the chain**, in which case step 1 materializes no slot for it and the reconciliation reports it **masked by** that `add`.',
    );
    expect(doc).toContain(
      'It is the same disposition as a changed session entry under a `replace`d slot, and for the same reason: an amendment owns the slot it named. One `commandId` is therefore never two slots, resolution never refuses over the collision, and the operator who added the session key sees from the mask why this one task still runs its task-local bytes.',
    );
  });

  test('§6.4 makes a rebase a re-anchoring, not an amendment', () => {
    expect(doc).toContain('**A rebase records the new anchor; it is not an amendment.**');
    expect(doc).toContain(
      'the first surface that both observes the drift and holds a write transaction — an applying `amend` or `refresh`, or the phase runner resolving the plan at claim time — updates the **§5.5 plan checkpoint**, and only it: its `sessionBaseline`, `sessionBaselineDigest`, and `planDigest` take the live values and `updatedBy` becomes `"rebase"`, under the ordinary CAS on `AiTask.revision`.',
    );
    expect(doc).toContain(
      'It then appends one `verification.amendment.rebased` task event (§12.1) carrying both baseline digests, both plan digests, and the rule 4 dispositions.',
    );
    // The rebase moves the mutable checkpoint; the append-only revision
    // records keep saying what each revision produced (§5.5 rule 2).
    expect(doc).toContain(
      'A rebase **creates no revision, consumes no `revisionOrdinal`, changes no operation, rewrites no revision record — the `planDigest` of every applied revision keeps saying what that revision produced (§5.5 rule 2) — takes no continuation (§9), and posts no public comment (§12.2)**: the operator-owned plan did not change, the ground under it did.',
    );
    expect(doc).toContain(
      'Read-only surfaces (`plan`, reports) name the drift in their output and write nothing; the next writing surface rebases.',
    );
  });

  test('§6.4 refuses a revision authored before the drift as stale, not corrupt', () => {
    expect(doc).toContain(
      '**A revision authored against a drifted plan is stale, not corrupt.**',
    );
    expect(doc).toContain(
      'That refusal is what makes rule 5\'s rebase safe: a rebase never carries a revision onto a plan its author did not see.',
    );
  });
});

describe(`${DOC_PATH} — admissible task states (§7)`, () => {
  test('the §7.1 table carries one row for every TaskStatus', () => {
    expect(countMatches(rawDoc, /^\| `\w+` \| \*\*(?:permitted|refused)\*\* \| /gm)).toBe(8);
  });

  test('permits queued, blocked, and ready_for_human', () => {
    expect(doc).toContain(
      '| `queued` | **permitted** | Nothing holds the task; the next claim resolves the amended plan |',
    );
    expect(doc).toContain(
      '| `blocked` | **permitted** | The implementation-lane human park (issue #224); no owner holds the row |',
    );
    expect(doc).toContain(
      '| `ready_for_human` | **permitted** | The primary case — the review Step 4.5 missing-command handoff |',
    );
  });

  test('refuses claimed, running, and every terminal status', () => {
    expect(doc).toContain('| `claimed` | **refused** |');
    expect(doc).toContain('| `running` | **refused** |');
    expect(doc).toContain('| `done` | **refused** | Terminal; no future cycle reads the plan |');
    expect(doc).toContain('| `failed` | **refused** |');
    expect(doc).toContain('| `cancelled` | **refused** |');
  });

  test('§7.2 makes the active-task refusal unconditional with no --force', () => {
    expect(doc).toContain(
      '**The refusal is unconditional.** No flag overrides it. There is no `--force`, and none may be added: a forced amendment is precisely the race the CAS cannot see, because the owning run holds its resolved plan in memory and will not re-read it.',
    );
  });

  test('§7.2 stores nothing on refusal and defines no pending amendment', () => {
    expect(doc).toContain(
      '**The refusal is a refusal, not a queue.** Nothing is stored, no revision is created, no `revisionOrdinal` is consumed, and no event is appended.',
    );
    expect(doc).toContain('the contract defines no deferred or pending amendment.');
  });

  test('§7.2 mirrors the shipped active-task refusal and exits non-zero', () => {
    expect(doc).toContain(
      'This mirrors the shipped `review-verification resolve` refusal on active tasks verbatim; it invents no new phrasing and no new posture.',
    );
    expect(doc).toContain(
      '**The refusal exits non-zero** (§11 rule 5) so scripted use cannot mistake it for a no-op success.',
    );
  });

  test('§7.2 distinguishes the active refusal from the terminal refusal', () => {
    expect(doc).toContain(
      '**Terminal statuses refuse for a different reason and say so.**',
    );
    expect(doc).toContain(
      'The two messages must be distinguishable — the second one names the reactivation path, the first one names waiting.',
    );
  });

  test('§7.3 fixes the CAS guard, the stale message, and the optional digest guard', () => {
    expect(doc).toContain(
      '**The guard is a compare-and-swap on `AiTask.revision`**, plus the §7.1 status check re-evaluated inside the same transaction.',
    );
    expect(doc).toContain(
      'the message names the observed and current revision, and the observed and current `planDigest`',
    );
    expect(doc).toContain(
      'When the difference is session-default drift (§6.4 rule 2) rather than a competing revision, the message says so and names the drift, because the two have different fixes: waiting out another operator versus re-reading a plan whose session layer moved.',
    );
    expect(doc).toContain(
      'a plan can be changed and changed back, and an operator who pinned a digest asked for exactly that check.',
    );
  });

  test('§7.3 introduces no new lock', () => {
    expect(doc).toContain(
      '**No new lock is introduced.** An amendment is a metadata write on the task row; it takes no worktree lock, no issue lock, and no maintenance lock. The `claimed`/`running` refusal plus the CAS is the complete concurrency contract, and an implementation that adds a lock is changing this document first.',
    );
  });
});

describe(`${DOC_PATH} — evidence invalidation and preservation (§8)`, () => {
  test('§8.1 states the preservation rule first', () => {
    expect(doc).toContain(
      '**No amendment ever deletes evidence.** Not a cycle bundle, not a manual evidence entry, not a run artifact, not a prior revision.',
    );
    expect(doc).toContain(
      '"Invalidation" in this section means exactly one thing: *no longer admissible as evidence for the current plan*. The record stays, and it stays readable, with the revision that invalidated it — and the slot it was invalidated *for* — named on it (§8.3 rule 1).',
    );
  });

  test('§8.2 derives execution-layer invalidation from #918 §8.2 rule 3 rather than adding a rule', () => {
    expect(doc).toContain(
      'Every runner-produced bundle bound to the previous fingerprint stops being admissible continuation evidence **by #918 §8.2 rule 3, which already says so** — evidence binds to identities, not to time.',
    );
    expect(doc).toContain(
      'This contract adds no rule here; it records that an amendment is one of the triggers',
    );
    expect(doc).toContain(
      'That is the designed behavior, not a regression: the corrected plan has not been executed yet.',
    );
  });

  test('§8.3 carries one row per operation and preserves superseded evidence', () => {
    expect(
      countMatches(rawDoc, /^\| .+ \| (?:Every manual evidence entry|Invalidates nothing)/gm),
    ).toBe(5);
    expect(doc).toContain(
      '| `restore` | Invalidates nothing and satisfies nothing. The slot returns to the gate with its bytes unchanged',
    );
    expect(doc).toContain(
      'evidence that never matched it still does not, and neither does evidence an earlier `replace` of that same slot invalidated for it (rule 3) |',
    );
    expect(doc).toContain(
      'invalidated **for S, and for S alone**, by a per-slot invalidation record naming S\'s `commandId` and marked `supersededByRevision: <revisionId>` (rule 1)',
    );
    expect(doc).toContain(
      'The entry is preserved, and it remains matchable against any *other* slot it satisfies under the shipped semantics — it was a true statement about a command that ran, and it stays one',
    );
    expect(doc).toContain(
      'a passing result for the wrong command proves nothing about the right command, so carrying it forward would launder a correction into a pass.',
    );
  });

  // The reviewed gap: a manual evidence entry can satisfy more than one slot,
  // so an entry-level mark cannot say which slot it stopped satisfying.
  test('§8.3 keys evidence invalidation on the slot, with a typed record', () => {
    expect(doc).toContain('**Invalidation is recorded per slot, never per entry.**');
    expect(doc).toContain(
      'A bare entry-level mark would therefore be unreadable: a matcher seeing it would have to exclude the entry from *every* slot, which contradicts the table\'s promise that it stays matchable elsewhere, or ignore it, which carries the superseded result into the corrected slot.',
    );
    expect(doc).toContain(
      'type EvidenceSlotInvalidation = { commandId: string; // the requirement slot the entry // stops satisfying (§5.1) supersededByRevision: string; // the §5.3 revisionId that did it };',
    );
    expect(doc).toContain(
      'each manual evidence entry carries an append-only list of them, empty for an entry nothing has superseded.',
    );
    expect(doc).toContain(
      '`commandId` is a requirement-layer identity: the execution layer invalidates by `setFingerprint` instead (§8.2) and writes no record here.',
    );
  });

  test('§8.3 gives the matcher exactly one clause and keeps the list append-only', () => {
    expect(doc).toContain('**The matcher reads it, and reads nothing else.**');
    expect(doc).toContain(
      '§6.2 rule 3\'s satisfaction test gains exactly one clause: a manual evidence entry is inadmissible for slot S when its list carries a record whose `commandId` is S\'s. For every other slot the entry matches, it is admissible unchanged.',
    );
    expect(doc).toContain(
      'No other field of the entry is consulted, and no invalidation is inferred from a revision the entry does not name.',
    );
    expect(doc).toContain('**The list is append-only and idempotent per slot.**');
    expect(doc).toContain(
      'At most one record per `commandId` per entry: an entry already invalidated for S cannot match S again, so a later `replace` of S finds nothing of that entry to supersede and rewrites nothing — the earlier record, with its earlier `revisionId`, stands.',
    );
    expect(doc).toContain(
      'a `restore` in particular reinstates a slot without clearing the records naming it, because a superseded result is superseded whatever the slot\'s state.',
    );
  });

  test('§8.4 keeps removal from ever reading as verification success', () => {
    expect(doc).toContain('### 8.4 Removal is never success');
    expect(doc).toContain(
      'A retired slot is reported `retired` — a state distinct from `passed`, `failed`, and `not_run` — everywhere a slot\'s state is reported',
    );
    expect(doc).toContain(
      'no entry to `verificationNames`/`verificationPassed`, and no satisfaction to the review gate. It is excluded, not credited.',
    );
    expect(doc).toContain(
      'Retiring the last active requirement does **not** produce "verification passed". It produces "no verification required for this task, by operator amendment `<revisionId>`"',
    );
    expect(doc).toContain(
      'An amendment never marks a review passed, never routes a task to `done`, and never closes an Issue.',
    );
    expect(doc).toContain(
      '**A restoration is reported as explicitly as a retirement.** A `restore` names the slot it reinstates in the operator output, the audit event, and the public comment (§12.2), and the reinstated slot is reported `active`.',
    );
    expect(doc).toContain(
      "Whether the reinstated slot is *already* satisfied is decided by §8.3's `restore` row and by nothing in this rule: the restoration itself satisfies nothing, and the slot's satisfaction is then whatever the shipped evidence semantics make of its unchanged bytes — preserved evidence that matched before the retirement matches again, because the retirement deleted nothing (§8.1) and invalidated nothing (§8.3).",
    );
    expect(doc).not.toContain('unsatisfied until a run satisfies it');
  });

  test('§8.5 leaves the shipped #622-P1 evidence clearing unchanged', () => {
    expect(doc).toContain(
      'That is evidence-layer bookkeeping on a different trigger; it is **unchanged** here, is not an amendment, and produces no revision.',
    );
  });
});

describe(`${DOC_PATH} — continuation (§9)`, () => {
  test('§9.1 defaults to recompute and return to review, not implementation', () => {
    expect(doc).toContain(
      'An amendment corrects **what is verified**, not the change under test.',
    );
    expect(doc).toContain(
      'So the default continuation is: **recompute the effective plan and return to review.**',
    );
  });

  test('the §9.2 table carries exactly five rows', () => {
    expect(
      countMatches(
        rawDoc,
        /^\| .+ \| (?:Re-queue `\{status: "queued"|Recorded only)/gm,
      ),
    ).toBe(5);
    expect(doc).toContain(
      '| `ready_for_human` + `review` | Re-queue `{status: "queued", phase: "review"}` |',
    );
    expect(doc).toContain(
      '| `blocked` + `review` | Re-queue `{status: "queued", phase: "review"}` |',
    );
  });

  test('§9.2 adds no phase-runner vocabulary', () => {
    expect(doc).toContain(
      '**No new vocabulary.** `{queued, review}` is the shipped edge that the implementation→review success transition already uses (#918 §12.3, R5). No `TaskStatus`, `TaskPhase`, `PhaseRunOutcome`, or `PhaseHandlerResult` member is added, and `nextPhaseAfter` and `checkReviewAdmission` are unchanged.',
    );
  });

  test('§9.2 orders recompute before routing', () => {
    expect(doc).toContain(
      '**Recompute before routing.** The re-queue happens only after the new plan and its digest are persisted, in the same transaction, so a claim can never observe a re-queued task with a stale plan.',
    );
  });

  test('§9.2 makes the override explicit, closed, and fail-closed', () => {
    expect(doc).toContain(
      '**An explicit operator override exists, is recorded, and reaches no further than the table does.**',
    );
    expect(doc).toContain(
      'The set is closed — `"review" | "implementation" | "none"` — and an unrecognized value fails closed (§11 rule 2).',
    );
  });

  // A `Recorded only` row is parked for its own surface's reasons; no
  // continuation value may re-queue it, or `--continue implementation`
  // becomes a way to unpark a human- or Tool-Request-owned task (§13.4).
  test('§9.2 bounds every non-none continuation to a re-queueable row', () => {
    expect(doc).toContain(
      '**every non-`none` continuation is available only on a table row that permits a re-queue**: an explicit `"review"` *or* an explicit `"implementation"` on a row whose default is `"none"` refuses rather than inventing a route, and the refusal names the row\'s state and phase and mutates nothing (rule 5).',
    );
    expect(doc).toContain(
      'The override is a choice of *which* lane a re-queueable task returns to, never a way to acquire a re-queue the table withholds.',
    );
    expect(doc).toContain(
      'a task parked `ready_for_human` or `blocked` outside `review` is owned by the surface that parked it, and the amendment surface must not requeue it under either route — an `--continue implementation` that did so would unpark a human-owned or Tool-Request-owned task from here, which §13.4 forbids.',
    );
  });

  test('§9.2 never skips review admission and continues nothing on refusal', () => {
    expect(doc).toContain(
      '**Continuation never skips review admission.** A re-queued review task passes #681\'s admission checks unchanged on the receiving side; this contract adds no verification evidence to admission and removes no check from it.',
    );
    expect(doc).toContain(
      '**A refused amendment continues nothing.** No revision, no re-queue, no event (§7.2 rule 2).',
    );
  });
});

describe(`${DOC_PATH} — refresh from the Issue (§10)`, () => {
  test('refresh is a source for an ordinary revision, not a second mechanism', () => {
    expect(doc).toContain(
      '`refresh-from-issue` is a **source** for an ordinary revision, not a second mechanism.',
    );
    expect(doc).toContain('It then goes through §5–§9 like any other revision.');
  });

  test('refresh updates verification requirements only', () => {
    expect(doc).toContain(
      'It never updates `context.body`, the task title, labels, priority, assignment, phase, dependencies, the Issue\'s goal, its acceptance criteria, or any implementation-scope field.',
    );
    expect(doc).toContain(
      '**The latest Issue body never becomes silently authoritative for any task field.**',
    );
    expect(doc).toContain(
      '`context.body` deliberately stays the pinned intake snapshot, and the amendment layer is what makes the corrected requirement effective (§3.2) — which is why the refresh needs no write to it.',
    );
  });

  test('refresh is operator-invoked and preview by default', () => {
    expect(doc).toContain(
      '**Operator-invoked, preview by default.** No scheduled refresh, no intake-time refresh, and no phase handler that triggers one.',
    );
  });

  test('refresh matches an active slot by its effective bytes before using identity', () => {
    // The load-bearing case: after `replace A -> B` the slot keeps A's
    // commandId while carrying B's bytes, so an Issue that now names B must
    // match that slot — matching by identity alone would add a duplicate B
    // and propose retiring the slot that already holds it.
    expect(doc).toContain(
      '**The refresh matches by effective bytes first, and never emits `replace`.**',
    );
    expect(doc).toContain(
      'The diff is taken against the **effective** requirement layer (§6.2) — the slots as the amendments left them, not as intake extracted them — and matching runs in the order below, one-to-one: each live command and each slot is consumed at most once, live commands in extraction order, slots in resolution order.',
    );
    expect(doc).toContain(
      '1. **Active slot, by command bytes.** A live command that matches an `active` slot\'s *current effective* command bytes under `matchesConfiguredVerificationCommand` (§13.2 — the same equivalence the review gate uses, so the refresh and the gate never disagree about whether the Issue\'s demand is already in the plan) matches that slot and produces **no operation**.',
    );
    expect(doc).toContain(
      'once an operator has replaced requirement A with B, the slot keeps A\'s `commandId` (§5.1) while carrying B\'s bytes, so an Issue that now names B matches that slot exactly.',
    );
    expect(doc).toContain(
      'Matching by identity alone would read B as live-only and its own slot as plan-only, and the refresh would propose an `add` of a check the plan already has plus a retirement of the slot that has it — the duplicate-and-retire failure this rule exists to prevent.',
    );
    expect(doc).toContain(
      '2. **Retired slot, by command bytes.** A still-unmatched live command that matches a `retired` slot\'s current bytes under the same equivalence produces a `restore` of that slot.',
    );
    expect(doc).toContain(
      '3. **Retired slot, by identity.** A still-unmatched live command whose `req:` identity (§5.1) equals a `retired` slot\'s `commandId` produces a `restore` of that slot',
    );
    expect(doc).toContain(
      'a restoration under this rule can reinstate bytes that differ from the live text; the refresh reports the difference and still emits no `replace` for it.',
    );
    expect(doc).toContain('4. **An unmatched live command becomes an `add`.**');
    expect(doc).toContain(
      '5. **An unmatched `active` slot becomes a *proposed* `retire`.** An unmatched `retired` slot produces nothing; it is already retired.',
    );
  });

  test('refresh never emits replace and never applies a retirement implicitly', () => {
    expect(doc).toContain(
      'A lineage-preserving correction — "command B is the fixed form of command A" — is a judgment only a human can make, so it stays an explicit operator `replace` naming the `commandId`.',
    );
    expect(doc).toContain(
      'This removes lineage guessing from the mechanism entirely rather than bounding it.',
    );
    expect(doc).toContain(
      '**A proposed `retire` is never applied implicitly.** Removals are the changes that can weaken verification, so they are included in the preview and enter the applied revision only under an explicit opt-in flag.',
    );
    expect(doc).toContain('it never silently drops them from the output.');
    expect(doc).toContain(
      '`add` and `restore` need no opt-in because neither weakens verification: one introduces a check and the other brings one back.',
    );
  });

  test('refresh fails closed on ambiguity and provider failure', () => {
    expect(doc).toContain('**Ambiguity and provider failure fail closed.**');
    expect(doc).toContain(
      'No partial revision is applied, and no `revisionOrdinal` is consumed.',
    );
  });

  test('refresh pins the read and treats a no-difference run as a no-op', () => {
    expect(doc).toContain(
      '**The read is pinned in the record.** A refresh revision records `issueBodyDigest` — SHA-256 over the raw fetched body — and `source: "issue-refresh"`.',
    );
    expect(doc).toContain(
      '**A refresh that finds no difference is a no-op, not a revision.** It exits successfully, reports "no change", consumes no ordinal, and appends no event.',
    );
  });

  test('an Issue edited between the preview and the apply is detected, not applied', () => {
    expect(doc).toContain(
      '**An Issue edited between the preview and the apply is detected, not applied.** The preview reports the `issueBodyDigest` it read, and `--expect-issue-digest <digest>` re-reads the Issue and refuses when the live body no longer hashes to that value.',
    );
    expect(doc).toContain(
      'The refusal is fail-closed and specific — it names both digests, writes nothing, and consumes no ordinal — so an operator who reviewed one diff can never apply a different one.',
    );
    // A refresh's difference is a function of two inputs, so both are guarded:
    // an amendment that moved the plan changes the diff with the Issue body
    // untouched (issue #1044 review).
    expect(doc).toContain(
      "The Issue is only half the input: a refresh diffs the live text against the task's own effective plan, so `--expect-plan-digest <digest>` guards the other half and refuses when another revision moved the plan between the preview and the apply — the same refusal, for the case where the Issue body is untouched but the difference derived from it is not.",
    );
    expect(doc).toContain(
      "A refresh's own retry is not that case: the rule 7 replay recognition is consulted first, so an apply whose response was lost is still reported as the repeat it is rather than as a conflict with the plan it produced itself.",
    );
    // The empty diff is not itself a bypass: a concurrent amendment can empty
    // it after the preview, and exiting zero there would defeat the guard
    // (issue #1044 review, P2).
    expect(doc).toContain(
      'That retry is the only bypass, and it is recognized from the chain — by the revision it already applied, whose base plan digest is the very digest it is guarding with — and never from the emptiness of the difference: a run that merely finds nothing left to do is still guarded, because a concurrent amendment can leave the live Issue and the plan agreeing after the preview was taken, and reporting "no change" there would exit successfully on a plan the operator never saw.',
    );
  });
});

describe(`${DOC_PATH} — operator surface requirements (§11)`, () => {
  test('the surface sits next to the shipped resolve command', () => {
    expect(doc).toContain(
      'It sits under the existing `review-verification` noun, next to the shipped `resolve`, because both are the operator\'s verification-correction surface for one task — `resolve` for the evidence layer, these for the requirement and execution layers.',
    );
  });

  test('pins the normative command shape', () => {
    expect(doc).toContain(
      'admin review-verification plan --session-id <id> --issue-number <n> [--json]',
    );
    expect(doc).toContain('admin review-verification amend --session-id <id> --issue-number <n>');
    expect(doc).toContain(
      '(--replace <commandId> --command <bytes> | --add-execution <name> --command <bytes> | --add-requirement --command <bytes> | --retire <commandId> | --restore <commandId> | --annotate <commandId>) [--op-reason <text>] ...',
    );
    expect(doc).toContain(
      '[--expect-plan-digest <digest>] [--request-key <token>] [--yes] [--json]',
    );
    expect(doc).toContain(
      'admin review-verification refresh --session-id <id> --issue-number <n> --reason <text> [--allow-retire] [--expect-issue-digest <digest>] [--expect-plan-digest <digest>] [--request-key <token>] [--yes] [--json]',
    );
  });

  test('maps the normative grammar onto the shipped resource-oriented commands', () => {
    expect(doc).toContain(
      "The shipped surface (issue #1042) spells this grammar as the resource it addresses — one task's verification plan — and adds one command the shape above implies but does not name:",
    );
    expect(doc).toContain('| `review-verification plan` | `admin task-verification show` |');
    expect(doc).toContain('| `review-verification amend` | `admin task-verification amend` |');
    expect(doc).toContain(
      '| `review-verification refresh` | `admin task-verification refresh-from-issue`, and the shipped `admin review-verification refresh` (issue #1041) unchanged — one implementation, two spellings |',
    );
    expect(doc).toContain('| — | `admin task-verification reset` |');
    expect(doc).toContain(
      '`reset` is neither a new mechanism nor a deletion. It derives the §5.2 operations that return the plan to its unamended baseline — `restore` for a retired slot, `replace` back to its origin bytes for a replaced one, `retire` for a slot a task-local `add` created — and applies them as one ordinary revision under every rule below, because the chain is append-only and a reversal is a revision (§5.3 rule 6).',
    );
    expect(doc).toContain(
      'Retiring a task-local addition removes a check the task currently runs, so it is withheld without the same explicit opt-in §10 rule 4 requires. Every rule below binds to all of these spellings without exception.',
    );
  });

  test('preview is the default and --yes applies', () => {
    expect(doc).toContain('**Preview by default; `--yes` applies.**');
    expect(doc).toContain(
      'change nothing without `--yes`. This is the established posture of `admin task reconcile-merged` and `admin chain sync`, reused rather than re-argued.',
    );
  });

  test('unknown and abbreviated mutation flags fail closed', () => {
    expect(doc).toContain('**Unknown and abbreviated mutation flags fail closed.**');
    expect(doc).toContain(
      'The "Unknown options are hard errors" bar of `docs/admin-cli-contract.md` applies without exception',
    );
    expect(doc).toContain(
      'There is no prefix matching and no abbreviation — `--ye`, `--allow-retir`, `--reaso`, `--op-reaso`, `--restor`, `--expect-plan-diges`, and `--request-ke` each exit non-zero and mutate nothing.',
    );
    expect(doc).toContain(
      'These commands must go through the shared `tokenizeArgs`/`parseCommonOptions` mechanism, never a hand-rolled argv scan, precisely so this guarantee is inherited rather than reimplemented.',
    );
  });

  test('a single --reason covers every operation, and --op-reason overrides one of them', () => {
    expect(doc).toContain(
      'It is the **revision-level** reason, and it is also the reason of every operation in the invocation that does not carry one of its own: a multi-operation `amend` with a single `--reason` is a complete, conforming invocation, and the surface materializes that text onto each operation it applies (§5.2 rule 1).',
    );
    expect(doc).toContain(
      '`--op-reason <text>` is the **operation-level** override and is repeatable. Each occurrence binds to the operation flag it immediately follows — the one open operation clause — and applies to that operation alone; a later `--op-reason` never retroactively changes an earlier operation, and the revision-level `--reason` never overwrites an operation that carries its own.',
    );
    expect(doc).toContain(
      'An `--op-reason` that precedes every operation flag, follows an already-reasoned operation clause, or carries empty or whitespace-only text exits non-zero and mutates nothing (rule 2\'s fail-closed bar).',
    );
  });

  test('--request-key is optional, derived when omitted, and makes an unchanged rerun a replay', () => {
    expect(doc).toContain(
      '`--request-key <token>` is optional and is the operator\'s stable handle on one invocation (§5.3 rule 2).',
    );
    expect(doc).toContain(
      'Omitting it is the normal case: the key is then derived from the invocation\'s own content — never from the plan that invocation read — so rerunning an unchanged command line after a lost or ambiguous response is recognized as a replay and reports the already-stored revision instead of appending a second one, whether or not the lost attempt had already changed the plan (§5.3 rule 3).',
    );
    expect(doc).toContain(
      'Supplying a distinct token is how an operator asks for a *deliberate* repeat of the same operations, and it is the only way to ask for one.',
    );
    expect(doc).toContain(
      'A token that is empty, whitespace-only, or outside `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/` exits non-zero and mutates nothing.',
    );
  });

  test('--reason is mandatory and there is no --force or --all', () => {
    expect(doc).toContain(
      '**`--reason` is mandatory on every applying invocation** and refuses when empty or whitespace-only (§5.2 rule 1).',
    );
    expect(doc).toContain(
      '**There is no `--force` and no `--all`.** Nothing overrides the §7.1 refusals, and no invocation addresses more than one task (§4 rule 1).',
    );
  });

  test('exit codes split refusals from previews', () => {
    expect(doc).toContain(
      '**Exit codes follow the shared contract.** Usage and validation errors, and every operational refusal (§7.1, §7.3, §10 rule 5), exit non-zero. A preview, a recognized replay (§5.3 rule 3), and a `refresh` that finds nothing to change, exit zero.',
    );
  });

  test('direct database editing is not an operator flow and is detectable', () => {
    expect(doc).toContain(
      '**Direct database editing is not an operator flow, and is detectable.**',
    );
    expect(doc).toContain(
      '**recomputes the plan digest from the recorded revision chain and refuses to run when it reconciles against neither the live inputs nor the recorded session baseline** — the refusal is fail-closed, names the mismatch, and never repairs, coerces, or overwrites the stored state.',
    );
  });

  test('the hand-edit refusal does not fire on an authorized session change', () => {
    expect(doc).toContain(
      'The baseline arm is what keeps this rule from firing on the legitimate case: a disagreement the recorded baseline explains is authorized session drift and is rebased (§6.4 rules 3 and 5), never refused, so correcting a session default does not strand every amended task in the session.',
    );
    expect(doc).toContain(
      "The digest this rule compares against is the §5.5 checkpoint's, which a rebase is allowed to move; a revision's own `planDigest` is append-only history and is never what a reconciliation reads.",
    );
  });

  test('output is redacted and sessions.json is never opened for writing', () => {
    expect(doc).toContain('**Redaction applies.**');
    expect(doc).toContain(
      '**`sessions.json` is never opened for writing** by any of them (§4 rule 3).',
    );
  });
});

describe(`${DOC_PATH} — audit and reporting (§12)`, () => {
  test('§12.1 defines one event per applied revision and adds no event vocabulary type', () => {
    expect(doc).toContain('**One task event per applied revision**: `verification.amendment.applied`');
    expect(doc).toContain(
      '`TaskEvent.type` is already a free-form string, so this introduces **no new event vocabulary type** and no schema change.',
    );
  });

  test('§12.1 keeps command bytes and output out of the event', () => {
    expect(doc).toContain(
      '**The event carries no command bytes and no output.** Names, identities, digests, and counts only — the #918 §11.3 posture.',
    );
    expect(doc).toContain(
      '**Refusals produce CLI output, not task events.** A refused amendment leaves no trace on the task',
    );
    expect(doc).toContain(
      '**A recognized replay likewise appends no event** (§5.3 rule 3): the event belongs to the revision it already produced.',
    );
  });

  test('§12.1 gives a rebase its own event and no revision', () => {
    expect(doc).toContain(
      '**One task event per rebase**: `verification.amendment.rebased` (§6.4 rule 5), carrying both `sessionBaselineDigest`s, both `planDigest`s, and the §6.4 rule 4 dispositions — the masked and orphaned slots by `commandId`, never by command bytes.',
    );
    expect(doc).toContain(
      'It records no revision, because a rebase is not one. Like the applied event it is a free-form `TaskEvent.type` and adds no schema.',
    );
    expect(doc).toContain(
      'The event is also where a rebase becomes auditable at all: the §5.5 checkpoint it rewrote is mutable and keeps no history of its own, so the event is the record of which digests were replaced by which.',
    );
  });

  test('§12.2 keys the public comment on revisionId with no run identifier', () => {
    expect(doc).toContain(
      '**idempotency-keyed on `revisionId`** so a retry never double-posts. The key excludes every run identifier, per the established rule.',
    );
  });

  test('§12.2 bounds the public comment content', () => {
    expect(doc).toContain(
      '**Never** raw verification output, artifact or worktree paths, absolute paths, a session identifier beyond what the shipped comment policy already permits, or a #917 refusal detail.',
    );
    expect(doc).toContain(
      'Command names are operator-authored and safe by construction — the #918 §11.2 argument, reused.',
    );
  });

  test('§12.2 makes every retirement visible and changes no label', () => {
    expect(doc).toContain(
      '**Every retirement is named explicitly**, together with the statement that a retired command is not a passing result (§8.4 rule 1). A removal that a reader of the Issue cannot see is exactly the failure this contract exists to prevent.',
    );
    expect(doc).toContain(
      '**No label changes.** An amendment adds, removes, and swaps no status label; label transitions stay owned by the phase runner and the shipped handoff surfaces.',
    );
    expect(doc).toContain(
      '**A refused amendment posts nothing, and neither does a replay or a rebase.** A replay\'s comment was posted by the revision it repeats (§5.3 rule 3), and a rebase changed no operator-owned requirement (§6.4 rule 5), so there is nothing for a reader of the Issue to learn from either.',
    );
  });

  // The record-only continuation is the one path that changes no status, so it
  // is the one path that can leave a live handoff describing a plan that no
  // longer exists (issue #1044 review, P1).
  test('§12.2 forbids leaving a stale merge gate standing after a record-only amendment', () => {
    expect(doc).toContain(
      '**An amendment must not leave a stale merge gate standing.** When a revision applies to a task already parked at the human merge gate and routes it nowhere (§9.2\'s `none`), the task stays actionable while the handoff summary published for it still describes the plan the revision replaced.',
    );
    expect(doc).toContain(
      'That summary is superseded in the same transaction as the revision: the reader who merges must not be shown a verification pass over a plan that no longer exists. A routing continuation supersedes nothing, because re-queuing the task retracts the handoff itself.',
    );
  });

  // Step 4 reads the session configuration and no amendment, so BOTH claims are
  // forbidden: that a retired execution entry stopped running, and that it is
  // still being run (issue #1044 review, P1).
  test('§12.2 forbids reporting an execution-layer entry as a check that ran or stopped running', () => {
    expect(doc).toContain(
      '**An execution-layer entry is reported as a recorded plan change and never as a check that ran or stopped running.**',
    );
    expect(doc).toContain(
      'a public statement may say that session execution is unchanged and may not claim that a retired entry "is still run": an entry a task-local `add` created under a name the session configuration does not hold was never run at all',
    );
  });
});

describe(`${DOC_PATH} — compatibility (§13)`, () => {
  test('§13.1 leaves review-verification resolve unchanged as the evidence surface', () => {
    expect(doc).toContain('It remains the **evidence** surface.');
    expect(doc).toContain(
      'the one-handoff-per-escalation posture (issue #622), the #622-P1 evidence clearing, and its output bounding and sanitization all stand.',
    );
  });

  test('§13.1 specifies the orphaned-command refusal as slice work, not a change made here', () => {
    expect(doc).toContain(
      'One addition is specified for the slice that implements this contract, and is not a change made here: a `resolve` naming a command that the effective plan no longer contains — because an amendment replaced or retired its slot — must refuse, naming the revision, rather than recording orphan evidence against a slot that is gone.',
    );
  });

  // "No longer contains" is the requirement gate's own question, so it is
  // answered by the gate's own rule — a rewrap or an unwrap leaves the
  // displayed bytes admissible (issue #1044 review, P2).
  test('§13.1 decides the orphan question under the §13.2 matching rule', () => {
    expect(doc).toContain(
      "Whether the plan still contains the command is decided under §13.2's matching rule, not by a byte comparison",
    );
    expect(doc).toContain(
      "an amendment that only rewraps or unwraps a slot — `bash -lc '<cmd>'` against `<cmd>` — leaves evidence for the displayed form admissible for that slot.",
    );
  });

  // Still-required bytes can sit over a slot the amendment moved, so the
  // escalation's binding is re-checked against the plan as it stands (issue
  // #1044 review, P2).
  test('§13.1 re-verifies the escalation binding against the effective plan', () => {
    expect(doc).toContain(
      'The same slice therefore verifies the recorded identity against the effective plan as it now stands, refuses when the slot moved rather than stamping the escalation\'s identity, and records the plan digest and ordinal the evidence is actually taken under.',
    );
    expect(doc).toContain(
      'The reviewed commit is not rebuilt: evidence attests a commit, and no amendment changes which.',
    );
  });

  test('§13.2 reuses the extractor and changes matching not at all', () => {
    expect(doc).toContain(
      'This contract adds a byte-preserving **identity** representation (§2) and changes **matching** not at all',
    );
    expect(doc).toContain(
      'both surfaces continue to agree about what counts as a configured verification command.',
    );
  });

  test('§13.3 adds nothing to #918 and keeps the review lane re-execution', () => {
    expect(doc).toContain(
      'No lane, classification, cycle outcome, stop rule, aggregation rule, or continuation row of #918 is added, removed, or reinterpreted.',
    );
    expect(doc).toContain(
      '#918 §12.4\'s rule that the review lane re-executes the session-configured set in its own worktree is what makes §9.1\'s return-to-review the correct default, and it is not modified.',
    );
  });

  test('§13.4 leaves Tool Request continuation and #919 untouched', () => {
    expect(doc).toContain(
      'No Tool Request action, disposition, state, or eligibility rule is added.',
    );
    expect(doc).toContain(
      'the resolution falls back to the shipped implementation continuation (§8.2). No evidence check is added to §10.3 and none is removed.',
    );
    expect(doc).toContain(
      'An amendment is not a gate decision and never resolves, parks, or unparks a Tool Request.',
    );
    expect(doc).toContain(
      '§9.2 rule 3 is what enforces this on the continuation side: a task parked outside `review` takes no route, and neither `--continue review` nor `--continue implementation` can obtain one.',
    );
  });

  test('§13.5 and §13.6 keep the session schema, transitions, and admission unchanged', () => {
    expect(doc).toContain(
      'No key, block, or flag is added to the session schema by this contract, and no session file is written by any surface it defines.',
    );
    expect(doc).toContain(
      'The §6.4 session baseline is a **task-side copy** of what was read: it is stored on the task row, it adds no session field, and recording or rebasing it never reads-modifies-writes `sessions.json` (§4 rule 3).',
    );
    expect(doc).toContain(
      '`nextPhaseAfter` is untouched; `checkReviewAdmission` (#681) keeps exactly its four checks',
    );
  });
});

describe(`${DOC_PATH} — invariants, decomposition, and test seams`, () => {
  test('§14 states twenty numbered invariants', () => {
    expect(countMatches(section('14. Invariants'), /^\d+\. /gm)).toBe(20);
  });

  test('§14 pins the checkpoint and single-identity invariants', () => {
    expect(doc).toContain(
      'Stored state separates an append-only revision chain from one mutable plan checkpoint: a rebase re-anchors the checkpoint and rewrites no revision, and every reconciliation compares against the checkpoint\'s `planDigest` and never against a revision\'s (§5.5, §6.4 rules 3 and 5, §11 rule 6).',
    );
    expect(doc).toContain(
      'One `commandId` is never two slots: a `session.verification` key that arrives on top of an existing task-local `add` is masked rather than materialized, so resolution neither duplicates the identity nor refuses over it, and the authoring-time collision check binds only the plan it was authored over (§5.1, §6.1 step 1, §6.4 rule 4).',
    );
  });

  test('§14 pins the retry-identity, drift, and refresh-matching invariants', () => {
    expect(doc).toContain(
      'Retry identity is caller-stable: the idempotency key is `requestKey`, derived from what the operator typed and never from the write-time `revisionOrdinal` or from `basePlanDigest`, and the chain is looked up on it before any plan comparison, so a repeated invocation is recognized as a replay that writes nothing, consumes no ordinal, appends no event, posts nothing, and exits zero — even when its own first attempt already changed the plan (§5.3 rules 1–3).',
    );
    expect(doc).toContain(
      'Session-default drift is attributable, not corruption: the recorded session baseline separates an authorized `session.verification` change — which rebases and proceeds on the live plan, preserving every recorded operation — from a hand-edited task row, which alone fails closed (§5.5, §6.4, §11 rule 6).',
    );
    expect(doc).toContain(
      'Drift is classified on the recorded baseline and not on the plan digest, so a session change the effective plan does not show — a key masked by a task-local `add` above all — still re-anchors the checkpoint and is still reported (§6.4 rules 3 and 5).',
    );
    expect(doc).toContain(
      'The baseline is never a source of executable bytes: a slot whose session key was removed is orphaned and its recorded operations go inert, never resurrected from the baseline (§6.1 step 2, §6.4 rule 4).',
    );
    expect(doc).toContain(
      'The refresh matches a live command against active effective command bytes before it uses identity, so a requirement the plan already carries after a `replace` is neither duplicated by an `add` nor proposed for retirement (§10 rule 3).',
    );
  });

  test('§14 pins the load-bearing invariants', () => {
    expect(doc).toContain(
      'Requirements and evidence are different things: an amendment never becomes evidence, evidence never becomes a requirement, and no amendment path writes a `passed` status (§3.2, §6.2 rule 4).',
    );
    expect(doc).toContain(
      'Agents may propose verification and may never author, amend, retire, reorder, or skip it; the actor of every revision is an operator (§3.3).',
    );
    expect(doc).toContain(
      'No amendment deletes evidence: invalidation marks inadmissibility and names its revision, and the record is preserved (§8.1, §8.3). The mark is **per slot** — it names the `commandId` it invalidates as well as the `revisionId` — so an entry that satisfied more than one requirement slot stays admissible for every slot the amendment did not touch (§8.3 rules 1–3).',
    );
    expect(doc).toContain(
      'Removing a command is never verification success: a retired slot is reported `retired`, is excluded rather than credited, and an empty requirement set after retirement never reads as a pass (§8.4).',
    );
    expect(doc).toContain(
      'The default continuation after an amendment is recompute and return to review, never implementation; the override is explicit and recorded, is bounded by the §9.2 table so no continuation re-queues a task the table keeps parked, and every route uses shipped vocabulary (§9).',
    );
    expect(doc).toContain(
      'Unknown or abbreviated mutation flags fail closed, `--reason` is mandatory, no `--force` exists, and a hand-edited chain that neither the live inputs nor the recorded session baseline explains produces a plan that resolution refuses rather than repairs (§11).',
    );
    expect(doc).toContain(
      'identity is derived once, is thereafter immutable, and is byte-preserving — no surface rewrites, collapses, or otherwise alters shell-significant command bytes, and what is stored, digested, reported, and executed is what the operator authored (§2, §5.1, §5.4).',
    );
    expect(doc).toContain(
      'idempotent over a fixed operation serialization whose identity form omits every reason; partial application and silent repeats are both impossible (§5.2, §5.3). Its operations compose sequentially against the state their predecessors in the same revision produced, so a composition every step of which is admissible applies in its recorded order — `replace` then `retire` of one slot included — and any operation that refuses refuses the whole revision (§5.3 rule 7). Every amendment is reversible: a retirement by `restore`, anything else by a further revision (§5.2 rule 4, §5.3 rule 6).',
    );
  });

  test('§14 adds no vocabulary and changes no predecessor policy', () => {
    expect(doc).toContain(
      'This contract adds no `TaskStatus`, `TaskPhase`, `PhaseRunOutcome`, `PhaseHandlerResult`, store method, table, column, session field, lock, backend, operation class, or Tool Request state, and changes no #681/#697/#915/#916/#917/#918/#919 policy (§13).',
    );
  });

  test('§15 proposes seven dependency-ordered slices', () => {
    expect(countMatches(rawDoc, /^\| A[1-7] \| /gm)).toBe(7);
    expect(doc).toContain(
      'Proposed slices for later issues; the tracker, not this document, assigns numbers.',
    );
  });

  test('§16 carries a drift row for the reconciliation cases', () => {
    expect(doc).toContain(
      '| Drift (§6.4) | a session-default edit after an amendment classifies `drifted`, resolves on the live plan, and is **not** refused;',
    );
    expect(doc).toContain(
      'a hand-edited chain that the baseline replay cannot reproduce classifies `unreconciled` and refuses;',
    );
    expect(doc).toContain(
      'a session edit that leaves the effective plan byte-identical — a key arriving under an execution-layer `add`, and a change to a session entry a `replace` masks — still classifies `drifted`, still rebases, and still reports and events its dispositions, with the two `planDigest`s equal and the two `sessionBaselineDigest`s different, and it classifies `consistent` only on the *next* resolve, after the re-anchor;',
    );
    expect(doc).toContain(
      'a removed session key orphans the slot **even when a revision `replace`d it**, and the slot is never resurrected from the recorded baseline, while an execution-layer `add` slot is unaffected; the orphaned slot\'s operations stay in the chain, go inert, and replay onto the slot — bytes and retired-or-restored state intact — when the key returns;',
    );
  });

  test('§16 carries a checkpoint row and the collision resolution case', () => {
    expect(doc).toContain(
      '| Checkpoint (§5.5) | applying a revision appends the chain entry and replaces the checkpoint in one write, with `appliedThroughOrdinal` equal to the new `revisionOrdinal` and `updatedBy: "revision"`;',
    );
    expect(doc).toContain(
      'a rebase moves `planDigest`, `sessionBaseline`, and `sessionBaselineDigest`, sets `updatedBy: "rebase"`, leaves `appliedThroughOrdinal` alone, and leaves every revision record byte-identical — in particular the newest revision\'s `planDigest` still equals the plan that revision produced, not the rebased one;',
    );
    expect(doc).toContain(
      'a chain with revisions and no checkpoint, and a checkpoint whose `appliedThroughOrdinal` differs from the chain\'s highest ordinal, each fail closed unrepaired |',
    );
    expect(doc).toContain(
      'a `session.verification` key added after a task-local `add` of the same name yields **one** `exec:<name>` slot carrying the amended bytes at its append position — never two slots, never a refusal — the session entry is reported masked, retiring the task-local slot does not unmask it, and adopting the session bytes takes a `replace`; the recorded `add` is not retroactively refused by the arriving key |',
    );
  });

  // The two rules the review asked to be pinned with a test: the composition
  // §5.3 rule 7 now calls valid, and the per-slot evidence invalidation §8.3
  // rule 1 defines.
  test('§16 gives the sequential-composition and per-slot invalidation rules cases', () => {
    expect(doc).toContain(
      'sequential composition — `replace S` then `retire S` in one revision **applies**, leaving one slot with the replaced bytes in state `retired` and a digest that carries both, while `retire S` then `replace S` refuses the whole revision, as do `retire S` twice, `restore S` twice, a second `add` of a `commandId` an earlier `add` in the same revision created, and a `replace` whose bytes equal what an earlier operation in the same revision left on the slot |',
    );
    expect(doc).toContain(
      'the mark is one `EvidenceSlotInvalidation` naming the replaced slot\'s `commandId` and the `revisionId`, so an entry that satisfied two slots stays admissible for the untouched one and is inadmissible only for the replaced one; a second `replace` of the same slot adds no second record for that entry and rewrites neither the first record nor its `revisionId`; a `restore` clears no record;',
    );
  });

  test('§16 names this file as the docs pin', () => {
    expect(doc).toContain(
      '| Docs pin | `test/docs-verification-amendment-contract.test.js` pins this document\'s status line and no-runtime-behavior claim',
    );
  });
});

describe(`${DOC_PATH} — non-goals (§17)`, () => {
  test('session-default management is an explicit non-goal with a fixed boundary', () => {
    expect(doc).toContain(
      '**Session-default management.** Editing `session.verification` through a supported operator surface',
    );
    expect(doc).toContain(
      'A session-scope mutation is unimplementable under this contract as written; it is a change to this document first.',
    );
    expect(doc).toContain(
      'The §6.4 rebase is not that surface either: it observes a session change that has already happened through whatever surface made it, and re-anchors one task\'s record to it. It can neither make a session change nor propose one.',
    );
  });

  test('bulk amendment, reordering, and pinned-entry amendment are non-goals', () => {
    expect(doc).toContain(
      '**Session-wide, chain-wide, or label-selected bulk amendment.** No invocation addresses more than one task (§11 rule 4).',
    );
    expect(doc).toContain('**Reordering the verification set.** No `reorder` operation exists');
    expect(doc).toContain(
      '**Amending a #915 plan-approval entry.** Pinned entries are approval-governed; correcting one is approval renewal (§6.1 rule 4).',
    );
  });

  test('amending anything that is not verification is out of scope', () => {
    expect(doc).toContain(
      '**Amending anything that is not verification.** The task goal, implementation scope, acceptance criteria, labels, assignment, priority, dependencies, and the Issue body are all out of scope',
    );
  });

  test('the chatops source is reserved without defining a verb', () => {
    expect(doc).toContain(
      '**A ChatOps verb.** `source: "chatops"` is reserved in the schema so a later mapping does not require a schema change, but no verb, grammar, authorization rule, or dispatch row is defined here',
    );
  });

  test('nothing in the loop amends automatically', () => {
    expect(doc).toContain(
      '**Automatic amendment.** Nothing in the loop proposes, applies, or schedules a revision: not intake, not a phase handler, not a scheduled job, not an agent. Every revision is an operator act.',
    );
  });
});

describe(`${DOC_PATH} — delivery notes in neighbouring documents`, () => {
  test('docs/environment-prepare-contract.md §3 records the amendment extension', () => {
    // #918's own delivery note stays byte-identical; #1037 adds its own marker.
    expect(envPrepare).toContain('**Extended by #918.**');
    expect(envPrepare).toContain('**Extended by #1037.**');
    expect(envPrepare).toContain(
      '[docs/verification-amendment-contract.md](verification-amendment-contract.md) (#1037)',
    );
    expect(envPrepare).toContain(
      'It adds a task-local operator overlay over `session.verification`; it never edits `sessions.json`, and it weakens no rule in §3.1–§3.3: an agent may propose verification and may still never author, amend, remove, skip, or reorder it.',
    );
  });

  test('docs/verification-execution-contract.md §16 forward-points at the delivered contract', () => {
    expect(execution).toContain(
      '**Correcting a verification requirement after intake** — the operator-owned amendment layer over §5.1\'s set resolution and over the Issue-derived review gate.',
    );
    expect(execution).toContain(
      '**Delivered (#1037)**: `docs/verification-amendment-contract.md`',
    );
    expect(execution).toContain(
      'it adds no lane, classification, cycle outcome, or continuation row here, never touches a `"verification.pinned"` entry, and changes nothing in §10\'s eligibility or E1–E7 evidence gate.',
    );
  });

  test('docs/feature-status.md carries an available row naming the shipped operator surface', () => {
    const heading = '#### Verification amendment (task-scoped, operator-owned)';
    const idx = featureStatus.indexOf(heading);
    expect(idx).toBeGreaterThan(-1);
    const nextIdx = featureStatus.indexOf('\n#### ', idx + heading.length);
    const block = featureStatus
      .slice(idx, nextIdx === -1 ? featureStatus.length : nextIdx)
      .replace(/\s+/g, ' ');
    // Issue #1044 closed the last reporting gap, so the row is no longer
    // foundation-only: the operator surface, the §12.2 comment, and the
    // human-gate line all ship together.
    expect(block).toContain('**Status:** `available`');
    expect(block).toContain('**Evidence:** `src/core/verification-amendment.ts` (issue #1038)');
    expect(block).toContain('`src/core/verification-plan.ts` (issue #1039)');
    expect(block).toContain('`src/core/verification-evidence.ts` (issue #1040)');
    expect(block).toContain('legacy unbound evidence is conservatively rejected, and stale evidence fails closed');
    expect(block).toContain('`src/core/verification-refresh.ts` and `admin review-verification refresh` (issue #1041)');
    expect(block).toContain(
      'The intake-time `context.body` is never rewritten: a refresh changes the requirement layer only, and review Step 4.5 reads the pinned body through the effective-plan resolver (issue #1043), never a live one.',
    );
    expect(block).toContain(
      'Issue #1043 wires §9 continuation and the requirement-layer gate',
    );
    expect(block).toContain(
      '`src/core/verification-amend.ts` and the `admin task-verification` commands (issue #1042) add the §11 slice A4 operator surface',
    );
    expect(block).toContain(
      'a `reset` that returns an amended plan to its baseline through `restore`/`replace`/`retire` operations rather than by deleting anything.',
    );
    expect(block).toContain(
      '`src/core/verification-amendment-publication.ts` projects one applied revision onto the §12.2 work-item comment',
    );
    expect(block).toContain('idempotency-keyed on `revisionId` and on no run identifier');
    expect(block).toContain(
      'The public comment is an Issue comment on the work item and never a PR review comment (the only PR write is the sticky human-gate summary above), and no amendment changes a label (§12.2).',
    );
    expect(block).toContain('verification-amendment-contract.md');
    expect(block).toContain('test/docs-verification-amendment-contract.test.js');
    expect(block).toContain('**Related Issues:** #1037, #1038, #1039, #1040, #1041, #1042, #1043, #1044');
  });
});
