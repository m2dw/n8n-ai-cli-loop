import type { AgentId } from "./task.js";

export interface SessionDefaults {
  implementationAgent: AgentId;
  reviewAgent: AgentId;
  researchAgent?: AgentId;
}

export type VerificationCommands = Record<string, string>;

export interface SessionLabels {
  active: string;
  blocked: string;
  readyForHuman: string;
  [name: string]: string;
}

export interface ReviewLoopConfig {
  /** Maximum number of needs_fix cycles before escalating to human. Default: 3. */
  maxCycles?: number;
}

/**
 * Per-lineage protocol limits (§6.1 of docs/review-dispute-contract.md).
 *
 * Session config may only LOWER these; the contract maxima are the defaults.
 * Four of them additionally reject 0 at session load, because at 0 the protocol
 * would have a state with no next action — see `REVIEW_DISPUTE_LIMIT_SPECS` in
 * core/review-dispute.ts, which owns the normative table and the validation.
 */
export interface ReviewDisputeLimitsConfig {
  /** `MAX_REBUTTALS_PER_VERSION`. Default 1; must not be lowered. */
  maxRebuttalsPerVersion?: number;
  /** `MAX_VERSIONS_PER_LINEAGE`. Default 2; must not be lowered below 1. */
  maxVersionsPerLineage?: number;
  /** `MAX_RECONSIDERATIONS_PER_LINEAGE`. Default 1; 0 skips the round (row 25). */
  maxReconsiderationsPerLineage?: number;
  /** `MAX_ARBITRATION_PASSES_PER_LINEAGE`. Default 2; must not be lowered below 1. */
  maxArbitrationPassesPerLineage?: number;
  /** `MAX_MALFORMED_ARBITER_ATTEMPTS_PER_LINEAGE`. Default 2; must not be lowered below 1. */
  maxMalformedArbiterAttemptsPerLineage?: number;
  /** `MAX_EVIDENCE_ROUNDS_PER_LINEAGE`. Default 1; 0 makes the round unavailable (row 17). */
  maxEvidenceRoundsPerLineage?: number;
}

/** Arbiter selection policy (§8.3). Selection itself is issue #839/#846. */
export interface ReviewDisputeArbiterConfig {
  /** Ordered candidate agent ids; the runner takes the first cross-provider one. */
  providers?: string[];
  /** A same-provider (never same-model) candidate is allowed only by explicit opt-in. */
  allowSameProvider?: boolean;
  /** Confidence threshold for the decisive verdicts of rows 13–14 and 18. Default 0.7. */
  minConfidence?: number;
}

/**
 * Review dispute, reconsideration, and arbitration protocol
 * (docs/review-dispute-contract.md). Off by default: with `enabled` absent or
 * false, review and fix behave byte-identically to today — free-form feedback,
 * no lineages, no dispositions, and a no-change fix run fails (§13).
 */
export interface ReviewDisputeConfig {
  /** Master switch. Default false. */
  enabled?: boolean;
  /** Per-lineage limits; may only be lowered (§6.1). */
  limits?: ReviewDisputeLimitsConfig;
  /** Arbiter selection policy (§8.3). */
  arbiter?: ReviewDisputeArbiterConfig;
}

// ---------------------------------------------------------------------------
// Chain-aware progressive Issue refinement (issue #866/#867,
// docs/issue-refinement-contract.md §19)
//
// Off by default: with `enabled` absent or false, `status:needs-refinement` is
// an inert label — intake ignores it, no refinement task is created, and an
// Issue carrying it alongside an executable status is routed exactly as it is
// today. Enabling the lane changes behavior only for Issues carrying the marker.
// ---------------------------------------------------------------------------

/**
 * §8 limits. Session config may only LOWER these; the contract maxima are the
 * defaults. Six of them additionally reject 0 at session load, because at 0 the
 * lane would have a state with no next action — see
 * `ISSUE_REFINEMENT_LIMIT_SPECS` in core/issue-refinement.ts, which owns the
 * normative table and the validation.
 */
export interface IssueRefinementLimitsConfig {
  /** `MAX_PREDECESSORS_PER_REFINEMENT`. Default 4; must not be lowered below 1. */
  maxPredecessorsPerRefinement?: number;
  /** `MAX_REFINEMENT_ROUNDS_PER_ISSUE`. Default 2; must not be lowered below 1. */
  maxRefinementRoundsPerIssue?: number;
  /** `MAX_MALFORMED_ATTEMPTS_PER_ROLE`. Default 2; must not be lowered below 1. */
  maxMalformedAttemptsPerRole?: number;
  /** `MAX_AGENT_FAILURES_PER_ROLE`. Default 2; 0 escalates on the first process failure. */
  maxAgentFailuresPerRole?: number;
  /** `MAX_STALE_RESTARTS_PER_ISSUE`. Default 1; 0 makes the restart unavailable. */
  maxStaleRestartsPerIssue?: number;
  /** `MAX_COMMENTS_PER_PREDECESSOR`. Default 5; 0 captures no comment window. */
  maxCommentsPerPredecessor?: number;
  /** `MAX_SNAPSHOT_TEXT_BYTES`. Default 8000; must not be lowered below 1. */
  maxSnapshotTextBytes?: number;
  /** `MAX_CHANGED_PATHS_PER_PREDECESSOR`. Default 100; must not be lowered below 1. */
  maxChangedPathsPerPredecessor?: number;
  /** `MAX_MANAGED_REGION_BYTES`. Default 16000; must not be lowered below 1. */
  maxManagedRegionBytes?: number;
}

