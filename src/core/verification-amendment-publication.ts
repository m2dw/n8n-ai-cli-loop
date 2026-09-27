/**
 * Issue #1044: the PUBLIC projection of an applied verification amendment
 * (docs/verification-amendment-contract.md §12.2, §15 slice A7).
 *
 * Issues #1038–#1043 made a task-scoped verification amendment a durable,
 * auditable, effective thing: an append-only revision chain, a plan checkpoint,
 * a `verification.amendment.applied` task event, a requirement gate that reads
 * the amended plan, and a §9.2 continuation. What none of them did is tell a
 * READER OF THE ISSUE that any of it happened. That gap is the specific failure
 * this contract exists to prevent (§12.2): a verification a human believed the
 * loop still runs can be retired by an operator, and the final human gate would
 * present a clean pass over a plan nobody outside the database ever saw change.
 *
 * This module is a RENDERER over the shipped revision record, and nothing else:
 *
 *  - **It projects a revision that was applied; it decides nothing.** Whether a
 *    revision applies, replays, or refuses belongs to
 *    `core/verification-amendment.ts`; a replay and a refusal never reach this
 *    module, because §12.2 posts nothing for either.
 *  - **The type is the redaction boundary.** {@link VerificationAmendmentComment}
 *    carries only what §12.2 permits — the ordinal, the operation kinds with
 *    their affected command names, the operator-authored reason, the resulting
 *    active and retired command names, the continuation, and the plan digest.
 *    Run identifiers, artifact and worktree paths, verification OUTPUT, actor
 *    ids, session ids, and #917 refusal details are absent from the type, so no
 *    later edit to the renderer can publish one by accident.
 *  - **Names are operator-authored.** An execution slot publishes the name the
 *    operator gave it; a requirement slot publishes its command bytes, which are
 *    the Issue's own verification section (or an operator's correction of it)
 *    and are already public. The caller still passes the rendered body through
 *    `sanitizeBody`, so a configured local path inside either is redacted.
 *  - **It has no value imports.** Everything here is a pure function over
 *    structurally-typed input, which is what lets the persistence slice import
 *    it to build the comment inside the amendment's own transaction without
 *    closing an import cycle back through the plan resolver.
 *
 * Delivery, ordering, and idempotency belong to the outbox: one append-only
 * comment per applied revision, keyed on `revisionId` plus this projection's
 * fixed version (see {@link verificationAmendmentCommentIdempotencyKey}) and on
 * no run identifier at all, enqueued in the same transaction as the revision it
 * publishes. A retry re-derives the same key and the outbox dedupes the row.
 */

import { createHash } from "crypto";

import type {
  VerificationAmendmentContinuation,
  VerificationAmendmentLayer,
  VerificationAmendmentOperation,
  VerificationAmendmentRevision,
  VerificationAmendmentSource,
} from "./verification-amendment.js";

// ---------------------------------------------------------------------------
// Projection identity
// ---------------------------------------------------------------------------

/** The literal that marks an outbox row as an amendment comment's. */
export const VERIFICATION_AMENDMENT_COMMENT_PROJECTION = "verification-amendment";

/**
 * The version of THIS projection — the comment, not the revision record.
 *
 * A change that must re-publish already-applied revisions bumps it; a change
 * that only rewords an existing comment must not, or every revision applied
 * after the rewording would post a second comment saying the same thing.
 */
export const VERIFICATION_AMENDMENT_COMMENT_VERSION = 1;

/**
 * The idempotency key of one applied revision's comment (§12.2).
 *
 * Derived from the session, the Issue, this projection's fixed name/version,
 * and the revision's own id — and from nothing else. **No run identifier**, per
 * the established rule: the revision is the thing being published, and the run
 * that happened to carry the operator's command is not part of its identity. A
 * process restart, an operator `outbox retry`, and a re-derived enqueue all
 * recompute this key byte for byte, so the outbox dedupes the second row.
 */
export function verificationAmendmentCommentIdempotencyKey(input: {
  sessionId: string;
  issueNumber: number;
  revisionId: string;
}): string {
  return [
    input.sessionId,
    String(input.issueNumber),
    VERIFICATION_AMENDMENT_COMMENT_PROJECTION,
    `v${VERIFICATION_AMENDMENT_COMMENT_VERSION}`,
    input.revisionId,
  ].join(":");
}

/** The undiscriminated marker every amendment comment opens with. */
export const VERIFICATION_AMENDMENT_COMMENT_MARKER = "<!-- ai-verification-amendment -->";

/**
 * The delivery-side idempotency marker of one amendment comment.
 *
 * The outbox key deduplicates the durable ROW; it says nothing about the
 * external comment. A dispatcher that posts and then loses its claim before
 * `markSent` leaves the row for a later attempt, and a second attempt that just
 * posts appends a duplicate to an append-only history. The marker closes that
 * window from the outside (`hasItemCommentWithMarker` in the dispatcher): a
 * comment already carrying it IS this row's delivery.
 *
 * Hashed rather than embedded because the key carries the session id, which
 * §12.2 never publishes.
 */
export function verificationAmendmentCommentMarker(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16);
  return `<!-- ai-verification-amendment key=${digest} -->`;
}

// ---------------------------------------------------------------------------
// The publishable model
// ---------------------------------------------------------------------------

/**
 * The maximum size of a rendered amendment comment. A backstop rather than the
 * primary bound: every field is a closed-set literal, a digest, a bounded
 * operator string, or a capped list of bounded command labels.
 */
