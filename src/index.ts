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
  AgentRuntimeConfig,
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
  ChainDiagnosticOwner,
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
  chainDiagnosticOwners,
  describeChainOwnership,
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
  ChainRepositoryIdentity,
  ChainOwnershipScope,
  ChainOwnershipScopeSession,
  ChainOwnershipScopeSessionSource,
} from "./core/chain-ownership-scope.js";
export {
  deriveChainRepositoryIdentity,
  chainRepositoryKey,
  formatChainRepository,
  resolveChainOwnershipScope,
  resolveChainOwnershipScopeFor,
} from "./core/chain-ownership-scope.js";
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
  chainEditRepositoryIssueLockScope,
  chainEditAliasLockScope,
  chainEditLockScopes,
  chainEditLockScopeKind,
  describeChainEditLockScope,
  describeChainEditLockScopes,
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
  RefinementCriticBlockStatus,
  RefinementEvidenceStatus,
  RefinementTaskStatus,
} from "./core/issue-refinement-status.js";
export {
  renderRefinementCriticBlockLine,
  renderRefinementLines,
  summarizeRefinementStatus,
} from "./core/issue-refinement-status.js";
// The normalized operator view of §15 refinement progress, shared by
// `admin task-status` and the admin UI (issue #977).
export type {
  RefinementProgressDisposition,
  RefinementProgressMilestoneView,
  RefinementProgressStatus,
  RefinementProgressStatusAgent,
} from "./core/issue-refinement-progress-status.js";
export {
  REFINEMENT_PROGRESS_DISPOSITIONS,
  REFINEMENT_PROGRESS_DISPOSITION_PHRASES,
  renderRefinementProgressLines,
  summarizeRefinementProgress,
} from "./core/issue-refinement-progress-status.js";
// The bounded predecessor snapshot and its fingerprint (issue #868,
// docs/issue-refinement-contract.md §4, §5, §6).
export type {
  BuildRefinementSnapshotInput,
  RefinementChainAgreement,
  RefinementChangedPathListing,
  RefinementChangedPathRead,
  RefinementCommentRead,
  RefinementEvidenceDeclarationParse,
  RefinementEvidenceFileLookup,
  RefinementEvidenceFileRequest,
  RefinementEvidenceOmissionReason,
  RefinementEvidenceParsedEntry,
  RefinementEvidenceProvenance,
  RefinementEvidenceSelector,
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
  RefinementSnapshotEvidence,
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
  REFINEMENT_EVIDENCE_BLOCK_TAG,
  REFINEMENT_EVIDENCE_OMISSION_REASONS,
  REFINEMENT_MAX_COMMENT_IDENTITY_BYTES,
  REFINEMENT_MAX_EVIDENCE_EXPORT_CHARS,
  REFINEMENT_MAX_EVIDENCE_PATH_BYTES,
  REFINEMENT_MAX_EVIDENCE_SELECTIONS,
  REFINEMENT_MAX_EVIDENCE_SOURCE_BYTES,
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
  extractExportedDeclaration,
  parseRefinementEvidenceDeclaration,
  refinementEvidenceOmissions,
  refinementPredecessorRecords,
  refinementSnapshotByteBudget,
} from "./core/issue-refinement-snapshot.js";
// §5.2: the required-evidence preflight that stops the lane before either agent
// runs when declared predecessor contract evidence could not be captured
// (issue #1003, docs/issue-refinement-contract.md §5.2, §12 row 48).
export type {
  RefinementEvidenceGap,
  RefinementEvidenceGapReason,
  RefinementEvidenceGapRequirement,
  RefinementEvidenceGateRecord,
  RefinementEvidencePreflight,
} from "./core/issue-refinement-evidence-preflight.js";
export {
  REFINEMENT_EVIDENCE_GAP_REASONS,
  evaluateRefinementEvidencePreflight,
  refinementEvidencePreflight,
} from "./core/issue-refinement-evidence-preflight.js";
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
  RefinementBlockReason,
  RefinementCriticBlockRecord,
  RefinementCriticRoute,
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
  REFINEMENT_BLOCK_REASONS,
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
  refinementEvidenceComplete,
  renderManagedRegion,
  routeCriticVerdict,
} from "./core/issue-refinement-loop.js";
// §9.1 topology-proposal normalization against the authoritative relationship
// graph: an already-satisfied proposal is a no-op, never a human handoff
// (issue #982, docs/issue-refinement-contract.md §9.1).
export type {
  NormalizedTopologyProposal,
  RefinementRelationshipGraph,
  RefinementRelationshipGraphFailure,
  RefinementTopologyNormalization,
  RefinementTopologyRelationship,
  TopologyNormalizationResult,
} from "./core/issue-refinement-topology.js";
export {
  REFINEMENT_RELATIONSHIP_GRAPH_FAILURES,
  REFINEMENT_TOPOLOGY_NORMALIZATIONS,
  normalizeTopologyProposals,
  refinementRelationshipGraph,
  validRefinementTopologyRelationship,
} from "./core/issue-refinement-topology.js";
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
// bounded §16 comment it renders, and the run-independent idempotency key all of
// its effects share (issue #936, docs/issue-refinement-contract.md §13) — the
// work-item label, the comment, and the messenger notification (issue #981).
export type {
  RefinementHandoffEffect,
  RefinementHandoffPublication,
  RefinementHandoffRole,
} from "./core/issue-refinement-publication.js";
export {
  MAX_HANDOFF_COMMENT_CHARS,
  REFINEMENT_HANDOFF_COMMENT_UNDELIVERABLE_EVENT,
  REFINEMENT_HANDOFF_EFFECTS,
  REFINEMENT_HANDOFF_MARKER,
  REFINEMENT_HANDOFF_NEXT_ACTIONS,
  publishableRefinementHandoff,
  publishableRefinementHandoffFromContext,
  recordedRefinementHandoffLabel,
  refinementHandoffCommentMarker,
  refinementHandoffEffectFromKey,
  refinementHandoffIdempotencyKey,
  renderRefinementHandoffComment,
  withRecordedRefinementHandoffLabel,
} from "./core/issue-refinement-publication.js";
// §13's operator recovery: the preconditions row 36 refuses on, the reset it
// performs, and the run-independent key its one effect carries (issue #980,
// docs/issue-refinement-contract.md §13, §12 row 36).
export type {
  RefinementRecoveryLabelObservation,
  RefinementRecoveryLabelRefusal,
  RefinementRecoveryPlan,
  RefinementRecoveryRefusal,
  RefinementRecoveryReset,
  RefinementRecoveryTarget,
} from "./core/issue-refinement-recovery.js";
export {
  REFINEMENT_RECOVERY_EVENT,
  evaluateRefinementRecoveryLabels,
  evaluateRefinementRecoveryTarget,
  planRefinementRecovery,
  refinementRecoveryCount,
  refinementRecoveryEvent,
  refinementRecoveryIdempotencyKey,
} from "./core/issue-refinement-recovery.js";
// The stable, versioned progress projection over the fine-grained audit events:
// the milestone contract, its deterministic identity, and the bounded dedupe
// ledger (issue #975, docs/issue-refinement-contract.md §15).
export type {
  RefinementMilestoneIdentity,
  RefinementProgressAgentRecord,
  RefinementProgressBlockView,
  RefinementProgressCommit,
  RefinementProgressCommitInput,
  RefinementProgressLedger,
  RefinementProgressMilestone,
  RefinementProgressMilestoneKind,
  RefinementProgressNextAction,
  RefinementProgressProjectionInput,
  RefinementProgressResult,
  RefinementProgressRole,
  RefinementProgressSourceEvent,
} from "./core/issue-refinement-progress.js";
export {
  REFINEMENT_MILESTONE_ID_CHARS,
  REFINEMENT_PHASE_FAILED_CLASS,
  REFINEMENT_PHASE_FAILED_TRANSITION,
  REFINEMENT_PROGRESS_EVENT_TYPE,
  REFINEMENT_PROGRESS_LEDGER_HEADROOM,
  REFINEMENT_PROGRESS_MAX_IDENTIFIER_CHARS,
  REFINEMENT_PROGRESS_MAX_SLUG_CHARS,
  REFINEMENT_PROGRESS_MILESTONE_KINDS,
  REFINEMENT_PROGRESS_NEXT_ACTIONS,
  REFINEMENT_PROGRESS_ROLES,
  REFINEMENT_PROGRESS_SCHEMA_VERSION,
  appendRefinementProgressLedger,
  computeRefinementMilestoneId,
  prepareRefinementProgressCommit,
  projectRefinementProgress,
  readRefinementProgressBlock,
  readRefinementProgressLedger,
  refinementProgressEvent,
  refinementProgressLedgerCap,
  stampRefinementRetryDeadline,
} from "./core/issue-refinement-progress.js";
export type {
  RefinementProgressComment,
  RefinementProgressCommentAgent,
  RefinementProgressCommentProjection,
  RefinementProgressCommentRefusal,
} from "./core/issue-refinement-progress-publication.js";
export {
  MAX_PROGRESS_COMMENT_CHARS,
  REFINEMENT_PROGRESS_COMMENT_HEADLINES,
  REFINEMENT_PROGRESS_COMMENT_MARKER,
  REFINEMENT_PROGRESS_COMMENT_PROJECTION,
  REFINEMENT_PROGRESS_COMMENT_UNPUBLISHABLE_EVENT,
  REFINEMENT_PROGRESS_COMMENT_VERSION,
  REFINEMENT_PROGRESS_NEXT_ACTION_PHRASES,
  publishableRefinementProgressComment,
  refinementProgressCommentIdempotencyKey,
  refinementProgressCommentMarker,
  refinementProgressCommentUnpublishableEvent,
  renderRefinementProgressComment,
} from "./core/issue-refinement-progress-publication.js";
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
export { makeOutboxKey, categorizeOutboxEntry, cancelPendingOutboxEntriesByKey } from "./core/outbox.js";
// Transport deadlines for outbox delivery (issue #1064): the bounds themselves,
// the per-attempt budget they are spent against, and the sanitized diagnostic a
// bounded hang records.
export type {
  OutboxAttemptBudget,
  OutboxTransportDeadlines,
  OutboxTransportDeadlineOverrides,
  OutboxTransportTimeoutFacts,
  OutboxTransportKind,
  OutboxTransportTimeoutStage,
} from "./core/outbox-transport-deadline.js";
export {
  OUTBOX_ATTEMPT_DEADLINE_MS,
  OUTBOX_ATTEMPT_LEASE_MARGIN_MS,
  OUTBOX_GH_CALL_DEADLINE_MS,
  OUTBOX_GITHUB_APP_TOKEN_EXCHANGE_DEADLINE_MS,
  OUTBOX_SLACK_REQUEST_DEADLINE_MS,
  OUTBOX_TRANSPORT_TIMEOUT_PREFIX,
  OutboxTransportDeadlineConfigError,
  describeOutboxTransportTimeout,
  isOutboxTransportTimeout,
  resolveOutboxTransportDeadlines,
  sanitizeTimeoutDetail,
  startOutboxAttemptBudget,
} from "./core/outbox-transport-deadline.js";
// Post-create PR reconciliation (issue #998): the pure "may this run adopt the
// PR that already exists?" decision. The provider-facing wrapper that feeds it
// lives with the other PR helpers in handlers/pr-helpers.ts.
export { reconcileExistingPullRequest, repoSlugFromPrUrl } from "./core/pr-reconciliation.js";
export type {
  ReconcilablePullRequest,
  PrReconciliationExpectation,
  PrReconciliationDecision,
  PrReconciliationRefusal,
} from "./core/pr-reconciliation.js";
// Merged-PR task reconciliation (issue #1047): the operation core behind
// docs/merged-pr-reconciliation-contract.md — the §7 outcome decision, the §8
// atomic transition, and the §9 audit record — over injected store/provider/
// lock dependencies. Deliberately separate from the #998 adoption decision
// above (contract §15.2): that one adopts OPEN PRs on a creation retry, this
// one completes tasks whose exact recorded PR is MERGED.
export {
  reconcileMergedPrTask,
  assessMergedPrProviderSupport,
  validateMergedPrDispositionHistory,
  MERGED_PR_RECONCILIATIONS_CONTEXT_KEY,
  TASK_MERGED_PR_RECONCILED_EVENT,
} from "./core/merged-pr-reconciliation.js";
export type {
  MergedPrReconciliationOutcome,
  MergedPrReconciliationRefusal,
  MergedPrReconciliationMode,
  MergedPrReconciliationDeps,
  MergedPrReconciliationRequest,
  MergedPrTaskReconciliationResult,
  MergedPrDispositionRecord,
  MergedPrDispositionHistoryValidation,
  MergedPrRepoHostPort,
  MergedPrIssueLockPort,
  MergedPrProviderPullRequest,
  MergedPrProviderRead,
} from "./core/merged-pr-reconciliation.js";
// Task-scoped verification plan revisions and amendments (issue #1038): the
// persistence slice (A2) of docs/verification-amendment-contract.md — the
// append-only revision chain plus the mutable §5.5 plan checkpoint on the
// task row, the atomic CAS apply/rebase writes, and the §12.1 audit events.
// Since issue #1043 the apply also takes the §9.2 continuation: a routing
// revision re-queues `{queued, <continuation>}` and clears the stale
// review-park state in the same transaction that persists the amended plan.
export {
  applyVerificationAmendmentRevision,
  rebaseVerificationPlanCheckpoint,
  readVerificationAmendmentState,
  verificationContinuationRequeueRow,
  VERIFICATION_CONTINUATION_CLEARED_CONTEXT_KEYS,
  validateVerificationAmendmentState,
  validateVerificationAmendmentOperations,
  canonicalJsonStringify,
  deriveExecutionCommandId,
  deriveRequirementCommandId,
  deriveSessionBaselineDigest,
  VERIFICATION_AMENDMENTS_CONTEXT_KEY,
  VERIFICATION_AMENDMENT_APPLIED_EVENT,
  VERIFICATION_AMENDMENT_REBASED_EVENT,
  MAX_VERIFICATION_AMENDMENT_REVISIONS,
  MAX_VERIFICATION_AMENDMENT_OPERATIONS,
  MAX_VERIFICATION_AMENDMENT_REASON_CHARS,
  MAX_VERIFICATION_AMENDMENT_COMMAND_CHARS,
  MAX_VERIFICATION_AMENDMENT_ACTOR_ID_CHARS,
  MAX_VERIFICATION_AMENDMENT_NAME_CHARS,
  MAX_VERIFICATION_SESSION_BASELINE_ENTRIES,
} from "./core/verification-amendment.js";
export type {
  VerificationAmendmentLayer,
  VerificationAmendmentSource,
  VerificationAmendmentContinuation,
  VerificationAmendmentActor,
  VerificationAmendmentOperation,
  VerificationAmendmentRevision,
  VerificationPlanSessionBaselineEntry,
  VerificationPlanCheckpoint,
  VerificationAmendmentState,
  VerificationAmendmentStateValidation,
  VerificationAmendmentOperationsValidation,
  VerificationAmendmentStateRead,
  VerificationAmendmentStore,
  VerificationAmendmentRevisionInput,
  VerificationPlanCheckpointInput,
  VerificationPlanSlotCounts,
  ApplyVerificationAmendmentInput,
  ApplyVerificationAmendmentOutcome,
  VerificationAmendmentRefusalReason,
  RebaseVerificationPlanCheckpointInput,
  RebaseVerificationPlanCheckpointOutcome,
} from "./core/verification-amendment.js";
// Effective verification plan resolution (issue #1039): the resolution half of
// slice A1 of docs/verification-amendment-contract.md — one deterministic,
// side-effect-free resolver over the session baseline, the intake-pinned
// Issue-derived requirements, and the applied amendment chain, plus the
// authoring-time operation composition, the §6.4 reconciliation, and the §6.2
// satisfaction test. Since issue #1040, review Step 4.5 and `admin
// review-verification resolve` consult it for evidence identity; since issue
// #1043 the Step 4.5 gate itself consumes the effective requirement layer, so
// an applied amendment changes what the review demands.
export {
  resolveEffectiveVerificationPlan,
  proposeVerificationRevision,
  reconcileVerificationPlan,
  buildEffectiveRequirementStatus,
  executionSatisfiesRequirement,
  buildVerificationSessionBaseline,
  effectiveVerificationCommands,
  verificationPlanSlotCounts,
  verificationPlanDispositions,
  deriveAddedCommandId,
  MAX_VERIFICATION_PLAN_REQUIREMENTS,
} from "./core/verification-plan.js";
export type {
  VerificationSlotState,
  VerificationSlotOrigin,
  VerificationSlotAmendmentRecord,
  EffectiveVerificationSlot,
  EffectiveVerificationPlan,
  EffectiveVerificationPlanInput,
  VerificationPlanNote,
  VerificationPlanInputRefusal,
  ResolveEffectiveVerificationPlanResult,
  ProposeVerificationRevisionInput,
  ProposeVerificationRevisionResult,
  VerificationRevisionRefusal,
  ReconcileVerificationPlanInput,
  VerificationPlanReconciliation,
  VerificationSessionBaselineResult,
  EvidenceSlotInvalidation,
  ManualVerificationEvidenceLike,
  EffectiveRequirementStatus,
  EffectiveRequirementVerification,
  EffectiveRequirementEvidenceExpectations,
  FullSuiteRequirementDeclaration,
} from "./core/verification-plan.js";
export { buildVerificationEvidenceBindingBlock } from "./core/verification-plan.js";
// Verification evidence binding (issue #1040): manual verification evidence is
// admissible only for the plan revision, slot identity, and reviewed commit it
// was recorded against — legacy unbound evidence is conservatively rejected,
// and stale evidence fails closed instead of producing a false pass.
export {
  evaluateVerificationEvidenceBinding,
  isVerificationSlotInvalidated,
  readVerificationEvidenceEntryBinding,
  readVerificationEvidenceBindingBlock,
  normalizeCommitSha,
  VERIFICATION_EVIDENCE_BINDING_CONTEXT_KEY,
  MAX_VERIFICATION_EVIDENCE_COMMAND_ID_CHARS,
  MAX_VERIFICATION_EVIDENCE_COMMAND_IDS,
  MAX_VERIFICATION_EVIDENCE_COMMAND_CHARS,
} from "./core/verification-evidence.js";
export type {
  VerificationEvidenceBinding,
  VerificationEvidenceBindingBlock,
  VerificationEvidenceExpectations,
  VerificationEvidenceRejection,
  VerificationEvidenceVerdict,
  BoundVerificationEvidenceLike,
} from "./core/verification-evidence.js";
// Refresh from the Issue (issue #1041): slice A6 of
// docs/verification-amendment-contract.md §10 — a live, provider-neutral read
// of the Issue body projected through the shipped extractor and diffed against
// the effective requirement layer, applied as one `issue-refresh` revision.
// Requirement-layer operations only; no `replace`, no implicit retirement, and
// no write to `context.body` or any other task field.
export {
  refreshIssueVerification,
  diffIssueVerificationRefresh,
  verificationRefreshOperations,
  verificationOperationsIdentityForm,
  deriveVerificationRevisionId,
  deriveVerificationRequestKey,
  deriveIssueBodyDigest,
  defaultVerificationContinuation,
  VERIFICATION_REQUEST_KEY_PATTERN,
} from "./core/verification-refresh.js";
export type {
  VerificationRefreshIssueRead,
  VerificationRefreshIssueSource,
  VerificationRefreshExtractor,
  VerificationRefreshUnchanged,
  VerificationRefreshRestore,
  VerificationRefreshAdd,
  VerificationRefreshRetirement,
  VerificationRefreshDiff,
  VerificationRefreshDiffResult,
  VerificationRevisionIdInput,
  VerificationRequestKeyInput,
  IssueVerificationRefreshDeps,
  IssueVerificationRefreshInput,
  IssueVerificationRefreshOutcome,
  IssueVerificationRefreshRefusal,
  IssueVerificationRefreshReport,
} from "./core/verification-refresh.js";
// The task-scoped operator surface (issue #1042): slice A4 of
// docs/verification-amendment-contract.md §11 — the read-only effective-plan
// view, the operator-typed revision, and the append-only return to the
// unamended baseline, all over the shipped resolution and persistence slices.
export {
  describeTaskVerificationPlan,
  amendTaskVerification,
  resetTaskVerification,
  diffTaskVerificationReset,
  taskVerificationResetOperations,
} from "./core/verification-amend.js";
export type {
  TaskVerificationDeps,
  TaskVerificationViewInput,
  TaskVerificationViewOutcome,
  TaskVerificationViewRefusal,
  TaskVerificationPlanView,
  TaskVerificationReconciliation,
  TaskVerificationDrift,
  TaskVerificationAmendInput,
  TaskVerificationAmendOutcome,
  TaskVerificationAmendRefusal,
  TaskVerificationAmendReport,
  TaskVerificationResetInput,
  TaskVerificationResetOutcome,
  TaskVerificationResetResult,
  TaskVerificationResetDiff,
  TaskVerificationResetEntry,
} from "./core/verification-amend.js";
// Public reporting (issue #1044): slice A7 of
// docs/verification-amendment-contract.md §12.2 — the bounded work-item comment
// one applied revision publishes (keyed on `revisionId`, never on a run), and
// the run-summary projection the human gate states an amended plan through.
export {
  buildVerificationAmendmentComment,
  renderVerificationAmendmentComment,
  verificationAmendmentCommentIdempotencyKey,
  verificationAmendmentCommentMarker,
  verificationAmendmentPublicSlots,
  verificationAmendmentGateSummary,
  publicSafeVerificationAmendmentGateSummary,
  VERIFICATION_AMENDMENT_NAMES_WITHHELD_REASON,
  VERIFICATION_AMENDMENT_COMMENT_MARKER,
  VERIFICATION_AMENDMENT_COMMENT_PROJECTION,
  VERIFICATION_AMENDMENT_COMMENT_VERSION,
  VERIFICATION_RETIREMENT_NOT_A_PASS,
  VERIFICATION_EXECUTION_LAYER_NOT_YET_RUN,
  MAX_VERIFICATION_AMENDMENT_COMMENT_CHARS,
  MAX_VERIFICATION_AMENDMENT_LABEL_CHARS,
  MAX_VERIFICATION_AMENDMENT_LISTED_SLOTS,
  MAX_VERIFICATION_AMENDMENT_PUBLISHED_REASON_CHARS,
} from "./core/verification-amendment-publication.js";
export type {
  VerificationAmendmentComment,
  VerificationAmendmentCommentOperation,
  VerificationAmendmentGateSummary,
  VerificationAmendmentPlanLike,
  VerificationAmendmentPublicSlot,
} from "./core/verification-amendment-publication.js";
// Staged verification configuration (issue #1097): slice S2 of
// docs/staged-verification-contract.md §13 — the operator-owned
// `session.stagedVerification` block with its fail-closed load validation
// (§5.3, docs/project-verification-contract.md §3.2,
// docs/verification-evidence-validity-contract.md §7.3 rule 5), and the
// repository-owned, non-authorizing project file with its closed refusal table
// (docs/project-verification-contract.md §4). Load and validation only: no
// stage runs, no selection is computed, and the feature stays off unless an
// operator enables it.
export {
  validateStagedVerificationConfig,
  cloneStagedVerificationConfig,
  resolveStagedVerificationSettings,
  StagedVerificationConfigError,
  STAGED_VERIFICATION_SETTING_KEYS,
  DEFAULT_MAX_STAGE_RECOVERY_ATTEMPTS,
  MAX_STAGE_ENVIRONMENT_IDENTITY_CHARS,
  TEST_SUITE_ADAPTER_KINDS,
  TEST_SUITE_BINDING_KEYS,
  MAX_TEST_SUITE_REQUIREMENT_COMMAND_CHARS,
} from "./core/staged-verification-config.js";
export type {
  StagedVerificationConfig,
  StagedVerificationConfigRefusal,
  StagedVerificationSettingKey,
  ResolvedStagedVerificationSettings,
  TestSuiteAdapterKind,
  TestSuiteAdapterBinding,
  ResolvedTestSuiteBinding,
} from "./core/staged-verification-config.js";
// Changed-file / full-suite verification: the language-neutral test-file
// execution boundary and this repository's Jest adapter (issue #1152 —
// docs/changed-file-verification-contract.md §2 and §6). Explicit files or an
// explicit full run through the shipped command runner, per-file outcomes and
// the run-level trust, process, completeness and termination facts. No
// selection, result classification or routing.
export {
  TEST_OUTCOME_UNTRUSTED_REASONS,
  TestExecutionRequestError,
  isTestFileId,
  validateTestExecutionRequest,
  toTestFileId,
  testFileStepAbnormalEnd,
  assembleTestFileRun,
} from "./core/test-file-execution.js";
export type {
  TestExecutionMode,
  TestExecutionRequest,
  TestExecutionRequestRefusal,
  TestFileOutcome,
  ReportedTestFileOutcome,
  TestOutcomeUntrustedReason,
  TestOutcomeTrust,
  TestProcessResult,
  TestRunIncompleteReason,
  TestRunCompleteness,
  TestRunTermination,
  TestFileRunStepKind,
  TestFileRoot,
  TestFileInventoryRead,
  TestAdapterRunReport,
  TestFileAdapter,
  TestFileRunStepObservation,
  TestFileRunStepRecord,
  TestFileRunResult,
  AssembleTestFileRunInput,
} from "./core/test-file-execution.js";
export {
  jestTestFileAdapter,
  readJestDiscovery,
  readJestRunResult,
} from "./handlers/jest-test-adapter.js";
// Issue #1174: the Vitest adapter behind the same boundary.
export {
  VITEST_SUPPORTED_RANGE,
  vitestTestFileAdapter,
  vitestSuiteCommandRefusal,
  readVitestDiscovery,
  readVitestRunResult,
} from "./handlers/vitest-test-adapter.js";
export {
  MAX_TEST_FILE_RESULT_BYTES,
  testFileAdapterFor,
  discoverTestFiles,
  runTestFiles,
  runTestSuiteSetup,
} from "./handlers/test-file-runner.js";
export type {
  TestFileCommandOptions,
  TestFileDiscoveryResult,
  TestSuiteSetupResult,
} from "./handlers/test-file-runner.js";
// Issue #1153 — Stage 1 changed-file selection and the Issue's retained failing
// test files (docs/changed-file-verification-contract.md §2–§4). The Issue base
// is resolved once and recorded; the cumulative net change is read from Git
// without a fetch; Selected = changed runnable test files ∪ retained files; an
// unreadable input is `unavailable`, never empty. Only a trusted `failed` Stage
// 2 adds a retained file and nothing removes one. No result classification,
// routing or workflow transition.
export {
  MAX_TEST_FILE_ID_CHARS,
  MAX_STAGE_TEST_FILES,
  MAX_RETAINED_TEST_FILES,
  ISSUE_BASE_SOURCES,
  STAGE1_SELECTION_UNAVAILABLE_REASONS,
  TEST_STAGE_RESULTS,
  isPersistableTestFileId,
  isCommitSha,
  resolveIssueBase,
  deriveTestFileSelectionDigest,
  selectStage1TestFiles,
  stage1ExecutionPlan,
  deriveTestSuiteBindingDigest,
  buildTestStageRecord,
  issueBaseRecordProblem,
  persistedIssueBase,
  testStageRecordProblem,
  nextRetainedTestFiles,
  readRetainedTestFileSet,
} from "./core/changed-test-file-selection.js";
export type {
  IssueBaseSource,
  IssueBaseRecord,
  CommitRead,
  IssueBaseUnavailableReason,
  IssueBaseResolution,
  ResolveIssueBaseInput,
  CumulativePathChange,
  CumulativeChangeEntry,
  CumulativeChangeRead,
  RetainedTestFile,
  RetainedTestFilesRead,
  RetainedTestFileSet,
  TestFileSelectionReason,
  SelectedTestFile,
  Stage1SelectionUnavailableReason,
  KnownStage1TestSelection,
  Stage1TestSelection,
  SelectStage1TestFilesInput,
  Stage1ExecutionPlan,
  TestSuiteConfigurationInput,
  TestStageResult,
  TestFileOutcomeCounts,
  TestStageSelectionRecord,
  TestStageRecord,
  BuildTestStageRecordInput,
} from "./core/changed-test-file-selection.js";
export {
  MAX_CUMULATIVE_CHANGE_OUTPUT_BYTES,
  readIssueBranchStart,
  readCumulativeChange,
} from "./handlers/cumulative-test-change.js";
export type {
  CumulativeChangeOptions,
  IssueBranchStartOptions,
} from "./handlers/cumulative-test-change.js";
// Issue #1154: Stage 1 / Stage 2 routing and lane wiring.
export {
  classifyTestStageResult,
  declaresBoundTestSuiteCommand,
  describeTestStageRecord,
  fullSuiteRequirementDeclaration,
  openStageRunGuard,
  resolveTestSuiteSlot,
  routeStage1TestResult,
  routeStage2TestResult,
  stage1RecoveryOutcome,
  testSuiteRequirementDeclaration,
} from "./core/test-stage-routing.js";
export type {
  ClassifyTestStageResultInput,
  OpenStageRunGuard,
  Stage1TestRoute,
  Stage2TestRoute,
  TestStageClassification,
  TestSuiteSlotResolution,
} from "./core/test-stage-routing.js";
export {
  nonTestVerificationCommands,
  resolveTestStageContext,
  runStage1TestVerification,
  runStage2Tests,
  testStageFullSuiteRequirement,
} from "./handlers/test-stage-verification.js";
export type {
  ReadyTestStageContext,
  RunStage1TestsInput,
  Stage1TestRun,
  TestStageContext,
} from "./handlers/test-stage-verification.js";
// Common verification results (issue #1098): the per-check execution record and
// the command-outcome classification that fills it — pass, nonzero exit, spawn
// failure, timeout and signal — all derived from the shipped #934 classifiers
// and the shipped CommandRunner. No selection, no stage outcome, no transition,
// and no subprocess supervisor of its own. Issue #1155 removed the
// opaque-command result adapter, the structured result envelope and the
// per-check `membership` / `selectedBy` metadata with the group-selection
// policy and the project verification file that were their only consumers.
export {
  buildCheckExecutionRecord,
  classifyCheckExecution,
  checkOutputTail,
  deriveCheckCommandDigest,
  isExecutionCheckId,
  CHECK_NOT_RUN_KINDS,
  MAX_CHECK_TEXT_CHARS,
} from "./core/verification-result.js";
export type {
  CheckVerdict,
  CheckNotRunKind,
  CheckExecutionRecord,
  CheckExecutionRecordInput,
  CheckExecutionClassification,
  CommandExecutionObservation,
} from "./core/verification-result.js";
// Durable stage state (issue #1099): the persistence half of
// docs/staged-verification-contract.md §13's S4 — the stage run ordinal and its
// launch identity written before launch, the §6.2 evidence bundle written at
// the end, and #1094 §6.3's R1/R3/R4 retention expressed as the shape itself.
// One task-context key under the shipped `completePhaseWithEffects` CAS: no new
// store, no new table, and a seam for a later slice's grant to ride the same
// transaction. Recording is idempotent on the stage run id, an allocation with
// no bundle reads as an interrupted run that credits nothing, and a task that
// predates the feature reads as "no stage has run" with nothing backfilled.
// Nothing selects, executes, routes or grants: no shipped call site reads this
// key yet.
export {
  STAGED_VERIFICATION_CONTEXT_KEY,
  STAGED_VERIFICATION_STATE_VERSION,
  STAGED_VERIFICATION_LEGACY_STATE_VERSION,
  retainedTestFilesRead,
  STAGE_RUN_ALLOCATED_EVENT,
  STAGE_RUN_RECORDED_EVENT,
  STAGE_IDS,
  STAGE_OUTCOMES,
  STAGE_IDENTITY_COMPONENTS,
  VERIFICATION_LANES,
  MAX_STAGE_RUN_LEDGER_ENTRIES,
  MAX_STAGE_ORDINAL_CURSORS,
  MAX_STAGE_BUNDLE_CHECKS,
  MAX_STAGE_TEXT_CHARS,
  stageRunKey,
  sameStageRunId,
  unknownIdentityComponent,
  legacyStageEvidenceIdentity,
  deriveStageSelectionDigest,
  deriveStageBundleCompleteness,
  latestStageBundle,
  lastPassedFinalBundle,
  grantingFinalBundle,
  pendingStageRunInterruption,
  stageRunLedgerEntry,
  stageRunBundle,
  validateStagedVerificationState,
  readStagedVerificationState,
  allocateStageRun,
  recordStageRun,
} from "./core/staged-verification-state.js";
export type {
  StageId,
  StageOutcome,
  StageIdentityComponentName,
  VerificationLane,
  IdentityComponent,
  StageEvidenceIdentity,
  StageRunId,
  StageSelectionRecord,
  StageRunResult,
  StageRunResultInput,
  StageRunLedgerEntry,
  StageOrdinalCursor,
  StagedVerificationState,
  StagedVerificationStateValidation,
  StagedVerificationStateRead,
  StagedVerificationStore,
  StagedVerificationRefusalReason,
  AllocateStageRunInput,
  AllocateStageRunOutcome,
  RecordStageRunInput,
  RecordStageRunOutcome,
} from "./core/staged-verification-state.js";
// Issue #1100 — stage evidence validity: `docs/verification-evidence-validity-contract.md`
// §4's matching law and the components a comparison is made of. Two identities
// match iff all seven components match, `none` matches `none`, and `unknown`
// matches nothing including another `unknown` — so a moved head, an amended
// plan, a changed working tree, a drifted session baseline, a different applied
// selection policy or a moved environment declaration all make earlier evidence
// inadmissible, and a legacy all-`unknown` bundle is admissible for nothing.
// The two uses are #1094 §4.4's final-stage reuse and §8's grant binding;
// invalidation deletes nothing. The plan-side components are derived from the
// shipped #1037 checkpoint and reconciliation rather than from a second notion
// of "the plan changed", and the environment component is derived from declared
// sources only — nothing here scans, probes or interprets a path. Pure: no
// shipped call site resolves an identity or admits a bundle yet.
export {
  STAGE_IDENTITY_MISMATCH_KINDS,
  STAGE_EVIDENCE_REFUSALS,
  WORKING_TREE_CLEAN_VALUE,
  WORKING_TREE_ABSENT_CONTENT_SENTINEL,
  valueIdentityComponent,
  noneIdentityComponent,
  matchIdentityComponent,
  compareStageEvidenceIdentity,
  stageEvidenceIdentityMatches,
  admitStageEvidence,
  evaluateFinalStageReuse,
  evaluateFinalGrantBinding,
  deriveTestedRevisionComponent,
  deriveWorkingTreeStateComponent,
  finalStageWorktreeIsClean,
  deriveAmendmentIdentityComponents,
  deriveEnvironmentIdentityComponent,
  STAGE1_TEST_EVIDENCE_REFUSALS,
  evaluateStage1TestEvidenceReuse,
  deriveTestSuitePolicyComponent,
} from "./core/stage-evidence-validity.js";
export type {
  Stage1TestEvidenceRefusalReason,
  Stage1TestEvidenceRefusal,
  Stage1TestEvidenceReuseInput,
  Stage1TestEvidenceReuse,
  TestSuiteConfigurationResolution,
  IdentityComponentState,
  StageIdentityMismatchKind,
  StageIdentityMismatch,
  StageIdentityComparison,
  StageEvidenceRefusalReason,
  StageEvidenceRefusal,
  StageEvidenceUse,
  StageEvidenceExpectation,
  StageEvidenceAdmissionInput,
  StageEvidenceAdmission,
  StageEvidenceCandidateRefusal,
  FinalStageReuseInput,
  FinalStageReuseDecision,
  FinalGrantBindingInput,
  FinalGrantBinding,
  WorkingTreeEntry,
  WorkingTreeEntryContent,
  WorkingTreeListing,
  LiveSessionBaseline,
  AmendmentIdentityInput,
  DeclaredEnvironmentSource,
  EnvironmentIdentityInput,
} from "./core/stage-evidence-validity.js";
// Issue #1155 deleted `core/stage-selection.ts` outright — the selection port,
// its wire protocol and admission rules, the ordered five-set loop union, the
// `selectable` / `finalOnly` membership and the effective selectable set — with
// the group-selection policy they implemented. What survives is the required
// set itself, exported from `core/stage-run.ts` below: a stage runs all of it.
// Staged verification: one stage run's aggregate judgment and its bundle
// (issue #1102 — `docs/staged-verification-contract.md` §6.1's outcome
// precedence with its accounted-absence table, §4.3's proven projection and
// §6.2 rule 6's evidence-bound requirement verdicts, the assembly of #1099's
// bundle over both, and §10 rule 5's bounded public projection). Pure: the
// per-check verdict stays #1098's, the selection stays #1101's, and the one
// host-versus-change judgment is the shipped #934/#897 classifiers', read
// once. The `loop` stage reaches the implementation lane through
// `handlers/stage-verification.ts`; nothing here grants, and no final stage
// runs yet.
export {
  STAGE_OUTCOME_PRECEDENCE,
  stageCheckHostFailure,
  aggregateStageOutcome,
  provenExecutionProjection,
  requirementSatisfierMap,
  deriveStageRequirementRecords,
  buildStageRunResultInput,
  summarizeStageRun,
  passedStageCheckNames,
  requiredSlotsByCheckId,
  requiredStageChecks,
  requiredStageSelection,
  stageCheckTerminationUnconfirmed,
} from "./core/stage-run.js";
export type {
  RequiredStageSelection,
  StageCheckSelection,
  StageOutcomeContribution,
  StageCheckOutcome,
  StageCheckContribution,
  StageOutcomeAggregation,
  AggregateStageOutcomeInput,
  StageRequirementDerivationInput,
  StageRequirementDerivation,
  BuildStageRunResultInput,
  StageRunAssembly,
  StageRunSummary,
  StageRunSummaryCheck,
} from "./core/stage-run.js";
// Staged verification: the `final` stage's §7 rows 7–13 and the stack-ready
// grant's row-7 precondition (issue #1103 — `docs/staged-verification-contract.md`
// §13 slices S9 and S10). Pure: the review lane runs the stage through
// `handlers/stage-verification.ts`, and `enqueueStatusLabelEffects` reads
// `decideStackReadyPublication` over the context of the same completion
// transaction, so the grant and the evidence behind it commit together.
export {
  FINAL_STAGE_GRANT_CONTEXT_KEY,
  FINAL_STAGE_VERIFICATION_CONTEXT_KEY,
  routeFinalStageBundle,
  decideStackReadyPublication,
} from "./core/final-stage-gate.js";
export type {
  FinalStageGrantMarker,
  FinalStageRow,
  FinalStageDisposition,
  FinalStageRoute,
  StackReadyWithholdReason,
  StackReadyPublication,
  StackReadyPublicationInput,
} from "./core/final-stage-gate.js";
// Staged verification: the operator stage view `admin task-verification show`
// prints (issue #1107 — `docs/staged-verification-contract.md` §10 rule 6, slice
// S11). Pure and read-only over the retained stage state.
export {
  STAGED_VERIFICATION_PROGRESS_MEANING,
  describeStagedVerificationStatus,
  hasStagedVerificationSurface,
} from "./core/staged-verification-status.js";
export type {
  StagedVerificationProgress,
  StageCheckView,
  StageBundleView,
  StagedVerificationStatusView,
  DescribeStagedVerificationStatusInput,
} from "./core/staged-verification-status.js";
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
// Agent runtime profile catalog (issue #904, slice B1 of
// docs/agent-runtime-profiles-contract.md §14.1). Data and validation only —
// no lane resolves through it yet.
export {
  QUALITY_LEVELS,
  AGENT_PROFILE_SETTING_KEYS,
  AGENT_PROFILE_REFUSAL_REASONS,
  AGENT_PROFILE_CATALOG_SCHEMA_VERSION,
  AGENT_PROFILES_FILENAME,
  AGENT_PROFILES_FILE_ENV,
  AGENT_PROFILE_REFRESH_SOURCES,
  BUILT_IN_AGENT_PROFILE_CATALOG,
  AgentProfileCatalogError,
  defaultAgentProfilesDir,
  resolveAgentProfilesPath,
  loadAgentProfileCatalog,
  buildEffectiveAgentProfileCatalog,
  parseAgentProfileCatalogDocument,
  providerCatalogFor,
  lookupQualityBinding,
} from "./core/agent-profile-catalog.js";
export type {
  QualityLevel,
  AgentProfileSettingKey,
  AgentProfileRefusalReason,
  AgentProfileRefreshSource,
  AgentProfileRefreshRecord,
  CatalogValueSource,
  CatalogSource,
  AgentProfilesPathSource,
  CapabilityDeclaration,
  AgentProfileSettingsDocument,
  AgentProfileProviderDocument,
  AgentProfileCatalogDocument,
  EffectiveProfileSettings,
  EffectiveRuntimeProfile,
  EffectiveQualityBinding,
  EffectiveProviderCatalog,
  EffectiveAgentProfileCatalog,
  AgentProfilesPathResolution,
  AgentProfilesPathOptions,
  LoadAgentProfileCatalogOptions,
  BuildEffectiveCatalogOptions,
} from "./core/agent-profile-catalog.js";
// Agent profile refresh planning (issue #914, §11.6 of
// docs/agent-runtime-profiles-contract.md). Pure comparison of the operator
// overlay against the release's recommended catalog and injected discovery
// facts; `admin agent-profile refresh` is the surface that spawns and writes.
export {
  AGENT_PROFILE_REFRESH_FINDING_KINDS,
  planAgentProfileRefresh,
} from "./core/agent-profile-refresh.js";
export type {
  AgentProfileRefreshFindingKind,
  AgentProfileRefreshDisposition,
  AgentProfileRefreshFinding,
  AgentProfileRefreshChange,
  AgentProfileModelInventorySource,
  AgentProfileRefreshModelListing,
  AgentProfileRefreshDiscoveryFacts,
  AgentProfileRefreshProviderReport,
  PlanAgentProfileRefreshInput,
  AgentProfileRefreshPlan,
} from "./core/agent-profile-refresh.js";
// Provider-neutral quality resolution (issue #905, slice B2 of
// docs/agent-runtime-profiles-contract.md §14.1). Resolution and the intake
// snapshot only — no lane consumes the resolved request yet.
export {
  QUALITY_CONTEXT_KEY,
  QUALITY_PIN_CONTEXT_KEY,
  QUALITY_LABEL_PREFIX,
  QUALITY_SOURCES,
  PHASE_CLASSES,
  DEFAULT_REQUESTED_QUALITY,
  REVIEW_LOOP_ESCALATION_QUALITY,
  AgentQualityError,
  isQualityLevel,
  qualityRank,
  compareQuality,
  strongerQuality,
  phaseClassForPhase,
  phaseClassForDisputeTurn,
  resolveRequestedQuality,
  applyQualityEscalation,
  readResolvedQuality,
  readQualityPin,
  qualityForPhase,
  qualityForPhaseClass,
} from "./core/agent-quality.js";
export type {
  PhaseClass,
  QualitySource,
  EffectiveQualitySource,
  RequestedQuality,
  ResolvedTaskQuality,
  QualityPin,
  QualitySessionView,
  ResolveRequestedQualityInput,
  EffectiveQuality,
  QualityForPhaseOptions,
} from "./core/agent-quality.js";
// Agent runtime adapter contract and provider registry (issue #906, the
// boundary piece of slice B3 of docs/agent-runtime-profiles-contract.md
// §14.1). Contract, registry, resolution engine, and sanitation gate only —
// the adapters that plug into it are exported separately below, and no lane
// invokes through the boundary yet.
export {
  RUNTIME_SETTING_SOURCES,
  RUNTIME_PROFILE_SOURCES,
  PROMPT_DELIVERIES,
  BUDGET_APPLICATIONS,
  AGENT_RUNTIME_DISCOVERY_STATUSES,
  INVOCATION_PROTECTED_ENV_KEYS,
  RUNTIME_PROFILE_PIN_CONTEXT_KEY,
  AgentRuntimeAdapterError,
  AgentRuntimeContractViolationError,
  isAgentRuntimeConfigurationError,
  isAgentProfileRefusalReason,
  createAgentRuntimeAdapterRegistry,
  resolveAgentRuntime,
  planAgentInvocation,
  assertSanitizedInvocationPlan,
  interpretDiscoveryProbe,
  readRuntimeProfilePin,
  sessionPinnedProfileFor,
} from "./core/agent-runtime-adapter.js";
export type {
  RuntimeSettingSource,
  RuntimeProfileSource,
  PromptDelivery,
  BudgetApplication,
  AgentRuntimeDiscoveryStatus,
  EnvOverridableSettingKey,
  AgentRuntimeEnvOverride,
  AgentRuntimeDiscoverySpec,
  AgentRuntimeAdapter,
  AgentRuntimeAdapterRegistry,
  CreateAgentRuntimeAdapterRegistryOptions,
  ResolvedRuntimeSetting,
  ResolvedRuntimeBinary,
  ResolvedAgentRuntime,
  ResolveAgentRuntimeInput,
  AgentInvocationRequest,
  AgentInvocationPlan,
  PlannedAgentInvocation,
  AgentRuntimeDiscovery,
  AgentRuntimeSessionPinsView,
} from "./core/agent-runtime-adapter.js";
// The Claude runtime profile adapter (issue #907) — the `anthropic` entry of
// slice B3's provider adapters. It declares the provider's break-glass
// variables, the four Claude invocation lanes with their tool boundaries, and
// the pre-invocation validation gate; the model/effort/budget values it splices
// in come from the boundary above. Registered by a composition root, consumed
// by no lane yet: each lane's cutover carries its own §10.3 before/after table.
export {
  CLAUDE_PROVIDER,
  CLAUDE_DEFAULT_BINARY,
  CLAUDE_ENV_OVERRIDES,
  CLAUDE_IMPLEMENTATION_ALLOWED_TOOLS,
  CLAUDE_CONFLICT_RESOLUTION_ALLOWED_TOOLS,
  CLAUDE_NO_TOOLS_ARGS,
  CLAUDE_LANES,
  CLAUDE_LANE_SPECS,
  CLAUDE_DISCOVERY,
  CLAUDE_RUNTIME_ADAPTER,
  createClaudeRuntimeAdapter,
  isClaudeLane,
} from "./core/claude-runtime-adapter.js";
export type { ClaudeLane, ClaudeLaneSpec } from "./core/claude-runtime-adapter.js";
// The Codex runtime profile adapter (issue #908) — the `openai` entry of slice
// B3's provider adapters. It declares the provider's two break-glass variables,
// the four Codex invocation lanes with their subcommands and sandbox postures,
// the one global-options-before-the-subcommand ordering rule every Codex lane
// follows, and the pre-invocation validation gate; the model/effort values it
// splices in come from the boundary above, and the accepted reasoning-effort
// values come from the catalog's capability descriptor rather than from any
// ceiling restated here. Registered by a composition root, consumed by no lane
// yet: each lane's cutover carries its own §10.3 before/after table.
export {
  CODEX_PROVIDER,
  CODEX_DEFAULT_BINARY,
  CODEX_ENV_OVERRIDES,
  CODEX_EXEC_ARGS,
  CODEX_REVIEW_ARGS,
  CODEX_READ_BOUNDED_EXEC_ARGS,
  CODEX_STRUCTURED_EXEC_ARGS,
  CODEX_LANES,
  CODEX_LANE_SPECS,
  CODEX_DISCOVERY,
  CODEX_RUNTIME_ADAPTER,
  codexInvocationRequest,
  createCodexRuntimeAdapter,
  describeCodexRuntime,
  isCodexLane,
} from "./core/codex-runtime-adapter.js";
export type {
  CodexLane,
  CodexLaneSpec,
  CodexLaneOutputPaths,
  CodexLaneInputs,
  CodexContextModeForm,
  CodexInvocationRequest,
  CodexRuntimeDescription,
} from "./core/codex-runtime-adapter.js";
// The Gemini/Antigravity runtime profile adapter (issue #909) — the `google`
// entry of slice B3's provider adapters, and the last of the three. It declares
// the provider's one break-glass variable (`ANTIGRAVITY_BIN`, the only
// inventoried variable that names a binary), the shipped `agy` invocation shape
// with its `--print` operand, the two prompt transports the lanes use, the
// `printTimeout` provider option, and a capability probe whose failure is
// reported in its own vocabulary so it can never read as an unavailable agent.
// This provider folds reasoning effort into the model display name, so the
// adapter emits no effort flag and refuses one that resolved. Registered by a
// composition root, consumed by no lane yet: each lane's cutover carries its own
// §10.3 before/after table.
export {
  ANTIGRAVITY_PROVIDER,
  ANTIGRAVITY_DEFAULT_BINARY,
  ANTIGRAVITY_ENV_OVERRIDES,
  ANTIGRAVITY_PRINT_TIMEOUT_OPTION,
  ANTIGRAVITY_PRINT_OPERAND,
  ANTIGRAVITY_LANES,
  ANTIGRAVITY_LANE_SPECS,
  ANTIGRAVITY_DISCOVERY,
  ANTIGRAVITY_MODELS_PROBE,
  ANTIGRAVITY_MODELS_PROBE_TIMEOUT_MS,
  ANTIGRAVITY_MAX_DISCOVERED_MODELS,
  ANTIGRAVITY_MODEL_DISCOVERY_STATUSES,
  ANTIGRAVITY_RUNTIME_ADAPTER,
  antigravityInvocationRequest,
  createAntigravityRuntimeAdapter,
  describeAntigravityRuntime,
  interpretAntigravityModelsProbe,
  isAntigravityLane,
} from "./core/antigravity-runtime-adapter.js";
export type {
  AntigravityLane,
  AntigravityLaneSpec,
  AntigravityLaneInputs,
  AntigravityInvocationRequest,
  AntigravityModelProbeSpec,
  AntigravityModelDiscovery,
  AntigravityModelDiscoveryStatus,
  AntigravityRuntimeDescription,
  DescribeAntigravityRuntimeProbes,
} from "./core/antigravity-runtime-adapter.js";
// The agent runtime audit record (issue #910) — slice B4 of
// docs/agent-runtime-profiles-contract.md §14.1, the §13 observability half of
// the contract. One provider-neutral record shape for every provider: the
// semantic request and the concrete settings together, each value with its own
// source, the catalog schema/version/digest that answered, the discovered CLI
// version, and the resolution's timing — plus the bounded task-context trail,
// the task-event payload, the run-artifact bytes, and the sanitized public
// one-liner. Nothing here decides a setting, and no lane resolves through the
// boundary yet, so no run produces a record until a lane cuts over.
export {
  AGENT_RUNTIME_AUDIT_RECORD_VERSION,
  AGENT_RUNTIME_AUDIT_CONTEXT_KEY,
  AGENT_RUNTIME_RESOLVED_EVENT,
  AGENT_RUNTIME_AUDIT_ARTIFACT_FILENAME,
  MAX_AGENT_RUNTIME_AUDIT_RECORDS,
  MAX_AGENT_RUNTIME_AUDIT_VALUE_CHARS,
  MAX_AGENT_RUNTIME_AUDIT_PROVIDER_OPTIONS,
  MAX_AGENT_RUNTIME_CLI_VERSION_CHARS,
  MAX_AGENT_RUNTIME_PUBLIC_SUMMARY_CHARS,
  buildAgentRuntimeAuditRecord,
  agentRuntimeAuditEventData,
  serializeAgentRuntimeAuditRecord,
  appendAgentRuntimeAuditRecord,
  readAgentRuntimeAuditLog,
  latestAgentRuntimeAuditRecord,
  publicAgentRuntimeSummary,
} from "./core/agent-runtime-audit.js";
export type {
  AgentRuntimeAuditRecord,
  BuildAgentRuntimeAuditRecordInput,
  PersistedAgentRuntimeAuditLog,
  AgentRuntimeAuditLog,
  AppendAgentRuntimeAuditRecordOptions,
  PublicAgentRuntimeSummaryOptions,
} from "./core/agent-runtime-audit.js";
