/**
 * Persisted outbox scan cursor keys (issue #819).
 *
 * The dispatcher keeps three persisted cursors per dispatch identity — `floor`,
 * `fwd` (the protected-zone end) and `bulk`. Their roles, advancement rules and
 * invariants are specified in `docs/outbox-scan-cursor-contract.md`; this module
 * owns the *one* derivation that turns an ownership scope into the three
 * `outbox_scan_cursor.scan_key` values, so the CLI that computes the scope and
 * the dispatcher that reads/writes the rows can never drift apart.
 *
 * Nothing here touches a store. The functions are pure and total, which is what
 * makes the collision-resistance claims below directly testable.
 */

/**
 * The three cursor roles. `floor` is the identity key itself (see
 * {@link deriveScanCursorKey}); `fwd` and `bulk` are derived from it.
 */
export type OutboxScanCursorRole = "floor" | "fwd" | "bulk";

/** Every role, in the order the dispatcher reads them. */
export const OUTBOX_SCAN_CURSOR_ROLES: readonly OutboxScanCursorRole[] = ["floor", "fwd", "bulk"];

/**
 * The ownership scope a persisted cursor belongs to.
 *
 * A cursor records "everything up to this id is foreign or resolved *for this
 * scope*", so it is only reusable while the scope that produced it is
 * unchanged. The scope is therefore the session id **plus** the full
 * repository/provider ownership tuple the dispatch filter is built from — not
 * the session id alone. Repointing a session at a different repository (or a
 * different Gitea instance) changes the key, which intentionally orphans the
 * old cursor: see {@link deriveOwnershipScanCursorKey}.
 */
export interface OutboxOwnershipScope {
  /** Session id owning the dispatch run. */
  sessionId: string;
  /** Repo-host owner the session's rows belong to. */
  githubOwner: string;
  /** Repo-host repository name the session's rows belong to. */
  githubName: string;
  /**
   * Work-item ownership tuple for a `gitea-issues` session, which owns a second
   * (owner, repo) pair on a specific instance. Omitted for a GitHub-only
   * session. `baseUrl` participates because the same owner/repo pair on two
   * Gitea instances is two different ownership scopes.
   */
  gitea?: { owner: string; repo: string; baseUrl: string };
}

/**
 * Derive the dispatch-identity key for an ownership scope.
 *
 * `JSON.stringify` of an array of primitive strings/`null` is injective — each
 * distinct (sessionId, githubOwner, githubName, giteaOwner, giteaRepo,
 * giteaBaseUrl) tuple produces a distinct string, because the encoding escapes
 * every quote and never lets one field's content be mistaken for the
 * delimiter — so no extra escaping is needed to keep two differently-scoped
 * sessions (or the same session before/after a repo config change) from
 * colliding on one cursor.
 *
 * Changing any component intentionally orphans the previous key's cursor rows
 * rather than reusing them under the new filter. Reusing them would be wrong:
 * rows for the new target sitting below the old cursor's position were
 * confirmed non-matching (foreign) under the *old* filter, and `id > afterId`
 * would then skip them permanently even though they match the new one. An
 * orphaned cursor row is harmless — it is simply never looked up again.
 *
 * The returned string is byte-identical to the key shape persisted before issue
 * #819, so existing `outbox_scan_cursor` rows keep resolving; no migration is
 * required.
 */
export function deriveOwnershipScanCursorKey(scope: OutboxOwnershipScope): string {
  return JSON.stringify([
    scope.sessionId,
    scope.githubOwner,
    scope.githubName,
    scope.gitea?.owner ?? null,
    scope.gitea?.repo ?? null,
    scope.gitea?.baseUrl ?? null,
  ]);
}

