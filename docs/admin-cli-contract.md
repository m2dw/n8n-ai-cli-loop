# admin.js CLI output and option contract

This document defines the command-line contract for `dist/cli/admin.js` (issue
#308). The goal is a surface that operators can use by hand during recovery, cap
resets, task inspection, and diagnostics, while preserving the stable
machine-readable output that n8n workflows and scripts depend on.

## Output modes

Every command runs in exactly one output mode:

- **Human-readable** (default for operator-facing commands): concise text on
  stdout meant to be read by a person.
- **JSON** (default for machine/structured commands, or whenever `--json` is
  passed): a single stable JSON object on stdout.

`--json` always forces JSON, regardless of the command's default. The sole
exception is `help`, which always renders the human-readable help page and
ignores `--json` (see [Help](#help)).

### Why two defaults?

Some commands are primarily invoked by automation (the n8n parent/child
workflow, scripts). Changing their default stdout from JSON to text would break
those callers. Those commands therefore default to JSON. Operator-facing
inspection/recovery commands default to human-readable text because that is what
a person at a terminal wants.

To keep automation safe regardless of defaults, **machine-owned callers request
`--json` explicitly** (see "Machine call sites" below).

## Global options

These flags are accepted by every command except `help`, and may appear in any
position:

| Flag | Meaning |
| --- | --- |
| `--json` | Emit a stable structured JSON object on stdout. |
| `--quiet` | Suppress nonessential human text (headers, summaries). No effect in JSON mode. |
| `--verbose` | Include extra diagnostics in human output. No effect in JSON mode. |

## Streams

- **stdout** carries command results: human text or the JSON object.
- **stderr** carries warnings, progress, and human-mode error messages.
- In **JSON mode**, errors are written to **stdout** as `{ "ok": false, "error":
  "<message>" }` so machine callers that parse stdout keep working.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success, or a safe no-op (e.g. nothing to recover). |
| non-zero | A real failure: validation error, missing session, setup problem. |

Currently the only non-zero exit code is `1`. Any command that introduces a
distinct non-zero code must document it in its `admin help <command>` output.

## Common option names

Option names are consistent across commands:

| Option | Meaning |
| --- | --- |
| `--session-id <id>` | Canonical session identifier. |
| `--session-ref <ref>` | Short session reference (sessionId, sessionNo, or alias) resolved to a canonical sessionId. Mutually exclusive with `--session-id`. |
| `--issue-number <n>` | GitHub issue number. |
| `--context-id <id>` | Context record identifier. |
| `--phase <phase>` | Task phase: `implementation` \| `review` \| `conflict_resolution` \| `research` \| `planner`. |
| `--dry-run` | Preview the action without persisting changes (state-changing commands only). |
| `--db-path <path>` | Override the SQLite database path. |
| `--sessions-path <path>` | Override the `sessions.json` path. |

## Unknown options are hard errors

Every command rejects options it does not recognize. This is an operator-safety
guarantee, not cosmetic CLI polish (issue #401): a misspelled safety flag must
never turn a preview into a mutation.

- Unknown `--flags` exit non-zero. The error names the offending flag and, when
  one is a plausible typo, suggests the closest valid option (e.g.
  `Unknown option: --dry-ru (did you mean --dry-run?)`).
- Boolean flags (`--dry-run`, `--yes`, `--all`, …) are recognized only by their
  exact spelling. A `--dry-run` typo such as `--dry-ru`, `--dryrun`, or
  `--dry_run` exits non-zero and performs no mutation — it is **never** silently
  ignored, on any command, including commands that do not support `--dry-run`.
- Value flags require a following value and reject another `--flag` as that value
  (`--session-id requires a value`).
- Non-option positional arguments are rejected unless a command explicitly
  supports them.

The validation runs in the shared parser (`tokenizeArgs` /
`parseCommonOptions` in `src/cli/admin-command.ts`) before any database, git,
GitHub/Gitea, or filesystem mutation, so an unrecognized option fails fast. The
same parser is reused by the non-admin CLI entrypoints (`enqueue-task`,
`github-intake`, `run-one-phase`, `dispatch-outbox`, `issue-plan`,
`issue-discuss`) so the contract holds across every command-line surface.

## Help

- `admin help` lists every command plus the global options and explains the
  two defaults and when to use `--json`.
- `admin help <command>` shows that command's options and a one-line note about
  its default output mode.

`help` is always human-readable: it ignores `--json` and the other global flags
because its purpose is to be read by a person at a terminal.

## Command classification

### Operator-facing (human-readable by default)

These print text by default and JSON with `--json`:

- `status` (worktree-aware: joins task, branch, PR, lock, and worktree state)
- `task-status`
- `list-stuck`
- `recover`
- `recover-cap-handoff`

Examples:

```sh
# Human-readable summary (default)
node dist/cli/admin.js task-status --session-ref 1 --issue-number 302

# Stable structured JSON
node dist/cli/admin.js task-status --session-ref 1 --issue-number 302 --json

# Human-readable planned action
node dist/cli/admin.js recover-cap-handoff --session-ref 1 --issue-number 302 --dry-run
```

### Machine/structured (JSON by default)

These default to JSON to preserve existing automation stdout contracts. They
still accept the global flags; `--json` is the default and an explicit no-op.
This set includes `context create`, `repo-lock acquire|release|status|
force-release`, `session-doctor`, `session-init`, `quarantine`, `worktree
list|prune`, `task-assign`, `tool-request`, `human-review-return`,
`github-app-review-return`, and `issue-discuss`. Operator-facing human rendering is rolled out to these commands
incrementally; the recovery/inspection commands above are the representative
first wave.

## Machine call sites

The n8n parent workflow (generated by
`scripts/build-parent-child-workflow.mjs`) parses `admin.js` stdout as JSON in
three nodes. Each passes `--json` explicitly so the `JSON.parse()` downstream
stays stable even if the command's default mode ever changes:

- **Create Context** → `admin.js context create --json ...`
- **Acquire Repo Lock** → `admin.js repo-lock acquire --json ...`
- **Release Repo Lock** (success and error paths) → `admin.js repo-lock release --json ...`

When adding a new machine-owned call that parses stdout, pass `--json`.

## Shared command framework (issue #309)

Common option parsing, session resolution, and output handling are implemented
once and reused rather than re-derived per command:

- `src/cli/admin-command.ts` provides the shared option layer: argv tokenizing,
  the `--session-id`/`--session-ref` selector, `--issue-number`/`--phase`
  validation, and `--dry-run`. A command declares what it needs via a
  `CommonOptionSpec` (e.g. `{ session: "required", issueNumber: "optional" }`)
  and gets back validated, typed options.
- `src/cli/cli-io.ts` provides the shared output layer: `emit`/`report`/`die`
  honour the resolved output mode so results, warnings, and errors land on the
  correct stream consistently.

Because session resolution is centralized, **every session-scoped command —
including the Tool Request commands (`tool-request list|resolve|grant`) — accepts
`--session-ref`** as an alternative to `--session-id`, resolved through the same
session registry. This removes the earlier inconsistency where Tool Request
commands accepted only `--session-id`.

Commands are migrated to this framework incrementally; `task-status`,
`recover-cap-handoff`, and the `tool-request` commands are the first wave.

## Migration notes

- Machine-owned calls request `--json` *before* any default changes, so the JSON
  stdout contract is never silently broken.
- Generated workflow definitions and their tests are updated together with any
  default change (see `test/build-parent-child-workflow.test.js`).
- Recovery behavior is unchanged; this contract only standardizes formatting and
  option handling.
