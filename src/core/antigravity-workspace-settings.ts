/**
 * Bounded, runner-owned Antigravity workspace settings for headless research
 * (issue #826, corrected for real `agy` 1.1.x by issue #830,
 * docs/antigravity-workspace-settings.md).
 *
 * This module is pure: it builds, renders, validates, and hashes the workspace
 * settings document, plans the runner-owned overlay installed into the global
 * CLI settings, and evaluates the global CLI trust store. It performs no
 * I/O — every filesystem and git effect lives in
 * `src/handlers/antigravity-workspace.ts`, which is the only caller allowed to
 * write anything.
 *
 * The document this builds is a *permission profile*, not an evidence source.
 * The runner-owned evidence resolver (src/core/repository-evidence.ts,
 * docs/research-evidence-contract.md) remains the authoritative bound on what
 * repository content is served into the prompt and published; nothing here may
 * widen it. See docs/antigravity-workspace-settings.md §5 for the limits of
 * what `agy` permission rules can express and what therefore stays with the
 * resolver.
 */

import { createHash } from "crypto";
import { DEFAULT_DENY_GLOBS } from "./repository-evidence.js";

// ---------------------------------------------------------------------------
// Pinned policy identity (§2)
// ---------------------------------------------------------------------------

/**
 * Policy version recorded in the local artifact. Bump whenever the emitted
 * document's meaning changes (tools allowed, rule syntax, deny composition, or
 * *where* the rules are installed) so an artifact from an old run is never
 * mistaken for the current policy.
 *
 * `/2` was issue #830: permission rules are installed into the global CLI
 * settings, which is the layer real `agy` 1.1.9 actually consults, and trust is
 * read and written as `trustedWorkspaces`.
 *
 * `/3` is issue #832: the *tool surface* (`tools.core`, `tools.exclude`,
 * `mcpServers`, `autoAccept`) is installed into that same global layer, so a
 * command-capable tool is never registered for the agent to select in the first
 * place. Under `/2` those keys lived only in the workspace document — the file
 * `agy` 1.1.9 ignores — so the CLI still offered a command tool, the model
 * selected it, and headless mode auto-denied it after the fact.
 */
export const WORKSPACE_SETTINGS_POLICY_VERSION = "research-readonly/3";

/**
 * The Antigravity settings schema this profile targets. Everything in this
 * module — the document keys, the tool names, the rule syntax, the trust
 * container — is pinned to this literal. A CLI that no longer speaks it is a
 * fail-closed compatibility error (`schema-drift` / `unsupported-cli-version`),
 * never a run under an unverified profile.
 *
 * `@2` was the schema observed on `agy` 1.1.9: `trustedWorkspaces` as an array of
 * absolute paths, and permission rules honoured from the global settings file.
 *
 * `@3` adds the assertion issue #832 rests on: the tool-registration keys
 * (`tools.core`, `tools.exclude`, `mcpServers`, `autoAccept`) are honoured from
 * that same global settings file, and are the layer that decides which tools
 * exist for the model to select. The pin is bumped rather than reused because
 * `@2` implicitly claimed the workspace document's tool block did that job, and
 * it does not.
 */
export const ANTIGRAVITY_SETTINGS_SCHEMA_PIN = "antigravity-cli/settings@3";

/**
 * The `agy` versions this schema pin has been reconciled against (issue #830).
 *
 * The pin below is a *verified* range, not a guess: 1.1.9 is the version whose
 * configuration loading and trust representation this module was corrected for.
 * A CLI outside the range fails closed (`unsupported-cli-version`) rather than
 * running under a profile whose meaning the runner cannot state — widening the
 * range is a documentation change first (§6.3).
 */
export const SUPPORTED_CLI_VERSION_RANGE = {
  minInclusive: "1.1.9",
  maxExclusive: "2.0.0",
} as const;

/** Workspace-relative location `agy` reads. Only this filename is recognized;
 * there is no `settings.local.json` layer. */
export const WORKSPACE_SETTINGS_DIR = ".gemini";
export const WORKSPACE_SETTINGS_FILENAME = "settings.json";
export const WORKSPACE_SETTINGS_RELATIVE_PATH = `${WORKSPACE_SETTINGS_DIR}/${WORKSPACE_SETTINGS_FILENAME}`;

/**
 * The minimum tool set needed to enumerate, read, and search evidence. Every
 * entry is read-only: none writes, edits, executes, spawns, uploads, or reaches
 * the network.
 */
export const RESEARCH_ALLOWED_TOOLS: readonly string[] = [
  "glob",
  "list_directory",
  "read_file",
  "read_many_files",
  "search_file_content",
];

/**
 * Explicitly denied by name as well as omitted from the allow set, so a future
 * default-allow change in the CLI cannot silently re-admit them.
 */
export const RESEARCH_DENIED_TOOLS: readonly string[] = [
  "google_web_search",
  "replace",
  "run_shell_command",
  "save_memory",
  "web_fetch",
  "write_file",
];

/**
 * Alias forms of tool names accepted by the `tools.core` / `tools.exclude`
 * vocabulary of the Gemini-CLI-lineage settings schema (issue #832).
 *
 * The lists above are the *tool* names — the identifiers permission rules and
 * the model's tool calls use. The same schema has always accepted the
 * implementing class name as a second spelling in the registration lists
 * (`ShellTool` for `run_shell_command`, `ReadFileTool` for `read_file`, …), and
 * issue #832's working diagnosis is that the runner may have been naming the
 * command tool in a spelling the installed build does not match.
 *
 * Listing both spellings is safe in both directions and is what makes the
 * registration robust against exactly that:
 *
 * - an entry in `exclude` that matches no tool is inert, so a spelling the
 *   installed build does not use costs nothing, while a *missing* one would
 *   silently leave a command tool registered; and
 * - an entry in `core` that matches no tool registers nothing, so the extra
 *   spellings widen the surface by exactly zero tools — they only make the
 *   allow-list match the read-only tools under either spelling.
 *
 * These are additions to the pinned vocabulary, never replacements: the tool
 * names remain what every permission rule, artifact, and prompt states.
 */
export const RESEARCH_ALLOWED_TOOL_ALIASES: readonly string[] = [
  "GlobTool",
  "GrepTool",
  "LSTool",
  "ReadFileTool",
  "ReadManyFilesTool",
];

/**
 * Every spelling of a command/process-capable tool the runner refuses to
 * register (issue #832).
 *
 * Pinned separately from the rest of the denied set and asserted by its own
 * regression test, because this is the class the real failure was in: a research
 * run that can select any of these produces `permission-denied/command` and no
 * findings, and the remedy is never to grant one.
 */
export const COMMAND_CAPABLE_TOOL_NAMES: readonly string[] = [
  "run_shell_command",
  "ShellTool",
];

/** Alias spellings of the denied write/edit/network/memory/command tools. */
export const RESEARCH_DENIED_TOOL_ALIASES: readonly string[] = [
  "EditTool",
  "MemoryTool",
  "ShellTool",
  "WebFetchTool",
  "WebSearchTool",
  "WriteFileTool",
];

/**
 * The `tools.core` allow-list the runner registers: the read-only tools under
 * every spelling the pinned schema accepts.
 *
 * This is a *positive* list, which is what makes the boundary independent of
 * whatever the installed build calls its command tool (issue #832): a tool that
 * is not named here is not registered, so it cannot be offered to the model,
 * selected, and then auto-denied.
 */
export const RESEARCH_TOOL_SURFACE_CORE: readonly string[] = [
  ...RESEARCH_ALLOWED_TOOLS,
  ...RESEARCH_ALLOWED_TOOL_ALIASES,
];

/** The `tools.exclude` list the runner registers: defence in depth behind the
 * positive list above, under every spelling. */
