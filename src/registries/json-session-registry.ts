import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import type { AgentId } from "../core/task.js";
import { DEFAULT_FLOW } from "../core/assignment.js";
import type {
  AntigravityResearchConfig,
  AssignmentProfile,
  CodexConfig,
  CodexContextModeConfig,
  DependencySyncConfig,
  EnvironmentPrepareConfig,
  FlowRule,
  GiteaLabelMappingStrategy,
  GiteaRepoHostConfig,
  GiteaWorkItemConfig,
  NotificationsConfig,
  ProviderAuthConfig,
  RepoHostProviderConfig,
  RepoHostProviderKind,
  ResearchConfig,
  ResolvedSession,
  SessionConfig,
  SessionRegistry,
  SlackNotificationsConfig,
  WorkItemProviderConfig,
  WorkItemProviderKind,
  WorktreeConfig,
} from "../core/session.js";

export const DEFAULT_SESSIONS_PATH = join(
  homedir(),
  ".config",
  "n8n-ai-cli-loop",
  "sessions.json",
);

const AGENTS = new Set<AgentId>(["claude", "codex", "gemini"]);

const WORK_ITEM_PROVIDERS = new Set<WorkItemProviderKind>([
  "github-issues",
  "gitea-issues",
  "jira",
  "azure-devops",
  "bitbucket",
]);
const REPO_HOST_PROVIDERS = new Set<RepoHostProviderKind>(["github", "gitea", "azure-devops", "bitbucket"]);
const AUTH_MODES = new Set<ProviderAuthConfig["mode"]>(["gh", "github-app", "api-token"]);
const GITEA_LABEL_MAPPINGS = new Set<GiteaLabelMappingStrategy>(["labels"]);

/**
 * Auth keys that would carry raw secret material. Auth config must reference
 * secrets by indirection (see docs/provider-architecture.md), so any of these is
 * rejected with a pointer to the `*Env` / `*Key` indirection forms.
 */
const FORBIDDEN_SECRET_AUTH_KEYS = new Set<string>([
  "appId",
  "installationId",
  "privateKey",
  "privateKeyPath",
  "token",
  "email",
  "password",
  "secret",
  "apiKey",
]);

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A credential-key / keychain reference: a non-empty, whitespace-free identifier
// pointing at an entry in an external secrets source (keychain, secrets manager).
// It is a pointer, never the secret itself.
const CREDENTIAL_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

const DEFAULT_WORK_ITEM_PROVIDER: WorkItemProviderConfig = {
  provider: "github-issues",
  auth: { mode: "gh" },
};
const DEFAULT_REPO_HOST_PROVIDER: RepoHostProviderConfig = {
  provider: "github",
  auth: { mode: "gh" },
};

interface RawSessionsFile {
  sessions?: unknown;
}

export class JsonSessionRegistry implements SessionRegistry {
  readonly #sessionsById: Map<string, ResolvedSession>;
  readonly #sessionsByRepoKey: Map<string, ResolvedSession>;
  readonly #refIndex: Map<string, RefEntry>;

  constructor(readonly path = DEFAULT_SESSIONS_PATH) {
    const { byId, byRepoKey, refIndex } = indexSessions(loadSessions(path));
    this.#sessionsById = byId;
    this.#sessionsByRepoKey = byRepoKey;
    this.#refIndex = refIndex;
  }

