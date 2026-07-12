import { spawnSync } from "child_process";
import { createSign } from "crypto";
import { readFileSync } from "fs";
import { request as httpsRequest } from "https";
import { homedir } from "os";
import { join } from "path";
import { URL } from "url";
import type { GitHubAppAuthConfig, ProviderAuthConfig } from "../../core/session.js";
import { defaultGhRunner, type GhRunner } from "./gh-runner.js";

// ---------------------------------------------------------------------------
// GitHub App authentication
//
// Opt-in alternative to `gh`-CLI auth for the GitHub provider layer. The flow is
// the standard GitHub App handshake:
//
//   1. Build a short-lived app JWT (RS256) signed by the App private key.
//   2. Exchange that JWT for an installation access token via the REST API.
//   3. Cache the installation token until shortly before it expires.
//
// The resolved installation token is handed to `gh` through the `GH_TOKEN`
// environment variable (see {@link ghRunnerWithToken}), so every existing
// provider argv keeps working unchanged — only the credential source differs.
//
// Secrets are NEVER read from `sessions.json`: the App id, installation id, and
// private key path are referenced by indirection (env-var name or credential
// key) per {@link GitHubAppAuthConfig}, and the private key itself is read from a
// `.pem` file. Tokens, JWTs, private keys, and Authorization headers are never
// logged: errors are built from status lines only and passed through
// {@link redactSecrets} as a defense in depth.
//
// Local `git push` is deliberately untouched: this only covers API operations
// performed by the provider layer (issues + PRs). See
// docs/provider-architecture.md for the configured GitHub App permissions.
// ---------------------------------------------------------------------------

/** Minimal POST-JSON transport. Injected in tests; defaults to Node `https`. */
export type HttpPostJson = (
  url: string,
  opts: { headers: Record<string, string>; body: string },
) => Promise<{ status: number; statusText: string; body: string }>;

/**
 * Synchronous POST-JSON transport. Injected in tests; defaults to a blocking
 * Node-subprocess request (see {@link defaultHttpPostJsonSync}). Used only by the
 * synchronous refresh path ({@link GitHubAppAuth.getCachedToken}) when a cached
 * token has actually expired and the `gh` runner — which is synchronous and
 * cannot await — needs a fresh token *before* it spawns `gh`.
 */
export type HttpPostJsonSync = (
  url: string,
  opts: { headers: Record<string, string>; body: string },
) => { status: number; statusText: string; body: string };

/** Default REST API base. Overridable for GitHub Enterprise / tests. */
const DEFAULT_API_BASE_URL = "https://api.github.com";

/** Refresh the installation token once it is within this window of expiry. */
const DEFAULT_REFRESH_SKEW_MS = 60_000;

/**
 * A permanent GitHub-auth *configuration* error: an auth mode the provider layer
 * does not support (`api-token`), or a missing/unreadable credential reference
 * (an unset `*Env`, an unconfigured identifier, an empty/unreadable private key).
 * Retrying never fixes it without operator action, so callers that downgrade
 * transient token-exchange/HTTP failures to retryable errors (e.g. the outbox
 * dispatcher) must let this surface as a fatal setup failure instead.
 */
export class GitHubAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthConfigError";
  }
}

/** Default JSON POST transport over Node `https` (no global `fetch` dependency). */
const defaultHttpPostJson: HttpPostJson = (url, opts) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpsRequest(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        headers: { ...opts.headers, "Content-Length": Buffer.byteLength(opts.body) },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", body: data });
        });
      },
    );
    req.on("error", reject);
    req.write(opts.body);
    req.end();
  });

/**
 * Default synchronous JSON POST transport. Node has no synchronous HTTPS, so the
 * request is run to completion in a short-lived child Node process via
 * `spawnSync`. Secrets (the app JWT in the Authorization header) are passed on
 * stdin — never on argv — so they cannot leak into a process listing, and only
 * the `{status, statusText, body}` envelope is read back from stdout.
 */
