/**
 * `admin session-audit` — loop design readiness audit for a session (issue #533).
 *
 * `session-doctor` answers "can this machine run the loop?"; this command answers
 * "is this session designed to run unattended?" — verification, kill switch,
 * handoff notifications, artifact hygiene, worktree/environment coherence,
 * explicit assignment, and the public/private boundary. Keeping the two apart is
 * deliberate (see the issue's note): doctor stays an environment probe instead of
 * growing a second, unrelated responsibility.
 *
 * This module is the I/O half. Every rule lives in
 * {@link import("../core/session-audit.js")}, which is pure; here we only load the
 * session, collect a handful of **read-only** observations, and render.
 *
 * Read-only contract (acceptance criteria):
 *   - No project command (test/build/lint/install) is ever executed. The audit
 *     reports on *configuration*, so it never needs to run one.
 *   - Tracker access is limited to reads: `gh label list` / `gh repo view` for a
 *     `github-issues` session, and `GET /repos/{owner}/{repo}[/labels]` for a
 *     `gitea-issues` one. No mutation endpoint is ever called.
 *   - Nothing touches the SQLite store: the audit never opens the DB, so it
 *     cannot create the file/schema as a side effect of inspection (the trap
 *     `session status` documents).
 *   - `--offline` skips even the read-only network probes, for auditing a
 *     session from a host without `gh` credentials.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import {
  buildSessionAudit,
  type AuditCheck,
  type AuditStatus,
  type LabelLookup,
  type RepoVisibility,
  type SessionAuditFacts,
  type SessionAuditPayload,
} from "../core/session-audit.js";
import { ECOSYSTEM_PRESETS } from "../core/presets.js";
import type { GiteaWorkItemConfig, ResolvedSession } from "../core/session.js";
import {
  buildGiteaApiUrl,
  createGiteaHttp,
  redactGiteaSecrets,
  resolveGiteaToken,
  type GiteaHttpRequest,
  type GiteaHttpResponse,
} from "../providers/gitea/gitea-client.js";
import { DEFAULT_SESSIONS_PATH, JsonSessionRegistry } from "../registries/json-session-registry.js";
import { resolveSessionSelector, tokenizeArgs } from "./admin-command.js";
import { die, report } from "./cli-io.js";
import type { OutputMode } from "./cli-io.js";

export interface SessionAuditArgs {
  sessionId: string;
  sessionsPath: string;
  offline: boolean;
}

export function parseSessionAuditArgs(argv: string[]): SessionAuditArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["session-id", "session-ref", "sessions-path"],
    booleanFlags: ["offline"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args, flags } = tokenized;
  const selector = resolveSessionSelector(args);
  if ("error" in selector) return { error: selector.error };
  return {
    sessionId: selector.sessionId,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    offline: flags.has("offline"),
  };
}

// ---------------------------------------------------------------------------
// Read-only fact collection
// ---------------------------------------------------------------------------

/** Run a read-only command, returning its trimmed stdout or the failure text. */
function probe(
  cmd: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
): { ok: boolean; output: string } {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      // Same value `execFileSync` would default to, passed explicitly so the child
      // is spawned with the environment this module can observe: a test sandbox
      // hands the module a *copy* of `process.env`, and without this the child
      // (and its `PATH` lookup) would silently use the real process environment
      // instead — i.e. the real `gh` rather than the one the test put on `PATH`.
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Caller-supplied: what is left of the run's shared tracker-probe budget,
      // so a second probe cannot start its own full-length wait after the first
      // one has already spent the budget.
      timeout: timeoutMs,
    }) as string;
    return { ok: true, output: stdout.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: (e.stderr ?? e.stdout ?? String(err)).slice(0, 300).trim() };
  }
}

/**
 * Whether `relPath` is excluded by the repo's ignore rules. Mirrors
 * session-doctor's tri-state helper, including the trailing-slash trick: the
 * artifact dir is usually checked before it has ever been created, and without an
 * existing directory to `lstat` git cannot match a directory-only pattern such as
 * `.n8n-artifacts/`. An exit status other than 0/1 is ambiguous (e.g. not a git
 * repo) and must never be read as "not ignored".
 */
