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
 * Close any fenced code block that `text` leaves open, so embedding it in a
 * larger Markdown document cannot swallow whatever follows it.
 *
 * The companion of {@link fencedDetailsExcerpt} (issue #706), for the inverse
 * situation: that helper picks an OUTER fence no inner run can close, this one
 * repairs an INNER document whose own fence was never closed. Agent-authored
 * Markdown reaches a published comment through the research publication path
 * (issue #834) rendered *as Markdown*, not inside a code block, so an
 * unterminated ``` would fence off every section the runner appends after it —
 * including the run-metadata block.
 *
 * Only the closer is appended; nothing inside the text is rewritten. Both fence
 * characters are recognized, a closer must be at least as long as its opener
 * (CommonMark), and up to three leading spaces are tolerated on either.
 */
export function closeOpenMarkdownFences(text: string): string {
  let open: { char: string; length: number } | null = null;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const run = match[1]!;
    const char = run[0]!;
    if (open === null) {
      // An opener's info string may not contain a backtick (CommonMark).
      if (char === "`" && match[2]!.includes("`")) continue;
      open = { char, length: run.length };
    } else if (char === open.char && run.length >= open.length && match[2]!.trim() === "") {
      open = null;
    }
  }
  if (open === null) return text;
  return (text.endsWith("\n") ? text : text + "\n") + open.char.repeat(open.length);
}

/**
 * Break GitHub's issue-closing keyword forms so quoted or agent-authored text
 * cannot close a work item as a side effect of being published.
 *
 * GitHub links a closing keyword to the reference that DIRECTLY follows it, so
 * `fixes #12` becomes `fixes (see #12)`: the reference still autolinks and the
 * sentence still reads, but the pair is no longer a closing form. Applying the
 * transform twice is a no-op because the inserted text separates the keyword
 * from the reference.
 *
 * Covers the bare (`#12`), cross-repo (`owner/repo#12`), and full-URL reference
 * spellings, each of which GitHub honours.
 */
export function neutralizeClosingKeywords(text: string): string {
  return text.replace(
    /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s*)(#\d+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+|https?:\/\/[^\s<>()]+\/(?:issues|pull)\/\d+)/gi,
    (_match, keyword: string, _separator: string, reference: string) => `${keyword} (see ${reference})`,
  );
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

/**
 * Redact standalone third-party credential shapes that {@link redactTokens}
 * does not reach.
 *
 * `redactTokens` is a dispatch-error catch-all: it covers GitHub tokens, 40-hex
 * strings, and any value introduced by `token`/`Bearer`. That is enough for
 * CLI stderr, but not for text an agent *composed* — the research publication
 * path (issue #834) publishes agent-authored prose, and an agent that read a
 * provider key out of a config file can name it in a sentence with no
 * introducing keyword at all (`sk-proj-…`, `AKIA…`, `xoxb-…`).
 *
 * Two complementary shapes are covered:
 *
 *  - well-known vendor prefixes, which are unambiguous enough to redact on
 *    sight anywhere in the text;
 *  - a `key = value` / `key: value` assignment whose left-hand side names a
 *    secret, which redacts the value whatever shape it has.
 *
 * Kept separate from `redactTokens` rather than folded into it because the
 * assignment form is deliberately eager: over-redacting an agent's prose costs
 * a phrase, while over-redacting an evidence payload or an outbox `last_error`
 * would change what those already-pinned channels report.
 */
export function redactApiKeys(text: string): string {
  return (
    text
      // OpenAI/Anthropic-style (`sk-`, `sk-ant-…`, `sk-proj-…`) and restricted keys.
      .replace(/\b[sr]k-[A-Za-z0-9_-]{20,}/g, "[redacted]")
      // Stripe-style live/test keys.
      .replace(/\b[sprw]k_(?:live|test)_[A-Za-z0-9]{10,}/g, "[redacted]")
      // AWS access key identifiers.
      .replace(/\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|APKA|AROA)[A-Z0-9]{16}\b/g, "[redacted]")
      // Google API keys.
      .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, "[redacted]")
      // Slack tokens.
      .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted]")
      // GitLab personal access tokens.
      .replace(/\bglpat-[A-Za-z0-9_-]{15,}/g, "[redacted]")
      // npm automation tokens.
      .replace(/\bnpm_[A-Za-z0-9]{30,}/g, "[redacted]")
      // JSON Web Tokens.
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]")
      // An assignment whose left-hand side names a secret. The opening quote (if
      // any) is kept in the separator and the closing one is left in place, so
      // the redacted line stays balanced.
      .replace(
        /\b(api[-_]?key|apikey|access[-_]?key|secret(?:[-_]?key)?|client[-_]?secret|private[-_]?key|password|passwd)(\s*[:=]\s*["'`]?)[A-Za-z0-9._~+/-]{8,}=*/gi,
        "$1$2[redacted]",
      )
  );
}

/**
 * Escape raw HTML so agent-authored text embedded in a runner-composed Markdown
 * document cannot restructure or hide it.
 *
 * Markdown passes HTML through, so a single unclosed `<!--` in an agent-written
 * summary comments out every section the runner appends after it — headings,
 * references, run metadata — and a reader sees a report that looks complete
 * while the trusted structure is gone (issue #834). {@link closeOpenMarkdownFences}
 * repairs code fences only; this is the same guarantee for the HTML channel.
 *
 * Every `<` outside code becomes `&lt;`, which renders as a literal `<`, so
 * prose is unchanged in the reader's view and only the *markup* meaning is
 * removed. `>` is left alone: with no `<` to open a tag it is ordinary text,
 * and rewriting it would break block quotes.
 *
 * Code is skipped, because HTML is already inert there and escaping would show
 * a literal `&lt;` to the reader: fenced blocks are passed through whole (fence
 * tracking mirrors `closeOpenMarkdownFences`), as are inline code spans, which
 * CommonMark closes with a backtick run of exactly the opening length.
 */
export function escapeRawHtml(text: string): string {
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match) {
      const run = match[1]!;
      const char = run[0]!;
      if (fence === null) {
        // An opener's info string may not contain a backtick (CommonMark).
        if (!(char === "`" && match[2]!.includes("`"))) {
          fence = { char, length: run.length };
          out.push(line);
          continue;
        }
      } else {
        if (char === fence.char && run.length >= fence.length && match[2]!.trim() === "") fence = null;
        out.push(line);
        continue;
      }
    }
    out.push(fence === null ? escapeHtmlOutsideCodeSpans(line) : line);
  }
  return out.join("\n");
}

/** Escape `<` in one line, leaving the contents of inline code spans as written. */
function escapeHtmlOutsideCodeSpans(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "<") {
      out += "&lt;";
      i++;
      continue;
    }
    if (ch !== "`") {
      out += ch;
      i++;
      continue;
    }
    let openEnd = i;
    while (openEnd < line.length && line[openEnd] === "`") openEnd++;
    const runLength = openEnd - i;
    const close = findBacktickRun(line, openEnd, runLength);
    if (close === -1) {
      // An unmatched run is not a code span; it is literal text.
      out += line.slice(i, openEnd);
      i = openEnd;
      continue;
    }
    out += line.slice(i, close + runLength);
    i = close + runLength;
  }
  return out;
}

/** Index of the next backtick run of exactly `length` at or after `from`, or -1. */
function findBacktickRun(line: string, from: number, length: number): number {
  let i = from;
  while (i < line.length) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let end = i;
    while (end < line.length && line[end] === "`") end++;
    if (end - i === length) return i;
    i = end;
  }
  return -1;
}
