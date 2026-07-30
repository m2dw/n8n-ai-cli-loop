/**
 * copybara-validate.mjs
 *
 * Post-transform validation for the Copybara private-to-public export
 * prototype (issue #767). Scans a transformed tree (the Copybara
 * destination working copy) for content and paths that must never reach
 * the public mirror, and fails closed (nonzero exit) when it finds any.
 *
 * Run standalone:  node scripts/copybara-validate.mjs <dir>
 * Run via wrapper:  handled by scripts/copybara-export.mjs after migrate.
 */

import { readFileSync, readdirSync, readlinkSync, statSync, lstatSync } from 'fs';
import { join, relative, sep } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Path walking
// ---------------------------------------------------------------------------

const ALWAYS_SKIP_DIRS = new Set(['.git', 'node_modules']);

/**
 * Recursively list file and symlink paths under dir, skipping VCS/dependency
 * dirs. A symlink is checked with `isSymbolicLink()` before `isDirectory()`/
 * `isFile()` — both of those are false for a symlink regardless of what it
 * points at, so it must be matched first or it silently falls through the
 * walk (and with it, both the path and content checks in scanTree).
 */
export function walkFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      results.push(fullPath);
    } else if (entry.isDirectory()) {
      if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
      results.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Content rules: each tests one line of a text file and returns the matched
 * substring(s), or an empty array when clean. Kept as plain RegExp so new
 * rules are easy to review and extend.
 */
export const CONTENT_RULES = [
  {
    id: 'personal-path-unix',
    description: 'Personal absolute path (macOS-style Users dir or Linux home dir)',
    pattern: /\/(?:Users|home)\/[\w.\-]+(?:\/[\w.\-]+)*/g,
  },
  {
    id: 'personal-path-windows',
    description: 'Personal absolute path (C:\\Users\\...)',
    pattern: /[A-Za-z]:\\Users\\[\w.\-]+(?:\\[\w.\-]+)*/g,
  },
  {
    id: 'credential-private-key',
    description: 'Embedded private key block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  },
  {
    id: 'credential-github-token',
    description: 'GitHub personal access token',
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g,
  },
  {
    id: 'credential-aws-key',
    description: 'AWS access key ID',
    pattern: /AKIA[0-9A-Z]{16}/g,
  },
  {
    id: 'credential-slack-token',
    description: 'Slack token',
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: 'credential-npm-token',
    description: 'npm publish token',
    pattern: /npm_[A-Za-z0-9]{36}/g,
  },
  {
    id: 'credential-generic-assignment',
    description: 'Quoted secret/API-key-shaped assignment',
    pattern: /(?:api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi,
  },
  {
    id: 'internal-repo-identifier',
    description: "Private repository identifier (public mirror name plus '-ai' suffix)",
    // Built via concatenation, not a literal regex, so this file's own
    // source text never contains the identifier it detects — a leak
    // scanner's rule definition inherently has to describe the pattern it
    // looks for; concatenating avoids it also being a literal match target.
    pattern: new RegExp('n8n-ai-cli-loop' + '-ai', 'g'),
  },
];

/**
 * Forbidden path rules: paths that must never exist in the transformed
 * tree, independent of their content. Matched against the file's path
 * relative to the scan root using POSIX-style separators.
 */
export const FORBIDDEN_PATH_RULES = [
  { id: 'forbidden-artifacts-dir', description: 'Local run artifacts', pattern: /^\.n8n-artifacts\// },
  { id: 'forbidden-env-file', description: 'Environment/secrets file', pattern: /(^|\/)\.env(\.|$)/ },
  { id: 'forbidden-git-credentials', description: 'Stored git credentials', pattern: /(^|\/)\.git-credentials$/ },
  { id: 'forbidden-key-file', description: 'Private key or key material file', pattern: /(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.\w+)?$/ },
  { id: 'forbidden-key-extension', description: 'Key/certificate file extension', pattern: /\.(pem|key|p12|pfx)$/ },
  // Defense in depth: mirrors copy.bara.sky's PRIVATE_ONLY_PATHS. A finding
  // here means the origin_files exclusion in copy.bara.sky did not do its
  // job (config drift) — see docs/copybara-export-poc.md.
  { id: 'forbidden-internal-doc', description: 'Internal-only planning document', pattern: /^docs\/DOMAIN\.md$/ },
  { id: 'forbidden-internal-design-dir', description: 'Internal-only design directory', pattern: /^docs\/design\// },
];

function toPosixRelative(root, filePath) {
  return relative(root, filePath).split(sep).join('/');
}

// ---------------------------------------------------------------------------
// Fixture/example exemptions
// ---------------------------------------------------------------------------

/**
 * `test/**` is exempt from every CONTENT_RULES check (not just personal
 * paths): this repo's test suite deliberately uses realistic-looking
 * absolute paths, PEM-shaped placeholder key blocks, and token-shaped
 * placeholder strings as fixture data for path-handling, redaction, and
 * secret-scrubbing coverage (see "Privacy and prerequisites" in
 * docs/idea-to-implementation.md, which documents this convention). None of
 * that is real material, and a normal export of this repository's own tree
 * — origin_files does not exclude test/ — must be able to pass its own
 * validation. FORBIDDEN_PATH_RULES (filename/extension based) still apply
 * inside test/ unchanged.
 */
const CONTENT_EXEMPT_DIRS = [/^test\//];

/**
 * A small, explicit set of non-test files that document the same
 * placeholder-path convention in prose or comments rather than in a test
 * fixture (e.g. `/Users/you/...` in docs/idea-to-implementation.md,
 * `C:\Users\Jane\...` in a text-sanitize.ts comment). Exempted from the
 * personal-path rules only — these files carry no credential or internal-
 * repo-identifier fixtures, so those rules stay active here as a safety
 * net if that ever changes.
 */
const PERSONAL_PATH_EXEMPT_FILES = new Set([
  'docs/idea-to-implementation.md',
  'src/core/text-sanitize.ts',
  'src/core/tool-request.ts',
  // scripts/ is not excluded by origin_files, so this validator's own source
  // (including this comment block's `/Users/you/...` and `C:\Users\Jane\...`
  // examples) is exported and scanned like any other file. Without this
  // exemption a clean migration would always fail on its own doc comments.
  'scripts/copybara-validate.mjs',
]);
const PERSONAL_PATH_RULE_IDS = new Set(['personal-path-unix', 'personal-path-windows']);

/** Compute the CONTENT_RULES subset that applies to one file's relative path. */
function contentRulesForPath(relPath, contentRules) {
  if (CONTENT_EXEMPT_DIRS.some((re) => re.test(relPath))) return [];
  if (PERSONAL_PATH_EXEMPT_FILES.has(relPath)) {
    return contentRules.filter((rule) => !PERSONAL_PATH_RULE_IDS.has(rule.id));
  }
  return contentRules;
}

/**
 * Best-effort binary-file skip so we don't try to line-scan images/binaries.
 * `.svg` is deliberately NOT included: SVG is XML text, not a binary raster
 * format, and a source SVG can carry a personal path, credential-shaped
 * string, or the private repo identifier in a `<title>`/`<desc>`/comment —
 * skipping it here would bypass the leak check entirely for that file.
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf',
  '.eot', '.zip', '.gz', '.tgz', '.jar', '.class', '.db', '.sqlite',
]);

function isLikelyBinary(path) {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/**
 * Scan one file's content against CONTENT_RULES, line by line.
 * Returns an array of findings: { rule, description, line, match }.
 */
export function scanFileContent(relPath, content, rules = CONTENT_RULES) {
  const findings = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      let m;
      while ((m = rule.pattern.exec(line)) !== null) {
        findings.push({
          rule: rule.id,
          description: rule.description,
          file: relPath,
          line: i + 1,
          match: m[0],
        });
        if (!rule.pattern.global) break;
      }
    }
  }
  return findings;
}

/** Check one relative path against FORBIDDEN_PATH_RULES. */
export function scanPath(relPath, rules = FORBIDDEN_PATH_RULES) {
  const findings = [];
  for (const rule of rules) {
    if (rule.pattern.test(relPath)) {
      findings.push({ rule: rule.id, description: rule.description, file: relPath, line: null, match: relPath });
    }
  }
  return findings;
}

/**
 * Scan an entire tree. Returns { ok, findings } — ok is true only when
 * findings is empty. Never throws on individual unreadable/binary files;
 * those are skipped rather than treated as a leak.
 */
export function scanTree(rootDir, opts = {}) {
  const contentRules = opts.contentRules ?? CONTENT_RULES;
  const pathRules = opts.pathRules ?? FORBIDDEN_PATH_RULES;
  const files = walkFiles(rootDir);
  const findings = [];

  for (const file of files) {
    const relPath = toPosixRelative(rootDir, file);
    findings.push(...scanPath(relPath, pathRules));
    const rulesForFile = contentRulesForPath(relPath, contentRules);

    // Symlinks are rejected outright rather than followed: Copybara can
    // carry a symlink from origin into the transformed tree, and its
    // target (which may point outside rootDir entirely, e.g. a personal
    // absolute path) would otherwise bypass both the path check above and
    // the content read below, which only ever look at the link itself, not
    // its target. The target string is still scanned as content so a
    // leaked path/credential-shaped target is also individually reported.
    if (lstatSync(file).isSymbolicLink()) {
      const target = readlinkSync(file);
      // Check the target for credential-shaped content BEFORE building the
      // forbidden-symlink finding: that finding's `match` is otherwise the
      // raw target, and displayMatch() only redacts `credential-*` rule ids,
      // so a credential-shaped target would print verbatim under this rule
      // even though the separate credential-* finding below is redacted.
      const targetFindings = scanFileContent(relPath, target, rulesForFile);
      const targetHasCredential = targetFindings.some((f) => f.rule.startsWith('credential-'));
      findings.push({
        rule: 'forbidden-symlink',
        description: 'Symbolic link (not permitted in the exported tree — target may bypass content checks)',
        file: relPath,
        line: null,
        match: targetHasCredential ? `[REDACTED ${target.length} chars]` : target,
      });
      findings.push(...targetFindings);
      continue;
    }

    if (isLikelyBinary(relPath)) continue;
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Skip files that don't decode cleanly as text (heuristic: NUL byte).
    if (content.includes('\u0000')) continue;
    findings.push(...scanFileContent(relPath, content, rulesForFile));
  }

  return { ok: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Render a finding's matched text for display (stderr, CI/n8n logs). A
 * `credential-*` rule's match IS the secret itself, so it is redacted here
 * rather than reported verbatim — the rule id, file, and line are enough to
 * act on the finding without the leak check itself persisting the leak in
 * retained logs.
 */
export function displayMatch(f) {
  return f.rule.startsWith('credential-') ? `[REDACTED ${f.match.length} chars]` : f.match;
}

export function main(argv = process.argv.slice(2)) {
  const dir = argv[0];
  if (!dir) {
    console.error('Usage: node scripts/copybara-validate.mjs <dir>');
    return 2;
  }
  statSync(dir); // throws if missing — fail closed rather than silently pass
  const { ok, findings } = scanTree(dir);
  if (ok) {
    console.log(`copybara-validate: clean (${dir})`);
    return 0;
  }
  console.error(`copybara-validate: ${findings.length} unsafe finding(s) in ${dir}`);
  for (const f of findings) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    console.error(`  [${f.rule}] ${loc} — ${f.description}: ${displayMatch(f)}`);
  }
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
