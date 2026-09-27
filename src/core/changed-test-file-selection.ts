/**
 * Stage 1 test-file selection, the Issue's retained failing test files, and the
 * persisted test-stage record (issue #1153,
 * `docs/changed-file-verification-contract.md` §2, §3 and §4).
 *
 * Three things live here, all pure:
 *
 * 1. **The Issue base** ({@link resolveIssueBase}, §4.1 rule 1). The predecessor
 *    head the dependency flow recorded, or the base-branch commit the Issue
 *    branch started from — resolved once, persisted with the first Stage 1
 *    record, and never recomputed afterwards. It moves exactly once per accepted
 *    predecessor update (decision D5): only a `dependencyBase` that attests
 *    acceptance of its own exact head advances it.
 * 2. **Stage 1 selection** ({@link selectStage1TestFiles}, §4.2): the changed
 *    paths of the cumulative net diff that the project tooling reports runnable,
 *    union the retained set. Nothing is inferred from imports, names, history or
 *    a judgment; an input that cannot be read is `unavailable`, never empty.
 * 3. **The obligations and the record** ({@link nextRetainedTestFiles},
 *    {@link testStageRecordProblem}, §3 and §4.3). Only a `failed` Stage 2 with
 *    trusted outcomes adds retained files, nothing removes one, and a record that
 *    claims more than its facts carry is refused.
 *
 * What this module deliberately is not:
 *
 * - **Not git and not a test tool.** The cumulative change and the runnable-file
 *   report arrive as reads (`src/handlers/cumulative-test-change.ts` and the
 *   #1152 adapter produce them). Core never decides what a test file is.
 * - **Not result classification or routing.** Which §3 row a run records is the
 *   caller's to establish; the record here only refuses a row its own facts
 *   contradict. A complete Stage 1 whose selected files are all `skipped`
 *   executed no test, so its only admissible row is `empty` (decision D6): it
 *   is never `passed`, and it never satisfies the full-suite requirement.
 * - **Not a store.** The retained set and the Issue base are fields of the one
 *   `stagedVerification` task-context block, written through the shipped
 *   `recordStageRun` CAS (`src/core/staged-verification-state.ts`).
 */

import { createHash } from "crypto";

import type {
  TestExecutionRequest,
  TestFileInventoryRead,
  TestFileRunResult,
  TestFileRunStepKind,
  TestOutcomeUntrustedReason,
} from "./test-file-execution.js";
import { DEPENDENCY_BASE_ACCEPTANCE_EVIDENCE } from "./review-admission.js";
import { isTestFileId } from "./test-file-id.js";
import { canonicalJsonStringify } from "./verification-amendment.js";
import { boundVerificationOutput, MAX_VERIFICATION_OUTPUT_CHARS } from "./verification-output.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** The longest file id a record persists. A longer runnable path is refused, never truncated. */
export const MAX_TEST_FILE_ID_CHARS = 4_096;

/**
 * Bound on the files one Stage 1 selection names, and on the failed files one
 * record lists. A Stage 2 run that fails more lists this many and is marked
 * truncated, never refused (see `TestStageRecord.failedFilesTruncated`).
 */
export const MAX_STAGE_TEST_FILES = 5_000;

/**
 * Bound on the Issue's retained set. A union past it is never shed: the set is
 * marked overflowed, and an overflowed set is unreadable for every later
 * selection (§4.3 rule 3 — an obligation is never dropped silently).
 */
export const MAX_RETAINED_TEST_FILES = 5_000;

const MAX_REASON_CHARS = 512;

function bounded(text: string): string {
  return text.length <= MAX_REASON_CHARS ? text : `${text.slice(0, MAX_REASON_CHARS - 1)}…`;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REASON_CHARS;
}

/** A test file id a record may persist: the shared grammar plus the length bound. */
export function isPersistableTestFileId(value: unknown): value is string {
  return isTestFileId(value) && value.length <= MAX_TEST_FILE_ID_CHARS;
}

/** A full lowercase commit object name (SHA-1 or SHA-256). */
export function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

// ---------------------------------------------------------------------------
// The Issue base (§4.1 rule 1)
// ---------------------------------------------------------------------------

/**
 * Where the Issue base came from: the predecessor head the shipped dependency
 * flow recorded (`dependencyBase.baseHeadSha`), or the base-branch commit the
 * Issue branch started from.
 */
export const ISSUE_BASE_SOURCES = ["dependency-base", "branch-start"] as const;

export type IssueBaseSource = (typeof ISSUE_BASE_SOURCES)[number];

export interface IssueBaseRecord {
  readonly sha: string;
  readonly source: IssueBaseSource;
  /**
   * §4.1 rule 1 / decision D5: the base this one replaces, carried only by the
   * Stage 1 selection whose accepted predecessor update advanced it. It is the
   * record's declaration of what it is rewriting, so the persisted state can
   * refuse every rewrite that declares nothing; the persisted base itself never
   * keeps it.
   */
  readonly advancedFrom?: { readonly sha: string; readonly source: IssueBaseSource };
}

/** The persisted form: the base alone, without the advance that produced it. */
export function persistedIssueBase(base: IssueBaseRecord): IssueBaseRecord {
  return { sha: base.sha, source: base.source };
}

/** A commit a caller tried to name, or why it could not. */
export type CommitRead =
  | { readonly kind: "readable"; readonly sha: string }
  | { readonly kind: "unreadable"; readonly reason: string };

export type IssueBaseUnavailableReason =
  /** A `dependencyBase` is present but names no usable head commit. */
  | "dependency_base_unresolved"
  /** No dependency base, nothing recorded, and the branch start could not be read. */
  | "branch_start_unreadable"
  /**
   * The recorded base and the one the task names now differ, and the difference
   * is not an accepted predecessor update (decision D5): the dependency base
   * disappeared, its source changed, or the head it names carries no acceptance
   * of its own exact commit. A moved ref or a fetch produces exactly this, and
   * it never changes the base — the selection is unavailable instead.
   */
  | "issue_base_changed";

export type IssueBaseResolution =
  | {
      readonly status: "resolved";
      readonly base: IssueBaseRecord;
      /** True when nothing was recorded yet: the next Stage 1 record persists it. */
      readonly firstResolution: boolean;
    }
  | { readonly status: "unavailable"; readonly reason: IssueBaseUnavailableReason; readonly detail: string };

