// ---------------------------------------------------------------------------
// Provider-neutral runtime quality resolution (issue #905).
//
// This is slice B2 of docs/agent-runtime-profiles-contract.md §14.1: "Quality
// levels, compatibility mapping, per-phase-class resolution, persistence on the
// task — pure resolution plus one intake write. Still not consumed by any
// lane." Landing it changes no invocation: every lane inventoried in §1.2 keeps
// resolving model/effort/budget from its own chain, and B3 is where the
// adapters start reading what this module resolves.
//
// What it owns, and nothing else:
//
//   - **The four levels as a request** (§5). `QualityLevel` is imported from
//     the B1 catalog module rather than restated, so there is exactly one
//     spelling of the vocabulary. A level is ordered against the other three
//     *within a provider*; it never names a model or a provider effort value,
//     which is why no provider effort string (`low`, `medium`, `high`,
//     `xhigh`, `max`) and no model name appears anywhere below.
//   - **The compatibility mapping** (§10.1) from the `complexity:*` and
//     `review:*` label families onto those levels, preserving today's
//     strongest-wins rule and today's "explicit review label beats a
//     complexity-derived one" precedence.
//   - **Per-phase-class resolution** (§10.2). Two classes exist only to pick
//     which requested quality a phase reads; neither selects a catalog entry.
//   - **The intake snapshot** (§9.3). The request is resolved once, from the
//     labels intake already trusted, and persisted on the task so relabelling
//     an Issue never moves a task already in flight.
//   - **Escalation as a floor** (§10.3). The review loop raises quality; it
//     never lowers a request that already meets the floor.
//
// Three things this module deliberately does NOT do:
//
//   - **It never reads the catalog.** Resolving a request is independent of
//     which provider will answer it and of what that provider can do — that is
//     the whole point of a provider-neutral vocabulary. No capability is
//     consulted, no ceiling is applied, and a level that a provider answers
//     with a profile shared with another level is §6.3's *declared* binding,
//     decided at catalog load, not here.
//   - **It never reads untrusted input** (§8.3). Labels, trusted session
//     config, and an explicit operator pin are the only inputs. An Issue body,
//     a comment, or agent output cannot raise or lower a request.
//   - **It never silently repairs a bad request** (§12.3). A `quality:` label
//     the vocabulary does not contain, two `quality:` labels naming different
//     levels, a malformed pin, or a malformed persisted snapshot is an
//     `invalid-quality-request` refusal. The one exception is deliberate and
//     inherited: `review:xhigh` and any other unrecognized member of the two
//     *compatibility* families keeps today's "not a recognized label" meaning
//     and is ignored (§10.1), because those two families predate this contract
//     and their unrecognized spellings already mean nothing.
// ---------------------------------------------------------------------------

import type { AgentProfileRefusalReason, QualityLevel } from "./agent-profile-catalog.js";
import { QUALITY_LEVELS } from "./agent-profile-catalog.js";
import type { DisputeTurnKind, EvidenceCollectionParty } from "./review-dispute-turn.js";
import type { AiTask, TaskPhase } from "./task.js";

// ---------------------------------------------------------------------------
// Vocabularies (§14.3 — provider-neutral, closed, owned by this contract)
// ---------------------------------------------------------------------------

/** Task-context key under which the intake-resolved quality request is persisted (§9.3). */
export const QUALITY_CONTEXT_KEY = "requestedQuality";

/**
 * Task-context key under which an explicit operator quality pin lives (§8.2
 * layer 1). Nothing in this slice writes it — the operator command that does is
 * B4's — but resolution honors it wherever it appears, so a pin written later
 * outranks the intake snapshot without rewriting the snapshot.
 */
export const QUALITY_PIN_CONTEXT_KEY = "qualityPin";

/** The canonical, forward-looking label namespace (§10.1). */
export const QUALITY_LABEL_PREFIX = "quality:";

/** The two phase classes of §10.2. */
export const PHASE_CLASSES = ["implementation-class", "review-class"] as const;

export type PhaseClass = (typeof PHASE_CLASSES)[number];

/** The `qualitySource` values §13.2 records for a persisted request (§8.2). */
export const QUALITY_SOURCES = [
  "task-pin",
  "label",
  "compat-label",
  "session-config",
  "default",
] as const;

