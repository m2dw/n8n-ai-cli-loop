/**
 * `admin chain new|append|prepend` (issue #791): the three linear
 * dependency-chain construction commands.
 *
 *   admin chain new     <issue[,issue...]> [name]
 *   admin chain append  <chain-ref> <issue[,issue...]>
 *   admin chain prepend <chain-ref> <issue[,issue...]>
 *
 * `chain sync` (#892) imports what GitHub already says and intake (#790)
 * registers one candidate as it arrives; neither draws a dependency structure.
 * These commands do, and they write BOTH sides — the GitHub Issue Relationships
 * the runner acts on, and the registry graph that mirrors them. `core/chain-linear.ts`
 * owns every decision; this module owns the sequence those decisions are carried
 * out in, which is where the safety actually lives.
 *
 * The sequence, and why each step is where it is:
 *
 *   0. Claim an exclusive scope for every Issue the edit touches, and for the
 *      chain name if one was asked for (`core/chain-edit-lock.ts`). Steps 2 and
 *      7 are a pair that only one edit at a time can hold open: a second edit
 *      overlapping on an Issue would find the labels already gone, own nothing,
 *      and be left exposed when the first edit hands them back mid-way through
 *      its own relationship writes. A name is claimed too, so a second run
 *      asking for it is turned away before it starts rather than after it has
 *      drawn relationships. An edit that cannot claim every scope refuses here,
 *      before it has touched anything. The claim is renewed for as long as the
 *      run lasts AND re-asserted around every mutation below — before each one
 *      and after each provider call, including between the Issues of a loop:
 *      one that has changed hands means a second edit is already free to move
 *      these Issues, so this one stops where it stands rather than write
 *      alongside it. What makes those checks trustworthy is that the claim does
 *      not expire on a clock: it records this process, and a `gh` call blocking
 *      the event loop cannot make a running edit look abandoned.
 *   1. Read GitHub's current relationships for every Issue involved, and the
 *      chain's accepted registry revision alongside them. A plan is a statement
 *      about a state that was observed, never about one SQLite assumed.
 *   2. Suspend automation for every affected Issue (#787), before the first
 *      relationship write. An Issue that is momentarily linked but not yet
 *      fully linked must not be picked up by `github-intake` in that window,
 *      and the labels that decide pickup are the only thing that can prevent it.
 *   3. Re-check the frozen dependency prefixes (#891) with automation already
 *      quiesced. The plan checked them too, but a task could have started
 *      between that read and the suspension — and after the suspension none can.
 *   4. Apply the planned relationship additions, idempotently: a relationship
 *      the tracker already holds is a step that already landed, not a failure,
 *      which is what lets a re-run finish a half-applied edit.
 *   5. Read GitHub back and verify it now holds exactly the planned graph —
 *      no more (someone else edited it) and no less (a write reported success
 *      without taking effect).
 *   6. Only then update the registry, and only with the graph that read-back
 *      verified, through #890's acceptance service so the graph, its revision,
 *      its fingerprint, and the accepted pointer move as one step. A `new`
 *      chain takes its name in the same transaction that allocates its ID —
 *      the two share one namespace (#788), so a name registered afterwards can
 *      be taken in between by any creation the step-0 claim does not bind.
 *   7. Only after that succeeds, restore the execution labels step 2 removed —
 *      and only those. A suspension standing before this run, from `admin issue
 *      suspend` or an unrelated chain edit, is left exactly as it was found:
 *      lifting it would make an Issue eligible while somebody else still means
 *      it not to be.
 *
 * Failure never rewinds GitHub. A partial edit leaves automation suspended, so
 * the Issues are diagnosable but not executable, and the answer carries the
 * concrete recovery plan — which Issues are still suspended, what to inspect,
 * and what to run. Repairing GitHub from the registry's idea of the graph is
 * exactly the optimistic write this ordering exists to avoid: SQLite's copy is
 * a mirror of a read that may already be stale, and undoing a relationship on
 * its word can destroy an edit somebody else just made.
 *
 * Preview by default, apply with `--yes` — the same convention as every other
 * state-changing command in this CLI. A preview reads GitHub and the registry
 * and writes nothing at all: no relationship, no label, no registry row.
 */

import { randomUUID } from "crypto";
import { hostname } from "os";
import type { OutputMode } from "./cli-io.js";
import { die, report } from "./cli-io.js";
import { parseCommonOptions, resolveSessionSelector } from "./admin-command.js";
import { fetchObservedEdges } from "./chain-inspect.js";
import { parseIssueNumberList, resolveIssueWorkItemProvider } from "./issue-activation.js";
import {
  describeUnresolvedSessionId,
  JsonSessionRegistry,
} from "../registries/json-session-registry.js";
import { SqliteChainRegistryStore } from "../stores/sqlite-chain-registry-store.js";
import { SqliteIssueActivationStore } from "../stores/sqlite-issue-activation-store.js";
import type { ResolvedSession } from "../core/session.js";
import type { WorkItemProvider } from "../providers/types.js";
import {
  activateIssueAutomation,
  planSuspend,
  suspendIssueAutomation,
  suspensionLabelsOwnedBy,
} from "../core/issue-activation.js";
import type { IssueActivationOutcome, IssueActivationStore } from "../core/issue-activation.js";
import { acceptChainGraph, collectChainOwnership } from "../core/chain-acceptance.js";
import { checkFrozenPrefixes } from "../core/chain-frozen-prefix.js";
import type { FrozenPrefixSnapshot } from "../core/chain-frozen-prefix.js";
import { frozenPrefixRefusal } from "../core/chain-sync.js";
import type { ChainSyncProviderError } from "../core/chain-sync.js";
import { isValidChainAlias } from "../core/chain-registry.js";
import {
  CHAIN_EDIT_LOCK_ABANDONED_MS,
  CHAIN_EDIT_LOCK_RENEW_MS,
  CHAIN_EDIT_LOCK_STALE_MS,
  chainEditLockScopeKind,
  chainEditLockScopes,
  describeChainEditLockScope,
} from "../core/chain-edit-lock.js";
import type { ChainEditLockHolder } from "../core/chain-edit-lock.js";
import type { ChainEdgeInput, ChainMemberInput } from "../core/chain-registry.js";
import type { ChainGraphEdge, ChainOwnershipEntry } from "../core/chain-graph.js";
import {
  planLinearChainEdit,
  structuralChainLinearRefusal,
  verifyLinearChainReadBack,
} from "../core/chain-linear.js";
import type {
  ChainLinearApply,
  ChainLinearOperation,
  ChainLinearRefusal,
  ChainLinearTarget,
} from "../core/chain-linear.js";

/** Provenance recorded on every revision these commands create. */
const LINEAR_SOURCE_PREFIX = "admin chain";

/* -------------------------------------------------------------------------
 * Arguments
 * ---------------------------------------------------------------------- */

interface ChainEditArgs {
  operation: ChainLinearOperation;
  /** Present for `append`/`prepend`. */
  chainRef: string | undefined;
  issueNumbers: number[];
  /** Present for `new` when the operator supplied the optional name. */
  name: string | undefined;
  /** An assertion about which session owns the chain; never a selector for it. */
  sessionId: string | undefined;
  apply: boolean;
  sessionsPath: string;
  dbPath: string | undefined;
}

export function parseChainEditArgs(
  argv: string[],
  operation: ChainLinearOperation,
): ChainEditArgs | { error: string } {
  // The selector flags are declared by hand rather than through
  // `session: "required"`: `new` genuinely requires one, while a chain-ref
  // already names the owning session, so requiring it there would force an
  // operator to restate something the registry knows. The flags are still
  // *known* to the tokenizer for all three, so a typo is rejected rather than
  // read as a positional.
  const parsed = parseCommonOptions(argv, {
    booleanFlags: ["yes"],
    valueFlags: ["session-id", "session-ref", "sessions-path"],
    allowPositionals: true,
  });
  if ("error" in parsed) return { error: parsed.error };
  const { args, flags, positionals } = parsed;

  const expected = operation === "new" ? "<issue[,issue...]> [name]" : "<chain-ref> <issue[,issue...]>";
  const maxPositionals = 2;
  if (positionals.length > maxPositionals) {
    return { error: `Unexpected argument: ${positionals[maxPositionals]}` };
  }

  let chainRef: string | undefined;
  let issueList: string;
  let name: string | undefined;
  if (operation === "new") {
    if (positionals.length === 0) {
      return { error: `issue number(s) are required, e.g. admin chain new ${expected}` };
    }
    issueList = positionals[0];
    name = positionals[1];
    if (name !== undefined && !isValidChainAlias(name)) {
      return {
        error:
          `Invalid chain name: ${name}. A name is registered as an operator alias for the chain, so it must be ` +
          "1-64 characters of letters, digits, '.', '_' or '-', starting with a letter or digit.",
      };
    }
  } else {
    if (positionals.length < 2) {
      return { error: `a chain reference and issue number(s) are required, e.g. admin chain ${operation} ${expected}` };
    }
    chainRef = positionals[0];
    issueList = positionals[1];
  }

  // A linear command's Issue list is a sequence, not a set: `10,11,10` asks for
  // a cycle (or a reorder), and collapsing it to `10,11` would apply a graph the
  // operator never described. Rejected here, before the planner ever sees it —
  // the plan's contract is that its input is already de-duplicated (issue #791
  // review).
  const issueNumbers = parseIssueNumberList(issueList, { duplicates: "reject" });
  if ("error" in issueNumbers) return { error: issueNumbers.error };

  let sessionId: string | undefined;
  if (args["session-id"] !== undefined || args["session-ref"] !== undefined) {
    const selector = resolveSessionSelector(args);
    if ("error" in selector) return { error: selector.error };
    sessionId = selector.sessionId;
  } else if (operation === "new") {
    return { error: "--session-id or --session-ref is required" };
  }

  return {
    operation,
    chainRef,
    issueNumbers: issueNumbers.value,
    name,
    sessionId,
    apply: flags.has("yes"),
    sessionsPath: parsed.sessionsPath,
    dbPath: parsed.dbPath,
  };
}

