/**
 * Session design audit (issue #533) — the pure decision layer behind
 * `admin session-audit`.
 *
 * `session-doctor` answers "can this machine run the loop?" (repo present, `gh`
 * authenticated, agent CLIs installed, SQLite healthy). It deliberately says
 * nothing about whether a session is *designed* well as an automation loop.
 * This module answers the second question: given the session's configuration —
 * and a small set of read-only observations about its repository and work-item
 * tracker — does the loop have the operational safeguards an unattended agent
 * loop needs? Verification, an operator kill switch, handoff notifications,
 * artifact hygiene, coherent worktree/environment settings, explicit
 * assignment, and a clear public/private boundary.
 *
 * Design constraints (from the issue's acceptance criteria):
 *
 *  - **Read-only.** Nothing here mutates GitHub, SQLite, or the repository, and
 *    no project command (test/build/lint) is ever executed. All observations
 *    arrive pre-collected in {@link SessionAuditFacts}, gathered by the CLI layer
 *    with read-only probes (`git check-ignore`, `gh label list`, `existsSync`).
 *  - **Pure.** {@link buildSessionAudit} performs no I/O, so every rule below is
 *    directly unit-testable by handing it a session plus synthetic facts.
 *  - **Actionable, graded output.** Each check reports one of `error` /
 *    `warning` / `suggestion` (or `ok` / `skipped` / `acknowledged`) plus a
 *    concrete remedy, so an operator can tell "this will break the loop" from
 *    "this would make the loop better".
 *
 * Where the issue's candidate checks landed:
 *
 *   required labels            -> `work-item-labels`
 *   artifactDir ignored        -> `artifact-dir-ignored` (+ `artifact-location`)
 *   verification configured    -> `verification-commands`
 *   stopped/handoff notice     -> `handoff-notifications` (+ `notification-secret`)
 *   worktree coherence         -> `worktree-root`
 *   env prepare / dep sync     -> `environment-prepare`, `dependency-sync`
 *   operator recovery path     -> `session-state-labels` (distinct handoff states),
 *                                 `handoff-notifications` (someone is told),
 *                                 `artifact-location` (where the run's logs are)
 *   pause / circuit breaker    -> `circuit-breaker` (the feature landed in #531)
 *   assignment defaults        -> `assignment-defaults`
 *   public/private boundary    -> `public-private-boundary`
 *
 * Intentional deviations are first-class: a session may record, per check id, a
 * documented reason for accepting a finding (`session.audit.acknowledge`). An
 * acknowledged finding is still listed — with its original severity and the
 * operator's reason — but no longer drags the verdict down. That is what lets a
 * session satisfy "verification commands are configured, **or** the session
 * intentionally documents why not" without inventing a per-check opt-out flag.
 * The one exception is `audit-acknowledgements`, the check that validates the
 * block itself: it is never acknowledgeable, so a self-referential entry cannot
 * suppress the report of the invalid keys sitting beside it.
 */

import type { ResolvedSession } from "./session.js";
import type { ResolvedAssignment } from "./assignment.js";
import { resolveAssignment } from "./assignment.js";
import { resolveCircuitBreakerPolicy } from "./session-control.js";
import { WORKTREE_ROOT_ENV, resolveWorktreeRoot } from "./worktree-paths.js";
import { isAbsolute, relative, resolve } from "path";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/** Severity of a finding, ordered most to least blocking. */
export type AuditSeverity = "error" | "warning" | "suggestion";

/**
 * Reported state of a single check. `ok` and `skipped` are non-findings;
 * `acknowledged` is a finding the session has explicitly accepted in writing.
 */
export type AuditStatus = AuditSeverity | "ok" | "skipped" | "acknowledged";

/** Design area a check belongs to; used only to group human output. */
export type AuditCategory =
  | "labels"
  | "artifacts"
  | "verification"
  | "notifications"
  | "worktrees"
  | "environment"
  | "controls"
  | "assignment"
  | "visibility"
  | "audit";

export interface AuditCheck {
  /** Stable check id. Also the key used by `session.audit.acknowledge`. */
  id: string;
  category: AuditCategory;
  /** Short human title, e.g. "Verification commands". */
  title: string;
  status: AuditStatus;
  /** What was observed. Always present, including for `ok`. */
  detail: string;
  /** Concrete next step. Present for every non-`ok`, non-`skipped` status. */
  remedy?: string;
  /**
   * Present only when `status` is `acknowledged`: the severity the finding would
   * have carried, plus the operator's documented reason for accepting it.
   */
  acknowledged?: { severity: AuditSeverity; reason: string };
}

/**
 * Overall readiness. `not-ready` means at least one finding will break or
 * silently degrade the loop; `needs-attention` means at least one warning;
 * `ready` means only suggestions (or nothing) remain.
 */
export type AuditVerdict = "ready" | "needs-attention" | "not-ready";

export interface AuditSummary {
  ok: number;
  error: number;
  warning: number;
  suggestion: number;
  acknowledged: number;
  skipped: number;
  total: number;
}

export interface SessionAuditPayload {
  /** Always true: the command ran. Readiness lives in `verdict`, not here. */
  ok: true;
  sessionId: string;
  generatedAt: string;
  verdict: AuditVerdict;
  summary: AuditSummary;
  checks: AuditCheck[];
}

// ---------------------------------------------------------------------------
// Facts: the read-only observations the CLI layer collects
// ---------------------------------------------------------------------------

