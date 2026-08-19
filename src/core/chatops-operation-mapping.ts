/**
 * ChatOps → operation mapping and per-surface argument policy (issue #784).
 *
 * `src/core/chatops-command.ts` (#780) recognizes a comment as a verb plus an
 * argv-style token array; `src/core/operation-port.ts` (#783) invokes a typed
 * operation given a request and a trusted context. Nothing between those two
 * existed until this module: which verb maps onto which operation id, which
 * of that operation's parameters a comment may ever set, and what happens to
 * argv that does not fit — see `docs/chatops-operation-mapping-contract.md`
 * for the full contract.
 *
 * Two things this module is deliberately not: it never builds an
 * {@link OperationContext} (that stays #783's `chatOpsOperationContext`,
 * built from ledger-scope facts only), and it never invokes an operation (no
 * registry is even in scope here — #783's port has none registered yet).
 * This module only ever answers "does this argv, under this verb's allowlist,
 * become a well-formed request", so its output is always either a typed
 * refusal or the untrusted half of an invocation — never the trusted half,
 * and never a call.
 *
 * Every export here is pure: no I/O, no clock, no randomness.
 */

import {
  OPERATION_ID_PATTERN,
  OPERATION_PARAM_NAME_PATTERN,
  OPERATION_RESERVED_PARAM_NAMES,
} from "./operation-port.js";
import type { OperationParamValue } from "./operation-port.js";

/** The scalar types a ChatOps-visible parameter may carry. Mirrors {@link OperationParamType}. */
export type ChatOpsOperationParamType = "string" | "number" | "boolean";

/** One parameter a ChatOps verb permits, out of the operation's own declared set. */
export interface ChatOpsOperationParamSpec {
  /** Lower-kebab, identical to the CLI flag spelling minus `--`. */
  name: string;
  type: ChatOpsOperationParamType;
  /** Refused with `invalid-argument` when omitted from argv. */
  required?: boolean;
  /** When true, the flag may be repeated; values are collected in argv order. */
  repeated?: boolean;
}

/** One ChatOps verb bound to exactly one canonical operation (contract §2). */
export interface ChatOpsOperationMapping {
  /** Lower-kebab, e.g. `"grant"` — the word a comment writes after `/`. */
  verb: string;
  /** The canonical `resource.action` id this verb invokes. Never a deprecated alias. */
  operationId: string;
  /** `issue` requires the invocation to carry a work item; `session` requires it not to. */
  scope: "session" | "issue";
  /** True when a confirmed invocation of `operationId` changes durable state. */
  mutating: boolean;
  /** One line, operator-facing; the ChatOps help reply. */
  summary: string;
  /** The closed allowlist of parameters a ChatOps comment may set. Never empty by default — an operation with nothing safe to expose gets an empty array, not an omitted mapping. */
  params: readonly ChatOpsOperationParamSpec[];
}

/**
 * Parameter names no ChatOps mapping may ever declare (contract §4).
 *
 * `OPERATION_RESERVED_PARAM_NAMES` is the port's own closed set — every field
 * {@link OperationContext} already injects, so a request carrying one would
 * either be refused by the port anyway or (worse, if the port's own check
 * were ever weakened) let a comment forge trusted routing. The names added
 * here are ChatOps-specific: they name a routing/selector concern the port
 * does not know about because no registered operation exists yet to declare
 * them, or they name the one shape (`command`) this contract singles out —
 * an operation parameter that is itself a free-form shell command, which may
 * never have a ChatOps-visible spelling no matter what it is called.
 */
export const CHATOPS_FORBIDDEN_PARAM_NAMES: readonly string[] = Object.freeze([
  ...new Set([
    ...OPERATION_RESERVED_PARAM_NAMES,
    "command",
    "commands",
    "sessions-path",
    "db-path",
    "lock-dir",
    "repo-root",
    "repo",
    "repository",
    "provider",
    "provider-endpoint",
    "provider-owner",
    "provider-repo",
    "state-path",
    "path",
  ]),
]);

/**
 * Operation ids a mapping may never target (contract §3).
 *
 * `tool-request.grant` mirrors the admin CLI's deprecated `tool-request
 * grant` alias for `tool-request run` (`docs/admin-command-registry-contract.md`
 * §2.3). The alias is kept on the CLI for operator continuity; it is not
 * carried into a new, comment-driven contract, which is why a ChatOps verb
 * that means the same thing as `grant` still maps to the canonical
 * `tool-request.run`, never to this id.
 */
export const CHATOPS_DEPRECATED_OPERATION_IDS: readonly string[] = Object.freeze([
  "tool-request.grant",
]);

// Mirrors `VERB_RE` in chatops-command.ts (#780): a verb this table maps must
// be a verb the grammar can actually recognize, and the grammar never
// recognizes a single-character one.
const CHATOPS_VERB_PATTERN = /^[a-z][a-z0-9-]+$/;

