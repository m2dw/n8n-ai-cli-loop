/**
 * Issue #1068: the runner-prompted structured Codex review invocation.
 *
 * This is an INVOCATION adapter and nothing else. It builds the argv/stdin/output
 * contract for the supported `codex exec` path, hands the CLI a JSON Schema for
 * the §2.1 finding envelope, runs it under the shared isolation boundary, and
 * returns one validated {@link ParsedReviewEnvelope} or one typed failure.
 *
 * ## What it deliberately does not do
 *
 * It is not wired into review routing. Nothing in `handlers/review.ts` calls it,
 * `codex review` behaves byte for byte as before, and `codex` remains in
 * {@link STRUCTURED_FINDINGS_UNSUPPORTED_AGENTS} — so a session with the dispute
 * protocol enabled still runs the §13 legacy prose path for a Codex reviewer.
 * Selecting this lane for a real review is decision D1 of
 * `docs/review-dispute-contract.md` §17.6, and §17.9 makes that an operator's to
 * record, not an adapter's to assume. It also does not admit findings: minting
 * lineages, stamping `reviewerMeta`, and resolving §3.3 evidence against the
 * checkout all belong to the handler that selects this lane.
 *
 * ## The boundary this invocation actually enforces
 *
 * A review is not a §8.2 turn: it reads the checkout by design, so the bundle is
 * NOT the entire input and the `no-tools` posture does not apply — and §17.5
 * refuses that literal for Codex outright. The posture recorded here is
 * `read-bounded`, the name §17.7 gives it, and what it means is exactly:
 *
 *  - **no writes and no network for agent-owned commands** — `--sandbox read-only`,
 *    which §17.4 grades `vendor-documented` (C4). Never a bypass flag; there is no
 *    switch on this module that can produce one.
 *  - **no operator agent configuration** — `--ignore-user-config` (C5), which is
 *    load-bearing rather than decorative: the isolated environment points
 *    `CODEX_HOME` back at the operator's real `~/.codex` so the CLI's own login is
 *    reachable, and the `config.toml` holding MCP servers and hooks lives there.
 *  - **no operator HOME** — the invocation runs under a throwaway `HOME`. The
 *    profile records `read-bounded`, but `buildIsolatedInvocation` is told
 *    `tool-capable`, which is the conservative direction: only an Anthropic
 *    `no-tools` turn inherits the real home (issue #935), and a Codex review has
 *    a reachable command tool.
 *  - **no GitHub credentials** — every write-enabling token is stripped and
 *    `GH_CONFIG_DIR` is pinned at an empty temp dir, so a prompt-injected `gh`
 *    finds nothing to authenticate with.
 *  - **an ENFORCED deadline** — the child is spawned in its own process group, so
 *    issue #1060's escalation watchdog is armed and a CLI that traps the
 *    deadline's `SIGTERM` is force-killed with its whole tree rather than waited
 *    out. Without the group, `timeoutMs` is a request the agent may decline.
 *
 * The cwd is the checkout under review, which is what makes this a review rather
 * than a bundle judgement, and the sandbox is what keeps the working branch
 * unchanged.
 *
 * ## Three streams, three destinations
 *
 * `codex exec --json` writes JSONL progress events to stdout; the CLI's own
 * diagnostics go to stderr; the runner's spawn diagnostics are synthesized by the
 * command runner and appended to stderr. None of those is the review. The review
 * is the FINAL MESSAGE, which `--output-last-message` writes to a file this module
 * owns — so the response is never recovered by scraping a stream that also carries
 * progress, and a noisy CLI cannot corrupt a clean review.
 *
 * Every one of them is preserved locally, each in its own artifact, whatever the
 * exit code; the runner-written spawn bytes are peeled back off stderr first, so
 * no artifact claims runner prose as the agent's.
 *
 * ## The schema is assistance, the validation is the contract
 *
 * `--output-schema` is `vendor-documented` (§17.4 C6), and §17.2 is explicit that
 * a documented mechanism is never an attestation. So the response is admitted by
 * {@link parseReviewFindingsEnvelope} on every path — a CLI that ignored the
 * schema, honored it partially, or does not implement it at all reaches exactly
 * the same gate. A build that REFUSES the flag is a distinct outcome
 * (`unsupported-capability`), never a review that found nothing.
 *
 * The flag is therefore **opt-in and off by default**: §17.7 admits it "only once
 * C6 is `verified`", and pinning how this runner constructs a flag is not
 * evidence that a build honors it. What is delivered here is the whole mechanism
 * — the derived schema, the argv, the temporary file, the refusal path — ready
 * for the successor that brings §17.8's canary. Everything else about the
 * invocation is unaffected by the switch.
 */

import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bothStreamsCommandRunner, type CommandRunner } from "./command-runner.js";
import { isSafeArtifactDirAfterRun } from "./artifact-dir.js";
import {
  UnsafeArtifactDirError,
  UnsafeArtifactPathError,
  agentSetupDetail,
  boundRawOutput as boundStream,
  buildIsolatedInvocation,
  readBoundedArtifact,
  writeArtifactFile,
  writeContainedArtifactFile,
} from "./agent-isolation.js";
import { resolveCodexContextMode } from "./codex-context-mode.js";
import { CODEX_STRUCTURED_EXEC_ARGS } from "../core/codex-runtime-adapter.js";
import type { CodexConfig } from "../core/session.js";
import { legacyRuntimeSettingSource, runtimeCmdSource } from "./agent-runtime.js";
import type { AgentPhaseRuntime, LegacyRuntimeSource } from "./agent-runtime.js";
import {
  buildReviewFindingsJsonSchema,
  stripNullEnvelopeMembers,
  type JsonSchema,
} from "../core/review-findings-schema.js";
import {
  REVIEW_FINDINGS_ENVELOPE_MAX_BYTES,
  extractReviewFindingsEnvelope,
  parseReviewFindingsEnvelope,
  reviewFindingsInstructions,
  reviewResolvableEvidenceKinds,
  type ParsedReviewEnvelope,
  type ReviewPromptLineage,
} from "../core/review-finding-envelope.js";
import type { ReviewDisputeFailure } from "../core/review-dispute-validation.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Default deadline for one structured review.
 *
 * A runner-owned bound, in the shape every other agent turn in this protocol
 * carries — and stricter than the unbounded `codex review` of the ordinary lane,
 * which is a deliberate difference and the wiring successor's to confirm. §17.7:
 * "the deadline is the only cancellation, and it is the runner's"; a run that hit
 * it is reported as `timeout`, never as a review that failed.
 */
export const DEFAULT_CODEX_STRUCTURED_REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

/** Output buffer ceiling for the agent subprocess. */
const CODEX_REVIEW_MAX_BUFFER = 16 * 1024 * 1024;