export const RESEARCH_TOOL_SURFACE_EXCLUDE: readonly string[] = [
  ...RESEARCH_DENIED_TOOLS,
  ...RESEARCH_DENIED_TOOL_ALIASES,
];

/**
 * Tools whose results carry file *content* rather than only path names. The
 * sensitive/generated deny globs are expanded against these (§4.2): a name-only
 * tool cannot leak file bytes, and expanding every glob across every tool
 * multiplies the rule count without changing what content is reachable.
 */
export const CONTENT_SURFACING_TOOLS: readonly string[] = [
  "read_file",
  "read_many_files",
  "search_file_content",
];

/**
 * Keys the emitted document is allowed to contain (§2).
 *
 * `coreTools` / `excludeTools` are the *legacy* spelling of the same
 * registration `tools.core` / `tools.exclude` carries (issue #832). Both are
 * emitted because which pair a given build honours is precisely what this issue
 * could not settle against the installed binary: a build that knows only one
 * ignores the other, they are generated from the same lists so they can never
 * disagree, and the failure mode of the guess being wrong is a run with no tools
 * (fail-closed) rather than one with a shell.
 */
export const KNOWN_SETTINGS_KEYS: readonly string[] = [
  "autoAccept",
  "coreTools",
  "excludeTools",
  "mcpServers",
  "permissions",
  "tools",
];

/** Upper bound on emitted permission rules. A profile that needs more than this
 * is a configuration error, not a run under a rule set nobody can audit. */
export const MAX_PERMISSION_RULES = 1_024;

/** Upper bound on operator-supplied deny/generated globs folded into the
 * profile. Keeps the emitted rule count reviewable. */
export const MAX_OPERATOR_GLOBS = 32;

// ---------------------------------------------------------------------------
// Refusals (§6)
// ---------------------------------------------------------------------------

export type WorkspaceSettingsRefusalReason =
  | "workspace-root-not-absolute"
  | "workspace-root-unrepresentable"
  | "workspace-root-unresolvable"
  | "settings-path-escapes-workspace"
  | "settings-dir-symlink"
  | "settings-symlink"
  | "settings-tracked-by-git"
  | "settings-not-ignored"
  | "settings-write-verification-failed"
  | "settings-replaced-before-launch"
  | "workspace-dirty-after-write"
  | "workspace-not-trusted"
  | "workspace-distrusted"
  | "trust-store-unreadable"
  | "trust-store-inside-workspace"
  | "git-probe-failed"
  | "rule-budget-exceeded"
  | "operator-glob-budget-exceeded"
  | "unvetted-cli-binary"
  | "schema-drift"
  | "cli-version-unreadable"
  | "unsupported-cli-version"
  | "global-settings-not-canonical"
  | "global-settings-locked"
  | "global-overlay-contended"
  | "global-overlay-journal-damaged"
  | "global-overlay-release-failed"
  | "global-settings-write-failed";

/**
 * A refusal to prepare the workspace. `reason` is a fixed literal from the
 * closed vocabulary above and is public-safe on its own; `detail` may carry
 * operator context (never file contents, never a secret) and is written only to
 * local artifacts.
 */
export class AntigravityWorkspaceSettingsError extends Error {
  readonly reason: WorkspaceSettingsRefusalReason;
  readonly detail: string | undefined;

  constructor(reason: WorkspaceSettingsRefusalReason, detail?: string) {
    super(`Antigravity workspace settings refused: ${reason}`);
    this.name = "AntigravityWorkspaceSettingsError";
    this.reason = reason;
    this.detail = detail;
  }
}

/** Fixed, public-safe operator guidance per refusal reason — no path, no
 * content, no CLI output is ever interpolated. */
const REFUSAL_GUIDANCE: Record<WorkspaceSettingsRefusalReason, string> = {
  "workspace-root-not-absolute": "the research workspace root is not an absolute path",
  "workspace-root-unrepresentable": "the research workspace root cannot be expressed as a permission-rule path scope",
  "workspace-root-unresolvable": "the research workspace root could not be resolved to a real directory",
  "settings-path-escapes-workspace": "the workspace settings path resolved outside the research workspace",
  "settings-dir-symlink": "the workspace settings directory is a symlink",
  "settings-symlink": "the workspace settings file is a symlink",
  "settings-tracked-by-git": "the workspace settings file is tracked by Git",
  "settings-not-ignored": "the workspace settings file could not be made Git-ignored",
  "settings-write-verification-failed": "the generated workspace settings file did not verify after writing",
  "settings-replaced-before-launch": "the prepared workspace settings file no longer matched the generated profile when the agent was launched",
  "workspace-dirty-after-write": "preparing the workspace settings would leave the worktree dirty",
  "workspace-not-trusted": "the research workspace is not trusted by the Antigravity CLI",
  "workspace-distrusted": "the research workspace is explicitly distrusted by the Antigravity CLI",
  "trust-store-unreadable": "the Antigravity CLI trust store could not be read",
  "trust-store-inside-workspace": "the Antigravity CLI trust store is located inside the research workspace",
  "git-probe-failed": "a read-only Git check on the research workspace failed",
  "rule-budget-exceeded": "the generated permission profile exceeds the permitted rule budget",
  "operator-glob-budget-exceeded": "the configured evidence globs exceed the permitted profile budget",
  "unvetted-cli-binary": "the research agent binary is operator-overridden, so its permission schema cannot be vouched for",
  "schema-drift": "the pinned Antigravity settings schema or permission vocabulary no longer matches",
  "cli-version-unreadable": "the installed Antigravity CLI did not report a version the runner could parse",
  "unsupported-cli-version": "the installed Antigravity CLI version is outside the range this permission schema was reconciled against",
  "global-settings-not-canonical": "the configured Antigravity CLI settings file is not the store the installed CLI loads, so a prepared profile would not apply to the run",
  "global-settings-locked": "the Antigravity CLI settings file is locked by another process",
  "global-overlay-contended": "another research workspace held the runner-owned permission entries in the Antigravity CLI settings file for the whole wait",
  "global-overlay-journal-damaged": "a runner-owned permission journal beside the Antigravity CLI settings file is unreadable, so the entries it records cannot be released automatically",
  "global-overlay-release-failed": "the runner-owned permission entries could not be removed from the Antigravity CLI settings file after the run",
  "global-settings-write-failed": "the runner-owned permission entries could not be written to the Antigravity CLI settings file",
};

/**
 * The public failure string for a refusal. Republished verbatim in the
 * research-failure GitHub comment and Slack notification, so it carries the
 * fixed reason literal and its fixed description only.
 */
export function publicWorkspaceSettingsMessage(reason: WorkspaceSettingsRefusalReason): string {
  return (
    `Research cannot run: the Antigravity workspace permission profile could not be prepared — `
    + `${REFUSAL_GUIDANCE[reason]} (reason: ${reason}). `
    + `Bounded diagnostics were recorded in the local run artifacts.`
  );
}

// ---------------------------------------------------------------------------
// Installed-CLI compatibility gate (§6.3, issue #830)
// ---------------------------------------------------------------------------

/** A parsed `major.minor.patch` triple. Pre-release and build metadata are
 * ignored: they do not change which settings schema the build speaks. */
export type CliVersion = readonly [number, number, number];

function parseVersionLiteral(literal: string): CliVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(literal);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Extract the version from whatever `agy --version` printed.
 *
 * The first `x.y.z` token in the output is taken, which is what every observed
 * build prints (`1.1.9`, or a banner line containing it). Anything with no such
 * token is `null` — an unparseable answer is a refusal (`cli-version-unreadable`)
 * and never an assumption that the installed CLI is compatible.
 */
export function parseCliVersion(output: string): CliVersion | null {
  const match = /\b(\d+\.\d+\.\d+)\b/.exec(output);
  if (!match) return null;
  return parseVersionLiteral(match[1]);
}

