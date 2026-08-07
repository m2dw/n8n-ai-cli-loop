import type { AgentId, ImplementationMode, TaskPhase } from "./task.js";

export interface IssueCandidate {
  issueNumber: number;
  title: string;
  url: string;
  labels: string[];
  /** Raw GitHub issue body (markdown). Absent when the issue has no body. */
  body?: string;
  phase: TaskPhase;
  implementationMode?: ImplementationMode;
  implementationAgent?: AgentId;
  reviewAgent?: AgentId;
  researchAgent?: AgentId;
}

/**
 * Maps a set of GitHub labels to a task phase and optional agent assignments.
 * Returns undefined if no intake rule matches.
 */
export function labelsToPhase(
  labels: string[],
): Pick<IssueCandidate, "phase" | "implementationMode" | "implementationAgent" | "reviewAgent" | "researchAgent"> | undefined {
  const set = new Set(labels);

  // ---------------------------------------------------------------------------
  // Assignment vs. labels boundary (issue #292)
  // ---------------------------------------------------------------------------
  // `context.assignment` is the source of truth for which agent owns each phase
  // (implementation / review / conflict_resolution / research). The `agent:*`
  // labels consulted here are only COARSE intake hints and public queue hints:
  // they pick the phase/lane and, at *first* intake, seed the per-phase override
  // that resolveAssignment() persists into `context.assignment`.
  //
  // labelsToPhase deliberately does NOT reconstruct full assignment state for
  // *later* phases. In particular, while routing a review it selects ONLY the
  // review agent — it never derives the implementation owner from the surrounding
  // `agent:*` labels. That ownership lives in
  // `context.assignment.implementationAgent` and is restored from there on a
  // `needs_fix` requeue (see outbox-effects.ts), not inferred from a possibly
  // stale `agent:*` label. Recovering full assignment from labels after DB/task
  // loss is intentionally out of scope here; it would need a dedicated mechanism
  // rather than overloading the coarse `agent:*` labels.

  // Fix lane: an explicit needs-fix re-runs the implementation agent in fix mode.
  if (set.has("status:needs-fix")) {
    if (set.has("agent:claude")) {
      return { phase: "implementation", implementationMode: "fix", implementationAgent: "claude" };
    }
    if (set.has("agent:codex")) {
      return { phase: "implementation", implementationMode: "fix", implementationAgent: "codex" };
    }
    if (set.has("agent:gemini")) {
      return { phase: "implementation", implementationMode: "fix", implementationAgent: "gemini" };
    }
  }

  // Review lane: choose ONLY the review agent from the coarse labels, using the
  // deterministic tie-break gemini > codex > claude. This is a coarse lane
  // hint, NOT assignment reconstruction (issue #292): for any task that already
  // exists, ownership is read from `context.assignment` and intake never
  // re-routes it (enqueueTask returns `already_exists`), so this tie-break only
  // ever decides a brand-new/manually-labelled issue.
  //
  // A genuine `agent:gemini` review wins over a stale `agent:codex` label left
  // behind by a Codex implementation that handed off to a Gemini review (the
  // review lane-swap, issue #264). The exceptions are the stale-lane pairs:
  // `agent:gemini` + `status:research-needed` is a *stale research* marker, and
  // `agent:gemini` + `status:content-needed` is a *stale content-research* marker.
  // Neither is a review assignment. When either marker coexists with a real
  // competing review agent (`agent:codex` OR `agent:claude`), the competing agent
  // keeps the review — a failed/pre-existing research or content-research handoff
  // must not let a stale `agent:gemini` steal a Claude or Codex review (issue
  // #292, #625). With no competing review agent, an explicitly requested Gemini
  // review still wins even if a stale `status:research-needed` or
  // `status:content-needed` lingers.
  //
  // KNOWN, BOUNDED AMBIGUITY (issue #292): `agent:gemini` is now also a valid
  // *implementation* label, so it is no longer unambiguously a review hint. When
  // a Gemini implementation hands off to a Codex/Claude review and `agent:gemini`
  // lingers (failed/slow label removal) beside the new `agent:codex`/`agent:claude`
  // + `status:needs-review`, the label set is identical to a genuine Gemini review
  // with a stale `agent:codex`. Labels cannot distinguish these two readings — the
  // core premise of #292 — so this tie-break keeps Gemini winning by design to
  // preserve #264 (see the locked tests in github-intake-mapping.test.js). The
  // ambiguity is contained, not resolved by labels: the outbox never re-adds an
  // implementation `agent:*` label across review (so our own transitions don't
  // create this state), and a tracked task's reviewer is fixed by
  // `context.assignment.reviewAgent`, never re-derived here. Recovering the true
  // owner from labels after task loss is explicitly out of scope (#292 non-goal).
  if (set.has("status:needs-review")) {
    const geminiReviewWins =
      set.has("agent:gemini") &&
      !((set.has("status:research-needed") || set.has("status:content-needed")) && (set.has("agent:codex") || set.has("agent:claude")));
    if (geminiReviewWins) {
      return { phase: "review", reviewAgent: "gemini" };
    }
    if (set.has("agent:codex")) {
      return { phase: "review", reviewAgent: "codex" };
    }
    if (set.has("agent:claude")) {
      return { phase: "review", reviewAgent: "claude" };
    }
  }

  // Research lane. Checked before the new-implementation lane so the documented
  // research pair (`agent:gemini` + `status:research-needed`) routes to research
  // even when a stale `status:needs-implementation` label still lingers on the
  // issue. Otherwise the Gemini new-implementation rule below would enqueue
  // Gemini to edit code instead of running the research lane (issue #292).
  if (set.has("agent:gemini") && set.has("status:research-needed")) {
    return { phase: "research", researchAgent: "gemini" };
  }

  // Content-research lane. Only gemini is currently supported by the
  // content-research runner. Requiring an explicit `agent:gemini` label ensures
  // no unsupported agent can be routed to this lane via label-driven intake —
  // issues with `status:content-needed` but no supported agent label are not
  // matched, preventing a handler run that would necessarily fail. Checked
  // before new-implementation so a content-needed pair is not misrouted even
  // when a stale `status:needs-implementation` label lingers (same pattern as
  // the research lane above, issue #292).
  if (set.has("agent:gemini") && set.has("status:content-needed")) {
    return { phase: "content_research", researchAgent: "gemini" };
  }

  // New-implementation lane.
  if (set.has("status:needs-implementation")) {
    if (set.has("agent:claude")) {
      return { phase: "implementation", implementationMode: "new", implementationAgent: "claude" };
    }
    if (set.has("agent:codex")) {
      return { phase: "implementation", implementationMode: "new", implementationAgent: "codex" };
    }
    if (set.has("agent:gemini")) {
      return { phase: "implementation", implementationMode: "new", implementationAgent: "gemini" };
    }
  }

  if (set.has("status:needs-conflict-resolution")) {
    // Conflict resolution currently runs through the assignment's
    // conflictResolutionAgent, which is clamped to supported agents.
    return { phase: "conflict_resolution" };
  }
  return undefined;
}

