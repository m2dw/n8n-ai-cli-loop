/**
 * SQLite-backed dependency-chain registry (issue #788).
 *
 * Durable half of `core/chain-registry.ts`: stable chain IDs, membership, DAG
 * edges, revision records, aliases, and synchronization metadata, in the same
 * database file the task/outbox/session-control tables live in.
 *
 * Two properties this file is responsible for, beyond plain persistence:
 *
 *   - *Atomicity.* Every mutating method runs inside one `BEGIN IMMEDIATE`
 *     transaction, so a rejected graph, a lost compare-and-set, or a failure
 *     part-way through a multi-table write leaves the registry exactly as it
 *     was. A chain row never outlives the members written with it.
 *   - *Referential integrity.* `PRAGMA foreign_keys` is enabled on this
 *     connection, which turns the composite foreign keys in
 *     `chain-registry-migration.ts` into enforced constraints: an edge cannot
 *     name an Issue that is not a member of its own chain. Deleting a chain
 *     removes everything attached to it, but `deleteChain` spells those
 *     deletes out instead of leaning on the cascade, because a database
 *     migrated from an earlier build may carry the child tables without it.
 *     The pure checks in
 *     `checkChainGraphIntegrity` run first so callers get a full, typed list
 *     of what is wrong instead of one opaque SQLite error, but the database
 *     remains the backstop.
 *
 * It also persists the frozen-prefix snapshots of #891 — the durable half of
 * `core/chain-frozen-prefix.ts` — on the same terms: what a task's dependency
 * contract was pinned to is a row, whether a candidate graph contradicts one is
 * not. The atomic freeze-with-transition port lives on `SqliteTaskStore`
 * instead, because that half has to commit alongside a task-state transition
 * and only that connection can do so in one transaction.
 *
 * Graph *policy* — cycle detection, accepted-revision semantics (#890), and
 * the frozen-prefix mutation guards (#891) — is deliberately absent. This store persists
 * what it is told and refuses only what it could never represent, plus the one
 * thing a caller cannot enforce for itself: the exclusive member claim of
 * `PutChainGraphInput.exclusiveMemberScope`, which is only meaningful when the
 * check and the write share a transaction. Deciding to ask for it stays the
 * caller's; deciding whether it holds cannot be.
 */

import Database from "better-sqlite3";
import { homedir, hostname } from "os";
import { mkdirSync } from "fs";
import { join } from "path";
import {
  allocateChainId,
  chainGraphFingerprint,
  checkChainGraphIntegrity,
  isChainMemberRole,
  isChainRevisionState,
  isChainSyncStatus,
  isValidChainAlias,
  isValidChainId,
  isValidIssueNumber,
  type AcceptedRevisionGuard,
  type ChainAlias,
  type ChainAliasInput,
  type ChainEdge,
  type ChainEdgeInput,
  type ChainGraph,
  type ChainListFilter,
  type ChainMember,
  type ChainMemberInput,
  type ChainMemberOwner,
  type ChainMetadataPatch,
  type ChainRecord,
  type ChainRegistryFailure,
  type ChainRegistryFailureCode,
  type ChainRegistryResult,
  type ChainRegistryStore,
  type ChainRevisionInput,
  type ChainRevisionRecord,
  type ChainRevisionState,
  type ChainRetirement,
  type ChainRevisionStateResult,
  type ChainSyncStatePatch,
  type CreateChainInput,
  type PutChainGraphInput,
  type RetireChainInput,
} from "../core/chain-registry.js";
import type {
  ChainFrozenPrefixStore,
  FrozenPrefixKey,
  FrozenPrefixListFilter,
  FrozenPrefixSnapshot,
} from "../core/chain-frozen-prefix.js";
import { frozenPrefixFingerprint, validateFrozenPrefixSnapshot } from "../core/chain-frozen-prefix.js";
import { isChainSyncRefusalKind } from "../core/chain-sync.js";
import { chainEditLockIsTakeable } from "../core/chain-edit-lock.js";
import type {
  AcquireChainEditLocksInput,
  ChainEditLockAcquisition,
  ChainEditLockOwnerLiveness,
  ChainEditLockRenewal,
  ChainEditLockStore,
  RenewChainEditLocksInput,
} from "../core/chain-edit-lock.js";
import type {
  ChainIntakeErrorKey,
  ChainIntakeErrorRecord,
  ChainIntakeErrorStore,
} from "../core/chain-intake.js";
import { migrateChainRegistrySchema } from "./chain-registry-migration.js";
import {
  INSERT_FROZEN_PREFIX,
  SELECT_FROZEN_PREFIX,
  frozenPrefixInsertValues,
  rowToFrozenPrefix,
  type FrozenPrefixRow,
} from "./frozen-prefix-rows.js";
import { sqliteBackendId } from "./sqlite-backend-id.js";

export const DEFAULT_CHAIN_REGISTRY_DB_PATH = join(
  homedir(),
  ".config",
  "n8n-ai-cli-loop",
  "dev_loop.db",
);

/**
 * How many Issue numbers one exclusive-ownership lookup binds at a time.
 *
 * SQLite refuses any statement carrying more than `SQLITE_MAX_VARIABLE_NUMBER`
 * bound parameters — 32,766 on the bundled build, 999 on anything older than
 * 3.32 — and an `IN (...)` list built from a chain's members is the one place
 * here whose parameter count grows with the data. A chain big enough to cross
 * the limit is still a legitimate graph, so the read is batched well below the
 * smaller of the two limits instead of being allowed to throw.
 */
const MEMBER_OWNER_QUERY_CHUNK = 500;

interface ChainRow {
  chain_id: string;
  session_id: string;
  origin_issue_number: number;
  head_issue_number: number;
  title: string | null;
  graph_revision: number;
  graph_fingerprint: string;
  accepted_revision: number | null;
  sync_status: string;
  sync_error: string | null;
  sync_checked_at: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
  rev: number;
}

interface MemberRow {
  chain_id: string;
  issue_number: number;
  role: string;
  added_at: string;
}

interface EdgeRow {
  chain_id: string;
  blocker_issue_number: number;
  blocked_issue_number: number;
  created_at: string;
}

interface RevisionRow {
  chain_id: string;
  revision: number;
  fingerprint: string;
  state: string;
  source: string | null;
  note: string | null;
  created_at: string;
}

interface AliasRow {
  alias: string;
  chain_id: string;
  reason: string | null;
  created_at: string;
}

interface EditLockRow {
  scope: string;
  owner_id: string;
  operation_id: string;
  acquired_at: string;
  /** Null for a row written before pids were recorded, or by a caller with no pid to give. */
  owner_pid: number | null;
  owner_host: string | null;
}

/**
 * Whether the process that took a lock still answers (issue #791 review).
 *
 * Only ever consulted for a claim already past its staleness window, and only
 * ever to REFUSE a takeover — so every uncertainty resolves to `unknown`, which
 * leaves the age-only rule in charge rather than inventing an answer:
 *
 *   - no pid, or a pid recorded by a build that did not know about hosts;
 *   - a pid belonging to another machine, where the local process table says
 *     nothing about it (a database file on a shared volume);
 *   - a signal probe that fails for a reason other than "no such process" —
 *     `EPERM` means a process is there and is somebody else's, which is a live
 *     owner as far as this is concerned.
 */
function editLockOwnerLiveness(row: EditLockRow): ChainEditLockOwnerLiveness {
  const pid = row.owner_pid;
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return "unknown";
  if (row.owner_host === null || row.owner_host !== hostname()) return "unknown";
  if (pid === process.pid) return "alive";
  try {
    // Signal 0 checks for the process without touching it.
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "alive";
  }
}

/** One `(member, owning chain)` pair from an exclusive-ownership lookup. */
interface MemberOwnerRow {
  issue_number: number;
  chain_id: string;
}

