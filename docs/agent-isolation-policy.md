# Isolated no-tool agent runs: the home policy

Status: implemented (issue #935).

Several features invoke an agent CLI on untrusted text with **no tool surface**:
the Progressive Issue Refinement refiner and critic
([issue-refinement-contract.md](issue-refinement-contract.md) §7.3), the review
dispute protocol's reconsideration and arbitration turns
([review-dispute-contract.md](review-dispute-contract.md) §8.2), and the AI
planner (`src/cli/issue-plan-ai.ts`). They share one environment builder,
`buildIsolatedInvocation()` in `src/handlers/agent-isolation.ts`; the planner
predates it and applies the same policy through its provider `authEnv` seam.

This document states the one place where that isolation is **provider-specific**,
why, and what compensates for it.

## 1. The invariants, which are not provider-specific

Every isolated no-tool invocation, for every provider, runs with:

| Boundary | How |
| --- | --- |
| No checkout to write to | cwd is a fresh `mkdtemp` directory, never the repository or a worktree |
| No path back to the checkout | `PWD`, `OLDPWD`, `INIT_CWD`, `npm_config_local_prefix`, `npm_package_json` deleted; `PWD` re-pinned to the sandbox |
| No GitHub write credentials | `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GH_APP_ID`, `GH_INSTALLATION_TOKEN`, `GITHUB_APP_TOKEN`, `GITHUB_CLIENT_SECRET`, `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN` deleted |
| No GitHub credential store | `GH_CONFIG_DIR` pinned to an empty temp directory, `XDG_CONFIG_HOME` deleted |
| No other provider's credentials | every provider credential var is stripped, then only the selected provider's are restored |
| No tools | the resolved profile's argv carries the CLI-level no-tools boundary (empty tool set, explicit denylist, `--strict-mcp-config`, `--safe-mode`, `--no-session-persistence` for Claude Code) |
| Bounded, local artifacts | raw output is byte-bounded and written under the run's own artifact directory, which refuses to follow a symlink out of itself |
| Temp directories removed | both temp directories are removed on every exit path, including a throwing one |

None of these changed in #935.

## 2. The Anthropic home policy

**Policy.** For provider `anthropic`, and only for an invocation whose resolved
profile records `toolPolicy: "no-tools"`, `HOME` is the operator's real home
rather than a throwaway directory.

**Why.** Claude Code's subscription/OAuth login is not reproducible from a
throwaway home. A local authentication matrix (issue #935) found:

| Environment | `claude` |
| --- | --- |
| normal user `HOME` | authenticated |
| throwaway `HOME`, `CLAUDE_CONFIG_DIR=$HOME` | not logged in |
| throwaway `HOME`, `CLAUDE_CONFIG_DIR=$HOME/.claude` | not logged in |
| throwaway `HOME` + the visible Claude config files copied in | not logged in |
| throwaway cwd + isolated `GH_CONFIG_DIR`, real `HOME` | authenticated |

So the `CLAUDE_CONFIG_DIR` passthrough the builder previously relied on did not
have a bug to fix — it had a wrong premise. The observable consequence was that
the first live PIR pilot reached `ready_for_human / refinement` with
`agent_unavailable` and zero completed rounds on a machine that was logged in,
every refiner invocation having exited non-zero with
`Not logged in · Please run /login`.

**Scope.** The policy is keyed on the provider AND on the tool boundary:

- `resolveHomePolicy("anthropic", "no-tools")` → `inherit`
- `resolveHomePolicy("anthropic", "tool-capable")` → `throwaway`
- every other provider, either boundary → `throwaway`

`openai`/Codex isolation is therefore unchanged, including its `CODEX_HOME`
passthrough — #935 neither altered nor re-verified that passthrough, so whether a
Codex subscription login survives the throwaway home is an open question for
whoever next runs a Codex no-tool turn, not something this document asserts.
`src/cli/issue-discuss.ts` builds its own environment for a **tool-capable**
agent step and keeps the throwaway home; nothing in #935 relaxes it.

**Fail-closed properties.**

- A genuinely logged-out CLI still fails. Nothing supplies a credential; the
  policy only stops hiding one that exists. `agent_unavailable` remains the
  outcome for an operator who has not run `/login`.
- An `inherit` provider with no real `HOME` in the caller's environment gets the
  throwaway home, not an unset `HOME`.
- An unknown provider string carries no provider credential and gets the
  throwaway home.

## 3. Compensating controls

The real home exposes the operator's own agent configuration — settings, hooks,
plugins, subagents, slash commands, MCP server definitions, session files — which
a throwaway home hid as a side effect. Each is closed explicitly:

| Exposure | Control |
| --- | --- |
| user/project hooks, plugins, subagents, slash commands | `--safe-mode` |
| MCP servers from any config file | `--strict-mcp-config` with no `--mcp-config` |
| built-in tools re-enabled by a settings file | `--tools ""` plus `--allowedTools ""` plus the explicit `--disallowedTools` denylist |
| the untrusted prompt persisted into the real config dir | `--no-session-persistence` |
| `gh` credentials under `$HOME/.config/gh` | `GH_CONFIG_DIR` pinned to the empty temp dir; every write-enabling token var stripped; the AI planner re-pins `GH_CONFIG_DIR` *after* the provider auth merge so no `authEnv` can drop it |
| the repository | throwaway cwd; no cwd-bearing var survives |

This is why the policy is conditioned on `toolPolicy: "no-tools"`: those controls
are properties of the no-tools argv. An invocation without them gets the
throwaway home whatever its provider, so a future tool-capable caller of the
shared builder cannot silently inherit the relaxation.

Credential CONTENTS are unaffected: the environment names credential locations,
never their contents, and artifacts, task context, and GitHub output are
unchanged by #935.

## 4. Local smoke test

`npm run build && node scripts/agent-isolation-auth-smoke.mjs` builds the real
invocation environment and reports:

1. `claude auth status` succeeds under it, and the environment carries none of
   `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` — a
   pass with that row also passing is the subscription login, not a key;
2. a real `claude -p` turn with the shipped no-tools argv succeeds under it —
   `claude auth status` alone would not show that `--safe-mode` and the login
   coexist;
3. `gh auth status` FAILS under the same environment — GitHub authentication is
   unavailable;
4. the `openai` provider still gets a throwaway home, and a tool-capable
   `anthropic` invocation still resolves to one;
5. both temp directories are gone afterwards and the real home is untouched.

It spawns real CLIs, so it is an operator-run check, not part of `npm test`.
`npm test` covers the environment construction itself, per provider and per tool
boundary.
