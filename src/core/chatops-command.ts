/**
 * ChatOps command grammar and trust boundary (issue #777).
 *
 * This module is the *recognition* layer only: given one issue/work-item
 * comment, decide whether it is a structurally valid command from a trusted
 * author, and if so, what the command's verb and argv are. It never executes
 * anything, never talks to a provider, and never persists anything — see
 * `docs/chatops-command-grammar-contract.md` for the full contract, including
 * what is deliberately *not* here (durable cursor/ledger replay, dispatch,
 * operation-tier design — tracked by issues #780-#785, #697, #915-#919, #722).
 *
 * Every exported function is pure and total over its documented input shape:
 * no I/O, no clock, no randomness. That is what lets a later, stateful layer
 * treat recognition as a deterministic function of a comment's immutable
 * first-seen fields and safely memoize/replay it.
 */

/** One comment as read from a work-item provider, trimmed to the fields this module needs. */
export interface ChatOpsCommentInput {
  /** Provider login/username that authored the comment. Compared case-insensitively. */
  author: string;
  /** Raw comment body, exactly as stored by the provider (Markdown source). */
  body: string;
  /** Provider-reported creation timestamp (any consistently-comparable string, e.g. ISO 8601). */
  createdAt: string;
  /** Provider-reported last-update timestamp. Equal to createdAt iff the comment was never edited. */
  updatedAt: string;
}

/** Static, explicit trust configuration for one session's ChatOps surface (`SessionConfig.chatOps`). */
export interface ChatOpsTrustConfig {
  /**
   * Provider logins allowed to issue commands. Compared case-insensitively.
   * Never derived from repo role/collaborator state — see the contract doc §5.
   */
  authorAllowlist: readonly string[];
  /**
   * Provider logins the session's own automation has posted acknowledgement
   * markers as, across every credential rotation. Disjoint in purpose from
   * `authorAllowlist`: this list authenticates markers *this system* posted,
   * not commands a human is allowed to issue.
   */
  automationLogins: readonly string[];
}

/** A structurally recognized command: a verb plus a normalized argv-style token array. */
export interface ChatOpsCommand {
  /** Lower-kebab verb, e.g. `"grant"`. */
  verb: string;
  /**
   * Every token after the verb, normalized: quotes stripped, and any
   * `--flag=value` form expanded into two entries (`"--flag"`, `"value"`),
   * identically to the space-separated form `--flag value`. Order preserved.
   */
  argv: string[];
}

/** Why a comment was not recognized as an executable command, or that it was. */
export type ChatOpsRecognitionOutcome =
  | { kind: "unauthorized-author" }
  | { kind: "malformed" }
  | { kind: "ambiguous-edit" }
  | { kind: "unsupported-command"; verb: string }
  | { kind: "command"; command: ChatOpsCommand };

/**
 * A comment body longer than this is rejected outright (contract doc §10) —
 * every command this contract supports is a handful of tokens, so this costs
 * nothing for a real command while keeping recognition cost independent of
 * how large an attacker-controlled comment body can be.
 */
export const MAX_CHATOPS_COMMENT_BODY_CHARS = 4000;

const VERB_RE = /^[a-z][a-z0-9-]+/;
const FLAG_NAME_RE = /^--[a-z][a-z0-9-]+/;
/**
 * Characters that are never meaningful in a command token because commands are
 * never interpolated into a shell string — a token containing one is not
 * stripped or escaped, the whole comment is rejected as not a command. See
 * the contract doc §2.
 */
const SHELL_METACHARACTER_RE = /[$`|;&<>(){}]/;

// ---------------------------------------------------------------------------
// §1 Parsing exclusions — find the one candidate line, if any
// ---------------------------------------------------------------------------

/**
 * Leading-space count of a line, tabs expanded to the next multiple of 4
 * (CommonMark's indentation rule), capped at 4 since nothing here cares about
 * indentation beyond the indented-code-block threshold.
 */
function leadingIndent(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === " ") col += 1;
    else if (ch === "\t") col += 4 - (col % 4);
    else break;
    if (col >= 4) return 4;
  }
  return col;
}

function fenceOpen(line: string): { char: string; len: number } | null {
  if (leadingIndent(line) >= 4) return null;
  const trimmed = line.replace(/^[ \t]*/, "");
  const match = /^(`{3,}|~{3,})/.exec(trimmed);
  if (!match) return null;
  const run = match[1];
  return { char: run[0], len: run.length };
}