/**
 * Derive the persisted `scan_key` for one cursor role of a dispatch identity.
 *
 * - `floor` is the identity key verbatim. It is the key issue #606 originally
 *   persisted, so keeping it unchanged is what makes every pre-existing cursor
 *   row keep working (see {@link deriveOwnershipScanCursorKey}).
 * - `fwd` and `bulk` are length-prefixed: `<len>:<identity>:<role>`.
 *
 * The length prefix is what makes the encoding injective, and a plain suffix
 * would not be: dispatch identities are only validated as nonempty strings, so
 * two identities `foo` and `foo::fwd` would collide — the former's `fwd` key
 * would equal the latter's own `floor` key, letting one identity read an
 * unrelated cursor and permanently skip its own older pending rows. Prefixing
 * with the identity's length delimits the identity portion unambiguously, so
 * for a fixed role no two distinct identities can produce the same derived key,
 * and the trailing role token separates the two derived roles from each other.
 *
 * Cross-role collision between `floor` (which is unprefixed, so its key space is
 * "any string") and a derived key is excluded by rejecting the one identity
 * shape that could produce it — see {@link isDerivedScanCursorKey}. Every scope
 * this repository supports satisfies that rule by construction: an ownership key
 * from {@link deriveOwnershipScanCursorKey} is a JSON array and always begins
 * with `[`, never a decimal digit.
 *
 * The result is plain TEXT, so tooling that inspects `outbox_scan_cursor`
 * directly still reads an ordinary string.
 *
 * @throws TypeError when `identityKey` is empty, or when it already has the
 * derived-key shape. Both are rejected rather than silently accepted because
 * the consequence of a colliding key is not a cosmetic bug: one identity would
 * read another's cursor and permanently skip its own older pending rows via
 * `id > afterId`. The CLI's ownership keys can never take either shape, so this
 * is a defensive assertion on a caller-supplied identity, not a runtime path.
 */
export function deriveScanCursorKey(identityKey: string, role: OutboxScanCursorRole): string {
  if (identityKey === "") {
    throw new TypeError("Outbox scan cursor identity must be a nonempty string");
  }
  if (isDerivedScanCursorKey(identityKey)) {
    throw new TypeError(
      `Outbox scan cursor identity must not have the derived-key shape <len>:<identity>:<role>: ${identityKey}`,
    );
  }
  if (role === "floor") return identityKey;
  return `${identityKey.length}:${identityKey}:${role}`;
}

/**
 * Whether `key` has the exact shape {@link deriveScanCursorKey} produces for a
 * derived role — a canonical decimal length, a `:`, exactly that many
 * characters of identity, and a trailing `:fwd` or `:bulk`.
 *
 * Used to reject an identity that would otherwise let a `floor` key collide with
 * some other identity's derived key (identity `3:foo:fwd` would own the same row
 * as identity `foo`'s `fwd` cursor). A non-canonical length such as `01:x:fwd`
 * is *not* derived-shaped: `String(length)` never emits a leading zero, so no
 * derivation can produce it and it cannot collide.
 */
export function isDerivedScanCursorKey(key: string): boolean {
  const colon = key.indexOf(":");
  if (colon <= 0) return false;
  const lengthPart = key.slice(0, colon);
  if (!/^(0|[1-9][0-9]*)$/.test(lengthPart)) return false;
  const length = Number(lengthPart);
  const identity = key.slice(colon + 1, colon + 1 + length);
  if (identity.length !== length) return false;
  const suffix = key.slice(colon + 1 + length);
  return suffix === ":fwd" || suffix === ":bulk";
}

/**
 * All three persisted keys for a dispatch identity, in role order. Convenience
 * for callers (admin tooling, tests) that need to inspect or reason about the
 * whole cursor triple rather than one role.
 */
export function scanCursorKeysFor(identityKey: string): Record<OutboxScanCursorRole, string> {
  return {
    floor: deriveScanCursorKey(identityKey, "floor"),
    fwd: deriveScanCursorKey(identityKey, "fwd"),
    bulk: deriveScanCursorKey(identityKey, "bulk"),
  };
}

/**
 * The persisted `after_id` of each cursor role for one identity, as read from
 * `outbox_scan_cursor`. `undefined` means the row does not exist — which is not
 * the same as `0`, and the difference matters to {@link planScanCursorRewind}:
 * an absent cursor is never created by a rewind (issue #820).
 */
export type OutboxScanCursorAfterIds = Partial<Record<OutboxScanCursorRole, number | undefined>>;

/**
 * What an `admin outbox retry` of row `rowId` must do to the persisted cursors
 * of one identity (issue #820).
 */
export interface OutboxScanCursorRewindPlan {
  /** Whether any existing cursor sits at or past `rowId` and must be rewound. */
  required: boolean;
  /** The `after_id` every affected cursor is set to: `rowId - 1`. */
  targetAfterId: number;
  /** The affected roles, in {@link OUTBOX_SCAN_CURSOR_ROLES} order. */
  roles: OutboxScanCursorRole[];
}

