/**
 * Diff classification utilities for the review phase.
 *
 * Parses the unified diff from `git diff <base>...HEAD` to identify which
 * files were added, modified, deleted, or renamed, and which of those are
 * guardrail/tooling files requiring extra reviewer scrutiny.
 *
 * Keeping this in a separate module lets the handler tests import only the
 * pure classification logic without constructing a full review context.
 */

export interface DiffClassification {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: { from: string; to: string }[];
  guardrail: {
    added: string[];
    modified: string[];
    deleted: string[];
    renamed: { from: string; to: string }[];
  };
}

// Patterns that identify guardrail/tooling files requiring extra reviewer
// scrutiny. Kept general-purpose so the classifier works across repositories.
const GUARDRAIL_PATTERNS: RegExp[] = [
  // CI/CD workflows
  /^\.github\/workflows\//,
  // Other GitHub config files
  /^\.github\//,
  // Test files by extension
  /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/,
  // Test files by conventional directory
  /^(test|tests|spec|__tests__)\//,
  /\/(test|tests|spec|__tests__)\//,
  // Agent instruction files
  /^AGENTS\.md$/i,
  /^CLAUDE\.md$/i,
  /^\.clinerules$/i,
  /^\.windsurfrules$/i,
  /agent[-_]instructions/i,
  // Package manifests and lockfiles
  /^package\.json$/,
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^Cargo\.toml$/,
  /^Cargo\.lock$/,
  /^go\.mod$/,
  /^go\.sum$/,
  /^requirements\.txt$/,
  /^pyproject\.toml$/,
  /^setup\.py$/,
  /^setup\.cfg$/,
  /^Pipfile$/,
  /^Pipfile\.lock$/,
  /^composer\.json$/,
  /^composer\.lock$/,
  /^Gemfile$/,
  /^Gemfile\.lock$/,
  // Release/validation gate scripts
  /^scripts\/(release|validate|publish|deploy|version)/i,
];

export function isGuardrailFile(path: string): boolean {
  return GUARDRAIL_PATTERNS.some((p) => p.test(path));
}

/**
 * Extract the file path from a `diff --git a/<path> b/<path>` header.
 * Used as a fallback when `---`/`+++` hunk lines are absent (binary, mode-only,
 * or empty-file diffs). The greedy match on the `b/` side handles paths with
 * spaces correctly for non-rename entries (where a-path === b-path).
 */
function getPathFromDiffHeader(section: string): string | null {
  const m = section.match(/^diff --git a\/.+ b\/(.+)$/m);
  return m?.[1]?.trim() ?? null;
}

/**
 * Parse a unified diff (from `git diff <base>...HEAD`) into a DiffClassification.
 *
 * Recognises per-file sections delimited by `diff --git` headers and identifies
 * each file's status via `new file mode`, `deleted file mode`, and `rename from/to`
 * header lines. Falls back to "modified" for all other sections.
 */
export function classifyDiffFromUnified(diff: string): DiffClassification {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const renamed: { from: string; to: string }[] = [];

  // Split on the `diff --git` boundary to get one block per changed file.
  const sections = diff.split(/^(?=diff --git )/m);

  for (const section of sections) {
    if (!section.trim()) continue;

    const isNew = /^new file mode/m.test(section);
    const isDeleted = /^deleted file mode/m.test(section);
    const isRename = /^rename from /m.test(section);

    if (isRename) {
      const fromMatch = section.match(/^rename from (.+)$/m);
      const toMatch = section.match(/^rename to (.+)$/m);
      if (fromMatch?.[1] && toMatch?.[1]) {
        renamed.push({ from: fromMatch[1].trim(), to: toMatch[1].trim() });
      }
    } else if (isNew) {
      const plusLine = section.match(/^\+\+\+ b\/(.+)$/m);
      const path = plusLine?.[1]?.trim() ?? getPathFromDiffHeader(section);
      if (path) added.push(path);
    } else if (isDeleted) {
      const minusLine = section.match(/^--- a\/(.+)$/m);
      const path = minusLine?.[1]?.trim() ?? getPathFromDiffHeader(section);
      if (path) deleted.push(path);
    } else {
      const plusLine = section.match(/^\+\+\+ b\/(.+)$/m);
      const path = plusLine?.[1]?.trim() ?? getPathFromDiffHeader(section);
      if (path) modified.push(path);
    }
  }

  return {
    added,
    modified,
    deleted,
    renamed,
    guardrail: {
      added: added.filter(isGuardrailFile),
      modified: modified.filter(isGuardrailFile),
      deleted: deleted.filter(isGuardrailFile),
      renamed: renamed.filter((r) => isGuardrailFile(r.from) || isGuardrailFile(r.to)),
    },
  };
}
