/**
 * Incremental dependency-chain registration at GitHub intake (issue #790).
 *
 * `admin chain sync` (#892) imports a whole chain's observed graph in one
 * operator-driven pass. Intake cannot afford that shape: it runs on every
 * poll, over candidate Issues one at a time, and must never scan or rewrite a
 * repository's worth of relationships to admit one task. This module owns the
 * candidate-scoped decision instead: given ONE Issue, the direct blockers
 * observed on GitHub for it, and what the registry already knows about those
 * Issues, decide how the registry should change — a new chain, an extension of
 * an existing one, or a refusal — before the Issue's task may be created.
 *
 * Like `chain-sync.ts`, this module decides only. It reads nothing, writes
 * nothing, and never touches GitHub or a database; the caller gathers one
 * observation and gets one verdict back. The checks reuse the same layers in
 * the same order — provider completeness, then #890's graph rules
 * (`validateChainGraph`), then #891's frozen prefixes (`checkFrozenPrefixes`)
 * — so a graph refused by sync is refused identically by intake, and the
 * refusal kinds (`provider_error` / `structural` / `frozen_prefix`) carry the
 * same transient-versus-durable meaning.
 *
 * What is deliberately NOT here:
 *
 *   - merging chains. A candidate whose blockers span two registered chains
 *     is refused as structural: candidate-scoped registration can add members
 *     and incoming edges, but re-partitioning existing chains is topology
 *     surgery that belongs to an operator;
 *   - removing members or edges between OTHER Issues. Only the candidate's
 *     own incoming edges are re-derived from observation; everything else in
 *     the target chain is carried forward verbatim, which is what keeps the
 *     ancestry of already-started Issues untouched by a valid fan-in;
 *   - deciding when to comment or label. The fingerprint and comment helpers
 *     below make the caller's once-per-distinct-failure behavior expressible,
 *     but posting, labelling, and retrying are the caller's.
 */

import { createHash } from "crypto";

import { validateChainGraph } from "./chain-graph.js";
import type {
  CanonicalChainGraph,
  ChainGraphDiagnostic,
  ChainGraphSnapshot,
  ChainOwnershipEntry,
} from "./chain-graph.js";
import type { FrozenPrefixViolation } from "./chain-frozen-prefix.js";
import { checkFrozenPrefixes } from "./chain-frozen-prefix.js";
import type { FrozenPrefixSnapshot } from "./chain-frozen-prefix.js";
import type { ChainEdgeInput, ChainMemberInput } from "./chain-registry.js";
import { diagnosticRemediationHints } from "./chain-sync.js";
import type { ChainSyncRefusal, ChainSyncRefusalKind } from "./chain-sync.js";
import type { AiTask, EnqueueTaskInput } from "./task.js";

/* -------------------------------------------------------------------------
 * Target resolution
 * ---------------------------------------------------------------------- */

/**
 * Which chains the registry already involves for a candidate: the chains the
 * candidate itself is a member of, and the chains each observed direct
 * blocker is a member of. Membership lists are expected to be pre-filtered to
 * the candidate's session — chain IDs are global, but intake only ever
 * extends its own session's chains.
 */
export interface ChainIntakeTargetInput {
  issueNumber: number;
  candidateChainIds: readonly string[];
  blockerChainIds: ReadonlyArray<{ issueNumber: number; chainIds: readonly string[] }>;
}

export type ChainIntakeTarget =
  /** Nothing known: the candidate starts a new chain. */
  | { kind: "create" }
  /** Exactly one chain is involved: the candidate (and any unregistered blockers) join it. */
  | { kind: "extend"; chainId: string }
  /**
   * More than one chain is involved — the candidate would fuse them, which
   * candidate-scoped registration refuses. `chainIds` is ascending.
   */
  | { kind: "multi_chain"; chainIds: string[] };

/**
 * Resolve which registered chain (if any) a candidate belongs with. The
 * decision is a pure set union: every chain named by the candidate's own
 * membership or by any observed blocker's membership is involved, and the
 * count of distinct involved chains picks the shape.
 */
