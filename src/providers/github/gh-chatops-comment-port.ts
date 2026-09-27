/**
 * GitHub binding of the ChatOps comment port (issue #1024).
 *
 * Satisfies `docs/chatops-comment-cursor-contract.md` §6 over the `gh` CLI:
 *
 * - **Ascending order by creation.** GitHub's issue-comment listing returns
 *   comments oldest-first, which is the one ordering a gap-free window can be
 *   proven over. A concurrent post can then only appear at the *end* of the
 *   list, so it is picked up by this scan or the next — never skipped. This is
 *   a pinned assumption read from GitHub's documentation (§6.1); a change in
 *   that behavior is a documented contract violation rather than a silent skip.
 * - **Explicit end-of-list signal.** Derived here from a short final page, which
 *   §6 names as a legitimate source — the core never guesses from page length,
 *   so the adapter must be the one to convert it.
 * - **Verbatim timestamps in one spelling.** `created_at` and `updated_at` are
 *   passed through untouched. Normalizing one and not the other would make an
 *   unedited comment look edited and get it refused as `ambiguous-edit`.
 *
 * The `since` filter is an optimization only (§6.1): GitHub filters on
 * `updated_at` and treats the bound as exclusive, and the core's order-key
 * comparison — not the filter — is what drops already-seen comments. A page
 * that ignores it entirely is equally correct, just larger.
 */

import type {
  ChatOpsCommentPageRequest,
  ChatOpsCommentPageResult,
  ChatOpsCommentPort,
  ChatOpsPostResult,
} from "../../core/chatops-comment-port.js";
import { chatOpsPageFromComments } from "../../core/chatops-comment-port.js";
import type { ChatOpsObservedComment } from "../../core/chatops-comment-cursor.js";
import type { GhRunner } from "./gh-runner.js";

interface RawComment {
  id?: unknown;
  body?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  user?: { login?: unknown } | null;
}

/** How much of a `gh` failure is echoed into an error string. */
const ERROR_DETAIL_CHARS = 200;

/**
 * Convert one raw API comment, or explain why it cannot be converted.
 *
 * A missing author or timestamp is reported rather than defaulted: the author
 * is the entire trust gate (#777 §5) and the timestamps are the ordering key
 * plus the edit test, so a comment missing any of them cannot be placed in the
 * window at all. Failing the page keeps the window unproven, which is what
 * `evaluateChatOpsScanWindow` needs in order to advance nothing.
 */
function toObservedComment(raw: RawComment, index: number): ChatOpsObservedComment | string {
  const id = raw.id;
  if (typeof id !== "number" && typeof id !== "string") {
    return `comment ${index} carries no usable id`;
  }
  const author = raw.user?.login;
  if (typeof author !== "string" || author === "") {
    return `comment ${String(id)} carries no author login`;
  }
  const createdAt = raw.created_at;
  const updatedAt = raw.updated_at;
  if (typeof createdAt !== "string" || typeof updatedAt !== "string") {
    return `comment ${String(id)} carries no created_at/updated_at pair`;
  }
  return {
    id: typeof id === "number" ? String(id) : id,
    author,
    body: typeof raw.body === "string" ? raw.body : "",
    createdAt,
    updatedAt,
  };
}

export interface GhChatOpsCommentPortOptions {
  runner: GhRunner;
  owner: string;
  repo: string;
  /** Working directory `gh` runs in; it selects the credential context. */
  cwd: string;
  /** Per-invocation timeout in ms, forwarded to the runner. */
  timeout?: number;
}

export class GhChatOpsCommentPort implements ChatOpsCommentPort {
  readonly #runner: GhRunner;
  readonly #owner: string;
  readonly #repo: string;
  readonly #cwd: string;
  readonly #timeout: number | undefined;

  constructor(options: GhChatOpsCommentPortOptions) {
    this.#runner = options.runner;
    this.#owner = options.owner;
    this.#repo = options.repo;
    this.#cwd = options.cwd;
    this.#timeout = options.timeout;
  }

  async listComments(request: ChatOpsCommentPageRequest): Promise<ChatOpsCommentPageResult> {
    const args = [
      "api",
      "--method",
      "GET",
      `repos/${this.#owner}/${this.#repo}/issues/${request.issueNumber}/comments`,
      "--field",
      `per_page=${request.perPage}`,
      "--field",
      `page=${request.page}`,
    ];
    if (request.since !== null) args.push("--field", `since=${request.since}`);

    const result = this.#runner.run(args, {
      cwd: this.#cwd,
      ...(this.#timeout === undefined ? {} : { timeout: this.#timeout }),
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `gh api list comments failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, ERROR_DETAIL_CHARS)}`,
      };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      return { ok: false, error: "gh api list comments returned non-JSON output" };
    }
    if (!Array.isArray(raw)) {
      return { ok: false, error: "gh api list comments returned a non-array payload" };
    }

    const comments: ChatOpsObservedComment[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const converted = toObservedComment(raw[i] as RawComment, i);
      if (typeof converted === "string") return { ok: false, error: converted };
      comments.push(converted);
    }
    return { ok: true, page: chatOpsPageFromComments(comments, request.perPage) };
  }

  async postComment(issueNumber: number, body: string): Promise<ChatOpsPostResult> {
    const result = this.#runner.run(
      [
        "api",
        `repos/${this.#owner}/${this.#repo}/issues/${issueNumber}/comments`,
        "--method",
        "POST",
        "--field",
        `body=${body}`,
      ],
      { cwd: this.#cwd, ...(this.#timeout === undefined ? {} : { timeout: this.#timeout }) },
    );
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `gh api comment failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, ERROR_DETAIL_CHARS)}`,
      };
    }
    return { ok: true };
  }
}