/** Outcome of the read-only work-item label lookup. */
export type LabelLookup =
  | { status: "ok"; names: string[] }
  | { status: "unavailable"; error: string }
  | { status: "skipped"; reason: string };

/**
 * Outcome of the read-only work-item repository visibility lookup.
 *
 * `unknown` and `unavailable` are deliberately distinct: `unavailable` means a
 * probe ran and failed (bad credentials, tracker down), while `unknown` means no
 * probe exists for this provider at all. Neither may be reported as "private" —
 * an unprobed tracker is not evidence of a closed boundary.
 */
export type RepoVisibility =
  | { status: "known"; visibility: "public" | "private" }
  | { status: "unavailable"; error: string }
  | { status: "unknown"; reason: string }
  | { status: "skipped"; reason: string };

/**
 * Everything {@link buildSessionAudit} needs from outside the session config.
 * Collected by the CLI layer with read-only probes so the rules stay pure.
 */
export interface SessionAuditFacts {
  /** Whether `repoRoot` exists on disk; gates the repo-derived checks. */
  repoRootExists: boolean;
  /** `git check-ignore` verdict for `artifactDir` inside `repoRoot`. */
  artifactDirIgnored: "ignored" | "not-ignored" | "unknown";
  /**
   * Names of the ecosystem presets (`src/core/presets.ts`) whose `cacheKeyFiles` were found under
   * `repoRoot` (e.g. `package-lock.json` -> `javascript-npm`). Lockfile presence
   * is used rather than manifest presence because it is the stronger signal that
   * a dependency install step is meaningful for this repository.
   */
  detectedEcosystems: string[];
  /** Label names on the work-item tracker, when they could be read. */
  workItemLabels: LabelLookup;
  /** Visibility of the work-item repository, when it could be read. */
  workItemRepoVisibility: RepoVisibility;
}

/**
 * Routing labels the loop matches as *literal* strings, whatever a session's
 * `labels` block says. `src/core/github-intake.ts` (`labelsToPhase`) compares
 * against these names directly, so an issue can only enter a lane when the
 * tracker carries them; a per-session override adds a name, it never retires one
 * of these. `status:backlog` is the operator-facing parking lane (docs/install.md):
 * not matched by intake, but part of the documented label set humans route on,
 * so `session-doctor` and this audit both require it.
 *
 * The list is provider-neutral. `labelsToPhase` routes a Gitea candidate on the
 * same literal names, and the Gitea provider's `transitionItem` fails outright
 * when a workflow label is absent from the repository, so these are required of
 * every wired tracker — not of GitHub alone.
 *
 * This is only half of the requirement: the effective, possibly-overridden names
 * the loop *writes* are added per session by {@link requiredWorkItemLabels}.
 */
export const FIXED_WORK_ITEM_ROUTING_LABELS: readonly string[] = [
  "agent:claude",
  "agent:codex",
  "agent:gemini",
  "status:needs-implementation",
  "status:needs-fix",
  "status:needs-review",
  "status:research-needed",
  "status:content-needed",
  "status:needs-conflict-resolution",
  "status:backlog",
];

/**
 * Labels the loop *writes* whose name comes from an optional `session.labels`
 * key with a literal fallback, and whose fallback is not already fixed above.
 * Each one is added by an outbox effect (`gh:label:add`, rewritten to a
 * `workitem:transition` for a non-GitHub tracker), and a label add fails when the
 * label does not exist on the tracker — taking the state transition with it.
 *
 * Key/fallback pairs rather than literals, because an override replaces the
 * default outright: a session with `labels.stackReady: "loop:stack-ready"` never
 * writes `status:stack-ready`, so requiring the literal would send an operator to
 * create a label nothing uses.
 *
 * The remaining defaulted write keys (`needsFix`, `needsReview`, `needsResearch`,
 * `needsConflictResolution`, `needsContentResearch`, …) fall back to names already
 * in {@link FIXED_WORK_ITEM_ROUTING_LABELS}, and their overrides are picked up by
 * the sweep over `session.labels` in {@link requiredWorkItemLabels}.
 *
 * Labels the loop only ever *removes* — `status:conflict-resolution-in-progress`
 * is the one such name with no add site — are deliberately absent: removing an
 * absent label is a no-op for the dispatcher (404 treated as ok), so its absence
 * cannot break a transition.
 */
const DEFAULTED_WRITTEN_LABELS: ReadonlyArray<readonly [key: string, fallback: string]> = [
  // Applied on every passing review; read back by the dependency resolver.
  ["stackReady", "status:stack-ready"],
  // Applied when conflict resolution gives up, to surface the failed lane.
  ["conflictResolutionFailed", "status:conflict-resolution-failed"],
];

/** A trimmed label name, or undefined when the entry is absent/blank. */
function labelName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The label names *this* session's loop actually depends on: the fixed routing
 * names intake matches, plus every effective name the runtime writes.
 *
 * Both halves are needed, and neither implies the other. Intake keeps matching
 * `status:needs-review` even when `labels.needsReview` renames the label the
 * outbox adds, so a renamed session needs both names present; and a session that
 * renames `labels.readyForHuman` (or `labels.blocked`, `labels.stackReady`, …)
 * would otherwise be certified `ready` while every outbound write of that label
 * fails at dispatch time.
 *
 * Every value in `session.labels` is swept, not just the three declared keys: the
 * block is a free-form `Record<string, string>` whose entries exist precisely to
 * name labels the loop writes (`needsReview`, `agentReview`, `stackReady`, …).
 */
