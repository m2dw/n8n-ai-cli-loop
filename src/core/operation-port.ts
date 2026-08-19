/**
 * The callable operation-dispatch port (issue #783).
 *
 * One resource-oriented admin operation, invoked programmatically by any
 * adapter — the admin CLI, `admin ui`, a future GitHub App, or the ChatOps
 * comment surface — without parsing argv, without a process-global output
 * mode, and without spawning `admin.js`. See
 * `docs/operation-dispatch-port-contract.md` for the full contract, including
 * what deliberately is *not* here (which verbs exist, how a ChatOps command
 * maps onto one, which parameters a given surface may set, acknowledgement
 * formatting, and Tool Request grant tiers — issues #784, #785, #697).
 *
 * The single structural rule this module exists to enforce: **a request is
 * untrusted data, a context is trusted authority, and neither can impersonate
 * the other.** An {@link OperationRequest} carries only the operation's own
 * declared parameters; every fact about *who* is asking, *which* session and
 * work item they are allowed to touch, and whether the invocation may apply
 * changes lives in {@link OperationContext}, which no adapter builds from
 * user-supplied text. The two are separate arguments of separate types, and
 * {@link invokeOperation} refuses a request that tries to carry a trusted
 * field name (contract §5).
 *
 * Every export here is pure with respect to this module: no I/O, no clock, no
 * randomness, no process state, no `process.exit`. The only impure code an
 * invocation reaches is the {@link OperationDescriptor.run} an adapter
 * registered, which owns its own transaction (contract §8).
 */

// ---------------------------------------------------------------------------
// Identity and parameters (contract §4)
// ---------------------------------------------------------------------------

/**
 * A typed operation id: `resource.action`, lower-kebab on both sides
 * (`tool-request.run`, `worktree.release-lock`, `task.clear-delay`).
 *
 * The shape deliberately mirrors the admin CLI's resource/action command
 * identity (`docs/admin-command-registry-contract.md` §3) so one operation can
 * back both surfaces, but an id is *not* a command string: it is never split
 * on whitespace, never re-joined into argv, and never interpolated into a
 * shell (contract §6).
 */
export const OPERATION_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

/** A parameter name: lower-kebab, matching the flag spelling adapters use. */
export const OPERATION_PARAM_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Operator-facing summary bound (contract §12). */
export const OPERATION_SUMMARY_MAX_CHARS = 500;

/** The scalar types a parameter may carry. */
export type OperationParamType = "string" | "number" | "boolean";

/**
 * The same set as a value, so registration can check a descriptor's declared
 * `type` against it. A descriptor may be built by unchecked JavaScript or from
 * configuration, and an unrecognized type would otherwise fall through
 * {@link matchesType}'s final branch and be validated as a boolean — a
 * parameter checked as something other than what it declared.
 */
const OPERATION_PARAM_TYPES: readonly OperationParamType[] = Object.freeze([
  "string",
  "number",
  "boolean",
]);

/** A single parameter value. Deliberately scalar: no nested objects. */
export type OperationParamValue = string | number | boolean;

/**
 * The untrusted half of an invocation: the operation's declared parameters.
 *
 * Values are scalars or arrays of scalars — never a nested object, never a
 * function, never an argv array. A repeated parameter is expressed as an
 * array of scalars under its own name, not as a positional token list.
 */
export type OperationParams = Readonly<
  Record<string, OperationParamValue | readonly OperationParamValue[]>
>;

/** One declared parameter of an operation (contract §4.1). */
export interface OperationParamSpec {
  /** Lower-kebab name, identical to the CLI flag spelling minus `--`. */
  name: string;
  type: OperationParamType;
  /** Absent parameters are omitted, never passed as `null` or `""`. */
  required?: boolean;
  /** When true, the value may be an array of `type`. */
  repeated?: boolean;
}

/**
 * The untrusted half of an invocation (contract §4).
 *
 * It names an operation and carries that operation's declared parameters, and
 * nothing else. There is no `argv`, no `command`, no `sessionId`, and no
 * `issueNumber` field here by design — see {@link OperationContext}.
 */
export interface OperationRequest {
  operationId: string;
  params: OperationParams;
}

// ---------------------------------------------------------------------------
// Trusted execution context (contract §5)
// ---------------------------------------------------------------------------

/** Which adapter is invoking. Used for audit and policy, never for routing. */
export type OperationSurface = "admin-cli" | "admin-ui" | "chatops" | "github-app";

/**
 * Who is invoking, as the *adapter* authenticated them — an operator shell
 * account, an allowlisted comment author, an app installation.
 *
 * Never derived from request parameters: a request that could name its own
 * actor is a request that can escalate itself.
 */