/**
 * §7.3/§14 role selection. `refiner`/`critic` are session-level FALLBACKS: the
 * flow's assignment profile (`refinement` / `refinement_critic`) is the source of
 * truth per §14 and wins whenever it names a role.
 */
export interface IssueRefinementAgentsConfig {
  /** Fallback agent id for the `refinementAgent` role. */
  refiner?: string;
  /** Fallback agent id for the `refinementCriticAgent` role. */
  critic?: string;
  /** §7.3: a same-provider (never same-model) critic is allowed only by explicit opt-in. */
  allowSameProvider?: boolean;
}

export interface IssueRefinementConfig {
  /** Master switch. Default false — the whole lane is off. */
  enabled?: boolean;
  /** §8 limits; may only be lowered. */
  limits?: IssueRefinementLimitsConfig;
  /** §7.3 refiner/critic selection policy. */
  agents?: IssueRefinementAgentsConfig;
}

export interface ConflictResolutionLoopConfig {
  /**
   * Maximum number of same-kind verification-failure attempts before escalating
   * to human. Defaults to 2 (first failure records; second escalates).
   */
  maxAttempts?: number;
  /**
   * Maximum number of review→conflict_resolution→review cycles before
   * escalating to human. Defaults to 2.
   */
  maxReviewCycles?: number;
}

// ---------------------------------------------------------------------------
// Per-issue worktrees (docs/per-issue-worktrees.md, issue #400)
//
// Every issue/work-item unconditionally runs in its own durable git worktree
// (keyed by session + issue); there is no shared-checkout execution mode
// (removed in issue #731 — see docs/worktree-only-migration-contract.md).
// ---------------------------------------------------------------------------

export interface WorktreeConfig {
  /**
   * Optional override for the managed worktree state root for this session. When
   * absent the runtime resolves it from the `N8N_AI_WORKTREE_ROOT` env var, then
   * the global default `~/.local/state/n8n-ai-cli-loop/worktrees`. Must be an
   * absolute path; it is never placed inside committed source.
   */
  root?: string;
}

// ---------------------------------------------------------------------------
// Dependency sync (docs/tool-request-and-dependency-sync.md §3)
//
// Handler-owned, session-configured regeneration of lockfiles / dependency
// metadata after the agent edits a manifest such as `package.json`. The
// mutating dependency command runs OUTSIDE the agent permission surface — it is
// never added to the Claude `allowedTools` set — so a manifest change that needs
// a lockfile update does not have to become a Tool Request handoff.
//
// Disabled unless a session opts in (`enabled: true`). The command is the exact,
// session-pinned string the handler may run; it is never derived from agent
// output, issue text, or any other untrusted source.
// ---------------------------------------------------------------------------

