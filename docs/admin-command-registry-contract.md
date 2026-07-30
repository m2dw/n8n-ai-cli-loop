# admin command registry and dispatch contract

This document specifies the behavior-preserving contract for how `admin.js`
(and the small family of CLI entrypoints alongside it) discovers, classifies,
and dispatches commands (issue #708). It extracts and reconciles only the
registry/dispatch slice of the broader decomposition attempted in #612, which
hit the review cycle cap. PR #707 is prior-attempt research material; where
anything below differs from it, this document — reconciled against the
current `src/cli/admin.ts`, `src/cli/admin-command.ts`, and their tests — is
authoritative. **This is a documentation-only issue: no production code is
refactored here.**

See also [`admin-cli-contract.md`](admin-cli-contract.md) for the output-mode,
exit-code, and option-validation contract. This document covers what happens
*before* a command's own option parsing runs: how `admin.js` decides which
command you invoked at all.

## 1. Two kinds of external admin surface

There are two distinct things a user can type on the command line that
`admin help` will show them, and they are not the same:

1. **Dispatchable commands** — a subcommand string that `src/cli/admin.ts`'s
   `main()` recognizes and executes in-process (e.g. `admin.js task-status`,
   `admin.js tool-request run`).
2. **Catalog-only external entrypoints** — a *separate* compiled script under
   `dist/cli/`, invoked directly by path (e.g. `node dist/cli/github-intake.js
   ...`). All four (`github-intake`, `enqueue-task`, `run-one-phase`,
   `dispatch-outbox`) begin with a `#!/usr/bin/env node` shebang, so each is
   independently executable. Three of the four (`github-intake`,
   `run-one-phase`, `dispatch-outbox`) also have their own `isMain` /
   `fileURLToPath(import.meta.url) === process.argv[1]` guard, so requiring
   the module is import-safe. `enqueue-task.ts` is the exception: despite
   having the shebang, it ends with an unconditional `main().catch(...)` and
   has no such guard, so importing it (rather than executing it as a script)
   runs `main()` as a side effect. `admin.js` never dispatches to any of
   these four; it only *lists* them in `admin help` (via a
   `CommandInfo.entrypoint` field) so operators can discover them from one
   place.

`main()`'s dispatch is a single `if (subcommand === "...")` chain over
`argv[0]` (and, for compound commands, `argv[1]`/`argv[2]`); it has no branch
for `github-intake`, `enqueue-task`, `run-one-phase`, or `dispatch-outbox` —
running `admin.js github-intake` falls through to the final
`die("Unknown command: github-intake...")`. Only the standalone scripts
answer to those names.

## 2. Full command classification

Every current external admin entrypoint falls into exactly one of these
buckets:

### 2.1 Catalog-only external entrypoints (not dispatchable through `admin.js`)

Each is listed in `admin help` via `CommandInfo.entrypoint` and never matched
by `main()`. All four have their own `#!/usr/bin/env node` shebang, making
each independently executable; three of the four also have their own
`isMain` guard, making them import-safe. `enqueue-task` has the shebang but
lacks the guard — see the caveat below:

| Name (as cataloged) | Script | Has `isMain` guard? |
| --- | --- | --- |
| `github-intake` | `dist/cli/github-intake.js` | Yes |
| `enqueue-task` | `dist/cli/enqueue-task.js` | **No** — ends with unconditional `main().catch(...)` |
| `run-one-phase` | `dist/cli/run-one-phase.js` | Yes |
| `dispatch-outbox` | `dist/cli/dispatch-outbox.js` | Yes |

Because `enqueue-task.ts` lacks the guard, importing that module (as opposed
to executing `dist/cli/enqueue-task.js` directly) runs `main()` as a side
effect. Any later decomposition that touches shared code paths must not
start importing `enqueue-task.ts` from another module without first adding
the same `isMain` guard the other three entrypoints already have — otherwise
it would change `enqueue-task`'s current behavior.

### 2.2 Public, dispatchable commands (registered in `COMMANDS` and in `main()`)

Everything else in the `COMMANDS` array (`src/cli/admin.ts:139-685`) that
lacks an `entrypoint` field is dispatched in-process by `main()`: `help`,
`ui`, `status`, `task-status`, `list-stuck`, `recover`, `recover-cap-handoff`,
`task clear-delay`, `task-assign`, `human-review-return`,
`github-app-review-return`, `review-verification resolve`, `tool-request
list`, `tool-request resolve`, `tool-request run`, `context create`,
`session-doctor`, `context-mode status`, `repo-lock acquire`, `repo-lock
release`, `repo-lock status`, `repo-lock force-release`,
`worktree list`, `worktree prune`, `worktree recovery`,
`worktree cleanup`, `worktree release-lock`, `worktree discard`, `review-lock
status`, `review-lock release`, `session-init`, `issue-discuss preview`,
`issue-plan preview`, `issue-plan ai-preview`, `issue-plan evaluate-history`,
`issue-discuss post`, `interventions`.

### 2.3 Deprecated alias

`tool-request grant` is a **deprecated alias for `tool-request run`** (issue
#430 retired "grant" from the operator surface in favor of the guided run,
but did not remove it). Both dispatch to the same handler,
`runToolRequestGrant(argv, surface)`, differing only in the `surface`
argument (`"run"` vs. the default `"grant"`), which is recorded as
`actionLabel` (`"guided-run"` vs. `"grant"`) in the stored operator-response
record — so historical resolutions remain distinguishable by which name was
used to invoke them. `tool-request grant` must keep working identically to
`tool-request run` (same preconditions, same disposition semantics); it is
not scheduled for removal by this issue.

### 2.4 Hidden (dispatchable, but absent from the registry/help)

`session preset list` and `session preset show` are fully dispatchable —
`main()` has a `subcommand === "session"` → `action === "preset"` →
`presetAction === "list" | "show"` branch — but **no `COMMANDS` entry exists
for them**, so they never appear in `admin help` or in `admin help <command>`
lookups. This is not flagged in code as intentional (no "hidden" comment),
but it is the current, tested behavior (`test/admin-session-preset.test.js`
exercises the commands functionally; no test asserts their help visibility
either way) and must be preserved as-is unless a future issue explicitly
changes it.

No other dispatchable command is missing a `COMMANDS` entry; no `COMMANDS`
entry (other than the four catalog-only ones) lacks a dispatch branch.

## 3. Command identity: single-token vs. compound

A command's identity is the exact sequence of leading `argv` tokens
`main()` consumes to select a handler; everything after that is options.
There are two shapes:

- **Single-token identity**: `argv[0]` alone is the whole command name, and
  every subsequent token is an option/value. Current single-token commands:
  `help`, `ui`, `status`, `task-status`, `list-stuck`, `recover`,
  `recover-cap-handoff`, `task-assign`, `human-review-return`,
  `github-app-review-return`, `session-doctor`, `session-init`,
  `interventions`.
- **Compound identity**: `argv[0]` is a *resource* token that requires an
  exact `argv[1]` *action* token to complete the identity (and, for exactly
  one resource, a third token). Current resource tokens and their actions:

  | Resource (`argv[0]`) | Actions (`argv[1]`, and `argv[2]` where noted) |
  | --- | --- |
  | `task` | `clear-delay` |
  | `tool-request` | `list` \| `resolve` \| `run` \| `grant` (deprecated alias) |
  | `context` | `create` |
  | `repo-lock` | `acquire` \| `release` \| `status` \| `force-release` |
  | `review-lock` | `status` \| `release` |
  | `worktree` | `list` \| `prune` \| `recovery` \| `cleanup` \| `release-lock` \| `discard` |
  | `session` | `preset` (hidden), then a required 3rd token: `list` \| `show` |
  | `context-mode` | `status` |
  | `issue-plan` | `preview` \| `ai-preview` \| `evaluate-history` |
  | `issue-discuss` | `preview` \| `post` |
  | `review-verification` | `resolve` |

The compound command's *name* as registered/documented (`CommandInfo.name`,
e.g. `"tool-request list"`, `"task clear-delay"`) is the resource and action
tokens joined by a single space; this is also the exact string `admin help
<name>` must be given to find it (see §5).