export interface OperationActor {
  kind: "human" | "automation";
  /** Non-blank stable identity (a login, an installation id, a shell user). */
  id: string;
}

/**
 * The trusted half of an invocation (contract §5).
 *
 * Every field here is established by the adapter from authenticated channel
 * state — the session it was started with, the work item the comment lives
 * on, the identity the provider reported — and never from
 * {@link OperationRequest.params}.
 */
export interface OperationContext {
  surface: OperationSurface;
  actor: OperationActor;
  /** The session whose configuration and stores the operation may touch. */
  sessionId: string;
  /**
   * The work item this invocation is scoped to, or `null` for a
   * session-scoped operation. A ChatOps adapter fills this from the issue the
   * comment lives on, unconditionally
   * (`docs/chatops-command-grammar-contract.md` §2's last rule).
   */
  issueNumber: number | null;
  /** Unique per invocation; the audit and idempotency handle (contract §9). */
  requestId: string;
  /**
   * False means preview: the operation describes what it would do and returns
   * `effect: "none"`. Mirrors the admin CLI's preview-by-default `--yes`
   * gate (`docs/admin-cli-contract.md`), hoisted into trusted context so no
   * user-supplied parameter can ever set it (contract §5.2).
   */
  confirmed: boolean;
  /**
   * Advisory wall-clock budget in ms, or `null` for none. Advisory because
   * this port has no cancellation: exceeding it produces an
   * indeterminate-effect failure, never a silent abort (contract §10).
   */
  deadlineMs: number | null;
}

/**
 * Parameter names an {@link OperationRequest} may never carry, because each
 * one either names a trusted context field or spells one the way a CLI flag
 * would (contract §5.1).
 *
 * This is a closed set, checked structurally rather than left to each
 * operation's own validation: an operation that forgot to reject
 * `--session-id` would otherwise let a comment retarget another session.
 * Output-mode flags are here too — the port returns data, never rendered
 * output, so an operation that accepted `json` would be re-inventing a
 * concern that does not exist at this layer (contract §7).
 */
export const OPERATION_RESERVED_PARAM_NAMES: readonly string[] = Object.freeze([
  "actor",
  "confirmed",
  "deadline-ms",
  "dry-run",
  "issue",
  "issue-number",
  "json",
  "request-id",
  "session-id",
  "session-ref",
  "surface",
  "yes",
]);

// ---------------------------------------------------------------------------
// Results (contract §7)
// ---------------------------------------------------------------------------

/**
 * Why an invocation was refused. Every reason here is **definite and
 * effect-free**: the operation provably did not run.
 */
export type OperationRejectionReason =
  | "unknown-operation"
  | "invalid-request"
  | "invalid-context"
  | "not-permitted"
  | "precondition-failed"
  | "conflict";

/** Why an invocation failed after it began. */
export type OperationFailureReason = "unavailable" | "timeout" | "internal";

/**
 * What the invocation did to the world outside the process.
 *
 * `unknown` is not a diagnostic nicety: it is the input the ChatOps ledger
 * needs to distinguish "retry is safe" from "an operator must look"
 * (`docs/chatops-execution-ledger-contract.md` §8, §11).
 */
export type OperationEffect = "applied" | "none" | "unknown";

/** The typed result of one invocation (contract §7). */
export type OperationResult =
  | {
      status: "executed";
      /** `none` when `context.confirmed` was false — a preview changed nothing. */
      effect: "applied" | "none";
      summary: string;
      /** Structured, already-redacted data for an adapter to render. */
      data?: Readonly<Record<string, unknown>>;
    }
  | {
      status: "rejected";
      reason: OperationRejectionReason;
      summary: string;
      /** Always `none` — a rejection is a definite non-event. */
      effect: "none";
    }
  | {
      status: "failed";
      reason: OperationFailureReason;
      /** `none` only when the operation proved it changed nothing. */
      effect: "none" | "unknown";
      summary: string;
    };

/** The visible marker a truncated summary ends with (contract §12). */
const SUMMARY_TRUNCATION_MARKER = "… (truncated)";

/**
 * Truncate an operator-facing summary to its documented bound (contract §12).
 *
 * The marker is part of the bound, not an addition to it: a ledger row or an
 * operator surface that sizes a column from `OPERATION_SUMMARY_MAX_CHARS` gets
 * a string that fits it, so the space the marker needs is reserved before the
 * slice rather than appended after it.
 */
export function boundOperationSummary(summary: string): string {
  if (summary.length <= OPERATION_SUMMARY_MAX_CHARS) return summary;
  const kept = OPERATION_SUMMARY_MAX_CHARS - SUMMARY_TRUNCATION_MARKER.length;
  if (kept <= 0) return SUMMARY_TRUNCATION_MARKER.slice(0, OPERATION_SUMMARY_MAX_CHARS);
  return `${summary.slice(0, kept)}${SUMMARY_TRUNCATION_MARKER}`;
}

