import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, realpathSync } from "fs";
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
// Result outcome (contract §Outcome enums)
// ---------------------------------------------------------------------------

export type ContentDraftOutcome =
  | "draft_complete"
  | "draft_failed"
  | "input_invalid";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BODY_CHAR_LIMIT = 4000;
const RESEARCH_CONTENT_CHAR_LIMIT = 8000;
const REVIEW_FIX_FEEDBACK_CHAR_LIMIT = 2000;

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

// Best-effort diagnostic write for preflight failure paths (input validation,
// unsupported agent) that run before the main mkdirSync/isSafeArtifactDirAfterRun
// re-validation sequence below. mkdirSync's recursive existence check follows
// symlinks, so without this the same pre-planted-symlink-at-runs/<run-id> attack
// that the main sequence guards against could redirect this diagnostic write
// outside artifactRoot. The original validation error is always returned to the
// caller regardless of whether this write succeeds.
function writeFailureResult(artifactDir: string, artifactRoot: string, resultJson: unknown): void {
  try {
    mkdirSync(artifactDir, { recursive: true });
    if (!isSafeArtifactDirAfterRun(artifactRoot, artifactDir)) return;
    const resultPath = join(artifactDir, "content-draft-result.json");
    rejectSymlink(resultPath);
    writeFileSync(resultPath, JSON.stringify(resultJson, null, 2), "utf8");
  } catch {
    // Best effort — the clear error is still returned even if the artifact write fails.
  }
}

// ---------------------------------------------------------------------------
// Path safety guard
// ---------------------------------------------------------------------------

// Requires a STRICT child of artifactRoot — a path that resolves to
// artifactRoot itself (e.g. a run ID of ".", "x/..") must be rejected, since
// callers pass the shared `runs` directory as artifactRoot and an equal match
// would mean the handler writes directly into that shared directory rather
// than a per-run subdirectory.
function isSafeArtifactPath(artifactRoot: string, resolvedDir: string): boolean {
  const resolvedRoot = resolve(artifactRoot);
  const rel = relative(resolvedRoot, resolvedDir);
  return rel.length > 0 && !rel.startsWith("..");
}

// ---------------------------------------------------------------------------
// Research brief resolver (input contract)
// ---------------------------------------------------------------------------

