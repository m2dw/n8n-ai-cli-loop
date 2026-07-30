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

export type ContentReviewOutcome = "success" | "needs_fix" | "blocked";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BODY_CHAR_LIMIT = 4000;
const DRAFT_CONTENT_CHAR_LIMIT = 12000;
const RESEARCH_CONTENT_CHAR_LIMIT = 6000;

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
// outside artifactRoot. The original validation error/message is always
// returned to the caller regardless of whether this write succeeds.
function writeFailureResult(artifactDir: string, artifactRoot: string, resultJson: unknown): void {
  try {
    mkdirSync(artifactDir, { recursive: true });
    if (!isSafeArtifactDirAfterRun(artifactRoot, artifactDir)) return;
    const resultPath = join(artifactDir, "content-review-result.json");
    rejectSymlink(resultPath);
    writeFileSync(resultPath, JSON.stringify(resultJson, null, 2), "utf8");
  } catch {
    // Best effort.
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
// Real path helper — resolves symlinks, falls back to lexical resolve on error
// ---------------------------------------------------------------------------

function safeRealpathSync(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Draft artifact resolver (input contract §Validated draft artifact)
// ---------------------------------------------------------------------------

function resolveDraftArtifact(
  task: AiTask,
  artifactRoot: string,
): { content: string; artifactDir: string } | { error: string } {
  const ctx = task.context as Record<string, unknown>;
  const draftArtifactDir = typeof ctx.artifactDir === "string" ? ctx.artifactDir : null;

  if (!draftArtifactDir) {
    return { error: "input_invalid: no draft artifact dir in task context" };
  }

  const resolvedDir = resolve(draftArtifactDir);
  if (!isSafeArtifactPath(artifactRoot, resolvedDir)) {
    return { error: "input_invalid: draft artifact dir is outside the artifact root" };
  }

  let realArtifactRoot: string;
  try {
    realArtifactRoot = realpathSync(resolve(artifactRoot));
  } catch {
    realArtifactRoot = resolve(artifactRoot);
  }

  const realArtifactDir = safeRealpathSync(resolvedDir);
  if (realArtifactDir === null) {
    return { error: "input_invalid: draft artifact dir cannot be resolved" };
  }
  if (!isSafeArtifactPath(realArtifactRoot, realArtifactDir)) {
    return { error: "input_invalid: draft artifact dir is outside the artifact root" };
  }

  // Validate the draft result before consuming the output.
  const resultPath = join(realArtifactDir, "content-draft-result.json");
  if (!existsSync(resultPath)) {
    return { error: "input_invalid: draft result artifact not found" };
  }

  const realResultPath = safeRealpathSync(resultPath);
  if (realResultPath === null) {
    return { error: "input_invalid: draft result artifact cannot be resolved" };
  }
  if (!isSafeArtifactPath(realArtifactRoot, realResultPath)) {
    return { error: "input_invalid: draft result artifact is outside the artifact root" };
  }

  let resultData: Record<string, unknown>;
  try {
    resultData = JSON.parse(readFileSync(realResultPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { error: "input_invalid: draft result artifact is malformed" };
  }

  if (resultData.outcome !== "draft_complete" || resultData.success !== true) {
    return { error: "input_invalid: draft did not produce a draft_complete outcome" };
  }

  if (typeof resultData.issueNumber !== "number") {
    return { error: "input_invalid: draft result artifact missing issueNumber" };
  }
  if (resultData.issueNumber !== task.issueNumber) {
    return { error: "input_invalid: draft result issueNumber does not match current task" };
  }
  if (typeof resultData.sessionId !== "string") {
    return { error: "input_invalid: draft result artifact missing sessionId" };
  }
  if (resultData.sessionId !== task.sessionId) {
    return { error: "input_invalid: draft result sessionId does not match current task" };
  }

  // Consume the validated draft output — written by the draft handler only after
  // the outcome is confirmed "draft_complete". This is the artifact to review.
  const outputPath = join(realArtifactDir, "content-draft-output.md");
  if (!existsSync(outputPath)) {
    return { error: "input_invalid: draft output artifact not found" };
  }

  const realOutputPath = safeRealpathSync(outputPath);
  if (realOutputPath === null) {
    return { error: "input_invalid: draft output artifact cannot be resolved" };
  }
  if (!isSafeArtifactPath(realArtifactRoot, realOutputPath)) {
    return { error: "input_invalid: draft output artifact is outside the artifact root" };
  }

  let content: string;
  try {
    content = readFileSync(realOutputPath, "utf8");
  } catch {
    return { error: "input_invalid: draft output artifact could not be read" };
  }

  if (!content.trim()) {
    return { error: "input_invalid: draft output artifact is empty" };
  }

  const bounded =
    content.length > DRAFT_CONTENT_CHAR_LIMIT
      ? content.slice(0, DRAFT_CONTENT_CHAR_LIMIT) + "\n<!-- draft content truncated -->"
      : content;

  return { content: bounded, artifactDir: realArtifactDir };
}

// ---------------------------------------------------------------------------
// Research brief resolver — optional input (contract §Validated research brief)
// ---------------------------------------------------------------------------

function resolveResearchBrief(
  task: AiTask,
  artifactRoot: string,
): { content: string } | { skipped: true } | { error: string } {
  const ctx = task.context as Record<string, unknown>;
  const researchArtifactDir = typeof ctx.researchArtifactDir === "string" ? ctx.researchArtifactDir : null;

  if (!researchArtifactDir) {
    return { skipped: true };
  }

  const resolvedDir = resolve(researchArtifactDir);
  if (!isSafeArtifactPath(artifactRoot, resolvedDir)) {
    return { error: "input_invalid: research artifact dir is outside the artifact root" };
  }

  let realArtifactRoot: string;
  try {
    realArtifactRoot = realpathSync(resolve(artifactRoot));
  } catch {
    realArtifactRoot = resolve(artifactRoot);
  }

  const realArtifactDir = safeRealpathSync(resolvedDir);
  if (realArtifactDir === null) {
    return { skipped: true };
  }
  if (!isSafeArtifactPath(realArtifactRoot, realArtifactDir)) {
    return { error: "input_invalid: research artifact dir is outside the artifact root" };
  }

  // Validate the research result record before consuming the brief — mirrors
  // resolveDraftArtifact's validation above. Without this, a stale or manually
  // recovered task context could feed another issue's (or invalid) research
  // into the review (issue #603 review follow-up). The research brief is an
  // optional input, so any validation failure here is a skip, not an error.
  const resultPath = join(realArtifactDir, "content-research-result.json");
  if (!existsSync(resultPath)) {
    return { skipped: true };
  }

  const realResultPath = safeRealpathSync(resultPath);
  if (realResultPath === null || !isSafeArtifactPath(realArtifactRoot, realResultPath)) {
    return { skipped: true };
  }

  let resultData: Record<string, unknown>;
  try {
    resultData = JSON.parse(readFileSync(realResultPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { skipped: true };
  }

  if (resultData.outcome !== "valid" || resultData.success !== true) {
    return { skipped: true };
  }
  if (typeof resultData.issueNumber !== "number" || resultData.issueNumber !== task.issueNumber) {
    return { skipped: true };
  }
  if (typeof resultData.sessionId !== "string" || resultData.sessionId !== task.sessionId) {
    return { skipped: true };
  }

  const briefPath = join(realArtifactDir, "content-research-validated-brief.md");
  if (!existsSync(briefPath)) {
    return { skipped: true };
  }

  const realBriefPath = safeRealpathSync(briefPath);
  if (realBriefPath === null || !isSafeArtifactPath(realArtifactRoot, realBriefPath)) {
    return { skipped: true };
  }

  let content: string;
  try {
    content = readFileSync(realBriefPath, "utf8");
  } catch {
    return { skipped: true };
  }

  if (!content.trim()) {
    return { skipped: true };
  }

  const bounded =
    content.length > RESEARCH_CONTENT_CHAR_LIMIT
      ? content.slice(0, RESEARCH_CONTENT_CHAR_LIMIT) + "\n<!-- research content truncated -->"
      : content;

  return { content: bounded };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(task: AiTask, draftContent: string, researchContent: string | null): string {
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

  const researchSection =
    researchContent !== null
      ? [
          "",
          "## Research Brief",
          "<!-- begin:research-brief-input -->",
          researchContent,
          "<!-- end:research-brief-input -->",
        ].join("\n")
      : "";

  return [
    `# Content Review Task — Issue #${task.issueNumber}`,
    "",
    `**Title**: ${title}${bodySection}`,
    ...(researchSection ? [researchSection] : []),
    "",
    "## Draft Content",
    "<!-- begin:draft-content-input -->",
    draftContent,
    "<!-- end:draft-content-input -->",
    "",
    "## Review Instructions",
    "",
    "You are performing an editorial review of the draft above against the original issue request.",
    "Do NOT include credentials, tokens, secrets, or private URLs in your output.",
    "Do NOT reference local filesystem paths in your output.",
    "Do NOT modify any files.",
    "",
    "Evaluate the draft on the following criteria and produce an ## Editorial Findings section:",
    "",
    "1. **Factual accuracy / source support** — Are claims supported by the research brief? Flag unsupported claims explicitly.",
    "2. **Private information or local path leakage** — Does the draft contain private paths, credentials, tokens, or internal references that must not appear in published content?",
    "3. **Overclaiming / marketing exaggeration** — Does the draft make claims that go beyond what the research supports?",
    "4. **Reader fit and structure** — Is the structure logical and appropriate for the intended audience?",
    "5. **Missing caveats or unanswered questions** — Are there gaps that should be addressed before publication?",
    "6. **Title/body mismatch** — Does the draft title match the body content?",
    "",
    "For each finding, label it as BLOCKING (must be fixed before publication) or ADVISORY (recommended improvement).",
    "",
    "Then produce a ## Review Outcome section with exactly one of:",
    "- `## Review Outcome: PASS` — when there are NO BLOCKING findings",
    "- `## Review Outcome: NEEDS_FIX` — when one or more BLOCKING findings require revision",
    "",
    "Output format:",
    "",
    "## Editorial Findings",
    "<list all findings with BLOCKING or ADVISORY labels>",
    "",
    "## Review Outcome: PASS",
    "(or ## Review Outcome: NEEDS_FIX)",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Command selection
// ---------------------------------------------------------------------------

export interface ResolvedContentReviewProfile {
  phase: "content_review";
  agentId: string;
  cmd: string;
  /** Sanitized argv — excludes prompt content (passed as positional arg and stdin). */
  argv: string[];
  cmdSource: "env" | "cli-default";
  modelSource: "cli-default" | "session-config";
  /** Configured Antigravity model name, present only when modelSource is "session-config". */
  model?: string;
}

function contentReviewCommand(
  agentId: string | undefined,
  model: string | undefined,
): { cmd: string; args: string[]; resolvedProfile: ResolvedContentReviewProfile } | { error: string } {
  const agent = agentId ?? "gemini";
  if (agent === "gemini") {
    const envBin = process.env["ANTIGRAVITY_BIN"];
    const bin = envBin ?? "agy";
    const cmdSource: ResolvedContentReviewProfile["cmdSource"] = envBin ? "env" : "cli-default";
    const modelSource: ResolvedContentReviewProfile["modelSource"] = model ? "session-config" : "cli-default";
    const argv: string[] = model ? ["--model", model, "--print"] : ["--print"];
    const resolvedProfile: ResolvedContentReviewProfile = {
      phase: "content_review",
      agentId: agent,
      cmd: bin,
      argv,
      cmdSource,
      modelSource,
      ...(model ? { model } : {}),
    };
    return { cmd: bin, args: argv, resolvedProfile };
  }
  return { error: `Unsupported content review agent: ${agent}. Supported: gemini` };
}

// ---------------------------------------------------------------------------
// Output classification
// ---------------------------------------------------------------------------

// Extracts the body of the mandated "## Editorial Findings" section (everything
// up to the next "## " heading or end of output). Returns null when the section
// is absent or empty — used to reject truncated/malformed/prompt-influenced
// output before it can be classified as a passing review.
function extractEditorialFindingsSection(stdout: string): string | null {
  const findingsMatch = stdout.match(/## Editorial Findings\n([\s\S]*?)(?=\n## |$)/);
  const findings = findingsMatch ? findingsMatch[1].trim() : "";
  return findings.length > 0 ? findings : null;
}

// Matches a finding line labelled BLOCKING per the prompt's required format,
// including common list/Markdown variants a reviewer may emit:
// "- BLOCKING: ...", "1. BLOCKING: ...", "- **BLOCKING**: ...". Deliberately
// anchored to the label position so prose that merely mentions the word
// ("No blocking issues found.") does not false-positive as an actual finding.
const BLOCKING_LABEL_RE = /^(?:[-*+]\s*|\d+[.)]\s*)?(?:\*\*|__)?BLOCKING(?:\*\*|__)?\s*:/i;

function findingsBlockingLines(findings: string): string[] {
  return findings
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => BLOCKING_LABEL_RE.test(l));
}

function classifyReviewOutcome(
  stdout: string,
  exitCode: number,
  isQuotaExhaustion: boolean,
): ContentReviewOutcome {
  if (isQuotaExhaustion) return "blocked";
  if (exitCode !== 0) return "blocked";
  if (!stdout.trim()) return "blocked";
  const hasPass = stdout.includes("## Review Outcome: PASS");
  const hasFix = stdout.includes("## Review Outcome: NEEDS_FIX");
  // Require exactly one outcome marker; ambiguity (both present) fails closed.
  if (hasFix && !hasPass) {
    const findings = extractEditorialFindingsSection(stdout);
    // A NEEDS_FIX is only actionable when it is backed by the mandated
    // Editorial Findings section containing at least one BLOCKING finding.
    // Truncated or malformed output that reaches only
    // "## Review Outcome: NEEDS_FIX" without that section must not be
    // accepted as a real revision request — it would send the next draft
    // "No blocking findings." and burn draft/review cycles with no
    // actionable guidance.
    if (findings === null) return "blocked";
    if (findingsBlockingLines(findings).length === 0) return "blocked";
    return "needs_fix";
  }
  if (hasPass && !hasFix) {
    const findings = extractEditorialFindingsSection(stdout);
    // A PASS is only trustworthy when it is backed by the mandated Editorial
    // Findings section. Truncated, malformed, or prompt-influenced output that
    // reaches only "## Review Outcome: PASS" without that section — or with a
    // section that contradicts PASS by still listing a BLOCKING finding — must
    // not be allowed to skip editorial review and reach the human-ready handoff.
    if (findings === null) return "blocked";
    if (findingsBlockingLines(findings).length > 0) return "blocked";
    return "success";
  }
  return "blocked";
}

// ---------------------------------------------------------------------------
// Fix feedback extractor — normalized category/action signal for task context
// (contract §Fix Feedback Policy). Deliberately does not carry any blocking
// finding's source text: task context is not a local artifact, so the record
// must be a structured internal signal derived from the findings rather than
// a duplicate of them. Full findings remain in the local
// content-review-findings.md artifact only.
// ---------------------------------------------------------------------------

interface FixFeedbackCategory {
  id: string;
  keywords: RegExp;
  action: string;
}

// Mirrors the six review criteria in the editorial prompt (see
// contentReviewPrompt above). Matched by keyword only, in priority order;
// a line matching no keyword falls into the "other" bucket below.
const FIX_FEEDBACK_CATEGORIES: FixFeedbackCategory[] = [
  {
    id: "accuracy",
    keywords: /factual|accuracy|unsupported|source|citation|evidence/i,
    action: "Verify flagged claims against the research brief; cite or remove unsupported claims.",
  },
  {
    id: "leakage",
    keywords: /private|leak|credential|token|secret|local path|internal reference/i,
    action: "Remove private paths, credentials, tokens, or internal references from the draft.",
  },
  {
    id: "overclaiming",
    keywords: /overclaim|exaggerat|marketing|hype/i,
    action: "Tone down claims that go beyond what the research supports.",
  },
  {
    id: "structure",
    keywords: /structure|reader fit|audience|organi[sz]ation|\bflow\b/i,
    action: "Revise structure and organization for the intended audience.",
  },
  {
    id: "gaps",
    keywords: /caveat|gap|missing|unanswered/i,
    action: "Add the missing caveats or address the unanswered questions.",
  },
  {
    id: "title_mismatch",
    keywords: /title/i,
    action: "Align the title with the body content.",
  },
];

const OTHER_FIX_FEEDBACK_CATEGORY: FixFeedbackCategory = {
  id: "other",
  keywords: /(?:)/,
  action: "Revise per the local editorial findings artifact.",
};

function categorizeBlockingLine(line: string): FixFeedbackCategory {
  return FIX_FEEDBACK_CATEGORIES.find((c) => c.keywords.test(line)) ?? OTHER_FIX_FEEDBACK_CATEGORY;
}

function extractFixFeedback(stdout: string): string {
  const findings = extractEditorialFindingsSection(stdout) ?? "";
  const blockingLines = findingsBlockingLines(findings);

  if (blockingLines.length === 0) {
    return "No blocking findings.";
  }

  const counts = new Map<string, number>();
  for (const line of blockingLines) {
    const category = categorizeBlockingLine(line);
    counts.set(category.id, (counts.get(category.id) ?? 0) + 1);
  }

  const lines = [`${blockingLines.length} BLOCKING finding(s).`];
  for (const category of [...FIX_FEEDBACK_CATEGORIES, OTHER_FIX_FEEDBACK_CATEGORY]) {
    const count = counts.get(category.id);
    if (!count) continue;
    lines.push(`- ${category.id} (${count}): ${category.action}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createContentReviewHandler(
  context: PhaseHandlerContext,
  runner: CommandRunner = defaultCommandRunner,
): PhaseHandler {
  return async (task: AiTask): Promise<PhaseHandlerResult> => {
    const { session, runId } = context;
    const artifactDir = runArtifactDir(session.artifactRoot, runId);

    if (!isSafeArtifactPath(join(session.artifactRoot, "runs"), artifactDir)) {
      return {
        result: "failed",
        error: "Content review cannot run: artifact path is unsafe",
      };
    }

    // Resolve and validate the draft artifact (required input).
    const draftResult = resolveDraftArtifact(task, session.artifactRoot);
    if ("error" in draftResult) {
      writeFailureResult(artifactDir, session.artifactRoot, {
        issueNumber: task.issueNumber,
        runId,
        success: false,
        outcome: "blocked" as ContentReviewOutcome,
        readyForHuman: false,
        artifactDir,
      });
      return {
        result: "blocked",
        message: draftResult.error,
        context: {
          artifactDir,
          [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true,
          outcome: "blocked" as ContentReviewOutcome,
        },
      };
    }

    // Resolve the optional research brief.
    const researchResult = resolveResearchBrief(task, session.artifactRoot);
    if ("error" in researchResult) {
      writeFailureResult(artifactDir, session.artifactRoot, {
        issueNumber: task.issueNumber,
        runId,
        success: false,
        outcome: "blocked" as ContentReviewOutcome,
        readyForHuman: false,
        artifactDir,
      });
      return {
        result: "blocked",
        message: researchResult.error,
        context: {
          artifactDir,
          [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true,
          outcome: "blocked" as ContentReviewOutcome,
        },
      };
    }

    const researchContent = "skipped" in researchResult ? null : researchResult.content;

    // Determine agent and command.
    const agentId = agentForPhase(task, session, "research");
    const antigravityModel = session.research?.antigravity?.model;
    const cmdSpec = contentReviewCommand(agentId, antigravityModel);
    if ("error" in cmdSpec) {
      writeAssignmentFailureArtifact(artifactDir, {
        phase: "content_review",
        agentId,
        sessionId: task.sessionId,
        issueNumber: task.issueNumber,
        runId,
        error: cmdSpec.error,
      });
      writeFailureResult(artifactDir, session.artifactRoot, {
        issueNumber: task.issueNumber,
        runId,
        success: false,
        outcome: "blocked" as ContentReviewOutcome,
        readyForHuman: false,
        artifactDir,
      });
      return {
        result: "failed",
        error: cmdSpec.error,
        context: {
          artifactDir,
          [ARTIFACT_DIR_PENDING_CONTEXT_FIELD]: true,
          assignmentError: { phase: "content_review", agent: agentId ?? null },
        },
      };
    }
    const resolvedProfile = cmdSpec.resolvedProfile;

    // Build prompt — bounded issue fields + validated draft + optional research brief.
    const prompt = buildPrompt(task, draftResult.content, researchContent);

    // Ensure artifact directory exists.
    try {
      mkdirSync(artifactDir, { recursive: true });
    } catch (err) {
      console.error(
        `[content-review] artifact dir setup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        result: "failed",
        context: { resolvedProfile },
        error: "content_review_setup_failed",
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
        error: "content_review_setup_failed",
      };
    }

    // Write prompt artifact (local only — never forwarded to GitHub).
    writeFileSync(join(artifactDir, "content-review-prompt.md"), prompt, "utf8");

    // Write resolved agent profile before invoking the agent so interrupted/failed
    // runs still have a pre-run audit record of the intended billable profile.
    const assignment = readResolvedAssignment(task);
    writeFileSync(
      join(artifactDir, "content-review-context.json"),
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
        error: "content_review_artifact_dir_unsafe",
      };
    }

    // Raw stdout/stderr is persisted only in the local findings artifact —
    // never forwarded to any GitHub-visible payload (contract §Output boundary).
    const diagnosticParts: string[] = [];
    if (cmdResult.stdout) diagnosticParts.push(cmdResult.stdout);
    if (cmdResult.stderr) diagnosticParts.push(`--- stderr ---\n${cmdResult.stderr}`);
    const findingsPath = join(artifactDir, "content-review-findings.md");
    rejectSymlink(findingsPath);
    writeFileSync(findingsPath, diagnosticParts.join("\n"), "utf8");

    // Classify quota exhaustion before determining outcome.
    const quotaClassification =
      cmdResult.exitCode !== 0
        ? classifyQuotaExhaustion(extractAgentFailureDiagnostic(resolvedProfile.agentId, cmdResult, { cmdSource: resolvedProfile.cmdSource }))
        : { isQuotaExhaustion: false as const };

    const outcome = classifyReviewOutcome(
      cmdResult.stdout,
      cmdResult.exitCode,
      quotaClassification.isQuotaExhaustion,
    );

    // success is true ONLY for the "success" outcome.
    const reviewArtifactKey = runId;
    const resultJson = {
      issueNumber: task.issueNumber,
      runId,
      agentId,
      exitCode: cmdResult.exitCode,
      success: outcome === "success",
      outcome,
      readyForHuman: outcome === "success",
      reviewArtifactKey,
      ...(quotaClassification.isQuotaExhaustion
        ? { delayed: true, quotaSignal: quotaClassification.signal }
        : {}),
      artifactDir,
      resolvedProfile,
    };
    const resultPath = join(artifactDir, "content-review-result.json");
    rejectSymlink(resultPath);
    writeFileSync(resultPath, JSON.stringify(resultJson, null, 2), "utf8");

    if (quotaClassification.isQuotaExhaustion) {
      return {
        result: "delayed",
        context: {
          ...task.context,
          reviewRunArtifactDir: artifactDir,
          resolvedProfile,
          outcome,
          quotaSignal: quotaClassification.signal,
          category: quotaClassification.category,
        },
        message: `Content review agent (${agentId}) hit a ${describeFailureCategory(quotaClassification.category)} condition (signal: "${quotaClassification.signal}"); delaying retry`,
        retryAfterMs: resolveRetryDelayOverrideMsForCategory(quotaClassification.category),
        category: quotaClassification.category,
      };
    }

    if (outcome === "needs_fix") {
      // Extract bounded fix feedback for the draft agent's next run (contract §Fix Feedback Policy).
      // The full findings remain in the local artifact only.
      const fixFeedback = extractFixFeedback(cmdResult.stdout);
      // Deliberately do NOT overwrite `artifactDir` here: this needs_fix may
      // either loop back to content_draft or (once the cycle cap is hit) hand
      // off to a human, and only the caller (nextPhaseAfter) knows which. Keep
      // `artifactDir` pointing at the draft dir — the documented handoff target
      // — for the terminal ready_for_human case; the research dir it was
      // resolved from is already preserved separately as `researchArtifactDir`
      // (set by content_draft's success context). nextPhaseAfter swaps
      // `artifactDir` back to `researchArtifactDir` only when it routes the
      // task back to content_draft.
      return {
        result: "needs_fix",
        context: {
          ...task.context,
          reviewRunArtifactDir: artifactDir,
          reviewFixFeedback: fixFeedback,
          resolvedProfile,
          outcome,
        },
      };
    }

    if (outcome === "blocked") {
      // Public-safe message — raw findings are in the local artifact only.
      const publicMessage = `Content review agent failed or could not determine outcome (exit code: ${cmdResult.exitCode})`;
      return {
        result: "blocked",
        message: publicMessage,
        // Keep the existing draft `artifactDir` intact (as the success path
        // does) so the human handoff still points at content-draft-output.md;
        // store this review run's own dir under a separate key.
        context: { ...task.context, reviewRunArtifactDir: artifactDir, resolvedProfile, outcome },
      };
    }

    // outcome === "success": draft passed editorial review.
    return {
      result: "success",
      context: {
        ...task.context,
        reviewRunArtifactDir: artifactDir,
        reviewArtifactKey,
        readyForHuman: true,
        contentReviewAgentUsed: agentId,
        resolvedProfile,
        outcome,
      },
    };
  };
}
