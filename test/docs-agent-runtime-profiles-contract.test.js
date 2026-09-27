/**
 * Structural tests for docs/agent-runtime-profiles-contract.md (issue #903).
 *
 * The document is the authoritative contract for how a phase run resolves the
 * concrete runtime settings of the agent that owns it. Issue #903 is a pure
 * specification: no production code changes with it, so these tests pin the
 * document's own claims — the four provider-neutral quality levels and their
 * ordering, the provider-centric (never phase-specific) catalog shape, the
 * capability descriptors that turn provider ceilings into data, the declared
 * shared binding that is explicitly not a downgrade, the storage split from
 * sessions.json, the partial-overlay merge rules, both precedence chains, the
 * compatibility mapping from the complexity and review label families, the
 * reload timing
 * asymmetry, the closed refusal set, the audit record, the no-model-names-in-
 * TypeScript-unions rule, and the follow-up slices — against drift. They also
 * pin the reconciliation that lands alongside in docs/feature-status.md,
 * docs/assignment-profiles.md, docs/phase-contracts.md, and
 * docs/provider-architecture.md. They are structural only, mirroring the
 * doc-only pin pattern used for
 * docs/single-host-platform-sandbox-contract.md (#916).
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Assertions run against a whitespace-normalized copy: the document is
// hard-wrapped prose, so a claim can straddle a line break today and be
// reflowed tomorrow. Normalizing means these tests pin what the document
// says, not how it happens to be wrapped.
function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8').replace(/\s+/g, ' ');
}

const DOC_PATH = 'docs/agent-runtime-profiles-contract.md';
const doc = read(DOC_PATH);
const featureStatus = read('docs/feature-status.md');
const assignment = read('docs/assignment-profiles.md');
const phases = read('docs/phase-contracts.md');
const providerArch = read('docs/provider-architecture.md');

describe(`${DOC_PATH} — status and scope`, () => {
  test('is marked approved design with B1–B2 implemented, B3’s boundary plus all three provider adapters, and B4’s audit record landed', () => {
    expect(doc).toMatch(
      /Status: \*\*approved design; slices B1–B2 implemented, B3's adapter boundary, all three provider adapters, and the write-capable lane cutover landed, B4's audit record landed\*\* \(issues #903, #904, #905, #906, #907, #908, #909, #910, #911\)/,
    );
  });

  test('the write-capable lanes resolve through the contract; the read-side lanes do not yet', () => {
    expect(doc).toMatch(
      /\*\*The write-capable lanes resolve through this contract; the read-side lanes do not yet\.\*\*/,
    );
    expect(doc).toMatch(/Issue #903 wrote this document and changed no source file\./);
    expect(doc).toMatch(
      /Issue #904 landed slice B1 .* in `src\/core\/agent-profile-catalog\.ts` .* as a pure core module no handler reads/,
    );
    expect(doc).toMatch(
      /Issue #905 landed slice B2 .* in `src\/core\/agent-quality\.ts` — as one shared resolver that consults no provider and no capability/,
    );
    expect(doc).toMatch(
      /Issue #906 landed slice B3's boundary .* in `src\/core\/agent-runtime-adapter\.ts` — as a typed seam with no provider adapter registered and no lane wired through it/,
    );
    expect(doc).toMatch(
      /Issue #907 landed slice B3's first provider adapter — the `anthropic` entry serving the Claude CLI, in `src\/core\/claude-runtime-adapter\.ts` — as a pure module a composition root can register but no lane calls, so a resolved profile still becomes no argv any lane runs/,
    );
    expect(doc).toMatch(
      /Issue #908 landed slice B3's second provider adapter — the `openai` entry serving the Codex CLI, in `src\/core\/codex-runtime-adapter\.ts` — on the same terms/,
    );
    // The retirement §1.2 consequence 1 asked for: the ceiling is the
    // descriptor's list, not a fact restated in source.
    expect(doc).toMatch(
      /the obsolete assumption that this provider's reasoning effort stops at the third of three tiers/,
    );
    expect(doc).toMatch(
      /Issue #909 landed slice B3's third and last provider adapter — the `google` entry serving the Gemini\/Antigravity \(`agy`\) CLI, in `src\/core\/antigravity-runtime-adapter\.ts` — on the same terms/,
    );
    // The provider-neutrality this slice has to protect: no shared code may
    // assume this provider carries an effort field at all.
    expect(doc).toMatch(
      /the adapter requires no effort setting, emits no effort flag, and refuses one that resolved, so no shared code assumes this provider speaks another's effort vocabulary/,
    );
    // B4's record landed with the same property: it is a projection with no
    // producer, so observability arrived without any lane changing.
    expect(doc).toMatch(
      /Issue #910 landed slice B4's audit record — the §13 metadata every billable run leaves behind, in `src\/core\/agent-runtime-audit\.ts` — as ONE provider-neutral record shape built by a single projection from a resolution, so the same fields are emitted for Claude, Codex, and Gemini\/Antigravity and only the absent values differ; it persists nothing itself, and with no lane resolving through the boundary yet no run produces a record/,
    );
    // The write-capable cutover is stated, and the not-yet-cut-over remainder
    // keeps the pre-cutover reading for its own lanes only.
    expect(doc).toMatch(
      /Issue #911 then cut the write-capable lanes over: `implementation` \(all three providers, both orchestration modes including fix\/requeue\) and `conflict_resolution` now resolve their invocation through the boundary, delete their §1\.2 chains, and persist a §13 record per attempt/,
    );
    expect(doc).toMatch(/there a persisted quality request changes no invocation/);
    expect(doc).toMatch(
      /for those lanes this document still describes the target, not the tree/,
    );
  });

  test('defers to the contracts it consumes rather than redefining them', () => {
    expect(doc).toMatch(/\*\*Which agent owns which phase\*\* — fixed by \[assignment-profiles\.md\]/);
    expect(doc).toMatch(/\*\*The per-phase behavioral contract\*\* — fixed by \[phase-contracts\.md\]/);
    expect(doc).toMatch(/it never names, holds, or resolves a credential/);
    expect(doc).toMatch(/A profile is a cost\/capability selection, never an authorization\./);
  });

  test('names its own docs pin', () => {
    expect(doc).toMatch(/test\/docs-agent-runtime-profiles-contract\.test\.js/);
  });
});

describe(`${DOC_PATH} — the four quality levels (§5)`, () => {
  test('the vocabulary is exactly light, normal, strong, maximum', () => {
    expect(doc).toMatch(
      /four provider-neutral values `light`, `normal`, `strong`, `maximum`/,
    );
  });

  test('the levels are ordered', () => {
    expect(doc).toMatch(/light < normal < strong < maximum/);
  });

  test('a quality level never names a model or an effort value', () => {
    expect(doc).toMatch(/\*\*A quality level never names a model or an effort value\.\*\*/);
    expect(doc).toMatch(/`maximum` is not `xhigh`; `normal` is not `medium`/);
  });

  test('the ordering is within a provider, not across providers', () => {
    expect(doc).toMatch(/\*\*The ordering is within a provider, not across providers\.\*\*/);
    expect(doc).toMatch(/makes no claim that they are equivalent, equally expensive, or comparable/);
  });

  test('a level is a request and a binding is the answer', () => {
    expect(doc).toMatch(/\*\*A level is a request; a binding is the answer\.\*\*/);
  });
});

