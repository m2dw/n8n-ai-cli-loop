# ChatOps operation mapping and routing protection

Status: **approved design, implemented** (`src/core/chatops-operation-mapping.ts`).

This "implemented" status is component-level, not end-to-end: see
[feature-status.md](feature-status.md) for ChatOps's overall availability,
which stays `foundation-only` until comment ingestion, dispatch, and result
publication are connected.

This is issue #784, split part 2 of superseded #779. It is the layer
`docs/operation-dispatch-port-contract.md` (#783) leaves unspecified between
recognition and invocation: given one recognized ChatOps command — a verb plus
an argv-style token array (`docs/chatops-command-grammar-contract.md`, #780,
§2) — which canonical operation does it invoke, which of that operation's
parameters may the comment ever set, and what happens to argv that does not
fit. It supersedes the mapping/routing portion of #779 and of #696 / PR #776.

The review of PR #776 found two failures this document exists to prevent:
parsed comment arguments could override trusted session routing, and the
design targeted `tool-request grant`, a deprecated CLI alias
(`docs/admin-command-registry-contract.md` §2.3), rather than its canonical
successor. Both are closed here by construction rather than by convention —
see §3 and §4.

It does **not** specify operation internals (#783's scope), cursor/ledger
behavior (#781, #782), or how a result is published back to a comment (the
successor issue this one names "result, acknowledgement, and dependency
contract").

## 1. Terminology

| Term | Meaning |
| --- | --- |
| **Verb** | The word a comment writes after `/` (`docs/chatops-command-grammar-contract.md` §2's `ChatOpsCommand.verb`), e.g. `"grant"`. Never itself an operation id. |
| **Mapping** | One verb bound to exactly one canonical `OperationRequest.operationId`, a scope, a mutating flag, and a closed parameter allowlist. |
| **Table** | The full set of mappings a surface may route through — see §7. Its key set *is* the `supportedVerbs` argument `recognizeChatOpsComment` (#780) requires. |
| **Allowlisted parameter** | An operation parameter a mapping explicitly names. Everything else a comment supplies is refused, never ignored. |
| **Trusted field** | Anything `chatOpsOperationContext` (#783 §9.1) injects — session, issue, actor, surface, request id, confirmation. Never a mapping parameter, by construction (§3). |
| **Request** | The untrusted half of an invocation this module produces: `{ operationId, scope, mutating, params }`, ready to become an `OperationRequest`. |

## 2. Why a verb is not an operation id, and a mapping is not a registry entry

An `OperationDescriptor` (#783 §4.2) is registered once, by the module that
implements an operation, and describes what that operation *understands*. A
`ChatOpsOperationMapping` is authored once, by this contract, and describes
what one comment surface is *permitted to ask for* — a strict subset, chosen
per verb, of what the operation understands. Declaring a parameter on an
operation is not the same as permitting ChatOps to set it
(`docs/operation-dispatch-port-contract.md` §4.1's closing line); this
document is where that permission is actually decided, verb by verb, and
`createChatOpsOperationMappingTable` enforces the decision structurally
(§4) rather than leaving each mapping to remember it.

The two structures are independent by design: no operation for `tool-request
run` is registered anywhere in this codebase yet
(`docs/operation-dispatch-port-contract.md`, "No operation is registered
yet"), and this contract does not register one. A mapping's `operationId`,
`scope`, and `mutating` fields are this contract's own declaration of what it
believes about the eventual operation; once one is registered, the two must
agree, which is a check for the issue that does the registering, not this one
(§12).

## 3. Trusted fields are never a mapping parameter

`chatOpsOperationContext` (#783 §9.1) already builds `surface`, `actor`,
`sessionId`, `issueNumber`, `requestId`, `confirmed`, and `deadlineMs` from
ledger-scope facts — never from a comment. This document's job is narrower
and specific to *this* surface: make sure no mapping's parameter allowlist
ever re-opens one of those fields, or a fact shaped like one, through the
back door of an operation-specific flag name the port's own reserved set
(`OPERATION_RESERVED_PARAM_NAMES`) does not yet know about because no
operation has registered it.

`CHATOPS_FORBIDDEN_PARAM_NAMES` is the closed set: every name in
`OPERATION_RESERVED_PARAM_NAMES` (contract §5.1's `actor`, `confirmed`,
`deadline-ms`, `dry-run`, `issue`, `issue-number`, `json`, `request-id`,
`session-id`, `session-ref`, `surface`, `yes`), plus the ChatOps-specific
names a routing override or a state-store location would take on an admin CLI
flag today: `command`, `commands`, `sessions-path`, `db-path`, `lock-dir`,
`repo-root`, `repo`, `repository`, `provider`, `provider-endpoint`,
`provider-owner`, `provider-repo`, `state-path`, `path`.

`command` sits in that list for a distinct reason from the others. It is not
a routing selector — it is the shape §6 exists to name on its own: a
parameter whose *value* is itself a free-form shell command. No allowlist
subset makes that safe to expose, so it is refused unconditionally rather
than validated.

The set is checked **at table-construction time**
(`createChatOpsOperationMappingTable`, mirroring `createOperationRegistry`'s
own posture for `OPERATION_RESERVED_PARAM_NAMES`): a mapping that declares a
forbidden parameter throws `ChatOpsOperationMappingError` before the table
exists, not a refusal discovered per-comment. An operation that forgot to
withhold `session-id` would otherwise be one review-miss away from a comment
retargeting another session; checking it structurally removes "every mapping
remembers" from the list of things that have to stay true.

## 4. Deprecated operation ids are refused at the same layer

`CHATOPS_DEPRECATED_OPERATION_IDS` currently holds exactly
`tool-request.grant`, mirroring the admin CLI's deprecated `tool-request
grant` alias for `tool-request run`
(`docs/admin-command-registry-contract.md` §2.3). A mapping whose
`operationId` names a deprecated id throws `ChatOpsOperationMappingError` at
construction, for the same reason a forbidden parameter does: PR #776's
review found the alias-targeting failure occurring at design time, so the
fix is a check that runs before any comment is evaluated, not a runtime
refusal that depends on a reviewer noticing the wrong id in a table.

This is deliberately narrower than "ChatOps may never resolve a Tool
Request." The verb `/grant` **is** supported (§7) — it is the comment-facing
word an operator already expects, kept for continuity — and it maps to
`tool-request.run`, the canonical, non-deprecated id. What is refused is a
mapping whose *operation id* is the deprecated one, regardless of which verb
spells it; the verb is UI vocabulary, the operation id is the only thing that
is ever invoked.

## 5. Argv → request: the algorithm

`mapChatOpsCommandToOperationRequest({ verb, argv }, table)` is total over
every `{ verb, argv }` a recognized `ChatOpsCommand` (#780 §2) can produce. It
never throws, and it returns exactly one of three outcomes (§8).

1. **Verb lookup.** `table.get(verb)`. Absent → `unsupported-operation` (§8).
2. **Token walk.** `argv` is read left to right. Every token must start with
   `--` and be longer than two characters — a bare positional is always
   `invalid-argument`, because no mapping this contract defines a positional
   parameter for, and giving argv position any meaning here is exactly the
   admin-CLI-argv-to-a-comment risk `docs/operation-dispatch-port-contract.md`
   §1 rejects as an adapter strategy. For each flag:
   - Unknown name (not in the verb's allowlist) → `invalid-argument`. This is
     also how a forbidden or reserved name is refused per comment. even
     though it can never appear in a *mapping* (§3, §4) — the request-mapping
     path and the table-construction path enforce the same closed set from two
     different directions, one at comment time and one at authoring time.
   - `boolean`-typed flags never consume a following token; presence is the
     value. Every other type requires a following token that does not itself
     start with `--` (the grammar, #780 §2, never produces a value token that
     does — so seeing one here means the flag was given no value, not that a
     legitimate value happens to look like a flag) → `invalid-argument` when
     absent or shaped like a flag.
   - Occurrences are collected per name, in argv order, without deciding
     anything about them yet.
3. **Duplicate resolution (§6).** For each name that occurred more than once:
   `repeated !== true` → `invalid-argument`, unconditionally. A name that
   occurred once, or that is declared `repeated`, proceeds to coercion.
4. **Type coercion.** Each raw string is coerced to the spec's `type`
   (`string` passes through; `number` via `Number(...)`, rejecting blank,
   `NaN`, and non-finite; `boolean` is always `true`, since a boolean flag
   never carries a text value). Any failed coercion → `invalid-argument`.
5. **Required check.** Any `required: true` spec absent from the collected
   names → `invalid-argument`.
6. **Assembly.** A frozen, prototype-less `params` object — one non-repeated
   value or one frozen array per repeated name — is returned as
   `{ kind: "request", operationId, scope, mutating, params }`.

## 6. Duplicate/repeated options never depend on argv order

A flag given twice is refused *because of its count*, checked once the whole
argv has been walked — never by "the first occurrence wins" or "the last
occurrence wins," both of which would make the resulting request depend on
where in the comment a token happened to sit. `/grant --disposition commit
--disposition discard` and `/grant --disposition discard --disposition
commit` produce the identical `invalid-argument` outcome, not two different
silently-accepted requests. A `repeated: true` parameter collects every
occurrence into an array in argv order — order *within* the array is
observable, since it is the caller's own repetition, but *whether the
request is accepted at all* never is.

## 7. The supported table

| Verb | Operation id | Scope | Mutating | Allowlisted parameters |
| --- | --- | --- | --- | --- |
| `grant` | `tool-request.run` | issue | yes | `disposition` (string, optional) |
| `resolve` | `tool-request.resolve` | issue | yes | `action` (string, required), `message` (string, optional) |

Both verbs are issue-scoped, matching `chatOpsOperationContext` filling
`issueNumber` unconditionally from the issue the comment lives on
(`docs/chatops-command-grammar-contract.md` §2's last rule) — a session-scoped
mapping would be rejected by the port itself (`invalid-context`) the moment an
issue-carrying context reached it, so every mapping in this table declares
`scope: "issue"` for that reason, not by coincidence.

`grant`'s withheld parameters, and why each is withheld, are documented next
to `CHATOPS_OPERATION_MAPPINGS` in the source and repeated here for the
scenarios in §9: `--command` is never exposed (§4's `command`, unconditional
— the free-form-command risk this whole contract exists to close);
`--session-id` / `--session-ref` / `--issue-number` are trusted-context
fields (§3); `--sessions-path` / `--db-path` / `--lock-dir` are state-store
locations (§3); `--ttl-seconds` / `--max-uses` are left at the operation's
own defaults rather than opened to a comment, since neither is a routing
concern this contract must guarantee and the acceptance criterion is
*minimality*, not "everything not forbidden." `resolve`'s withheld
`--dry-run` is confirmation, which is trusted context
(`docs/operation-dispatch-port-contract.md` §5.2), never a parameter.

## 8. Outcomes

```ts
type ChatOpsOperationMappingOutcome =
  | { kind: "unsupported-operation"; verb: string }
  | { kind: "invalid-argument"; verb: string; detail: string }
  | { kind: "request"; operationId: string; scope: "session" | "issue"; mutating: boolean; params: Readonly<Record<string, ...>> };
```

- `unsupported-operation` covers two cases that are indistinguishable from
  this module's side and deliberately not distinguished: a verb nobody ever
  mapped, and a verb some other admin surface supports but this contract
  chose not to expose at all (§9's "no safe ChatOps mapping" scenario — e.g.
  `repo-lock force-release` and `worktree discard`, both destructive
  operator-only actions with no scoped, minimal, comment-safe parameter set;
  `tool-request list`, which reads across every session's requests and so has
  no issue-scoped shape to begin with). Neither case is a defect a comment
  author caused, so the outcome carries no more detail than the verb that
  failed to resolve, the same posture #780's `unsupported-command` recognition
  outcome already takes for the identical reason.
- `invalid-argument` covers a mapped verb whose argv did not fit the
  allowlist: positional tokens, unknown parameters, malformed duplicates,
  missing values, failed coercion, or a missing required parameter. `detail`
  is operator-facing text about the *shape* of the argv, never an echo of a
  value that could carry attacker-controlled content back into a rendered
  reply — callers that publish `detail` should still treat it as untrusted
  formatting input, not user-facing prose to trust verbatim (out of scope
  here; owned by the publication contract, §16 of #783's document).
- `request` is the untrusted half of an invocation, ready to pair with
  `chatOpsOperationContext`'s trusted half and become an `OperationRequest` /
  `OperationContext` pair for `invokeOperation` — once an operation is
  registered to receive it (§2).

## 9. Required scenarios

- **`/grant --session-ref other`, or a repeated trusted selector.**
  `session-ref` is not in `grant`'s allowlist at all (§3, §7), so this is
  `invalid-argument` on the first unknown-parameter check, before duplicate
  detection ever runs. Repeating it changes nothing: an unknown parameter is
  refused the same way once or five times.
- **The same issue number in two sessions, or two repositories.** This
  module never reads or emits a session, repository, provider, or issue
  identity — `scope` says only whether the eventual context must carry an
  issue number, and the number itself comes from
  `chatOpsOperationContext`'s ledger-scope identity (#783 §9.1), which is
  built from `ChatOpsProviderIdentity`, not from anything this module
  touches. Two attempts with identical `issueNumber` but distinct
  `identity.sessionId` (or `identity.providerOwner`/`providerRepo`) produce
  identical `request.operationId`/`params` from this module and distinct
  `context.sessionId` from #783's — the two never merge into one invocation
  because they are never in the same object.
- **A deprecated alias supplied as a command.** Covered two ways: no mapping
  in `CHATOPS_OPERATION_MAPPINGS` targets `tool-request.grant` (and
  `createChatOpsOperationMappingTable` refuses one that tried to, §4); and
  the supported verb that means the same thing, `grant`, resolves to the
  canonical `tool-request.run`.
- **An extra option accepted by the admin CLI but forbidden in ChatOps.**
  `tool-request run --command <cmd>` is a valid admin CLI invocation
  (`docs/admin-command-registry-contract.md` §2.2); `/grant --command <cmd>`
  is `invalid-argument` — `command` is forbidden outright (§3) and is not in
  `grant`'s allowlist (§7) regardless.
- **An operation with no safe ChatOps mapping.** A verb like `force-release`
  or `discard`, mirroring `repo-lock force-release` / `worktree discard`, has
  no entry in the table at all and resolves to `unsupported-operation` (§8) —
  there is no partial or best-effort mapping for an operation this contract
  chose to keep operator-only.

## 10. Test seams and matrix

- **Table construction is a pure function over data.** `test/chatops-operation-mapping.test.js` builds tables from hand-written mapping arrays and asserts `ChatOpsOperationMappingError` for every declaration defect in §3/§4, with no operation, port, or ledger involved.
- **Request mapping is a pure function over `{ verb, argv }`.** The same file drives `mapChatOpsCommandToOperationRequest` directly — no comment, no provider, no clock — covering: unsupported verb; every forbidden/unknown parameter name; positional tokens; a flag with no value; a value-shaped-like-a-flag; a duplicate non-repeated parameter (both orders, per §6); a valid repeated parameter; failed number coercion; a missing required parameter; the full `grant` and `resolve` happy paths.
- **End-to-end recognition → mapping**, composing #780's `recognizeChatOpsComment` with this module's `mapChatOpsCommandToOperationRequest`, and separately with #783's `chatOpsOperationContext`, to pin the required scenarios in §9 as executable tests rather than prose alone.
- **The docs pin.** `test/docs-chatops-operation-mapping-contract.test.js` pins this document's forbidden-parameter set, deprecated-id set, the supported table (§7), the outcome shapes (§8), and the required scenarios (§9) against drift.

## 11. Invariants

1. A mapping's parameter allowlist never contains a trusted-context name or a
   free-form-command-shaped name; a table containing one does not exist —
   construction throws first.
2. A mapping never targets a deprecated operation id; a table containing one
   does not exist.
3. Every accepted comment maps to exactly one canonical operation id, never
   to argv, never to a positional token, and never to more than the
   allowlisted parameters for its verb.
4. Whether a duplicate parameter is accepted depends only on its count and
   its `repeated` declaration, never on which occurrence came first or last.
5. This module never builds trusted context and never invokes an operation;
   both stay #783's.

## 12. Non-goals and forward pointers

- **Operation registration.** No operation is registered by this document —
  `operationId`/`scope`/`mutating` are this contract's own declaration, to be
  checked against a real `OperationDescriptor` by whichever issue registers
  `tool-request.run` and `tool-request.resolve`.
- **Result and acknowledgement publication**, and how `detail`/`summary` text
  becomes a comment — the successor issue named in this issue's own
  dependency list ("result, acknowledgement, and dependency contract").
  **Delivered (#785)**: `docs/chatops-result-contract.md`, whose §6 fixes
  exactly this — `detail` is not exempt from the visibility pipeline that any
  operation's `summary` passes through.
- **Tool Request grant tiers over typed operation ids** —
  `docs/operation-dispatch-port-contract.md` §16, #697. **Delivered
  (#697)**: `docs/tool-request-grant-tiers-contract.md`, which adds no
  ChatOps verb and does not modify this document's §7 table — its tiers
  govern the loop's own automation path at the Tool Request gate, and any
  configurable policy engine over the ChatOps table itself stays exactly
  where this section's final bullet leaves it.
- **Which operations a surface may reach under a configurable policy** (as
  opposed to this document's fixed, closed table) — any future per-session or
  per-actor tiering remains that later work's scope; this document fixes the
  ChatOps table itself, not a policy engine over it.