const defaultHttpPostJsonSync: HttpPostJsonSync = (url, opts) => {
  const child = `
    const https = require("https");
    const { URL } = require("url");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { input += c; });
    process.stdin.on("end", () => {
      const { url, headers, body } = JSON.parse(input);
      const u = new URL(url);
      const req = https.request(
        {
          method: "POST",
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { data += c; });
          res.on("end", () => {
            process.stdout.write(JSON.stringify({
              status: res.statusCode || 0,
              statusText: res.statusMessage || "",
              body: data,
            }));
          });
        },
      );
      req.on("error", (e) => { process.stderr.write(String((e && e.message) || e)); process.exit(2); });
      req.write(body);
      req.end();
    });
  `;
  const result = spawnSync(process.execPath, ["-e", child], {
    input: JSON.stringify({ url, headers: opts.headers, body: opts.body }),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    // stderr carries only the network error message (never the JWT/body); the
    // caller redacts regardless as defense in depth.
    throw new Error(result.stderr?.trim() || `token exchange subprocess exited ${result.status}`);
  }
  return JSON.parse(result.stdout) as { status: number; statusText: string; body: string };
};

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Redact known secret strings (and any GitHub token pattern) from text destined
 * for an error message or log. Defense in depth: error text here is already
 * built from status lines, never from headers or tokens.
 */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join("[redacted]");
    }
  }
  // GitHub installation/app/user tokens: ghs_, ghp_, gho_, ghu_, ghr_, github_pat_.
  out = out.replace(/\b(gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]");
  return out;
}

/**
 * Decide whether a failed token-exchange response is a transient rate limit
 * rather than a permanent credential/config failure.
 *
 * GitHub returns HTTP 429 for primary rate limits and HTTP 403 for both primary
 * ("API rate limit exceeded") and secondary ("you have exceeded a secondary rate
 * limit") limits, so the status code alone cannot distinguish a throttled request
 * from bad credentials. We use the only signals carried by the exchange response
 * envelope: a 429 is always a rate limit, and a 403 is treated as one when its
 * body or status line names a rate limit. Anything else stays a config error.
 */
function isRateLimited(res: { status: number; statusText: string; body: string }): boolean {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  return /rate limit/i.test(`${res.statusText} ${res.body}`);
}

/**
 * Create a signed GitHub App JWT (RS256). The clock is injectable so tests can
 * assert `iat`/`exp` against a fixed time. The issued-at is backdated 60s to
 * tolerate clock skew, and the token is valid for 10 minutes (GitHub's max).
 */
export function createAppJwt(opts: {
  appId: string;
  privateKey: string;
  now?: () => number;
}): string {
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSec - 60, exp: nowSec + 600, iss: opts.appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  let signature: Buffer;
  try {
    signature = createSign("RSA-SHA256").update(signingInput).sign(opts.privateKey);
  } catch (err) {
    // A signing failure here means the private key itself is unusable (a
    // malformed/truncated PEM, wrong key type). That is a permanent setup
    // problem — retrying never fixes it — so raise it as a config error rather
    // than a transient exchange failure. Redact as defense in depth even though
    // the message is built from the crypto error, never the key.
    throw new GitHubAuthConfigError(
      redactSecrets(
        `GitHub App auth: failed to sign app JWT (malformed private key?): ${err instanceof Error ? err.message : String(err)}`,
        [opts.privateKey],
      ),
    );
  }
  return `${signingInput}.${base64url(signature)}`;
}

export interface GitHubAppAuthOptions {
  appId: string;
  installationId: string;
  /** PEM-encoded App private key (already read from disk). */
  privateKey: string;
  httpPostJson?: HttpPostJson;
  httpPostJsonSync?: HttpPostJsonSync;
  now?: () => number;
  apiBaseUrl?: string;
  refreshSkewMs?: number;
}

/**
 * Resolves and caches a GitHub App installation access token. A single instance
 * exchanges the app JWT for an installation token and serves it from cache until
 * shortly before expiry, then refreshes transparently.
 */
export class GitHubAppAuth {
  private readonly appId: string;
  private readonly installationId: string;
  private readonly privateKey: string;
  private readonly httpPostJson: HttpPostJson;
  private readonly httpPostJsonSync: HttpPostJsonSync;
  private readonly now: () => number;
  private readonly apiBaseUrl: string;
  private readonly refreshSkewMs: number;
  private cached?: { token: string; expiresAtMs: number };
  /** In-flight background refresh kicked off by {@link getCachedToken}; deduped. */
  private refreshing?: Promise<void>;

  constructor(opts: GitHubAppAuthOptions) {
    this.appId = opts.appId;
    this.installationId = opts.installationId;
    this.privateKey = opts.privateKey;
    this.httpPostJson = opts.httpPostJson ?? defaultHttpPostJson;
    this.httpPostJsonSync = opts.httpPostJsonSync ?? defaultHttpPostJsonSync;
    this.now = opts.now ?? (() => Date.now());
    this.apiBaseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.refreshSkewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  }

