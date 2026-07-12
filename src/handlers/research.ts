import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { AiTask } from "../core/task.js";
import type { PhaseHandler, PhaseHandlerContext, PhaseHandlerResult } from "../core/phase-runner.js";
import { defaultCommandRunner } from "./command-runner.js";
import type { CommandRunner } from "./command-runner.js";
import { runArtifactDir, writeAssignmentFailureArtifact } from "./artifact-dir.js";
import { agentForPhase, readResolvedAssignment } from "../core/assignment.js";
import { classifyQuotaExhaustion } from "../core/quota-classifier.js";
export type { CommandRunner, CommandRunResult } from "./command-runner.js";

function buildPrompt(task: AiTask, repoRoot: string): string {
  const ctx = task.context as Record<string, unknown>;
  const title = typeof ctx.title === "string" ? ctx.title : `Issue #${task.issueNumber}`;
  const url = typeof ctx.url === "string" ? `\nURL: ${ctx.url}` : "";
  const labels = Array.isArray(ctx.labels) ? `\nLabels: ${(ctx.labels as string[]).join(", ")}` : "";

  return [
    `# Research Task — Issue #${task.issueNumber}`,
    "",
    `**Title**: ${title}${url}${labels}`,
    `Repository root: ${repoRoot}`,
    "",
    "## Instructions",
    "",
    "Research the issue described above and produce actionable findings.",
    "Do NOT modify any files in the repository.",
    "Do NOT implement fixes, create branches, or open PRs.",
    "Focus on understanding the problem, existing code, and potential approaches.",
    "Summarize findings, options, recommendation, risks, and open questions.",
    "Make uncertain claims explicit instead of presenting them as verified facts.",
    "Output your findings as structured markdown.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Research command selection
// ---------------------------------------------------------------------------

export interface ResolvedResearchProfile {
  phase: "research";
  agentId: string;
  cmd: string;
  /** Sanitized argv — excludes prompt content (passed as positional arg and stdin). */
  argv: string[];
  cmdSource: "env" | "cli-default";
  modelSource: "cli-default" | "session-config";
  /** Configured Antigravity model name, present only when modelSource is "session-config". */
  model?: string;
}

function researchCommand(agentId: string | undefined, model: string | undefined): { cmd: string; args: string[]; resolvedProfile: ResolvedResearchProfile } | { error: string } {
  const agent = agentId ?? "gemini";
  if (agent === "gemini") {
    const envBin = process.env["ANTIGRAVITY_BIN"];
    const bin = envBin ?? "agy";
    const cmdSource: ResolvedResearchProfile["cmdSource"] = envBin ? "env" : "cli-default";
    const modelSource: ResolvedResearchProfile["modelSource"] = model ? "session-config" : "cli-default";
    const argv: string[] = model ? ["--model", model, "--print"] : ["--print"];
    const resolvedProfile: ResolvedResearchProfile = {
      phase: "research", agentId: agent, cmd: bin, argv, cmdSource, modelSource,
      ...(model ? { model } : {}),
    };
    // --print forces non-interactive/TUI output, mirroring the legacy shell worker:
    //   "$ANTIGRAVITY_BIN" --print "$(cat "$PROMPT")" > "$OUT" 2>&1
    return { cmd: bin, args: argv, resolvedProfile };
  }
  return { error: `Unsupported research agent: ${agent}. Supported: gemini` };
}

// ---------------------------------------------------------------------------
// Research phase handler factory
// ---------------------------------------------------------------------------

export function createResearchHandler(
  context: PhaseHandlerContext,
  runner: CommandRunner = defaultCommandRunner,
): PhaseHandler {
  return async (task: AiTask): Promise<PhaseHandlerResult> => {
    const { session, runId } = context;
    const artifactDir = runArtifactDir(session.artifactRoot, runId);

    // Determine research command
    const agentId = agentForPhase(task, session, "research");
    const antigravityModel = session.research?.antigravity?.model;
    const cmdSpec = researchCommand(agentId, antigravityModel);
    if ("error" in cmdSpec) {
      writeAssignmentFailureArtifact(artifactDir, {
        phase: "research", agentId, sessionId: task.sessionId, issueNumber: task.issueNumber, runId, error: cmdSpec.error,
      });
      return { result: "failed", error: cmdSpec.error, context: { artifactDir, assignmentError: { phase: "research", agent: agentId ?? null } } };
    }
    const resolvedProfile = cmdSpec.resolvedProfile;

    // Build prompt
    const prompt = buildPrompt(task, session.repoRoot);

    // Ensure artifact directory exists
    try {
      mkdirSync(artifactDir, { recursive: true });
    } catch (err) {
      return { result: "failed", context: { resolvedProfile }, error: `Failed to create artifact dir: ${err instanceof Error ? err.message : String(err)}` };
    }

    // Write prompt artifact
    writeFileSync(join(artifactDir, "research-prompt.md"), prompt, "utf8");

    // Write resolved agent profile before invoking the agent so interrupted/failed
    // runs still have a pre-run audit record of the intended billable profile.
    // Include the full persisted assignment (flow, source, resolvedAt, all phase
    // agents) so the run dir is self-describing, not just the per-phase resolvedProfile.
    const assignment = readResolvedAssignment(task);
    writeFileSync(join(artifactDir, "research-context.json"), JSON.stringify({
      issueNumber: task.issueNumber, sessionId: task.sessionId, runId, resolvedProfile,
      ...(assignment ? { assignment } : {}),
    }, null, 2), "utf8");

    // Run the research command — pass prompt as --print argument, matching the
    // legacy shell contract: agy --print "$(cat "$PROMPT")"
    const cmdResult = runner.run(cmdSpec.cmd, [...cmdSpec.args, prompt], { cwd: session.repoRoot, stdin: prompt });

    // Write output artifact regardless of success so there is always a record.
    writeFileSync(join(artifactDir, "research-output.md"), cmdResult.stdout || cmdResult.stderr, "utf8");

    const succeeded = cmdResult.exitCode === 0;
    // A quota/rate-limit exhaustion is recoverable on its own (issue #25): delay
    // the retry instead of failing the task.
    const quota = !succeeded
      ? classifyQuotaExhaustion(`${cmdResult.stdout}\n${cmdResult.stderr}`, agentId)
      : { isQuotaExhaustion: false as const };

    const resultJson = {
      issueNumber: task.issueNumber,
      sessionId: task.sessionId,
      runId,
      agentId,
      exitCode: cmdResult.exitCode,
      success: succeeded,
      ...(quota.isQuotaExhaustion ? { delayed: true, quotaSignal: quota.signal } : {}),
      artifactDir,
      resolvedProfile,
    };
    writeFileSync(join(artifactDir, "research-result.json"), JSON.stringify(resultJson, null, 2), "utf8");

    if (!succeeded) {
      if (quota.isQuotaExhaustion) {
        return {
          result: "delayed",
          context: { artifactDir, resolvedProfile, quotaSignal: quota.signal },
          message: `Research agent (${agentId}) hit a quota/rate-limit (signal: "${quota.signal}"); delaying retry`,
        };
      }
      return {
        result: "failed",
        error: `Research command exited ${cmdResult.exitCode}: ${(cmdResult.stderr || cmdResult.stdout).slice(0, 500)}`,
        context: { artifactDir, resolvedProfile },
      };
    }

    // success -> nextPhaseAfter("research", "success") falls through to
    // ready_for_human (existing default in transitions.ts). Safe first slice.
    return {
      result: "success",
      context: {
        artifactDir,
        researchAgentUsed: agentId,
        resolvedProfile,
        researchOutput: cmdResult.stdout.length > 3000
          ? cmdResult.stdout.slice(0, 3000) + "\n\n…(truncated)"
          : cmdResult.stdout,
      },
    };
  };
}
