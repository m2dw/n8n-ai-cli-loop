/**
 * Structural tests for docs/single-host-execution-backend-contract.md
 * (issue #917).
 *
 * The document is the authoritative contract for the single-host
 * ExecutionBackend abstraction behind every runner-owned command execution.
 * Issue #917 is a pure specification: no production code changes with it,
 * so these tests pin the document's own claims — the closed backend and
 * operation-class sets, the routed/never-routed scope rules (agent lanes
 * and git/GitHub side effects never route through a backend, the table
 * succeeding #916 §3 with the supersession recorded in the predecessor),
 * the resolved-immutable-spec rule, the routine-form carriage for #697
 * in-process substitutions, the in-document definition of every
 * interface shape, the closed lifecycle and its refusal/
 * infrastructure/lost semantics, the closed outcome and refusal-reason
 * taxonomies and the rule that they add no phase-runner vocabulary, the
 * family-preserving pinned classes with their per-family §11.3 rows and
 * the refused-result refusal payload, the
 * agent-never-selects and no-silent-downgrade selection rules, the
 * pinned-never-local floor, the writable-set/secret/socket boundaries, the
 * credential-stripped Git-metadata projection with its prepare-sentinel
 * placement, the native profile+executor-build fingerprint composite, the
 * trust-domain cache and stamp binding, the package-manager-free rule, the
 * packaging layouts with the P1 recommendation and P2's container refusal,
 * the persistence rejections, the local-first migration ordering, and the
 * reconciliation notes in docs/tool-request-grant-tiers-contract.md §18,
 * docs/preflight-execution-plan-contract.md §20,
 * docs/single-host-platform-sandbox-contract.md §15, and docs/DOMAIN.md §5
 * that land alongside it — against drift. They are structural only,
 * mirroring the doc-only pin pattern used for
 * docs/single-host-platform-sandbox-contract.md (#916).
 */
import { existsSync, readFileSync } from 'fs';
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

const DOC_PATH = 'docs/single-host-execution-backend-contract.md';
const doc = read(DOC_PATH);
const tiers = read('docs/tool-request-grant-tiers-contract.md');
const preflight = read('docs/preflight-execution-plan-contract.md');
const platform = read('docs/single-host-platform-sandbox-contract.md');

// docs/DOMAIN.md is a PRIVATE_ONLY_PATH (copybara/copy.bara.sky): the public
// mirror never receives it, and a test that unconditionally loads it couples
// this file to material the exported tree lacks — a dangling ENOENT in the
// public repo's own CI (issue #811). The DOMAIN.md reconciliation pins below
// therefore run only where the document exists (the private source of truth)
// and skip cleanly in the exported tree.
const domain = existsSync(resolve(ROOT, 'docs/DOMAIN.md')) ? read('docs/DOMAIN.md') : null;
const domainTest = domain === null ? test.skip : test;

