export type {
  AgentId,
  AiTask,
  ClaimNextTaskRequest,
  EnqueueTaskInput,
  StoreResult,
  TaskAttempts,
  TaskContext,
  TaskEvent,
  TaskExpected,
  TaskKey,
  TaskPatch,
  TaskPhase,
  TaskPriority,
  TaskStatus,
} from "./core/task.js";
export type {
  AssignmentProfile,
  DependencySyncConfig,
  FlowRule,
  ResolvedSession,
  SessionAuditConfig,
  SessionConfig,
  SessionDefaults,
  SessionLabels,
  SessionRegistry,
  VerificationCommands,
  WorkItemProviderConfig,
  WorkItemProviderKind,
  RepoHostProviderConfig,
  RepoHostProviderKind,
  ProviderAuthConfig,
  ProviderAuthMode,
  GhAuthConfig,
  GitHubAppAuthConfig,
  ApiTokenAuthConfig,
} from "./core/session.js";
export type {
  AuditCategory,
  AuditCheck,
  AuditSeverity,
  AuditStatus,
  AuditSummary,
  AuditVerdict,
  LabelLookup,
  RepoVisibility,
  SessionAuditFacts,
  SessionAuditPayload,
} from "./core/session-audit.js";
export {
  FIXED_WORK_ITEM_ROUTING_LABELS,
  buildSessionAudit,
  requiredWorkItemLabels,
} from "./core/session-audit.js";
export type { ResolvedAssignment, PhaseAgentKind } from "./core/assignment.js";
export {
  ASSIGNMENT_CONTEXT_KEY,
  DEFAULT_FLOW,
  agentForPhase,
  readResolvedAssignment,
  resolveAssignment,
} from "./core/assignment.js";
export type { TaskStore } from "./core/task-store.js";
export type { PhaseHandler, PhaseHandlerContext, PhaseHandlerResult, PhaseHandlers, PhaseRunOutcome, RunNextPhaseOptions, WorktreeContextResolution, PhaseLockHandle, PhaseLockAcquisition, PhaseAdmissionResult } from "./core/phase-runner.js";
export { runNextPhase } from "./core/phase-runner.js";
export type {
  SessionPauseState,
  SessionPauseRecord,
  SessionControlStore,
  RunLedgerEntry,
  RunLedgerEntryInput,
  RunLedgerOutcome,
  CircuitBreakerPolicy,
  CircuitBreakerDecision,
  CircuitBreakerRule,
  RecordRunEvaluation,
} from "./core/session-control.js";
export {
  resolveCircuitBreakerPolicy,
  evaluateCircuitBreaker,
  fetchCircuitBreakerWindows,
  countConsecutiveFailures,
  extractRunMetadata,
  recordRunAndEvaluate,
  isFailureOutcome,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_MAX_ISSUE_PHASE_FAILURES,
  CIRCUIT_BREAKER_EVAL_WINDOW,
  circuitBreakerEvalWindow,
} from "./core/session-control.js";
export { applyTaskPatch, isClaimExpired, isDelayed, isRunnable, leaseExpiry, nextPhaseAfter, priorityRank } from "./core/transitions.js";
export {
  classifyQuotaExhaustion,
  resolveQuotaRetryDelayMs,
  DEFAULT_QUOTA_RETRY_DELAY_MS,
  resolveTransientRetryDelayMs,
  DEFAULT_TRANSIENT_RETRY_DELAY_MS,
  resolveRetryDelayMsForCategory,
  resolveRetryDelayOverrideMsForCategory,
  describeFailureCategory,
} from "./core/quota-classifier.js";
export type { QuotaClassification } from "./core/quota-classifier.js";
export {
  classifyPermissionDenial,
  describeDeniedOperation,
  MAX_DENIAL_EVIDENCE_LINES,
  MAX_DENIAL_OPERATION_TOKENS,
  MAX_DENIAL_SIGNAL_CHARS,
} from "./core/permission-denial-classifier.js";
export type {
  DeniedOperationClass,
  DenialChannel,
  DenialEvidence,
  PermissionDenialClassification,
} from "./core/permission-denial-classifier.js";
export {
  extractAgentFailureDiagnostic,
  extractClaudeDiagnostic,
  extractCodexDiagnostic,
  extractGeminiDiagnostic,
  MAX_DIAGNOSTIC_TEXT_LENGTH,
} from "./core/agent-diagnostics.js";
export type {
  AgentFailureDiagnostic,
  AgentFailureKind,
  AgentDiagnosticSource,
  AgentCommandOutput,
  AgentDiagnosticOptions,
} from "./core/agent-diagnostics.js";
export {
  classifyIntervention,
  isCountableIntervention,
  isPlannedHumanAction,
  isCandidate,
  INTERVENTION_L1,
  INTERVENTION_L2,
  INTERVENTION_L3,
  INTERVENTION_CANDIDATE,
  INTERVENTION_NONE,
} from "./core/intervention-taxonomy.js";
export type {
  InterventionLevel,
  CountableInterventionLevel,
  InterventionSignalKind,
  InterventionClassification,
  ReviewFixLoopRecord,
} from "./core/intervention-taxonomy.js";
export {
  scanIssueComments,
  scanPrComments,
  scanPrReviews,
  scanPrCommits,
  scanIssue,
  scanSession,
  looksLikeGuidance,
} from "./core/github-intervention-scan.js";
export type {
  GhScanComment,
  GhScanCommit,
  GhPrOutcomeState,
  GhPrReviewState,
  GhScanReviewComment,
  GhScanReview,
  GhIssueScanInput,
  AutomationActorConfig,
  GhInterventionSignal,
  GhClosedUnmergedOutcome,
  GhScanResult,
  GhScanDateRange,
} from "./core/github-intervention-scan.js";
export {
  aggregateL3Interventions,
  L3_EVENT_TYPE_MAP,
  UNOBSERVABLE_L3_SIGNALS,
} from "./core/l3-intervention-aggregation.js";
export type {
  IssueL3Interventions,
  L3AggregationResult,
} from "./core/l3-intervention-aggregation.js";
export { DEFAULT_SESSIONS_PATH, JsonSessionRegistry, resolveSessionRef } from "./registries/json-session-registry.js";
export type {
  BlockedByEntry,
  DependencyChecker,
  DependencyDecision,
  GhIssue,
  IssueCandidate,
  IssueCandidateWithDecision,
} from "./core/github-intake.js";
export { labelsToPhase, parseCandidates } from "./core/github-intake.js";
export type {
  GhCommentPayload,
  GhLabelAddPayload,
  GhLabelRemovePayload,
  OutboxEntry,
  OutboxEnqueueInput,
  OutboxPayload,
  OutboxStore,
  OutboxTopic,
  OutboxDeliveryStatus,
} from "./core/outbox.js";
export { makeOutboxKey, categorizeOutboxEntry } from "./core/outbox.js";
export { parseToolRequest, redactCommand, toolRequestPromptSection, toolRequestResolutionPromptSection, normalizeToolRequestCommand, TOOL_REQUEST_OPEN, TOOL_REQUEST_CLOSE } from "./core/tool-request.js";
export type { ToolRequest, StoredToolRequest, ToolRequestResolution, ToolRequestNecessity, ToolRequestDisposition, ToolRequestCapturedResult } from "./core/tool-request.js";
export {
  normalizeCommand,
  hashCommand,
  createToolRequestGrant,
  grantStatus,
  grantMatches,
  GRANT_DEFAULT_MAX_USES,
  GRANT_DEFAULT_TTL_MS,
  GRANT_MAX_USES_CEILING,
  GRANT_MAX_TTL_MS,
} from "./core/tool-request-grant.js";
export type {
  ToolRequestGrant,
  ToolRequestGrantScope,
  GrantCandidate,
  GrantMatchResult,
  CreateGrantInput,
} from "./core/tool-request-grant.js";
export {
  parseRepoChangeAction,
  parsePorcelainStatus,
  isIgnoredPath,
  matchesExpected,
  classifyChangedFiles,
  planRepoChange,
  summarizeClassification,
} from "./core/tool-request-changes.js";
export type {
  RepoChangeAction,
  ChangedFile,
  ChangeClassification,
  RepoChangePlanInput,
  RepoChangePlan,
  RepoChangePlanRefusalCode,
} from "./core/tool-request-changes.js";
export { MemoryTaskStore } from "./stores/memory-task-store.js";
export { SqliteTaskStore } from "./stores/sqlite-task-store.js";
export { SqliteOutboxStore, DEFAULT_DB_PATH } from "./stores/sqlite-outbox-store.js";
export { SqliteContextStore } from "./stores/sqlite-context-store.js";
export { SqliteSessionControlStore } from "./stores/sqlite-session-control-store.js";
export { RepoLockStore, DEFAULT_LOCK_DIR } from "./stores/repo-lock-store.js";
export type { AcquireResult, ReleaseResult, InspectResult, ForceReleaseResult } from "./stores/repo-lock-store.js";
export type { WorktreeConfig } from "./core/session.js";
export {
  WORKTREE_ROOT_ENV,
  DEFAULT_WORKTREE_ROOT,
  resolveWorktreeRoot,
  issueWorktreeId,
  issueWorktreePath,
  sessionWorktreeDir,
  redactWorktreePaths,
} from "./core/worktree-paths.js";
export {
  parseWorktreeList,
  canonicalizePath,
  listWorktrees,
  findWorktreeByPath,
  resolveIssueWorktree,
  removeWorktree,
  IssueWorktreeLock,
  issueLockScope,
  DEFAULT_WORKTREE_LOCK_DIR,
} from "./handlers/worktree.js";
export type {
  WorktreeEntry,
  ResolveIssueWorktreeInput,
  ResolveIssueWorktreeResult,
  ResolvedIssueWorktree,
} from "./handlers/worktree.js";
export { resolveWorktreeExecutionContext } from "./handlers/worktree-context.js";
export type {
  WorktreeExecutionContextInput,
  WorktreeExecutionContext,
  ResolveWorktreeExecutionContextResult,
} from "./handlers/worktree-context.js";
export { assessWorktreeRecovery } from "./core/worktree-recovery.js";
export type {
  WorktreeRecoveryAction,
  WorktreeRecoveryLock,
  WorktreeRecoverySnapshot,
  WorktreeRecoveryAssessment,
} from "./core/worktree-recovery.js";
export { createContentResearchHandler } from "./handlers/content-research.js";
export type { ResolvedContentResearchProfile, ContentResearchOutcome } from "./handlers/content-research.js";
export { createContentDraftHandler } from "./handlers/content-draft.js";
export type { ResolvedContentDraftProfile, ContentDraftOutcome } from "./handlers/content-draft.js";
export { createContentReviewHandler } from "./handlers/content-review.js";
export type { ResolvedContentReviewProfile, ContentReviewOutcome } from "./handlers/content-review.js";
export type { GhRunner, GhRunResult, DispatchResult, DispatchOptions } from "./handlers/gh-dispatcher.js";
export { dispatchOutbox, defaultGhRunner } from "./handlers/gh-dispatcher.js";
export type {
  WorkItemProvider,
  WorkItem,
  WorkItemDetails,
  WorkItemTransition,
  RepoHostProvider,
  PullRequest,
  FindPullRequestResult,
  CreatePullRequestInput,
  ProviderResult,
  ProviderRead,
} from "./providers/types.js";
export { ghRunnerFromCommandRunner } from "./providers/github/gh-runner.js";
export { GhWorkItemProvider } from "./providers/github/gh-work-item-provider.js";
export { GhRepoHostProvider } from "./providers/github/gh-repo-host-provider.js";
export { GiteaRepoHostProvider } from "./providers/gitea/gitea-repo-host-provider.js";
export { GiteaWorkItemProvider } from "./providers/gitea/gitea-work-item-provider.js";
export type { GiteaWorkItemProviderOptions } from "./providers/gitea/gitea-work-item-provider.js";
export {
  createGiteaClient,
  defaultGiteaHttpSync,
  createGiteaHttp,
  defaultGiteaHttp,
  redactGiteaSecrets,
  resolveGiteaToken,
  buildGiteaApiUrl,
  GiteaAuthConfigError,
} from "./providers/gitea/gitea-client.js";
export type {
  GiteaClient,
  GiteaRequest,
  GiteaResponse,
  GiteaMethod,
  GiteaHttpSync,
  GiteaClientOptions,
  GiteaHttpRequest,
  GiteaHttpRequestInput,
  GiteaHttpResponse,
  GiteaHttpOptions,
  GiteaSecretDeps,
} from "./providers/gitea/gitea-client.js";
export { resolveRepoHostProvider, resolveSessionRepoHost, defaultGiteaClientBuilder } from "./providers/repo-host-factory.js";
export type {
  RepoHostProviderDeps,
  SessionRepoHost,
  GiteaClientBuilder,
  GiteaTokenResolverDeps,
} from "./providers/repo-host-factory.js";
export {
  GitHubAppAuth,
  createAppJwt,
  createGhRunnerForAuth,
  resolveGhRunner,
  ghRunnerWithToken,
  resolveGitHubAppCredentials,
  redactSecrets,
  GitHubAuthConfigError,
} from "./providers/github/github-app-auth.js";
export type {
  GitHubAppAuthOptions,
  GitHubAppCredentials,
  HttpPostJson,
  HttpPostJsonSync,
  SecretResolverDeps,
  GhRunnerAuthDeps,
} from "./providers/github/github-app-auth.js";
