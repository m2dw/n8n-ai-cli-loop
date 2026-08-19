/**
 * Chain-aware progressive Issue refinement — the bounded two-agent loop runner
 * (issue #869, docs/issue-refinement-contract.md §7, §8, §12 rows 8–21, §13,
 * §15, §17).
 *
 * This module walks one refinement attempt from role resolution through the
 * refiner/critic exchange to either an ACCEPTED contract or a human handoff,
 * and it is deliberately store-free: it takes the §15 context block, returns
 * the updated block plus the audit events and the task-status instruction, and
 * lets the caller commit them. What it never holds is a write surface — no
 * GitHub client, no outbox, no repository worktree. The only I/O it performs
 * is spawning the two isolated agents and writing local artifacts.
 *
 * Scope boundary (#869): the walk STOPS at `accepted` (§12 rows 14/15). The
 * `apply.requested` commit point (row 22), the Issue-body write, the audit
 * comment, and the label transition belong to the application slice — "persist
 * an accepted refinement artifact; do not update GitHub yet". That slice now
 * exists (issue #870, `src/handlers/issue-refinement-apply.ts`):
 * {@link createRefinementHandler} dispatches an `accepted`/`applying` block to
 * it, so acceptance flows into application on the next tick instead of
 * parking for an operator.
 *
 * One documented ordering deviation: §12 resolves predecessors (rows 3–7,
 * state `eligible`) before roles (rows 8/9). #868's snapshot builder performs
 * predecessor resolution and capture in one atomic pass, so this runner
 * resolves ROLES first — which preserves the property §7.3 actually names
 * (a run that cannot name two independent agents escalates without spending a
 * snapshot, a draft, or a round) at the cost of firing row 9 before rows 5–7
 * when both would match.
 */

import { randomBytes } from "crypto";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";

import type { AgentId } from "../core/task.js";
import type {
  PhaseHandler,
  PhaseHandlerContext,
  PhaseHandlerResult,
} from "../core/phase-runner.js";
import type {
  RefinementHandoffReason,
  RefinementLabels,
} from "../core/issue-refinement.js";
import {
  IMPLEMENTATION_STATUS_LABEL,
  readRefinementContextBlock,
  resolveIssueRefinementSettings,
} from "../core/issue-refinement.js";
import type {
  RefinementIssueRead,
  RefinementSnapshot,
  RefinementSnapshotFailureStage,
  RefinementSnapshotSource,
} from "../core/issue-refinement-snapshot.js";
import {
  buildRefinementSnapshot,
  refinementPredecessorRecords,
} from "../core/issue-refinement-snapshot.js";
import type {
  RefinedContract,
  RefinementCritique,
  RefinementLoopContextBlock,
  RefinementObjection,
  RefinementPendingRetryRecord,
  RefinementRoleRunRecord,
} from "../core/issue-refinement-loop.js";
import {
  buildCriticPrompt,
  buildRefinerPrompt,
  combineTopologyDispositions,
  evaluateRefinementRoleIndependence,
  parseCriticResponse,
  parseRefinerResponse,
  renderManagedRegion,
} from "../core/issue-refinement-loop.js";
import { ARBITER_CLAUDE_NO_TOOLS_ARGS } from "../core/review-arbiter-profile.js";
import type {
  RefinementApplyContextBlock,
  RefinementApplyPort,
} from "../core/issue-refinement-apply.js";
import { MAX_APPLY_TRANSIENT_FAILURES } from "../core/issue-refinement-apply.js";
import { executeRefinementApply } from "./issue-refinement-apply.js";
import {
  agentSetupDetail,
  boundRawOutput as boundStream,
  buildIsolatedInvocation,
  writeArtifactFile,
} from "./agent-isolation.js";
import type { CommandRunner, CommandRunResult } from "./command-runner.js";
import { bothStreamsCommandRunner } from "./command-runner.js";
import { providerForAgent, resolveCodexModel } from "./codex-context-mode.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Default agent deadline per invocation — a bounded judgement, not a review. */
export const DEFAULT_REFINEMENT_LOOP_TIMEOUT_MS = 10 * 60 * 1000;

/** Output buffer ceiling for the agent subprocess. */
const REFINEMENT_MAX_BUFFER = 16 * 1024 * 1024;

/** The bound on the raw transcripts this module writes (§15 stays local, not unbounded). */
export const MAX_REFINEMENT_RAW_BYTES = 1024 * 1024;

function boundRawOutput(text: string): string {
  return boundStream(text, MAX_REFINEMENT_RAW_BYTES);
}

// ---------------------------------------------------------------------------
// Role profiles — the §7.3 no-tools invocation
// ---------------------------------------------------------------------------

export const REFINEMENT_LOOP_ROLES = ["refiner", "critic"] as const;
export type RefinementLoopRole = (typeof REFINEMENT_LOOP_ROLES)[number];

export interface ResolvedRefinementRoleProfile {
  phase: "refinement";
  role: RefinementLoopRole;
  agentId: AgentId;
  cmd: string;
  /** Sanitized argv — the prompt travels on stdin and never appears here. */
  argv: string[];
  model?: string;
  modelSource: "env" | "default";
  effort?: string;
  effortSource: "env" | "default";
  provider: string;
  /** States the enforced posture in the run metadata, not just in code. */
  toolPolicy: "no-tools";
}

export type RefinementRoleProfileResolution =
  | { profile: ResolvedRefinementRoleProfile }
  | { error: string };

export type RefinementRoleProfileResolver = (
  role: RefinementLoopRole,
  agentId: AgentId,
  env: NodeJS.ProcessEnv,
) => RefinementRoleProfileResolution;

/**
 * Resolve the read-only invocation for one refinement role.
 *
 * Only agents with an established CLI-level read-only boundary in this
 * repository are supported, and that is a fail-closed decision rather than an
 * oversight (§7.3's enforcement point is the runner — the same line #838 draws
 * for reconsideration and #839 for the arbiter). Two agents have one: `claude`
 * (the arbiter's no-tools argv) and `codex` (its own read-only sandbox), which
 * is what makes a genuinely cross-provider refiner/critic pair — the pairing
 * §7.3 prefers and the mandatory same-agent check requires — resolvable in
 * production, not only under an injected test resolver. Gemini/Antigravity has
 * no verified read-only invocation here yet and fails closed.
 */