/** Build an `executed` result. `effect` defaults to `applied`. */
export function operationExecuted(
  summary: string,
  options: { effect?: "applied" | "none"; data?: Readonly<Record<string, unknown>> } = {},
): OperationResult {
  const executed = {
    status: "executed" as const,
    effect: options.effect ?? ("applied" as const),
    summary: boundOperationSummary(summary),
  };
  return options.data === undefined ? executed : { ...executed, data: options.data };
}

/** Build a `rejected` result — definite, and effect-free by construction. */
export function operationRejected(
  reason: OperationRejectionReason,
  summary: string,
): OperationResult {
  return { status: "rejected", reason, summary: boundOperationSummary(summary), effect: "none" };
}

/**
 * Build a `failed` result.
 *
 * `effect` is required and has no default: whether an effect may exist is the
 * one fact only the operation knows, and defaulting it either way would be
 * this port guessing on a question the whole at-most-once chain depends on.
 */
export function operationFailed(
  reason: OperationFailureReason,
  effect: "none" | "unknown",
  summary: string,
): OperationResult {
  return { status: "failed", reason, effect, summary: boundOperationSummary(summary) };
}

// ---------------------------------------------------------------------------
// Descriptors and the registry (contract §4.2)
// ---------------------------------------------------------------------------

/** The two arguments of an invocation, kept separate all the way down. */
export interface OperationInvocation {
  request: OperationRequest;
  context: OperationContext;
}

/**
 * One operation implementation.
 *
 * It returns a typed result; it never writes to stdout, never consults a
 * process-global output mode, and never calls `process.exit`/`die`
 * (contract §11).
 */
export type OperationHandler = (
  invocation: OperationInvocation,
) => OperationResult | Promise<OperationResult>;

/** Everything an adapter needs to know about an operation without running it. */
export interface OperationDescriptor {
  id: string;
  /** One line, operator-facing; the CLI help text and the ChatOps help reply. */
  summary: string;
  /** True when a confirmed invocation changes durable state. */
  mutating: boolean;
  /** `issue` requires `context.issueNumber`; `session` requires it to be absent. */
  scope: "session" | "issue";
  params: readonly OperationParamSpec[];
  run: OperationHandler;
}

/** The lookup surface adapters hold. Deliberately read-only. */
export interface OperationRegistry {
  get(operationId: string): OperationDescriptor | undefined;
  list(): readonly OperationDescriptor[];
}

/**
 * A defect in a *registration* — a duplicate id, a malformed parameter name, a
 * reserved parameter name.
 *
 * Registration defects throw, invocation defects return results: a bad
 * descriptor is a programming error at the composition root that must stop
 * the process before it serves anyone, while a bad request is ordinary
 * untrusted input that must produce an answer (contract §4.2).
 */
export class OperationRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationRegistrationError";
  }
}

/**
 * Copy a descriptor into a frozen one, reading every field exactly once.
 *
 * A descriptor is supplied by the composition root, but it is still an object
 * this module did not build, and — unlike a request — it outlives the call that
 * introduced it. Whoever holds the original may keep writing to it: a handler
 * that sets `descriptor.mutating = true` while it runs would leave the *next*
 * invocation reading metadata nobody registered, and §5.2's guard would then
 * accept `applied` effects from an operation that was registered as
 * non-mutating. So the registry stores a frozen copy and hands that out; the
 * caller's object is never reachable through {@link OperationRegistry}.
 *
 * The copy is made before validation for the same reason a request's params
 * are: a field that answers differently on a second read must not be able to
 * pass the check and then be something else at the point of use.
 */
function freezeDescriptor(descriptor: OperationDescriptor): OperationDescriptor {
  if (!isRecordArgument(descriptor)) {
    throw new OperationRegistrationError(
      `descriptor must be an object, got ${describeArgument(descriptor)}`,
    );
  }
  const id: unknown = descriptor.id;
  const params: unknown = descriptor.params;
  if (!Array.isArray(params)) {
    throw new OperationRegistrationError(
      `operation ${describeValue(id)} declares params that are not an array, got ${describeArgument(params)}`,
    );
  }
  const frozen = {
    id,
    summary: descriptor.summary,
    mutating: descriptor.mutating,
    scope: descriptor.scope,
    params: Object.freeze(
      (params as readonly OperationParamSpec[]).map((param) => freezeParamSpec(id, param)),
    ),
    run: descriptor.run,
  } as OperationDescriptor;
  return Object.freeze(frozen);
}