  async getSessionById(sessionId: string): Promise<ResolvedSession | undefined> {
    return cloneSession(this.#sessionsById.get(sessionId));
  }

  async getSessionByRepoKey(repoKey: string): Promise<ResolvedSession | undefined> {
    return cloneSession(this.#sessionsByRepoKey.get(repoKey));
  }

  async listSessions(): Promise<ResolvedSession[]> {
    return [...this.#sessionsById.values()].map((session) => cloneSession(session) as ResolvedSession);
  }

  async resolveSessionRef(ref: string): Promise<string> {
    return resolveRefFromIndex(this.#refIndex, ref);
  }
}

/**
 * Resolve a user-facing session reference to the canonical `sessionId` by
 * loading and validating the sessions file at `sessionsPath`. This is the shared
 * resolver used by CLI commands that accept `--session-ref`. It applies the same
 * collision validation as constructing a registry, so an ambiguous registry
 * fails closed here too. Throws if the reference is unknown.
 */
export function resolveSessionRef(sessionsPath: string, ref: string): string {
  const { refIndex } = indexSessions(loadSessions(sessionsPath));
  return resolveRefFromIndex(refIndex, ref);
}

// ---------------------------------------------------------------------------
// Session reference index
//
// A single map keys every user-facing reference (sessionId, sessionNo, alias)
// to the canonical sessionId. Building it validates the issue's rules in one
// pass: any reference that would resolve to two different sessions is rejected
// at construction time, so resolution is always unambiguous and fails closed.
// ---------------------------------------------------------------------------

type RefKind = "sessionId" | "sessionNo" | "alias";

interface RefEntry {
  sessionId: string;
  kind: RefKind;
}

interface SessionIndex {
  byId: Map<string, ResolvedSession>;
  byRepoKey: Map<string, ResolvedSession>;
  refIndex: Map<string, RefEntry>;
}

function indexSessions(sessions: ResolvedSession[]): SessionIndex {
  const byId = new Map<string, ResolvedSession>();
  const byRepoKey = new Map<string, ResolvedSession>();
  for (const session of sessions) {
    if (byId.has(session.sessionId)) {
      throw new Error(`Duplicate sessionId in session registry: ${session.sessionId}`);
    }
    if (byRepoKey.has(session.repoKey)) {
      throw new Error(`Duplicate repoKey in session registry: ${session.repoKey}`);
    }
    byId.set(session.sessionId, session);
    byRepoKey.set(session.repoKey, session);
  }
  return { byId, byRepoKey, refIndex: buildSessionRefIndex(sessions) };
}

function describeRef(key: string, entry: RefEntry): string {
  switch (entry.kind) {
    case "sessionId":
      return `sessionId "${entry.sessionId}"`;
    case "sessionNo":
      return `sessionNo ${key} (session "${entry.sessionId}")`;
    case "alias":
      return `alias "${key}" (session "${entry.sessionId}")`;
  }
}

function buildSessionRefIndex(sessions: ResolvedSession[]): Map<string, RefEntry> {
  const index = new Map<string, RefEntry>();

  const register = (key: string, entry: RefEntry): void => {
    const existing = index.get(key);
    if (existing) {
      // The same session referencing itself through more than one form that
      // collapses to the same key (e.g. an alias equal to its own sessionId) is
      // harmless — both resolve to the same canonical sessionId.
      if (existing.sessionId === entry.sessionId) return;
      throw new Error(
        `Ambiguous session reference "${key}": ${describeRef(key, existing)} and ${describeRef(key, entry)} ` +
          `both resolve to it. Session references (sessionId, sessionNo, aliases) must be unique across the registry.`,
      );
    }
    index.set(key, entry);
  };

  // Register sessionIds first so an alias or sessionNo that collides with
  // another session's id is reported against the id.
  for (const session of sessions) {
    register(session.sessionId, { sessionId: session.sessionId, kind: "sessionId" });
  }
  for (const session of sessions) {
    if (session.sessionNo !== undefined) {
      register(String(session.sessionNo), { sessionId: session.sessionId, kind: "sessionNo" });
    }
    for (const alias of session.aliases ?? []) {
      register(alias, { sessionId: session.sessionId, kind: "alias" });
    }
  }
  return index;
}

function resolveRefFromIndex(index: Map<string, RefEntry>, ref: string): string {
  const entry = index.get(ref);
  if (!entry) {
    throw new Error(
      `Unknown session reference: "${ref}". It does not match any sessionId, sessionNo, or alias in the session registry.`,
    );
  }
  return entry.sessionId;
}

function loadSessions(path: string): ResolvedSession[] {
  if (!existsSync(path)) {
    throw new Error(`Session registry file does not exist: ${path}`);
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as RawSessionsFile;
  if (!Array.isArray(parsed.sessions)) {
    throw new Error("Session registry must contain a sessions array");
  }

  return parsed.sessions.map((session, index) => resolveSession(validateSession(session, index)));
}

function validateSession(value: unknown, index: number): SessionConfig {
  const session = record(value, `sessions[${index}]`);
  const defaults = record(session.defaults, `sessions[${index}].defaults`);
  const labels = record(session.labels, `sessions[${index}].labels`);
  const verification = record(session.verification, `sessions[${index}].verification`);

  const config: SessionConfig = {
    sessionId: requiredString(session.sessionId, `sessions[${index}].sessionId`),
    repoKey: requiredString(session.repoKey, `sessions[${index}].repoKey`),
    repoRoot: requiredString(session.repoRoot, `sessions[${index}].repoRoot`),
    githubRepo: requiredString(session.githubRepo, `sessions[${index}].githubRepo`),
    artifactDir: requiredString(session.artifactDir, `sessions[${index}].artifactDir`),
    ...(session.baseBranch !== undefined
      ? { baseBranch: requiredString(session.baseBranch, `sessions[${index}].baseBranch`) }
      : {}),
    defaults: {
      implementationAgent: agent(defaults.implementationAgent, `sessions[${index}].defaults.implementationAgent`),
      reviewAgent: agent(defaults.reviewAgent, `sessions[${index}].defaults.reviewAgent`),
      researchAgent:
        defaults.researchAgent === undefined
          ? undefined
          : agent(defaults.researchAgent, `sessions[${index}].defaults.researchAgent`),
    },
    verification: stringRecord(verification, `sessions[${index}].verification`),
    labels: {
      ...stringRecord(labels, `sessions[${index}].labels`),
      active: requiredString(labels.active, `sessions[${index}].labels.active`),
      blocked: requiredString(labels.blocked, `sessions[${index}].labels.blocked`),
      readyForHuman: requiredString(labels.readyForHuman, `sessions[${index}].labels.readyForHuman`),
    },
  };

  if (session.sessionNo !== undefined) {
    const sessionNo = session.sessionNo;
    if (typeof sessionNo !== "number" || !Number.isInteger(sessionNo) || sessionNo < 1) {
      throw new Error(`sessions[${index}].sessionNo must be a positive integer`);
    }
    config.sessionNo = sessionNo;
  }

  if (session.aliases !== undefined) {
    if (!Array.isArray(session.aliases)) {
      throw new Error(`sessions[${index}].aliases must be an array of strings`);
    }
    config.aliases = session.aliases.map((alias, i) =>
      requiredString(alias, `sessions[${index}].aliases[${i}]`),
    );
  }

  if (session.workItemProvider !== undefined) {
    config.workItemProvider = validateWorkItemProvider(
      session.workItemProvider,
      `sessions[${index}].workItemProvider`,
    );
  }
  if (session.repoHostProvider !== undefined) {
    config.repoHostProvider = validateRepoHostProvider(
      session.repoHostProvider,
      `sessions[${index}].repoHostProvider`,
    );
  }

  if (session.reviewLoop !== undefined) {
    const reviewLoop = record(session.reviewLoop, `sessions[${index}].reviewLoop`);
    config.reviewLoop = {};
    if (reviewLoop.maxCycles !== undefined) {
      const maxCycles = reviewLoop.maxCycles;
      if (typeof maxCycles !== "number" || !Number.isInteger(maxCycles) || maxCycles < 1) {
        throw new Error(`sessions[${index}].reviewLoop.maxCycles must be a positive integer`);
      }
      config.reviewLoop.maxCycles = maxCycles;
    }
  }

  if (session.conflictResolutionLoop !== undefined) {
    const conflictResolutionLoop = record(session.conflictResolutionLoop, `sessions[${index}].conflictResolutionLoop`);
    config.conflictResolutionLoop = {};
    if (conflictResolutionLoop.maxAttempts !== undefined) {
      const maxAttempts = conflictResolutionLoop.maxAttempts;
      if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new Error(`sessions[${index}].conflictResolutionLoop.maxAttempts must be a positive integer`);
      }
      config.conflictResolutionLoop.maxAttempts = maxAttempts;
    }
    if (conflictResolutionLoop.maxReviewCycles !== undefined) {
      const maxReviewCycles = conflictResolutionLoop.maxReviewCycles;
      if (typeof maxReviewCycles !== "number" || !Number.isInteger(maxReviewCycles) || maxReviewCycles < 1) {
        throw new Error(`sessions[${index}].conflictResolutionLoop.maxReviewCycles must be a positive integer`);
      }
      config.conflictResolutionLoop.maxReviewCycles = maxReviewCycles;
    }
  }

  if (session.worktrees !== undefined) {
    config.worktrees = validateWorktreeConfig(
      session.worktrees,
      `sessions[${index}].worktrees`,
    );
  }

  if (session.dependencySync !== undefined) {
    config.dependencySync = validateDependencySync(
      session.dependencySync,
      `sessions[${index}].dependencySync`,
    );
  }

  if (session.environmentPrepare !== undefined) {
    config.environmentPrepare = validateEnvironmentPrepare(
      session.environmentPrepare,
      `sessions[${index}].environmentPrepare`,
    );
  }

  if (session.codex !== undefined) {
    config.codex = validateCodexConfig(session.codex, `sessions[${index}].codex`);
  }

  if (session.research !== undefined) {
    config.research = validateResearchConfig(session.research, `sessions[${index}].research`);
  }

  if (session.notifications !== undefined) {
    config.notifications = validateNotificationsConfig(
      session.notifications,
      `sessions[${index}].notifications`,
    );
  }

  if (
    session.assignmentProfiles !== undefined ||
    session.flowRules !== undefined ||
    session.defaultFlow !== undefined
  ) {
    validateAssignment(session, config, index);
  }

  if (!isAbsolute(config.repoRoot)) {
    throw new Error(`repoRoot must be an absolute path for session ${config.sessionId}`);
  }
  if (isAbsolute(config.artifactDir)) {
    throw new Error(`artifactDir must be relative to repoRoot for session ${config.sessionId}`);
  }
  if (!/^[^/]+\/[^/]+$/.test(config.githubRepo)) {
    throw new Error(`githubRepo must use owner/name format for session ${config.sessionId}`);
  }
  return config;
}

function resolveSession(config: SessionConfig): ResolvedSession {
  const [githubOwner, githubName] = config.githubRepo.split("/");
  return {
    ...config,
    defaults: { ...config.defaults },
    verification: { ...config.verification },
    labels: { ...config.labels },
    ...(config.aliases ? { aliases: [...config.aliases] } : {}),
    ...(config.dependencySync ? { dependencySync: cloneDependencySync(config.dependencySync) } : {}),
    ...(config.environmentPrepare ? { environmentPrepare: cloneEnvironmentPrepare(config.environmentPrepare) } : {}),
    ...(config.worktrees ? { worktrees: { ...config.worktrees } } : {}),
    ...(config.codex ? { codex: cloneCodexConfig(config.codex) } : {}),
    ...(config.research ? { research: cloneResearchConfig(config.research) } : {}),
    artifactRoot: resolve(config.repoRoot, config.artifactDir),
    githubOwner,
    githubName,
    ...(config.assignmentProfiles ? { assignmentProfiles: cloneAssignmentProfiles(config.assignmentProfiles) } : {}),
    ...(config.flowRules ? { flowRules: cloneFlowRules(config.flowRules) } : {}),
    ...(config.defaultFlow !== undefined ? { defaultFlow: config.defaultFlow } : {}),
    ...(config.notifications ? { notifications: cloneNotificationsConfig(config.notifications) } : {}),
    workItemProvider: config.workItemProvider
      ? cloneProvider(config.workItemProvider)
      : { ...DEFAULT_WORK_ITEM_PROVIDER, auth: { ...DEFAULT_WORK_ITEM_PROVIDER.auth } },
    repoHostProvider: config.repoHostProvider
      ? cloneProvider(config.repoHostProvider)
      : { ...DEFAULT_REPO_HOST_PROVIDER, auth: { ...DEFAULT_REPO_HOST_PROVIDER.auth } },
    // Record whether the operator declared `repoHostProvider` BEFORE the default
    // above masks an omission. Outbox dispatch needs this to honor an explicit
    // `github`/`gh` repo-host config that is byte-identical to the default.
    repoHostProviderConfigured: config.repoHostProvider !== undefined,
  };
}

function cloneProvider<T extends WorkItemProviderConfig | RepoHostProviderConfig>(provider: T): T {
  const cloned = { ...provider, auth: { ...provider.auth } } as T;
  // Both work-item and repo-host providers may carry a non-secret `gitea`
  // connection block; deep-copy it so a resolved session never aliases the raw
  // config (the two block shapes differ but both are flat string records).
  const gitea = (provider as { gitea?: GiteaWorkItemConfig | GiteaRepoHostConfig }).gitea;
  if (gitea) {
    (cloned as { gitea?: GiteaWorkItemConfig | GiteaRepoHostConfig }).gitea = { ...gitea };
  }
  return cloned;
}

/**
 * Validate the dependency-sync block (docs/tool-request-and-dependency-sync.md
 * §3). Structural validation only: it pins the shape (booleans, string arrays, a
 * non-empty command, a positive timeout) but deliberately does NOT enforce
 * package-manager-specific flags on `command`, so the same config shape stays
 * usable for non-npm tools. Safe mode itself is enforced at run time, not here:
 * runDependencySync refuses any command that is not a recognized lockfile-only
 * shape unless the session explicitly opts in via `allowLifecycleScripts`.
 *
 * `enabled` is the documented master switch. A disabled block is a pure runtime
 * no-op (runDependencySync returns early on `!enabled`), so it must load even
 * when written minimally as `{ "enabled": false }`: the execution fields
 * (triggerPaths/expectedOutputs/command) are only meaningful when the sync can
 * run, so they are required only when enabled. Any execution field that IS
 * supplied is still validated even on a disabled block, so typos surface early.
 */
function validateDependencySync(value: unknown, path: string): DependencySyncConfig {
  const obj = record(value, path);

  if (typeof obj.enabled !== "boolean") {
    throw new Error(`${path}.enabled must be a boolean`);
  }

  const requireExecutionFields = obj.enabled;

  const config: DependencySyncConfig = {
    enabled: obj.enabled,
    triggerPaths:
      requireExecutionFields || obj.triggerPaths !== undefined
        ? stringArray(obj.triggerPaths, `${path}.triggerPaths`, { nonEmpty: requireExecutionFields })
        : [],
    expectedOutputs:
      requireExecutionFields || obj.expectedOutputs !== undefined
        ? stringArray(obj.expectedOutputs, `${path}.expectedOutputs`, { nonEmpty: false })
        : [],
    command:
      requireExecutionFields || obj.command !== undefined
        ? requiredString(obj.command, `${path}.command`)
        : "",
  };

  if (obj.allowLifecycleScripts !== undefined) {
    if (typeof obj.allowLifecycleScripts !== "boolean") {
      throw new Error(`${path}.allowLifecycleScripts must be a boolean`);
    }
    config.allowLifecycleScripts = obj.allowLifecycleScripts;
  }

  if (obj.timeoutMs !== undefined) {
    if (typeof obj.timeoutMs !== "number" || !Number.isInteger(obj.timeoutMs) || obj.timeoutMs < 1) {
      throw new Error(`${path}.timeoutMs must be a positive integer`);
    }
    config.timeoutMs = obj.timeoutMs;
  }

  return config;
}

function cloneDependencySync(config: DependencySyncConfig): DependencySyncConfig {
  return {
    ...config,
    triggerPaths: [...config.triggerPaths],
    expectedOutputs: [...config.expectedOutputs],
  };
}

/**
 * Validate the environment-prepare block (docs/environment-prepare-contract.md,
 * issue #510). Structural validation only: it pins the shape (boolean, a
 * non-empty command when enabled, optional string arrays, optional boolean, a
 * positive timeout) but deliberately does NOT enforce package-manager-specific
 * flags on `command`, so the same config shape stays usable for non-npm tools.
 *
 * `enabled` is the documented master switch. A disabled block is a pure runtime
 * no-op, so it must load even when written minimally as `{ "enabled": false }`:
 * the execution fields are only required when enabled. Any execution field that
 * IS supplied is still validated even on a disabled block, so typos surface early.
 */
function validateEnvironmentPrepare(value: unknown, path: string): EnvironmentPrepareConfig {
  const obj = record(value, path);

  if (obj.enabled !== undefined && typeof obj.enabled !== "boolean") {
    throw new Error(`${path}.enabled must be a boolean`);
  }

  const enabled = obj.enabled !== undefined ? (obj.enabled as boolean) : false;
  const requireExecutionFields = enabled;

  const config: EnvironmentPrepareConfig = {
    enabled,
    command:
      requireExecutionFields || obj.command !== undefined
        ? requiredString(obj.command, `${path}.command`)
        : "",
  };

  if (obj.cacheKeyFiles !== undefined) {
    config.cacheKeyFiles = stringArray(obj.cacheKeyFiles, `${path}.cacheKeyFiles`, { nonEmpty: false });
  }

  if (obj.allowLifecycleScripts !== undefined) {
    if (typeof obj.allowLifecycleScripts !== "boolean") {
      throw new Error(`${path}.allowLifecycleScripts must be a boolean`);
    }
    config.allowLifecycleScripts = obj.allowLifecycleScripts;
  }

  if (obj.timeoutMs !== undefined) {
    if (typeof obj.timeoutMs !== "number" || !Number.isInteger(obj.timeoutMs) || obj.timeoutMs < 1) {
      throw new Error(`${path}.timeoutMs must be a positive integer`);
    }
    config.timeoutMs = obj.timeoutMs;
  }

  return config;
}

function cloneEnvironmentPrepare(config: EnvironmentPrepareConfig): EnvironmentPrepareConfig {
  return {
    ...config,
    ...(config.cacheKeyFiles ? { cacheKeyFiles: [...config.cacheKeyFiles] } : {}),
  };
}

/**
 * Validate the per-issue worktree block (docs/per-issue-worktrees.md). `enabled`
 * is the required master switch; an optional `root` overrides the managed state
 * root and, when present, must be an absolute path so it can never resolve inside
 * committed source.
 */
function validateWorktreeConfig(value: unknown, path: string): WorktreeConfig {
  const obj = record(value, path);
  if (typeof obj.enabled !== "boolean") {
    throw new Error(`${path}.enabled must be a boolean`);
  }
  const config: WorktreeConfig = { enabled: obj.enabled };
  if (obj.root !== undefined) {
    const root = requiredString(obj.root, `${path}.root`);
    if (!isAbsolute(root)) {
      throw new Error(`${path}.root must be an absolute path`);
    }
    config.root = root;
  }
  return config;
}

/**
 * Validate the Codex runtime block (docs/codex-context-mode.md). Structural
 * validation only: `enabled` is the master switch; when enabled, at least one of
 * `config` (verified `-c key=value` overrides) or `profile` must be present so a
 * billed Codex run never proceeds without an invocation form. The exact
 * context-mode key is operator-supplied and NOT guessed here, so config entries
 * are only required to look like `key=value`.
 */
function validateCodexConfig(value: unknown, path: string): CodexConfig {
  const obj = record(value, path);
  const config: CodexConfig = {};
  if (obj.contextMode !== undefined) {
    config.contextMode = validateCodexContextMode(obj.contextMode, `${path}.contextMode`);
  }
  return config;
}

function validateCodexContextMode(value: unknown, path: string): CodexContextModeConfig {
  const obj = record(value, path);
  if (typeof obj.enabled !== "boolean") {
    throw new Error(`${path}.enabled must be a boolean`);
  }

  const result: CodexContextModeConfig = { enabled: obj.enabled };

  let config: string[] | undefined;
  if (obj.config !== undefined) {
    config = stringArray(obj.config, `${path}.config`, { nonEmpty: false }).map((entry, i) => {
      const trimmed = entry.trim();
      if (!/^[^=\s]+=.+$/.test(trimmed)) {
        throw new Error(`${path}.config[${i}] must be a key=value override (e.g. context_mode=on)`);
      }
      return trimmed;
    });
    result.config = config;
  }

  let profile: string | undefined;
  if (obj.profile !== undefined) {
    profile = requiredString(obj.profile, `${path}.profile`).trim();
    result.profile = profile;
  }

  // When enabled, an invocation form is mandatory — otherwise the run would have
  // nothing to pass to Codex and would fail closed at resolution time anyway.
  if (obj.enabled && (config === undefined || config.length === 0) && (profile === undefined || profile.length === 0)) {
    throw new Error(
      `${path} is enabled but no invocation form is configured; set ${path}.config (e.g. ["context_mode=on"]) and/or ${path}.profile`,
    );
  }

  return result;
}

function cloneCodexConfig(config: CodexConfig): CodexConfig {
  return {
    ...(config.contextMode
      ? {
          contextMode: {
            ...config.contextMode,
            ...(config.contextMode.config ? { config: [...config.contextMode.config] } : {}),
          },
        }
      : {}),
  };
}

function validateResearchConfig(value: unknown, path: string): ResearchConfig {
  const obj = record(value, path);
  const config: ResearchConfig = {};
  if (obj.antigravity !== undefined) {
    config.antigravity = validateAntigravityResearchConfig(obj.antigravity, `${path}.antigravity`);
  }
  return config;
}

function validateAntigravityResearchConfig(value: unknown, path: string): AntigravityResearchConfig {
  const obj = record(value, path);
  const config: AntigravityResearchConfig = {};
  if (obj.model !== undefined) {
    const model = requiredString(obj.model, `${path}.model`);
    config.model = model;
  }
  return config;
}

function cloneResearchConfig(config: ResearchConfig): ResearchConfig {
  return {
    ...(config.antigravity ? { antigravity: { ...config.antigravity } } : {}),
  };
}

function stringArray(value: unknown, path: string, opts: { nonEmpty: boolean }): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of strings`);
  }
  if (opts.nonEmpty && value.length === 0) {
    throw new Error(`${path} must be a non-empty array of strings`);
  }
  return value.map((entry, i) => requiredString(entry, `${path}[${i}]`));
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function stringRecord(value: Record<string, unknown>, path: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, requiredString(entry, `${path}.${key}`)]),
  );
}

function agent(value: unknown, path: string): AgentId {
  const id = requiredString(value, path) as AgentId;
  if (!AGENTS.has(id)) {
    throw new Error(`${path} must be one of: ${[...AGENTS].join(", ")}`);
  }
  return id;
}

const OPTIONAL_PROFILE_ROLES = ["conflict_resolution", "research"] as const;

/**
 * Validate the assignment block (assignmentProfiles + flowRules + defaultFlow)
 * and copy the validated, defaulted shape onto `config`. See
 * docs/assignment-profiles.md.
 *
 * Agent values are only required to be valid AgentIds — this layer does NOT
 * verify that a chosen agent is actually supported by the phase that will run
 * it (e.g. a codex-only implementation profile is accepted here and fails closed
 * at execution time), so new agent implementations can be added later without a
 * config-format change.
 */
function validateAssignment(session: Record<string, unknown>, config: SessionConfig, index: number): void {
  const base = `sessions[${index}]`;

  const profiles = validateAssignmentProfiles(session.assignmentProfiles, `${base}.assignmentProfiles`);
  const { rules, defaultRuleFlow } = validateFlowRules(
    session.flowRules,
    `${base}.flowRules`,
    config.sessionId,
  );

  // Every flow referenced by a rule must have a profile entry, except the
  // built-in `code` flow which is covered by the preserved built-in profile.
  for (const rule of rules) {
    if (rule.flow !== DEFAULT_FLOW && !(rule.flow in profiles)) {
      throw new Error(
        `${base}.flowRules references flow "${rule.flow}" which has no entry in assignmentProfiles`,
      );
    }
  }

  let defaultFlow: string | undefined;
  if (session.defaultFlow !== undefined) {
    defaultFlow = requiredString(session.defaultFlow, `${base}.defaultFlow`);
    if (defaultFlow !== defaultRuleFlow) {
      throw new Error(
        `${base}.defaultFlow ("${defaultFlow}") must agree with the default flow rule ("${defaultRuleFlow}")`,
      );
    }
  }

  config.assignmentProfiles = profiles;
  config.flowRules = rules;
  config.defaultFlow = defaultFlow ?? defaultRuleFlow;
}

function validateAssignmentProfiles(value: unknown, path: string): Record<string, AssignmentProfile> {
  // Profiles are optional; an omitted block relies on the built-in `code`
  // profile, so treat it as an empty map rather than rejecting the config.
  if (value === undefined) return {};
  const obj = record(value, path);
  return Object.fromEntries(
    Object.entries(obj).map(([flow, profile]) => [
      flow,
      validateAssignmentProfile(profile, `${path}.${flow}`),
    ]),
  );
}

function validateAssignmentProfile(value: unknown, path: string): AssignmentProfile {
  const obj = record(value, path);
  const profile: AssignmentProfile = {
    implementation: agent(obj.implementation, `${path}.implementation`),
    review: agent(obj.review, `${path}.review`),
  };
  for (const role of OPTIONAL_PROFILE_ROLES) {
    if (obj[role] !== undefined) {
      profile[role] = agent(obj[role], `${path}.${role}`);
    }
  }
  return profile;
}

/**
 * Validate the ordered flow rules. Each rule is either a labels rule
 * (`{ flow, labels: [...] }`, matching when all listed labels are present) or
 * the single terminal `{ flow, default: true }`. Exactly one default is
 * required. Returns the validated rules and the default rule's flow.
 *
 * When no rules are configured a built-in `code` default rule is synthesized so
 * every task resolves to the `code` flow (which must then have a profile).
 */
function validateFlowRules(
  value: unknown,
  path: string,
  sessionId: string,
): { rules: FlowRule[]; defaultRuleFlow: string } {
  if (value === undefined) {
    return { rules: [{ flow: DEFAULT_FLOW, default: true }], defaultRuleFlow: DEFAULT_FLOW };
  }
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }

  const rules: FlowRule[] = value.map((rule, i) => {
    const r = record(rule, `${path}[${i}]`);
    const flow = requiredString(r.flow, `${path}[${i}].flow`);
    const isDefault = r.default === true;
    if (r.default !== undefined && typeof r.default !== "boolean") {
      throw new Error(`${path}[${i}].default must be a boolean`);
    }
    if (isDefault) {
      if (r.labels !== undefined) {
        throw new Error(`${path}[${i}] is the default rule and must not also list labels`);
      }
      return { flow, default: true };
    }
    if (!Array.isArray(r.labels) || r.labels.length === 0) {
      throw new Error(`${path}[${i}].labels must be a non-empty array (or set default: true)`);
    }
    const labels = r.labels.map((l, j) => requiredString(l, `${path}[${i}].labels[${j}]`));
    return { flow, labels };
  });

  const defaults = rules.filter((r) => r.default);
  if (defaults.length !== 1) {
    throw new Error(
      `${path} must contain exactly one rule with "default": true for session ${sessionId} (found ${defaults.length})`,
    );
  }
  // The default rule is the terminal fallback: resolveFlow scans label rules in
  // order and only falls back to the default last, so a default placed before a
  // label rule would let that label rule override the fallback. Require it last.
  if (!rules[rules.length - 1].default) {
    throw new Error(
      `${path} default rule must be the last rule for session ${sessionId}`,
    );
  }
  return { rules, defaultRuleFlow: defaults[0].flow };
}

// ---------------------------------------------------------------------------
// Notifications config validation and clone (issue #465)
// ---------------------------------------------------------------------------

/**
 * Validate the `notifications` block. Currently only `slack` is recognized;
 * additional providers can be added here without a config-format change.
 */
function validateNotificationsConfig(value: unknown, path: string): NotificationsConfig {
  const obj = record(value, path);
  const config: NotificationsConfig = {};
  if (obj.slack !== undefined) {
    config.slack = validateSlackNotificationsConfig(obj.slack, `${path}.slack`);
  }
  return config;
}

/**
 * Validate the Slack notifications block. `enabled` is the master switch;
 * `webhookUrlEnv` is the name of the env var that holds the webhook URL and
 * must be a valid env var identifier — the URL itself is resolved at dispatch
 * time and never stored in sessions.json.
 */
function validateSlackNotificationsConfig(value: unknown, path: string): SlackNotificationsConfig {
  const obj = record(value, path);
  if (typeof obj.enabled !== "boolean") {
    throw new Error(`${path}.enabled must be a boolean`);
  }
  // `webhookUrlEnv` is the env var NAME, not the URL. Validate it as an env var
  // identifier so no webhook URL (which could embed a token in the path) can be
  // stored directly in sessions.json.
  const webhookUrlEnv = envVarName(obj.webhookUrlEnv, `${path}.webhookUrlEnv`);
  return { enabled: obj.enabled, webhookUrlEnv };
}

function cloneNotificationsConfig(config: NotificationsConfig): NotificationsConfig {
  return {
    ...(config.slack ? { slack: { ...config.slack } } : {}),
  };
}

function cloneAssignmentProfiles(
  profiles: Record<string, AssignmentProfile>,
): Record<string, AssignmentProfile> {
  return Object.fromEntries(Object.entries(profiles).map(([k, v]) => [k, { ...v }]));
}

function cloneFlowRules(rules: FlowRule[]): FlowRule[] {
  return rules.map((r) => ({ ...r, ...(r.labels ? { labels: [...r.labels] } : {}) }));
}

function cloneSession(session: ResolvedSession | undefined): ResolvedSession | undefined {
  if (!session) return undefined;
  return {
    ...session,
    defaults: { ...session.defaults },
    verification: { ...session.verification },
    labels: { ...session.labels },
    ...(session.aliases ? { aliases: [...session.aliases] } : {}),
    ...(session.reviewLoop ? { reviewLoop: { ...session.reviewLoop } } : {}),
    ...(session.conflictResolutionLoop ? { conflictResolutionLoop: { ...session.conflictResolutionLoop } } : {}),
    ...(session.dependencySync ? { dependencySync: cloneDependencySync(session.dependencySync) } : {}),
    ...(session.environmentPrepare ? { environmentPrepare: cloneEnvironmentPrepare(session.environmentPrepare) } : {}),
    ...(session.worktrees ? { worktrees: { ...session.worktrees } } : {}),
    ...(session.codex ? { codex: cloneCodexConfig(session.codex) } : {}),
    ...(session.research ? { research: cloneResearchConfig(session.research) } : {}),
    ...(session.baseBranch !== undefined ? { baseBranch: session.baseBranch } : {}),
    ...(session.assignmentProfiles ? { assignmentProfiles: cloneAssignmentProfiles(session.assignmentProfiles) } : {}),
    ...(session.flowRules ? { flowRules: cloneFlowRules(session.flowRules) } : {}),
    ...(session.defaultFlow !== undefined ? { defaultFlow: session.defaultFlow } : {}),
    ...(session.notifications ? { notifications: cloneNotificationsConfig(session.notifications) } : {}),
    workItemProvider: cloneProvider(session.workItemProvider),
    repoHostProvider: cloneProvider(session.repoHostProvider),
    repoHostProviderConfigured: session.repoHostProviderConfigured,
  };
}

function validateWorkItemProvider(value: unknown, path: string): WorkItemProviderConfig {
  const obj = record(value, path);
  const provider = requiredString(obj.provider, `${path}.provider`) as WorkItemProviderKind;
  if (!WORK_ITEM_PROVIDERS.has(provider)) {
    throw new Error(`${path}.provider must be one of: ${[...WORK_ITEM_PROVIDERS].join(", ")}`);
  }
  const auth = validateProviderAuth(obj.auth, `${path}.auth`);

  if (provider === "gitea-issues") {
    // Gitea has no wired runtime provider yet (issue #362 pins only its config +
    // auth shape). Require `api-token` auth: a Gitea instance is unreachable via
    // the GitHub `gh`/`github-app` runners, and accepting `gh` here would let the
    // GitHub-only code paths (intake listing, GraphQL dependency checks) read the
    // GitHub repo under the operator's `gh` session instead of failing closed.
    // With `api-token`, every `resolveGhRunner` call for this session throws, so
    // the runtime fails clearly rather than silently falling back to GitHub.
    if (auth.mode !== "api-token") {
      throw new Error(
        `${path}.auth.mode must be "api-token" for the gitea-issues provider (got "${auth.mode}")`,
      );
    }
    // The Gitea API token is resolved at runtime via `resolveGiteaToken`, but no
    // production credential-key resolver is wired for Gitea: the intake,
    // dependency-check, and outbox-dispatch entrypoints all call it without a
    // `resolveKey`. A `tokenKey` reference would therefore validate here yet fail
    // at runtime, so reject it now — mirroring the `github-app` `*Key` rejection —
    // until a resolver lands; only the `tokenEnv` form is usable today. Other
    // `api-token` providers (e.g. `jira`) keep accepting `tokenKey`.
    if (auth.tokenKey !== undefined) {
      throw new Error(
        `${path}.auth.tokenKey is not supported yet for the gitea-issues provider: reference the API token by environment variable name (${path}.auth.tokenEnv) instead`,
      );
    }
    if (obj.gitea === undefined) {
      throw new Error(`${path}.gitea is required for the gitea-issues provider`);
    }
    return { provider, auth, gitea: validateGiteaConfig(obj.gitea, `${path}.gitea`) };
  }

  if (obj.gitea !== undefined) {
    throw new Error(`${path}.gitea is only valid for the gitea-issues provider`);
  }
  return { provider, auth };
}

/**
 * Validate the non-secret Gitea connection block. No secret material is allowed
 * here: the API token is referenced by indirection through the sibling `auth`
 * block. `baseUrl` must be an http(s) URL with no embedded `user:password@`
 * userinfo, so a password can never be smuggled into `sessions.json` through the
 * URL (and the rejection never echoes the value).
 */
function validateGiteaConfig(value: unknown, path: string): GiteaWorkItemConfig {
  const obj = record(value, path);
  const config: GiteaWorkItemConfig = {
    baseUrl: giteaBaseUrl(obj.baseUrl, `${path}.baseUrl`),
    owner: requiredString(obj.owner, `${path}.owner`),
    repo: requiredString(obj.repo, `${path}.repo`),
  };

  if (obj.apiPath !== undefined) {
    const apiPath = requiredString(obj.apiPath, `${path}.apiPath`);
    if (!apiPath.startsWith("/")) {
      throw new Error(`${path}.apiPath must be an absolute path starting with "/" (got "${apiPath}")`);
    }
    config.apiPath = apiPath;
  }

  if (obj.labelMapping !== undefined) {
    const labelMapping = requiredString(obj.labelMapping, `${path}.labelMapping`) as GiteaLabelMappingStrategy;
    if (!GITEA_LABEL_MAPPINGS.has(labelMapping)) {
      throw new Error(`${path}.labelMapping must be one of: ${[...GITEA_LABEL_MAPPINGS].join(", ")}`);
    }
    config.labelMapping = labelMapping;
  }

  return config;
}

function giteaBaseUrl(value: unknown, path: string): string {
  const raw = requiredString(value, path);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${path} must be a valid http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${path} must be an http(s) URL`);
  }
  // Embedded userinfo (user:password@host) would carry a raw credential in
  // sessions.json — exactly what the secret-indirection rule forbids. Reject it
  // WITHOUT echoing the value, so any password in the URL never reaches the error.
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      `${path} must not embed credentials (user:password@host); reference the API token via auth.tokenEnv instead`,
    );
  }
  return raw;
}

