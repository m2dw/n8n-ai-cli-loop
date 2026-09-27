#!/usr/bin/env node
/**
 * chatops-scan — run ONE bounded ChatOps scan/dispatch/publish pass.
 *
 * This is the supported entrypoint the ChatOps chain was built toward: it
 * connects comment discovery, authenticated command recognition, the durable
 * cursor and execution ledger, operation mapping and dispatch, and bounded
 * result publication. Nothing about it polls — one invocation reads each work
 * item's comment list to its end once, dispatches at most
 * `chatOps.maxDispatchesPerPass` commands, publishes what it owes, and exits.
 *
 * It is also the ChatOps *composition root* (issue #1031): the two mapped Tool
 * Request operations are callable cores that construct nothing for themselves,
 * so this is where their task store, outbox, repo lock and session are opened
 * and handed to `createChatOpsOperationRegistry`. An authorized `/grant` or
 * `/resolve` therefore runs exactly the business logic `admin tool-request run`
 * / `resolve` runs — the same module, called in-process, with no argv and no
 * subprocess anywhere on the path.
 *
 * n8n command shape:
 *   node /path/to/dist/cli/chatops-scan.js \
 *     --context-id "ctx-123" \
 *     [--db-path "/path/to/dev_loop.db"] \
 *     [--issue-number 12,34] [--max-issues 20] [--lock-dir "/path/to/locks"]
 *
 * `--session-id` names the session directly; `--context-id` resolves it from the
 * context store, which is how the generated child workflow invokes this CLI (the
 * same convention every other node in that workflow follows — sessionId never
 * crosses the workflow boundary). Exactly one of the two is required, and
 * passing both is rejected rather than resolved by precedence.
 *
 * The schedule lives in n8n; the *policy* — who may command, which verbs exist,
 * what a verb may set, how a result is published — lives entirely in the session
 * config and the contracts this CLI calls into. A workflow never needs to encode
 * any of it, which is the point of the flag set being this small. `--max-issues`
 * bounds one pass rather than choosing which work items a session ever scans:
 * the window rotates across passes, so the workflow can leave it unset without
 * any part of the session being permanently skipped.
 *
 * Exit codes:
 *   0 — the pass ran, whatever it concluded. `outcome` carries the disposition:
 *       `disabled`, `idle`, `refused`, `processed`, `delayed` (call again), or
 *       `failed` (a human must look). A ChatOps failure is a state to report,
 *       not a crashed step. A session with ChatOps switched off is reported here
 *       too, as `disabled`, without opening a store or a provider connection,
 *       and a database under a `prune`/`restore` maintenance lock as `delayed`,
 *       without opening a provider connection.
 *   1 — setup error: bad args, unknown session or context, unusable provider identity, a
 *       provider ChatOps has no comment port for, or credentials that cannot be
 *       resolved. No provider read, no ChatOps write, and no comment post has
 *       happened when this occurs.
 *
 * Emits exactly one JSON object to stdout.
 */

import { fileURLToPath } from "url";
import {
  JsonSessionRegistry,
  DEFAULT_SESSIONS_PATH,
  describeUnresolvedSessionId,
} from "../registries/json-session-registry.js";
import { SqliteChatOpsStore, DEFAULT_DB_PATH } from "../stores/sqlite-chatops-store.js";
import { MaintenanceLockedError } from "../stores/maintenance-lock-guard.js";
import { SqliteContextStore } from "../stores/sqlite-context-store.js";
import { SqliteOutboxStore } from "../stores/sqlite-outbox-store.js";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import { RepoLockStore } from "../stores/repo-lock-store.js";
import { chatOpsIdentityKey, deriveChatOpsProviderIdentity } from "../core/chatops-identity.js";
import type { ChatOpsProviderIdentity } from "../core/chatops-identity.js";
import { createChatOpsOperationRegistry } from "../core/chatops-operations.js";
import type { ChatOpsOperationDeps } from "../core/chatops-operations.js";
import {
  toolRequestResolveOperationContext,
  toolRequestRunOperationContext,
} from "../handlers/tool-request-operation-context.js";
import {
  chatOpsDisabledResult,
  chatOpsMaintenanceLockedResult,
  runChatOpsPass,
} from "../handlers/chatops-pass.js";
import type { ChatOpsPassResult } from "../handlers/chatops-pass.js";
import type { ChatOpsCommentPort } from "../core/chatops-comment-port.js";
import type { OperationRegistry } from "../core/operation-port.js";
import type { ResolvedSession } from "../core/session.js";
import type { TaskStatus } from "../core/task.js";
import { defaultGhRunner } from "../providers/github/gh-runner.js";
import type { GhRunner } from "../providers/github/gh-runner.js";
import { GhChatOpsCommentPort } from "../providers/github/gh-chatops-comment-port.js";
import { GiteaChatOpsCommentPort } from "../providers/gitea/gitea-chatops-comment-port.js";
import { redactGiteaSecrets, resolveGiteaToken } from "../providers/gitea/gitea-client.js";
import type { GiteaHttpRequest } from "../providers/gitea/gitea-client.js";
import { resolveGhRunner, redactSecrets } from "../providers/github/github-app-auth.js";
import type { GhRunnerAuthDeps } from "../providers/github/github-app-auth.js";
import { emit, die } from "./cli-io.js";
import { tokenizeArgs } from "./admin-command.js";

