# Feature Status Matrix

Status: **maintained** (issue #946). This is the canonical, repository-wide
answer to "can I use this now, does it require configuration, is it only a
foundation, or is it design-only?" It is an overview and navigation document.
Runtime source and the detailed contracts it links to remain authoritative
for behavior — this matrix never restates their specifications, only points
at them.

## 1. Status vocabulary

Every row below carries exactly one of these six statuses. No other word
(e.g. "partial", "in progress", "beta") is a valid status value; use the
**Gaps** field to describe nuance instead of inventing a new status.

- **`available`** — wired into a supported runtime or operator path with no
  extra configuration required beyond normal setup. An operator can use it
  today by following the linked docs/CLI.
- **`config-gated`** — implemented and wired end to end, but disabled or
  unavailable until an explicit session/runtime configuration flag enables
  it. The **Configuration** field must name the flag and its default.
- **`foundation-only`** — reusable, tested components exist in `src/`, but no
  supported end-to-end operator workflow strings them together. Naming a
  component "implemented" in its own contract does not make the aggregate
  feature `available`; see §2's ChatOps rule.
- **`design-only`** — an approved or draft design exists with no supported
  runtime implementation. `grep -r` for the design's central type/class in
  `src/` returns nothing, or only unused scaffolding.
- **`deprecated`** / **`archived`** — retained only for migration or history;
  not recommended for current operation. The row must name the replacement.

## 2. Inclusion and transition rules

- **A closed design Issue is not evidence of `available`.** Closing the Issue
  that wrote a contract document records an accepted policy, not a shipped
  runtime path. A row only moves off `design-only` when the **Evidence**
  field names a real source file, CLI subcommand, or test that exercises the
  runtime path — never an Issue or PR number alone.
- **Component-level "implemented" is not feature-level `available`.** A
  contract for one layer of a multi-layer feature (see the ChatOps row in §4)
  can correctly say "implemented" for that layer while the aggregate feature is
  `foundation-only`, because no supported path chains the layers together.
  When a component doc's status could be misread this way, it must carry a
  pointer back to this matrix (see the ChatOps contracts for the pattern).
- **`foundation-only` → `config-gated` or `available`** happens when a
  handler, CLI subcommand, or scheduled job exists that an operator can
  invoke end to end. It does not require the feature to be on by default.
- **`config-gated` → `available`** happens only when the session/runtime
  default itself flips to enabled — not when the capability merely exists.
- **`available` → `deprecated`/`archived`** happens when a replacement path
  ships and the old path is kept only for migration or compatibility.
- **Every transition needs evidence in the same change.** A PR that changes
  what a feature can do, how it is gated, or whether it is wired must update
  this file's row (and its `Status`/`Configuration`/`Evidence` fields) in the
  same change — see §5.

## 3. How to read a row

Each row lists, in order: **Status**, **Capability** (one operator-visible
sentence), **Configuration** (flag and default, or "none"), **Evidence**
(repository-relative source/CLI paths), **Docs** (authoritative contracts —
detail lives there, not here), **Gaps** (what a reader must not assume), and
**Related Issues** where useful. Detail belongs in the linked contract, not
in a longer row here.

## 4. Matrix

### Core execution pipeline

#### Issue intake and phase execution

- **Status:** `available`
- **Capability:** GitHub Issues enter the loop through label-driven intake
  and advance through a fixed `TaskPhase` pipeline, one phase execution per
  invocation.
- **Configuration:** none; this is the default runtime path.
- **Evidence:** `src/cli/github-intake.ts`, `src/core/github-intake.ts`,
  `src/cli/run-one-phase.ts`, `src/core/transitions.ts`, `src/core/task.ts`.
- **Docs:** [DOMAIN.md](DOMAIN.md), [phase-contracts.md](phase-contracts.md).
- **Gaps:** none known.

#### Implementation, review, conflict resolution, and research (phase handlers)

- **Status:** `available`
- **Capability:** agent-driven implementation, review, conflict-resolution,
  and research phases, each invoked one phase per `run-one-phase` call.
- **Configuration:** agent/model selection is session-configured; the phases
  themselves require no enablement flag.
- **Evidence:** `src/handlers/implementation.ts`, `src/handlers/review.ts`,
  `src/handlers/conflict-resolution.ts`, `src/handlers/research.ts`.
- **Docs:** [handlers-extraction-plan.md](handlers-extraction-plan.md),
  [phase-contracts.md](phase-contracts.md).
- **Gaps:** none behavioral; the handler files themselves are tracked for a
  size/responsibility extraction (issue #692), a maintainability concern, not
  a capability gap.
- **Related Issues:** #692

#### Content research, draft, and review

- **Status:** `available`
- **Capability:** a separate content pipeline (research → draft → review)
  for content-labeled work items.
- **Configuration:** none; on by default for content-labeled items.
- **Evidence:** `src/handlers/content-research.ts`,
  `src/handlers/content-draft.ts`, `src/handlers/content-review.ts`.
- **Docs:** [content-research-mvp-contract.md](content-research-mvp-contract.md),
  [content-draft-mvp-contract.md](content-draft-mvp-contract.md),
  [content-review-mvp-contract.md](content-review-mvp-contract.md),
  [content-human-ready-handoff.md](content-human-ready-handoff.md).
- **Gaps:** each contract is scoped to an MVP; see the individual documents
  for what is explicitly out of scope.

#### Agent assignment profiles

- **Status:** `available`
- **Capability:** configurable, per-role agent-CLI assignment (which agent
  implements, reviews, resolves conflicts, or researches) without hardcoding
  a single pairing.
- **Configuration:** session `assignmentProfiles`/`flowRules`; a session that
  configures neither derives a built-in default profile.
- **Evidence:** `src/core/assignment.ts`; `admin task-assign`.
- **Docs:** [assignment-profiles.md](assignment-profiles.md).
- **Gaps:** none known.
- **Related Issues:** #259, #260, #261, #262, #292

#### Per-Issue worktrees and locking

- **Status:** `available`
- **Capability:** every phase that touches the working tree runs inside a
  dedicated git worktree for that Issue, exclusively locked for the
  duration.
- **Configuration:** none; worktree-only operation is unconditional across
  all repo-working phases.
- **Evidence:** `src/handlers/worktree.ts` (`IssueWorktreeLock`),
  `src/handlers/worktree-context.ts`; `admin worktree list|prune|recovery|
  cleanup|release-lock|discard`.
- **Docs:** [per-issue-worktrees.md](per-issue-worktrees.md),
  [worktree-only-migration-contract.md](worktree-only-migration-contract.md),
  [worktree-rollout.md](worktree-rollout.md).
- **Gaps:** none known.
- **Related Issues:** #400, #731

### Human and planning workflow

#### Human gate (Go/No-go) and human review return

- **Status:** `available`
- **Capability:** phases that need a human decision post a Go/No-go
  checklist comment; a human's review return re-activates the task.
- **Configuration:** none; on by default at the relevant phase boundaries.
- **Evidence:** `src/core/human-gate-summary.ts`; `admin human-review-return`,
  `admin github-app-review-return`.
- **Docs:** [human-gate-no-go-flow.md](human-gate-no-go-flow.md),
  [human-review-return-flow.md](human-review-return-flow.md).
- **Gaps:** none known.
- **Related Issues:** #552

#### Issue planning and AI preview

- **Status:** `available`
- **Capability:** preview and evaluate an implementation plan for an Issue
  before activation, including an AI-generated preview and a backtest
  evaluation against historical outcomes.
- **Configuration:** none required to preview.
- **Evidence:** `src/cli/issue-plan.ts`, `src/cli/issue-plan-ai.ts`,
  `src/cli/issue-plan-history.ts`; `admin issue-plan preview|ai-preview|
  evaluate-history`.
- **Docs:** [ai-planner-gate-architecture.md](ai-planner-gate-architecture.md),
  [issue-planning-gate-contract.md](issue-planning-gate-contract.md),
  [issue-plan-backtest.md](issue-plan-backtest.md).
- **Gaps:** none known.

#### Issue refinement

- **Status:** `config-gated`
- **Capability:** chain-aware progressive rewriting of a dormant dependent
  Issue's body once its blocker reaches a stack-ready result, then automatic
  handover into ordinary implementation.
- **Configuration:** `session.issueRefinement.enabled`, default `false`.
- **Evidence:** `src/core/issue-refinement.ts`,
  `src/handlers/issue-refinement-apply.ts`, `src/cli/issue-refinement-loop.ts`;
  `admin refinement run`.
- **Docs:** [issue-refinement-contract.md](issue-refinement-contract.md)
  (status line corrected alongside this matrix — it previously read "not yet
  implemented"), [idea-to-implementation.md](idea-to-implementation.md).
- **Gaps:** subject to the publication and config boundaries the contract
  describes; a session that has not opted in treats
  `status:needs-refinement` as an inert label.
- **Related Issues:** #866, #867, #868, #869, #870, #871

### Tool Request and verification

#### Tool Request grant (single-use) and guided continuation

- **Status:** `available`
- **Capability:** an operator can authorize one previously-blocked command
  for a task with a single-use grant; the orchestrator runs it on the
  operator's behalf, captures the result, and takes an explicit disposition
  for any changes it produced. The existing automated execution path
  consumes the resolution on the next retry, so the continuation behavior is
  wired end to end.
- **Configuration:** none; operator-invoked per task.
- **Evidence:** `src/core/tool-request-grant.ts`; `admin tool-request run`
  (the current operator surface — issue #430's redesigned successor).
  `admin tool-request grant` still exists but is a deprecated alias for
  `tool-request run` (`src/cli/admin.ts`, `tool-request grant` command
  description).
- **Docs:** [guided-tool-request-flow.md](guided-tool-request-flow.md),
  [tool-request-and-dependency-sync.md](tool-request-and-dependency-sync.md),
  [tool-request-redesign.md](tool-request-redesign.md) (§9a records that
  issue #430 already implements the core operator-experience track described
  here — the document's own top-of-file "specification" status line predates
  that and covers only the still-unimplemented follow-up items in §9).
- **Gaps:** this is the single-grant primitive only. There is no typed
  tiering and no automatic/unattended granting — see the next two rows.
- **Related Issues:** #419, #428, #430, #445, #454, #458, #472

#### Tool Request grant tiers (typed policy)

- **Status:** `design-only`
- **Capability:** not shipped. The design specifies typed operation tiers
  (blocked/relaxed/pre-approved) to replace today's single ad hoc grant.
- **Configuration:** n/a — no runtime behavior yet.
- **Evidence:** none; `grep -r "GrantTier" src/` has no matches.
- **Docs:** [tool-request-grant-tiers-contract.md](tool-request-grant-tiers-contract.md)
  ("Nothing in this document is implemented").
- **Gaps:** entire tiered policy is unimplemented.
- **Related Issues:** #697

#### Unattended Tool Request operation

- **Status:** `design-only`
- **Capability:** not shipped. The design specifies auto-executing
  pre-approved commands without a human grant.
- **Configuration:** n/a — no runtime behavior yet.
- **Evidence:** none in `src/`.
- **Docs:** [unattended-tool-request-contract.md](unattended-tool-request-contract.md)
  ("adds no runtime behavior").
- **Gaps:** the full 25-slice decomposition is unstarted.
- **Related Issues:** #919

#### Verification (per-phase, inline repair)

- **Status:** `available`
- **Capability:** implementation-phase verification commands run before
  commit/push; a failure blocks the commit/push (reported as a failed run,
  with a dirty-continuation patch captured for the next attempt), after one
  bounded automatic inline repair attempt.
- **Configuration:** verification commands are configured per session/task;
  behavior is on by default once a command is configured.
- **Evidence:** `src/handlers/verification.ts` (command execution),
  `src/handlers/implementation.ts` (verification gating and the bounded
  `MAX_VERIFICATION_REPAIR_ATTEMPTS` repair loop).
- **Docs:** none dedicated — do not confuse with the *unified* engine below.
- **Gaps:** today's verification is per-phase and handler-invoked, blocking
  to a plain `failed` result — not the classify-and-cap `needs_fix` requeue
  designed under issue #934. That work exists on branch `ai/issue-934` but is
  not yet merged into this repository; `needs_fix` transitions currently
  exist only for the `review` and `content_review` phases
  (`src/core/transitions.ts`).
- **Related Issues:** #934

#### Unified verification execution engine (runner-owned)

- **Status:** `design-only`
- **Capability:** not shipped. The design specifies runner-owned
  verification cycles independent of any single phase handler.
- **Configuration:** n/a — no runtime behavior yet.
- **Evidence:** none in `src/`.
- **Docs:** [verification-execution-contract.md](verification-execution-contract.md)
  ("adds no runtime behavior").
- **Gaps:** fully unimplemented.
- **Related Issues:** #918

#### Research evidence

- **Status:** `config-gated`
- **Capability:** a bounded read/list/search evidence resolver for the
  research phase, driven by an in-turn stdout-marker request/response
  protocol.
- **Configuration:** `session.research.evidence.enabled`, default `false`.
  Enabling this flag alone only turns on evidence lookups — it does **not**
  enable research publication; see the next row for that independent gate.
- **Evidence:** `src/core/research-evidence-protocol.ts`.
- **Docs:** [research-evidence-contract.md](research-evidence-contract.md)
  (status line corrected alongside this matrix — it previously read "not yet
  implemented" although issue #806 had already shipped it).
- **Gaps:** a session that has not opted in sees no behavior change.
- **Related Issues:** #805, #806

#### Research publication

- **Status:** `config-gated`
- **Capability:** a closed-schema stdout envelope for publishing research
  results, with a sanitizing `sanitized_summary` mode as an alternative to
  keeping results local.
- **Configuration:** two independent gates, both required for a report to
  actually publish: `session.research.publication.mode` (`local_only` by
  default — no publication regardless of other settings — or
  `sanitized_summary`), and `session.research.publication.allowUntrustedInputs`
  (default `false`; publication is refused with `untrusted-provenance` until
  this is explicitly set `true`, since research runs are always treated as
  untrusted provenance). Setting only `session.research.evidence.enabled`
  does not affect this gate.
- **Evidence:** `src/core/research-publication.ts` (`resolvePublicationPolicy`,
  `publicationWithholdReason`).
- **Docs:** [research-publication-contract.md](research-publication-contract.md).
- **Gaps:** a session that has not opted in to both `sanitized_summary` mode
  and `allowUntrustedInputs` publishes nothing.
- **Related Issues:** #834

### Review governance

#### Review dispute

- **Status:** `foundation-only`
- **Capability:** a fix author can dispute a review finding; reconsideration
  and arbitration components exist to resolve the disagreement instead of
  silently overriding or silently accepting it, but no supported end-to-end
  path drives a dispute from open to resolution today.
- **Configuration:** `session.reviewDispute.enabled`, default `false`. Even
  when enabled, this does not make the feature end-to-end usable — see Gaps.
- **Evidence:** `src/handlers/review-reconsideration.ts`,
  `src/handlers/review-arbitration.ts`, `src/core/review-dispute-*.ts`;
  `admin dispute status|reopen|metrics`. `src/cli/run-one-phase.ts` registers only the
  normal `review` phase handler — it does not dispatch the reviewer,
  evidence, or runner dispute turns below.
- **Docs:** [review-dispute-contract.md](review-dispute-contract.md) (status
  line corrected alongside this matrix — it previously read "not yet
  implemented" despite the implementation note already below it),
  [review-dispute-operations.md](review-dispute-operations.md).
- **Gaps:** three turns of §7.1 — **reviewer**, **evidence**, and **runner** —
  still have no dispatcher (contract §15/G2), so an operator cannot drive a
  dispute through reconsideration/arbitration to resolution end to end.
- **Related Issues:** #835, #836, #837, #838, #839, #840, #841, #843, #844,
  #845, #846, #847, #848, #849

### ChatOps

#### ChatOps (comment recognition, cursor, ledger, mapping, dispatch port)

- **Status:** `foundation-only`
- **Capability:** comment recognition, provider identity, a durable
  discovery cursor, an execution ledger, operation mapping, and a callable
  dispatch port each exist as independent, tested building blocks. **No
  supported end-to-end path scans GitHub comments, dispatches a recognized
  command, and publishes a result** — there is no CLI entrypoint or
  scheduled job that calls these components together
  (`grep -r chatops src/cli` is empty).
- **Configuration:** n/a — nothing runs automatically.
- **Evidence:** `src/core/chatops-command.ts`,
  `src/core/chatops-comment-cursor.ts`,
  `src/core/chatops-execution-ledger.ts`, `src/core/chatops-identity.ts`,
  `src/core/chatops-operation-dispatch.ts`,
  `src/core/chatops-operation-mapping.ts`, `src/core/operation-port.ts`.
- **Docs:** [chatops-command-grammar-contract.md](chatops-command-grammar-contract.md),
  [chatops-comment-cursor-contract.md](chatops-comment-cursor-contract.md),
  [chatops-execution-ledger-contract.md](chatops-execution-ledger-contract.md),
  [chatops-identity-contract.md](chatops-identity-contract.md),
  [chatops-operation-mapping-contract.md](chatops-operation-mapping-contract.md),
  [chatops-result-contract.md](chatops-result-contract.md),
  [operation-dispatch-port-contract.md](operation-dispatch-port-contract.md).
  Each of those component contracts now points back to this row so its own
  layer-scoped "implemented" status is not read as end-to-end availability.
- **Gaps:** comment ingestion, dispatch invocation, and result publication
  (`chatops-result-contract.md`, itself `design-only`) are not connected.
  This row does not move to `available` or `config-gated` until an
  end-to-end scan → dispatch → publish path is wired and CLI/job-observable.
- **Related Issues:** #696, #777, #778, #779, #780, #781, #782, #783, #784,
  #785

### Providers

#### GitHub and GitHub App provider — default `gh` CLI auth

- **Status:** `available`
- **Capability:** primary supported repo-host and work-item provider,
  authenticated via the operator's already-authenticated `gh` CLI session.
- **Configuration:** default provider and default auth mode
  (`repoHostProvider.auth.mode: "gh"`); no flag required.
- **Evidence:** `src/providers/github/gh-repo-host-provider.ts`,
  `src/providers/github/gh-work-item-provider.ts`.
- **Docs:** [provider-architecture.md](provider-architecture.md).
- **Gaps:** none known.

#### GitHub App auth mode

- **Status:** `config-gated`
- **Capability:** authenticates as a GitHub App installation instead of the
  operator's `gh` CLI session (e.g. for unattended/service deployments).
- **Configuration:** requires `repoHostProvider.auth.mode: "github-app"` plus
  the App credential environment settings (`appIdEnv`, `installationIdEnv`,
  `privateKeyPathEnv`); the sibling `*Key`/keychain form is reserved but not
  yet wired to a runtime resolver. Not the default — the default GitHub path
  above uses `gh` auth with no configuration.
- **Evidence:** `src/providers/github/github-app-auth.ts`,
  `src/core/session.ts` (`GitHubAppAuthConfig`).
- **Docs:** [provider-architecture.md](provider-architecture.md).
- **Gaps:** `*Key`/keychain credential references are accepted in the type but
  rejected by the session validator at runtime; only `*Env` works today.

#### Gitea provider

- **Status:** `config-gated`
- **Capability:** repo-host and work-item provider implementations exist and
  are consumed by outbox dispatch when a session selects Gitea. **This is
  not a complete GitHub replacement.**
- **Configuration:** session provider selection; GitHub remains the default.
- **Evidence:** `src/providers/gitea/gitea-repo-host-provider.ts`,
  `src/providers/gitea/gitea-work-item-provider.ts`,
  `src/providers/gitea/gitea-client.ts`.
- **Docs:** [gitea-private-work-items.md](gitea-private-work-items.md) ("a
  design specification only" for the parts still unimplemented),
  [github-to-gitea-import.md](github-to-gitea-import.md) ("stops at
  design"), [provider-architecture.md](provider-architecture.md).
- **Gaps:** GitHub → Gitea Issue import/mirroring is `design-only`;
  documented dependency and repo-host parity gaps remain (see
  `github-to-gitea-import.md`). Do not present Gitea support as parity with
  the GitHub provider.

### Data lifecycle

#### Outbox, cursor, retry, and dead-letter operations

- **Status:** `available`
- **Capability:** durable outbound-effect queue with a scan cursor, retry,
  cancellation, and maintenance locking.
- **Configuration:** none; on by default.
- **Evidence:** `src/core/outbox.ts`, `src/core/outbox-scan-cursor.ts`,
  `src/core/outbox-visibility.ts`, `src/core/outbox-effects.ts`; `admin
  outbox list|retry|cancel`, `admin maintenance-lock status|release`.
- **Docs:** [outbox-scan-cursor-contract.md](outbox-scan-cursor-contract.md).
- **Gaps:** none known.
- **Related Issues:** #818, #819, #820

#### Retention, backup, restore, and pruning

- **Status:** `available`
- **Capability:** SQLite online backup/restore and retention-bucket pruning
  for `tasks`/`events`.
- **Configuration:** operator-invoked (`admin archive rollup`, the `restore`
  action, the `prune` action); no automatic scheduling.
- **Evidence:** `src/core/retention.ts`, `src/stores/sqlite-backup-store.ts`.
- **Docs:** [retention-backup-contract.md](retention-backup-contract.md) —
  note: that document's own header still reads "specification only ...
  contains no implementation"; this row reflects the current source, which
  has moved past that header (issue #611 shipped the backup/retention split
  it describes). Treat this matrix row, not that header, as current.
- **Gaps:** retention is deliberately scoped to `tasks`/`events` only —
  outbox and context-record retention are excluded per the contract's own
  fail-closed posture (§12).
- **Related Issues:** #610, #611

### Admin and operations

#### Admin UI and recovery commands

- **Status:** `available`
- **Capability:** operator CLI surface for locks, worktrees, recovery,
  sessions, and diagnostics.
- **Configuration:** none; operator-invoked.
- **Evidence:** `src/cli/admin.ts`, `src/cli/admin-ui.ts`; subcommands
  including `repo-lock`, `worktree`, `review-lock`, `maintenance-lock`,
  `recover`, `recover-cap-handoff`, `list-stuck`, `session pause|resume|
  status`, `session-doctor`.
- **Docs:** [admin-cli-contract.md](admin-cli-contract.md),
  [admin-cli-parsing-contract.md](admin-cli-parsing-contract.md),
  [admin-command-registry-contract.md](admin-command-registry-contract.md).
- **Gaps:** `admin.ts` itself is oversized and tracked for extraction
  (issue #692) — a maintainability note, not a capability gap.
- **Related Issues:** #692

#### Metrics and intervention-rate reporting

- **Status:** `available`
- **Capability:** aggregates L3 human-intervention signal counts (human
  review-return plus tool-request resolution) per Issue/session, alongside a
  generated repo-health metrics snapshot.
- **Configuration:** none; operator-invoked.
- **Evidence:** `src/core/l3-intervention-aggregation.ts`,
  `src/core/intervention-taxonomy.ts`, `src/core/github-intervention-scan.ts`;
  `admin interventions`.
- **Docs:** [metrics/latest.md](metrics/latest.md) (generated).
- **Gaps:** none known.
- **Related Issues:** #588

### Distribution and export

#### Copybara private-to-public export

- **Status:** `foundation-only`
- **Capability:** SQUASH-export tooling exists and is tested, but it is a
  prototype: it runs only against local temporary git repositories and never
  talks to the real public mirror.
- **Configuration:** `npm run copybara:export` / `copybara:validate`;
  operator-invoked, not scheduled.
- **Evidence:** `scripts/copybara-export.mjs`, `scripts/copybara-validate.mjs`,
  `scripts/copybara-jar-cache.mjs`, `copybara/` config.
- **Docs:** [copybara-export-poc.md](copybara-export-poc.md) ("prototype"),
  [copybara-public-export.md](copybara-public-export.md) (successor design).
- **Gaps:** does not yet export to the real public repository; do not
  describe this as a supported publish path.
- **Related Issues:** #767

#### Private n8n node distribution

- **Status:** `available`
- **Capability:** a private n8n community node package, covering Create
  Context and related operations through its third implementation slice.
- **Configuration:** none to use the shipped slice; later slices are
  intentionally parked under `status:backlog`.
- **Evidence:** `n8n-node/` package.
- **Docs:** [private-node-distribution.md](private-node-distribution.md).
- **Gaps:** governance rule blocks starting slice N+1 before slice N ships;
  later slices remain unimplemented.

### Platform and execution

#### Execution backend, platform sandbox, and preflight execution plan

- **Status:** `design-only`
- **Capability:** not shipped. The design specifies a typed
  local/native-sandbox/container execution backend, a platform/sandbox
  contract, and a fingerprint-bound preflight plan gating what commands may
  run.
- **Configuration:** n/a — no runtime behavior yet.
- **Evidence:** none; `grep -r "SingleHost\|PlatformSandbox\|
  PreflightExecutionPlan\|ExecutionBackend" src/` has no matches.
- **Docs:** [single-host-execution-backend-contract.md](single-host-execution-backend-contract.md),
  [single-host-platform-sandbox-contract.md](single-host-platform-sandbox-contract.md),
  [preflight-execution-plan-contract.md](preflight-execution-plan-contract.md).
- **Gaps:** the entire chain is unimplemented (#915 → #916 → #917 → #918 →
  #919 → #722); only doc-structural tests exist today.
- **Related Issues:** #915, #916, #917, #918, #919, #722

### Agent and editor integrations

#### Antigravity workspace integration

- **Status:** `config-gated`
- **Capability:** writes a read-only Antigravity workspace settings profile.
- **Configuration:** `session.research.antigravity.workspaceSettings.enabled`
  (default `false`); the research phase writes nothing into the workspace
  until it is set to `true`.
- **Evidence:** `src/handlers/antigravity-workspace.ts`,
  `src/core/antigravity-workspace-settings.ts`.
- **Docs:** [antigravity-workspace-settings.md](antigravity-workspace-settings.md)
  ("implemented, disabled by default").
- **Gaps:** requires Antigravity `>=1.1.9 <2.0.0`; workspace `.gemini` rules
  are ignored by the real `agy` binary (grants go through the global store
  instead) — see issue #830.
- **Related Issues:** #826, #830

#### Codex context-mode

- **Status:** `config-gated`
- **Capability:** resolves Codex model/context-mode selection per
  session/provider; operator-observable via `admin context-mode status`.
- **Configuration:** `codex.contextMode.enabled` is a required master
  switch — when it is absent or `false`, the Codex argv is unchanged.
  Operators enable it via `session.codex.contextMode.enabled` (with
  `config`/`profile`) or `CODEX_CONTEXT_MODE=on`; disabled by default.
- **Evidence:** `src/handlers/codex-context-mode.ts`,
  `src/cli/context-mode-status.ts`.
- **Docs:** [codex-context-mode.md](codex-context-mode.md).
- **Gaps:** none known.
- **Related Issues:** #609

## 5. Maintenance rule

**Any Issue or PR that changes what a feature can do, how it is gated, or
whether it is wired into a supported runtime path MUST update the relevant
row in this file in the same change.** This includes: shipping a
`design-only` or `foundation-only` feature past its current boundary,
flipping a `config-gated` default, wiring a new end-to-end path (as ChatOps
would need to move off `foundation-only`), or deprecating a shipped path.
Reviewers should treat a missing matrix update as a review finding, the same
way a missing test would be.

A closed design Issue, by itself, is never sufficient justification for
marking a row `available` — see §2. If a change only advances a design
document without shipping runtime behavior, this file does not change.

## 6. Excluded documents

Documents with an explicit `Status:` declaration that are intentionally not
represented as their own matrix row, with the reason:

- [DOMAIN.md](DOMAIN.md) — an architecture/glossary meta-document tracking
  structural decomposition work (admin CLI, handlers, outbox extraction
  boundaries), not a feature-availability declaration about a single
  operator-facing capability.
- [agent-isolation-policy.md](agent-isolation-policy.md) — a cross-cutting
  implementation invariant (the environment every isolated no-tool agent run
  gets) rather than an operator-facing capability. The features it backs —
  Issue refinement, Review dispute, and the AI planner — carry their own rows
  above, and their availability is what an operator acts on.
