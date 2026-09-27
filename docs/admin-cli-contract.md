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

  Duplicate ownership is judged over a *repository*, never over bare Issue
  numbers (issue #1045). An Issue number is unique only inside the repository
  that issued it, so the chains a member is compared against are those of every
  session bound to the same work-item repository as the chain's own session —
  which is the same scope `chain new`, `append`, `prepend`, `fork`, `merge`,
  `sync`, and intake claim their members under. Two sessions on one repository
  therefore still refuse a doubled claim, two sessions on different repositories
  never collide over a shared number, and a chain whose session the session file
  no longer describes falls back to that session alone. Two sessions are on the
  same repository when their provider, endpoint, owner, and repository name
  match case-insensitively — both providers resolve a slug that way, so
  `M2DW/Repo` and `m2dw/repo` are one Issue-number space — while the spelling
  each session declared is what is shown back. `validate` reports the
  scope it used as `ownershipScope`, and a `duplicate_ownership` finding names
  the offending chain's session and repository so it can be identified
  unambiguously.
- `agent-profile list` / `agent-profile show` / `agent-profile validate` (issue
  #913): read-only inspection and validation of the agent runtime profile
  catalog ([agent-runtime-profiles-contract.md](agent-runtime-profiles-contract.md)
  §11.4). `list` shows the effective catalog after the `agent-profiles.json`
  overlay is merged over the built-in one, with every value labelled built-in or
  overridden; `show <agent> [--quality <level>]` reports all four quality levels
  with the profile each binds and the concrete model, effort, budget, binary,
  and provider options the precedence ladder resolves for it, each value
  carrying its own source (an env break-glass override, an operator pin, the
  overlay, or the built-in catalog); `validate [--file <path>] [--probe]`
  re-runs the load-time gate against the effective catalog or a candidate file
  and then resolves every agent at every level under the current environment and
  session pins, so a bad override or an undeclared pin is reported before a
  phase spends a token. All three work with no catalog file present (the
  built-in defaults are what they show), address a catalog and a session rather
  than one task, and write nothing. `--probe` additionally runs each provider's
  declared version probe and reports `available` / `unavailable` /
  `indeterminate` in a section of its own: capability discovery is
  informational, never a verdict on a profile, and never feeds the catalog.
  `show` and `validate` exit non-zero when a resolution or a check fails, with
  the contract's own refusal reason (`catalog-invalid`, `unknown-profile`,
  `unsupported-value`, `invalid-override`, ...) on the finding.
- `agent-profile refresh` (issue #914): the safe update path for the same
  catalog ([agent-runtime-profiles-contract.md](agent-runtime-profiles-contract.md)
  §11.6). Compares the `agent-profiles.json` overlay against the release's
  recommended (built-in) catalog and the installed provider CLIs — a bounded,
  non-interactive model listing where a provider offers one, the bundled
  catalog otherwise, with the source reported — and previews a diff: removed
  or no-longer-recommended models, effort tiers the release does not declare,
  redundant overrides, and overrides shadowing a newer recommendation.
  Previews by default, applies with `--yes` like every other state-changing
  admin command; applying removes only tool-managed values (overrides
  identical to the recommendation — the proposed and current effective
  catalogs must produce the same digest, so no resolved setting can change),
  records the refresh provenance in the file, and writes a timestamped backup
  of the previous file first. A catalog edited concurrently — between the
  planning read and the apply — refuses with `refresh-conflict` instead of
  being overwritten. Model listings are scoped per resolved executable, so a
  profile is only compared against the inventory of the binary that would
  run it; a listing the probe interpreter truncated at its bound proves
  nothing absent, so it flags no configured model as removed and the
  inventory reason reports the truncation. Operator-created profiles and custom bindings
  are never modified; there is no force/replace mode. `--offline` skips every
  probe. With no catalog file present it reports that the built-in defaults
  apply and writes nothing.
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

  "Overlap on an Issue" is decided over the same repository the ownership check
  above is (issue #1045): an Issue is claimed under the work-item repository its
  number belongs to, so two sessions bound to one repository serialize against
  each other, while two sessions bound to different repositories that happen to
  share a number never block one another. A session that declares no repository
  identity claims its Issues under itself alone, exactly as before — narrower,
  never wider. Without the repository claim, two sessions on one repository
  would take disjoint claims and separate only at the final registry
  transaction, after both had already suspended labels and drawn relationships
  on the same Issue.

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

- `task-verification show` / `amend` / `refresh-from-issue` / `reset` (issue
  #1042): the task-scoped verification surface of
  [verification-amendment-contract.md](verification-amendment-contract.md) §11.
  They address one task, identified by `--session-id` and `--issue-number`, and
  they are the supported way to inspect and correct its verification plan —
  editing `sessions.json`, the task row, or SQLite by hand is not an operational
  flow, and a chain edited that way fails closed rather than being repaired.

  `show` is read-only: it resolves the **effective** plan (session defaults,
  Issue-derived requirements, and the applied revision chain, in that
  precedence) and reports each slot's stable command identity, origin, state
  (`active`/`retired`), the revisions that touched it, each requirement's
  evidence status (`passed`/`not_run`/`retired`), the plan digest, the recorded
  revisions, and any session-default drift. It re-anchors nothing.

  `amend` authors one append-only revision from `--replace <commandId>
  --command <bytes>`, `--add-execution <name> --command <bytes>`,
  `--add-requirement --command <bytes>`, `--retire`, `--restore`, and
  `--annotate`, each repeatable. `--command` and `--op-reason` bind to the
  operation flag they follow; a `--reason` is mandatory and becomes the reason
  of every operation that carries no `--op-reason` of its own.
  `refresh-from-issue` is the resource-oriented spelling of
  `review-verification refresh` — the same runner, flags, outcomes, and exit
  codes. `reset` returns the plan to its unamended baseline as one ordinary
  revision: retired slots restored, replaced slots reverted to their origin
  bytes, and task-local additions retired — withheld unless `--allow-retire`
  is passed, because retiring one removes a check the task currently runs.
  A reset derives its operations from the plan, so a request key derived from
  them cannot survive the reset's own success: its preview names the
  `--request-key` to pass back, and a rerun carrying that key is reported as a
  replay of the revision already recorded — even when it still carries the
  `--expect-plan-digest` the apply itself moved.

  All three mutations preview by default and apply only with `--yes`; a preview
  and an apply both report the old and the new plan digest. An outcome that
  proposes no revision has no such pair and reports the plan it did resolve as
  `plan digest: <digest> (unchanged)`, so a caller carrying a preview into an
  apply always has the digest that preview computed against.
  `--expect-plan-digest` (or `--expect-issue-digest` on the refresh) is the
  concurrent-edit guard between the two. A claimed or running task, a terminal
  task, a stale plan, a pinned preflight entry, an invalid operation, and a
  malformed `--reason` or `--request-key` each refuse whole, exit non-zero, and
  write nothing — including when the invocation would otherwise have had
  nothing to do. A recognized replay of an
  already-applied request, and a no-change preview or apply, exit zero. There
  is no `--force` and no `--all`: nothing overrides a refusal and no invocation
  addresses more than one task. `review-verification resolve` remains the
  evidence surface, with one addition (issue #1044, §13.1): on a task carrying
  an amendment chain it refuses a command the effective plan no longer requires
  — replaced, retired, or orphaned — naming the revision that moved the slot,
  rather than recording evidence against a requirement that is gone.

  An applied revision is publicly visible (issue #1044, §12.2): it enqueues one
  bounded comment on the work item through the outbox, keyed on the revision id
  and on no run identifier, naming the operations with their affected command
  names, the operator's reason, the resulting active and retired commands, and
  the continuation — with every retirement and restoration stated explicitly
  and "a retired verification command is not a passing result" beside them.
  Local paths are redacted and long text bounded, exactly as the command's own
  output is — with the bound spent on the plan listings and never on the
  retirement disclosures, each bounded section stating its own overflow. The
  comment separates the two layers rather than presenting them as one set of
  running checks: review Step 4 still executes the raw `session.verification`
  entries, so an execution-layer entry is published as a recorded plan change
  the loop neither runs nor credits at the gate — and an execution entry the
  revision RETIRED is published as retired in the recorded plan only, with
  session execution stated as unchanged rather than as still running it: Step 4
  reads the session's own configuration, so a command that configuration names
  keeps running and being reported while a task-local entry it never held was
  never run at all. Only the requirement layer carries the "not run, not
  passed" statement. A refusal, a recognized replay, and a session-default
  rebase each publish nothing, and no amendment changes a label. The same facts
  reach the human merge gate: an amended task's Human Gate Decision Summary
  states that the plan was amended, why, and what is no longer checked — with
  the plan's true retired total, a named overflow when the label list is
  bounded, and the digest of the RECONCILED plan the gate actually read rather
  than the latest revision's checkpoint. On a split-provider session (private
  work-item tracker, public repo host) that summary carries only the public-safe
  aggregate: the counts and digests are published, the operator's reason and the
  command labels stay on the work item, exactly as the Issue title already does.
  A session counts as split when its two providers do not address the same
  repository — `github-issues` + `github`, and a `gitea-issues` + `gitea` pair
  naming the same instance, owner, and repository, are each one surface and
  publish the names in full.
  A `--continue none` amendment applied to a task already parked at
  `ready_for_human` moves no status, so it also rewrites that PR's sticky
  summary in the same transaction — superseding a decision summary that
  describes the plan the revision replaced, and naming what the revision
  retired. A routing continuation retracts the handoff instead and rewrites
  nothing.

  `admin ui` offers the same flow from its task menu (issue #1044): the
  Verification entry renders the `show` payload, prefills the current plan and
  the previous revision's reason, previews every correction, and applies only on
  an explicit confirmation — running these exact commands, with everything the
  preview reported carried into the apply: the plan digest it displayed as
  `--expect-plan-digest`; on `refresh-from-issue` BOTH the live Issue body
  digest as `--expect-issue-digest` and the plan digest the preview itself
  resolved as `--expect-plan-digest`, because a refresh's difference is derived
  from two inputs and a concurrent amendment moves it while the Issue body is
  untouched — the `base -> new` pair of a proposed revision, or the
  `(unchanged)` digest a no-change preview reports, and never a digest read from
  an earlier screen: a preview that names neither offers no apply at all. Each
  correction also mints one `--request-key` for that flow and names it on both
  the preview and the apply, including on `reset`, whose preview names the key
  to pass back. A key is minted rather than left to the content-derived default
  because two UI corrections can be byte-identical and still be different
  requests — retiring a slot, restoring it, and retiring it again — and the
  derived key would make the third one a replay of the first, reporting a
  superseded revision while the slot stays active. Carrying the same key into
  the apply keeps the printed apply line replayable: re-running it names the
  revision already recorded instead of recording a second one, so a reset whose
  apply commits and loses its response is recognized as the replay it is rather
  than reported as "nothing left to undo". One thing it deliberately does not carry
  over: the plan view redacts local paths out of the commands it prints, so a
  replacement for a redacted command is typed in full rather than prefilled —
  accepting a `<path>` placeholder as the corrected bytes would store a
  non-executable command and break the check the correction was meant to fix.
  It resolves no plan and writes
  no state of its own, so the CLI and the UI produce the same plan, the same
  transition, and the same audit trail.

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

## How the admin CLI is tested (issue #1018)

The executable is a thin boundary over one dispatcher, and the test surface is
split along exactly that seam.

- `src/cli/admin.ts` exports `main(argv)` (the dispatcher) and `runAdminCli(argv)`
  (dispatch plus the top-level failure contract that turns an unexpected throw
  into the same `die()` output any other failure produces). Invoked as a program,
  `dist/cli/admin.js` does nothing but call `runAdminCli(process.argv.slice(2))`.
- `src/cli/cli-io.ts` owns the three process effects — stdout, stderr, and exit —
  behind a `CliIoSink`. Production binds it to the real process. No other module
  in the admin CLI writes to `process.stdout`/`process.stderr` or calls
  `process.exit` directly, so replacing the sink captures the whole output and
  exit contract.

**In-process (the default).** `test/helpers/admin-cli.js` exposes `runAdmin(args,
{ env, cwd })`, which installs a buffering sink whose `exit` throws `CliExit`,
runs `runAdminCli`, and returns the same `{ code, stdout, stderr }` a spawned run
would. It snapshots and restores `process.env`, the working directory,
`process.exitCode`, and the resolved output mode around every run. Behavioural
cases — what a command decided, what it wrote, what it refused — belong here.
There is one harness; suites do not add their own.

**Subprocess (the contract set).** `test/admin-cli-subprocess.test.js` keeps a
small, documented set of spawned cases for the things the harness can only
simulate:

1. real `process.argv` parsing, including unknown-option rejection;
2. the real process exit status a shell or an n8n `Execute Command` node reads;
3. genuine stdout/stderr file-descriptor separation and the JSON stdout contract;
4. environment isolation.

A case belongs there only when the process boundary *is* the assertion. Three
divergences decide borderline cases:

- `die()` unwinds by throwing under the harness, so `finally` blocks a real exit
  would skip do run. Every such block in `admin.ts` is an idempotent lock release
  or store close that the `die()` path already performs explicitly, so the
  observable outcome is unchanged — but a case asserting that a resource is
  *still held* after a death must stay spawned.
- Module-load-time constants (`DEFAULT_SESSIONS_PATH`, `DEFAULT_WORKTREE_LOCK_DIR`)
  read `homedir()` once per worker, so a case that needs a different `HOME` must
  stay spawned. `test/admin-status.test.js` keeps exactly one such case.
- An `env` override reaches a child process only through a spawn site that
  passes it. Jest hands every module a *copy* of `process.env`, while
  `execFileSync`/`spawnSync` read their default `env` from the real process
  object — so a spawn site that omits `env` resolves `PATH` against the host and
  silently ignores a stub the case installed. Every spawn site the admin CLI
  reaches passes `spawnEnv()` (`src/handlers/command-runner.ts`), which is the
  same value the default already is in production; a new spawn site must do the
  same or its case has to stay spawned.

**Measuring.** Per-suite timing comes from
`npx jest test/admin-cli.test.js --verbose` (Jest prints the suite time), and
whole-run timing from `time npm test`. Compare on one machine; CI runtime varies
between runners.

## Migration notes

- Machine-owned calls request `--json` *before* any default changes, so the JSON
  stdout contract is never silently broken.
- Generated workflow definitions and their tests are updated together with any
  default change (see `test/build-parent-child-workflow.test.js`).
- Recovery behavior is unchanged; this contract only standardizes formatting and
  option handling.
