/**
 * Semantic pins for docs/changed-file-verification-contract.md (issue #1158):
 * one result table and one transition table that agree with each other, a
 * scenario matrix in which no incomplete or all-skipped evidence publishes,
 * the A -> B trace, an inventory whose kept and adapted modules exist and
 * whose Delete rows issue #1155 executed, the retirement notes in the three
 * staged contracts, and the operator decisions with the Issue that owns each
 * piece of work they add.
 *
 * These tests check consistency between tables and the invariants the
 * operator approved — a partial or empty Stage 1 never grants full-suite
 * success, a full failure retains its failed files, and missing, incomplete
 * or stale evidence never passes. They deliberately do not freeze the count,
 * names or wording of decisions, and do not require one section's prose to be
 * duplicated in another.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readRaw = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const normalize = (text) => text.replace(/\s+/g, ' ');

const RAW = readRaw('docs/changed-file-verification-contract.md');
const doc = normalize(RAW);

function section(startHeading, endHeading) {
  const start = RAW.indexOf(startHeading);
  if (start === -1) throw new Error(`missing section: ${startHeading}`);
  const end = endHeading === undefined ? RAW.length : RAW.indexOf(endHeading, start + 1);
  return RAW.slice(start, end === -1 ? RAW.length : end);
}

function tableRows(text, firstCellPattern) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('| ') && !/^\| -/.test(line))
    .map((line) => line.slice(2, -2).split(' | ').map((cell) => cell.trim()))
    .filter((cells) => firstCellPattern.test(cells[0]));
}

const backticked = (cell) => [...cell.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);

const resultRows = tableRows(section('## 3. Semantic result table', '## 4. Selection'), /^R\d+$/);
const transitionRows = tableRows(section('## 5. Transition table', '## 6. Execution'), /^(1|2|—)$/);
const meaningRows = tableRows(section('What each result is allowed to mean:', 'Non-test checks keep'), /`/);

describe('docs/changed-file-verification-contract.md — authority', () => {
  test('is the approved replacement of #1151, wired into the lanes by #1154', () => {
    expect(doc).toContain('issue #1158, replacing the abandoned #1151 draft');
    expect(doc).toContain('the runtime wiring of both stages into the lanes landed in issue #1154');
  });

  test('states the four approved operator requirements', () => {
    for (const id of ['O1', 'O2', 'O3', 'O4']) {
      expect(RAW).toMatch(new RegExp(`\\*\\*${id} — `));
    }
  });

  test('retires the old selection authority and restates retained invariants itself', () => {
    expect(doc).toContain('The staged verification contracts no longer have authority over test selection.');
    expect(doc).toContain('only when §8 restates it');
    const invariants = section('## 8. Retained invariants', '**Obsolete normative policy**');
    expect(invariants.split('\n').filter((line) => /^\d+\. /.test(line)).length).toBe(6);
  });

  test('adds no process-management or migration machinery', () => {
    expect(doc).toContain(
      'It adds no process manager, launch gate, handshake or claim-file protocol, scheduler, operator command, configuration migration, compatibility mode or old-setting detector.',
    );
  });
});

describe('result table and transition table agree', () => {
  test('each result is defined exactly once per stage', () => {
    const seen = new Set();
    for (const [, name, stages] of resultRows) {
      for (const stage of stages.split(', ')) {
        const key = `${stage}:${backticked(name)[0]}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(15);
  });

  test('every defined result has a transition row for its stage, and nothing else does', () => {
    const defined = new Set();
    for (const [, name, stages] of resultRows) {
      for (const stage of stages.split(', ')) defined.add(`${stage}:${backticked(name)[0]}`);
    }
    const routed = new Set();
    for (const [stage, results] of transitionRows) {
      if (stage === '—') continue;
      for (const result of backticked(results)) routed.add(`${stage}:${result}`);
    }
    expect([...routed].sort()).toEqual([...defined].sort());
  });

  test('only Stage 2 passed grants', () => {
    const granting = transitionRows.filter((cells) => cells[3].includes('**Granted**'));
    expect(granting).toHaveLength(1);
    expect(granting[0][0]).toBe('2');
    expect(backticked(granting[0][1])).toEqual(['passed']);
  });

  test('Stage 2 still runs the required non-test checks at the approved revision', () => {
    const granting = transitionRows.find((cells) => cells[3].includes('**Granted**'));
    expect(granting[2]).toContain('non-test checks at the approved revision');
    expect(doc).toContain(
      '**Stage 2 still executes every required non-test check at the approved revision, exactly as the shipped final stage does**',
    );
    expect(doc).toContain('nothing here optimizes those checks away or reuses a loop record in place of running them');
  });

  test('unknown termination and unresolved retained files never re-run automatically', () => {
    for (const [, results, action] of transitionRows) {
      const names = backticked(results);
      if (names.includes('termination-unknown') || names.includes('retained-unresolved')) {
        expect(action).toContain('Never re-run automatically');
      }
    }
  });

  test('a not-run file makes a run incomplete', () => {
    const incomplete = resultRows.find((cells) => backticked(cells[1])[0] === 'incomplete');
    expect(incomplete[3]).toContain('any file is `not-run`');
  });

  test('a deadline overrun is its own result that goes to repair, never to a re-run', () => {
    // A timed-out suite must not be retried until it passes, and its untrusted
    // per-file outcomes must credit nothing, so it retains and publishes nothing.
    const timedOut = resultRows.find((cells) => backticked(cells[1])[0] === 'timed-out');
    expect(timedOut[2]).toBe('1, 2');
    expect(timedOut[3]).toContain('`untrusted` with reason `deadline`');
    for (const cells of transitionRows.filter((c) => backticked(c[1]).includes('timed-out'))) {
      expect(cells[2]).toContain('Never an automatic re-run');
      expect(cells[3]).not.toContain('**Granted**');
    }
    const rerouted = transitionRows.find((cells) => backticked(cells[1]).includes('incomplete') && cells[0] === '1');
    expect(backticked(rerouted[1])).not.toContain('timed-out');
    expect(doc).toContain('**A run that overran its configured deadline goes to repair too**');
    expect(doc).toContain('Only untrusted outcomes whose reason is *not* `deadline`');
  });

  test('publication re-attests every grant prerequisite without re-deriving the result', () => {
    const invariant = normalize(section('4. **Recording → publication.**', '## 3. Semantic result table'));
    expect(invariant).toContain('Publication never re-derives a stage result');
    expect(invariant).toContain('read and re-attest every *other* grant prerequisite');
    expect(invariant).toContain('required non-test check records');
    expect(invariant).toContain('review approval');
    expect(invariant).toContain('never turns a recorded non-`passed` result into a grant');
  });

  test('a stale Stage 2 returns to Stage 1 and review, never a Stage 2 re-run', () => {
    const stale = transitionRows.filter((cells) => cells[0] === '2' && backticked(cells[1]).includes('stale'));
    expect(stale).toHaveLength(1);
    expect(backticked(stale[0][1])).toEqual(['stale']);
    expect(stale[0][2]).toContain('Return to Stage 1 and review');
  });

  test('partial or empty Stage 1 never satisfies the full-suite requirement, yet permits review', () => {
    const satisfying = meaningRows.filter((cells) => cells[2].startsWith('**Yes**'));
    expect(satisfying).toHaveLength(1);
    expect(satisfying[0][0]).toBe('`passed` (Stage 2)');
    const empty = meaningRows.find((cells) => cells[0] === '`empty` (Stage 1)');
    expect(empty[1]).toMatch(/^\*\*Yes\*\*/);
    expect(doc).toContain('Review is never blocked by the pending full-suite requirement.');
  });

  test('no Stage 1 result and no incomplete or stale evidence satisfies the full suite', () => {
    // Every row but the complete Stage 2 pass answers "No" to O4, so nothing a
    // Stage 1 can produce — and no unavailable, incomplete, stale, unattested
    // or unterminated run — stands in for the full suite.
    for (const cells of meaningRows) {
      const expected = cells[0] === '`passed` (Stage 2)' ? '**Yes**' : 'No';
      expect([cells[0], cells[2]]).toEqual([cells[0], expected]);
    }
    // ...and no result defined in §3 escapes that classification, so a new
    // result cannot slip through unclassified and be read as a full-suite pass.
    const stageOf = (label) => (label.includes('Stage 2') ? '2' : label.includes('Stage 1') ? '1' : '*');
    const classified = new Set(
      meaningRows.flatMap((cells) => backticked(cells[0]).map((name) => `${stageOf(cells[0])}:${name}`)),
    );
    for (const cells of resultRows) {
      const name = backticked(cells[1])[0];
      const stages = cells[2].split(', ');
      const covered = classified.has(`*:${name}`) || stages.every((stage) => classified.has(`${stage}:${name}`));
      expect([name, covered]).toEqual([name, true]);
    }
  });

  test('a full-suite failure retains its genuinely failed files and returns to implementation', () => {
    const meaning = meaningRows.find((cells) => cells[0] === '`failed` (Stage 2)');
    expect(meaning[3]).toContain('Adds every `failed` file');
    expect(meaning[3]).toContain('`not-run` files are not added');
    expect(meaning[3]).toContain('a suite-level failure adds none');
    const route = transitionRows.find((cells) => cells[0] === '2' && backticked(cells[1]).includes('failed'));
    expect(route[2]).toContain('Retain the failing files');
    expect(route[2]).toContain('the next cycle starts at Stage 1');
    expect(route[3]).not.toContain('**Granted**');
    // Only a failed Stage 2 ever changes the retained set, and nothing clears it.
    const changing = meaningRows.filter((cells) => !/^No/.test(cells[3]));
    expect(changing.map((cells) => cells[0])).toEqual(['`failed` (Stage 2)']);
    expect(doc).toContain('**Nothing removes an entry before the Issue completes.**');
  });

  test('the test suite entry is an operator-owned, validated binding inside the configuration identity', () => {
    const rule = normalize(section('5. **Operator-owned suite binding.**', '## 7. Scenario matrix'));
    expect(rule).toContain('The binding names **exactly one** key present in `session.verification`');
    expect(rule).toContain('refuses the session at load');
    expect(rule).toContain("its command matches the bound entry's command under the shipped configured-command equivalence");
    expect(rule).toContain('a requirement `npm test` reads *pending Stage 2*, never missing');
    expect(rule).toContain('part of the **configuration identity** (§8 invariant 1)');
    expect(doc).toContain('Core never infers the suite from a key name, a command string');
    expect(doc).toContain('The configuration identity includes the suite binding');
  });

  test('the executed suite command is resolved through the effective plan, not raw session.verification', () => {
    const rule = normalize(section('5. **Operator-owned suite binding.**', '## 7. Scenario matrix'));
    // An operator amendment that replaces the bound slot must be executed as
    // amended, never as the superseded `session.verification` text.
    expect(rule).toContain('active slot the reconciled effective verification plan holds for the bound key');
    expect(rule).toContain('never the raw `session.verification` text');
    expect(rule).toContain('resolveStageSelection');
    expect(rule).toContain('stageExecutionInput');
    // A retired bound slot has no suite: unavailable and parked, never a fallback.
    expect(rule).toContain('never executes a retired slot and never grants');
    // And the requirements it discharges still gate as the suite, so the loop
    // stage cannot end the run before Stage 1 records that `unavailable`.
    expect(rule).toContain('The requirement closure follows the bound slot, retired or not.');
    expect(rule).toContain("leaves the loop stage's non-test selection with it in both cases");
    const byName = Object.fromEntries(resultRows.map((cells) => [`${cells[2]}:${backticked(cells[1])[0]}`, cells[3]]));
    expect(byName['1, 2:unavailable']).toContain('no active slot for the bound suite key');
    // The plan the bytes came from is part of what stage evidence is bound to.
    expect(rule).toContain("that plan's identity (digest and applied-through ordinal)");
  });

  test('a duplicate suite entry is detected by command equivalence, not by slot identity', () => {
    // Two keys carrying the same command (`test: npm test` and `ci: npm test`)
    // have distinct slot identities, so a slot-identity check never fires and
    // the second key would be run as a non-test check — a pre-approval full
    // suite run during Stage 1.
    const rule = normalize(section('2. **No accidental full run.**', '3. **Process outcome first.**'));
    expect(rule).toContain('A duplicate suite entry is detected by command, not by slot');
    expect(rule).toContain("equivalent to the bound entry's active command under the shipped configured-command equivalence");
    expect(rule).toContain('matchesConfiguredVerificationCommand');
    expect(rule).toContain('records `unavailable`');
    expect(rule).toContain('never executed — neither as the suite nor as a non-test check');
    expect(rule).toContain('Comparing slot identities (`exec:<key>`) instead would never fire');
    // The non-test-check catch-all must not re-admit the duplicate it excludes.
    const binding = normalize(section('5. **Operator-owned suite binding.**', '## 7. Scenario matrix'));
    expect(binding).toContain('never classified as a non-test check and never executed');
  });

  // Issue #1166: the requirement text an Issue carries and the command the
  // binding launches are two operator decisions and may differ. The declaration
  // that reconciles them must be explicit, scoped to the bound entry, and
  // incapable of satisfying anything on its own.
  test('the operator may declare which requirement text the bound entry discharges', () => {
    const rule = normalize(section('5. **Operator-owned suite binding.**', '## 7. Scenario matrix'));
    expect(rule).toContain('The operator may declare which requirement text the bound entry discharges');
    expect(rule).toContain('`requirementCommands`');
    expect(rule).toContain('applying **only to the bound entry** and to nothing else in the plan');
    // It declares an identity, never evidence.
    expect(rule).toContain('It declares an identity, never evidence.');
    expect(rule).toContain('Only a complete, passing Stage 2 of that entry satisfies a requirement matched this way');
    // Nothing generic, nothing inferred, nothing AI.
    expect(rule).toContain('no `package.json` is read, no script name resolved, no npm alias treated as equivalent by any generic matching rule, and no AI judgment consulted');
    // The suite never steals another check's requirement.
    expect(rule).toContain('A declared command another `session.verification` entry already runs refuses the session at load');
    // Issue #1166 review, P1: the load-time check is not the whole rule — an
    // amendment can introduce the same collision into the effective plan.
    expect(rule).toContain('The same collision is rechecked against the effective plan as each stage launches');
    expect(rule).toContain('the load-time check sees only the static session map');
    expect(rule).toContain("is not a duplicate of the suite's own command");
    expect(rule).toContain('makes the suite ambiguous exactly as a duplicate does');
    expect(rule).toContain('never classified as a non-test check and never executed');
    // The collision is excluded even when the same revision retires the bound slot.
    expect(rule).toContain('**A colliding slot is excluded whether or not the bound key still has an active slot**');
    expect(rule).toContain('one revision may retire the bound entry and give another slot a declared command at once');
    // And it is part of what stage evidence is bound to.
    expect(rule).toContain('any declared `requirementCommands` are part of the **configuration identity**');
    // §5 rule 4 routes a declared requirement identically to a spelled one.
    const pending = normalize(section('4. **Review is never blocked by the pending full-suite requirement.**', '## 6. Execution'));
    expect(pending).toContain('is the §6 rule 5 relation');
    expect(pending).toContain('plus any Issue-requirement text the operator declared for that entry');
    expect(pending).toContain('`passed` only on a complete passing Stage 2 of the current admissible identity');
  });

  test('the shipped manual-evidence admission for requirements is preserved', () => {
    const rule = normalize(section('5. **Operator-owned suite binding.**', '## 7. Scenario matrix'));
    expect(rule).toContain('buildEffectiveRequirementStatus');
    expect(rule).toContain('admissible bound `manualVerificationEvidence`');
    expect(rule).toContain('never which evidence the shipped requirement gate admits');
    // Preserving that path must not turn manual evidence into a Stage 2 substitute.
    expect(rule).toContain('Manual evidence never substitutes for Stage 2');
    const pending = normalize(section('4. **Review is never blocked by the pending full-suite requirement.**', '## 6. Execution'));
    expect(pending).toContain('already reports it `passed` from admissible bound manual evidence');
  });

  test('unavailable selection is distinct from an empty known selection', () => {
    const byName = Object.fromEntries(resultRows.map((cells) => [`${cells[2]}:${backticked(cells[1])[0]}`, cells[3]]));
    expect(byName['1, 2:unavailable']).toContain('no selection is known');
    expect(byName['1:empty']).toContain('Selection is known and empty');
    expect(doc).toContain('Unreadable is never empty.');
  });

  test('Stage 2 is never made unavailable by the Issue base or the cumulative diff', () => {
    const byName = Object.fromEntries(resultRows.map((cells) => [`${cells[2]}:${backticked(cells[1])[0]}`, cells[3]]));
    expect(byName['1, 2:unavailable']).toContain('in Stage 2 only the runnable-file report or the retained set');
  });

  test('publication re-checks the live identity inside the recording completion', () => {
    expect(doc).toContain('**The live identity is re-checked inside publication.**');
    const byName = Object.fromEntries(resultRows.map((cells) => [`${cells[2]}:${backticked(cells[1])[0]}`, cells[3]]));
    expect(byName['1, 2:stale']).toContain('completion re-check');
    expect(byName['1, 2:identity-unknown']).toContain('completion re-check');
  });

  test('an unattested or changed identity is never recorded as retained-unresolved', () => {
    const byName = Object.fromEntries(resultRows.map((cells) => [`${cells[2]}:${backticked(cells[1])[0]}`, cells[3]]));
    expect(byName['1:retained-unresolved']).toContain('neither R4 nor R5 applies');
  });
});

