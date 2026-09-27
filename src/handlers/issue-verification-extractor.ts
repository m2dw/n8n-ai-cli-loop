/**
 * Extracts expected verification commands from an issue body.
 *
 * Scans for Markdown section headers whose titles match "Verification",
 * "Test Plan", "Acceptance Criteria", or "Verify". Within those sections,
 * extracts shell commands from fenced code blocks and inline backtick spans.
 *
 * Non-required caveat: a command mentioned in inline backticks is excluded
 * from the required list when the SAME clause also contains the phrase "not
 * required" or "out of scope" (case-insensitive), e.g.:
 *
 *   `npm run validate:release` may remain blocked by unresolved production
 *   data and is not required by this Issue.
 *
 * A line is split into clauses on `;` or `.` boundaries before the marker is
 * tested, so the marker only excludes the backtick spans in its own clause —
 * required commands sharing a line with a caveat (e.g. "Run `npm test`;
 * `npm run e2e` is not required") are not swept up by the caveat next to
 * them. The split never lands inside an inline backtick span, so a required
 * command that itself contains a `;` or `.` (e.g. `` `npm run lint; npm
 * test` ``) is kept intact as a single clause rather than being torn apart
 * into unmatched fragments.
 *
 * This is a narrow, deterministic textual marker — not natural-language
 * interpretation — so issue authors can mention a command for context while
 * explicitly excluding it from mandatory verification (issue #993).
 *
 * Fenced-block section boundary: a Markdown heading that appears inside ANY
 * fenced code block (```...```) — including one nested inside an unrelated
 * section, such as a quoted example under "## Regression fixture" — is never
 * treated as opening, closing, or replacing a task-level Verification/Test
 * Plan/Acceptance Criteria section. Fence state is tracked globally across
 * the whole body for this purpose. This keeps an Issue free to quote a
 * sample Verification section (e.g. to document the extractor's own
 * behavior) without that sample being parsed as the Issue's real contract.
 * Commands inside a fenced block that genuinely lives INSIDE a real
 * Verification section are still extracted as before.
 *
 * Fence delimiters are length-tracked (CommonMark-style): opening a fence
 * with four or more backticks — the standard way to quote a sample that
 * itself contains a triple-backtick fence — records that opening length, and
 * only a line with a backtick run of at least that length closes it. A
 * shorter backtick run nested inside (e.g. an inner ```md sample) is treated
 * as literal fence content, not a fence boundary, so headings and commands
 * inside that inner sample are not mistaken for real verification content.
 * A closing delimiter must also have nothing but whitespace after its
 * backtick run (CommonMark rule) — a nested line like "```md" inside an
 * already-open fence has a long-enough backtick run but is followed by an
 * info string, so it is literal content, not a close.
 */

