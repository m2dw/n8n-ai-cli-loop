/**
 * One bounded ChatOps scan/dispatch/publish pass (issue #1024).
 *
 * This is the runtime the component contracts were written for. Every decision
 * it makes is delegated to a pure core module — it owns no policy of its own:
 *
 *   scan            src/core/chatops-comment-port.ts + chatops-comment-cursor.ts
 *   reconcile       src/core/chatops-execution-ledger.ts (§10, §11)
 *   recognize       src/core/chatops-command.ts (#777)
 *   map             src/core/chatops-operation-mapping.ts (#784)
 *   dispatch        src/core/operation-port.ts + chatops-operation-dispatch.ts (#783)
 *   publish         src/core/chatops-result.ts (#785)
 *
 * What this module *does* own is ordering and durability: which local
 * transaction wraps which external effect
 * (`docs/chatops-execution-ledger-contract.md` §8). The order is not
 * negotiable and every deviation is a duplicate-execution bug:
 *
 *   T2 (write-ahead) → epoch witness → post claim marker → invoke operation
 *   → T3 (outcome commit, carrying the summary effect) → post ack marker
 *   → T4 (publication commit)
 *
 * The claim marker is posted *before* the operation and its success confirmed,
 * because the absence of a claim marker over a complete, quiesced window is the
 * only negative evidence this system has — it is what row 9's automatic retry
 * rests on. Posting it after, or fire-and-forget, would destroy that evidence.
 *
 * "Bounded" is structural: one pass reads each issue's comment list to its end
 * once, dispatches at most `chatOps.maxDispatchesPerPass` commands, and returns.
 * It never polls, never sleeps, and never loops waiting for a state change.
 */

import {
  CHATOPS_MAX_DISPATCH_ATTEMPTS,
  applyChatOpsLedgerEvent,
  assessChatOpsLedgerEpoch,
  chatOpsEvidenceTargetResolver,
  chatOpsReconciliationSinceBound,
  collectChatOpsExecutionEvidence,
  reconcileChatOpsLedgerScope,
  sameChatOpsLedgerVersion,
} from "../core/chatops-execution-ledger.js";
import type {
  ChatOpsLedgerEvent,
  ChatOpsLedgerHandoffReason,
  ChatOpsLedgerRow,
  ChatOpsLedgerTransition,
} from "../core/chatops-execution-ledger.js";
import {
  buildChatOpsFirstSeenRecord,
  chatOpsScanSinceBound,
  compareChatOpsCommentOrderKeys,
  deriveChatOpsCommentOrderKey,
  evaluateChatOpsScanWindow,
  planChatOpsBootstrap,
  selectChatOpsCandidates,
} from "../core/chatops-comment-cursor.js";
import type {
  ChatOpsCommentOrderKey,
  ChatOpsCursorState,
  ChatOpsFirstSeenRecord,
  ChatOpsScanWindowComplete,
} from "../core/chatops-comment-cursor.js";
import {
  isAuthenticatedChatOpsMarker,
  parseChatOpsMarkerBody,
  recognizeChatOpsComment,
} from "../core/chatops-command.js";
import type { ChatOpsCommand, ChatOpsTrustConfig } from "../core/chatops-command.js";
import { fetchChatOpsScanPages } from "../core/chatops-comment-port.js";
import type { ChatOpsCommentPort, ChatOpsPostResult } from "../core/chatops-comment-port.js";
import { chatOpsIdentityKey } from "../core/chatops-identity.js";
import type { ChatOpsProviderIdentity } from "../core/chatops-identity.js";
import {
  CHATOPS_OPERATION_MAPPING_TABLE,
  mapChatOpsCommandToOperationRequest,
} from "../core/chatops-operation-mapping.js";
import type { ChatOpsOperationMappingTable } from "../core/chatops-operation-mapping.js";
import {
  chatOpsDispatchDisposition,
  chatOpsOperationContext,
  chatOpsOperationRequestId,
} from "../core/chatops-operation-dispatch.js";
import type { ChatOpsDispatchAttempt } from "../core/chatops-operation-dispatch.js";
import { invokeOperation } from "../core/operation-port.js";
import type {
  OperationParamValue,
  OperationRegistry,
  OperationResult,
} from "../core/operation-port.js";
import {
  chatOpsDispatchResultOutcome,
  chatOpsHandoffOutcome,
  chatOpsLedgerDisposition,
  chatOpsMarkerBody,
  chatOpsReconciledFromMarkerOutcome,
  chatOpsRetryBudgetExhaustedOutcome,
  chatOpsUndispatchedOutcome,
  renderChatOpsHandoffCorrectionComment,
  renderChatOpsSummaryComment,
} from "../core/chatops-result.js";
import type {
  ChatOpsAuditRecord,
  ChatOpsPublicOutcome,
  ChatOpsUndispatchedReason,
} from "../core/chatops-result.js";
import {
  chatOpsEpochWitnessPath,
  readChatOpsEpochWitness,
  writeChatOpsEpochWitness,
} from "../core/chatops-epoch-witness.js";
import type { ChatOpsCommitInput, ChatOpsScope, ChatOpsStore } from "../core/chatops-store.js";
import { makeOutboxKey } from "../core/outbox.js";
import type { OutboxEnqueueInput, WorkItemCommentPayload } from "../core/outbox.js";
import { DEFAULT_COMMENT_MAX_CHARS, enforceCommentVisibility } from "../core/outbox-visibility.js";
import { sessionRedactionPaths } from "../core/outbox-effects.js";
import type { ResolvedSession } from "../core/session.js";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * The five operator-visible dispositions of one pass, plus `disabled`.
 *
 * Deliberately coarser than `ChatOpsResultKind` (`docs/chatops-result-contract.md`
 * §3): that vocabulary describes what happened to *one command*, this one
 * describes what an n8n step should do next. `delayed` means "call again";
 * `failed` means "a human must look".
 */
export type ChatOpsPassOutcome =
  | "disabled"
  | "idle"
  | "processed"
  | "refused"
  | "delayed"
  | "failed";

/** A fence as a pass reports it: the contract reason, plus bounded detail. */
export interface ChatOpsFenceNotice {
  reason: ChatOpsLedgerHandoffReason;
  detail: string | null;
}

/** What one pass did to one work item. */
export interface ChatOpsIssuePassResult {
  issueNumber: number;
  outcome: ChatOpsPassOutcome;
  /** Whether this pass initialized the scope, recording pre-existing comments without running them. */
  bootstrapped: boolean;
  /** Pre-existing comments that looked like commands and were deliberately not run (§8). */
  bootstrapSkipped: number;
  /** Newly discovered comments this pass wrote a ledger row for. */
  candidates: number;
  /** Candidates refused before any dispatch (§4.1). */
  refused: number;
  /** Candidates that reached `claimed` — recognized, authorized, and mapped. */
  claimed: number;
  /** Dispatch attempts this pass began (T2 committed). */
  dispatchAttempts: number;
  /** Dispatch attempts that produced a definite result (T3 committed). */
  dispatchResults: number;
  /** Acknowledgement markers published this pass (row 17). */
  acknowledged: number;
  /** Whether the scope is fenced, and why. */
  fenced: ChatOpsFenceNotice | null;
  /** Bounded, operator-facing notes. Never a comment body. */
  notes: string[];
}

/** What one pass did, across every work item in scope. */
export interface ChatOpsPassResult {
  outcome: ChatOpsPassOutcome;
  sessionId: string;
  /**
   * The scope this pass ran under. `null` only for a `disabled` result whose
   * session has no derivable ChatOps identity at all (an unsupported work-item
   * provider, contract §3): a pass that runs always has one.
   */
  identity: {
    provider: string;
    providerEndpoint: string;
    providerOwner: string;
    providerRepo: string;
  } | null;
  epoch: {
    database: number;
    witness: number | null;
    verdict: string;
    detail: string;
  };
  issues: ChatOpsIssuePassResult[];
  notes: string[];
}

export interface ChatOpsPassDeps {
  session: ResolvedSession;
  identity: ChatOpsProviderIdentity;
  store: ChatOpsStore;
  port: ChatOpsCommentPort;
  /**
   * The operations a ChatOps command may invoke.
   *
   * Injected rather than constructed here, because a descriptor is only
   * callable once someone hands its core the stores, lock and session it takes
   * by injection — facts a composition root holds
   * (`src/core/chatops-operations.ts` plus the entrypoint that opened them).
   * Issue #1031 registers both mapped Tool Request operations there, so an
   * authorized `/grant` or `/resolve` now executes the same guided run or
   * resolution `admin tool-request run` / `resolve` performs.
   *
   * A registry with no descriptor for a mapped verb remains an ordinary,
   * contract-defined state rather than a hole: the port answers `rejected` /
   * `unknown-operation`, which is definite and effect-free, and the ledger
   * acknowledges it like any other definite refusal. Nothing in this pass
   * special-cases either arrangement.
   */
  registry: OperationRegistry;
  /** Work items to scan. Bounded by the caller; one pass never discovers its own. */
  issueNumbers: readonly number[];
  mappingTable?: ChatOpsOperationMappingTable;
  /** Defaults to `chatOpsEpochWitnessPath(session.artifactRoot)`. */
  witnessPath?: string;
  /** Injected clock, so a crash-recovery decision is reproducible from its inputs. */
  now?: () => number;
  /** Raise-only override of the reconciliation quiescence delay (§10.4). */
  quiescenceMs?: number;
  maxScanPages?: number;
}

/** Default commands one pass dispatches before stopping; see {@link ChatOpsConfig}. */
export const DEFAULT_CHATOPS_MAX_DISPATCHES_PER_PASS = 5;

// ---------------------------------------------------------------------------
// Internal pass context
// ---------------------------------------------------------------------------

interface PassContext {
  session: ResolvedSession;
  identity: ChatOpsProviderIdentity;
  identityKey: string;
  trust: ChatOpsTrustConfig;
  store: ChatOpsStore;
  port: ChatOpsCommentPort;
  registry: OperationRegistry;
  table: ChatOpsOperationMappingTable;
  redactionPaths: string[];
  now: () => number;
  quiescenceMs: number | undefined;
  maxScanPages: number | undefined;
  witnessPath: string;
  /** Fenced for the whole session by the epoch witness (§9.2). */
  sessionEpochFence: { reason: ChatOpsLedgerHandoffReason; detail: string } | null;
  deadlineMs: number | null;
  /** Remaining dispatch budget for this pass, shared across work items. */
  dispatchBudget: number;
}

