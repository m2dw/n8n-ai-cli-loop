#!/usr/bin/env node
/**
 * dispatch-outbox — flush pending GitHub side effects from the SQLite outbox.
 *
 * n8n command shape:
 *   node /path/to/dist/cli/dispatch-outbox.js \
 *     --session-id "addon-dev" \
 *     --db-path "/path/to/dev_loop.db"
 *
 * Exit codes:
 *   0 — normal: empty outbox, full success, partial GitHub failures
 *       (failures stay retryable and are reported in JSON), or a held
 *       maintenance lock (`outcome: "maintenance_locked"`, issue #818 — no
 *       row claimed, no external side effect, everything stays pending)
 *   1 — setup error: bad args, unknown session, missing sessions file,
 *       invalid limit
 *
 * Emits exactly one JSON object to stdout.
 */

import { statSync } from "fs";
import {
  JsonSessionRegistry,
  DEFAULT_SESSIONS_PATH,
  describeUnresolvedSessionId,
} from "../registries/json-session-registry.js";
import { SqliteOutboxStore, DEFAULT_DB_PATH } from "../stores/sqlite-outbox-store.js";
import { SqliteContextStore } from "../stores/sqlite-context-store.js";
import { dispatchOutbox, defaultGhRunner, defaultOutboxProviderFactory } from "../handlers/gh-dispatcher.js";
import { deriveOwnershipScanCursorKey } from "../core/outbox-scan-cursor.js";
import type { GhRunner, OutboxProviderFactory } from "../handlers/gh-dispatcher.js";
import { GiteaRepoHostProvider } from "../providers/gitea/gitea-repo-host-provider.js";
import { defaultGiteaClientBuilder } from "../providers/repo-host-factory.js";
import {
  resolveGhRunner,
  redactSecrets,
  GitHubAuthConfigError,
} from "../providers/github/github-app-auth.js";
import type { GhRunnerAuthDeps } from "../providers/github/github-app-auth.js";
import { GiteaWorkItemProvider } from "../providers/gitea/gitea-work-item-provider.js";
import {
  resolveGiteaToken,
  redactGiteaSecrets,
  defaultGiteaHttp,
} from "../providers/gitea/gitea-client.js";
import type { GiteaHttpRequest } from "../providers/gitea/gitea-client.js";
import type { ProviderAuthConfig } from "../core/session.js";
import type { WorkItemProvider } from "../providers/types.js";
import { fileURLToPath } from "url";
import { emit, die } from "./cli-io.js";
import { tokenizeArgs } from "./admin-command.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  sessionId: string | undefined;
  contextId: string | undefined;
  sessionsPath: string;
  dbPath: string;
  limit: number;
  cwd: string | undefined;
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["session-id", "context-id", "sessions-path", "db-path", "limit", "cwd"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;

  // Validate limit
  let limit = 50;
  if (args["limit"] !== undefined) {
    const parsed = Number(args["limit"]);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { error: `--limit must be a positive integer, got: ${args["limit"]}` };
    }
    limit = parsed;
  }

  return {
    sessionId: args["session-id"],
    contextId: args["context-id"],
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"] ?? DEFAULT_DB_PATH,
    limit,
    cwd: args["cwd"],
  };
}

/**
 * A WorkItemProvider whose every mutation fails with a fixed, already-redacted
 * message. Used when the Gitea API token cannot be resolved: Gitea rows then
 * surface as retryable per-entry failures (staying pending) instead of being
 * dropped or silently routed to GitHub. The read methods are present only for
 * interface completeness; the outbox dispatcher invokes comment/transition only.
 */
function failingWorkItemProvider(message: string): WorkItemProvider {
  return {
    listCandidateItems() {
      throw new Error(message);
    },
    getItem() {
      return { ok: false, error: message };
    },
    async getDependencies() {
      throw new Error(message);
    },
    commentItem() {
      return { ok: false, error: message };
    },
    transitionItem() {
      return { ok: false, error: message };
    },
  };
}