export function requiredWorkItemLabels(session: ResolvedSession): string[] {
  const required = new Set<string>(FIXED_WORK_ITEM_ROUTING_LABELS);
  for (const [key, fallback] of DEFAULTED_WRITTEN_LABELS) {
    required.add(labelName(session.labels[key]) ?? fallback);
  }
  for (const value of Object.values(session.labels)) {
    // A blank configured name is reported by `session-state-labels`; requiring it
    // here would produce an unfixable "missing label ``" line beside it.
    const name = labelName(value);
    if (name) required.add(name);
  }
  return [...required];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * A check's own result, before an acknowledgement can downgrade it. `status` is
 * deliberately narrower than {@link AuditStatus}: only {@link applyAcknowledgement}
 * may produce `acknowledged`, which is what lets it treat a non-`ok` draft status
 * as an {@link AuditSeverity}.
 */
type Draft = Omit<AuditCheck, "acknowledged" | "status"> & {
  status: AuditSeverity | "ok" | "skipped";
};

function ok(id: string, category: AuditCategory, title: string, detail: string): Draft {
  return { id, category, title, status: "ok", detail };
}

function skipped(id: string, category: AuditCategory, title: string, detail: string): Draft {
  return { id, category, title, status: "skipped", detail };
}

function finding(
  id: string,
  category: AuditCategory,
  title: string,
  severity: AuditSeverity,
  detail: string,
  remedy: string,
): Draft {
  return { id, category, title, status: severity, detail, remedy };
}

/**
 * Audit a session's loop design. Pure: every external observation arrives in
 * `facts`, and `env` is passed explicitly so the env-configured circuit-breaker
 * and worktree-root rules are testable without touching `process.env`.
 */
export function buildSessionAudit(
  session: ResolvedSession,
  facts: SessionAuditFacts,
  env: NodeJS.ProcessEnv = process.env,
  now: string = new Date().toISOString(),
): SessionAuditPayload {
  const drafts: Draft[] = [
    checkWorkItemLabels(session, facts),
    checkSessionLabels(session),
    checkArtifactLocation(session),
    checkArtifactIgnored(session, facts),
    checkVerification(session),
    checkHandoffNotifications(session),
    checkNotificationSecret(session, env),
    checkWorktreeConfig(session, env),
    checkEnvironmentPrepare(session, facts),
    checkDependencySync(session, facts),
    checkCircuitBreaker(env),
    checkAssignment(session, now),
    checkPublicPrivateBoundary(session, facts),
  ];
  drafts.push(checkAcknowledgements(session, drafts));

  const checks = drafts.map((d) => applyAcknowledgement(d, session));
  return {
    ok: true,
    sessionId: session.sessionId,
    generatedAt: now,
    verdict: verdictOf(checks),
    summary: summarize(checks),
    checks,
  };
}

/**
 * Id of {@link checkAcknowledgements}, the check that validates the
 * acknowledgement block. Named here because it is also the one id that
 * {@link applyAcknowledgement} must refuse to act on.
 */
const ACKNOWLEDGEMENTS_CHECK_ID = "audit-acknowledgements";

/**
 * Downgrade a finding the session has documented a reason for. The original
 * severity is preserved in `acknowledged.severity` so the output still shows
 * what was accepted and how bad it is — an acknowledgement records a decision,
 * it does not erase the finding. `ok`/`skipped` checks are never rewritten (an
 * acknowledgement for a passing check is reported by
 * {@link checkAcknowledgements} instead).
 *
 * {@link ACKNOWLEDGEMENTS_CHECK_ID} is exempt: it is the validator *of* the
 * acknowledgement block. Letting it be acknowledged would let a single
 * self-referential entry suppress the report of every other invalid key — the
 * exact opposite of the rule that an unknown key suppresses nothing.
 */
function applyAcknowledgement(draft: Draft, session: ResolvedSession): AuditCheck {
  const reason = session.audit?.acknowledge?.[draft.id];
  if (
    !reason ||
    draft.status === "ok" ||
    draft.status === "skipped" ||
    draft.id === ACKNOWLEDGEMENTS_CHECK_ID
  ) {
    return draft;
  }
  return {
    ...draft,
    status: "acknowledged",
    acknowledged: { severity: draft.status, reason },
  };
}

function summarize(checks: AuditCheck[]): AuditSummary {
  const count = (status: AuditStatus) => checks.filter((c) => c.status === status).length;
  return {
    ok: count("ok"),
    error: count("error"),
    warning: count("warning"),
    suggestion: count("suggestion"),
    acknowledged: count("acknowledged"),
    skipped: count("skipped"),
    total: checks.length,
  };
}

function verdictOf(checks: AuditCheck[]): AuditVerdict {
  if (checks.some((c) => c.status === "error")) return "not-ready";
  if (checks.some((c) => c.status === "warning")) return "needs-attention";
  return "ready";
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * The intake/outbox labels must exist on the work-item tracker: a missing
 * `status:*` routing label means intake silently never picks those issues up,
 * and a missing state label means the loop cannot publish its own state.
 *
 * The required set is per session, not a fixed list — see
 * {@link requiredWorkItemLabels}: the literal names intake matches *plus* the
 * effective (possibly renamed) names the runtime writes, so a session that
 * overrides `labels.readyForHuman` is checked against the label its transitions
 * actually apply.
 *
 * This holds for every wired tracker, GitHub and Gitea alike: `labelsToPhase` is
 * provider-neutral and the Gitea provider's `transitionItem` fails outright when
 * a workflow label is missing, so skipping the check for a non-GitHub session
 * would hide exactly the configuration that stops work from being claimed.
 *
 * A failed lookup is a warning, never an error: an unreachable tracker (`gh` not
 * authenticated, Gitea unreachable) is not evidence that a label is absent, and
 * treating it as such would send operators to create labels that already exist.
 */
function checkWorkItemLabels(session: ResolvedSession, facts: SessionAuditFacts): Draft {
  const id = "work-item-labels";
  const title = "Required work-item labels";
  const tracker = describeWorkItemTracker(session);
  const lookup = facts.workItemLabels;
  if (lookup.status === "skipped") {
    return skipped(id, "labels", title, lookup.reason);
  }
  if (lookup.status === "unavailable") {
    return finding(
      id,
      "labels",
      title,
      "warning",
      `Could not read labels from ${tracker}: ${lookup.error}`,
      `Verify tracker access with \`admin session-doctor --session-id ${session.sessionId}\` and re-run ` +
        "the audit; an unreadable tracker is not proof the labels are missing.",
    );
  }
  const required = requiredWorkItemLabels(session);
  const have = new Set(lookup.names);
  const missing = required.filter((l) => !have.has(l));
  if (missing.length === 0) {
    return ok(id, "labels", title, `all ${required.length} routing labels present on ${tracker}`);
  }
  return finding(
    id,
    "labels",
    title,
    "error",
    `Missing on ${tracker}: ${missing.join(", ")}`,
    `Intake routes on these literal names and a state transition fails when its label is absent, so ` +
      `issues carrying them are never claimed and the loop cannot publish its own state. ` +
      createLabelsRemedy(session, tracker, missing),
  );
}

/**
 * How to create the missing labels on *this* session's tracker. The command
 * differs per provider, and a `gh` line pointed at a Gitea instance is worse than
 * no remedy at all — it would silently target a different repository.
 */
function createLabelsRemedy(
  session: ResolvedSession,
  tracker: string,
  missing: readonly string[],
): string {
  if (session.workItemProvider.provider === "github-issues") {
    return (
      "Create them: " +
      missing.map((l) => `gh label create "${l}" --repo ${session.githubRepo}`).join("; ")
    );
  }
  if (session.workItemProvider.provider === "gitea-issues") {
    return (
      `Create them on ${tracker} (Issues -> Labels, or POST /api/v1/repos/` +
      `${session.workItemProvider.gitea?.owner ?? "<owner>"}/` +
      `${session.workItemProvider.gitea?.repo ?? "<repo>"}/labels): ${missing.join(", ")}`
    );
  }
  return `Create them on ${tracker}: ${missing.join(", ")}`;
}

/**
 * Human-readable identity of the tracker that holds this session's work items.
 * In split-provider mode `githubRepo` names the *code* repository, which is not
 * where the work items live — naming that one would send an operator to fix
 * labels, or check visibility, on a repository the loop never files issues in.
 */
function describeWorkItemTracker(session: ResolvedSession): string {
  const provider = session.workItemProvider;
  if (provider.provider === "github-issues") return session.githubRepo;
  if (provider.provider === "gitea-issues" && provider.gitea) {
    return `${provider.gitea.baseUrl.replace(/\/+$/, "")}/${provider.gitea.owner}/${provider.gitea.repo}`;
  }
  return `the ${provider.provider} tracker`;
}

/**
 * The three session state labels drive mutually exclusive states (`active` while
 * a phase runs, `blocked` on a Tool Request/quota stop, `readyForHuman` on
 * handoff). If two of them are the same string, applying one state silently
 * clears another and a stopped loop can end up looking active.
 */
function checkSessionLabels(session: ResolvedSession): Draft {
  const id = "session-state-labels";
  const title = "Session state labels";
  const entries: Array<[string, string]> = [
    ["active", session.labels.active],
    ["blocked", session.labels.blocked],
    ["readyForHuman", session.labels.readyForHuman],
  ];
  const blank = entries.filter(([, v]) => v.trim().length === 0).map(([k]) => k);
  if (blank.length > 0) {
    return finding(
      id,
      "labels",
      title,
      "error",
      `Blank label name(s): ${blank.join(", ")}`,
      "Set a non-empty label name for each of labels.active / labels.blocked / labels.readyForHuman.",
    );
  }
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const [key, value] of entries) {
    const prior = seen.get(value);
    if (prior) collisions.push(`${prior} and ${key} both use "${value}"`);
    else seen.set(value, key);
  }
  if (collisions.length > 0) {
    return finding(
      id,
      "labels",
      title,
      "error",
      collisions.join("; "),
      "Give labels.active, labels.blocked and labels.readyForHuman distinct names — they are mutually " +
        "exclusive states, so a shared name makes a stopped loop indistinguishable from a running one.",
    );
  }
  return ok(
    id,
    "labels",
    title,
    entries.map(([k, v]) => `${k}=${v}`).join(", "),
  );
}

/**
 * `artifactRoot` is `resolve(repoRoot, artifactDir)`, so an absolute or
 * `..`-escaping `artifactDir` puts run artifacts outside the checkout — where
 * the repository's `.gitignore` cannot protect them and where an operator
 * looking for a stopped run's logs will not find them.
 */
function checkArtifactLocation(session: ResolvedSession): Draft {
  const id = "artifact-location";
  const title = "Artifact location";
  const artifactRoot = resolve(session.repoRoot, session.artifactDir);
  const rel = relative(session.repoRoot, artifactRoot);
  if (rel === "") {
    return finding(
      id,
      "artifacts",
      title,
      "error",
      `artifactDir "${session.artifactDir}" resolves to the checkout root itself (${session.repoRoot})`,
      'Point artifactDir at a dedicated subdirectory (e.g. ".n8n-artifacts") — artifact cleanup and the ' +
        "gitignore check both operate on that directory.",
    );
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return finding(
      id,
      "artifacts",
      title,
      "error",
      `artifactDir "${session.artifactDir}" resolves to ${artifactRoot}, outside ${session.repoRoot}`,
      'Use a repo-relative artifactDir (e.g. ".n8n-artifacts") so run logs live with the checkout and ' +
        "are covered by the repository's .gitignore.",
    );
  }
  return ok(id, "artifacts", title, `${artifactRoot} (repo-relative: ${rel})`);
}

/**
 * Run artifacts hold prompts, agent transcripts and local paths. If the
 * directory is not ignored, an implementation phase can commit them into the
 * very PR it opens — leaking internal detail into a public repository.
 */
function checkArtifactIgnored(session: ResolvedSession, facts: SessionAuditFacts): Draft {
  const id = "artifact-dir-ignored";
  const title = "Artifact dir gitignored";
  if (!facts.repoRootExists) {
    return finding(
      id,
      "artifacts",
      title,
      "warning",
      `Could not check: repoRoot does not exist (${session.repoRoot})`,
      "Fix the environment first (`admin session-doctor`), then re-run the audit.",
    );
  }
  if (facts.artifactDirIgnored === "ignored") {
    return ok(id, "artifacts", title, `${session.artifactDir} is ignored by ${session.repoRoot}`);
  }
  if (facts.artifactDirIgnored === "unknown") {
    return finding(
      id,
      "artifacts",
      title,
      "warning",
      `Could not determine whether ${session.artifactDir} is ignored in ${session.repoRoot}`,
      "Check the repository's ignore rules manually; an unverified artifact dir may be committed by a phase.",
    );
  }
  return finding(
    id,
    "artifacts",
    title,
    "error",
    `${session.artifactDir} is not ignored by ${session.repoRoot}`,
    `Run artifacts contain prompts, transcripts and local paths and can be committed by an implementation ` +
      `phase. Fix with: echo '${session.artifactDir}/' >> ${session.repoRoot}/.gitignore`,
  );
}

/**
 * Verification is what makes the loop self-correcting: with no configured
 * command, a phase's only quality gate is the review agent's opinion and a
 * broken change can reach a PR unchallenged. A session that genuinely has
 * nothing to run documents that via `audit.acknowledge`.
 */
function checkVerification(session: ResolvedSession): Draft {
  const id = "verification-commands";
  const title = "Verification commands";
  const names = Object.keys(session.verification ?? {});
  if (names.length === 0) {
    return finding(
      id,
      "verification",
      title,
      "error",
      "No verification commands are configured",
      "Add at least one command to the session's `verification` block (`admin session preset show " +
        "<name>` lists ecosystem defaults). If this repository genuinely has nothing to verify, record " +
        `why in audit.acknowledge["${id}"].`,
    );
  }
  const blank = names.filter((n) => (session.verification[n] ?? "").trim().length === 0);
  if (blank.length > 0) {
    return finding(
      id,
      "verification",
      title,
      "error",
      `Empty verification command(s): ${blank.join(", ")}`,
      "Give every verification entry a runnable command, or remove the empty entries.",
    );
  }
  return ok(id, "verification", title, `${names.length} configured: ${names.join(", ")}`);
}

/**
 * When the loop stops — Tool Request, quota cap, human handoff — nothing pushes
 * that fact to a human. Without a notification channel the only recovery path is
 * an operator remembering to poll `admin status`, which is exactly how a stalled
 * loop goes unnoticed for a day.
 */
function checkHandoffNotifications(session: ResolvedSession): Draft {
  const id = "handoff-notifications";
  const title = "Handoff notifications";
  const slack = session.notifications?.slack;
  if (slack?.enabled) {
    return ok(id, "notifications", title, `slack enabled (webhook from $${slack.webhookUrlEnv})`);
  }
  const detail = slack
    ? "notifications.slack is configured but disabled"
    : "No notification channel is configured";
  return finding(
    id,
    "notifications",
    title,
    "warning",
    detail,
    "Stopped/handoff states are then only discoverable by polling `admin status` / `admin list-stuck`. " +
      "Enable notifications.slack (enabled: true + webhookUrlEnv) to get pushed a ready-for-human signal.",
  );
}

/**
 * A notification channel whose secret env var is unset fails at dispatch time,
 * not at configuration time: the outbox keeps queueing notification rows that
 * can never be delivered, so the loop looks instrumented while no human is ever
 * actually told.
 */
function checkNotificationSecret(session: ResolvedSession, env: NodeJS.ProcessEnv): Draft {
  const id = "notification-secret";
  const title = "Notification secret";
  const slack = session.notifications?.slack;
  if (!slack?.enabled) {
    return skipped(id, "notifications", title, "no notification channel is enabled");
  }
  const value = env[slack.webhookUrlEnv];
  if (typeof value === "string" && value.trim().length > 0) {
    return ok(id, "notifications", title, `$${slack.webhookUrlEnv} is set in this environment`);
  }
  return finding(
    id,
    "notifications",
    title,
    "error",
    `$${slack.webhookUrlEnv} is not set in this environment`,
    `Slack notifications are enabled but the webhook URL resolves from $${slack.webhookUrlEnv} at ` +
      "dispatch time. Undelivered notification rows will accumulate in the outbox. Export the variable " +
      "for the process that runs `dispatch-outbox` (the loop's scheduler environment, not just your shell).",
  );
}

/**
 * Every phase runs in a per-issue worktree (issue #731), so the state root has
 * to be somewhere the checkout is not: a root under `repoRoot` would place full
 * repo checkouts inside committed source. This also surfaces the case where a
 * session pins its own root while the environment sets a different one — the
 * session wins, and an operator reading the env var would otherwise be looking
 * at the wrong directory.
 */
function checkWorktreeConfig(session: ResolvedSession, env: NodeJS.ProcessEnv): Draft {
  const id = "worktree-root";
  const title = "Worktree state root";
  let root: string;
  try {
    root = resolveWorktreeRoot({ sessionRoot: session.worktrees?.root, env });
  } catch (err) {
    return finding(
      id,
      "worktrees",
      title,
      "error",
      err instanceof Error ? err.message : String(err),
      `Set an absolute path in session.worktrees.root or ${WORKTREE_ROOT_ENV}.`,
    );
  }
  const rel = relative(session.repoRoot, root);
  const insideRepo = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (insideRepo) {
    return finding(
      id,
      "worktrees",
      title,
      "error",
      `Worktree state root ${root} is inside the checkout ${session.repoRoot}`,
      "Per-issue worktrees are full repo checkouts and must never live inside committed source. Point " +
        `session.worktrees.root (or ${WORKTREE_ROOT_ENV}) at a path outside ${session.repoRoot}.`,
    );
  }
  const envRoot = env[WORKTREE_ROOT_ENV];
  if (session.worktrees?.root && typeof envRoot === "string" && envRoot.trim() && envRoot !== root) {
    return finding(
      id,
      "worktrees",
      title,
      "warning",
      `session.worktrees.root (${root}) overrides ${WORKTREE_ROOT_ENV} (${envRoot})`,
      `The session value wins, so worktrees are created under ${root}. Remove one of the two so the ` +
        "effective root is unambiguous for anyone inspecting or cleaning up worktrees.",
    );
  }
  return ok(
    id,
    "worktrees",
    title,
    `${root} (${session.worktrees?.root ? "session override" : envRoot ? `${WORKTREE_ROOT_ENV} override` : "default"})`,
  );
}

/**
 * A repository whose dependencies are never installed fails verification for a
 * reason that has nothing to do with the agent's change. When a lockfile
 * identifies the ecosystem, the matching preset is named so the fix is a copy of
 * a known-good command rather than an invention.
 */
function checkEnvironmentPrepare(session: ResolvedSession, facts: SessionAuditFacts): Draft {
  const id = "environment-prepare";
  const title = "Environment preparation";
  const configured = session.environmentPrepare;
  const detected = facts.detectedEcosystems;
  if (configured?.enabled) {
    return ok(
      id,
      "environment",
      title,
      `enabled: ${configured.command}${detected.length ? ` (repo looks like: ${detected.join(", ")})` : ""}`,
    );
  }
  if (detected.length === 0) {
    return skipped(
      id,
      "environment",
      title,
      configured
        ? "environmentPrepare is configured but disabled; no known ecosystem lockfile detected either"
        : "no known ecosystem lockfile detected under repoRoot",
    );
  }
  const preset = detected[0];
  return finding(
    id,
    "environment",
    title,
    "warning",
    configured
      ? `environmentPrepare is configured but disabled, while the repo looks like: ${detected.join(", ")}`
      : `No environmentPrepare configured, but the repo looks like: ${detected.join(", ")}`,
    `Verification runs against an uninstalled dependency tree and can fail for reasons unrelated to the ` +
      `agent's change. See \`admin session preset show ${preset}\` for a ready-made environmentPrepare block.`,
  );
}

/**
 * Without handler-owned dependency sync, an agent that edits a manifest cannot
 * regenerate the lockfile: the change either lands inconsistent or has to detour
 * through a Tool Request handoff that stops the loop and waits for a human.
 */
function checkDependencySync(session: ResolvedSession, facts: SessionAuditFacts): Draft {
  const id = "dependency-sync";
  const title = "Dependency sync";
  const cfg = session.dependencySync;
  if (cfg?.enabled) {
    if (!cfg.triggerPaths || cfg.triggerPaths.length === 0) {
      return finding(
        id,
        "environment",
        title,
        "warning",
        "dependencySync is enabled but declares no triggerPaths",
        "No manifest change can ever make the sync eligible, so it never runs. List the manifest paths " +
          "(e.g. package.json) in dependencySync.triggerPaths.",
      );
    }
    return ok(id, "environment", title, `enabled: ${cfg.command} (on ${cfg.triggerPaths.join(", ")})`);
  }
  if (facts.detectedEcosystems.length === 0) {
    return skipped(id, "environment", title, "no known ecosystem lockfile detected under repoRoot");
  }
  return finding(
    id,
    "environment",
    title,
    "suggestion",
    cfg
      ? `dependencySync is configured but disabled (repo looks like: ${facts.detectedEcosystems.join(", ")})`
      : `No dependencySync configured (repo looks like: ${facts.detectedEcosystems.join(", ")})`,
    "A manifest edit then has to detour through a Tool Request handoff, which stops the loop until an " +
      "operator responds. See docs/tool-request-and-dependency-sync.md §3.",
  );
}

/**
 * The circuit breaker is the loop's automatic kill switch: without it a session
 * that fails the same way every run keeps burning quota until a human notices.
 * Both rules are env-tunable and `0` disables a rule, so a session can end up
 * with no automatic stop at all.
 */
function checkCircuitBreaker(env: NodeJS.ProcessEnv): Draft {
  const id = "circuit-breaker";
  const title = "Circuit breaker";
  const policy = resolveCircuitBreakerPolicy(env);
  const describe =
    `session-consecutive=${policy.maxConsecutiveFailures || "disabled"}, ` +
    `issue-phase=${policy.maxIssuePhaseFailures || "disabled"}`;
  if (policy.maxConsecutiveFailures === 0 && policy.maxIssuePhaseFailures === 0) {
    return finding(
      id,
      "controls",
      title,
      "error",
      `Both breaker rules are disabled (${describe})`,
      "Nothing pauses the session automatically, so a repeating failure burns quota until a human " +
        "intervenes. Unset (or set above 0) CIRCUIT_BREAKER_SESSION_FAILURES and " +
        "CIRCUIT_BREAKER_ISSUE_PHASE_FAILURES.",
    );
  }
  if (policy.maxConsecutiveFailures === 0 || policy.maxIssuePhaseFailures === 0) {
    const off =
      policy.maxConsecutiveFailures === 0
        ? "CIRCUIT_BREAKER_SESSION_FAILURES"
        : "CIRCUIT_BREAKER_ISSUE_PHASE_FAILURES";
    return finding(
      id,
      "controls",
      title,
      "warning",
      `One breaker rule is disabled (${describe})`,
      `${off}=0 turns off that rule. Leave it unset unless the remaining rule is deliberately the only ` +
        "automatic stop for this session.",
    );
  }
  return ok(id, "controls", title, `${describe}; manual stop: \`admin session pause\``);
}

/**
 * Every label set intake can present, not just the empty one. `resolveAssignment`
 * picks the flow from the issue's labels and fails closed on an unsupported
 * explicit agent, so a broken *non-default* flow rule breaks task creation for
 * exactly the issues that select it while the default flow still resolves
 * cleanly. Auditing only `[]` would certify that session as ready.
 *
 * A label set is a candidate per configured flow rule with labels; the empty set
 * covers the terminal `default: true` rule (and the built-in `code` flow when no
 * rules are configured). Rules whose labels are shadowed by an earlier rule
 * resolve to that earlier flow — which is also what intake would do, so the
 * candidate list is exactly the set of reachable resolutions.
 */
function assignmentCandidates(session: ResolvedSession): { labels: string[]; describe: string }[] {
  const candidates = [{ labels: [] as string[], describe: "Default-flow assignment" }];
  const seen = new Set<string>();
  for (const rule of session.flowRules ?? []) {
    // A rule with no labels is only reachable as the terminal fallback, which
    // the empty-label candidate already covers.
    if (!rule.labels || rule.labels.length === 0) continue;
    const key = rule.labels.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      labels: [...rule.labels],
      describe: `Assignment for labels [${rule.labels.join(", ")}]`,
    });
  }
  return candidates;
}

