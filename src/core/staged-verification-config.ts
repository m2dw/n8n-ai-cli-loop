/**
 * Staged verification: the operator-owned session block and its fail-closed
 * load validation (issue #1097 — slice S2 of
 * `docs/staged-verification-contract.md` §13).
 *
 * Two documents own the vocabulary this module validates, and none of it is
 * invented here:
 *
 * - `docs/verification-evidence-validity-contract.md` §7.3 rule 5 and §4.5 —
 *   `maxStageRecoveryAttempts` and the opaque, operator-declared
 *   `environmentIdentity` token.
 * - `docs/changed-file-verification-contract.md` §6 rule 5 and §10.1 D4 —
 *   `testSuite`, the operator-owned suite binding, required whenever the
 *   feature is `enabled`.
 *
 * Issue #1155 deleted the group-selection half of this block outright — the
 * six settings that named groups, bounded their budgets and bound their
 * adapters, together with the policy they configured
 * (`docs/changed-file-verification-contract.md` §9). There is no migration,
 * alias, deprecation warning or compatibility mode for them: a session still
 * carrying one is refused by the closed-field rule below, and the operator
 * removes the setting.
 *
 * What this module is NOT, deliberately:
 *
 * - It never selects, executes, routes a phase, reads a verdict, or knows what
 *   a check means. `docs/staged-verification-contract.md` §3.3's
 *   language-neutrality holds: a name here is an opaque
 *   `session.verification` key and a command is opaque operator bytes.
 * - It never widens authorization. Every name it accepts was already authored
 *   by the operator in `session.verification`; validation can only refuse.
 *
 * The block itself stays optional, and
 * {@link resolveStagedVerificationSettings} turns absence into today's
 * behavior — `enabled: false`, no suite bound — so a session written before
 * this chain loads and behaves exactly as it does today
 * (`docs/staged-verification-contract.md` §10 rules 1 and 3). Issue #1166 added
 * the binding's `requirementCommands`, which is optional for the same reason: a
 * binding without it matches Issue requirements by the suite command alone,
 * byte for byte as #1154 shipped it. An *enabled*
 * block without a suite binding refuses at load: the changed-file contract
 * replaces the selection policy rather than adding a mode beside it, so there
 * is no policy left for an enabled session to fall back to.
 */

import { matchesConfiguredVerificationCommand } from "./tool-request-continuation.js";

/**
 * The closed field set. An unknown key refuses.
 *
 * Issue #1155 removed the six group-selection settings
 * (`docs/changed-file-verification-contract.md` §9) with the policy they
 * configured. They are not migrated, aliased or detected: a session that still
 * carries one refuses at load through the `unknown_field` rule below, which is
 * exactly what the operator's own removal of the settings is checked against.
 */
export const STAGED_VERIFICATION_SETTING_KEYS = [
  "enabled",
  "maxStageRecoveryAttempts",
  "environmentIdentity",
  "testSuite",
] as const;

export type StagedVerificationSettingKey = (typeof STAGED_VERIFICATION_SETTING_KEYS)[number];

/**
 * #1096 §7.3 rule 5: the consecutive non-code stage termination budget,
 * "a positive integer defaulting to a small bounded value".
 */
export const DEFAULT_MAX_STAGE_RECOVERY_ATTEMPTS = 3;

/**
 * The operator's `environmentIdentity` token is opaque — core never parses it
 * (#1096 §4.5 rule 1) — but it is digested into an identity component and
 * therefore has to be a bounded, single-line string. Anything else is the
 * "token is present and malformed" case, refused here at load rather than left
 * to resolve `unknown` on every stage run.
 */
export const MAX_STAGE_ENVIRONMENT_IDENTITY_CHARS = 512;

/**
 * Issue #1152 (`docs/changed-file-verification-contract.md` §6 rule 5, §10.1
 * D4): the test adapters a suite binding may name. Closed — an adapter is
 * implemented code, so a name nothing implements refuses at load. Issue #1174
 * added `vitest` (`src/handlers/vitest-test-adapter.ts`).
 */
export const TEST_SUITE_ADAPTER_KINDS = ["jest", "vitest"] as const;

export type TestSuiteAdapterKind = (typeof TEST_SUITE_ADAPTER_KINDS)[number];

/** The closed field set of one suite binding entry. An unknown field refuses. */
export const TEST_SUITE_BINDING_KEYS = [
  "adapter",
  "setupCommand",
  "argumentSeparator",
  "requirementCommands",
] as const;