function freezeParamSpec(descriptorId: unknown, param: OperationParamSpec): OperationParamSpec {
  if (!isRecordArgument(param)) {
    throw new OperationRegistrationError(
      `operation ${describeValue(descriptorId)} declares a parameter that is not an object, got ${describeArgument(param)}`,
    );
  }
  const spec = { name: param.name, type: param.type } as OperationParamSpec;
  const required = param.required;
  if (required !== undefined) spec.required = required;
  const repeated = param.repeated;
  if (repeated !== undefined) spec.repeated = repeated;
  return Object.freeze(spec);
}

function assertValidDescriptor(descriptor: OperationDescriptor): void {
  if (!OPERATION_ID_PATTERN.test(descriptor.id)) {
    throw new OperationRegistrationError(
      `invalid operation id ${describeValue(descriptor.id)}: expected resource.action in lower-kebab`,
    );
  }
  if (isBlank(descriptor.summary)) {
    throw new OperationRegistrationError(`operation ${descriptor.id} has a blank summary`);
  }
  // Both are load-bearing metadata rather than description: `mutating` is half
  // of §5.2's postcondition, and an unrecognized `scope` would match neither
  // scope check and so be checked by nothing at all.
  if (typeof descriptor.mutating !== "boolean") {
    throw new OperationRegistrationError(
      `operation ${descriptor.id} declares a non-boolean mutating flag: ${describeValue(descriptor.mutating)}`,
    );
  }
  if (descriptor.scope !== "session" && descriptor.scope !== "issue") {
    throw new OperationRegistrationError(
      `operation ${descriptor.id} declares unknown scope ${describeValue(descriptor.scope)}`,
    );
  }
  if (typeof descriptor.run !== "function") {
    throw new OperationRegistrationError(`operation ${descriptor.id} has no run function`);
  }
  const seen = new Set<string>();
  for (const param of descriptor.params) {
    if (!OPERATION_PARAM_NAME_PATTERN.test(param.name)) {
      throw new OperationRegistrationError(
        `operation ${descriptor.id} declares invalid parameter name ${describeValue(param.name)}`,
      );
    }
    if (OPERATION_RESERVED_PARAM_NAMES.includes(param.name)) {
      throw new OperationRegistrationError(
        `operation ${descriptor.id} declares reserved parameter ${JSON.stringify(param.name)}: trusted context fields are never parameters`,
      );
    }
    if (seen.has(param.name)) {
      throw new OperationRegistrationError(
        `operation ${descriptor.id} declares parameter ${JSON.stringify(param.name)} twice`,
      );
    }
    seen.add(param.name);
    // A spec's metadata is load-bearing in the same way `mutating` is: each
    // field decides how §4.1's validation reads a supplied value, so a
    // descriptor that came from unchecked JavaScript or from configuration must
    // not be able to declare one the port would then misread. An unknown `type`
    // would be checked as a boolean, and a string-valued `required` or
    // `repeated` — truthy, but never `true` — would silently make a required
    // parameter optional and a repeated one non-repeatable.
    if (!OPERATION_PARAM_TYPES.includes(param.type)) {
      throw new OperationRegistrationError(
        `operation ${descriptor.id} declares parameter ${JSON.stringify(param.name)} with unknown type ${describeValue(param.type)}`,
      );
    }
    for (const flag of ["required", "repeated"] as const) {
      const value: unknown = param[flag];
      if (value !== undefined && typeof value !== "boolean") {
        throw new OperationRegistrationError(
          `operation ${descriptor.id} declares parameter ${JSON.stringify(param.name)} with a non-boolean ${flag} flag: ${describeValue(value)}`,
        );
      }
    }
  }
}

/**
 * Build a registry from descriptors, rejecting every registration defect up
 * front.
 *
 * The registry is a *collection point*: an operation module exports its
 * descriptors and the composition root passes them in. A module never reaches
 * back into a registry to register itself — the same inward-pull direction
 * `docs/admin-command-registry-contract.md` §8 fixes for command registration
 * (contract §3.2).
 *
 * What it stores is a frozen copy, not the caller's object: registered
 * metadata is what the port checks its own postconditions against, so it must
 * not be rewritable by anyone who kept a reference — least of all by the
 * operation's own handler (see {@link freezeDescriptor}).
 */