export function resolveRefinementRoleProfile(
  role: RefinementLoopRole,
  agentId: AgentId,
  env: NodeJS.ProcessEnv = process.env,
): RefinementRoleProfileResolution {
  if (agentId === "claude") {
    const envModel = env["CLAUDE_MODEL"];
    const envEffort = env["CLAUDE_EFFORT"];
    // Refinement is a judgement over frozen evidence with no way to gather more,
    // so both roles default to the strong tier, as reconsideration does.
    const model = envModel ?? "opus";
    const effort = envEffort ?? "high";
    return {
      profile: {
        phase: "refinement",
        role,
        agentId,
        cmd: "claude",
        argv: ["-p", ...ARBITER_CLAUDE_NO_TOOLS_ARGS, "--model", model, "--effort", effort],
        model,
        modelSource: envModel ? "env" : "default",
        effort,
        effortSource: envEffort ? "env" : "default",
        provider: providerForAgent(agentId),
        toolPolicy: "no-tools",
      },
    };
  }
  if (agentId === "codex") {
    // The Codex CLI cannot drop its command tool outright the way the Claude
    // CLI can, so its half of the §7.3 boundary is the CLI's own read-only
    // sandbox: no file writes and no network, on top of the throwaway cwd and
    // credential-stripped environment every role already runs in.
    // `--skip-git-repo-check` is required because that cwd is deliberately not
    // a git checkout — `codex exec` refuses to start outside one without it.
    // Both are documented `codex exec` flags, pinned here the way the
    // implementation and review lanes pin their Codex invocations; the prompt
    // travels on stdin with no prompt argument, exactly as the implementation
    // lane passes it.
    const modelResolution = resolveCodexModel(undefined, env);
    const envEffort = env["CODEX_EFFORT"];
    const effort = envEffort ?? "high";
    // Codex accepts exactly three reasoning-effort levels; Claude-only tiers
    // (`xhigh`, `max`) map to `high`, as the implementation lane maps them.
    const codexEffortLevel =
      effort === "low" ? "low" : effort === "medium" ? "medium" : "high";
    const argv: string[] = [];
    if (modelResolution.source !== "unset") {
      // `--model` is a GLOBAL Codex option and must precede the subcommand.
      argv.push("--model", modelResolution.model);
    }
    argv.push(
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-c",
      `model_reasoning_effort=${codexEffortLevel}`,
    );
    return {
      profile: {
        phase: "refinement",
        role,
        agentId,
        cmd: "codex",
        argv,
        // An unset model stays absent — the Codex CLI's own default applies,
        // and §7.3's same-provider comparison treats an absent model as unknown.
        ...(modelResolution.source === "unset" ? {} : { model: modelResolution.model }),
        modelSource: modelResolution.source === "env" ? "env" : "default",
        effort,
        effortSource: envEffort ? "env" : "default",
        provider: providerForAgent(agentId),
        toolPolicy: "no-tools",
      },
    };
  }
  return {
    error:
      `Unsupported refinement ${role} agent: ${agentId}. Refinement roles run with no tool surface ` +
      "(docs/issue-refinement-contract.md §7.3), and only agents with a verified read-only " +
      "invocation are runnable. Supported: claude, codex",
  };
}

// ---------------------------------------------------------------------------
// The agent seam
// ---------------------------------------------------------------------------

export interface RefinementAgentInvocation {
  prompt: string;
  timeoutMs: number;
}

/** Injectable so tests exercise the whole loop without spawning an agent. */
export type RefinementAgentRunner = (invocation: RefinementAgentInvocation) => CommandRunResult;

/**
 * The default runner: the resolved profile's command, the prompt on stdin, a
 * throwaway cwd, and a credential-stripped environment (§7.3 — "exactly as
 * specified for `issue-discuss` and the AI planner"). Temp directories are
 * removed on every exit path, including a throwing one.
 */
