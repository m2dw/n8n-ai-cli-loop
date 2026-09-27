#!/usr/bin/env node
/**
 * chatops-recover — the operator half of the ChatOps ledger.
 *
 * Everything automation deliberately refuses to do on its own
 * (`docs/chatops-execution-ledger-contract.md` §12, §13.2, §13.3):
 *
 *   --clear-fence            lift a fence, naming the scope, recorded durably
 *   --seed-witness           re-seed the epoch witness after a legitimate
 *                            `artifactRoot` repoint
 *   --resolve --outcome X    ledger row 21: record what actually happened
 *   --retry                  ledger row 22: authorize one more attempt
 *
 * These are one-way doors on purpose. A fence never expires and is never cleared
 * automatically, because a fence that lifted on its own would be a silent replay
 * path with a delay. Row 22 is the *only* path by which a command that may
 * already have executed is dispatched again, which is why it refuses to apply
 * without both an operator identity and a reason — neither is inferable
 * afterwards, and a retry nobody is named for is exactly the silent replay the
 * rest of the ledger exists to forbid.
 *
 * Every action here decides from what the operator *read*, minutes earlier, in
 * `chatops-status` — so every one of them commits as a compare-and-swap against
 * what the transaction itself sees, and refuses if anything moved in between.
 * `--clear-fence` compares the fence (with `--fenced-at <iso>` as the explicit
 * operator-named form); `--resolve` and `--retry` compare the ledger row, because
 * a decision applied to a state that no longer exists would overwrite whatever
 * settled it — and, for `--resolve`, leave the summary comment the outbox already
 * accepted under that row's key describing an outcome the ledger no longer holds.
 *
 * Exit codes: 0 when the action applied or was a recorded no-op, 1 on a setup or
 * validation error — including state that changed underneath the action, which
 * leaves what is recorded in place. One JSON object on stdout.
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
import {
  applyChatOpsLedgerEvent,
  sameChatOpsLedgerVersion,
} from "../core/chatops-execution-ledger.js";
import type { ChatOpsLedgerRow } from "../core/chatops-execution-ledger.js";
import type { ChatOpsMarkerOutcome } from "../core/chatops-command.js";
import {
  chatOpsEpochWitnessPath,
  writeChatOpsEpochWitness,
} from "../core/chatops-epoch-witness.js";
import {
  chatOpsOperatorResolvedOutcome,
  renderChatOpsSummaryComment,
} from "../core/chatops-result.js";
import type { ChatOpsAuditRecord, ChatOpsPublicOutcome } from "../core/chatops-result.js";
import type {
  ChatOpsCommitInput,
  ChatOpsFenceRecord,
  ChatOpsScope,
  ChatOpsStore,
} from "../core/chatops-store.js";
import { makeOutboxKey } from "../core/outbox.js";
import type { WorkItemCommentPayload } from "../core/outbox.js";
import { DEFAULT_COMMENT_MAX_CHARS, enforceCommentVisibility } from "../core/outbox-visibility.js";
import { sessionRedactionPaths } from "../core/outbox-effects.js";
import { emit, die } from "./cli-io.js";
import { tokenizeArgs } from "./admin-command.js";

const MARKER_OUTCOMES: readonly string[] = ["executed", "rejected", "error"];

/**
 * Are these the same fence?
 *
 * A fence carries no id, so the three fields it records *are* its version: two
 * fences that agree on all three are indistinguishable, and clearing either is
 * the same act. Anything else — a different reason, a different detail, a later
 * `fencedAt` — is a different fence, raised by a different observation, and an
 * operator who has not read it has not authorized clearing it.
 */
function sameFence(a: ChatOpsFenceRecord, b: ChatOpsFenceRecord): boolean {
  return a.reason === b.reason && a.detail === b.detail && a.fencedAt === b.fencedAt;
}

/** Bounded operator-facing description of a fence, for a refusal message. */
function describeFence(fence: ChatOpsFenceRecord | null): string {
  if (fence === null) return "no fence";
  const detail = fence.detail === null ? "" : `: ${fence.detail}`;
  return `${fence.reason} fenced at ${fence.fencedAt}${detail}`;
}

