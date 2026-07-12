import { spawnSync } from "child_process";
import { URL, URLSearchParams } from "url";
import type { ProviderAuthConfig } from "../../core/session.js";

// ---------------------------------------------------------------------------
// Injectable Gitea REST executor
//
// The single seam the Gitea-backed providers depend on, mirroring the role
// `GhRunner` plays for the GitHub providers — but Gitea has no first-class CLI,
// so the seam is an HTTP-request executor rather than a command runner. Tests
// inject a fake to assert the exact method/path/body and to drive
// parsing/error branches without a live Gitea instance.
//
// The executor is **synchronous** on purpose: the `RepoHostProvider` methods it
// backs are synchronous (matching the `gh`-backed providers, which shell out via
// the synchronous `spawnSync`). Node has no synchronous HTTPS, so the default
// transport runs the request to completion in a short-lived child Node process —
// the same approach `github-app-auth.ts` uses for its synchronous token
// exchange. The API token is passed to that child on **stdin**, never on argv,
// so it cannot leak into a process listing.
// ---------------------------------------------------------------------------

export type GiteaMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface GiteaRequest {
  method: GiteaMethod;
  /**
   * API path relative to the resolved API base (e.g. `/repos/owner/repo/pulls`).
   * The base URL + API path prefix are owned by the client, so callers pass only
   * the resource path.
   */
  path: string;
  /** Optional query parameters appended to the path (values are URL-encoded). */
  query?: Record<string, string | number>;
  /** Optional JSON request body for POST/PATCH. Serialized by the client. */
  body?: unknown;
}

export interface GiteaResponse {
  status: number;
  body: string;
}

export interface GiteaClient {
  request(req: GiteaRequest): GiteaResponse;
}

/**
 * Low-level synchronous HTTP transport. Injected in tests; the default runs the
 * request in a child Node process (see {@link defaultGiteaHttpSync}). Kept
 * separate from {@link GiteaClient} so the URL/auth/header assembly can be unit
 * tested against a fake transport without spawning a subprocess.
 */
export type GiteaHttpSync = (req: {
  method: GiteaMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
}) => GiteaResponse;

/**
 * Default synchronous HTTP transport. Node has no synchronous http(s), so the
 * request is run to completion in a short-lived child Node process via
 * `spawnSync`. The whole request envelope (including the `Authorization` header)
 * is passed on stdin — never on argv — so the token cannot leak into a process
 * listing, and only the `{status, body}` envelope is read back from stdout.
 */
export const defaultGiteaHttpSync: GiteaHttpSync = (req) => {
  const child = `
    const http = require("http");
    const https = require("https");
    const { URL } = require("url");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { input += c; });
    process.stdin.on("end", () => {
      const { method, url, headers, body } = JSON.parse(input);
      const u = new URL(url);
      const lib = u.protocol === "http:" ? http : https;
      const opts = {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        headers: { ...headers },
      };
      if (body !== undefined) opts.headers["Content-Length"] = Buffer.byteLength(body);
      const reqObj = lib.request(opts, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          process.stdout.write(JSON.stringify({ status: res.statusCode || 0, body: data }));
        });
      });
      reqObj.on("error", (e) => { process.stderr.write(String((e && e.message) || e)); process.exit(2); });
      if (body !== undefined) reqObj.write(body);
      reqObj.end();
    });
  `;
  const result = spawnSync(process.execPath, ["-e", child], {
    input: JSON.stringify(req),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    // stderr carries only the network error message (never the token, which
    // travels in the header on stdin). Surface it as a 0-status response so the
    // provider reports a retryable failure rather than throwing.
    return { status: 0, body: result.stderr?.trim() || `gitea request subprocess exited ${result.status}` };
  }
  return JSON.parse(result.stdout) as GiteaResponse;
};

export interface GiteaClientOptions {
  /** Base URL of the Gitea instance, e.g. `https://gitea.example.com`. */
  baseUrl: string;
  /** API token resolved by indirection from the session `auth` block. */
  token: string;
  /** API base path. Defaults to `/api/v1`. */
  apiPath?: string;
  /** Injectable transport; defaults to {@link defaultGiteaHttpSync}. */
  http?: GiteaHttpSync;
}

const DEFAULT_API_PATH = "/api/v1";

/**
 * Build a {@link GiteaClient} that targets a single Gitea instance. The client
 * owns base-URL + API-path assembly and authentication, so the provider passes
 * only the resource path. Auth uses Gitea's canonical `Authorization: token …`
 * header. The token is held only in the closure and the request header — never
 * placed on argv or echoed into a response/error.
 */
export function createGiteaClient(opts: GiteaClientOptions): GiteaClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const apiPath = (opts.apiPath ?? DEFAULT_API_PATH).replace(/\/+$/, "");
  const http = opts.http ?? defaultGiteaHttpSync;

  return {
    request(req) {
      let path = `${apiPath}${req.path}`;
      if (req.query && Object.keys(req.query).length > 0) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(req.query)) params.set(k, String(v));
        path += `?${params.toString()}`;
      }
      const headers: Record<string, string> = {
        Authorization: `token ${opts.token}`,
        Accept: "application/json",
        "User-Agent": "n8n-ai-cli-loop",
      };
      const body = req.body !== undefined ? JSON.stringify(req.body) : undefined;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      return http({ method: req.method, url: `${base}${path}`, headers, body });
    },
  };
}

