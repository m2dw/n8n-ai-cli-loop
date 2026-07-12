import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { AiTask } from "../core/task.js";
import type { PhaseHandler, PhaseHandlerContext, PhaseHandlerResult } from "../core/phase-runner.js";
import { defaultCommandRunner } from "./command-runner.js";
import type { CommandRunner } from "./command-runner.js";
import { labelsToComplexity } from "../core/github-intake.js";
import { runArtifactDir, writeAssignmentFailureArtifact } from "./artifact-dir.js";
import { agentForPhase, readResolvedAssignment } from "../core/assignment.js";
import { classifyQuotaExhaustion } from "../core/quota-classifier.js";
import { resolveFixPr } from "./pr-helpers.js";
import { ghRunnerFromCommandRunner } from "../providers/github/gh-runner.js";
import { resolveSessionRepoHost } from "../providers/repo-host-factory.js";
import type { SessionRepoHost } from "../providers/repo-host-factory.js";
import { parseShellTokens, MAX_VERIFICATION_BUFFER_BYTES } from "./verification.js";
import { ensureEnvironmentPrepared } from "./environment-prepare.js";
import { resolveIssueWorktree, IssueWorktreeLock, issueLockScope } from "./worktree.js";
import { boundedExcerpt } from "../core/outbox-effects.js";

// ---------------------------------------------------------------------------
// Conflict-resolution allowed tools — strictly scoped per the phase contract.
//
// The agent owns ONLY editing conflicted files and staging the specific
// resolved files. It must not run gh commands, or any git command other than
// status / ls-files / add -- <file>. All repository operations (fetch, checkout,
// merge, commit, push) are owned by the handler, never the agent.
// ---------------------------------------------------------------------------

const CONFLICT_RESOLUTION_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "Bash(rg *)",
  "Bash(sed *)",
  "Bash(cat *)",
  "Bash(git status *)",
  "Bash(git ls-files *)",
  "Bash(git add -- *)",
].join(",");

/** Maximum chars stored in the bounded log excerpt for a verification failure. */
const CONFLICT_VERIFICATION_EXCERPT_CHARS = 3000;

/** Maximum chars in the bounded main-side diff included in the conflict-resolution prompt. */
const CONFLICT_MAIN_SIDE_DIFF_CHARS = 3000;

/** Maximum chars in the bounded issue body excerpt included in the conflict-resolution prompt. */
const CONFLICT_ISSUE_BODY_CHARS = 2000;

/** Maximum chars per field in the bounded merge rationale emitted by the conflict-resolution agent. */
const MERGE_RATIONALE_MAX_FIELD_CHARS = 500;

/** Maximum same-kind verification failures before escalating to human. */
const DEFAULT_MAX_CONFLICT_RESOLUTION_ATTEMPTS = 2;

/**
 * Returns true when both arrays are non-empty and share at least one test name.
 * Empty arrays (e.g. environment-setup failures where the test runner never
 * started) must never be treated as a repeated semantic-conflict signal.
 */
function hasOverlappingFailedTests(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setA = new Set(a);
  return b.some((t) => setA.has(t));
}

/**
 * Extract failed test names from verification output (best-effort, Jest-style).
 * Returns up to 20 names — the list is bounded so it stays fit for prompt context.
 */
function extractFailedTestNames(output: string): string[] {
  const matches = output.match(/^\s+●\s+.+$/gm) ?? [];
  return matches
    .map((m) => m.replace(/^\s+●\s+/, "").trim())
    .filter((name) => name !== "Test suite failed to run")
    .slice(0, 20);
}

/**
 * Bounded machine-readable rationale emitted by the conflict-resolution agent and
 * stored as a local artifact. Never posted to GitHub or passed to review prompts.
 */
export interface MergeRationale {
  /** What the issue-side change accomplishes in the merged result. */
  preservedIssueIntent: string;
  /** What the main-side change accomplishes in the merged result. */
  preservedMainBehavior: string;
  /** Behavior intentionally dropped during resolution, or null when nothing was discarded. */
  discardedBehavior: string | null;
  /** Which tests or checks confirm the combined behavior is correct. */
  verificationNotes: string;
}

export interface ResolvedConflictProfile {
  phase: "conflict_resolution";
  agentId: string;
  cmd: string;
  /** Sanitized argv — no prompt content (prompt is passed via stdin). */
  argv: string[];
  model: string;
  effort: string;
  maxBudgetUsd: string;
}

function resolveClaudeConflictProfile(labels: string[]): ResolvedConflictProfile {
  const labelProfile = labelsToComplexity(labels);
  const model = process.env["CLAUDE_MODEL"] ?? labelProfile.model;
  const budget = process.env["CLAUDE_MAX_BUDGET_USD"] ?? labelProfile.budget;
  const effort = process.env["CLAUDE_EFFORT"] ?? labelProfile.effort;
  const argv = [
    "-p",
    "--model", model,
    "--effort", effort,
    "--permission-mode", "acceptEdits",
    "--max-budget-usd", budget,
    "--allowedTools", CONFLICT_RESOLUTION_ALLOWED_TOOLS,
  ];
  return { phase: "conflict_resolution", agentId: "claude", cmd: "claude", argv, model, effort, maxBudgetUsd: budget };
}

function conflictResolutionCommand(
  agentId: string | undefined,
  labels: string[],
): { profile: ResolvedConflictProfile } | { error: string } {
  const agent = agentId ?? "claude";
  if (agent === "claude") {
    return { profile: resolveClaudeConflictProfile(labels) };
  }
  return { error: `Unsupported conflict-resolution agent: ${agent}. Supported: claude` };
}

// ---------------------------------------------------------------------------
// Unmerged-file parsing
// ---------------------------------------------------------------------------

/** A worktree path carrying residue, with whether git tracks it. */
interface DirtyPath {
  path: string;
  tracked: boolean;
}

interface UnmergedFile {
  path: string;
  /** Which merge stages are present: 1 (base), 2 (ours / PR), 3 (theirs / base). */
  stages: Set<number>;
  /** Blob object id per present stage (1=base, 2=ours / PR, 3=theirs / base). */
  blobs: Map<number, string>;
}

/**
 * Parse `git ls-files -u` output into one entry per conflicted path.
 *
 * Each line has the shape `<mode> <object> <stage>\t<path>`. A path can appear
 * up to three times: stage 1 (base), stage 2 (ours / PR branch), stage 3
 * (theirs / base branch). We collapse those into a single entry that records
 * which stages are present (so a modify/delete conflict — one side absent — is
 * distinguishable from a normal text conflict) and the blob id of each stage
 * (so a binary conflict can be detected by diffing the stage blobs directly).
 */
function parseUnmergedFiles(lsFilesOutput: string): UnmergedFile[] {
  const byPath = new Map<string, UnmergedFile>();
  for (const line of lsFilesOutput.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const meta = line.slice(0, tab).trim().split(/\s+/);
    const path = line.slice(tab + 1);
    const stage = Number(meta[meta.length - 1]);
    if (!Number.isFinite(stage)) continue;
    const object = meta.length >= 2 ? meta[1] : undefined;
    let entry = byPath.get(path);
    if (!entry) {
      entry = { path, stages: new Set<number>(), blobs: new Map<number, string>() };
      byPath.set(path, entry);
    }
    entry.stages.add(stage);
    if (object) entry.blobs.set(stage, object);
  }
  return [...byPath.values()];
}

/**
 * A modify/delete (or delete/delete) conflict has content on only one side, so
 * the unmerged entry is missing stage 2 or stage 3. These require human
 * judgement and must not be guessed by the agent, so the handler hands off.
 */
function hasModifyDeleteConflict(files: UnmergedFile[]): boolean {
  return files.some((f) => !(f.stages.has(2) && f.stages.has(3)));
}

/**
 * A binary file changed on both sides is still a full three-stage conflict, so
 * `git ls-files -u` (and therefore {@link hasModifyDeleteConflict}) cannot
 * distinguish it from a text conflict. Running `git diff --numstat -- <path>`
 * against the *worktree* is unreliable here: for an unmerged binary path git can
 * report `0\t0\t<path>` instead of `-\t-`, so the binary conflict would slip
 * through. Instead we diff the two conflicting stage blobs directly
 * (stage 2 = ours / PR, stage 3 = theirs / base): `git diff --numstat <a> <b>`
 * reports `-` for both line counts when either blob is binary, which is the
 * reliable signal that the conflict cannot be reconciled as text. Binary
 * conflicts require human judgement and must not be guessed by the agent.
 */
function detectBinaryConflicts(
  runner: CommandRunner,
  cwd: string,
  files: UnmergedFile[],
): string[] {
  const binary: string[] = [];
  for (const file of files) {
    const ours = file.blobs.get(2);
    const theirs = file.blobs.get(3);
    // Modify/delete conflicts (a stage missing) are handled separately; only a
    // full two-sided conflict can be a binary content conflict.
    if (!ours || !theirs) continue;
    const result = runner.run("git", ["diff", "--numstat", ours, theirs], { cwd });
    const line = result.stdout.split("\n").find((l) => l.trim());
    if (!line) continue;
    const parts = line.split("\t");
    if (parts[0] === "-" && parts[1] === "-") {
      binary.push(file.path);
    }
  }
  return binary;
}