describe(`${DOC_PATH} — ownership stays split from assignment (§4)`, () => {
  test('assignment profiles select the agent and never its runtime settings', () => {
    expect(doc).toMatch(
      /\*\*assignment profiles select the agent and never its runtime settings\.\*\*/,
    );
    expect(doc).toMatch(
      /MUST NOT gain a `model`, `effort`, `budget`, `quality`, or `profile` field/,
    );
    expect(doc).toMatch(/joined by exactly one value — the resolved agent id/);
  });

  test('the #694 source-of-truth rules survive verbatim', () => {
    expect(doc).toMatch(/`context\.assignment` is authoritative/);
    expect(doc).toMatch(/survives? verbatim/);
  });

  test('the matrix is provider by quality, never phase-specific', () => {
    expect(doc).toMatch(/\*\*No phase-specific model profiles\*\* \(a stated non-goal\)/);
    expect(doc).toMatch(
      /the catalog schema has no phase key to select one with/,
    );
  });
});

describe(`${DOC_PATH} — the provider catalog (§6)`, () => {
  test('the illustrative values are not a permanent model recommendation', () => {
    expect(doc).toMatch(
      /the values shown are illustrative and MUST NOT be read as a permanent model recommendation/,
    );
  });

  test('an omitted setting is an absence, never a model named "default"', () => {
    expect(doc).toMatch(/\*\*Every setting field is optional\.\*\*/);
    expect(doc).toMatch(/Omission is recorded as an absence \(§13\.3\), never as a model named `"default"`/);
  });

  test('capability descriptors turn provider ceilings into data', () => {
    expect(doc).toMatch(/### 6\.2 Capability descriptors make ceilings data/);
    expect(doc).toMatch(/`"effort": \["low", "medium", "high"\]` in the catalog/);
    expect(doc).toMatch(
      /a data edit, with no source change, no new TypeScript union member, and no release/,
    );
    expect(doc).toMatch(/a profile that sets `effort` under `google` is rejected at load rather than silently ignored/);
  });

  test('model names are always free and never discovered by the loop', () => {
    expect(doc).toMatch(/Model names are always `"free"`\./);
    expect(doc).toMatch(
      /never maintains a list of valid model names, never normalizes or aliases one, and never asks a provider for one/,
    );
  });

  test('a shared binding is declared configuration, not a silent downgrade', () => {
    expect(doc).toMatch(/### 6\.3 Two levels may bind to the same profile — declared, never silent/);
    expect(doc).toMatch(/\*\*explicitly permitted and is not a downgrade\*\*/);
    expect(doc).toMatch(/Contrast this with what remains forbidden: \*\*a runtime clamp\*\*/);
    expect(doc).toMatch(
      /"Declared equality at configuration time" and "silent substitution at run time" are different things, and only the first is allowed/,
    );
  });

  test('every quality level must be bound, with no nearest-lower fallback', () => {
    expect(doc).toMatch(/all four quality levels MUST resolve to a declared profile/);
    expect(doc).toMatch(
      /There is no fallback level, no "nearest lower binding", and no inheritance from another provider/,
    );
  });

  test('the three providers expose different concrete capabilities behind the same levels', () => {
    expect(doc).toMatch(/\*\*Anthropic\*\* — `--model <model> --effort <effort>`/);
    expect(doc).toMatch(/spliced as a \*global\* option before the `exec`\/`review` subcommand/);
    expect(doc).toMatch(/\*\*Google\/Antigravity\*\* — `<binary> --print`/);
    expect(doc).toMatch(/Antigravity folds effort into the model display name/);
  });
});

describe(`${DOC_PATH} — adapters own the invocation (§7)`, () => {
  test('a setting a lane cannot express is recorded, never silently dropped', () => {
    expect(doc).toMatch(
      /\*\*A setting the lane cannot express is recorded as not applicable, never dropped in silence\.\*\*/,
    );
    expect(doc).toMatch(/`budgetApplied: "not-applicable"`/);
  });

  test('an adapter never re-derives a setting', () => {
    expect(doc).toMatch(/\*\*An adapter never re-derives a setting\.\*\*/);
    expect(doc).toMatch(/it does not consult labels, the session, or a default of its own/);
    expect(doc).toMatch(/the per-lane default chains inventoried in §1\.2 are deleted, not layered under/);
  });

  test('§7.1 fixes the common boundary: fail-closed registry, one resolution engine, sanitation gate', () => {
    expect(doc).toMatch(/### 7\.1 The common boundary the adapters plug into/);
    expect(doc).toMatch(/\*\*A provider registry that fails closed\.\*\*/);
    expect(doc).toMatch(
      /including one the shipped fail-open mapping echoes back as its own provider — refuses \(`unknown-provider`\) rather than resolving to a settings-free invocation/,
    );
    expect(doc).toMatch(/\*\*One shared §8\.1 resolution engine\.\*\*/);
    expect(doc).toMatch(
      /every override validated against the capability descriptors before any billable invocation \(`invalid-override`, `unknown-profile`\)/,
    );
    expect(doc).toMatch(/\*\*A sanitation gate over the invocation data\.\*\*/);
    expect(doc).toMatch(
      /prompt reaches the CLI verbatim on the channel the plan declares — stdin where a lane requires it today/,
    );
    expect(doc).toMatch(/\*\*A typed configuration\/transient split\.\*\*/);
    expect(doc).toMatch(
      /a transiently unprobeable CLI is `indeterminate`, never recorded as unavailable/,
    );
    expect(doc).toMatch(/The boundary is pure and spawns nothing/);
    expect(doc).toMatch(/each lane can migrate onto an adapter one cutover at a time, with no flag day/);
  });

  test('§7.2 fixes the Claude adapter: break-glass variables, lane table, declared asymmetry', () => {
    expect(doc).toMatch(/### 7\.2 The Claude adapter/);
    expect(doc).toMatch(
      /`src\/core\/claude-runtime-adapter\.ts`, serving the catalog's `anthropic` key/,
    );
    expect(doc).toMatch(/\*\*The break-glass variables\.\*\*/);
    expect(doc).toMatch(
      /`CLAUDE_MODEL`, `CLAUDE_EFFORT`, and `CLAUDE_MAX_BUDGET_USD` keep their §1\.2 meaning and their §8\.1 layer-1 precedence/,
    );
    // No ambient binary override: a different executable is a validated catalog
    // setting, never a trusted environment variable.
    expect(doc).toMatch(/There is deliberately \*\*no binary override\*\*/);
    expect(doc).toMatch(/\*\*A lane table, as data\.\*\*/);
    expect(doc).toMatch(
      /Four lanes are served — `implementation`, `conflict_resolution`, `review`, and `no_tools`/,
    );
    expect(doc).toMatch(/\*\*Those are properties of the lane, never of a profile\*\*/);
    expect(doc).toMatch(
      /no catalog edit can add a permission mode, widen an allowlist, or dissolve the read-only boundary/,
    );
    expect(doc).toMatch(/\*\*The §7 rule-1 asymmetry, declared\.\*\*/);
    expect(doc).toMatch(/\*\*A pre-invocation validation pass\.\*\*/);
    expect(doc).toMatch(/Every lane delivers its prompt on \*\*stdin\*\*, verbatim/);
    expect(doc).toMatch(
      /The adapter names no model and no effort value anywhere in its source \(§14\.3\)/,
    );
    // The write-capable lanes call this adapter since #911; the one remaining
    // Claude difference is named here, so it is not discovered when the review
    // lane is finally switched over.
    expect(doc).toMatch(
      /since issue #911, called by the write-capable lanes \(`implementation`, `conflict_resolution`\)/,
    );
    expect(doc).toMatch(
      /one difference remains, owed to the review cutover: an explicit `review:medium` \(§9\.2 divergence 1\)/,
    );
    expect(doc).toMatch(
      /it belongs to the cutover that documents it, not to the adapter that makes it expressible/,
    );
  });

  test('§7.3 fixes the Codex adapter: break-glass variables, lane table, ordering rule', () => {
    expect(doc).toMatch(/### 7\.3 The Codex adapter/);
    expect(doc).toMatch(
      /`src\/core\/codex-runtime-adapter\.ts`, serving the catalog's `openai` key/,
    );
    expect(doc).toMatch(
      /`CODEX_MODEL` and `CODEX_EFFORT` keep their §1\.2 meaning and their §8\.1 layer-1 precedence/,
    );
    // Same stance as §7.2 for the binary, plus the budget asymmetry this
    // provider has on EVERY lane rather than on some of them.
    expect(doc).toMatch(/There is deliberately \*\*no binary override\*\*/);
    expect(doc).toMatch(
      /\*\*no budget variable\*\*: the Codex CLI has no per-run budget cap flag on any lane/,
    );
    expect(doc).toMatch(/\*\*A lane table, as data\.\*\*/);
    expect(doc).toMatch(
      /Four lanes are served — `implementation` \(`codex exec`\), `review` \(`codex review --base <branch>`\), `structured_exec` .*, and `read_bounded`/,
    );
    expect(doc).toMatch(/\*\*Those are properties of the lane, never of a profile\*\*/);
    expect(doc).toMatch(
      /no catalog edit can drop a `--sandbox` pin, add an output path a lane does not read, or widen a read-bounded lane/,
    );
    // The read-only sandbox is never relabelled as a no-tools boundary.
    expect(doc).toMatch(
      /`--sandbox read-only` is never a no-tools boundary — it bounds writes and network while leaving reads available/,
    );
    expect(doc).toMatch(/\*\*One argument-ordering rule, applied once\.\*\*/);
    expect(doc).toMatch(
      /`--model` and `--profile` are GLOBAL Codex options and precede the subcommand; `-c` overrides follow it/,
    );
    expect(doc).toMatch(/\*\*Context-mode stays operator-supplied \(#376\)\.\*\*/);
    // An operator's context-mode form sits below the break-glass ladder: it may
    // not reach a setting the adapter resolves and emits.
    expect(doc).toMatch(
      /A context-mode `-c` entry naming a setting the adapter itself emits — the model or the reasoning effort — refuses too/,
    );
    expect(doc).toMatch(
      /honoring one would let an unvalidated value silently replace the resolved, capability-checked one from below the §8\.1 ladder/,
    );
    expect(doc).toMatch(/\*\*A pre-invocation validation pass\.\*\*/);
    // A path is not a token: its spaces are characters of a valid path.
    expect(doc).toMatch(
      /a run-owned output path is its own argv element and is preserved verbatim, spaces and all, rather than trimmed or refused/,
    );
    expect(doc).toMatch(/Every lane delivers its prompt on \*\*stdin\*\*, verbatim/);
    // The point of the slice: the ceiling is data, and nothing clamps.
    expect(doc).toMatch(
      /\*\*names no model and no reasoning-effort value anywhere in its source\*\* \(§14\.3\), and — the point of this slice — \*\*it never clamps\*\*/,
    );
    expect(doc).toMatch(
      /an installation whose Codex\/model combination accepts a stronger tier declares that value in its capability descriptor and binds a quality level to it/,
    );
    expect(doc).toMatch(
      /Discovery reports the installed CLI's version, and the resolution reports the effective model and effort with each value's own source \(§13\.2\)/,
    );
    // The implementation lane is cut over (#911); what remains is the review
    // cutover's own difference, still named so it is not discovered later.
    expect(doc).toMatch(/The implementation lane is cut over \(issue #911, §10\.4\)/);
    expect(doc).toMatch(/the built-in `normal` binding now targets `codex-high`/);
    expect(doc).toMatch(
      /the review cutover's own difference, an explicit `review:medium` \(§9\.2 divergence 2\)/,
    );
  });

  test('§7.4 fixes the Gemini/Antigravity adapter: binary break-glass, one shape, two transports', () => {
    expect(doc).toMatch(/### 7\.4 The Gemini\/Antigravity adapter/);
    expect(doc).toMatch(
      /`src\/core\/antigravity-runtime-adapter\.ts`, serving the catalog's `google` key/,
    );
    // The one provider whose inventoried variable names the binary — stated
    // together with why §7.2 and §7.3 decline the same override.
    expect(doc).toMatch(/`ANTIGRAVITY_BIN` keeps its §1\.2 meaning and its §8\.1 layer-1 precedence/);
    expect(doc).toMatch(
      /the one provider whose inventoried variable names the \*\*binary\*\* rather than a model or an effort/,
    );
    expect(doc).toMatch(/\*\*no model variable and no effort variable\*\*/);
    // `--print` must have a value, which is why it is last and why a promptless
    // invocation is not expressible.
    expect(doc).toMatch(
      /`<binary> \[--model M\] \[--print-timeout T\] --print <operand>`/,
    );
    expect(doc).toMatch(/it is a flag that \*\*must have a value\*\*/);
    expect(doc).toMatch(
      /An invocation with no prompt is therefore not expressible at all, and refuses/,
    );
    expect(doc).toMatch(/\*\*A lane table, as data\.\*\*/);
    expect(doc).toMatch(
      /Five lanes are served — `implementation`, `review`, `research`, `content_draft`, and `content_review`/,
    );
    // Both prompt channels by default, because a stdin-only delivery can fail
    // silently on builds that ignore stdin.
    expect(doc).toMatch(/\*\*Two prompt transports, and which lane may ask for which\.\*\*/);
    expect(doc).toMatch(
      /some `agy` builds read the prompt only from the operand and ignore stdin, so a stdin-only delivery would silently run the phase on no prompt at all/,
    );
    expect(doc).toMatch(/\*\*That is a property of the lane, never of a profile\*\*/);
    // The reason this provider needs no effort field at all.
    expect(doc).toMatch(/\*\*Effort as a provider fact, declared once\.\*\*/);
    expect(doc).toMatch(
      /this provider folds the tier into the model \*\*display name\*\* — one model string, not a model plus a tier/,
    );
    expect(doc).toMatch(
      /An effort that somehow resolved .* \*\*refuses\*\* rather than being dropped in silence/,
    );
    expect(doc).toMatch(
      /a display name legitimately carries plain spaces and parentheses, and only what would stop naming a model at all is refused/,
    );
    expect(doc).toMatch(/\*\*The `printTimeout` provider option\.\*\*/);
    // The acceptance criterion this slice turns on: the two probes are separate
    // questions with separate vocabularies.
    expect(doc).toMatch(/\*\*Capability discovery that cannot be mistaken for availability\.\*\*/);
    expect(doc).toMatch(/\*\*the only probe that may answer `unavailable`\*\*/);
    expect(doc).toMatch(
      /reports in its own vocabulary — `listed`, `undiscovered`, `indeterminate`/,
    );
    expect(doc).toMatch(
      /is recorded as a capability this loop could not read and \*\*never\*\* as a missing agent/,
    );
    expect(doc).toMatch(/Neither probe feeds the catalog \(§11\.3\)/);
    expect(doc).toMatch(/\*\*names no model anywhere in its source\*\* \(§14\.3\)/);
    // The implementation lane is cut over (#911) and now passes the timeout;
    // the read-side lanes gain it at their own cutover.
    expect(doc).toMatch(
      /every built-in `google` profile carries a `printTimeout`, so that lane now passes `--print-timeout 15m`/,
    );
    expect(doc).toMatch(
      /The read-side lanes that pass none today gain the same flag at their own cutover/,
    );
  });
});

describe(`${DOC_PATH} — precedence (§8)`, () => {
  test('env overrides are field-level break-glass and pins are profile-level', () => {
    expect(doc).toMatch(/Layer 1 is \*\*field-level and break-glass\*\*/);
    expect(doc).toMatch(/Layers 2–5 are \*\*profile-level\*\*/);
    expect(doc).toMatch(/a pinned profile's omitted field stays omitted/);
  });

  test('pins name a profile, never a raw model string', () => {
    expect(doc).toMatch(/Layers 2 and 3 name a \*profile\*, never a raw model string/);
  });

  test('the quality precedence puts task pin above labels above session default', () => {
    expect(doc).toMatch(/\| 1 \| Task pin set by an explicit operator command \| `task-pin` \|/);
    expect(doc).toMatch(/\| 2 \| Trusted `quality:<level>` label \| `label` \|/);
    expect(doc).toMatch(
      /\| 3 \| Compatibility labels — `complexity:\*` \/ `review:\*` \(§10\) \| `compat-label` \|/,
    );
    expect(doc).toMatch(/\| 5 \| Built-in default `normal` \| `default` \|/);
  });

  test('untrusted text can never select quality, profile, model, effort, or budget', () => {
    expect(doc).toMatch(/Quality resolution reads \*\*trusted inputs only\*\*/);
    expect(doc).toMatch(
      /Issue bodies, issue comments, PR descriptions, review comments, and agent output MUST NOT influence/,
    );
  });
});

describe(`${DOC_PATH} — storage, defaults, and reload timing (§9)`, () => {
  test('the catalog lives in its own file, outside sessions.json', () => {
    expect(doc).toMatch(/The catalog lives in its own file, `agent-profiles\.json`/);
    expect(doc).toMatch(/\*\*Inlining a catalog into `sessions\.json` is rejected\*\*/);
    expect(doc).toMatch(/`sessions\.json` keeps only \*selection\*, never the catalog/);
  });

  test('a configured but unreadable catalog refuses instead of falling back', () => {
    expect(doc).toMatch(
      /is a refusal \(`catalog-unreadable`\), never a silent fall-through to the built-in catalog/,
    );
    expect(doc).toMatch(
      /A configured path that is not absolute is the same refusal for the same reason/,
    );
  });

  test('the loop runs correctly with no catalog file present', () => {
    expect(doc).toMatch(/The loop MUST run correctly with no catalog file present\./);
    expect(doc).toMatch(/It is a \*default\*, not a floor/);
  });

  test('the shipped built-in catalog records the divergences B3 must reconcile', () => {
    expect(doc).toMatch(
      /The catalog B1 shipped \(`BUILT_IN_AGENT_PROFILE_CATALOG`\) reproduces today's complexity mapping for `anthropic`/,
    );
    // The write-capable cutover closed the no-label case by the predicted data
    // edit; what remains diverges only for the review class.
    expect(doc).toMatch(
      /closed the no-label divergence B1 recorded, by the data edit it predicted/,
    );
    expect(doc).toMatch(/It carries two known divergences/);
    expect(doc).toMatch(/both of them review-class cases no lane resolves through this catalog yet/);
    expect(doc).toMatch(
      /so B3 resolves each with its own before\/after table rather than either slice picking one silently/,
    );
  });

  test('quality is snapshotted at intake but concrete settings resolve per run', () => {
    expect(doc).toMatch(
      /\*\*The requested quality is resolved once, at intake, and persisted on the task\*\*/,
    );
    expect(doc).toMatch(/\*\*The catalog is read at phase start\*\*, once per phase execution, and never re-read mid-run/);
    expect(doc).toMatch(
      /\*\*Concrete settings are therefore resolved per phase run, not snapshotted at intake\.\*\*/,
    );
    expect(doc).toMatch(/would strand a long-running or requeued task on a model that has since been retired/);
    // B2 named the key and the reactivation rule, so the snapshot's storage is
    // as pinned as its timing.
    expect(doc).toMatch(
      /B2 persists it under the task-context key `requestedQuality`, beside `assignment`; a task reactivated by a later intake pass keeps its original snapshot/,
    );
    expect(doc).toMatch(/\*\*A pin is read live, not snapshotted\.\*\*/);
  });

  test('a pin guarantees profile identity, not frozen concrete settings', () => {
    expect(doc).toMatch(/\*\*A pin holds a profile \*name\*, not a snapshot of its settings\.\*\*/);
    expect(doc).toMatch(/There is no versioned or immutable pin/);
    expect(doc).toMatch(
      /\*\*An operator who needs stable concrete settings pins a profile they do not edit\.\*\*/,
    );
    expect(doc).toMatch(/declare a dated profile in the overlay \(`claude-strong-2026-09-07`\), pin that/);
    expect(doc).toMatch(/the same `profileName` against a different `catalogDigest`/);
  });

  test('overlay is partial: providers, profiles, and options merge; bindings replace', () => {
    expect(doc).toMatch(/\*\*Providers merge by key\.\*\*/);
    expect(doc).toMatch(/\*\*Profiles merge by name, field by field\.\*\*/);
    expect(doc).toMatch(/\*\*A field set to JSON `null` is explicitly unset\*\*/);
    expect(doc).toMatch(/\*\*Bindings replace, they do not merge\.\*\*/);
    expect(doc).toMatch(/\*\*`providerOptions` merges by key\*\*, with `null` unsetting one option/);
    expect(doc).toMatch(/\*\*There is no deletion and no block replacement\.\*\*/);
    expect(doc).toMatch(
      /the effective catalog always declares every built-in provider, and a provider missing from it is one that was never built in/,
    );
  });

  test('the smallest valid override file is a few lines and still validated', () => {
    expect(doc).toMatch(/The smallest valid override file is therefore a few lines/);
    expect(doc).toMatch(
      /it is valid only if `codex-xhigh` is also declared — by the same file or by the built-in catalog/,
    );
  });
});

describe(`${DOC_PATH} — label compatibility (§10)`, () => {
  test('complexity labels map to quality levels, not to provider effort names', () => {
    expect(doc).toMatch(
      /\*\*compatibility inputs mapped to a provider-neutral quality level\*\*, and are never again read as a literal provider effort value/,
    );
    expect(doc).toMatch(/\| `complexity:low` \| implementation-class phases \| `light` \|/);
    expect(doc).toMatch(/\| `complexity:high` \| implementation-class phases \| `strong` \|/);
    expect(doc).toMatch(/\| `complexity:xhigh` \| implementation-class phases \| `maximum` \|/);
  });

  test('review labels map to quality levels with the same rule', () => {
    expect(doc).toMatch(/\| `review:low` \| review-class phases \| `light` \|/);
    expect(doc).toMatch(/\| `review:medium` \| review-class phases \| `normal` \|/);
    expect(doc).toMatch(/\| `review:high` \| review-class phases \| `strong` \|/);
  });

  test('quality:* is the canonical namespace and outranks both families', () => {
    expect(doc).toMatch(
      /`quality:<level>` is the forward-looking canonical namespace and outranks both compatibility families/,
    );
    expect(doc).toMatch(/`review:xhigh` remains unrecognized as a \*label\*/);
  });

  test('phase classes exist only to pick which requested quality a phase reads', () => {
    expect(doc).toMatch(/\*\*implementation-class\*\*/);
    expect(doc).toMatch(/\*\*review-class\*\*/);
    expect(doc).toMatch(/not to select a catalog entry \(§4\.3\)/);
  });

  test('B2 fixes the phase-to-class assignment, including the dispute sub-turns', () => {
    expect(doc).toMatch(/Slice B2 \(#905\) fixes the exact assignment/);
    expect(doc).toMatch(/\| `review`, `content_review` \| review-class \|/);
    expect(doc).toMatch(/\| dispute `implementer_fix` \| implementation-class \|/);
    expect(doc).toMatch(
      /\| dispute `evidence_collection` \| per party — implementer side is implementation-class, reviewer side is review-class \|/,
    );
    expect(doc).toMatch(
      /\| dispute `human_handoff`, `no_turn`, `unresolvable` \| none — no agent runs, so no quality is resolved \|/,
    );
    expect(doc).toMatch(
      /adding a phase without assigning it a class is a compile error/,
    );
  });

  test('escalation is a per-run floor that raises and never lowers', () => {
    expect(doc).toMatch(/\*\*Escalation raises, never lowers\.\*\*/);
    expect(doc).toMatch(
      /the run resolves the stronger of the persisted request and the floor/,
    );
    expect(doc).toMatch(/is untouched and keeps its own source/);
    expect(doc).toMatch(/The floor is per run and is never written back to the task/);
  });

  test('an unreadable or contradictory quality request refuses instead of defaulting', () => {
    expect(doc).toMatch(
      /Two of them naming \*different\* levels is a contradiction with no defensible winner/,
    );
    expect(doc).toMatch(/is refused \(`invalid-quality-request`, §12\.2\)/);
    // The compatibility families keep their pre-contract "unrecognized means
    // nothing" meaning; only the canonical namespace fails closed.
    expect(doc).toMatch(
      /an unrecognized `complexity:\*` or `review:\*` spelling — `review:xhigh` above all — contributes nothing and falls through/,
    );
    expect(doc).toMatch(
      /intake refuses that one Issue rather than the whole scan, so one operator's typo never stops every other Issue/,
    );
    // The refusal is about admission, not about the row the Issue already has:
    // the refinement suspension guard runs first, or a typo would leave the
    // previous lane executing under the marker that exists to stop it.
    expect(doc).toMatch(
      /A quality refusal withholds \*admission only\*.*never suppresses a guard that acts on the task the work item already has/,
    );
    expect(doc).toMatch(
      /relabelled into refinement while its previous lane is still live is suspended for a human first/,
    );
    // Same ordering for the predecessor gate, and its direction: a refusal may
    // only be preceded by guards that make a task LESS claimable.
    expect(doc).toMatch(
      /a refinement row whose predecessors are not ready is parked before the refusal is reported/,
    );
    expect(doc).toMatch(
      /Only the guards that make a task \*less\* claimable run ahead of a refusal; releasing a hold waits for a poll whose quality request resolves/,
    );
  });

  test('cutover preserves behavior and never resolves a difference silently', () => {
    expect(doc).toMatch(/the same labels and the same environment must resolve to the same concrete model, effort, and budget as before/);
    expect(doc).toMatch(/It does not resolve such a difference by silently picking one\./);
    // Since the write-capable cutover, escalation is a quality floor: it can
    // raise the whole profile, and that is a documented §10.4 difference.
    expect(doc).toMatch(/a per-run quality floor of `strong`/);
    expect(doc).toMatch(
      /it raises the whole resolved profile and never lowers a request that already meets the floor/,
    );
  });

  test('§10.4 records the write-capable cutover with its before/after table', () => {
    expect(doc).toMatch(/### 10\.4 The write-capable cutover \(issue #911\)/);
    expect(doc).toMatch(
      /`implementation` \(Claude, Codex, Gemini\/Antigravity; both orchestration modes including fix\/requeue\) and `conflict_resolution` \(Claude\) resolve through the boundary/,
    );
    expect(doc).toMatch(
      /With no `agent-profiles\.json` present, the built-in catalog reproduces the pre-cutover model, effort, and budget for every labeled and unlabeled run/,
    );
    // The deliberate differences, each a table row: escalation as a floor, the
    // two retired session keys, the clamped effort now refused, the --profile
    // placement fix, and the Antigravity print timeout.
    expect(doc).toMatch(
      /a quality floor of `strong`: the run resolves that binding's whole profile \(for `anthropic`, opus\/high\/\$10\)/,
    );
    expect(doc).toMatch(
      /\| `session\.claude\.complexityProfiles` \| overrode the implementation\/conflict tier map \| no longer read by the cut-over lanes; express the override as an `agent-profiles\.json` overlay \|/,
    );
    expect(doc).toMatch(
      /\| `session\.codex\.model` \| spliced `--model` into `codex exec` \| no longer read by the implementation lane; set `model` on an `openai` profile or break the glass with `CODEX_MODEL` \|/,
    );
    expect(doc).toMatch(/silently clamped to `high` \| refused \(`invalid-override`, §12\.3\)/);
    expect(doc).toMatch(
      /spliced after `exec`, where a global option fails CLI argument parsing \| spliced before the subcommand, per the §7\.3 ordering rule/,
    );
    expect(doc).toMatch(
      /every built-in `google` profile carries `printTimeout: 15m`, so the lane passes `--print-timeout 15m`/,
    );
    // What is NOT changed, and the record every attempt now leaves.
    expect(doc).toMatch(
      /worktree isolation, locks, Tool Request handling, environment preparation, verification and its repair loop, branch and recovery behavior, and the assignment boundary are untouched/,
    );
    expect(doc).toMatch(
      /every attempt now persists the §13 record \(run artifact, bounded task-context trail, and `agent\.runtime\.resolved` event\)/,
    );
  });
});

describe(`${DOC_PATH} — safe refresh of a fast-moving catalog (§11)`, () => {
  test('an unsupported schema version is refused whole', () => {
    expect(doc).toMatch(
      /\*\*refused whole\*\* \(`catalog-schema-unsupported`\) — never partially parsed, never mixed with built-ins/,
    );
  });

  test('the schema is closed so a typo cannot silently no-op', () => {
    expect(doc).toMatch(/Unknown keys anywhere in the document are rejected\./);
    expect(doc).toMatch(/A typo'd `qualityBinding` \(singular\) must not silently leave the built-in binding in place/);
  });

  test('there is no auto-discovery and the loop never rewrites the catalog', () => {
    expect(doc).toMatch(/### 11\.3 No auto-discovery, ever/);
    expect(doc).toMatch(/never rewrites the catalog file/);
    expect(doc).toMatch(/Refreshing is an operator edit\./);
  });

  test('a refresh never disturbs work in flight', () => {
    expect(doc).toMatch(/### 11\.5 A refresh never disturbs work in flight/);
    expect(doc).toMatch(/cannot change any already-recorded resolution/);
  });

  test('the refresh command previews by default and applies only with the established confirmation', () => {
    expect(doc).toMatch(/### 11\.6 The refresh command \(issue #914\)/);
    expect(doc).toMatch(
      /The default invocation is non-mutating; applying requires the admin CLI's established explicit confirmation \(`--yes`\)/,
    );
    // §11.3 is reconciled, not weakened: the command is the operator edit.
    expect(doc).toMatch(
      /it is the operator edit, made explicit and reviewable: no phase run ever triggers it/,
    );
  });

  test('the refresh writes only tool-managed values, with no force/replace mode', () => {
    expect(doc).toMatch(
      /What `--yes` may write is exactly the \*\*tool-managed set\*\*, and nothing else: the removal of redundant overrides \(with the containers they empty pruned\) and one `refresh` provenance record\./,
    );
    expect(doc).toMatch(/There is deliberately \*\*no force\/replace mode\*\*/);
    expect(doc).toMatch(/\*\*A refresh cannot silently alter active provider settings\.\*\*/);
    expect(doc).toMatch(
      /\*\*the newest model is never assumed to be the preferred cost\/quality choice\*\*/,
    );
    expect(doc).toMatch(/\*\*The previous file is backed up before it is replaced\.\*\*/);
  });

  test('an apply refuses to overwrite a concurrent catalog edit', () => {
    expect(doc).toMatch(/\*\*A concurrent edit is never overwritten\.\*\*/);
    expect(doc).toMatch(/refuses \(`refresh-conflict`\) if it changed in between/);
  });

  test('model listings are scoped to the executable that produced them', () => {
    expect(doc).toMatch(/A listing is taken \*\*per resolved executable\*\*/);
    expect(doc).toMatch(
      /every profile is compared only against the listing of the binary that would run it, never against another executable's inventory/,
    );
  });

  test('the refresh finding vocabulary and the fallback source are specified', () => {
    for (const kind of [
      'removed-model',
      'unsupported-effort',
      'redundant-override',
      'stale-override',
      'operator-addition',
    ]) {
      expect(doc).toContain(`\`${kind}\``);
    }
    expect(doc).toMatch(
      /the bundled recommended catalog everywhere else — including when a live listing is unavailable, unreadable, or skipped with `--offline`/,
    );
    expect(doc).toMatch(/The applied record names the aggregate source: `live`, `bundled`, or `mixed`\./);
  });

  test('the refresh documents upgrade, rollback, offline, and the missing-file behaviors', () => {
    expect(doc).toMatch(/\*\*Rollback\*\* — restore the printed backup over the catalog path/);
    expect(doc).toMatch(
      /A binary older than the `refresh` block refuses a refreshed file whole \(`catalog-invalid`, §11\.2\)/,
    );
    expect(doc).toMatch(
      /\*\*No file\*\* — with no `agent-profiles\.json` present the command reports that the built-in defaults apply, writes nothing, and creates nothing/,
    );
  });
});

describe(`${DOC_PATH} — validation and fail-closed behavior (§12)`, () => {
  test('validation happens at load time and at resolution time', () => {
    expect(doc).toMatch(/Two gates, both fail-closed/);
    expect(doc).toMatch(/so a bad edit fails on the next phase for every task rather than corrupting one/);
  });

  test('the refusal-reason set is closed', () => {
    for (const reason of [
      'catalog-unreadable',
      'catalog-schema-unsupported',
      'catalog-invalid',
      'unknown-provider',
      'unbound-quality',
      'unknown-profile',
      'unsupported-setting',
      'unsupported-value',
      'invalid-quality-request',
      'invalid-override',
    ]) {
      expect(doc).toContain(`\`${reason}\``);
    }
    expect(doc).toMatch(/A closed set\. Adding a member is a change to this document first\./);
  });

  test('no silent downgrade: refusals, never clamps', () => {
    expect(doc).toMatch(
      /\*\*a resolved setting is never replaced by a nearby value the provider would accept\.\*\*/,
    );
    expect(doc).toMatch(/refused, not lowered to `high`/);
    expect(doc).toMatch(
      /a provider that was never built in — refused, not served from another provider's profiles and not given a settings-free default invocation/,
    );
    expect(doc).toMatch(
      /The one permitted "same answer for two requests" is a \*declared\* binding \(§6\.3\), which is configuration, not substitution/,
    );
  });
});

describe(`${DOC_PATH} — observability and audit metadata (§13)`, () => {
  test('both the requested quality and the concrete settings are recorded', () => {
    expect(doc).toMatch(/The requested quality and the concrete resolved settings are recorded together/);
    expect(doc).toMatch(/quality alone hides what actually ran; settings alone hide what was asked for/);
  });

  test('the record carries per-field sources, a catalog digest, and shared bindings', () => {
    for (const field of [
      'requestedQuality',
      'requestedQualitySource',
      'effectiveQuality',
      'effectiveQualitySource',
      'profileName',
      'profileSource',
      'sharedWithQualityLevels',
      'catalogSchemaVersion',
      'catalogVersion',
      'catalogDigest',
      'modelSource',
      'effortSource',
      'budgetSource',
      'binarySource',
      'cliVersion',
      'resolvedAt',
      'resolutionDurationMs',
    ]) {
      expect(doc).toContain(`"${field}"`);
    }
    expect(doc).toMatch(/\*\*Every concrete value carries its own source\*\*/);
    expect(doc).toMatch(/\*\*`catalogDigest` covers the effective catalog after overlay\*\*/);
  });

  test('one record shape covers every provider, and only absent values differ', () => {
    expect(doc).toMatch(/\*\*One record shape, every provider\.\*\*/);
    expect(doc).toMatch(
      /what differs between providers is which \*values\* are absent, never which fields exist/,
    );
    expect(doc).toMatch(/Implemented by issue #910 as `src\/core\/agent-runtime-audit\.ts`/);
    expect(doc).toMatch(/pinned by `test\/agent-runtime-audit\.test\.js`/);
  });

  test('the two quality halves stay separate, and escalation belongs to the run', () => {
    expect(doc).toMatch(/\*\*`escalation` is a run's source, never a task's\.\*\*/);
    expect(doc).toMatch(
      /records `effectiveQualitySource: "escalation"` while the task keeps the request it was admitted with/,
    );
  });

  test('a shared binding lists the OTHER levels, whichever layer chose the profile', () => {
    expect(doc).toMatch(
      /It lists the levels \*other than\* this run's, whichever §8\.1 layer chose the profile, so the fact does not change shape between a binding and a pin/,
    );
  });

  test('a value over the per-value bound is truncated visibly, with a digest', () => {
    expect(doc).toMatch(
      /\*\*A recorded value over the bound is truncated visibly, never silently\.\*\*/,
    );
    expect(doc).toMatch(
      /recorded as its prefix plus the original length and a SHA-256 of the whole value/,
    );
    expect(doc).toMatch(
      /two binaries that differ only past the bound keep two different records/,
    );
  });

  test('nothing in the record can carry a prompt, an environment value, or a credential', () => {
    expect(doc).toMatch(
      /\*\*The record has no field for a prompt, an environment, or a credential\.\*\*/,
    );
    expect(doc).toMatch(
      /An operator override contributes the \*source\* `env`, never the variable's value/,
    );
    expect(doc).toMatch(
      /a discovered CLI version is the one recorded value that came from a CLI's stdout/i,
    );
  });

  test('absence is absence and is never proof that two runs differ', () => {
    expect(doc).toMatch(/### 13\.3 Absence is absence/);
    expect(doc).toMatch(/An unset model is recorded as an absence, never as a model name\./);
    expect(doc).toMatch(
      /no consumer may treat one as proof that two runs used different models/,
    );
  });

  test('the status comment surfaces the quality alongside the agent', () => {
    expect(doc).toMatch(
      /agent claude \(anthropic\) — quality: strong requested by label complexity:high — profile claude-strong — model opus, effort high, budget \$10/,
    );
    expect(doc).toMatch(/That line is bounded, single-line, and sanitized/);
  });

  test('the public line describes a pinned profile as a pin, never as a binding', () => {
    expect(doc).toMatch(
      /a pinned profile is named as pinned and the levels the provider binds to it are listed without folding the run's own level in/,
    );
    expect(doc).toMatch(
      /never reads as a binding of `normal` to `claude-light` that the catalog does not declare/,
    );
  });

  test('a provider ceiling is stated as what ran, never as the tier that was asked for', () => {
    expect(doc).toMatch(
      /concrete settings are quoted from the resolution and never translated from the quality level/,
    );
    expect(doc).toMatch(
      /a `maximum` request answered by a provider's high-only profile reads as `maximum` requested with `high` effort and the shared binding named, never as an `xhigh` run the provider never performed/,
    );
  });

  test('the public line drops what only internal surfaces may carry', () => {
    expect(doc).toMatch(
      /The resolved binary is omitted from the public line, because a break-glass variable may legitimately point it at an absolute local path/,
    );
    expect(doc).toMatch(/full internal metadata stays in the events and the artifact/);
  });

  test('the persisted trail is bounded, counts what it trims, and tolerates foreign records', () => {
    expect(doc).toMatch(/One `agent\.runtime\.resolved` event carries the whole record/);
    expect(doc).toMatch(
      /which trims oldest-first and counts what it trimmed rather than presenting a shortened history as a complete one/,
    );
    expect(doc).toMatch(
      /a record written by another build of this loop can neither block a run nor be reinterpreted as this version's facts/,
    );
    expect(doc).toMatch(/as `agent-runtime\.json`/);
  });

  test('arbitration rules are fed, never relaxed', () => {
    expect(doc).toMatch(/None of those rules relax\./);
    expect(doc).toMatch(
      /causes more same-model refusals, not fewer/,
    );
  });
});

describe(`${DOC_PATH} — follow-up implementation boundaries (§14)`, () => {
  test('five ordered slices are named, with the behavior-changing one isolated', () => {
    expect(doc).toMatch(/\| B1 \| Catalog schema, loader, overlay merge, validator, built-in catalog \|/);
    expect(doc).toMatch(/\| B3 \| The adapter interface and the three provider adapters/);
    expect(doc).toMatch(/The only slice that changes what runs\./);
    expect(doc).toMatch(/Ordering is B1 → B2 → B3 → B4 → B5\./);
    expect(doc).toMatch(/a partially deleted chain is exactly the silent-default failure this contract exists to remove/);
  });

  test('B1 is marked landed and names its module and its behavioral pin', () => {
    expect(doc).toMatch(
      /\*\*Landed in issue #904\*\* as `src\/core\/agent-profile-catalog\.ts`\./,
    );
    expect(doc).toMatch(/Slice B1's behavioral pin is `test\/agent-profile-catalog\.test\.js`\./);
  });

  test('B2 is marked landed and names its module and its behavioral pin', () => {
    expect(doc).toMatch(
      /\| B2 \| Quality levels, compatibility mapping, per-phase-class resolution, persistence on the task \| Pure resolution plus one intake write\. Still not consumed by any lane\. \*\*Landed in issue #905\*\* as `src\/core\/agent-quality\.ts`\. \|/,
    );
    expect(doc).toMatch(/Slice B2's behavioral pin is `test\/agent-quality\.test\.js`\./);
  });

  test("B3's boundary and all three provider adapters are marked landed with behavior unchanged, and name their pins", () => {
    expect(doc).toMatch(
      /\*\*The adapter contract and the provider registry landed in issue #906\*\* as `src\/core\/agent-runtime-adapter\.ts` \(§7\.1\); \*\*the Claude adapter landed in issue #907\*\* as `src\/core\/claude-runtime-adapter\.ts` \(§7\.2\); \*\*the Codex adapter landed in issue #908\*\* as `src\/core\/codex-runtime-adapter\.ts` \(§7\.3\); \*\*the Gemini\/Antigravity adapter landed in issue #909\*\* as `src\/core\/antigravity-runtime-adapter\.ts` \(§7\.4\); \*\*the write-capable lanes \(`implementation`, `conflict_resolution`\) switched over in issue #911\*\* with the §10\.4 before\/after table\. The read-side lanes are not cut over yet, so their behavior is unchanged\./,
    );
    expect(doc).toMatch(
      /Slice B3's boundary pin is `test\/agent-runtime-adapter\.test\.js`, its Claude adapter's pin is `test\/claude-runtime-adapter\.test\.js`, its Codex adapter's pin is `test\/codex-runtime-adapter\.test\.js`, and its Gemini\/Antigravity adapter's pin is `test\/antigravity-runtime-adapter\.test\.js`\./,
    );
    // The widened §12.2 row: the registry's refusal shares the catalog's reason.
    expect(doc).toMatch(
      /a resolved agent's provider has no catalog entry, or no registered runtime adapter at the B3 boundary \(§7\.1\)/,
    );
  });

  test("B4's audit record and its §11.4 operator commands are both marked landed", () => {
    expect(doc).toMatch(
      /\*\*The audit record landed in issue #910\*\* as `src\/core\/agent-runtime-audit\.ts` \(§13\)/,
    );
    expect(doc).toMatch(
      /\*\*The operator commands of §11\.4 landed in issue #913\*\* as `src\/cli\/agent-profile\.ts` — `admin agent-profile list`, `show`, and `validate`, read-only and resolving through the same gates a run does; only their candidate-versus-effective diff remains\./,
    );
    expect(doc).toMatch(
      /its §11\.4 operator commands by `test\/admin-agent-profile\.test\.js`\./,
    );
  });

  test('the non-goals are restated as out of scope for every slice', () => {
    expect(doc).toMatch(
      /Phase-specific model profiles; identical effort names across providers; credential handling; provider capability \*discovery\*/,
    );
  });

  test('model names must never become a TypeScript union', () => {
    expect(doc).toMatch(/\*\*May\*\* — the closed, provider-neutral vocabularies this contract owns: `QualityLevel` \(four members\)/);
    expect(doc).toMatch(
      /\*\*Must not\*\* — anything tracking a provider's catalog: model names, effort values, budget amounts, profile names, and per-provider capability lists/,
    );
    expect(doc).toMatch(/These are `string` in the types and validated against the catalog's capability descriptors at load/);
    expect(doc).toMatch(
      /A follow-up implementation that adds a model name to a union has violated this contract/,
    );
  });
});

describe(`${DOC_PATH} — reconciliation landed alongside`, () => {
  test('feature-status.md carries the write-capable-cutover row #911 moved it to', () => {
    expect(featureStatus).toMatch(/#### Provider-centric agent runtime profiles/);
    const block = featureStatus.slice(
      featureStatus.indexOf('#### Provider-centric agent runtime profiles'),
    );
    expect(block).toMatch(/\*\*Status:\*\* `available`/);
    expect(block).toMatch(/agent-runtime-profiles-contract\.md/);
    // The row must say which lanes resolve through the boundary and which do
    // not, or the remaining read-side gap reads as a shipped feature.
    expect(block).toMatch(
      /the write-capable phases — `implementation` \(Claude, Codex, Gemini\/Antigravity; both orchestration modes including fix\/requeue and the verification repair loop\) and `conflict_resolution` \(Claude\) — resolve their agent invocation through the provider runtime boundary; the read-side lanes do not yet/,
    );
    expect(block).toMatch(
      /Issue #911 cuts the write-capable lanes over \(`src\/handlers\/agent-runtime\.ts` is the composition root\)/,
    );
    expect(block).toMatch(
      /the review loop's `escalatedEffort` handoff buys a `strong` quality floor/,
    );
    // The row moved off `foundation-only` only because Evidence names the
    // consuming handlers, per this matrix's own transition rule.
    expect(block).toMatch(/\*\*Evidence:\*\* `src\/core\/agent-profile-catalog\.ts`/);
    expect(block).toMatch(/`src\/core\/agent-quality\.ts`/);
    expect(block).toMatch(/`src\/core\/agent-runtime-adapter\.ts`/);
    expect(block).toMatch(/`test\/agent-runtime-adapter\.test\.js`/);
    expect(block).toMatch(/`src\/core\/claude-runtime-adapter\.ts`/);
    expect(block).toMatch(/`test\/claude-runtime-adapter\.test\.js`/);
    expect(block).toMatch(/`src\/core\/codex-runtime-adapter\.ts`/);
    expect(block).toMatch(/`test\/codex-runtime-adapter\.test\.js`/);
    expect(block).toMatch(/`src\/core\/antigravity-runtime-adapter\.ts`/);
    expect(block).toMatch(/`test\/antigravity-runtime-adapter\.test\.js`/);
    expect(block).toMatch(/`src\/core\/agent-runtime-audit\.ts`/);
    expect(block).toMatch(/`test\/agent-runtime-audit\.test\.js`/);
    expect(block).toMatch(/`src\/handlers\/agent-runtime\.ts`/);
    // The remaining gap must say both halves for the read-side lanes: the
    // request persists AND nothing about what runs changes there yet.
    expect(block).toMatch(
      /on those lanes a `quality:\*` label still selects the persisted request but changes nothing about what runs/,
    );
    expect(block).toMatch(
      /editing `agent-profiles\.json` changes no read-side invocation until B3 cuts those lanes over/,
    );
  });

  test('assignment-profiles.md keeps the agent-only boundary and points forward', () => {
    expect(assignment).toMatch(/\*\*Forward direction \(issue #903\)\.\*\*/);
    expect(assignment).toMatch(/agent-runtime-profiles-contract\.md/);
    expect(assignment).toMatch(
      /\*\*assignment profiles select the agent and never its runtime settings\*\*/,
    );
    expect(assignment).toMatch(
      /still MUST NOT carry a `model`, `effort`, `budget`, `quality`, or `profile` field/,
    );
  });

  test('phase-contracts.md maps both label families onto quality levels', () => {
    expect(phases).toMatch(
      /\*\*compatibility inputs to a provider-neutral quality level\*\*, not literal provider effort names/,
    );
    expect(phases).toMatch(/`complexity:xhigh` → `maximum`/);
    expect(phases).toMatch(
      /`quality:maximum` becomes the supported spelling of the intent `review:xhigh` never had/,
    );
    expect(phases).toMatch(/A declared shared binding is configuration, not a silent downgrade/);
  });

  test('provider-architecture.md links the agent-runtime analogue', () => {
    expect(providerArch).toMatch(/agent-runtime-profiles-contract\.md/);
    expect(providerArch).toMatch(/the same "trusted data, never a credential" rule applied to the \*agent\* runtime/);
  });
});
