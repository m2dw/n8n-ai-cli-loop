# ChatOps operations guide

Status: **implemented, config-gated** (issues #1024, #1031). This is the operator
document for the ChatOps comment surface: how to turn it on, who may use it,
what one invocation does, how to read its state, and how to recover or roll
back. It is deliberately *not* a specification — every rule it describes is
fixed by one of the contracts listed in §9, and where this guide and a contract
disagree the contract wins.

See [feature-status.md](feature-status.md#chatops) for the aggregate status of
this feature and the limitations that keep it `config-gated` rather than
`available`.

---

## 1. What ChatOps does, in one sentence

An allowlisted human writes `/grant --disposition commit` as an ordinary
comment on a work item; a scheduled, bounded pass discovers that comment,
proves it is authorized and well-formed, records it durably, runs the operation
it maps to **at most once**, and posts back a machine-readable acknowledgement
marker plus a human-readable summary.

Everything hard about that sentence is the "at most once" — a command must
never run twice, not after a crash, not after a retry, not after a database
restore. The whole design exists to buy that property, and the cost is that
ChatOps would rather do nothing and ask you than guess.

## 2. Before you enable it

**What it can actually do.** Both mapped verbs execute. The operation catalog
(`src/core/chatops-operations.ts`) registers exactly the two operations the
mapping table names — `/grant` → `tool-request.run` and `/resolve` →
`tool-request.resolve` (see [§3's table](#supported-commands)). An authorized
`/grant` runs the issue's *already-recorded* Tool Request command on the issue
branch — in the per-issue worktree when one is registered, else the canonical
checkout — under the same single-worker repo lock `admin tool-request run`
takes, then resolves the request and hands the task back to the implementation
lane. An authorized `/resolve` records the
operator's decision without running anything and resumes through the existing
continuation semantics.

**The lock your own workflow holds is not contention.** The generated parent
takes the session's repo lock under the context id it then passes to the child,
and releases it only after the child returns — so the ChatOps Scan node always
runs with that lock held. A pass invoked with `--context-id` therefore treats a
lock held *by that same context* as the critical section it is already inside:
the guided run proceeds without rewriting the lock file, and the parent still
releases its own lock at the end of the execution. Exclusion is unchanged — the
parent holds the lock against every other execution for the session, and the
child's nodes run one after another, so no second worker is on the checkout
while the granted command runs. A lock held by anything else (another
execution, `admin tool-request run`, a phase runner) is still a definite
`conflict` refusal, and a pass invoked with `--session-id` — an operator running
one by hand, outside any execution — refuses on any held lock, as before.

Both go through the *same* callable core the admin CLI calls
(`src/core/tool-request-run.ts`, `src/core/tool-request-resolve.ts`): the
ChatOps entrypoint is a composition root that hands those cores their stores,
repo lock and session, then invokes them in-process. No argv is built from a
comment and no `admin.js` subprocess is spawned
([operation-dispatch-port-contract.md](operation-dispatch-port-contract.md) §6,
§11.2).

**What a comment may set is a closed allowlist.** `/grant` exposes
`--disposition` and nothing else — in particular *not* `--command`. Which
command runs was decided and recorded when the Tool Request was created; a
comment picking it would be free-form shell through a comment, which
[chatops-operation-mapping-contract.md](chatops-operation-mapping-contract.md)
§4 forbids outright. A parameter outside the allowlist is refused before
anything is claimed or dispatched. Any verb outside [§3's
table](#supported-commands) is still answered `unknown-operation`: definite,
effect-free, and acknowledged like any other refusal.

**Provider support.** Two work-item providers have a comment-port adapter:
GitHub Issues (`src/providers/github/gh-chatops-comment-port.ts`, over the `gh`
CLI) and Gitea Issues (`src/providers/gitea/gitea-chatops-comment-port.ts`, over
Gitea's REST API). Command semantics, the verb table, and every durability rule
are identical on both — the adapter is the only Gitea-aware code on the path,
and the handler, the contracts and the n8n workflow JSON carry no provider
branch. Any other kind (`jira`, `azure-devops`, `bitbucket`) has neither a
ChatOps identity nor a port: with ChatOps enabled the entrypoint refuses to
start (exit `1`) rather than reading or posting anywhere, and with ChatOps
disabled it reports `disabled` like any other session, whatever its provider.

One behavioural difference is worth knowing about before you read a Gitea pass's
request count: a self-hosted Gitea clamps the page size to its own configured
maximum, so a *full* page can come back shorter than the pass asked for. The
Gitea adapter therefore proves it reached the end of a comment list only when a
page comes back **empty**, which costs one extra request per work item per pass.
Stopping at a short page instead would advance the cursor past comments that
were never read — commands that would then never run and never be reported.

Each Gitea request the adapter makes is bounded at 30 seconds. An instance that
accepts the connection and then goes quiet is reported as a normal `HTTP 0`
transport failure (`gitea request timed out after 30000ms` in the pass note),
which advances no cursor and is retried on the next pass — a scheduled pass must
always finish, so it never waits on an unresponsive instance indefinitely.

**Credentials.** ChatOps acts as the session's work-item provider identity: it
scans and posts through `workItemProvider.auth`, so a `github-app` session uses
its installation token and never the ambient `gh` login, and a `gitea-issues`
session uses the API token its `auth.tokenEnv` / `auth.tokenKey` resolves to —
there is no ambient Gitea login and none is invented. A credential that cannot
be resolved is a refusal to start (exit `1`), not a pass outcome: nothing has
been read, written, or posted at that point. Configured credentials are also
what keeps markers postable under a login you can list in `automationLogins` — a
marker posted under some operator's personal account would not authenticate as
ChatOps evidence.

## 3. Enablement

Add a `chatOps` block to the session in `sessions.json`:

```jsonc
{
  "sessionId": "addon-dev",
  // ...
  "chatOps": {
    "enabled": true,
    "authorAllowlist": ["alice", "bob"],
    "automationLogins": ["addon-dev-bot"],
    "maxDispatchesPerPass": 5,
    "operationTimeoutMs": 600000
  }
}
```

- **`enabled`** — the master switch. Absent or `false` is a total runtime
  no-op: the entrypoint reports `outcome: "disabled"` and performs no provider
  read, no ChatOps database write, and no comment post. (Invoked with
  `--context-id`, it still reads the context table to learn which session it was
  asked about — that read precedes the switch and is the same one every other
  child-workflow node performs.)
- **`authorAllowlist`** — the provider logins allowed to issue commands,
  compared case-insensitively. This is the entire trust boundary. It is never
  derived from repository roles or collaborator state, because a repository
  setting changed by someone else must not be able to widen who can dispatch.
- **`automationLogins`** — the logins *this session's own automation* posts
  acknowledgement markers as. It authenticates markers the system wrote; it
  does not authorize anybody. List **every** login the bot has ever posted
  under, across credential rotations: a marker posted under a retired
  credential must still authenticate, or a future reconciliation would read a
  real acknowledgement as absent.
- **The two lists must be disjoint.** This is enforced at session load, not at
  scan time: an overlapping login would let a human command author post markers
  that authenticate, forging exactly the evidence every restore detector reads.
  A session that could forge its own evidence never resolves at all.
- **`maxDispatchesPerPass`** (default `5`) — commands one invocation runs
  before stopping. Whatever is left runs on the next pass.
- **`operationTimeoutMs`** (optional) — an *advisory* budget handed to the
  operation as `deadlineMs`. There is no cancellation: exceeding it produces an
  indeterminate-effect failure, never a silent abort.

### Supported commands

Fixed by
[chatops-operation-mapping-contract.md](chatops-operation-mapping-contract.md)
§7, and not extendable by configuration:

| Comment | Operation | Parameters a comment may set |
| --- | --- | --- |
| `/grant [--disposition <value>]` | `tool-request.run` | `disposition` |
| `/resolve --action <manual-done\|reject> [--message <text>]` | `tool-request.resolve` | `action` (required), `message` |

The command must be the comment's **first surviving non-blank line** (code
blocks, indented code, and block quotes are skipped), and the comment must not
have been edited after it was posted.

## 4. First run: bootstrap

The first pass over a work item **bootstraps** it: every comment that already
exists is recorded as seen and **none of them is ever run**, even if it looks
exactly like a valid command. Replaying instructions nobody re-issued is the
one thing a freshly-enabled surface must not do.

The pass reports what it skipped, so this is explicit rather than silent:

```json
{ "issueNumber": 42, "bootstrapped": true, "bootstrapSkipped": 1,
  "notes": ["bootstrap: comment 91 by alice looks like a command and was not run"] }
```

If you want one of those commands to run, post it again after the bootstrap
pass completes.

An issue with **no** comments still bootstraps: the pass records an
initialization sentinel with a null cursor position. That is deliberate —
without it, the next pass would look like a first-ever one and would record a
command posted in between as pre-existing backlog, skipping it forever.

## 5. Running one pass

```bash
node dist/cli/chatops-scan.js \
  --session-id "addon-dev" \
  --db-path "/path/to/dev_loop.db" \
  [--issue-number 42,57] \
  [--max-issues 20] \
  [--lock-dir "/path/to/locks"]
```

`--lock-dir` points at the single-worker repo lock a `/grant` takes before it
runs the approved command. It must name the *same* directory the phase runner
and `admin tool-request run` use — two entrypoints with different lock
directories would take different locks and neither would exclude the other.
Leave it unset unless your deployment moved the lock directory. Running a pass
by hand with `--session-id` while a scheduled execution holds that lock refuses
the `/grant` (`conflict`); the scheduled pass itself does not, because it *is*
that execution (see [§2](#2-before-you-enable-it)).

`--context-id <id>` may be given instead of `--session-id`; the session is then
resolved from the context store. That is the form the n8n child workflow uses,
and it is why `sessionId` never has to cross the workflow boundary. Exactly one
of the two is required: passing both is a setup error (exit 1), because a
context row that resolves to a different session than the explicit flag would
otherwise decide silently which session gets scanned and commented on.

One invocation reads each work item's comment list **to the end of the list**
once, dispatches up to `maxDispatchesPerPass` commands, publishes what it owes,
and exits. It never polls, never sleeps, and never waits for a state change.

**You normally do not run this by hand.** The generated child workflow already
carries a **ChatOps Scan** node between *Run One Phase* and *Dispatch Outbox*, so
every scheduled n8n execution of the parent workflow runs one pass for that
session:

```
[When Called by Parent] → [GitHub Intake] → [Run One Phase] → [ChatOps Scan] → [Dispatch Outbox] → [Return Context]
```

The node invokes this same CLI with `--context-id` — the session is resolved from
the context store, exactly as the other child nodes do it — and it sits upstream
of *Dispatch Outbox* so the claim/acknowledgement/result comments a pass enqueues
are delivered in the same execution. The node is unconditional because a session
without `chatOps.enabled` exits `0` with `outcome: "disabled"` before opening a
ChatOps store or a provider connection; enabling ChatOps for a session therefore
needs no workflow change at all. The schedule is the workflow's business and every policy
decision stays in the session config and the contracts, so no ChatOps rule is
ever encoded in workflow JSON.

Run the CLI directly when you want an out-of-schedule pass, a pass restricted to
named work items, or a first bootstrap you can watch. Existing deployments pick
the node up by reimporting the child workflow
(`docs/n8n-thin-child-workflow.json`); see
[docs/parent-child-workflow.md](parent-child-workflow.md).

When a pass finds several ready commands it runs them in the provider's own
comment order — oldest first, by
[`chatops-comment-cursor-contract.md`](chatops-comment-cursor-contract.md) §3's
`(createdAt, id)` key, not by comment id. So a `/grant` posted before a
`/resolve` runs before it even on an issue whose comment ids do not ascend with
creation time. If the pass's `maxDispatchesPerPass` budget runs out, the ones
left over are the newest, and the next pass takes them.

Omitting `--issue-number` covers every work item this session already has
ChatOps state for, plus every work item with a live (non-terminal) task, capped
at `--max-issues`. When the cap truncates the set the result says so
(`issuesTruncated: true`).

A work item leaves that set for good once its task is `done`, `failed`, or
`cancelled` — including one whose scope was scanned and bootstrapped earlier, so
finished work stops costing provider requests and stops taking new commands
rather than being scanned for the life of the session. The single exception is a
finished work item whose ledger still owes automation something — a dispatch in
flight, or an outcome whose acknowledgement marker has not been published yet;
those stay in scope until they settle, so nothing is stranded half-published, and
drop out afterwards. A scope parked for a human (`ambiguous`) is not kept alive
this way: it moves only through `chatops-recover` (§7). Naming a work item with
`--issue-number` always scans it, terminal or not, which is how an operator runs
one last pass on a finished issue.

The cap is a **window, not a selection**: each pass starts at the work item after
the previous pass's last one, wrapping around, and the result reports where the
next pass resumes (`nextIssueCursor`). A session with more candidates than the
cap is therefore covered completely every `ceil(candidates / max-issues)` passes,
rather than having its higher-numbered work items excluded forever. The position
is recorded when the window is chosen, not when the pass finishes, so a pass that
dies partway does not pin the window to the work items that killed it. Raising
`--max-issues` changes how *fast* a large session is covered, never *whether* it
is — which is why the generated workflow does not need to set it.

Each window is also *run* from its resume position rather than in ascending work
item order. The window's members share one `maxDispatchesPerPass` budget, so
whoever is handed first spends it first; re-sorting each window ascending would
hand the budget to the same low-numbered work items every pass and leave the
higher-numbered ones scanned but never dispatched. Running in rotation order
gives every candidate first call on the budget once per full rotation.

Two passes may overlap — a slow run and its schedule's next tick, or an operator
running one by hand — without breaking at-most-once. Each command's write-ahead
is a compare-and-swap against the row as the transaction itself reads it, so the
pass that commits second sees the first pass's claim and declines instead of
dispatching. The loser reports `delayed`, because the command is still in flight
somewhere, not concluded. Reconciliation commits the same way: its verdicts are
decided from the rows the committing transaction reads, not from the scan that
began before the other pass finished, so a command the winner dispatched and
acknowledged is never rewritten back to a human handoff. Discovery commits the
same way, so a comment two passes see at once gets one ledger row rather than a
fresh claim written over a row the other pass has already dispatched. The
acknowledgement post is the one step that happens between two transactions, so
it is reserved first: only the pass holding the reservation posts the marker,
and the other reports `delayed`. A fence is read by the same two transactions:
a write-ahead reads the fence the transaction itself sees, so a fence one pass
commits while another is mid-pass still stops that pass's next dispatch, and a
dispatch result is written only onto the row version its attempt began on, so a
result arriving after a fence parked its row leaves the handoff — and its
`ambiguous` state — standing rather than replacing it with a summary the fence
contradicts. Overlapping passes still cost provider requests
for nothing, so schedule them apart rather than relying on this.

### Reading the result

Exit code is `0` whenever the pass ran, whatever it concluded — a ChatOps
failure is a state to report, not a crashed step. Exit `1` means a setup error —
bad arguments, an unknown session or context id, an unusable provider identity, a
provider with no comment port, or credentials that cannot be resolved — and no
provider read, no ChatOps write, and no comment post has happened when it does. The `outcome` field carries the
disposition:

| `outcome` | Meaning | What to do |
| --- | --- | --- |
| `disabled` | `chatOps.enabled` is not true | nothing |
| `idle` | nothing new, nothing pending | nothing |
| `refused` | commands were seen and refused before any dispatch | nothing; the reason is in the audit record |
| `processed` | at least one command was dispatched or acknowledged | nothing |
| `delayed` | something is retryable — an incomplete scan, an unconfirmed post, an indeterminate result, or a maintenance lock | call again |
| `failed` | a scope is fenced or a command is parked for a human | read §6, then §7 |

A `prune` or `restore` holds a file-level maintenance lock on the state
database, and every ChatOps write refuses while it is held — the check runs
inside the same transaction as the write, so a lock acquired mid-pass stops the
pass at its next write rather than racing it. That is reported as `delayed`
with a note naming the lock, never as `failed`: nothing is wrong, and the next
scheduled invocation after maintenance finishes the work. A pass that sees the
lock before it starts reports `delayed` immediately, without a single provider
request.

Per-work-item counters (`candidates`, `refused`, `claimed`,
`dispatchAttempts`, `dispatchResults`, `acknowledged`, `fenced`) and bounded
`notes` sit under `issues[]`.

### What gets posted

Two **separate** comments per dispatched command, never merged:

1. The **marker** — trimmed body exactly `<!-- chatops-claimed:<id> -->` or
   `<!-- chatops-ack:<id>:<executed|rejected|error> -->`, and nothing else.
   This is the only comment reconciliation ever reads as evidence; a marker
   with anything appended fails authentication and becomes invisible to every
   restore detector. Posted directly by the pass, with its own bounded retry
   budget.
2. The **summary** — an ordinary comment whose first line is always the fixed
   literal `ChatOps automated comment — not a command`, followed by the
   bounded, sanitized outcome and its closed reason code. Delivered through the
   ordinary outbox, so it needs a `dispatch-outbox` run to actually appear.

A summary never contains a local path, a credential, raw command output, a
diff, or any part of the operation's structured `data`. Its fixed leading line
is what guarantees it can never itself be recognized as a new command,
regardless of what the operation's prose happens to say.

## 6. Inspecting state

```bash
node dist/cli/chatops-status.js --session-id "addon-dev" [--issue-number 42]
```

Strictly read-only: it opens no provider connection, posts nothing, and writes
nothing — including the epoch witness, which it reports but never heals. The
database connection is read-only too, so a session that has never completed a
pass gets exit `1` and an explanation rather than a freshly created, empty
database. Run §5 (or §4's bootstrap) first.

It answers the four questions worth asking:

- **`cursor`** — how far discovery has advanced, and whether the scope has been
  initialized at all.
- **`fence`** — whether this issue, or the whole session, is barred from new
  execution, and why.
- **`pendingPublication`** / **`inFlight`** / **`awaitingHuman`** — commands
  still owing an acknowledgement, commands mid-dispatch, and commands parked
  for a person.
- **`auditTail`** — each command's recorded disposition. **Read these in
  emission order and take the last one**; the `row` field says which transition
  produced a record, and it is not a sequence number, so picking the highest
  `row` gives the wrong answer.

`epoch` shows the database's dispatch counter against the out-of-database
witness. `deferredClaims` lists commands discovered while fenced whose claim
was deliberately not written — they are picked up automatically once the fence
clears.

`unsettledPublication` lists acknowledgement posts that were reserved and never
settled — a pass died between posting the marker and recording that it had. It
is normally empty, and an entry needs no operator action: the next pass counts
the attempt as one failed publication (whether the marker landed is unknown, so
neither outcome is assumed) and republishes if the row still owes a marker.
Only one pass can hold a reservation, which is what stops two overlapping
passes from acknowledging the same command twice.

## 7. Recovery

```bash
node dist/cli/chatops-recover.js --session-id "addon-dev" <action>
```

Every one of these is an operator-only action, recorded durably. None of them
ever happens automatically: a fence that expired on its own would be a silent
replay path with a delay.

Any action that writes ChatOps state refuses while a `prune`/`restore`
maintenance lock is held — with exit `1` and a message naming the lock, rather
than the `delayed` a scheduled scan reports. Check `admin maintenance-lock
status`, wait for maintenance to finish, and re-run.

### A fenced scope

A fence means "the world records more execution than the database does" — a
restored backup, a lost witness, or evidence that contradicts the ledger. While
fenced, the scope keeps discovering comments and keeps publishing markers it
already owes, but **dispatches nothing**.

1. Read the rows (`chatops-status`) and the issue's markers.
2. Decide, per parked command, what actually happened, and record it:
   ```bash
   # the command definitely ran (or definitely did not)
   node dist/cli/chatops-recover.js --session-id addon-dev --resolve \
     --issue-number 42 --comment-id 12345 --outcome executed --operator alice

   # you want it attempted again — the ONLY sanctioned replay path
   node dist/cli/chatops-recover.js --session-id addon-dev --retry \
     --issue-number 42 --comment-id 12345 --operator alice \
     --reason "confirmed with the platform team it never ran"
   ```
   Both refuse without `--operator`; `--retry` also refuses without
   `--reason`. Neither half is inferable afterwards, and a retry nobody is
   named for is the silent replay everything else here exists to forbid.

   Both also apply to **the row you read** in `chatops-status`. If anything
   settled it in between — a second operator, a re-run of this same command —
   the command exits `1`, leaves the recorded decision alone, and tells you what
   the row is now; re-read `chatops-status` and decide again. That matters most
   for `--resolve`, whose summary comment is keyed on the ledger row it writes:
   a second decision landing on top would leave the published text describing an
   outcome the ledger no longer records.
3. Clear the fence:
   ```bash
   node dist/cli/chatops-recover.js --session-id addon-dev --clear-fence \
     --grain session [--fenced-at 2026-02-02T00:00:00.000Z]
   # or --grain issue --issue-number 42
   ```
   Clearing a fence re-opens the scope for new work; it does not decide what
   happened to commands already parked. Do step 2 first.

   The clear applies to **the fence you read**, not to whatever is recorded when
   it runs: if a pass raised a different fence in between — a new restore
   detection, new conflicting evidence — the command exits `1`, leaves the new
   fence in place, and tells you what is recorded now. Pass `--fenced-at` with
   the `fencedAt` from `chatops-status` to name the fence explicitly; the
   comparison happens either way. With no fence at that grain, the command is a
   reported no-op (`cleared: false`), not an error.

### `witness-missing`

The epoch witness lives under the session's `artifactRoot`, which a database
restore never replaces. If it is absent (or unreadable) while the ledger
records dispatch history, the session fences: a restore cannot be ruled out.
The legitimate cause is a repointed `artifactRoot`. Once you have satisfied
yourself that is what happened:

```bash
node dist/cli/chatops-recover.js --session-id addon-dev --seed-witness
```

### A parked command's acknowledgement was abandoned

If a marker could not be published within its retry budget the command is
terminal with `ackPublication: "abandoned"`. The outcome is durable locally and
the summary comment may well have been delivered; what is missing is the
provider-visible proof a future reconciliation would read. There is no
republication path — record the situation out of band if it matters.

## 8. Rollback

Set `"enabled": false` (or delete the `chatOps` block) and redeploy the session
file. The next pass reports `disabled` and does nothing at all — no provider
read, no write, no post. Every durable row stays exactly as it was, so
re-enabling later resumes from the same cursor rather than re-bootstrapping.

Two things a rollback does **not** do, on purpose:

- It does not clear a fence. A fence records something that actually happened;
  disabling the surface does not un-happen it.
- It does not withdraw comments already posted, or drain the outbox of a
  summary already enqueued. Run `dispatch-outbox` if you want a pending summary
  delivered, or cancel the row with `admin outbox cancel` if you do not.

To roll back further — to a scope that has never been scanned — delete this
session's `chatops_*` rows and the epoch witness file together. Deleting the
cursor without the first-seen records would silently convert "we saw this
unedited" into "we never saw this", and deleting the database without the
witness is indistinguishable from the restore the witness exists to detect.

## 9. Contracts

Behavior is specified by, in dependency order:

- [chatops-command-grammar-contract.md](chatops-command-grammar-contract.md) —
  what a command is and who may issue one.
- [chatops-identity-contract.md](chatops-identity-contract.md) — what tuple
  identifies one session's view of one work item.
- [chatops-comment-cursor-contract.md](chatops-comment-cursor-contract.md) —
  the complete scan window, the durable cursor, and bootstrap.
- [chatops-execution-ledger-contract.md](chatops-execution-ledger-contract.md)
  — the at-most-once state machine, reconciliation, fences, and the epoch
  witness.
- [operation-dispatch-port-contract.md](operation-dispatch-port-contract.md) —
  the callable operation port and the request/context split.
- [chatops-operation-mapping-contract.md](chatops-operation-mapping-contract.md)
  — which verb invokes which operation and which parameters it may set.
- [chatops-result-contract.md](chatops-result-contract.md) — result kinds,
  reason domains, publication, and redaction.
