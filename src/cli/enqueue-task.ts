#!/usr/bin/env node
/**
 * enqueue-task — CLI to insert a queued task into SqliteTaskStore.
 *
 * Command shape:
 *   node /path/to/dist/cli/enqueue-task.js \
 *     --session-id "addon-dev" \
 *     --issue-number 123 \
 *     --phase implementation \
 *     --implementation-agent claude \
 *     --review-agent codex
 *
 * Exits 0 for successful enqueue and for duplicate (already_exists).
 * Exits 1 for setup, validation, or unexpected runtime errors.
 * Writes one JSON object to stdout.
 */

import { JsonSessionRegistry, DEFAULT_SESSIONS_PATH } from "../registries/json-session-registry.js";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import { ASSIGNMENT_CONTEXT_KEY, resolveAssignment } from "../core/assignment.js";
import type { ResolvedAssignment } from "../core/assignment.js";
import type { AgentId, TaskPhase, TaskPriority } from "../core/task.js";
import { emit, die } from "./cli-io.js";
import { tokenizeArgs } from "./admin-command.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_PHASES = new Set<TaskPhase>([
  "implementation",
  "review",
  "conflict_resolution",
  "research",
  "content_research",
  "content_draft",
  "content_review",
  "planner",
]);

const VALID_AGENTS = new Set<AgentId>(["claude", "codex", "gemini"]);

const VALID_PRIORITIES = new Set<TaskPriority>(["high", "normal", "low"]);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  sessionId: string;
  issueNumber: number;
  phase: TaskPhase;
  sessionsPath: string;
  dbPath: string | undefined;
  priority: TaskPriority;
  implementationAgent: AgentId | undefined;
  reviewAgent: AgentId | undefined;
  researchAgent: AgentId | undefined;
  context: Record<string, unknown> | undefined;
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: [
      "session-id",
      "issue-number",
      "phase",
      "sessions-path",
      "db-path",
      "priority",
      "implementation-agent",
      "review-agent",
      "research-agent",
      "context-json",
    ],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;

  if (!args["session-id"]) return { error: "--session-id is required" };
  if (!args["issue-number"]) return { error: "--issue-number is required" };
  if (!args["phase"]) return { error: "--phase is required" };

  const issueNumber = Number(args["issue-number"]);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
  }

  const phase = args["phase"] as TaskPhase;
  if (!VALID_PHASES.has(phase)) {
    return { error: `--phase must be one of: ${[...VALID_PHASES].join(", ")}, got: ${phase}` };
  }

  const priority = (args["priority"] ?? "normal") as TaskPriority;
  if (!VALID_PRIORITIES.has(priority)) {
    return { error: `--priority must be one of: ${[...VALID_PRIORITIES].join(", ")}, got: priority` };
  }

  const agentError = (flag: string, val: string) =>
    `--${flag} must be one of: ${[...VALID_AGENTS].join(", ")}, got: ${val}`;

  for (const flag of ["implementation-agent", "review-agent", "research-agent"] as const) {
    const val = args[flag];
    if (val !== undefined && !VALID_AGENTS.has(val as AgentId)) {
      return { error: agentError(flag, val) };
    }
  }

  let context: Record<string, unknown> | undefined;
  if (args["context-json"] !== undefined) {
    try {
      const parsed: unknown = JSON.parse(args["context-json"]);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { error: "--context-json must be a JSON object" };
      }
      context = parsed as Record<string, unknown>;
    } catch {
      return { error: `--context-json is not valid JSON: ${args["context-json"]}` };
    }
  }

  return {
    sessionId: args["session-id"],
    issueNumber,
    phase,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"],
    priority,
    implementationAgent: args["implementation-agent"] as AgentId | undefined,
    reviewAgent: args["review-agent"] as AgentId | undefined,
    researchAgent: args["research-agent"] as AgentId | undefined,
    context,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) die(parsed.error);

  const { sessionId, issueNumber, phase, sessionsPath, dbPath, priority, context } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const session = await registry.getSessionById(sessionId);
  if (!session) {
    die(`Unknown sessionId: ${sessionId} (not found in ${sessionsPath})`);
  }

  // Apply session defaults for missing agents.
  const implementationAgent = parsed.implementationAgent ?? session.defaults.implementationAgent;
  const reviewAgent = parsed.reviewAgent ?? session.defaults.reviewAgent;
  const researchAgent = parsed.researchAgent ?? session.defaults.researchAgent;

  // Resolve and persist the assignment from trusted session config and any
  // labels supplied in the context. An explicit `assignment` in --context-json
  // wins, so callers can pin a specific resolution; otherwise it is computed and
  // persisted so the task carries an immutable, auditable agent decision (#259).
  //
  // Explicit --implementation-agent / --review-agent / --research-agent flags
  // override the resolved slots, preserving the manual enqueue override path:
  // phase handlers now read context.assignment, so without this the flags would
  // be silently ignored. The implementation override also drives
  // conflict_resolution, matching its historical follow-the-implementation
  // behavior. A full `assignment` in --context-json still wins over both.
  const contextLabels = Array.isArray(context?.labels) ? (context!.labels as string[]) : [];
  const baseAssignment = resolveAssignment(session, contextLabels, new Date().toISOString());
  const assignment: ResolvedAssignment = {
    ...baseAssignment,
    ...(parsed.implementationAgent
      ? { implementationAgent: parsed.implementationAgent }
      : {}),
    // Conflict resolution only supports Claude; force this regardless of whether
    // implementationAgent came from an explicit flag or a session default (e.g. gemini).
    conflictResolutionAgent: "claude",
    ...(parsed.reviewAgent ? { reviewAgent: parsed.reviewAgent } : {}),
    ...(parsed.researchAgent ? { researchAgent: parsed.researchAgent } : {}),
  };
  const resolvedContext: Record<string, unknown> = {
    [ASSIGNMENT_CONTEXT_KEY]: assignment,
    ...(context ?? {}),
  };

  const store = new SqliteTaskStore(dbPath);
  try {
    const result = await store.enqueueTask({
      sessionId,
      issueNumber,
      phase,
      priority,
      implementationAgent,
      reviewAgent,
      researchAgent,
      context: resolvedContext,
    });

    if (result.ok) {
      emit({
        ok: true,
        code: "enqueued",
        task: {
          sessionId: result.value.sessionId,
          issueNumber: result.value.issueNumber,
          phase: result.value.phase,
          status: result.value.status,
          priority: result.value.priority,
        },
      });
    } else {
      // already_exists is an expected idempotent outcome — exit 0.
      emit({
        ok: false,
        code: result.code,
        task: result.current
          ? {
              sessionId: result.current.sessionId,
              issueNumber: result.current.issueNumber,
              phase: result.current.phase,
              status: result.current.status,
            }
          : undefined,
      });
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  die(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
