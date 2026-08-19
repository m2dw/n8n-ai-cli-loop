/**
 * GitHub-to-registry chain synchronization rules (issue #892).
 *
 * `admin chain validate` (#789) answers "do the registry and GitHub agree?".
 * This module answers the question that follows: **may what GitHub currently
 * says be imported as the chain's next accepted graph, and if not, why not and
 * which side has to move?** It decides only. It reads nothing, writes nothing,
 * and never touches GitHub — the caller supplies one observation and gets one
 * verdict back, so the same decision can be unit-tested without a database, a
 * provider, or a command line.
 *
 * Two refusals that look alike from the outside are kept apart deliberately:
 *
 *   - a **provider failure** (an inaccessible or deleted Issue, a transient
 *     API error) means the observed graph was never fully read. It says
 *     nothing about the chain's structure, and a caller that treated it as a
 *     structural finding would import a graph missing every edge into the
 *     member it could not read — silently deleting real dependencies;
 *   - a **structural failure** (a cycle, an edge naming a non-member, an
 *     ambiguous identity, a member another chain owns) is a durable fact about
 *     what GitHub currently says, and it stays true until someone edits the
 *     Issue Relationships.
 *
 * The first is transient and costs nothing but a retry. The second needs an
 * operator, so every refusal carries a remediation line naming the direction of
 * the repair. That direction is always the same one: GitHub is the runner-
 * visible dependency truth, so a refused import is repaired on GitHub and
 * re-synced. The registry is never edited to match a graph that does not pass —
 * which is exactly why the last accepted graph survives a failed import.
 *
 * Checks run in a fixed order — provider completeness, then #890's graph rules,
 * then #891's frozen prefixes — because each one presupposes the previous. A
 * frozen-prefix check over a cyclic graph, or a drift comparison against a
 * half-read one, would produce findings about a graph nobody observed.
 */

import {
  CHAIN_GRAPH_DIAGNOSTIC_CODES,
  compareChainGraphs,
  validateChainGraph,
} from "./chain-graph.js";
import type {
  CanonicalChainGraph,
  ChainGraphComparison,
  ChainGraphDiagnostic,
  ChainGraphDiagnosticCode,
  ChainGraphSnapshot,
  ChainOwnershipEntry,
} from "./chain-graph.js";
import { checkFrozenPrefixes } from "./chain-frozen-prefix.js";
import type {
  FrozenPrefixGuardVerdict,
  FrozenPrefixSnapshot,
  FrozenPrefixViolation,
} from "./chain-frozen-prefix.js";

/** One member whose GitHub relationships could not be read. */
export interface ChainSyncProviderError {
  issueNumber: number;
  error: string;
}

/**
 * Why an import was refused. Ordered from "nothing was learned" to "something
 * durable is wrong", which is also the order the checks run in.
 */
export const CHAIN_SYNC_REFUSAL_KINDS = ["provider_error", "structural", "frozen_prefix"] as const;

export type ChainSyncRefusalKind = (typeof CHAIN_SYNC_REFUSAL_KINDS)[number];

export function isChainSyncRefusalKind(value: unknown): value is ChainSyncRefusalKind {
  return typeof value === "string" && (CHAIN_SYNC_REFUSAL_KINDS as readonly string[]).includes(value);
}

/** Everything the decision needs, already gathered. */
export interface ChainSyncObservation {
  chainId: string;
  /** The chain's declared head. Sync never moves it; GitHub has no head. */
  headIssueNumber: number;
  /** The graph currently on record, for the drift report. */
  registry: ChainGraphSnapshot;
  /**
   * The candidate built from GitHub: the members the registry declares (GitHub
   * has no notion of chain membership) with the edges read back for each.
   */
  observed: ChainGraphSnapshot;
  /** Members whose relationships could not be read. Any entry refuses the import. */
  providerErrors: readonly ChainSyncProviderError[];
  /** Every frozen prefix recorded against this chain (#891). */
  frozenSnapshots: readonly FrozenPrefixSnapshot[];
  /** Which *other* chains already own the candidate's members (#890). */
  ownership: readonly ChainOwnershipEntry[];
}