function compareVersions(a: CliVersion, b: CliVersion): number {
  for (let i = 0; i < 3; i++) {
    const left = a[i] as number;
    const right = b[i] as number;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** Whether the parsed version falls inside `SUPPORTED_CLI_VERSION_RANGE`. */
export function isSupportedCliVersion(version: CliVersion): boolean {
  const min = parseVersionLiteral(SUPPORTED_CLI_VERSION_RANGE.minInclusive) as CliVersion;
  const max = parseVersionLiteral(SUPPORTED_CLI_VERSION_RANGE.maxExclusive) as CliVersion;
  return compareVersions(version, min) >= 0 && compareVersions(version, max) < 0;
}

/**
 * Gate the run on the installed CLI's version and return the normalized
 * `x.y.z` string for the local artifact.
 *
 * This is the check #826 lacked: its schema pin was never confronted with the
 * installed binary, so `agy` 1.1.9 could silently ignore the profile the runner
 * had "verified". Version drift now fails closed with a diagnostic naming both
 * the observed version and the reconciled range, which is the actionable form of
 * "re-verify the pin".
 */
export function assertSupportedCliVersion(output: string): string {
  const version = parseCliVersion(output);
  if (version === null) {
    throw new AntigravityWorkspaceSettingsError(
      "cli-version-unreadable",
      "no x.y.z version token was found in the CLI version output",
    );
  }
  const literal = version.join(".");
  if (!isSupportedCliVersion(version)) {
    throw new AntigravityWorkspaceSettingsError(
      "unsupported-cli-version",
      `installed Antigravity CLI ${literal} is outside the reconciled range `
      + `>=${SUPPORTED_CLI_VERSION_RANGE.minInclusive} <${SUPPORTED_CLI_VERSION_RANGE.maxExclusive} `
      + `for schema ${ANTIGRAVITY_SETTINGS_SCHEMA_PIN}; re-verify docs/antigravity-workspace-settings.md §6.3 before widening it`,
    );
  }
  return literal;
}

// ---------------------------------------------------------------------------
// Document construction (§4)
// ---------------------------------------------------------------------------

export interface AntigravityWorkspaceSettings {
  permissions: { allow: string[]; deny: string[] };
  tools: { core: string[]; exclude: string[] };
  /** The legacy spelling of `tools.core` (issue #832); always identical to it. */
  coreTools: string[];
  /** The legacy spelling of `tools.exclude`; always identical to it. */
  excludeTools: string[];
  autoAccept: false;
  mcpServers: Record<string, never>;
}

export interface BuildWorkspaceSettingsInput {
  /** Absolute, normalized real path of the research workspace root. */
  workspaceRoot: string;
  /** `session.research.evidence.denyGlobs` — folded into the profile's deny rules. */
  denyGlobs?: readonly string[] | undefined;
  /** `session.research.evidence.generatedGlobs` — folded in for the same reason. */
  generatedGlobs?: readonly string[] | undefined;
}

/**
 * Characters that would make a workspace root ambiguous inside a
 * `tool(path)` rule: glob metacharacters, the rule's own delimiters, and
 * anything that cannot survive a single-line JSON string cleanly. A workspace
 * whose path contains one of these is refused rather than scoped approximately
 * — an approximate scope is a broader scope.
 */
const UNREPRESENTABLE_ROOT_CHARS = /[*?[\]{}()!,\n\r\t\\]/;

function assertRepresentableRoot(workspaceRoot: string): void {
  if (!workspaceRoot.startsWith("/")) {
    throw new AntigravityWorkspaceSettingsError("workspace-root-not-absolute");
  }
  if (workspaceRoot === "/" || workspaceRoot.endsWith("/")) {
    throw new AntigravityWorkspaceSettingsError("workspace-root-unrepresentable", "root must be a non-root directory without a trailing separator");
  }
  if (workspaceRoot.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new AntigravityWorkspaceSettingsError("workspace-root-unrepresentable", "root must be normalized");
  }
  if (UNREPRESENTABLE_ROOT_CHARS.test(workspaceRoot)) {
    throw new AntigravityWorkspaceSettingsError("workspace-root-unrepresentable", "root contains a character that cannot be scoped in a permission rule");
  }
}

/**
 * Expand one evidence deny glob into absolute, workspace-scoped rule paths.
 *
 * A recursive-prefix glob (the `**`-then-separator shape the evidence deny
 * floor uses) matches both at the root and at any depth, so it becomes two
 * rules — a single depth-anchored rule would leave the root copy readable and
 * a single root rule would leave every nested copy readable; every other glob
 * is anchored under the root as written. Globs are never rewritten beyond this
 * anchoring — a rule that does not mean what the evidence floor means would be
 * a silently different boundary.
 */
function denyGlobRulePaths(workspaceRoot: string, glob: string): string[] {
  const trimmed = glob.trim();
  if (trimmed.length === 0) return [];
  const anchored = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const paths = [`${workspaceRoot}/${anchored}`];
  if (anchored.startsWith("**/")) {
    paths.push(`${workspaceRoot}/${anchored.slice(3)}`);
  }
  return paths;
}

function rule(tool: string, path?: string): string {
  return path === undefined ? tool : `${tool}(${path})`;
}

/**
 * Build the complete permitted configuration for one headless research run.
 *
 * The document is generated whole: repository-provided settings are never read,
 * merged, or consulted. Deny rules are emitted alongside the allow rules so the
 * profile states its boundary explicitly instead of relying on omission.
 */
export function buildResearchWorkspaceSettings(input: BuildWorkspaceSettingsInput): AntigravityWorkspaceSettings {
  const workspaceRoot = input.workspaceRoot;
  assertRepresentableRoot(workspaceRoot);

  const operatorGlobs = [...(input.denyGlobs ?? []), ...(input.generatedGlobs ?? [])];
  if (operatorGlobs.length > MAX_OPERATOR_GLOBS) {
    throw new AntigravityWorkspaceSettingsError(
      "operator-glob-budget-exceeded",
      `${operatorGlobs.length} operator globs exceed the ${MAX_OPERATOR_GLOBS} permitted`,
    );
  }

  // Allow: the read-only tool set, each scoped to the resolved workspace root.
  // Both the root itself and its subtree are listed so enumerating the
  // workspace does not require a separate, broader rule.
  const allow = new Set<string>();
  for (const tool of RESEARCH_ALLOWED_TOOLS) {
    allow.add(rule(tool, workspaceRoot));
    allow.add(rule(tool, `${workspaceRoot}/**`));
  }

  // Deny: every write/execute/network tool by name, plus the evidence deny
  // floor and the operator's deny/generated globs expanded across the
  // content-surfacing tools (§4.2).
  const deny = new Set<string>();
  for (const tool of RESEARCH_DENIED_TOOLS) {
    deny.add(rule(tool));
  }
  const denyGlobs = [...DEFAULT_DENY_GLOBS, ...operatorGlobs];
  for (const glob of denyGlobs) {
    for (const path of denyGlobRulePaths(workspaceRoot, glob)) {
      for (const tool of CONTENT_SURFACING_TOOLS) {
        deny.add(rule(tool, path));
      }
    }
  }

  const settings: AntigravityWorkspaceSettings = {
    permissions: { allow: [...allow].sort(), deny: [...deny].sort() },
    tools: { core: [...RESEARCH_TOOL_SURFACE_CORE], exclude: [...RESEARCH_TOOL_SURFACE_EXCLUDE] },
    coreTools: [...RESEARCH_TOOL_SURFACE_CORE],
    excludeTools: [...RESEARCH_TOOL_SURFACE_EXCLUDE],
    autoAccept: false,
    mcpServers: {},
  };

  const ruleCount = settings.permissions.allow.length + settings.permissions.deny.length;
  if (ruleCount > MAX_PERMISSION_RULES) {
    throw new AntigravityWorkspaceSettingsError(
      "rule-budget-exceeded",
      `${ruleCount} rules exceed the ${MAX_PERMISSION_RULES} permitted`,
    );
  }

  validateWorkspaceSettingsDocument(settings, workspaceRoot);
  return settings;
}

/**
 * Fail-closed validation of a generated document against the pinned schema and
 * permission vocabulary (§6.2).
 *
 * Every key, tool name, and rule is checked against the pins above, and every
 * path-bearing rule must be scoped to the resolved workspace root. A profile
 * that drifted — a renamed tool, an unknown key, a rule that escaped the
 * workspace — is a `schema-drift` refusal, so a run never proceeds under a
 * profile whose meaning the runner cannot state.
 */
export function validateWorkspaceSettingsDocument(
  settings: AntigravityWorkspaceSettings,
  workspaceRoot: string,
): void {
  const keys = Object.keys(settings).sort();
  for (const key of keys) {
    if (!KNOWN_SETTINGS_KEYS.includes(key)) {
      throw new AntigravityWorkspaceSettingsError("schema-drift", `unknown settings key: ${key}`);
    }
  }
  if (settings.autoAccept !== false) {
    throw new AntigravityWorkspaceSettingsError("schema-drift", "autoAccept must be false");
  }
  if (Object.keys(settings.mcpServers).length !== 0) {
    throw new AntigravityWorkspaceSettingsError("schema-drift", "mcpServers must be empty");
  }
  const known = new Set([...RESEARCH_ALLOWED_TOOLS, ...RESEARCH_DENIED_TOOLS]);
  const scope = `${workspaceRoot}/`;
  for (const [list, entries] of [
    ["allow", settings.permissions.allow],
    ["deny", settings.permissions.deny],
  ] as const) {
    for (const entry of entries) {
      const match = /^([a-z_]+)(?:\((.*)\))?$/.exec(entry);
      if (!match) {
        throw new AntigravityWorkspaceSettingsError("schema-drift", `malformed permission rule in ${list}`);
      }
      // The path group is optional, so it is genuinely absent for a
      // tool-name-only deny rule.
      const tool: string = match[1];
      const path: string | undefined = match[2];
      if (!known.has(tool)) {
        throw new AntigravityWorkspaceSettingsError("schema-drift", `unknown permission tool name: ${tool}`);
      }
      if (list === "allow" && !RESEARCH_ALLOWED_TOOLS.includes(tool)) {
        throw new AntigravityWorkspaceSettingsError("schema-drift", `tool is not allowed by policy: ${tool}`);
      }
      if (path !== undefined && path !== workspaceRoot && !path.startsWith(scope)) {
        throw new AntigravityWorkspaceSettingsError("schema-drift", `permission rule escapes the workspace scope in ${list}`);
      }
      if (list === "allow" && path === undefined) {
        throw new AntigravityWorkspaceSettingsError("schema-drift", "allow rules must be scoped to the workspace root");
      }
    }
  }
  // The registration lists carry the alias spellings as well as the tool names
  // (issue #832), so they are checked against the surface vocabulary; the
  // permission rules above stay on the tool names alone. Both key spellings are
  // checked, and required to agree: a document whose two registrations differ
  // would mean different things to two builds of the same CLI.
  for (const [core, exclude] of [
    [settings.tools.core, settings.tools.exclude],
    [settings.coreTools, settings.excludeTools],
  ] as const) {
    for (const tool of core) {
      if (!RESEARCH_TOOL_SURFACE_CORE.includes(tool)) {
        throw new AntigravityWorkspaceSettingsError("schema-drift", `unknown core tool: ${tool}`);
      }
    }
    for (const tool of exclude) {
      if (!RESEARCH_TOOL_SURFACE_EXCLUDE.includes(tool)) {
        throw new AntigravityWorkspaceSettingsError("schema-drift", `unknown excluded tool: ${tool}`);
      }
    }
    // Every command-capable spelling must be absent from the registration
    // allow-list and named in the exclusion list. This is the invariant the
    // whole layer exists for, so it is asserted on the built document rather
    // than left to follow from how the lists above were composed.
    for (const tool of COMMAND_CAPABLE_TOOL_NAMES) {
      if (core.includes(tool)) {
        throw new AntigravityWorkspaceSettingsError("schema-drift", `command-capable tool registered as core: ${tool}`);
      }
      if (!exclude.includes(tool)) {
        throw new AntigravityWorkspaceSettingsError("schema-drift", `command-capable tool is not excluded: ${tool}`);
      }
    }
  }
  if (
    canonicalJson(settings.tools.core) !== canonicalJson(settings.coreTools)
    || canonicalJson(settings.tools.exclude) !== canonicalJson(settings.excludeTools)
  ) {
    throw new AntigravityWorkspaceSettingsError("schema-drift", "the two tool registrations disagree");
  }
}

/** Deterministic on-disk form: stable key order (construction order), two-space
 * indent, trailing newline — so the same policy always hashes identically. */
export function renderWorkspaceSettings(settings: AntigravityWorkspaceSettings): string {
  return JSON.stringify(settings, null, 2) + "\n";
}

export function workspaceSettingsSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Runner-owned global permission overlay (§2.5, issue #830)
// ---------------------------------------------------------------------------

/**
 * The rules the runner installs into the *global* CLI settings.
 *
 * Issue #830's finding: `agy` 1.1.9 does not apply workspace
 * `.gemini/settings.json` permission rules to a headless tool request, so the
 * bounded grants have to live in the global settings file the CLI actually
 * consults. Only *path-scoped* rules are ever installed there:
 *
 * - allow rules, every one scoped to the exact research workspace, and
 * - deny rules that carry a workspace-scoped path (the evidence deny floor and
 *   the operator globs).
 *
 * The unscoped, tool-name-only deny *rules* stay in the workspace document: a
 * global deny rule would sit in the operator's permission lists, which the
 * overlay otherwise only appends workspace-scoped entries to. Nothing is lost by
 * omitting them — the overlay grants no write, command, network, or credential
 * tool at all, and the operator's own allow rules are suspended for its lifetime
 * (`suspendOperatorAllow`).
 *
 * What #830 left out, and issue #832 adds, is the *registration* half: the
 * `tools` / `mcpServers` / `autoAccept` keys (`surface` below). Those are what
 * decide which tools the CLI offers the model at all, and they were only ever
 * written to the workspace document — the file `agy` 1.1.9 ignores. Installing
 * them globally does change what tools a concurrent `agy` invocation on the same
 * machine has for the duration of the run, and that is accepted deliberately:
 * the change is strictly narrowing, it is journalled, and the alternative is a
 * research run that keeps selecting a command tool it can never be granted. The
 * overlay is already exclusive to one workspace at a time for the same class of
 * reason (§2.5).
 */
export interface RunnerPermissionOverlay {
  allow: string[];
  deny: string[];
  /**
   * The non-permission half of the generated profile — the keys that decide
   * which tools *exist* for the model to select (§2.6, issue #832).
   *
   * Installed into the same global store as the rules above, for the same
   * reason: it is the layer the CLI reads. Under the previous policy these keys
   * lived only in the workspace document, so `agy` 1.1.9 still registered its
   * whole default tool set, the model selected a command tool, and headless mode
   * auto-denied it after the fact — a run that produced no findings for a
   * capability the profile never intended to offer.
   */
  surface: Record<string, unknown>;
}

/**
 * Global settings keys the overlay takes over for its lifetime (§2.6).
 *
 * Each decides capability rather than merely scoping it, so leaving an
 * operator's value in place would leave the research invocation holding it:
 *
 * - `tools` registers the tool set (and, in this schema, can carry
 *   command-backed tool discovery), so it is replaced with the read-only
 *   registration;
 * - `coreTools` / `excludeTools` say the same thing under the legacy spelling,
 *   so an operator's copy of either would otherwise survive in whichever pair
 *   the installed build reads;
 * - `mcpServers` is a second, subprocess-backed tool source that a `tools.core`
 *   allow-list does not reach, so it is emptied; and
 * - `autoAccept` would approve whatever a tool asks for without a prompt, so it
 *   is pinned to `false`.
 *
 * Like the suspended `allow` rules, this is a *narrowing* change to a shared
 * file: another process on the machine sees fewer capabilities while a research
 * run is in flight, never more, and the operator's own values are journalled and
 * restored by the last overlay out.
 */
export const SUSPENDED_GLOBAL_SURFACE_KEYS: readonly string[] = [
  "autoAccept",
  "coreTools",
  "excludeTools",
  "mcpServers",
  "tools",
];

/**
 * The values the overlay installs for those keys, taken verbatim from the
 * validated profile so the global store states exactly the surface the workspace
 * document states.
 */
export function buildGlobalSurfaceOverlay(settings: AntigravityWorkspaceSettings): Record<string, unknown> {
  return {
    autoAccept: settings.autoAccept,
    coreTools: [...settings.coreTools],
    excludeTools: [...settings.excludeTools],
    mcpServers: { ...settings.mcpServers },
    tools: { core: [...settings.tools.core], exclude: [...settings.tools.exclude] },
  };
}

/**
 * Order-independent JSON identity, used to tell "still exactly what this run
 * installed" from "something else wrote this key".
 *
 * Object keys are sorted, so a store an operator re-serialised with a different
 * key order still reads as unchanged; arrays keep their order, because a
 * reordered list is a different document as far as anything reading it is
 * concerned.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * One suspended top-level key. An absent `value` records that the operator's
 * store did not carry the key at all, so restoring it means removing it again
 * rather than writing a `null`.
 */
export interface SuspendedSurfaceKey {
  key: string;
  value?: unknown;
}

/** What one overlay did to the surface keys: what it wrote, and what it found. */
export interface OverlaySurfaceRecord {
  installed: Record<string, unknown>;
  suspended: SuspendedSurfaceKey[];
}

/**
 * Derive the global overlay from the validated workspace document.
 *
 * Every emitted rule is re-checked against the workspace scope here as well:
 * this is the set that lands in a file shared with unrelated user configuration,
 * so an unscoped or escaping rule is drift, not something to install.
 */
export function buildGlobalPermissionOverlay(
  settings: AntigravityWorkspaceSettings,
  workspaceRoot: string,
): RunnerPermissionOverlay {
  assertRepresentableRoot(workspaceRoot);
  const scope = `${workspaceRoot}/`;
  const scoped = (entries: readonly string[]): string[] =>
    entries.filter((entry) => {
      const match = /^([a-z_]+)\((.*)\)$/.exec(entry);
      if (!match) return false;
      const path: string = match[2];
      if (path !== workspaceRoot && !path.startsWith(scope)) {
        throw new AntigravityWorkspaceSettingsError("schema-drift", "overlay rule escapes the workspace scope");
      }
      return true;
    });
  const allow = scoped(settings.permissions.allow);
  if (allow.length !== settings.permissions.allow.length) {
    throw new AntigravityWorkspaceSettingsError("schema-drift", "allow rules must be scoped to the workspace root");
  }
  // Re-validated here as well as at construction: this is the set that lands in
  // the file the CLI reads, so a surface that registered a command-capable tool
  // must never get that far (issue #832).
  const surface = buildGlobalSurfaceOverlay(settings);
  const registered = [
    ...(surface["tools"] as { core: string[] }).core,
    ...(surface["coreTools"] as string[]),
  ];
  for (const tool of COMMAND_CAPABLE_TOOL_NAMES) {
    if (registered.includes(tool)) {
      throw new AntigravityWorkspaceSettingsError("schema-drift", `command-capable tool registered as core: ${tool}`);
    }
  }
  return { allow, deny: scoped(settings.permissions.deny), surface };
}

/** What one runner-owned overlay installation claims in the global document. */
export interface OverlayClaim {
  allow: readonly string[];
  deny: readonly string[];
  /**
   * Whether this still-installed overlay must be assumed to be holding the
   * runner's tool surface in place (§2.6, issue #832 review).
   *
   * Separate from the permission claim above, because the two lifecycles are not
   * the same one. A journal written before the surface existed carries rules but
   * no `surface` record: it neither installed the read-only registration nor can
   * restore the operator's values for it. Suppressing the releasing run's
   * restoration on the strength of such a co-tenant — which is what counting
   * permission claims does — leaves the registration in the global store with
   * *nothing* able to take it back out, since the legacy run's own release has no
   * record either. Later runs then read it as operator configuration and preserve
   * it, so the leak is permanent. A rolling upgrade is exactly when that overlap
   * happens.
   *
   * Absent means "unknown", which is treated as holding: the damaged-journal
   * claims the release path synthesizes name no rules and no surface, and a live
   * run may be relying on the registration, so leaving it installed is the
   * fail-closed direction there.
   */
  holdsSurface?: boolean;
}

/**
 * Whether `permissions` and its lists existed *before any* runner overlay was
 * installed. Recorded so the last release can restore the document's original
 * shape instead of leaving empty containers behind.
 */
export interface OverlayContainerState {
  permissionsWasAbsent: boolean;
  allowWasAbsent: boolean;
  denyWasAbsent: boolean;
}

/** The runner-owned record of one installed overlay — the crash-safe half of
 * the lifecycle. `foreign` rules were already in the document and owned by the
 * user, so they are claimed but never removed. */
export interface OverlayJournalCore {
  claim: { allow: string[]; deny: string[] };
  foreign: { allow: string[]; deny: string[] };
  containers: OverlayContainerState;
  /**
   * The operator's own `allow` rules, lifted out of the document for the
   * overlay's lifetime and restored verbatim by the last release (§2.5).
   *
   * Optional so a journal written before this field existed still reverts: an
   * absent list simply restores nothing, which never widens anything.
   */
  suspended?: { allow: string[] };
  /**
   * The tool-surface keys this overlay took over, and the operator's own values
   * for them (§2.6, issue #832).
   *
   * Optional for the same reason as `suspended`: a journal written before the
   * field existed restores nothing, which leaves the store exactly as that
   * build left it.
   */
  surface?: OverlaySurfaceRecord;
}

interface GlobalPermissions {
  present: boolean;
  allowPresent: boolean;
  denyPresent: boolean;
  allow: string[];
  deny: string[];
  /** Every key of the `permissions` object other than `allow`/`deny`, preserved. */
  rest: Record<string, unknown>;
}

/**
 * Read the global document's permission container.
 *
 * Anything that is not the pinned shape (a non-object `permissions`, a list that
 * is not an array of strings) is drift: the runner never guesses at, repairs, or
 * overwrites a container it does not recognize, because unrelated user
 * configuration lives in the same file.
 */
function readGlobalPermissions(document: Record<string, unknown>): GlobalPermissions {
  const container = document["permissions"];
  if (container === undefined || container === null) {
    return { present: false, allowPresent: false, denyPresent: false, allow: [], deny: [], rest: {} };
  }
  if (typeof container !== "object" || Array.isArray(container)) {
    throw new AntigravityWorkspaceSettingsError("schema-drift", "global permissions must be an object");
  }
  const obj = container as Record<string, unknown>;
  const list = (key: "allow" | "deny"): { present: boolean; entries: string[] } => {
    const value = obj[key];
    if (value === undefined || value === null) return { present: false, entries: [] };
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new AntigravityWorkspaceSettingsError("schema-drift", `global permissions.${key} must be an array of strings`);
    }
    return { present: true, entries: [...(value as string[])] };
  };
  const allow = list("allow");
  const deny = list("deny");
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (key !== "allow" && key !== "deny") rest[key] = obj[key];
  }
  return {
    present: true,
    allowPresent: allow.present,
    denyPresent: deny.present,
    allow: allow.entries,
    deny: deny.entries,
    rest,
  };
}

function composeGlobalDocument(
  document: Record<string, unknown>,
  permissions: GlobalPermissions,
  allow: string[],
  deny: string[],
  containers: OverlayContainerState,
): Record<string, unknown> {
  const keepAllow = allow.length > 0 || !containers.allowWasAbsent;
  const keepDeny = deny.length > 0 || !containers.denyWasAbsent;
  const rebuilt: Record<string, unknown> = { ...permissions.rest };
  if (keepAllow) rebuilt["allow"] = allow;
  if (keepDeny) rebuilt["deny"] = deny;
  const next = { ...document };
  if (Object.keys(rebuilt).length === 0 && containers.permissionsWasAbsent) {
    delete next["permissions"];
    return next;
  }
  next["permissions"] = rebuilt;
  return next;
}

/**
 * Plan the installation of one runner-owned overlay into the global document.
 *
 * `liveClaims` are the journals of overlays that are still installed, oldest
 * first. They make the lifecycle safe for concurrent runs in two ways:
 *
 * - a rule another live run installed is *not* treated as pre-existing user
 *   configuration, so the last run to release still removes it; and
 * - the original container shape, and the suspended operator `allow` list, are
 *   inherited from the oldest live journal, so whoever releases last restores
 *   the document the first run found.
 *
 * INVARIANT (issue #830 review): every journal passed here must belong to the
 * *same* research workspace as `overlay`. The global store is the layer `agy`
 * applies, so composing this overlay on top of a live overlay for a different
 * workspace would hand this invocation read access to that workspace's tree and
 * break the exact-workspace boundary. Enforcing it is the caller's job, because
 * only the caller (`installGlobalOverlay`) knows which workspace a journal
 * belongs to; it serializes different workspaces against each other instead of
 * merging their grants.
 *
 * INVARIANT (issue #832 review): the caller must also have checked
 * `detectSurfaceHandoffDrift` against this very document and reported no changed
 * keys. The tool-surface record inherited below is only the operator's if nobody
 * has written those keys since the co-tenant installed.
 *
 * The operator's own `allow` rules are *suspended* for the overlay's lifetime
 * (see `suspendOperatorAllow`). Everything else — unrelated keys, the whole
 * `deny` list, their order — is preserved: the runner's rules are appended,
 * never merged into or reordered around what is already there.
 */
export function applyPermissionOverlay(
  document: Record<string, unknown>,
  overlay: RunnerPermissionOverlay,
  liveClaims: readonly OverlayJournalCore[] = [],
): { document: Record<string, unknown>; journal: OverlayJournalCore } {
  const permissions = readGlobalPermissions(document);
  const oldest = liveClaims[0];
  const containers: OverlayContainerState = oldest
    ? { ...oldest.containers }
    : {
        permissionsWasAbsent: !permissions.present,
        allowWasAbsent: !permissions.allowPresent,
        denyWasAbsent: !permissions.denyPresent,
      };

  const claimedByOthers = (list: "allow" | "deny"): Set<string> => {
    const claimed = new Set<string>();
    for (const journal of liveClaims) {
      for (const rule of journal.claim[list]) claimed.add(rule);
    }
    return claimed;
  };

  const merge = (
    existing: string[],
    rules: readonly string[],
    list: "allow" | "deny",
  ): { entries: string[]; foreign: string[] } => {
    const present = new Set(existing);
    const others = claimedByOthers(list);
    const entries = [...existing];
    const foreign: string[] = [];
    for (const rule of rules) {
      if (present.has(rule)) {
        // Already in the document: user-owned unless another live run put it
        // there, in which case it stays runner-owned and is released with the
        // last claim on it.
        if (!others.has(rule)) foreign.push(rule);
        continue;
      }
      entries.push(rule);
      present.add(rule);
    }
    return { entries, foreign };
  };

  const suspended = suspendOperatorAllow(permissions.allow, claimedByOthers("allow"), oldest);
  const allow = merge(suspended.retained, overlay.allow, "allow");
  const deny = merge(permissions.deny, overlay.deny, "deny");
  const surface = installSurface(document, overlay.surface, oldest);
  return {
    document: withSurface(
      composeGlobalDocument(document, permissions, allow.entries, deny.entries, containers),
      overlay.surface,
    ),
    journal: {
      claim: { allow: [...overlay.allow], deny: [...overlay.deny] },
      foreign: { allow: allow.foreign, deny: deny.foreign },
      containers,
      suspended: { allow: suspended.suspended },
      surface,
    },
  };
}

/** Write the runner's surface keys over whatever the document carried. */
function withSurface(
  document: Record<string, unknown>,
  surface: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...document };
  for (const key of SUSPENDED_GLOBAL_SURFACE_KEYS) {
    next[key] = surface[key];
  }
  return next;
}