function rowToChain(row: ChainRow): ChainRecord {
  const record: ChainRecord = {
    chainId: row.chain_id,
    sessionId: row.session_id,
    originIssueNumber: row.origin_issue_number,
    headIssueNumber: row.head_issue_number,
    graphRevision: row.graph_revision,
    graphFingerprint: row.graph_fingerprint,
    // A status written by an older build, or hand-edited, is surfaced as
    // `unknown` rather than as an off-enum string: every consumer switches on
    // this, and "we do not know" is the honest, safe reading.
    syncStatus: isChainSyncStatus(row.sync_status) ? row.sync_status : "unknown",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rev: row.rev,
  };
  if (row.title !== null) record.title = row.title;
  if (row.accepted_revision !== null) record.acceptedRevision = row.accepted_revision;
  if (row.sync_error !== null) record.syncError = row.sync_error;
  if (row.sync_checked_at !== null) record.syncCheckedAt = row.sync_checked_at;
  if (row.synced_at !== null) record.syncedAt = row.synced_at;
  return record;
}

function rowToMember(row: MemberRow): ChainMember {
  return {
    chainId: row.chain_id,
    issueNumber: row.issue_number,
    role: isChainMemberRole(row.role) ? row.role : "node",
    addedAt: row.added_at,
  };
}

function rowToEdge(row: EdgeRow): ChainEdge {
  return {
    chainId: row.chain_id,
    blockerIssueNumber: row.blocker_issue_number,
    blockedIssueNumber: row.blocked_issue_number,
    createdAt: row.created_at,
  };
}

function rowToRevision(row: RevisionRow): ChainRevisionRecord {
  const record: ChainRevisionRecord = {
    chainId: row.chain_id,
    revision: row.revision,
    fingerprint: row.fingerprint,
    state: isChainRevisionState(row.state) ? row.state : "candidate",
    createdAt: row.created_at,
  };
  if (row.source !== null) record.source = row.source;
  if (row.note !== null) record.note = row.note;
  return record;
}

function rowToAlias(row: AliasRow): ChainAlias {
  const alias: ChainAlias = {
    alias: row.alias,
    chainId: row.chain_id,
    createdAt: row.created_at,
  };
  if (row.reason !== null) alias.reason = row.reason;
  return alias;
}

// Typed as the shared refusal arm rather than a `ChainRegistryResult<T>`, so it
// also satisfies a method whose success arm carries more than a single value.
function fail(code: ChainRegistryFailureCode, detail?: string): ChainRegistryFailure {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail };
}

