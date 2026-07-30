/**
 * Constrained read-only repository evidence resolver (issue #806).
 *
 * Implements the resolver half of docs/research-evidence-contract.md: a
 * runner-owned, pure, read-only resolver that answers exactly three
 * operations — `list`, `read`, `search` — against a snapshot of the tracked
 * file set of the run's evidence root, under fixed bounds and a fixed
 * admission policy (§1, §3–§5 of the contract).
 *
 * This module is the security boundary. It performs no I/O of its own beyond
 * the injected seams (`TrackedFileSource`, `FileAccess`), spawns nothing,
 * writes nothing, and never constructs a `RegExp` from agent-supplied text —
 * patterns and globs are executed by the bounded matchers below (§3.3.1,
 * §3.4, §8.5). It must not import from handlers/.
 */

import { createHash } from "crypto";
import { redactTokens } from "./text-sanitize.js";

// ---------------------------------------------------------------------------
// Bounds (contract §5) — named constants, asserted by tests, recorded in the
// run manifest. Fixed in code deliberately: an operator-tunable bound here
// would let a misconfiguration turn into an availability failure.
// ---------------------------------------------------------------------------

export const REQUEST_SCAN_MAX_BYTES = 262_144;
export const REQUEST_MAX_BYTES = 8_192;
export const QUERY_ID_MAX_LENGTH = 64;
export const PATH_MAX_LENGTH = 1_024;
export const GLOB_MAX_LENGTH = 256;
export const GLOB_MAX_SEGMENTS = 32;
export const GLOB_MAX_WILDCARDS = 16;
export const GLOB_MAX_STARSTAR = 2;
export const PATTERN_MAX_LENGTH = 200;
export const REGEX_MAX_REPEAT = 1_000;
export const REGEX_MAX_QUANTIFIERS = 8;
export const ALT_MAX_BRANCHES = 16;
export const REGEX_NFA_MAX_STATES = 512;
export const READ_MAX_BYTES = 65_536;
export const READ_MAX_LINES = 1_000;
export const READ_SCAN_MAX_BYTES = 1_048_576;
export const LIST_MAX_PATHS = 500;
export const SEARCH_MAX_MATCHES = 100;
export const SEARCH_MAX_FILES_SCANNED = 5_000;
export const SEARCH_MATCH_LINE_MAX = 512;
export const FILE_MAX_BYTES_SCANNED = 1_048_576;
export const BINARY_SNIFF_BYTES = 8_192;
export const SNAPSHOT_MAX_PATHS = 200_000;
export const SNAPSHOT_MAX_BYTES = 8_388_608;
export const SNAPSHOT_MS = 10_000;
export const MAX_QUERIES_PER_TURN = 8;
export const EVIDENCE_BYTES_PER_TURN = 131_072;
export const EVIDENCE_TURN_MS = 30_000;
export const MAX_EVIDENCE_TURNS = 4;
export const MAX_QUERIES_PER_RUN = 24;
export const EVIDENCE_BYTES_PER_RUN = 393_216;
export const PROMPT_MAX_BYTES = 524_288;
export const EVIDENCE_RUN_MS = 120_000;

/** Reserved literal addressing the issue-body artifact (§4.0) — a source
 * discriminator, never a filesystem path. */
export const ISSUE_BODY_PATH_LITERAL = "<issue-body>";

/** Constant basename of the runner-written issue-body artifact (§2). */
export const ISSUE_BODY_ARTIFACT = "research-issue-body.md";

/**
 * Fixed, non-overridable deny floor (§4.7). `session.research.evidence.denyGlobs`
 * is additive only; configuration can tighten this floor, never loosen it.
 */
export const DEFAULT_DENY_GLOBS: readonly string[] = [
  "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.pfx", "**/*.p12",
  "**/id_rsa*", "**/id_ed25519*", "**/.npmrc", "**/.netrc",
  "**/*.keystore", "**/*credentials*", "**/*secret*.json", "**/.n8n-artifacts/**",
];

// ---------------------------------------------------------------------------
// Query / result types (contract §3, §7.1)
// ---------------------------------------------------------------------------

export interface ListQuery {
  id: string;
  op: "list";
  path?: string;
  glob?: string;
  includeGenerated?: boolean;
  maxResults?: number;
}

export interface ReadQuery {
  id: string;
  op: "read";
  source?: "repo" | "issue-body";
  path?: string;
  startLine?: number;
  endLine?: number;
}

export interface SearchQuery {
  id: string;
  op: "search";
  pattern: string;
  kind?: "fixed" | "regex";
  ignoreCase?: boolean;
  glob?: string;
  path?: string;
  maxMatches?: number;
  includeGenerated?: boolean;
}

export type EvidenceQuery = ListQuery | ReadQuery | SearchQuery;

export type EvidenceDenialReason =
  | "invalid-query"
  | "unsupported-op"
  | "absolute-path"
  | "outside-root"
  | "symlink-rejected"
  | "not-tracked"
  | "not-found"
  | "not-regular-file"
  | "binary"
  | "denied-sensitive"
  | "pattern-rejected"
  | "glob-rejected"
  | "budget-exhausted"
  | "resolver-error";

export interface EvidenceDenialResult {
  id: string;
  op: string;
  status: "denied";
  reason: EvidenceDenialReason;
  /** Fixed-form detail: a failing subset rule, field name, or error class —
   * never agent-supplied text (§7.1, §9). */
  detail?: string;
  /** Binary-read metadata (§4.5): bounded prefix digest, never a whole-file hash. */
  totalBytes?: number;
  digestAlgorithm?: "sha256-prefix";
  digestBytes?: number;
  digestPrefixSha256?: string;
}

export interface EvidenceListResult {
  id: string;
  op: "list";
  status: "ok";
  paths: string[];
  truncated: boolean;
  pathsExcludedGenerated: number;
  pathsExcludedSensitive: number;
  pathsExcludedSymlink: number;
}

export interface EvidenceReadResult {
  id: string;
  op: "read";
  status: "ok";
  source: "repo" | "issue-body";
  contentSource: "worktree" | "artifact";
  scope: "tracked-worktree";
  path?: string;
  content: string;
  firstLine: number | null;
  lastLine: number | null;
  totalBytes: number;
  totalLines: number | null;
  totalLinesExact: boolean;
  truncated: boolean;
  redacted: boolean;
}

export interface EvidenceSearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface EvidenceSearchResult {
  id: string;
  op: "search";
  status: "ok";
  matches: EvidenceSearchMatch[];
  filesScanned: number;
  filesSkippedBinary: number;
  filesSkippedTooLarge: number;
  filesExcludedGenerated: number;
  filesExcludedSensitive: number;
  truncated: boolean;
  redacted: boolean;
}

export type EvidenceResult =
  | EvidenceDenialResult
  | EvidenceListResult
  | EvidenceReadResult
  | EvidenceSearchResult;

// ---------------------------------------------------------------------------
// Injected seams (§13 S1) — unit tests need no git and no real repository.
// ---------------------------------------------------------------------------

export type EvidenceSnapshotReason = "snapshot-too-large" | "snapshot-timeout" | "snapshot-failed";

/** Snapshot capture failure (§4.2.1): overflow is a failure, not a truncation. */
export class EvidenceSnapshotError extends Error {
  reason: EvidenceSnapshotReason;
  entriesSeen: number;
  bytesConsumed: number;
  constructor(reason: EvidenceSnapshotReason, entriesSeen: number, bytesConsumed: number) {
    super(`evidence snapshot ${reason}`);
    this.name = "EvidenceSnapshotError";
    this.reason = reason;
    this.entriesSeen = entriesSeen;
    this.bytesConsumed = bytesConsumed;
  }
}