/** A mutable per-issue accumulator; `finishIssue` converts it into the result shape. */
interface IssueAccumulator extends ChatOpsIssuePassResult {
  sawDelay: boolean;
  sawHandoff: boolean;
}

function newAccumulator(issueNumber: number): IssueAccumulator {
  return {
    issueNumber,
    outcome: "idle",
    bootstrapped: false,
    bootstrapSkipped: 0,
    candidates: 0,
    refused: 0,
    claimed: 0,
    dispatchAttempts: 0,
    dispatchResults: 0,
    acknowledged: 0,
    fenced: null,
    notes: [],
    sawDelay: false,
    sawHandoff: false,
  };
}

/** Bound a note the same way the ledger bounds its own operator-facing detail. */
function note(acc: IssueAccumulator, text: string): void {
  if (acc.notes.length >= 32) return;
  acc.notes.push(text.length <= 300 ? text : `${text.slice(0, 300)}… (truncated)`);
}

/**
 * Collapse one issue's observations into a single disposition.
 *
 * Order matters and encodes severity: a human handoff outweighs a retry, a
 * retry outweighs progress, and progress outweighs "nothing happened". An
 * operator reading one word should get the most urgent true one.
 */
function finishIssue(acc: IssueAccumulator): ChatOpsIssuePassResult {
  let outcome: ChatOpsPassOutcome;
  if (acc.fenced !== null || acc.sawHandoff) outcome = "failed";
  else if (acc.sawDelay) outcome = "delayed";
  else if (acc.dispatchResults > 0 || acc.acknowledged > 0 || acc.dispatchAttempts > 0)
    outcome = "processed";
  else if (acc.refused > 0 || acc.bootstrapSkipped > 0) outcome = "refused";
  else outcome = "idle";
  return {
    issueNumber: acc.issueNumber,
    outcome,
    bootstrapped: acc.bootstrapped,
    bootstrapSkipped: acc.bootstrapSkipped,
    candidates: acc.candidates,
    refused: acc.refused,
    claimed: acc.claimed,
    dispatchAttempts: acc.dispatchAttempts,
    dispatchResults: acc.dispatchResults,
    acknowledged: acc.acknowledged,
    fenced: acc.fenced,
    notes: acc.notes,
  };
}

/** The most urgent disposition across every work item. */
function combineOutcomes(results: readonly ChatOpsIssuePassResult[]): ChatOpsPassOutcome {
  const order: ChatOpsPassOutcome[] = ["idle", "refused", "processed", "delayed", "failed"];
  let best = 0;
  for (const result of results) {
    const rank = order.indexOf(result.outcome);
    if (rank > best) best = rank;
  }
  return order[best];
}

// ---------------------------------------------------------------------------
// Publication helpers
// ---------------------------------------------------------------------------

/**
 * Build the outbox effect that delivers a summary comment (§5.1, §10.1).
 *
 * Rendered once, here, and enqueued in the same transaction as the transition
 * that produced the outcome — never recomputed on a delivery retry. The
 * idempotency key folds in the producing row number so a row that reaches a
 * second publishable outcome later (row 16 then row 21, say) enqueues a second
 * comment rather than silently deduping against the first.
 */
function summaryEffect(
  ctx: PassContext,
  issueNumber: number,
  commentId: string,
  row: number,
  outcome: ChatOpsPublicOutcome,
): OutboxEnqueueInput {
  return commentEffect(
    ctx,
    issueNumber,
    makeOutboxKey(
      ctx.identityKey,
      issueNumber,
      "chatops-summary",
      commentId,
      String(row),
    ),
    renderChatOpsSummaryComment(outcome),
  );
}

/** The handoff correction comment a row escalated or fenced out of `awaiting_ack` gets (§7.1). */
function handoffCorrectionEffect(
  ctx: PassContext,
  issueNumber: number,
  commentId: string,
  row: number,
  reason: ChatOpsLedgerHandoffReason,
): OutboxEnqueueInput {
  return commentEffect(
    ctx,
    issueNumber,
    makeOutboxKey(ctx.identityKey, issueNumber, "chatops-handoff", commentId, String(row)),
    renderChatOpsHandoffCorrectionComment(reason, ctx.redactionPaths),
  );
}

function commentEffect(
  ctx: PassContext,
  issueNumber: number,
  idempotencyKey: string,
  body: string,
): OutboxEnqueueInput {
  const payload: WorkItemCommentPayload = {
    topic: "workitem:comment",
    provider: ctx.identity.provider,
    owner: ctx.identity.providerOwner,
    repo: ctx.identity.providerRepo,
    issueNumber,
    // Bounded and path-stripped once more at the surface tier: the summary text
    // itself was already sanitized when the outcome was composed, and the fixed
    // header/reason lines carry nothing, so this is defense in depth rather than
    // a second policy.
    body: enforceCommentVisibility("work-item", body, {
      configuredPaths: ctx.redactionPaths,
      maxChars: DEFAULT_COMMENT_MAX_CHARS,
    }),
  };
  return { idempotencyKey, topic: "workitem:comment", payload };
}

/** An audit record for one disposition (§9). */
function auditRecord(
  ctx: PassContext,
  issueNumber: number,
  commentId: string,
  row: number,
  actorId: string,
  operationId: string | null,
  requestId: string | null,
  outcome: ChatOpsPublicOutcome,
): ChatOpsAuditRecord {
  return {
    requestId,
    surface: "chatops",
    actorId,
    operationId,
    ledgerScope: { identity: ctx.identityKey, issueNumber, commentId },
    row,
    kind: outcome.kind,
    dispatched: outcome.dispatched,
    reason: outcome.reason,
  };
}

// ---------------------------------------------------------------------------
// Recognition + mapping, replayed from immutable first-seen input
// ---------------------------------------------------------------------------

/** A recognized, mapped, dispatchable command, or the §4.1 reason it is not one. */
type CandidateVerdict =
  | {
      kind: "dispatchable";
      command: ChatOpsCommand;
      operationId: string;
      scope: "session" | "issue";
      params: Readonly<Record<string, OperationParamValue | readonly OperationParamValue[]>>;
    }
  | { kind: "refused"; reason: ChatOpsUndispatchedReason; detail?: string };

/**
 * Decide one comment's fate from its **immutable first-seen fields** (#777 §6,
 * #781 §9).
 *
 * Deliberately a pure function of the stored record rather than of a fresh
 * observation: a comment edited after it was first seen must produce the same
 * verdict on every pass, and re-reading a possibly-edited body is exactly how a
 * command's meaning could change between the claim and the dispatch. It is also
 * what lets a `claimed` row left behind by a crash re-derive its operation and
 * parameters without storing them a second time.
 *
 * Mapping is resolved here, before the caller writes T1's row-1-vs-row-2
 * decision — never afterwards (`docs/chatops-result-contract.md` §4.1,
 * invariant 13): the ledger has no `claimed → rejected` transition a
 * later-discovered mapping failure could use.
 */
