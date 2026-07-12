import type { GhRunner } from "./github/gh-runner.js";
import { GhRepoHostProvider } from "./github/gh-repo-host-provider.js";
import { GiteaRepoHostProvider } from "./gitea/gitea-repo-host-provider.js";
import { createGiteaClient } from "./gitea/gitea-client.js";
import type { GiteaClient } from "./gitea/gitea-client.js";
import { resolveGhRunner } from "./github/github-app-auth.js";
import type { GhRunnerAuthDeps } from "./github/github-app-auth.js";
import type {
  GiteaRepoHostConfig,
  ProviderAuthConfig,
  RepoHostProviderConfig,
  RepoHostProviderKind,
} from "../core/session.js";
import type { RepoHostProvider } from "./types.js";

// ---------------------------------------------------------------------------
// Repo-host provider selection
//
// The single seam that turns a validated `RepoHostProviderConfig` (from a
// session) into a concrete `RepoHostProvider`, so a session can SELECT its repo
// host by config rather than callers hard-coding GitHub. `github` resolves to the
// `gh`-backed provider (using a pre-resolved executor, so the operator-`gh` /
// GitHub-App auth path is untouched); `gitea` resolves to the REST-backed Gitea
// provider.
//
// The Gitea client is supplied through an injected builder rather than
// constructed here, so this selection stays pure: token resolution (env /
// keychain) and the HTTP transport live behind {@link defaultGiteaClientBuilder}
// in production and behind a fake in tests. GitHub behavior is unchanged — its
// branch is byte-for-byte the construction callers used before this seam existed.
// ---------------------------------------------------------------------------

/** Builds a {@link GiteaClient} for a `gitea` repo host from its config + auth. */
export type GiteaClientBuilder = (
  gitea: GiteaRepoHostConfig,
  auth: ProviderAuthConfig,
) => GiteaClient;

export interface RepoHostProviderDeps {
  /** Working directory for the GitHub `gh` executor. */
  cwd: string;
  /** `owner/name` of the GitHub repo host. */
  githubRepo: string;
  /** Pre-resolved `gh` executor (operator `gh` session or GitHub App token-injecting runner). */
  ghRunner: GhRunner;
  /**
   * Builds the Gitea client for a `gitea` repo host. Required only when the
   * configured provider is `gitea`; omitted callers that never select Gitea need
   * not provide it.
   */
  giteaClient?: GiteaClientBuilder;
}

/**
 * Resolve the {@link RepoHostProvider} a session's `repoHostProvider` config
 * selects. Throws on an unsupported provider kind or a `gitea` config missing its
 * connection block / client builder — a setup error, never a silent fallback to
 * GitHub (which would publish to the wrong host).
 */
export function resolveRepoHostProvider(
  config: RepoHostProviderConfig,
  deps: RepoHostProviderDeps,
): RepoHostProvider {
  switch (config.provider) {
    case "github":
      return new GhRepoHostProvider(deps.ghRunner, deps.githubRepo, deps.cwd);
    case "gitea": {
      if (!config.gitea) {
        throw new Error("gitea repo-host provider requires a gitea connection block");
      }
      if (!deps.giteaClient) {
        throw new Error("gitea repo-host provider requires a gitea client builder");
      }
      const client = deps.giteaClient(config.gitea, config.auth);
      return new GiteaRepoHostProvider(client, config.gitea.owner, config.gitea.repo);
    }
    default:
      throw new Error(`Unsupported repo-host provider: ${config.provider}`);
  }
}

// ---------------------------------------------------------------------------
// Session-level resolution (async: resolves repo-host auth + provider together)
// ---------------------------------------------------------------------------

/**
 * The repo host a session selected, resolved for runtime use by the handlers.
 *
 * `provider` is the concrete {@link RepoHostProvider} for PR lookup/create/detail/
 * comment work, regardless of backend. `ghRunner` is the resolved `gh` executor
 * and is present ONLY for the `github` backend — handlers that still have
 * gh-CLI-only steps (e.g. `gh pr checkout`, the live-base/mergeability `gh pr
 * view` reads) use it on the GitHub path and branch on `kind` for others.
 */
export interface SessionRepoHost {
  provider: RepoHostProvider;
  kind: RepoHostProviderKind;
  /** Resolved `gh` executor — present only when `kind === "github"`. */
  ghRunner?: GhRunner;
}