export interface ChainSyncImport {
  action: "import";
  /** How the observed graph differs from the one on record. Empty when it does not. */
  drift: ChainGraphComparison;
  /** The canonical form the import would persist, fingerprint included. */
  canonical: CanonicalChainGraph;
}

export interface ChainSyncRefusal {
  action: "refuse";
  kind: ChainSyncRefusalKind;
  /**
   * True when re-running the same command unchanged could succeed. Only a
   * provider failure qualifies: a structural or frozen-prefix refusal stands
   * until an Issue Relationship changes.
   */
  transient: boolean;
  /** Deterministic one-line summary, safe to log. */
  message: string;
  /** Which side has to move, and how. Never empty. */
  remediation: string;
  /** #890 findings about the observed graph. Empty unless `kind` is `structural`. */
  diagnostics: ChainGraphDiagnostic[];
  /** #891 findings. Empty unless `kind` is `frozen_prefix`. */
  violations: FrozenPrefixViolation[];
  /** Unreadable members. Empty unless `kind` is `provider_error`. */
  providerErrors: ChainSyncProviderError[];
}

export type ChainSyncPlan = ChainSyncImport | ChainSyncRefusal;

/**
 * The one direction every refusal points in. GitHub holds the dependency truth
 * the runner acts on, so a graph that cannot be accepted is repaired there —
 * the registry keeps the last graph that did pass until it is.
 */
const IMPORT_DIRECTION =
  "Direction: GitHub -> registry. Repair the Issue Relationships on GitHub and re-run `admin chain sync`; " +
  "the registry keeps its last accepted graph until the observed one passes.";

/**
 * What to change for each way a graph can be refused. Keyed by diagnostic code
 * so a candidate failing several rules gets one hint per rule, in
 * {@link CHAIN_GRAPH_DIAGNOSTIC_CODES} order — the same order the diagnostics
 * themselves are sorted in, so the two lists read together.
 */
const DIAGNOSTIC_REMEDIATIONS: Partial<Record<ChainGraphDiagnosticCode, string>> = {
  empty_members: "the chain has no members to sync — register its members before importing relationships",
  invalid_issue_number: "drop the relationship naming a value that is not an Issue number",
  invalid_role: "correct the member role recorded in the registry",
  duplicate_member: "the same Issue is registered twice — remove the duplicate membership",
  ambiguous_identity: "resolve the conflicting head/role claims so each Issue has one identity",
  head_not_member: "the declared head is not a member — repoint the head or register it",
  missing_member:
    "an Issue outside the chain is named as a blocker — either register it as a member (intake) or remove that relationship on GitHub",
  self_edge: "remove the `blocked by` relationship an Issue holds against itself",
  duplicate_edge: "the same dependency is recorded twice — remove the duplicate",
  cycle: "break the cycle by removing one of the `blocked by` relationships named above",
  duplicate_ownership:
    "the named Issues already belong to another chain — release that claim before this chain can take them",
};

/**
 * The per-code repair hints for a set of diagnostics, in
 * {@link CHAIN_GRAPH_DIAGNOSTIC_CODES} order — one hint per rule the candidate
 * failed. Exported for the intake-side registration path (issue #790), which
 * composes the same hints under its own direction line instead of this
 * module's `admin chain sync` one.
 */
export function diagnosticRemediationHints(
  diagnostics: readonly ChainGraphDiagnostic[],
): string[] {
  const present = new Set(diagnostics.map((d) => d.code));
  const hints: string[] = [];
  for (const code of CHAIN_GRAPH_DIAGNOSTIC_CODES) {
    if (!present.has(code)) continue;
    const hint = DIAGNOSTIC_REMEDIATIONS[code];
    if (hint !== undefined) hints.push(hint);
  }
  return hints;
}