## 4. Dispatch matching is deterministic because resource and single-token identities never collide

`main()` matches tokens by **exact string equality only** — there is no
substring/abbreviation matching (e.g. `admin.js stat` does not match
`status`) and no numeric prefix-length heuristic. The "longest match wins"
property comes entirely from the two-level (occasionally three-level)
resource/action structure: the set of resource tokens in §3 and the set of
single-token command names are **disjoint** —no string is both a complete
single-token command and a resource token requiring more tokens (e.g. `task`
vs. `task-assign` vs. `task-status` are three distinct, non-overlapping
`argv[0]` values; `session` vs. `session-doctor` vs. `session-init`
likewise). Because of that disjointness, there is never a genuine ambiguity
between "this is the whole command" and "this is a resource that needs more
tokens" — the resource/single-token partition is a closed, enumerable
invariant, not something resolved by trying progressively shorter prefixes at
runtime. A later implementation must preserve this disjointness: adding a new
single-token command whose name collides with an existing resource token (or
vice versa) would make the dispatch key ambiguous and is not permitted
without an explicit compatibility decision.

## 5. Invalid or incomplete compound command handling

When a resource token is recognized but the following action token is
missing or unrecognized, `main()` calls `die()` with a message of the form
`` Unknown <resource> action: <action | "(none)">. Expected: <list>`` and
exits non-zero (`die`'s default code is `1`; nothing in this dispatch layer
overrides it). `die` is typed `never` (it calls `process.exit`), so the
missing `return` statements after some of these `die()` calls (e.g. the
`task` branch) are safe — execution never falls through to a later `if`
block.