/**
 * Surface keys a live overlay can no longer account for (issue #832 review).
 *
 * `installSurface` inherits the operator's values from the oldest live journal
 * instead of re-reading a document that already carries the runner's
 * registration. That inheritance is only faithful while the document still holds
 * what a live overlay installed. If something else wrote one of these keys since
 * — an operator editing `tools`, `mcpServers`, or `autoAccept` mid-run — then the
 * value in the document is theirs and *no* journal records it: this installation
 * would write the runner surface over it, and the last overlay out would restore
 * the value from before their edit, discarding it. That is the opposite of what
 * `restoreSurface` guarantees for the single-overlay case, where a key the
 * overlay no longer recognizes is left exactly as found.
 *
 * Capturing the current value here would only cover *this* journal; the
 * co-tenant's is already on disk carrying the stale value, and it may be the one
 * that releases last. So the changed keys are reported instead and the caller
 * refuses the handoff — backing off is safe and self-resolving, because the
 * co-tenant's own release leaves the edit in place and the retry after it records
 * the operator's real values.
 *
 * A live journal from before the surface existed records nothing to inherit, so
 * it cannot be stale (`[]`). But if the *oldest* is such a journal while a newer
 * live one did install a surface, the document holds that runner registration
 * with nothing naming it as the operator's — every key is reported, for the same
 * fail-closed reason.
 */
