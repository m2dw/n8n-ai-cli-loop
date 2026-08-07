/**
 * `admin context-mode status` — operator-facing readiness diagnostics for Codex
 * context-mode (issue #399).
 *
 * Issue #376 added the low-level Codex context-mode plumbing (session config,
 * `CODEX_CONTEXT_MODE`, resolved-profile metadata) but left readiness something an
 * operator had to infer from docs and failed runs. This command answers, in one
 * place, before a billable run is attempted:
 *
 *   - which agents the session assigns to implementation/review/research/
 *     conflict-resolution,
 *   - whether each assigned agent can actually use context-mode in this codebase
 *     (only Codex can; Claude/Gemini are `n/a`),
 *   - the configured `codex.contextMode` and the effective `CODEX_CONTEXT_MODE`
 *     override,
 *   - the exact Codex argv additions that would be spliced into `codex exec` /
 *     `codex review`,
 *   - whether the setup is enabled, disabled, invalid, or not applicable.
 *
 * The verdict is computed from the SAME resolver the implementation/review
 * handlers use ({@link resolveCodexContextMode}), so the diagnostic can never
 * disagree with what a real run would do. An invalid configuration is surfaced
 * here with the resolver's own actionable error message, so the operator fixes it
 * before a billed Codex run fails.
 *
 * Dry-run note: the command does NOT invoke Codex to "try" the configured
 * context-mode form. There is no reliable no-work Codex invocation that both
 * exercises the operator's `-c`/`--profile` form AND avoids a billable run, and
 * guessing such a form would violate the project's "never guess the context-mode
 * invocation form" contract (issue #376). The command therefore fails closed to
 * static validation. `--probe-cli` adds a safe, non-billable `codex --version`
 * check that only confirms the Codex binary is installed — it deliberately does
 * not assert that Codex accepts the configured profile/override.
 */

import type { ResolvedSession } from "../core/session.js";
import type { AgentId } from "../core/task.js";
import { resolveAssignment, type ResolvedAssignment } from "../core/assignment.js";
import {
  resolveCodexContextMode,
  providerForAgent,
  type CodexContextModeResolution,
} from "../handlers/codex-context-mode.js";
import {
  DEFAULT_SESSIONS_PATH,
  JsonSessionRegistry,
  describeUnresolvedSessionId,
} from "../registries/json-session-registry.js";
import { tokenizeArgs, resolveSessionSelector } from "./admin-command.js";
import { report, die } from "./cli-io.js";
import type { OutputMode } from "./cli-io.js";
import { execFileSync } from "child_process";

/** Phase slots reported, in the order shown to the operator. */
export type ContextModePhase =
  | "implementation"
  | "review"
  | "research"
  | "conflict_resolution";

const PHASE_ORDER: readonly ContextModePhase[] = [
  "implementation",
  "review",
  "research",
  "conflict_resolution",
];

/**
 * Phases whose handler actually invokes Codex today, and therefore can splice in
 * the context-mode argv. Only implementation and review run Codex
 * ({@link import("../handlers/implementation.js")}, {@link import("../handlers/review.js")});
 * the research handler is Gemini-only and the conflict-resolution handler is
 * Claude-only, so assigning Codex there fails the real run with
 * `Unsupported … agent: codex` long before any context-mode argv would be used.
 * Marking those phases context-mode-applicable would make the diagnostic claim a
 * readiness the run can never honor, so they are excluded here.
 */
const CODEX_CAPABLE_PHASES: ReadonlySet<ContextModePhase> = new Set([
  "implementation",
  "review",
]);

/** Top-level readiness verdict for the session. */
export type ContextModeReadiness = "enabled" | "disabled" | "invalid" | "not_applicable";