/**
 * Refusal text for a row that moved between the operator's read and the write.
 *
 * Both operator transitions decide from what the operator *read* — the row's
 * state is exactly what they were judging — so a row another writer moved in
 * between is a decision made about a state that no longer exists. Applying it
 * anyway would silently overwrite the newer outcome while the summary comment
 * this command enqueues stays keyed on the ledger row it thought it wrote,
 * leaving the published text disagreeing with the durable state.
 */
function describeStaleRow(
  action: string,
  commentId: string,
  observed: ChatOpsLedgerRow,
  current: ChatOpsLedgerRow | undefined,
): string {
  const now =
    current === undefined
      ? "the row is gone"
      : `it is ${current.state} with ${current.attempts} attempt(s) now`;
  return (
    `${action} refused: comment ${commentId} changed while it was being recorded ` +
    `(read as ${observed.state} with ${observed.attempts} attempt(s), ${now}); ` +
    `nothing was written — a concurrent pass or operator moved this row, so re-read ` +
    `chatops-status before deciding again`
  );
}

/** The fence at one grain, as the store currently records it. */
async function readFence(
  store: ChatOpsStore,
  scope: ChatOpsScope,
  grain: "issue" | "session",
): Promise<ChatOpsFenceRecord | null> {
  const state = await store.loadScope(scope);
  return grain === "session" ? state.sessionFence : state.issueFence;
}

interface CliArgs {
  sessionId: string;
  sessionsPath: string;
  dbPath: string;
  issueNumber: number | undefined;
  commentId: string | undefined;
  operator: string | undefined;
  reason: string | undefined;
  outcome: string | undefined;
  fencedAt: string | undefined;
  grain: "issue" | "session";
  clearFence: boolean;
  seedWitness: boolean;
  resolve: boolean;
  retry: boolean;
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const tokenized = tokenizeArgs(argv, {
    booleanFlags: ["clear-fence", "seed-witness", "resolve", "retry"],
    valueFlags: [
      "session-id",
      "sessions-path",
      "db-path",
      "issue-number",
      "comment-id",
      "operator",
      "reason",
      "outcome",
      "grain",
      "fenced-at",
    ],
  });
  if ("error" in tokenized) return { error: tokenized.error };
  const { args, flags } = tokenized;

  const sessionId = args["session-id"];
  if (!sessionId) return { error: "--session-id is required" };

  const actions = ["clear-fence", "seed-witness", "resolve", "retry"].filter((f) => flags.has(f));
  if (actions.length === 0) {
    return { error: "one of --clear-fence, --seed-witness, --resolve, or --retry is required" };
  }
  if (actions.length > 1) {
    return { error: `provide exactly one action, got: ${actions.map((a) => `--${a}`).join(", ")}` };
  }

  let issueNumber: number | undefined;
  if (args["issue-number"] !== undefined) {
    const parsed = Number(args["issue-number"]);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { error: `--issue-number must be a positive integer, got: ${args["issue-number"]}` };
    }
    issueNumber = parsed;
  }

  const rawGrain = args["grain"] ?? "issue";
  if (rawGrain !== "issue" && rawGrain !== "session") {
    return { error: `--grain must be "issue" or "session", got: ${rawGrain}` };
  }
  const grain: "issue" | "session" = rawGrain === "session" ? "session" : "issue";

  const outcome = args["outcome"];
  if (flags.has("resolve")) {
    if (outcome === undefined || !MARKER_OUTCOMES.includes(outcome)) {
      return { error: `--resolve requires --outcome one of: ${MARKER_OUTCOMES.join(", ")}` };
    }
  }
  if ((flags.has("resolve") || flags.has("retry")) && args["comment-id"] === undefined) {
    return { error: "--resolve/--retry require --comment-id" };
  }
  if ((flags.has("resolve") || flags.has("retry")) && issueNumber === undefined) {
    return { error: "--resolve/--retry require --issue-number" };
  }
  if (flags.has("clear-fence") && grain === "issue" && issueNumber === undefined) {
    return { error: "--clear-fence at issue grain requires --issue-number" };
  }
  if (args["fenced-at"] !== undefined && !flags.has("clear-fence")) {
    return { error: "--fenced-at only applies to --clear-fence" };
  }
  // Both operator transitions are refused by the ledger without a recorded
  // identity, and row 22 without a recorded reason as well. Checking here turns
  // that refusal into an argument error an operator can act on rather than a
  // committed no-op they have to go read the row to discover.
  if ((flags.has("resolve") || flags.has("retry")) && !args["operator"]) {
    return { error: "--resolve/--retry require --operator (the decision is recorded against it)" };
  }
  if (flags.has("retry") && !args["reason"]) {
    return { error: "--retry requires --reason (an authorized replay is never unexplained)" };
  }

  return {
    sessionId,
    sessionsPath: args["sessions-path"] ?? DEFAULT_SESSIONS_PATH,
    dbPath: args["db-path"] ?? DEFAULT_DB_PATH,
    issueNumber,
    commentId: args["comment-id"],
    operator: args["operator"],
    reason: args["reason"],
    outcome,
    fencedAt: args["fenced-at"],
    grain,
    clearFence: flags.has("clear-fence"),
    seedWitness: flags.has("seed-witness"),
    resolve: flags.has("resolve"),
    retry: flags.has("retry"),
  };
}

