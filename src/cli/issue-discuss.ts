/**
 * issue-discuss — issue refinement preview and safe post.
 *
 * preview (issue #244): Reads a GitHub issue and writes a local planning prompt
 * plus a captured-context artifact. Strictly read-only with respect to GitHub.
 *
 * post (issue #246): Loads a previously reviewed preview artifact, re-verifies
 * the live issue state against the stored fingerprint, and posts the reviewed
 * draft as a GitHub comment. The post path never re-runs any AI agent and never
 * posts content other than the operator-reviewed draft file.
 *
 * Safety invariants:
 * - The post command reads the live issue state to detect staleness; it refuses
 *   to post if state, body, labels, or the bounded comment window changed since
 *   preview.
 * - The --approve token (fingerprint emitted by preview) proves the operator
 *   saw the artifact before approving the post.
 * - No agent (Codex / Claude / Gemini) is invoked in the post path.
 * - Local artifact paths are never included in the posted comment.
 *
 * Safety boundary (issue #244): this slice is strictly read-only with respect to
 * GitHub. It reads issue data via an injectable reader and writes ONLY local
 * artifacts. It never posts comments, mutates labels/state, creates branches or
 * PRs, or enqueues tasks. The module deliberately does not import any GitHub
 * write surface (gh-dispatcher / outbox / task store), so there is no code path
 * that could mutate the remote.
 *
 * Isolation model (issue #245): untrusted GitHub issue text can contain
 * prompt-injection payloads that, if processed by an AI agent with write access,
 * could cause authenticated GitHub side effects. The isolation boundary enforced
 * here is:
 *
 *   1. READ STEP (this module): the injectable IssueDiscussReader interface
 *      exposes only readIssue — no write method exists. defaultIssueDiscussReader
 *      calls only read-only gh subcommands (gh issue view, gh api graphql with a
 *      read-only query). All auth tokens remain in the reader's env because they
 *      are needed for fetching; the reader is trusted/controlled code.
 *
 *   2. AGENT EXECUTION STEP (future): any AI agent invoked on the generated
 *      prompt must run with write-enabling env vars stripped (see buildIsolatedEnv
 *      below). The agent should not receive the repo working tree or broad
 *      filesystem access. Generated output is returned as a local artifact only —
 *      it is never auto-posted.
 *
 *   3. POST STEP (separate, human-approved): a distinct safe-post command (not
 *      implemented here) is responsible for reviewing generated output and posting
 *      it to GitHub with explicit human approval.
 *
 * buildIsolatedEnv() is exported for use by the forthcoming agent-execution step.
 */

import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import {
  DEFAULT_SESSIONS_PATH,
  describeUnresolvedSessionId,
  JsonSessionRegistry,
} from "../registries/json-session-registry.js";
import { emit, die } from "./cli-io.js";
import { tokenizeArgs } from "./admin-command.js";

// ---------------------------------------------------------------------------
// Isolation — env-var stripping for the agent-execution step.
//
// GitHub CLI (`gh`) and Actions runtimes accept several token env vars that
// grant write access to the API. Any AI agent subprocess that processes the
// issue-discuss prompt must have these stripped so that prompt-injected text
// cannot trigger authenticated writes.
//
// The READ STEP (defaultIssueDiscussReader) calls gh with the full caller env
// because it needs auth to fetch issue data; those calls are read-only by
// construction. buildIsolatedEnv() targets the AGENT EXECUTION boundary only.
// ---------------------------------------------------------------------------

/**
 * Env vars that leak the caller's current working directory.
 *
 * When this command runs from inside a checkout, `process.env` usually carries
 * `PWD` (and, under npm, `INIT_CWD`/`OLDPWD`) pointing at that checkout. npm also
 * injects absolute checkout paths via `npm_config_local_prefix` (the package
 * root) and `npm_package_json` (its `package.json`) when launched through
 * `npm run`/`npm exec`. Passing any of these to the tool-capable agent would let
 * untrusted issue text instruct it to `cd "$PWD"` (or `cd
 * "$npm_config_local_prefix"`), escaping the isolated temp `cwd` and defeating the
 * isolation boundary. They are removed so the agent only sees its sandboxed `cwd`.
 */
export const CWD_BEARING_ENV_KEYS: readonly string[] = [
  "PWD",
  "OLDPWD",
  "INIT_CWD",
  "npm_config_local_prefix",
  "npm_package_json",
] as const;