/** Per-phase view of the assigned agent and whether it can use context-mode. */
export interface PhaseContextMode {
  phase: ContextModePhase;
  /** Assigned agent, or null when no agent is assigned (research is optional). */
  agent: AgentId | null;
  /** Backing provider (anthropic/openai/google), or null when unassigned. */
  provider: string | null;
  /**
   * True only when Codex is assigned to a phase whose handler actually runs Codex
   * (implementation/review). Claude/Gemini phases — and Codex assigned to the
   * Gemini-only research or Claude-only conflict-resolution phase — cannot use
   * context-mode in this codebase.
   */
  supportsContextMode: boolean;
  /**
   * `applicable` for Codex phases that run Codex, `unsupported` when Codex is
   * assigned to a phase whose handler does not run Codex (research/conflict
   * resolution — the real run fails before context-mode applies), and `n/a` for
   * Claude/Gemini phases (or unassigned).
   */
  contextMode: "applicable" | "unsupported" | "n/a";
}

/** Codex subcommand a Codex-capable phase invokes. */
type CodexCapablePhase = "implementation" | "review";
const PHASE_SUBCOMMAND: Record<CodexCapablePhase, "exec" | "review"> = {
  implementation: "exec",
  review: "review",
};

/**
 * Exact Codex context-mode argv additions for one Codex-capable phase, split by
 * where each piece lands relative to the subcommand. This mirrors how the real
 * handlers splice the additions: `--profile <name>` is a GLOBAL option that the
 * review handler places BEFORE the `review` subcommand (`codex --profile <name>
 * review …`), while the implementation handler appends it (with the `-c`
 * overrides) after `codex exec`. Splitting per phase keeps the diagnostic in
 * exact agreement with the invocation a real run builds (issue #399).
 */
export interface PhaseCodexArgv {
  phase: CodexCapablePhase;
  /** The Codex subcommand this phase invokes (`exec` or `review`). */
  subcommand: "exec" | "review";
  /** context-mode tokens placed BEFORE the subcommand (global options, e.g. `--profile`). */
  globalArgs: string[];
  /** context-mode tokens appended AFTER the subcommand (`-c key=value` overrides, and — for `exec` — `--profile`). */
  appendedArgs: string[];
}

export interface ContextModeStatusPayload {
  ok: true;
  sessionId: string;
  generatedAt: string;
  /** enabled | disabled | invalid | not_applicable. */
  status: ContextModeReadiness;
  /** Per-phase assigned agent and context-mode applicability. */
  phases: PhaseContextMode[];
  /**
   * Phases whose assigned agent is Codex AND whose handler actually runs Codex
   * (implementation/review). Codex assigned to research/conflict_resolution is
   * excluded here — those handlers never run Codex, so context-mode cannot apply.
   */
  codexPhases: ContextModePhase[];
  /** Echo of `session.codex.contextMode`, or null when unconfigured. */
  configured: {
    enabled: boolean;
    config: string[];
    profile?: string;
  } | null;
  /** Raw `CODEX_CONTEXT_MODE` value, or null when unset. */
  envOverride: string | null;
  /** Outcome of the shared resolver used by the real implementation/review runs. */
  resolution:
    | { status: "enabled"; source: "session" | "env"; config: string[]; profile?: string }
    | { status: "unset"; source: "default" | "env" }
    | { status: "error"; error: string };
  /**
   * Exact Codex context-mode argv additions, per Codex-capable phase, in the real
   * placement each handler uses. Reported per phase (not as one flat list) because
   * `--profile <name>` is a GLOBAL option the review handler places BEFORE the
   * `review` subcommand (`codex --profile <name> review …`), while the
   * implementation handler appends it after `codex exec`. One flat list would
   * misstate `codex review`'s real argv for profile-based configs (issue #399).
   */
  phaseArgv: PhaseCodexArgv[];
  /** Actionable, human-readable guidance for the current verdict. */
  guidance: string;
  /** Present only when `--probe-cli` ran: a safe, non-billable `codex --version` check. */
  cliProbe?: { ok: boolean; detail: string };
}

/**
 * Build the readiness payload purely from a resolved session and the environment.
 * No I/O, so it is directly unit-testable. The per-phase agents come from the
 * session's default-flow assignment (no issue labels), matching the agents a
 * label-free task would run with.
 */