/* -------------------------------------------------------------------------
 * Result shape
 * ---------------------------------------------------------------------- */

/**
 * Every way one linear edit can fail: the plan's own three kinds, plus the four
 * that only exist once the edit is being carried out. A setup problem (no such
 * chain, an unusable session or provider) is not here — it aborts through
 * `die()` before anything is planned, like every other admin command.
 */
type ChainEditFailureKind =
  | ChainLinearRefusal["kind"]
  | "label_error"
  | "relationship_error"
  | "conflict"
  | "store_error"
  | "lock_contended";

interface ChainEditFailure {
  kind: ChainEditFailureKind;
  /** True when an unchanged re-run could succeed. */
  transient: boolean;
  message: string;
  /** Which side has to move, and how. Never empty. */
  remediation: string;
  /**
   * What an operator has to do to leave the system in a runnable state, in
   * order. Never empty once anything was suspended: automation stays off until
   * somebody turns it back on, and this is where that instruction lives.
   */
  recovery: string[];
  diagnostics?: ChainLinearRefusal["diagnostics"];
  violations?: ChainLinearRefusal["violations"];
  providerErrors?: ChainSyncProviderError[];
}

/** One Issue's label movement, for both the preview and the applied answer. */
interface ChainEditLabelChange {
  issueNumber: number;
  /** Execution labels removed by the suspension (or that a preview would remove). */
  suspended: string[];
  /** Execution labels restored afterwards. Empty until step 7 runs. */
  restored: string[];
  /** Labels still withheld — a partial restore, or a mutation that never finished. */
  withheld: string[];
  error?: string;
}

interface ChainEditPayload {
  ok: boolean;
  operation: ChainLinearOperation;
  applied: boolean;
  status: "would_apply" | "applied" | "failed";
  sessionId: string;
  chainRef?: string;
  chainId?: string;
  /** The Issues the command was asked to link, in the order given. */
  issues: number[];
  /** GitHub relationships the edit plans to create, or created. */
  plannedEdges: ChainGraphEdge[];
  appliedEdges: ChainGraphEdge[];
  /** Relationships that were already present, so this run did not create them. */
  alreadyPresentEdges: ChainGraphEdge[];
  /** The graph the registry would hold, or now holds. */
  graph?: {
    headIssueNumber: number;
    members: ChainMemberInput[];
    edges: ChainEdgeInput[];
    fingerprint: string;
  };
  revision?: { graphRevision: number; acceptedRevision: number | null; fingerprint: string };
  labels: ChainEditLabelChange[];
  failure?: ChainEditFailure;
  /**
   * A bookkeeping write that failed after the edit itself landed (an alias left
   * unregistered). The edit stands.
   */
  followUpFailure?: { code: string; detail?: string };
}

/* -------------------------------------------------------------------------
 * Rendering
 * ---------------------------------------------------------------------- */

const FAILURE_LABELS: Record<ChainEditFailureKind, string> = {
  provider_error: "provider read failed (transient)",
  structural: "structural graph problem",
  frozen_prefix: "frozen dependency-prefix conflict",
  label_error: "automation labels could not be moved",
  relationship_error: "GitHub relationship write failed",
  conflict: "chain moved during the edit (retryable)",
  store_error: "registry write failed",
  lock_contended: "another chain edit already holds this Issue or name (retryable)",
};

function formatEdges(edges: readonly ChainGraphEdge[]): string {
  if (edges.length === 0) return "(none)";
  return edges.map((e) => `${e.blockerIssueNumber}->${e.blockedIssueNumber}`).join(", ");
}

function renderChainEdit(payload: ChainEditPayload, _mode: OutputMode): string {
  const scope =
    payload.chainId !== undefined
      ? `chain ${payload.chainId}`
      : payload.chainRef !== undefined
        ? `chain ${payload.chainRef}`
        : "a new chain";
  const mode = payload.applied ? "applied" : "preview (pass --yes to apply)";
  const lines = [
    `Chain ${payload.operation} — ${scope}, session ${payload.sessionId}, ${mode}: ` +
      `${payload.issues.map((n) => `#${n}`).join(", ")}`,
  ];

  if (payload.graph) {
    lines.push(`  head: #${payload.graph.headIssueNumber}`);
    lines.push(`  graph edges: ${formatEdges(payload.graph.edges as ChainGraphEdge[])}`);
  }
  lines.push(
    `  GitHub relationships ${payload.applied ? "created" : "to create"}: ` +
      formatEdges(payload.applied ? payload.appliedEdges : payload.plannedEdges),
  );
  if (payload.alreadyPresentEdges.length > 0) {
    lines.push(`  already present: ${formatEdges(payload.alreadyPresentEdges)}`);
  }
  if (payload.revision) {
    lines.push(
      `  registry revision: ${payload.revision.graphRevision} (accepted: ${payload.revision.acceptedRevision ?? "none"}) ${payload.revision.fingerprint}`,
    );
  }
  for (const label of payload.labels) {
    const parts = [
      `${payload.applied ? "suspended" : "would suspend"}: ${label.suspended.join(", ") || "none"}`,
    ];
    if (payload.applied) parts.push(`restored: ${label.restored.join(", ") || "none"}`);
    if (label.withheld.length > 0) parts.push(`STILL WITHHELD: ${label.withheld.join(", ")}`);
    if (label.error) parts.push(`error: ${label.error}`);
    lines.push(`  #${label.issueNumber} labels — ${parts.join("; ")}`);
  }

  if (payload.failure) {
    const failure = payload.failure;
    lines.push(`  error [${failure.kind}]: ${FAILURE_LABELS[failure.kind]} — ${failure.message}`);
    for (const d of failure.diagnostics ?? []) lines.push(`    [${d.code}] ${d.message}`);
    for (const v of failure.violations ?? []) lines.push(`    [${v.code}] ${v.message}`);
    for (const e of failure.providerErrors ?? []) lines.push(`    #${e.issueNumber}: ${e.error}`);
    lines.push(`  remediation: ${failure.remediation}`);
    if (failure.recovery.length > 0) {
      lines.push("  recovery:");
      for (const step of failure.recovery) lines.push(`    - ${step}`);
    }
  }
  if (payload.followUpFailure) {
    lines.push(
      `  warning: follow-up bookkeeping failed [${payload.followUpFailure.code}] ${payload.followUpFailure.detail ?? ""}`.trimEnd(),
    );
  }
  if (!payload.applied && payload.ok) lines.push("Run with --yes to apply.");
  return lines.join("\n");
}

/* -------------------------------------------------------------------------
 * Execution
 * ---------------------------------------------------------------------- */

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function issueList(issues: readonly number[]): string {
  return issues.join(",");
}

/**
 * How one Issue's standing suspension record splits between operations.
 * Exported for the advanced topology commands (issue #893), which suspend and
 * restore through exactly this attribution.
 */
export interface SuspensionAttribution {
  /** Labels this edit removed, an earlier interrupted run of it included. */
  owned: string[];
  /**
   * Labels the same record holds for somebody else — `admin issue suspend`, or
   * another chain edit that got there first. This edit neither restores them
   * nor tells an operator to.
   */
  foreign: string[];
  /**
   * Labels this edit took off the Issue that reached no suspension record at
   * all (#787's durability compensation failed on both halves). They belong to
   * nobody's record, so `admin issue activate` cannot bring them back and the
   * recovery plan has to ask for them by name (issue #791 review).
   */
  stranded: string[];
}

/**
 * The instruction that has to survive every failure after step 2: automation is
 * off for these Issues and nothing will turn it back on by itself.
 *
 * `admin issue activate` restores a suspension record whole, so it is only
 * offered for Issues whose record belongs to this edit alone. Where another
 * operation's labels have been merged into the same record, that command would
 * lift the other suspension too and make the Issue eligible while it is still
 * meant to be held back — the very thing step 7 uses `onlyLabels` to avoid
 * (issue #791 review). Those Issues get the labels named instead of a command.
 *
 * It is also only offered where a record exists to restore. When #787 could
 * neither commit the record nor put the labels back, activation is a no-op (or
 * restores only an older record) and would read as a fix that never happened,
 * so those labels are named for manual re-add instead (issue #791 review).
 */