/** Env vars that grant GitHub write (or elevated) access via the gh CLI or Actions runtime. */
export const WRITE_ENABLING_ENV_KEYS: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_APP_ID",
  "GH_INSTALLATION_TOKEN",
  "GITHUB_APP_TOKEN",
  "GITHUB_CLIENT_SECRET",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
] as const;

/**
 * Return a copy of `env` with all write-enabling GitHub env vars removed
 * and `gh`'s credential store redirected to an empty temp directory.
 *
 * Use this when spawning the AI agent subprocess that will process an
 * issue-discuss prompt. After this transform:
 *
 * - Token env vars (GH_TOKEN, GITHUB_TOKEN, …) are deleted so the agent
 *   cannot authenticate via environment variables.
 * - HOME is redirected to a fresh empty temp directory so a prompt-injected
 *   agent that can run shell commands cannot reach stored credentials by
 *   overriding GH_CONFIG_DIR=$HOME/.config/gh or by unsetting GH_CONFIG_DIR
 *   (which causes gh to fall back to $HOME/.config/gh).
 * - GH_CONFIG_DIR is set to the same empty temp directory as an explicit
 *   override so gh never loads credentials regardless of HOME.
 * - XDG_CONFIG_HOME is deleted to close the secondary credential store path.
 * - Cwd-bearing vars (PWD, OLDPWD, INIT_CWD) are deleted so a prompt-injected
 *   agent cannot `cd` back into the caller's checkout via the inherited PWD.
 *
 * Generated output is returned as a local artifact only — it is never auto-posted.
 */
export function buildIsolatedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = { ...env };
  for (const key of WRITE_ENABLING_ENV_KEYS) {
    delete isolated[key];
  }
  for (const key of CWD_BEARING_ENV_KEYS) {
    delete isolated[key];
  }
  // Redirect HOME and GH_CONFIG_DIR to the same empty temp directory.
  // Stripping token vars alone is not enough: a prompt-injected agent that
  // can run shell commands can set GH_CONFIG_DIR=$HOME/.config/gh or unset
  // GH_CONFIG_DIR before invoking gh, falling back to the stored credentials
  // under the caller's HOME. Redirecting HOME closes that fallback path.
  const isolatedHome = mkdtempSync(join(tmpdir(), "gh-isolated-"));
  isolated["HOME"] = isolatedHome;
  isolated["GH_CONFIG_DIR"] = isolatedHome;
  delete isolated["XDG_CONFIG_HOME"];
  return isolated;
}

// ---------------------------------------------------------------------------
// Bounds — keep prompt/artifact sizes predictable regardless of issue size.
// ---------------------------------------------------------------------------

const MAX_TITLE_CHARS = 300;
const MAX_BODY_CHARS = 8000;
const MAX_COMMENT_CHARS = 2000;
const DEFAULT_COMMENT_LIMIT = 10;
const MAX_COMMENT_LIMIT = 50;

// Buffer ceiling for `gh` subprocess output. The default execFileSync buffer
// (~1 MiB) can be exceeded by a heavily commented issue *before* our own bounds
// apply, causing the fetch to fail outright. We instead bound the fetch itself
// (base fields without comments; comments via `last:N`) and size the buffer to
// comfortably hold MAX_COMMENT_LIMIT max-length comments plus overhead.
const GH_MAX_BUFFER = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface IssueDiscussArgs {
  sessionId: string;
  issueNumber: number;
  sessionsPath: string;
  commentLimit: number;
}

export function parseIssueDiscussArgs(argv: string[]): IssueDiscussArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["session-id", "issue-number", "sessions-path", "comment-limit"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;

  if (!args["session-id"]) return { error: "--session-id is required" };
  if (args["issue-number"] === undefined) return { error: "--issue-number is required" };

  const issueNumber = Number(args["issue-number"]);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
  }

  let commentLimit = DEFAULT_COMMENT_LIMIT;
  if (args["comment-limit"] !== undefined) {
    const n = Number(args["comment-limit"]);
    if (!Number.isInteger(n) || n < 0) {
      return { error: `--comment-limit must be a non-negative integer, got: ${args["comment-limit"]}` };
    }
    commentLimit = Math.min(n, MAX_COMMENT_LIMIT);
  }

  return {
    sessionId: args["session-id"],
    issueNumber,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    commentLimit,
  };
}