/**
 * A declared requirement command is Issue-body text, so it is bounded and
 * single-line for the same reason `environmentIdentity` is: it is digested into
 * the suite binding's configuration identity and printed in operator output.
 */
export const MAX_TEST_SUITE_REQUIREMENT_COMMAND_CHARS = 512;

/**
 * The adapter configuration the operator binds to the test suite entry.
 * Every value is operator-authored; nothing here is inferred from the command.
 */
export interface TestSuiteAdapterBinding {
  /** Which implemented adapter reads and drives the suite command. */
  adapter: TestSuiteAdapterKind;
  /**
   * An optional build/setup command, run as its own step before the suite
   * command in both modes, so changed sources are built before tests consume
   * them. It never receives the file selection.
   */
  setupCommand?: string;
  /**
   * An optional token placed between the suite command and the adapter's
   * arguments — `--` when the suite command is a package-manager script that
   * forwards arguments only after it (`npm test -- …`). An npm suite command
   * with no `--` of its own and no `--` separator is refused before launch.
   */
  argumentSeparator?: string;
  /**
   * Issue #1166 (`docs/changed-file-verification-contract.md` §6 rule 5): the
   * Issue-requirement command texts a complete Stage 2 of THIS entry
   * discharges, beyond the bound entry's own command.
   *
   * It exists because the command an Issue requires and the command the stages
   * launch are two different operator decisions. A project may bind
   * `npm run test:files` so a stage builds once and launches the suite twice,
   * while its Issues keep requiring `npm test` — the same suite, spelled the
   * way the project's contributor documentation spells it. Without this
   * declaration that requirement matches no configured command, so it reads
   * missing and blocks review before Stage 2 can ever run.
   *
   * It is a declaration, never an inference: nothing here reads `package.json`,
   * resolves a script name, compares npm aliases or asks an agent. The operator
   * states which requirement text this entry's full run discharges, and the
   * shipped `matchesConfiguredVerificationCommand` rule — exact trimmed text or
   * the shell-wrapper form — decides whether a requirement is that text. It
   * only ever applies to the BOUND entry, and only a complete, passing Stage 2
   * satisfies anything through it.
   */
  requirementCommands?: string[];
}

/**
 * The `stagedVerification` session block, exactly as the operator wrote it.
 * Every field is optional; {@link resolveStagedVerificationSettings} applies
 * the defaults. Validation has already refused anything malformed, so a value
 * present here is one the contract admits.
 */
export interface StagedVerificationConfig {
  /** §5.3: default `false`. Absent or `false` means nothing staged runs. */
  enabled?: boolean;
  /** #1096 §7.3 rule 5: consecutive non-code stage terminations before a park. */
  maxStageRecoveryAttempts?: number;
  /** #1096 §4.5: an opaque operator-declared environment token. */
  environmentIdentity?: string;
  /**
   * Issue #1152 (`docs/changed-file-verification-contract.md` §6 rule 5): the
   * suite binding — exactly one `session.verification` key mapped to the test
   * adapter bound to it. Required when `enabled` is `true`.
   */
  testSuite?: Record<string, TestSuiteAdapterBinding>;
}

/** Which rule refused the session. Recorded on the thrown error, never parsed. */
export type StagedVerificationConfigRefusal =
  | "not_an_object"
  | "unknown_field"
  | "invalid_enabled"
  | "invalid_budget"
  | "unresolvable_name"
  | "invalid_environment_identity"
  | "missing_test_suite"
  | "invalid_test_suite"
  | "duplicate_test_suite_key"
  | "invalid_test_adapter"
  | "invalid_adapter_command"
  | "invalid_argument_separator"
  | "invalid_requirement_commands";

/**
 * A load-time refusal. It extends `Error` so the session registry propagates it
 * exactly like every other validation failure — the session does not load, and
 * a half-enabled staged configuration never reaches a phase.
 */
export class StagedVerificationConfigError extends Error {
  readonly refusal: StagedVerificationConfigRefusal;
  readonly path: string;

  constructor(refusal: StagedVerificationConfigRefusal, path: string, message: string) {
    super(message);
    this.name = "StagedVerificationConfigError";
    this.refusal = refusal;
    this.path = path;
  }
}

function refuse(
  refusal: StagedVerificationConfigRefusal,
  path: string,
  message: string,
): never {
  throw new StagedVerificationConfigError(refusal, path, message);
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    refuse("invalid_budget", path, `${path} must be a positive integer`);
  }
  return value;
}