/**
 * Work items one invocation will scan when the operator names none explicitly.
 *
 * A per-pass bound, not a selection: when a session has more candidates than
 * this, each pass takes the *next* window rather than the same prefix (see
 * {@link selectRotatedIssues}), so this number changes how fast the whole
 * session is covered, never whether it is.
 */
const DEFAULT_MAX_ISSUES = 20;

/**
 * Task statuses past which automation takes no further commands for a work item
 * (see {@link resolveIssueNumbers}).
 */
const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "done",
  "failed",
  "cancelled",
]);

interface CliArgs {
  sessionId: string | undefined;
  contextId: string | undefined;
  sessionsPath: string;
  dbPath: string;
  issueNumbers: number[] | undefined;
  maxIssues: number;
  cwd: string | undefined;
  /**
   * Where the single-worker repo lock lives (issue #1031).
   *
   * The guided run takes that lock so a granted command can never mutate the
   * checkout beside an active worker, and the lock is a *filesystem* fact
   * shared with `admin tool-request run` and the phase runner — so the flag
   * exists for the same reason it does on the admin CLI: a deployment that
   * moved the lock directory must be able to tell every entrypoint about it, or
   * the two would take different locks and neither would exclude the other.
   */
  lockDir: string | undefined;
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: [
      "session-id",
      "context-id",
      "sessions-path",
      "db-path",
      "issue-number",
      "max-issues",
      "cwd",
      "lock-dir",
    ],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;

  const sessionId = args["session-id"];
  const contextId = args["context-id"];
  if (!sessionId && !contextId) return { error: "--session-id or --context-id is required" };
  // Both is a selector *ambiguity*, not a redundancy: silently preferring one
  // would scan, dispatch against, and post markers on whichever session that
  // flag named, while the caller believed it had named the other. A stale or
  // mismatched context row is exactly the case where the two disagree, so the
  // only safe reading of "exactly one" is to refuse before any store is opened.
  if (sessionId && contextId) {
    return { error: "--session-id and --context-id are mutually exclusive: pass exactly one" };
  }

  let issueNumbers: number[] | undefined;
  if (args["issue-number"] !== undefined) {
    // Comma-separated rather than a repeated flag: the shared tokenizer keeps a
    // single value per flag (last wins), and silently scanning only the last of
    // several `--issue-number` flags would be worse than not accepting them.
    const parts = args["issue-number"].split(",").map((part) => part.trim());
    issueNumbers = [];
    for (const part of parts) {
      const parsed = Number(part);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return { error: `--issue-number must be a comma-separated list of positive integers, got: ${args["issue-number"]}` };
      }
      if (!issueNumbers.includes(parsed)) issueNumbers.push(parsed);
    }
    if (issueNumbers.length === 0) return { error: "--issue-number must name at least one work item" };
  }

  let maxIssues = DEFAULT_MAX_ISSUES;
  if (args["max-issues"] !== undefined) {
    const parsed = Number(args["max-issues"]);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { error: `--max-issues must be a positive integer, got: ${args["max-issues"]}` };
    }
    maxIssues = parsed;
  }

  return {
    sessionId,
    contextId,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"] ?? DEFAULT_DB_PATH,
    issueNumbers,
    maxIssues,
    cwd: args["cwd"],
    lockDir: args["lock-dir"],
  };
}