function remediationForDiagnostics(diagnostics: readonly ChainGraphDiagnostic[]): string {
  const hints = diagnosticRemediationHints(diagnostics);
  if (hints.length === 0) return IMPORT_DIRECTION;
  return `${hints.join("; ")}. ${IMPORT_DIRECTION}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The frozen-prefix guard's refusal branch. */
export type FrozenPrefixConflict = Extract<FrozenPrefixGuardVerdict, { ok: false }>;

/**
 * Word a frozen-prefix conflict as a refusal.
 *
 * Exported because the guard is run twice over one observation: once here,
 * against the snapshots read alongside the graph, and once by the caller at the
 * point it commits — a prefix frozen while GitHub was being read is invisible
 * to the first and refuses the import just the same. Both are the same finding
 * about the same graph, so they are worded in one place rather than two.
 */
export function frozenPrefixRefusal(verdict: FrozenPrefixConflict): ChainSyncRefusal {
  return {
    action: "refuse",
    kind: "frozen_prefix",
    transient: false,
    message:
      `the graph observed on GitHub conflicts with a frozen dependency prefix ` +
      `(${plural(verdict.violations.length, "finding")}, ${plural(verdict.evaluated, "snapshot")} evaluated)`,
    remediation:
      "A started Issue's dependency prefix is frozen and outranks the observed graph: restore the pinned edges on " +
      `GitHub, or replan the started Issue so its prefix can be re-taken. ${IMPORT_DIRECTION}`,
    diagnostics: [],
    violations: verdict.violations,
    providerErrors: [],
  };
}

/**
 * Decide whether the observed graph may become the chain's next accepted graph.
 *
 * A verdict of `import` is not a promise that the write will land: ownership
 * and the chain's row revision are re-decided inside the store's own
 * transaction by {@link acceptChainGraph}. It is the statement that nothing
 * *observable from here* refuses the graph.
 */
export function planChainSync(observation: ChainSyncObservation): ChainSyncPlan {
  // 1. Completeness. A member whose relationships could not be read drops every
  //    edge into it from the observed graph, so the candidate is incomplete
  //    rather than merely smaller. Importing it would delete real dependencies
  //    the provider simply failed to report, and comparing it would call those
  //    missing edges drift. Nothing else is evaluated until every member reads.
  if (observation.providerErrors.length > 0) {
    const issues = observation.providerErrors.map((e) => e.issueNumber).sort((a, b) => a - b);
    return {
      action: "refuse",
      kind: "provider_error",
      transient: true,
      message:
        `could not read GitHub Issue Relationships for ${plural(issues.length, "member")} ` +
        `(${issues.map((n) => `#${n}`).join(", ")}); the observed graph is incomplete, so nothing was imported`,
      remediation:
        "Transient or access failure, not a graph problem: restore access to the Issues above (or retry once the " +
        "provider recovers) and re-run `admin chain sync`. Nothing in the registry was changed.",
      diagnostics: [],
      violations: [],
      providerErrors: [...observation.providerErrors],
    };
  }

  // 2. #890's rules, judged on the observed graph alone: a cycle, an edge
  //    naming a non-member, an ambiguous identity, or a member another chain
  //    already owns each refuse the import outright.
  const validation = validateChainGraph(
    {
      chainId: observation.chainId,
      headIssueNumber: observation.headIssueNumber,
      members: observation.observed.members,
      edges: observation.observed.edges,
    },
    { ownership: observation.ownership },
  );
  if (!validation.ok) {
    return {
      action: "refuse",
      kind: "structural",
      transient: false,
      message: `the graph observed on GitHub is not a valid chain graph (${plural(validation.diagnostics.length, "finding")})`,
      remediation: remediationForDiagnostics(validation.diagnostics),
      diagnostics: validation.diagnostics,
      violations: [],
      providerErrors: [],
    };
  }

  // 3. #891's frozen prefixes. Checked last because a prefix is only meaningful
  //    over a graph that has one — an ancestor set is undefined on a cyclic
  //    candidate. A started Issue's prefix outranks whatever GitHub now says:
  //    the freeze is never rewritten to match a graph that contradicts it.
  const frozen = checkFrozenPrefixes({
    candidate: observation.observed,
    snapshots: observation.frozenSnapshots,
    chainId: observation.chainId,
  });
  if (!frozen.ok) return frozenPrefixRefusal(frozen);

  return {
    action: "import",
    drift: compareChainGraphs(observation.registry, observation.observed),
    canonical: validation.graph,
  };
}
