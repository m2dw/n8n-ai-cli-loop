/**
 * Structural tests for docs/project-verification-contract.md (issue #1095).
 *
 * The document is the authoritative contract for the project-owned half
 * of staged verification: where a project's verification configuration
 * lives, what it may and may not say, the two independently optional
 * adapters, stable check-and-case identity, runner-owned execution
 * metadata, and the closed structured-result envelope with its explicit
 * unknown and partial states. Issue #1095 is a pure specification — no
 * production code changes with it — so these tests pin the document's
 * own claims: the three configuration locations and the authorization
 * boundary between them, the closed non-authorizing project-file
 * vocabulary and its never-contains list, the subtraction-only
 * selectability rule with its operator lower bound and its "#1094 §4.2
 * is unchanged" claim, the reconciliation with #1037's four plan
 * layers, the single fixed file location with silent absence and no
 * framework detection, the closed refusal table with its
 * ignore-the-whole-file rule and the operator-floor bound on what a
 * refusal costs, the check-is-the-verification-unit rule,
 * the case-id stability rules, the closed stage-membership set whose
 * `final-only` class every #1094 floor still reaches and whose
 * narrowing applies to a well-formed `"selected"` proposal only, the
 * runner-measured duration rule, the six envelope kinds, the
 * never-a-verdict rules including the `partial` downgrade and
 * `conflicting`, the fail-closed adapter wrappers, the
 * no-command-synthesis rule, the three worked examples, the invariants,
 * the implementation mapping that adds no slice, and the reconciliation
 * notes in docs/staged-verification-contract.md §15,
 * docs/verification-amendment-contract.md §17,
 * docs/environment-prepare-contract.md §3, docs/feature-status.md and
 * docs/DOMAIN.md §5 that land alongside it — against drift. They are
 * structural only, mirroring the doc-only pin pattern used for
 * docs/staged-verification-contract.md (#1094).
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

const DOC_PATH = 'docs/project-verification-contract.md';
const RAW = readRaw(DOC_PATH);
const doc = read(DOC_PATH);
const staged = read('docs/staged-verification-contract.md');
const amendment = read('docs/verification-amendment-contract.md');
const envPrepare = read('docs/environment-prepare-contract.md');
const featureStatus = readRaw('docs/feature-status.md');

// docs/DOMAIN.md is a PRIVATE_ONLY_PATH (copybara/copy.bara.sky): the public
// mirror never receives it, and a test that unconditionally loads it couples
// this file to material the exported tree lacks. The DOMAIN.md pins below
// therefore run only where the document exists and skip cleanly elsewhere.
const domain = existsSync(resolve(ROOT, 'docs/DOMAIN.md')) ? read('docs/DOMAIN.md') : null;
const domainTest = domain === null ? test.skip : test;

describe(`${DOC_PATH} — status, chain position, and deferrals`, () => {
  // Issue #1155 removed everything this contract specified from the
  // implementation: the project file and its reader, both adapters, the
  // structured result envelope and the group-selection session fields. The
  // document stays as the design record of the retired policy, and its status
  // line has to say so — an operator must not read it as shipped behavior.
  test('declares itself a retired design record, superseded by #1158', () => {
    expect(doc).toContain(
      'Status: **RETIRED design record — superseded by '
        + '`docs/changed-file-verification-contract.md` (#1158) and removed from '
        + 'the implementation by #1155** (issues #1095, #1097, #1098, #1155).',
    );
    expect(doc).toContain('Nothing below is implemented any more');
    expect(doc).toContain('A stage now runs the **entire required set**');
    expect(doc).toContain('This document is kept as the design record of the retired policy');
  });

  test('states the chain position as slice 2/15 with 3 design Issues', () => {
    expect(doc).toContain(
      'This is slice 2/15 of the independent **Staged Verification** chain: 3 design Issues followed by 12 implementation/validation Issues.',
    );
    expect(doc).toContain('The chain has no dependency on another active chain.');
  });

  test('ships no runtime behavior', () => {
    expect(doc).toContain('**no runtime behavior ships with it.**');
  });

  test('consumes the #1094 lifecycle verbatim and adds nothing to it', () => {
    expect(doc).toContain('Everything #1094 decided is consumed **verbatim** here');
    expect(doc).toContain(
      'This document adds no stage, no outcome, no verdict, no transition row, and no grant path.',
    );
  });

  test('is not a fifth plan layer', () => {
    expect(doc).toContain(
      "The project file is **not** a fifth plan layer and never enters §3.2's precedence (§3.5).",
    );
  });

  test('defers evidence layout and operator surfaces to the third design Issue', () => {
    expect(doc).toContain(
      "**Evidence artifact layout, event payloads, CLI output shapes and audit reporting** — the chain's third design Issue owns them (§15).",
    );
  });

  test('defers the stage lifecycle itself to #1094', () => {
    expect(doc).toContain(
      'This document never widens a floor, never adds an outcome, and never creates a path to the stack-ready grant.',
    );
  });
});

describe(`${DOC_PATH} — configuration locations and the authorization boundary`, () => {
  test('the location table names exactly three locations', () => {
    const rows = RAW.split('\n').filter((line) => /^\| (`sessions\.json`|Task amendment|`\.ai-cli-loop)/.test(line));
    expect(rows).toHaveLength(3);
  });

  test('the project file is agent-reachable and can neither authorize nor weaken', () => {
    expect(RAW).toContain(
      '| `.ai-cli-loop/verification.json` — the project verification file | Repository (and therefore the implementation agent) | **Yes** | **No** | **No** | Per Issue, with the code, in the PR |',
    );
    expect(doc).toContain(
      'the two locations an agent cannot reach are the two that can authorize, and the one an agent can reach can do neither of the dangerous things.',
    );
  });

  test('the session block is extended additively and stays fail-closed', () => {
    expect(doc).toContain(
      '`session.stagedVerification` (#1094 §5.3) is extended **additively** with the adapter declarations.',
    );
    expect(doc).toContain(
      "A session written against #1094's three-field schema still loads unchanged; every field added here is optional.",
    );
    expect(doc).toContain(
      '**Every `finalOnly` name must also appear in `selectable`**: staging a check out of the loop is a statement that the loop may omit it',
    );
    expect(doc).toContain(
      'a `finalOnly` name absent from `selectable`, an empty adapter command, and a duplicate adapter id all refuse the session.',
    );
    expect(doc).toContain('**Absent means no selection adapter**');
    expect(doc).toContain(
      'The id is what the project file may name (§4.2); the command is what only the operator may write.',
    );
  });

  test('the project file may never contain an authorizing or result-claiming value', () => {
    expect(doc).toContain('a command, an argument, a flag, a shell fragment, or an interpreter name;');
    expect(doc).toContain('a filesystem path, a glob, a URL, or an artifact location;');
    expect(doc).toContain('an environment variable, a secret, a credential, or a token;');
    expect(doc).toContain(
      'a timeout, a budget, a retry count, a concurrency value, or any other resource knob;'
    );
    expect(doc).toContain(
      'a verdict, an outcome, a result class, a pass/fail claim, or any statement about what happened in a run;',
    );
    expect(doc).toContain(
      'a statement that makes a check **selectable**, final-only, or otherwise eligible for omission.',
    );
    expect(doc).toContain(
      '**the project file may only name things the operator already authorized, and may only move verification in the direction of running more of it.**',
    );
  });
});

describe(`${DOC_PATH} — selectability is computed by subtraction`, () => {
  test('the effective selectable set has four subtractive sources', () => {
    expect(doc).toContain(
      'The effective selectable set is computed by the runner, from four subtractive sources, in this order:',
    );
    expect(doc).toContain("Start from the operator's `selectable` list");
    expect(doc).toContain('a **task-amendment-added** slot are never selectable');
    expect(doc).toContain('Subtract every check the project file pinned with `alwaysRequired: true`');
    expect(doc).toContain('Subtract every check whose structured result was `conflicting` in this task');
  });

  test('every source subtracts and none adds', () => {
    expect(doc).toContain('**Monotone in one direction.** Every source subtracts; no source adds.');
    expect(doc).toContain(
      "**Bounded below by the operator.** The effective selectable set is always a subset of the operator's `selectable` list",
    );
  });

  test('#1094 §4.2 keeps its five-set union and its floors', () => {
    expect(doc).toContain(
      'The union is still five sets; no sixth source exists, and steps 3, 4 and 5 remain floors no rule here can reach.',
    );
  });

  test('the four plan layers and their precedence are untouched', () => {
    expect(doc).toContain('**This contract adds no layer and changes no precedence.**');
    expect(doc).toContain(
      '**A project file entry for a check that is not in the plan is not an addition.** It is a refusal (§4.4).',
    );
    expect(doc).toContain(
      "**A project pin is not an amendment.** `alwaysRequired: true` does not create a revision, does not appear in the plan, does not change a slot's state",
    );
  });

  test('routine per-Issue operation edits no authorizing file', () => {
    expect(doc).toContain('### 3.6 Routine per-Issue operation touches no authorizing file');
    expect(doc).toContain(
      "made on the Issue's branch, reviewed in the Issue's PR, and reverted by reverting the commit.",
    );
  });

  test('the authorization boundary is stated without over-claiming', () => {
    expect(doc).toContain(
      '**No new authority.** An adapter runs with the authority verification commands already run with',
    );
    expect(doc).toContain(
      '**No new command class.** The set of commands that can execute is still exactly the set an operator wrote in `sessions.json`.',
    );
    expect(doc).toContain(
      '**No weakening.** Nothing an adapter returns, and nothing the project file says, can reduce the required set',
    );
  });
});

describe(`${DOC_PATH} — the project verification file`, () => {
  test('there is exactly one fixed location and no discovery', () => {
    expect(doc).toContain(
      'The file is `.ai-cli-loop/verification.json`, relative to the **root of the worktree being verified**.',
    );
    expect(doc).toContain(
      '**Exactly one location.** No search upward, no search downward, no per-directory files, no merge of several files, no environment variable override, no CLI flag, and no alternative extension.',
    );
  });

  test('absence is silent and no framework detection exists', () => {
    expect(doc).toContain(
      '**Absence is normal and silent.** No file means no project pins and no result adapters');
    expect(doc).toContain(
      '**No framework detection.** The runner never inspects the repository to guess a language, a package manager, a test framework, or a suitable adapter.',
    );
  });

  test('the worst project-file edit stays bounded by the operator and never reaches the final stage', () => {
    expect(doc).toContain(
      'never below it (§3.4), never out of the required set, and never out of the final stage, which is total by #1094 §4.3 regardless of any project input.',
    );
  });

  test('the schema vocabulary is closed at three fields', () => {
    expect(RAW).toContain(
      '| `checks.<name>.alwaysRequired` | boolean, optional | `true` pins the check out of the effective selectable set (§3.4 step 3). `false` means "no project pin" and **never grants selectability** |',
    );
    expect(RAW).toContain(
      '| `checks.<name>.result` | string, optional | An adapter id that must be a key of `session.stagedVerification.resultAdapters` |',
    );
    expect(doc).toContain(
      'That is the entire vocabulary. There is no other field, no nesting beyond this, and no extension point',
    );
  });

  test('the file is keyed on operator names, which cannot address a requirement slot', () => {
    expect(doc).toContain(
      'so a project file keyed on names cannot address a requirement slot at all',
    );
  });

  test('the refusal table is closed and refusal means ignoring the whole file', () => {
    const refusals = RAW.split('\n').filter((line) => line.includes('| Refuse the file |'));
    expect(refusals).toHaveLength(8);
    expect(doc).toContain(
      '**Refusing the file means ignoring all of it**: no partial application, no "apply the entries that parsed".',
    );
  });

  // The refusal guarantee is a floor, not a direction. Dropping an
  // `alwaysRequired: true` pin on an operator-`selectable` check hands that
  // check back to the selection adapter, so a refused file can run *less*
  // loop verification than the same file honored. The document states that
  // case outright rather than claiming a monotone that does not hold, and
  // pins the three bounds that do.
  test('refusal is bounded by the operator floor, not by a monotone direction', () => {
    expect(doc).toContain(
      '**A refused file can therefore run less loop verification than the same file honored, on exactly the checks the operator had already marked omissible.**',
    );
    expect(doc).toContain(
      'The guarantee is a floor, not a monotone direction, and it is the floor §3.4 and §4.1 already state:',
    );
    expect(doc).toContain(
      "**Never below the operator.** The effective selectable set stays a subset of the operator's `selectable` list whether the file is honored, absent, or refused",
    );
    expect(doc).toContain(
      '**Never out of the required set, never out of the final stage.** A refusal changes selection only.',
    );
    expect(doc).toContain(
      '**Never a verdict.** A refusal is an operator-facing fact: it changes no verdict, no stage outcome, no completeness flag and no transition',
    );
  });
});

describe(`${DOC_PATH} — identity, units, and stage membership`, () => {
  test('the check is the verification unit and an opaque command is a complete one', () => {
    expect(doc).toContain(
      'A check is selected whole, run whole, and judged whole. There is no partial execution of a check, no per-case selection, no per-case retention, and no per-case grant.',
    );
    expect(doc).toContain(
      '**An opaque command is a complete verification unit.** A project with no adapters, no file, and one `make verify` entry participates fully',
    );
    expect(doc).toContain('**Granularity is a configuration decision, not an adapter power.**');
    expect(doc).toContain(
      '**Cases never become checks.** No adapter output creates a check id, splits a check, or gets its own verdict, pin, regression entry or retention rule.',
    );
  });

  test('case ids are project-minted, opaque, stable and bounded', () => {
    expect(doc).toContain(
      'Core never parses it, never splits it, never infers a file, package, or framework from it, and never uses it to construct a command (§9.3).',
    );
    expect(doc).toContain(
      '**Stability.** The same logical case in the same repository state has the same id across runs, hosts and worktrees.',
    );
    expect(doc).toContain('**Uniqueness within a check.**');
    expect(doc).toContain('**Bounded.** Non-empty, at most 512 bytes.');
    expect(doc).toContain(
      '**Honest.** A project that cannot produce stable ids must not produce ids');
  });

  test('case ids and labels never reach a public surface', () => {
    expect(doc).toContain(
      'Case ids and case labels are **operator-facing and agent-facing only**. Public surfaces carry counts, never ids and never labels (§7.6)',
    );
  });

  test('stage membership is a closed three-member set', () => {
    expect(doc).toContain(
      'Stage membership is a **resolved property of a check in a task**, not a configuration field, and its set is closed:',
    );
    const rows = RAW.split('\n').filter((line) => /^\| `(always|selectable|final-only)` \|/.test(line));
    expect(rows).toHaveLength(3);
  });

  test('every #1094 floor still reaches a final-only check', () => {
    expect(doc).toContain(
      "**Where `final-only` narrows.** `final-only` removes a check from #1094 §4.2's step 1 and step 2 only, and from step 1 **only when the selection port returned a well-formed `\"selected\"` response**.",
    );
    expect(doc).toContain(
      'Steps 3, 4 and 5 — the regression set, the loop pin set, and the requirement closure — still pull a `final-only` check into a loop selection unconditionally, on both paths.',
    );
    expect(doc).toContain(
      "A `final-only` check that failed this Issue's last final stage therefore runs on every subsequent loop until a final stage clears it",
    );
  });

  // The one combination an implementation could get backwards: #1094 §4.2's
  // unknown-impact fallback contributes the entire required set, and stage
  // membership is a filter over a proposal that does not exist on that path.
  // A `finalOnly` name is omitted from a loop only when a selection adapter
  // actually answered — never because one was absent, crashed, or timed out.
  test('the unknown-impact fallback still contributes final-only checks', () => {
    expect(doc).toContain(
      '**Where it does not narrow.** The unknown-impact fallback is not a proposal to filter.',
    );
    expect(doc).toContain(
      'step 1 contributes the **entire required set, `final-only` checks included** (§8.1, §9.2). That rule is #1094 §4.2\'s own, this contract does not change it',
    );
    expect(doc).toContain(
      'it is what makes a session with `finalOnly` and no `selectionAdapter` run every required check in every loop (§8.3 row 1, §10.3).',
    );
    expect(doc).toContain(
      '| `final-only` | **Never through a `"selected"` proposal** — but the unknown-impact fallback still contributes it | Yes | **Yes** |',
    );
  });
});

describe(`${DOC_PATH} — command execution metadata`, () => {
  test('the record is runner-produced and does not copy command bytes', () => {
    expect(doc).toContain(
      '**Command bytes are not duplicated into the record.** The plan holds them; `commandDigest` binds the record to them.',
    );
    expect(doc).toContain(
      '**The record is runner-produced in full.** No field is supplied by, defaulted from, or corrected by an adapter',
    );
    expect(doc).toContain('**`selectedBy` is recorded, not inferred.**');
    expect(doc).toContain(
      '**A `req:<hex>` record has no `name` and no `structured` payload.**');
  });

  test('duration is runner-measured and never derived from adapter data', () => {
    expect(doc).toContain(
      '`durationMs` is **measured by the runner**, from immediately before the process is launched to immediately after it is reaped, using a monotonic clock.',
    );
    expect(doc).toContain(
      'A check with no launch has no `durationMs`. An accounted absence (#1094 §6.1) is not a zero-duration run',
    );
    expect(doc).toContain(
      'Case durations are never summed, never compared to the check duration, and never used to derive, correct or validate it.',
    );
  });

  test('the result classes are #1094s, unchanged and not extended', () => {
    expect(doc).toContain("The result classes are #1094's, unchanged and not extended:");
    expect(doc).toContain(
      "A case's `status` (§7.2) is a **different, smaller vocabulary about a different subject**. It never enters either set above",
    );
  });
});

describe(`${DOC_PATH} — the structured result envelope`, () => {
  test('the kind set is closed at six members with unknown and partial explicit', () => {
    const rows = RAW.split('\n').filter((line) =>
      /^\| `(complete|partial|unknown|unavailable|unreadable|conflicting)` \|/.test(line),
    );
    expect(rows).toHaveLength(6);
    expect(doc).toContain(
      '`unavailable` and `unknown` are deliberately distinct: the first says nobody was asked, the second says someone was asked and honestly could not tell.',
    );
  });

  test('a result adapter is invoked only for a failed or timed-out check', () => {
    expect(doc).toContain(
      'the check actually ran in this stage run, and its verdict is `failed` or `timed-out`.',
    );
    expect(doc).toContain(
      "The failure-only rule is deliberate: the payload's value is the failing set",
    );
  });

  test('the envelope can never be a verdict', () => {
    expect(doc).toContain(
      "The runner's verdict is authoritative, always. The envelope may add detail to it and may never change it.",
    );
    expect(doc).toContain(
      'The response has **no verdict field, no outcome field, and no pass/fail claim for the check**. The shape makes the claim inexpressible rather than merely forbidden.',
    );
    expect(doc).toContain(
      '**`complete` is downgraded to `partial` whenever the check did not run to completion**',
    );
    expect(doc).toContain(
      '**Contradiction is `conflicting`.** A `complete` envelope for a `failed` check that reports no `failed` and no `errored` case contradicts the exit code.',
    );
    expect(doc).toContain(
      'the check leaves the effective selectable set for the remainder of the task (§3.4 step 4)',
    );
    expect(doc).toContain('**No re-run, no re-classification, no "the adapter says it is flaky".**');
  });

  test('bounds truncate deterministically and keep the payload inert', () => {
    expect(doc).toContain(
      "the runner truncates deterministically — non-passing cases first, preserving the adapter's order within each status class — sets `truncated: true`, and downgrades `complete` to `partial`.",
    );
    expect(doc).toContain(
      '`totals` that disagree with the case list downgrades `complete` to `partial`.',
    );
    expect(doc).toContain(
      'The envelope is **inert on every #1094 path**: it never contributes to a verdict, an outcome, the §6.1 precedence, the completeness flag, the regression set, the loop pin set, retention, or a grant.',
    );
  });

  test('public surfaces carry counts and kinds only', () => {
    expect(doc).toContain(
      '**Public surfaces** — PR summaries, human-gate summaries and ChatOps acknowledgements carry **counts and the envelope kind only**: never a case id, never a label, never a path, never output bytes.',
    );
  });
});

describe(`${DOC_PATH} — the adapters`, () => {
  test('the selection adapter is a transport around #1094 §5.1 verbatim', () => {
    expect(doc).toContain(
      "**Its request and response bodies are that document's, verbatim**; this section fixes only the transport around them.",
    );
    expect(doc).toContain(
      '**Everything fails to `"unknown"`.** Absent adapter, non-zero exit, signal, timeout, empty stdout, non-JSON stdout, unknown `protocolVersion`, schema violation, an id outside `request.checkIds` (#1094 §5.2 rule 1) — each yields `"unknown"`',
    );
    expect(doc).toContain(
      '**Never invoked for the final stage.** #1094 §5.2 rule 5 is a transport-level rule here too',
    );
  });

  test('the selection request omits the floors and the command bytes', () => {
    expect(doc).toContain(
      'It does **not** receive command bytes, the regression set, the loop pin set, the plan, the Issue body, or session configuration.',
    );
  });

  test('a result adapter never reports on the runner verdict or its own invocation', () => {
    expect(doc).toContain(
      'The `unavailable` and `conflicting` kinds are **runner-only**: an adapter that returns either is `unreadable`.',
    );
    expect(doc).toContain(
      "An adapter says what it found (`complete`, `partial`) or that it cannot tell (`unknown`); it never reports on its own invocation or on the runner's verdict.",
    );
  });

  test('the runner passes only its own artifact path and accepts none from the project', () => {
    expect(doc).toContain(
      'The runner never accepts a path *from* the project file (§3.3), so no project input can direct a runner read.',
    );
  });

  test('adapter failure is never a check failure', () => {
    expect(doc).toContain(
      "**Failure is never a check failure.** A missing, crashing, hanging, or malformed result adapter yields `unreadable` and changes nothing about the check, the stage outcome, the bundle's completeness, or the transition.",
    );
  });

  test('the two adapters are independent and all four combinations are supported', () => {
    const rows = RAW.split('\n').filter((line) => /^\| (Absent|Present) \| (Absent|Present) \|/.test(line));
    expect(rows).toHaveLength(4);
    expect(doc).toContain(
      'There is no bundling, no implied ordering, no shared process, no shared state between them, and no requirement that a project implementing one implement the other.',
    );
  });

  test('an unknown protocol version is never read best-effort', () => {
    expect(doc).toContain(
      'A runner that reads a `protocolVersion` it does not know treats the answer as `"unknown"` (selection) or `unreadable` (result). It never attempts a partial or best-effort read of an unknown version.',
    );
  });

  test('adapter invocation adds no authority and no lock', () => {
    expect(doc).toContain(
      'Adapter invocation introduces **no** new operation class, refusal reason, grant, tier, backend or preflight plan state, and no new lock',
    );
  });
});

describe(`${DOC_PATH} — how the project's answer enters selection`, () => {
  test('incomplete or unknown answers broaden and never narrow', () => {
    expect(doc).toContain(
      'a missing adapter, a refusal, a crash, a timeout, malformed output, an unknown protocol version, an out-of-request id, or an explicit `"unknown"` all make step 1 contribute the **entire required set**.',
    );
    expect(doc).toContain(
      '**"Entire" includes `final-only` checks**: stage membership is a filter over a well-formed `"selected"` proposal (§5.4), and there is no proposal to filter on this path',
    );
    expect(doc).toContain(
      "#1094 §4.2's unknown-impact rule then runs the **full** required set, `final-only` checks included (§5.4). Stage membership filters a `\"selected\"` proposal, never this fallback.",
    );
    expect(doc).toContain(
      'an envelope that is `partial`, `unknown`, `unreadable` or `conflicting` yields less *detail*, never less *verification*',
    );
  });

  test('the runner never synthesizes a command, for two stated reasons', () => {
    expect(doc).toContain(
      "The runner executes the operator's command bytes, unmodified, for every check it runs. It never appends a filter, a test-name pattern, a shard index, a path list, or any other argument derived from a selection response, a case id, a structured result, a change path, or a project file.",
    );
    expect(doc).toContain(
      "**Authorization.** A command assembled from adapter output is a command the operator never wrote, executed with the runner's authority.",
    );
    expect(doc).toContain(
      "**Evidence.** A check's identity and digest bind its evidence (#1094 §6.2 rule 2).",
    );
    expect(doc).toContain(
      'A project that wants a narrower command writes a narrower `session.verification` entry (§5.1).',
    );
  });
});

describe(`${DOC_PATH} — worked examples`, () => {
  test('covers this TypeScript repository, a non-TypeScript project, and an un-adapted one', () => {
    expect(doc).toContain('### 10.1 This repository — TypeScript with Jest');
    expect(doc).toContain('### 10.2 A Go module — non-TypeScript, same core contract');
    expect(doc).toContain('### 10.3 A project with opaque commands and no adapter');
    expect(doc).toContain('The same core contract, three projects, one of them not TypeScript and one of them with no adapter at all.');
  });

  test('the TypeScript example pins a check back out of the operator selectable list', () => {
    expect(doc).toContain('"resultAdapters": { "jest-v1": "node scripts/loop-jest-result.mjs" },');
    expect(doc).toContain(
      'Resolved membership: `exec:typecheck` is `always` — the operator listed it as selectable, and the project pinned it back',
    );
    expect(doc).toContain(
      'the final stage runs `typecheck`, `test` and `package` — the whole required set, no adapter consulted',
    );
  });

  test('the Go example uses the same core contract with its own ids and a final-only suite', () => {
    expect(doc).toContain('"selectable": ["test", "e2e"], "finalOnly": ["e2e"],');
    expect(doc).toContain('"resultAdapters": { "gotest-v1": "go run ./tools/looptestresult" },');
    expect(doc).toContain('`github.com/acme/svc/internal/billing.TestRounding`');
    expect(doc).toContain(
      '**A build is a check like any other.** `exec:build` is pinned always-required because in a compiled language a build failure makes every other check meaningless. That is a project judgment expressed in the project file, not a special case in core.',
    );
    expect(doc).toContain(
      "**Truncation is normal here.** A large `go test -json` stream can exceed the runner's bounded log capture.",
    );
    expect(doc).toContain(
      'on a cycle where `go run ./tools/loopselect` fails to build, crashes, or overruns its 30 s budget, the selection reads `"unknown"` and that loop runs the entire required set — `exec:e2e` with it (§9.2).',
    );
  });

  test('the un-adapted example gets the whole of #1094 with two commands and one flag', () => {
    expect(doc).toContain(
      '`make verify` is a single verification unit: one command, one verdict, one entry in the bundle, no cases, `structured: { kind: "unavailable" }`.',
    );
    expect(doc).toContain(
      "That is the design's floor, and it is deliberately the same floor an un-adapted TypeScript repository gets.",
    );
  });
});

describe(`${DOC_PATH} — compatibility, invariants, and scope`, () => {
  test('default-off leaves behavior exactly as today', () => {
    expect(doc).toContain(
      '**Default off.** With `stagedVerification.enabled` absent or `false`, nothing here runs: no file is read, no adapter is spawned',
    );
    expect(doc).toContain(
      '**Session schema.** `session.verification` is untouched. `stagedVerification` gains optional fields only',
    );
  });

  test('the invariants list is the documented fifteen', () => {
    const section = RAW.slice(RAW.indexOf('\n## 12. Invariants'), RAW.indexOf('\n## 13. Implementation mapping'));
    const numbered = section.split('\n').filter((line) => /^\d+\. /.test(line));
    expect(numbered).toHaveLength(15);
    expect(doc).toContain(
      'The verification unit is the check. Cases are optional detail and never become checks, selections, pins, regressions, retention units, or grants (§5.1, §5.2).',
    );
    expect(doc).toContain(
      "Selectability is computed by subtraction only, and the effective selectable set is always a subset of the operator's `selectable` list.",
    );
    expect(doc).toContain(
      'The runner never synthesizes or modifies a command. No selection response, case id, structured result, change path, or project file contributes a byte to what executes (§9.3).',
    );
    expect(doc).toContain(
      'No framework detection exists. An unconfigured project runs opaque commands as complete verification units, and an opaque command is a supported first-class configuration, not a degraded one',
    );
    expect(doc).toContain(
      '`final-only` removes a check from the always-required step and from a well-formed `"selected"` proposal only; every #1094 floor still reaches it, and so does the unknown-impact fallback, which contributes the entire required set including `final-only` checks (§5.4, §9.2).',
    );
    expect(doc).toContain(
      "A refused project file is ignored in full, never applied in part, and the result is exactly the file's absence: never below the operator's own `selectable` bound, never out of the required set, never out of the final stage, and never a verdict — a dropped `alwaysRequired` pin may still cost one loop cycle's coverage of a check the operator already staged as omissible (§4.1, §4.4).",
    );
  });

  test('the implementation mapping adds no slice to the twelve', () => {
    expect(doc).toContain("This contract adds **no slice** to #1094 §13's twelve.");
  });

  test('the test matrix names this document pin', () => {
    expect(doc).toContain('`test/docs-project-verification-contract.test.js` pins this document');
  });

  test('non-goals keep packaging, detection, and per-case selection out', () => {
    expect(doc).toContain(
      '**Adapter packaging, distribution, or a registry.** An adapter is a command the operator named.',
    );
    expect(doc).toContain(
      '**Per-case selection, sharding, or test splitting.** The check is the unit (§5.1), and command synthesis is forbidden (§9.3).',
    );
  });
});

describe(`${DOC_PATH} — reconciliation notes in the documents it touches`, () => {
  test('docs/staged-verification-contract.md §15 records the delivery', () => {
    expect(staged).toContain(
      '**Delivered (#1095)**: `docs/project-verification-contract.md` — the project verification configuration and adapter contract',
    );
    expect(staged).toContain(
      "It supplies the **effective selectable set** §4.2 step 2 consumes — computed by subtraction only, always a subset of the operator's `selectable` list",
    );
    expect(staged).toContain(
      "§5.1's request and response bodies are consumed verbatim; only the transport around them is new.",
    );
    expect(staged).toContain(
      'The one membership class it adds, the operator-owned `final-only`, is still reached by every floor in §4.2 steps 3, 4 and 5, and it filters step 1\'s `"selected"` proposal only: §4.2\'s unknown-impact fallback is untouched and still contributes the entire required set, `final-only` checks included.',
    );
  });

  // The amendment contract owns the four plan layers and their precedence, so
  // it is where a new configuration location has to be reconciled — otherwise
  // a reader of §3 could take the project file for a fifth layer.
  test('docs/verification-amendment-contract.md §17 records that no fifth layer appears', () => {
    expect(amendment).toContain(
      '**Delivered (#1095)**: `docs/project-verification-contract.md` — the project verification configuration and adapter contract',
    );
    expect(amendment).toContain('**without adding a fifth layer**');
    expect(amendment).toContain(
      'the project file is not a value in the plan, never overlays a slot, and answers only "which of the already-required checks does this loop run?"',
    );
    expect(amendment).toContain(
      'a pin creates no revision and survives into no other task',
    );
  });

  // The environment-prepare contract owns verification ownership and session
  // configuration (§3.1–§3.3), so it is where a new configuration location has
  // to be reconciled — otherwise a reader of that section could conclude the
  // project file is a second place commands may be authored.
  test('docs/environment-prepare-contract.md §3 records the non-authorizing project file', () => {
    expect(envPrepare).toContain('**Extended by #1095.**');
    expect(envPrepare).toContain(
      'It weakens no rule in §3.1–§3.3: **the project verification file is non-authorizing**',
    );
    expect(envPrepare).toContain(
      "Command bytes stay `session.verification`'s alone, and the runner never synthesizes a command from adapter output.",
    );
  });

  test('docs/feature-status.md keeps the staged verification row gated and names #1095', () => {
    const idx = featureStatus.indexOf('#### Staged verification (loop and final stages)');
    expect(idx).toBeGreaterThan(-1);
    const next = featureStatus.indexOf('\n#### ', idx + 1);
    const block = featureStatus.slice(idx, next === -1 ? featureStatus.length : next);
    // #1097 moved the row off `design-only` by shipping the configuration
    // slice, and #1102's loop stage moved it to `config-gated`; what this
    // contract itself describes is still short of an end-to-end path — no
    // project adapter ships, so an enabled session with no `selectionAdapter`
    // runs exactly what it ran before.
    expect(block).toMatch(/\*\*Status:\*\* `config-gated`/);
    expect(block).toContain('project-verification-contract.md');
    expect(block).toContain('#1095');
    // What #1095 pins is that its own landing added no
    // implementation/validation slice to the count.
    expect(block.replace(/\s+/g, ' ')).toContain(
      'neither #1095 nor #1096 added a slice, so six remain',
    );
  });

  domainTest('docs/DOMAIN.md §5 records the decided contract', () => {
    expect(domain).toContain(
      '**Project verification configuration and adapter contracts decided (#1095)** — `docs/project-verification-contract.md`',
    );
    expect(domain).toContain(
      "the repository's own `.ai-cli-loop/verification.json` is reachable by an agent and can do neither",
    );
    expect(domain).toContain(
      'no sixth source joins its five-set union, and the regression, pin and requirement-closure floors stay out of reach',
    );
    expect(domain).toContain(
      "A refused file is ignored in full, never in part, and the guarantee that gives is a floor rather than a direction: dropping an always-required pin can cost one loop cycle's coverage of a check the operator already staged as omissible, but never reaches below the operator's own `selectable` list, out of the required set, out of the total final stage, or into a verdict.",
    );
    expect(domain).toContain(
      "selection failures run the full required set — including the operator's `final-only` checks, since membership filters a well-formed proposal and there is none on that path",
    );
    expect(domain).toContain(
      "withdrawing that check's selectability for the task rather than moving verdict authority into repository-writable code",
    );
    expect(domain).toContain("Document-only: it adds no slice to #1094's twelve.");
  });
});
