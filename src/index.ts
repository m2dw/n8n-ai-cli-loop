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
  IssueRefinementAgentsConfig,
  IssueRefinementConfig,
  IssueRefinementLimitsConfig,
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
export type {
  ExecutionLabelSet,
  LabelDiff,
  IssueAutomationSuspension,
  IssueActivationStore,
  IssueActivationOutcome,
} from "./core/issue-activation.js";
export {
  resolveExecutionLabelSet,
  planSuspend,
  planActivate,
  suspendIssueAutomation,
  activateIssueAutomation,
  suspensionLabelOwner,
  suspensionLabelsOwnedBy,
} from "./core/issue-activation.js";
export type {
  ChainSyncStatus,
  ChainRevisionState,
  ChainMemberRole,
  ChainRecord,
  ChainMember,
  ChainEdge,
  ChainGraph,
  ChainRevisionRecord,
  ChainAlias,
  ChainMemberInput,
  ChainMemberOwner,
  ChainEdgeInput,
  ChainGraphIntegrityError,
  ChainRegistryFailure,
  ChainRegistryFailureCode,
  ChainRegistryResult,
  ChainRegistryStore,
  ChainRevisionStateResult,
  ChainListFilter,
  CreateChainInput,
  PutChainGraphInput,
  ChainMetadataPatch,
  ChainSyncStatePatch,
  ChainRevisionInput,
  ChainAliasInput,
  RetireChainInput,
  ChainRetirement,
  AcceptedRevisionGuard,
  AcceptedRevisionGuardContext,
} from "./core/chain-registry.js";
export {
  CHAIN_ID_PREFIX,
  MAX_CHAIN_ID_SUFFIX,
  MAX_CHAIN_ALIAS_LENGTH,
  isChainMemberRole,
  isChainSyncStatus,
  isChainRevisionState,
  isValidChainId,
  isValidChainAlias,
  isValidIssueNumber,
  chainIdCandidate,
  defaultChainId,
  allocateChainId,
  checkChainGraphIntegrity,
  canonicalChainGraphText,
  chainGraphFingerprint,
} from "./core/chain-registry.js";
export type {
  ChainGraphEdge,
  ChainGraphMember,
  ChainGraphCandidate,
  ChainOwnershipEntry,
  ChainGraphValidationOptions,
  ChainGraphDiagnosticCode,
  ChainGraphDiagnostic,
  CanonicalChainGraph,
  ChainGraphValidation,
  ChainGraphSnapshot,
  ChainGraphComparison,
} from "./core/chain-graph.js";
export {
  CHAIN_GRAPH_DIAGNOSTIC_CODES,
  MAX_DIAGNOSTIC_MESSAGE_ISSUES,
  MAX_DIAGNOSTIC_TOKEN_CHARS,
  isChainGraphDiagnosticCode,
  formatChainGraphEdge,
  chainGraphTopologicalOrder,
  validateChainGraph,
  compareChainGraphs,
} from "./core/chain-graph.js";
export type {
  ChainAcceptanceStore,
  AcceptChainGraphInput,
  ChainGraphAccepted,
  ChainGraphUnchanged,
  ChainGraphRejected,
  ChainGraphConflict,
  ChainGraphVetoed,
  ChainGraphFailed,
  ChainAcceptanceFailureCode,
  ChainGraphAcceptance,
} from "./core/chain-acceptance.js";
export { acceptChainGraph, collectChainOwnership } from "./core/chain-acceptance.js";
export type {
  ChainSyncProviderError,
  ChainSyncRefusalKind,
  ChainSyncObservation,
  ChainSyncImport,
  ChainSyncRefusal,
  ChainSyncPlan,
  FrozenPrefixConflict,
} from "./core/chain-sync.js";
export {
  CHAIN_SYNC_REFUSAL_KINDS,
  isChainSyncRefusalKind,
  diagnosticRemediationHints,
  frozenPrefixRefusal,
  planChainSync,
} from "./core/chain-sync.js";
export type {
  ChainLinearOperation,
  ChainLinearTarget,
  ChainLinearPlanInput,
  ChainLinearApply,
  ChainLinearRefusal,
  ChainLinearPlan,
} from "./core/chain-linear.js";
export {
  CHAIN_LINEAR_OPERATIONS,
  isChainLinearOperation,
  planLinearChainEdit,
  verifyLinearChainReadBack,
  structuralChainLinearRefusal,
  ownedElsewhereChainLinearRefusal,
} from "./core/chain-linear.js";
export type {
  ChainAdvancedOperation,
  ChainMergePosition,
  ChainForkPlanInput,
  ChainMergePlanInput,
  ChainAdvancedGraph,
  ChainForkApply,
  ChainMergeApply,
  ChainAdvancedRefusal,
  ChainForkPlan,
  ChainMergePlan,
  ForkFrozenShape,
} from "./core/chain-advanced.js";
export {
  CHAIN_ADVANCED_OPERATIONS,
  CHAIN_MERGE_POSITIONS,
  isChainMergePosition,
  planChainFork,
  planChainMerge,
  verifyAdvancedChainReadBack,
  checkForkFrozenPrefixes,
  checkMergeFrozenPrefixes,
  structuralChainAdvancedRefusal,
  ownedElsewhereChainAdvancedRefusal,
} from "./core/chain-advanced.js";
export type {
  ChainEditLockHolder,
  ChainEditLockAcquisition,
  ChainEditLockOwnerLiveness,
  AcquireChainEditLocksInput,
  ChainEditLockRenewal,
  RenewChainEditLocksInput,
  ChainEditLockStore,
} from "./core/chain-edit-lock.js";
export {
  CHAIN_EDIT_LOCK_STALE_MS,
  CHAIN_EDIT_LOCK_RENEW_MS,
  CHAIN_EDIT_LOCK_ABANDONED_MS,
  chainEditLockIsTakeable,
  chainEditIssueLockScope,
  chainEditAliasLockScope,
  chainEditLockScopes,
  chainEditLockScopeKind,
  describeChainEditLockScope,
} from "./core/chain-edit-lock.js";
export type {
  ChainIntakeTargetInput,
  ChainIntakeTarget,
  ChainIntakeExtendTarget,
  ChainIntakeProviderError,
  ChainIntakePlanInput,
  ChainIntakeRegistration,
  ChainIntakeRefusal,
  ChainIntakePlan,
  ChainIntakeErrorKey,
  ChainIntakeErrorRecord,
  ChainIntakeErrorStore,
  EnqueueTaskWithChainFreezeResult,
  ChainIntakeEnqueueStore,
} from "./core/chain-intake.js";
export {
  resolveChainIntakeTarget,
  planChainIntake,
  structuralChainIntakeRefusal,
  frozenPrefixChainIntakeRefusal,
  chainIntakeRefusalFingerprint,
  formatChainIntakeErrorComment,
} from "./core/chain-intake.js";
export type {
  ChainBaseKind,
  ChainBaseDecision,
  ChainPrefix,
  FrozenPrefixKey,
  FrozenPrefixSnapshot,
  BuildFrozenPrefixInput,
  FrozenPrefixViolationCode,
  FrozenPrefixViolation,
  CandidateBaseDecision,
  FrozenPrefixGuardInput,
  FrozenPrefixGuardVerdict,
  FrozenPrefixListFilter,
  ChainFrozenPrefixStore,
  FreezeChainPrefixTransition,
  FreezeChainPrefixInput,
  FreezeChainPrefixFailureCode,
  FreezeChainPrefixResult,
  ChainPrefixFreezeStore,
} from "./core/chain-frozen-prefix.js";
export {
  MAX_CHAIN_BASE_REF_LENGTH,
  MAX_BASE_REF_MESSAGE_CHARS,
  FROZEN_PREFIX_VIOLATION_CODES,
  isChainBaseKind,
  isChainBaseDecision,
  isFrozenPrefixViolationCode,
  chainBaseDecisionsEqual,
  canonicalChainBaseDecisionText,
  computeChainPrefix,
  canonicalFrozenPrefixText,
  frozenPrefixFingerprint,
  buildFrozenPrefix,
  validateFrozenPrefixSnapshot,
  checkFrozenPrefixes,
} from "./core/chain-frozen-prefix.js";
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
export {
  DEFAULT_SESSIONS_PATH,
  describeUnresolvedSessionId,
  JsonSessionRegistry,
  resolveSessionRef,
  SessionReferenceError,
  SessionRegistryFatalError,
} from "./registries/json-session-registry.js";
export type {
  SessionReferenceErrorKind,
  SessionRegistryDiagnostic,
  SessionRegistryDiagnosticKind,
} from "./registries/json-session-registry.js";
export type {
  BlockedByEntry,
  DependencyChecker,
  DependencyDecision,
  GhIssue,
  IssueCandidate,
  IssueCandidateWithDecision,
  RefinementIntakeOptions,
  RefinementIntakeRefusal,
} from "./core/github-intake.js";
export { labelsToPhase, parseCandidates } from "./core/github-intake.js";
// Chain-aware progressive Issue refinement (issue #866/#867,
// docs/issue-refinement-contract.md).
export type {
  BuildRefinementContextInput,
  IssueRefinementConfigError,
  IssueRefinementLimitKey,
  IssueRefinementLimits,
  IssueRefinementSettingsResolution,
  IssueSourceDigestInput,
  IssueSourceFingerprint,
  ManagedRegionScan,
  ManagedRegionShape,
  RefinementActivationPlan,
  RefinementActivationStep,
  RefinementAdmission,
  RefinementChangeClass,
  RefinementContextBlock,
  RefinementCounters,
  RefinementCriticVerdict,
  RefinementExecutionConflictRecord,
  RefinementHandoffReason,
  RefinementLabels,
  RefinementPredecessorRecord,
  RefinementRefusalReason,
  RefinementRoles,
  RefinementState,
  RefinementTopologyDisposition,
  ResolvedIssueRefinementSettings,
} from "./core/issue-refinement.js";
export {
  DEFAULT_REFINEMENT_MARKER_LABEL,
  EXECUTABLE_STATUS_LABELS,
  IMPLEMENTATION_LANE_AGENT_LABELS,
  IMPLEMENTATION_STATUS_LABEL,
  ISSUE_REFINEMENT_DEFAULT_LIMITS,
  ISSUE_REFINEMENT_LIMIT_KEYS,
  ISSUE_REFINEMENT_LIMIT_SPECS,
  MANAGED_REGION_BEGIN_PREFIX,
  MANAGED_REGION_END,
  REFINEMENT_ACTIVATION_STEPS,
  REFINEMENT_CHANGE_CLASSES,
  REFINEMENT_CONTEXT_KEY,
  REFINEMENT_CRITIC_VERDICTS,
  REFINEMENT_EXECUTION_CONFLICT_KEY,
  REFINEMENT_EXECUTION_SUSPENDED_EVENT,
  REFINEMENT_HANDOFF_REASONS,
  REFINEMENT_REFUSAL_REASONS,
  REFINEMENT_STATES,
  REFINEMENT_TOPOLOGY_DISPOSITIONS,
  TERMINAL_REFINEMENT_STATES,
  buildRefinementContextBlock,
  buildRefinementExecutionConflict,
  computeIssueSourceDigest,
  computeIssueSourceFingerprint,
  describeRefinementExecutionConflict,
  evaluateRefinementAdmission,
  implementationLaneAgentLabel,
  isRefinementHandoffReason,
  isRefinementState,
  isSuspendableForRefinement,
  readRefinementContextBlock,
  readRefinementExecutionConflict,
  refinementRoleFallbacks,
  resolveIssueRefinementSettings,
  resolveRefinementLabels,
  scanManagedRegion,
} from "./core/issue-refinement.js";
export type {
  RefinementActivationStatus,
  RefinementCounterStatus,
  RefinementTaskStatus,
} from "./core/issue-refinement-status.js";
export { renderRefinementLines, summarizeRefinementStatus } from "./core/issue-refinement-status.js";
// The bounded predecessor snapshot and its fingerprint (issue #868,
// docs/issue-refinement-contract.md §4, §5, §6).
export type {
  BuildRefinementSnapshotInput,
  RefinementChainAgreement,
  RefinementChangedPathListing,
  RefinementChangedPathRead,
  RefinementCommentRead,
  RefinementIssueRead,
  RefinementPredecessorHold,
  RefinementPredecessorHoldReason,
  RefinementPredecessorIdentity,
  RefinementPredecessorShape,
  RefinementPredecessorUsability,
  RefinementPullRequestLookup,
  RefinementPullRequestRead,
  RefinementReviewSummaryRead,
  RefinementSnapshot,
  RefinementSnapshotComment,
  RefinementSnapshotFailureStage,
  RefinementSnapshotManifest,
  RefinementSnapshotPredecessor,
  RefinementSnapshotPullRequest,
  RefinementSnapshotResult,
  RefinementSnapshotSource,
  RefinementSnapshotTarget,
  RefinementUsablePredecessor,
} from "./core/issue-refinement-snapshot.js";
export {
  REFINEMENT_MAX_COMMENT_IDENTITY_BYTES,
  REFINEMENT_MAX_PR_IDENTITY_BYTES,
  REFINEMENT_MAX_TARGET_LABELS,
  REFINEMENT_MAX_TARGET_LABEL_BYTES,
  REFINEMENT_PREDECESSOR_HOLD_REASONS,
  REFINEMENT_PREDECESSOR_SHAPES,
  REFINEMENT_SNAPSHOT_VERSION,
  boundSnapshotText,
  buildRefinementSnapshot,
  classifyPredecessorUsability,
  computePredecessorFingerprint,
  directPredecessorNumbers,
  refinementPredecessorRecords,
  refinementSnapshotByteBudget,
} from "./core/issue-refinement-snapshot.js";
// §4 condition 5 against the chain registry, shared by the handler's snapshot
// source and the intake gate below (issue #967).
export type { ChainAgreementRegistryReader } from "./core/issue-refinement-chain-agreement.js";
export { readChainAgreementFromRegistry } from "./core/issue-refinement-chain-agreement.js";
// The intake-side predecessor gate: §4 conditions 2–5 evaluated before a
// claimable task exists, so a held Issue never consumes a worker turn
// (issue #967, docs/issue-refinement-contract.md §4, §12 row 4).
export type {
  EvaluateRefinementIntakeEligibilityInput,
  RefinementEligibilitySource,
  RefinementIntakeDisposition,
  RefinementIntakeEligibility,
  RefinementIntakeLeaveReason,
  RefinementPredecessorHoldRecord,
  RefinementStructuralReason,
} from "./core/issue-refinement-eligibility.js";
export {
  REFINEMENT_PREDECESSOR_HOLD_KEY,
  buildRefinementPredecessorHold,
  decideRefinementIntakeDisposition,
  describeRefinementPredecessorHold,
  evaluateRefinementIntakeEligibility,
  readRefinementPredecessorHold,
} from "./core/issue-refinement-eligibility.js";
// The two-agent refinement loop's pure half: result schemas, fail-closed
// validation, topology combination, region rendering, role independence
// (issue #869, docs/issue-refinement-contract.md §7, §9, §10, §17).
export type {
  CombinedTopologyDispositions,
  CriticParse,
  EffectiveTopologyDisposition,
  RefinedContract,
  RefinementAcceptedRecord,
  RefinementConfidence,
  RefinementCritique,
  RefinementExecutionRecord,
  RefinementIndependenceRejection,
  RefinementIndependenceResult,
  RefinementLoopContextBlock,
  RefinementObjection,
  RefinementObjectionField,
  RefinementObjectionKind,
  RefinementPendingRetryRecord,
  RefinementPredecessorReference,
  RefinementRoleIdentity,
  RefinementRoleRunRecord,
  RefinementTopologyKind,
  RefinementTopologyProposal,
  RefinerParse,
} from "./core/issue-refinement-loop.js";
export {
  REFINEMENT_CONFIDENCE_LEVELS,
  REFINEMENT_INDEPENDENCE_REJECTIONS,
  REFINEMENT_MAX_OBJECTIONS,
  REFINEMENT_MAX_TOPOLOGY_PROPOSALS,
  REFINEMENT_OBJECTION_FIELDS,
  REFINEMENT_OBJECTION_KINDS,
  REFINEMENT_RECORD_MAX_BYTES,
  REFINEMENT_TOPOLOGY_KINDS,
  buildCriticPrompt,
  buildRefinerPrompt,
  combineTopologyDispositions,
  containsFilesystemPath,
  containsManagedRegionMarker,
  evaluateRefinementRoleIndependence,
  extractRefinementRecord,
  parseCriticResponse,
  parseRefinerResponse,
  renderManagedRegion,
} from "./core/issue-refinement-loop.js";
// The application/activation slice's pure half: region splice and trust,
// applied-region digest, audit-comment rendering and idempotency, and the
// marker-precondition evaluation for the labels-last transition (issue #870,
// docs/issue-refinement-contract.md §6, §10, §11, §16).
export type {
  ManagedRegionExtraction,
  ManagedRegionWriteDisposition,
  MarkerRemovalDisposition,
  RefinementAppliedRegionRecord,
  RefinementApplyContextBlock,
  RefinementApplyPort,
  RefinementApplyProgress,
  RefinementAuditCommentInput,
  StatusAdditionDisposition,
} from "./core/issue-refinement-apply.js";
export {
  MAX_APPLY_TRANSIENT_FAILURES,
  REFINEMENT_COMMENT_MARKER_PREFIX,
  REFINEMENT_COMMENT_SCAN_ALL,
  appliedRegionPrefixes,
  computeAppliedRegionDigest,
  evaluateManagedRegionWrite,
  evaluateMarkerRemoval,
  evaluateStatusAddition,
  extractManagedRegion,
  hasRefinementComment,
  refinementCommentMarker,
  refinementFingerprintPrefix,
  renderRefinementAuditComment,
  spliceManagedRegion,
} from "./core/issue-refinement-apply.js";
// The public half of a terminal handoff: which escalation may be announced, the
// bounded §16 comment it renders, and the run-independent idempotency key both
// of its effects share (issue #936, docs/issue-refinement-contract.md §13).
export type {
  RefinementHandoffPublication,
  RefinementHandoffRole,
} from "./core/issue-refinement-publication.js";
export {
  MAX_HANDOFF_COMMENT_CHARS,
  REFINEMENT_HANDOFF_COMMENT_UNDELIVERABLE_EVENT,
  REFINEMENT_HANDOFF_MARKER,
  REFINEMENT_HANDOFF_NEXT_ACTIONS,
  publishableRefinementHandoff,
  publishableRefinementHandoffFromContext,
  refinementHandoffCommentMarker,
  refinementHandoffEffectFromKey,
  refinementHandoffIdempotencyKey,
  renderRefinementHandoffComment,
} from "./core/issue-refinement-publication.js";
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
export {
  matchesConfiguredVerificationCommand,
  resolveConfiguredVerification,
  collectPendingImplementationMarkers,
  decideToolRequestContinuation,
  buildToolRequestContinuationRecord,
  boundEvidenceLabel,
  TOOL_REQUEST_PENDING_MARKERS,
  TOOL_REQUEST_CONTINUATION_CHECKS,
  MAX_EVIDENCE_LABEL_CHARS,
} from "./core/tool-request-continuation.js";
export type {
  ToolRequestPendingMarker,
  PendingMarkerInputs,
  ToolRequestContinuationPhase,
  ToolRequestContinuationCheck,
  ToolRequestContinuationReason,
  ToolRequestContinuationInput,
  ToolRequestContinuationEvidence,
  ToolRequestContinuationDecision,
  ToolRequestContinuationRecord,
} from "./core/tool-request-continuation.js";
export { MemoryTaskStore } from "./stores/memory-task-store.js";
export { SqliteTaskStore } from "./stores/sqlite-task-store.js";
export { SqliteOutboxStore, DEFAULT_DB_PATH } from "./stores/sqlite-outbox-store.js";
export { SqliteContextStore } from "./stores/sqlite-context-store.js";
export { SqliteSessionControlStore } from "./stores/sqlite-session-control-store.js";
export { SqliteIssueActivationStore } from "./stores/sqlite-issue-activation-store.js";
export {
  SqliteChainRegistryStore,
  DEFAULT_CHAIN_REGISTRY_DB_PATH,
} from "./stores/sqlite-chain-registry-store.js";
export {
  migrateChainRegistrySchema,
  CHAIN_REGISTRY_SCHEMA,
  CHAIN_REGISTRY_INDEXES,
  CHAIN_REGISTRY_ADDITIVE_COLUMNS,
} from "./stores/chain-registry-migration.js";
export { CorruptFrozenPrefixError } from "./stores/frozen-prefix-rows.js";
export { RepoLockStore, DEFAULT_LOCK_DIR } from "./stores/repo-lock-store.js";
export type { AcquireResult, ReleaseResult, InspectResult, ForceReleaseResult } from "./stores/repo-lock-store.js";
export type { WorktreeConfig } from "./core/session.js";
export {
  WORKTREE_ROOT_ENV,
  DEFAULT_WORKTREE_ROOT,
  resolveWorktreeRoot,
  issueWorktreeId,
  issueWorktreePath,
  researchWorktreeId,
  researchWorktreePath,
  sessionWorktreeDir,
  classifyManagedWorktree,
  redactWorktreePaths,
} from "./core/worktree-paths.js";
export type { ManagedWorktreeClass } from "./core/worktree-paths.js";
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
export {
  prepareResearchWorkspace,
  releaseResearchWorkspace,
  defaultResearchWorktreeRuntime,
  publicResearchWorkspaceMessage,
} from "./handlers/research-worktree.js";
export type {
  ResearchWorkspace,
  ResearchWorkspaceStage,
  ResearchWorktreeRuntime,
  PrepareResearchWorkspaceInput,
  PrepareResearchWorkspaceResult,
  ReleaseResearchWorkspaceInput,
  ReleaseResearchWorkspaceResult,
} from "./handlers/research-worktree.js";
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
  DependencyMutationResult,
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
