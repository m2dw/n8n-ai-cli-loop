# Future Architecture Notes

This note captures the intended direction for the next major refactor. The current workflow works, but it relies too heavily on GitHub labels and large shell snippets embedded in generated n8n Execute Command nodes.

## Goals

- Keep GitHub labels simple and human-readable.
- Move detailed workflow state out of GitHub labels.
- Allow implementation and review agents to be chosen independently.
- Reduce shell escaping and generated JSON fragility.
- Keep n8n useful as an orchestration UI, not as the place where business logic lives.

## Current Problems

### Label overload

GitHub labels currently carry too many meanings at once:

- workflow status, such as `status:needs-implementation`
- lane selection, such as implementation vs review
- agent selection, such as `agent:claude` or `agent:codex`
- human-visible status
- retry and failure state

This creates label sprawl and makes the public GitHub issue state harder to read.

The desired GitHub-side state is much coarser. GitHub should only need to show something like:

- `ai:active`
- optionally `ai:blocked`
- optionally `ai:ready-for-human`

The details of whether a task is waiting for implementation, review, recovery, or research should live in the automation state store.

### Execute Command escaping

The generated n8n workflow currently embeds large zsh scripts into Execute Command nodes. This makes quote handling, heredocs, exit status, and n8n expression escaping part of the maintenance burden.

The long-term shape should move process logic into normal JavaScript modules and keep n8n nodes thin.

## Proposed State Model

Store detailed queue and execution state outside GitHub labels. Candidate stores:

- n8n Data Tables
- `.n8n-artifacts/state.sqlite`
- GitHub Project custom fields
- issue comments parsed as commands, backed by one of the stores above

The data layer should not depend directly on n8n or the filesystem. Application code should talk to a small storage interface, and concrete adapters should provide the persistence backend. The likely first adapter can be `.n8n-artifacts/state.sqlite` because it is local, inspectable, version-independent, and does not require committing state. n8n Data Tables can be evaluated later if UI-level state inspection becomes important.

The important boundary is:

- workflow and phase logic depend on `TaskStore` / `RunStore` interfaces
- adapters depend on SQLite, n8n Data Tables, files, or GitHub Projects
- tests can use an in-memory adapter
- migration to another backend should not rewrite queue, lane, or agent logic

The store should also provide atomic operations, not only basic reads and writes. If the data layer can guarantee atomic claim and transition behavior, higher-level lane code becomes much simpler and does not need to reimplement race protection around every phase.

Required atomic guarantees:

- select and claim the next runnable task as one operation
- transition a task only when it is currently in the expected state
- start a run only if the task is still owned by the current worker
- append event and update task/run state in one transaction
- release a claim only when the owner/run id matches
- increment retry counters without lost updates

This should be modeled as compare-and-swap style APIs. For example, a task transition should fail cleanly if another execution already moved the task.

Example interface shape:

```js
export class TaskStore {
  async enqueueTask(task) {}
  async getTask(issueNumber) {}
  async claimNextTask(workerId) {}
  async transitionTask(issueNumber, expected, patch) {}
  async updateTask(issueNumber, patch) {}
  async appendEvent(issueNumber, event, options) {}
  async releaseClaim(issueNumber, ownerRunId) {}
}

export class RunStore {
  async startRun(run) {}
  async updateRun(runId, patch) {}
  async finishRun(runId, result) {}
  async getLatestRunForIssue(issueNumber) {}
}
```

Example transition:

```js
await taskStore.transitionTask(
  123,
  { status: "claimed", ownerRunId: runId, phase: "implementation" },
  { status: "running", startedAt: now }
);
```

If the expected fields do not match, the adapter returns a conflict result rather than overwriting state.

Adapters can then be introduced incrementally:

- `MemoryTaskStore` for tests
- `SqliteTaskStore` for the first local implementation
- `N8nDataTableTaskStore` if n8n-native state becomes useful
- `GithubProjectTaskStore` only if GitHub UI-level field visibility is worth the API complexity

Example task state:

```json
{
  "issue": 123,
  "status": "queued",
  "phase": "implementation",
  "implAgent": "codex",
  "reviewAgent": "gemini",
  "priority": "normal",
  "attempts": {
    "implementation": 0,
    "review": 0,
    "recovery": 0
  },
  "runId": null,
  "lastError": null
}
```

