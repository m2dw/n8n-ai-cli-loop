import type { OutboxEntry, OutboxStore, SlackNotificationPayload } from "../core/outbox.js";
import { sanitizeLegacyPrCommentBody } from "../core/outbox-visibility.js";

/** Minimal fetch-compatible function type for Slack webhook dispatch (issue #465). */
export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
import { GhWorkItemProvider } from "../providers/github/gh-work-item-provider.js";
import { GhRepoHostProvider } from "../providers/github/gh-repo-host-provider.js";
import type { GhRunner, GhRunResult } from "../providers/github/gh-runner.js";
import { defaultGhRunner } from "../providers/github/gh-runner.js";
import type { WorkItemProvider, RepoHostProvider } from "../providers/types.js";

// The injectable `gh` executor now lives with the providers; re-exported here so
// existing import sites (and the outbox dispatcher's injection seam) are stable.
export type { GhRunner, GhRunResult };
export { defaultGhRunner };

// ---------------------------------------------------------------------------
// Provider construction (provider-neutral topics)
//
// Provider-neutral outbox rows (`workitem:*`, `repohost:pr-comment`) carry a
// provider *kind* rather than assuming GitHub endpoints. The dispatcher
// constructs the matching provider from that kind via this factory instead of
// hard-coding `gh api` argv, so a future non-GitHub work-item backend (e.g.
// Gitea) is reached by registering a new factory branch — handler and outbox
// code stay unchanged. The `github-issues` / `github` kinds resolve back to the
// existing `gh` providers so GitHub behavior is preserved.
//
// A factory returns `null` for a kind it cannot build (an unimplemented
// provider). The dispatcher treats that as a retryable per-entry failure: the
// row stays pending rather than being dropped, so enabling the provider later
// drains the backlog.
// ---------------------------------------------------------------------------

export interface OutboxProviderFactory {
  /** Build a WorkItemProvider for a provider kind, or null when unsupported. */
  workItem(provider: string, repo: string, cwd: string, runner: GhRunner): WorkItemProvider | null;
  /** Build a RepoHostProvider for a provider kind, or null when unsupported. */
  repoHost(provider: string, repo: string, cwd: string, runner: GhRunner): RepoHostProvider | null;
}

/**
 * The default factory: GitHub is the only wired backend today. `github-issues`
 * and `github` map to the `gh`-backed providers; every other kind is reported
 * as unsupported (null) so its rows stay pending instead of being mis-dispatched
 * to GitHub.
 */
export const defaultOutboxProviderFactory: OutboxProviderFactory = {
  workItem(provider, repo, cwd, runner) {
    if (provider === "github-issues") return new GhWorkItemProvider(runner, repo, cwd);
    return null;
  },
  repoHost(provider, repo, cwd, runner) {
    if (provider === "github") return new GhRepoHostProvider(runner, repo, cwd);
    return null;
  },
};

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface DispatchResult {
  dispatched: number;
  failed: number;
  errors: Array<{ id: number; error: string }>;
}

export interface DispatchOptions {
  cwd: string;
  limit?: number;
  now?: string;
  /**
   * Optional predicate restricting which pending entries this invocation owns.
   * Used to scope a session-bound dispatch to that session's repo so its runner
   * (e.g. a GitHub App installation token) is never applied to another session's
   * repo rows in a shared DB. Non-matching entries are left pending (retryable)
   * for the run that owns them. When omitted, every pending entry is dispatched.
   */
  filter?: (entry: OutboxEntry) => boolean;
  /**
   * Provider factory used to construct the work-item / repo-host provider for
   * provider-neutral topics. Defaults to {@link defaultOutboxProviderFactory}
   * (GitHub only). Injected in tests to dispatch through a fake provider.
   */
  providers?: OutboxProviderFactory;
  /**
   * Runner used for repo-host rows (`repohost:pr-comment`), which publish to the
   * public repo host and so must dispatch with repo-host credentials. In a
   * split-auth session those differ from the work-item credentials carried by
   * `runner` (used for `workitem:*` and legacy `gh:*` rows): the repo-host runner
   * is resolved from `repoHostProvider.auth` while `runner` is resolved from
   * `workItemProvider.auth`. Defaults to `runner` when omitted, preserving
   * single-auth behavior. Like `runner`, a factory is resolved lazily and only
   * when a repo-host row is actually pending.
   */
  repoHostRunner?: GhRunnerResolver;
  /**
   * Fetch implementation for Slack webhook dispatch (issue #465). Defaults to
   * `globalThis.fetch`. Injectable for testing without network access.
   */
  fetchImpl?: FetchFn;
  /**
   * Environment variable map used to resolve the Slack webhook URL at dispatch
   * time (issue #465). Defaults to `process.env`. Injectable so tests can
   * supply webhook URLs without mutating the process environment.
   */
  env?: Record<string, string | undefined>;
}