export function createOperationRegistry(
  descriptors: readonly OperationDescriptor[],
): OperationRegistry {
  const byId = new Map<string, OperationDescriptor>();
  for (const supplied of descriptors) {
    const descriptor = freezeDescriptor(supplied);
    assertValidDescriptor(descriptor);
    if (byId.has(descriptor.id)) {
      throw new OperationRegistrationError(`duplicate operation id ${JSON.stringify(descriptor.id)}`);
    }
    byId.set(descriptor.id, descriptor);
  }
  const ordered = Object.freeze([...byId.values()]);
  return {
    get: (operationId: string) => byId.get(operationId),
    list: () => ordered,
  };
}

// ---------------------------------------------------------------------------
// Validation (contract §5.1, §6)
// ---------------------------------------------------------------------------

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/**
 * True for a plain object argument. An array is not one: an argv array reaching
 * either half of an invocation is exactly the mistake §6 forbids, and it must
 * produce an answer rather than be walked as if it were a record.
 */
function isRecordArgument(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeArgument(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * Render an untrusted value for a defect message. **This never throws.**
 *
 * `JSON.stringify` is not total — a BigInt raises, a cycle raises, a `toJSON`
 * or getter of the caller's choosing raises whatever it likes — and every one
 * of those values can reach this port, because an adapter is ordinary
 * JavaScript at the boundary. A refusal that threw while explaining itself
 * would leave the ChatOps ledger's T2→T3 window with no disposition to record
 * (`docs/chatops-execution-ledger-contract.md` §8), which is precisely the
 * failure the typed-result contract exists to prevent. So malformed values are
 * described by type rather than serialized: a caller that supplied one already
 * knows what it sent, and the message only has to say what was wrong with it.
 */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      // Total for a primitive string: no replacer, no cycle, no `toJSON`.
      return JSON.stringify(value);
    case "number":
    case "boolean":
      // Not JSON: `NaN` and `Infinity` serialize to `null`, and a message that
      // says a rejected value was `null` when it was `NaN` is a false one.
      return String(value);
    case "bigint":
      return `${String(value)}n`;
    case "symbol":
      return String(value);
    case "undefined":
      return "undefined";
    case "function":
      return "a function";
    default:
      return Array.isArray(value) ? "an array" : "an object";
  }
}

/** Describe a thrown value without assuming it can be converted to a string. */
function describeThrown(value: unknown): string {
  try {
    if (value instanceof Error && typeof value.message === "string") return value.message;
    // A thrown object usually carries its explanation in `toString`; that call
    // is the caller's code, so it is fenced rather than trusted.
    return String(value);
  } catch {
    return describeValue(value);
  }
}

/**
 * Validate the trusted half of an invocation, returning a defect message or
 * `null`.
 *
 * A malformed context is the adapter's bug, not the user's — but it is still
 * refused rather than defaulted, because every field here is an authority
 * claim and a defaulted authority claim is a forged one.
 */
export function validateOperationContext(context: OperationContext): string | null {
  // Checked before any field is read, for the same reason the actor is widened
  // below: the validator answers about a malformed context, it does not crash
  // on one.
  if (!isRecordArgument(context)) {
    return `context must be an object, got ${describeArgument(context)}`;
  }
  const surfaces: readonly OperationSurface[] = ["admin-cli", "admin-ui", "chatops", "github-app"];
  if (!surfaces.includes(context.surface)) {
    return `unknown surface ${describeValue(context.surface)}`;
  }
  // Widened deliberately: an adapter is ordinary JavaScript at the boundary,
  // and a context that arrived without an actor must be refused rather than
  // crash on the field access that would have proved it.
  const actor = context.actor as OperationActor | null | undefined;
  if (actor === null || actor === undefined || typeof actor !== "object") {
    return "actor is required";
  }
  if (actor.kind !== "human" && actor.kind !== "automation") {
    return `unknown actor kind ${describeValue(actor.kind)}`;
  }
  if (isBlank(actor.id)) return "actor id is required";
  if (isBlank(context.sessionId)) return "sessionId is required";
  if (isBlank(context.requestId)) return "requestId is required";
  if (typeof context.confirmed !== "boolean") return "confirmed must be a boolean";
  if (context.issueNumber !== null) {
    if (!Number.isInteger(context.issueNumber) || context.issueNumber <= 0) {
      return `issueNumber must be a positive integer or null, got ${describeValue(context.issueNumber)}`;
    }
  }
  if (context.deadlineMs !== null) {
    if (!Number.isFinite(context.deadlineMs) || context.deadlineMs <= 0) {
      return `deadlineMs must be a positive finite number or null, got ${describeValue(context.deadlineMs)}`;
    }
  }
  return null;
}

function matchesType(value: unknown, type: OperationParamType): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "boolean";
}

/**
 * Validate the untrusted half against the operation's declared parameters,
 * returning a defect message or `null`.
 *
 * Unknown parameters are refused, never ignored: silently dropping one turns
 * "the operation did something other than what was asked" into an invisible
 * event, and this port's whole purpose is that a caller can tell exactly what
 * it authorized.
 */
