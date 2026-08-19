/**
 * Exclusive scopes for one linear chain edit (issue #791 review).
 *
 * `admin chain new|append|prepend` carries out a seven-step mutation whose
 * safety rests on one invariant: from the moment automation is suspended for an
 * Issue until the moment the edit's own labels are handed back, nothing may make
 * that Issue eligible again. Per-label suspension attribution keeps *unrelated*
 * suspensions (an `admin issue suspend`, a different edit that already
 * finished) from being lifted by an edit that did not take them — but it cannot
 * hold the line between two edits that are running at the same time:
 *
 *   - edit A suspends #11, removing its execution labels;
 *   - edit B starts on #11 while A is still writing relationships. The labels
 *     are already gone, so B removes nothing and owns nothing;
 *   - A finishes, restores the labels it removed, and clears the record;
 *   - #11 is eligible again while B is still half-way through its own edit.
 *
 * Attribution cannot fix this on its own: whichever edit finishes first is the
 * one that hands the labels back, and it has no way to know another edit still
 * needs them withheld. So overlapping edits are serialized instead — the second
 * one is refused before it suspends anything, rather than allowed to interleave.
 *
 * The same mechanism covers a chain *name*, with one difference worth being
 * precise about. `chain new <issues> <name>` checks the name is free before it
 * writes anything; two concurrent runs asking for the same name would both pass
 * that check and one would work through a whole mutation it could never finish.
 * Holding the name keeps the loser from starting. It is NOT what makes the name
 * safe: chain IDs and aliases share one namespace (#788), so a creation that
 * takes no lock at all — an intake registering a candidate whose head Issue
 * derives the same ID — can still occupy the name between the check and the
 * write. What binds is that the name is registered by the same registry
 * transaction that allocates the chain's ID, so a lost race creates no chain.
 *
 * A scope is a plain string so one table can hold both kinds. Everything about
 * how a scope is spelled lives here; the SQLite half only stores and compares
 * them.
 */

/**
 * How long a lock may stand WITHOUT BEING RENEWED before another edit may take
 * it over.
 *
 * There has to be a takeover at all: a process killed between acquiring a scope
 * and releasing it would otherwise hold it forever, and the documented recovery
 * for every failure in this command is "re-run it" — which needs the same
 * scopes.
 *
 * What this window must NOT do is expire under a run that is still working. The
 * owner therefore renews every {@link CHAIN_EDIT_LOCK_RENEW_MS} for as long as
 * it executes, so the age compared here is measured from the last heartbeat and
 * not from acquisition: a genuinely slow edit — a rate-limited provider, a chain
 * with many Issues — keeps its scopes however long it takes, and only a run that
 * has stopped renewing can have them taken (issue #791 review). Without that,
 * an edit slower than this window could have its scopes claimed while it was
 * still writing relationships and suspending labels, which is the interleaving
 * this whole module exists to prevent.
 *
 * That leaves the window trading off crashes alone: too short and an owner whose
 * heartbeat is starved (a blocked event loop, a contended SQLite writer) looks
 * dead while it is not; too long and a crashed edit blocks its own retry, while
 * the Issues it suspended stay ineligible. Half an hour is many missed
 * heartbeats' worth of slack, and short enough that a crash costs a coffee break
 * rather than an afternoon.
 */
export const CHAIN_EDIT_LOCK_STALE_MS = 30 * 60 * 1000;

/**
 * How often the run holding the scopes pushes them forward.
 *
 * A third of {@link CHAIN_EDIT_LOCK_STALE_MS}, so two consecutive heartbeats can
 * be missed before anybody else could read the scopes as abandoned.
 */
export const CHAIN_EDIT_LOCK_RENEW_MS = CHAIN_EDIT_LOCK_STALE_MS / 3;