/** One capped pass's work-item window, and where the next one resumes. */
export interface ChatOpsIssueSelection {
  /**
   * The work items this pass covers, in the order it must run them — rotation
   * order, starting at the resume position, not ascending (see
   * {@link selectRotatedIssues}).
   */
  issueNumbers: number[];
  /** True when the cap left some candidate out of this pass. */
  truncated: boolean;
  /**
   * The candidate the next pass starts from, or `null` when the cap covered
   * everything and there is nothing to resume from.
   */
  nextCursor: number | null;
}

/**
 * Take one capped window out of the candidate set, starting where the last pass
 * stopped.
 *
 * A cap without rotation is a permanent exclusion, not a bound: a session with
 * more candidates than `maxIssues` would hand every scheduled invocation the
 * same ascending prefix, and the work items past it would never have their
 * comments read at all — no `/grant` on them would ever run, and nothing in the
 * output would say which ones were being skipped forever. Starting each pass at
 * the candidate after the previous pass's last one makes the cap a *window* that
 * walks the whole set instead, so every work item is scanned within
 * `ceil(candidates / maxIssues)` passes.
 *
 * The window wraps, and the returned set stays in *rotation* order rather than
 * being re-sorted ascending, because the pass consumes one shared
 * `maxDispatchesPerPass` budget in the order it is handed. Re-sorting would
 * restore the starvation the rotation exists to remove one level down: with
 * candidates 1..5, `maxIssues` 3 and a budget of 1, the windows [1,2,3],
 * [4,5,1], [2,3,4] sorted ascending always put the lowest-numbered member first,
 * so 1, 1, 2 spend the budget and 4 and 5 are scanned but never dispatched.
 * Running each window from its resume position instead means every candidate
 * gets first call on the budget within one full rotation. `cursor` is matched by
 * ">=" rather than equality because the candidate it named may have gone
 * terminal since — a rotation position is a place to resume, never a promise
 * that a particular work item still exists.
 */
export function selectRotatedIssues(
  candidates: readonly number[],
  maxIssues: number,
  cursor: number | null,
): ChatOpsIssueSelection {
  if (candidates.length <= maxIssues) {
    return { issueNumbers: [...candidates], truncated: false, nextCursor: null };
  }
  let start = 0;
  if (cursor !== null) {
    const found = candidates.findIndex((issueNumber) => issueNumber >= cursor);
    start = found === -1 ? 0 : found;
  }
  const selected: number[] = [];
  for (let i = 0; i < maxIssues; i += 1) {
    selected.push(candidates[(start + i) % candidates.length]);
  }
  return {
    issueNumbers: selected,
    truncated: true,
    nextCursor: candidates[(start + maxIssues) % candidates.length],
  };
}

/**
 * Which work items this pass covers when the operator named none.
 *
 * Two sources, unioned and capped:
 *
 * - every scope this identity already has ChatOps state for, so a bootstrapped
 *   issue keeps being scanned without anyone re-listing it, and
 * - every work item with a live task in this session, so an issue an operator is
 *   about to comment on is already in scope before its first ChatOps state
 *   exists — otherwise the first `/grant` on a new issue would need a manual
 *   `--issue-number` and the surface would only work for issues someone had
 *   already thought to enumerate.
 *
 * Terminal tasks are excluded from *both* sources: a done, failed, or cancelled
 * work item is not somewhere automation should still be taking commands, and
 * including them would grow the per-pass provider cost without bound as a
 * session ages. Excluding them from the live-task source alone would not do
 * that — a task that goes terminal after its scope was bootstrapped keeps a
 * cursor row forever, so `known` would hand the scope straight back and every
 * later pass would go on scanning and dispatching for finished work.
 *
 * The one exception is a terminal work item whose ledger still owes automation
 * something — an in-flight dispatch, or a published outcome whose
 * acknowledgement marker has not landed yet. Dropping those at the moment the
 * task finished would strand the marker with no automatic path left to publish
 * it, so they stay in scope until they settle and then leave for good. A scope
 * parked for a human is *not* such a case: it moves only through
 * `chatops-recover`, and an operator can always name it with `--issue-number`.
 *
 * The cap is applied as a rotating window (see {@link selectRotatedIssues}), and
 * the next position is recorded *before* the pass runs: a pass that dies partway
 * must not leave the window pinned to the work items that killed it.
 */
