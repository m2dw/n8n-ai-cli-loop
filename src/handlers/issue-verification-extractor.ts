/**
 * Extracts expected verification commands from an issue body.
 *
 * Scans for Markdown section headers whose titles match "Verification",
 * "Test Plan", "Acceptance Criteria", or "Verify". Within those sections,
 * extracts shell commands from fenced code blocks and inline backtick spans.
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
          if (!isCompoundRunnableCommand(cmd) && (ENV_ONLY_RE.test(cmd) || SETUP_LINE_RE.test(cmd))) {
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
        if (!isCompoundRunnableCommand(bare) && (ENV_ONLY_RE.test(bare) || SETUP_LINE_RE.test(bare))) {
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

// Matches a line that is ONLY env-var assignments (no trailing command).
// Unlike ENV_PREFIX_RE, the final assignment need not be followed by whitespace.
const ENV_ONLY_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s*)+$/;

// Shell setup/stateful lines that do not represent standalone verification checks:
// directory changes, variable exports (export VAR=val), file sourcing, and shell
// option flags (set -e, set -x). These lines configure the environment for the
// real command that follows and should not be recorded as required verifications.
// Note: bare env-var assignments (VAR=val) are already filtered by ENV_ONLY_RE.
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

function extractFromInlineCode(text: string): string[] {
  const commands: string[] = [];
  // Remove fenced blocks first to avoid double-counting
  const stripped = text.replace(/```[\s\S]*?```/g, "");
  const inlineRe = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(stripped)) !== null) {
    const code = m[1].trim();
    if (looksLikeShellCommand(code)) {
      commands.push(code);
    }
  }
  return commands;
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
  const lines = body.split("\n");
  const seen = new Set<string>();
  const commands: string[] = [];

  let inVerification = false;
  let verificationLevel = 0;
  let sectionBuf = "";
  let inFence = false;

  const flush = (): void => {
    if (!sectionBuf) return;
    const extracted = [
      ...extractFromFencedBlocks(sectionBuf),
      ...extractFromInlineCode(sectionBuf),
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
    // Track fenced code blocks so comment lines (# ...) inside them are not
    // mistaken for Markdown headers, which would prematurely close the section.
    if (inVerification && line.trimStart().startsWith("```")) {
      inFence = !inFence;
      sectionBuf += line + "\n";
      continue;
    }
    if (inFence) {
      sectionBuf += line + "\n";
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

  return commands;
}
