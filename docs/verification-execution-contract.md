# Runner-owned verification execution and continuation contract

Status: **approved design, not yet implemented** (issue #918). This
document is the authoritative contract for how the runner executes
configured verification — the operator-authored `session.verification`
commands and the #915 preflight-approved verification plan entries —
through the selected `ExecutionBackend`, classifies every result,
aggregates a multi-command set into one coherent outcome, and chooses
the next phase. Follow-up implementation issues reference this
specification and MUST NOT redefine its policy; a change of policy is a
change to this document first.

This is issue #918, the successor of the single-host isolated
ExecutionBackend contract (#917) in the executable chain
`#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917
→ #918 → #919 → #722` (see the issue body for the authoritative GitHub
Issue Relationships). #917 deliberately left the judgment of a
verification run to "the consuming contract" — a nonzero `npm test` is a
verification result, not a backend error (#917 §11.1) — and this
document is that consuming contract: it consumes #917's outcomes, it
never re-defines them. It adds no runtime behavior: the unified
verification engine, the policy schema, the continuation wiring, and the
direct-to-review resolution surface are the chain's later issues (#919
onward, with #722 the direct-routing slice — §13).

It does **not** specify, and no implementation built against it may
assume:

- **Verification ownership, non-derivation, and session configuration**
  — fixed by `docs/environment-prepare-contract.md` §3.1–§3.3:
  `session.verification` stays operator-authored, never derived from
  issue text or agent output, never modifiable, skippable, or
  reorderable by an agent. This contract extends §3.4's timing with
  execution and continuation semantics; it changes no ownership rule.
- **The ExecutionBackend interface, lifecycle, outcome and refusal
  taxonomies, backend selection, and recovery** — fixed by
  `docs/single-host-execution-backend-contract.md` (#917). This
  contract maps `ExecutionOutcome` values onto verification
  classifications (§7); it adds no backend id, no operation class, no
  outcome, and no refusal reason.
- **The preflight Execution Plan schema, approval, invalidation, and
  occurrence reservation** — fixed by
  `docs/preflight-execution-plan-contract.md` (#915). A verification
  cycle *consumes* an approved `"plan-approval"` verification entry
  under #915 §10's report-only, per-verification-cycle semantics; this
  document defines the verification-cycle identity those semantics
  name (§2), and nothing else about plans.
- **The three tiers and the enforcing sandbox demand** — fixed by
  `docs/tool-request-grant-tiers-contract.md` (#697).
- **The platform targets and capability attestation** — fixed by
  `docs/single-host-platform-sandbox-contract.md` (#916).
- **The guided operator flow** — fixed by
  `docs/guided-tool-request-flow.md`; the human gate *is* that flow.
  §10 records the exact revisions #722 must make to that flow's
  continuation rules before direct-to-review routing may be
  implemented; this document itself changes nothing there.
- **The issue-required verification extractor and matching semantics**
  — the shipped `extractIssueVerificationCommands` /
  `buildIssueVerificationStatus` behavior (issue-body heading scan,
  exact/trimmed/shell-wrapper command equivalence) is the recorded
  baseline this contract reuses for routing classification (§10), never
  redefines.
- **Review dispute machinery** — `docs/review-dispute-contract.md` and
  its successors own everything after review admission; the §7.1
  routing overrides that can displace an ordinary transition stand
  unchanged.

## 1. Why this contract — the gap it closes

Configured verification is part of the workflow contract, not an
unexpected agent request. The operator authored the commands
(`docs/environment-prepare-contract.md` §3.1), or approved them once at
preflight (#915 §7); requiring a human to approve the same verification
again mid-run interrupts long-running execution and duplicates a
decision that was already made with better context. Yet the shipped tree
under-specifies everything between "the runner runs the commands" and
"the task moves on":

- **Three divergent execution sites.** The implementation lane uses the
  shared `runVerification` (`src/handlers/verification.ts`); the review
  lane inlines its own loop (no `maxBuffer`, so a verbose *passing*
  command can be misreported; no empty-command skip); the
  conflict-resolution lane defines a third local variant. Same
  contract, three behaviors.
- **First-failure-only evidence.** Every shipped site stops at the
  first nonzero exit. A set of three commands with three failures
  surfaces them one escalation at a time — the operator and the agent
  resolve one command per cycle instead of one set per cycle.
- **No classification.** A spawn failure, a timeout, a sandbox refusal,
  and a deterministic test failure all surface as "verification
  failed". Infrastructure problems masquerade as code problems and burn
  agent invocations that cannot fix them.
- **No timeout.** No shipped verification site passes a time budget; a
  hung test holds the phase forever.
- **Continuation is lane-inconsistent and partly hardcoded.** The same
  code failure routes `failed` in implementation, `needs_fix` in
  review, and escalation in conflict resolution — defensible per lane,
  but recorded nowhere as one table. Every Tool Request resolution
  requeues to `implementation` unconditionally, so a task whose work is
  already pushed and PR'd pays one more no-op agent invocation before
  review (issue #404 made that no-op a success; #722 wants it gone).
- **Review admission carries no verification evidence.** The #681
  admission preflight checks a durable PR reference, a head selector,
  the dependency review base, and the absence of an unresolved Tool
  Request — deliberately nothing else. Any direct-to-review continuation
  therefore needs its own evidence rules, or arbitrary successful
  commands would route blind into review.

This contract fixes all of it as design: one verification-set schema and
lifecycle (§5–§6), one closed classification (§7), one aggregate result
per cycle (§8), one continuation table (§9), evidence-validated direct
routing to review (§10), and a bounded observability contract (§11) —
with a compatibility mapping (§12) that keeps every shipped behavior
either preserved verbatim or changed as a recorded, slice-owned change,
never silently.

## 2. Terminology

- **Verification command** — one named check: the `session.verification`
  key plus its exact configured command bytes, or one #915
  `"plan-approval"` entry of family `verification`.
- **Verification set** — the ordered list of verification commands
  resolved for one cycle (§5.1). The order is deterministic:
  `session.verification` entries in declaration order, then applicable
  plan entries in ascending `entryId` order.
- **Verification lane** — where in the phase flow a cycle runs. The
  lane set is **closed**: `"implementation"` | `"review"` |
  `"conflict-resolution"` | `"tool-request-continuation"` (§4). Adding
  a lane is a change to this document first.
- **Verification cycle** — one complete execution of the verification
  set within a lane. The **verification-cycle identity** is
  `(taskAttempt, lane, cycleOrdinal)`, with `cycleOrdinal` starting at
  0 per attempt and lane and incrementing once per launched cycle.
  Joined to the runner-injected scope triple
  `(sessionId, repo, issueNumber)`, this is the
  `"per-verification-cycle"` occurrence window #915 §10 names without
  defining — defined here, consumed there.
- **Classification** — the per-command judgment of one execution (§7).
  The set is closed: `"passed"` | `"code-failure"` | `"timeout"` |
  `"infrastructure"` | `"sandbox-policy"` | `"tainted"` | `"cancelled"`
  | `"lost"` | `"not-run"`.
- **Cycle outcome** — the aggregate judgment of one cycle (§8). The set
  is closed: `"passed"` | `"code-failed"` | `"infrastructure"` |
  `"sandbox-policy"` | `"tainted"` | `"cancelled"`.
- **Evidence bundle** — the complete, durable result of one cycle
  (§8.2): every command's classification and bounded output, the
  worktree dirty state, and the binding identities. The bundle — never
  an agent statement — is the only admissible evidence that
  verification ran or passed.
- **Set fingerprint** — the SHA-256 over the canonical ordered
  `(name, operationClass, command identity)` list of the resolved set
  (§5.1). Evidence binds to it; a configuration change is different
  evidence.
- **Verification-gap Tool Request** — a Tool Request whose command
  matches a configured `session.verification` value under the shipped
  matching semantics (§10.2). A routing classification only — never an
  authorization.
- **Verification-first continuation** — the §10 procedure a Tool
  Request resolution may take: run a full verification cycle over the
  continuation state, validate the §10.3 evidence set, and route to
  review on a passed cycle — to implementation otherwise.

## 3. Standing authorization — known verification never stops for a human

1. **`session.verification` is standing operator authorization.** The
   operator authored the exact command bytes in session configuration;
   executing them is the runner's job at the §4 moments, with no
   per-run approval, no Tool Request, and no operator interaction. A
   #915 `"session-default"` verification entry records exactly this
   mechanism and changes nothing about it (#915 §3; #917 §3, fourth
   corollary).
2. **A #915 `"plan-approval"` verification entry is preflight
   authorization.** The operator approved the plan once; each occurrence
   is authorized by resolution against the approved snapshot, reserved
   per verification cycle, and executed as `"verification.pinned"`
   under an attested isolated backend (#915 §9–§10, #917 §2–§3). No
   additional human stop exists on the happy path.
3. **Everything else remains a Tool Request.** A command that is
   neither configured nor plan-approved is not verification the runner
   may run; the agent surfaces the gap (a Tool Request or an explicit
   note, `docs/environment-prepare-contract.md` §3.3) and the human
   gate owns it, unchanged.
4. **The runner is authoritative for execution and routing.** The agent
   cannot run, modify, skip, or reorder configured verification, and an
   agent's *statement* that verification succeeded is inert: only a §8.2
   evidence bundle produced by the runner's own execution counts, for
   continuation, for review admission, and for every public summary. An
   agent transcript claiming "all tests pass" carries exactly as much
   routing weight as any other agent-authored byte in backend selection
   (#917 §13 rule 1): none.
5. **A successful command is not a completed implementation.** A passed
   cycle proves the configured checks pass on the verified state —
   nothing more. Whether the change is *complete* stays the business of
   the phase contracts and review; §10.4 is where this rule bites.

## 4. When verification runs — lanes, timing, prerequisites

### 4.1 The lanes

| Lane | When the cycle runs | Shipped anchor |
| --- | --- | --- |
| `implementation` | After the agent diff and after dependency sync, **before any commit/push/PR creation**, so a known-broken commit is never pushed; inside the bounded repair loop — each repair iteration is a new cycle | `docs/environment-prepare-contract.md` §3.4 point 1; implementation Step 5.5 |
| `review` | After the PR head checkout in the review worktree, before the review agent runs | §3.4 point 2 |
| `conflict-resolution` | After merge resolution, before the merge commit; a failure aborts the merge | §3.4 point 3 |
| `tool-request-continuation` | After a Tool Request resolution re-queues the task and the §10 procedure applies: over the worktree continuation state, with no agent invocation | New in this contract; the #722 hook |

### 4.2 Prerequisites — environment preparation and cache validity

No verification cycle launches against an unprepared or stale
worktree:

1. **The prepare stamp must be current.** Where `environmentPrepare`
   is enabled, the stamp check of
   `docs/environment-prepare-contract.md` §2.4–§2.5 runs first — in
   particular §2.5 point 3: after dependency sync changed a
   `cacheKeyFiles` hash, a fresh prepare runs before any verification
   command. Backend and fingerprint changes invalidate the stamp per
   #917 §7 rule 1.
2. **A failed prepare stops before verification.** The fail-closed
   semantics of §2.6 apply verbatim: the phase stops, no verification
   command launches, and the stop is an environment-prepare failure —
   never recorded as a verification result and never fed to the agent
   as code evidence.
3. **The deferred-prepare ordering survives.** In the
   conflict-resolution lane with conflicted dependency files, prepare
   runs after the agent and before verification, exactly as §2.5's
   deferred path orders it.

## 5. The verification set

### 5.1 Resolution

The runner resolves the set once per cycle, deterministically, from
operator-owned inputs alone:

1. Every `session.verification` entry, in declaration order, becomes
   one command of operation class `"verification.run"`, carried as a
   `form: "tokenized"` spec — the configured bytes verbatim in
   `command.line`, argv derived exactly once by the fixed tokenizer
   (#917 §6.2). An entry whose value is the empty string is recorded
   `"passed"` with an `emptyCommand` marker and launches nothing. That
   skip is shipped behavior in the implementation and
   conflict-resolution lanes only; the shipped review lane has no
   blank guard, so extending the skip there is a recorded V1 change
   (§12.2), not preserved behavior.
2. Every applicable #915 `"plan-approval"` entry of family
   `verification`, in ascending `entryId` order, becomes one command of
   operation class `"verification.pinned"`, its form fixed by its
   origin's `execution.kind` (#917 §6.2), executing only under the
   attested isolated backend its class floor demands (#917 §13
   rule 4). Plan entries join cycles in the `implementation` and
   `tool-request-continuation` lanes only — the lanes whose cycles are
   the #915 `"per-verification-cycle"` windows; the `review` and
   `conflict-resolution` lanes run the session-configured commands
   alone, as shipped.
3. Nothing else. No issue text, agent output, PR content, or
   auto-detection contributes a command
   (`docs/environment-prepare-contract.md` §2.1's non-derivation rule,
   applied to verification since §3.2).

The **set fingerprint** is the SHA-256 of the canonical JSON of the
ordered `(name, operationClass, command identity)` list, where command
identity is the exact `line` bytes for command-string forms and the
routine name plus canonical input for `form: "routine"` (#917 §6.2).
Command bytes are never re-fingerprinted; the set fingerprint is a
binder over identities the predecessors already pinned.

### 5.2 Session policy (additive schema)

`session.verification` itself is preserved verbatim as
`Record<string, string>` (§12.1). Execution limits live in a new,
optional, sibling block:

```json
{
  "verificationPolicy": {
    "timeoutMs": 600000,
    "setTimeoutMs": 1800000,
    "perCommand": { "test": { "timeoutMs": 900000 } }
  }
}
```

- `timeoutMs` — per-command budget, default `600000` (10 minutes) when
  absent. It becomes `limits.timeoutMs` on every resolved
  `"verification.run"` spec (#917 makes the field mandatory). It never
  applies to a `"verification.pinned"` command: a plan entry's budget
  is the approved contract's own `timeoutMs` — a #915 §6 fingerprinted
  policy axis, changeable only through approval renewal — carried onto
  the resolved spec verbatim. Session policy substituting its own
  value would silently rewrite an approved pinned contract and could
  terminate a valid pinned verification early.
- `setTimeoutMs` — optional whole-set budget, enforced as a real
  execution deadline: it bounds the running command as well as the
  not-yet-launched ones, via the §6.2 rule 2 clamp, so one long
  command cannot overrun it. When absent, the set has no bound beyond
  its commands' own budgets.
- `perCommand.<name>.timeoutMs` — per-command override; a name that
  matches no `session.verification` key fails session load validation,
  so an override can never reach a plan entry.

Validation is fail-closed at session load: non-positive or non-integer
values, unknown fields, and unknown `perCommand` names refuse the
session, mirroring the existing registry posture. Introducing the
default budget is a **recorded behavioral change** (a shipped
verification command runs unbounded today) owned by slice V2 (§13),
never a side effect of the engine unification.

## 6. Execution lifecycle within one cycle

### 6.1 Per-command execution

Each command is one resolved #917 spec executed through the selected
backend under its class — `"verification.run"` on the class's session
policy (compatibility default `local`, #917 §13 rule 5),
`"verification.pinned"` on its attested isolated floor. Captures are
bounded per #917 §9; the agent-facing tail keeps the shipped
`MAX_VERIFICATION_OUTPUT_CHARS` (4000 characters, tail-keeping)
truncation.

For a pinned command, the #915 occurrence reservation is taken
immediately before its launch and settled with the run's outcome in the
run's own audit transaction — #915 §10 restated, not redefined. A
command the cycle never launches (§6.2 stop rules) takes no
reservation.

### 6.2 Ordering and the stop rules

The set executes in resolution order. Whether a later command runs
after an earlier failure is fixed per classification — the rules exist
so one cycle produces the *complete* picture wherever completeness is
trustworthy, and stops wherever it is not:

1. **`code-failure` continues.** A nonzero exit is exactly the evidence
   the fix loop wants, and the next command's result is still
   meaningful. Later commands run; the cycle collects every failure at
   once.
2. **`timeout` continues.** The expired command is killed per #917
   §8.4 and recorded; later commands run under their own budgets. When
   `setTimeoutMs` is configured it is a hard deadline for the running
   command, not only a launch gate: every command launches with an
   effective `limits.timeoutMs` of
   `min(per-command budget, remaining set budget)`, the remainder
   measured at that command's launch, so no launched command can
   outlive the set budget (#917 already makes `limits.timeoutMs`
   mandatory on every spec — the clamp reuses that field and adds no
   backend vocabulary). For a `"verification.pinned"` entry the
   per-command term is its plan-approved budget (§5.2), never session
   policy; the set deadline may still bound its effective budget —
   approval fixes the *maximum* an operation may consume, and a
   smaller `effectiveTimeoutMs` stays inside the approved envelope —
   but nothing here ever extends a pinned budget past its approved
   value. A command killed because the clamped budget
   expired classifies `timeout` exactly like a per-command expiry,
   with the clamped value recorded as the command's
   `effectiveTimeoutMs` (§8.2) so the evidence names the budget that
   bound it; every command the exhausted set budget keeps from
   launching records `"not-run"` (reason `set-budget-exhausted`)
   instead of launching.
3. **`infrastructure` stops the set** — after at most one transient
   relaunch: when the backend reported a spawn-level failure with no
   process created (#917 §5 rule 2's pre-launch path), the runner may
   relaunch **once** in the same cycle as a new run over the same spec.
   This retry exists for `"verification.run"` only, whose operator-owned
   reruns are safe by effect confinement (#917 §12 rule 4); a
   `"verification.pinned"` never-launched run settles its reservation
   per #917 §12 rule 5 and its retry path is the next cycle, never a
   same-window relaunch. A second failure — or any post-launch
   infrastructure failure — ends the command `"infrastructure"` and
   stops the set: the substrate is broken, later results would be
   untrustworthy, and every remaining command records `"not-run"`
   (reason `infrastructure-stop`).
4. **`sandbox-policy` stops the set immediately, no retry.** A #917
   refusal (`"backend-unavailable"`, `"capability-unattested"`,
   `"policy-unenforceable"`, `"spec-invalid"`, `"mount-unresolvable"`,
   `"image-unpinned"`) is deterministic operator configuration state;
   re-running cannot change it. Remaining commands record `"not-run"`
   (reason `sandbox-policy-stop`).
5. **`tainted` continues.** A report-only pinned run whose observed
   effects left `allowedEffects` is recorded and surfaced per #915 §10
   — it does not count as passed, and §8 makes the cycle outcome
   reflect it — but the taint is a trust fact about that command, not
   a broken substrate; later commands still produce usable evidence.
6. **`cancelled` stops the set.** Cancellation is an operator act
   (#917 §8.3); remaining commands record `"not-run"` (reason
   `cancellation-stop`).
7. **`lost` stops the set** exactly as `infrastructure` does; it is
   assigned only by reconciliation (#917 §11.1) and a lost run adopts,
   stamps, and verifies nothing (#917 §12 rule 6).

### 6.3 Retry discipline

- The runner never auto-retries a `code-failure` or a `timeout`.
  Re-running to green would mask flaky tests and grant unearned passes;
  a flake is a code-quality fact the fix loop and review should see.
- The single transient relaunch of §6.2 rule 3 is the only same-cycle
  retry anywhere in this contract.
- New cycles come only from the lanes' own loops (§9): the
  implementation repair loop within its existing cap, the review loop
  within its existing cycle cap, a fresh task attempt.

## 7. Failure classification

The per-command classification is a total function of the #917
`ExecutionResult` plus, for pinned commands, the #915 effect check:

| #917 outcome | Additional condition | Classification |
| --- | --- | --- |
| `ran`, exit 0 | pinned command with out-of-enumeration writes (#915 §10) | `tainted` |
| `ran`, exit 0 | otherwise | `passed` |
| `ran`, nonzero exit | — | `code-failure` |
| `timeout` | — | `timeout` |
| `infrastructure` | after §6.2 rule 3's bounded relaunch | `infrastructure` |
| `refused` | — | `sandbox-policy`, carrying the §11.2 refusal reason verbatim |
| `cancelled` | — | `cancelled` |
| `lost` | — | `lost` |
| (not launched) | §6.2 stop rules or set budget | `not-run`, with its reason |

Two rules keep the classification honest, in both directions:

- **Infrastructure and isolation failures never masquerade as code
  failures.** An `infrastructure`, `sandbox-policy`, or `lost` command
  is never fed to the agent as fix input, never consumes a repair
  attempt, and never appears in a fix prompt as a failing check — it is
  an operator-facing fact (#917 §11.3: an unsatisfiable isolation
  policy is an operator configuration problem, not an agent boundary).
- **A code failure is never laundered into an infrastructure retry.**
  `ran` with a nonzero exit is `code-failure` regardless of how the
  output reads; no heuristic inspects command output to reclassify.
  `timeout` sits deliberately on the code side of the line: the
  dominant cause of a hung verification command inside a bounded,
  prepared worktree is the change under test, the evidence (the bounded
  tail plus the configured budget, both in the bundle) is actionable by
  the agent, and an operator whose budget is genuinely too small reads
  exactly that from the bundle and fixes policy, not code.

## 8. Aggregation — one cycle, one outcome

### 8.1 The cycle outcome

Every escalation resolves all verification results as one set. The
cycle outcome is derived from the per-command classifications by
precedence — first row that matches any command wins:

| Precedence | Any command classified | Cycle outcome |
| --- | --- | --- |
| 1 | `cancelled` | `cancelled` |
| 2 | `sandbox-policy` | `sandbox-policy` |
| 3 | `infrastructure` or `lost` | `infrastructure` |
| 4 | `tainted` | `tainted` |
| 5 | `code-failure` or `timeout` | `code-failed` |
| 6 | none of the above (all `passed`, `emptyCommand` included) | `passed` |

An empty resolved set is `passed` trivially — the shipped behavior of a
session with no verification configured. `not-run` never produces a
cycle outcome by itself; the classification that caused the stop does.

### 8.2 The evidence bundle

One cycle produces one durable bundle — the shape is normative;
persistence is an implementation slice:

```ts
interface VerificationCycleResult {
  cycleId: {
    taskAttempt: number;
    lane: VerificationLane;
    cycleOrdinal: number;
  };
  setFingerprint: string;
  headSha?: string;               // worktree HEAD when resolvable
  worktree: {
    clean: boolean;               // `git status --porcelain` empty
    dirtyFiles?: readonly string[];
    patchArtifact?: string;       // run-artifact-relative, when captured
  };
  outcome: VerificationCycleOutcome;
  commands: readonly {
    name: string;
    operationClass: "verification.run" | "verification.pinned";
    classification: VerificationCommandClassification;
    exitCode?: number;            // present iff the command ran
    notRunReason?: "infrastructure-stop" | "sandbox-policy-stop"
                 | "cancellation-stop" | "set-budget-exhausted";
    refusalReason?: string;       // #917 §11.2 reason, iff sandbox-policy
    emptyCommand?: boolean;       // §5.1 blank-entry skip marker
    outputTail?: string;          // bounded per §6.1; failures only
    logArtifact?: string;         // run-artifact-relative path
    requestDigest?: string;       // #917 §4.2 execution identity
    effectiveTimeoutMs?: number;  // §6.2 rule 2 clamp; present iff launched
    durationMs?: number;
  }[];
}
```

Rules:

1. **Complete, not first-failure.** The bundle carries every command's
   entry — passed, failed, and not-run alike — so neither the agent nor
   the operator ever resolves one command at a time. Replacing the
   shipped first-failure-only feedback with the full bundle is a
   recorded behavioral change owned by slice V3 (§13).
2. **Code failure and dirty worktree travel together.** When a
   `code-failed` cycle returns to implementation, the *one* fix input
   is the bundle: every failing command's name, exit code, and bounded
   tail, plus the worktree dirty state (`dirtyFiles`, the patch
   artifact reference, and the shipped `commitSkipped` posture). The
   shipped `dirtyContinuation` marker is this bundle's compatibility
   ancestor (§12.2) — the agent sees the test failure and the
   uncommitted state it must reconcile in the same prompt, never in
   separate escalations.
3. **Evidence binds to identities, not to time.** A bundle is evidence
   only for its `setFingerprint`, its `headSha` (or, dirty, its
   recorded worktree state), and — per command — its `requestDigest`.
   A session configuration change, a new commit, or a backend
   fingerprint change makes it a historical artifact, not admissible
   continuation evidence.
4. **Consumption is per escalation.** The bundle is consumed by the
   continuation it routes (§9); it is not carried into another run
   unless explicitly retained by an operator act, and the shipped
   clearing of manual verification evidence on requeue is the model:
   retention is the exception, recorded, never the default.
5. **Operator resolution acts on the set.** Where a cycle escalates to
   a human, the operator surface presents and resolves the whole
   bundle in one decision. The shipped per-command
   `admin review-verification resolve` remains for the issue-required
   gate (§12.4); the set-level surface is slice V5 (§13).

## 9. Continuation — the classification table

The full lane × outcome table. **No new phase-runner vocabulary
exists**: no new `PhaseRunOutcome` member, no new `PhaseHandlerResult`
member, no new `TaskStatus`, and no change to `nextPhaseAfter`'s
transition set — every cell routes through vocabulary that ships today
(#917 §11.3's discipline, applied to continuation).

| Lane | `passed` | `code-failed` | `infrastructure` | `sandbox-policy` | `tainted` | `cancelled` |
| --- | --- | --- | --- | --- | --- | --- |
| `implementation` | Proceed to stage/commit/push/PR; phase `success` routes queued→review exactly as shipped | Repair loop while the existing cap allows (each iteration a new cycle); at the cap, phase `failed` carrying the §8.2 bundle with commit/push skipped — the shipped dirty-continuation posture | Phase `failed`, infrastructure-classified: no agent invocation, no repair attempt consumed, no code blame in the bundle | Same fail-closed stop, naming the #917 §11.2 refusal reason — operator configuration, never an agent boundary | Unattended continuation stops at the lane's human park (`blocked` on implementation, the shipped issue-#224 posture); result recorded and surfaced per #915 §10 | Phase stops; the cancellation is the recorded outcome (issue #608 posture), no automatic continuation |
| `review` | Proceed to the review agent (the issue-required verification gate follows, unchanged) | `needs_fix` carrying the bundle; at the review-loop cycle cap, escalate to the human gate — both exactly the shipped routes | Fail-closed phase failure naming the reason — never `needs_fix`, never an agent turn | Same | — (no pinned commands in this lane, §5.1) | Same as implementation |
| `conflict-resolution` | Proceed to commit and push the merge | Abort the merge, clean residue, escalate per the shipped semantic-conflict policy — a deterministic failure, never retried as transient | Fail-closed; merge aborted; infrastructure-classified | Same | — | Same |
| `tool-request-continuation` | §10 evidence validation; full pass → re-queue `{queued, review}`; any miss → re-queue `{queued, implementation}` (the ordinary continuation, never a hard stop) | Re-queue `{queued, implementation}` with the bundle as fix input — the #678 failed-clean posture generalized to the whole set | Fail-closed stop; the task stays parked for the operator who resolved the request | Same | Stays at the human gate; the resolution does not complete unattended | Same |

Four rules the table depends on:

1. **An infrastructure or sandbox-policy cycle never consumes an agent
   resource.** It consumes no repair attempt, no review cycle, and no
   fix invocation; the failing substrate or policy is repaired by an
   operator, and the same attempt's loop capacity is intact when the
   cycle re-runs.
2. **Caps stay lane-owned and unchanged.** The implementation repair
   cap and the review loop cycle cap are existing session-owned values;
   this contract counts cycles against them exactly as the shipped
   loops do and adds no cap of its own.
3. **Cycle ordinals advance per launched cycle** regardless of outcome,
   so #915 reservation windows never alias across an infrastructure
   re-run.
4. **A pinned stop keeps its #917 §11.3 route.** The `infrastructure`
   and `sandbox-policy` columns above state the `"verification.run"`
   consumption. When the command whose classification stopped the set
   is a `"verification.pinned"` entry (only the `implementation` and
   `tool-request-continuation` lanes can contain one, §5.1), its
   refusal or infrastructure failure routes per #917 §11.3's
   `verification.pinned` `refused`/`infrastructure` column instead —
   the `environment.pinned` route: the existing
   `"containment-unavailable"` handling — reached, for a refusal,
   through `"backend-unavailable"` / `"capability-unattested"` /
   `"policy-unenforceable"` — falling through #915 §9's ordinary
   refusal chain — never a fallback to the shipped mechanism or
   another backend, and never this table's generic phase failure.
   Nothing else moves: §7 classifies and §8 aggregates identically,
   the bundle records the stop, and rule 1 holds on that route too —
   no agent resource is consumed. A pinned command classified `lost`
   keeps the table's `infrastructure` cell — #917 §11.3's pinned
   `lost` column is a fail-closed verification failure — and a run
   recovery closes `"never-launched"` follows the
   refused/infrastructure column, both #917 rules consumed here, not
   redefined.

## 10. Direct routing to review — the #722 contract, validated with revisions

### 10.1 The shape of the problem

Issue #722 describes direct routing to review after a successful guided
verification request. Today no such route exists anywhere: the guided
flow's only continuation destination is `implementation`
(`docs/guided-tool-request-flow.md` §4.1–§4.2), every Tool Request
requeue surface hardcodes `implementation`, and the resumed no-op
implementation run (issue #404) is the pressure valve that makes the
detour survivable. The detour is real waste — one full agent invocation
that changes nothing — but removing it blind would let *any*
successfully executed command promote a task into review. The
acceptance boundary of this design is exactly that: **no blind review
routing after arbitrary successful commands.**

### 10.2 Eligibility — verification-gap classification

A Tool Request resolution is *eligible* for the verification-first
continuation when the resolved request is a **verification-gap
request**: its command matches a configured `session.verification`
value under the shipped matching semantics (exact/trimmed match plus
shell-wrapper equivalence — the `buildIssueVerificationStatus`
behavior pinned by `test/verification-status.test.js`).

A request matching only an issue-required verification command — one
the issue body demands but no `session.verification` value covers — is
deliberately **not** eligible: the §10.3 cycle executes the resolved
set alone (§5.1) and ignores the guided run, so the required command
would never execute on this route, while the review gate (Step 4.5,
§12.4) admits only a `session.verification` match, manual operator
evidence, or the implementation-lane pinned bundle — none of which
this continuation can produce. Direct routing would trade the no-op
implementation detour for a review blocked on unexecuted required
verification. Such a resolution keeps the shipped implementation
continuation.

This classification is **routing metadata only**. It decides which
continuation is *attempted* by default; it authorizes nothing, and it
can afford to be text-based precisely because every route it selects
re-validates evidence independently: a misclassified request reaches,
at worst, the §10.3 gate — whose failure mode is the ordinary
implementation continuation, i.e. exactly today's behavior. (#915 §7's
"not text matching" rule governs authorization; nothing here touches
authorization.) A non-eligible resolution keeps the shipped
implementation continuation unconditionally. An operator may direct an
eligible resolution back to the implementation continuation explicitly;
no operator input can waive §10.3.

### 10.3 The verification-first continuation

For an eligible resolution that left the task re-queueable (the shipped
clean-worktree / no-changes / committed-disposition postures), the
runner — with no agent invocation:

1. Resolves the current verification set (§5.1) and runs one full cycle
   in the `tool-request-continuation` lane over the worktree
   continuation state. The guided run's own success or failure
   contributes **nothing** here: the operator-approved command already
   served its purpose by unblocking the flow, and its exit status is
   already judged by the guided flow's dispositions. Evidence for
   review is the runner's cycle, alone.
2. On any outcome but `passed`, routes per the §9 table — a
   `code-failed` cycle re-queues to implementation with the bundle as
   fix input, so a genuine failure surfaces to the loop exactly as if
   the implementation lane had found it.
3. On `passed`, validates **all** of the following evidence, from
   durable task context and the local repository state, before
   re-queueing to review:

   - **E1 — branch**: the recorded continuation branch (`ai/issue-<n>`,
     or the fix PR's head ref) exists on `origin` after a fetch — the
     guided flow's own continuation-point rule, re-checked at routing
     time.
   - **E2 — PR reference**: a durable `prUrl` or `branch` is recorded
     and resolves to a head selector (the #681 admission checks 2–3,
     validated here so the re-queue cannot manufacture a review run
     that admission would immediately fail).
   - **E3 — review base**: a dependency-started task carries its
     recorded `dependencyBase.baseHeadSha` (#681 check 4).
   - **E4 — clean worktree**: the worktree is clean after the cycle
     (`git status --porcelain` empty). Verification that dirtied the
     tree, or partial work left uncommitted, is work review would never
     see — it belongs to the implementation lane.
   - **E5 — pushed commit**: the local branch head equals the `origin`
     branch head **and** equals the `headSha` the passed bundle is
     bound to. What review will fetch is byte-for-byte what
     verification passed on.
   - **E6 — Tool Request state**: after this resolution commits, no
     unresolved Tool Request remains on the task (#677's authority
     rule; #681 check 1).
   - **E7 — evidence freshness**: the passed bundle's `setFingerprint`
     equals the currently resolved set's fingerprint (a session
     configuration change between cycle and routing invalidates the
     evidence), **and** every execution identity still holds: the
     runner re-resolves the set's commands to their current #917 specs
     and backend bindings — a resolution only, never a run — and each
     launched command's recorded `requestDigest` (§8.2) must equal the
     digest the current binding yields. A backend binding change
     between cycle and routing — a sandbox-profile, image-digest, or
     executor-build update moving `backendId` or its fingerprint — is
     exactly §8.2 rule 3's inadmissibility, which `setFingerprint`
     alone cannot see. A §5.1 empty-command skip marker launches
     nothing, records no `requestDigest`, and is exempt from the
     digest comparison. Given step 1 runs the cycle inside this same
     continuation, E7 fails only when configuration or a backend
     binding changed mid-flight — and it fails closed.

   Every check that fails routes to the implementation continuation —
   the shipped no-op-resume path (#404) — with the failed check named
   in the resolution record. There is no hard-failure route out of
   evidence validation and no partial credit: all seven or
   implementation.
4. On full validation, re-queues `{status: "queued", phase: "review"}`
   — the exact vocabulary the shipped implementation→review success
   edge uses. Review admission (#681) then runs unchanged on the
   receiving side; this contract adds no verification evidence to
   `checkReviewAdmission` (§12.4), because E2/E3/E6 already guarantee
   its checks hold and the review lane re-executes verification in its
   own worktree regardless.

### 10.4 Why state evidence, not intent

A Tool Request interrupts an agent mid-run; no evidence can prove the
agent had no further edits planned (§3 rule 5: a successful operation
does not mean the implementation is complete). This contract
deliberately validates **state**, not intent: E4 and E5 prove there is
no pending work product the routing would strand — nothing uncommitted,
nothing unpushed — and eligibility (§10.2) restricts the default to
requests whose own content declares the work was at the verification
stage. What state cannot prove, review judges: a semantically
incomplete change that passes every configured check routes to a
reviewer whose `needs_fix` is the correct verdict and the correct
route. The alternative — an unconditional extra agent invocation to
"finish" — is exactly the no-op detour #404 measured and #722 exists to
remove; it stays available as the fallback for every non-eligible or
evidence-failing case, so this design subtracts nothing.

### 10.5 Verdict on #722

**Validated, with the following revisions required before #722 is
implemented** — #722 as titled ("direct routing to review after a
successful guided verification request") is unsafe without them:

- **R1** — The guided run's success is never review-admission evidence.
  Direct routing requires a passed runner-owned verification cycle in
  the `tool-request-continuation` lane (§10.3 step 1); "successful
  guided verification request" in #722's sense is an eligibility
  trigger, not evidence.
- **R2** — The full E1–E7 evidence set is validated before the
  re-queue; any miss falls back to the implementation continuation.
  All-or-implementation, never partial credit.
- **R3** — Default eligibility is restricted to verification-gap
  requests (§10.2); arbitrary successful commands keep the shipped
  implementation continuation. Operator overrides steer eligibility
  only, never the evidence gate.
- **R4** — A failed continuation cycle routes to implementation with
  the complete §8.2 bundle — the #678 failed-clean posture generalized
  — keeping normal code/test failures inside the implementation/review
  loop.
- **R5** — No new transition vocabulary: the route is
  `{queued, review}` issued by the resolution surface. The shipped
  hardcoded `implementation` requeue destinations are #722's change
  site; `nextPhaseAfter`, `checkReviewAdmission`, and the task status
  set are not.
- **R6** — `docs/guided-tool-request-flow.md` §4 gains the continuation
  rule (and its §5.3 safety-check table the corresponding rows) as part
  of #722 itself; this contract records the requirement and changes
  that document not at all.

## 11. Evidence and observability

### 11.1 Private, local artifacts (operator eyes)

- Per-command logs, one file per command per cycle, under the run's
  artifact directory — the shipped per-lane names preserved:
  `verification-<name>.log` (implementation and
  tool-request-continuation lanes), `review-verification-<name>.log`,
  `conflict-resolution-verification-<name>.log`.
- The cycle bundle: `verification-cycle-<lane>-<ordinal>.json`, the
  serialized §8.2 shape. For backend-routed commands, #917's
  `execution-result.json` remains the per-run record; the bundle
  references runs by `requestDigest`, it duplicates nothing.
- Bounded per-command output tails inside the bundle (§6.1's shipped
  4000-character tail).

### 11.2 Bounded public summaries

Public surfaces (PR summaries, human-gate summaries, ChatOps
acknowledgements) receive **names, classifications, and counts only**:
the command names (operator-authored, safe by construction), the
per-command classification, and the cycle outcome. Never raw command
output, never artifact or worktree paths, never command bytes beyond
the operator-authored name, never a #917 refusal `detail`. The
redaction posture of `docs/environment-prepare-contract.md` §2.7
applies unchanged; the shipped `verificationNames`/`verificationPassed`
summary fields are the compatible ancestors of this surface (§12.5).

### 11.3 Events

One task event per terminal cycle: `verification_cycle_completed`,
carrying the lane, cycle ordinal, cycle outcome, set fingerprint, and
per-command classifications — never output bytes. Infrastructure and
sandbox-policy cycles additionally surface through the lane's existing
failure recording, exactly as an environment-prepare failure surfaces
today; no new phase-runner event vocabulary is introduced.

### 11.4 Agent-facing evidence

Fix-mode and repair prompts receive the §8.2 bundle rendered whole:
every non-passed command with its classification, exit code, and
bounded tail, plus the dirty-worktree evidence — replacing the shipped
first-failure-only rendering (slice V3's recorded change). Prompts
never receive infrastructure, sandbox-policy, or lost entries as
failing checks (§7); where such a cycle stopped a phase, the agent is
simply never invoked.

## 12. Compatibility mapping

### 12.1 `session.verification`

Preserved verbatim: `Record<string, string>`, declaration order is
execution order, prefer-separate-commands guidance stands. The
empty-string skip becomes the uniform rule (recorded as `passed` +
`emptyCommand`): it preserves the shipped behavior of the
implementation and conflict-resolution lanes, and applying it to the
review lane is the §12.2 recorded change. The
`verificationPolicy` block (§5.2) is additive and optional; a session
without it loads exactly as today. No per-command object form, no
enable flag, and no phase-scoping field are introduced.

### 12.2 The three shipped execution sites

The unified engine (slice V1) replaces the shared `runVerification`,
the review lane's inline loop, and the conflict-resolution local
variant with one implementation behind the #917 seam, class
`"verification.run"`, preserving M0 byte-equivalence per #917 §16 at
the spawn level. The shipped divergences are recorded here and fixed as
**recorded changes owned by V1**, never silently: the review lane gains
the capture bound the shared module already has (a verbose passing
command is no longer misreportable) and gains the empty-command skip —
shipped, its inline loop passes a blank entry's empty argv straight to
the runner, whose caught spawn error surfaces as
`Verification '<name>' failed (exit 1)` and routes `needs_fix`; under
V1 the same entry is `passed` + `emptyCommand` (§5.1), a
routing-visible migration — and keeps its log-file naming; the
implementation lane's `dirtyContinuation`
marker is superseded by the §8.2 bundle with its fields preserved as a
compatible subset.

### 12.3 Phase transitions

`nextPhaseAfter` is untouched: same result union, same rows —
implementation `success` → queued review, review `needs_fix` → queued
implementation, review `conflict` → queued conflict_resolution,
conflict_resolution `success` → queued review, the tool-request and
blocked rows, and the review-dispute §7.1 overrides all stand. The §9
table routes exclusively through handler results and re-queue
destinations that exist today; the only new *destination use* is the
resolution surface issuing `{queued, review}` (#722, R5). The
implementation phase's success criteria in `docs/phase-contracts.md`
are amended alongside this contract to name what the code already
enforces: configured verification passes before commit/push.

### 12.4 Review admission and the review lane

`checkReviewAdmission` (#681) keeps exactly its four checks; **no
verification evidence is added to admission**. The review lane
re-executes the session-configured set in its own worktree — evidence
reuse to skip that re-execution is a recorded non-goal this cycle
(§16). The issue-required verification gate (review Step 4.5) keeps its
`blocked` semantics and its two shipped evidence sources (a
`session.verification` match, manual operator evidence), and gains one
addition when the plan slices land: a `passed` `"verification.pinned"`
command from the latest implementation-lane bundle satisfies an
issue-required command **iff** the bundle's `headSha` equals the review
head — bound evidence, never a timestamp.

### 12.5 Tool Request state

Actions (`manual-done` | `reject` | `guided-run` | `grant`),
dispositions (`no-op` | `committed` | `discarded` | `failed`), the
unresolved-request authority rule (#677), the clean-worktree execution
requirement, the changes-produced human handoff, the #678
failed-clean requeue, and the #404 no-op-resume success are all
unchanged. The verification-gap classification (§10.2) is additive
resolution metadata; the verification-first continuation is a new
routing option layered on the existing re-queue seam, defaulting off
until #722 lands.

### 12.6 #915 and #917

The `"per-verification-cycle"` occurrence window is now defined (§2)
and consumed unchanged; reservation, settlement, taint, and
never-launched semantics are #915 §10 / #917 §12 verbatim. Class
routing is #917 §3's: session commands are `"verification.run"`,
plan-approval entries `"verification.pinned"`, and this contract adds
no class, no backend, and no selection input.

## 13. Implementation decomposition proposal

Proposed slices, for the chain's later issues (#919 onward — the
tracker, not this document, assigns numbers; V6 is #722's slice):

| Slice | Content | Depends on | Recorded behavioral change |
| --- | --- | --- | --- |
| V1 | The unified verification engine: set resolution, §6 lifecycle, §7 classification, §8 aggregation, the cycle bundle artifact, per-lane adapters; byte-equivalence pins over the shipped three sites | #917 D1 (the seam) — or lands seam-shaped ahead of it | Review-lane capture bound + empty-command skip (§12.2) |
| V2 | `verificationPolicy` schema + fail-closed load validation + timeout wiring | V1 | The default per-command budget (§5.2) |
| V3 | Full-bundle continuation evidence: fix/repair prompts render the whole §8.2 bundle; dirty evidence merged | V1 | Full-set feedback replaces first-failure-only (§8.2 rule 1) |
| V4 | Infrastructure/sandbox classification wiring: transient relaunch, fail-closed phase stops, the §9 rule 4 pinned-stop route, `verification_cycle_completed`, operator surfaces for infra/policy cycles | V1 | Infra failures stop reaching agents as code evidence |
| V5 | Set-level operator resolution surface over a whole escalated bundle; explicit evidence retention | V3, V4 | — (additive surface) |
| V6 (#722) | Verification-gap classification, the verification-first continuation, E1–E7 validation, the `{queued, review}` resolution route, the `docs/guided-tool-request-flow.md` §4 amendment (R6) | V1–V4 | The direct-to-review route itself (§10) |

## 14. Invariants

1. The lane, classification, and cycle-outcome sets are closed (§2);
   widening any of them is a change to this document first.
2. Known verification never stops for a human: `session.verification`
   is standing operator authorization, #915 plan approval is preflight
   authorization, and both execute unattended at the §4 moments;
   everything else stays a Tool Request (§3).
3. The runner is authoritative for execution and routing; agent
   statements about verification are inert, and only a runner-produced
   §8.2 bundle is evidence — for continuation, admission, and every
   summary (§3 rule 4).
4. No verification cycle launches over a stale or failed environment
   prepare; a prepare failure is never recorded as a verification
   result (§4.2).
5. The resolved set is operator-owned and deterministic: session
   entries in declaration order, then plan entries by `entryId`; no
   agent-authored byte contributes a command, an order, or a policy
   value (§5.1).
6. One cycle yields one complete outcome: code failures do not stop the
   set, substrate failures do, and the aggregate is derived by the §8.1
   precedence — an operator or agent never resolves one command at a
   time (§6.2, §8).
7. Infrastructure and isolation failures never masquerade as code
   failures, never consume repair attempts or review cycles, and never
   reach an agent prompt; code failures are never laundered into
   retries — the only same-cycle relaunch is the bounded
   never-launched case, `"verification.run"` only (§6.2–§7, §9).
8. Code-quality failures return to the implementation/review loop as
   actionable evidence — the full bundle, dirty-worktree state
   included, in one fix input (§8.2, §9).
9. Evidence binds to identities: set fingerprint, head SHA, request
   digests. Unbound, stale, or fingerprint-mismatched evidence
   authorizes no continuation (§8.2 rule 3, §10.3 E5/E7).
10. A successful command is never, by itself, a completed
    implementation or a review admission: direct-to-review requires a
    passed runner-owned cycle plus the full E1–E7 state evidence, and
    every failure of that gate falls back to the shipped
    implementation continuation — subtraction-free (§10).
11. No new phase-runner vocabulary: no `PhaseRunOutcome`,
    `PhaseHandlerResult`, or `TaskStatus` member is added, and
    `nextPhaseAfter` and `checkReviewAdmission` are unchanged; the §9
    and §10 routes use shipped vocabulary only (§9, §12.3–§12.4).
12. Public surfaces carry names, classifications, and counts only;
    output bytes, paths, and refusal details stay in local artifacts
    (§11).
13. This contract adds no backend, class, outcome, refusal reason,
    tier, or plan state, and changes no #697/#915/#916/#917 policy;
    its own vocabulary is the lanes, classifications, cycle outcomes,
    cycle identity, evidence bundle, and continuation rules defined
    here (§12.6).

## 15. Test seams and matrix

For the implementation slices that build against this contract (the
docs pin at the end is the only test landing with #918 itself):

| Area | Cases |
| --- | --- |
| Set resolution (§5) | declaration-order and `entryId`-order determinism; empty-string skip recorded `passed`+`emptyCommand`; plan entries excluded from review/conflict lanes; set fingerprint stable under reordering-free config and changed by any name/class/bytes change; policy validation refuses non-positive budgets and unknown `perCommand` names. |
| Lifecycle (§6) | code-failure continues, refusal stops immediately with `sandbox-policy-stop` not-runs, infrastructure stops after exactly one never-launched relaunch (`verification.run` only; a pinned never-launched settles its reservation and does not relaunch), timeout continues under per-command budgets, `setTimeoutMs` clamps every launch to the remaining set budget (a set-deadline kill classifies `timeout` and records the clamped `effectiveTimeoutMs`; exhaustion records `set-budget-exhausted`), cancellation stops with the recorded outcome. |
| Classification (§7) | the total mapping table, including `ran`+0+taint → `tainted`, refusal reason carried verbatim, `lost` aggregating as infrastructure; no output-based reclassification. |
| Aggregation (§8) | precedence order; empty set → `passed`; bundle completeness (every command present); dirty evidence and failures in one bundle; binding fields present; per-escalation consumption with explicit retention only. |
| Continuation (§9) | every table cell, notably: infra cycle consumes no repair attempt and re-runs under intact caps; review infra → phase failure never `needs_fix`; conflict code-failure aborts the merge; continuation-lane code-failure re-queues implementation with the bundle; a `verification.pinned` refusal or infrastructure stop routes per #917 §11.3's pinned column (`containment-unavailable` falling through the #915 §9 refusal chain), never the generic phase failure, while a pinned `lost` keeps the fail-closed verification failure. |
| Direct-to-review (§10) | eligibility matching via the shipped equivalence semantics; each of E1–E7 individually failing → implementation continuation with the failed check recorded; all-pass → `{queued, review}`; guided-run exit status asserted irrelevant to the gate; a non-eligible successful command asserted never to route to review; a config change between cycle and routing → E7 failure; a backend binding change between cycle and routing (`setFingerprint` unchanged, a command's re-resolved `requestDigest` differing from the bundle's) → E7 failure. |
| Observability (§11) | per-lane log names preserved; bundle artifact shape; public surface carries no output bytes/paths/details; `verification_cycle_completed` payload. |
| Docs pin | `test/docs-verification-execution-contract.test.js` pins this document's status line, chain position, the deferrals to the fixed predecessor contracts, the closed lane/classification/cycle-outcome sets, the standing-authorization and runner-authority rules, the prepare-prerequisite rule, the deterministic set resolution and additive `verificationPolicy` schema, the §6.2 stop rules, set-budget deadline clamp, and single-relaunch discipline, the §7 mapping with both no-masquerade rules, the one-set aggregation and bundle rules, the §9 no-new-vocabulary rule, table, and pinned-stop route, the §10 eligibility/evidence/verdict (R1–R6), the bounded public-summary rule, the compatibility statements (admission unchanged, review re-execution kept, Tool Request state unchanged), the decomposition, and the reconciliation notes in `docs/single-host-execution-backend-contract.md` §20, `docs/preflight-execution-plan-contract.md` §20, `docs/tool-request-grant-tiers-contract.md` §18, `docs/environment-prepare-contract.md` §3, `docs/phase-contracts.md` (implementation success criteria), and `docs/DOMAIN.md` §5 where present — against drift. |

## 16. Non-goals and forward pointers

This document defines runner-owned verification execution and
continuation only. It does not define, and nothing implementing it
should assume:

- **The unified engine, policy schema, continuation wiring, operator
  surfaces, and the direct-to-review route** — the chain's later
  issues (#919 onward, #722), decomposed per §13.
  **Delivered (#919)**: `docs/unattended-tool-request-contract.md` —
  the unattended Tool Request handling and human parking contract: the
  chain's final design issue. It consumes this contract's §9 table and
  §10 evidence gate unchanged (the #722 verdict R1–R6 restated, never
  reopened), wraps them in the total Tool Request decision and
  continuation table, and produces the final dependency-ordered
  implementation decomposition in which this contract's §13 slices —
  #722 (V6) included — are scheduled. The unified engine, policy
  schema, continuation wiring, and operator surfaces themselves remain
  with those tracker-assigned implementation issues.
- **Evidence reuse to skip the review lane's re-execution** — rejected
  this cycle: the review worktree re-runs the session-configured set
  even when an implementation-lane bundle binds to the same head SHA.
  Revisiting this is a change to this document first.
- **Flake detection, rerun-to-green, or quarantine** — no automatic
  retry of code failures exists here (§6.3), and none is planned by
  this contract.
- **External CI integration** — GitHub checks, external runners, and
  status-based admission are out of scope; verification is the
  runner's own execution, on the single host, through #917's seam.
- **Coverage thresholds, result parsing, or per-framework awareness** —
  the contract reads exit codes and bounded output; it never parses
  test-runner formats (the package-manager-free rule of #917 §7,
  applied to test tooling).
- **Any change to `docs/guided-tool-request-flow.md`, the admin CLI
  grammar, the ChatOps verb table, or the session schema beyond §5.2**
  — governed by their own contracts when the surface slices land; the
  guided flow's §4 amendment is #722's (R6).
- **Agent-visible verification APIs** — agents keep receiving evidence
  in prompts (§11.4) and keep having no mechanism to run, modify,
  skip, or reorder configured verification.
