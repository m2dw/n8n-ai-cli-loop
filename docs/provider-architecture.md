# Provider Architecture

This document specifies the provider model that separates **work item
management** from **repository host operations**. It is the foundation for
optional GitHub App support and for future Jira, Azure DevOps, Bitbucket, or
mixed-provider configurations.

It is a design specification only. **No behavior change is required to land
this document.** The current `gh`-CLI workflow remains the MVP; the interfaces
below describe the seams that existing code should be refactored behind, not a
rewrite.

## Why Split The Responsibilities

Today the workflow is tightly coupled to GitHub in several distinct places:

- GitHub Issues as the queue and task source
  (`src/core/github-intake.ts`, `labelsToPhase`)
- GitHub Issue Relationships (`blocked by`) for dependencies
  (`DependencyChecker`, `src/cli/github-intake.ts`)
- GitHub labels as workflow/agent state (`status:*`, `agent:*`, `review:*`)
- GitHub Pull Requests for code review handoff
  (`src/handlers/pr-helpers.ts`, `findOpenPr`)
- GitHub issue comments and labels as the audit/notification surface
  (outbox topics `gh:comment`, `gh:label:add`, `gh:label:remove` in
  `src/handlers/gh-dispatcher.ts`)
- `gh` CLI authentication for every one of the above
  (`defaultGhRunner` in `src/handlers/gh-dispatcher.ts`,
  `CommandRunner` in `src/handlers/command-runner.ts`)

That works for the current local workflow, but it conflates two concerns that
do not have to live in the same system:

- **Work items** — issues/tickets, queue selection, dependencies, comments,
  and workflow state. This could be GitHub Issues, Jira, Azure Boards, Linear,
  or a local store.
- **Repository host** — branches, pull/merge requests, PR comments, PR state,
  and other code-host operations. This could be GitHub PRs, GitLab MRs,
  Bitbucket PRs, or Azure Repos.

A team might run Jira for work items while hosting code on GitHub. Splitting
the two responsibilities lets each be chosen independently, and makes GitHub
App support an **auth/provider option rather than a forked workflow**.

## The Two Provider Interfaces

The intended boundary is:

```ts
// A unit of work: an issue/ticket and its queue/dependency/comment surface.
interface WorkItemProvider {
  /** Queue selection: candidate items eligible to enter the loop. */
  listCandidateItems(query: CandidateQuery): Promise<WorkItem[]>;

  /** Full detail for a single item (body, labels/fields, state). */
  getItem(ref: WorkItemRef): Promise<WorkItemDetails>;

  /**
   * Optional capability: dependency relationships (e.g. "blocked by").
   * Providers without a dependency model omit this; callers must check the
   * `capabilities` descriptor (see "Required vs Optional" below) rather than
   * assume it is present. Implemented by `GitHubIssuesWorkItemProvider`.
   */
  getDependencies?(ref: WorkItemRef): Promise<DependencyInfo>;

  /** Post a human-visible comment / audit note. */
  commentItem(ref: WorkItemRef, body: string, idempotencyKey?: string): Promise<void>;

  /** Move the item's coarse workflow state (label/status/transition). */
  transitionItem(ref: WorkItemRef, transition: WorkItemTransition): Promise<void>;
}

// A code host: branches, pull requests, and PR-level conversation/state.
interface RepoHostProvider {
  /** Resolve the open PR/MR that corresponds to a work item, if any. */
  findPullRequestForWorkItem(ref: WorkItemRef): Promise<PullRequest | undefined>;

  /** Open a PR/MR for an already-pushed branch. */
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;

  /** Fetch a PR/MR by id, including mergeability/state. */
  getPullRequest(ref: PullRequestRef): Promise<PullRequest>;

  /** Post a comment on the PR/MR. */
  commentPullRequest(ref: PullRequestRef, body: string, idempotencyKey?: string): Promise<void>;
}
```

The existing GitHub behavior is expressed as one concrete pairing:

```txt
WorkItemProvider = GitHub Issues   (issues, labels, blocked-by relationships, comments)
RepoHostProvider = GitHub Pull Requests / Git refs
Auth             = gh CLI
```

### Supporting Types (sketch)

These mirror types that already exist so the refactor is a re-homing, not an
invention:

- `WorkItem` ≈ `IssueCandidate` (`src/core/github-intake.ts`): `{ ref, title,
  url, body?, labels/fields, phase, mode?, agent assignments }`.
- `WorkItemRef` identifies an item within a provider, e.g.
  `{ provider: "github-issues", sessionId, id: 214 }`. For GitHub `id` is the
  issue number; for Jira it is the issue key (`PROJ-214`).
- `DependencyInfo` ≈ the `blocked by` snapshot already captured in
  `DependencyDecision` / `BlockedByEntry`.
- `PullRequest` extends today's `PrInfo` (`{ url, headRefName }`) with
  `number`, `state`, and mergeability fields already read in
  `src/handlers/dependency-plan.ts` (`mergeable`, `mergeStateStatus`).
