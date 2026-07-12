import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  FIXTURES,
  computeRows,
  summarize,
  renderMarkdown,
} from "../scripts/issue-plan-backtest.mjs";

// Verifies the issue #339 issue-plan backtest: a reproducible baseline of the
// CURRENT heuristic over a labeled fixture set. Two things are asserted:
//   1. the reporting contract is internally consistent (flags ↔ rule, aggregate
//      ↔ rows), so the report cannot silently miscount; and
//   2. docs/issue-plan-backtest.md embeds the EXACT live output, so the
//      documented table can never drift from the command (acceptance criteria).
// When the heuristic is recalibrated these numbers change and this test fails
// until the doc is regenerated — the single, intended update path.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const doc = readFileSync(resolve(ROOT, "docs/issue-plan-backtest.md"), "utf8");

describe("issue-plan backtest (issue #339)", () => {
  const rows = computeRows();

  test("every fixture is labeled easy or hard", () => {
    expect(rows.length).toBe(FIXTURES.length);
    for (const r of rows) {
      expect(["easy", "hard"]).toContain(r.outcome);
    }
  });

  test("each prediction projects the live analyzer's reported fields", () => {
    for (const r of rows) {
      expect(["ready", "needs_clarification", "split_required", "blocked", "high_risk"]).toContain(
        r.pred.decision,
      );
      expect(["low", "medium", "high", "xhigh"]).toContain(r.pred.complexity);
      expect(["low", "medium", "high", "xhigh"]).toContain(r.pred.effort);
    }
  });

  test("false-positive / true-positive flags follow the documented rule", () => {
    for (const r of rows) {
      const pessimistic =
        r.pred.decision === "high_risk" ||
        r.pred.decision === "split_required" ||
        r.pred.effort === "high" ||
        r.pred.effort === "xhigh";
      const stopsLine = r.pred.decision === "high_risk" || r.pred.decision === "split_required";
      expect(r.falsePositive).toBe(r.outcome === "easy" && pessimistic);
      expect(r.truePositive).toBe(r.outcome === "hard" && stopsLine);
      // A row can never be both — the outcome label is exclusive.
      expect(r.falsePositive && r.truePositive).toBe(false);
    }
  });

  test("aggregate counts match the filtered rows", () => {
    const s = summarize(rows);
    expect(s.easyTotal).toBe(rows.filter((r) => r.outcome === "easy").length);
    expect(s.hardTotal).toBe(rows.filter((r) => r.outcome === "hard").length);
    expect(s.falsePositives).toBe(rows.filter((r) => r.falsePositive).length);
    expect(s.truePositives).toBe(rows.filter((r) => r.truePositive).length);
  });

  test("documented baseline matches the current heuristic", () => {
    // The current (pre-calibration) heuristic flags all four `easy` fixtures and
    // catches only one of the two `hard` fixtures. These literals are the
    // checked-in baseline; a calibration improvement must update them here and in
    // the doc together.
    const s = summarize(rows);
    expect(s).toEqual({ easyTotal: 4, falsePositives: 4, hardTotal: 2, truePositives: 1 });
  });

  test("docs/issue-plan-backtest.md embeds the exact live report", () => {
    const begin = "<!-- BEGIN GENERATED: scripts/issue-plan-backtest.mjs -->";
    const end = "<!-- END GENERATED -->";
    const start = doc.indexOf(begin);
    const stop = doc.indexOf(end);
    expect(start).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(start);
    const block = doc.slice(start + begin.length, stop).trim();
    expect(block).toBe(renderMarkdown(rows));
  });

  test("the documented reproduction command is present", () => {
    expect(doc).toContain("node scripts/issue-plan-backtest.mjs");
  });
});
