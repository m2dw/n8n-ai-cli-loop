import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, relative, resolve } from "path";
import type { AiTask, ImplementationMode } from "../core/task.js";
import type { PhaseHandler, PhaseHandlerContext, PhaseHandlerResult } from "../core/phase-runner.js";
import { defaultCommandRunner } from "./command-runner.js";
import type { CommandRunner } from "./command-runner.js";
import type { DependencyChecker, DependencyDecision } from "../core/github-intake.js";
import { labelsToComplexity } from "../core/github-intake.js";
import { runArtifactDir, writeAssignmentFailureArtifact } from "./artifact-dir.js";
import { agentForPhase, readResolvedAssignment } from "../core/assignment.js";
import { branchName, findOpenPr, resolveFixPr, extractPrNumber } from "./pr-helpers.js";
import type { PrInfo } from "./pr-helpers.js";
import { resolveIssueWorktree, removeWorktree } from "./worktree.js";
import { ghRunnerFromCommandRunner } from "../providers/github/gh-runner.js";
import type { GhRunner } from "../providers/github/gh-runner.js";
import { resolveGhRunner } from "../providers/github/github-app-auth.js";
import { resolveSessionRepoHost } from "../providers/repo-host-factory.js";
import type { SessionRepoHost } from "../providers/repo-host-factory.js";
import { resolveDependencyExecutionPlan } from "./dependency-plan.js";
import type { DependencyExecutionPlan } from "./dependency-plan.js";
import { runVerification } from "./verification.js";
import type { VerificationFailure } from "./verification.js";
import { runDependencySync } from "./dependency-sync.js";
import type { DependencySyncOutcome } from "./dependency-sync.js";
import { ensureEnvironmentPrepared } from "./environment-prepare.js";
import { runDependencyUpdate } from "./dependency-update.js";
import type { DependencyUpdateApplied, DependencyUpdateFailed } from "./dependency-update.js";
import { classifyQuotaExhaustion } from "../core/quota-classifier.js";
import { parseToolRequest, toolRequestPromptSection, toolRequestResolutionPromptSection, normalizeToolRequestCommand } from "../core/tool-request.js";
import type { StoredToolRequest, ToolRequest } from "../core/tool-request.js";
import type { CodexConfig } from "../core/session.js";
import { resolveCodexContextMode, providerForAgent } from "./codex-context-mode.js";

// ---------------------------------------------------------------------------
// Mode detection
//
// Fix mode is triggered by any of:
//   1. task.context.implementationMode === "fix" (set during intake from labels)
//   2. task.context.labels contains "status:needs-fix" (manual via GitHub label,
//      legacy fallback when implementationMode is absent)
//   3. task.context.reviewFeedback is a non-empty string (automatic requeue from
//      the review handler after a needs_fix classification)
// ---------------------------------------------------------------------------

function resolveImplementationMode(task: AiTask): ImplementationMode {
  const hasReviewFeedback =
    typeof task.context["reviewFeedback"] === "string" &&
    (task.context["reviewFeedback"] as string).trim().length > 0;
  if (hasReviewFeedback) return "fix";

  const mode = task.context["implementationMode"];
  if (mode === "fix" || mode === "new") return mode;

  const labels = task.context["labels"];
  const hasFixLabel =
    Array.isArray(labels) &&
    (labels as unknown[]).some((l) => l === "status:needs-fix");
  return hasFixLabel ? "fix" : "new";
}

function isNeedsFixTask(task: AiTask): boolean {
  return resolveImplementationMode(task) === "fix";
}

// ---------------------------------------------------------------------------
// Review feedback extraction
//
// Returns the review feedback string, or undefined if not present.
// ---------------------------------------------------------------------------

function getReviewFeedback(task: AiTask): string | undefined {
  const fb = task.context["reviewFeedback"];
  if (typeof fb === "string" && fb.trim().length > 0) return fb.trim();
  return undefined;
}

// ---------------------------------------------------------------------------
// Prompt builder
//
// Claude is asked to edit files only — no git or gh access.
// Branch creation, commit, push, and PR are handled by the handler itself
// after Claude exits, mirroring the n8n lane structure.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dependency-sync prompt section (issue #302)
//
// When the session enables handler-owned dependency sync, tell the agent the
// first-class way to add/update a dependency: edit the manifest directly with an
// explicit version and let the handler regenerate the lockfile. This addresses
// the root cause behind issue #302 — an agent that does not know it can edit the
// manifest keeps emitting (and re-emitting) an install Tool Request whose package
// state never changes. Only emitted when sync is enabled, so sessions without it
// keep today's prompt verbatim.
//
// The dependency-sync runner supports non-npm ecosystems (e.g. Cargo, Poetry,
// Go), so the examples must match the session's manifest rather than always
// assuming npm/package.json. We derive an ecosystem-specific example from the
// configured triggerPaths and fall back to ecosystem-neutral phrasing when the
// manifest is unrecognized.
// ---------------------------------------------------------------------------

interface DependencyEcosystemExample {
  manifestEdit: string;
  installCommand: string;
  // True only when an install Tool Request for this ecosystem is auto-applied by
  // the trusted dependency-sync path. Today that is npm/package.json alone:
  // runDependencyUpdate edits the manifest and regenerates the lockfile only for
  // npm. Cargo/Poetry/Go (and unrecognized manifests) fall back to a human
  // handoff, so their prompt must NOT promise auto-apply (issue #302 review).
  autoApply: boolean;
}

function dependencyEcosystemExample(triggerPaths: string[]): DependencyEcosystemExample | undefined {
  const has = (name: string) =>
    triggerPaths.some((p) => p.split(/[\\/]/).pop()?.toLowerCase() === name);
  if (has("package.json")) {
    return {
      manifestEdit: "add `\"left-pad\": \"^1.3.0\"` to the dependencies",
      installCommand: "npm install left-pad@^1.3.0",
      autoApply: true,
    };
  }
  if (has("cargo.toml")) {
    return {
      manifestEdit: "add `left-pad = \"1.3.0\"` under `[dependencies]`",
      installCommand: "cargo add left-pad@1.3.0",
      autoApply: false,
    };
  }
  if (has("pyproject.toml")) {
    return {
      manifestEdit: "add `left-pad = \"^1.3.0\"` under the project dependencies",
      installCommand: "poetry add left-pad@^1.3.0",
      autoApply: false,
    };
  }
  if (has("go.mod")) {
    return {
      manifestEdit: "add `require example.com/left-pad v1.3.0`",
      installCommand: "go get example.com/left-pad@v1.3.0",
      autoApply: false,
    };
  }
  return undefined;
}

function dependencySyncPromptSection(triggerPaths: string[]): string[] {
  const manifests = triggerPaths.length > 0 ? triggerPaths.join(", ") : "the dependency manifest";
  const example = dependencyEcosystemExample(triggerPaths);
  const manifestLine = example
    ? `edit the manifest (${manifests}) directly and pin an explicit version (e.g. ${example.manifestEdit}).`
    : `edit the manifest (${manifests}) directly and pin an explicit version using that ecosystem's syntax.`;
  // Only npm install requests are auto-applied by the trusted dependency-sync
  // path; for every other ecosystem (and unrecognized manifests) the request is
  // handed to a human, so the prompt must not promise auto-apply (issue #302
  // review) — that would steer non-npm agents to emit requests the workflow
  // cannot satisfy, causing avoidable blocked runs.
  const exampleClause = example ? `(e.g. \`${example.installCommand}\`)` : "using that ecosystem's package manager";
  const installLine =
    example?.autoApply === true
      ? `${exampleClause}; the workflow will apply it for you.`
      : `${exampleClause}; a human reviewer will pick it up and apply it.`;
  return [
    "## Adding Or Updating A Dependency",
    "",
    `This session has handler-owned dependency sync. To add or change a dependency,`,
    manifestLine,
    "The lockfile is regenerated for you after you finish — do NOT hand-edit the",
    "lockfile and do NOT run an install command.",
    "",
    "Only if you genuinely cannot express the change as a manifest edit, emit a Tool",
    "Request whose command is the exact install with an explicit version",
    installLine,
    "",
  ];
}

function verificationPromptSection(verification: Record<string, string>): string[] {
  const configured = Object.entries(verification).filter(([, cmd]) => cmd);
  if (configured.length === 0) return [];
  const list = configured.map(([name, cmd]) => `  - \`${name}\`: \`${cmd}\``).join("\n");
  return [
    "",
    "## Configured Verification Commands",
    "",
    "The following verification commands are already configured and will run",
    "automatically by the runner after your edits. Do NOT request these as",
    "Tool Requests — doing so would produce redundant or conflicting state.",
    "Rely on the runner-provided verification output (included in fix-mode",
    "prompts) rather than re-running them manually:",
    "",
    list,
    "",
    "If a command you need is not listed here, you may still emit a Tool",
    "Request or explain the missing verification in your output.",
  ];
}

// ---------------------------------------------------------------------------
// Dirty continuation check (issue #571)
//
// A prior verification-failure run may have recorded a dirtyContinuation
// marker in task context (issue #568). When the next implementation attempt
// finds the worktree dirty it checks this marker and, if all safety conditions
// hold, continues from the existing edits instead of aborting.
//
// Safety conditions (all must hold):
//   - marker phase === "implementation"
//   - marker issueNumber matches the task
//   - marker branch matches the expected worktree branch
//   - marker commitSkipped === true (commit/push never happened)
//   - marker patchArtifactFile is present (dirty state was cleanly captured)
//   - when both are known, marker worktreeId matches the resolved worktree
//   - dirty file path set matches dirtyFiles recorded in the marker
//   - current git diff HEAD + untracked patch matches the stored patch artifact
// ---------------------------------------------------------------------------

function isValidDirtyContinuation(
  savedCtx: unknown,
  issueNumber: number,
  branch: string,
  worktreeId: string | undefined,
): boolean {
  if (typeof savedCtx !== "object" || savedCtx === null) return false;
  const dc = savedCtx as Record<string, unknown>;
  if (dc["phase"] !== "implementation") return false;
  if (dc["issueNumber"] !== issueNumber) return false;
  if (dc["branch"] !== branch) return false;
  if (dc["commitSkipped"] !== true) return false;
  // Require the patch artifact to have been recorded — ensures the dirty state
  // capture itself completed cleanly, not just the failure classification.
  if (typeof dc["patchArtifactFile"] !== "string") return false;
  // Worktree ID guard: when both are known they must agree.
  if (
    worktreeId !== undefined &&
    dc["worktreeId"] !== undefined &&
    dc["worktreeId"] !== null &&
    dc["worktreeId"] !== worktreeId
  ) return false;
  return true;
}