export interface ChatOpsRecoverDeps {
  /**
   * Overrides the SQLite ChatOps store.
   *
   * Exists for the tests that have to interleave a concurrent writer with this
   * command's own read — the ordering every compare-and-swap here exists for
   * (the fence for `--clear-fence`, the ledger row for `--resolve`/`--retry`),
   * and one a second in-process connection cannot produce, because a SQLite
   * transaction is not re-entrant.
   */
  store?: ChatOpsStore;
}

export async function main(argv: string[], deps: ChatOpsRecoverDeps = {}): Promise<void> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) die(parsed.error);

  let registry: JsonSessionRegistry;
  try {
    registry = new JsonSessionRegistry(parsed.sessionsPath);
  } catch (err) {
    die(`Failed to load sessions file (${parsed.sessionsPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const session = await registry.getSessionById(parsed.sessionId);
  if (!session) die(describeUnresolvedSessionId(registry, parsed.sessionId, parsed.sessionsPath));

  let identity: ChatOpsProviderIdentity;
  try {
    identity = deriveChatOpsProviderIdentity(session);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  const identityKey = chatOpsIdentityKey(identity);

  const store: ChatOpsStore = deps.store ?? new SqliteChatOpsStore(parsed.dbPath);
  try {
    if (parsed.seedWitness) {
      // §9.2's documented operator action for `witness-missing`: the epoch is
      // re-seeded from the database deliberately, by a human who has satisfied
      // themselves the artifact tree was repointed rather than the database
      // restored. Nothing automatic ever does this.
      const dbEpoch = await store.getEpoch(identityKey);
      const path = chatOpsEpochWitnessPath(session.artifactRoot);
      const written = writeChatOpsEpochWitness(path, dbEpoch);
      if (!written.ok) die(`epoch witness could not be written (${path}): ${written.error}`);
      emit({ ok: true, action: "seed-witness", witnessPath: path, epoch: dbEpoch });
      return;
    }

    // A session-grain fence is stored under a reserved scope, so a clear at that
    // grain does not need (and must not silently consume) an issue number.
    const scope: ChatOpsScope = {
      identityKey,
      issueNumber: parsed.issueNumber ?? 0,
    };

    if (parsed.clearFence) {
      // Cleared against *the fence the operator looked at*, never against
      // whatever happens to be there when SQLite hands over the write lock. A
      // scheduled or manual pass can record a new fence at any moment — §9.2's
      // witness detector and §11's regression predicate both commit in ordinary
      // transactions — and an unconditional delete would silently discard a
      // safety signal raised seconds ago, letting the next pass dispatch under a
      // clearance granted for an older, different fence.
      const observed = await readFence(store, scope, parsed.grain);
      if (observed === null) {
        if (parsed.fencedAt !== undefined) {
          die(
            `no ${parsed.grain}-grain fence is recorded, so --fenced-at ${parsed.fencedAt} ` +
              `names a fence that is already gone; nothing was cleared`,
          );
        }
        emit({
          ok: true,
          action: "clear-fence",
          grain: parsed.grain,
          ...(parsed.grain === "issue" ? { issueNumber: scope.issueNumber } : {}),
          cleared: false,
          note: `no ${parsed.grain}-grain fence was recorded`,
        });
        return;
      }
      if (parsed.fencedAt !== undefined && parsed.fencedAt !== observed.fencedAt) {
        die(
          `--fenced-at ${parsed.fencedAt} does not name the ${parsed.grain}-grain fence ` +
            `now recorded (${describeFence(observed)}); nothing was cleared — re-read ` +
            `chatops-status and clear the fence you actually mean`,
        );
      }
      // Whatever the transaction itself reads is the only fence that may be
      // deleted: `build` runs inside it, after the write lock was taken.
      const conflict: { fence: ChatOpsFenceRecord | null } = { fence: null };
      const applied = await store.commitCompareAndSwap(scope, (_rows, fences) => {
        const current = parsed.grain === "session" ? fences.session : fences.issue;
        if (current === null || !sameFence(current, observed)) {
          conflict.fence = current;
          return null;
        }
        return { fence: { grain: parsed.grain, record: null } };
      });
      if (!applied) {
        die(
          `the ${parsed.grain}-grain fence changed while it was being cleared ` +
            `(${describeFence(conflict.fence)} is recorded now, not ${describeFence(observed)}); ` +
            `nothing was cleared — a concurrent pass fenced this scope, so re-read ` +
            `chatops-status before deciding again`,
        );
      }
      emit({
        ok: true,
        action: "clear-fence",
        grain: parsed.grain,
        ...(parsed.grain === "issue" ? { issueNumber: scope.issueNumber } : {}),
        cleared: true,
        fence: { reason: observed.reason, fencedAt: observed.fencedAt },
        // Rows the fence moved to `ambiguous` stay there: clearing the fence
        // re-opens the scope for new work, it does not decide what happened to a
        // command already parked. Each of those still needs --resolve or --retry.
        note: "rows already moved to ambiguous still require --resolve or --retry",
      });
      return;
    }

    const commentId = parsed.commentId as string;
    const state = await store.loadScope(scope);
    const row = state.rows.find((candidate) => candidate.commentId === commentId);
    if (!row) die(`no ChatOps ledger row for comment ${commentId} on issue #${scope.issueNumber}`);

    // `build` runs inside the store's transaction, so what it decided is carried
    // back out through a holder rather than through a `let` the compiler cannot
    // narrow afterwards — the same shape the bounded pass uses.
    const settled: {
      current: ChatOpsLedgerRow | undefined;
      transition: { row: number; next: ChatOpsLedgerRow } | null;
      outcome: ChatOpsPublicOutcome | null;
    } = { current: undefined, transition: null, outcome: null };

    if (parsed.retry) {
      const event = {
        kind: "operator-retry" as const,
        operator: parsed.operator as string,
        reason: parsed.reason as string,
      };
      // Validated against the row that was read, so a state the ledger simply
      // refuses is reported as a refusal rather than as a lost race.
      const preflight = applyChatOpsLedgerEvent(row, event, commentId);
      if (!preflight.applied) {
        die(`retry refused (row ${preflight.row}, ${preflight.refusal.reason}): ${preflight.refusal.detail}`);
      }
      // Compare-and-swap against the row the transaction itself reads: two
      // operators can authorize a retry from the same reading, and an
      // unconditional upsert would let the later one silently discard the
      // operator and reason the earlier one recorded. The transition is re-applied
      // to the persisted row so anything a concurrent pass folded in (evidence)
      // survives.
      const applied = await store.commitCompareAndSwap(scope, (persisted) => {
        settled.transition = null;
        const current = persisted.find((candidate) => candidate.commentId === commentId);
        settled.current = current;
        if (current === undefined || !sameChatOpsLedgerVersion(current, row)) return null;
        const transition = applyChatOpsLedgerEvent(current, event, commentId);
        if (!transition.applied) return null;
        settled.transition = { row: transition.row, next: transition.next };
        return { rows: [transition.next] };
      });
      const committed = settled.transition;
      if (!applied || committed === null) die(describeStaleRow("retry", commentId, row, settled.current));
      emit({
        ok: true,
        action: "retry",
        issueNumber: scope.issueNumber,
        commentId,
        row: committed.row,
        state: committed.next.state,
      });
      return;
    }

    // --resolve: ledger row 21. The operator supplies only the three-valued
    // outcome and their identity — never a summary — so the published text is
    // this document's fixed row-21 sentence, rendered and enqueued in the same
    // transaction as the transition that produces the disposition (§7.1, §10.1).
    const outcome = parsed.outcome as ChatOpsMarkerOutcome;
    const event = {
      kind: "operator-resolve" as const,
      outcome,
      operator: parsed.operator as string,
    };
    // As with --retry: a state the ledger refuses outright is a refusal, decided
    // against the row the operator read, not a lost race.
    const preflight = applyChatOpsLedgerEvent(row, event, commentId);
    if (!preflight.applied) {
      die(`resolve refused (row ${preflight.row}, ${preflight.refusal.reason}): ${preflight.refusal.detail}`);
    }
    // Compare-and-swap for the same reason --retry does, and with one extra
    // consequence: the summary effect below is keyed on the ledger row this
    // transition produces, so the outbox retains whichever caller enqueued it
    // first. A second, unconditional write would change the durable outcome while
    // the published text still describes the first — the published summary and
    // the ledger disagreeing is precisely what this refuses.
    //
    // Everything the effect carries is a pure function of the persisted row, so
    // it is built inside the transaction alongside the transition it describes.
    const redactionPaths = sessionRedactionPaths(session);
    const applied = await store.commitCompareAndSwap(scope, (persisted) => {
      settled.transition = null;
      settled.outcome = null;
      const current = persisted.find((candidate) => candidate.commentId === commentId);
      settled.current = current;
      if (current === undefined || !sameChatOpsLedgerVersion(current, row)) return null;
      const transition = applyChatOpsLedgerEvent(current, event, commentId);
      if (!transition.applied) return null;
      const publicOutcome = chatOpsOperatorResolvedOutcome(
        outcome,
        transition.next.attempts,
        redactionPaths,
      );
      const payload: WorkItemCommentPayload = {
        topic: "workitem:comment",
        provider: identity.provider,
        owner: identity.providerOwner,
        repo: identity.providerRepo,
        issueNumber: scope.issueNumber,
        body: enforceCommentVisibility("work-item", renderChatOpsSummaryComment(publicOutcome), {
          configuredPaths: redactionPaths,
          maxChars: DEFAULT_COMMENT_MAX_CHARS,
        }),
      };
      const audit: ChatOpsAuditRecord = {
        requestId: null,
        surface: "chatops",
        actorId: parsed.operator as string,
        operationId: null,
        ledgerScope: { identity: identityKey, issueNumber: scope.issueNumber, commentId },
        row: transition.row,
        kind: publicOutcome.kind,
        dispatched: publicOutcome.dispatched,
        reason: publicOutcome.reason,
      };
      const commit: ChatOpsCommitInput = {
        rows: [transition.next],
        audit: [audit],
        effects: [
          {
            idempotencyKey: makeOutboxKey(
              identityKey,
              scope.issueNumber,
              "chatops-summary",
              commentId,
              String(transition.row),
            ),
            topic: "workitem:comment",
            payload,
          },
        ],
      };
      settled.transition = { row: transition.row, next: transition.next };
      settled.outcome = publicOutcome;
      return commit;
    });
    const committed = settled.transition;
    const publicOutcome = settled.outcome;
    if (!applied || committed === null || publicOutcome === null) {
      die(describeStaleRow("resolve", commentId, row, settled.current));
    }
    emit({
      ok: true,
      action: "resolve",
      issueNumber: scope.issueNumber,
      commentId,
      row: committed.row,
      state: committed.next.state,
      kind: publicOutcome.kind,
      dispatched: publicOutcome.dispatched,
      reason: publicOutcome.reason,
      // The marker itself is posted by the next `chatops-scan` pass, which owns
      // rows 17-19 and their bounded retry budget. Nothing here talks to a provider.
      note: "the acknowledgement marker is published by the next chatops-scan pass",
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