/** The bound on each raw stream this module preserves locally. */
export const MAX_CODEX_REVIEW_RAW_BYTES = 1024 * 1024;

/**
 * The bound on the final-message FILE, applied before any of it is in memory.
 *
 * Deliberately looser than the §2.1 envelope bound: the final message may carry a
 * review report as well as the envelope, and it is
 * {@link extractReviewFindingsEnvelope} — the domain gate — that refuses an
 * oversized PAYLOAD, with its own `payload-too-large`. This bound only stops a
 * runaway file from being read whole.
 */
export const MAX_CODEX_REVIEW_RESPONSE_BYTES = 1024 * 1024;

function boundRawOutput(text: string): string {
  return boundStream(text, MAX_CODEX_REVIEW_RAW_BYTES);
}

// ---------------------------------------------------------------------------
// Artifacts (§10.2, run-owned and local-only)
// ---------------------------------------------------------------------------

/** The runner-authored prompt, exactly as delivered on stdin. */
export const CODEX_REVIEW_PROMPT_ARTIFACT = "codex-review-prompt.md";
/** The JSON Schema handed to the CLI, byte-identical to the temporary copy. */
export const CODEX_REVIEW_SCHEMA_ARTIFACT = "codex-review-schema.json";
/** The final message, verbatim — the only stream that is the review. */
export const CODEX_REVIEW_RESPONSE_ARTIFACT = "codex-review-response.txt";
/** `--json` progress events from stdout; never parsed for the verdict. */
export const CODEX_REVIEW_EVENTS_ARTIFACT = "codex-review-events.jsonl";
/** The agent's own stderr, with any runner-written spawn bytes removed. */
export const CODEX_REVIEW_STDERR_ARTIFACT = "codex-review-stderr.txt";
/** Bytes the RUNNER wrote about a spawn-level failure, under a name that says so. */
export const CODEX_REVIEW_RUNNER_ERROR_ARTIFACT = "codex-review-runner-error.txt";

// ---------------------------------------------------------------------------
// The resolved profile
// ---------------------------------------------------------------------------

/**
 * The `codex exec` flags this contract pins, in argv order, minus the run-owned
 * file paths and the `-c` overrides.
 *
 * `--skip-git-repo-check` is included unconditionally: it only disables a refusal
 * to START outside a git checkout, never a boundary, and pinning it makes the
 * invocation independent of whether the caller's cwd happens to be a repository.
 *
 * The list itself is owned by the Codex runtime adapter
 * (src/core/codex-runtime-adapter.ts, issue #908), which declares it as this
 * lane's posture; it is imported rather than restated so the two cannot drift
 * while this lane's cutover onto that adapter is pending.
 */
export const CODEX_STRUCTURED_REVIEW_EXEC_ARGS: readonly string[] =
  CODEX_STRUCTURED_EXEC_ARGS;

/** Every flag whose refusal by the CLI is an unsupported capability, not a review. */
export const CODEX_STRUCTURED_REVIEW_PINNED_FLAGS: readonly string[] = [
  "--sandbox",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "--json",
  "--output-last-message",
  "--output-schema",
];

export interface ResolvedCodexStructuredReviewProfile {
  phase: "review";
  /** Distinguishes this run from the ordinary `codex review` of the same phase. */
  role: "structured-review";
  agentId: "codex";
  cmd: string;
  /**
   * Binary path source (issue #912): the catalog overlay can point this
   * provider at an operator-supplied executable, and the diagnostics boundary
   * reads this field to withhold stderr trust from such an invocation.
   */
  cmdSource: "env" | "cli-default" | "catalog-builtin" | "catalog-overlay";
  /**
   * Sanitized argv: the prompt travels on stdin, and the two run-owned file paths
   * are spliced in at invocation time (see {@link buildCodexStructuredReviewArgv}).
   * A local command line is not protocol state, and a temp path is not a fact
   * about the review.
   */
  argv: string[];
  /** Absent means `cli-default` — no `--model` is passed and the CLI's own applies. */
  model?: string;
  modelSource: LegacyRuntimeSource | "cli-default";
  /**
   * The catalog-validated reasoning effort (§14.3): a string the boundary
   * already checked against the provider's capability descriptor, never a
   * TypeScript union this lane re-narrows — an overlay declaring a further
   * tier is a data edit (§6.2), honored here without a source change.
   */
  effort: string;
  effortSource: LegacyRuntimeSource;
  provider: string;
  /**
   * §17.7: the posture this argv enforces. NEVER `no-tools` — §17.5 refuses that
   * literal for Codex, because `--sandbox read-only` bounds writes and network
   * while leaving reads available.
   */
  toolPolicy: "read-bounded";
  /** Which optional CLI capabilities this invocation pins. */
  capabilities: { outputSchema: boolean; jsonEvents: boolean };
  contextMode: "enabled" | "unset";
  contextModeSource: "session" | "env" | "default";
  contextModeConfig?: string[];
  /** `--profile`, when context-mode configured one. A GLOBAL option. */
  contextModeProfile?: string;
}

export interface CodexStructuredReviewArgvPaths {
  /** `--output-last-message` target. Absent only in the sanitized argv. */
  lastMessagePath?: string;
  /** `--output-schema` target. Absent when the capability is not pinned. */
  schemaPath?: string;
}

/**
 * Compose the argv for one invocation.
 *
 * The ordering rule is the one the existing Codex lanes already follow and is not
 * cosmetic: `--model` and `--profile` are GLOBAL Codex options and must precede
 * the subcommand, while `-c` overrides are accepted after it. Splicing a global
 * after `exec` makes the CLI fail argument parsing before the review starts.
 */
export function buildCodexStructuredReviewArgv(
  profile: ResolvedCodexStructuredReviewProfile,
  paths: CodexStructuredReviewArgvPaths = {},
): string[] {
  const argv: string[] = [];
  if (profile.model !== undefined) argv.push("--model", profile.model);
  if (profile.contextModeProfile !== undefined) argv.push("--profile", profile.contextModeProfile);
  argv.push(...CODEX_STRUCTURED_REVIEW_EXEC_ARGS);
  if (paths.lastMessagePath !== undefined) argv.push("--output-last-message", paths.lastMessagePath);
  if (profile.capabilities.outputSchema && paths.schemaPath !== undefined) {
    argv.push("--output-schema", paths.schemaPath);
  }
  argv.push("-c", `model_reasoning_effort=${profile.effort}`);
  for (const entry of profile.contextModeConfig ?? []) argv.push("-c", entry);
  return argv;
}