describe('scenario matrix and trace', () => {
  const scenarios = tableRows(section('## 7. Scenario matrix', 'The whole model traces'), /^[A-Z]/).filter(
    (cells) => cells[0] !== 'Scenario',
  );

  test('covers the required scenarios', () => {
    expect(scenarios.map((cells) => cells[0])).toEqual([
      'Ordinary success',
      'Non-test check failure',
      'Full failure retained',
      'Fail-fast failure',
      'Suite-level failure',
      'Host failure',
      'Empty Stage 1',
      'All-skipped Stage 1',
      'Accepted predecessor update',
      'Predecessor ref moved',
      'Mixed pass/skip',
      'All-skipped full run',
      'Unavailable selection',
      'Deadline exceeded',
      'Interrupted, termination confirmed',
      'Interrupted, termination unknown',
      'Revision change',
      'Unattested identity',
      'Absent retained file',
    ]);
  });

  test('only complete passing Stage 2 evidence publishes', () => {
    const publishing = scenarios.filter((cells) => cells[4] !== 'No').map((cells) => cells[0]);
    expect(publishing).toEqual(['Ordinary success', 'Mixed pass/skip']);
    const mixed = scenarios.find((cells) => cells[0] === 'Mixed pass/skip');
    expect(mixed[4]).toContain('§5 rule 1');
    expect(mixed[1]).toContain('review approval of the same revision');
    expect(mixed[1]).toContain('required non-test checks passed');
  });

  test('every scenario result is a defined result', () => {
    const names = new Set(resultRows.map((cells) => backticked(cells[1])[0]));
    for (const cells of scenarios) {
      for (const result of backticked(cells[2])) expect(names.has(result)).toBe(true);
    }
  });

  test('the trace goes A -> full B failure -> A+B -> full success', () => {
    const trace = tableRows(section('The whole model traces', '## 8. Retained invariants'), /^\d$/);
    expect(trace.map((cells) => [cells[2], backticked(cells[3])[0], cells[4]])).toEqual([
      ['Stage 1 `files [A]`', 'passed', '∅'],
      ['Stage 1 evidence for H1, else `files [A]`', 'passed', '∅'],
      ['Stage 2 `full`', 'failed', '`{B}`'],
      ['Stage 1 `files [A, B]`', 'passed', '`{B}`'],
      ['Stage 1 evidence for H2, else `files [A, B]`', 'passed', '`{B}`'],
      ['Stage 2 `full`', 'passed', '`{B}`'],
    ]);
    expect(trace[5][5]).toBe('**Grant**');
  });
});

