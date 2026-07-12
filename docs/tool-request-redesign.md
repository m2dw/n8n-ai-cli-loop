# Tool Request Redesign — Curated Input and Isolated Execution

Status: design / specification (issue #428)

This document redesigns the **Tool Request** flow as an operator-guided
workflow. It supersedes the operator-experience parts of the original Tool
Request contract in
[docs/tool-request-and-dependency-sync.md](tool-request-and-dependency-sync.md)
(§2 and §2.6 in particular) and is governed by the deployment boundary in
[docs/private-control-plane-security.md](private-control-plane-security.md).

It is a **specification**. It does not rewrite the Tool Request implementation.
It defines the intended architecture, fixes the terminology, draws the state
flow, and splits the work into follow-up implementation issues (§9). Those
follow-ups should cite the sections here rather than restating them.

The existing contract document remains authoritative for the parts this redesign
does **not** change: the agent-side emission rules (when an agent stops and how
it serializes a request, §2.1–2.2), the public/redacted command split (§2.4),
the task-context metadata record (§2.5), and the handler-owned dependency-sync
path (§3). This document changes the **operator experience and execution model**
layered on top of those primitives.

---

## 1. Why the current `grant` is not enough

`grant` (issue #301) was built as a **one-shot exact-command runner**: the
operator approves one specific normalized command, the orchestrator runs it once
on the issue branch, and the result is captured locally. That primitive is
correct and worth keeping — but as the *main* operator experience it is too
low-level, and in practice it feels less effective than `manual-done`:

- **It conflates approval with execution.** A grant is simultaneously "I approve
  this command" and "run it now." There is no approve-then-inspect step, no way
  to see the result and *then* decide whether the produced diff should land.

- **It leaves repo plumbing to the operator.** When a granted command produces
  changes, the flow stops and tells the operator to commit and push on the issue
  branch and *then* run `resolve --action manual-done` (see
  [tool-request-and-dependency-sync.md §2.6](tool-request-and-dependency-sync.md#26-scoped-grants-issue-301)).
  For the common path — "run this, keep the diff, continue" — the operator does
  the git/admin work by hand. That is exactly the manual plumbing this redesign
  wants to remove.

- **It has no first-class notion of a no-op verification command.** A command
  the agent requested purely to *check* something (a build, a test, a lint) exits
  zero and changes nothing. Today that is a clean-no-op grant that re-queues, but
  the *output the operator saw* — the thing the agent actually needed — is not
  routed back into the next prompt as continuation context. So the next run can
  re-derive the same uncertainty and re-emit the same request.

- **It models security as command-shape narrowing rather than environment
  containment.** The grant's safety story is "exact normalized hash, one use,
  short TTL." That constrains *which* string runs but says nothing about *what
  the command can reach* (secrets, host credentials, other issues' state). The
  redesign moves the primary safety boundary to the **execution environment**
  (§5), where it belongs, and lets command approval be about operator intent
  rather than hash-pinning.

`grant`'s mechanics survive as the **guided run** engine (§4.3). What changes is
that the operator no longer drives a bare command runner; they drive a guided
Tool Request flow with explicit, state-aware actions.

---

## 2. Operating assumptions

This redesign is built on the model established in
[private-control-plane-security.md](private-control-plane-security.md):

1. **Human-curated input.** External text reaches an AI control-plane Issue only
   after benevolent human review, summarization, and selection. The control
   plane is private/internal; it does not assume an arbitrary public attacker can
   write orchestration instructions directly. Curated input is **lower risk but
   not fully trusted** — copied text can still carry prompt-injection payloads,
   so structural guards remain (§5).

2. **Low-impact execution.** A command requested by an agent should run in an
   environment that minimizes damage if the command or the prompt that produced
   it is malicious: **no broad secrets, no unnecessary host credentials**, and
   issue/worktree-scoped state so one Issue cannot contaminate another. Stronger
   isolation (restricted host, Docker, VM) is an **executor/config concern**, not
   a workflow concern (§5, §6).

3. **Thin workflow.** n8n passes a `contextId` and invokes runner commands. It
   does **not** embed Docker-specific, host-specific, or worktree-specific logic.
   Execution-environment resolution lives in TypeScript code and session config
   (§6).

4. **Operator-guided, not plumbing-by-hand.** For the common paths the operator
   chooses an action (run, reject, done, commit, discard, retry) and the
   orchestrator performs the git/admin plumbing. The operator's response always
   becomes continuation context for the next implementation prompt (§4.4, §7).

5. **Explicit, configurable security.** Defaults are safer. Where security and
   functionality genuinely conflict in a private deployment, the resolution is an
   explicit operator risk-acceptance opt-in with a visible warning — never a
   silently weakened feature (per private-control-plane-security.md §5–6).

---

## 3. Terminology

These terms are fixed for all follow-up issues.

| Term | Meaning |
|---|---|
| **Tool Request** | A structured handoff emitted by an implementation/fix/conflict agent when it needs a command outside its allowed tool set. Emission rules unchanged (tool-request-and-dependency-sync.md §2.1–2.2). |
| **operator** | The human with access to the private control plane who decides what happens to a Tool Request. |
| **`manual-done`** | Operator response meaning *"I already ran the command myself, outside the orchestrator, and committed/pushed any effects on the issue branch."* The orchestrator runs nothing; it only re-queues. (Unchanged from §2.6.) |
| **`reject`** | Operator response meaning *"do not run this; this is not the right action."* Records the decision and the reason, leaves the task as a human handoff, runs nothing. (Unchanged from §2.6.) |
| **guided run** | Operator response meaning *"run this command for me in the low-impact execution environment, capture the result, and show it to me before anything lands."* This is the redesigned successor to `grant`: it reuses the grant scope/execution engine but separates **execution** from the **disposition** of any produced changes (§4.3). |
| **operator response** | The structured record of whichever action the operator took (`manual-done` / `reject` / `guided run` + disposition), plus any note and the captured execution result. It is the unit that flows into the next prompt (§7). |
| **execution environment** | *Where* a guided run actually executes: host, restricted host, issue worktree, or an isolated runtime (Docker/VM). Resolved by the executor/config layer (§6), never described in workflow JSON. |
| **repo-changing command** | A command whose guided run leaves a dirty worktree or a new commit on the issue branch. Its produced diff needs an explicit disposition: **commit** or **discard** (§4.3, §8). |
| **no-op verification command** | A command that exits zero and changes nothing — the agent ran it to *learn* something (build/test/lint result). There is no diff to dispose of; its **captured output is the deliverable** and must flow into the next prompt as continuation context (§4.3, §7). |

`grant` (the word) is retired from the operator surface in favor of **guided
run**. The grant scope/hash machinery in `src/core/tool-request-grant.ts` is
retained internally as the authorization primitive a guided run is built on.

---

## 4. Architecture

### 4.1 Layers

```text
agent (implementation / fix / conflict)
  └─ emits Tool Request  ──────────────►  [unchanged emission contract §2.1–2.2]

n8n workflow (thin)
  └─ passes contextId, invokes runner commands  ── no env-specific logic

orchestrator / TypeScript handlers
  ├─ detect + classify Tool Request as a human handoff (not failed/needs_fix)
  ├─ store the request + redacted display command (metadata §2.5)
  ├─ present the guided Tool Request flow to the operator (§4.2)
  ├─ on guided run: resolve execution environment (§6), execute, capture result
  ├─ dispose of produced changes per operator choice (commit / discard)
  └─ fold the operator response into the next implementation prompt (§7)

execution-environment layer (executor/config)
  └─ resolves host | restricted-host | worktree | docker/vm  (§6)
```

### 4.2 Operator-facing presentation

When a Tool Request is open, the operator surface (admin CLI / UI) must present,
in one place:

- the **redacted display command** (never the raw command in any public surface;
  §2.4);
- the agent's **reason** and any **risk notes**;
- the request **necessity** (`required` / `optional`);
- the current **state** (§8) — including whether a guided run has already
  executed and what it produced;
- after a guided run: the **captured result** (bounded stdout/stderr, exit code)
  and the **repo diff state** (clean no-op, dirty worktree, or new commit).

The available actions are **state-dependent** (§8): e.g. `commit` / `discard`
are offered only after a guided run produced changes; `retry` is offered after a
failed run.

### 4.3 Guided run: execution separated from disposition

A guided run has two distinct phases the old grant fused together:

1. **Execute.** The orchestrator resolves the execution environment (§6), checks
   out / creates the issue branch (never the base branch — branch discipline from
   §2.6 carries over unchanged), runs the approved command inside the low-impact
   environment, and captures `stdout`/`stderr`/exit code to a **local** artifact
   and a task event. Public surfaces still see only the redacted command and a
   high-level outcome.

2. **Dispose.** Based on what the run produced and on the operator's choice:
   - **no-op verification command** (zero exit, no diff): there is nothing to
     commit. The captured output becomes continuation context (§7) and the task
     re-queues so the next implementation pass *has the answer the agent was
     missing*. This is the key fix for verification loops.
   - **repo-changing command** (dirty tree or new commit), operator chooses
     **commit**: the orchestrator commits and pushes on the issue branch and
     re-queues. The operator does **not** do this git plumbing by hand — this is
     the central improvement over `grant`.
   - **repo-changing command**, operator chooses **discard**: the produced
     changes are reverted on the issue branch; the request is left a human
     handoff (or re-runnable) per operator intent. The partial-diff snapshot
     safeguard (§2.7) still applies so nothing is lost irrecoverably.
   - **non-zero exit**: no auto-commit; the task stays a human handoff and the
     captured failure output is available. The operator may `retry` (with a
     corrected command, which re-authorizes), `reject`, or fall back to
     `manual-done`. A failing command never silently loops.

The authorization remains tightly scoped (session + issue + phase + repo root +
exact normalized command), one-shot, and short-lived, exactly as today — but the
operator now drives disposition explicitly instead of being handed raw git steps.

### 4.4 Continuation context is mandatory, not incidental

Every terminal operator response — `manual-done`, `reject`, a committed guided
run, a discarded guided run, or a captured no-op verification result — produces
an **operator response record** that the next implementation prompt receives as
continuation context (§7). A Tool Request must never resolve in a way that
re-queues the agent with *no memory* of what the operator decided or what a
verification command revealed; that omission is the root cause of the current
re-request loops.

---

## 5. Security model (explicit, not public-hostile)

The control plane is private and its input is human-curated (§2.1), so the
security model does **not** assume an arbitrary public attacker writing
orchestration instructions. It does still treat Issue/comment/agent text as
**untrusted content** (private-control-plane-security.md §4): structural guards,
not content trust, remain the primary defense.

The redesign moves the **primary safety boundary from command-string narrowing to
execution-environment containment**:

- **Strip secrets and broad credentials by default.** A guided run executes with
  the minimum environment it needs. Broad host secrets and unnecessary
  credentials are removed by default; granting any back is an explicit, named,
  per-session opt-in with a runtime warning (private-control-plane-security.md
  §6).
- **Issue/worktree scoping prevents cross-contamination.** A guided run for issue
  *N* operates in issue *N*'s worktree (per-issue-worktrees.md) so it cannot
  mutate another issue's checkout or leak its state.
- **Untrusted text never selects or composes the command.** As in the existing
  contract (§4 of tool-request-and-dependency-sync.md), the only command a guided
  run executes is the operator-approved one; agent output and Issue text are data,
  never the executable.
- **Stronger isolation is opt-in, not assumed.** Restricted-host / Docker / VM
  execution is available for operators who want a larger blast-radius reduction,
  selected by config (§6) — its absence is not a security failure of the default
  private deployment, and its presence must not leak into workflow JSON.

Where a private deployment needs functionality the safe default blocks (e.g. a
guided run that genuinely needs a credential), the resolution is the documented
operator risk-acceptance pattern (private-control-plane-security.md §6): safer
default, explicit opt-in, visible runtime warning — never a silently widened
default.

---

## 6. Execution environment belongs in JS/config, not workflow JSON

> **Normative.** Workflow JSON stays thin. n8n passes a `contextId` and invokes
> runner commands. It must **not** contain Docker image names, host paths,
> worktree roots, mount specs, credential plumbing, or any branch on "where does
> this run." Environment-specific execution is resolved entirely in TypeScript
> code and session configuration.

The execution-environment layer takes a guided-run request plus session config
and resolves *where* the command runs:

| Environment | Selected when | Resolved by |
|---|---|---|
| host | default for simple/trusted private deployments | config default |
| restricted host | secrets/credentials stripped, reduced filesystem reach | session config |
| issue worktree | per-issue isolation (per-issue-worktrees.md) | `worktreeId` on the task |
| Docker / VM | strongest isolation, opt-in | session config |

The runner command invoked by n8n is the same regardless of which row applies;
the workflow neither knows nor encodes the choice. This mirrors the
already-established split (phase-contracts.md): n8n owns orchestration,
TypeScript owns repository/execution operations. Concretely, the session-config
shape for execution environment, and the resolver that consumes it, are a
follow-up (§9) and must keep this boundary — adding an environment must never
require editing generated workflow JSON.

---

## 7. Operator response → next prompt

The operator response record (§3) is appended to the next implementation prompt
as **continuation context**, structured so the agent can act on it without
re-deriving the blocker:

- **what was requested** (the command, in the local/private context where the
  exact form is allowed);
- **what the operator decided** (`manual-done` / `reject` / guided-run +
  commit / guided-run + discard);
- **the captured result** for any executed command — crucially including the
  **no-op verification output**, so a verification-only request feeds the agent
  the answer it was missing instead of looping;
- **any operator note** (e.g. the reason for a `reject`, or guidance to take a
  different approach).

This is the load-bearing change for the "verification commands loop" problem:
the operator response is **treated as continuation context by contract**, not as
an incidental side effect.

---

## 8. State flow

```text
                         ┌─────────────┐
                         │  requested  │  (agent emitted Tool Request;
                         └──────┬──────┘   stored + redacted; human handoff)
              ┌─────────────────┼───────────────────┐
              ▼                 ▼                     ▼
        ┌──────────┐     ┌─────────────┐       ┌───────────┐
        │  reject  │     │ manual-done │       │ guided run│
        └────┬─────┘     └──────┬──────┘       └─────┬─────┘
             │                  │          ┌─────────┼─────────────┐
             │                  │          ▼         ▼             ▼
             │                  │     ┌─────────┐ ┌─────────┐ ┌──────────┐
             │                  │     │ success │ │ success │ │   fail   │
             │                  │     │  no-op  │ │  repo-  │ │ (non-zero│
             │                  │     │ (verify)│ │ changes │ │   exit)  │
             │                  │     └────┬────┘ └────┬────┘ └────┬─────┘
             │                  │          │      commit│discard   │retry/
             │                  │          │           │ │        │reject/
             │                  │          │           │ │        │manual-done
             ▼                  ▼          ▼           ▼ ▼         ▼
   ┌───────────────┐   ┌──────────────┐  (all resolved paths emit an operator
   │ human handoff │   │   re-queued  │   response record → next prompt §7)
   │ (no re-queue) │   │ w/ continu-  │
   └───────────────┘   │ ation ctx    │
                       └──────────────┘
```

The required transitions, spelled out:

- **requested** — agent emitted the request; orchestrator classified it as a
  **human handoff** (not `failed`, not `needs_fix`; §2.3) and stored it with the
  redacted display command.
- **operator runs / approves** — the operator triggers a guided run; the
  orchestrator resolves the execution environment (§6) and executes on the issue
  branch.
- **command succeeds, no repo changes** (no-op verification command) — captured
  output becomes continuation context; task **re-queues** with that context so
  the next pass has the answer.
- **command succeeds, repo changes** (repo-changing command) — operator chooses
  **commit** (orchestrator commits/pushes on the issue branch, re-queues) or
  **discard** (changes reverted, partial-diff safeguard §2.7 applies, stays a
  handoff or re-runnable).
- **command fails** (non-zero exit) — no auto-commit; stays a human handoff with
  the captured failure available; operator may `retry` / `reject` /
  `manual-done`. Never loops silently.
- **operator rejects** — decision + reason recorded; stays a human handoff; runs
  nothing; the rejection is continuation context if the task is later re-queued.
- **missing branch / continuation point** — if there is no usable continuation
  point (no resume branch landed-and-pushed, no PR head to resume; §2.7), the
  flow **fails closed** rather than re-queueing into a dead loop, and points the
  operator at the preserved `partial-implementation.patch` and the recovery
  steps. The branch discipline from §2.6 (issue branch only, never base) holds
  across every executing path.
- **next implementation prompt receives the operator response** — every resolved
  path emits an operator response record folded into the next prompt (§7).

---

## 9. Follow-up implementation issues

This issue is design only. The agreed pieces split into the following
follow-ups; each should cite the relevant section above rather than restating it.

1. **Guided-run engine: separate execution from disposition.** Refactor the
   `grant` execution path (`runToolRequestGrant`, `src/core/tool-request-grant.ts`)
   into a **guided run** that executes, captures, and then takes an explicit
   `commit` / `discard` disposition for repo-changing commands, with the
   orchestrator performing the commit/push plumbing on the issue branch. Retire
   `grant` from the operator surface in favor of `guided run`; keep the scope/hash
   authorization primitive. (§4.3, §1)

2. **No-op verification continuation context.** Capture the output of a no-op
   verification command and route it into the next implementation prompt; ensure
   a verification-only request re-queues *with the answer* instead of re-emitting.
   (§4.3, §7)

3. **Operator response record + prompt continuation.** Define the operator
   response record (covering `manual-done`, `reject`, guided-run dispositions, and
   captured results) and the prompt section that injects it as continuation
   context, by contract, for every resolved path. (§4.4, §7)

4. **Execution-environment resolver (config + JS).** Add the session-config shape
   and TypeScript resolver for host / restricted-host / worktree / Docker-VM
   selection, keeping all environment specifics out of workflow JSON. Land the
   default-strip-secrets behavior and the restricted-host environment first;
   Docker/VM as a later opt-in. (§5, §6)

5. **State-aware operator presentation.** Update the admin CLI / UI surface to
   present command, risk notes, result, and repo diff state together and to offer
   only the state-valid actions (run / reject / done / commit / discard / retry).
   (§4.2, §8)

6. **Operator risk-acceptance opt-ins for execution.** Implement the explicit,
   warned opt-ins for restoring stripped credentials / secrets to a guided run in
   a private deployment, following the operator risk-acceptance pattern. (§5)

Items 1–3 are the core of the redesigned operator experience and unblock the
verification-loop and manual-plumbing problems; 4 and 6 are the execution-
environment and security tracks; 5 is the operator surface that ties them
together.

---

## 9a. Implementation status (issue #430)

Issue #430 implements the core operator-experience track — §9 items 1–3, which
unblock the verification-loop and manual-plumbing problems:

- **Guided run (item 1, §4.3).** The operator surface is now `tool-request run`
  (the *guided run*). `tool-request grant` is retained as a deprecated alias that
  tags its operator-response record `grant` so historical records still replay as
  "the command was run". The grant scope/hash authorization primitive
  (`src/core/tool-request-grant.ts`) is unchanged. A guided run separates
  execution from disposition via `--disposition commit|discard|keep`:
  - `commit` — the orchestrator commits and pushes the produced changes on the
    issue branch (never the base branch; §2.6/#316) and re-queues. This removes
    the by-hand git plumbing the old `grant` left to the operator.
  - `discard` — the produced changes are reverted (`git reset --hard` +
    `git clean -fd`) after a best-effort snapshot to `discarded-changes.patch`
    (partial-diff safeguard §2.7); the request stays a human handoff.
  - `keep` (default) — the pre-redesign behavior, preserved for compatibility.

  The contaminated-base and off-issue-branch guards still fail closed before any
  disposition runs, so commit/discard never operate on base contamination.

- **No-op verification continuation context (item 2, §4.3/§7).** A no-op
  verification command captures its stdout/stderr/exit code onto the operator
  response (`ToolRequestResolution.capturedResult`, `disposition: "no-op"`) and
  re-queues with that output. The captured output is the deliverable.

- **Operator response record + prompt continuation (item 3, §4.4/§7).** The
  operator response record now carries `disposition` and `capturedResult`, and
  `toolRequestResolutionPromptSection` folds both — including the no-op
  verification output and the disposition — into the next implementation prompt
  for every requeued path.

The thin-workflow boundary (§6) is respected: this work is entirely TypeScript
and CLI; no workflow JSON changed. The execution-environment resolver (item 4),
state-aware operator presentation (item 5), and risk-acceptance opt-ins (item 6)
remain the follow-ups listed in §9.

---

## 10. Scope / non-goals

- This document does **not** rewrite the Tool Request implementation; it specifies
  the redesign and splits the work (§9).
- It does **not** change the agent-side emission contract, the redacted/exact
  command split, the metadata record, or the dependency-sync path — those remain
  governed by [tool-request-and-dependency-sync.md](tool-request-and-dependency-sync.md).
- It does **not** add Docker/VM execution itself; it places that work in the
  executor/config layer and lists it as an opt-in follow-up (§9.4).
- It does **not** design a public/hostile control plane; that remains explicitly
  out of scope (private-control-plane-security.md §5.5).
