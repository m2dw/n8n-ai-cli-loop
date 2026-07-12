/**
 * pr-review-reader — read-only fetch of a PR's reviews and inline review comments.
 *
 * This is the I/O half of the GitHub-App-based human-review detection (Path B in
 * docs/human-review-return-flow.md). The pure selection logic lives in
 * src/core/github-app-review.ts; this module only fetches the data it consumes.
 *
 * The reader is injectable so the admin command can be tested without `gh`. The
 * default implementation calls only read-only `gh` subcommands and never mutates
 * the PR. Reviews and inline comments are fetched via the REST API so we get the
 * authoritative `user.type` ("Bot"/"User") identity flag, the review permalink
 * (`html_url`), and the `pull_request_review_id` that associates an inline comment
 * with its parent review.
 *
 * `gh` invocations go through an injected {@link GhRunner} rather than a bare
 * `execFileSync("gh", …)`. That is the same seam the rest of the repo-host
 * operations use, so a `github-app` session resolves its configured app auth and
 * reads/injects an installation token instead of silently relying on an unrelated
 * operator `gh` identity (see {@link prReviewReaderFromGhRunner} and
 * `resolveGhRunner`).
 */

import { defaultGhRunner, type GhRunner } from "../providers/github/gh-runner.js";
import type { PrReview, PrReviewComment } from "../core/github-app-review.js";

/** Result of resolving + reading a PR's reviews. */
export interface PrReviewData {
  prNumber: number;
  prUrl: string;
  reviews: PrReview[];
  comments: PrReviewComment[];
}

export interface PrReviewReader {
  /**
   * Read-only fetch of a PR's reviews and inline review comments.
   *
   * `selector` is a PR number or head branch (`gh pr view` accepts either). The
   * implementation MUST NOT mutate the PR.
   */
  readPrReviews(repo: string, selector: string): PrReviewData;
}

// We page explicitly (`?per_page=…&page=N`) rather than with `gh api --paginate
// --slurp`. `--paginate` slurps every page into one stdout payload before we can
// cap it, and the injected GhRunner uses `spawnSync` with Node's default ~1 MiB
// stdout buffer, so a heavily reviewed PR can blow the buffer (ENOBUFS) or spend
// unbounded time before the post-fetch slice runs. Fetching one page per `gh`
// call keeps each payload to PER_PAGE entries (~100), and the loop stops at the
// first short/empty page or after MAX_PAGES — so at 100/page we read at most 1000
// reviews / 1000 inline comments, far beyond any real PR, with bounded work and a
// bounded buffer per call.
const PER_PAGE = 100;
const MAX_PAGES = 10;

/**
 * Read up to {@link MAX_PAGES} pages of a paginated REST array endpoint, one `gh`
 * call per page. `pathWithQuery` must already carry `?per_page=…`; this appends
 * `&page=N`. Stops at the first page that is empty or shorter than PER_PAGE
 * (the last page), bounding both the number of subprocess calls and the bytes
 * buffered per call.
 */
function fetchPaginated<T>(runner: GhRunner, pathWithQuery: string): T[] {
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const out = runGh(runner, [
      "api",
      `${pathWithQuery}&page=${page}`,
      "-H",
      "Accept: application/vnd.github+json",
    ]);
    const parsed = JSON.parse(out) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) break;
    all.push(...(parsed as T[]));
    if (parsed.length < PER_PAGE) break;
  }
  return all;
}

interface RawGhReview {
  id?: number | string;
  user?: { login?: string; type?: string } | null;
  body?: string;
  state?: string;
  submitted_at?: string;
  html_url?: string;
}

interface RawGhReviewComment {
  pull_request_review_id?: number | string | null;
  user?: { login?: string; type?: string } | null;
  body?: string;
  path?: string;
  created_at?: string;
}

function splitRepo(repo: string): { owner: string; name: string } {
  const slash = repo.indexOf("/");
  return slash >= 0
    ? { owner: repo.slice(0, slash), name: repo.slice(slash + 1) }
    : { owner: repo, name: "" };
}