function fenceClose(line: string, char: string, len: number): boolean {
  if (leadingIndent(line) >= 4) return false;
  const trimmed = line.replace(/^[ \t]*/, "");
  const re = new RegExp(`^${char === "`" ? "`" : "~"}{${len},}[ \\t]*$`);
  return re.test(trimmed);
}

function isBlockquoteStart(line: string): boolean {
  if (leadingIndent(line) >= 4) return false;
  return /^[ \t]{0,3}>/.test(line);
}

function isInlineCodeSpan(line: string): boolean {
  const trimmed = line.trim();
  const match = /^(`+)([\s\S]*)$/.exec(trimmed);
  if (!match) return false;
  const fence = match[1];
  const rest = match[2];
  if (!rest.endsWith(fence)) return false;
  const inner = rest.slice(0, rest.length - fence.length);
  // A bare backtick immediately inside the span would prematurely close it;
  // CommonMark handles that with longer runs, which this deliberately
  // under-approximates — see the contract doc's documented limitations.
  return inner.length > 0 && !inner.includes(fence);
}

/**
 * Strip fenced code, indented code, block-quoted (incl. lazy-continuation)
 * lines, and inline-code-span-only lines, then return the first surviving
 * **non-blank** line. Blank lines carry no content and are transparent —
 * they neither count as "the candidate" nor as a reason to treat a later
 * line as anything other than the *first* surviving one; only a non-blank
 * line can be the candidate, and once found, no later line is ever
 * considered, matching or not (see the contract doc §3). Returns `null`
 * when every line is excluded or blank, or the body is empty. Also returns
 * `null`, without scanning at all, for a body longer than
 * {@link MAX_CHATOPS_COMMENT_BODY_CHARS} (contract doc §10).
 */
export function extractCandidateCommandLine(body: string): string | null {
  if (body.length > MAX_CHATOPS_COMMENT_BODY_CHARS) return null;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let fence: { char: string; len: number } | null = null;
  let inLazyQuote = false;

  for (const line of lines) {
    if (fence) {
      const closed = fenceClose(line, fence.char, fence.len);
      if (closed) fence = null;
      continue; // fence body and its closer are both excluded
    }

    const opened = fenceOpen(line);
    if (opened) {
      fence = opened;
      inLazyQuote = false;
      continue;
    }

    if (leadingIndent(line) >= 4) {
      // Indented code block line. Does not, by itself, end a lazy block-quote
      // continuation per CommonMark; conservatively treat it as breaking one,
      // since no known caller relies on the nested case.
      inLazyQuote = false;
      continue;
    }

    if (isBlockquoteStart(line)) {
      inLazyQuote = true;
      continue;
    }
    if (inLazyQuote && line.trim() !== "") {
      continue; // lazy continuation of the open block-quote paragraph
    }
    inLazyQuote = false;

    if (line.trim() === "") continue; // blank lines carry no content; never a candidate
    if (isInlineCodeSpan(line)) continue;

    return line.replace(/\r$/, "");
  }

  return null;
}

// ---------------------------------------------------------------------------
// §2 Grammar — parse one candidate line into a command
// ---------------------------------------------------------------------------

interface Scan {
  text: string;
  pos: number;
}

function skipWhitespace(s: Scan): void {
  while (s.pos < s.text.length && /\s/.test(s.text[s.pos])) s.pos += 1;
}

/** Reads a quoted value starting at `s.pos === '"'`. Returns null if unterminated. */
function readQuoted(s: Scan): string | null {
  const start = s.pos + 1;
  const end = s.text.indexOf('"', start);
  if (end === -1) return null;
  const value = s.text.slice(start, end);
  s.pos = end + 1;
  return value;
}

/** Reads a run of non-whitespace, non-quote characters. */
function readBareRun(s: Scan): string {
  const start = s.pos;
  while (s.pos < s.text.length && !/\s/.test(s.text[s.pos]) && s.text[s.pos] !== '"') {
    s.pos += 1;
  }
  return s.text.slice(start, s.pos);
}

function atBoundary(s: Scan): boolean {
  return s.pos >= s.text.length || /\s/.test(s.text[s.pos]);
}

/**
 * Parse one candidate line as a `/verb argv...` command per the contract
 * doc's grammar. Returns `null` (malformed) on any structural violation —
 * never a partial match. `--flag=value` is expanded into two argv entries;
 * `--flag="quoted value"` and `--flag "quoted value"` are equivalent.
 */
export function parseChatOpsCommandLine(rawLine: string): ChatOpsCommand | null {
  const line = rawLine.trim();
  if (!line.startsWith("/")) return null;
  if (SHELL_METACHARACTER_RE.test(line)) return null;

  const afterSlash = line.slice(1);
  const verbMatch = VERB_RE.exec(afterSlash);
  if (!verbMatch) return null;
  const verb = verbMatch[0];

  const s: Scan = { text: afterSlash, pos: verb.length };
  if (s.pos < s.text.length && !/\s/.test(s.text[s.pos])) return null; // junk glued to verb

  const argv: string[] = [];
  for (;;) {
    skipWhitespace(s);
    if (s.pos >= s.text.length) break;

    if (s.text[s.pos] === '"') {
      const value = readQuoted(s);
      if (value === null) return null; // unterminated quote
      if (!atBoundary(s)) return null; // trailing content glued to quote
      // A quoted positional that normalizes to `--flag` is indistinguishable
      // from a real flag once flattened into argv — reject here for the same
      // reason the `--flag="value"` case below rejects `--`-prefixed values.
      if (value.startsWith("--")) return null;
      argv.push(value);
      continue;
    }

    const flagMatch = FLAG_NAME_RE.exec(s.text.slice(s.pos));
    if (flagMatch) {
      const name = flagMatch[0].slice(2);
      s.pos += flagMatch[0].length;
      if (atBoundary(s)) {
        argv.push(`--${name}`);
        continue;
      }
      if (s.text[s.pos] !== "=") return null; // junk glued to flag name
      s.pos += 1; // consume '='
      let value: string;
      if (s.pos < s.text.length && s.text[s.pos] === '"') {
        const quoted = readQuoted(s);
        if (quoted === null) return null;
        value = quoted;
      } else {
        value = readBareRun(s);
        if (value === "") return null; // `--flag=` with nothing after
      }
      if (!atBoundary(s)) return null;
      // A value starting with `--` is indistinguishable from a flag once
      // flattened into argv — tokenizeArgs refuses a value flag whose next
      // token starts with `--`, so reject here rather than emit argv the
      // downstream parser cannot consume.
      if (value.startsWith("--")) return null;
      argv.push(`--${name}`, value);
      continue;
    }

    const bare = readBareRun(s);
    if (bare === "") return null; // stray quote glued to a bare run
    argv.push(bare);
  }

  return { verb, argv };
}

// ---------------------------------------------------------------------------
// §3 Trust gate + edited-comment eligibility
// ---------------------------------------------------------------------------

function isAllowlisted(login: string, allowlist: readonly string[]): boolean {
  const needle = login.toLowerCase();
  return allowlist.some((entry) => entry.toLowerCase() === needle);
}

/**
 * Evaluate one comment against the full recognition contract: author
 * allowlist gate, first-eligible-line parse, edited-comment eligibility, and
 * verb support. Order matches the contract doc §5 (author gate before any
 * parsing) and §6 (edit check only applies once a comment already parses as
 * a command — an edited comment that was never going to parse is just an
 * ordinary comment, not a rejected command).
 */
export function recognizeChatOpsComment(
  comment: ChatOpsCommentInput,
  trust: ChatOpsTrustConfig,
  supportedVerbs: ReadonlySet<string>,
): ChatOpsRecognitionOutcome {
  if (!isAllowlisted(comment.author, trust.authorAllowlist)) {
    return { kind: "unauthorized-author" };
  }

  const candidate = extractCandidateCommandLine(comment.body);
  if (candidate === null) return { kind: "malformed" };

  const command = parseChatOpsCommandLine(candidate);
  if (command === null) return { kind: "malformed" };

  if (comment.updatedAt !== comment.createdAt) {
    return { kind: "ambiguous-edit" };
  }

  if (!supportedVerbs.has(command.verb)) {
    return { kind: "unsupported-command", verb: command.verb };
  }

  return { kind: "command", command };
}

// ---------------------------------------------------------------------------
// §4 Acknowledgement markers — authenticating, not posting
// ---------------------------------------------------------------------------

export type ChatOpsMarkerOutcome = "executed" | "rejected" | "error";

export type ChatOpsMarker =
  | { kind: "claimed"; commentId: string }
  | { kind: "ack"; commentId: string; outcome: ChatOpsMarkerOutcome };

// A comment identifier is the provider's canonical decimal digit string (no
// leading zeros) — see the contract doc §7 for the marker format and §8 for
// why the identifier shape is future-provider-neutral.
const CLAIMED_RE = /^<!-- chatops-claimed:(0|[1-9][0-9]*) -->$/;
const ACK_RE = /^<!-- chatops-ack:(0|[1-9][0-9]*):(executed|rejected|error) -->$/;

/**
 * Parse a comment body as an acknowledgement marker, requiring an *exact*
 * match of the canonical form (no surrounding text). A body that merely
 * contains marker-shaped text is not a marker — see
 * {@link isAuthenticatedChatOpsMarker}.
 */
export function parseChatOpsMarkerBody(body: string): ChatOpsMarker | null {
  const trimmed = body.trim();
  const claimed = CLAIMED_RE.exec(trimmed);
  if (claimed) return { kind: "claimed", commentId: claimed[1] };
  const ack = ACK_RE.exec(trimmed);
  if (ack) return { kind: "ack", commentId: ack[1], outcome: ack[2] as ChatOpsMarkerOutcome };
  return null;
}

/**
 * Whether a comment is an authenticated acknowledgement marker: its body is
 * an exact canonical marker string (see {@link parseChatOpsMarkerBody}) *and*
 * its author is a member of the session's `automationLogins` (current or any
 * prior credential rotation — the list is never pruned, see the contract doc
 * §5). A comment that merely looks like a marker but fails either check is an
 * ordinary comment: it cannot suppress dispatch of a real command, and if it
 * happens to also be well-formed and author-allowlisted it is evaluated
 * normally by {@link recognizeChatOpsComment}.
 */
export function isAuthenticatedChatOpsMarker(
  comment: Pick<ChatOpsCommentInput, "author" | "body">,
  automationLogins: readonly string[],
): boolean {
  if (parseChatOpsMarkerBody(comment.body) === null) return false;
  return isAllowlisted(comment.author, automationLogins);
}

// ---------------------------------------------------------------------------
// Public response policy — contract doc §10
// ---------------------------------------------------------------------------

/**
 * Whether a comment's candidate line (§3) at least looked like an attempted
 * command — started with `/` — regardless of whether it went on to parse.
 * Used only to decide whether a `malformed` outcome is worth a reply (see
 * {@link isPubliclyRespondable}); it is not part of grammar matching itself.
 */
export function looksLikeCommandAttempt(body: string): boolean {
  const candidate = extractCandidateCommandLine(body);
  return candidate !== null && candidate.trim().startsWith("/");
}

/**
 * Whether a recognition outcome (§4) ever warrants a public reply at all —
 * a policy decision (contract doc §10), not a delivery mechanism; *how* and
 * *when* a reply is actually posted is out of scope here (§8).
 *
 * `unauthorized-author` is always silent (§5 — no oracle for discovering the
 * grammar). A `malformed` outcome is silent too unless the candidate line at
 * least looked like an attempted command before failing the grammar —
 * reacting to every comment that simply isn't a command would be noise, not
 * a response. Every other outcome may be responded to.
 */
export function isPubliclyRespondable(
  outcome: ChatOpsRecognitionOutcome,
  commentBody: string,
): boolean {
  switch (outcome.kind) {
    case "unauthorized-author":
      return false;
    case "malformed":
      return looksLikeCommandAttempt(commentBody);
    case "ambiguous-edit":
    case "unsupported-command":
    case "command":
      return true;
  }
}