async function resolveIssueNumbers(
  session: ResolvedSession,
  identityKey: string,
  store: SqliteChatOpsStore,
  dbPath: string,
  maxIssues: number,
): Promise<ChatOpsIssueSelection> {
  const known = await store.listIssueNumbers(identityKey);
  const active: number[] = [];
  const terminal = new Set<number>();
  const taskStore = new SqliteTaskStore(dbPath);
  try {
    for (const task of await taskStore.listSessionTasks(session.sessionId)) {
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        terminal.add(task.issueNumber);
        continue;
      }
      active.push(task.issueNumber);
    }
  } finally {
    taskStore.close();
  }
  // Read only when it can change the answer: with no terminal task there is
  // nothing to drop, so nothing to keep alive either.
  let retainedKnown = known;
  if (terminal.size > 0) {
    const unsettled = new Set(await store.listUnsettledIssueNumbers(identityKey));
    retainedKnown = known.filter(
      (issueNumber) => !terminal.has(issueNumber) || unsettled.has(issueNumber),
    );
  }

  const union = [...new Set([...retainedKnown, ...active])].sort((a, b) => a - b);
  const selection = selectRotatedIssues(union, maxIssues, await store.getScanRotation(identityKey));
  if (selection.nextCursor !== null) await store.setScanRotation(identityKey, selection.nextCursor);
  return selection;
}

export interface ChatOpsScanDeps {
  /**
   * Fallback `gh` executor for the GitHub comment port; tests inject a fake.
   *
   * Only used for `auth.mode: "gh"` sessions — a session that configured
   * `github-app` auth gets a token-injecting executor instead, so an injected
   * runner never silently overrides configured credentials.
   */
  runner?: GhRunner;
  /**
   * Transport/clock seams for GitHub App token resolution; tests inject fakes.
   *
   * `env` and `resolveKey` are shared with Gitea credential resolution — the
   * `api-token` reference a `gitea-issues` session configures is read through
   * the same two seams, the way `dispatch-outbox` and `issue-activation` read
   * it.
   */
  authDeps?: GhRunnerAuthDeps;
  /** HTTP transport for the Gitea comment port; tests inject a fake. */
  giteaHttp?: GiteaHttpRequest;
  /** Overrides the provider-derived comment port entirely (tests, future providers). */
  port?: ChatOpsCommentPort;
  /** Overrides the operation registry; defaults to the ChatOps composition root. */
  registry?: OperationRegistry;
}

/**
 * The identity view a `disabled` result reports, or `null` when this session's
 * work-item provider has no defined ChatOps identity.
 *
 * Deliberately non-fatal: derivation failure is a refusal to *start* a pass, and
 * a disabled session never starts one. A `jira` session with ChatOps switched
 * off is an ordinary no-op, not a setup error.
 */
function describeIdentityIfDerivable(session: ResolvedSession): ChatOpsPassResult["identity"] {
  try {
    const identity = deriveChatOpsProviderIdentity(session);
    return {
      provider: identity.provider,
      providerEndpoint: identity.providerEndpoint,
      providerOwner: identity.providerOwner,
      providerRepo: identity.providerRepo,
    };
  } catch {
    return null;
  }
}

/**
 * Build the comment port for a resolved identity, under the session's own
 * configured credentials.
 *
 * Two things this must not do, both of which would cross a scope boundary:
 *
 * - **Post as somebody else.** The work-item provider's `auth` block decides who
 *   this session acts as. Ignoring a configured `github-app` mode and using the
 *   ambient `gh` login would break App-only deployments outright, and on a
 *   developer machine would post claim/ack markers under a human login that is
 *   absent from `automationLogins` — markers that then fail to authenticate as
 *   ChatOps evidence, which every restore detector reads
 *   (`docs/chatops-execution-ledger-contract.md` §10.3).
 * - **Scan the wrong repository.** Each identity is served by its own adapter
 *   (`docs/chatops-operations.md` §2). A `gitea-issues` identity carries a Gitea
 *   owner/repo, and handing those to a `gh api` port would scan — and post
 *   markers on — a same-named repository on github.com while recording state
 *   under the Gitea identity. The branch below is on `identity.provider`, the
 *   same value the ledger scope is keyed by, so the two can never disagree.
 *
 * The dispatch is an exhaustive switch rather than an `if` chain so that adding
 * a third kind to `ChatOpsSupportedWorkItemProviderKind` is a *compile* error
 * here. The failure mode a fall-through would produce is the worst one this
 * function has: a session silently scanned and commented on through whichever
 * adapter the last branch happened to build.
 */
