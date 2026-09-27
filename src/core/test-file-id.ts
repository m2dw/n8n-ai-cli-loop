/**
 * The one spelling of a test file id (issue #1152, moved to a leaf module by
 * issue #1153).
 *
 * Selection, execution, the persisted retained set and the stage evidence all
 * name a test file by this id, so it lives where every one of them can import it
 * without importing the others: `src/core/test-file-execution.ts` re-exports it
 * for the execution boundary, and `src/core/staged-verification-state.ts`
 * validates persisted ids with it without depending on the runner vocabulary.
 */

/** A C0 control character, DEL, or a backslash: never part of a file id. */
function hasForbiddenFileIdCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * Is this a stable repository-relative file id: forward slashes, no leading
 * slash, no `.`/`..`/empty segment, no control character? A path the adapter
 * would have to normalize is refused rather than rewritten, so one file always
 * has exactly one spelling across selection, execution and the retained set.
 */
export function isTestFileId(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  if (hasForbiddenFileIdCharacter(value)) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
