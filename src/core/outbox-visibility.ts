/**
 * Outbox visibility policy + provider-neutral enqueue helpers.
 *
 * This module is the single enforcement point for the AI-output visibility
 * policy described in docs/gitea-private-work-items.md ("Surfaces and
 * Visibility Tiers") and docs/provider-architecture.md ("Outbox Visibility
 * Policy"). Every provider-neutral comment that leaves the loop goes through
 * {@link enforceCommentVisibility} so the bounded/sanitized contract is applied
 * uniformly rather than re-derived at each call site.
 *
 * The three comment surfaces and their maximum fidelity:
 *
 *  - `work-item` (Tier 1) — a comment on the configured work-item provider
 *    (GitHub Issues today, private Gitea issues in split-provider mode). May
 *    carry bounded, sanitized internal workflow feedback (phase outcomes,
 *    decisions, truncated excerpts). Never a verbatim dump of raw prompts or
 *    full agent output.
 *  - `repo-host-pr` (Tier 2) — a comment on a public code-host pull request.
 *    Must be a public-safe review/status summary: no raw prompts, no local
 *    filesystem/artifact paths, no secrets, no private work-item links.
 *  - `public-issue` (Tier 2) — a comment on a public, human-owned work-item
 *    issue in split-provider mode. The most conservative surface: a human-safe
 *    summary, or nothing. It must never receive raw AI conversation details.
 *
 * A surface may always carry *less* than its tier; it must never carry *more*.
 */

import type {
  OutboxStore,
  WorkItemCommentPayload,
  WorkItemTransitionPayload,
  RepoHostPrCommentPayload,
  RepoHostPrSummaryPayload,
} from "./outbox.js";
import type { WorkItemProviderKind, RepoHostProviderKind } from "./session.js";
import type { WorkItemTransition } from "../providers/types.js";
import { boundedExcerpt, sanitizeBody } from "./text-sanitize.js";

// ---------------------------------------------------------------------------
// Surfaces and tiers
// ---------------------------------------------------------------------------

/** A comment surface the outbox can publish to, ordered by decreasing privacy. */
export type CommentSurface = "work-item" | "repo-host-pr" | "public-issue";

/** Whether a surface is a public (Tier 2) sink that must never carry internal detail. */
export function isPublicSurface(surface: CommentSurface): boolean {
  return surface === "repo-host-pr" || surface === "public-issue";
}

export interface VisibilityOptions {
  /**
   * Absolute paths (e.g. session.repoRoot, session.artifactRoot) to redact in
   * addition to the built-in path heuristics, so installs under non-standard
   * top-level directories are still covered.
   */
  configuredPaths?: string[];
  /**
   * Maximum comment length. Tier 1 records are bounded so the full text stays
   * in the local artifact; Tier 2 summaries are bounded too as defense in depth.
   */
  maxChars?: number;
}

/** Default size budget for a bounded comment body. */
export const DEFAULT_COMMENT_MAX_CHARS = 60_000;

/**
 * Apply the visibility policy for `surface` to `body` and return the safe text.
 *
 * Both tiers are bounded and run through {@link sanitizeBody}, which strips
 * absolute filesystem paths (the built-in heuristics plus any `configuredPaths`)
 * so no raw local artifact path is ever introduced into a published comment.
 * Secret redaction for agent-controlled free text (commands, tokens) is applied
 * by callers before reaching here (see `redactCommand` in
 * src/core/outbox-effects.ts); this function never re-introduces a path.
 *
 * This is intentionally provider-agnostic: it does not know whether the
 * work-item surface is GitHub or Gitea. The surface argument, not the provider,
 * decides the ceiling.
 */
export function enforceCommentVisibility(
  surface: CommentSurface,
  body: string,
  opts: VisibilityOptions = {},
): string {
  const maxChars = opts.maxChars ?? DEFAULT_COMMENT_MAX_CHARS;
  const bounded = boundedExcerpt(body, maxChars);
  // Path sanitization is required on every surface (Tier 1 and Tier 2): a raw
  // local artifact path must never leak, and the private work-item surface is
  // still not "trusted" (see docs/gitea-private-work-items.md). Public surfaces
  // get the same treatment; the additional Tier-2 stripping of prompts/internal
  // links is the caller's responsibility when it composes a summary.
  return sanitizeBody(bounded, opts.configuredPaths ?? []);
}

/**
 * Rebuild a public-safe (Tier 2) summary from a *legacy* PR-timeline comment
 * body queued by the pre-split-auth code.
 *
 * Before the visibility policy existed, the review-phase PR comment reused the
 * same body as the issue comment, so a pending legacy PR row (topic
 * `gh:comment`, idempotency key ending `:pr`) can still carry a raw `Reason:`
 * line (up to 300 chars of verification stdout/stderr) or a `<details>` review-
 * findings/output excerpt. Dispatching such a row verbatim after upgrade would
 * leak exactly the content the current code keeps off public PR comments, so the
 * dispatcher passes legacy PR bodies through here first.
 *
 * The bolded headline (the first line) is a fixed template string carrying only
 * issue/PR numbers, so it is always public-safe; everything after it (the
 * `Reason:`/`Error:` body and any excerpt `<details>` block, both of which may
 * contain newlines) is dropped. The public-safe "Run metadata" `<details>`
 * block, if present, is preserved so the rebuilt comment still records which
 * agent/model/run produced it. The result is run through
 * {@link enforceCommentVisibility} for the same defense-in-depth path stripping
 * a freshly composed Tier 2 comment receives.
 */
