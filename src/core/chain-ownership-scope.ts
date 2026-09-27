/**
 * Repository-scoped Issue identity for the dependency-chain registry (issue
 * #1045).
 *
 * An Issue number is unique only inside the repository that issued it. The
 * registry stores bare numbers — that is what GitHub Relationships, the
 * frozen-prefix snapshots, and every chain command already speak — so the
 * qualification has to come from somewhere else: the *session* a chain belongs
 * to, and the repository binding that session carries. This module owns the one
 * derivation that turns "the chain I am judging" into "every session whose
 * chains name Issues from the same repository," and nothing else:
 *
 *   - It reads no store and no file. Callers hand it the sessions they already
 *     loaded, so the scope a command computes is the scope its own session file
 *     describes.
 *   - It never widens past a repository. Two sessions bound to the same
 *     repository share one Issue-number space and must keep rejecting a doubled
 *     claim; two sessions bound to different repositories share nothing, and
 *     treating their `#697`s as the same Issue is the bug this module exists to
 *     remove.
 *   - It never fails. A session that is missing from the registry, or whose
 *     provider has no defined repository identity, falls back to the
 *     session-only scope every chain command used before this module existed —
 *     which is narrower than a repository scope, never wider, so a fallback can
 *     only miss a duplicate, never invent one.
 *
 * The resulting {@link ChainOwnershipScope.filter} is what the chain commands
 * hand to `collectChainOwnership` *and* to
 * `PutChainGraphInput.exclusiveMemberScope`, so the ownership a plan is judged
 * against and the ownership the store claims inside its write are the same
 * question asked twice.
 */

import type { ChainListFilter } from "./chain-registry.js";
import {
  canonicalizeGiteaEndpoint,
  GITHUB_ISSUES_PROVIDER_ENDPOINT,
} from "./chatops-identity.js";

/**
 * The repository an Issue number is qualified by: the tracker instance plus the
 * container inside it. Deliberately *not* the session — two sessions pointed at
 * one repository see one Issue-number space.
 *
 * The tuple mirrors `ChatOpsProviderIdentity` minus its `sessionId`, because
 * both answer the same question ("which work-item container is this?") and a
 * second, subtly different spelling of it would be a drift waiting to happen.
 */
export interface ChainRepositoryIdentity {
  /** Work-item provider kind (`github-issues`, `gitea-issues`). */
  provider: string;
  /** Canonical API endpoint: fixed for GitHub, the canonicalized base URL for Gitea. */
  endpoint: string;
  /** Owning org/user of the work-item container. */
  owner: string;
  /** Repository name of the work-item container. */
  repo: string;
}

/**
 * The subset of a resolved session this module reads. Narrower than
 * `ResolvedSession` on purpose, so the derivation stays pure and this module
 * carries no dependency on session loading — `ResolvedSession` satisfies it
 * structurally.
 */
export interface ChainOwnershipScopeSession {
  sessionId: string;
  githubOwner?: string;
  githubName?: string;
  workItemProvider?: {
    provider: string;
    gitea?: { baseUrl: string; owner: string; repo: string };
  };
}

/**
 * The repository a session's Issue numbers belong to, or `undefined` when the
 * session declares no identity this module can qualify by — an unknown provider
 * kind, or a provider whose connection block is incomplete.
 *
 * Total by design: a caller resolving a scope must not have to distinguish "no
 * binding" from "malformed binding", because both lead to the same, safe answer
 * (fall back to the session's own scope). A session with no `workItemProvider`
 * at all is GitHub Issues over `githubRepo`, which is what session resolution
 * itself defaults to.
 */
export function deriveChainRepositoryIdentity(
  session: ChainOwnershipScopeSession,
): ChainRepositoryIdentity | undefined {
  const provider = session.workItemProvider?.provider ?? "github-issues";

  if (provider === "github-issues") {
    if (!session.githubOwner || !session.githubName) return undefined;
    return {
      provider,
      endpoint: GITHUB_ISSUES_PROVIDER_ENDPOINT,
      owner: session.githubOwner,
      repo: session.githubName,
    };
  }

  if (provider === "gitea-issues") {
    const gitea = session.workItemProvider?.gitea;
    if (!gitea || !gitea.owner || !gitea.repo) return undefined;
    let endpoint: string;
    try {
      endpoint = canonicalizeGiteaEndpoint(gitea.baseUrl);
    } catch {
      return undefined;
    }
    return { provider, endpoint, owner: gitea.owner, repo: gitea.repo };
  }

  // Reserved provider kinds (`jira`, `azure-devops`, ...) have no runtime
  // provider and no defined endpoint canonicalization, so there is nothing to
  // compare two of them by.
  return undefined;
}