/**
 * Resolve a session's repo-host config into a runtime {@link SessionRepoHost}.
 *
 * This is the single seam the implementation/review/conflict handlers call so a
 * session can select its repo host by config. For `github` it resolves the `gh`
 * executor from the configured auth (operator `gh` or a GitHub App
 * token-injecting runner) exactly as the handlers did before — GitHub behavior is
 * unchanged. For `gitea` it builds the REST-backed provider via
 * {@link resolveRepoHostProvider} and does NOT resolve a `gh` runner, so a
 * `gitea` session no longer fails at handler entry with "unsupported GitHub auth"
 * (the `api-token` mode the validator requires for gitea throws inside
 * `resolveGhRunner`). An omitted config defaults to `github`/`gh`.
 */
export async function resolveSessionRepoHost(
  config: RepoHostProviderConfig | undefined,
  opts: {
    githubRepo: string;
    cwd: string;
    /** Operator `gh` session wrapped from the handler's CommandRunner (the `gh`-mode fallback). */
    ghRunnerFallback: GhRunner;
    /** Builds the Gitea client; defaults to {@link defaultGiteaClientBuilder} (env/keychain token). */
    giteaClient?: GiteaClientBuilder;
    /** GitHub App auth deps, forwarded to `resolveGhRunner` for the github path. */
    authDeps?: GhRunnerAuthDeps;
  },
): Promise<SessionRepoHost> {
  const resolved: RepoHostProviderConfig = config ?? { provider: "github", auth: { mode: "gh" } };

  if (resolved.provider === "github") {
    const ghRunner = await resolveGhRunner(resolved.auth, opts.ghRunnerFallback, opts.authDeps);
    const provider = resolveRepoHostProvider(resolved, {
      ghRunner,
      githubRepo: opts.githubRepo,
      cwd: opts.cwd,
    });
    return { provider, kind: "github", ghRunner };
  }

  // Non-GitHub (gitea, …): the REST provider needs no `gh` runner. `ghRunner` in
  // the factory deps is unused by this branch but required by the type, so pass
  // the fallback through harmlessly.
  const provider = resolveRepoHostProvider(resolved, {
    ghRunner: opts.ghRunnerFallback,
    githubRepo: opts.githubRepo,
    cwd: opts.cwd,
    giteaClient: opts.giteaClient ?? defaultGiteaClientBuilder(),
  });
  return { provider, kind: resolved.provider };
}

/** Injectable secret sources for token resolution; defaults to `process.env`. */
export interface GiteaTokenResolverDeps {
  env?: NodeJS.ProcessEnv;
  /** Resolve a credential-key (`tokenKey`) reference. Required when `tokenKey` is used. */
  resolveKey?: (key: string) => string;
}

/**
 * Production {@link GiteaClientBuilder}: resolve the API token by indirection from
 * the session `auth` block (`api-token` with `tokenEnv` / `tokenKey`) and build a
 * client over the default synchronous transport. The token is never read from the
 * session config itself, only by reference — matching the secret-indirection rule
 * the validator enforces.
 */
export function defaultGiteaClientBuilder(deps: GiteaTokenResolverDeps = {}): GiteaClientBuilder {
  return (gitea, auth) => {
    const token = resolveGiteaToken(auth, deps);
    return createGiteaClient({ baseUrl: gitea.baseUrl, apiPath: gitea.apiPath, token });
  };
}

function resolveGiteaToken(auth: ProviderAuthConfig, deps: GiteaTokenResolverDeps): string {
  if (auth.mode !== "api-token") {
    throw new Error(`gitea repo-host provider requires api-token auth (got "${auth.mode}")`);
  }
  const env = deps.env ?? process.env;
  if (auth.tokenEnv !== undefined) {
    const value = env[auth.tokenEnv];
    if (value === undefined || value === "") {
      throw new Error(`gitea repo-host auth: environment variable "${auth.tokenEnv}" is not set`);
    }
    return value;
  }
  if (auth.tokenKey !== undefined) {
    if (!deps.resolveKey) {
      throw new Error(`gitea repo-host auth: no credential-key resolver configured to resolve "${auth.tokenKey}"`);
    }
    const value = deps.resolveKey(auth.tokenKey);
    if (!value) {
      throw new Error(`gitea repo-host auth: credential key "${auth.tokenKey}" resolved to empty`);
    }
    return value;
  }
  throw new Error("gitea repo-host auth: api-token auth must set tokenEnv or tokenKey");
}