// Builds a unified-diff representation of untracked files in `cwd`, using the
// same format as `git diff HEAD` so both parts can be concatenated and compared
// as a single patch. Used at both recording and check-time to detect content drift.
export function buildUntrackedPatch(cwd: string, untrackedFiles: string[]): { patch: string; skipped: string[] } {
  const resolvedCwd = resolve(cwd);
  const skipped: string[] = [];
  const patch = untrackedFiles.map((rel) => {
    let content = "";
    try {
      const absPath = resolve(join(cwd, rel));
      // Skip paths that escape the worktree (directory traversal guard).
      if (absPath !== resolvedCwd && !absPath.startsWith(resolvedCwd + "/")) {
        skipped.push(rel);
        return "";
      }
      // Use lstat so we never follow symlinks; skip non-regular files.
      const st = lstatSync(absPath);
      if (!st.isFile()) {
        skipped.push(rel);
        return `# skipped non-regular untracked file ${rel}\n`;
      }
      // Skip files larger than 1 MiB to avoid OOM on large artifacts.
      const MAX_UNTRACKED_BYTES = 1 * 1024 * 1024;
      if (st.size > MAX_UNTRACKED_BYTES) {
        skipped.push(rel);
        return `# skipped untracked file ${rel} (${st.size} bytes, exceeds limit)\n`;
      }
      const raw = readFileSync(absPath);
      // Skip binary files (null byte in first 8 KiB is the heuristic git uses).
      const probe = raw.subarray(0, 8 * 1024);
      if (probe.includes(0)) {
        skipped.push(rel);
        return `# skipped binary untracked file ${rel} (${st.size} bytes)\n`;
      }
      content = raw.toString("utf8");
    } catch {
      skipped.push(rel);
      return "";
    }
    const lines = content.split("\n");
    // Remove trailing empty element from split when file ends with newline.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    // Empty files have no hunk; a @@ -0,0 +1,0 @@ header is a corrupt patch.
    const hunkSection = lines.length === 0
      ? ""
      : `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
    return `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n${hunkSection}`;
  }).join("");
  return { patch, skipped };
}

function buildPrompt(
  task: AiTask,
  repoRoot: string,
  reviewFeedback?: string,
  dependencySyncTriggerPaths?: string[],
  verification?: Record<string, string>,
  dirtyContinuation?: Record<string, unknown>,
): string {
  const ctx = task.context as Record<string, unknown>;
  const title = typeof ctx.title === "string" ? ctx.title : `Issue #${task.issueNumber}`;
  const url = typeof ctx.url === "string" ? `\nURL: ${ctx.url}` : "";
  const labels = Array.isArray(ctx.labels) ? `\nLabels: ${(ctx.labels as string[]).join(", ")}` : "";
  const body = typeof ctx.body === "string" && ctx.body.trim().length > 0 ? ctx.body.trim() : undefined;
  const descriptionSection = body
    ? ["", "## Issue Description", "", body]
    : [];
  const dependencySection =
    dependencySyncTriggerPaths !== undefined
      ? ["", ...dependencySyncPromptSection(dependencySyncTriggerPaths)]
      : [];
  // Replay an operator's resolution of a prior Tool Request as conversational
  // continuation so the agent reacts to the human response instead of re-emitting
  // the same request against an unchanged repo (issue #422). Empty when there is
  // no resolved request to report.
  const resolutionLines = toolRequestResolutionPromptSection(ctx.toolRequest);
  const toolRequestResolutionSection =
    resolutionLines.length > 0 ? ["", ...resolutionLines] : [];
  const verificationSection = verification ? verificationPromptSection(verification) : [];

  // When the handler detected a valid dirty continuation, include a section that
  // tells the agent its prior edits are still in the tree so it continues from
  // them rather than starting fresh, and shows the verification failure that
  // caused the earlier attempt to stop (issue #571).
  const continuationLines: string[] = [];
  if (dirtyContinuation) {
    const verFailure = ctx["verificationFailure"] as { name: string; exitCode: number } | undefined;
    const verFeedback = typeof ctx["verificationFeedback"] === "string"
      ? (ctx["verificationFeedback"] as string)
      : "";
    continuationLines.push(
      "",
      "## Continuation Context",
      "",
      "This run continues a prior implementation attempt whose edits are already in the working tree.",
      "Review the existing changes and continue from them; do not discard correct work.",
      "Fix the verification failure described below and the runner will commit and push as normal.",
    );
    if (verFailure) {
      continuationLines.push(
        "",
        `### Prior Verification Failure: ${verFailure.name} (exit ${verFailure.exitCode})`,
        "",
      );
      if (verFeedback.trim()) {
        continuationLines.push("```", verFeedback.slice(0, 4000), "```");
      }
    }
  }

  if (reviewFeedback) {
    return [
      `# Fix Task — Issue #${task.issueNumber}`,
      "",
      `**Title**: ${title}${url}${labels}`,
      `Repository root: ${repoRoot}`,
      ...descriptionSection,
      ...toolRequestResolutionSection,
      ...continuationLines,
      "",
      "You are updating the **existing PR branch** for this issue.",
      "Focus only on addressing the review findings below.",
      "",
      "## Review Feedback To Address",
      "",
      reviewFeedback,
      "",
      "## Instructions",
      "",
      "Apply focused changes that address the actionable findings listed above.",
      "Work inside the repository at the repository root path above.",
      "Edit the relevant source files to fix the review findings.",
      "Keep the change scoped to the findings and avoid unrelated refactors.",
      "Do not bump package, lockfile, manifest, or extension versions unless explicitly requested.",
      "Use the existing project patterns and helper APIs where possible.",
      "Run only safe inspection or verification commands when needed.",
      "You may use read-only git commands (git status, git diff, git log, git show) to inspect the working tree or history.",
      "Do not run git write operations (commit, push, checkout, reset, merge, rebase, add, restore, clean) or gh commands — branch, commit, and PR creation are handled externally.",
      "Do not modify unrelated files.",
      ...dependencySection,
      ...verificationSection,
      "",
      ...toolRequestPromptSection(),
    ].join("\n");
  }

  return [
    `# Implementation Task — Issue #${task.issueNumber}`,
    "",
    `**Title**: ${title}${url}${labels}`,
    `Repository root: ${repoRoot}`,
    ...descriptionSection,
    ...toolRequestResolutionSection,
    ...continuationLines,
    "",
    "## Instructions",
    "",
    "Implement the changes required to resolve the issue described above.",
    "Work inside the repository at the repository root path above.",
    "Edit the relevant source files to implement the fix or feature.",
    "Keep the change scoped to the issue and avoid unrelated refactors.",
    "Do not bump package, lockfile, manifest, or extension versions unless the issue explicitly requests a release/version change.",
    "Use the existing project patterns and helper APIs where possible.",
    "Run only safe inspection or verification commands when needed.",
    "You may use read-only git commands (git status, git diff, git log, git show) to inspect the working tree or history.",
    "Do not run git write operations (commit, push, checkout, reset, merge, rebase, add, restore, clean) or gh commands — branch, commit, and PR creation are handled externally.",
    "Do not modify unrelated files.",
    ...dependencySection,
    ...verificationSection,
    "",
    ...toolRequestPromptSection(),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Repair prompt builder
//
// When verification fails after the agent's edits, the agent is re-run once with
// the failing command's output appended so it can fix the regression before any
// commit/push. The repair attempt is bounded (see MAX_VERIFICATION_REPAIR_ATTEMPTS)
// so this never becomes an infinite inner loop.
// ---------------------------------------------------------------------------

function buildRepairPrompt(task: AiTask, repoRoot: string, failure: VerificationFailure): string {
  return [
    `# Verification Repair Task — Issue #${task.issueNumber}`,
    "",
    `Repository root: ${repoRoot}`,
    "",
    "Your previous edits are in the working tree but verification is failing.",
    "Fix the cause of the failure below. Do not revert unrelated correct work.",
    "",
    `## Failing Verification: ${failure.name} (exit ${failure.exitCode})`,
    "",
    "```",
    failure.output,
    "```",
    "",
    "## Instructions",
    "",
    "Edit the relevant source files so the failing verification command passes.",
    "Work inside the repository at the repository root path above.",
    "Keep the change scoped to fixing the failure and avoid unrelated refactors.",
    "Do not bump package, lockfile, manifest, or extension versions.",
    "You may use read-only git commands (git status, git diff, git log, git show) to inspect the working tree or history.",
    "Do not run git write operations (commit, push, checkout, reset, merge, rebase, add, restore, clean) or gh commands — commit and push are handled externally.",
    "",
    // A repair attempt can be the first place a disallowed command is found to be
    // needed (e.g. the failing verification depends on an uninstalled package), so
    // the repair agent must know how to hand off too (issue #291).
    ...toolRequestPromptSection(),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// PR body builder
//
// Produces a human-readable PR body from the issue context. Keeps local
// filesystem paths out of the body — only runId (a short opaque identifier)
// appears in the generated-by footer.
// ---------------------------------------------------------------------------

const PR_BODY_EXCERPT_LIMIT = 500;

function buildPrBody(
  task: AiTask,
  runId: string,
  mode: ImplementationMode,
  verification: Record<string, string>,
): string {
  const ctx = task.context as Record<string, unknown>;
  const issueTitle =
    typeof ctx.title === "string" && ctx.title.trim().length > 0
      ? ctx.title.trim()
      : undefined;
  const rawBody =
    typeof ctx.body === "string" && ctx.body.trim().length > 0
      ? ctx.body.trim()
      : undefined;
  // Neutralize GitHub closing keywords so copied issue text doesn't auto-close
  // unintended issues when this PR merges. An HTML comment between the keyword
  // and `#` is enough to defeat GitHub's parser.
  const sanitizeClosingKeywords = (text: string): string =>
    text.replace(
      /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s+(?:[\w.-]+\/[\w.-]+)?#\d+)/gi,
      "$1<!-- -->$2"
    );

  const rawExcerpt = rawBody
    ? rawBody.length > PR_BODY_EXCERPT_LIMIT
      ? `${rawBody.slice(0, PR_BODY_EXCERPT_LIMIT)}\n…`
      : rawBody
    : undefined;
  const bodyExcerpt = rawExcerpt ? sanitizeClosingKeywords(rawExcerpt) : undefined;

  const lines: string[] = [`Closes #${task.issueNumber}`];

  if (issueTitle) {
    lines.push("", `## ${sanitizeClosingKeywords(issueTitle)}`);
  }
  if (bodyExcerpt) {
    lines.push("", bodyExcerpt);
  }

  const verificationNames = Object.keys(verification).filter((k) => verification[k]);
  lines.push("", "---", "");
  if (verificationNames.length > 0) {
    lines.push(`**Verification**: ${verificationNames.join(", ")} ✓`);
  }
  lines.push(`**Mode**: ${mode}`, "", `Generated by run-one-phase (runId: ${runId})`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Verification repair bound
//
// The implementation agent is re-run at most this many times with verification
// feedback. Keeping this bounded ensures the pre-push verification never turns
// into an unbounded inner loop.
// ---------------------------------------------------------------------------

const MAX_VERIFICATION_REPAIR_ATTEMPTS = 1;

// ---------------------------------------------------------------------------
// Claude flags — mirrors the established n8n implementation lane contract
// ---------------------------------------------------------------------------

const CLAUDE_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "Bash(rg *)",
  "Bash(sed *)",
  "Bash(cat *)",
  "Bash(npm test)",
  "Bash(npm run package)",
  "Bash(git status *)",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
].join(",");

export interface ResolvedImplementationProfile {
  phase: "implementation";
  agentId: string;
  cmd: string;
  /** Sanitized argv — no prompt content (prompt is passed via stdin). */
  argv: string[];
  model: string;
  modelSource: "env" | "label" | "default";
  effort: string;
  effortSource: "env" | "escalation" | "label" | "default";
  maxBudgetUsd: string;
  budgetSource: "env" | "label" | "default";
  /** Binary path source — set for Gemini/Antigravity; absent for Claude. */
  cmdSource?: "env" | "cli-default";
  /** Company/provider backing the agent (e.g. "anthropic", "openai", "google"). */
  provider: string;
  /**
   * Codex context-mode status. `enabled`/`unset` for Codex; `n/a` for agents that
   * have no context-mode capability (Claude, Gemini/Antigravity).
   */
  contextMode: "enabled" | "unset" | "n/a";
  /** Source of the context-mode decision. */
  contextModeSource: "session" | "env" | "default";
  /** Resolved Codex context-mode invocation overrides, recorded when enabled. */
  contextModeConfig?: string[];
}

// Relative ordering of Claude effort tiers, used to ensure review-loop
// escalation only ever raises effort and never downgrades an already-stronger
// label profile (e.g. complexity:xhigh must not be knocked down to "high"
// escalation — issue #243).
const EFFORT_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

function effortRank(effort: string): number {
  return EFFORT_RANK[effort] ?? 0;
}

function resolveClaudeProfile(
  labels: string[],
  escalatedEffort?: string,
): ResolvedImplementationProfile {
  const labelProfile = labelsToComplexity(labels);
  const hasComplexityLabel =
    labels.includes("complexity:xhigh") ||
    labels.includes("complexity:high") ||
    labels.includes("complexity:low");

  const model = process.env["CLAUDE_MODEL"] ?? labelProfile.model;
  const modelSource: ResolvedImplementationProfile["modelSource"] =
    process.env["CLAUDE_MODEL"] ? "env" : hasComplexityLabel ? "label" : "default";

  const budget = process.env["CLAUDE_MAX_BUDGET_USD"] ?? labelProfile.budget;
  const budgetSource: ResolvedImplementationProfile["budgetSource"] =
    process.env["CLAUDE_MAX_BUDGET_USD"] ? "env" : hasComplexityLabel ? "label" : "default";

  let effort: string;
  let effortSource: ResolvedImplementationProfile["effortSource"];
  if (process.env["CLAUDE_EFFORT"]) {
    effort = process.env["CLAUDE_EFFORT"];
    effortSource = "env";
  } else if (escalatedEffort && effortRank(escalatedEffort) > effortRank(labelProfile.effort)) {
    // Only escalate when it actually raises effort. This keeps the existing
    // no-op for default/high profiles and, critically, never downgrades a
    // stronger label profile such as complexity:xhigh down to "high".
    effort = escalatedEffort;
    effortSource = "escalation";
  } else {
    effort = labelProfile.effort;
    effortSource = hasComplexityLabel ? "label" : "default";
  }

  const argv = [
    "-p",
    "--model", model,
    "--effort", effort,
    "--permission-mode", "acceptEdits",
    "--max-budget-usd", budget,
    "--allowedTools", CLAUDE_ALLOWED_TOOLS,
  ];

  return {
    phase: "implementation", agentId: "claude", cmd: "claude", argv, model, modelSource, effort, effortSource, maxBudgetUsd: budget, budgetSource,
    provider: providerForAgent("claude"),
    // Context-mode is a Codex-only capability; never applies to Claude (issue #376).
    contextMode: "n/a", contextModeSource: "default",
  };
}

function claudeArgs(profile: ResolvedImplementationProfile, prompt: string): string[] {
  // Gemini/Antigravity requires the prompt as a positional arg after --print,
  // matching the research lane contract: agy --print "<prompt>"
  if (profile.agentId === "gemini") {
    return [...profile.argv, prompt];
  }
  return profile.argv;
}

function resolveGeminiProfile(): ResolvedImplementationProfile {
  const envBin = process.env["ANTIGRAVITY_BIN"];
  const bin = envBin ?? "agy";
  const cmdSource: "env" | "cli-default" = envBin ? "env" : "cli-default";
  // --print forces non-interactive/TUI output, matching the research lane contract:
  //   agy --print "<prompt>"
  // The prompt is appended as a positional arg at call time (see claudeArgs).
  return {
    phase: "implementation",
    agentId: "gemini",
    cmd: bin,
    argv: ["--print"],
    cmdSource,
    model: "cli-default",
    modelSource: "default",
    effort: "n/a",
    effortSource: "default",
    maxBudgetUsd: "n/a",
    budgetSource: "default",
    provider: providerForAgent("gemini"),
    // Context-mode is a Codex-only capability; never applies to Gemini (issue #376).
    contextMode: "n/a",
    contextModeSource: "default",
  };
}

// ---------------------------------------------------------------------------
// Codex flags — implementation lane
//
// Codex does not expose model selection or a per-run budget cap via CLI flags.
// Effort is passed via -c model_reasoning_effort=<value>; the effort tier is
// resolved from task labels / escalation / env just like Claude, then mapped
// to the three levels Codex accepts (low / medium / high). xhigh and max (Claude-
// specific tiers) are mapped to "high" since Codex has no finer tier above it.
// Prompt is passed via stdin (same contract as Claude).
// ---------------------------------------------------------------------------

function resolveCodexProfile(
  labels: string[],
  escalatedEffort?: string,
  codex?: CodexConfig,
): { profile: ResolvedImplementationProfile } | { error: string } {
  const labelProfile = labelsToComplexity(labels);
  const hasComplexityLabel =
    labels.includes("complexity:xhigh") ||
    labels.includes("complexity:high") ||
    labels.includes("complexity:low");

  let effort: string;
  let effortSource: ResolvedImplementationProfile["effortSource"];
  if (process.env["CODEX_EFFORT"]) {
    effort = process.env["CODEX_EFFORT"];
    effortSource = "env";
  } else if (escalatedEffort && effortRank(escalatedEffort) > effortRank(labelProfile.effort)) {
    effort = escalatedEffort;
    effortSource = "escalation";
  } else {
    effort = labelProfile.effort;
    effortSource = hasComplexityLabel ? "label" : "default";
  }

  // Map effort tier to the three levels Codex accepts via model_reasoning_effort.
  // "xhigh" and "max" are Claude-specific tiers with no Codex equivalent; map to "high".
  const codexEffortLevel =
    effort === "low" ? "low" :
    effort === "medium" ? "medium" :
    "high";

  // Resolve context-mode BEFORE building argv so an invalid/unavailable
  // configuration fails the run with a clear error before the agent is invoked
  // (issue #376). When unset the Codex argv is unchanged.
  const ctxMode = resolveCodexContextMode(codex);
  if (ctxMode.status === "error") {
    return { error: ctxMode.error };
  }

  const argv: string[] = ["exec"];
  argv.push("-c", `model_reasoning_effort=${codexEffortLevel}`);
  if (ctxMode.status === "enabled") {
    argv.push(...ctxMode.args);
  }

  return {
    profile: {
      phase: "implementation",
      agentId: "codex",
      cmd: "codex",
      argv,
      // Codex does not expose model selection via CLI flags; model is determined
      // by the Codex CLI configuration.
      model: "cli-default",
      modelSource: "default",
      effort,
      effortSource,
      // Codex does not support a per-run budget cap flag.
      maxBudgetUsd: "n/a",
      budgetSource: "default",
      provider: providerForAgent("codex"),
      contextMode: ctxMode.status === "enabled" ? "enabled" : "unset",
      contextModeSource: ctxMode.source,
      ...(ctxMode.status === "enabled"
        ? { contextModeConfig: [...(ctxMode.profile ? [`profile=${ctxMode.profile}`] : []), ...ctxMode.config] }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Agent command selection
// ---------------------------------------------------------------------------

function implementationCommand(
  agentId: string | undefined,
  labels: string[],
  escalatedEffort?: string,
  codex?: CodexConfig,
): { profile: ResolvedImplementationProfile } | { error: string } {
  const agent = agentId ?? "claude";
  if (agent === "claude") {
    return { profile: resolveClaudeProfile(labels, escalatedEffort) };
  }
  if (agent === "gemini") {
    return { profile: resolveGeminiProfile() };
  }
  if (agent === "codex") {
    return resolveCodexProfile(labels, escalatedEffort, codex);
  }
  return { error: `Unsupported implementation agent: ${agent}. Supported: claude, codex, gemini` };
}

// ---------------------------------------------------------------------------
// Contamination guard helpers (issue #211)
//
// A previous implementation run that created a branch and committed but then
// failed at a late step (push / gh pr create) could leave the worker checkout
// sitting on that failed branch. A later run that assumed a clean base would
// then branch off the wrong HEAD, pulling one issue's commit into another
// issue's PR. These helpers harden the run against that:
//
//   - currentBranch(): read the checked-out branch so we can assert HEAD is at
//     the intended base before `git checkout -b`.
//   - the quarantine marker: a persistent fail-closed signal written to the
//     shared session artifact root when a late failure cannot be rolled back to
//     a safe base. While present, every new run aborts in preflight so a
//     contaminated checkout can never become the base for a later issue branch.
//     It is cleared by manual recovery (deleting the file).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Partial-work preservation result types (issue #379, #390)
//
// capturePartialDiff distinguishes three outcomes so a handoff can decide whether
// the new-impl issue branch — the last continuation point once the patch is
// absent — may be deleted: a captured patch and a proven-empty diff are both safe
// to drop the branch on, but a capture FAILURE means a diff may exist and the
// branch must be kept.
// ---------------------------------------------------------------------------

type PartialDiffCapture =
  | { kind: "captured"; artifact: string }
  | { kind: "empty" }
  | { kind: "failed"; reason: string };

// What a Tool Request handoff preserved, recorded on the stored request so admin
// guidance is accurate per case (issue #390).
interface HandoffPreservation {
  /** Relative artifact filename of the captured partial-implementation patch. */
  partialDiffArtifact?: string;
  /** True when the handler proved the agent produced no file changes. */
  noPriorDiff?: boolean;
  /** Reason capture failed, when it did (a diff may have existed but was not snapshotted). */
  partialDiffCaptureFailed?: string;
  /** Issue branch kept as the continuation point because capture failed. */
  preservedBranch?: string;
  /** Whether {@link preservedBranch} reached origin. */
  preservedBranchPushed?: boolean;
}

const QUARANTINE_FILENAME = "implementation-quarantine.json";

function quarantineMarkerPath(artifactRoot: string): string {
  return join(artifactRoot, QUARANTINE_FILENAME);
}

function currentBranch(
  runner: CommandRunner,
  cwd: string,
): { branch: string } | { error: string } {
  const r = runner.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  if (r.exitCode !== 0) {
    return {
      error: `git rev-parse --abbrev-ref HEAD failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(0, 300)}`,
    };
  }
  return { branch: r.stdout.trim() };
}

interface QuarantineInfo {
  issueNumber: number;
  sessionId: string;
  runId: string;
  branch: string;
  step: string;
}

function writeQuarantineMarker(artifactRoot: string, info: QuarantineInfo): void {
  try {
    mkdirSync(artifactRoot, { recursive: true });
    writeFileSync(
      quarantineMarkerPath(artifactRoot),
      JSON.stringify({ ...info, quarantinedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
  } catch {
    // Best-effort: if the marker cannot be written the run still reports the
    // underlying failure. The next run's preflight HEAD check remains a guard.
  }
}

// ---------------------------------------------------------------------------
// Implementation phase handler factory
//
// Two orchestration modes share the same dirty-check + base-reset prologue,
// then diverge on branch setup:
//
// NEW IMPLEMENTATION (status:needs-implementation):
//   0.5. Revalidate dependency execution plan (issue #208, #224, #242):
//        - no open blockers        → continue normally (branch from base branch)
//        - one usable blocker PR    → fetch the blocker PR head and branch from
//                                     it; the dependent PR still targets the
//                                     session base branch (`main`), NOT that head
//        - blocked / unsupported    → return blocked WITHOUT running any git ops
//   1. git status --porcelain — fail if dirty
//   2. git checkout main && git pull --ff-only
//   3. git checkout -b ai/issue-<N> (from the base branch or the blocker head)
//   4. Run Claude
//   5. git diff --stat HEAD — fail if no changes
//   6. Run session.verification (bounded repair loop) — fail if still failing
//   7. git add -A, git commit, git push
//   8. gh pr create — capture PR URL
//   9. Return success with prUrl/branch in context
//
// FIX EXISTING PR (status:needs-fix):
//   1. git status --porcelain — fail if dirty
//   2. git checkout main && git pull --ff-only
//   3. gh pr list → find open PR for the branch; fail if none
//   4. git checkout <headRefName>
//   5. git pull origin <headRefName> --ff-only
//   6. Run Claude
//   7. git diff --stat HEAD — fail if no changes
//   8. Run session.verification (bounded repair loop) — fail if still failing
//   9. git add -A, git commit, git push
//   10. (no gh pr create — existing PR auto-updates)
//   11. Return success with existing prUrl/branch in context
// ---------------------------------------------------------------------------

export function createImplementationHandler(
  context: PhaseHandlerContext,
  runner: CommandRunner = defaultCommandRunner,
  depChecker?: DependencyChecker,
  // Injectable so the per-issue worktree materialization (Step 0.6) can be stubbed
  // in tests without driving the canonical-repo git machinery through the mock
  // command runner. Defaults to the real resolver in production (issue #454).
  resolveWorktree: typeof resolveIssueWorktree = resolveIssueWorktree,
): PhaseHandler {
  return async (task: AiTask): Promise<PhaseHandlerResult> => {
    const { session, runId } = context;
    const artifactDir = runArtifactDir(session.artifactRoot, runId);
    const canonicalRoot = session.repoRoot;
    // Per-issue worktree execution (issue #454). When the session opts into
    // per-issue worktrees the implementation runs INSIDE this issue's own durable
    // worktree (resolved in Step 0.6 below) instead of the shared canonical
    // checkout; until then `cwd` is the canonical checkout so the repo-host auth
    // and dependency-plan reads target the canonical repository. A
    // worktree-disabled session keeps `cwd === canonicalRoot` for the whole run,
    // so its behavior is byte-for-byte unchanged.
    let cwd = canonicalRoot;
    const worktreesEnabled = session.worktrees?.enabled === true;
    const baseBranch = session.baseBranch ?? "main";
    const fixMode = isNeedsFixTask(task);

    const agentId = agentForPhase(task, session, "implementation");
    const escalatedEffort = typeof task.context["escalatedEffort"] === "string"
      ? task.context["escalatedEffort"] as string
      : undefined;
    const taskLabels = Array.isArray(task.context["labels"])
      ? task.context["labels"] as string[]
      : [];
    const cmdSpec = implementationCommand(agentId, taskLabels, escalatedEffort, session.codex);
    if ("error" in cmdSpec) {
      writeAssignmentFailureArtifact(artifactDir, {
        phase: "implementation", agentId, sessionId: task.sessionId, issueNumber: task.issueNumber, runId, error: cmdSpec.error,
      });
      return { result: "failed", error: cmdSpec.error, context: { artifactDir, assignmentError: { phase: "implementation", agent: agentId ?? null } } };
    }
    const resolvedProfile = cmdSpec.profile;

    // Guard: fix mode requires captured review feedback so Claude doesn't run blind.
    const reviewFeedback = fixMode ? getReviewFeedback(task) : undefined;
    if (fixMode && !reviewFeedback) {
      return {
        result: "failed",
        context: { resolvedProfile },
        error:
          `Fix mode requires review feedback in task context. ` +
          `Expected task.context.reviewFeedback to be a non-empty string, ` +
          `but it was ${JSON.stringify(task.context["reviewFeedback"])}. ` +
          `Re-run the review phase so findings are captured before fix mode runs.`,
      };
    }

    try {
      mkdirSync(artifactDir, { recursive: true });
    } catch (err) {
      return {
        result: "failed",
        context: { resolvedProfile },
        error: `Failed to create artifact dir: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Step 0: Fail closed if a prior run quarantined the checkout. A quarantine
    // marker means an earlier late-stage failure left the repository in a state
    // that could not be safely rolled back to the base branch. Running now risks
    // branching issue #N off contaminated state, so refuse until manual recovery.
    if (existsSync(quarantineMarkerPath(session.artifactRoot))) {
      return {
        result: "failed",
        context: { artifactDir, resolvedProfile },
        error:
          `Implementation is quarantined after a prior unrecoverable failure left the worker ` +
          `checkout in an unsafe state. Refusing to run so a contaminated branch cannot become ` +
          `the base for issue #${task.issueNumber}. Manual recovery required: restore the checkout ` +
          `to ${baseBranch} and clear the quarantine marker in the session artifact root.`,
      };
    }

    // Resolve the `gh` executor for this session's configured provider auth.
    // For `gh` mode this is the operator's CLI session (unchanged); for
    // `github-app` mode it injects a refresh-aware installation token so PR/issue
    // API operations run as the App. Resolved once per run before the dependency
    // plan and preflight gates, because the plan resolver needs these runners;
    // the runner refreshes its token per invocation (resolveGhRunner /
    // GitHubAppAuth.getCachedToken). Provider config is optional: an unconfigured
    // session defaults to `gh`, preserving today's behavior.
    //
    // The work-item runner speaks GitHub only and `resolveGhRunner` rejects any
    // non-`gh`/`github-app` auth mode. A non-GitHub work-item provider (e.g.
    // `gitea-issues`, which authenticates by `api-token`) must therefore NOT be
    // resolved through it — doing so would throw and fail every Gitea
    // implementation task before it starts. Such a session reads its `blocked by`
    // relationships through the injected Gitea-aware `depChecker` instead, and
    // Gitea stacking is unsupported (PRs live on the repo host), so no GitHub
    // work-item runner is needed.
    //
    // A leftover `workItemRunner` of `undefined` does NOT by itself disable
    // stacking: the plan resolver would fall back to a `gh` work-item reader and
    // resolve the blocker's readiness from GitHub Issue labels — the wrong
    // tracker. The unsupported-stacking decision is instead driven by passing
    // `workItemKind` to `resolveDependencyExecutionPlan`, which fails closed on
    // an open blocker for any non-`github-issues` provider before any GitHub
    // work-item read.
    const workItemKind = session.workItemProvider?.provider ?? "github-issues";
    let sessionRepoHost: SessionRepoHost;
    let workItemRunner: GhRunner | undefined;
    try {
      const cmdGhRunner = ghRunnerFromCommandRunner(runner);
      // Route repo-host PR work (create / lookup / blocker reads) through the
      // session's configured provider, so a `gitea` repo host uses the Gitea REST
      // client instead of `gh`. For a `github` repo host this resolves the same
      // `gh` executor (operator session or GitHub App) the handler used before, so
      // behavior is unchanged.
      sessionRepoHost = await resolveSessionRepoHost(session.repoHostProvider, {
        githubRepo: session.githubRepo,
        cwd,
        ghRunnerFallback: cmdGhRunner,
      });
      workItemRunner =
        workItemKind === "github-issues"
          ? await resolveGhRunner(session.workItemProvider?.auth ?? { mode: "gh" }, cmdGhRunner)
          : undefined;
    } catch (err) {
      return {
        result: "failed",
        context: { artifactDir, resolvedProfile },
        error: `Failed to resolve repo-host provider: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Step 0.5: Resolve the dependency execution plan for new implementation
    // BEFORE any local repository preflight (issue #224). Running this first
    // ensures a task that is already dependency-blocked never fails on dirty
    // worktree state or contaminated branch state that is unrelated to the
    // actual block. The plan resolver only issues GitHub API calls (gh CLI) —
    // it never reads or modifies the local checkout, so moving it here is safe.
    //
    // It also replaces the prior close-only blocker gate: in addition to
    // refusing when a blocker is unresolved, it enables stacked branch creation
    // when the single open blocker already has a usable PR branch to build on
    // (issue #208).
    //
    // - no open blockers        → branch from the base branch (depBase = undefined)
    // - one usable blocker PR    → fetch the blocker PR head and branch from it
    // - blocked / unsupported    → return blocked without running any git ops
    //
    // Fix mode never stacks — it operates on the issue's own existing PR branch.
    let depBase:
      | { baseIssueNumber: number; basePrNumber: number; baseHeadRefName: string; basePrUrl: string }
      | undefined;
    if (!fixMode && depChecker) {
      let plan: DependencyExecutionPlan;
      try {
        plan = await resolveDependencyExecutionPlan(task.issueNumber, {
          depChecker,
          runner,
          repoHost: sessionRepoHost.provider,
          workItemRunner,
          // Stacking reads the blocker's readiness label from the GitHub
          // work-item tracker, which is only valid for a GitHub work-item
          // session. Pass the configured kind so a `gitea-issues` task fails
          // closed on an open blocker instead of consulting GitHub Issue labels
          // for a same-numbered issue on the wrong tracker.
          workItemProvider: workItemKind,
          githubRepo: session.githubRepo,
          cwd,
          readyForHumanLabel: session.labels.readyForHuman,
          // Accept a reviewed-but-still-stacked blocker as a valid stacking base.
          // Such a blocker is held as `blocked` (never `readyForHuman`) and is
          // tagged with this marker by the review outbox effect (issue #208,
          // A<-B<-C). Must match STACK_READY_LABEL_DEFAULT in outbox-effects.ts.
          stackReadyLabel: session.labels["stackReady"] ?? "status:stack-ready",
        });
      } catch (err) {
        return {
          result: "blocked",
          context: { artifactDir, resolvedProfile },
          message: `Dependency plan resolution failed (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (plan.kind === "blocked" || plan.kind === "unsupported") {
        // Record the FULL relationship list (open + closed), not just the open
        // blockers, so the recheck snapshot matches the DependencyDecision
        // contract and prior close-only behavior for blocked handoffs.
        const dependencyRecheck: DependencyDecision = {
          checkedAt: new Date().toISOString(),
          source: "github-relationships",
          blockedBy: plan.allBlockers,
          blocked: true,
        };
        return {
          result: "blocked",
          context: { artifactDir, dependencyRecheck, resolvedProfile },
          message: plan.reason,
        };
      }

      if (plan.kind === "ready") {
        depBase = {
          baseIssueNumber: plan.baseIssueNumber,
          basePrNumber: plan.basePrNumber,
          baseHeadRefName: plan.baseHeadRefName,
          basePrUrl: plan.basePrUrl,
        };
      }
    }

    // Look up the issue's existing open PR for fix-mode runs BEFORE deciding
    // worktree vs shared checkout (issue #454 review). A worktree-enabled session
    // that first implemented the issue through worktree mode leaves `ai/issue-<n>`
    // checked out in the per-issue worktree, so the next needs-fix run must reuse
    // that same worktree — but it can only decide that once it knows the PR head
    // branch. The lookup is only needed when worktrees are enabled; the shared
    // fix path below resolves its own PR, so a worktree-disabled session keeps its
    // single lookup and unchanged behavior. Fail closed on a lookup error exactly
    // as the shared fix path does.
    let fixPr: PrInfo | undefined;
    if (fixMode && worktreesEnabled) {
      // Resolve via `resolveFixPr` (not `findOpenPr`) so a PR whose head is not the
      // conventional `ai/issue-<n>` — e.g. an externally-created `feature/custom`
      // recorded in the task context — is discovered before worktree routing
      // (issue #455 review). The conventional-only lookup would report it
      // `not-found` here and never reach the worktree fix path below.
      const prInfo = resolveFixPr(sessionRepoHost.provider, task, task.issueNumber);
      if ("error" in prInfo) {
        return { result: "failed", context: { artifactDir, resolvedProfile }, error: prInfo.error };
      }
      fixPr = prInfo;
    }

    // Step 0.6: Materialize the per-issue worktree (issue #454, #455). Every
    // worktree-enabled NEW implementation runs in the per-issue worktree, whether
    // it branches from the session base or stacks on a dependency blocker PR head
    // (issue #455): the blocker head is only the branch START POINT, so a stacked
    // worktree branch keeps the same `ai/issue-<n>` name and the same dependency
    // semantics the shared checkout has — it just runs in the isolated worktree.
    //
    // A fix followup likewise runs in the worktree for ANY open PR head (issue
    // #455), not just the conventional `ai/issue-<n>` branch. The worktree checks
    // out the LIVE PR head discovered from the PR — `ai/issue-<n>` for a
    // worktree-originated PR, or a non-conventional head for an externally-created
    // one — so the agent edits and pushes the real PR branch instead of blindly
    // `ai/issue-<n>`. Without routing into the worktree, a worktree-originated PR's
    // followup would fall back to the shared checkout and `git checkout
    // ai/issue-<n>` would fail because the branch is held by the worktree, breaking
    // every review/fix cycle.
    //
    // Deferring materialization to HERE — after the dependency plan above cleared —
    // means a still-blocked task returns `blocked` WITHOUT any worktree side effect,
    // and a dirty *canonical* checkout can never fail a naturally blocked issue. Once
    // materialized the worktree is checked out on `ai/issue-<n>` by the worktree
    // manager, so the shared-checkout base-reset + branch-creation choreography
    // (Steps 2–3) is skipped below and every downstream git side effect + the agent
    // run uses the worktree as `cwd`.
    const conventionalBranch = branchName(task.issueNumber);
    // New implementation runs in the per-issue worktree whether or not it stacks on
    // a dependency blocker PR head (issue #455). depBase only changes the branch
    // START POINT (handled in Step 0.6 / Step 3 below); the worktree branch is still
    // `ai/issue-<n>`.
    const worktreeNewMode = worktreesEnabled && !fixMode;
    // Fix followups run in the per-issue worktree for any open PR head (issue #455),
    // including a non-conventional one. fixPr is always populated here when fixMode
    // && worktreesEnabled (the lookup above fails closed otherwise), so its presence
    // is what gates worktree fix routing; an empty value would mean a
    // worktree-disabled session, which keeps the shared fix path.
    const worktreeFixMode = worktreesEnabled && fixMode && fixPr !== undefined;
    const worktreeMode = worktreeNewMode || worktreeFixMode;
    // The branch the worktree checks out, commits, and pushes: the LIVE PR head in
    // fix mode (which may be a non-conventional name discovered from the PR), and the
    // conventional `ai/issue-<n>` for new implementation — including a
    // dependency-stacked one, where only the start point differs (issue #455).
    const worktreeBranch = fixPr?.headRefName ?? conventionalBranch;
    // Fail closed on a worktree fix followup for a FORKED (cross-repository) PR (issue
    // #456 review, P2). A forked PR head lives on the contributor's fork, not `origin`,
    // so the only ref that materializes it is `pull/<n>/head`. Reading it is safe, but
    // the downstream `git push origin <branch>` pushes to the BASE repository, not the
    // fork: it would create/advance an unrelated base-repo branch while the real PR on
    // the fork stays untouched, and the returned context would then route
    // review/promotion to code that is NOT in the PR. Until the PR head
    // repository/remote is carried through, refuse the fix rather than push to the wrong
    // place.
    //
    // Detection is the PROVIDER's confirmed cross-repository flag, NOT a `prUrl`-only
    // heuristic. A SAME-repository PR whose head is a non-conventional branch pushed to
    // `origin` also arrives as a `prUrl`-only handoff (no recorded `branch`) — e.g. when
    // a worktree review materialized its head from `prUrl` and the subsequent needs_fix
    // context left `branch` undefined. Those fix cycles fetch and push `headRefName` on
    // origin and work fine, so they must NOT be rejected (issue #456 review). Only a head
    // the provider reports as living in a different repo is refused. (Origin-branch heads
    // — our own `ai/issue-<n>` or a non-conventional head pushed to `origin` — fetch and
    // push by branch name. New implementation never reaches this; it pushes its own
    // `ai/issue-<n>` to origin.)
    if (worktreeFixMode && fixPr?.isCrossRepository === true) {
      const fixPrNumber = extractPrNumber(fixPr.url);
      return {
        result: "failed",
        context: { artifactDir, resolvedProfile },
        error:
          `Refusing to run a worktree fix for issue #${task.issueNumber}${fixPrNumber !== undefined ? ` on PR #${fixPrNumber}` : ""}: its head is on a fork (a cross-repository PR head lives on the contributor's fork, not origin), so pushing fixes to origin would update an unrelated base-repo branch instead of the PR. Carry the PR head repository/remote through before fixing forked PRs in worktree mode.`,
      };
    }
    // Every remaining worktree fix targets an origin branch (our own `ai/issue-<n>` or a
    // non-conventional head pushed to `origin`), so the fetch/reconcile source is just
    // that branch.
    const prHeadFetchSource = worktreeBranch;
    // True when resolveWorktree REUSED an existing `ai/issue-<n>` branch rather than
    // creating it fresh from `baseRef`. The new-impl delayed-retry base refresh below
    // only applies to a reused branch (a fresh one is already at the just-fetched
    // base), so a fresh run keeps its exact command sequence (issue #454 review). Sourced
    // from the resolver's `branchReused` flag (the branch-existence decision), which is
    // tracked INDEPENDENTLY of whether the worktree PATH was newly created: when a prior
    // delayed/quota run leaves an empty `ai/issue-<n>` branch but its worktree dir is
    // later pruned, resolveWorktree recreates the checkout FROM that existing branch
    // (`created: true`, `branchReused: true`) — the branch is still reused and must still
    // be refreshed (issue #455 review).
    let worktreeBranchReused = false;
    let resolvedWorktreeId: string | undefined;
    if (worktreeMode) {
      const issueBranch = worktreeBranch;
      // A grant / manual-done requeue may record `toolRequestResumeBranch ===
      // ai/issue-<n>` as the resume point for this run. Detect it once up front: it
      // gates both the origin-only recovery fetch below AND the resolver's
      // fast-forward allowance (issue #454 review).
      const recordedResumeBranch = task.context["toolRequestResumeBranch"];
      const hasRecordedResumeBranch =
        typeof recordedResumeBranch === "string" && recordedResumeBranch === issueBranch;
      // Start point used ONLY when the issue branch does not already exist (the
      // new-impl case); resolveWorktree ignores it when the branch is present (the
      // fix-followup case, where `ai/issue-<n>` already carries the PR commits).
      let worktreeBaseRef = `origin/${baseBranch}`;

      // Fix followup (worktreeFixMode): when the issue branch already exists locally
      // with the PR commits, do NOT fetch `origin/ai/issue-<n>` here. The worktree
      // reconciliation below (`git pull origin <branch> --ff-only`, Step 3a) fetches
      // and fast-forwards it onto origin — the same reconciliation the shared fix path
      // performs. Refreshing the remote-tracking ref *before* resolveWorktree is
      // unnecessary churn that only feeds a more advanced origin head into the
      // resolver's guard. That guard no longer hard-fails the behind-origin case for
      // a fix followup: `allowFastForward` (set above) lets the resolver accept a
      // merely fast-forwardable PR head — even one whose `refs/remotes/origin/...` an
      // earlier `git fetch`/status recovery already advanced — so it reaches the
      // `--ff-only` reconciliation, which itself still fails closed on a genuinely
      // diverged (force-pushed) head, exactly like the shared checkout path. Skipping
      // the fetch keeps this path side-effect-free on the canonical repo (issue #454
      // review). The fresh/single-branch-clone case where the local branch is absent is
      // handled in the `else` branch below.
      if (!worktreeFixMode) {
        if (depBase) {
          // DEPENDENCY-STACKED NEW IMPLEMENTATION (issue #455): the single open
          // blocker already has a usable PR, so the fresh issue branch must START
          // from the blocker PR head — exactly the start point the shared-checkout
          // dep path uses (`git fetch origin <head>` then `git checkout -b <branch>
          // FETCH_HEAD`). Fetch the blocker head into its remote-tracking ref so
          // `origin/<blockerHead>` resolves as the worktree branch start point that
          // resolveWorktree branches from. Use an explicit, force-updating (`+`)
          // refspec so `refs/remotes/origin/<blockerHead>` updates deterministically
          // regardless of the clone's configured fetch refspec — and, crucially, even
          // when the blocker PR head was force-pushed so the update is a
          // non-fast-forward. The shared dep path fetches the blocker into FETCH_HEAD
          // (which never rejects an amended head); without the leading `+` an explicit
          // refspec would reject a force-updated head as non-fast-forward and fail a
          // valid stacked worktree run before the issue branch is created (issue #458
          // review). Fail closed on a fetch error, mirroring the shared dep path's hard
          // failure. The PR still targets
          // the session base branch (Step 7 below) — only the START POINT is the
          // blocker head.
          const fetchBlocker = runner.run(
            "git",
            ["fetch", "origin", `+${depBase.baseHeadRefName}:refs/remotes/origin/${depBase.baseHeadRefName}`],
            { cwd: canonicalRoot },
          );
          if (fetchBlocker.exitCode !== 0) {
            return {
              result: "failed",
              context: { artifactDir, resolvedProfile },
              error: `git fetch origin ${depBase.baseHeadRefName} (stacked worktree start point) failed (exit ${fetchBlocker.exitCode}): ${(fetchBlocker.stderr || fetchBlocker.stdout).slice(0, 300)}`,
            };
          }
          worktreeBaseRef = `origin/${depBase.baseHeadRefName}`;
        } else {
          // Refresh the base ref in the canonical repo BEFORE branching from it (issue
          // #454 review). The shared-checkout path lands on an up-to-date base via
          // `git checkout <base> && git pull --ff-only`; worktree mode skips that, so
          // without this a long-running worker whose `origin/<base>` remote-tracking ref
          // is stale would start the fresh issue branch behind the real base. Fetch into
          // the canonical repo — whose object store the worktree shares — so the
          // `origin/<base>` start point resolveWorktree branches from is current. Fail
          // closed on a fetch error, mirroring the shared path's hard failure on a failed
          // base pull. Use an explicit `+<base>:refs/remotes/origin/<base>` refspec
          // (issue #457 review, P2): a bare `git fetch origin <base>` only writes
          // `FETCH_HEAD` when the clone's `remote.origin.fetch` does not already track
          // `<base>` (e.g. a single-branch clone checked out elsewhere), leaving
          // `origin/<base>` stale or absent even though the fetch "succeeds". The
          // worktree start point and resume reconciliation below read `origin/<base>`,
          // so the refspec is what guarantees they branch from a current ref.
          const fetchBase = runner.run("git", ["fetch", "origin", `+${baseBranch}:refs/remotes/origin/${baseBranch}`], { cwd: canonicalRoot });
          if (fetchBase.exitCode !== 0) {
            return {
              result: "failed",
              context: { artifactDir, resolvedProfile },
              error: `git fetch origin ${baseBranch} (refresh worktree base) failed (exit ${fetchBase.exitCode}): ${(fetchBase.stderr || fetchBase.stdout).slice(0, 300)}`,
            };
          }
        }

        // Honor an origin-only Tool Request resume branch BEFORE materializing the
        // worktree (issue #454 review). When a grant / manual-done requeue recorded
        // `toolRequestResumeBranch === ai/issue-<n>` but this canonical clone has no
        // local `refs/heads/ai/issue-<n>` (the operator pushed the branch from another
        // clone, or the local ref was pruned), the worktree start point must be the
        // PUSHED resume head — not `origin/<base>`. Otherwise the worktree manager
        // would create `ai/issue-<n>` from `origin/<base>` and the later resume
        // reconciliation (Step 3a) could only fast-forward that branch onto the pushed
        // resume head, which fails outright once `<base>` advanced after the resume
        // branch was pushed — silently dropping a valid recovery point.
        //
        // Fetch the recorded resume branch into its remote-tracking ref so the worktree
        // manager's existing remote-recovery path (worktree.ts: `remoteRefExists`)
        // starts the worktree from `origin/ai/issue-<n>`; the later reconciliation is
        // then a no-op fast-forward. With no recorded resume branch, or when the local
        // branch already exists, this is skipped and the start point stays the one set
        // above (`origin/<base>`, or the blocker head for a dependency-stacked branch).
        if (hasRecordedResumeBranch) {
          const localIssueBranchExists =
            runner.run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${issueBranch}`], {
              cwd: canonicalRoot,
            }).exitCode === 0;
          if (!localIssueBranchExists) {
            // Fetch with an explicit refspec so `refs/remotes/origin/<branch>` is
            // updated deterministically regardless of the clone's configured fetch
            // refspec. Fail closed (mirroring the shared-checkout origin-only resume
            // path) rather than fall through to `origin/<base>` and discard the changes.
            const fetchResume = runner.run(
              "git",
              ["fetch", "origin", `${issueBranch}:refs/remotes/origin/${issueBranch}`],
              { cwd: canonicalRoot },
            );
            if (fetchResume.exitCode !== 0) {
              return {
                result: "failed",
                context: { artifactDir, resolvedProfile },
                error: `git fetch origin ${issueBranch} (recover origin-only Tool Request resume branch as worktree start point) failed (exit ${fetchResume.exitCode}): ${(fetchResume.stderr || fetchResume.stdout).slice(0, 300)}`,
              };
            }
            worktreeBaseRef = `origin/${issueBranch}`;
          }
        }
      } else {
        // FIX FOLLOWUP with NO local issue branch (issue #454 review). The common
        // worktreeFixMode case reuses an `ai/issue-<n>` branch this session's worktree
        // already left checked out, so the skip-the-fetch reasoning above holds. But on
        // a fresh/single-branch clone — a different worker, or after the local ref was
        // pruned — neither `refs/heads/ai/issue-<n>` NOR `refs/remotes/origin/ai/issue-<n>`
        // exists even though `findOpenPr` located the PR head. Without the remote-tracking
        // ref, resolveWorktree's `remoteRefExists` recovery does not fire and it creates
        // `ai/issue-<n>` fresh from `origin/<base>`; if the base advanced after the PR
        // branch was cut, the later `git pull origin ai/issue-<n> --ff-only` (Step 3a)
        // cannot fast-forward the base-rooted branch onto the real PR head and leaves a
        // stale worktree/local branch that blocks every retry. Fetch the PR head into its
        // remote-tracking ref FIRST so resolveWorktree starts the worktree from
        // `origin/ai/issue-<n>` (the PR head) and the `--ff-only` reconciliation is a clean
        // no-op. Fetch with an explicit refspec so `refs/remotes/origin/<branch>` updates
        // deterministically regardless of the clone's configured fetch refspec, and fail
        // closed on a fetch error rather than fall through to a base-derived branch. When
        // the local branch already exists this is skipped — that path keeps its
        // side-effect-free fetch-skip behavior.
        const localIssueBranchExists =
          runner.run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${issueBranch}`], {
            cwd: canonicalRoot,
          }).exitCode === 0;
        if (!localIssueBranchExists) {
          // Fetch FROM `prHeadFetchSource` (the recorded origin head branch) INTO
          // `refs/remotes/origin/<issueBranch>` so a fresh/single-branch clone whose
          // local head ref was pruned still materializes the worktree from the real PR
          // head instead of a base-derived branch (issue #456 review). Forked PRs never
          // reach here — they fail closed above.
          const fetchPrHead = runner.run(
            "git",
            ["fetch", "origin", `${prHeadFetchSource}:refs/remotes/origin/${issueBranch}`],
            { cwd: canonicalRoot },
          );
          if (fetchPrHead.exitCode !== 0) {
            return {
              result: "failed",
              context: { artifactDir, resolvedProfile },
              error: `git fetch origin ${prHeadFetchSource} (materialize fix worktree from PR head) failed (exit ${fetchPrHead.exitCode}): ${(fetchPrHead.stderr || fetchPrHead.stdout).slice(0, 300)}`,
            };
          }
        }
      }

      const materialized = resolveWorktree({
        repoRoot: canonicalRoot,
        sessionId: task.sessionId,
        issueNumber: task.issueNumber,
        branch: issueBranch,
        // A fresh issue branch starts from the latest known remote base (just
        // refreshed above). The PR still targets the session base branch; only the
        // START POINT is set here. For an origin-only Tool Request resume branch this
        // is `origin/ai/issue-<n>` so the worktree recovers the pushed resume head.
        baseRef: worktreeBaseRef,
        // Fix followups reconcile the issue branch with origin via `git pull
        // --ff-only` (Step 3a below), so let the resolver accept a behind-origin
        // (fast-forwardable) PR head instead of failing its remote-head containment
        // guard. Without this, an environment whose earlier `git fetch`/status
        // recovery already advanced `refs/remotes/origin/ai/issue-<n>` past the local
        // branch would hard-fail here before the `--ff-only` pull could catch up —
        // turning a normal behind-origin PR head into a hard failure the shared fix
        // path would have fast-forwarded. A recorded Tool Request resume branch gets
        // the SAME allowance: `resumeFromToolRequestBranch` (below) reconciles its
        // local `ai/issue-<n>` with origin via `git merge --ff-only`, so when the
        // operator pushed the resume side effects from another clone and this clone
        // already fetched (advancing `refs/remotes/origin/ai/issue-<n>` past the local
        // branch), the resolver must accept the fast-forwardable local branch instead
        // of rejecting it here — which would strand a resolved Tool Request before the
        // retry could reconcile. Genuine divergence (force-push) is still rejected by
        // the resolver and again by the `--ff-only` reconciliation. Fresh new
        // implementations (no recorded resume branch) keep the strict guard: a fresh
        // branch starts at the just-fetched base and a leftover diverged ref must
        // still fail closed (issue #454 review).
        allowFastForward: worktreeFixMode || hasRecordedResumeBranch,
        ...(session.worktrees?.root ? { worktreeRoot: session.worktrees.root } : {}),
        runner,
      });
      if (!materialized.ok) {
        return {
          result: "failed",
          context: { artifactDir, resolvedProfile },
          error: `Failed to prepare issue #${task.issueNumber} worktree: ${materialized.error}`,
        };
      }
      cwd = materialized.path;
      resolvedWorktreeId = materialized.worktreeId;
      // Track BRANCH reuse from the resolver's own branch-existence decision, NOT from
      // `materialized.created` (which reports whether the worktree PATH was created).
      // The two diverge in the recoverable delayed-run case: a prior delayed/quota run
      // leaves an empty `ai/issue-<n>` branch, its worktree dir is later pruned, and the
      // resolver recreates the checkout (`created: true`) FROM that existing branch.
      // Keying off `created` would treat the branch as fresh and skip the refresh below,
      // running the retry from the stale old start point (issue #455 review).
      worktreeBranchReused = materialized.branchReused;

    }

    // Step 1: Preflight — reject dirty working tree.
    // In worktree mode `cwd` is the issue's own worktree, so this protects that
    // tree from unrelated changes. A dirty *canonical* checkout is always fatal in
    // worktree mode (issue #571) — checked unconditionally here so the guard
    // applies even when the issue worktree itself is clean. In shared mode the
    // single statusResult check below guards the canonical checkout as before.
    // Exception (issue #571): in per-issue worktree mode a dirty issue-worktree is
    // allowed when the task context carries a dirtyContinuation marker whose safety
    // checks all pass — the dirty state is unfinished work from a prior verification
    // failure for the same issue/branch/worktree, so continuing is safe.
    if (worktreeMode) {
      const canonicalStatus = runner.run("git", ["status", "--porcelain"], { cwd: canonicalRoot });
      if (canonicalStatus.exitCode !== 0 || canonicalStatus.stdout.trim().length > 0) {
        return {
          result: "failed",
          context: { artifactDir, resolvedProfile },
          error: `Canonical checkout is dirty; aborting to prevent unsafe state:\n${canonicalStatus.stdout.slice(0, 300)}`,
        };
      }
    }
    const statusResult = runner.run("git", ["status", "--porcelain"], { cwd });
    let activeDirtyContinuation: Record<string, unknown> | undefined;
    if (statusResult.stdout.trim().length > 0) {
      const savedDirtyCtx = worktreeMode ? task.context["dirtyContinuation"] : undefined;
      if (
        worktreeMode &&
        isValidDirtyContinuation(savedDirtyCtx, task.issueNumber, worktreeBranch, resolvedWorktreeId)
      ) {
        // Guard against drift: verify the current dirty file set exactly matches
        // what was recorded in the marker. If any file was added or removed since
        // the marker was written, the worktree is in an unknown state — fail closed.
        const dc = savedDirtyCtx as Record<string, unknown>;
        const recordedFiles = Array.isArray(dc["dirtyFiles"])
          ? (dc["dirtyFiles"] as string[]).slice().sort()
          : null;
        if (recordedFiles === null) {
          return {
            result: "failed",
            context: { artifactDir, resolvedProfile },
            error: "dirtyContinuation marker is missing dirtyFiles; failing closed to avoid committing unrelated changes.",
          };
        }
        // Re-run with the same flags used when the marker was recorded so path
        // encoding (spaces, non-ASCII, renames) is handled consistently.
        const currentDirtyStatus = runner.run("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd });
        const currentEntries = currentDirtyStatus.stdout.split("\0").filter(Boolean);
        const currentFiles: string[] = [];
        {
          let idx = 0;
          while (idx < currentEntries.length) {
            const entry = currentEntries[idx++];
            if (entry.length < 3) continue;
            const xy = entry.slice(0, 2);
            currentFiles.push(entry.slice(3));
            if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
              idx++; // skip the old-path token for renames/copies
            }
          }
        }
        currentFiles.sort();
        if (
          currentFiles.length !== recordedFiles.length ||
          currentFiles.some((f, i) => f !== recordedFiles[i])
        ) {
          return {
            result: "failed",
            context: { artifactDir, resolvedProfile },
            error:
              "Worktree dirty file set has drifted from the recorded dirtyContinuation marker; " +
              "failing closed to avoid committing unrelated changes.\n" +
              `Recorded: ${recordedFiles.join(", ") || "(none)"}\n` +
              `Current:  ${currentFiles.join(", ") || "(none)"}`,
          };
        }
        // Content drift check: the path set matches, but files may have been edited
        // after the marker was recorded. Re-run git diff HEAD and rebuild the
        // untracked patch in the same format used at recording time, then compare
        // byte-for-byte against the stored patch artifact. Any difference means the
        // dirty content no longer reflects the captured prior attempt — fail closed.
        const priorRunId = typeof dc["runId"] === "string" ? dc["runId"] : null;
        const patchArtifactFile = typeof dc["patchArtifactFile"] === "string" ? dc["patchArtifactFile"] : null;
        // If a patch artifact file was recorded, a valid runId is required to locate it.
        // Without runId, the stored patch cannot be found and content drift cannot be verified —
        // fail closed rather than skipping the comparison.
        if (patchArtifactFile !== null && priorRunId === null) {
          return {
            result: "failed",
            context: { artifactDir, resolvedProfile },
            error:
              "dirtyContinuation marker has a patchArtifactFile but no valid runId; " +
              "failing closed to avoid committing unrelated changes.",
          };
        }
        if (priorRunId !== null && patchArtifactFile !== null) {
          const priorArtifactDir = runArtifactDir(session.artifactRoot, priorRunId);
          let storedPatch: string;
          try {
            storedPatch = readFileSync(join(priorArtifactDir, patchArtifactFile), "utf8");
          } catch {
            return {
              result: "failed",
              context: { artifactDir, resolvedProfile },
              error: "dirtyContinuation patch artifact cannot be read; failing closed to avoid committing unrelated changes.",
            };
          }
          const currentTrackedDiff = runner.run("git", ["diff", "HEAD"], { cwd, maxBuffer: 64 * 1024 * 1024 });
          if (currentTrackedDiff.exitCode !== 0) {
            return {
              result: "failed",
              context: { artifactDir, resolvedProfile },
              error: "Failed to compute current git diff for dirtyContinuation content check; failing closed.",
            };
          }
          const currentUntrackedFiles = currentEntries
            .filter((e) => e.startsWith("?? "))
            .map((e) => e.slice(3));
          const { patch: currentUntrackedPatch, skipped: skippedUntracked } = buildUntrackedPatch(cwd, currentUntrackedFiles);
          // Fail closed when any untracked file was skipped (binary, oversized, non-regular,
          // or inaccessible). Placeholder comments for skipped files contain only name and
          // size, so a different file with the same path and size produces an identical
          // placeholder — the byte-for-byte comparison cannot detect that drift.
          if (skippedUntracked.length > 0) {
            return {
              result: "failed",
              context: { artifactDir, resolvedProfile },
              error:
                "Worktree has untracked files that cannot be content-verified " +
                "(binary, oversized, non-regular, or inaccessible); " +
                "failing closed to avoid committing unrelated changes.\n" +
                `Skipped: ${skippedUntracked.join(", ")}`,
            };
          }
          const currentPatch = currentTrackedDiff.stdout + currentUntrackedPatch;
          if (currentPatch !== storedPatch) {
            return {
              result: "failed",
              context: { artifactDir, resolvedProfile },
              error:
                "Worktree dirty content has drifted from the recorded dirtyContinuation patch; " +
                "failing closed to avoid committing unrelated changes.",
            };
          }
        }
        activeDirtyContinuation = dc;
      } else {
        return {
          result: "failed",
          context: { artifactDir, resolvedProfile },
          error: `Working tree is dirty before implementation; aborting to avoid committing unrelated changes:\n${statusResult.stdout.slice(0, 300)}`,
        };
      }
    }

    // Steps 2–2.1 are the shared-checkout base reset + contamination guard. In
    // worktree mode the issue worktree is already checked out on `ai/issue-<n>` by
    // the worktree manager, so checking out the base branch here would either fail
    // (the base is checked out in the canonical tree and cannot be checked out in a
    // second worktree) or move the worktree off the issue branch. The worktree
    // manager owns this setup, so both steps are skipped (issue #454).
    if (!worktreeMode) {
      // Step 2: Reset to base branch so we start from a clean, up-to-date base
      for (const [cmd, ...args] of [
        ["git", "checkout", baseBranch],
        ["git", "pull", "--ff-only"],
      ] as [string, ...string[]][]) {
        const r = runner.run(cmd, args, { cwd });
        if (r.exitCode !== 0) {
          return {
            result: "failed",
            context: { artifactDir, resolvedProfile },
            error: `${cmd} ${args.join(" ")} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(0, 300)}`,
          };
        }
      }

      // Step 2.1: Verify HEAD actually landed on the base branch before branching.
      // Defense-in-depth against a prior failed run leaving the checkout on a
      // different branch that a silent/no-op checkout did not move. Without this,
      // `git checkout -b` would branch off the wrong HEAD and one issue's commits
      // could become the base of another issue's branch (issue #211).
      const baseHead = currentBranch(runner, cwd);
      if ("error" in baseHead) {
        return { result: "failed", context: { artifactDir, resolvedProfile }, error: baseHead.error };
      }
      if (baseHead.branch !== baseBranch) {
        return {
          result: "failed",
          context: { artifactDir, resolvedProfile },
          error:
            `Expected HEAD to be on base branch '${baseBranch}' after checkout/pull, but it is ` +
            `on '${baseHead.branch}'. Aborting before creating issue #${task.issueNumber}'s branch ` +
            `to avoid branching off contaminated state.`,
        };
      }
    }

    // Step 3a/b: Branch setup — diverges by mode
    // (dep plan was resolved in Step 0.5; depBase is set if kind === "ready")
    let branch: string;
    let prUrl: string | undefined;
    // True when this run resumed an existing `ai/issue-<n>` branch recorded by a
    // Tool Request grant / manual-done recovery (issue #316). Such a branch may
    // already contain the issue's committed implementation, so a no-op agent run
    // is a valid preserved-branch recovery rather than a failed implementation
    // (issue #404). Fresh runs never set this and keep today's no-diff failure.
    let resumedFromToolRequestBranch = false;

    // A Tool Request grant (or the operator following manual-done's guidance) may
    // have already landed the dependency/Tool Request changes on `ai/issue-<n>`
    // (issue #316). When that branch is recorded as the resume point, continue from
    // those changes instead of recreating the branch — this applies in BOTH
    // new-implementation AND dependency-start-point modes (issue #316 review). A
    // plain `git checkout -b` would otherwise collide with the existing local branch
    // or, in dependency mode, branch from the blocker head and discard the pushed
    // side effects. Reuse is gated on the explicit recorded signal so an unexpected
    // leftover branch (e.g. a previously quarantined run) still fails loudly rather
    // than being silently resumed.
    const resumeFromToolRequestBranch = (
      issueBranch: string,
    ): { kind: "resumed" } | { kind: "none" } | { kind: "failed"; result: PhaseHandlerResult } => {
      const resumeBranch = task.context["toolRequestResumeBranch"];
      const wantResume = typeof resumeBranch === "string" && resumeBranch === issueBranch;
      if (!wantResume) return { kind: "none" };

      const localResumeExists =
        runner.run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${issueBranch}`], { cwd }).exitCode === 0;

      if (localResumeExists) {
        const checkoutExisting = runner.run("git", ["checkout", issueBranch], { cwd });
        if (checkoutExisting.exitCode !== 0) {
          return {
            kind: "failed",
            result: {
              result: "failed",
              context: { artifactDir, resolvedProfile },
              error: `git checkout ${issueBranch} (resume Tool Request grant branch) failed (exit ${checkoutExisting.exitCode}): ${(checkoutExisting.stderr || checkoutExisting.stdout).slice(0, 300)}`,
            },
          };
        }
        // The local branch may be stale: a grant created `ai/issue-<n>` here, but
        // the operator then committed/pushed the real Tool Request side effects
        // from another clone, advancing origin/<branch>. Checking out the stale
        // local branch alone would continue without those pushed changes — the
        // exact regression manual-done exists to prevent (issue #316 review).
        // Reconcile with origin with a tri-state remote probe: `git ls-remote
        // --exit-code` exits 2 only when the lookup succeeded but matched no ref
        // (a grant-created branch never pushed — keep the local branch as-is); any
        // other non-zero status is an ambiguous lookup failure that must fail
        // closed rather than silently skip the fast-forward.
        const remoteProbe = runner.run("git", ["ls-remote", "--exit-code", "--heads", "origin", issueBranch], { cwd });
        if (remoteProbe.exitCode !== 0 && remoteProbe.exitCode !== 2) {
          return {
            kind: "failed",
            result: {
              result: "failed",
              context: { artifactDir, resolvedProfile },
              error: `git ls-remote origin ${issueBranch} (reconcile resume Tool Request grant branch) failed (exit ${remoteProbe.exitCode}): ${(remoteProbe.stderr || remoteProbe.stdout).slice(0, 300)} — refusing to continue on a possibly-stale '${issueBranch}' without reconciling with origin`,
            },
          };
        }
        if (remoteProbe.exitCode === 0) {
          // origin has the branch — fast-forward the local branch onto it so the
          // requeued run includes the pushed Tool Request side effects. Fail
          // closed if the local branch diverged rather than continue on stale
          // state.
          const fetchResume = runner.run("git", ["fetch", "origin", issueBranch], { cwd });
          if (fetchResume.exitCode !== 0) {
            return {
              kind: "failed",
              result: {
                result: "failed",
                context: { artifactDir, resolvedProfile },
                error: `git fetch origin ${issueBranch} (reconcile resume Tool Request grant branch) failed (exit ${fetchResume.exitCode}): ${(fetchResume.stderr || fetchResume.stdout).slice(0, 300)}`,
              },
            };
          }
          const ffResume = runner.run("git", ["merge", "--ff-only", "FETCH_HEAD"], { cwd });
          if (ffResume.exitCode !== 0) {
            return {
              kind: "failed",
              result: {
                result: "failed",
                context: { artifactDir, resolvedProfile },
                error: `git merge --ff-only FETCH_HEAD (reconcile resume Tool Request grant branch '${issueBranch}' with origin) failed (exit ${ffResume.exitCode}): ${(ffResume.stderr || ffResume.stdout).slice(0, 300)} — local '${issueBranch}' diverged from origin; reconcile manually`,
              },
            };
          }
          // `git merge --ff-only FETCH_HEAD` is a no-op (exit 0) when the local
          // branch is *ahead* of origin, leaving unpushed local commits in place.
          // Resuming from such a branch would continue from — and later push or
          // delete — commits that were never confirmed pushed, violating the
          // committed-and-pushed resume discipline (issue #316 review). Fail closed
          // so the operator reconciles the unpushed local commits first.
          const aheadResume = runner.run("git", ["rev-list", "--count", "FETCH_HEAD..HEAD"], { cwd });
          if (aheadResume.exitCode !== 0) {
            return {
              kind: "failed",
              result: {
                result: "failed",
                context: { artifactDir, resolvedProfile },
                error: `git rev-list --count FETCH_HEAD..HEAD (check resume Tool Request grant branch '${issueBranch}' is not ahead of origin) failed (exit ${aheadResume.exitCode}): ${(aheadResume.stderr || aheadResume.stdout).slice(0, 300)}`,
              },
            };
          }
          if (aheadResume.stdout.trim() !== "0") {
            return {
              kind: "failed",
              result: {
                result: "failed",
                context: { artifactDir, resolvedProfile },
                error: `local resume Tool Request grant branch '${issueBranch}' is ahead of origin/${issueBranch} by ${aheadResume.stdout.trim()} commit(s); refusing to resume from unpushed local commits. Push or drop the local-only commits on '${issueBranch}' before requeueing`,
              },
            };
          }
        }
        return { kind: "resumed" };
      }

      // The resume branch was recorded but is absent locally: it exists only on
      // origin because the operator committed/pushed the Tool Request side effects
      // from another clone (the manual-done path records the branch when it lives
      // on origin too; issue #316 review). Fetch and check it out so the requeued
      // run continues from those pushed changes. Fail closed rather than falling
      // through to a base/blocker-derived branch, which would silently discard the
      // dependency/Tool Request changes.
      const fetchResume = runner.run("git", ["fetch", "origin", issueBranch], { cwd });
      if (fetchResume.exitCode !== 0) {
        return {
          kind: "failed",
          result: {
            result: "failed",
            context: { artifactDir, resolvedProfile },
            error: `git fetch origin ${issueBranch} (resume Tool Request grant branch from origin) failed (exit ${fetchResume.exitCode}): ${(fetchResume.stderr || fetchResume.stdout).slice(0, 300)}`,
          },
        };
      }
      const checkoutResume = runner.run("git", ["checkout", "-B", issueBranch, "FETCH_HEAD"], { cwd });
      if (checkoutResume.exitCode !== 0) {
        return {
          kind: "failed",
          result: {
            result: "failed",
            context: { artifactDir, resolvedProfile },
            error: `git checkout -B ${issueBranch} FETCH_HEAD (resume Tool Request grant branch from origin) failed (exit ${checkoutResume.exitCode}): ${(checkoutResume.stderr || checkoutResume.stdout).slice(0, 300)}`,
          },
        };
      }
      return { kind: "resumed" };
    };

    if (worktreeMode) {
      // WORKTREE MODE (new implementation — plain OR dependency-stacked — or a fix
      // followup on any open PR head): the worktree manager already checked out the
      // branch when it materialized the worktree in Step 0.6, so there is no branch
      // to create or check out here. Adopt that branch name (`worktreeBranch`): the
      // live PR head in fix mode (possibly non-conventional), the conventional
      // `ai/issue-<n>` for a new implementation. The clean preflight in Step 1 already
      // guarded this tree, and every downstream git op below runs in it.
      branch = worktreeBranch;

      if (worktreeFixMode) {
        // FIX FOLLOWUP IN WORKTREE (issue #454, #455): the worktree already holds the
        // live PR head checked out (resolveWorktree reused/recovered it in Step 0.6),
        // whether that is the conventional `ai/issue-<n>` or a non-conventional head
        // discovered from the PR. A `git checkout` is unnecessary and would in fact
        // fail — the branch is the worktree's own HEAD and Git refuses to check out a
        // branch already checked out in this worktree's tree. Adopt the existing PR
        // url and fast-forward the worktree branch onto origin to pick up any pushed
        // follow-ups: the same reconciliation the shared fix path performs, just
        // inside the worktree. `prUrl` is read from the Step 0.6 lookup, which is
        // always present in this mode (worktreeFixMode requires fixPr); `fixPr?` keeps
        // the narrowing typed without a non-null assertion.
        prUrl = fixPr?.url;
        // Reconcile against `prHeadFetchSource` (the recorded origin head branch) so the
        // followup fast-forwards onto any pushed updates to the real head (issue #456
        // review). A genuinely diverged head still fails closed on `--ff-only`.
        // Skip when a dirtyContinuation is active: the worktree has uncommitted edits
        // from a prior verification failure that the agent needs to repair and commit.
        // A --ff-only pull over dirty files aborts, defeating the purpose of allowing
        // the dirty continuation in the first place. However, we must still guard
        // against the remote head having advanced since the previous failed verification:
        // if origin/<prHeadFetchSource> has moved past the local HEAD, the agent would
        // repair against stale files and the eventual push would fail non-fast-forward.
        // Fail closed in that case — the safe option (issue #571 review).
        if (!activeDirtyContinuation) {
          const pullBranch = runner.run("git", ["pull", "origin", prHeadFetchSource, "--ff-only"], { cwd });
          if (pullBranch.exitCode !== 0) {
            return {
              result: "failed",
              context: { artifactDir, resolvedProfile },
              error: `git pull origin ${prHeadFetchSource} failed (exit ${pullBranch.exitCode}): ${(pullBranch.stderr || pullBranch.stdout).slice(0, 300)}`,
            };
          }
        } else {
          // Dirty continuation: pull is skipped, but verify the remote head has not
          // advanced past the local HEAD (issue #571). Fetch the PR head first so the
          // remote-tracking ref is up-to-date; a stale or missing ref here could let a
          // diverged PR branch through and waste a repair run before failing at push.
          // Fail closed if the fetch itself fails.
          const fetchPrHead = runner.run("git", ["fetch", "origin", prHeadFetchSource], { cwd });
          if (fetchPrHead.exitCode !== 0) {
            return {
              result: "failed",
              context: { artifactDir, resolvedProfile },
              error: `dirty continuation aborted: git fetch origin ${prHeadFetchSource} failed (exit ${fetchPrHead.exitCode}): ${(fetchPrHead.stderr || fetchPrHead.stdout).slice(0, 300)}`,
            };
          }
          const localHead = runner.run("git", ["rev-parse", "HEAD"], { cwd });
          if (localHead.exitCode !== 0) {
            return {
              result: "failed",
              context: { artifactDir, resolvedProfile },
              error: `dirty continuation aborted: could not resolve local HEAD (exit ${localHead.exitCode}): ${(localHead.stderr || localHead.stdout).slice(0, 300)}`,
            };
          }
          // Always prefer FETCH_HEAD — it was just populated by the fetch above and is
          // guaranteed fresh. In narrow-clone setups the configured fetch refspec may
          // exclude this branch, so `git fetch origin <branch>` updates FETCH_HEAD but
          // leaves refs/remotes/origin/<branch> pointing at a stale commit; preferring
          // the tracking ref in that case would compare local HEAD to stale data and
          // silently allow a dirty continuation after the remote PR head advanced.
          // Fall back to the tracking ref only when FETCH_HEAD is somehow absent.
          // Fail closed if neither resolves — we cannot validate the PR head.
          const fetchHeadResolved = runner.run("git", ["rev-parse", "FETCH_HEAD"], { cwd });
          const remoteHeadSha =
            fetchHeadResolved.exitCode === 0
              ? fetchHeadResolved.stdout.trim()
              : (() => {
                  const trackingRef = runner.run("git", ["rev-parse", `refs/remotes/origin/${prHeadFetchSource}`], { cwd });
                  return trackingRef.exitCode === 0 ? trackingRef.stdout.trim() : null;
                })();
          if (remoteHeadSha === null) {
            return {
              result: "failed",
              context: { artifactDir, resolvedProfile },
              error: `dirty continuation aborted: could not resolve remote head for origin/${prHeadFetchSource} (tracking ref absent and FETCH_HEAD unresolvable); cannot validate PR head`,
            };
          }
          if (localHead.stdout.trim() !== remoteHeadSha) {
            return {
              result: "failed",
              context: { artifactDir, resolvedProfile },
              error: `dirty continuation aborted: origin/${prHeadFetchSource} has advanced past local HEAD (local=${localHead.stdout.trim().slice(0, 12)}, remote=${remoteHeadSha.slice(0, 12)}); cannot safely continue from dirty worktree onto a stale base`,
            };
          }
        }
      } else {
        // DELAYED-RETRY START-POINT REFRESH (issue #454 review, #455): a prior
        // quota/rate-limit discard (discardEditsToBase) KEEPS `ai/issue-<n>` in
        // worktree mode rather than deleting it, so resolveIssueWorktree reused that
        // existing branch in Step 0.6 and IGNORED the freshly-fetched start point. When
        // the discard happened before any commit, the branch is an empty placeholder
        // still rooted at the start point captured when it was first created; by this
        // retry that start point may have advanced. Reset such a branch onto the
        // just-fetched start point so the retry — and its eventual PR — builds on the
        // current code, matching the shared path, which gets the same result by deleting
        // the branch and re-running `git checkout -b <branch> <start>`. The start point
        // is the dependency blocker PR head for a stacked branch (issue #455) and
        // `origin/<base>` otherwise — both were refreshed into their remote-tracking ref
        // in Step 0.6. Guarded three ways: only when the branch was REUSED (a freshly
        // created branch already starts at the just-fetched start point, so its command
        // sequence stays untouched); skip when a Tool Request resume branch is recorded
        // (its commits are the resume point, handled below — never an empty placeholder);
        // and only reset a branch with NO issue-specific commits beyond the start point so
        // any real partial/committed work is preserved untouched. A missing start-point ref
        // leaves the probe non-zero and is skipped.
        //
        // The emptiness probe is `rev-list --count --right-only --cherry-pick
        // <start>...<branch>`, NOT the plainer two-dot `<start>..<branch>` (issue #458
        // review). A force-push or rebase of the blocker PR head (the stacked start point)
        // rewrites `origin/<blocker>` to a new lineage; the empty placeholder still sits on
        // the OLD blocker head, so a two-dot count would report the old blocker commits as
        // commits "ahead" of the new start point and skip the reset — leaving the retry
        // stacked on stale blocker code. `--right-only --cherry-pick` over the symmetric
        // difference drops every branch-side commit that is patch-equivalent to a start-ref
        // commit (the rebased blocker commits cancel out), so the count reflects only
        // genuine issue-specific work: 0 for a true empty placeholder regardless of whether
        // the blocker was rewritten, non-zero only when the agent actually committed
        // implementation work (which is preserved). A non-fast-forward base receives the
        // same treatment; the fast-forward case is unaffected (no patch-equivalent commits
        // to cancel).
        const recordedResume = task.context["toolRequestResumeBranch"];
        const hasRecordedResume = typeof recordedResume === "string" && recordedResume === branch;
        const retryStartRef = depBase ? `origin/${depBase.baseHeadRefName}` : `origin/${baseBranch}`;
        // Skip the empty-branch probe when dirty continuation is active: the worktree
        // has 0 commits beyond base (commitSkipped: true) but the dirty edits from the
        // prior attempt are what we want to continue from — resetting to base would
        // wipe them (issue #571).
        if (worktreeBranchReused && !hasRecordedResume && !activeDirtyContinuation) {
          const aheadOfBase = runner.run(
            "git",
            ["rev-list", "--count", "--right-only", "--cherry-pick", `${retryStartRef}...${branch}`],
            { cwd },
          );
          if (aheadOfBase.exitCode === 0 && aheadOfBase.stdout.trim() === "0") {
            const resetBase = runner.run("git", ["reset", "--hard", retryStartRef], { cwd });
            if (resetBase.exitCode !== 0) {
              return {
                result: "failed",
                context: { artifactDir, resolvedProfile },
                error: `git reset --hard ${retryStartRef} (refresh empty delayed worktree branch) failed (exit ${resetBase.exitCode}): ${(resetBase.stderr || resetBase.stdout).slice(0, 300)}`,
              };
            }
          }
        }

        // NEW IMPLEMENTATION: honor a recorded Tool Request resume branch (issue #454
        // review). A grant / manual-done may have already committed the Tool Request
        // side effects onto `ai/issue-<n>`, which resolveIssueWorktree just checked
        // out into this worktree. Reconcile that branch with origin and mark the run
        // resumed so a correct no-op agent run (the changes are already committed) is
        // treated as a preserved-branch recovery (issue #404) rather than a fresh
        // no-op failure. With no recorded resume branch this returns early without any
        // git ops, so a fresh implementation keeps today's behavior.
        const resumed = resumeFromToolRequestBranch(branch);
        if (resumed.kind === "failed") return resumed.result;
        if (resumed.kind === "resumed") resumedFromToolRequestBranch = true;
      }
    } else if (fixMode) {
      // FIX MODE (shared checkout): reached only by a worktree-DISABLED session
      // (issue #455 routes every worktree-enabled fix, including a non-conventional
      // PR head, into the worktree above). fixPr is therefore undefined here, so
      // resolve the PR now — unchanged worktree-disabled behavior. Check out its
      // branch and pull latest.
      const prInfo = fixPr ?? findOpenPr(sessionRepoHost.provider, task.issueNumber);
      if ("error" in prInfo) {
        return { result: "failed", context: { artifactDir, resolvedProfile }, error: prInfo.error };
      }
      branch = prInfo.headRefName;
      prUrl = prInfo.url;

      const checkoutExisting = runner.run("git", ["checkout", branch], { cwd });
      if (checkoutExisting.exitCode !== 0) {
        return {
          result: "failed",
          context: { artifactDir, resolvedProfile },
          error: `git checkout ${branch} failed (exit ${checkoutExisting.exitCode}): ${(checkoutExisting.stderr || checkoutExisting.stdout).slice(0, 300)}`,
        };
      }

      const pullBranch = runner.run("git", ["pull", "origin", branch, "--ff-only"], { cwd });
      if (pullBranch.exitCode !== 0) {
        return {
          result: "failed",
          context: { artifactDir, resolvedProfile },
          error: `git pull origin ${branch} failed (exit ${pullBranch.exitCode}): ${(pullBranch.stderr || pullBranch.stdout).slice(0, 300)}`,
        };
      }

    } else if (depBase) {
      // DEPENDENCY START-POINT MODE (shared checkout): reached only by a
      // worktree-DISABLED session (issue #455 runs a worktree-enabled stacked
      // implementation in the worktree above). The single open blocker already has a
      // usable PR; build this issue's branch on top of the blocker PR head instead of
      // the (stale) base branch so the implementation compiles against the blocker's
      // changes.
      branch = branchName(task.issueNumber);

      // First honor a Tool Request resume branch: a grant/manual-done may have
      // already landed the dependency/Tool Request side effects on `ai/issue-<n>`
      // (created from this same blocker head), so resume from there rather than
      // recreating the branch and colliding/discarding the changes (issue #316
      // review).
      const resumed = resumeFromToolRequestBranch(branch);
      if (resumed.kind === "failed") return resumed.result;
      if (resumed.kind === "resumed") resumedFromToolRequestBranch = true;
      if (resumed.kind === "none") {
        // No recorded resume point — create the branch from the blocker head.
        // Fetch the blocker head explicitly and branch directly from the fetched
        // commit (FETCH_HEAD) so we never depend on a stale local branch or a
        // remote-tracking ref that may be absent in a fresh/single-branch clone
        // (issue #208). The PR itself still targets the session base branch
        // (`main`) — only the branch START POINT is the blocker head (issue #242).
        const fetchHead = runner.run("git", ["fetch", "origin", depBase.baseHeadRefName], { cwd });
        if (fetchHead.exitCode !== 0) {
          return {
            result: "failed",
            context: { artifactDir, resolvedProfile },
            error: `git fetch origin ${depBase.baseHeadRefName} failed (exit ${fetchHead.exitCode}): ${(fetchHead.stderr || fetchHead.stdout).slice(0, 300)}`,
          };
        }
        const checkoutStacked = runner.run("git", ["checkout", "-b", branch, "FETCH_HEAD"], { cwd });
        if (checkoutStacked.exitCode !== 0) {
          return {
            result: "failed",
            context: { artifactDir, resolvedProfile },
            error: `git checkout -b ${branch} FETCH_HEAD failed (exit ${checkoutStacked.exitCode}): ${(checkoutStacked.stderr || checkoutStacked.stdout).slice(0, 300)}`,
          };
        }
      }
    } else {
      // NEW IMPLEMENTATION MODE: create fresh branch explicitly from the base
      // branch. Naming the start point makes the base independent of the current
      // HEAD, so even an unexpected checkout state cannot leak into the new
      // branch (belt-and-suspenders with the Step 2.1 HEAD verification).
      branch = branchName(task.issueNumber);

      // A Tool Request grant during initial implementation may have already created
      // this issue branch and committed the dependency/Tool Request changes onto it
      // (issue #316). Resume from that recorded branch when present; otherwise create
      // the branch fresh from the base branch.
      const resumed = resumeFromToolRequestBranch(branch);
      if (resumed.kind === "failed") return resumed.result;
      if (resumed.kind === "resumed") resumedFromToolRequestBranch = true;
      if (resumed.kind === "none") {
        const checkoutBranch = runner.run("git", ["checkout", "-b", branch, baseBranch], { cwd });
        if (checkoutBranch.exitCode !== 0) {
          return {
            result: "failed",
            context: { artifactDir, resolvedProfile },
            error: `git checkout -b ${branch} failed (exit ${checkoutBranch.exitCode}): ${(checkoutBranch.stderr || checkoutBranch.stdout).slice(0, 300)}`,
          };
        }
      }
    }

    // After this point a branch exists (and, past the commit step, a commit on
    // it). Any late failure must leave the repository in a predictable safe
    // state so the next run does not inherit a contaminated checkout. If the
    // worktree is clean we return to the base branch; if it cannot be safely
    // restored we quarantine and fail closed (issue #211).
    const failAfterBranch = (
      step: string,
      failResult: PhaseHandlerResult & { result: "failed" },
    ): PhaseHandlerResult => {
      // In worktree mode a late failure leaves the issue worktree intact: it is an
      // isolated, durable continuation point, so there is no shared checkout to
      // restore to base and no quarantine to set (the quarantine marker is a
      // shared-checkout backstop only — issue #454). Surface the failure as-is.
      if (worktreeMode) return failResult;
      const status = runner.run("git", ["status", "--porcelain"], { cwd });
      const clean = status.exitCode === 0 && status.stdout.trim().length === 0;
      if (clean) {
        const restore = runner.run("git", ["checkout", baseBranch], { cwd });
        if (restore.exitCode === 0) return failResult;
      }
      writeQuarantineMarker(session.artifactRoot, {
        issueNumber: task.issueNumber,
        sessionId: task.sessionId,
        runId,
        branch,
        step,
      });
      return {
        ...failResult,
        error:
          `${failResult.error}\n\nThe worker checkout could not be safely restored to '${baseBranch}'; ` +
          `implementation has been quarantined and later runs will fail closed until manually recovered.`,
      };
    };

    // Tool Request handoff (issue #291). A non-interactive agent that needs a
    // command outside its allowed tool set emits a structured Tool Request block
    // and stops instead of running it. The requested command is NEVER executed;
    // the task is handed to a human with the request metadata captured in context.
    // Any uncommitted edits the agent made before stopping are discarded so the
    // worker checkout returns to a safe base for later runs. This is shared by the
    // initial implementation agent and the verification-repair agent, since a
    // repair attempt can be the first place a disallowed command is discovered.
    // Restore the checkout to the base branch, discarding the agent's
    // uncommitted edits, then drop the freshly-created issue branch (new-impl
    // mode only — fix mode operates on the existing PR branch and must keep it).
    // Best-effort: a restore failure does not change the handoff outcome, but the
    // next run's dirty-tree/HEAD preflight remains a backstop. Shared by the
    // generic Tool Request handoff and the dependency-update handoff, both of
    // which may leave uncommitted edits (the latter also a manifest edit it made).
    // Relative name (within this run's artifact dir) of the patch capturing the
    // agent's uncommitted partial implementation, written by capturePartialDiff
    // when any partial work existed (issue #379). Never an absolute path so it is
    // safe to persist in task context, and it is never surfaced in public comments.
    const PARTIAL_DIFF_ARTIFACT = "partial-implementation.patch";

    // Issue #379: a Tool Request (or quota) handoff discards the agent's
    // uncommitted partial implementation — new files, edits — with `git checkout
    // -f` + `git clean -fd` (+ `git branch -D`). Implementation agents do not
    // commit before a Tool Request, so that diff is real, unrecoverable work and
    // its loss makes the next run re-derive the same blocker and re-emit the same
    // request (a Tool Request loop). Before the discard, snapshot the full partial
    // diff (tracked edits AND untracked new files) into a patch artifact so the
    // work is preserved and an operator (or a recovery step) can reapply it with
    // `git apply`.
    //
    // Issue #390: capture is best-effort and the prior "return undefined on any
    // failure" lost the distinction between "there was genuinely no diff" and
    // "there was a diff but capture failed". That distinction decides whether the
    // new-impl issue branch — the ONLY remaining continuation point once the patch
    // is absent — may be safely deleted. So return a tri-state result instead:
    //   - captured: a reappliable patch was written
    //   - empty:    `git add -A` succeeded and the staged tree equals HEAD, so
    //               there is provably no diff to preserve (safe to drop the branch)
    //   - failed:   a git/IO error means a diff may exist but could not be
    //               snapshotted (must NOT silently drop the branch)
    const capturePartialDiff = (): PartialDiffCapture => {
      const relArtifactRoot = relative(cwd, session.artifactRoot);
      // Stage everything so untracked new files are included in the diff. Exclude
      // the artifact dir (untracked-but-not-ignored, holding this run's records)
      // when it lives inside the repo so it is not swept into the patch.
      const addArgs = ["add", "-A", "--"];
      if (!relArtifactRoot.startsWith("..")) {
        addArgs.push(".", `:(exclude)${relArtifactRoot}`, `:(exclude)${relArtifactRoot}/**`);
      } else {
        addArgs.push(".");
      }
      const added = runner.run("git", addArgs, { cwd });
      if (added.exitCode !== 0) {
        return { kind: "failed", reason: `git ${addArgs.join(" ")} failed (exit ${added.exitCode}): ${(added.stderr || added.stdout).slice(0, 200)}` };
      }
      // Diff the staged tree against HEAD (the issue branch tip — equal to the
      // base for a fresh new-impl branch, or the PR head in fix mode) so the patch
      // contains exactly the agent's partial work. `--binary` keeps it reappliable.
      // A substantial partial implementation can exceed the default 1 MB capture
      // buffer; raise it so the whole point of this snapshot — not losing the work
      // — is not defeated by a buffer overflow turning into an empty capture.
      const diff = runner.run("git", ["diff", "--cached", "--binary", "HEAD"], { cwd, maxBuffer: 64 * 1024 * 1024 });
      if (diff.exitCode !== 0) {
        return { kind: "failed", reason: `git diff --cached --binary HEAD failed (exit ${diff.exitCode}): ${(diff.stderr || diff.stdout).slice(0, 200)}` };
      }
      if (diff.stdout.trim().length === 0) {
        // `git add -A` succeeded and the staged tree matches HEAD: the agent left
        // no file changes, so there is genuinely nothing to preserve.
        return { kind: "empty" };
      }
      try {
        writeFileSync(join(artifactDir, PARTIAL_DIFF_ARTIFACT), diff.stdout, "utf8");
        return { kind: "captured", artifact: PARTIAL_DIFF_ARTIFACT };
      } catch (err) {
        return { kind: "failed", reason: `writing ${PARTIAL_DIFF_ARTIFACT} failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    };

    // Restore the worktree to a clean base branch (shared cleanup). `git checkout
    // -f` reverts tracked files but leaves untracked files the agent may have
    // created; those would trip the next phase run's dirty-tree preflight, so
    // remove them too — but never the artifact dir (untracked-but-not-ignored,
    // holding this run's audit records) when it lives inside the repo.
    const restoreWorktreeToBase = (): void => {
      if (worktreeMode) {
        // In the per-issue worktree the base branch is checked out by the canonical
        // repo (git refuses to check it out a second time) and `ai/issue-<n>` is the
        // durable worktree branch, so never `git checkout -f <base>` — it would fail
        // and leave the tree dirty, or move the worktree off its issue branch. Reset
        // the worktree to its own HEAD (the issue branch tip) so the next run's
        // preflight sees a clean tree while the worktree stays on the issue branch
        // (issue #454 review).
        runner.run("git", ["reset", "--hard", "HEAD"], { cwd });
      } else {
        runner.run("git", ["checkout", "-f", baseBranch], { cwd });
      }
      const relArtifactRoot = relative(cwd, session.artifactRoot);
      const cleanArgs = ["clean", "-fd"];
      if (!relArtifactRoot.startsWith("..")) {
        cleanArgs.push("-e", relArtifactRoot);
      }
      runner.run("git", cleanArgs, { cwd });
    };

    // Full discard: capture the partial work, restore the worktree to base, and
    // drop the freshly-created new-impl issue branch. Used by the quota/rate-limit
    // delayed path (issue #25), which re-queues the SAME implementation run — that
    // retry re-creates `ai/issue-<n>` with `git checkout -b`, so the branch MUST
    // be deleted here or the retry collides. Returns the capture result so callers
    // can record/inspect what was preserved.
    const discardEditsToBase = (): PartialDiffCapture => {
      // Preserve the partial work as a patch artifact BEFORE the destructive
      // cleanup below removes it (issue #379).
      const capture = capturePartialDiff();
      restoreWorktreeToBase();
      // Never delete the issue branch in worktree mode: `ai/issue-<n>` is the durable
      // per-issue worktree branch, so the delayed retry re-materializes the SAME
      // worktree on it (there is no `git checkout -b` to collide with), and
      // `git branch -D` cannot delete a branch checked out in the current worktree
      // anyway (issue #454 review). In shared mode drop the freshly-created new-impl
      // branch so the retry's `git checkout -b` does not collide.
      if (!fixMode && !worktreeMode) {
        runner.run("git", ["branch", "-D", branch], { cwd });
      }
      return capture;
    };

    // Tool Request handoff cleanup (issue #379, #390). Like discardEditsToBase,
    // but a Tool Request leaves the task as a human handoff (ready_for_human) whose
    // ONLY continuation point, once the patch is absent and no PR exists, is the
    // issue branch. So in new-impl mode this NEVER deletes the issue branch when
    // doing so would lose the agent's work irrecoverably:
    //   - captured / empty: safe to drop the branch — the work is in the patch, or
    //     there provably was none.
    //   - failed: a diff may exist but could not be snapshotted. Commit the staged
    //     partial work onto the issue branch and keep it (pushing best-effort) so
    //     an operator can resume; never `git branch -D` it.
    // Fix mode keeps the existing PR branch regardless (its work is already there).
    const handoffCleanup = (): HandoffPreservation => {
      const capture = capturePartialDiff();

      // Worktree mode: `ai/issue-<n>` is the durable per-issue worktree branch and the
      // handoff's continuation point, so it is NEVER deleted and the worktree is NEVER
      // switched to base (issue #454 review): `git checkout -f <base>` would fail (the
      // base is checked out in the canonical repo) and `git branch -D` would either
      // fail or drop the only resume point. When the agent produced work, commit the
      // staged partial implementation (capturePartialDiff already ran `git add -A`)
      // onto the branch and push best-effort so a later grant resumes from a real
      // commit (issue #404, #454 review); an empty run leaves the branch at its start
      // point with nothing to preserve.
      if (worktreeMode) {
        if (capture.kind === "empty") {
          return { noPriorDiff: true };
        }
        const committed = runner.run("git", ["commit", "--no-verify", "-m",
          `wip: preserve partial implementation for issue #${task.issueNumber} (tool-request handoff)`], { cwd });
        if (committed.exitCode === 0) {
          const pushed = runner.run("git", ["push", "origin", branch], { cwd });
          return {
            noPriorDiff: false,
            ...(capture.kind === "captured" ? { partialDiffArtifact: capture.artifact } : {}),
            ...(capture.kind === "failed" ? { partialDiffCaptureFailed: capture.reason } : {}),
            preservedBranch: branch,
            preservedBranchPushed: pushed.exitCode === 0,
          };
        }
        // Commit failed (nothing staged, or a deeper git error). Reset the worktree
        // to a clean tree — staying on the issue branch — so the next run's preflight
        // passes; any work still survives in the captured patch. Advertise the branch
        // as the resume point only when it provably carries committed work beyond base
        // (a probe failure must not be read as "safe to drop the branch").
        restoreWorktreeToBase();
        const ahead = runner.run("git", ["rev-list", "--count", `${baseBranch}..${branch}`], { cwd });
        const hasCommits = ahead.exitCode === 0 && ahead.stdout.trim() !== "0";
        return {
          noPriorDiff: false,
          ...(capture.kind === "captured" ? { partialDiffArtifact: capture.artifact } : {}),
          ...(capture.kind === "failed" ? { partialDiffCaptureFailed: capture.reason } : {}),
          ...(hasCommits ? { preservedBranch: branch, preservedBranchPushed: false } : {}),
        };
      }

      if (!fixMode && capture.kind === "failed") {
        // capturePartialDiff's `git add -A` already staged whatever the agent
        // produced; the failure was in diffing/writing the patch, not in detecting
        // changes. Commit that staged work onto the issue branch so the branch is a
        // real resume point rather than an empty ref. `--no-verify` skips any
        // pre-commit hooks: this is a best-effort preservation commit, and a hook
        // failure must not defeat the whole point of not losing the work.
        const committed = runner.run("git", ["commit", "--no-verify", "-m",
          `wip: preserve partial implementation for issue #${task.issueNumber} (tool-request handoff; patch capture failed)`], { cwd });
        if (committed.exitCode === 0) {
          // Push so the branch is a durable, operator-visible resume point that a
          // later handoff's `git branch -D` (in another run) cannot lose. Push is
          // best-effort: if it fails the local branch is still kept and the admin
          // resolve guidance tells the operator to push it before resolving.
          const pushed = runner.run("git", ["push", "origin", branch], { cwd });
          restoreWorktreeToBase();
          return {
            noPriorDiff: false,
            partialDiffCaptureFailed: capture.reason,
            preservedBranch: branch,
            preservedBranchPushed: pushed.exitCode === 0,
          };
        }
        // Could not commit (nothing staged, or a deeper git error). Restore the
        // shared worktree so later runs are not blocked by a dirty tree — but that
        // restore discards this run's uncommitted/index state, so the branch can
        // only be a real continuation point if it ALREADY carries committed work
        // (e.g. a resumed `ai/issue-<n>` with the operator's earlier commits). A
        // freshly-created new-impl branch that still points at base preserves
        // NOTHING after the restore: advertising it would send the operator to
        // resume from base and silently drop the partial work — the exact failure
        // this review guards against (issue #390 review). So only keep+advertise the
        // branch when it provably has commits beyond base; when it provably does
        // not, delete the empty ref so admin resolve cannot mistake it for a resume
        // point and instead routes to the capture-failure recovery (reconstruct from
        // the run artifacts) recorded via partialDiffCaptureFailed below.
        restoreWorktreeToBase();
        const ahead = runner.run("git", ["rev-list", "--count", `${baseBranch}..${branch}`], { cwd });
        const provablyEmpty = ahead.exitCode === 0 && ahead.stdout.trim() === "0";
        if (provablyEmpty) {
          runner.run("git", ["branch", "-D", branch], { cwd });
          return {
            noPriorDiff: false,
            partialDiffCaptureFailed: capture.reason,
          };
        }
        // The branch carries committed work, or we could not prove it empty (a
        // probe failure must not be read as "safe to delete" — fail closed and
        // keep the only potential continuation point). Push best-effort so the ref
        // is durable; a push failure still leaves the local branch as a resume
        // point, and the admin guidance tells the operator to push it first.
        const pushed = runner.run("git", ["push", "origin", branch], { cwd });
        return {
          noPriorDiff: false,
          partialDiffCaptureFailed: capture.reason,
          preservedBranch: branch,
          preservedBranchPushed: pushed.exitCode === 0,
        };
      }

      // captured / empty (or fix mode): safe to fully discard. Captured work lives
      // in the patch; empty means there is provably no diff to preserve. Fix mode
      // also reaches here on capture.kind === "failed": its work is already on the
      // existing PR branch (kept regardless), so there is no continuation point to
      // protect — but the repair edits made this run were still discarded with no
      // patch written, so record WHY (issue #390 review) instead of letting the
      // stored request look like it simply had no diff.
      restoreWorktreeToBase();
      if (!fixMode) {
        runner.run("git", ["branch", "-D", branch], { cwd });
      }
      return {
        ...(capture.kind === "captured" ? { partialDiffArtifact: capture.artifact } : {}),
        ...(capture.kind === "failed" ? { partialDiffCaptureFailed: capture.reason } : {}),
        noPriorDiff: capture.kind === "empty",
      };
    };

    const storeToolRequest = (
      toolRequest: ToolRequest,
      preservation: HandoffPreservation,
    ): StoredToolRequest => {
      const priorRequest = task.context["toolRequest"] as Record<string, unknown> | undefined;
      const priorResolution = priorRequest?.["resolution"] as Record<string, unknown> | undefined;
      const repeatedAfterManualDone =
        priorRequest?.["resolved"] === true &&
        priorResolution?.["action"] === "manual-done" &&
        priorRequest?.["command"] === toolRequest.command;

      return {
        ...toolRequest,
        requestedBy: agentId ?? resolvedProfile.agentId,
        mode: fixMode ? "fix" : "new",
        requestedAt: new Date().toISOString(),
        resolved: false,
        ...(repeatedAfterManualDone ? { repeatedAfterManualDone: true } : {}),
        // Record the preserved partial-work patch (issue #379) so an operator can
        // see — via `admin tool-request list` and the artifact dir — that the
        // handoff did not silently discard the agent's work.
        ...(preservation.partialDiffArtifact ? { partialDiffArtifact: preservation.partialDiffArtifact } : {}),
        // Issue #390: record WHY there is no patch / where the work went so the
        // operator-facing guidance is accurate per case rather than always
        // pointing at a maybe-nonexistent patch.
        ...(preservation.noPriorDiff ? { noPriorDiff: true } : {}),
        ...(preservation.partialDiffCaptureFailed ? { partialDiffCaptureFailed: preservation.partialDiffCaptureFailed } : {}),
        ...(preservation.preservedBranch ? { preservedBranch: preservation.preservedBranch } : {}),
        ...(preservation.preservedBranch ? { preservedBranchPushed: preservation.preservedBranchPushed === true } : {}),
      };
    };

    // Detect repeat Tool Requests to suppress duplicate public comments (issue #300).
    // `task.context.toolRequest` holds the previous stored request — checked before
    // the transition merges the new one in. Shared by the generic and dependency
    // handoffs so a repeated dependency request is suppressed/diagnosed the same way.
    const toolRequestRepeatKind = (
      command: string,
    ): "unresolved-duplicate" | "resolved-duplicate" | undefined => {
      const prevTrRaw = task.context["toolRequest"];
      if (prevTrRaw === null || typeof prevTrRaw !== "object" || Array.isArray(prevTrRaw)) {
        return undefined;
      }
      const prevTr = prevTrRaw as Record<string, unknown>;
      const prevCmd = typeof prevTr["command"] === "string" ? prevTr["command"] : "";
      if (
        prevCmd.length === 0 ||
        normalizeToolRequestCommand(prevCmd) !== normalizeToolRequestCommand(command)
      ) {
        return undefined;
      }
      if (prevTr["resolved"] === true) {
        const prevResolution =
          prevTr["resolution"] !== null &&
          typeof prevTr["resolution"] === "object" &&
          !Array.isArray(prevTr["resolution"])
            ? (prevTr["resolution"] as Record<string, unknown>)
            : undefined;
        return prevResolution?.["action"] === "manual-done" ? "resolved-duplicate" : undefined;
      }
      return "unresolved-duplicate";
    };

    // The work branch to persist across a Tool Request handoff so a later grant
    // lands the granted command on the SAME branch this run worked on. Record it
    // ONLY for a real PR head — a fix followup's live PR branch, which in worktree
    // mode may be a non-conventional head resolved from `prUrl` (issue #459 review,
    // P2). For a fresh initial implementation (plain or dependency-stacked) there
    // is no PR yet and `branch` is just the conventional `ai/issue-<n>`; persisting
    // it would make `admin tool-request grant` treat it as a recorded PR head
    // (`fromRecordedPr`, admin.ts) and refuse to (re)create the branch when it is
    // absent on origin — exactly the normal fresh Tool Request path after branch
    // cleanup or a no-diff handoff (issue #477 review). resolveToolRequestWorkBranch
    // falls back to `ai/issue-<n>` for the new-impl case anyway, so omitting the
    // key loses nothing there while the dependency start point still routes via
    // `dependencyBase`.
    const recordedWorkBranch = fixMode ? branch : undefined;

    const toolRequestHandoff = (toolRequest: ToolRequest): PhaseHandlerResult => {
      const preservation = handoffCleanup();
      const storedToolRequest = storeToolRequest(toolRequest, preservation);

      writeFileSync(join(artifactDir, "implementation-result.json"), JSON.stringify({
        issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
        exitCode: 0, success: false, step: "tool-request", artifactDir, resolvedProfile,
        toolRequest: storedToolRequest,
      }, null, 2), "utf8");

      const repeatKind = toolRequestRepeatKind(toolRequest.command);

      return {
        result: "tool_request",
        context: {
          artifactDir, resolvedProfile, toolRequest: storedToolRequest,
          // Persist the resolved work branch (a real PR head only) so a later
          // `admin tool-request run/resolve` lands the granted command on the SAME
          // branch this run worked on. In a worktree fix found from a `prUrl`-only,
          // non-conventional PR head, `recordedWorkBranch` holds the live PR head;
          // without persisting it, resolveToolRequestWorkBranch falls back to
          // `ai/issue-<n>` and the grant would commit/push to the wrong branch
          // (issue #459 review, P2). A fresh conventional issue branch is NOT
          // recorded — see recordedWorkBranch above (issue #477 review).
          ...(recordedWorkBranch !== undefined ? { branch: recordedWorkBranch } : {}),
          ...(repeatKind !== undefined ? { toolRequestRepeatKind: repeatKind } : {}),
          // Persist the dependency start point so a later grant rebuilds the issue
          // branch on the blocker PR head (the temporary branch was just deleted in
          // discardEditsToBase) instead of the session base (issue #316 review).
          // Write the key unconditionally — clearing it (undefined) when the
          // current dependency plan provided no start point. Omitting it would let
          // the phase runner's context merge preserve a stale dependencyBase from a
          // previous handoff, and runToolRequestGrant would rebuild the issue
          // branch from an obsolete blocker head instead of the current base
          // (issue #316 review).
          dependencyBase: depBase,
        },
        message: `Implementation agent requested a disallowed command: ${toolRequest.command}`,
      };
    };

    // Dependency-update handoff (issue #302). The agent requested a dependency
    // install that the trusted dependency-sync path recognized but could NOT
    // safely satisfy (already-satisfied state, a manifest error, or a sync
    // failure). Hand off to a human with a dependency-specific explanation rather
    // than repeating the generic Tool Request comment — the whole point is to stop
    // the loop where the agent re-requests the same install every run. The handoff
    // metadata records both the original request and the attempt outcome so an
    // operator sees exactly what was tried.
    const dependencyUpdateHandoff = (
      toolRequest: ToolRequest,
      attempt: DependencyUpdateFailed,
    ): PhaseHandlerResult => {
      const preservation = handoffCleanup();
      const storedToolRequest = storeToolRequest(toolRequest, preservation);
      const dependencyUpdate = {
        manager: attempt.manager,
        manifestPath: attempt.manifestPath,
        packages: attempt.packages,
        ...(attempt.failure ? { failure: attempt.failure } : {}),
      };

      writeFileSync(join(artifactDir, "implementation-result.json"), JSON.stringify({
        issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
        exitCode: 0, success: false, step: "dependency-update", artifactDir, resolvedProfile,
        toolRequest: storedToolRequest, dependencyUpdate,
      }, null, 2), "utf8");

      const repeatKind = toolRequestRepeatKind(toolRequest.command);

      return {
        result: "tool_request",
        context: {
          artifactDir, resolvedProfile, toolRequest: storedToolRequest, dependencyUpdate,
          // Persist the resolved work branch (a real PR head only) so a later grant
          // lands on the SAME branch this run worked on rather than falling back to
          // `ai/issue-<n>` — a worktree fix on a non-conventional PR head would
          // otherwise be moved off the real head (issue #459 review, P2). A fresh
          // conventional issue branch is NOT recorded, so a dependency-update handoff
          // during initial implementation does not make the grant treat `ai/issue-<n>`
          // as a recorded PR head (issue #477 review).
          ...(recordedWorkBranch !== undefined ? { branch: recordedWorkBranch } : {}),
          ...(repeatKind !== undefined ? { toolRequestRepeatKind: repeatKind } : {}),
          // Persist the dependency start point so a later grant rebuilds the issue
          // branch on the blocker PR head instead of the session base (issue #316
          // review). Write the key unconditionally — clearing it (undefined) when
          // the current dependency plan provided no start point — so the phase
          // runner's context merge cannot preserve a stale dependencyBase from a
          // previous handoff and have runToolRequestGrant rebuild the branch from
          // an obsolete blocker head (issue #316 review).
          dependencyBase: depBase,
        },
        message:
          `Dependency update could not be applied through trusted dependency sync ` +
          `(${attempt.failure.kind}): ${attempt.failure.message}`,
      };
    };

    // The trusted dependency-update path applied the requested install (issue
    // #302): when set, the agent's Tool Request was satisfied by editing the
    // manifest and regenerating the lockfile with the session-pinned sync command,
    // so the run continues to verification/commit instead of handing off. Holds the
    // sync outcome so the later dependency-sync step is not re-run redundantly.
    let dependencyUpdate: DependencyUpdateApplied | undefined;

    // Route a Tool Request: try the trusted dependency-update path first, then
    // fall back to the generic handoff. Returns a terminal handoff result, or
    // undefined when the request was satisfied and the run should continue.
    const routeToolRequest = (toolRequest: ToolRequest): PhaseHandlerResult | undefined => {
      const attempt = runDependencyUpdate(runner, session.dependencySync, toolRequest.command, cwd, artifactDir);
      if (attempt.handled && attempt.passed) {
        dependencyUpdate = attempt;
        return undefined;
      }
      if (attempt.handled) {
        return dependencyUpdateHandoff(toolRequest, attempt);
      }
      return toolRequestHandoff(toolRequest);
    };

    // Step 3.5: Runner-owned environment preparation (issue #511). Installs the
    // full runtime dependency tree (e.g. `npm ci` → node_modules) BEFORE the
    // agent runs, using the EXACT configured command — never derived from agent
    // output, issue text, or repository auto-detection. A stamp keyed by worktree
    // identity, command, config, and cacheKeyFiles content prevents redundant
    // reinstalls across retries. A nonzero exit fails closed: the phase stops and
    // no agent execution follows a failed prepare.
    //
    // `cwd` is the stable identity: the issue worktree path in worktree mode, or
    // canonicalRoot in shared mode — both are set before this point.
    const envPrepareIdentity = cwd;

    // When a dirty continuation is active and environment preparation is enabled,
    // snapshot untracked files BEFORE the prepare command runs. After prepare,
    // subtracting this pre-prepare set from the post-prepare baseline ensures that
    // dirty continuation untracked files are not mistakenly treated as prepare
    // artifacts and excluded from staging (issue #571).
    const prePrepareUntrackedFiles: Set<string> | null =
      activeDirtyContinuation && session.environmentPrepare?.enabled
        ? (() => {
            const r = runner.run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd });
            return r.exitCode === 0 ? new Set<string>(r.stdout.split("\0").filter(Boolean)) : null;
          })()
        : null;

    const envPrepare = ensureEnvironmentPrepared({
      config: session.environmentPrepare,
      cwd,
      worktreeIdentity: envPrepareIdentity,
      artifactRoot: session.artifactRoot,
      artifactDir,
      runner,
    });
    if (envPrepare.status === "failed") {
      return failAfterBranch("environment-prepare", {
        result: "failed",
        context: { artifactDir, resolvedProfile },
        error: `Environment preparation failed (exit ${envPrepare.exitCode ?? 1}): ${(envPrepare.output ?? "").slice(0, 500)}`,
      });
    }

    // Capture the set of untracked files that exist after environment preparation
    // but BEFORE the agent runs. Files materialised by the prepare command (e.g.
    // node_modules/, vendor/, .venv/) that are not covered by the repo's .gitignore
    // would otherwise appear as agent-produced changes in the diff/stage checks
    // below. Snapshotting now lets us exclude them from both the no-diff check
    // (Step 5) and the stageable-paths list (Step 6).
    //
    // Only snapshot when environmentPrepare is enabled; when disabled the baseline
    // is empty (no prepare ran → no prepare artifacts to exclude). This also avoids
    // an extra git call on every run for sessions that don't use environmentPrepare.
    const envPrepareBaselineResult = session.environmentPrepare?.enabled
      ? runner.run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd })
      : null;
    const envPrepareBaseline = new Set<string>(
      envPrepareBaselineResult && envPrepareBaselineResult.exitCode === 0
        ? envPrepareBaselineResult.stdout.split("\0").filter(Boolean)
        : []
    );

    // Remove dirty-continuation files that were present before environment
    // preparation from the baseline. Those files pre-date the prepare step and
    // must not be suppressed as prepare artifacts — they are uncommitted
    // implementation work from the prior attempt that should be staged after
    // this run succeeds (issue #571).
    if (prePrepareUntrackedFiles !== null) {
      for (const f of prePrepareUntrackedFiles) {
        envPrepareBaseline.delete(f);
      }
    }

    const dependencySyncTriggerPaths =
      session.dependencySync?.enabled === true ? session.dependencySync.triggerPaths : undefined;
    const prompt = buildPrompt(task, cwd, reviewFeedback, dependencySyncTriggerPaths, session.verification, activeDirtyContinuation);
    writeFileSync(join(artifactDir, "implementation-prompt.md"), prompt, "utf8");

    // Write resolved agent profile before invoking the agent so interrupted/failed
    // runs still have a pre-run audit record of the intended billable profile.
    // Also record the full persisted assignment (flow, source, resolvedAt, all
    // phase agents) so the run dir is self-describing for auditability — not just
    // the per-phase resolvedProfile.
    const assignment = readResolvedAssignment(task);
    writeFileSync(join(artifactDir, "implementation-context.json"), JSON.stringify({
      issueNumber: task.issueNumber, sessionId: task.sessionId, runId, resolvedProfile,
      ...(assignment ? { assignment } : {}),
    }, null, 2), "utf8");

    // Step 4: Run implementation agent (file edits only; Gemini receives prompt
    // as a --print positional arg and stdin for compatibility with agy).
    const agentResult = runner.run(resolvedProfile.cmd, claudeArgs(resolvedProfile, prompt), { cwd, stdin: prompt });
    writeFileSync(join(artifactDir, "implementation-output.md"), agentResult.stdout || agentResult.stderr, "utf8");

    // Step 4.5: Tool Request handoff (issue #291). Detect a Tool Request block
    // here, BEFORE both the nonzero-exit failure check below and the later no-diff
    // failure check, so a clean handoff is never misread as a generic failure. The
    // agent may emit a valid Tool Request and still exit nonzero (e.g. it treats
    // the blocked/disallowed-command stop as an unsuccessful run); parsing first
    // ensures that becomes a `ready_for_human` handoff rather than `lastError`.
    // See toolRequestHandoff. Parse stdout first, then fall back to stderr: a
    // nonzero-exit run may have printed the agent's final message (and thus the
    // Tool Request block) to stderr rather than stdout.
    const toolRequest = parseToolRequest(agentResult.stdout) ?? parseToolRequest(agentResult.stderr);
    if (toolRequest) {
      // Issue #302: a dependency-install request may be satisfied through the
      // trusted dependency-sync path (routeToolRequest returns undefined and the
      // run continues); otherwise this is a terminal human handoff.
      const handoff = routeToolRequest(toolRequest);
      if (handoff) return handoff;
    }

    // A satisfied dependency update (dependencyUpdate set) means the agent's
    // non-zero exit was just its way of signaling "I stopped, I need a command";
    // the command has now been applied for it, so do not treat that exit as a
    // generic phase failure.
    if (!dependencyUpdate && agentResult.exitCode !== 0) {
      // Quota/rate-limit exhaustion is not a task failure (issue #25): the agent
      // ran out of its usage window, not out of ability to do the work. Classify
      // the combined output and, when it matches, return `delayed` so the task is
      // released back to `queued` with a future notBefore instead of failing. The
      // original output artifact is preserved for diagnosis either way.
      const quota = classifyQuotaExhaustion(`${agentResult.stdout}\n${agentResult.stderr}`, agentId);
      writeFileSync(join(artifactDir, "implementation-result.json"), JSON.stringify({
        issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
        exitCode: agentResult.exitCode, success: false,
        ...(quota.isQuotaExhaustion ? { delayed: true, quotaSignal: quota.signal } : {}),
        step: resolvedProfile.agentId, artifactDir, resolvedProfile,
      }, null, 2), "utf8");
      if (quota.isQuotaExhaustion) {
        // Restore the worker checkout before re-queueing (issue #25 review): the
        // branch already exists at this point, and the agent may have left partial
        // edits. Without this, the delayed retry's preflight would trip on a dirty
        // worktree, or `git checkout -b ai/issue-N` would collide with the existing
        // branch, turning a recoverable quota delay into a hard failure. Reuse the
        // same restore the Tool Request handoff uses: discard edits back to base and
        // drop the freshly-created issue branch (new-impl mode; fix mode keeps it).
        discardEditsToBase();
        return {
          result: "delayed",
          context: { artifactDir, resolvedProfile, quotaSignal: quota.signal },
          message: `${resolvedProfile.agentId} hit a quota/rate-limit (signal: "${quota.signal}"); delaying retry`,
        };
      }
      return {
        result: "failed",
        context: { artifactDir, resolvedProfile },
        error: `${resolvedProfile.agentId} exited ${agentResult.exitCode}: ${(agentResult.stderr || agentResult.stdout).slice(0, 500)}`,
      };
    }

    // Step 5: Verify Claude produced changes.
    // git diff --stat HEAD only covers tracked files; check untracked files too so that
    // an implementation consisting entirely of new files is not incorrectly rejected.
    const diffResult = runner.run("git", ["diff", "--stat", "HEAD"], { cwd });
    const hasDiff = diffResult.stdout.trim().length > 0;
    const relArtifactRoot = relative(cwd, session.artifactRoot);
    const isArtifactInRepo = !relArtifactRoot.startsWith("..");
    const untrackedResult = !hasDiff
      ? runner.run("git", ["ls-files", "--others", "--exclude-standard"], { cwd })
      : null;
    const hasUntracked = (() => {
      if (untrackedResult === null) return false;
      return untrackedResult.stdout.trim().split("\n").some(f => {
        if (!f) return false;
        if (isArtifactInRepo && (f === relArtifactRoot || f.startsWith(relArtifactRoot + "/"))) return false;
        if (envPrepareBaseline.has(f)) return false;
        return true;
      });
    })();
    // A no-op agent run is normally a failure: a fresh implementation that edits
    // nothing produced no work. But after a Tool Request / manual-done recovery the
    // issue's implementation is already committed on the resumed `ai/issue-<n>`
    // branch, and the agent may correctly decide there is nothing left to change
    // (issue #404). Distinguish the two by asking whether the resumed branch already
    // carries committed changes relative to its start point: `git diff --quiet
    // <start>...HEAD` exits 1 when the merge-base..HEAD range has a diff. Only a
    // resumed branch with such committed changes is allowed to succeed on a no-op;
    // a fresh branch (resumedFromToolRequestBranch === false) keeps today's failure.
    let resumedNoopWithCommits = false;
    if (!hasDiff && !hasUntracked) {
      const branchHasCommittedChanges = (): boolean => {
        // The start point depends on the branch mode. In dependency-start-point
        // mode the issue branch is built on the blocker PR head, so comparing
        // against `baseBranch` would count the blocker PR's commits as this
        // issue's implementation work and let a no-op resume succeed with only
        // the dependency changes (issue #404 review). Use the blocker head as the
        // start point in that mode so the probe only sees commits beyond it.
        let startPoint = baseBranch;
        if (depBase) {
          // Fetch the blocker head explicitly: a remote-tracking ref may be
          // absent in a fresh/single-branch clone, and the local issue branch was
          // created from this same head. Compare against the fetched commit so the
          // diff range excludes the dependency start point. A failed fetch leaves
          // the start point unresolvable, which the exit-code check below treats as
          // inconclusive (falls through to failure).
          const fetchBlocker = runner.run("git", ["fetch", "origin", depBase.baseHeadRefName], { cwd });
          if (fetchBlocker.exitCode !== 0) return false;
          startPoint = "FETCH_HEAD";
        } else if (worktreeMode) {
          // Worktree mode deliberately skips the shared checkout's
          // `git checkout <base> && git pull`, so the local `baseBranch` ref can lag
          // behind `origin/<base>`. The worktree base was already refreshed via
          // `git fetch origin <base>` above, so compare against the fetched
          // remote-tracking ref instead. Otherwise, when the canonical `<base>` is
          // stale, a resumed branch with no issue-specific commits looks non-empty
          // purely from upstream base commits and would be wrongly accepted as a
          // no-op success (issue #454 review).
          startPoint = `origin/${baseBranch}`;
        }
        const r = runner.run("git", ["diff", "--quiet", `${startPoint}...HEAD`], { cwd });
        // exit 1 = differences present; exit 0 = empty; any other (e.g. 128 for an
        // unresolvable ref) is inconclusive and must fall through to the failure so
        // a truly empty branch is never reported as success.
        return r.exitCode === 1;
      };
      if (!resumedFromToolRequestBranch || !branchHasCommittedChanges()) {
        writeFileSync(join(artifactDir, "implementation-result.json"), JSON.stringify({
          issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
          exitCode: 0, success: false, step: "diff-check", artifactDir, resolvedProfile,
        }, null, 2), "utf8");
        return { result: "failed", context: { artifactDir, resolvedProfile }, error: `${resolvedProfile.agentId} exited 0 but produced no file changes` };
      }
      // Resumed branch already holds the committed implementation. Skip the commit
      // step below (nothing new to stage; the branch is already pushed) but still
      // run verification and proceed to review like a normal implementation success.
      resumedNoopWithCommits = true;
    }

    // Step 5.25: Handler-owned dependency sync (issue #290). When the session
    // enables dependencySync and the agent changed a configured trigger path
    // (e.g. package.json), regenerate the lockfile by running the EXACT
    // session-pinned command — outside the agent permission surface (npm install
    // is never added to allowedTools) — BEFORE verification and commit, so the
    // lockfile change is verified and lands in the same commit. A sync failure
    // stops with actionable feedback rather than committing a stale lockfile.
    const dependencySyncMeta = (outcome: DependencySyncOutcome) => ({
      ran: outcome.ran,
      passed: outcome.passed,
      ...(outcome.command ? { command: outcome.command } : {}),
      changedTriggerPaths: outcome.changedTriggerPaths,
      producedExpectedOutputs: outcome.producedExpectedOutputs,
      ...(outcome.resyncedStaleOutputs ? { resyncedStaleOutputs: true } : {}),
      ...(outcome.failure ? { failure: outcome.failure } : {}),
    });
    // A sync that did not pass (a non-zero command exit, or a refused
    // lifecycle-running command in safe mode) stops with actionable feedback
    // rather than committing a stale/uncontrolled lockfile. `passed` is true for
    // the no-op cases (disabled / no trigger change), so this only fires on a
    // real failure.
    const dependencySyncFailure = (sync: DependencySyncOutcome): PhaseHandlerResult & { result: "failed" } => {
      const failure = sync.failure!;
      writeFileSync(join(artifactDir, "implementation-result.json"), JSON.stringify({
        issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
        exitCode: failure.exitCode, success: false, step: "dependency-sync", artifactDir, resolvedProfile,
        dependencySync: dependencySyncMeta(sync),
      }, null, 2), "utf8");
      return {
        result: "failed",
        context: {
          artifactDir,
          resolvedProfile,
          dependencySync: dependencySyncMeta(sync),
          dependencySyncFeedback: failure.output,
        },
        error:
          failure.kind === "unsafe-command"
            ? `Dependency sync refused before commit/push: ${failure.output.slice(0, 500)}`
            : `Dependency sync failed (exit ${failure.exitCode}) after ${sync.changedTriggerPaths.join(", ")} ` +
              `changed, before commit/push:\n${failure.output.slice(0, 500)}`,
      };
    };

    // When the trusted dependency-update path already ran the session sync command
    // (issue #302) reuse its outcome instead of running it a second time; the
    // manifest+lockfile are already in the requested state. Otherwise run it now
    // for the ordinary case where the agent edited a manifest directly.
    let dependencySync = dependencyUpdate?.sync ?? runDependencySync(runner, session.dependencySync, cwd, artifactDir);
    if (!dependencySync.passed) {
      return dependencySyncFailure(dependencySync);
    }

    // Step 5.3: Re-check environment preparation before verification. When dep
    // sync regenerated a lockfile listed in `cacheKeyFiles`, the cacheKeyFiles
    // content hash changes and the existing stamp is stale — a fresh prepare run
    // is needed so verification commands execute against the updated dependencies.
    // We call this unconditionally (not just when dependencySync.ran) because the
    // agent may have edited a cacheKeyFiles file directly without triggering a dep
    // sync run. `ensureEnvironmentPrepared` computes the hash on each call and
    // skips cheaply when the stamp is still current, so this is a no-op whenever
    // cache keys are unchanged or `environmentPrepare` is disabled.
    const envPrepareAfterSync = ensureEnvironmentPrepared({
      config: session.environmentPrepare,
      cwd,
      worktreeIdentity: envPrepareIdentity,
      artifactRoot: session.artifactRoot,
      artifactDir,
      runner,
    });
    if (envPrepareAfterSync.status === "failed") {
      return failAfterBranch("environment-prepare-after-sync", {
        result: "failed",
        context: { artifactDir, resolvedProfile },
        error: `Environment preparation (after dependency sync) failed (exit ${envPrepareAfterSync.exitCode ?? 1}): ${(envPrepareAfterSync.output ?? "").slice(0, 500)}`,
      });
    }
    // If the post-sync prepare actually ran, it may have materialized new
    // untracked files (e.g. regenerated vendor/ or node_modules/ entries)
    // that were absent when envPrepareBaseline was captured before the agent.
    // Refresh the baseline so the later stageable-paths filter still excludes
    // those runner-created files and does not accidentally commit them.
    if (envPrepareAfterSync.status === "ran") {
      const refreshResult = runner.run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd });
      if (refreshResult.exitCode === 0) {
        envPrepareBaseline.clear();
        for (const f of refreshResult.stdout.split("\0").filter(Boolean)) {
          envPrepareBaseline.add(f);
        }
      }
    }

    // Step 5.5: Run configured verification BEFORE any git add/commit/push or
    // gh pr create, so a known-broken commit is never pushed. A bounded repair
    // loop re-runs the agent once with verification feedback to fix obvious
    // failures inline, reducing expensive review/fix cycles.
    let verification = runVerification(runner, session.verification, cwd, artifactDir);
    for (
      let repair = 0;
      !verification.passed && repair < MAX_VERIFICATION_REPAIR_ATTEMPTS;
      repair++
    ) {
      const failure = verification.failure!;
      const repairPrompt = buildRepairPrompt(task, cwd, failure);
      writeFileSync(join(artifactDir, `implementation-repair-prompt-${repair + 1}.md`), repairPrompt, "utf8");
      const repairResult = runner.run(resolvedProfile.cmd, claudeArgs(resolvedProfile, repairPrompt), { cwd, stdin: repairPrompt });
      writeFileSync(join(artifactDir, `implementation-repair-output-${repair + 1}.md`), repairResult.stdout || repairResult.stderr, "utf8");
      // The repair agent may discover that fixing the failure needs a disallowed
      // command (e.g. an uninstalled dependency the failing test imports). Detect
      // its Tool Request block BEFORE the nonzero-exit check below, otherwise a
      // valid handoff emitted alongside a nonzero exit would be misclassified as a
      // generic repair failure instead of a clean human handoff (issue #291).
      const repairToolRequest = parseToolRequest(repairResult.stdout) ?? parseToolRequest(repairResult.stderr);
      // Same routing as the initial agent (issue #302): a dependency-install
      // request may be satisfied through the trusted dependency-sync path, in
      // which case the loop continues and the sync/verification below validate
      // the applied manifest+lockfile; otherwise it is a terminal handoff.
      // routeToolRequest returns undefined ONLY when it applied the manifest +
      // lockfile, so a satisfied request means the repair agent's nonzero exit was
      // just its way of signaling the blocked command — mirror the initial-agent
      // exception below rather than treating that exit as a repair failure.
      let repairSatisfiedDependency = false;
      if (repairToolRequest) {
        const handoff = routeToolRequest(repairToolRequest);
        if (handoff) return handoff;
        repairSatisfiedDependency = true;
      }
      if (!repairSatisfiedDependency && repairResult.exitCode !== 0) {
        // A quota/rate-limit exhaustion can first surface during the repair
        // attempt; treat it as a delayed retry rather than a repair failure
        // (issue #25).
        const repairQuota = classifyQuotaExhaustion(`${repairResult.stdout}\n${repairResult.stderr}`, agentId);
        writeFileSync(join(artifactDir, "implementation-result.json"), JSON.stringify({
          issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
          exitCode: repairResult.exitCode, success: false,
          ...(repairQuota.isQuotaExhaustion ? { delayed: true, quotaSignal: repairQuota.signal } : {}),
          step: "verification-repair", artifactDir,
        }, null, 2), "utf8");
        if (repairQuota.isQuotaExhaustion) {
          // Same restore as the initial-agent delayed path (issue #25 review): the
          // issue branch already exists and the repair agent may have left partial
          // edits, so return the checkout to base and drop the new-impl branch before
          // re-queueing, otherwise the delayed retry hard-fails on the dirty-worktree
          // or branch-already-exists preflight.
          discardEditsToBase();
          return {
            result: "delayed",
            context: { artifactDir, resolvedProfile, quotaSignal: repairQuota.signal },
            message: `${resolvedProfile.agentId} verification repair hit a quota/rate-limit (signal: "${repairQuota.signal}"); delaying retry`,
          };
        }
        return {
          result: "failed",
          context: { artifactDir, resolvedProfile },
          error: `${resolvedProfile.agentId} verification repair exited ${repairResult.exitCode}: ${(repairResult.stderr || repairResult.stdout).slice(0, 500)}`,
        };
      }
      // When the repair request was satisfied through the trusted dependency-update
      // path (issue #302), routeToolRequest already applied the manifest edit AND
      // ran the session sync command, so reuse that outcome instead of running the
      // sync a second time — mirrors the initial-agent reuse above. Otherwise the
      // repair agent may have edited a manifest (e.g. package.json) directly while
      // fixing the failure, so re-run dependency sync now to regenerate the lockfile
      // for the repaired manifest BEFORE the re-verification below — otherwise a
      // manifest change introduced during repair would be committed with a stale
      // lockfile, reintroducing exactly the case this feature prevents (issue #290).
      // Pass the prior outcome so a repair that REVERTS the manifest after an
      // earlier sync still forces a resync, instead of leaving a stale lockfile
      // diff staged with no matching manifest change (issue #290 review).
      dependencySync =
        repairSatisfiedDependency && dependencyUpdate
          ? dependencyUpdate.sync
          : runDependencySync(runner, session.dependencySync, cwd, artifactDir, dependencySync);
      if (!dependencySync.passed) {
        return dependencySyncFailure(dependencySync);
      }
      // Re-check environment preparation before re-verification (issue #511
      // review, P2). Called unconditionally — not just when dependencySync.ran —
      // because the repair agent may have edited a cacheKeyFiles file directly
      // without triggering a dep sync, leaving the existing stamp stale.
      // ensureEnvironmentPrepared skips cheaply when the stamp is still current.
      const envPrepareAfterRepairSync = ensureEnvironmentPrepared({
        config: session.environmentPrepare,
        cwd,
        worktreeIdentity: envPrepareIdentity,
        artifactRoot: session.artifactRoot,
        artifactDir,
        runner,
      });
      if (envPrepareAfterRepairSync.status === "failed") {
        return failAfterBranch("environment-prepare-after-repair-sync", {
          result: "failed",
          context: { artifactDir, resolvedProfile },
          error: `Environment preparation (after repair dependency sync) failed (exit ${envPrepareAfterRepairSync.exitCode ?? 1}): ${(envPrepareAfterRepairSync.output ?? "").slice(0, 500)}`,
        });
      }
      // Refresh the prepare baseline if this repair-path prepare actually ran.
      // The repair agent or repair dep sync may have changed a cacheKeyFiles
      // entry, causing prepare to materialise new untracked files AFTER the
      // baseline was captured before the initial agent. Without refreshing,
      // those runner-created files pass the stageablePaths filter and can be
      // committed as agent output in repos where prepare artifacts are not ignored.
      if (envPrepareAfterRepairSync.status === "ran") {
        const refreshResult = runner.run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd });
        if (refreshResult.exitCode === 0) {
          envPrepareBaseline.clear();
          for (const f of refreshResult.stdout.split("\0").filter(Boolean)) {
            envPrepareBaseline.add(f);
          }
        }
      }
      verification = runVerification(runner, session.verification, cwd, artifactDir);
    }
    if (!verification.passed) {
      const failure = verification.failure!;
      // In per-issue worktree mode, capture dirty state so the next phase attempt
      // can distinguish "dirty from a known prior verification failure" from "dirty
      // for an unknown reason" (docs/per-issue-worktrees.md §Follow-up work, item 1).
      let dirtyContinuation: Record<string, unknown> | undefined;
      if (worktreeMode) {
        // Use -z (NUL-delimited) so paths with spaces, tabs, or non-ASCII are
        // never quoted by git, avoiding silent path-mismatch on quoted entries.
        const dirtyStatus = runner.run("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd });
        const statusEntries = dirtyStatus.stdout.split("\0").filter(Boolean);
        // Rename/copy entries emit two NUL-terminated tokens: "XY new-path" then "old-path".
        const dirtyFiles: string[] = [];
        {
          let idx = 0;
          while (idx < statusEntries.length) {
            const entry = statusEntries[idx++];
            if (entry.length < 3) continue;
            const xy = entry.slice(0, 2);
            dirtyFiles.push(entry.slice(3));
            if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
              idx++; // skip the old-path token
            }
          }
        }
        const patchResult = runner.run("git", ["diff", "HEAD"], { cwd, maxBuffer: 64 * 1024 * 1024 });
        // Also include untracked files (git diff HEAD omits them).
        const untrackedFiles = statusEntries
          .filter((entry) => entry.startsWith("?? "))
          .map((entry) => entry.slice(3));
        const { patch: untrackedPatch } = buildUntrackedPatch(cwd, untrackedFiles);
        const patchFile = "implementation-dirty-patch.patch";
        const patchCaptured = dirtyStatus.exitCode === 0 && patchResult.exitCode === 0;
        if (patchCaptured) {
          writeFileSync(join(artifactDir, patchFile), patchResult.stdout + untrackedPatch, "utf8");
        }
        dirtyContinuation = {
          issueNumber: task.issueNumber,
          phase: "implementation",
          runId,
          branch: worktreeBranch,
          worktreeId: resolvedWorktreeId ?? null,
          verificationName: failure.name,
          verificationExitCode: failure.exitCode,
          dirtyFiles,
          ...(patchCaptured ? { patchArtifactFile: patchFile } : {}),
          timestamp: new Date().toISOString(),
          commitSkipped: true,
        };
      }
      writeFileSync(join(artifactDir, "implementation-result.json"), JSON.stringify({
        issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
        exitCode: failure.exitCode, success: false, step: `verification:${failure.name}`, artifactDir,
        ...(dirtyContinuation ? { dirtyContinuation } : {}),
      }, null, 2), "utf8");
      return {
        result: "failed",
        context: {
          artifactDir,
          resolvedProfile,
          verificationFailure: { name: failure.name, exitCode: failure.exitCode },
          verificationFeedback: failure.output,
          ...(dirtyContinuation ? { dirtyContinuation } : {}),
        },
        error: `Verification '${failure.name}' failed (exit ${failure.exitCode}) before commit/push:\n${failure.output.slice(0, 500)}`,
      };
    }

    // Step 6: Stage, commit, push. Stage an explicit file list so ignored
    // artifact directories are never passed to git add as pathspec candidates.
    const stageableResult = runner.run("git", ["ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z"], { cwd });
    if (stageableResult.exitCode !== 0) {
      writeFileSync(join(artifactDir, "implementation-result.json"), JSON.stringify({
        issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
        exitCode: stageableResult.exitCode, success: false, step: "git-ls-files", artifactDir, resolvedProfile,
      }, null, 2), "utf8");
      return {
        result: "failed",
        context: { artifactDir, resolvedProfile },
        error: `git ls-files failed (exit ${stageableResult.exitCode}): ${(stageableResult.stderr || stageableResult.stdout).slice(0, 300)}`,
      };
    }
    const stageablePaths = stageableResult.stdout
      .split("\0")
      .filter((f) => {
        if (!f) return false;
        if (isArtifactInRepo && (f === relArtifactRoot || f.startsWith(relArtifactRoot + "/"))) return false;
        if (envPrepareBaseline.has(f)) return false;
        return true;
      });
    // No stageable paths is normally a failure, EXCEPT for the resumed no-op
    // recovery: the implementation is already committed and pushed on the resumed
    // branch, so there is correctly nothing new to stage (issue #404). The bounded
    // verification repair loop above could still have introduced a real diff even
    // in that case, so gate the commit/push on whether anything is actually
    // stageable rather than on the flag alone.
    if (stageablePaths.length === 0 && !resumedNoopWithCommits) {
      writeFileSync(join(artifactDir, "implementation-result.json"), JSON.stringify({
        issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
        exitCode: 0, success: false, step: "stageable-check", artifactDir, resolvedProfile,
      }, null, 2), "utf8");
      return { result: "failed", context: { artifactDir, resolvedProfile }, error: `${resolvedProfile.agentId} exited 0 but produced no stageable file changes` };
    }

    const commitMsg = fixMode
      ? `fix: apply review feedback for issue #${task.issueNumber}`
      : `fix: implement issue #${task.issueNumber}`;

    if (stageablePaths.length > 0) {
      for (const [cmd, ...args] of [
        ["git", "add", "--", ...stageablePaths],
        ["git", "commit", "-m", commitMsg],
        ["git", "push", "origin", branch],
      ]) {
        const r = runner.run(cmd, args, { cwd });
        if (r.exitCode !== 0) {
          writeFileSync(join(artifactDir, "implementation-result.json"), JSON.stringify({
            issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
            exitCode: r.exitCode, success: false, step: cmd, artifactDir, resolvedProfile,
          }, null, 2), "utf8");
          return failAfterBranch(cmd, {
            result: "failed",
            context: { artifactDir, resolvedProfile },
            error: `${cmd} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(0, 300)}`,
          });
        }
      }
    }

    // Step 7 (new-impl only): Create PR
    if (!fixMode) {
      // Resumed no-op recovery: the earlier run (Tool Request grant / manual-done)
      // may already have opened the PR for this branch, in which case creating a
      // second one would fail (issue #404). Reuse the existing open PR when present;
      // only create when the lookup positively reports none. A lookup failure is
      // ambiguous and must fail closed rather than risk a duplicate PR.
      if (resumedNoopWithCommits) {
        const existingPr = findOpenPr(sessionRepoHost.provider, task.issueNumber);
        if (!("error" in existingPr)) {
          prUrl = existingPr.url;
        } else if (existingPr.kind === "lookup-failed") {
          writeFileSync(join(artifactDir, "implementation-result.json"), JSON.stringify({
            issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
            exitCode: 1, success: false, step: "gh-pr-lookup", artifactDir, resolvedProfile,
          }, null, 2), "utf8");
          return failAfterBranch("gh-pr-lookup", {
            result: "failed",
            context: { artifactDir, resolvedProfile },
            error: existingPr.error,
          });
        }
        // kind === "not-found" → no PR yet; fall through to create it below.
      }
    }
    if (!fixMode && !prUrl) {
      const ctx = task.context as Record<string, unknown>;
      const issueTitle = typeof ctx.title === "string" && ctx.title.trim().length > 0
        ? ctx.title.trim()
        : undefined;
      const issuePrefix = `fix: #${task.issueNumber} `;
      const prTitle = issueTitle
        ? `${issuePrefix}${issueTitle.slice(0, 256 - issuePrefix.length)}`
        : `fix: issue #${task.issueNumber}`;
      const prBody = buildPrBody(task, runId, "new", session.verification);
      // Every dependent PR targets the session base branch (`main` by default),
      // even when its branch was started from a blocker PR head. The branch start
      // point and the PR target are deliberately different concepts: starting from
      // the blocker head gives the implementation the code it depends on, but the
      // PR must still deliver to `main` so the dependent issue's mainline delivery
      // stays visible. Merge ordering is owned by GitHub Issue Relationships and
      // human review, not by this system (issue #242).
      const prBase = baseBranch;
      const prResult = sessionRepoHost.provider.createPullRequest({ title: prTitle, body: prBody, head: branch, base: prBase });

      if (!prResult.ok) {
        writeFileSync(join(artifactDir, "implementation-result.json"), JSON.stringify({
          issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
          exitCode: 1, success: false, step: "gh-pr-create", artifactDir, resolvedProfile,
        }, null, 2), "utf8");
        return failAfterBranch("gh-pr-create", {
          result: "failed",
          context: { artifactDir, resolvedProfile },
          error: prResult.error,
        });
      }

      prUrl = prResult.value.url;
    }

    // Free the issue branch for the downstream review phase (issue #454 review,
    // P1). A successful worktree-mode run leaves `ai/issue-<n>` checked out in the
    // per-issue worktree, but the implementation is now committed AND pushed (and its
    // PR ensured), so the durable tree has nothing left to preserve. The review phase
    // runs from the canonical checkout and checks out the PR branch there; Git refuses
    // to check out a branch already held by another worktree, so every successful
    // worktree implementation would break review unless the branch is freed. Remove
    // the per-issue worktree to release the branch ref — the work is safe on origin,
    // and a later needs-fix run re-materializes the worktree from the existing branch.
    // Force so any residual untracked files in the worktree cannot block the removal
    // (the meaningful work is already committed). Fail closed on a removal error
    // rather than report success and leave review to die on the held branch with a
    // cryptic git error. Failure/handoff paths above keep their worktree on purpose
    // (they have uncommitted state to preserve) and never reach here.
    if (worktreeMode) {
      const freed = removeWorktree(canonicalRoot, cwd, { force: true, runner });
      if (!freed.ok) {
        writeFileSync(join(artifactDir, "implementation-result.json"), JSON.stringify({
          issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
          exitCode: 1, success: false, step: "worktree-remove", artifactDir, resolvedProfile,
        }, null, 2), "utf8");
        return {
          result: "failed",
          context: { artifactDir, resolvedProfile },
          error:
            `Implementation committed, pushed, and its PR is ready, but freeing the issue worktree ` +
            `at ${cwd} failed, leaving '${branch}' checked out there: ${freed.error}\n\n` +
            `The downstream review phase checks out '${branch}' in the canonical checkout and Git ` +
            `refuses a branch already held by another worktree. Remove the worktree manually ` +
            `(e.g. \`git worktree remove --force ${cwd}\`) before the issue can advance to review.`,
        };
      }
    }

    // Summary of a trusted dependency-update application (issue #302), surfaced on
    // success so it is auditable that the agent's install request was satisfied by
    // the manifest edit + session sync rather than by the agent running a command.
    const dependencyUpdateMeta = dependencyUpdate
      ? { manager: dependencyUpdate.manager, manifestPath: dependencyUpdate.manifestPath, packages: dependencyUpdate.packages }
      : undefined;

    writeFileSync(join(artifactDir, "implementation-result.json"), JSON.stringify({
      issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
      exitCode: 0, success: true, branch, prUrl, artifactDir, resolvedProfile,
      ...(resumedNoopWithCommits ? { resumedNoChanges: true } : {}),
      ...(depBase ? { dependencyBase: depBase } : {}),
      ...(dependencySync.ran ? { dependencySync: dependencySyncMeta(dependencySync) } : {}),
      ...(dependencyUpdateMeta ? { dependencyUpdate: dependencyUpdateMeta } : {}),
    }, null, 2), "utf8");

    return {
      result: "success",
      context: {
        artifactDir,
        branch,
        prUrl,
        implementationAgentUsed: agentId,
        labels: taskLabels,
        resolvedProfile,
        ...(resumedNoopWithCommits ? { resumedNoChanges: true } : {}),
        ...(depBase ? { dependencyBase: depBase } : {}),
        ...(dependencySync.ran ? { dependencySync: dependencySyncMeta(dependencySync) } : {}),
        ...(dependencyUpdateMeta ? { dependencyUpdate: dependencyUpdateMeta } : {}),
        // Explicitly clear any consumed dirtyContinuation marker so a later
        // implementation attempt for the same issue does not inherit it and
        // incorrectly treat a new dirty worktree as safe to continue.
        dirtyContinuation: undefined,
      },
    };
  };
}