export interface ComplexityProfile {
  model: string;
  effort: string;
  budget: string;
}

/** Complexity tier key, used to look up a per-tier override (issue #748). */
export type ComplexityTier = "low" | "default" | "high" | "xhigh";

/**
 * Session-configurable per-tier overrides for {@link labelsToComplexity}
 * (issue #748). Any field left unset for a tier falls back to that tier's
 * built-in default, so a session can retarget e.g. just the `xhigh` model
 * without restating its effort/budget. Keeps the complexity -> Claude
 * model/effort/budget mapping a config concern rather than a permanent
 * hard-coded assumption: a future model rename is a session-config edit, not
 * a source change.
 */
export type ComplexityProfileOverrides = Partial<Record<ComplexityTier, Partial<ComplexityProfile>>>;

/** Resolves the complexity tier a label set maps to, per the same precedence as {@link labelsToComplexity}. */
export function resolveComplexityTier(labels: string[]): ComplexityTier {
  const set = new Set(labels);
  return set.has("complexity:xhigh")
    ? "xhigh"
    : set.has("complexity:high")
    ? "high"
    : set.has("complexity:low")
    ? "low"
    : "default";
}

/**
 * Maps complexity labels to a Claude model/effort/budget profile.
 *
 * | Label            | Model  | Effort | Budget |
 * |------------------|--------|--------|--------|
 * | complexity:low   | sonnet | low    | $2     |
 * | (no label)       | sonnet | high   | $5     |
 * | complexity:high  | opus   | high   | $10    |
 * | complexity:xhigh | fable  | xhigh  | $20    |
 *
 * When multiple complexity labels are present the strongest wins:
 * `xhigh > high > low`.
 *
 * `complexity:xhigh` selects Fable 5 (`fable`) at `xhigh` effort (issue #857,
 * a follow-up policy correction to #748): #748 moved `xhigh` off Opus 5 (a
 * distilled model, degraded by pushing effort past `high`) onto Fable 5, but
 * capped it at `high` effort — leaving `xhigh` no stronger than
 * `complexity:high`. Since Opus 5 at `high` and Fable 5 at `high` are judged
 * roughly equivalent, `xhigh` now runs Fable 5 at its own `xhigh` effort so
 * the tier is materially stronger than `complexity:high`.
 *
 * `overrides` lets a session retarget any tier's model/effort/budget without
 * a source change (docs: see session `claude.complexityProfiles`).
 */