// ---------------------------------------------------------------------------
// Main — exported for testing with injectable runner
// ---------------------------------------------------------------------------

export async function main(
  argv: string[],
  runner: GhRunner = defaultGhRunner,
  authDeps: GhRunnerAuthDeps = {},
  giteaHttp: GiteaHttpRequest = defaultGiteaHttp,
): Promise<void> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { contextId, sessionsPath, dbPath, limit, cwd: cwdOverride } = parsed;
  let { sessionId } = parsed;

  // Resolve sessionId from context store when --context-id is provided without --session-id
  if (!sessionId && contextId) {
    const ctxStore = new SqliteContextStore(dbPath);
    let fromStore: string | undefined;
    try {
      fromStore = ctxStore.getSessionId(contextId);
    } finally {
      ctxStore.close();
    }
    if (!fromStore) die(`Unknown contextId: ${contextId}`);
    sessionId = fromStore;
  }

  // Resolve cwd: explicit --cwd beats session.repoRoot beats undefined (dispatcher will still work)
  let cwd = cwdOverride;
  // Factory for the `gh` executor used to drain the outbox. Defaults to the
  // injected runner (operator `gh` session / test fake); replaced below with a
  // GitHub App token-injecting resolver when the session's work-item provider
  // opts into it. It is passed to dispatchOutbox() and invoked lazily, so a
  // `github-app` session with an empty outbox never resolves/exchanges a token —
  // matching the contract that an empty outbox exits successfully without GitHub
  // side effects, and surviving a transient token-exchange outage.
  let resolveRunner: () => Promise<GhRunner> = async () => runner;
  // Repo-host rows (`repohost:pr-comment`) publish to the public repo host and so
  // must dispatch with repo-host credentials, which differ from the work-item
  // credentials in a split-auth session. Resolved from `repoHostProvider.auth`
  // (parallel to `resolveRunner` for the work-item domain) and handed to
  // dispatchOutbox, which invokes it only when a repo-host row is actually
  // pending. Left undefined when no session is resolved OR when the session did
  // not explicitly configure `repoHostProvider`, so dispatchOutbox falls back to
  // the work-item runner — the existing single-auth behavior (see below).
  let resolveRepoHostRunner: (() => Promise<GhRunner>) | undefined;
  // When a session is resolved, only dispatch outbox rows that belong to that
  // session's repo (set below). In a shared DB with pending rows from more than
  // one session, this keeps session A's runner — a GitHub App installation token
  // scoped to A's repo — from dispatching session B's rows under the wrong
  // identity; B's rows stay pending until B's own dispatch run drains them.
  let entryFilter: ((entry: { payload: { owner: string; repo: string } }) => boolean) | undefined;
  // Scopes the persisted scan cursor to this session (issue #606 review
  // follow-up) so repeated runs eventually advance past a large shared due
  // backlog that doesn't belong to this session, instead of re-scanning the
  // same non-matching prefix from row 1 every time. Set alongside `entryFilter`
  // below, since a cursor is only meaningful together with a filter. The key
  // also folds in the resolved ownership scope (githubOwner/githubName and,
  // for a Gitea work-item session, the Gitea owner/repo/baseUrl) — not just
  // `sessionId` — so that if an operator repoints a session's GitHub or Gitea
  // repository configuration, the cursor for the *old* scope is orphaned
  // rather than reused under the new `entryFilter`. Reusing a stale cursor
  // here would be wrong: rows for the new target sitting below the old
  // cursor's position would have been confirmed non-matching (foreign) under
  // the old filter and so are permanently skipped by `id > afterId`, even
  // though they match the new one (P2 review follow-up to issue #606). An
  // orphaned old-scope cursor row is harmless — it is simply never looked up
  // again once the key changes.
  let scanCursorKey: string | undefined;
  // Provider factory for provider-neutral outbox rows. Left undefined for
  // GitHub-only sessions so dispatchOutbox uses its default (GitHub) factory
  // unchanged. A session-bound factory is built below when the session selects
  // Gitea for either domain: a `gitea` repo host routes `repohost:pr-comment`
  // rows through the REST-backed Gitea provider, and a `gitea-issues` work-item
  // provider routes `workitem:*` rows through the Gitea WorkItemProvider — each
  // delegating the other (and every GitHub) kind to the default factory so a
  // fully-Gitea session dispatches both domains over Gitea.
  let providerFactory: OutboxProviderFactory | undefined;

  if (sessionId) {
    // Load the session to resolve the configured provider auth (and repoRoot when
    // --cwd was not given). This must run even when --cwd is provided: an explicit
    // cwd only overrides the working directory, it does not waive a configured
    // `github-app` work-item auth, so a manual retry with --cwd still dispatches
    // as the App rather than falling back to the operator's `gh` session.
    let registry: JsonSessionRegistry;
    try {
      registry = new JsonSessionRegistry(sessionsPath);
    } catch (err) {
      die(
        `Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const session = await registry.getSessionById(sessionId);
    if (!session) {
      die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));
    }
    // Explicit --cwd wins; otherwise fall back to the session's repoRoot.
    if (!cwd) cwd = session.repoRoot;
    // Scope dispatch to this session's repo so its runner is never applied to
    // another session's repo rows (see entryFilter declaration above). A
    // split-provider Gitea session owns two (owner, repo) pairs: the GitHub repo
    // for `repohost:*` PR rows and the Gitea repo for `workitem:*` rows, so both
    // are matched here.
    const { githubOwner, githubName } = session;
    const gitea =
      session.workItemProvider?.provider === "gitea-issues" ? session.workItemProvider.gitea : undefined;
    entryFilter = (entry) => {
      const { owner, repo } = entry.payload;
      if (owner === githubOwner && repo === githubName) return true;
      if (gitea && owner === gitea.owner && repo === gitea.repo) return true;
      return false;
    };
    // Derived by the one shared, injective derivation (issue #819) rather than
    // built inline here, so the ownership scope the CLI computes and the three
    // per-role keys the dispatcher reads/writes can never drift apart. See
    // `docs/outbox-scan-cursor-contract.md`.
    scanCursorKey = deriveOwnershipScanCursorKey({
      sessionId,
      githubOwner,
      githubName,
      ...(gitea ? { gitea: { owner: gitea.owner, repo: gitea.repo, baseUrl: gitea.baseUrl } } : {}),
    });
    // Wire the session's configured provider auth (GitHub App when set) into the
    // dispatcher runners so outbox side effects run as the App; `gh` mode returns
    // the injected runner unchanged. The runner refreshes its token per
    // invocation. Resolution is deferred to dispatch time (only when there is
    // pending work of the matching domain) so an empty outbox never exchanges a
    // token. The work-item domain (comments / labels / transitions) uses
    // `workItemProvider.auth`; the repo-host domain (public PR comments) uses
    // `repoHostProvider.auth` ONLY when the session explicitly configured a
    // repoHostProvider. They are equivalent in a single-auth session and differ
    // in a split-auth one, where each domain must dispatch under its own
    // credentials rather than borrowing the other's.

    // A runner that fails every invocation with a redacted message. Used to keep
    // outbox rows pending (each invocation surfaces as a retryable per-entry
    // failure) instead of dispatching them when no usable runner can be resolved.
    const failingRunner = (message: string): GhRunner => ({
      run: () => ({ exitCode: 1, stdout: "", stderr: redactSecrets(message, []) }),
    });

    // `isGitHubProvider` gates GitHub credential resolution to GitHub-backed
    // provider kinds only (`github-issues` work items / `github` repo host).
    // Resolving GitHub auth for a non-GitHub kind would be both pointless (no
    // wired backend exists) and harmful: a non-`gh` auth mode
    // (`api-token`/`github-app`) would raise a fatal `Unsupported GitHub provider
    // auth mode` setup error (exit 1), wrongly turning a retryable
    // unsupported-provider row into a hard failure. For a non-GitHub kind the
    // resolver short-circuits to a failing runner instead (see below).
    const makeResolver = (
      auth: ProviderAuthConfig,
      isGitHubProvider: boolean,
      providerKind: string,
      role: string,
    ) => async (): Promise<GhRunner> => {
      // A recognized-but-unwired non-GitHub provider kind (e.g. "jira") has no
      // GitHub credentials to resolve. Provider-neutral rows (`workitem:*` /
      // `repohost:pr-comment`) are already held pending by the dispatcher's
      // provider factory — it returns null, surfaced as a retryable
      // unsupported-provider failure — without ever invoking this runner. But
      // legacy GitHub-specific rows (`gh:comment` / `gh:label:*`) bypass that
      // factory and dispatch through this runner directly: returning the operator
      // `gh` runner here would publish private work-item side effects to the
      // public GitHub repo under operator credentials — exactly the split-provider
      // leak this change guards against. Return a failing runner so those legacy
      // rows stay pending (retryable), mirroring the provider-neutral path.
      if (!isGitHubProvider) {
        return failingRunner(`Unsupported ${role} provider: ${providerKind}`);
      }
      try {
        return await resolveGhRunner(auth, runner, authDeps);
      } catch (err) {
        // A permanent auth *configuration* error (unsupported `api-token` mode, a
        // missing `*Env`, an unreadable/empty private key) is not a dispatch
        // failure: retrying never fixes it without operator action. Downgrading it
        // to per-entry retryable errors would leave the rows pending forever while
        // the CLI exits 0, hiding the broken setup from n8n. Re-throw so it
        // propagates to die() as a fatal setup error (exit 1) — and do it before
        // dispatchOutbox touches any row, so nothing is marked sent or failed.
        if (err instanceof GitHubAuthConfigError) throw err;
        // Otherwise this is a transient GitHub installation-token exchange failure
        // (a network error or a GitHub 5xx). die()ing here would exit before
        // dispatchOutbox can report retryable per-entry failures, so n8n would see
        // a fatal setup/phase failure instead of a normal retryable drain. Instead,
        // return a runner that fails every pending entry — leaving each row un-sent
        // (retryable) and exiting 0 with failed/errors, matching the contract that
        // GitHub dispatch failures stay pending. The upstream message is built from
        // status lines and already redacted; failingRunner redacts again as defense
        // in depth so no token can reach stderr.
        return failingRunner(
          `GitHub App auth resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    // `github-issues` is the only wired work-item kind; treat an omitted provider
    // (registry default) as GitHub too, preserving prior behavior.
    const workItemKind = session.workItemProvider?.provider ?? "github-issues";
    const workItemIsGitHub = workItemKind === "github-issues";
    resolveRunner = makeResolver(
      session.workItemProvider?.auth ?? { mode: "gh" },
      workItemIsGitHub,
      workItemKind,
      "work-item",
    );
    // Give repo-host rows their own runner when the session EXPLICITLY configured a
    // `repoHostProvider` (tracked by the registry as `repoHostProviderConfigured`,
    // since the resolved value alone cannot reveal whether it came from the operator
    // or the default) — OR when the work-item provider is non-GitHub, because the
    // work-item fallback runner cannot serve GitHub repo-host rows in that case.
    //
    // When repoHostProvider is NOT explicitly configured and the work-item provider
    // IS GitHub/single-auth, leave resolveRepoHostRunner undefined and let
    // dispatchOutbox fall back to the work-item runner. A session that configured
    // GitHub App auth only under `workItemProvider` leaves `repoHostProvider` at the
    // registry default — dispatching `repohost:pr-comment` rows under that defaulted
    // operator `gh` would regress PR comments the App posted before the
    // work-item/repo-host auth split (and would fail outright on headless or App-only
    // runners with no `gh` login, or post as the wrong actor). The work-item runner
    // is the right identity there, so reuse it.
    //
    // But when the work-item provider is non-GitHub (e.g. `jira`) and repoHostProvider
    // is defaulted, that fallback is wrong: the work-item resolver short-circuits to a
    // FAILING runner (`Unsupported work-item provider`), which would leave the row's
    // GitHub `repohost:pr-comment` comments pending forever even though the repo host
    // is GitHub. So build a repo-host runner from the (defaulted) `github`/`gh`
    // repo-host config, keeping public PR comments dispatching under the operator
    // identity. Conversely, an EXPLICIT `github`/`gh` repo-host config is honored here
    // even though it is byte-equal to the default: its rows dispatch under the operator
    // `gh` identity rather than borrowing a divergent (e.g. App) work-item runner.
    if (session.repoHostProviderConfigured || !workItemIsGitHub) {
      resolveRepoHostRunner = makeResolver(
        session.repoHostProvider.auth,
        // `github` is the only wired repo-host kind.
        session.repoHostProvider.provider === "github",
        session.repoHostProvider.provider,
        "repo-host",
      );
    }

    // A `gitea` repo host reaches PRs over the Gitea REST API, not `gh`, so its
    // provider-neutral `repohost:pr-comment` rows cannot be built by the default
    // (GitHub-only) factory — they would surface as an "Unsupported repo-host
    // provider" failure and stay pending forever. Build a lazy builder that
    // constructs the REST-backed Gitea provider for `gitea` rows. The Gitea
    // client — and its token resolution — is built lazily, so it is created only
    // when a Gitea repo-host row is actually dispatched (never for an empty or
    // GitHub-only outbox). The PR lives in the Gitea repo addressed by the
    // connection block's owner/repo, not the GitHub owner/repo carried on the row,
    // so use the configured Gitea target. The resolved repo-host `runner` is
    // unused by the REST provider; it resolves to a failing runner for `gitea`
    // above and is harmlessly ignored.
    const repoHostProvider = session.repoHostProvider;
    let giteaRepoHostBuilder: (() => GiteaRepoHostProvider) | undefined;
    if (repoHostProvider.provider === "gitea" && repoHostProvider.gitea) {
      const giteaConfig = repoHostProvider.gitea;
      const giteaAuth = repoHostProvider.auth;
      const buildGiteaClient = defaultGiteaClientBuilder();
      giteaRepoHostBuilder = () => {
        const client = buildGiteaClient(giteaConfig, giteaAuth);
        return new GiteaRepoHostProvider(client, giteaConfig.owner, giteaConfig.repo);
      };
    }

    // Build the Gitea work-item provider for a `gitea-issues` session so
    // provider-neutral `workitem:*` rows dispatch to Gitea over its REST API,
    // while `repohost:*` PR rows continue through the configured repo host. The
    // API token is resolved from the configured `api-token` auth by indirection
    // (env var / credential key); `authDeps` supplies the test seam.
    //
    // Token resolution failures are NOT fatal here: a config error builds a
    // work-item provider whose every call fails with a redacted message, so Gitea
    // rows stay pending (retryable) and never silently fall back to GitHub — while
    // an empty outbox (the failing provider is never invoked) still exits 0.
    let giteaWorkItem: WorkItemProvider | undefined;
    if (gitea && session.workItemProvider) {
      const giteaAuth = session.workItemProvider.auth;
      try {
        const token = resolveGiteaToken(giteaAuth, {
          env: authDeps.env,
          resolveKey: authDeps.resolveKey,
        });
        giteaWorkItem = new GiteaWorkItemProvider({
          baseUrl: gitea.baseUrl,
          owner: gitea.owner,
          repo: gitea.repo,
          token,
          ...(gitea.apiPath !== undefined ? { apiPath: gitea.apiPath } : {}),
          http: giteaHttp,
        });
      } catch (err) {
        const message = redactGiteaSecrets(
          `Gitea work-item provider unavailable: ${err instanceof Error ? err.message : String(err)}`,
          [],
        );
        giteaWorkItem = failingWorkItemProvider(message);
      }
    }

    // Compose a single factory covering both Gitea roles: `workitem:gitea-issues`
    // rows route to the Gitea work-item provider and `repohost:gitea` rows to the
    // Gitea repo-host provider, while every other kind delegates to the default
    // (GitHub) factory. A fully-Gitea session exercises both branches at once.
    if (giteaWorkItem || giteaRepoHostBuilder) {
      providerFactory = {
        workItem: (provider, repo, cwd2, runner2) =>
          provider === "gitea-issues" && giteaWorkItem
            ? giteaWorkItem
            : defaultOutboxProviderFactory.workItem(provider, repo, cwd2, runner2),
        repoHost: (provider, repo, cwd2, runner2) =>
          provider === "gitea" && giteaRepoHostBuilder
            ? giteaRepoHostBuilder()
            : defaultOutboxProviderFactory.repoHost(provider, repo, cwd2, runner2),
      };
    }
  }

  // cwd is required for gh commands; fall back to process.cwd() if not resolved.
  // Validate that the resolved directory actually exists — a non-existent cwd
  // is a configuration error (not a retryable GitHub failure) so we exit 1.
  const effectiveCwd = cwd ?? process.cwd();
  if (cwd !== undefined) {
    // Only validate when cwd was explicitly provided or resolved from a session;
    // process.cwd() is always valid by definition.
    try {
      const stat = statSync(effectiveCwd);
      if (!stat.isDirectory()) {
        die(`cwd is not a directory: ${effectiveCwd}`);
      }
    } catch (err) {
      const source = cwdOverride ? "--cwd" : "session.repoRoot";
      die(
        `${source} does not exist or is not accessible: ${effectiveCwd}`,
      );
    }
  }

  const outboxStore = new SqliteOutboxStore(dbPath);
  try {
    const result = await dispatchOutbox(outboxStore, resolveRunner, {
      cwd: effectiveCwd,
      limit,
      filter: entryFilter,
      ...(scanCursorKey ? { scanCursorKey } : {}),
      repoHostRunner: resolveRepoHostRunner,
      ...(providerFactory ? { providers: providerFactory } : {}),
    });

    emit({
      ok: true,
      // Maintenance contention is an expected idle outcome, not a failure
      // (issue #818): exit 0 with a typed `outcome` so n8n treats a
      // prune/restore window like an empty outbox rather than a crashed step.
      // Nothing external happened — no comment, label, provider request, or
      // Slack post — and every row stays pending for the next run. Emitted
      // only on contention so a normal drain's JSON shape is unchanged.
      ...(result.maintenanceLocked ? { outcome: "maintenance_locked" } : {}),
      // Reported so an operator can see why this run's scan progress was not
      // persisted (issue #820 review follow-up): an `admin outbox retry` rewound
      // this identity's cursors mid-run, so the extent computed before that
      // recovery was discarded rather than written back over it. Everything
      // dispatched is still counted below; the next run simply re-scans the
      // re-opened span. Emitted only when it happened, so a normal drain's JSON
      // shape is unchanged.
      ...(result.cursorFenceStale ? { cursorFenceStale: true } : {}),
      dispatched: result.dispatched,
      failed: result.failed,
      errors: result.errors,
      deadLettered: result.deadLettered,
      ...(sessionId ? { sessionId } : {}),
      ...(contextId ? { contextId } : {}),
    });
  } catch (err) {
    // A permanent GitHub-auth configuration error surfaced from resolveRunner
    // (see above). Exit 1 as a setup failure so n8n sees a real configuration
    // problem rather than a normal dispatch run — the message is already built
    // from config references (no secrets) but redact as defense in depth.
    if (err instanceof GitHubAuthConfigError) {
      die(redactSecrets(err.message, []));
    }
    throw err;
  } finally {
    outboxStore.close();
  }
}

// ---------------------------------------------------------------------------
// Entrypoint guard
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    die(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  });
}