/**
 * A `gh` executor, or a factory that resolves one. A factory is invoked only once
 * there is pending work, so an empty outbox never triggers credential resolution
 * (e.g. a GitHub App installation-token exchange) or its associated API call.
 */
export type GhRunnerResolver = GhRunner | (() => Promise<GhRunner>);

/**
 * Drain pending outbox entries, calling the appropriate `gh` command for each.
 *
 * - On success: marks the entry as sent.
 * - On failure: leaves the entry un-sent (retryable on next call).
 * - Duplicate idempotency keys are never re-sent (INSERT OR IGNORE at enqueue time).
 *
 * When `runner` is a factory it is resolved lazily — only after pending entries
 * are found — so an empty outbox exits successfully without resolving credentials.
 *
 * `runner` dispatches work-item rows (`workitem:*`, legacy `gh:*`); repo-host
 * rows (`repohost:pr-comment`) dispatch through `opts.repoHostRunner` (defaulting
 * to `runner`). In a split-auth session those resolve from different provider
 * auth configs, so a public PR comment is never posted under work-item
 * credentials. Each is resolved at most once and only when its domain has a
 * pending row.
 */
export async function dispatchOutbox(
  outboxStore: OutboxStore,
  runner: GhRunnerResolver,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const limit = opts.limit ?? 50;
  // Apply the ownership filter *before* the limit. If we fetched only `limit`
  // rows first, a shared DB with `limit` older pending rows for other repos
  // ahead of this session's rows would fill the entire fetch window; those rows
  // would all be filtered out and this session's own pending entries would never
  // be reached — starving it across repeated runs. So when a filter is present
  // we fetch every pending row, drop the ones this invocation does not own (e.g.
  // another session's repo rows, which stay pending for the run that owns them
  // and never get dispatched under the wrong identity), and only then cap to
  // `limit`. Without a filter the store-side limit already bounds the fetch.
  const fetched = await outboxStore.listPending(opts.filter ? undefined : limit);
  const owned = opts.filter ? fetched.filter(opts.filter) : fetched;
  const pending = owned.length > limit ? owned.slice(0, limit) : owned;
  const now = opts.now ?? new Date().toISOString();
  let dispatched = 0;
  let failed = 0;
  const errors: DispatchResult["errors"] = [];

  // Nothing to dispatch: return before resolving the runner so an empty (or
  // fully filtered-out) outbox never performs credential resolution or any
  // GitHub side effect.
  if (pending.length === 0) {
    return { dispatched, failed, errors };
  }

  const providers = opts.providers ?? defaultOutboxProviderFactory;

  // Resolve the two auth domains' runners independently. Repo-host rows
  // (`repohost:pr-comment`) publish to the public repo host and must use
  // repo-host credentials, which in a split-auth session differ from the
  // work-item credentials used for `workitem:*` / legacy `gh:*` rows. Each runner
  // is resolved at most once, and only when a row of its domain is actually
  // pending, so a run carrying only one domain's rows never resolves (or
  // token-exchanges) the other — and a fatal auth *configuration* error surfaces
  // here, before any row is dispatched. `repoHostRunner` defaults to the
  // work-item `runner` for single-auth sessions and existing callers.
  const resolve = async (r: GhRunnerResolver): Promise<GhRunner> =>
    typeof r === "function" ? await r() : r;
  const workItemRunner = pending.some((e) => !isRepoHostEntry(e) && !isSlackEntry(e))
    ? await resolve(runner)
    : undefined;
  const repoHostRunner = pending.some(isRepoHostEntry)
    ? await resolve(opts.repoHostRunner ?? runner)
    : undefined;

  const fetchImpl: FetchFn = opts.fetchImpl ?? (globalThis as unknown as { fetch: FetchFn }).fetch;
  const env = opts.env ?? process.env;
  for (const entry of pending) {
    // Pick the runner for this row's auth domain. The selected runner is
    // guaranteed resolved: its domain was detected as pending above. Slack notification rows
    // (`slack:notification`) use `fetch` directly and never need a runner — they
    // are given `undefined` so a Slack-only batch never triggers credential
    // resolution (e.g. a GitHub App token exchange) for an unrelated auth domain.
    const entryRunner = isRepoHostEntry(entry) ? repoHostRunner : isSlackEntry(entry) ? undefined : workItemRunner;
    // Constructing a row's provider can throw, not just its dispatch: a provider
    // factory that resolves credentials lazily while building its client (e.g. the
    // `gitea` repo-host factory, whose client builder throws when the configured
    // API-token env var is unset) raises synchronously from inside
    // `dispatchEntry`. Catch it here and record a retryable per-entry failure so
    // the dispatcher always returns a structured result. Letting it propagate
    // would abort the drain mid-loop — after earlier rows were already marked
    // sent — and surface as an uncaught stack trace, breaking the single-JSON /
    // deterministic-exit contract n8n depends on. The row stays pending and the
    // (secret-free, config-reference) message is reported, so fixing the config
    // and re-running drains it.
    let result: Awaited<ReturnType<typeof dispatchEntry>>;
    try {
      result = await dispatchEntry(entry, entryRunner, opts.cwd, providers, fetchImpl, env);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok) {
      await outboxStore.markSent(entry.id, now);
      dispatched++;
    } else {
      failed++;
      errors.push({ id: entry.id, error: result.error });
    }
  }

  return { dispatched, failed, errors };
}