export function detectSurfaceHandoffDrift(
  document: Record<string, unknown>,
  liveClaims: readonly OverlayJournalCore[] = [],
): string[] {
  const installed = liveClaims
    .map((journal) => journal.surface?.installed)
    .filter((record): record is Record<string, unknown> => record !== undefined);
  if (installed.length === 0) return [];
  if (liveClaims[0]?.surface === undefined) return [...SUSPENDED_GLOBAL_SURFACE_KEYS];
  const changed: string[] = [];
  for (const key of SUSPENDED_GLOBAL_SURFACE_KEYS) {
    const current = canonicalJson(
      Object.prototype.hasOwnProperty.call(document, key) ? document[key] : undefined,
    );
    // Any live overlay's registration accounts for the value: co-tenants may
    // have installed different surfaces (a profile changed between runs), and
    // the document carries whichever went in last.
    if (!installed.some((record) => canonicalJson(record[key]) === current)) changed.push(key);
  }
  return changed;
}

/**
 * Record what the surface keys held before this overlay took them over.
 *
 * The operator's values are read from the document only when no overlay is
 * already installed. While one is, the document carries the *runner's* surface,
 * so recording it again would journal the read-only registration as if it were
 * the operator's configuration and the last release would "restore" it
 * permanently — the same inheritance rule `suspendOperatorAllow` follows, for
 * the same reason.
 *
 * Inheriting is faithful only for a document no one has edited since the
 * co-tenant installed; `detectSurfaceHandoffDrift` is what the caller checks
 * that with, before this overlay replaces values nothing would put back.
 */