/**
 * Decide which of an identity's cursors a retry of `rowId` must rewind.
 *
 * A cursor means "every row up to `after_id` is foreign or resolved", and the
 * dispatcher only ever looks at `id > after_id`. Reviving an older row without
 * touching the cursors therefore leaves it **stranded**: it is pending again,
 * but permanently below the window every future scan for that identity looks
 * at. So each cursor already sitting at or past the revived row is pulled back
 * to `rowId - 1`, the largest value that keeps the row visible.
 *
 * Two rules make this safe rather than merely convenient:
 *
 * - **`>=`, not `>`.** A cursor exactly equal to `rowId` excludes the row (the
 *   scan predicate is strict), so it needs the rewind just as much as one past
 *   it.
 * - **Absent stays absent.** A role with no persisted row already reads as
 *   "no confirmed progress", which is the conservative direction — the next run
 *   scans from row 1 and sees the revived row anyway. Creating a row for it
 *   would invent progress that no run ever confirmed.
 *
 * Rewinding never violates I4 (`docs/outbox-scan-cursor-contract.md` §9): the
 * span between the new and old positions was scanned before and is re-scanned,
 * which costs a bounded amount of work and can only *find* rows, never skip
 * them.
 *
 * Pure and total, so the CLI preview and the store's `UPDATE ... WHERE after_id
 * >= ?` predicate are two readings of one rule rather than two rules.
 */
export function planScanCursorRewind(
  cursors: OutboxScanCursorAfterIds,
  rowId: number,
): OutboxScanCursorRewindPlan {
  const roles = OUTBOX_SCAN_CURSOR_ROLES.filter((role) => {
    const afterId = cursors[role];
    return afterId !== undefined && afterId >= rowId;
  });
  return { required: roles.length > 0, targetAfterId: rowId - 1, roles };
}

/**
 * A fence token pinning the rewind generation a dispatch run observed for one
 * dispatch identity (issue #820 review follow-up).
 *
 * The retry transaction alone is *not* sufficient to keep a recovered row
 * discoverable. A dispatch run reads its three cursors at scan start, then
 * spends an unbounded amount of wall-clock in external calls before persisting
 * the extent it computed from that read. An `admin outbox retry` committing in
 * that window is invisible to the run: its final, unconditional cursor writes
 * carry a scan extent computed while the retried row was still dead-lettered
 * (so `listPendingEntries` never returned it and the scan skipped straight over
 * it), and they land *after* the rewind — restoring exactly the cursor state
 * the rewind removed and re-stranding the row below `id > after_id`, this time
 * with no operation left to undo it.
 *
 * So cursor persistence is fenced on this token rather than merely ordered
 * against the rewind. Every retry that supplies a cursor identity bumps the
 * identity's fence, whether or not any cursor row actually moved; a dispatch
 * run reads the fence *before* it reads the cursors and passes it back with
 * each write, which the store commits only while the token still matches. The
 * two possible interleavings are then both safe:
 *
 * - retry commits **before** the run's fence read — the run reads the bumped
 *   fence and the rewound cursors, scans the revived row like any other pending
 *   row, and its writes commit normally;
 * - retry commits **after** it — the run's writes are refused, so the rewind
 *   stands and the next run resumes from it.
 *
 * The fence covers the case a value-level compare-and-swap on `after_id` would
 * miss: a cursor sitting *below* the retried row is not rewound at all (nothing
 * to rewind), yet an in-flight run that scanned past that row while it was
 * dead-lettered would still advance the cursor beyond it. Bumping on every
 * retry, not only on a rewind that moved a row, is what closes that case.
 *
 * The cost of a refusal is bounded and one-off: one run's scan progress is
 * discarded, and the next run re-scans a span it already classified once.
 */
export interface OutboxScanCursorFence {
  /**
   * The dispatch identity (the `floor` key — see {@link deriveScanCursorKey}),
   * not a per-role key: a retry rewinds all three roles together, so one token
   * per identity fences all three writes.
   */
  identityKey: string;
  /**
   * The generation observed at scan start. `0` means "no retry has ever
   * rewound this identity", which is the value an absent fence row reads as —
   * absent and zero are deliberately the same here, unlike a cursor's absent
   * vs. `0` distinction, because a fence has no "no confirmed progress" state
   * to preserve.
   */
  epoch: number;
}