export function labelsToComplexity(
  labels: string[],
  overrides?: ComplexityProfileOverrides,
): ComplexityProfile {
  const tier = resolveComplexityTier(labels);
  const base: ComplexityProfile =
    tier === "xhigh"
      ? { model: "fable", effort: "xhigh", budget: "20" }
      : tier === "high"
      ? { model: "opus", effort: "high", budget: "10" }
      : tier === "low"
      ? { model: "sonnet", effort: "low", budget: "2" }
      : { model: "sonnet", effort: "high", budget: "5" };
  return { ...base, ...overrides?.[tier] };
}

// NOTE: there is deliberately no "xhigh" review strength. The installed Codex
// CLI's `model_reasoning_effort` config accepts only low/medium/high (xhigh is a
// Claude-only effort tier), so the Codex review path tops out at "high". A
// `review:xhigh` label is therefore NOT a recognized review label: it has no
// effect rather than being silently mapped down to "high" (issue #243 non-goal).
// `complexity:xhigh` still derives the highest Codex-supported strength ("high")
// when no explicit review label is present, matching `complexity:high`.
export type ReviewStrength = "low" | "default" | "high";

/**
 * Resolves review strength in priority order:
 * 1. Explicit review label wins (review:high > review:medium > review:low)
 * 2. Derived from complexity label (complexity:xhigh/high > complexity:low)
 * 3. Default
 *
 * When multiple labels conflict, strongest wins.
 *
 * `complexity:xhigh` maps to the strongest Codex-supported review strength
 * ("high"); Codex has no xhigh reasoning tier, so this is the ceiling, not a
 * silent downgrade of an explicit review label. `review:xhigh` is intentionally
 * unrecognized (see the ReviewStrength note above).
 */
export function labelsToReviewStrength(labels: string[]): {
  strength: ReviewStrength;
  source: "label" | "complexity" | "default";
} {
  const set = new Set(labels);
  if (set.has("review:high")) return { strength: "high", source: "label" };
  if (set.has("review:medium")) return { strength: "default", source: "label" };
  if (set.has("review:low")) return { strength: "low", source: "label" };
  if (set.has("complexity:xhigh")) return { strength: "high", source: "complexity" };
  if (set.has("complexity:high")) return { strength: "high", source: "complexity" };
  if (set.has("complexity:low")) return { strength: "low", source: "complexity" };
  return { strength: "default", source: "default" };
}