async function createProviderCommentPort(
  session: ResolvedSession,
  identity: ChatOpsProviderIdentity,
  cwd: string | undefined,
  deps: ChatOpsScanDeps,
): Promise<ChatOpsCommentPort> {
  switch (identity.provider) {
    case "gitea-issues":
      return createGiteaCommentPort(session, identity, deps);
    case "github-issues":
      break;
    default: {
      const unsupported: never = identity.provider;
      die(
        `ChatOps has no comment port for work-item provider "${String(unsupported)}": only ` +
          `"github-issues" and "gitea-issues" are wired (docs/chatops-operations.md §2). This ` +
          `session cannot be scanned until such a comment port exists.`,
      );
    }
  }

  const auth = session.workItemProvider.auth;
  let runner: GhRunner;
  try {
    runner = await resolveGhRunner(auth, deps.runner ?? defaultGhRunner, deps.authDeps ?? {});
  } catch (err) {
    // Both a credential *configuration* defect and a failed token exchange land
    // here. Neither is a pass outcome: nothing has been read, written, or
    // posted, so this is the same class of setup error as an unknown session.
    // Falling back to ambient `gh` credentials instead would be the exact
    // substitution this resolution exists to prevent.
    die(
      redactSecrets(
        `ChatOps could not resolve ${auth.mode} credentials for work-item provider ` +
          `"${identity.provider}": ${err instanceof Error ? err.message : String(err)}`,
        [],
      ),
    );
  }

  return new GhChatOpsCommentPort({
    runner,
    owner: identity.providerOwner,
    repo: identity.providerRepo,
    cwd: cwd ?? session.repoRoot,
  });
}

/**
 * The Gitea comment port for a `gitea-issues` identity (issue #1032).
 *
 * Three things are deliberately taken from `identity` rather than re-read from
 * the session block: the endpoint, the owner, and the repo. They are the same
 * values `chatOpsIdentityKey` scopes every cursor, ledger row, fence and
 * epoch-witness record by, so reading them twice from two places is how a pass
 * would end up scanning one repository while recording under another. The base
 * URL that reaches the transport is therefore the *canonicalized* endpoint
 * (`docs/chatops-identity-contract.md` §4) — one spelling, one scope.
 *
 * `apiPath` has no place in the identity tuple (it is a deployment detail of how
 * the same instance is mounted, not a different instance), so it is the one
 * field read from the session's Gitea block.
 *
 * A credential that cannot be resolved is fatal here, exactly as a failed
 * GitHub App token exchange is: nothing has been read, written, or posted, so
 * it is a refusal to start rather than a pass outcome. There is no ambient
 * Gitea login to degrade to, and inventing an anonymous one would post markers
 * under no identity at all.
 */
function createGiteaCommentPort(
  session: ResolvedSession,
  identity: ChatOpsProviderIdentity,
  deps: ChatOpsScanDeps,
): ChatOpsCommentPort {
  const auth = session.workItemProvider.auth;
  let token: string;
  try {
    token = resolveGiteaToken(auth, {
      ...(deps.authDeps?.env === undefined ? {} : { env: deps.authDeps.env }),
      ...(deps.authDeps?.resolveKey === undefined ? {} : { resolveKey: deps.authDeps.resolveKey }),
    });
  } catch (err) {
    // The phrasing keeps `auth.mode` quoted deliberately: `redactGiteaSecrets`
    // rewrites a bare `token <word>` sequence, and an unquoted `api-token
    // credentials` is exactly that shape — the message would arrive reading
    // "api-token [redacted]" and name nothing an operator could act on.
    die(
      redactGiteaSecrets(
        `ChatOps could not resolve the work-item credentials for provider ` +
          `"${identity.provider}" (auth mode "${auth.mode}"): ` +
          `${err instanceof Error ? err.message : String(err)}`,
        [],
      ),
    );
  }

  const apiPath = session.workItemProvider.gitea?.apiPath;
  return new GiteaChatOpsCommentPort({
    baseUrl: identity.providerEndpoint,
    owner: identity.providerOwner,
    repo: identity.providerRepo,
    token,
    ...(apiPath === undefined ? {} : { apiPath }),
    ...(deps.giteaHttp === undefined ? {} : { http: deps.giteaHttp }),
  });
}

