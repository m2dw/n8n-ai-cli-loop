/**
 * issue-plan heuristic backtest (issue #339).
 *
 * Runs the CURRENT, live deterministic `issue-plan` heuristic over a small
 * labeled fixture set and reports where it over- or under-fires, so the
 * pessimism the calibration prompt describes (issue #323/#329) has a
 * reproducible baseline rather than a hand-maintained, drift-prone table.
 *
 * This deliberately does NOT embed a second ("before") copy of the heuristic.
 * A frozen inline duplicate of the rules drifts from the shipped analyzer the
 * moment either changes; instead the report imports `analyzeIssuePlan` from the
 * built module, so it always reflects exactly what `issue-plan preview` would
 * predict. When the heuristic is recalibrated the numbers below change, the
 * docs/issue-plan-backtest.md table stops matching, and
 * test/issue-plan-backtest.test.js fails — a single, explicit update path.
 *
 * Run:  npm run build && node scripts/issue-plan-backtest.mjs   (prints markdown)
 *       npm run build && node scripts/issue-plan-backtest.mjs --json
 *
 * This is an OFFLINE analysis. It reads no GitHub data, opens no database, and
 * mutates nothing.
 */

import { analyzeIssuePlan } from "../dist/cli/issue-plan.js";

// ---------------------------------------------------------------------------
// Fixture dataset — mirrors the cleaned calibration dataset categories (issue
// #329): each fixture has a FINAL, cleanly classified issue-difficulty outcome
// (`easy` | `hard`), with infra/tooling noise and incomplete runs excluded. The
// `easy` cases are the pessimistic false positives called out in issue #330
// (#309 / #311 / #325 / #308); the `hard` cases are true positives that must
// stay conservative.
// ---------------------------------------------------------------------------

export const FIXTURES = [
  {
    number: 309,
    title: "Add token usage metadata to run logs",
    outcome: "easy",
    note: "AI token cost + a docs \"migration note\" — neither is real security/migration work.",
    body: [
      "We log the model token count and token cost per run. Update the cost",
      "migration note in the docs to mention the new token usage field.",
      "",
      "## Acceptance Criteria",
      "",
      "- Token usage is recorded per run.",
      "- The cost table is updated.",
    ].join("\n"),
    labels: [],
  },
  {
    number: 311,
    title: "Show derived status in the list view",
    outcome: "easy",
    note: "Negated migration/breaking statements (\"no schema migration is required\").",
    body: [
      "Add a derived display field to the view model. No schema migration is",
      "required and there is no breaking change to stored data.",
      "",
      "## Acceptance Criteria",
      "",
      "- The derived field is shown.",
      "- Existing records render unchanged.",
    ].join("\n"),
    labels: [],
  },
  {
    number: 325,
    title: "Polish admin CLI help text",
    outcome: "easy",
    note: "Many acceptance criteria + several bare issue references.",
    body: [
      "Tidy up the help text. Related context in #301, #302, #303, and #304.",
      "",
      "## Acceptance Criteria",
      "",
      ...Array.from({ length: 8 }, (_, i) => `- Criterion ${i + 1} is satisfied.`),
    ].join("\n"),
    labels: [],
  },
  {
    number: 308,
    title: "Bump the default request timeout",
    outcome: "easy",
    note: "Carries a complexity:xhigh intake label on a one-line change.",
    body: "Change the default request timeout to 30s.\n\n## Acceptance Criteria\n\n- The default timeout is 30s.",
    labels: ["complexity:xhigh"],
  },
  {
    number: 401,
    title: "Add priority column to tasks",
    outcome: "hard",
    note: "Real schema migration + backward-incompatible change (should be caught).",
    body: [
      "Add a new column to the tasks table. This requires a schema migration and",
      "is a backward incompatible change to the persisted task records.",
      "",
      "## Acceptance Criteria",
      "",
      "- The schema migration adds the column.",
      "- Existing rows are backfilled.",
    ].join("\n"),
    labels: [],
  },
  {
    number: 403,
    title: "Change retry policy",
    outcome: "hard",
    note: "Workflow semantics / operational policy (should be caught).",
    body: "This alters workflow semantics in the execution engine.\n\n## Acceptance Criteria\n\n- works",
    labels: [],
  },
];

