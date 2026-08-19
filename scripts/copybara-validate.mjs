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
// Value classification (issue #971)
// ---------------------------------------------------------------------------

/**
 * `y` counts as a vowel: it carries the syllable in plenty of ordinary
 * identifier words (`topology`, `sync`, `system`), and excluding it would
 * reject readable literals for no security gain.
 */
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

/**
 * Thresholds for `isReadableSemanticValue`. Collected in one table so the
 * policy is reviewable as data rather than scattered through the function.
 */
export const SEMANTIC_VALUE_LIMITS = {
  maxLength: 40,
  minSegments: 2,
  maxSegments: 3,
  minSegmentLength: 3,
  maxSegmentLength: 20,
  maxConsonantRun: 3,
  minVowelRatio: 0.22,
  maxVowelRatio: 0.7,
  // Shannon entropy over an N-character string is capped at log2(N), so for
  // a 16-20 character value a readable word pair and a random one score
  // almost identically and the estimate cannot separate them. The check is
  // therefore only applied to values long enough for it to be informative;
  // below that, the word-shape signals above carry the decision.
  entropyMinLength: 24,
  maxNormalizedEntropy: 0.87,
};

/** Shannon entropy of a string's own character distribution, in bits/char. */
export function shannonEntropyBitsPerChar(value) {
  if (value.length === 0) return 0;
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Longest run of consecutive characters satisfying `predicate`. */
function maxRun(word, predicate) {
  let best = 0;
  let run = 0;
  for (const ch of word) {
    if (predicate(ch)) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/**
 * Classify the value captured by the generic secret-assignment rule (issue
 * #971). Returns true ONLY for values that are confidently readable semantic
 * literals — routing keys, status slugs, marker strings. Everything else,
 * including anything merely *plausibly* harmless, stays a credential: this
 * scanner is fail-closed, and the explicit suppression marker below (not a
 * looser classifier) is the escape hatch for reviewed ambiguous values.
 *
 * The input is the quoted value's own text. Nothing here inspects JavaScript
 * syntax — no lexer, no scope tracking, no brace/string/comment/regex-literal
 * parsing — so it applies uniformly to any file type the scanner reads.
 *
 * Signals, all of which must hold:
 *
 *  1. **Length.** Bounded overall and per segment; credential material is
 *     routinely longer than a readable literal, and a very short segment is
 *     not a word.
 *  2. **Character-class diversity.** Lowercase ASCII words joined by single
 *     `-`/`_` separators, and nothing else. One uppercase letter, digit,
 *     `+`, `/`, `=`, or `.` is enough to keep the value a credential —
 *     base64, hex, and opaque-token alphabets all carry them, readable
 *     kebab/snake literals do not.
 *  3. **Separators and word boundaries.** At least two and at most three
 *     segments. One segment has no readable word boundary at all; four or
 *     more is the shape of a word-list passphrase, which issue #971
 *     deliberately leaves blocked.
 *  4. **Not hex-alphabet-only.** `deadbeef-cafebabe` is lowercase, separated,
 *     and vowel-bearing, but it is hex-like credential material.
 *  5. **Word-shaped segments.** A vowel ratio in the range ordinary English
 *     words occupy, and no consonant run longer than three — the signal that
 *     most reliably separates words from random lowercase, where long
 *     consonant runs are the norm.
 *  6. **Estimated entropy.** For values long enough for the estimate to mean
 *     something, normalized Shannon entropy must sit below the readable-text
 *     band.
 *
 * Known limitation: a random lowercase-only value with no digits, no
 * uppercase, word-shaped segments, and exactly two or three of them would be
 * exempted. Real credential generators emit base64/hex/mixed-case alphabets,
 * and the known-format rules in CONTENT_RULES are unaffected either way —
 * this classifier only ever relaxes the single generic heuristic rule.
 */
export function isReadableSemanticValue(value) {
  if (typeof value !== 'string') return false;
  const limits = SEMANTIC_VALUE_LIMITS;
  if (value.length > limits.maxLength) return false;

  // Signal 2. The anchored shape also rules out leading/trailing and doubled
  // separators, so segment splitting below can never yield an empty segment.
  if (!/^[a-z]+(?:[-_][a-z]+)*$/.test(value)) return false;

  const segments = value.split(/[-_]/);
  if (segments.length < limits.minSegments) return false;
  if (segments.length > limits.maxSegments) return false;

  if (/^[a-f]+$/.test(segments.join(''))) return false;

  for (const segment of segments) {
    if (segment.length < limits.minSegmentLength) return false;
    if (segment.length > limits.maxSegmentLength) return false;
    const vowelCount = [...segment].filter((ch) => VOWELS.has(ch)).length;
    const vowelRatio = vowelCount / segment.length;
    if (vowelRatio < limits.minVowelRatio) return false;
    if (vowelRatio > limits.maxVowelRatio) return false;
    if (maxRun(segment, (ch) => !VOWELS.has(ch)) > limits.maxConsonantRun) return false;
  }

  if (value.length >= limits.entropyMinLength) {
    const normalized = shannonEntropyBitsPerChar(value) / Math.log2(value.length);
    if (normalized > limits.maxNormalizedEntropy) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Explicit suppression marker (issue #971)
// ---------------------------------------------------------------------------

/**
 * Grammar, written on the line IMMEDIATELY ABOVE the reported line, inside
 * whatever comment syntax the file already uses:
 *
 *     copybara-allow-next-line: <rule-id> <finding-key> -- <reason>
 *
 * `<rule-id>` must be the exact id of a rule declared `suppressible`;
 * `<finding-key>` must be the exact key that rule derives from the match (for
 * `credential-generic-assignment`, the assigned identifier); `<reason>` is
 * free text after a `--` or `—` separator and must be non-empty.
 *
 * The design constraints this satisfies:
 *
 * - **Generic across files.** One line-based grammar, no file allowlist, no
 *   per-file or per-constant special case. It is parsed out of the raw
 *   previous line, so it works in `//`, `#`, `<!-- -->`, or fenced-code
 *   contexts without any language awareness.
 * - **Visible in code review.** It is a literal comment on the line above the
 *   thing it exempts, carrying a written justification.
 * - **Does not expose the value.** The key is the identifier being assigned,
 *   never the assigned value.
 * - **Finding-scoped.** Both the rule id and the finding key must match, so a
 *   marker does not cover the whole file, does not cover the whole line when
 *   that line carries a second assignment under a different identifier, and
 *   does not cover a different rule that happens to fire on the same line.
 *   It also applies to the next line only — not two lines down.
 */
export const SUPPRESSION_MARKER_PATTERN =
  /copybara-allow-next-line:[ \t]*([a-z][a-z0-9-]*)[ \t]+([A-Za-z0-9_.$-]+)[ \t]*(?:--|—)[ \t]*\S/g;

const NO_SUPPRESSIONS = new Map();

/**
 * Parse every suppression marker on one line into `ruleId -> Set(findingKey)`.
 * A malformed marker (unknown shape, missing key, missing reason) simply does
 * not parse and therefore suppresses nothing — fail closed.
 */
export function parseSuppressionMarkers(line) {
  if (typeof line !== 'string' || line.length === 0) return NO_SUPPRESSIONS;
  const byRule = new Map();
  SUPPRESSION_MARKER_PATTERN.lastIndex = 0;
  let m;
  while ((m = SUPPRESSION_MARKER_PATTERN.exec(line)) !== null) {
    const [, ruleId, findingKey] = m;
    if (!byRule.has(ruleId)) byRule.set(ruleId, new Set());
    byRule.get(ruleId).add(findingKey);
  }
  return byRule;
}

/**
 * Decide whether one regex match is exempt: either the classifier says its
 * captured value is a confidently readable semantic literal, or the previous
 * line carries a marker naming both this rule and this finding's key.
 */
function isExemptMatch(rule, match, suppressions) {
  if (rule.classifyValue && rule.valueGroup !== undefined) {
    if (rule.classifyValue(match[rule.valueGroup])) return true;
  }
  if (!rule.suppressible) return false;
  const keys = suppressions.get(rule.id);
  if (!keys || keys.size === 0) return false;
  const findingKey = rule.suppressionKeyGroup === undefined ? undefined : match[rule.suppressionKeyGroup];
  return typeof findingKey === 'string' && keys.has(findingKey);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Content rules: each tests one line of a text file and returns the matched
 * substring(s), or an empty array when clean. Kept as plain RegExp so new
 * rules are easy to review and extend.
 *
 * Optional per-rule fields (issue #971), used only by the one generic
 * heuristic rule — every known-format rule below stays an unconditional,
 * fail-closed regex match:
 *   - `valueGroup` / `classifyValue`: capture group holding the candidate
 *     secret, and the classifier that may exempt it.
 *   - `suppressible` / `suppressionKeyGroup`: whether an explicit
 *     `copybara-allow-next-line` marker can exempt a match, and the capture
 *     group whose text the marker must name.
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
    id: 'credential-jwt',
    description: 'JWT-shaped value (base64url header.payload.signature)',
    // `eyJ` is base64url for `{"`, i.e. the start of every JSON JWT header.
    // Kept as its own known-format rule rather than left to the generic
    // assignment rule below, because a JWT most often leaks somewhere that is
    // not an assignment at all (a log line, a curl example, a fixture).
    // Mirrors the redaction regex in src/core/text-sanitize.ts, with a looser
    // bound on the signature segment — a scanner should not be the laxer of
    // the two.
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  },
  {
    id: 'credential-generic-assignment',
    description: 'Quoted secret/API-key-shaped assignment',
    // Group 1 is the full assigned identifier (the suppression key); group 2
    // is the quoted value handed to the classifier. The value alphabet
    // covers base64 (`+/=`) and dotted forms as well as the plain
    // word/hyphen shape, since those are credential-shaped too — the
    // classifier rejects all of them, so widening it only ever detects more.
    pattern: /([A-Za-z0-9_.$-]*(?:api[_-]?key|secret|token))\s*[:=]\s*['"]([A-Za-z0-9_\-+\/=.]{16,})['"]/gi,
    valueGroup: 2,
    classifyValue: isReadableSemanticValue,
    suppressible: true,
    suppressionKeyGroup: 1,
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
  // Mirrors copy.bara.sky's INTERNAL_PLANNING_PATHS (issue #811): this doc
  // and its structural test both depend on docs/DOMAIN.md and
  // docs/design/handlers-responsibility-inventory.md, which are private-only,
  // so they must stay excluded too rather than dangling in the public tree.
  { id: 'forbidden-handlers-extraction-plan', description: 'Internal-only engineering plan (depends on excluded DOMAIN.md/docs/design)', pattern: /^docs\/handlers-extraction-plan\.md$/ },
  { id: 'forbidden-handlers-extraction-plan-test', description: 'Structural test for the excluded handlers extraction plan', pattern: /^test\/docs-handlers-extraction-plan\.test\.js$/ },
];

function toPosixRelative(root, filePath) {
  return relative(root, filePath).split(sep).join('/');
}

// ---------------------------------------------------------------------------
// Dependency-closure rules
// ---------------------------------------------------------------------------

/**
 * Narrow, human-curated manifest of exported-file -> required-file
 * couplings — not a general source-dependency analyzer (see issue #811
 * scope). copy.bara.sky's origin_files exclusions are a human decision, not
 * something Copybara enforces for consistency; this catches the specific
 * failure mode where a file that IS exported reads (at module load, per
 * docs, etc.) a file that is NOT, which otherwise only surfaces as an
 * ENOENT in the public repo's own CI rather than in export validation.
 */
export const DEPENDENCY_MANIFEST = [
  {
    id: 'handlers-extraction-plan-requires-private-only-docs',
    // docs/handlers-extraction-plan.md and its structural test both read
    // docs/DOMAIN.md and docs/design/handlers-responsibility-inventory.md
    // at load time; those two are intentionally PRIVATE_ONLY_PATHS in
    // copy.bara.sky and must never be exported (see issue #811).
    dependents: ['docs/handlers-extraction-plan.md', 'test/docs-handlers-extraction-plan.test.js'],
    requires: ['docs/DOMAIN.md', 'docs/design/handlers-responsibility-inventory.md'],
  },
];

/**
 * Check a manifest of dependent -> required-path couplings against the set
 * of paths present in a tree. Only fires when at least one dependent path is
 * actually present, so it is silent for a tree (like the real public export)
 * that excludes the dependents entirely.
 */
export function checkDependencyManifest(presentPaths, manifest = DEPENDENCY_MANIFEST) {
  const findings = [];
  for (const rule of manifest) {
    const presentDependents = rule.dependents.filter((p) => presentPaths.has(p));
    if (presentDependents.length === 0) continue;
    for (const required of rule.requires) {
      if (!presentPaths.has(required)) {
        findings.push({
          rule: rule.id,
          description: `${presentDependents.join(', ')} requires ${required}, which is absent from this tree`,
          file: presentDependents[0],
          line: null,
          match: required,
        });
      }
    }
  }
  return findings;
}

/**
 * Concrete-file entries of copy.bara.sky's PRIVATE_ONLY_PATHS — paths a
 * test could plausibly `readFileSync`/`read` by their exact name.
 */
export const PRIVATE_ONLY_DOC_PATHS = ['docs/DOMAIN.md'];

/**
 * Directory-glob entries of copy.bara.sky's PRIVATE_ONLY_PATHS (currently
 * only `docs/design/**`), expressed as literal path prefixes instead of
 * enumerated filenames: a read of ANY path under one of these directories
 * dangles in an export tree exactly like a read of docs/DOMAIN.md, but the
 * concrete files under docs/design/ change over time. Matching by prefix
 * means checkUnconditionalPrivateReads covers a newly added private design
 * doc automatically, without a matching edit here — the review follow-up
 * for issue #973 found that the original fix only listed docs/DOMAIN.md
 * and missed docs/design/**, leaving the same export-CI failure class
 * (ENOENT in the public tree) open for design docs.
 */
export const PRIVATE_ONLY_DOC_PREFIXES = ['docs/design/'];

/**
 * Files whose own source is expected to contain `read(...)`/`readFileSync(...)`
 * text mentioning a private-only path as a quoted fixture string (test data
 * for checkUnconditionalPrivateReads itself), not as an executable call this
 * file would run. Scanning those fixture strings as if they were live code
 * produces a false positive the moment this validator's own test file is
 * part of the tree being scanned — see issue #973 review follow-up. Kept
 * separate from PERSONAL_PATH_EXEMPT_FILES because it exempts a different
 * check (unconditional-private-read, not the personal-path content rules)
 * and a different file (the test, not the validator source).
 */
const UNCONDITIONAL_READ_CHECK_EXEMPT_FILES = new Set(['test/copybara-validate.test.js']);

const GUARD_LOOKBACK_CHARS = 200;

/**
 * Returns the index of the `)` that closes the `(` at `openParenIndex`, by
 * depth counting, or -1 if unbalanced. Used to find the true end of an
 * `existsSync(...)` call even when its argument is itself a call
 * (`existsSync(resolve(ROOT, 'docs/DOMAIN.md'))`) — a naive `[^;]*?\)`
 * regex stops at the FIRST `)` it meets, which is `resolve(...)`'s, not
 * `existsSync(...)`'s, and that misidentified boundary is what let a
 * `||`-joined read slip past the pre-#973-review-follow-up version of this
 * check (see checkUnconditionalPrivateReads below).
 */
function matchingParenEnd(content, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < content.length; i++) {
    if (content[i] === '(') depth++;
    else if (content[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * True when `index` falls inside a `//` line comment or a block comment
 * (`/star ... star/`), by a simple backward scan (this file deliberately has no lexer —
 * see the module banner). Used only to refuse crediting an `existsSync(...)`
 * guard that appears in commented-out/example text as though it gated a
 * real read; it never suppresses detection of the read call itself, so it
 * can only make this check MORE conservative, never less.
 */
function isInsideComment(content, index) {
  const lineStart = content.lastIndexOf('\n', index - 1) + 1;
  if (content.slice(lineStart, index).includes('//')) return true;
  return content.lastIndexOf('/*', index) > content.lastIndexOf('*/', index);
}

/**
 * True only for the exact guarded conditional-read shape used throughout
 * test/docs-*-contract.test.js: `existsSync(<call containing the path>) ?
 * read(...)`, with the read sitting directly on the ternary's affirmative
 * (present-path) branch — nothing else between the guard's closing paren
 * and the read but the `?` and whitespace.
 *
 * This is deliberately a positive match on that one safe shape rather than
 * a negative "no `;` or `:` in between" test. The negative test was
 * defeated two ways (issue #973 review follow-up): `existsSync(path) ||
 * read(path)` contains neither `;` nor `:` yet runs the read exactly when
 * the path is ABSENT, and a comment mentioning `existsSync(path)` ahead of
 * a real unconditional read also contains neither. Requiring the exact `?`
 * ternary shape — via matchingParenEnd for the guard's true boundary, and
 * isInsideComment to refuse comment text as a guard — rejects both:
 * `||` leaves `between` as `" || "`, not `?`-only, and a commented-out
 * `existsSync(...)` is skipped as a guard candidate entirely.
 */
function isGuardedByExistsSyncTernary(content, readCallIndex, pathLiteralPattern) {
  const windowStart = Math.max(0, readCallIndex - GUARD_LOOKBACK_CHARS);
  const existsSyncCallPattern = /\bexistsSync\(/g;
  existsSyncCallPattern.lastIndex = windowStart;
  let gm;
  while ((gm = existsSyncCallPattern.exec(content)) !== null && gm.index < readCallIndex) {
    const openParenIndex = gm.index + gm[0].length - 1;
    const closeParenIndex = matchingParenEnd(content, openParenIndex);
    if (closeParenIndex === -1 || closeParenIndex >= readCallIndex) continue;
    if (isInsideComment(content, gm.index)) continue;
    const guardSpan = content.slice(openParenIndex, closeParenIndex + 1);
    if (!pathLiteralPattern.test(guardSpan)) continue;
    const between = content.slice(closeParenIndex + 1, readCallIndex);
    if (/^\s*\?\s*$/.test(between)) return true;
  }
  return false;
}

/**
 * Regression guard for issue #973: catches the general shape of the #811
 * failure mode (an exported file that unconditionally reads a private-only
 * path dangles with ENOENT the moment that path is correctly excluded from
 * an export) without requiring a new hand-curated DEPENDENCY_MANIFEST entry
 * for every future contract test. It reads one present file's own source for
 * a `read(...)`/`readFileSync(...)` call, extracts the first string-literal
 * argument, and — when that literal is declared private (an exact match in
 * `privatePaths` or prefixed by an entry in `privatePrefixes`) and itself
 * absent from the same tree — flags it. That means it fires against a
 * transformed export tree (where the read would actually throw) but stays
 * silent against the private source tree (where the read succeeds).
 *
 * A call is exempt only when isGuardedByExistsSyncTernary recognizes it as
 * sitting on the affirmative branch of an `existsSync(<same path>) ? ...`
 * guard immediately to its left — see that function for why this is a
 * positive shape match rather than a looser "no `;`/`:` in between" test.
 * An `existsSync` call that checks an unrelated path, or one whose result
 * is discarded in an earlier statement, does not exempt the read either —
 * the tree would still dangle with ENOENT in that case.
 */
export function checkUnconditionalPrivateReads(
  relPath,
  content,
  presentPaths,
  privatePaths = PRIVATE_ONLY_DOC_PATHS,
  privatePrefixes = PRIVATE_ONLY_DOC_PREFIXES,
) {
  if (UNCONDITIONAL_READ_CHECK_EXEMPT_FILES.has(relPath)) return [];
  const findings = [];
  const readCallPattern = /\b(?:readFileSync|read)\([^)]*?['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = readCallPattern.exec(content)) !== null) {
    const literalPath = m[1];
    const isDeclaredPrivate =
      privatePaths.includes(literalPath) || privatePrefixes.some((prefix) => literalPath.startsWith(prefix));
    if (!isDeclaredPrivate) continue;
    if (presentPaths.has(literalPath)) continue;
    const escaped = literalPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pathLiteralPattern = new RegExp(`['"\`]${escaped}['"\`]`);
    if (isGuardedByExistsSyncTernary(content, m.index, pathLiteralPattern)) continue;
    findings.push({
      rule: 'unconditional-private-read',
      description: `Unconditionally reads private-only path ${literalPath}, which this tree does not contain — guard with existsSync(<same path>) ? read(...) : ...`,
      file: relPath,
      line: content.slice(0, m.index).split('\n').length,
      match: literalPath,
    });
  }
  return findings;
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
 *
 * Two per-match exemptions can drop a candidate finding (issue #971), both
 * confined to rules that opt into them: the value classifier, and an explicit
 * `copybara-allow-next-line` marker on the preceding raw line. Lookback is
 * exactly one line and is not carried forward, so a marker never widens to
 * cover a file, a block, or a later assignment.
 */
export function scanFileContent(relPath, content, rules = CONTENT_RULES) {
  const findings = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const suppressions = i > 0 ? parseSuppressionMarkers(lines[i - 1]) : NO_SUPPRESSIONS;
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      let m;
      while ((m = rule.pattern.exec(line)) !== null) {
        if (!isExemptMatch(rule, m, suppressions)) {
          findings.push({
            rule: rule.id,
            description: rule.description,
            file: relPath,
            line: i + 1,
            match: m[0],
          });
        }
        if (!rule.pattern.global) break;
        // A zero-length match leaves lastIndex where it was; without this the
        // exec loop would never terminate for such a rule.
        if (m[0].length === 0) rule.pattern.lastIndex += 1;
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
  const dependencyManifest = opts.dependencyManifest ?? DEPENDENCY_MANIFEST;
  const privateOnlyDocPaths = opts.privateOnlyDocPaths ?? PRIVATE_ONLY_DOC_PATHS;
  const privateOnlyDocPrefixes = opts.privateOnlyDocPrefixes ?? PRIVATE_ONLY_DOC_PREFIXES;
  const files = walkFiles(rootDir);
  const findings = [];
  const presentPaths = new Set(files.map((file) => toPosixRelative(rootDir, file)));
  findings.push(...checkDependencyManifest(presentPaths, dependencyManifest));

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
    findings.push(
      ...checkUnconditionalPrivateReads(relPath, content, presentPaths, privateOnlyDocPaths, privateOnlyDocPrefixes),
    );
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
