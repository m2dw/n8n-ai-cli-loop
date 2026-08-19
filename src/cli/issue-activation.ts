/**
 * `admin issue activate|suspend <issue[,issue...]>` (issue #787).
 *
 * Thin CLI wrapper around the pure service in `core/issue-activation.ts`:
 * resolves the session and a concrete `WorkItemProvider` for it, opens the
 * restorable-suspension store, and reports each Issue's outcome. Preview by
 * default (the existing admin CLI confirmation convention); pass `--yes` to
 * apply. Multiple Issues are processed independently — one Issue's failure
 * never stops the rest, and the command's exit code reflects whether every
 * Issue succeeded.
 */

import type { ResolvedSession } from "../core/session.js";
import type { WorkItemProvider } from "../providers/types.js";
import {
  planActivate,
  planSuspend,
  suspendIssueAutomation,
  activateIssueAutomation,
  type IssueActivationOutcome,
  type IssueActivationStore,
} from "../core/issue-activation.js";
import { SqliteIssueActivationStore } from "../stores/sqlite-issue-activation-store.js";
import { DEFAULT_SESSIONS_PATH, describeUnresolvedSessionId, JsonSessionRegistry } from "../registries/json-session-registry.js";
import { parseCommonOptions } from "./admin-command.js";
import { die, report, type OutputMode } from "./cli-io.js";
import { GhWorkItemProvider } from "../providers/github/gh-work-item-provider.js";
import { ghRunnerFromCommandRunner } from "../providers/github/gh-runner.js";
import { resolveGhRunner } from "../providers/github/github-app-auth.js";
import type { GhRunnerAuthDeps } from "../providers/github/github-app-auth.js";
import { GiteaWorkItemProvider } from "../providers/gitea/gitea-work-item-provider.js";
import { resolveGiteaToken, defaultGiteaHttp } from "../providers/gitea/gitea-client.js";
import type { GiteaHttpRequest } from "../providers/gitea/gitea-client.js";
import { defaultCommandRunner } from "../handlers/command-runner.js";

type IssueActivationAction = "suspend" | "activate";

interface IssueActivationArgs {
  sessionId: string;
  issueNumbers: number[];
  sessionsPath: string;
  dbPath: string | undefined;
  yes: boolean;
}

/**
 * Parse `<issue[,issue...]>` into an order-preserving list.
 *
 * Exported for `admin chain new|append|prepend` (issue #791), which takes the
 * same argument in the same shape — and for which the *order* is not
 * cosmetic: it is the dependency order the linear edit links the Issues in.
 *
 * A repeat is collapsed by default, which is the right answer for
 * `admin issue activate|suspend`: the list there is a set of Issues to act on
 * one by one, and naming one twice asks for the same thing twice.
 *
 * `duplicates: "reject"` is for the callers where the list is a *sequence*.
 * Collapsing `10,11,10` to `10,11` there would quietly execute a different
 * topology than the operator typed — the repeat is a request to reorder or to
 * close a cycle, and both are findings, not noise to be smoothed away (issue
 * #791 review).
 */
export function parseIssueNumberList(
  raw: string,
  options: { duplicates?: "collapse" | "reject" } = {},
): { value: number[] } | { error: string } {
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return { error: "issue number list must not be empty" };
  const seen = new Set<number>();
  const numbers: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n <= 0) {
      return { error: `Invalid issue number: ${part}` };
    }
    if (!seen.has(n)) {
      seen.add(n);
      numbers.push(n);
    } else if (options.duplicates === "reject") {
      return {
        error:
          `Issue #${n} is named more than once in "${raw}". The Issues are linked in the order given, so a repeat ` +
          "would describe a different graph than the one it reads as — name each Issue exactly once.",
      };
    }
  }
  return { value: numbers };
}