function runGh(runner: GhRunner, args: string[]): string {
  // The GhRunner needs a cwd; PR reads are repo-scoped via `--repo`/the REST path
  // so the working directory is immaterial. Use the process cwd.
  const res = runner.run(args, { cwd: process.cwd() });
  if (res.exitCode !== 0) {
    const detail = (res.stderr || res.stdout || "").trim();
    throw new Error(`gh ${args.join(" ")} failed (exit ${res.exitCode})${detail ? `: ${detail}` : ""}`);
  }
  return res.stdout;
}

/**
 * Build a {@link PrReviewReader} backed by an injected {@link GhRunner}. Pass the
 * runner resolved from the session's repo-host auth (`resolveGhRunner`) so a
 * `github-app` session reads with its installation token rather than an operator
 * `gh` identity.
 */
export function prReviewReaderFromGhRunner(runner: GhRunner): PrReviewReader {
  return {
    readPrReviews(repo, selector) {
      // 1. Resolve the PR number + url from the selector (number or branch).
      //    `gh pr view <number>` resolves closed/merged PRs too, so a stale
      //    selector (e.g. a stored task.context.prUrl) can point at a PR that is
      //    no longer open. Read `state` and refuse anything but OPEN — there is
      //    no open PR to fix, and an old CHANGES_REQUESTED review must not requeue
      //    the task or enqueue fix labels/comments.
      const viewOut = runGh(runner, [
        "pr",
        "view",
        selector,
        "--repo",
        repo,
        "--json",
        "number,url,state",
      ]);
      const view = JSON.parse(viewOut) as { number?: number; url?: string; state?: string };
      const prNumber = typeof view.number === "number" ? view.number : 0;
      const prUrl = view.url ?? "";
      if (prNumber <= 0) {
        throw new Error(`Could not resolve PR number for selector "${selector}" in ${repo}`);
      }
      // `gh pr view --json state` returns OPEN/CLOSED/MERGED.
      if (view.state !== "OPEN") {
        throw new Error(
          `PR for selector "${selector}" in ${repo} is not open (state: ${view.state ?? "unknown"}); ` +
            `refusing to read reviews from a closed or merged PR.`,
        );
      }

      const { owner, name } = splitRepo(repo);

      // 2. Reviews via REST so we get user.type + html_url. Paged one request at a
      //    time (see fetchPaginated) so PRs with more than one page of reviews still
      //    surface the latest reviewer state without slurping every page through the
      //    subprocess buffer at once.
      const rawReviews = fetchPaginated<RawGhReview>(
        runner,
        `repos/${owner}/${name}/pulls/${prNumber}/reviews?per_page=${PER_PAGE}`,
      );
      const reviews: PrReview[] = rawReviews
        .map((r) => ({
          id: r.id !== undefined && r.id !== null ? String(r.id) : "",
          author: r.user?.login ?? "",
          authorType: r.user?.type,
          state: r.state ?? "",
          body: r.body ?? "",
          submittedAt: r.submitted_at ?? "",
          url: r.html_url,
        }));

      // 3. Inline review comments via REST so we get pull_request_review_id.
      const rawComments = fetchPaginated<RawGhReviewComment>(
        runner,
        `repos/${owner}/${name}/pulls/${prNumber}/comments?per_page=${PER_PAGE}`,
      );
      const comments: PrReviewComment[] = rawComments
        .map((c) => ({
          reviewId:
            c.pull_request_review_id !== undefined && c.pull_request_review_id !== null
              ? String(c.pull_request_review_id)
              : undefined,
          author: c.user?.login ?? "",
          authorType: c.user?.type,
          body: c.body ?? "",
          path: c.path,
          createdAt: c.created_at,
        }));

      return { prNumber, prUrl, reviews, comments };
    },
  };
}

/**
 * Default reader: the operator's `gh` session (backward-compatible default used
 * by tests and `gh`-auth sessions). App-auth sessions build a reader from their
 * resolved runner via {@link prReviewReaderFromGhRunner}.
 */
export const defaultPrReviewReader: PrReviewReader = prReviewReaderFromGhRunner(defaultGhRunner);
