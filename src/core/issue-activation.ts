import type { ResolvedSession } from "./session.js";
import type { AgentId } from "./task.js";
import type { WorkItemProvider } from "../providers/types.js";

/**
 * Reusable automation-label activation/suspension for one or more Issues
 * (issue #787).
 *
 * Dependency-chain construction and repair must prevent `github-intake` from
 * picking an Issue back up while its GitHub Issue Relationships are mid-edit.
 * `core/github-intake.ts`'s `labelsToPhase` is the actual pickup gate: it
 * reads a fixed set of `status:*` labels (the phase/lane markers) together
 * with an `agent:*` label to decide whether — and how — an Issue enters the
 * loop. "Suspending" automation for an Issue means removing exactly that
 * label subset (never a session's other coarse-state, human-applied, or
 * unrelated labels) and recording what was removed so a later "activation"
 * restores only what this operation suspended. A failed or partial
 * suspend/activate must never be repaired by guessing — see
 * {@link suspendIssueAutomation} / {@link activateIssueAutomation} for the
 * partial-failure and idempotency contract.
 *
 * This module is pure orchestration over the {@link WorkItemProvider} and
 * {@link IssueActivationStore} ports, so it is directly callable — by a chain
 * command or by `github-intake` chain-error handling — without shelling out
 * to the CLI. The SQLite store implementation lives in
 * stores/sqlite-issue-activation-store.ts.
 */

/** Every agent id `labelsToPhase` recognizes via an `agent:<id>` label. */
const KNOWN_AGENT_IDS: readonly AgentId[] = ["claude", "codex", "gemini"];

/**
 * Session `labels` keys `labelsToPhase` gates on, each paired with the same
 * literal fallback `core/outbox-effects.ts` uses when a session leaves the key
 * unconfigured. Resolving through this table (rather than a fixed literal)
 * means a session that renames its lane labels is suspended/restored using
 * its OWN configured names, not a hard-coded default.
 */
const STATUS_LABEL_KEYS: ReadonlyArray<{ key: string; fallback: string }> = [
  { key: "needsImplementation", fallback: "status:needs-implementation" },
  { key: "needsFix", fallback: "status:needs-fix" },
  { key: "needsReview", fallback: "status:needs-review" },
  { key: "needsResearch", fallback: "status:research-needed" },
  { key: "needsContentResearch", fallback: "status:content-needed" },
  { key: "needsConflictResolution", fallback: "status:needs-conflict-resolution" },
];

/** The resolved execution-label vocabulary for a session: every label value
 * that could gate `github-intake` pickup for SOME Issue in this session. */
export interface ExecutionLabelSet {
  agentLabels: string[];
  statusLabels: string[];
}

/** Resolve {@link ExecutionLabelSet} from session/flow configuration. Never
 * hard-codes a specific agent or phase — every session resolves its own set.
 *
 * Includes BOTH a session's configured alias and the literal default
 * (issue #787 review): `github-intake`'s `labelsToPhase` gate always checks
 * the literal `status:*` values, never a session's `labels` configuration.
 * A session that renames e.g. `needsImplementation` to a custom label is
 * still gated by the literal `status:needs-implementation` on GitHub, so
 * suspending only the configured alias would remove a label `github-intake`
 * never looks at while leaving the real gate in place. Resolving both means
 * suspend/activate always covers the label `github-intake` actually reads,
 * regardless of what a session has renamed it to. */
export function resolveExecutionLabelSet(session: ResolvedSession): ExecutionLabelSet {
  return {
    agentLabels: KNOWN_AGENT_IDS.map((id) => `agent:${id}`),
    statusLabels: Array.from(
      new Set(
        STATUS_LABEL_KEYS.flatMap(({ key, fallback }) => {
          const configured = session.labels[key] as string | undefined;
          return configured ? [configured, fallback] : [fallback];
        }),
      ),
    ),
  };
}

function executionLabelValues(set: ExecutionLabelSet): Set<string> {
  return new Set([...set.agentLabels, ...set.statusLabels]);
}

/** A computed suspend/activate plan against an Issue's CURRENT label set. */
export interface LabelDiff {
  /** Execution labels to remove (suspend only). */
  removed: string[];
  /** Execution labels to add (activate only). */
  added: string[];
  /** Labels present on the Issue that are untouched by this operation. */
  preserved: string[];
  /** Labels this plan makes available for a future restore. */
  restorable: string[];
}

/** Plan a suspend: every currently-present execution label is removed; every
 * other current label is preserved untouched. */
