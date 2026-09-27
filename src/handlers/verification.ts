import { writeFileSync } from "fs";
import { join } from "path";
import type { CommandRunner } from "./command-runner.js";
import type { VerificationCommands } from "../core/session.js";
import { matchesConfiguredVerificationCommand } from "../core/tool-request-continuation.js";
import { boundVerificationOutput } from "../core/verification-output.js";
import {
  evaluateVerificationEvidenceBinding,
  type VerificationEvidenceRejection,
} from "../core/verification-evidence.js";
import {
  buildCheckExecutionRecord,
  classifyCheckExecution,
} from "../core/verification-result.js";
import {
  stageCheckHostFailure,
  stageCheckTerminationUnconfirmed,
  type StageCheckOutcome,
} from "../core/stage-run.js";

// ---------------------------------------------------------------------------
// Shell tokenizer
//
// Splits a verification command string into argv tokens, honouring single and
// double quotes so a command like `npm run "lint:all"` is tokenized correctly.
// ---------------------------------------------------------------------------

export function parseShellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'") {
      i++;
      while (i < command.length && command[i] !== "'") {
        current += command[i++];
      }
      i++; // closing quote
    } else if (ch === '"') {
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) {
          i++;
          current += command[i++];
        } else {
          current += command[i++];
        }
      }
      i++; // closing quote
    } else if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      i++;
    } else {
      current += ch;
      i++;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

// ---------------------------------------------------------------------------
// Output bound
//
// `MAX_VERIFICATION_OUTPUT_CHARS` / `boundVerificationOutput` are pure string
// policy shared with `core/` (issue #1029), so they are declared in
// `core/verification-output.ts` and re-exported here unchanged — see that
// module's header.
// ---------------------------------------------------------------------------

export { MAX_VERIFICATION_OUTPUT_CHARS, boundVerificationOutput } from "../core/verification-output.js";

// Capture buffer for a verification command's combined stdout+stderr. Verbose
// but passing commands (a full `npm test` or build log) can exceed Node's
// default 1 MiB `execFileSync` buffer, which makes the default runner throw —
// surfacing as a non-zero exit before `boundVerificationOutput` can trim the
// log, so a passing command would be misreported as a failed verification.
// Capture generously here and let `boundVerificationOutput` trim only the
// stored feedback. Keep it aligned with the worker's command buffer (80 MiB).
export const MAX_VERIFICATION_BUFFER_BYTES = 80 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Verification runner
// ---------------------------------------------------------------------------

export interface VerificationFailure {
  /** Name of the failing verification command (the key in session.verification). */
  name: string;
  /** Exit code returned by the failing command. */
  exitCode: number;
  /** Bounded combined stdout+stderr from the failing command. */
  output: string;
}

export interface VerificationOutcome {
  passed: boolean;
  /** One entry per command that was run, in order, up to and including any failure. */
  results: { name: string; passed: boolean }[];
  /** Present only when passed === false. */
  failure?: VerificationFailure;
  /**
   * Staged verification (issue #1102, `docs/staged-verification-contract.md`
   * §13 slice S3): one {@link StageCheckOutcome} per SELECTED execution check,
   * present only when the caller passed a {@link StageVerificationExecution}.
   *
   * Present for every selected check, passed and failed alike, including the
   * remainder this site never reached — the fail-fast stop records those as
   * `not-run` with `notRunKind: "first-failure-stop"` rather than leaving them
   * unexplained (§6.2 rule 3). Absent entirely on the legacy path, where there
   * is no stage and nothing to record.
   */
  stageChecks?: StageCheckOutcome[];
}

/**
 * One required execution check, as the stage resolved it. The command bytes are
 * the plan's, not `session.verification`'s, so an operator amendment that
 * replaced a slot runs the replacement.
 */
export interface StageExecutionCheck {
  /** #1037 §5.1 identity: always an `exec:<name>` id at this site. */
  readonly checkId: string;
  /** The operator-authored name — the `verification-<name>.log` path component. */
  readonly name: string;
  readonly command: string;
}

/**
 * §9's "stage-scoped check map passed into the existing sites": what a stage
 * run tells {@link runVerification} to execute, in the order it must run.
 *
 * Passing it changes *which* checks run and *what is recorded*, never how a
 * check is executed, bounded, or logged: the spawn, the buffer, the artifact
 * name and the first-failure stop are the shipped ones. Omitting it is the
 * legacy path, byte for byte.
 */
export interface StageVerificationExecution {
  readonly checks: readonly StageExecutionCheck[];
  /**
   * When set (with an `artifactDir`), each executed check's log is also
   * snapshotted to `<logSnapshotPrefix>-<name>.log` and the stage record points
   * at that copy. The shipped `${logPrefix}-<name>.log` is still written, but a
   * later run (a repair re-verification) overwrites it, so a bundle bound to it
   * would link another run's output.
   */
  readonly logSnapshotPrefix?: string;
  /**
   * Issue #1103: a per-check deadline, for a lane whose shipped site bounds
   * every command. The review lane's final stage runs under
   * `session.reviewLoop.verificationTimeoutMs` (#1090), process-tree-isolated,
   * so a hung check expires as `timed-out` instead of blocking the phase. Absent
   * is the implementation lane's shipped unbounded spawn, byte for byte.
   */
  readonly commandTimeoutMs?: number;
}

/** Status of a single verification command extracted from the issue body. */
export interface IssueRequiredVerification {
  /** The raw command string as it appeared in the issue body. */
  command: string;
  /**
   * Whether the command was run and passed, run and failed, or not run at
   * all. `retired` (issue #1043, amendment contract §8.4) marks a requirement
   * slot an operator amendment retired: excluded from the gate, reported
   * distinctly, and never a passing result. Only the review gate emits it —
   * {@link buildIssueVerificationStatus} never does. `pending_full_suite`
   * (issue #1154, `docs/changed-file-verification-contract.md` §5 rule 4) marks
   * a requirement only the bound test suite entry satisfies before Stage 2
   * passes at the approved revision: neither passed nor missing, and never a
   * blocker of the review that reaches Stage 2. Only the review gate emits it.
   */
  status: "passed" | "failed" | "not_run" | "retired" | "pending_full_suite";
  /** Exit code when status is "failed". */
  exitCode?: number;
  /** Bounded failure output when status is "failed". */
  failureSummary?: string;
  /**
   * Issue #1040: why matching-but-inadmissible manual evidence was rejected
   * (distinct reasons, evaluation order). Present only under evidence-binding
   * enforcement, and only when at least one matching entry was rejected.
   */
  evidenceRejections?: readonly VerificationEvidenceRejection[];
}

/**
 * Returns true when a session verification value is considered equivalent to a
 * required command. Handles two cases:
 *
 * 1. Exact match (trimmed strings are equal).
 * 2. Shell-wrapper equivalence: an entry like `bash -lc 'cd frontend && npm test'`
 *    is a runnable form of the compound command `cd frontend && npm test` that the
 *    extractor records. Comparing by inner command prevents compound directory-
 *    scoped checks from being permanently blocked as "not_run".
 *
 * The semantics live in core (`matchesConfiguredVerificationCommand`) because
 * the Tool Request direct-review continuation (issue #722,
 * `docs/verification-execution-contract.md` §10.2) classifies a resolved
 * request's command against `session.verification` with EXACTLY this rule; two
 * copies of it could drift apart and let the two surfaces disagree about what
 * counts as a configured verification command.
 */
const matchesRequiredCommand = matchesConfiguredVerificationCommand;

/** Evidence of a manually-executed verification command supplied by the operator. */
export interface ManualVerificationEntry {
  /** The command string as supplied by the operator. */
  command: string;
  /** Exit code from running the command. */
  exitCode: number;
  /** Bounded, sanitized output from the command. */
  output: string;
  /** ISO timestamp when the evidence was recorded. */
  recordedAt: string;
  /** How the evidence was supplied: e.g. "operator_input". */
  source: string;
  /**
   * Issue #1040 binding — stamped by `admin review-verification resolve` so
   * the evidence is admissible only for the plan revision, slot identity, and
   * reviewed commit it actually tested. Entries recorded before #1040 lack
   * these fields and are conservatively rejected under binding enforcement.
   */
  /** §5.4 digest of the effective verification plan at recording time. */
  planDigest?: string;
  /** `appliedThroughOrdinal` of that plan; 0 for an unamended task. */
  planRevisionOrdinal?: number;
  /** §5.1 identity of the requirement slot the evidence was recorded for. */
  commandId?: string;
  /** The reviewed branch HEAD SHA the evidence was recorded against. */
  headSha?: string;
  /** §8.3 rule 1 per-slot invalidation records; absent when none. */
  invalidations?: readonly { commandId: string; supersededByRevision: string }[];
}

/**
 * Issue #1040: the current run's evidence-binding expectations. When passed to
 * {@link buildIssueVerificationStatus}, a manual evidence entry satisfies a
 * required command only when `core/verification-evidence.ts` admits it —
 * recorded slot identity, plan resolvability, §8.3 invalidations, and the
 * reviewed HEAD all checked, with legacy unbound evidence conservatively
 * rejected. Omitted, the shipped pre-#1040 semantics apply unchanged.
 */
export interface IssueVerificationEvidenceExpectations {
  /** The reviewed HEAD of the current run; absent = unresolvable, fail closed. */
  headSha?: string;
  /** The current effective plan digest; absent = unresolvable, fail closed. */
  planDigest?: string;
  /**
   * Trimmed required command bytes → the §5.1 `commandId` of the ACTIVE
   * requirement slot carrying them. A required command absent from the map is
   * not in the current effective plan, so no evidence can satisfy it.
   */
  commandIds?: Readonly<Record<string, string>>;
}

/**
 * Match extracted issue-required commands against what session.verification
 * actually ran. Each required command is matched by comparing its string
 * (trimmed) to the VALUES in `sessionVerification`, including shell-wrapped
 * equivalents such as `bash -lc '<cmd>'`.
 *
 * Called after session.verification has been fully executed with no failures,
 * so any matched command is known to have passed. Unmatched commands are
 * marked "not_run", unless operator-supplied `manualEvidence` covers the
 * command with a passing (exit 0) result.
 *
 * With `evidenceExpectations` (issue #1040), a manual entry additionally
 * satisfies a required command only when the evidence-binding rule admits it
 * for that command's plan slot; rejected candidates surface their reasons on
 * the returned entry. The equivalence rule itself is unchanged — an entry
 * still has to match under `matchesConfiguredVerificationCommand`, and a
 * renamed or similar-looking command is never inferred equivalent.
 */
export function buildIssueVerificationStatus(
  requiredCommands: string[],
  sessionVerification: VerificationCommands,
  manualEvidence?: ManualVerificationEntry[],
  evidenceExpectations?: IssueVerificationEvidenceExpectations,
): IssueRequiredVerification[] {
  const sessionValues = Object.values(sessionVerification).map((c) => c.trim());
  const evidence = manualEvidence ?? [];
  return requiredCommands.map((command): IssueRequiredVerification => {
    const req = command.trim();
    if (sessionValues.some((sv) => matchesRequiredCommand(sv, req))) {
      return { command, status: "passed" };
    }
    const candidates = evidence.filter((e) => matchesRequiredCommand(e.command, req));
    if (evidenceExpectations === undefined) {
      const manualEntry = candidates.find((e) => e.exitCode === 0);
      if (manualEntry !== undefined) {
        return { command, status: "passed" };
      }
      return { command, status: "not_run" };
    }
    const rejections: VerificationEvidenceRejection[] = [];
    for (const candidate of candidates) {
      const verdict = evaluateVerificationEvidenceBinding(candidate, {
        headSha: evidenceExpectations.headSha,
        planDigest: evidenceExpectations.planDigest,
        commandId: evidenceExpectations.commandIds?.[req],
      });
      if (verdict.admissible) {
        return { command, status: "passed" };
      }
      if (!rejections.includes(verdict.reason)) rejections.push(verdict.reason);
    }
    return {
      command,
      status: "not_run",
      ...(rejections.length > 0 ? { evidenceRejections: rejections } : {}),
    };
  });
}

/**
 * Run each configured verification command in order, stopping at the first
 * failure. Writes a per-command log under `artifactDir` when provided.
 *
 * An empty verification map passes trivially.
 *
 * With `stage` (issue #1102), the checks a stage run SELECTED are executed
 * instead of the whole `verification` map, and one {@link StageCheckOutcome} is
 * recorded per selected check — including the remainder the first-failure stop
 * never reached, which is recorded as an accounted absence rather than left
 * unexplained (`docs/staged-verification-contract.md` §6.2 rule 3). Everything
 * else is unchanged: the same spawn, the same buffer, the same
 * `${logPrefix}-<name>.log` artifact, the same stop at the first nonzero exit,
 * and the same {@link VerificationOutcome} the shipped callers route on. With
 * `stage` omitted nothing above runs at all.
 */
export function runVerification(
  runner: CommandRunner,
  verification: VerificationCommands,
  cwd: string,
  artifactDir?: string,
  logPrefix = "verification",
  stage?: StageVerificationExecution,
): VerificationOutcome {
  const results: { name: string; passed: boolean }[] = [];
  // The stage's selection is the check map when there is one (§9); otherwise
  // the whole configured map, exactly as before.
  const entries: { name: string; command: string; check?: StageExecutionCheck }[] =
    stage === undefined
      ? Object.entries(verification).map(([name, command]) => ({ name, command }))
      : stage.checks.map((check) => ({ name: check.name, command: check.command, check }));
  const stageChecks: StageCheckOutcome[] | undefined = stage === undefined ? undefined : [];
  /** Every selected check from `index` on, recorded as an accounted absence. */
  const recordUnreached = (index: number, notRunReason: string): void => {
    if (stageChecks === undefined) return;
    for (const remaining of entries.slice(index)) {
      if (remaining.check === undefined) continue;
      stageChecks.push({
        record: buildCheckExecutionRecord({
          checkId: remaining.check.checkId,
          name: remaining.check.name,
          command: remaining.check.command,
          notRunKind: "first-failure-stop",
          notRunReason,
        }),
      });
    }
  };

  for (let i = 0; i < entries.length; i += 1) {
    const { name, command, check } = entries[i] as { name: string; command: string; check?: StageExecutionCheck };
    const [verCmd, ...verArgs] = parseShellTokens(command);
    if (!verCmd) {
      // Skip empty command strings rather than spawning an empty process.
      results.push({ name, passed: true });
      if (stageChecks !== undefined && check !== undefined) {
        // A command with no argv proves nothing, so it is never a stage's
        // `passed`: the legacy trivial pass stays for routing, and the bundle
        // records an absence nobody can account for (§6.1).
        stageChecks.push({
          record: buildCheckExecutionRecord({
            checkId: check.checkId,
            name: check.name,
            command: check.command,
            notRunKind: "evidence-lost",
            notRunReason: "the configured command has no executable token",
          }),
        });
      }
      continue;
    }
    const startedAtMs = Date.now();
    const r = runner.run(verCmd, verArgs, {
      cwd,
      maxBuffer: MAX_VERIFICATION_BUFFER_BYTES,
      ...(stage?.commandTimeoutMs !== undefined
        ? { timeout: stage.commandTimeoutMs, isolateProcessGroup: true }
        : {}),
    });
    if (artifactDir) {
      writeFileSync(join(artifactDir, `${logPrefix}-${name}.log`), r.stdout + r.stderr, "utf8");
    }
    if (stageChecks !== undefined && check !== undefined) {
      // The record binds to an immutable per-stage copy when one is requested;
      // a snapshot that cannot be written leaves the record without a log
      // reference rather than pointing at bytes a later run will replace.
      let logArtifact: string | undefined = artifactDir ? `${logPrefix}-${name}.log` : undefined;
      if (artifactDir && stage?.logSnapshotPrefix !== undefined) {
        const snapshot = `${stage.logSnapshotPrefix}-${name}.log`;
        try {
          writeFileSync(join(artifactDir, snapshot), r.stdout + r.stderr, "utf8");
          logArtifact = snapshot;
        } catch {
          logArtifact = undefined;
        }
      }
      stageChecks.push({
        record: buildCheckExecutionRecord({
          checkId: check.checkId,
          name: check.name,
          command: check.command,
          run: r,
          startedAtMs,
          ...(logArtifact !== undefined ? { logArtifact } : {}),
        }),
        // The host-versus-change judgment is the shipped classifiers' (#934,
        // #897), read once here and never re-derived downstream.
        hostFailure: stageCheckHostFailure(classifyCheckExecution(name, r)),
        // Issue #1106 (#1096 §4.5 rule 3): a kill whose process-tree sweep could
        // not confirm the group is gone leaves a process in the worktree.
        ...(stageCheckTerminationUnconfirmed(r) ? { terminationUnconfirmed: true } : {}),
      });
    }
    if (r.exitCode !== 0) {
      results.push({ name, passed: false });
      recordUnreached(i + 1, `the stage stopped at the first failing check (${name})`);
      return {
        passed: false,
        results,
        failure: {
          name,
          exitCode: r.exitCode,
          output: boundVerificationOutput([r.stdout, r.stderr].filter(Boolean).join("\n")),
        },
        ...(stageChecks !== undefined ? { stageChecks } : {}),
      };
    }
    results.push({ name, passed: true });
  }
  return { passed: true, results, ...(stageChecks !== undefined ? { stageChecks } : {}) };
}