/**
 * Validate the `stagedVerification` block, fail-closed (§5.3, #1096 §7.3 rule
 * 5 / §4.5, `docs/changed-file-verification-contract.md` §6 rule 5).
 *
 * `verificationNames` are the live `session.verification` keys of the same
 * session. They are the only resolution this check performs: the suite binding
 * names an operator-authored command, so a key that resolves to nothing is a
 * configuration mistake, not a check that might appear later.
 *
 * `verificationCommands` is the same map's VALUES, used for one further refusal
 * (issue #1166): a declared `requirementCommands` entry that another key
 * already runs would let the suite discharge a requirement that check's own
 * record owns. It is optional so a caller that has only the keys keeps the
 * shipped behavior; the declaration's own shape is validated either way.
 *
 * Throws {@link StagedVerificationConfigError} on every refusal. Returns the
 * validated block, copied, with nothing defaulted — defaults belong to
 * {@link resolveStagedVerificationSettings} so an operator surface can still
 * tell "absent" from "written and equal to the default".
 */
export function validateStagedVerificationConfig(
  value: unknown,
  path: string,
  verificationNames: readonly string[],
  verificationCommands?: Readonly<Record<string, string>>,
): StagedVerificationConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse("not_an_object", path, `${path} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(STAGED_VERIFICATION_SETTING_KEYS as readonly string[]).includes(key)) {
      refuse(
        "unknown_field",
        `${path}.${key}`,
        `${path}.${key} is not a known stagedVerification setting; expected one of: `
          + `${STAGED_VERIFICATION_SETTING_KEYS.join(", ")}`,
      );
    }
  }

  const known = new Set(verificationNames);
  const config: StagedVerificationConfig = {};

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") {
      refuse("invalid_enabled", `${path}.enabled`, `${path}.enabled must be a boolean`);
    }
    config.enabled = raw.enabled;
  }

  if (raw.maxStageRecoveryAttempts !== undefined) {
    config.maxStageRecoveryAttempts = positiveInteger(
      raw.maxStageRecoveryAttempts,
      `${path}.maxStageRecoveryAttempts`,
    );
  }

  if (raw.environmentIdentity !== undefined) {
    const token = raw.environmentIdentity;
    if (
      typeof token !== "string"
      || token.trim() === ""
      || token.length > MAX_STAGE_ENVIRONMENT_IDENTITY_CHARS
      || /[ -]/.test(token)
    ) {
      refuse(
        "invalid_environment_identity",
        `${path}.environmentIdentity`,
        `${path}.environmentIdentity must be a non-empty single-line token of at most `
          + `${MAX_STAGE_ENVIRONMENT_IDENTITY_CHARS} characters`,
      );
    }
    config.environmentIdentity = token;
  }

  if (raw.testSuite !== undefined) {
    config.testSuite = validateTestSuiteBinding(
      raw.testSuite,
      `${path}.testSuite`,
      known,
      verificationCommands,
    );
  }
  // `docs/changed-file-verification-contract.md` §6 rule 5: an enabled session
  // must say which entry is the suite. Nothing guesses it from a key name or a
  // command, and nothing falls back to running every command.
  if (config.enabled === true && config.testSuite === undefined) {
    refuse(
      "missing_test_suite",
      `${path}.testSuite`,
      `${path}.testSuite is required when ${path}.enabled is true; it must name the one `
        + "session.verification key that is the test suite and the test adapter bound to it",
    );
  }

  return config;
}

/**
 * The suite binding (issue #1152, `docs/changed-file-verification-contract.md`
 * §6 rule 5 and §10.1 D4): `{ "<session.verification key>": { "adapter": … } }`
 * with exactly one entry.
 *
 * An empty binding, more than one key, a key that is not a
 * `session.verification` key, a missing or unimplemented adapter, an unknown
 * field, an empty setup command or a malformed separator each refuse the
 * session. The binding is the operator's; validation only ever refuses it.
 */
function validateTestSuiteBinding(
  value: unknown,
  path: string,
  verificationNames: ReadonlySet<string>,
  verificationCommands?: Readonly<Record<string, string>>,
): Record<string, TestSuiteAdapterBinding> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse(
      "invalid_test_suite",
      path,
      `${path} must be an object naming exactly one session.verification key`,
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1) {
    refuse(
      "invalid_test_suite",
      path,
      `${path} must name exactly one session.verification key as the test suite; it names ${entries.length}`,
    );
  }
  const [key, rawBinding] = entries[0] as [string, unknown];
  const entryPath = `${path}.${key}`;
  if (!verificationNames.has(key)) {
    refuse(
      "unresolvable_name",
      entryPath,
      `${path} names "${key}", which is not a session.verification key`,
    );
  }
  if (!rawBinding || typeof rawBinding !== "object" || Array.isArray(rawBinding)) {
    refuse("invalid_test_adapter", entryPath, `${entryPath} must be an object declaring the test adapter`);
  }
  const binding = rawBinding as Record<string, unknown>;
  for (const field of Object.keys(binding)) {
    if (!(TEST_SUITE_BINDING_KEYS as readonly string[]).includes(field)) {
      refuse(
        "unknown_field",
        `${entryPath}.${field}`,
        `${entryPath}.${field} is not a known test suite binding field; expected one of: `
          + `${TEST_SUITE_BINDING_KEYS.join(", ")}`,
      );
    }
  }
  if (
    typeof binding.adapter !== "string"
    || !(TEST_SUITE_ADAPTER_KINDS as readonly string[]).includes(binding.adapter)
  ) {
    refuse(
      "invalid_test_adapter",
      `${entryPath}.adapter`,
      `${entryPath}.adapter must name an implemented test adapter; expected one of: `
        + `${TEST_SUITE_ADAPTER_KINDS.join(", ")}`,
    );
  }
  const resolved: TestSuiteAdapterBinding = { adapter: binding.adapter as TestSuiteAdapterKind };
  if (binding.setupCommand !== undefined) {
    if (typeof binding.setupCommand !== "string" || binding.setupCommand.trim() === "") {
      refuse(
        "invalid_adapter_command",
        `${entryPath}.setupCommand`,
        `${entryPath}.setupCommand must be a non-empty command`,
      );
    }
    resolved.setupCommand = binding.setupCommand;
  }
  if (binding.argumentSeparator !== undefined) {
    if (typeof binding.argumentSeparator !== "string" || !/^\S+$/.test(binding.argumentSeparator)) {
      refuse(
        "invalid_argument_separator",
        `${entryPath}.argumentSeparator`,
        `${entryPath}.argumentSeparator must be a single non-empty token such as "--"`,
      );
    }
    resolved.argumentSeparator = binding.argumentSeparator;
  }
  if (binding.requirementCommands !== undefined) {
    resolved.requirementCommands = validateRequirementCommands(
      binding.requirementCommands,
      `${entryPath}.requirementCommands`,
      key,
      verificationCommands,
    );
  }
  // Null-prototype: a suite key of `__proto__` stays an own entry instead of
  // becoming a prototype write.
  const suite: Record<string, TestSuiteAdapterBinding> = Object.create(null);
  suite[key] = resolved;
  return suite;
}

/**
 * Issue #1166 (`docs/changed-file-verification-contract.md` §6 rule 5): the
 * operator's declaration of which Issue-requirement command texts a complete
 * Stage 2 of the bound entry discharges.
 *
 * Every refusal here is about the declaration's own shape or about a collision
 * the operator can see and fix; nothing is normalized, deduplicated silently or
 * inferred. A present-but-empty array declares nothing while looking like a
 * declaration, so it refuses rather than resolving to "no aliases" — an
 * operator who means that removes the field.
 *
 * The collision rule is the narrow one: a declared command another
 * `session.verification` entry already runs would let the suite discharge a
 * requirement that entry's own record owns, which is exactly the silent
 * widening this field must not enable. A declaration equal to the bound entry's
 * own command is redundant rather than wrong, and is allowed.
 *
 * This check sees only the STATIC session map, which is all a load-time
 * validation can see. A task amendment can introduce the same collision into a
 * single task's effective plan later, so `resolveTestSuiteSlot`
 * (`src/core/test-stage-routing.ts`) rechecks it against that plan as each
 * stage launches and routes it as an ambiguous suite (issue #1166 review, P1).
 * Neither check substitutes for the other: this one keeps a whole session from
 * loading in a state no task could run, and that one catches the amendment.
 */
function validateRequirementCommands(
  value: unknown,
  path: string,
  boundKey: string,
  verificationCommands?: Readonly<Record<string, string>>,
): string[] {
  if (!Array.isArray(value)) {
    refuse("invalid_requirement_commands", path, `${path} must be an array of command strings`);
  }
  if (value.length === 0) {
    refuse(
      "invalid_requirement_commands",
      path,
      `${path} must declare at least one Issue-requirement command; remove the field to declare none`,
    );
  }
  const commands: string[] = [];
  for (const [index, entry] of value.entries()) {
    const entryPath = `${path}[${index}]`;
    if (
      typeof entry !== "string"
      || entry.trim() === ""
      || entry.length > MAX_TEST_SUITE_REQUIREMENT_COMMAND_CHARS
      || /[\r\n]/.test(entry)
    ) {
      refuse(
        "invalid_requirement_commands",
        entryPath,
        `${entryPath} must be a non-empty single-line command of at most `
          + `${MAX_TEST_SUITE_REQUIREMENT_COMMAND_CHARS} characters`,
      );
    }
    if (commands.some((seen) => seen.trim() === entry.trim())) {
      refuse("invalid_requirement_commands", entryPath, `${entryPath} repeats an earlier declaration`);
    }
    for (const [name, command] of Object.entries(verificationCommands ?? {})) {
      if (name === boundKey || typeof command !== "string") continue;
      if (
        matchesConfiguredVerificationCommand(command, entry)
        || matchesConfiguredVerificationCommand(entry, command)
      ) {
        refuse(
          "invalid_requirement_commands",
          entryPath,
          `${entryPath} is the command session.verification."${name}" already runs, so the bound test suite `
            + `would discharge a requirement that check's own record owns; declare only commands the suite itself runs`,
        );
      }
    }
    commands.push(entry);
  }
  return commands;
}

