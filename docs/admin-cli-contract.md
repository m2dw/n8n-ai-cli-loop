# admin.js CLI output and option contract

This document defines the command-line contract for `dist/cli/admin.js` (issue
#308). The goal is a surface that operators can use by hand during recovery, cap
resets, task inspection, and diagnostics, while preserving the stable
machine-readable output that n8n workflows and scripts depend on.

For how `admin.js` decides *which* command you invoked in the first place —
catalog-only entrypoints vs. dispatchable commands, aliases, hidden commands,
compound-command matching, and invalid/incomplete command handling — see
[`admin-command-registry-contract.md`](admin-command-registry-contract.md).

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

Currently the only non-zero exit code shared across `die()`-routed commands
is `1`. `admin ui` is an existing, intentional exception to this, but only
for its own normal-quit, non-TTY, and cancellation outcomes: those three
paths own a separate `0`/`2`/`130` exit-code vocabulary and bypass `die()`
entirely. `admin ui` does **not** bypass `die()` end-to-end — argument
parsing errors (e.g. `admin ui --bad`) still go through `die()` and exit `1`
like every other command, and this happens before the non-TTY check runs.
The non-TTY check itself runs *before* session resolution: a non-interactive
invocation (e.g. `printf '' | admin ui --session-ref no-such-session`) exits
`2` from the non-TTY path without ever calling `resolveSessionIds`, so a
session-resolution failure can only reach `die()` and exit `1` on an
interactive (TTY) invocation — see
[`admin-cli-parsing-contract.md`](admin-cli-parsing-contract.md) §7 for the
full specification. Any other command that introduces a distinct non-zero
code must document it in its `admin help <command>` output.

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
`issue-discuss`) so the contract holds across every command-line surface —
with standing, pre-existing exceptions: `admin worktree prune` hand-rolls its
own argv scan and silently accepts (and discards) an unrecognized flag rather
than rejecting it, and `admin worktree cleanup`/`release-lock`/`discard` and
`admin review-lock status`/`release` hand-roll a second parser
(`parseStrictArgs`) that does reject unrecognized flags but — unlike this
section's "reject another `--flag` as that value" claim — will consume a
following `--flag` token as a value flag's value instead of rejecting it. See
[`admin-cli-parsing-contract.md`](admin-cli-parsing-contract.md) §1
("Pre-existing exceptions: commands that bypass the shared parser") for the
specifics; a later implementation must close these gaps rather than assume
this section already describes the affected commands' current behavior.

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
- `dispute status` (review-dispute protocol state for one task; read-only)
- `dispute reopen` (the §6.4 reopen request; previews by default, applies with
  `--yes`)
- `dispute metrics` (session-scoped review-dispute counts derived from the
  persisted `review.dispute.transition` events; read-only, offline, and never
  a quality gate — see [review-dispute-operations.md](review-dispute-operations.md))