export interface ResolveIssueBaseInput {
  /** The base the task's stage state already recorded, if any. */
  readonly recorded?: IssueBaseRecord;
  /** `resolveDependencyReviewBase(task.context)` — the shipped parse of `dependencyBase`. */
  readonly dependencyBase: {
    readonly base?: {
      readonly sha: string;
      /** The dependency flow's acceptance of this exact head (decision D5). */
      readonly accepted?: { readonly sha: string; readonly evidence: string };
    };
    readonly missing: boolean;
  };
  /**
   * Reads the base-branch commit the Issue branch started from. Called only when
   * the task has no dependency base and nothing is recorded, so a recorded base
   * is never recomputed.
   */
  readonly readBranchStart: () => CommitRead;
}

function normalizedSha(value: string): string | undefined {
  const sha = value.trim().toLowerCase();
  return isCommitSha(sha) ? sha : undefined;
}

/**
 * §4.1 rule 1: the one commit the cumulative diff is taken from.
 *
 * - A dependency-started task's base is its recorded predecessor head.
 * - Otherwise it is the branch start, read once and then taken from the record:
 *   a later merge or rebase of the Issue branch never moves it.
 * - **Decision D5.** A recorded `dependency-base` moves only when the dependency
 *   flow explicitly incorporated and recorded an updated predecessor: the task
 *   names a `dependency-base` head that differs from the recorded one *and*
 *   attests acceptance (`stack-ready`, or an equivalent authoritative successful
 *   completion signal) of that exact head. The advance is carried on the
 *   resolved base as {@link IssueBaseRecord.advancedFrom}, so the persisted
 *   state can tell a declared advance from a silent rewrite. Predecessor test
 *   files then sit below the new base and are not this Issue's changes.
 *   A base recorded as `branch-start` never advances, however well attested the
 *   new head is: this contract never resolved it against a predecessor, so the
 *   predecessor's files have been this Issue's own changes all along.
 * - Every other disagreement — the dependency base disappearing, its source
 *   changing, or a head whose acceptance names a different commit, which is all
 *   a moved ref or a bare fetch can ever produce — is `unavailable`
 *   (`issue_base_changed`). Nothing here reads a ref.
 */
export function resolveIssueBase(input: ResolveIssueBaseInput): IssueBaseResolution {
  const unavailable = (reason: IssueBaseUnavailableReason, detail: string): IssueBaseResolution => ({
    status: "unavailable",
    reason,
    detail: bounded(detail),
  });
  if (input.dependencyBase.missing) {
    return unavailable("dependency_base_unresolved", "the recorded dependency base carries no head commit");
  }
  let candidate: IssueBaseRecord | undefined;
  let accepted = false;
  if (input.dependencyBase.base !== undefined) {
    const sha = normalizedSha(input.dependencyBase.base.sha);
    if (sha === undefined) {
      return unavailable("dependency_base_unresolved", "the recorded dependency base head is not a full commit SHA");
    }
    candidate = { sha, source: "dependency-base" };
    // The attestation must name THIS commit and carry an admitted kind: the
    // acceptance of any other head, or an unrecognized signal, accepts nothing.
    const attestation = input.dependencyBase.base.accepted;
    accepted = attestation !== undefined
      && normalizedSha(attestation.sha) === sha
      && (DEPENDENCY_BASE_ACCEPTANCE_EVIDENCE as readonly string[]).includes(attestation.evidence);
  }
  const recorded = input.recorded;
  if (recorded !== undefined) {
    if (candidate === undefined && recorded.source === "branch-start") {
      return { status: "resolved", base: persistedIssueBase(recorded), firstResolution: false };
    }
    if (candidate !== undefined && candidate.source === recorded.source && candidate.sha === recorded.sha) {
      return { status: "resolved", base: persistedIssueBase(recorded), firstResolution: false };
    }
    if (candidate !== undefined && accepted && recorded.source === "dependency-base") {
      // D5: the dependency flow incorporated and recorded this exact head, and
      // the predecessor was accepted at it. Advance, declaring what is replaced.
      return {
        status: "resolved",
        base: { ...candidate, advancedFrom: { sha: recorded.sha, source: recorded.source } },
        firstResolution: false,
      };
    }
    // A base this contract never resolved against a predecessor never advances
    // (§4.1 rule 1): an Issue whose diff was taken from its branch start does
    // not silently become a stacked Issue, because the predecessor's test files
    // were this Issue's changes for every selection recorded so far and an
    // advance would drop them from the cumulative set. The disagreement is
    // `unavailable` for an operator, exactly like an unaccepted head.
    const now = candidate === undefined
      ? "no dependency base"
      : accepted
        ? `${candidate.source} ${candidate.sha}, accepted at that head`
        : `${candidate.source} ${candidate.sha} with no acceptance of that exact head`;
    const why = candidate !== undefined && accepted
      ? "a base recorded as branch-start never advances onto a predecessor"
      : "only an accepted, recorded predecessor update advances the base";
    return unavailable(
      "issue_base_changed",
      `the Issue base was recorded as ${recorded.source} ${recorded.sha} but the task now names ${now}; `
        + `${why} (§4.1 rule 1, D5)`,
    );
  }
  if (candidate !== undefined) return { status: "resolved", base: candidate, firstResolution: true };
  const start = input.readBranchStart();
  if (start.kind === "unreadable") return unavailable("branch_start_unreadable", start.reason);
  const sha = normalizedSha(start.sha);
  if (sha === undefined) {
    return unavailable("branch_start_unreadable", "the branch start is not a full commit SHA");
  }
  return { status: "resolved", base: { sha, source: "branch-start" }, firstResolution: true };
}

// ---------------------------------------------------------------------------
// The cumulative net change (§4.1 rules 2 and 3)
// ---------------------------------------------------------------------------

/** How a path's complete tree entry at the revision differs from the Issue base. */
export type CumulativePathChange = "added" | "modified" | "deleted";

export interface CumulativeChangeEntry {
  /** Repository-relative, as Git names it. */
  readonly path: string;
  readonly change: CumulativePathChange;
}

/**
 * The net change from the Issue base to the revision under test: committed,
 * staged, unstaged and untracked non-ignored content. A rename is a `deleted`
 * old path plus an `added` new one.
 */
export type CumulativeChangeRead =
  | { readonly kind: "readable"; readonly base: string; readonly entries: readonly CumulativeChangeEntry[] }
  | { readonly kind: "unreadable"; readonly reason: string };

// ---------------------------------------------------------------------------
// The retained set (§4.3)
// ---------------------------------------------------------------------------