export interface CodexStructuredReviewProfileInput {
  /** The configured review agent id; only `codex` has this invocation. */
  agentId?: string;
  /**
   * The runtime this run resolved through the boundary's `structured_exec`
   * lane (issue #912). Model, effort, and binary come from it — `CODEX_EFFORT`
   * and `CODEX_MODEL` keep their precedence as the boundary's validated §8.1
   * layer-1 overrides, and `session.codex.model` is no longer read by this
   * lane (set `model` on an `openai` profile instead).
   */
  runtime: AgentPhaseRuntime;
  /** Session Codex config, read here only for the context-mode form (#376). */
  codex?: CodexConfig;
  /**
   * Pin `--output-schema` (§17.4 C6).
   *
   * **Off by default**, and that is the contract rather than caution: §17.7's
   * argv row admits the flag "only once C6 is `verified`", and C6 is
   * `vendor-documented` — a grade §17.2 credits as documentation, never as
   * attestation. This module does not get to promote it: the fixtures below pin
   * how the runner CONSTRUCTS the flag, which is not the same claim as a build
   * having honored it, and §17.9 reserves a change to that row for a successor
   * that brings §17.8's evidence.
   *
   * Nothing is lost by the default. The schema is assistance; admission is
   * {@link parseReviewFindingsEnvelope} either way, so a review that runs without
   * the flag is judged by exactly the same rule as one that runs with it.
   */
  outputSchema?: boolean;
  env?: NodeJS.ProcessEnv;
}

export type CodexStructuredReviewProfileResolution =
  | { profile: ResolvedCodexStructuredReviewProfile }
  | { error: string; kind: "unsupported-agent" | "configuration-error" };

/**
 * Resolve the structured-review invocation for the configured agent.
 *
 * Fail-closed on an agent other than `codex`: this module is one CLI's invocation
 * contract, and every other supported reviewer either has its own lane or has no
 * structured-review invocation defined at all. Adding one means adding its argv
 * here, never widening this check.
 */
