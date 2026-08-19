# Single-host platform and CLI sandbox capability contract

Status: **approved design, not yet implemented** (issue #916). This document
is the authoritative contract for the supported single-host platform set and
for the sandbox capabilities the loop expects from each provider CLI. It
defines which hosts the loop runs on, what boundary each host is expected to
provide, which sandbox protects which class of command, and what a host must
prove — fail-closed — before any pre-authorized operation may rely on
containment there. Follow-up implementation issues reference this
specification and MUST NOT redefine its policy; a change of policy is a
change to this document first.

This is issue #916, the successor of the preflight Execution Plan contract
(#915) in the executable chain
`#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917
→ #918 → #919 → #722` (see the issue body for the authoritative GitHub Issue
Relationships). It consumes `docs/tool-request-grant-tiers-contract.md`
(#697) — whose §7 enforcing sandbox is the runner capability this document
maps onto concrete hosts — and `docs/preflight-execution-plan-contract.md`
(#915), whose plan entries inherit that same containment demand. It adds no
runtime behavior: the concrete sandbox mechanism, the capability probes, the
capability report wiring, and the execution plumbing are the chain's later
issues (#917 onward).

It does **not** specify, and no implementation built against it may assume:

- **The three tiers, tier resolution, the policy triple, effect
  verification, and the audit record** — fixed by
  `docs/tool-request-grant-tiers-contract.md` (#697). This document adds no
  tier, no `TierRefusalReason` member, and no change to that registry's
  policy triple; `"containment-unavailable"` (#697 §6 rule 4) is the
  existing refusal every degraded host routes through.
- **The preflight Execution Plan schema, approval, invalidation, and
  authorization resolution** — fixed by
  `docs/preflight-execution-plan-contract.md` (#915); nothing here alters a
  plan's semantics or its subtracts-nothing fallthrough.
- **The guided operator flow** — fixed by
  `docs/guided-tool-request-flow.md`; the human gate *is* that flow,
  unchanged.
- **The shipped `environmentPrepare`, `verification`, and `dependencySync`
  mechanisms** — fixed by `docs/environment-prepare-contract.md` and
  `docs/tool-request-and-dependency-sync.md` §3.
- **The execution-environment session-config resolver** (host / restricted
  host / worktree / Docker-VM rows) — the
  `docs/tool-request-redesign.md` §6/§9.4 track, distinct from this
  contract: that track is about *where a guided run executes*; this
  contract is about *which hosts the whole loop supports and what they must
  prove*.
- **The install flow** — `docs/install.md` remains the operative setup
  guide; §11 below adds target-specific prerequisites and a validation
  plan, not a new install procedure.

## 1. Why a platform contract — the gap this contract closes

#697 made relaxed execution conditional on an **enforcing sandbox**: a
required runner capability that mechanically imposes an entry's policy
triple, with a host that cannot provide it routed to the human gate
(`"containment-unavailable"`), never to unconfined execution. #915 extended
the same demand to preflight plan entries. Both contracts deliberately left
open *which hosts can provide that capability at all* — and today the answer
is recorded nowhere: the loop operates on macOS in practice, `docs/install.md`
assumes a POSIX host without saying which, and nothing distinguishes "this
host can enforce a policy triple" from "this host happens to be the one the
operator uses."

Pre-authorized operations are useful only when their execution boundary is
explicit and portable. The intended single-host deployment targets beyond
macOS are Linux virtual machines — AWS EC2 as the reference cloud shape —
and Windows through WSL2. Each of those hosts has a different sandbox
toolbox (Seatbelt; Landlock/seccomp/user namespaces; the WSL2 kernel's
subset of the same), a different filesystem story, and a different secret
surface. Without a contract, every implementation slice from #917 onward
would re-derive those differences ad hoc, and "the sandbox works here" would
be an assumption instead of a probed fact.

**Security posture.** The expected deployment is private: Issue text reaches
the loop only after the trusted human boundary `docs/install.md` §1 and
`docs/private-control-plane-security.md` establish, and the control plane
never ingests untrusted external input directly. Security remains defense in
depth — worktree isolation, human PR review, redacted public surfaces, and
the #697 trust model all stay load-bearing — but the design goal of this
contract is to let functionality proceed inside an **explicitly isolated
environment** instead of distorting the workflow around repeated
per-occurrence approvals. Isolation earns automation; automation never earns
isolation.

## 2. Terminology

- **Platform target** — a named host configuration this contract takes a
  position on: `macos`, `linux` (single-host), `wsl2` (Windows through
  WSL2), `ec2` (the reference Linux cloud deployment). The runtime platform
  set underneath them is closed: `process.platform` `"darwin"` or
  `"linux"`; `wsl2` and `ec2` are `linux` evaluated in a specific
  environment, not additional runtime platforms.
- **Runner-owned command** — a command the orchestrator executes directly:
  the n8n Execute Command nodes that invoke the admin CLI, every `git` and
  `gh` operation the handlers run, `environmentPrepare`, the configured
  `verification` commands, the `dependencySync` pinned command, and #697
  §7 pinned substitutions. No agent CLI is in the process tree above these.
- **Agent-owned command** — a command a provider CLI's own agent decides to
  run inside its own tool surface (Claude's command tool, Codex's exec
  sandbox, whatever Antigravity runs) during an agent lane. The runner
  launches the CLI; the CLI launches the command.
- **Provider CLI sandbox** — the containment a provider CLI applies to its
  own agent-owned commands (e.g. `codex exec --sandbox read-only`). Scope:
  agent-owned commands only.
- **Runner sandbox** — #697 §7's enforcing sandbox: the runner capability
  that contains a pinned substitution under an entry's policy triple. It is
  not any provider CLI's sandbox and no provider CLI can supply it (§3).
- **Capability probe** — a fail-closed check the runner (or
  `admin session-doctor`) performs on the live host to establish that a
  boundary actually holds. Probes are **behavioral** (exercise the boundary
  with a canary and observe denial) or **declarative** (read a version or a
  config); only behavioral probes attest containment (§8.3).
- **Capability report** — the durable, structured summary of probe results
  defined in §10, suitable for `admin session-doctor` output or a future
  runtime diagnostic.
- **Support level** — the closed set `"supported"` | `"degraded"` |
  `"rejected"` (§4, §7). **Unknown evaluates as absent**: any probe or
  matrix lookup that cannot be resolved takes the more restrictive level.
- **Maturity** — orthogonal to support level: `operational` (the loop has
  run the §11 validation plan on this target) vs `designed` (this contract
  covers the target; validation has not yet executed). Maturity never
  loosens a rule; it records which guarantees are demonstrated versus
  specified.

## 3. Two sandbox domains — what protects which commands

The single most important boundary statement in this contract, and the one
the rest of it refuses to blur:

**No agent CLI sandbox is ever credited with containing runner-owned
commands.** Runner-owned commands — git/gh plumbing, `environmentPrepare`,
`verification`, `dependencySync`, the admin CLI itself — execute directly on
the host with the orchestrator's own privileges. They are governed by
operator trust in session configuration, worktree scoping, and human PR
review, not by any sandbox an agent CLI happens to ship. A deployment that
enables a provider CLI's strictest sandbox has changed **nothing** about
what `npm test` run by the runner can reach.

**Superseded in part by #917.** The direct-host execution this section
describes remains true of the shipped tree and remains the compatibility
default, but it is no longer the only normative containment story for
the operator-configured commands:
`docs/single-host-execution-backend-contract.md` (#917) names the seam
they execute through (the `ExecutionBackend`), makes this direct-host
story its `local` backend — the default for every operator-owned class —
and lets an operator raise a class to an isolated backend per session
(#917 §13 rule 5), in which case that class's containment authority is
the selected backend, refusing rather than silently downgrading (#917
§13 rules 2–3). What this section fixes unchanged is the boundary above
and the agent-lane story below: no agent CLI sandbox is ever the
containment authority for runner-owned commands, no agent-authored byte
selects where they run, and the runner's own git/gh plumbing never
routes through a backend at all (#917 §3).

Three containment authorities exist, and each command class has exactly one:

| Command class | Executor | Containment authority |
| --- | --- | --- |
| Agent-owned commands | The provider CLI's agent, inside an agent lane | The provider CLI sandbox (§6), graded per §6.3 — plus the lane's worktree cwd and review gate, which do not depend on it |
| Runner-owned commands (operator-configured: `environmentPrepare`, `verification`, `dependencySync`, git/gh plumbing) | The runner, directly | Operator trust + worktree scoping + PR review; **no sandbox is claimed** on the direct-host default, which #917 names the `local` backend. A class an operator explicitly raises per #917 §13 rule 5 is contained by its selected isolated backend instead — never silently, in either direction — while git/gh plumbing always stays direct-host (#917 §3) |
| Pinned substitutions under a relaxed #697 tier | The runner, inside the runner sandbox | The runner sandbox (§8) — a required capability, behaviorally attested, or the request routes `"containment-unavailable"` |

Corollaries:

- A provider CLI sandbox being absent, unknown, or broken never weakens the
  runner-owned command story — that story never cited it.
- The runner sandbox is never delegated to a provider CLI. #697 §7 already
  fixes this ("a required runner capability, not the execution-environment
  host default"); this contract adds the platform-facing half: the runner
  sandbox must be attestable on the host itself, with no agent CLI in the
  loop.
- The reverse credit is also refused: the runner sandbox contains
  runner-owned executions only — pinned substitutions by requirement
  (§8), plus operator-owned classes an operator explicitly raised to it
  (#917 §13 rule 5) by election. Agent lanes are never run inside it,
  and nothing in this contract changes what an agent lane may do.

## 4. The normative platform support matrix

The runtime platform set is **closed**: a loop process runs on
`process.platform === "darwin"` or `process.platform === "linux"` and
refuses to start anywhere else (§9 rule 1). The four platform targets and
the explicit non-goals:

| Target | Support level | Maturity | Definition |
| --- | --- | --- | --- |
| `macos` | supported | designed | The current reference host, with operating history (§12.1 G1). Still `designed`: §2's `operational` requires the §11.4 validation plan, whose V4 needs the capability-report wiring this contract defers to #917 onward — operating history is evidence, never a substitute for the plan. Apple toolchain assumptions: none beyond `docs/install.md` §2. |
| `linux` | supported | designed | A single Linux host (physical, VM, or on-prem) meeting §11.2's kernel-feature prerequisites. Distribution-neutral: requirements are kernel features and installable tools, never a distro name. |
| `wsl2` | supported | designed | The `linux` contract evaluated **entirely inside the WSL2 distribution** (§5.3, §9 rules 2–4). Nothing on the Windows side of the interop boundary is part of the supported surface. |
| `ec2` | supported | designed | The reference Linux cloud deployment: the `linux` contract on a single EC2 instance, plus §5.4's cloud-specific boundary rules. |

Explicit non-goals for this design cycle — **rejected, not degraded**:

| Non-target | Level | Why |
| --- | --- | --- |
| Native Windows execution | rejected | `process.platform === "win32"` has no POSIX filesystem semantics, no candidate runner-sandbox mechanism in scope, and no lane has ever run there. **Native Windows execution is rejected at startup, never degraded** (§9 rule 1). Windows users are served by the `wsl2` target. |
| WSL1 | rejected | WSL1 emulates Linux syscalls without a Linux kernel: no namespaces, no Landlock, no seccomp — no candidate mechanism for §8. A Microsoft-kernel host that cannot be positively identified as WSL2 is treated as WSL1 and refused (§9 rule 2). |
| ECS, EKS, Fargate, distributed runners | rejected | The loop's locks (per-issue worktree locks, store transactions) and its SQLite store are host-local; the supported n8n deployment is the local CLI against a local database (`docs/install.md` §2). Nothing coordinates across hosts, so a multi-node substrate would silently break every mutual-exclusion assumption. |
| Multi-host coordination / horizontal scaling | rejected | Same reason: single-host is a design premise, not a current limitation being worked around. |
| Lambda-style short-lived execution | rejected | The loop assumes durable local state (worktrees, SQLite, artifacts) and long-lived processes; a request-scoped runtime satisfies none of that. |

**The platform set is closed.** Adding a target — or moving a non-goal into
scope — is a change to this document first, exactly as adding a tier is a
change to #697 first.

## 5. Platform boundary profiles

For each target: the filesystem, process, network, environment, and secret
boundary the loop assumes, and what the target must provide. The common core
comes first; targets then state only their deltas.

### 5.1 Common core (all targets)

| Boundary | Contract |
| --- | --- |
| Filesystem | The loop owns: the canonical repo checkout, the per-issue worktree root (`docs/per-issue-worktrees.md`), the artifact directory, and the SQLite store. All four live on a local, POSIX-semantics filesystem with working advisory locks and atomic rename. Agent lanes write inside their issue worktree; relaxed-tier substitutions are confined to worktree + run-artifact directory (#697 §7). |
| Process | One host, one orchestrator (local n8n), child processes for every command. Mutual exclusion is host-local: per-issue worktree locks and SQLite transactions. No cross-host lock exists, which is exactly why §4 rejects multi-host substrates. |
| Network | Egress only: the GitHub API/`gh` endpoints, each configured provider's API endpoints, and — when a `"registry-metadata"` entry is configured — the session-configured registry endpoints. No lane requires inbound connectivity. The n8n editor UI binds locally and is reached by local access or an operator tunnel, never a public binding. |
| Environment | The orchestrator's environment carries operator secrets (gh auth, provider credentials) and passes through to agent lanes as each lane's contract specifies. Relaxed-tier substitutions never see it: their environment is constructed from a fixed allowlist (#697 §7, `docs/tool-request-redesign.md` §5). |
| Secrets | Provider CLI credentials live in each CLI's own store under `$HOME` — never in the repo, a worktree, an artifact, or a plan (#915 invariant 10). Public surfaces receive redacted summaries only. |

### 5.2 `macos` delta

- Credential stores may be Keychain-backed (gh, some provider CLIs); the
  file-permission guidance of §5.5 applies to whatever is file-based.
- The OS ships `sandbox-exec` (Seatbelt) on every install — a candidate §8
  mechanism with a deprecation caveat (spike S4).
- No other delta: the common core is the macOS reality today.

### 5.3 `wsl2` delta — repository placement and the interop boundary

WSL2 is the `linux` contract evaluated inside the distribution, plus two
normative rules the interop boundary makes necessary:

- **Placement: loop-owned state lives on a Linux-native filesystem.** The
  canonical repo, worktree root, artifact directory, and SQLite store must
  all reside on the distribution's native filesystem (e.g. under the Linux
  `$HOME`), never on a Windows-drive interop mount (the DrvFs/9P-backed
  `/mnt/<drive>` mounts or equivalents). Interop mounts break the common
  core's filesystem row — advisory locking, rename atomicity, mtime
  fidelity, and case sensitivity are all degraded through the 9P boundary,
  and SQLite explicitly cannot be trusted on them — so a loop-owned path on
  one **refuses at startup** (§9 rule 3). The check is by containing-mount
  filesystem type, not by path prefix: a DrvFs mount outside `/mnt` refuses
  just the same.
- **Executables: loop-owned commands resolve to Linux binaries.** WSL2
  interop lets `PATH` reach Windows executables (`git.exe`, `node.exe`).
  Every loop-owned binary — `git`, `node`, `npm`, `gh`, `n8n`, and each
  configured agent CLI — must resolve to a Linux executable inside the
  distribution; a loop-owned command resolving to a `*.exe` or to a path on
  an interop mount **refuses at startup** (§9 rule 4). Windows-side
  executables see Windows path semantics and the Windows credential
  surface: they are outside the boundary this contract describes, and no
  loop command may cross to them. Setting `[interop] appendWindowsPath=false`
  in `/etc/wsl.conf` on a loop host is the recommended (not required) way
  to make rule 4 trivially true.
- Windows-side credentials (Windows `gh`, Windows keychains) are never
  used; every credential the loop touches lives inside the distribution per
  §5.5.

### 5.4 `ec2` delta — the reference cloud shape

- One instance, EBS-persisted state; the `linux` profile applies verbatim.
- **Egress-only security group**: outbound to GitHub, provider APIs,
  configured registries, and the regional AWS SSM control-plane endpoints
  (`ssm`, `ssmmessages`, `ec2messages`, over HTTPS) that the operator
  access path below depends on; no inbound rule at all — which rules out
  direct SSH by construction. **Operator access in the reference shape is
  SSM Session Manager**: the SSM agent connects outbound to those
  control-plane endpoints, so no ingress rule exists, and an interactive
  shell, SSH-over-SSM, and the n8n UI
  port-forward all run as tunnels inside the SSM session. A deployment
  that requires direct SSH instead adds one narrowly scoped inbound rule
  (SSH from a fixed operator source only) — a recorded deviation from
  the reference shape, not a variant of it. The loop itself needs no
  inbound connectivity under either access path (§5.1).
- **IMDS is a secret surface, not just metadata.** The instance metadata
  service (`169.254.169.254`) serves instance-role credentials to any
  process on the host. Two consequences: (a) the instance role is minimal —
  the loop's GitHub and provider credentials are its own, never IAM-derived,
  so the role a sandbox escapee could reach holds nothing the loop needs;
  (b) the §8 runner sandbox's `network: "none"` must deny link-local
  destinations including IMDS, and the §8.3 canary on EC2 must prove that
  denial (spike S6). IMDSv2-required with a hop limit of 1 is the expected
  instance configuration.
- No other cloud service is assumed: no ECS/EKS/Fargate (§4), no Lambda, no
  managed queue.

### 5.5 `linux` (and shared Linux-family) delta

- Credential stores are files under `$HOME` (gh hosts file, provider CLI
  stores, the Antigravity global store of
  `docs/antigravity-workspace-settings.md`): the host is single-purpose or
  the loop runs as a dedicated OS user, and credential files carry
  owner-only permissions.
- Kernel-feature prerequisites for the §8 candidate mechanisms are listed
  in §11.2 — expressed as kernel features and installable tools,
  deliberately not bound to any distribution.

## 6. Provider CLI sandbox capabilities

### 6.1 Required minimum capabilities (lane participation)

A provider CLI must offer P1–P4 to participate in any lane; a missing one is
an `admin session-doctor` error for every session that assigns the agent:

| # | Capability | Why it is required |
| --- | --- | --- |
| P1 | Non-interactive single-shot invocation: prompt on argv or stdin, run to completion, exit code meaningful | Every lane is headless; the runner cannot answer prompts. |
| P2 | A `--version` probe that exits quickly without authentication | `admin session-doctor` probes each distinct agent binary once, memoized (issue #839); a CLI that cannot be probed cannot be diagnosed. |
| P3 | A pinnable argv contract: documented flags stable enough for handlers to pin, with behavior changes catchable by a version gate | Handlers pin exact invocations (§6.2); the Antigravity `>=1.1.9 <2.0.0` gate of `docs/antigravity-workspace-settings.md` is the precedent for gating a CLI whose behavior moved. |
| P4 | No interactive escalation mid-run: in its non-interactive mode the CLI must refuse or skip an action it lacks permission for, never block awaiting approval | A blocked child process stalls the phase with no human watching; fail-closed refusal is recoverable, a hang is not. |

### 6.2 The shipped baseline (verified in-repo)

What each CLI is invoked with today — the as-is facts the §12 guarantees
table refers back to. No lane passes a permission-bypass or
sandbox-disabling flag anywhere in the tree.

| CLI | Lane | Pinned invocation (sanitized) |
| --- | --- | --- |
| `claude` | implementation / fix | `claude -p --model … --effort … --permission-mode acceptEdits --max-budget-usd … --allowedTools …` (`src/handlers/implementation.ts`) |
| `claude` | review | `claude -p --model … --effort …` (`src/handlers/review.ts`) |
| `codex` | implementation | `codex [--model …] exec …` with effort via `-c model_reasoning_effort=…` (`src/handlers/implementation.ts`) |
| `codex` | review | `codex [--model …] review --base … -c model_reasoning_effort=…` (`src/handlers/review.ts`) |
| `codex` | refinement roles | `codex exec --sandbox read-only --skip-git-repo-check …` — the only explicit `--sandbox` pin in the tree (`src/handlers/issue-refinement-loop.ts`) |
| `agy` (Antigravity/Gemini; `ANTIGRAVITY_BIN` override) | research / implementation / review | `agy --print "<prompt>"` — no sandbox-related flag exists in any lane |

### 6.3 Agent-owned command containment (graded, never load-bearing)

P5 — the provider CLI sandbox proper: writes scoped to the invocation
workspace and network limited per the CLI's own policy for agent-owned
commands. P5 is **graded, not required**: no loop guarantee depends on it
(§3), so its absence degrades defense in depth, never correctness. The
capability report (§10) grades it per provider:

| Grade | Meaning |
| --- | --- |
| `verified` | A behavioral canary on **this host** demonstrated the containment (an agent-owned out-of-workspace write / disallowed connect was denied). |
| `vendor-documented` | The vendor documents the mechanism but no on-host canary has run. Credited in diagnostics as documentation, never as attestation. |
| `unknown` | No verified containment story exists. Evaluated as absent everywhere a decision is made. |

Current grading:

| Provider CLI | Grade today | Basis |
| --- | --- | --- |
| `claude` | vendor-documented | Vendor documents command sandboxing (Seatbelt on macOS, comparable mechanisms on Linux) and the shipped lanes constrain the tool surface (`--permission-mode acceptEdits`, `--allowedTools`); no on-host canary has verified the sandbox itself (spike S8). |
| `codex` | vendor-documented | Vendor documents Seatbelt on macOS and Landlock + seccomp on Linux for `--sandbox` modes; the refinement lane already pins `--sandbox read-only`. Landlock availability on specific kernels (WSL2 included) and the CLI's behavior when it is missing are spikes S1/S2. |
| `agy` (Antigravity/Gemini) | unknown | No first-party containment documentation has been verified for the `agy` builds the loop drives. **Antigravity/Gemini sandbox guarantees are recorded as verification work, never assumed** (spike S3) — consistent with `docs/antigravity-workspace-settings.md`, which already pins agy behavior it could not verify on-host and fails closed on every uncertainty. |

## 7. Provider × platform support levels

Level semantics for a (provider, platform) combination:

- `supported` — the provider's lanes run on the platform, P1–P4 hold, and a
  containment grade of at least `vendor-documented` exists for P5.
- `degraded` — the provider's lanes run, P1–P4 hold, but P5 is `unknown`:
  the CLI's own sandbox contributes nothing to defense in depth, and the
  worktree + review + private-control-plane guarantees stand alone. The
  combination works; the capability report says so out loud.
- `rejected` — the combination is refused (today: everything on native
  Windows, via §9 rule 1).

| Provider CLI | `macos` | `linux` | `wsl2` | `ec2` | native Windows |
| --- | --- | --- | --- | --- | --- |
| `claude` | supported | supported | supported | supported | rejected |
| `codex` | supported | supported (S2) | supported (S1, S2) | supported (S2) | rejected |
| `agy` (Antigravity/Gemini) | degraded (S3) | degraded (S3) | degraded (S3) | degraded (S3) | rejected |

A spike reference in a cell means the level holds under the fail-closed
interim stance §12.2 records for that spike; the spike's landing can only
confirm or *lower* the cell, never silently raise a different one. None of
these levels bears on the runner sandbox: §8's capability is attested
per-host by canary, independent of any provider CLI.

## 8. The runner sandbox on each platform

### 8.1 Required guarantees (restated, not redefined)

The runner sandbox is #697 §7's enforcing boundary, unchanged: filesystem
writes confined to the issue worktree plus the run-artifact directory;
environment constructed from a fixed allowlist; network denied — or, for
`"registry-metadata"`, restricted to the session-configured registry
endpoints; bounded by a timeout; `in-process` routines inside the same
boundary. This contract adds the platform mapping and the attestation rule,
nothing else.

### 8.2 Candidate mechanisms per platform (informative, not chosen here)

The concrete mechanism is an implementation choice for the chain's later
issues (#917 onward). This contract constrains the choice only through
§8.3's attestation rule and these platform facts:

| Platform | Candidate mechanisms | Platform-specific notes |
| --- | --- | --- |
| `macos` | Seatbelt profiles via `sandbox-exec` | OS-shipped everywhere; the interface is deprecated upstream (spike S4). `network: "none"` is expressible; `"registry-metadata"` endpoint scoping needs an egress proxy (spike S5). |
| `linux` / `ec2` | Landlock (filesystem), seccomp (network denial), user-namespace tools such as bubblewrap (mount + network namespaces), or a rootless container runtime | Landlock requires a kernel with the LSM enabled (mainline since 5.13); unprivileged user namespaces are restricted on some current distributions (spike S7). `"registry-metadata"` needs a network namespace + loopback proxy or equivalent (S5). On `ec2`, `network: "none"` must demonstrably cover IMDS (S6). |
| `wsl2` | The Linux column, as available in the WSL2 kernel | Whether the stock WSL2 kernel enables Landlock and unprivileged user namespaces is spike S1; until probed on the actual host, absent. |

### 8.3 Attestation is behavioral

**A runner-sandbox capability is attested only by a canary that exercises
the boundary on the live host** — at minimum: an attempted write outside
the permitted filesystem set, an attempted connection to a non-allowlisted
endpoint, a read — from inside the boundary — of a canary environment
variable planted in the orchestrator's environment outside the fixed
allowlist, and, on `ec2` (or whenever the host's cloud classification is
`unknown`, §10.2), an attempted connection to the IMDS address — with
every write and connect attempt observed to be denied and the planted
variable observed to be absent. The environment probe is what attests
`"runner-sandbox.env-allowlist"` (§10.1): a boundary whose constructed
environment still exposes the planted non-allowlisted variable has not
demonstrated the allowlist, whatever its configuration claims, and the
check evaluates `absent`. A `"registry-metadata"` boundary must
additionally demonstrate what it permits, not only what it denies: its
canary makes a controlled connection from inside the boundary to a
session-configured allowlisted registry endpoint and observes it to
succeed. Without that positive probe a deny-all network backend passes
every denial check while making the authorized `dependency.sync` registry
request impossible, so `"runner-sandbox.network-registry-metadata"`
attests `present` only when the non-allowlisted connection is observed to
be denied **and** the allowlisted connection is observed to succeed;
either observation missing evaluates the check `absent`. Version checks,
kernel-config reads,
and package presence are declarative probes: useful in diagnostics, **never
sufficient to attest containment**. A canary that fails to run, produces an
ambiguous result, or is skipped attests nothing: the capability is absent
and #697 §6 rule 4 routes relaxed requests to the human gate. This is the
platform-facing form of #697's "attest the enforcing containment
capability" — the attestation is a demonstrated denial, not a configuration
opinion.

## 9. Fail-closed startup and capability checks; the degraded-mode policy

Numbered rules; implementation slices cite them by number.

1. **OS gate.** A loop process starts only on `process.platform`
   `"darwin"` or `"linux"`. Any other value — `"win32"` explicitly
   included — refuses at startup with an error naming this contract.
   Native Windows is rejected, never degraded.
2. **WSL gate.** On a Microsoft-kernel Linux host, the process must
   positively identify WSL2; a host it cannot positively identify as WSL2
   is treated as WSL1 and refused. Detection method is an implementation
   choice; the ambiguity resolution is not: unknown → refuse.
3. **Placement gate (WSL2).** Each loop-owned path — canonical repo,
   worktree root, artifact directory, SQLite store — must reside on a
   Linux-native filesystem, judged by the containing mount's filesystem
   type. Any loop-owned path on a Windows-interop mount refuses at
   startup.
4. **Toolchain gate (WSL2).** Every loop-owned binary (`git`, `node`,
   `npm`, `gh`, `n8n`, each configured agent CLI) must resolve to a Linux
   executable inside the distribution. Resolution to a `*.exe` or onto an
   interop mount refuses at startup.
5. **Probes fail closed.** A capability probe that errors, times out, or
   returns an unclassifiable result yields `absent`, not a retry-later
   `unknown`-that-counts-as-present. Everywhere this contract's data is
   consumed, **unknown evaluates as absent**.
6. **Degraded-mode policy — subtraction-free, never silent.** A host
   without an attested runner-sandbox capability runs the full base loop:
   every agent lane, every runner-owned mechanism, and the human-gated
   Tool Request flow are exactly as on a supported host, because none of
   them ever depended on that capability. What degrades is only the
   relaxed surface: every #697 relaxed-tier resolution refuses
   `"containment-unavailable"` (§6 rule 4), and every #915 plan entry that
   needs containment refuses and falls through per #915 §9 — subtracting
   nothing from the pre-#697 behavior. **Degradation subtracts nothing and
   is never silent**: `admin session-doctor` reports the degraded level
   and each absent capability with its probe evidence.
7. **No silent upgrade.** A capability observed absent does not become
   present for a running decision because a later probe succeeded:
   authorization consumes the probe evaluated at its own resolution time
   (memoized within a process run at most — the #839 probe-memoization
   precedent — never across the decision boundary). A host that gains a
   capability gains it for subsequent resolutions.
8. **Provider gates are doctor errors, not process refusals.** A missing
   or P1–P4-deficient provider CLI fails `admin session-doctor` for the
   sessions that assign it and fails at lane runtime as it does today; it
   does not stop the host from running sessions that never touch that
   provider. Only rules 1–4 refuse the process itself.

## 10. The capability report

The structured result of the §9 checks and §8.3 probes — the format
`admin session-doctor` (or a future runtime diagnostic) emits. Shape is
normative; wiring is an implementation slice.

```ts
type SupportLevel = "supported" | "degraded" | "rejected";
type CapabilityStatus = "present" | "absent" | "unknown";

interface PlatformCapabilityReport {
  schemaVersion: 1;
  platform: {
    os: "darwin" | "linux";
    arch: string;
    kernel: string;                    // uname -r verbatim, bounded
    wsl2: boolean;
    cloud: "ec2" | "none" | "unknown";
  };
  supportLevel: SupportLevel;          // derived, never hand-assigned (§10.2)
  checks: readonly CapabilityCheck[];  // exactly the applicable ids (§10.2); a missing applicable id evaluates as absent
  providers: readonly ProviderCliCapability[];
}

interface CapabilityCheck {
  id: CapabilityCheckId;               // closed set, §10.1
  status: CapabilityStatus;
  method: "behavioral" | "declarative";
  evidence: string;                    // bounded probe output, secret-free
}

interface ProviderCliCapability {
  agentId: "claude" | "codex" | "gemini";
  binary: string;                      // resolved binary (e.g. ANTIGRAVITY_BIN override)
  binarySource: "cli-default" | "env";
  present: boolean;                    // the memoized --version probe (P2)
  version?: string;
  commandContainment: "verified" | "vendor-documented" | "unknown";  // §6.3
}
```

### 10.1 The check-id set is closed

`"platform.os-supported"` | `"platform.wsl2-identified"` |
`"platform.placement-native"` | `"platform.toolchain-native"` |
`"runner-sandbox.filesystem"` | `"runner-sandbox.network-none"` |
`"runner-sandbox.network-registry-metadata"` |
`"runner-sandbox.env-allowlist"` | `"platform.imds-guarded"`

The first four are the §9 rule 1–4 gates (declarative by nature); the
`runner-sandbox.*` checks are §8.3 canaries and MUST carry
`method: "behavioral"` to count as `present`; `"platform.imds-guarded"`
applies whenever `platform.cloud !== "none"` — on `"ec2"`, and equally on
`"unknown"`, because a host that cannot be classified must be treated as
if it were EC2 (§9 rule 5: unknown evaluates as absent, never as
"not cloud") — and is omitted only on a positively classified non-cloud
host. Adding a check id is a change to this document first.

### 10.2 Derivation and consumption rules

- **The applicable check-id set is fixed by `platform`, and a well-formed
  report carries exactly that set.** Applicability is a pure function of
  the `platform` block: `"platform.os-supported"` and every
  `runner-sandbox.*` check apply on every host;
  `"platform.wsl2-identified"` applies when `platform.os === "linux"` and
  records the §9 rule 2 classification outcome — `present` when the host
  is positively classified either as WSL2 (`platform.wsl2 === true`) or as
  non-WSL Linux (no Microsoft-kernel markers, the ordinary `linux`/`ec2`
  case), `absent` only when a Microsoft-kernel host cannot be positively
  identified as WSL2 (the rule 2 refusal: treated as WSL1) — so a plain
  Linux or EC2 host attests it `present` with the non-WSL classification
  as evidence and is never `rejected` for lacking a WSL2 identity;
  `"platform.placement-native"` and `"platform.toolchain-native"` apply
  when `platform.wsl2 === true`; `"platform.imds-guarded"` applies when
  `platform.cloud !== "none"` (§10.1) — `"unknown"` is treated exactly as
  `"ec2"`, so an unclassified host must pass the §§5.4/8.3 IMDS denial
  canary and can never derive `supported` without it. The `checks` array
  must contain exactly the applicable ids — a report carrying an
  inapplicable, duplicate, or unrecognized id is rejected at construction.
- `supportLevel` is a pure function of `platform` and `checks`, evaluated
  over the **applicable** set — never merely over whichever checks happen
  to appear in the array. An applicable id missing from `checks` evaluates
  as `absent`, exactly as an `unknown` status does (§9 rule 5): `rejected`
  when any applicable §9 rule 1–4 gate does not evaluate `present`;
  `degraded` when those gates evaluate `present` but any applicable
  `runner-sandbox.*` check — or an applicable `"platform.imds-guarded"` —
  does not; `supported` otherwise. An empty `checks` array therefore
  derives `rejected`, and a partial one can only lower the level, never
  raise it: omission fails closed and cannot hide an unprobed OS gate,
  runner-sandbox boundary, or IMDS guard.
- The report is a **diagnostic surface, not an authorization input**:
  #697 §6 rule 4's attestation consumes the resolution-time probes
  themselves (§9 rule 7), never a stored report. A stale report can
  misdescribe the host; it can never authorize on its behalf.
- `evidence` is bounded and secret-free. The report may carry local
  absolute paths on the operator's terminal; any public or published
  surface receives at most `supportLevel` and per-status counts — the same
  redaction posture as #915's public summaries.

## 11. Platform prerequisites and the validation plan

### 11.1 Common prerequisites (all targets)

`docs/install.md` §2 unchanged: Node ≥ 20 with npm, `git`, authenticated
`gh`, the agent CLIs for the lanes the session assigns, and a local n8n v1
on the same host. Native npm modules build from source when no prebuilt
binary matches the platform/arch, so a compiler toolchain may be required
by `npm install` on fresh Linux hosts.

### 11.2 `linux` / `ec2` prerequisites

- Kernel baseline **5.15+** — a pragmatic floor: Landlock is mainline since
  5.13 and stock WSL2 kernels ship 5.15+, so one floor serves the whole
  Linux family. A chosen §8 mechanism may raise its own requirement; it may
  not lower this one.
- Sandbox dependencies per the mechanism the implementation slices choose:
  Landlock enabled in the kernel, unprivileged user namespaces permitted
  (see spike S7 for current-distribution restrictions), and/or the
  namespace tool (e.g. bubblewrap) installed. Expressed as kernel features
  and installable tools — never a distribution name.
- `ec2` reference shape: a current-generation instance, EBS-persisted
  state, the §5.4 egress-only security group, IMDSv2 required with hop
  limit 1, and a minimal instance role that holds none of the loop's
  credentials.

### 11.3 `wsl2` prerequisites

- WSL2 (not WSL1) with a current stock kernel; any modern distribution —
  the `linux` rules apply inside it.
- All loop-owned state under the Linux filesystem and all loop-owned
  binaries installed inside the distribution (§5.3).
- `[interop] appendWindowsPath=false` in `/etc/wsl.conf` recommended.

### 11.4 The validation plan — how `designed` becomes `operational`

Per target, in order; a target's matrix maturity flips to `operational`
only when all steps pass and the results (kernel, CLI versions, probe
outputs) are recorded in the validating issue's delivery note:

1. **V1** — install prerequisites per `docs/install.md` §2 and §11.1–11.3.
2. **V2** — `npm install`, `npm run build`, `npm test` green natively on
   the target.
3. **V3** — `admin session-doctor` green against a scratch session on the
   target.
4. **V4** — the §10 capability report generates with all §9 rule 1–4 gates
   `present` (runner-sandbox checks may be `absent` until the mechanism
   slices land — that is the `degraded` level working as designed).
5. **V5** — one end-to-end smoke issue (research → implementation →
   review) on a scratch repository with the target's configured agents.
6. **V6 (`wsl2` only, negative)** — a deliberately interop-mounted
   repository placement and a deliberately Windows-resolved `git` must
   each refuse per §9 rules 3–4.
7. **V7 (`ec2` only)** — V1–V5 on the reference instance shape, plus the
   IMDS canary once a §8 mechanism exists (until then, record S6 as open).

The validation plan is itself future work: running it is part of the
chain's later issues, and V4 cannot execute anywhere until the
capability-report wiring lands (#917 onward). Until a target completes the
plan, every target — `macos` included, its operating history
notwithstanding — remains `supported` in design and `designed` in
maturity — a distinction §12 keeps honest. `operational` is claimed only
from recorded V1–V7 results, never from history predating the plan.

## 12. Current guarantees vs. the spike register

The acceptance boundary this issue was asked to draw: what is demonstrated
today, versus what this contract asserts subject to a technical spike.
Nothing in the spike column may be treated as true by an implementation
slice until its spike lands.

### 12.1 Current guarantees (demonstrated)

| # | Guarantee | Basis |
| --- | --- | --- |
| G1 | The loop operates on macOS today — operating history, not validated maturity: every target, `macos` included, is `designed` until the §11.4 plan (V4's capability report included) runs. | Operating history; §4 matrix; §11.4. |
| G2 | Every agent lane runs a pinned, sanitized argv; no lane passes a permission-bypass flag; the only explicit provider-sandbox pin is the refinement lane's `codex exec --sandbox read-only`. | §6.2, verified in the handlers. |
| G3 | No relaxed tier is shipped: #697 and #915 are approved designs, so every Tool Request is human-gated today and **nothing currently executing depends on the runner sandbox existing**. | #697/#915 status lines. |
| G4 | The operative guarantees on every platform are worktree isolation, human PR review, and the private control plane — none of which this contract weakens or conditions on a sandbox. | §3, `docs/install.md` §1. |
| G5 | Provider CLIs are probed by `--version`, once per distinct binary, memoized. | `admin session-doctor`, issue #839. |

### 12.2 Spike register (assumptions requiring verification)

Each spike: the question, the decision it blocks, and the fail-closed
stance that holds until it lands.

| Spike | Question | Blocks | Interim stance |
| --- | --- | --- | --- |
| S1 | Does the stock WSL2 kernel enable Landlock and unprivileged user namespaces? | Runner-sandbox mechanism choice on `wsl2`; the Codex sandbox story there. | Absent until the §8.3 canary passes on the actual host. |
| S2 | What does the Codex CLI do on a Linux host without Landlock — refuse, or degrade silently? | Whether `codex` cells in §7 stay `supported` on such hosts. | Treat Codex containment as `vendor-documented`, never `verified`; the loop's own guarantees don't lean on it (§3). |
| S3 | What containment, if any, do the `agy` builds the loop drives apply to agent-owned commands? | Raising the Antigravity §6.3 grade above `unknown`; the §7 `degraded` cells. | `unknown` = absent; combinations stay `degraded`; nothing may assume an Antigravity sandbox. |
| S4 | Is Seatbelt (`sandbox-exec`) viable as the macOS runner-sandbox mechanism given its deprecated interface? | Runner-sandbox mechanism choice on `macos`. | No macOS containment attested until a canary passes; deprecation alone neither attests nor refutes. |
| S5 | What mechanism restricts `"registry-metadata"` egress to session-configured endpoints (loopback proxy in a network namespace, or equivalent) on each platform? | The `"package-registry"` containment capability #915 §20 defers here; any relaxed `dependency.sync`. | `"registry-metadata"` entries resolve `"containment-unavailable"` on every host — package-registry work fails closed until this lands. |
| S6 | Does the candidate `network: "none"` boundary demonstrably deny IMDS (`169.254.169.254`) on `ec2`? | Attesting `runner-sandbox.network-none` on `ec2`; the `"platform.imds-guarded"` check. | On `ec2`, `network: "none"` is unattested — absent — until the IMDS canary passes. |
| S7 | Which current distributions restrict unprivileged user namespaces (e.g. AppArmor-confined userns), and what host configuration do namespace-based mechanisms then require? | Linux mechanism choice and §11.2's dependency list. | Namespace availability is probed per host, never assumed from the distribution name. |
| S8 | Does the Claude CLI's documented command sandboxing hold under a behavioral canary on each platform? | Raising Claude's §6.3 grade from `vendor-documented` to `verified`. | `vendor-documented` — credited as documentation in diagnostics, never as attestation. |

## 13. Invariants

1. The runtime platform set is closed — `"darwin"` and `"linux"` — and
   the target set is closed: `macos`, `linux`, `wsl2`, `ec2`. Native
   Windows, WSL1, ECS/EKS/Fargate, Lambda-style runtimes, and every
   multi-host substrate are rejected, not degraded; widening any of these
   sets is a change to this document first (§4).
2. Support levels are the closed set `supported | degraded | rejected`,
   and **unknown evaluates as absent** at every decision point: probes,
   report derivation, matrix lookups (§2, §9 rule 5, §10.2).
3. **No agent CLI sandbox is ever credited with containing runner-owned
   commands.** Runner-owned commands are governed by operator trust,
   worktree scoping, and PR review on the direct-host default — #917's
   `local` backend — or by the isolated backend an operator explicitly
   raised them to (#917 §13 rule 5, the §3 supersession note); pinned
   substitutions only by the runner sandbox; agent-owned commands only
   by their provider CLI's sandbox plus the lane's worktree-and-review
   guarantees (§3).
4. The runner sandbox is a runner capability attested **behaviorally** on
   the live host (§8.3); no provider CLI, version table, or configuration
   read can supply the attestation, and a host without it routes every
   relaxed request `"containment-unavailable"` — never to unconfined
   execution (#697 §6 rule 4, §7 restated).
5. **Degradation subtracts nothing and is never silent**: the base loop
   runs identically on a degraded host, only relaxed-tier and
   containment-dependent plan entries refuse (falling through per #915
   §9), and `admin session-doctor` reports every absent capability
   (§9 rule 6).
6. Startup gates fail closed: unsupported OS, unidentifiable WSL
   generation, interop-mounted loop state, and Windows-resolved loop
   binaries each refuse the process before any lane runs (§9 rules 1–4).
7. On `wsl2`, loop-owned state lives on Linux-native filesystems and
   loop-owned commands resolve to Linux executables; the Windows side of
   the interop boundary is outside the supported surface (§5.3).
8. **Antigravity/Gemini sandbox guarantees are recorded as verification
   work, never assumed**: its containment grade is `unknown`, its
   combinations are `degraded`, and no decision may credit an Antigravity
   sandbox until spike S3 lands (§6.3, §12.2).
9. The capability report is diagnostic: authorization consumes
   resolution-time probes, never a stored report, and no report content
   beyond `supportLevel` and counts reaches a public surface (§10.2).
10. Single-host is a design premise: locks and stores are host-local, and
    nothing in this contract creates or implies cross-host coordination
    (§4, §5.1).
11. This contract adds no runtime behavior, no tier, no
    `TierRefusalReason` member, no plan-state, no event, and no change to
    #697's or #915's policy; its own vocabulary is the platform targets,
    support levels, capability check ids, and report schema defined here.

## 14. Test seams and matrix

For the implementation slices that build against this contract (the docs
pin at the end is the only test landing with #916 itself):

| Area | Cases |
| --- | --- |
| Startup gates (§9 rules 1–4) | pure predicate over an injected facts object (the session-audit facts-injection precedent): `win32` and unknown platforms refuse; Microsoft-kernel-but-unidentified refuses as WSL1; each loop-owned path on an interop-typed mount refuses; a loop binary resolving to `*.exe` or an interop mount refuses; all-green facts pass. |
| Behavioral canaries (§8.3) | out-of-worktree write denied; non-allowlisted connect denied; a planted non-allowlisted environment variable observed absent inside the boundary, and observed leaking through → `"runner-sandbox.env-allowlist"` yields `absent`; IMDS connect denied on `ec2` and on an `unknown` cloud classification; a canary that errors or times out yields `absent`; a declarative-only probe never yields `present` for a `runner-sandbox.*` check. |
| Report derivation (§10.2) | `supportLevel` is a pure function of `platform` and checks, evaluated over the applicable set: gate-absent → `rejected`; gates present + any runner-sandbox check or applicable `"platform.imds-guarded"` absent/unknown → `degraded`; all applicable checks present → `supported`; `unknown` counted as absent; an applicable id missing from `checks` counted as absent (empty `checks` → `rejected`; a partial report never derives `supported`); `"platform.imds-guarded"` applicable whenever `cloud !== "none"` (`unknown` treated as `ec2`, so an unclassified host never derives `supported` without the IMDS canary); a non-WSL `linux`/`ec2` host attests `"platform.wsl2-identified"` `present` via the non-WSL classification and is never `rejected` for lacking a WSL2 identity; a `checks` array with inapplicable, duplicate, or unknown ids rejected at construction. |
| Degraded routing (§9 rule 6) | with capability absent, a relaxed-tier resolution refuses `"containment-unavailable"` and a containment-needing plan entry falls through per #915 §9 with base behavior unchanged; nothing silently executes unconfined. |
| Provider probes (§6.1) | one memoized `--version` spawn per distinct binary; a P1–P4-deficient provider is a doctor error scoped to sessions assigning it, not a process refusal. |
| Docs pin | `test/docs-single-host-platform-sandbox-contract.test.js` pins this document's status line, chain position, closed platform and support-level sets, the non-goal rejections, the runner-owned/agent-owned separation rule, the behavioral-attestation rule, the fail-closed startup gates, the degraded-mode subtraction-free policy, the WSL2 placement and toolchain rules, the unknown-as-absent rule, the unknown-cloud IMDS rule, the non-WSL classification rule, the Antigravity verification-work stance, the closed check-id set, the spike register, and the reconciliation notes in `docs/tool-request-grant-tiers-contract.md` §18 and `docs/preflight-execution-plan-contract.md` §20 (and `docs/DOMAIN.md` §5 where present) against drift. |

## 15. Non-goals and forward pointers

This document defines the platform and sandbox-capability contract only. It
does not define, and nothing implementing it should assume:

- **The runner-sandbox mechanism choice, the probe and canary
  implementations, the capability-report wiring, and the execution
  plumbing that runs planned entries** — the chain's later issues (#917
  onward; see the issue body for the authoritative GitHub Issue
  Relationships), per #915 §20's own deferral.
  **Delivered (#917)**: `docs/single-host-execution-backend-contract.md` —
  the single-host isolated ExecutionBackend contract: the closed
  backend set (`local`, `native-sandbox`, `container`) behind every
  runner-owned command execution, per-axis enforcement records
  credited only through §8.3's behavioral attestation, fail-closed
  backend selection consuming resolution-time probes, and the
  packaging layouts that keep the container-runtime socket unreachable
  from untrusted execution. The mechanism choice itself, the canary
  implementations, the capability-report wiring, and the
  validation-plan runs remain with the chain's later issues (#918
  onward).
- **Execution of the §11.4 validation plan** — the same later issues;
  until it runs, every target — `macos` included — stays `designed`
  maturity.
- **Container/VM execution as a general substrate for agent-proposed
  commands** — the `docs/tool-request-redesign.md` §6/§9.4 track,
  unchanged; this contract's runner sandbox contains runner-owned
  executions only — pinned substitutions, plus the operator-raised
  classes #917 §13 rule 5 admits — and never agent-proposed commands,
  exactly as #697 §18 scopes it.
- **Any change to `docs/install.md`'s flow, the session schema, the admin
  CLI grammar, or the ChatOps verb table** — governed by their own
  contracts when the surface slices land.
- **Native Windows, ECS/EKS/Fargate, Lambda-style runtimes, and
  multi-host coordination** — explicitly rejected for this design cycle
  (§4); revisiting any of them is a change to this document first.