/**
 * A defect in a mapping *declaration* — an invalid verb, a forbidden or
 * malformed parameter name, a deprecated operation id, a duplicate verb.
 *
 * Thrown at table-construction time, never at request-mapping time, for the
 * same reason `OperationRegistrationError` is thrown by `operation-port.ts`:
 * a bad mapping is a defect at the composition root, not untrusted input, and
 * must stop the process before it serves anyone.
 */
export class ChatOpsOperationMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatOpsOperationMappingError";
  }
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function assertValidParamSpec(
  verb: string,
  spec: ChatOpsOperationParamSpec,
  seen: Set<string>,
): void {
  if (!OPERATION_PARAM_NAME_PATTERN.test(spec.name)) {
    throw new ChatOpsOperationMappingError(
      `chatops verb ${JSON.stringify(verb)} declares invalid parameter name ${JSON.stringify(spec.name)}`,
    );
  }
  if (CHATOPS_FORBIDDEN_PARAM_NAMES.includes(spec.name)) {
    throw new ChatOpsOperationMappingError(
      `chatops verb ${JSON.stringify(verb)} declares forbidden parameter ${JSON.stringify(spec.name)}: trusted routing fields and free-form command input may never be a ChatOps parameter`,
    );
  }
  if (seen.has(spec.name)) {
    throw new ChatOpsOperationMappingError(
      `chatops verb ${JSON.stringify(verb)} declares parameter ${JSON.stringify(spec.name)} twice`,
    );
  }
  seen.add(spec.name);
  if (spec.type !== "string" && spec.type !== "number" && spec.type !== "boolean") {
    throw new ChatOpsOperationMappingError(
      `chatops verb ${JSON.stringify(verb)} declares parameter ${JSON.stringify(spec.name)} with unknown type ${JSON.stringify(spec.type)}`,
    );
  }
  for (const flag of ["required", "repeated"] as const) {
    const value = spec[flag];
    if (value !== undefined && typeof value !== "boolean") {
      throw new ChatOpsOperationMappingError(
        `chatops verb ${JSON.stringify(verb)} declares parameter ${JSON.stringify(spec.name)} with a non-boolean ${flag} flag`,
      );
    }
  }
}

function assertValidMapping(mapping: ChatOpsOperationMapping): void {
  if (typeof mapping.verb !== "string" || !CHATOPS_VERB_PATTERN.test(mapping.verb)) {
    throw new ChatOpsOperationMappingError(`invalid chatops verb ${JSON.stringify(mapping.verb)}`);
  }
  if (typeof mapping.operationId !== "string" || !OPERATION_ID_PATTERN.test(mapping.operationId)) {
    throw new ChatOpsOperationMappingError(
      `chatops verb ${JSON.stringify(mapping.verb)} maps to an invalid operation id ${JSON.stringify(mapping.operationId)}`,
    );
  }
  if (CHATOPS_DEPRECATED_OPERATION_IDS.includes(mapping.operationId)) {
    throw new ChatOpsOperationMappingError(
      `chatops verb ${JSON.stringify(mapping.verb)} maps to ${JSON.stringify(mapping.operationId)}, which is a deprecated alias — map to its canonical operation instead`,
    );
  }
  if (mapping.scope !== "session" && mapping.scope !== "issue") {
    throw new ChatOpsOperationMappingError(
      `chatops verb ${JSON.stringify(mapping.verb)} declares unknown scope ${JSON.stringify(mapping.scope)}`,
    );
  }
  if (typeof mapping.mutating !== "boolean") {
    throw new ChatOpsOperationMappingError(
      `chatops verb ${JSON.stringify(mapping.verb)} declares a non-boolean mutating flag`,
    );
  }
  if (typeof mapping.summary !== "string" || isBlank(mapping.summary)) {
    throw new ChatOpsOperationMappingError(`chatops verb ${JSON.stringify(mapping.verb)} has a blank summary`);
  }
  if (!Array.isArray(mapping.params)) {
    throw new ChatOpsOperationMappingError(
      `chatops verb ${JSON.stringify(mapping.verb)} declares params that are not an array`,
    );
  }
  const seen = new Set<string>();
  for (const spec of mapping.params) {
    assertValidParamSpec(mapping.verb, spec, seen);
  }
}

/** The lookup surface adapters hold. Deliberately read-only. */
export interface ChatOpsOperationMappingTable {
  get(verb: string): ChatOpsOperationMapping | undefined;
  /**
   * The exact set `recognizeChatOpsComment` (#780) needs for its
   * `supportedVerbs` argument — this table *is* the definition of which verbs
   * are supported.
   */
  supportedVerbs(): ReadonlySet<string>;
  list(): readonly ChatOpsOperationMapping[];
}

