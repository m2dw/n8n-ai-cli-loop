#!/usr/bin/env node
/**
 * chatops-status — read-only ChatOps state for one session.
 *
 * The diagnostic surface `docs/chatops-result-contract.md` §8 describes and
 * deliberately left to a later issue: cursor position, fenced scopes, rows still
 * owing an acknowledgement, rows parked for a human, and the disposition each
 * command actually reached — none of which should require opening SQLite.
 *
 * **Strictly read-only.** It opens no provider connection, posts nothing, and
 * writes nothing, including the epoch witness: it *reports* the witness/database
 * comparison but never heals it, because rolling the witness forward is a
 * dispatch-path decision and a status command that silently repaired state would
 * be a diagnosis that changed what it diagnosed. Clearing a fence and resolving a
 * parked row are `chatops-recover`'s job. The store connection is read-only for
 * the same reason: a session that has never run a pass has no ChatOps database,
 * and this command reports that rather than creating one.
 *
 * Operator-private ledger fields (`evidence`, `detail`, `handoff`) surface here
 * and only here — §8 scopes them as never readable by anything that composes a
 * public comment, which is why this is a local CLI rather than a published
 * summary.
 *
 * n8n / operator command shape:
 *   node /path/to/dist/cli/chatops-status.js \
 *     --session-id "addon-dev" [--issue-number 12] [--db-path ...]
 *
 * Exit codes: 0 on a successful read, 1 on a setup error. One JSON object on stdout.
 */

import { fileURLToPath } from "url";
import {
  JsonSessionRegistry,
  DEFAULT_SESSIONS_PATH,
  describeUnresolvedSessionId,
} from "../registries/json-session-registry.js";
import { SqliteChatOpsStore, DEFAULT_DB_PATH } from "../stores/sqlite-chatops-store.js";
import { chatOpsIdentityKey, deriveChatOpsProviderIdentity } from "../core/chatops-identity.js";
import type { ChatOpsProviderIdentity } from "../core/chatops-identity.js";
import { assessChatOpsLedgerEpoch } from "../core/chatops-execution-ledger.js";
import type { ChatOpsLedgerRow } from "../core/chatops-execution-ledger.js";
import {
  chatOpsEpochWitnessPath,
  readChatOpsEpochWitness,
} from "../core/chatops-epoch-witness.js";
import { chatOpsLedgerDisposition } from "../core/chatops-result.js";
import { emit, die } from "./cli-io.js";
import { tokenizeArgs } from "./admin-command.js";

/** Audit records reported per scope. Bounded so a busy issue stays readable. */
const AUDIT_TAIL = 20;

interface CliArgs {
  sessionId: string;
  sessionsPath: string;
  dbPath: string;
  issueNumbers: number[] | undefined;
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    valueFlags: ["session-id", "sessions-path", "db-path", "issue-number"],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args } = tokenized;
  const sessionId = args["session-id"];
  if (!sessionId) return { error: "--session-id is required" };

  let issueNumbers: number[] | undefined;
  if (args["issue-number"] !== undefined) {
    issueNumbers = [];
    for (const part of args["issue-number"].split(",").map((p) => p.trim())) {
      const parsed = Number(part);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return { error: `--issue-number must be a comma-separated list of positive integers, got: ${args["issue-number"]}` };
      }
      if (!issueNumbers.includes(parsed)) issueNumbers.push(parsed);
    }
  }

  return {
    sessionId,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"] ?? DEFAULT_DB_PATH,
    issueNumbers,
  };
}

