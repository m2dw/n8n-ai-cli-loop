/**
 * Structural tests for docs/research-evidence-contract.md (issue #805).
 *
 * The document is the authoritative security boundary for the follow-up
 * read-only research evidence implementation, so these tests pin the claims an
 * implementer or reviewer must not have to rediscover: the single chosen
 * mechanism, the supported operations, the admission policy, the bounds, the
 * prohibitions, the failure vocabulary, the public/local split, and the
 * rejected alternatives.
 *
 * They are structural only — no runtime behavior is asserted here, even
 * though the resolver this contract specifies is now implemented (issue
 * #806), default-off behind `session.research.evidence.enabled`.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Assertions run against a whitespace-normalized copy: the documents are
// hard-wrapped prose, so a claim can straddle a line break today and be
// reflowed tomorrow. Normalizing means these tests pin what the document says,
// not how it happens to be wrapped.
function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8').replace(/\s+/g, ' ');
}

const doc = read('docs/research-evidence-contract.md');
const phaseContracts = read('docs/phase-contracts.md');

// ---------------------------------------------------------------------------
// One resolved mechanism
// ---------------------------------------------------------------------------

describe('docs/research-evidence-contract.md — single chosen mechanism', () => {
  test('is marked as an approved design, implemented default-off', () => {
    expect(doc).toMatch(/approved design, implemented \(issue #806\), default-off/i);
    expect(doc).toMatch(/session\.research\.evidence\.enabled.*default `false`/);
  });

  test('names the runner-owned in-process resolver as the mechanism', () => {
    expect(doc).toMatch(/Repository Evidence Resolver/);
    expect(doc).toMatch(/runner-owned/i);
    expect(doc).toMatch(/in-process/i);
  });

  test('names the evidence transport as the provider-specific part', () => {
    expect(doc).toMatch(/Evidence Transport/);
    expect(doc).toMatch(/The resolver is the security boundary\. The transport is a wire format/);
  });

  test('states the enforcement point is the runner, not the agent CLI', () => {
    expect(doc).toMatch(/enforcement point is the runner, not the agent CLI/i);
  });

  test('states the invariant that the agent gains no new capability', () => {
    expect(doc).toMatch(/no[\s>]+capability it did not have before/i);
  });

  test('defines the evidence root as the worktree or session.repoRoot', () => {
    expect(doc).toMatch(/evidence root/i);
    expect(doc).toMatch(/per-issue worktree path.*otherwise[\s\S]{0,40}session\.repoRoot/i);
  });
});

// ---------------------------------------------------------------------------
// Supported operations
// ---------------------------------------------------------------------------

describe('docs/research-evidence-contract.md — supported operations', () => {
  test('supports exactly three operations: list, read, search', () => {
    expect(doc).toMatch(/Exactly three\./);
    expect(doc).toMatch(/`list` — enumerate paths/);
    expect(doc).toMatch(/`read` — bounded file content/);
    expect(doc).toMatch(/`search` — bounded text search/);
  });

  test('list enumerates tracked repo-relative paths', () => {
    expect(doc).toMatch(/repo-relative paths from the tracked-file snapshot/i);
  });

  test('read is bounded by lines and bytes and reports truncation', () => {
    expect(doc).toMatch(/READ_MAX_LINES/);
    expect(doc).toMatch(/READ_MAX_BYTES/);
    expect(doc).toMatch(/truncated/);
  });

  test('reaching a bound is not a denial', () => {
    expect(doc).toMatch(/Reaching a bound is \*\*not\*\* a denial/);
  });

  test('search is in-process and never shells out to rg or grep', () => {
    expect(doc).toMatch(/`search` MUST NOT shell out to `rg`, `grep`/);
    expect(doc).toMatch(/scans the snapshot in-process/i);
  });

  test('regex is a restricted safe subset and is never downgraded silently', () => {
    expect(doc).toMatch(/Quantifying a group is rejected outright/);
    expect(doc).toMatch(/never downgraded to a fixed-string search/i);
  });

  // An exclusion list (no lookaround, no backreferences) does not bound match
  // time: `^(a+)+$` passes every such list and is exponential in a backtracking
  // engine. The resolver is synchronous, so no wall-clock budget can interrupt
  // a match already running — the bound has to come from the grammar and the
  // matcher, and both halves must stay in the document.
  test('bounds regex match time by grammar rather than by an exclusion list', () => {
    expect(doc).toMatch(/#### 3\.3\.1 The regex subset \(normative\)/);
    expect(doc).toMatch(/\^\(a\+\)\+\$/);
    expect(doc).toMatch(/an exclusion list[\s\S]{0,60}is not sufficient/i);
    expect(doc).toMatch(/A quantifier may only bind a single-character atom/);
    expect(doc).toMatch(/REGEX_MAX_REPEAT/);
    expect(doc).toMatch(/REGEX_MAX_QUANTIFIERS/);
    expect(doc).toMatch(/REGEX_NFA_MAX_STATES/);
  });

  test('requires a non-backtracking matcher and forbids RegExp on agent text', () => {
    expect(doc).toMatch(/non-backtracking NFA simulation/);
    expect(doc).toMatch(/MUST NOT construct a JavaScript `RegExp` from\s+agent-supplied text/);
    expect(doc).toMatch(/O\(\|pattern\| x \|line\|\)/);
  });

  // A bounded read may not pay for a result field with an unbounded scan: an
  // exact totalLines on a 2 GiB file would contradict the §5 read bound and
  // hold the phase lock for the length of the scan.
  test('never buys an exact totalLines with an unbounded whole-file scan', () => {
    expect(doc).toMatch(/`totalLines` is \*\*not\*\* free/);
    expect(doc).toMatch(/READ_SCAN_MAX_BYTES/);
    expect(doc).toMatch(/`totalLines` is exact only when the traversal reached end of file/);
    expect(doc).toMatch(/`totalLines: null` and\s+`totalLinesExact: false`/);
    expect(doc).toMatch(/MUST NOT continue reading past `READ_SCAN_MAX_BYTES`/);
    expect(doc).toMatch(/deliberately \*\*no\*\* "count the lines"\s+operation/);
    expect(doc).toMatch(/No result field may be paid for with an unbounded\s+scan/);
  });

  // `glob` is agent-controlled on both bulk operations. A length cap bounds its
  // size but neither its match cost (a glob translated to a RegExp backtracks
  // like the patterns §3.3.1 excludes) nor its shape (an unconstrained glob may
  // be absolute or traversing, which §9.1 then cannot record). Both halves —
  // closed grammar and bounded non-RegExp matcher — must stay in the document.
  test('defines a closed glob subset with a bounded matcher, not just a length cap', () => {
    expect(doc).toMatch(/### 3\.4 The glob subset \(normative\)/);
    expect(doc).toMatch(/`GLOB_MAX_LENGTH`\s+alone is not a bound on \*\*cost\*\*/);
    expect(doc).toMatch(/GLOB_MAX_SEGMENTS/);
    expect(doc).toMatch(/GLOB_MAX_WILDCARDS/);
    expect(doc).toMatch(/GLOB_MAX_STARSTAR/);
    expect(doc).toMatch(/`\*\*` is meaningful \*\*only as a whole segment\*\*/);
    expect(doc).toMatch(/A glob is relative by construction/);
    expect(doc).toMatch(/Character classes, brace expansion, extglob, and negation do not exist in\s+this subset/);
    expect(doc).toMatch(/MUST NOT translate the glob into a JavaScript `RegExp`/);
    expect(doc).toMatch(/`minimatch` and its relatives compile to\s+`RegExp`/);
    expect(doc).toMatch(/`glob-rejected`/);
    expect(doc).toMatch(/A rejected glob is\s+never dropped so the query can run unfiltered/);
  });

  test('keeps glob matching case-sensitive and exact-bytes', () => {
    expect(doc).toMatch(/Matching is \*\*case-sensitive and exact-bytes\*\*/);
    expect(doc).toMatch(/it never\s+folds the glob against a path/);
  });

  test('exposes the issue-body source to close the #803 body-bound deferral', () => {
    expect(doc).toMatch(/`issue-body`/);
    expect(doc).toMatch(/research-issue-body\.md/);
    expect(doc).toMatch(/issue #803/);
    expect(doc).toMatch(/32,768/);
  });

  test('makes read path optional so the issue-body source is addressed by source', () => {
    expect(doc).toMatch(/REQUIRED when source is "repo"/);
    expect(doc).toMatch(/reserved literal "<issue-body>"/);
  });
});

