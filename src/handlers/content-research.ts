import { mkdirSync, writeFileSync, lstatSync } from "fs";
import { join, relative, resolve } from "path";
import type { AiTask } from "../core/task.js";
import type { PhaseHandler, PhaseHandlerContext, PhaseHandlerResult } from "../core/phase-runner.js";
import { defaultCommandRunner } from "./command-runner.js";
import type { CommandRunner } from "./command-runner.js";
import {
  runArtifactDir,
  writeAssignmentFailureArtifact,
  isSafeArtifactDirAfterRun,
  ARTIFACT_DIR_PENDING_CONTEXT_FIELD,
} from "./artifact-dir.js";
import { agentForPhase, readResolvedAssignment } from "../core/assignment.js";
import { classifyQuotaExhaustion, resolveRetryDelayOverrideMsForCategory, describeFailureCategory } from "../core/quota-classifier.js";
import { extractAgentFailureDiagnostic } from "../core/agent-diagnostics.js";
export type { CommandRunner, CommandRunResult } from "./command-runner.js";

// ---------------------------------------------------------------------------
// Symlink guard — prevents a compromised agent from steering post-agent
// writeFileSync calls to paths outside the artifact directory via a pre-placed
// symlink (lstat does not follow links; ENOENT means the path is safe to create)
// ---------------------------------------------------------------------------