/**
 * Every phase's agent should be a decision the session made, not one a fallback
 * made for it. A profile/flow-rule set that cannot resolve is an error: intake
 * would abort at task-creation time. A missing research agent is only a
 * suggestion — the research phase is optional.
 */
function checkAssignment(session: ResolvedSession, now: string): Draft {
  const id = "assignment-defaults";
  const title = "Assignment defaults";
  const resolutions: { flow: string; resolved: ResolvedAssignment }[] = [];
  for (const candidate of assignmentCandidates(session)) {
    let resolved: ResolvedAssignment;
    try {
      resolved = resolveAssignment(session, candidate.labels, now);
    } catch (err) {
      return finding(
        id,
        "assignment",
        title,
        "error",
        `${candidate.describe} does not resolve: ${err instanceof Error ? err.message : String(err)}`,
        "Intake resolves the assignment before enqueuing, so every task creation for a matching issue " +
          "fails while this stands. Fix the session's defaults / assignmentProfiles / flowRules " +
          "(docs/assignment-profiles.md).",
      );
    }
    resolutions.push({ flow: resolved.flow, resolved });
  }
  const describeOne = (r: ResolvedAssignment) =>
    `flow=${r.flow}, implementation=${r.implementationAgent}, review=${r.reviewAgent}, ` +
    `conflict_resolution=${r.conflictResolutionAgent}, research=${r.researchAgent ?? "(none)"}`;
  // Deduplicate by flow: two rules can select the same flow, and repeating an
  // identical line would read as two separate findings.
  const byFlow = new Map<string, ResolvedAssignment>();
  for (const r of resolutions) if (!byFlow.has(r.flow)) byFlow.set(r.flow, r.resolved);
  const describe = [...byFlow.values()].map(describeOne).join("; ");
  const withoutResearch = [...byFlow.entries()].filter(([, r]) => !r.researchAgent).map(([flow]) => flow);
  if (withoutResearch.length > 0) {
    return finding(
      id,
      "assignment",
      title,
      "suggestion",
      `No research agent is assigned for ${withoutResearch.map((f) => `flow=${f}`).join(", ")} (${describe})`,
      "Research-labelled issues cannot be claimed. Set defaults.researchAgent (or a `research` entry in " +
        "the assignment profile) if this session should handle them.",
    );
  }
  return ok(id, "assignment", title, describe);
}