export function restoreStep(
  sessionId: string,
  issues: readonly number[],
  scope: ReadonlyMap<number, SuspensionAttribution>,
): string[] {
  if (issues.length === 0) return [];
  const entangled = issues.filter((n) => (scope.get(n)?.foreign ?? []).length > 0);
  const exclusive = issues.filter(
    (n) => (scope.get(n)?.foreign ?? []).length === 0 && (scope.get(n)?.owned ?? []).length > 0,
  );
  const strandedIssues = issues.filter((n) => (scope.get(n)?.stranded ?? []).length > 0);
  const steps = [
    `Automation stays suspended for ${issues.map((n) => `#${n}`).join(", ")} so no Issue can be picked up mid-edit.`,
  ];
  if (exclusive.length > 0) {
    steps.push(
      `Restore it with \`admin issue activate ${issueList(exclusive)} --session-id ${sessionId} --yes\` once the ` +
        "state above is resolved.",
    );
  }
  for (const issueNumber of entangled) {
    const attribution = scope.get(issueNumber)!;
    steps.push(
      `#${issueNumber} is also suspended by another operation, whose labels (${attribution.foreign.join(", ")}) ` +
        `share its suspension record: do NOT run \`admin issue activate ${issueNumber}\`, which restores the record ` +
        `whole and would lift that suspension as well. Re-add only this edit's labels ` +
        `(${attribution.owned.join(", ") || "none"}) to #${issueNumber}, or leave it to the operation that holds ` +
        "the rest.",
    );
  }
  for (const issueNumber of strandedIssues) {
    const attribution = scope.get(issueNumber)!;
    steps.push(
      `#${issueNumber} lost label(s) ${attribution.stranded.join(", ")} with no suspension record naming them: ` +
        "the record could not be written and putting the label(s) back failed too. `admin issue activate " +
        `${issueNumber}\` will NOT restore them — re-add them to #${issueNumber} by hand (once the state above is ` +
        "resolved) before the Issue can run again.",
    );
  }
  return steps;
}

/**
 * The identity of one linear edit, stable across retries.
 *
 * It is stamped on every suspension record this edit creates (#787), and step 7
 * consults it: a suspension standing before this run is only lifted when the
 * record says this same edit left it, so a suspension from `admin issue
 * suspend` — or from a different chain edit — survives this one instead of
 * being cleared as a side effect (issue #791 review).
 *
 * Derived from what the edit IS — the operation, the chain, and the Issues in
 * the order given — rather than from the clock, because a run that finishes an
 * interrupted edit is the same operation and must lift what the interrupted run
 * suspended. The chain's resolved ID is used rather than the operator's
 * chain-ref, so an alias and the ID it resolves to name one edit.
 */
function linearOperationId(request: ChainEditRequest): string {
  // The command as an operator would type it, then what it is being run on:
  // `admin chain new-10,11`. The id is quoted back at whoever loses a race for
  // one of this edit's claims, so it reads as the command it names.
  return [
    `${LINEAR_SOURCE_PREFIX} ${request.operation}`,
    ...(request.chainId === undefined ? [] : [request.chainId]),
    issueList(request.issueNumbers),
  ].join("-");
}

function refusalFailure(refusal: ChainLinearRefusal, recovery: string[]): ChainEditFailure {
  return {
    kind: refusal.kind,
    transient: refusal.transient,
    message: refusal.message,
    remediation: refusal.remediation,
    recovery,
    ...(refusal.diagnostics.length > 0 ? { diagnostics: refusal.diagnostics } : {}),
    ...(refusal.violations.length > 0 ? { violations: refusal.violations } : {}),
    ...(refusal.providerErrors.length > 0 ? { providerErrors: refusal.providerErrors } : {}),
  };
}

/** Everything one run resolves before it can decide anything. */
interface ChainEditContext {
  session: ResolvedSession;
  provider: WorkItemProvider;
  chainStore: SqliteChainRegistryStore;
  activationStore: IssueActivationStore;
  now: string;
  /**
   * The scopes of step 0 this run has stopped holding, re-checked against the
   * store on every call. Empty while the claim is intact; anything it returns is
   * final, and every mutation asks before it writes.
   *
   * Absent for a preview, which claims nothing because it writes nothing.
   */
  verifyLocks?: () => Promise<readonly string[]>;
}

/** The chain a previous, unfinished run of this same `chain new` left behind. */
interface ResumableChain {
  chainId: string;
  /** The chain row's revision as this run read it, for the acceptance's CAS. */
  rev: number;
}

/**
 * The chain an interrupted `chain new` left owning exactly these Issues, if
 * there is one (issue #791 review).
 *
 * `chain new` allocates the chain identity first and accepts the graph second,
 * so an acceptance that is vetoed, conflicted, or refused by the registry
 * leaves a chain behind that owns the Issues but was never the last-known-good
 * graph for anything. Re-running the command is the documented recovery, and it
 * has to be able to reach that chain: collecting it as foreign ownership turns a
 * retryable partial edit into a permanent refusal pointing at a merge (#893) the
 * operator has no reason to want.
 *
 * Adoption is deliberately narrow, because "this is my own leftover" must never
 * be confused with "somebody else's chain":
 *
 * - it belongs to this session;
 * - it has NO accepted revision, so no reader has ever been told this graph is
 *   the good one and nothing downstream depends on its contents;
 * - its members are exactly the Issues this command names — a chain holding one
 *   more (or one fewer) is a different chain, and re-accepting it under this
 *   command's graph would silently drop or absorb members.
 *
 * A second matching leftover (two `chain new` runs that both failed before this
 * change) is left in the ownership set on purpose: the lowest chain ID is
 * resumed and the rest still refuse, naming themselves, rather than being
 * quietly abandoned. The choice is by sorted ID so two operators racing the same
 * retry converge on the same chain.
 */
async function findResumableChain(
  chainStore: SqliteChainRegistryStore,
  sessionId: string,
  issueNumbers: readonly number[],
  ownership: readonly ChainOwnershipEntry[],
): Promise<ResumableChain | undefined> {
  for (const chainId of [...new Set(ownership.map((o) => o.chainId))].sort()) {
    const resumable = await resumableChain(chainStore, sessionId, issueNumbers, chainId);
    if (resumable !== undefined) return resumable;
  }
  return undefined;
}

/**
 * Whether one named chain is this command's own leftover — the three conditions
 * {@link findResumableChain} documents, asked about a single chain so that the
 * name check in step 0 can ask them too.
 */
async function resumableChain(
  chainStore: SqliteChainRegistryStore,
  sessionId: string,
  issueNumbers: readonly number[],
  chainId: string,
): Promise<ResumableChain | undefined> {
  const wanted = new Set(issueNumbers);
  const graph = await chainStore.getChain(chainId);
  if (graph === undefined) return undefined;
  if (graph.chain.sessionId !== sessionId) return undefined;
  if (graph.chain.acceptedRevision !== undefined) return undefined;
  const members = graph.members.map((m) => m.issueNumber);
  if (members.length !== wanted.size || !members.every((n) => wanted.has(n))) return undefined;
  return { chainId, rev: graph.chain.rev };
}

/**
 * Both ends of every relationship the Issues involved take part in.
 *
 * `includeDependents` is what makes the plan's fork checks real. Reading only
 * each Issue's `blocked by` set would leave every edge OUT of the set invisible:
 * a head that already blocks an unregistered Issue would look like a downstream
 * end, `chain append` would extend past it, and the result would be a live fork
 * the command promises to refuse and the registry does not represent (issue #791
 * review). The read-back uses the same observation for the same reason — a
 * concurrent editor who adds an outgoing relationship is as much a change as one
 * who adds an incoming one.
 */
async function readObservation(
  provider: WorkItemProvider,
  issues: readonly number[],
): Promise<{ edges: ChainGraphEdge[]; errors: ChainSyncProviderError[] }> {
  const { edges, errors } = await fetchObservedEdges(
    provider,
    issues.map((issueNumber) => ({ issueNumber })),
    { includeDependents: true },
  );
  return { edges, errors };
}

/**
 * The answer an edit gets when it cannot claim every scope of step 0.
 *
 * Deliberately shaped like every other failure this command reports, with one
 * difference that matters: the recovery plan says nothing about restoring
 * automation, because a refusal here happens before the first suspension. There
 * is no partial state — no label moved, no relationship written, no registry row
 * touched — so the whole remedy is to run the command again later.
 */
function lockContentionPayload(
  request: ChainEditRequest,
  sessionId: string,
  scope: string,
  heldBy: ChainEditLockHolder,
): ChainEditPayload {
  const staleMinutes = Math.round(CHAIN_EDIT_LOCK_STALE_MS / 60_000);
  const abandonedHours = Math.round(CHAIN_EDIT_LOCK_ABANDONED_MS / (60 * 60 * 1000));
  /** The process still holding it, when the claim records one: what an operator checks. */
  const holder =
    heldBy.pid === undefined
      ? ""
      : ` It is held by process ${heldBy.pid}${heldBy.host === undefined ? "" : ` on ${heldBy.host}`}.`;
  const remediation =
    chainEditLockScopeKind(scope) === "alias"
      ? "A chain name is claimed from the moment a `chain new` checks it is free until the chain that carries it is " +
        "registered, so two runs cannot both read it as available and the loser work through an edit it could never " +
        "finish. Nothing was written: choose another name, or re-run this command once the other edit finishes."
      : "Two chain edits that overlap on an Issue cannot run at once: whichever finished first would hand back " +
        "the execution labels it suspended while the other was still drawing relationships, making the Issue " +
        "eligible for pickup mid-edit. Nothing was written: re-run this command once the other edit finishes.";
  return {
    ok: false,
    operation: request.operation,
    applied: request.apply,
    status: "failed",
    sessionId,
    ...(request.chainRef === undefined ? {} : { chainRef: request.chainRef }),
    ...(request.chainId === undefined ? {} : { chainId: request.chainId }),
    issues: [...request.issueNumbers],
    plannedEdges: [],
    appliedEdges: [],
    alreadyPresentEdges: [],
    labels: [],
    failure: {
      kind: "lock_contended",
      transient: true,
      message:
        `${describeChainEditLockScope(scope)} is already claimed by the chain edit \`${heldBy.operationId}\`, ` +
        `which started at ${heldBy.acquiredAt}.${holder}`,
      remediation,
      recovery: [
        "No automation was suspended and nothing was written to GitHub or the registry, so there is no partial " +
          "state to repair.",
        `Re-run \`admin chain ${request.operation}\` with --yes once the other edit has finished. A claim left ` +
          `behind by an edit that crashed is taken over automatically once its process is gone and ${staleMinutes} ` +
          "minutes have passed without a heartbeat; one whose process is still running is never taken from it, " +
          "however long its current GitHub call blocks for — an edit blocked in a slow GitHub call is still an " +
          "edit, and taking its Issues would let two runs relabel them at once.",
        ...(holder === ""
          ? []
          : [
              "If the process named above is not a chain edit at all — a pid the system reassigned after the real " +
                `owner died — the claim is released anyway after ${abandonedHours} hours without a heartbeat.`,
            ]),
      ],
    },
  };
}