/**
 * After the agent runs, the resolution is only safe to commit if the index has
 * no remaining unmerged paths and no leftover conflict markers in the staged
 * content. `git diff --cached --check` exits non-zero when a staged hunk still
 * contains a conflict marker, which catches a partial / marker-leaking edit.
 */
function findConflictMarkerFiles(checkOutput: string): string[] {
  const files = new Set<string>();
  for (const line of checkOutput.split("\n")) {
    const m = line.match(/^([^:]+):\d+: leftover conflict marker/);
    if (m) files.add(m[1]);
  }
  return [...files];
}

function extractPrNumber(prUrl: string): number | undefined {
  // Match GitHub's `/pull/<n>` and Gitea's `/pulls/<n>` PR URL forms; the optional
  // `s` leaves GitHub matching unchanged.
  const m = prUrl.match(/\/pulls?\/(\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}

// ---------------------------------------------------------------------------
// Merge rationale parsing
//
// The conflict-resolution agent is asked to emit a bounded JSON block delimited
// by MERGE_RATIONALE_START / MERGE_RATIONALE_END at the end of its output. The
// block is parsed after the agent exits 0 and all structural checks pass; a
// missing or malformed block fails closed — the merge is aborted rather than
// committed without an auditable rationale.
// ---------------------------------------------------------------------------

const MERGE_RATIONALE_BLOCK_START = "MERGE_RATIONALE_START";
const MERGE_RATIONALE_BLOCK_END = "MERGE_RATIONALE_END";

/**
 * Extract and validate the merge rationale block from raw agent output.
 * Returns the structured {@link MergeRationale} on success, or an explicit
 * error string so the caller can fail closed with a clear message.
 */
export function parseMergeRationale(
  output: string,
): { ok: true; rationale: MergeRationale } | { ok: false; error: string } {
  const start = output.indexOf(MERGE_RATIONALE_BLOCK_START);
  const end = output.indexOf(MERGE_RATIONALE_BLOCK_END);
  if (start === -1 || end === -1 || end <= start) {
    return { ok: false, error: "merge rationale block missing from agent output" };
  }
  const raw = output.slice(start + MERGE_RATIONALE_BLOCK_START.length, end).trim();
  if (!raw) {
    return { ok: false, error: "merge rationale block is empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "merge rationale block is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "merge rationale block is not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj["preservedIssueIntent"] !== "string" || !obj["preservedIssueIntent"].trim()) {
    return { ok: false, error: "merge rationale: preservedIssueIntent must be a non-empty string" };
  }
  if (typeof obj["preservedMainBehavior"] !== "string" || !obj["preservedMainBehavior"].trim()) {
    return { ok: false, error: "merge rationale: preservedMainBehavior must be a non-empty string" };
  }
  if (obj["discardedBehavior"] !== null && typeof obj["discardedBehavior"] !== "string") {
    return { ok: false, error: "merge rationale: discardedBehavior must be a string or null" };
  }
  if (typeof obj["verificationNotes"] !== "string" || !obj["verificationNotes"].trim()) {
    return { ok: false, error: "merge rationale: verificationNotes must be a non-empty string" };
  }
  return {
    ok: true,
    rationale: {
      preservedIssueIntent: (obj["preservedIssueIntent"] as string).slice(0, MERGE_RATIONALE_MAX_FIELD_CHARS),
      preservedMainBehavior: (obj["preservedMainBehavior"] as string).slice(0, MERGE_RATIONALE_MAX_FIELD_CHARS),
      discardedBehavior: obj["discardedBehavior"] === null
        ? null
        : (obj["discardedBehavior"] as string).slice(0, MERGE_RATIONALE_MAX_FIELD_CHARS),
      verificationNotes: (obj["verificationNotes"] as string).slice(0, MERGE_RATIONALE_MAX_FIELD_CHARS),
    },
  };
}

// ---------------------------------------------------------------------------
// Scoped conflict-resolution prompt
//
// The prompt lists exactly the conflicted files and instructs the agent that
// this is conflict resolution only: edit/stage only those files, no commit,
// push, PR creation, or unrelated refactors. It must inspect the conflict state
// with `git status --porcelain` and `git ls-files -u`, and hand off (leave
// unresolved) for binary or modify/delete conflicts.
// ---------------------------------------------------------------------------

interface ConflictPromptInput {
  issueNumber: number;
  prNumber?: number;
  prUrl: string;
  baseBranch: string;
  prBranch: string;
  conflictedFiles: string[];
  repoRoot: string;
  /** Issue title from task context; undefined when not available. */
  issueTitle: string | undefined;
  /** Bounded issue body excerpt from task context; undefined when not available. */
  issueBody: string | undefined;
  /** Bounded diff of what changed on the base branch in the conflicted files. */
  mainSideChanges: string | undefined;
  /** Log excerpt from the most recent prior verification failure, if any. */
  priorFailureExcerpt: string | undefined;
  /** Failed test names from the most recent prior verification failure, if any. */
  priorFailedTests: string[] | undefined;
}

function buildConflictPrompt(input: ConflictPromptInput): string {
  const prRef = input.prNumber !== undefined ? `PR #${input.prNumber}` : "the open PR";
  const fileList = input.conflictedFiles.map((f) => `- ${f}`).join("\n");

  const lines: string[] = [
    `# Conflict Resolution Task — Issue #${input.issueNumber}`,
    "",
    `**${prRef}**: ${input.prUrl}`,
    `Base branch: ${input.baseBranch}`,
    `PR branch: ${input.prBranch}`,
    `Repository root: ${input.repoRoot}`,
    "",
    "A merge of the base branch into the PR branch is in progress and has left",
    "the conflicts listed below in the working tree. **This is conflict resolution",
    "only.** Resolve exactly these conflicts and nothing else.",
    "",
    "## Issue Context",
    "",
    `**Title**: ${input.issueTitle ?? "Not available"}`,
    "",
    input.issueBody ?? "Issue body not available.",
    "",
    "## Main-Side Changes (Conflicted Files)",
    "",
    input.mainSideChanges
      ? ["```diff", input.mainSideChanges, "```"].join("\n")
      : "Not available — no changes detected on the base branch for these files.",
    "",
  ];

  // Prior failure section — only present when a prior attempt recorded failure context.
  const hasPriorFailure =
    input.priorFailureExcerpt !== undefined ||
    (input.priorFailedTests !== undefined && input.priorFailedTests.length > 0);
  if (hasPriorFailure) {
    lines.push(
      "## Prior Verification Failure",
      "",
      "A prior attempt to resolve this conflict passed text resolution but failed",
      "verification. Ensure the resolution makes these tests pass.",
      "",
    );
    if (input.priorFailedTests && input.priorFailedTests.length > 0) {
      lines.push("**Failed tests:**");
      lines.push(...input.priorFailedTests.map((t) => `- ${t}`));
      lines.push("");
    }
    if (input.priorFailureExcerpt) {
      lines.push("**Verification output (excerpt):**", "```", input.priorFailureExcerpt, "```", "");
    }
  }

  lines.push(
    "## Conflicted Files",
    "",
    fileList,
    "",
    "## What To Do",
    "",
    "1. Inspect the conflict state with `git status --porcelain` and `git ls-files -u`.",
    "2. For each conflicted file above, open it, reconcile the two sides into a",
    "   single coherent result, and remove every conflict marker",
    "   (`<<<<<<<`, `=======`, `>>>>>>>`).",
    "3. Stage each resolved file individually with `git add -- <file>`.",
    "4. Preserve **both** the issue-side intent (described above) and the",
    "   main-side changes shown above. The resolution must not silently",
    "   discard either side's intended behavior.",
    "",
    "## Hard Constraints",
    "",
    "- Edit and stage ONLY the conflicted files listed above. Do not touch any",
    "  other file, and do not perform unrelated refactors or cleanups.",
    "- Do NOT commit. Do NOT push. Do NOT create or modify any pull request.",
    "- Do NOT run `gh`, and do NOT run any git command other than",
    "  `git status`, `git ls-files`, and `git add -- <file>`.",
    "- If a conflict is in a binary file, or is a modify/delete conflict (a file",
    "  changed on one side and deleted on the other), do NOT guess. Leave it",
    "  unresolved and stop — these require human judgement.",
    "- Resolve only conflicts that can be reconciled into correct, compilable text.",
  );

  lines.push(
    "",
    "## Merge Rationale (required)",
    "",
    "After all conflicts are resolved and staged, append **exactly** this block as",
    "the **last output** — nothing after it:",
    "",
    "MERGE_RATIONALE_START",
    '{"preservedIssueIntent":"<one sentence>","preservedMainBehavior":"<one sentence>","discardedBehavior":<"one sentence" or null>,"verificationNotes":"<one sentence>"}',
    "MERGE_RATIONALE_END",
    "",
    "- `preservedIssueIntent`: what the issue-side change accomplishes in the merged result.",
    "- `preservedMainBehavior`: what the main-side change accomplishes in the merged result.",
    "- `discardedBehavior`: behavior intentionally dropped during resolution, or `null` when nothing was discarded.",
    "- `verificationNotes`: which tests or checks confirm the combined behavior is correct.",
    "",
    "All values are single plain sentences (no newlines). `discardedBehavior` is the only nullable field.",
    "This block is stored as a local operator record — it is never posted to GitHub.",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Conflict-resolution phase handler factory
//
// Worktree mode (issue #457): when the session enables per-issue worktrees, the
// resolution runs INSIDE the issue worktree on the PR head branch under the
// issue-scoped worktree lock, instead of the canonical checkout. Steps 2–4 are
// replaced by: acquire the lock → fetch (in the canonical repo) → materialize the
// worktree on the PR head → reject a dirty worktree → `git reset --hard
// refs/remotes/origin/<prBranch>` (the canonical `git checkout -B` would fail
// because the PR branch is already checked out in the worktree). Steps 5+ run with
// `cwd` set to the worktree. A worktree-disabled session is byte-for-byte unchanged.
//
// Orchestration order (handler owns ALL repository operations):
//   1. Resolve the open PR for the issue (gh pr list). No PR → ready_for_human.
//   2. git status --porcelain — fail (handoff) if the worktree is dirty.
//   3. git fetch origin <base>:refs/remotes/origin/<base>
//                    <prBranch>:refs/remotes/origin/<prBranch>
//      Explicit refspecs guarantee fresh, checkoutable remote-tracking refs even
//      in a fresh / single-branch clone.
//   4. git checkout -B <prBranch> refs/remotes/origin/<prBranch>
//      Reset the local branch to the fetched remote head (never a stale local).
//   5. git merge --no-commit --no-ff refs/remotes/origin/<base>
//      - clean merge with no MERGE_HEAD (already up to date) → abort (no-op) and
//        return success so review re-runs.
//      - clean merge that produced a merge commit (PR was behind base) → commit
//        and push the base update so review re-runs against the updated branch
//        instead of looping on the stale remote.
//      - binary / modify-delete conflict → abort and mark failed
//        (status:conflict-resolution-failed), since the contract treats these as
//        defined stop conditions that belong in the conflict-resolution-failed lane.
//      - text conflicts → build a scoped prompt and invoke the agent.
//   6. After the agent resolves: verify no unmerged paths / conflict markers
//      remain, that nothing was staged outside the conflict set, that no
//      auto-merged file's staged content was changed, and that the worktree has
//      no unstaged/untracked residue, then run verification (session.verification,
//      e.g. npm test). Because verification can itself regenerate artifacts, the
//      worktree is re-checked once more after it passes; only a still-clean tree
//      is committed with `git commit --no-edit` and pushed with
//      `git push origin <prBranch>`, returning success so the task re-enters
//      review against the resolved branch. Verification and the post-verification
//      cleanliness recheck also gate the clean-base-merge commit/push.
//
// Any path that has entered merge state and is returning blocked or failed
// first runs `git merge --abort` so the worktree is never left in an
// intermediate state. (A push failure happens after the commit lands, when no
// merge is in progress, so it is reported as-is.)
// ---------------------------------------------------------------------------

export function createConflictResolutionHandler(
  context: PhaseHandlerContext,
  runner: CommandRunner = defaultCommandRunner,
  // Injectable so the per-issue worktree materialization can be stubbed in tests,
  // mirroring the review/implementation handlers' resolveWorktree seam.
  resolveWorktree: typeof resolveIssueWorktree = resolveIssueWorktree,
  // Issue-scoped advisory lock that serializes one issue's worktree execution. Only
  // used in worktree mode. Injectable so tests point it at a temp lock dir; in
  // production it defaults to the managed lock dir `admin doctor` already inspects.
  issueLock?: IssueWorktreeLock,
  // When set, the phase runner already acquired the issue-scoped worktree lock under
  // this owner ID before invoking this handler. The handler must NOT acquire the lock
  // itself — that would see it already held and return `blocked` (issue #524). The
  // phase runner is also responsible for releasing the lock after the handler returns,
  // so no `releaseLock` is registered. Leave undefined when calling this handler
  // directly (e.g. in tests) so it acquires and releases the lock as usual.
  phaseLockOwnerId?: string,
): PhaseHandler {
  return async (task: AiTask): Promise<PhaseHandlerResult> => {
    const { session, runId } = context;
    const artifactDir = runArtifactDir(session.artifactRoot, runId);
    // `cwd` is the canonical checkout until a worktree-enabled run materializes the
    // per-issue worktree below and operates there instead.
    let cwd = session.repoRoot;
    const baseBranch = session.baseBranch ?? "main";
    const worktreeMode = session.worktrees?.enabled === true;

    const agentId = agentForPhase(task, session, "conflictResolution");
    const taskLabels = Array.isArray(task.context["labels"])
      ? task.context["labels"] as string[]
      : [];
    const cmdSpec = conflictResolutionCommand(agentId, taskLabels);
    if ("error" in cmdSpec) {
      writeAssignmentFailureArtifact(artifactDir, {
        phase: "conflict_resolution", agentId, sessionId: task.sessionId, issueNumber: task.issueNumber, runId, error: cmdSpec.error,
      });
      return { result: "failed", error: cmdSpec.error, context: { artifactDir, assignmentError: { phase: "conflict_resolution", agent: agentId ?? null } } };
    }
    const resolvedProfile = cmdSpec.profile;

    try {
      mkdirSync(artifactDir, { recursive: true });
    } catch (err) {
      return {
        result: "failed",
        context: { artifactDir, resolvedProfile },
        error: `Failed to create artifact dir: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Resolve the session's repo-host provider so the PR lookup routes through the
    // configured backend: GitHub (`gh` executor, resolved as the GitHub App when
    // configured, else the operator's `gh` session) or Gitea (REST client). The
    // remaining steps are plain local git (fetch/merge/push), which stay local
    // regardless of provider. Routing through the resolver means a `gitea`
    // repo-host session no longer fails here trying to resolve unsupported GitHub
    // auth from its `api-token` mode.
    let sessionRepoHost: SessionRepoHost;
    try {
      sessionRepoHost = await resolveSessionRepoHost(session.repoHostProvider, {
        githubRepo: session.githubRepo,
        cwd,
        ghRunnerFallback: ghRunnerFromCommandRunner(runner),
      });
    } catch (err) {
      return {
        result: "failed",
        context: { artifactDir, resolvedProfile },
        error: `Failed to resolve repo-host provider: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Abort an in-progress merge before returning from a blocked/failed path so
    // the worktree is never left in an intermediate state. Best-effort: a failed
    // abort (e.g. no merge in progress) must not mask the original outcome.
    const abortMerge = (): void => {
      runner.run("git", ["merge", "--abort"], { cwd });
    };

    // `git merge --abort` restores the merge's own tracked changes to the
    // pre-merge state but does NOT touch residue outside the merge: it leaves
    // untracked files in place and leaves unrelated *tracked* edits (e.g. a
    // regenerated tracked artifact or a stray ` M src/other.ts`) dirty. Either
    // kind of residue blocks the next phase's clean-tree preflight. The pre-merge
    // preflight was clean, so any such residue is automation-created and safe to
    // remove. Scope the cleanup to the detected paths so nothing outside the
    // observed residue is touched, and split by tracked-ness: `git clean` removes
    // untracked/ignored paths but is a no-op for tracked files, while `git
    // checkout --` discards unstaged tracked edits but errors on untracked paths.
    // Best-effort: a failure must not mask the original outcome.
    const cleanResidue = (entries: DirtyPath[]): void => {
      const trackedPaths = entries.filter((e) => e.tracked).map((e) => e.path);
      const untrackedPaths = entries.filter((e) => !e.tracked).map((e) => e.path);
      if (trackedPaths.length > 0) {
        runner.run("git", ["checkout", "--", ...trackedPaths], { cwd });
      }
      if (untrackedPaths.length > 0) {
        runner.run("git", ["clean", "-fd", "--", ...untrackedPaths], { cwd });
      }
    };

    // Paths in the worktree that carry unstaged/untracked residue: untracked
    // (`?`), ignored (`!`), or a non-space porcelain second column (unstaged
    // worktree modification). Purely-staged merge content (second column space)
    // is intentionally ignored so an in-progress `--no-commit` merge is not
    // reported as dirty. Each entry records whether the path is tracked so
    // `cleanResidue` can pick `git clean` vs `git checkout --`.
    const worktreeDirtyPaths = (): DirtyPath[] => {
      const status = runner.run("git", ["status", "--porcelain"], { cwd });
      return status.stdout
        .split("\n")
        .filter((l) => l.length > 0)
        .filter((l) => l[0] === "?" || l[0] === "!" || l[1] !== " ")
        .map((l) => ({ path: l.slice(3).trim(), tracked: l[0] !== "?" && l[0] !== "!" }))
        .filter((e) => e.path);
    };

    // Snapshot the staged (stage 0) blob id of each given path. Used to fingerprint
    // the files git auto-merged without conflict so a later edit of their *content*
    // — not just a newly-staged path — can be detected. Makes no git call for an
    // empty path set (nothing was auto-merged).
    const captureStagedBlobs = (paths: string[]): Map<string, string> => {
      const map = new Map<string, string>();
      if (paths.length === 0) return map;
      const out = runner.run("git", ["ls-files", "--stage", "--", ...paths], { cwd });
      for (const line of out.stdout.split("\n")) {
        if (!line.trim()) continue;
        const tab = line.indexOf("\t");
        if (tab === -1) continue;
        const meta = line.slice(0, tab).trim().split(/\s+/); // <mode> <object> <stage>
        const path = line.slice(tab + 1);
        const stage = Number(meta[meta.length - 1]);
        const object = meta.length >= 2 ? meta[1] : undefined;
        if (stage === 0 && object) map.set(path, object);
      }
      return map;
    };

    const writeResult = (fields: Record<string, unknown>): void => {
      writeFileSync(join(artifactDir, "conflict-resolution-result.json"), JSON.stringify({
        issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
        branch: prBranch, prUrl, artifactDir, ...fields,
      }, null, 2), "utf8");
    };

    // Run the configured verification commands (e.g. npm test) against the merged
    // worktree. A conflict can be resolved into code that still breaks the build,
    // and committing/pushing it would advance the PR branch with a broken merge
    // before review re-runs. Returns the first failure so the caller can abort
    // the in-progress merge and hand off; the conflict lane contract requires
    // verification to gate the commit/push.
    const runVerification = (): { name: string; command: string; exitCode: number; output: string } | undefined => {
      for (const [name, command] of Object.entries(session.verification)) {
        const [verCmd, ...verArgs] = parseShellTokens(command);
        if (!verCmd) continue;
        // Capture with the shared large buffer: a verbose but passing command
        // (a full `npm test` log) can exceed Node's default exec buffer, which
        // would make the default runner throw and surface as a non-zero exit —
        // aborting a valid merge as if verification failed.
        const verResult = runner.run(verCmd, verArgs, { cwd, maxBuffer: MAX_VERIFICATION_BUFFER_BYTES });
        writeFileSync(
          join(artifactDir, `conflict-resolution-verification-${name}.log`),
          verResult.stdout + verResult.stderr,
          "utf8",
        );
        if (verResult.exitCode !== 0) {
          return { name, command, exitCode: verResult.exitCode, output: (verResult.stdout + verResult.stderr).trim() };
        }
      }
      return undefined;
    };

    // Commit the in-progress merge (the prepared merge message is reused) and
    // push it so review re-runs against the updated PR branch. Shared by the
    // clean-base-merge path (no agent) and the resolved-conflict path. Before
    // committing, verification must pass — a syntactically-resolved but broken
    // merge is aborted and handed off rather than pushed ahead of review. A
    // commit failure aborts the merge; a push failure happens after the commit
    // lands, when no merge is in progress, so it is reported as-is.
    const commitAndPush = (opts: { reason: string; conflictedFiles: string[]; clean: boolean; mergeRationale?: MergeRationale }): PhaseHandlerResult => {
      // Issue #511: ensure the runtime dependency tree is materialized before
      // running verification. The stamp/skip logic makes this a cheap no-op when
      // the worktree was already prepared by a prior phase. Failure is fail-closed:
      // abort the in-progress merge and surface the prepare error rather than
      // running verification against a broken dependency tree.
      const conflictEnvPrepare = ensureEnvironmentPrepared({
        config: session.environmentPrepare,
        cwd,
        worktreeIdentity: cwd,
        artifactRoot: session.artifactRoot,
        artifactDir,
        runner,
      });
      if (conflictEnvPrepare.status === "failed") {
        abortMerge();
        return {
          result: "failed",
          context: { artifactDir, prUrl, branch: prBranch, conflictedFiles: opts.conflictedFiles, resolvedProfile },
          error: `Environment preparation failed (exit ${conflictEnvPrepare.exitCode ?? 1}) before merge verification: ${(conflictEnvPrepare.output ?? "").slice(0, 500)}`,
        };
      }
      const verFailure = runVerification();
      if (verFailure) {
        // A failing verification command can still emit untracked artifacts
        // (coverage, build output) before exiting non-zero. merge --abort
        // restores tracked files but leaves that residue behind, so capture the
        // dirty paths first and clean them after the abort — otherwise the
        // shared checkout stays dirty and the next retry / recovered task stops
        // at the clean-tree preflight. The pre-merge tree was clean, so any
        // residue here is automation-created and safe to remove.
        const dirtyAfterFailure = worktreeDirtyPaths();
        abortMerge();
        cleanResidue(dirtyAfterFailure);
        const verLogExcerpt = boundedExcerpt(verFailure.output, CONFLICT_VERIFICATION_EXCERPT_CHARS);
        const verFailedTests = extractFailedTestNames(verFailure.output);
        const textConflictsResolved = !opts.clean;

        // Repeated same-kind failure detection (issue #536). Compare the current
        // failedTests with those persisted from the prior attempt. A non-empty
        // overlap means the same semantic conflict is blocking progress; stop
        // retrying and escalate. Empty failedTests (e.g. the test runner never
        // started due to a missing node_modules) are excluded from this check —
        // they must not be mistaken for a semantic-conflict signal.
        //
        // Guard: only reuse prior retry state when it came from the same conflict
        // (same PR branch). Task context is merged across phase transitions, so
        // state written by an earlier conflict-resolution run can survive a
        // recovered/passing run and wrongly escalate an unrelated future conflict
        // on its first real attempt. If the stored branch doesn't match the
        // current prBranch, treat the state as stale and start fresh.
        const priorContextBranch = typeof task.context["branch"] === "string" ? task.context["branch"] : undefined;
        // Treat an absent branch as matching: no recorded branch means the state
        // is from the current run series (or pre-branch-guard legacy context). A
        // stale cross-conflict context would have branch explicitly set to a
        // different value, which is the case this guard is designed to reject.
        const stateMatchesCurrentConflict = priorContextBranch === undefined || priorContextBranch === prBranch;
        const priorSemanticConflict =
          stateMatchesCurrentConflict &&
          typeof task.context["semanticConflict"] === "object" && task.context["semanticConflict"] !== null
            ? task.context["semanticConflict"] as Record<string, unknown>
            : undefined;
        const priorFailedTests = Array.isArray(priorSemanticConflict?.["failedTests"])
          ? priorSemanticConflict["failedTests"] as string[]
          : [];
        const priorAttempts =
          stateMatchesCurrentConflict &&
          typeof task.context["conflictResolutionVerificationAttempts"] === "number"
            ? task.context["conflictResolutionVerificationAttempts"]
            : 0;
        const currentAttempts = priorAttempts + 1;
        const maxAttempts =
          session.conflictResolutionLoop?.maxAttempts ?? DEFAULT_MAX_CONFLICT_RESOLUTION_ATTEMPTS;

        const semanticConflictCtx = {
          verificationCommandName: verFailure.name,
          verificationCommand: verFailure.command,
          exitCode: verFailure.exitCode,
          failedTests: verFailedTests,
          logExcerpt: verLogExcerpt,
          textConflictsResolved,
        };

        writeResult({
          exitCode: verFailure.exitCode,
          success: false,
          step: `verification:${verFailure.name}`,
          conflictedFiles: opts.conflictedFiles,
          verificationCommandName: verFailure.name,
          verificationCommand: verFailure.command,
          logExcerpt: verLogExcerpt,
          failedTests: verFailedTests,
          textConflictsResolved,
          conflictResolutionVerificationAttempts: currentAttempts,
        });

        if (currentAttempts >= maxAttempts && verFailedTests.length > 0 && (priorAttempts === 0 || hasOverlappingFailedTests(priorFailedTests, verFailedTests))) {
          return {
            result: "blocked",
            context: {
              artifactDir, prUrl, branch: prBranch, conflictedFiles: opts.conflictedFiles, resolvedProfile,
              semanticConflict: semanticConflictCtx,
              conflictResolutionVerificationCapReached: true,
              conflictResolutionVerificationAttempts: currentAttempts,
              conflictResolutionMaxAttempts: maxAttempts,
            },
            message: `Repeated conflict-resolution verification failure (${verFailedTests.length} test(s) still failing after ${currentAttempts} attempt(s)) — escalating to human.`,
          };
        }

        return {
          result: "failed",
          context: {
            artifactDir, prUrl, branch: prBranch, conflictedFiles: opts.conflictedFiles, resolvedProfile,
            semanticConflict: semanticConflictCtx,
            conflictResolutionVerificationAttempts: currentAttempts,
          },
          error: `Verification '${verFailure.name}' failed (exit ${verFailure.exitCode}) before committing the merge resolution; aborting to prevent pushing a broken merge`,
        };
      }
      // Verification can itself mutate the worktree (e.g. `npm run package`
      // regenerates workflow JSON). The earlier cleanliness check ran before
      // verification, so re-inspect now: committing here would otherwise omit
      // those generated artifacts and leave the worktree dirty, failing the next
      // review run's own dirty-tree preflight. Abort and hand off — regenerating
      // artifacts is outside the narrow conflict-resolution contract.
      const dirtyAfterVerification = worktreeDirtyPaths();
      if (dirtyAfterVerification.length > 0) {
        abortMerge();
        // Remove the untracked artifacts verification regenerated: merge --abort
        // leaves them behind, which would wedge the next phase's clean-tree
        // preflight. The pre-merge tree was clean, so this residue is ours.
        cleanResidue(dirtyAfterVerification);
        const dirtyList = dirtyAfterVerification.map((p) => p.path);
        writeResult({ exitCode: 0, success: false, step: "verify-dirty-post-verification", conflictedFiles: opts.conflictedFiles, dirtyPaths: dirtyList });
        return {
          result: "failed",
          context: { artifactDir, prUrl, branch: prBranch, conflictedFiles: opts.conflictedFiles, resolvedProfile },
          error: `Verification modified the worktree (e.g. regenerated artifacts) after the cleanliness check; aborting so a merge omitting those changes is not committed/pushed: ${dirtyList.join(", ")}`,
        };
      }
      const commitResult = runner.run("git", ["commit", "--no-edit"], { cwd });
      if (commitResult.exitCode !== 0) {
        abortMerge();
        writeResult({ exitCode: 0, success: false, step: "commit", conflictedFiles: opts.conflictedFiles });
        return {
          result: "failed",
          context: { artifactDir, prUrl, branch: prBranch, conflictedFiles: opts.conflictedFiles, resolvedProfile },
          error: `git commit of the merge resolution failed (exit ${commitResult.exitCode}): ${(commitResult.stderr || commitResult.stdout).slice(0, 300)}`,
        };
      }
      const pushResult = runner.run("git", ["push", "origin", prBranch], { cwd });
      if (pushResult.exitCode !== 0) {
        writeResult({ exitCode: 0, success: false, step: "push", conflictedFiles: opts.conflictedFiles });
        return {
          result: "failed",
          context: { artifactDir, prUrl, branch: prBranch, conflictedFiles: opts.conflictedFiles, resolvedProfile },
          error: `git push origin ${prBranch} failed (exit ${pushResult.exitCode}): ${(pushResult.stderr || pushResult.stdout).slice(0, 300)}`,
        };
      }
      writeResult({
        exitCode: 0, success: true, merged: true, reason: opts.reason,
        step: opts.clean ? "merge" : "agent", conflictedFiles: opts.conflictedFiles,
        ...(opts.mergeRationale !== undefined ? { mergeRationale: opts.mergeRationale } : {}),
      });
      return {
        result: "success",
        context: {
          artifactDir, prUrl, branch: prBranch, conflictedFiles: opts.conflictedFiles,
          ...(opts.clean ? {} : { conflictResolutionAgentUsed: agentId }),
          conflictResolution: opts.clean ? { clean: true, merged: true } : { clean: false, resolved: true },
          resolvedProfile,
          ...(opts.mergeRationale !== undefined ? { mergeRationale: opts.mergeRationale } : {}),
          // Signal the next review phase that it follows a conflict resolution so it
          // can apply conflict-specific review criteria and enforce the loop cap
          // (issue #540). Do NOT reset conflictReviewCycles here — the counter must
          // accumulate across cycles so the cap in review.ts can be reached.
          postConflictReview: true,
          // Clear retry state so a future conflict on the same PR branch starts fresh.
          semanticConflict: null,
          conflictResolutionVerificationAttempts: null,
          conflictResolutionVerificationCapReached: null,
          conflictResolutionMaxAttempts: null,
        },
      };
    };

    // Step 1: Resolve the open PR for the issue. Use `resolveFixPr` (not the
    // convention-only `findOpenPr`) so a PR whose head is NOT the conventional
    // `ai/issue-<n>` branch — a PR-url-only or externally-created head that a
    // worktree review routed here — resolves to its actual head from the recorded
    // `prUrl`/`branch` context, exactly as the review and fix paths do. The
    // convention lookup stays primary, so a conventional PR keeps its prior
    // behavior; without this the worktree path below would fetch/reset the wrong
    // (or a nonexistent `ai/issue-<n>`) branch and block. Distinguish the two error
    // shapes: a genuinely missing PR is a setup-cannot-begin condition → hand
    // off to human (no merge state has been entered). A `gh`/parse failure is a
    // transient lookup error → return `failed` so it surfaces as an
    // operator-visible resolver failure rather than silently clearing the
    // conflict-resolution lane labels and moving the task to ready_for_human.
    const prInfo = resolveFixPr(sessionRepoHost.provider, task, task.issueNumber);
    if ("error" in prInfo) {
      if (prInfo.kind === "lookup-failed") {
        return {
          result: "failed",
          context: { artifactDir, resolvedProfile },
          error: prInfo.error,
        };
      }
      return {
        result: "blocked",
        context: { artifactDir, resolvedProfile },
        message: prInfo.error,
      };
    }
    const prBranch = prInfo.headRefName;
    const prUrl = prInfo.url;
    const prNumber = extractPrNumber(prUrl);

    // Issue #457: per-issue worktree conflict resolution. When the session enables
    // worktrees the resolution runs INSIDE this issue's worktree on the PR head branch
    // instead of the canonical checkout. The canonical path's `git checkout -B
    // <prBranch>` (Step 4) fails in worktree mode because the PR branch is already
    // checked out in the issue worktree (Git refuses a branch held by another
    // worktree). A worktree-disabled session keeps `cwd === session.repoRoot` and its
    // behavior is byte-for-byte unchanged. `prBranch` is the live PR head, so a
    // NON-conventional head (an externally-created PR whose head is not `ai/issue-<n>`)
    // is supported exactly as on the canonical path.
    const conflictLockScope = issueLockScope(task.sessionId, task.issueNumber);
    // Held across the whole worktree-mode resolution and released in the `finally`
    // below — on every return path AND on a thrown error — so the next phase for this
    // issue is never blocked by a leaked lock. Stays undefined when worktrees are
    // disabled, so the canonical path is unchanged.
    let releaseLock: (() => void) | undefined;

    try {
    if (worktreeMode) {
      // Fail closed on a FORKED (cross-repository) PR head before fetching or pushing by
      // branch name (issue #457 review, P2; mirrors implementation.ts's worktree fix
      // guard). A forked PR head lives on the contributor's fork, not `origin`, so the
      // `git fetch origin <prBranch>` below either fails (no such branch on origin) or —
      // worse — fetches an unrelated same-named base-repo branch, and the later `git push
      // origin <prBranch>` then advances that base-repo branch while the real PR on the
      // fork stays untouched. Detection is the PROVIDER's confirmed `isCrossRepository`
      // flag, NOT a `prUrl` heuristic: a SAME-repository non-conventional head pushed to
      // `origin` fetches/pushes by branch name and works fine, so it must not be refused.
      // Until the PR head repository/remote is carried through, refuse rather than touch
      // the wrong branch. The canonical (worktree-disabled) path is unaffected.
      if (prInfo.isCrossRepository === true) {
        return {
          result: "failed",
          context: { artifactDir, prUrl, branch: prBranch, resolvedProfile, conflictLockScope },
          error:
            `Refusing to resolve conflicts for issue #${task.issueNumber}${prNumber !== undefined ? ` on PR #${prNumber}` : ""}: its head is on a fork (a cross-repository PR head lives on the contributor's fork, not origin), so fetching/pushing '${prBranch}' on origin would touch an unrelated base-repo branch instead of the PR head. Carry the PR head repository/remote through before resolving conflicts for forked PRs in worktree mode.`,
        };
      }
      if (phaseLockOwnerId === undefined) {
        // No pre-acquired lock: acquire it here and register release for the finally.
        // When phaseLockOwnerId IS set the phase runner holds the lock already (issue
        // #524) — skip acquire and release; the phase runner releases after we return.
        const lock = issueLock ?? new IssueWorktreeLock();
        const acquired = lock.acquire(runId, task.sessionId, task.issueNumber);
        if (!acquired.locked) {
          return {
            result: "blocked",
            context: { artifactDir, prUrl, branch: prBranch, resolvedProfile, conflictLockScope, conflictLockHeldBy: acquired.ownerContextId },
            message: `Issue #${task.issueNumber} conflict resolution skipped: worktree lock '${conflictLockScope}' is held by ${acquired.ownerContextId} (since ${acquired.ownerStartedAt}) — another execution owns this issue's worktree. Escalating to human.`,
          };
        }
        // Lock held — register release for the finally before any further return.
        releaseLock = () => { lock.release(runId, task.sessionId, task.issueNumber); };
      }

      // Step 3 equivalent: fetch base + PR head into fresh remote-tracking refs. Runs
      // in the canonical repo whose object store the worktree shares; the leading `+`
      // forces the refs to update even on a non-fast-forward move so the worktree
      // resets to the true remote head below. The PR head (`prBranch`) is fetched by
      // its actual ref name, so a non-conventional head is fetched correctly.
      const fetchResult = runner.run("git", [
        "fetch", "origin",
        `+${baseBranch}:refs/remotes/origin/${baseBranch}`,
        `+${prBranch}:refs/remotes/origin/${prBranch}`,
      ], { cwd: session.repoRoot });
      if (fetchResult.exitCode !== 0) {
        return {
          result: "failed",
          context: { artifactDir, prUrl, branch: prBranch, resolvedProfile, conflictLockScope },
          error: `git fetch origin ${baseBranch} ${prBranch} failed (exit ${fetchResult.exitCode}): ${(fetchResult.stderr || fetchResult.stdout).slice(0, 300)}`,
        };
      }

      // Materialize the per-issue worktree on the PR head branch. The worktree was
      // typically removed by the worktree-mode review when it routed the PR to conflict
      // resolution, so this usually re-creates it from the still-present local issue
      // branch (or, on a fresh clone, from the freshly-fetched `origin/<prBranch>`).
      // The resolution resets it to the remote head immediately below, so accept a
      // merely-behind (fast-forwardable) local ref via `allowFastForward`; only a
      // genuinely diverged (force-pushed) head is rejected.
      const materialized = resolveWorktree({
        repoRoot: session.repoRoot,
        sessionId: task.sessionId,
        issueNumber: task.issueNumber,
        branch: prBranch,
        baseRef: `refs/remotes/origin/${prBranch}`,
        allowFastForward: true,
        ...(session.worktrees?.root ? { worktreeRoot: session.worktrees.root } : {}),
        runner,
      });
      if (!materialized.ok) {
        return {
          result: "failed",
          context: { artifactDir, prUrl, branch: prBranch, resolvedProfile, conflictLockScope },
          error: `Failed to prepare issue #${task.issueNumber} conflict-resolution worktree: ${materialized.error}`,
        };
      }
      cwd = materialized.path;

      // Step 2 equivalent: reject a dirty worktree before touching it, so unrelated
      // residue left by a prior phase is escalated to a human rather than silently
      // discarded by the reset below.
      const statusResult = runner.run("git", ["status", "--porcelain"], { cwd });
      if (statusResult.stdout.trim().length > 0) {
        return {
          result: "blocked",
          context: { artifactDir, prUrl, branch: prBranch, resolvedProfile, conflictLockScope },
          message: `Working tree is dirty before conflict resolution; aborting to avoid touching unrelated changes:\n${statusResult.stdout.slice(0, 300)}`,
        };
      }

      // Step 4 equivalent: pin the worktree's PR branch to the freshly-fetched remote
      // head (never a stale local) — the same guarantee the canonical `git checkout -B
      // <prBranch> refs/remotes/origin/<prBranch>` provides. A `git checkout -B` here
      // would fail because the branch is already checked out in this worktree, so reset
      // the held branch in place instead.
      const resetResult = runner.run("git", ["reset", "--hard", `refs/remotes/origin/${prBranch}`], { cwd });
      if (resetResult.exitCode !== 0) {
        return {
          result: "failed",
          context: { artifactDir, prUrl, branch: prBranch, resolvedProfile, conflictLockScope },
          error: `git reset --hard refs/remotes/origin/${prBranch} (pin worktree to PR head) failed (exit ${resetResult.exitCode}): ${(resetResult.stderr || resetResult.stdout).slice(0, 300)}`,
        };
      }
    } else {
      // Step 2: Preflight — reject a dirty working tree (handoff, no merge yet).
      const statusResult = runner.run("git", ["status", "--porcelain"], { cwd });
      if (statusResult.stdout.trim().length > 0) {
        return {
          result: "blocked",
          context: { artifactDir, prUrl, branch: prBranch, resolvedProfile },
          message: `Working tree is dirty before conflict resolution; aborting to avoid touching unrelated changes:\n${statusResult.stdout.slice(0, 300)}`,
        };
      }

      // Step 3: Fetch base and PR head with explicit refspecs so the refs used for
      // checkout and merge are fresh and checkoutable even in a single-branch clone.
      // The leading `+` forces the remote-tracking refs to update even on a
      // non-fast-forward move (e.g. after a rebase or amended automation commit),
      // so checkout/merge resets to the true remote head instead of failing.
      const fetchResult = runner.run("git", [
        "fetch", "origin",
        `+${baseBranch}:refs/remotes/origin/${baseBranch}`,
        `+${prBranch}:refs/remotes/origin/${prBranch}`,
      ], { cwd });
      if (fetchResult.exitCode !== 0) {
        return {
          result: "failed",
          context: { artifactDir, prUrl, branch: prBranch, resolvedProfile },
          error: `git fetch origin ${baseBranch} ${prBranch} failed (exit ${fetchResult.exitCode}): ${(fetchResult.stderr || fetchResult.stdout).slice(0, 300)}`,
        };
      }

      // Step 4: Reset the PR branch to the fetched remote head (never a stale local).
      const checkoutResult = runner.run("git", ["checkout", "-B", prBranch, `refs/remotes/origin/${prBranch}`], { cwd });
      if (checkoutResult.exitCode !== 0) {
        return {
          result: "failed",
          context: { artifactDir, prUrl, branch: prBranch, resolvedProfile },
          error: `git checkout -B ${prBranch} failed (exit ${checkoutResult.exitCode}): ${(checkoutResult.stderr || checkoutResult.stdout).slice(0, 300)}`,
        };
      }
    }

    // Step 5: Attempt the merge without committing. --no-ff forces a merge so
    // conflicts surface even when the PR branch is strictly behind the base.
    const mergeResult = runner.run("git", ["merge", "--no-commit", "--no-ff", `refs/remotes/origin/${baseBranch}`], { cwd });
    if (mergeResult.exitCode === 0) {
      // Clean merge. Distinguish a real base update from an already-up-to-date
      // no-op: a no-op leaves no MERGE_HEAD (nothing to merge), while a PR that
      // was merely behind the base leaves MERGE_HEAD and staged base changes.
      const mergeHead = runner.run("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd });
      if (mergeHead.exitCode !== 0) {
        // Already up to date — the PR branch already contains the base. True
        // no-op; abort is a harmless cleanup. Return success → review re-runs.
        // Set postConflictReview so review.ts arms the conflict-review loop cap
        // (issue #540): without this flag the no-op path can bounce
        // review → conflict_resolution → review indefinitely.
        abortMerge();
        writeResult({ success: true, merged: false, reason: "already-up-to-date" });
        return {
          result: "success",
          context: {
            artifactDir, prUrl, branch: prBranch, resolvedProfile, conflictResolution: { clean: true, merged: false },
            postConflictReview: true,
            semanticConflict: null,
            conflictResolutionVerificationAttempts: null,
            conflictResolutionVerificationCapReached: null,
            conflictResolutionMaxAttempts: null,
          },
        };
      }
      // The base merged cleanly but produced a merge commit (the PR was behind
      // the base). Committing and pushing it advances the remote branch so
      // review re-runs against the updated branch; aborting here would discard
      // the base update and let the task loop on the stale remote state.
      return commitAndPush({ reason: "clean-base-merge", conflictedFiles: [], clean: true });
    }

    // Merge failed: distinguish real conflicts from an unexpected merge error.
    const lsFilesResult = runner.run("git", ["ls-files", "-u"], { cwd });
    const unmerged = parseUnmergedFiles(lsFilesResult.stdout);
    if (unmerged.length === 0) {
      // Non-zero exit with no unmerged paths → unexpected failure, not a conflict.
      abortMerge();
      writeResult({ success: false, step: "merge" });
      return {
        result: "failed",
        context: { artifactDir, prUrl, branch: prBranch, resolvedProfile },
        error: `git merge of ${baseBranch} into ${prBranch} failed (exit ${mergeResult.exitCode}) with no unmerged paths: ${(mergeResult.stderr || mergeResult.stdout).slice(0, 300)}`,
      };
    }

    const conflictedFiles = unmerged.map((f) => f.path);

    // Binary / modify/delete conflicts require human judgement — do not let the
    // agent guess. Abort and hand off.
    if (hasModifyDeleteConflict(unmerged)) {
      abortMerge();
      const modifyDelete = unmerged
        .filter((f) => !(f.stages.has(2) && f.stages.has(3)))
        .map((f) => f.path);
      writeResult({ success: false, step: "modify-delete-conflict", conflictedFiles, modifyDelete });
      // Per the conflict-resolution contract a modify/delete conflict is a defined
      // stop condition that must mark status:conflict-resolution-failed, not
      // ready_for_human. Returning `failed` (the merge is already aborted) clears
      // the conflict-resolution lane labels and adds the failed label so operators
      // see the issue in the conflict-resolution-failed lane; returning `blocked`
      // would instead move it to ready_for_human and bypass that failed-label path.
      return {
        result: "failed",
        context: { artifactDir, prUrl, branch: prBranch, conflictedFiles, resolvedProfile },
        error: `Modify/delete conflict requires human judgement (not auto-resolvable): ${modifyDelete.join(", ")}`,
      };
    }

    // Binary files conflicted on both sides keep all three ls-files stages, so
    // they slip past the modify/delete check above. The agent cannot reconcile
    // binary content — detect it explicitly and hand off before invoking it.
    const binaryConflicts = detectBinaryConflicts(runner, cwd, unmerged);
    if (binaryConflicts.length > 0) {
      abortMerge();
      writeResult({ success: false, step: "binary-conflict", conflictedFiles, binaryConflicts });
      // Mark status:conflict-resolution-failed, not ready_for_human — same rationale
      // as the modify/delete branch above: per the contract a binary conflict is a
      // defined stop condition, so it belongs in the conflict-resolution-failed lane
      // rather than being escalated as ready_for_human via `blocked`.
      return {
        result: "failed",
        context: { artifactDir, prUrl, branch: prBranch, conflictedFiles, resolvedProfile },
        error: `Binary conflict requires human judgement (not auto-resolvable): ${binaryConflicts.join(", ")}`,
      };
    }

    // Baseline of the paths git staged while auto-merging the non-conflicting
    // base changes. The agent is only permitted to resolve the conflicted files,
    // so after it runs the staged set must not grow beyond this baseline plus the
    // conflicted files themselves — anything else is an unrelated change.
    const preMergeStaged = runner.run("git", ["diff", "--cached", "--name-only"], { cwd });
    const stagedBaseline = preMergeStaged.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const allowedStaged = new Set<string>([...stagedBaseline, ...conflictedFiles]);
    // A path being in `allowedStaged` only authorises it to *remain* staged; it
    // does not authorise the agent to change its content. Fingerprint the blobs of
    // the auto-merged (non-conflicted) staged files so a content edit of one — not
    // just a brand-new staged path — is caught after the agent runs.
    const autoMergedFiles = stagedBaseline.filter((p) => !conflictedFiles.includes(p));
    const autoMergedBlobs = captureStagedBlobs(autoMergedFiles);
    // A base merge can auto-stage a *deletion* of a non-conflicted file. Such a
    // path is in `stagedBaseline` (so `allowedStaged` permits it to stay) but has
    // no stage-0 blob, so `captureStagedBlobs` records nothing for it and it never
    // enters `autoMergedBlobs`. Track these deleted paths separately so that if the
    // agent recreates and re-stages one, the content-drift check below still flags
    // it — otherwise the recreation would slip through both the path and blob
    // checks and be committed.
    const autoMergedDeleted = autoMergedFiles.filter((p) => !autoMergedBlobs.has(p));

    // Issue #511: ensure the runtime dependency tree is materialized before the
    // conflict-resolution agent runs, not just before verification inside
    // commitAndPush. The stamp/skip logic makes this a cheap no-op when the
    // worktree was already prepared by a prior phase. Failure is fail-closed:
    // abort the in-progress merge so a broken dependency tree is never handed
    // to the agent.
    //
    // Exception: if a configured cacheKeyFile (e.g. package-lock.json) is itself
    // among the conflicted files, the file contains conflict markers and the
    // prepare command (e.g. `npm ci`) would fail immediately — preventing the
    // agent from resolving exactly the dependency-file conflict that makes
    // preparation possible. Defer prepare in that case; commitAndPush runs it
    // after the agent has resolved conflicts and the file is well-formed again.
    const cacheKeyFilesConflicted =
      session.environmentPrepare?.enabled === true &&
      Array.isArray(session.environmentPrepare.cacheKeyFiles) &&
      session.environmentPrepare.cacheKeyFiles.some((f) => conflictedFiles.includes(f));
    if (!cacheKeyFilesConflicted) {
      const preAgentEnvPrepare = ensureEnvironmentPrepared({
        config: session.environmentPrepare,
        cwd,
        worktreeIdentity: cwd,
        artifactRoot: session.artifactRoot,
        artifactDir,
        runner,
      });
      if (preAgentEnvPrepare.status === "failed") {
        abortMerge();
        return {
          result: "failed",
          context: { artifactDir, prUrl, branch: prBranch, conflictedFiles, resolvedProfile },
          error: `Environment preparation failed (exit ${preAgentEnvPrepare.exitCode ?? 1}) before conflict-resolution agent: ${(preAgentEnvPrepare.output ?? "").slice(0, 500)}`,
        };
      }
    }

    // Gather bounded semantic context for the conflict-resolution prompt.
    // Missing fields are passed as undefined and rendered as "Not available" in
    // the prompt. No AI summaries — context is deterministic and bounded.
    const issueTitle =
      typeof task.context["title"] === "string" ? task.context["title"] : undefined;
    const rawIssueBody =
      typeof task.context["body"] === "string" ? task.context["body"] : undefined;
    const issueBody = rawIssueBody
      ? boundedExcerpt(rawIssueBody, CONFLICT_ISSUE_BODY_CHARS)
      : undefined;

    // Main-side changes: what the base branch changed in the conflicted files since
    // the merge base. Three-dot diff computes the symmetric diff from the merge base
    // without a separate merge-base call. Bounded to keep the prompt focused.
    const mainDiffResult = runner.run(
      "git",
      ["diff", `refs/remotes/origin/${prBranch}...refs/remotes/origin/${baseBranch}`, "--", ...conflictedFiles],
      { cwd },
    );
    const mainSideChanges = mainDiffResult.stdout.trim()
      ? boundedExcerpt(mainDiffResult.stdout.trim(), CONFLICT_MAIN_SIDE_DIFF_CHARS)
      : undefined;

    // Prior failure context: from the semanticConflict field written by the prior attempt.
    // Apply the same branch guard used in commitAndPush so stale cross-conflict state
    // from a different PR branch is never surfaced to the agent.
    const priorCtxBranch =
      typeof task.context["branch"] === "string" ? task.context["branch"] : undefined;
    const priorStateMatchesBranch =
      priorCtxBranch === undefined || priorCtxBranch === prBranch;
    const priorSemanticCtx =
      priorStateMatchesBranch &&
      typeof task.context["semanticConflict"] === "object" &&
      task.context["semanticConflict"] !== null
        ? (task.context["semanticConflict"] as Record<string, unknown>)
        : undefined;
    const priorFailureExcerpt =
      typeof priorSemanticCtx?.["logExcerpt"] === "string"
        ? priorSemanticCtx["logExcerpt"]
        : undefined;
    const priorFailedTests = Array.isArray(priorSemanticCtx?.["failedTests"])
      ? (priorSemanticCtx?.["failedTests"] as string[])
      : undefined;

    // Build the scoped prompt and invoke the agent for text-conflict resolution.
    const prompt = buildConflictPrompt({
      issueNumber: task.issueNumber,
      prNumber,
      prUrl,
      baseBranch,
      prBranch,
      conflictedFiles,
      repoRoot: cwd,
      issueTitle,
      issueBody,
      mainSideChanges,
      priorFailureExcerpt,
      priorFailedTests,
    });
    writeFileSync(join(artifactDir, "conflict-resolution-prompt.md"), prompt, "utf8");
    // Include the full persisted assignment (flow, source, resolvedAt, all phase
    // agents) so the run dir is self-describing, not just the per-phase resolvedProfile.
    const assignment = readResolvedAssignment(task);
    writeFileSync(join(artifactDir, "conflict-resolution-context.json"), JSON.stringify({
      issueNumber: task.issueNumber, sessionId: task.sessionId, runId, agentId,
      prUrl, branch: prBranch, baseBranch, conflictedFiles, resolvedProfile,
      ...(assignment ? { assignment } : {}),
      promptContext: {
        issueTitleAvailable: issueTitle !== undefined,
        issueBodyAvailable: issueBody !== undefined,
        mainSideChangesAvailable: mainSideChanges !== undefined,
        priorFailureAvailable:
          priorFailureExcerpt !== undefined ||
          (priorFailedTests !== undefined && priorFailedTests.length > 0),
      },
    }, null, 2), "utf8");

    const agentResult = runner.run(resolvedProfile.cmd, resolvedProfile.argv, { cwd, stdin: prompt });
    writeFileSync(join(artifactDir, "conflict-resolution-output.md"), agentResult.stdout || agentResult.stderr, "utf8");

    if (agentResult.exitCode !== 0) {
      // The agent's allowed Write/Edit tools can have created untracked or
      // unstaged residue before it exited non-zero. merge --abort restores
      // tracked files but leaves that residue behind, so capture the dirty paths
      // first and clean them after the abort — otherwise the shared checkout
      // stays dirty and the next phase fails its clean-tree preflight. The
      // pre-merge tree was clean, so any residue here is automation-created.
      const dirtyAfterAgent = worktreeDirtyPaths();
      abortMerge();
      cleanResidue(dirtyAfterAgent);
      // Quota/rate-limit exhaustion is recoverable on its own (issue #25): the
      // merge was aborted and the worktree restored, so delay the retry instead
      // of failing the task to a human.
      const quota = classifyQuotaExhaustion(`${agentResult.stdout}\n${agentResult.stderr}`, agentId);
      writeResult({
        exitCode: agentResult.exitCode, success: false, step: "agent", conflictedFiles,
        ...(quota.isQuotaExhaustion ? { delayed: true, quotaSignal: quota.signal } : {}),
      });
      if (quota.isQuotaExhaustion) {
        return {
          result: "delayed",
          context: { artifactDir, prUrl, branch: prBranch, conflictedFiles, resolvedProfile, quotaSignal: quota.signal },
          message: `Conflict-resolution agent (${agentId}) hit a quota/rate-limit (signal: "${quota.signal}"); delaying retry`,
        };
      }
      return {
        result: "failed",
        context: { artifactDir, prUrl, branch: prBranch, conflictedFiles, resolvedProfile },
        error: `Conflict-resolution agent exited ${agentResult.exitCode}: ${(agentResult.stderr || agentResult.stdout).slice(0, 500)}`,
      };
    }

    // The agent exited cleanly. Before committing, verify the resolution is
    // complete: no unmerged paths may remain in the index, and no conflict
    // marker may survive in the staged content. A failed verification is a stop
    // condition — abort the merge so the worktree is never left mid-merge.
    const postLsFiles = runner.run("git", ["ls-files", "-u"], { cwd });
    const remainingUnmerged = parseUnmergedFiles(postLsFiles.stdout).map((f) => f.path);
    if (remainingUnmerged.length > 0) {
      // The agent can leave unresolved paths *and* untracked residue (e.g. a
      // scratch file) before exiting 0. merge --abort restores the tracked merge
      // state but leaves untracked files behind, so capture the dirty paths first
      // and clean them after the abort — as in the agent-error and verify-worktree
      // paths — or the shared checkout stays dirty and the next phase fails its
      // clean-tree preflight. The pre-merge tree was clean, so any residue here is
      // automation-created.
      const dirtyAfterAgent = worktreeDirtyPaths();
      abortMerge();
      cleanResidue(dirtyAfterAgent);
      writeResult({ exitCode: 0, success: false, step: "verify-unmerged", conflictedFiles, remainingUnmerged });
      return {
        result: "failed",
        context: { artifactDir, prUrl, branch: prBranch, conflictedFiles, resolvedProfile },
        error: `Conflict-resolution agent left ${remainingUnmerged.length} unmerged path(s): ${remainingUnmerged.join(", ")}`,
      };
    }

    // `git diff --cached --check` exits non-zero for *any* flagged content,
    // including pure whitespace errors (trailing whitespace, etc.) in correctly
    // resolved hunks. Only a leftover conflict marker is a stop condition here, so
    // key the failure on the parsed marker lines rather than the exit code — a
    // whitespace-only failure must not reject an otherwise valid resolution.
    const markerCheck = runner.run("git", ["diff", "--cached", "--check"], { cwd });
    const markerFiles = findConflictMarkerFiles(markerCheck.stdout || markerCheck.stderr);
    if (markerFiles.length > 0) {
      // The agent can leave untracked residue alongside the marker-leaking edit;
      // merge --abort restores tracked files but not untracked ones, so capture
      // the dirty paths first and clean them after the abort or the shared
      // checkout stays dirty and the next phase fails its clean-tree preflight.
      const dirtyAfterAgent = worktreeDirtyPaths();
      abortMerge();
      cleanResidue(dirtyAfterAgent);
      writeResult({ exitCode: 0, success: false, step: "verify-markers", conflictedFiles, markerFiles });
      return {
        result: "failed",
        context: { artifactDir, prUrl, branch: prBranch, conflictedFiles, resolvedProfile },
        error: `Conflict markers remain in staged files after resolution${markerFiles.length ? `: ${markerFiles.join(", ")}` : ""}.`,
      };
    }

    // The allowed tools let the agent `git add -- <path>` for any path, so an
    // unrelated file could be staged alongside the resolutions. Confirm the
    // staged set did not grow beyond the merge's auto-merged baseline plus the
    // conflicted files; an extra path is an unrelated change that must not be
    // committed or pushed. A failed check aborts the merge.
    const stagedNow = runner.run("git", ["diff", "--cached", "--name-only"], { cwd });
    const unrelatedStaged = stagedNow.stdout
      .split("\n").map((l) => l.trim()).filter(Boolean)
      .filter((p) => !allowedStaged.has(p));
    if (unrelatedStaged.length > 0) {
      // The agent can leave untracked residue alongside staging the unrelated
      // file; merge --abort restores tracked files but not untracked ones, so
      // capture the dirty paths first and clean them after the abort or the
      // shared checkout stays dirty and the next phase fails its preflight.
      const dirtyAfterAgent = worktreeDirtyPaths();
      abortMerge();
      cleanResidue(dirtyAfterAgent);
      writeResult({ exitCode: 0, success: false, step: "verify-staged", conflictedFiles, unrelatedStaged });
      return {
        result: "failed",
        context: { artifactDir, prUrl, branch: prBranch, conflictedFiles, resolvedProfile },
        error: `Conflict-resolution agent staged file(s) outside the conflict set: ${unrelatedStaged.join(", ")}`,
      };
    }

    // The path check above allows the auto-merged files to stay staged, but the
    // contract is that only conflicted files may be *edited*. If the agent edited
    // and re-staged one of the auto-merged files, its path is still allowed yet
    // its content changed — compare the staged blobs against the pre-agent
    // fingerprint and reject any whose content drifted. A path the base merge
    // staged as a deletion must likewise stay deleted: if it now has a stage-0 blob
    // the agent recreated and re-staged it, which is an unrelated edit. A failed
    // check aborts.
    const modifiedAutoMerged = (() => {
      const changed: string[] = [];
      if (autoMergedBlobs.size > 0) {
        const postBlobs = captureStagedBlobs([...autoMergedBlobs.keys()]);
        for (const [path, blob] of autoMergedBlobs.entries()) {
          if (postBlobs.get(path) !== blob) changed.push(path);
        }
      }
      if (autoMergedDeleted.length > 0) {
        const postDeleted = captureStagedBlobs(autoMergedDeleted);
        for (const path of autoMergedDeleted) {
          if (postDeleted.has(path)) changed.push(path);
        }
      }
      return changed;
    })();
    if (modifiedAutoMerged.length > 0) {
      // The agent can leave untracked residue alongside editing the auto-merged
      // file; merge --abort restores tracked files but not untracked ones, so
      // capture the dirty paths first and clean them after the abort or the
      // shared checkout stays dirty and the next phase fails its preflight.
      const dirtyAfterAgent = worktreeDirtyPaths();
      abortMerge();
      cleanResidue(dirtyAfterAgent);
      writeResult({ exitCode: 0, success: false, step: "verify-auto-merged-content", conflictedFiles, modifiedAutoMerged });
      return {
        result: "failed",
        context: { artifactDir, prUrl, branch: prBranch, conflictedFiles, resolvedProfile },
        error: `Conflict-resolution agent modified auto-merged file(s) outside the conflict set: ${modifiedAutoMerged.join(", ")}`,
      };
    }

    // `git diff --cached` only sees the staged set, so the checks above miss an
    // agent that edited an unrelated file without staging it, created an
    // untracked file, or re-modified an already-resolved file after `git add`.
    // Inspect the full worktree: any path that is untracked or carries unstaged
    // worktree changes (porcelain second column non-space) means the resolution
    // is dirty and must not be committed/pushed — the next review run would
    // otherwise block on its own dirty-worktree preflight. Abort and hand off.
    const dirtyPaths = worktreeDirtyPaths();
    if (dirtyPaths.length > 0) {
      abortMerge();
      // merge --abort restores the merge's own tracked changes but leaves the
      // agent's untracked residue and any unrelated tracked edits behind; the
      // pre-merge tree was clean, so remove them here too or the next phase's
      // clean-tree preflight would wedge on it.
      cleanResidue(dirtyPaths);
      const dirtyList = dirtyPaths.map((p) => p.path);
      writeResult({ exitCode: 0, success: false, step: "verify-worktree", conflictedFiles, dirtyPaths: dirtyList });
      return {
        result: "failed",
        context: { artifactDir, prUrl, branch: prBranch, conflictedFiles, resolvedProfile },
        error: `Conflict-resolution agent left unstaged or untracked changes after resolution: ${dirtyList.join(", ")}`,
      };
    }

    // Parse merge rationale from agent output before committing. A missing or
    // malformed rationale fails closed — the merge is aborted rather than pushed
    // without an auditable record of what was preserved and what was discarded.
    // The rationale is stored only in the local artifact and internal task context;
    // it is never posted to GitHub or passed to review prompts.
    const rationaleResult = parseMergeRationale(agentResult.stdout || agentResult.stderr);
    if (!rationaleResult.ok) {
      abortMerge();
      writeResult({ exitCode: 0, success: false, step: "missing-rationale", conflictedFiles, rationaleError: rationaleResult.error });
      return {
        result: "failed",
        context: { artifactDir, prUrl, branch: prBranch, conflictedFiles, resolvedProfile },
        error: `Conflict-resolution agent output is missing or has a malformed merge rationale: ${rationaleResult.error}`,
      };
    }
    const mergeRationale = rationaleResult.rationale;

    // Resolution verified — commit and push so review re-runs against the branch.
    return commitAndPush({ reason: "conflicts-resolved", conflictedFiles, clean: false, mergeRationale });
    } finally {
      // Release the issue-scoped worktree lock on every return path (and on a thrown
      // error). `releaseLock` is undefined when worktrees are disabled, so the
      // canonical path is unaffected.
      if (releaseLock) releaseLock();
    }
  };
}