function rejectSymlink(p: string): void {
  try {
    if (lstatSync(p).isSymbolicLink()) throw new Error(`Refusing to write artifact at symlink path: ${p}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Result outcome
// ---------------------------------------------------------------------------

export type ContentResearchOutcome =
  | "valid"
  | "unverifiable"
  | "malformed"
  | "command-failure"
  | "quota/rate-limit";

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

const BODY_CHAR_LIMIT = 4000;

function buildPrompt(task: AiTask): string {
  const ctx = task.context as Record<string, unknown>;
  const title = typeof ctx.title === "string" ? ctx.title : `Issue #${task.issueNumber}`;
  const url = typeof ctx.url === "string" ? `\nURL: ${ctx.url}` : "";
  const labels = Array.isArray(ctx.labels) ? `\nLabels: ${(ctx.labels as string[]).join(", ")}` : "";
  const rawBody = typeof ctx.body === "string" ? ctx.body : null;
  const bodyText =
    rawBody !== null
      ? rawBody.length > BODY_CHAR_LIMIT
        ? rawBody.slice(0, BODY_CHAR_LIMIT) + "\n<!-- body truncated -->"
        : rawBody
      : null;
  const bodySection =
    bodyText !== null
      ? [
          "",
          "## Issue Body",
          "<!-- begin:issue-body-input -->",
          bodyText,
          "<!-- end:issue-body-input -->",
        ].join("\n")
      : "";

  return [
    `# Content Research Task — Issue #${task.issueNumber}`,
    "",
    `**Title**: ${title}${url}${labels}${bodySection}`,
    "",
    "## Instructions",
    "",
    "Research the topic described above and produce structured content findings.",
    "Do NOT include credentials, tokens, secrets, or private URLs in your output.",
    "Do NOT reference local filesystem paths in your output.",
    "Do NOT modify any files.",
    "Focus on understanding the topic, identifying key points, and producing actionable research findings.",
    "Summarize findings, key themes, audience considerations, and recommended content approach.",
    "Make uncertain claims explicit instead of presenting them as verified facts.",
    "Output your findings as structured markdown.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Command selection
// ---------------------------------------------------------------------------

export interface ResolvedContentResearchProfile {
  phase: "content_research";
  agentId: string;
  cmd: string;
  /** Sanitized argv — excludes prompt content (passed as positional arg and stdin). */
  argv: string[];
  cmdSource: "env" | "cli-default";
  modelSource: "cli-default" | "session-config";
  /** Configured Antigravity model name, present only when modelSource is "session-config". */
  model?: string;
}

function contentResearchCommand(
  agentId: string | undefined,
  model: string | undefined,
): { cmd: string; args: string[]; resolvedProfile: ResolvedContentResearchProfile } | { error: string } {
  const agent = agentId ?? "gemini";
  if (agent === "gemini") {
    const envBin = process.env["ANTIGRAVITY_BIN"];
    const bin = envBin ?? "agy";
    const cmdSource: ResolvedContentResearchProfile["cmdSource"] = envBin ? "env" : "cli-default";
    const modelSource: ResolvedContentResearchProfile["modelSource"] = model ? "session-config" : "cli-default";
    const argv: string[] = model ? ["--model", model, "--print"] : ["--print"];
    const resolvedProfile: ResolvedContentResearchProfile = {
      phase: "content_research",
      agentId: agent,
      cmd: bin,
      argv,
      cmdSource,
      modelSource,
      ...(model ? { model } : {}),
    };
    return { cmd: bin, args: argv, resolvedProfile };
  }
  return { error: `Unsupported content research agent: ${agent}. Supported: gemini` };
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

function classifyOutcome(
  stdout: string,
  stderr: string,
  exitCode: number,
  isQuotaExhaustion: boolean,
): ContentResearchOutcome {
  if (isQuotaExhaustion) return "quota/rate-limit";
  if (exitCode !== 0) return "command-failure";
  if (!stdout.trim()) return "malformed";
  return "valid";
}

// ---------------------------------------------------------------------------
// Path safety guard
// ---------------------------------------------------------------------------

// Validate using resolved paths so that a run ID containing traversal segments
// (e.g. "../../tmp/escape") cannot escape the artifact root after path.join()
// normalizes away the ".." sequences. Requires a STRICT child of artifactRoot —
// a run ID that resolves to artifactRoot itself (e.g. ".", "x/..") must be
// rejected, since callers pass the shared `runs` directory as artifactRoot and
// an equal match would mean the handler writes directly into that shared
// directory rather than a per-run subdirectory.
function isSafeArtifactPath(artifactRoot: string, resolvedDir: string): boolean {
  const resolvedRoot = resolve(artifactRoot);
  const rel = relative(resolvedRoot, resolvedDir);
  return rel.length > 0 && !rel.startsWith("..");
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createContentResearchHandler(
  context: PhaseHandlerContext,
  runner: CommandRunner = defaultCommandRunner,
): PhaseHandler {
  return async (task: AiTask): Promise<PhaseHandlerResult> => {
    const { session, runId } = context;
    const artifactDir = runArtifactDir(session.artifactRoot, runId);

    // Reject unsafe output paths before any write — validate against the runs
    // subdirectory so a traversal run-id like "../other-run" that stays under
    // artifactRoot but escapes the runs/ tree is also rejected.
    if (!isSafeArtifactPath(join(session.artifactRoot, "runs"), artifactDir)) {
      return {
        result: "failed",
        error: "Content research cannot run: artifact path is unsafe",
      };
    }

    // Determine agent and command
    const agentId = agentForPhase(task, session, "research");
    const antigravityModel = session.research?.antigravity?.model;
    const cmdSpec = contentResearchCommand(agentId, antigravityModel);
    if ("error" in cmdSpec) {
      writeAssignmentFailureArtifact(artifactDir, {
        phase: "content_research",
        agentId,
        sessionId: task.sessionId,
        issueNumber: task.issueNumber,
        runId,
        error: cmdSpec.error,
      });
      return {
        result: "failed",
        error: cmdSpec.error,
        context: {
          artifactDir,
          [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true,
          assignmentError: { phase: "content_research", agent: agentId ?? null },
        },
      };
    }
    const resolvedProfile = cmdSpec.resolvedProfile;

    // Build prompt — title, URL, labels only; body is intentionally excluded
    // (see docs/content-research-mvp-contract.md §Input Contract)
    const prompt = buildPrompt(task);

    // Ensure artifact directory exists
    try {
      mkdirSync(artifactDir, { recursive: true });
    } catch (err) {
      // Log diagnostic locally; public error must be a fixed status value (contract §Output)
      console.error(`[content-research] artifact dir setup failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        result: "failed",
        context: { resolvedProfile },
        error: "content_research_setup_failed",
      };
    }

    // Re-validate immediately after creation, before any write or runner
    // invocation: mkdirSync's recursive existence check follows symlinks, so a
    // pre-planted symlink at runs/<run-id> makes mkdirSync succeed without
    // creating a real directory, letting the prompt/context writes below and
    // the agent's cwd escape the artifact root before the post-run check runs.
    if (!isSafeArtifactDirAfterRun(session.artifactRoot, artifactDir)) {
      return {
        result: "failed",
        context: { resolvedProfile },
        error: "content_research_setup_failed",
      };
    }

    // Write prompt artifact (local only — never forwarded to GitHub)
    const promptPath = join(artifactDir, "content-research-prompt.md");
    rejectSymlink(promptPath);
    writeFileSync(promptPath, prompt, "utf8");

    // Write the structured brief — pre-run record of the approved MVP inputs
    const ctx = task.context as Record<string, unknown>;
    const briefTitle = typeof ctx.title === "string" ? ctx.title : `Issue #${task.issueNumber}`;
    const briefUrl = typeof ctx.url === "string" ? ctx.url : null;
    const briefLabels = Array.isArray(ctx.labels) ? (ctx.labels as string[]) : [];
    const briefBodyPresent = typeof ctx.body === "string";
    const structuredBriefPath = join(artifactDir, "content-research-brief.json");
    rejectSymlink(structuredBriefPath);
    writeFileSync(
      structuredBriefPath,
      JSON.stringify(
        {
          issueNumber: task.issueNumber,
          sessionId: task.sessionId,
          runId,
          phase: "content_research",
          inputs: {
            title: briefTitle,
            url: briefUrl,
            labels: briefLabels,
            ...(briefBodyPresent ? { bodyBounded: true } : {}),
          },
          ...(briefBodyPresent ? {} : { inputsExcluded: ["body"] }),
          cwdPolicy: "artifact-dir",
        },
        null,
        2,
      ),
      "utf8",
    );

    // Write resolved agent profile before invoking the agent so interrupted/failed
    // runs still have a pre-run audit record of the intended billable profile
    const assignment = readResolvedAssignment(task);
    const contextPath = join(artifactDir, "content-research-context.json");
    rejectSymlink(contextPath);
    writeFileSync(
      contextPath,
      JSON.stringify(
        {
          issueNumber: task.issueNumber,
          sessionId: task.sessionId,
          runId,
          resolvedProfile,
          ...(assignment ? { assignment } : {}),
        },
        null,
        2,
      ),
      "utf8",
    );

    // Run the agent in the per-run artifact directory so any relative files it
    // creates are retained alongside the other run artifacts.
    const cmdResult = runner.run(cmdSpec.cmd, [...cmdSpec.args, prompt], {
      cwd: artifactDir,
      stdin: prompt,
    });

    // The agent ran with artifactDir as its cwd and could have replaced the
    // directory itself with a symlink to an external location; re-validate
    // before any post-run write follows a leaf path into it.
    if (!isSafeArtifactDirAfterRun(session.artifactRoot, artifactDir)) {
      return {
        result: "failed",
        context: { artifactDir },
        error: "content_research_artifact_dir_unsafe",
      };
    }

    // Raw stdout/stderr is persisted only in the local diagnostic artifact —
    // never forwarded to any GitHub-visible payload
    const diagnosticParts: string[] = [];
    if (cmdResult.stdout) diagnosticParts.push(cmdResult.stdout);
    if (cmdResult.stderr) diagnosticParts.push(`--- stderr ---\n${cmdResult.stderr}`);
    const outputPath = join(artifactDir, "content-research-output.md");
    rejectSymlink(outputPath);
    writeFileSync(outputPath, diagnosticParts.join("\n"), "utf8");

    // Classify quota exhaustion before determining outcome
    const quotaClassification =
      cmdResult.exitCode !== 0
        ? classifyQuotaExhaustion(extractAgentFailureDiagnostic(resolvedProfile.agentId, cmdResult, { cmdSource: resolvedProfile.cmdSource }))
        : { isQuotaExhaustion: false as const };

    const outcome = classifyOutcome(
      cmdResult.stdout,
      cmdResult.stderr,
      cmdResult.exitCode,
      quotaClassification.isQuotaExhaustion,
    );

    // success is true ONLY for the "valid" outcome — invalid output never
    // leaves an artifact marked successful
    const resultJson = {
      issueNumber: task.issueNumber,
      sessionId: task.sessionId,
      runId,
      agentId,
      exitCode: cmdResult.exitCode,
      success: outcome === "valid",
      outcome,
      ...(quotaClassification.isQuotaExhaustion
        ? { delayed: true, quotaSignal: quotaClassification.signal }
        : {}),
      artifactDir,
      resolvedProfile,
    };
    const resultPath = join(artifactDir, "content-research-result.json");
    rejectSymlink(resultPath);
    writeFileSync(resultPath, JSON.stringify(resultJson, null, 2), "utf8");

    if (quotaClassification.isQuotaExhaustion) {
      return {
        result: "delayed",
        context: {
          // Preserve original issue context so the retry prompt rebuilds with
          // the real title/URL/labels/body rather than the fallback "Issue #N".
          ...task.context,
          artifactDir,
          // issue #611 review: `...task.context` above can carry a stale
          // `artifactDirPending: true` forward from an earlier failed run on
          // this task, but `artifactDir` is overridden to THIS run's own,
          // just-created-and-validated directory in the same patch — assert
          // `false` explicitly so `applyTaskPatch`'s spread-aware auto-clear
          // (which only fires when a patch omits this key outright) isn't
          // short-circuited by that carried-forward value.
          [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: false,
          resolvedProfile,
          outcome,
          quotaSignal: quotaClassification.signal,
          category: quotaClassification.category,
        },
        message: `Content research agent (${agentId}) hit a ${describeFailureCategory(quotaClassification.category)} condition (signal: "${quotaClassification.signal}"); delaying retry`,
        // Category-specific backoff (issue #671): rate_limit/provider_capacity
        // get a short transient retry, not the multi-hour usage_quota delay.
        retryAfterMs: resolveRetryDelayOverrideMsForCategory(quotaClassification.category),
        category: quotaClassification.category,
      };
    }

    if (outcome !== "valid") {
      // Public-safe error summary — raw stdout/stderr is in the local artifact only
      const publicError =
        outcome === "malformed"
          ? `Content research agent produced no usable output (exit code: ${cmdResult.exitCode})`
          : `Content research agent failed (exit code: ${cmdResult.exitCode})`;
      return {
        result: "failed",
        error: publicError,
        context: { artifactDir, resolvedProfile, outcome },
      };
    }

    // Write the validated brief for downstream consumers (e.g. content_draft).
    // Separate from the raw output artifact so downstream phases never consume
    // unvalidated agent output or stderr.
    const briefPath = join(artifactDir, "content-research-validated-brief.md");
    rejectSymlink(briefPath);
    writeFileSync(briefPath, cmdResult.stdout, "utf8");

    return {
      result: "success",
      context: {
        ...task.context,
        artifactDir,
        // issue #611 review: this run's own mkdirSync/isSafeArtifactDirAfterRun
        // sequence already succeeded above, so artifactDir now names a real
        // directory — clear any stale pending marker a prior failed run on
        // this task left on context.
        [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: false,
        contentResearchAgentUsed: agentId,
        resolvedProfile,
        outcome,
      },
    };
  };
}