function validateRepoHostProvider(value: unknown, path: string): RepoHostProviderConfig {
  const obj = record(value, path);
  const provider = requiredString(obj.provider, `${path}.provider`) as RepoHostProviderKind;
  if (!REPO_HOST_PROVIDERS.has(provider)) {
    throw new Error(`${path}.provider must be one of: ${[...REPO_HOST_PROVIDERS].join(", ")}`);
  }
  // The production Gitea repo-host paths (CLI + handlers) build
  // `defaultGiteaClientBuilder()` with no credential-key resolver, so an
  // `api-token` `tokenKey` reference would validate here and then fail at runtime.
  // Reject it for `gitea` until a resolver is wired, mirroring the GitHub App path.
  const auth = validateProviderAuth(obj.auth, `${path}.auth`, provider !== "gitea");

  if (provider === "gitea") {
    // A Gitea repo host is reached over the Gitea REST API, never the GitHub
    // `gh`/`github-app` runners. Require `api-token` auth so a session can never
    // accidentally publish PRs/PR comments to the GitHub repo under the
    // operator's `gh` session: any non-`api-token` mode is rejected here, and the
    // runtime Gitea provider only understands an api-token client.
    if (auth.mode !== "api-token") {
      throw new Error(
        `${path}.auth.mode must be "api-token" for the gitea provider (got "${auth.mode}")`,
      );
    }
    if (obj.gitea === undefined) {
      throw new Error(`${path}.gitea is required for the gitea provider`);
    }
    return { provider, auth, gitea: validateGiteaRepoHostConfig(obj.gitea, `${path}.gitea`) };
  }

  if (obj.gitea !== undefined) {
    throw new Error(`${path}.gitea is only valid for the gitea provider`);
  }
  return { provider, auth };
}