An unrecognized top-level `subcommand` (no matching single-token command and
no matching resource token) falls through the entire chain to the final
`die(`Unknown command: ${subcommand}. Run "admin help" to see available
commands.`)`.

**Output mode for these errors is not uniform** — it is decided *before*
dispatch runs, by the same `HUMAN_DEFAULT_COMMANDS` lookup used for
successful commands (see `admin-cli-contract.md`), keyed on `argv[0]` alone
or on `` `${argv[0]} ${argv[1]}` `` when both are present:

- **General case (JSON)**: for every resource above except `session`, the
  bare resource token (`argv[0]` alone) and the two-token key formed from an
  *invalid* action are never present in `HUMAN_DEFAULT_COMMANDS`, so the
  default output mode is JSON. E.g. `admin.js tool-request bogus` exits 1
  with `{"ok":false,"error":"Unknown tool-request action: bogus. Expected:
  list | resolve | run | grant"}` on stdout.
- **`session preset` is the one exception**: `HUMAN_DEFAULT_COMMANDS`
  contains the literal two-token key `"session preset"` (added for issue
  #513 to cover both `list` and `show` under one default). That key is
  matched as soon as `argv[0] === "session"` and `argv[1] === "preset"`,
  **before** the code even checks whether a valid third token (`list`/`show`)
  was supplied. So `admin.js session preset` (with no third token, or an
  invalid one) resolves to **human-readable** mode: `die()` writes `error:
  Unknown session preset action: (none). Expected: list | show` to **stderr**
  (not stdout JSON) and exits 1 — different from every other incomplete
  compound command. This is current, verifiable behavior (not a proposal) and
  must be preserved or explicitly and visibly changed, not silently
  "normalized" by a future refactor.

Every `die()` reachable from dispatch exits with code `1`; there is currently
no distinct non-zero exit code assigned to "invalid command" vs. "invalid
action" vs. any other command's internal validation failure.

## 6. Help visibility is independent of dispatchability

`admin help` (`formatHelpAll`) lists exactly the `COMMANDS` array, in
declaration order, including the four catalog-only entrypoints. `admin help
<name>` (`formatHelpOne`, via `runHelp`) does an **exact string match** of
the joined argument against `CommandInfo.name` (`COMMANDS.find((c) => c.name
=== target)`) — no prefix or fuzzy matching, and no synthesis of a "resource
summary" page. Consequences worth stating explicitly because they are easy
to get backwards:

- A command can be **visible but not dispatchable**: all four catalog-only
  entrypoints appear in `admin help`'s command list (and `admin help
  github-intake` etc. show their options), but `admin.js github-intake ...`
  itself dies with "Unknown command."
- A command can be **dispatchable but not visible**: `session preset list`
  and `session preset show` (§2.4) work when invoked, but do not appear in
  `admin help`'s listing, and `admin help session preset list` (or any
  variant) dies with "Unknown command" because no matching `CommandInfo`
  exists.
- Bare resource names have no help page of their own: `admin help
  tool-request` or `admin help worktree` die with "Unknown command", because
  `COMMANDS` never registers a resource token alone — only its full compound
  names (`"tool-request list"`, `"worktree list"`, etc.). Operators must
  already know (or discover via `admin help` with no arguments) the exact
  compound name to look up.

## 7. Preservation guarantees

A later implementation of this contract (a real registry/dispatcher
decomposition) must preserve, byte-for-byte where machine-readable:

- Every command name in §2.2 and every hidden command in §2.4, spelled
  exactly as today (including the space-joined compound names).
- The `tool-request grant` / `tool-request run` alias relationship,
  including the `"grant"` vs. `"guided-run"` `actionLabel` recorded in
  stored operator-response data.
- All four catalog-only entrypoint names and their scripts.
- Every current exit code: `0` for success/no-op, `1` for every documented
  failure path in this document (unknown command, unknown action, missing
  action).
- Every current `{ ok: false, error: "..." }` JSON error shape and the exact
  wording of "Unknown command: ...", "Unknown `<resource>` action: ...
  Expected: ...", including the literal `(none)` placeholder when the action
  token is absent — scripts and operators may already pattern-match on this
  text.
- The output-mode-before-validation ordering in §5, including the `session
  preset` anomaly, unless a future issue explicitly revises it (in which case
  the revision must be called out, not silently absorbed into a "cleaner"
  general rule).

## 8. Registry ownership and dependency direction

Today, both halves of the registry — the `COMMANDS: CommandInfo[]` array
(catalog/help data) and the `main()` if-chain (dispatch behavior) — live
together in `src/cli/admin.ts`, the top-level dispatcher itself. `admin.ts`
imports handler logic *from* resource/domain modules (`src/core/*`,
`src/handlers/*`, `src/stores/*`, `src/providers/*`, and the small CLI helper
modules `admin-command.ts`, `cli-io.ts`, `admin-ui.ts`,
`issue-discuss.ts`, `issue-plan*.ts`, `pr-review-reader.ts`,
`context-mode-status.ts`); none of those modules *imports* `admin.ts` at the
module level (verified: no source file outside `src/cli/admin.ts` itself has
a static/dynamic `import` of `cli/admin`).

`admin-ui.ts` is the one exception to "no reverse dependency," and it is a
*runtime subprocess* dependency rather than an import cycle. `adminEntrypoint()`
(src/cli/admin-ui.ts:824-826) builds the path to the compiled `admin.js` as a
sibling of the compiled `admin-ui.js` (`join(dirname(fileURLToPath(import.meta.url)),
"admin.js")`), and `runAdminCommand()` (src/cli/admin-ui.ts:838-848) spawns it
via `execFileSync` for every state-changing action the interactive `admin ui`
screens offer — including the worktree-lock recovery actions. This is a
*build-layout* dependency, not a TypeScript import: `admin-ui.ts` never
imports symbols from `admin.ts`, it only assumes the two files still compile
to siblings on disk and that `admin.js` remains invocable as a Node
entrypoint with the same argv-in/stdout+exit-code-out contract described
in §3–§7. A decomposition that renames, moves, or splits `admin.ts` into a
directory of resource modules must either keep a `admin.js` (or equivalent)
sibling entrypoint at that same relative path, or update
`adminEntrypoint()`/`runAdminCommand()` in lockstep — otherwise every `admin
ui` action that shells out (including lock-recovery flows) breaks silently
at runtime with no compile-time signal, since nothing type-checks the path
string or the subprocess's behavior.

Apart from that one runtime edge, the one-directional dependency — dispatcher
depends on resource modules, never the reverse — is the invariant to
preserve.

Because `COMMANDS` and the dispatch chain are two separately hand-maintained
structures in the same file, keeping them in sync is currently a manual
discipline rather than a structural guarantee — the `session preset` gap in
§2.4 is a live example of them drifting apart. Any future decomposition (out
of scope for this issue) that splits command registration per resource
module must keep the same direction: a resource module (e.g. a hypothetical
`src/cli/commands/tool-request.ts`) may export its own command metadata and
handler functions for the top-level dispatcher to collect, but it must never
import the top-level dispatcher (`admin.ts` or its successor) to register
itself — registration is always pulled inward by the dispatcher, never
pushed outward by a resource module reaching back into it. A resource module
depending on the dispatcher would create the exact import cycle the current
single-file layout accidentally avoids by not being decomposed at all.

## 9. Compatibility and regression tests required for a later implementation

None of the following exist today; a later implementation task must add
them before or alongside any registry/dispatch refactor so behavior
preservation is machine-checked, not just asserted in review:

1. **Full classification snapshot** — one test enumerating every entry in
   §2 (dispatchable, catalog-only, alias, hidden) and asserting each is
   still classified the same way (dispatch succeeds/fails as expected;
   `admin help` includes/excludes it as expected). This is the test that
   would have caught the `session preset` help-visibility gap immediately.
2. **`session preset` help-invisibility** — assert `admin help` output does
   *not* contain `session preset`, and `admin help session preset list`
   (and `show`) exit non-zero with "Unknown command" — pinning §2.4/§6
   explicitly, since no current test checks this either way.
3. **`session preset` incomplete-command output mode** — assert `admin.js
   session preset` (no third token) exits 1 with a **stderr** `error: ...`
   message and **empty/non-JSON stdout**, distinguishing it from every other
   resource's incomplete-command case (which must assert the opposite:
   JSON-shaped `{ ok: false, error }` on stdout). This directly pins the §5
   anomaly.
4. **Resource/single-token disjointness invariant** — a test that computes
   the set of registered resource tokens and single-token command names
   (including the hidden `session` resource) and asserts they never
   intersect, so the deterministic-dispatch argument in §4 stays true as
   commands are added.
5. **Catalog-only entrypoints are not dispatchable** — assert `admin.js
   github-intake`, `admin.js enqueue-task`, `admin.js run-one-phase`, and
   `admin.js dispatch-outbox` each exit non-zero with "Unknown command",
   while `admin help` still lists all four (currently covered only
   partially — existing help tests assert visibility but not
   non-dispatchability).
6. **`tool-request grant`/`tool-request run` alias parity** — a test that
   drives the same scenario through both command names and asserts
   identical resulting state except for the recorded `actionLabel`
   (`"grant"` vs. `"guided-run"`).
7. **Exact error message text for every "Unknown `<resource>` action"
   branch** — one test per resource (`task`, `tool-request`, `context`,
   `repo-lock`, `review-lock`, `worktree`, `session preset`,
   `context-mode`, `issue-plan`, `issue-discuss`, `review-verification`)
   asserting the exact `Expected: ...` list text, so a refactor can't
   silently drop or reorder an action from the message.
8. **`admin help <bare-resource>` misses** — assert `admin help
   tool-request`, `admin help worktree`, etc. (any registered resource token
   given alone) exit non-zero with "Unknown command", pinning the "no
   resource-summary help page" rule in §6.
9. **`admin-ui` subprocess entrypoint** — assert `adminEntrypoint()` still
   resolves to a sibling `admin.js` next to the compiled `admin-ui.js`, and
   that at least one `runAdminCommand()`-driven UI action (e.g. a
   worktree-lock recovery action) round-trips through the real compiled
   `admin.js` and observes its exit code/stdout contract, so a future
   decomposition can't silently break `admin ui`'s only production
   dependency on the dispatcher (§8).