export function resolveChainIntakeTarget(input: ChainIntakeTargetInput): ChainIntakeTarget {
  const ids = new Set<string>(input.candidateChainIds);
  for (const blocker of input.blockerChainIds) {
    for (const chainId of blocker.chainIds) ids.add(chainId);
  }
  const sorted = [...ids].sort();
  if (sorted.length === 0) return { kind: "create" };
  if (sorted.length === 1) return { kind: "extend", chainId: sorted[0] };
  return { kind: "multi_chain", chainIds: sorted };
}

/* -------------------------------------------------------------------------
 * Registration plan
 * ---------------------------------------------------------------------- */

/** The graph currently on record for the chain a candidate is joining. */
export interface ChainIntakeExtendTarget {
  chainId: string;
  headIssueNumber: number;
  members: readonly ChainMemberInput[];
  edges: readonly ChainEdgeInput[];
}

/** One observed blocker whose registry state could not be read. */
export interface ChainIntakeProviderError {
  issueNumber: number;
  error: string;
}

export interface ChainIntakePlanInput {
  issueNumber: number;
  /**
   * The candidate's direct blockers as observed on GitHub Issue Relationships
   * — its incoming edges, and the only edges intake re-derives. Blockers
   * closed as `not_planned` must be excluded by the caller: an abandoned
   * blocker is not ancestry.
   */
  observedBlockers: readonly number[];
  target:
    | { kind: "create" }
    | ({ kind: "extend" } & ChainIntakeExtendTarget)
    | { kind: "multi_chain"; chainIds: readonly string[] };
  /** Every frozen prefix recorded against the target chain (#891). Empty for a create. */
  frozenSnapshots: readonly FrozenPrefixSnapshot[];
  /** Which OTHER chains already own any involved Issue (#890). */
  ownership: readonly ChainOwnershipEntry[];
  /** Observation failures. Any entry refuses the registration as transient. */
  providerErrors: readonly ChainIntakeProviderError[];
}

/** A registration the caller may apply: the full candidate graph to accept. */
export interface ChainIntakeRegistration {
  action: "register";
  mode: "create" | "extend";
  /** Present for `extend`; a `create` has no ID until the store allocates one. */
  chainId?: string;
  headIssueNumber: number;
  members: ChainMemberInput[];
  edges: ChainEdgeInput[];
  /** The validated canonical form, fingerprint included. */
  canonical: CanonicalChainGraph;
}

/**
 * Refusals share `ChainSyncRefusal`'s shape and kinds on purpose: an intake
 * refusal and a sync refusal about the same graph are the same finding, and a
 * caller routing on `kind`/`transient` must not need to know which door the
 * graph arrived through.
 */
export type ChainIntakeRefusal = ChainSyncRefusal;

export type ChainIntakePlan = ChainIntakeRegistration | ChainIntakeRefusal;

/**
 * The one direction an intake refusal points in. Worded for the Issue comment
 * rather than the operator console: intake re-checks on every poll, so the
 * repair loop is "fix the relationships and wait", not "re-run a command".
 */
const INTAKE_DIRECTION =
  "Direction: GitHub -> registry. Repair the `blocked by` Issue Relationships on GitHub; " +
  "intake re-checks this Issue on every poll and the registry keeps its last accepted graph until the observed relationships pass.";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function refusal(
  kind: ChainSyncRefusalKind,
  transient: boolean,
  message: string,
  remediation: string,
  detail?: Partial<Pick<ChainSyncRefusal, "diagnostics" | "violations" | "providerErrors">>,
): ChainIntakeRefusal {
  return {
    action: "refuse",
    kind,
    transient,
    message,
    remediation,
    diagnostics: detail?.diagnostics ?? [],
    violations: detail?.violations ?? [],
    providerErrors: detail?.providerErrors ?? [],
  };
}

/**
 * Word #890 findings as an intake refusal. Exported because the caller can
 * learn of them twice: from {@link planChainIntake}, and again from
 * `acceptChainGraph` when a concurrent claim surfaces ownership the plan-time
 * read could not see. Both are the same kind of finding about the same
 * candidate and must publish identically.
 */
export function structuralChainIntakeRefusal(
  issueNumber: number,
  diagnostics: readonly ChainGraphDiagnostic[],
): ChainIntakeRefusal {
  const hints = diagnosticRemediationHints(diagnostics);
  return refusal(
    "structural",
    false,
    `registering issue #${issueNumber} would not leave a valid chain graph (${plural(diagnostics.length, "finding")})`,
    hints.length === 0 ? INTAKE_DIRECTION : `${hints.join("; ")}. ${INTAKE_DIRECTION}`,
    { diagnostics: [...diagnostics] },
  );
}