/**
 * Validate the non-secret Gitea repo-host connection block. Mirrors
 * {@link validateGiteaConfig} (work-item side) but without `labelMapping`, which
 * is a work-item-only concern: a repo host addresses pull requests, not labels.
 * No secret material is allowed here — the API token is referenced by indirection
 * through the sibling `auth` block, and `baseUrl` may not embed credentials.
 */
function validateGiteaRepoHostConfig(value: unknown, path: string): GiteaRepoHostConfig {
  const obj = record(value, path);
  const config: GiteaRepoHostConfig = {
    baseUrl: giteaBaseUrl(obj.baseUrl, `${path}.baseUrl`),
    owner: requiredString(obj.owner, `${path}.owner`),
    repo: requiredString(obj.repo, `${path}.repo`),
  };

  if (obj.apiPath !== undefined) {
    const apiPath = requiredString(obj.apiPath, `${path}.apiPath`);
    if (!apiPath.startsWith("/")) {
      throw new Error(`${path}.apiPath must be an absolute path starting with "/" (got "${apiPath}")`);
    }
    config.apiPath = apiPath;
  }

  return config;
}

/**
 * Validate a provider `auth` block.
 *
 * `allowApiTokenKey` defaults to true. Pass false where the `api-token` `tokenKey`
 * (credential-key / keychain) form has no runtime resolver yet — the production
 * Gitea repo-host paths build `defaultGiteaClientBuilder()` without a credential-key
 * resolver, so a `tokenKey` reference would validate here and then fail at runtime
 * with "no credential-key resolver configured". Rejecting it keeps validation
 * honest, mirroring the GitHub App `*Key` rejection.
 */