/**
 * Copy a caller-supplied mapping's fields exactly once, before any
 * validation reads them.
 *
 * A mapping or param spec supplied from ordinary JavaScript may carry
 * getters that return different values on successive reads (e.g. a safe
 * value the first time `assertValidMapping` checks it, then a forbidden one
 * the next). Reading each field exactly once here — and validating only this
 * snapshot afterward — makes that a non-issue: whatever the table ends up
 * storing is exactly what was checked.
 */
function snapshotMapping(supplied: ChatOpsOperationMapping): ChatOpsOperationMapping {
  const suppliedParams = supplied.params;
  if (!Array.isArray(suppliedParams)) {
    throw new ChatOpsOperationMappingError(
      `chatops verb ${JSON.stringify(supplied.verb)} declares params that are not an array`,
    );
  }
  const params = suppliedParams.map((spec) => Object.freeze({ ...spec }));
  return Object.freeze({
    verb: supplied.verb,
    operationId: supplied.operationId,
    scope: supplied.scope,
    mutating: supplied.mutating,
    summary: supplied.summary,
    params: Object.freeze(params),
  });
}

/**
 * Build a mapping table from declarations, rejecting every declaration
 * defect up front (contract §3, §4).
 *
 * Mirrors `createOperationRegistry`'s posture: registration throws, because a
 * bad mapping is a defect nobody downstream can safely route around; the
 * request-mapping function below returns typed refusals instead, because
 * argv is untrusted input that must always produce an answer.
 */
export function createChatOpsOperationMappingTable(
  mappings: readonly ChatOpsOperationMapping[],
): ChatOpsOperationMappingTable {
  const byVerb = new Map<string, ChatOpsOperationMapping>();
  for (const supplied of mappings) {
    const frozen = snapshotMapping(supplied);
    assertValidMapping(frozen);
    if (byVerb.has(frozen.verb)) {
      throw new ChatOpsOperationMappingError(`duplicate chatops verb ${JSON.stringify(frozen.verb)}`);
    }
    byVerb.set(frozen.verb, frozen);
  }
  const ordered = Object.freeze([...byVerb.values()]);
  return Object.freeze({
    get: (verb: string) => byVerb.get(verb),
    supportedVerbs: () => new Set(byVerb.keys()),
    list: () => ordered,
  });
}

// ---------------------------------------------------------------------------
// Mapping one recognized command onto a request (contract §5, §6)
// ---------------------------------------------------------------------------

/** Why a recognized ChatOps command did not become a request, or that it did. */
export type ChatOpsOperationMappingOutcome =
  | { kind: "unsupported-operation"; verb: string }
  | { kind: "invalid-argument"; verb: string; detail: string }
  | {
      kind: "request";
      operationId: string;
      scope: "session" | "issue";
      mutating: boolean;
      /** The untrusted half of an invocation: pass this straight through as `OperationRequest.params`. */
      params: Readonly<Record<string, OperationParamValue | readonly OperationParamValue[]>>;
    };

/** The minimal shape this module needs from `ChatOpsCommand` (#780), stated locally to avoid a type-only import cycle. */
export interface ChatOpsMappableCommand {
  readonly verb: string;
  readonly argv: readonly string[];
}