/**
 * Word a #891 conflict as an intake refusal. Accepts either the guard's full
 * violation list (plan-time) or a bare detail line — the commit guard inside
 * `setAcceptedRevision` and the atomic enqueue-freeze both refuse with one
 * line, after the point where violations were computable.
 */
export function frozenPrefixChainIntakeRefusal(
  issueNumber: number,
  detail:
    | { violations: readonly FrozenPrefixViolation[]; evaluated: number }
    | { message: string },
): ChainIntakeRefusal {
  const message =
    "violations" in detail
      ? `registering issue #${issueNumber} conflicts with a frozen dependency prefix ` +
        `(${plural(detail.violations.length, "finding")}, ${plural(detail.evaluated, "snapshot")} evaluated)`
      : `registering issue #${issueNumber} conflicts with a frozen dependency prefix: ${detail.message}`;
  return refusal(
    "frozen_prefix",
    false,
    message,
    "A started Issue's dependency prefix is frozen and outranks the observed relationships: restore the pinned " +
      `\`blocked by\` edges on GitHub, or replan the started Issue so its prefix can be re-taken. ${INTAKE_DIRECTION}`,
    "violations" in detail ? { violations: [...detail.violations] } : undefined,
  );
}

/**
 * Decide how the registry should change for one candidate Issue.
 *
 * A verdict of `register` is not a promise the write will land: ownership and
 * revision are re-decided inside the store's transaction by
 * `acceptChainGraph`, and the frozen prefixes are re-read by its commit
 * guard. It is the statement that nothing observable from here refuses the
 * candidate.
 */
export function planChainIntake(input: ChainIntakePlanInput): ChainIntakePlan {
  // 1. Completeness, for the same reason as planChainSync: a half-read
  //    observation is not a smaller graph, it is no graph, and judging it
  //    would turn a provider hiccup into a durable public finding.
  if (input.providerErrors.length > 0) {
    const issues = input.providerErrors.map((e) => e.issueNumber).sort((a, b) => a - b);
    return refusal(
      "provider_error",
      true,
      `could not read the registry or relationship state for ${plural(issues.length, "Issue")} ` +
        `(${issues.map((n) => `#${n}`).join(", ")}); issue #${input.issueNumber} was not registered`,
      "Transient or access failure, not a graph problem: nothing was changed and intake retries on the next poll.",
      { providerErrors: [...input.providerErrors] },
    );
  }

  // 2. One chain at most. Fusing chains is not a candidate-scoped edit.
  if (input.target.kind === "multi_chain") {
    const chains = input.target.chainIds.join(", ");
    return refusal(
      "structural",
      false,
      `issue #${input.issueNumber} and its observed blockers span ${plural(input.target.chainIds.length, "registered chain")} (${chains}); ` +
        "candidate-scoped intake cannot merge chains",
      "An Issue may only join one dependency chain: adjust the `blocked by` relationships so every blocker belongs to " +
        `a single chain, or retire the chains that should not apply. ${INTAKE_DIRECTION}`,
    );
  }

  const observedBlockers = [...new Set(input.observedBlockers)].sort((a, b) => a - b);

  // 3. Build the candidate graph. A create is the candidate plus its observed
  //    blockers; an extend carries the target chain forward verbatim except
  //    for the candidate's own membership and incoming edges, which are
  //    re-derived from observation. Nothing about any other member moves.
  let headIssueNumber: number;
  let members: ChainMemberInput[];
  let edges: ChainEdgeInput[];
  if (input.target.kind === "create") {
    headIssueNumber = input.issueNumber;
    members = [
      { issueNumber: input.issueNumber, role: "head" },
      ...observedBlockers
        .filter((n) => n !== input.issueNumber)
        .map((n) => ({ issueNumber: n })),
    ];
    edges = observedBlockers.map((n) => ({
      blockerIssueNumber: n,
      blockedIssueNumber: input.issueNumber,
    }));
  } else {
    headIssueNumber = input.target.headIssueNumber;
    const known = new Set(input.target.members.map((m) => m.issueNumber));
    members = [
      ...input.target.members.map((m) => ({ ...m })),
      ...(known.has(input.issueNumber) ? [] : [{ issueNumber: input.issueNumber }]),
      ...observedBlockers
        .filter((n) => n !== input.issueNumber && !known.has(n))
        .map((n) => ({ issueNumber: n })),
    ];
    edges = [
      ...input.target.edges
        .filter((e) => e.blockedIssueNumber !== input.issueNumber)
        .map((e) => ({ ...e })),
      ...observedBlockers.map((n) => ({
        blockerIssueNumber: n,
        blockedIssueNumber: input.issueNumber,
      })),
    ];
  }

  // 4. #890's rules over the candidate, ownership included.
  const validation = validateChainGraph(
    {
      ...(input.target.kind === "extend" ? { chainId: input.target.chainId } : {}),
      headIssueNumber,
      members,
      edges,
    },
    { ownership: input.ownership },
  );
  if (!validation.ok) {
    return structuralChainIntakeRefusal(input.issueNumber, validation.diagnostics);
  }

  // 5. #891's frozen prefixes. A started Issue's pinned ancestry outranks the
  //    observed relationships — including the candidate's own, if it froze one
  //    on an earlier start.
  const frozen = checkFrozenPrefixes({
    candidate: { members, edges } satisfies ChainGraphSnapshot,
    snapshots: input.frozenSnapshots,
    ...(input.target.kind === "extend" ? { chainId: input.target.chainId } : {}),
  });
  if (!frozen.ok) {
    return frozenPrefixChainIntakeRefusal(input.issueNumber, {
      violations: frozen.violations,
      evaluated: frozen.evaluated,
    });
  }

  return {
    action: "register",
    mode: input.target.kind,
    ...(input.target.kind === "extend" ? { chainId: input.target.chainId } : {}),
    headIssueNumber,
    members,
    edges,
    canonical: validation.graph,
  };
}