function validateProviderAuth(
  value: unknown,
  path: string,
  allowApiTokenKey = true,
): ProviderAuthConfig {
  const obj = record(value, path);
  const mode = requiredString(obj.mode, `${path}.mode`) as ProviderAuthConfig["mode"];
  if (!AUTH_MODES.has(mode)) {
    throw new Error(`${path}.mode must be one of: ${[...AUTH_MODES].join(", ")}`);
  }

  // Secrets must be referenced by env-var name, never inlined. Reject any raw
  // secret/identifier key in favor of its `*Env` counterpart.
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_SECRET_AUTH_KEYS.has(key)) {
      throw new Error(
        `${path}.${key} must not be set: reference secrets by environment variable name (e.g. "${key}Env"), not raw values`,
      );
    }
  }

  switch (mode) {
    case "gh":
      return { mode };
    case "github-app":
      // `*Key` (credential-key / keychain) references are not yet wired to a
      // production resolver for GitHub App auth, so accepting them would yield a
      // config that always fails at token-exchange time. Reject them here until a
      // resolver exists; only `*Env` references are usable at runtime.
      return {
        mode,
        ...secretRef(obj, path, "appId", true, false),
        ...secretRef(obj, path, "installationId", true, false),
        ...secretRef(obj, path, "privateKeyPath", true, false),
      };
    case "api-token":
      return {
        mode,
        ...secretRef(obj, path, "token", true, allowApiTokenKey),
        ...secretRef(obj, path, "email", false),
      };
  }
}