function parseIssueActivationArgs(argv: string[]): IssueActivationArgs | { error: string } {
  const opts = parseCommonOptions(argv, {
    session: "required",
    booleanFlags: ["yes"],
    allowPositionals: true,
  });
  if ("error" in opts) return { error: opts.error };
  if (opts.positionals.length === 0) {
    return { error: "issue number(s) are required, e.g. admin issue suspend 101,102 --session-ref 1" };
  }
  if (opts.positionals.length > 1) {
    return { error: `Unexpected argument: ${opts.positionals[1]}` };
  }
  const issueNumbers = parseIssueNumberList(opts.positionals[0]);
  if ("error" in issueNumbers) return { error: issueNumbers.error };
  return {
    sessionId: opts.sessionId,
    issueNumbers: issueNumbers.value,
    sessionsPath: opts.sessionsPath,
    dbPath: opts.dbPath,
    yes: opts.flags.has("yes"),
  };
}

/**
 * Resolve the session's concrete `WorkItemProvider`, mirroring the
 * provider-selection logic in `run-one-phase.ts`/`dispatch-outbox.ts`:
 * `gh`/GitHub-App auth for `github-issues`, token auth for `gitea-issues`.
 * Throws on an unsupported/misconfigured provider — a setup error, never a
 * silent fallback to GitHub.
 */
export async function resolveIssueWorkItemProvider(
  session: ResolvedSession,
  authDeps?: GhRunnerAuthDeps,
  giteaHttp: GiteaHttpRequest = defaultGiteaHttp,
): Promise<WorkItemProvider> {
  const workItemKind = session.workItemProvider?.provider ?? "github-issues";
  if (workItemKind === "gitea-issues") {
    const gitea = session.workItemProvider?.gitea;
    if (!gitea) {
      throw new Error(`Session ${session.sessionId} selects gitea-issues but is missing the gitea connection block`);
    }
    const token = resolveGiteaToken(session.workItemProvider.auth, {
      env: authDeps?.env,
      resolveKey: authDeps?.resolveKey,
    });
    return new GiteaWorkItemProvider({
      baseUrl: gitea.baseUrl,
      owner: gitea.owner,
      repo: gitea.repo,
      token,
      ...(gitea.apiPath !== undefined ? { apiPath: gitea.apiPath } : {}),
      http: giteaHttp,
    });
  }
  if (workItemKind !== "github-issues") {
    throw new Error(`Issue activation/suspension is not implemented for work-item provider "${workItemKind}"`);
  }
  const auth = session.workItemProvider?.auth ?? { mode: "gh" };
  const cmdGhRunner = ghRunnerFromCommandRunner(defaultCommandRunner);
  const runner = await resolveGhRunner(auth, cmdGhRunner, authDeps);
  return new GhWorkItemProvider(runner, session.githubRepo, session.repoRoot);
}

/** Preview-mode outcome for one Issue: the plan `--yes` would apply, computed
 * read-only (no label mutation, no store write). */
async function previewOutcome(
  session: ResolvedSession,
  provider: WorkItemProvider,
  store: IssueActivationStore,
  issueNumber: number,
  action: IssueActivationAction,
): Promise<IssueActivationOutcome> {
  const read = provider.getItem(issueNumber);
  if (!read.ok) {
    return { issueNumber, ok: false, error: read.error, removed: [], added: [], preserved: [], restorable: [] };
  }
  if (action === "suspend") {
    const diff = planSuspend(session, read.value.labels);
    const existing = await store.getSuspension(session.sessionId, issueNumber);
    // Mirrors persistSuspensionRecord's merge (issue #787 review): a prior
    // partial-failure suspend may already have some labels on record that are
    // no longer present on the Issue (so `diff.removed` won't re-surface
    // them). The preview's `restorable` must show what --yes would actually
    // commit — the union of that standing record and what this run would
    // newly remove — not just the newly-removed set alone.
    const restorable =
      diff.removed.length > 0
        ? Array.from(new Set([...(existing?.labels ?? []), ...diff.removed]))
        : existing?.labels ?? [];
    return {
      issueNumber,
      ok: true,
      removed: diff.removed,
      added: [],
      preserved: diff.preserved,
      restorable,
      alreadySuspended: diff.removed.length === 0 && restorable.length > 0,
    };
  }
  const existing = await store.getSuspension(session.sessionId, issueNumber);
  if (!existing || existing.labels.length === 0) {
    return { issueNumber, ok: true, removed: [], added: [], preserved: [], restorable: [], alreadyActive: true };
  }
  const diff = planActivate(existing.labels, read.value.labels);
  const stillSuspended = existing.labels.filter((l) => !diff.added.includes(l) && !read.value.labels.includes(l));
  return { issueNumber, ok: true, removed: [], added: diff.added, preserved: diff.preserved, restorable: stillSuspended };
}