/**
 * How long a lock whose owning PROCESS still answers may stand unrenewed before
 * it is taken over anyway.
 *
 * {@link CHAIN_EDIT_LOCK_STALE_MS} on its own cannot make the window safe, and
 * no amount of widening it can. Every provider call an edit makes is a
 * `spawnSync`: it blocks the event loop, so the heartbeat does not fire *at all*
 * while one is outstanding, and a claim can go stale in the middle of a call
 * that is still running. Checking the claim before each call — which this
 * command does — does not close that: the check passes, the call blocks past the
 * window, another edit takes the scopes over and starts its own mutation, and
 * the first run comes back and finishes writing relationships and handing
 * execution labels back on Issues the second edit now owns (issue #791 review).
 *
 * So liveness, not age, is what ends a claim: a takeover additionally requires
 * that the owning process is *gone* (see {@link ChainEditLockOwnerLiveness}). A
 * pid keeps answering while `spawnSync` blocks, which makes it the one heartbeat
 * that is genuinely independent of the provider calls, and it costs nothing to
 * read. A crashed edit is then superseded sooner than before, not later: its pid
 * is gone the moment it dies.
 *
 * This window is what remains for the case liveness cannot judge — a pid the
 * operating system has recycled onto an unrelated process, which would otherwise
 * hold these scopes for good. Twelve hours is far longer than any single `gh`
 * call can plausibly block, so the unfenced gap it leaves is theoretical, and
 * short enough that a recycled pid costs one working day rather than forever.
 */
export const CHAIN_EDIT_LOCK_ABANDONED_MS = 12 * 60 * 60 * 1000;

/**
 * What is known about the process that took a lock.
 *
 * `unknown` covers a row written by a build before pids were recorded and a lock
 * taken on a different machine, where a local pid says nothing. Both fall back
 * to the age-only rule, which is what those rows have always been judged by.
 */
export type ChainEditLockOwnerLiveness = "alive" | "gone" | "unknown";

/**
 * Whether a held scope may be taken from its owner. The single place the rule
 * lives; the SQLite half only supplies the facts.
 */
export function chainEditLockIsTakeable(input: {
  /** Since the last sign of life — acquisition or heartbeat, whichever is later. */
  ageMs: number;
  owner: ChainEditLockOwnerLiveness;
  /** Defaults to {@link CHAIN_EDIT_LOCK_STALE_MS}. */
  staleAfterMs?: number;
  /** Defaults to {@link CHAIN_EDIT_LOCK_ABANDONED_MS}. */
  abandonedAfterMs?: number;
}): boolean {
  const staleAfterMs = input.staleAfterMs ?? CHAIN_EDIT_LOCK_STALE_MS;
  const abandonedAfterMs = input.abandonedAfterMs ?? CHAIN_EDIT_LOCK_ABANDONED_MS;
  // An age that cannot be established — an unparseable or hand-edited timestamp
  // — counts as live. Breaking a lock on a guess is exactly the interleaving
  // this module exists to prevent.
  if (!Number.isFinite(input.ageMs)) return false;
  if (input.ageMs < staleAfterMs) return false;
  // A process that still answers is working, however long its current provider
  // call has blocked for; only the recycled-pid ceiling overrides it.
  if (input.owner === "alive") return input.ageMs >= Math.max(abandonedAfterMs, staleAfterMs);
  return true;
}

/** Who holds a scope, for the refusal an edit that loses the race reports. */
export interface ChainEditLockHolder {
  /** Identifies one invocation. Never reused, so a lock is only ever released by the run that took it. */
  ownerId: string;
  /** The human-meaningful edit identity — what {@link ChainEditLockHolder.ownerId} is doing. */
  operationId: string;
  acquiredAt: string;
  /** The owning process, when one was recorded — see {@link CHAIN_EDIT_LOCK_ABANDONED_MS}. */
  pid?: number;
  /** The machine {@link ChainEditLockHolder.pid} is a pid on. A pid is only meaningful with it. */
  host?: string;
}

/**
 * All-or-nothing: either every requested scope is held by this owner, or none of
 * them is and the first contended scope is named.
 */
export type ChainEditLockAcquisition =
  | { ok: true; scopes: string[] }
  | { ok: false; scope: string; heldBy: ChainEditLockHolder };

