/**
 * Human-readable PR change summary for the final merge gate (issue #506).
 *
 * Generates a concise markdown comment body posted as a sticky PR comment.
 * The comment is updated (not duplicated) on each implementation/review pass
 * via the `repohost:pr-summary` outbox topic and `upsertStickyPrComment`.
 */

import type { DiffClassification } from "./review-diff-context.js";
import type { IssueRequiredVerification } from "../handlers/verification.js";

/** Stable HTML comment marker for the sticky summary comment. */
export const PR_SUMMARY_MARKER = "<!-- n8n-ai-pr-summary -->";

export interface PrSummaryInput {
  issueNumber: number;
  issueTitle?: string;
  phase: string;
  phaseResult: string;
  runId: string;
  diffClassification?: DiffClassification;
  /** Names of verification commands that ran. */
  verificationNames?: string[];
  /** Whether verification passed overall. */
  verificationPassed?: boolean;
  /** Issue-required verification commands and their run status. */
  issueRequiredVerifications?: IssueRequiredVerification[];
}

/** Maximum files shown per list entry before truncation. */
const FILE_LIST_CAP = 10;

function renderFileList(files: string[], max = FILE_LIST_CAP): string {
  if (files.length === 0) return "—";
  const shown = files.slice(0, max);
  const overflow = files.length - shown.length;
  const base = shown.map((f) => `\`${f}\``).join(", ");
  return overflow > 0 ? `${base} _(+${overflow} more)_` : base;
}

function renderRenameList(renames: { from: string; to: string }[], max = FILE_LIST_CAP): string {
  if (renames.length === 0) return "—";
  const shown = renames.slice(0, max);
  const overflow = renames.length - shown.length;
  const base = shown.map((r) => `\`${r.from}\` → \`${r.to}\``).join(", ");
  return overflow > 0 ? `${base} _(+${overflow} more)_` : base;
}

/**
 * Render the full PR summary body, including the HTML comment marker.
 * The marker must be present so `upsertStickyPrComment` can find and replace
 * this comment on subsequent passes.
 */
export function renderPrSummary(input: PrSummaryInput): string {
  const {
    issueNumber,
    issueTitle,
    phase,
    phaseResult,
    runId,
    diffClassification,
    verificationNames = [],
    verificationPassed,
    issueRequiredVerifications,
  } = input;

  const lines: string[] = [PR_SUMMARY_MARKER, ""];

  const titleLine = issueTitle
    ? `**Issue #${issueNumber}** — ${issueTitle}`
    : `**Issue #${issueNumber}**`;
  lines.push("## PR Change Summary", "", titleLine, "");

  // Guardrail / tooling changes section — rendered first so it is never truncated by large file lists
  lines.push("### Guardrail / Tooling Changes");
  if (diffClassification) {
    const { guardrail } = diffClassification;
    const totalGuardrail =
      guardrail.added.length +
      guardrail.modified.length +
      guardrail.deleted.length +
      guardrail.renamed.length;
    if (totalGuardrail === 0) {
      lines.push("None.");
    } else {
      if (guardrail.deleted.length > 0) {
        lines.push(
          `- ⚠️ **Deleted (${guardrail.deleted.length})** _(requires justification)_: ${renderFileList(guardrail.deleted)}`,
        );
      }
      if (guardrail.added.length > 0) {
        lines.push(`- **Added (${guardrail.added.length})**: ${renderFileList(guardrail.added)}`);
      }
      if (guardrail.modified.length > 0) {
        lines.push(
          `- **Modified (${guardrail.modified.length})**: ${renderFileList(guardrail.modified)}`,
        );
      }
      if (guardrail.renamed.length > 0) {
        lines.push(
          `- **Renamed (${guardrail.renamed.length})**: ${renderRenameList(guardrail.renamed)}`,
        );
      }
    }
  } else {
    lines.push("Not available.");
  }
  lines.push("");

  // Scope concerns section
  const scopeConcerns: string[] = [];
  if (diffClassification) {
    const { guardrail } = diffClassification;
    if (guardrail.deleted.length > 0) {
      scopeConcerns.push(
        `Guardrail file(s) deleted: ${renderFileList(guardrail.deleted)} — deletion requires justification tied to the issue scope.`,
      );
    }
  }

  if (scopeConcerns.length > 0) {
    lines.push("### Scope Concerns");
    for (const concern of scopeConcerns) {
      lines.push(`- ${concern}`);
    }
    lines.push("");
  }

  // File changes section — rendered after guardrail/scope so high-value warnings are always visible
  lines.push("### Files Changed");
  if (diffClassification) {
    const { added, modified, deleted, renamed } = diffClassification;
    const totalFiles = added.length + modified.length + deleted.length + renamed.length;
    if (totalFiles === 0) {
      lines.push("No file changes detected.");
    } else {
      if (added.length > 0) lines.push(`- **Added (${added.length})**: ${renderFileList(added)}`);
      if (modified.length > 0)
        lines.push(`- **Modified (${modified.length})**: ${renderFileList(modified)}`);
      if (deleted.length > 0)
        lines.push(`- **Deleted (${deleted.length})**: ${renderFileList(deleted)}`);
      if (renamed.length > 0)
        lines.push(`- **Renamed (${renamed.length})**: ${renderRenameList(renamed)}`);
    }
  } else {
    lines.push("Not available (diff classification unavailable for this review agent).");
  }
  lines.push("");

  // Verification section
  lines.push("### Verification");
  if (verificationPassed !== undefined) {
    const status = verificationPassed ? "✅ passed" : "❌ failed";
    const names = verificationNames.length > 0 ? verificationNames.join(", ") : "verification";
    lines.push(`${names}: ${status}`);
  } else {
    lines.push("Unknown — not recorded for this phase.");
  }
  if (issueRequiredVerifications && issueRequiredVerifications.length > 0) {
    lines.push("");
    lines.push("**Issue-required verification:**");
    for (const v of issueRequiredVerifications) {
      const label =
        v.status === "passed"
          ? "✅ passed"
          : v.status === "failed"
          ? `❌ failed${v.exitCode !== undefined ? ` (exit ${v.exitCode})` : ""}`
          : "⚠️ not run";
      lines.push(`- \`${v.command}\`: ${label}`);
    }
    const notRunCount = issueRequiredVerifications.filter((v) => v.status === "not_run").length;
    const failedCount = issueRequiredVerifications.filter((v) => v.status === "failed").length;
    if (notRunCount > 0) {
      lines.push(`_${notRunCount} required command(s) not run — human review required._`);
    }
    if (failedCount > 0) {
      lines.push(`_${failedCount} required command(s) failed — human review required._`);
    }
  }
  lines.push("");

  // CI/Checks section
  lines.push("### CI / Checks Status");
  lines.push("Unknown — checks not queried by the workflow.");
  lines.push("");

  lines.push("---", `_Phase: ${phase} | Result: ${phaseResult} | Run: ${runId}_`);

  return lines.join("\n");
}
