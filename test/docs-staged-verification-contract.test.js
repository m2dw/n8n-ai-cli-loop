/**
 * Structural tests for docs/staged-verification-contract.md (issue #1094).
 *
 * The document is the authoritative contract for the staged shape of
 * runner-owned verification: a lightweight `loop` stage on every normal
 * cycle and a `final` stage that runs the whole required set per Issue
 * before the stack-ready grant. Issue #1094 is a pure specification —
 * no production code changes with it — so these tests pin the
 * document's own claims: the closed stage and stage-outcome sets, the
 * three-owner split with the list of things core may never know, the
 * per-Issue final stage and its approval-before-final ordering, the
 * five-set loop-selection union with its unknown-impact-runs-full
 * fallback, its pinned-unproven-checks floor and its requirement
 * closure, the evidence-bound requirement satisfaction that keeps a
 * retained mandatory slot from reading passed without a run, the
 * accounted-absence
 * mapping that keeps a fail-fast skip — and a requirement left unproven
 * by a failing or expired satisfying check — out of the interruption and
 * `unknown` rows, the
 * selection port's narrowing-only / never-authorization / never-final
 * rules, the additive default-off session block, bundle completeness
 * and the permanent inadmissibility of partial evidence, the
 * runner-owned mandatory retention, the 13-row transition table whose
 * single granting cell requires complete head-bound evidence, the
 * publication ordering, the modules-to-extend table, the maintenance
 * exclusions, the invariants, the 12-slice decomposition, and the
 * reconciliation notes in docs/verification-execution-contract.md §16,
 * docs/verification-amendment-contract.md §17, docs/phase-contracts.md
 * (Gate 2), docs/feature-status.md, and docs/DOMAIN.md §5 that land
 * alongside it — against drift. They are structural only, mirroring the
 * doc-only pin pattern used for
 * docs/verification-execution-contract.md (#918).
 */
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readRaw(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

// Assertions run against a whitespace-normalized copy: the document is
// hard-wrapped prose, so a claim can straddle a line break today and be
// reflowed tomorrow. Normalizing means these tests pin what the document
// says, not how it happens to be wrapped. Table-shape assertions use the
// RAW text, where a row is still a line.
function read(rel) {
  return readRaw(rel).replace(/\s+/g, ' ');
}

const DOC_PATH = 'docs/staged-verification-contract.md';
const RAW = readRaw(DOC_PATH);
const doc = read(DOC_PATH);
const execution = read('docs/verification-execution-contract.md');
const amendment = read('docs/verification-amendment-contract.md');
const phases = read('docs/phase-contracts.md');
const featureStatus = readRaw('docs/feature-status.md');

// docs/DOMAIN.md is a PRIVATE_ONLY_PATH (copybara/copy.bara.sky): the public
// mirror never receives it, and a test that unconditionally loads it couples
// this file to material the exported tree lacks. The DOMAIN.md pins below
// therefore run only where the document exists and skip cleanly elsewhere.
const domain = existsSync(resolve(ROOT, 'docs/DOMAIN.md')) ? read('docs/DOMAIN.md') : null;
const domainTest = domain === null ? test.skip : test;

describe(`${DOC_PATH} — status, chain position, and deferrals`, () => {
  test('declares an approved design whose implemented part grants nothing', () => {
    // #1098 landed S1's result half — the per-check record and the structured
    // result envelope — beside #1097's configuration slice, #1099 landed S4's
    // persistence half so a stage run has somewhere durable to go, #1100
    // landed the law that decides whether such a bundle may be used, #1101
    // landed S6's selection port with the §4.2 union it feeds, and #1102 ran
    // the first stage: S1's outcome precedence, S4's requirement projection,
    // and S3/S7's loop stage in the implementation lane. #1103 then landed S9
    // and S10: the per-Issue final stage after review approval and the row-7
    // precondition on the stack-ready grant.
    expect(doc.replace(/\s+/g, ' ')).toContain(
      "Status: **approved design; §13's S2 session configuration, S1's "
        + 'common command-result vocabulary, evidence matching law, selection '
        + "algorithm and stage-outcome precedence, S4's stage evidence persistence "
        + "and requirement projection, S6's selection port, S3 with S7's "
        + 'implementation-lane loop stage, and S9 with S10\'s per-Issue final '
        + 'stage and stack-ready publication gate implemented** (issues #1094, '
        + '#1097, #1098, #1099, #1100, #1101, #1102, #1103).',
    );
  });

  test('states the chain position as slice 1/15 with 3 design Issues', () => {
    expect(doc).toContain(
      'This is slice 1/15 of the independent **Staged Verification** chain: 3 design Issues followed by 12 implementation/validation Issues.',
    );
    expect(doc).toContain('The chain has no dependency on another active chain.');
  });

  test('ships no runtime behavior', () => {
    expect(doc).toContain('**no runtime behavior ships with it.**');
  });

  test('defers the plan model to the shipped amendment contract', () => {
    expect(doc).toContain('fixed by `docs/verification-amendment-contract.md` (#1037) and **shipped** in');
    expect(doc).toContain('it introduces no plan layer, no slot origin, and no revision operation.');
  });

  test('records that the #918 execution contract is design-only today', () => {
    expect(doc).toContain('fixed by `docs/verification-execution-contract.md` (#918), which is **design-only** today');
  });

  test('leaves the dependency gates and their resolver alone', () => {
    expect(doc).toContain(
      'This contract changes only *what it takes to earn* the stack-ready marker, never how a dependent consumes it.',
    );
  });
});

describe(`${DOC_PATH} — closed vocabularies`, () => {
  test('the stage set is closed at loop and final', () => {
    expect(doc).toContain('The stage set is **closed**: `"loop"` | `"final"` (§4).');
    expect(doc).toContain('Adding a stage is a change to this document first.');
  });

  test('the stage-outcome set is closed and covers all six outcomes', () => {
    expect(doc).toContain(
      'The set is **closed**: `"passed"` | `"code-failed"` | `"timed-out"` | `"interrupted"` | `"unknown"` | `"infrastructure"`.',
    );
  });

  test('the outcome precedence is stated', () => {
    expect(doc).toContain(
      '`interrupted` > `unknown` > `infrastructure` > `code-failed` > `timed-out` > `passed`.',
    );
  });

  test('a check is a plan identity, never a command string', () => {
    expect(doc).toContain('`exec:<name>` for an execution-layer slot, `req:<hex>` for an Issue-required slot');
  });
});

describe(`${DOC_PATH} — ownership and language neutrality`, () => {
  test('the runner owns the lifecycle including retention and publication', () => {
    expect(doc).toContain('Retention is never configurable by the project or by an adapter.');
    expect(doc).toContain('**Transitions and publication**: the §7 table and the §8 ordering,');
  });

  test('core carries no language, framework, filename, or layout knowledge', () => {
    expect(doc).toContain(
      'Core contains **no** TypeScript, npm, Jest, filename, extension, directory, build-graph, package-manager, or repository-layout knowledge.',
    );
    expect(doc).toContain('map a source file to a test file by any naming convention;');
    expect(doc).toContain("parse a test runner's output, a coverage report, or a build manifest;");
    expect(doc).toContain('ship a default adapter, a language detector, or a built-in impact heuristic.');
  });

  test('paths reaching core are opaque strings', () => {
    expect(doc).toContain('Paths that reach core are **opaque strings**');
  });

  test('TypeScript/Jest is the first project integration, not a core feature', () => {
    expect(doc).toContain('TypeScript/Jest is the **first project integration**, delivered as an adapter');
    expect(doc).toContain('It is not a core feature and it is not a reference implementation core depends on.');
  });

  test('the precedence order is operator plan, runner lifecycle, project selection', () => {
    expect(doc).toContain('**operator plan > runner lifecycle > project selection**');
  });
});

describe(`${DOC_PATH} — the two stages and their selection`, () => {
  test('the final stage is per Issue, not deferred to chain merge', () => {
    expect(doc).toContain('**The final stage is per Issue, not per chain.**');
    expect(doc).toContain(
      'Deferring full validation to chain merge is exactly the failure this contract exists to prevent',
    );
  });

  test('the final stage runs after approval', () => {
    expect(doc).toContain('**The final stage never runs before approval.**');
  });

  test('the loop stage can never grant', () => {
    expect(doc).toContain('**The loop stage never grants anything.**');
    expect(doc).toContain(
      'it can never satisfy a final stage and can never produce a stack-ready grant',
    );
  });

  test('loop selection is the union of impact, always-required, regression, pinned, and requirement-satisfying checks', () => {
    expect(doc).toContain('as the ordered union of five sets, in required-set order');
    expect(doc).toContain('**Impact-related checks**');
    expect(doc).toContain('**Always-required checks**');
    expect(doc).toContain('**Regression checks**');
    expect(doc).toContain('**Pinned unproven checks**');
    expect(doc).toContain('**Requirement-satisfying execution checks**');
    expect(doc).toContain(
      "A check that failed the Issue's last full validation stays in the loop until a final stage clears it.",
    );
  });

  // The gap this closes: a requirement slot is never selectable, but
  // non-selectability retains the SLOT, not the work. With
  // `session.verification.test` = `npm test`, `test` listed as selectable
  // and the Issue requiring `npm test`, a selection could keep `req:<hex>`
  // and drop `exec:test`; §4.3's satisfaction test, which matches a
  // requirement against active execution slots, would then read the
  // mandatory requirement as passed on a check that never ran.
  test('selection retains the execution checks that discharge every mandatory requirement slot', () => {
    expect(doc).toContain('**Retaining a mandatory slot is not the same as running it.**');
    expect(doc).toContain(
      'a slot is an obligation, not a process, and it is discharged only by the execution check that actually runs the command',
    );
    expect(doc).toContain(
      'without this step a selection could drop `exec:test` while keeping `req:<hex>`, and §4.3\'s satisfaction test would read the requirement as passed on work this stage run never performed',
    );
    expect(doc).toContain(
      'the check that discharges a mandatory requirement is selected whenever the requirement is',
    );
  });

  // `selectable` is an operator statement and so is the Issue-required
  // layer; the closure is only safe if the document says which one wins.
  test('a selectable execution check is selected anyway when a requirement needs it', () => {
    expect(doc).toContain(
      '`selectable` says which checks may be skipped as *unrelated* to a change; it is never a licence to report an Issue-mandated requirement as satisfied by a check that did not run, so where the two collide the requirement wins',
    );
    expect(doc).toContain(
      'so an `exec:<name>` the operator did list here is selected anyway whenever a requirement slot needs it to pass',
    );
  });

  // Closing the selection gap is necessary but not sufficient: the
  // shipped buildEffectiveRequirementStatus marks a requirement passed
  // from a MATCHING ACTIVE execution slot, which is a fact about the plan
  // and not about the run. A selected-but-failed check would otherwise
  // still satisfy the requirement it discharges.
  test('stage requirement satisfaction is judged over proven evidence, not the configured plan', () => {
    expect(doc).toContain(
      "**Requirement satisfaction is bound to the run's evidence, not to the plan's shape.**",
    );
    expect(doc).toContain(
      'Consuming it unchanged over the resolved plan would let a mandatory requirement read `passed` on a check that produced no passing verdict.',
    );
    expect(doc).toContain(
      'the resolved plan with its execution layer narrowed to exactly the execution slots *this stage run recorded a `passed` verdict for*',
    );
    expect(doc).toContain(
      'A requirement whose satisfying execution check failed, timed out, was skipped by a fail-fast stop, or lost its verdict is `not_run` for that stage — never `passed`.',
    );
  });

  // The projection must not be a fork: the matching rule and the shipped
  // plan-level consumers keep their shipped behavior.
  test('the proven projection reuses the shipped call and leaves plan-level consumers alone', () => {
    expect(doc).toContain('consumed verbatim, never forked, never reimplemented');
    expect(doc).toContain("What a stage changes is that call's **input**, not the call");
    expect(doc).toContain(
      'every other shipped consumer keep calling `buildEffectiveRequirementStatus` over the resolved plan and keep reporting "this requirement is covered by the configured plan"',
    );
    expect(doc).toContain('reported side by side, never merged');
  });

  // A selectable check that timed out during a loop is neither
  // impact-related on the next cycle nor in the regression set, which only
  // a final stage writes. Without a retained pin set in the selection
  // union, the §7 row-3 timeout pin would be unenforceable by the
  // algorithm — so the union, the lifetime, and the port's inability to
  // reach it are all pinned here.
  test('the pinned set carries a loop-stage non-green check into later selections', () => {
    expect(doc).toContain(
      'A check a loop run selected and did not prove green — because it failed, because it timed out, because a fail-fast stop meant it never ran, or because its verdict was lost — stays selected until some stage run records a `passed` verdict for it.',
    );
    expect(doc).toContain(
      "This step is what makes §7 row 3's timeout pin and row 2's failing set *enforceable by the selection algorithm* instead of by a prose promise",
    );
    expect(doc).toContain(
      'so without this step it could be selected away on the very next loop.',
    );
  });

  test('the regression, pinned, and requirement-closure sets are floors the selection port cannot reach', () => {
    expect(doc).toContain('Steps 3, 4 and 5 are **floors the port cannot reach.**');
    expect(doc).toContain(
      'no adapter answer, and no `selectable` list, removes a regression id, a pinned id, or an execution id that step 5 pulled in',
    );
    expect(doc).toContain(
      'None of the three can push the selection past a full required run',
    );
  });

  // Every floor is intersected with the CURRENT required set, so a plan
  // revision releases it rather than leaving a check pinned forever.
  test('the requirement closure retires with the requirement slot that created it', () => {
    expect(doc).toContain(
      'step 5 is computed over the required set itself and retires with it on the same revision',
    );
  });

  test('unknown impact falls back to the full required set, never to less', () => {
    expect(doc).toContain('**Unknown impact falls back to full required validation.**');
    expect(doc).toContain(
      'There is no partial fallback and no "best effort" subset: unknown impact is never a reason to run less.',
    );
  });

  test('final selection is total and never consults the port', () => {
    expect(doc).toContain("The final stage's selection is **the entire required set**, always.");
    expect(doc).toContain('the port is not invoked in the final stage at all');
  });

  test('final-stage satisfaction without re-execution is same-lane only', () => {
    expect(doc).toContain('This is same-lane, same-head, same-plan reuse only.');
    expect(doc).toContain(
      'an implementation-lane bundle never satisfies a review-lane final stage, however its digests compare.',
    );
  });

  test('only a post-approval final-stage bundle can satisfy a final stage', () => {
    expect(doc).toContain('a bundle whose `stageRunId.stage` is **`final`**');
    expect(doc).toContain('**A `loop` bundle never satisfies a final stage**');
    expect(doc).toContain(
      'a full loop selection does not become final evidence by being full',
    );
    expect(doc).toContain(
      '**produced after the review approval this publication rests on**',
    );
    expect(doc).toContain(
      "the reused bundle must itself be a final stage's own bundle",
    );
  });
});

describe(`${DOC_PATH} — the selection port`, () => {
  test('an out-of-request id makes the whole response unknown', () => {
    expect(doc).toContain('**Subset or nothing.**');
    expect(doc).toContain('makes the **whole response** `"unknown"`');
    expect(doc).toContain('never accepts a partially valid answer');
  });

  test('the port narrows and never widens', () => {
    expect(doc).toContain('**Narrowing only.**');
    expect(doc).toContain(
      "An adapter cannot shrink the loop below what the operator and the Issue's own history demand.",
    );
  });

  test('the port is never authorization and never evidence', () => {
    expect(doc).toContain('**Never authorization.**');
    expect(doc).toContain('Selection is scope; authorization is upstream and untouched.');
    expect(doc).toContain('**Never evidence.**');
  });

  test('the port is never consulted in the final stage and never ships in core', () => {
    expect(doc).toContain('**Never consulted in the final stage.**');
    expect(doc).toContain('**Out of core.** Core ships no adapter.');
  });

  test('the session block is additive, default off, and fail-closed', () => {
    expect(doc).toContain('`enabled` — default `false`.');
    expect(doc).toContain('"stagedVerification"');
    expect(doc).toContain('Default `[]`');
    expect(doc).toContain('Validation is fail-closed at session load');
  });

  test('requirement-layer and amendment-added slots are never selectable', () => {
    expect(doc).toContain('is never selectable. The Issue asked for it');
    expect(doc).toContain('A **task-amendment-added** slot is never selectable.');
  });

  test('routine per-Issue operation needs no sessions.json edit', () => {
    expect(doc).toContain('Routine per-Issue operation touches the session file **never**.');
    expect(doc).toContain('a one-time configuration act');
    expect(doc).toContain('go through the shipped task-scoped amendment surface (`admin task-verification`, #1042)');
  });
});

describe(`${DOC_PATH} — outcomes, evidence, and retention`, () => {
  test('timeout is a verdict about a check, interruption the absence of one', () => {
    expect(doc).toContain(
      '**`timed-out` is a verdict about a check; `interrupted` is the absence of a verdict about the stage.**',
    );
  });

  test('unknown is never passed', () => {
    expect(doc).toContain('**`unknown` is never `passed`.**');
  });

  test('infrastructure never masquerades as code and reuses the shipped split', () => {
    expect(doc).toContain('**Infrastructure never masquerades as code.**');
    expect(doc).toContain('the shipped #934 split, restated, not redefined');
  });

  test('a bundle records its own scope', () => {
    expect(doc).toContain('**A bundle records its own scope.**');
    expect(doc).toContain('No consumer may infer completeness from an outcome alone.');
    expect(doc).toContain('selectionDigest');
  });

  test('partial evidence is permanently inadmissible and never resumed', () => {
    expect(doc).toContain('**A partial bundle is permanently inadmissible.**');
    expect(doc).toContain('the next final stage starts from the beginning');
  });

  test('retention is runner-owned and mandatory', () => {
    expect(doc).toContain('**R1 — the granting bundle.**');
    expect(doc).toContain('**R2 — the regression set.**');
    expect(doc).toContain('**R5 — retention is a floor.**');
    expect(doc).toContain('**R6 — the loop pin set.**');
    expect(doc).toContain(
      'Nothing an adapter returns, and nothing a project configures, can shorten R1, R2 or R6.',
    );
  });

  test('the loop pin set has an Issue-scoped lifetime with one exit', () => {
    expect(doc).toContain(
      '**Scope: the Issue, not the lane and not the stage run.**',
    );
    expect(doc).toContain(
      'A pin survives a requeue, a repair cycle, a lane change, a fresh task attempt, an interruption, and any number of intervening loop runs.',
    );
    expect(doc).toContain('**An id leaves the set only by being proven green:**');
    expect(doc).toContain(
      'no timer, no cycle count, no operator value, no adapter answer',
    );
    expect(doc).toContain('**The whole set clears with R2:**');
  });

  // A failing suite today stops `runVerification` at the first nonzero
  // exit, so most real bundles carry `not-run` entries. The §6.1 mapping
  // keeps those accounted absences out of the `interrupted` / `unknown`
  // rows, which is what lets an ordinary red build reach the repair path.
  test('a missing verdict enters the precedence through its recorded cause', () => {
    expect(doc).toContain(
      'A selected check with no verdict enters that precedence **through its recorded cause, not through its bare absence.**',
    );
    expect(doc).toContain(
      'The `notRunKind` set is closed (§6.2) and each member maps to exactly one contribution',
    );
    for (const kind of [
      'first-failure-stop',
      'requirement-unproven',
      'set-budget-exhausted',
      'infrastructure-stop',
      'sandbox-policy-stop',
      'cancellation-stop',
      'evidence-lost',
    ]) {
      expect(RAW).toMatch(new RegExp(`^\\| \`${kind}\` \\|`, 'm'));
    }
    expect(RAW).toContain(
      '| `notRunKind` | When the runner records it | What the absence contributes |',
    );
    // The mapping is a function: each kind names exactly one contribution.
    expect(RAW).toMatch(
      /^\| `first-failure-stop` \|.*\| \*\*Nothing\.\*\* The `failed` or `timed-out` verdict that caused the stop is what decides the row \|$/m,
    );
    expect(RAW).toMatch(
      /^\| `requirement-unproven` \|.*\| \*\*Nothing\.\*\* The satisfying execution check's own `failed` or `timed-out` verdict decides the row \|$/m,
    );
    expect(RAW).toMatch(/^\| `cancellation-stop` \|.*\| `interrupted` \|$/m);
    expect(RAW).toMatch(
      /^\| `evidence-lost` \|.*\| `interrupted` if the stage run did not complete, otherwise `unknown` \|$/m,
    );
  });

  // The bundle is where a requirement's verdict becomes durable, so the
  // evidence binding has to be stated there too and not only in §4.3.
  test('a requirement check in the bundle is passed only on a verdict the run recorded', () => {
    expect(doc).toContain(
      "**A requirement check's verdict comes from evidence, not from the plan.**",
    );
    expect(doc).toContain(
      'an execution check *this run* recorded `passed` for satisfies it, or admissible manual evidence does',
    );
    expect(doc).toContain(
      'its `notRunKind` states what this same bundle already says about the execution check that would have satisfied it',
    );
    expect(doc).toContain(
      'a mandatory requirement can never be the one check in a `passed` bundle that nothing ran',
    );
  });

  // The failure this pins: an Issue that requires `npm test` whose
  // matching execution check FAILED has no `notRunKind` to inherit — the
  // check ran. Deriving `evidence-lost` there would make the whole stage
  // `unknown` under §6.1's precedence and send an ordinary red build to
  // the operator handoff instead of the repair route.
  test('a requirement unproven by a known failure is an accounted absence, not evidence loss', () => {
    // The three ordered derivation cases, each naming one cause.
    expect(doc).toContain(
      '**`requirement-unproven` when that check ran and recorded a known non-passing verdict** (`failed` or `timed-out`)',
    );
    expect(doc).toContain(
      "**that check's own `notRunKind` when it too is `not-run`**",
    );
    expect(doc).toContain(
      '**`evidence-lost` when no such cause was recorded.**',
    );
    // And the consequence the derivation exists for.
    expect(doc).toContain(
      "the requirement's absence adds nothing to the §6.1 precedence and the stage stays `code-failed` or `timed-out` instead of becoming `unknown` and parking for an operator",
    );
    // Fail-closed: the new kind is not a general-purpose excuse.
    expect(doc).toContain(
      '`requirement-unproven` is admissible only on a `req:<hex>` check, and only when the execution check that would satisfy it carries a `failed` or `timed-out` verdict **in this same bundle**',
    );
    expect(doc).toContain(
      'a satisfying verdict that is itself `unknown`, a satisfying check that was never selected, a cause nobody recorded — is `evidence-lost`',
    );
    // §4.3 states the same thing where requirement satisfaction is defined.
    expect(doc).toContain('**`not_run` is not the same as unexplained.**');
  });

  test('an accounted absence is neither evidence loss nor a pass', () => {
    expect(doc).toContain('**An accounted absence is not evidence loss.**');
    expect(doc).toContain(
      'an ordinary `code-failed` stage whose remaining checks were never reached must route to the repair path, never to the interruption or `unknown` handling',
    );
    expect(doc).toContain('**Fail closed on the cause:**');
    expect(doc).toContain(
      'an unrecognized or missing `notRunKind` is `evidence-lost`, and `first-failure-stop` is admissible only when the same stage run carries at least one `failed` or `timed-out` verdict',
    );
    expect(doc).toContain('**The skip is never a pass:**');
    expect(doc).toContain(
      'The table changes which *row* a run routes through, never what it proved.',
    );
  });

  test('a fail-fast bundle is still incomplete and still cannot grant', () => {
    expect(doc).toContain('`notRunKind: "first-failure-stop"`');
    expect(doc).toContain(
      "Such a bundle is nonetheless **incomplete**: it is the failing set's evidence, never a grant's.",
    );
    expect(doc).toContain(
      'Completeness is about verdict coverage, never about blame',
    );
  });
});

describe(`${DOC_PATH} — the state-transition table`, () => {
  test('adds no phase-runner vocabulary', () => {
    expect(doc).toContain('**No new phase-runner vocabulary exists**');
    expect(doc).toContain("no change to `nextPhaseAfter`'s transition set");
  });

  test('has exactly thirteen numbered stage rows', () => {
    const rows = [...RAW.matchAll(/^\| \d+ \| `(?:loop|final)` \|/gm)];
    expect(rows).toHaveLength(13);
  });

  test('covers pass, code failure, timeout, interruption and unknown in both stages', () => {
    for (const stage of ['loop', 'final']) {
      for (const outcome of ['passed', 'code-failed', 'timed-out', 'interrupted', 'unknown']) {
        expect(RAW).toMatch(
          new RegExp(`^\\| \\d+ \\| \`${stage}\` \\| \`${outcome}\``, 'm'),
        );
      }
    }
  });

  test('exactly one cell grants stack-ready, on complete head-bound evidence', () => {
    expect(doc).toContain('**Stack-ready is granted by exactly one cell.**');
    expect(doc).toContain(
      'Row 7 — a complete, `passed` final bundle bound to the head being published — and nothing else.',
    );
    expect(doc).toContain(
      'There is no partial credit, no "enough of the set", and no operator override that substitutes for the bundle',
    );
  });

  test('every non-passing final stage clears a live marker', () => {
    expect(doc).toContain('**Any non-passing final stage clears a live marker.**');
  });

  test('interruption and infrastructure consume no agent resource', () => {
    expect(doc).toContain('**Infrastructure and interruption never consume agent resources.**');
    expect(doc).toContain("The lane's caps are intact when the stage re-runs.");
  });

  test('caps stay lane-owned and no cap is added', () => {
    expect(doc).toContain('**Caps stay lane-owned and unchanged.**');
    expect(doc).toContain('adds no cap of its own');
  });

  test('an incomplete passing final bundle hands off to the operator, not to repair', () => {
    expect(doc).toContain('**Missing evidence is never treated as a code failure.**');
    expect(doc).toContain(
      "Row 8's defensive case is a runner defect, not a defect in the Issue's code",
    );
    expect(doc).toContain(
      "It routes to row 12's operator handoff — not to row 10, and so not to row 9's repair route",
    );
    // The row itself must name row 12, never row 10.
    const rowEight = RAW.split('\n').find((line) => line.startsWith('| 8 | `final` |'));
    expect(rowEight).toBeDefined();
    expect(rowEight).toContain('treated as **row 12**');
    expect(rowEight).not.toContain('row 10');
  });

  // The complement of the rule above: a genuine code failure whose later
  // checks were skipped by the fail-fast stop must NOT be read as missing
  // evidence, or every red build would restart the stage or park for an
  // operator instead of reaching the fix loop.
  test('a fail-fast code failure routes to the repair rows, never to interruption or unknown', () => {
    expect(doc).toContain(
      '**A fail-fast stop routes by the failure, not by the absence.**',
    );
    expect(doc).toContain(
      'the shipped `runVerification` does, so an ordinary failing suite produces a bundle whose remaining checks are all `not-run`',
    );
    expect(doc).toContain(
      'so the run is `code-failed` or `timed-out` and routes through rows 2, 3, 9 or 10 — the repair path — and **never** through rows 4, 5, 11 or 12.',
    );
    expect(doc).toContain(
      'The skipped ids stay unproven, never passed: in a loop stage they join the pin set (R6) so the next cycle runs them, and in a final stage the next final stage runs them because a final selection is always total (§4.3).',
    );
  });

  // The requirement-layer twin of the rule above: whether an Issue
  // happens to demand the command that failed must not change the row a
  // failing run takes.
  test('a failing required command routes to the repair rows, never to row 12', () => {
    expect(doc).toContain(
      '**A failing requirement routes as a failure, not as missing evidence.**',
    );
    expect(doc).toContain(
      'carries `requirement-unproven` and likewise contributes nothing to the precedence',
    );
    expect(doc).toContain(
      'a final stage in which a required command failed is `code-failed` and routes through row 9 — the repair route the failure calls for — and never through row 12',
    );
    expect(doc).toContain(
      'The requirement stays unproven and the bundle stays incomplete either way; what the mapping fixes is only which row the run takes.',
    );
  });

  test('rows 2 and 3 name the loop pin set rather than only the next cycle', () => {
    const lines = RAW.split('\n');
    const rowTwo = lines.find((line) => line.startsWith('| 2 | `loop` |'));
    const rowThree = lines.find((line) => line.startsWith('| 3 | `loop` |'));
    expect(rowTwo).toContain('joins the loop pin set (R6)');
    expect(rowTwo).toContain('`first-failure-stop` skips');
    expect(rowThree).toContain("join this Issue's loop pin set (R6)");
    expect(rowThree).toContain('unioned into **every** later loop selection by §4.2 step 4');
  });
});

describe(`${DOC_PATH} — publication ordering`, () => {
  test('the four ordering constraints are stated', () => {
    expect(doc).toContain('**Approval before final.**');
    expect(doc).toContain('**Final before publication.**');
    expect(doc).toContain('**One transaction.**');
    expect(doc).toContain('**Head binding at enqueue.**');
  });

  test('evidence and grant commit in the shipped CAS transaction', () => {
    expect(doc).toContain('**in the same store transaction**');
    expect(doc).toContain('`TaskStore.completePhaseWithEffects`');
    expect(doc).toContain(
      'A crash between them cannot leave a grant whose evidence was never persisted',
    );
  });

  test('a head change between stage and enqueue suppresses the grant', () => {
    expect(doc).toContain('the grant is not published and the final stage is re-queued');
  });

  test('step 4 may only be skipped by a final-stage bundle from this approval', () => {
    expect(doc).toContain(
      'unless §4.4\'s same-lane/same-head/same-plan complete **`final` stage** bundle from this approval already satisfies it',
    );
    expect(doc).toContain(
      'A `loop` bundle, including a full one produced at this same head in step 2 before approval, never satisfies step 4.',
    );
  });

  test('downstream consumption of the marker is unchanged', () => {
    expect(doc).toContain('The marker simply becomes harder to earn.');
  });
});

describe(`${DOC_PATH} — modules to extend, not a parallel engine`, () => {
  test('states that no parallel orchestration engine is introduced', () => {
    expect(doc).toContain('**No parallel orchestration engine is introduced**');
    expect(doc).toContain(
      'no second scheduler, no second classifier, no second evidence model, no second store.',
    );
  });

  test('names the shipped modules the chain extends', () => {
    for (const mod of [
      'src/core/verification-plan.ts',
      'src/core/verification-amendment.ts',
      'src/core/verification-evidence.ts',
      'src/handlers/verification.ts',
      'src/core/implementation-verification.ts',
      'src/core/review-classifier.ts',
      'src/core/task-store.ts',
      'src/core/outbox-effects.ts',
      'src/core/transitions.ts',
    ]) {
      expect(doc).toContain(mod);
    }
  });

  test('transitions, review admission, and the Gate 2 resolver stay unchanged', () => {
    expect(doc).toContain('**Unchanged.** No phase, result, or status is added');
    expect(doc).toContain('No verification evidence is added to admission');
  });

  test('the selection port is named as the only new seam', () => {
    expect(doc).toContain('The only genuinely new seam in the design');
  });

  // The evidence binding must not become a second requirement evaluator:
  // the module map has to say the shipped call is reused as-is and only
  // its input is narrowed.
  test('the evidence binding is a narrowed input to the shipped call, not a second evaluator', () => {
    expect(doc).toContain(
      'a **proven projection** of the plan — its execution layer narrowed to the checks the stage run proved green — passed into `buildEffectiveRequirementStatus` *unchanged*',
    );
    expect(doc).toContain(
      'No new layer, origin, slot state, or matching rule |',
    );
  });
});

describe(`${DOC_PATH} — compatibility and the project-maintenance boundary`, () => {
  test('the feature is default off and behaves exactly as today when unset', () => {
    expect(doc).toContain('**Default off.**');
    expect(doc).toContain("exactly today's behavior and today's artifacts");
  });

  test('an enabled session with no adapter still runs the full set', () => {
    expect(doc).toContain('Both stages run the full required set.');
  });

  test('public summaries carry no output bytes and do carry the scope flag', () => {
    expect(doc).toContain('never raw output, never paths, never command bytes beyond the operator-authored name');
    expect(doc).toContain('The `selection.full` flag is deliberately public');
  });

  test('excludes automated test deletion or restructuring', () => {
    expect(doc).toContain('**No automated deletion or restructuring of tests.**');
    expect(doc).toContain(
      'A check the loop stage does not select is *not run this cycle*; it is not disabled, not retired, and not weakened.',
    );
  });

  test('excludes a mutation-testing engine and defines what mutation means here', () => {
    expect(doc).toContain('**No mutation-testing engine.**');
    expect(doc).toContain(
      '"Mutation" in this chain means the shipped **store mutation ports** (§9) and nothing else.',
    );
  });

  test('excludes a periodic audit scheduler', () => {
    expect(doc).toContain('**No periodic audit scheduler.**');
    expect(doc).toContain('Every stage run is triggered by a phase the runner was already executing.');
  });

  test('excludes a cross-project concurrency scheduler', () => {
    expect(doc).toContain('**No cross-project concurrency scheduler.**');
  });

  test('excludes a new global lock', () => {
    expect(doc).toContain('**No new global lock.**');
    expect(doc).toContain(
      'No lock is added, widened, promoted to a global scope, or held across phases.',
    );
  });

  test('heavy test maintenance stays a separate project operation', () => {
    expect(doc).toContain(
      'Heavy test maintenance remains a separate project operation, outside this chain.',
    );
  });
});

describe(`${DOC_PATH} — invariants and decomposition`, () => {
  test('pins the grant invariant', () => {
    expect(doc).toContain(
      'Partial, stale, unbound, interrupted, and `unknown` evidence never grants',
    );
  });

  test('pins the selection-is-not-authorization invariant', () => {
    expect(doc).toContain(
      'Selection is scope, never authorization. Every check a stage can run was already authorized upstream',
    );
  });

  test('pins the accounted-absence invariant', () => {
    expect(doc).toContain(
      'An accounted absence is never evidence loss and never a pass.',
    );
    expect(doc).toContain(
      'Either way the check is unproven, the bundle is incomplete, and the id is pinned',
    );
  });

  test('pins the mandatory-requirement-needs-a-run invariant', () => {
    expect(doc).toContain(
      'A mandatory requirement is never reported as passed without the evidence of a check that ran.',
    );
    expect(doc).toContain(
      "a stage judges satisfaction over the run's **proven** execution evidence rather than over the plan's configured execution layer",
    );
    expect(doc).toContain(
      'Retaining a requirement slot is not executing it, and this design never lets the first stand in for the second.',
    );
    expect(doc).toContain(
      'a requirement left unproven by a satisfying check that failed or expired is an accounted absence (`requirement-unproven`), not evidence loss, so a failing required command routes by its failure and not to the operator handoff',
    );
  });

  // §14 is what the implementation slices build their suites from, so the
  // combinations the derivation turns on have to be named there too.
  test('the test matrix names the requirement-absence combinations', () => {
    expect(doc).toContain(
      'a `requirement-unproven` slot alongside its `failed` satisfying check is `code-failed` and alongside its `timed-out` satisfying check is `timed-out`, never `unknown`',
    );
    expect(doc).toContain(
      'a `requirement-unproven` on a check that is not `req:<hex>`, or whose satisfying check carries no `failed` or `timed-out` verdict in the same bundle, is `evidence-lost`',
    );
    expect(doc).toContain(
      "the derived `notRunKind` is `requirement-unproven` for the failed and the timed-out satisfier, the skipped satisfier's own `first-failure-stop` for the fail-fast one, and `evidence-lost` for the unselected one and for a satisfier whose own verdict is `unknown`",
    );
    expect(doc).toContain(
      'a final run whose failing or expired check is also the satisfier of an active `req:<hex>` slot routes to row 9 or row 10, never to row 12',
    );
  });

  test('pins the no-new-infrastructure invariant', () => {
    expect(doc).toContain(
      'no new store, table, column, scheduler, or lock',
    );
  });

  test('proposes exactly twelve implementation slices with tracker-assigned numbers', () => {
    const slices = [...RAW.matchAll(/^\| S\d+ \|/gm)];
    expect(slices).toHaveLength(12);
    expect(doc).toContain('the tracker, not this document, assigns numbers');
  });

  test('names the slice where behavior changes for an opted-in session', () => {
    expect(doc).toContain('**This slice is where behavior changes for an opted-in session**');
  });

  test('names its own docs pin test file', () => {
    expect(doc).toContain('`test/docs-staged-verification-contract.test.js` pins this document');
  });
});

describe(`${DOC_PATH} — reconciliation notes in the related documents`, () => {
  test('docs/verification-execution-contract.md §16 records the delivery', () => {
    expect(execution).toContain(
      '**Delivered (#1094)**: `docs/staged-verification-contract.md` — the staged verification lifecycle and ownership contract',
    );
    expect(execution).toContain(
      'It sits *above* §5.1 as a membership filter',
    );
    expect(execution).toContain(
      "it adds no lane, no classification, no cycle outcome, no phase-runner vocabulary, and no change to §10's eligibility or E1–E7 evidence gate.",
    );
  });

  test('the #918 rejected evidence reuse is explicitly not reopened', () => {
    expect(execution).toContain('#1094 §4.4 does not reopen it');
    expect(execution).toContain(
      'only by a **same-lane**, same-head, same-plan complete **final-stage** bundle',
    );
    expect(execution).toContain(
      'neither an implementation-lane bundle nor a `loop` bundle of any lane ever satisfies a review-lane final stage',
    );
  });

  test('docs/verification-amendment-contract.md §17 records the delivery', () => {
    expect(amendment).toContain(
      '**Delivered (#1094)**: `docs/staged-verification-contract.md`',
    );
    expect(amendment).toContain(
      'It introduces no layer, origin, slot state, or revision operation; a stage never amends',
    );
    expect(amendment).toContain(
      "a task-scoped correction made through §11's commands can never be selected away.",
    );
  });

  // The amendment contract owns buildEffectiveRequirementStatus, so it is
  // where the "consumed verbatim, over a narrowed input" distinction has
  // to be recorded — otherwise the delivery note reads as a promise that
  // a stage judges requirements exactly as the plan-level call does.
  test('docs/verification-amendment-contract.md §17 records the evidence-bound stage evaluation', () => {
    expect(amendment).toContain(
      'Because a subset run makes "the plan is configured to run this" and "this run proved it" two different facts',
    );
    expect(amendment).toContain(
      '#1094 §4.2 step 5 also keeps the execution checks that discharge a requirement slot in every selection',
    );
    expect(amendment).toContain(
      'calling `buildEffectiveRequirementStatus` unchanged over a plan whose execution layer is narrowed to the checks that run proved green',
    );
    expect(amendment).toContain(
      'its answer for every shipped plan-level caller',
    );
  });

  test('docs/phase-contracts.md records the Gate 2 marker precondition', () => {
    expect(phases).toContain('**What it takes to earn the marker (opt-in, implemented in #1103).**');
    expect(phases).toContain(
      'the marker is granted only by a complete, passed **final** verification stage over the entire required set',
    );
    expect(phases).toContain(
      'This gate is default-off and changes nothing above',
    );
  });

  test('docs/feature-status.md carries a gated, one-lane staged verification row', () => {
    expect(featureStatus).toContain('#### Staged verification (loop and final stages)');
    const idx = featureStatus.indexOf('#### Staged verification (loop and final stages)');
    const next = featureStatus.indexOf('\n#### ', idx + 1);
    const block = featureStatus.slice(idx, next === -1 ? featureStatus.length : next);
    // #1097's configuration slice moved the row off `design-only`; #1102's loop
    // stage moved it off `foundation-only` by giving an opted-in operator a
    // path that runs end to end in one lane. #1103 added the final stage and
    // the row-7 precondition on the grant. The two claims that must not drift:
    // the loop stage runs nowhere else, and a passing review alone no longer
    // earns the marker for an opted-in session.
    expect(block).toMatch(/\*\*Status:\*\* `config-gated`/);
    expect(block).toContain('staged-verification-contract.md');
    expect(block).toContain('#1094');
    expect(block).toContain('#1103');
    const normalized = block.replace(/\s+/g, ' ');
    expect(normalized).toContain('The loop stage still runs in one lane only, and only a final stage grants.');
    expect(normalized).toContain(
      'For an opted-in session `status:stack-ready` is no longer granted on a passing review alone',
    );
  });

  test('docs/feature-status.md no longer claims #934 sits unmerged on a branch', () => {
    const normalized = featureStatus.replace(/\s+/g, ' ');
    expect(normalized).not.toContain('That work exists on branch `ai/issue-934` but is not yet merged');
    expect(normalized).toContain("#934's classify-and-cap `needs_fix` requeue **has since merged**");
  });

  domainTest('docs/DOMAIN.md §5 records the decided contract', () => {
    expect(domain).toContain(
      '**Staged verification contract decided (#1094)** — `docs/staged-verification-contract.md`',
    );
    expect(domain).toContain('with unknown impact falling back to the **full** required set, never to less');
    expect(domain).toContain('whose **single** granting cell requires a complete, passed final bundle');
    expect(domain).toContain(
      'because retaining a mandatory slot is not the same as running it',
    );
    expect(domain).toContain(
      "A stage judges Issue-required commands over the checks that run actually proved green rather than over the plan's configured execution set",
    );
  });
});
