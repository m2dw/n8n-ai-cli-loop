/**
 * Turning a RESOLVED §3.3 evidence reference into the bounded text a no-tool
 * agent is shown (issues #838, #846).
 *
 * `evidence-checkout.ts` answers "may this path be read at all", and
 * `createReviewEvidenceResolver` answers "does this reference resolve". This
 * module answers the third question both the reconsideration and the arbitration
 * bundle ask: *what, exactly, does the agent get to read for it?*
 *
 * Shared rather than copied because the excerpt IS the evidence: the reviewer and
 * the arbiter decide a contested finding on these lines and nothing else, so two
 * copies of the rule would eventually show two agents two different files for the
 * same citation. The matching rules here are deliberately no looser than the
 * resolver's — a `doc_section` is located by the same normalization that resolved
 * it, so a reference that resolved always excerpts, and one that did not is never
 * excerpted by a laxer rule.
 *
 * Pure over an injected reader: nothing here opens a path the caller's own
 * tracked-file reader would refuse.
 */
import type { EvidenceRef } from "../core/review-dispute.js";
import type { EvidenceRefResolver } from "../core/review-dispute-validation.js";

/**
 * Why a cited reference has no content.
 *
 * Reported rather than dropped: an agent weighing a record must be able to see
 * that a reference the other party leaned on resolves against nothing, and a
 * silently omitted excerpt is indistinguishable from one that was never cited.
 */
export type EvidenceExcerptUnavailability =
  /** §3.3 resolution failed — the path/section/quote is not in this checkout. */
  | "unresolvable"
  /** Resolved, but the runner could not read content for it within its bounds. */
  | "unreadable"
  /** A kind this runner cannot excerpt read-only (today: `test`). */
  | "unsupported-kind";

export type EvidenceExcerptResult =
  | { excerpt: string }
  | { unavailable: EvidenceExcerptUnavailability };

/** A stable identity for one reference, so the same citation is excerpted once. */
export function evidenceRefKey(ref: EvidenceRef): string {
  switch (ref.kind) {
    case "file":
      return `file:${ref.path}:${ref.startLine}-${ref.endLine}`;
    case "doc_section":
      return `doc_section:${ref.path}:${ref.section}`;
    case "test":
      return `test:${ref.name}`;
    case "issue_quote":
      return `issue_quote:${ref.quote}`;
  }
}

/** `## §7.1 Diff-bearing runs` → level 2; a non-heading line → 0. */
const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

function normalizeHeading(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The body of one named document section: the matching heading and every line
 * until the next heading at the same or a higher level.
 */
export function docSectionExcerpt(content: string, section: string): string | undefined {
  const wanted = normalizeHeading(section);
  if (wanted === "") return undefined;
  const lines = content.split("\n");
  let start = -1;
  let level = 0;
  for (const [i, line] of lines.entries()) {
    const match = ATX_HEADING.exec(line);
    if (!match) continue;
    if (start === -1) {
      if (normalizeHeading(match[2]!).includes(wanted)) {
        start = i;
        level = match[1]!.length;
      }
      continue;
    }
    if (match[1]!.length <= level) return lines.slice(start, i).join("\n");
  }
  return start === -1 ? undefined : lines.slice(start).join("\n");
}

/** The cited line range, rendered with its line numbers so the citation is checkable. */
export function fileRangeExcerpt(content: string, startLine: number, endLine: number): string | undefined {
  const lines = content.split("\n");
  if (startLine < 1 || endLine < startLine || endLine > lines.length) return undefined;
  return lines
    .slice(startLine - 1, endLine)
    .map((line, i) => `${startLine + i}: ${line}`)
    .join("\n");
}

/**
 * Resolve one reference and read the content a bundle may show for it.
 *
 * The excerpt is returned WHOLE — the prompt module owns the length bound and
 * marks what it cut. Truncating silently here would hide from the agent that the
 * citation it is weighing was shortened.
 */
export function excerptEvidenceRef(
  ref: EvidenceRef,
  resolve: EvidenceRefResolver,
  readFile: (path: string) => string | undefined,
): EvidenceExcerptResult {
  if (!resolve(ref)) {
    // A `test` reference resolves for nobody yet (§3.3): the runner cannot tell a
    // real test name from an invented one without running the suite, so it is
    // reported as unsupported rather than as a failed lookup.
    return { unavailable: ref.kind === "test" ? "unsupported-kind" : "unresolvable" };
  }
  // Resolved against the Issue body already in the bundle; the quote IS the
  // excerpt, so nothing further is read.
  if (ref.kind === "issue_quote") return { excerpt: ref.quote };
  if (ref.kind === "test") return { unavailable: "unsupported-kind" };
  const content = readFile(ref.path);
  if (content === undefined) return { unavailable: "unreadable" };
  const excerpt =
    ref.kind === "file"
      ? fileRangeExcerpt(content, ref.startLine, ref.endLine)
      : docSectionExcerpt(content, ref.section);
  return excerpt === undefined ? { unavailable: "unreadable" } : { excerpt };
}
