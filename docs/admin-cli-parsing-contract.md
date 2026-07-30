# admin CLI shared parsing, output, help, and confirmation contract

This document specifies the cross-cutting implementation boundary for
`src/cli/admin-command.ts` and `src/cli/cli-io.ts` — the shared infrastructure
every admin subcommand (and the non-admin CLI entrypoints that reuse it) must
go through for option parsing, output rendering, help rendering, and
state-changing confirmation (issue #709). It isolates the parsing/output/
confirmation slice of the broader decomposition attempted in #612, which hit
the review cycle cap; #708 isolated the sibling registry/dispatch slice into
[`admin-command-registry-contract.md`](admin-command-registry-contract.md).
PR #707 is prior-attempt research material only — where anything below
differs from it, this document, reconciled against the current
`src/cli/admin-command.ts`, `src/cli/cli-io.ts`, `src/cli/admin.ts`, and
`src/cli/admin-ui.ts`, is authoritative. **This is a documentation-only
issue: no production code is moved or refactored here.**

See also [`admin-cli-contract.md`](admin-cli-contract.md) for the baseline
output-mode/exit-code/option-validation contract this document extends, and
[`admin-command-registry-contract.md`](admin-command-registry-contract.md)
for how `admin.js` decides which command was invoked in the first place
(covered there, not here).

## 1. Ownership: one shared engine, per-command declared surface

There are two distinct ownership layers, and conflating them is the most
common source of drift:

1. **Global output flags** (`--json`, `--quiet`, `--verbose`) are owned
   end-to-end by `extractOutputFlags`/`resolveOutputMode` in `cli-io.ts`.
   They are pulled out of `rawArgv` by **literal token match, anywhere in
   the argument list**, before `main()` dispatches to any command-specific
   parser (`src/cli/admin.ts` — `main()` calls `extractOutputFlags(rawArgv)`
   as its first statement). Every dispatchable command accepts them
   implicitly; no command declares them individually.
2. **Everything else** — `--session-id`/`--session-ref`, `--issue-number`,
   `--phase`, `--dry-run`, `--yes`, and every command-specific flag — is
   owned by the shared *mechanism* in `admin-command.ts`
   (`tokenizeArgs`/`parseCommonOptions`), but each command declares its own
   accepted *subset* of that mechanism via a `CommonOptionSpec` (or a raw
   `TokenizeSpec` for the handful of commands that call `tokenizeArgs`
   directly instead of `parseCommonOptions`). There is no single global list
   of "every flag every command accepts" at this layer: `--dry-run` is legal
   on `recover` because its spec sets `dryRun: true`, and a hard unknown-flag
   error on `task clear-delay` unless that command's own spec independently
   lists it. A later decomposition must preserve this two-layer split:
   pulling `--json`/`--quiet`/`--verbose` handling into a per-command spec
   (or vice versa, making `--dry-run`/`--yes` implicitly global) is an
   observable behavior change, not a refactor-neutral move.

### Pre-existing exceptions: commands that bypass the shared parser

The "everything else is owned by `tokenizeArgs`/`parseCommonOptions`"
statement above describes the intended, near-universal shape, not a
guarantee that holds for every command today. Two separate hand-rolled
parsers sit outside that mechanism, and a later implementation must not
present either as already converged.

**`admin worktree prune`** (`parseWorktreePruneArgs`, `admin.ts:2782-2809`)
hand-rolls its own argv scan instead of calling either shared function. That
hand-rolled loop recognizes `--yes` and `--force` as booleans, then treats
*any other* `--flag value` pair as a known value flag by storing it under
`args[flag]` — it never rejects a flag name it doesn't recognize. Unknown
options are silently accepted and then simply never read back out of
`args`. Concretely, `worktree prune --session-id s --issue-number 4 --yes
--dry-ru value` parses without error: `--dry-ru` (a typo of `--dry-run`,
which this command does not even implement) is stored as `args["dry-ru"] =
"value"` and discarded, `--yes` is still recognized on its own, and the
command proceeds to prune. This is the exact failure this document's
"unknown flags fail closed" bar (§ "Unknown options are hard errors" in
`admin-cli-contract.md`) exists to prevent, and `worktree prune` does not
currently meet that bar.

**`admin worktree cleanup`, `admin worktree release-lock`, `admin
review-lock status`, `admin review-lock release`, and `admin worktree
discard`** all call a second, separate hand-rolled parser,
`parseStrictArgs` (`admin.ts:3643-3670`), via their own thin wrappers
(`runWorktreeCleanup`, `parseIssueLockReleaseArgs` — shared by
`worktree release-lock` and `review-lock release` — `runReviewLockStatus`,
and `parseWorktreeDiscardArgs`). Unlike `worktree prune`'s parser,
`parseStrictArgs` *does* reject any `--flag` it does not recognize (an
unlisted flag name is a hard `Unknown option: --<name>` error), so these
five commands meet the "unknown flags fail closed" bar for flag *names*.
But `parseStrictArgs` still diverges from `tokenizeArgs` in one respect: for
a declared value flag, it unconditionally consumes the next token as that
flag's value — including a token that itself starts with `--`. `tokenizeArgs`
refuses a value token starting with `--` (§ "Precedence rule this split
implies" above); `parseStrictArgs` does not. Concretely, `worktree discard
--session-id s --issue-number 4 --sessions-path --yes` parses without
error under `parseStrictArgs`: `--yes` is consumed as the *value* of
`--sessions-path` (`args["sessions-path"] = "--yes"`) rather than being
recognized as the `--yes` confirmation flag, so the command falls through to
its default (non-confirmed) preview behavior instead of erroring or
proceeding — a silent flag-swallow shaped differently from, but in the same
family as, `worktree prune`'s gap.

A later implementation must not present "every command hard-rejects unknown
flags and options never swallow an adjacent flag as a value" as already
true everywhere. For each of these six commands (`worktree prune` plus the
five `parseStrictArgs` callers), it must either migrate the command onto
`tokenizeArgs`/`parseCommonOptions` as part of that command's extraction
(closing the gap) or explicitly carry the applicable exception forward as a
documented, pre-existing safety gap rather than silently inheriting it.

### Precedence rule this split implies

Because global flags are stripped by literal match *before* any
command-specific tokenizer sees `argv`, a value-flag's value can **never**
literally be `--json`, `--quiet`, or `--verbose` — that token is always
captured as a global flag first and never reaches the command parser as a
candidate value. (In practice this rarely matters because `tokenizeArgs`
independently refuses any value token that starts with `--`, but the two
mechanisms reach the same refusal for different reasons and a later
implementation must not merge them in a way that changes which layer
produces the error.)

### `--session-id` / `--session-ref` resolution and precedence

`resolveSessionSelector` (`admin-command.ts`) is the single owner. Precedence,
in order:

1. Both `--session-id` and `--session-ref` present → hard error
   (`Provide only one of --session-id or --session-ref, not both`), before
   either is resolved.
2. `--session-id` present alone → used verbatim, **never validated** against
   `sessions.json`. This is deliberate back-compat: existing callers that
   pass a sessionId the registry doesn't know about must keep working.
3. `--session-ref` present alone → resolved to a canonical `sessionId`
   through the shared registry resolver (`resolveSessionRef`, keyed off
   `--sessions-path` or `DEFAULT_SESSIONS_PATH`); an unresolvable ref
   surfaces the resolver's own error message verbatim.
4. Neither present, and the command's spec requires a session → hard error
   (`--session-id or --session-ref is required`).

A later implementation must preserve the asymmetric validation in step 2 vs.
3 — it is not an oversight to "clean up."

## 2. `--json`, `--dry-run`, `--yes`: three flags, three different scopes

| Flag | Scope | Declared by |
| --- | --- | --- |
| `--json` | Global; forces JSON mode for every command's *successful* output, with the help-rendering carve-out in §5. | `cli-io.ts`, implicit for every command |
| `--dry-run` | Per-command opt-in preview flag. | `CommonOptionSpec.dryRun` (via `parseCommonOptions`) |
| `--yes` | Per-command opt-in confirmation flag. | `TokenizeSpec.booleanFlags`/`CommonOptionSpec.booleanFlags`, spelled `"yes"` |

`--yes` is not currently listed in `admin-cli-contract.md`'s "Common option
names" table even though it is accepted, with identical spelling and
identical "confirm the mutation" meaning, by every state-changing command
that uses the default-preview pattern in §3. Treat `--yes` as a common option
name with the same unknown-flag-rejection guarantees as every other flag in
that table (§ "Unknown options are hard errors" in `admin-cli-contract.md`
already covers the mechanism; this document adds `--yes` to the set of names
a later implementation must keep spelled exactly `--yes`, never `--force`
alone or `--confirm`, except where §3's third pattern layers an
action-scoped flag *in addition to* `--yes`/`--dry-run`).

`--dry-run` and `--yes` are never declared together on the same
`parseCommonOptions` call in the current codebase (they express two
different confirmation patterns — see §3) with one exception:
`tool-request run`/`tool-request grant`, which declares `dryRun: true`
*and* an action-scoped `--confirm-discard` boolean (not `--yes`) that gates
only the destructive `--on-changes discard` sub-path. A later implementation
must preserve that a command may compose more than one confirmation gate
(a whole-command preview flag plus a narrower per-action confirmation flag)
rather than assuming the two are mutually exclusive.

## 3. Confirmation and dry-run semantics: three current patterns

The acceptance bar is that **confirmation and dry-run semantics can never
silently perform an *unrecoverable or unreviewable* mutation** — a bare
invocation with no confirmation flag must do one of: refuse outright, only
preview, perform a mutation that is itself inherently safe (idempotent and
reversible, per Pattern B1 below), require operator-supplied content that
stands in for explicit review before any mutation runs (per Pattern B2
below), or execute a command whose exact content
was already explicitly, narrowly requested by the agent in a separate,
prior step and is only now being reviewed and run by the operator (Pattern D
below). "Silently perform the requested mutation" is prohibited only when
that mutation is *not* one of those exempted cases — Pattern B's
bare-invocation mutate and Pattern D's bare-invocation execution are the
documented exceptions, not violations of this bar: Pattern B1's mutation is
idempotent and reversible by construction (a recovery reset to a known-safe
`queued` state), Pattern B2's bare invocation is safe not because the
mutation itself is idempotent — it is not — but because the parser refuses
to run without operator-supplied content that stands in for review (see B2
below), and Pattern D's execution is not
"silent" in the relevant sense because the operator's own invocation of
`tool-request run`/`grant` *is* the point of review and approval for the
exact command an agent recorded earlier — there is no separate, still-earlier
operator-approval step it redeems; running it is the approval, applied to
content that was fixed and disclosed in advance rather than assembled fresh
from unreviewed input. The codebase satisfies this today with four distinct,
hand-rolled patterns rather than one shared abstraction; a later
implementation must classify every command it touches into one of these (or
an explicitly documented new one) rather than assume a single
`--yes`-means-confirm rule fits everything:

- **Pattern A — default-preview, opt-in mutate (`--yes` required to act).**
  Bare invocation only previews; nothing is written until `--yes` is passed.
  Used by `task clear-delay`, `worktree prune`, `worktree cleanup`,
  `worktree release-lock`, `worktree discard`, `review-lock release`. Some
  of these also accept `--force` to override a live-lock/dirty-worktree
  refusal, which is a distinct gate from `--yes` (see
  `admin-cli-contract.md`'s worktree descriptions): `--force` overrides a
  *safety refusal*, `--yes` confirms the *mutation itself*; both may be
  required together. `worktree cleanup` (`admin.ts:533-543`) is a
  representative multi-candidate instance of this pattern: it classifies
  every managed worktree as active/terminal/orphaned, previews the
  terminal/orphaned prune candidates by default, prunes them only with
  `--yes`, and separately requires `--force` to also remove a candidate
  that is dirty or has unpushed commits — the same two-gate shape as
  `worktree release-lock`/`worktree discard`, just applied to a batch of
  candidates instead of one target.
- **Pattern B — default-mutate, opt-in preview (`--dry-run` optional, no
  `--yes`).** Bare invocation mutates; `--dry-run` is an explicit opt-in to
  preview instead. Six commands share this flag shape, but not one
  rationale — grouping all six under "idempotent recovery reset" (as an
  earlier draft of this section did) is wrong for four of them. There are
  two sub-cases:
  - **B1 — idempotent recovery reset.** Used by `recover` and
    `recover-cap-handoff` — both reset already-broken tasks
    (failed/claimed/running, or capped) back to `queued`, an operation that
    is safe to repeat and does not destroy data, so requiring `--yes` up
    front would only add friction to a routine recovery action.
  - **B2 — default-mutate gated by required operator-supplied content,
    not by a confirmation flag.** Used by `task-assign`, `human-review-return`,
    `review-verification resolve`, and `github-app-review-return`
    (`admin.ts:4822`, `5691`, `6063`, `6613`). None of these are idempotent
    recovery resets — `human-review-return` in particular writes task
    context and enqueues an outbox message (`admin.ts:5852-5911`), a
    real, non-idempotent side effect each time it runs, not a reset to a
    known-safe state. What stands in for `--yes` here is that none of them
    has a truly content-free "bare" invocation: the parser itself refuses to
    run without operator-supplied specifics that amount to reviewing the
    mutation before it happens.
    - `human-review-return` requires exactly one of `--feedback`,
      `--feedback-file`, or `--feedback-source` (`parseHumanReviewReturnArgs`,
      `admin.ts:5303-5320`) — the operator must supply or explicitly select
      the feedback text being written, not just confirm an already-decided
      action.
    - `review-verification resolve` requires `--command` and `--exit-code`
      (`parseReviewVerificationResolveArgs`, `admin.ts:6033-6034`) — the
      operator must state the exact verification result being recorded.
    - `task-assign` requires at least one of `--profile`,
      `--implementation-agent`, `--review-agent`, or `--research-agent` to
      change anything, and separately refuses to touch a `claimed`/`running`
      task regardless of flags (per its `admin help task-assign` description),
      so it cannot silently reassign a task mid-execution.
    - `github-app-review-return` takes no content flags at all because it has
      no operator-supplied content to gate: its trigger is an external fact
      (an actual human `CHANGES_REQUESTED` review, detected via the GitHub
      App API and restricted to sessions using GitHub App auth —
      `admin.ts:6637-6644`), not an operator decision made at the CLI. A bare
      invocation only acts when that external review genuinely exists; there
      is nothing for a confirmation flag to gate that the detection check
      doesn't already gate.
    A later implementation must not describe B2 commands as fitting B1's
    "safe to repeat, resets to a known state" rationale, and must not assume
    it is safe to add a bare, content-free invocation to any of them — the
    required-content parse failure is doing the job `--yes` does elsewhere in
    this contract.
- **Pattern C — mandatory `--yes`, no preview mode at all.** The command
  refuses outright without `--yes`; there is no bare-invocation behavior
  that does anything, safe or otherwise. Used by `repo-lock force-release`
  — a rare, deliberately "big red button" operator action where even a
  silent no-op default would be confusing, so the command dies immediately
  with an instruction to inspect status first (`--yes is required to
  force-release a lock. Inspect with 'repo-lock status' first.`).
- **Pattern D — pre-authorized redemption, `--dry-run` optional, no `--yes`
  gate.** Used by `tool-request run` and its deprecated alias `tool-request
  grant` (`parseToolRequestGrantArgs`/`runToolRequestGrant`,
  `admin.ts:7831-7910`). This does not reduce to Pattern B: it shares
  Pattern B's shape (`--dry-run` supported, optional, no `--yes`) but its
  safety story is different, so it is called out separately. What "prior
  authorization" means here is easy to misstate, so be precise about it:
  the thing authorized *before* this invocation is the agent's stored Tool
  Request (a `command`/`requestedAt` record on the task, created earlier by
  the agent asking to run something outside its tool surface — issue
  #430) — **not** a separate, earlier `admin tool-request` grant/approval
  command. `tool-request run` is the single operator action that both mints
  the grant (`createToolRequestGrant`, `admin.ts` inside
  `runToolRequestGrant`) authorizing the agent's exact requested command
  (session + issue + phase + repo root + exact normalized command hash,
  one-shot, short-lived) **and**, on the same invocation, checks out the
  work branch and executes it — there is no separate prior `admin
  tool-request` authorization step to redeem; the operator reviewing the
  stored request and running `tool-request run` *is* the authorization.
  `--dry-run` **is** supported (`parseToolRequestGrantArgs` sets `dryRun:
  true` in its `parseCommonOptions` spec) and previews the resolved grant,
  target branch, and disposition — it returns (`emit({ ok: true, dryRun:
  true, ... })`) before the work-branch checkout and before the command
  executes, so `--dry-run` here is a real preview gate, not a no-op. What
  Pattern D actually lacks is a `--yes`-style confirmation gate on the
  bare, non-dry-run invocation: there is no flag an operator must pass
  (beyond just invoking the command) to make the already-reviewed command
  run. `--confirm-discard` (`admin.ts:409`) is a narrower, second gate
  layered *after* execution: it only governs one possible post-execution
  disposition (`--on-changes discard`, which reverts changes the
  already-run command produced) and does nothing to prevent the command
  itself from running. A later implementation must not describe
  `tool-request run`/`grant` as lacking `--dry-run` support, and must not
  describe its bare-invocation execution as "redeeming a separate prior
  admin command" — the grant is created and consumed within the same
  `tool-request run` invocation, and only the underlying agent-authored
  Tool Request record predates it (issue #301, issue #430).

The classification a new/extracted command uses is a product decision (how
destructive and how reversible the action is), not something this document
mandates case by case — but it must be recorded in that command's
`admin help <name>` description (every current command in Patterns A and C
already does this — see the `--yes` option descriptions in `admin.ts`'s
`COMMANDS` array) so an operator can tell which pattern applies without
reading source.

## 4. No interactive confirmation prompts outside `admin ui`

Every non-`ui` admin subcommand is designed to run unattended (the n8n
workflow, scripts, an operator's shell with piped input) and therefore
**never blocks on stdin for a y/n confirmation**. Confirmation is expressed
entirely through the flags in §2–§3, resolved once from `argv`, never through
a runtime prompt. This is why Patterns A–C exist as flag-driven gates rather
than "are you sure? [y/N]" prompts: a prompt would hang or silently read
garbage from a non-TTY stdin in automation.

`admin ui` is the sole exception, and only because it independently refuses
to run at all without a TTY (§6). Inside the interactive loop it uses
`@clack/prompts`' `confirm()` (`src/cli/admin-ui.ts:1117`) as a single
ergonomic gate in front of `runStateChange` (`admin-ui.ts:1171`), which then
runs whatever `argv` its caller built via `runAdminCommand`
(`admin-ui.ts:838`) unmodified — **`runAdminCommand` itself never appends
`--yes`, or any other flag, to the `argv` it receives.** Whether the
underlying non-interactive command still enforces its own Pattern A/B/C gate
after the Clack prompt is answered depends entirely on which argv builder
produced that `argv`, and the builders are not uniform:

- `buildLockReleaseArgv` (`admin-ui.ts:463-479`), used for the Pattern A
  `worktree release-lock` action, bakes `--yes` (and, for a live-lock
  force-release, `--force`) into the argv it returns — see the comment at
  `admin-ui.ts:464-467`. For this action the Clack confirm and the
  underlying command's own `--yes` gate are both satisfied, back to back.
- `buildRecoverArgv` and `buildCapResetArgv` (`admin-ui.ts:314-367`), used
  for the Pattern B `recover`/`recover-cap-handoff` actions, never include
  `--yes` — there is nothing for them to include, since Pattern B mutates on
  a bare invocation by design (§3). For these actions the Clack confirm is
  the *only* gate; the subprocess underneath would mutate with or without
  it.

A later implementation must not describe this as "the UI applies one common
non-interactive confirmation gate" — there is no such gate. The Clack prompt
is uniform operator ergonomics in front of `runStateChange`; whether a
*second*, flag-driven gate also applies underneath is a property of the
specific action's argv builder and its command's Pattern (A/B/C), not of the
UI layer itself.

## 5. Human vs. JSON output for success and each error class

Success and "safe no-op" both exit `0` and both flow through
`report()`/`emit()` (`cli-io.ts`), mode-dependent per
`admin-cli-contract.md`. Most failures, in most commands **except `admin
ui`**, flow through `die()`, which is dual-mode in the same way
(`{ ok: false, error }` on stdout in JSON mode, `error: <message>` on stderr
in human mode) and exits non-zero. This is not universal: a small,
pre-existing set of commands instead report a structured `{ ok: false, ...
}` payload through `report()`/`emit()` — the same renderer used for success
— and separately set `process.exitCode = 1`, falling through the rest of
the handler rather than throwing or calling `die()`. These are deliberate
structured-failure paths, not gaps to be normalized away:

- `admin task clear-delay` for an unknown task (`reason: "not_found"`) or a
  non-queued task (`reason: "active_task"`) — `report()` followed by
  `process.exitCode = 1` (`admin.ts:1522-1541`).
- `admin worktree cleanup` when one or more items are left unremoved after a
  run — `emit()` with `ok: errors.length === 0` followed by
  `process.exitCode = 1` (`admin.ts:3856-3875`).
- `admin worktree discard` when the worktree lock is held live and `--yes`
  was passed without `--force` — `report()` followed by
  `process.exitCode = 1` (`admin.ts:4207-4225`).

A later implementation must preserve each of these commands' existing
structured payload and human rendering exactly; it must not route them
through `die()` merely to make the failure-handling story uniform, and must
not assume every nonzero exit in the codebase carries `die()`'s
`{ ok: false, error }`/`error: ...` shape.

`admin ui`'s own failure paths are similarly excluded from the `die()`
guarantee and from the exit-code-`1`/output-shape claim below: its no-TTY
refusal and its Ctrl-C/Escape cancellation are nonzero exits that never
call `die()`, write plain text (or nothing) instead of the
`{ ok: false, error }`/`error: ...` shape, and use exit codes `2` and `130`
respectively rather than `1` — see §7 for the full, separate vocabulary
those two paths use. The codebase does **not** currently distinguish the
following failure classes, among the commands that do go through `die()`,
by exit code or output shape — they are all `die()` with its default code
of `1` — but they are worth naming separately because a later
implementation must not accidentally special-case one without updating this
document and its contract tests (§8):

- **Usage errors** — malformed `argv` the tokenizer itself catches: unknown
  `--flag`, a value flag missing its value, an unexpected positional. Caught
  by `tokenizeArgs` before any command-specific validation runs.
- **Validation errors** — a flag was recognized and had a well-formed value,
  but the value is semantically invalid for this command: a non-positive
  `--issue-number`, a `--phase` outside `VALID_PHASES`, an unresolvable
  `--session-ref`, a required flag simply absent (`--issue-number is
  required`). Caught by `parseCommonOptions`/command-specific parsers.
- **Operational errors** — parsing succeeded but the command failed against
  real state: a SQLite database that can't be opened, a `git`/`gh`
  subprocess failure, a lock held by another run, a GitHub/Gitea API error.
  Caught inside each command's handler body, typically in a `try`/`catch`
  around the operation, then routed to `die()` with a message describing
  what failed.
- **Unexpected errors** — anything that escapes a handler uncaught. Caught
  exactly once, at the top level: `main(process.argv.slice(2)).catch((err)
  => die(`Unexpected error: ${...}`))` (`admin.ts`, bottom of file). Because
  `main()` resolves the output mode as its first statement and every branch
  it dispatches to runs inside that same `async` call stack, a synchronous
  throw anywhere in a command handler is still caught by this wrapper — the
  only things that bypass it are handlers that call `process.exit()`
  directly instead of throwing or calling `die()` (currently only
  `admin ui`; see §6).

All four classes currently produce **exit code `1`** and the same
`{ ok: false, error }` / `error: ...` shape — this is a statement about
`die()`-routed failures only; it does not apply to `admin ui`'s `2`/`130`
exits, which are excluded above and covered separately in §7. `die()`'s
signature does accept
an explicit `code` parameter (`die(message, code = 1)`,
`src/cli/cli-io.ts:120`), but **no call site in the codebase passes a
non-default code today** — it is unused capability, not a hidden second exit
code. A later implementation that wants distinct exit codes per failure
class (e.g. to let scripts distinguish "you called it wrong" from "the
system is broken") may use this existing parameter, but doing so is an
observable behavior change requiring its own issue and its own test
coverage — it must not happen as an incidental side effect of moving a
command into a new module.

## 6. Help rendering and exit codes: root, resource, command, invalid

- **Root help** (`admin help` with no further argument, or `admin` with no
  subcommand at all): `formatHelpAll()` — human text, unconditionally,
  exit `0`. `--json` is a documented no-op here
  (`test/admin-cli.test.js:64-69` pins this: `admin help --json` still
  prints human text and is not valid JSON).
- **Command help** (`admin help <exact-registered-name>`, e.g. `admin help
  task-status`, or a compound name like `admin help "tool-request list"`):
  `formatHelpOne(cmd)` — human text, unconditionally, exit `0`, same
  `--json` no-op.
- **Resource-bare help** (`admin help <resource-token-alone>`, e.g.
  `admin help worktree` or `admin help tool-request`): there is no
  resource-summary page — `COMMANDS` never registers a bare resource token
  (`admin-command-registry-contract.md` §6) — so this is not a third
  rendering path, it falls straight into the next bucket.
- **Invalid help target** (`admin help <unregistered-name>`, including any
  bare resource token): `runHelp()` calls `die()`
  (`Unknown command: <target>. Run "admin help" to see available
  commands.`), exit `1`. Unlike the two successful-render paths above,
  **this path is mode-dependent, not always-human.** `main()` resolves the
  output mode from `HUMAN_DEFAULT_COMMANDS`, keyed on `argv[0]` (here,
  `"help"`), *before* `runHelp` runs; `"help"` is not a member of
  `HUMAN_DEFAULT_COMMANDS`, so the default mode for an invalid help lookup
  is **JSON**, not human text. Concretely, today: `admin.js help
  no-such-command` (no `--json` flag) exits `1` with
  `{"ok":false,"error":"Unknown command: no-such-command. ..."}` on
  **stdout**, not `error: ...` on stderr. This directly contradicts the
  intuitive reading of "`help` is always human-readable" from
  `admin-cli-contract.md`'s Help section — that statement is true only of
  `help`'s *successful* renders, not its failure path. This is current,
  verifiable behavior (`test/admin-cli.test.js:91-94` asserts only the exit
  code, not the output mode or stream), not a proposal, and it is exactly
  the kind of quirk `admin-command-registry-contract.md` §5 documented for
  `session preset`. A later implementation must either preserve this
  divergence explicitly or revise it in a change that is called out on its
  own — not silently normalized as part of a "cleaner" help rewrite.
- **Invalid top-level command / invalid resource action**: already fully
  specified in `admin-command-registry-contract.md` §5 (including the
  `session preset` output-mode anomaly); this document does not duplicate
  it.

## 7. `ui`'s intentional exit-code vocabulary

This section is the authoritative, more specific statement for `admin ui`
and **explicitly supersedes** `admin-cli-contract.md`'s "Exit codes" section,
which says "the only non-zero exit code is `1`." That baseline statement is
true of every other command's failure paths (§5) — both the `die()`-routed
ones and the `report()`/`emit()`-plus-`process.exitCode = 1` exceptions
enumerated there — but was never true of `admin ui`; `admin-cli-contract.md`
itself now cross-references this section rather than restating the blanket
claim. A later implementation must not treat the two documents as being in
unresolved conflict — this document's `2`/`130` vocabulary for `admin ui` is
the current, correct behavior, and the baseline's "only `1`" statement
applies to every other command.

`admin ui` owns a distinct `0`/`2`/`130` exit-code vocabulary for its own
normal-quit, non-TTY, and cancellation outcomes, bypassing
`die()`/`report()`/`emit()`'s shared exit-1 convention for two of those
three:

| Exit code | Meaning | Mechanism |
| --- | --- | --- |
| `0` | Operator quit the interactive loop normally. | `emit({ ok: true, exited: "ui" })` then falls off the end of `runAdminUi` (implicit `main()` success). |
| `2` | Invoked without a TTY on stdin *and* stdout. Refuses before touching sessions or the database. | `process.stdout.write(nonTtyHelp()); process.exit(2);` (`admin-ui.ts:1825-1828`) — an unconditional plain-text write, not mode-gated through `report()`. |
| `130` | Operator cancelled a Clack prompt (Ctrl-C / Escape). Conventional shell "128 + SIGINT" code. The cancelled prompt's own pending action is not carried out; the task store is closed before exit. | `clackCancel(...); process.stdin.pause(); process.exit(130);` (`admin-ui.ts:1891-1894`), from a `catch` on `UiCancelled`. |

The `130` row's "pending action is not carried out" guarantee is scoped to
*that* prompt, not to the UI session as a whole: `UiCancelled` can surface
from any `unwrap`-wrapped Clack prompt anywhere in the session, including
the final `pause()` confirmation `runStateChange` shows *after* it has
already run a mutating admin command (`admin-ui.ts:1171-1193` — `pause()` at
line 1192 is a `clackSelect` and is itself cancellable). Cancelling that
trailing pause aborts nothing: `runAdminCommand(argv)` (line 1185) already
ran to completion before the pause is ever shown, so the earlier mutation
stands. A later implementation must not describe `130` as "no task state is
mutated during the UI session" — only as "the specific action the cancelled
prompt was gating does not run."

None of these three call `die()`; `2` and `130` are direct `process.exit()`
calls, which is why §5's "unexpected errors are always caught by the
top-level `main().catch()` wrapper" caveat exists — `ui`'s exit paths never
reach that wrapper because they exit the process before `main()`'s promise
can settle. This vocabulary is **not** end-to-end, and the two remaining `die()`-routed
failure points straddle the non-TTY check rather than both preceding it.
`runAdminUi` parses argv first (`parseUiArgs`, `admin-ui.ts:1820-1821`), and
an argument-parsing error there (e.g. `admin ui --bad`) exits `1` via `die()`
before the non-TTY check ever runs. The non-TTY check itself
(`admin-ui.ts:1825-1828`) runs immediately after that parse and *before*
`resolveSessionIds` is called (`admin-ui.ts:1830-1835`) — not after, as a
naive reading of "session-resolution failures" might suggest. Concretely,
a piped (non-TTY) `admin ui --session-ref no-such-session` never reaches
`resolveSessionIds` at all: it exits `2` with `nonTtyHelp()` from the
non-TTY check, regardless of whether the given `--session-ref` would have
resolved. Only on an *interactive* invocation does an unresolvable
`--session-ref` reach `resolveSessionIds` and exit `1` via `die()`;
`--session-id` is never validated against the session registry there —
`resolveSessionIds` returns any nonempty `--session-id` verbatim
(`admin-ui.ts:776-780`) and only calls a resolver (`resolveSessionRef`) for
`--session-ref` (`admin-ui.ts:781-783`), so an unknown `--session-id` does
not fail at session resolution at all. A later implementation must preserve
exactly these three codes for
their three specific outcomes (not fold `2`/`130` into the generic `1`), and
must not route them through `die()` even if `die()` gains a second call site
passing an explicit code (§5) — but it must also preserve this exact
ordering (parse → non-TTY check → session resolution): moving
`resolveSessionIds` ahead of the non-TTY check would make it reachable
without a TTY, changing the exit code and adding session/DB access on a
path this contract requires stay TTY-free.

## 8. Transitional compatibility stubs/adapters for incremental migration

No commands move in this issue. When a later issue *does* begin extracting
resource modules out of `admin.ts` one command (or one resource) at a time,
it will need temporary forwarding code so the still-monolithic `main()`
if-chain and the newly-extracted module can coexist mid-migration. This
section bounds what that transitional code may do, since nothing like it
exists yet to observe directly:

- **Form.** A transitional adapter may only *forward* — it takes the same
  `argv` slice `main()` already computes for that command/resource today and
  calls into the extracted module's exported handler, or vice versa (an
  extracted module temporarily re-exporting a still-`admin.ts`-owned
  `runXxx` function so its own tests can call it without duplicating logic).
  It must not introduce new validation, new output shaping, or a new
  confirmation gate — those all remain owned by `admin-command.ts`/
  `cli-io.ts` per §1, unchanged by where the calling code physically lives.
- **Bound.** An adapter exists only for the specific command(s) mid-migration
  in that PR. It must not become a general-purpose "call an admin command by
  name" indirection layer that other code starts depending on — that would
  recreate the reverse-dependency risk `admin-command-registry-contract.md`
  §8 already warns against for `admin-ui.ts`'s subprocess dependency on
  `admin.js`.
- **Explicit removal criterion.** The adapter must be deleted in the same PR
  that completes the migration of the command(s) it forwards for — "same PR"
  meaning: once every caller of the old path has been repointed at the new
  module and the contract tests in §9 pass against the new module directly,
  the forwarding code has no remaining reason to exist and leaving it in
  place is scope creep, not caution. A migration PR that adds a stub but
  does not also delete it once its forwarding target is fully cut over must
  say so explicitly in its description and open a tracked follow-up — an
  adapter must never be left in place "just in case" past the migration that
  introduced it.
- **What must never live in a stub.** Exit codes (§5, §7), output shape
  (§5), help text (§6), and flag spelling (§2) are all pinned by this
  document and by `admin-cli-contract.md`/`admin-command-registry-contract.md`.
  A transitional adapter changing any of these — even temporarily, even
  "to make the new module's types cleaner" — is a behavior change requiring
  its own review, not an implementation detail of the migration.

## 9. Contract-test coverage a later implementation must add

None of the following exist today; a decomposition that touches this layer
must add them before or alongside the change so behavior preservation is
machine-checked:

1. **Global-flag-before-command-parser precedence** — a test on a
   representative value-flag command asserting a literal `--json` (or
   `--quiet`/`--verbose`) token is always consumed as a global flag, never
   as another flag's value, regardless of its position in `argv` (§1).
2. **`--session-id`/`--session-ref` precedence** — both given → error; only
   `--session-ref` given → resolved through the registry; only
   `--session-id` given → passed through unvalidated even for a
   nonexistent id; neither given on a session-required command → error
   (§1).
3. **`--yes` spelled consistently** — a test enumerating every command
   documented as Pattern A or C (§3) and asserting each accepts exactly
   `--yes` (not `--y`, `--confirm`, or `--force` alone) as its mutation gate.
4. **No silent mutation without confirmation, per pattern** — one test per
   Pattern A/B1/B2/C/D representative command: Pattern A/C commands must
   leave state unchanged on a bare invocation (and, for Pattern C, must
   refuse outright); the Pattern B1 representative (`recover`) must default
   to mutating (by design) and must not mutate when `--dry-run` is passed;
   a Pattern B2 representative (`human-review-return`) must refuse to run
   with none of `--feedback`/`--feedback-file`/`--feedback-source` supplied,
   and must not mutate when `--dry-run` is passed alongside a valid feedback
   source, pinning that its confirmation gate is required content, not
   `--yes`; the Pattern D representative (`tool-request run`, using a
   fixture authorization for an exact, harmless command) must execute on a
   bare invocation with no `--yes` involved, and separately must not mutate
   when `--dry-run` is passed, pinning that `--dry-run` is a real, supported
   preview gate here even though `--yes` is not (§3).
5. **`help`'s human-render carve-out vs. its `die()` divergence** — one test
   confirming `admin help` / `admin help <valid>` always render human text
   and ignore `--json` (already partially covered by
   `test/admin-cli.test.js:64-69`), and a *separate* test pinning today's
   actual `admin help <invalid>` behavior: JSON-shaped `{ ok: false, error
   }` on stdout by default (no `--json` flag needed), not stderr text —
   explicitly closing the gap left by `test/admin-cli.test.js:91-94`, which
   only asserts the exit code (§6).
6. **Error-class output-shape parity** — one test per class in §5 (usage,
   validation, operational, unexpected) asserting all four produce the
   identical `{ ok: false, error }` / `error: ...` shape and exit code `1`,
   so a decomposition can't accidentally special-case one class's shape or
   exit code without that being a visible, intentional diff.
7. **`die()`'s unused `code` parameter stays unused** — a test (or a
   lint/grep-based check) asserting no call site in `admin.ts`/`admin-ui.ts`
   passes a second argument to `die()`, so a future PR can't silently
   introduce a second exit code as a side effect of an unrelated change
   (§5).
8. **`ui`'s three exit codes** — a subprocess test per code: no TTY (piped
   stdio) → `2` with `nonTtyHelp()` text and no session/DB file touched;
   normal quit → `0` with `{ ok: true, exited: "ui" }`; a simulated
   cancellation → `130` (§7).
9. **Transitional-adapter absence** — once §8's first real migration lands,
   a test (or CI grep) asserting no forwarding/adapter code from a
   *completed* migration remains in the tree, so the removal criterion in
   §8 is enforced rather than aspirational.