The state store should become the source of truth for:

- queue membership
- current phase
- selected implementation agent
- selected review agent
- retry counts
- last failure
- current branch and PR URL when known

GitHub issue comments should remain the audit trail and human notification surface.

## Agent Assignment

Agent selection should not depend on labels. The system should support combinations such as:

- Claude implementation, Codex review
- Codex implementation, Gemini review
- Claude implementation, Gemini research, Codex review

Default routing can live in a repo-local config file, for example:

```json
{
  "defaultImplementationAgent": "claude",
  "defaultReviewAgent": "codex",
  "agents": {
    "implementation": ["claude", "codex"],
    "review": ["codex", "gemini"],
    "research": ["gemini"]
  }
}
```

Human overrides can be expressed through issue comments and then written into the state store:

```text
/ai queue
/ai implement claude review codex
/ai implement codex review gemini
/ai pause
/ai retry
/ai handoff
```

This keeps GitHub interaction simple while allowing flexible automation.

## Workflow Shape

n8n should orchestrate work by phase, while JavaScript owns the implementation.

The target repository should be defined once per workflow/session, not repeated inside every command. Repeating `cd <repo>` or `--repo-root <repo>` in many nodes is error-prone. A workflow run should begin by creating a session context that contains the target repository root and runtime configuration, and every phase should receive that session id.

Example session context:

```json
{
  "sessionId": "addon-dev",
  "repoRoot": "/Users/you/git/thunderbird-auth-results-filter",
  "artifactDir": ".n8n-artifacts",
  "workflow": "github-issue-ai-dev-loop",
  "defaults": {
    "implementationAgent": "claude",
    "reviewAgent": "codex"
  }
}
```

n8n can then manage multiple workflows or targets in one instance:

- one session for `/Users/you/git/thunderbird-auth-results-filter`
- one session for `/Users/you/git/n8n-ai-cli-loop`

Each phase should resolve its `repoRoot` from the session context, not from the process cwd and not from a repeated command literal.

An even better end state may be a single reusable n8n workflow that accepts the target repository/session as input. Instead of generating or importing one workflow per repository, the same workflow can drive multiple projects by passing a `sessionId` or `repoKey` at the start of the run.

Possible inputs:

```json
{
  "sessionId": "addon-dev"
}
```

or:

```json
{
  "repoKey": "thunderbird-auth-results-filter"
}
```

The session layer would resolve that key to repository-specific configuration:

- `repoRoot`
- GitHub owner/repo
- artifact directory
- default implementation/review agents
- verification commands
- label names for coarse human-visible state

This keeps the n8n canvas stable while adding new projects through configuration. It also avoids copying workflow definitions for every repository.

For scheduled runs, the workflow needs a source of sessions to poll. Options:

- run once per configured session in a loop
- select the next runnable task globally across all sessions
- keep one schedule trigger per session only as a thin entry point into the same phase runner

Concurrency must be scoped by session/repository. A task in `thunderbird-auth-results-filter` should not block a task in `n8n-ai-cli-loop`, but two runs for the same repo must not mutate the same working tree concurrently.

Suggested modules:

- `lock`: acquire, release, stale-lock recovery
- `session`: resolve target repository, artifacts, config, and runtime defaults
- `state`: storage interfaces, migrations, and adapters
- `queue`: select next task from state
- `github`: issue, PR, comment, and label helpers
- `agents`: run Claude, Codex, Gemini/Antigravity
- `implementation`: branch, prompt, verify, commit, PR, handoff
- `review`: resolve PR, checkout, verify, run review, classify, post result
- `recovery`: inspect failed runs and repair recoverable failures
- `research`: prompt, run, post result
- `planner`: promote backlog or comment-command tasks

Preferred end state:

- n8n nodes describe phases and transitions.
- each node invokes a small JavaScript function.
- generated workflow JSON stays readable and stable.
- tests cover phase contracts and state transitions.
- upper-layer lane code relies on atomic store operations instead of ad hoc lock checks

### Breaking The Current Single Lane

The current workflow is a long node chain where n8n itself acts as the state machine. Every execution walks through many lane-specific nodes, and each node decides whether to run or skip. This works, but it keeps implementation, review, conflict resolution, research, and planner behavior tied to canvas order.