/**
 * Work-item comments are the loop's most detailed public-facing surface (Tier 1:
 * phase outcomes, decisions, truncated agent excerpts). On a public tracker that
 * detail is world-readable, which is a deliberate choice for some repositories
 * and an accident for others — so it is surfaced, not assumed.
 *
 * The tracker's *provider* says nothing about its visibility: a split-provider
 * session moves work items off the code host, but the Gitea (or future) repo it
 * moves them to can itself be public and receives the same `workitem:comment`
 * payloads. Only an actual visibility observation can clear this check; an
 * unprobed tracker is reported as unknown, never as a closed boundary.
 */
function checkPublicPrivateBoundary(session: ResolvedSession, facts: SessionAuditFacts): Draft {
  const id = "public-private-boundary";
  const title = "Public/private boundary";
  const tracker = describeWorkItemTracker(session);
  const exposure =
    "Work-item comments carry bounded internal detail (phase outcomes, decisions, truncated agent " +
    "excerpts)";
  const visibility = facts.workItemRepoVisibility;
  if (visibility.status === "skipped") {
    return skipped(id, "visibility", title, visibility.reason);
  }
  if (visibility.status === "unknown") {
    return finding(
      id,
      "visibility",
      title,
      "warning",
      `Visibility of ${tracker} is unknown: ${visibility.reason}`,
      `${exposure}, so the audit cannot certify this boundary without knowing whether the tracker is ` +
        `world-readable. Confirm it manually, then record the decision in audit.acknowledge["${id}"].`,
    );
  }
  if (visibility.status === "unavailable") {
    return finding(
      id,
      "visibility",
      title,
      "warning",
      `Could not determine whether ${tracker} is public: ${visibility.error}`,
      `${exposure}. Confirm manually whether AI work-item comments on this tracker are world-readable.`,
    );
  }
  if (visibility.visibility === "private") {
    return ok(id, "visibility", title, `${tracker} is private`);
  }
  return finding(
    id,
    "visibility",
    title,
    "warning",
    `${tracker} is public and also hosts this session's work items`,
    `${exposure}, so they are world-readable here. Either accept that explicitly via ` +
      `audit.acknowledge["${id}"], or move work items to a private tracker (docs/gitea-private-work-items.md).`,
  );
}