function installSurface(
  document: Record<string, unknown>,
  surface: Record<string, unknown>,
  oldest: OverlayJournalCore | undefined,
): OverlaySurfaceRecord {
  const inherited = oldest?.surface?.suspended;
  const suspended: SuspendedSurfaceKey[] = inherited !== undefined
    ? inherited.map((entry) => ({ ...entry }))
    : SUSPENDED_GLOBAL_SURFACE_KEYS.map((key) =>
        Object.prototype.hasOwnProperty.call(document, key)
          ? { key, value: document[key] }
          : { key },
      );
  const installed: Record<string, unknown> = {};
  for (const key of SUSPENDED_GLOBAL_SURFACE_KEYS) installed[key] = surface[key];
  return { installed, suspended };
}

/**
 * Put the operator's surface keys back, once the last overlay is out.
 *
 * A key whose value is no longer the one this overlay installed was written by
 * something else while the run was in flight; it is left exactly as found rather
 * than overwritten with a value that is now stale — the same rule the
 * suspended-`allow` restoration follows for rules added mid-run. Restoring a key
 * the operator did not have means removing it, not writing a null.
 */
function restoreSurface(
  document: Record<string, unknown>,
  record: OverlaySurfaceRecord,
): Record<string, unknown> {
  const next = { ...document };
  for (const entry of record.suspended) {
    const installed = record.installed[entry.key];
    const current = Object.prototype.hasOwnProperty.call(next, entry.key) ? next[entry.key] : undefined;
    if (canonicalJson(current) !== canonicalJson(installed)) continue;
    if (Object.prototype.hasOwnProperty.call(entry, "value")) {
      next[entry.key] = entry.value;
    } else {
      delete next[entry.key];
    }
  }
  return next;
}

