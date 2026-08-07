# Legacy Review Feedback Compatibility (issue #842)

This document specifies how `resolveReviewCompatContext`
(`src/core/review-legacy-compat.ts`) adapts a persisted task context's legacy
free-form `reviewFeedback` to the structured review dispute pipeline defined
by [`docs/review-dispute-contract.md`](review-dispute-contract.md), and how
that adaptation behaves across deployment, mixed-version fleets, and
rollback.

It does not redefine anything `review-dispute-contract.md` §13 already
specifies. It is the implementation note for the one boundary that document's
§13 leaves to a later issue: the point in `src/handlers/implementation.ts`
where subsequent implementation/fix processing reads `task.context` and
decides what review state to act on.

---

## What it does

`resolveReviewCompatContext(context, opts?)` reads exactly two fields —
`context.reviewFeedback` and `context.reviewDispute` — and returns a
classification, never a mutation:

```ts
interface ReviewCompatResolution {
  mode: "disabled" | "empty" | "legacy" | "mixed" | "structured" | "malformed";
  legacyFinding: LegacyReviewFinding | null; // issue #836, disputable: false
  reviewDispute: ReviewDisputeContext | null; // issue #836/#841, validated
  malformedReason?: string;
}
```

It owns no schema, classifier, envelope parser, or validator of its own. It
composes two issue #836 exports:

- `legacyFindingFromReviewFeedback` — bounds `reviewFeedback` and wraps it in
  a finding whose `disputable` field is the literal type `false`, so no
  downstream code can widen legacy prose into a disputable finding.
- `validateReviewDisputeContext` — the same runtime validator issue #841's
  admission path uses, applied here to whatever `context.reviewDispute`
  already holds.

### Precedence rule (one, applied deterministically)

| `reviewDispute` | residual `reviewFeedback` | `mode` | authoritative |
| --- | --- | --- | --- |
| absent/null | absent/whitespace | `empty` | neither |
| absent/null | present | `legacy` | the legacy finding |
| present, fails validation | (either) | `malformed` | the legacy finding only — the structured block is discarded, never repaired |
| present, valid, `reviewStructure: "structured"` | (either) | `structured` | the structured block only — no legacy finding is reported even if `reviewFeedback` still holds text |
| present, valid, `reviewStructure: "mixed"` | present | `mixed` | both — the structured block AND the legacy finding |
| `opts.enabled === false` | (either) | `disabled` | neither — matches §13's byte-identical-to-today rule |

A malformed structured block never falls back to a partial or "best effort"
reading of itself. §12's fail-closed rule applies at this boundary exactly as
it does everywhere else in the protocol: reject the whole block, keep
whatever legacy prose exists, move on.

---

## Deployment and rollback behavior

The resolver is pure: it recomputes its answer from `context` on every call
and writes nothing back. There is no persisted "converted" flag and no
migration. That has three consequences for rollout:

1. **Old snapshots** (written before issue #836/#841 existed, `reviewDispute`
   absent) resolve to `legacy` or `empty` exactly as they would have without
   this module — `resolveReviewCompatContext` is the same classification a
   hand-written `if (typeof reviewFeedback === "string" ...)` check would
   have produced, just centralized and reusable. No backfill is required or
   performed.
2. **Mixed-version snapshots** — a task queued by an older build and picked
   up by a newer one (or vice versa) mid-rollout — are handled by the same
   read-time classification. A newer build sees whatever `reviewDispute`
   shape an older build left behind (absent, or a valid/invalid block from a
   different code revision) and classifies it the same way it would classify
   a freshly-written one. There is no "task context version" to reconcile.
3. **Newly structured snapshots** (a `reviewDispute` block issue #841's
   admission path just wrote) are picked up automatically the next time
   `resolveReviewCompatContext` runs against that context — because task
   context merges shallowly and issue #841 replaces `reviewDispute` wholesale
   on each admitted review, the prior legacy-only resolution is superseded
   without any explicit "replace" step here. Unrelated fields
   (`reviewFeedback`'s storage bound, `prUrl`, `branch`,
   `implementationMode`, review-loop counters) are untouched — this module
   never reads or writes them.

### Rollback

Disabling the protocol (`session.reviewDispute.enabled: false`, the default)
or rolling back to a build that predates this module both leave existing task
context intact:

- Rolling back to a pre-#842 build: `task.context.reviewDispute`, if present,
  is simply never read again. Fix mode continues to run on
  `task.context.reviewFeedback` exactly as it always has — untouched, because
  this module never removes or rewrites either field.
- Disabling the flag on a current build: `resolveReviewCompatContext` returns
  `mode: "disabled"` for any context, regardless of what `reviewDispute` it
  finds — the structured block is ignored, not deleted. Re-enabling the flag
  later resumes classifying that same block exactly as before it was
  disabled, since nothing was destroyed while it was off.

In both directions, no code path here ever deletes a field, migrates a
record, or requires a coordinated deploy order.

---

## What it deliberately does not do

- It does not change `src/handlers/review.ts`'s structured envelope
  generation, parsing, or admission (issue #841 owns that).
- It does not add structured finding disposition instructions to the
  implementation/fix prompt (issue #837 owns that). The fix prompt built from
  `task.context.reviewFeedback` is byte-for-byte unchanged by this module —
  see the comment above `getReviewFeedback` in
  `src/handlers/implementation.ts`.
- It does not implement dispute transitions, counters, caps, reconsideration,
  or arbitration (issue #840 and its upstream routing issues own that).
- It never makes legacy prose eligible for a structured dispute:
  `LegacyReviewFinding.disputable` is typed `false`, and this module never
  constructs one any other way.