- `WorkItemTransition` is the provider-neutral form of "move to this coarse
  state" — for GitHub it resolves to label add/remove; for Jira it resolves to
  a workflow transition id.

## How GitHub Maps Onto The Interfaces

### `GitHubIssuesWorkItemProvider`

| Interface method      | Current implementation                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| `listCandidateItems`  | `gh issue list ... --json` → `parseCandidates` + `labelsToPhase` (`src/core/github-intake.ts`) |
| `getItem`             | `gh issue view <n> --json ...` (`src/handlers/dependency-plan.ts` reads labels this way) |
| `getDependencies`     | `DependencyChecker.getBlockedBy` via `gh api graphql` `blockedBy` field                  |
| `getDependents`       | the same read in the other direction, via `gh api graphql` `blocking` field (issue #791) |
| `commentItem`         | outbox topic `gh:comment` → `gh api .../comments` (`gh-dispatcher.ts`)                   |
| `transitionItem`      | outbox topics `gh:label:add` / `gh:label:remove` → `gh api .../labels`                   |

The coarse, human-visible state targeted by `transitionItem` is the label set
already modeled in `SessionLabels` (`active`, `blocked`, `readyForHuman`, and the
configurable `stackReady` marker). The `stackReady` transition is required, not
optional: stacked dependents are only unblocked once a passing review adds the
`stackReady` label to their blocker, and a non-passing review must clear it again
so the dependency resolver never branches from an unverified base (see
`src/core/outbox-effects.ts`). A `transitionItem` contract that omits this state
would either keep dependents blocked forever or leave stale stack-ready markers
behind. The detailed phase/queue state is **not** a GitHub concern and continues
to live in the local task store (see
[future-architecture.md](future-architecture.md)).

### `GitHubRepoHostProvider`

| Interface method               | Current implementation                                               |
| ------------------------------ | -------------------------------------------------------------------- |
| `findPullRequestForWorkItem`   | `findOpenPr` → `gh pr list --head ai/issue-<n>` (`pr-helpers.ts`)     |
| `createPullRequest`            | `gh pr create` for an already-pushed head branch (branch push stays a local git operation) |
| `getPullRequest`               | `gh pr view ... --json mergeable,mergeStateStatus,...`               |
| `commentPullRequest`           | `gh pr comment` / `gh api .../comments`                              |

The deterministic head-branch convention (`branchName` →
`ai/issue-<n>` in `pr-helpers.ts`) is the join key between a work item and its
PR. Under a split-provider configuration this becomes part of the
`RepoHostProvider` contract: it must be able to derive (or look up) the branch
that corresponds to a given `WorkItemRef`. For a cross-provider pairing
(e.g. Jira work items + GitHub repo) the convention generalizes to
`ai/<work-item-key>` (e.g. `ai/PROJ-214`).

### `GiteaRepoHostProvider` — and how repo-host Gitea differs from work-item Gitea

A Gitea **repo host** (`src/providers/gitea/gitea-repo-host-provider.ts`, issue
#365) implements the same `RepoHostProvider` interface as the GitHub one, so
handlers and the outbox dispatcher treat it identically. It is selected by a
session whose `repoHostProvider.provider` is `gitea`, via
`resolveRepoHostProvider` (`src/providers/repo-host-factory.ts`) — the seam that
turns a validated `RepoHostProviderConfig` into a concrete provider. GitHub
remains the default; an unconfigured session is unchanged.

It is important to keep this **distinct from the Gitea work-item provider**
(`gitea-issues`, the MVP of [gitea-private-work-items.md](gitea-private-work-items.md)).
They are independent slices that happen to share a backend vendor:

| Concern | Gitea **work-item** provider (`gitea-issues`) | Gitea **repo-host** provider (`gitea`) |
| --- | --- | --- |
| Interface | `WorkItemProvider` (issues, labels, dependencies, comments) | `RepoHostProvider` (pull requests + PR comments) |
| Role in the MVP topology | The private AI workflow tracker (Tier 1 internal discussion) | A code host alternative to GitHub PRs — the MVP keeps GitHub here |
| Config block | `workItemProvider.gitea` (`GiteaWorkItemConfig`, includes `labelMapping`) | `repoHostProvider.gitea` (`GiteaRepoHostConfig`, **no** `labelMapping`) |
| May point at | A private *work-item* repository | The *code* repository (possibly a different repo, even a different instance) |
| Visibility tier of its comments | Tier 1 (bounded/sanitized internal record) | Tier 2 (public-safe PR summary) — same policy as the GitHub repo host |
| Coarse-state mapping | `transitionItem` → Gitea labels/status | n/a — a repo host has no work-item state |

Because the two are separate providers with separate connection blocks, a session
can mix them freely: Gitea work items + GitHub repo host (the MVP), GitHub issues
+ Gitea repo host, or Gitea on both sides (with each block pointing at its own
repository). The connection blocks are declared independently precisely so the
work-item repo and the code repo need not coincide.

The Gitea REST surface is **not** assumed GitHub-compatible (the standing
verification obligation). Verified differences the provider absorbs:

| `RepoHostProvider` method | Gitea v1 call | Difference from GitHub |
| --- | --- | --- |
| `findPullRequestForWorkItem` | `GET /repos/{o}/{r}/pulls?state=open` then match `head.ref` client-side | Gitea has **no `--head` list filter**, so the `ai/issue-<n>` convention is matched in the provider |
| `createPullRequest` | `POST /repos/{o}/{r}/pulls` `{title,head,base,body}` | head branch still pushed by local git first |
| `getPullRequest` | `GET /repos/{o}/{r}/pulls/{index}` | mergeability degrades (below) |
| `commentPullRequest` | `POST /repos/{o}/{r}/issues/{index}/comments` | a PR **shares its index with an issue**, so there is no separate PR-comment resource |

**Mergeability degradation.** Gitea exposes a single boolean `mergeable` and has
no equivalent of GitHub's `mergeStateStatus` (CLEAN/DIRTY/BLOCKED/…). The provider
maps `mergeable: true → "MERGEABLE"`, `false → "CONFLICTING"`, and an
absent/uncomputed field → `"UNKNOWN"`, and **never sets** `mergeStateStatus`. This
keeps existing consumers safe-by-default: the review merge gate promotes only on a
confirmed `"MERGEABLE"`, so `"UNKNOWN"` fails closed to a human rather than
auto-merging. Note Gitea's boolean conflates a true content conflict with a policy
block (e.g. required reviews), so a Gitea `"CONFLICTING"` is a conservative "not
cleanly mergeable" signal, not a guaranteed textual conflict.

Like the GitHub providers, the Gitea provider depends on a single injectable
seam — `GiteaClient` (`src/providers/gitea/gitea-client.ts`), an HTTP-request
executor analogous to `GhRunner` — so tests drive PR lookup/create/comment through
a fake client with no live Gitea. Auth is `api-token` only (the GitHub `gh`/App
runners cannot reach Gitea); the token is resolved by indirection and carried in
the `Authorization: token …` header, never on argv. As with the GitHub App `*Key`
fields, the credential-key form `tokenKey` is **not yet wired to a runtime
resolver** for a `gitea` repo host — the production CLI/handler paths build
`defaultGiteaClientBuilder()` without one — so the validator currently **rejects**
`tokenKey` for `repoHostProvider.provider: "gitea"`; use `tokenEnv` until a
resolver is implemented.

## Provider-Neutral Outbox And Its Visibility Policy

The transactional outbox (`src/core/outbox.ts`,
`src/handlers/gh-dispatcher.ts`) is the publication seam: handlers never call a
provider directly, they enqueue a side-effect row that a separate dispatch run
drains. Two topic families coexist on the same outbox table:

- **Legacy GitHub topics** — `gh:comment`, `gh:label:add`, `gh:label:remove`.
  These dispatch directly against GitHub Issues with the exact `gh` argv they
  always used. They are preserved unchanged so existing sessions keep their
  observable behavior; they are **not** removed until compatibility tests prove
  the provider-neutral path reproduces them.
- **Provider-neutral topics** — `workitem:comment`, `workitem:transition`,
  `repohost:pr-comment`. Each row carries the configured provider *kind* (e.g.
  `github-issues`, `github`, later `gitea`) plus an `owner`/`repo` pair. At
  dispatch time the kind selects which provider implementation handles the row
  (`defaultOutboxProviderFactory` in `gh-dispatcher.ts`), so the dispatcher
  **constructs the provider from the session/provider config** rather than
  assuming GitHub issue endpoints. The `github-issues` / `github` kinds resolve
  back to the same `GhWorkItemProvider` / `GhRepoHostProvider`, producing
  byte-identical `gh` argv to the legacy topics (proven by
  `test/outbox-provider-neutral.test.js`). A kind with no wired provider is a
  **retryable** per-entry failure: the row stays pending (with bounded backoff
  between attempts, issue #606) instead of being dropped or mis-routed to
  GitHub, so enabling the provider before the row exhausts its retry budget
  drains the backlog. Idempotency keys use the same `makeOutboxKey` scheme, so
  dedup behavior is identical across both families.

These three provider-neutral comment topics map onto three distinct comment
**surfaces**, each with a maximum disclosure tier. The policy is enforced in one
place — `enforceCommentVisibility` in `src/core/outbox-visibility.ts`, which the
provider-neutral enqueue helpers call before a body is persisted — so every
publication path goes through the same bounded/sanitized writer:

| Outbox topic           | Surface (provider role)            | Tier | Maximum fidelity |
| ---------------------- | ---------------------------------- | :--: | --------------- |
| `workitem:comment`     | Work-item provider (Issues/Gitea)  |  1   | Bounded, sanitized internal workflow feedback (phase outcomes, decisions, truncated excerpts). Never a verbatim dump of raw prompts or full agent output. |
| `repohost:pr-comment`  | Repo-host provider (public PR)      |  2   | Public-safe review/status summary only. No raw prompts, no local filesystem/artifact paths, no secrets, no private work-item links. |
| `workitem:comment` on a **public** issue (split-provider mode) | Public, human-owned work item |  2   | Human-safe summary, or nothing. Must never receive raw AI conversation details. |

The tiers (Tier 0 raw / local-only, Tier 1 bounded private, Tier 2 public
summary) and the per-surface ceilings are specified in full in
[gitea-private-work-items.md](gitea-private-work-items.md). Enforcement details:

- **Sanitization is mandatory on every published comment.** Both tiers are
  bounded and run through `sanitizeBody`, which strips absolute filesystem paths
  (built-in heuristics plus any configured `repoRoot` / `artifactRoot`). **No
  raw local artifact path is ever introduced into a public comment**, and the
  private work-item surface — which is still untrusted input, not just an output
  sink — receives the same path stripping.
- **Secret redaction** for agent-controlled free text (commands, tokens,
  `Authorization` headers) is applied by the caller before the body reaches the
  outbox (see `redactCommand` in `src/core/outbox-effects.ts`), matching the
  redaction posture used for GitHub App token handling.
- **The surface, not the provider, sets the ceiling.** `enforceCommentVisibility`
  is provider-agnostic: a `workitem:comment` may carry Tier 1 detail whether the
  backend is GitHub or Gitea, while a `repohost:pr-comment` is always held to the
  public Tier 2 summary.

## Authentication Is A Provider Concern, Not A Workflow Fork

Auth is injected, not branched on. The existing code already has the seam:
every GitHub call goes through an injectable runner
(`GhRunner` in `gh-dispatcher.ts`, `CommandRunner` in `command-runner.ts`),
and the default is the real `gh` CLI (`defaultGhRunner`). GitHub App support is
a second implementation of the **auth strategy** behind the same providers.

```ts
interface GitHubAuth {
  /** Returns a usable token (PAT-equivalent) for REST/GraphQL/git operations. */
  getToken(): Promise<string>;
}

// MVP: shell out to the already-authenticated gh CLI. No token handling here.
class GhCliAuth implements GitHubAuth { /* uses `gh` to run commands */ }

// Optional: mint short-lived installation tokens from an App's private key.
class GitHubAppAuth implements GitHubAuth {
  // appId + installationId + private key (loaded from a secret source, never
  // from sessions.json) → POST /app/installations/<id>/access_tokens
}
```

How GitHub App auth fits under the GitHub providers:

- The provider pairing stays `GitHub Issues` + `GitHub PRs`. Only the
  `GitHubAuth` instance changes.
- `GitHubAppAuth` exchanges the App private key + installation id for a
  **short-lived installation access token**, then runs the same REST/GraphQL
  calls (and `git` over HTTPS using the token) that the `gh` path runs.
- Token lifetime is bounded (GitHub installation tokens expire in ~1 hour);
  the auth strategy is responsible for caching and refreshing within the
  process, never persisting the minted token.

Because both auth strategies satisfy the same provider interfaces, choosing
GitHub App vs `gh` is configuration, not a separate code path through the
phase runner.

## Which Responsibilities Stay Local Git

Some operations are **neither** work-item nor repo-host provider calls — they
are plain local git against the working tree at `session.repoRoot`, and they
stay that way regardless of provider:

- creating, checking out, and resetting branches in the local clone
- staging, committing, and `git push`
- reading working-tree state (`git status`, `git diff`, `git log`, `git show`)
- the single-worker repo lock and stale-lock recovery
  (`.n8n-artifacts/repo.lock`, `src/stores/repo-lock-store.ts`)
- worktree-clean checks before claiming/mutating

These remain local because the runner must execute where the clone lives
(see the "Cloud n8n Boundary" note in
[future-architecture.md](future-architecture.md)). The `RepoHostProvider`
covers only the **hosted** side of git (PR creation/lookup/state); pushing the
branch that a PR is opened against is a local git operation. `createPullRequest`
therefore assumes the head branch has already been pushed.

## Required vs Optional / Provider-Specific Capabilities

The MVP only needs a small required core; everything else is a capability a
provider may or may not implement.

**Required (every `WorkItemProvider`):**

- `listCandidateItems`, `getItem`, `commentItem`, `transitionItem`

**Required (every `RepoHostProvider`):**

- `findPullRequestForWorkItem`, `createPullRequest`, `getPullRequest`,
  `commentPullRequest`

**Optional / provider-specific:**

- `getDependencies` — declared optional on the `WorkItemProvider` interface
  (note the `?`). GitHub Issue Relationships (`blocked by`) and Jira issue links
  map cleanly; a provider without a dependency model simply omits the method
  rather than supplying a fake no-op. Callers consult the `capabilities`
  descriptor and, when the capability is absent, treat the item as having no
  dependencies so the stacked-execution gate (`isStackableBlockedCase`) is
  never taken.
- Rich PR mergeability (`mergeable` / `mergeStateStatus`) — GitHub exposes
  these; a host that does not should degrade gracefully (conflict-resolution
  phase falls back to attempting a rebase rather than pre-checking).
- Native workflow transitions — Jira has first-class transitions; GitHub
  approximates state with labels. `transitionItem` hides this difference.
- Idempotency keys for comments/PR creation — surfaced as optional parameters
  so providers that support natural dedup (or the local outbox
  `idempotency_keys` table) can use them.

Capability discovery should be explicit (e.g. a `capabilities` descriptor on
each provider) so the phase runner can branch on "does this provider support
dependencies?" rather than catching `NotImplemented` errors.

## MVP: Preserve Current `gh` Behavior While Introducing Seams

The migration must not change observable behavior. Concretely, the MVP:

1. Defines the `WorkItemProvider` / `RepoHostProvider` interfaces and the
   supporting types.
2. Wraps the **existing** `gh`-backed code behind
   `GitHubIssuesWorkItemProvider` and `GitHubRepoHostProvider`, reusing
   `parseCandidates`, `findOpenPr`, the outbox `gh:*` topics, and the
   injectable `GhRunner` / `CommandRunner` unchanged.
3. Keeps `GhCliAuth` (shell out to `gh`) as the only wired auth strategy.
   `GitHubAppAuth` is specified here but not required for the MVP.
4. Leaves the queue, labels, phase contracts, and tests behaving exactly as
   today. This is a re-homing of call sites behind interfaces, not a rewrite.

The win is that adding GitHub App auth, or a Jira `WorkItemProvider`, becomes a
new class plus a config entry — not a second copy of the phase runner.

## Secrets Must Not Live In `sessions.json`

`sessions.json` (`src/registries/json-session-registry.ts`,
default `~/.config/n8n-ai-cli-loop/sessions.json`) is a plaintext, readable
config file that holds repo roots, GitHub `owner/name`, labels, and agent
defaults. **It must never contain secret material** — no GitHub App private
keys, no installation tokens, no Jira API tokens, no passwords.

Rules:

- The session config references secrets **by indirection only** — an auth
  *kind* plus a pointer to where the secret is resolved from: an environment
  variable name (`*Env`) or a credential-key / keychain reference (`*Key`),
  exactly one form per secret. The session validator (`validateSession`)
  rejects a config that inlines key material, and rejects supplying both the
  `*Env` and `*Key` form for the same secret.
- Secret resolution happens at runtime inside the auth strategy, from a source
  outside `sessions.json`: environment variables (see `.env.example`), a file
  path the operator controls (e.g. an App `.pem`), or a secrets manager.
- Minted/short-lived tokens (GitHub App installation tokens) are held in memory
  for their lifetime and never written back to disk or into task context /
  `sessions.json`.

## Initial Session Config Shapes

These extend the current `SessionConfig` (`src/core/session.ts`) with two
optional fields — `workItemProvider` and `repoHostProvider` — parsed and
validated by `validateSession` in `src/registries/json-session-registry.ts`.
Each carries a `provider` identifier and an `auth` block.

A session that omits both fields defaults to today's behavior (GitHub Issues +
GitHub repo host via `gh`), so existing `sessions.json` files keep working
unchanged. After resolution both fields are always present on `ResolvedSession`.

The `github-issues` (work item) and `github` (repo host) providers are
implemented, over both `gh` auth (default) and `github-app` auth (see
[GitHub App auth — runtime flow](#github-app-auth--runtime-flow) below). The
other provider identifiers (`gitea-issues`, `jira`, `azure-devops`, `bitbucket`)
and the `api-token` auth mode are recognized so future backends can be declared
explicitly without a config-format change, but have no runtime provider yet.

`gitea-issues` additionally carries a non-secret connection block, `gitea`
(base URL, owner/org, repo, optional API path and label-mapping strategy), since
a self-/co-hosted Gitea instance has no implicit base URL or `owner/name`
derivable from `githubRepo` — see
[Gitea work items + GitHub repo host](#4-gitea-work-items--github-repo-host)
below. Because no Gitea runtime provider exists yet, the validator requires its
auth to be `api-token`: a session that selects `gitea-issues` therefore **fails
closed** at every GitHub `gh`/App runner resolution (intake listing, GraphQL
dependency checks, outbox dispatch) instead of silently reading the GitHub repo.

### 1. GitHub Issues + GitHub repo host via `gh` (current behavior, default)

```json
{
  "sessionId": "n8n-ai-cli-loop",
  "repoKey": "n8n-ai-cli-loop",
  "repoRoot": "/path/to/n8n-ai-cli-loop",
  "githubRepo": "m2dw/n8n-ai-cli-loop",
  "artifactDir": ".n8n-artifacts",
  "defaults": { "implementationAgent": "claude", "reviewAgent": "codex" },
  "verification": { "test": "npm test" },
  "labels": { "active": "ai:active", "blocked": "ai:blocked", "readyForHuman": "ai:ready-for-human" },

  "workItemProvider": { "provider": "github-issues", "auth": { "mode": "gh" } },
  "repoHostProvider": { "provider": "github", "auth": { "mode": "gh" } }
}
```

`auth.mode = "gh"` carries no secret: it relies on the operator's
already-authenticated `gh` session. This block is the exact equivalent of
omitting both fields.

### 2. GitHub Issues + GitHub repo host via GitHub App auth

```json
{
  "sessionId": "n8n-ai-cli-loop-app",
  "repoKey": "n8n-ai-cli-loop",
  "repoRoot": "/path/to/n8n-ai-cli-loop",
  "githubRepo": "m2dw/n8n-ai-cli-loop",
  "artifactDir": ".n8n-artifacts",
  "defaults": { "implementationAgent": "claude", "reviewAgent": "codex" },
  "verification": { "test": "npm test" },
  "labels": { "active": "ai:active", "blocked": "ai:blocked", "readyForHuman": "ai:ready-for-human" },

  "workItemProvider": {
    "provider": "github-issues",
    "auth": {
      "mode": "github-app",
      "appIdEnv": "N8N_AI_GITHUB_APP_ID",
      "installationIdEnv": "N8N_AI_GITHUB_INSTALLATION_ID",
      "privateKeyPathEnv": "N8N_AI_GITHUB_APP_PRIVATE_KEY_PATH"
    }
  },
  "repoHostProvider": {
    "provider": "github",
    "auth": {
      "mode": "github-app",
      "appIdEnv": "N8N_AI_GITHUB_APP_ID",
      "installationIdEnv": "N8N_AI_GITHUB_INSTALLATION_ID",
      "privateKeyPathEnv": "N8N_AI_GITHUB_APP_PRIVATE_KEY_PATH"
    }
  }
}
```

Every credential is referenced by **indirection**: each `*Env` field names the
environment variable that the auth strategy resolves at runtime. No App id,
installation id, or private key (raw or path) is stored in `sessions.json`. The
validator rejects raw secret keys (`appId`, `installationId`, `privateKey`,
`privateKeyPath`, `token`, …) in favor of their indirection form.

The sibling `*Key` field (credential key / keychain entry — e.g. `appIdKey`
instead of `appIdEnv`) is reserved for resolving credentials from a secrets
manager or OS keychain. **It is not yet wired to a runtime resolver for
`github-app` auth**, so the validator currently rejects `appIdKey` /
`installationIdKey` / `privateKeyPathKey`; use the `*Env` form until a resolver
is implemented. A secret must be referenced by **exactly one** form; supplying
both `*Env` and `*Key` for the same secret is rejected.

```json
{
  "workItemProvider": {
    "provider": "github-issues",
    "auth": {
      "mode": "github-app",
      "appIdEnv": "N8N_AI_GITHUB_APP_ID",
      "installationIdEnv": "N8N_AI_GITHUB_INSTALLATION_ID",
      "privateKeyPathEnv": "N8N_AI_GITHUB_APP_PRIVATE_KEY_PATH"
    }
  },
  "repoHostProvider": {
    "provider": "github",
    "auth": {
      "mode": "github-app",
      "appIdEnv": "N8N_AI_GITHUB_APP_ID",
      "installationIdEnv": "N8N_AI_GITHUB_INSTALLATION_ID",
      "privateKeyPathEnv": "N8N_AI_GITHUB_APP_PRIVATE_KEY_PATH"
    }
  }
}
```

#### GitHub App auth — runtime flow

`github-app` auth is implemented by
`src/providers/github/github-app-auth.ts`. When a GitHub provider is configured
with `mode: "github-app"`, `createGhRunnerForAuth` resolves the credentials and
performs the standard GitHub App handshake:

1. Resolve the App id, installation id, and private-key **path** from their
   `*Env` references, then read the PEM key from that file.
2. Build a short-lived App JWT (RS256, 10-minute lifetime, issued-at backdated
   60s for clock skew) signed with the private key.
3. Exchange the JWT for an **installation access token** via
   `POST /app/installations/{installation_id}/access_tokens`.
4. Cache the installation token and reuse it until it is within 60s of expiry,
   then refresh transparently.

The runtime selects the executor through `resolveGhRunner`, the seam the
handler and CLI provider-construction paths call (implementation, review,
conflict-resolution, dependency-plan intake, and the outbox dispatcher). For
`gh` mode it returns the operator's `gh` session unchanged; for `github-app`
mode it returns the App runner from `createGhRunnerForAuth`. So when a session
sets `workItemProvider.auth.mode` / `repoHostProvider.auth.mode` to
`github-app`, the App credentials are actually resolved and `GH_TOKEN` injected
at the point each `GhWorkItemProvider` / `GhRepoHostProvider` is built.

The outbox dispatcher resolves these two auth domains **independently**: work-item
rows (`workitem:*` and legacy `gh:*` issue comments / label changes) dispatch under
`workItemProvider.auth`, while repo-host rows dispatch under `repoHostProvider.auth`
**when a `repoHostProvider` is explicitly configured**. A repo-host row is either
the provider-neutral `repohost:pr-comment` topic *or* a legacy PR-timeline comment
queued by the pre-split-auth code — those have topic `gh:comment` with a trailing
`:pr` idempotency-key token and carry the PR number in `payload.issueNumber`. The
dispatcher detects that `:pr` token so a public PR comment already sitting in the
outbox at upgrade time is also dispatched with repo-host credentials, never posted
under the work-item identity (or stranded for a non-GitHub work-item session); it
still dispatches through the `gh:comment` path, only its auth domain is
reclassified. "Explicitly configured" means the operator declared the block in
the session config, tracked as `ResolvedSession.repoHostProviderConfigured` — not
whether the resolved value differs from the default. This distinction matters:
an explicit `{ provider: "github", auth: { mode: "gh" } }` is byte-identical to
the registry default yet is still honored as a split-auth choice, so its public
PR comments post under the operator `gh` identity even when `workItemProvider`
uses `github-app`. When `repoHostProvider` is omitted, the registry defaults it to
github/`gh`, but the dispatcher does **not** switch repo-host rows to that default
operator `gh` identity: it falls back to the work-item runner, preserving the
pre-split single-auth behavior. So an existing session that configured
`github-app` auth only under `workItemProvider` keeps posting PR comments under
the App — it does not silently regress to the operator's `gh` session (which
would fail on a headless / App-only runner, or post as the wrong actor). In a single-auth session
the two domains therefore use the one configured identity; in a **split-auth**
session (an explicit `repoHostProvider`) they differ, and a public PR comment is
never posted with work-item credentials. Each domain's runner is resolved at most
once per drain and only when a row of that domain is actually pending, so a drain
carrying only one domain's rows never resolves (or token-exchanges) the other's
credentials.

The installation token is handed to `gh` through the `GH_TOKEN` environment
variable, so every existing provider argv runs unchanged — only the credential
source differs. The runner resolves the token **per invocation** rather than
capturing it once: it reads `GitHubAppAuth.getCachedToken()` on every `gh` call,
which serves the cached token and proactively refreshes ahead of expiry, so a
long-lived process never keeps using an expired installation token. `gh` auth
remains the default and backward-compatible path: a session without a
`github-app` block keeps using the operator's `gh` session.

Tokens, JWTs, private keys, and `Authorization` headers are never logged. Token
exchange errors are built from HTTP status lines only and passed through a
redaction filter as defense in depth.

**Required GitHub App permissions** for the MVP (API operations only):

| Permission     | Access       | Used for                                            |
| -------------- | ------------ | --------------------------------------------------- |
| Metadata       | Read         | Baseline repository access (always required)        |
| Issues         | Read & write | Issue list/read, comments, label transitions, deps  |
| Pull requests  | Read & write | PR list/read/create, comments, metadata reads       |
| Contents       | Read & write | **Only if** a future `git push` via the App token is enabled |

`git push` is **not** covered by GitHub App auth in this MVP: branch pushes
continue to use local git credentials, so `Contents` is unnecessary unless that
future capability is turned on.

### 3. Future: Jira work items + GitHub repo host

```json
{
  "sessionId": "acme-app",
  "repoKey": "acme-app",
  "repoRoot": "/path/to/acme-app",
  "githubRepo": "acme/acme-app",
  "artifactDir": ".n8n-artifacts",
  "defaults": { "implementationAgent": "claude", "reviewAgent": "codex" },
  "verification": { "test": "npm test" },
  "labels": { "active": "ai:active", "blocked": "ai:blocked", "readyForHuman": "ai:ready-for-human" },

  "workItemProvider": {
    "provider": "jira",
    "auth": {
      "mode": "api-token",
      "emailEnv": "N8N_AI_JIRA_EMAIL",
      "tokenEnv": "N8N_AI_JIRA_API_TOKEN"
    }
  },
  "repoHostProvider": { "provider": "github", "auth": { "mode": "gh" } }
}
```

Here the queue, dependencies, comments, and coarse state would move to Jira
(`listCandidateItems` ← JQL; `transitionItem` ← Jira workflow transitions;
`getDependencies` ← Jira issue links), while branches and PRs stay on GitHub.
The branch join key generalizes from `ai/issue-<n>` to `ai/<jira-key>`
(e.g. `ai/ACME-214`). As with the App config, the Jira email and token are
referenced by env-var name and never stored in `sessions.json`. The `jira`
provider and `api-token` mode are recognized by the config shape but not yet
implemented as a runtime provider.

### 4. Gitea work items + GitHub repo host

A minimal session that tracks work items in a private Gitea instance while
keeping branches and PRs on GitHub (the pairing specified in
[gitea-private-work-items.md](gitea-private-work-items.md)):

```json
{
  "sessionId": "acme-private",
  "repoKey": "acme-private",
  "repoRoot": "/path/to/acme",
  "githubRepo": "acme/acme",
  "artifactDir": ".n8n-artifacts",
  "defaults": { "implementationAgent": "claude", "reviewAgent": "codex" },
  "verification": { "test": "npm test" },
  "labels": { "active": "ai:active", "blocked": "ai:blocked", "readyForHuman": "ai:ready-for-human" },

  "workItemProvider": {
    "provider": "gitea-issues",
    "gitea": {
      "baseUrl": "https://gitea.example.com",
      "owner": "acme",
      "repo": "acme-private",
      "apiPath": "/api/v1",
      "labelMapping": "labels"
    },
    "auth": {
      "mode": "api-token",
      "tokenEnv": "N8N_AI_GITEA_API_TOKEN"
    }
  },
  "repoHostProvider": { "provider": "github", "auth": { "mode": "gh" } }
}
```

The `gitea` block holds only **non-secret** connection settings. Unlike GitHub —
which derives owner/name from the top-level `githubRepo` and reaches a single
known host — a Gitea instance is self-/co-hosted, so its location (`baseUrl`) and
target repository (`owner`/`repo`) must be declared explicitly. `apiPath`
(default `/api/v1`) and `labelMapping` (default `labels`) are optional. `baseUrl`
must be a plain http(s) URL: a URL embedding `user:password@host` is rejected so
no credential ever lands in `sessions.json`.

Auth is `api-token` only. The Gitea token is referenced **by indirection**
through `tokenEnv` and resolved at runtime — a raw `token`/`password` in the
config is rejected, and error messages never echo token values. The credential-key
`tokenKey` form is **not wired for Gitea yet** (no production resolver), so
`validateSession` rejects it for `gitea-issues`; use `tokenEnv` until a resolver
lands. The provider id `gitea-issues` (parallel to `github-issues`) is the stable
name. The sibling `gitea` **repo-host** id (the distinct `RepoHostProvider` for
PRs, not work items) has since been implemented as its own slice — issue #365,
example 5 below — so a session may keep GitHub as the repo host (as here) or move
PRs to Gitea independently.

No Gitea *work-item* runtime provider is wired yet. Selecting `gitea-issues` is intentionally
fail-closed: every GitHub `gh`/App runner resolution throws on the required
`api-token` auth, and the provider-neutral outbox / dependency-check paths
surface a clear `Unsupported work-item provider: gitea-issues` (or
`Dependency checks are not implemented for work-item provider "gitea-issues"`)
error instead of falling back to GitHub.

### 5. GitHub work items + Gitea repo host

The mirror image of example 4: issues stay on GitHub (the default work-item
provider, so `workItemProvider` is omitted) while pull requests move to a
self-/co-hosted Gitea instance. A session selects the Gitea repo host by
declaring this `repoHostProvider` block; `resolveRepoHostProvider`
(`src/providers/repo-host-factory.ts`) resolves it to a `GiteaRepoHostProvider`,
while an unconfigured session stays on the GitHub default:

```json
{
  "sessionId": "acme-gitea-prs",
  "repoKey": "acme-gitea-prs",
  "repoRoot": "/path/to/acme",
  "githubRepo": "acme/acme",
  "artifactDir": ".n8n-artifacts",
  "defaults": { "implementationAgent": "claude", "reviewAgent": "codex" },
  "verification": { "test": "npm test" },
  "labels": { "active": "ai:active", "blocked": "ai:blocked", "readyForHuman": "ai:ready-for-human" },

  "repoHostProvider": {
    "provider": "gitea",
    "gitea": {
      "baseUrl": "https://gitea.example.com",
      "owner": "acme",
      "repo": "acme",
      "apiPath": "/api/v1"
    },
    "auth": {
      "mode": "api-token",
      "tokenEnv": "N8N_AI_GITEA_API_TOKEN"
    }
  }
}
```

The `repoHostProvider.gitea` block is the **repo-host** sibling of the work-item
`gitea` block in example 4 — same non-secret connection shape (`baseUrl` /
`owner` / `repo` / optional `apiPath`) and the same `api-token`-by-indirection
auth, but **no** `labelMapping` (a repo host addresses pull requests, not labels).
The two blocks are independent, so the code repo here (`acme/acme` on Gitea) need
not be the GitHub `githubRepo` and may even differ from a work-item Gitea repo.
Auth is `api-token` only: a `gitea` repo host is reached over the Gitea REST API,
never the GitHub `gh`/App runners, so any other auth mode is rejected and a public
PR/PR-comment can never be published to the GitHub repo under the operator's `gh`
session. See the **`GiteaRepoHostProvider`** section above for the verified Gitea
REST surface and the mergeability degradation (`mergeable` boolean →
`MERGEABLE`/`CONFLICTING`/`UNKNOWN`, no `mergeStateStatus`).

## Relationship To Other Docs

- [gitea-private-work-items.md](gitea-private-work-items.md) — applies this
  split to a concrete cross-provider pairing (Gitea work items + GitHub repo
  host) and specifies the private-work-item visibility tiers and
  prompt-injection boundary for AI-driven development.
- [github-to-gitea-import.md](github-to-gitea-import.md) — the one-way,
  allow-listed import of a public GitHub issue into a private Gitea work item,
  and why no raw AI interaction is written back to public GitHub.
- [future-architecture.md](future-architecture.md) — the local state store,
  phase runner, leases, and outbox that this provider model plugs into. The
  suggested `github` module there is the natural home for the GitHub provider
  implementations.
- [phase-contracts.md](phase-contracts.md) — the per-phase behavioral contract
  the providers serve; phases call providers, they do not call `gh` directly
  once the seams are in place.