function coerce(raw: string, type: ChatOpsOperationParamType): OperationParamValue | undefined {
  if (type === "string") return raw;
  if (type === "number") {
    if (raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }
  // Boolean parameters are presence-only flags (contract §5.2): reaching here
  // at all means the flag was present, which is the value.
  return true;
}

/**
 * Map one recognized `{ verb, argv }` command (#780 §2) onto the untrusted
 * half of an invocation, under one verb's allowlist.
 *
 * Every parameter is named: a bare positional token is always
 * `invalid-argument`, because no mapping this contract defines declares a
 * positional parameter, and giving argv position any meaning here is exactly
 * the property that made an admin-CLI argv unsafe to hand to a comment in the
 * first place (`docs/operation-dispatch-port-contract.md` §1). A repeated
 * flag is refused deterministically from its *count*, never from which
 * occurrence "wins" — so the outcome never depends on argv order (contract
 * §6).
 */
export function mapChatOpsCommandToOperationRequest(
  command: ChatOpsMappableCommand,
  table: ChatOpsOperationMappingTable,
): ChatOpsOperationMappingOutcome {
  const mapping = table.get(command.verb);
  if (mapping === undefined) {
    return { kind: "unsupported-operation", verb: command.verb };
  }

  const specByName = new Map(mapping.params.map((spec) => [spec.name, spec] as const));
  const raw = new Map<string, string[]>();
  const argv = command.argv;

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (!token.startsWith("--") || token.length <= 2) {
      return {
        kind: "invalid-argument",
        verb: command.verb,
        detail: `unexpected positional argument ${JSON.stringify(token)}`,
      };
    }
    const name = token.slice(2);
    const spec = specByName.get(name);
    if (spec === undefined) {
      return {
        kind: "invalid-argument",
        verb: command.verb,
        detail: `unsupported parameter --${name} for chatops command /${command.verb}`,
      };
    }
    let value: string;
    if (spec.type === "boolean") {
      value = "true";
      i += 1;
    } else {
      const next = argv[i + 1];
      // `parseChatOpsCommandLine` (#780) never produces a value token that
      // starts with `--`, so seeing one here means the flag before it got no
      // value at all, not that the value happens to look like a flag.
      if (next === undefined || next.startsWith("--")) {
        return {
          kind: "invalid-argument",
          verb: command.verb,
          detail: `--${name} requires a value`,
        };
      }
      value = next;
      i += 2;
    }
    const bucket = raw.get(name);
    if (bucket === undefined) raw.set(name, [value]);
    else bucket.push(value);
  }

  const params: Record<string, OperationParamValue | readonly OperationParamValue[]> = Object.create(null);
  for (const [name, occurrences] of raw) {
    const spec = specByName.get(name) as ChatOpsOperationParamSpec;
    if (occurrences.length > 1 && spec.repeated !== true) {
      return {
        kind: "invalid-argument",
        verb: command.verb,
        detail: `--${name} was supplied more than once`,
      };
    }
    const coerced = occurrences.map((value) => coerce(value, spec.type));
    if (coerced.some((value) => value === undefined)) {
      return {
        kind: "invalid-argument",
        verb: command.verb,
        detail: `--${name} expects a ${spec.type} value`,
      };
    }
    params[name] =
      spec.repeated === true
        ? Object.freeze(coerced as OperationParamValue[])
        : (coerced[0] as OperationParamValue);
  }

  for (const spec of mapping.params) {
    if (spec.required === true && !(spec.name in params)) {
      return {
        kind: "invalid-argument",
        verb: command.verb,
        detail: `missing required parameter --${spec.name} for chatops command /${command.verb}`,
      };
    }
  }

  return {
    kind: "request",
    operationId: mapping.operationId,
    scope: mapping.scope,
    mutating: mapping.mutating,
    params: Object.freeze(params),
  };
}

// ---------------------------------------------------------------------------
// The supported table (contract §7)
// ---------------------------------------------------------------------------

/**
 * The first two ChatOps verbs, mapped per contract §7: `/grant` and
 * `/resolve` are the two Tool Request handoff actions PR #776's review found
 * unsafely wired, and each demonstrates a different shape — a wholly-optional
 * allowlist, and a required-plus-optional one.
 *
 * `/grant` maps to `tool-request.run`, never `tool-request.grant`
 * (`CHATOPS_DEPRECATED_OPERATION_IDS` would refuse the latter at table
 * construction if it were ever written here). It exposes only `disposition`:
 * `--command` — the field that names *which* shell command runs — is
 * withheld unconditionally, because that command was already chosen and
 * recorded when the Tool Request was created; a comment picking it now would
 * be exactly the free-form-shell-through-a-comment risk this contract exists
 * to close, and there is no safe subset of "let the comment choose the
 * command" short of not having the parameter at all. `--session-ref`,
 * `--sessions-path`, `--db-path`, and `--lock-dir` are withheld because each
 * is a trusted-context or state-store selector `chatOpsOperationContext`
 * already injects or that this contract forbids outright.
 *
 * `/resolve` maps to `tool-request.resolve` and exposes `action` (required —
 * `manual-done` or `reject`, validated by the operation itself once one is
 * registered) and `message` (optional operator text). `--dry-run` is
 * withheld: confirmation is trusted context (`operation-port.ts` §5.2), never
 * a ChatOps-settable parameter.
 */
export const CHATOPS_OPERATION_MAPPINGS: readonly ChatOpsOperationMapping[] = Object.freeze([
  Object.freeze({
    verb: "grant",
    operationId: "tool-request.run",
    scope: "issue",
    mutating: true,
    summary: "Guided-run the approved command for this issue's Tool Request handoff.",
    params: Object.freeze([Object.freeze({ name: "disposition", type: "string" as const })]),
  }),
  Object.freeze({
    verb: "resolve",
    operationId: "tool-request.resolve",
    scope: "issue",
    mutating: true,
    summary: "Resolve this issue's Tool Request handoff without running its command.",
    params: Object.freeze([
      Object.freeze({ name: "action", type: "string" as const, required: true }),
      Object.freeze({ name: "message", type: "string" as const }),
    ]),
  }),
]);

/** The ready-to-use table over {@link CHATOPS_OPERATION_MAPPINGS}. */
export const CHATOPS_OPERATION_MAPPING_TABLE: ChatOpsOperationMappingTable =
  createChatOpsOperationMappingTable(CHATOPS_OPERATION_MAPPINGS);