  /** Build the signed request for an installation-token exchange. */
  private buildExchangeRequest(): {
    url: string;
    headers: Record<string, string>;
    body: string;
    jwt: string;
  } {
    const jwt = createAppJwt({ appId: this.appId, privateKey: this.privateKey, now: this.now });
    const url = `${this.apiBaseUrl}/app/installations/${encodeURIComponent(this.installationId)}/access_tokens`;
    return {
      url,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "n8n-ai-cli-loop",
        "Content-Type": "application/json",
      },
      body: "{}",
      jwt,
    };
  }

  /** Validate the exchange response, cache the token, and return it. */
  private storeExchangeResponse(
    res: { status: number; statusText: string; body: string },
    jwt: string,
    nowMs: number,
  ): string {
    if (res.status < 200 || res.status >= 300) {
      // GitHub returns { message, documentation_url } on error — never our token —
      // but redact regardless so a token can never reach an error string.
      const message = redactSecrets(
        `GitHub App installation token request failed (HTTP ${res.status} ${res.statusText})`,
        [jwt, this.privateKey],
      );
      // A 4xx means the credentials are wrong: a bad App id, the wrong
      // installation id, or a key not authorized for this installation. Retrying
      // never fixes it without operator action, so raise a permanent config error
      // so the outbox dispatcher exits 1 (setup error) instead of leaving rows
      // pending forever. 5xx stays transient.
      //
      // Rate limiting is the exception: GitHub signals it with HTTP 429 *or* 403
      // (primary and secondary rate limits both use 403), so a 403 alone cannot
      // be assumed fatal. When the response looks rate-limited, keep it transient
      // so the outbox stays on its normal retryable per-entry path.
      if (res.status >= 400 && res.status < 500 && !isRateLimited(res)) {
        throw new GitHubAuthConfigError(message);
      }
      throw new Error(message);
    }

    let parsed: { token?: unknown; expires_at?: unknown };
    try {
      parsed = JSON.parse(res.body) as { token?: unknown; expires_at?: unknown };
    } catch {
      throw new Error("GitHub App installation token response was not valid JSON");
    }

    if (typeof parsed.token !== "string" || parsed.token === "") {
      throw new Error("GitHub App installation token response did not include a token");
    }
    const expiresAtMs =
      typeof parsed.expires_at === "string" ? Date.parse(parsed.expires_at) : NaN;

    this.cached = {
      token: parsed.token,
      // If expiry is missing/unparseable, treat the token as already at the skew
      // boundary so the next call refreshes rather than caching indefinitely.
      expiresAtMs: Number.isNaN(expiresAtMs) ? nowMs + this.refreshSkewMs : expiresAtMs,
    };
    return this.cached.token;
  }

  /** Return a valid installation token, refreshing it if cached past the skew window. */
  async getInstallationToken(): Promise<string> {
    const nowMs = this.now();
    if (this.cached && this.cached.expiresAtMs - this.refreshSkewMs > nowMs) {
      return this.cached.token;
    }

    const { url, headers, body, jwt } = this.buildExchangeRequest();
    let res: { status: number; statusText: string; body: string };
    try {
      res = await this.httpPostJson(url, { headers, body });
    } catch (err) {
      throw new Error(
        redactSecrets(
          `GitHub App installation token request failed: ${err instanceof Error ? err.message : String(err)}`,
          [jwt, this.privateKey],
        ),
      );
    }
    return this.storeExchangeResponse(res, jwt, nowMs);
  }

  /**
   * Synchronous sibling of {@link getInstallationToken}, used by
   * {@link getCachedToken} when a cached token has actually expired and the
   * (synchronous) `gh` runner needs a fresh token before spawning `gh`. Always
   * performs the exchange via the synchronous transport; the caller decides when
   * a refresh is required.
   */
  private refreshInstallationTokenSync(): string {
    const nowMs = this.now();
    const { url, headers, body, jwt } = this.buildExchangeRequest();
    let res: { status: number; statusText: string; body: string };
    try {
      res = this.httpPostJsonSync(url, { headers, body });
    } catch (err) {
      throw new Error(
        redactSecrets(
          `GitHub App installation token request failed: ${err instanceof Error ? err.message : String(err)}`,
          [jwt, this.privateKey],
        ),
      );
    }
    return this.storeExchangeResponse(res, jwt, nowMs);
  }

  /**
   * Synchronous token accessor for the `gh` runner, which spawns `gh` from a
   * synchronous `run()` and so cannot await. The caller must warm the cache first
   * with {@link getInstallationToken} (see {@link createGhRunnerForAuth}).
   *
   * Behavior depends on how close the cached token is to expiry:
   *   - Past actual expiry: refresh synchronously (blocking) and return the fresh
   *     token, so the very next `gh` invocation never runs with a dead `GH_TOKEN`.
   *     This matters for long phases (e.g. an implementation run that spends over
   *     an hour in the agent/verification steps before `gh pr create`) where the
   *     warmed token expires while no `gh` call is in flight.
   *   - Within the refresh-skew window but still valid: serve the cached token and
   *     kick off a single (deduped) background refresh so subsequent calls pick up
   *     the new token without blocking.
   *   - Otherwise: serve the cached token.
   */
  getCachedToken(): string {
    if (!this.cached) {
      throw new Error("GitHub App installation token has not been resolved yet");
    }
    const nowMs = this.now();
    if (this.cached.expiresAtMs <= nowMs) {
      // The cached token has actually expired: a background refresh would still
      // hand this call a dead token, so refresh synchronously before returning.
      return this.refreshInstallationTokenSync();
    }
    if (this.cached.expiresAtMs - this.refreshSkewMs <= nowMs && !this.refreshing) {
      // Proactively refresh ahead of expiry; keep serving the still-valid token
      // until the refresh lands. Swallow errors here — the next exchange (or a
      // failing `gh` call) surfaces a persistent problem with a redacted message.
      this.refreshing = this.getInstallationToken().then(
        () => undefined,
        () => undefined,
      ).finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.cached.token;
  }
}

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------