export function sanitizeLegacyPrCommentBody(body: string): string {
  const headline = body.split("\n", 1)[0];
  const metadataMatch = body.match(
    /<details>\s*\n<summary>Run metadata<\/summary>[\s\S]*?<\/details>/,
  );
  const rebuilt = metadataMatch ? `${headline}\n\n${metadataMatch[0]}` : headline;
  return enforceCommentVisibility("repo-host-pr", rebuilt);
}

// ---------------------------------------------------------------------------
// Provider-neutral enqueue helpers
//
// These are the provider-neutral counterparts of the GitHub-specific enqueues
// in outbox-effects.ts. They construct `workitem:*` / `repohost:*` payloads
// that route to the configured provider at dispatch time and apply the
// visibility policy for the surface before the body is persisted. Idempotency
// keys use the same makeOutboxKey scheme so dedup behavior is unchanged.
// ---------------------------------------------------------------------------

export interface EnqueueWorkItemCommentInput {
  provider: WorkItemProviderKind;
  owner: string;
  repo: string;
  issueNumber: number;
  idempotencyKey: string;
  body: string;
  /** Extra absolute paths to redact (repoRoot, artifactRoot). */
  configuredPaths?: string[];
  maxChars?: number;
  now?: string;
}

/**
 * Enqueue a Tier 1 work-item comment routed through the configured
 * WorkItemProvider. The body is bounded and sanitized before persistence.
 */
export async function enqueueWorkItemComment(
  store: OutboxStore,
  input: EnqueueWorkItemCommentInput,
): Promise<{ enqueued: boolean }> {
  const body = enforceCommentVisibility("work-item", input.body, {
    configuredPaths: input.configuredPaths,
    maxChars: input.maxChars,
  });
  const payload: WorkItemCommentPayload = {
    topic: "workitem:comment",
    provider: input.provider,
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issueNumber,
    body,
  };
  return store.enqueue({
    idempotencyKey: input.idempotencyKey,
    topic: "workitem:comment",
    payload,
    now: input.now,
  });
}

export interface EnqueueWorkItemTransitionInput {
  provider: WorkItemProviderKind;
  owner: string;
  repo: string;
  issueNumber: number;
  idempotencyKey: string;
  transition: WorkItemTransition;
  now?: string;
}

/**
 * Enqueue a coarse work-item state transition routed through the configured
 * WorkItemProvider. Transitions carry no agent-derived prose, so no
 * visibility sanitization is required.
 */
export async function enqueueWorkItemTransition(
  store: OutboxStore,
  input: EnqueueWorkItemTransitionInput,
): Promise<{ enqueued: boolean }> {
  const payload: WorkItemTransitionPayload = {
    topic: "workitem:transition",
    provider: input.provider,
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issueNumber,
    transition: input.transition,
  };
  return store.enqueue({
    idempotencyKey: input.idempotencyKey,
    topic: "workitem:transition",
    payload,
    now: input.now,
  });
}

export interface EnqueueRepoHostPrCommentInput {
  provider: RepoHostProviderKind;
  owner: string;
  repo: string;
  prNumber: number;
  idempotencyKey: string;
  body: string;
  /** Extra absolute paths to redact (repoRoot, artifactRoot). */
  configuredPaths?: string[];
  maxChars?: number;
  now?: string;
}

/**
 * Enqueue a Tier 2 public PR comment routed through the configured
 * RepoHostProvider. The body is treated as a public-safe summary: bounded and
 * sanitized so no local artifact path leaks onto the public code host.
 */
export async function enqueueRepoHostPrComment(
  store: OutboxStore,
  input: EnqueueRepoHostPrCommentInput,
): Promise<{ enqueued: boolean }> {
  const body = enforceCommentVisibility("repo-host-pr", input.body, {
    configuredPaths: input.configuredPaths,
    maxChars: input.maxChars,
  });
  const payload: RepoHostPrCommentPayload = {
    topic: "repohost:pr-comment",
    provider: input.provider,
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    body,
  };
  return store.enqueue({
    idempotencyKey: input.idempotencyKey,
    topic: "repohost:pr-comment",
    payload,
    now: input.now,
  });
}

export interface EnqueueRepoHostPrSummaryInput {
  provider: RepoHostProviderKind;
  owner: string;
  repo: string;
  prNumber: number;
  idempotencyKey: string;
  /** HTML comment marker for locating the sticky comment. */
  marker: string;
  body: string;
  /** Extra absolute paths to redact (repoRoot, artifactRoot). */
  configuredPaths?: string[];
  maxChars?: number;
  now?: string;
}

/**
 * Enqueue a Tier 2 sticky PR summary upsert routed through the configured
 * RepoHostProvider. The dispatcher will find the existing comment by `marker`
 * and edit it in place, or create a new one if none exists (issue #506).
 */
export async function enqueueRepoHostPrSummary(
  store: OutboxStore,
  input: EnqueueRepoHostPrSummaryInput,
): Promise<{ enqueued: boolean }> {
  const body = enforceCommentVisibility("repo-host-pr", input.body, {
    configuredPaths: input.configuredPaths,
    maxChars: input.maxChars,
  });
  const payload: RepoHostPrSummaryPayload = {
    topic: "repohost:pr-summary",
    provider: input.provider,
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    marker: input.marker,
    body,
  };
  return store.replacePendingPrSummary(
    {
      idempotencyKey: input.idempotencyKey,
      topic: "repohost:pr-summary",
      payload,
      now: input.now,
    },
    {
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      marker: input.marker,
    },
  );
}