// ---------------------------------------------------------------------------
// Admission policy
// ---------------------------------------------------------------------------

describe('docs/research-evidence-contract.md — admission policy', () => {
  test('dispatches on source before running the repo path gate', () => {
    expect(doc).toMatch(/### 4\.0 Source dispatch/);
    expect(doc).toMatch(/Admission is keyed on the query's `source` first/);
  });

  test('explains why an index-tracked gate cannot admit the issue-body artifact', () => {
    expect(doc).toMatch(/would deny every `issue-body`\s+request as `not-tracked`/);
    expect(doc).toMatch(/#803 paging deferral unimplementable as specified/);
  });

  test('defines a canonical issue-body address and its admission rule', () => {
    expect(doc).toMatch(/`path` MUST be omitted, or MUST be exactly the reserved\s+literal `<issue-body>`/);
    expect(doc).toMatch(/§4\.1 \(path shape\), §4\.2\s+\(tracked-worktree scope\), §4\.6 \(generated\) and §4\.7 \(deny globs\) do not apply/);
    expect(doc).toMatch(/joining the run artifact\s+directory with the constant basename\s+`research-issue-body\.md`/);
    expect(doc).toMatch(/No byte of the resolved path originates in the\s+query/);
    expect(doc).toMatch(/`bodyIncluded === false` implies\s+`not-found` for every `issue-body` read/);
    expect(doc).toMatch(/contentSource: "artifact"/);
  });

  test('keeps a repository file named like the reserved literal reachable only via source repo', () => {
    expect(doc).toMatch(/repository file literally named\s+`<issue-body>` is therefore unaffected/);
  });

  test('rejects a source field on list and search', () => {
    expect(doc).toMatch(/`list`\s+and `search` are always `repo`-sourced and have no `source` field at all/);
  });

  test('rejects absolute paths and traversal outside the evidence root', () => {
    expect(doc).toMatch(/`absolute-path`/);
    expect(doc).toMatch(/`outside-root`/);
    expect(doc).toMatch(/strict descendant of the evidence root/i);
  });

  test('requires path only for read, keeping root-scoped list and search admissible', () => {
    expect(doc).toMatch(/The `path` requirement is per operation/);
    expect(doc).toMatch(/On `read`, `path` names exactly one file and is REQUIRED/);
    expect(doc).toMatch(/On `list` and `search`, `path` is an OPTIONAL directory prefix/);
    expect(doc).toMatch(/A missing `path` is never\s+`invalid-query` for these two ops/);
  });

  test('admits the evidence root itself only for the directory-prefix operations', () => {
    expect(doc).toMatch(/neither a strict descendant of the evidence root nor\s+the evidence root itself/);
    expect(doc).toMatch(/`\.` and `\.\/` mean\s+the whole tracked snapshot/);
    expect(doc).toMatch(/a root-equivalent `path` reaches §4\.2 and is\s+`not-tracked`/);
    expect(doc).toMatch(/admitting the root is not admitting its parent/);
  });

  // A directory is never an entry in the git index, so running the candidate-file
  // membership check against a `list`/`search` prefix would make an ordinary
  // prefix such as `src` `not-tracked` — contradicting the operations that
  // advertise `path` as a directory prefix. The indexed-descendant rule is what
  // makes a non-root prefix implementable at all.
  test('admits a non-root directory prefix by its indexed descendants', () => {
    expect(doc).toMatch(/\*\*Directory prefixes on `list` and `search` \(normative\)\.\*\*/);
    expect(doc).toMatch(/Running §4\.2 against the prefix itself would deny every normal\s+prefix/);
    expect(doc).toMatch(/§4\.2's tracked-set membership check\s+MUST NOT be applied to a prefix/);
    expect(doc).toMatch(/at least one entry that is a strict\s+descendant\*\* of it/);
    expect(doc).toMatch(/never matches\s+`srcfoo\.ts`/);
    expect(doc).toMatch(/A prefix with zero indexed\s+descendants is `not-tracked`/);
    expect(doc).toMatch(/\*\*The root scope is exempt from rule 2\.\*\*/);
    expect(doc).toMatch(/A single trailing `\/` is accepted and normalized\s+away/);
  });

  test('runs the remaining gates per candidate rather than against the prefix', () => {
    expect(doc).toMatch(/\*\*The remaining gates run per candidate\.\*\*/);
    expect(doc).toMatch(/never against the\s+prefix as a surrogate for them/);
    expect(doc).toMatch(/an admitted query\s+with an empty result and non-zero exclusion counts, not a denial/);
  });

  test('never follows symlinks, checks every path component, and uses O_NOFOLLOW', () => {
    expect(doc).toMatch(/Symlinks are never followed and never read/);
    expect(doc).toMatch(/Each path component.*is\s+`lstat`-ed/is);
    expect(doc).toMatch(/O_RDONLY \| O_NOFOLLOW/);
    expect(doc).toMatch(/`fstat` the \*\*file descriptor\*\*/);
  });

  test('closes the interior-symlink-swap race with descriptor re-verification', () => {
    // The component pre-check must be explicitly non-authoritative: O_NOFOLLOW
    // only guards the leaf, so an interior directory swapped for a symlink
    // after the pre-check would otherwise escape the evidence root.
    expect(doc).toMatch(/A path-only\s+pre-check is \*\*not\*\* the boundary/i);
    expect(doc).toMatch(/MUST NOT treat a passing pre-check as permission to read/);
    expect(doc).toMatch(/re-verification before any byte is read/i);
    expect(doc).toMatch(/same `\(dev, ino\)` as\s+the step-4 `fstat`/);
    expect(doc).toMatch(/compared \*\*byte-for-byte\*\*/);
    expect(doc).toMatch(/Interior directory\*\* replaced by a symlink/i);
  });

  test('requires a non-blocking open so a FIFO cannot hang the phase', () => {
    expect(doc).toMatch(/O_RDONLY \| O_NOFOLLOW \| O_NOCTTY \| O_NONBLOCK/);
    expect(doc).toMatch(/Opening a FIFO `O_RDONLY` \*\*blocks until a writer connects\*\*/);
    expect(doc).toMatch(/MUST NOT\s+clear the flag before the type check/);
  });

  test('restricts evidence to index-tracked files via fixed-argv git plumbing', () => {
    expect(doc).toMatch(/git ls-files -z --cached/);
    expect(doc).toMatch(/fixed argv/);
    expect(doc).toMatch(/`shell: false`/);
    expect(doc).toMatch(/Untracked files, ignored files, and anything under `\.git\/` are therefore\s+invisible/);
  });

  test('names the scope tracked-worktree rather than committed-only', () => {
    // `git ls-files --cached` lists the index, so a staged-but-uncommitted file is
    // in the candidate set, and the read that follows serves worktree bytes. An
    // edit that restores the "committed content" wording would promise a boundary
    // the mechanism does not hold.
    expect(doc).toMatch(/### 4\.2 Tracked-worktree scope \(not committed-only\)/);
    expect(doc).toMatch(/\*\*The boundary is: paths listed in the git index,\s+bytes read from the current worktree\.\*\*/);
    expect(doc).toMatch(/\*\*`--cached` means tracked, not committed\.\*\*/);
    expect(doc).toMatch(/`git add`-ed but\s+never committed \*is\* in the index/);
    expect(doc).toMatch(/scope: "tracked-worktree"/);
    expect(doc).not.toMatch(/Committed content of the run's evidence root/);
  });

  test('argues the rejected committed tree/blob source and states the residual', () => {
    expect(doc).toMatch(/\*\*Why not a committed tree\/blob source\.\*\*/);
    expect(doc).toMatch(/git ls-tree -r -z --name-only\s+HEAD/);
    expect(doc).toMatch(/git cat-file blob/);
    expect(doc).toMatch(/\*\*Stated residual \(accepted\)\.\*\*/);
    expect(doc).toMatch(/tracked-but-uncommitted file whose path is\s+outside the deny floor/);
  });

  test('forbids a filesystem-walk fallback when the snapshot fails', () => {
    expect(doc).toMatch(/MUST NOT fall back to walking the filesystem/);
  });

  test('bounds the tracked-file snapshot while streaming, and fails rather than truncating', () => {
    // The snapshot is the one input the per-query limits cannot bound: the whole
    // index exists before LIST_MAX_PATHS or SEARCH_MAX_FILES_SCANNED apply. An
    // edit that drops these bounds reintroduces an unbounded capture holding the
    // issue worktree lock.
    expect(doc).toMatch(/SNAPSHOT_MAX_PATHS/);
    expect(doc).toMatch(/SNAPSHOT_MAX_BYTES/);
    expect(doc).toMatch(/SNAPSHOT_MS/);
    expect(doc).toMatch(/consumes the child's stdout \*\*incrementally\*\*/);
    expect(doc).toMatch(/MUST NOT accumulate the whole\s+output/);
    expect(doc).toMatch(/\*\*Overflow is a failure, not a truncation\.\*\*/);
    expect(doc).toMatch(/`snapshot-too-large`/);
    expect(doc).toMatch(/`snapshot-timeout`/);
    // A truncated snapshot would turn not-tracked into a false statement.
    expect(doc).toMatch(/would make `not-tracked`\s+a lie/);
    expect(doc).toMatch(/`SNAPSHOT_MS` is charged against `EVIDENCE_TURN_MS`/);
    // Overflow must reach the run-level unavailable outcome, not a partial serve.
    expect(doc).toMatch(/exceeded `SNAPSHOT_MAX_PATHS` \/ `SNAPSHOT_MAX_BYTES` \/ `SNAPSHOT_MS`/);
  });

  test('records whether content came from the worktree or the index', () => {
    expect(doc).toMatch(/contentSource: "worktree"/);
  });

  test('rejects non-regular files', () => {
    expect(doc).toMatch(/`not-regular-file`/);
    expect(doc).toMatch(/FIFO, socket, block or character device/i);
  });

  test('detects binary files by a bounded NUL sniff', () => {
    expect(doc).toMatch(/BINARY_SNIFF_BYTES/);
    expect(doc).toMatch(/NUL byte/);
    expect(doc).toMatch(/`binary`/);
  });

  test('returns a bounded, labelled prefix digest for a binary rather than a content hash', () => {
    // A whole-file hash would contradict the READ_SCAN_MAX_BYTES bound on a
    // multi-gigabyte binary; a window hash presented as a content hash would be
    // a false identity claim. The contract requires the bounded form, labelled.
    expect(doc).toMatch(/bounded prefix digest, never a content hash/);
    expect(doc).toMatch(/`digestAlgorithm` \| The literal `"sha256-prefix"`/);
    expect(doc).toMatch(/`digestBytes` \| `min\(BINARY_SNIFF_BYTES, totalBytes\)`/);
    expect(doc).toMatch(/digestPrefixSha256/);
    expect(doc).toMatch(/costs \*\*no additional traversal\*\*/);
    expect(doc).toMatch(/do \*\*not\*\* prove two files identical/);
    expect(doc).toMatch(/MUST NOT offer any\s+operation that digests a whole file/);
    // The digest is derived from file bytes, so it stays out of public text.
    expect(doc).toMatch(/including a binary's bounded\s+prefix digest/);
  });

  test('treats generated files as excluded from bulk results, not denied', () => {
    expect(doc).toMatch(/Generated files are \*\*not denied\*\*/);
    expect(doc).toMatch(/generatedGlobs/);
    expect(doc).toMatch(/includeGenerated/);
  });

  test('defines a non-overridable sensitive-path floor with additive operator globs', () => {
    expect(doc).toMatch(/DEFAULT_DENY_GLOBS \(floor, cannot be removed by config\)/);
    expect(doc).toMatch(/\*\*additive only\*\*/);
    expect(doc).toMatch(/\.env/);
    expect(doc).toMatch(/\*\*\/\*\.pem/);
    expect(doc).toMatch(/`denied-sensitive`/);
  });

  test('makes deny matching case-insensitive while membership stays exact-bytes', () => {
    expect(doc).toMatch(/Deny matching is \*\*case-insensitive\*\*/);
    expect(doc).toMatch(/membership stays exact-bytes/i);
  });

  test('never names denied paths in list/search output', () => {
    expect(doc).toMatch(/never named in `list`\/`search` output/);
    expect(doc).toMatch(/oracle for enumerating secret file names/i);
  });

  test('redacts token-shaped content and flags the redaction', () => {
    expect(doc).toMatch(/redactTokens/);
    expect(doc).toMatch(/src\/core\/text-sanitize\.ts/);
    expect(doc).toMatch(/`redacted: true`/);
  });
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

describe('docs/research-evidence-contract.md — bounds', () => {
  test('defines per-query bounds', () => {
    expect(doc).toMatch(/PATH_MAX_LENGTH/);
    expect(doc).toMatch(/PATTERN_MAX_LENGTH/);
  });

  test('defines per-file bounds', () => {
    expect(doc).toMatch(/READ_MAX_BYTES\` \| 65,536 bytes/);
    expect(doc).toMatch(/READ_MAX_LINES\` \| 1,000 lines/);
    expect(doc).toMatch(/READ_SCAN_MAX_BYTES\` \| 1,048,576 bytes/);
    expect(doc).toMatch(/FILE_MAX_BYTES_SCANNED/);
  });

  test('separates the emitted-byte bound from the traversed-byte bound', () => {
    expect(doc).toMatch(/65,536 bytes \*\*emitted\*\*/);
    expect(doc).toMatch(/1,048,576 bytes \*\*traversed\*\*/);
    expect(doc).toMatch(/costs at most\s+`READ_SCAN_MAX_BYTES` of sequential traversal/);
  });

  test('bounds regex cost structurally rather than with a wall-clock timer', () => {
    expect(doc).toMatch(/Regex cost is bounded structurally, not by a timer/);
    expect(doc).toMatch(/A synchronous\s+resolver cannot be preempted mid-match/);
  });

  test('bounds glob cost structurally and names the per-glob bounds', () => {
    expect(doc).toMatch(/GLOB_MAX_SEGMENTS\` \| 32/);
    expect(doc).toMatch(/GLOB_MAX_WILDCARDS\` \| 16/);
    expect(doc).toMatch(/GLOB_MAX_STARSTAR\` \| 2/);
    expect(doc).toMatch(/Glob cost is bounded the same way and for the same reason/);
    expect(doc).toMatch(/A glob translated into a `RegExp` would have neither property/);
  });

  test('defines per-turn bounds', () => {
    expect(doc).toMatch(/MAX_QUERIES_PER_TURN/);
    expect(doc).toMatch(/EVIDENCE_BYTES_PER_TURN/);
    expect(doc).toMatch(/EVIDENCE_TURN_MS/);
  });

  test('defines per-run bounds including a turn cap', () => {
    expect(doc).toMatch(/MAX_EVIDENCE_TURNS\` \| 4/);
    expect(doc).toMatch(/MAX_QUERIES_PER_RUN/);
    expect(doc).toMatch(/EVIDENCE_BYTES_PER_RUN/);
    expect(doc).toMatch(/EVIDENCE_RUN_MS/);
  });

  test('requires bounded reads not to load whole files', () => {
    expect(doc).toMatch(/MUST NOT load a whole file to return a bounded window/);
  });

  test('degrades a greedy request gracefully instead of failing the turn', () => {
    expect(doc).toMatch(/`budget-exhausted`/);
    expect(doc).toMatch(/degrades\s+gracefully/i);
  });
});

// ---------------------------------------------------------------------------
// Wire contract
// ---------------------------------------------------------------------------

describe('docs/research-evidence-contract.md — wire contract', () => {
  test('defines the request markers and strict line-start recognition', () => {
    expect(doc).toMatch(/<<<EVIDENCE_REQUEST>>>/);
    expect(doc).toMatch(/<<<END_EVIDENCE_REQUEST>>>/);
    expect(doc).toMatch(/only\*\* as a whole line/);
  });

  test('rejects unknown fields rather than ignoring them', () => {
    expect(doc).toMatch(/Unknown fields are rejected, not ignored/);
  });

  test('serves the last well-formed block when several appear', () => {
    expect(doc).toMatch(/the \*\*last\*\* one wins/);
  });

  test('recognizes no other stdout shape as a request', () => {
    expect(doc).toMatch(/MUST NOT interpret anything else in stdout as a request/);
  });

  test('bounds request size and field lengths before parsing or resolving', () => {
    expect(doc).toMatch(/REQUEST_SCAN_MAX_BYTES/);
    expect(doc).toMatch(/REQUEST_MAX_BYTES/);
    expect(doc).toMatch(/QUERY_ID_MAX_LENGTH/);
    expect(doc).toMatch(/GLOB_MAX_LENGTH/);
    expect(doc).toMatch(/Request size is bounded before anything is parsed or resolved/);
    expect(doc).toMatch(/`request-too-large`/);
    expect(doc).toMatch(/it never echoes the value/);
  });

  test('summarizes excess queries instead of emitting one result per query', () => {
    expect(doc).toMatch(/Excess queries are summarized, not enumerated/);
    expect(doc).toMatch(/requestOverflow/);
    expect(doc).toMatch(/produce \*\*no per-query results at all\*\*/);
  });

  test('bounds the rendered response independently of the request', () => {
    expect(doc).toMatch(/The response is bounded independently of the request/);
    expect(doc).toMatch(/responseTruncated/);
    expect(doc).toMatch(/can make the section appended to the next prompt exceed\s+`EVIDENCE_BYTES_PER_TURN`/);
  });

  test('defines the response section with delimiters, labels, and remaining budget', () => {
    expect(doc).toMatch(/## Repository Evidence \(turn 2 of 4\)/);
    expect(doc).toMatch(/begin:evidence-response/);
    expect(doc).toMatch(/Budget remaining/);
    expect(doc).toMatch(/issue-body`-sourced results MUST carry the untrusted-content label/);
  });

  test('states delimiters are labelling, not enforcement', () => {
    expect(doc).toMatch(/labelling, not enforcement/);
  });

  test('defines the turn loop and its termination conditions', () => {
    expect(doc).toMatch(/turn 0: invoke agent with base prompt/);
    expect(doc).toMatch(/prompt grows monotonically/i);
    expect(doc).toMatch(/Two consecutive invocations that produce a malformed request block/);
    expect(doc).toMatch(/short-circuits the loop immediately/);
  });

  test('requires stdin-only prompt delivery on evidence-enabled turns', () => {
    // The prompt accumulates up to EVIDENCE_BYTES_PER_RUN across turns. Today's
    // handler passes it as a positional argument *and* on stdin, so an
    // evidence-enabled run would exceed darwin's ~256 KiB ARG_MAX and die with
    // E2BIG on a valid run. An edit that drops this rule reintroduces that
    // failure.
    expect(doc).toMatch(/#### 6\.3\.1 Prompt delivery: stdin only \(normative\)/);
    expect(doc).toMatch(/ARG_MAX/);
    expect(doc).toMatch(/E2BIG/);
    expect(doc).toMatch(/delivered on \*\*stdin only\*\*/);
    expect(doc).toMatch(/\*\*no\s+positional prompt argument\*\* appended/);
    expect(doc).toMatch(/\*\*Evidence-disabled runs are untouched\.\*\*/);
    expect(doc).toMatch(/promptDelivery: "stdin"/);
    expect(doc).toMatch(/\*\*Verify, do not assume, the operand-free form\.\*\*/);
    expect(doc).toMatch(/MUST NOT fall back to appending the prompt to\s+argv/);
  });

  test('bounds the cumulative prompt before each re-invocation', () => {
    expect(doc).toMatch(/PROMPT_MAX_BYTES\` \| 524,288 bytes of cumulative prompt/);
    expect(doc).toMatch(/if next prompt would exceed PROMPT_MAX_BYTES/);
    expect(doc).toMatch(/checked \*\*before\*\* each re-invocation/);
    expect(doc).toMatch(/promptCapReached/);
    expect(doc).toMatch(/\*\*not\*\* a substitute\s+for §6\.3\.1/);
  });
});

// ---------------------------------------------------------------------------
// Failure contracts
// ---------------------------------------------------------------------------

describe('docs/research-evidence-contract.md — failure contracts', () => {
  test('defines the per-query denial vocabulary', () => {
    for (const reason of [
      'invalid-query', 'unsupported-op', 'absolute-path', 'outside-root',
      'symlink-rejected', 'not-tracked', 'not-found', 'not-regular-file',
      'binary', 'denied-sensitive', 'pattern-rejected', 'glob-rejected',
      'budget-exhausted', 'resolver-error',
    ]) {
      expect(doc).toMatch(new RegExp('`' + reason + '`'));
    }
  });

  test('maps a rejected glob and a descendant-free prefix to their own reasons', () => {
    expect(doc).toMatch(/Glob outside the §3\.4 subset/);
    expect(doc).toMatch(/the query is never re-run unfiltered/);
    expect(doc).toMatch(/a `list`\/`search` directory prefix has no indexed descendant/);
    expect(doc).toMatch(/Never returned for the root scope/);
  });

  test('states a per-query denial never fails the run and is reported to the agent', () => {
    expect(doc).toMatch(/It never fails the run/);
    expect(doc).toMatch(/instead of inventing content/i);
  });

  test('records resolver errors by class, never by raw message', () => {
    expect(doc).toMatch(/error \*\*class\*\*/);
    expect(doc).toMatch(/an error message can embed an absolute path/i);
  });

  test('adds exactly three run outcomes and maps them to task results', () => {
    expect(doc).toMatch(/`evidence\/unavailable`/);
    expect(doc).toMatch(/`evidence\/protocol-error`/);
    expect(doc).toMatch(/`evidence\/budget-exhausted`/);
    expect(doc).toMatch(/Existing `ResearchOutcome` values are unchanged/);
  });

  test('defines a total ordering for outcome precedence', () => {
    expect(doc).toMatch(/Precedence, evaluated in order, so exactly one outcome is recorded/);
    expect(doc).toMatch(/quota\/rate-limit` \(delayed, not failed\)/);
    expect(doc).toMatch(/permission-denied\/\{read,command,unspecified\}/);
  });

  test('keeps the #804 denial classification meaningful and non-fatal alongside findings', () => {
    expect(doc).toMatch(/#804 semantics, unchanged/);
    expect(doc).toMatch(/A denial \*and\* usable findings is `valid`/);
  });

  test('states quota retries restart from turn 0 with no cross-run evidence cache', () => {
    expect(doc).toMatch(/restarts from turn 0/);
    expect(doc).toMatch(/not\*\* cached across runs/);
  });

  test('states the resolver takes no lock and mutates nothing', () => {
    expect(doc).toMatch(/holds no lock of its own/);
    expect(doc).toMatch(/mutates nothing/);
  });
});

// ---------------------------------------------------------------------------
// Prohibitions
// ---------------------------------------------------------------------------

describe('docs/research-evidence-contract.md — prohibitions', () => {
  test('prohibits every form of write outside runner-owned artifacts', () => {
    expect(doc).toMatch(/No `open` for write, create, append, or truncate/);
    expect(doc).toMatch(/no rename, no\s+delete/i);
  });

  test('prohibits network access', () => {
    expect(doc).toMatch(/\*\*Reach the network\.\*\*/);
    expect(doc).toMatch(/No HTTP client, no DNS, no socket/);
    expect(doc).toMatch(/ls-remote/);
  });

  test('prohibits child processes derived from agent input', () => {
    expect(doc).toMatch(/\*\*Spawn a process from agent input\.\*\*/);
    expect(doc).toMatch(/resolver's \*\*only\*\* additional\s+child process is `git ls-files -z --cached`/);
    expect(doc).toMatch(/\*\*zero\*\* agent-derived arguments/);
  });

  // The prohibition is scoped to the resolver on purpose: the turn loop invokes
  // the agent CLI once per turn by design, so a literal "exactly one subprocess
  // in this mechanism" would contradict the transport and could make an audit
  // reject the required invocations.
  test('scopes the subprocess prohibition to the resolver, not the turn loop', () => {
    expect(doc).toMatch(/This is scoped to the resolver deliberately/);
    expect(doc).toMatch(/turn loop \(§6\.3\) invokes the\s+agent CLI once per turn/);
    expect(doc).toMatch(/counts the resolver's children,\s+not the agent invocations/);
  });

  test('prohibits shell interpretation', () => {
    expect(doc).toMatch(/No `shell: true`, no `execSync` with a string/);
  });

  test('prohibits executing anything the agent produced', () => {
    expect(doc).toMatch(/\*\*Execute anything the agent produced\.\*\*/);
    expect(doc).toMatch(/otherwise treated as inert text/);
  });

  test('prohibits generated scratch scripts and executable artifacts', () => {
    expect(doc).toMatch(/\*\*Create a scratch script or any executable artifact\.\*\*/);
  });

  test('prohibits widening agent permissions, including --dangerously-skip-permissions', () => {
    expect(doc).toMatch(/\*\*Widen agent permissions\.\*\*/);
    expect(doc).toMatch(/MUST NOT pass\s+`--dangerously-skip-permissions`/);
    expect(doc).toMatch(/MUST NOT add or expand a tool allowlist/);
    expect(doc).toMatch(/MUST NOT set an auto-approve/);
  });

  test('prohibits escaping the evidence root or reading denied/untracked paths', () => {
    expect(doc).toMatch(/\*\*Escape the evidence root\*\*/);
  });
});

// ---------------------------------------------------------------------------
// Artifacts and public/local separation
// ---------------------------------------------------------------------------

describe('docs/research-evidence-contract.md — artifacts and publication', () => {
  test('names the local artifacts the implementation must write', () => {
    expect(doc).toMatch(/research-evidence-manifest\.json/);
    expect(doc).toMatch(/research-evidence-turn-<n>\.json/);
    expect(doc).toMatch(/research-prompt-turn-<n>\.md/);
    expect(doc).toMatch(/research-turn-<n>-output\.md/);
  });

  test('keeps the existing artifacts unchanged as the turn-0 and final records', () => {
    expect(doc).toMatch(/`research-prompt\.md` remains turn 0, unchanged/);
    expect(doc).toMatch(/`research-output\.md` remains the \*\*final\*\* invocation's capture/);
  });

  test('reuses the existing artifact path guards', () => {
    expect(doc).toMatch(/rejectSymlink/);
    expect(doc).toMatch(/isSafeArtifactDirAfterRun/);
  });

  test('keeps content payloads out of artifacts by recording length and hash', () => {
    expect(doc).toMatch(/recorded by length and SHA-256, not duplicated/);
  });

  // A query carrying an absolute or traversal path is well-formed JSON: it
  // reaches admission and is denied there. Persisting "the validated request
  // verbatim" would therefore write an absolute path into an artifact that
  // promises repo-relative paths only — invalid input must not be able to put
  // content into an artifact that valid input could not.
  test('stores a sanitized request record so a rejected path is never persisted', () => {
    expect(doc).toMatch(/### 9\.1 The sanitized request record/);
    expect(doc).toMatch(/sanitized request record\*\*, never the raw request/);
    expect(doc).toMatch(/`path: "\/etc\/passwd"`/);
    expect(doc).toMatch(/query \*\*denied or invalid\*\* \| `\{ length, sha256 \}` only/);
    expect(doc).toMatch(/Invalid input must not be able to put content into an\s+artifact that valid input could not/);
  });

  // An admitted `glob` or `pattern` never passes the §4.1 path-shape gate, so a
  // verdict-only rule would write a pattern such as an absolute path verbatim
  // into an artifact that promises repo-relative paths only. The glob is safe by
  // its own grammar (§3.4); the pattern needs an independent gate.
  test('gates free-text serialization independently of the query verdict', () => {
    expect(doc).toMatch(/\*\*Two gates, not one\.\*\*/);
    expect(doc).toMatch(/The verdict decides whether a value is \*entitled\*\s+to be stored; a separate serialization gate decides whether it is \*safe\* to store/);
    expect(doc).toMatch(/Keying only on the verdict would be wrong for `pattern`/);
    expect(doc).toMatch(/Admission bounds a pattern's match \*cost\* \(§3\.3\.1\), never its \*shape\*/);
    expect(doc).toMatch(/unsafeToSerialize: true/);
    expect(doc).toMatch(/applied to every free-text field the runner is about to\s+write, independently of that field's verdict/);
    expect(doc).toMatch(/no leading `\/`, no Windows drive prefix, no\s+UNC prefix/);
    expect(doc).toMatch(/`redactTokens` \(§4\.8\) leaves it unchanged/);
    // The glob is verbatim only because its own subset already proves the shape.
    expect(doc).toMatch(/the §3\.4 subset admits no absolute form/);
    // Serving the query is not in question — only what gets written down.
    expect(doc).toMatch(/Denying such a query would be worse than useless/);
    expect(doc).toMatch(/any request field the\s+section echoes passes the serialization gate first/);
  });

  test('names the sanitized record in the turn artifact row, not a verbatim request', () => {
    expect(doc).toMatch(/The \*\*sanitized\*\* request record of §9\.1 \(never the raw request\)/);
  });

  // The body artifact exists only to give the issue-body source something to
  // read. Writing it on a disabled run would add an unbounded local copy of
  // work-item content to a run that is promised byte-identical to today.
  test('gates the issue-body artifact write on evidence being enabled', () => {
    expect(doc).toMatch(/when, and only when, repository evidence is enabled for the run\s+and a body is present/);
    expect(doc).toMatch(/writing it on a disabled run would create a new unbounded local copy/);
    expect(doc).toMatch(/With evidence disabled the mechanism writes nothing at all/);
    expect(doc).toMatch(/Written only when evidence is enabled \*and\* a body is present/);
  });

  test('adds a bounded evidence summary to research-result.json', () => {
    expect(doc).toMatch(/"evidence": \{/);
    expect(doc).toMatch(/"bytesServed"/);
    expect(doc).toMatch(/"budgetExhausted"/);
  });

  test('defines a publishable allowlist of counts and literals', () => {
    expect(doc).toMatch(/Publishable:/);
    expect(doc).toMatch(/The outcome literal/);
    expect(doc).toMatch(/Counts: turns used, invocations, queries by op/);
  });

  test('forbids publishing paths, content, patterns, and absolute paths', () => {
    expect(doc).toMatch(/Never publishable:/);
    expect(doc).toMatch(/Any repository path, glob, or filename — including a denied one/);
    expect(doc).toMatch(/Any file content, match line, or content hash/);
    expect(doc).toMatch(/Any search pattern/);
    expect(doc).toMatch(/Any absolute filesystem path, the evidence root/);
  });

  test('keeps the bodyIncluded withholding rule load-bearing and un-narrowed', () => {
    expect(doc).toMatch(/`bodyIncluded` withholding/);
    expect(doc).toMatch(/MUST NOT narrow it/);
  });

  test('states bodyIncluded alone is insufficient once evidence is served', () => {
    expect(doc).toMatch(/### 10\.1 Withholding is widened to enablement, not narrowed/);
    expect(doc).toMatch(/on its own it is \*\*not\s+sufficient\*\*/);
    expect(doc).toMatch(/An Issue with \*\*no body\*\* leaves\s+`bodyIncluded` false/);
  });

  test('suppresses published agent output whenever evidence is enabled', () => {
    expect(doc).toMatch(/whenever repository evidence is \*\*enabled\*\* for the run/);
    expect(doc).toMatch(/Omit `researchOutput` from the success context entirely/);
    expect(doc).toMatch(/`evidenceEnabled: true`/);
    expect(doc).toMatch(/fixed-form, content-free `result\.error` on \*\*every\*\* failure path/);
    expect(doc).toMatch(/same fixed-form text in the Slack notification/);
  });

  test('ORs the two withholding conditions instead of replacing one', () => {
    expect(doc).toMatch(/The two conditions are \*\*ORed\*\*/);
    expect(doc).toMatch(/neither condition may be narrowed/);
  });

  test('gates suppression on enablement rather than on bytes actually served', () => {
    expect(doc).toMatch(/The gate is \*\*enablement, not "were any bytes actually served"\*\*/);
    expect(doc).toMatch(/must not depend on evidence accounting being correct/);
  });

  test('requires repo-relative paths in composed metadata and rendered sections', () => {
    expect(doc).toMatch(/\*\*Structured metadata\*\*/);
    expect(doc).toMatch(/MUST contain repo-relative paths only/);
    expect(doc).toMatch(/\*\*Rendered evidence sections\*\*/);
    expect(doc).toMatch(/MUST likewise carry repo-relative paths only/);
  });

  test('exempts the verbatim prompt and output captures from path rewriting', () => {
    expect(doc).toMatch(/\*\*Verbatim captures\*\*/);
    expect(doc).toMatch(/preserved byte-for-byte and MAY contain\s+absolute paths/);
    expect(doc).toMatch(/base prompt already interpolates the repository root/);
    expect(doc).toMatch(/local-only and are never a\s+publication source/);
    expect(doc).toMatch(/sanitize what the runner \*composes\*, preserve what it \*captures\*/);
  });

  test('records the copybara export decision for this document', () => {
    expect(doc).toMatch(/copybara\/copy\.bara\.sky/);
    expect(doc).toMatch(/\*\*publicly exportable\*\*, not private-only/);
  });

  test('states the general public-reporting rule: shape, never content', () => {
    expect(doc).toMatch(/shape\* of a run.*never its \*content\*/);
  });
});

// ---------------------------------------------------------------------------
// Provider neutrality
// ---------------------------------------------------------------------------

describe('docs/research-evidence-contract.md — provider neutrality', () => {
  test('states which parts are portable and which are per-provider', () => {
    expect(doc).toMatch(/Portable \(provider-neutral\)/);
    expect(doc).toMatch(/Per-provider \(transport\)/);
  });

  test('forbids the transport from being an enforcement point', () => {
    expect(doc).toMatch(/transport MUST NOT be an enforcement point/);
    expect(doc).toMatch(/every accept\/deny decision belongs to the resolver/);
  });

  test('forbids a transport from adding an operation, bound, or denial reason', () => {
    expect(doc).toMatch(/A transport MUST NOT add an operation, widen a bound, or introduce a denial reason/);
    expect(doc).toMatch(/this document changes first/);
  });

  test('registers transports by agentId so adding a provider is additive', () => {
    expect(doc).toMatch(/registered by `agentId`/);
  });

  test('records the transport id in local artifacts', () => {
    expect(doc).toMatch(/artifacts always record the transport id/);
  });

  test('separates the provider-neutral resolver from a per-provider transport', () => {
    expect(doc).toMatch(/EvidenceTransport/);
    expect(doc).toMatch(/EVIDENCE_TRANSPORTS: Record<string, EvidenceTransport>/);
    expect(doc).toMatch(/src\/core\/agent-diagnostics\.ts/);
  });

  test('states a second provider reuses the resolver, bounds, and vocabularies', () => {
    expect(doc).toMatch(/without changing the resolver, the bounds, the\s+denial vocabulary, or the outcome vocabulary/);
  });

  test('names the transport id shipped for the Antigravity CLI', () => {
    expect(doc).toMatch(/antigravity-stdout-marker/);
  });

  test('keeps a read-only MCP server available as a future transport', () => {
    expect(doc).toMatch(/\*\*future transport\*\* behind the same resolver port/);
  });
});

// ---------------------------------------------------------------------------
// Decision record
// ---------------------------------------------------------------------------

describe('docs/research-evidence-contract.md — decision record', () => {
  test('has a decision record section with a chosen option', () => {
    expect(doc).toMatch(/## 11\. Decision record/);
    expect(doc).toMatch(/### 11\.1 Chosen/);
    expect(doc).toMatch(/### 11\.2 Rejected/);
  });

  test('states the accepted costs of the chosen option', () => {
    expect(doc).toMatch(/Accepted costs, stated plainly/);
    expect(doc).toMatch(/Up to 5 agent invocations/);
  });

  test('rejects --dangerously-skip-permissions with a reason', () => {
    expect(doc).toMatch(/`--dangerously-skip-permissions` \| Grants writes, arbitrary commands, network/);
    expect(doc).toMatch(/destroys auditability/i);
  });

  test('rejects broad permission grants with a reason', () => {
    expect(doc).toMatch(/Broad permission grant \/ pre-approved tool policy/);
  });

  test('rejects a vendor tool-profile allowlist as the boundary', () => {
    expect(doc).toMatch(/Vendor tool-profile allowlist as the boundary/);
    expect(doc).toMatch(/\*defense in depth\* under this contract, never as the contract/);
  });

  test('rejects a committed blob source and an overstated committed-only claim', () => {
    expect(doc).toMatch(/Committed tree\/blob source \(`git ls-tree HEAD` \+ `git cat-file blob`\) as the evidence scope/);
    expect(doc).toMatch(/Keep calling the scope "committed-only" while reading `--cached` and the worktree/);
    expect(doc).toMatch(/An overstated security claim is worse than a narrower true one/);
  });

  test('rejects an allowlisted shell and a runner-owned helper subprocess', () => {
    expect(doc).toMatch(/Allowlisted shell/);
    expect(doc).toMatch(/Runner-owned helper \*\*binary\*\*/);
  });

  test('rejects a static-bundle-only design and explains why', () => {
    expect(doc).toMatch(/Static precomputed bundle only/);
    expect(doc).toMatch(/Cannot answer a question nobody anticipated/);
  });

  test('rejects generated scratch scripts and research write access', () => {
    expect(doc).toMatch(/Generated scratch scripts/);
    expect(doc).toMatch(/Give research the implementation lane's write access/);
  });

  test('rejects a RegExp-translated glob and a membership-checked prefix', () => {
    expect(doc).toMatch(/Length-capped `glob` translated to a `RegExp` \(or delegated to `minimatch`\)/);
    expect(doc).toMatch(/Admitting a `list`\/`search` directory prefix by tracked-set membership/);
    expect(doc).toMatch(/`stat`-ing the prefix on the filesystem to prove it is a directory/);
  });

  test('rejects recording an admitted pattern verbatim on the strength of its verdict', () => {
    expect(doc).toMatch(/Recording an admitted `pattern` verbatim because the query passed §4/);
    expect(doc).toMatch(/searching a repository for an absolute path is legitimate evidence work/);
  });
});

// ---------------------------------------------------------------------------
// Scope: no behavior change in this issue
// ---------------------------------------------------------------------------

describe('docs/research-evidence-contract.md — scope', () => {
  test('states no production research behavior changed in issue #805 itself', () => {
    expect(doc).toMatch(/no production research behavior changed in #805\s+itself/);
  });

  test('states the implementation is off by default when it lands', () => {
    expect(doc).toMatch(/session\.research\.evidence\.enabled/);
    expect(doc).toMatch(/defaults to\s+`false`/);
    expect(doc).toMatch(/behaves exactly as\s+today/);
  });

  test('records both halves of the tracked-worktree scope as accepted limitations', () => {
    expect(doc).toMatch(/\*\*Tracked-worktree evidence, not committed-only\.\*\*/);
    expect(doc).toMatch(/Untracked and ignored files stay invisible/);
    expect(doc).toMatch(/A staged-but-uncommitted tracked file is visible/);
    expect(doc).toMatch(/never claims a committed-only\s+guarantee/);
  });

  test('records the residual prompt-injection risk and its bound', () => {
    expect(doc).toMatch(/the worst outcome is a wasted run,\s+not a disclosure or a mutation/);
  });

  test('records the glob-subset and pattern-hashing costs as accepted limitations', () => {
    expect(doc).toMatch(/\*\*The glob subset is deliberately smaller than a shell's\.\*\*/);
    expect(doc).toMatch(/\*\*An unsafe-to-serialize `pattern` is debuggable only by hash\.\*\*/);
    expect(doc).toMatch(/the alternative is either an artifact that contradicts §9 or a denial\s+for a legitimate search/);
  });

  test('leaves content-research and the n8n workflow topology out of scope', () => {
    expect(doc).toMatch(/other research lanes are out of scope/i);
    expect(doc).toMatch(/No new n8n node, no workflow topology change/);
  });
});

// ---------------------------------------------------------------------------
// Implementation plan and test matrix
// ---------------------------------------------------------------------------

describe('docs/research-evidence-contract.md — implementation plan', () => {
  test('has an ordered slice plan naming the files each slice touches', () => {
    expect(doc).toMatch(/## 13\. Implementation plan/);
    expect(doc).toMatch(/src\/core\/repository-evidence\.ts/);
    expect(doc).toMatch(/src\/core\/research-evidence-protocol\.ts/);
    expect(doc).toMatch(/src\/handlers\/research-evidence-source\.ts/);
    expect(doc).toMatch(/src\/handlers\/research\.ts/);
    expect(doc).toMatch(/src\/core\/session\.ts/);
  });

  test('keeps the pure core testable without git or a real repository', () => {
    expect(doc).toMatch(/TrackedFileSource/);
    expect(doc).toMatch(/FileAccess/);
    expect(doc).toMatch(/no imports from `handlers\/`|no imports from handlers/i);
  });

  test('names the glob, prefix-scope, and sanitization units the core must own', () => {
    expect(doc).toMatch(/parseEvidenceGlob\(\)/);
    expect(doc).toMatch(/matchEvidenceGlob\(segments, path\)/);
    expect(doc).toMatch(/resolveListScope\(\)/);
    expect(doc).toMatch(/MUST NOT route a prefix\s+through the candidate-file membership check/);
    expect(doc).toMatch(/sanitizeRequestRecord\(\)/);
    expect(doc).toMatch(/applies both gates — the verdict gate and the\s+field-level serialization gate/);
  });

  test('constrains operator config to tightening only', () => {
    expect(doc).toMatch(/may only \*\*lower\*\* `MAX_EVIDENCE_TURNS`/);
    expect(doc).toMatch(/`denyGlobs` is additive only/);
  });

  test('requires the phase-contracts outcome table to be updated by the implementation', () => {
    expect(doc).toMatch(/`docs\/phase-contracts\.md`: add the three outcomes/);
  });
});

describe('docs/research-evidence-contract.md — test matrix', () => {
  test('specifies a fixture repository with the adversarial cases enumerated', () => {
    expect(doc).toMatch(/### 14\.1 Fixture repository/);
    expect(doc).toMatch(/initRepo/);
    for (const fixture of [
      'Untracked exclusion', 'Ignored exclusion', 'Deny floor must beat tracked-ness',
      'Case-insensitive deny matching', 'Component-level symlink rejection',
      'Binary detection', 'Exact-bytes membership',
    ]) {
      expect(doc).toContain(fixture);
    }
  });

  test('requires fixture-level resolver integration cases', () => {
    expect(doc).toMatch(/### 14\.2 Resolver cases/);
    expect(doc).toMatch(/Leaf replaced by a symlink between validation and open/);
    expect(doc).toMatch(/Same swap, then reverted to the real directory before re-verification/);
    expect(doc).toMatch(/Evidence root itself replaced or moved mid-turn/);
    expect(doc).toMatch(/Tracked regular file replaced by a FIFO with no writer/);
    expect(doc).toMatch(/`pattern-rejected` \(`quantified-group`\) at admission/);
    expect(doc).toMatch(/An admitted pattern run against a 1 MiB single-line worst case/);
    expect(doc).toMatch(/Matcher implementation audit/);
    expect(doc).toMatch(/`read` a text file larger than `READ_SCAN_MAX_BYTES`/);
    expect(doc).toMatch(/`read` `startLine` beyond `READ_SCAN_MAX_BYTES`/);
    expect(doc).toMatch(/Whole-run write audit/);
  });

  test('requires cases pinning the sanitized record and the disabled-run write gate', () => {
    expect(doc).toMatch(/Evidence \*\*disabled\*\*, work item \*\*has\*\* a body/);
    expect(doc).toMatch(/no `research-issue-body\.md`, no manifest, no turn record/);
    expect(doc).toMatch(/each rejected field is stored as `\{ length, sha256 \}` per §9\.1/);
    expect(doc).toMatch(/Resolver child-process audit/);
  });

  test('requires cases for the directory-prefix scope rule', () => {
    expect(doc).toMatch(/`path: "src"`, `path: "src\/"`, and `path: "src\/nested"`/);
    expect(doc).toMatch(/scoped to the prefix's indexed descendants/);
    expect(doc).toMatch(/prefix matching is exact-bytes on a segment boundary/);
    expect(doc).toMatch(/every descendant deny-floored/);
    expect(doc).toMatch(/Root scope on a repository with an \*\*empty\*\* index/);
    expect(doc).toMatch(/Segment-bounded prefix matching/);
  });

  test('requires cases for the glob subset, its matcher, and its case sensitivity', () => {
    expect(doc).toMatch(/Globs inside the §3\.4 subset/);
    expect(doc).toMatch(/Globs outside it/);
    expect(doc).toMatch(/Each `glob-rejected`, naming its own failing rule/);
    expect(doc).toMatch(/the query is \*\*not\*\* re-run unfiltered/);
    expect(doc).toMatch(/Glob matcher audit/);
    expect(doc).toMatch(/imports no glob library/);
    expect(doc).toMatch(/Glob case sensitivity/);
  });

  test('requires cases proving an admitted pattern is not serialized verbatim', () => {
    expect(doc).toMatch(/\*\*Admitted\*\* `search` queries whose `pattern` is/);
    expect(doc).toMatch(/none is denied for its shape/);
    expect(doc).toMatch(/`\{ length, sha256, unsafeToSerialize: true \}`/);
    expect(doc).toMatch(/no absolute filesystem path even though the request was entirely admitted/);
  });

  test('requires protocol parsing cases including the echoed-body case', () => {
    expect(doc).toMatch(/### 14\.3 Protocol cases/);
    expect(doc).toMatch(/Request block quoted inside an echoed work-item body/);
  });

  test('requires handler cases proving the disabled default is byte-identical', () => {
    expect(doc).toMatch(/### 14\.4 Handler cases/);
    expect(doc).toMatch(/byte-identical to today/);
  });

  test('requires cases pinning the tracked-worktree scope in both directions', () => {
    expect(doc).toMatch(/staged, never committed/);
    expect(doc).toMatch(/are \*\*not\*\* the `HEAD` blob/);
    expect(doc).toMatch(/A staged-but-uncommitted file whose path matches the deny floor/);
  });

  test('requires prompt-delivery cases that would fail an argv-passed prompt', () => {
    expect(doc).toMatch(/Prompt delivery audit, evidence \*\*enabled\*\*/);
    expect(doc).toMatch(/no invocation fails with `E2BIG`/);
    expect(doc).toMatch(/would exceed `PROMPT_MAX_BYTES`/);
    expect(doc).toMatch(/Evidence \*\*disabled\*\* argv audit/);
    expect(doc).toMatch(/Transport registry check/);
  });

  test('requires audits for public text, artifact paths, and invocation flags', () => {
    expect(doc).toMatch(/Public text audit/);
    expect(doc).toMatch(/Artifact path audit/);
    expect(doc).toMatch(/Invocation flag audit/);
  });

  test('requires the oversized-body paging case that closes the #803 deferral', () => {
    expect(doc).toMatch(/Oversized body/);
  });

  test('requires issue-body source admission cases', () => {
    expect(doc).toMatch(/### 14\.5 Evidence-source and publication cases/);
    expect(doc).toMatch(/`read` `source: "issue-body"`, `path: "src\/a\.ts"` \| `invalid-query`/);
    expect(doc).toMatch(/`not-found`, never `not-tracked`/);
    expect(doc).toMatch(/the tracked-file gate is not consulted for this source/);
    expect(doc).toMatch(/Tracked repository file literally named `<issue-body>`/);
  });

  test('lists the contradiction-prone invariants the documentation test must pin', () => {
    expect(doc).toMatch(/### 14\.6 Documentation test/);
    expect(doc).toMatch(/the glob\s+must likewise be a closed subset executed by a bounded matcher/);
    expect(doc).toMatch(/a non-root directory prefix\s+must be admitted by its indexed descendants/);
    expect(doc).toMatch(/an\s+admitted `pattern` must pass a serialization gate that is independent of the\s+verdict/);
  });

  test('requires publication cases for an Issue with no body', () => {
    expect(doc).toMatch(/Issue has \*\*no\*\* body, agent stdout quotes served file content/);
    expect(doc).toMatch(/no stderr\/stdout interpolation/);
    expect(doc).toMatch(/the widening is scoped to enablement/);
  });
});

// ---------------------------------------------------------------------------
// Cross-document consistency
// ---------------------------------------------------------------------------

describe('docs/research-evidence-contract.md — cross-document links', () => {
  test('phase-contracts.md points at this contract for the read-only boundary', () => {
    expect(phaseContracts).toMatch(/docs\/research-evidence-contract\.md/);
  });

  test('phase-contracts.md still states that #804 grants no permission', () => {
    expect(phaseContracts).toMatch(/grants no permission/);
  });

  test('this document reuses the existing outcome names from phase-contracts.md', () => {
    for (const outcome of ['quota/rate-limit', 'command-failure', 'empty-output']) {
      expect(doc).toContain(outcome);
      expect(phaseContracts).toContain(outcome);
    }
  });

  test('contains no absolute filesystem paths', () => {
    expect(doc).not.toMatch(/\/Users\//);
    expect(doc).not.toMatch(/\/home\/[a-z]/);
  });
});