export interface DependencySyncConfig {
  /** Master switch. Defaults to off; when false no sync ever runs. */
  enabled: boolean;
  /** Manifest paths (repo-relative) whose change makes the sync eligible. */
  triggerPaths: string[];
  /** Files the command is expected to produce/update (e.g. package-lock.json). */
  expectedOutputs: string[];
  /**
   * The exact command string the handler may run. Not a pattern or prefix. In
   * the default safe mode it must be a lockfile-only, no-lifecycle-script form
   * (for npm, `npm install --package-lock-only --ignore-scripts`).
   */
  command: string;
  /**
   * Explicit acknowledgement that this sync may execute arbitrary lifecycle-script
   * code influenced by agent-edited manifest content. Defaults to off (false).
   */
  allowLifecycleScripts?: boolean;
  /** Bounded execution budget in milliseconds. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Environment prepare (docs/environment-prepare-contract.md, issue #510)
//
// Runner-owned, session-configured installation of the full runtime dependency
// tree (e.g. `npm ci` → node_modules) before a phase or verification runs.
// This is distinct from dependencySync, which only regenerates lockfiles.
//
// Disabled unless a session opts in (`enabled: true`). The command is the
// exact, session-pinned string the runner may execute; it is never derived from
// agent output, issue text, or repository auto-detection. See the contract
// document for stamp/caching rules and failure semantics.
// ---------------------------------------------------------------------------

export interface EnvironmentPrepareConfig {
  /** Master switch. Defaults to off; when false no environment preparation ever runs. */
  enabled: boolean;
  /** The exact command string the runner may execute. Not a pattern or prefix. */
  command: string;
  /**
   * Repo-relative paths whose content hash contributes to the prepare stamp.
   * A change to any listed file invalidates the stamp and triggers a fresh run.
   */
  cacheKeyFiles?: string[];
  /**
   * Explicit acknowledgement that this prepare command may execute arbitrary
   * lifecycle-script code (e.g. `npm ci` runs `postinstall` scripts defined in
   * dependencies). Defaults to off (false). In safe mode the runner should prefer
   * commands that skip lifecycle scripts (e.g. `--ignore-scripts`). Set to `true`
   * only when the operator has reviewed and accepted the lifecycle-script risk for
   * the configured command.
   */
  allowLifecycleScripts?: boolean;
  /** Bounded execution budget in milliseconds. Defaults to 120000 (2 minutes). */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Codex runtime capabilities (docs/codex-context-mode.md)
//
// Codex-specific runtime knobs that apply only when an agent invocation runs the
// `codex` CLI (implementation `codex exec`, review `codex review`). They never
// affect Claude or Gemini/Antigravity runs.
//
// context-mode is delivered as operator-supplied, verified Codex invocation
// state rather than a key this workflow guesses: the `config`/`profile` form a
// session declares is passed verbatim to `codex exec`/`codex review`, so a
// Codex CLI/plugin change cannot silently send an unverified config key. When
// `enabled` is false/absent the Codex argv is unchanged.
// ---------------------------------------------------------------------------

export interface CodexContextModeConfig {
  /**
   * Master switch. When false/absent the Codex command argv is unchanged and the
   * resolved profile records context-mode as `unset`.
   */
  enabled: boolean;
  /**
   * Operator-verified Codex config overrides applied as `-c <entry>` to both
   * `codex exec` and `codex review` when enabled. Each entry is a literal
   * `key=value` string the operator has confirmed against their Codex build, so
   * the workflow never guesses the context-mode config key. At least one of
   * `config` or `profile` must be present when `enabled` is true.
   */
  config?: string[];
  /**
   * Optional Codex profile to select via `--profile <name>` when context-mode is
   * delivered through a Codex profile/plugin rather than plain `-c` overrides.
   */
  profile?: string;
}

export interface CodexConfig {
  /** Context-mode runtime capability for Codex agent invocations. */
  contextMode?: CodexContextModeConfig;
  /**
   * Optional explicit Codex model, passed as `--model <model>` (a global Codex
   * CLI option, spliced before the `exec`/`review` subcommand) to both the
   * implementation and review Codex invocations when set. When absent, the
   * Codex CLI's own config/authenticated default selects the model — the
   * documented compatibility mode for sessions that intentionally track the
   * CLI default; resolved profile metadata records this as `model:
   * "cli-default"` (issue #609). `CODEX_MODEL` overrides this when set.
   */
  model?: string;
}

// ---------------------------------------------------------------------------
// Claude complexity-profile overrides (issue #748)
//
// The built-in complexity-label -> Claude model/effort/budget mapping (see
// core/github-intake.ts labelsToComplexity) is intentionally kept out of
// source as a permanent hard-coded assumption: a session may override any
// field of any tier so a future Claude model rename or effort-policy change
// is a config edit, not a source rewrite.
// ---------------------------------------------------------------------------

/**
 * Overrides one or more of a complexity tier's model/effort/budget. Fields
 * left unset fall back to that tier's built-in default.
 */
export interface ClaudeComplexityProfileOverride {
  model?: string;
  effort?: string;
  budget?: string;
}

/** Per-tier overrides, keyed by the same tiers `labelsToComplexity` resolves. */
export interface ClaudeComplexityProfilesConfig {
  low?: ClaudeComplexityProfileOverride;
  default?: ClaudeComplexityProfileOverride;
  high?: ClaudeComplexityProfileOverride;
  xhigh?: ClaudeComplexityProfileOverride;
}

export interface ClaudeConfig {
  /**
   * Overrides the built-in complexity-label -> Claude model/effort/budget
   * mapping. Optional and a no-op when absent: a session without it uses the
   * built-in defaults (e.g. `complexity:xhigh` -> Fable 5 / xhigh / $20),
   * preserving today's behavior.
   */
  complexityProfiles?: ClaudeComplexityProfilesConfig;
}

// ---------------------------------------------------------------------------
// Research configuration (issue #493)
//
// Optional per-session model configuration for the Antigravity (Gemini/agy)
// research agent. When absent the default CLI model is used unchanged.
// ---------------------------------------------------------------------------

export interface AntigravityResearchConfig {
  /**
   * Antigravity model name passed as `--model <model>` to `agy` when set.
   * The effort suffix is part of the model display name (e.g. "Gemini 3.1 Pro (Low)").
   * When absent the CLI default model is used.
   */
  model?: string;
  /**
   * `--print-timeout` passed to `agy --print` (issue #861). A Go-duration
   * string such as `"15m"`, `"90s"`, or `"1h30m"`; validated and bounded by
   * `parseAntigravityPrintTimeout` (src/core/antigravity-print-timeout.ts).
   * When absent, `ANTIGRAVITY_PRINT_TIMEOUT_DEFAULT` ("15m") is used instead
   * of Antigravity's own five-minute CLI default, which is too short for
   * large but valid research tasks.
   */
  printTimeout?: string;
  /** Runner-owned workspace permission profile (issue #826). */
  workspaceSettings?: AntigravityWorkspaceSettingsSessionConfig;
}

/**
 * Bounded, runner-owned `<workspace_root>/.gemini/settings.json` generation for
 * headless research (issue #826, docs/antigravity-workspace-settings.md). Off by
 * default: with `enabled` absent or false the research phase writes nothing into
 * the workspace and behaves exactly as before.
 */
export interface AntigravityWorkspaceSettingsSessionConfig {
  /** Master switch for the workspace-settings preparation step. Default false. */
  enabled?: boolean;
  /**
   * Register the EXACT research workspace in the Antigravity CLI trust store
   * when it is not already trusted. Default false — an untrusted workspace fails
   * closed instead. A parent-directory grant is never written either way.
   */
  registerTrust?: boolean;
  /**
   * Absolute path of the global Antigravity CLI settings file holding the trust
   * store. When absent the runtime resolves `ANTIGRAVITY_CLI_SETTINGS`, then the
   * user default `~/.gemini/antigravity-cli/settings.json`.
   *
   * It only moves where the *runner* writes: `agy` still reads its own store, so
   * a research run that launches the CLI is refused unless this resolves to that
   * same file (`global-settings-not-canonical`, issue #830).
   */
  globalSettingsPath?: string;
}

/**
 * Constrained read-only repository evidence for headless research (issue
 * #806, docs/research-evidence-contract.md). Off by default: with `enabled`
 * absent or false the research phase behaves exactly as before — one
 * invocation, no evidence sections, no new artifacts, no new outcomes.
 */
export interface ResearchEvidenceConfig {
  /** Master switch for the evidence turn loop. Default false. */
  enabled?: boolean;
  /**
   * Additive-only additions to the fixed deny floor (contract §4.7).
   * Configuration can tighten the floor, never loosen it.
   */
  denyGlobs?: string[];
  /** Globs for generated files excluded from bulk list/search results
   * (contract §4.6). Default empty. */
  generatedGlobs?: string[];
  /** May only LOWER the fixed MAX_EVIDENCE_TURNS ceiling (contract §13 S5). */
  maxTurns?: number;
}

/**
 * Research Publication policy (issue #834,
 * docs/research-publication-contract.md). Off by default: with `mode` absent or
 * `"local_only"` the research phase behaves exactly as before — no publication
 * prompt section, no publication artifact, and the existing fixed-status
 * comment on the originating Issue.
 *
 * `sanitized_summary` turns on the separately validated publication path: the
 * agent emits a closed-schema report envelope, the runner validates and
 * sanitizes it deterministically, and only that report is enqueued. It is not a
 * relaxation of the raw-output withholding conditions — raw agent stdout is
 * never published under either mode.
 */
export interface ResearchPublicationConfig {
  /** Publication mode. Default `"local_only"`; an unrecognized value resolves to it. */
  mode?: "local_only" | "sanitized_summary";
  /**
   * Size budget for the rendered public report. Clamped to the module's
   * floor/ceiling; when absent the contract default (12,000) applies.
   */
  maxChars?: number;
  /**
   * Explicit operator acknowledgment that a validated report may be published
   * even though every research run is untrusted by provenance: the run exists
   * because a GitHub Issue asked for it, and everything an Issue carries is
   * written by whoever can file or edit it. Setting this accepts that
   * deterministic validation and known-pattern redaction cannot guarantee the
   * removal of arbitrary or unknown secrets from AI-authored prose — a steered
   * agent can place one inside an otherwise well-formed field.
   *
   * Without it, `sanitized_summary` builds and sanitizes the report but keeps it
   * local, so this flag is what enables publication at all. Default `false`;
   * only a literal `true` enables it.
   */
  allowUntrustedInputs?: boolean;
}

export interface ResearchConfig {
  /** Antigravity-specific research model configuration. */
  antigravity?: AntigravityResearchConfig;
  /** Repository evidence configuration (issue #806). */
  evidence?: ResearchEvidenceConfig;
  /** Research Publication policy (issue #834). */
  publication?: ResearchPublicationConfig;
}

// ---------------------------------------------------------------------------
// Assignment profiles & flow rules (docs/assignment-profiles.md)
//
// Configurable per-phase agent assignment. A session may declare named flows
// (assignment profiles) plus the trusted flow rules that select a flow from
// trusted labels. The resolved assignment is computed once at intake /
// task-creation time and persisted into task context (see core/assignment.ts),
// so later edits to sessions.json never silently change an existing task's
// agents.
//
// All three fields are optional: a session that omits them preserves today's
// behavior — the built-in `code` flow (implementation: claude, review: codex,
// conflict_resolution: claude, research: existing behavior), derived from the
// session `defaults`.
// ---------------------------------------------------------------------------

/**
 * Maps each phase role to a concrete agent for a flow. `implementation` and
 * `review` are required; `conflict_resolution` and `research` are optional and
 * fall back to the session defaults when absent (so partial profiles are valid).
 */
export interface AssignmentProfile {
  implementation: AgentId;
  review: AgentId;
  conflict_resolution?: AgentId;
  research?: AgentId;
  /**
   * Chain-aware refinement roles (issue #866/#867,
   * docs/issue-refinement-contract.md §14). Optional: a profile that omits them
   * falls back to `issueRefinement.agents.refiner` / `.critic`, and a session
   * that configures neither has no refiner or critic — which the refinement task
   * records as `null` rather than defaulting to an agent nobody chose.
   *
   * These are never expressed as labels: §14 keeps the critic's independence
   * requirement (§7.3) enforced against the resolved profile.
   */
  refinement?: AgentId;
  refinement_critic?: AgentId;
}

/**
 * A trusted flow-selection rule. Either matches when ALL `labels` are present,
 * or is the single terminal `default: true` fallback. Rules are evaluated in
 * order; the first match wins.
 */
export interface FlowRule {
  /** Flow name to resolve; must have an entry in `assignmentProfiles`. */
  flow: string;
  /** Trusted labels; the rule matches when all are present. */
  labels?: string[];
  /** Marks the terminal fallback rule. Exactly one flow rule must set this. */
  default?: boolean;
}

// ---------------------------------------------------------------------------
// Provider configuration
//
// Selects the work-item tracker and repository host backing a session, plus the
// auth strategy each uses. The shape follows docs/provider-architecture.md.
//
// Only `github-issues` (work items) and `github` (repo host) over `gh`-CLI auth
// are implemented today; the other identifiers are recognized so future
// providers can be declared explicitly without a config-format change. No
// provider API beyond the current `gh` path is wired in by this config.
//
// `gitea-issues` additionally carries a documented non-secret connection shape
// (issue #362): a self-/co-hosted Gitea instance has no implicit base URL or
// `owner/name` derivable from `githubRepo`, so those are declared explicitly in
// a sibling `gitea` block. The runtime provider is still unimplemented; a
// session that selects it fails closed (never silently reads GitHub) because the
// validator requires `api-token` auth, which no GitHub `gh`/App runner accepts.
//
// Secrets are NEVER stored here: auth references credentials by indirection
// only — either an environment-variable name (`*Env`) or a credential
// key / keychain reference (`*Key`) that the auth strategy resolves at runtime.
// Each secret is referenced by exactly one of the two forms.
// `validateSession` rejects configs that inline raw key material.
// ---------------------------------------------------------------------------

/**
 * Recognized work-item tracker providers. Only `github-issues` has a wired
 * runtime backend today; `gitea-issues` has a documented config/auth shape
 * (issue #362) but no runtime provider yet; the rest are reserved identifiers.
 */
export type WorkItemProviderKind =
  | "github-issues"
  | "gitea-issues"
  | "jira"
  | "azure-devops"
  | "bitbucket";

/**
 * Recognized repository-host providers. `github` (over `gh`/`github-app`) is the
 * default backend; `gitea` has a wired runtime `RepoHostProvider` (issue #365)
 * reached over the Gitea REST API with `api-token` auth; the rest are reserved
 * identifiers.
 */
export type RepoHostProviderKind = "github" | "gitea" | "azure-devops" | "bitbucket";

/** Auth strategy for a provider. Secrets are referenced by indirection, never inlined. */
export type ProviderAuthMode = "gh" | "github-app" | "api-token";

/** `gh`-CLI auth: relies on the operator's already-authenticated `gh` session. Carries no secret. */
export interface GhAuthConfig {
  mode: "gh";
}

/**
 * GitHub App auth. Each credential is referenced by indirection via its `*Env`
 * (environment-variable name) form; the auth strategy resolves the value at
 * runtime. The sibling `*Key` (credential-key / keychain reference) form is
 * reserved but not yet wired to a runtime resolver, so the session validator
 * currently rejects it for `github-app` auth — use `*Env` until a resolver lands.
 */
export interface GitHubAppAuthConfig {
  mode: "github-app";
  /** Env var name holding the GitHub App id. */
  appIdEnv?: string;
  /** Credential-key / keychain reference holding the GitHub App id (not yet supported). */
  appIdKey?: string;
  /** Env var name holding the installation id. */
  installationIdEnv?: string;
  /** Credential-key / keychain reference holding the installation id (not yet supported). */
  installationIdKey?: string;
  /** Env var name holding the path to the App private key (`.pem`). */
  privateKeyPathEnv?: string;
  /** Credential-key / keychain reference holding the App private key path (not yet supported). */
  privateKeyPathKey?: string;
}

/**
 * API-token auth (e.g. Jira). Token and optional account email are referenced by
 * indirection: exactly one of the `*Env` or `*Key` form per secret.
 */
export interface ApiTokenAuthConfig {
  mode: "api-token";
  /** Env var name holding the API token. */
  tokenEnv?: string;
  /** Credential-key / keychain reference holding the API token. */
  tokenKey?: string;
  /** Env var name holding the account email/username, when the provider needs one. */
  emailEnv?: string;
  /** Credential-key / keychain reference holding the account email/username. */
  emailKey?: string;
}

export type ProviderAuthConfig = GhAuthConfig | GitHubAppAuthConfig | ApiTokenAuthConfig;

/**
 * Label/status mapping strategy for a Gitea work-item provider. Selects how the
 * provider-neutral coarse workflow state maps onto a Gitea instance. Only
 * `labels` (state as a Gitea label add/remove, mirroring the GitHub provider) is
 * recognized today; the field exists so a future native-status strategy can be
 * declared without a config-format change.
 */
export type GiteaLabelMappingStrategy = "labels";

/**
 * Non-secret connection settings for a Gitea (`gitea-issues`) work-item
 * provider. Gitea is self-/co-hosted, so — unlike GitHub — it has no implicit
 * base URL or `owner/name` derivable from `githubRepo`: the instance location
 * and target repository are declared explicitly here. This block carries NO
 * secret material; the API token is referenced by indirection through the
 * sibling `auth` block (`api-token`). Only the `tokenEnv` form is wired for Gitea
 * today; `validateSession` rejects `tokenKey` for `gitea-issues` (no production
 * credential-key resolver yet), and it rejects a `baseUrl` that embeds
 * credentials (`user:password@host`).
 */
export interface GiteaWorkItemConfig {
  /** Base URL of the Gitea instance, e.g. `https://gitea.example.com`. http(s) only, no embedded credentials. */
  baseUrl: string;
  /** Owning organization or user that holds the repository. */
  owner: string;
  /** Repository name within `owner`. */
  repo: string;
  /**
   * Optional API base path. Defaults to `/api/v1` when omitted, so an instance
   * mounted under a non-standard prefix or pinned to a specific API version can
   * be addressed without a code change. Must be an absolute path (`/…`).
   */
  apiPath?: string;
  /**
   * Optional label/status mapping strategy. Defaults to `labels`. See
   * {@link GiteaLabelMappingStrategy}.
   */
  labelMapping?: GiteaLabelMappingStrategy;
}

/** Work-item tracker selection for a session. */
export interface WorkItemProviderConfig {
  provider: WorkItemProviderKind;
  auth: ProviderAuthConfig;
  /**
   * Gitea connection settings. Required when `provider` is `gitea-issues` and
   * rejected for every other provider (GitHub derives its target from
   * `githubRepo`). Carries no secrets — see {@link GiteaWorkItemConfig}.
   */
  gitea?: GiteaWorkItemConfig;
}

/**
 * Non-secret connection settings for a Gitea (`gitea`) repository-host provider.
 *
 * This is the **repo-host** sibling of {@link GiteaWorkItemConfig}, and they are
 * deliberately separate: a Gitea repo host addresses pull requests on a *code*
 * repository, so it carries no work-item-only concern such as `labelMapping`.
 * The two may even point at different Gitea repositories (a private work-item
 * repo vs. the code repo), so the connection block is declared independently on
 * each provider rather than shared.
 *
 * Like the work-item block, Gitea is self-/co-hosted, so the instance location
 * and target repository have no implicit value derivable from `githubRepo` and
 * are declared explicitly here. This block carries NO secret material; the API
 * token is referenced by indirection through the sibling `auth` block
 * (`api-token` with `tokenEnv` / `tokenKey`). `validateSession` rejects a
 * `baseUrl` that embeds credentials (`user:password@host`).
 */
export interface GiteaRepoHostConfig {
  /** Base URL of the Gitea instance, e.g. `https://gitea.example.com`. http(s) only, no embedded credentials. */
  baseUrl: string;
  /** Owning organization or user that holds the code repository. */
  owner: string;
  /** Repository name within `owner`. */
  repo: string;
  /**
   * Optional API base path. Defaults to `/api/v1` when omitted, so an instance
   * mounted under a non-standard prefix or pinned to a specific API version can
   * be addressed without a code change. Must be an absolute path (`/…`).
   */
  apiPath?: string;
}

/** Repository-host selection for a session. */
export interface RepoHostProviderConfig {
  provider: RepoHostProviderKind;
  auth: ProviderAuthConfig;
  /**
   * Gitea connection settings. Required when `provider` is `gitea` and rejected
   * for every other provider (GitHub derives its target from `githubRepo`).
   * Carries no secrets — see {@link GiteaRepoHostConfig}.
   */
  gitea?: GiteaRepoHostConfig;
}

// ---------------------------------------------------------------------------
// Notification settings (issue #465)
//
// Opt-in notification providers that fire on specific task transitions. Only
// `ready_for_human` transitions are covered by this first iteration; additional
// triggers (failed, tool_request, quota backoff) can be added later without a
// config-format change.
//
// Secrets are NEVER stored here. The Slack webhook URL is referenced by the
// name of an environment variable (`webhookUrlEnv`), resolved at dispatch time.
// ---------------------------------------------------------------------------

export interface SlackNotificationsConfig {
  /** Master switch. When false/absent no Slack notifications are sent. */
  enabled: boolean;
  /**
   * Name of the environment variable that holds the Slack incoming webhook URL.
   * Never the URL itself — the URL is resolved from the env at dispatch time so no
   * secret is persisted in sessions.json or the SQLite outbox.
   */
  webhookUrlEnv: string;
}

export interface NotificationsConfig {
  /** Slack incoming webhook notification settings. Optional and disabled by default. */
  slack?: SlackNotificationsConfig;
}

// ---------------------------------------------------------------------------
// Report-only rollout mode (issue #532)
//
// L1/report-only rollout gate for newly onboarded sessions: intake still
// discovers and analyzes candidate issues, but the phases that mutate the
// repository (`implementation`, `conflict_resolution` — branch creation,
// commits, PR pushes, write-authority agent runs) are refused before any
// side effect runs, both at intake (the task is never enqueued) and, as a
// defense-in-depth backstop, at phase admission (a pre-existing or
// otherwise-enqueued task is blocked before the handler runs). See
// src/handlers/report-only-admission.ts.
//
// Disabled unless a session opts in (`enabled: true`). Toggling `enabled`
// back to `false` resumes normal automation without redefining the session.
// ---------------------------------------------------------------------------

export interface ReportOnlyConfig {
  /** Master switch. Defaults to off; when false the session runs normal automation. */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Loop design audit (issue #533)
//
// Operator-recorded dispositions for `admin session-audit` findings. The audit
// itself derives everything else from the rest of the session config plus
// read-only observations; this block exists only so a deliberate deviation
// ("this repository has nothing to verify", "work items are public on purpose")
// can be documented in the session rather than re-argued at every audit run.
//
// An acknowledged finding is still reported — with its original severity and
// the recorded reason — but no longer drags the overall verdict down.
// ---------------------------------------------------------------------------

export interface SessionAuditConfig {
  /**
   * Documented reasons for accepting an audit finding, keyed by the audit's
   * stable check id (e.g. `verification-commands`). The value is the rationale
   * shown next to the finding; it is never empty. An entry whose key matches no
   * check id suppresses nothing and is reported by the audit as a typo.
   */
  acknowledge?: Record<string, string>;
}

export interface SessionConfig {
  sessionId: string;
  /**
   * Optional compact numeric reference for the session, e.g. an n8n tag or
   * Config value like `2`. Must be a unique positive integer across all
   * sessions when present. Resolved to the canonical `sessionId` by the session
   * reference resolver; never used in place of `sessionId` for DB state,
   * context records, task rows, lock files, artifacts, or diagnostics.
   */
  sessionNo?: number;
  /**
   * Optional string aliases for the session, e.g. `["addon", "tar"]`. Each
   * alias must be unique across all sessions and must not collide with another
   * session's `sessionId` or `sessionNo`. Resolved to the canonical `sessionId`
   * by the session reference resolver.
   */
  aliases?: string[];
  repoKey: string;
  repoRoot: string;
  githubRepo: string;
  artifactDir: string;
  /** Branch to base new implementation branches on. Defaults to "main". */
  baseBranch?: string;
  defaults: SessionDefaults;
  verification: VerificationCommands;
  labels: SessionLabels;
  reviewLoop?: ReviewLoopConfig;
  /**
   * Review-dispute protocol (issue #835, docs/review-dispute-contract.md).
   * Optional and disabled by default; a session without it behaves exactly as
   * today. Limits that would leave the protocol unusable are rejected at
   * session load rather than clamped (§6.1).
   */
  reviewDispute?: ReviewDisputeConfig;
  /**
   * Chain-aware progressive Issue refinement (issue #866/#867,
   * docs/issue-refinement-contract.md). Optional and disabled by default; a
   * session without it treats `status:needs-refinement` as an inert label and
   * behaves exactly as today. Limits that would leave the lane unusable are
   * rejected at session load rather than clamped (§8).
   */
  issueRefinement?: IssueRefinementConfig;
  conflictResolutionLoop?: ConflictResolutionLoopConfig;
  /**
   * Per-issue worktree isolation (issue #400). Optional — only present to
   * carry a `root` override; every session runs every phase in its own
   * per-issue worktree unconditionally (issue #731,
   * docs/worktree-only-migration-contract.md).
   */
  worktrees?: WorktreeConfig;
  /**
   * Handler-owned dependency sync. Optional and disabled by default: a session
   * without it (or with `enabled: false`) never runs a dependency-sync command,
   * preserving today's behavior.
   */
  dependencySync?: DependencySyncConfig;
  /**
   * Runner-owned environment preparation (issue #510). Optional and disabled by
   * default: a session without it (or with `enabled: false`) uses the worktree
   * as-is without running a prepare command. See docs/environment-prepare-contract.md
   * for stamp/caching rules, timing, and failure semantics.
   */
  environmentPrepare?: EnvironmentPrepareConfig;
  /**
   * Codex-specific runtime capabilities (e.g. context-mode). Optional and a no-op
   * for non-Codex agents; a session without it preserves today's Codex behavior.
   */
  codex?: CodexConfig;
  /**
   * Claude-specific runtime configuration (e.g. complexity-profile
   * overrides). Optional and a no-op when absent: a session without it uses
   * the built-in complexity mapping, preserving today's behavior.
   */
  claude?: ClaudeConfig;
  /**
   * Research-phase agent configuration. Optional and a no-op when absent: a
   * session without it uses the CLI default model for the research agent,
   * preserving today's behavior.
   */
  research?: ResearchConfig;
  /**
   * Named assignment profiles keyed by flow name. Optional: when absent the
   * built-in `code` profile (derived from `defaults`) is used.
   */
  assignmentProfiles?: Record<string, AssignmentProfile>;
  /**
   * Ordered flow-selection rules. Optional: when absent every task resolves to
   * the `code` flow. Exactly one rule must be the `default: true` fallback.
   */
  flowRules?: FlowRule[];
  /**
   * Convenience name of the default flow; when present it must agree with the
   * `default: true` flow rule.
   */
  defaultFlow?: string;
  /**
   * Work-item tracker provider. Optional: a session without it defaults to
   * GitHub Issues over `gh`, preserving today's behavior.
   */
  workItemProvider?: WorkItemProviderConfig;
  /**
   * Repository-host provider. Optional: a session without it defaults to
   * GitHub over `gh`, preserving today's behavior.
   */
  repoHostProvider?: RepoHostProviderConfig;
  /**
   * Notification provider settings. Optional and a no-op when absent: a session
   * without this block sends no external notifications, preserving today's behavior.
   */
  notifications?: NotificationsConfig;
  /**
   * Report-only rollout mode (issue #532). Optional and disabled by default: a
   * session without it (or with `enabled: false`) runs normal automation. When
   * enabled, intake still finds and analyzes candidate issues, but the
   * `implementation` and `conflict_resolution` phases are refused before any
   * branch, commit, or PR is created — see {@link ReportOnlyConfig}.
   */
  reportOnly?: ReportOnlyConfig;
  /**
   * Loop-design audit dispositions (issue #533). Optional and a no-op when
   * absent; read only by `admin session-audit`, never by a phase handler.
   */
  audit?: SessionAuditConfig;
}

export interface ResolvedSession extends SessionConfig {
  artifactRoot: string;
  githubOwner: string;
  githubName: string;
  /** See {@link SessionConfig.worktrees}. */
  worktrees?: WorktreeConfig;
  /** Always resolved: defaults to GitHub Issues over `gh` when not configured. */
  workItemProvider: WorkItemProviderConfig;
  /** Always resolved: defaults to GitHub over `gh` when not configured. */
  repoHostProvider: RepoHostProviderConfig;
  /**
   * Whether the operator explicitly declared `repoHostProvider` in the raw
   * session config (vs. the registry-supplied default). Resolution erases the
   * raw optionality — `repoHostProvider` above is always populated — so this flag
   * preserves the one bit outbox dispatch needs: an explicit repo-host config
   * must route public PR comments under its own credentials even when it happens
   * to match the default `github`/`gh` shape, which a value-only comparison
   * cannot distinguish from omission.
   */
  repoHostProviderConfigured: boolean;
}

export interface SessionRegistry {
  getSessionById(sessionId: string): Promise<ResolvedSession | undefined>;
  getSessionByRepoKey(repoKey: string): Promise<ResolvedSession | undefined>;
  listSessions(): Promise<ResolvedSession[]>;
  /**
   * Resolve a user-facing session reference to the canonical `sessionId`. A
   * reference may be an exact `sessionId`, a numeric `sessionNo` (as a string),
   * or a string alias. Rejects unknown references with a clear error. Ambiguous
   * references are rejected at registry construction time, so resolution here is
   * always unambiguous.
   */
  resolveSessionRef(ref: string): Promise<string>;
}