// ---------------------------------------------------------------------------
// Metrics
//
// A prediction is a pessimistic FALSE POSITIVE on an `easy` outcome when the
// decision stops the line (`high_risk` / `split_required`) or the recommended
// implementation effort is inflated (`high` / `xhigh`). Complexity is excluded
// from this metric on purpose: an authoritative `complexity:*` intake label is
// honored (never lowered) by design, so a label-driven complexity is not itself
// a heuristic false positive.
//
// A prediction is a TRUE POSITIVE on a `hard` outcome when the decision stops
// the line (`high_risk` / `split_required`).
// ---------------------------------------------------------------------------

function pessimistic(pred) {
  return (
    pred.decision === "high_risk" ||
    pred.decision === "split_required" ||
    pred.effort === "high" ||
    pred.effort === "xhigh"
  );
}

function isFalsePositive(outcome, pred) {
  return outcome === "easy" && pessimistic(pred);
}

function isTruePositive(outcome, pred) {
  return outcome === "hard" && (pred.decision === "high_risk" || pred.decision === "split_required");
}

/** Predict a fixture with the live analyzer, projecting only the reported fields. */
function predict(f) {
  const p = analyzeIssuePlan({
    number: f.number,
    title: f.title,
    body: f.body,
    labels: f.labels,
    comments: [],
  });
  return {
    decision: p.decision,
    complexity: p.complexity,
    effort: p.recommendedImplementationEffort,
  };
}

/** Compute per-fixture prediction rows. Pure: depends only on FIXTURES + analyzer. */
export function computeRows() {
  return FIXTURES.map((f) => {
    const pred = predict(f);
    return {
      number: f.number,
      outcome: f.outcome,
      note: f.note,
      pred,
      falsePositive: isFalsePositive(f.outcome, pred),
      truePositive: isTruePositive(f.outcome, pred),
    };
  });
}

/** Aggregate false-positive / true-positive counts across the fixtures. */
export function summarize(rows = computeRows()) {
  return {
    easyTotal: rows.filter((r) => r.outcome === "easy").length,
    falsePositives: rows.filter((r) => r.falsePositive).length,
    hardTotal: rows.filter((r) => r.outcome === "hard").length,
    truePositives: rows.filter((r) => r.truePositive).length,
  };
}

function verdict(r) {
  if (r.outcome === "easy") return r.falsePositive ? "false positive" : "ok";
  return r.truePositive ? "caught (true positive)" : "missed (false negative)";
}

/** Render the report. The exact block is mirrored in docs/issue-plan-backtest.md. */
export function renderMarkdown(rows = computeRows()) {
  const s = summarize(rows);
  const lines = [
    "## Current heuristic vs. labeled outcome",
    "",
    "| Issue | Outcome | Decision | Complexity | Impl effort | Verdict | Note |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(
      `| #${r.number} | ${r.outcome} | ${r.pred.decision} | ${r.pred.complexity} | ${r.pred.effort} | ${verdict(r)} | ${r.note} |`,
    );
  }
  lines.push("", "## Aggregate", "");
  lines.push(`- Pessimistic false positives on \`easy\` outcomes: **${s.falsePositives} / ${s.easyTotal}**.`);
  lines.push(`- True positives caught on \`hard\` outcomes: **${s.truePositives} / ${s.hardTotal}**.`);
  return lines.join("\n");
}

// CLI entry point — only when run directly (node scripts/issue-plan-backtest.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--json")) {
    const rows = computeRows();
    console.log(JSON.stringify({ rows, ...summarize(rows) }, null, 2));
  } else {
    console.log(renderMarkdown());
  }
}