The target design should keep n8n narrow:

```text
Trigger
  -> Load Session
  -> Claim Next Task
  -> Run One Phase
  -> Persist Result
```

Only one runnable phase should execute per worker run. The phase is selected from the state store, not from GitHub labels and not from n8n node order.

Example state transitions:

```text
queued:implementation
  -> running:implementation
  -> queued:review
  -> running:review
  -> ready_for_human
```

Conflict handling becomes another phase, not a special branch baked into the n8n chain:

```text
queued:review
  -> queued:conflict_resolution
  -> running:conflict_resolution
  -> queued:review
```

This does not require a visually complex n8n workflow. The canvas can stay mostly linear as a dispatch entry point. The branching moves into TypeScript phase dispatch:

```ts
await phaseRegistry.run({
  session,
  task,
  phase: task.phase,
  agent: selectedAgent,
});
```

The important invariant is that `claimNextTask()` is atomic. Once a worker claims a task, no other worker should run the same phase for the same session until the lease expires or the owner releases it.

Initial TypeScript library boundaries:

- `core/task`: task types, phases, statuses, and agent ids
- `core/task-store`: storage interface with atomic operations
- `core/transitions`: transition helpers that are independent of n8n
- `core/phase-runner`: claim one runnable task, run one handler, and persist the next phase
- `stores/memory-task-store`: unit-test adapter
- later `stores/sqlite-task-store`: first durable adapter

The migration should first make this dispatch model testable without changing the existing production workflow. Once the state store and phase dispatch are stable, n8n nodes can be reduced to thin wrappers that call the TypeScript-built JavaScript entry points.

## Existing Patterns To Reuse

The next design should reuse proven workflow and queue patterns where they fit. The goal is not to build a full workflow engine inside this repository; it is to borrow the parts that reduce race conditions and recovery complexity.

Useful patterns:

- **Job queue with leases**: a worker claims a task for a bounded lease period. If the worker dies, the lease expires and the task becomes recoverable.
- **Compare-and-swap state transitions**: every task transition includes expected current state and owner. Conflicts are explicit and safe.
- **Idempotency keys**: operations such as creating PRs, posting review comments, and moving labels should have stable keys so retries do not duplicate external side effects.
- **Transactional outbox**: record the intended external action in local state before calling GitHub, then mark it delivered after success. This helps recover from crashes between state updates and GitHub API calls.
- **Append-only event log**: task history should be recorded as events, with current task state derived or updated alongside the event in the same transaction.
- **Saga-style compensation**: long operations that cannot be a single transaction, such as branch creation, push, PR creation, and label updates, should have explicit recovery or compensation steps.
- **Retry policy with backoff and caps**: transient failures should retry with bounded attempts, while repeated failures should move to a human-visible state.
- **Heartbeat / lease renewal**: long-running Claude or Codex phases should refresh ownership so another worker does not recover the task prematurely.

Existing systems worth studying before implementation:

- **Temporal**: durable workflow concepts, activity retries, idempotency, and long-running workflow state. It may be too heavy to adopt directly, but the concepts are relevant.
- **BullMQ / Sidekiq-style queues**: leased jobs, retry counts, dead-letter queues, and worker concurrency limits.
- **GitHub Actions concurrency groups**: simple model for one active run per key.
- **Database-backed job queues**: `SELECT ... FOR UPDATE SKIP LOCKED` style claiming where supported; SQLite can approximate this with transactions and conditional updates.
- **Transactional outbox pattern**: useful for GitHub API side effects that must be retried safely.

The likely local implementation should start small:

- SQLite adapter with WAL enabled.
- `tasks`, `runs`, `events`, and `outbox` tables.
- atomic `claimNextTask`, `transitionTask`, `renewLease`, and `completeOutboxItem` operations.
- stable idempotency keys for GitHub comments, PR creation recovery, and workflow dispatch.

## External Review Takeaways

An external architecture review recommended the same broad direction: start with SQLite and a custom state layer rather than adopting a heavy workflow engine. The useful additions from that review are below.

### SQLite First, But Not Repo-Local Only

The first SQLite adapter should probably store its database in a shared user-level location, for example:

```text
~/.config/n8n-ai-cli-loop/dev_loop.db
```

This makes a single reusable n8n workflow easier because one state database can register multiple local repositories. Per-repository artifacts can still live under each repo's `.n8n-artifacts/`.

Suggested core tables:

- `repositories`: registered local repositories and default config
- `tasks`: current task state, phase, owner, lease, attempts, JSON context
- `runs`: run-level status, start/end timestamps, and error summary
- `events`: append-only task/run history
- `outbox`: pending external side effects
- `idempotency_keys`: stable keys and cached external operation results

Repository config should include:

- `repo_key`
- `local_path`
- `github_repo`
- verification commands
- default implementation/review agents
- coarse GitHub label names

### Backend Adapters

The interface should keep backend options open:

- `SQLiteTaskStore`: first local implementation using `better-sqlite3`
- `PostgresTaskStore`: later option if cloud n8n and local runners need shared state
- `N8nDataTableTaskStore`: possible n8n-native state adapter
- `MemoryTaskStore`: unit tests

Postgres is not needed initially, but it is the obvious migration target if more than one machine needs to coordinate against the same queue.

### SQLite Safety Rules

SQLite is a good fit only if long operations do not hold database transactions open.

Rules:

- Open a transaction, claim/update state, commit immediately.
- Run long commands such as Claude, Codex, GitHub API calls, `npm test`, and `git push` outside the transaction.
- Open a new transaction to record results.
- Use WAL mode and a nonzero busy timeout.
- Treat lease renewal as a short write transaction.

Suggested initialization:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

### Cloud n8n Boundary

Cloud-hosted n8n cannot directly access local repository files or local CLIs. If this system ever moves beyond local self-hosted n8n, the actual runner still needs to execute locally.

Possible architecture:

- cloud n8n triggers a local daemon through a webhook tunnel
- local daemon polls a shared queue
- Postgres or another network-accessible adapter coordinates state

This is not a near-term requirement, but the storage interface should avoid making cloud migration impossible.

### Additional Failure Modes

Likely missing failure modes:

- n8n execution cancellation while a local agent process continues or dies
- SQLite writer contention if transactions are held too long
- developer manually edits the target working tree during a run
- local branch falls behind remote while a fix is being prepared
- GitHub API rate limits or transient API failures during outbox flush
- PR creation succeeds remotely but the local command times out before recording the URL

Mitigations:

- lease expiry and reclaim
- heartbeat while long-running phases execute
- clean worktree check before claim and before mutation
- remote ref check before push
- outbox retries with exponential backoff
- idempotency keys and recovery lookup for PR/comment/workflow-dispatch operations

## Execute JavaScript vs Thin Execute Command

The ideal n8n node type may be Execute JavaScript or Code, but this depends on the deployed n8n environment:

- whether `require` or dynamic import is allowed
- whether filesystem access is allowed
- whether child processes can be spawned
- whether absolute module paths are acceptable

If Execute JavaScript is too constrained, use thin Execute Command nodes as an intermediate step:

```sh
node /Users/you/git/n8n-ai-cli-loop/dist/cli/run-one-phase.js \
  --session-id "$SESSION_ID" \
  --supported-phases review
```

This still removes the current escaping problem because the generated workflow contains only short commands.

## Migration Plan

1. Add an explicit state store and task schema.
2. Add issue comment commands or a small CLI to enqueue tasks into state.
3. Move queue selection from GitHub labels to the state store.
4. Move agent selection from labels to state/config.
5. Reduce GitHub labels to human-facing state such as `ai:active`.
6. Refactor worker code into phase runner functions.
7. Generate n8n nodes that call one phase at a time through thin JavaScript/command wrappers.
8. Revisit failure semantics once phase runner state is explicit.

This should happen incrementally. The current generated workflow should remain testable and usable while the new model is introduced.

## Open Questions

- Should the first state store be SQLite or n8n Data Tables?
- What is the minimum issue comment command language?
- Should command parsing be opt-in only, for example only comments by repository owners?
- How should manual edits to GitHub issues reconcile with existing state?
- How much state should be mirrored back to GitHub comments for auditability?
- Can the deployed n8n environment safely run Execute JavaScript with local module imports?