/**
 * Whether an outbox row belongs to the repo-host auth domain (a public-repo-host
 * publication) rather than the work-item domain. Used to route each row to the
 * runner resolved from the matching provider auth.
 *
 * Two row shapes qualify:
 *  - the provider-neutral `repohost:pr-comment` topic enqueued by the current
 *    code; and
 *  - legacy PR-timeline rows enqueued by the *old* code as `gh:comment` with the
 *    trailing `:pr` idempotency-key token (see {@link isLegacyPrCommentEntry}).
 *
 * The legacy case matters on upgrade: a PR comment queued before the split-auth
 * change still has topic `gh:comment`, so without this check it would be treated
 * as a work-item row and dispatched under work-item credentials (or stranded for
 * a non-GitHub work-item session). Classifying it here makes split-auth routing
 * apply to already-queued PR comments too — the row is dispatched with the
 * repo-host runner, posting the public PR comment under repo-host credentials.
 */
function isRepoHostEntry(entry: OutboxEntry): boolean {
  return (
    entry.payload.topic === "repohost:pr-comment" ||
    entry.payload.topic === "repohost:pr-summary" ||
    isLegacyPrCommentEntry(entry)
  );
}

/**
 * Whether an outbox row is a legacy PR-timeline comment enqueued by the pre-
 * split-auth code: topic `gh:comment` with an idempotency key ending in the `:pr`
 * token. That suffix was appended only to the review-phase PR-timeline enqueue
 * (`…:gh:comment:<phase>:<result>:pr`); no other `gh:comment` key ends in `:pr`,
 * so the token unambiguously distinguishes a PR comment from an issue comment.
 * Such a row carries the PR number in `payload.issueNumber` and still dispatches
 * through the `gh:comment` case — only its auth domain is reclassified.
 */
function isLegacyPrCommentEntry(entry: OutboxEntry): boolean {
  return entry.payload.topic === "gh:comment" && entry.idempotencyKey.endsWith(":pr");
}

/**
 * Whether an outbox row belongs to the Slack notification domain. Slack rows
 * dispatch via `fetch` only and never require a GitHub runner, so they must be
 * excluded from the work-item runner resolution check: a Slack-only batch
 * should not trigger a GitHub App token exchange or any GitHub auth side-effect.
 */
function isSlackEntry(entry: OutboxEntry): boolean {
  return entry.payload.topic === "slack:notification";
}

// ---------------------------------------------------------------------------
// Per-entry dispatch
// ---------------------------------------------------------------------------