function copyTestSuiteBinding(
  suite: Readonly<Record<string, TestSuiteAdapterBinding>>,
): Record<string, TestSuiteAdapterBinding> {
  const copy: Record<string, TestSuiteAdapterBinding> = Object.create(null);
  for (const [key, binding] of Object.entries(suite)) {
    copy[key] = {
      ...binding,
      ...(binding.requirementCommands !== undefined
        ? { requirementCommands: [...binding.requirementCommands] }
        : {}),
    };
  }
  return copy;
}

/** A deep copy, so a cached session and a handed-out session never share it. */
export function cloneStagedVerificationConfig(
  config: StagedVerificationConfig,
): StagedVerificationConfig {
  return {
    ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
    ...(config.maxStageRecoveryAttempts !== undefined
      ? { maxStageRecoveryAttempts: config.maxStageRecoveryAttempts }
      : {}),
    ...(config.environmentIdentity !== undefined
      ? { environmentIdentity: config.environmentIdentity }
      : {}),
    ...(config.testSuite !== undefined ? { testSuite: copyTestSuiteBinding(config.testSuite) } : {}),
  };
}

/** The suite binding resolved to its one entry (§6 rule 5). */
export interface ResolvedTestSuiteBinding extends TestSuiteAdapterBinding {
  /** The `session.verification` key that is the test suite entry. */
  readonly key: string;
}

