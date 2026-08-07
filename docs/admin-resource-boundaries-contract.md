# Session, Worktree, Lock, UI, Outbox, and maintenance resource boundaries

This document specifies the target module boundaries, public ports,
construction ownership, and dependency direction for every remaining
operational resource in `src/cli/admin.ts` and `src/cli/admin-ui.ts` that is
**not** already covered by the three sibling extraction-contract documents
(issue #711, completing the set started by #708/#709/#710). PR #707 is
prior-attempt research material; where anything below differs from it, this
document — reconciled against the current `src/cli/admin.ts` (10,574 lines),
`src/cli/admin-ui.ts` (1,900 lines), and their supporting `core`/`stores`
modules — is authoritative. **This is a documentation-only issue: no
production code (interfaces, adapters, construction sites, or call sites) is
changed here.** The port shapes below are a target contract for later
implementation issues, exactly as #708/#709/#710 were for their slices.

This document supersedes the remaining part of #612 not already closed by
#708–#710, per `docs/DOMAIN.md` §4 row 4/5 and §4.1's admin-decomposition
chain. **Note (issue #731):** the `quarantine status`/`quarantine clear`
subcommands and their marker-file machinery discussed below (§2, §8.1) have
been deleted along with `worktrees.enabled` — those references are historical
and no longer describe a live boundary violation. **Note (issue #823):**
`SessionRegistry`'s construction is no longer "whole-file-eager-validating"
in the sense §3.2/§3.3 below describe — a malformed or ambiguous entry
elsewhere in `sessions.json` is quarantined (excluded, reported via
`getDiagnostics()`) rather than failing the whole registry. The *target*
session's own malformed/missing fields still make `getSessionById` return
`undefined` (same as before), so §3.2/§3.3's core conclusion — keep paths B
and C on their own tolerant read path(s), off `SessionRegistry` — is
unaffected: `SessionRegistry` still requires the full schema on the
requested session, which paths B/C's callers still don't need. Read those
sections' "any entry in the file" framing as historical. It complements:

- [`admin-command-registry-contract.md`](admin-command-registry-contract.md)
  (#708) — dispatch/registry mechanics: which token routes to which handler.
- [`admin-cli-parsing-contract.md`](admin-cli-parsing-contract.md) (#709) —
  option parsing, output-mode, and exit-code behavior.
- [`admin-task-handoff-ports-contract.md`](admin-task-handoff-ports-contract.md)
  (#710) — the `TaskStore` port for every command that mutates a task or
  human-handoff, plus the transactional/idempotency contract for that slice.

None of those three govern *who owns which resource's state* outside task
rows — that is this document's charter, per `docs/DOMAIN.md` §2.3's
"Operation" context: "Depends on: every context's *public* ports; reaching
into internals (e.g. raw SQLite writes bypassing the stores) is forbidden."

## 1. Scope: what is, and is not, covered here

Every dispatchable command enumerated in #708's §2.2 falls into exactly one
of four buckets. Buckets 1–2 are **out of scope** here (already contracted);
buckets 3–4 are this document's charter:

1. **Task/handoff mutation** — `task-status`, `list-stuck`, `recover`,
   `recover-cap-handoff`, `task clear-delay`, `human-review-return`,
   `github-app-review-return`, `review-verification resolve`, `tool-request
   list|resolve|run|grant`. Owned by #710.
2. **Registry/dispatch mechanics and output framing** — cross-cutting, not a
   resource; owned by #708/#709.
3. **Session, Worktree, Lock, and UI resources** — `session-doctor`,
   `session-init`, `session preset list|show`, `worktree
   list|prune|recovery|cleanup|release-lock|discard`, `repo-lock
   acquire|release|status|force-release`, `review-lock status|release`,
   `admin ui`. Covered in §3–§6 below.
4. **Maintenance-catalogued resource groups** — `quarantine status|clear`,
   `context create`, `context-mode status`, `issue-discuss preview|post`,
   `issue-plan preview|ai-preview|evaluate-history`, `interventions`, the
   top-level `status` aggregator, and `task-assign`. Covered in §8 below.
   Outbox operator controls (inspection/retry/cancel/dead-letter) do not
   exist as admin commands today — §7 defines their target ownership and
   port surface for when #606/#607 build them, so the boundary is drawn in
   advance rather than left to whichever issue happens to add the first
   command.

`context create` remains, as #710 §2.1 already ruled for its own scope, a
three-line adapter over its own tiny table — it is inventoried here only for
completeness of the ownership map (§2), not because it needs new port work.

## 2. Ownership map: every remaining admin subcommand has exactly one owner

| Command | Target owner | Current handler (file:line) |
| --- | --- | --- |
| `session-doctor` | Session | `runSessionDoctor`, dispatch `admin.ts:10499-10502` |
| `session-init` | Session | `runSessionInit`, `admin.ts:5168-5246`, dispatch `10504-10507` |
| `session preset list` | Session | `runSessionPresetList`, `admin.ts:1642`, dispatch `10482-10496` |
| `session preset show` | Session | `runSessionPresetShow`, `admin.ts:1647`, dispatch `10482-10496` |
| `worktree list` | Worktree | `runWorktreeList`, `admin.ts:2723-2769` |
| `worktree prune` | Worktree | `runWorktreePrune`, `admin.ts:2811-2860` |
| `worktree recovery` | Worktree | `runWorktreeRecovery`, `admin.ts:4570-4600` |
| `worktree cleanup` | Worktree | `runWorktreeCleanup`, `admin.ts:3723-3868` |
| `worktree release-lock` | Lock (issue-scoped) | `runWorktreeReleaseLock`, `admin.ts:3972-3979` |
| `worktree discard` | Worktree (acquires Lock) | `runWorktreeDiscard`, `admin.ts:4118-4340` |
| `repo-lock acquire` | Lock (session-scoped) | `runRepoLockAcquire`, `admin.ts:2304-2313` |
| `repo-lock release` | Lock (session-scoped) | `runRepoLockRelease`, `admin.ts:2315-2324` |
| `repo-lock status` | Lock (session-scoped) | `runRepoLockStatus`, `admin.ts:2350-2357` |
| `repo-lock force-release` | Lock (session-scoped) | `runRepoLockForceRelease`, `admin.ts:2392-2404` |
| `review-lock status` | Lock (issue-scoped) | `runReviewLockStatus`, `admin.ts:4369-4385` |
| `review-lock release` | Lock (issue-scoped) | `runReviewLockRelease`, `admin.ts:4402-4407` |
| `admin ui` | UI (consumes Session/Worktree/Lock/#710's Task ports) | `runAdminUi`, `admin-ui.ts:1819-1900` |
| `quarantine status` | Maintenance | `runQuarantineStatus`, `admin.ts:2521-2545` |
| `quarantine clear` | Maintenance | `runQuarantineClear`, `admin.ts:2589-2611` |
| `interventions` | Maintenance | `runInterventions`, `admin.ts:10214-10246` |
| `status` (top-level) | Maintenance (cross-context aggregator; reads Task/#710, Worktree, Lock) | `runStatus`, `admin.ts:3533-3591` |
| `context create` | Content | `runContextCreate`, `admin.ts:1624-1629` |
| `context-mode status` | Content | `runContextModeStatus`, `src/cli/context-mode-status.ts` |
| `issue-discuss preview` | Content | `src/cli/issue-discuss.ts`, dispatch `admin.ts:10546` |
| `issue-discuss post` | Content | `src/cli/issue-discuss.ts`, dispatch `admin.ts:10552` |
| `issue-plan preview` | Content | `src/cli/issue-plan.ts`, dispatch `admin.ts:10523` |
| `issue-plan ai-preview` | Content | `src/cli/issue-plan-ai.ts`, dispatch `admin.ts:10529` |
| `issue-plan evaluate-history` | Content | `src/cli/issue-plan-history.ts`, dispatch `admin.ts:10535` |
| `task-assign` | **Not this document** — already Orchestration/#710's `TaskStore` scope (`core/assignment.ts`); listed only to confirm it has an owner and does not fall through the cracks between #710 and #711 | `runTaskAssign`, `admin.ts:4822-4860`, dispatch `10350-10352` |
| *(no current command)* | Outbox — forward-looking, §7 | n/a |
| *(no current command)* | Notification — forward-looking, §8.4 | n/a |
| `npm run metrics` | **Not an admin subcommand** — `scripts/metrics.mjs`, a wholly separate composition root outside `admin.ts`'s `COMMANDS`/`main()`. Out of scope for this contract (it isn't part of the surface the acceptance criterion "every remaining admin subcommand" refers to); noted so its absence from every table above reads as a decision, not an oversight. | `package.json:16` |

Five target modules therefore carry §3–§8: **Session**, **Worktree**,
**Lock**, **UI**, **Outbox** (forward-looking), and **Maintenance**
(quarantine + interventions + status aggregation), plus **Content**
(context/context-mode/issue-discuss/issue-plan — already the best-isolated
group in the monolith, see §8.2).

## 3. Session module

### 3.1 What exists today, and what's already correct

`SessionRegistry` (`src/core/session.ts:560-570`) is a four-method,
**read-only, `Promise`-returning** interface — `getSessionById`,
`getSessionByRepoKey`, `listSessions`, `resolveSessionRef` — and
`JsonSessionRegistry` (`src/registries/json-session-registry.ts:88`) already
implements it with matching `async` signatures. **There is no port-typing gap
on the read side**: every method a consumer needs already exists on the
interface with the right shape. `JsonSessionRegistry` is a **snapshot**
registry — it indexes the entire `sessions.json` once at construction
(`indexSessions(loadSessions(path))`, `json-session-registry.ts:91-95`) and
serves every subsequent call from that in-memory index; it does not re-read
the file per call and has no reload method.

### 3.2 The gap: four parallel, un-consolidated ways to read/write the same file

| Path | Where | Call sites | Read/write |
| --- | --- | --- | --- |
| A. `new JsonSessionRegistry(...)`, typed as the **concrete class**, not `SessionRegistry` | `admin.ts:4840,5702,6071,6625,7088,7925`; `admin-ui.ts:789,1845`; `context-mode-status.ts:496` | 9 sites | Read-only (`registry.getSessionById`/`listSessions`) |
| B. `loadSessionInfo(sessionId, sessionsPath)` — hand-rolled `readFileSync`+`JSON.parse`, bypasses the registry entirely | `admin.ts:2443-2486` | `runQuarantineStatus` (2526), `runQuarantineClear` (2599), `runWorktreeList` (2728), `runWorktreePrune` (2816), `runStatus` (3538), `runWorktreeCleanup` (3736), `runWorktreeDiscard` (4123), `runWorktreeRecovery` (4575) — 8 sites | Read-only |
| C. Inline raw `JSON.parse`/`Array.isArray`/`find`, a *third* hand-rolled parser | `admin.ts:2024-2049`, `session-doctor` only | 1 site | Read-only |
| D. Raw `JSON.parse` → duplicate-check → `file.sessions.push(...)` → `writeFileSync` | `admin.ts:5191-5243`, `session-init` only | 1 site | **Write** — the only session-mutating command in scope |

Path A's concrete-vs-interface mismatch is the *lesser* violation (a type
annotation fix — every call already used matches the interface's async
signature); paths B and C are the real gap, since they read `sessions.json`
without going through any port at all, each with its own ad hoc parse and
error message. `loadSessionInfo`'s return shape (`LoadedSessionInfo`:
`sessionId`, `repoRoot`, `artifactRoot`, `artifactDir`, `baseBranch`,
`sessionWorktreeRoot`, `worktreesEnabled` — `admin.ts:2424-2486`) is a strict
subset of the *values* `ResolvedSession` carries, but not of the
*validation* required to produce a `ResolvedSession` in the first place.
`JsonSessionRegistry`'s constructor eagerly runs `validateSession`
(`json-session-registry.ts:207` onward) against **every** entry in
`sessions.json`, requiring fields none of `loadSessionInfo`'s 8 callers read
or need — `githubRepo`, `defaults.implementationAgent`,
`defaults.reviewAgent` (each a `requiredString`/enum check that throws when
absent or malformed) — and failing the whole construction if *any* entry,
including one unrelated to the session actually being looked up, fails that
check. `loadSessionInfo` requires only `repoRoot` and `artifactDir` on the
**selected** entry, defaults everything else it needs (`baseBranch` to
`"main"`, worktree fields to `undefined`/`false`), and never inspects any
other entry in the array. Routing path B through
`SessionRegistry.getSessionById` would therefore reject a `sessions.json`
that all 8 of these commands accept today — either because the target
session omits a field none of them read, or because some *other* session
elsewhere in the file is malformed. Path C has the identical problem for the
same reason (`session-doctor`'s own inline parser is just as tolerant, for
its own subset of fields). §3.3 therefore keeps **both** B and C off
`SessionRegistry`, on their own tolerant read path(s), never merged into the
registry's stricter, whole-file-eager-validating contract.

### 3.3 Decision: migrate path A onto `SessionRegistry`; keep paths B/C tolerant; add its write surface (`createSession` and `updateSession`)

- **Read call site A migrates to `SessionRegistry.getSessionById` /
  `.listSessions`**, typed against the **interface**, not
  `JsonSessionRegistry`. Its callers already construct `JsonSessionRegistry`
  directly today, so they are already subject to its eager, whole-file
  validation — only the type annotation changes, not runtime behavior.
- **Read call sites B and C are *not* deleted and do *not* migrate to
  `SessionRegistry`.** `JsonSessionRegistry`'s constructor eagerly validates
  and normalizes **every** entry in `sessions.json`
  (`indexSessions(loadSessions(path))`, §3.1) and throws on the first
  malformed one — the requested session's own malformed/missing fields, *or*
  an unrelated session elsewhere in the file. Both `loadSessionInfo` (path B,
  8 call sites: `runQuarantineStatus`, `runQuarantineClear`,
  `runWorktreeList`, `runWorktreePrune`, `runStatus`, `runWorktreeCleanup`,
  `runWorktreeDiscard`, `runWorktreeRecovery`) and `session-doctor`'s inline
  parser (path C) are deliberately tolerant today (`typeof
  session["repoRoot"] === "string" ? session["repoRoot"] : ""`,
  `admin.ts:2047-2049` for C; the equivalent per-field checks in
  `loadSessionInfo`, `admin.ts:2461-2472`, for B): a missing or malformed
  field the caller doesn't read becomes an empty string / default value
  instead of an abort, and neither path inspects any session other than the
  one requested. Routing either through `SessionRegistry` would turn a
  per-command tolerant lookup into a total command failure the moment any
  session in the file — not even the one being looked up — has data
  `SessionRegistry`'s stricter contract requires but that command never
  reads; that is a regression, not a consolidation, and would break §13's
  preservation guarantee for all 9 of these commands (the 8 path-B commands
  plus `session-doctor`). This document therefore keeps path B and path C on
  their own tolerant read path(s) — today's two separate inline parsers, or
  a tolerant helper factored out of each and relocated out of `admin.ts` so
  every call site imports a named port instead of the top-level dispatcher
  (this document's own ports-not-dispatcher requirement) — distinct from,
  and never merged into, `SessionRegistry`'s stricter,
  whole-file-eager-validating read contract. `SessionRegistry` must not be
  weakened to tolerate malformed entries to accommodate B or C, and neither
  B's nor C's path may be asked to satisfy `SessionRegistry`'s interface.
- **Two write methods are added to `SessionRegistry`: `createSession`
  (append-only) and `updateSession` (in-place field mutation)** — a rival
  "write port" (i.e. a whole separate interface) is still rejected for the
  same reason #710 §3 rejected a rival `TaskStore`: session state is one
  table (`sessions.json`'s `sessions` array); splitting its read and write
  access across two *ports* would let a future change satisfy one port's
  invariants (e.g. duplicate-`sessionId` checks) while bypassing the other's.
  Two *methods* on the one port is not that split — see the `updateSession`
  docstring below, and §3.4, for why a single append-only method cannot also
  serve pause/resume.
- **`createSession` validates the complete reference index, not just
  `sessionId`/`repoKey`.** `SessionConfig` also carries `sessionNo` and
  `aliases` (`core/session.ts`), both of which `resolveSessionRef`'s
  `#refIndex` (§3.1) resolves a `--session-ref` against. Rejecting only
  duplicate `sessionId`/`repoKey` (as `runSessionInit` does today,
  `admin.ts:5197-5206`) lets a caller create a session whose `sessionNo` or
  any `aliases` entry collides with an existing session's — the write
  reports success, but the file it just wrote is now ambiguous for the next
  `--session-ref` resolution: `JsonSessionRegistry`'s own construction
  (§3.1, which builds `#refIndex` via `buildSessionRefIndex` by folding every
  session's refs into one map) throws `Ambiguous session reference` the next
  time *any* registry is constructed from that file, not just for the two
  colliding sessions but for every caller that needs to load the registry at
  all. `createSession` must therefore validate the **complete**
  reference index before writing — `sessionId`, `repoKey`, `sessionNo`, and
  every `aliases` entry, each checked against every existing session, not
  only the two fields `runSessionInit` happens to check today — and reject
  (no write) on any collision, in any of the four fields.
- **`session-init`'s migration keeps its file-bootstrap step outside
  `JsonSessionRegistry`'s constructor.** `loadSessions` (§3.1,
  `json-session-registry.ts:222-225`) throws `Session registry file does not
  exist` when `sessionsPath` is missing — correct fail-fast behavior for
  every *read* path (§3.2 paths A/B/C all assume the file already exists),
  but `runSessionInit` today creates `sessionsPath` (and its parent
  directory) with an empty `{ sessions: [] }` on first use
  (`admin.ts:5187-5190,5236-5237`) precisely because a fresh installation
  has no `sessions.json` yet. Routing `session-init` through
  `SessionRegistry.createSession` must not silently drop that bootstrap: a
  registry cannot be constructed against a missing file to call
  `createSession` on it in the first place. This document does **not**
  change `JsonSessionRegistry`'s constructor to tolerate a missing file for
  every caller — that would weaken the fail-fast guarantee read callers
  correctly rely on. Instead, `session-init`'s handler retains a small,
  dedicated bootstrap step — equivalent to today's `existsSync(sessionsPath)
  ? ... : { sessions: [] }` plus `mkdirSync(dirname(sessionsPath), {
  recursive: true })` — that runs **before** constructing the registry: if
  `sessionsPath` does not exist, write an empty `{ sessions: [] }` file (and
  create its parent directory) first, then construct `JsonSessionRegistry`
  against the now-present file and call `createSession`. This bootstrap step
  is `session-init`-only; it is not a `SessionRegistry` method and no other
  call site gets it.
- **`JsonSessionRegistry`'s constructor retains its current eager,
  whole-file `validateSession` pass unchanged — this document does not make
  it lazy.** An earlier draft of this section proposed deferring that pass
  from construction time to first-call time on one of the four *read*
  methods (`getSessionById`, `getSessionByRepoKey`, `listSessions`,
  `resolveSessionRef`), memoized after that first call, specifically so a
  `session-init` run against a `sessions.json` with some unrelated malformed
  entry could still reach `createSession`. That is not behavior-preserving:
  existing callers such as `run-one-phase.ts` wrap only `new
  JsonSessionRegistry(...)` in a try/catch and call `getSessionById()`
  outside that `try`, and the existing registry tests assert invalid files
  throw during construction — both depend on the throw happening at
  construction time, inside the established `Failed to load sessions file`
  handling. Moving the throw to first-read time would let a malformed or
  missing sessions file escape that handling for every one of those callers
  and break those tests. `new JsonSessionRegistry(sessionsPath)` therefore
  keeps validating and throwing exactly as it does today, for every caller,
  with no exemption carved out for `session-init`.
- **Consequence: `session-init` now fails fast on a `sessions.json` with any
  unrelated malformed entry, where `runSessionInit`'s path D (§3.2)
  tolerates one today — a real, narrow behavior difference, documented here
  rather than avoided.** Path D (`admin.ts:5191-5243`) requires only that
  `raw.sessions` be an array and never inspects any field of any entry
  besides `sessionId`/`repoKey`, on the one it's checking for a duplicate.
  Once `session-init` is routed through `SessionRegistry`, the
  `JsonSessionRegistry` its factory constructs (§9 point 1 — built only
  after the bootstrap step guarantees the file *exists*, not that every
  entry in it is well-formed) validates every entry in `sessions.json` and
  throws on the first malformed one, matching every other
  `SessionRegistry`-based command's existing fail-fast contract (path A,
  §3.2) rather than path D's narrower duplicate-only check. This is judged
  acceptable rather than papered over with the lazy validation rejected
  above: it can only be triggered by a *pre-existing* malformed unrelated
  entry — a file `session-doctor` (path C, unaffected — it keeps its own
  tolerant parser, §3.3 above) already flags as broken — and as
  `createSession`/`updateSession` become every command's write path,
  `sessions.json` entries are increasingly written through this same
  validating contract, making that starting condition rarer, not more
  common. Because construction already guarantees every entry is valid by
  the time `createSession` is reachable at all, its reference-invariant
  collision check (`sessionId`, `repoKey`, `sessionNo`, every `aliases`
  entry) is **not** simply read from the constructed instance's own,
  possibly-stale `byId`/`byRepoKey`/`#refIndex` snapshot (§3.1) — see the
  write-time re-validation requirement in `createSession`'s docstring below,
  which exists precisely because that snapshot can go stale within a single
  instance's lifetime.

```ts
export type SessionWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

export interface SessionRegistry {
  // ... existing four read methods unchanged ...

  /**
   * Append a new session to the registry's backing store. Rejects (no write)
   * if `sessionId`, `repoKey`, `sessionNo`, or any `aliases` entry collides
   * with an existing session's (§3.3's reference-invariant requirement) —
   * a strict superset of the `sessionId`/`repoKey` checks `runSessionInit`
   * performs today (admin.ts:5197-5206). The collision check is **not**
   * computed from the constructed instance's own `byId`/`byRepoKey`/
   * `#refIndex` snapshot (§3.1): that snapshot is taken once, at
   * construction time, and never mutated in place (see below), so a second
   * `createSession` call on the *same* instance — the same `sessionId`, or
   * one colliding on `repoKey`/`sessionNo`/`aliases` with a session the
   * *first* call just wrote — would still see the pre-first-write snapshot,
   * find no collision, and append a second, now-duplicate entry;
   * `JsonSessionRegistry`'s own construction would then throw `Ambiguous
   * session reference` the next time *anything* loads the file (§3.3's
   * consequence paragraph above), for a corruption `createSession` itself
   * introduced. To prevent this, `createSession` must re-load and re-index
   * `sessions.json` from disk immediately before checking for a collision —
   * the same eager, whole-file `validateSession` + `buildSessionRefIndex`
   * pass the constructor runs (§3.1), not path B/C's tolerant read — and
   * validate against *that* freshly-read state, never the instance's
   * original construction-time snapshot. This re-read closes the
   * single-instance race (two calls on the same object) but not the
   * **cross-instance** one: two separate `SessionRegistry` instances — e.g.
   * two concurrent `session-init` processes, each constructing its own
   * `JsonSessionRegistry` against the same `sessionsPath` — can each perform
   * this re-read before either writes, each see no collision, and each
   * append, producing the same duplicate-entry corruption from the other
   * direction. Closing that gap requires the read-validate-write sequence to
   * run as a single transaction scoped to the sessions file, not just a
   * re-read: `createSession` (and `updateSession`, below) must acquire an
   * exclusive, file-scoped lock *before* the re-read, hold it across
   * validation, and release it — in a `finally`, so a thrown
   * validation/write error cannot leave it held — only after the write
   * completes. This is a CAS-style guarantee: the re-read is the "compare,"
   * the guarded write is the "swap," and the lock is what makes the pair
   * atomic across processes rather than merely sequential within one.
   * A `finally` release only protects against a *thrown* error inside the
   * process that holds the lock; it does nothing if that process is killed
   * (SIGKILL, OOM, host crash) between acquire and release, so a bare
   * exclusive-create sidecar with no expiry would let one abandoned
   * `session-init`/update process wedge every future `createSession`/
   * `updateSession` call behind a lock its owner will never release. The
   * sidecar must therefore carry the same owner-record-plus-staleness shape
   * `RepoLockStore` already implements (`repo-lock-store.ts`), not a bare
   * exclusive-create with no recovery path: the lock file's contents are a
   * `{ contextId, startedAt }` record (the same shape `RepoLockStore.acquire`
   * writes), and any acquire attempt that finds an existing record older than
   * a fixed stale TTL (reusing `RepoLockStore`'s `DEFAULT_STALE_TTL_MS`
   * constant/value, not inventing a second threshold) must treat it as
   * abandoned and reclaim it via the same atomic tmp-file-plus-rename
   * replace `RepoLockStore.acquire`'s stale-recovery branch uses, rather than
   * blocking indefinitely or requiring an operator to delete the sidecar file
   * by hand. This lock is **Session-owned, file-local infrastructure**, not
   * an import of `RepoLockStore`/`IssueWorktreeLock` from the Lock module
   * (§10's dependency matrix: Session → Lock is `✗`) — it may reuse the same
   * exclusive-create (`open(..., "wx")`) technique **and** the same
   * owner-record/stale-TTL recovery shape those classes already use, to make
   * both acquisition and crash recovery atomic, implemented as its own
   * primitive alongside `JsonSessionRegistry` (e.g. a `<sessionsPath>.lock`
   * sidecar), since reusing the *technique* is not the same as depending on
   * the *module*. Every `SessionRegistry` implementation's `createSession`/
   * `updateSession` must honor this transaction, including its stale-lock
   * recovery; §12 items 2/3 list the two-instance concurrency tests that
   * exercise the ordinary (non-crashed) case, and §12 item 3's added
   * crash-recovery test (below) pins the abandoned-lock case specifically —
   * neither concurrency test kills a lock holder mid-transaction, so neither
   * would catch a regression that dropped the staleness check. This re-read is
   * authoritative but still instance-**local** bookkeeping for the write
   * path only; it does
   * not retroactively update the instance's own `byId`/`byRepoKey`/
   * `#refIndex` used by the four read methods (below), which stays exactly
   * the construction-time snapshot it is today. The input is
   * the raw `SessionConfig`
   * shape (defaults/verification/labels/environmentPrepare as constructed
   * today), not a `ResolvedSession` — provider defaults and other resolution
   * happen on the next read, not at write time. A registry instance's own
   * in-memory index used by the four read methods is a snapshot (§3.1):
   * callers that need a `ResolvedSession` for the session just created must
   * construct a fresh registry (or otherwise reload), not assume
   * `createSession` mutates the calling instance's read-method index in
   * place — only its own write-time collision check re-reads the file, and
   * only for that check's own purposes.
   */
  createSession(
    input: SessionConfig & { sessionId: string; repoKey: string },
  ): Promise<SessionWriteResult<SessionConfig>>;

  /**
   * Mutate an existing session in place, identified by `sessionId`. The
   * `patch` is applied to that session's stored `SessionConfig` only —
   * every other session in the file is untouched. `patch`'s type excludes
   * `sessionId` and `repoKey` (see `SessionConfigPatch` below): those two
   * fields are the identity a registry is keyed and indexed by (§3.1's
   * `byId`/`byRepoKey` maps), and this port has no rename semantics.
   * Changing a session's `sessionId` or `repoKey` is **unsupported** by
   * `SessionRegistry` today: `createSession` is append-only and cannot
   * touch an existing row, and there is no `deleteSession` (no port method
   * removes a row at all, by identity or otherwise). A caller cannot
   * reach a supported rename by composing the two documented methods —
   * `createSession` plus a delete that does not exist — so no caller may
   * be directed to do so. If session identity renaming is needed later, it
   * requires an explicit new port method (e.g. an atomic `renameSession`,
   * or a `deleteSession` paired with `createSession`) added under the same
   * review this document's other write methods received (§3.3); until
   * that method exists, no caller should be pointed at a raw
   * `sessions.json` rewrite to work around this gap.
   *
   * Rejects (no write) if `sessionId` does not exist, or if applying `patch` would
   * introduce a `sessionNo`/`aliases` collision with a *different* session
   * (the same reference-invariant check `createSession` performs, run
   * against the post-patch state) — and, like `createSession`, computed
   * from a fresh re-load/re-index of `sessions.json` immediately before the
   * check, not the instance's construction-time snapshot, so that two
   * `updateSession` calls issued back-to-back on the same instance (e.g. two
   * consecutive pause/resume patches) each see the effect of the one before
   * it rather than both validating against the same stale pre-first-write
   * state. Like `createSession`, this re-read-then-validate sequence must
   * run under the same exclusive, file-scoped lock `createSession`'s
   * docstring above defines (acquired before the re-read, released only
   * after the write, in a `finally`) — otherwise two `updateSession` calls
   * on *separate* registry instances (e.g. two concurrent processes patching
   * the same session, or one patching while another `createSession`s) race
   * the same way two concurrent `createSession` calls do, each re-reading
   * before either writes and silently discarding the other's change. Both
   * methods write the same file and therefore share one lock scoped to
   * `sessionsPath`, not one lock per method. This is the port pause/resume (§3.4)
   * writes through — never a raw file rewrite, and never routed through
   * `createSession`, which is append-only and has no concept of an
   * existing row to modify.
   *
   * Rejects (no write, `code: "identity-field-in-patch"`) if `patch`
   * carries an own `sessionId` or `repoKey` property at runtime — checked
   * as two separate calls, `Object.prototype.hasOwnProperty.call(patch,
   * "sessionId")` and `Object.prototype.hasOwnProperty.call(patch,
   * "repoKey")` (a union of string literals is a type, not a value, and is
   * not itself a valid `hasOwnProperty` argument), rejecting if either
   * returns `true`, before any field is applied. `SessionConfigPatch`'s `never`
   * fields (below) only block `.ts` callers passing a literal or a narrowly
   * typed variable; an `any`-typed value, a JS caller, or a variable widened
   * through a broader type has no compiler in the loop, so the
   * implementation must not skip this check on the assumption the type
   * already guarantees it.
   */
  updateSession(
    sessionId: string,
    patch: SessionConfigPatch,
  ): Promise<SessionWriteResult<SessionConfig>>;
}

/**
 * `SessionConfig` minus its two identity fields, with both re-declared as
 * forbidden (`never`). `sessionId` and `repoKey` are what
 * `SessionRegistry`'s indexes (§3.1) and `createSession`'s uniqueness checks
 * (§3.3) are keyed on; permitting them in an `updateSession` patch would let
 * a caller silently reassign a session's identity out from under
 * `byId`/`byRepoKey`/`#refIndex`; `repoKey` in particular is what
 * `resolveSessionForRepo` (§3.1) looks a session up by, so patching it to
 * collide with another session's `repoKey` would leave that lookup
 * ambiguous.
 *
 * `Omit<Partial<SessionConfig>, "sessionId" | "repoKey">` alone is not
 * sufficient: TypeScript's excess-property check only fires on a fresh
 * object literal passed directly as an argument, so a predeclared variable
 * typed as (or widened to) `Partial<SessionConfig>` that happens to carry a
 * `sessionId`/`repoKey` value remains structurally assignable to the
 * `Omit<...>` shape — the two properties are merely absent from the target
 * type there, not disallowed on the source. Re-adding both as
 * `sessionId?: never` and `repoKey?: never` closes that gap: assigning any
 * concrete value to a `never`-typed property is a type error everywhere,
 * not just an excess-property warning on literals, so it also catches
 * predeclared variables and spreads. This is still a compile-time-only
 * guarantee — untyped/`any` JS callers bypass it entirely — which is why
 * `updateSession` also runs the runtime `hasOwnProperty` check documented
 * on its docstring above; the type and the runtime check are both
 * required, neither substitutes for the other.
 */
export type SessionConfigPatch = Omit<
  Partial<SessionConfig>,
  "sessionId" | "repoKey"
> & {
  sessionId?: never;
  repoKey?: never;
};
```

`SessionWriteResult<T>` is a Session-local, discriminated-result shape —
structurally similar to #710 §3.1's `StoreResult<T>` (`{ ok: true, ... } |
{ ok: false, code, ... }`) but declared independently in `core/session.ts`,
not imported from `core/task.ts`. `StoreResult` is a `TaskStore` type whose
failure shape carries a task-specific `current?: AiTask` field; reusing it
here would make `SessionRegistry` depend on the Task domain, extending
Session's dependency on Task beyond the one pre-existing type-only `AgentId`
exception §10 already scopes (Session → `#710 Task ports` is
`type-only (AgentId)*`, not a blanket `✗`) into a second, broader
Task-domain type dependency this document does not sanction.
If a shared neutral result primitive is ever worth factoring out of both
`StoreResult` and `SessionWriteResult`, that factoring belongs in shared
infrastructure both domains already depend on (never one domain's module
importing the other's), but this document does not require that factoring —
each port keeps its own result type today.

### 3.4 Scope items named in the issue that do not exist today

The issue's scope line names "audit" and "pause/resume" alongside registry,
doctor, initialization, and configuration reads. **Neither exists in the
current codebase**: no `session audit` subcommand, no audit log/store for
sessions, and no `paused`/`pausedAt`/`resumedAt` field anywhere on
`SessionConfig`/`ResolvedSession`. Every "resume" hit in `admin.ts` (e.g.
`resolveResumeBranch`, `admin.ts:4530`) is git-branch/worktree resume-point
tracking on `AiTask`, unrelated to session lifecycle. This is the same
situation as Outbox's dead-letter operations (§7): the boundary is drawn in
advance of the feature. **If either is built later, it is Session's**
responsibility (audit: an append-only log keyed by `sessionId`, consumed
through a `SessionRegistry`-adjacent port, not a raw file; pause/resume: a
field on `SessionConfig` written through `SessionRegistry.updateSession`
(§3.3) — never through `createSession`, which is append-only and cannot
mutate a session that already exists, and never a fifth raw-file code path)
— no other module may grow session-lifecycle state to avoid this
consolidation.

## 4. Worktree module

### 4.1 No manager abstraction exists; logic is scattered across three files

There is no `WorktreeManager`-style constructed object. Free functions are
tied together only by `IssueWorktreeLock` (§5):

- `src/handlers/worktree.ts` — `listWorktrees`, `findWorktreeByPath`,
  `resolveIssueWorktree`, `removeWorktree`, `canonicalizePath`,
  `parseWorktreeList`, and the `IssueWorktreeLock` class itself (line 613).
- `src/core/worktree-paths.ts` — `resolveWorktreeRoot`, `issueWorktreeId`,
  `sessionWorktreeDir`, `issueWorktreePath`, `redactWorktreePaths`.
- `src/core/worktree-recovery.ts` — the pure classifier `assessWorktreeRecovery`.
- `src/cli/admin.ts` itself — real git-probe orchestration lives here rather
  than being delegated to a shared mechanism, e.g. `worktreeHasUnpushedCommits`
  (`admin.ts:3692`) and the discard reset/clean sequence (`admin.ts:4297-4315`).

This document does **not** mandate introducing a `WorktreeManager` class —
per DOMAIN.md §2.2's razor, worktree materialization/reconcile/cleanup are
already slated as "small shared services," not a manager object, when the
handlers-boundary work (#692, DOMAIN.md §5 item 2) lands. Operation's target
is narrower: every `worktree <action>` command depends on the free-function
module above through **named function imports**, never by re-implementing
git-probe logic inline in `admin.ts` — the two sites already doing so
(`worktreeHasUnpushedCommits`, the discard reset/clean sequence) are the
extraction targets for a later implementation issue, not new work this
document invents.

### 4.2 Per-command port surface (already read-only/mutating as marked; no behavior change)

| Command | Calls into (module) | Mutates? | Acquires Lock? |
| --- | --- | --- | --- |
| `worktree list` | `handlers/worktree.ts` (`listWorktrees`, `canonicalizePath`), `core/worktree-paths.ts` (`sessionWorktreeDir`) | No | No |
| `worktree prune` | `core/worktree-paths.ts` (`issueWorktreePath`), `handlers/worktree.ts` (`listWorktrees`, `removeWorktree`) | Yes (`--yes`) | No — relies on `git worktree remove --force`, not `IssueWorktreeLock` |
| `worktree recovery` | `handlers/worktree.ts` (`listWorktrees`), `core/worktree-recovery.ts` (`assessWorktreeRecovery`), `IssueWorktreeLock.inspect` (read-only) | **No** — diagnostic-only by design (`admin.ts:4420-4429`); prints guidance, including the follow-up `worktree release-lock ... --yes` command, but never calls it | Inspects only |
| `worktree cleanup` | `handlers/worktree.ts` (`listWorktrees`, `removeWorktree`), `IssueWorktreeLock.inspect` per candidate (read-only) | Yes (`--yes`) | Inspects only, does not acquire |
| `worktree release-lock` | `resolveIssueLockRelease` (shared helper, `admin.ts:3921-3966`) → `IssueWorktreeLock.inspect`/`.forceRelease` | Lock only | **Yes — this command's entire purpose is the Lock mutation** (owned by §5, not Worktree; kept in this table because its command name is `worktree ...`) |
| `worktree discard` | `handlers/worktree.ts` (`listWorktrees`), raw `git reset --hard`/`git clean -ffd` probes (`admin.ts:4297-4315`) | Yes (`--yes`) | **Conditionally — acquires `IssueWorktreeLock` before mutating** (`admin.ts:4238`) **unless `--force` is bypassing an already-live lock** (`isLiveLock`, `admin.ts:4235-4237`); a free or stale lock is still acquired even with `--force`. Releases in the failure/finally path (`4252`) when acquired |

`cleanup`, `discard`, and `prune` are three genuinely separate code paths,
not variants of one shared removal helper: `prune` and `cleanup` both end in
`removeWorktree`; `discard` never calls `removeWorktree` at all — it keeps
the worktree directory and resets its dirty state in place. A later
implementation must preserve this distinction (discard ≠ a lighter-weight
prune).

### 4.3 Not present: "worktree shell access"

The issue's scope line names "shell access" alongside lifecycle/cleanup/
recovery. **No such feature exists** — no interactive-shell/attach/spawn
action was found in `admin.ts` or `admin-ui.ts` (repo-wide grep for
shell-spawn-into-worktree patterns returns nothing). This is forward-looking,
like Session's audit/pause-resume (§3.4) and Outbox's operator controls
(§7): if built, it belongs to the Worktree module (it operates on a
worktree's filesystem path, not on lock or session state), and it must be
built as a distinct, explicitly-gated admin command (subject to
`admin-cli-contract.md`'s preview/`--yes` discipline) — not silently folded
into an existing command's option surface.

## 5. Lock module

### 5.1 One underlying store, two scope namespaces, one alias pair

There is exactly one lock **class**, `RepoLockStore`
(`src/stores/repo-lock-store.ts:54-393`) — a file-based, string-scoped
exclusive lock with `acquire` (63), `peek` (222), `inspect` (241),
`forceRelease` (263), `release` (329), and a default staleness TTL of 24h
(`DEFAULT_STALE_TTL_MS`, line 16, `DEFAULT_LOCK_DIR`, line 5). Everything
else built on top of it is a **scope convention**, not a second data
structure:

- **Repository lock** (`repo-lock acquire|release|status|force-release`) —
  scope is the bare `sessionId`; session-wide.
- **Issue lock** (`IssueWorktreeLock`, `handlers/worktree.ts:613-641`) — a
  thin wrapper delegating every method to the same `RepoLockStore`, scope
  `issueLockScope(sessionId, issueNumber)` = `<session>::issue-<n>`
  (`worktree.ts:605`), default lock dir `DEFAULT_WORKTREE_LOCK_DIR`
  (`worktree.ts:596`).
- **Review lock is not a distinct lock.** `review-lock status`/`release`
  operate on the exact same `IssueWorktreeLock` instance shape (same scope
  key) as `worktree release-lock` — confirmed by shared implementation, not
  just a docstring: `review-lock release` (`admin.ts:4402-4407`) calls the
  same `resolveIssueLockRelease` helper (`admin.ts:3921-3966`) that
  `worktree release-lock` (`admin.ts:3972-3979`) calls, and `review-lock
  status` (`admin.ts:4369-4385`) calls `.inspect()` on the same
  `IssueWorktreeLock` shape `worktree recovery`/`cleanup` already
  inspect (`worktree list` never constructs or inspects an
  `IssueWorktreeLock` at all — §4.2 marks it "No" for locks). They differ in
  **two** emitted JSON fields, not one: both
  `review-lock status` and `review-lock release` add `lockKind: "review"`
  *and* `reviewLockScope: issueLockScope(sessionId, issueNumber)`
  (`admin.ts:4381-4382`, `4411-4412`) — neither field is present on
  `worktree release-lock`'s output, and there is no `worktree lock-status`
  command to compare `review-lock status` against at all. `reviewLockScope`
  is not derivable from the other fields at zero cost (it re-serializes the
  scope key `IssueWorktreeLock` already computed internally to construct its
  lock-file path), so it is a real, intentional output difference — not
  incidental — and must not be dropped when a later implementation treats
  these commands as aliases (§12 item 7, §13).

`admin.ts` imports `RepoLockStore` as a **concrete class**
(`import { RepoLockStore } from "../stores/repo-lock-store.js"`,
`admin.ts:38`) and `IssueWorktreeLock`/`issueLockScope`/
`DEFAULT_WORKTREE_LOCK_DIR` from `handlers/worktree.js` (`admin.ts:70`). **No
`LockStore` interface/port exists anywhere in `src/`** — every reference to
"lock store" in the codebase names the concrete class.

### 5.2 `force-release` vs. `release`: bypass semantics

| Method | Owner check | Staleness check |
| --- | --- | --- |
| `RepoLockStore.release` (`repo-lock-store.ts:329`) | **Required** — caller-supplied `contextId` must match the current owner; mismatch → `not_owner` | None — owner-gated only |
| `RepoLockStore.forceRelease` (`repo-lock-store.ts:263`) | **Optional** — omitting `contextId` releases regardless of owner | **None at the store level** — it removes a live lock unconditionally if called |

The staleness/liveness gate that keeps `forceRelease` from silently breaking
a live holder lives **one layer up**, in `admin.ts`'s
`resolveIssueLockRelease` (`admin.ts:3921-3966`): a non-stale lock is refused
unless the caller passes `--force` (3934-3944); a stale lock proceeds through
the normal preview/`--yes` path (3947-3958). This two-layer split matters for
a target port: **the store-level `forceRelease` primitive intentionally has
no gate — it is a mechanism, not a policy** — and `resolveIssueLockRelease`'s
staleness policy is the piece that must move onto whatever port replaces
today's free function, not get flattened into the store method itself. Plain
`repo-lock force-release` (`admin.ts:2392-2404`) has **no** staleness gate at
all today — only a `--yes` requirement — which is a real asymmetry with the
issue-scoped commands (worktree/review release) worth flagging for a later
implementation to either close or explicitly ratify as intentional
(session-wide locks vs. per-issue locks may reasonably carry different risk
tolerances), not silently normalize.

### 5.3 Relationship to the phase-runner's lock hook — parallel, not shared, code path

`docs/DOMAIN.md` §2.2 documents `core/phase-runner.ts`'s `acquirePhaseLock`
hook (issue #440) as the in-band lock path for phase execution. Concretely:
the hook is wired at `run-one-phase.ts:411`
(`acquirePhaseLock: (task) => acquireIssuePhaseLock(...)`), calling
`acquireIssuePhaseLock` (`run-one-phase.ts:84-124`), which calls
`.acquire()`/`.release()` (95, 110) on its own `IssueWorktreeLock` instance
(`run-one-phase.ts:379`). The hook's contract is declared at
`core/phase-runner.ts:244` and invoked at `phase-runner.ts:343-344`.

**Admin's lock commands share the same `IssueWorktreeLock` class but never
go through this hook** — they call `.inspect()`/`.forceRelease()` directly
for operator recovery, an out-of-band path by design (an operator recovering
a stuck lock is, definitionally, not going through the normal phase
lifecycle). This is the correct shape and this document does not change it;
it is recorded here so a later implementation does not "fix" it by routing
admin's lock commands through the phase-runner hook, which would make
recovery depend on the very lifecycle it is meant to unstick.

`src/handlers/review.ts:886` and `src/handlers/conflict-resolution.ts:936`
also construct `IssueWorktreeLock` directly, as an in-handler fallback when
no lock is threaded in — a **third** call-site pattern. Deleting this
fallback pattern in favor of always routing through the phase-runner's lock
hook is the "lock asymmetry" DOMAIN.md §2.2 already flags as
resolved-in-principle ("extend the runner's lock hook to review/conflict and
delete in-handler acquisition"), and stays owned by the handlers-boundary
derived issue (DOMAIN.md §5 item 2), not by Operation's contract. §5.5's
constructor change still requires a mechanical, non-behavioral update at
this call site and at `run-one-phase.ts:379` so `IssueWorktreeLock(...)`
keeps compiling after the constructor changes — that narrow compile-fix is
in scope here; the fallback pattern's removal is not.

### 5.4 admin-ui.ts: shares the read path, shells out for the write path

`admin-ui.ts` constructs its own `IssueWorktreeLock()` at `:1876` (no
`--lock-dir` override, unlike every `admin.ts` site, which threads it) and
calls `.inspect()` in-process for status display — same class, same
semantics as `admin.ts`. For the write path, it does **not** call
`resolveIssueLockRelease` directly: `buildLockReleaseArgv()`
(`admin-ui.ts:462-477`) constructs argv for `admin worktree release-lock
--yes [--force]`, and the UI shells out via `runAdminCommand()` (§6.3) — the
"Release stale worktree lock" / "Force-release LIVE worktree lock" menu
items (`admin-ui.ts:1416-1430`) both route through the real CLI subprocess
rather than duplicating the release logic in-process.

This missing override is recorded as a **gap, not a target this document
requires closing**: `parseUiArgs` (`admin-ui.ts:754-768`) has no `--lock-dir`
value flag today, and §13's preservation guarantees rule out changing an
existing command's argv shape as an incidental side effect of a type-
annotation/construction-ownership change. Adding `--lock-dir` to `admin ui`
is a new public CLI option — that addition, if ever done, is
`admin-cli-parsing-contract.md`'s (#709) to specify and route, not
something this document can require the UI's constructed lock to already
honor. §12's test list reflects this: it requires a single-construction
test for the registry (§6.1), but does not require a `--lock-dir`
conformance test here, since the option does not exist to conform to.

### 5.5 Target port

```ts
export type PeekResult =
  | { held: true; contextId: string; startedAt: string }
  | { held: false };

export interface LockStore {
  acquire(contextId: string, scope: string, now?: string): AcquireResult;
  release(contextId: string, scope: string): ReleaseResult;
  /** Owner-agnostic when contextId is omitted — see §5.2 for the policy split. */
  forceRelease(scope: string, contextId?: string): ForceReleaseResult;
  inspect(scope: string, now?: string): InspectResult;
  peek(scope: string, now?: string): PeekResult;
}
```

Every method name, parameter (name, order, optionality), and return type
here is copied verbatim from `RepoLockStore` (`repo-lock-store.ts:63` acquire,
329 release, 263 forceRelease, 241 inspect, 222 peek) — including staying
**synchronous** (the store does blocking `fs` calls, not I/O promises) and
reusing its exported `AcquireResult`/`ReleaseResult`/`ForceReleaseResult`/
`InspectResult` types (`repo-lock-store.ts:31-49`). `PeekResult` is added
here because `peek`'s return type is inline in the source rather than a
named export; extracting it is the only new surface this port introduces.
`scope` is this document's term for what `RepoLockStore` itself calls
`sessionId` — the parameter is session-scoped for the repository lock and
`issueLockScope(sessionId, issueNumber)`-scoped for the issue lock (§5.1);
the port keeps the neutral name so both callers type-check against it
without implying the argument is always a literal session ID.
`runQuarantineStatus`'s `lockStore.peek(sessionId)` call (`admin.ts:2548`)
is the reason `peek` is in the port at all: without it, that handler could
not be typed against `LockStore` and would need to keep importing the
concrete class.

This port is typed against `RepoLockStore`'s **direct** consumers only: the
four `repo-lock` commands (`acquire`/`release`/`status`/`force-release`,
whose scope is always the bare, caller-precomputed `sessionId`) and
`runQuarantineStatus`'s `lockStore.peek(sessionId)` (`admin.ts:2548`). With
every signature matched, `RepoLockStore` implements this interface
structurally with **no adapter and no call-site changes** for that
consumer set — the migration is just typing those consumers against
`LockStore` instead of `RepoLockStore`, the same concrete-vs-interface fix
§3.3 makes for sessions.

**`IssueWorktreeLock` consumers do not type against `LockStore` — they keep
typing against `IssueWorktreeLock` itself.** `IssueWorktreeLock`
(`handlers/worktree.ts:613-641`) is not structurally compatible with
`LockStore`: its methods take `(ownerId, sessionId, issueNumber, now?)` /
`(sessionId, issueNumber, now?)` — the caller's raw session/issue pair,
not a precomputed `scope` string — and it exposes no `peek` method at all
(nothing in `src/` calls `.peek()` on an `IssueWorktreeLock`; only
`runQuarantineStatus`'s direct `RepoLockStore` call above does). Forcing
`worktree release-lock`/`discard`/`list`/`recovery`/`cleanup`,
`review-lock status`/`release`, the `status` aggregator (`admin.ts:3395`),
or `admin-ui`'s read path (§5.4) onto the `LockStore` shape would require
every one of those call sites to precompute `issueLockScope(sessionId,
issueNumber)` itself and drop the `ownerId`-first argument order they call
today — a real call-site change this document does not require. Instead,
`IssueWorktreeLock` stays exactly the scope-key convenience wrapper it is
today (§5.1) and remains the port those consumers type against; it does
not need its own interface declaration, for the same reason #710 §3
rejected a rival `TaskStore` — one underlying table (here: one lock file
format), one port, reached through two typed entry points (`LockStore` for
scope-precomputed callers, `IssueWorktreeLock` for session/issue-pair
callers) instead of one.

The change `IssueWorktreeLock` needs is at its constructor, not just its
private field's declared type. Today it takes `(lockDir: string =
DEFAULT_WORKTREE_LOCK_DIR, staleTtlMs?: number)` and builds `this.#store =
new RepoLockStore(lockDir, staleTtlMs)` itself (`worktree.ts:616-617`) —
retyping `#store` to `LockStore` alone leaves that `new RepoLockStore(...)`
call in place, so `IssueWorktreeLock` still imports and constructs Lock's
concrete adapter internally, which is exactly the dependency §9's
construction-ownership rule forbids (Worktree module — `IssueWorktreeLock`
lives in `handlers/worktree.ts` — building another resource module's
concrete adapter). Closing it requires the constructor to receive an
already-constructed `LockStore` instead of primitive `lockDir`/`staleTtlMs`
arguments: `constructor(store: LockStore)`. The composition root (§9,
`main()`) builds this store from that call site's own resolved
**worktree**-lock directory — `DEFAULT_WORKTREE_LOCK_DIR` (§5.1) unless the
command's own flag overrides it — never from a `RepoLockStore` built for a
`repo-lock`/repository-lock operation, even one constructed earlier in the
same invocation: the two namespaces default to different directories
(`DEFAULT_LOCK_DIR` vs. `DEFAULT_WORKTREE_LOCK_DIR`, §5.1), so reusing one
`LockStore` instance for both would point `IssueWorktreeLock` at the wrong
directory and is not a valid application of §9's one-construction-per-need
rule — that rule dedupes construction of the *same* resource, and the repo
lock and the issue lock are two different resources even though they share
one class. This is a real call-site change, not the type-only
`LockStore`-vs-`RepoLockStore` fix this section makes for `RepoLockStore`'s
direct consumers: every `new IssueWorktreeLock(...)` call inside
`admin.ts`/`admin-ui.ts` in scope here (`admin.ts:3558,3757,3976,4205,4385,4407,4660`;
`admin-ui.ts:1876`) becomes `new IssueWorktreeLock(new
RepoLockStore(<worktree-lock-dir>, staleTtlMs))` at that composition-root
call site, where `<worktree-lock-dir>` is that site's own worktree-lock-dir
value — the local `lockDir` parsed from that command's `--lock-dir` flag at
every site except `admin.ts:3558`. `admin.ts:3558` (`status`) is the one
call site where this is **not** `lockDir`: `status` parses two independent
directories (§1's `--lock-dir` and `--worktree-lock-dir` flags, `admin.ts:2917`),
and its local `lockDir` (used at `admin.ts:3559` to build the *repository*
lock's `RepoLockStore` for `repoLock`) is a different directory from
`worktreeLockDir` (used at `admin.ts:3558` today to construct the
`IssueWorktreeLock` itself). `status`'s composition-root call must build
`IssueWorktreeLock`'s `RepoLockStore` from `worktreeLockDir`, not `lockDir` —
building it from `lockDir` (or from a `RepoLockStore` already built for
`repoLock`) would make `status` inspect the repo-lock directory instead of
the worktree-lock directory, silently diverging from every other
`IssueWorktreeLock` consumer (`worktree release-lock`, phase execution, and
the other six call sites above) and from `status`'s own recovery hints
(`admin.ts:3565-3566`, which already special-case `worktreeLockDir` for this
exact reason). This divergence is the concrete failure mode a later
extraction must not introduce: `status` reporting a lock as free (or a
recovery hint pointing at the wrong `--lock-dir`) because it inspected a
directory nothing else touches.

A `constructor(store: LockStore)` signature change is not scoped to
`admin.ts`/`admin-ui.ts` callers — every `new IssueWorktreeLock(...)` call
anywhere in `src/` must satisfy the same signature or the build fails to
compile, regardless of which document owns that call site's deeper
behavior. Three more calls exist outside `admin.ts`/`admin-ui.ts` and
outside §1's command surface — `run-one-phase.ts:379`,
`handlers/conflict-resolution.ts:936`, and `handlers/review.ts:886` — and
this document's migration must keep all three compiling even though it does
not otherwise change their behavior (the deeper "delete in-handler
acquisition, extend the phase-runner lock hook instead" fix stays owned by
DOMAIN.md §5 item 2, per §5.3):

- `run-one-phase.ts:379` is itself a composition root — the CLI entry point
  for one phase-runner invocation, distinct from `admin.ts`'s. It gets the
  same treatment as an `admin.ts` site: that line becomes `const issueLock =
  new IssueWorktreeLock(new RepoLockStore(DEFAULT_WORKTREE_LOCK_DIR))`,
  reusing the one instance for both the phase-lock hook (§5.3) and, per the
  one-construction-per-need rule, threading it into `createPhaseHandlers`'s
  `createReviewHandler`/`createConflictResolutionHandler` calls (`:318-319`,
  which pass `undefined` for the lock argument today) instead of leaving
  those two handlers to construct their own.
- `handlers/conflict-resolution.ts:936` and `handlers/review.ts:886` each
  guard their construction with `issueLock ?? new IssueWorktreeLock()` — a
  fallback for callers that do not thread a lock in, which today includes
  the bulk of `conflict-resolution-handler.test.js`/`review-handler.test.js`
  (calling the handler with no 3rd/4th lock argument). With
  `run-one-phase.ts` now always supplying an explicit `issueLock` (previous
  bullet), production traffic never reaches this fallback, but it still has
  to typecheck and is still exercised by every test that omits the
  argument. Each fallback becomes `issueLock ?? new IssueWorktreeLock(new
  RepoLockStore(DEFAULT_WORKTREE_LOCK_DIR))` — the same default `lockDir`
  the no-argument constructor resolves to today, so behavior for every
  existing test that hits this branch is unchanged. This is a mechanical
  fix local to the fallback expression (plus the matching `RepoLockStore`/
  `DEFAULT_WORKTREE_LOCK_DIR` import in each file), not a broader refactor
  of either handler's construction pattern.

`#store`'s field type becomes `LockStore` as before, but the type change
alone does not close the gap without this constructor change, at all eleven
call sites above (seven in `admin.ts`, one in `admin-ui.ts`, three outside
both) — not just the `admin.ts`/`admin-ui.ts` subset.

## 6. UI module (`admin ui`)

### 6.1 Composition root and its concrete-class dependencies

`runAdminUi` (`admin-ui.ts:1819-1900`) is where every concrete dependency
for one `admin ui` invocation is constructed today. Per §9.2's decision
below, this makes it part of `main()`'s single composition root, not a
second composition root of its own — but the construction problems
recorded here (duplicate registry, missing `--lock-dir`) are unchanged
either way:

- `const store = new SqliteTaskStore(parsed.dbPath)` (`:1882`) — the
  concrete class, not `TaskStore` (#710's port). Threaded into
  `interactiveLoop` (`:1884`) and from there into every screen that touches
  storage.
- `const issueLock = new IssueWorktreeLock()` (`:1876`) — wrapped in a
  `lockReader` closure (`:1877-1880`).
- `JsonSessionRegistry` is constructed **twice** for one invocation, but only
  in the **unfiltered** path. `resolveSessionIds` (`:776-789`) has three
  branches: `--session-id` returns early with no registry construction at
  all; `--session-ref` resolves through the standalone `resolveSessionRef`
  function, not the registry class; only the neither-filter branch (list
  every session) constructs a `JsonSessionRegistry` (`:789`) to call
  `.listSessions()`. `runAdminUi` then unconditionally constructs a
  **second** `JsonSessionRegistry` (`:1845`, gated only on
  `existsSync(parsed.sessionsPath)`, not on which filter branch ran) to build
  the GitHub-issue-state `sessionMap`. So the duplicate-construction problem
  is real only when no `--session-id`/`--session-ref` filter is given and
  `sessions.json` exists: `--session-id` yields at most one construction
  (`runAdminUi`'s, if the file exists — needed even for a single explicit
  session, since `sessionMap` still needs that session's `githubRepo`/
  `repoRoot`/auth), and `--session-ref` likewise yields at most one. A later
  implementation's fix (thread `resolveSessionIds`'s registry through to
  `runAdminUi` instead of reconstructing) must not be generalized into "the
  UI never constructs a registry when a filter is passed" — `runAdminUi`'s
  own construction is doing needed work in the filtered branches too, and is
  not deletable, only shareable with the unfiltered branch's.
- `store.close()` runs on both normal exit (`:1898`) and on `UiCancelled`
  (`:1890`).

Every store-typed screen function in the file is typed `store:
SqliteTaskStore` (the concrete class) — `collectActiveTasks` (`:189`,
already flagged by #710's ports-contract doc as needing to migrate to
`TaskStore`), `interactiveLoop` (`:1657`), `taskMenu` (`:1457`), `showEvents`
(`:1195`), `closedTaskMenu` (`:1557`), `closedTaskList` (`:1596`). No import
of the `TaskStore` interface exists anywhere in `admin-ui.ts`. This
document's target: every one of these signatures becomes `store: TaskStore`
once #710's port work lands — a pure type-annotation change (the interface
already covers every method the UI calls), owned jointly by #710 (defines
the port) and this document (declares the UI must consume it, not the
concrete class).

### 6.2 Three invocation categories, not two

The UI's state-changing actions fall into three categories — the third is
easy to miss because it looks like the first two:

1. **Shell out to the real CLI** (`runStateChange` → `runAdminCommand`
   `:1185`, calling `execFileSync` on the compiled `admin.js`,
   `:824-848`): `recover` (`:1477`), `cap-reset` (`:1481`), `lock-release`
   (`:1491`), `lock-force-release` (`:1509`), and the `status` menu action
   (`:1512-1514`, read-only but still shells out rather than reading
   in-process).
2. **Call the store directly, in-process**: `collectActiveTasks` (`:189`,
   `store.listTasks`), `interactiveLoop`'s pre-menu refresh (`:1793`,
   `store.getTask`), `closedTaskList` (`:1622`, `store.getTask`),
   `showEvents` (`:1195-1196`, `store.listEvents`).
3. **Print-only, never execute**: `showToolRequestCommands` (`:1292`) and
   `showHumanReviewReturnCommands` (`:1330`) call `formatAdminCommand(...)`
   to render a copy/paste string for the operator to run themselves — the UI
   never invokes `execFileSync` or the store for these. A later
   implementation must preserve this three-way split exactly: collapsing
   category 3 into category 1 (auto-executing what is currently
   print-only) or category 2 (bypassing the subprocess boundary for
   currently-shelled-out mutations) is new behavior, not a refactor.

### 6.3 `admin.js` subprocess dependency — cross-reference, not restated

`adminEntrypoint()`/`runAdminCommand()` (`admin-ui.ts:824-848`) resolve and
invoke a sibling `admin.js` next to the compiled `admin-ui.js`. #708 §8
already documents this as the one sanctioned reverse-shaped dependency (a
build-layout/subprocess dependency, not a TypeScript import cycle) and the
preservation requirement (a decomposition that moves `admin.ts` must keep a
same-relative-path `admin.js` entrypoint or update these two functions in
lockstep). This document does not restate that contract; it only confirms
category-1 actions above (§6.2) are exactly the actions #708 §8 already
covers.

### 6.4 No polling; refresh is operator-triggered

No `setInterval`/`setTimeout`/polling exists anywhere in `admin-ui.ts`. The
"refresh" menu action (`interactiveLoop`, `:1771-1779`) re-verifies GitHub
issue open/closed state via `populateStateCache`/`issueStateReader` — a
GitHub-state cache refresh, not a store re-read. The active task list itself
(`collectActiveTasks`) is already re-run unconditionally on every loop
iteration (`:1693`), so store data is effectively re-fetched on every render
regardless of the refresh action.

## 7. Outbox module (forward-looking)

**No current `admin.ts` command inspects, retries, cancels, or dead-letters
outbox rows.** Confirmed by exhaustive grep: every `SqliteOutboxStore`
construction in `admin.ts` (5 sites: `5783, 6102, 6648, 7104, 7937`, always
paired 1:1 with a `SqliteTaskStore` in the same function) is
**producer-side** — it enqueues a GitHub comment/label effect
(`workItemOutbox(...).enqueue(...)`) as part of a task/handoff mutation
already owned by #710, then closes the connection. `dispatch-outbox` remains
a **catalog-only external entrypoint** (`admin.ts:228-230`, `entrypoint:
"dist/cli/dispatch-outbox.js"`), never matched by `main()`'s dispatch chain
(`admin.ts:10316-10563` has no branch for it) — #708 §2.1's classification is
still accurate.

This matches `docs/DOMAIN.md` §2.3 Delivery: "Operator controls
(list/requeue dead-letter rows) are #607." **#606's retry/backoff/DLQ
*mechanics* are already built** (confirmed in `src/core/outbox.ts`/
`src/stores/sqlite-outbox-store.ts`, not merely planned): `OutboxEntry`
carries `attemptCount`, `lastError`, `nextAttemptAt`, and `deadLetterAt`
(`outbox.ts:168-192`); `markFailed` (`outbox.ts:272`,
`sqlite-outbox-store.ts:202-229`) increments the attempt count, schedules
bounded backoff (`computeOutboxBackoffMs`, `outbox.ts:339`), and sets
`deadLetterAt` once `OUTBOX_MAX_ATTEMPTS` (`outbox.ts:325`, `= 8`) is
exhausted. What #607 is still missing is the **operator-facing surface**
*and* the store methods it needs that do not exist yet — because every
current read method actively **excludes** dead-lettered rows rather than
exposing them: both `listPending` and `listPendingEntries`' SQL filter on
`dead_letter_at IS NULL` (`sqlite-outbox-store.ts:124,165,168,188`) — there
is no query that returns *only* dead-lettered rows, and no write method
resets `deadLetterAt`/`attemptCount` to requeue one. **This section exists
so the boundary is drawn before #607 adds those methods and their first
command**, the same reasoning as Session's audit/pause-resume (§3.4) and
Worktree's shell access (§4.3).

**Target ownership, when built:** any future `outbox list|retry|cancel|
dead-letter` (or similarly named) admin command must be typed against the
`OutboxStore` interface (`src/core/outbox.ts:205-298`) — never against
`SqliteOutboxStore` directly. `workItemOutbox()`
(`core/outbox-effects.ts:171`) already demonstrates the correct pattern
(typed `(outboxStore: OutboxStore, ...)`, per #710 §1's own citation of it);
a future Outbox admin command inherits that pattern rather than inventing a
new one. Inspection of *pending, non-dead-lettered* rows is already fully
served by `listPending`/`listPendingEntries`; #607 still needs to add, on
`OutboxStore` itself (one table, one port; same rule §3.3 and §5.5 apply,
never a rival `OutboxAdminPort`): a query for dead-lettered rows (the mirror
image of the existing `dead_letter_at IS NULL` filter), and a requeue/retry
write method that clears `deadLetterAt` and resets `attemptCount`/
`nextAttemptAt` for a specific row id. A `cancel` operation (removing a
still-pending, not-yet-dispatched row before it ever sends) has no existing
analog on the interface at all and is likewise #607's to design — this
document only fixes where it must live once designed.

## 8. Maintenance-catalogued resource groups

### 8.1 Maintenance: quarantine + interventions + status aggregation

**`quarantine status`/`quarantine clear`** (`runQuarantineStatus`,
`admin.ts:2521-2545`; `runQuarantineClear`, `admin.ts:2589-2611`) read/write
a **filesystem marker file** (`QUARANTINE_FILENAME`, `admin.ts:2530`/`2603`)
directly, plus acquire a `RepoLockStore` guard (`admin.ts:2545`/`2611`,
covered by §5). Per `docs/DOMAIN.md` §2.3, quarantine markers are
**Execution-owned state** ("quarantine markers (until #699)"), and Operation
reaching into another context's internal filesystem state directly — rather
than through a port that context exposes — is exactly what the dependency
matrix forbids ("reaching into internals ... is forbidden"). **This is a
live boundary violation, not a hypothetical one.** No port exists today to
close it; this document does not invent a new one either (a marker-file port
is a small, mechanical addition better scoped alongside whatever eventually
implements #699's quarantine-backstop removal, since `per-issue-worktrees.md`
already ties the marker's fate to that work) — it records the violation so a
later implementation issue is scoped to fix it, rather than treating the
direct `existsSync`/marker-path read as acceptable prior art to copy for a
new command.

**`interventions`** (`runInterventions`, `admin.ts:10214-10246`) is the one
command in scope that bypasses every store abstraction entirely: it opens
its own raw `better-sqlite3` `Database` handle (`admin.ts:10239`, `{
readonly: true }`) and hands it directly to `aggregateL3Interventions(db,
sessionId, ...)` (`core/l3-intervention-aggregation.ts`, imported
`admin.ts:33-37`), rather than going through `TaskStore`/`OutboxStore`. This
is a second, independent instance of the same "Operation reaching into
internals" pattern quarantine exhibits — flagged for the same reason,
without inventing a fix here (the read-only `Database` handle is at least
less risky than a write-capable raw connection, but the boundary violation is
the same in kind).

**`status`** (top-level, `runStatus`, `admin.ts:3533-3591`) is a pure
**read-only aggregator** over three other contexts' already-public state:
`RepoLockStore.inspect` (3559, §5), `IssueWorktreeLock`/`listWorktrees`
(3554-3556, §4/§5), and `SqliteTaskStore` (3591, #710). It has no state or
logic of its own to extract — it is Maintenance only in the sense that it is
the composite view an operator reaches for first; a later implementation
should keep it as a thin fan-out over the other modules' read ports (once
they exist), not grow it into a fourth place that re-implements
lock/worktree/task reads.

### 8.2 Content: already the best-isolated group

`context create` (`SqliteContextStore`, `admin.ts:1629`, class at
`stores/sqlite-context-store.ts:24`), `context-mode status`
(`context-mode-status.ts`), `issue-discuss preview|post`
(`issue-discuss.ts`), and `issue-plan preview|ai-preview|evaluate-history`
(`issue-plan.ts`/`issue-plan-ai.ts`/`issue-plan-history.ts`) each already
live in their own dedicated module, imported by `admin.ts` as named
functions rather than reimplemented inline — the pattern every other group
in this document is being pushed toward. Per `docs/DOMAIN.md` §2.3, this
maps to the **Intake** context ("planning artifacts and the issue-plan
history store"). No extraction work is proposed for this group; it is
inventoried here only so the ownership map (§2) has no gap, matching #710
§2.1's treatment of `context create` as in-scope-for-inventory,
out-of-scope-for-change.

### 8.3 Metrics: not part of this surface

`grep -i metrics src/cli/admin.ts` returns zero matches. `npm run metrics`
(`package.json:16`) invokes `scripts/metrics.mjs` directly — a fully separate
script and composition root, never registered in `COMMANDS` or reachable
through `main()`'s dispatch. It is not an "admin subcommand" and therefore
outside this document's ownership map (§2) by definition, not by omission.

### 8.4 Notification: does not exist as an admin resource

No `admin.ts` command manages notification delivery/state today (Slack
notification configuration is session config, not an admin command — see
the existing memory note on `slack:notification` outbox rows). Per
`docs/DOMAIN.md` §2.3, notification delivery is a **Delivery** concern
(outbox dispatch + visibility/redaction), already covered structurally by
§7's Outbox section. **If an operator-facing notification command is ever
added, it is Outbox's, not a new module** — notifications are one more kind
of outbox row, not a separate resource with its own state.

## 9. Construction ownership: composition roots

### 9.1 Current state: no centralization

`admin.ts` constructs the same concrete classes independently, once per
command function, rather than once per process:

| Class | Sites in `admin.ts` | Centralized? |
| --- | --- | --- |
| `SqliteTaskStore` | 16 (`851,977,1194,1365,1517,3591,3756,4176,4596,4860,5782,6101,6647,7008,7103,7936`) | No |
| `SqliteOutboxStore` | 5 (`5783,6102,6648,7104,7937`) | No — always paired 1:1 with a `SqliteTaskStore` in the same function |
| `JsonSessionRegistry` | 6 (`4840,5702,6071,6625,7088,7925`) | No |
| `SqliteContextStore` | 2 (`1629`, plus the shared `resolveSessionIdFromContext` helper at `2299` used by `repo-lock acquire`/`release`) | Partial |
| `RepoLockStore` | 8 (`2312,2323,2356,2403,2545,2611,3559,7946`) | No |
| `IssueWorktreeLock` | 7 (`3558,3757,3976,4205,4385,4407,4660`) | No |
| raw `Database` (`better-sqlite3`) | 1 (`10239`, `interventions`, read-only) | N/A — direct bypass, §8.1 |

`admin-ui.ts` does **not** reuse any of `admin.ts`'s construction — it has
its own independent set: `JsonSessionRegistry` (`:789` and `:1845`,
duplicated within one invocation), `IssueWorktreeLock` (`:1876`, missing the
`--lock-dir` override every `admin.ts` site threads), `SqliteTaskStore`
(`:1882`).

Provider construction (GitHub/Gitea) is the **one already-correct example**:
`admin.ts` never calls `new <Provider>(...)`; it calls factory functions
(`resolveSessionRepoHost`, `admin.ts:5459`; `resolveGhRunner`,
`admin.ts:6682`) that return the right adapter for the session's configured
provider. Every module in this document should converge on that shape, not
invent a new one.

### 9.2 Decision: one composition root per process entry point, not one per command

This document's construction-ownership scope covers **five** process entry
points, one composition root each — not the two `admin.ts`/`run-one-phase.ts`
roots alone. `src/cli/github-intake.ts`, `src/cli/enqueue-task.ts`, and
`src/cli/dispatch-outbox.ts` are each a separate executable (own
`isMain`/`import.meta.url` guard, own `main()`), never dispatched through
`admin.ts`'s `COMMANDS`, and each already constructs operational adapters
directly in its own `main()`: `github-intake.ts` builds `JsonSessionRegistry`
(`:330`), `SqliteTaskStore`/`SqliteOutboxStore` (`:468-469`), and
`SqliteContextStore` (`:317`); `enqueue-task.ts` builds `JsonSessionRegistry`
(`:148`) and `SqliteTaskStore` (`:192`); `dispatch-outbox.ts` builds
`SqliteContextStore` (`:131`), `JsonSessionRegistry` (`:202`), and
`SqliteOutboxStore` (`:456`). Each is already a self-contained composition
root today — points 1-3 below describe the two roots this document requires
*changes* to (`admin.ts`'s per-command construction consolidating into
`main()`, and `run-one-phase.ts`'s missing `LockStore` injection); these
three intake/enqueue/dispatch entry points already construct once per
process at their existing `main()`, so no further consolidation work is
required of them here — they are in scope for the "one root per process
entry point" inventory, but out of scope for point 1-3's remediation because
they have no per-command duplication to fix. `admin ui`
currently runs in-process — `admin.ts` imports `runAdminUi` directly
(`admin.ts:99`) and its `ui` command handler `await`s it (`admin.ts:10312`)
— so `runAdminUi` is **not** a sixth composition root; it is `main()`'s
in-process UI handler, and (per point 2 below) must receive its constructed
ports as parameters from `main()` exactly like every other command handler
in point 1. Splitting `admin ui` into its own process entry point — which
would make `runAdminUi` its own composition root alongside the ones
named above — is new work this document does not require; if a later
implementation makes that split, this section's five-root inventory must be
revisited explicitly, not assumed to still hold:

1. **`admin.ts`'s `main()`** is the composition root for the non-interactive
   CLI. Target: each command handler receives its constructed ports as
   parameters from `main()`, instead of constructing its own copy inline —
   but **which** ports a given handler receives is driven by what that
   handler actually calls today, never a fixed set of all four
   (`TaskStore`, `OutboxStore`, `SessionRegistry`, `LockStore`) constructed
   for every command regardless of need. This mirrors the provider pattern
   (§9.1) already in place — `main()` resolves *which* concrete adapter a
   command needs and hands it the typed port, the same way it already
   resolves *which* provider a command needs via
   `resolveSessionRepoHost`/`resolveGhRunner`; a command whose handler never
   calls `SessionRegistry` gets no `SessionRegistry` constructed on its
   behalf, exactly as a command with no repo-host provider gets no
   provider resolved.

   **Exception: `session-init` receives a factory, not a constructed
   registry.** Every other command that *does* depend on `SessionRegistry`
   has its precondition (a readable `sessions.json`) already hold by the
   time `main()` dispatches, so eager construction in `main()` is safe for
   them. `session-init` is the one command whose entire job (§3.3) is to
   satisfy that precondition on a fresh install — `sessions.json` may not
   exist yet. If `main()` eagerly constructs `JsonSessionRegistry` before
   calling `runSessionInit`, the fresh-install path breaks before the
   handler that is supposed to create the file ever runs. `main()` must
   instead pass `session-init` a `SessionRegistry` **factory** (a zero-arg
   function returning the port, e.g. `() => new
   JsonSessionRegistry(sessionsPath)`) and let `runSessionInit` invoke it
   only after its own bootstrap step (creating an empty `sessions.json`
   with an empty `sessions` array, plus any missing parent directory) has
   run. This is exactly what the fresh-install bootstrap test in §12 item 2
   pins.

   **`repo-lock force-release` and `interventions` receive no
   `SessionRegistry` at all — eagerly, lazily, or via a factory.** Both
   take an explicit `--session-id` and never a `--session-ref`
   (`parseRepoLockForceReleaseArgs`, `admin.ts:2377-2391`;
   `parseInterventionsArgs`, `admin.ts:10137-10162`), so neither ever
   resolves a session reference against `sessions.json`, and neither reads
   any other session field either: `runRepoLockForceRelease` constructs
   only a `RepoLockStore(lockDir)` from the given `--lock-dir`;
   `runInterventions` opens a raw read-only `Database` from the given/
   default `--db-path` (its raw-`Database` bypass is already noted in
   §9.1/§8.1) and touches no session state at all. Today, both commands
   work on a fresh install with no `sessions.json` on disk — constructing
   `SessionRegistry` in `main()` before dispatching to either would break
   that, for a file the command never reads, which is the same
   fresh-install hazard the `session-init` exception above exists to avoid.
   This is not a third named exception so much as a restatement of the rule
   point 1 opens with: `main()`'s port construction is per-command, driven
   by what that command's handler actually calls — the enumerated
   exceptions above are the two places today's codebase makes that concrete
   for `SessionRegistry` specifically (a fresh-install command that must
   defer construction, and two commands that never need the port at all),
   not an exhaustive list a future command must re-derive from scratch.
   Every command's handler keeps the eager-construction rule for the ports
   it *does* use; only the `SessionRegistry` cases just described are
   lazy or absent.
2. **`admin-ui.ts`'s `runAdminUi()`** is `main()`'s in-process UI handler,
   not a sixth composition root — the decision this section opens with,
   restated at its call site. `admin.ts` imports `runAdminUi` directly
   (`admin.ts:99`) and the `ui` command handler `await`s it in-process
   (`admin.ts:10312`); target: `runAdminUi` receives its constructed ports
   as parameters from `main()`, the same way point 1 requires for every
   other command handler, instead of constructing its own copies (§6.1's
   duplicate `JsonSessionRegistry`, §5.4's missing `--lock-dir` thread) —
   that parameter-passing fix is what "one composition root per entry
   point, constructed once" requires here.

   **This must not move port construction ahead of `runAdminUi`'s existing
   non-TTY guard.** Today, `runAdminUi` parses its own argv and checks
   `isInteractive()` (`admin-ui.ts:1819-1828`) *before* touching
   `sessions.json` or opening the database — a non-interactive caller (no
   TTY) gets the documented help text and exit code 2, never a
   `JsonSessionRegistry`/`Database` construction attempt. If `main()`
   eagerly constructs those ports and passes them into `runAdminUi` as
   already-built values — the naive reading of "receives its constructed
   ports as parameters" — that construction now runs unconditionally for
   every `admin ui` invocation, non-TTY included: `admin ui --session-id x`
   with no TTY and no `sessions.json` on disk would fail during
   `JsonSessionRegistry` construction inside `main()`, before `runAdminUi`
   is even called, instead of returning the documented exit-2 help
   response. This is the same fresh-install/precondition hazard point 1's
   `session-init` exception exists to avoid, applied to the UI's TTY
   precondition instead of a file-existence one. The fix is the same shape:
   `main()` still owns construction (no sixth composition root), but what
   it hands `runAdminUi` are **deferred factories**, not already-constructed
   ports — zero-arg functions `runAdminUi` invokes only *after* its own
   `parseUiArgs`/`isInteractive` preflight passes. `runAdminUi`'s argument
   list and internal guard ordering are unchanged; only the origin of the
   values its guard currently constructs inline moves to `main()`-supplied
   factories, invoked at the same point in the control flow the inline
   constructor calls occupy today. `main()` itself performs no TTY check —
   it is not the one deciding whether to run the UI, only what to hand it
   if the UI decides to proceed. This is distinct from the `admin.js`/
   `admin-ui.js` subprocess relationship §6.3 documents, which goes the
   *other* direction (`admin-ui.ts`'s category-1 actions shelling out to
   `admin.js`, per #708 §8) and is unaffected by this point. Splitting
   `admin ui` into its own process entry point — which would make
   `runAdminUi` a true sixth composition root — is explicitly **out of
   scope**: this document requires only the deferred-factory fix above, not
   that split. If a later implementation performs the split anyway,
   `runAdminUi` becomes a sixth composition root at that point, and this
   section must be revised to say so rather than being read as having
   already decided that.
3. **`run-one-phase.ts`** is the composition root for the phase-runner
   entry point, distinct from `main()`'s (point 1) — it is a separate
   executable (`src/cli/run-one-phase.ts`), not a command dispatched through
   `admin.ts`'s `COMMANDS`, so it does not inherit any construction `main()`
   performs and must build its own ports directly. Per §5.5's
   already-specified fix, line 379 becomes `const issueLock = new
   IssueWorktreeLock(new RepoLockStore(DEFAULT_WORKTREE_LOCK_DIR))` —
   constructing the injected `LockStore` (§5.5) at this composition root,
   the same way point 1 constructs `LockStore`/`RepoLockStore` for
   `admin.ts`'s commands — and that one instance is threaded into both the
   phase-lock hook (§5.3) and, per the one-construction-per-need rule, into
   `createPhaseHandlers`'s `createReviewHandler`/`createConflictResolutionHandler`
   calls (`:318-319`) instead of leaving those two handlers to fall back to
   their own `issueLock ?? new IssueWorktreeLock(...)` default. This is not
   new work invented by this section — §5.5 already prescribes it in full —
   this point exists so `run-one-phase.ts` has an explicit, named place in
   the composition-root model instead of being addressable only through
   §5.5's constructor-signature discussion; a later extraction implementing
   `LockStore` injection has exactly one composition-root section to satisfy
   for every process entry point, not one for `admin.ts`/`admin-ui.ts` and a
   separately-discovered gap for `run-one-phase.ts`.

Point 1's `main()` handlers, point 2's `runAdminUi`, and point 3's
`run-one-phase.ts` all depend on the same **construction ownership rule**: a
resource module (Session, Worktree, Lock, Outbox, Content, Maintenance) may
export constructors/factories for its own composition root to call, but it
must never construct or import another resource module's concrete adapter
directly — that dependency flows through the *other* module's port, exactly
as `admin.ts` already does for providers (§9.1) and as #710 §1 already
requires for `TaskStore`.

## 10. Cross-resource dependency directions

Extending `docs/DOMAIN.md` §2.3's dependency matrix (Operation row: "ports"
into every other context, "maintenance ports" into Execution, raw internals
forbidden) to the module split this document introduces:

| ↓ calls → | Session | Worktree | Lock | UI | Outbox | Maintenance | Content | #710 Task ports |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Session | — | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | type-only (`AgentId`)* |
| Worktree | reads (session paths) | — | acquires (discard only) | ✗ | ✗ | ✗ | ✗ | ✗ |
| Lock | ✗ | ✗ | — | ✗ | ✗ | ✗ | ✗ | ✗ |
| UI | reads | reads/shells-out | reads/shells-out | — | ✗ | ✗ | ✗ | reads/shells-out (#710) |
| Outbox | ✗ | ✗ | ✗ | ✗ | — | ✗ | ✗ | ✗ |
| Maintenance | reads | reads | reads | ✗ | ✗ | — | ✗ | reads (`status` only) |
| Content | ✗ | ✗ | ✗ | ✗ | enqueue (existing, out of scope) | ✗ | — | enqueue (existing, Intake per DOMAIN §2.3) |

Notes on the ✗ cells worth stating explicitly because they are easy to get
backwards:

- **Session has no *runtime* dependency on anything else**, but it is not
  dependency-free today: `src/core/session.ts` has a real, existing
  `import type { AgentId } from "./task.js"` (line 1), and `AgentId` appears
  in exported shapes — `SessionDefaults.implementationAgent`/
  `.reviewAgent`/`.researchAgent` (`session.ts:3-7`) and
  `AssignmentProfile.implementation`/`.review`/`.conflict_resolution`/
  `.research` (`session.ts:211-216`), the latter consumed by
  `src/core/assignment.ts`'s own `AgentId` imports. This is the one
  asterisked cell in the matrix above (`type-only (`AgentId`)*`): a
  compile-time type reference, not a call into any Task-port function or a
  runtime import of Task's concrete store, so it does not violate the
  "no calls" cells elsewhere in this row — but it does mean a later
  extraction that gives Task its own module boundary (#710) cannot make
  Session import-clean of Task in the same stroke unless `AgentId` moves
  somewhere both modules can reach without either depending on the other
  (e.g. a shared primitives module, or re-exported from a location Session
  already owns). This document does not perform that relocation — it is
  new work, not covered by any extraction #710 or this document already
  specifies — but a later implementation closing this boundary must
  explicitly scope and perform it; until then, `Session → #710 Task ports`
  is accurately a type-only edge, not the `✗` a naive reading of "Session
  never depends on anything else" would imply. Session must still never
  import Worktree/Lock/UI/Outbox/Maintenance, and never import Task's
  runtime adapters (`SqliteTaskStore` or the port #710 defines) — only this
  one pre-existing type import is the exception, and it is scoped to
  `AgentId` alone.
- **Lock never depends on anything else either** — same reasoning:
  everything else reads/mutates Lock state, Lock has no dependents to
  satisfy in the other direction. The phase-runner's separate,
  parallel use of `IssueWorktreeLock` (§5.3) is Execution calling the same
  primitive, not Lock calling Execution.
- **Outbox has no sanctioned outbound edge of its own** — it is only ever
  called *into*, never the caller. The direction documented by #710 runs
  producer → Outbox, mirroring the Content → Outbox cell above: Task/handoff/
  review mutation commands (Task ports, out of scope for this document per
  #710) enqueue through Outbox as part of *other* already-owned commands, not
  as new Outbox-module work — see §7's "no current command" finding. All five
  current `SqliteOutboxStore` constructions in `admin.ts` (`enqueueFixModeRequeue`,
  `runReviewVerificationResolve`, `runGithubAppReviewReturn`,
  `runToolRequestResolve`, `runToolRequestGrant`) live in these Task/handoff/
  review handlers, not in a Maintenance command — `Maintenance → Outbox` stays
  forbidden per the matrix above, and Outbox never calls back into `TaskStore`
  or any other module. No module in this document may call
  `dispatchOutbox`/perform a synchronous host write — that stays Delivery's
  dispatch-time-only privilege per `docs/DOMAIN.md` §2.3.
- **UI is the one module allowed to depend on every other module's read
  path**, because it is a read+recovery console over all of them — but its
  *write* path is constrained to exactly the shell-out/in-process split §6.2
  already pins; UI must never gain a write path to a module it does not
  already shell out to or call in-process today (e.g., no in-process
  `createSession`/`updateSession` call from the UI without an explicit new
  command, even though it already reads sessions).
- **Maintenance's two live violations** (§8.1: quarantine's raw marker-file
  access, interventions' raw `Database` handle) are exactly the cells this
  table says should be "reads (port)" but are today "reads (raw fs/SQL)" —
  recorded as violations to close, not as sanctioned direct-access cells.

## 11. UI existing behavior and test-import migration path

`test/admin-ui-cli.test.js` imports 45 named exports from
`../dist/cli/admin-ui.js` (compiled from `src/cli/admin-ui.ts`):

```
ACTIVE_STATUSES, isActiveStatus, leaseState, attemptsCapState, issueTitle,
blockerSummary, artifactPathForTask, isRecoverable, isCapRecoverable,
isToolRequestHandoff, isHumanReviewHandoff, collectActiveTasks,
partitionByGitHubState, buildGhIssueStateReader, buildCachingReader,
populateStateCache, buildClosedTaskMenuActions, buildRecoverArgv,
buildCapResetArgv, buildToolRequestResolveArgv, buildToolRequestGrantArgv,
buildHumanReviewReturnArgv, buildTaskMenuActions, buildLockReleaseArgv,
buildStatusArgv, formatAdminCommand, formatTaskLine, formatTaskDetail,
taskColumns, parseUiArgs, resolveSessionIds, nonTtyHelp, DEFAULT_PAGE_SIZE,
pageCount, clampPage, pageForIndex, pageSlice, moveSelectionByPage,
moveSelectionByRow, formatPageStatus, applyFilter, isFilterActive,
formatFilterStatus, formatSessionScope, sessionIdsForScope
```

**Migration path: every one of these 45 names must remain a stable named
export of whichever module ends up owning it**, whether that module is still
`admin-ui.ts` (if the UI stays one file) or a split-out module the UI
re-exports from (if it does not) — the test's import statement is the
contract, not the file it currently points at. `collectActiveTasks` is the
single highest-priority name in this list: it is the exact function #710's
ports-contract doc already flags as needing to migrate from `store:
SqliteTaskStore` to `store: TaskStore` (§6.1 above), so its **signature**
changes while its **export name and module path** must not, in the same
change.

`runAdminUi` — `main()`'s in-process UI handler, not its own composition
root (§6.1/§9.2) — is **not** in this import
list; the test drives the UI via `execFileSync` on the compiled CLI (its own
`CLI` constant, line 54), not by calling `runAdminUi` in-process. This means
`runAdminUi`'s internal construction (which classes it builds, in what
order) has no test-import constraint pinning it today — it may be
refactored to follow §9.2's composition-root rule without a rename, as long
as `admin ui`'s observable subprocess behavior (stdout/exit-code contract,
per #709) is unchanged.

## 12. Required contract and integration tests

None of the following exist today; a later implementation task must add
them alongside any extraction so behavior preservation is machine-checked,
matching #708 §9's and #710 §11's precedent of listing tests rather than
asserting preservation by review alone:

1. **Session tolerant-read characterization** — one test per path-B call
   site (§3.2: `quarantine status`, `quarantine clear`, `worktree list`,
   `worktree prune`, `status`, `worktree cleanup`, `worktree discard`,
   `worktree recovery`) plus `session-doctor` (path C), pinning today's
   tolerant-read behavior after each is relocated off its inline parse onto
   its own named, non-`SessionRegistry` port (§3.3) — the port's *location*
   changes, its *validation strictness* does not. A target session missing
   a field its command never reads, or a malformed *unrelated* session
   elsewhere in `sessions.json`, must still let the command run to
   completion (a normal successful read for the 8 path-B commands, the same
   per-check diagnostic failure as today for `session-doctor`) — never a
   thrown error, and never a silent fallthrough onto `SessionRegistry`'s
   stricter, whole-file-eager validation. Read call site A (§3.2) is the
   only one migrating onto `SessionRegistry.getSessionById`/`.listSessions`;
   since its callers already construct `JsonSessionRegistry` directly today
   (§3.3), that migration changes no runtime behavior and needs no
   preservation test here.
2. **`SessionRegistry.createSession` conformance** — duplicate-`sessionId`
   rejection, duplicate-`repoKey` rejection (both exact messages
   `runSessionInit` produces today, `admin.ts:5197-5206`), duplicate-
   `sessionNo` rejection, and duplicate-`aliases`-entry rejection (the two
   additional reference-invariant checks §3.3 requires beyond
   `runSessionInit`'s current pair), plus a successful-write-then-fresh-
   registry-read round trip (pinning the snapshot-semantics note in §3.3 —
   the same instance must **not** be expected to see its own write via its
   read methods). Also a **repeated-write-on-one-instance test**: two
   `createSession` calls issued back-to-back on the *same* `SessionRegistry`
   instance, the second colliding with the first on `sessionId`, `repoKey`,
   `sessionNo`, or an `aliases` entry, must reject the second call (§3.3's
   write-time re-read requirement) — and a follow-up assertion that a fresh
   registry constructed against the resulting file loads without throwing
   `Ambiguous session reference`, proving the second write was actually
   rejected rather than silently appended. Also a
   **two-instance concurrency test**: two *separate* `SessionRegistry`
   instances, each constructed against the same `sessionsPath`, issue
   colliding `createSession` calls concurrently (e.g. both `await`ed via
   `Promise.all`, or interleaved deterministically if the implementation
   exposes a seam for it); exactly one call must succeed and the other must
   reject with a collision, never both succeeding (the corruption the
   same-instance test above cannot detect, since a single instance's
   sequential re-reads never race each other) — pinning the file-scoped lock
   transaction §3.3's `createSession` docstring requires. Also a
   **fresh-install bootstrap test**: `session-init` against a
   `--sessions-path` that does not exist on disk must create the file (with
   an empty `sessions` array and any missing parent directory) and then
   successfully write the first session — asserting `session-init`'s
   dedicated bootstrap step (§3.3) runs before `JsonSessionRegistry`
   construction, not that the registry itself tolerates a missing file. Also
   a **malformed-unrelated-entry test**: `session-init` against a
   `sessions.json` that already exists and contains an unrelated entry
   missing a field `validateSession` would reject (e.g. no `labels.active`)
   must fail with the same `Failed to load sessions file` construction-time
   error every other `SessionRegistry`-based command produces for that file
   — pinning §3.3's documented, intentional divergence from path D's
   current tolerance of malformed unrelated entries, not masking it.
3. **`SessionRegistry.updateSession` conformance** — unknown-`sessionId`
   rejection, a patch that introduces a `sessionNo`/`aliases` collision
   with a different session rejected (the same reference-invariant check
   as `createSession`, run post-patch), a successful in-place field update
   verified via a fresh-registry-read round trip, confirmation that
   updating one session leaves every other session in `sessions.json`
   byte-for-byte unchanged, and rejection (no write) of a `patch` carrying
   an own `sessionId` or `repoKey` property at runtime — constructed via an
   untyped/`any` value so it bypasses `SessionConfigPatch`'s compile-time
   `never` fields — pinning the runtime `hasOwnProperty` check §3.3 requires
   alongside, not instead of, the type-level guarantee. Also a
   **repeated-patch-on-one-instance test**: two `updateSession` calls issued
   back-to-back on the same instance, the second patch introducing a
   `sessionNo`/`aliases` collision with the state the *first* patch just
   wrote (not with the pre-first-write file), must reject the second call —
   pinning the same write-time re-read requirement item 2 pins for
   `createSession`, for the patch path. Also a **two-instance concurrency
   test**, mirroring item 2's: two separate `SessionRegistry` instances
   against the same `sessionsPath` issue colliding `updateSession` calls
   (or one `updateSession` racing a colliding `createSession` on the other
   instance) concurrently; exactly one write must land, the other must
   reject, and the resulting file must never contain the corruption either
   call would have produced alone — pinning that `createSession` and
   `updateSession` share one lock scoped to the sessions file, not two
   independent per-method locks that would fail to serialize a
   `createSession`/`updateSession` race against each other. Also a
   **crash-recovery test**: write a `<sessionsPath>.lock` sidecar directly
   (simulating a process that acquired the lock and was killed before its
   `finally` ran) with a `{ contextId, startedAt }` record whose `startedAt`
   is older than the stale TTL, then call `createSession`/`updateSession`
   against the same `sessionsPath`; the call must reclaim the abandoned lock
   and succeed, rather than blocking or rejecting — pinning §3.3's
   owner-record/stale-TTL recovery requirement, the gap a bare `finally` does
   not cover. A companion assertion with a **fresh** (non-stale) sidecar
   record must still block/reject the concurrent call, so the recovery path
   is proven to trigger only once the TTL has actually elapsed, not on every
   pre-existing lock file.
4. **`LockStore` port-conformance suite** — acquire/release/force-release/
   inspect/peek against the interface (§5.5), run against `RepoLockStore`
   today and against any future in-memory fake, mirroring #710 §11's
   pattern for `TaskStore`.
5. **`IssueWorktreeLock` distinct-directory test** (§5.5) — acquire a lock
   via `status`'s `IssueWorktreeLock` (built from `--worktree-lock-dir`) and
   assert it is visible to a separately constructed `IssueWorktreeLock`
   built from the same `--worktree-lock-dir` value (e.g. the one
   `worktree release-lock` or the phase-runner's lock hook would build),
   while a `RepoLockStore` built from `status`'s own, distinct `--lock-dir`
   value (used for `repoLock`) does **not** see it — pinning that the two
   `RepoLockStore` instances a single `status` invocation constructs are
   never the same instance and never point at the same directory by
   default, so the composition-root change in §5.5 cannot silently make
   `status` (or any other `IssueWorktreeLock` call site) inspect the
   repo-lock directory instead of the worktree-lock directory.
6. **`repo-lock force-release` vs. `worktree release-lock`/`review-lock
   release` asymmetry** — a test asserting the current, documented
   difference (§5.2: the former has no staleness gate, the latter two do)
   so a future change to either is a visible, reviewed decision, not a
   silent drift.
7. **Review-lock/worktree-release-lock alias parity** — drive the same
   stuck-lock scenario through both command names and assert identical
   resulting lock state, differing only in the two documented output fields
   (§5.1: `lockKind` and `reviewLockScope`, both present on `review-lock`
   output and absent from `worktree release-lock`'s) — extending the pattern
   #708 §9 item 6 already established for `tool-request grant`/`tool-request
   run`.
8. **`admin-ui` composition-root single-construction test** — assert
   `JsonSessionRegistry` is constructed **at most once** per `admin ui`
   invocation, and exactly once in the specific case §6.1 identifies as
   today's real duplication (no `--session-id`/`--session-ref` filter, and
   `sessions.json` exists) — not a blanket "exactly one construction always"
   assertion, which would misdescribe the `--session-id`/`--session-ref`
   branches (§6.1) and could force an unnecessary registry read, or break
   the supported `--session-id`-without-`sessions.json` fallback. This test
   does **not** cover `--lock-dir` (§5.4): that option does not exist on
   `parseUiArgs` today, and adding it is out of this document's and this
   test's scope — see §5.4. Also a **non-TTY-guard-precedes-construction
   test**: `admin ui` invoked with no TTY (stdin/stdout not a TTY) and *no*
   `sessions.json` on disk must still print `nonTtyHelp()` and exit 2 — the
   documented pre-#711 behavior — never throw or fail during
   `JsonSessionRegistry`/database construction; pinning §9.2 point 2's
   deferred-factory requirement (`main()` hands `runAdminUi` factories, not
   already-constructed ports, so the non-TTY short-circuit still runs before
   any port is built) against the regression that requirement exists to
   prevent.
9. **`admin-ui` three-category action classification** — one test per
   category in §6.2 (shell-out, in-process, print-only) asserting each
   currently-categorized action stays in its category — this is the test
   that would catch an accidental auto-execution of a currently print-only
   command.
10. **Quarantine/interventions raw-access regression markers** — not
   fix-verifying tests (no fix is proposed here), but **characterization
   tests** pinning today's marker-file and raw-`Database`-handle behavior
   exactly, so a later fix to either (§8.1) has a concrete before/after
   baseline instead of relying on the fix's own new tests to define
   "unchanged."
11. **Ownership-map completeness test** — a single test enumerating every
    `COMMANDS` entry (per #708 §2.2) **plus every hidden dispatch identifier
    not registered in `COMMANDS`** and asserting each appears in exactly one
    of #710's task/handoff list, this document's §2 table, or #708/#709's
    "not a resource" bucket — the automated version of the acceptance
    criterion "every remaining admin subcommand has exactly one target
    resource owner," so a newly added command cannot silently land ownerless.
    `session preset list`/`session preset show` are the two known hidden
    identifiers today (§2: dispatched at `admin.ts:10482-10496` but absent
    from `COMMANDS`, per #708 §2.2) — a test that only walks `COMMANDS` would
    keep passing even if one of them lost its owner in §2's table, since
    neither is reachable from that enumeration. The test must derive its
    identifier set from dispatch (e.g. the same routing table `main()` uses,
    or an explicit hidden-identifiers list covering these two plus any future
    hidden command) so the completeness criterion is actually enforced, not
    just enforced for the subset of commands `COMMANDS` happens to list.
12. **Outbox port-typing lint/test** — once #606/#607 add the first Outbox
    admin command, a test (or a static check) asserting its handler's store
    parameter is typed `OutboxStore`, never `SqliteOutboxStore` — pinning
    §7's target ownership decision at the point it first becomes
    checkable, rather than leaving it to code review alone.
13. **`IssueWorktreeLock` non-admin call-site conformance** (§5.5) — a test
    asserting `run-one-phase.ts` threads its single, composition-root-built
    `issueLock` into `createReviewHandler`/`createConflictResolutionHandler`
    (so production phase runs never hit the in-handler
    `issueLock ?? new IssueWorktreeLock(...)` fallback), plus the existing
    `conflict-resolution-handler.test.js`/`review-handler.test.js` calls that
    omit the lock argument continuing to exercise and pass through that
    fallback unchanged — pinning that the `constructor(store: LockStore)`
    change compiles and behaves identically at all three non-`admin.ts`/
    non-`admin-ui.ts` call sites, not only the eleven this document
    otherwise tracks.

## 13. Preservation guarantees

A later implementation of this contract must preserve, byte-for-byte where
machine-readable:

- Every command name, dispatch behavior, and output shape §2's table
  references — this document changes *type annotations and construction
  ownership*, never argv shapes, JSON field names, or exit codes (those stay
  governed by #709).
- The `review-lock`/`worktree release-lock` alias relationship (§5.1) and
  the `repo-lock force-release` vs. issue-scoped-release asymmetry (§5.2),
  unless a future issue explicitly revises either — in which case the
  revision must be called out, not silently absorbed into a "cleaner"
  general rule (mirroring #708 §7's same requirement for the
  `tool-request grant`/`run` alias).
- `admin-ui.ts`'s three-category action split (§6.2) and its 45 stable test
  exports (§11) — a rename or category change is a visible, reviewed
  decision, never an incidental side effect of a `TaskStore`/`LockStore`
  type-annotation change.
- The `admin.js`/`admin-ui.js` sibling-entrypoint subprocess contract, per
  #708 §8 (cross-referenced, not restated, in §6.3).
- `SessionRegistry`'s snapshot semantics (§3.1/§3.3): neither `createSession`
  nor `updateSession` ever becomes an implicit-reload operation on the
  calling instance without an explicit, documented decision to change the
  registry from snapshot to live.
- The `context create`/Content-group boundary (§8.2) and the
  not-an-admin-subcommand status of `npm run metrics` (§8.3) stay excluded
  from any future resource-extraction issue's scope unless that issue
  explicitly opts them in.
- The 8 path-B commands' and `session-doctor`'s tolerant reads of
  `sessions.json` (§3.2/§3.3): none of the 9 may start failing on a target
  session missing a field it doesn't use, or on an unrelated malformed
  session elsewhere in the file, as a side effect of relocating their reads
  onto a named port. Only read call site A (§3.2), whose callers already
  construct `JsonSessionRegistry` directly today, may take on
  `SessionRegistry`'s stricter validation — because that validation already
  applies to it.
- `repo-lock force-release` and `interventions` keep working on a fresh
  install with no `sessions.json` on disk (§9.2 point 1): neither may be
  made to depend on `SessionRegistry` construction — eager, lazy, or via
  factory — since neither reads session state today.