async function dispatchEntry(
  entry: OutboxEntry,
  runner: GhRunner | undefined,
  cwd: string,
  providers: OutboxProviderFactory,
  fetchImpl: FetchFn,
  env: Record<string, string | undefined>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { payload } = entry;
  const repo = `${payload.owner}/${payload.repo}`;

  switch (payload.topic) {
    // -----------------------------------------------------------------------
    // Legacy GitHub-specific topics — dispatch directly against GitHub Issues,
    // preserving the exact `gh` argv. Unchanged so existing sessions keep their
    // observable behavior.
    // -----------------------------------------------------------------------
    case "gh:comment": {
      const provider = new GhWorkItemProvider(runner!, repo, cwd);
      // A legacy PR-timeline row (queued by pre-split-auth code with the `:pr`
      // idempotency token) is a public Tier 2 comment whose stored body may
      // carry a raw review reason/excerpt the visibility policy now keeps off
      // public PR comments. Rebuild a public-safe summary before posting it.
      // Plain issue-side `gh:comment` rows are Tier 1 and dispatched unchanged.
      const body = isLegacyPrCommentEntry(entry)
        ? sanitizeLegacyPrCommentBody(payload.body)
        : payload.body;
      return provider.commentItem(payload.issueNumber, body);
    }
    case "gh:label:add": {
      const provider = new GhWorkItemProvider(runner!, repo, cwd);
      return provider.transitionItem(payload.issueNumber, { kind: "add-label", label: payload.label });
    }
    case "gh:label:remove": {
      const provider = new GhWorkItemProvider(runner!, repo, cwd);
      return provider.transitionItem(payload.issueNumber, { kind: "remove-label", label: payload.label });
    }

    // -----------------------------------------------------------------------
    // Provider-neutral topics — construct the provider from the configured kind
    // and route through the WorkItemProvider / RepoHostProvider interface.
    // -----------------------------------------------------------------------
    case "workitem:comment": {
      const provider = providers.workItem(payload.provider, repo, cwd, runner!);
      if (!provider) return unsupportedProvider("work-item", payload.provider);
      return provider.commentItem(payload.issueNumber, payload.body);
    }
    case "workitem:transition": {
      const provider = providers.workItem(payload.provider, repo, cwd, runner!);
      if (!provider) return unsupportedProvider("work-item", payload.provider);
      return provider.transitionItem(payload.issueNumber, payload.transition);
    }
    case "repohost:pr-comment": {
      const provider = providers.repoHost(payload.provider, repo, cwd, runner!);
      if (!provider) return unsupportedProvider("repo-host", payload.provider);
      return provider.commentPullRequest(String(payload.prNumber), payload.body);
    }

    case "repohost:pr-summary": {
      const provider = providers.repoHost(payload.provider, repo, cwd, runner!);
      if (!provider) return unsupportedProvider("repo-host", payload.provider);
      return provider.upsertStickyPrComment(payload.prNumber, payload.marker, payload.body);
    }

    case "slack:notification": {
      return dispatchSlackNotification(payload, fetchImpl, env);
    }

    default: {
      const never: never = payload;
      return { ok: false, error: `Unknown outbox topic: ${(never as OutboxEntry["payload"]).topic}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Slack webhook dispatch (issue #465)
// ---------------------------------------------------------------------------

/**
 * Build a concise Slack message body from a `slack:notification` outbox payload.
 * Only public-safe fields are included — no local paths, no secrets, no raw
 * agent output. The webhook URL is resolved from the env var at dispatch time
 * and never stored; `payload.webhookUrlEnv` is just its name.
 */
function buildSlackMessage(payload: SlackNotificationPayload): Record<string, unknown> {
  const header = payload.transition === "failed"
    ? `*Failed* — issue #${payload.issueNumber} (session: \`${payload.sessionId}\`)`
    : `*Ready for human* — issue #${payload.issueNumber} (session: \`${payload.sessionId}\`)`;
  const lines: string[] = [
    header,
    `Phase: \`${payload.phase}\``,
  ];
  if (payload.reason) lines.push(payload.transition === "failed" ? `Error: ${payload.reason}` : `Reason: ${payload.reason}`);
  if (payload.issueUrl) lines.push(`Issue: ${payload.issueUrl}`);
  if (payload.prUrl) lines.push(`PR: ${payload.prUrl}`);
  return { text: lines.join("\n") };
}

async function dispatchSlackNotification(
  payload: SlackNotificationPayload,
  fetchImpl: FetchFn,
  env: Record<string, string | undefined>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const webhookUrl = env[payload.webhookUrlEnv];
  if (!webhookUrl) {
    return { ok: false, error: `Slack webhook URL env var not set: ${payload.webhookUrlEnv}` };
  }
  let response: Awaited<ReturnType<FetchFn>>;
  try {
    response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildSlackMessage(payload)),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Slack webhook request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!response.ok) {
    // Read body text for the error message but cap it to avoid huge payloads
    // entering the error log. Failure to read the body is a soft error — the
    // HTTP status is still surfaced.
    let detail = "";
    try {
      detail = ` — ${(await response.text()).slice(0, 200)}`;
    } catch {
      // body unreadable — status alone is enough
    }
    return { ok: false, error: `Slack webhook returned HTTP ${response.status}${detail}` };
  }
  return { ok: true };
}

/**
 * A provider-neutral row whose kind has no wired implementation. Reported as a
 * retryable failure (not silently dropped) so the row stays pending until the
 * provider is enabled.
 */
function unsupportedProvider(role: string, provider: string): { ok: false; error: string } {
  return { ok: false, error: `Unsupported ${role} provider: ${provider}` };
}