export const MAX_VERIFICATION_AMENDMENT_COMMENT_CHARS = 4000;

/** Longest published command label; longer labels are elided, never wrapped. */
export const MAX_VERIFICATION_AMENDMENT_LABEL_CHARS = 200;

/** Longest published operator reason. */
export const MAX_VERIFICATION_AMENDMENT_PUBLISHED_REASON_CHARS = 500;

/** How many slots one list section names before collapsing into a count. */
export const MAX_VERIFICATION_AMENDMENT_LISTED_SLOTS = 20;

/**
 * One plan slot as the public comment names it.
 *
 * `label` is the operator-facing name of the check: the execution layer's
 * operator-authored name, or the requirement layer's command bytes (which are
 * the Issue's own verification section). `commandId` rides along because a
 * `req:<hash>` identity is the only stable handle an operator has on a
 * requirement slot when they go back to `admin task-verification`.
 */
export interface VerificationAmendmentPublicSlot {
  commandId: string;
  layer: VerificationAmendmentLayer;
  label: string;
  state: "active" | "retired";
}

/**
 * The resulting plan as {@link buildVerificationAmendmentComment} reads it.
 *
 * Structurally typed rather than imported from `core/verification-plan.ts`: an
 * {@link import("./verification-plan.js").EffectiveVerificationPlan} satisfies
 * it as-is, and keeping the dependency structural is what lets the persistence
 * slice import this module without closing a cycle through the resolver.
 */
export interface VerificationAmendmentPlanLike {
  execution: readonly {
    commandId: string;
    name?: string | undefined;
    command: string;
    state: "active" | "retired";
  }[];
  requirement: readonly {
    commandId: string;
    command: string;
    state: "active" | "retired";
  }[];
}

/**
 * Project a resolved plan onto the public slot list §12.2 names.
 *
 * The execution layer publishes its NAME (`exec:build` → `build`) and never its
 * command bytes: an execution command is a session default, which is
 * infrastructure rather than a statement about this Issue, and #918 §11.3's
 * posture keeps it local. The requirement layer publishes its bytes, because
 * those bytes ARE the Issue's verification section and a reader needs to see
 * which of them the amendment changed.
 */
export function verificationAmendmentPublicSlots(
  plan: VerificationAmendmentPlanLike,
): VerificationAmendmentPublicSlot[] {
  return [
    ...plan.execution.map((slot) => ({
      commandId: slot.commandId,
      layer: "execution" as const,
      label: slot.name ?? stripCommandIdPrefix(slot.commandId),
      state: slot.state,
    })),
    ...plan.requirement.map((slot) => ({
      commandId: slot.commandId,
      layer: "requirement" as const,
      label: slot.command,
      state: slot.state,
    })),
  ];
}

/** One operation as the comment names it: the kind, the layer, the label. */
export interface VerificationAmendmentCommentOperation {
  kind: VerificationAmendmentOperation["kind"];
  layer: VerificationAmendmentLayer;
  label: string;
  commandId: string;
}

/** Everything §12.2 permits a comment to carry, and nothing else. */
export interface VerificationAmendmentComment {
  revisionOrdinal: number;
  revisionId: string;
  source: VerificationAmendmentSource;
  reason: string;
  continuation: VerificationAmendmentContinuation;
  planDigest: string;
  operations: readonly VerificationAmendmentCommentOperation[];
  /** The plan this revision produced, split by state (§12.2 "resulting"). */
  active: readonly VerificationAmendmentPublicSlot[];
  retired: readonly VerificationAmendmentPublicSlot[];
  /** §8.4 rules 1/5: a removal and a reinstatement are each named explicitly. */
  retiredByThisRevision: readonly VerificationAmendmentCommentOperation[];
  restoredByThisRevision: readonly VerificationAmendmentCommentOperation[];
}

/** The revision fields the projection reads; a stored revision satisfies it. */
export type VerificationAmendmentRevisionLike = Pick<
  VerificationAmendmentRevision,
  "revisionId" | "revisionOrdinal" | "source" | "reason" | "operations" | "planDigest" | "continuation"
>;

/**
 * Project one APPLIED revision and the plan it produced onto the public model.
 *
 * The operation labels are read out of the RESULTING plan wherever the slot
 * survives in it, so a `replace` publishes the bytes it installed rather than
 * the bytes it superseded — the reader's question is "what does this task check
 * now", and the superseded bytes are in the revision record for the operator
 * who needs them. A slot the plan does not contain (an orphaned identity, §6.4
 * rule 4) falls back to its `commandId`, which is always safe to print.
 */
