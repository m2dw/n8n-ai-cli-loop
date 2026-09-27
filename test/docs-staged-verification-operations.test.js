/**
 * Structural pins for docs/staged-verification-operations.md (issue #1107,
 * rewritten by issue #1155): the operator guide carries configuration, generic
 * command integration, the test suite binding, the stage view's progress
 * vocabulary (kept in lockstep with the code) and recovery examples, and adds
 * no scheduler, audit engine or command family.
 *
 * #1155 removed the selection-adapter section and every retired setting from
 * the shipped examples, so the guide describes only the replacement.
 *
 * #1167 added the check that matters most to an operator copying out of this
 * file: every configuration example is loaded through the shipped session
 * validator, so an example that would refuse the session fails here instead of
 * at the operator's next session load.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { STAGED_VERIFICATION_PROGRESS_MEANING } from '../dist/core/staged-verification-status.js';
import { validateStagedVerificationConfig } from '../dist/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = readFileSync(join(ROOT, 'docs/staged-verification-operations.md'), 'utf8');
const doc = RAW.replace(/\s+/g, ' ');
const featureStatus = readFileSync(join(ROOT, 'docs/feature-status.md'), 'utf8').replace(/\s+/g, ' ');
const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8').replace(/\s+/g, ' ');

/**
 * Every fenced `json` block of a document, as written.
 *
 * A block is either a whole `sessions.json` fragment (`{ "verification": …,
 * "stagedVerification": … }`) or a bare binding entry (`"test": { … }`) shown
 * inside §3's prose. The bare form is not JSON on its own, so it is wrapped in
 * braces before parsing — that is exactly the object the operator pastes into
 * `testSuite`.
 */
function jsonBlocks(raw) {
  return [...raw.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]).map((text) => {
    try {
      return { text, value: JSON.parse(text) };
    } catch {
      return { text, value: JSON.parse(`{${text}}`) };
    }
  });
}