export interface AcquireChainEditLocksInput {
  scopes: readonly string[];
  ownerId: string;
  operationId: string;
  now: string;
  /**
   * The process making the claim, so a later run can tell "still working" from
   * "died holding it" without waiting out {@link CHAIN_EDIT_LOCK_ABANDONED_MS}.
   * Omitted by a caller that cannot answer for a pid; the lock then falls back
   * to the age-only rule.
   */
  ownerPid?: number;
  /** The machine {@link AcquireChainEditLocksInput.ownerPid} is a pid on. */
  ownerHost?: string;
  /** Defaults to {@link CHAIN_EDIT_LOCK_STALE_MS}. */
  staleAfterMs?: number;
  /** Defaults to {@link CHAIN_EDIT_LOCK_ABANDONED_MS}. */
  abandonedAfterMs?: number;
}

export interface RenewChainEditLocksInput {
  scopes: readonly string[];
  ownerId: string;
  /** The heartbeat's timestamp — what the staleness age is measured from next. */
  now: string;
}

/** What a heartbeat found: which scopes it kept, and which had already gone. */
export interface ChainEditLockRenewal {
  renewed: string[];
  /** No longer held by this owner — released, or already taken over. */
  lost: string[];
}

/** Durable half. SQLite implementation: stores/sqlite-chain-registry-store.ts. */
export interface ChainEditLockStore {
  acquireChainEditLocks(input: AcquireChainEditLocksInput): Promise<ChainEditLockAcquisition>;
  /**
   * Push every scope this owner still holds forward in time, so a long apply
   * cannot be declared stale while it is running (issue #791 review).
   *
   * Reports the scopes it no longer owns rather than re-taking them: a scope
   * that has changed hands belongs to the run holding it now, and grabbing it
   * back would put two edits on the same Issue — exactly what the lock exists to
   * prevent.
   */
  renewChainEditLocks(input: RenewChainEditLocksInput): Promise<ChainEditLockRenewal>;
  /** Releases only the scopes this owner still holds; a scope taken over by
   * another run is left alone. */
  releaseChainEditLocks(scopes: readonly string[], ownerId: string): Promise<{ released: number }>;
}

/**
 * One Issue, in one session. Session-scoped because execution labels are: two
 * sessions tracking the same Issue number suspend different label sets on
 * different repositories.
 *
 * The session id is percent-encoded so an id containing `:` cannot be read as a
 * different issue scope.
 */
export function chainEditIssueLockScope(sessionId: string, issueNumber: number): string {
  return `issue:${encodeURIComponent(sessionId)}:${issueNumber}`;
}

/**
 * One chain name. NOT session-scoped: chain IDs and aliases share one global
 * namespace (#788), so two sessions asking for the same name are in genuine
 * conflict.
 */
export function chainEditAliasLockScope(alias: string): string {
  return `alias:${alias}`;
}

/** Every scope one linear edit needs, deduplicated and in a fixed order. */
export function chainEditLockScopes(input: {
  sessionId: string;
  issueNumbers: readonly number[];
  name?: string;
}): string[] {
  const scopes = input.issueNumbers.map((n) => chainEditIssueLockScope(input.sessionId, n));
  if (input.name !== undefined) scopes.push(chainEditAliasLockScope(input.name));
  return [...new Set(scopes)].sort();
}

/** What a scope names. `unknown` for a shape written by a later build. */
export function chainEditLockScopeKind(scope: string): "issue" | "alias" | "unknown" {
  if (scope.startsWith("issue:")) return "issue";
  if (scope.startsWith("alias:")) return "alias";
  return "unknown";
}

/** A scope as an operator reads it. Unrecognized shapes are shown verbatim. */
export function describeChainEditLockScope(scope: string): string {
  if (scope.startsWith("issue:")) {
    const issueNumber = scope.slice(scope.lastIndexOf(":") + 1);
    return `issue #${issueNumber}`;
  }
  if (scope.startsWith("alias:")) return `the chain name "${scope.slice("alias:".length)}"`;
  return scope;
}
