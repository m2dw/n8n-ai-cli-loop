# Worktree-Only Migration Contract

Status: **complete** — all four stages shipped (#690 contract → #691 ramp →
#698 migrate → #699/#731 delete). `worktrees.enabled` no longer exists;
supplying it is rejected with an actionable error (§2). This document is now
a historical record of the migration decisions; it is not a description of a
still-open contract.

This document is the migration **contract**, not the implementation. It
answers the four open questions from the DOMAIN.md draft unambiguously so
stages 2–4 (#691 ramp, #698 migrate, #699 delete) can be built without
re-litigating the design. Follow-up issues should reference the sections
below rather than restating them.

Background: `worktrees.enabled=false` (shared-checkout execution) is a
deletion target per DOMAIN.md §2.1 — the per-issue worktree rollout
(#454–#477) is complete and all `worktreeMode` dual paths in the phase
handlers are deletion targets, not refactor targets. But worktrees are
**opt-in and default-off today** (`src/core/session.ts`,
`docs/worktree-rollout.md`), and most live sessions still run disabled, so
immediate deletion breaks operations. Hence a staged migration.

---

## 1. New-session default

**Decision: the default flips from opt-in to opt-out.** A session that omits
the `worktrees` block is currently treated as disabled
(`session.worktrees?.enabled === true` evaluates to `false` when the block is
absent — `src/handlers/implementation.ts`, `src/registries/json-session-registry.ts`
`validateWorktreeConfig`). Ship in **#691**: change session resolution so a
missing `worktrees` block resolves to `{ enabled: true }` instead of
`undefined`. This is a loader-level default, not a schema change — the field
stays optional at this stage; it does not become required.

The default must apply everywhere a session's worktree state is read, not just
in the registry/phase-handler path. `src/cli/admin.ts`'s `loadSessionInfo`
re-parses `sessions.json` directly (it does not go through
`json-session-registry.ts`) and computes
`worktreesEnabled = worktrees?.["enabled"] === true` — a blockless session
resolves to `false` there today, and would keep resolving to `false` after
#691 unless it is updated too. That field feeds `admin worktree discard`
(`src/cli/admin.ts:4690`, refuses to run when `worktreesEnabled` is false) and
the continuation-category classification consumers at
`src/cli/admin.ts:3776-3916`, so an unpatched `loadSessionInfo` would refuse a
`discard` and misclassify recovery output for a session whose phase handlers
are already running in worktree mode under the new default. **#691 must
either (a) change `loadSessionInfo`'s defaulting to match — a blockless
`worktrees` object resolves `worktreesEnabled` to `true`, same as the
registry default — or (b) replace `loadSessionInfo`'s ad hoc JSON parsing with
a call through the resolved session/registry path so there is a single
source of truth for the default.** Either is acceptable; leaving
`loadSessionInfo` computing its own default independently of the registry is
not — the two would silently diverge the moment #691 ships.

Rationale for defaulting over requiring: requiring the field would force every
existing session file to be touched just to keep its current (disabled)
behavior, which is exactly the silent-breakage risk this contract is trying to
avoid. Flipping the default only changes behavior for sessions that don't
already have an opinion recorded in their config; a session with an explicit
`enabled: false` is untouched by this stage (see §2).

`docs/worktree-rollout.md`'s "Compatibility" statement ("A session without the
block keeps today's shared-`repoRoot` behavior byte-for-byte") becomes false
the moment #691 ships and must be corrected in the same PR — see §6.

## 2. Legacy `enabled: false` handling

**Decision: reject with an actionable error, enforced at #699 — not
auto-migrate, and not enforced any earlier.**

Auto-migration (silently treating a recorded `enabled: false` as `true`) is
rejected because it would flip a session's execution model (locks, branch
reset behavior, the quarantine backstop, worktree disk usage) without the
operator observing or approving the change — inconsistent with this
codebase's existing fail-closed/explicit-action conventions (admin commands
preview-by-default and require `--yes`; dependency-sync and
`environmentPrepare` commands are operator-pinned, never inferred; Tool
Request is a human gate, not an auto-grant). A session that explicitly
recorded `enabled: false` made a deliberate choice; changing that choice for
the operator, silently, is the failure mode this repo consistently avoids
elsewhere.

Enforcement timeline across the three implementation stages:

| Stage | Behavior for `enabled: false` |
|---|---|
| **#691** (ramp) | Still fully supported — shared-checkout execution keeps working. `session-doctor` (#695, coordinated with #691) emits a **non-fatal** warning naming the session and pointing at this doc. |
| **#698** (migrate) | Still supported. Ships the operator-facing migration procedure (§3) so sessions can move off `enabled: false` on the operator's schedule. No enforcement change. |
| **#699** (delete) | **Hard rejection.** Once the shared-checkout code paths are physically deleted, there is no code path left to honor `enabled: false` — the registry validation must throw a load-time error naming the session, the offending field, and this doc, rather than the runtime silently doing something the config didn't ask for. |

This is not a new mechanism: it is the same "validated even when present"
posture `validateDependencySync`/`validateEnvironmentPrepare` already use for
their own `enabled` flags, applied at the point where the flag stops having a
runtime meaning.

## 3. In-flight task migration procedure

**Decision: no task-data migration is required.** The mid-flight enablement
contract already in `docs/worktree-rollout.md` ("Mid-Flight Enablement")
covers this case completely: a task with work already in the shared checkout
keeps using it until its next phase runs under a worktree-enabled session, at
which point `resolveIssueWorktree` creates the worktree on first use and
records `worktreeId`/`worktreePath`. No database migration is needed because
`worktreeId` is recomputable from `session + issueNumber`.

This means the "migration procedure" a session operator performs in **#698**
is entirely config-level, not data-level:

1. (Pre-check) Run `admin quarantine status --session-id <id>`. If a
   quarantine marker is present, resolve it with
   `admin quarantine clear --session-id <id> --yes` — the command itself
   restores the checkout to the session base branch before deleting the
   marker, and refuses to run without `--yes` (see §4). A session should not
   carry a pre-migration quarantine marker into worktree-only operation.
2. Flip the session's config: **delete the `worktrees` block only if it sets
   no other field** (falls through to the #691 default). If the block also
   sets `root` (a supported override — `resolveSessionWorktreeRoot`,
   `src/cli/admin.ts`), deleting the whole block silently drops that override
   and moves subsequent worktrees to the global default root, potentially
   splitting a session's worktrees across two locations on disk. For a
   session with `root` set, the operator must instead keep the block and
   change only `enabled: false` to `enabled: true`, e.g.
   `{ "worktrees": { "enabled": true, "root": "/custom/root" } }`. `admin
   quarantine status` and `session-doctor` (both `src/cli/admin.ts`) surface
   this distinction directly — `quarantine status`'s `migrationGuidance`
   field and the doctor's non-fatal suggestion both name the specific next
   step (block has `root` → edit in place; block has no other fields →
   either edit or delete) instead of leaving it to operator memory.
3. No queue drain is required and no task rows are touched. Issues mid-flight
   on the shared checkout finish their current phase there if already
   started; their next phase run resolves a worktree automatically.
4. Confirm via `admin worktree list --session-id <id>` after the next trigger
   that worktrees are being created for active issues.

#698's "quarantine drain" scope (per the DOMAIN.md draft) is therefore the
marker cleanup described in §4, not a task-migration mechanism of its own.

## 4. Quarantine backstop: drain plan

The quarantine marker (`implementation-quarantine.json`,
`src/handlers/implementation.ts`) is a shared-checkout-only backstop per
`docs/per-issue-worktrees.md` ("Recovery model": *"The quarantine marker
remains a backstop only for the shared-checkout path"*). Current code state
(verified against `src/handlers/implementation.ts`):

- **Write path is already dead in worktree mode.** `failAfterBranch` returns
  the raw failure without writing a marker when `worktreeMode` is true — a
  late failure in a per-issue worktree leaves the worktree intact as its own
  durable continuation point instead (issue #454). No code change needed here
  before #699 removes the branch entirely.
- **Read gate (Step 0) is unconditional today** — `createImplementationHandler`
  checks `existsSync(quarantineMarkerPath(...))` regardless of
  `worktreeMode` and fails closed if a marker exists.

Drain plan:

1. **Write-path removal**: no action required now (already effectively dead
   per above); **#699** deletes the branch physically along with the rest of
   the `worktreeMode` dual paths, `writeQuarantineMarker`, `QUARANTINE_FILENAME`,
   and `quarantineMarkerPath`.
2. **Read-gate drain window**: keep the Step-0 read gate **unconditional**
   (not gated on `worktreeMode`) through #691 and #698. It must not be
   narrowed to "only check when `worktreeMode` is false", because a marker
   could have been written by a session *before* it migrated to worktree
   mode — the gate has to keep failing closed for that session regardless of
   its current config until the marker is explicitly cleared. Remove the gate
   only in **#699**, at the same time the write path is deleted, since by
   then no code path can produce a marker and no session can legitimately
   carry one forward.
3. **Marker cleanup**: `admin quarantine status|clear` (already implemented,
   `src/cli/admin.ts`) is the existing, sufficient tool — no new command is
   needed. §3 step 1 makes clearing a pre-check of the per-session migration
   procedure so no session enters worktree-only operation with a live marker.
4. **Final removal (#699)**: delete `admin quarantine status|clear` alongside
   the marker read/write code — once shared-checkout mode no longer exists,
   there is nothing left for those subcommands to report on or clear.

## 5. Stage boundaries — confirmed against this contract

| Issue | Scope | Confirmed / amended |
|---|---|---|
| **#690** (this issue) | Define the contract | — |
| **#691** | Default-on ramp for all blockless sessions — new and existing alike (§1) + non-fatal `session-doctor` warning for sessions with explicit `enabled: false` (§2) | **Confirmed.** Also must correct the now-false "opt-in/default-off" claims in `worktree-rollout.md`, `per-issue-worktrees.md`, and `install.md` in the same PR (§6), and must bring `admin.ts`'s `loadSessionInfo` in line with the new default so `admin worktree discard` and continuation-category classification don't diverge from the registry/phase-handler behavior (§1). |
| **#698** | Operator-facing migration procedure (§3) + quarantine marker pre-check/cleanup (§4) for existing sessions and their in-flight tasks | **Amended in scope, not in boundary**: no task-data migration code is needed (§3) — #698's actual deliverable is the documented/tooled config-flip procedure plus making the quarantine pre-check part of it. The issue title ("migrate sessions & in-flight tasks, quarantine drain") still describes the right issue; this contract just confirms the in-flight-task part is a documentation/verification step, not new mechanism. |
| **#699** | Delete shared-checkout mode: `worktreeMode` dual paths in impl/review/conflict handlers, the quarantine write+read+clear machinery (§4), and enforce rejection of `enabled: false` (§2) | **Confirmed**, with §2's enforcement point and §4's read-gate removal now pinned to this issue specifically (not #698). |

No split boundary changes are needed; this contract resolves the "TBD"s
inside the existing #690→#691→#698→#699 chain rather than moving work between
them.

## 6. Follow-up documentation updates required (not part of this issue)

When **#691** ships (default flips to enabled for every blockless session,
new or existing), the following statements become false immediately and must
be corrected in the same PR — they cannot wait for #699:

- `docs/worktree-rollout.md` **Overview** section (lines 31-32): "The feature
  is **opt-in** (default off). A session without the `worktrees` block keeps
  today's shared-checkout behavior unchanged." (Note: this file has no
  "Compatibility" section — the false claim lives in Overview.)
- `docs/per-issue-worktrees.md` **Compatibility** section (lines 339-340):
  "**Opt-in**: `session.worktrees.enabled` (default off). A session without
  the block keeps today's shared-`repoRoot` behavior byte-for-byte."
- `docs/install.md` §9 "Optional: enable per-issue worktrees" (lines
  303-315): "By default each session uses a single shared checkout
  (`repoRoot`)." and the surrounding "To opt in" framing.

Full removal of the "opt-in" framing — renaming these sections/headings,
dropping the now-vestigial `enabled: true` examples, and folding
`per-issue-worktrees.md`'s "Migration" section into a single narrative — still
waits for **#699**, once `enabled: false` stops being a valid config at all.
But the specific false factual claims above are a correctness bug the moment
#691 ships and must not be deferred.

DOMAIN.md §5 derived issue 1 is updated by this issue (see the diff on that
file) to point at this contract instead of restating it.