export function buildContextModeStatus(
  session: ResolvedSession,
  env: NodeJS.ProcessEnv = process.env,
  now: string = new Date().toISOString(),
): ContextModeStatusPayload {
  const assignment = resolveDiagnosticAssignment(session, now);
  const agentByPhase: Record<ContextModePhase, AgentId | null> = {
    implementation: assignment.implementationAgent,
    review: assignment.reviewAgent,
    research: assignment.researchAgent ?? null,
    conflict_resolution: assignment.conflictResolutionAgent,
  };

  const phases: PhaseContextMode[] = PHASE_ORDER.map((phase) => {
    const agent = agentByPhase[phase];
    const assignedCodex = agent === "codex";
    const supportsContextMode = assignedCodex && CODEX_CAPABLE_PHASES.has(phase);
    const contextMode: PhaseContextMode["contextMode"] = supportsContextMode
      ? "applicable"
      : assignedCodex
        ? "unsupported"
        : "n/a";
    return {
      phase,
      agent,
      provider: agent ? providerForAgent(agent) : null,
      supportsContextMode,
      contextMode,
    };
  });

  const codexPhases = phases.filter((p) => p.supportsContextMode).map((p) => p.phase);

  const cfg = session.codex?.contextMode;
  const configured = cfg
    ? {
        enabled: cfg.enabled === true,
        config: Array.isArray(cfg.config) ? cfg.config.filter((c) => typeof c === "string") : [],
        ...(typeof cfg.profile === "string" && cfg.profile.trim().length > 0
          ? { profile: cfg.profile }
          : {}),
      }
    : null;

  const rawEnv = env["CODEX_CONTEXT_MODE"];
  const envOverride = typeof rawEnv === "string" && rawEnv.length > 0 ? rawEnv : null;

  const res = resolveCodexContextMode(session.codex, env);
  const resolution = toResolutionView(res);
  const phaseArgv = codexPhases
    .filter((p): p is CodexCapablePhase => p === "implementation" || p === "review")
    .map((p) => buildPhaseArgv(p, res));

  const unsupportedCodexPhases = phases
    .filter((p) => p.contextMode === "unsupported")
    .map((p) => p.phase);

  const status = classify(res.status, codexPhases.length > 0);
  const guidance = buildGuidance(status, res, codexPhases, unsupportedCodexPhases, configured);

  return {
    ok: true,
    sessionId: session.sessionId,
    generatedAt: now,
    status,
    phases,
    codexPhases,
    configured,
    envOverride,
    resolution,
    phaseArgv,
    guidance,
  };
}

/**
 * Resolve the default-flow assignment for the diagnostic, recovering from the one
 * case {@link resolveAssignment} fail-closes on: an assignment profile that
 * explicitly sets `conflict_resolution` to an unsupported agent (e.g. codex).
 *
 * The real run intentionally aborts there, but this readiness command exists to
 * SURFACE that misconfiguration before a billable run — so instead of letting the
 * throw collapse the whole payload into `{ok:false}`, we re-resolve with
 * `conflict_resolution` stripped (which never affects the implementation/review/
 * research slots) and restore the configured (unsupported) agent for display, so
 * the phase table reports `conflict_resolution` as `unsupported` (issue #399). If
 * the re-resolution still throws, the failure is unrelated to conflict_resolution
 * and is left to propagate to the caller's error handling.
 */
function resolveDiagnosticAssignment(session: ResolvedSession, now: string): ResolvedAssignment {
  try {
    return resolveAssignment(session, [], now);
  } catch {
    const assignment = resolveAssignment(stripConflictResolution(session), [], now);
    const configuredConflict = session.assignmentProfiles?.[assignment.flow]?.conflict_resolution;
    return configuredConflict
      ? { ...assignment, conflictResolutionAgent: configuredConflict }
      : assignment;
  }
}