// ---------------------------------------------------------------------------
// Session resolution
//
// Resolve through the central JsonSessionRegistry so this command honors the
// same validation as the rest of the system: artifactDir must be relative to
// repoRoot (so the resolved artifactRoot stays inside the repo-scoped artifact
// area) and githubRepo must be a well-formed owner/name. Hand-edited or stale
// session files that the registry rejects are not silently accepted here.
// ---------------------------------------------------------------------------

interface ResolvedDiscussSession {
  sessionId: string;
  githubRepo: string;
  artifactRoot: string;
}

async function resolveSession(
  sessionId: string,
  sessionsPath: string,
): Promise<ResolvedDiscussSession | { error: string }> {
  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    return {
      error: `Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const session = await registry.getSessionById(sessionId);
  if (!session) {
    return { error: describeUnresolvedSessionId(registry, sessionId, sessionsPath) };
  }

  return {
    sessionId: session.sessionId,
    githubRepo: session.githubRepo,
    artifactRoot: session.artifactRoot,
  };
}

// ---------------------------------------------------------------------------
// Issue reader — injectable so tests can supply a fake (read-only) provider.
// ---------------------------------------------------------------------------

export interface IssueDiscussComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueDiscussIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: IssueDiscussComment[];
  /**
   * Total number of comments on the issue, when known. The fetched `comments`
   * array may be bounded to the most recent N, so callers use this (when set)
   * to report how many comments were omitted.
   */
  totalComments?: number;
}

export interface IssueDiscussReader {
  /**
   * Read-only fetch of issue data. Implementations must never mutate the issue.
   *
   * `commentLimit` bounds the fetch itself so heavily commented issues do not
   * overflow subprocess buffers; implementations should fetch at most that many
   * (most recent) comments.
   */
  readIssue(repo: string, issueNumber: number, commentLimit: number): IssueDiscussIssue;
}

interface RawGhIssue {
  number?: number;
  title?: string;
  body?: string;
  state?: string;
  labels?: Array<{ name?: string }>;
}

interface RawGhComments {
  data?: {
    repository?: {
      issue?: {
        comments?: {
          totalCount?: number;
          nodes?: Array<{ author?: { login?: string } | null; body?: string; createdAt?: string }>;
        };
      };
    };
  };
}

export const defaultIssueDiscussReader: IssueDiscussReader = {
  readIssue(repo, issueNumber, commentLimit) {
    // 1. Base fields, WITHOUT comments. Bounded in size (body is capped by
    //    GitHub), so this never risks overflowing the subprocess buffer.
    const out = execFileSync(
      "gh",
      [
        "issue", "view", String(issueNumber),
        "--repo", repo,
        "--json", "number,title,body,state,labels",
      ],
      { encoding: "utf8", maxBuffer: GH_MAX_BUFFER },
    );
    const raw = JSON.parse(out) as RawGhIssue;

    // 2. Comments, bounded at the source via GraphQL `last:N`, so we only ever
    //    buffer up to `commentLimit` (most recent) comments instead of the
    //    issue's entire comment history.
    let comments: IssueDiscussComment[] = [];
    let totalComments = 0;
    if (commentLimit > 0) {
      const slash = repo.indexOf("/");
      const owner = slash >= 0 ? repo.slice(0, slash) : repo;
      const name = slash >= 0 ? repo.slice(slash + 1) : "";
      const query =
        "query($owner:String!,$name:String!,$number:Int!,$limit:Int!){" +
        "repository(owner:$owner,name:$name){" +
        "issue(number:$number){comments(last:$limit){totalCount " +
        "nodes{author{login} body createdAt}}}}}";
      const commentsOut = execFileSync(
        "gh",
        [
          "api", "graphql",
          "-f", `query=${query}`,
          "-F", `owner=${owner}`,
          "-F", `name=${name}`,
          "-F", `number=${issueNumber}`,
          "-F", `limit=${commentLimit}`,
        ],
        { encoding: "utf8", maxBuffer: GH_MAX_BUFFER },
      );
      const parsed = JSON.parse(commentsOut) as RawGhComments;
      const conn = parsed.data?.repository?.issue?.comments;
      totalComments = typeof conn?.totalCount === "number" ? conn.totalCount : 0;
      comments = (conn?.nodes ?? []).map((c) => ({
        author: c?.author?.login ?? "",
        body: c?.body ?? "",
        createdAt: c?.createdAt ?? "",
      }));
    }

    return {
      number: typeof raw.number === "number" ? raw.number : issueNumber,
      title: raw.title ?? "",
      body: raw.body ?? "",
      state: raw.state ?? "",
      labels: (raw.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
      comments,
      totalComments,
    };
  },
};

// ---------------------------------------------------------------------------
// Fingerprint
//
// A stable SHA-256 over the bounded issue snapshot captured at preview time.
// Any field change (state, title, labels, body, or the bounded comment window)
// produces a different fingerprint, causing the post step to refuse stale data.
// Labels are sorted so insertion-order differences don't cause spurious mismatches.
// ---------------------------------------------------------------------------

interface FingerprintFields {
  sessionId: string;
  repo: string;
  issueNumber: number;
  issueState: string;
  title: string;
  labels: string[];
  body: string;
  comments: Array<{ author: string; body: string; createdAt: string }>;
}

export function computeFingerprint(fields: FingerprintFields): string {
  const canonical = JSON.stringify({
    sessionId: fields.sessionId,
    repo: fields.repo,
    issueNumber: fields.issueNumber,
    issueState: fields.issueState,
    title: fields.title,
    labels: [...fields.labels].sort(),
    body: fields.body,
    comments: fields.comments.map((c) => ({
      author: c.author,
      body: c.body,
      createdAt: c.createdAt,
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Bounding helpers
// ---------------------------------------------------------------------------

function truncate(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max) + "\n\n…(truncated)", truncated: true };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(
  repo: string,
  issue: IssueDiscussIssue,
  boundedBody: string,
  boundedComments: Array<{ author: string; createdAt: string; body: string }>,
): string {
  const lines: string[] = [
    `# Issue Refinement — ${repo}#${issue.number}`,
    "",
    `**Title**: ${truncate(issue.title, MAX_TITLE_CHARS).text}`,
    `**State**: ${issue.state || "(unknown)"}`,
    `**Labels**: ${issue.labels.length > 0 ? issue.labels.join(", ") : "(none)"}`,
    "",
    "## Issue Body",
    "",
    boundedBody.trim() === "" ? "(empty)" : boundedBody,
    "",
    "## Recent Comments",
    "",
  ];

  if (boundedComments.length === 0) {
    lines.push("(none)");
  } else {
    for (const c of boundedComments) {
      const who = c.author || "unknown";
      const when = c.createdAt ? ` (${c.createdAt})` : "";
      lines.push(`### ${who}${when}`, "", c.body, "");
    }
  }

  lines.push(
    "## Instructions",
    "",
    "Review the issue above and produce a refinement discussion draft.",
    "Focus on clarifying scope, surfacing ambiguities, proposing acceptance",
    "criteria, identifying risks and dependencies, and listing open questions.",
    "Make uncertain claims explicit instead of presenting them as verified facts.",
    "",
    "This is a PREVIEW ONLY. Do NOT post anything to GitHub, do NOT modify the",
    "issue, its labels, or its state, and do NOT create branches, PRs, or tasks.",
    "Output the discussion draft as structured markdown for human review.",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main (exported for testing with a fake, read-only reader)
// ---------------------------------------------------------------------------

export async function runIssueDiscussPreview(
  args: IssueDiscussArgs,
  reader: IssueDiscussReader = defaultIssueDiscussReader,
): Promise<void> {
  const session = await resolveSession(args.sessionId, args.sessionsPath);
  if ("error" in session) die(session.error);

  let issue: IssueDiscussIssue;
  try {
    issue = reader.readIssue(session.githubRepo, args.issueNumber, args.commentLimit);
  } catch (err) {
    die(`Failed to read issue ${session.githubRepo}#${args.issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Apply bounds. The reader may already have bounded the fetch to the most
  // recent N comments; the slice here is a defensive cap for readers that
  // return the full history (e.g. test fakes). `totalComments`, when the reader
  // reports it, lets us still account for comments omitted at the source.
  const body = truncate(issue.body, MAX_BODY_CHARS);
  const recentRaw = args.commentLimit > 0 ? issue.comments.slice(-args.commentLimit) : [];
  const totalComments = issue.totalComments ?? issue.comments.length;
  const omittedComments = Math.max(0, totalComments - recentRaw.length);
  const boundedComments = recentRaw.map((c) => {
    const b = truncate(c.body, MAX_COMMENT_CHARS);
    return { author: c.author, createdAt: c.createdAt, body: b.text, truncated: b.truncated };
  });

  const prompt = buildPrompt(session.githubRepo, issue, body.text, boundedComments);

  const artifactDir = join(session.artifactRoot, "issue-discuss", `issue-${args.issueNumber}`);
  try {
    mkdirSync(artifactDir, { recursive: true });
  } catch (err) {
    die(`Failed to create artifact dir: ${err instanceof Error ? err.message : String(err)}`);
  }

  const promptPath = join(artifactDir, "issue-discuss-prompt.md");
  const contextPath = join(artifactDir, "issue-discuss-context.json");

  const titleText = truncate(issue.title, MAX_TITLE_CHARS).text;

  const fingerprint = computeFingerprint({
    sessionId: args.sessionId,
    repo: session.githubRepo,
    issueNumber: args.issueNumber,
    issueState: issue.state,
    title: titleText,
    labels: issue.labels,
    body: issue.body,
    comments: recentRaw,
  });
  const draftPath = join(artifactDir, `issue-discuss-draft-${fingerprint}.md`);

  const context = {
    sessionId: args.sessionId,
    repo: session.githubRepo,
    issueNumber: args.issueNumber,
    issueState: issue.state,
    title: titleText,
    labels: issue.labels,
    body: body.text,
    bodyTruncated: body.truncated,
    commentLimit: args.commentLimit,
    commentsIncluded: boundedComments.length,
    commentsOmitted: omittedComments,
    comments: boundedComments,
    fingerprint,
    generatedAt: new Date().toISOString(),
    isolation: {
      model: "token-stripped-agent-env",
      writeEnvKeysStripped: [...WRITE_ENABLING_ENV_KEYS],
      readerMode: "read-only-by-construction",
      posted: false,
    },
  };

  writeFileSync(promptPath, prompt, "utf8");
  writeFileSync(contextPath, JSON.stringify(context, null, 2), "utf8");

  emit({
    ok: true,
    sessionId: args.sessionId,
    repo: session.githubRepo,
    issueNumber: args.issueNumber,
    issueState: issue.state,
    posted: false,
    fingerprint,
    artifactDir,
    artifacts: { prompt: promptPath, context: contextPath, draft: draftPath },
    commentsIncluded: boundedComments.length,
    commentsOmitted: omittedComments,
    bodyTruncated: body.truncated,
    isolation: {
      model: "token-stripped-agent-env",
      writeEnvKeysStripped: [...WRITE_ENABLING_ENV_KEYS],
      readerMode: "read-only-by-construction",
    },
  });
}

// ---------------------------------------------------------------------------
// Post command — argument parsing
// ---------------------------------------------------------------------------

export interface IssueDiscussPostArgs {
  sessionId: string;
  issueNumber: number;
  artifactPath: string;
  approveToken: string;
  sessionsPath: string;
}

export function parseIssueDiscussPostArgs(argv: string[]): IssueDiscussPostArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["session-id", "issue-number", "artifact", "approve", "sessions-path"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;

  if (!args["session-id"]) return { error: "--session-id is required" };
  if (args["issue-number"] === undefined) return { error: "--issue-number is required" };
  if (!args["artifact"]) return { error: "--artifact is required" };
  if (!args["approve"]) return { error: "--approve is required" };

  const issueNumber = Number(args["issue-number"]);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
  }

  return {
    sessionId: args["session-id"],
    issueNumber,
    artifactPath: args["artifact"],
    approveToken: args["approve"],
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
  };
}

// ---------------------------------------------------------------------------
// Post command — comment poster (injectable for tests)
// ---------------------------------------------------------------------------

export interface IssueDiscussPoster {
  postComment(repo: string, issueNumber: number, body: string): { error: string } | void;
}

export const defaultIssueDiscussPoster: IssueDiscussPoster = {
  postComment(repo, issueNumber, body) {
    const slash = repo.indexOf("/");
    const owner = slash >= 0 ? repo.slice(0, slash) : repo;
    const name = slash >= 0 ? repo.slice(slash + 1) : "";
    try {
      execFileSync(
        "gh",
        [
          "api",
          `repos/${owner}/${name}/issues/${issueNumber}/comments`,
          "--method", "POST",
          "--raw-field", `body=${body}`,
        ],
        { encoding: "utf8", maxBuffer: GH_MAX_BUFFER },
      );
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? "";
      const message = (stderr || (err instanceof Error ? err.message : String(err))).slice(0, 300);
      return { error: message };
    }
  },
};

// ---------------------------------------------------------------------------
// Artifact context shape (as written by runIssueDiscussPreview)
// ---------------------------------------------------------------------------

interface ArtifactContext {
  sessionId: string;
  repo: string;
  issueNumber: number;
  issueState: string;
  title: string;
  labels: string[];
  body: string;
  commentLimit: number;
  comments: Array<{ author: string; createdAt: string; body: string }>;
  fingerprint?: string;
}

// ---------------------------------------------------------------------------
// Post command — main (exported for testing with injectable reader + poster)
// ---------------------------------------------------------------------------

export async function runIssueDiscussPost(
  args: IssueDiscussPostArgs,
  reader: IssueDiscussReader = defaultIssueDiscussReader,
  poster: IssueDiscussPoster = defaultIssueDiscussPoster,
): Promise<void> {
  // 1. Resolve session
  const session = await resolveSession(args.sessionId, args.sessionsPath);
  if ("error" in session) die(session.error);

  // 2. Load artifact context
  const artifactPath = resolve(args.artifactPath);
  let contextRaw: string;
  try {
    contextRaw = readFileSync(artifactPath, "utf8");
  } catch (err) {
    die(`Cannot read artifact: ${artifactPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let context: ArtifactContext;
  try {
    context = JSON.parse(contextRaw) as ArtifactContext;
  } catch {
    die(`Artifact is not valid JSON: ${artifactPath}`);
  }

  // 3. Verify artifact matches requested session and issue
  if (context.sessionId !== args.sessionId) {
    die(`Artifact sessionId mismatch: artifact="${context.sessionId}", expected="${args.sessionId}"`);
  }
  if (context.issueNumber !== args.issueNumber) {
    die(`Artifact issueNumber mismatch: artifact=${context.issueNumber}, expected=${args.issueNumber}`);
  }
  if (context.repo !== session.githubRepo) {
    die(`Artifact repo mismatch: artifact="${context.repo}", session="${session.githubRepo}"`);
  }

  // 4. Verify --approve token matches the stored fingerprint
  const storedFingerprint = context.fingerprint;
  if (!storedFingerprint) {
    die("Artifact does not contain a fingerprint. Regenerate the preview to produce a fresh artifact.");
  }
  if (args.approveToken !== storedFingerprint) {
    die("--approve token does not match the artifact fingerprint. Use the fingerprint emitted by the preview command.");
  }

  // 5. Re-fetch current issue and verify fingerprint (detects changes since preview)
  let liveIssue: IssueDiscussIssue;
  try {
    liveIssue = reader.readIssue(session.githubRepo, args.issueNumber, context.commentLimit);
  } catch (err) {
    die(`Failed to read live issue state: ${err instanceof Error ? err.message : String(err)}`);
  }

  const liveRecentRaw = context.commentLimit > 0 ? liveIssue.comments.slice(-context.commentLimit) : [];

  const liveFingerprint = computeFingerprint({
    sessionId: args.sessionId,
    repo: session.githubRepo,
    issueNumber: args.issueNumber,
    issueState: liveIssue.state,
    title: truncate(liveIssue.title, MAX_TITLE_CHARS).text,
    labels: liveIssue.labels,
    body: liveIssue.body,
    comments: liveRecentRaw,
  });

  if (liveFingerprint !== storedFingerprint) {
    die(
      "Issue state has changed since preview. Re-run preview to capture a fresh snapshot, review the new artifact, and retry.",
    );
  }

  // 6. Load the reviewed discussion draft (namespaced to the fingerprint so a
  //    draft from an earlier preview cannot be used to satisfy a newer one).
  const artifactDir = dirname(artifactPath);
  const draftPath = join(artifactDir, `issue-discuss-draft-${storedFingerprint}.md`);
  let draftContent: string;
  try {
    draftContent = readFileSync(draftPath, "utf8").trim();
  } catch {
    die(
      `Draft file not found: ${draftPath}. Run the AI agent with the prompt file, save the reviewed output to that path, then retry.`,
    );
  }
  if (!draftContent) {
    die(`Draft file is empty: ${draftPath}`);
  }

  // 7. Post the reviewed comment — never re-runs any agent
  const postResult = poster.postComment(session.githubRepo, args.issueNumber, draftContent);
  if (postResult && "error" in postResult) {
    die(`Failed to post comment to ${session.githubRepo}#${args.issueNumber}: ${postResult.error}`);
  }

  emit({
    ok: true,
    sessionId: args.sessionId,
    repo: session.githubRepo,
    issueNumber: args.issueNumber,
    posted: true,
    fingerprint: storedFingerprint,
  });
}