export interface GhIssue {
  number: number;
  title: string;
  url: string;
  labels: Array<{ name: string }>;
  body?: string;
}

/**
 * A single `blocked by` relationship entry resolved from GitHub Issue Relationships.
 */
export interface BlockedByEntry {
  issueNumber: number;
  state: "open" | "closed";
  /**
   * GitHub `state_reason` when closed. `not_planned` means abandoned / superseded
   * and does NOT satisfy a dependency; `completed` or null/absent means the normal
   * closed path and does satisfy it.
   */
  stateReason?: "not_planned" | "completed" | null;
}

/**
 * Decision snapshot recorded when a dependency check is performed during intake.
 * Stored verbatim in task context so the intake decision is auditable.
 */
export interface DependencyDecision {
  /** ISO-8601 timestamp when the check was performed. */
  checkedAt: string;
  /** Always "github-relationships" — checked via GitHub Issue Relationships. */
  source: "github-relationships";
  /** All `blocked by` relationship entries found for the issue at check time. */
  blockedBy: BlockedByEntry[];
  /** True when at least one unsatisfied `blocked by` dependency exists (open or closed as not_planned). */
  blocked: boolean;
}

/**
 * Adapter seam for checking GitHub Issue Relationships (`blocked by`).
 *
 * The default production implementation (GraphQLDependencyChecker in
 * src/cli/github-intake.ts) queries GitHub via `gh api graphql` using the
 * `blockedBy` GraphQL field.  If that field is
 * not available in the target environment, replace this with a custom
 * implementation and wire it into runIntake().
 *
 * Contract: implementations MUST throw on any error so the caller can fail
 * closed (skip the issue rather than letting it through unverified).
 */
export interface DependencyChecker {
  /** Returns all `blocked by` relationship entries for the given issue number. */
  getBlockedBy(issueNumber: number): Promise<BlockedByEntry[]>;
}

/**
 * Resolves whether the single-blocker stackable case (Gate 2) is ready to be
 * enqueued — i.e. the blocker already has a usable PR head to stack on. Returns
 * true only when stacking can proceed; false (or a throw) keeps the dependent
 * issue held at intake. Injected so the core gate can consult the full
 * dependency-plan resolver without depending on the gh-backed handler layer.
 */
export type StackReadyResolver = (issueNumber: number) => Promise<boolean>;

/**
 * IssueCandidate extended with the dependency decision snapshot.
 * The dependencyDecision field is present whenever a DependencyChecker was used.
 */
export type IssueCandidateWithDecision = IssueCandidate & {
  dependencyDecision?: DependencyDecision;
};

/**
 * Gate 2 stackable case: a dependent issue may advance to implementation before
 * its blocker is closed when it has exactly one open blocker and is a new
 * implementation task. Only the new-implementation path stacks onto a blocker PR
 * head (fix mode operates on the issue's own existing PR branch), so all other
 * shapes remain held by the close-only gate.
 */
function isStackableBlockedCase(
  openBlockers: BlockedByEntry[],
  mapping: NonNullable<ReturnType<typeof labelsToPhase>>,
): boolean {
  return (
    openBlockers.length === 1 &&
    mapping.phase === "implementation" &&
    mapping.implementationMode === "new"
  );
}

