/**
 * The ChatOps surface's operation registry — the composition root (issues
 * #1024, #1031).
 *
 * `docs/chatops-operation-mapping-contract.md` §7 fixes which verbs exist and
 * which canonical `resource.action` id each one invokes. This module is the
 * other half: which of those ids actually has a registered implementation on
 * this build.
 *
 * **What §11.2 required before an entry could exist here.**
 * `docs/operation-dispatch-port-contract.md` §11.2 admits an operation to a
 * registry only once its handler is a `{ request, context } → OperationResult`
 * core that parses no argv, writes no output, never calls `die()`/`process.exit`,
 * and takes its stores and providers by injection. §11.3 charges that
 * per-operation extraction to the issue that first needs the operation. Issue
 * #1029 split `tool-request.run` into `src/core/tool-request-run.ts` and issue
 * #1030 split `tool-request.resolve` into `src/core/tool-request-resolve.ts`,
 * each with a `createToolRequestXxxDescriptor` that binds the callable core to
 * the port. Issue #1031 registers both, which is what makes an authorized
 * `/grant` or `/resolve` comment actually run the Tool Request semantics
 * instead of being answered `unknown-operation`.
 *
 * **Why registration takes dependencies.** An operation core constructs nothing
 * for itself, so a descriptor is only callable once someone hands it a session,
 * the task and outbox stores, and the repo lock — facts a *composition root*
 * holds and a module-level constant cannot. So the catalog below is a list of
 * registrations rather than of ready descriptors: it fixes exactly which
 * operations this surface admits (that is a policy statement, and it belongs in
 * core), while the runtime halves stay with the entrypoint that opened them.
 * `src/handlers/tool-request-operation-context.ts` is where the admin CLI and
 * ChatOps meet: both assemble the injected context there, so both surfaces drive
 * one implementation of the business logic.
 *
 * **An unregistered verb is still not a special case.** Nothing outside this
 * module changed to accommodate registration, and nothing has to. A verb whose
 * operation is absent from a registry is answered `rejected` /
 * `unknown-operation` by `invokeOperation`, which
 * `docs/operation-dispatch-port-contract.md` §7 defines as definite and
 * effect-free; `chatOpsDispatchDisposition` maps it onto ledger row 8; and the
 * command is acknowledged with outcome `rejected` and a published summary like
 * any other definite refusal. That is what a caller passing an empty `deps` — or
 * a future verb whose operation nobody has extracted yet — still gets.
 */

import { createOperationRegistry } from "./operation-port.js";
import type {
  OperationContext,
  OperationDescriptor,
  OperationRegistry,
} from "./operation-port.js";
import {
  TOOL_REQUEST_RUN_OPERATION_ID,
  createToolRequestRunDescriptor,
} from "./tool-request-run.js";
import type { ToolRequestRunContext } from "./tool-request-run.js";
import {
  TOOL_REQUEST_RESOLVE_OPERATION_ID,
  createToolRequestResolveDescriptor,
} from "./tool-request-resolve.js";
import type { ToolRequestResolveContext } from "./tool-request-resolve.js";

/**
 * The runtime halves a ChatOps composition root supplies, one resolver per
 * registered operation.
 *
 * Each resolver receives the *trusted* {@link OperationContext} the dispatcher
 * built from ledger-scope facts (`chatOpsOperationContext`, #783) and returns
 * the operation's injected context for that one invocation — which is why the
 * per-issue worktree, the run id and the artifact directory can all be
 * invocation-specific without any of them being a request parameter.
 *
 * Every field is optional. An absent resolver is not a degraded mode: its
 * operation is simply not registered on that build, and its verb is answered
 * with the same definite `unknown-operation` refusal it got before either core
 * existed. That keeps a caller which holds no task store — a test, a diagnostic
 * pass — from having to fabricate one.
 */
export interface ChatOpsOperationDeps {
  toolRequestRun?: (
    invocation: OperationContext,
  ) => ToolRequestRunContext | Promise<ToolRequestRunContext>;
  toolRequestResolve?: (
    invocation: OperationContext,
  ) => ToolRequestResolveContext | Promise<ToolRequestResolveContext>;
}

/**
 * One admitted operation: its canonical id, and how to build its descriptor
 * from the composition root's dependencies.
 *
 * `create` returns `null` when the root supplied no runtime half for this
 * operation — see {@link ChatOpsOperationDeps}.
 */
export interface ChatOpsOperationRegistration {
  /** The canonical `resource.action` id, matching the §7 mapping table. */
  id: string;
  create(deps: ChatOpsOperationDeps): OperationDescriptor | null;
}

/**
 * Operations a ChatOps command may invoke on this build.
 *
 * Exactly the two the §7 mapping table names, and nothing else: `/grant` →
 * `tool-request.run` and `/resolve` → `tool-request.resolve`. Adding a third
 * entry is a deliberate act that requires its own §11.2 extraction first —
 * `createOperationRegistry` enforces the structural half of that gate (id shape,
 * reserved parameter names, declared metadata) and throws at construction rather
 * than at invocation.
 */
export const CHATOPS_OPERATION_DESCRIPTORS: readonly ChatOpsOperationRegistration[] = Object.freeze([
  Object.freeze({
    id: TOOL_REQUEST_RUN_OPERATION_ID,
    create: (deps: ChatOpsOperationDeps) =>
      deps.toolRequestRun === undefined
        ? null
        : createToolRequestRunDescriptor(deps.toolRequestRun),
  }),
  Object.freeze({
    id: TOOL_REQUEST_RESOLVE_OPERATION_ID,
    create: (deps: ChatOpsOperationDeps) =>
      deps.toolRequestResolve === undefined
        ? null
        : createToolRequestResolveDescriptor(deps.toolRequestResolve),
  }),
]);

/**
 * Build the registry the ChatOps runtime dispatches through.
 *
 * `extra` exists for tests and for a caller that composes an operation from
 * dependencies only it holds — a registry is a *collection point*, and an
 * operation module never reaches back into one to register itself
 * (`docs/operation-dispatch-port-contract.md` §3.2).
 */
export function createChatOpsOperationRegistry(
  deps: ChatOpsOperationDeps = {},
  extra: readonly OperationDescriptor[] = [],
): OperationRegistry {
  const descriptors: OperationDescriptor[] = [];
  for (const registration of CHATOPS_OPERATION_DESCRIPTORS) {
    const descriptor = registration.create(deps);
    if (descriptor !== null) descriptors.push(descriptor);
  }
  return createOperationRegistry([...descriptors, ...extra]);
}