export function validateOperationRequest(
  descriptor: OperationDescriptor,
  request: OperationRequest,
): string | null {
  if (!isRecordArgument(request)) {
    return `request must be an object, got ${describeArgument(request)}`;
  }
  // Widened for the same reason as the context's actor: an argv array reaching
  // this field is exactly the mistake §6 forbids, so it must produce an answer
  // rather than a crash.
  const params = request.params as unknown as Record<string, unknown> | null | undefined;
  if (params === null || params === undefined || typeof params !== "object" || Array.isArray(params)) {
    return "params must be an object";
  }
  const declared = new Map<string, OperationParamSpec>(
    descriptor.params.map((spec) => [spec.name, spec] as const),
  );
  for (const name of Object.keys(params)) {
    if (OPERATION_RESERVED_PARAM_NAMES.includes(name)) {
      return `parameter ${JSON.stringify(name)} is reserved for trusted context and may never be supplied by a caller`;
    }
    const spec = declared.get(name);
    if (spec === undefined) {
      return `unknown parameter ${JSON.stringify(name)} for operation ${descriptor.id}`;
    }
    const value = params[name];
    if (Array.isArray(value)) {
      if (spec.repeated !== true) {
        return `parameter ${JSON.stringify(name)} is not repeatable`;
      }
      if (value.length === 0) {
        return `parameter ${JSON.stringify(name)} was supplied with no values`;
      }
      for (const entry of value) {
        if (!matchesType(entry, spec.type)) {
          return `parameter ${JSON.stringify(name)} expects ${spec.type} values`;
        }
      }
    } else if (!matchesType(value, spec.type)) {
      return `parameter ${JSON.stringify(name)} expects a ${spec.type}`;
    }
  }
  for (const spec of descriptor.params) {
    if (spec.required === true && !Object.prototype.hasOwnProperty.call(params, spec.name)) {
      return `missing required parameter ${JSON.stringify(spec.name)} for operation ${descriptor.id}`;
    }
  }
  return null;
}

/**
 * Copy the untrusted half into a frozen request, reading every value once, or
 * `null` when `params` is not an object at all.
 *
 * A caller's `params` may be a proxy or an object of getters, and it stays the
 * caller's object for the whole invocation. Validating it and then handing the
 * *same* object to the handler would mean the value the handler acts on is not
 * necessarily the value that passed validation: a getter can answer `safe` to
 * the check and `other` to the operation, and a plain object can simply be
 * rewritten while the handler is running. So each name and value is read once,
 * here, and it is this snapshot that is validated, handed to the handler, and
 * never anything else (contract §4.1).
 *
 * Reading may throw; the caller keeps this inside its exception boundary.
 */
function snapshotOperationRequest(
  operationId: string,
  request: OperationRequest,
): OperationRequest | null {
  const params = request.params as unknown;
  if (params === null || params === undefined || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }
  const source = params as Record<string, unknown>;
  // Null-prototype, because `params` is JSON an adapter decoded and JSON may
  // carry an own `"__proto__"` key. Written into an ordinary object, that name
  // hits `Object.prototype`'s inherited setter instead of adding an own key:
  // validation's `Object.keys` would not see it, and the handler would read
  // whatever it installed — an inherited value under a declared parameter's
  // name that nothing ever checked. With no prototype it is an ordinary own
  // key, so it is snapshotted, seen, and refused as an unknown parameter (no
  // declared name can spell it, per OPERATION_PARAM_NAME_PATTERN); nothing is
  // inherited into `params` for a handler to read either.
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of Object.keys(source)) {
    const value = source[name];
    // An array is copied too, or the caller could still grow or rewrite a
    // repeated parameter after every element of it had been type-checked.
    snapshot[name] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  return Object.freeze({ operationId, params: Object.freeze(snapshot) }) as OperationRequest;
}

const REJECTION_REASONS: readonly string[] = Object.freeze([
  "unknown-operation",
  "invalid-request",
  "invalid-context",
  "not-permitted",
  "precondition-failed",
  "conflict",
]);

const FAILURE_REASONS: readonly string[] = Object.freeze(["unavailable", "timeout", "internal"]);

/**
 * Both reason sets are closed, and a result carrying a reason outside its own
 * set is not a result: an adapter that pattern-matches on them (the ChatOps
 * ledger mapping does) must never meet one it has no row for.
 */