/* -------------------------------------------------------------------------
 * Error fingerprint and the idempotent comment
 * ---------------------------------------------------------------------- */

/**
 * Identity of one distinct refusal, stable across polls: the same candidate
 * failing the same way fingerprints identically, and any material change —
 * different kind, different findings, different observed relationships —
 * produces a new fingerprint. This is what "post the explanation once" keys
 * on: the caller persists it, and a poll that recomputes the stored value has
 * nothing new to say.
 */
export function chainIntakeRefusalFingerprint(input: {
  issueNumber: number;
  observedBlockers: readonly number[];
  refusal: Pick<ChainIntakeRefusal, "kind" | "message" | "diagnostics" | "violations">;
}): string {
  const lines = [
    `issue ${input.issueNumber}`,
    `blockers ${[...new Set(input.observedBlockers)].sort((a, b) => a - b).join(",")}`,
    `kind ${input.refusal.kind}`,
    `message ${input.refusal.message}`,
    ...input.refusal.diagnostics.map((d) => `diagnostic ${d.code} ${d.message}`),
    ...input.refusal.violations.map((v) => `violation ${v.code} ${v.message}`),
  ];
  const digest = createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
  return `sha256:${digest}`;
}

function renderIssueList(issues: readonly number[]): string {
  if (issues.length === 0) return "none";
  return [...new Set(issues)].sort((a, b) => a - b).map((n) => `#${n}`).join(", ");
}

/**
 * The one public explanation of a durable intake refusal, posted to the Issue.
 *
 * Deterministic on purpose — no timestamps, no run IDs — so the same refusal
 * always renders the same body and the caller's fingerprint-keyed dedup means
 * exactly one comment per distinct failure. States what was observed, what the
 * accepted graph expected (when there is one), every finding, and the repair
 * direction; ends with the fingerprint so an operator can match the comment to
 * the persisted error record.
 */