/**
 * Lift the operator's own `allow` rules out of the global document for the
 * overlay's lifetime (§2.5, issue #830 review).
 *
 * The global layer is the one headless `agy` actually applies, so any allow rule
 * already in it is *inherited* by the research process: an operator who allows
 * `run_shell_command`, `write_file`, or a path outside this workspace would hand
 * a supposedly read-only invocation the capability to run commands or mutate the
 * repository. The workspace document cannot take that back — its deny rules are
 * exactly what the CLI ignores — so the only place to constrain it is here.
 *
 * Suspension is therefore total: every rule the operator had is removed while an
 * overlay is installed, and the run holds precisely the bounded, workspace-scoped
 * grants the runner can state. The list is journalled and restored verbatim by
 * the last release, and the direction of the temporary change is fail-closed —
 * another process on the machine sees fewer grants during the run, never more.
 *
 * Rules another live overlay installed are not the operator's; they are retained
 * so a concurrent run is never stripped of its own grants, and are released with
 * the last claim on them as before. Once suspension is in effect, the oldest live
 * journal owns the authoritative list; a rule the operator adds mid-run joins it.
 *
 * The list a journal already carries is not re-recorded, but the accounting is by
 * multiplicity rather than by identity (issue #830 review): a store that legally
 * lists the same rule twice is restored with both copies, instead of silently
 * losing one to a set-based "already seen" test. Only the copies an inherited
 * journal already accounts for are skipped.
 */
function suspendOperatorAllow(
  existing: readonly string[],
  claimedByLiveOverlays: ReadonlySet<string>,
  oldest: OverlayJournalCore | undefined,
): { retained: string[]; suspended: string[] } {
  const retained: string[] = [];
  const suspended: string[] = [...(oldest?.suspended?.allow ?? [])];
  const inherited = new Map<string, number>();
  for (const rule of suspended) inherited.set(rule, (inherited.get(rule) ?? 0) + 1);
  for (const rule of existing) {
    if (claimedByLiveOverlays.has(rule)) {
      retained.push(rule);
      continue;
    }
    const carried = inherited.get(rule) ?? 0;
    if (carried > 0) {
      // This copy is already recorded by the journal being inherited from.
      inherited.set(rule, carried - 1);
      continue;
    }
    suspended.push(rule);
  }
  return { retained, suspended };
}

/**
 * Plan the removal of one runner-owned overlay.
 *
 * A claimed rule is removed only when it is runner-owned (not `foreign`) and no
 * *other* still-installed overlay claims it, so a crashed or concurrent run
 * never revokes a live run's grants. Everything else in the document — other
 * keys, other rules, their order — is left exactly as found, and once the last
 * claim is gone the original container shape and the operator's suspended
 * `allow` rules are restored.
 *
 * Removal is counted, not matched by identity (issue #830 review). An overlay
 * installs exactly one copy of each rule it did not already find, and that
 * count is what it may take back out: an operator who adds the same
 * workspace-scoped rule by hand while the overlay is live owns their copy — it
 * is not `foreign`, because it was not there at installation — and a set-based
 * filter would delete it along with the runner's, silently undoing their edit.
 */
export function revertPermissionOverlay(
  document: Record<string, unknown>,
  journal: OverlayJournalCore,
  otherLiveClaims: readonly OverlayClaim[] = [],
): Record<string, unknown> {
  const permissions = readGlobalPermissions(document);
  const strip = (existing: string[], list: "allow" | "deny"): string[] => {
    const others = new Set<string>();
    for (const claim of otherLiveClaims) {
      for (const rule of claim[list]) others.add(rule);
    }
    // How many copies of each rule this overlay added: everything it claimed,
    // less the copies it found already there (`foreign`), and nothing at all for
    // a rule another still-installed overlay is holding.
    const removable = new Map<string, number>();
    for (const rule of journal.claim[list]) {
      if (others.has(rule)) continue;
      removable.set(rule, (removable.get(rule) ?? 0) + 1);
    }
    for (const rule of journal.foreign[list]) {
      const owned = removable.get(rule);
      if (owned === undefined) continue;
      if (owned <= 1) removable.delete(rule);
      else removable.set(rule, owned - 1);
    }
    const kept: string[] = [];
    for (const rule of existing) {
      const owned = removable.get(rule) ?? 0;
      if (owned > 0) {
        removable.set(rule, owned - 1);
        continue;
      }
      kept.push(rule);
    }
    return kept;
  };
  const allow = strip(permissions.allow, "allow");
  // The last overlay out puts the operator's own rules back, ahead of anything
  // added since, in the order they were found. While another overlay is still
  // installed they stay suspended: that journal carries the same list and will
  // restore it when it releases.
  const last = otherLiveClaims.length === 0;
  const suspended = last ? (journal.suspended?.allow ?? []) : [];
  const restored = [...suspended, ...allow.filter((rule) => !suspended.includes(rule))];
  const reverted = composeGlobalDocument(
    document,
    permissions,
    restored,
    strip(permissions.deny, "deny"),
    journal.containers,
  );
  // The tool surface follows a "last overlay out" rule of its own (§2.6): while
  // another overlay is installed the read-only registration stays, because that
  // run is relying on it and its journal carries the same operator values to
  // restore when it releases.
  //
  // "Last" is counted over the overlays that actually hold the surface, not over
  // permission claims (issue #832 review). A co-tenant with no surface record —
  // a journal from before #832, live across a rolling upgrade — is holding
  // nothing and can restore nothing, so deferring to it would strand the
  // registration in the global store permanently. Releasing here instead puts
  // the operator's keys back, which is what that co-tenant's own run was
  // configured against anyway.
  const lastSurface = !otherLiveClaims.some((claim) => claim.holdsSurface !== false);
  if (!lastSurface || journal.surface === undefined) return reverted;
  return restoreSurface(reverted, journal.surface);
}

