# Unattended Tool Request handling and human parking contract

Status: **approved design, not yet implemented** (issue #919). This
document is the authoritative contract for how the long-running loop
handles Tool Requests without a watching human: which requests
auto-execute, which notify and proceed, which park for a human and how
exactly one Issue parks, how operator dispositions re-enter the loop with
complete context, how repeated requests and no-op continuation loops are
handled deterministically, and how the whole design decomposes into
implementation issues. Follow-up implementation issues reference this
specification and MUST NOT redefine its policy; a change of policy is a
change to this document first.

This is issue #919, the successor of the runner-owned verification
execution and continuation contract (#918) in the executable chain
`#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917
→ #918 → #919 → #722` (see the issue body for the authoritative GitHub
Issue Relationships). It is the chain's final design issue: it integrates
the trust (#697), preflight (#915), platform (#916), backend (#917), and
verification (#918) contracts into one decision and continuation model,
and it produces the dependency-ordered implementation decomposition those
contracts deferred (§12). It adds no runtime behavior, and it deliberately
defines almost no new machinery: nearly every cell of its decision table
names a rule one of the predecessor contracts or the shipped tree already
fixed. What is new here is the *composition* — the total decision order,
the request lifecycle, the repeat rules, the parking contract, and the
decomposition.

It does **not** specify, and no implementation built against it may
assume:

- **The typed-operation registry, the three tiers, tier resolution, the
  enforcing execution boundary, effect verification, patch-level
  adoption, and the tier audit record** — fixed by
  `docs/tool-request-grant-tiers-contract.md` (#697). This document adds
  no tier and no `TierRefusalReason` member.
- **The preflight Execution Plan schema, approval, invalidation,
  authorization resolution, and occurrence reservation** — fixed by
  `docs/preflight-execution-plan-contract.md` (#915). This document adds
  no `PreflightRefusalReason` member and no plan state.
- **The platform targets, the two-sandbox-domain rule, and behavioral
  capability attestation** — fixed by
  `docs/single-host-platform-sandbox-contract.md` (#916).
- **The ExecutionBackend interface, backend selection, and the
  outcome/refusal taxonomies** — fixed by
  `docs/single-host-execution-backend-contract.md` (#917). This document
  adds no backend, class, outcome, or refusal reason.
- **Verification execution, classification, aggregation, the
  continuation table, and the direct-to-review evidence gate** — fixed by
  `docs/verification-execution-contract.md` (#918), including the #722
  verdict (R1–R6). This document consumes §9–§10 of that contract and
  changes nothing in them.
- **The Tool Request emission contract, the exact/redacted command
  split, the metadata record, scoped grants, the continuation-point
  machinery, and dependency sync** — fixed by
  `docs/tool-request-and-dependency-sync.md`.
- **The guided operator flow** — fixed by
  `docs/guided-tool-request-flow.md`; the human gate *is* that flow. Its
  §4 continuation amendment belongs to #722 (#918 §10.5 R6), not to this
  document.
- **The `ready_for_human` merge-gate dispositions** — fixed by
  `docs/human-gate-no-go-flow.md`. That gate, the planning gate, and the
  Tool Request permission gate are three independent gates (§8.2); this
  document governs only the third.

## 1. Why this contract — the gap it closes

Tool Request is the loop's escalation mechanism, and it works: nothing
executes without an authority, and a human can always dispose of a
request. What it does badly today is *unattended operation*:

- **It stops too many predictable operations.** Every command outside the
  agent's allowed tool set stops the loop once per occurrence — including
  operations that were knowable from the Issue, repository, chain, and
  session before the agent ever ran. #697 and #915 designed the fix
  (typed operations, session allowlists, preflight plans); no contract
  yet said how the pieces compose at the single gate decision point.
- **It returns to implementation without enough evidence.** Every
  resolution re-queues `implementation` unconditionally; a task whose
  work is already pushed pays a no-op agent invocation (#404 made it
  survivable, #722 wants it gone, #918 §10 gated it on evidence). And a
  resolution that answers the agent's question badly produces the same
  request again — the re-request loop `docs/tool-request-redesign.md` §1
  names as the operator-experience failure.
- **Parking is under-specified.** The shipped tree parks a task
  `ready_for_human` and stops; nothing records what a parked Issue means
  for the serial chain behind it, what the operator surfaces must be able
  to answer, which repeats are suppressed, or when a parked Issue is
  allowed to stay parked forever.

This contract fixes all of it as design: one authority order (§3), one
derived request lifecycle (§4), one total decision and continuation table
(§5), one operator-response contract (§6), deterministic repeat handling
(§7), a parking contract that stops one Issue without a scheduler and
explains itself (§8), safe handling of preserved work products (§9), a
failure/recovery/audit contract (§10), reconciliation with everything
shipped (§11), and the final implementation decomposition (§12).

## 2. Terminology

- **Gate decision point** — the moment a phase handler has an emitted
  Tool Request (or the runner reaches a planned step) and must decide who
  authorizes it (#697 §2, #915 §9). One request meets the gate decision
  point exactly once per emission.
- **Authority** — one of the four sources consulted at the gate decision
  point, in fixed order (§3): the preflight plan (#915), the session
  allowlist tiers (#697), the legacy pre-#697 disposition flow (the
  shipped dependency-update route, during migration), and the guided
  human gate.
- **Auto-execution** — execution of a pinned substitution under a
  relaxed tier (#697 §7) authorized by a plan entry or an allowlist
  entry, with no waiting human. Never agent command text (#697
  invariant 2).
- **Park** — the human handoff: the task moves to `ready_for_human` via
  the distinct `tool_request` handler result — never `blocked`, never
  `failed` (`docs/tool-request-and-dependency-sync.md` §2.3) — and the
  request stays unresolved until an operator disposes it.
- **Request lifecycle state** — the derived, closed set
  `"pending" | "auto-resolved" | "parked" | "operator-resolved" |
  "continued"` (§4). Derived vocabulary only: the stored record keeps
  exactly the shipped fields (`resolved`, `resolution`), and **no
  `toolRequest.status` column is introduced**.
- **Operator-response context** — the continuation prompt section built
  from the resolved request: the prior command, the operator's action and
  disposition, the note, and the captured bounded result
  (`toolRequestResolutionPromptSection`, §6).
- **Typed request identity** — `(operationId, params digest)`: the
  identity repeat protection uses for typed operations (#697 §6 rule 6,
  #915 §10's occurrence key).
- **Free-form request identity** — the shipped normalized command bytes
  (`normalizeToolRequestCommand`: leading/trailing trim only) joined to
  the task attempt: the identity repeat handling uses for requests that
  resolve to no typed operation (§7).
- **Prior outcome** — for a repeat decision: the earlier same-identity
  request's `resolution.action` and `resolution.disposition`, plus — for
  typed identities — the recorded tier/plan execution (#697 §11, #915
  §10).
- **No-progress repeat** — a re-emitted request whose identity a
  delivered operator-response context already answered, from a
  continuation run that added no commits and no file changes (§7).
- **Continuation destination** — where a resolution sends the task. The
  set is closed and uses shipped vocabulary only:
  `{queued, implementation}` | `{queued, review}` (#918 §10 / #722, the
  only direct-to-review route) | remain `ready_for_human`. No new
  `TaskStatus`, `PhaseRunOutcome`, or `PhaseHandlerResult` member exists.

## 3. The authority order — who executes without a waiting human

### 3.1 Standing authorization never becomes a Tool Request

Configured `environmentPrepare`, `verification`, and `dependencySync`
runs are standing operator authorization and execute unattended at their
own contracts' moments (#918 §3; `docs/environment-prepare-contract.md`).
**Routine approved verification does not require a Tool Request stop** —
that is #918's acceptance boundary, restated here as this contract's
precondition: by the time a Tool Request exists, the operation was
*not* covered by standing or preflight authorization, and the decision
below is about the remainder. Agents are told not to emit requests for
commands they can already run, and a verification-gap request (a request
matching a configured `session.verification` value) is routing metadata
for #918 §10, never a new authorization.

### 3.2 The four authorities, in fixed consult order

At the gate decision point the handler consults, in order, stopping at
the first authority that serves the request (#915 §9's precedence,
adopted whole):

1. **The preflight plan** (#915 §9) — the most specific authority: this
   operator approved these typed operation contracts for this issue or
   chain segment. Verdicts execute via #697 §7 under an attested isolated
   backend (#917 §13 rule 4).
2. **The session allowlist tiers** (#697 §6) — standing, session-wide,
   typed. Same execution machinery.
3. **The legacy pre-#697 disposition flow** — the shipped §3.5
   dependency-update route, reachable only through the reason-scoped
   migration exceptions (#697 §6, #915 §9) until #697 §14's subsumption
   bar is met.
4. **The guided human gate** — everything else parks
   (`docs/guided-tool-request-flow.md`).

Two refusals bypass the fallthrough by design and park directly:
`"occurrence-exhausted"` (#915 §9's carve-out) and `"already-executed"`
(#697 §6 rule 6) — repeat protection outranks fallthrough, so a consumed
operation converges on a human instead of a second execution.

### 3.3 Free-form approval is never durable

The only durable relaxations in the system are typed and
operator-authored: the #697 session allowlist (standing) and the #915
plan approval (issue-/chain-scoped, fingerprint-bound). Every human
disposition of a free-form request is per-occurrence:

- A **grant** remains the retained internal authorization primitive of
  `docs/tool-request-and-dependency-sync.md` §2.6, scoped to session +
  issue/task + phase + repo root + normalized exact-command hash, with
  `maxUses` defaulting to 1 and a short TTL; `grantStatus` reports
  `exhausted`/`expired`. The operator surface for it is the guided run
  (`admin tool-request run`; `admin tool-request grant` is the
  deprecated alias, `docs/tool-request-redesign.md` §3).
- `manual-done`, `reject`, and a guided run each resolve exactly one
  request.
- **No surface converts an approved free-form command into a standing
  allowlist entry, a plan entry, or any wildcard, and this contract adds
  none.** An operator who wants an operation to stop parking declares it
  ahead of time — a registry entry plus an allowlist or plan entry —
  which is exactly the "predictable operations should be declared and
  approved before they are needed" policy, made mechanical.

### 3.4 What stays human-gated by construction

Unchanged from #697 §3 and restated as this contract's human-gate floor:
**every free-form shell request** (no typed resolution), **dependency
additions** that resolve to no typed entry, **credentials**, **spend**,
**network access beyond a typed operation's declared policy**, **any
canonical-repository mutation**, and **unresolved policy** (an operation
the registry, allowlist, and plan are all silent about). None of these is
representable in a relaxed tier or a plan entry, so none can be
auto-executed — a structural guarantee, not a classifier's opinion.

## 4. The request lifecycle (derived)

The stored record keeps exactly the shipped shape: `resolved` is the only
lifecycle bit; `resolution` carries the action, disposition, message, and
captured result. The states below are **derived** from that record plus
the task status, so no store migration and no new status column exists:

| State | Derived from | Meaning |
| --- | --- | --- |
| `pending` | Request exists in the emitting phase run; gate decision not yet recorded | The §5 rows 1–17 decision is in flight, inside the same phase run |
| `auto-resolved` | `resolved: true` with an unattended resolution record (§6.4), task never parked for it | An authority executed without a waiting human (rows 3–4, 7–8, 13) |
| `parked` | `resolved !== true`, task `ready_for_human` via the `tool_request` handler result | A human owns the next decision (rows 5, 9–12, 14–15) |
| `operator-resolved` | `resolved: true` with action `manual-done`/`reject`/`guided-run`/`grant` | A human disposed it (rows 18–25; rows 19 and 23 leave the request unresolved and the state `parked`) |
| `continued` | A continuation destination was issued consuming the resolution (§5 rows 26–27) | The operator-response context is delivered in the next agent prompt, or the task routed to review |

Transitions are exactly the §5 table's rows; there is no other edge. In
particular `parked → parked` re-entry does not exist: a parked request
stays one park (row 17 suppresses duplicates; row 19 keeps a refused
`manual-done`, and row 23 a kept guided run, in the same park), and a
*new* park after a continuation is
always a new request record (row 28).

## 5. The decision and continuation table (normative)

The total table. Every row routes through vocabulary that ships today or
that a predecessor contract already defined; rows cite their authority.
Rows are single-line by design so the docs pin can parse them; the row
count is part of the contract. The deprecated `grant` alias (§3.3) has
no rows of its own: a `grant`-surfaced resolution is a guided run and
takes rows 21–25 verbatim, on the same scope/execution engine, differing
only in the recorded `resolution.action` — `grant` instead of
`guided-run`, so historical records still replay as "the command was
run" (`docs/tool-request-redesign.md` §3).

| # | Input | Authority | Condition / verdict | Route and record |
| --- | --- | --- | --- | --- |
| 1 | Planned step the runner reaches itself | #915 §9 rule 4 | Matched `"session-default"` entry | Observational passthrough: the shipped mechanism executes under its own operator-owned class (#917 §3); resolution recorded for provenance; no Tool Request exists |
| 2 | Planned step the runner reaches itself | #915 §9–§10 | Matched `"plan-approval"` entry, authorized; occurrence reserved pre-launch | Auto-execute through #697 §7 under the attested isolated backend, inside the owning #918 cycle (the lane's `"verification.pinned"` command, #918 §5.1); the task never stops for the launch; reservation settled with the run; every outcome is #918's — classified §7, aggregated §8, routed §9, so a nonzero exit or timeout is `code-failure`/`timeout` continuing the set into the repair loop — and rows 10–12 never apply: no Tool Request exists to park |
| 3 | Emitted request with a typed resolution (#697 §6 rule 2 nomination) | #915 §9, consulted first | `via: "plan-approval"`, tier `"auto-grant"` | Auto-execute on row 2's launch machinery (#697 §7, attested isolated backend), but as a request-resolving execution: failures take rows 10–12, never #918 §9; the request record resolves `"auto-executed"` (§6.4); continuation per rows 26–27 |
| 4 | Emitted request with a typed resolution | #915 §9, consulted first | `via: "plan-approval"`, tier `"notify-and-proceed"` | As row 3, plus the #697 §10 notification enqueued in the adoption transaction; `postHocReview: "pending"` |
| 5 | Emitted request with a typed resolution | #915 §9 rule 9 | Refusal `"occurrence-exhausted"` | Direct human park (§8) carrying the prior occurrence's recorded outcome — or, when the window is spent by an unsettled reservation (a crash before any outcome was recorded, #915 §10's ambiguous-reservation rule), the dangling reservation state itself, so the §8.4 explanation exists either way; `resolveGrantTier` and the legacy route are never consulted (#915 §9's carve-out) |
| 6 | Emitted request with a typed resolution | #915 §9 | Any other preflight refusal (the seven fall-through reasons) | Fall through to #697 tier resolution with unchanged inputs — a preflight refusal subtracts nothing (rows 7–13) |
| 7 | Request with a typed resolution | #697 §6 | Relaxed verdict, tier `"auto-grant"` | Auto-execute via the session allowlist: #697 §7 verbatim; request resolves `"auto-executed"`; continuation rows 26–27 |
| 8 | Request with a typed resolution | #697 §6 | Relaxed verdict, tier `"notify-and-proceed"` | As row 7 plus the notification and `postHocReview: "pending"` |
| 9 | Request with a typed resolution | #697 §6 rule 6 | `"already-executed"` | Direct human park carrying the recorded prior tier execution; never the legacy dependency route (repeat protection outranks the migration exception) |
| 10 | Request-resolving relaxed-tier execution (launched by rows 3–4 or 7–8) | #697 §7 step 5 | Nonzero exit or timeout | Nothing verified or adopted: human park with the captured bounded result attached as continuation context and the produced diff left in place for the guided dispositions; a failed relaxed run never retries itself |
| 11 | Request-resolving relaxed-tier execution (launched by rows 3–4 or 7–8) | #697 §8 | Observed effects exceed the enumeration, or an overlap cannot be isolated | Adopt nothing: human park with the excess or entangled path list recorded (`tool_request_effects_exceeded` / `tool_request_effects_entangled`); diff preserved in the worktree |
| 12 | Request-resolving relaxed-tier execution (launched by rows 3–4 or 7–8) | #917 §11.3; §8.3 and §11.1 for `cancelled` | Backend `refused`/`infrastructure` outcome — surfaced as `"containment-unavailable"` (#697 §6 rule 4) through `"backend-unavailable"` / `"capability-unattested"` / `"policy-unenforceable"` — `cancelled` (an explicit operator cancellation honored at the backend layer, #917 §8.3 — the #608 cooperative-stop posture), or `lost` (assigned only by reconciliation, #917 §8.5) | Adopt nothing: human park carrying the recorded outcome — the refusal reason (a refusal is pre-launch: nothing user-visible executed), the `cancelled` run record (an operator stopped the run mid-flight: never a resolution — `"auto-executed"` requires a `ran` outcome, §6.4 — with the partial captured result attached and any produced diff preserved for the guided dispositions like rows 10–11; the occurrence reservation settles with the recorded `cancelled` outcome and stays consumed, #917 §12 rule 5, never an automatic relaunch), or the `lost` run record (fate unknown: never relaunched, the occurrence reservation / at-most-once identity stays consumed, §10.1) — per #917 §11.3's `tool-request.pinned` columns, with the `cancelled` mapping supplied by this row (#917 §11.1 closes the outcome set; its §11.3 columns omit `cancelled`); never a retry on another backend, never a silent isolation downgrade (#917 §13 rule 3) |
| 13 | Request under a #697 human-gate verdict within the five reason-scoped refusals | The legacy pre-#697 flow (#697 §6 migration exception) | The shipped §3.5 dependency-update route recognizes the request | The legacy route executes exactly as shipped (parse-as-data, manifest edit, pinned sync); its shipped continuation and handoff semantics apply; row 14 on decline |
| 14 | Request the legacy route declines | Shipped §3.5 fallback conditions | No explicit version, unsupported ecosystem, already satisfied ("unchanged"), safe-mode refusal, or sync failure | Human park with the route's specific context attached — the shipped handoffs, unchanged, including the distinct "unchanged" handoff that addresses the re-request loop |
| 15 | Free-form request resolving to no typed operation | This contract §3.4 | Always | Human park via the `tool_request` handler result: `ready_for_human`, never `blocked`, never `failed` |
| 16 | Agent output containing a malformed block | Shipped emission contract | No `command` line parses | Not a Tool Request: the block is inert output; field bounds truncate, never reject |
| 17 | Emitted request whose free-form identity equals a still-unresolved prior request | §7 | `"unresolved-duplicate"` | The existing park stands: no second handoff, no second public comment; the repeat kind is recorded on the handoff context |
| 18 | Parked request | Operator: `manual-done` | A usable continuation point exists (the shipped §2.7 guard: resume branch landed and pushed, or the PR head in fix mode; local base not ahead of origin) | Resolve `manual-done`; re-queue `{queued, implementation}` with the §6 operator-response context |
| 19 | Parked request | Operator: `manual-done` | No usable continuation point, or the local base is ahead of origin | Refused fail-closed: the request stays unresolved and the park stands — never a resolution into a dead loop |
| 20 | Parked request | Operator: `reject` (message required) | Always | Resolve `reject`; re-queue `{queued, implementation}` with the rejection as feedback; identity and outcome recorded for §7 |
| 21 | Parked request | Operator: guided run (`grant` alias included) | Exit 0, no repository changes | Resolve action `guided-run` with `resolution.disposition: "no-op"` and the captured result — the output is the deliverable; continuation rows 26–27 |
| 22 | Parked request | Operator: guided run (`grant` alias included) | Repository changes, disposition `commit` (expected-files check; `--allow-unexpected` for excess) | The orchestrator commits and pushes on the issue branch — never the base; resolve action `guided-run` with `resolution.disposition: "committed"`; continuation rows 26–27 |
| 23 | Parked request | Operator: guided run (`grant` alias included) | Repository changes, disposition `keep` (the default) | The shipped keep handoff stands: the produced changes stay in place on the issue branch, the request stays unresolved, and the park holds — no automatic re-queue; the operator commits and pushes on the issue branch (never the base), then resolves `manual-done` (rows 18–19, guard included) to re-queue from a clean tree |
| 24 | Parked request | Operator: guided run (`grant` alias included) | Repository changes, disposition `discard` (`--confirm-discard`; snapshot to `discarded-changes.patch` first) | Reset and clean; resolve action `guided-run` with `resolution.disposition: "discarded"`; re-queue `{queued, implementation}` with take-a-different-approach context |
| 25 | Parked request | Operator: guided run (`grant` alias included) | Nonzero exit | Clean tree and no base mutation: resolve action `guided-run` with `resolution.disposition: "failed"` and the captured result, and re-queue `{queued, implementation}` (the #678 failed-clean posture); dirty tree or base mutation: the request stays a human handoff, fail-closed |
| 26 | Resolution leaving the task re-queueable | #918 §10 (#722, once landed) | Verification-gap eligible; the continuation-lane cycle passed; E1–E7 all hold | Re-queue `{queued, review}` — the only direct-to-review route; any miss falls to row 27 with the failed check named |
| 27 | Resolution leaving the task re-queueable | This contract | Row 26 not taken | Re-queue `{queued, implementation}` with the §6 context — the shipped default; a resumed run with issue commits and no new changes remains a success (#404) until #722 removes the detour for eligible cases |
| 28 | Re-queued continuation run | §7 | The run adds no commits and no file changes and re-emits the identity its delivered context already answered | No-progress repeat: direct human park carrying both the prior request and the operator response; no further automatic continuation for that identity within the task attempt |
| 29 | Re-queued continuation run | Shipped phase runner | Any other result | Ordinary phase-result routing; `nextPhaseAfter` unchanged |
| 30 | Any live request | Cross-gate rule (§8.2) | A Human Gate operation or generic recovery is attempted while the request is unresolved | Refused `tool_request_unresolved`: a live Tool Request closes only through its own resolution surfaces |

Rules the table depends on:

1. **Consult order is fixed and complete.** Preflight, then tiers, then
   the legacy route, then the gate — rows 3–15 in that order; no other
   path from an emitted request to an execution exists.
2. **Auto-execution is always the pinned substitution.** Rows 2–4 and
   7–8 execute registry-pinned bytes under the enforcing boundary; agent
   command text is never executed on any unattended row (#697
   invariant 2), and the executed operation runs under an attested
   isolated backend, never `local` (#917 §13 rule 4).
3. **Every unattended request failure degrades into the shipped human
   flow; planned verification outcomes never enter it.** Rows 10–12
   govern only executions that resolve an emitted request (rows 3–4,
   7–8): every #697/#917 outcome of such an execution — nonzero exit,
   timeout, effect-verification failure, backend refusal, operator
   cancellation (`cancelled`, #917 §8.3),
   infrastructure failure, `lost` — parks with evidence and residue
   preserved, nothing retries itself, and nothing silently downgrades
   isolation to keep going
   (#917 §13 rule 3). A planned step the runner reaches itself
   (rows 1–2) has no request record to park; its command runs inside
   its owning #918 cycle, a nonzero exit or timeout is
   `code-failure`/`timeout` continuing the verification set into the
   repair loop as ordinary fix input (#917 §11.3: `verification.pinned`
   output feeds the shipped repair loop, never the Tool Request human
   handoff), and only #918 §9's own routes (the `tainted` park, rule 4's
   pinned refusal route) stop the task — never this table's parks.
4. **Parking is single and typed.** Every park row lands
   `ready_for_human` via the `tool_request` handler result; at most one
   unresolved request exists per task (`hasUnresolvedToolRequest` is the
   authority, #677), and a parked task consumes no agent invocations.
5. **Continuation is evidence-routed.** Row 26 is #918 §10 verbatim: a
   passed runner-owned cycle plus the full E1–E7 state evidence — never a
   successful command alone, and never an agent statement. Everything
   else returns to implementation with mandatory context (§6).

## 6. Human interaction — dispositions and the operator-response contract

### 6.1 The disposition surface is the shipped one

Actions (`manual-done` | `reject` | `guided-run` | `grant`), dispositions
(`no-op` | `committed` | `discarded` | `failed`), the guided-run flags
(`--disposition keep|commit|discard`, `--on-changes
commit|keep|discard|reject|abort`, `--confirm-discard`,
`--allow-unexpected`), and the clean-worktree, contaminated-base, and
off-issue-branch guards are all preserved exactly as
`docs/tool-request-and-dependency-sync.md` §2 and
`docs/guided-tool-request-flow.md` specify. This contract adds no
disposition and removes none.

### 6.2 Continuation context is mandatory, not incidental

`docs/tool-request-redesign.md` §4.4's rule is adopted as this
contract's own: **a Tool Request must never resolve in a way that
re-queues the agent with no memory of what the operator decided or what
a command revealed.** Every continuation prompt (rows 18, 20–22,
24–25, 27)
carries the operator-response context: the prior request (exact command
on the local prompt surface, `displayCommand` everywhere public), the
action, the disposition phrase, the operator note, the captured bounded
result, and the per-disposition instruction — the shipped
`toolRequestResolutionPromptSection` rendering, which implementation
slices keep as the single source of that section. Resolving a request
without recording what the next prompt needs is a defect, not a
degraded mode.

### 6.3 Repeat-aware instructions

The per-disposition instruction lines keep their shipped intent: a
`reject` tells the agent not to repeat the request without new evidence;
a `no-op` tells it the captured output *is* the answer; a `failed` tells
it not to expect a different result from the same command. §7 is the
enforcement behind those instructions — the instructions persuade, the
repeat rules guarantee.

### 6.4 The unattended resolution record

Rows 3–4 and 7–8 resolve the request without an operator only when the
launched execution succeeds: the run exits 0 within budget, its observed
effects verify within the enumeration and are adopted (#697 §§7–8), and
its backend outcome is `ran` — never a refusal, a cancellation
(#917 §8.3), or `lost`. A launch that fails
any of those takes rows 10–12 instead — the request stays unresolved,
the task parks, and the eventual resolution belongs to the §6.1 operator
surfaces; `"auto-executed"` is never written for a failed run. The
resolution record for the successful case is new, slice-owned vocabulary
(the one addition this contract makes to the request record):

- `resolution.action` gains one value: `"auto-executed"`. The four
  shipped values and their semantics are unchanged.
- An `"auto-executed"` resolution carries the resolved `operationId`,
  the authorizing source (`"plan-approval"` or `"session-allowlist"`),
  the tier, and the captured bounded result — the same fields the #697
  §11 audit record already stores, referenced rather than duplicated.
- The continuation prompt renders it through the same §6.2 section: the
  agent that emitted the request learns, in its next run, that the
  operation ran, under what authority, and with what bounded output —
  "resolved requests continue with complete prior request and operator-
  response context" holds on the unattended path too.
- The legacy dependency route (row 13) keeps its shipped recording and
  continuation sections unchanged during migration; it adopts the
  `"auto-executed"` record only at #697 §14's subsumption point.

## 7. Repeated requests and no-progress loops — deterministic handling

### 7.1 Identity

Repeat decisions use two identities, both already defined:

- **Typed**: `(operationId, params digest)` — protected by #697 §6
  rule 6 (`"already-executed"`, at most once per task attempt) and #915
  §10's occurrence reservation (`"occurrence-exhausted"`, per window,
  ambiguous reservations counting as consumed). Rows 5 and 9 are the
  whole story: a typed repeat converges on a human, never on a second
  execution.
- **Free-form**: the normalized command bytes
  (`normalizeToolRequestCommand`, trim-only — deliberately not the
  grant's whitespace-collapsing hash) within one task attempt.

### 7.2 The free-form repeat rules

1. **Unresolved duplicate** (row 17): the shipped
   `toolRequestRepeatKind` `"unresolved-duplicate"` suppression is made
   uniform and normative — one park, one public comment, however many
   times an interrupted agent re-emits the same block.
2. **Resolved duplicate**: a re-emitted identity whose prior request was
   resolved is served normally *once* — the continuation may legitimately
   need the same command again after new work — with the repeat recorded
   (`"resolved-duplicate"`, and `repeatedAfterManualDone` preserved for
   its shipped case). It parks like any first request; the operator
   surface shows the prior request and response beside it.
3. **No-progress repeat** (row 28): a continuation run that adds no
   commits and no file changes and re-emits the identity its own
   delivered context already answered is not served again: it parks
   directly, carrying the prior request *and* the prior operator
   response, marked `repeatedAfterResolution` (the generalization of the
   shipped `repeatedAfterManualDone`). At most one automatic
   continuation exists per identical free-form identity per task
   attempt; the second consecutive no-progress emission is a human
   decision by definition — the agent has demonstrated it cannot proceed
   without something the loop cannot give it.

### 7.3 No-op continuation runs

A resumed continuation run that ends with no Tool Request, no new
commits, and no changes keeps the shipped #404 semantics: success when
the resume branch already carries issue commits beyond its start point
(recorded `resumedNoChanges`), failure for a fresh run that produced
nothing. #722 (row 26) removes the eligible no-op detour entirely by
routing evidence-passing resolutions straight to review; the #404
posture remains the fallback for everything else. Deterministic in both
directions: no heuristic inspects agent prose to decide whether progress
happened — commits, file changes, and request identity are the only
inputs.

## 8. Parking — one Issue stops, nothing else does, and the system says why

### 8.1 What parking is

Parking is the shipped human handoff, restated and bounded:

1. The task moves to `ready_for_human` via the `tool_request` handler
   result — a distinct classification, not a failure (`failed`) and not
   a dependency hold (`blocked`).
2. The phase run ends; the issue lock releases; the worktree and any
   preserved branch stay exactly as §9 specifies.
3. A parked task is not claimable, consumes no agent invocations, runs
   no retries, and emits no repeated public comments (row 17). Silence
   after the one handoff comment is contractual: a parked Issue costs
   zero tokens and zero API noise until a human acts.
4. Release paths are exactly the resolution surfaces (rows 18–25) plus
   the operator acts the task store already owns (`cancelTask`; the
   Human Gate flow after resolution, row 30).

### 8.2 Three gates, one at a time

"Human gate" names three independent mechanisms, and this contract keeps
them independent (`docs/human-gate-no-go-flow.md` §1's terminology guard
adopted): the Tool Request permission gate (this document), the
`ready_for_human` merge gate (Human Gate No-go), and the planning gate.
A task sits behind at most one at a time; the cross-refusal is
mechanical: Human Gate operations and generic recovery refuse
`tool_request_unresolved` while a request is live (row 30), and a Tool
Request park is never disposed through Human Gate dispositions.

### 8.3 The chain behind a parked Issue

A parked Issue stalls its chain **by the existing dependency gate, not
by any new machinery**: dependent Issues were never admissible before
their predecessor merged, so they simply remain unadmitted. No chain
scheduler is introduced (#915 §13's rule, inherited), no queue is
reordered, and nothing polls.

- **A chain blocked on a genuinely human-only decision may stop —
  indefinitely.** That is designed behavior, not an error state. What is
  contractual is the explanation (§8.4) and the silence (§8.1 rule 3):
  the loop never burns invocations re-deriving the same park.
- **Other already-runnable Issues continue** under the existing intake
  and claim behavior, unchanged: parking is scoped to one task, and the
  single-lane loop moves on to whatever else is admissible.
- Un-parking is always an operator act on the parked Issue itself
  (resolution, rejection, cancellation, or chain edit through the chain
  registry's own surfaces).

### 8.4 Explain, never loop

Every park must be answerable from operator surfaces without reading
logs, and the answer is recorded at decision time, not reconstructed:

1. **The decision trail** — `preflight_authorization_resolved` (#915),
   `tool_request_tier_resolved` (#697), and this contract's
   `tool_request_parked` event (§10.2) name, for every park, which
   authorities were consulted and which closed refusal reason each
   returned. "Why did this stop for a human" has a recorded, enumerable
   answer.
2. **The public handoff comment** — the one bounded, redacted comment
   the shipped flow already posts (`displayCommand`, reason, suggested
   action; duplicates suppressed).
3. **The status surfaces** — `admin status` lists the parked task with
   its request; the #915 §12 plan status surface shows refusal reasons
   and dangling reservations; the chain inspection surface
   (`admin chain …`) reads the same records, so "this chain is waiting
   on Issue N's Tool Request" is visible without new scheduling state.
4. **Notification** — the park rides the existing outbox/visibility
   pipeline (the `slack:notification` row family); no new publication
   path is introduced (#697 §12 criterion 5's discipline).

## 9. Preserved work products — branch, worktree, and residue safety

The park must never cost work, and no disposition may destroy bytes it
did not first preserve. All shipped mechanisms, made contractual:

1. **Partial agent work**: the interrupted run's diff is captured to
   `partial-implementation.patch` (with `partialDiffCaptureFailed`
   recorded when capture itself failed), and where the shipped flow
   preserves a branch it records `preservedBranch` /
   `preservedBranchPushed` so the continuation point survives the park.
2. **Guided-run residue**: `discard` snapshots to
   `discarded-changes.patch` before `git reset --hard` + `git clean
   -fd`, and requires `--confirm-discard`; `commit` stages only after
   the expected-files check; `keep` leaves everything in place.
3. **Relaxed-tier residue** (rows 10–12): the produced diff stays in
   the worktree for the guided dispositions — a row 12 refusal is
   pre-launch and leaves none, a cancelled run's partial residue stays
   in place for the same dispositions, and a `lost` run's worktree
   residue stays with its forensic record retained (#917 §10); adoption never
   stages agent-authored bytes (#697 §7 step 4's patch-level boundary),
   and an entangled overlap adopts nothing.
4. **Worktree lifetime**: the per-issue worktree survives the park under
   the shipped worktree rules; nothing in this contract deletes a
   worktree, and any future cleanup slice must preserve parked tasks'
   worktrees fail-closed.
5. **The base branch is untouchable**: guided runs execute on the issue
   branch only, with base-SHA and tracking-ref snapshots compared after
   execution; base mutation fails the run closed (row 25) and is an
   operator incident, never auto-repaired.

## 10. Failure, recovery, and audit

### 10.1 Crash and recovery behavior

- **Crash before the gate decision records**: the request re-parses from
  the run's captured output on the next phase run; no decision means no
  execution happened (rows 1–15 execute only after their authority's
  verdict is durable — #915's reservation-before-launch is the strict
  form for plan entries).
- **Crash during an auto-execution**: #915 §10's ambiguous-reservation
  rule governs plan occurrences (reservation counts as consumed; the
  window stays spent; the dangling reservation is surfaced); #697's
  at-most-once rule governs allowlist executions the same way through
  its §11 audit trail. Recovery never relaunches an ambiguous unattended
  execution — the next window or a human does.
- **Crash after resolution, before re-queue**: resolution records are
  durable before the continuation destination is issued; recovery
  re-issues the continuation from the record (the shipped
  continuation-point machinery), never re-executes the disposition.
- **Generic task recovery**: `RECOVERABLE_STATUSES` stays
  `["failed", "claimed", "running"]`; `ready_for_human` is deliberately
  not in it, and `recoverHandoff` keeps refusing
  `tool_request_unresolved` while a request is live (row 30). A parked
  task re-enters the loop only through resolution.
- **Stale-run reconciliation** for backend-routed executions is #917
  §8.5/§12 verbatim; a run recovery closes `"never-launched"` settles
  its reservation with a definite outcome instead of parking a human on
  a command that provably never spawned.

### 10.2 Audit events

The decision trail reuses the predecessors' closed event sets
(`preflight_*`, `tool_request_tier_*`, `tool_request_grant_*`,
`tool_request_effects_*`, `verification_cycle_completed`) and adds
exactly two task events, both closed:

- `tool_request_parked` — one per park: the derived park row number
  (§5), the consulted authorities' refusal reasons, the repeat kind if
  any, and the preserved-work markers. Never command bytes beyond
  `displayCommand`.
- `tool_request_continuation_routed` — one per issued continuation: the
  destination (`implementation` | `review` | `parked`), the resolution
  action, and — for row 26 — the evidence verdict with any failed check
  named (#918 §10.3's recording requirement, restated).

Public surfaces keep the bounded, redacted posture of every predecessor:
names, reasons, and counts; never output bytes, paths, exact commands,
or refusal detail strings.

### 10.3 Admin and UI operations

The operator surface set for this contract is the shipped one plus the
slices the predecessors already reserved — no new command grammar is
defined here (the admin-CLI contracts govern that when surface slices
land): `admin tool-request list|resolve|run` (and the deprecated `grant`
alias), the #697 §10 `postHocReview` listing surface, the #915 §12 plan
review/decide/revoke/status surface, `admin status` and the chain
inspection surface reading the §8.4 records, and `admin session-doctor`
reporting the #916 capability posture that decides whether relaxed tiers
can execute at all.

## 11. Reconciliation

### 11.1 With #697, #915, #916, #917, #918

- **#697** is consumed whole: tiers, resolution, boundary, effect
  verification, adoption, audit. This contract composes its gate
  decision point into the §5 table and adds the `"auto-executed"`
  request-record vocabulary (§6.4) at the seam #697 left to its
  implementation slices. The migration exception and its
  `"already-executed"` carve-out appear as rows 13–14 and 9 verbatim.
- **#915** supplies rows 1–6 and the "declared and approved before
  needed" policy. The consult order (§3.2) is #915 §9's precedence
  restated; nothing about plans, fingerprints, or reservations is
  redefined.
- **#916** bounds the whole design to the closed platform set — the
  acceptance criterion "long-running single-lane operation on macOS,
  Linux/EC2, and WSL2" is #916 §4's matrix — and its degraded-mode
  policy is what keeps security controls from making normal work
  unusable: a host without attestation runs the full base loop and
  human-gates the relaxed surface, subtracting nothing.
- **#917** executes everything: auto-executions on attested isolated
  backends (never `local`), guided grant runs as `"tool-request.granted"`
  under the operator's per-class policy, and the no-silent-downgrade
  rule behind §5 rule 3. Its §11.3 rows are the outcome consumption for
  every executed row here — row 12 is its `tool-request.pinned`
  `refused`/`infrastructure`/`lost` columns restated as a park row,
  plus the `cancelled` outcome — closed in #917 §11.1 but absent from
  §11.3's columns — mapped onto the same park by this contract.
- **#918** owns verification and continuation evidence. Row 26 is its
  §10 gate; the `tool-request-continuation` lane, the evidence bundle,
  and the E1–E7 set are consumed unchanged. It also owns every planned
  verification outcome outright: a `"plan-approval"` step the runner
  reaches itself (row 2) fails or passes inside its #918 cycle —
  classification §7, aggregation §8, continuation §9 — and never
  produces or parks a Tool Request; rows 10–12 are scoped to
  request-resolving executions (rows 3–4, 7–8). The #722 verdict
  (**validated with revisions R1–R6**) stands exactly as #918 §10.5
  records it; this contract adds only the rows that consume it and
  changes `docs/verification-execution-contract.md` not at all.

### 11.2 With the shipped Tool Request tree

- **Emission** (`docs/tool-request-and-dependency-sync.md` §2.1–§2.2):
  unchanged — the `<<<TOOL_REQUEST>>>` block, the field set, the bounds,
  the `command`/`displayCommand` split, and the non-authoritative
  `suggested_action` hint set (`dependencySync`, `guided-run`,
  `manual-review`).
- **Classification** (§2.3): the park row semantics here are that
  section restated — `ready_for_human` via the `tool_request` result,
  never `blocked`, never `failed`.
- **Metadata record** (§2.5): the stored shape is the shipped one. That
  section's original suggested `"status": "open"` field is explicitly
  superseded — a supersession note lands there with this document — so
  §4's rule (`resolved`/`resolution` only, no `toolRequest.status`
  column) leaves no source contract still mandating a status column.
- **Grants** (§2.6): retained as the internal authorization primitive,
  per-occurrence and short-lived; §3.3's never-durable rule is the
  policy those mechanics already imply, now stated. The deprecated
  `grant` alias surface resolves through the guided-run rows 21–25
  (§5), tagging its record `grant`.
- **Continuation points** (§2.7) and the `manual-done` fail-closed
  guard: rows 18–19 verbatim.
- **Dependency sync** (§3): preserved through the migration as the
  legacy route (rows 13–14) until #697 §14's subsumption bar; safe mode
  and lifecycle-script exclusion unchanged.
- **`docs/tool-request-redesign.md`**: §4.4 (continuation context
  mandatory) is adopted as §6.2; §9a items 1–3 are the shipped baseline
  this contract builds on; item 4's execution-environment resolver is
  superseded for guided runs by #917's per-class backend policy
  (`"tool-request.granted"`), while its restricted-host track for
  agent-proposed free-form text remains exactly as deferred as #697 §15
  left it; items 5–6 (state-aware presentation, risk-acceptance
  opt-ins) fold into the U-slices and open questions.
- **`docs/guided-tool-request-flow.md`**: the flow is unchanged; the one
  amendment this document lands is editorial — §3.9's record-update step
  now names the shipped `resolved` field instead of the never-shipped
  `toolRequest.status` (§4's no-status-column rule). Its §4 continuation
  amendment is #722's (R6).
- **`docs/human-gate-no-go-flow.md`**: unchanged; §8.2 adopts its
  three-gate terminology guard and its `tool_request_unresolved`
  cross-refusals.
- **Issue-numbered shipped behaviors preserved**: #300 (repeat-kind
  comment suppression → row 17), #302 (dependency-update router →
  row 13), #404 (resumed no-op success → row 27), #419 (`--on-changes`
  dispositions), #430 (guided run), #677 (unresolved-request authority →
  rule 4, row 30), #678 (failed-clean requeue → row 25), #681 (review
  admission untouched — #918 §12.4).

### 11.3 Superseded framings

No shipped behavior is removed. The one framing this contract retires is
the implicit "every resolution re-queues implementation
unconditionally": row 26 (via #722) replaces it with evidence-routed
continuation, and rows 5, 9, and 28 replace "re-queue and hope" with
deterministic parks for the repeat cases. Each of those is a recorded,
slice-owned behavioral change (§12), never a silent one.

## 12. Final implementation decomposition (proposal for human approval)

**No implementation Issues are created by this document.** The table
below is the proposed Issue split for the whole chain's runtime work,
dependency-ordered; it awaits human approval, and the tracker — not this
document — assigns numbers and may re-cut slices. Slice ids reference
their defining contracts (#917 §17's D-slices, #918 §13's V-slices; G/P
slices implement #697/#915; N/O slices implement #916; U slices
implement this document). Effort maps to the tracker's complexity
labels: **S** ≈ `complexity:medium`, **M** ≈ `complexity:high`, **L/XL**
≈ `complexity:xhigh` (XL additionally carries spike risk and should not
be scheduled in parallel with another XL).

| # | Slice | Delivers | Depends on | Effort |
| --- | --- | --- | --- | --- |
| 1 | B1 (#917 D1) | ExecutionBackend seam, `local` engine, M0 routing of the four operator-owned classes, byte-equivalence pins | — | L |
| 2 | B2 (#917 D2) | Run records, lifecycle, heartbeats, §8.5 reconciliation, supervised launch, admin recovery surface | B1 | L |
| 3 | B3 (#917 D3) | `selectBackend` pure core + per-class session policy schema, fail-closed load validation | B1 | M |
| 4 | V1 (#918) | Unified verification engine: set resolution, lifecycle, classification, aggregation, cycle bundle, per-lane adapters | B1 | L |
| 5 | V2 (#918) | `verificationPolicy` schema + timeout wiring (recorded default-budget change) | V1 | S |
| 6 | V3 (#918) | Full-bundle continuation evidence in fix/repair prompts (recorded first-failure-only replacement) | V1 | S |
| 7 | V4 (#918) | Infrastructure/sandbox classification wiring, `verification_cycle_completed`, operator surfaces for infra/policy cycles | V1, B2 | M |
| 8 | G1 (#697) | Typed-operation registry, `resolveGrantTier` pure core, allowlist session validation — resolution and audit events only, nothing executes yet | — | M |
| 9 | U1 (#919) | Gate decision-point wiring: the §3.2 consult order, §5 park rows, `tool_request_parked`, uniform duplicate suppression, free-form repeat identity + no-progress detection (`repeatedAfterResolution`) | G1 | M |
| 10 | N1 (#916) | Startup gates (§9 rules 1–4), probe skeleton, unknown-as-absent plumbing | — | M |
| 11 | N2 (#916 + #917 D6) | `native-sandbox` engine + behavioral canaries; spikes S1/S4/S5/S6/S7 land here or block their axes | B2, B3, N1 | XL |
| 12 | G2 (#697) | Relaxed-tier execution: snapshot baseline, effect verification, patch-level adoption, `"auto-executed"` resolution record + continuation context (§6.4) | G1, U1, N2 | L |
| 13 | G3 (#697) | Notify tier: adoption-transaction notification, `postHocReview` operator surface, `tool-request-tier.json` audit artifact | G2 | M |
| 14 | P1 (#915) | Plan schema, canonical serialization + fingerprint, validation, store ports, lifecycle + events | G1 | L |
| 15 | P2 (#915) | Plan assembly: contribution layers, fixed parsers, baseline evidence collection, snapshot timing | P1 | M |
| 16 | P3 (#915) | Preflight resolution + guarded occurrence reservation wired ahead of tier resolution; the `"occurrence-exhausted"` direct park | P1, U1, G2 | M |
| 17 | P4 (#915) | Plan operator surfaces: review (digest-verified command display), approve/decline/revoke, status with reservation residue | P1 | M |
| 18 | B4 (#917 D4+D5) | `container` engine + trust-domain cache/stamp binding (opt-in per class policy) | B2, B3 | L |
| 19 | O1 (#916 + #917 D7) | `capabilities()` → capability report → `admin session-doctor` (validation-plan step V4 becomes runnable) | B3, and N2 or B4 for probed axes | M |
| 20 | U2 (#919) | Parking observability: status/chain surfaces answering §8.4, `tool_request_continuation_routed`, notification wiring on the existing outbox | U1 | S |
| 21 | V6 (#722) | Verification-gap classification, verification-first continuation, E1–E7 validation, the `{queued, review}` route, the `docs/guided-tool-request-flow.md` §4 amendment (R1–R6) | V1–V4, U1 | M |
| 22 | G4 (#697 §14) | `dependency.sync` typed-entry migration to the subsumption bar; legacy-route retirement decision recorded | G2, G3, P3 | M |
| 23 | B5 (#917 D8) | Packaging: optional container runtime, volume contract, `docs/install.md` additions | B4 | S |
| 24 | O2 (#916 §11.4) | Platform validation runs V1–V7 per target; maturity flips recorded in delivery notes | O1 | M |
| 25 | U3 (#919) | Migration and compatibility sweep: tiers-off/preflight-off byte-equivalence, M0 pins hold end to end, legacy-route preservation, repeat-rule determinism, cross-gate refusals — the regression floor for every recorded behavioral change above | continuous; final gate after G2, P3, V6 | M |

Reading the order: the backend seam and the verification engine (1–7)
are pure infrastructure with byte-equivalence obligations and unblock
everything; the trust layer (8–9) can start in parallel because
resolution is pure; nothing auto-executes until the sandbox floor exists
(11→12); plans (14–17) layer on the same execution machinery; the
direct-to-review route (21) and the subsumption decision (22) come last
because they are the only rows that retire shipped behavior. The
critical path to "routine operations stop parking" is
B1→B2/B3→N1→N2→G2 with G1/U1 alongside; everything else is breadth.

## 13. Invariants

1. The §5 decision table is total and closed: every emitted request and
   every planned step takes exactly one row; adding a row — or a fifth
   authority — is a change to this document first.
2. Auto-execution exists only for typed operations under operator-
   authored authorization (allowlist or approved plan), executes only
   pinned substitutions under an attested isolated backend, and never
   executes agent command text (#697 invariants 1–2, #917 §13 rule 4).
3. Free-form approval is never durable: grants stay per-occurrence,
   exact-command-hash, short-lived; no surface converts a disposition
   into a standing relaxation (§3.3).
4. Everything outside typed authorization parks: free-form shell,
   untyped dependency additions, credentials, spend, out-of-policy
   network,
   canonical-repository mutation, and unresolved policy are human-gated
   by construction (§3.4).
5. A park is always `ready_for_human` via the `tool_request` result —
   never `blocked`, never `failed` — with at most one unresolved request
   per task, and a parked task consumes no agent invocations and posts
   no duplicate comments (§5 rule 4, §8.1).
6. Every continuation carries the operator-response (or auto-executed)
   context; resolving a request without recording what the next prompt
   needs is a defect (§6.2, §6.4).
7. Repeat handling is deterministic over recorded identity and prior
   outcome: typed repeats converge on a human via `"already-executed"` /
   `"occurrence-exhausted"`, free-form no-progress repeats park after at
   most one automatic continuation per identity per attempt, and no
   heuristic inspects prose (§7).
8. Continuation to review requires #918 §10's passed runner-owned cycle
   plus full E1–E7 evidence — never a successful command, a guided-run
   exit status, or an agent statement (§5 rule 5).
9. Parking one Issue introduces no chain scheduler: dependents stall on
   the existing dependency gate, other admissible Issues continue under
   existing intake/claim, and un-parking is an operator act (§8.3).
10. Every park is explained from recorded decisions: the consulted
    authorities and their closed refusal reasons are durable at decision
    time and readable from the status surfaces (§8.4).
11. No disposition destroys unpreserved work: discards snapshot first,
    parks preserve branch/worktree/patch artifacts, adoption never
    stages agent-authored bytes, and the base branch is never mutated by
    any path in this contract (§9).
12. Recovery never relaunches an ambiguous unattended execution and
    never bypasses a live request: ambiguous reservations stay consumed,
    `ready_for_human` is not generically recoverable, and
    `tool_request_unresolved` guards both recovery and the Human Gate
    (§10.1, row 30).
13. This contract adds no `TaskStatus`, `PhaseRunOutcome`,
    `PhaseHandlerResult` member, tier, refusal reason, backend, outcome,
    plan state, or ChatOps verb; its own vocabulary is the derived
    lifecycle states, the `"auto-executed"` resolution action, the
    `repeatedAfterResolution` marker, and the two §10.2 events.
14. The §12 decomposition is a proposal: no implementation Issue is
    created by this document, and the split executes only after human
    approval, with the tracker assigning numbers.

## 14. Test seams and matrix

For the implementation slices that build against this contract (the docs
pin at the end is the only test landing with #919 itself):

| Area | Cases |
| --- | --- |
| Decision order (§3, §5 rows 1–17) | consult order preflight→tiers→legacy→gate with unchanged inputs on fallthrough; `"occurrence-exhausted"` and `"already-executed"` park directly, never reaching the legacy route; an `"occurrence-exhausted"` park caused by an unsettled reservation carries the dangling reservation state, not a fabricated outcome; a refused, cancelled, infrastructure-failed, or `lost` request-resolving execution parks via row 12 with the refusal reason or run record carried and is never relaunched; free-form requests park with no authority consulted beyond nomination; adversarial `command`/`reason`/`suggested_action` text asserted unread by every decision (only a declared `input.parser` reads `command`). |
| Auto-execution recording (§6.4) | an `"auto-executed"` resolution carries operationId/source/tier/bounded result; the continuation prompt renders it through the shared section; the legacy route's shipped recording is untouched until subsumption. |
| Dispositions (§5 rows 18–25) | each row's route and record; `manual-done` refusal without a continuation point; `reject` requires a message; `keep` leaves the request unresolved and the park standing with no automatic re-queue; guided-run residue rules (snapshot-before-discard, expected-files check, base-mutation fail-closed). |
| Repeats (§7) | unresolved-duplicate emits no second comment or park; a resolved duplicate is served once with the repeat recorded; a no-progress repeat parks with both records attached and never re-continues within the attempt; commit/file-change evidence is the only progress input. |
| Continuation (§5 rows 26–29) | row 26 defers entirely to #918 §10's gate (each E-check individually failing → implementation); row 27 carries mandatory context; row 28 fires only on identity-plus-no-progress; `nextPhaseAfter` untouched. |
| Parking (§8) | park is `ready_for_human` via `tool_request`, never `blocked`/`failed`; parked task unclaimable, zero agent invocations; cross-gate refusals both directions (`tool_request_unresolved`); dependents stall via the dependency gate while an unrelated admissible issue is claimed; every park's `tool_request_parked` event names the refusal trail. |
| Preservation (§9) | partial-diff and preserved-branch markers present across a park; `discarded-changes.patch` written before reset; worktree survives the park; base SHA and tracking ref compared after guided runs. |
| Recovery (§10.1) | ambiguous reservation stays consumed across a crash; resolution durable before re-queue and recovery re-issues without re-executing; `RECOVERABLE_STATUSES` unchanged. |
| Docs pin | `test/docs-unattended-tool-request-contract.test.js` pins this document's status line, chain position, the deferrals to the six fixed predecessor contracts, the closed derived-lifecycle set and the no-status-column rule, the authority order and its two direct-park carve-outs, the never-durable free-form rule, the human-gate floor, the 30-row decision table, its five rules, and the `grant`-alias mapping onto the guided-run rows, the mandatory continuation-context rule and the `"auto-executed"` addition, the deterministic repeat rules, the parking contract (single park, three-gate independence, no chain scheduler, explain-never-loop), the preservation rules, the two new events, the reconciliation statements (including the #722 R1–R6 restatement, the redesign-§6 supersession note, and the §2.5/§3.9 status-column supersession amendments in the two shipped Tool Request documents), the 25-slice decomposition with its approval-first rule, and the delivery notes in `docs/tool-request-grant-tiers-contract.md` §18, `docs/preflight-execution-plan-contract.md` §20, `docs/single-host-execution-backend-contract.md` §20, `docs/verification-execution-contract.md` §16, and `docs/DOMAIN.md` §5 where present — against drift. |

## 15. Non-goals and forward pointers

This document defines the unattended decision, continuation, and parking
policy only. It does not define, and nothing implementing it should
assume:

- **Implementation of any slice** — the §12 proposal awaits human
  approval; the tracker assigns issue numbers. #722 (slice V6) is the
  chain's named direct-to-review issue and changes
  `docs/guided-tool-request-flow.md` §4 as #918 §10.5 R6 requires.
- **Generic auto-grant of agent-proposed commands** — exactly as
  deferred as #697 §15 left it; nothing here gives free-form text a new
  route, and the restricted-host track of
  `docs/tool-request-redesign.md` §6/§9.4 remains the premise-changing
  prerequisite.
- **ECS/Fargate, multi-lane scheduling, and multi-host substrates** —
  rejected for this design cycle by #916 §4; a chain scheduler is
  permanently out of scope here (#915 §13).
- **Changes to the guided flow, the Human Gate No-go flow, the admin CLI
  grammar, the ChatOps verb table, or the session schema** — governed by
  their own contracts when surface slices land.
- **New phase-runner vocabulary** — none exists here and none may be
  introduced by a slice citing this document (invariant 13).
- **ChatOps approval/resolution verbs** (`tool-request.run` /
  `tool-request.resolve` registration, a `preflight.approve` verb) —
  still the open items #784 §12 and #915 §17 record.