describe(`${DOC_PATH} — status and scope`, () => {
  test('is marked approved design, not yet implemented', () => {
    expect(doc).toMatch(/Status: \*\*approved design, not yet implemented\*\* \(issue #917\)/);
  });

  test('states its chain position as the successor of #916', () => {
    expect(doc).toMatch(
      /the successor of the single-host platform and CLI sandbox capability contract \(#916\) in the executable chain/,
    );
    expect(doc).toMatch(
      /#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917 → #918 → #919 → #722/,
    );
  });

  test('defers to the fixed predecessor contracts it consumes', () => {
    expect(doc).toMatch(/fixed by `docs\/tool-request-grant-tiers-contract\.md` \(#697\)/);
    expect(doc).toMatch(/fixed by `docs\/preflight-execution-plan-contract\.md` \(#915\)/);
    expect(doc).toMatch(/fixed by `docs\/single-host-platform-sandbox-contract\.md` \(#916\)/);
    expect(doc).toMatch(/fixed by `docs\/guided-tool-request-flow\.md`/);
  });

  test('adds no runtime behavior and no predecessor vocabulary', () => {
    expect(doc).toMatch(/It adds no runtime behavior/);
    expect(doc).toMatch(
      /adds no tier and no `TierRefusalReason` member/,
    );
    expect(doc).toMatch(
      /a backend executes an occurrence the runner already authorized, it never authorizes one/,
    );
  });
});

describe(`${DOC_PATH} — closed sets (§2)`, () => {
  test('the backend id set is closed', () => {
    expect(doc).toMatch(
      /The backend id set is \*\*closed\*\*: `"local"` \| `"native-sandbox"` \| `"container"`\. Adding a backend id is a change to this document first\./,
    );
  });

  test('the operation class set is closed', () => {
    expect(doc).toMatch(
      /The operation class set is \*\*closed\*\*: `"environment\.prepare"` \| `"verification\.run"` \| `"dependency\.sync"` \| `"tool-request\.granted"` \| `"environment\.pinned"` \| `"verification\.pinned"` \| `"tool-request\.pinned"`/,
    );
  });

  test('the pinned classes carry the #915 plan entry family', () => {
    expect(doc).toMatch(
      /a #915 `"plan-approval"` occurrence carries its plan entry's `family` verbatim into its class/,
    );
    expect(doc).toMatch(
      /`environment` → `"environment\.pinned"`, `verification` → `"verification\.pinned"`, `tool-request` → `"tool-request\.pinned"`/,
    );
  });
});

describe(`${DOC_PATH} — scope: routed and never-routed (§3)`, () => {
  test('agent lanes never route through a backend', () => {
    expect(doc).toMatch(/\| Agent lanes \(provider CLI invocations\) \| \*\*No\*\* \|/);
    expect(doc).toMatch(/\*\*A backend never contains agent-owned commands\.\*\*/);
  });

  test('git/GitHub side effects never route through a backend', () => {
    expect(doc).toMatch(/\| Git\/GitHub side effects \(commit, push, fetch, `gh`\) \| \*\*No\*\* \|/);
    expect(doc).toMatch(/\*\*Git and GitHub side effects remain explicit runner operations\.\*\*/);
    expect(doc).toMatch(
      /no authenticated Git or GitHub side effect — a push, a comment, a credentialed API call — can succeed from inside, even if the command invokes `git` or `gh`/,
    );
  });

  test('the scope table succeeds #916 §3 rather than restating it', () => {
    expect(doc).toMatch(
      /The table \*\*succeeds\*\* #916 §3's containment authorities rather than restating them/,
    );
    expect(doc).toMatch(/#916 §3 records that supersession in place/);
  });

  test('a #697 in-process entry routes as a routine-form spec, never as orchestrator code', () => {
    expect(doc).toMatch(
      /routes through the backend as a `form: "routine"` spec \(§6\.2\) and the routine runs inside the backend-launched \*sandboxed run process\* \(#697 §7\), never in the orchestrator's/,
    );
    expect(doc).toMatch(
      /Both #697 `execution` kinds route: a `"pinned-command"` entry as a `form: "tokenized"` spec, an `"in-process"` entry as a `form: "routine"` spec \(§6\.2\)/,
    );
  });
});

describe(`${DOC_PATH} — the interface and the immutable spec (§4)`, () => {
  test('the spec is resolved once, immutable, and complete', () => {
    expect(doc).toMatch(
      /the backend receives the resolved spec verbatim and consults no session config, no plan, no store, and no environment of its own/,
    );
  });

  test('the persisted execution identity binds the backend fingerprint', () => {
    expect(doc).toMatch(
      /The \*\*persisted execution identity\*\* of a run is `requestDigest`: the SHA-256 of the canonical `\(specDigest, backendId, fingerprint\)` triple/,
    );
    expect(doc).toMatch(
      /two runs of one spec under different digest-pinned images or sandbox profiles are never conflated/,
    );
  });

  test('the native-sandbox fingerprint composites the profile and executor build digests', () => {
    expect(doc).toMatch(
      /the canonical composite of the compiled sandbox-profile digest \*\*and\*\* the exact runner\/routine-executor build digest \(§4\.1\)/,
    );
    expect(doc).toMatch(/executorBuildDigest: string;/);
    expect(doc).toMatch(
      /so `requestDigest` binds that full fingerprint and two executor builds under one profile carry distinct fingerprints and distinct `requestDigest`s/,
    );
    expect(doc).toMatch(
      /different executed backend code never shares an execution identity/,
    );
    expect(doc).toMatch(
      /A binding either of whose digests is unresolvable is not constructible, and selection refuses `"backend-unavailable"`/,
    );
  });

  test('the local engine compatibility reference is the shipped CommandRunner', () => {
    expect(doc).toMatch(
      /The shipped `CommandRunner` \(`src\/handlers\/command-runner\.ts`\) is the compatibility reference for the `local` engine/,
    );
    expect(doc).toMatch(
      /the `spawnDiagnostic` seam keeps them separable, exactly as the shipped `spawnError` contract does/,
    );
  });

  test('every shape the interface references is defined in-document', () => {
    expect(doc).toMatch(
      /Every shape the interface references is defined in this document: `ExecutionRequest` and its members in §4\.1, `ExecutionRunState` in §5, `EnforcementRecord` and the closed `IsolationAxis` set in §6\.6, `ExecutionRunRecord`, `IdentityWitness`, and `ReconcileOutcome` in §8\.5, `ExecutionOutcome` in §11\.1, `ExecutionRefusal` in §11\.2, and `BackendCapabilities` in §13\.2\./,
    );
    expect(doc).toMatch(/type ExecutionRunState =/);
    expect(doc).toMatch(/type IsolationAxis =/);
    expect(doc).toMatch(
      /type EnforcementRecord = Readonly<Partial<Record<IsolationAxis, EnforcementValue>>>;/,
    );
    expect(doc).toMatch(/type IdentityWitness =/);
    expect(doc).toMatch(/interface ExecutionRunRecord \{/);
    expect(doc).toMatch(/type ReconcileOutcome =/);
    expect(doc).toMatch(/interface ExecutionRefusal \{/);
    expect(doc).toMatch(/interface BackendCapabilities \{/);
  });
});

describe(`${DOC_PATH} — lifecycle (§5)`, () => {
  test('the state set is closed and refusals are pre-launch only', () => {
    expect(doc).toMatch(/The state set is \*\*closed\*\*/);
    expect(doc).toMatch(/\*\*Refusal exits are pre-launch only\.\*\*/);
  });

  test('infrastructure and lost keep their semantics', () => {
    expect(doc).toMatch(/\*\*`infrastructure` is never attributed to the command\.\*\*/);
    expect(doc).toMatch(/\*\*`lost` is assigned only by reconciliation\*\*/);
  });

  test('a post-launch backend failure has a legal infrastructure exit through collecting', () => {
    expect(doc).toMatch(
      /done: `ran` \\\| `timeout` \\\| `cancelled` \\\| `infrastructure` \(rule 2\)/,
    );
    expect(doc).toMatch(
      /Post-launch, a backend\/runtime failure — observed at `launched`, while `running`, or during a `terminating` kill sequence — enters `collecting`/,
    );
    expect(doc).toMatch(/A terminator recorded first still wins \(§11\.1\)/);
  });

  test('the launching intent is distinct from a witnessed launch', () => {
    expect(doc).toMatch(/\| "launching"/);
    expect(doc).toMatch(
      /The durable launch intent persisted, immediately before the spawn\/start attempt \(§12 rule 2\); no process has been created and no launch is claimed/,
    );
    expect(doc).toMatch(/no record ever claims a witnessed launch that never happened/);
  });
});

describe(`${DOC_PATH} — isolation policy (§6)`, () => {
  test('the writable set is exactly worktree + run artifacts + declared caches', () => {
    expect(doc).toMatch(/The writable set of every run is exactly: the issue worktree/);
    expect(doc).toMatch(
      /Never mounted into any isolated backend, under any spec: the SQLite store, session configuration, the runner's `\$HOME`/,
    );
  });

  test('git metadata reaches an isolated run only as a credential-stripped projection', () => {
    expect(doc).toMatch(
      /\*\*Git metadata reaches an isolated run only as an ephemeral, credential-stripped projection\.\*\*/,
    );
    expect(doc).toMatch(
      /the host common Git directory — the repository `\.git` directory every worktree's `gitdir` pointer targets, worktree admin dirs included — in any mode, `ro` included/,
    );
    expect(doc).toMatch(
      /credential-bearing config keys \(`credential\.\*`, every `http\.<url>\.extraheader`\), authenticated remote material, and credential-helper references are \*\*excluded\*\*, not copied/,
    );
    expect(doc).toMatch(
      /A `kind: "git-metadata"` mount that is `rw`, appears on a `local` spec, or whose `hostPath` is the host common Git directory \(or any path inside it\) rather than a runner-constructed projection is `"spec-invalid"`/,
    );
    expect(doc).toMatch(
      /On `local` nothing changes: no projection exists, and the worktree's real metadata stays ambiently reachable exactly as today/,
    );
  });

  test('the network policy set carries the #915 package-registry axis verbatim', () => {
    expect(doc).toMatch(/type NetworkPolicy =/);
    expect(doc).toMatch(/\| "package-registry"/);
    expect(doc).toMatch(/The two registry policies are distinct axes and are never conflated/);
    expect(doc).toMatch(
      /never widened to `"unrestricted"`, never narrowed or renamed to `"registry-allowlist"`/,
    );
  });

  test('the local env is inherited at spawn, never carried in the spec', () => {
    expect(doc).toMatch(/\{ source: "runner-inherited" \}/);
    expect(doc).toMatch(
      /it never enters the spec, `specDigest`, the run record, or any artifact/,
    );
    expect(doc).toMatch(
      /`source: "runner-inherited"` on an isolated backend, or on a pinned-class spec, is `"spec-invalid"`/,
    );
  });

  test('the enforcement record is honest', () => {
    expect(doc).toMatch(
      /\*\*A backend never reports `"enforced"` for an axis it cannot attest\.\*\*/,
    );
    expect(doc).toMatch(
      /The axis set is \*\*closed\*\*, shared by the enforcement record and the §13\.2 capability statement/,
    );
  });

  test('the routine form models #697 in-process substitutions inside the backend boundary', () => {
    expect(doc).toMatch(/\{ form: "routine";/);
    expect(doc).toMatch(
      /the spec's identity content is the routine name plus that canonical input, bound into `specDigest` like every other field/,
    );
    expect(doc).toMatch(
      /Admissible for the pinned classes only — an in-process relaxed entry is a #697 pinned substitution, hence `"tool-request\.pinned"` \(§2\)/,
    );
    expect(doc).toMatch(
      /a `"pinned-command"` origin resolved to anything but `"tokenized"`, an `"in-process"` origin resolved to anything but `"routine"` — are each `"spec-invalid"`/,
    );
  });
});

describe(`${DOC_PATH} — caches, stamps, and package managers (§7)`, () => {
  test('caches are trust-domain-scoped and stamps bind to the backend', () => {
    expect(doc).toMatch(/\*\*The prepare stamp binds to the backend\.\*\*/);
    expect(doc).toMatch(/\*\*Caches are runner-owned and trust-domain-scoped\.\*\*/);
    expect(doc).toMatch(/A cache written in one trust domain is never mounted into another/);
  });

  test('the contract names no package manager', () => {
    expect(doc).toMatch(/\*\*No package manager appears in this contract\.\*\*/);
  });

  test('prepare sentinels live outside the projected Git metadata and the worktree', () => {
    expect(doc).toMatch(
      /\*\*Prepare sentinels never live in projected Git metadata or the worktree\.\*\*/,
    );
    expect(doc).toMatch(
      /written to backend-managed runner state or the artifact root, outside both the projected Git metadata and the worktree/,
    );
    expect(doc).toMatch(
      /Lifecycle and cleanup are owned by the runner, never by a run/,
    );
    expect(doc).toMatch(
      /the shipped worktree-lifetime semantics survive by keying, not by co-location/,
    );
  });
});

describe(`${DOC_PATH} — time, death, and recovery (§8)`, () => {
  test('heartbeats never kill; the identity witness decides', () => {
    expect(doc).toMatch(
      /no run is ever killed for heartbeat staleness alone — the identity witness decides/,
    );
  });

  test('recovery never guesses', () => {
    expect(doc).toMatch(
      /Recovery never guesses: nothing is killed by process name, argv pattern, or image name\. No witness match, no kill\./,
    );
  });

  test('process-group signalling is never credited as tree death', () => {
    expect(doc).toMatch(
      /\*\*Process-group signalling alone is not a tree-death guarantee\*\*/,
    );
    expect(doc).toMatch(
      /inside a kernel-owned tree boundary wherever the platform provides one/,
    );
    expect(doc).toMatch(
      /a backend that cannot enforce the axis on the live host refuses the pinned run \(`"policy-unenforceable"`\)/,
    );
  });

  test('a pre-launch record is never lost', () => {
    expect(doc).toMatch(/\*\*A pre-launch record is never `lost`\.\*\*/);
    expect(doc).toMatch(/disposition: "never-launched"/);
  });
});

describe(`${DOC_PATH} — outcome taxonomy (§11)`, () => {
  test('the outcome set is closed', () => {
    expect(doc).toMatch(/type ExecutionOutcome =/);
    expect(doc).toMatch(/\| "lost"; \/\/ fate unknown; assigned only by reconciliation/);
  });

  test('the refusal-reason set is closed', () => {
    expect(doc).toMatch(/type ExecutionRefusalReason =/);
    expect(doc).toMatch(/\| "image-unpinned";/);
  });

  test('consumption adds no phase-runner vocabulary', () => {
    expect(doc).toMatch(
      /adds no new `PhaseRunOutcome` member, no new `PhaseHandlerResult` shape, no new `TierRefusalReason` member, and no new task status/,
    );
  });

  test('a pinned refusal reaches the existing containment-unavailable route', () => {
    expect(doc).toMatch(
      /`"containment-unavailable"` \(#697 §6 rule 4\) — the existing refusal, reached through `"backend-unavailable"` \/ `"capability-unattested"` \/ `"policy-unenforceable"`/,
    );
  });

  test('a refused result carries the §11.2 refusal payload', () => {
    expect(doc).toMatch(/refusal\?: ExecutionRefusal; \/\/ present iff outcome "refused"/);
    expect(doc).toMatch(
      /so `execution-result\.json` persists the reason for every refused run \(§10\) rather than a bare `outcome: "refused"`/,
    );
  });

  test('the per-family pinned rows keep their #915 §10 semantics', () => {
    expect(doc).toMatch(/\| `environment\.pinned` \| The `environment\.prepare` row's success semantics/);
    expect(doc).toMatch(
      /\| `verification\.pinned` \| Verification output consumed by the shipped bounded repair loop within its existing cycle cap/,
    );
    expect(doc).toMatch(
      /never enters #697 §7 effect verification or its nonzero\/timeout human handoff, which belong to the adopt-changes `tool-request` family alone/,
    );
  });

  test('a lost pinned run keeps its reservation consumed', () => {
    expect(doc).toMatch(/an unsettled reservation counts as consumed across a crash/);
  });

  test('a never-launched pinned run settles instead of parking ambiguously', () => {
    expect(doc).toMatch(
      /recovery settles the reservation with the run reference and `infrastructure` outcome/,
    );
    expect(doc).toMatch(/The settled window stays occupied/);
  });
});

describe(`${DOC_PATH} — fail-closed selection (§13)`, () => {
  test('no agent-authored byte is a selection input', () => {
    expect(doc).toMatch(/\*\*No agent-authored byte is an input\.\*\*/);
    expect(doc).toMatch(
      /\*\*AI agents receive no ability to select a weaker backend\*\* — or any backend\./,
    );
  });

  test('no silent downgrade and no fallback path exist', () => {
    expect(doc).toMatch(/\*\*No silent downgrade, ever\.\*\*/);
    expect(doc).toMatch(/There is no "fall back to local" path anywhere in this contract/);
  });

  test('a pinned class never selects local', () => {
    expect(doc).toMatch(/\*\*A pinned class never selects `local`\.\*\*/);
  });

  test('container execution is optional per policy', () => {
    expect(doc).toMatch(
      /\*\*container execution is optional per policy, never assumed to exist\*\*/,
    );
  });
});

describe(`${DOC_PATH} — packaging and persistence (§15)`, () => {
  test('P1 native host services is the recommended baseline', () => {
    expect(doc).toMatch(/\| \*\*P1 — native host services\*\* \|/);
    expect(doc).toMatch(/\*\*Recommended baseline\.\*\*/);
  });

  test('P2 refuses the container backend rather than exposing the runtime', () => {
    expect(doc).toMatch(/\*\*`container` refuses\*\* \(`"backend-unavailable"`\)/);
  });

  test('the socket rule has no exception', () => {
    expect(doc).toMatch(
      /\*\*The container-runtime socket is never mounted into, proxied into, or otherwise reachable from any execution container, nor from any process an execution container can start\.\*\*/,
    );
  });

  test('the persistence rejections hold', () => {
    expect(doc).toMatch(
      /\*\*No PostgreSQL, no S3, no remote workers, and no distributed leases are introduced in this design cycle\*\*/,
    );
  });
});

describe(`${DOC_PATH} — migration (§16)`, () => {
  test('M0 is byte-identical and local is preserved first', () => {
    expect(doc).toMatch(/\*\*None — byte-identical\.\*\*/);
    expect(doc).toMatch(
      /\*\*local execution remains possible for compatible trusted installations\*\* from M0 onward/,
    );
  });

  test('the supervised group launch is M1\'s recorded change, not M0\'s', () => {
    expect(doc).toMatch(
      /The §8\.4 supervised group\/boundary launch expressly does \*\*not\*\* apply at M0/,
    );
    expect(doc).toMatch(
      /Additive observability plus \*\*one recorded behavioral change\*\*/,
    );
  });

  test('names its own docs pin', () => {
    expect(doc).toMatch(/test\/docs-single-host-execution-backend-contract\.test\.js/);
  });
});

describe(`${DOC_PATH} — reconciliation landed alongside`, () => {
  test('the grant-tiers contract §18 marks its #917 pointer delivered', () => {
    expect(tiers).toMatch(
      /\*\*Delivered \(#917\)\*\*: `docs\/single-host-execution-backend-contract\.md` — the single-host isolated ExecutionBackend contract: the closed `local`\/`native-sandbox`\/`container` backend set/,
    );
    expect(tiers).toMatch(/no silent isolation downgrade/);
    expect(tiers).toMatch(
      /the isolated backend a pinned substitution requires \(never `local`\)/,
    );
  });

  test('the preflight contract §20 marks its #917 pointer delivered', () => {
    expect(preflight).toMatch(
      /\*\*Delivered \(#917\)\*\*: `docs\/single-host-execution-backend-contract\.md` — the single-host isolated ExecutionBackend contract: the execution seam that runs `"plan-approval"` occurrences under an attested isolated backend/,
    );
    expect(preflight).toMatch(/\(`local` is never admissible for them\)/);
  });

  test('the platform contract §15 marks its #917 pointer delivered', () => {
    expect(platform).toMatch(
      /\*\*Delivered \(#917\)\*\*: `docs\/single-host-execution-backend-contract\.md` — the single-host isolated ExecutionBackend contract: the closed backend set \(`local`, `native-sandbox`, `container`\)/,
    );
    expect(platform).toMatch(
      /per-axis enforcement records credited only through §8\.3's behavioral attestation/,
    );
    expect(platform).toMatch(
      /keep the container-runtime socket unreachable from untrusted execution/,
    );
  });

  test('the platform contract §3 records the backend-routing supersession', () => {
    expect(platform).toMatch(/\*\*Superseded in part by #917\.\*\*/);
    expect(platform).toMatch(
      /lets an operator raise a class to an isolated backend per session \(#917 §13 rule 5\)/,
    );
    expect(platform).toMatch(
      /that class's containment authority is the selected backend, refusing rather than silently downgrading/,
    );
  });

  domainTest('DOMAIN.md §5 records the execution-backend contract as decided', () => {
    expect(domain).toMatch(/\*\*Execution-backend contract decided \(#917\)\*\*/);
    expect(domain).toMatch(
      /`docs\/single-host-execution-backend-contract\.md`: the single-host ExecutionBackend abstraction/,
    );
  });
});