// ---------------------------------------------------------------------------
// Workspace trust (§3)
// ---------------------------------------------------------------------------

/**
 * Recognized trust container inside the global Antigravity CLI settings: an
 * ARRAY of absolute workspace paths.
 *
 * Issue #830: this is the representation `agy` 1.1.9 actually writes and reads.
 * #826 assumed the `trustedFolders` map below, which made an already-trusted
 * workspace read as untrusted.
 */
export const TRUST_CONTAINER_KEY = "trustedWorkspaces";

/**
 * The legacy map container (`path -> status`) some builds still carry. It is
 * *read* — an operator's existing store keeps working, and an explicit
 * `DO_NOT_TRUST` there still refuses the run — but never written.
 */
export const LEGACY_TRUST_CONTAINER_KEY = "trustedFolders";

/** Pinned status vocabulary of the LEGACY map container. Anything else is
 * schema drift. The current array container carries no status literal. */
export const TRUST_STATUS_EXACT = "TRUST_FOLDER";
export const TRUST_STATUS_PARENT = "TRUST_PARENT";
export const TRUST_STATUS_DISTRUST = "DO_NOT_TRUST";
export const KNOWN_TRUST_STATUSES: readonly string[] = [
  TRUST_STATUS_EXACT,
  TRUST_STATUS_PARENT,
  TRUST_STATUS_DISTRUST,
];

export type WorkspaceTrustStatus = "trusted-exact" | "trusted-parent" | "untrusted" | "distrusted";

/** Which container(s) the evaluated document carried. Recorded so an operator
 * can see whether a store is on the current or the legacy representation. */
export type TrustRepresentation = "trustedWorkspaces" | "trustedFolders" | "both" | "none";

export interface WorkspaceTrustEvaluation {
  status: WorkspaceTrustStatus;
  /** Whether the global settings document carries a recognized trust container. */
  containerPresent: boolean;
  /** Number of entries across the recognized containers (never their paths). */
  entryCount: number;
  representation: TrustRepresentation;
}

/** The current array container: absolute workspace paths, exact trust only. */
function trustedWorkspaces(document: Record<string, unknown>): string[] | null {
  const container = document[TRUST_CONTAINER_KEY];
  if (container === undefined || container === null) return null;
  if (!Array.isArray(container) || container.some((entry) => typeof entry !== "string")) {
    throw new AntigravityWorkspaceSettingsError("schema-drift", `${TRUST_CONTAINER_KEY} must be an array of absolute paths`);
  }
  return [...(container as string[])];
}

/** The legacy map container: absolute path -> pinned status literal. */
function legacyTrustEntries(document: Record<string, unknown>): Record<string, unknown> | null {
  const container = document[LEGACY_TRUST_CONTAINER_KEY];
  if (container === undefined || container === null) return null;
  if (typeof container !== "object" || Array.isArray(container)) {
    throw new AntigravityWorkspaceSettingsError("schema-drift", `${LEGACY_TRUST_CONTAINER_KEY} must be an object map`);
  }
  return container as Record<string, unknown>;
}

function isDescendant(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/**
 * Evaluate whether the exact research workspace is trusted.
 *
 * Both representations are read (§3.1):
 *
 * - `trustedWorkspaces` (current, `agy` 1.1.x) grants trust on an **exact**
 *   entry only. An ancestor entry is deliberately not read as trust — the array
 *   form carries no status literal saying "and everything below", so inferring
 *   one would be the broad parent grant this layer refuses to rely on. The
 *   workspace is registered in its own right instead.
 * - `trustedFolders` (legacy map) keeps its pinned vocabulary, including the
 *   `TRUST_PARENT` entry the CLI itself applies and the explicit `DO_NOT_TRUST`
 *   that refuses the run.
 *
 * Distrust wins over trust wherever it appears.
 */
export function evaluateWorkspaceTrust(
  document: Record<string, unknown>,
  workspaceRoot: string,
): WorkspaceTrustEvaluation {
  const workspaces = trustedWorkspaces(document);
  const legacy = legacyTrustEntries(document);
  const legacyPaths = legacy === null ? [] : Object.keys(legacy);
  const representation: TrustRepresentation =
    workspaces !== null && legacy !== null ? "both"
      : workspaces !== null ? "trustedWorkspaces"
        : legacy !== null ? "trustedFolders"
          : "none";
  const containerPresent = representation !== "none";
  const entryCount = (workspaces?.length ?? 0) + legacyPaths.length;
  const evaluation = (status: WorkspaceTrustStatus): WorkspaceTrustEvaluation =>
    ({ status, containerPresent, entryCount, representation });

  let status: WorkspaceTrustStatus = "untrusted";
  for (const path of legacyPaths) {
    const value = (legacy as Record<string, unknown>)[path];
    if (typeof value !== "string" || !KNOWN_TRUST_STATUSES.includes(value)) {
      throw new AntigravityWorkspaceSettingsError("schema-drift", "unknown trust status value in the global settings trust container");
    }
    if (path === workspaceRoot) {
      if (value === TRUST_STATUS_DISTRUST) return evaluation("distrusted");
      status = value === TRUST_STATUS_EXACT ? "trusted-exact" : "trusted-parent";
    } else if (value === TRUST_STATUS_PARENT && isDescendant(workspaceRoot, path) && status === "untrusted") {
      status = "trusted-parent";
    }
  }
  if (workspaces !== null && workspaces.includes(workspaceRoot)) {
    status = "trusted-exact";
  }
  return evaluation(status);
}

/**
 * Return a copy of the global settings document with the exact workspace root
 * trusted, written in the representation the installed CLI uses
 * (`trustedWorkspaces`).
 *
 * Every other key, the legacy container, and every unrelated trust entry are
 * preserved verbatim; no parent-directory entry is ever added, and an entry
 * that is already there is not duplicated (§3.2).
 */
export function withExactWorkspaceTrust(
  document: Record<string, unknown>,
  workspaceRoot: string,
): Record<string, unknown> {
  const entries = trustedWorkspaces(document) ?? [];
  if (entries.includes(workspaceRoot)) return { ...document };
  return { ...document, [TRUST_CONTAINER_KEY]: [...entries, workspaceRoot] };
}

/**
 * Identify stale trust entries across both representations: recorded paths that
 * no longer resolve to an existing directory. Used by the documented cleanup
 * procedure (docs/antigravity-workspace-settings.md §3.3); never applied
 * automatically, because a temporarily unmounted path is not a revocation.
 */
export function findStaleTrustEntries(
  document: Record<string, unknown>,
  directoryExists: (path: string) => boolean,
): string[] {
  const paths = new Set<string>([
    ...(trustedWorkspaces(document) ?? []),
    ...Object.keys(legacyTrustEntries(document) ?? {}),
  ]);
  return [...paths].filter((path) => !directoryExists(path)).sort();
}

/** Return a copy of the document with the listed trust entries removed from
 * both representations; all other settings are preserved. */
export function withoutTrustEntries(
  document: Record<string, unknown>,
  paths: readonly string[],
): Record<string, unknown> {
  const next = { ...document };
  const workspaces = trustedWorkspaces(document);
  if (workspaces !== null) {
    next[TRUST_CONTAINER_KEY] = workspaces.filter((path) => !paths.includes(path));
  }
  const legacy = legacyTrustEntries(document);
  if (legacy !== null) {
    const remaining: Record<string, unknown> = {};
    for (const key of Object.keys(legacy)) {
      if (!paths.includes(key)) remaining[key] = legacy[key];
    }
    next[LEGACY_TRUST_CONTAINER_KEY] = remaining;
  }
  return next;
}