/**
 * Shallow-clone the session with `conflict_resolution` removed from every
 * assignment profile, so {@link resolveAssignment} resolves the other phases
 * without tripping its unsupported-conflict-agent guard. The original session is
 * left unmutated.
 */
function stripConflictResolution(session: ResolvedSession): ResolvedSession {
  if (!session.assignmentProfiles) return session;
  const profiles: NonNullable<ResolvedSession["assignmentProfiles"]> = {};
  for (const [flow, profile] of Object.entries(session.assignmentProfiles)) {
    const copy = { ...profile };
    delete copy.conflict_resolution;
    profiles[flow] = copy;
  }
  return { ...session, assignmentProfiles: profiles };
}

/**
 * Build the exact context-mode argv additions for one Codex-capable phase, in the
 * placement the real handler uses. See {@link PhaseCodexArgv}.
 */
function buildPhaseArgv(
  phase: CodexCapablePhase,
  res: CodexContextModeResolution,
): PhaseCodexArgv {
  const subcommand = PHASE_SUBCOMMAND[phase];
  if (res.status !== "enabled") {
    return { phase, subcommand, globalArgs: [], appendedArgs: [] };
  }
  const profileArgs = res.profile ? ["--profile", res.profile] : [];
  const configArgs: string[] = [];
  for (const entry of res.config) configArgs.push("-c", entry);
  if (phase === "review") {
    // `--profile` is a GLOBAL Codex option and must precede the `review`
    // subcommand (`codex --profile <name> review …`); `-c` overrides follow it.
    return { phase, subcommand, globalArgs: profileArgs, appendedArgs: configArgs };
  }
  // implementation: the handler appends `--profile`+`-c` after `codex exec`.
  return { phase, subcommand, globalArgs: [], appendedArgs: [...profileArgs, ...configArgs] };
}

function toResolutionView(res: CodexContextModeResolution): ContextModeStatusPayload["resolution"] {
  if (res.status === "enabled") {
    return {
      status: "enabled",
      source: res.source,
      config: res.config,
      ...(res.profile ? { profile: res.profile } : {}),
    };
  }
  if (res.status === "unset") {
    return { status: "unset", source: res.source };
  }
  return { status: "error", error: res.error };
}

/**
 * Map the resolver outcome plus whether any assigned agent is Codex to the
 * operator-facing verdict. An invalid configuration is surfaced even when no
 * Codex phase currently uses it, so the misconfiguration is fixed before it can
 * block a future billable run.
 */
function classify(
  resStatus: CodexContextModeResolution["status"],
  anyCodexPhase: boolean,
): ContextModeReadiness {
  if (resStatus === "error") return "invalid";
  if (!anyCodexPhase) return "not_applicable";
  return resStatus === "enabled" ? "enabled" : "disabled";
}

function buildGuidance(
  status: ContextModeReadiness,
  res: CodexContextModeResolution,
  codexPhases: ContextModePhase[],
  unsupportedCodexPhases: ContextModePhase[],
  configured: ContextModeStatusPayload["configured"],
): string {
  const base = buildBaseGuidance(status, res, codexPhases, unsupportedCodexPhases, configured);
  // The not_applicable branch already folds the unsupported-phase warning into its
  // message. For enabled/disabled/invalid verdicts a Codex phase that can never run
  // Codex (e.g. an explicit `conflict_resolution: codex`) would otherwise go
  // unmentioned, so append the warning here too (issue #399).
  if (status !== "not_applicable" && unsupportedCodexPhases.length > 0) {
    return `${base} Also: ${unsupportedPhaseWarning(unsupportedCodexPhases)}`;
  }
  return base;
}

/** Shared warning text for Codex assigned to a phase whose handler never runs Codex. */
function unsupportedPhaseWarning(unsupportedCodexPhases: ContextModePhase[]): string {
  return (
    `Codex is assigned to ${unsupportedCodexPhases.join(", ")}, but that phase's handler ` +
    "does not run Codex (research is Gemini-only, conflict_resolution is Claude-only), so " +
    "the run will fail with `Unsupported … agent: codex` and context-mode never applies. " +
    "Assign a supported agent to that phase."
  );
}