// ---------------------------------------------------------------------------
// Gitea HTTP transport + auth helpers (WorkItemProvider)
//
// The Gitea WorkItemProvider talks to a self-/co-hosted Gitea instance over its
// REST API. Unlike the GitHub provider — which shells out to the operator's `gh`
// CLI — Gitea has no local CLI seam, so the provider depends on a small
// injectable HTTP transport instead. Tests inject a fake transport to assert the
// exact request (method, URL, body) and to drive parsing/error branches without
// a live Gitea server.
//
// The transport is intentionally SYNCHRONOUS so the provider can satisfy the
// synchronous WorkItemProvider methods (listCandidateItems / getItem /
// commentItem / transitionItem) the same way the `gh` provider does, without
// rippling an async signature change through the dispatcher and its callers. The
// default transport runs the request to completion in a short-lived Node
// subprocess (Node has no synchronous HTTP), mirroring the synchronous
// token-exchange transport already used for GitHub App auth.
//
// SECURITY: the API token is sent only in the Authorization header, which is
// passed to the subprocess on stdin — never on argv — so it cannot leak into a
// process listing. Error strings are built from status lines / bounded response
// snippets and run through {@link redactGiteaSecrets} as a defense in depth, so a
// token can never reach an error message, task context, or published comment.
// ---------------------------------------------------------------------------

/** The result envelope of a Gitea HTTP request. */
export interface GiteaHttpResponse {
  status: number;
  statusText: string;
  body: string;
}

/** A single Gitea HTTP request. */
export interface GiteaHttpRequestInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** JSON request body, omitted for GET/DELETE without a payload. */
  body?: string;
}

/**
 * Synchronous Gitea HTTP transport. Injected in tests; defaults to
 * {@link defaultGiteaHttp}. Returns the response envelope for any HTTP status
 * (the caller inspects `status`); it throws only on a transport-level failure
 * (DNS/connection error), so a non-2xx Gitea response is a normal return.
 */
export type GiteaHttpRequest = (req: GiteaHttpRequestInput) => GiteaHttpResponse;

/**
 * A permanent Gitea-auth *configuration* error: a non-`api-token` auth mode, or
 * a missing/empty credential reference (an unset `tokenEnv`, an unresolved
 * `tokenKey`). Retrying never fixes it without operator action, so callers that
 * downgrade transient failures to retryable errors must let this surface as a
 * fatal setup failure instead.
 */
export class GiteaAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GiteaAuthConfigError";
  }
}

/**
 * Redact known secret strings (and any Gitea-token-shaped value) from text
 * destined for an error message or log. Gitea personal access tokens are 40-char
 * lowercase hex (SHA1) strings, so the pattern catches a token even if a caller
 * forgets to pass it in `secrets`. Defense in depth: error text here is already
 * built from status lines / bounded snippets, never from the Authorization
 * header.
 */
export function redactGiteaSecrets(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join("[redacted]");
    }
  }
  // Gitea access tokens are 40-char lowercase hex; also redact any `token`/`Bearer`
  // Authorization value, in case one is ever echoed back in a response body.
  out = out.replace(/\b[0-9a-f]{40}\b/g, "[redacted]");
  out = out.replace(/\b(token|Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "$1 [redacted]");
  return out;
}