export function buildVerificationAmendmentComment(input: {
  revision: VerificationAmendmentRevisionLike;
  slots: readonly VerificationAmendmentPublicSlot[];
}): VerificationAmendmentComment {
  const { revision } = input;
  const slots = input.slots.map((slot) => ({
    commandId: slot.commandId,
    layer: slot.layer,
    label: label(slot.label),
    state: slot.state,
  }));
  const byId = new Map(slots.map((slot) => [slot.commandId, slot] as const));

  const operations = revision.operations.map((operation): VerificationAmendmentCommentOperation => {
    if (operation.kind === "add") {
      // An `add` names no `commandId` (the write derives one), so its label is
      // the operator's own input: the name for the execution layer, the bytes
      // for the requirement layer.
      const own = operation.layer === "execution" ? operation.name : operation.command;
      const resolved = matchAddedSlot(slots, operation.layer, own);
      return {
        kind: "add",
        layer: operation.layer,
        label: label(own),
        commandId: resolved?.commandId ?? "",
      };
    }
    const slot = byId.get(operation.commandId);
    return {
      kind: operation.kind,
      layer: slot?.layer ?? layerOfCommandId(operation.commandId),
      label: slot?.label ?? label(operation.commandId),
      commandId: operation.commandId,
    };
  });

  return {
    revisionOrdinal: revision.revisionOrdinal,
    revisionId: revision.revisionId,
    source: revision.source,
    reason: reasonText(revision.reason),
    continuation: revision.continuation,
    planDigest: revision.planDigest,
    operations,
    active: slots.filter((slot) => slot.state === "active"),
    retired: slots.filter((slot) => slot.state === "retired"),
    retiredByThisRevision: operations.filter((operation) => operation.kind === "retire"),
    restoredByThisRevision: operations.filter((operation) => operation.kind === "restore"),
  };
}

// ---------------------------------------------------------------------------
// The rendered comment
// ---------------------------------------------------------------------------

/**
 * §8.4 rule 1, published verbatim: a retirement is never a passing result.
 *
 * Stated of the REQUIREMENT layer only. A retired requirement is genuinely no
 * longer run and no longer gated; a retired execution slot is not (see
 * {@link VERIFICATION_EXECUTION_LAYER_NOT_YET_RUN}).
 */
export const VERIFICATION_RETIREMENT_NOT_A_PASS =
  "⚠️ A retired verification command is **not** a passing result: it is no longer run, "
  + "and no evidence claims it passed.";

/**
 * The truthfulness guard over the execution layer (issue #1044 review).
 *
 * The review lane's Step 4 still executes the raw `session.verification` entries
 * — #918 set resolution does not yet consume the amendment layer — and Step
 * 4.5's requirement gate deliberately credits only what Step 4 ran. So an
 * execution-layer slot an amendment added or replaced is a change to the
 * RECORDED plan and nothing more: it is neither executed by the loop nor
 * credited by the gate. Publishing it as "a check this task now runs" would be
 * the same class of misstatement §12.2 exists to prevent, pointed the other way.
 *
 * A RETIRED execution slot is the same asymmetry pointed the other way again:
 * the retirement is real in the recorded plan and changes nothing about what
 * runs, so a comment that said the slot "is no longer run" would contradict the
 * very summary printed beside it.
 *
 * What that retirement is NOT is a statement that the command ran (issue #1044
 * review, P1). Whether it did depends on the session's own configuration, which
 * this projection deliberately does not carry: a slot whose name
 * `session.verification` lists keeps running and keeps being reported, while a
 * task-local slot an `--add-execution` created under a name that map does not
 * hold was never executed by the loop at all. So the line states the one thing
 * true of both — an amendment does not change what this session executes —
 * rather than crediting an unrun command at the merge gate.
 */
export const VERIFICATION_EXECUTION_LAYER_NOT_YET_RUN =
  "ℹ️ An execution-layer entry is a recorded **plan change**, not a statement about what ran: "
  + "the loop's verification step executes this session's own verification configuration and "
  + "nothing else, so an entry added, replaced or retired here neither starts a command, stops "
  + "one, nor is credited by the requirement gate. A command that session configuration names "
  + "keeps running and keeps being reported as run; one it does not name was never run by the "
  + "loop. Change the session's configuration to change what runs.";

/**
 * The most one mandatory disclosure line spends naming slots inline. The true
 * count always precedes the list, so a bounded list states an overflow rather
 * than shortening the number of removals it reports.
 */
const MAX_VERIFICATION_AMENDMENT_DISCLOSURE_CHARS = 600;

/** Characters a section reserves so its `_(+N more)_` line always fits. */
const OVERFLOW_LINE_RESERVE = 40;

/**
 * Characters a disclosure reserves so its `_(+N more — see …)_` marker always
 * fits, separator included. The marker is ~50 characters plus the digits of a
 * count bounded by the number of operations one revision may carry.
 */
const DISCLOSURE_OVERFLOW_RESERVE = 64;

const CONTINUATION_PHRASES: Record<VerificationAmendmentContinuation, string> = {
  review: "the task was re-queued for a fresh review run against the amended plan",
  implementation: "the task was re-queued into implementation against the amended plan",
  none: "the task stayed where it was; the amendment is recorded only",
};

const SOURCE_PHRASES: Record<VerificationAmendmentSource, string> = {
  "admin-cli": "operator command",
  chatops: "operator ChatOps command",
  "issue-refresh": "re-read of this Issue's verification section",
};

/**
 * Render one append-only amendment comment.
 *
 * A headline, the revision's identity and reason, the operations it applied,
 * and the plan it produced — with every retirement and every restoration named
 * explicitly (§12.2), because a check that quietly stopped running is exactly
 * what a reader of this Issue must not have to discover from a database.
 *
 * The body is assembled as a mandatory HEAD (the revision's identity), a
 * compactable MIDDLE (the plan listings), and a mandatory TAIL (§8.4 rules 1
 * and 5: every removal, every restoration, and the not-a-pass statement). The
 * bound is spent on the middle before the tail's statements (issue #1044
 * review, P2):
 * slicing a finished body to fit would drop precisely the removals this comment
 * exists to publish, and could cut Markdown mid-entry while doing it. Each
 * bounded section states its own overflow, so nothing is dropped silently.
 *
 * The tail is nonetheless allocated BEFORE the middle rather than taken whole
 * (issue #1044 review, P2): four disclosure lines naming long labels at their
 * own inline cap can, on a perfectly valid revision, leave the middle nothing
 * and push the assembled body past the cap — and the old fallback then answered
 * that by reconstructing the comment from head and tail alone, publishing a
 * revision with neither its Operations section nor its resulting plan. So the
 * tail's inline NAME LISTS give way first, down to the count-plus-overflow form
 * each of them already has, and the section headers keep the floor they need to
 * state their own counts. Both halves of the reporting contract survive; only
 * names give way, and only after saying how many were withheld.
 *
 * There is no free-text section, no verification output, no link to anything
 * local, and callers must not append to the returned body.
 */