/** One Issue-scoped obligation: a file a trusted Stage 2 outcome named `failed`. */
export interface RetainedTestFile {
  readonly file: string;
  /** `stageRunKey` of the Stage 2 run that first added it. */
  readonly addedBy: string;
}

export type RetainedTestFilesRead =
  | { readonly kind: "readable"; readonly files: readonly RetainedTestFile[] }
  | { readonly kind: "unreadable"; readonly reason: string };

export interface RetainedTestFileSet {
  readonly files: readonly RetainedTestFile[];
  readonly overflowed: boolean;
}

// ---------------------------------------------------------------------------
// Stage 1 selection (§4.2)
// ---------------------------------------------------------------------------

export type TestFileSelectionReason = "changed" | "retained";

/** Canonical order of a file's reasons. */
const SELECTION_REASONS: readonly TestFileSelectionReason[] = ["changed", "retained"];

export interface SelectedTestFile {
  readonly file: string;
  /** Non-empty, in `changed`, `retained` order. */
  readonly reasons: readonly TestFileSelectionReason[];
}

/** Which Stage 1 input could not be read (§3 R2). */
export const STAGE1_SELECTION_UNAVAILABLE_REASONS = [
  "issue-base",
  "cumulative-change",
  "runnable-file-report",
  "retained-set",
  "selection-bound",
] as const;

export type Stage1SelectionUnavailableReason = (typeof STAGE1_SELECTION_UNAVAILABLE_REASONS)[number];

export interface KnownStage1TestSelection {
  readonly status: "known";
  readonly issueBase: IssueBaseRecord;
  /** Sorted by id. Possibly empty. */
  readonly files: readonly SelectedTestFile[];
  /** Retained files the runnable-file report does not name, sorted. */
  readonly unresolvedRetained: readonly string[];
  /** {@link deriveTestFileSelectionDigest} over the three fields above. */
  readonly selectionDigest: string;
}

export type Stage1TestSelection =
  | KnownStage1TestSelection
  | {
      readonly status: "unavailable";
      readonly reason: Stage1SelectionUnavailableReason;
      readonly detail: string;
      /**
       * The Issue base, when it resolved and a later input did not (§4.1 rule 1):
       * the base is fixed once resolved, so it is recorded even though no
       * selection is known and a retry never resolves it again.
       */
      readonly issueBase?: IssueBaseRecord;
    };

export interface SelectStage1TestFilesInput {
  readonly issueBase: IssueBaseResolution;
  readonly change: CumulativeChangeRead;
  /** The runnable-file report at the revision under test. */
  readonly inventory: TestFileInventoryRead;
  readonly retained: RetainedTestFilesRead;
}

/**
 * sha256 over the canonical selection: the Issue base, each file with its
 * reasons, and the unresolved retained files. Two runs that would execute the
 * same files for the same reasons against the same base share a digest; any
 * change to membership, reason, base or an unresolved obligation moves it.
 */
export function deriveTestFileSelectionDigest(selection: {
  readonly issueBase: IssueBaseRecord;
  readonly files: readonly SelectedTestFile[];
  readonly unresolvedRetained: readonly string[];
}): string {
  const advancedFrom = selection.issueBase.advancedFrom;
  return sha256Hex(
    canonicalJsonStringify({
      issueBase: {
        sha: selection.issueBase.sha,
        source: selection.issueBase.source,
        // Only an advancing selection carries it, so a selection that moves no
        // base keeps the digest it had before D5 existed.
        ...(advancedFrom !== undefined ? { advancedFrom: [advancedFrom.sha, advancedFrom.source] } : {}),
      },
      files: [...selection.files]
        .sort((a, b) => compareIds(a.file, b.file))
        .map((entry) => [entry.file, SELECTION_REASONS.filter((reason) => entry.reasons.includes(reason))]),
      unresolvedRetained: [...selection.unresolvedRetained].sort(compareIds),
    }),
  );
}

/**
 * §4.2: **Selected = (changed paths that are runnable test files at the
 * revision) ∪ (retained files)**, deterministically.
 *
 * - An added, modified or untracked path is selected exactly when the runnable
 *   report names it; a deleted path selects nothing, so a rename selects only
 *   its new path. A changed source, helper, fixture or config path the report
 *   does not name selects nothing (Stage 2 covers it).
 * - A retained file is selected whenever the report names it, changed or not,
 *   passed since or not; one the report does not name is an unresolved
 *   obligation and stays listed.
 * - The first unreadable input, in the order base → change → report → retained
 *   set, makes the whole selection `unavailable`. A report that names an id
 *   twice or names a path that is not a file id is unreadable too: it cannot be
 *   an honest inventory. An unavailable selection past a resolved base still
 *   carries that base, so it is persisted and never resolved again.
 */
export function selectStage1TestFiles(input: SelectStage1TestFilesInput): Stage1TestSelection {
  const { issueBase, change, inventory, retained } = input;
  if (issueBase.status === "unavailable") {
    return { status: "unavailable", reason: "issue-base", detail: bounded(`${issueBase.reason}: ${issueBase.detail}`) };
  }
  const unavailable = (reason: Stage1SelectionUnavailableReason, detail: string): Stage1TestSelection => ({
    status: "unavailable",
    reason,
    detail: bounded(detail),
    // An advance the base resolution declared rides even an unavailable
    // selection: the record still persists the new base, so it must still say
    // which base it replaces (D5).
    issueBase: { ...issueBase.base },
  });
  if (change.kind === "unreadable") return unavailable("cumulative-change", change.reason);
  if (change.base !== issueBase.base.sha) {
    return unavailable(
      "cumulative-change",
      `the cumulative change was read against ${change.base}, not the Issue base ${issueBase.base.sha}`,
    );
  }
  if (inventory.kind === "unreadable") return unavailable("runnable-file-report", inventory.reason);
  const runnable = new Set<string>();
  for (const file of inventory.files) {
    if (!isPersistableTestFileId(file)) {
      return unavailable("runnable-file-report", `the report names ${JSON.stringify(file)}, which is not a test file id`);
    }
    if (runnable.has(file)) return unavailable("runnable-file-report", `the report names ${file} twice`);
    runnable.add(file);
  }
  if (retained.kind === "unreadable") return unavailable("retained-set", retained.reason);

  const reasons = new Map<string, Set<TestFileSelectionReason>>();
  const add = (file: string, reason: TestFileSelectionReason): void => {
    const held = reasons.get(file) ?? new Set<TestFileSelectionReason>();
    held.add(reason);
    reasons.set(file, held);
  };
  for (const entry of change.entries) {
    if (entry.change !== "deleted" && runnable.has(entry.path)) add(entry.path, "changed");
  }
  const unresolved = new Set<string>();
  for (const obligation of retained.files) {
    if (runnable.has(obligation.file)) add(obligation.file, "retained");
    else unresolved.add(obligation.file);
  }

  const files: SelectedTestFile[] = [...reasons.entries()]
    .sort(([a], [b]) => compareIds(a, b))
    .map(([file, held]) => ({ file, reasons: SELECTION_REASONS.filter((reason) => held.has(reason)) }));
  const unresolvedRetained = [...unresolved].sort(compareIds);
  if (files.length > MAX_STAGE_TEST_FILES || unresolvedRetained.length > MAX_RETAINED_TEST_FILES) {
    return unavailable(
      "selection-bound",
      `the selection names ${files.length} file(s) and ${unresolvedRetained.length} unresolved obligation(s), `
        + `over the ${MAX_STAGE_TEST_FILES}-file bound`,
    );
  }
  const base = issueBase.base;
  return {
    status: "known",
    issueBase: base,
    files,
    unresolvedRetained,
    selectionDigest: deriveTestFileSelectionDigest({ issueBase: base, files, unresolvedRetained }),
  };
}