/**
 * An acknowledgement keyed to a check id that does not exist silently does
 * nothing — the operator believes a finding is accepted while it still counts
 * against the verdict. Typos are therefore reported rather than ignored.
 *
 * An entry keyed to this check's *own* id is reported the same way: it is the
 * one key that can never suppress anything (see {@link applyAcknowledgement}),
 * so leaving it unreported would hide the very typo it sits next to.
 */
function checkAcknowledgements(session: ResolvedSession, drafts: Draft[]): Draft {
  const id = ACKNOWLEDGEMENTS_CHECK_ID;
  const title = "Audit acknowledgements";
  const ack = session.audit?.acknowledge ?? {};
  const keys = Object.keys(ack);
  if (keys.length === 0) {
    return skipped(id, "audit", title, "no acknowledgements recorded");
  }
  const known = new Set(drafts.map((d) => d.id));
  const unknown = keys.filter((k) => k !== id && !known.has(k));
  const selfReferential = keys.includes(id);
  const inert = keys.filter((k) => {
    const draft = drafts.find((d) => d.id === k);
    return draft !== undefined && (draft.status === "ok" || draft.status === "skipped");
  });
  if (unknown.length > 0 || selfReferential) {
    const parts: string[] = [];
    if (unknown.length > 0) parts.push(`unknown check id(s): ${unknown.join(", ")}`);
    if (selfReferential) parts.push(`"${id}", which is not an acknowledgeable check`);
    const selfNote = selfReferential
      ? ` "${id}" validates the acknowledgement block itself, so accepting it would hide invalid keys ` +
        "rather than record a trade-off."
      : "";
    return finding(
      id,
      "audit",
      title,
      "suggestion",
      `Acknowledgement(s) that suppress nothing — ${parts.join("; ")}`,
      `Remove or re-key them.${selfNote} Valid ids: ${[...known].sort().join(", ")}.`,
    );
  }
  if (inert.length > 0) {
    return finding(
      id,
      "audit",
      title,
      "suggestion",
      `Acknowledgement(s) no longer needed: ${inert.join(", ")}`,
      "Those checks now pass (or are skipped). Remove the entries so the remaining acknowledgements " +
        "still describe real, accepted trade-offs.",
    );
  }
  return ok(id, "audit", title, `${keys.length} acknowledged: ${keys.join(", ")}`);
}