export interface TrackedFileSource {
  /** Returns the complete tracked snapshot (already within SNAPSHOT_MAX_PATHS)
   * or throws EvidenceSnapshotError — the core never receives a partial list. */
  list(): string[];
  snapshotAt: string;
  scope: "tracked-worktree";
  /** Identity of the evidence root the snapshot was captured from (§4.3
   * step 1). The caller MUST verify its per-turn anchor against this before
   * serving any query, so a root replaced between capture and anchor
   * resolution aborts as `evidence/unavailable` instead of pairing this path
   * list with another directory's bytes. */
  root: RootAnchor;
}

export interface RootAnchor {
  realPath: string;
  dev: number;
  ino: number;
}

export type ComponentCheck = "ok" | "symlink" | "missing" | "error";

export interface FileAccess {
  /** Resolve the evidence root once per turn: realpath + (dev, ino) (§4.3 step 1). */
  resolveRoot(root: string): RootAnchor;
  /** Re-check the recorded root identity (§4.3 step 1): false when the root
   * no longer matches the anchor's (dev, ino) — moved, replaced, or gone. */
  verifyRoot(anchor: RootAnchor): boolean;
  /** Diagnostic pre-check (§4.3 step 2) — never authorization to read. */
  lstatComponents(anchor: RootAnchor, relPath: string): ComponentCheck;
  /** No-follow, non-blocking open (§4.3 step 3, §4.4). */
  openRead(anchor: RootAnchor, relPath: string): { fd: number } | { errorClass: string };
  /** fstat the DESCRIPTOR, not the path (§4.3 step 4). */
  fstatFd(fd: number): { isFile: boolean; dev: number; ino: number; size: number };
  /** Chain re-verification before any byte is read (§4.3 step 5). */
  verifyChain(anchor: RootAnchor, relPath: string, dev: number, ino: number): boolean;
  /** Positioned read into a fixed-size buffer; returns bytes read (0 at EOF). */
  readAt(fd: number, buffer: Buffer, position: number): number;
  close(fd: number): void;
}

export interface EvidenceBudgetState {
  queriesRun: number;
  /** Rendered payload bytes actually appended to the prompt so far (§5) —
   * charged by the caller after rendering each section, never from pre-render
   * result JSON, which the per-turn render cap may partially drop. */
  bytesServedRun: number;
  runStartedAt: number;
  turnStartedAt: number;
}

export interface EvidenceResolverDeps {
  snapshot: TrackedFileSource;
  fileAccess: FileAccess;
  anchor: RootAnchor;
  /** Operator additions to the deny floor (§4.7) — additive only. */
  denyGlobs?: string[];
  /** Generated-file globs (§4.6) — default empty. */
  generatedGlobs?: string[];
  /** Location of the runner-written issue-body artifact; null when the run has
   * no body (or evidence is disabled, in which case the file was never written). */
  issueBody?: { artifactDir: string } | null;
  budget: EvidenceBudgetState;
  now(): number;
}

// ---------------------------------------------------------------------------
// Glob subset (§3.4): closed grammar + bounded segment-wise matcher.
// No RegExp is ever constructed from a glob, and no glob library is used.
// ---------------------------------------------------------------------------

export type ParsedGlob = string[][] & { readonly __brand?: "evidence-glob" };

export type GlobParseResult =
  | { ok: true; segments: string[] }
  | { ok: false; rule: string };

const GLOB_RESERVED = new Set(["[", "]", "{", "}", "(", ")", "!", "\\", ","]);

export function parseEvidenceGlob(glob: string): GlobParseResult {
  if (typeof glob !== "string" || glob.length === 0) return { ok: false, rule: "glob-empty" };
  if (glob.length > GLOB_MAX_LENGTH) return { ok: false, rule: "glob-too-long" };
  if (glob.includes("\0")) return { ok: false, rule: "glob-nul" };
  if (glob.startsWith("/")) return { ok: false, rule: "glob-absolute" };
  if (/^[A-Za-z]:[/\\]/.test(glob) || glob.startsWith("\\\\")) return { ok: false, rule: "glob-absolute" };
  if (glob.endsWith("/")) return { ok: false, rule: "glob-trailing-slash" };
  const segments = glob.split("/");
  if (segments.length > GLOB_MAX_SEGMENTS) return { ok: false, rule: "glob-too-many-segments" };
  let wildcards = 0;
  let starstar = 0;
  for (const seg of segments) {
    if (seg.length === 0) return { ok: false, rule: "glob-empty-segment" };
    if (seg === "." || seg === "..") return { ok: false, rule: "glob-traversal" };
    if (seg === "**") {
      starstar++;
      continue;
    }
    if (seg.includes("**")) return { ok: false, rule: "glob-starstar-not-whole-segment" };
    for (const ch of seg) {
      if (GLOB_RESERVED.has(ch)) return { ok: false, rule: "glob-class-unsupported" };
      if (ch === "*" || ch === "?") wildcards++;
    }
  }
  if (wildcards > GLOB_MAX_WILDCARDS) return { ok: false, rule: "glob-too-many-wildcards" };
  if (starstar > GLOB_MAX_STARSTAR) return { ok: false, rule: "glob-too-many-starstar" };
  return { ok: true, segments };
}