export function renderVerificationAmendmentComment(
  comment: VerificationAmendmentComment,
  marker: string = VERIFICATION_AMENDMENT_COMMENT_MARKER,
): string {
  const head: string[] = [
    marker,
    `### Verification plan amended — revision ${comment.revisionOrdinal}`,
    "",
    "An operator changed the verification plan of this work item. The resulting plan is",
    "below; each section states what the loop does with the entries it names.",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Revision | ${comment.revisionOrdinal} (\`${cell(comment.revisionId)}\`) |`,
    `| Source | ${SOURCE_PHRASES[comment.source] ?? cell(comment.source)} (\`${cell(comment.source)}\`) |`,
    `| Reason | ${cell(comment.reason)} |`,
    `| Continuation | ${CONTINUATION_PHRASES[comment.continuation] ?? cell(comment.continuation)} (\`${cell(comment.continuation)}\`) |`,
    `| Plan digest | \`${cell(comment.planDigest)}\` |`,
  ];

  // Every disclosure below is split by layer (issue #1044 review, P2). A retired
  // requirement stops being run and stops being gated; a retired EXECUTION slot
  // changes neither, because Step 4 executes the session's configured commands
  // and reads no amendment. Saying "removed a check" of both would let the same
  // comment report one command as passed and as no-longer-run at once.
  //
  // The execution half says only that session execution is UNCHANGED, and never
  // that the retired entry still runs (issue #1044 review, P1): whether it runs
  // depends on the session configuration this projection does not carry, and a
  // task-local `--add-execution` slot the configuration never held was not run
  // at all. Claiming otherwise would credit an unrun check at merge time.
  const removedChecks = comment.retiredByThisRevision.filter((op) => op.layer === "requirement");
  const removedExecution = comment.retiredByThisRevision.filter((op) => op.layer === "execution");
  // A restoration is split the same way, and for the symmetric reason (issue
  // #1044 review, P2): retiring an execution slot never stopped anything, so
  // restoring one starts nothing either — it changes the recorded plan and
  // nothing about what runs. Calling it a "restored check" beside the line that
  // says execution-layer entries do not control Step 4 would make this comment
  // report the same entry two contradictory ways.
  const restoredChecks = comment.restoredByThisRevision.filter((op) => op.layer === "requirement");
  const restoredExecution = comment.restoredByThisRevision.filter((op) => op.layer === "execution");
  const retiredRequirement = comment.retired.filter((slot) => slot.layer === "requirement");
  const retiredExecution = comment.retired.filter((slot) => slot.layer === "execution");

  // Each disclosure is a PREFIX (the count, which is always the true one) plus
  // an inline name list, so the allocator below can shorten the names without
  // touching the statement they belong to.
  const disclosures: DisclosureSpec[] = [];
  if (removedChecks.length > 0) {
    disclosures.push({
      prefix: `**This revision removed ${removedChecks.length} check(s):** `,
      operations: removedChecks,
    });
  }
  if (removedExecution.length > 0) {
    disclosures.push({
      prefix:
        `**This revision retired ${removedExecution.length} execution-layer entry(ies) in the `
        + `recorded plan — what this session executes is unchanged:** `,
      operations: removedExecution,
    });
  }
  if (restoredChecks.length > 0) {
    disclosures.push({
      prefix: `**This revision restored ${restoredChecks.length} check(s):** `,
      operations: restoredChecks,
    });
  }
  if (restoredExecution.length > 0) {
    disclosures.push({
      prefix:
        `**This revision restored ${restoredExecution.length} execution-layer entry(ies) in the `
        + `recorded plan — what this session executes is unchanged:** `,
      operations: restoredExecution,
    });
  }

  // The two fixed statements are constant-size and always survive whole.
  const notices: string[] = [];
  if (retiredRequirement.length > 0) {
    notices.push("", VERIFICATION_RETIREMENT_NOT_A_PASS);
  }
  if (touchesExecutionLayer(comment)) {
    notices.push("", VERIFICATION_EXECUTION_LAYER_NOT_YET_RUN);
  }

  // The active plan is split by layer because the two layers make different
  // statements: a requirement entry is what the review gate blocks on, while an
  // execution entry is only recorded (see
  // {@link VERIFICATION_EXECUTION_LAYER_NOT_YET_RUN}). A single "checks this
  // task now runs" list would present a task-local execution addition as a
  // check the loop had started running, which is not true today.
  const activeRequirement = comment.active.filter((slot) => slot.layer === "requirement");
  const activeExecution = comment.active.filter((slot) => slot.layer === "execution");
  const slotBullet = (slot: VerificationAmendmentPublicSlot): string =>
    `${slot.layer} \`${cell(slot.label)}\``;

  // Emitted in reading order; ALLOCATED in `priority` order, so a plan too large
  // for one comment spends its bound on what is no longer checked first.
  const sections: PlanSectionSpec[] = [
    {
      header: `**Operations (${comment.operations.length})**`,
      items: comment.operations.map(
        (operation) => `\`${cell(operation.kind)}\` — ${operation.layer} \`${cell(operation.label)}\``,
      ),
      empty: "- (none recorded)",
      priority: 1,
    },
  ];
  if (comment.active.length === 0) {
    sections.push({
      header: "**Active plan entries (0)**",
      items: [],
      empty: "- (none — this plan has no active verification command)",
      priority: 2,
    });
  }
  if (activeRequirement.length > 0) {
    sections.push({
      header: `**Required checks in the amended plan (${activeRequirement.length})**`,
      items: activeRequirement.map(slotBullet),
      priority: 2,
    });
  }
  if (activeExecution.length > 0) {
    sections.push({
      header: `**Execution-layer plan entries (${activeExecution.length})**`,
      items: activeExecution.map(slotBullet),
      priority: 3,
    });
  }
  if (retiredRequirement.length > 0) {
    sections.push({
      header: `**Retired — not run, not passed (${retiredRequirement.length})**`,
      items: retiredRequirement.map(slotBullet),
      priority: 0,
    });
  }
  if (retiredExecution.length > 0) {
    sections.push({
      header:
        `**Retired in the recorded plan — session execution unchanged `
        + `(${retiredExecution.length})**`,
      items: retiredExecution.map(slotBullet),
      priority: 0,
    });
  }

  const headChars = charsOf(head) - 1;
  // What the middle needs to state every section header and every per-section
  // overflow count — the floor the disclosures must not eat into, because a
  // section that cannot even print its header is a section the reader never
  // learns exists (issue #1044 review, P2).
  const sectionFloor = sections.reduce((sum, spec) => sum + minimumSectionChars(spec), 0);
  const noticeChars = charsOf(notices);
  const tail = [
    ...allocateDisclosures(
      disclosures,
      Math.max(
        0,
        MAX_VERIFICATION_AMENDMENT_COMMENT_CHARS - headChars - noticeChars - sectionFloor,
      ),
    ),
    ...notices,
  ];
  const middle = allocatePlanSections(
    sections,
    Math.max(0, MAX_VERIFICATION_AMENDMENT_COMMENT_CHARS - headChars - charsOf(tail)),
  );
  const body = [...head, ...middle, ...tail].join("\n");
  if (body.length <= MAX_VERIFICATION_AMENDMENT_COMMENT_CHARS) return body;
  // Unreachable while the head stays bounded (a capped reason plus two digests
  // plus closed-set phrases cannot reach the cap, and the middle and the tail
  // were each allocated to fit inside what the head leaves). If it were ever
  // reached, the HEAD is what gives way and BOTH disclosures and plan sections
  // are kept: they are the reporting contract this comment exists to satisfy.
  const disclosed = [...middle, ...tail].join("\n");
  const keep = MAX_VERIFICATION_AMENDMENT_COMMENT_CHARS - charsOf(middle) - charsOf(tail) - 1;
  return keep > 0
    ? `${head.join("\n").slice(0, keep)}…${disclosed === "" ? "" : `\n${disclosed}`}`
    : disclosed.slice(0, MAX_VERIFICATION_AMENDMENT_COMMENT_CHARS);
}

// ---------------------------------------------------------------------------
// The human-gate / run-metadata projection (§12.2's second reader)
// ---------------------------------------------------------------------------

/**
 * What a run summary says about a task whose verification plan was amended.
 *
 * The same bound as the comment, for the same reason: the human gate is the
 * LAST place a hidden plan change can still do damage, so the summary that asks
 * a human to merge must state that the plan moved, how many times, why the last
 * time, and — above all — what is no longer being checked.
 *
 * Absent when the task carries no revision, so an unamended task's summary is
 * byte-identical to what it was before this projection existed.
 */
export interface VerificationAmendmentGateSummary {
  revisionCount: number;
  latestOrdinal: number;
  latestRevisionId: string;
  latestSource: VerificationAmendmentSource;
  latestReason: string;
  /**
   * The digest of the plan the summary's counts describe.
   *
   * The digest of the RECONCILED plan whenever the caller resolved one, not the
   * latest revision's `planDigest` (issue #1044 review, P2): session defaults
   * can drift after the last amendment, and the review gate then blocks on the
   * live reconciled plan. Publishing the revision's older digest beside counts
   * taken from the live plan would label a plan nobody gated on as the effective
   * one. The revision's digest is the fallback, and only for a caller that
   * resolved no plan at all.
   */
  planDigest: string;
  /**
   * How many REQUIREMENT slots the amended plan reports `retired` — the TRUE
   * total, which {@link retiredLabels} may not name in full.
   *
   * Carried separately because the merge decision is the last point a hidden
   * removal can still do damage (issue #1044 review, P2): a renderer that
   * counted the bounded label list would report `Retired ... (20)` for a plan
   * that retired twenty-five checks, which is exactly the understatement §8.4
   * rule 1 forbids.
   *
   * Requirement-layer only, because this is the count the "not run, not passed"
   * statement is made of. Retiring an execution slot stops nothing running —
   * Step 4 reads the session configuration, not this plan — so it is reported
   * through {@link executionRetiredTotal} instead.
   */
  retiredTotal: number;
  /** Labels of the retired requirement slots, bounded (§8.4 rule 1). */
  retiredLabels: readonly string[];
  /**
   * How many EXECUTION slots the amended plan reports `retired` (issue #1044
   * review, P2). These are retired in the recorded plan and nowhere else: review
   * Step 4 executes the session's own verification configuration and reads no
   * amendment, so the retirement neither stopped a command nor says one ran.
   * Absent on a summary persisted before this field existed.
   */
  executionRetiredTotal?: number;
  /** Labels of the retired execution slots, bounded. */
  executionRetiredLabels?: readonly string[];
  /**
   * Set when this summary was projected for a surface that must not carry the
   * work item's own text (see
   * {@link publicSafeVerificationAmendmentGateSummary}). The counts are intact;
   * the names and the operator's reason are not present, and a renderer says so
   * rather than printing an empty list.
   */
  namesWithheld?: boolean;
  /**
   * Every active slot of the amended plan, both layers. Kept as the total it
   * always was; a renderer that must state what the review actually gated on
   * reads {@link activeRequirementCount} instead.
   */
  activeCount: number;
  /**
   * How many active REQUIREMENT slots the amended plan holds — the checks Step
   * 4.5's gate blocks on, and the only count that may be presented beside a
   * verification pass as "active check(s)" (issue #1044 review, P1).
   *
   * Split out because {@link activeCount} lumps in the execution layer, whose
   * amendments are recorded and nothing more: Step 4 still executes this
   * session's configured commands, so an added or replaced execution slot has
   * neither run nor been credited. Counting it as an active check at the merge
   * gate would imply a check ran when it did not. Absent on a summary persisted
   * before the split existed.
   */
  activeRequirementCount?: number;
  /** How many active EXECUTION slots the amended plan records (issue #1044). */
  activeExecutionCount?: number;
  /**
   * Set when ANY revision in the chain operated on the execution layer — added,
   * replaced, retired, restored or annotated one (issue #1044 review, P1).
   *
   * The retirement counts alone do not cover this: an amendment that only ADDS
   * or REPLACES an execution entry retires nothing, so without this flag the
   * gate summary would say the plan changed and never say that the change does
   * not affect what the loop runs.
   */
  executionAmended?: boolean;
}

/** The chain shape the gate projection reads; a stored state satisfies it. */
export interface VerificationAmendmentChainLike {
  revisions: readonly VerificationAmendmentRevisionLike[];
}

/**
 * Project a task's revision chain and its resolved plan onto the run-summary
 * model. Returns `undefined` for a task with no revisions — the summary then
 * says nothing, which is the correct statement about an unamended plan.
 *
 * The plan is optional because not every summary caller resolves one; without
 * it the retirement list is empty and the summary still reports THAT the plan
 * was amended, which is the part that must never be omitted.
 */
export function verificationAmendmentGateSummary(
  chain: VerificationAmendmentChainLike | undefined,
  slots?: readonly VerificationAmendmentPublicSlot[],
  /**
   * The digest of the plan `slots` came from. A caller that resolved a plan
   * MUST pass it: the latest revision's digest describes the plan as of that
   * revision, and a session default that drifted since makes it a different plan
   * from the one the gate read (issue #1044 review, P2).
   */
  effectivePlanDigest?: string,
): VerificationAmendmentGateSummary | undefined {
  if (!chain || chain.revisions.length === 0) return undefined;
  const latest = chain.revisions[chain.revisions.length - 1];
  const retired = (slots ?? []).filter((slot) => slot.state === "retired");
  const retiredRequirement = retired.filter((slot) => slot.layer === "requirement");
  const retiredExecution = retired.filter((slot) => slot.layer === "execution");
  const active = (slots ?? []).filter((slot) => slot.state === "active");
  const bounded = (list: readonly VerificationAmendmentPublicSlot[]): string[] =>
    list.slice(0, MAX_VERIFICATION_AMENDMENT_LISTED_SLOTS).map((slot) => label(slot.label));
  // `add` is the only operation carrying its own layer; every other kind is
  // identified by the `exec:`/`req:` prefix its `commandId` was derived from.
  const executionAmended = chain.revisions.some((revision) =>
    revision.operations.some(
      (operation) =>
        (operation.kind === "add" ? operation.layer : layerOfCommandId(operation.commandId))
        === "execution",
    ),
  );
  return {
    revisionCount: chain.revisions.length,
    latestOrdinal: latest.revisionOrdinal,
    latestRevisionId: latest.revisionId,
    latestSource: latest.source,
    latestReason: reasonText(latest.reason),
    planDigest: effectivePlanDigest ?? latest.planDigest,
    retiredTotal: retiredRequirement.length,
    retiredLabels: bounded(retiredRequirement),
    executionRetiredTotal: retiredExecution.length,
    executionRetiredLabels: bounded(retiredExecution),
    activeCount: active.length,
    activeRequirementCount: active.filter((slot) => slot.layer === "requirement").length,
    activeExecutionCount: active.filter((slot) => slot.layer === "execution").length,
    executionAmended,
  };
}

/** What a public-safe aggregate reports in place of the operator's reason. */
export const VERIFICATION_AMENDMENT_NAMES_WITHHELD_REASON =
  "withheld — this work item is tracked on a separate, private surface from this pull request";

/**
 * The projection of a gate summary for a surface that is not the work item.
 *
 * A split-provider session tracks its work items on a private host and opens its
 * pull requests on a public one (issue #1044 review, P1). The summary's reason
 * and its command labels are work-item text — the operator's own words and, for
 * a requirement slot, the private Issue's verification section — so publishing
 * them on the public PR would disclose exactly what that split exists to keep
 * apart. The COUNTS are not work-item text: that a plan was amended N times and
 * retires M checks is a statement about this repository's automation, and it is
 * the part a merge decision must never be missing.
 *
 * So the aggregate keeps every count, digest and closed-set literal, drops every
 * label, and marks itself {@link VerificationAmendmentGateSummary.namesWithheld}
 * so the renderer states that the names live on the work item rather than
 * printing an empty list beside a non-zero count.
 */
export function publicSafeVerificationAmendmentGateSummary(
  summary: VerificationAmendmentGateSummary,
): VerificationAmendmentGateSummary {
  return {
    revisionCount: summary.revisionCount,
    latestOrdinal: summary.latestOrdinal,
    latestRevisionId: summary.latestRevisionId,
    latestSource: summary.latestSource,
    latestReason: VERIFICATION_AMENDMENT_NAMES_WITHHELD_REASON,
    planDigest: summary.planDigest,
    retiredTotal: summary.retiredTotal ?? summary.retiredLabels.length,
    retiredLabels: [],
    executionRetiredTotal: summary.executionRetiredTotal ?? summary.executionRetiredLabels?.length ?? 0,
    executionRetiredLabels: [],
    namesWithheld: true,
    activeCount: summary.activeCount,
    // Counts and the layer flag are statements about this repository's
    // automation, not work-item text, so the split survives the projection —
    // the merge gate on the public surface must still be able to say which of
    // the active entries the review actually gated on.
    activeRequirementCount: summary.activeRequirementCount,
    activeExecutionCount: summary.activeExecutionCount,
    executionAmended: summary.executionAmended,
  };
}

// ---------------------------------------------------------------------------
// Bounding helpers
// ---------------------------------------------------------------------------

function stripCommandIdPrefix(commandId: string): string {
  const colon = commandId.indexOf(":");
  return colon === -1 ? commandId : commandId.slice(colon + 1);
}

function layerOfCommandId(commandId: string): VerificationAmendmentLayer {
  return commandId.startsWith("exec:") ? "execution" : "requirement";
}

/** A published command label: bounded, single-line, never rewritten otherwise. */
function label(value: string): string {
  const oneLine = value.replace(/\s*\n+\s*/g, " ⏎ ").trim();
  return oneLine.length > MAX_VERIFICATION_AMENDMENT_LABEL_CHARS
    ? `${oneLine.slice(0, MAX_VERIFICATION_AMENDMENT_LABEL_CHARS - 1)}…`
    : oneLine;
}

/**
 * The published form of an operator's own reason: single-line, HTML-inert, and
 * bounded — in that order.
 *
 * The reason is the one operator-authored string BOTH projections render as
 * prose rather than inside a code span: the comment's `| Reason |` cell and the
 * human gate's `- Reason (latest):` line. Markdown passes raw HTML through, so
 * an unmatched `<!--` in it comments out every line either projection appends
 * afterwards — the continuation, the operations, the resulting plan, and the
 * mandatory retirement disclosures §8.4 rule 1 exists to publish — and a reader
 * sees a comment that looks complete while precisely the removals are hidden
 * (issue #1044 review, P1). `sanitizeBody` runs later but redacts paths only,
 * so the escape has to happen here, at the projection both readers share.
 *
 * Escaping `<` is enough and is all that is done: with no `<` to open one, `>`
 * and `&` are ordinary text, and the reader still sees the operator's literal
 * characters. This is `escapeRawHtml`'s guarantee for the HTML channel, inlined
 * rather than imported because that helper reads whole Markdown LINES — a reason
 * opening with a ``` or `~~~` run would be taken for a fence and passed through
 * unescaped — while this value is a fragment embedded mid-document.
 *
 * The bound is applied AFTER escaping so the published string is bounded by the
 * cap the assembler budgets against rather than by up-to-4× that. A cut lands
 * inside an entity at worst, which renders as the literal `&l` it now is; it
 * cannot leave a dangling `<`, because none survives the line above.
 */
function reasonText(value: string): string {
  const oneLine = value.replace(/\s*\n+\s*/g, " ").trim().replace(/</g, "&lt;");
  return oneLine.length > MAX_VERIFICATION_AMENDMENT_PUBLISHED_REASON_CHARS
    ? `${oneLine.slice(0, MAX_VERIFICATION_AMENDMENT_PUBLISHED_REASON_CHARS - 1)}…`
    : oneLine;
}

/**
 * A markdown-table-safe cell: a pipe would end the cell and a backtick would
 * close the code span the renderer opened around it. Neither is rewritten in
 * anything stored, digested, or executed — this is presentation only.
 */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/`/g, "'");
}

/** Does this revision, or the plan it produced, involve the execution layer? */
function touchesExecutionLayer(comment: VerificationAmendmentComment): boolean {
  return (
    comment.operations.some((operation) => operation.layer === "execution")
    || comment.active.some((slot) => slot.layer === "execution")
    || comment.retired.some((slot) => slot.layer === "execution")
  );
}

/**
 * The inline name list of one mandatory disclosure line, bounded in characters
 * by BOTH its own cap and whatever `budget` the assembler can still spare.
 *
 * The COUNT precedes this list and is always the true one, so a bound that
 * elides names never understates how many checks a revision removed.
 */
function inlineLabels(
  operations: readonly VerificationAmendmentCommentOperation[],
  budget: number,
): string {
  const cap = Math.min(MAX_VERIFICATION_AMENDMENT_DISCLOSURE_CHARS, Math.max(0, budget));
  const parts: string[] = [];
  let used = 0;
  for (const [index, operation] of operations.entries()) {
    const part = `\`${cell(operation.label)}\``;
    const cost = parts.length > 0 ? part.length + 2 : part.length;
    // Room for the overflow marker is held back while names remain unnamed, so
    // the list can always say how many it withheld.
    const reserve = index < operations.length - 1 ? DISCLOSURE_OVERFLOW_RESERVE : 0;
    if (used + cost + reserve > cap) break;
    parts.push(part);
    used += cost;
  }
  const overflow = operations.length - parts.length;
  if (overflow > 0) parts.push(`_(+${overflow} more — see \`admin task-verification show\`)_`);
  return parts.join(", ");
}