function isOperationResult(value: unknown): value is OperationResult {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as {
    status?: unknown;
    summary?: unknown;
    effect?: unknown;
    reason?: unknown;
  };
  if (typeof candidate.summary !== "string") return false;
  if (candidate.status === "executed") {
    return candidate.effect === "applied" || candidate.effect === "none";
  }
  if (candidate.status === "rejected") {
    return (
      candidate.effect === "none" &&
      typeof candidate.reason === "string" &&
      REJECTION_REASONS.includes(candidate.reason)
    );
  }
  if (candidate.status === "failed") {
    return (
      (candidate.effect === "none" || candidate.effect === "unknown") &&
      typeof candidate.reason === "string" &&
      FAILURE_REASONS.includes(candidate.reason)
    );
  }
  return false;
}

/**
 * Copy a handler's return value into a plain result, or `null` if it is not one.
 *
 * A handler returns an object this module did not build, so every field may be
 * an accessor: one that throws, or one that answers differently on a second
 * read. Each field is therefore read exactly once, into an ordinary object, and
 * it is that copy which is validated and handed to the caller — validating the
 * handler's object and then returning it would leave the caller free to observe
 * a value that never passed validation.
 *
 * Reading may still throw; the caller keeps this inside its exception boundary.
 */
function snapshotOperationResult(value: unknown): OperationResult | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as {
    status?: unknown;
    summary?: unknown;
    effect?: unknown;
    reason?: unknown;
    data?: unknown;
  };
  const status = candidate.status;
  const snapshot: Record<string, unknown> = {
    status,
    summary: candidate.summary,
    effect: candidate.effect,
  };
  if (status === "executed") {
    const data = candidate.data;
    if (data !== undefined) snapshot.data = data;
  } else {
    snapshot.reason = candidate.reason;
  }
  return isOperationResult(snapshot) ? snapshot : null;
}

// ---------------------------------------------------------------------------
// Invocation (contract §7, §10)
// ---------------------------------------------------------------------------

/** Everything settled before the handler runs, or the refusal that ends it. */
type InvocationPlan =
  | { readonly kind: "refused"; readonly result: OperationResult }
  | {
      readonly kind: "ready";
      readonly descriptor: OperationDescriptor;
      /** The validated id, captured once, for messages after the plan. */
      readonly operationId: string;
      /** The snapshot that was validated — never the caller's own object. */
      readonly request: OperationRequest;
      readonly mutating: boolean;
      readonly mayApply: boolean;
    };

/**
 * Decide everything that must hold before a handler is allowed to run.
 *
 * Every read in here lands on an object this port did not build: an adapter is
 * ordinary JavaScript at the boundary, so `operationId`, `params` and the
 * context's fields may be getters or proxy traps that throw. A dispatch attempt
 * that threw would leave the ChatOps ledger's T2→T3 window with no disposition
 * to record (`docs/chatops-execution-ledger-contract.md` §8), which is the one
 * thing this port must never do, so the whole stretch sits inside an exception
 * boundary.
 *
 * A throw here earns `rejected`, not the `failed` / `unknown` a lost handler
 * earns: no handler has run, so the non-event is definite. `half` tracks which
 * side of the boundary was being inspected, so the refusal names the half that
 * was actually unreadable.
 */
function planInvocation(
  registry: OperationRegistry,
  request: OperationRequest,
  context: OperationContext,
): InvocationPlan {
  let half: "invalid-context" | "invalid-request" = "invalid-context";
  try {
    // Both halves are checked for being an object at all before any field is
    // read off them — the context inside its validator, the request here,
    // because the operation id is read before the request's own validator runs.
    const contextDefect = validateOperationContext(context);
    if (contextDefect !== null) {
      return { kind: "refused", result: operationRejected("invalid-context", contextDefect) };
    }
    half = "invalid-request";
    if (!isRecordArgument(request)) {
      return {
        kind: "refused",
        result: operationRejected(
          "invalid-request",
          `request must be an object, got ${describeArgument(request)}`,
        ),
      };
    }
    // Read once, into a local: a second read of an accessor is free to answer
    // differently, and the id that is looked up must be the id that was checked.
    const operationId: unknown = request.operationId;
    if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
      return {
        kind: "refused",
        result: operationRejected(
          "unknown-operation",
          `malformed operation id ${describeValue(operationId)}`,
        ),
      };
    }
    const descriptor = registry.get(operationId);
    if (descriptor === undefined) {
      return {
        kind: "refused",
        result: operationRejected("unknown-operation", `no operation registered as ${operationId}`),
      };
    }
    half = "invalid-context";
    if (descriptor.scope === "issue" && context.issueNumber === null) {
      return {
        kind: "refused",
        result: operationRejected(
          "invalid-context",
          `operation ${operationId} is issue-scoped and requires a work item in context`,
        ),
      };
    }
    if (descriptor.scope === "session" && context.issueNumber !== null) {
      return {
        kind: "refused",
        result: operationRejected(
          "invalid-context",
          `operation ${operationId} is session-scoped and must not be given a work item`,
        ),
      };
    }
    half = "invalid-request";
    // Snapshotted before validation, so the values that are checked here are
    // the same values the handler will read (see `snapshotOperationRequest`).
    const snapshot = snapshotOperationRequest(operationId, request);
    if (snapshot === null) {
      return { kind: "refused", result: operationRejected("invalid-request", "params must be an object") };
    }
    const requestDefect = validateOperationRequest(descriptor, snapshot);
    if (requestDefect !== null) {
      return { kind: "refused", result: operationRejected("invalid-request", requestDefect) };
    }

    // The authority for §5.2's postcondition is taken here, before control
    // leaves for the handler. The handler holds a reference to the very context
    // object the check would otherwise read, and so does whoever built it;
    // re-reading `context.confirmed` afterwards would test whatever was last
    // written to it rather than the authority this invocation was actually
    // granted, which is all an unconfirmed operation would need to have its
    // `applied` effects acknowledged as authorized.
    half = "invalid-context";
    const mutating = descriptor.mutating;
    const mayApply = context.confirmed && mutating;
    return { kind: "ready", descriptor, operationId, request: snapshot, mutating, mayApply };
  } catch (error) {
    return {
      kind: "refused",
      result: operationRejected(
        half,
        `invocation could not be inspected: ${describeThrown(error)}`,
      ),
    };
  }
}