// Linear two-pointer wildcard match within one segment: O(|pattern| x |text|).
function matchSegment(pattern: string, text: string): boolean {
  let p = 0, t = 0, star = -1, mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p++; t++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++; mark = t;
    } else if (star >= 0) {
      p = star + 1; t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Segment-wise glob match over a whole repo-relative path (§3.4 part 2). */
export function matchEvidenceGlob(segments: string[], path: string): boolean {
  const parts = path.split("/");
  // Memoized DP over (glob segment, path segment); bounded by
  // GLOB_MAX_SEGMENTS x path segments.
  const memo = new Map<number, boolean>();
  const n = segments.length, m = parts.length;
  const key = (i: number, j: number) => i * (m + 1) + j;
  const walk = (i: number, j: number): boolean => {
    const k = key(i, j);
    const cached = memo.get(k);
    if (cached !== undefined) return cached;
    let out: boolean;
    if (i === n) {
      out = j === m;
    } else if (segments[i] === "**") {
      out = false;
      for (let jj = j; jj <= m && !out; jj++) out = walk(i + 1, jj);
    } else if (j === m) {
      out = false;
    } else {
      out = matchSegment(segments[i]!, parts[j]!) && walk(i + 1, j + 1);
    }
    memo.set(k, out);
    return out;
  };
  return walk(0, 0);
}

/**
 * Enable-time validation for operator-configured globs (§4.6, §4.7). Validates
 * the lowercased form — the exact string `compileOperatorGlobs` compiles — and
 * returns the first rejection as an index plus the §3.4 rule literal (never
 * the glob text, which may itself name a sensitive path).
 */
export function findInvalidOperatorGlob(
  globs: readonly string[],
): { index: number; rule: string } | null {
  for (let i = 0; i < globs.length; i++) {
    const parsed = parseEvidenceGlob(globs[i]!.toLowerCase());
    if (!parsed.ok) return { index: i, rule: parsed.rule };
  }
  return null;
}

/**
 * Operator-trusted deny/generated matching (§3.4 rule 6): case-insensitive so
 * denial over-matches; agent-supplied glob filtering stays exact-bytes.
 */
function compileOperatorGlobs(globs: readonly string[]): string[][] {
  const out: string[][] = [];
  for (const g of globs) {
    const parsed = parseEvidenceGlob(g.toLowerCase());
    if (!parsed.ok) {
      // An operator glob the grammar rejects must never be silently dropped —
      // dropping a deny entry would serve paths the operator configured as
      // sensitive. Callers validate at enable time (findInvalidOperatorGlob);
      // this throw is the fail-closed backstop, surfaced per query as a
      // `resolver-error` denial by resolveEvidenceTurn's class-only catch.
      const err = new Error("operator glob rejected") as NodeJS.ErrnoException;
      err.code = "operator-glob-invalid";
      throw err;
    }
    out.push(parsed.segments);
  }
  return out;
}

function matchesAnyOperatorGlob(compiled: string[][], path: string): boolean {
  const lower = path.toLowerCase();
  for (const segs of compiled) {
    if (matchEvidenceGlob(segs, lower)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Regex subset (§3.3.1): closed grammar + non-backtracking NFA simulation.
// A quantifier may only bind a single-character atom, so nested/ambiguous
// quantifiers cannot be expressed; the Thompson simulation gives a hard
// O(|pattern| x |line|) worst case. No RegExp is built from agent text.
// ---------------------------------------------------------------------------

type CharPred = (ch: string) => boolean;

type NfaState =
  | { t: "char"; pred: CharPred; next: number }
  | { t: "split"; a: number; b: number }
  | { t: "assert"; kind: "bol" | "eol" | "wb" | "nwb"; next: number }
  | { t: "accept" };

export interface CompiledPattern {
  states: NfaState[];
  start: number;
}

export type PatternParseResult =
  | { ok: true; nfa: CompiledPattern }
  | { ok: false; rule: string };

const WORD_RE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_RE_CHARS.includes(ch);
}

const ESCAPE_CLASSES: Record<string, CharPred> = {
  d: (c) => c >= "0" && c <= "9",
  D: (c) => !(c >= "0" && c <= "9"),
  w: (c) => isWordChar(c),
  W: (c) => !isWordChar(c),
  s: (c) => c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v",
  S: (c) => !(c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v"),
};

const ESCAPE_LITERALS: Record<string, string> = { n: "\n", r: "\r", t: "\t" };

interface PatternParser {
  src: string;
  pos: number;
  quantifiers: number;
  rule: string | null;
}

// Parsed AST node. `atom` nodes are single-character-consuming and therefore
// quantifiable (grammar rule 1); groups are not.
type ReNode =
  | { t: "alt"; branches: ReNode[][] }
  | { t: "atom"; pred: CharPred; min: number; max: number } // max = Infinity for * / +
  | { t: "assert"; kind: "bol" | "eol" | "wb" | "nwb" }
  | { t: "group"; inner: ReNode }; // (?:...) — never quantified

function fail(p: PatternParser, rule: string): null {
  if (!p.rule) p.rule = rule;
  return null;
}

function parseAlternation(p: PatternParser, depth: number): ReNode | null {
  const branches: ReNode[][] = [];
  let current: ReNode[] = [];
  for (;;) {
    if (p.pos >= p.src.length || p.src[p.pos] === ")") break;
    const ch = p.src[p.pos]!;
    if (ch === "|") {
      branches.push(current);
      current = [];
      if (branches.length + 1 > ALT_MAX_BRANCHES) return fail(p, "too-many-branches");
      p.pos++;
      continue;
    }
    const term = parseTerm(p, depth);
    if (term === null) return null;
    current.push(term);
  }
  branches.push(current);
  return { t: "alt", branches };
}

function parseTerm(p: PatternParser, depth: number): ReNode | null {
  const ch = p.src[p.pos]!;
  // Anchors take no quantifier.
  if (ch === "^") { p.pos++; return { t: "assert", kind: "bol" }; }
  if (ch === "$") { p.pos++; return { t: "assert", kind: "eol" }; }
  if (ch === "\\" && (p.src[p.pos + 1] === "b" || p.src[p.pos + 1] === "B")) {
    const kind = p.src[p.pos + 1] === "b" ? "wb" : "nwb";
    p.pos += 2;
    if (peekQuantifier(p)) return fail(p, "quantified-anchor");
    return { t: "assert", kind };
  }
  if (ch === "*" || ch === "+" || ch === "?" || ch === "{") return fail(p, "dangling-quantifier");
  if (ch === "(") {
    if (p.src.startsWith("(?:", p.pos)) {
      p.pos += 3;
      const inner = parseAlternation(p, depth + 1);
      if (inner === null) return null;
      if (p.src[p.pos] !== ")") return fail(p, "unbalanced-group");
      p.pos++;
      // Rule 1: quantifying a group is rejected outright.
      if (peekQuantifier(p)) return fail(p, "quantified-group");
      return { t: "group", inner };
    }
    if (p.src.startsWith("(?", p.pos)) return fail(p, "lookaround-unsupported");
    return fail(p, "capture-group-unsupported");
  }
  const atomPred = parseAtomPred(p);
  if (atomPred === null) return null;
  const q = parseQuantifier(p);
  if (q === undefined) return null;
  if (q !== null) {
    p.quantifiers++;
    if (p.quantifiers > REGEX_MAX_QUANTIFIERS) return fail(p, "too-many-quantifiers");
    return { t: "atom", pred: atomPred, min: q.min, max: q.max };
  }
  return { t: "atom", pred: atomPred, min: 1, max: 1 };
}

function peekQuantifier(p: PatternParser): boolean {
  const ch = p.src[p.pos];
  return ch === "*" || ch === "+" || ch === "?" || ch === "{";
}

/** Returns null = no quantifier, undefined = parse failure, else {min,max}. */
function parseQuantifier(p: PatternParser): { min: number; max: number } | null | undefined {
  const ch = p.src[p.pos];
  let q: { min: number; max: number } | null = null;
  if (ch === "*") { p.pos++; q = { min: 0, max: Infinity }; }
  else if (ch === "+") { p.pos++; q = { min: 1, max: Infinity }; }
  else if (ch === "?") { p.pos++; q = { min: 0, max: 1 }; }
  else if (ch === "{") {
    const m = /^\{(\d+)(?:,(\d*))?\}/.exec(p.src.slice(p.pos));
    if (!m) { fail(p, "malformed-repeat"); return undefined; }
    const n = Number(m[1]);
    const upper = m[2] === undefined ? n : (m[2] === "" ? Infinity : Number(m[2]));
    if (n > REGEX_MAX_REPEAT || (upper !== Infinity && upper > REGEX_MAX_REPEAT)) {
      fail(p, "repeat-too-large");
      return undefined;
    }
    if (upper !== Infinity && n > upper) { fail(p, "repeat-range-invalid"); return undefined; }
    p.pos += m[0].length;
    q = { min: n, max: upper };
  }
  if (q !== null && p.src[p.pos] === "?") p.pos++; // lazy marker — equivalence for match detection
  return q;
}

const PUNCTUATION_ESCAPES = new Set([...".^$*+?()[]{}|\\/-,:;!@#%&=<>\"'`~ "]);

function parseAtomPred(p: PatternParser): CharPred | null {
  const ch = p.src[p.pos]!;
  if (ch === ".") {
    p.pos++;
    return (c) => c !== "\n";
  }
  if (ch === "[") return parseClass(p);
  if (ch === "]") return fail(p, "unbalanced-class");
  if (ch === "\\") {
    const next = p.src[p.pos + 1];
    if (next === undefined) return fail(p, "trailing-escape");
    if (ESCAPE_CLASSES[next]) { p.pos += 2; return ESCAPE_CLASSES[next]!; }
    if (ESCAPE_LITERALS[next] !== undefined) {
      const lit = ESCAPE_LITERALS[next]!;
      p.pos += 2;
      return (c) => c === lit;
    }
    if (PUNCTUATION_ESCAPES.has(next)) {
      p.pos += 2;
      return (c) => c === next;
    }
    // \1, \p{...}, \k<...>, and any unlisted escape are rejected (rule 4).
    if (next >= "0" && next <= "9") return fail(p, "backreference-unsupported");
    return fail(p, "unsupported-escape");
  }
  p.pos++;
  return (c) => c === ch;
}

function parseClass(p: PatternParser): CharPred | null {
  p.pos++; // consume [
  let negated = false;
  if (p.src[p.pos] === "^") { negated = true; p.pos++; }
  const singles = new Set<string>();
  const ranges: Array<[string, string]> = [];
  const preds: CharPred[] = [];
  let sawItem = false;
  for (;;) {
    const ch = p.src[p.pos];
    if (ch === undefined) return fail(p, "unbalanced-class");
    if (ch === "]" && sawItem) { p.pos++; break; }
    if (ch === "[") return fail(p, "nested-class-unsupported");
    let lo: string;
    if (ch === "\\") {
      const next = p.src[p.pos + 1];
      if (next === undefined) return fail(p, "trailing-escape");
      if (ESCAPE_CLASSES[next]) { preds.push(ESCAPE_CLASSES[next]!); p.pos += 2; sawItem = true; continue; }
      if (ESCAPE_LITERALS[next] !== undefined) { lo = ESCAPE_LITERALS[next]!; p.pos += 2; }
      else if (PUNCTUATION_ESCAPES.has(next) || next === "]") { lo = next; p.pos += 2; }
      else return fail(p, "unsupported-escape");
    } else {
      lo = ch;
      p.pos++;
    }
    sawItem = true;
    if (p.src[p.pos] === "-" && p.src[p.pos + 1] !== undefined && p.src[p.pos + 1] !== "]") {
      p.pos++;
      let hi = p.src[p.pos]!;
      if (hi === "\\") {
        const next = p.src[p.pos + 1];
        if (next !== undefined && (PUNCTUATION_ESCAPES.has(next) || ESCAPE_LITERALS[next] !== undefined)) {
          hi = ESCAPE_LITERALS[next] ?? next;
          p.pos += 2;
        } else return fail(p, "unsupported-escape");
      } else {
        p.pos++;
      }
      if (lo > hi) return fail(p, "class-range-invalid");
      ranges.push([lo, hi]);
    } else {
      singles.add(lo);
    }
  }
  const positive: CharPred = (c) =>
    singles.has(c) || ranges.some(([lo, hi]) => c >= lo && c <= hi) || preds.some((f) => f(c));
  return negated ? (c) => !positive(c) : positive;
}

// Thompson construction: build states, patch dangling outs; the state count is
// bounded by REGEX_NFA_MAX_STATES (grammar rule 5).
interface NfaBuilder {
  states: NfaState[];
  overflow: boolean;
}

function addState(b: NfaBuilder, s: NfaState): number {
  if (b.states.length >= REGEX_NFA_MAX_STATES) {
    b.overflow = true;
    return 0;
  }
  b.states.push(s);
  return b.states.length - 1;
}

interface Frag { start: number; outs: Array<{ state: number; slot: "next" | "a" | "b" }> }

function patch(b: NfaBuilder, outs: Frag["outs"], target: number): void {
  for (const o of outs) {
    const s = b.states[o.state]!;
    if (o.slot === "next" && (s.t === "char" || s.t === "assert")) s.next = target;
    else if (s.t === "split" && o.slot === "a") s.a = target;
    else if (s.t === "split" && o.slot === "b") s.b = target;
  }
}

function emptyFrag(b: NfaBuilder): Frag {
  const s = addState(b, { t: "split", a: -1, b: -1 });
  // A split whose both slots dangle acts as a pass-through once patched to the
  // same target.
  return { start: s, outs: [{ state: s, slot: "a" }, { state: s, slot: "b" }] };
}

function charFrag(b: NfaBuilder, pred: CharPred): Frag {
  const s = addState(b, { t: "char", pred, next: -1 });
  return { start: s, outs: [{ state: s, slot: "next" }] };
}

function concatFrag(b: NfaBuilder, a: Frag, c: Frag): Frag {
  patch(b, a.outs, c.start);
  return { start: a.start, outs: c.outs };
}

function altFrag(b: NfaBuilder, frags: Frag[]): Frag {
  if (frags.length === 1) return frags[0]!;
  let acc = frags[0]!;
  for (let i = 1; i < frags.length; i++) {
    const s = addState(b, { t: "split", a: acc.start, b: frags[i]!.start });
    acc = { start: s, outs: [...acc.outs, ...frags[i]!.outs] };
  }
  return acc;
}

function buildNode(b: NfaBuilder, node: ReNode): Frag {
  if (node.t === "assert") {
    const s = addState(b, { t: "assert", kind: node.kind, next: -1 });
    return { start: s, outs: [{ state: s, slot: "next" }] };
  }
  if (node.t === "group") return buildNode(b, node.inner);
  if (node.t === "alt") {
    const branches = node.branches.map((seq) => buildSeq(b, seq));
    return altFrag(b, branches);
  }
  // Single-character atom with {min,max} quantifier expansion.
  const { pred, min, max } = node;
  let acc: Frag | null = null;
  for (let i = 0; i < min; i++) {
    const f = charFrag(b, pred);
    acc = acc ? concatFrag(b, acc, f) : f;
  }
  if (max === Infinity) {
    // min copies then a star loop.
    const split = addState(b, { t: "split", a: -1, b: -1 });
    const body = charFrag(b, pred);
    const st = b.states[split]!;
    if (st.t === "split") st.a = body.start;
    patch(b, body.outs, split);
    const loop: Frag = { start: split, outs: [{ state: split, slot: "b" }] };
    acc = acc ? concatFrag(b, acc, loop) : loop;
  } else {
    for (let i = min; i < max; i++) {
      if (b.overflow) break;
      const body = charFrag(b, pred);
      const split = addState(b, { t: "split", a: body.start, b: -1 });
      const opt: Frag = { start: split, outs: [...body.outs, { state: split, slot: "b" }] };
      acc = acc ? concatFrag(b, acc, opt) : opt;
    }
  }
  return acc ?? emptyFrag(b);
}

function buildSeq(b: NfaBuilder, seq: ReNode[]): Frag {
  if (seq.length === 0) return emptyFrag(b);
  let acc = buildNode(b, seq[0]!);
  for (let i = 1; i < seq.length; i++) acc = concatFrag(b, acc, buildNode(b, seq[i]!));
  return acc;
}

export function compileEvidencePattern(pattern: string): PatternParseResult {
  if (typeof pattern !== "string" || pattern.length === 0) return { ok: false, rule: "pattern-empty" };
  if (pattern.length > PATTERN_MAX_LENGTH) return { ok: false, rule: "pattern-too-long" };
  const p: PatternParser = { src: pattern, pos: 0, quantifiers: 0, rule: null };
  const ast = parseAlternation(p, 0);
  if (ast === null) return { ok: false, rule: p.rule ?? "pattern-invalid" };
  if (p.pos !== pattern.length) return { ok: false, rule: p.rule ?? "unbalanced-group" };
  const b: NfaBuilder = { states: [], overflow: false };
  const frag = buildNode(b, ast);
  const accept = addState(b, { t: "accept" });
  patch(b, frag.outs, accept);
  if (b.overflow) return { ok: false, rule: "nfa-too-large" };
  return { ok: true, nfa: { states: b.states, start: frag.start } };
}

/**
 * Non-backtracking NFA simulation (§3.3.1 part 2): does the pattern match any
 * substring of `line`? Hard O(|states| x |line|) — the state set is advanced
 * once per position, with the start state injected at every offset.
 */
export function patternMatchesLine(nfa: CompiledPattern, line: string): boolean {
  const n = nfa.states.length;
  let current: boolean[] = new Array(n).fill(false);
  const closure = (set: boolean[], state: number, pos: number): boolean => {
    // Iterative worklist epsilon-closure evaluating assertions at `pos`.
    const stack = [state];
    let accepted = false;
    while (stack.length > 0) {
      const s = stack.pop()!;
      if (set[s]) continue;
      const st = nfa.states[s]!;
      if (st.t === "accept") { set[s] = true; accepted = true; continue; }
      if (st.t === "char") { set[s] = true; continue; }
      set[s] = true;
      if (st.t === "split") {
        stack.push(st.a, st.b);
      } else {
        const prev = pos > 0 ? line[pos - 1] : undefined;
        const next = pos < line.length ? line[pos] : undefined;
        const holds =
          st.kind === "bol" ? pos === 0 :
          st.kind === "eol" ? pos === line.length :
          st.kind === "wb" ? isWordChar(prev) !== isWordChar(next) :
          isWordChar(prev) === isWordChar(next);
        if (holds) stack.push(st.next);
      }
    }
    return accepted;
  };
  for (let i = 0; i <= line.length; i++) {
    if (closure(current, nfa.start, i)) return true;
    // Re-run closure for states already marked but whose assertions were added
    // earlier: marking is monotone per position, so a single injection pass per
    // position is sufficient — char states carry over below.
    if (i === line.length) break;
    const ch = line[i]!;
    const next: boolean[] = new Array(n).fill(false);
    let any = false;
    for (let s = 0; s < n; s++) {
      if (!current[s]) continue;
      const st = nfa.states[s]!;
      if (st.t === "char" && st.pred(ch)) {
        if (closure(next, st.next, i + 1)) return true;
        any = true;
      }
    }
    if (!any) {
      // No surviving states; continue with a fresh set (start re-injected next
      // iteration).
      current = new Array(n).fill(false);
    } else {
      current = next;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Path shape and prefix admission (§4.0, §4.1)
// ---------------------------------------------------------------------------

interface PathDenial { reason: EvidenceDenialReason; detail?: string }

/**
 * §4.1 shape gate applied to a repo-relative operand. Returns the normalized
 * repo-relative path ("" for the root scope) or a denial.
 */
export function normalizeEvidencePath(path: string): { ok: true; rel: string } | ({ ok: false } & PathDenial) {
  if (typeof path !== "string" || path.length === 0) return { ok: false, reason: "invalid-query", detail: "path-empty" };
  if (path.length > PATH_MAX_LENGTH) return { ok: false, reason: "invalid-query", detail: "path-too-long" };
  if (path.includes("\0")) return { ok: false, reason: "invalid-query", detail: "path-nul" };
  if (path.startsWith("/")) return { ok: false, reason: "absolute-path" };
  if (/^[A-Za-z]:[/\\]/.test(path) || path.startsWith("\\\\")) return { ok: false, reason: "absolute-path" };
  // Normalize on the resolved segments so a traversal segment that normalizes
  // away must not become admissible (§4.1 rule 3).
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return { ok: false, reason: "outside-root" };
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return { ok: true, rel: out.join("/") };
}

/** Directory-prefix admission for list/search (§4.0): the root scope is always
 * admitted; a non-root prefix needs at least one strict indexed descendant. */
function resolveListScope(
  path: string | undefined,
  snapshotPaths: string[],
): { ok: true; prefix: string } | ({ ok: false } & PathDenial) {
  if (path === undefined) return { ok: true, prefix: "" };
  const norm = normalizeEvidencePath(path);
  if (!norm.ok) return norm;
  if (norm.rel === "") return { ok: true, prefix: "" };
  const prefix = norm.rel + "/";
  for (const p of snapshotPaths) {
    if (p.length > prefix.length && p.startsWith(prefix)) return { ok: true, prefix };
  }
  return { ok: false, reason: "not-tracked" };
}

// ---------------------------------------------------------------------------
// Redaction (§4.8)
// ---------------------------------------------------------------------------

function redactContent(text: string, rootRealPath: string): { text: string; redacted: boolean } {
  let out = redactTokens(text);
  if (rootRealPath) {
    out = out.split(rootRealPath + "/").join("<repo-root>/").split(rootRealPath).join("<repo-root>");
  }
  return { text: out, redacted: out !== text };
}

// ---------------------------------------------------------------------------
// Bounded file reading (§3.2, §4.3–§4.5)
// ---------------------------------------------------------------------------

const READ_CHUNK = 65_536;

interface OpenedFile {
  fd: number;
  size: number;
}

type OpenOutcome = { ok: true; file: OpenedFile } | ({ ok: false } & PathDenial);

/** §4.3 steps 2–5 + §4.4, against an arbitrary anchor (evidence root, or the
 * artifact dir for the issue-body source). The caller must close the fd. */
function openVerified(fa: FileAccess, anchor: RootAnchor, relPath: string): OpenOutcome {
  const comp = fa.lstatComponents(anchor, relPath);
  if (comp === "symlink") return { ok: false, reason: "symlink-rejected" };
  if (comp === "missing") return { ok: false, reason: "not-found" };
  if (comp === "error") return { ok: false, reason: "resolver-error", detail: "lstat" };
  const opened = fa.openRead(anchor, relPath);
  if (!("fd" in opened)) {
    if (opened.errorClass === "ELOOP" || opened.errorClass === "ENOTDIR") {
      return { ok: false, reason: "symlink-rejected" };
    }
    if (opened.errorClass === "ENOENT") return { ok: false, reason: "not-found" };
    if (opened.errorClass === "EISDIR" || opened.errorClass === "ENXIO") {
      return { ok: false, reason: "not-regular-file" };
    }
    return { ok: false, reason: "resolver-error", detail: opened.errorClass };
  }
  const fd = opened.fd;
  try {
    const st = fa.fstatFd(fd);
    if (!st.isFile) {
      fa.close(fd);
      return { ok: false, reason: "not-regular-file" };
    }
    if (!fa.verifyChain(anchor, relPath, st.dev, st.ino)) {
      fa.close(fd);
      return { ok: false, reason: "symlink-rejected" };
    }
    return { ok: true, file: { fd, size: st.size } };
  } catch {
    fa.close(fd);
    return { ok: false, reason: "resolver-error", detail: "fstat" };
  }
}

interface WindowRead {
  binary: boolean;
  sniff: Buffer;
  content: string;
  firstLine: number | null;
  lastLine: number | null;
  totalLines: number | null;
  totalLinesExact: boolean;
  truncated: boolean;
}

/**
 * Forward traversal through a fixed-size buffer (§3.2): stops at the first of
 * end of window, READ_MAX_LINES emitted, READ_MAX_BYTES emitted,
 * READ_SCAN_MAX_BYTES traversed, or EOF. Memory is the buffer, never the file.
 */
function readWindowBounded(
  fa: FileAccess,
  file: OpenedFile,
  startLine: number,
  endLine: number,
): WindowRead {
  const buf = Buffer.alloc(READ_CHUNK);
  const emitted: Buffer[] = [];
  let emittedBytes = 0;
  let traversed = 0;
  let line = 1;
  let newlines = 0;
  let lastByteWasNewline = true; // empty file => 0 lines
  let firstLine: number | null = null;
  let lastLine: number | null = null;
  let emittedLines = 0;
  let lineHasEmitted = false;
  let truncated = false;
  let reachedEof = false;
  let pos = 0;
  let sniff: Buffer = Buffer.alloc(0);
  let sniffDone = false;
  let binary = false;

  outer: for (;;) {
    const n = fa.readAt(file.fd, buf, pos);
    if (n <= 0) { reachedEof = true; break; }
    pos += n;
    if (!sniffDone) {
      const take = Math.min(n, BINARY_SNIFF_BYTES - sniff.length);
      sniff = Buffer.concat([sniff, buf.subarray(0, take)]);
      if (sniff.length >= BINARY_SNIFF_BYTES || n < buf.length) sniffDone = true;
      if (sniff.includes(0)) { binary = true; break; }
    }
    for (let i = 0; i < n; i++) {
      if (traversed >= READ_SCAN_MAX_BYTES) { truncated = true; break outer; }
      traversed++;
      const b = buf[i]!;
      const inWindow = line >= startLine && line <= endLine;
      if (inWindow) {
        if (!lineHasEmitted) {
          if (emittedLines >= READ_MAX_LINES) { truncated = true; break outer; }
          emittedLines++;
          lineHasEmitted = true;
          if (firstLine === null) firstLine = line;
          lastLine = line;
        }
        if (emittedBytes >= READ_MAX_BYTES) { truncated = true; break outer; }
        emitted.push(Buffer.from([b]));
        emittedBytes++;
      }
      if (b === 0x0a) {
        newlines++;
        line++;
        lineHasEmitted = false;
        lastByteWasNewline = true;
        if (line > endLine) {
          // End of the requested window: a full window served is a success, but
          // an exact totalLines was not paid for (§3.2).
          break outer;
        }
      } else {
        lastByteWasNewline = false;
      }
    }
  }

  // On sniff-detected binary the sniff may be incomplete for small reads; the
  // remaining sniff bytes are read below by the caller through digestSniff.
  if (binary) {
    // Complete the sniff window (bounded by BINARY_SNIFF_BYTES, §4.5) so the
    // prefix digest covers exactly min(BINARY_SNIFF_BYTES, size) bytes.
    while (sniff.length < Math.min(BINARY_SNIFF_BYTES, file.size)) {
      const n = fa.readAt(file.fd, buf, sniff.length);
      if (n <= 0) break;
      sniff = Buffer.concat([sniff, buf.subarray(0, Math.min(n, BINARY_SNIFF_BYTES - sniff.length))]);
    }
    return { binary: true, sniff, content: "", firstLine: null, lastLine: null, totalLines: null, totalLinesExact: false, truncated: false };
  }

  const totalLines = reachedEof ? (lastByteWasNewline ? newlines : newlines + 1) : null;
  return {
    binary: false,
    sniff,
    content: Buffer.concat(emitted).toString("utf8"),
    firstLine,
    lastLine,
    totalLines,
    totalLinesExact: reachedEof,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Budget pre-checks (§5): checked before resolving each query.
// ---------------------------------------------------------------------------

function budgetExhausted(deps: EvidenceResolverDeps): boolean {
  const b = deps.budget;
  const now = deps.now();
  return (
    b.queriesRun >= MAX_QUERIES_PER_RUN
    || b.bytesServedRun >= EVIDENCE_BYTES_PER_RUN
    || now - b.runStartedAt >= EVIDENCE_RUN_MS
    || now - b.turnStartedAt >= EVIDENCE_TURN_MS
  );
}

// ---------------------------------------------------------------------------
// Per-operation resolution
// ---------------------------------------------------------------------------

function resolveList(q: ListQuery, deps: EvidenceResolverDeps): EvidenceResult {
  const snapshot = deps.snapshot.list();
  const scope = resolveListScope(q.path, snapshot);
  if (!scope.ok) return { id: q.id, op: "list", status: "denied", reason: scope.reason, ...(scope.detail ? { detail: scope.detail } : {}) };
  let globSegs: string[] | null = null;
  if (q.glob !== undefined) {
    const parsed = parseEvidenceGlob(q.glob);
    if (!parsed.ok) return { id: q.id, op: "list", status: "denied", reason: "glob-rejected", detail: parsed.rule };
    globSegs = parsed.segments;
  }
  const deny = compileOperatorGlobs([...DEFAULT_DENY_GLOBS, ...(deps.denyGlobs ?? [])]);
  const generated = compileOperatorGlobs(deps.generatedGlobs ?? []);
  const max = Math.min(Math.max(1, q.maxResults ?? LIST_MAX_PATHS), LIST_MAX_PATHS);
  const sorted = [...snapshot].sort();
  const paths: string[] = [];
  let excludedGenerated = 0, excludedSensitive = 0, excludedSymlink = 0;
  let truncated = false;
  for (const p of sorted) {
    if (scope.prefix && !(p.length > scope.prefix.length && p.startsWith(scope.prefix))) continue;
    if (globSegs && !matchEvidenceGlob(globSegs, p)) continue;
    if (matchesAnyOperatorGlob(deny, p)) { excludedSensitive++; continue; }
    if (!q.includeGenerated && matchesAnyOperatorGlob(generated, p)) { excludedGenerated++; continue; }
    if (paths.length >= max) { truncated = true; break; }
    // Symlinks are omitted (§4.3.8), counted never named.
    const comp = deps.fileAccess.lstatComponents(deps.anchor, p);
    if (comp === "symlink") { excludedSymlink++; continue; }
    if (comp === "missing" || comp === "error") continue;
    paths.push(p);
  }
  return {
    id: q.id, op: "list", status: "ok", paths, truncated,
    pathsExcludedGenerated: excludedGenerated,
    pathsExcludedSensitive: excludedSensitive,
    pathsExcludedSymlink: excludedSymlink,
  };
}

function resolveRead(q: ReadQuery, deps: EvidenceResolverDeps): EvidenceResult {
  const source = q.source ?? "repo";
  const startLine = q.startLine ?? 1;
  const endLine = q.endLine ?? startLine + READ_MAX_LINES - 1;
  if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(endLine) || endLine < startLine) {
    return { id: q.id, op: "read", status: "denied", reason: "invalid-query", detail: "line-range" };
  }

  if (source === "issue-body") {
    // §4.0 issue-body dispatch: the readable object is exactly one
    // runner-written artifact; the repo path gate never runs.
    if (q.path !== undefined && q.path !== ISSUE_BODY_PATH_LITERAL) {
      return { id: q.id, op: "read", status: "denied", reason: "invalid-query", detail: "issue-body-path" };
    }
    if (!deps.issueBody) {
      return { id: q.id, op: "read", status: "denied", reason: "not-found" };
    }
    let bodyAnchor: RootAnchor;
    try {
      bodyAnchor = deps.fileAccess.resolveRoot(deps.issueBody.artifactDir);
    } catch {
      return { id: q.id, op: "read", status: "denied", reason: "resolver-error", detail: "artifact-root" };
    }
    return readVerified(q, deps, bodyAnchor, ISSUE_BODY_ARTIFACT, "issue-body", "artifact", startLine, endLine);
  }

  if (q.path === undefined) {
    return { id: q.id, op: "read", status: "denied", reason: "invalid-query", detail: "path-required" };
  }
  const norm = normalizeEvidencePath(q.path);
  if (!norm.ok) return { id: q.id, op: "read", status: "denied", reason: norm.reason, ...(norm.detail ? { detail: norm.detail } : {}) };
  // §4.1 rule 4: on a read, a root-equivalent path reaches the tracked-set
  // check and fails it — a directory is never a member of the tracked set.
  const snapshot = deps.snapshot.list();
  if (norm.rel === "" || !snapshot.includes(norm.rel)) {
    return { id: q.id, op: "read", status: "denied", reason: "not-tracked" };
  }
  const deny = compileOperatorGlobs([...DEFAULT_DENY_GLOBS, ...(deps.denyGlobs ?? [])]);
  if (matchesAnyOperatorGlob(deny, norm.rel)) {
    return { id: q.id, op: "read", status: "denied", reason: "denied-sensitive" };
  }
  return readVerified(q, deps, deps.anchor, norm.rel, "repo", "worktree", startLine, endLine);
}

function readVerified(
  q: ReadQuery,
  deps: EvidenceResolverDeps,
  anchor: RootAnchor,
  relPath: string,
  source: "repo" | "issue-body",
  contentSource: "worktree" | "artifact",
  startLine: number,
  endLine: number,
): EvidenceResult {
  const opened = openVerified(deps.fileAccess, anchor, relPath);
  if (!opened.ok) {
    return { id: q.id, op: "read", status: "denied", reason: opened.reason, ...(opened.detail ? { detail: opened.detail } : {}) };
  }
  try {
    const win = readWindowBounded(deps.fileAccess, opened.file, startLine, endLine);
    if (win.binary) {
      // §4.5: bounded prefix digest over exactly the sniff bytes — never a
      // whole-file hash, never any content.
      const digestBytes = Math.min(BINARY_SNIFF_BYTES, opened.file.size);
      const digest = createHash("sha256").update(win.sniff.subarray(0, digestBytes)).digest("hex");
      return {
        id: q.id, op: "read", status: "denied", reason: "binary",
        totalBytes: opened.file.size,
        digestAlgorithm: "sha256-prefix",
        digestBytes,
        digestPrefixSha256: digest,
      };
    }
    const red = redactContent(win.content, deps.anchor.realPath);
    return {
      id: q.id, op: "read", status: "ok", source, contentSource, scope: "tracked-worktree",
      ...(source === "repo" ? { path: relPath } : {}),
      content: red.text,
      firstLine: win.firstLine,
      lastLine: win.lastLine,
      totalBytes: opened.file.size,
      totalLines: win.totalLines,
      totalLinesExact: win.totalLinesExact,
      truncated: win.truncated,
      redacted: red.redacted,
    };
  } finally {
    deps.fileAccess.close(opened.file.fd);
  }
}

function resolveSearch(q: SearchQuery, deps: EvidenceResolverDeps): EvidenceResult {
  if (typeof q.pattern !== "string" || q.pattern.length === 0) {
    return { id: q.id, op: "search", status: "denied", reason: "invalid-query", detail: "pattern-required" };
  }
  if (q.pattern.length > PATTERN_MAX_LENGTH) {
    return { id: q.id, op: "search", status: "denied", reason: "pattern-rejected", detail: "pattern-too-long" };
  }
  const kind = q.kind ?? "fixed";
  let nfa: CompiledPattern | null = null;
  if (kind === "regex") {
    // `ignoreCase` folds the pattern against line content (§3.4 rule 6): both
    // sides are lowercased, so the fold is applied at compile time too.
    const compiled = compileEvidencePattern(q.ignoreCase ? q.pattern.toLowerCase() : q.pattern);
    if (!compiled.ok) {
      // Never downgraded to a fixed-string search (§3.3.1).
      return { id: q.id, op: "search", status: "denied", reason: "pattern-rejected", detail: compiled.rule };
    }
    nfa = compiled.nfa;
  }
  const snapshot = deps.snapshot.list();
  const scope = resolveListScope(q.path, snapshot);
  if (!scope.ok) return { id: q.id, op: "search", status: "denied", reason: scope.reason, ...(scope.detail ? { detail: scope.detail } : {}) };
  let globSegs: string[] | null = null;
  if (q.glob !== undefined) {
    const parsed = parseEvidenceGlob(q.glob);
    if (!parsed.ok) return { id: q.id, op: "search", status: "denied", reason: "glob-rejected", detail: parsed.rule };
    globSegs = parsed.segments;
  }
  const deny = compileOperatorGlobs([...DEFAULT_DENY_GLOBS, ...(deps.denyGlobs ?? [])]);
  const generated = compileOperatorGlobs(deps.generatedGlobs ?? []);
  const maxMatches = Math.min(Math.max(1, q.maxMatches ?? SEARCH_MAX_MATCHES), SEARCH_MAX_MATCHES);
  const needle = q.ignoreCase ? q.pattern.toLowerCase() : q.pattern;

  const matches: EvidenceSearchMatch[] = [];
  let filesScanned = 0, skippedBinary = 0, skippedTooLarge = 0;
  let excludedGenerated = 0, excludedSensitive = 0;
  let truncated = false;
  let redacted = false;
  const buf = Buffer.alloc(READ_CHUNK);

  const sorted = [...snapshot].sort();
  for (const p of sorted) {
    // Turn/run wall-clock budgets are checked between files, where the
    // resolver is genuinely interruptible (§3.3.1, §5).
    if (deps.now() - deps.budget.turnStartedAt >= EVIDENCE_TURN_MS
      || deps.now() - deps.budget.runStartedAt >= EVIDENCE_RUN_MS) { truncated = true; break; }
    if (scope.prefix && !(p.length > scope.prefix.length && p.startsWith(scope.prefix))) continue;
    if (globSegs && !matchEvidenceGlob(globSegs, p)) continue;
    if (matchesAnyOperatorGlob(deny, p)) { excludedSensitive++; continue; }
    if (!q.includeGenerated && matchesAnyOperatorGlob(generated, p)) { excludedGenerated++; continue; }
    if (filesScanned >= SEARCH_MAX_FILES_SCANNED) { truncated = true; break; }

    const opened = openVerified(deps.fileAccess, deps.anchor, p);
    if (!opened.ok) {
      // Every open in search is subject to the same gates (§4.3 step 5): a
      // symlink or vanished file is skipped, never served and never named.
      continue;
    }
    try {
      if (opened.file.size > FILE_MAX_BYTES_SCANNED) { skippedTooLarge++; continue; }
      filesScanned++;
      // Read the (bounded, <= FILE_MAX_BYTES_SCANNED) file through the chunk
      // buffer and scan line by line.
      let content = Buffer.alloc(0);
      let pos = 0;
      for (;;) {
        const n = deps.fileAccess.readAt(opened.file.fd, buf, pos);
        if (n <= 0) break;
        pos += n;
        content = Buffer.concat([content, buf.subarray(0, n)]);
        if (content.length >= BINARY_SNIFF_BYTES && content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) break;
      }
      if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) { skippedBinary++; filesScanned--; continue; }
      const lines = content.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= maxMatches) { truncated = true; break; }
        let text = lines[i]!;
        if (text.endsWith("\r")) text = text.slice(0, -1);
        const hay = q.ignoreCase ? text.toLowerCase() : text;
        const hit = nfa
          ? patternMatchesLine(nfa, q.ignoreCase ? text.toLowerCase() : text)
          : hay.includes(needle);
        if (!hit) continue;
        const clamped = text.length > SEARCH_MATCH_LINE_MAX ? text.slice(0, SEARCH_MATCH_LINE_MAX) : text;
        const red = redactContent(clamped, deps.anchor.realPath);
        if (red.redacted) redacted = true;
        matches.push({ path: p, line: i + 1, text: red.text });
      }
      if (matches.length >= maxMatches && truncated) break;
    } finally {
      deps.fileAccess.close(opened.file.fd);
    }
  }
  return {
    id: q.id, op: "search", status: "ok", matches,
    filesScanned,
    filesSkippedBinary: skippedBinary,
    filesSkippedTooLarge: skippedTooLarge,
    filesExcludedGenerated: excludedGenerated,
    filesExcludedSensitive: excludedSensitive,
    truncated,
    redacted,
  };
}

// ---------------------------------------------------------------------------
// Turn resolution
// ---------------------------------------------------------------------------

/** A request entry as produced by the protocol layer: either a validated query
 * or a pre-resolution rejection carrying only fixed-form detail. */
export type EvidenceRequestEntry =
  | { kind: "query"; query: EvidenceQuery }
  | { kind: "invalid"; id: string | null; op: string | null; reason: "invalid-query" | "unsupported-op"; detail: string };

/**
 * Resolve one turn's admitted entries in request order. Budgets are checked
 * before each query (§5): a query past a spent budget is `budget-exhausted`,
 * earlier queries keep their results. `bytesServedRun` is read here but never
 * written: the run byte budget counts rendered payload (§5), so the caller
 * charges it after rendering the section this turn's results end up in.
 */
export function resolveEvidenceTurn(
  entries: EvidenceRequestEntry[],
  deps: EvidenceResolverDeps,
): EvidenceResult[] {
  const results: EvidenceResult[] = [];
  for (const entry of entries) {
    if (entry.kind === "invalid") {
      results.push({
        id: entry.id ?? "<invalid>",
        op: entry.op ?? "<invalid>",
        status: "denied",
        reason: entry.reason,
        detail: entry.detail,
      });
      continue;
    }
    const q = entry.query;
    // §4.3 step 1: every query in the turn is checked against the recorded
    // root identity. A root moved or replaced after the anchor was created
    // aborts the whole turn as `evidence/unavailable` (§7.2) — resolving
    // further would pair the snapshot's path list with another directory.
    if (!deps.fileAccess.verifyRoot(deps.anchor)) {
      throw new EvidenceSnapshotError("snapshot-failed", 0, 0);
    }
    if (budgetExhausted(deps)) {
      results.push({ id: q.id, op: q.op, status: "denied", reason: "budget-exhausted" });
      continue;
    }
    deps.budget.queriesRun++;
    let result: EvidenceResult;
    try {
      result = q.op === "list" ? resolveList(q, deps)
        : q.op === "read" ? resolveRead(q, deps)
        : resolveSearch(q, deps);
    } catch (err) {
      if (err instanceof EvidenceSnapshotError) throw err;
      const cls = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
      // Error CLASS only — a raw message can embed an absolute path (§7.1).
      result = { id: q.id, op: q.op, status: "denied", reason: "resolver-error", detail: String(cls) };
    }
    results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Sanitized request record (§9.1): the ONLY producer of a storable request
// record, so a raw request (with its absolute paths, traversals, or
// token-shaped patterns) can never reach a turn artifact by another route.
// ---------------------------------------------------------------------------

export interface SanitizedFieldRecord {
  length: number;
  sha256: string;
  unsafeToSerialize?: true;
}

export type SanitizedField = string | SanitizedFieldRecord;

export interface SanitizedQueryRecord {
  id: string;
  op: string;
  verdict: string;
  detail?: string;
  source?: string;
  kind?: string;
  path?: SanitizedField;
  glob?: SanitizedField;
  pattern?: SanitizedField;
}

function hashRecord(value: string): SanitizedFieldRecord {
  return { length: value.length, sha256: createHash("sha256").update(value, "utf8").digest("hex") };
}

/**
 * The field-level serialization gate (§9.1): a free-text value may be written
 * verbatim only when it is length-bounded, control-byte-free, not
 * absolute-path-shaped, traversal-free, contains no run-local root path, and
 * is unchanged by redactTokens. Independent of the query's verdict.
 */
export function safeToSerialize(value: string, maxLength: number, localRoots: string[]): boolean {
  if (value.length > maxLength) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith("/")) return false;
  if (/^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\")) return false;
  if (value.split("/").includes("..") || value.split("\\").includes("..")) return false;
  const lower = value.toLowerCase();
  for (const root of localRoots) {
    if (root && lower.includes(root.toLowerCase())) return false;
  }
  if (redactTokens(value) !== value) return false;
  return true;
}

export function sanitizeRequestRecord(
  entries: EvidenceRequestEntry[],
  results: EvidenceResult[],
  localRoots: string[],
): SanitizedQueryRecord[] {
  const records: SanitizedQueryRecord[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const result = results[i];
    if (entry.kind === "invalid") {
      records.push({
        id: entry.id !== null && entry.id.length <= QUERY_ID_MAX_LENGTH ? entry.id : "<invalid>",
        op: entry.op ?? "<invalid>",
        verdict: entry.reason,
        detail: entry.detail,
      });
      continue;
    }
    const q = entry.query;
    const denied = result !== undefined && result.status === "denied";
    const verdict = denied ? (result as EvidenceDenialResult).reason : "ok";
    const detail = denied ? (result as EvidenceDenialResult).detail : undefined;
    const record: SanitizedQueryRecord = { id: q.id, op: q.op, verdict, ...(detail ? { detail } : {}) };
    if (q.op === "read" && q.source !== undefined) record.source = q.source;
    if (q.op === "search" && q.kind !== undefined) record.kind = q.kind;
    const field = (value: string, admitted: boolean, maxLength: number): SanitizedField => {
      // Two gates (§9.1): the verdict decides entitlement, the serialization
      // gate decides safety — a denied value is never stored verbatim, and an
      // admitted one still has to pass the gate.
      if (!admitted) return hashRecord(value);
      if (!safeToSerialize(value, maxLength, localRoots)) {
        return { ...hashRecord(value), unsafeToSerialize: true };
      }
      return value;
    };
    if ("path" in q && q.path !== undefined) record.path = field(q.path, !denied, PATH_MAX_LENGTH);
    if ("glob" in q && q.glob !== undefined) record.glob = field(q.glob, !denied, GLOB_MAX_LENGTH);
    if (q.op === "search") record.pattern = field(q.pattern, !denied, PATTERN_MAX_LENGTH);
    records.push(record);
  }
  return records;
}