function resolveResearchBrief(
  task: AiTask,
  artifactRoot: string,
): { content: string } | { error: string } {
  const ctx = task.context as Record<string, unknown>;
  const researchArtifactDir = typeof ctx.artifactDir === "string" ? ctx.artifactDir : null;

  if (!researchArtifactDir) {
    return { error: "input_invalid: no research artifact dir in task context" };
  }

  // Validate the research artifact dir is under the session's artifact root
  // so a DB-injected path cannot read arbitrary files.
  const resolved = resolve(researchArtifactDir);
  if (!isSafeArtifactPath(artifactRoot, resolved)) {
    return { error: "input_invalid: research artifact dir is outside the artifact root" };
  }

  // Compute the real (symlink-resolved) artifact root once.  On systems where
  // the temp path passes through a symlink (e.g. macOS /var→/private/var),
  // resolve() and realpathSync() yield different prefixes; comparing a
  // realpathSync-resolved child against a resolve()-only root would fail even
  // for a legitimately nested path.
  let realArtifactRoot: string;
  try {
    realArtifactRoot = realpathSync(resolve(artifactRoot));
  } catch {
    realArtifactRoot = resolve(artifactRoot);
  }

  // Reject symlinked artifact directories — resolve() only normalises the path
  // lexically; realpathSync follows any symlinks so the boundary check sees the
  // true on-disk location.
  let realArtifactDir: string;
  try {
    realArtifactDir = realpathSync(resolved);
  } catch {
    return { error: "input_invalid: research artifact dir cannot be resolved" };
  }
  if (!isSafeArtifactPath(realArtifactRoot, realArtifactDir)) {
    return { error: "input_invalid: research artifact dir is outside the artifact root" };
  }

  // Validate the research result before consuming the output.
  const resultPath = join(realArtifactDir, "content-research-result.json");
  if (!existsSync(resultPath)) {
    return { error: "input_invalid: research result artifact not found" };
  }

  // Reject symlinked result files that could redirect reads outside the root.
  let realResultPath: string;
  try {
    realResultPath = realpathSync(resultPath);
  } catch {
    return { error: "input_invalid: research result artifact cannot be resolved" };
  }
  if (!isSafeArtifactPath(realArtifactRoot, realResultPath)) {
    return { error: "input_invalid: research result artifact is outside the artifact root" };
  }

  let resultData: Record<string, unknown>;
  try {
    resultData = JSON.parse(readFileSync(realResultPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { error: "input_invalid: research result artifact is malformed" };
  }

  if (resultData.outcome !== "valid" || resultData.success !== true) {
    return { error: "input_invalid: research did not produce a valid outcome" };
  }

  if (typeof resultData.issueNumber !== "number") {
    return { error: "input_invalid: research result artifact missing issueNumber" };
  }
  if (resultData.issueNumber !== task.issueNumber) {
    return { error: "input_invalid: research result issueNumber does not match current task" };
  }
  if (typeof resultData.sessionId !== "string") {
    return { error: "input_invalid: research result artifact missing sessionId" };
  }
  if (resultData.sessionId !== task.sessionId) {
    return { error: "input_invalid: research result sessionId does not match current task" };
  }

  // Consume the validated brief — written by the research handler only after
  // the outcome is confirmed "valid". This is NOT the raw output artifact.
  const briefPath = join(realArtifactDir, "content-research-validated-brief.md");
  if (!existsSync(briefPath)) {
    return { error: "input_invalid: research validated brief not found" };
  }

  // Reject symlinked brief files that could redirect reads outside the root.
  let realBriefPath: string;
  try {
    realBriefPath = realpathSync(briefPath);
  } catch {
    return { error: "input_invalid: research validated brief cannot be resolved" };
  }
  if (!isSafeArtifactPath(realArtifactRoot, realBriefPath)) {
    return { error: "input_invalid: research validated brief is outside the artifact root" };
  }

  let content: string;
  try {
    content = readFileSync(realBriefPath, "utf8");
  } catch {
    return { error: "input_invalid: research validated brief could not be read" };
  }

  if (!content.trim()) {
    return { error: "input_invalid: research validated brief is empty" };
  }

  // Bound research content to avoid token overruns.
  const bounded =
    content.length > RESEARCH_CONTENT_CHAR_LIMIT
      ? content.slice(0, RESEARCH_CONTENT_CHAR_LIMIT) + "\n<!-- research content truncated -->"
      : content;

  return { content: bounded };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(task: AiTask, researchContent: string): string {
  const ctx = task.context as Record<string, unknown>;
  const title = typeof ctx.title === "string" ? ctx.title : `Issue #${task.issueNumber}`;
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

  // Include bounded editorial fix feedback from a prior content_review run when present.
  const rawFixFeedback = typeof ctx.reviewFixFeedback === "string" ? ctx.reviewFixFeedback : null;
  const fixFeedbackText =
    rawFixFeedback !== null
      ? rawFixFeedback.length > REVIEW_FIX_FEEDBACK_CHAR_LIMIT
        ? rawFixFeedback.slice(0, REVIEW_FIX_FEEDBACK_CHAR_LIMIT) + "\n<!-- feedback truncated -->"
        : rawFixFeedback
      : null;
  const fixFeedbackSection =
    fixFeedbackText !== null
      ? [
          "",
          "## Previous Review Feedback",
          "<!-- begin:review-fix-feedback-input -->",
          fixFeedbackText,
          "<!-- end:review-fix-feedback-input -->",
        ].join("\n")
      : "";

  return [
    `# Content Draft Task — Issue #${task.issueNumber}`,
    "",
    `**Title**: ${title}${bodySection}`,
    "",
    "## Research Findings",
    "<!-- begin:research-brief-input -->",
    researchContent,
    "<!-- end:research-brief-input -->",
    ...(fixFeedbackSection ? [fixFeedbackSection] : []),
    "",
    "## Instructions",
    "",
    "Using the issue request and research findings above, produce a structured article draft.",
    ...(fixFeedbackText
      ? ["Address the Previous Review Feedback section above in this revised draft."]
      : []),
    "Do NOT include credentials, tokens, secrets, or private URLs in your output.",
    "Do NOT reference local filesystem paths in your output.",
    "Do NOT modify any files.",
    "Produce a structured markdown draft including:",
    "- Title suggestions (at least one primary, optional alternates)",
    "- Summary / abstract",
    "- Main body sections",
    "- Optional social excerpt if the issue requests one",
    "Preserve uncertain claims explicitly rather than inventing unsupported facts.",
    "Include editorial notes, TODOs, or fact-check flags where appropriate.",
    "The draft is for a human editor, not for auto-publication.",
    "Output your draft as structured markdown.",
    "",
    "After the draft, add a ## Self-Review section covering:",
    "- Claims you could not verify against the research findings above",
    "- Editorial TODOs or fact-check flags for the human editor",
    "- Sections that need expansion, revision, or additional sources",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Command selection
// ---------------------------------------------------------------------------

export interface ResolvedContentDraftProfile {
  phase: "content_draft";
  agentId: string;
  cmd: string;
  /** Sanitized argv — excludes prompt content (passed as positional arg and stdin). */
  argv: string[];
  cmdSource: "env" | "cli-default";
  modelSource: "cli-default" | "session-config";
  /** Configured Antigravity model name, present only when modelSource is "session-config". */
  model?: string;
}

function contentDraftCommand(
  agentId: string | undefined,
  model: string | undefined,
): { cmd: string; args: string[]; resolvedProfile: ResolvedContentDraftProfile } | { error: string } {
  const agent = agentId ?? "gemini";
  if (agent === "gemini") {
    const envBin = process.env["ANTIGRAVITY_BIN"];
    const bin = envBin ?? "agy";
    const cmdSource: ResolvedContentDraftProfile["cmdSource"] = envBin ? "env" : "cli-default";
    const modelSource: ResolvedContentDraftProfile["modelSource"] = model ? "session-config" : "cli-default";
    const argv: string[] = model ? ["--model", model, "--print"] : ["--print"];
    const resolvedProfile: ResolvedContentDraftProfile = {
      phase: "content_draft",
      agentId: agent,
      cmd: bin,
      argv,
      cmdSource,
      modelSource,
      ...(model ? { model } : {}),
    };
    return { cmd: bin, args: argv, resolvedProfile };
  }
  return { error: `Unsupported content draft agent: ${agent}. Supported: gemini` };
}

// ---------------------------------------------------------------------------
// Output classification
// ---------------------------------------------------------------------------

function classifyDraftOutcome(
  stdout: string,
  exitCode: number,
  isQuotaExhaustion: boolean,
): ContentDraftOutcome {
  if (isQuotaExhaustion) return "draft_failed";
  if (exitCode !== 0) return "draft_failed";
  if (!stdout.trim()) return "draft_failed";
  if (!stdout.includes("## Self-Review")) return "draft_failed";
  return "draft_complete";
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createContentDraftHandler(
  context: PhaseHandlerContext,
  runner: CommandRunner = defaultCommandRunner,
): PhaseHandler {
  return async (task: AiTask): Promise<PhaseHandlerResult> => {
    const { session, runId } = context;
    const artifactDir = runArtifactDir(session.artifactRoot, runId);

    // Reject unsafe output paths before any write.
    if (!isSafeArtifactPath(join(session.artifactRoot, "runs"), artifactDir)) {
      return {
        result: "failed",
        error: "Content draft cannot run: artifact path is unsafe",
      };
    }

    // Resolve and validate the research brief (input contract).
    const researchResult = resolveResearchBrief(task, session.artifactRoot);
    if ("error" in researchResult) {
      // Write the local result record so operators can diagnose validation failures.
      writeFailureResult(artifactDir, session.artifactRoot, {
        issueNumber: task.issueNumber,
        sessionId: task.sessionId,
        runId,
        success: false,
        outcome: "input_invalid" as ContentDraftOutcome,
        artifactDir,
      });
      return {
        result: "failed",
        error: researchResult.error,
        context: {
          artifactDir,
          [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true,
          outcome: "input_invalid" as ContentDraftOutcome,
        },
      };
    }

    // Determine agent and command.
    const agentId = agentForPhase(task, session, "research");
    const antigravityModel = session.research?.antigravity?.model;
    const cmdSpec = contentDraftCommand(agentId, antigravityModel);
    if ("error" in cmdSpec) {
      writeAssignmentFailureArtifact(artifactDir, {
        phase: "content_draft",
        agentId,
        sessionId: task.sessionId,
        issueNumber: task.issueNumber,
        runId,
        error: cmdSpec.error,
      });
      writeFailureResult(artifactDir, session.artifactRoot, {
        issueNumber: task.issueNumber,
        sessionId: task.sessionId,
        runId,
        success: false,
        outcome: "draft_failed" as ContentDraftOutcome,
        artifactDir,
      });
      return {
        result: "failed",
        error: cmdSpec.error,
        context: {
          artifactDir,
          [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true,
          assignmentError: { phase: "content_draft", agent: agentId ?? null },
        },
      };
    }
    const resolvedProfile = cmdSpec.resolvedProfile;

    // Build prompt — bounded issue fields + validated research brief.
    const prompt = buildPrompt(task, researchResult.content);

    // Ensure artifact directory exists.
    try {
      mkdirSync(artifactDir, { recursive: true });
    } catch (err) {
      // Log diagnostic locally; public error must be a fixed status value (contract §Output).
      console.error(
        `[content-draft] artifact dir setup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        result: "failed",
        context: { resolvedProfile },
        error: "content_draft_setup_failed",
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
        error: "content_draft_setup_failed",
      };
    }

    // Write prompt artifact (local only — never forwarded to GitHub).
    writeFileSync(join(artifactDir, "content-draft-prompt.md"), prompt, "utf8");

    // Write resolved agent profile before invoking the agent so interrupted/failed
    // runs still have a pre-run audit record of the intended billable profile.
    const assignment = readResolvedAssignment(task);
    writeFileSync(
      join(artifactDir, "content-draft-context.json"),
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
        error: "content_draft_artifact_dir_unsafe",
      };
    }

    // content-draft-output.md is the validated draft artifact consumed
    // downstream by content_review (contract §Required artifacts) — it must
    // contain only the agent's stdout, never stderr warnings/diagnostics, or a
    // successful run with noisy stderr would inject unvalidated diagnostic text
    // into the review prompt. Stderr is captured separately, local-only.
    const outputPath = join(artifactDir, "content-draft-output.md");
    rejectSymlink(outputPath);
    writeFileSync(outputPath, cmdResult.stdout, "utf8");

    if (cmdResult.stderr) {
      const diagnosticPath = join(artifactDir, "content-draft-diagnostic.md");
      rejectSymlink(diagnosticPath);
      writeFileSync(diagnosticPath, cmdResult.stderr, "utf8");
    }

    // Classify quota exhaustion before determining outcome.
    const quotaClassification =
      cmdResult.exitCode !== 0
        ? classifyQuotaExhaustion(extractAgentFailureDiagnostic(resolvedProfile.agentId, cmdResult, { cmdSource: resolvedProfile.cmdSource }))
        : { isQuotaExhaustion: false as const };

    const outcome = classifyDraftOutcome(
      cmdResult.stdout,
      cmdResult.exitCode,
      quotaClassification.isQuotaExhaustion,
    );

    // success is true ONLY for the "draft_complete" outcome.
    const resultJson = {
      issueNumber: task.issueNumber,
      sessionId: task.sessionId,
      runId,
      agentId,
      exitCode: cmdResult.exitCode,
      success: outcome === "draft_complete",
      outcome,
      ...(quotaClassification.isQuotaExhaustion
        ? { delayed: true, quotaSignal: quotaClassification.signal }
        : {}),
      artifactDir,
      resolvedProfile,
    };
    const resultPath = join(artifactDir, "content-draft-result.json");
    rejectSymlink(resultPath);
    writeFileSync(resultPath, JSON.stringify(resultJson, null, 2), "utf8");

    if (quotaClassification.isQuotaExhaustion) {
      return {
        result: "delayed",
        context: {
          // Preserve original issue context so the retry prompt rebuilds with
          // the real title/URL/labels/body rather than the fallback "Issue #N".
          // Keep task.context.artifactDir (the upstream research artifact dir)
          // intact so resolveResearchBrief finds content-research-result.json
          // on the next attempt. Store the draft run dir under a separate key.
          ...task.context,
          draftArtifactDir: artifactDir,
          resolvedProfile,
          outcome,
          quotaSignal: quotaClassification.signal,
          category: quotaClassification.category,
        },
        message: `Content draft agent (${agentId}) hit a ${describeFailureCategory(quotaClassification.category)} condition (signal: "${quotaClassification.signal}"); delaying retry`,
        retryAfterMs: resolveRetryDelayOverrideMsForCategory(quotaClassification.category),
        category: quotaClassification.category,
      };
    }

    if (outcome !== "draft_complete") {
      // Public-safe error summary — raw stdout/stderr is in the local artifact only.
      const publicError = `Content draft agent failed (exit code: ${cmdResult.exitCode})`;
      return {
        result: "failed",
        error: publicError,
        context: { artifactDir, resolvedProfile, outcome },
      };
    }

    // Preserve the upstream research artifact dir under a stable key so the
    // content_review phase can locate the validated research brief without
    // re-resolving it from the (now-overwritten) artifactDir context key.
    const researchArtifactDir =
      typeof (task.context as Record<string, unknown>).artifactDir === "string"
        ? (task.context as Record<string, unknown>).artifactDir
        : undefined;

    return {
      result: "success",
      context: {
        ...(researchArtifactDir !== undefined ? { researchArtifactDir } : {}),
        artifactDir,
        contentDraftAgentUsed: agentId,
        resolvedProfile,
        outcome,
      },
    };
  };
}