export function resolveCodexStructuredReviewProfile(
  input: CodexStructuredReviewProfileInput,
): CodexStructuredReviewProfileResolution {
  const agent = input.agentId ?? "codex";
  if (agent !== "codex") {
    return {
      kind: "unsupported-agent",
      error:
        `Unsupported structured-review agent: ${agent}. This lane is the \`codex exec\` invocation contract `
        + "(docs/review-dispute-contract.md §17.7). Supported: codex",
    };
  }
  const env = input.env ?? process.env;
  // Resolved BEFORE the argv so an invalid operator configuration fails the run
  // before a billed Codex turn starts, exactly as the ordinary lane does.
  const ctxMode = resolveCodexContextMode(input.codex, env);
  if (ctxMode.status === "error") {
    return { kind: "configuration-error", error: ctxMode.error };
  }
  // Model, effort, and binary come from the boundary's `structured_exec`
  // resolution (issue #912): the §8.1 ladder already applied `CODEX_MODEL` /
  // `CODEX_EFFORT` as validated overrides, and the catalog validated every
  // value against the `openai` capability descriptor before this call.
  const resolved = input.runtime.resolved;
  const effortValue = resolved.effort.value;
  // §14.3: the resolved effort is a string the catalog already validated
  // against the `openai` capability descriptor, so a descriptor declaring a
  // further tier (an overlay data edit, §6.2) runs here with no source change
  // — re-imposing a three-value ceiling would refuse configurations the
  // boundary accepted. Only an ABSENT value refuses: this lane always pins an
  // explicit `-c model_reasoning_effort` override, and a resolution that
  // produced no effort has nothing honest for that override to carry.
  if (effortValue === undefined) {
    return {
      kind: "configuration-error",
      error:
        `profile "${resolved.profileName}" resolves no reasoning effort; `
        + "the structured review lane pins an explicit model_reasoning_effort override",
    };
  }
  const contextModeProfile = ctxMode.status === "enabled" ? ctxMode.profile : undefined;
  const contextModeConfig = ctxMode.status === "enabled" ? [...ctxMode.config] : [];
  const profile: ResolvedCodexStructuredReviewProfile = {
    phase: "review",
    role: "structured-review",
    agentId: "codex",
    cmd: input.runtime.command,
    cmdSource: runtimeCmdSource(resolved),
    argv: [],
    // An unset model stays ABSENT (§17.7): `--model` is not passed and the
    // profile records `cli-default`, which is no model at all rather than a
    // guessed one.
    ...(resolved.model.value === undefined ? {} : { model: resolved.model.value }),
    modelSource:
      resolved.model.value === undefined
        ? "cli-default"
        : legacyRuntimeSettingSource(resolved.model, resolved, input.runtime.quality),
    effort: effortValue,
    effortSource: legacyRuntimeSettingSource(resolved.effort, resolved, input.runtime.quality),
    provider: resolved.provider,
    toolPolicy: "read-bounded",
    capabilities: { outputSchema: input.outputSchema === true, jsonEvents: true },
    contextMode: ctxMode.status === "enabled" ? "enabled" : "unset",
    contextModeSource: ctxMode.source,
    ...(contextModeConfig.length > 0 ? { contextModeConfig } : {}),
    ...(contextModeProfile !== undefined ? { contextModeProfile } : {}),
  };
  return { profile: { ...profile, argv: buildCodexStructuredReviewArgv(profile) } };
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export interface CodexStructuredReviewPromptInput {
  /** The runner-authored review brief. The successor owns what goes in it. */
  brief: string;
  /** Whether this run captured the Issue body, which decides §3.3 `issue_quote`. */
  issueBodyAvailable?: boolean;
  /** §2.2 open lineages a re-raise may attach to. */
  liveLineages?: readonly ReviewPromptLineage[];
}

/**
 * The runner-authored prompt: the caller's brief, then the §2.1 envelope
 * instruction.
 *
 * The instruction is {@link reviewFindingsInstructions} verbatim — the same text
 * every structured reviewer is given — rather than a Codex-specific restatement.
 * Two copies of the envelope brief would eventually disagree, and the one that
 * disagreed would be describing a shape admission refuses.
 */
export function buildCodexStructuredReviewPrompt(input: CodexStructuredReviewPromptInput): string {
  const liveLineages = input.liveLineages ?? [];
  return [
    input.brief.trimEnd(),
    "",
    reviewFindingsInstructions({
      issueBodyAvailable: input.issueBodyAvailable === true,
      ...(liveLineages.length > 0 ? { liveLineages } : {}),
    }),
    "",
    // The final message is what the runner reads; a review whose verdict is only
    // in the progress stream is not one this contract can admit.
    "Your FINAL message is the only output that is read. Put the envelope there.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The agent seam
// ---------------------------------------------------------------------------

export interface CodexStructuredReviewInvocation {
  prompt: string;
  timeoutMs: number;
  /** The checkout under review — the agent's cwd, bounded by the read-only sandbox. */
  cwd: string;
}

/** Why the final message is absent, when it is. */
export type CodexFinalMessageFailure = "missing" | "too-large" | "stale";

export interface CodexStructuredReviewAgentResult {
  /** `--json` progress events. Never the verdict. */
  stdout: string;
  stderr: string;
  exitCode: number;
  spawnError?: string;
  /** The errno of a spawn-level failure, preserved rather than reduced to prose. */
  spawnErrorCode?: string;
  timedOut?: boolean;
  /** The final message, read from the run-owned output file. */
  finalMessage: string | null;
  finalMessageFailure: CodexFinalMessageFailure | null;
  /** The argv actually spawned, run-owned paths included. */
  argv: string[];
  /** The serialized schema handed to the CLI, or `null` when none was. */
  schema: string | null;
  /** Where the CLI was allowed to look for its own login (§17.7's environment row). */
  homePolicy: "throwaway" | "inherit";
}

/** Injectable so a test can exercise the whole path without spawning an agent. */
export type CodexStructuredReviewAgentRunner = (
  invocation: CodexStructuredReviewInvocation,
) => CodexStructuredReviewAgentResult;

export interface CodexStructuredReviewRunnerOptions {
  /** The subprocess seam. Must preserve stderr on a zero exit (see below). */
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam for the run-owned temp directory that holds the schema and the
   * final-message file.
   *
   * The default is a fresh `mkdtemp` per invocation, which is what makes a stale
   * final message structurally impossible in production. It is injectable so the
   * refusal itself can be exercised: without a seam, the only test for
   * "the output file predates this run" would be one that cannot be written.
   */
  makeRunDir?: () => string;
}

/**
 * The default runner: the resolved profile's command, the prompt on stdin, the
 * checkout as cwd, and a credential-stripped environment.
 *
 * The schema and the final-message file live in a temp directory this module
 * creates and removes on every exit path — never in the checkout (which would
 * dirty the working branch) and never under the operator's home. What survives is
 * the run-owned COPY the caller writes into the artifact directory.
 *
 * @param runner Defaults to `bothStreamsCommandRunner`, not `defaultCommandRunner`:
 * `execFileSync` discards the stderr it buffered once a command exits 0, and this
 * contract preserves both streams whatever the exit code.
 */
export function createCodexStructuredReviewAgentRunner(
  profile: ResolvedCodexStructuredReviewProfile,
  schema: JsonSchema | null,
  options: CodexStructuredReviewRunnerOptions = {},
): CodexStructuredReviewAgentRunner {
  const runner = options.runner ?? bothStreamsCommandRunner;
  const env = options.env ?? process.env;
  const makeRunDir = options.makeRunDir ?? (() => mkdtempSync(join(tmpdir(), "ai-codex-review-io-")));
  const serializedSchema =
    profile.capabilities.outputSchema && schema !== null ? `${JSON.stringify(schema, null, 2)}\n` : null;
  return (invocation) => {
    const isolated = buildIsolatedInvocation(env, {
      prefix: "ai-codex-review",
      provider: profile.provider,
      // `read-bounded` is not a home policy this table knows, and the safe
      // translation is the restrictive one: a Codex review has a reachable
      // command tool, so it gets the throwaway home every tool-capable
      // invocation gets. Only an Anthropic `no-tools` turn inherits the real one.
      toolPolicy: "tool-capable",
    });
    // `buildIsolatedInvocation` has already created the directories it named, so
    // the run directory is created INSIDE the cleanup scope: a `makeRunDir` that
    // throws (`ENOSPC`, a vanished `TMPDIR`) would otherwise return through this
    // function leaving the isolation directories behind, once per failed setup.
    let runDir: string | null = null;
    try {
      runDir = makeRunDir();
      const lastMessagePath = join(runDir, "final-message.txt");
      const schemaPath = join(runDir, "output-schema.json");
      // The run directory is fresh, so this file cannot be a leftover — and the
      // check is here rather than assumed because "the response is this run's" is
      // the property everything downstream rests on. A pre-existing file is
      // refused BEFORE the CLI is spawned: reading it afterwards would report
      // another run's verdict as this one's.
      if (existsSync(lastMessagePath)) {
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          finalMessage: null,
          finalMessageFailure: "stale",
          argv: [],
          schema: serializedSchema,
          homePolicy: isolated.homePolicy,
        };
      }
      if (serializedSchema !== null) writeArtifactFile(runDir, "output-schema.json", serializedSchema);
      const argv = buildCodexStructuredReviewArgv(profile, {
        lastMessagePath,
        ...(serializedSchema !== null ? { schemaPath } : {}),
      });
      const childEnv: NodeJS.ProcessEnv = { ...isolated.env };
      // The checkout is the cwd, so `PWD` names it: `buildIsolatedInvocation`
      // pinned it at the throwaway directory this lane does not use, and an agent
      // whose reported cwd disagrees with its actual one is a debugging trap.
      childEnv["PWD"] = invocation.cwd;
      const result = runner.run(profile.cmd, argv, {
        cwd: invocation.cwd,
        env: childEnv,
        stdin: invocation.prompt,
        timeout: invocation.timeoutMs,
        maxBuffer: CODEX_REVIEW_MAX_BUFFER,
        // Without this the deadline above is only a REQUEST. `spawnSync`'s own
        // timeout sends `SIGTERM` to the direct child and then keeps blocking
        // this thread until the child chooses to exit — so a CLI that traps or
        // ignores the signal makes `timeoutMs` unenforceable, and the phase this
        // adapter runs under waits out the agent rather than the deadline.
        // Issue #1060's escalation watchdog is armed exactly when a deadline and
        // a process group are both present: it `SIGKILL`s the whole group after
        // the deadline plus its grace, which nothing can trap.
        //
        // A Codex review is also a process TREE, not one process — the CLI spawns
        // the commands its read-only sandbox permits — so the group is what has to
        // be signalled for `terminateProcessTree` to have anything to sweep. A
        // child left behind holds the run-owned temp directory this function is
        // about to remove, and could still be writing the final message the
        // caller is about to read.
        isolateProcessGroup: true,
      });
      const read = readBoundedArtifact(lastMessagePath, MAX_CODEX_REVIEW_RESPONSE_BYTES);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        ...(result.spawnError === undefined ? {} : { spawnError: result.spawnError }),
        ...(result.spawnErrorCode === undefined ? {} : { spawnErrorCode: result.spawnErrorCode }),
        ...(result.timedOut === undefined ? {} : { timedOut: result.timedOut }),
        finalMessage: read.ok ? read.raw : null,
        finalMessageFailure: read.ok ? null : read.reason === "too-large" ? "too-large" : "missing",
        argv,
        schema: serializedSchema,
        homePolicy: isolated.homePolicy,
      };
    } finally {
      for (const dir of [...(runDir === null ? [] : [runDir]), ...isolated.cleanup]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // A leftover temp dir is not worth failing a completed invocation for.
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * The invocation-level failure vocabulary.
 *
 * Distinct from the §12 protocol vocabulary, as the reconsideration lane's is:
 * "the CLI does not accept `--output-schema`" is an operational fact about a
 * build, not a statement about a record's admissibility. A failure that DID come
 * from admission carries the §12 failure verbatim in `protocol`.
 */
export const CODEX_STRUCTURED_REVIEW_FAILURE_KINDS = [
  /** No structured-review invocation is defined for the configured agent. */
  "unsupported-agent",
  /** The operator's Codex configuration could not be resolved into an invocation. */
  "configuration-error",
  /** A supplied artifact directory is not a real directory inside the session's root. */
  "unsafe-artifact-dir",
  /** An artifact's own file name is a symlink; writing it would leave the directory. */
  "unsafe-artifact-path",
  /** A local artifact could not be preserved. */
  "artifact-write-failed",
  /** The CLI refused a flag this contract pins (§17.4 C4–C7). Never a review. */
  "unsupported-capability",
  /** The runner's deadline killed the run (§17.7). Distinct from a nonzero exit. */
  "timeout",
  /** The agent exited nonzero, or never ran because its invocation could not start. */
  "agent-failed",
  /** The run finished but wrote no final message where the argv said to. */
  "missing-output",
  /** The final-message file predates this invocation; it is not this run's answer. */
  "stale-output",
  /** The final-message file is past the byte bound this module reads under. */
  "oversized-output",
  /** The run exited zero and produced a blank final message. */
  "empty-output",
  /** The final message could not be admitted as a §2.1 envelope (§12). */
  "malformed-response",
  /** §13: the response carries no envelope at all — a legacy prose review. */
  "envelope-absent",
] as const;
export type CodexStructuredReviewFailureKind = (typeof CODEX_STRUCTURED_REVIEW_FAILURE_KINDS)[number];

export interface CodexStructuredReviewFailure {
  kind: CodexStructuredReviewFailureKind;
  /** Content-free locator: a flag name, an exit code, a field path. */
  detail: string | null;
  /** The §12 failure behind a `malformed-response`. */
  protocol?: ReviewDisputeFailure;
}

/**
 * Phrases a CLI uses when it does not recognize an argument.
 *
 * Matched only against stderr, and only on a nonzero exit. Neither condition is
 * incidental: the review itself is the final MESSAGE, written to a file, so a
 * reviewer's own prose can never reach this test — stderr carries the CLI's
 * diagnostics and nothing else. Argument parsing fails before any turn is billed,
 * which is exactly why "the build refused a flag" is worth telling apart from "a
 * review ran and failed": one is a capability to grade in §17.4, the other is an
 * operational incident.
 */
const UNRECOGNIZED_ARGUMENT_RE =
  /unexpected argument|unrecognized (?:option|argument|subcommand)|unknown (?:flag|option|argument)|wasn't expected|invalid option/i;

/**
 * The pinned flag a refusal names, when the diagnostic names one.
 *
 * The flag is looked for on the LINE that carries the refusal before the stream
 * as a whole, because an argument parser typically follows its complaint with a
 * usage block listing every flag it does accept — and the first pinned flag in
 * THAT would name whichever one this module happens to list first rather than the
 * one the build refused.
 *
 * Exported (issue #1085) because the §17.7 argv is one contract with two callers:
 * this review lane and the `read-bounded` reconsideration lane. "The build refused
 * a flag this runner pins" must be the same observation on both, so the caller
 * supplies the flags IT pinned and the recognition rule stays here. It is not a
 * general-purpose stderr classifier: it is only meaningful on a NONZERO exit,
 * where argument parsing failed before any turn was billed.
 */
export function codexRefusedCapability(
  stderr: string,
  pinnedFlags: readonly string[] = CODEX_STRUCTURED_REVIEW_PINNED_FLAGS,
): string | null {
  if (!UNRECOGNIZED_ARGUMENT_RE.test(stderr)) return null;
  const named = (haystack: string): string | null => {
    for (const flag of pinnedFlags) {
      if (haystack.includes(flag)) return flag;
    }
    return null;
  };
  for (const line of stderr.split("\n")) {
    if (!UNRECOGNIZED_ARGUMENT_RE.test(line)) continue;
    const onLine = named(line);
    if (onLine !== null) return onLine;
  }
  // The refusal named no flag this contract pins. It is still a refusal to start,
  // not a review, so it is reported as one — with no flag to blame.
  return named(stderr) ?? "unknown-flag";
}

/**
 * The refusal every artifact write raises when the directory it was handed is no
 * longer the real directory inside `artifactRoot` that was admitted.
 *
 * Thrown rather than returned so it travels the same path as an `O_NOFOLLOW`
 * refusal at the leaf and an ordinary IO error: one try/catch around the writes,
 * one classification in {@link writeFailure}. Mirrors `review-evidence-collection.ts`.
 */
function unsafeArtifactDir(): UnsafeArtifactDirError {
  return new UnsafeArtifactDirError("artifact directory is no longer inside the session artifact root");
}

function writeFailure(err: unknown, name: string): CodexStructuredReviewFailure {
  // The directory refusal keeps its own kind and its own detail: "the run
  // directory moved out from under this run" is a containment fact about the
  // DIRECTORY, and naming the artifact that happened to be next would send an
  // operator looking at a file for a problem the file does not have.
  if (err instanceof UnsafeArtifactDirError) return { kind: "unsafe-artifact-dir", detail: "artifactDir" };
  return {
    kind: err instanceof UnsafeArtifactPathError ? "unsafe-artifact-path" : "artifact-write-failed",
    detail: name,
  };
}

// ---------------------------------------------------------------------------
// Response admission
// ---------------------------------------------------------------------------

/**
 * Peel one Markdown code fence off a final message that is nothing but a fenced
 * block.
 *
 * A CLI honoring `--output-schema` returns the bare JSON object, and one that
 * ignored it commonly wraps the same object in a fence. Only a message whose
 * ENTIRE content is one fenced block is unwrapped — a report that happens to
 * contain a fenced snippet is left alone, and reaches the marker extraction
 * below, which is the form that can tell a verdict from a suggested patch.
 */
function stripLoneCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```") || trimmed.length < 6) return trimmed;
  const firstBreak = trimmed.indexOf("\n");
  if (firstBreak === -1) return trimmed;
  // Anything on the opening line after the backticks is a language tag; a fence
  // whose opening line carries other text is not a lone fence.
  const tag = trimmed.slice(3, firstBreak).trim();
  if (tag !== "" && !/^[A-Za-z0-9_-]+$/.test(tag)) return trimmed;
  const inner = trimmed.slice(firstBreak + 1, trimmed.length - 3);
  return inner.trim();
}

export type CodexEnvelopeAdmission =
  | {
      ok: true;
      envelope: ParsedReviewEnvelope;
      /**
       * The reviewer's own prose outside the envelope, exactly as
       * {@link extractReviewFindingsEnvelope} bounded it — and the empty string
       * when the whole final message WAS the envelope (the bare/fenced JSON a
       * schema-honoring build returns, which has no prose around it).
       *
       * Returned rather than recomputed by the caller because §13 classifies a
       * review from its residual, and a second extraction over the same text
       * would have to re-derive the same split (issue #1069).
       */
      residual: string;
    }
  | { ok: false; failure: CodexStructuredReviewFailure };

/**
 * Admit the final message as one §2.1 envelope.
 *
 * Two shapes are accepted, and both end at the same gate:
 *
 *  - a marker-delimited envelope inside a prose report — what
 *    {@link reviewFindingsInstructions} asks for, and what a build that ignored
 *    `--output-schema` produces;
 *  - a bare (or singly fenced) JSON object — what a build that honored the schema
 *    produces, since a schema-constrained final message cannot carry the markers.
 *
 * Nothing is admitted BECAUSE a schema was supplied: the payload goes through
 * {@link parseReviewFindingsEnvelope} either way, and the strict encoding's
 * explicit `null`s are removed first (see {@link stripNullEnvelopeMembers}) so a
 * conforming response is not refused as carrying an unknown field.
 */
export function admitCodexReviewEnvelope(
  finalMessage: string,
  opts: { repoRoot?: string } = {},
): CodexEnvelopeAdmission {
  const extracted = extractReviewFindingsEnvelope(finalMessage);
  if (extracted.kind === "failure") {
    return { ok: false, failure: { kind: "malformed-response", detail: extracted.failure.reason, protocol: extracted.failure } };
  }
  let payload: string;
  let residual: string;
  if (extracted.kind === "payload") {
    payload = extracted.payload;
    residual = extracted.residual;
  } else {
    // A bare or singly fenced object IS the whole message, so there is no
    // reviewer prose beside it — not "prose the extractor could not find".
    residual = "";
    const bare = stripLoneCodeFence(finalMessage);
    // §13: a response with neither markers nor a JSON object is a legacy prose
    // review. Reported as itself rather than as a malformed envelope — the two
    // have different remedies, and only one of them is a defect.
    if (!bare.startsWith("{")) {
      return { ok: false, failure: { kind: "envelope-absent", detail: null } };
    }
    payload = bare;
  }
  // §12's byte bound is a bound on what the AGENT wrote, and the marker path
  // above enforces it on exactly those bytes. `stripNullEnvelopeMembers`
  // re-serializes compactly, so normalizing first would drop indentation and
  // could pull an oversized bare or fenced payload back under the limit —
  // admitting through one encoding a response every other encoding refuses.
  // Bound the original bytes, and when they exceed it hand the parser the
  // payload it must reject, so the failure is the domain parser's own.
  const bounded = Buffer.byteLength(payload, "utf8") > REVIEW_FINDINGS_ENVELOPE_MAX_BYTES;
  const parsed = parseReviewFindingsEnvelope(bounded ? payload : stripNullEnvelopeMembers(payload), {
    ...(opts.repoRoot === undefined ? {} : { repoRoot: opts.repoRoot }),
  });
  if (!parsed.ok) {
    return { ok: false, failure: { kind: "malformed-response", detail: parsed.failure.reason, protocol: parsed.failure } };
  }
  return { ok: true, envelope: parsed.value, residual };
}

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

export interface CodexStructuredReviewInput {
  /** The runner-authored review brief; the §2.1 instruction is appended to it. */
  brief: string;
  /** The checkout under review. The agent's cwd, and this module never writes to it. */
  repoCwd: string;
  /** This run's artifact directory: the prompt, the schema, and all three streams. */
  artifactDir: string;
  /**
   * The session's artifact root. When supplied, the artifact directory must be a
   * real directory inside it — before the run and again before every post-run
   * write, since the agent's runtime is a window in which it could be replaced.
   */
  artifactRoot?: string;
  agentId?: string;
  /** The boundary's `structured_exec` resolution (issue #912); see {@link CodexStructuredReviewProfileInput.runtime}. */
  runtime: AgentPhaseRuntime;
  /** Session Codex config, read here only for the context-mode form (#376). */
  codex?: CodexConfig;
  /** Whether this run captured the Issue body (§3.3 `issue_quote` resolvability). */
  issueBodyAvailable?: boolean;
  liveLineages?: readonly ReviewPromptLineage[];
  /**
   * Opt IN to `--output-schema`; off by default under §17.7's C6 rule. See
   * {@link CodexStructuredReviewProfileInput.outputSchema}.
   */
  outputSchema?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam for the agent's subprocess, under the real isolated invocation. */
  agentRunner?: CommandRunner;
  /** Test seam for the run-owned temp directory. */
  makeRunDir?: () => string;
  /** Test seam: replaces the whole isolated invocation. */
  agent?: CodexStructuredReviewAgentRunner;
}

/** Literals, counters, and artifact names only — safe for task context. */
export interface CodexStructuredReviewSummary {
  promptBytes: number;
  schemaBytes: number;
  /** Bytes of the final message, before any bound. */
  responseBytes: number;
  eventBytes: number;
  /** Artifact BASE names; the directory is the caller's and never travels. */
  artifacts: {
    prompt: string | null;
    schema: string | null;
    response: string | null;
    events: string | null;
    stderr: string | null;
    runnerError: string | null;
  };
  exitCode: number | null;
  timedOut: boolean;
  /** Where the CLI could look for its own login. Never `inherit` for this lane. */
  homePolicy: "throwaway" | "inherit" | null;
  profile: ResolvedCodexStructuredReviewProfile | null;
  /** The admitted envelope's shape — counts and literals, never finding prose. */
  envelope: { status: string; findings: number; blockedReason?: string; ignoredRunnerOwnedFields: number } | null;
  failure: { kind: CodexStructuredReviewFailureKind; detail: string | null } | null;
}

/**
 * The run-local text a caller needs and the §10.1 summary deliberately excludes.
 *
 * `summary` is what may travel into task context, so it carries counters and
 * literals only. These two are the opposite kind of value: agent-authored bytes
 * that stay in this process and in the local artifacts. They are returned rather
 * than left for the caller to read back out of the artifact directory, because a
 * routing lane has to classify the review's own prose (§13) and diagnose a
 * nonzero exit (quota exhaustion, a CLI diagnostic) from the same run it just
 * made, and re-reading a file it has already been handed is one more failure
 * mode for no gain (issue #1069).
 */
export interface CodexStructuredReviewStreams {
  /** The final message verbatim, bounded by {@link MAX_CODEX_REVIEW_RESPONSE_BYTES}. */
  finalMessage: string | null;
  /** The agent's own stderr, with any runner-written spawn bytes removed. */
  stderr: string;
}

export type CodexStructuredReviewResult =
  | {
      ok: true;
      envelope: ParsedReviewEnvelope;
      /** See {@link CodexEnvelopeAdmission}. */
      residual: string;
      streams: CodexStructuredReviewStreams;
      summary: CodexStructuredReviewSummary;
    }
  | {
      ok: false;
      failure: CodexStructuredReviewFailure;
      streams: CodexStructuredReviewStreams;
      summary: CodexStructuredReviewSummary;
    };

// ---------------------------------------------------------------------------
// The invocation
// ---------------------------------------------------------------------------

/**
 * Run one structured Codex review and return one validated envelope.
 *
 * Never throws: every failure — an unsupported agent, a CLI that refused a flag, a
 * run that timed out, a final message that will not admit — comes back as a typed
 * outcome, because a caller can only fail closed if it gets a value back.
 *
 * Nothing is persisted to a task and no protocol state is touched: the prompt, the
 * schema and all three streams are written to the run's own artifact directory,
 * and only names, counters, and literals travel in the summary.
 */
export function runCodexStructuredReview(input: CodexStructuredReviewInput): CodexStructuredReviewResult {
  const baseSummary: CodexStructuredReviewSummary = {
    promptBytes: 0,
    schemaBytes: 0,
    responseBytes: 0,
    eventBytes: 0,
    artifacts: { prompt: null, schema: null, response: null, events: null, stderr: null, runnerError: null },
    exitCode: null,
    timedOut: false,
    homePolicy: null,
    profile: null,
    envelope: null,
    failure: null,
  };
  const noStreams: CodexStructuredReviewStreams = { finalMessage: null, stderr: "" };
  const fail = (
    failure: CodexStructuredReviewFailure,
    summary: CodexStructuredReviewSummary = baseSummary,
    streams: CodexStructuredReviewStreams = noStreams,
  ): CodexStructuredReviewResult => ({
    ok: false,
    failure,
    streams,
    summary: { ...summary, failure: { kind: failure.kind, detail: failure.detail } },
  });

  const env = input.env ?? process.env;

  // (1) The artifact directory, checked before anything is written to it.
  const root = input.artifactRoot;
  if (root !== undefined && !isSafeArtifactDirAfterRun(root, input.artifactDir)) {
    return fail({ kind: "unsafe-artifact-dir", detail: "artifactDir" });
  }
  /**
   * The only way this module writes an artifact.
   *
   * The (1) check answers "was the directory safe BEFORE anything ran", and the
   * agent's runtime — plus every instant between one write and the next — is a
   * window in which the directory could be replaced with a symlink. So the check
   * is re-asked immediately before EVERY write.
   *
   * That check alone is not containment, and this is the part a plain
   * `writeArtifactFile` cannot provide: it protects the LEAF with `O_NOFOLLOW`
   * and resolves the parent components from the path a second time, so a
   * directory swapped for a symlink in the window between the check and the open
   * is followed, and the bytes land wherever the link points — with the review
   * still reporting success. `writeContainedArtifactFile` pins the directory by
   * descriptor (`O_DIRECTORY | O_NOFOLLOW`) and writes THROUGH that descriptor,
   * so the only directory the bytes can reach is the one that was admitted.
   *
   * The root travels into the pinned write as well, because the two guarantees
   * are not the same one: a rename of the admitted directory OUT of the root
   * would leave the pin faithfully writing into it, outside the root, wherever
   * the rename put it.
   */
  const writeGuardedArtifact = (name: string, content: string): void => {
    // Read the path ONCE: the directory that is checked has to be the directory
    // that is opened, and `input` is the caller's object.
    const dir = input.artifactDir;
    if (root !== undefined && !isSafeArtifactDirAfterRun(root, dir)) throw unsafeArtifactDir();
    writeContainedArtifactFile(dir, name, content, root);
  };

  // (2) The invocation. Resolved before anything is built: an agent this module
  // cannot invoke, or a configuration that does not resolve, gets no run at all.
  const resolution = resolveCodexStructuredReviewProfile({
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    runtime: input.runtime,
    ...(input.codex === undefined ? {} : { codex: input.codex }),
    ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    env,
  });
  if ("error" in resolution) {
    return fail({ kind: resolution.kind, detail: input.agentId ?? "codex" });
  }
  const profile = resolution.profile;

  // (3) The prompt and the schema — both runner-authored, both preserved.
  const issueBodyAvailable = input.issueBodyAvailable === true;
  const liveLineages = input.liveLineages ?? [];
  const prompt = buildCodexStructuredReviewPrompt({
    brief: input.brief,
    issueBodyAvailable,
    ...(liveLineages.length > 0 ? { liveLineages } : {}),
  });
  const schema = profile.capabilities.outputSchema
    ? buildReviewFindingsJsonSchema({
        resolvableEvidenceKinds: reviewResolvableEvidenceKinds({ issueBodyAvailable }),
        liveLineageIds: liveLineages.map((lineage) => lineage.lineageId),
      })
    : null;
  const serializedSchema = schema === null ? null : `${JSON.stringify(schema, null, 2)}\n`;
  const summary: CodexStructuredReviewSummary = {
    ...baseSummary,
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    schemaBytes: serializedSchema === null ? 0 : Buffer.byteLength(serializedSchema, "utf8"),
    profile,
  };

  // Which artifact a write failure names, when one of the six cannot be written.
  let writing: string = CODEX_REVIEW_PROMPT_ARTIFACT;
  try {
    writeGuardedArtifact(CODEX_REVIEW_PROMPT_ARTIFACT, prompt);
    if (serializedSchema !== null) {
      writing = CODEX_REVIEW_SCHEMA_ARTIFACT;
      writeGuardedArtifact(CODEX_REVIEW_SCHEMA_ARTIFACT, serializedSchema);
    }
  } catch (err) {
    return fail(writeFailure(err, writing), summary);
  }
  const withInputs: CodexStructuredReviewSummary = {
    ...summary,
    artifacts: {
      ...summary.artifacts,
      prompt: CODEX_REVIEW_PROMPT_ARTIFACT,
      schema: serializedSchema === null ? null : CODEX_REVIEW_SCHEMA_ARTIFACT,
    },
  };

  // (4) The agent.
  const agent =
    input.agent
    ?? createCodexStructuredReviewAgentRunner(profile, schema, {
      ...(input.agentRunner === undefined ? {} : { runner: input.agentRunner }),
      ...(input.makeRunDir === undefined ? {} : { makeRunDir: input.makeRunDir }),
      env,
    });
  let result: CodexStructuredReviewAgentResult;
  try {
    result = agent({
      prompt,
      timeoutMs: input.timeoutMs ?? DEFAULT_CODEX_STRUCTURED_REVIEW_TIMEOUT_MS,
      cwd: input.repoCwd,
    });
  } catch (err) {
    // The isolation sandbox is three `mkdtemp` calls before any subprocess
    // exists, and a full or unwritable TMPDIR fails them outright. That exception
    // would leave this function by a path it promises never to take.
    return fail({ kind: "agent-failed", detail: agentSetupDetail(err) }, withInputs);
  }

  // (5) The three streams, each preserved verbatim in its own artifact.
  //
  // The runner appends its own spawn diagnostic to stderr for the benefit of
  // callers that read only that stream; those bytes are peeled back off here, so
  // no artifact presents runner prose as the CLI's. A diagnostic that is NOT the
  // documented suffix leaves us unable to say which trailing bytes the CLI wrote,
  // so none of the stream is claimed for it.
  const spawnError = result.spawnError !== undefined && result.spawnError !== "" ? result.spawnError : null;
  const spawnErrorIsSuffix = spawnError !== null && result.stderr.endsWith(spawnError);
  const agentStderr =
    spawnError === null
      ? result.stderr
      : spawnErrorIsSuffix
        ? result.stderr.slice(0, result.stderr.length - spawnError.length)
        : "";
  const runnerErrorCapture = spawnError === null ? null : spawnErrorIsSuffix ? spawnError : result.stderr;
  const timedOut = result.timedOut === true;
  const streams: CodexStructuredReviewStreams = { finalMessage: result.finalMessage, stderr: agentStderr };

  writing = CODEX_REVIEW_EVENTS_ARTIFACT;
  try {
    if (result.stdout !== "") {
      writeGuardedArtifact(CODEX_REVIEW_EVENTS_ARTIFACT, boundRawOutput(result.stdout));
    }
    if (agentStderr !== "") {
      writing = CODEX_REVIEW_STDERR_ARTIFACT;
      writeGuardedArtifact(CODEX_REVIEW_STDERR_ARTIFACT, boundRawOutput(agentStderr));
    }
    if (runnerErrorCapture !== null) {
      writing = CODEX_REVIEW_RUNNER_ERROR_ARTIFACT;
      writeGuardedArtifact(CODEX_REVIEW_RUNNER_ERROR_ARTIFACT, boundRawOutput(runnerErrorCapture));
    }
    if (result.finalMessage !== null) {
      writing = CODEX_REVIEW_RESPONSE_ARTIFACT;
      writeGuardedArtifact(CODEX_REVIEW_RESPONSE_ARTIFACT, boundRawOutput(result.finalMessage));
    }
  } catch (err) {
    return fail(writeFailure(err, writing), { ...withInputs, exitCode: result.exitCode, timedOut }, streams);
  }
  const withRun: CodexStructuredReviewSummary = {
    ...withInputs,
    exitCode: result.exitCode,
    timedOut,
    homePolicy: result.homePolicy,
    eventBytes: Buffer.byteLength(result.stdout, "utf8"),
    responseBytes: result.finalMessage === null ? 0 : Buffer.byteLength(result.finalMessage, "utf8"),
    artifacts: {
      ...withInputs.artifacts,
      events: result.stdout === "" ? null : CODEX_REVIEW_EVENTS_ARTIFACT,
      stderr: agentStderr === "" ? null : CODEX_REVIEW_STDERR_ARTIFACT,
      runnerError: runnerErrorCapture === null ? null : CODEX_REVIEW_RUNNER_ERROR_ARTIFACT,
      response: result.finalMessage === null ? null : CODEX_REVIEW_RESPONSE_ARTIFACT,
    },
  };

  // (6) The exit status, classified before the response is looked at.
  //
  // Order matters. A build that refused a pinned flag exits nonzero having run
  // nothing, and reporting that as an agent failure would send an operator
  // looking for a review that never started; a deadline is likewise a different
  // operational fact from a CLI that ran and reported failure.
  if (timedOut) {
    return fail(
      { kind: "timeout", detail: `timeout:${input.timeoutMs ?? DEFAULT_CODEX_STRUCTURED_REVIEW_TIMEOUT_MS}` },
      withRun,
      streams,
    );
  }
  if (result.exitCode !== 0) {
    const refused = codexRefusedCapability(result.stderr);
    if (refused !== null) {
      return fail({ kind: "unsupported-capability", detail: refused }, withRun, streams);
    }
    // A spawn-level failure never reached a CLI at all, so its errno is the
    // reportable fact; an exit status is only meaningful for a run that happened.
    const detail =
      spawnError !== null
        ? agentSetupDetail(result.spawnErrorCode === undefined ? {} : { code: result.spawnErrorCode })
        : `exit:${result.exitCode}`;
    return fail({ kind: "agent-failed", detail }, withRun, streams);
  }

  // (7) The final message. A run that exited zero and wrote nothing where the
  // argv said to has not produced a review, whatever it printed on the way.
  if (result.finalMessageFailure === "stale") {
    return fail({ kind: "stale-output", detail: null }, withRun, streams);
  }
  if (result.finalMessageFailure === "too-large") {
    return fail({ kind: "oversized-output", detail: `bound:${MAX_CODEX_REVIEW_RESPONSE_BYTES}` }, withRun, streams);
  }
  if (result.finalMessage === null) {
    // A build that silently ignored `--output-last-message` and a run that died
    // before writing it are the same fact from here: there is no final message.
    return fail({ kind: "missing-output", detail: "--output-last-message" }, withRun, streams);
  }
  if (result.finalMessage.trim() === "") {
    return fail({ kind: "empty-output", detail: null }, withRun, streams);
  }

  // (8) One admitted envelope, or nothing.
  const admitted = admitCodexReviewEnvelope(result.finalMessage, { repoRoot: input.repoCwd });
  if (!admitted.ok) {
    return fail(admitted.failure, withRun, streams);
  }
  const envelope = admitted.envelope;
  return {
    ok: true,
    envelope,
    residual: admitted.residual,
    streams,
    summary: {
      ...withRun,
      envelope: {
        status: envelope.status,
        findings: envelope.candidates.length,
        ...(envelope.blockedReason === undefined ? {} : { blockedReason: envelope.blockedReason }),
        ignoredRunnerOwnedFields: envelope.ignoredRunnerOwnedFields.length,
      },
    },
  };
}
