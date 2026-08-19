# Single-host isolated ExecutionBackend contract

Status: **approved design, not yet implemented** (issue #917). This document
is the authoritative contract for the loop's single-host execution
abstraction: the `ExecutionBackend` interface behind which every
runner-owned command execution — environment preparation, configured
verification, dependency sync, and guided Tool Request execution — runs,
with `local` preserving current behavior verbatim and `native-sandbox` /
`container` adding enforceable isolation where policy demands it. Follow-up
implementation issues reference this specification and MUST NOT redefine its
policy; a change of policy is a change to this document first.

This is issue #917, the successor of the single-host platform and CLI
sandbox capability contract (#916) in the executable chain
`#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917
→ #918 → #919 → #722` (see the issue body for the authoritative GitHub Issue
Relationships). It consumes `docs/tool-request-grant-tiers-contract.md`
(#697) — whose §7 enforcing sandbox is the containment demand the isolated
backends realize — `docs/preflight-execution-plan-contract.md` (#915),
whose approved plan entries are among the operations a backend executes,
and `docs/single-host-platform-sandbox-contract.md` (#916), whose platform
targets, two-sandbox-domain rule, behavioral-attestation rule, and
capability report this contract builds on without restating. It adds no
runtime behavior: the backend engines, the run registry, the selection
wiring, and the packaging changes are the chain's later issues (#918
onward).

It does **not** specify, and no implementation built against it may assume:

- **The three tiers, tier resolution, the policy triple, effect
  verification, and the audit record** — fixed by
  `docs/tool-request-grant-tiers-contract.md` (#697). This document adds
  no tier and no `TierRefusalReason` member; `"containment-unavailable"`
  (#697 §6 rule 4) remains the refusal a missing isolated backend routes
  through.
- **The preflight Execution Plan schema, approval, invalidation,
  occurrence reservation, and authorization resolution** — fixed by
  `docs/preflight-execution-plan-contract.md` (#915); a backend executes
  an occurrence the runner already authorized, it never authorizes one.
- **The platform target set, the startup gates, the behavioral-attestation
  rule, and the capability report schema** — fixed by
  `docs/single-host-platform-sandbox-contract.md` (#916); this contract
  consumes that report, it adds no check id.
- **The guided operator flow** — fixed by
  `docs/guided-tool-request-flow.md`; the human gate *is* that flow,
  unchanged.
- **The shipped `environmentPrepare`, `verification`, and
  `dependencySync` semantics** — fixed by
  `docs/environment-prepare-contract.md` and
  `docs/tool-request-and-dependency-sync.md` §3. This contract changes
  *where* those commands may execute, never what they mean, when they
  run, or how their results are judged.
- **Agent lanes and provider CLI sandboxes** — fixed by #916 §3/§6. No
  agent lane routes through an `ExecutionBackend` (§3 below), and no
  backend is ever credited with containing agent-owned commands.
- **The install flow** — `docs/install.md` remains the operative setup
  guide; §15 below records packaging layouts and a recommended baseline,
  not a new install procedure.

## 1. Why an execution backend — the gap this contract closes

#916 §3 fixed the loop's most important boundary statement: no agent CLI
sandbox is ever credited with containing runner-owned commands. Its
consequence is the gap this contract closes: runner-owned commands —
`environmentPrepare`, every configured `verification` command, the
`dependencySync` pinned command, and guided Tool Request execution — run
directly on the host with the orchestrator's own privileges, governed by
operator trust, worktree scoping, and PR review, with **no sandbox
claimed**. That is the correct description of today and the correct
baseline for compatible trusted installations; it is not a place to bolt
isolation onto ad hoc. #697 §7 already demands an enforcing sandbox for
relaxed-tier pinned substitutions, #915 extends that demand to its
`"plan-approval"` occurrences (its `"session-default"` entries run the
shipped mechanisms exactly as if no plan existed), and #916 mapped the
demand onto concrete hosts — but nothing
yet names the seam where any of these commands actually executes.

This contract names that seam. One abstraction — the `ExecutionBackend` —
carries every runner-owned command execution, so that:

- `local` reproduces current behavior byte for byte and remains the
  compatibility baseline for trusted installations;
- `native-sandbox` realizes #697 §7's enforcing sandbox as a backend,
  credited axis by axis only through #916 §8.3's behavioral attestation;
- `container` provides per-operation Docker/Podman isolation on the same
  host, optional per policy, never assumed to exist.

The required boundaries, stated once and enforced throughout:

- **n8n remains the control-plane trigger and visualization layer.** The
  workflow JSON never names a backend, an image, a mount, or a policy —
  `docs/tool-request-redesign.md` §6's rule, unchanged.
- **The runner owns execution policy and backend selection.** Selection
  is a pure function of session policy, operation class, and
  resolution-time host capability (§13).
- **AI agents receive no ability to select a weaker backend.** No
  agent-authored byte is an input to selection; agent-authored content
  can nominate operations (#915's contribution layers), never name where
  they run (§13 rule 1).
- **A backend must not silently downgrade isolation.** An unsatisfiable
  requirement refuses and routes per operation class; nothing re-selects
  a weaker backend (§13 rules 2–3).
- **Git and GitHub side effects remain explicit runner operations.**
  Every commit, push, fetch, and `gh` call the runner itself makes
  stays a runner-owned command outside the untrusted boundary, and an
  execution container gets no credentials and no credentialed remote
  route, so no authenticated Git/GitHub side effect can originate
  inside one (§6.3–§6.4, §14.3). Routing never classifies command
  text: an operator-approved guided command that happens to invoke
  `git` or `gh` routes whole as `"tool-request.granted"` (§3, third
  corollary).

## 2. Terminology

- **Execution backend** — an implementation of the §4 interface. The
  backend id set is **closed**: `"local"` | `"native-sandbox"` |
  `"container"`. Adding a backend id is a change to this document first.
- **Execution operation** — one runner-owned command execution routed
  through a backend. The operation class set is **closed**:
  `"environment.prepare"` | `"verification.run"` | `"dependency.sync"` |
  `"tool-request.granted"` | `"environment.pinned"` |
  `"verification.pinned"` | `"tool-request.pinned"` (§3).
- **Resolved operation specification (spec)** — the immutable, fully
  resolved description of one execution (§4.2): command, cwd,
  environment, mounts, network policy, identity, and limits. The runner
  resolves it once; the backend receives it verbatim and re-resolves
  nothing. `specDigest` is the SHA-256 of its canonical form.
- **Run** — one attempt to execute a spec, identified by a `runId`
  unique per attempt. Retries are new runs over the same `specDigest`.
- **Run record** — the durable row describing a run: state, backend id,
  identity witness, heartbeat, timeline, outcome (§5, §8).
- **Identity witness** — the evidence that a live process or container
  *is* a given run: on `local`/`native-sandbox` the pid + process group
  + process start time, plus the run's recorded tree boundary (§8.4)
  where one was used; on `container` the container id plus the
  `ai-cli-loop.run-id` label. Recovery kills only what a witness
  positively identifies (§8.5).
- **Enforcement record** — the per-axis statement of what a backend
  actually enforced versus merely recorded (§6.6). The value set is
  closed: `"enforced"` | `"declared-only"` | `"refused"`.
- **Trust domain** — the isolation class a run executes under. `local`
  is the operator-trust domain; each isolated backend is its own domain.
  Caches never cross domains (§7).
- **Operator-owned class** — `environment.prepare`, `verification.run`,
  `dependency.sync`, and `tool-request.granted`: the operator (or the
  human gate) authored or approved the exact command.
- **Pinned class** — `environment.pinned`, `verification.pinned`, and
  `tool-request.pinned`: the non-operator-owned classes, admissible
  only under an attested isolated backend (§13 rule 4). A #697
  relaxed-tier pinned substitution is always `"tool-request.pinned"`;
  a #915 `"plan-approval"` occurrence carries its plan entry's
  `family` verbatim into its class — `environment` →
  `"environment.pinned"`, `verification` → `"verification.pinned"`,
  `tool-request` → `"tool-request.pinned"` — so the family's #915 §10
  execution semantics (report-only stamp-gated, report-only
  per-verification-cycle, adopt-changes once-per-task-attempt) survive
  routing and §11.3 consumes each pinned class under its shipped
  counterpart's outcomes, never uniformly under the Tool Request row.
  Every rule this document states for a pinned spec or run binds all
  three classes; only §11.3's per-class consumption differs. A #915
  `"session-default"` entry never enters a pinned class: #915 requires
  it to execute through the shipped mechanism exactly as if no plan
  existed, so its occurrences keep the operator-owned class that
  mechanism already has — and that class's backend admissibility,
  `local` included (§3, fourth corollary).

## 3. Scope — what routes through a backend, and what never does

Every command in the table routes through the `ExecutionBackend` seam once
the migration (§16) reaches it. The table **succeeds** #916 §3's
containment authorities rather than restating them: for the
operator-owned classes, #916 §3's direct-host row becomes this contract's
`local` backend — still the compatibility default (§13 rule 5) — and a
class the operator raises is contained by its selected isolated backend;
#916 §3 records that supersession in place, so no implementer faces two
authoritative rules. The agent-lane and pinned-substitution authorities
are unchanged here, and nothing below blurs them.

| Command class | Routed through a backend? | Containment authority |
| --- | --- | --- |
| `environmentPrepare` (`docs/environment-prepare-contract.md` §2) | Yes — class `"environment.prepare"` | The selected backend; `local` = operator trust, recorded not enforced |
| Configured `verification` commands (same document, §3) | Yes — class `"verification.run"` | Same |
| `dependencySync` pinned command (`docs/tool-request-and-dependency-sync.md` §3) | Yes — class `"dependency.sync"` | Same; the relaxed `"registry-metadata"` route additionally inherits #697 §7 |
| Guided Tool Request execution (grant runs, `docs/guided-tool-request-flow.md`) | Yes — class `"tool-request.granted"` | The selected backend; the human approved the exact command |
| #697 §7 pinned substitutions / #915 `"plan-approval"` occurrences | Yes — the pinned class carrying the originating family (§2): a #697 substitution is `"tool-request.pinned"`; a `"plan-approval"` occurrence routes per its plan entry's `family` as `"environment.pinned"`, `"verification.pinned"`, or `"tool-request.pinned"`, so its #915 §10 family semantics reach §11.3 intact. Both #697 `execution` kinds route: a `"pinned-command"` entry as a `form: "tokenized"` spec, an `"in-process"` entry as a `form: "routine"` spec (§6.2) | An attested isolated backend **only** — `local` is never admissible (§13 rule 4). #915 `"session-default"` occurrences are never a pinned class (fourth corollary below) |
| Agent lanes (provider CLI invocations) | **No** | The provider CLI sandbox plus worktree + review, per #916 §3/§6 — unchanged |
| Git/GitHub side effects (commit, push, fetch, `gh`) | **No** | The runner's **own** git/GitHub operations — branch setup, worktree harvest, the guided flow's disposition commits and pushes, every `gh` call the orchestrator itself makes: explicit runner operations on the host, outside every untrusted boundary (§14.3). This row classifies by *operation*, never by command text (third corollary below) |
| The admin CLI itself, store transactions, in-process code of the orchestrator | **No** | The orchestrator's own process. This row covers the orchestrator's own code paths only: a #697 registry entry whose `execution.kind` is `"in-process"` is **not** this row — when a relaxed entry executes, it routes through the backend as a `form: "routine"` spec (§6.2) and the routine runs inside the backend-launched *sandboxed run process* (#697 §7), never in the orchestrator's |

Four corollaries:

- **A backend never contains agent-owned commands.** Agent lanes keep
  launching exactly as their handlers pin today (#916 §6.2); routing
  them through a backend is out of scope for this design cycle (§20).
- **A spec's command may invoke `git` locally** (a verification command
  that runs `git diff` inside the worktree is contained like any other
  bytes it writes); what never happens is a *side effect to the
  canonical repository or to GitHub* from inside an untrusted backend.
  The runner harvests the worktree with its own git operations at the
  boundary, before and after the run — and inside an isolated backend
  the absence of credentials (and, under every policy but the
  operator-only `"unrestricted"` — `"none"`, `"registry-allowlist"`,
  `"package-registry"` — of any GitHub route at all) makes
  the rule fail closed, not merely stated (§6.3–§6.4).
- **Guided grants route whole, whatever their text says.** The human
  gate approves exact command bytes, and no parser can safely decide
  that a shell line "is a git command", so the routed/never-routed
  split is never made by inspecting text. An approved grant that
  invokes `git push` or `gh issue comment` is one
  `"tool-request.granted"` execution through the selected backend: on
  `local` — the class's compatibility default (§13 rule 5) — it runs
  with the runner's ambient environment and credentials, byte-identical
  to the shipped `/bin/sh -c` grant path, so every command an operator
  can approve today keeps working at M0. Under an isolated backend,
  §6.3–§6.4 give the run no credentials and no credentialed route, so
  exactly such a command fails closed inside the boundary and the
  failure is judged by the guided flow's dispositions like any other
  nonzero exit; an operator who raises `"tool-request.granted"` to an
  isolated backend chooses that trade explicitly, and nothing
  re-classifies or re-routes the command to avoid it (§13 rule 3). The
  never-routed row above covers the runner's *own* git/GitHub
  operations, which are never expressed as backend commands in the
  first place.
- **A #915 `"session-default"` occurrence keeps its shipped class.**
  #915 records the shipped mechanisms in a plan as `"session-default"`
  entries precisely so they execute through the shipped mechanism
  exactly as if no plan existed — observational passthrough, not a new
  authorization. Such an occurrence therefore routes under its
  mechanism's own operator-owned class (`"environment.prepare"`,
  `"verification.run"`, `"dependency.sync"`, or
  `"tool-request.granted"`) with that class's backend admissibility —
  on the compatibility default, that is `local` (§13 rule 5) — and
  only `"plan-approval"` occurrences take a pinned class, each the one
  its plan entry's `family` names (§2). A
  plan that records an existing local-only environment-prepare or
  verification run is preserved, never refused.

## 4. The backend interface

Shape is normative; wiring is an implementation slice. Scripts below are
TypeScript for precision, not a file in this repository.

### 4.1 Types

```ts
type ExecutionBackendId = "local" | "native-sandbox" | "container";

type ExecutionOperationClass =
  | "environment.prepare"
  | "verification.run"
  | "dependency.sync"
  | "tool-request.granted"
  | "environment.pinned"     // #915 "plan-approval", family "environment"
  | "verification.pinned"    // #915 "plan-approval", family "verification"
  | "tool-request.pinned";   // #697 §7 pinned substitution, or #915
                             // "plan-approval", family "tool-request" —
                             // the class carries the plan entry's family
                             // so §11.3 keeps its #915 §10 semantics (§2)

type NetworkPolicy =
  | "none"
  | "registry-allowlist"     // the #697 "registry-metadata" axis:
                             // metadata reads against the spec's own
                             // `registryEndpoints` list alone (§6.4)
  | "package-registry"       // the #915 §4 plan axis, carried verbatim:
                             // full-artifact fetch restricted to the same
                             // spec-carried endpoint list;
                             // attested-capability-only (§6.4)
  | "unrestricted";

interface MountSpec {
  hostPath: string;                    // absolute, resolved by the runner
  guestPath: string;                   // == hostPath on local/native-sandbox
  mode: "ro" | "rw";
  kind: "worktree" | "run-artifacts" | "cache" | "repo-ro"
      | "git-metadata";                // the §6.1 ephemeral
                                       // credential-stripped Git metadata
                                       // projection: ro only, isolated
                                       // backends only, hostPath a
                                       // runner-constructed projection —
                                       // never the host common Git
                                       // directory (§6.1)
}

interface ResolvedOperationSpec {
  operationClass: ExecutionOperationClass;
  operationId: string;                 // the #697/#783 typed operation id,
                                       // or the shipped mechanism's name
  command:
    | { form: "tokenized";
        line: string;                  // the configured or #697/#915-pinned
                                       // command bytes, verbatim — every
                                       // predecessor digest binds to these
        argv: readonly string[] }      // derived from `line` exactly once at
                                       // resolution by the fixed runner
                                       // tokenizer (§6.2); the pinned
                                       // classes' required form for
                                       // command-bytes origins (§6.2)
    | { form: "shell";
        line: string }                 // executed via the shell, as the
                                       // shipped guided grant path does;
                                       // operator-owned classes only (§6.2)
    | { form: "routine";
        routine: string;               // a #697 registry entry's named
                                       // `in-process` routine: fixed runner
                                       // code resolved from the closed
                                       // registry, never agent text — the
                                       // pinned classes' required form for
                                       // `execution.kind: "in-process"`
                                       // origins, inadmissible everywhere
                                       // else (§6.2)
        input?: string };              // canonical JSON of the entry's
                                       // `input.parser` output — parsed
                                       // typed data, spec content bound
                                       // into `specDigest` like every
                                       // other field (§6.2); absent when
                                       // the routine takes none
  cwd: string;                         // inside a declared mount
  env:                                 // one of two closed forms (§6.3)
    | { source: "constructed";         // required on isolated backends:
        values:                        // allowlist-built by the runner,
          Readonly<Record<string, string>> }  // never credential-bearing
    | { source: "runner-inherited" };  // `local`, operator-owned classes
                                       // only: the engine applies the
                                       // runner's own ambient environment
                                       // at spawn; the marker is spec
                                       // content, the ambient bytes never
                                       // are (§6.3)
  mounts: readonly MountSpec[];
  network: NetworkPolicy;
  registryEndpoints?: readonly string[];
                                       // required iff `network` is
                                       // "registry-allowlist" or
                                       // "package-registry": the
                                       // session-configured registry
                                       // endpoints, copied into the spec
                                       // at resolution and bound into
                                       // `specDigest` like every other
                                       // field, so the backend enforces
                                       // exactly this list and consults
                                       // no session config (§4.2, §6.4);
                                       // absent on every other policy
  identity: { user: "runner" | "unprivileged" };  // §6.5
  limits: {
    timeoutMs: number;
    maxStdoutBytes: number;
    maxStderrBytes: number;
    cpu?: number;
    memoryBytes?: number;
    pids?: number;
    scratchBytes?: number;
  };
}

interface BackendBinding {                // §13 selection output
  backendId: ExecutionBackendId;
  fingerprint: string;                    // the §7 backend fingerprint:
                                          // the image digest on
                                          // "container", the §14.2 native
                                          // composite — compiled
                                          // sandbox-profile digest +
                                          // runner/routine-executor build
                                          // digest — on "native-sandbox",
                                          // the literal "host" on "local"
  container?: { imageDigest: string };    // required iff "container":
                                          // image pinned by digest, never
                                          // by mutable tag; equal to
                                          // `fingerprint`
  native?: {                              // required iff "native-sandbox":
    profileDigest: string;                // the compiled sandbox profile
    executorBuildDigest: string;          // the exact runner/routine-
                                          // executor build that launches,
                                          // supervises, and (form:
                                          // "routine") is the run's
                                          // command process (§6.2, §14.2);
                                          // `fingerprint` is the canonical
                                          // composite of both digests —
                                          // either digest unresolvable ⇒
                                          // no binding is constructible
                                          // and selection refuses
                                          // "backend-unavailable" (§13.2)
  };
}

interface ExecutionRequest {
  runId: string;                       // unique per attempt
  spec: ResolvedOperationSpec;         // immutable after resolution
  specDigest: string;                  // sha256 over the canonical form
  binding: BackendBinding;
  requestDigest: string;               // sha256 of the canonical
                                       // (specDigest, backendId,
                                       // fingerprint) triple — the
                                       // persisted execution identity
                                       // (§4.2)
}
```

### 4.2 The spec is resolved once, immutable, and complete

The runner resolves the spec from session configuration, the operation's
own contract, and — for the pinned classes — the approved #915
`"plan-approval"` entry (whose `family` fixed the class, §2/§3) or #697
resolution. Resolution happens
**before** the backend sees anything; the backend receives the resolved
spec verbatim and consults no session config, no plan, no store, and no
environment of its own. A
backend that would need to "look something up" to run a spec has found a
spec-resolution bug, not a backend responsibility. The one spec-directed
exception is the `env` form `source: "runner-inherited"` (§6.3): the
spec itself instructs the `local` engine to apply the runner's own
ambient process environment at spawn, so the backend still decides
nothing — it obeys a marker the runner resolved — and the ambient bytes
remain execution-time state outside the spec, outside `specDigest`, and
outside every persisted form.

`specDigest` identifies the exact spec bytes — and deliberately nothing
more, because every #697/#915 predecessor digest binds to command and
spec content, never to where it runs. The **persisted execution
identity** of a run is `requestDigest`: the SHA-256 of the canonical
`(specDigest, backendId, fingerprint)` triple, computed by the runner
at resolution alongside the binding. The run record, the
`ExecutionResult`, `execution-result.json`, and the container labels
all carry it (§8.5, §10, §14.3), so two runs of one spec under
different digest-pinned images or sandbox profiles are never conflated,
and every artifact can answer *which backend bytes executed this spec*.
On `native-sandbox`, "which backend bytes" includes the runner itself:
the binding fingerprint is the §14.2 composite of the compiled
sandbox-profile digest and the exact runner/routine-executor build
digest, so `requestDigest` binds that full fingerprint and two executor
builds under one profile carry distinct fingerprints and distinct
`requestDigest`s — different executed backend code never shares an
execution identity.
Any change to any spec field is a different spec; any change to the
binding is a different execution identity over the same spec.

### 4.3 The interface

```ts
interface ExecutionBackend {
  readonly id: ExecutionBackendId;

  /** Resolution-time capability statement; fail-closed (§13.2 defines
   *  the shape). */
  capabilities(): BackendCapabilities;

  /** Pre-launch, side-effect-free check of one request (§5; the
   *  refusal shape is §11.2's). */
  validate(request: ExecutionRequest): ExecutionRefusal | null;

  /** Runs the full §5 lifecycle for one request. */
  execute(request: ExecutionRequest): Promise<ExecutionResult>;

  /** Stale-run recovery over a persisted run record (§8.5 defines
   *  record and outcome). */
  reconcile(record: ExecutionRunRecord): ReconcileOutcome;
}

interface BoundedCapture {
  bytes: string;                       // at most the configured maximum
  truncated: boolean;
  totalBytes: number;                  // when known; else bytes.length
}

interface ExecutionResult {
  runId: string;
  specDigest: string;
  requestDigest: string;               // §4.2 persisted execution identity
  backendId: ExecutionBackendId;
  outcome: ExecutionOutcome;           // §11
  exitCode?: number;                   // present iff outcome "ran"
  refusal?: ExecutionRefusal;          // present iff outcome "refused":
                                       // the §11.2 refusal verbatim —
                                       // reason, operator-eyes detail,
                                       // failed axes — so the persisted
                                       // result (execution-result.json
                                       // exists for refused runs like
                                       // every outcome, §10) carries the
                                       // reason §11.3 routes and records,
                                       // never a bare "refused" (§11.2)
  stdout: BoundedCapture;
  stderr: BoundedCapture;
  /**
   * Runner-synthesized diagnostic for a launch/infrastructure failure —
   * bytes the child never wrote, reported separately exactly as the
   * shipped CommandRunResult.spawnError seam does, so callers that
   * persist only child-authored output can strip it. On `local`,
   * populated only where the class's shipped runner reports one (§4.3).
   */
  spawnDiagnostic?: string;
  enforcement: EnforcementRecord;      // §6.6
  timeline: {
    validatedAt: string;
    launchedAt?: string;
    exitedAt?: string;
    collectedAt: string;
  };
  artifacts: readonly string[];        // run-artifact-dir-relative paths
}
```

Every shape the interface references is defined in this document:
`ExecutionRequest` and its members in §4.1, `ExecutionRunState` in §5,
`EnforcementRecord` and the closed `IsolationAxis` set in §6.6,
`ExecutionRunRecord`, `IdentityWitness`, and `ReconcileOutcome` in
§8.5, `ExecutionOutcome` in §11.1, `ExecutionRefusal` in §11.2, and
`BackendCapabilities` in §13.2.

The shipped `CommandRunner` (`src/handlers/command-runner.ts`) is the
compatibility reference for the `local` engine — **per class, because
the shipped module is two runners with different stream semantics, not
one profile**. `environment.prepare`, `verification.run`, and
`dependency.sync` execute through `defaultCommandRunner`
(`execFileSync`): argv-vector spawn, child environment defaulting to
the runner's own, `timeout`, `maxBuffer`, stdout-only on success (a
successful command's stderr is discarded as `""`), failure reporting
the error path's captured stderr, and **no separate spawn diagnostic**.
`tool-request.granted` executes through `bothStreamsCommandRunner`
(`spawnSync`, via `/bin/sh -c`): both streams captured on every exit
code including success, spawn-level failures appended verbatim to
stderr and reported separately (`spawnError`), a signal-killed child
reported as nonzero. Migration stage M0 (§16) demands byte-identical
behavior through the seam, which therefore means each routed class
keeps exactly its shipped runner: on `local`, successful-`stderr`
capture and `spawnDiagnostic` are populated only where the class's
baseline populates them today — the default-runner classes keep
discarding successful stderr and gain no separate diagnostic at M0.
Uniform both-streams capture with a separate diagnostic is the contract
for the **isolated** backends, which are new behavior by construction;
extending it to a `local` class is a recorded behavioral change a later
migration stage must own explicitly, never an M0 side effect.

## 5. Lifecycle state machine

The state set is **closed**. Intent states are recorded before the
action they describe (§12 rule 2: the `launching` intent commits before
the spawn), and fact states are recorded with their evidence in hand
(`launched` only after the spawn returned, witness included), so a
crash between any two steps leaves an honest record — one that neither
forgets a process that might exist nor claims a launch that never
happened (§12).

| State | Entered when | Legal exits |
| --- | --- | --- |
| `resolved` | The runner produced the request (spec + digest + binding) and persisted the run record | `validated`, `refused` |
| `validated` | `validate()` returned null: mounts resolvable, policy enforceable or admissibly declared-only, capabilities sufficient | `provisioned`, `refused` |
| `provisioned` | Backend-side preparation finished (container created but not started — its id already recorded as the witness, §8.5 rule 7; sandbox profile compiled; the §6.1 Git metadata projection constructed where the spec mounts one; nothing user-visible executed) | `launching`, `infrastructure` |
| `launching` | The durable launch intent persisted, immediately before the spawn/start attempt (§12 rule 2); no process has been created and no launch is claimed | `launched`, `infrastructure` (the spawn attempt failed without creating the process, rule 2) |
| `launched` | The spawn/start returned: the command process (or container) is live; identity witness recorded with the transition | `running`, `collecting` (already exited, rule 5; or backend failure observed, rule 2) |
| `running` | Liveness observed at least once; heartbeat maintained (§8.2) | `collecting` (self-exit, or backend failure observed, rule 2), `terminating` |
| `terminating` | Timeout expiry or cancellation began the §8.4 kill sequence | `collecting` |
| `collecting` | The process tree is dead — or a post-launch backend/runtime failure ended observation (rule 2); captures, exit status, and artifacts being gathered | done: `ran` \| `timeout` \| `cancelled` \| `infrastructure` (rule 2) |
| done | Terminal: exactly one §11 outcome, cleanup executed (§10) | — |

```ts
type ExecutionRunState =
  | "resolved"
  | "validated"
  | "provisioned"
  | "launching"
  | "launched"
  | "running"
  | "terminating"
  | "collecting"
  | "done";
```

The run record's `state` field (§8.5) carries exactly these values; the
table's outcome-named exits (`refused`, `infrastructure`, `ran`, …) are
`done` paired with that §11 outcome on the record.

Rules:

1. **Refusal exits are pre-launch only.** `refused` is reachable from
   `resolved`/`validated` alone; once the `launching` intent is
   committed, the run ends in `ran`,
   `timeout`, `cancelled`, `infrastructure`, or — only via recovery —
   `lost`. Nothing user-visible has executed when a run refuses.
2. **`infrastructure` is never attributed to the command.** A
   provisioning failure, spawn failure, or runtime crash produces
   `infrastructure`, with `spawnDiagnostic` set wherever the backend
   reports a separate diagnostic — always on the isolated backends; on
   `local`, only where the class's shipped runner reports one today
   (§4.3, §9): at M0 the default-runner classes surface the failure
   through their shipped error path with no separate diagnostic, and
   that absence is the recorded baseline, not a violation of this rule.
   The command's own exit
   is only ever reported through `ran`. Pre-launch the edges are
   `provisioned → infrastructure` (a provisioning failure) and
   `launching → infrastructure` (a spawn attempt that failed without
   creating the process — the shipped spawn-error path). Post-launch, a backend/runtime
   failure — observed at `launched`, while `running`, or during a
   `terminating` kill sequence — enters `collecting`, which gathers
   whatever remains gatherable and finishes `infrastructure` when the
   failure prevented adopting an exit status: a run that cannot report
   `exitCode` never ends `ran` (§4.3), and its partial captures and
   artifacts are retained like any failed run's (§10 rule 4). A
   terminator recorded first still wins (§11.1): after a recorded
   timeout or cancellation, a collection-time failure leaves the
   outcome `timeout`/`cancelled` and is recorded on the result — the
   §8.4 posture — never rewriting it.
3. **`lost` is assigned only by reconciliation** (§8.5): a run record
   stuck in a non-terminal state whose identity witness no longer
   matches anything alive. A stuck record that provably never spawned
   is closed `infrastructure` by that same reconciliation, never
   `lost` (§8.5 rule 7). `execute()` never returns `lost`.
4. **Cleanup runs on every exit path** — refusals and `lost` included
   (§10) — and cleanup failure never rewrites the outcome.
5. **A command may exit before liveness is observed.** A short-lived
   command (`true`) can be dead by the supervisor's first check after
   the spawn; the run then moves `launched → collecting` directly,
   adopting the recorded exit status through the same collection path
   as a self-exit from `running`, and ends `ran`. The §8.2 heartbeat
   obligation attaches to `running` only — a run that never entered
   `running` never owed one.

## 6. Isolation policy contracts

Each axis below is declared in every spec. What differs per backend is
whether the axis is *enforced* or *declared-only* — recorded per §6.6,
never assumed.

### 6.1 Mounts and the writable-path policy

The writable set of every run is exactly: the issue worktree
(`kind: "worktree"`, rw), the per-run artifact directory
(`kind: "run-artifacts"`, rw), and — for the operator-owned classes
only — the caches the operation class declares (`kind: "cache"`, rw,
§7). Everything else is absent (a
container sees no path it was not given), read-only
(`kind: "repo-ro"` when an operation declares it), or — on `local` —
merely declared. This is #697 §7's filesystem confinement generalized to
every routed class: an absolute path or `..` inside the command hits the
boundary, it does not escape it, on any backend that enforces the axis.

**The pinned classes never mount a cache.** #697 §7's boundary denies
every write outside the issue worktree and the per-run artifact
directory precisely so that worktree diffing is the complete observable
effect surface of a pinned run; a cache shared across runs would be a
writable channel that effect verification never sees, letting one
pinned run poison state a later run consumes. A pinned-class spec
carrying a `kind: "cache"` mount is therefore `"spec-invalid"` (§11.2).
Scratch a pinned run needs is per-run and inside the already-writable
boundary: the run-artifact mount, or the container's own writable layer
— bounded by `limits.scratchBytes` where set and destroyed with the run
(§10) — never a path that outlives the run or is mounted into another.

Never mounted into any isolated backend, under any spec: the SQLite
store, session configuration, the runner's `$HOME` (credential stores,
per #916 §5.5), the host common Git directory — the repository `.git`
directory every worktree's `gitdir` pointer targets, worktree admin
dirs included — in any mode, `ro` included (the projection rule below),
the canonical repository checkout in rw mode, the
artifact roots of other runs, and the container runtime socket (§15.4).
`guestPath` values inside a container are stable canonical paths; the
host↔guest mapping is recorded in the run record so captured output that
names guest paths can be interpreted afterwards.

**Git metadata reaches an isolated run only as an ephemeral,
credential-stripped projection.** A worktree carries no Git metadata of
its own — `<worktree>/.git` is a `gitdir:` pointer into the repository's
common Git directory — and that directory is credential-bearing state:
`credential.*` helper configuration, every `http.<url>.extraheader`
value, and remote URLs or credential-helper state carrying
authenticated material live there, so mounting it directly would hand
an untrusted run the very secrets §6.3 keeps out of every spec. Where a
routed command resolves repository state (the §3 second-corollary
`git diff` case), the runner instead constructs a per-run **Git
metadata projection** and mounts that: `kind: "git-metadata"`,
`mode: "ro"` only, built by the runner at provisioning (§5) under the
run's own backend-managed state, containing exactly the read-only
metadata repository/HEAD/index resolution needs — `HEAD`, refs, the
object store, the worktree's index and pointer files rewritten to
projection-internal paths — and a sanitized configuration from which
credential-bearing config keys (`credential.*`, every
`http.<url>.extraheader`), authenticated remote material, and
credential-helper references are **excluded**, not copied. The
projection is ephemeral and runner-owned: destroyed with the run by
§10 cleanup like scratch and compiled profiles, never reused across
runs, never writable — a command that needs to write Git metadata
fails inside the boundary and is judged like any other nonzero exit
(§3, second corollary). A `kind: "git-metadata"` mount that is `rw`,
appears on a `local` spec, or whose `hostPath` is the host common Git
directory (or any path inside it) rather than a runner-constructed
projection is `"spec-invalid"` (§11.2). On `local` nothing changes: no
projection exists, and the worktree's real metadata stays ambiently
reachable exactly as today (§16 M0).

### 6.2 cwd and command form

`cwd` must resolve inside a declared mount, and is the worktree unless
the operation's own contract says otherwise. The command is carried as
data in one of three forms, chosen per class — and, for a pinned-class
spec, fixed by its originating entry's `execution.kind` — to preserve
the shipped mechanism's execution exactly. Where #697 and #915 pin
command **strings** — a registry template renders `command: string`,
and a session-config pin is a `commandRef` plus a `commandDigest` over
the exact bytes — neither predecessor defines an argv representation or
a canonical parser, so the pinned bytes remain the identity everywhere:
this contract never re-fingerprints a command, and `command.line`
carries those bytes verbatim in both command-string forms. A #697
`execution.kind: "in-process"` entry pins no command bytes at all; its
identity content is the third form's (`"routine"`, below).

- **`form: "tokenized"`** — `line` plus the argv the runner derives
  from it **exactly once at resolution time** with the fixed,
  quote-aware tokenizer the shipped mechanisms already use
  (`parseShellTokens`, `src/handlers/verification.ts`): single and
  double quotes honored, no expansion, no substitution, no operator
  interpretation — a shell metacharacter is a literal argument byte.
  This is today's execution form for `environment.prepare`,
  `verification.run`, and `dependency.sync`, and the **required** form
  for a pinned-class spec whose origin pins command bytes — a #697
  `"pinned-command"` entry or a #915 command-pinning plan entry: a
  pinned command is never handed to a
  shell interpreter, its digest stays the digest of `line`'s bytes
  (unchanged from #697/#915 approval), and the derived argv is
  recorded in the spec so the backend executes it verbatim and
  re-parses nothing (§4.2). A tokenized spec whose `argv` is not the
  fixed tokenizer's output for its `line` is `"spec-invalid"` (§11.2).
- **`form: "shell"`** — the operator-approved line executed via the
  shell (`/bin/sh -c`), exactly as the shipped guided grant path runs
  it today; the human gate approved these exact bytes, shell semantics
  included. Admissible for operator-owned classes only.
- **`form: "routine"`** — the execution form for a #697 registry entry
  whose `execution.kind` is `"in-process"`, reached directly at #697
  resolution or through a #915 plan entry naming such an entry: a
  fixed, named routine in the runner's own code (#697 §14's
  `dependency.sync` manifest edit is the calibrating case),
  parameterized only by the entry's `input.parser` output, carried in
  `input` as canonical JSON. No command bytes exist: the spec's
  identity content is the routine name plus that canonical input, bound
  into `specDigest` like every other field, and nothing derives an argv
  or consults a shell. Execution realizes #697 §7's rule that an
  `in-process` routine runs in the sandboxed run process, never in the
  orchestrator's: the backend launches the runner's own **routine
  executor** — a runner-owned entry point delivered inside the
  binding's fingerprint boundary, baked into the digest-pinned image on
  `container` and, on `native-sandbox`, launched under the compiled
  profile with its build digest a component of the binding fingerprint
  itself (§4.1, §14.2), so `requestDigest` binds the executor bytes
  like every other backend byte on both isolated backends (§4.2) — as
  the run's command process inside
  exactly the §6 boundary any pinned spec gets: the §6.1 mounts, a
  `constructed` env, the spec's network policy, identity, and limits,
  with §8's supervision, §9's bounded captures, and §10's cleanup
  applying to that process unchanged. The routine dispatches by name
  inside that process; any subprocess it spawns (the `dependency.sync`
  routine's session-pinned command is its only one, #697 §14) is a
  child inside the same boundary and dies with the §8.4 tree.
  Admissible for the pinned classes only — an in-process relaxed entry
  is a #697 pinned substitution, hence `"tool-request.pinned"` (§2) —
  so a routine spec never selects `local` (§13 rule 4) and the
  orchestrator's own in-process code paths stay unrouted (§3). A
  `routine` value absent from the closed #697 registry, or an `input`
  that is not the canonical form of the entry's parser output, is
  `"spec-invalid"` (§11.2).

`form: "shell"` on a pinned-class spec, `form: "routine"` anywhere but
a pinned-class spec, and a pinned-class form that does not match its
originating entry's `execution.kind` — a `"pinned-command"` origin
resolved to anything but `"tokenized"`, an `"in-process"` origin
resolved to anything but `"routine"` — are each `"spec-invalid"`
(§11.2).

### 6.3 Environment and secrets

The spec's `env` carries one of two closed forms (§4.1), chosen at
resolution:

- **`source: "constructed"`** — required on `native-sandbox` and
  `container`: the runner builds `values` from the fixed allowlist
  (#697 §7, `docs/tool-request-redesign.md` §5) — never a `process.env`
  passthrough — a backend adds nothing and inherits nothing, and #916
  §8.3's planted-canary probe is what attests the axis. A constructed
  map never contains credential material; that is what makes the
  no-credentials-in-a-spec rule below satisfiable rather than
  aspirational.
- **`source: "runner-inherited"`** — admissible only on `local` for
  operator-owned classes: the spec records the marker, and the engine
  applies the runner's own ambient process environment at spawn time,
  exactly as the shipped per-class runners spawn today (§4.3) — the
  recorded compatibility baseline, not an enforcement claim. The
  ambient environment — which on an operator's host may well contain
  provider and `gh` credentials — is deliberately modeled as
  execution-time state, never as spec content: it never enters the
  spec, `specDigest`, the run record, or any artifact (§10 rule 1), so
  the M0 byte-identical `local` path never requires a secret-bearing
  spec. `source: "runner-inherited"` on an isolated backend, or on a
  pinned-class spec, is `"spec-invalid"` (§11.2).

Secrets follow #916 §5: provider and `gh` credentials live in their own
stores under `$HOME`, which no isolated backend mounts; no credential
material appears in a spec, a mount, an artifact, or a persisted run
record. On `ec2` (and unclassified-cloud hosts), the IMDS denial demand
of #916 §5.4/S6 applies to every isolated backend's `network: "none"`.

### 6.4 Network

The policy set is closed: `"none"` (default for every class unless the
operation's contract or session policy says otherwise),
`"registry-allowlist"` (metadata reads against the session-configured
registry endpoints only — the #697 `"registry-metadata"` axis, whose
concrete mechanism remains spike S5 of #916), `"package-registry"`
(full-artifact fetch restricted to the same session-configured registry
endpoints — #915 §4's plan vocabulary, e.g. an approved
environment-family `npm ci`, carried into the spec verbatim), and
`"unrestricted"`.

Both registry policies are enforceable from the spec alone. The enum
names the axis; the endpoints are the policy; and §4.2 forbids the
backend from consulting session configuration to learn them — so at
resolution the runner copies the session-configured registry endpoints
into `spec.registryEndpoints` (§4.1), immutable spec content bound into
`specDigest` like every other field. The backend permits egress to
exactly the listed endpoints and nothing else, re-resolving nothing; a
session endpoint change after resolution changes nothing in flight,
because the next resolution is simply a different spec (§4.2). A
`"registry-allowlist"` or `"package-registry"` spec without
`registryEndpoints`, any other policy carrying the field, or an
endpoint bearing userinfo or other credential material (§6.3's
no-credentials-in-a-spec rule) is `"spec-invalid"` (§11.2).

The two registry policies are distinct axes and are
never conflated: a #915 `"plan-approval"` entry pinned
`network: "package-registry"` resolves to a spec carrying
`"package-registry"` — never widened to `"unrestricted"`, never
narrowed or renamed to `"registry-allowlist"` — and it executes only
under a backend whose network axis attests the package-registry
containment capability #915 §9 rule 8 demands. Until the chain lands
that capability (the successor of #916 spike S5), such a spec refuses
`"capability-unattested"` at selection, which §11.3 routes to the
existing `"containment-unavailable"` handling — fail-closed exactly as
#915 §9 already specifies, with the plan's pinned value preserved
intact for the host that can eventually honor it; refusing is the only
alternative to weakening an approved plan's pinned policy, which no
implementation may do. The remaining #915 value `"session-mechanism"`
never reaches a spec: it marks `"session-default"` entries, whose
occurrences run their shipped mechanism under that mechanism's own
class and policy (§3, fourth corollary). `"unrestricted"` is
expressible for operator-owned classes only — a pinned-class
spec carries `"none"`, `"registry-allowlist"`, or `"package-registry"`
and nothing else — and on `container` it still means the container's
own egress namespace, never host-network mode. No isolated backend ever
has a credentialed route to GitHub: the git/GitHub boundary of §3 is
enforced by construction, not by convention.

### 6.5 User identity

On `local` and `native-sandbox` the command runs as the runner's own OS
user (recorded). On `container` the command runs as an unprivileged,
non-root user, with UID/GID mapping arranged so files written to the
worktree and artifact mounts are owned by the runner's user on the host
— a rootless runtime is the preferred arrangement. A spec demanding
`identity.user: "unprivileged"` on a backend that cannot provide it is
refused (`"policy-unenforceable"`), never silently run as root.

### 6.6 Resource limits and the enforcement record

`timeoutMs`, `maxStdoutBytes`, and `maxStderrBytes` are mandatory on
every spec; cpu/memory/pids/scratch caps are optional axes a policy may
set. The result's `EnforcementRecord` states, per axis, `"enforced"`,
`"declared-only"`, or `"refused"`. The axis set is **closed**, shared
by the enforcement record and the §13.2 capability statement; widening
it is a change to this document first:

```ts
type IsolationAxis =
  | "filesystem"                 // §6.1 mounts + writable-path policy
  | "environment"                // §6.3 constructed env, nothing inherited
  | "network"                    // §6.4 policy
  | "user-identity"              // §6.5
  | "process-tree-termination"   // §8.4
  | "timeout"                    // limits.timeoutMs (§8.1)
  | "capture-bounds"             // limits.maxStdoutBytes/maxStderrBytes (§9)
  | "cpu" | "memory" | "pids" | "scratch";  // the optional caps above

type EnforcementValue = "enforced" | "declared-only" | "refused";

// One entry per axis the spec declares: the §6.1–§6.5 axes plus
// "process-tree-termination", "timeout", and "capture-bounds" always;
// "cpu"/"memory"/"pids"/"scratch" iff the spec set the cap. No
// "unknown" value exists here — unknown evaluated as absent at
// selection (§13.2), before anything launched.
type EnforcementRecord =
  Readonly<Partial<Record<IsolationAxis, EnforcementValue>>>;
```

Two rules make it honest:

- **A backend never reports `"enforced"` for an axis it cannot attest.**
  Crediting an isolation axis follows #916 §8.3: behavioral attestation
  on the live host, not configuration opinion. Unattested = declared.
- **`"declared-only"` is admissible only where policy admits `local`**
  (or an explicitly declared-only axis on an isolated backend, e.g. a
  cpu cap the mechanism lacks — never for the filesystem, environment,
  network, or process-tree-termination (§8.4) axes of a
  pinned-class run, which must all be `"enforced"` or the
  request was refused at selection, §13 rule 4).

## 7. Environment preparation and cache ownership

The `environmentPrepare` mechanism — operator contract, timing, deferred
prepare for conflicted dependency files, fail-closed failure handling,
and stamp semantics — is fixed by `docs/environment-prepare-contract.md`
and does not change. This contract adds the backend dimension:

1. **The prepare stamp binds to the backend.** The stamp key gains
   `(backendId, backendFingerprint)` — the fingerprint being exactly
   the binding's `fingerprint` field (§4.1), the same value
   `requestDigest` binds (§4.2): the container image digest on
   `container`, the §14.2 composite of compiled sandbox-profile digest
   and runner/routine-executor build digest on `native-sandbox`, the
   literal `"host"` on `local`. Artifacts built under one backend are
   never presumed valid under another — a `node_modules` tree built
   inside a Linux container is not the host's — so a backend or image
   change invalidates the stamp exactly as a command change does; on
   `native-sandbox` an executor-build upgrade invalidates it too,
   conservative by construction, because a new build is new executed
   backend code (§14.2).
2. **Caches are runner-owned and trust-domain-scoped.** An operation
   class declares cache mounts by cache id; the runner materializes
   them under its own cache root, keyed `(cacheId, backendId)`. A cache
   written in one trust domain is never mounted into another —
   `container`-domain bytes never feed a `local` run and vice versa —
   because a writable cache is an injection channel between runs, and
   cross-domain reuse would let the least-trusted run poison the
   most-trusted one. Within one domain, reuse across runs and issues is
   the point of the cache. The pinned classes are excluded entirely:
   they declare no cache id and receive no `kind: "cache"` mount,
   because #697 §7's write boundary outranks cache reuse (§6.1).
3. **No package manager appears in this contract.** The interface
   carries command bytes with their declared execution form (§6.2),
   mounts, caches, and `cacheKeyFiles`-derived
   stamps only; npm, pnpm, pip, cargo, and every peer are session-side
   configuration (`docs/environment-prepare-contract.md` §4's presets).
   Planned verification and environment preparation run through the
   backend without the contract naming any language's tooling.
4. **Prepare sentinels never live in projected Git metadata or the
   worktree.** The shipped worktree-lifetime sentinel
   (`src/handlers/environment-prepare.ts`) lives inside the worktree's
   admin dir under the host common Git directory — exactly the state
   §6.1 excludes from every isolated run, and writable cross-run state
   besides, which the read-only ephemeral projection cannot carry and
   the worktree must not: a sentinel the run itself can rewrite is a
   forgeable prepare-skip. For every prepare run under an isolated
   backend, the sentinel — and any equivalent prepare marker — is
   therefore written to backend-managed runner state or the artifact
   root, outside both the projected Git metadata and the worktree,
   keyed by the worktree instance identity the shipped sentinel keys
   on plus rule 1's `(backendId, backendFingerprint)` binding.
   Lifecycle and cleanup are owned by the runner, never by a run: the
   runner writes the sentinel at the boundary after a successful
   prepare and invalidates it when it prunes or recreates the
   worktree, so the shipped worktree-lifetime semantics survive by
   keying, not by co-location, and a run's own writes stay inside its
   §6.1 writable set. On `local` the shipped placement is the M0
   baseline, unchanged (§16); relocation is owned by the migration
   stage that first executes `environment.prepare` under an isolated
   backend.

## 8. Time and death: timeout, heartbeat, cancellation, termination, recovery

### 8.1 Timeout

The runner's deadline (`spec.limits.timeoutMs`) is authoritative. A
backend able to impose its own inner bound (the shipped `timeout` option;
a container runtime's stop timeout) imposes it as a second line, but
expiry of the runner deadline begins the §8.4 kill sequence regardless,
and the outcome is `"timeout"` with partial captures retained.

### 8.2 Heartbeat

While a run is `running`, its run record carries a `heartbeatAt`
refreshed at a bounded interval by whichever process supervises the
child. Heartbeats exist for **observability and recovery triage only**:
a stale heartbeat makes a run a reconciliation candidate (§8.5), but no
run is ever killed for heartbeat staleness alone — the identity witness
decides. The shipped synchronous local engine satisfies this trivially
(supervisor and child die together, which is exactly what §8.5 detects).

### 8.3 Cancellation

Cancellation is requested through the run record (a CAS'd flag — the
cooperative-stop precedent of task cancellation, issue #608) and honored
at the backend layer: the supervisor observes the flag and enters the
§8.4 sequence. Outcome `"cancelled"`. Cancellation is cooperative first
and forceful second, never forceful first.

### 8.4 Process-tree termination

Termination targets the **tree**, never just the direct child — and a
mechanism is credited with tree death only where it structurally owns
the tree. **Process-group signalling alone is not a tree-death
guarantee**: a descendant that calls `setsid()` (or `setpgid()`) moves
itself out of the process group and survives group-wide
SIGTERM/SIGKILL. Tree termination is therefore an explicit §6.6
enforcement axis, credited per backend as follows:

- `container`: the runtime's stop (bounded grace) then kill, followed
  by container removal — the pid namespace makes tree death structural
  rather than best-effort, so the axis is `"enforced"` by construction.
- `local` / `native-sandbox`, from §16 M1 (the stage that introduces
  the supervised launch; the M0 `local` baseline keeps the shipped
  direct-child `timeout` semantics and claims nothing about trees):
  the child is launched in its own process group **inside a
  kernel-owned tree boundary wherever the platform provides one** — on
  the Linux family a per-run cgroup (v2 `cgroup.kill`), a PID
  namespace, or a subreaper-supervised process set; which concrete
  mechanism may be credited where stays governed by #916 §8.2/§12.2's
  spikes. Termination signals the group (SIGTERM), waits a bounded
  grace, SIGKILLs the group, and then terminates by **boundary
  membership**, so a `setsid()` escapee dies with the tree. Only a
  boundary-backed sequence may report the axis `"enforced"`, only on
  an isolated backend (`local` records every axis `"declared-only"`,
  §14.1 — a boundary used there is defense in depth, never credit),
  and only through a #916 §8.3 behavioral canary (an escapee probe
  observed to die with its run).
- Where no such boundary exists (notably `macos`, which offers process
  groups but no cgroup/PID-namespace equivalent), group signalling is
  the best effort actually made and the axis is `"declared-only"` —
  recorded honestly, never presented as tree death. That is admissible
  exactly where §6.6 admits declared-only: always on `local`, and on
  `native-sandbox` for operator-owned classes. A
  pinned-class run never accepts it: enforced tree
  termination is part of the §13 rule 4 floor, so a backend that
  cannot enforce the axis on the live host refuses the pinned run
  (`"policy-unenforceable"`) rather than risk leaving a detached
  descendant alive with worktree and cache access.

A tree that demonstrably survives the sequence on any backend is an
`infrastructure` fact recorded on the result, not silently ignored.

### 8.5 Stale-run recovery

Crash recovery consumes run records, at startup and on an admin surface
(the worktree-recovery precedent):

1. A record in a non-terminal state is a candidate.
2. Its identity witness is checked against the live host: pid + pgid +
   process start time (a recycled pid with a different start time is
   **not** the run) — plus, where the run recorded a §8.4 tree
   boundary, residual boundary membership: a process still inside the
   run's recorded cgroup/namespace is the run's, whatever its pgid,
   and recovery may kill it by membership — or container id +
   `ai-cli-loop.run-id` label.
3. Witness alive → the run is still running; a stale heartbeat is
   reported, nothing is killed.
4. Witness dead or mismatched → the record is marked `lost`, residue is
   cleaned by label, by recorded path, and by recorded tree boundary —
   orphan containers are enumerable by label, which is why every
   container carries `ai-cli-loop.run-id`, `ai-cli-loop.spec-digest`,
   and `ai-cli-loop.request-digest` labels — and the §10 forensic set
   is retained.
5. Recovery never guesses: nothing is killed by process name, argv
   pattern, or image name. No witness match, no kill.
6. **A dead witness on a boundary-less run speaks only for what it
   witnessed.** Where the run's tree-termination axis was
   `"declared-only"` (§8.4 — no kernel boundary, group signalling
   only), marking the record `lost` asserts the death of the recorded
   pid/pgid, not of every descendant: a `setsid()` escapee is outside
   the witness by construction. The persisted axis value is the durable
   warning, so nothing downstream reads `lost` as "no process of this
   run survives"; whatever residue *is* positively enumerable is still
   cleaned under rule 5's no-guessing constraint.
7. **A pre-launch record is never `lost`.** `lost` asserts an unknown
   fate; a candidate whose record proves no spawn was ever attempted
   has a known one. A record still in `resolved`, `validated`, or
   `provisioned` never reached the `launching` intent that §12 rule 2
   orders before every spawn, so recovery closes it `infrastructure`
   (disposition `"never-launched"`): nothing executed, provisioned
   residue is cleaned per §10, and the forensic set is retained as for
   any failed run. A record in `launching` is ambiguous by default —
   the crash may sit between the spawn and the witness write — and
   resolves by evidence, never optimism: on `container`, the witness
   id recorded at `provisioned` makes it decidable — the runtime
   reports a created-but-never-started container (§14.3), which proves
   no start (`"never-launched"`), while a started one is handled under
   rules 2–4 like any witnessed run — whereas on a process backend a
   witness-free `launching` record stays `lost`, with rule 6's caveat
   sharpened: for such a record the witness covered nothing, so `lost`
   asserts nothing beyond the recorded intent.

The shapes recovery consumes and returns — the run record being the §2
durable row the backend maintains through every §5 transition:

```ts
type IdentityWitness =                    // §2; process: recorded at launch;
                                          // container: recorded from
                                          // `provisioned` on — the id exists
                                          // before start (rule 7)
  | { kind: "process";                    // "local" / "native-sandbox"
      pid: number;
      pgid: number;
      startedAt: string;                  // process start time, recorded
                                          // verbatim — a recycled pid with a
                                          // different start time is NOT the
                                          // run (rule 2)
      treeBoundary?: string }             // the recorded §8.4 boundary ref
                                          // (cgroup path / namespace), where
                                          // one was used
  | { kind: "container";                  // "container"
      containerId: string };              // paired with the
                                          // ai-cli-loop.run-id label (rule 4)

interface ExecutionRunRecord {
  runId: string;
  specDigest: string;
  requestDigest: string;                  // §4.2 persisted execution identity
  backendId: ExecutionBackendId;
  fingerprint: string;                    // the §4.1 binding fingerprint
  operationClass: ExecutionOperationClass;
  state: ExecutionRunState;               // last state entered (§12 rule 2)
  stateHistory: readonly {                // append-only (§12 rule 1)
    state: ExecutionRunState;
    at: string;                           // recorded before the action (§5)
  }[];
  witness?: IdentityWitness;              // process: from `launched` on;
                                          // container: from `provisioned`
                                          // on (rule 7)
  heartbeatAt?: string;                   // maintained while `running` (§8.2)
  cancelRequested: boolean;               // the §8.3 CAS'd flag
  enforcement?: EnforcementRecord;        // persisted at launch — what the
                                          // launch actually arranged — so
                                          // rule 6 can read the
                                          // process-tree-termination axis
                                          // after a crash
  hostGuestPaths?: readonly {             // §6.1 host↔guest map ("container")
    hostPath: string;
    guestPath: string;
  }[];
  outcome?: ExecutionOutcome;             // present iff `state` is `done`
}

type ReconcileOutcome =
  | { disposition: "still-running";       // rule 3: witness alive —
      staleHeartbeat: boolean }           // reported, nothing killed
  | { disposition: "never-launched";      // rule 7: the record's state or
                                          // backend evidence proves no
                                          // spawn occurred; run closed
                                          // `infrastructure`, nothing ran
      residueCleaned: boolean }
  | { disposition: "lost";                // rule 4: witness dead/mismatched;
                                          // the §10 forensic set retained
      residueCleaned: boolean }           // false ⇒ §10 rule 3: recorded,
                                          // left enumerable for the next pass
  | { disposition: "already-terminal" };  // not a rule-1 candidate; no-op
```

## 9. Bounded capture and artifact collection

Stdout and stderr are captured per stream up to `maxStdoutBytes` /
`maxStderrBytes`. A backend that can truncate without killing reports
`truncated: true` with the observed `totalBytes` and keeps the run alive;
the shipped local engines' behavior — `maxBuffer` overflow surfaces as a
spawn-level failure, through the error path's captured stderr on the
default-runner classes and appended to stderr with the separate
`spawnError` on the grant path (§4.3) — is the recorded compatibility
baseline, preserved verbatim on `local`, per class. On the isolated
backends, runner-synthesized bytes are never mixed silently into child
output: the `spawnDiagnostic` seam keeps them separable, exactly as the
shipped `spawnError` contract does. On `local` the seam is populated
only where that shipped contract exists (`tool-request.granted`); an
absent diagnostic on a default-runner class is the baseline, not a gap.

Artifact collection is a **pull by the runner** from the run-artifact
mount after termination — a backend pushes nothing anywhere. The run's
directory (`<artifactRoot>/runs/<runId>/`, the shipped layout) gains
`execution-result.json`: the serialized `ExecutionResult` plus the
redacted spec form (§10). Artifact paths are local-only and never appear
verbatim on public surfaces; the redaction posture of
`docs/environment-prepare-contract.md` §2.7 applies unchanged.

## 10. Cleanup guarantees and retained forensic evidence

Cleanup is **idempotent and runs on every exit path** — `ran`, `timeout`,
`cancelled`, `refused`, `infrastructure`, and `lost` alike. What is
destroyed and what is retained is fixed:

| Destroyed | Retained (bounded, local-only) |
| --- | --- |
| The container and its writable layer; anonymous volumes; scratch space; compiled sandbox profiles; the §6.1 Git metadata projection; the provisioned-but-never-launched residue of a refusal | `execution-result.json` (outcome, exit code, the §11.2 refusal payload on a refused run, bounded captures, enforcement record, timeline, host↔guest path map); the redacted canonical spec + `specDigest` + the `requestDigest` execution identity (§4.2); the run record with its full state history |

Rules:

1. **The persisted spec form is redacted.** Environment *values* are
   never persisted — for a `constructed` env, names plus a per-variable
   digest at most (the #915 invariant-10 posture); a `runner-inherited`
   env persists the marker alone, because the ambient bytes never
   entered any resolved or persisted shape to begin with (§6.3), so
   there are not even names to redact. Command bytes are retained in the local
   artifact only (the grant-artifact precedent, issue #301): local
   artifacts are operator-eyes surfaces, public surfaces get outcome
   categories and counts.
2. **Worktree contents are not cleanup's business.** Whatever a run
   wrote inside the worktree stays for the phase contract that follows
   — verification judgment, the guided flow's
   `commit`/`keep`/`discard` dispositions, #697 §7 step 5's
   failed-relaxed-run handling — exactly as today.
3. **Cleanup failure is recorded, never masking.** A failed cleanup
   emits its own event and leaves residue enumerable (by label, by
   recorded path) for the next reconcile pass; it never rewrites the
   run's outcome (the phase-runner's ledger posture).
4. Failed and `lost` runs retain the same forensic set as successful
   ones — recovery and diagnosis read the same shape everywhere.

## 11. Outcome and error taxonomy

### 11.1 The outcome set is closed

```ts
type ExecutionOutcome =
  | "ran"             // launched, exited by itself; exitCode present
  | "timeout"         // the runner deadline killed it
  | "cancelled"       // an explicit cancellation killed it
  | "refused"         // pre-launch refusal; nothing executed
  | "infrastructure"  // backend/runtime failure, never the command's
  | "lost";           // fate unknown; assigned only by reconciliation
```

Determinism rules: `"ran"` carries the exit code and passes **no
judgment** — command-level success and failure stay the consuming
contract's business (a nonzero `npm test` is a verification result, not
a backend error). Post-launch, the first terminator recorded on the run
record wins: a timeout that fires during a cancellation grace is still
`"cancelled"`, because the cancellation entered `terminating` first. A
post-launch backend/runtime failure ends the run `"infrastructure"`
through `collecting` (§5 rule 2) only where no terminator was recorded
first; after one was, the terminator's outcome stands and the
collection failure is recorded on the result.
Pre-launch, a failure is `"refused"` when a validation rule names it and
`"infrastructure"` otherwise. `"lost"` never comes out of `execute()`.

### 11.2 Refusal reasons are closed

```ts
type ExecutionRefusalReason =
  | "backend-unavailable"    // selected backend not present/operational
  | "capability-unattested"  // required axis lacks #916 §8.3 attestation
  | "policy-unenforceable"   // an axis the backend cannot enforce or
                             // admissibly declare
  | "spec-invalid"           // malformed/inadmissible spec (e.g.
                             // form: "shell" on a pinned class,
                             // form: "routine" off the pinned classes
                             // or naming an unregistered routine (§6.2),
                             // a tokenized argv that is not the
                             // fixed tokenizer's output for its line,
                             // or a runner-inherited env off `local`
                             // or on a pinned spec, §6.3)
  | "mount-unresolvable"     // a declared hostPath missing or illegal
  | "image-unpinned";        // container binding without a digest

interface ExecutionRefusal {
  reason: ExecutionRefusalReason;
  detail: string;                    // operator-eyes diagnostic, recorded in
                                     // the run artifact via the result's
                                     // `refusal` field (§4.3, §10) — never
                                     // a public surface (§10 rule 1)
  axes?: readonly IsolationAxis[];   // for "capability-unattested" /
                                     // "policy-unenforceable": the §6.6 axes
                                     // that failed
}
```

`selectBackend` (§13.1) and `validate()` (§4.3) refuse with this same
shape, and a run refused during the lifecycle ends with the same shape
on its result: a refused `ExecutionResult` carries the refusal verbatim
in its `refusal` field — required whenever `outcome` is `"refused"`,
absent otherwise (§4.3) — so `execution-result.json` persists the
reason for every refused run (§10) rather than a bare
`outcome: "refused"`. §11.3 routes on `reason` alone — `detail` and
`axes` are diagnostics for the artifact and the #916 §10 capability
report, never routing inputs.

### 11.3 Consumption by the existing phase runner

Backend outcomes are consumed **inside handlers**; this contract adds no
new `PhaseRunOutcome` member, no new `PhaseHandlerResult` shape, no new
`TierRefusalReason` member, and no new task status. The mapping:

| Class | `ran` (exit 0) | `ran` (nonzero) / `timeout` | `refused` / `infrastructure` | `lost` |
| --- | --- | --- | --- | --- |
| `environment.prepare` | `run` outcome + stamp, as today | Fail-closed phase stop, `environment_prepare_failed`, no stamp — `docs/environment-prepare-contract.md` §2.6 verbatim | Same fail-closed stop; the refusal reason is recorded in the artifact; **never** a silent fallback to another backend | Same, after reconciliation; no stamp |
| `verification.run` | Verification output consumed exactly as today | Verification failure exactly as today | Fail-closed phase failure naming the reason — an unsatisfiable isolation policy is an operator configuration problem, not an agent boundary | Same, after reconciliation |
| `dependency.sync` | As today (shipped route) | As today | As today for the shipped route; the relaxed route inherits #697 | Human handoff |
| `tool-request.granted` | Recorded in the grant artifact (issue #301) as today | Same — the guided flow's dispositions judge it | Human handoff with the refusal recorded | Human handoff |
| `environment.pinned` | The `environment.prepare` row's success semantics — run outcome plus the `docs/environment-prepare-contract.md` §2.4 stamp — with the #915 `stamp-gated` reservation settled alongside (§12 rule 5) | The `environment.prepare` row verbatim: fail-closed phase stop, `environment_prepare_failed`, no stamp; the settled reservation occupies its window, and the next window is the retry path (#915 §10) | Same route as `tool-request.pinned`: `"containment-unavailable"` through the same three reasons, falling through #915 §9's ordinary refusal chain — never a fallback to the shipped mechanism or another backend | Fail-closed as `environment.prepare`, after reconciliation; no stamp; the reservation stays consumed (§12) |
| `verification.pinned` | Verification output consumed by the shipped bounded repair loop within its existing cycle cap — the `verification.run` row, with the #915 `per-verification-cycle` reservation settled alongside (§12 rule 5); out-of-enumeration writes taint the run (#915 §10) | Verification failure exactly as the `verification.run` row — the same repair loop judges it, within the same cap | Same as `environment.pinned` | Fail-closed verification failure, after reconciliation; the reservation stays consumed (§12) |
| `tool-request.pinned` | #697 §7 effect verification proceeds | Human handoff per #697 §7 step 5, diff left in place | `"containment-unavailable"` (#697 §6 rule 4) — the existing refusal, reached through `"backend-unavailable"` / `"capability-unattested"` / `"policy-unenforceable"` | Human handoff; the #915 reservation stays consumed (§12) |

The three pinned rows differ by design: a `"plan-approval"` occurrence's
class carries its plan entry's `family` (§2, §3), and execution
preserves that family's #915 §10 semantics end to end. A report-only
`environment` or `verification` entry keeps its stamp-gated and
per-verification-cycle outcomes — feeding the environment stamp and the
bounded repair loop exactly as its shipped counterpart's row does — and
never enters #697 §7 effect verification or its nonzero/timeout human
handoff, which belong to the adopt-changes `tool-request` family alone.
What the pinned classes share is the execution floor (§13 rule 4) and
the at-most-once reservation discipline (§12 rule 5), never the outcome
consumption.

One recovery distinction keeps the `lost` column honest: a run that
recovery closes `"never-launched"` (§8.5 rule 7) follows the
`refused`/`infrastructure` column, never the `lost` column — the crash
is an infrastructure fact about a command that provably never spawned,
and for a pinned class §12 rule 5 settles the occurrence
reservation with that definite outcome instead of leaving the
ambiguous-reservation human park to a run that never executed.

## 12. Idempotency and crash/retry behavior

1. **A `runId` is one attempt; retries are new runs.** The run record's
   state history is append-only; a crash leaves the record in the last
   state entered, which is exactly what reconciliation consumes.
2. **Record-then-act — intent before action, witness after.** Every
   irreversible action is preceded by a persisted intent state (the
   `launching` intent commits before the spawn, §5), so no crash
   window leaves an unrecorded live process: a process can exist only
   if a record says one might. The converse binds equally: a state
   that asserts an observed fact is persisted only with its evidence
   in hand — `launched` is written after the spawn returned, witness
   included — so no record ever claims a witnessed launch that never
   happened, and §8.5 rule 7 can tell a crashed intent from a lost
   run.
3. **Retry is the caller's decision, never the backend's.** A backend
   never auto-retries; the phase scheduler and the operation's own
   contract own retry semantics, unchanged.
4. **What makes retry safe is effect confinement.** For operator-owned
   classes, a rerun over the same spec is safe because all effects live
   in the writable set and the judging contracts (stamps, verification
   judgment, grant dispositions) already tolerate reruns.
5. **The pinned classes stay at-most-once.** The #915 occurrence
   reservation — taken per the entry's family window: the stamp
   identity for `environment.pinned`, the verification-cycle identity
   for `verification.pinned`, the task-attempt identity for
   `tool-request.pinned` (#915 §10) —
   is committed before launch and an unsettled reservation
   counts as consumed across a crash — #915's rule, restated not
   redefined — so a `lost` pinned run routes per its class's §11.3
   `lost` column rather
   than silently re-executing. A crash the record proves pre-launch is
   the deliberate exception to that *ambiguity*, not to the rule: a
   pinned run that recovery closes `"never-launched"` (§8.5 rule 7) has
   a definite fate — nothing spawned — so recovery settles the
   reservation with the run reference and `infrastructure` outcome
   through #915 §11's ordinary settlement port, in the recovery
   transaction that closes the run record, instead of leaving a
   dangling ambiguous reservation parked for a human. The settled
   window stays occupied — #915 §10: a settled reservation occupies
   its window regardless of outcome, and the next task attempt or
   verification cycle is the retry path — so at-most-once is
   untouched; the distinction removes only the false "may have
   executed" classification of a command that never spawned. (A
   reservation with no run record at all remains #915's
   dangling-ambiguous case — this distinction needs the record's
   evidence.)
6. **`lost` is honest, not optimistic.** A `lost` run adopts nothing,
   stamps nothing, and verifies nothing; whatever it wrote inside the
   worktree is visible to the phase contract exactly like any other
   dirty state.

## 13. Capability negotiation and fail-closed backend selection

### 13.1 Selection is a pure runner function

`selectBackend(operationClass, sessionPolicy, hostCapabilities) →
BackendBinding | ExecutionRefusal`, evaluated per occurrence at
resolution time, consuming resolution-time probes (#916 §9 rule 7's
memoization discipline — never a stored report, #916 §10.2).

Numbered rules; implementation slices cite them by number.

1. **No agent-authored byte is an input.** The inputs are session
   configuration, the operation class, and the host capability probes —
   a closed set. Issue text, Tool Request text, PR content, plan
   nominations, and agent transcripts can nominate *operations* (#915's
   contribution layers), never name a backend, an image, a mount, or a
   policy value; backend-shaped content anywhere in agent-authored
   material is inert. **AI agents receive no ability to select a weaker
   backend** — or any backend.
2. **Fail-closed, per class.** Session policy assigns each operation
   class a backend requirement. A requirement the host cannot satisfy —
   backend absent, capability unattested, axis unenforceable — refuses
   with the §11.2 reason and routes per §11.3. It never selects a
   weaker backend, and absence of a container runtime is an ordinary
   refusal for policies that demand one, not an error for anyone else:
   **container execution is optional per policy, never assumed to
   exist**.
3. **No silent downgrade, ever.** A backend refusal or infrastructure
   failure never triggers re-selection within the same occurrence; a
   policy change is an operator act. There is no "fall back to local"
   path anywhere in this contract — a run either executes under the
   selected binding or refuses out loud. (Raising isolation is equally
   explicit: policy edits, not runtime improvisation.)
4. **A pinned class never selects `local`.** The requirement floor of
   every pinned class — `environment.pinned`, `verification.pinned`,
   `tool-request.pinned` alike —
   is an isolated backend whose filesystem, environment, network,
   and process-tree-termination (§8.4) axes are behaviorally attested
   (#916 §8.3); anything less
   was already `"containment-unavailable"` at #697/#915 resolution. The
   floor is not session-configurable downward — no configuration value
   exists that would express it.
5. **Compatibility default.** Every operator-owned class defaults to
   `local` — current behavior on compatible trusted installations, per
   the #916 §3 trust story — and an operator may raise any class to an
   isolated backend per session.

### 13.2 Backend capabilities are probed, not asserted

`capabilities()` reports, per isolation axis, whether the backend can
enforce it **on this host, now**: runtime present and answering, image
resolvable by digest, sandbox mechanism present, and — for every axis
credited toward a pinned-class floor — the #916 §8.3
behavioral canary observed. Unknown evaluates as absent, probes fail
closed, and a probe that errors or times out yields absent (#916 §9
rule 5, unchanged). Capability output feeds selection and the #916 §10
capability report's diagnostics; it never authorizes anything by itself.

The shape — over the §6.6 closed axis set:

```ts
type AxisCapability =
  | "attested"        // enforceable now AND the #916 §8.3 behavioral canary
                      // observed on this host — the only value creditable
                      // toward a pinned-class floor (§13 rule 4)
  | "enforceable"     // mechanism present and answering; no canary observed —
                      // never credited where attestation is required
  | "declared-only"   // the backend can record the axis, not enforce it
  | "absent";         // mechanism missing — and what unknown, a probe error,
                      // and a probe timeout all evaluate to

interface BackendCapabilities {
  backendId: ExecutionBackendId;
  available: boolean;                  // operational on this host, now:
                                       // runtime present and answering /
                                       // sandbox mechanism present; false ⇒
                                       // "backend-unavailable" at selection
  fingerprint?: string;                // the resolvable §4.1 binding
                                       // fingerprint (image digest / the
                                       // §14.2 profile+executor-build
                                       // composite / "host"); absent ⇒
                                       // no binding is constructible and
                                       // selection refuses ("image-unpinned"
                                       // on `container`,
                                       // "backend-unavailable" on
                                       // `native-sandbox`, §4.1)
  axes: Readonly<Record<IsolationAxis, AxisCapability>>;
}
```

## 14. Backend profiles

### 14.1 `local`

The compatibility baseline: the shipped per-class `CommandRunner`
semantics, command forms, and `runner-inherited` spawn environment
(§4.3, §6.2, §6.3)
behind the §4 interface, byte-identical (§16 M0). Enforcement record:
every axis `"declared-only"`. Admissible for operator-owned classes
under session policy; never for a pinned class (§13 rule 4).
`local` is not a lesser backend being tolerated — it is the correct
backend for trusted single-operator installations, and keeping it
first-class is an acceptance criterion of this design.

### 14.2 `native-sandbox`

#697 §7's enforcing sandbox realized as a backend, over the #916 §8.2
candidate mechanisms (Seatbelt on `macos`; Landlock/seccomp/
user-namespace tools on the Linux family — spikes S1/S4/S5/S7 govern
what may be credited where). Each axis is credited only through a
passed canary on the live host; an axis without one is `"refused"` or
`"declared-only"` per §6.6, and a pinned-class floor without
full attestation refuses at selection. Primary consumer: pinned
substitutions and `"plan-approval"` occurrences; operator-owned classes
may also select it where attested.

The backend's binding fingerprint is the canonical composite of the
compiled sandbox-profile digest **and** the exact runner/routine-executor
build digest (§4.1). On `container` the executed backend code is baked
into the digest-pinned image, so the image digest alone identifies it;
on `native-sandbox` the code that launches, supervises, and — for
`form: "routine"` specs — *is* the run's command process is the
runner's own build, which no profile digest identifies. Compositing
both digests makes `requestDigest` (§4.2) bind the full fingerprint
and distinguish two executor builds under one profile: different
executed backend code never shares an execution identity, and the §7
stamp — keyed on the same fingerprint — is invalidated by an executor
upgrade exactly as by a profile change (§7 rule 1). A binding either
of whose digests is unresolvable is not constructible, and selection
refuses `"backend-unavailable"` (§4.1, §13.2).

### 14.3 `container`

Per-operation (or per-run) Docker/Podman isolation on the same host:

- One container per run, created from the binding's **digest-pinned
  image**, labeled `ai-cli-loop.run-id` / `ai-cli-loop.spec-digest` /
  `ai-cli-loop.request-digest`, removed on cleanup. No long-lived
  execution containers, no reuse.
- Rootless runtime preferred; the command runs unprivileged (§6.5).
- The container receives exactly the §6.1 mounts. **It never receives
  the container runtime socket, the SQLite store, session
  configuration, `$HOME`, the host common Git directory (Git metadata
  arrives only as §6.1's credential-stripped projection), or
  credentials of any kind** — which is what
  makes the §3 git/GitHub rule structural: no authenticated Git or
  GitHub side effect — a push, a comment, a credentialed API call —
  can succeed from inside, even if the command invokes `git` or `gh`.
  Under the registry-scoped and denied policies — `"none"`,
  `"registry-allowlist"`, `"package-registry"` — there
  is additionally no GitHub route at all; the operator-only
  `"unrestricted"` policy (§6.4) still admits unauthenticated public
  requests, so the guarantee is no authenticated side effects, never
  "`gh` cannot execute".
- Network per §6.4; `"none"` must demonstrably cover IMDS on `ec2` and
  unclassified-cloud hosts (#916 S6).
- The runner talks to the runtime from outside (§15.4); container
  liveness is supervised through the runtime API, and recovery
  enumerates orphans by label (§8.5).

## 15. Single-host packaging and persistence layouts

### 15.1 The component inventory

What must land somewhere on the one host: the runner CLI (`dist/cli`,
invoked by n8n's Execute Command nodes per `docs/install.md` §4), the
private n8n node (`docs/private-node-distribution.md`), the n8n service
itself, the canonical repositories and the per-issue worktree root, the
SQLite database (default `~/.config/n8n-ai-cli-loop/dev_loop.db`), the
artifact root, the §7 cache root, and — when the `container` backend is
in policy — the container runtime and its image store.

### 15.2 The layouts

| Layout | Shape | Backend availability | Position |
| --- | --- | --- | --- |
| **P1 — native host services** | n8n and the runner run natively, exactly as `docs/install.md` describes; the container runtime is an optional host service the native runner drives from outside | `local` everywhere; `native-sandbox` where attested; `container` where a runtime is present | **Recommended baseline.** Matches every #916 target; on `ec2`, state lives on the EBS volume |
| **P2 — containerized n8n (combined control-plane container)** | One long-lived container holds n8n + the CLI + the private node; repositories, worktrees, SQLite, and artifacts live on bind-mounted persistent volumes | `local` (meaning: inside the combined container); `native-sandbox` only as attestable inside it (kernel-feature dependent, fail-closed); **`container` refuses** (`"backend-unavailable"`) | Viable for deployments that want n8n packaging convenience and accept that the combined container *is* the trust boundary. Granting it host-runtime access to launch siblings would put a runtime socket inside the box that also runs agent CLIs — exactly the exposure §15.4 forbids — so it is refused, not worked around. A mediated sibling-launcher is future work, recorded not designed |
| **P3 — containerized n8n + native runner (split)** | n8n containerized as a pure trigger; the runner stays native; Execute Command is replaced by a host-side invocation bridge | As P1, once a bridge exists | Recorded as viable, **not designed this cycle**: the bridge is a new inbound surface on the host (#916 §5.1's egress-only posture), and nothing in the current tree provides it |

### 15.3 Persistence rules

All durable state — repositories, the worktree root, the SQLite
database, artifacts, caches — lives on **persistent local storage** (the
EBS volume on `ec2`), on a filesystem meeting #916 §5.1's row: POSIX
semantics, working advisory locks, atomic rename. The SQLite database is
never placed inside a container writable layer, never on a network or
interop filesystem, and never mounted into any execution container
(§6.1). Container images are cache, not state: rebuildable from pinned
digests. **No PostgreSQL, no S3, no remote workers, and no distributed
leases are introduced in this design cycle** — single-host is the design
premise (#916 §4), and each of those is a rejected non-goal here exactly
as multi-host substrates are there; revisiting any of them is a change
to this document first.

### 15.4 The socket rule

**The container-runtime socket is never mounted into, proxied into, or
otherwise reachable from any execution container, nor from any process
an execution container can start.** Socket access is root-equivalent on
the host; handing it to untrusted execution would dissolve every
boundary in §6 at once. The runner drives the runtime from outside the
containers it creates. This rule has no exception in any layout: P2
refuses the `container` backend precisely because satisfying it there
would require breaking this rule or building the mediated launcher this
cycle does not design.

## 16. Migration path — the local backend is preserved first

Stages ship independently and in order; each leaves the loop fully
operational. M0 changes no observable behavior; every later stage's
behavior column names exactly what it changes — in particular the §8.4
supervised launch is deliberately M1's recorded change, never smuggled
into M0's byte-identical promise.

| Stage | Content | Behavior change |
| --- | --- | --- |
| **M0 — the seam** | Introduce the §4 interface; register `local` as the only backend; route `environment.prepare`, `verification.run`, `dependency.sync`, and `tool-request.granted` through it | **None — byte-identical.** Same per-class spawn semantics and command form — each class keeps its shipped runner and execution shape (§4.3, §6.2) — same environment (the `runner-inherited` form: the runner's own ambient env applied at spawn, never carried in the spec, §6.3), same timeout/`maxBuffer`, same artifacts, same events; equivalence is pinned by tests before anything else lands. The §8.4 supervised group/boundary launch expressly does **not** apply at M0: the shipped `execFileSync`/`spawnSync` engines create no dedicated process group, and M0 keeps their direct-child `timeout` kill semantics verbatim |
| **M1 — lifecycle** | Run records, timelines, heartbeats, §8.5 reconciliation, `execution-result.json`, the admin recovery surface, and the supervised `local` launch (§8.4): asynchronous spawn in a dedicated process group, inside a kernel tree boundary where the platform provides one | Additive observability plus **one recorded behavioral change**: `local` timeout and cancellation now terminate the §8.4 group/boundary instead of the shipped direct child only. Per-class capture semantics (§4.3, §9), outcomes, and routing unchanged |
| **M2 — `container`** | The §14.3 engine, image pinning, cache/stamp backend binding (§7), session policy to raise operator-owned classes | Opt-in per session policy; default remains `local` |
| **M3 — `native-sandbox`** | The §14.2 engine with #916 §8.3 canaries; the pinned classes become executable where attested | Nothing subtracts: hosts without attestation keep refusing `"containment-unavailable"` exactly as #697/#915/#916 already specify |
| **M4 — capability wiring** | `capabilities()` feeding the #916 §10 report and `admin session-doctor`; the V4 validation-plan step becomes runnable | Diagnostics only |

The ordering is the acceptance boundary: **local execution remains
possible for compatible trusted installations** from M0 onward and
forever after; isolation arrives as capability, never as a prerequisite
for the base loop.

## 17. Implementation decomposition proposal

Proposed slices over this contract, for the chain's later issues (#918
onward — the tracker, not this document, assigns numbers):

| Slice | Content | Depends on |
| --- | --- | --- |
| D1 | The §4 types + `local` engine + M0 routing, with byte-equivalence pins over the shipped `CommandRunner` paths | — |
| D2 | Run records, lifecycle persistence, heartbeats, the §8.4 supervised launch and tree boundary, §8.5 reconciliation, admin recovery surface | D1 |
| D3 | `selectBackend` as a pure core function + the session-policy schema (per-class requirements), fail-closed load validation | D1 |
| D4 | The `container` engine: image pinning, labels, mounts, identity mapping, tree termination, cleanup | D2, D3 |
| D5 | Cache root + stamp backend-binding (§7) | D4 |
| D6 | The `native-sandbox` engine + per-axis canaries (#916 spikes S1/S4/S5/S6/S7 land here or block their axes) | D2, D3 |
| D7 | `capabilities()` → #916 §10 report wiring + doctor surfaces (V4) | D3, and D4/D6 for probed axes |
| D8 | Packaging: `docs/install.md` additions for P1's optional runtime, P2's volume contract | D4 |

## 18. Invariants

1. The backend id set is closed — `local`, `native-sandbox`,
   `container` — and the operation class set is closed (§2); widening
   either is a change to this document first.
2. Every routed execution consumes a resolved, immutable spec; the
   backend re-resolves nothing and consults no configuration, plan, or
   store of its own (§4.2). Command identity is the configured or
   pinned string bytes — the bytes every #697/#915 digest already binds
   to — and tokenization derives an execution argv without ever
   re-fingerprinting them (§6.2). A #697 `in-process` entry routes as a
   `form: "routine"` spec — pinned classes only, executed in the
   backend-launched sandboxed run process — whose identity is the
   registry routine name plus its canonical parsed input (§6.2). The
   persisted execution identity is
   `requestDigest`, which additionally binds the backend fingerprint
   (§4.2) — on `native-sandbox` the composite of compiled
   sandbox-profile digest and runner/routine-executor build digest
   (§14.2) — so two runs of one spec under different images, profiles,
   or executor builds are never conflated.
3. **No agent-authored byte is an input to backend selection**, and
   agents cannot name backends, images, mounts, or policy values —
   nominated operations execute where the runner's policy says, full
   stop (§13 rule 1).
4. **A backend must not silently downgrade isolation**: refusals route
   per operation class, re-selection within an occurrence does not
   exist, and there is no fall-back-to-local path (§13 rules 2–3).
5. No pinned class executes on `local`; the floor of all three is an
   isolated backend with behaviorally attested filesystem, environment,
   network, and process-tree-termination axes, and a host without one
   keeps refusing `"containment-unavailable"` (§13 rule 4, #697 §6
   rule 4). A `"plan-approval"` occurrence's class carries its plan
   entry's `family`, so its #915 §10 report-only or adopt-changes
   semantics are preserved through §11.3, never collapsed into the
   Tool Request row (§2, §3, §11.3).
6. The writable set of every run is the issue worktree, the per-run
   artifact directory, and — operator-owned classes only — declared
   caches, nothing else; a pinned run writes inside the worktree and
   its own run-artifact boundary alone, never a cache (§6.1); the
   SQLite store, session config, `$HOME`, the host common Git
   directory, and the runtime socket are
   never reachable from an isolated backend — Git metadata reaches an
   isolated run only as the §6.1 ephemeral credential-stripped
   read-only projection, and prepare sentinels live outside both the
   projected metadata and the worktree (§6.1, §7 rule 4, §15.4).
7. **Git and GitHub side effects remain explicit runner operations**
   outside every untrusted boundary: the runner's own git/`gh` calls
   never route through a backend, routed commands are never classified
   by text (a guided grant invoking `git` routes whole, §3), and
   isolated backends carry no credentials and no credentialed network
   route, so the rule holds by construction (§3, §6.3–§6.4, §14.3).
8. Enforcement is recorded honestly: `"enforced"` only with #916 §8.3
   attestation behind it, `"declared-only"` only where policy admits
   it, and unknown evaluates as absent everywhere (§6.6, §13.2).
9. The outcome set and refusal-reason set are closed; `"ran"` passes no
   judgment on exit codes; `"infrastructure"` is never attributed to
   the command; `"lost"` is assigned only by reconciliation (§11).
10. Consumption adds nothing to the phase runner: no new
    `PhaseRunOutcome` member, no new `TierRefusalReason` member, no new
    task status; every backend outcome maps onto existing handler
    semantics (§11.3).
11. Record-then-act, witness-gated recovery, and idempotent
    every-exit-path cleanup hold on all backends; tree termination is
    an honest §6.6 axis — `"enforced"` only where a §8.4 kernel tree
    boundary or the container pid namespace structurally backs it,
    process-group signalling alone never credited as tree death — and
    recovery never kills without a positive identity match (§5, §8,
    §10).
12. Caches and prepare stamps are trust-domain-scoped: nothing built in
    one backend's domain is credited to or mounted into another's (§7).
13. The contract names no package manager; planned verification and
    environment preparation route through it with command bytes and
    their declared execution form, mounts, caches,
    and stamps alone (§6.2, §7 rule 3).
14. Single-host persistence: durable state on persistent local
    storage/EBS; no PostgreSQL, S3, remote workers, or distributed
    leases; no ECS/Fargate or multi-host abstraction is added
    speculatively (§15.3, #916 §4 restated).
15. This contract adds no runtime behavior, no tier, no plan state, no
    event, no check id, and no change to #697's or #915's policy. Its
    one predecessor amendment is recorded, never silent: #916 §3's
    direct-host containment row for the operator-configured commands is
    superseded in place — it becomes the `local` default, and an
    operator-raised class is contained by its selected backend (§3,
    §13 rule 5) — while #916 §3's boundary statement and agent-lane
    and pinned-substitution authorities stand unchanged. Its own
    vocabulary is the backend ids, operation classes, lifecycle
    states, outcome/refusal sets, enforcement values, and packaging
    layouts defined here.

## 19. Test seams and matrix

For the implementation slices that build against this contract (the docs
pin at the end is the only test landing with #917 itself):

| Area | Cases |
| --- | --- |
| Local equivalence (M0, §14.1) | golden-pinned byte equivalence over the shipped `CommandRunner` paths, per class (§4.3): `defaultCommandRunner` semantics for `environment.prepare` / `verification.run` / `dependency.sync` — `parseShellTokens` argv, success discards stderr, no separate diagnostic — and `bothStreamsCommandRunner` `/bin/sh -c` semantics for `tool-request.granted` — both-streams capture on every exit, `spawnError`-appended-to-stderr, signal-kill-as-nonzero; same env, cwd, timeout, `maxBuffer`; artifacts and events unchanged. |
| Selection (§13) | pure-function tests: per-class requirement satisfied → binding; backend absent → `"backend-unavailable"`; unattested axis on a pinned floor → `"capability-unattested"`; no input carries agent-authored bytes (adversarial backend-shaped text in issue/tool-request content asserted inert); no re-selection after a refusal; a pinned class with `local` policy value impossible at schema level; a `"plan-approval"` occurrence's class derived from its plan entry's `family` (`environment` → `environment.pinned`, `verification` → `verification.pinned`, `tool-request` → `tool-request.pinned`), never collapsed to `tool-request.pinned`. |
| Spec admission (§4, §6) | `form: "shell"` on a pinned-class spec → `"spec-invalid"`; `form: "routine"` on an operator-owned class, naming an unregistered routine, or carrying an `input` that is not the canonical form of the entry's parser output → `"spec-invalid"` (§6.2); a pinned-class form mismatching its origin's `execution.kind` — a `"pinned-command"` origin resolved to anything but `"tokenized"`, an `"in-process"` origin resolved to anything but `"routine"` → `"spec-invalid"` (§6.2); a routine spec's `specDigest` binding the routine name plus its canonical input; a tokenized `argv` that is not the fixed tokenizer's output for its `line` → `"spec-invalid"`; a pinned command's digest computed over `line`'s bytes, unchanged by tokenization; cwd outside declared mounts refused; container binding without digest → `"image-unpinned"`; missing hostPath → `"mount-unresolvable"`; `identity.user` unsatisfiable → `"policy-unenforceable"`; `source: "runner-inherited"` env on an isolated backend or a pinned spec → `"spec-invalid"`, with the ambient environment absent from the spec's canonical form and `specDigest` (§6.3); a registry-policy spec without `registryEndpoints`, any other policy carrying the field, or a credential-bearing endpoint → `"spec-invalid"`, with the resolved endpoint list bound into `specDigest` (§6.4); a pinned-class spec declaring a `kind: "cache"` mount → `"spec-invalid"` (§6.1); a #915 `"package-registry"` pin carried into the spec verbatim and refusing `"capability-unattested"` while the capability is unattested — never rewritten to `"registry-allowlist"` or `"unrestricted"` (§6.4); a `kind: "git-metadata"` mount that is `rw`, on a `local` spec, or whose `hostPath` resolves to or inside the host common Git directory → `"spec-invalid"`, with the projected configuration asserted free of `credential.*` keys, `http.<url>.extraheader` values, and authenticated remote material (§6.1); identical spec under two digest-pinned images → equal `specDigest`, distinct `requestDigest` (§4.2); identical spec and profile under two runner/routine-executor builds → distinct `fingerprint`, distinct `requestDigest`, and a `native-sandbox` binding missing either composite digest refused `"backend-unavailable"` (§4.1, §14.2). |
| Lifecycle + recovery (§5, §8) | record-then-act ordering observable across a simulated crash at each state; a crash persisted in each pre-`launching` state recovers `"never-launched"` with outcome `infrastructure` — for a pinned spec the reservation settles with that outcome, no ambiguous-reservation park (§8.5 rule 7, §12 rule 5); a `launching` crash with a created-but-never-started container recovers `"never-launched"`, while a witness-free `launching` crash on a process backend recovers `lost`; an instant-exit command (`true`) completes via `launched → collecting` with outcome `ran` (§5 rule 5); first-terminator-wins outcome determinism; a backend/runtime failure during collection with no terminator recorded ends `infrastructure` (§5 rule 2), and the same failure after a recorded timeout keeps `timeout` with the failure recorded on the result; tree-kill (grandchild dies; a `setsid` escapee dies inside a §8.4 boundary; a group-only platform reports the tree-termination axis `"declared-only"` and a pinned spec on it refuses `"policy-unenforceable"`); witness mismatch (recycled pid / relabeled container) → no kill + `lost`; stale heartbeat with live witness → report only; orphan containers found by label. |
| Capture + artifacts (§9) | per-stream bounds; `truncated`/`totalBytes` honesty; `spawnDiagnostic` separable from child bytes; `execution-result.json` present on every outcome including `refused` and `lost`, a refused result carrying its §11.2 `refusal` payload (reason, detail, axes) and a non-refused result carrying none; env values absent from every persisted form. |
| Outcome mapping (§11.3) | per-class table rows, including: prepare refusal → fail-closed stop without stamp and without backend fallback; pinned refusal → `"containment-unavailable"`; `tool-request.pinned` `lost` → human handoff with reservation consumed; `environment.pinned` success → stamp written and reservation settled, failure → fail-closed no-stamp stop, never #697 §7 effect verification; `verification.pinned` output → the shipped repair loop within its cycle cap, never the Tool Request human handoff; a refused run routed on the result's `refusal.reason` (§4.3). |
| Cache/stamp binding (§7) | backend or image-digest change invalidates the prepare stamp; an executor-build digest change invalidates it on `native-sandbox` (§7 rule 1, §14.2); cross-domain cache mount refused at validation; a pinned-class spec with a `kind: "cache"` mount refused `"spec-invalid"` (§6.1); a prepare sentinel written for an isolated-backend run lands in backend-managed runner state or the artifact root — never in the projected Git metadata or the worktree — keyed per §7 rule 4, invalidated by the runner's own worktree prune/recreate (§7 rule 4). |
| Docs pin | `test/docs-single-host-execution-backend-contract.test.js` pins this document's status line, chain position, the closed backend and operation-class sets, the routed/never-routed scope table rules (the #916 §3 supersession statement included), the immutable-spec rule, the three-form command carriage with the routine form's pinned-only sandboxed-run-process rule (§6.2), the constructed/`runner-inherited` env split (§6.3), the closed network-policy set with the #915 `"package-registry"` axis carried verbatim (§6.4), the closed lifecycle (including `collecting`'s `infrastructure` exit, §5 rule 2, the `launching` intent state, and §8.5's never-launched recovery distinction), the closed isolation-axis set and the in-document definition of every §4.3 interface shape, the closed outcome and refusal sets, the no-new-phase-runner-vocabulary rule, the agent-never-selects and no-silent-downgrade rules, the pinned-never-local floor, the writable-set and socket rules, the §6.1 credential-stripped Git-metadata projection rule with the §7 rule 4 sentinel placement, the §14.2 native profile+executor-build fingerprint composite, the git/GitHub boundary, the trust-domain cache rule, the package-manager-free rule, the P1 recommendation and the P2 `container` refusal, the persistence rejections, the local-first migration ordering, and the reconciliation notes in `docs/tool-request-grant-tiers-contract.md` §18, `docs/preflight-execution-plan-contract.md` §20, and `docs/single-host-platform-sandbox-contract.md` §3 (the supersession note) and §15 (and `docs/DOMAIN.md` §5 where present) against drift. |

## 20. Non-goals and forward pointers

This document defines the single-host execution abstraction only. It
does not define, and nothing implementing it should assume:

- **The backend engines, run registry, selection wiring, session-policy
  schema, admin surfaces, and packaging changes** — the chain's later
  issues (#918 onward; see the issue body for the authoritative GitHub
  Issue Relationships), decomposed per §17.
  **Delivered (#918)**: `docs/verification-execution-contract.md` —
  the runner-owned verification execution and continuation contract:
  the consuming contract this document's §11.3 verification rows defer
  to. It maps this contract's closed outcomes onto a closed per-command
  verification classification, aggregates every multi-command set into
  one cycle outcome per the lane it ran in, keeps infrastructure and
  refusal outcomes out of agent-facing code evidence, and defines the
  evidence-validated direct-to-review continuation (#722's
  prerequisite). The backend engines, run registry, selection wiring,
  and packaging changes remain with the chain's later issues (#919
  onward).
  **Delivered (#919)**: `docs/unattended-tool-request-contract.md` —
  the unattended Tool Request handling and human parking contract: the
  chain's final design issue. Every unattended execution row it
  defines routes through this contract's seam (pinned classes on
  attested isolated backends only, guided grant runs as
  `"tool-request.granted"`, no silent downgrade), and its final
  dependency-ordered decomposition schedules this contract's §17
  slices, awaiting human approval. The backend engines, run registry,
  selection wiring, and packaging changes remain with those
  tracker-assigned implementation issues.
- **Routing agent lanes through a backend** — provider CLIs keep
  launching exactly as their handlers pin (#916 §6.2); containing
  agent-owned commands remains the provider CLI sandbox's job (#916
  §3), and any future change starts as a change to #916 and this
  document.
- **A general execution substrate for agent-proposed free-form
  commands** — the `docs/tool-request-redesign.md` §6/§9.4 track,
  unchanged; #697 §15's deferral of generic auto-grant stands.
- **The P2 mediated sibling-launcher and the P3 invocation bridge** —
  recorded as viable shapes, designed by nobody yet; until one lands,
  P2 refuses the `container` backend and P3 is not a supported layout.
- **The concrete sandbox mechanisms and their spikes** — #916 §8/§12.2
  govern; no spike outcome is assumed here.
- **Any change to `docs/install.md`'s flow, the session schema, the
  admin CLI grammar, or the ChatOps verb table** — governed by their
  own contracts when the surface slices land.
- **ECS/EKS/Fargate, Lambda-style runtimes, multi-host coordination,
  PostgreSQL, S3, remote workers, and distributed leases** — rejected
  for this design cycle (§15.3, #916 §4); revisiting any of them is a
  change to this document first.
