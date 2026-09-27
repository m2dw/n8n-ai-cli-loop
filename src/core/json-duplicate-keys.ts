/**
 * Duplicate-object-key detection over already-valid JSON **text**.
 *
 * `JSON.parse` keeps the last of two identical keys silently, so a document
 * whose effect nobody can read off it parses cleanly. Every fail-closed
 * configuration surface in this chain refuses that rather than picking a
 * winner, and a refusal can only be made by looking at the original bytes —
 * after parsing, the losing value is already gone.
 *
 * `json-session-registry.ts` is the caller: it refuses a duplicate
 * `stagedVerification.testSuite` key, which would otherwise collapse two
 * operator-written bindings into one. (Issue #1155 removed the other caller
 * with the project verification file and the `resultAdapters` id it validated.)
 *
 * Keys are compared by their **decoded** value, not their source spelling:
 * `"test"` and `"test"` are the same key to `JSON.parse`, so they must be
 * the same key here too.
 *
 * The scan only has to handle well-formed JSON — every caller runs it after
 * `JSON.parse` succeeded.
 */

/** One duplicated key, with the path of the object that declared it twice. */
export interface DuplicateJsonKey {
  /** The decoded key, as `JSON.parse` would see it. */
  readonly key: string;
  /**
   * Dotted path of the **containing object**, root being `""`; array elements
   * are indexed (`sessions[0].stagedVerification.testSuite`).
   */
  readonly path: string;
}

type Frame =
  | { object: true; path: string; awaitingKey: boolean; lastKey: string; keys: Set<string> }
  | { object: false; path: string; index: number };

function childPath(parent: Frame | undefined): string {
  if (!parent) return "";
  if (parent.object) return parent.path === "" ? parent.lastKey : `${parent.path}.${parent.lastKey}`;
  return `${parent.path}[${parent.index}]`;
}

/**
 * Every duplicate key in `text`, in the order their second occurrence appears.
 *
 * A key repeated three times reports twice — the caller refuses on the first,
 * so the extra entries cost nothing and keep the scan free of special cases.
 */
export function findDuplicateJsonKeys(text: string): DuplicateJsonKey[] {
  const duplicates: DuplicateJsonKey[] = [];
  const stack: Frame[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{") {
      stack.push({
        object: true,
        path: childPath(stack[stack.length - 1]),
        awaitingKey: true,
        lastKey: "",
        keys: new Set(),
      });
      i += 1;
    } else if (ch === "[") {
      stack.push({ object: false, path: childPath(stack[stack.length - 1]), index: 0 });
      i += 1;
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      i += 1;
    } else if (ch === ":") {
      const top = stack[stack.length - 1];
      if (top?.object) top.awaitingKey = false;
      i += 1;
    } else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top?.object) top.awaitingKey = true;
      else if (top) top.index += 1;
      i += 1;
    } else if (ch === '"') {
      // Walk to the closing quote, then let `JSON.parse` decode the literal —
      // comparing raw escape sequences would let `R` hide a duplicate.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      const top = stack[stack.length - 1];
      if (top?.object && top.awaitingKey) {
        let key: string;
        try {
          key = JSON.parse(text.slice(i, j + 1)) as string;
        } catch {
          // Unreachable for the valid JSON this scanner is given; falling back
          // to the raw spelling keeps a malformed input from throwing here.
          key = text.slice(i + 1, j);
        }
        if (top.keys.has(key)) duplicates.push({ key, path: top.path });
        top.keys.add(key);
        top.lastKey = key;
      }
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return duplicates;
}
