/**
 * Provider-neutral text bounding and filesystem-path redaction.
 *
 * These helpers have no knowledge of outbox topics, visibility tiers, or
 * publication policy — they are pure text transforms that both the outbox
 * effect-composition layer (outbox-effects.ts) and the visibility/publication
 * policy layer (outbox-visibility.ts) depend on. Keeping them here (rather
 * than in either layer) lets both import downward without either importing
 * the other, avoiding a circular dependency between them (issue #605).
 */

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Truncate `text` to at most `maxChars`, appending an ellipsis if cut. */
export function boundedExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n…(truncated)";
}

/**
 * Render a bounded excerpt inside a `<details>` block with a fenced code
 * block, choosing an outer fence longer than any backtick run already
 * present in the excerpt.
 *
 * Agent-produced review feedback can itself contain fenced code blocks
 * (e.g. a ```diff block). A fixed triple-backtick outer fence would be
 * closed early by such an embedded fence, spilling the remainder of the
 * excerpt out of the `<details>` block into the surrounding comment
 * (issue #706). Picking a fence one backtick longer than the longest run
 * in the (already-bounded) excerpt guarantees no line inside the excerpt
 * can close it.
 */
export function fencedDetailsExcerpt(summary: string, text: string, maxChars: number): string {
  const bounded = boundedExcerpt(text, maxChars);
  const longestBacktickRun = Math.max(0, ...(bounded.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `\n\n<details>\n<summary>${summary}</summary>\n\n${fence}\n${bounded}\n${fence}\n</details>`;
}

/**
 * Replace absolute Unix filesystem paths with a placeholder so that
 * server-side paths are never exposed in public GitHub comments.
 *
 * Configured paths (repoRoot, artifactRoot) are redacted explicitly so that
 * installations under non-standard top-level directories are covered.
 */
export function sanitizeBody(text: string, configuredPaths: string[] = []): string {
  let result = text
    .replace(/file:\/\/[^\s<>"'`\]})]*\/[^\s<>"'`\]})]*/g, "<path>")
    .replace(
      /(?<![:/\w])\/(private|tmp|home|Users|var|opt|run|srv|data|mnt|root|proc|sys|dev|etc|workspace|build|usr|bin|sbin|Applications|Library|System|Volumes)(?:\/[^\s<>"'`\]})]*)*/g,
      "<path>",
    )
    // Windows absolute paths: C:\... or C:/... Intermediate components may contain
    // spaces (e.g. C:\Users\Jane Doe\secret.txt) since each is anchored by a
    // trailing separator, but the final (leaf) component stops at the first
    // whitespace so trailing prose on the same line (e.g. "C:\a.md then retry")
    // is left untouched rather than swallowed into the redaction.
    .replace(
      /(?<![A-Za-z])[A-Za-z]:[/\\](?:[^\t\n\r<>"'`\]})/\\]+[/\\])*[^\t\n\r<>"'`\]})/\\\s]*/g,
      "<path>",
    );
  // Redact explicitly configured roots and any sub-paths under them.
  for (const p of configuredPaths) {
    if (!p) continue;
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (p.startsWith("/")) {
      result = result.replace(new RegExp(`(?<![:/\\w])${escaped}(?:/[^\\s<>"'\`\\]})]*)?`, "g"), "<path>");
    } else if (/^[A-Za-z]:[/\\]/.test(p)) {
      // Windows drive-letter path — separator may be / or \
      result = result.replace(new RegExp(`${escaped}(?:[/\\\\][^\\s<>"'\`\\]})]*)?`, "g"), "<path>");
    }
  }
  return result;
}

/**
 * Redact common raw-token shapes from text before it is persisted somewhere
 * longer-lived than a transient dispatch error (issue #606: outbox
 * `last_error`). Provider-specific dispatch paths already have their own
 * narrower redactors (`redactSecrets` in providers/github/github-app-auth.ts,
 * `redactGiteaSecrets` in providers/gitea/gitea-client.ts) that run against a
 * known set of live secrets; this one is a defense-in-depth catch-all applied
 * regardless of which provider produced the error, since `gh`/Gitea CLI
 * stderr is not otherwise guaranteed to be redacted before it reaches here.
 */
export function redactTokens(text: string): string {
  return text
    .replace(/\b(gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]")
    .replace(/\b[0-9a-f]{40}\b/gi, "[redacted]")
    .replace(/\b(token|Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "$1 [redacted]");
}
