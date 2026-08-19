/**
 * ChatOps provider identity and state namespace (issue #780).
 *
 * This module defines what tuple of values identifies "one session's view of
 * one work item on one provider," and derives the string keys a durable
 * cursor or ledger row for that view would be scoped by. See
 * `docs/chatops-identity-contract.md` for the full contract, including what
 * is deliberately *not* here (cursor advancement, pagination, claim/dispatch/
 * ack, restore semantics — tracked by issues #781-#785, #697, #915-#919,
 * #722).
 *
 * Every exported function is pure and total over its documented input shape:
 * no I/O, no clock, no randomness, no store access.
 */

/**
 * Work-item provider kinds this contract defines a canonical endpoint and
 * identity for. A superset, `WorkItemProviderKind` (`src/core/session.ts`),
 * also includes `"jira"`, `"azure-devops"`, and `"bitbucket"` — reserved
 * identifiers with neither a runtime `WorkItemProvider` nor a defined
 * endpoint-canonicalization rule (contract §3). Deriving a ChatOps identity
 * for one of those is undefined and {@link deriveChatOpsProviderIdentity}
 * throws.
 */
export type ChatOpsSupportedWorkItemProviderKind = "github-issues" | "gitea-issues";

const SUPPORTED_PROVIDERS = new Set<string>(["github-issues", "gitea-issues"]);

/**
 * GitHub's work-item (Issues) API has no session-configurable endpoint, so
 * every `github-issues` session shares this fixed `providerEndpoint`
 * (contract §4).
 */
export const GITHUB_ISSUES_PROVIDER_ENDPOINT = "github.com";

/**
 * The canonical ChatOps provider identity tuple (contract §2): "one
 * session's view of one work item on one provider." Every field is required
 * — {@link deriveChatOpsProviderIdentity} never returns a tuple with an
 * empty-string or placeholder field.
 */
export interface ChatOpsProviderIdentity {
  /** The session's own canonical id — never `sessionNo` or an alias. */
  sessionId: string;
  /** The work-item tracker provider kind. Never a `RepoHostProviderKind` value (contract §3). */
  provider: ChatOpsSupportedWorkItemProviderKind;
  /** Canonical API endpoint (contract §4). Fixed for `github-issues`; canonicalized `baseUrl` for `gitea-issues`. */
  providerEndpoint: string;
  /** Owning org/user of the work-item container. */
  providerOwner: string;
  /** Repository name of the work-item container. */
  providerRepo: string;
}

/**
 * Canonicalize a Gitea instance base URL into the form {@link ChatOpsProviderIdentity.providerEndpoint}
 * uses for `gitea-issues` (contract §4).
 *
 * `new URL()` parsing alone already lowercases the scheme and host and drops
 * an explicit port equal to the scheme's default (WHATWG URL semantics), so
 * this collapses host/scheme case and default-port spellings without extra
 * work. Stripping `href`'s trailing `/` (always present for a root path)
 * additionally collapses a trailing slash, including one on a mounted
 * sub-path.
 *
 * @throws Error if `baseUrl` does not parse as a URL, is not http(s), embeds
 * userinfo, or carries a query string or fragment — all treated as an
 * incomplete/invalid endpoint (contract §5), never silently dropped or
 * defaulted.
 */
export function canonicalizeGiteaEndpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // Never echo `baseUrl` here: an unparseable value may still embed
    // credentials (e.g. malformed userinfo), and this error must not leak them.
    throw new Error("ChatOps Gitea endpoint is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // Same reasoning as above: a non-http(s) URL (e.g. `ftp://user:token@host`)
    // can carry userinfo, so this must not echo `baseUrl` either.
    throw new Error("ChatOps Gitea endpoint must be an http(s) URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("ChatOps Gitea endpoint must not embed credentials (user:password@host)");
  }
  if (url.search !== "" || url.hash !== "" || url.href.includes("?") || url.href.includes("#")) {
    throw new Error("ChatOps Gitea endpoint must not carry a query string or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * The subset of a resolved session's fields {@link deriveChatOpsProviderIdentity}
 * needs. Deliberately narrower than `ResolvedSession` (`src/core/session.ts`)
 * so this module stays dependency-light and pure, mirroring
 * `OutboxOwnershipScope` in `src/core/outbox-scan-cursor.ts`.
 */
export interface ChatOpsIdentitySource {
  sessionId: string;
  /** The work-item provider kind and its connection config (`ResolvedSession.workItemProvider`). */
  workItemProvider: {
    provider: string;
    gitea?: { baseUrl: string; owner: string; repo: string };
  };
  /** GitHub owner/repo, resolved from `githubRepo` (`ResolvedSession.githubOwner` / `.githubName`). */
  githubOwner: string;
  githubName: string;
}

/**
 * Derive the canonical {@link ChatOpsProviderIdentity} for a session's
 * *current* `workItemProvider` config (contract §2, §5).
 *
 * Pure and fail-closed: never returns a partial tuple. Throws when the
 * provider kind is unsupported (§3) or the provider-specific connection
 * fields needed to complete the tuple are missing or invalid (§5).
 */
export function deriveChatOpsProviderIdentity(session: ChatOpsIdentitySource): ChatOpsProviderIdentity {
  if (!session.sessionId) {
    throw new Error("ChatOps identity: session is missing sessionId");
  }

  const provider = session.workItemProvider.provider;
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(
      `ChatOps identity is undefined for work-item provider "${provider}": only ` +
        `"github-issues" and "gitea-issues" have a defined provider-endpoint ` +
        `canonicalization (docs/chatops-identity-contract.md §3)`,
    );
  }

  if (provider === "github-issues") {
    if (!session.githubOwner || !session.githubName) {
      throw new Error("ChatOps identity: github-issues session is missing githubOwner/githubName");
    }
    return {
      sessionId: session.sessionId,
      provider: "github-issues",
      providerEndpoint: GITHUB_ISSUES_PROVIDER_ENDPOINT,
      providerOwner: session.githubOwner,
      providerRepo: session.githubName,
    };
  }

  const gitea = session.workItemProvider.gitea;
  if (!gitea) {
    throw new Error("ChatOps identity: gitea-issues session is missing its gitea connection config");
  }
  if (!gitea.owner || !gitea.repo) {
    throw new Error("ChatOps identity: gitea-issues session is missing its gitea owner/repo");
  }
  return {
    sessionId: session.sessionId,
    provider: "gitea-issues",
    providerEndpoint: canonicalizeGiteaEndpoint(gitea.baseUrl),
    providerOwner: gitea.owner,
    providerRepo: gitea.repo,
  };
}

/**
 * Opaque string key for one {@link ChatOpsProviderIdentity} (contract §6).
 * For in-memory/test scopes only — a persisted schema must use separate
 * typed columns as its primary key, not this joined string (contract §7).
 *
 * `JSON.stringify` of an array of primitive strings is injective — distinct
 * tuples always produce distinct strings — the same argument
 * `deriveOwnershipScanCursorKey` (`src/core/outbox-scan-cursor.ts`) relies on
 * for the outbox's ownership-scope key.
 */
export function chatOpsIdentityKey(identity: ChatOpsProviderIdentity): string {
  return JSON.stringify([
    identity.sessionId,
    identity.provider,
    identity.providerEndpoint,
    identity.providerOwner,
    identity.providerRepo,
  ]);
}

/**
 * Validate that `issueNumber` is a finite integer before it is folded into a
 * key. `JSON.stringify` serializes `NaN`/`Infinity`/`-Infinity` — all valid
 * `number` values in TypeScript — to `null`, which would collapse distinct
 * cursor/ledger scopes onto the same key (contract §6).
 */
function assertValidIssueNumber(issueNumber: number): void {
  if (!Number.isInteger(issueNumber)) {
    throw new Error(`ChatOps identity: issueNumber must be a finite integer, got ${issueNumber}`);
  }
}

/**
 * Opaque string key for one cursor scope: an identity plus the work item it
 * applies to (contract §6). See {@link chatOpsIdentityKey} for the injectivity
 * argument and the in-memory-only caveat.
 */
export function chatOpsCursorKey(identity: ChatOpsProviderIdentity, issueNumber: number): string {
  assertValidIssueNumber(issueNumber);
  return JSON.stringify([
    identity.sessionId,
    identity.provider,
    identity.providerEndpoint,
    identity.providerOwner,
    identity.providerRepo,
    issueNumber,
  ]);
}

/**
 * Opaque string key for one ledger (execution) scope: a cursor scope plus a
 * single comment id (contract §6). See {@link chatOpsIdentityKey} for the
 * injectivity argument and the in-memory-only caveat.
 */
export function chatOpsLedgerKey(
  identity: ChatOpsProviderIdentity,
  issueNumber: number,
  commentId: string,
): string {
  assertValidIssueNumber(issueNumber);
  return JSON.stringify([
    identity.sessionId,
    identity.provider,
    identity.providerEndpoint,
    identity.providerOwner,
    identity.providerRepo,
    issueNumber,
    commentId,
  ]);
}