/**
 * Opaque equality key for a repository identity.
 *
 * `JSON.stringify` over an array of primitive strings is injective — distinct
 * tuples always produce distinct strings — the same argument
 * `chatOpsIdentityKey` relies on.
 *
 * Owner and repository are case-folded first. Both GitHub and Gitea resolve a
 * slug case-insensitively, so `M2DW/Repo` and `m2dw/repo` are one repository and
 * one Issue-number space; comparing them byte for byte would put two sessions
 * that differ only in how an operator typed the slug into separate scopes and
 * let both claim the same Issue. The fold is confined to this key: the identity
 * itself keeps the spelling the session declared, which is what
 * {@link formatChainRepository} shows an operator. The endpoint needs no fold —
 * GitHub's is a fixed constant and `canonicalizeGiteaEndpoint` already collapses
 * scheme and host case.
 */
export function chainRepositoryKey(identity: ChainRepositoryIdentity): string {
  return JSON.stringify([
    identity.provider,
    identity.endpoint,
    identity.owner.toLowerCase(),
    identity.repo.toLowerCase(),
  ]);
}

/**
 * Operator-facing rendering of a repository: `owner/repo` for GitHub, and the
 * endpoint-qualified `https://host/owner/repo` for a self-hosted instance,
 * where `owner/repo` alone would not say *which* instance.
 */
export function formatChainRepository(identity: ChainRepositoryIdentity): string {
  return identity.endpoint === GITHUB_ISSUES_PROVIDER_ENDPOINT
    ? `${identity.owner}/${identity.repo}`
    : `${identity.endpoint}/${identity.owner}/${identity.repo}`;
}

/** The sessions whose chains share one Issue-number space. */
export interface ChainOwnershipScope {
  /** The session the scope was resolved from. Always present in `sessionIds`. */
  anchorSessionId: string;
  /**
   * Every session bound to the same repository, ascending. A single-entry list
   * is the fallback: the anchor session alone, either because nothing else is
   * bound to its repository or because no repository identity could be derived.
   */
  sessionIds: string[];
  /** The repository the scope resolved to, absent when it fell back to the session. */
  repository?: ChainRepositoryIdentity;
  /**
   * {@link chainRepositoryKey} of {@link ChainOwnershipScope.repository}, present
   * exactly when it is. Carried so a caller that has to name the shared
   * Issue-number space — the repository-scoped edit lock of
   * `chain-edit-lock.ts` — uses the same key this scope was widened by, rather
   * than deriving a second one.
   */
  repositoryKey?: string;
  /** Ready to hand to a registry lookup or an exclusive-membership claim. */
  filter: ChainListFilter;
  /** `owner/repo` per session in `sessionIds`, for duplicate-ownership diagnostics. */
  repositoryBySessionId: Map<string, string>;
}

/**
 * Which sessions share `sessionId`'s Issue-number space, given the sessions the
 * caller has loaded.
 *
 * The anchor is always included even when it is missing from `sessions` — a
 * chain whose session has been deleted from the session file still owns its
 * members, and dropping it from its own scope would make the chain invisible to
 * its own duplicate check.
 */
export function resolveChainOwnershipScope(
  sessionId: string,
  sessions: readonly ChainOwnershipScopeSession[],
): ChainOwnershipScope {
  const repositoryBySessionId = new Map<string, string>();
  for (const session of sessions) {
    const identity = deriveChainRepositoryIdentity(session);
    if (identity) repositoryBySessionId.set(session.sessionId, formatChainRepository(identity));
  }

  const anchor = sessions.find((session) => session.sessionId === sessionId);
  const repository = anchor ? deriveChainRepositoryIdentity(anchor) : undefined;

  const sessionIds = new Set<string>([sessionId]);
  if (repository) {
    const key = chainRepositoryKey(repository);
    for (const session of sessions) {
      const identity = deriveChainRepositoryIdentity(session);
      if (identity && chainRepositoryKey(identity) === key) sessionIds.add(session.sessionId);
    }
  }

  const ordered = [...sessionIds].sort();
  return {
    anchorSessionId: sessionId,
    sessionIds: ordered,
    ...(repository ? { repository, repositoryKey: chainRepositoryKey(repository) } : {}),
    // A one-session scope is expressed as `sessionId` rather than a one-entry
    // `sessionIds`: it is the filter every pre-#1045 caller built, and keeping
    // the common case on the older, narrower field means a store that has not
    // learned about `sessionIds` still scopes it correctly.
    filter: ordered.length === 1 ? { sessionId } : { sessionIds: ordered },
    repositoryBySessionId,
  };
}

/** The session-lookup surface {@link resolveChainOwnershipScopeFor} needs. */
export interface ChainOwnershipScopeSessionSource {
  listSessions(): Promise<readonly ChainOwnershipScopeSession[]>;
}

/**
 * {@link resolveChainOwnershipScope} over a session registry, with the same
 * never-fails posture: a registry that cannot be read at all still yields the
 * session-only scope, because a chain command must not start refusing work
 * because the *widening* half of its duplicate check is unavailable.
 */
export async function resolveChainOwnershipScopeFor(
  sessionId: string,
  source: ChainOwnershipScopeSessionSource | undefined,
): Promise<ChainOwnershipScope> {
  if (!source) return resolveChainOwnershipScope(sessionId, []);
  try {
    return resolveChainOwnershipScope(sessionId, await source.listSessions());
  } catch {
    return resolveChainOwnershipScope(sessionId, []);
  }
}