export function planSuspend(session: ResolvedSession, currentLabels: string[]): LabelDiff {
  const execValues = executionLabelValues(resolveExecutionLabelSet(session));
  const removed = currentLabels.filter((l) => execValues.has(l));
  const preserved = currentLabels.filter((l) => !execValues.has(l));
  return { removed, added: [], preserved, restorable: removed };
}

/** Plan an activate: every restorable label not already present is added. */
export function planActivate(restorableLabels: string[], currentLabels: string[]): LabelDiff {
  const currentSet = new Set(currentLabels);
  const added = restorableLabels.filter((l) => !currentSet.has(l));
  return { removed: [], added, preserved: currentLabels, restorable: [] };
}

/** A suspension record: exactly the labels a prior `suspend` removed from one
 * Issue, kept so a later `activate` restores only what this operation
 * suspended — never a full, freshly-resolved label bundle. */
export interface IssueAutomationSuspension {
  sessionId: string;
  issueNumber: number;
  labels: string[];
  operationId: string;
  suspendedAt: string;
  updatedAt: string;
  /**
   * Store-owned monotonic revision, bumped on every write to this
   * (sessionId, issueNumber) record (issue #787 review). `updatedAt` alone
   * cannot identify a specific version of the record for CAS: two concurrent
   * operations (two CLI invocations, or two direct callers of the exported
   * core API) can compute the same ISO-millisecond `now`, in which case a
   * stale write's `expectedUpdatedAt` would equal the current row's
   * `updated_at` even though the row moved — letting it clobber a newer
   * suspension. `rev` changes on every commit regardless of wall-clock
   * timestamp, so it is what `putSuspensionIfUnchanged` /
   * `clearSuspensionIfUnchanged` actually key their CAS predicate on.
   */
  rev: number;
  /**
   * Per-label attribution: which operation removed each label in
   * {@link labels} (issue #791 review).
   *
   * A record is a merged set — a second `suspend` adds its removals to
   * whatever a first one left — so the record-level {@link operationId} names
   * only the operation that OPENED it. An operation that merely added to
   * somebody else's record still has to recognize its own labels later: it is
   * the one that must hand exactly those back (and no others) once its edit
   * completes, including on a retry that has no memory of the run that removed
   * them. Attribution kept only at record level cannot answer that, and the
   * labels of whichever operation did not open the record stay withheld
   * forever.
   *
   * Optional because a record written before this field existed has none; read
   * it through {@link suspensionLabelOwner}, which falls back to the
   * record-level {@link operationId} exactly as the pre-#791 behaviour did.
   */
  labelOperations?: Record<string, string>;
}

/**
 * The operation answerable for one label on a suspension record: the one that
 * removed it, or — for a record predating {@link
 * IssueAutomationSuspension.labelOperations} — the one that opened the record.
 */
export function suspensionLabelOwner(record: IssueAutomationSuspension, label: string): string {
  return record.labelOperations?.[label] ?? record.operationId;
}

/** The labels on `record` that `operationId` removed. */
export function suspensionLabelsOwnedBy(
  record: IssueAutomationSuspension,
  operationId: string,
): string[] {
  return record.labels.filter((label) => suspensionLabelOwner(record, label) === operationId);
}

/** Restorable-state port. SQLite implementation:
 * stores/sqlite-issue-activation-store.ts. */
export interface IssueActivationStore {
  getSuspension(sessionId: string, issueNumber: number): Promise<IssueAutomationSuspension | undefined>;
  putSuspension(record: IssueAutomationSuspension): Promise<void>;
  clearSuspension(sessionId: string, issueNumber: number): Promise<void>;
  /**
   * Compare-and-swap write (issue #787 review): commits only if the record
   * for (sessionId, issueNumber) is still exactly as it was when the caller
   * observed it — `expectedRev` is that observed record's `rev`, or
   * `undefined` if no record existed yet. Returns `false` WITHOUT writing
   * anything when a concurrent suspend/activate on the same Issue already
   * moved the record, so a stale read can never overwrite state a concurrent
   * operation is relying on. Keyed on the store-owned monotonic `rev` rather
   * than `updatedAt`: two concurrent callers can share the same
   * ISO-millisecond timestamp, which would let a timestamp-only predicate
   * match a row that has actually moved on. `suspendIssueAutomation`/
   * `activateIssueAutomation` use this exclusively (never the unconditional
   * `putSuspension` above) for every write derived from a prior read.
   */
  putSuspensionIfUnchanged(record: IssueAutomationSuspension, expectedRev: number | undefined): Promise<boolean>;
  /** Compare-and-swap delete: same contract as {@link putSuspensionIfUnchanged}. */
  clearSuspensionIfUnchanged(sessionId: string, issueNumber: number, expectedRev: number): Promise<boolean>;
}