/**
 * Extract IssueCandidate list from raw gh issue JSON output.
 *
 * When depChecker is provided, each issue is checked against GitHub Issue
 * Relationships (`blocked by`).  Issues with at least one unsatisfied blocker are
 * skipped — except the Gate 2 stackable case (exactly one OPEN blocker on a
 * new-implementation issue) whose blocker is confirmed stack-ready by
 * stackReadyResolver, which is enqueued so the implementation handler can stack
 * it on the blocker PR head.  When the resolver is absent or reports the blocker
 * is not yet stack-ready, the dependent issue stays held (it would otherwise be
 * enqueued only to hit the terminal implementation `blocked` handoff).  If the
 * dependency check itself throws (network error, GraphQL field missing, etc.)
 * the issue is skipped — fail closed.
 *
 * A blocker is unsatisfied when it is open, OR when it is closed as `not_planned`
 * (abandoned / superseded).  Only a blocker closed as `completed` (or with no
 * state_reason) satisfies the dependency.  `not_planned` blockers are never a
 * valid stacking base for Gate 2.
 *
 * The DependencyDecision is attached to each returned candidate so the caller
 * can persist it in the task context.
 *
 * When depChecker is omitted no dependency gate is applied (useful in tests
 * that supply a controlled issue list without a live GitHub connection).
 */
export async function parseCandidates(
  issues: GhIssue[],
  depChecker?: DependencyChecker,
  stackReadyResolver?: StackReadyResolver,
): Promise<IssueCandidateWithDecision[]> {
  const candidates: IssueCandidateWithDecision[] = [];
  for (const issue of issues) {
    const labels = issue.labels.map((l) => l.name);
    const mapping = labelsToPhase(labels);
    if (!mapping) continue;

    let dependencyDecision: DependencyDecision | undefined;

    if (depChecker) {
      const checkedAt = new Date().toISOString();
      let blockedBy: BlockedByEntry[];
      try {
        blockedBy = await depChecker.getBlockedBy(issue.number);
      } catch {
        // Fail closed: cannot verify relationship state → hold back
        continue;
      }
      const openBlockers = blockedBy.filter((b) => b.state === "open");
      // A blocker closed as `not_planned` (abandoned / superseded) does not
      // satisfy the dependency — treat it as unsatisfied just like an open blocker.
      const unsatisfiedBlockers = blockedBy.filter(
        (b) => b.state === "open" || b.stateReason === "not_planned",
      );
      dependencyDecision = {
        checkedAt,
        source: "github-relationships",
        blockedBy,
        blocked: unsatisfiedBlockers.length > 0,
      };
      // Dependency gate: hold the issue back until all blockers are satisfied.
      // EXCEPT for the Gate 2 stackable case — exactly one OPEN blocker on a
      // new-implementation issue. `not_planned` closed blockers are never a valid
      // stacking base, so Gate 2 requires that the single unsatisfied blocker is
      // also open (unsatisfiedBlockers and openBlockers are the same single entry).
      if (unsatisfiedBlockers.length > 0) {
        const singleOpenUnsatisfied =
          unsatisfiedBlockers.length === 1 && openBlockers.length === 1;
        if (!singleOpenUnsatisfied || !isStackableBlockedCase(openBlockers, mapping)) {
          continue;
        }
        // Gate 2: the shape is stackable, but only let it through once the blocker
        // is actually stack-ready (has a usable PR head to branch from). An
        // implementation `blocked` result is terminal — it hands off to a human
        // and clears the queue labels — so enqueuing a dependent whose blocker is
        // merely unimplemented/unreviewed would prematurely remove it from
        // automation. Hold it here instead until the blocker becomes stack-ready.
        // Fail closed: no resolver, a not-ready blocker, or a resolver error all
        // keep the issue held (issue #208 review follow-up).
        let stackReady = false;
        if (stackReadyResolver) {
          try {
            stackReady = await stackReadyResolver(issue.number);
          } catch {
            stackReady = false;
          }
        }
        if (!stackReady) {
          continue;
        }
      }
    }

    candidates.push({
      issueNumber: issue.number,
      title: issue.title,
      url: issue.url,
      labels,
      ...(typeof issue.body === "string" && issue.body.length > 0
        ? { body: issue.body }
        : {}),
      ...mapping,
      ...(dependencyDecision ? { dependencyDecision } : {}),
    });
  }
  return candidates;
}
