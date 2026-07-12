import type { CodexConfig } from "../core/session.js";

// ---------------------------------------------------------------------------
// Codex context-mode resolution (issue #376)
//
// Resolves whether a Codex agent invocation (implementation `codex exec` or
// review `codex review`) should run with context-mode, and — when it should —
// the exact argv fragment to splice into the Codex command.
//
// The invocation form is ALWAYS operator-supplied via session config
// (`session.codex.contextMode.config` / `.profile`). This is deliberate: Codex
// CLI/plugin behavior changes quickly, so this workflow must never hard-code an
// unverified context-mode config key by guesswork. The operator declares the
// form they have verified against their own Codex build and it is passed
// verbatim.
//
// Resolution outcomes:
//   - unset    : no context-mode configured (or explicitly disabled). The Codex
//                argv is left unchanged; metadata records it as unset.
//   - enabled  : context-mode is on. `args` is spliced into the Codex command.
//   - error    : context-mode was requested but the configuration is invalid or
//                missing an invocation form. The caller fails the run with this
//                message BEFORE invoking the agent, so a billed Codex run never
//                proceeds silently without the context-mode the operator asked
//                for.
//
// Precedence: the `CODEX_CONTEXT_MODE` env var (when set) overrides the session
// switch, mirroring how `CODEX_EFFORT` overrides the resolved effort tier. The
// env var only toggles context-mode on/off; the invocation form still comes from
// session config, so `CODEX_CONTEXT_MODE=on` with no configured form is an error
// rather than a guess.
// ---------------------------------------------------------------------------

export type CodexContextModeStatus = "enabled" | "unset";
export type CodexContextModeSource = "session" | "env" | "default";

export interface CodexContextModeEnabled {
  status: "enabled";
  /** argv fragment to splice into the Codex command (`codex exec`/`codex review`). */
  args: string[];
  source: "session" | "env";
  /** Resolved `-c key=value` overrides applied. */
  config: string[];
  /** Resolved `--profile` name, when configured. */
  profile?: string;
}

export interface CodexContextModeUnset {
  status: "unset";
  source: "default" | "env";
}

export interface CodexContextModeError {
  status: "error";
  error: string;
}

export type CodexContextModeResolution =
  | CodexContextModeEnabled
  | CodexContextModeUnset
  | CodexContextModeError;

const ENABLE_VALUES = new Set(["on", "true", "1", "yes", "enabled"]);
const DISABLE_VALUES = new Set(["off", "false", "0", "no", "disabled"]);

// A `-c` override must look like `key=value` with a non-empty key (no `=`/
// whitespace) and a non-empty value. This catches obvious typos (a bare key, a
// leading `=`, an empty value) before they reach the Codex CLI.
const CONFIG_ENTRY_RE = /^[^=\s]+=.+$/;

/**
 * Resolve Codex context-mode for an invocation from the session's `codex` config
 * and the process environment. See the module header for outcome semantics.
 */
export function resolveCodexContextMode(
  codex: CodexConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CodexContextModeResolution {
  const cfg = codex?.contextMode;
  const rawEnv = env["CODEX_CONTEXT_MODE"];
  const envVal = typeof rawEnv === "string" ? rawEnv.trim().toLowerCase() : "";

  let source: "session" | "env";
  if (envVal.length > 0) {
    if (DISABLE_VALUES.has(envVal)) return { status: "unset", source: "env" };
    if (!ENABLE_VALUES.has(envVal)) {
      return {
        status: "error",
        error:
          `Invalid CODEX_CONTEXT_MODE value ${JSON.stringify(rawEnv)}; ` +
          `expected one of: on, off, true, false, 1, 0.`,
      };
    }
    source = "env";
  } else {
    if (!cfg || cfg.enabled !== true) return { status: "unset", source: "default" };
    source = "session";
  }

  // Enabled (via session switch or CODEX_CONTEXT_MODE). The invocation form is
  // always operator-supplied so we never guess the context-mode key.
  const rawConfig = Array.isArray(cfg?.config) ? cfg.config : [];
  const config = rawConfig
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter((c) => c.length > 0);
  const profile = typeof cfg?.profile === "string" ? cfg.profile.trim() : "";

  if (config.length === 0 && profile.length === 0) {
    return {
      status: "error",
      error:
        `Codex context-mode is enabled (source: ${source}) but no invocation form is configured. ` +
        `Set session.codex.contextMode.config (e.g. ["context_mode=on"]) and/or ` +
        `session.codex.contextMode.profile to the form verified against your Codex build.`,
    };
  }

  for (const entry of config) {
    if (!CONFIG_ENTRY_RE.test(entry)) {
      return {
        status: "error",
        error:
          `Invalid Codex context-mode config override ${JSON.stringify(entry)}; ` +
          `expected key=value (e.g. context_mode=on).`,
      };
    }
  }

  const args: string[] = [];
  if (profile.length > 0) args.push("--profile", profile);
  for (const entry of config) args.push("-c", entry);

  return {
    status: "enabled",
    args,
    source,
    config,
    ...(profile.length > 0 ? { profile } : {}),
  };
}

/**
 * The company/provider backing an agent id, recorded in resolved profile
 * metadata so billed runs can be audited by provider.
 */
export function providerForAgent(agentId: string): string {
  switch (agentId) {
    case "claude":
      return "anthropic";
    case "codex":
      return "openai";
    case "gemini":
      return "google";
    default:
      return agentId;
  }
}