/** Injectable secret sources, defaulting to `process.env` and the filesystem. */
export interface SecretResolverDeps {
  env?: NodeJS.ProcessEnv;
  /** Read a private key file. Defaults to `readFileSync(path, "utf8")`. */
  readFile?: (path: string) => string;
  /** Resolve a credential-key (`*Key`) reference. Required when any `*Key` is used. */
  resolveKey?: (key: string) => string;
}

export interface GitHubAppCredentials {
  appId: string;
  installationId: string;
  privateKey: string;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function resolveRef(
  base: string,
  envName: string | undefined,
  keyName: string | undefined,
  deps: Required<Pick<SecretResolverDeps, "env">> & SecretResolverDeps,
): string {
  if (envName !== undefined) {
    const value = deps.env[envName];
    if (value === undefined || value === "") {
      throw new GitHubAuthConfigError(
        `GitHub App auth: environment variable "${envName}" (for ${base}) is not set`,
      );
    }
    return value;
  }
  if (keyName !== undefined) {
    if (!deps.resolveKey) {
      throw new GitHubAuthConfigError(
        `GitHub App auth: no credential-key resolver configured to resolve ${base} ("${keyName}")`,
      );
    }
    const value = deps.resolveKey(keyName);
    if (!value) {
      throw new GitHubAuthConfigError(
        `GitHub App auth: credential key "${keyName}" (for ${base}) resolved to empty`,
      );
    }
    return value;
  }
  throw new GitHubAuthConfigError(
    `GitHub App auth: ${base} is not configured (set ${base}Env or ${base}Key)`,
  );
}

/**
 * Resolve App id, installation id, and the PEM private key from a validated
 * {@link GitHubAppAuthConfig}. Each identifier comes from its `*Env` / `*Key`
 * reference; the private key is read from the `.pem` file at the resolved path.
 */
export function resolveGitHubAppCredentials(
  auth: GitHubAppAuthConfig,
  deps: SecretResolverDeps = {},
): GitHubAppCredentials {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const resolved = { ...deps, env };

  const appId = resolveRef("appId", auth.appIdEnv, auth.appIdKey, resolved);
  const installationId = resolveRef(
    "installationId",
    auth.installationIdEnv,
    auth.installationIdKey,
    resolved,
  );
  const privateKeyPath = expandHome(
    resolveRef("privateKeyPath", auth.privateKeyPathEnv, auth.privateKeyPathKey, resolved),
  );

  let privateKey: string;
  try {
    privateKey = readFile(privateKeyPath);
  } catch (err) {
    throw new GitHubAuthConfigError(
      `GitHub App auth: failed to read private key file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (privateKey.trim() === "") {
    throw new GitHubAuthConfigError("GitHub App auth: private key file is empty");
  }

  return { appId, installationId, privateKey };
}

// ---------------------------------------------------------------------------
// Runner wiring
// ---------------------------------------------------------------------------

/**
 * A `gh` executor that injects an installation token via `GH_TOKEN`/`GITHUB_TOKEN`
 * so `gh` authenticates as the GitHub App installation. Argv is unchanged, so all
 * existing provider behavior carries over.
 *
 * The token is resolved through `getToken` on every invocation rather than
 * captured once, so a long-lived runner picks up tokens refreshed before expiry
 * (see {@link GitHubAppAuth.getCachedToken}) instead of reusing a stale one.
 *
 * Token resolution can throw — `getCachedToken` refreshes synchronously when the
 * cached token has expired, and that exchange can fail on a network outage or
 * revoked credentials. Such a failure is caught and surfaced as a non-zero
 * {@link GhRunResult} (with redacted stderr) rather than thrown, so callers that
 * treat a non-zero `run()` as a retryable failure (e.g. the outbox dispatcher)
 * keep the entry retryable instead of aborting the whole process.
 */
export function ghRunnerWithToken(getToken: () => string): GhRunner {
  return {
    run(args, opts) {
      let token: string;
      try {
        token = getToken();
      } catch (err) {
        // Treat a token-resolution failure as a retryable runner failure: the
        // error message is already built from status lines, but redact again as
        // defense in depth so no token can reach stderr.
        return {
          exitCode: 1,
          stdout: "",
          stderr: redactSecrets(
            `GitHub App token resolution failed: ${err instanceof Error ? err.message : String(err)}`,
            [],
          ),
        };
      }
      const result = spawnSync("gh", args, {
        cwd: opts.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
        timeout: opts.timeout,
      });
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  };
}

export interface GhRunnerAuthDeps extends SecretResolverDeps {
  httpPostJson?: HttpPostJson;
  httpPostJsonSync?: HttpPostJsonSync;
  now?: () => number;
  apiBaseUrl?: string;
  refreshSkewMs?: number;
}

/**
 * Build the {@link GhRunner} for a provider's configured auth mode. `gh` mode
 * returns the default executor (the operator's `gh` session, the backward-
 * compatible default). `github-app` mode resolves credentials, exchanges for an
 * installation token, and returns a token-injecting executor. `api-token` mode is
 * not implemented for the GitHub provider layer.
 */
export async function createGhRunnerForAuth(
  auth: ProviderAuthConfig,
  deps: GhRunnerAuthDeps = {},
): Promise<GhRunner> {
  switch (auth.mode) {
    case "gh":
      return defaultGhRunner;
    case "github-app": {
      const creds = resolveGitHubAppCredentials(auth, deps);
      const appAuth = new GitHubAppAuth({
        ...creds,
        httpPostJson: deps.httpPostJson,
        httpPostJsonSync: deps.httpPostJsonSync,
        now: deps.now,
        apiBaseUrl: deps.apiBaseUrl,
        refreshSkewMs: deps.refreshSkewMs,
      });
      // Warm the cache once so config/credential errors surface here at
      // construction; the runner then resolves a (refresh-aware) token per
      // invocation via getCachedToken so it never reuses an expired token.
      await appAuth.getInstallationToken();
      return ghRunnerWithToken(() => appAuth.getCachedToken());
    }
    default:
      throw new GitHubAuthConfigError(
        `Unsupported GitHub provider auth mode: ${(auth as ProviderAuthConfig).mode}`,
      );
  }
}

/**
 * Resolve the {@link GhRunner} a runtime provider should use for a session's
 * configured auth. `gh` mode returns `fallback` unchanged — the operator's `gh`
 * session wrapped from the injected CommandRunner — preserving the existing test
 * seam and backward-compatible default. Any other mode delegates to
 * {@link createGhRunnerForAuth}, which resolves credentials and returns a
 * token-injecting executor.
 *
 * This is the seam the handler/provider construction paths call so configured
 * `github-app` auth actually takes effect at runtime.
 */
export async function resolveGhRunner(
  auth: ProviderAuthConfig,
  fallback: GhRunner,
  deps: GhRunnerAuthDeps = {},
): Promise<GhRunner> {
  if (auth.mode === "gh") return fallback;
  return createGhRunnerForAuth(auth, deps);
}