/** One mandatory disclosure line: an unshortenable count, a shortenable list. */
interface DisclosureSpec {
  prefix: string;
  operations: readonly VerificationAmendmentCommentOperation[];
}

/**
 * The floor one disclosure needs to state its count and its withheld total.
 *
 * The blank line before it, the prefix, its own newline, and the overflow marker
 * that stands in for every name the budget cannot fit.
 */
function minimumDisclosureChars(spec: DisclosureSpec): number {
  return spec.prefix.length + 2 + DISCLOSURE_OVERFLOW_RESERVE;
}

/**
 * Render the mandatory disclosure lines within `budget` characters.
 *
 * Same reservation scheme as {@link allocatePlanSections}: each line may spend
 * what is left after every later line's floor, so an early disclosure with many
 * long labels cannot starve a later one out of stating its count.
 */
function allocateDisclosures(specs: readonly DisclosureSpec[], budget: number): string[] {
  const lines: string[] = [];
  let remaining = budget;
  for (let n = 0; n < specs.length; n++) {
    const spec = specs[n];
    const reserved = specs
      .slice(n + 1)
      .reduce((sum, later) => sum + minimumDisclosureChars(later), 0);
    const line =
      spec.prefix
      + inlineLabels(spec.operations, remaining - reserved - spec.prefix.length - 2);
    lines.push("", line);
    remaining -= line.length + 2;
  }
  return lines;
}

