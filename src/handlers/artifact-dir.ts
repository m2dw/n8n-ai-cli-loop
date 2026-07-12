import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export function runArtifactDir(artifactRoot: string, runId: string): string {
  return join(artifactRoot, "runs", runId);
}

/**
 * Record a fail-closed artifact when a phase is asked to run an agent it does
 * not support (e.g. a codex implementation before that agent exists). Written
 * best-effort so an artifact always accompanies the clear error returned to the
 * caller, even though the run never reached its normal result artifact.
 */
export function writeAssignmentFailureArtifact(
  artifactDir: string,
  payload: {
    phase: string;
    agentId: string | undefined;
    sessionId: string;
    issueNumber: number;
    runId: string;
    error: string;
  },
): void {
  try {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "assignment-error.json"),
      JSON.stringify({ success: false, ...payload }, null, 2),
      "utf8",
    );
  } catch {
    // Best effort: the clear error is still returned even if the artifact write fails.
  }
}