/** Outcome of one `suspend`/`activate` call for a single Issue. */
export interface IssueActivationOutcome {
  issueNumber: number;
  ok: boolean;
  error?: string;
  removed: string[];
  added: string[];
  preserved: string[];
  restorable: string[];
  /** Repeated suspend with nothing new to remove; `restorable` carries the
   * standing suspension (if any). */
  alreadySuspended?: boolean;
  /**
   * Labels this call took off the Issue that are now neither back on it nor on
   * any suspension record: the record could not be committed AND the
   * compensating re-add failed too. Nothing can restore them automatically —
   * `activateIssueAutomation` has no record naming them — so a caller must
   * report an explicit manual re-add rather than an activation command (issue
   * #791 review). Present only on that path.
   */
  strandedLabels?: string[];
  /** Activate with no suspension on record for this Issue; a safe no-op. */
  alreadyActive?: boolean;
}

/** Bound on compare-and-swap retries in {@link suspendIssueAutomation} /
 * {@link activateIssueAutomation}: a concurrent operation on the SAME Issue is
 * rare, and each lost race re-reads and retries against whatever it left
 * behind, so a handful of attempts is enough to converge rather than mask a
 * genuine conflict as a hang. */
const MAX_CAS_ATTEMPTS = 3;

/** Outcome of persisting a suspension record via CAS, or the durability
 * failure that must trigger compensation in {@link suspendIssueAutomation}. */
type PersistSuspensionResult = { ok: true; restorable: string[] } | { ok: false; error: string };

/**
 * Persist a suspension record for (sessionId, issueNumber), merging
 * `newlyRemoved` into whatever the store currently holds via CAS
 * ({@link IssueActivationStore.putSuspensionIfUnchanged}). Re-reads and
 * retries the merge (up to {@link MAX_CAS_ATTEMPTS}) if a concurrent
 * suspend/activate on the same Issue wins the race, so the record this call
 * commits always builds on the latest state rather than clobbering it (issue
 * #787 review). A store fault (rather than a lost race) fails immediately —
 * retrying an exception from the store itself would not help.
 */