export class SqliteChainRegistryStore
  implements ChainRegistryStore, ChainFrozenPrefixStore, ChainIntakeErrorStore, ChainEditLockStore
{
  readonly #db: Database.Database;
  readonly backendId: string | undefined;

  constructor(dbPath?: string) {
    const resolved = dbPath ?? DEFAULT_CHAIN_REGISTRY_DB_PATH;
    mkdirSync(join(resolved, ".."), { recursive: true });
    this.#db = new Database(resolved);
    // Pragmas must run outside a transaction — `foreign_keys` in particular is
    // silently ignored inside one, which would leave the composite foreign
    // keys in the schema decorative instead of enforced.
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA busy_timeout = 5000;");
    this.#db.exec("PRAGMA foreign_keys = ON;");
    migrateChainRegistrySchema(this.#db);
    this.backendId = sqliteBackendId(resolved);
  }

  close(): void {
    this.#db.close();
  }

  /* ---------------------------------------------------------------------
   * Internal helpers (synchronous; all callers already hold a transaction
   * or are read-only)
   * ------------------------------------------------------------------ */

  #readChain(chainId: string): ChainRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM dependency_chain WHERE chain_id = ?")
      .get(chainId) as ChainRow | undefined;
    return row ? rowToChain(row) : undefined;
  }

  #readMembers(chainId: string): ChainMember[] {
    const rows = this.#db
      .prepare("SELECT * FROM dependency_chain_member WHERE chain_id = ? ORDER BY issue_number")
      .all(chainId) as MemberRow[];
    return rows.map(rowToMember);
  }

  #readEdges(chainId: string): ChainEdge[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM dependency_chain_edge WHERE chain_id = ?
         ORDER BY blocker_issue_number, blocked_issue_number`,
      )
      .all(chainId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  #readGraph(chainId: string): ChainGraph | undefined {
    const chain = this.#readChain(chainId);
    if (!chain) return undefined;
    return { chain, members: this.#readMembers(chainId), edges: this.#readEdges(chainId) };
  }

  /**
   * True when a handle is unavailable for a new chain ID. Chain IDs and
   * aliases share one namespace, so both tables are consulted: allocating an
   * ID an alias already claims would make an operator handle ambiguous.
   */
  #handleTaken(handle: string): boolean {
    const chain = this.#db
      .prepare("SELECT 1 FROM dependency_chain WHERE chain_id = ?")
      .get(handle);
    if (chain) return true;
    return Boolean(this.#db.prepare("SELECT 1 FROM dependency_chain_alias WHERE alias = ?").get(handle));
  }

  /**
   * Which chains other than `chainId` already contain any of `issueNumbers`,
   * narrowed to `scope`.
   *
   * Only ever called from inside the write transaction that is about to claim
   * those Issues. That placement is the whole point: `BEGIN IMMEDIATE` holds
   * the writer lock, so a second claimant either reads this after the first
   * has committed its members or waits for it — it cannot read the same
   * "unowned" answer and write on top of it.
   *
   * Asked in fixed-size batches rather than one statement per call: a graph
   * with more members than {@link MEMBER_OWNER_QUERY_CHUNK} would otherwise
   * bind more parameters than SQLite accepts and throw `too many SQL
   * variables`, turning a perfectly valid large chain into an error instead of
   * an acceptance result. Splitting the read changes nothing about the claim —
   * every batch is read under the same transaction and the same writer lock.
   */
  #foreignMemberOwners(
    chainId: string,
    issueNumbers: readonly number[],
    scope: ChainListFilter,
  ): ChainMemberOwner[] {
    if (issueNumbers.length === 0) return [];

    const scopeClauses: string[] = [];
    const scopeParams: unknown[] = [];
    if (scope.sessionId !== undefined) {
      scopeClauses.push("c.session_id = ?");
      scopeParams.push(scope.sessionId);
    }
    if (scope.syncStatus !== undefined) {
      scopeClauses.push("c.sync_status = ?");
      scopeParams.push(scope.syncStatus);
    }

    const owners: ChainMemberOwner[] = [];
    for (let start = 0; start < issueNumbers.length; start += MEMBER_OWNER_QUERY_CHUNK) {
      const batch = issueNumbers.slice(start, start + MEMBER_OWNER_QUERY_CHUNK);
      const clauses = [
        `m.issue_number IN (${batch.map(() => "?").join(", ")})`,
        "m.chain_id <> ?",
        ...scopeClauses,
      ];
      const rows = this.#db
        .prepare(
          `SELECT m.issue_number AS issue_number, c.chain_id AS chain_id
             FROM dependency_chain_member m
             JOIN dependency_chain c ON c.chain_id = m.chain_id
            WHERE ${clauses.join(" AND ")}`,
        )
        .all(...batch, chainId, ...scopeParams) as MemberOwnerRow[];
      for (const row of rows) {
        owners.push({ issueNumber: row.issue_number, chainId: row.chain_id });
      }
    }

    // Ordered here rather than per statement: the caller is promised one stable
    // order over the whole result, and a batch's own `ORDER BY` only orders
    // that batch.
    return owners.sort(
      (a, b) =>
        a.issueNumber - b.issueNumber ||
        (a.chainId < b.chainId ? -1 : a.chainId > b.chainId ? 1 : 0),
    );
  }

  /** Bump the chain's row revision and `updated_at` in the current transaction. */
  #touchChain(chainId: string, now: string): void {
    this.#db
      .prepare("UPDATE dependency_chain SET updated_at = ?, rev = rev + 1 WHERE chain_id = ?")
      .run(now, chainId);
  }

  #writeGraphRows(
    chainId: string,
    members: readonly ChainMemberInput[],
    edges: readonly ChainEdgeInput[],
    now: string,
  ): void {
    // Edges before members: an edge's composite foreign key points at a
    // member row, so members must be gone last and back first.
    this.#db.prepare("DELETE FROM dependency_chain_edge WHERE chain_id = ?").run(chainId);
    this.#db.prepare("DELETE FROM dependency_chain_member WHERE chain_id = ?").run(chainId);

    const insertMember = this.#db.prepare(
      `INSERT INTO dependency_chain_member (chain_id, issue_number, role, added_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const member of members) {
      insertMember.run(chainId, member.issueNumber, member.role ?? "node", now);
    }

    const insertEdge = this.#db.prepare(
      `INSERT INTO dependency_chain_edge
         (chain_id, blocker_issue_number, blocked_issue_number, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const edge of edges) {
      insertEdge.run(chainId, edge.blockerIssueNumber, edge.blockedIssueNumber, now);
    }
  }

  /**
   * Insert a revision record, tolerating one already present at the same
   * `(chain, revision)`. `DO NOTHING` rather than an upsert: a recorded
   * revision is history, and history a later write could silently rewrite
   * would not be worth referencing. Callers that need to distinguish "already
   * there" from "just written" read the row back themselves.
   */
  #insertRevision(input: {
    chainId: string;
    revision: number;
    fingerprint: string;
    state: ChainRevisionState;
    source?: string | undefined;
    note?: string | undefined;
    now: string;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO dependency_chain_revision
           (chain_id, revision, fingerprint, state, source, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chain_id, revision) DO NOTHING`,
      )
      .run(
        input.chainId,
        input.revision,
        input.fingerprint,
        input.state,
        input.source ?? null,
        input.note ?? null,
        input.now,
      );
  }

  /* ---------------------------------------------------------------------
   * Reads
   * ------------------------------------------------------------------ */

  async getChain(chainId: string): Promise<ChainGraph | undefined> {
    return this.#readGraph(chainId);
  }

  async getChainRecord(chainId: string): Promise<ChainRecord | undefined> {
    return this.#readChain(chainId);
  }

  async resolveChainHandle(handle: string): Promise<string | undefined> {
    if (typeof handle !== "string" || handle.length === 0) return undefined;
    const chain = this.#db
      .prepare("SELECT chain_id FROM dependency_chain WHERE chain_id = ?")
      .get(handle) as { chain_id: string } | undefined;
    if (chain) return chain.chain_id;
    const alias = this.#db
      .prepare("SELECT chain_id FROM dependency_chain_alias WHERE alias = ?")
      .get(handle) as { chain_id: string } | undefined;
    return alias?.chain_id;
  }

  async listChains(filter?: ChainListFilter): Promise<ChainRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.sessionId !== undefined) {
      clauses.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter?.syncStatus !== undefined) {
      clauses.push("sync_status = ?");
      params.push(filter.syncStatus);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(`SELECT * FROM dependency_chain${where} ORDER BY chain_id`)
      .all(...params) as ChainRow[];
    return rows.map(rowToChain);
  }

  async listChainsForIssue(
    issueNumber: number,
    filter?: ChainListFilter,
  ): Promise<ChainRecord[]> {
    const clauses: string[] = ["m.issue_number = ?"];
    const params: unknown[] = [issueNumber];
    if (filter?.sessionId !== undefined) {
      clauses.push("c.session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter?.syncStatus !== undefined) {
      clauses.push("c.sync_status = ?");
      params.push(filter.syncStatus);
    }
    const rows = this.#db
      .prepare(
        `SELECT c.* FROM dependency_chain c
           JOIN dependency_chain_member m ON m.chain_id = c.chain_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY c.chain_id`,
      )
      .all(...params) as ChainRow[];
    return rows.map(rowToChain);
  }

  async getChainRevision(
    chainId: string,
    revision: number,
  ): Promise<ChainRevisionRecord | undefined> {
    const row = this.#db
      .prepare("SELECT * FROM dependency_chain_revision WHERE chain_id = ? AND revision = ?")
      .get(chainId, revision) as RevisionRow | undefined;
    return row ? rowToRevision(row) : undefined;
  }

  async listChainRevisions(chainId: string): Promise<ChainRevisionRecord[]> {
    const rows = this.#db
      .prepare("SELECT * FROM dependency_chain_revision WHERE chain_id = ? ORDER BY revision")
      .all(chainId) as RevisionRow[];
    return rows.map(rowToRevision);
  }

  async listChainAliases(chainId?: string): Promise<ChainAlias[]> {
    const rows = (
      chainId === undefined
        ? this.#db.prepare("SELECT * FROM dependency_chain_alias ORDER BY alias").all()
        : this.#db
            .prepare("SELECT * FROM dependency_chain_alias WHERE chain_id = ? ORDER BY alias")
            .all(chainId)
    ) as AliasRow[];
    return rows.map(rowToAlias);
  }

  /* ---------------------------------------------------------------------
   * Writes
   * ------------------------------------------------------------------ */

  async createChain(input: CreateChainInput): Promise<ChainRegistryResult<ChainGraph>> {
    if (typeof input.sessionId !== "string" || input.sessionId.length === 0) {
      return fail("invalid_input", "sessionId is required");
    }
    if (!isValidIssueNumber(input.headIssueNumber)) {
      return fail("invalid_input", `headIssueNumber must be a positive integer, got ${String(input.headIssueNumber)}`);
    }
    if (input.chainId !== undefined && !isValidChainId(input.chainId)) {
      return fail("invalid_input", `malformed chain id: ${String(input.chainId)}`);
    }
    if (input.alias !== undefined && !isValidChainAlias(input.alias)) {
      return fail("invalid_input", `malformed alias: ${String(input.alias)}`);
    }

    const now = input.now ?? new Date().toISOString();
    const members: ChainMemberInput[] =
      input.members === undefined
        ? [{ issueNumber: input.headIssueNumber, role: "head" }]
        : input.members.map((m) => ({ ...m }));
    const edges: ChainEdgeInput[] = (input.edges ?? []).map((e) => ({ ...e }));

    const errors = checkChainGraphIntegrity({
      headIssueNumber: input.headIssueNumber,
      members,
      edges,
    });
    if (errors.length > 0) return { ok: false, code: "invalid_graph", errors };

    const fingerprint = chainGraphFingerprint({ members, edges });

    const run = this.#db.transaction((): ChainRegistryResult<ChainGraph> => {
      // The alias is claimed before the ID is allocated, in this same
      // transaction, so a name and the ID namespace it belongs to are taken
      // together or not at all (issue #791 review). Checked first because a
      // creation that cannot carry its name must create nothing: a caller whose
      // name was taken while it was working retries with a free registry
      // instead of owning a chain the name can never reach.
      if (input.alias !== undefined && this.#handleTaken(input.alias)) {
        return fail("alias_taken", `alias ${input.alias} is already a chain id or alias`);
      }

      let chainId: string;
      if (input.chainId !== undefined) {
        if (this.#handleTaken(input.chainId)) {
          return fail("already_exists", `chain id already in use: ${input.chainId}`);
        }
        // An alias equal to the ID it is being registered against would make
        // that handle ambiguous and leave the alias row unreachable through
        // `resolveChainHandle`, exactly as `putChainAlias` refuses. The
        // allocating branch below walks past it instead; a caller who named
        // both is told, rather than quietly given one of them.
        if (input.alias === input.chainId) {
          return fail("alias_taken", `alias ${input.alias} is the id of the chain being created`);
        }
        chainId = input.chainId;
      } else {
        // Allocation reads and writes inside this same transaction, so two
        // concurrent creations for the same head Issue cannot both observe
        // `chain_777` as free: the second blocks on the write lock and then
        // walks on to `chain_777_2`. The pending alias counts as taken for the
        // same reason a registered one does — an ID that shadows this chain's
        // own name would make that handle ambiguous.
        const allocated = allocateChainId(
          input.headIssueNumber,
          (candidate) => candidate === input.alias || this.#handleTaken(candidate),
        );
        if (allocated === undefined) {
          return fail("id_exhausted", `no free chain id for head issue ${input.headIssueNumber}`);
        }
        chainId = allocated;
      }

      this.#db
        .prepare(
          `INSERT INTO dependency_chain
             (chain_id, session_id, origin_issue_number, head_issue_number, title,
              graph_revision, graph_fingerprint, accepted_revision,
              sync_status, sync_error, sync_checked_at, synced_at,
              created_at, updated_at, rev)
           VALUES (?, ?, ?, ?, ?, 1, ?, NULL, 'unknown', NULL, NULL, NULL, ?, ?, 1)`,
        )
        .run(
          chainId,
          input.sessionId,
          input.headIssueNumber,
          input.headIssueNumber,
          input.title ?? null,
          fingerprint,
          now,
          now,
        );

      if (input.alias !== undefined) {
        this.#db
          .prepare(
            "INSERT INTO dependency_chain_alias (alias, chain_id, reason, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(input.alias, chainId, input.source ?? null, now);
      }

      this.#writeGraphRows(chainId, members, edges, now);
      this.#insertRevision({
        chainId,
        revision: 1,
        fingerprint,
        state: "candidate",
        source: input.source,
        now,
      });

      return { ok: true, value: this.#readGraph(chainId)! };
    });

    return run.immediate();
  }

  async putChainGraph(input: PutChainGraphInput): Promise<ChainRegistryResult<ChainGraph>> {
    const members: ChainMemberInput[] = (input.members ?? []).map((m) => ({ ...m }));
    const edges: ChainEdgeInput[] = (input.edges ?? []).map((e) => ({ ...e }));
    const now = input.now ?? new Date().toISOString();

    const run = this.#db.transaction((): ChainRegistryResult<ChainGraph> => {
      const current = this.#readChain(input.chainId);
      if (!current) return fail("not_found", `no such chain: ${input.chainId}`);
      if (input.expectedRev !== undefined && input.expectedRev !== current.rev) {
        return fail("conflict", `expected rev ${input.expectedRev}, found ${current.rev}`);
      }

      const headIssueNumber = input.headIssueNumber ?? current.headIssueNumber;
      const errors = checkChainGraphIntegrity({ headIssueNumber, members, edges });
      if (errors.length > 0) return { ok: false, code: "invalid_graph", errors };

      // Decided before the no-op return below, because a claim is a statement
      // about who *else* holds these members, not about whether this write
      // changes them. A graph already on record is not a claim already held:
      // #890 accepts an unaccepted candidate by re-writing it, and letting that
      // re-write through as a no-op would label and point at a revision whose
      // members another chain has taken in the meantime. The check reads only,
      // so a claim that is going to be refused still moves no row first.
      if (input.exclusiveMemberScope !== undefined) {
        // A tolerated chain is one the caller's own operation is about to
        // dissolve (a merge's source, #893): its claim on the members is
        // expected, and only a THIRD chain's refuses the write.
        const tolerated = new Set(input.tolerateOwnerChainIds ?? []);
        const owners = this.#foreignMemberOwners(
          input.chainId,
          [...new Set(members.map((member) => member.issueNumber))],
          input.exclusiveMemberScope,
        ).filter((owner) => !tolerated.has(owner.chainId));
        if (owners.length > 0) {
          const first = owners[0]!;
          const rest = owners.length - 1;
          const detail =
            `issue ${first.issueNumber} already belongs to chain ${first.chainId}` +
            (rest === 0 ? "" : ` (and ${rest} further claim${rest === 1 ? "" : "s"})`);
          return { ok: false, code: "conflict", detail, owners };
        }
      }

      const fingerprint = chainGraphFingerprint({ members, edges });
      if (fingerprint === current.graphFingerprint && headIssueNumber === current.headIssueNumber) {
        // Idempotent re-write: the persisted structure and head already match,
        // so advancing the revision would manufacture history for a change
        // that did not happen. The claim above still had to hold.
        return { ok: true, value: this.#readGraph(input.chainId)! };
      }

      // One past the highest revision number *recorded*, not merely one past
      // the chain's current graph revision: `putChainRevision` can record a
      // revision ahead of the persisted graph, and reusing that number would
      // either be silently dropped or overwrite a record other rows already
      // reference.
      const highestRecorded = (
        this.#db
          .prepare("SELECT MAX(revision) AS max_revision FROM dependency_chain_revision WHERE chain_id = ?")
          .get(input.chainId) as { max_revision: number | null }
      ).max_revision;
      const revision = Math.max(current.graphRevision, highestRecorded ?? 0) + 1;
      this.#writeGraphRows(input.chainId, members, edges, now);
      this.#db
        .prepare(
          `UPDATE dependency_chain
             SET head_issue_number = ?, graph_revision = ?, graph_fingerprint = ?,
                 updated_at = ?, rev = rev + 1
           WHERE chain_id = ?`,
        )
        .run(headIssueNumber, revision, fingerprint, now, input.chainId);
      this.#insertRevision({
        chainId: input.chainId,
        revision,
        fingerprint,
        state: "candidate",
        source: input.source,
        note: input.note,
        now,
      });

      return { ok: true, value: this.#readGraph(input.chainId)! };
    });

    return run.immediate();
  }

  async updateChainMetadata(
    chainId: string,
    patch: ChainMetadataPatch,
  ): Promise<ChainRegistryResult<ChainRecord>> {
    if (patch.alias !== undefined && !isValidChainAlias(patch.alias)) {
      return fail("invalid_input", `malformed alias: ${String(patch.alias)}`);
    }
    const now = patch.now ?? new Date().toISOString();

    const run = this.#db.transaction((): ChainRegistryResult<ChainRecord> => {
      const current = this.#readChain(chainId);
      if (!current) return fail("not_found", `no such chain: ${chainId}`);
      if (patch.expectedRev !== undefined && patch.expectedRev !== current.rev) {
        return fail("conflict", `expected rev ${patch.expectedRev}, found ${current.rev}`);
      }

      // The alias is claimed here rather than through `putChainAlias` so a
      // caller that names a chain and then compare-and-sets on the revision
      // this write returns has both under the one `expectedRev` above: a
      // separate alias call would bump the row on its own, and the number this
      // caller carried forward would silently include whatever a concurrent
      // writer did in between (issue #791 review). The rules are the ones
      // `putChainAlias` applies, in the same order and for the same reasons.
      let claimAlias: string | undefined;
      const alias = patch.alias;
      if (alias !== undefined) {
        if (this.#db.prepare("SELECT 1 FROM dependency_chain WHERE chain_id = ?").get(alias)) {
          return fail("alias_taken", `alias ${alias} is already a chain id`);
        }
        const existing = this.#db
          .prepare("SELECT * FROM dependency_chain_alias WHERE alias = ?")
          .get(alias) as AliasRow | undefined;
        if (existing !== undefined && existing.chain_id !== chainId) {
          return fail("alias_taken", `alias ${alias} already points at ${existing.chain_id}`);
        }
        // Already this chain's: a no-op, exactly as re-registering it through
        // `putChainAlias` is.
        if (existing === undefined) claimAlias = alias;
      }

      let headIssueNumber = current.headIssueNumber;
      if (patch.headIssueNumber !== undefined) {
        if (!isValidIssueNumber(patch.headIssueNumber)) {
          return fail("invalid_input", `headIssueNumber must be a positive integer`);
        }
        // The head is an operator entry point into the chain, so it has to
        // name a member. The chain ID is deliberately NOT re-derived here:
        // stable handles are the point of the registry.
        const member = this.#db
          .prepare("SELECT 1 FROM dependency_chain_member WHERE chain_id = ? AND issue_number = ?")
          .get(chainId, patch.headIssueNumber);
        if (!member) {
          return {
            ok: false,
            code: "invalid_graph",
            errors: [{ code: "head_not_member", issueNumber: patch.headIssueNumber }],
          };
        }
        headIssueNumber = patch.headIssueNumber;
      }

      if (claimAlias !== undefined) {
        this.#db
          .prepare(
            "INSERT INTO dependency_chain_alias (alias, chain_id, reason, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(claimAlias, chainId, null, now);
      }

      const title = patch.title === undefined ? (current.title ?? null) : patch.title;
      // One bump for the whole patch, alias included: `#touchChain` is not
      // called for the alias row because this UPDATE is already the row's
      // single revision advance.
      this.#db
        .prepare(
          `UPDATE dependency_chain
             SET head_issue_number = ?, title = ?, updated_at = ?, rev = rev + 1
           WHERE chain_id = ?`,
        )
        .run(headIssueNumber, title, now, chainId);

      return { ok: true, value: this.#readChain(chainId)! };
    });

    return run.immediate();
  }

  async setChainSyncState(
    chainId: string,
    patch: ChainSyncStatePatch,
  ): Promise<ChainRegistryResult<ChainRecord>> {
    if (!isChainSyncStatus(patch.status)) {
      return fail("invalid_input", `unknown sync status: ${String(patch.status)}`);
    }
    const now = patch.now ?? new Date().toISOString();
    const checkedAt = patch.checkedAt ?? now;

    const run = this.#db.transaction((): ChainRegistryResult<ChainRecord> => {
      const current = this.#readChain(chainId);
      if (!current) return fail("not_found", `no such chain: ${chainId}`);
      if (patch.expectedRev !== undefined && patch.expectedRev !== current.rev) {
        return fail("conflict", `expected rev ${patch.expectedRev}, found ${current.rev}`);
      }

      // `syncError` describes the *last failed* attempt, so a later non-error
      // result must not keep reporting it. Omitting `error` therefore carries
      // the recorded detail forward only while the status stays `error`.
      const error =
        patch.error !== undefined
          ? patch.error
          : patch.status === "error"
            ? (current.syncError ?? null)
            : null;
      // A failed or stale check must not advance "last known good": only an
      // explicit `syncedAt`, or an `in_sync` result, moves it.
      const syncedAt =
        patch.syncedAt !== undefined
          ? patch.syncedAt
          : patch.status === "in_sync"
            ? checkedAt
            : (current.syncedAt ?? null);

      this.#db
        .prepare(
          `UPDATE dependency_chain
             SET sync_status = ?, sync_error = ?, sync_checked_at = ?, synced_at = ?,
                 updated_at = ?, rev = rev + 1
           WHERE chain_id = ?`,
        )
        .run(patch.status, error, checkedAt, syncedAt, now, chainId);

      return { ok: true, value: this.#readChain(chainId)! };
    });

    return run.immediate();
  }

  async putChainRevision(
    input: ChainRevisionInput,
  ): Promise<ChainRegistryResult<ChainRevisionRecord>> {
    if (!Number.isInteger(input.revision) || input.revision < 1) {
      return fail("invalid_input", `revision must be a positive integer, got ${String(input.revision)}`);
    }
    if (typeof input.fingerprint !== "string" || input.fingerprint.length === 0) {
      return fail("invalid_input", "fingerprint is required");
    }
    const state = input.state ?? "candidate";
    if (!isChainRevisionState(state)) {
      return fail("invalid_input", `unknown revision state: ${String(input.state)}`);
    }
    const now = input.now ?? new Date().toISOString();

    const run = this.#db.transaction((): ChainRegistryResult<ChainRevisionRecord> => {
      if (!this.#readChain(input.chainId)) {
        return fail("not_found", `no such chain: ${input.chainId}`);
      }
      const existing = this.#db
        .prepare("SELECT * FROM dependency_chain_revision WHERE chain_id = ? AND revision = ?")
        .get(input.chainId, input.revision) as RevisionRow | undefined;
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) {
          return fail(
            "already_exists",
            `revision ${input.revision} already recorded with a different fingerprint`,
          );
        }
        return { ok: true, value: rowToRevision(existing) };
      }

      this.#insertRevision({
        chainId: input.chainId,
        revision: input.revision,
        fingerprint: input.fingerprint,
        state,
        source: input.source,
        note: input.note,
        now,
      });
      const stored = this.#db
        .prepare("SELECT * FROM dependency_chain_revision WHERE chain_id = ? AND revision = ?")
        .get(input.chainId, input.revision) as RevisionRow;
      return { ok: true, value: rowToRevision(stored) };
    });

    return run.immediate();
  }

  async setChainRevisionState(
    chainId: string,
    revision: number,
    state: ChainRevisionState,
    options?: {
      note?: string;
      now?: string;
      unlessAcceptedRevision?: boolean;
      expectedRev?: number;
    },
  ): Promise<ChainRevisionStateResult> {
    if (!isChainRevisionState(state)) {
      return fail("invalid_input", `unknown revision state: ${String(state)}`);
    }

    const run = this.#db.transaction((): ChainRevisionStateResult => {
      const existing = this.#db
        .prepare("SELECT * FROM dependency_chain_revision WHERE chain_id = ? AND revision = ?")
        .get(chainId, revision) as RevisionRow | undefined;
      if (!existing) {
        return fail("not_found", `no revision ${revision} for chain ${chainId}`);
      }
      const chain = this.#readChain(chainId);
      if (!chain) return fail("not_found", `no such chain: ${chainId}`);
      // Before the no-op below, not after: a caller pins this write so the
      // `chainRev` it gets back describes only its own effect, and a guarded
      // no-op that reported the row a concurrent writer had already moved
      // would hand back exactly the number the pin exists to exclude.
      if (options?.expectedRev !== undefined && options.expectedRev !== chain.rev) {
        return fail("conflict", `expected rev ${options.expectedRev}, found ${chain.rev}`);
      }
      // Read here rather than by the caller: a pointer that moved onto this
      // revision after the caller looked would otherwise be left naming a row
      // this write has just demoted. Inside the transaction the two cannot
      // interleave, so the label the pointer implies is the one that survives.
      if (options?.unlessAcceptedRevision === true && chain.acceptedRevision === revision) {
        return { ok: true, value: rowToRevision(existing), chainRev: chain.rev };
      }
      const note = options?.note === undefined ? existing.note : options.note;
      this.#db
        .prepare(
          "UPDATE dependency_chain_revision SET state = ?, note = ? WHERE chain_id = ? AND revision = ?",
        )
        .run(state, note, chainId, revision);
      this.#touchChain(chainId, options?.now ?? new Date().toISOString());
      const stored = this.#db
        .prepare("SELECT * FROM dependency_chain_revision WHERE chain_id = ? AND revision = ?")
        .get(chainId, revision) as RevisionRow;
      // Read inside the write's own transaction: this is the number a caller
      // compare-and-sets on to assert that nothing has touched the chain since
      // its last write, and a read taken after the transaction could not tell
      // this bump from a concurrent writer's.
      return { ok: true, value: rowToRevision(stored), chainRev: this.#readChain(chainId)!.rev };
    });

    return run.immediate();
  }

  async setAcceptedRevision(
    chainId: string,
    revision: number | null,
    options?: {
      expectedRev?: number;
      now?: string;
      guard?: AcceptedRevisionGuard;
      guardChainIds?: readonly string[];
    },
  ): Promise<ChainRegistryResult<ChainRecord>> {
    if (revision !== null && (!Number.isInteger(revision) || revision < 1)) {
      return fail("invalid_input", `revision must be a positive integer or null, got ${String(revision)}`);
    }
    const now = options?.now ?? new Date().toISOString();

    const run = this.#db.transaction((): ChainRegistryResult<ChainRecord> => {
      const current = this.#readChain(chainId);
      if (!current) return fail("not_found", `no such chain: ${chainId}`);
      if (options?.expectedRev !== undefined && options.expectedRev !== current.rev) {
        return fail("conflict", `expected rev ${options.expectedRev}, found ${current.rev}`);
      }
      if (revision !== null) {
        // Referential integrity, not policy: the pointer must name a revision
        // record that exists. Whether that revision *deserves* acceptance is
        // #890's call, made before it gets here.
        const exists = this.#db
          .prepare("SELECT 1 FROM dependency_chain_revision WHERE chain_id = ? AND revision = ?")
          .get(chainId, revision);
        if (!exists) return fail("not_found", `no revision ${revision} for chain ${chainId}`);
      }

      // The caller's own rule, applied to rows read here rather than to rows it
      // read before calling. A frozen prefix (#891) is written without touching
      // any chain row, so the compare-and-set above cannot see one land — and a
      // caller that checked the snapshots itself checked them in an earlier
      // transaction. Inside this one the two orderings are the only ones there
      // are: either the freeze has not been written yet, and the graph it
      // snapshots is the one this write accepts, or it has, and this write is
      // refused.
      if (options?.guard !== undefined) {
        const guardChainIds = [...new Set([chainId, ...(options.guardChainIds ?? [])])];
        const refusal = options.guard({ frozenPrefixes: this.#readFrozenPrefixes(guardChainIds) });
        if (refusal !== undefined) return fail("guard_refused", refusal);
      }

      this.#db
        .prepare(
          "UPDATE dependency_chain SET accepted_revision = ?, updated_at = ?, rev = rev + 1 WHERE chain_id = ?",
        )
        .run(revision, now, chainId);

      return { ok: true, value: this.#readChain(chainId)! };
    });

    return run.immediate();
  }

  async putChainAlias(input: ChainAliasInput): Promise<ChainRegistryResult<ChainAlias>> {
    if (!isValidChainAlias(input.alias)) {
      return fail("invalid_input", `malformed alias: ${String(input.alias)}`);
    }
    const now = input.now ?? new Date().toISOString();

    const run = this.#db.transaction((): ChainRegistryResult<ChainAlias> => {
      if (!this.#readChain(input.chainId)) {
        return fail("not_found", `no such chain: ${input.chainId}`);
      }
      // An alias that shadows a live chain ID would make that handle
      // ambiguous, so the namespace is shared and this is refused outright —
      // even when both name the same chain, because the alias row would then
      // be unreachable through `resolveChainHandle`.
      if (this.#db.prepare("SELECT 1 FROM dependency_chain WHERE chain_id = ?").get(input.alias)) {
        return fail("alias_taken", `alias ${input.alias} is already a chain id`);
      }
      const existing = this.#db
        .prepare("SELECT * FROM dependency_chain_alias WHERE alias = ?")
        .get(input.alias) as AliasRow | undefined;
      if (existing) {
        if (existing.chain_id !== input.chainId) {
          return fail("alias_taken", `alias ${input.alias} already points at ${existing.chain_id}`);
        }
        return { ok: true, value: rowToAlias(existing) };
      }

      this.#db
        .prepare(
          "INSERT INTO dependency_chain_alias (alias, chain_id, reason, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(input.alias, input.chainId, input.reason ?? null, now);
      this.#touchChain(input.chainId, now);

      const stored = this.#db
        .prepare("SELECT * FROM dependency_chain_alias WHERE alias = ?")
        .get(input.alias) as AliasRow;
      return { ok: true, value: rowToAlias(stored) };
    });

    return run.immediate();
  }

  async deleteChainAlias(
    alias: string,
  ): Promise<ChainRegistryResult<{ alias: string; deleted: boolean }>> {
    const run = this.#db.transaction((): ChainRegistryResult<{ alias: string; deleted: boolean }> => {
      const existing = this.#db
        .prepare("SELECT * FROM dependency_chain_alias WHERE alias = ?")
        .get(alias) as AliasRow | undefined;
      if (!existing) return { ok: true, value: { alias, deleted: false } };
      this.#db.prepare("DELETE FROM dependency_chain_alias WHERE alias = ?").run(alias);
      this.#touchChain(existing.chain_id, new Date().toISOString());
      return { ok: true, value: { alias, deleted: true } };
    });

    return run.immediate();
  }

  async deleteChain(
    chainId: string,
    options?: { expectedRev?: number },
  ): Promise<ChainRegistryResult<{ chainId: string; deleted: boolean }>> {
    const run = this.#db.transaction((): ChainRegistryResult<{ chainId: string; deleted: boolean }> => {
      const current = this.#readChain(chainId);
      if (!current) return { ok: true, value: { chainId, deleted: false } };
      if (options?.expectedRev !== undefined && options.expectedRev !== current.rev) {
        return fail("conflict", `expected rev ${options.expectedRev}, found ${current.rev}`);
      }
      // Child rows are deleted explicitly rather than left to the cascade.
      // A database created by an earlier build already has these tables, and
      // `CREATE TABLE IF NOT EXISTS` cannot retrofit an `ON DELETE CASCADE`
      // onto them, so on a migrated file the cascade may simply not exist and
      // the chain delete would report success over orphaned rows. These
      // statements make the outcome the same on every database; on a fresh one
      // they are redundant with the cascade, never in conflict with it.
      //
      // Edges before members, for the same reason as `#writeGraphRows`: an
      // edge's composite foreign key points at a member row.
      this.#db.prepare("DELETE FROM dependency_chain_edge WHERE chain_id = ?").run(chainId);
      this.#db.prepare("DELETE FROM dependency_chain_member WHERE chain_id = ?").run(chainId);
      this.#db.prepare("DELETE FROM dependency_chain_revision WHERE chain_id = ?").run(chainId);
      this.#db.prepare("DELETE FROM dependency_chain_alias WHERE chain_id = ?").run(chainId);
      // Frozen prefixes go with the chain (issue #891). They carry no foreign
      // key — see `chain-registry-migration.ts` — so nothing but this statement
      // would clear them, and a snapshot pinning the ancestry of a chain that
      // no longer exists guards nothing while still refusing every candidate an
      // operator might build in its place.
      this.#db
        .prepare("DELETE FROM dependency_chain_frozen_prefix WHERE chain_id = ?")
        .run(chainId);
      this.#db.prepare("DELETE FROM dependency_chain WHERE chain_id = ?").run(chainId);
      return { ok: true, value: { chainId, deleted: true } };
    });

    return run.immediate();
  }

  async retireChain(input: RetireChainInput): Promise<ChainRegistryResult<ChainRetirement>> {
    const now = input.now ?? new Date().toISOString();

    const run = this.#db.transaction((): ChainRegistryResult<ChainRetirement> => {
      if (input.chainId === input.intoChainId) {
        return fail("invalid_input", "a chain cannot be retired into itself");
      }
      const current = this.#readChain(input.chainId);
      if (!current) return fail("not_found", `no such chain: ${input.chainId}`);
      const into = this.#readChain(input.intoChainId);
      if (!into) return fail("not_found", `no such chain: ${input.intoChainId}`);
      if (input.expectedRev !== undefined && input.expectedRev !== current.rev) {
        return fail("conflict", `expected rev ${input.expectedRev}, found ${current.rev}`);
      }

      // Re-point the chain's aliases before its row goes away, keeping each
      // row's own provenance: the alias is history, and the retirement only
      // changes where it resolves.
      const movedAliases = (
        this.#db
          .prepare("SELECT alias FROM dependency_chain_alias WHERE chain_id = ? ORDER BY alias")
          .all(input.chainId) as Array<{ alias: string }>
      ).map((row) => row.alias);
      this.#db
        .prepare("UPDATE dependency_chain_alias SET chain_id = ? WHERE chain_id = ?")
        .run(input.intoChainId, input.chainId);

      // Frozen prefixes survive the retirement against the surviving chain. A
      // started Issue's contract is about its ancestry, and a retirement that
      // preserves the ancestry (a merge in the `prepend` position) must not
      // silently unpin it. The chain handle is part of the contract's
      // fingerprint, so it is recomputed for the new handle; everything the
      // freeze actually pinned is carried over byte for byte.
      const prefixes = this.#readFrozenPrefixes([input.chainId]);
      const retagPrefix = this.#db.prepare(
        `UPDATE dependency_chain_frozen_prefix SET chain_id = ?, prefix_fingerprint = ?
          WHERE session_id = ? AND issue_number = ? AND chain_id = ?`,
      );
      for (const snapshot of prefixes) {
        const fingerprint = frozenPrefixFingerprint({
          issueNumber: snapshot.issueNumber,
          chainId: input.intoChainId,
          ancestors: snapshot.ancestors,
          predecessors: snapshot.predecessors,
          edges: snapshot.edges,
          order: snapshot.order,
          base: snapshot.base,
        });
        retagPrefix.run(
          input.intoChainId,
          fingerprint,
          snapshot.sessionId,
          snapshot.issueNumber,
          input.chainId,
        );
      }

      // Edges before members, as everywhere else: the composite foreign key
      // points at member rows.
      this.#db.prepare("DELETE FROM dependency_chain_edge WHERE chain_id = ?").run(input.chainId);
      this.#db.prepare("DELETE FROM dependency_chain_member WHERE chain_id = ?").run(input.chainId);
      this.#db.prepare("DELETE FROM dependency_chain_revision WHERE chain_id = ?").run(input.chainId);
      this.#db.prepare("DELETE FROM dependency_chain WHERE chain_id = ?").run(input.chainId);

      // Only now is the ID free to become a handle again — the shared
      // namespace is exactly why this cannot be composed from deleteChain +
      // putChainAlias. This row is what keeps the retired chain resolvable.
      this.#db
        .prepare(
          "INSERT INTO dependency_chain_alias (alias, chain_id, reason, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(input.chainId, input.intoChainId, input.reason ?? null, now);
      this.#touchChain(input.intoChainId, now);

      return {
        ok: true,
        value: {
          chainId: input.chainId,
          intoChainId: input.intoChainId,
          movedAliases,
          movedFrozenPrefixes: prefixes.length,
        },
      };
    });

    return run.immediate();
  }

  /* ---------------------------------------------------------------------
   * Frozen prefixes (issue #891)
   * ------------------------------------------------------------------ */

  async getFrozenPrefix(key: FrozenPrefixKey): Promise<FrozenPrefixSnapshot | undefined> {
    const row = this.#db.prepare(SELECT_FROZEN_PREFIX).get(key.sessionId, key.issueNumber) as
      | FrozenPrefixRow
      | undefined;
    return row ? rowToFrozenPrefix(row) : undefined;
  }

  async listFrozenPrefixes(filter?: FrozenPrefixListFilter): Promise<FrozenPrefixSnapshot[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.sessionId !== undefined) {
      clauses.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter?.chainId !== undefined) {
      clauses.push("chain_id = ?");
      params.push(filter.chainId);
    }
    return this.#selectFrozenPrefixes(clauses, params);
  }

  /**
   * The named chains' frozen prefixes, read synchronously so a caller's
   * {@link AcceptedRevisionGuard} can be evaluated inside a transaction. Shares
   * `listFrozenPrefixes`'s query and ordering deliberately: a guard is handed
   * whichever list its caller could have read for itself, and the two must not
   * be able to disagree about what "the frozen prefixes of this chain" means.
   * More than one chain only where the acceptance answers for more than one —
   * a merge's `guardChainIds` names the source chain alongside the target.
   */
  #readFrozenPrefixes(chainIds: readonly string[]): FrozenPrefixSnapshot[] {
    return this.#selectFrozenPrefixes(
      [`chain_id IN (${chainIds.map(() => "?").join(", ")})`],
      [...chainIds],
    );
  }

  #selectFrozenPrefixes(clauses: string[], params: unknown[]): FrozenPrefixSnapshot[] {
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(
        `SELECT * FROM dependency_chain_frozen_prefix${where} ORDER BY session_id, issue_number`,
      )
      .all(...params) as FrozenPrefixRow[];
    return rows.map(rowToFrozenPrefix);
  }

  /**
   * Record a frozen prefix, or recognize the one already on record.
   *
   * The existence check and the insert share this transaction for the same
   * reason every other write here does: two callers freezing the same task
   * would otherwise both read "nothing frozen" and both write, and the loser's
   * contract would silently replace the one the winner's task is already
   * running under.
   *
   * A different contract at the same key is refused rather than overwritten —
   * `already_exists`, exactly as `putChainRevision` refuses a revision number
   * whose fingerprint changed. A frozen prefix that a later write could
   * redefine would not be frozen at all.
   */
  async putFrozenPrefix(
    snapshot: FrozenPrefixSnapshot,
  ): Promise<ChainRegistryResult<FrozenPrefixSnapshot>> {
    const invalid = validateFrozenPrefixSnapshot(snapshot);
    if (invalid !== undefined) return fail("invalid_input", invalid);

    const run = this.#db.transaction((): ChainRegistryResult<FrozenPrefixSnapshot> => {
      // The chain must be the snapshot's own session's. Chain IDs are global,
      // so an existence-only check would let a task be frozen against another
      // session's graph, and `listFrozenPrefixes({ chainId })` would then feed
      // that row to the guard as a constraint on a run it never described. A
      // chain owned elsewhere is reported as absent, which is what it is from
      // this session.
      const chain = this.#readChain(snapshot.chainId);
      if (!chain) {
        return fail("not_found", `no such chain: ${snapshot.chainId}`);
      }
      if (chain.sessionId !== snapshot.sessionId) {
        return fail(
          "not_found",
          `chain ${snapshot.chainId} belongs to session ${chain.sessionId}, not ${snapshot.sessionId}`,
        );
      }
      const existing = this.#db
        .prepare(SELECT_FROZEN_PREFIX)
        .get(snapshot.sessionId, snapshot.issueNumber) as FrozenPrefixRow | undefined;
      if (existing) {
        if (existing.prefix_fingerprint !== snapshot.fingerprint) {
          return fail(
            "already_exists",
            `issue ${snapshot.issueNumber} is already frozen with a different prefix`,
          );
        }
        // Idempotent repeat: the stored row keeps the provenance of the first
        // freeze — which accepted revision it was taken from, and when.
        return { ok: true, value: rowToFrozenPrefix(existing) };
      }

      this.#db.prepare(INSERT_FROZEN_PREFIX).run(...frozenPrefixInsertValues(snapshot));
      const stored = this.#db
        .prepare(SELECT_FROZEN_PREFIX)
        .get(snapshot.sessionId, snapshot.issueNumber) as FrozenPrefixRow;
      return { ok: true, value: rowToFrozenPrefix(stored) };
    });

    return run.immediate();
  }

  async deleteFrozenPrefix(
    key: FrozenPrefixKey,
  ): Promise<ChainRegistryResult<{ deleted: boolean }>> {
    const run = this.#db.transaction((): ChainRegistryResult<{ deleted: boolean }> => {
      const info = this.#db
        .prepare(
          "DELETE FROM dependency_chain_frozen_prefix WHERE session_id = ? AND issue_number = ?",
        )
        .run(key.sessionId, key.issueNumber);
      return { ok: true, value: { deleted: info.changes > 0 } };
    });

    return run.immediate();
  }

  /* -----------------------------------------------------------------------
   * Intake error fingerprints (issue #790)
   * -------------------------------------------------------------------- */

  async getChainIntakeError(key: ChainIntakeErrorKey): Promise<ChainIntakeErrorRecord | undefined> {
    const row = this.#db
      .prepare(
        "SELECT * FROM dependency_chain_intake_error WHERE session_id = ? AND issue_number = ?",
      )
      .get(key.sessionId, key.issueNumber) as
      | {
          session_id: string;
          issue_number: number;
          fingerprint: string;
          kind: string;
          message: string;
          created_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      issueNumber: row.issue_number,
      fingerprint: row.fingerprint,
      // A kind this build does not know reads as the durable default rather
      // than crashing intake: the fingerprint, not the kind, is the identity
      // the dedup keys on.
      kind: isChainSyncRefusalKind(row.kind) ? row.kind : "structural",
      message: row.message,
      createdAt: row.created_at,
    };
  }

  async putChainIntakeError(record: ChainIntakeErrorRecord): Promise<void> {
    const run = this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO dependency_chain_intake_error
             (session_id, issue_number, fingerprint, kind, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (session_id, issue_number) DO UPDATE SET
             fingerprint = excluded.fingerprint,
             kind = excluded.kind,
             message = excluded.message,
             created_at = excluded.created_at`,
        )
        .run(
          record.sessionId,
          record.issueNumber,
          record.fingerprint,
          record.kind,
          record.message,
          record.createdAt,
        );
    });
    run.immediate();
  }

  async deleteChainIntakeError(key: ChainIntakeErrorKey): Promise<{ deleted: boolean }> {
    const run = this.#db.transaction((): { deleted: boolean } => {
      const info = this.#db
        .prepare(
          "DELETE FROM dependency_chain_intake_error WHERE session_id = ? AND issue_number = ?",
        )
        .run(key.sessionId, key.issueNumber);
      return { deleted: info.changes > 0 };
    });
    return run.immediate();
  }

  /* -----------------------------------------------------------------------
   * Chain-edit locks (issue #791 review)
   * -------------------------------------------------------------------- */

  /**
   * Claim every scope, or none of them.
   *
   * Check every scope, then write every scope, both inside one `BEGIN
   * IMMEDIATE` transaction. That is what makes it all-or-nothing and
   * deadlock-free at once: two edits overlapping on different subsets cannot
   * each hold half and wait for the other, because the second one to reach the
   * writer lock reads a state the first has already finished committing. A
   * refusal therefore never leaves a scope claimed, and the loser has nothing to
   * release before it retries.
   *
   * A scope this same owner already holds is refreshed rather than contended:
   * acquisition is idempotent for the run that owns it.
   */
  async acquireChainEditLocks(input: AcquireChainEditLocksInput): Promise<ChainEditLockAcquisition> {
    const scopes = [...new Set(input.scopes)].sort();
    const nowMs = new Date(input.now).getTime();

    const run = this.#db.transaction((): ChainEditLockAcquisition => {
      const read = this.#db.prepare("SELECT * FROM dependency_chain_edit_lock WHERE scope = ?");
      // Every scope is checked BEFORE any of them is written. A transaction
      // function that returns normally commits — only a throw rolls back — so a
      // check-then-write loop would leave the scopes it had already passed
      // claimed by a run that goes on to refuse. Reading first costs nothing:
      // the writer lock is held for the whole transaction either way.
      for (const scope of scopes) {
        const row = read.get(scope) as EditLockRow | undefined;
        if (row === undefined || row.owner_id === input.ownerId) continue;
        const takeable = chainEditLockIsTakeable({
          ageMs: nowMs - new Date(row.acquired_at).getTime(),
          // The decisive fact, not the age: a run blocked in a `spawnSync`
          // provider call fires no heartbeat, so age alone would supersede an
          // edit that is still writing (issue #791 review).
          owner: editLockOwnerLiveness(row),
          ...(input.staleAfterMs === undefined ? {} : { staleAfterMs: input.staleAfterMs }),
          ...(input.abandonedAfterMs === undefined ? {} : { abandonedAfterMs: input.abandonedAfterMs }),
        });
        if (!takeable) {
          return {
            ok: false,
            scope,
            heldBy: {
              ownerId: row.owner_id,
              operationId: row.operation_id,
              acquiredAt: row.acquired_at,
              // Reported only when recorded, so a row from an older build reads
              // exactly as it did before.
              ...(row.owner_pid === null ? {} : { pid: row.owner_pid }),
              ...(row.owner_host === null ? {} : { host: row.owner_host }),
            },
          };
        }
      }

      const write = this.#db.prepare(
        `INSERT INTO dependency_chain_edit_lock (scope, owner_id, operation_id, acquired_at, owner_pid, owner_host)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope) DO UPDATE SET
           owner_id = excluded.owner_id,
           operation_id = excluded.operation_id,
           acquired_at = excluded.acquired_at,
           owner_pid = excluded.owner_pid,
           owner_host = excluded.owner_host`,
      );
      for (const scope of scopes) {
        write.run(
          scope,
          input.ownerId,
          input.operationId,
          input.now,
          input.ownerPid ?? null,
          input.ownerHost ?? null,
        );
      }
      return { ok: true, scopes };
    });

    return run.immediate();
  }

  /**
   * Heartbeat: move `acquired_at` forward on every scope this owner still holds.
   *
   * The staleness check above measures age from `acquired_at`, so a run slower
   * than the window — many Issues, a rate-limited provider — would otherwise
   * have its scopes taken over while it was still writing relationships and
   * suspending labels (issue #791 review). Renewing on a timer keeps the age
   * measured from the last sign of life instead, so only a run that has actually
   * stopped can be superseded.
   *
   * Every UPDATE is fenced on `owner_id`, and a scope that matches nothing is
   * reported as lost rather than re-inserted: an owner that was already
   * superseded must not silently reclaim what the run after it now holds.
   */
  async renewChainEditLocks(input: RenewChainEditLocksInput): Promise<ChainEditLockRenewal> {
    const scopes = [...new Set(input.scopes)].sort();

    const run = this.#db.transaction((): ChainEditLockRenewal => {
      const stmt = this.#db.prepare(
        "UPDATE dependency_chain_edit_lock SET acquired_at = ? WHERE scope = ? AND owner_id = ?",
      );
      const renewed: string[] = [];
      const lost: string[] = [];
      for (const scope of scopes) {
        if (stmt.run(input.now, scope, input.ownerId).changes > 0) renewed.push(scope);
        else lost.push(scope);
      }
      return { renewed, lost };
    });

    return run.immediate();
  }

  async releaseChainEditLocks(
    scopes: readonly string[],
    ownerId: string,
  ): Promise<{ released: number }> {
    const run = this.#db.transaction((): { released: number } => {
      const stmt = this.#db.prepare(
        "DELETE FROM dependency_chain_edit_lock WHERE scope = ? AND owner_id = ?",
      );
      let released = 0;
      // Scoped to this owner: a scope a staleness takeover has already handed to
      // a later run belongs to that run, and deleting it here — from the run
      // that was declared gone — would silently unblock a third edit.
      for (const scope of scopes) released += stmt.run(scope, ownerId).changes;
      return { released };
    });
    return run.immediate();
  }
}