/**
 * Run one linear edit end to end. Returns the payload; never throws for an
 * expected failure, so the caller only has to decide the exit code.
 */
async function runChainEdit(argv: string[], operation: ChainLinearOperation): Promise<void> {
  const parsed = parseChainEditArgs(argv, operation);
  if ("error" in parsed) die(parsed.error);
  const { chainRef, issueNumbers, name, apply, sessionsPath, dbPath } = parsed;

  // Loaded before any store is opened: `die()` calls `process.exit`, which skips
  // the `finally` that closes them, so everything that can legitimately abort
  // the whole command happens first.
  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${messageOf(err)}`);
  }

  const chainStore = new SqliteChainRegistryStore(dbPath);
  const activationStore = new SqliteIssueActivationStore(dbPath);

  /** This invocation's claim on the scopes of step 0, never reused by another run. */
  const lockOwnerId = randomUUID();
  let heldScopes: string[] = [];
  /**
   * Scopes this run has been found not to hold any more. Sticky and fatal: a
   * claim that has changed hands belongs to the run holding it now, and this one
   * has no way to take it back — so every scope that lands here is a reason for
   * the edit to stop, not a list to shrink and carry on with.
   */
  const lostScopes: string[] = [];
  /**
   * Push the claim forward, and record anything it has already lost.
   *
   * The takeover another edit performs on a stale claim is what stops a crashed
   * run from holding its scopes forever — but an edit is only "stale" if it has
   * stopped, and an apply over many Issues against a rate-limited provider can
   * outlive the window while it is still working. Without a heartbeat a second
   * invocation would then take these scopes over, suspend and restore the same
   * labels, and write the same relationships alongside this one (issue #791
   * review). Renewal is fenced on this run's owner id, so a scope that HAS
   * already changed hands is dropped here rather than reclaimed.
   *
   * A renewal that throws is not a loss: only the store saying the row is
   * somebody else's counts as one, and a busy database must not stop an edit
   * that still holds everything it claimed.
   */
  const renewLocks = async (): Promise<void> => {
    if (heldScopes.length === 0) return;
    try {
      const { lost } = await chainStore.renewChainEditLocks({
        scopes: heldScopes,
        ownerId: lockOwnerId,
        now: new Date().toISOString(),
      });
      if (lost.length === 0) return;
      heldScopes = heldScopes.filter((s) => !lost.includes(s));
      for (const scope of lost) if (!lostScopes.includes(scope)) lostScopes.push(scope);
    } catch {
      /* see above: a failed heartbeat is not a lost claim */
    }
  };
  /**
   * What every mutation checks before it runs: the scopes this edit has stopped
   * holding, re-asserted rather than read off the last heartbeat.
   *
   * The timer below cannot cover the gap on its own. Every `gh` call is a
   * `spawnSync`, so a slow provider blocks the event loop and no heartbeat fires
   * at all — a run can pass the staleness window mid-edit and have its scopes
   * taken over without ever noticing. Re-asserting the claim between mutations
   * is what turns that into a stop instead of two edits suspending, relating and
   * relabelling the same Issues at once (issue #791 review).
   *
   * Checking *before* each mutation is not on its own enough either, and cannot
   * be: the check passes, the call blocks past the window, and the write lands
   * under a claim that changed hands while it was in flight. What closes that is
   * the claim no longer expiring on a timer — the lock records this process, and
   * a live pid answers throughout a blocking call, so only a run that has really
   * stopped can be superseded (`CHAIN_EDIT_LOCK_ABANDONED_MS`). This check is
   * then what notices the case that rule still allows — a crash-and-takeover
   * between two calls of this run — before the next write, and before any
   * execution label goes back on.
   *
   * Every call in a loop, not once before it: each iteration is another blocking
   * provider call, so a claim intact before the first Issue's label write says
   * nothing about the fifth's.
   */
  const verifyLocks = async (): Promise<readonly string[]> => {
    await renewLocks();
    return lostScopes;
  };
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  const startLockRenewal = (): void => {
    renewTimer = setInterval(() => {
      // A missed heartbeat is not a failure: the window is several ticks wide
      // precisely so the next one can cover for it.
      void renewLocks();
    }, CHAIN_EDIT_LOCK_RENEW_MS);
    // The command must exit the moment its work is done. The heartbeat is not
    // work, so it must never be what keeps the event loop alive.
    renewTimer.unref();
  };
  /**
   * Give the scopes back. Idempotent, and safe to call before a `die()` — which
   * bypasses the `finally` below by exiting the process. A release that itself
   * fails is swallowed: the answer this command already has is worth more than
   * the error, and the staleness takeover is what covers a claim nobody frees.
   */
  const releaseLocks = async (): Promise<void> => {
    if (renewTimer !== undefined) {
      clearInterval(renewTimer);
      renewTimer = undefined;
    }
    if (heldScopes.length === 0) return;
    const scopes = heldScopes;
    heldScopes = [];
    try {
      await chainStore.releaseChainEditLocks(scopes, lockOwnerId);
    } catch {
      /* left to the staleness takeover */
    }
  };

  try {
    // ---------------------------------------------------------------------
    // Resolve the chain (append/prepend) and the session that owns it.
    // ---------------------------------------------------------------------
    let target: ChainLinearTarget | undefined;
    let chainRev: number | undefined;
    let chainId: string | undefined;
    let sessionId = parsed.sessionId;

    if (chainRef !== undefined) {
      const resolved = await chainStore.resolveChainHandle(chainRef);
      if (resolved === undefined) {
        report({ ok: false, operation, chainRef, reason: "not_found" }, () =>
          `No chain found for reference: ${chainRef}`,
        );
        process.exitCode = 1;
        return;
      }
      const graph = await chainStore.getChain(resolved);
      if (!graph) {
        report({ ok: false, operation, chainRef, reason: "not_found" }, () =>
          `No chain found for reference: ${chainRef}`,
        );
        process.exitCode = 1;
        return;
      }
      chainId = resolved;
      chainRev = graph.chain.rev;
      target = {
        chainId: resolved,
        headIssueNumber: graph.chain.headIssueNumber,
        members: graph.members.map((m) => ({ issueNumber: m.issueNumber, role: m.role })),
        edges: graph.edges.map((e) => ({
          blockerIssueNumber: e.blockerIssueNumber,
          blockedIssueNumber: e.blockedIssueNumber,
        })),
        graphRevision: graph.chain.graphRevision,
        ...(graph.chain.acceptedRevision === undefined
          ? {}
          : { acceptedRevision: graph.chain.acceptedRevision }),
      };
      // A supplied selector is an assertion, not a filter: a chain-ref already
      // names exactly one chain, and quietly editing a different session's
      // chain than the operator named is the kind of surprise this CLI refuses.
      if (sessionId !== undefined && sessionId !== graph.chain.sessionId) {
        die(
          `Chain ${resolved} belongs to session ${graph.chain.sessionId}, not ${sessionId}. ` +
            "Drop the session selector or name the owning session.",
        );
      }
      sessionId = graph.chain.sessionId;
    }

    const session = await registry.getSessionById(sessionId!);
    if (!session) die(describeUnresolvedSessionId(registry, sessionId!, sessionsPath));

    let provider: WorkItemProvider;
    try {
      provider = await resolveIssueWorkItemProvider(session);
    } catch (err) {
      die(messageOf(err));
    }

    const now = new Date().toISOString();
    const request: ChainEditRequest = {
      operation,
      issueNumbers,
      ...(chainRef === undefined ? {} : { chainRef }),
      ...(chainId === undefined ? {} : { chainId }),
      ...(target === undefined ? {} : { target }),
      ...(chainRev === undefined ? {} : { chainRev }),
      ...(name === undefined ? {} : { name }),
      apply,
    };

    // ---------------------------------------------------------------------
    // Step 0: claim the Issues (and the name) for the duration of the edit.
    //
    // Only for an apply: a preview writes nothing, so it neither needs a scope
    // nor should be able to block the edit it is a preview of.
    // ---------------------------------------------------------------------
    if (apply) {
      const scopes = chainEditLockScopes({
        sessionId: session.sessionId,
        // The plan may narrow this — an append touches the head, not every
        // member — but the scopes are claimed BEFORE anything is read, so they
        // are drawn from what the operator named plus what the chain already
        // holds. Claiming a superset costs a rare needless refusal; claiming a
        // subset would leave the overlap this exists to prevent.
        issueNumbers: [...(target?.members ?? []).map((m) => m.issueNumber), ...issueNumbers],
        ...(name === undefined ? {} : { name }),
      });
      const acquired = await chainStore.acquireChainEditLocks({
        scopes,
        ownerId: lockOwnerId,
        operationId: linearOperationId(request),
        now,
        // The claim's real heartbeat. The timer below stops while a `gh` call
        // blocks the event loop; this process does not, so a later run can tell
        // "still working" from "died holding it" without either waiting out a
        // window or breaking a live edit's claim (issue #791 review).
        ownerPid: process.pid,
        ownerHost: hostname(),
      });
      if (!acquired.ok) {
        const refused = lockContentionPayload(request, session.sessionId, acquired.scope, acquired.heldBy);
        report(refused as unknown as Record<string, unknown>, (mode) => renderChainEdit(refused, mode));
        process.exitCode = 1;
        return;
      }
      heldScopes = acquired.scopes;
      startLockRenewal();
    }

    // A name is registered as an alias, and aliases share one namespace with
    // chain IDs (#788). Checking it before anything is created keeps the
    // deterministic-collision answer ("this name is taken") separate from the
    // chain the command would otherwise have half-built around it. The check
    // sits INSIDE the claim above so that it and the registration in step 6 are
    // one indivisible claim on the name against another run of this command:
    // two concurrent runs asking for the same name used to both read it as free,
    // and the loser ended with an accepted chain and no alias (issue #791
    // review). It is a courtesy, not the guarantee — the lock cannot bind
    // creations that never take it (an intake registering a candidate), so the
    // binding claim is the one step 6 makes inside the registry's own
    // transaction; this check only keeps a doomed edit from starting.
    //
    // A name already pointing at THIS command's own unfinished chain is not a
    // collision but the retry the recovery plan asks for, so it passes: step 6
    // resumes that chain rather than creating a second one.
    if (name !== undefined) {
      const taken = await chainStore.resolveChainHandle(name);
      if (
        taken !== undefined &&
        (await resumableChain(chainStore, session.sessionId, issueNumbers, taken)) === undefined
      ) {
        await releaseLocks();
        die(`Chain name "${name}" already resolves to chain ${taken}. Choose another name, or omit it.`);
      }
    }

    const context: ChainEditContext = {
      session,
      provider,
      chainStore,
      activationStore,
      now,
      ...(apply ? { verifyLocks } : {}),
    };

    const payload = await executeChainEdit(context, request);

    report(payload as unknown as Record<string, unknown>, (mode) => renderChainEdit(payload, mode));
    if (!payload.ok) process.exitCode = 1;
  } finally {
    await releaseLocks();
    activationStore.close();
    chainStore.close();
  }
}

interface ChainEditRequest {
  operation: ChainLinearOperation;
  issueNumbers: number[];
  chainRef?: string;
  chainId?: string;
  target?: ChainLinearTarget;
  chainRev?: number;
  name?: string;
  apply: boolean;
}

async function executeChainEdit(
  context: ChainEditContext,
  request: ChainEditRequest,
): Promise<ChainEditPayload> {
  const { session, provider, chainStore, activationStore, now } = context;
  const { operation, issueNumbers, target, apply } = request;
  const sessionId = session.sessionId;

  const base: ChainEditPayload = {
    ok: false,
    operation,
    applied: apply,
    status: "failed",
    sessionId,
    ...(request.chainRef === undefined ? {} : { chainRef: request.chainRef }),
    ...(request.chainId === undefined ? {} : { chainId: request.chainId }),
    issues: [...issueNumbers],
    plannedEdges: [],
    appliedEdges: [],
    alreadyPresentEdges: [],
    labels: [],
  };

  const fail = (failure: ChainEditFailure, extra: Partial<ChainEditPayload> = {}): ChainEditPayload => ({
    ...base,
    ...extra,
    ok: false,
    status: "failed",
    failure,
  });

  /**
   * The scopes of step 0 this edit has stopped holding — asked afresh, right
   * before each mutation. Empty for a preview, which claims nothing.
   */
  const lostLocks = async (): Promise<string[]> => [...((await context.verifyLocks?.()) ?? [])];

  /**
   * Stop, because the exclusivity the rest of this sequence assumes is gone.
   *
   * Losing a scope means another edit has taken the claim over and is free to
   * move the same Issues right now. Carrying on would put two runs on one Issue
   * — the one interleaving steps 2 and 7 exist to prevent — so the edit reports
   * where it got to and leaves automation suspended, which is what keeps the
   * Issues out of the loop's reach while the overlap is untangled (issue #791
   * review).
   */
  const lockLossFailure = (
    lost: readonly string[],
    recovery: string[],
    remediation = "A claim is this run's only for as long as it keeps renewing it, and one that has changed hands " +
      "means a second edit is already free to move these Issues, so this one stopped rather than write alongside " +
      `it. Re-run \`admin chain ${operation}\` with --yes once that edit has finished: it re-reads GitHub first ` +
      "and writes only what is still missing.",
  ): ChainEditFailure => ({
    kind: "lock_contended",
    transient: true,
    message:
      `this edit no longer holds ${lost.map(describeChainEditLockScope).join(", ")}: another chain edit took the ` +
      "claim over while this one was running",
    remediation,
    recovery,
  });

  const lockLoss = (lost: readonly string[], recovery: string[], extra: Partial<ChainEditPayload> = {}) =>
    fail(lockLossFailure(lost, recovery), extra);

  // -----------------------------------------------------------------------
  // Step 1: what GitHub says now, and what the registry has accepted.
  // -----------------------------------------------------------------------
  const observedIssues = [
    ...new Set([...(target?.members ?? []).map((m) => m.issueNumber), ...issueNumbers]),
  ].sort((a, b) => a - b);
  const observation = await readObservation(provider, observedIssues);

  const owners = await collectChainOwnership(chainStore, observedIssues, {
    filter: { sessionId },
    ...(target === undefined ? {} : { excludeChainId: target.chainId }),
  });

  // A `chain new` that created its chain and then failed before the acceptance
  // landed leaves that chain owning these Issues. Without this, the retry reads
  // its own leftover as somebody else's chain and refuses to merge — so the one
  // command that can finish the edit is the one command that cannot be re-run
  // (issue #791 review).
  const resume =
    target === undefined
      ? await findResumableChain(chainStore, sessionId, issueNumbers, owners)
      : undefined;
  const ownership = resume === undefined ? owners : owners.filter((o) => o.chainId !== resume.chainId);

  // For an existing chain the snapshots are the ones frozen against it. For a
  // new one there is no chain yet, so the session's snapshots are narrowed to
  // the Issues being linked: a snapshot naming an Issue this graph does not
  // contain says nothing about it, and handing it to the guard would report
  // every other started Issue in the session as a missing member.
  const linkedSet = new Set(issueNumbers);
  const frozenSnapshots: FrozenPrefixSnapshot[] =
    target === undefined
      ? (await chainStore.listFrozenPrefixes({ sessionId })).filter((s) => linkedSet.has(s.issueNumber))
      : await chainStore.listFrozenPrefixes({ chainId: target.chainId });

  const plan = planLinearChainEdit({
    operation,
    issueNumbers,
    ...(target === undefined ? {} : { target }),
    observedEdges: observation.edges,
    observedIssues,
    frozenSnapshots,
    ownership,
    providerErrors: observation.errors,
  });

  if (plan.action === "refuse") {
    // Nothing has been suspended, so there is nothing to restore.
    return fail(refusalFailure(plan, []));
  }

  const graph = {
    headIssueNumber: plan.headIssueNumber,
    members: plan.members,
    edges: plan.edges,
    fingerprint: plan.canonical.fingerprint,
  };

  // -----------------------------------------------------------------------
  // Preview: report the plan, having written nothing.
  // -----------------------------------------------------------------------
  if (!apply) {
    const labels: ChainEditLabelChange[] = [];
    for (const issueNumber of plan.affectedIssues) {
      const read = provider.getItem(issueNumber);
      if (!read.ok) {
        labels.push({ issueNumber, suspended: [], restored: [], withheld: [], error: read.error });
        continue;
      }
      const diff = planSuspend(session, read.value.labels);
      labels.push({ issueNumber, suspended: diff.removed, restored: [], withheld: [] });
    }
    return {
      ...base,
      ok: true,
      status: "would_apply",
      // Named even though nothing is created yet: applying this preview would
      // finish the chain an earlier run left unaccepted, not open a new one.
      ...(resume === undefined ? {} : { chainId: resume.chainId }),
      plannedEdges: plan.edgeAdditions,
      graph,
      labels,
    };
  }

  // -----------------------------------------------------------------------
  // Step 2: suspend automation for every affected Issue, before the first
  // relationship write.
  //
  // Every Issue reached here is claimed by step 0 for as long as this run
  // lasts, which is what makes steps 2 and 7 a matched pair. The attribution
  // below decides which labels are this edit's to hand back; the claim is what
  // guarantees no OTHER edit sits between those two steps on the same Issue at
  // the same time — needing labels it never removed, and so cannot own, to stay
  // withheld (issue #791 review).
  // -----------------------------------------------------------------------
  // Step 1 read the whole neighbourhood from GitHub, which is one blocking `gh`
  // call per Issue: long enough that the claim can already be gone before the
  // first label comes off.
  const lostBeforeSuspend = await lostLocks();
  if (lostBeforeSuspend.length > 0) {
    return lockLoss(lostBeforeSuspend, [
      "No automation was suspended and nothing was written to GitHub or the registry, so there is no partial " +
        "state to repair.",
    ]);
  }
  const labels: ChainEditLabelChange[] = [];
  const suspended: number[] = [];
  const operationId = linearOperationId(request);
  /**
   * Per Issue, who the standing suspension belongs to: the labels THIS edit is
   * answerable for — the ones it removed itself, plus the ones an earlier
   * interrupted run of the same edit removed — and the ones the same record
   * holds for another operation. Step 7 restores exactly the former, and the
   * recovery plan never offers a command that would restore the latter.
   */
  const restoreScope = new Map<number, SuspensionAttribution>();
  for (const [index, issueNumber] of plan.affectedIssues.entries()) {
    // Between Issues too, not only before the first: suspending one is a read
    // and a label write per label, all of them blocking, so a claim that was
    // this run's when the loop started may not be by the time the next Issue's
    // labels come off (issue #791 review).
    const lostMidSuspend = index === 0 ? [] : await lostLocks();
    if (lostMidSuspend.length > 0) {
      return lockLoss(
        lostMidSuspend,
        [
          "Nothing was written to GitHub or the registry: the edit stopped before its first relationship write.",
          ...restoreStep(sessionId, suspended, restoreScope),
        ],
        { labels },
      );
    }
    let outcome: IssueActivationOutcome;
    // Read the standing record BEFORE suspending: `suspendIssueAutomation`
    // merges its removals into whatever is already there, so afterwards this
    // edit's own removals and an unrelated operation's are one label list.
    // What tells them apart is the record's per-label attribution — not the
    // record-level operation id, which names only whoever opened the record and
    // would leave this edit's labels unrecognized (and so withheld for good)
    // whenever the record was opened by somebody else (issue #791 review).
    let inherited: string[] = [];
    let standingLabels: string[] = [];
    try {
      const standing = await activationStore.getSuspension(sessionId, issueNumber);
      if (standing !== undefined) {
        standingLabels = [...standing.labels];
        inherited = suspensionLabelsOwnedBy(standing, operationId);
      }
      outcome = await suspendIssueAutomation(session, provider, activationStore, issueNumber, operationId, now);
    } catch (err) {
      outcome = {
        issueNumber,
        ok: false,
        error: messageOf(err),
        removed: [],
        added: [],
        preserved: [],
        restorable: [],
      };
    }
    // Labels #787 removed but could neither record nor put back. They are on no
    // record — not this edit's, not anybody's — so nothing restores them by
    // command; only naming them in the recovery plan does (issue #791 review).
    // A label the standing record already carried is excluded: the failed CAS
    // left that record intact, so activation still covers it.
    const stranded = (outcome.strandedLabels ?? []).filter((l) => !standingLabels.includes(l));
    const owned = [...new Set([...inherited, ...outcome.removed])].filter((l) => !stranded.includes(l));
    restoreScope.set(issueNumber, {
      owned,
      foreign: standingLabels.filter((l) => !owned.includes(l)),
      stranded,
    });
    labels.push({
      issueNumber,
      suspended: outcome.removed,
      restored: [],
      withheld: outcome.restorable,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    });
    if (owned.length > 0 || stranded.length > 0) suspended.push(issueNumber);
    if (!outcome.ok) {
      // Not one relationship has been written yet, so GitHub is untouched. What
      // is not untouched is the label state of the Issues already processed.
      return fail(
        {
          kind: "label_error",
          transient: false,
          message: `automation could not be suspended for #${issueNumber}: ${outcome.error ?? "unknown error"}`,
          remediation:
            "No GitHub relationship and no registry row was changed: the edit stopped before its first write " +
            "because an Issue could still have been picked up while the relationships were half-drawn.",
          recovery: restoreStep(sessionId, suspended, restoreScope),
        },
        { labels },
      );
    }
  }

  // -----------------------------------------------------------------------
  // Steps 3-7 run with every affected Issue already stripped of its execution
  // labels, so an exception escaping from here is not merely a failed command:
  // it is automation left switched off with nobody told which Issues to switch
  // back on. Each step reports its OWN expected failures below, recovery plan
  // and all; this guard is for the ones no step models — a SQLite read that
  // hits a busy timeout or an I/O error, a provider client that throws where it
  // is documented to return — so that they arrive as the same shaped answer,
  // carrying the same label recovery plan, rather than as a stack trace (issue
  // #791 review).
  //
  // The two edge lists are declared out here so that answer can also say how
  // much of the graph had already reached GitHub when the throw happened.
  // -----------------------------------------------------------------------
  const appliedEdges: ChainGraphEdge[] = [];
  const alreadyPresentEdges: ChainGraphEdge[] = [];
  try {
    // ---------------------------------------------------------------------
    // Step 3: frozen prefixes again, now that no task can start.
    // ---------------------------------------------------------------------
    const freshSnapshots: FrozenPrefixSnapshot[] =
      target === undefined
        ? (await chainStore.listFrozenPrefixes({ sessionId })).filter((s) => linkedSet.has(s.issueNumber))
        : await chainStore.listFrozenPrefixes({ chainId: target.chainId });
    const frozen = checkFrozenPrefixes({
      candidate: { members: plan.members, edges: plan.edges },
      snapshots: freshSnapshots,
      ...(target === undefined ? {} : { chainId: target.chainId }),
    });
    if (!frozen.ok) {
      return fail(
        refusalFailure(frozenPrefixRefusal(frozen), [
          "A task started against the prefix this edit would rewrite, between the plan and the suspension. Nothing " +
            "was written to GitHub or the registry.",
          ...restoreStep(sessionId, suspended, restoreScope),
        ]),
        { labels, graph },
      );
    }

    // ---------------------------------------------------------------------
    // Step 4: apply the relationship additions, idempotently.
    // ---------------------------------------------------------------------
    for (const edge of plan.edgeAdditions) {
      // Before each write, not just before the loop: every relationship is
      // another blocking provider call, and the claim has to still be this
      // run's at the moment the next one lands.
      const lostMidWrite = await lostLocks();
      if (lostMidWrite.length > 0) {
        return lockLoss(
          lostMidWrite,
          [
            `Relationships created by this run: ${formatEdges(appliedEdges)}.`,
            `Never created: ${formatEdges(plan.edgeAdditions.filter((e) => !appliedEdges.includes(e) && !alreadyPresentEdges.includes(e)))}.`,
            "The registry was NOT updated, so it still holds the graph from before this edit.",
            ...restoreStep(sessionId, suspended, restoreScope),
          ],
          { labels, graph, appliedEdges, alreadyPresentEdges, plannedEdges: plan.edgeAdditions },
        );
      }
      const result = await provider.addDependency(edge.blockedIssueNumber, edge.blockerIssueNumber);
      if (!result.ok) {
        return fail(
          {
            kind: "relationship_error",
            transient: true,
            message:
              `could not create the \`blocked by\` relationship ${edge.blockerIssueNumber}->${edge.blockedIssueNumber}: ` +
              result.error,
            remediation:
              "The registry was NOT updated, so it still holds the graph from before this edit while GitHub holds a " +
              "partially drawn one. Re-running the command re-reads GitHub and writes only what is still missing — a " +
              "relationship already created is left alone rather than duplicated.",
            recovery: [
              `Relationships created by this run: ${formatEdges(appliedEdges)}.`,
              `Still missing: ${formatEdges(plan.edgeAdditions.filter((e) => !appliedEdges.includes(e) && !alreadyPresentEdges.includes(e)))}.`,
              `Re-run \`admin chain ${operation}\` with --yes to finish the edit.`,
              ...restoreStep(sessionId, suspended, restoreScope),
            ],
          },
          { labels, graph, appliedEdges, alreadyPresentEdges, plannedEdges: plan.edgeAdditions },
        );
      }
      if (result.changed) appliedEdges.push(edge);
      else alreadyPresentEdges.push(edge);
    }

    // ---------------------------------------------------------------------
    // Step 5: read GitHub back and verify it holds exactly the planned graph.
    // ---------------------------------------------------------------------
    const readBack = await readObservation(provider, observedIssues);
    const verified = verifyLinearChainReadBack({
      operation,
      edges: plan.edges,
      observedEdges: readBack.edges,
      observedIssues,
      providerErrors: readBack.errors,
    });
    if ("action" in verified) {
      return fail(
        refusalFailure(verified, [
          "The registry was NOT updated: only a graph GitHub was observed to hold is ever persisted.",
          `Compare the two with \`admin chain validate ${request.chainId ?? "<chain-ref>"}\`.`,
          ...restoreStep(sessionId, suspended, restoreScope),
        ]),
        { labels, graph, appliedEdges, alreadyPresentEdges, plannedEdges: plan.edgeAdditions },
      );
    }

    // ---------------------------------------------------------------------
    // Step 6: update the registry with the verified graph.
    //
    // The read-back is one more round of blocking provider calls, so the claim
    // is asked about again: a graph verified under an exclusivity this run has
    // since lost describes GitHub as it was before the other edit started
    // writing, and persisting it would record that stale reading as the
    // last-known-good one.
    // ---------------------------------------------------------------------
    const lostBeforeCommit = await lostLocks();
    if (lostBeforeCommit.length > 0) {
      return lockLoss(
        lostBeforeCommit,
        [
          `Relationships created by this run: ${formatEdges(appliedEdges)}.`,
          "The registry was NOT updated: a graph verified before the claim changed hands is not one GitHub can " +
            "still be said to hold.",
          ...restoreStep(sessionId, suspended, restoreScope),
        ],
        { labels, graph, appliedEdges, alreadyPresentEdges, plannedEdges: plan.edgeAdditions },
      );
    }
    const registryOutcome = await commitVerifiedGraph(context, request, plan, resume);
    if ("failure" in registryOutcome) {
      return fail(
        {
          ...registryOutcome.failure,
          recovery: [...registryOutcome.failure.recovery, ...restoreStep(sessionId, suspended, restoreScope)],
        },
        { labels, graph, appliedEdges, alreadyPresentEdges, plannedEdges: plan.edgeAdditions },
      );
    }

    // ---------------------------------------------------------------------
    // Step 7: restore the execution labels — and only now.
    //
    // Unless the claim is gone: handing an Issue its execution labels back
    // while another edit holds it and is mid-sequence would make it eligible in
    // the middle of THAT edit, which is the harm steps 2 and 7 are paired
    // against. The graph is already committed, so the edit itself stands; what
    // is reported is the same diagnosable, non-executable state a failed
    // restore leaves, and the labels stay off until an operator says otherwise.
    //
    // Asked per Issue rather than once for the loop: each restore is its own
    // blocking provider call, and the answer from before the first one does not
    // cover the fifth (issue #791 review).
    // ---------------------------------------------------------------------
    /**
     * The scopes step 7 has lost — asked before the loop AND after every Issue
     * it hands labels back to.
     *
     * Restoring an Issue is a read and a label write, both blocking, and both
     * long enough that the claim can change hands during them. Checking only
     * once before the loop left the run putting execution labels back on Issue
     * five under a claim another edit took over while Issue two was being
     * written — the mid-edit eligibility steps 2 and 7 are paired against
     * (issue #791 review). Sticky: the first loss ends the loop, because a
     * claim that has changed hands is not this run's to take back.
     */
    let lostAtRestore = await lostLocks();
    const restoreFailures: string[] = [];
    for (const change of labels) {
      if (lostAtRestore.length > 0) break;
      const owned = restoreScope.get(change.issueNumber)?.owned ?? [];
      if (owned.length === 0) {
        // This edit took nothing off this Issue. Anything still withheld was
        // suspended by another operation — `admin issue suspend`, or an
        // unrelated chain edit — and re-adding it here would make the Issue
        // eligible while that suspension is still meant to hold (issue #791
        // review).
        continue;
      }
      let outcome: IssueActivationOutcome;
      try {
        outcome = await activateIssueAutomation(session, provider, activationStore, change.issueNumber, now, {
          onlyLabels: owned,
        });
      } catch (err) {
        outcome = {
          issueNumber: change.issueNumber,
          ok: false,
          error: messageOf(err),
          removed: [],
          added: [],
          preserved: [],
          restorable: [],
        };
      }
      change.restored = outcome.added;
      change.withheld = outcome.restorable;
      if (!outcome.ok) {
        change.error = outcome.error;
        restoreFailures.push(`#${change.issueNumber}: ${outcome.error ?? "unknown error"}`);
      } else {
        delete change.error;
      }
      // After the write, so the claim is re-asserted across the call that just
      // blocked rather than only across the gap before it.
      lostAtRestore = await lostLocks();
    }

    /**
     * The Issues still holding a label THIS edit suspended: what a recovery plan
     * may offer to hand back. One another operation is withholding is not this
     * command's to name, and one step 7 already restored has nothing left to do.
     */
    const stillSuspended = labels
      .filter((l) =>
        l.withheld.some((label) => (restoreScope.get(l.issueNumber)?.owned ?? []).includes(label)),
      )
      .map((l) => l.issueNumber);

    const result: ChainEditPayload = {
      ...base,
      ok: restoreFailures.length === 0 && lostAtRestore.length === 0,
      status: "applied",
      ...(registryOutcome.chainId === undefined ? {} : { chainId: registryOutcome.chainId }),
      plannedEdges: plan.edgeAdditions,
      appliedEdges,
      alreadyPresentEdges,
      graph,
      revision: registryOutcome.revision,
      labels,
      ...(registryOutcome.followUpFailure === undefined
        ? {}
        : { followUpFailure: registryOutcome.followUpFailure }),
    };

    if (lostAtRestore.length > 0) {
      // The graph landed, and step 7 was stopped — before it began, or between
      // two Issues. Restoring what is left is for an operator who can see both
      // edits, because only they can say whether the Issue is still meant to be
      // suspended for the other one.
      const recovery = [
        "The registry holds the verified graph, so the edit itself is complete; what is unresolved is the execution " +
          "labels.",
      ];
      if (stillSuspended.length > 0) {
        recovery.push(
          "Restore these once the other edit has finished, and only if it has not suspended them for itself:",
          ...restoreStep(sessionId, stillSuspended, restoreScope),
        );
      }
      // Anything step 7 got to before the loss was found. The claim changed
      // hands during a provider call this run had already started, so these
      // Issues went back to eligible while another edit may have been
      // mid-sequence on them — the one outcome the check cannot pre-empt, and
      // therefore the one it has to report (issue #791 review).
      const handedBack = labels.filter((l) => l.restored.length > 0).map((l) => l.issueNumber);
      if (handedBack.length > 0) {
        recovery.push(
          `Automation was restored for ${handedBack.map((n) => `#${n}`).join(", ")} before the claim was found to ` +
            "have changed hands, so those Issues are eligible again. If the edit that now holds them is still " +
            `running, suspend them again with \`admin issue suspend ${issueList(handedBack)} --session-id ` +
            `${sessionId} --yes\` until it finishes.`,
        );
      }
      result.failure = lockLossFailure(
        lostAtRestore,
        recovery,
        "GitHub and the registry agree and the edit is complete. Step 7 did not finish: handing these Issues their " +
          "execution labels back while another edit holds them would make them eligible in the middle of that " +
          "edit, which is exactly what the suspension exists to prevent.",
      );
    } else if (restoreFailures.length > 0) {
      // The graph landed; the Issues it names are still not executable. That is
      // the diagnosable, non-executable state the contract asks for, and it is
      // reported as a failure because it needs an operator.
      result.failure = {
        kind: "label_error",
        transient: true,
        message: `the edit was applied, but automation could not be restored for ${restoreFailures.length} Issue(s): ${restoreFailures.join("; ")}`,
        remediation:
          "GitHub and the registry agree and the edit is complete; only the execution labels are still withheld, so " +
          "the Issues stay ineligible until they are restored.",
        // Only the Issues holding a label THIS edit suspended: one still
        // withheld by another operation is not this command's to hand back.
        recovery: restoreStep(sessionId, stillSuspended, restoreScope),
      };
    }
    return result;
  } catch (err) {
    // Whatever threw, the invariant to protect is the same one steps 2 and 7
    // are a pair for: the labels are off, and the answer has to say so and name
    // the Issues. It is reported as transient because an unmodelled fault is
    // usually one the same command can survive next time, and the mutation is
    // idempotent by construction — the re-run re-reads GitHub and writes only
    // what is still missing.
    return fail(
      {
        kind: "store_error",
        transient: true,
        message: `the edit stopped unexpectedly after automation was suspended: ${messageOf(err)}`,
        remediation:
          "The registry was NOT updated, so it still holds the graph from before this edit. Resolve the fault above " +
          "and re-run the command: it re-reads GitHub and writes only what is still missing, leaving a relationship " +
          "this run already created alone rather than duplicating it.",
        recovery: [
          `Relationships created by this run: ${formatEdges(appliedEdges)}.`,
          `Re-run \`admin chain ${operation}\` with --yes to finish the edit.`,
          ...restoreStep(sessionId, suspended, restoreScope),
        ],
      },
      { labels, graph, appliedEdges, alreadyPresentEdges, plannedEdges: plan.edgeAdditions },
    );
  }
}