describe('docs/staged-verification-operations.md', () => {
  test('defers to the three contracts and adds no behavior', () => {
    expect(doc).toContain('It adds no behavior of its own.');
    for (const contract of [
      'staged-verification-contract.md',
      'changed-file-verification-contract.md',
      'verification-evidence-validity-contract.md',
    ]) {
      expect(doc).toContain(contract);
    }
  });

  test('covers configuration, generic commands, the suite binding, status and recovery', () => {
    for (const heading of [
      '## 1. Configuration',
      '## 2. Generic command integration',
      '## 3. The test suite binding',
      '## 4. Reading the status',
      '## 5. Recovery examples',
    ]) {
      expect(RAW).toContain(heading);
    }
  });

  // Issue #1155: the guide's shipped examples describe the replacement only.
  // No retired setting appears in them, and there is no selection adapter
  // section left to document — an operator copying an example out of this file
  // must get a session that loads.
  test('no retired group-selection setting survives in the guide', () => {
    for (const setting of [
      'selectable',
      'finalOnly',
      'selectionTimeoutMs',
      'selectionAdapter',
      'resultAdapters',
      'resultTimeoutMs',
    ]) {
      expect(doc).not.toContain(`"${setting}"`);
    }
    expect(RAW).not.toContain('```python');
  });

  test('states the closed field set and that a retired setting refuses the session', () => {
    expect(doc).toContain(
      'That is the whole closed field set: `enabled`, `maxStageRecoveryAttempts`, `environmentIdentity` and `testSuite`.',
    );
    expect(doc).toContain(
      'There is no migration, alias, deprecation warning or compatibility mode: a session that still carries one of those settings **does not load**, and the operator removes it.',
    );
  });

  // Issue #1167. The guide used to say a stage runs every required check, full
  // stop — which has not been true since the suite entry left both stages for
  // the changed-file ones. The rule an operator needs is that nothing can
  // *omit* a check, stated without describing a run this product no longer
  // makes.
  test('says what a stage runs today: every required non-test check, with the suite relocated', () => {
    expect(doc).toContain('**No setting can omit a required check.**');
    expect(doc).toContain(
      'Every required **non-test** check is selected into every stage, and nothing the repository contains can add or remove one.',
    );
    // Selected is not executed: a stage stops at its first failure, and the
    // final stage skips the non-test checks when the suite did not pass
    // (`first-failure-stop`, src/handlers/stage-verification.ts). The guide
    // must not promise an unconditional run of every check.
    expect(doc).toContain('Selected is not the same as executed');
    expect(doc).toContain(
      'the final stage skips the non-test checks outright when the full suite did not pass',
    );
    expect(doc).toContain('an accounted `not-run` with `first-failure-stop`, never dropped');
    expect(doc).not.toContain('Every required **non-test** check runs in every stage');
    expect(doc).toContain(
      'The one entry that ever leaves a stage is the bound test suite, which the changed-file stages run instead',
    );
    expect(doc).toContain('That is a relocation, not an omission');
    // And the unqualified claim is gone: no sentence in the guide says a stage
    // runs every required check, or that the loop stage runs the same set the
    // pre-stage cycle ran.
    expect(doc).not.toContain('**Every required check runs in every stage.**');
    expect(doc).not.toContain('the loop stage runs exactly the set that ran before it');
    // The retired policy appears only where the guide says it was retired.
    for (const sentence of doc.split('. ')) {
      if (/related[ -]test|hand-maintained|category partition/i.test(sentence)) {
        expect([sentence, /retired|no |never|removed/i.test(sentence)]).toEqual([sentence, true]);
      }
    }
  });

  // Issue #1167. The first enabled example in this file used to omit
  // `testSuite`, so an operator copying it out got a session that refused at
  // load. Every example is now loaded through the shipped validator itself —
  // the same function `JsonSessionRegistry` calls — rather than eyeballed.
  test('every configuration example loads through the shipped session validator', () => {
    const blocks = jsonBlocks(RAW);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    let enabled = 0;
    for (const { text, value } of blocks) {
      if (value.stagedVerification !== undefined) {
        // A guide example authorizes its own commands: the suite binding may
        // only name a key this same block declares.
        const commands = value.verification ?? {};
        expect([text, Object.keys(commands).length > 0]).toEqual([text, true]);
        const resolved = validateStagedVerificationConfig(
          value.stagedVerification,
          'stagedVerification',
          Object.keys(commands),
          commands,
        );
        if (resolved.enabled === true) {
          enabled += 1;
          // §6 rule 5: an enabled example without its adapter binding is the
          // exact defect this test exists for.
          expect([text, resolved.testSuite === undefined]).toEqual([text, false]);
        }
        continue;
      }
      // A bare binding entry shown in prose: validated as the `testSuite` of an
      // enabled session whose one verification key is the entry's own.
      const names = Object.keys(value);
      expect([text, names.length]).toEqual([text, 1]);
      validateStagedVerificationConfig(
        { enabled: true, testSuite: value },
        'stagedVerification',
        names,
      );
    }
    expect(enabled).toBeGreaterThanOrEqual(2);
  });

  test('names the minimum that loads and the adapter that bounds who can enable it', () => {
    expect(doc).toContain('**The minimum that loads** is the block above');
    expect(doc).toContain(
      '**The test suite is the exception, and it is what decides who can enable this today.**',
    );
    // Issue #1174 added the second member.
    expect(doc).toContain(
      'That set is closed and currently holds exactly two members, `jest` and `vitest`',
    );
    expect(doc).not.toContain('holds exactly one member');
    expect(doc).toContain('cannot set `enabled: true` at all');
  });

  // Issue #1174: the operator-authored Vitest binding and what it may not do.
  test('documents a minimal Vitest binding and its restrictions', () => {
    const vitest = jsonBlocks(RAW).filter(({ value }) =>
      Object.values(value.stagedVerification?.testSuite ?? {}).some((binding) => binding.adapter === 'vitest'));
    expect(vitest).toHaveLength(1);
    expect(vitest[0].value.verification.test).toBe('npx vitest');
    expect(RAW).toContain('### 3.1 A Vitest suite');
    expect(doc).toContain('**Supported: Vitest 3, from 3.2.**');
    expect(doc).toContain('**The suite command invokes the Vitest executable itself**');
    expect(doc).toContain('**A package script such as `npm test` or `npm run test:unit --` is refused**');
    expect(doc).toContain('An Issue that requires `npm test` is matched through `requirementCommands`, as for Jest.');
    expect(doc).toContain('**Each test file belongs to exactly one configured project.**');
    expect(doc).toContain('A similarly named file is refused rather than run, with the file named.');
    expect(doc).toContain('one more listing launch per Stage 1 run; Stage 2 passes no file and pays nothing extra');
    expect(doc).toContain('The stages, selection, retained files, D1–D6 and `requirementCommands` behave exactly as for Jest');
  });

  test('states what the binding costs per stage', () => {
    expect(doc).toContain('**What the binding costs.**');
    expect(doc).toContain(
      'Every stage pays its `setupCommand` once plus one discovery launch (`--listTests`) before a single test file runs — including a cycle whose selection turns out to be empty.',
    );
    // Discovery lists files; it does not execute them. A failing Stage 2 costs
    // one whole-suite execution, and the second one only arrives with a later
    // approval — the doc must not double-count it.
    expect(doc).toContain(
      'discovery only lists files, so a failing Stage 2 pays for one whole-suite execution, not two',
    );
    expect(doc).not.toContain('pays the whole suite twice');
  });

  // A non-test check is classified by binding, not by inspecting what it runs,
  // so an aggregate target that transitively reaches the suite reintroduces the
  // full suite before approval.
  test('warns that non-test checks and the setup command must not transitively run tests', () => {
    expect(doc).toContain(
      '**A non-test check must not run tests, including transitively — and neither must the suite\'s `setupCommand`.**',
    );
    expect(doc).toContain('`./gradlew check` depends on `test` in the standard Java plugin');
    // The example list must not offer an aggregate target as a non-test check.
    expect(doc).not.toContain('`go vet ./...`, `./gradlew check`,');
    // The setup command runs before Stage 1 discovery, so an aggregate build
    // target bound there runs the whole suite before approval just as surely
    // as a non-test check does.
    expect(doc).toContain('the `setupCommand` runs ahead of Stage 1\'s file discovery');
    expect(doc).toContain('a `setupCommand` pointed at a broad build target');
  });

  test('documents the suite binding an enabled session must declare', () => {
    expect(doc).toContain(
      '"test": { "adapter": "jest", "setupCommand": "npm run build", "argumentSeparator": "--" }',
    );
    expect(doc).toContain(
      '`testSuite` is **required** whenever `enabled` is `true`',
    );
  });

  // Issue #1166: the operator-authored reconciliation between the command an
  // Issue requires and the command the binding launches.
  test('documents the optional declared Issue-requirement commands', () => {
    expect(doc).toContain('`requirementCommands` is optional and declares which **Issue-requirement** command texts this entry discharges');
    expect(doc).toContain('"requirementCommands": ["npm test"]');
    expect(doc).toContain('is satisfied only by a complete, passing Stage 2 — it declares an identity, never evidence');
    expect(doc).toContain('no `package.json` is read and no script name resolved');
    expect(doc).toContain('A declared command another `session.verification` entry already runs refuses the session');
  });

  test('the progress table lists exactly the shipped progress states', () => {
    const rows = [...RAW.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1]);
    expect(rows.sort()).toEqual(Object.keys(STAGED_VERIFICATION_PROGRESS_MEANING).sort());
    expect(doc).toContain('**Review approval alone is never `final-passed`.**');
  });

  test('the stage view is additive and keeps the redaction posture', () => {
    expect(doc).toContain('gains one additive `stagedVerification` key; a session that has not opted in gets a byte-identical payload. No new command family exists.');
    expect(doc).toContain('No output tail, no log path, no command bytes');
  });

  // Issue #1167. The recovery section is where an operator decides whether to
  // wait or to act, so each row has to say which of the two it is — and the
  // section must not imply a repair the runner does not perform.
  test('the recovery section covers D5, D6 and an unknown termination without inventing recovery', () => {
    expect(doc).toContain(
      '**Nothing below is repaired automatically except where it says so.**',
    );
    expect(doc).toContain(
      'there is no background retry, no repair job and no self-healing of a parked Issue',
    );
    // D6, both halves, with the asymmetry stated.
    expect(doc).toContain('**A Stage 1 that executed only skipped test files** (`empty`, contract §3 R10)');
    expect(doc).toContain('a green-looking `empty` never discharges a full-suite requirement');
    expect(doc).toContain('**A Stage 2 that executed only skipped test files** (`no-evidence`)');
    expect(doc).toContain('the run is **never** repeated automatically');
    // The crash cases: confirmed-terminated retries, unconfirmed termination
    // parks identically in both stages — no automatic-final-rerun claim.
    expect(doc).toContain('**A confirmed host failure or interruption**');
    expect(doc).toContain('only that proof authorizes an automatic re-run');
    expect(doc).toContain('**A crash with no recorded result** (`termination-unknown`');
    expect(doc).toContain('This applies identically to Stage 1 and Stage 2');
    expect(doc).toContain('nothing is credited to the dead run and nothing re-runs by itself');
    // D5, including what an advance costs.
    expect(doc).toContain('**The Issue base after a predecessor update** (D5).');
    expect(doc).toContain(
      'a blocker branch that merely moved, or one that kept a stale `status:stack-ready`, never advances it',
    );
    expect(doc).toContain('every bundle this Issue recorded is dropped');
    expect(doc).toContain('Retained test files survive untouched.');
  });

  // Issue #1167. Two claims a reader must not be able to confuse: shipped code
  // is not a switched-on session, and a measurement taken once at a named head
  // is not a current benchmark.
  test('separates implemented capability from activation, and measured history from fresh evidence', () => {
    expect(doc).toContain('**Implemented is not activated.**');
    expect(doc).toContain('**no session in this repository carries that block today**');
    expect(doc).toContain(
      "this repository's own loop runs `npm test` as an ordinary verification command on every cycle",
    );
    expect(doc).toContain('**Those numbers are historical, not fresh evidence.**');
    expect(doc).toContain('a revision that predates the D5/D6 corrections');
    expect(doc).toContain('**One sample is not a performance guarantee.**');
  });

  // Issue #1167: the same three statements in the file contributors read.
  test('AGENTS.md agrees about the declaration and about nothing being switched on', () => {
    expect(agents).toContain('Staged verification does not change the `npm test` requirement.');
    expect(agents).toContain('`"requirementCommands": ["npm test"]`, issue #1166');
    expect(agents).toContain('only a complete, passing Stage 2 at the approved revision discharges it');
    expect(agents).toContain('**No session in this repository binds the suite today**');
    expect(agents).toContain(
      'every loop and final stage runs the entire required set of non-test checks',
    );
  });

  test('names the out-of-scope maintenance machinery', () => {
    expect(doc).toContain(
      'No automated test deletion or restructuring, no mutation-testing engine, no periodic audit scheduler, no cross-project concurrency scheduler, and no new admin command family.',
    );
  });

  test('docs/feature-status.md records the stage view and links the guide', () => {
    expect(featureStatus).toContain('`admin task-verification show` now carries the stage view (#1107)');
    expect(featureStatus).toContain('[staged-verification-operations.md](staged-verification-operations.md)');
    expect(featureStatus).toContain("S11's `stage release` and `stage reset-attempts` operator actions are not built");
    // Issue #1167: the row carries the correction and the two distinctions.
    expect(featureStatus).toContain('**The operator guide and the integrated regression were corrected last (#1167).**');
    expect(featureStatus).toContain('the published timings are **historical**');
    expect(featureStatus).toContain('the feature is **implemented but not activated**');
  });

  // Issue #1156: §6 is the project integration an operator actually copies. It
  // names the one project-side wiring change, the validation test, the
  // measurement script and the CI safeguard — and nothing that runs by itself.
  test('the repository section documents the project wiring and the measurement', () => {
    expect(RAW).toContain('## 6. This repository — TypeScript/Jest');
    expect(doc).toContain('"test": "npm run test:files"');
    expect(doc).toContain('`package.json` gained a `test:files` script');
    expect(doc).toContain('test/changed-file-verification-e2e.test.js');
    expect(doc).toContain('scripts/changed-file-stage-timing.mjs');
    expect(doc).toContain(
      "nothing in `npm test`, `npm run package` or CI invokes it, and it changes no commit, label, publication or configuration",
    );
    expect(doc).toContain(
      "CI's own full verification remains an independent final safeguard that nothing here narrows",
    );
    expect(doc).toContain('[changed-file-verification-validation.md](changed-file-verification-validation.md)');
  });

  // Issue #1166: this repository's own Issues require `npm test` while the
  // binding launches `npm run test:files`, so §6's copyable block must carry
  // the declaration and say why it is not optional here.
  test('the repository section declares the `npm test` requirement the binding discharges', () => {
    expect(doc).toContain('**The second piece (#1166): `"requirementCommands": ["npm test"]`.**');
    expect(doc).toContain('Ordinary Issues here require `npm test`');
    expect(doc).toContain('review blocks before Stage 2, and the whole-suite requirement can never be discharged');
    expect(doc).toContain('it grants nothing on its own');
    expect(doc).toContain('Existing tasks need no amendment');
  });
});