function judgeCandidate(ctx: PassContext, record: ChatOpsFirstSeenRecord): CandidateVerdict {
  if (record.bootstrap) return { kind: "refused", reason: "bootstrap-backlog" };
  if (record.body === null) {
    // Over `MAX_CHATOPS_COMMENT_BODY_CHARS`, so `malformed` by grammar §10
    // regardless of content — which is why the body was never stored.
    return { kind: "refused", reason: "malformed" };
  }
  const comment = {
    author: record.author,
    body: record.body,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (isAuthenticatedChatOpsMarker(comment, ctx.trust.automationLogins)) {
    return { kind: "refused", reason: "marker-comment" };
  }
  const recognition = recognizeChatOpsComment(comment, ctx.trust, ctx.table.supportedVerbs());
  if (recognition.kind !== "command") {
    return { kind: "refused", reason: recognition.kind };
  }
  const mapped = mapChatOpsCommandToOperationRequest(recognition.command, ctx.table);
  if (mapped.kind === "unsupported-operation") {
    return { kind: "refused", reason: "unsupported-operation" };
  }
  if (mapped.kind === "invalid-argument") {
    return { kind: "refused", reason: "invalid-argument", detail: mapped.detail };
  }
  return {
    kind: "dispatchable",
    command: recognition.command,
    operationId: mapped.operationId,
    scope: mapped.scope,
    params: mapped.params,
  };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * The result a session with ChatOps switched off produces (#777 §5 gate 1).
 *
 * Exported because a caller must be able to answer `disabled` *before* it opens
 * a store or resolves any credential: `chatOps.enabled: false` is documented
 * (docs/chatops-operations.md §3, §8) as a total runtime no-op — no provider
 * read, no database write, no comment post — and a gate that only fires once
 * execution is already inside `runChatOpsPass` cannot deliver that, because
 * getting there means the store is already open. Keeping the payload here keeps
 * the two entries to the same state byte-identical.
 *
 * `identity` is null when the session's work-item provider has no defined
 * ChatOps identity at all (a `jira` session, contract §3). Being unable to name
 * the scope is not an error for a surface that is switched off — a rollback must
 * not turn provider-dependent.
 */
export function chatOpsDisabledResult(
  sessionId: string,
  identity: ChatOpsPassResult["identity"],
): ChatOpsPassResult {
  return {
    outcome: "disabled",
    sessionId,
    identity,
    epoch: { database: 0, witness: null, verdict: "not-assessed", detail: "chatOps is not enabled" },
    issues: [],
    notes: ["chatOps.enabled is not true for this session"],
  };
}

/**
 * The result a pass produces when the ChatOps database is under maintenance
 * (issue #818, `docs/retention-backup-contract.md` §9).
 *
 * Exported for the same reason {@link chatOpsDisabledResult} is: a caller that
 * can see the lock *before* it starts should report it without reading a single
 * comment from the provider. Every ChatOps write refuses while the lock is held,
 * so a pass that started anyway would spend the session's provider quota
 * scanning work items it could not record anything about, and then report the
 * same `delayed` this does.
 *
 * The check that actually enforces the exclusion is the one each store mutator
 * runs inside its own transaction; this is the fail-closed pre-check that turns
 * the common case into a clean idle run, exactly as `dispatch-outbox` does.
 */
export function chatOpsMaintenanceLockedResult(
  sessionId: string,
  identity: ChatOpsPassResult["identity"],
): ChatOpsPassResult {
  const detail =
    "a maintenance lock is held on the ChatOps database (see `admin maintenance-lock status`)";
  return {
    outcome: "delayed",
    sessionId,
    identity,
    epoch: { database: 0, witness: null, verdict: "not-assessed", detail },
    issues: [],
    notes: [
      `${detail}; nothing was scanned, dispatched, or published — run the pass ` +
        `again once maintenance releases it`,
    ],
  };
}

/**
 * Run one bounded pass.
 *
 * Never throws for a provider, ledger, or operation problem — every such event
 * becomes a typed disposition on the returned result, and a store refusing under
 * a maintenance lock is reported as `delayed` rather than propagated. It does
 * throw for a *configuration* defect (an identity that cannot be derived, login
 * lists that overlap), because those are refusals to start rather than outcomes
 * to record.
 */
export async function runChatOpsPass(deps: ChatOpsPassDeps): Promise<ChatOpsPassResult> {
  const { session } = deps;
  const chatOps = session.chatOps;
  const identityKey = chatOpsIdentityKey(deps.identity);
  const identityView = {
    provider: deps.identity.provider,
    providerEndpoint: deps.identity.providerEndpoint,
    providerOwner: deps.identity.providerOwner,
    providerRepo: deps.identity.providerRepo,
  };

  if (!chatOps?.enabled) {
    // Gate 1 (#777 §5): a disabled session performs no provider read, no
    // database write, and no comment post. Reporting the state is the whole
    // behavior.
    return chatOpsDisabledResult(session.sessionId, identityView);
  }

  const now = deps.now ?? (() => Date.now());
  const witnessPath = deps.witnessPath ?? chatOpsEpochWitnessPath(session.artifactRoot);
  const notes: string[] = [];

  // --- The epoch witness (§9.2) --------------------------------------------
  const dbEpoch = await deps.store.getEpoch(identityKey);
  const witnessRead = readChatOpsEpochWitness(witnessPath);
  const assessment =
    witnessRead.kind === "unreadable"
      ? {
          // An unreadable witness is not an absent one: something wrote a file
          // this code did not write, so the benign "no witness yet" branch has
          // not been earned. Fence rather than guess.
          verdict: "witness-missing" as const,
          fence: true,
          healWitness: false,
          handoffReason: "witness-missing" as ChatOpsLedgerHandoffReason,
          detail: witnessRead.detail,
        }
      : assessChatOpsLedgerEpoch(dbEpoch, witnessRead.kind === "present" ? witnessRead.epoch : null);

  if (assessment.healWitness) {
    const healed = writeChatOpsEpochWitness(witnessPath, dbEpoch);
    if (!healed.ok) notes.push(`epoch witness could not be rolled forward: ${healed.error}`);
  }

  const ctx: PassContext = {
    session,
    identity: deps.identity,
    identityKey,
    trust: {
      authorAllowlist: chatOps.authorAllowlist ?? [],
      automationLogins: chatOps.automationLogins ?? [],
    },
    store: deps.store,
    port: deps.port,
    registry: deps.registry,
    table: deps.mappingTable ?? CHATOPS_OPERATION_MAPPING_TABLE,
    redactionPaths: sessionRedactionPaths(session),
    now,
    quiescenceMs: deps.quiescenceMs,
    maxScanPages: deps.maxScanPages,
    witnessPath,
    sessionEpochFence: assessment.fence
      ? { reason: assessment.handoffReason ?? "restore-detected", detail: assessment.detail }
      : null,
    deadlineMs: chatOps.operationTimeoutMs ?? null,
    dispatchBudget: chatOps.maxDispatchesPerPass ?? DEFAULT_CHATOPS_MAX_DISPATCHES_PER_PASS,
  };

  if (ctx.sessionEpochFence) notes.push(assessment.detail);

  const issues: ChatOpsIssuePassResult[] = [];
  for (const issueNumber of deps.issueNumbers) {
    issues.push(await runIssuePass(ctx, issueNumber));
  }

  return {
    outcome: issues.length === 0 ? "idle" : combineOutcomes(issues),
    sessionId: session.sessionId,
    identity: identityView,
    epoch: {
      database: dbEpoch,
      witness: witnessRead.kind === "present" ? witnessRead.epoch : null,
      verdict: assessment.verdict,
      detail: assessment.detail,
    },
    issues,
    notes,
  };
}

/**
 * Whether an error is a store's maintenance-lock refusal
 * (`stores/maintenance-lock-guard.ts`, issue #818).
 *
 * Duck-typed on the stable `code` discriminator rather than by importing the
 * class, the same way `core/phase-runner.ts` does it: the store layer is a
 * detail of which `ChatOpsStore` a caller injected, and an in-memory fake must
 * be able to model contention without depending on SQLite.
 */
function isMaintenanceLockedError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "maintenance_locked"
  );
}

/**
 * One work item's pass, with a maintenance-lock refusal turned into a retryable
 * no-op (issue #818, `docs/retention-backup-contract.md` §9).
 *
 * A `prune`/`restore` can acquire the lock at any point, including between two
 * of this pass's own transactions, and every ChatOps write refuses while it is
 * held. That is not a ChatOps failure — nothing is wrong with the scope, the
 * command, or the provider — so it must not fence anything, must not be reported
 * as `failed`, and must not crash the scheduled step. `delayed` says exactly what
 * is true: the work item was not finished, and calling again once maintenance
 * releases the lock will finish it.
 *
 * Whatever the pass had already committed before the refusal stays committed and
 * is still reported in `acc`; what stops is everything after it. Ordering is what
 * makes that safe — the write-ahead precedes the claim marker and the operation,
 * so a refusal there means no external effect was attempted, and a refusal later
 * leaves a `dispatching` row that the next pass's reconciliation resolves from
 * provider evidence like any other interrupted attempt.
 */
async function runIssuePass(ctx: PassContext, issueNumber: number): Promise<ChatOpsIssuePassResult> {
  const acc = newAccumulator(issueNumber);
  try {
    return await scanIssue(ctx, issueNumber, acc);
  } catch (err) {
    if (!isMaintenanceLockedError(err)) throw err;
    note(
      acc,
      "database maintenance lock is held (prune/restore in progress): this work item was " +
        "left where it was; run the pass again once maintenance releases the lock",
    );
    acc.sawDelay = true;
    return finishIssue(acc);
  }
}

async function scanIssue(
  ctx: PassContext,
  issueNumber: number,
  acc: IssueAccumulator,
): Promise<ChatOpsIssuePassResult> {
  const scope: ChatOpsScope = { identityKey: ctx.identityKey, issueNumber };
  const state = await ctx.store.loadScope(scope);

  // A scope is fenced by its own regression fence, by a session-grain fence, or
  // by this pass's epoch assessment. All three bar new execution; none of them
  // bars discovery, marker publication, or reconciliation (§12).
  let fence = state.issueFence ?? state.sessionFence ?? null;
  if (fence === null && ctx.sessionEpochFence !== null) {
    fence = {
      reason: ctx.sessionEpochFence.reason,
      detail: ctx.sessionEpochFence.detail,
      fencedAt: new Date(ctx.now()).toISOString(),
    };
    // Persist the session-grain fence so clearing it is an explicit, recorded
    // operator action rather than something the next pass happens not to
    // re-derive (§12).
    await ctx.store.commit(scope, { fence: { grain: "session", record: fence } });
  }
  if (fence !== null) acc.fenced = { reason: fence.reason, detail: fence.detail };
  const fenced = fence !== null;

  // --- Scan (§5, §6, §10.5) ------------------------------------------------
  const cursorBound = chatOpsScanSinceBound(state.cursor.cursor);
  const since = chatOpsReconciliationSinceBound(state.rows, cursorBound);
  const fetched = await fetchChatOpsScanPages(ctx.port, issueNumber, since, {
    ...(ctx.maxScanPages === undefined ? {} : { maxPages: ctx.maxScanPages }),
  });
  const window = fetched.ok
    ? evaluateChatOpsScanWindow({
        cursor: state.cursor.cursor,
        initialized: state.cursor.initialized,
        pages: fetched.pages,
        ...(ctx.maxScanPages === undefined ? {} : { maxPages: ctx.maxScanPages }),
      })
    : fetched.incomplete;

  if (window.kind === "incomplete") {
    // Nothing advances: an incomplete window proves nothing about absence, so
    // no cursor, no first-seen record, and no candidate may be persisted (§11).
    // The one thing that does happen is that every open row's reconciliation
    // counter moves, which is what eventually surfaces a scope that can never
    // complete a scan instead of retrying it forever (§11.3, rows 12 and 13).
    note(acc, `scan incomplete (${window.reason}): ${window.detail}`);
    await applyInconclusiveReconciliation(ctx, scope, state.rows, acc, fenced);
    if (window.retryable) acc.sawDelay = true;
    else acc.sawHandoff = true;
    return finishIssue(acc);
  }

  const rowsById = new Map<string, ChatOpsLedgerRow>(state.rows.map((row) => [row.commentId, row]));
  const unsettledPublications = new Set(
    state.ackReservations.map((reservation) => reservation.commentId),
  );

  // --- T1: discovery commit (§8) -------------------------------------------
  // Deliberately *before* reconciliation. §11's regression predicate compares a
  // row's recorded `attempts` against the claim markers the provider shows, and
  // §11's row 24 fences on evidence naming a comment the ledger has never heard
  // of — so reconciling first would read a scope's own, correctly bootstrapped
  // backlog as orphan evidence and fence a first run that has nothing wrong with
  // it. Discovering first gives every comment in the window its row, after which
  // both detectors compare like with like: a genuine restore still fences,
  // because the comment it lost comes back as a fresh row with `attempts: 0`
  // while its claim marker is still on the issue (`claims > attempts`).
  const discovery = await commitDiscovery(ctx, scope, window, acc, fenced);
  for (const row of discovery.rows) rowsById.set(row.commentId, row);

  // --- Deferred claims a fenced pass could not write (§12, row 3) ----------
  if (!fenced && state.pendingFirstSeen.length > 0) {
    const recovered = await claimPending(ctx, scope, state.pendingFirstSeen, acc);
    for (const row of recovered) rowsById.set(row.commentId, row);
  }

  // --- Reconcile (§10, §11) ------------------------------------------------
  // Skipped on a bootstrap window, and only there. `docs/chatops-comment-cursor-contract.md`
  // §8 states the reason directly: a pre-existing comment's acknowledgement
  // markers "belong to a history this session never observed." Reading them as
  // evidence would fence every scope that is merely being enabled on an issue
  // ChatOps once ran on — while protecting nothing, since §8 already guarantees
  // no pre-existing comment is ever dispatched. A restore that erased the cursor
  // and produced this bootstrap is caught by the other detector instead: §9.2's
  // witness sees `dbEpoch` below a witness that survived, and fences the session.
  let fencedNow = fenced;
  if (!window.bootstrap) {
    const reconciled = await reconcileWindow(
      ctx,
      scope,
      window,
      [...rowsById.values()],
      acc,
      fenced,
    );
    for (const row of reconciled.rows) rowsById.set(row.commentId, row);
    fencedNow = fenced || reconciled.fenced;
    if (reconciled.fenced && acc.fenced === null && reconciled.fenceRecord) {
      acc.fenced = { reason: reconciled.fenceRecord.reason, detail: reconciled.fenceRecord.detail };
    }
  }

  // --- Dispatch (T2 → external effects → T3) -------------------------------
  if (!fencedNow) {
    await dispatchReadyRows(ctx, scope, rowsById, acc);
  } else {
    note(acc, "scope is fenced: no dispatch attempted");
  }

  // --- Publication (T4) ----------------------------------------------------
  // Runs even under a fence: the fence bars *new execution*, not the evidence
  // of execution that already happened. Suppressing a marker would blind the
  // very reconciliation the fence exists to protect (§11.4, §12).
  // The reservations read at the top of this pass, before it took any of its
  // own: an entry still here belongs to a pass that died mid-publication.
  await publishPendingAcks(ctx, scope, rowsById, unsettledPublications, acc);

  return finishIssue(acc);
}

/**
 * First-seen records for a bounded set of comment ids, resolved *before* a
 * reconciliation commit.
 *
 * Reconciliation decides inside the commit transaction (see
 * {@link ChatOpsStore.commitCompareAndSwap}) and that callback may not perform
 * I/O, so the one input a verdict's audit record needs beyond the ledger rows is
 * loaded up front. First-seen records are immutable once written (§8), so
 * loading them early costs nothing in freshness. An id the map does not carry —
 * a row an overlapping pass created from a comment outside this window — falls
 * back to §9.1's existing `unknown` actor, which weakens one audit field rather
 * than the decision.
 */
async function loadFirstSeenRecords(
  ctx: PassContext,
  scope: ChatOpsScope,
  commentIds: Iterable<string>,
): Promise<Map<string, ChatOpsFirstSeenRecord>> {
  const ids = [...new Set(commentIds)];
  const records = await Promise.all(ids.map((id) => ctx.store.getFirstSeen(scope, id)));
  const byId = new Map<string, ChatOpsFirstSeenRecord>();
  ids.forEach((id, index) => {
    const record = records[index];
    if (record) byId.set(id, record);
  });
  return byId;
}

/**
 * Bump every open row's inconclusive-reconciliation counter after a scan that
 * proved nothing (§11.3).
 *
 * Applies only to `dispatching` rows: those are the ones whose execution status
 * is open, and rows 12/13 are the only transitions an inconclusive verdict has.
 * Which rows those are is read inside the commit transaction, for the reason
 * {@link reconcileWindow} states.
 */
async function applyInconclusiveReconciliation(
  ctx: PassContext,
  scope: ChatOpsScope,
  rows: readonly ChatOpsLedgerRow[],
  acc: IssueAccumulator,
  fenced: boolean,
): Promise<void> {
  const firstSeen = await loadFirstSeenRecords(
    ctx,
    scope,
    rows.map((row) => row.commentId),
  );
  // Held in an object for the reason `dispatchRow`'s T2 states: `build` runs
  // inside the store's transaction, and a value a nested closure assigns is not
  // something the compiler can narrow afterwards.
  const seen = { handoff: false };
  await ctx.store.commitCompareAndSwap(scope, (persisted) => {
    seen.handoff = false;
    const updated: ChatOpsLedgerRow[] = [];
    const audit: ChatOpsAuditRecord[] = [];
    for (const row of persisted) {
      if (row.state !== "dispatching") continue;
      const transition = applyChatOpsLedgerEvent(
        row,
        { kind: "reconciled", verdict: { kind: "inconclusive", detail: "scan window incomplete" } },
        row.commentId,
        { fenced },
      );
      if (!transition.applied) continue;
      updated.push(transition.next);
      if (transition.next.state === "ambiguous") {
        seen.handoff = true;
        audit.push(
          handoffAudit(ctx, scope.issueNumber, transition, "reconcile-inconclusive", firstSeen),
        );
      }
    }
    return updated.length > 0 ? { rows: updated, audit } : null;
  });
  if (seen.handoff) acc.sawHandoff = true;
}

/** The audit record for a row that reached `ambiguous` without an operation result (§9.1). */
function handoffAudit(
  ctx: PassContext,
  issueNumber: number,
  transition: Extract<ChatOpsLedgerTransition, { applied: true }>,
  fallbackReason: ChatOpsLedgerHandoffReason,
  firstSeen: ReadonlyMap<string, ChatOpsFirstSeenRecord>,
): ChatOpsAuditRecord {
  const row = transition.next;
  const reason = row.handoff?.reason ?? fallbackReason;
  const outcome = chatOpsHandoffOutcome(reason, row.attempts, ctx.redactionPaths);
  const record = firstSeen.get(row.commentId);
  const verdict = record ? judgeCandidate(ctx, record) : null;
  return auditRecord(
    ctx,
    issueNumber,
    row.commentId,
    transition.row,
    record?.author ?? "unknown",
    verdict?.kind === "dispatchable" ? verdict.operationId : null,
    null,
    outcome,
  );
}

interface ReconcileResult {
  rows: readonly ChatOpsLedgerRow[];
  fenced: boolean;
  fenceRecord: { reason: ChatOpsLedgerHandoffReason; detail: string | null } | null;
}

/**
 * Reconcile every ledger row in the scope against one complete window's
 * authenticated evidence (§11), and commit whatever that produces.
 *
 * A regression fences the *entire* scope rather than the row that tripped it: a
 * restore does not roll back one row, so the one comment whose markers happened
 * to survive is a sample, not the extent of the damage.
 */
async function reconcileWindow(
  ctx: PassContext,
  scope: ChatOpsScope,
  window: ChatOpsScanWindowComplete,
  rows: readonly ChatOpsLedgerRow[],
  acc: IssueAccumulator,
  fenced: boolean,
): Promise<ReconcileResult> {
  // A marker's target frequently sits below the window (§10.1, §10.5), so the
  // first-seen table answers for it. Only the ids markers actually name are
  // loaded — resolving every comment in the scope would read the whole table
  // to answer a handful of questions.
  const targetIds = new Set<string>();
  for (const comment of window.comments) {
    if (!isAuthenticatedChatOpsMarker(comment, ctx.trust.automationLogins)) continue;
    const marker = parseChatOpsMarkerBody(comment.body);
    if (marker) targetIds.add(marker.commentId);
  }
  const targets = new Map<string, { createdAt: string }>();
  for (const id of targetIds) {
    const record = await ctx.store.getFirstSeen(scope, id);
    if (record) targets.set(id, { createdAt: record.createdAt });
  }
  const resolveTarget = chatOpsEvidenceTargetResolver(window.comments, (id) => targets.get(id) ?? null);
  const evidence = collectChatOpsExecutionEvidence(
    window.comments,
    ctx.trust.automationLogins,
    resolveTarget,
  );
  for (const defect of evidence.defects) {
    note(acc, `evidence defect (${defect.reason}): ${defect.detail}`);
  }

  // Everything from here decides from the ledger rows, so it decides *inside*
  // the commit transaction (see {@link ChatOpsStore.commitCompareAndSwap}).
  // An overlapping pass can write T2 — and post its claim marker — between this
  // pass's scan and its commit, and a verdict derived from the scan snapshot
  // would then be upserted over whatever that pass has since committed: a row it
  // dispatched and completed would be rewritten as `ambiguous` (row 11), which
  // later reconciliation skips, parking a finished command for manual recovery.
  // Re-deciding under the write lock means each verdict is applied to exactly
  // the state it was derived from. The two inputs that are *not* ledger rows —
  // the window's evidence, above, and the first-seen records an audit record
  // needs — are resolved first, because the callback may not perform I/O.
  const firstSeen = await loadFirstSeenRecords(ctx, scope, [
    ...rows.map((row) => row.commentId),
    ...window.comments.map((comment) => comment.id),
  ]);

  // Held in an object for the reason `dispatchRow`'s T2 states: `build` runs
  // inside the store's transaction, and a value a nested closure assigns is not
  // something the compiler can narrow afterwards. The observations are collected
  // rather than applied to `acc` directly so that a build which commits nothing
  // reports nothing.
  const seen: {
    result: ReconcileResult;
    notes: string[];
    handoff: boolean;
    delay: boolean;
  } = {
    result: { rows, fenced: false, fenceRecord: null },
    notes: [],
    handoff: false,
    delay: false,
  };

  await ctx.store.commitCompareAndSwap(scope, (persisted) => {
    seen.notes = [];
    seen.handoff = false;
    seen.delay = false;

    const reconciliation = reconcileChatOpsLedgerScope({
      rows: persisted,
      evidence,
      windowComplete: true,
      nowMs: ctx.now(),
      ...(ctx.quiescenceMs === undefined ? {} : { quiescenceMs: ctx.quiescenceMs }),
    });

    const updated: ChatOpsLedgerRow[] = [];
    const audit: ChatOpsAuditRecord[] = [];
    const effects: OutboxEnqueueInput[] = [];

    if (reconciliation.fence) {
      const reason = reconciliation.fenceReason ?? "ledger-regression";
      const detail = reconciliation.fenceDetail;
      seen.notes.push(`scope fenced (${reason}): ${detail ?? "no detail"}`);
      for (const orphan of reconciliation.orphanEvidence) {
        seen.notes.push(`orphan evidence names comment ${orphan}, which has no ledger row`);
      }
      const fenceEvent: ChatOpsLedgerEvent =
        detail === null ? { kind: "fence", reason } : { kind: "fence", reason, detail };
      for (const entry of reconciliation.rows) {
        const wasAwaitingAck = entry.row.state === "awaiting_ack";
        const transition = applyChatOpsLedgerEvent(entry.row, fenceEvent, entry.commentId, {
          fenced,
        });
        if (!transition.applied) {
          // A terminal or already-ambiguous row keeps its merged evidence; the
          // fence has nothing left to change about it.
          updated.push(entry.row);
          continue;
        }
        updated.push(transition.next);
        seen.handoff = true;
        audit.push(handoffAudit(ctx, scope.issueNumber, transition, reason, firstSeen));
        if (wasAwaitingAck) {
          // §7.1's carve-out: this row's summary was already committed — and
          // possibly delivered — reporting an outcome the fence now supersedes.
          // The summary is preserved unchanged; one bounded correction comment is
          // scheduled beside it, in this same transaction.
          effects.push(
            handoffCorrectionEffect(ctx, scope.issueNumber, entry.commentId, transition.row, reason),
          );
        }
      }
      seen.result = { rows: updated, fenced: true, fenceRecord: { reason, detail } };
      return {
        rows: updated,
        audit,
        effects,
        fence: {
          grain: "issue",
          record: { reason, detail, fencedAt: new Date(ctx.now()).toISOString() },
        },
      };
    }

    for (const entry of reconciliation.rows) {
      if (entry.row.state !== "dispatching") {
        updated.push(entry.row); // merged evidence only
        continue;
      }
      const transition = applyChatOpsLedgerEvent(
        entry.row,
        { kind: "reconciled", verdict: entry.verdict },
        entry.commentId,
        { fenced },
      );
      if (!transition.applied) {
        updated.push(entry.row);
        continue;
      }
      updated.push(transition.next);
      if (transition.row === 10 && transition.next.outcome !== null) {
        // Row 10: reconciliation adopted a marker already on the provider. No
        // prior transaction ever enqueued a summary for this row (row 8 never
        // ran), so its fixed sentence is enqueued here, atomically with the write
        // that commits the disposition (§7.1, §10.1).
        const outcome = chatOpsReconciledFromMarkerOutcome(
          transition.next.outcome,
          ctx.redactionPaths,
        );
        effects.push(
          summaryEffect(ctx, scope.issueNumber, entry.commentId, transition.row, outcome),
        );
        const record = firstSeen.get(entry.commentId);
        const verdict = record ? judgeCandidate(ctx, record) : null;
        audit.push(
          auditRecord(
            ctx,
            scope.issueNumber,
            entry.commentId,
            transition.row,
            record?.author ?? "unknown",
            verdict?.kind === "dispatchable" ? verdict.operationId : null,
            null,
            outcome,
          ),
        );
        seen.notes.push(`comment ${entry.commentId}: outcome recovered from a provider marker`);
      } else if (transition.next.state === "ambiguous") {
        seen.handoff = true;
        audit.push(
          handoffAudit(ctx, scope.issueNumber, transition, "dispatch-crash-unresolved", firstSeen),
        );
      } else if (transition.next.state === "retry_scheduled") {
        seen.notes.push(`comment ${entry.commentId}: proven no-effect, retry scheduled`);
      } else {
        seen.delay = true;
      }
    }

    seen.result = { rows: updated, fenced: false, fenceRecord: null };
    if (updated.length === 0 && audit.length === 0 && effects.length === 0) return null;
    return { rows: updated, audit, effects };
  });

  for (const text of seen.notes) note(acc, text);
  if (seen.handoff) acc.sawHandoff = true;
  if (seen.delay) acc.sawDelay = true;
  return seen.result;
}

/**
 * T1 — the discovery commit (§8).
 *
 * First-seen inserts, the cursor advance, and one ledger row per candidate go
 * in together. The postcondition that matters is *every comment at or below the
 * cursor has exactly one ledger row*: committing the cursor without the rows
 * would let a restart find a comment that is neither a candidate (its first-seen
 * record exists) nor tracked (no ledger row) — a permanently invisible command.
 *
 * The one deliberate exception is a fenced scope, which may not write a claim
 * (row 3). Its first-seen record is still written and the cursor still advances
 * (§12), and the missing row is recovered by {@link claimPending} once the fence
 * is cleared — which is why that path exists rather than being an optimization.
 *
 * Which comments still need a row is decided **inside** the transaction, from
 * the rows it re-reads, for the reason §15 states as a schema requirement:
 * every transition is a guarded compare-and-set. Two passes can read the same
 * new comment before either commits; deciding from a scan snapshot would let
 * the slower one write its fresh `claimed` row over a row the faster one had
 * already carried through dispatch, rolling the ledger back to a state that
 * dispatches the command a second time. Under the write lock a row is written
 * only while it is still absent, which makes a second discovery a no-op instead.
 */
async function commitDiscovery(
  ctx: PassContext,
  scope: ChatOpsScope,
  window: ChatOpsScanWindowComplete,
  acc: IssueAccumulator,
  fenced: boolean,
): Promise<{ rows: readonly ChatOpsLedgerRow[] }> {
  // The one input that is not a ledger row and needs I/O — which comments
  // already have a first-seen record — is resolved before the transaction
  // opens, because `build` may not perform any (§8's "nothing external is ever
  // inside a transaction"). A record another pass inserts in between costs
  // nothing: first-seen writes are insert-only, and the row it would imply is
  // caught by the in-transaction re-read below.
  const present = new Set<string>();
  if (!window.bootstrap) {
    await Promise.all(
      window.comments.map(async (comment) => {
        if (await ctx.store.getFirstSeen(scope, comment.id)) present.add(comment.id);
      }),
    );
  }

  // Held in an object for the reason `reconcileWindow` states: `build` runs
  // inside the store's transaction, so nothing it decides is applied to the
  // accumulator until the transaction that decided it has committed.
  const seen = {
    rows: [] as readonly ChatOpsLedgerRow[],
    notes: [] as string[],
    candidates: 0,
    refused: 0,
    claimed: 0,
    bootstrapped: false,
    bootstrapSkipped: 0,
  };

  await ctx.store.commitCompareAndSwap(scope, (persisted) => {
    seen.rows = [];
    seen.notes = [];
    seen.candidates = 0;
    seen.refused = 0;
    seen.claimed = 0;
    seen.bootstrapped = false;
    seen.bootstrapSkipped = 0;

    const tracked = new Set(persisted.map((row) => row.commentId));
    const firstSeen: ChatOpsFirstSeenRecord[] = [];
    const rows: ChatOpsLedgerRow[] = [];
    const audit: ChatOpsAuditRecord[] = [];
    let cursor: ChatOpsCursorState = window.nextState;

    if (window.bootstrap) {
      // Every pre-existing comment is recorded and none is dispatched: replaying
      // commands that predate the surface being enabled would execute
      // instructions nobody re-issued (§8).
      const plan = planChatOpsBootstrap(window);
      firstSeen.push(...plan.records);
      cursor = plan.state;
      seen.bootstrapped = true;
      seen.bootstrapSkipped = plan.skippedCommandAttempts.length;
      for (const skipped of plan.skippedCommandAttempts) {
        seen.notes.push(
          `bootstrap: comment ${skipped.commentId} by ${skipped.author} looks like a command and was not run`,
        );
      }
      for (const record of plan.records) {
        if (tracked.has(record.commentId)) continue; // already tracked; never a second row
        const refusal = refuseRow(ctx, scope, record, "bootstrap-backlog", undefined, rows, audit);
        if (refusal) seen.refused += 1;
      }
      seen.candidates = plan.records.length;
    } else {
      const selection = selectChatOpsCandidates(window, (id) => present.has(id));
      seen.candidates = selection.candidates.length;
      for (const comment of selection.candidates) {
        const record = buildChatOpsFirstSeenRecord(comment, { bootstrap: false });
        firstSeen.push(record);
        if (tracked.has(comment.id)) continue; // already tracked; never a second row
        const verdict = judgeCandidate(ctx, record);
        if (verdict.kind === "refused") {
          refuseRow(ctx, scope, record, verdict.reason, verdict.detail, rows, audit);
          seen.refused += 1;
          continue;
        }
        if (fenced) {
          // Row 3: a fenced scope writes no claim. The first-seen record above is
          // still committed, so the comment is recoverable by `claimPending`.
          seen.notes.push(`comment ${comment.id}: claim deferred, scope is fenced`);
          continue;
        }
        const transition = applyChatOpsLedgerEvent(null, { kind: "claim" }, comment.id, { fenced });
        if (transition.applied) {
          rows.push(transition.next);
          seen.claimed += 1;
        }
      }
    }

    seen.rows = rows;
    // Always a write, even with nothing to claim: the cursor advance is the
    // half of T1 that makes a scan bounded, and skipping it would rescan the
    // same window forever.
    return { cursor, firstSeen, rows, audit };
  });

  for (const text of seen.notes) note(acc, text);
  acc.candidates = seen.candidates;
  acc.refused += seen.refused;
  acc.claimed += seen.claimed;
  if (seen.bootstrapped) {
    acc.bootstrapped = true;
    acc.bootstrapSkipped = seen.bootstrapSkipped;
  }
  return { rows: seen.rows };
}

/**
 * Append the ledger row and audit record for one §4.1 refusal.
 *
 * The audit record — not the row — is what makes the fine-grained reason
 * survive a restart (§9.1): the ledger's own `refuse` event records only which
 * of four coarse causes applied, and six of these nine reasons share the single
 * literal `recognition-refused`.
 *
 * No comment of any kind is scheduled: a `rejected` row is terminal at T1 with
 * no external effect ever attempted (§10.2).
 */
function refuseRow(
  ctx: PassContext,
  scope: ChatOpsScope,
  record: ChatOpsFirstSeenRecord,
  reason: ChatOpsUndispatchedReason,
  detail: string | undefined,
  rows: ChatOpsLedgerRow[],
  audit: ChatOpsAuditRecord[],
): boolean {
  const ledgerReason =
    reason === "bootstrap-backlog" || reason === "chatops-disabled" || reason === "marker-comment"
      ? reason
      : "recognition-refused";
  const transition = applyChatOpsLedgerEvent(
    null,
    { kind: "refuse", reason: ledgerReason, detail: detail ?? reason },
    record.commentId,
  );
  if (!transition.applied) return false;
  rows.push(transition.next);
  const outcome = chatOpsUndispatchedOutcome(reason, ctx.redactionPaths, detail);
  audit.push(
    auditRecord(
      ctx,
      scope.issueNumber,
      record.commentId,
      transition.row,
      record.author,
      null,
      null,
      outcome,
    ),
  );
  return true;
}

/**
 * Write the ledger rows a previously-fenced pass deferred (§12, row 3).
 *
 * These comments already have first-seen records and have fallen below the
 * cursor, so no future scan window will contain them: without this they would
 * be permanently un-dispatched once the fence cleared, which is exactly the
 * skip `docs/chatops-comment-cursor-contract.md` I1 forbids.
 */
async function claimPending(
  ctx: PassContext,
  scope: ChatOpsScope,
  pending: readonly ChatOpsFirstSeenRecord[],
  acc: IssueAccumulator,
): Promise<readonly ChatOpsLedgerRow[]> {
  // Guarded exactly like T1, and for the same reason: a deferred claim is
  // recovered from a first-seen record two overlapping passes can both read, so
  // whether the row is still missing is a question only the write transaction
  // can answer.
  const seen = { rows: [] as readonly ChatOpsLedgerRow[], notes: [] as string[], refused: 0, claimed: 0 };
  await ctx.store.commitCompareAndSwap(scope, (persisted) => {
    seen.rows = [];
    seen.notes = [];
    seen.refused = 0;
    seen.claimed = 0;
    const tracked = new Set(persisted.map((row) => row.commentId));
    const rows: ChatOpsLedgerRow[] = [];
    const audit: ChatOpsAuditRecord[] = [];
    for (const record of pending) {
      if (tracked.has(record.commentId)) continue;
      const verdict = judgeCandidate(ctx, record);
      if (verdict.kind === "refused") {
        refuseRow(ctx, scope, record, verdict.reason, verdict.detail, rows, audit);
        seen.refused += 1;
        continue;
      }
      const transition = applyChatOpsLedgerEvent(null, { kind: "claim" }, record.commentId, {
        fenced: false,
      });
      if (transition.applied) {
        rows.push(transition.next);
        seen.claimed += 1;
        seen.notes.push(
          `comment ${record.commentId}: deferred claim recovered after the fence cleared`,
        );
      }
    }
    seen.rows = rows;
    return rows.length > 0 || audit.length > 0 ? { rows, audit } : null;
  });
  for (const text of seen.notes) note(acc, text);
  acc.refused += seen.refused;
  acc.claimed += seen.claimed;
  return seen.rows;
}

/**
 * The provider's ordering position for a ready row.
 *
 * The order key is `(createdAtMs, commentId)`
 * (`docs/chatops-comment-cursor-contract.md` §3), and its instant half lives in
 * the row's first-seen record — recorded verbatim from the provider when the
 * comment was first observed, and immutable afterwards (§9). The ledger row
 * itself carries only the id, which is *not* a substitute: ids ascend with
 * creation on a natively-authored issue, but an issue imported from another
 * tracker keeps the original timestamps under freshly-minted ids, so id order
 * and comment order come apart exactly where a `/resolve` and the `/grant` it
 * depends on were imported together.
 *
 * A row with no readable first-seen record sorts last rather than at some
 * guessed instant: T1 writes the record and the row in one transaction, so this
 * should not happen, and sorting the unknown last leaves every known row in its
 * true relative order instead of letting one unplaceable row jump the queue.
 */
function dispatchOrderKey(
  row: ChatOpsLedgerRow,
  record: ChatOpsFirstSeenRecord | undefined,
): ChatOpsCommentOrderKey {
  if (record) {
    try {
      return deriveChatOpsCommentOrderKey({ id: row.commentId, createdAt: record.createdAt });
    } catch {
      // Fall through: a record whose timestamp no longer parses cannot place the
      // row, which is the same situation as having no record at all.
    }
  }
  return { createdAtMs: Number.POSITIVE_INFINITY, commentId: row.commentId };
}

/**
 * Dispatch every ready row, in comment order, up to the pass's budget.
 *
 * `claimed` and `retry_scheduled` are the only two dispatchable states. A row in
 * `dispatching` is deliberately skipped: a process that finds one never resumes
 * the attempt from where it left off — it reconciles (§9.1), which already
 * happened above.
 *
 * "Comment order" is the contract's total order, not the ids' numeric order; see
 * {@link dispatchOrderKey}. The rows come from a map, whose iteration order is
 * insertion order across several unrelated sources (persisted state, discovery,
 * deferred claims, reconciliation), so an explicit sort is what makes the order
 * the provider's rather than this pass's.
 */
async function dispatchReadyRows(
  ctx: PassContext,
  scope: ChatOpsScope,
  rowsById: Map<string, ChatOpsLedgerRow>,
  acc: IssueAccumulator,
): Promise<void> {
  const readyRows = [...rowsById.values()].filter(
    (row) => row.state === "claimed" || row.state === "retry_scheduled",
  );
  if (readyRows.length === 0) return;

  const firstSeen = await loadFirstSeenRecords(
    ctx,
    scope,
    readyRows.map((row) => row.commentId),
  );
  const ready = readyRows
    .map((row) => ({ row, key: dispatchOrderKey(row, firstSeen.get(row.commentId)) }))
    .sort((a, b) => compareChatOpsCommentOrderKeys(a.key, b.key))
    .map((entry) => entry.row);

  for (const row of ready) {
    if (ctx.dispatchBudget <= 0) {
      note(acc, "dispatch budget exhausted for this pass; remaining commands run on the next one");
      acc.sawDelay = true;
      return;
    }
    const updated = await dispatchOne(ctx, scope, row, acc);
    if (updated) rowsById.set(updated.commentId, updated);
    if (acc.fenced !== null) {
      // Only a write-ahead can set this here — a fence known before dispatch
      // skips this loop entirely — so it means an overlapping pass fenced the
      // scope mid-pass. A fence covers the scope, not the row that noticed it,
      // so the remaining rows are not attempted either (§12).
      note(acc, "scope was fenced during this pass: no further dispatch attempted");
      return;
    }
  }
}

async function dispatchOne(
  ctx: PassContext,
  scope: ChatOpsScope,
  row: ChatOpsLedgerRow,
  acc: IssueAccumulator,
): Promise<ChatOpsLedgerRow | null> {
  const record = await ctx.store.getFirstSeen(scope, row.commentId);
  if (!record) {
    // A ledger row with no first-seen record cannot be re-derived, and guessing
    // its command is precisely what the immutable-input rule forbids. Escalate.
    return escalateRow(
      ctx,
      scope,
      row,
      "conflicting-evidence",
      `comment ${row.commentId} has a ledger row but no first-seen record`,
      acc,
    );
  }
  const verdict = judgeCandidate(ctx, record);
  if (verdict.kind !== "dispatchable") {
    // Recognition is a pure function of immutable input, so this can only mean
    // the stored record and the ledger row disagree about what this comment is.
    return escalateRow(
      ctx,
      scope,
      row,
      "conflicting-evidence",
      `comment ${row.commentId} is claimed but no longer maps to an operation (${verdict.reason})`,
      acc,
    );
  }

  // Row 16 — the retry budget is spent. A definite negative outcome (the
  // operation provably never started on any attempt), so it is acknowledged
  // rather than escalated, and it consumes no epoch because nothing external
  // will happen.
  if (row.state === "retry_scheduled" && row.attempts >= CHATOPS_MAX_DISPATCH_ATTEMPTS) {
    const outcome = chatOpsRetryBudgetExhaustedOutcome(ctx.redactionPaths);
    // Decided inside the transaction for the two reasons T2 states: the row may
    // have moved, and the scope may have been fenced, since this pass loaded
    // them. This transition is still a `begin-dispatch`, so a fence refuses it
    // (§7 row 3) exactly as it refuses a real dispatch — a fenced scope's rows
    // belong to an operator, including the one whose budget happens to be spent.
    const spent: { row: ChatOpsLedgerRow | null; fenced: ChatOpsFenceNotice | null } = {
      row: null,
      fenced: null,
    };
    await ctx.store.commitCompareAndSwap(scope, (persisted, fences) => {
      spent.row = null;
      spent.fenced = null;
      const current = persisted.find((candidate) => candidate.commentId === row.commentId);
      if (!current || !sameChatOpsLedgerVersion(current, row)) return null;
      const fence = fences.issue ?? fences.session;
      const transition = applyChatOpsLedgerEvent(
        current,
        { kind: "begin-dispatch", epoch: current.epoch ?? 0, nowMs: ctx.now() },
        row.commentId,
        { fenced: fence !== null },
      );
      if (!transition.applied) {
        if (fence !== null) spent.fenced = { reason: fence.reason, detail: fence.detail };
        return null;
      }
      spent.row = transition.next;
      return {
        rows: [transition.next],
        effects: [summaryEffect(ctx, scope.issueNumber, row.commentId, transition.row, outcome)],
        audit: [
          auditRecord(
            ctx,
            scope.issueNumber,
            row.commentId,
            transition.row,
            record.author,
            verdict.operationId,
            null,
            outcome,
          ),
        ],
      };
    });
    if (spent.fenced !== null) {
      if (acc.fenced === null) acc.fenced = spent.fenced;
      note(
        acc,
        `comment ${row.commentId}: exhausted retry not settled, scope was fenced (${spent.fenced.reason})`,
      );
      return null;
    }
    if (spent.row === null) {
      // The row moved under this pass, so whoever moved it owns what happens
      // next — the same decline T2 makes, for the same reason.
      note(acc, `comment ${row.commentId}: exhausted retry not settled, the row changed under this pass`);
      acc.sawDelay = true;
      return null;
    }
    note(acc, `comment ${row.commentId}: automatic retry budget exhausted`);
    return spent.row;
  }

  // --- T2: the write-ahead (§8, §9.1) --------------------------------------
  // The row the transaction produced is captured through a holder rather than a
  // bare `let`: `build` runs inside the store's transaction, and a value a
  // nested closure assigns is not something the compiler can narrow afterwards.
  const written: {
    row: ChatOpsLedgerRow | null;
    stale: string | null;
    fenced: ChatOpsFenceNotice | null;
  } = { row: null, stale: null, fenced: null };
  const epoch = await ctx.store.commitWithEpoch(scope, (allocated, persisted, fences) => {
    // Compare-and-swap against the row the transaction itself read, never the
    // copy this pass loaded before it started making provider calls. Two
    // overlapping passes both hold a `claimed` row; the one that commits first
    // leaves `dispatching` behind, and the second must see that and decline
    // rather than spend a second epoch and invoke the operation again. Applying
    // the transition to the *persisted* row (not the local one) is the same
    // guarantee stated positively: whatever this commits is a successor of what
    // is actually stored.
    const current = persisted.find((candidate) => candidate.commentId === row.commentId);
    if (!current) {
      written.stale = "its ledger row is gone";
      return null;
    }
    if (!sameChatOpsLedgerVersion(current, row)) {
      written.stale = `another pass moved it to ${current.state}`;
      return null;
    }
    // The fence is read by *this* transaction too, for the same reason the row
    // is. A fence bars new execution (§12), and the write-ahead is the instant a
    // dispatch becomes new execution: an overlapping pass's reconciliation can
    // durably fence the scope after this pass reconciled and before this commit,
    // and a write-ahead that trusted the pre-fence snapshot would invoke the
    // operation the fence exists to stop. Row 8's own guard states the refusal,
    // so the fence is handed to it rather than re-decided here.
    const fence = fences.issue ?? fences.session;
    const transition = applyChatOpsLedgerEvent(
      current,
      { kind: "begin-dispatch", epoch: allocated, nowMs: ctx.now() },
      row.commentId,
      { fenced: fence !== null },
    );
    if (!transition.applied) {
      if (fence !== null) written.fenced = { reason: fence.reason, detail: fence.detail };
      return null;
    }
    written.row = transition.next;
    const input: ChatOpsCommitInput = { rows: [transition.next] };
    return input;
  });
  if (written.fenced !== null) {
    // Nothing was committed and no epoch was spent: the scope was fenced while
    // this pass was working, so this row is now an operator's to release, not
    // this pass's to dispatch. Recorded on the accumulator so the pass reports
    // the fence exactly as one observed at its start would (§12).
    if (acc.fenced === null) acc.fenced = written.fenced;
    note(
      acc,
      `comment ${row.commentId}: dispatch declined, scope was fenced (${written.fenced.reason})`,
    );
    return null;
  }
  if (written.stale !== null) {
    // Not an error and not this pass's work any more: whoever moved the row owns
    // the attempt. Reported as a delay so the caller knows the command is still
    // in flight rather than concluded.
    note(acc, `comment ${row.commentId}: dispatch declined, ${written.stale}`);
    acc.sawDelay = true;
    return null;
  }
  if (epoch === null || written.row === null) return null;
  const dispatching: ChatOpsLedgerRow = written.row;
  ctx.dispatchBudget -= 1;
  acc.dispatchAttempts += 1;

  // --- The epoch witness, before the first external call (§9.2) ------------
  const witness = writeChatOpsEpochWitness(ctx.witnessPath, epoch);
  if (!witness.ok) {
    // An effect whose epoch was never witnessed is an effect a future restore
    // could not detect, so the attempt is abandoned before anything external
    // happens. Nothing ran, so row 9's proven-no-effect verdict is exactly true.
    //
    // Settled through the same compare-and-swap T3 uses, and for the same
    // reason: the write-ahead is already durable, so an overlapping pass can
    // fence or reconcile this `dispatching` row while this one is failing to
    // write the witness. A verdict derived from the local copy and upserted
    // unconditionally would replace a fence's `ambiguous` handoff with
    // `retry_scheduled`, letting the command resume by itself once the fence is
    // cleared. The verdict is therefore written only onto the row version the
    // attempt began on.
    const abandoned: {
      row: ChatOpsLedgerRow | null;
      stale: string | null;
      staleHandoff: boolean;
      refused: boolean;
    } = { row: null, stale: null, staleHandoff: false, refused: false };
    await ctx.store.commitCompareAndSwap(scope, (persisted) => {
      abandoned.row = null;
      abandoned.stale = null;
      abandoned.staleHandoff = false;
      abandoned.refused = false;

      const current = persisted.find((candidate) => candidate.commentId === row.commentId);
      if (!current) {
        abandoned.stale = "its ledger row is gone";
        abandoned.staleHandoff = true;
        return null;
      }
      if (!sameChatOpsLedgerVersion(current, dispatching)) {
        abandoned.stale = `another pass moved it to ${current.state}`;
        abandoned.staleHandoff = current.state === "ambiguous";
        return null;
      }
      const back = applyChatOpsLedgerEvent(
        current,
        { kind: "reconciled", verdict: { kind: "no-effect" } },
        row.commentId,
      );
      if (!back.applied) {
        abandoned.refused = true;
        return null;
      }
      abandoned.row = back.next;
      return { rows: [back.next] };
    });
    if (abandoned.stale !== null) {
      // Whatever displaced the row was decided from state this aborted attempt
      // cannot invalidate, and nothing external happened, so it stands.
      note(
        acc,
        `comment ${row.commentId}: epoch witness write failed (${witness.error}); ` +
          `no-effect verdict not recorded, ${abandoned.stale}`,
      );
      if (abandoned.staleHandoff) acc.sawHandoff = true;
      else acc.sawDelay = true;
      return null;
    }
    note(acc, `comment ${row.commentId}: epoch witness write failed, attempt aborted (${witness.error})`);
    acc.sawDelay = true;
    return abandoned.refused ? dispatching : abandoned.row;
  }

  // --- External effect 1: the claim marker ---------------------------------
  const claim = await ctx.port.postComment(scope.issueNumber, chatOpsMarkerBody(row.commentId));
  if (!claim.ok) {
    // Deliberately NOT treated as "no marker": an unconfirmed post (a timeout, a
    // dropped connection) may still have landed. The row stays `dispatching` and
    // the next pass's reconciliation decides, exactly like any mid-dispatch
    // crash (§8).
    note(acc, `comment ${row.commentId}: claim marker post unconfirmed (${claim.error})`);
    acc.sawDelay = true;
    return dispatching;
  }

  // --- External effect 2: the operation ------------------------------------
  const attempt: ChatOpsDispatchAttempt = {
    identity: ctx.identity,
    issueNumber: scope.issueNumber,
    commentId: row.commentId,
    // From the immutable first-seen record, never re-read from a possibly
    // edited comment: the author is the actor the operation is authorized as.
    authorLogin: record.author,
    attempt: dispatching.attempts,
    // ChatOps commands are dispatched confirmed: preview is not a shape the
    // grammar can express, and `--dry-run`/`--yes` are forbidden parameters
    // (#784 §4), so confirmation stays trusted context.
    confirmed: true,
    deadlineMs: ctx.deadlineMs,
  };
  const result = await invokeOperation(
    ctx.registry,
    { operationId: verdict.operationId, params: verdict.params },
    chatOpsOperationContext(attempt),
  );
  const disposition = chatOpsDispatchDisposition(result);

  if (disposition.kind === "reconcile") {
    // `failed` with `effect: "unknown"`: the operation cannot vouch for what it
    // already did. Recording anything here is how a command gets replayed on top
    // of effects that already landed, so nothing is recorded at all.
    note(acc, `comment ${row.commentId}: dispatch outcome indeterminate (${disposition.detail})`);
    acc.sawDelay = true;
    return dispatching;
  }

  // --- T3: the outcome commit, carrying the summary effect (§8, §10.1) -----
  return await recordDispatchOutcome(
    ctx,
    scope,
    dispatching,
    disposition.event,
    result,
    record.author,
    verdict.operationId,
    chatOpsOperationRequestId(attempt),
    acc,
  );
}

async function recordDispatchOutcome(
  ctx: PassContext,
  scope: ChatOpsScope,
  row: ChatOpsLedgerRow,
  event: ChatOpsLedgerEvent,
  result: OperationResult,
  actorId: string,
  operationId: string,
  requestId: string,
  acc: IssueAccumulator,
): Promise<ChatOpsLedgerRow | null> {
  const outcome = chatOpsDispatchResultOutcome(result, ctx.redactionPaths);

  // Decided inside the commit transaction, against the row as it is stored, for
  // the reason T2 states — and here for one case in particular: an overlapping
  // pass can fence the scope while the operation is in flight, which moves this
  // `dispatching` row to `ambiguous` (§11, §12). Applying the result to the
  // local copy and upserting it would replace that handoff with an ordinary
  // result and enqueue a summary comment contradicting the fence. A result is
  // therefore written only onto the row version the attempt began on.
  const seen: {
    row: ChatOpsLedgerRow | null;
    stale: string | null;
    /** Whether the row that displaced this one is parked for an operator. */
    staleHandoff: boolean;
    refusal: string | null;
    note: string | null;
    delay: boolean;
    published: boolean;
  } = {
    row: null,
    stale: null,
    staleHandoff: false,
    refusal: null,
    note: null,
    delay: false,
    published: false,
  };

  await ctx.store.commitCompareAndSwap(scope, (persisted) => {
    seen.row = null;
    seen.stale = null;
    seen.staleHandoff = false;
    seen.refusal = null;
    seen.note = null;
    seen.delay = false;
    seen.published = false;

    const current = persisted.find((candidate) => candidate.commentId === row.commentId);
    if (!current) {
      seen.stale = "its ledger row is gone";
      seen.staleHandoff = true;
      return null;
    }
    if (!sameChatOpsLedgerVersion(current, row)) {
      seen.stale = `another pass moved it to ${current.state}`;
      seen.staleHandoff = current.state === "ambiguous";
      return null;
    }
    const transition = applyChatOpsLedgerEvent(current, event, row.commentId);
    if (!transition.applied) {
      seen.refusal = transition.refusal.reason;
      return null;
    }
    seen.row = transition.next;
    if (transition.next.state === "retry_scheduled") {
      // Row 9 via a transient, proven-no-effect failure. Not a publishable
      // disposition — the command has not finished — so no summary is enqueued.
      seen.note = `comment ${row.commentId}: transient failure with no effect, retry scheduled`;
      seen.delay = true;
      return { rows: [transition.next] };
    }
    seen.published = true;
    seen.note = `comment ${row.commentId}: ${outcome.kind}${outcome.reason ? ` (${outcome.reason})` : ""}`;
    return {
      rows: [transition.next],
      effects: [summaryEffect(ctx, scope.issueNumber, row.commentId, transition.row, outcome)],
      audit: [
        auditRecord(
          ctx,
          scope.issueNumber,
          row.commentId,
          transition.row,
          actorId,
          operationId,
          requestId,
          outcome,
        ),
      ],
    };
  });

  if (seen.stale !== null) {
    // The persisted row is no longer the one this attempt began on, so it stands
    // unchanged: whatever displaced it — a fence, a reconciliation verdict — was
    // decided from state this result cannot invalidate. The operation did run,
    // and the surviving row is what an operator recovers from.
    note(acc, `comment ${row.commentId}: dispatch result not recorded, ${seen.stale}`);
    if (seen.staleHandoff) acc.sawHandoff = true;
    else acc.sawDelay = true;
    return null;
  }
  if (seen.refusal !== null) {
    note(acc, `comment ${row.commentId}: ledger refused the dispatch outcome (${seen.refusal})`);
    acc.sawDelay = true;
    return null;
  }
  if (seen.note !== null) note(acc, seen.note);
  if (seen.delay) acc.sawDelay = true;
  if (seen.published) acc.dispatchResults += 1;
  return seen.row;
}

/** Move a row to `ambiguous` with a recorded reason, and audit the handoff (§13.3). */
async function escalateRow(
  ctx: PassContext,
  scope: ChatOpsScope,
  row: ChatOpsLedgerRow,
  reason: ChatOpsLedgerHandoffReason,
  detail: string,
  acc: IssueAccumulator,
): Promise<ChatOpsLedgerRow | null> {
  const wasAwaitingAck = row.state === "awaiting_ack";
  const transition = applyChatOpsLedgerEvent(row, { kind: "escalate", reason, detail }, row.commentId);
  if (!transition.applied) return null;
  const effects = wasAwaitingAck
    ? [handoffCorrectionEffect(ctx, scope.issueNumber, row.commentId, transition.row, reason)]
    : [];
  const firstSeen = await loadFirstSeenRecords(ctx, scope, [row.commentId]);
  await ctx.store.commit(scope, {
    rows: [transition.next],
    audit: [handoffAudit(ctx, scope.issueNumber, transition, reason, firstSeen)],
    effects,
  });
  acc.sawHandoff = true;
  note(acc, `comment ${row.commentId}: escalated (${reason}) — ${detail}`);
  return transition.next;
}

/** What an unsettled reservation is recorded as; see {@link publishPendingAcks}. */
const CHATOPS_UNSETTLED_PUBLICATION =
  "a previous publication attempt did not record its result";

/**
 * T4 — publish the acknowledgement marker for every row still owing one.
 *
 * The marker body is re-derived from the row's own persisted `commentId` and
 * `outcome`, so attempt *N+1* is byte-identical to attempt *N*: there is no
 * separate payload for a restart to forget, and no path by which a retry can
 * post a different outcome than the one already committed (§10.1).
 *
 * The post itself sits *between* two transactions, which is the one place the
 * ledger's own compare-and-set cannot reach: two passes can both hold the same
 * `awaiting_ack`/`pending` row and both post before either commits, and one
 * command then carries two acknowledgement markers. So the attempt is reserved
 * first (see {@link ChatOpsStore.reserveAckPublication}) and the reservation is
 * released by the transaction that records what the post did. Only the pass
 * that took the reservation posts; the other reports a delay and leaves the
 * marker to its owner.
 *
 * A reservation still held when a later pass starts belongs to a pass that died
 * mid-publication, so its post is *unconfirmed* — the same state a dropped
 * claim-marker post leaves behind, and resolved the same deliberately ambiguous
 * way (§8): nothing is assumed about whether the marker landed, the attempt is
 * settled as a failure (rows 18/19, so it consumes exactly one of the
 * documented attempts and no new counter is introduced), and a later pass
 * republishes if the row still owes a marker.
 */
async function publishPendingAcks(
  ctx: PassContext,
  scope: ChatOpsScope,
  rowsById: Map<string, ChatOpsLedgerRow>,
  unsettled: ReadonlySet<string>,
  acc: IssueAccumulator,
): Promise<void> {
  const owing = [...rowsById.values()].filter(
    (row) => row.state === "awaiting_ack" && row.ackPublication === "pending",
  );
  if (owing.length === 0) return;
  // Row 19's audit record names the command's author and operation, and the
  // settlement below decides inside the commit transaction, which may not
  // perform I/O — so those records are resolved before any of it starts.
  const firstSeen = await loadFirstSeenRecords(
    ctx,
    scope,
    owing.map((row) => row.commentId),
  );

  for (const row of owing) {
    const outcome = row.outcome;
    if (outcome === null) continue;

    const unsettledAttempt = unsettled.has(row.commentId);
    if (!unsettledAttempt) {
      const mine = await ctx.store.reserveAckPublication(
        scope,
        row.commentId,
        (persisted) =>
          persisted !== undefined &&
          persisted.state === "awaiting_ack" &&
          persisted.ackPublication === "pending" &&
          sameChatOpsLedgerVersion(persisted, row),
      );
      if (!mine) {
        // Either another pass owns this publication or the row moved under this
        // one. Neither is an error, and neither is this pass's work any more.
        note(acc, `comment ${row.commentId}: acknowledgement publication is owned by another pass`);
        acc.sawDelay = true;
        continue;
      }
    }
    const post: ChatOpsPostResult = unsettledAttempt
      ? { ok: false, error: CHATOPS_UNSETTLED_PUBLICATION }
      : await ctx.port.postComment(scope.issueNumber, chatOpsMarkerBody(row.commentId, outcome));

    const event: ChatOpsLedgerEvent = post.ok
      ? { kind: "ack-published" }
      : { kind: "ack-publish-failed", detail: post.error };

    // Held in an object for the reason `reconcileWindow` states: `build` runs
    // inside the store's transaction, and what it decided is applied to the
    // accumulator only once that transaction has committed.
    const settled: { row: ChatOpsLedgerRow | null; abandoned: boolean; stale: boolean } = {
      row: null,
      abandoned: false,
      stale: false,
    };
    await ctx.store.commitCompareAndSwap(scope, (persisted) => {
      settled.row = null;
      settled.abandoned = false;
      settled.stale = false;
      // The reservation is released whatever the row turns out to say: holding
      // it after the attempt it covers has finished would stall every later
      // publication for this comment.
      const release: ChatOpsCommitInput = { releaseAckReservations: [row.commentId] };
      const current = persisted.find((candidate) => candidate.commentId === row.commentId);
      if (!current || !sameChatOpsLedgerVersion(current, row)) {
        settled.stale = true;
        return release;
      }
      const transition = applyChatOpsLedgerEvent(current, event, row.commentId);
      if (!transition.applied) {
        settled.stale = true;
        return release;
      }
      settled.row = transition.next;
      const commit: ChatOpsCommitInput = { ...release, rows: [transition.next] };
      if (!post.ok && transition.next.ackPublication === "abandoned") {
        // Row 19: the outcome stays exactly as committed, but what is *presented*
        // becomes a human handoff — the durable, provider-visible proof a future
        // reconciliation would read is now permanently missing (§9.1's superseding
        // record; §4.2).
        settled.abandoned = true;
        const disposition = chatOpsLedgerDisposition(transition.next);
        const handoff = chatOpsHandoffOutcome(
          "ack-publication-abandoned",
          transition.next.attempts,
          ctx.redactionPaths,
        );
        const record = firstSeen.get(row.commentId);
        const verdict = record ? judgeCandidate(ctx, record) : null;
        commit.audit = [
          auditRecord(
            ctx,
            scope.issueNumber,
            row.commentId,
            transition.row,
            record?.author ?? "unknown",
            verdict?.kind === "dispatchable" ? verdict.operationId : null,
            null,
            // The row's own projection and the composed outcome must agree; the
            // projection is the authority for `dispatched` (invariant 9).
            { ...handoff, dispatched: disposition?.dispatched ?? handoff.dispatched },
          ),
        ];
      }
      return commit;
    });

    if (settled.stale) {
      note(acc, `comment ${row.commentId}: acknowledgement settled by another pass`);
      acc.sawDelay = true;
      continue;
    }
    const next: ChatOpsLedgerRow | null = settled.row;
    if (next === null) continue;
    if (post.ok) {
      acc.acknowledged += 1;
    } else if (settled.abandoned) {
      acc.sawHandoff = true;
      note(acc, `comment ${row.commentId}: acknowledgement publication abandoned`);
    } else {
      acc.sawDelay = true;
      note(
        acc,
        unsettledAttempt
          ? `comment ${row.commentId}: ${CHATOPS_UNSETTLED_PUBLICATION}; the marker will be posted again`
          : `comment ${row.commentId}: acknowledgement post failed, will retry (${post.error})`,
      );
    }
    rowsById.set(row.commentId, next);
  }
}