export function formatChainIntakeErrorComment(input: {
  issueNumber: number;
  observedBlockers: readonly number[];
  /** The blockers the accepted graph records for this Issue, when it is registered. */
  expectedBlockers?: readonly number[];
  refusal: Pick<ChainIntakeRefusal, "kind" | "message" | "remediation" | "diagnostics" | "violations">;
  fingerprint: string;
}): string {
  const lines: string[] = [
    "### Dependency chain registration blocked",
    "",
    `Automated intake could not register issue #${input.issueNumber} in the dependency-chain registry, so no task was created for it.`,
    "",
    `- Observed \`blocked by\` relationships: ${renderIssueList(input.observedBlockers)}`,
  ];
  if (input.expectedBlockers !== undefined) {
    lines.push(`- Expected by the accepted chain graph: ${renderIssueList(input.expectedBlockers)}`);
  }
  lines.push("", `**Problem** (\`${input.refusal.kind}\`): ${input.refusal.message}`);
  const findings = [
    ...input.refusal.diagnostics.map((d) => d.message),
    ...input.refusal.violations.map((v) => v.message),
  ];
  if (findings.length > 0) {
    lines.push("", "Findings:", ...findings.map((f) => `- ${f}`));
  }
  lines.push(
    "",
    `**Remediation**: ${input.refusal.remediation}`,
    "",
    `_The previously accepted chain graph was preserved. This comment is posted once per distinct failure (fingerprint \`${input.fingerprint}\`)._`,
  );
  return lines.join("\n");
}

/* -------------------------------------------------------------------------
 * Store ports
 * ---------------------------------------------------------------------- */

export interface ChainIntakeErrorKey {
  sessionId: string;
  issueNumber: number;
}

/**
 * The persisted record of the last durable refusal for a candidate — the
 * memory that makes "one comment per distinct failure" survive process
 * restarts, and that tells a later successful registration there is a stale
 * `blocked` label to clean up.
 */
export interface ChainIntakeErrorRecord {
  sessionId: string;
  issueNumber: number;
  /** {@link chainIntakeRefusalFingerprint} of the refusal that was published. */
  fingerprint: string;
  kind: ChainSyncRefusalKind;
  /** The refusal's one-line message, for operator inspection. */
  message: string;
  createdAt: string;
}

/**
 * Durable storage for intake error fingerprints. One row per
 * (session, Issue): a new distinct failure replaces the previous record, and
 * a successful registration deletes it.
 */
export interface ChainIntakeErrorStore {
  getChainIntakeError(key: ChainIntakeErrorKey): Promise<ChainIntakeErrorRecord | undefined>;
  /** Upsert: a record for the same key replaces the previous one. */
  putChainIntakeError(record: ChainIntakeErrorRecord): Promise<void>;
  /** Deleting an absent record reports `deleted: false` rather than failing. */
  deleteChainIntakeError(key: ChainIntakeErrorKey): Promise<{ deleted: boolean }>;
}

/* -------------------------------------------------------------------------
 * Atomic enqueue + freeze port
 * ---------------------------------------------------------------------- */

export type EnqueueTaskWithChainFreezeResult =
  | {
      ok: true;
      task: AiTask;
      /** True when an existing dependency-held task was reactivated (issue #224). */
      reactivated: boolean;
      /** The stored snapshot — on a repeat, the one the first freeze wrote. */
      snapshot: FrozenPrefixSnapshot;
      /** True when the identical contract was already frozen and nothing was written for it. */
      alreadyFrozen: boolean;
    }
  /** A task already exists and is not reactivatable. Nothing was written. */
  | { ok: false; code: "already_exists"; current: AiTask }
  /** A DIFFERENT contract is already frozen for this Issue. Nothing was written. */
  | { ok: false; code: "frozen_prefix_conflict"; detail: string; frozen: FrozenPrefixSnapshot }
  /**
   * `not_found`: no such chain (or another session's). `conflict`: the chain's
   * graph moved since the snapshot was computed — retry after re-observing.
   * `invalid_input`: the snapshot is malformed or names a different task.
   */
  | { ok: false; code: "not_found" | "conflict" | "invalid_input"; detail?: string };

/**
 * The intake-side sibling of {@link import("./chain-frozen-prefix.js").ChainPrefixFreezeStore}
 * (issue #790): create (or reactivate) a task AND freeze its dependency
 * snapshot in one transaction. The same two-halves argument applies — the
 * snapshot is the contract the created task will run under, and the creation
 * is what makes the contract binding — so an implementation must apply both
 * or neither. A candidate whose stored contract differs must be refused
 * without creating anything: that is the fail-closed half of "atomic or
 * fail-closed".
 */
export interface ChainIntakeEnqueueStore {
  enqueueTaskWithChainFreeze(
    input: EnqueueTaskInput,
    snapshot: FrozenPrefixSnapshot,
  ): Promise<EnqueueTaskWithChainFreezeResult>;
}