/**
 * Invoke one operation. **This is the port.**
 *
 * It is an ordinary function call: no argv is parsed, no subprocess is
 * spawned, no output is written. Every failure mode — unknown operation,
 * malformed request, forged trusted field, a boundary object that throws while
 * being read, a handler that throws — comes back as a typed
 * {@link OperationResult}, so a caller in the middle of a durable state machine
 * (the ChatOps ledger's T2→T3 window,
 * `docs/chatops-execution-ledger-contract.md` §8) always has something to
 * record.
 *
 * A handler that throws, or returns something that is not an
 * {@link OperationResult}, yields `failed` with `effect: "unknown"`: a
 * handler that lost control cannot vouch for what it already did, and
 * pretending otherwise is exactly how a command gets replayed on top of
 * effects that already landed.
 */
export async function invokeOperation(
  registry: OperationRegistry,
  request: OperationRequest,
  context: OperationContext,
): Promise<OperationResult> {
  // Everything decided before the handler runs is decided inside its own
  // exception boundary, because deciding it means reading fields off the two
  // objects the adapter supplied (see `planInvocation`).
  const plan = planInvocation(registry, request, context);
  if (plan.kind === "refused") return plan.result;
  const { descriptor, operationId, mutating, mayApply } = plan;

  let result: OperationResult | null;
  let returned = false;
  try {
    // `plan.request` rather than `request`: the handler acts on the validated
    // snapshot, so no parameter it reads can differ from the one that was
    // checked (contract §4.1).
    const raw = await descriptor.run({ request: plan.request, context });
    returned = true;
    // Deliberately inside the boundary: recognising the result means reading
    // fields off an object this port did not build, and an accessor that throws
    // must not escape as an exception. By the time a handler has returned it may
    // already have had its effect, and a caller mid-ledger needs a `failed` /
    // `unknown` disposition for that far more than it needs a stack trace.
    result = snapshotOperationResult(raw);
  } catch (error) {
    const detail = describeThrown(error);
    return operationFailed(
      "internal",
      "unknown",
      returned
        ? `operation ${operationId} returned a result that threw while being read: ${detail}`
        : `operation ${operationId} threw before returning a result: ${detail}`,
    );
  }
  if (result === null) {
    return operationFailed(
      "internal",
      "unknown",
      `operation ${operationId} returned a value that is not an operation result`,
    );
  }
  if (!mayApply && result.status === "executed" && result.effect === "applied") {
    // The one postcondition this port enforces (contract §5.2). An operation
    // that applied changes it was not authorized to apply has produced effects
    // nobody authorized and nobody characterized, so the honest report is an
    // indeterminate failure, not its own claim of success.
    const why = mutating ? "an unconfirmed invocation" : "a non-mutating operation";
    return operationFailed(
      "internal",
      "unknown",
      `operation ${operationId} reported applied effects for ${why}: ${result.summary}`,
    );
  }
  if (result.summary.length <= OPERATION_SUMMARY_MAX_CHARS) return result;
  const summary = boundOperationSummary(result.summary);
  if (result.status === "executed") return { ...result, summary };
  if (result.status === "rejected") return { ...result, summary };
  return { ...result, summary };
}