/** One bullet section of the comment's compactable middle. */
interface PlanSectionSpec {
  header: string;
  items: readonly string[];
  /** The line to emit when `items` is empty; the section is dropped without it. */
  empty?: string;
  /** Lower allocates first; 0 is the retirement list, which never gives way. */
  priority: number;
}

/** How many characters one line occupies, including the newline that joins it. */
function charsOf(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

/** The floor a section needs to state its header and its own overflow count. */
function minimumSectionChars(spec: PlanSectionSpec): number {
  return spec.header.length + 2 + (spec.items.length === 0 ? (spec.empty?.length ?? 0) + 1 : OVERFLOW_LINE_RESERVE);
}

/**
 * Render the plan listings within `budget` characters.
 *
 * Sections are ALLOCATED in priority order — what is no longer checked first —
 * and EMITTED in the order they were declared, so a plan too large for one
 * comment compacts the least load-bearing lists rather than whichever ones
 * happen to sort last. Each section reserves enough of the budget for every
 * later section to at least state its header and its overflow count.
 */
function allocatePlanSections(sections: readonly PlanSectionSpec[], budget: number): string[] {
  const rendered: string[][] = sections.map(() => []);
  const order = sections
    .map((_, index) => index)
    .sort((a, b) => sections[a].priority - sections[b].priority || a - b);
  let remaining = budget;
  for (let n = 0; n < order.length; n++) {
    const index = order[n];
    const reserved = order
      .slice(n + 1)
      .reduce((sum, later) => sum + minimumSectionChars(sections[later]), 0);
    const lines = renderPlanSection(sections[index], Math.max(0, remaining - reserved));
    rendered[index] = lines;
    remaining -= charsOf(lines);
  }
  return rendered.flat();
}

/** One section, capped by both the slot cap and the characters it may spend. */
function renderPlanSection(spec: PlanSectionSpec, budget: number): string[] {
  if (spec.items.length === 0) {
    return spec.empty === undefined ? [] : ["", spec.header, spec.empty];
  }
  const lines = ["", spec.header];
  let used = spec.header.length + 2;
  let shown = 0;
  for (const item of spec.items.slice(0, MAX_VERIFICATION_AMENDMENT_LISTED_SLOTS)) {
    const line = `- ${item}`;
    if (used + line.length + 1 + OVERFLOW_LINE_RESERVE > budget) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  const overflow = spec.items.length - shown;
  if (overflow > 0) lines.push(`- _(+${overflow} more)_`);
  return lines;
}

/**
 * Match an `add` operation to the slot it created. The write derives the
 * identity, so the operation carries none; the resulting plan is where it
 * exists. Matched on the layer plus the operator's own input — the name for an
 * execution add, the bytes for a requirement add — which is exactly what §5.1
 * derives the identity from.
 */
function matchAddedSlot(
  slots: readonly VerificationAmendmentPublicSlot[],
  layer: VerificationAmendmentLayer,
  own: string,
): VerificationAmendmentPublicSlot | undefined {
  const wanted = label(own);
  return slots.find((slot) => slot.layer === layer && slot.label === wanted);
}
