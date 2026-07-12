# issue-plan heuristic backtest

A reproducible baseline of how the **current** deterministic `issue-plan`
heuristic classifies a small labeled fixture set. The heuristic is known to be
too pessimistic — it over-predicts implementation risk from keyword-only
detections such as `token`, `migration`, or a bare `#NNN` reference (this is the
premise of the calibration prompt produced by `issue-plan evaluate-history`,
issues #323 / #329). This backtest turns that pessimism into a measurable,
reproducible number so future calibration work has something concrete to move.

## Method

The live calibration dataset (issue #329) is produced by joining each issue's
heuristic prediction with its **local** workflow outcome from the SQLite history
store, keeping only `calibrationEligible` rows — issues with a **final** outcome
that is cleanly classified as issue difficulty (`easy` / `hard`), with
infra/tooling noise and incomplete runs excluded. `issue-plan` reads GitHub
**read-only** and that historical data must not be mutated, so this backtest
runs **offline** over a fixture set that mirrors those cleaned-dataset
categories: each fixture is an `easy` outcome the heuristic tends to
over-classify, or a `hard` outcome that must stay conservative.

The report imports the live `analyzeIssuePlan` from the built module, so it
always reflects exactly what `issue-plan preview` predicts. There is **no**
second, frozen copy of the heuristic to drift. When the heuristic is
recalibrated the numbers below change, this table stops matching, and
`test/issue-plan-backtest.test.js` fails — the single, explicit update path.

Reproduce it with:

```
npm run build && node scripts/issue-plan-backtest.mjs
```

Add `--json` for the machine-readable rows + aggregate.

A prediction is a **pessimistic false positive** on an `easy` outcome when the
decision stops the line (`high_risk` / `split_required`) or the recommended
implementation effort is inflated (`high` / `xhigh`). Complexity is excluded
from that metric: an authoritative `complexity:*` intake label is honored (never
lowered) by design, so a label-driven complexity is not itself a false positive.
A **true positive** on a `hard` outcome is a stop-the-line decision
(`high_risk` / `split_required`).

<!-- BEGIN GENERATED: scripts/issue-plan-backtest.mjs -->
## Current heuristic vs. labeled outcome

| Issue | Outcome | Decision | Complexity | Impl effort | Verdict | Note |
| --- | --- | --- | --- | --- | --- | --- |
| #309 | easy | high_risk | high | high | false positive | AI token cost + a docs "migration note" — neither is real security/migration work. |
| #311 | easy | ready | high | high | false positive | Negated migration/breaking statements ("no schema migration is required"). |
| #325 | easy | ready | high | high | false positive | Many acceptance criteria + several bare issue references. |
| #308 | easy | high_risk | xhigh | xhigh | false positive | Carries a complexity:xhigh intake label on a one-line change. |
| #401 | hard | ready | high | high | missed (false negative) | Real schema migration + backward-incompatible change (should be caught). |
| #403 | hard | high_risk | high | high | caught (true positive) | Workflow semantics / operational policy (should be caught). |

## Aggregate

- Pessimistic false positives on `easy` outcomes: **4 / 4**.
- True positives caught on `hard` outcomes: **1 / 2**.
<!-- END GENERATED -->

## How to read this

The current heuristic flags **all four** `easy` fixtures as pessimistic false
positives and catches only **one of two** `hard` fixtures:

- `token` (an AI cost/usage word) counts as credential/security context (#309).
- A bare `migration` substring fires even on a docs "migration note" or a
  **negated** "no schema migration is required" statement (#309, #311).
- `recommendedImplementationEffort` tracks `complexity`, so a `complexity:xhigh`
  intake label or a body-structure complexity bump inflates the effort even when
  the decision itself is `ready` (#308, #325).
- A `high`-complexity migration that never reaches `high_risk` is a false
  negative on a genuinely breaking change (#401).

These are the rules a future calibration pass should target. Each later
improvement should reduce the false-positive count (or catch #401) and update
this table together with `test/issue-plan-backtest.test.js` — they are kept in
lock-step so the documented numbers can never silently drift from the code.