// ---------------------------------------------------------------------------
// Issue #1156 — the published validation report
// ---------------------------------------------------------------------------

const validationRaw = readFileSync(join(ROOT, 'docs/changed-file-verification-validation.md'), 'utf8');
const validation = validationRaw.replace(/\s+/g, ' ');

// The ceiling §5.2.1 blames, read from the source the report links to rather
// than imported: the constant is a plain literal, and loading the module that
// declares it would drag the whole grant path into a docs test.
const grantCeilingMs = Number(
  /export const GRANT_EXEC_DEFAULT_TIMEOUT_MS = ([\d_]+)/
    .exec(readFileSync(join(ROOT, 'src/core/tool-request-run.ts'), 'utf8'))?.[1]
    .replace(/_/g, ''),
);

describe('docs/changed-file-verification-validation.md', () => {
  test('defers to the contract and adds no behavior', () => {
    expect(validation).toContain('It decides nothing.');
    expect(validation).toContain('Where this report and the contract disagree, the contract wins.');
    expect(validation).toContain('changed-file-verification-contract.md');
  });

  test('reports the integration as unfinished rather than foundation-complete', () => {
    expect(validation).toContain(
      'Status: **integration unfinished — end-to-end behavior validated, '
        + 'repository-scale timings measured, no session bound**',
    );
    expect(validation).toContain('unfinished, not foundation-complete');
    // The one step left is operator-owned and it is the binding, not a
    // measurement: the timings below do not mean the stages are switched on
    // here, and no repository change can switch them on.
    expect(validation).toContain('### 5.3 What is still missing — the session binding');
    expect(validation).toContain('no session in this repository binds the suite');
    expect(validation).toContain('the runner never edits a live session');
    // Issue #1166: the binding that step adds is not the #1154 one — here it
    // must also declare the `npm test` its Issues require, or every Issue
    // blocks before Stage 2 on a command no configured check runs.
    expect(validation).toContain('it is not optional here');
    expect(validation).toContain('"requirementCommands": ["npm test"]');
    expect(validation).toContain('The declaration changes no command and grants nothing');
  });

  test('publishes the measured timings with the conditions, files and commands behind them', () => {
    expect(validation).toContain('### 5.2 Repository-scale timings — measured');
    expect(validation).toContain('**The repository-scale numbers below were measured, not modelled.**');
    // Each row carries its raw millisecond value and its file count, so a
    // rounded second in prose can always be traced to the machine report.
    for (const row of [
      '| Stage 1 duration (selected files) | **28.4 s** — 28449 ms for 3 files |',
      '| Stage 2 duration (full suite) | **779.0 s** — 778957 ms for 315 files,'
        + ' its own build and discovery included |',
      '| Build (setup) cost per stage | **7.2 s** — 7245 ms in Stage 1, 6899 ms in Stage 2 |',
      '| Discovery cost per stage | **1.1 s** — 1128 ms in Stage 1, 1018 ms in Stage 2 |',
      '| Saving per pre-approval cycle | **742.1 s** — a 36822 ms cycle against 778957 ms,'
        + ' a ratio of **4.7 %** |',
    ]) {
      expect(validationRaw).toContain(row);
    }
    // A duration is never published without the host it was taken on, the
    // files it selected or the argv it launched.
    expect(validation).toContain('| Taken at | `2026-09-18T05:41:30.283Z` |');
    expect(validation).toContain('| Host | `darwin-arm64`, Apple M2, 8 CPUs, 24 GiB, node `v22.6.0` |');
    expect(validation).toContain('| Load average | 2.74 / 3.46 / 4.23 before, 6.58 / 5.64 / 5.32 after |');
    for (const file of [
      'test/changed-file-verification-e2e.test.js',
      'test/docs-staged-verification-operations.test.js',
      'test/staged-verification-e2e.test.js',
    ]) {
      expect(validation).toContain(`\`${file}\` — \`changed\``);
    }
    expect(validation).toContain('npm run test:files -- --listTests --json');
    expect(validation).toContain('--runTestsByPath');
  });

  test('reports the saving, the build cost, the full-stage cost and the measurement limits', () => {
    expect(validation).toContain('#### 5.2.1 What the numbers say about an ordinary localized change');
    expect(validation).toContain('executed 3 of 315 runnable files — 0.95 % of the inventory');
    expect(validation).toContain('**Actual saving: 742.1 s per pre-approval cycle**');
    expect(validation).toContain('**Build cost: 8.4 s of that 36.8 s**');
    expect(validation).toContain('**Full-stage cost is unchanged: 779.0 s**');
    // Bounded evidence, and it says so: one pass, one shared host, one head,
    // and three unusually slow files.
    expect(validation).toContain('**This is not a best case.**');
    expect(validation).toContain('**The head measured is not necessarily the head you are reading.**');
    expect(validation).toContain('**A load average is not an isolated host.**');
  });

  test('separates the workflow-run full verification from the full run the measurement took', () => {
    // The gate is not this report: the Issue workflow runs the configured
    // verification commands at the branch head, and this report neither
    // performs nor certifies them.
    expect(validation).toContain('### 5.1 Full project verification of this branch');
    expect(validation).toContain(
      'Full project verification of this branch is **not** what is missing, '
        + 'and this report neither performs it nor stands in for it.',
    );
    expect(validation).toContain(
      'runs `npm test`, `npm run typecheck` and `npm run package` itself, at the head produced by each turn',
    );
    expect(validation).toContain('That blocks exactly one thing — the stopwatch in §5.2.');
    // What it does record is the full suite its own Stage 2 ran: the same Jest
    // command `npm test` runs, after the same build `pretest` runs.
    expect(validation).toContain('| Files reported | 315 of the 315 runnable test files |');
    expect(validation).toContain('| Failing files | **0** |');
    expect(validation).toContain('defines `test` and `test:files` as the same command');
    expect(validation).toContain('Two runs still decide completion, and neither of them is this table');
  });

  test('diagnoses why a granted command could not take the measurement in its own process', () => {
    // The blocker is a product constant, not an operator oversight: a granted
    // command runs under a fixed wall clock and a build plus a whole suite does
    // not fit inside it. Pin the report's number to the shipped one, so raising
    // the ceiling — or the report drifting from it — fails here instead of
    // sending the next operator to repeat a grant that cannot succeed.
    expect(Number.isFinite(grantCeilingMs) && grantCeilingMs > 0).toBe(true);
    const ceilingSeconds = grantCeilingMs / 1000;
    expect(validation).toContain('#### 5.2.2 Why a granted command could not take it in its own process');
    expect(validation).toContain(`a fixed \`GRANT_EXEC_DEFAULT_TIMEOUT_MS\` of ${ceilingSeconds} seconds`);
    // The recorded attempt, so the failure is evidence rather than a claim.
    expect(validation).toContain('Error: spawnSync /bin/sh ETIMEDOUT');
    expect(validation).toContain('**No granted command can take this measurement in its own process**');
    // ... and the answer is a detached launch, never a wider deadline on the
    // path every other approved command shares.
    expect(validation).toContain('This report does not ask for the ceiling to be raised.');
    expect(validation).toContain('in a terminal** — not as a granted command');
    expect(validation).toContain("**This is how §5.2's numbers were taken**");
  });

  // Issue #1167: the report names the integrated cases the operator guide's
  // configuration section depends on, and says why they are repeated against a
  // real Jest rather than left to the scripted-runner tests.
  test('records the integrated D5, D6 and declared-requirement cases', () => {
    expect(validation).toContain('Issue #1167 extended the same file');
    expect(validation).toContain('| The ordinary `npm test` requirement, undeclared |');
    expect(validation).toContain('| The ordinary `npm test` requirement, declared (§6\'s binding) |');
    expect(validation).toContain('| D5, an accepted predecessor update |');
    expect(validation).toContain('| D6, an all-skipped Stage 1 |');
    expect(validation).toContain('| D6, an all-skipped Stage 2 |');
    expect(validation).toContain(
      'a skip, a machine result and a discovery are exactly the places a fake runner can agree with the adapter and a real one disagree',
    );
  });

  // Issue #1167: a measurement taken once, at a head the branch has since left,
  // is reported as history — never as a benchmark or a guarantee.
  test('reports the timings as historical rather than current', () => {
    expect(validation).toContain('**They are historical measurements, and this Issue did not re-take them.**');
    expect(validation).toContain('`60cb22dc` is no longer the head anyone reads');
    expect(validation).toContain(
      'not a current benchmark and not a performance guarantee',
    );
    expect(validation).toContain('the durations above describe `60cb22dc` and no head after it');
    expect(validation).toContain('Historical: taken once at that head and not re-taken since');
  });

  test('names the end-to-end evidence and the six §7 steps', () => {
    expect(validation).toContain('test/changed-file-verification-e2e.test.js');
    for (const claim of [
      'No full run precedes the reviewer.',
      'A rejected review never runs the suite and never grants',
      'The obligation is durable.',
      'A retained file stays retained after it passes',
      'Absence is never success',
    ]) {
      expect(validation).toContain(claim);
    }
  });

  test('records the reproduction, the limitations and the operator steps that close it', () => {
    expect(validation).toContain('node scripts/changed-file-stage-timing.mjs --base-branch main');
    // A stacked branch's merge base with `main` is the root of the whole stack,
    // so the representative run names the predecessor revision instead.
    expect(validation).toContain('**Name the base explicitly on a stacked branch.**');
    expect(validation).toContain('node scripts/changed-file-stage-timing.mjs --base 30430073');
    expect(validation).toContain('### Measurement limitations');
    // A run that never executed a test file is never reported as a completed
    // measurement, whichever stage it stopped in.
    expect(validation).toContain('A stage that never tested for any other reason is incomplete.');
    expect(validation).toContain('the exit status is nonzero');
    expect(validation).toContain('One pass, one host.');
    expect(validation).toContain('the runner never edits a live session');
  });

  test('keeps CI as an independent safeguard and the pilot separate', () => {
    expect(validation).toContain(
      'CI and any full project verification an operator runs outside the loop remain an independent final safeguard.',
    );
    expect(validation).toContain(
      'No automatic publication, merge, periodic audit or test-maintenance expansion.',
    );
    expect(validation).toContain('No test removal, assertion weakening or hand-crafted category partition');
  });

  test('records that the obsolete-selector removal checks hold', () => {
    expect(validation).toContain('test/staged-verification-config.test.js');
    for (const setting of [
      'selectable',
      'finalOnly',
      'selectionTimeoutMs',
      'selectionAdapter',
      'resultAdapters',
      'resultTimeoutMs',
    ]) {
      expect(validation).toContain(setting);
    }
    expect(validation).toContain('nothing in this Issue reintroduces a selection port');
  });

  test('docs/feature-status.md links the report', () => {
    expect(featureStatus).toContain(
      '[changed-file-verification-validation.md](changed-file-verification-validation.md)',
    );
  });
});