function buildBaseGuidance(
  status: ContextModeReadiness,
  res: CodexContextModeResolution,
  codexPhases: ContextModePhase[],
  unsupportedCodexPhases: ContextModePhase[],
  configured: ContextModeStatusPayload["configured"],
): string {
  switch (status) {
    case "invalid":
      // The resolver's message already names the offending value and the fix.
      return res.status === "error" ? res.error : "Invalid context-mode configuration.";
    case "not_applicable": {
      // Codex assigned to a phase whose handler never runs Codex (Gemini-only
      // research, Claude-only conflict resolution) is a misconfiguration: the
      // real run fails with `Unsupported … agent: codex` before context-mode
      // could ever apply. Flag it instead of implying context-mode is ready.
      if (unsupportedCodexPhases.length > 0) {
        return (
          `Codex is assigned to ${unsupportedCodexPhases.join(", ")}, but that phase's ` +
          "handler does not run Codex (research is Gemini-only, conflict_resolution is " +
          "Claude-only), so the run will fail with `Unsupported … agent: codex` and " +
          "context-mode never applies. Assign Codex to implementation or review to use " +
          "context-mode, or assign a supported agent to that phase."
        );
      }
      if (configured?.enabled) {
        return (
          "context-mode is configured and enabled, but no assigned agent " +
          "(implementation/review) is Codex, so it will not be used. Assign Codex to " +
          "implementation or review (session defaults or an assignment profile) to make " +
          "context-mode take effect, or remove the config."
        );
      }
      return (
        "No assigned agent runs Codex, so context-mode does not apply to this session. " +
        "Claude/Gemini phases never use context-mode."
      );
    }
    case "disabled": {
      // CODEX_CONTEXT_MODE only toggles on/off; it still needs a configured
      // invocation form. Suggest it as a shortcut only when one already exists,
      // otherwise pointing operators at it just turns DISABLED into INVALID.
      const hasInvocationForm =
        !!configured && (configured.config.length > 0 || typeof configured.profile === "string");
      const enableHint = hasInvocationForm
        ? "Set session.codex.contextMode.enabled=true, or pass CODEX_CONTEXT_MODE=on, to enable it."
        : "Set session.codex.contextMode.enabled=true with a verified config/profile " +
          "(see docs/codex-context-mode.md) to enable it. CODEX_CONTEXT_MODE=on alone is not " +
          "enough — it only toggles the mode and still requires a configured config/profile.";
      return (
        `Codex is assigned to ${codexPhases.join(", ")} but context-mode is off. ` + enableHint
      );
    }
    case "enabled":
      return (
        `context-mode is enabled for ${codexPhases.join(", ")} and will be passed to ` +
        "codex exec/codex review verbatim."
      );
  }
}

// ---------------------------------------------------------------------------
// Arg parsing + command runner
// ---------------------------------------------------------------------------

export interface ContextModeStatusArgs {
  sessionId: string;
  sessionsPath: string;
  probeCli: boolean;
}

export function parseContextModeStatusArgs(
  argv: string[],
): ContextModeStatusArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["session-id", "session-ref", "sessions-path"],
    booleanFlags: ["probe-cli"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args, flags } = tokenized;
  const selector = resolveSessionSelector(args);
  if ("error" in selector) return { error: selector.error };
  return {
    sessionId: selector.sessionId,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    probeCli: flags.has("probe-cli"),
  };
}

/**
 * Safe, non-billable confirmation that the Codex CLI is installed. This proves
 * the binary exists; it deliberately does NOT assert Codex accepts the configured
 * context-mode form (no reliable no-work validation of that exists — see the
 * module header), so the operator must still verify the form against their build.
 */
function probeCodexCli(): { ok: boolean; detail: string } {
  try {
    const out = execFileSync("codex", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }) as string;
    return { ok: true, detail: out.trim() || "codex --version succeeded" };
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string };
    return { ok: false, detail: (e.stderr ?? e.stdout ?? String(err)).slice(0, 200).trim() };
  }
}

