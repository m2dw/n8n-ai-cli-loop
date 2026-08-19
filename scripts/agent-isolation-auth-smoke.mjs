/**
 * Local smoke test for the isolated no-tool invocation environment (issue #935).
 *
 * Answers, on the operator's own machine, the two questions `npm test` cannot:
 * does an already authenticated Claude Code subscription still authenticate
 * inside the environment the runner actually builds, and does GitHub stay
 * unavailable in that same environment? Jest can assert which vars are set and
 * what they point at; only a real CLI can say whether the resulting environment
 * reaches a real login.
 *
 * Run:  npm run build && node scripts/agent-isolation-auth-smoke.mjs
 *       npm run build && node scripts/agent-isolation-auth-smoke.mjs --json
 *
 * This spawns `claude` and `gh` with READ-ONLY status subcommands, in a
 * throwaway cwd, and removes every directory it creates. It writes nothing to
 * the repository, opens no database, and contacts no GitHub API beyond `gh`'s
 * own auth check. See docs/agent-isolation-policy.md.
 *
 * Exit code 0 = every check passed. Exit code 1 = at least one failed, and the
 * failing rows say which.
 */

import { spawnSync } from "child_process";
import { existsSync, rmSync } from "fs";

import { buildIsolatedInvocation, resolveHomePolicy } from "../dist/handlers/agent-isolation.js";
import { ARBITER_CLAUDE_NO_TOOLS_ARGS } from "../dist/core/review-arbiter-profile.js";

const asJson = process.argv.includes("--json");

/** Credential vars that would authenticate Claude WITHOUT the subscription login. */
const API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

/**
 * Run one probe under an isolated environment.
 *
 * `stdio: "pipe"` with an empty stdin: a CLI that would otherwise prompt gets
 * EOF and exits rather than hanging this script, and the timeout bounds the rest.
 */
function probe(cmd, args, env, cwd, input = "") {
  const result = spawnSync(cmd, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    // A missing CLI (ENOENT) is a failure to REPORT, not an authenticated run.
    ok: result.error === undefined && result.status === 0,
    status: result.status,
    error: result.error ? String(result.error.code ?? result.error.message) : undefined,
    // First line only: enough to identify the outcome, and no transcript-sized
    // output — and never printed for a check whose output could name a token.
    firstLine: output.split("\n")[0] ?? "",
  };
}

const checks = [];
function record(name, passed, detail) {
  checks.push({ name, passed, detail });
}

// ---------------------------------------------------------------------------
// The Anthropic no-tool environment: the one #935 changed.
// ---------------------------------------------------------------------------

const anthropic = buildIsolatedInvocation(process.env, {
  prefix: "ai-isolation-smoke",
  provider: "anthropic",
  toolPolicy: "no-tools",
});

try {
  record(
    "anthropic/no-tools inherits the real HOME",
    anthropic.homePolicy === "inherit" && anthropic.env.HOME === process.env.HOME,
    `homePolicy=${anthropic.homePolicy}`,
  );

  const presentKeyVars = API_KEY_VARS.filter((key) => anthropic.env[key] !== undefined);
  record(
    "no API key in the environment (the login under test is the subscription)",
    presentKeyVars.length === 0,
    presentKeyVars.length === 0
      ? "none set"
      : `set: ${presentKeyVars.join(", ")} — unset them and re-run for a meaningful result`,
  );

  const claudeAuth = probe("claude", ["auth", "status"], anthropic.env, anthropic.cwd);
  record(
    "`claude auth status` succeeds under the isolated environment",
    claudeAuth.ok,
    claudeAuth.ok
      ? "exit 0"
      : `exit ${claudeAuth.status ?? claudeAuth.error}: ${claudeAuth.firstLine}`,
  );

  // `claude auth status` answers "is this environment logged in", but the turns
  // this script exists for run with the no-tools argv on top of it — including
  // `--safe-mode`, which disables the operator's customizations. Only the real
  // argv can show that the boundary and the login coexist, so the probe below
  // is the actual invocation shape with a trivial prompt on stdin.
  const claudeTurn = probe(
    "claude",
    ["-p", ...ARBITER_CLAUDE_NO_TOOLS_ARGS],
    anthropic.env,
    anthropic.cwd,
    "Reply with the single word: ok",
  );
  record(
    "a real no-tools `claude -p` turn runs under the isolated environment",
    claudeTurn.ok,
    claudeTurn.ok
      ? "exit 0"
      : `exit ${claudeTurn.status ?? claudeTurn.error}: ${claudeTurn.firstLine}`,
  );

  // GitHub must stay unreachable even though HOME is real: GH_CONFIG_DIR is the
  // control, not the faked home.
  record(
    "GH_CONFIG_DIR is an empty temp dir, not the real home",
    anthropic.env.GH_CONFIG_DIR !== process.env.HOME
      && anthropic.env.GH_CONFIG_DIR !== anthropic.env.HOME
      && existsSync(anthropic.env.GH_CONFIG_DIR),
    `GH_CONFIG_DIR=${anthropic.env.GH_CONFIG_DIR}`,
  );
  const ghAuth = probe("gh", ["auth", "status"], anthropic.env, anthropic.cwd);
  record(
    "`gh auth status` FAILS under the isolated environment",
    !ghAuth.ok,
    // No output echoed here: an authenticated `gh auth status` can print account
    // and scope detail, and this script must not become the thing that leaks it.
    ghAuth.ok ? "gh is authenticated — GitHub isolation is broken" : "unauthenticated, as required",
  );

  record(
    "the agent does not run in the checkout",
    anthropic.cwd !== process.cwd() && !anthropic.cwd.startsWith(process.cwd()),
    `cwd=${anthropic.cwd}`,
  );
} finally {
  for (const dir of anthropic.cleanup) rmSync(dir, { recursive: true, force: true });
}

record(
  "both temp directories are removed, the real home is untouched",
  anthropic.cleanup.every((dir) => !existsSync(dir))
    && (process.env.HOME === undefined || existsSync(process.env.HOME)),
  anthropic.cleanup.join(", "),
);

// ---------------------------------------------------------------------------
// The boundaries #935 did NOT move.
// ---------------------------------------------------------------------------

const openai = buildIsolatedInvocation(process.env, {
  prefix: "ai-isolation-smoke",
  provider: "openai",
  toolPolicy: "no-tools",
});
try {
  record(
    "openai/no-tools still gets a throwaway home",
    openai.homePolicy === "throwaway"
      && openai.env.HOME !== process.env.HOME
      && openai.env.GH_CONFIG_DIR === openai.env.HOME,
    `HOME=${openai.env.HOME}`,
  );
} finally {
  for (const dir of openai.cleanup) rmSync(dir, { recursive: true, force: true });
}

record(
  "a tool-capable anthropic invocation gets a throwaway home",
  resolveHomePolicy("anthropic", "tool-capable") === "throwaway",
  "resolveHomePolicy(anthropic, tool-capable)",
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const failed = checks.filter((check) => !check.passed);
if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
} else {
  console.log("Isolated no-tool invocation — local auth smoke test (issue #935)\n");
  for (const check of checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"}  ${check.name}\n        ${check.detail}`);
  }
  console.log(
    `\n${failed.length === 0 ? "All checks passed." : `${failed.length} check(s) failed.`}`,
  );
}
process.exit(failed.length === 0 ? 0 : 1);