export type QualitySource = (typeof QUALITY_SOURCES)[number];

/**
 * What a *run* resolved, which is the persisted request unless a review-loop
 * escalation floor raised it (§10.3). `escalation` exists only here: it is a
 * property of one run, never of the task's persisted request.
 */
export type EffectiveQualitySource = QualitySource | "escalation";

/** The level that applies when nothing asks for another one (§8.2 layer 5). */
export const DEFAULT_REQUESTED_QUALITY: QualityLevel = "normal";

/**
 * The floor the review loop raises to on the penultimate fix cycle, the
 * provider-neutral spelling of today's `escalatedEffort` (§10.3).
 *
 * It is a *floor*, not a target: a request that already meets or exceeds it is
 * untouched, exactly as today's effort-rank guard refuses to lower a stronger
 * label-derived effort. Which concrete settings that floor buys is the
 * provider's binding to answer at cutover — B3 carries the before/after table,
 * because "raise effort without raising model" is expressible in today's
 * per-lane chain and is a binding change under this contract.
 */
export const REVIEW_LOOP_ESCALATION_QUALITY: QualityLevel = "strong";

/**
 * A refusal from the resolution-time gate (§12.1's second gate). Load-time
 * catalog refusals stay `AgentProfileCatalogError`; both draw their `reason`
 * from §12.2's single closed set, so an operator sees one refusal vocabulary
 * whichever gate fired.
 */
export class AgentQualityError extends Error {
  readonly reason: AgentProfileRefusalReason;
  readonly path?: string;