/**
 * Persist the verified graph through #890's acceptance service.
 *
 * A `new` chain is created first and accepted second, rather than created
 * pre-accepted: creation is what allocates the deterministic chain ID (and
 * refuses when every candidate for the head Issue is taken), while acceptance is
 * what makes the graph the last-known-good one under the same commit guard every
 * other writer goes through. Splitting them costs one extra write and buys a
 * single code path for the frozen-prefix veto.
 *
 * `resume` is the chain a previous run of this same `chain new` created before
 * failing between the two (see {@link findResumableChain}): the retry accepts it
 * rather than allocating a second identity for the same Issues.
 */
async function commitVerifiedGraph(
  context: ChainEditContext,
  request: ChainEditRequest,
  plan: ChainLinearApply,
  resume?: ResumableChain,
): Promise<
  | {
      chainId: string;
      revision: { graphRevision: number; acceptedRevision: number | null; fingerprint: string };
      followUpFailure?: { code: string; detail?: string };
    }
  | { failure: ChainEditFailure }
> {
  const { chainStore, session, now } = context;
  const sessionId = session.sessionId;
  const source = `${LINEAR_SOURCE_PREFIX} ${request.operation}`;

  let chainId = request.chainId ?? resume?.chainId;
  let expectedRev = request.chainRev ?? resume?.rev;
  let followUpFailure: { code: string; detail?: string } | undefined;

  /**
   * What an operator needs to know when acceptance fails on a `new` chain: the
   * identity exists, holds nothing anyone relies on, and re-running the same
   * command finishes THAT chain rather than opening a second one for the same
   * Issues (issue #791 review). Empty for `append`/`prepend`, whose chain was
   * accepted long before this run.
   */
  const resumeStep = (id: string): string[] =>
    request.chainId === undefined
      ? [
          `Chain ${id} is registered but has accepted no revision, so nothing reads it as a chain yet. ` +
            `Re-run \`admin chain new ${issueList(request.issueNumbers)}\` with --yes to finish it — it resumes ` +
            "this chain instead of creating a second one for the same Issues.",
        ]
      : [];

  if (chainId === undefined) {
    // The name is registered by this same write, not after the acceptance
    // below. Chain IDs and aliases share one namespace (#788), so a name
    // registered afterwards can be taken in between by any other creation —
    // including an unnamed `chain new` or an intake whose head Issue happens to
    // derive the very ID the name occupies. Claiming both in one transaction
    // means a lost race creates no chain at all, which is a state a retry can
    // leave, rather than an accepted chain that can never carry its name
    // (issue #791 review).
    const created = await chainStore.createChain({
      sessionId,
      headIssueNumber: plan.headIssueNumber,
      members: plan.members,
      edges: plan.edges,
      ...(request.name === undefined ? {} : { title: request.name, alias: request.name }),
      source,
      now,
    });
    if (!created.ok) {
      return {
        failure: {
          kind: "store_error",
          transient: false,
          message: `the chain could not be created: ${created.code}${created.detail === undefined ? "" : `: ${created.detail}`}`,
          remediation:
            created.code === "id_exhausted"
              ? "Every deterministic chain ID for this head Issue is taken. Retire the chains that no longer apply " +
                "(see issue #893) before creating another for the same head."
              : created.code === "alias_taken"
                ? `The name "${request.name}" was taken by another chain while this edit was running, and the ` +
                  "chain is created with its name or not at all. No chain was created and no revision was " +
                  "accepted. Re-run the command with a different name: the relationships already in place are " +
                  "left alone."
                : "The GitHub relationships were created and verified, but the registry refused the chain row, so no " +
                  "chain exists for them. Re-run the command once the registry accepts writes: the relationships " +
                  "already in place are left alone.",
          recovery: [
            `The \`blocked by\` relationships ${formatEdges(plan.edges as ChainGraphEdge[])} exist on GitHub but are not registered.`,
          ],
        },
      };
    }
    chainId = created.value.chain.chainId;
    expectedRev = created.value.chain.rev;
  } else if (request.name !== undefined) {
    // Resuming a chain a previous run left unaccepted: its identity exists
    // already, so the name is claimed by its own write — but still BEFORE the
    // acceptance, for the same reason the creation above claims it. A refusal
    // here leaves the chain exactly as this run found it, unaccepted and
    // resumable, so the retry the operator is told to make is a real one.
    //
    // Name and title go in as ONE write, guarded by the revision this run read
    // during the preflight, so this and the acceptance below are two halves of
    // the same compare-and-set. Unguarded, the write would absorb whatever a
    // concurrent registry writer (a `chain sync`, another edit) had done to the
    // chain since the preflight and hand the acceptance a revision that
    // describes their state as well as ours — and the acceptance would then
    // overwrite a graph newer than this plan instead of reporting the conflict
    // that sends the operator back through a fresh GitHub read (issue #791
    // review). The write also carries the fresh revision the acceptance needs,
    // which a separate title write is what made necessary in the first place:
    // the row moves once here, and this caller knows exactly how.
    const named = await chainStore.updateChainMetadata(chainId, {
      title: request.name,
      alias: request.name,
      ...(expectedRev === undefined ? {} : { expectedRev }),
      now,
    });
    if (!named.ok) {
      const conflicted = named.code === "conflict";
      return {
        failure: {
          kind: conflicted ? "conflict" : "store_error",
          transient: conflicted,
          message:
            `the name "${request.name}" could not be recorded on chain ${chainId}: ${named.code}` +
            `${named.detail === undefined ? "" : `: ${named.detail}`}`,
          remediation: conflicted
            ? "The chain was modified while this edit ran, so neither the name nor the graph was written on top of a " +
              "state this run never saw. The relationships exist on GitHub; re-run the command to record them."
            : named.code === "alias_taken"
              ? `The name was taken while this edit was running, so nothing was accepted: chain ${chainId} is still ` +
                "exactly the unaccepted chain a previous run left behind. Re-run the command with a different name " +
                "to finish it."
              : `Neither the name nor the graph was written and nothing was accepted: chain ${chainId} is still ` +
                "exactly the unaccepted chain a previous run left behind. Re-run the same command once the registry " +
                "accepts writes.",
          recovery: [
            `The \`blocked by\` relationships ${formatEdges(plan.edges as ChainGraphEdge[])} exist on GitHub but are not registered.`,
            ...(conflicted
              ? [`Re-run \`admin chain ${request.operation}\` with --yes; it re-reads GitHub first.`]
              : resumeStep(chainId)),
          ],
        },
      };
    }
    expectedRev = named.value.rev;
  }

  const late: { message?: string } = {};
  const acceptance = await acceptChainGraph(chainStore, {
    chainId,
    members: plan.members,
    edges: plan.edges,
    headIssueNumber: plan.headIssueNumber,
    ...(expectedRev === undefined ? {} : { expectedRev }),
    ownershipScope: { sessionId },
    // The last word on the frozen prefixes, taken inside the transaction that
    // moves the accepted pointer. Steps 1 and 3 both read them outside a write,
    // and a freeze bumps no chain row for a compare-and-set to catch — so this
    // is the only check a freeze cannot slip past. It should never fire after
    // step 3 (automation is suspended by then), and it is here for the case
    // step 3 cannot cover: a task that started from something other than this
    // session's execution labels.
    commitGuard: ({ frozenPrefixes }) => {
      const verdict = checkFrozenPrefixes({
        candidate: { members: plan.members, edges: plan.edges },
        snapshots: frozenPrefixes,
        chainId: chainId!,
      });
      if (verdict.ok) return undefined;
      late.message = frozenPrefixRefusal(verdict).message;
      return late.message;
    },
    source,
    now,
  });

  if (acceptance.followUpFailure !== undefined) {
    followUpFailure = {
      code: acceptance.followUpFailure.code,
      ...(acceptance.followUpFailure.detail === undefined
        ? {}
        : { detail: acceptance.followUpFailure.detail }),
    };
  }

  if (acceptance.status === "rejected") {
    return {
      failure: {
        ...refusalFailure(structuralChainLinearRefusal(request.operation, acceptance.diagnostics), []),
        remediation:
          "Another chain claimed one of these Issues while the relationships were being written, so the registry " +
          "refused the graph inside its own transaction. The relationships exist on GitHub; the chain does not " +
          "record them.",
      },
    };
  }
  if (acceptance.status === "vetoed") {
    return {
      failure: {
        kind: "frozen_prefix",
        transient: false,
        message: late.message ?? acceptance.detail,
        remediation:
          "A dependency prefix was frozen at the exact moment this edit was being committed, and a started Issue's " +
          "pinned ancestry outranks an operator edit. The relationships exist on GitHub but were not accepted into " +
          "the registry.",
        recovery: [
          `Reconcile GitHub with the accepted graph using \`admin chain validate ${chainId}\`.`,
          ...resumeStep(chainId),
        ],
      },
    };
  }
  if (acceptance.status === "conflict") {
    return {
      failure: {
        kind: "conflict",
        transient: true,
        message: acceptance.detail,
        remediation:
          "The chain was modified while this edit ran, so the graph was refused rather than written on top of a " +
          "state it never saw. The relationships exist on GitHub; re-run the command to record them.",
        recovery: [`Re-run \`admin chain ${request.operation}\` with --yes; it re-reads GitHub first.`],
      },
    };
  }
  if (acceptance.status === "failed") {
    return {
      failure: {
        kind: "store_error",
        transient: false,
        message: `${acceptance.code}${acceptance.detail === undefined ? "" : `: ${acceptance.detail}`}`,
        remediation:
          "The registry refused the write, so the accepted graph is unchanged while GitHub holds the new " +
          "relationships. Re-run the command once the registry accepts writes.",
        recovery: [`Inspect the chain with \`admin chain show ${chainId}\`.`, ...resumeStep(chainId)],
      },
    };
  }

  // The graph landed, and it is the one GitHub was read back holding — which is
  // exactly the claim `chain sync` records as `in_sync`. Recording it here means
  // a chain built by this command does not sit in `chain list --sync-status
  // unknown` until somebody runs a sync that has nothing to import. Guarded by
  // the revision the acceptance itself committed, for the same reason sync
  // guards its own: a slower writer must not stamp `in_sync` over a verdict
  // reached about a newer graph. A lost guard is bookkeeping — the edit stands.
  const marked = await chainStore.setChainSyncState(chainId, {
    status: "in_sync",
    checkedAt: now,
    syncedAt: now,
    expectedRev: acceptance.committedRev,
    now,
  });
  if (!marked.ok) {
    followUpFailure = {
      code: marked.code,
      detail: `the edit was applied, but the chain's synchronization metadata was not updated${marked.detail === undefined ? "" : `: ${marked.detail}`}`,
    };
  }

  const record = await chainStore.getChainRecord(chainId);
  return {
    chainId,
    revision: {
      graphRevision: record?.graphRevision ?? acceptance.acceptedRevision,
      acceptedRevision: record?.acceptedRevision ?? acceptance.acceptedRevision,
      fingerprint: record?.graphFingerprint ?? acceptance.fingerprint,
    },
    ...(followUpFailure === undefined ? {} : { followUpFailure }),
  };
}

export async function runChainNew(argv: string[]): Promise<void> {
  await runChainEdit(argv, "new");
}

export async function runChainAppend(argv: string[]): Promise<void> {
  await runChainEdit(argv, "append");
}

export async function runChainPrepend(argv: string[]): Promise<void> {
  await runChainEdit(argv, "prepend");
}