export function createRefinementAgentRunner(
  profile: ResolvedRefinementRoleProfile,
  runner: CommandRunner = bothStreamsCommandRunner,
  env: NodeJS.ProcessEnv = process.env,
): RefinementAgentRunner {
  return (invocation) => {
    const isolated = buildIsolatedInvocation(env, {
      prefix: profile.role === "refiner" ? "ai-refiner" : "ai-critic",
      provider: profile.provider,
      // The profile's own record of the boundary its argv enforces; the home
      // policy of `agent-isolation.ts` is conditioned on it.
      toolPolicy: profile.toolPolicy,
    });
    try {
      return runner.run(profile.cmd, profile.argv, {
        cwd: isolated.cwd,
        env: isolated.env,
        stdin: invocation.prompt,
        timeout: invocation.timeoutMs,
        maxBuffer: REFINEMENT_MAX_BUFFER,
      });
    } finally {
      for (const dir of isolated.cleanup) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // A leftover temp dir is not worth failing a completed invocation for.
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// §17 process-failure classification (disposition seam)
// ---------------------------------------------------------------------------

export interface RefinementFailureClass {
  retryable: boolean;
  /** Content-free kind literal for events (`timeout`, `spawn`, `exit-nonzero`…). */
  kind: string;
}

export type RefinementFailureClassifier = (result: CommandRunResult) => RefinementFailureClass;

/**
 * §17 keeps CLASSIFICATION with the existing phase machinery; this default is
 * the conservative in-process stand-in and the injection seam is where the
 * runner's own classifier plugs in. Everything transient — timeout, quota
 * (a non-zero exit), a spawn hiccup — is retryable up to the per-role cap; a
 * missing binary is not, because retrying cannot install it.
 */
export function defaultRefinementFailureClassifier(
  result: CommandRunResult,
): RefinementFailureClass {
  if (result.spawnError) {
    if (/ENOENT/.test(result.spawnError)) return { retryable: false, kind: "spawn-missing-binary" };
    if (/ETIMEDOUT|timed?\s*out/i.test(result.spawnError)) return { retryable: true, kind: "timeout" };
    return { retryable: true, kind: "spawn" };
  }
  return { retryable: true, kind: "exit-nonzero" };
}

// ---------------------------------------------------------------------------
// Loop input/output
// ---------------------------------------------------------------------------

export interface RefinementLoopEvent {
  /** §15 `refinement.<subject>.<action>` literal. */
  type: string;
  /** Literals and counters only — never prose, snapshot content, or paths. */
  data: Record<string, unknown>;
}

export type RefinementLoopOutcome =
  | { kind: "accepted" }
  | { kind: "escalated"; reason: RefinementHandoffReason }
  | { kind: "hold"; reason: "predecessor_not_ready" }
  /** A provider/network error while snapshotting: nothing moved, retry later. */
  | { kind: "snapshot_failed"; stage: RefinementSnapshotFailureStage | "issue"; error: string }
  /**
   * §12 rows 38/40: a retryable agent process failure below the per-role cap.
   * The resumable position is persisted on the block (`pendingRetry`) and the
   * SAME role re-runs on a later run, after the phase-level delay the existing
   * classification prescribes (§17) — never synchronously in this one.
   */
  | { kind: "agent_retry"; role: RefinementLoopRole; failureKind: string; round: number }
  /** The block is not in a runnable state; nothing was touched. */
  | { kind: "refused"; detail: string };

export interface RefinementLoopRunResult {
  outcome: RefinementLoopOutcome;
  /** The updated §15 block; the caller persists it under `context.refinement`. */
  block: RefinementLoopContextBlock;
  events: RefinementLoopEvent[];
  /** §13: `ready_for_human` on every escalation; `null` otherwise. */
  taskStatus: "ready_for_human" | null;
  /** Artifact file names written under `artifactDir`, in write order. */
  artifacts: string[];
}

export interface RefinementLoopDeps {
  /** Read-only snapshot port (#868). The loop's ONLY view of GitHub. */
  source: RefinementSnapshotSource;
  /** Replace the whole isolated invocation for a role (tests). */
  refinerAgent?: RefinementAgentRunner;
  criticAgent?: RefinementAgentRunner;
  /** Replace only the subprocess under the default isolated invocation. */
  agentRunner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  /** Injectable monotonic-enough clock for durations and timestamps. */
  now?: () => number;
  classifyFailure?: RefinementFailureClassifier;
  /** Capability seam; defaults to the claude-only resolver above. */
  resolveRoleProfile?: RefinementRoleProfileResolver;
}

export interface RefinementLoopInput {
  issueNumber: number;
  block: RefinementLoopContextBlock;
  /** `session.labels.stackReady` (§4). */
  stackReadyLabel: string;
  /** `<artifactRoot>/issue-refinement/issue-<n>/<runId>` (§15); created if absent. */
  artifactDir: string;
  runId: string;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

interface LoopState {
  block: RefinementLoopContextBlock;
  events: RefinementLoopEvent[];
  artifacts: string[];
  issueNumber: number;
  runId: string;
  artifactDir: string;
  startedAt: string;
  nowMs: () => number;
  outcome?: RefinementLoopOutcome;
  taskStatus: "ready_for_human" | null;
}

function iso(state: LoopState): string {
  return new Date(state.nowMs()).toISOString();
}

/** §15 common event fields: literals, counters, and identifiers only. */
function baseEventData(state: LoopState): Record<string, unknown> {
  const c = state.block.counters;
  return {
    issueNumber: state.issueNumber,
    runId: state.runId,
    state: state.block.state,
    predecessors: state.block.predecessors.map((p) => p.issueNumber),
    predecessorFingerprint: state.block.predecessorFingerprint,
    counters: {
      rounds: c.rounds,
      malformedRefiner: c.malformedAttempts.refiner,
      malformedCritic: c.malformedAttempts.critic,
      agentFailuresRefiner: c.agentFailures.refiner,
      agentFailuresCritic: c.agentFailures.critic,
      staleRestarts: c.staleRestarts,
    },
    at: iso(state),
  };
}

function emitEvent(state: LoopState, type: string, data: Record<string, unknown>): void {
  state.events.push({ type, data: { ...baseEventData(state), ...data } });
}

function touch(state: LoopState): void {
  state.block.updatedAt = iso(state);
}

/** §13's load-bearing local half: state, reason, status — no GitHub write. */
function escalate(
  state: LoopState,
  reason: RefinementHandoffReason,
  data: Record<string, unknown> = {},
): void {
  state.block.state = "escalated_human";
  state.block.handoffReason = reason;
  touch(state);
  emitEvent(state, "refinement.escalated.human", { reason, ...data });
  state.taskStatus = "ready_for_human";
  state.outcome = { kind: "escalated", reason };
}

/**
 * Rows 38/40 (§17): persist the resumable mid-round position and stop this
 * run. The state literal does not move — the block stays `drafting` or
 * `critiquing` — and the SAME role re-runs on the next phase run after the
 * phase-level delay. `refinement.agent.failed` (already emitted by the turn)
 * is the audit record; §15's event list is closed, so no new event is minted.
 */
function deferRoleRetry(
  state: LoopState,
  record: Omit<RefinementPendingRetryRecord, "recordedAt">,
): void {
  state.block.pendingRetry = { ...record, recordedAt: iso(state) };
  touch(state);
  state.outcome = {
    kind: "agent_retry",
    role: record.role,
    failureKind: record.failureKind,
    round: record.round,
  };
}

function writeArtifact(state: LoopState, name: string, content: string): void {
  writeArtifactFile(state.artifactDir, name, content);
  state.artifacts.push(name);
}

function roleRunRecord(profile: ResolvedRefinementRoleProfile): RefinementRoleRunRecord {
  return {
    agentId: profile.agentId,
    provider: profile.provider,
    model: profile.model ?? null,
    modelSource: profile.modelSource,
    effort: profile.effort ?? null,
    effortSource: profile.effortSource,
    invocations: 0,
    totalDurationMs: 0,
  };
}

/** §15/§16 run manifest: agent/company/model/effort/duration per role. */
function writeRunManifest(state: LoopState): void {
  const manifest = {
    runId: state.runId,
    issueNumber: state.issueNumber,
    startedAt: state.startedAt,
    finishedAt: iso(state),
    outcome: state.outcome ?? null,
    state: state.block.state,
    handoffReason: state.block.handoffReason,
    predecessorFingerprint: state.block.predecessorFingerprint,
    counters: state.block.counters,
    roles: state.block.execution ?? null,
    artifacts: [...state.artifacts, "run-manifest.json"],
  };
  writeArtifactFile(state.artifactDir, "run-manifest.json", JSON.stringify(manifest, null, 2));
  state.artifacts.push("run-manifest.json");
}

interface RoleTurnContext {
  role: RefinementLoopRole;
  agent: RefinementAgentRunner;
  record: RefinementRoleRunRecord;
  timeoutMs: number;
  classify: RefinementFailureClassifier;
}

/**
 * One §12 role turn with its two self-loops: rows 38/39 (40/41) for process
 * failures, rows 12/13 (20/21) for malformed output. Returns the parsed value
 * on success; on escalation the state already carries the handoff.
 *
 * The raw transcript is ALWAYS written before parsing (§17), so a turn that
 * admits nothing still leaves a record.
 */
function invokeRole(
  state: LoopState,
  turn: RoleTurnContext,
  round: number,
  attempt: number,
  prompt: string,
): { result: CommandRunResult; durationMs: number } {
  const started = state.nowMs();
  let result: CommandRunResult;
  try {
    result = turn.agent({ prompt, timeoutMs: turn.timeoutMs });
  } catch (err) {
    // The isolated invocation's own mkdtemp can throw, and an injected test
    // agent can too; both are process failures, not malformed output.
    const detail = agentSetupDetail(err);
    result = { stdout: "", stderr: detail, exitCode: -1, spawnError: detail };
  }
  const durationMs = state.nowMs() - started;
  turn.record.invocations += 1;
  turn.record.totalDurationMs += durationMs;
  const prefix = `${turn.role}-round${round}-attempt${attempt}`;
  writeArtifact(state, `${prefix}-stdout.txt`, boundRawOutput(result.stdout));
  writeArtifact(state, `${prefix}-stderr.txt`, boundRawOutput(result.stderr));
  return { result, durationMs };
}

function runRoleTurn<T>(
  state: LoopState,
  turn: RoleTurnContext,
  round: number,
  buildPrompt: (nonce: string) => string,
  parse: (stream: string) => { ok: true; value: T } | { ok: false; malformed: string[] },
  startAttempt = 1,
): { ok: true; value: T } | { ok: false; retry?: { attempt: number; failureKind: string } } {
  const limits = state.block.limits;
  const counters = state.block.counters;
  const malformedEvent =
    turn.role === "refiner" ? "refinement.draft.malformed" : "refinement.critique.malformed";
  const malformedReason: RefinementHandoffReason =
    turn.role === "refiner" ? "malformed_refiner_output" : "malformed_critic_output";
  for (let attempt = startAttempt; ; attempt += 1) {
    const nonce = randomBytes(12).toString("hex");
    const { result } = invokeRole(state, turn, round, attempt, buildPrompt(nonce));

    if (result.exitCode !== 0 || result.spawnError) {
      const failure = turn.classify(result);
      if (failure.retryable && counters.agentFailures[turn.role] < limits.maxAgentFailuresPerRole) {
        counters.agentFailures[turn.role] += 1;
        touch(state);
        // Rows 38/40: no round and no malformed-attempt counter is spent.
        emitEvent(state, "refinement.agent.failed", {
          role: turn.role,
          agentId: turn.record.agentId,
          provider: turn.record.provider,
          model: turn.record.model,
          effort: turn.record.effort,
          failureKind: failure.kind,
          retryable: true,
          round,
          attempt,
        });
        // §17: the re-run happens on a LATER phase run, after the phase-level
        // delay the existing classification prescribes — a quota or timeout
        // retried synchronously here would burn the remaining attempts while
        // the provider is still unavailable. The caller persists the
        // resumable position and returns a delayed outcome.
        return { ok: false, retry: { attempt, failureKind: failure.kind } };
      }
      // Rows 39/41: the task never reaches status `failed` (§17).
      escalate(state, "agent_unavailable", {
        role: turn.role,
        failureKind: failure.kind,
        retryable: failure.retryable,
        round,
        attempt,
      });
      return { ok: false };
    }

    // An agent that printed its answer on the wrong stream still gets a turn.
    const stream = result.stdout.trim() !== "" ? result.stdout : result.stderr;
    const parsed = parse(stream);
    if (parsed.ok) return { ok: true, value: parsed.value };

    if (counters.malformedAttempts[turn.role] < limits.maxMalformedAttemptsPerRole) {
      counters.malformedAttempts[turn.role] += 1;
      touch(state);
      // Rows 12/20: re-run the same role; nothing is salvaged (§17).
      emitEvent(state, malformedEvent, {
        role: turn.role,
        details: parsed.malformed,
        round,
        attempt,
      });
      continue;
    }
    // Rows 13/21.
    escalate(state, malformedReason, { role: turn.role, details: parsed.malformed, round, attempt });
    return { ok: false };
  }
}

/**
 * Run one bounded refinement attempt: §12 rows 8–21 plus the local half of
 * every escalation those rows can raise. See the module header for the scope
 * boundary and the one ordering deviation.
 */
export async function executeRefinementLoop(
  input: RefinementLoopInput,
  deps: RefinementLoopDeps,
): Promise<RefinementLoopRunResult> {
  const nowMs = deps.now ?? Date.now;
  const block = structuredClone(input.block) as RefinementLoopContextBlock;
  const state: LoopState = {
    block,
    events: [],
    artifacts: [],
    issueNumber: input.issueNumber,
    runId: input.runId,
    artifactDir: input.artifactDir,
    startedAt: new Date(nowMs()).toISOString(),
    nowMs,
    taskStatus: null,
  };
  const finish = (): RefinementLoopRunResult => {
    writeRunManifest(state);
    return {
      outcome: state.outcome ?? { kind: "refused", detail: "internal:no-outcome" },
      block: state.block,
      events: state.events,
      taskStatus: state.taskStatus,
      artifacts: state.artifacts,
    };
  };

  // §12 rows 38/40: a `drafting`/`critiquing` block carrying the resumable
  // retry position re-enters here after the phase-level delay, and ONLY then —
  // a mid-loop state without one (a crashed run never persists) stays refused.
  const pendingRetry = block.pendingRetry;
  const resuming =
    pendingRetry !== undefined
    && ((block.state === "drafting" && pendingRetry.role === "refiner")
      || (block.state === "critiquing" && pendingRetry.role === "critic"));
  if (block.state !== "pending" && block.state !== "eligible" && !resuming) {
    // Not an escalation: a terminal or mid-application block is not this
    // slice's to move, and refusing without touching it keeps a re-invoked
    // runner idempotent.
    return {
      outcome: { kind: "refused", detail: `state:${block.state}` },
      block,
      events: [],
      taskStatus: null,
      artifacts: [],
    };
  }
  if (resuming && pendingRetry) {
    // Fail closed on a position that cannot re-run the SAME role with the SAME
    // inputs: re-running a different role, or the refiner without the revision
    // context it must address, would silently violate rows 38/40.
    const missingInputs =
      (pendingRetry.role === "critic" && !pendingRetry.draft)
      || (pendingRetry.role === "refiner"
        && block.counters.rounds > 0
        && (!pendingRetry.previousContract || !pendingRetry.objections));
    if (missingInputs || pendingRetry.round !== block.counters.rounds + 1) {
      return {
        outcome: { kind: "refused", detail: `pending-retry:${pendingRetry.role}` },
        block,
        events: [],
        taskStatus: null,
        artifacts: [],
      };
    }
  } else if (block.pendingRetry) {
    // A fresh entry (row 36 recovery re-queues at `pending`) must not inherit
    // a stale mid-round position from an earlier attempt.
    delete block.pendingRetry;
  }

  mkdirSync(input.artifactDir, { recursive: true });
  const timeoutMs = input.timeoutMs ?? DEFAULT_REFINEMENT_LOOP_TIMEOUT_MS;
  const env = deps.env ?? process.env;
  const classify = deps.classifyFailure ?? defaultRefinementFailureClassifier;
  const resolveProfile = deps.resolveRoleProfile ?? resolveRefinementRoleProfile;

  // -------------------------------------------------------------------------
  // Rows 8/9 — roles. §7.3: resolved once, before the snapshot is captured,
  // so a run that cannot name two independent executable agents spends nothing.
  // -------------------------------------------------------------------------
  const refinerId = block.roles.refinerAgent;
  const criticId = block.roles.criticAgent;
  if (!refinerId || !criticId) {
    escalate(state, "no_independent_critic", {
      detail: !refinerId ? "refiner-unassigned" : "critic-unassigned",
    });
    return finish();
  }
  const refinerResolution = resolveProfile("refiner", refinerId, env);
  if ("error" in refinerResolution) {
    escalate(state, "no_independent_critic", { detail: `refiner-profile:${refinerId}` });
    return finish();
  }
  const criticResolution = resolveProfile("critic", criticId, env);
  if ("error" in criticResolution) {
    escalate(state, "no_independent_critic", { detail: `critic-profile:${criticId}` });
    return finish();
  }
  const refinerProfile = refinerResolution.profile;
  const criticProfile = criticResolution.profile;
  const independence = evaluateRefinementRoleIndependence(
    { agentId: refinerProfile.agentId, provider: refinerProfile.provider, model: refinerProfile.model ?? null },
    { agentId: criticProfile.agentId, provider: criticProfile.provider, model: criticProfile.model ?? null },
    block.roles.allowSameProvider,
  );
  if (!independence.ok) {
    escalate(state, "no_independent_critic", { detail: independence.rejection });
    return finish();
  }

  const refinerRecord = roleRunRecord(refinerProfile);
  const criticRecord = roleRunRecord(criticProfile);
  block.execution = { runId: input.runId, refiner: refinerRecord, critic: criticRecord };
  touch(state);
  // Row 8: record both resolved roles.
  emitEvent(state, "refinement.roles.resolved", {
    refiner: {
      agentId: refinerProfile.agentId,
      provider: refinerProfile.provider,
      model: refinerProfile.model ?? null,
      effort: refinerProfile.effort ?? null,
      toolPolicy: refinerProfile.toolPolicy,
    },
    critic: {
      agentId: criticProfile.agentId,
      provider: criticProfile.provider,
      model: criticProfile.model ?? null,
      effort: criticProfile.effort ?? null,
      toolPolicy: criticProfile.toolPolicy,
    },
    crossProvider: independence.crossProvider,
    sameProviderFallback: independence.sameProviderFallback,
    allowSameProvider: block.roles.allowSameProvider,
  });

  // -------------------------------------------------------------------------
  // Rows 3–7 and 10 — predecessors and the bounded snapshot (#868).
  // -------------------------------------------------------------------------
  let target: RefinementIssueRead;
  try {
    target = await deps.source.readIssue(input.issueNumber);
  } catch (err) {
    state.outcome = {
      kind: "snapshot_failed",
      stage: "issue",
      error: err instanceof Error ? err.message : String(err),
    };
    return finish();
  }
  const laneLabels: RefinementLabels = {
    marker: block.markerLabel,
    implementationStatus:
      block.activationPlan?.implementationStatusLabel ?? IMPLEMENTATION_STATUS_LABEL,
  };
  const snapshotResult = await buildRefinementSnapshot({
    target,
    source: deps.source,
    limits: block.limits,
    laneLabels,
    stackReadyLabel: input.stackReadyLabel,
    now: iso(state),
  });
  if (snapshotResult.kind === "failed") {
    state.outcome = {
      kind: "snapshot_failed",
      stage: snapshotResult.stage,
      error: snapshotResult.error,
    };
    return finish();
  }
  if (snapshotResult.kind === "hold") {
    // Row 4: no counter moves, no state moves; re-evaluated on the next poll.
    emitEvent(state, "refinement.eligibility.refused", {
      reason: snapshotResult.reason,
      predecessors: snapshotResult.predecessorIssueNumbers,
      holds: snapshotResult.holds,
    });
    state.outcome = { kind: "hold", reason: snapshotResult.reason };
    return finish();
  }
  if (snapshotResult.kind === "handoff") {
    // Rows 5/6/7.
    escalate(state, snapshotResult.reason, {
      predecessors: snapshotResult.predecessorIssueNumbers,
    });
    return finish();
  }
  const snapshot: RefinementSnapshot = snapshotResult.snapshot;
  const enteredPending = block.state === "pending";
  block.predecessorFingerprint = snapshot.predecessorFingerprint;
  block.predecessors = refinementPredecessorRecords(snapshot);
  if (enteredPending) {
    // Row 3. A stale-restart re-entry arrives at `eligible` already granted.
    block.state = "eligible";
    touch(state);
    emitEvent(state, "refinement.eligibility.granted", {});
  } else {
    touch(state);
  }
  writeArtifact(state, "snapshot.json", JSON.stringify(snapshot, null, 2));
  if (!resuming) {
    // Rows 38/40: a resumed run re-enters with the state already at the
    // deferred role's literal — `drafting` or `critiquing` — and must not
    // move it (§17: "the refinement state does not move").
    block.state = "drafting";
  }
  touch(state);
  emitEvent(state, "refinement.snapshot.captured", {
    predecessorCount: snapshot.manifest.predecessorCount,
    totalTextBytes: snapshot.manifest.totalTextBytes,
    truncatedFields: snapshot.manifest.truncatedFields.length,
  });

  // -------------------------------------------------------------------------
  // Rows 11–21 — the bounded exchange. A round is one refiner draft plus one
  // critic verdict (§8); only a well-formed verdict advances the round counter.
  // -------------------------------------------------------------------------
  const refinerTurn: RoleTurnContext = {
    role: "refiner",
    agent:
      deps.refinerAgent
      ?? createRefinementAgentRunner(refinerProfile, deps.agentRunner ?? bothStreamsCommandRunner, env),
    record: refinerRecord,
    timeoutMs,
    classify,
  };
  const criticTurn: RoleTurnContext = {
    role: "critic",
    agent:
      deps.criticAgent
      ?? createRefinementAgentRunner(criticProfile, deps.agentRunner ?? bothStreamsCommandRunner, env),
    record: criticRecord,
    timeoutMs,
    classify,
  };

  let objections: RefinementObjection[] | null = null;
  let previousContract: RefinedContract | null = null;
  // Rows 38/40 resume: seed the deferred turn's inputs from the persisted
  // position, then consume it — a later failure records a fresh one. The
  // attempt numbering continues where the deferred run stopped so the events
  // and per-run transcript names read as one bounded sequence.
  let resumeDraft: RefinedContract | null = null;
  let refinerStartAttempt = 1;
  let criticStartAttempt = 1;
  if (resuming && pendingRetry) {
    if (pendingRetry.role === "refiner") {
      previousContract = pendingRetry.previousContract ?? null;
      objections = pendingRetry.objections ?? null;
      refinerStartAttempt = pendingRetry.attempt + 1;
    } else {
      resumeDraft = pendingRetry.draft ?? null;
      criticStartAttempt = pendingRetry.attempt + 1;
    }
    delete block.pendingRetry;
    touch(state);
  }

  for (;;) {
    const round = block.counters.rounds + 1;

    let draft: RefinedContract;
    let renderedRegion: string;
    let regionBytes: number;
    if (resumeDraft) {
      // Row 40: this round's draft survived the deferred run, so only the
      // critic re-runs — `refinement.draft.recorded` was already committed
      // with that run. The region re-renders deterministically from the
      // persisted contract and the fingerprint, which is why it is never
      // persisted itself (§15 keeps rendered prose out of the block).
      draft = resumeDraft;
      resumeDraft = null;
      renderedRegion = renderManagedRegion(draft, snapshot.predecessorFingerprint);
      regionBytes = Buffer.byteLength(renderedRegion, "utf8");
    } else {
      block.state = "drafting";
      touch(state);
      const drafted = runRoleTurn(
        state,
        refinerTurn,
        round,
        (nonce) =>
          buildRefinerPrompt({ snapshot, nonce, round, previousContract, objections }),
        (stream) => {
          const parsed = parseRefinerResponse(stream, snapshot, block.limits.maxManagedRegionBytes);
          if (!parsed.ok) return parsed;
          return {
            ok: true,
            value: {
              contract: parsed.contract,
              renderedRegion: parsed.renderedRegion,
              regionBytes: parsed.regionBytes,
            },
          };
        },
        refinerStartAttempt,
      );
      refinerStartAttempt = 1;
      if (!drafted.ok) {
        if (drafted.retry) {
          // Row 38: the refiner re-runs with the SAME revision inputs.
          deferRoleRetry(state, {
            role: "refiner",
            round,
            attempt: drafted.retry.attempt,
            failureKind: drafted.retry.failureKind,
            ...(previousContract ? { previousContract } : {}),
            ...(objections ? { objections } : {}),
          });
        }
        return finish();
      }
      draft = drafted.value.contract;
      renderedRegion = drafted.value.renderedRegion;
      regionBytes = drafted.value.regionBytes;
      // Row 11.
      block.state = "critiquing";
      touch(state);
      emitEvent(state, "refinement.draft.recorded", {
        round,
        role: "refiner",
        agentId: refinerProfile.agentId,
        provider: refinerProfile.provider,
        model: refinerProfile.model ?? null,
        effort: refinerProfile.effort ?? null,
        confidence: draft.confidence,
        topologyProposals: draft.topologyProposals.length,
        regionBytes,
      });
    }

    const critiqued = runRoleTurn(
      state,
      criticTurn,
      round,
      (nonce) => buildCriticPrompt({ snapshot, nonce, contract: draft }),
      (stream) => {
        const parsed = parseCriticResponse(stream);
        if (!parsed.ok) return parsed;
        return { ok: true, value: parsed.critique };
      },
      criticStartAttempt,
    );
    criticStartAttempt = 1;
    if (!critiqued.ok) {
      if (critiqued.retry) {
        // Row 40: the critic re-runs against the SAME draft.
        deferRoleRetry(state, {
          role: "critic",
          round,
          attempt: critiqued.retry.attempt,
          failureKind: critiqued.retry.failureKind,
          draft,
        });
      }
      return finish();
    }
    const verdictRecord: RefinementCritique = critiqued.value;

    // §8: the verdict completes the round, whatever it says.
    block.counters.rounds = round;
    touch(state);

    if (verdictRecord.verdict === "block") {
      // Row 19.
      escalate(state, "critique_blocked", {
        round,
        criticConfidence: verdictRecord.confidence,
      });
      return finish();
    }

    if (verdictRecord.verdict === "revise") {
      if (round < block.limits.maxRefinementRoundsPerIssue) {
        // Row 17: the objections are the only critic output handed back.
        emitEvent(state, "refinement.critique.revise", {
          round,
          objections: verdictRecord.objections.map((o) => ({ field: o.field, kind: o.kind })),
          criticConfidence: verdictRecord.confidence,
        });
        objections = verdictRecord.objections;
        previousContract = draft;
        continue;
      }
      // Row 18.
      escalate(state, "no_convergence", {
        round,
        objections: verdictRecord.objections.map((o) => ({ field: o.field, kind: o.kind })),
      });
      return finish();
    }

    // `pass` — rows 14/15/16, decided by the §9 combination.
    const combined = combineTopologyDispositions(
      draft.topologyProposals,
      verdictRecord.topologyDispositions,
    );
    if (combined.anyBlocking) {
      // Row 16: nothing applied.
      escalate(state, "topology_change_required", {
        round,
        topology: combined.effective.map((e) => ({
          index: e.index,
          kind: e.kind,
          refinerDisposition: e.refinerDisposition,
          criticDisposition: e.criticDisposition,
          effective: e.effective,
        })),
      });
      return finish();
    }

    block.state = "accepted";
    block.accepted = {
      contract: draft,
      topology: combined.effective,
      refinerConfidence: draft.confidence,
      criticConfidence: verdictRecord.confidence,
      roundsUsed: round,
      regionBytes,
      acceptedAt: iso(state),
    };
    touch(state);
    // Rows 14/15.
    emitEvent(state, "refinement.critique.passed", {
      round,
      refinerConfidence: draft.confidence,
      criticConfidence: verdictRecord.confidence,
    });
    if (combined.effective.length > 0) {
      emitEvent(state, "refinement.topology.recorded", {
        topology: combined.effective.map((e) => ({
          index: e.index,
          kind: e.kind,
          refinerDisposition: e.refinerDisposition,
          criticDisposition: e.criticDisposition,
          effective: e.effective,
        })),
      });
    }
    // The #869 acceptance artifact — persisted locally, never published (§15).
    writeArtifact(
      state,
      "accepted-refinement.json",
      JSON.stringify(
        {
          issueNumber: input.issueNumber,
          runId: input.runId,
          predecessorFingerprint: block.predecessorFingerprint,
          accepted: block.accepted,
        },
        null,
        2,
      ),
    );
    writeArtifact(state, "managed-region.md", renderedRegion);
    state.outcome = { kind: "accepted" };
    return finish();
  }
}

// ---------------------------------------------------------------------------
// Phase-runner adapter
// ---------------------------------------------------------------------------

/**
 * Dependencies for the `refinement` phase handler. The snapshot source is the
 * one seam the composition root MUST provide (the gh-backed adapter lives in
 * the CLI layer — see `createGhRefinementSnapshotSource` — so this module
 * stays free of `gh` shelling); the rest are {@link RefinementLoopDeps} test
 * seams passed straight through.
 *
 * `applyPort` (issue #870) is the §11 step 3–5 write port for the application
 * walk, with the same layering as the source: the gh-backed adapter is
 * `createGhRefinementApplyPort` in the CLI layer. It is optional so a
 * composition root that cannot mutate the work item (or predates the apply
 * slice) fails CLOSED: an `accepted`/`applying` block with no port parks
 * `ready_for_human` instead of failing the task or silently skipping stages.
 */
export type RefinementPhaseHandlerDeps = RefinementLoopDeps & {
  timeoutMs?: number;
  applyPort?: RefinementApplyPort;
};

/**
 * Cool-down for a `hold`/`snapshot_failed` release back to `queued`. The
 * runner's default delayed cool-down is the QUOTA window (hours) — wrong for
 * a predecessor-not-ready poll or a transient provider read failure, both of
 * which §12 row 4 expects the next ordinary poll to re-evaluate cheaply.
 */
export const REFINEMENT_RETRY_DELAY_MS = 15 * 60 * 1000;

/**
 * Adapt {@link executeRefinementLoop} to the phase-runner handler contract so
 * an intake-admitted `refinement` task is executed by the ordinary
 * `run-one-phase` tick (issue #869 review follow-up) instead of waiting for an
 * operator to invoke `admin refinement run` by hand. The runner commits the
 * returned context patch, the loop's audit events (`extraEvents`), and the
 * status transition in one `completePhaseWithEffects` transaction — the same
 * atomicity the admin command provides — and its refinement-phase effect gate
 * enqueues no GitHub side effect, preserving §13's "no GitHub write".
 *
 * An `accepted` or `applying` block dispatches to the application walk
 * (issue #870, `executeRefinementApply`) instead of the loop, so one handler
 * carries a task from admission to activation across successive ticks.
 *
 * Outcome mapping, in the runner's vocabulary:
 *
 *  - `accepted`   → `success`: the loop's terminal state. `nextPhaseAfter`
 *    keeps a refinement success `queued` at this phase, so the next tick
 *    re-claims the block and runs the application walk on it (row 22).
 *  - apply `committed` → `success`: the row-22 commit point persisted; the
 *    re-queued next run performs the body/comment/label stages against it.
 *  - apply `activated` → `success` + `refinementActivation`: the runner parks
 *    the shared row `blocked`/phase `implementation` (row 45) in the same
 *    transaction as the `activated` block, per the persisted activation plan.
 *  - apply `stale_restart` / `verify_failed` / `write_failed` → `delayed`:
 *    the short refinement re-poll window; the block already records what the
 *    next run must re-derive (rows 23/26/43, or the row-32 bounded retry).
 *  - `escalated`  → `blocked`: §13's exceptional handoff; the runner's routing
 *    lands on `ready_for_human`, matching the loop's own `taskStatus`.
 *  - `hold` / `snapshot_failed` → `delayed`: nothing moved; the task is
 *    released back to `queued` with a cool-down and re-polled by the normal
 *    schedule (the CLI's stays-queued equivalent).
 *  - `agent_retry` → `delayed`: §12 rows 38/40. The block carries the
 *    resumable position (`pendingRetry`), and the release deliberately OMITS
 *    `retryAfterMs` so the runner applies its default delayed cool-down — the
 *    phase-level delay §17 prescribes for a quota/timeout/transient provider
 *    failure — rather than the short refinement re-poll window used for
 *    eligibility holds.
 *  - `refused`    → `failed`: a claimed task whose block is terminal or
 *    mid-application should not have been runnable; fail closed rather than
 *    spin. Nothing is persisted onto the block, mirroring the admin command.
 */
export function createRefinementHandler(
  context: PhaseHandlerContext,
  deps: RefinementPhaseHandlerDeps,
): PhaseHandler {
  const { session, runId } = context;
  return async (task): Promise<PhaseHandlerResult> => {
    const settings = resolveIssueRefinementSettings(session.issueRefinement);
    if (!settings.ok) {
      return {
        result: "failed",
        error:
          "Invalid issueRefinement configuration: "
          + settings.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
      };
    }
    if (!settings.settings.enabled) {
      // Admitted while the lane was on, claimed after it was turned off: fail
      // closed rather than run a lane the session has disabled.
      return {
        result: "failed",
        error:
          "issueRefinement is disabled for this session (issueRefinement.enabled is not true); "
          + "refusing to run an already-admitted refinement task.",
      };
    }
    const block = readRefinementContextBlock(task.context);
    if (!block) {
      return {
        result: "failed",
        error:
          `Task for issue #${task.issueNumber} carries no context.refinement block; `
          + "re-run intake to admit it into the refinement lane.",
      };
    }

    // Issue #870: an accepted refinement continues into application and
    // activation on this same handler — the loop refuses these states, and
    // parking them would reintroduce the routine human approval step the
    // contract's §11 removes.
    if (block.state === "accepted" || block.state === "applying") {
      if (!deps.applyPort) {
        // Fail closed, not `failed`: §17 forbids the lane dying at status
        // `failed`, and without a write surface no application stage can run.
        return {
          result: "blocked",
          message:
            `refinement for issue #${task.issueNumber} is ${block.state} but this composition `
            + "root provides no work-item write port for the application slice; parking the "
            + "task for an operator.",
        };
      }
      const applied = await executeRefinementApply(
        {
          issueNumber: task.issueNumber,
          block: block as RefinementApplyContextBlock,
          stackReadyLabel: session.labels["stackReady"] ?? "status:stack-ready",
          artifactDir: join(
            session.artifactRoot,
            "issue-refinement",
            `issue-${task.issueNumber}`,
            runId,
          ),
          runId,
        },
        {
          source: deps.source,
          applyPort: deps.applyPort,
          ...(deps.now ? { now: deps.now } : {}),
        },
      );
      const applyOutcome = applied.outcome;
      const applyPatch: Record<string, unknown> = { refinement: applied.block };
      const applyEvents = applied.events.map((e) => ({ type: e.type, data: e.data }));
      switch (applyOutcome.kind) {
        case "refused":
          return {
            result: "failed",
            error: `refinement application is not runnable (${applyOutcome.detail})`,
            context: applyPatch,
          };
        case "committed":
          return {
            result: "success",
            message:
              "refinement commit point persisted (contract row 22); the body, comment, and "
              + "label stages apply on the next run",
            context: applyPatch,
            extraEvents: applyEvents,
          };
        case "stale_restart":
          return {
            result: "delayed",
            message:
              `refinement inputs moved (${applyOutcome.trigger}); draft discarded, `
              + `re-snapshotting (stale restart ${applyOutcome.staleRestarts})`,
            retryAfterMs: REFINEMENT_RETRY_DELAY_MS,
            context: applyPatch,
            extraEvents: applyEvents,
          };
        case "verify_failed":
          return {
            result: "delayed",
            message:
              `refinement fingerprint re-verification failed (${applyOutcome.stage}): `
              + applyOutcome.error,
            retryAfterMs: REFINEMENT_RETRY_DELAY_MS,
            context: applyPatch,
            extraEvents: applyEvents,
          };
        case "write_failed":
          return {
            result: "delayed",
            message:
              `refinement application step ${applyOutcome.step} failed transiently `
              + `(${applyOutcome.transientFailures}/${MAX_APPLY_TRANSIENT_FAILURES} recorded): `
              + applyOutcome.error,
            retryAfterMs: REFINEMENT_RETRY_DELAY_MS,
            context: applyPatch,
            extraEvents: applyEvents,
          };
        case "escalated":
          return {
            result: "blocked",
            message: `refinement escalated to human: ${applyOutcome.reason}`,
            context: applyPatch,
            extraEvents: applyEvents,
          };
        case "activated":
          return {
            result: "success",
            message: `refinement applied and implementation activated for issue #${task.issueNumber}`,
            context: applyPatch,
            extraEvents: applyEvents,
            // Row 45: the park rides in the SAME completion transaction as
            // the `activated` block, per the plan persisted at admission.
            refinementActivation: {
              targetStatus: applied.block.activationPlan.targetStatus,
              targetPhase: applied.block.activationPlan.targetPhase,
            },
          };
      }
    }

    const result = await executeRefinementLoop(
      {
        issueNumber: task.issueNumber,
        block: block as RefinementLoopContextBlock,
        stackReadyLabel: session.labels["stackReady"] ?? "status:stack-ready",
        artifactDir: join(
          session.artifactRoot,
          "issue-refinement",
          `issue-${task.issueNumber}`,
          runId,
        ),
        runId,
        timeoutMs: deps.timeoutMs ?? DEFAULT_REFINEMENT_LOOP_TIMEOUT_MS,
      },
      deps,
    );

    const outcome = result.outcome;
    if (outcome.kind === "refused") {
      return {
        result: "failed",
        error: `refinement block is not runnable (${outcome.detail})`,
      };
    }
    const contextPatch: Record<string, unknown> = { refinement: result.block };
    const extraEvents = result.events.map((e) => ({ type: e.type, data: e.data }));
    if (outcome.kind === "hold") {
      return {
        result: "delayed",
        message: `refinement held: ${outcome.reason}`,
        retryAfterMs: REFINEMENT_RETRY_DELAY_MS,
        context: contextPatch,
        extraEvents,
      };
    }
    if (outcome.kind === "snapshot_failed") {
      return {
        result: "delayed",
        message: `refinement snapshot failed (${outcome.stage}): ${outcome.error}`,
        retryAfterMs: REFINEMENT_RETRY_DELAY_MS,
        context: contextPatch,
        extraEvents,
      };
    }
    if (outcome.kind === "agent_retry") {
      // Rows 38/40 (§17): the same role re-runs on a later phase run. No
      // `retryAfterMs` — the runner's default delayed cool-down IS the
      // phase-level delay the existing failure classification prescribes.
      return {
        result: "delayed",
        message:
          `refinement ${outcome.role} process failure (${outcome.failureKind}) in round `
          + `${outcome.round}; re-running the ${outcome.role} after the phase-level delay`,
        context: contextPatch,
        extraEvents,
      };
    }
    if (outcome.kind === "escalated") {
      return {
        result: "blocked",
        message: `refinement escalated to human: ${outcome.reason}`,
        context: contextPatch,
        extraEvents,
      };
    }
    return {
      result: "success",
      message: `refinement accepted after ${result.block.counters.rounds} round(s)`,
      context: contextPatch,
      extraEvents,
    };
  };
}