/**
 * Default synchronous Gitea HTTP transport. Node has no synchronous HTTP, so the
 * request runs to completion in a short-lived child Node process via `spawnSync`.
 * The request descriptor (including the Authorization header) is passed on
 * stdin — never on argv — so secrets cannot leak into a process listing, and only
 * the `{status, statusText, body}` envelope is read back from stdout.
 */
export const defaultGiteaHttp: GiteaHttpRequest = (req) => {
  const child = `
    const http = require("http");
    const https = require("https");
    const { URL } = require("url");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { input += c; });
    process.stdin.on("end", () => {
      const { method, url, headers, body } = JSON.parse(input);
      const u = new URL(url);
      const lib = u.protocol === "http:" ? http : https;
      const hasBody = typeof body === "string";
      const req = lib.request(
        {
          method,
          hostname: u.hostname,
          port: u.port || (u.protocol === "http:" ? 80 : 443),
          path: u.pathname + u.search,
          headers: { ...headers, ...(hasBody ? { "Content-Length": Buffer.byteLength(body) } : {}) },
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
      if (hasBody) req.write(body);
      req.end();
    });
  `;
  const result = spawnSync(process.execPath, ["-e", child], {
    input: JSON.stringify({
      method: req.method,
      url: req.url,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
    }),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    // stderr carries only the network error message (never the token); redact
    // regardless as defense in depth.
    throw new Error(
      redactGiteaSecrets(result.stderr?.trim() || `gitea request subprocess exited ${result.status}`, []),
    );
  }
  return JSON.parse(result.stdout) as GiteaHttpResponse;
};

/** Injectable secret sources for resolving the Gitea API token. */
export interface GiteaSecretDeps {
  env?: NodeJS.ProcessEnv;
  /** Resolve a credential-key (`tokenKey`) reference. Required when `tokenKey` is used. */
  resolveKey?: (key: string) => string;
}

/**
 * Resolve the Gitea API token from a validated `api-token` auth config. The
 * token is referenced by indirection only — exactly one of `tokenEnv`
 * (environment-variable name) or `tokenKey` (credential-key reference) — and is
 * resolved at runtime, never read from `sessions.json`. Throws a
 * {@link GiteaAuthConfigError} when the reference is missing or resolves to empty.
 */
export function resolveGiteaToken(auth: ProviderAuthConfig, deps: GiteaSecretDeps = {}): string {
  if (auth.mode !== "api-token") {
    throw new GiteaAuthConfigError(
      `Gitea auth requires mode "api-token" (got "${auth.mode}")`,
    );
  }
  const env = deps.env ?? process.env;
  if (auth.tokenEnv !== undefined) {
    const value = env[auth.tokenEnv];
    if (value === undefined || value === "") {
      throw new GiteaAuthConfigError(
        `Gitea auth: environment variable "${auth.tokenEnv}" (for the API token) is not set`,
      );
    }
    return value;
  }
  if (auth.tokenKey !== undefined) {
    if (!deps.resolveKey) {
      throw new GiteaAuthConfigError(
        `Gitea auth: no credential-key resolver configured to resolve the API token ("${auth.tokenKey}")`,
      );
    }
    const value = deps.resolveKey(auth.tokenKey);
    if (!value) {
      throw new GiteaAuthConfigError(
        `Gitea auth: credential key "${auth.tokenKey}" (for the API token) resolved to empty`,
      );
    }
    return value;
  }
  throw new GiteaAuthConfigError(
    "Gitea auth: API token is not configured (set auth.tokenEnv or auth.tokenKey)",
  );
}

// ---------------------------------------------------------------------------
// URL construction (shared by the provider)
// ---------------------------------------------------------------------------

/**
 * Build an absolute Gitea API URL from the base URL, API path, and an endpoint
 * path, appending an optional query string. `apiPath` defaults to `/api/v1`.
 * Owner/repo segments are expected to be pre-encoded by the caller.
 */
export function buildGiteaApiUrl(
  baseUrl: string,
  apiPath: string | undefined,
  endpointPath: string,
  query?: Record<string, string>,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const api = (apiPath ?? "/api/v1").replace(/\/+$/, "");
  let url = `${base}${api}${endpointPath}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  // Normalize via URL so a malformed concatenation surfaces early rather than at
  // request time. Throws on an invalid base, which the validator already guards.
  return new URL(url).toString();
}