const VERIFICATION_SECTION_RE = /^(#{1,6})\s+(.+)$/;

const VERIFICATION_KEYWORDS: RegExp[] = [
  /\bverification\b/i,
  /\btest\s+plan\b/i,
  /\bacceptance\s+criteri/i,
  /\bverify\b/i,
];

function isVerificationSection(title: string): boolean {
  return VERIFICATION_KEYWORDS.some((re) => re.test(title));
}

const SHELL_FENCE_IDS = new Set(["", "sh", "bash", "shell", "zsh", "console", "terminal"]);
// Transcript fences mix command lines (with a prompt) and output lines; only
// lines prefixed by a shell prompt are commands — everything else is output.
const TRANSCRIPT_FENCE_IDS = new Set(["console", "terminal"]);

function isShellFence(langId: string): boolean {
  return SHELL_FENCE_IDS.has(langId.toLowerCase().trim());
}

// Matches an unambiguous shell prompt ($, %) with optional trailing whitespace.
const PROMPT_RE = /^[$%]\s*/;
// '>' is also used by npm/yarn to echo script names (e.g. `> package@ test`);
// treat it as a prompt only when the remainder looks like a real shell command.
const GT_PROMPT_RE = /^>\s*/;

function extractFromFencedBlocks(text: string): string[] {
  const commands: string[] = [];
  const fenceRe = /```([^\n]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const langId = m[1].toLowerCase().trim();
    if (!isShellFence(langId)) continue;
    const isTranscript = TRANSCRIPT_FENCE_IDS.has(langId);
    // npm echoes its script invocation as two consecutive `>` lines:
    //   > package-name@ script-name [/path]
    //   > the-actual-command
    // Track when the previous `>` line was an npm package-echo line so we
    // can suppress extracting the following command line as a user command.
    let prevGtWasNpmPackageLine = false;
    // Accumulates stateful setup lines (cd, export, etc.) that precede a real
    // command. Reset each time a non-setup command is consumed so that
    // `cd frontend\nnpm test` is recorded as `cd frontend && npm test` rather
    // than a bare `npm test` that would falsely match a root-level run.
    let pendingSetup: string[] = [];
    for (const line of m[2].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
        prevGtWasNpmPackageLine = false;
        continue;
      }
      if (isTranscript) {
        // For transcript fences, only accept lines that start with a prompt;
        // non-prompt lines are output and must be ignored.
        let cmd: string | null = null;
        const promptMatch = PROMPT_RE.exec(trimmed);
        if (promptMatch) {
          cmd = trimmed.slice(promptMatch[0].length).trim();
          prevGtWasNpmPackageLine = false;
        } else {
          // '>' is ambiguous: npm/yarn echoes script lines as `> pkg@ script`
          // or `> jest`. Only treat it as a prompt when the rest of the line
          // is recognisably a shell command, filtering out npm output noise.
          const gtMatch = GT_PROMPT_RE.exec(trimmed);
          if (gtMatch) {
            const candidate = trimmed.slice(gtMatch[0].length).trim();
            // Detect npm package-echo lines like `> package@ scriptname` or `> package@1.2.3 scriptname`
            const isNpmPackageLine = /^\S+@\S*\s/.test(candidate);
            if (!prevGtWasNpmPackageLine && looksLikeShellCommand(candidate)) {
              cmd = candidate;
            }
            prevGtWasNpmPackageLine = isNpmPackageLine;
          } else {
            prevGtWasNpmPackageLine = false;
          }
        }
        if (cmd) {
          if (!isCompoundRunnableCommand(cmd) && (isEnvAssignmentOnly(cmd) || SETUP_LINE_RE.test(cmd))) {
            pendingSetup.push(cmd);
          } else {
            const full = pendingSetup.length > 0 ? [...pendingSetup, cmd].join(" && ") : cmd;
            commands.push(full);
            pendingSetup = [];
          }
        }
      } else {
        // For non-transcript shell fences (bash, sh, etc.), strip conventional
        // shell prompts ($ or %) — authors often include them for clarity but
        // they are not part of the runnable command.
        const promptMatch = PROMPT_RE.exec(trimmed);
        const bare = promptMatch ? trimmed.slice(promptMatch[0].length).trim() : trimmed;
        if (!isCompoundRunnableCommand(bare) && (isEnvAssignmentOnly(bare) || SETUP_LINE_RE.test(bare))) {
          // Setup/context line — defer it so it can be prepended to the next
          // real command. This preserves required execution context such as
          // `cd frontend` before `npm test`, preventing a root-level `npm test`
          // from satisfying a directory-scoped requirement.
          // Exception: compound commands like `cd frontend && npm test` are
          // emitted as-is rather than deferred, because they are already
          // self-contained runnable verification commands.
          pendingSetup.push(bare);
        } else if (isCompoundRunnableCommand(bare) || langId !== "" || looksLikeShellCommand(bare)) {
          const cmd =
            pendingSetup.length > 0 ? [...pendingSetup, bare].join(" && ") : bare;
          commands.push(cmd);
          pendingSetup = [];
        } else {
          pendingSetup = [];
        }
      }
    }
  }
  return commands;
}

const SHELL_COMMAND_PREFIXES = [
  "npm", "yarn", "pnpm", "make", "./", "npx", "node",
  "python", "python3", "pytest", "jest", "cargo", "go",
  "bash", "sh", "ruby", "bundle",
  // Additional common verification tools
  "uv", "composer", "git", "docker", "docker-compose",
  "deno", "bun", "php", "mvn", "gradle", "rspec", "rake",
  "vendor/",
];

// Matches one or more leading shell env-var assignments like `CI=1 KEY=val `.
// After stripping these, the remainder is the actual command.
const ENV_PREFIX_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/;

// Matches a single whitespace-free token that is a shell env-var assignment.
const ENV_ASSIGNMENT_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Returns true when `s` is ONLY env-var assignments (no trailing command),
 * e.g. `CI=1` or `A=1 B=2`. Unlike ENV_PREFIX_RE, the final assignment need
 * not be followed by whitespace.
 *
 * This is a linear-time token scan rather than a single regex: the former
 * `/^(?:NAME=[^\s]*\s*)+$/` let each repetition end inside a whitespace-free
 * run, so a line like `A=A=A=…A=A x` backtracked exponentially (issue #1190).
 * Splitting on whitespace is equivalent because any whitespace-free run that
 * starts with `NAME=` is itself one assignment whose value is the rest of the
 * run; the line matches iff it has no leading whitespace and every run does.
 */
function isEnvAssignmentOnly(s: string): boolean {
  if (s === "" || /^\s/.test(s)) return false;
  const tokens = s.split(/\s+/).filter((t) => t !== "");
  return tokens.length > 0 && tokens.every((t) => ENV_ASSIGNMENT_TOKEN_RE.test(t));
}

// Shell setup/stateful lines that do not represent standalone verification checks:
// directory changes, variable exports (export VAR=val), file sourcing, and shell
// option flags (set -e, set -x). These lines configure the environment for the
// real command that follows and should not be recorded as required verifications.
// Note: bare env-var assignments (VAR=val) are already filtered by isEnvAssignmentOnly.
const SETUP_LINE_RE =
  /^(?:cd(?:\s|$)|export\s+[A-Za-z_][A-Za-z0-9_]*=|source\s|\.(?:\s|$)|set\s+-[a-z]|unset\s+|local\s+|readonly\s+)/;

/**
 * Returns true when `s` is a compound shell command (contains `&&` or `||`)
 * whose right-hand side contains at least one recognisable shell command.
 * Used to distinguish `cd frontend && npm test` (compound, runnable) from a
 * plain `cd frontend` (pure setup that must be deferred until the next line).
 */
function isCompoundRunnableCommand(s: string): boolean {
  const parts = s.split(/&&|\|\|/);
  return parts.length > 1 && parts.slice(1).some((p) => looksLikeShellCommand(p.trim()));
}

function looksLikeShellCommand(s: string): boolean {
  // Strip leading env-var assignments (e.g. `CI=1 npm test` → `npm test`)
  // before testing prefixes so env-prefixed forms are not silently dropped.
  const stripped = s.replace(ENV_PREFIX_RE, "");
  // If the whole string was env assignments with no trailing command, skip it.
  if (stripped === "") return false;
  return SHELL_COMMAND_PREFIXES.some((p) => {
    if (!stripped.startsWith(p)) return false;
    // Require a token boundary after the prefix so that filenames like
    // "go.mod" or identifiers like "node_modules" are not classified as
    // shell commands.  "./" and "vendor/" are always valid path prefixes.
    if (p === "./" || p === "vendor/") return true;
    const rest = stripped.slice(p.length);
    return rest === "" || rest[0] === " " || rest[0] === "\t";
  });
}

// Explicit, deterministic marker for a command an issue author mentions but
// does not require: the phrase "not required" or "out of scope" appearing in
// the same clause as the backticked command (see issue #993). This is a fixed
// textual marker, not natural-language interpretation of arbitrary negation.
const NOT_REQUIRED_MARKER_RE = /\bnot\s+required\b|\bout\s+of\s+scope\b/i;

// Splits a line into clauses on `;` or `.` boundaries so the not-required
// marker is scoped to only the clause it appears in, not the whole line.
// This keeps a required command from being dropped when it shares a line
// with an unrelated caveat, e.g. "Run `npm test`; `npm run e2e` is not
// required" — only `npm run e2e` is excluded.
//
// The split must never land inside an inline backtick code span: a required
// command that itself contains a `;` (e.g. `` `npm run lint; npm test` ``)
// would otherwise have its opening and closing backticks pulled into
// different clauses, so neither fragment matches the inline-code regex and
// the whole command silently disappears from extraction (issue #993 review
// follow-up). Backtick state is tracked while scanning so `;`/`.` characters
// inside an (even unterminated) code span are never treated as boundaries.
function splitClauses(line: string): string[] {
  const clauses: string[] = [];
  let current = "";
  let inCode = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
      i++;
      continue;
    }
    if (!inCode && (ch === ";" || ch === ".") && /\s/.test(line[i + 1] ?? "")) {
      current += ch;
      clauses.push(current);
      current = "";
      i++;
      while (i < line.length && /\s/.test(line[i])) i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current) clauses.push(current);
  return clauses;
}

function extractFromInlineCode(text: string): { required: string[]; excluded: string[] } {
  const required: string[] = [];
  const excluded: string[] = [];
  // Remove fenced blocks first to avoid double-counting
  const stripped = text.replace(/```[\s\S]*?```/g, "");
  for (const line of stripped.split("\n")) {
    for (const clause of splitClauses(line)) {
      const isExcludedClause = NOT_REQUIRED_MARKER_RE.test(clause);
      const inlineRe = /`([^`\n]+)`/g;
      let m: RegExpExecArray | null;
      while ((m = inlineRe.exec(clause)) !== null) {
        const code = m[1].trim();
        if (!looksLikeShellCommand(code)) continue;
        if (isExcludedClause) {
          excluded.push(code);
        } else {
          required.push(code);
        }
      }
    }
  }
  return { required, excluded };
}

/**
 * The extraction, plus whether a supported section was present at all.
 *
 * `sectionFound` distinguishes "the Issue has a Verification section that asks
 * for nothing" from "the Issue has no supported section" — two readings of an
 * empty command list that a caller diffing a LIVE body against a task's plan
 * must not confuse. The refresh path (issue #1041,
 * `docs/verification-amendment-contract.md` §10 rule 5) refuses on the second:
 * a body whose section was renamed, or which was fetched from the wrong place,
 * would otherwise read as "the Issue now requires nothing" and propose retiring
 * every requirement the task has.
 */
export interface IssueVerificationExtraction {
  commands: string[];
  sectionFound: boolean;
}

/**
 * Parse an issue body and return the list of verification commands explicitly
 * required by the issue.
 *
 * Commands are extracted from fenced code blocks and inline backtick code spans
 * inside sections titled "Verification", "Test Plan", "Acceptance Criteria", or
 * "Verify". Commands are deduplicated (first occurrence wins) and returned in
 * the order they appear.
 */
export function extractIssueVerificationCommands(body: string): string[] {
  return extractIssueVerificationSections(body).commands;
}

/**
 * The same scan as {@link extractIssueVerificationCommands}, reporting whether
 * a supported section was found. The command list is byte-identical to what
 * that function returns for the same body — one scan, one behavior, so the
 * pinned intake extraction and a live refresh can never disagree.
 */
export function extractIssueVerificationSections(body: string): IssueVerificationExtraction {
  const lines = body.split("\n");
  const seen = new Set<string>();
  const commands: string[] = [];
  const excluded = new Set<string>();

  let inVerification = false;
  let sectionFound = false;
  let verificationLevel = 0;
  let sectionBuf = "";
  let inFence = false;
  let fenceDelimiterLength = 0;

  const flush = (): void => {
    if (!sectionBuf) return;
    const { required, excluded: excludedHere } = extractFromInlineCode(sectionBuf);
    for (const cmd of excludedHere) excluded.add(cmd);
    const extracted = [
      ...extractFromFencedBlocks(sectionBuf),
      ...required,
    ];
    for (const cmd of extracted) {
      if (!seen.has(cmd)) {
        seen.add(cmd);
        commands.push(cmd);
      }
    }
    sectionBuf = "";
  };

  for (const line of lines) {
    // Track fenced code blocks globally (not just while inside a verification
    // section) so a heading embedded in a fenced sample — e.g. a Markdown
    // example quoted for illustration, as in the #569 self-hosting fixture —
    // can never open, close, or replace a task-level Verification/Test
    // Plan/Acceptance Criteria section. Comment lines (# ...) inside a real
    // fenced command block are likewise protected from being mistaken for
    // Markdown headers, which would otherwise prematurely close the section.
    //
    // Delimiter length is tracked so a fence opened with four or more
    // backticks — used to quote a sample that itself contains a nested
    // ``` fence — is only closed by a backtick run at least as long as the
    // one that opened it. A shorter nested run is literal fence content.
    const trimmedLine = line.trimStart();
    const fenceDelimiterMatch = /^`{3,}/.exec(trimmedLine);
    if (fenceDelimiterMatch) {
      const delimiterLength = fenceDelimiterMatch[0].length;
      if (!inFence) {
        inFence = true;
        fenceDelimiterLength = delimiterLength;
        if (inVerification) sectionBuf += line + "\n";
        continue;
      }
      const remainder = trimmedLine.slice(delimiterLength);
      if (delimiterLength >= fenceDelimiterLength && remainder.trim() === "") {
        inFence = false;
        fenceDelimiterLength = 0;
        if (inVerification) sectionBuf += line + "\n";
        continue;
      }
      // Either a shorter backtick run than the fence that is currently open,
      // or a long-enough run followed by trailing content (e.g. an info
      // string like "```md") — CommonMark only allows whitespace after a
      // closing fence's backticks, so this is literal content nested inside
      // the fence, not a closing delimiter. Fall through to the inFence
      // branch below.
    }
    if (inFence) {
      if (inVerification) sectionBuf += line + "\n";
      continue;
    }

    const headerMatch = VERIFICATION_SECTION_RE.exec(line);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const title = headerMatch[2].trim();

      if (inVerification && level <= verificationLevel) {
        // Exiting verification section (same or higher-level header)
        flush();
        inVerification = false;
      }

      if (!inVerification && isVerificationSection(title)) {
        inVerification = true;
        sectionFound = true;
        verificationLevel = level;
        sectionBuf = "";
      } else if (inVerification) {
        // Sub-header inside the section — accumulate it
        sectionBuf += line + "\n";
      }
    } else if (inVerification) {
      sectionBuf += line + "\n";
    }
  }

  if (inVerification) flush();

  return { commands: commands.filter((cmd) => !excluded.has(cmd)), sectionFound };
}