  constructor(reason: AgentProfileRefusalReason, message: string, path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "AgentQualityError";
    this.reason = reason;
    if (path !== undefined) this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Ordering (§5) — within a provider, never across providers
// ---------------------------------------------------------------------------

const QUALITY_RANK: ReadonlyMap<QualityLevel, number> = new Map(
  QUALITY_LEVELS.map((level, index) => [level, index] as const),
);

const QUALITY_LEVEL_SET: ReadonlySet<string> = new Set<string>(QUALITY_LEVELS);

/** Narrows an arbitrary value to one of the four levels. */
export function isQualityLevel(value: unknown): value is QualityLevel {
  return typeof value === "string" && QUALITY_LEVEL_SET.has(value);
}

/** Rank of a level in `light < normal < strong < maximum`, weakest first. */
export function qualityRank(level: QualityLevel): number {
  return QUALITY_RANK.get(level) ?? 0;
}

/** Negative when `a` is weaker than `b`, positive when stronger, 0 when equal. */
export function compareQuality(a: QualityLevel, b: QualityLevel): number {
  return qualityRank(a) - qualityRank(b);
}

/** The stronger of two levels; ties return the first, since they are equal. */
export function strongerQuality(a: QualityLevel, b: QualityLevel): QualityLevel {
  return compareQuality(b, a) > 0 ? b : a;
}

// ---------------------------------------------------------------------------
// The compatibility mapping (§10.1)
// ---------------------------------------------------------------------------

/**
 * `complexity:*` -> quality, strongest first so the first match wins. This
 * preserves today's `xhigh > high > low` rule (`resolveComplexityTier`,
 * src/core/github-intake.ts) rather than restating it differently.
 *
 * A label absent from this table — including a misspelled one — contributes
 * nothing, which is today's meaning of an unrecognized complexity label.
 */
const COMPLEXITY_LABEL_QUALITY: ReadonlyArray<readonly [string, QualityLevel]> = [
  ["complexity:xhigh", "maximum"],
  ["complexity:high", "strong"],
  ["complexity:low", "light"],
];

/**
 * `review:*` -> quality, strongest first, same rule. `review:xhigh` is absent
 * on purpose: §10.1 keeps it unrecognized as a *label*, so it falls through to
 * the complexity-derived answer exactly as it does today. Its intent now has a
 * supported spelling, `quality:maximum`.
 */
const REVIEW_LABEL_QUALITY: ReadonlyArray<readonly [string, QualityLevel]> = [
  ["review:high", "strong"],
  ["review:medium", "normal"],
  ["review:low", "light"],
];

function matchLabelTable(
  table: ReadonlyArray<readonly [string, QualityLevel]>,
  labels: ReadonlySet<string>,
): { quality: QualityLevel; label: string } | undefined {
  for (const [label, quality] of table) {
    if (labels.has(label)) return { quality, label };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Phase classes (§10.2)
// ---------------------------------------------------------------------------

/**
 * Which requested quality each phase reads. Typed as a total record so adding a
 * `TaskPhase` is a compile error until its class is decided — a phase silently
 * defaulting to the implementation-class request is exactly the kind of
 * unowned decision this contract exists to remove.
 *
 * Review-class is the judging work: the review phase and the content lane's
 * review. Everything else produces work, including the planner and the
 * refinement lane, whose output is the input to an implementation.
 */
const PHASE_CLASS_BY_PHASE: Readonly<Record<TaskPhase, PhaseClass>> = {
  implementation: "implementation-class",
  review: "review-class",
  conflict_resolution: "implementation-class",
  research: "implementation-class",
  content_research: "implementation-class",
  content_draft: "implementation-class",
  content_review: "review-class",
  planner: "implementation-class",
  refinement: "implementation-class",
};

/** The class whose requested quality a phase reads (§10.2). */
export function phaseClassForPhase(phase: TaskPhase): PhaseClass {
  return PHASE_CLASS_BY_PHASE[phase];
}

/**
 * The class a review-dispute sub-turn reads (§10.2: "the dispute sub-turns
 * that produce work" versus "the dispute sub-turns that judge work").
 *
 * `undefined` means the turn runs no agent at all — a human handoff, an
 * unresolvable state, or "no protocol turn exists" — so there is no quality to
 * resolve for it. `evidence_collection` is per party and therefore requires
 * one: asking for its class without naming the party is a refusal rather than
 * a guess, because the two parties sit on opposite sides of the class split.
 */
export function phaseClassForDisputeTurn(
  kind: DisputeTurnKind,
  party?: EvidenceCollectionParty,
): PhaseClass | undefined {
  switch (kind) {
    case "implementer_fix":
      return "implementation-class";
    case "reviewer_reconsideration":
    case "re_review":
    // Arbitration judges one contested finding. The runner advances it, but the
    // arbiter run it dispatches is judging work, so it reads the review-class
    // request like every other judging turn.
    case "runner_arbitration":
      return "review-class";
    case "evidence_collection":
      if (party === undefined) {
        throw new AgentQualityError(
          "invalid-quality-request",
          "evidence_collection is resolved per party; name the implementer or reviewer side",
        );
      }
      return party === "implementer" ? "implementation-class" : "review-class";
    case "human_handoff":
    case "no_turn":
    case "unresolvable":
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The resolved request (§8.2, §9.3, §13.2)
// ---------------------------------------------------------------------------

/** One phase class's answer: the level asked for, and what asked for it. */
export interface RequestedQuality {
  readonly quality: QualityLevel;
  readonly source: QualitySource;
  /** The label that decided it; present only for `label` and `compat-label`. */
  readonly label?: string;
}

/**
 * The intake snapshot persisted under {@link QUALITY_CONTEXT_KEY}: one request
 * per phase class, resolved once from the labels intake trusted (§9.3).
 */
export interface ResolvedTaskQuality {
  readonly implementation: RequestedQuality;
  readonly review: RequestedQuality;
  readonly resolvedAt: string;
}

/**
 * An explicit operator pin (§8.2 layer 1). Either class may be pinned alone;
 * an empty pin is malformed rather than a no-op, because writing one is an
 * explicit action that must mean something.
 */
export interface QualityPin {
  readonly implementation?: QualityLevel;
  readonly review?: QualityLevel;
}

/** Trusted session config this module reads — `ResolvedSession` satisfies it. */
export interface QualitySessionView {
  readonly agentRuntime?: { readonly defaultQuality?: QualityLevel } | undefined;
}

export interface ResolveRequestedQualityInput {
  /** Trusted labels, as intake read them. */
  readonly labels?: readonly string[];
  /** Trusted session config supplying §8.2 layer 4. */
  readonly session?: QualitySessionView | undefined;
  /** An explicit operator pin, when one exists (§8.2 layer 1). */
  readonly pin?: QualityPin | undefined;
  /** ISO timestamp recorded on the snapshot, as the assignment records one. */
  readonly now: string;
}

/**
 * Resolve both phase classes' quality requests from trusted inputs.
 *
 * Precedence per class, highest first (§8.2): an explicit pin, a `quality:`
 * label, the compatibility labels of that class, the session default, then
 * `normal`. A `quality:` label carries no phase-class variant by design — it
 * states the level directly, so it applies to both classes.
 *
 * The review class derives from the complexity family when no `review:*` label
 * is present, which is today's rule (`labelsToReviewStrength`) restated in the
 * neutral vocabulary. The one difference is deliberate and is the point of the
 * vocabulary: `complexity:xhigh` derives `maximum` rather than being pre-capped
 * to what one provider's review CLI accepted in 2026. What that request costs
 * is the provider binding's answer (§6.3), decided in the catalog, not here.
 *
 * Throws {@link AgentQualityError} (`invalid-quality-request`) on a `quality:`
 * label outside the vocabulary, on two `quality:` labels naming different
 * levels, on a malformed pin, and on a malformed session default — never
 * resolving one of those to a nearby level (§12.3).
 */
export function resolveRequestedQuality(input: ResolveRequestedQualityInput): ResolvedTaskQuality {
  const labelSet = new Set(input.labels ?? []);
  const explicit = parseQualityLabels(labelSet);
  const pin = input.pin === undefined ? undefined : canonicalizeQualityPin(input.pin, "quality pin");
  const sessionDefault = readSessionDefaultQuality(input.session);
  return {
    implementation: resolveForClass("implementation-class", labelSet, explicit, pin, sessionDefault),
    review: resolveForClass("review-class", labelSet, explicit, pin, sessionDefault),
    resolvedAt: input.now,
  };
}

function resolveForClass(
  phaseClass: PhaseClass,
  labels: ReadonlySet<string>,
  explicit: { quality: QualityLevel; label: string } | undefined,
  pin: QualityPin | undefined,
  sessionDefault: QualityLevel | undefined,
): RequestedQuality {
  const pinned = pinFor(pin, phaseClass);
  if (pinned !== undefined) return { quality: pinned, source: "task-pin" };
  if (explicit !== undefined) {
    return { quality: explicit.quality, source: "label", label: explicit.label };
  }
  const compat =
    phaseClass === "review-class"
      ? // An explicit review label wins over a complexity-derived one; with no
        // review label the complexity family decides, as it does today.
        matchLabelTable(REVIEW_LABEL_QUALITY, labels) ?? matchLabelTable(COMPLEXITY_LABEL_QUALITY, labels)
      : matchLabelTable(COMPLEXITY_LABEL_QUALITY, labels);
  if (compat !== undefined) {
    return { quality: compat.quality, source: "compat-label", label: compat.label };
  }
  if (sessionDefault !== undefined) return { quality: sessionDefault, source: "session-config" };
  return { quality: DEFAULT_REQUESTED_QUALITY, source: "default" };
}

function pinFor(pin: QualityPin | undefined, phaseClass: PhaseClass): QualityLevel | undefined {
  if (!pin) return undefined;
  return phaseClass === "review-class" ? pin.review : pin.implementation;
}

/**
 * Read the `quality:<level>` labels out of a trusted label set.
 *
 * Two labels naming the same level are one request stated twice; two naming
 * different levels are a contradiction with no defensible winner — taking the
 * stronger would let a stray label raise cost, taking the weaker would let one
 * lower it — so both are refused.
 */
function parseQualityLabels(
  labels: ReadonlySet<string>,
): { quality: QualityLevel; label: string } | undefined {
  let found: { quality: QualityLevel; label: string } | undefined;
  for (const label of labels) {
    if (!label.startsWith(QUALITY_LABEL_PREFIX)) continue;
    const value = label.slice(QUALITY_LABEL_PREFIX.length);
    if (!isQualityLevel(value)) {
      throw new AgentQualityError(
        "invalid-quality-request",
        `"${label}" does not name a quality level (expected one of ${QUALITY_LEVELS.join(", ")})`,
      );
    }
    if (found !== undefined && found.quality !== value) {
      const [a, b] = [found.label, label].sort();
      throw new AgentQualityError(
        "invalid-quality-request",
        `labels "${a}" and "${b}" request different quality levels; remove one`,
      );
    }
    found = { quality: value, label };
  }
  return found;
}

function readSessionDefaultQuality(session: QualitySessionView | undefined): QualityLevel | undefined {
  const configured = session?.agentRuntime?.defaultQuality;
  if (configured === undefined) return undefined;
  if (!isQualityLevel(configured)) {
    throw new AgentQualityError(
      "invalid-quality-request",
      `"${String(configured)}" does not name a quality level (expected one of ${QUALITY_LEVELS.join(", ")})`,
      "session.agentRuntime.defaultQuality",
    );
  }
  return configured;
}

// ---------------------------------------------------------------------------
// Escalation (§10.3) — a floor, never a target
// ---------------------------------------------------------------------------

/** What one run resolved, and why it differs from the persisted request. */
export interface EffectiveQuality {
  readonly quality: QualityLevel;
  readonly source: EffectiveQualitySource;
  /** The persisted request, unchanged — an escalation never rewrites it. */
  readonly requested: RequestedQuality;
  /** The floor this run was offered, present whether or not it raised anything. */
  readonly escalationFloor?: QualityLevel;
}

/**
 * Apply a review-loop escalation floor to a request.
 *
 * The floor raises and never lowers: a request that already meets or exceeds it
 * is returned with its own source intact, which is the neutral restatement of
 * today's rank guard ("only escalate when it actually raises effort", issue
 * #243). A raise is recorded as `escalation` so the record distinguishes a run
 * the loop pushed up from one the labels asked for, while `requested` keeps the
 * unescalated request the task is still carrying.
 */
export function applyQualityEscalation(
  requested: RequestedQuality,
  floor?: QualityLevel,
): EffectiveQuality {
  if (floor === undefined) {
    return { quality: requested.quality, source: requested.source, requested };
  }
  if (!isQualityLevel(floor)) {
    throw new AgentQualityError(
      "invalid-quality-request",
      `"${String(floor)}" does not name a quality level (expected one of ${QUALITY_LEVELS.join(", ")})`,
      "escalation floor",
    );
  }
  if (compareQuality(floor, requested.quality) <= 0) {
    return { quality: requested.quality, source: requested.source, requested, escalationFloor: floor };
  }
  return { quality: floor, source: "escalation", requested, escalationFloor: floor };
}

// ---------------------------------------------------------------------------
// Persistence on the task (§9.3)
// ---------------------------------------------------------------------------

/**
 * Read the intake-resolved snapshot from task context.
 *
 * Absent is not an error: tasks created before this slice carry no snapshot,
 * and {@link qualityForPhaseClass} resolves those from the labels intake
 * already persisted. Present-but-malformed IS an error — something wrote a
 * request nobody can read, and resolving it as "normal" would be the silent
 * downgrade §12.3 forbids.
 */
export function readResolvedQuality(task: AiTask): ResolvedTaskQuality | undefined {
  const raw = task.context[QUALITY_CONTEXT_KEY];
  if (raw === undefined || raw === null) return undefined;
  const path = `context.${QUALITY_CONTEXT_KEY}`;
  const record = requireRecord(raw, path);
  const resolvedAt = record["resolvedAt"];
  if (typeof resolvedAt !== "string" || resolvedAt.length === 0) {
    throw new AgentQualityError("invalid-quality-request", "resolvedAt must be a non-empty string", path);
  }
  return {
    implementation: requireRequestedQuality(record["implementation"], `${path}.implementation`),
    review: requireRequestedQuality(record["review"], `${path}.review`),
    resolvedAt,
  };
}

/**
 * Read an explicit operator pin from task context, if one was written. Absent
 * is the normal case; malformed is a refusal, for the same reason a malformed
 * snapshot is.
 */
export function readQualityPin(task: AiTask): QualityPin | undefined {
  const raw = task.context[QUALITY_PIN_CONTEXT_KEY];
  if (raw === undefined || raw === null) return undefined;
  return canonicalizeQualityPin(raw, `context.${QUALITY_PIN_CONTEXT_KEY}`);
}

export interface QualityForPhaseOptions {
  /** A review-loop escalation floor for this run only (§10.3). */
  readonly escalationFloor?: QualityLevel | undefined;
  /**
   * Labels to resolve from when the task carries no snapshot. Defaults to the
   * trusted `context.labels` intake persisted, so a pre-B2 task resolves from
   * the same labels a post-B2 one snapshotted rather than falling to `normal`.
   */
  readonly fallbackLabels?: readonly string[] | undefined;
}

/**
 * The quality one run of a phase class resolves: an operator pin if one exists,
 * otherwise the intake snapshot, otherwise a fresh resolution from the labels
 * the task carries — then the escalation floor, which can only raise it.
 *
 * The pin is read live rather than baked into the snapshot because it is an
 * explicit operator action that must take effect on a task already in flight;
 * everything else is snapshotted precisely so it cannot move under a running
 * task (§9.3).
 */
export function qualityForPhaseClass(
  task: AiTask,
  session: QualitySessionView | undefined,
  phaseClass: PhaseClass,
  options: QualityForPhaseOptions = {},
): EffectiveQuality {
  const key = phaseClass === "review-class" ? "review" : "implementation";
  const pinned = pinFor(readQualityPin(task), phaseClass);
  const snapshot = pinned === undefined ? readResolvedQuality(task) : undefined;
  const requested: RequestedQuality =
    pinned !== undefined
      ? { quality: pinned, source: "task-pin" }
      : snapshot !== undefined
      ? snapshot[key]
      : resolveRequestedQuality({
          labels: options.fallbackLabels ?? labelsFromContext(task),
          session,
          now: task.createdAt,
        })[key];
  return applyQualityEscalation(requested, options.escalationFloor);
}

/** {@link qualityForPhaseClass} for a phase, via §10.2's phase-to-class map. */
export function qualityForPhase(
  task: AiTask,
  session: QualitySessionView | undefined,
  phase: TaskPhase,
  options: QualityForPhaseOptions = {},
): EffectiveQuality {
  return qualityForPhaseClass(task, session, phaseClassForPhase(phase), options);
}

function labelsFromContext(task: AiTask): readonly string[] {
  const raw = task.context["labels"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((label): label is string => typeof label === "string");
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireRecord(raw: unknown, path: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentQualityError("invalid-quality-request", "must be an object", path);
  }
  return raw as Record<string, unknown>;
}

function requireRequestedQuality(raw: unknown, path: string): RequestedQuality {
  const record = requireRecord(raw, path);
  const quality = record["quality"];
  if (!isQualityLevel(quality)) {
    throw new AgentQualityError(
      "invalid-quality-request",
      `quality must be one of ${QUALITY_LEVELS.join(", ")}`,
      path,
    );
  }
  const source = record["source"];
  if (typeof source !== "string" || !(QUALITY_SOURCES as readonly string[]).includes(source)) {
    throw new AgentQualityError(
      "invalid-quality-request",
      `source must be one of ${QUALITY_SOURCES.join(", ")}`,
      path,
    );
  }
  const label = record["label"];
  if (label !== undefined && typeof label !== "string") {
    throw new AgentQualityError("invalid-quality-request", "label must be a string when present", path);
  }
  return {
    quality,
    source: source as QualitySource,
    ...(typeof label === "string" ? { label } : {}),
  };
}

/**
 * Validate a pin from any source and return the canonical projection. An empty
 * pin refuses: it was written by an explicit operator action, so "pins
 * nothing" is a mistake to surface, not an intent to honor.
 */
function canonicalizeQualityPin(raw: unknown, path: string): QualityPin {
  const record = requireRecord(raw, path);
  const pin: { implementation?: QualityLevel; review?: QualityLevel } = {};
  for (const key of ["implementation", "review"] as const) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (!isQualityLevel(value)) {
      throw new AgentQualityError(
        "invalid-quality-request",
        `${key} must be one of ${QUALITY_LEVELS.join(", ")}`,
        path,
      );
    }
    pin[key] = value;
  }
  for (const key of Object.keys(record)) {
    if (key !== "implementation" && key !== "review") {
      throw new AgentQualityError("invalid-quality-request", `unknown key "${key}"`, path);
    }
  }
  if (pin.implementation === undefined && pin.review === undefined) {
    throw new AgentQualityError(
      "invalid-quality-request",
      "pins no phase class; set implementation, review, or both",
      path,
    );
  }
  return pin;
}