/**
 * §2 boundary invariant 1 and §4.2: what a Stage 1 selection may hand to
 * execution. An unavailable selection is never an empty list, an empty known
 * selection never reaches execution, and a selection with an unresolved retained
 * file executes nothing.
 */
export type Stage1ExecutionPlan =
  | { readonly kind: "execute"; readonly request: Extract<TestExecutionRequest, { mode: "files" }> }
  | { readonly kind: "empty" }
  | { readonly kind: "retained-unresolved"; readonly files: readonly string[] }
  | { readonly kind: "unavailable"; readonly reason: Stage1SelectionUnavailableReason };

export function stage1ExecutionPlan(selection: Stage1TestSelection): Stage1ExecutionPlan {
  if (selection.status === "unavailable") return { kind: "unavailable", reason: selection.reason };
  if (selection.unresolvedRetained.length > 0) {
    return { kind: "retained-unresolved", files: [...selection.unresolvedRetained] };
  }
  if (selection.files.length === 0) return { kind: "empty" };
  return { kind: "execute", request: { mode: "files", files: selection.files.map((entry) => entry.file) } };
}

// ---------------------------------------------------------------------------
// Configuration identity of the suite binding (§6 rule 5, §8 invariant 1)
// ---------------------------------------------------------------------------

/**
 * The suite binding as a run used it: the bound key, the command bytes the
 * effective plan's active slot resolved for that key, and the operator's adapter
 * binding. The plan's own identity (digest and applied-through ordinal) is not
 * repeated here; it is already two components of the stage identity.
 */
export interface TestSuiteConfigurationInput {
  readonly key: string;
  readonly command: string;
  readonly adapter: string;
  readonly setupCommand?: string;
  readonly argumentSeparator?: string;
  /**
   * Issue #1166: the Issue-requirement commands the operator declared this
   * entry discharges. It decides which requirement a Stage 2 pass satisfies, so
   * evidence recorded under one declaration must not discharge a requirement a
   * later declaration introduced.
   */
  readonly requirementCommands?: readonly string[];
}

/**
 * sha256 over the canonical suite binding. Changing any field moves it.
 *
 * `requirementCommands` enters the canonical object only when the operator
 * declared it (issue #1166). A binding that declares none therefore keeps the
 * digest it already has, so shipping this field does not invalidate every stage
 * bundle in flight for a configuration whose meaning did not change.
 */