export async function runContextModeStatus(argv: string[]): Promise<void> {
  const parsed = parseContextModeStatusArgs(argv);
  if ("error" in parsed) die(parsed.error);

  const { sessionId, sessionsPath, probeCli } = parsed;

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

  let payload: ContextModeStatusPayload;
  try {
    payload = buildContextModeStatus(session);
  } catch (err) {
    // An explicit unsupported `conflict_resolution` agent is recovered inside
    // buildContextModeStatus and reported in the phase table; this guards only the
    // residual cases (e.g. malformed assignment config) so they surface as an
    // actionable message rather than an unhandled crash.
    die(err instanceof Error ? err.message : String(err));
  }

  if (probeCli) {
    payload = { ...payload, cliProbe: probeCodexCli() };
  }

  report(payload as unknown as Record<string, unknown>, (mode) =>
    renderContextModeStatus(payload, mode),
  );
}

// ---------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<ContextModeReadiness, string> = {
  enabled: "ENABLED",
  disabled: "DISABLED",
  invalid: "INVALID",
  not_applicable: "N/A",
};

export function renderContextModeStatus(
  payload: ContextModeStatusPayload,
  _mode: OutputMode,
): string {
  const lines: string[] = [];
  lines.push(`Codex context-mode readiness for session "${payload.sessionId}"`);
  lines.push(`  status: ${STATUS_LABEL[payload.status]}`);
  lines.push("");
  lines.push("  Assigned agents (default flow):");
  for (const p of payload.phases) {
    const agent = p.agent ?? "(none)";
    const applies =
      p.contextMode === "applicable"
        ? "context-mode applicable"
        : p.contextMode === "unsupported"
          ? "context-mode unsupported (phase does not run Codex)"
          : "context-mode n/a";
    lines.push(`    ${p.phase.padEnd(20)} ${agent.padEnd(8)} ${applies}`);
  }
  lines.push("");

  const cfg = payload.configured;
  if (cfg) {
    lines.push(`  codex.contextMode.enabled: ${cfg.enabled}`);
    if (cfg.profile) lines.push(`  codex.contextMode.profile: ${cfg.profile}`);
    if (cfg.config.length > 0) {
      lines.push(`  codex.contextMode.config: ${cfg.config.join(", ")}`);
    }
  } else {
    lines.push("  codex.contextMode: (not configured)");
  }
  lines.push(`  CODEX_CONTEXT_MODE: ${payload.envOverride ?? "(unset)"}`);
  lines.push("");

  if (payload.resolution.status === "enabled") {
    lines.push(`  Resolved: enabled (source: ${payload.resolution.source})`);
    lines.push("  Codex argv additions (per phase):");
    for (const pa of payload.phaseArgv) {
      lines.push(`    ${pa.phase.padEnd(20)} ${renderPhaseCommand(pa)}`);
    }
  } else if (payload.resolution.status === "unset") {
    lines.push(`  Resolved: unset (source: ${payload.resolution.source})`);
  } else {
    lines.push("  Resolved: error");
  }

  if (payload.cliProbe) {
    const probe = payload.cliProbe;
    lines.push(
      `  Codex CLI: ${probe.ok ? "found" : "NOT found"} (${probe.detail || "no output"})`,
    );
  }

  lines.push("");
  lines.push(`  ${payload.guidance}`);
  return lines.join("\n");
}

/**
 * Render one phase's context-mode additions as the command form a real run builds,
 * with `…` standing in for the phase's other (non-context-mode) args. Global
 * options precede the subcommand; appended options follow it — so a profile-based
 * review reads `codex --profile <name> review … -c …`, matching the handler.
 */
function renderPhaseCommand(pa: PhaseCodexArgv): string {
  const parts = ["codex", ...pa.globalArgs, pa.subcommand, "…", ...pa.appendedArgs];
  return parts.join(" ");
}