describe('inventory, ownership and operator decisions', () => {
  const inventory = tableRows(section('## 9. Keep / adapt / delete inventory', '## 10.'), /`/);
  const modulePaths = (cell) =>
    [...cell.matchAll(/`((?:src|scripts|docs|test|\.ai-cli-loop)\/[^`]+)`/g)].map((m) => m[1]);
  // The one Delete row that opens with prose rather than a path deletes
  // *fields* out of two modules the replacement keeps; every other Delete row
  // names whole modules.
  const wholeModuleDeletes = inventory.filter((cells) => cells[1] === 'Delete' && cells[0].startsWith('`'));
  const fieldDeletes = inventory.filter((cells) => cells[1] === 'Delete' && !cells[0].startsWith('`'));

  test('the inventory reaches a verdict of Keep, Adapt or Delete on every module', () => {
    expect([...new Set(inventory.map((cells) => cells[1]))].sort()).toEqual(['Adapt', 'Delete', 'Keep']);
    expect(wholeModuleDeletes.length).toBeGreaterThan(0);
    expect(fieldDeletes).toHaveLength(1);
  });

  test('every kept or adapted module exists', () => {
    for (const cells of inventory.filter((cells) => cells[1] !== 'Delete')) {
      for (const path of modulePaths(cells[0])) {
        expect([path, existsSync(join(ROOT, path))]).toEqual([path, true]);
      }
    }
  });

  // Issue #1155 executed the Delete rows, so the inventory is now also a pin
  // on their absence: a whole-module row leaves no file behind, and the
  // field-level row keeps its two modules and loses the setting names.
  test('the delete rows are executed — no module and no selection setting survives', () => {
    for (const cells of wholeModuleDeletes) {
      for (const path of modulePaths(cells[0])) {
        expect([path, existsSync(join(ROOT, path))]).toEqual([path, false]);
      }
    }
    const [cells] = fieldDeletes;
    const settings = [...cells[2].matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]);
    expect(settings).toEqual([
      'selectable',
      'finalOnly',
      'selectionTimeoutMs',
      'selectionAdapter',
      'resultAdapters',
      'resultTimeoutMs',
    ]);
    for (const path of modulePaths(cells[0])) {
      expect([path, existsSync(join(ROOT, path))]).toEqual([path, true]);
      const source = readRaw(path);
      for (const setting of settings) {
        expect([path, setting, new RegExp(`\\b${setting}\\b`).test(source)]).toEqual([path, setting, false]);
      }
    }
  });

  test('preserves downstream ownership #1152–#1156 and gives the applied D5/D6 to #1165', () => {
    const rows = tableRows(section('## 10. Downstream ownership', '### 10.1'), /^#\d+$/);
    expect(rows.map((cells) => cells[0])).toEqual(['#1152', '#1153', '#1154', '#1155', '#1156', '#1165', '#1174']);
    const owned = Object.fromEntries(rows.map((cells) => [cells[0], cells[1]]));
    // The two decisions that add work assign it to the Issue that already owns
    // the area: the suite binding to #1152, the termination guard to #1154.
    expect(owned['#1152']).toContain('suite binding');
    expect(owned['#1152']).toContain('load-time validation');
    expect(owned['#1154']).toContain('unconfirmed-termination guard');
    expect(owned['#1153']).toContain('Cumulative selection');
    // D5 and D6 were approved after #1156; applying them is #1165's alone, and
    // it takes no area away from the Issues above.
    expect(owned['#1165']).toContain('D5');
    expect(owned['#1165']).toContain('D6');
    // Issue #1174 adds an adapter and nothing else: the algorithm stays put.
    expect(owned['#1174']).toContain('The Vitest adapter');
    expect(owned['#1174']).toContain('no change to selection, retention, routing or the Jest adapter');
  });

  // Issue #1174: the Vitest adapter's tool-specific rules sit beside the
  // shared ones, and none of them changes the algorithm.
  test('§6 rule 6 names the implemented adapters and the Vitest adapter restrictions', () => {
    const rule = normalize(section('6. **Implemented adapters.**', '## 7. Scenario matrix'));
    expect(rule).toContain('`jest` (#1152) and `vitest` (#1174)');
    expect(rule).toContain('An adapter changes how the tooling is asked and read, never the algorithm');
    expect(rule).toContain('**Supported range: Vitest 3, from 3.2**');
    expect(rule).toContain('**The adapter owns the subcommand.**');
    expect(rule).toContain('**Explicit files are checked, not trusted.**');
    expect(rule).toContain('A similarly named file is refused, never run and never collapsed into the requested one.');
    expect(rule).toContain('Exit zero is never a pass by itself');
    expect(rule).toContain('Configured projects are supported when each test file belongs to exactly one project.');
    expect(rule).toContain('rather than collapsing incompatible results');
  });

  test('records the operator decisions as settled, without claiming the known defect is fixed', () => {
    const decisions = normalize(section('### 10.1 Approved operator decisions'));
    expect(decisions).toContain('They are settled requirements, not open questions');
    // The unconfirmed-termination guard: parks, reuses what exists, and every
    // started run with no recorded result parks until launch evidence exists.
    expect(decisions).toContain('**Implemented by #1154 for the test stages**');
    expect(decisions).toContain('an allocated run with no recorded result parks through the existing handoff');
    expect(decisions).toContain('every started run with no recorded result parks');
    expect(decisions).toContain(
      'No process manager, autonomous orphan recovery, handshake or claim-file subsystem is added',
    );
    // A retained file that is gone stays an obligation; the release surface is deferred.
    expect(decisions).toContain('never silently discarded');
    expect(decisions).toContain('deferred to a separate future task');
    // Stage 2 still runs the required non-test checks at the approved revision.
    expect(decisions).toContain('execute the required non-test checks at the approved revision');
    // The suite binding is human-supplied; nothing infers it or rewrites live settings.
    expect(decisions).toContain('never infer or autonomously authorize them');
    expect(decisions).toContain('never edit a live `sessions.json`');
  });

  test('records D5 and D6 as decided, with no open decision left behind', () => {
    // The operator approved D5 and D6 after #1158 shipped; #1165 applied them.
    // Nothing in the document may still describe either as open, and §10.2 is
    // gone rather than emptied.
    expect(() => section('### 10.2 Open decisions')).toThrow(/missing section/);
    expect(doc).not.toContain('open decision D5');
    expect(doc).not.toContain('open decision D6');
    const decisions = normalize(section('### 10.1 Approved operator decisions'));
    expect(decisions).toMatch(/\*\*D5 — /);
    expect(decisions).toMatch(/\*\*D6 — /);

    // D5: only an accepted, recorded predecessor update advances the base; a
    // moved ref never does; retained obligations survive and old evidence dies.
    const base = normalize(section('### 4.1 Issue base', '### 4.2'));
    expect(base).toContain('Decision D5 (§10.1) settles the re-base.');
    expect(base).toContain('recorded it together with an attestation that the predecessor was accepted at that exact commit');
    expect(base).toContain('**A moved ref, a force-push and a bare fetch change nothing**');
    expect(base).toContain("are **not** this Issue's changes.");
    expect(base).toContain('The retained set is unchanged by the advance');
    expect(base).toContain('every stage result and review approval recorded against the old base is invalidated');
    // Including the bundle a live grant rests on: an already-ancestor predecessor
    // head leaves the branch head untouched, so a retained granting bundle would
    // still bind and republish the marker with no Stage 2 after the advance.
    expect(base).toContain('**No bundle is exempt, including the one a live stack-ready grant rests on, and the pin that names it is dropped with it.**');
    expect(base).toContain('the stack-ready marker is republished only by the completion that records the fresh Stage 2');
    // The approval waiting on its own final stage dies with the evidence: it is
    // bound to a head an already-ancestor advance never moves, so leaving it
    // would let the next review resume on it instead of reviewing the re-based
    // revision.
    expect(base).toContain('**An approval still waiting on its own final stage is dropped by the same write.**');
    expect(base).toContain('Advancing the base and evicting that approval are one write, never two.');
    expect(decisions).toContain('stack-ready again for that **exact** head');
    // A label a force-push carries along is not an acceptance of the new head.
    expect(decisions).toContain('A readiness *label* the predecessor still carries is not that evidence');

    // D6: an all-skipped Stage 1 is R10 `empty` — review, then a mandatory
    // Stage 2 — and Stage 2's all-skipped row still parks.
    const byName = Object.fromEntries(resultRows.map((cells) => [`${cells[2]}:${backticked(cells[1])[0]}`, cells[3]]));
    expect(byName['1:empty']).toContain('`skipped` every one of them, so no test executed (decision D6)');
    expect(byName['1:empty']).toContain('neither is ever reported as a pass');
    const stage1Continue = transitionRows.find((cells) => cells[0] === '1' && backticked(cells[1]).includes('empty'));
    expect(stage1Continue[2]).toContain('makes Stage 2 mandatory');
    expect(stage1Continue[3]).toBe('Not granted');
    const stage2Park = transitionRows.find((cells) => cells[0] === '2' && backticked(cells[1]).includes('no-evidence'));
    expect(stage2Park[2]).toContain('Never re-run automatically');
    expect(stage2Park[2]).toContain('needs a human');
  });

  test('a nonzero exit never passes, and fail-fast failures are retained', () => {
    const byName = Object.fromEntries(resultRows.map((cells) => [`${cells[2]}:${backticked(cells[1])[0]}`, cells[3]]));
    expect(byName['1, 2:failed']).toContain('suite-level failure');
    // A nonzero exit is a code failure even when files never ran (a global
    // setup failure), so it routes to repair instead of an automatic re-run
    // as `incomplete`.
    expect(byName['1, 2:failed']).toContain(
      '**Every known nonzero process result at an attested, unchanged identity that R6 does not recognize is a code-level failure**',
    );
    expect(byName['1, 2:incomplete']).toContain('R6 and R7 win first for every run whose process result is `failed`');
    expect(doc).toContain('A known nonzero exit that is `failed` is never re-run under `maxStageRecoveryAttempts`');
    expect(doc).toContain('the process result is `succeeded` and no file is `not-run`');
    expect(doc).toContain('trusted `failed` outcome in a `failed` Stage 2');
    expect(doc).not.toContain('failed in a complete Stage 2');
    expect(byName['1, 2:unavailable']).toContain("equivalent to the bound test suite entry's active command");
  });

  test('a nonzero exit fails even when the per-file outcomes cannot be trusted', () => {
    // An unreadable or mismatched adapter result must not turn a real setup or
    // teardown failure into an `incomplete` run that §5 reruns to green. The
    // failure is run-level; only the retentions depend on outcome trust.
    const byName = Object.fromEntries(resultRows.map((cells) => [`${cells[2]}:${backticked(cells[1])[0]}`, cells[3]]));
    expect(byName['1, 2:failed']).toContain('**whatever the outcome trust**');
    expect(byName['1, 2:failed']).toContain('Only a *trusted* explicit `failed` file outcome is ever retained');
    expect(byName['1, 2:incomplete']).toContain('**and that recorded no `failed` process result**');
    const meaning = meaningRows.find((cells) => cells[0] === '`failed` (Stage 2)');
    expect(meaning[3]).toContain('an untrusted run adds none');
    expect(doc).toContain('losing trust in the outcomes costs that run its retained files, never its failure');
    // A run that never ended on its own records no process result, so this
    // branch cannot swallow the deadline row.
    expect(byName['1, 2:failed']).toContain('a deadline overrun, an interruption or a spawn failure is never this row');
  });

  test('only recorded launch and termination evidence lets a no-result run re-run', () => {
    // A worker that died before spawning and one that died just after spawning
    // an orphan look the same to a recovering worker, so only evidence the run
    // itself recorded may authorize a re-run; everything else parks.
    const byName = Object.fromEntries(resultRows.map((cells) => [`${cells[2]}:${backticked(cells[1])[0]}`, cells[3]]));
    expect(byName['1, 2:termination-unknown']).toContain('**Unconfirmed termination is what this row is for.**');
    expect(byName['1, 2:termination-unknown']).toContain('its recorded launch and termination evidence (§2) does not prove');
    expect(byName['1, 2:termination-unknown']).toContain('Nothing the recovering worker observes stands in for that evidence');
    expect(byName['1, 2:incomplete']).toContain(
      'a started run with no recorded result whose recorded launch and termination evidence proves',
    );
    const shared = normalize(section('## 2. Shared information between boundaries', 'Boundary invariants:'));
    expect(shared).toContain('| Launch and termination evidence |');
    expect(doc).toContain('**Confirmation is exactly what the park waits for**');
    // The shipped ledger cannot supply the proof, so the gap is reported and
    // those runs park rather than being asserted safe.
    expect(doc).toContain('**The shipped stage-run ledger records no such evidence today**');
    expect(doc).toContain('every started run with no recorded result is `termination-unknown` and parks');
    expect(doc).not.toContain('nothing to terminate');
  });

  test('identity rows decide a nonzero exit before it is blamed on the change', () => {
    const order = resultRows.map((cells) => backticked(cells[1])[0]);
    for (const identity of ['identity-unknown', 'stale']) {
      expect(order.indexOf(identity)).toBeLessThan(order.indexOf('infrastructure'));
      expect(order.indexOf(identity)).toBeLessThan(order.indexOf('failed'));
    }
    const byName = Object.fromEntries(resultRows.map((cells) => [`${cells[2]}:${backticked(cells[1])[0]}`, cells[3]]));
    expect(byName['1, 2:failed']).toContain('**R4 and R5 come first.**');
    expect(doc).toContain('**Identity first:** a nonzero exit at an unattested or changed identity is `identity-unknown` or `stale`');
  });

  test('a host failure recognized by the shipped classification keeps the host-retry route', () => {
    const order = resultRows.map((cells) => backticked(cells[1])[0]);
    expect(order.indexOf('infrastructure')).toBeLessThan(order.indexOf('failed'));
    const byName = Object.fromEntries(resultRows.map((cells) => [`${cells[2]}:${backticked(cells[1])[0]}`, cells[3]]));
    expect(byName['1, 2:infrastructure']).toContain('shipped host-failure classification');
    expect(doc).toContain('`stageCheckHostFailure`');
    for (const cells of transitionRows.filter((c) => backticked(c[1]).includes('infrastructure'))) {
      expect(backticked(cells[1])).toEqual(['infrastructure']);
      expect(cells[2]).toContain('Existing host retry');
      expect(cells[2]).toContain('without invoking an agent');
      expect(cells[3]).not.toContain('**Granted**');
    }
    const meaning = meaningRows.find((cells) => backticked(cells[0]).includes('infrastructure'));
    expect(meaning[3]).toMatch(/^No/);
  });

  test('a mid-run plan change is stale, not unavailable', () => {
    // R2 precedes R5, so its plan conditions must be scoped to launch time.
    // Otherwise a slot retired or duplicated under a running stage would record
    // `unavailable` and park a Stage 2 that should return through Stage 1 and
    // review at the live revision.
    const byName = Object.fromEntries(resultRows.map((cells) => [`${cells[2]}:${backticked(cells[1])[0]}`, cells[3]]));
    expect(byName['1, 2:unavailable']).toContain(
      '**Both plan conditions are launch-time input validation and nothing else.**',
    );
    expect(byName['1, 2:unavailable']).toContain('changes the configuration identity, so it is R5, never this row');
    const binding = normalize(section('5. **Operator-owned suite binding.**', '## 7. Scenario matrix'));
    expect(binding).toContain('holds no active slot for the bound key **as the stage launches**');
    expect(binding).toContain('a Stage 2 returns through Stage 1 and review rather than parking');
    const noFullRun = normalize(section('2. **No accidental full run.**', '3. **Process outcome first.**'));
    expect(noFullRun).toContain('A duplicate an operator introduces *after* the launch changes the configuration identity');
  });
});

describe('supersession notes and feature status', () => {
  test.each([
    'docs/staged-verification-contract.md',
    'docs/project-verification-contract.md',
    'docs/verification-evidence-validity-contract.md',
  ])('%s defers selection authority to the new contract', (rel) => {
    const text = normalize(readRaw(rel));
    expect(text).toContain('**Superseded for selection (#1158).** `docs/changed-file-verification-contract.md`');
    expect(text).toContain("only where that contract's §8 restates it");
  });

  test('the evidence-validity note parks only runs whose termination is unconfirmed', () => {
    // The new contract recovers a confirmed-terminated no-result run as
    // `incomplete` (§3 R8, §5 rule 3). The supersession note must not tell a
    // downstream implementer to park every allocated no-result run instead.
    const text = normalize(readRaw('docs/verification-evidence-validity-contract.md'));
    expect(text).toContain(
      'An allocated run with no result re-runs automatically only when termination is confirmed by launch and termination evidence the run itself recorded',
    );
    expect(text).toContain('A worker\'s death or a superseded allocation never proves it');
    expect(text).toContain('Only a run whose termination cannot be confirmed parks as `termination-unknown`');
  });

  test('docs/feature-status.md links the contract', () => {
    const featureStatus = normalize(readRaw('docs/feature-status.md'));
    expect(featureStatus).toContain('[changed-file-verification-contract.md](changed-file-verification-contract.md) (issue #1158');
  });
});