export async function main(argv: string[], deps: ChatOpsScanDeps = {}): Promise<void> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { contextId, sessionsPath, dbPath, maxIssues } = parsed;

  // Resolve sessionId from the context store when the caller named a context
  // instead of a session — the shape the generated child workflow uses, and the
  // same resolution `dispatch-outbox` and `run-one-phase` perform.
  //
  // This necessarily precedes the enablement gate below, because the gate needs
  // a session to read. It touches only the context table — a row the parent
  // workflow already wrote — and never ChatOps state, so a disabled session
  // still performs no ChatOps write, no provider read, and no comment post. An
  // unknown id is a setup error, not a pass outcome.
  let sessionId = parsed.sessionId;
  if (!sessionId && contextId) {
    const contextStore = new SqliteContextStore(dbPath);
    let fromStore: string | undefined;
    try {
      fromStore = contextStore.getSessionId(contextId);
    } finally {
      contextStore.close();
    }
    if (!fromStore) die(`Unknown contextId: ${contextId}`);
    sessionId = fromStore;
  }
  if (!sessionId) die("--session-id or --context-id is required");

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const session = await registry.getSessionById(sessionId);
  if (!session) die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));

  // Gate 1 (#777 §5) is checked here, not just inside runChatOpsPass: a disabled
  // session is documented as a total no-op (docs/chatops-operations.md §3, §8),
  // and everything below this line — deriving an identity, opening the ChatOps
  // and task stores, resolving credentials — is an effect. Opening a SQLite store
  // creates the database file if it is absent, so reaching the handler's gate is
  // already too late to have written nothing.
  if (!session.chatOps?.enabled) {
    const disabled = chatOpsDisabledResult(session.sessionId, describeIdentityIfDerivable(session));
    emit({ ok: true, ...disabled, ...(contextId ? { contextId } : {}) });
    return;
  }

  // A session whose work-item provider has no defined ChatOps identity cannot be
  // scoped at all (`docs/chatops-identity-contract.md` §3, §5), and a partial
  // tuple would silently share state with another session's scope. Refuse to
  // start rather than record anything under a guessed key.
  let identity: ChatOpsProviderIdentity;
  try {
    identity = deriveChatOpsProviderIdentity(session);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  // Built before the store is opened: an unsupported provider and an unusable
  // credential are both refusals to start, and a refusal that had already
  // created the database would leave state behind for a pass that never ran.
  const port = deps.port ?? (await createProviderCommentPort(session, identity, parsed.cwd, deps));

  const identityView = {
    provider: identity.provider,
    providerEndpoint: identity.providerEndpoint,
    providerOwner: identity.providerOwner,
    providerRepo: identity.providerRepo,
  };

  const store = new SqliteChatOpsStore(dbPath);
  // The stores the registered operations run against (issue #1031). Declared
  // out here so the one `finally` below closes whatever was opened, on every
  // exit including the early returns; opened lazily, on the first dispatch that
  // needs them, so an idle or maintenance-locked pass never opens either.
  let operationTasks: SqliteTaskStore | undefined;
  let operationOutbox: SqliteOutboxStore | undefined;
  try {
    // Fail closed on database maintenance before the first provider request
    // (issue #818): a `prune`/`restore` holds a file-level lock that every
    // ChatOps write refuses, so a pass started now could read comments and post
    // nothing, record nothing, and advance nothing. The store's in-transaction
    // guard is what actually enforces the exclusion — including for a lock
    // acquired mid-pass, which `runChatOpsPass` reports as `delayed` per work
    // item — and this only keeps the ordinary case from burning provider quota
    // to reach the same answer.
    if (await store.isMaintenanceLocked()) {
      const locked = chatOpsMaintenanceLockedResult(session.sessionId, identityView);
      emit({ ok: true, ...locked, ...(contextId ? { contextId } : {}) });
      return;
    }

    const identityKey = chatOpsIdentityKey(identity);
    let issueNumbers = parsed.issueNumbers;
    let truncated = false;
    let nextCursor: number | null = null;
    if (issueNumbers === undefined) {
      let resolved: ChatOpsIssueSelection;
      try {
        resolved = await resolveIssueNumbers(session, identityKey, store, dbPath, maxIssues);
      } catch (err) {
        // The rotation write is a ChatOps mutation like any other, so a
        // `prune`/`restore` that acquires the lock *after* the preflight above
        // refuses it (issue #818). Left unhandled that would leave the scheduled
        // step crashing at exit 1 — n8n reads a failed child execution as a
        // defect needing a human — for the one contention case the whole
        // `delayed` outcome exists to describe. Nothing has been scanned,
        // dispatched, or published at this point: the rotation position is
        // recorded before the pass runs, so this is the same retryable no-op the
        // preflight reports, reached a few milliseconds later.
        if (!(err instanceof MaintenanceLockedError)) throw err;
        const locked = chatOpsMaintenanceLockedResult(session.sessionId, identityView);
        emit({ ok: true, ...locked, ...(contextId ? { contextId } : {}) });
        return;
      }
      issueNumbers = resolved.issueNumbers;
      truncated = resolved.truncated;
      nextCursor = resolved.nextCursor;
    }

    // The operation registry's runtime half (issue #1031). `tool-request.run`
    // and `tool-request.resolve` are callable cores that construct nothing for
    // themselves, so this — the composition root — is where their stores, repo
    // lock and session come from. An injected registry (tests, a diagnostic
    // caller) brings its own, and a `disabled` or maintenance-locked pass has
    // already returned above without reaching this at all.
    //
    // The resolvers run per dispatch, on the trusted context `chatOpsOperationContext`
    // built from ledger-scope facts, and they route through exactly the module
    // `admin tool-request run` / `resolve` route through — so a `/grant` comment
    // executes the same guided run, on the same branch, in the same per-issue
    // worktree, under the same single-worker lock as the CLI. There is no argv
    // and no subprocess anywhere on this path.
    let registry = deps.registry;
    if (registry === undefined) {
      // Opened on first dispatch, not on entry. Most passes find nothing to
      // run, and opening a store runs its migrations — a scan that only
      // discovers, reconciles, or publishes has no business touching the task
      // and outbox schemas to reach that conclusion.
      const repoLock = new RepoLockStore(parsed.lockDir);
      const tasks = (): SqliteTaskStore => {
        if (operationTasks === undefined) operationTasks = new SqliteTaskStore(dbPath);
        return operationTasks;
      };
      const outbox = (): SqliteOutboxStore => {
        if (operationOutbox === undefined) operationOutbox = new SqliteOutboxStore(dbPath);
        return operationOutbox;
      };
      const operationDeps: ChatOpsOperationDeps = {
        toolRequestRun: (invocation) =>
          toolRequestRunOperationContext(invocation, {
            session,
            tasks: tasks(),
            outbox: outbox(),
            repoLock,
            // The lock this pass is already running inside, when it is running
            // inside one. The generated parent workflow takes the session's repo
            // lock under the very `--context-id` it then hands this CLI, and
            // releases it only after the child returns — so in the normal
            // scheduled path the lock is held, by us, for the whole pass. Without
            // this the guided run would ask for it under
            // `admin-tool-request-grant`, be refused by its own parent, and every
            // authorized `/grant` in the standard workflow would answer
            // `conflict`. Left `undefined` for a `--session-id` invocation: an
            // operator running a pass by hand is outside any critical section, so
            // a held lock there means what it always meant.
            ambientLockContextId: contextId,
            // `/grant` maps to the canonical `tool-request.run`, never to the
            // deprecated `tool-request.grant` alias
            // (`docs/chatops-operation-mapping-contract.md` §3), so the
            // operator-response record is tagged as the redesigned guided run.
            responseAction: "guided-run",
            runIdPrefix: "chatops-tool-request-run",
          }),
        toolRequestResolve: (invocation) =>
          toolRequestResolveOperationContext(invocation, {
            session,
            tasks: tasks(),
            outbox: outbox(),
            runIdPrefix: "chatops-tool-request-resolve",
          }),
      };
      registry = createChatOpsOperationRegistry(operationDeps);
    }

    const result: ChatOpsPassResult = await runChatOpsPass({
      session,
      identity,
      store,
      port,
      registry,
      issueNumbers,
    });

    emit({
      ok: true,
      ...result,
      ...(contextId ? { contextId } : {}),
      // Reported so an operator can see that this pass deliberately covered only
      // part of the session rather than finding nothing in the rest — and, since
      // the cap rotates, which work item the next pass will resume from.
      ...(truncated ? { issuesTruncated: true, maxIssues, nextIssueCursor: nextCursor } : {}),
    });
  } finally {
    store.close();
    operationTasks?.close();
    operationOutbox?.close();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    die(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  });
}