/** The block with every default applied — what a later slice actually reads. */
export interface ResolvedStagedVerificationSettings {
  readonly enabled: boolean;
  readonly maxStageRecoveryAttempts: number;
  readonly environmentIdentity?: string;
  /** Issue #1152: the suite binding, when declared. It has no default. */
  readonly testSuite?: ResolvedTestSuiteBinding;
}

/**
 * Apply the defaults to a validated block, or to its absence.
 *
 * Absence is the compatibility path and it is the same answer as
 * `{ "enabled": false }`: staged verification is off and no suite is bound, so
 * a lane runs the shipped full `session.verification` pass exactly as it does
 * today (§10 rules 1 and 3). Nothing here is defaulted in a way that could
 * weaken verification: with the feature enabled a stage runs the **entire**
 * required set of non-test checks (issue #1155 retired the selection policy
 * that could narrow it), and the test suite runs under the changed-file stages.
 */
export function resolveStagedVerificationSettings(
  config?: StagedVerificationConfig,
): ResolvedStagedVerificationSettings {
  return {
    enabled: config?.enabled ?? false,
    maxStageRecoveryAttempts:
      config?.maxStageRecoveryAttempts ?? DEFAULT_MAX_STAGE_RECOVERY_ATTEMPTS,
    ...(config?.environmentIdentity !== undefined
      ? { environmentIdentity: config.environmentIdentity }
      : {}),
    ...resolvedTestSuite(config?.testSuite),
  };
}

function resolvedTestSuite(
  suite: Readonly<Record<string, TestSuiteAdapterBinding>> | undefined,
): { testSuite?: ResolvedTestSuiteBinding } {
  const entry = suite === undefined ? undefined : Object.entries(suite)[0];
  return entry === undefined ? {} : { testSuite: { key: entry[0], ...entry[1] } };
}