function checkGitIgnored(repoRoot: string, relPath: string): "ignored" | "not-ignored" | "unknown" {
  const dirPath = relPath.endsWith("/") ? relPath : `${relPath}/`;
  try {
    execFileSync("git", ["check-ignore", "-q", "--", dirPath], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return "ignored";
  } catch (err: unknown) {
    return (err as { status?: number }).status === 1 ? "not-ignored" : "unknown";
  }
}

/**
 * Ecosystem presets whose lockfiles are present in the checkout. Lockfile
 * presence (rather than manifest presence) is the signal: it is what makes a
 * reproducible install command meaningful, and it is what the presets already key
 * their `cacheKeyFiles` on. Detection only *names a suggestion* — nothing is
 * auto-applied or auto-executed (docs/environment-prepare-contract.md).
 */
function detectEcosystems(repoRoot: string): string[] {
  if (!existsSync(repoRoot)) return [];
  return ECOSYSTEM_PRESETS.filter((p) =>
    p.environmentPrepare.cacheKeyFiles.some((f) => existsSync(join(repoRoot, f))),
  ).map((p) => p.name);
}

/**
 * Injectable seams for the read-only tracker probes. The Gitea transport and the
 * environment are injectable outright; the `gh` path goes through `execFileSync`
 * (tests drive it with a fake `gh` on `PATH`) and takes only its shared
 * wall-clock deadline from here, so the budget is testable without waiting for it.
 */
export interface SessionAuditProbeDeps {
  /** Gitea HTTP transport. Defaults to the provider's Node-subprocess transport. */
  giteaHttp?: GiteaHttpRequest;
  /** Environment used to resolve the Gitea API token by indirection. */
  env?: NodeJS.ProcessEnv;
  /**
   * Wall-clock budget shared by *all* tracker probes of one audit run — the `gh`
   * subprocesses and, unless a transport is injected, the default Gitea one.
   * Defaults to a fresh {@link createProbeDeadline}.
   */
  deadline?: ProbeDeadline;
}

/**
 * Requested cap for `gh label list`. `gh` paginates the REST endpoint internally
 * and stops once `--limit` items are collected, so this is both the page budget
 * and the truncation signal: a result of exactly this size means completeness
 * cannot be established, and the lookup reports `unavailable` rather than
 * declaring a required label missing from a partial list. Set well above any
 * realistic routing-label count so the fail-closed branch stays a corner case.
 */
const GH_LABEL_MAX = 1000;

/** Requested page size for the Gitea label list (a hint the instance may clamp). */
const GITEA_LABEL_PAGE_LIMIT = 50;

/**
 * Wall-clock bound on a single Gitea probe request. The default transport is a
 * synchronous subprocess with no timeout of its own, so a server that accepts the
 * connection and then never answers would block the whole audit; an expired
 * request throws and is reported as an `unavailable` lookup instead.
 */
const GITEA_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Wall-clock budget for *all* tracker probes in one audit — both the label read
 * and the visibility read, for either provider. A per-request timeout alone is
 * not enough: the audit issues several requests (the paginated Gitea label read
 * alone may issue up to {@link GITEA_LABEL_MAX_PAGES}), so an unresponsive tracker
 * could stall the command for requests × timeout. Once the budget is spent,
 * further probes fail immediately.
 */
const TRACKER_PROBE_BUDGET_MS = 60_000;

/**
 * Hard cap on Gitea label pages read per audit. Mirrors the provider's own
 * fail-closed paging (`gitea-work-item-provider.ts`): the audit reports *missing*
 * labels, so a truncated list must never read as "label absent". If every page up
 * to this cap comes back non-empty the lookup reports `unavailable` instead of a
 * possibly-wrong missing-label error.
 */
const GITEA_LABEL_MAX_PAGES = 50;

/**
 * A wall-clock budget shared by every tracker probe of one audit run.
 *
 * The audit is a diagnostic an operator runs in the foreground, and it issues two
 * independent tracker reads (labels, then visibility). Giving each its own
 * full-length timeout would let an unresponsive tracker cost the command twice
 * the advertised budget, so both draw down the same remaining time.
 */
export interface ProbeDeadline {
  /** Milliseconds left in the shared budget; `0` once it is spent. */
  remainingMs(): number;
  /** The budget this deadline was created with, for the expiry message. */
  budgetMs: number;
}

/** `now` is injectable so expiry is testable without waiting for it. */
export function createProbeDeadline(
  now: () => number = () => Date.now(),
  budgetMs: number = TRACKER_PROBE_BUDGET_MS,
): ProbeDeadline {
  const expiresAt = now() + budgetMs;
  return { remainingMs: () => Math.max(0, expiresAt - now()), budgetMs };
}

/**
 * Wrap a Gitea transport in the run's shared wall-clock budget. An unresponsive
 * instance has to end as an `unavailable` finding rather than as a hang; the
 * thrown expiry travels the same path as a refused connection.
 *
 * `now`/`budgetMs` are kept as parameters (rather than taking a
 * {@link ProbeDeadline}) so a caller can bound an injected transport on its own.
 */
export function withGiteaProbeBudget(
  inner: GiteaHttpRequest,
  now: () => number = () => Date.now(),
  budgetMs: number = TRACKER_PROBE_BUDGET_MS,
): GiteaHttpRequest {
  return boundGiteaTransport(() => inner, createProbeDeadline(now, budgetMs));
}

/**
 * Refuse a Gitea request once the deadline it shares with every other probe is
 * spent, and build the transport from what is *left* of that deadline so a
 * request started near the end cannot outlive the budget it was checked against.
 */
function boundGiteaTransport(
  transportFor: (remainingMs: number) => GiteaHttpRequest,
  deadline: ProbeDeadline,
): GiteaHttpRequest {
  return (req) => {
    const remaining = deadline.remainingMs();
    if (remaining <= 0) {
      throw new Error(`Gitea audit probes exceeded their ${deadline.budgetMs}ms budget`);
    }
    return transportFor(remaining)(req);
  };
}

/**
 * The transport the audit uses when the caller injects none: bounded twice over.
 * The per-request timeout is clamped to the shared budget's remaining time, so
 * the last page of a paginated read cannot push the run past that budget the way
 * a fixed {@link GITEA_REQUEST_TIMEOUT_MS} wait would.
 *
 * `make` is injectable so a test can observe the timeout each request is built
 * with without standing up a Gitea instance.
 */
export function defaultAuditGiteaHttp(
  deadline: ProbeDeadline,
  make: (timeoutMs: number) => GiteaHttpRequest = (timeoutMs) => createGiteaHttp({ timeoutMs }),
): GiteaHttpRequest {
  return boundGiteaTransport((remainingMs) => make(Math.min(GITEA_REQUEST_TIMEOUT_MS, remainingMs)), deadline);
}

/**
 * One read-only `gh` probe, bounded by what is left of the run's shared budget.
 * An exhausted budget is reported as a probe failure instead of starting another
 * full-length wait — which is what makes the label read and the visibility read
 * cost one budget between them, not one each.
 */
function ghProbe(
  args: string[],
  cwd: string | undefined,
  deadline: ProbeDeadline,
): { ok: boolean; output: string } {
  const remaining = deadline.remainingMs();
  if (remaining <= 0) {
    return { ok: false, output: `gh audit probes exceeded their ${deadline.budgetMs}ms budget` };
  }
  return probe("gh", args, cwd, remaining);
}

/**
 * The run's shared deadline. {@link collectSessionAuditFacts} always injects one,
 * so this fallback only covers a direct call with a bare deps object — it must
 * never be how the two probes of a single audit get theirs.
 */
function deadlineOf(deps: SessionAuditProbeDeps): ProbeDeadline {
  return deps.deadline ?? createProbeDeadline();
}

/**
 * One read-only Gitea `GET`, returning parsed JSON. The API token rides in the
 * Authorization header only, and every error string is redacted before it can
 * reach the audit payload.
 */
function giteaGet(
  http: GiteaHttpRequest,
  gitea: GiteaWorkItemConfig,
  token: string,
  suffix: string,
  query?: Record<string, string>,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const path = `/repos/${encodeURIComponent(gitea.owner)}/${encodeURIComponent(gitea.repo)}${suffix}`;
  const url = buildGiteaApiUrl(gitea.baseUrl, gitea.apiPath, path, query);
  const fail = (message: string) => ({ ok: false as const, error: redactGiteaSecrets(message, [token]) });
  let res: GiteaHttpResponse;
  try {
    res = http({
      method: "GET",
      url,
      headers: {
        // Gitea personal access tokens use the `token <value>` scheme.
        Authorization: `token ${token}`,
        Accept: "application/json",
        "User-Agent": "n8n-ai-cli-loop",
      },
    });
  } catch (err) {
    // The transport throws only on a transport-level failure (DNS, refused
    // connection); a non-2xx response is a normal return.
    return fail(`Gitea request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status < 200 || res.status >= 300) {
    return fail(`Gitea GET ${path} (HTTP ${res.status}): ${(res.body || res.statusText || "").slice(0, 200)}`);
  }
  try {
    return { ok: true, value: JSON.parse(res.body || "null") };
  } catch (err) {
    return fail(
      `could not parse Gitea response for ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The connection block + resolved API token a Gitea probe needs, or the reason it cannot run. */
function giteaProbeContext(
  session: ResolvedSession,
  deps: SessionAuditProbeDeps,
): { ok: true; gitea: GiteaWorkItemConfig; token: string; http: GiteaHttpRequest } | { ok: false; error: string } {
  const gitea = session.workItemProvider.gitea;
  if (!gitea) {
    return {
      ok: false,
      error: "session selects gitea-issues but carries no workItemProvider.gitea connection block",
    };
  }
  try {
    const token = resolveGiteaToken(session.workItemProvider.auth, { env: deps.env ?? process.env });
    return { ok: true, gitea, token, http: deps.giteaHttp ?? defaultAuditGiteaHttp(deadlineOf(deps)) };
  } catch (err) {
    return {
      ok: false,
      error: redactGiteaSecrets(
        `could not resolve the Gitea API token: ${err instanceof Error ? err.message : String(err)}`,
        [],
      ),
    };
  }
}

/**
 * Label names on the Gitea work-item repository, read through the same paginated
 * `/labels` endpoint the runtime provider uses to resolve a label name to its id.
 * Gitea intake routes on the very same literal names as GitHub (`labelsToPhase`
 * is provider-neutral) and `transitionItem` fails outright when a workflow label
 * is absent, so this check is not GitHub-specific and must not be skipped.
 */
function readGiteaLabels(session: ResolvedSession, deps: SessionAuditProbeDeps): LabelLookup {
  const ctx = giteaProbeContext(session, deps);
  if (!ctx.ok) return { status: "unavailable", error: ctx.error };
  const names: string[] = [];
  for (let page = 1; page <= GITEA_LABEL_MAX_PAGES; page++) {
    const res = giteaGet(ctx.http, ctx.gitea, ctx.token, "/labels", {
      limit: String(GITEA_LABEL_PAGE_LIMIT),
      page: String(page),
    });
    if (!res.ok) return { status: "unavailable", error: res.error };
    if (!Array.isArray(res.value)) {
      return { status: "unavailable", error: "Gitea label list did not return a JSON array" };
    }
    if (res.value.length === 0) return { status: "ok", names };
    for (const entry of res.value as Array<{ name?: unknown }>) {
      if (entry && typeof entry.name === "string" && entry.name.length > 0) names.push(entry.name);
    }
  }
  return {
    status: "unavailable",
    error:
      `Gitea label list did not terminate within ${GITEA_LABEL_MAX_PAGES} pages; refusing to report ` +
      "labels as missing from a truncated list",
  };
}

function readWorkItemLabels(
  session: ResolvedSession,
  offline: boolean,
  deps: SessionAuditProbeDeps,
): LabelLookup {
  if (offline) return { status: "skipped", reason: "--offline: tracker not queried" };
  if (session.workItemProvider.provider === "gitea-issues") {
    return readGiteaLabels(session, deps);
  }
  if (session.workItemProvider.provider !== "github-issues") {
    return {
      status: "skipped",
      reason: `work-item provider is ${session.workItemProvider.provider}; it has no wired runtime backend, so there is no label API to read`,
    };
  }
  const cwd = existsSync(session.repoRoot) ? session.repoRoot : undefined;
  const probed = ghProbe(
    ["label", "list", "--repo", session.githubRepo, "--json", "name", "--limit", String(GH_LABEL_MAX)],
    cwd,
    deadlineOf(deps),
  );
  if (!probed.ok) return { status: "unavailable", error: probed.output };
  let parsed: unknown;
  try {
    parsed = JSON.parse(probed.output || "[]");
  } catch (err) {
    return {
      status: "unavailable",
      error: `could not parse gh label list output: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { status: "unavailable", error: "gh label list did not return a JSON array" };
  }
  if (parsed.length >= GH_LABEL_MAX) {
    // `gh` pages internally but stops at `--limit`, so a full result set may be
    // truncated. Same fail-closed rule as the Gitea reader: the audit reports
    // labels as *missing*, and a truncated list is not evidence of absence.
    return {
      status: "unavailable",
      error:
        `gh label list returned the full ${GH_LABEL_MAX}-label request, so the list may be truncated; ` +
        "refusing to report labels as missing from an incomplete list",
    };
  }
  const names = (parsed as Array<{ name?: unknown }>)
    .map((l) => (typeof l.name === "string" ? l.name : ""))
    .filter((n) => n.length > 0);
  return { status: "ok", names };
}

/**
 * Visibility of the repository that holds this session's work items, probed per
 * provider. On GitHub only `PUBLIC` is world-readable; `INTERNAL` (org-wide) is
 * treated as private here because the boundary question this answers is "can
 * anyone on the internet read the loop's work-item comments?".
 *
 * A provider with no probe returns `unknown`, never `skipped`: the audit must not
 * quietly certify a boundary it has not observed, and `unknown` is what makes the
 * consuming check ask the operator to confirm (and acknowledge) it instead.
 */
function readRepoVisibility(
  session: ResolvedSession,
  offline: boolean,
  deps: SessionAuditProbeDeps,
): RepoVisibility {
  if (offline) return { status: "skipped", reason: "--offline: tracker not queried" };
  if (session.workItemProvider.provider === "gitea-issues") {
    return readGiteaVisibility(session, deps);
  }
  if (session.workItemProvider.provider !== "github-issues") {
    return {
      status: "unknown",
      reason: `no visibility probe is implemented for work-item provider ${session.workItemProvider.provider}`,
    };
  }
  const cwd = existsSync(session.repoRoot) ? session.repoRoot : undefined;
  const probed = ghProbe(
    ["repo", "view", session.githubRepo, "--json", "visibility"],
    cwd,
    deadlineOf(deps),
  );
  if (!probed.ok) return { status: "unavailable", error: probed.output };
  try {
    const parsed = JSON.parse(probed.output || "{}") as { visibility?: unknown };
    if (typeof parsed.visibility !== "string") {
      return { status: "unavailable", error: "gh repo view returned no visibility field" };
    }
    return {
      status: "known",
      visibility: parsed.visibility.toUpperCase() === "PUBLIC" ? "public" : "private",
    };
  } catch (err) {
    return {
      status: "unavailable",
      error: `could not parse gh repo view output: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Visibility of the Gitea repository that holds this session's work items. A
 * Gitea repository carries a boolean `private` flag, so — unlike GitHub's
 * three-valued `visibility` — the mapping is direct. A non-private repository on
 * an instance that is itself only reachable from an internal network is still
 * reported as public; that is the case an operator settles once, in writing, via
 * `audit.acknowledge["public-private-boundary"]`.
 */
function readGiteaVisibility(session: ResolvedSession, deps: SessionAuditProbeDeps): RepoVisibility {
  const ctx = giteaProbeContext(session, deps);
  if (!ctx.ok) return { status: "unavailable", error: ctx.error };
  const res = giteaGet(ctx.http, ctx.gitea, ctx.token, "");
  if (!res.ok) return { status: "unavailable", error: res.error };
  const value = res.value as { private?: unknown } | null;
  if (!value || typeof value.private !== "boolean") {
    return { status: "unavailable", error: "Gitea repository read returned no `private` field" };
  }
  return { status: "known", visibility: value.private ? "private" : "public" };
}

/** Collect every out-of-config observation the pure audit needs. All read-only. */
export function collectSessionAuditFacts(
  session: ResolvedSession,
  offline: boolean,
  deps: SessionAuditProbeDeps = {},
): SessionAuditFacts {
  const repoRootExists = existsSync(session.repoRoot);
  // One wall-clock budget is shared by the label and visibility probes — one
  // transport for the Gitea path, one deadline for the `gh` path — so an
  // unresponsive tracker cannot cost the audit that budget once per probe.
  const deadline = deps.deadline ?? createProbeDeadline();
  const probeDeps: SessionAuditProbeDeps = {
    ...deps,
    giteaHttp: deps.giteaHttp ?? defaultAuditGiteaHttp(deadline),
    deadline,
  };
  return {
    repoRootExists,
    artifactDirIgnored: repoRootExists
      ? checkGitIgnored(session.repoRoot, session.artifactDir)
      : "unknown",
    detectedEcosystems: detectEcosystems(session.repoRoot),
    workItemLabels: readWorkItemLabels(session, offline, probeDeps),
    workItemRepoVisibility: readRepoVisibility(session, offline, probeDeps),
  };
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

export async function runSessionAudit(argv: string[]): Promise<void> {
  const parsed = parseSessionAuditArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, sessionsPath, offline } = parsed;

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
    die(`Unknown sessionId: ${sessionId} (not found in ${sessionsPath})`);
  }

  const facts = collectSessionAuditFacts(session, offline);
  const payload = buildSessionAudit(session, facts);
  report(payload as unknown as Record<string, unknown>, (mode) => renderSessionAudit(payload, mode));
}

// ---------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------

const VERDICT_LABEL: Record<SessionAuditPayload["verdict"], string> = {
  ready: "READY",
  "needs-attention": "NEEDS ATTENTION",
  "not-ready": "NOT READY",
};

/**
 * Findings first, most blocking first: an operator reading this wants the list of
 * things to fix, not a catalog. Passing and skipped checks are still listed (one
 * line each) so the audit's coverage is visible rather than implied.
 */
const STATUS_ORDER: AuditStatus[] = [
  "error",
  "warning",
  "suggestion",
  "acknowledged",
  "ok",
  "skipped",
];

const STATUS_LABEL: Record<AuditStatus, string> = {
  error: "ERROR",
  warning: "WARN",
  suggestion: "SUGGEST",
  acknowledged: "ACCEPTED",
  ok: "ok",
  skipped: "skip",
};

export function renderSessionAudit(payload: SessionAuditPayload, mode: OutputMode): string {
  const lines: string[] = [];
  lines.push(`Loop design audit for session "${payload.sessionId}"`);
  const s = payload.summary;
  lines.push(
    `  verdict: ${VERDICT_LABEL[payload.verdict]} — ${s.error} error(s), ${s.warning} warning(s), ` +
      `${s.suggestion} suggestion(s), ${s.acknowledged} accepted, ${s.ok} ok, ${s.skipped} skipped`,
  );

  for (const status of STATUS_ORDER) {
    const group = payload.checks.filter((c) => c.status === status);
    if (group.length === 0) continue;
    if (status === "ok" || status === "skipped") {
      // Non-findings: one compact line each, and only when not in quiet mode.
      if (mode.quiet) continue;
      lines.push("");
      for (const check of group) {
        lines.push(`  ${STATUS_LABEL[status].padEnd(8)} ${check.id.padEnd(24)} ${check.detail}`);
      }
      continue;
    }
    lines.push("");
    for (const check of group) {
      lines.push(...renderFinding(check));
    }
  }

  if (payload.verdict === "ready" && s.suggestion === 0) {
    lines.push("");
    lines.push("  No design findings.");
  }
  return lines.join("\n");
}

function renderFinding(check: AuditCheck): string[] {
  const lines: string[] = [];
  lines.push(`  ${STATUS_LABEL[check.status].padEnd(8)} ${check.id.padEnd(24)} ${check.title}`);
  lines.push(`      ${check.detail}`);
  if (check.acknowledged) {
    lines.push(
      `      accepted (${STATUS_LABEL[check.acknowledged.severity]}): ${check.acknowledged.reason}`,
    );
  }
  if (check.remedy) lines.push(`      -> ${check.remedy}`);
  return lines;
}