/** The operator-private view of one ledger row (§8). */
function describeRow(row: ChatOpsLedgerRow): Record<string, unknown> {
  const disposition = chatOpsLedgerDisposition(row);
  return {
    commentId: row.commentId,
    state: row.state,
    outcome: row.outcome,
    attempts: row.attempts,
    epoch: row.epoch,
    ackPublication: row.ackPublication,
    ackAttempts: row.ackAttempts,
    reconcileAttempts: row.reconcileAttempts,
    evidenceClaims: row.evidenceClaims,
    evidenceAcks: row.evidenceAcks,
    evidenceTruncated: row.evidenceTruncated,
    handoff: row.handoff,
    detail: row.detail,
    ...(disposition
      ? { kind: disposition.kind, dispatched: disposition.dispatched }
      : { kind: null, dispatched: row.attempts >= 1 }),
  };
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) die(parsed.error);
  const { sessionId, sessionsPath, dbPath } = parsed;

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const session = await registry.getSessionById(sessionId);
  if (!session) die(describeUnresolvedSessionId(registry, sessionId, sessionsPath));

  let identity: ChatOpsProviderIdentity;
  try {
    identity = deriveChatOpsProviderIdentity(session);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  const identityKey = chatOpsIdentityKey(identity);

  // Read-only right down to the connection: an ordinary open would create the
  // database and its schema for a session that has never run a pass, so a
  // command whose whole contract is "reports state, changes nothing" would be
  // the thing that created the state it reported on. A database that is not
  // there yet is a finding, not something to fix on the way past.
  let store: SqliteChatOpsStore;
  try {
    store = SqliteChatOpsStore.openReadOnly(dbPath);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  try {
    const dbEpoch = await store.getEpoch(identityKey);
    const witnessPath = chatOpsEpochWitnessPath(session.artifactRoot);
    const witness = readChatOpsEpochWitness(witnessPath);
    // Assessed but never healed: see the module header.
    const assessment =
      witness.kind === "unreadable"
        ? {
            verdict: "witness-missing",
            fence: true,
            detail: witness.detail,
          }
        : assessChatOpsLedgerEpoch(dbEpoch, witness.kind === "present" ? witness.epoch : null);

    const issueNumbers = parsed.issueNumbers ?? (await store.listIssueNumbers(identityKey));
    const issues: Array<Record<string, unknown>> = [];
    for (const issueNumber of issueNumbers) {
      const scope = { identityKey, issueNumber };
      const state = await store.loadScope(scope);
      const audit = await store.listAudit(scope);
      issues.push({
        issueNumber,
        lastActivityAt: state.lastActivityAt,
        cursor: state.cursor,
        fence: {
          issue: state.issueFence,
          session: state.sessionFence,
        },
        // The four questions an operator actually asks, precomputed rather than
        // left to be reconstructed from the row list below.
        pendingPublication: state.rows
          .filter((row) => row.state === "awaiting_ack" && row.ackPublication === "pending")
          .map((row) => row.commentId),
        // A publication reserved but never settled: the pass that took it died
        // between posting the marker and recording the result, so whether the
        // marker landed is unknown until the next pass settles the attempt.
        unsettledPublication: state.ackReservations,
        awaitingHuman: state.rows
          .filter((row) => row.state === "ambiguous" || row.ackPublication === "abandoned")
          .map((row) => ({ commentId: row.commentId, handoff: row.handoff })),
        inFlight: state.rows.filter((row) => row.state === "dispatching").map((row) => row.commentId),
        deferredClaims: state.pendingFirstSeen.map((record) => record.commentId),
        rows: state.rows.map(describeRow),
        // The most recently emitted record for a comment is its current
        // disposition (§9.1) — emission order, never the numeric `row` field.
        auditTail: audit.slice(-AUDIT_TAIL),
      });
    }

    emit({
      ok: true,
      sessionId: session.sessionId,
      enabled: session.chatOps?.enabled === true,
      identity: {
        provider: identity.provider,
        providerEndpoint: identity.providerEndpoint,
        providerOwner: identity.providerOwner,
        providerRepo: identity.providerRepo,
      },
      epoch: {
        database: dbEpoch,
        witness: witness.kind === "present" ? witness.epoch : null,
        witnessPath,
        verdict: assessment.verdict,
        fenced: assessment.fence,
        detail: assessment.detail,
      },
      issues,
    });
  } finally {
    store.close();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    die(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  });
}