/**
 * Resolve a single secret reference, which must be supplied by indirection as
 * exactly one of `<base>Env` (environment-variable name) or `<base>Key`
 * (credential-key / keychain reference). Returns the single provided form so the
 * resolved auth config carries only the reference the operator declared.
 *
 * `allowKey` defaults to true. Pass false where the `*Key` form has no runtime
 * resolver yet (GitHub App auth): a supplied `*Key` is then rejected with a clear
 * error rather than being accepted into a config that fails later.
 */
function secretRef(
  obj: Record<string, unknown>,
  path: string,
  base: string,
  required: boolean,
  allowKey = true,
): Record<string, string> {
  const envKey = `${base}Env`;
  const keyKey = `${base}Key`;
  const hasEnv = obj[envKey] !== undefined;
  const hasKey = obj[keyKey] !== undefined;

  if (hasKey && !allowKey) {
    throw new Error(
      `${path}.${keyKey} is not supported yet: reference the secret by environment variable name (${path}.${envKey}) instead`,
    );
  }
  if (hasEnv && hasKey) {
    throw new Error(
      `${path}.${envKey} and ${path}.${keyKey} are mutually exclusive: reference the secret by exactly one form`,
    );
  }
  if (!hasEnv && !hasKey) {
    if (required) {
      throw new Error(
        `${path}.${envKey} or ${path}.${keyKey} must be set: reference the secret by environment variable name or credential key`,
      );
    }
    return {};
  }

  return hasEnv
    ? { [envKey]: envVarName(obj[envKey], `${path}.${envKey}`) }
    : { [keyKey]: credentialKeyName(obj[keyKey], `${path}.${keyKey}`) };
}

function envVarName(value: unknown, path: string): string {
  const name = requiredString(value, path);
  if (!ENV_VAR_NAME.test(name)) {
    throw new Error(`${path} must be an environment variable name (got "${name}")`);
  }
  return name;
}

function credentialKeyName(value: unknown, path: string): string {
  const name = requiredString(value, path);
  if (!CREDENTIAL_KEY.test(name)) {
    throw new Error(`${path} must be a credential key reference (got "${name}")`);
  }
  return name;
}
