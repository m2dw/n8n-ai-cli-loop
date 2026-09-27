/**
 * Structural tests for docs/verification-evidence-validity-contract.md
 * (issue #1096).
 *
 * The document is the authoritative contract for the durability half of
 * staged verification: what identity a stage evidence bundle is bound
 * to, when that evidence stops being usable, how a failing check stays
 * pinned to its Issue, and what happens when a run crashes, is amended
 * underneath, loses the check it pinned, or has to be recovered by an
 * operator. Issue #1096 is a pure specification — no production code
 * changes with it — so these tests pin the document's own claims: the
 * three-valued identity component with its never-`none`-from-failure
 * and unimplemented-is-`none` rules and its stated divergence from
 * #916, the closed seven-component tuple that excludes
 * `selectionDigest`, the resolve-before-launch and end-of-run re-check
 * rules with the clean-worktree precondition on a final stage, the
 * matching law in which `unknown` matches nothing including itself, the
 * arms-but-never-releases asymmetry, the declared-never-sniffed
 * dependency and environment rule, the typed-fact attribution rules
 * that keep a whole-command timeout off the last displayed test and
 * infrastructure off the repair path, the pin record with its
 * purchasing-power rule and its closed four-kind release table,
 * dormancy with its rename-is-a-delete-and-an-add rule, the
 * idempotency key with its two observable states, the bounded
 * consecutive-retry budget, the three closed operator recovery
 * operations, the no-backfill migration rules, the invariants, the
 * implementation mapping that adds no slice, and the reconciliation
 * notes in docs/staged-verification-contract.md §15,
 * docs/project-verification-contract.md §15,
 * docs/verification-amendment-contract.md §17,
 * docs/verification-execution-contract.md §16, docs/feature-status.md
 * and docs/DOMAIN.md §5 that land alongside it — against drift. They
 * are structural only, mirroring the doc-only pin pattern used for
 * docs/staged-verification-contract.md (#1094) and
 * docs/project-verification-contract.md (#1095).
 */
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readRaw(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

// Assertions run against a whitespace-normalized copy: the documents are
// hard-wrapped prose, so a claim can straddle a line break today and be
// reflowed tomorrow. Normalizing means these tests pin what a document
// says, not how it happens to be wrapped. Blockquote markers are stripped
// FIRST because this document states its two load-bearing laws (§4.4 and
// §6.2) as blockquotes: without the strip, every wrapped line inside one
// would leave a stray `>` in the middle of the collapsed prose and a pin
// could only ever cover a single physical line. Table-shape assertions use
// the RAW text, where a row is still a line.
function read(rel) {
  return readRaw(rel).replace(/^>\s?/gm, '').replace(/\s+/g, ' ');
}

const DOC_PATH = 'docs/verification-evidence-validity-contract.md';
const RAW = readRaw(DOC_PATH);
const doc = read(DOC_PATH);
const staged = read('docs/staged-verification-contract.md');
const project = read('docs/project-verification-contract.md');
const amendment = read('docs/verification-amendment-contract.md');
const execution = read('docs/verification-execution-contract.md');
const featureStatus = readRaw('docs/feature-status.md');

// docs/DOMAIN.md is a PRIVATE_ONLY_PATH (copybara/copy.bara.sky): the public
// mirror never receives it, and a test that unconditionally loads it couples
// this file to material the exported tree lacks. The DOMAIN.md pins below
// therefore run only where the document exists and skip cleanly elsewhere.
const domain = existsSync(resolve(ROOT, 'docs/DOMAIN.md')) ? read('docs/DOMAIN.md') : null;
const domainTest = domain === null ? test.skip : test;

function section(startHeading, endHeading) {
  const start = RAW.indexOf(startHeading);
  expect(start).toBeGreaterThan(-1);
  const end = RAW.indexOf(endHeading, start + 1);
  expect(end).toBeGreaterThan(start);
  return RAW.slice(start, end);
}

describe(`${DOC_PATH} — status, chain position, and deferrals`, () => {
  test('declares an approved design whose implemented part resolves no identity', () => {
    // #1099 landed S4's persistence half: the seven-component identity, the
    // ordinal allocated before launch and the all-`unknown` reading of legacy
    // evidence are now shapes the runner writes and reads. What still does not
    // exist is a stage run that resolves one.
    expect(doc).toContain(
      "Status: **approved design; §9's S2 session fields "
        + "(`maxStageRecoveryAttempts`, `environmentIdentity`) and S4's persisted "
        + 'identity, ordinal allocation and legacy-evidence rules are implemented, '
        + 'and no stage run resolves an identity yet** (issues #1096, #1097, #1099).',
    );
  });

  test('states the chain position as slice 3/15 with 3 design Issues', () => {
    expect(doc).toContain(
      'This is slice 3/15 of the independent **Staged Verification** chain: 3 design Issues followed by 12 implementation/validation Issues.',
    );
    expect(doc).toContain('The chain has no dependency on another active chain.');
  });

  test('ships no runtime behavior', () => {
    expect(doc).toContain('**no runtime behavior ships with it.**');
  });

  test('consumes both predecessors verbatim and adds nothing to their vocabularies', () => {
    expect(doc).toContain(
      'It is the third and last design Issue of the chain, and it closes the seam both of its predecessors deferred to it.',
    );
    expect(doc).toContain('Everything those two decided is consumed **verbatim** here');
    expect(doc).toContain(
      '**This document adds no stage, no outcome, no verdict, no selection source, no transition row and no grant path.**',
    );
    expect(doc).toContain('It adds exactly three things neither predecessor owns');
  });

  test('defers the lifecycle, the project half, the plan model and the engine', () => {
    expect(doc).toContain(
      '**The stage lifecycle** — stages, selection, outcomes, aggregation, the transition table, the publication ordering and the retention floors are fixed by `docs/staged-verification-contract.md` (#1094).',
    );
    expect(doc).toContain(
      '**Project configuration and the adapters** — fixed by `docs/project-verification-contract.md` (#1095).',
    );
    expect(doc).toContain(
      '**Environment preparation itself** — `docs/environment-prepare-contract.md` owns the prepare command, its stamp, its caching and its stop-reason classification (#1060).',
    );
    expect(doc).toContain(
      '**Retention, backup and pruning mechanics** — `docs/retention-backup-contract.md` owns them.',
    );
  });
});

describe(`${DOC_PATH} — §3 the map onto shipped state`, () => {
  test('the map changes nothing it names', () => {
    expect(doc).toContain("The Issue's first requirement is a map, not a redesign.");
    expect(doc).toContain('**Nothing in this table changes the mechanism it names.**');
  });

  test('the session baseline is mapped as the component plan-neutral drift requires', () => {
    expect(doc).toContain(
      'This is the component that exists **because** §6.4 rule 3 proves a plan-neutral drift leaves `planDigest` equal: without it, an authorized session edit would be invisible to every identity comparison',
    );
  });

  test('the prepare stamp is the declared dependency identity and core still knows no lockfile', () => {
    expect(doc).toContain(
      'The **declared** dependency and environment identity (§4.5). Its `cacheKeyFiles` are operator-declared, so core learns "the dependency state changed" without knowing what a lockfile is',
    );
  });

  test('legacy verification context is read-only history', () => {
    expect(doc).toContain(
      'Read-only history. It is never converted into a bundle, an identity, or a pin (§8 rule 2)',
    );
  });

  test('the shipped evidence evaluator and the resolve failure path are consumed unchanged', () => {
    expect(doc).toContain('Consumed **verbatim**.');
    expect(doc).toContain(
      'Unchanged, and it is **not** a pin release: it clears operator-attested evidence on its own trigger and touches no pin, no bundle and no identity (§6.3 rule 5)',
    );
  });
});

describe(`${DOC_PATH} — §4 evidence identity`, () => {
  test('a component is three-valued and a failure never produces `none`', () => {
    expect(doc).toContain('**`none` is never produced by a failure.**');
    expect(doc).toContain(
      '`none` is reachable only from a successful consultation whose answer is "nothing is declared".',
    );
  });

  test('an unimplemented or unconfigured source is `none`, not `unknown`', () => {
    expect(doc).toContain('**A source that does not exist yet is `none`, not `unknown`.**');
    expect(doc).toContain(
      '"not implemented" is a configuration fact, "implemented and broke" is not.',
    );
  });

  test('the divergence from #916 unknown-evaluates-as-absent is stated explicitly', () => {
    expect(doc).toContain('**The divergence from #916 is deliberate and is stated here once.**');
    expect(doc).toContain(
      'Both contracts fail closed; they fail closed in opposite directions because they are answering opposite questions.',
    );
  });

  test('the tuple is exactly the seven documented components', () => {
    const table = section('### 4.5 The components, one by one', '### 4.6 Where identity is used');
    const rows = [
      ...table.matchAll(
        /^\| `(testedRevision|workingTreeState|planDigest|planRevisionOrdinal|sessionBaselineDigest|selectionPolicyDigest|environmentIdentity)` \|/gm,
      ),
    ];
    expect(rows).toHaveLength(7);
    expect(doc).toContain('The component set is **closed**; adding one is a change to this document first.');
  });

  test('`selectionDigest` is deliberately not a component', () => {
    expect(doc).toContain('`selectionDigest` (#1094 §6.2) is **not** a member.');
    expect(doc).toContain(
      'Keeping the two separate is what lets a consumer say "same world, different scope" — which is exactly the loop-versus-final distinction.',
    );
  });

  test('identity resolves before launch, is re-checked at the end, and costs no execution when it fails', () => {
    expect(doc).toContain('**Resolved once, at launch, before the first check starts.**');
    expect(doc).toContain('**An unresolvable identity costs no execution.**');
    expect(doc).toContain('**Re-checked once, at the end, before the bundle is written.**');
    expect(doc).toContain('**An unresolvable component makes the stage run `unknown`.**');
    expect(doc).toContain(
      'the #1094 §6.1 member, not a new one',
    );
  });

  test('a final stage requires a clean working tree and a loop stage deliberately does not', () => {
    expect(doc).toContain('**A `final` stage launches only on a clean working tree.**');
    expect(doc).toContain(
      'Untracked, non-ignored paths do **not** block the launch — the review worktree routinely holds runner-written artifacts — but they are counted into `workingTreeState` (§4.5) so two otherwise identical runs are still distinguishable.',
    );
    expect(doc).toContain(
      "A `loop` stage has no such precondition: it runs on the agent's uncommitted diff on purpose (#1094 §8 step 1), which is exactly why `workingTreeState` is a component rather than an assertion.",
    );
  });

  test('no component is ever supplied or corrected by an adapter, agent, project file or case id', () => {
    expect(doc).toContain(
      '**No component is ever supplied, defaulted, corrected or contradicted by an adapter, an agent, a project file, or a case id.**',
    );
  });

  test('the matching law makes `unknown` match nothing including itself', () => {
    expect(doc).toContain(
      'A component in state `unknown` matches nothing, including another component in state `unknown`.',
    );
    expect(doc).toContain('Two identities match iff **all seven** components match.');
    expect(doc).toContain('**There is no partial validity and no component weighting.**');
    expect(doc).toContain('**There is no override.**');
  });

  test('invalidation deletes nothing and an invalid bundle arms but never releases', () => {
    expect(doc).toContain('**Invalidation deletes nothing.**');
    expect(doc).toContain(
      '"Invalid" means exactly "not admissible for a use", never "gone".',
    );
    expect(doc).toContain('**An invalid bundle can still arm a pin and can never release one.**');
    expect(doc).toContain(
      'This asymmetry is the fail-closed direction and it is deliberate — a run that ran under an identity nobody can pin down still observed something break.',
    );
  });

  test('legacy records are `unknown` rather than `none`', () => {
    expect(doc).toContain('**Legacy and partial records are `unknown`, not `none`.**');
  });

  test('dependencies and environment are declared, never sniffed', () => {
    expect(doc).toContain('**Dependencies are covered twice and sniffed never.**');
    expect(doc).toContain(
      'Core therefore learns "the dependency state changed" without reading a lockfile, knowing what a package manager is, or inspecting a path (#1094 §3.3).',
    );
    expect(doc).toContain('**A worktree the runner cannot vouch for has an `unknown` environment.**');
  });

  test('`workingTreeState` is bound to file contents, not to porcelain status entries', () => {
    expect(doc).toContain('**A status entry is not a content fingerprint.**');
    expect(doc).toContain(
      'A path that is already modified, or already untracked, keeps a byte-identical `<status-code> <path>` entry when its contents change again.',
    );
    expect(doc).toContain(
      'every path the status lists is fingerprinted by its current bytes through the same provider seam, the listing enumerates untracked files individually rather than collapsing a directory into one entry',
    );
    expect(doc).toContain('**fingerprinting bytes is not sniffing them**');
    expect(doc).toContain('makes the component `unknown` and is never silently skipped.');
  });

  test('the session baseline is read live and a live-versus-stored divergence is `unknown`', () => {
    expect(doc).toContain(
      '**The session baseline is read live, and a divergence is not an identity.**',
    );
    expect(doc).toContain(
      'an operator editing `sessions.json` during a stage run moves nothing the checkpoint holds, and rereading a stored digest could never observe that edit',
    );
    expect(doc).toContain(
      'When the task also carries a checkpoint whose stored `sessionBaselineDigest` differs from the live one, the component is `unknown` rather than either digest',
    );
  });

  test('the applied selection policy is the component, not the project file bytes', () => {
    expect(doc).toContain('**`selectionPolicyDigest` is the applied policy, not the project file.**');
    expect(doc).toContain(
      '#1095 invariant 10 requires a refused project file to behave exactly like an absent one; making the *file\'s* digest an identity component would break that, since two states that behave identically would compare unequal.',
    );
  });

  test('identity is used by exactly two questions and by neither the #1040 evaluator nor retention', () => {
    expect(doc).toContain(
      '#1094 §8\'s "head binding at enqueue" becomes an **identity** binding at enqueue',
    );
    expect(doc).toContain('**Not a use: operator-attested evidence.**');
    expect(doc).toContain(
      'The stage identity governs the *stage run*; it is never folded into that evaluator, and the evaluator is never re-implemented with more fields.',
    );
    expect(doc).toContain('**Not a use: retention, display and audit.**');
    expect(doc).toContain(
      'Identity restricts what evidence may *buy*, never what is *kept*',
    );
  });
});

describe(`${DOC_PATH} — §5 attribution`, () => {
  test('attribution reads typed facts and never output', () => {
    expect(doc).toContain('**Attribution is by typed facts, never by output.**');
    expect(doc).toContain(
      'No stage outcome, verdict, `notRunKind`, pin, or agent fix input is ever derived from parsing a check\'s stdout or stderr.',
    );
  });

  test('a whole-command timeout is attributed to the check and to no case', () => {
    expect(doc).toContain('**A whole-command timeout has no failing case.**');
    expect(doc).toContain(
      'the last case observed before the deadline is specifically not the cause — it is the last thing that was printed, which is a fact about output ordering and not about what hung.',
    );
    expect(doc).toContain('The retained regression entry is the check id and nothing finer (§6.5).');
    expect(doc).toContain('labelled as *observed before the deadline*, and never as the failing set.');
  });

  test('the infrastructure ban runs in both directions', () => {
    expect(doc).toContain(
      '**Infrastructure is never fabricated as code, and code is never laundered as infrastructure.**',
    );
    expect(doc).toContain(
      'The ban runs in both directions because both directions destroy the loop: one burns repair cycles on a broken host, the other hides a real failure behind a retry.',
    );
  });

  test('an unconfirmed process-tree cleanup outranks infrastructure and parks', () => {
    expect(doc).toContain(
      '**A cleanup that could not confirm termination is the one host condition that does not stop at `infrastructure`**',
    );
    expect(doc).toContain(
      "#1094 §6.1's precedence puts `unknown` above `infrastructure`, so such a run is `unknown` and takes the operator park rather than the delayed retry.",
    );
    expect(doc).toContain(
      'a host that merely failed can be retried, while a worktree with an unaccounted process in it is a question about evidence integrity, and retrying into it would produce more evidence of the same doubtful kind.',
    );
  });

  test('an absent cause is evidence-lost and attribution never crosses checks', () => {
    expect(doc).toContain('**An absent cause is `evidence-lost`, never the nearest plausible one.**');
    expect(doc).toContain('**Attribution never crosses checks.**');
    expect(doc).toContain(
      'never collapsed onto whichever check happened to be running when it hit.',
    );
  });
});

describe(`${DOC_PATH} — §6 pinned regressions`, () => {
  test('the pin record exists because id lists cannot carry attribution', () => {
    expect(doc).toContain(
      "#1094 §6.3's R2 and R6 are **id lists**, which is all a selection needs and not enough for anything else",
    );
    expect(doc).toContain('**The record is append-only.**');
    expect(doc).toContain('**The record is not a plan revision.**');
    expect(doc).toContain('**Only `checkId`, `kind` and `state` affect selection.**');
  });

  test('the purchasing-power rule is stated positively', () => {
    expect(doc).toContain(
      "A single check's `passed` verdict may buy exactly one thing: the removal of that check from the **loop**'s carried-forward selection.",
    );
    expect(doc).toContain(
      'It may never buy the release of a regression pin, the completeness of a bundle, the satisfaction of a final stage, or a grant.',
    );
  });

  test('a single PASS never releases a regression pin', () => {
    expect(doc).toContain(
      '**A regression pin is released by no pass at all, only by a complete full-set pass.**',
    );
    expect(doc).toContain(
      'Not by a loop-stage pass of that check, not by a final-stage pass of that check inside an incomplete bundle, not by a manual operator evidence entry, and not by any number of other checks passing.',
    );
    expect(doc).toContain(
      'Releasing a regression pin and granting stack-ready are therefore the same event, which is what makes "this Issue\'s last full validation failed" and "this Issue is a usable stacking base" impossible to hold at once.',
    );
  });

  test("a loop pin's release by a proving pass is justified as a different claim", () => {
    expect(doc).toContain(
      "**A loop pin's release by a proving pass is sound, and is a different claim.**",
    );
    expect(doc).toContain(
      'a loop pin gates nothing — it only widens a selection — and the final stage\'s selection is total (#1094 §4.3), so a check released from the loop still runs in full before anything is granted.',
    );
    expect(doc).toContain('**Incompleteness cannot be bought either.**');
  });

  test('the release table is exactly the four closed kinds', () => {
    const table = section('### 6.3 The release table (closed)', '### 6.4 Dormancy');
    const rows = [...table.matchAll(/^\| `(proven|final-pass|amended|terminal)` \|/gm)];
    expect(rows).toHaveLength(4);
    expect(doc).toContain('**The table is exhaustive.**');
    expect(doc).toContain(
      'No timer, no cycle count, no attempt budget, no adapter answer, no project file value, no session edit, no plan revision, no label, no ChatOps verb and no agent statement releases a pin.',
    );
  });

  test('the audited operator release releases a pin and never a check', () => {
    expect(doc).toContain('**`amended` is the only operator release, and it is narrow.**');
    expect(doc).toContain(
      'It releases a **pin**, never a check: the check stays in the plan, stays required, and still runs in every final stage',
    );
    expect(doc).toContain('**Release is never success.**');
    expect(doc).toContain('**Only a valid bundle releases.**');
    expect(doc).toContain(
      "**`admin review-verification resolve`'s evidence clearing is not a release** (#1037 §8.5).",
    );
  });

  test('an id that leaves the required set goes dormant rather than released', () => {
    expect(doc).toContain('**Leaving the required set makes a pin `dormant`, not released.**');
    expect(doc).toContain(
      '**A dormant pin re-activates when its `commandId` returns to the required set**, with its original arming record intact.',
    );
    expect(doc).toContain('**Dormancy is loud.**');
    expect(doc).toContain(
      '"Your pinned regression stopped being carried because the check left the plan" is exactly the sentence an operator needs and the one a silent intersection never produces.',
    );
  });

  test('a rename is a delete plus an add with no matching heuristic', () => {
    expect(doc).toContain(
      '**A rename is a delete and an add, and the contract refuses to guess otherwise.**',
    );
    expect(doc).toContain(
      'any heuristic that matched them (by command bytes, by name similarity) would carry one check\'s failure record onto a different check the operator never said was the same one.',
    );
    expect(doc).toContain('**The safety net is that the final stage is total.**');
    expect(doc).toContain(
      'Dormancy costs loop coverage between now and the final stage; it can never cost the gate.',
    );
  });

  test('retention is command-level and case ids are an annotation on it', () => {
    expect(doc).toContain(
      'The answer is that the command level is not a fallback; it is the contract, and case ids are an annotation on it.',
    );
    expect(doc).toContain('**The pin is always the check.**');
    expect(doc).toContain('There is no case-level pin to degrade from.');
    expect(doc).toContain(
      '**Nothing else changes**: same pin, same id, same selection consequence, same release rules.',
    );
    expect(doc).toContain('**Case detail never narrows anything.**');
  });
});

describe(`${DOC_PATH} — §7 crash, retry, amendment and recovery`, () => {
  test('the stage run id is the idempotency key and only two states are observable', () => {
    expect(doc).toContain('**`stageRunId` is the idempotency key.**');
    expect(doc).toContain('**The ordinal is allocated before launch**');
    expect(doc).toContain('**There are exactly two observable states per stage run**');
    expect(doc).toContain(
      'No state exists in which pins moved and the bundle did not, or the grant published and the bundle did not',
    );
    expect(doc).toContain('**The first state is `interrupted`.**');
    expect(doc).toContain('**The grant is at-most-once by the shipped mechanisms.**');
    expect(doc).toContain('**Retries are new runs, not resumed ones.**');
  });

  test('the #1037 claimed/running refusal is relied upon rather than duplicated', () => {
    expect(doc).toContain('**The primary guard is shipped and is relied upon.**');
    expect(doc).toContain(
      'A plan cannot change underneath an in-flight stage run through the amendment surface, and this contract adds no second guard for that case.',
    );
    expect(doc).toContain('**Session-default drift is the residual race, and identity catches it.**');
    expect(doc).toContain(
      'the stored digest is exactly the thing that provably has *not* moved when the edit lands',
    );
    expect(doc).toContain(
      'An edit that landed before launch is caught in the other direction, by the live-versus-stored divergence that makes the component `unknown` at launch.',
    );
    expect(doc).toContain('**An amendment between two stage runs is ordinary, not special.**');
    expect(doc).toContain(
      '**The window between the final stage and its publication is closed by two shipped rules together.**',
    );
    expect(doc).toContain('**A stale lease is a recovery problem, not an amendment problem.**');
  });

  test('non-code terminations are bounded consecutively without touching a repair cap', () => {
    expect(doc).toContain('**The budget counts consecutive non-code stage terminations**');
    expect(doc).toContain(
      '**resets the counter to zero**, because the run got far enough to say something about the change.',
    );
    expect(doc).toContain('**It never interacts with a repair cap.**');
    expect(doc).toContain('**It is an outer bound and never extends an inner one.**');
    expect(doc).toContain(
      'The budget can cause a park earlier than #1094 would; it can never grant a re-run #1094 withheld.',
    );
    expect(doc).toContain('**At the cap, park for the operator**');
    expect(doc).toContain('**The value is operator-owned and fail-closed.**');
    expect(doc).toContain('**No backoff policy is added.**');
    expect(doc).toContain('**Parking releases nothing and grants nothing.**');
  });

  test('operator recovery is three audited operations on runner state', () => {
    const table = section('### 7.4 Explicit operator recovery', '## 8. Compatibility and migration');
    const rows = [...table.matchAll(/^\| `stage (show|release <checkId>|reset-attempts)` \|/gm)];
    expect(rows).toHaveLength(3);
    expect(doc).toContain('**Every operation is audited**');
    expect(doc).toContain('**Every operation refuses on an active task**');
    expect(doc).toContain('**A refused operation changes nothing** and exits non-zero');
    expect(doc).toContain('**The set is closed, and the exclusions are the point.**');
    expect(doc).toContain(
      'An operator who wants a different obligation amends the **plan** (#1094 §7 rule 1); an operator who wants a fresh answer re-runs the stage.',
    );
    expect(doc).toContain('**No recovery act touches the plan.**');
  });
});

describe(`${DOC_PATH} — §8 compatibility and migration`, () => {
  test('default-off changes nothing', () => {
    expect(doc).toContain(
      '**Default off.** With `stagedVerification.enabled` absent or `false`, nothing in this document runs',
    );
  });

  test('enabling the feature migrates nothing', () => {
    expect(doc).toContain(
      '**In-flight legacy tasks: absence is the initial state, never a migration.**',
    );
    expect(doc).toContain(
      'There is **no backfill**: legacy `verificationNames`/`verificationPassed` context is never converted into a bundle, an identity, a pass or a pin',
    );
    expect(doc).toContain(
      '**Persisted evidence written before a component existed carries it as `unknown`.**',
    );
    expect(doc).toContain(
      'This is the main reason the `none`/`unknown` distinction exists.',
    );
  });

  test('an already-earned stack-ready marker is not retroactively revoked', () => {
    expect(doc).toContain(
      '**A `status:stack-ready` marker earned before the feature is not retroactively revoked.**',
    );
    expect(doc).toContain(
      'for one transition, an Issue may stack on a base that never ran a final stage.',
    );
  });

  test('Tool Requests, operator amendments and persisted evidence each have a rule', () => {
    expect(doc).toContain('**Unresolved Tool Requests.**');
    expect(doc).toContain(
      'A granted Tool Request releases no pin and makes no bundle valid.',
    );
    expect(doc).toContain('**Operator amendments in flight** — §7.2, in full.');
    expect(doc).toContain(
      '**Operator-attested evidence** keeps its shipped rule verbatim',
    );
    expect(doc).toContain('**Disabling the feature again is not a release.**');
  });

  test('the session schema gains two optional fail-closed fields only', () => {
    expect(doc).toContain(
      '**Session schema.** `stagedVerification` gains two optional fields, `maxStageRecoveryAttempts` (§7.3 rule 5) and `environmentIdentity` (§4.5), both fail-closed at load.',
    );
    expect(doc).toContain('`session.verification` is untouched.');
  });

  test('public surfaces carry states and digests and never paths or case ids', () => {
    expect(doc).toContain(
      '**component names, their three states, and digests only** — never a path, never a dirty-file name, never a command byte, never an environment value, never a prepare command.',
    );
    expect(doc).toContain(
      '`workingTreeState` in particular digests the paths **and the bytes** it covers precisely so that no surface has to be careful about them.',
    );
  });
});

describe(`${DOC_PATH} — §9–§12 mapping, invariants, matrix and scope`, () => {
  test('the implementation mapping adds no slice and reviews all twelve', () => {
    expect(doc).toContain(
      "This contract adds **no slice** to #1094 §13's twelve, and #1095 added none either.",
    );
    expect(doc).toContain(
      "what follows is the review of each against this design, as the Issue's fourth acceptance criterion requires.",
    );
    const table = section('## 9. Implementation mapping', '## 10. Invariants');
    const rows = [...table.matchAll(/^\| S\d+ — /gm)];
    expect(rows).toHaveLength(12);
  });

  test('the three sharpened predecessor statements are recorded', () => {
    expect(doc).toContain(
      'Three statements of the predecessors this contract **sharpens without changing**, recorded so a reviewer can check the claim:',
    );
    expect(doc).toContain(
      '#1094 §6.2 rule 2\'s "evidence binds to identities, not to time" keeps its meaning and gains five more identities (§4.2).',
    );
    expect(doc).toContain(
      '#1094 §8\'s "head binding at enqueue" keeps its behavior — a moved head suppresses the grant and re-queues the stage — and is generalized from one component to seven (§4.6 rule 2).',
    );
  });

  test('the invariants list is the documented twenty-one', () => {
    const invariants = section('## 10. Invariants', '## 11. Test seams and matrix');
    const numbered = invariants.split('\n').filter((line) => /^\d+\. /.test(line));
    expect(numbered).toHaveLength(21);
    expect(doc).toContain(
      '`unknown` matches nothing, including another `unknown`; `none` matches `none`. A failure to resolve is always `unknown` and never `none`, and an unimplemented or unconfigured source is always `none` and never `unknown` (§4.1, §4.4).',
    );
    expect(doc).toContain(
      "A single check's `passed` verdict buys only its removal from the loop's carried-forward selection. It never releases a regression pin, never makes a bundle complete, never satisfies a final stage and never grants (§6.2).",
    );
    expect(doc).toContain(
      'A whole-command timeout is attributed to the check and to no case; the last case observed before a deadline is specifically not the cause (§5 rule 2).',
    );
    expect(doc).toContain(
      'An id that leaves the required set goes **dormant**, not released; dormancy is recorded with its disposition, re-activates if the id returns, and a rename is treated as a delete plus an add with no matching heuristic of any kind (§6.4).',
    );
    expect(doc).toContain(
      'Enabling the feature migrates nothing: absence of stage state is the initial state, no legacy context becomes a bundle, an identity or a pin, and no existing `status:stack-ready` marker is retroactively revoked (§8 rules 2–4).',
    );
  });

  test('the test matrix names this document pin', () => {
    expect(doc).toContain(
      '`test/docs-verification-evidence-validity-contract.test.js` pins this document',
    );
  });

  test('non-goals keep a second evidence model, flake handling and audit sweeps out', () => {
    expect(doc).toContain('**A second evidence model.**');
    expect(doc).toContain(
      'The §7.3 budget bounds *non-code* terminations precisely so that it can never become a retry of a failing check.',
    );
    expect(doc).toContain('**A periodic audit scheduler or a background re-validation sweep.**');
    expect(doc).toContain(
      'A dormant pin is not a disabled check; a released pin is not a removed check.',
    );
  });
});

describe(`${DOC_PATH} — reconciliation notes in the documents it touches`, () => {
  test('docs/staged-verification-contract.md §15 records the delivery', () => {
    expect(staged).toContain(
      '**Delivered (#1096)**: `docs/verification-evidence-validity-contract.md` — the verification evidence validity, pinned regressions and recovery contract, and the chain\'s third and last design Issue.',
    );
    expect(staged).toContain(
      'a **closed seven-component evidence identity** whose components are three-valued, in which `unknown` matches nothing — including another `unknown` — while a `none` from an unconfigured source matches `none`',
    );
    expect(staged).toContain(
      'a single check\'s pass buys only its removal from the loop\'s carried-forward selection, a regression pin\'s only evidential release is the same complete, valid, full-set final pass that grants',
    );
    expect(staged).toContain(
      'it adds no stage, outcome, verdict, selection source, transition row, grant path or slice — §13\'s twelve stand, and §9\'s module table is unchanged.',
    );
  });

  test('docs/staged-verification-contract.md §13 still proposes exactly twelve slices', () => {
    const stagedRaw = readRaw('docs/staged-verification-contract.md');
    expect([...stagedRaw.matchAll(/^\| S\d+ \|/gm)]).toHaveLength(12);
    expect(staged).toContain(
      "**Reviewed against the chain's later design Issues, and still twelve.**",
    );
    expect(staged).toContain('each add content to some of these slices and **neither adds a slice**');
  });

  test('docs/project-verification-contract.md §15 records the delivery', () => {
    expect(project).toContain(
      '**Delivered (#1096)**: `docs/verification-evidence-validity-contract.md` — the verification evidence validity, pinned regressions and recovery contract, the chain\'s third design Issue.',
    );
    expect(project).toContain(
      '**The identity component is the applied selection policy, never the project file\'s bytes**',
    );
    expect(project).toContain(
      'a `timed-out` check — whose envelope §7.4 already downgrades to `partial` — attributes to the check and names no case at all, so the last case printed before a deadline can never become a pinned failure.',
    );
  });

  test('docs/verification-amendment-contract.md §17 records the delivery', () => {
    expect(amendment).toContain(
      '**Delivered (#1096)**: `docs/verification-evidence-validity-contract.md` — the verification evidence validity, pinned regressions and recovery contract, which binds a stage evidence bundle to a closed seven-component identity and gives the staged pins a lifecycle.',
    );
    expect(amendment).toContain(
      'without the baseline in the tuple, an authorized session edit would be invisible to every evidence comparison.',
    );
    expect(amendment).toContain(
      "That component reads the **live** `session.verification` layer under §6.4 rule 1's digest rule and compares it to the checkpoint's stored digest, because rule 5 re-anchors the checkpoint only at the next writing surface",
    );
    expect(amendment).toContain(
      "§7.1's unconditional `claimed`/`running` refusal is the primary in-flight guard for an amendment landing under a stage run, relied upon rather than duplicated",
    );
    expect(amendment).toContain(
      'a **pin is runner state, not a plan layer** — arming, dormancy and release create no revision, consume no `revisionOrdinal`, change no slot state and post no §12.2 comment',
    );
    expect(amendment).toContain(
      'a released pin is reported released, never passed.',
    );
  });

  test('docs/verification-execution-contract.md §16 records the delivery', () => {
    expect(execution).toContain(
      '**Delivered (#1096)**: `docs/verification-evidence-validity-contract.md` — the verification evidence validity, pinned regressions and recovery contract, the chain\'s third and last design Issue.',
    );
    expect(execution).toContain(
      'It extends §8.2 rule 3\'s identity binding from two fields to a closed seven-component identity',
    );
    expect(execution).toContain(
      'so a whole-command timeout is attributed to the **check** and to no case, and §6.3\'s ban on laundering a code failure into infrastructure is restated as running in both directions.',
    );
    expect(execution).toContain(
      'it is not a retry of a code failure and §6.3 stands.',
    );
  });

  test('docs/feature-status.md carries the third design document in the staged verification row', () => {
    expect(featureStatus).toContain('#### Staged verification (loop and final stages)');
    const idx = featureStatus.indexOf('#### Staged verification (loop and final stages)');
    const next = featureStatus.indexOf('\n#### ', idx + 1);
    const block = featureStatus.slice(idx, next === -1 ? featureStatus.length : next);
    // #1097's configuration slice moved the row off `design-only` and shipped
    // this contract's two session fields; #1102's loop stage moved it to
    // `config-gated`. Everything THIS contract specifies is still paper: no
    // identity is resolved, so no bundle is admissible for either use.
    expect(block).toMatch(/\*\*Status:\*\* `config-gated`/);
    expect(block).toContain('verification-evidence-validity-contract.md');
    expect(block).toContain('#1096');
    expect(block).toContain('test/docs-verification-evidence-validity-contract.test.js');
    const normalized = block.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      'neither #1095 nor #1096 added a slice, so six remain',
    );
    // #1099 persists an identity and a bundle, #1101 ships the selection port
    // and #1102 calls it. #1103's final stage is the first caller that RESOLVES
    // an identity and admits a bundle for both of this contract's uses, and the
    // first to bound non-code terminations. What the row must keep saying is
    // that the loop stage still does neither, and that the pin record is still
    // unwritten.
    expect(normalized).toContain(
      'only the final stage resolves an identity, so no loop bundle can satisfy a final stage or bind a grant',
    );
    // #1106 bounded the implementation lane's loop stage (§7.3's S7 counter);
    // the other loop lanes (S8) are still unbounded, and the row must say so.
    expect(normalized).toContain('there is no pin record (S5)');
    expect(normalized).toContain(
      "the implementation lane's loop stage now bounds its non-code terminations (#1106)",
    );
    expect(normalized).toContain(
      "tool-request-continuation lanes' loop verification is still re-run without a counted bound (S8).",
    );
  });

  domainTest('docs/DOMAIN.md §5 records the decided contract', () => {
    expect(domain).toContain(
      '**Verification evidence validity, pinned regressions and recovery decided (#1096)** — `docs/verification-evidence-validity-contract.md`',
    );
    expect(domain).toContain(
      '`unknown` matches nothing, **including another `unknown`**',
    );
    expect(domain).toContain(
      'That is the deliberate opposite of #916\'s "unknown evaluates as absent", because a capability and an identity fail closed in opposite directions.',
    );
    expect(domain).toContain(
      'Dependencies and environment are **declared, never sniffed**',
    );
    expect(domain).toContain(
      'a rename is treated as a delete plus an add with no matching heuristic, and exactly one audited operator act releases a pin, which is never a check.',
    );
  });
});