function renderIssueActivation(
  action: IssueActivationAction,
  sessionId: string,
  dryRun: boolean,
  results: IssueActivationOutcome[],
  _mode: OutputMode,
): string {
  const verb = action === "suspend" ? "Suspend" : "Activate";
  const lines = [
    `${verb} automation for session ${sessionId}: ${dryRun ? "preview" : "applied"} for ${results.length} issue(s).`,
  ];
  for (const r of results) {
    if (!r.ok) {
      lines.push(`  #${r.issueNumber}: FAILED (${r.error ?? "unknown error"})`);
      continue;
    }
    if (action === "suspend") {
      if (r.alreadySuspended) {
        lines.push(`  #${r.issueNumber}: already suspended (restorable: ${r.restorable.join(", ") || "none"})`);
      } else if (r.removed.length === 0) {
        lines.push(`  #${r.issueNumber}: no execution labels present; nothing to suspend`);
      } else {
        lines.push(
          `  #${r.issueNumber}: ${dryRun ? "would remove" : "removed"} ${r.removed.join(", ")}` +
            ` (preserved: ${r.preserved.join(", ") || "none"})`,
        );
      }
    } else {
      if (r.alreadyActive) {
        lines.push(`  #${r.issueNumber}: no suspension on record; nothing to restore`);
      } else if (r.added.length === 0 && r.restorable.length === 0) {
        lines.push(`  #${r.issueNumber}: already fully restored`);
      } else {
        lines.push(
          `  #${r.issueNumber}: ${dryRun ? "would restore" : "restored"} ${r.added.join(", ") || "none"}` +
            (r.restorable.length > 0 ? ` (still suspended: ${r.restorable.join(", ")})` : ""),
        );
      }
    }
  }
  if (dryRun) lines.push("Run with --yes to apply.");
  return lines.join("\n");
}

async function runIssueActivationCommand(argv: string[], action: IssueActivationAction): Promise<void> {
  const parsed = parseIssueActivationArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { sessionId, issueNumbers, sessionsPath, dbPath, yes } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const session = await registry.getSessionById(sessionId);
  if (!session) die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));

  let provider: WorkItemProvider;
  try {
    provider = await resolveIssueWorkItemProvider(session);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const store = new SqliteIssueActivationStore(dbPath);
  const now = new Date().toISOString();
  const operationId = `admin-issue-${action}-${now}`;
  const results: IssueActivationOutcome[] = [];
  try {
    for (const issueNumber of issueNumbers) {
      // Per-Issue batch isolation (issue #787 review): a rejection from
      // `previewOutcome`/`suspendIssueAutomation`/`activateIssueAutomation`
      // (e.g. the store throwing on a locked/corrupt row) must not abort the
      // rest of the batch — the command contract is that one Issue's failure
      // never blocks the others, so catch here and report a failed outcome
      // for just that Issue instead of letting the loop exit early.
      try {
        if (!yes) {
          results.push(await previewOutcome(session, provider, store, issueNumber, action));
          continue;
        }
        const outcome =
          action === "suspend"
            ? await suspendIssueAutomation(session, provider, store, issueNumber, operationId, now)
            : await activateIssueAutomation(session, provider, store, issueNumber, now);
        results.push(outcome);
      } catch (err) {
        results.push({
          issueNumber,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          removed: [],
          added: [],
          preserved: [],
          restorable: [],
        });
      }
    }
  } finally {
    store.close();
  }

  const allOk = results.every((r) => r.ok);
  const payload = { ok: allOk, sessionId, action, dryRun: !yes, results };
  report(payload, (mode) => renderIssueActivation(action, sessionId, !yes, results, mode));
  if (!allOk) process.exitCode = 1;
}

export async function runIssueSuspend(argv: string[]): Promise<void> {
  await runIssueActivationCommand(argv, "suspend");
}

export async function runIssueActivate(argv: string[]): Promise<void> {
  await runIssueActivationCommand(argv, "activate");
}