export function deriveTestSuiteBindingDigest(input: TestSuiteConfigurationInput): string {
  return sha256Hex(
    canonicalJsonStringify({
      key: input.key,
      command: input.command,
      adapter: input.adapter,
      setupCommand: input.setupCommand ?? null,
      argumentSeparator: input.argumentSeparator ?? null,
      ...(input.requirementCommands !== undefined
        ? { requirementCommands: [...input.requirementCommands] }
        : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// The persisted test-stage record (§2, §3)
// ---------------------------------------------------------------------------

/** §3's result names, R1–R13 (`passed` is one name for both stages). */
export const TEST_STAGE_RESULTS = [
  "termination-unknown",
  "unavailable",
  "retained-unresolved",
  "identity-unknown",
  "stale",
  "infrastructure",
  "failed",
  "timed-out",
  "incomplete",
  "empty",
  "passed",
  "no-evidence",
] as const;

export type TestStageResult = (typeof TEST_STAGE_RESULTS)[number];

/** Results whose conditions the record's own facts cannot contradict (§3 R1, R2, R4, R5). */
const PRE_EXECUTION_RESULTS: readonly TestStageResult[] = [
  "termination-unknown",
  "unavailable",
  "identity-unknown",
  "stale",
];

export interface TestFileOutcomeCounts {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly notRun: number;
}

/**
 * The Stage 1 selection reason for a runnable-file report deliberately left
 * unread: the launch identity is unattested, so discovery — the suite's own
 * tooling — is not launched (§3 R4). No input was unreadable, so its record is
 * `identity-unknown`, never R2's `unavailable`.
 */
export const STAGE1_SELECTION_NOT_READ_UNATTESTED = "launch-identity-unattested";

/** What the stage selected. Stage 1 records a selection; Stage 2 runs `full`. */
export type TestStageSelectionRecord =
  | KnownStage1TestSelection
  | { readonly status: "full" }
  /** `issueBase` only on Stage 1, for a base that resolved before a later input failed. */
  | { readonly status: "unavailable"; readonly reason: string; readonly issueBase?: IssueBaseRecord };

/**
 * The test half of one stage run's evidence bundle (`StageRunResult.testFiles`).
 *
 * It stores facts and counts, never per-file output: the failing files are the
 * only file list an outcome contributes, because they are the only one a later
 * run acts on. The identity the run was allocated under — revision, plan and the
 * suite binding digest as `selectionPolicyDigest` — rides the bundle beside it.
 */
export interface TestStageRecord {
  readonly result: TestStageResult;
  /** {@link deriveTestSuiteBindingDigest} of the binding the run used. */
  readonly suiteBindingDigest: string;
  readonly selection: TestStageSelectionRecord;
  /** Present exactly when a test run was requested. */
  readonly mode?: "files" | "full";
  /** Present with `mode`: `trusted`, or the one untrusted reason. */
  readonly trust?: "trusted" | TestOutcomeUntrustedReason;
  /** Present only for a run that ended on its own. */
  readonly processResult?: "succeeded" | "failed";
  /** Present exactly when `trust` is `trusted`. */
  readonly outcomeCounts?: TestFileOutcomeCounts;
  /**
   * Trusted `failed` outcomes only, sorted. Empty for an untrusted run. A
   * Stage 2 run with more than {@link MAX_STAGE_TEST_FILES} failed files keeps
   * the first that many and sets `failedFilesTruncated`.
   */
  readonly failedFiles: readonly string[];
  /**
   * Present, and `true`, only when `failedFiles` lists fewer files than
   * `outcomeCounts.failed`. Retaining from such a record overflows the
   * retained set (§4.3 rule 3), because the unlisted failures are obligations
   * nobody recorded.
   */
  readonly failedFilesTruncated?: true;
  /**
   * §2 failure evidence, present only with `mode`: the shipped bounded output
   * tail of the command that decided an incomplete run, the machine result's
   * artifact and each launched command's log artifact (run-artifact-relative,
   * in launch order). A failed, timed-out or incomplete run whose bundle holds
   * no check records has no other diagnostic for repair or handoff.
   */
  readonly outputTail?: string;
  readonly resultArtifact?: string;
  readonly logArtifacts?: readonly TestStageLogArtifact[];
}

export interface TestStageLogArtifact {
  readonly step: TestFileRunStepKind;
  readonly artifact: string;
}

const TEST_FILE_RUN_STEP_KINDS: readonly TestFileRunStepKind[] = ["setup", "discovery", "tests"];

/** The longest tail {@link boundVerificationOutput} returns: the bound plus its truncation marker. */
const MAX_TEST_STAGE_OUTPUT_TAIL_CHARS = MAX_VERIFICATION_OUTPUT_CHARS + "…(truncated)\n".length;

/** A run-artifact-relative path: bounded, relative, never escaping the run's artifact directory. */
function isRunArtifactPath(value: unknown): value is string {
  return (
    isBoundedText(value)
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && !value.split("/").includes("..")
  );
}

export interface BuildTestStageRecordInput {
  readonly result: TestStageResult;
  readonly suiteBindingDigest: string;
  readonly selection: TestStageSelectionRecord;
  /** The assembled run, when a test run was requested. */
  readonly run?: TestFileRunResult;
}

/** Copy a run's facts into the record shape. Trust is never upgraded here. */
export function buildTestStageRecord(input: BuildTestStageRecordInput): TestStageRecord {
  const { run } = input;
  if (run === undefined) {
    return {
      result: input.result,
      suiteBindingDigest: input.suiteBindingDigest,
      selection: input.selection,
      failedFiles: [],
    };
  }
  const trusted = run.trust.status === "trusted";
  const counts = { passed: 0, failed: 0, skipped: 0, notRun: 0 };
  if (trusted) {
    for (const entry of run.files) {
      if (entry.outcome === "not-run") counts.notRun += 1;
      else counts[entry.outcome] += 1;
    }
  }
  const failedFiles = trusted ? [...run.failedFiles].sort(compareIds) : [];
  const truncated = failedFiles.length > MAX_STAGE_TEST_FILES;
  const outputTail = run.outputTail === undefined ? "" : boundVerificationOutput(run.outputTail);
  const logArtifacts = run.steps.flatMap((step) =>
    step.logArtifact !== undefined ? [{ step: step.step, artifact: step.logArtifact }] : [],
  );
  return {
    result: input.result,
    suiteBindingDigest: input.suiteBindingDigest,
    selection: input.selection,
    mode: run.mode,
    trust: run.trust.status === "trusted" ? "trusted" : run.trust.reason,
    ...(run.processResult !== undefined ? { processResult: run.processResult } : {}),
    ...(trusted ? { outcomeCounts: counts } : {}),
    failedFiles: truncated ? failedFiles.slice(0, MAX_STAGE_TEST_FILES) : failedFiles,
    ...(truncated ? { failedFilesTruncated: true as const } : {}),
    ...(outputTail !== "" ? { outputTail } : {}),
    ...(run.resultArtifact !== undefined ? { resultArtifact: run.resultArtifact } : {}),
    ...(logArtifacts.length > 0 ? { logArtifacts } : {}),
  };
}

/** Validate a record's §2 failure evidence against whether it requested a run. */
function failureEvidenceProblem(value: Record<string, unknown>, path: string): string | undefined {
  if (value.mode === undefined) {
    if (value.outputTail !== undefined || value.resultArtifact !== undefined || value.logArtifacts !== undefined) {
      return `${path}: run evidence recorded for a record that requested no run`;
    }
    return undefined;
  }
  const tail = value.outputTail;
  if (tail !== undefined && (typeof tail !== "string" || tail.length === 0 || tail.length > MAX_TEST_STAGE_OUTPUT_TAIL_CHARS)) {
    return `${path}.outputTail: not a non-empty output tail within the ${MAX_VERIFICATION_OUTPUT_CHARS}-character bound`;
  }
  if (value.resultArtifact !== undefined && !isRunArtifactPath(value.resultArtifact)) {
    return `${path}.resultArtifact: not a run-artifact-relative path`;
  }
  const logs = value.logArtifacts;
  if (logs !== undefined) {
    if (!Array.isArray(logs) || logs.length === 0 || logs.length > TEST_FILE_RUN_STEP_KINDS.length) {
      return `${path}.logArtifacts: not a non-empty list of at most ${TEST_FILE_RUN_STEP_KINDS.length} entries`;
    }
    const seen = new Set<unknown>();
    for (let i = 0; i < logs.length; i += 1) {
      const entry: unknown = logs[i];
      if (!isPlainObject(entry) || !(TEST_FILE_RUN_STEP_KINDS as readonly unknown[]).includes(entry.step)) {
        return `${path}.logArtifacts[${i}].step: not one of setup | discovery | tests`;
      }
      if (seen.has(entry.step)) return `${path}.logArtifacts[${i}].step: ${String(entry.step)} recorded twice`;
      seen.add(entry.step);
      if (!isRunArtifactPath(entry.artifact)) return `${path}.logArtifacts[${i}].artifact: not a run-artifact-relative path`;
    }
  }
  return undefined;
}

function sortedDistinctIdsProblem(value: unknown, path: string, bound: number): string | undefined {
  if (!Array.isArray(value)) return `${path}: not an array`;
  if (value.length > bound) return `${path}: ${value.length} entries exceeds the ${bound}-file bound`;
  for (let i = 0; i < value.length; i += 1) {
    if (!isPersistableTestFileId(value[i])) return `${path}[${i}]: not a test file id`;
    if (i > 0 && compareIds(value[i - 1] as string, value[i] as string) >= 0) {
      return `${path}[${i}]: not sorted and distinct`;
    }
  }
  return undefined;
}

/**
 * Validate a persisted {@link IssueBaseRecord}.
 *
 * `advancedFrom` (decision D5) is admitted only on a selection record, and only
 * when it names a different commit than the base it advanced to and the base
 * that replaced it is a predecessor head. `allowAdvance` is false for the
 * task's own persisted base, which keeps no advance.
 */
export function issueBaseRecordProblem(value: unknown, path: string, allowAdvance = false): string | undefined {
  if (!isPlainObject(value)) return `${path}: not an object`;
  if (!isCommitSha(value.sha)) return `${path}.sha: not a full lowercase commit SHA`;
  if (!(ISSUE_BASE_SOURCES as readonly unknown[]).includes(value.source)) {
    return `${path}.source: not one of dependency-base | branch-start`;
  }
  const advancedFrom = value.advancedFrom;
  if (advancedFrom === undefined) return undefined;
  if (!allowAdvance) return `${path}.advancedFrom: recorded outside a Stage 1 selection`;
  if (!isPlainObject(advancedFrom)) return `${path}.advancedFrom: not an object`;
  if (!isCommitSha(advancedFrom.sha)) return `${path}.advancedFrom.sha: not a full lowercase commit SHA`;
  if (!(ISSUE_BASE_SOURCES as readonly unknown[]).includes(advancedFrom.source)) {
    return `${path}.advancedFrom.source: not one of dependency-base | branch-start`;
  }
  if (value.source !== "dependency-base") {
    return `${path}.advancedFrom: only an accepted predecessor head advances the Issue base (§4.1 rule 1, D5)`;
  }
  if (advancedFrom.sha === value.sha && advancedFrom.source === value.source) {
    return `${path}.advancedFrom: names the base it advanced to`;
  }
  return undefined;
}

function knownSelectionProblem(value: Record<string, unknown>, path: string): string | undefined {
  const baseIssue = issueBaseRecordProblem(value.issueBase, `${path}.issueBase`, true);
  if (baseIssue) return baseIssue;
  const files = value.files;
  if (!Array.isArray(files)) return `${path}.files: not an array`;
  if (files.length > MAX_STAGE_TEST_FILES) {
    return `${path}.files: ${files.length} entries exceeds the ${MAX_STAGE_TEST_FILES}-file bound`;
  }
  for (let i = 0; i < files.length; i += 1) {
    const entry: unknown = files[i];
    if (!isPlainObject(entry) || !isPersistableTestFileId(entry.file)) return `${path}.files[${i}].file: not a test file id`;
    if (i > 0 && compareIds((files[i - 1] as SelectedTestFile).file, entry.file) >= 0) {
      return `${path}.files[${i}]: not sorted and distinct`;
    }
    const reasons = entry.reasons;
    if (
      !Array.isArray(reasons)
      || reasons.length === 0
      || reasons.join(",") !== SELECTION_REASONS.filter((reason) => reasons.includes(reason)).join(",")
    ) {
      return `${path}.files[${i}].reasons: not a non-empty list of changed | retained in that order`;
    }
  }
  const unresolvedIssue = sortedDistinctIdsProblem(value.unresolvedRetained, `${path}.unresolvedRetained`, MAX_RETAINED_TEST_FILES);
  if (unresolvedIssue) return unresolvedIssue;
  const selected = new Set((files as SelectedTestFile[]).map((entry) => entry.file));
  const both = (value.unresolvedRetained as string[]).find((file) => selected.has(file));
  if (both !== undefined) return `${path}.unresolvedRetained: ${both} is also selected`;
  const digest = deriveTestFileSelectionDigest(value as unknown as KnownStage1TestSelection);
  if (value.selectionDigest !== digest) return `${path}.selectionDigest: does not cover the recorded selection`;
  return undefined;
}

/**
 * Validate one persisted {@link TestStageRecord} for a run of `stage` (`loop`
 * is Stage 1, `final` is Stage 2). Refuses shape errors and every record whose
 * result its own facts contradict:
 *
 * - Stage 1 records a known or unavailable selection and never `no-evidence`;
 *   Stage 2 records `full` or unavailable and never `empty` or
 *   `retained-unresolved`.
 * - A run is requested only for a known non-empty Stage 1 selection with no
 *   unresolved obligation, or for Stage 2's `full` (§2 invariant 1) — or, with
 *   untrusted outcomes, for a Stage 1 whose runnable-file report is unread
 *   because its setup or discovery command did not succeed (§6 rule 3).
 * - A process result is absent under a `deadline`, `interrupted` or
 *   `spawn-failure` trust reason and present for trusted or
 *   `mismatched-files` outcomes (§2 process result).
 * - Failed files require trusted outcomes, and name only selected files in
 *   Stage 1 (§2 invariant 2).
 * - `passed` needs a complete run with at least one passed file (R11, R13),
 *   `no-evidence` a complete run with none (R12), `empty` an empty Stage 1
 *   selection that executed nothing **or** a complete Stage 1 whose selected
 *   files were every one `skipped`, so no test ran (R10, decision D6),
 *   `failed` and `infrastructure` a failed process result or a trusted failed
 *   file (R6, R7), `timed-out` a deadline (R8), and `incomplete` a run that is
 *   not complete and recorded no failed process and no trusted failed file
 *   (R9, which R7 pre-empts).
 */
export function testStageRecordProblem(value: unknown, path: string, stage: "loop" | "final"): string | undefined {
  if (!isPlainObject(value)) return `${path}: not an object`;
  if (!(TEST_STAGE_RESULTS as readonly unknown[]).includes(value.result)) {
    return `${path}.result: not one of the closed result set`;
  }
  const result = value.result as TestStageResult;
  if (!isDigest(value.suiteBindingDigest)) return `${path}.suiteBindingDigest: not a sha256 digest`;

  const selection = value.selection;
  if (!isPlainObject(selection)) return `${path}.selection: not an object`;
  if (selection.status === "known") {
    if (stage !== "loop") return `${path}.selection: a known file selection belongs to Stage 1 only`;
    const problem = knownSelectionProblem(selection, `${path}.selection`);
    if (problem) return problem;
  } else if (selection.status === "full") {
    if (stage !== "final") return `${path}.selection: a full run belongs to Stage 2 only`;
  } else if (selection.status === "unavailable") {
    if (!isBoundedText(selection.reason)) return `${path}.selection.reason: not bounded text`;
    if (selection.issueBase !== undefined) {
      if (stage !== "loop") return `${path}.selection.issueBase: only a Stage 1 selection reads the Issue base`;
      if (selection.reason === "issue-base") {
        return `${path}.selection.issueBase: recorded for a selection whose Issue base did not resolve`;
      }
      const baseIssue = issueBaseRecordProblem(selection.issueBase, `${path}.selection.issueBase`, true);
      if (baseIssue) return baseIssue;
    }
  } else {
    return `${path}.selection.status: not one of known | full | unavailable`;
  }
  const known = selection.status === "known" ? (selection as unknown as KnownStage1TestSelection) : undefined;

  const mode = value.mode;
  if (mode !== undefined) {
    if (mode === "files") {
      if (stage === "loop" && selection.status === "unavailable" && selection.reason === "runnable-file-report") {
        // §6 rule 3: the setup or discovery that left the report unread ended
        // with a known process outcome, which the record carries instead of R2.
        if (value.trust === "trusted") {
          return `${path}.trust: a Stage 1 run whose runnable-file report is unread has no trusted outcomes`;
        }
      } else if (known === undefined || known.files.length === 0 || known.unresolvedRetained.length > 0) {
        return `${path}.mode: a files run needs a known, non-empty Stage 1 selection with no unresolved obligation`;
      }
    } else if (mode === "full") {
      if (selection.status !== "full") return `${path}.mode: a full run needs a Stage 2 full selection`;
    } else {
      return `${path}.mode: not one of files | full`;
    }
  } else if (selection.status === "full" && result !== "incomplete" && !PRE_EXECUTION_RESULTS.includes(result)) {
    return `${path}.mode: a Stage 2 "${result}" result needs the run it describes`;
  }

  const trust = value.trust;
  if (mode === undefined) {
    if (trust !== undefined || value.processResult !== undefined || value.outcomeCounts !== undefined) {
      return `${path}: run facts recorded for a record that requested no run`;
    }
  } else if (trust !== "trusted" && !(UNTRUSTED_REASONS as readonly unknown[]).includes(trust)) {
    return `${path}.trust: not trusted or one of the closed untrusted reasons`;
  }
  const evidenceIssue = failureEvidenceProblem(value, path);
  if (evidenceIssue) return evidenceIssue;
  const processResult = value.processResult;
  if (processResult !== undefined && processResult !== "succeeded" && processResult !== "failed") {
    return `${path}.processResult: not one of succeeded | failed`;
  }
  // §2 process result: recorded whenever the run ended on its own. A deadline,
  // interruption or spawn failure did not, so a process result beside one
  // would route a timeout as a code failure (R6, R7 over R8, R9). Trusted and
  // mismatched outcomes were read from an ended command, so theirs is required;
  // `unreadable-result` also covers a run that launched no command at all.
  if (mode !== undefined) {
    if ((NOT_SELF_ENDED_REASONS as readonly unknown[]).includes(trust)) {
      if (processResult !== undefined) {
        return `${path}.processResult: recorded for a run that did not end on its own ("${String(trust)}")`;
      }
    } else if ((trust === "trusted" || trust === "mismatched-files") && processResult === undefined) {
      return `${path}.processResult: a run whose outcomes are "${trust}" ended on its own and records its process result`;
    }
  }
  let counts: TestFileOutcomeCounts | undefined;
  if (trust === "trusted") {
    const raw = value.outcomeCounts;
    if (
      !isPlainObject(raw)
      || !isNonNegativeInteger(raw.passed)
      || !isNonNegativeInteger(raw.failed)
      || !isNonNegativeInteger(raw.skipped)
      || !isNonNegativeInteger(raw.notRun)
    ) {
      return `${path}.outcomeCounts: not four non-negative integer counts`;
    }
    counts = raw as unknown as TestFileOutcomeCounts;
    if (mode === "files" && known !== undefined) {
      const total = counts.passed + counts.failed + counts.skipped + counts.notRun;
      if (total !== known.files.length) {
        return `${path}.outcomeCounts: ${total} outcome(s) for ${known.files.length} selected file(s)`;
      }
    }
  } else if (value.outcomeCounts !== undefined) {
    return `${path}.outcomeCounts: recorded for untrusted outcomes`;
  }

  const failedIssue = sortedDistinctIdsProblem(value.failedFiles, `${path}.failedFiles`, MAX_STAGE_TEST_FILES);
  if (failedIssue) return failedIssue;
  const failedFiles = value.failedFiles as readonly string[];
  const truncated = value.failedFilesTruncated;
  if (truncated !== undefined) {
    // Only a full run can fail more files than a record lists; a Stage 1 run
    // never selects more than the bound.
    if (truncated !== true || stage !== "final" || counts === undefined
      || failedFiles.length !== MAX_STAGE_TEST_FILES || counts.failed <= MAX_STAGE_TEST_FILES) {
      return `${path}.failedFilesTruncated: recorded for a run that is not a trusted Stage 2 run with more than ${MAX_STAGE_TEST_FILES} failed files, of which the first ${MAX_STAGE_TEST_FILES} are listed`;
    }
  } else if (counts === undefined) {
    if (failedFiles.length > 0) return `${path}.failedFiles: failed files recorded for untrusted outcomes`;
  } else if (counts.failed !== failedFiles.length) {
    return `${path}.failedFiles: ${failedFiles.length} file(s) for ${counts.failed} failed outcome(s)`;
  }
  if (known !== undefined) {
    const selected = new Set(known.files.map((entry) => entry.file));
    const stray = failedFiles.find((file) => !selected.has(file));
    if (stray !== undefined) return `${path}.failedFiles: ${stray} was not selected`;
  }

  const complete = counts !== undefined && processResult === "succeeded" && counts.notRun === 0;
  /**
   * Decision D6: a complete Stage 1 that reached every selected file and
   * executed none of them. It progresses as `empty` — it never claims a pass
   * and never satisfies the full-suite requirement (O4).
   */
  const allSkipped = stage === "loop" && complete && counts !== undefined
    && counts.passed === 0 && counts.failed === 0 && counts.skipped > 0;

  if (selection.status === "unavailable") {
    if (selection.reason === STAGE1_SELECTION_NOT_READ_UNATTESTED) {
      if (stage !== "loop" || result !== "identity-unknown") {
        return `${path}.result: "${result}" for a Stage 1 selection left unread under an unattested launch identity (§3 R4)`;
      }
    } else if (result !== "termination-unknown" && result !== "unavailable" && mode === undefined) {
      // A record that requested no run is R1 or R2; one carrying the setup or
      // discovery process outcome is classified by that outcome.
      return `${path}.result: "${result}" for an unavailable selection (§3 R1, R2)`;
    }
  }
  // R2 is an unreadable input or a launch-time plan refusal: the run never
  // launched, so a record carrying run facts under it would hide a trusted
  // outcome — a Stage 2 failure recorded this way would retain nothing.
  if (result === "unavailable" && mode !== undefined) {
    return `${path}.result: "unavailable" for a record that requested a run (§3 R2)`;
  }
  if (known !== undefined && known.unresolvedRetained.length > 0
    && result !== "retained-unresolved" && !PRE_EXECUTION_RESULTS.includes(result)) {
    return `${path}.result: "${result}" for a selection with an unresolved retained file (§3 R3)`;
  }
  if (known !== undefined && known.files.length === 0 && known.unresolvedRetained.length === 0
    && result !== "empty" && !PRE_EXECUTION_RESULTS.includes(result)) {
    return `${path}.result: "${result}" for an empty selection (§3 R10)`;
  }

  const wrong = (why: string): string => `${path}.result: "${result}" ${why}`;
  switch (result) {
    case "retained-unresolved":
      if (known === undefined || known.unresolvedRetained.length === 0) {
        return wrong("needs a Stage 1 selection with an unresolved retained file (§3 R3)");
      }
      break;
    case "empty":
      if (known === undefined || known.unresolvedRetained.length > 0) {
        return wrong("needs a Stage 1 selection with no unresolved retained file (§3 R3, R10)");
      }
      // Decision D6 widened R10: either nothing was selected, or everything
      // selected was reached and skipped, so either way no test executed.
      if (known.files.length > 0 && !allSkipped) {
        return wrong(
          "needs an empty Stage 1 selection, or a complete run whose selected files were every one skipped (§3 R10)",
        );
      }
      break;
    case "no-evidence":
      if (stage !== "final" || !complete || counts === undefined || counts.passed > 0 || counts.failed > 0) {
        return wrong("needs a complete Stage 2 run with no passed and no failed file (§3 R12)");
      }
      break;
    case "passed":
      if (!complete || counts === undefined || counts.failed > 0 || counts.passed === 0) {
        return wrong("needs a complete run with no failed file and at least one passed file (§3 R11, R13)");
      }
      break;
    case "failed":
      if (mode === undefined || (processResult !== "failed" && failedFiles.length === 0)) {
        return wrong("needs a run with a failed process result or a trusted failed file (§3 R7)");
      }
      break;
    case "infrastructure":
      if (mode === undefined || processResult !== "failed") {
        return wrong("needs a run with a failed process result (§3 R6)");
      }
      break;
    case "timed-out":
      if (trust !== "deadline") return wrong("needs outcomes untrusted for a deadline (§3 R8)");
      break;
    case "incomplete":
      // A confirmed deadline is always R8: recording it here would route the
      // suite's own overrun through automatic recovery instead of repair.
      if (trust === "deadline") return wrong("needs outcomes not untrusted for a deadline, which is `timed-out` (§3 R8, R9)");
      // R7 wins first for a trusted failed file too: that run is `failed`, and
      // recording it as `incomplete` would drop the file from retention.
      if (mode !== undefined && (complete || processResult === "failed" || failedFiles.length > 0)) {
        return wrong("needs a run that is not complete and recorded no failed process result and no trusted failed file (§3 R7, R9)");
      }
      break;
    default:
      break;
  }
  if (stage === "loop" && result === "no-evidence") return wrong("belongs to Stage 2 only");
  if (stage === "final" && (result === "empty" || result === "retained-unresolved")) {
    return wrong("belongs to Stage 1 only");
  }
  return undefined;
}

const UNTRUSTED_REASONS: readonly TestOutcomeUntrustedReason[] = [
  "deadline",
  "interrupted",
  "spawn-failure",
  "unreadable-result",
  "mismatched-files",
];

/** The untrusted reasons under which the command did not end on its own (§2). */
const NOT_SELF_ENDED_REASONS: readonly TestOutcomeUntrustedReason[] = ["deadline", "interrupted", "spawn-failure"];

// ---------------------------------------------------------------------------
// Retention (§4.3)
// ---------------------------------------------------------------------------

/**
 * The retained set after one stage run is recorded.
 *
 * Only a Stage 2 (`final`) record whose result is `failed` and whose outcomes
 * are trusted adds, and it adds exactly its failed files that are not already
 * retained — so a repeated failure deduplicates and keeps the run that first
 * added the file. Nothing removes an entry: a later pass in either stage, a
 * grant, or a file that is no longer runnable leaves it in place.
 *
 * Past {@link MAX_RETAINED_TEST_FILES} the entries already held are kept, the
 * rest are not added, and `overflowed` is set for good: nobody can say which
 * obligation went unrecorded, so every later selection reads the set as
 * unreadable rather than as smaller than it is. A record whose failed files
 * were truncated overflows the set the same way, after its listed files are
 * added.
 */
export function nextRetainedTestFiles(
  prior: RetainedTestFileSet,
  run: { readonly stage: "loop" | "final"; readonly stageRunKey: string; readonly record?: TestStageRecord },
): RetainedTestFileSet {
  const record = run.record;
  if (run.stage !== "final" || record === undefined || record.result !== "failed" || record.trust !== "trusted") {
    return prior;
  }
  const held = new Set(prior.files.map((entry) => entry.file));
  const files = [...prior.files];
  let overflowed = prior.overflowed;
  for (const file of record.failedFiles) {
    if (held.has(file)) continue;
    if (files.length >= MAX_RETAINED_TEST_FILES) {
      overflowed = true;
      break;
    }
    held.add(file);
    files.push({ file, addedBy: run.stageRunKey });
  }
  if (record.failedFilesTruncated === true) overflowed = true;
  return { files, overflowed };
}

/** The retained set as a selection reads it: an overflowed set is unreadable. */
export function readRetainedTestFileSet(set: RetainedTestFileSet): RetainedTestFilesRead {
  if (set.overflowed) {
    return {
      kind: "unreadable",
      reason: `the retained set exceeded its ${MAX_RETAINED_TEST_FILES}-file bound, so an obligation may be unrecorded`,
    };
  }
  return { kind: "readable", files: set.files };
}