- `n8n deploy` (generates one session's workflow artifacts and imports them into
  a local n8n; previews by default, applies with `--yes`, publishes only with an
  explicit `--publish`, and restores an already active parent after the import so
  a re-deploy never deactivates one. An apply serializes on two locks: one scoped
  to the parent workflow and held for the whole run, so two deploys of the same
  session cannot lose each other's activation decision, and one scoped to the
  shared child workflow and held across generation and the child import, so two
  deploys of *different* sessions cannot import each other's child artifact. A run
  refused on either reports `ok: false` with a `failure` that carries no `step`,
  since nothing ran. Any run that started a command writing
  the n8n database reports `restartRequired: true`: a running n8n must be
  restarted before what was imported — including the parent's active state —
  takes effect. A run whose n8n binary never started reports
  `restartRequired: false`. See
  [install.md](install.md#7-generate-and-import-the-n8n-workflows))
- `issue suspend` / `issue activate` (issue #787): remove/restore the
  execution labels (`status:*`/`agent:*`) that gate `github-intake` pickup for
  one or more Issues, resolved from session/flow configuration rather than a
  hard-coded agent or phase. `suspend` records exactly which labels it
  removed; `activate` restores only that recorded set — never a freshly
  resolved bundle — and is a safe no-op when nothing is suspended. Preview by
  default; pass `--yes` to apply.
- `chain list` / `chain show` / `chain validate` (issue #789): read-only
  inspection and validation of the dependency-chain registry (#788). `list`
  and `show` read the registry alone; `validate` additionally fetches GitHub
  Issue Relationships for a chain's members and reports structural problems
  in the observed graph (#890), drift against the graph on record, whether
  the accepted revision is current, and frozen-prefix conflicts (#891) — all
  without writing anything back to the registry or to GitHub. Per-member
  provider fetch failures are reported separately from structural findings.
- `chain sync` (issue #892): the mutating counterpart to `chain validate` —
  the explicit way GitHub Issue Relationship changes are imported into the
  registry. Takes a `<chain-ref>` or `--all`; previews by default, applies
  with `--yes`. GitHub stays the dependency truth and the import is one-way:
  the command never writes a GitHub comment, label, or relationship. A chain
  whose observed graph passes #890's rules and contradicts no frozen
  dependency prefix (#891) has its graph, revision, fingerprint, and
  accepted-revision pointer advanced as one atomic step (via #890's acceptance
  service) and records `in_sync` sync metadata. Any import problem — a cycle,
  an inaccessible member, an ambiguous identity, a duplicate claim, a
  frozen-prefix conflict, or a chain that moved mid-run — is refused with the
  expected and observed edges plus a remediation direction, exits nonzero, and
  leaves the previously accepted graph exactly as it was. Transient provider
  failures are distinguished from structural graph failures (`failure.kind`
  and `failure.transient`), and only the failures that actually judged the
  graph record `error` sync metadata; a provider outage or a lost
  compare-and-set records nothing. `--all` checks every chain independently
  and reports every failure in one run.

  Two guarantees hold against a concurrent run. The frozen prefixes are
  re-read inside the transaction that moves the accepted pointer, not only when
  the plan is drawn up, so a task that starts at any point while the command
  runs refuses the import rather than having its pinned dependencies
  overwritten by it (freezing a prefix moves no chain row, so no
  compare-and-set can catch that on its own, and a check taken just before the
  write is still a read the write cannot bind). And every sync-metadata write
  carries the row revision its verdict was
  reached about, so a slower run cannot stamp `in_sync` over the `error`
  another run has already recorded about a newer graph; the outcome still
  stands and the lost write is reported as `followUpFailure`.

- `chain new` / `chain append` / `chain prepend` (issue #791): the linear
  construction commands, and the only ones that write BOTH sides — the GitHub
  Issue Relationships the runner acts on and the registry graph that mirrors
  them. `new <issue[,issue...]> [name]` links the Issues in the order given
  (`10,11,12` means #10 blocks #11 blocks #12), makes the last one the head the
  stable chain ID is derived from, and registers the optional `[name]` as an
  operator alias — refused up front if a chain or alias already occupies it,
  since the two share one namespace (#788). The name is registered by the same
  registry transaction that allocates the chain ID, so a chain is created with
  its name or not created at all. `append` extends past the head and
  moves it; `prepend` extends ahead of the chain's single root and leaves the
  head where it is. Both accept unregistered Issues. An Issue named twice in one
  list (`10,11,10`) is rejected outright rather than collapsed: the list is a
  dependency *sequence*, so a repeat describes a reorder or a cycle, not the
  same request twice. Anything that is not a
  straight line — an Issue already owned by another chain (a merge), an Issue
  already in this chain (a reorder), a head that already blocks something, a
  chain with several roots, a chain that forks or merges anywhere within itself
  or falls into disconnected runs — is refused with a pointer to the advanced
  operations in #893 rather than guessed at. The last two are checked on the
  chain being extended, by counting degrees and starting points, before the
  extended graph is built: the registry accepts any DAG, so a branched chain can
  perfectly well have a head that blocks nothing, and extending it would grow a
  topology these commands cannot express. "A head that already blocks something"
  is judged against GitHub as well as the registry: an Issue outside every chain
  that the head blocks is a live fork the registry cannot show, so the relevant
  Issues' relationships are read in BOTH directions — each one's `blocked by` set
  and the Issues it blocks — and any relationship the plan does not account for
  refuses the edit whichever end of it the plan is missing.
  Previews by default; applies with `--yes`.

  Every apply runs the same sequence, and the ordering is the contract: read
  GitHub's current relationships and the accepted revision; suspend the
  execution labels (#787) of every affected Issue *before* the first
  relationship write, so no Issue can be picked up while its dependencies are
  half-drawn; re-check the frozen dependency prefixes (#891) with automation
  quiesced; apply the relationship additions idempotently (one that already
  exists is a step that already landed, which is what lets a re-run finish a
  half-applied edit); read GitHub back and verify it holds exactly the planned
  graph; update the registry only from that verified read, through #890's
  acceptance service under a frozen-prefix commit guard; and restore the labels
  only after all of that succeeded. "Every affected Issue" means every endpoint
  of a relationship this edit introduces, plus the Issues being linked —
  whether or not the relationship still has to be written, so a re-run that
  finds the boundary edge already in place still restores the head or root the
  interrupted run suspended. "The labels" means the ones this edit
  removed itself, plus the ones an earlier interrupted run of the same edit
  removed — never a suspension already standing when the command started. An
  Issue parked by `issue suspend`, or by a different chain edit, stays parked
  and is reported as still withheld: a completed edit must not be what makes it
  eligible again. Which labels those are is decided per label, not per record:
  one Issue holds one suspension record, so an edit that removes a label into a
  record another operation opened must still be able to recognize that label as
  its own on a retry, or it would leave it withheld for good while restoring
  nothing. Because appending is downstream-only it
  stays valid after an upstream Issue has started, while prepending rewrites the
  ancestry below the root and is refused once any prefix in the chain is frozen.

  Two applies that overlap on an Issue cannot run at once. An apply first claims
  an exclusive scope for every Issue it may touch, and for the `[name]` if one
  was given; an apply that cannot claim all of them refuses with
  `failure.kind: "lock_contended"`, naming the scope and the edit holding it,
  before it has suspended a label or written a relationship — so there is no
  partial state, and `failure.recovery` says only to run it again. The claim is
  what makes the suspend/restore pair above safe: a second edit arriving mid-way
  through the first would find the execution labels already removed, own none of
  them, and be left exposed when the first edit hands them back while the second
  is still drawing relationships. The name is claimed across its own pair of
  steps — the check that it is free and its registration — so a second run
  asking for the same name is turned away before it starts rather than after it
  has drawn relationships. That claim is not what makes the name safe: a
  creation that takes no claim at all (an intake registering a candidate whose
  head Issue derives the same ID) can still occupy the name in between, so the
  binding step is that the name and the chain ID are taken by one registry
  transaction. A run that loses that race creates no chain, keeps the
  relationships it drew, and is told to re-run with a different name — never an
  accepted chain that can never carry the name it was created for. A
  preview claims nothing and is blocked by nothing, since it writes nothing. A
  claim is released on every exit path, including a failure, so the documented
  retry can run; one left behind by a killed process is taken over after 30
  minutes.

  A claim also has to still be this run's at the moment it writes. It is renewed
  on a timer, and re-asserted against the store immediately before each
  mutation — the suspension, every relationship write, the registry update, and
  the restore. The timer alone cannot cover the case that matters: every
  provider call is synchronous, so a run blocked in one for longer than the
  takeover window never gets to fire a heartbeat, which is precisely when its
  scopes change hands. An edit that finds a scope is no longer its own stops
  there with `failure.kind: "lock_contended"`, leaving automation suspended and
  naming in `failure.recovery` what it had written and what to restore. Losing a
  scope after the registry already holds the verified graph does not undo the
  edit — it stands, applied — but the labels are then deliberately *not*
  restored: handing them back would make an Issue eligible in the middle of the
  edit that now holds it, which is the interleaving the whole claim exists to
  prevent.

  Two preconditions protect the "never repair GitHub from local state" rule for
  `append`/`prepend`. The chain's persisted graph must be the one #890 has
  accepted — an unaccepted candidate is refused with a pointer at
  `chain validate`/`chain sync` rather than extended — and every relationship
  the chain already records must be one GitHub actually holds, so an edge
  somebody removed on purpose can never come back as a side effect of an
  unrelated extension. Only the edges the command itself introduces are ever
  written.

  A failure never rewinds GitHub and never repairs it from the registry's copy
  of the graph: automation is left suspended, so the affected Issues are
  diagnosable but not executable, and the answer carries a `failure.recovery`
  list naming the Issues still suspended and the `admin issue activate` command
  that restores them. That command is offered only for Issues whose suspension
  record belongs to this edit alone: where another operation's labels share the
  record, `issue activate` would restore those too, so the plan names this
  edit's labels and says not to run it there. `chain new` allocates its chain
  identity before the graph is accepted, so a failure in between leaves a chain
  that owns the Issues but has accepted nothing; re-running the same `chain new`
  finishes that chain rather than reading its own leftover as another chain's
  claim and refusing as a merge. Only a chain in this session, holding no
  accepted revision, whose members are exactly the Issues named is resumed this
  way — anything else is somebody else's chain, and a `[name]` already resolving
  to that leftover is read as the retry it is rather than as a taken name.
  Naming such a leftover is one guarded registry write: the alias and the title
  are claimed under the same row revision the plan was computed against, so
  another registry writer moving that chain in between is reported as a
  `conflict` — sending the operator back through a fresh GitHub read — instead
  of being folded into the revision the acceptance compares with, where a stale
  plan could overwrite a newer graph. A read-back that disagrees with
  the plan — a relationship
  that did not take effect, or one another actor added while the command ran —
  refuses before the registry is touched, so the accepted graph is never a
  statement about a GitHub state nobody observed.

- `chain fork` / `chain merge` (issue #893): the advanced topology operations
  the linear commands refuse with a pointer here. `chain fork <chain-ref>
  <issue> [length] [--name <alias>]` extracts a contiguous run of members —
  `length` Issues starting at `<issue>`, or through the chain's downstream end
  when the length is omitted — into a chain of its own, removing the boundary
  relationships that attached the segment and bridging every predecessor of the
  segment's first member to every successor of its last, so every ordering
  constraint among the remaining members survives. A fan-in or fan-out strictly
  inside the segment is refused by name (there is no single next member to walk
  to); one at the segment's boundary survives the extraction. With `length` 1
  and no `--name`, the detached Issue receives no new chain identity; a name
  (or any longer segment) registers the segment as a chain through the same
  create-then-accept sequence as `chain new`. The segment must be unfrozen: a
  started Issue can be neither extracted (its pinned contract would move to
  another chain) nor stripped of an extracted ancestor (`ancestor_removed`),
  and both readings are enforced by one rule shared between the plan, the
  post-suspension re-check, and the acceptance's commit guard. `chain merge
  <target-chain> <source-chain> --position append|prepend` draws one boundary
  relationship — target head to source root for `append` (the target's head
  moves to the source's), source head to target root for `prepend` (the head
  stays) — makes every source member a member of the target, and retires the
  source in one registry transaction: the target keeps its chain ID, the
  source's ID and every alias it carried become aliases of the target (so
  every operator handle stays resolvable, deterministically), and its
  frozen-prefix snapshots are re-recorded against the target. The acceptance
  of the combined graph tolerates exactly the source chain in the store's
  exclusive member claim — the one legitimate moment two chains record the
  same Issues — and any third chain's claim still refuses the write inside the
  registry's own transaction. Both commands run the full linear mutation
  sequence: per-Issue edit locks, preview by default and `--yes` to apply,
  automation suspended before the first relationship write, additions applied
  before removals so a partial state never severs an ordering constraint
  without its bridge, an exact read-back (additions present, removals absent,
  nothing else moved) before any registry write, and labels restored last. A
  failure leaves automation suspended with a concrete recovery plan: an
  interrupted relationship pass is finished by re-running the same command; a
  fork interrupted after the chain was shrunk is finished with `admin chain
  new <segment-issues>`, whose leftover-adoption also resumes a segment chain
  created but never accepted; a merge interrupted after the target accepted
  the combined graph is finished by re-running the same merge, which detects
  the merged state and performs only the retirement.

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
force-release`, `session-doctor`, `session-init`, `worktree
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