async function persistSuspensionRecord(
  store: IssueActivationStore,
  sessionId: string,
  issueNumber: number,
  operationId: string,
  now: string,
  newlyRemoved: string[],
  baseline: IssueAutomationSuspension | undefined,
): Promise<PersistSuspensionResult> {
  let current = baseline;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const restorable = Array.from(new Set([...(current?.labels ?? []), ...newlyRemoved]));
    // Per-label attribution, merged the same way the labels are: whatever the
    // record already attributes stands, and every label THIS call removed is
    // attributed to it (issue #791 review). Last remover wins for a label the
    // record already carried — it was put back on the Issue and taken off
    // again, and the operation that took it off this time is the one that owes
    // it back.
    const labelOperations: Record<string, string> = {};
    for (const label of current?.labels ?? []) {
      labelOperations[label] = suspensionLabelOwner(current!, label);
    }
    for (const label of newlyRemoved) labelOperations[label] = operationId;
    let committed: boolean;
    try {
      committed = await store.putSuspensionIfUnchanged(
        {
          sessionId,
          issueNumber,
          labels: restorable,
          labelOperations,
          // The operation that STARTED the suspension keeps it, exactly as
          // `suspendedAt` does (issue #791 review). A record is a merged set —
          // this call may only be adding to one another operation opened — and
          // overwriting the attribution would let this operation later mistake
          // that other one's labels for its own and lift a suspension it never
          // took. Which operation owes which label back is `labelOperations`
          // above; this field is the record's origin, not a claim on its
          // contents.
          operationId: current?.operationId ?? operationId,
          suspendedAt: current?.suspendedAt ?? now,
          updatedAt: now,
          // The store computes the authoritative next `rev` itself on commit;
          // this placeholder is only here to satisfy the record's shape.
          rev: current?.rev ?? 0,
        },
        current?.rev,
      );
    } catch (err) {
      return { ok: false, error: `Failed to record suspension: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (committed) return { ok: true, restorable };
    try {
      current = await store.getSuspension(sessionId, issueNumber);
    } catch (err) {
      return { ok: false, error: `Failed to record suspension: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: false, error: "Failed to record suspension: concurrent update conflict" };
}

/**
 * Suspend automation for one Issue: remove its currently-present execution
 * labels and record exactly what was removed.
 *
 * Idempotent: a repeated call with nothing left to remove is a safe no-op
 * that reports the standing suspension via `alreadySuspended`/`restorable`,
 * without writing to the store.
 *
 * Partial-failure safe: only labels the provider confirms were removed are
 * added to the restorable set (merged with any prior record) — a label this
 * call failed to remove is never presented as restorable, and the store is
 * never overwritten with an optimistic full set. A caller can retry; the plan
 * is recomputed from the Issue's live labels each time, so a retry only
 * targets what is still present.
 *
 * Attribution-safe (issue #787 review): a label another actor already
 * removed between the initial read and this call is re-verified as still
 * present immediately before attempting its removal, and is skipped (never
 * recorded as restorable) if it is not. That re-verification narrows but
 * cannot close the race entirely — another actor can still remove the same
 * label in the instant between this call's own re-verification read and its
 * DELETE request landing, and both providers report the resulting 404 as
 * success. So the removal result itself is also checked via
 * `alreadyAbsent`: only a label THIS call's provider request actually
 * removed (not one it merely found already gone) is added to the restorable
 * set — a provider reporting success for removing an already-absent label
 * must never be credited to this operation.
 *
 * Durability-safe (issue #787 review): if the record documenting these
 * removals can't be committed — the CAS in {@link persistSuspensionRecord}
 * keeps losing to a concurrent writer, or the store itself faults (e.g. a
 * prolonged lock or disk error) — this call compensates by re-adding exactly
 * the labels it just removed, so a failed suspend never leaves the Issue
 * without execution labels AND without a restorable record. Compensation
 * itself is reported in `error`/`removed` if it can't fully succeed either, and
 * the labels it could not put back are called out in `strandedLabels` — those
 * exist on no record, so no command restores them and the caller must ask for a
 * manual re-add (issue #791 review).
 */
export async function suspendIssueAutomation(
  session: ResolvedSession,
  provider: WorkItemProvider,
  store: IssueActivationStore,
  issueNumber: number,
  operationId: string,
  now: string,
): Promise<IssueActivationOutcome> {
  const read = provider.getItem(issueNumber);
  if (!read.ok) {
    return { issueNumber, ok: false, error: read.error, removed: [], added: [], preserved: [], restorable: [] };
  }
  const diff = planSuspend(session, read.value.labels);
  const existing = await store.getSuspension(session.sessionId, issueNumber);

  if (diff.removed.length === 0) {
    const restorable = existing?.labels ?? [];
    return {
      issueNumber,
      ok: true,
      removed: [],
      added: [],
      preserved: diff.preserved,
      restorable,
      alreadySuspended: restorable.length > 0,
    };
  }

  // Re-verify presence immediately before EACH removal (issue #787 review): the
  // `read` above may already be stale by the time this loop runs, and both the
  // GitHub and Gitea providers treat removing an already-absent label as
  // success (404 -> ok). A single snapshot taken before the loop is not
  // enough — another actor can remove a LATER label in `diff.removed` after
  // that snapshot but before this loop reaches it, and the provider would
  // still report success. So re-read immediately before each deletion: only a
  // label still actually present right before ITS OWN removal is eligible to
  // be recorded as newly removed by this call. A failed re-read aborts the
  // rest of the batch (a transient read fault gives no reliable attribution
  // for labels not yet checked either) rather than being credited as removed
  // or silently skipped.
  const newlyRemoved: string[] = [];
  const failedLabels: string[] = [];
  let verificationError: string | undefined;
  for (const label of diff.removed) {
    const preRemovalRead = provider.getItem(issueNumber);
    if (!preRemovalRead.ok) {
      verificationError = preRemovalRead.error;
      break;
    }
    if (!preRemovalRead.value.labels.includes(label)) continue;
    const result = provider.transitionItem(issueNumber, { kind: "remove-label", label });
    if (!result.ok) {
      failedLabels.push(label);
    } else if (!result.alreadyAbsent) {
      newlyRemoved.push(label);
    }
    // else: the provider found the label already gone (another actor won the
    // race between the re-verification read above and this request) — the
    // Issue ends up in the state suspend wants either way, but this call did
    // not itself remove it, so it must not be credited as restorable.
  }

  if (verificationError && newlyRemoved.length === 0) {
    return {
      issueNumber,
      ok: false,
      error: verificationError,
      removed: [],
      added: [],
      preserved: diff.preserved,
      restorable: existing?.labels ?? [],
    };
  }

  const persisted = await persistSuspensionRecord(
    store,
    session.sessionId,
    issueNumber,
    operationId,
    now,
    newlyRemoved,
    existing,
  );

  if (!persisted.ok) {
    const restoreFailed: string[] = [];
    for (const label of newlyRemoved) {
      const result = provider.transitionItem(issueNumber, { kind: "add-label", label });
      if (!result.ok) restoreFailed.push(label);
    }
    const detail =
      restoreFailed.length > 0
        ? `; failed to restore label(s) ${restoreFailed.join(", ")} during compensation — manual recovery required`
        : "";
    return {
      issueNumber,
      ok: false,
      error: `${persisted.error}${detail}`,
      removed: restoreFailed,
      added: [],
      preserved: diff.preserved,
      restorable: [],
      // Named separately from `removed` so a caller can tell this apart from an
      // ordinary failed suspend: these labels are off the Issue with no record
      // anywhere, so activation cannot bring them back and only a manual re-add
      // will (issue #791 review).
      ...(restoreFailed.length === 0 ? {} : { strandedLabels: restoreFailed }),
    };
  }

  if (failedLabels.length > 0 || verificationError) {
    const errors: string[] = [];
    if (failedLabels.length > 0) errors.push(`Failed to remove label(s): ${failedLabels.join(", ")}`);
    if (verificationError) errors.push(`Aborted remaining removals after a verification read failure: ${verificationError}`);
    return {
      issueNumber,
      ok: false,
      error: errors.join("; "),
      removed: newlyRemoved,
      added: [],
      preserved: diff.preserved,
      restorable: persisted.restorable,
    };
  }

  return { issueNumber, ok: true, removed: newlyRemoved, added: [], preserved: diff.preserved, restorable: persisted.restorable };
}

/**
 * Activate automation for one Issue: restore exactly the labels the standing
 * suspension recorded (see safety contract in the module header — never
 * restore anything else, and never restore optimistically on failure).
 *
 * Idempotent: no suspension on record is a safe no-op (`alreadyActive`).
 *
 * Partial-failure safe: a label the provider fails to add stays on the
 * suspension record (mirroring `suspendIssueAutomation`), so a retry only
 * targets what is still missing; the record is cleared only once every
 * suspended label is confirmed present on the Issue.
 *
 * Revalidation-safe (issue #787 review): whether a recorded label is still
 * missing is decided from a fresh read taken immediately before the
 * clear/update, never from the `read` snapshot the add-label loop planned
 * against — that snapshot can go stale if another actor removes a recorded
 * label while this call is adding others, and trusting it would make
 * `stillSuspended` empty (clearing the record) even though the Issue is
 * still actually missing that label, with no record left for a later
 * activate to restore it from.
 *
 * Race-safe (issue #787 review): the final clear/update of the suspension
 * record is a CAS against the exact revision this call read
 * ({@link IssueActivationStore.clearSuspensionIfUnchanged} /
 * {@link IssueActivationStore.putSuspensionIfUnchanged}). If a concurrent
 * `suspend` (or another `activate`) on the same Issue commits a newer record
 * in between, an unconditional write would silently delete or overwrite it —
 * this instead loses the race, re-reads whatever the other call left behind,
 * and retries the whole read/add/write sequence against it (bounded by
 * {@link MAX_CAS_ATTEMPTS}) rather than ever clobbering a record it didn't
 * observe.
 *
 * Attribution-safe across operations (issue #791 review): `options.onlyLabels`
 * narrows the restore to the labels the CALLER suspended, leaving every other
 * recorded label both missing from the Issue and on the record. A suspension
 * record is a merged set — a second `suspend` adds to whatever a first one
 * left — so an operation that suspended only part of it must not restore the
 * rest: doing so makes an Issue eligible while an unrelated suspension is
 * still meant to hold. Omitting the option restores the whole record, which is
 * what `admin issue activate` (an operator lifting every suspension) means.
 */
export async function activateIssueAutomation(
  session: ResolvedSession,
  provider: WorkItemProvider,
  store: IssueActivationStore,
  issueNumber: number,
  now: string,
  options?: { onlyLabels?: readonly string[] },
): Promise<IssueActivationOutcome> {
  const scope = options?.onlyLabels === undefined ? undefined : new Set(options.onlyLabels);
  /** Recorded labels this call is not allowed to restore, so the record keeps them verbatim. */
  const outOfScope = (label: string): boolean => scope !== undefined && !scope.has(label);

  // Accumulated across CAS-retry attempts (not reset per attempt): a label
  // added in a losing attempt was still really added to the Issue, and must
  // still be reported even though that attempt's own write lost its race.
  const everAdded = new Set<string>();

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const existing = await store.getSuspension(session.sessionId, issueNumber);
    if (!existing || existing.labels.length === 0) {
      return {
        issueNumber,
        ok: true,
        removed: [],
        added: Array.from(everAdded),
        preserved: [],
        restorable: [],
        alreadyActive: everAdded.size === 0,
      };
    }

    // Nothing on the record belongs to this caller: the standing suspension is
    // somebody else's, and lifting it is not this call's to do.
    const inScope = existing.labels.filter((l) => !outOfScope(l));
    if (inScope.length === 0) {
      return {
        issueNumber,
        ok: true,
        removed: [],
        added: Array.from(everAdded),
        preserved: [],
        restorable: existing.labels,
        alreadyActive: everAdded.size === 0,
      };
    }

    const read = provider.getItem(issueNumber);
    if (!read.ok) {
      return {
        issueNumber,
        ok: false,
        error: read.error,
        removed: [],
        added: Array.from(everAdded),
        preserved: [],
        restorable: existing.labels,
      };
    }
    const diff = planActivate(inScope, read.value.labels);

    const added: string[] = [];
    const failedLabels: string[] = [];
    for (const label of diff.added) {
      const result = provider.transitionItem(issueNumber, { kind: "add-label", label });
      if (result.ok) added.push(label);
      else failedLabels.push(label);
    }
    added.forEach((l) => everAdded.add(l));

    // Re-read immediately before deciding what is still missing (issue #787
    // review): `read` above is a snapshot from before the add-label calls,
    // and may already be stale — trusting it here (rather than the Issue's
    // live labels) can make `stillSuspended` empty for a label another actor
    // removed in the meantime, clearing the record while the label stays
    // missing.
    const postAddRead = provider.getItem(issueNumber);
    if (!postAddRead.ok) {
      return {
        issueNumber,
        ok: false,
        error: postAddRead.error,
        removed: [],
        added: Array.from(everAdded),
        preserved: diff.preserved,
        restorable: existing.labels,
      };
    }
    const nowPresent = new Set(postAddRead.value.labels);
    // An out-of-scope label stays on the record exactly as it was found, even if
    // it is currently present on the Issue: this call did not restore it, so it
    // has no standing to declare its suspension over.
    const stillSuspended = existing.labels.filter((l) => outOfScope(l) || !nowPresent.has(l));

    let committed: boolean;
    try {
      if (stillSuspended.length === 0) {
        committed = await store.clearSuspensionIfUnchanged(session.sessionId, issueNumber, existing.rev);
      } else if (stillSuspended.length !== existing.labels.length) {
        // Attribution is narrowed with the labels it describes: an entry for a
        // label this call handed back would outlive the suspension it belongs
        // to, and a later suspend re-attributes what it removes anyway.
        const labelOperations: Record<string, string> = {};
        for (const label of stillSuspended) labelOperations[label] = suspensionLabelOwner(existing, label);
        committed = await store.putSuspensionIfUnchanged(
          { ...existing, labels: stillSuspended, labelOperations, updatedAt: now },
          existing.rev,
        );
      } else {
        committed = true;
      }
    } catch (err) {
      return {
        issueNumber,
        ok: false,
        error: `Failed to record restoration: ${err instanceof Error ? err.message : String(err)}`,
        removed: [],
        added: Array.from(everAdded),
        preserved: diff.preserved,
        restorable: stillSuspended,
      };
    }

    if (!committed) continue;

    if (failedLabels.length > 0) {
      return {
        issueNumber,
        ok: false,
        error: `Failed to restore label(s): ${failedLabels.join(", ")}`,
        removed: [],
        added: Array.from(everAdded),
        preserved: diff.preserved,
        restorable: stillSuspended,
      };
    }

    return {
      issueNumber,
      ok: true,
      removed: [],
      added: Array.from(everAdded),
      preserved: diff.preserved,
      restorable: stillSuspended,
    };
  }

  return {
    issueNumber,
    ok: false,
    error: "Failed to record restoration: concurrent update conflict",
    removed: [],
    added: Array.from(everAdded),
    preserved: [],
    restorable: [],
  };
}
