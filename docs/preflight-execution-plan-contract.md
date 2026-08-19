# Preflight Execution Plan contract

Status: **approved design, not yet implemented** (issue #915). This document
is the authoritative contract for the preflight Execution Plan: a durable,
operator-approvable record — produced before write-capable implementation
begins — of the environment-preparation, verification, and predictable
Tool Request operations an issue (or a chain of issues) is expected to need.
Follow-up implementation issues reference this specification and MUST NOT
redefine its policy; a change of policy is a change to this document first.

This is issue #915, the first successor of the grant-tiers contract in the
executable chain
`#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917
→ #918 → #919 → #722` (see the issue body for the authoritative GitHub Issue
Relationships). It consumes `docs/tool-request-grant-tiers-contract.md`
(#697) as its trust-model foundation and adds no runtime behavior: runtime
execution and platform isolation are deferred to the chain's later issues.

It does **not** specify, and no implementation built against it may assume:

- **The typed-operation registry, the three tiers, tier resolution, the
  enforcing execution boundary, effect verification, and the audit record**
  — fixed by `docs/tool-request-grant-tiers-contract.md` (#697). This
  document adds no tier, no `TierRefusalReason` member, and no change to
  that registry's policy triple (§16).
- **The Tool Request emission contract, the exact/redacted command split,
  the task-context metadata record, scoped grants, and the continuation
  point** — fixed by `docs/tool-request-and-dependency-sync.md` §2.
- **The guided operator flow** — fixed by
  `docs/guided-tool-request-flow.md`; the human gate *is* that flow,
  unchanged.
- **The shipped `environmentPrepare`, `verification`, and `dependencySync`
  mechanisms** — fixed by `docs/environment-prepare-contract.md` and
  `docs/tool-request-and-dependency-sync.md` §3. This document changes none
  of their behavior (§3, §16).
- **Operation identity** — `"resource.action"` ids per
  `docs/operation-dispatch-port-contract.md` §4.1.
- **Chain identity and membership** — fixed by the chain registry
  (`docs/DOMAIN.md` §5's chain track, issues #788/#890). This document
  reads membership; it never schedules (§13).

## 1. Why a preflight plan — the gap this contract closes

The loop's goal is long unattended runs, and the operations that interrupt
them are mostly *knowable before implementation starts*: which command
prepares the worktree, which commands verify the result, which dependency
addition the Issue itself announces. Today those needs are served at two
grains, and both have a cost:

- **Session configuration** (`environmentPrepare`, `verification`,
  `dependencySync`, and #697's `toolRequestTiers` allowlist) is
  operator-owned and runs unattended — but it is *session-wide and
  standing*. An operation needed by one issue only (an integration-test
  script, a known dependency addition) either becomes a routine
  `sessions.json` edit or is not covered at all.
- **Per-occurrence approval** (the Tool Request human gate,
  `docs/guided-tool-request-flow.md`) covers everything else — but it stops
  the loop once per occurrence, at the exact moment the operator was not
  watching, for a need that was usually predictable from the Issue,
  repository, chain, and session before the agent ever ran.

The preflight Execution Plan moves the decision to where the knowledge
already is. Before write-capable implementation begins, the runner
assembles the expected operations into a durable plan; the operator reviews
it once and approves the plan as a whole; during the run, the runner —
never the implementation agent — authorizes each planned occurrence against
the approved snapshot, fail-closed per occurrence.

The unit of planning and approval is the **typed operation** of #697 §4,
never command text. `docs/tool-request-grant-tiers-contract.md` §1
established that safety is **undecidable from command text**; this contract
inherits that result whole. A plan is therefore best understood in one
sentence: **an issue-/chain-scoped, snapshot-fingerprinted, operator-approved
extension of the #697 session allowlist, plus an observational record of the
session-default mechanisms that will run anyway.** Execution mechanics,
tier ceilings, containment, effect verification, and audit all inherit from
#697 §7–§11 unchanged.

## 2. Terminology

- **Execution Plan (plan)** — the immutable, fingerprinted snapshot of
  expected operations for a scope (§4, §6).
- **Scope** — the session, repository, and issue set (a single issue or a
  chain segment) a plan covers (§4).
- **Plan lineage** — the stable identity supersession is keyed on:
  `(sessionId, repo, issueNumber)` for a single-issue plan,
  `(sessionId, repo, chainId)` for a chain-segment plan. Deliberately
  independent of `scope.issues`, so a chain-membership edit stays inside
  one lineage (§11).
- **Plan entry** — one expected typed-operation occurrence: operation id,
  typed params, pinned operation contract, authorization class, provenance,
  and assumptions (§4).
- **Pinned operation contract** — the entry's fixed command (or in-process
  routine), cwd, environment, network, timeout, output, and side-effect
  policy, resolved at snapshot time and frozen by the fingerprint (§4).
- **Authorization class** — `"session-default"` (already authorized by
  operator-owned session configuration; recorded observationally),
  `"plan-approval"` (authorized by the operator's plan decision), or
  `"unresolved"` (never authorizable; will human-gate) (§4, §5).
- **Baseline evidence** — a named, content-addressed input the plan's
  assumptions bind to: a session-config block, a repository file fragment at
  the base revision, an Issue-derived datum, chain membership — each
  carrying the typed locator and canonicalization id its re-derivation
  resolves (§4, §6).
- **Plan fingerprint** — the SHA-256 of the plan's canonical serialization;
  the identity approval binds to (§6).
- **Approval record** — the durable operator decision bound to exactly one
  plan fingerprint (§7).
- **Authorization resolution** — the pure, runner-side decision whether a
  concrete need is covered by the plan, with a closed refusal set (§9).
- **Need** — a concrete occurrence to authorize: a runner-owned planned
  step, or an agent Tool Request that #697 §6 rule 2 nomination has
  resolved to a typed operation (§9).

## 3. Position among the runner-owned mechanisms

`docs/environment-prepare-contract.md` §1 fixes four strictly separate
mechanisms: dependency sync, environment prepare, verification, and Tool
Request. **The plan is not a fifth executor.** It executes nothing, owns no
subprocess, and introduces no new way for bytes to run. It is an
authorization and provenance record consulted by the runner at the points
where execution is already decided today:

- The shipped `environmentPrepare`, `verification`, and dependency-sync
  runs keep executing exactly as their contracts specify, whether or not a
  plan exists. The plan *records* them as `"session-default"` entries so the
  operator sees the complete preflight picture and so drift in "what will
  run" is detectable — recording is observational, never gating (§5).
- The new capability — unattended execution of operations that would
  otherwise stop per occurrence — applies only to `"plan-approval"` entries,
  and those execute through #697's relaxed-tier machinery (§7–§8 of that
  contract: enforcing boundary, effect verification, patch-level adoption,
  audit), with the plan approval standing where the session allowlist entry
  would otherwise stand (§9, §10).
- Everything the plan does not cover falls through to the flow that exists
  today: #697 tier resolution, its migration exception, and the guided
  human gate. A preflight refusal subtracts nothing (§9; the one
  reason-scoped exception, `"occurrence-exhausted"`, parks for a human
  instead of re-entering the legacy route — §9's carve-out).

## 4. The Execution Plan schema (normative)

```ts
interface PreflightExecutionPlan {
  schemaVersion: 1;
  scope: {
    sessionId: string;                 // canonical session id
    repo: { provider: string; owner: string; name: string };
    issues: readonly number[];         // one issue, or the chain-segment members (§13)
    chainId?: string;                  // chain-registry id when scope came from a chain
  };
  baseline: {
    baseBranch: string;
    evidence: readonly PlanEvidence[]; // named, content-addressed inputs (§6)
  };
  entries: readonly PreflightPlanEntry[];
  assembledBy: "runner" | "operator";
  planFingerprint: string;             // "sha256:<hex>", over the canonical form (§6)
}

interface PlanEvidence {
  name: string;        // unique within the plan (§4 validation);
                       // e.g. "session:verification", "repo:package.json#scripts.test"
  source: "session-config" | "repository-base" | "issue"
        | "chain-registry" | "operation-registry";
  locator: EvidenceLocator;  // typed re-derivation descriptor; its variant must equal `source` (§4 validation)
  canonicalization: "utf8-bytes@1" | "json-canonical@1";  // closed, versioned: retrieved value → canonical bytes
  fingerprint: string; // "sha256:<hex>" of the canonical evidence bytes the locator re-derives
}

type SessionConfigLocator =
  { source: "session-config"; keyPath: readonly string[] };  // into the session block, e.g. ["verification", "test"]

type EvidenceLocator =
  | SessionConfigLocator
  | { source: "repository-base"; file: string;         // worktree-relative, read at the base revision (§5)
      selector?: { parser: string; fragment: string } } // versioned fixed-parser id + the fragment it extracts
  | { source: "issue"; issueNumber: number;
      field: "title" | "body" | "labels"; parser: string }  // §5 fixed parser whose typed output is the value
  | { source: "chain-registry"; chainId: string }      // the chain's member set (§13)
  | { source: "operation-registry"; operationId: string };  // the operation's registry row, template included

type OperationParamValue = string | number | boolean;   // #783 §4.1's scalar set, verbatim
type OperationParams =                                   // #783 §4.1's `OperationRequest.params` value type,
  Readonly<Record<string, OperationParamValue | readonly OperationParamValue[]>>;  // verbatim; no nested structures

type PreflightPlanEntry = ResolvedPlanEntry | UnresolvedPlanEntry;

interface ResolvedPlanEntry {
  entryId: string;                     // "<operationId>#<n>", unique within the plan
  operationId: string;                 // "resource.action", #697 §4 / #783 §4.1 identity
  family: "environment" | "verification" | "tool-request";
  params: OperationParams;             // typed data, validated by the operation's closed grammar;
                                       // required — `{}` for a zero-parameter operation, never omitted
  authorization: "session-default" | "plan-approval";
  tier?: "auto-grant" | "notify-and-proceed"; // #697 §5 entry tier; required iff authorization is "plan-approval" (§9)
  pinned: PinnedOperationContract;
  assumptions: readonly string[];      // names into baseline.evidence; every name must resolve
  origin: "session" | "repository" | "issue" | "chain";  // the layer that nominated it (§5)
}

interface UnresolvedPlanEntry {
  entryId: string;                     // "unresolved#<n>"
  authorization: "unresolved";
  origin: "session" | "repository" | "issue" | "chain";
  proposal: { displaySummary: string };  // redacted, bounded; never an executable pin
}

interface PinnedOperationContract {
  execution:
    | { kind: "pinned-command"; source: "registry-template";
        command: string }                   // rendered from the fixed template and grammar-validated params (§5, §6)
    | { kind: "pinned-command"; source: "session-config";
        commandRef: SessionConfigLocator;   // where the operator-owned bytes live — never the bytes (§6)
        commandDigest: string }             // "sha256:<hex>" of the exact command's UTF-8 bytes
    | { kind: "in-process"; routine: string };
  cwd: "issue-worktree";               // the only value; canonical repo is unrepresentable
  env: "stripped" | "session-mechanism";
  network: "none" | "registry-metadata" | "package-registry" | "session-mechanism";
  timeoutMs: number;
  output: { capture: "bounded-artifact"; publish: "redacted-summary" };
  outcome: "report-only" | "adopt-changes";
  allowedEffects: { worktreePaths: readonly string[] };  // closed glob set, worktree-relative
  occurrence: "stamp-gated" | "per-verification-cycle" | "once-per-task-attempt";
}
```

Reading the shape is reading the policy:

- **Every authorizable entry is a typed operation.** `operationId` is a
  #697 §4 registry identity; `params` are typed data validated by that
  operation's closed grammar, carried in #783 §4.1's `OperationParams`
  value type verbatim — scalar `string | number | boolean` values and
  flat arrays of them — so every parameter shape a validated
  `OperationRequest` can carry, a plan entry can plan. `params` is
  required, never omitted: a zero-parameter operation carries `{}`,
  the same required-`{}` form the request it authorizes carries, so
  §9's deep-equality match is total over valid entries and needs.
  There is no field in which free command text
  could be planned as an authorizable unit: approval applies to a typed
  operation contract, not to matching command text.
- **Every baseline evidence item is re-derivable from its own fields.**
  `locator` is a typed, source-discriminated descriptor of exactly where
  the evidence value comes from — the key path into the session block, the
  worktree-relative file and fragment selector at the base revision, the
  Issue number, field, and fixed parser, the chain id, the operation id —
  and `canonicalization` names the versioned routine that turns the
  retrieved value into the fingerprinted bytes (`"utf8-bytes@1"` for raw
  UTF-8 content, `"json-canonical@1"` for §6's canonical-JSON rules
  applied to the retrieved value; a closed set). Parser ids
  (`selector.parser`, the issue variant's `parser`) are closed, versioned
  identities of fixed extraction code under §5's trust rules. Revalidation
  (§8 rule 3, §9 rule 7) resolves exactly this descriptor and nothing
  else: nothing about retrieval is left to implementation choice, and §6
  covers both fields in the fingerprint, so approval freezes not only what
  the evidence bytes were but how to fetch and canonicalize them again.
- **The pinned operation contract fixes all seven policy axes per
  operation** — command (or in-process routine), cwd, environment, network,
  timeout, output, and side-effect policy — at snapshot time, and the
  fingerprint freezes them. A `pinned-command`'s bytes come only from an
  operator-owned session-config path or from a registry template
  parameterized by validated data; never from agent output, and from Issue
  or repository text only through §5's nomination-plus-approval discipline.
  The two byte sources pin differently, by policy (§6): a
  `"registry-template"` pin retains its rendered `command` literally —
  every byte is fixed template text or grammar-validated typed data, so no
  operator secret is representable in it — while a `"session-config"` pin
  stores `commandRef` (the §4 session-config locator) and `commandDigest`
  only, never the bytes: a session command field may legally embed a
  credential, and the digest freezes the exact bytes in the fingerprint
  without making them representable in the durable plan.
- **`"session-mechanism"` is a recording value, not a grant.** It is legal
  only on `"session-default"` entries and means "the shipped mechanism's
  own posture, unchanged" — the plan records what
  `docs/environment-prepare-contract.md` will run without restating or
  altering its policy. Every `"plan-approval"` entry MUST declare
  `env: "stripped"` and a network value other than `"session-mechanism"`,
  because those entries execute under #697 §7's enforcing boundary and the
  declared value is the boundary's instruction.
- **`tier` names the #697 execution tier a `"plan-approval"` entry runs
  at — the value a session allowlist entry would carry.** Its closed
  values are #697 §5's legal entry values, `"auto-grant"` and
  `"notify-and-proceed"`; `"human-gate"` is not one, because absence of
  authorization already means exactly that. The field is required on
  every `"plan-approval"` entry, validated at assembly against the
  operation's #697 §9 ceiling, frozen by the fingerprint, and carried
  into #697's execution machinery on authorization (§9's handoff). It is
  unrepresentable on `"session-default"` entries — the shipped mechanisms
  take no tier — and on unresolved entries.
- **`"package-registry"` is plan vocabulary, defined here**: full-artifact
  fetch restricted to the session-configured registry endpoints (the
  environment-preparation case, e.g. `npm ci`, `go mod download`). It is
  representable so plans can record and propose environment-family
  operations, but it is **not** a member of #697's registry policy triple:
  a `"plan-approval"` entry pinned to `"package-registry"` executes
  unattended only when the runner attests a containment capability that
  enforces it, and no such capability is defined before the chain's
  runtime-execution issues land — until then resolution refuses it
  `"containment-unavailable"` (§9), fail-closed. Admitting the value into
  #697's registry is an amendment to that document first.
- **`outcome` separates checks from changes.** `"report-only"` operations
  (environment, verification) never adopt anything into the branch: their
  deliverable is exit status and bounded output, their `allowedEffects` are
  tolerated scratch paths, and out-of-enumeration writes taint the run
  (§10). `"adopt-changes"` operations (the tool-request family, e.g.
  `dependency.sync`) adopt via #697 §7 step 4's patch-level machinery and
  MUST declare `occurrence: "once-per-task-attempt"` (#697 §6 rule 6
  inherited).
- **`UnresolvedPlanEntry` is a prediction of a human gate, not a pending
  authorization.** A proposed need that resolves to no registry operation
  is recorded with a redacted `displaySummary` only — no operation id, no
  pinned contract, nothing executable. Unresolved entries are never
  authorizable under any approval state, and the guarantee is structural,
  not a refusal branch: carrying neither `operationId` nor `params`, they
  participate in no §9 match, and the occurrences they predict never
  become needs at all — §9 admits only occurrences already resolved to a
  typed operation, so a proposal that resolves to nothing stops at the
  human gate upstream of preflight resolution. They are advisories for
  the operator surface (§12), not states the resolver can report: they
  exist so the operator sees, before implementation starts, which
  expected needs will still stop for a human.
- **The authorizable typed identity is unique within a plan.** §9 rule 3
  resolves a need against *exactly one* resolved entry with equal
  `operationId` and deep-equal `params`. Two resolved entries sharing
  that typed identity — however distinct their `entryId`s or origins —
  would make every occurrence of the need refuse `"not-in-plan"`: an
  approved entry rendered unreachable by its own duplicate. Assembly
  therefore merges same-identity contributions from different layers into
  a single entry, deterministically, before validation: when any
  contributor is a shipped mechanism recorded from session configuration,
  the merged entry is `"session-default"` — the operator already owns
  that execution session-wide, and the observational class is the
  stricter posture — otherwise the nominations collapse into one
  `"plan-approval"` entry whose `origin` is the earliest nominating layer
  in §5's table order (session, repository, issue, chain). Merging never
  widens policy: the pinned contract, tier, and effects are derived from
  the operation registry and operator-owned configuration as a function
  of the typed identity, so same-identity contributions pin identically
  by construction, and a plan in which they did not is a defect
  validation refuses below.

Plan validation is fail-closed at construction, in #697 §4's style: a
`scope` with an empty `issues` list or with more than one issue but no
`chainId` (either leaves §11's plan lineage undefined), a
`scope.chainId` without exactly one `baseline.evidence` item whose
locator is `{ source: "chain-registry", chainId: scope.chainId }` (§13's
membership evidence — a chain scope must stay re-derivable, so a later
membership change can always fail an assumption), a chain-scoped plan
whose `scope.issues` is not exactly the member set that evidence's
canonical bytes record at assembly (the frozen issue list is the
evidenced membership verbatim, never a hand-supplied list, so
re-deriving the evidence re-derives the scope), a `"plan-approval"`
resolved entry of a chain-scoped plan whose `assumptions` omit that
evidence's name (every authorization the chain scope widens must
revalidate membership per occurrence — §8 rule 3, §9 rule 7, §13), a
malformed or duplicate `entryId`, two resolved entries left sharing one
authorizable typed identity (the merge above is mandatory and must
converge), an unknown `operationId`, params refused
by the operation's grammar, an assumption name with no matching evidence,
a `baseline.evidence` name appearing more than once (each name is
required exactly once, so an assumption always binds to exactly one
evidence fingerprint — no map-based implementation can silently pick
one of two digests), an evidence `locator` whose variant disagrees with
its item's `source`, an unknown parser or `canonicalization` id or a
`canonicalization` illegal for its locator variant, a `commandDigest`
that does not hash the bytes its `commandRef` resolves to at assembly,
`"session-mechanism"` on a `"plan-approval"` entry, a `"plan-approval"`
entry without a `tier` or with a `tier` above the operation's #697 §9
ceiling, a `tier` on a `"session-default"` entry, an `"adopt-changes"`
entry without `"once-per-task-attempt"`, an empty `allowedEffects` on an
`"adopt-changes"` entry (a `"report-only"` entry may declare an empty set —
"expected to write nothing observable" is the strictest posture, and #697
§8 verifies it like any other), or an unknown closed-set value **throws at
assembly** — a bad plan is a defect, not an input.

## 5. Contribution layers and provenance

Four layers contribute to a plan, and the contract's central discipline —
inherited from #697 invariant 1 — is that **contribution layers nominate;
they never authorize**:

| Layer | May contribute | May never contribute |
| --- | --- | --- |
| Session configuration | Pinned commands (referenced by `commandRef` into operator-owned session-config paths — the bytes stay in session config, §4, §6), the shipped mechanisms recorded as `"session-default"` entries, the #697 registry and allowlist | — (it is operator-owned already) |
| Repository (base-revision content only) | Nomination of registry operations and typed params (e.g. a script or target name), baseline evidence | Command bytes that execute without plan approval |
| Issue (title, body, labels — untrusted text) | Nomination of registry operations and typed params, parsed as **data only** by fixed parsers; unresolved advisories | Command bytes that execute without plan approval; any authorization |
| Chain registry | Scope membership (§13), baseline evidence | Ordering, triggering, or scheduling of any issue |

Two rules make the table safe:

- **Repository and Issue content is read at the base revision, as data,
  by fixed code.** Repository evidence is content-addressed at the base
  revision the worktree will branch from — never the agent-writable
  worktree. Issue text is untrusted input under the
  `docs/chatops-command-grammar-contract.md` trust boundary; fixed parsers
  may extract typed values from it (a script name, a package name with an
  explicit version range — the `docs/tool-request-and-dependency-sync.md`
  §3.5 precedent), and those values may select a registry operation and
  fill its params, but nothing derived this way executes unattended until
  an operator has approved the snapshot that displays the resolved,
  exact pinned contract.
- **Approval is what converts a derived pin into an operator-set one.**
  `docs/environment-prepare-contract.md` §2.1's non-derivation rule — the
  runner executes only what the operator set — is preserved, not relaxed:
  for `"session-default"` entries the operator set the command in session
  configuration; for `"plan-approval"` entries the operator sets it by
  approving the displayed snapshot (§7). Derivation may propose; only an
  operator decision authorizes.

This is how Issue, repository, chain, and session defaults contribute
**without requiring routine edits to `sessions.json`**: the session holds
the durable, session-wide material once (registry, allowlist, shipped
mechanisms); everything issue-specific varies per plan and is authorized by
the per-plan approval, not by a config edit.

## 6. Snapshot, fingerprint, and immutability

- **Snapshots are immutable and append-only.** A plan row is never mutated
  after `snapshotPreflightPlan` writes it; every change is a new snapshot
  that supersedes the old one for the same plan lineage (§11). There is
  no stored draft state: assembly is a pure function over injected facts,
  and the first durable write is the snapshot.
- **Canonical serialization.** The fingerprint input is the plan document
  with `planFingerprint` absent, serialized as UTF-8 JSON with
  lexicographically sorted object keys, no insignificant whitespace,
  `entries` ordered by `entryId`, `baseline.evidence` ordered by `name`
  (a total order — names are unique, §4),
  and `scope.issues` ascending. `planFingerprint` is
  `"sha256:" + hex(SHA-256(canonical bytes))`.
- **The fingerprint covers everything approval means.** Scope, baseline
  evidence (names, sources, locators, canonicalization ids, and their
  content fingerprints), and every entry's operation id, params,
  authorization class, tier, pinned contract (rendered command bytes for
  `"registry-template"` pins, `commandRef` and `commandDigest` for
  `"session-config"` pins), assumptions, and origin are all inside
  the canonical form. A changed command, a changed policy value, a changed
  side-effect declaration, or a changed baseline assumption each yield a
  different fingerprint — which is the mechanism by which stale approval
  can never be silently reused (§8).
- **Baseline assumptions are content-addressed, never head-SHA-addressed.**
  Repository evidence names a specific fragment (e.g.
  `repo:package.json#scripts.test` — the `name` is display; the
  `locator`'s file and selector are normative, §4) and fingerprints its
  canonical bytes at the base revision. A base branch that advances while every named evidence
  fragment stays byte-identical keeps the plan current; any evidence change
  is a failed assumption at authorization time (§9). This is what makes
  chain-scope approval useful — merged predecessor PRs advance the base
  SHA constantly — while still guaranteeing that a changed repository
  revision *assumption* invalidates (§8, §13).
- **Re-derivation is deterministic by construction.** Re-deriving an
  evidence item means resolving its `locator` against its source,
  applying its named `canonicalization`, and comparing SHA-256 digests —
  a pure procedure over the descriptor, with no implementation-chosen
  retrieval, selection, or normalization step. Approval and every later
  revalidation resolve the same frozen descriptor (§4; both fields are
  inside the canonical form), so a plan can never be revalidated against
  different bytes than its approval displayed. A locator that no longer
  resolves — the file or key path gone, the issue field absent — or a
  parser or canonicalization id unknown to the running build fails the
  assumption fail-closed (§8 rule 3, §9 rule 7), never falls back to a
  best-effort read.
- **Recording never exposes secrets or local absolute paths.** The
  snapshot stores worktree-relative paths and the `"issue-worktree"` cwd
  token only; no absolute path is representable. Environment values are
  never stored — `env` is a closed token, and the stripped allowlist is
  #697 §7's, by name. Evidence locators are key paths, file names,
  selectors, and ids — sources of values, never values. And session-config
  command bytes are never copied into the plan row or the local
  `preflight-plan.json` artifact at all: a session command field may
  legally embed a credential, so a `"session-config"` pin stores only
  `commandRef` and `commandDigest` (§4), and the bytes stay where the
  operator put them. A secret in an operator command is thereby
  unrepresentable in durable plan artifacts by construction, not by
  scanning. The Review surface (§12) re-derives the bytes from
  `commandRef` for the approval display and verifies them against
  `commandDigest` first — exact command text is shown re-derived, local and
  operator-visible, never posted to a public surface, and never persisted
  by the display. `"registry-template"` pins retain their rendered
  `command` literally: every byte is fixed template text or
  grammar-validated typed data (§5), so no operator secret can reach
  them. Public text about a
  plan carries at most operation ids, entry counts, states, and a
  fingerprint prefix (first 12 hex characters) through the existing
  visibility pipeline; `UnresolvedPlanEntry.displaySummary` follows the
  `displayCommand` redaction rules of
  `docs/tool-request-and-dependency-sync.md` §2.4.

## 7. Approval — one decision, its exact reach, and what it never implies

```ts
interface PreflightApproval {
  planFingerprint: string;   // full digest; exact match only
  decision: "approved" | "declined";
  decidedBy: string;         // provider identity, or "local-operator"
  surface: "admin-cli";      // closed in this contract; ChatOps is deferred (§17)
  decidedAt: string;         // ISO-8601 UTC
  note?: string;             // operator free text, local-only
}
```

**One approval covers the whole plan.** Approving a snapshot authorizes
every `"plan-approval"` entry in it, for every occurrence within each
entry's occurrence budget, for every issue in the scope, for as long as
the plan stays current (§8) — that is the "approve the full plan once
instead of approving each occurrence" the design exists for. Declining
records the decision and changes no behavior: an undecided or declined
plan simply authorizes nothing beyond its `"session-default"` records.

What approval **is**: an operator statement that these typed operation
contracts — exactly the displayed ids, params, tiers, pinned commands,
policies, and effect enumerations, under exactly these baseline
assumptions — may
execute unattended for these issues, through #697's execution machinery.

What approval is **not** — each a required decision of this contract:

- **Not text matching.** Approval binds to the plan fingerprint over typed
  operation contracts. A future request whose command text happens to equal
  a pinned command but which resolves to no typed operation gains nothing;
  a request that resolves to a planned operation is authorized even if its
  free-text `command` field is adversarial garbage, because that field is
  never read (§9; #697 invariant 1).
- **Not trust in the code the operation will execute.** Preflight approval
  must not imply that future modified test code is trusted: a verification
  operation runs repository code the implementation agent has just edited,
  by design. The executed repository code remains untrusted at all times;
  what contains it is #697 §7's enforcing execution boundary, which is
  mandatory for every `"plan-approval"` execution — a runner that cannot
  attest the entry's containment capability refuses the occurrence
  (`"containment-unavailable"`, §9) rather than running it unconfined.
  Approval authorizes the *operation contract*; the *boundary* is what the
  agent-influenced bytes stay inside.
- **Not a standing session grant.** The reach is the plan's scope and
  fingerprint. A new issue outside the scope, or any invalidating change
  (§8), puts the operator back in the loop. Standing, session-wide
  relaxation remains #697 §5's allowlist, unchanged.
- **Not a schedule.** Nothing runs because it was approved; operations run
  when the runner's existing flow reaches them (§10), and issues run when
  the existing intake reaches them (§13).

## 8. Invalidation and renewal

No stale approval is ever silently reused. Approval applies only when all
of the following still hold at the moment a need is authorized (§9) —
and the store-owned facts among them (the active snapshot, its
fingerprint, its `approved` state) are re-checked transactionally at the
moment the occurrence is reserved (§10):

1. **Exact fingerprint match** — the approval's `planFingerprint` equals
   the active snapshot's. Any re-snapshot supersedes, and approval never
   carries forward: a superseding snapshot starts undecided, however small
   the change.
2. **Pin currency** — re-deriving the entry's pinned contract from its
   sources (the `commandRef` key path for a session-config pin — whose
   resolved bytes must hash to the stored `commandDigest` — the registry
   template and the entry's params for a rendered command, the operation
   registry) yields byte-identical results. A session-config edit, a
   registry change, or a template change after approval makes the entry
   stale (`"plan-stale"`), even though the stored snapshot is immutable.
3. **Assumption currency** — every named baseline evidence, re-derived by
   resolving its `locator` and applying its `canonicalization` (§4, §6),
   fingerprint-matches (`"assumption-failed"` otherwise); a locator that
   no longer resolves, or a parser or canonicalization id unknown to the
   running build, is the same refusal. This is where a
   changed repository revision assumption lands: the evidence fragment
   changed at the base, so the plan's premise is gone.

A failed check refuses the single occurrence fail-closed and emits the
refusal in the audit trail; it never blocks the shipped fallback flow
(§9). **Renewal is always a new snapshot plus a new approval** — there is
no partial re-approval, no amendment of an approved snapshot, and no
approval that survives its fingerprint. The operator surface makes renewal
cheap by diffing the superseding snapshot against the superseded one
(§12), but cheapness is a UI property; the authorization property is
absolute.

Revocation (`revokePlanApproval`, §11) withdraws an existing approval at
any time; occurrences already executed are history (their audit records
stand), and nothing further authorizes. Enforcement is the lifecycle
state, not the approval record: the transition moves the plan to
`revoked` while the `PreflightApproval` record stands as append-only
history, and §9 rule 5 reads the state — so from the first consult
after the transition commits, every remaining occurrence of every entry
refuses `"plan-unapproved"`. The consult is not the last check:
`resolvePreflightAuthorization` is pure over facts that may predate the
transition, so the pre-launch reservation take re-verifies the active
fingerprint and `approved` state inside its own transaction (§10, §11)
— the take, not the consult, is the commit point a revocation races
against. A transition that commits first makes the guarded take refuse
without reserving; an occurrence whose reservation already committed is
in flight and, like executed history, is not recalled. A surviving
`decision: "approved"` record
for the same fingerprint is never sufficient on its own.

## 9. Authorization resolution

Authorization is a **pure core policy function** in the
`resolveGrantTier` mold (#697 §6): the handler injects facts; the resolver
reads no host state and no agent text.

```
resolvePreflightAuthorization(need, plan, approval, facts) →
  | { authorized: true;  entryId: string; via: "session-default" }
  | { authorized: true;  entryId: string; via: "plan-approval";
      tier: "auto-grant" | "notify-and-proceed";
      effectiveEffects: readonly string[] }
  | { authorized: false; reason: PreflightRefusalReason }
```

with `PreflightRefusalReason` =
`"preflight-disabled"` | `"no-plan"` | `"not-in-plan"` |
`"plan-unapproved"` | `"plan-stale"` |
`"assumption-failed"` | `"containment-unavailable"` |
`"occurrence-exhausted"` — a closed set, recorded in the audit trail,
never published beyond it.

A **need** is
`{ sessionId, repo, issueNumber, taskAttempt, source, operationId, params }`,
where `sessionId` and `repo` are the executing task's canonical session id
and repository identity (`provider`, `owner`, `name`) — runner-injected
facts, never derived from agent text — and `source` is
`"runner-mechanism"` (a planned step the runner reaches
itself) or `"tool-request"` (an emitted request that #697 §6 rule 2's
nomination — the `suggestedAction` hint or the parser probe — has resolved
to a typed operation and typed data). `params` is required and carries
#783 §4.1's `OperationParams` value type — for a `"tool-request"` need,
the validated request's `params` verbatim; `{}` when the operation takes
none. The request's free-text `command`
and `reason` fields are **never read** by preflight resolution; the only
reader of `command` anywhere remains a #697 §4 `input.parser`.

Rules, in order, all fail-closed:

1. Session `preflight` block absent or disabled → `"preflight-disabled"`.
2. No active snapshot whose scope matches the need in full — equal
   `scope.sessionId`, `scope.repo` equal on `provider`, `owner`, and
   `name`, and the need's issue in `scope.issues` → `"no-plan"`. Scope
   identity is exact on all three axes, never issue number alone: a
   snapshot for another session or repository that happens to list the
   same issue number covers nothing here, however the snapshot was
   supplied to the resolver. §11's lineage-keyed supersession with
   cover-bounded overlap retirement (a partial cross-lineage overlap
   refuses at the snapshot port and never commits) keeps at most one
   active snapshot covering any issue, so the matching snapshot is
   unique when it exists.
3. Entry matching: exactly one entry with equal `operationId` and
   deep-equal `params` → else `"not-in-plan"`. Both sides carry `params`
   by construction (§4), so a zero-parameter operation matches on `{}`
   and array values compare element-wise in order. Matching is typed-identity
   equality only; no text, no globbing, no similarity. Unresolved entries
   carry neither field and participate in no match: a need can never
   address one (§4). Assembly's typed-identity uniqueness (§4) makes the
   multiple-match branch unrepresentable in a valid snapshot; the refusal
   decides the zero-match case.
4. A matched `"session-default"` entry → authorized, `via:
   "session-default"`. This is observational passthrough: the occurrence
   executes through the shipped mechanism exactly as if no plan existed,
   and the resolution is recorded for provenance.
5. A matched `"plan-approval"` entry requires the active snapshot to
   stand in lifecycle state `approved` (§11) at this consult → else
   `"plan-unapproved"`. The state, not the `PreflightApproval` record,
   is what the rule reads — the injected plan carries its current
   state, so the pure function needs no store read. A `decision:
   "approved"` record for the snapshot's exact fingerprint necessarily
   exists in that state, but the record alone proves nothing:
   `revokePlanApproval` withdraws authorization by moving the state to
   `revoked` while the record stands as history (§8), so `snapshotted`,
   `declined`, and `revoked` snapshots all refuse here, whatever
   records accompany them.
6. Pin currency (§8 rule 2) → else `"plan-stale"`.
7. Assumption currency (§8 rule 3) → else `"assumption-failed"`.
8. The runner must attest the enforcing containment capability the entry's
   pinned policy demands (#697 §6 rule 4, §7) → else
   `"containment-unavailable"`. This is where `"package-registry"` pins
   refuse until the runtime issues land the capability (§4).
9. The entry's occurrence budget must not be exhausted for this task
   attempt or cycle → else `"occurrence-exhausted"`. The budget is
   enforced by §10's pre-launch reservation: the resolver reads injected
   reservation state — an unsettled reservation counts as consumed — and
   a passing verdict is provisional on the handler's guarded reservation
   take: a lost race on the occurrence key is this same refusal, decided
   at the §11 port, while the take's authority guard (§10) refuses a
   plan revoked or superseded since this consult — re-entering
   resolution, not parking. The pure function observes; the reservation
   excludes.
10. Otherwise authorized, `via: "plan-approval"`, carrying the entry's
    `tier` and its pinned `allowedEffects.worktreePaths` as
    `effectiveEffects` — #697 §6 rule 7's success shape, produced from
    the plan instead of the session allowlist.

**The plan-approval handoff.** A `via: "plan-approval"` verdict is
consumed exactly where `resolveGrantTier`'s relaxed verdict is consumed,
and `resolveGrantTier` is not additionally called for the occurrence — it
is the fallthrough authority, reached only on refusal. The handler hands
`{ operationId, tier, effectiveEffects }` to #697 §7's execution
machinery in the allowlist verdict's place; everything downstream of
#697 §6 — the enforcing boundary, effect verification, patch-level
adoption, the §9 ceilings, `notify-and-proceed`'s §10 notification, the
§11 audit record — consumes the plan verdict identically. The checks
#697 §6 performs are not skipped; each has exactly one preflight
equivalent: candidate nomination is the need's typed identity (above);
the allowlist test is entry matching plus plan approval (rules 3 and 5);
an `input.parser` refusal cannot survive assembly, where the operation's
grammar validated `params` (§4); the tier ceiling is validated at
assembly and its registry premise is pin-checked at rule 6; containment
attestation is rule 8; `trigger.precondition` facts MUST be
content-addressed as named baseline evidence at assembly, so a
precondition that stops holding fails rule 7 (`"assumption-failed"`);
and repeat protection is rule 9, backed by §10's pre-launch occurrence
reservation. The two authorization sources are independently switched:
`toolRequestTiers.enabled` gates only the session allowlist,
`preflight.enabled` plus the plan's approval gates only the plan;
neither switch reads the other.

**The runner, not the implementation agent, decides.** The agent can at
most nominate — emit a request whose typed resolution names a planned
operation. The verdict is computed runner-side from stored state and
injected facts; there is no agent-writable input that flips it.

**Precedence and fallthrough.** At the gate decision point the handler
consults preflight authorization **first** — the plan is the most specific
authority (this operator, this issue, these bytes) — then, only on a
preflight refusal, #697 tier resolution, then the pre-#697 disposition
flow with its migration exception, then the guided human gate. Seven of
the eight refusals fall through to that chain unchanged: **a preflight
refusal subtracts nothing** — a request refused by the plan is exactly
as gated, and exactly
as served, as it was before this contract existed, and for these
refusals `resolvePreflightAuthorization` never yields a park of its own;
parking remains the downstream flow's verdict.

**The `"occurrence-exhausted"` carve-out.** Rule 9's refusal is the one
exception, the plan-side mirror of #697 §6 rule 6's
`"already-executed"`, which likewise sits outside that contract's
migration exception. An exhausted budget presupposes that this entry
already executed — or holds an ambiguous reservation (§10) — within the
protected window, so handing the repeat onward could run the operation a
second time: for an operation the session never allowlisted,
`resolveGrantTier` answers `"not-allowlisted"`, and the migration
exception then serves the repeat through the pre-#697 dependency route,
whose `runDependencyUpdate` would execute a second pinned sync. An
`"occurrence-exhausted"` refusal therefore parks as a **direct human
handoff**: `resolveGrantTier` is not consulted and the legacy route is
never reached for the occurrence — repeat protection outranks
fallthrough, exactly as #697 invariant 8 ranks it for
`"already-executed"`. For an operation the session *does* also
allowlist, the direct park changes no outcome, only skips a redundant
consult: the plan execution rides #697 §7 and writes the §11 audit
record that rule 6 reads, so fallthrough would rediscover the same park
as `"already-executed"`. A confused agent re-emitting a consumed request
converges on a human instead of a second execution — the at-most-once
guarantee outranks the fallback, by design.

## 10. Execution semantics by family

Execution mechanics are #697 §7's, and their runtime wiring is deferred to
the chain's later issues; this section fixes only the per-family semantics
the plan's fields promise.

| Family | `outcome` | `occurrence` | Effects posture |
| --- | --- | --- | --- |
| `environment` | `report-only` | `stamp-gated` — reuses `docs/environment-prepare-contract.md` §2.4's stamp semantics; a current stamp skips the run | Materialised dependencies are scratch inside `allowedEffects`; nothing is adopted |
| `verification` | `report-only` | `per-verification-cycle` — once per cycle of the shipped bounded repair loop, within its existing cap | Scratch paths tolerated inside `allowedEffects`; nothing is adopted; the deliverable is exit status plus bounded output fed to the fix loop |
| `tool-request` | `adopt-changes` | `once-per-task-attempt` (#697 §6 rule 6 inherited; a repeat refuses `"occurrence-exhausted"` and parks as §9's direct human handoff — the `"already-executed"` carve-out inherited, never the legacy route) | #697 §7 step 4 patch-level adoption and §8 effect verification, unchanged |

- **Report-only runs adopt nothing, ever.** Their observed effects are
  checked against `allowedEffects` like any relaxed-tier run; an
  out-of-enumeration write **taints the run**: the result is still
  recorded and surfaced to the operator, but it does not count as passed
  verification, unattended continuation stops at the human gate, and the
  residue is left for the guided flow's dispositions — fail-closed, the
  same posture as #697 §8 excess. This check binds `"plan-approval"`
  executions under the boundary; recorded `"session-default"` runs are the
  shipped mechanisms and are not retroactively gated (§3).
- **Adopt-changes runs are #697 relaxed-tier runs.** Snapshot baseline,
  enforcing sandbox, effect verification, patch-level adoption, overlap
  isolation, entanglement parking: all of it applies verbatim, with the
  plan approval standing in the allowlist entry's place — the entry's
  `tier` and pinned effects entering as §9's handoff verdict — and the
  entry's pinned contract standing in the registry pin's place. Tier
  ceilings are respected, not bypassed: a network-reaching operation
  keeps its notify-posture obligations, and the §10 notification of #697
  rides the
  same outbox pipeline — plan approval moves the operator decision earlier;
  it does not remove the post-hoc visibility of network-reaching runs.
- **Occurrence capacity is reserved before launch, then settled.**
  Authorization never merely *observes* the absence of consumption — it
  *takes* the occurrence. On a would-be-authorized `"plan-approval"`
  verdict the handler calls `reservePlanOccurrence` (§11), which
  transactionally inserts a reservation under a unique occurrence key and
  commits **before the operation launches**; the key's uniqueness is the
  mutual exclusion, so of two attempts that both resolved cleanly exactly
  one take commits, and the loser is refused `"occurrence-exhausted"` at
  the port and parks per §9's carve-out. The occurrence key is the
  executing task's scope joined to the entry's typed identity joined to
  its occurrence window —
  `(sessionId, repo, issueNumber, operationId, params digest,
  occurrenceKey)`, where the leading scope triple is the need's
  runner-injected task identity (§9) and `occurrenceKey`
  is the task-attempt identity for `"once-per-task-attempt"`, the
  verification-cycle identity for `"per-verification-cycle"`, and the
  stamp identity for `"stamp-gated"` — deliberately **not** the plan
  fingerprint or `entryId`: a superseding snapshot re-fingerprints and
  renumbers entries, and it must never refresh a spent window — a
  changed plan cannot relaunch a consumed operation. The scope triple
  is load-bearing for chains: attempt and cycle counters advance per
  task, not per plan, so without it two member issues of a chain-scoped
  plan running the same operation with identical params in their own
  first cycles would contend for one key, and the loser would park
  `"occurrence-exhausted"` for a human — with it they are disjoint
  occurrences by construction, the one-approval-many-issues reach §7
  and §13 promise, while within one issue the same window under a
  superseding snapshot still maps to the spent key. The reservation row
  records the fingerprint and `entryId` it was taken under — excluded
  from the key by design, while the fingerprint doubles as the comparand
  the take's authority guard re-checks (below). After the run, the
  reservation is settled with the
  run reference and outcome in the run's own audit transaction
  (`preflight_entry_consumed`); a settled reservation occupies its
  window regardless of outcome — after a failed adopt-changes run the
  external state is suspect, so the next window (the next task attempt
  or cycle), not a same-window retry, is the retry path.
- **The take is guarded, not just unique.**
  `resolvePreflightAuthorization` is pure over facts injected at the
  consult (§9), so `revokePlanApproval` or a superseding
  `snapshotPreflightPlan` can commit between a clean consult and the
  reservation take — and the take must not launch a dead verdict. Inside
  the reservation transaction the port therefore re-reads the scope's
  active snapshot and inserts only if it still carries the fingerprint
  the verdict was resolved against, in lifecycle state `approved`;
  otherwise it refuses without inserting (§11's `"plan-authority-lost"`
  port result). Fingerprint equality is evidence equality: the
  fingerprint covers every pinned contract and named baseline evidence
  fingerprint (§6), so a committed take launches exactly the bytes a
  standing approval names, and the take — not the consult — is the
  commit point a revocation or supersession races against (§8). A lost
  guard is not `"occurrence-exhausted"`: nothing ran and no window was
  consumed, so there is no double-execution risk and no direct human
  handoff — the handler re-enters §9 resolution against the now-current
  state, that consult emits its own `preflight_authorization_resolved`
  event and its refusal falls through the ordinary chain, or it
  authorizes again under an already-approved superseding snapshot,
  whose take then names the current fingerprint while the
  fingerprint-independent occurrence key keeps a spent window spent.
- **An unsettled reservation is ambiguous and counts as consumed.** A
  crash between the reservation's commit and its settlement leaves a
  reservation with no run record, and whether the external operation ran
  is unknowable from the store. Recovery is fail-closed: the reservation
  keeps occupying its window, a same-window retry refuses
  `"occurrence-exhausted"` and parks for a human (§9), and the dangling
  reservation is surfaced on the §12 status surface. There is no
  automatic release and no operator release port: for an adopt-changes
  operation the ambiguity *is* the double-execution risk the reservation
  exists to close, and a fresh task attempt or verification cycle opens
  fresh capacity by key construction — exactly the per-window semantics
  #697 §6 rule 6 gives the shipped machinery.

## 11. Lifecycle, state ownership, mutation ports, and events

Ownership follows the `docs/DOMAIN.md` §2.1 razor exactly as #697 §13 cut
it:

- **State — Orchestration.** Plan snapshots, approval records, and
  consumption rows live in the store, written only by the ports below;
  append-only revisions, CAS on state transitions.
- **Policy — Orchestration core.** `assemblePreflightPlan` (pure over
  injected facts), canonical serialization and fingerprinting, plan
  validation, and `resolvePreflightAuthorization` are pure functions in
  `core/`, the `core/tool-request-changes.ts` family.
- **Mechanics — Execution.** Fact collection (session config, base-revision
  evidence, chain membership, containment attestation), snapshot timing,
  gate-decision-point consultation, and the executions themselves stay in
  the handlers and runner, behind the same worktree and lock machinery as
  every phase concern.
- **Operator surfaces — Operation.** The review/approve/decline/revoke and
  status surfaces are Operation entry points over the ports (§12).

**Plan lifecycle.** States:
`"snapshotted" | "approved" | "declined" | "revoked" | "superseded"`.

| # | From | To | Trigger |
| --- | --- | --- | --- |
| 1 | — | `snapshotted` | `snapshotPreflightPlan` (assembly output; supersedes the prior active snapshot for the plan lineage and retires every other active snapshot whose scope the new one fully covers, in the same transaction; a partial cross-lineage overlap refuses the insert instead — the cover-bounded retirement rule below) |
| 2 | `snapshotted` | `approved` | `recordPlanDecision(approved)` |
| 3 | `snapshotted` | `declined` | `recordPlanDecision(declined)` |
| 4 | `approved` | `revoked` | `revokePlanApproval` |
| 5 | `snapshotted` \| `approved` \| `declined` \| `revoked` | `superseded` | a new snapshot for the same plan lineage, or a new snapshot whose scope fully covers this plan's (the cover-bounded retirement rule below) |

The table is closed: there is no edge back into `approved` — renewal is a
new snapshot (§8). Staleness is deliberately **not** a stored state: it is
computed per occurrence at resolution (§9 rules 6–7), so a stale-then-fixed
base never needs a state repair.

**Supersession is lineage-keyed, not scope-keyed.** The supersede
identity is the plan lineage (§2): `(sessionId, repo, issueNumber)` for a
single-issue plan, `(sessionId, repo, chainId)` for a chain-segment plan.
Scope membership is deliberately not part of the key: `scope.issues` is
part of a chain plan's scope, so a chain edit produces a snapshot with a
*different* scope — were supersession scope-keyed, the edited chain's new
snapshot would leave the old plan active, two approved plans would cover
the overlapping members, and a membership that later returned to its old
value would re-expose the old approval without the renewal §8 requires.
Keyed on `chainId`, the membership edit is an ordinary renewal inside one
lineage. In addition, cross-lineage retirement is **cover-bounded**:
`snapshotPreflightPlan` retires every other active snapshot — outside
the new snapshot's own lineage — **whose scope's issues the new
snapshot's scope fully contains**, in the same transaction, moving each
to `superseded` and emitting `preflight_plan_superseded` per retired
plan. A new snapshot whose scope **partially** overlaps another active
snapshot outside its lineage — shares at least one issue while that
plan covers at least one issue outside the new scope — **refuses the
insert** with the typed port result `"scope-conflict"`, naming the
conflicting plan and writing nothing (a port outcome like the
reservation guard's `"plan-authority-lost"`, not a ninth
`PreflightRefusalReason`). Both alternatives are forbidden by what
approval means: retiring the conflicting plan whole would withdraw its
other members' authority though none of their entries or assumptions
changed, and shrinking its scope in place would leave a plan its
approved fingerprint no longer describes (§6, §8). Retirement therefore
never reaches past the new snapshot's own scope: **a snapshot never
withdraws authority from an issue it does not cover**; only a lineage's
own renewal — the operator-visible, evidence-backed scope change — can
drop an issue from coverage (§13). The conflict resolves by renewing
the *conflicting* plan through its own lineage first. The standing case
is an issue that left a chain: the chain plan's `chain:membership`
assumption is already failing (§8), its renewal from the current
registry drops the departed issue, and the retried single-issue insert
no longer overlaps. The runner performs exactly that sequence
unattended on `"scope-conflict"` — renew the named plan, then retry —
and it converges because assembly scopes an issue from the same current
registry membership that renewal reads (§13): a conflict renewal cannot
clear is a registry placing one issue in two scopes at once, which
stays refused, fail-closed, for the operator. Neither snapshot inherits
any approval (§8), so the refusal costs no authority renewal was not
already due to re-earn. The two rules together yield the store
invariant: **at most one active plan covers any
`(sessionId, repo, issueNumber)`** — covered overlaps retire, partial
overlaps never commit. §9 rule 2's matching
snapshot and `getActivePlan`'s result are therefore unique when they
exist, an issue moving between a single-issue plan and a chain plan — or
between two chains — never leaves two live approvals behind, and a
superseded plan's approval never authorizes again, whatever the
membership history: renewal is a new snapshot plus a new approval (§8).

**Mutation ports** (Orchestration-owned, transactional, event-emitting):

- `snapshotPreflightPlan(plan)` — validates (§4), inserts the immutable
  revision, and in the same transaction supersedes the prior active
  snapshot for the plan lineage and retires every other active snapshot
  whose scope the new one fully covers (the
  at-most-one-active-plan-per-issue invariant above); a partial
  cross-lineage overlap returns the typed `"scope-conflict"` result
  naming the conflicting plan and inserts nothing (the cover-bounded
  retirement rule above).
- `recordPlanDecision(planFingerprint, decision, evidence)` — CAS from
  `snapshotted`; writes the `PreflightApproval` record.
- `revokePlanApproval(planFingerprint, evidence)` — CAS from `approved`.
- `reservePlanOccurrence(taskScope, planFingerprint, entryId, occurrenceKey)`
  — pre-launch occurrence accounting: a guarded transactional
  test-and-set on the unique occurrence key (§10) — `taskScope` is the
  need's `(sessionId, repo, issueNumber)` triple, the key's scope
  components — committed before the operation launches. The same
  transaction re-reads the scope's active snapshot and inserts only if
  it still carries `planFingerprint` in lifecycle state `approved`
  (§10's authority guard); `planFingerprint` is thus a guard comparand,
  not provenance alone. A losing take on the occurrence key returns the
  typed `"occurrence-exhausted"` refusal instead of inserting; a failed
  guard returns the port-level `"plan-authority-lost"` result instead of
  inserting — a port outcome, not a ninth `PreflightRefusalReason`: the
  handler re-enters §9 resolution and that consult's verdict is the
  recorded outcome (§10).
- `settlePlanOccurrence(taskScope, planFingerprint, entryId, occurrenceKey, runRef)`
  — settles the reservation with the run reference and outcome, in the
  executing run's own audit transaction (§10); settling a reservation
  that does not exist, or twice, is a defect, not a race.
- Reads: `getActivePlan(taskScope)` — the at-most-one active snapshot
  whose scope covers the `(sessionId, repo, issueNumber)` triple, unique
  by the invariant above, together with its current lifecycle state, §9
  rule 5's authority — and `getApproval(planFingerprint)`.

**Events** (task-event naming precedent, a closed set):
`preflight_plan_snapshotted`, `preflight_plan_superseded`,
`preflight_plan_approved`, `preflight_plan_declined`,
`preflight_plan_revoked`, `preflight_authorization_resolved` (every
consult: the need's operation id, the verdict, the `entryId` or refusal
reason), `preflight_entry_reserved`, and `preflight_entry_consumed`
(settlement). Execution-side events remain
#697 §11's, unchanged and unrenamed.

**Session configuration**:

```json
{
  "preflight": {
    "enabled": true
  }
}
```

`enabled` defaults to **off**. Absent block or `enabled: false` means no
plan is assembled, no snapshot is written, and every behavior in the loop
is byte-for-byte pre-#915 — the zero-configuration behavior is today's
behavior. Whether an additional strict mode should gate write-capable
implementation on an approved plan is an open question (§17), not a field.

**Plan production timing.** When enabled, the runner assembles and
snapshots the plan for an issue after intake resolves it and **before the
first write-capable implementation phase run** for that issue (re-using an
active, current snapshot when one already covers the issue — the chain
case, §13). Implementation never waits for approval: an undecided plan
authorizes nothing beyond its `"session-default"` records, and everything
else falls through per §9.

## 12. Operator surfaces and visible outcomes

The operator-visible surface is an Operation-context slice over the §11
ports, in the guided flow's local-display tradition
(`docs/guided-tool-request-flow.md` §3.5: exact text on the operator's
terminal, redacted text everywhere public):

- **Review** shows the active snapshot grouped by authorization class:
  `"session-default"` records (will run anyway; shown for completeness and
  drift visibility), `"plan-approval"` requests (the decision's actual
  reach: the exact pinned command — a session-config pin's bytes
  re-derived live from `commandRef` and verified against `commandDigest`
  before display, a mismatch showing as stale pending renewal, never as
  approvable (§6, §8) — tier, policy axes, effect enumeration,
  occurrence budget, assumptions with their evidence names), and `"unresolved"`
  advisories (will human-gate). It shows the plan fingerprint and, for a
  superseding snapshot, the diff against the superseded one (§8).
- **Decide** applies `approve` / `decline` to the displayed fingerprint —
  never to "the latest plan" implicitly: the decision names the digest it
  covers, so a re-snapshot between display and decision cannot be approved
  blind.
- **Revoke** withdraws an approval; it wins against every occurrence
  whose reservation has not yet committed (§8, §10), while an already
  reserved occurrence is in flight and not recalled.
- **Status** lists the active plan's state, per-entry consumption counts,
  any unsettled reservations (§10's ambiguous-crash residue, shown with
  the window they occupy), and the refusal reasons of recent
  `preflight_authorization_resolved` events, so "why did this stop for a
  human anyway" is answerable from the operator surface alone.

Command grammar, registration, and output shape follow the admin-CLI
contracts (`docs/admin-cli-contract.md`, `docs/admin-command-registry-contract.md`)
and are implementation-issue material; ChatOps exposure is deferred (§17)
and this contract adds no ChatOps verb and does not modify #784's table.

Public comments about a plan — if a slice chooses to post any — carry only
the bounded, redacted summary of §6; approval evidence and pinned commands
never leave the local surfaces.

## 13. Chains: preparing future issues without a scheduler

A plan whose scope is a chain segment lists the member issues explicitly
(`scope.issues`, with `scope.chainId` naming the registry chain) as read
from the chain registry at snapshot time, with the membership recorded as
baseline evidence (`chain:membership`) — a mandatory pairing §4
validates: the evidence item must carry the scope's `chainId` locator,
`scope.issues` must equal the membership it fingerprints, and every
`"plan-approval"` entry must name it as an assumption, so no
chain-scoped snapshot exists whose membership premise cannot be
re-derived and failed. That is the entire chain feature:

- **One approval, many issues.** The operator approves the verification
  and environment operations for the whole segment once; each member
  issue's occurrences authorize against the same snapshot.
- **Per-occurrence revalidation does the safety work.** Every occurrence
  re-checks pin currency and assumption currency (§9). Content-addressed
  baseline evidence (§6) makes this practical: a predecessor PR merging
  advances the base SHA but leaves `repo:...` evidence byte-identical, so
  approval keeps carrying; a change to a named evidence fragment — the
  verification script, the manifest fragment, the chain membership —
  refuses fail-closed and asks the operator to renew.
- **No new chain scheduler is introduced.** The plan never orders,
  triggers, blocks, or re-queues issues; intake, dependency gating, and
  the existing loop remain the only machinery that decides what runs when.
  The chain registry is a read-only membership source here, exactly as the
  snapshot ports of the refinement track read it. A chain edit after
  snapshot is not an error — it is a failed `chain:membership` assumption
  at the next occurrence, which is renewal, not repair. The renewal
  snapshot supersedes the edited chain's prior plan through the shared
  `chainId` lineage (§11), however the membership changed: members that
  left the segment are covered by no plan and refuse `"no-plan"`
  fail-closed until planned again — and planning one anew waits on that
  renewal: while the stale chain plan still lists the departed issue, a
  single-issue snapshot for it refuses `"scope-conflict"` rather than
  retiring a chain plan whose remaining members are unaffected, and the
  runner renews the chain plan through its lineage first (§11) — and a
  membership that later returns
  to an old value meets a superseded plan, never a resurrected approval.

## 14. Example — a Node.js repository

Session config (already present, unchanged): `environmentPrepare` with
`npm ci`, `verification` with `test` / `typecheck`, `dependencySync` in
§3.2a safe mode, `toolRequestTiers` listing `dependency.sync` at
`notify-and-proceed`, and `preflight.enabled: true`. Issue #1234's body
announces an integration-test script and a known dependency addition.

```jsonc
{
  "schemaVersion": 1,
  "scope": {
    "sessionId": "main-loop",
    "repo": { "provider": "github", "owner": "acme", "name": "widget" },
    "issues": [1234]
  },
  "baseline": {
    "baseBranch": "main",
    "evidence": [
      { "name": "session:environmentPrepare", "source": "session-config",
        "locator": { "source": "session-config", "keyPath": ["environmentPrepare"] },
        "canonicalization": "json-canonical@1", "fingerprint": "sha256:9f1c…" },
      { "name": "session:verification", "source": "session-config",
        "locator": { "source": "session-config", "keyPath": ["verification"] },
        "canonicalization": "json-canonical@1", "fingerprint": "sha256:e07a…" },
      { "name": "repo:package.json#scripts.test:integration", "source": "repository-base",
        "locator": { "source": "repository-base", "file": "package.json",
                     "selector": { "parser": "json-member@1", "fragment": "scripts.test:integration" } },
        "canonicalization": "json-canonical@1", "fingerprint": "sha256:41d2…" },
      { "name": "issue:1234#dependency-note", "source": "issue",
        "locator": { "source": "issue", "issueNumber": 1234, "field": "body", "parser": "dependency-note@1" },
        "canonicalization": "json-canonical@1", "fingerprint": "sha256:77b0…" },
      { "name": "registry:verify.npm-script", "source": "operation-registry",
        "locator": { "source": "operation-registry", "operationId": "verify.npm-script" },
        "canonicalization": "json-canonical@1", "fingerprint": "sha256:c3ba…" }
    ]
  },
  "entries": [
    {
      "entryId": "environment.prepare#1",
      "operationId": "environment.prepare",
      "family": "environment",
      "params": {},
      "authorization": "session-default",
      "origin": "session",
      "pinned": {
        "execution": { "kind": "pinned-command", "source": "session-config",
                       "commandRef": { "source": "session-config", "keyPath": ["environmentPrepare", "command"] },
                       "commandDigest": "sha256:2b90…" },
        "cwd": "issue-worktree", "env": "session-mechanism", "network": "session-mechanism",
        "timeoutMs": 120000,
        "output": { "capture": "bounded-artifact", "publish": "redacted-summary" },
        "outcome": "report-only",
        "allowedEffects": { "worktreePaths": ["node_modules/**"] },
        "occurrence": "stamp-gated"
      },
      "assumptions": ["session:environmentPrepare"]
    },
    {
      "entryId": "verify.named#1",
      "operationId": "verify.named",
      "family": "verification",
      "params": { "name": "test" },
      "authorization": "session-default",
      "origin": "session",
      "pinned": {
        "execution": { "kind": "pinned-command", "source": "session-config",
                       "commandRef": { "source": "session-config", "keyPath": ["verification", "test"] },
                       "commandDigest": "sha256:8c1d…" },
        "cwd": "issue-worktree", "env": "session-mechanism", "network": "session-mechanism",
        "timeoutMs": 600000,
        "output": { "capture": "bounded-artifact", "publish": "redacted-summary" },
        "outcome": "report-only",
        "allowedEffects": { "worktreePaths": [] },
        "occurrence": "per-verification-cycle"
      },
      "assumptions": ["session:verification"]
    },
    {
      "entryId": "verify.npm-script#1",
      "operationId": "verify.npm-script",
      "family": "verification",
      "params": { "script": "test:integration" },
      "authorization": "plan-approval",
      "tier": "auto-grant",
      "origin": "issue",
      "pinned": {
        "execution": { "kind": "pinned-command", "source": "registry-template", "command": "npm run test:integration" },
        "cwd": "issue-worktree", "env": "stripped", "network": "none",
        "timeoutMs": 600000,
        "output": { "capture": "bounded-artifact", "publish": "redacted-summary" },
        "outcome": "report-only",
        "allowedEffects": { "worktreePaths": ["coverage/**"] },
        "occurrence": "per-verification-cycle"
      },
      "assumptions": ["repo:package.json#scripts.test:integration", "registry:verify.npm-script"]
    },
    {
      "entryId": "dependency.sync#1",
      "operationId": "dependency.sync",
      "family": "tool-request",
      "params": { "package": "left-pad", "range": "^1.3.0" },
      "authorization": "plan-approval",
      "tier": "notify-and-proceed",
      "origin": "issue",
      "pinned": {
        "execution": { "kind": "in-process", "routine": "dependency-sync-manifest-edit" },
        "cwd": "issue-worktree", "env": "stripped", "network": "registry-metadata",
        "timeoutMs": 120000,
        "output": { "capture": "bounded-artifact", "publish": "redacted-summary" },
        "outcome": "adopt-changes",
        "allowedEffects": { "worktreePaths": ["package.json", "package-lock.json"] },
        "occurrence": "once-per-task-attempt"
      },
      "assumptions": ["issue:1234#dependency-note"]
    },
    {
      "entryId": "unresolved#1",
      "authorization": "unresolved",
      "origin": "issue",
      "proposal": { "displaySummary": "issue asks for a local service via docker compose; no typed operation covers it" }
    }
  ],
  "assembledBy": "runner",
  "planFingerprint": "sha256:5b21…"
}
```

Reading the example: the first two entries will run whether or not anyone
approves — they are the shipped mechanisms, recorded. The `npm ci` and
`npm test` they will run appear nowhere in the snapshot: their
session-config pins carry `commandRef` and `commandDigest` only (§6), and
the review surface re-derives the bytes for local display. Approving the plan
authorizes exactly two things: the issue-specific integration-test run
(report-only, no network, boundary-contained, at `auto-grant` under its
network-none ceiling) and the announced dependency addition (at
`notify-and-proceed`, so #697 §10's post-hoc notification still rides; it
would otherwise ride the session allowlist if present, and here is
additionally pinned to the Issue's own package and range — a request for
any *other* package deep-equals no entry and falls through).
The docker-compose need is visible up front as the one human gate this
issue is still expected to hit. `verify.npm-script#1` is authorized per
verification cycle even though the agent will have edited the test code —
that is §7's second non-implication doing its work: the code is untrusted,
the boundary contains it, approval never widened.

## 15. Example — language-neutral

The same schema with nothing npm-shaped in it: a Go repository whose
session uses the `go-mod` preset row of
`docs/environment-prepare-contract.md` §4, planned for a two-issue chain
segment.

```jsonc
{
  "schemaVersion": 1,
  "scope": {
    "sessionId": "svc-loop",
    "repo": { "provider": "github", "owner": "acme", "name": "svc" },
    "issues": [210, 211],
    "chainId": "svc-hardening"
  },
  "baseline": {
    "baseBranch": "main",
    "evidence": [
      { "name": "session:environmentPrepare", "source": "session-config",
        "locator": { "source": "session-config", "keyPath": ["environmentPrepare"] },
        "canonicalization": "json-canonical@1", "fingerprint": "sha256:a911…" },
      { "name": "session:verification", "source": "session-config",
        "locator": { "source": "session-config", "keyPath": ["verification"] },
        "canonicalization": "json-canonical@1", "fingerprint": "sha256:0d4e…" },
      { "name": "repo:Makefile#lint", "source": "repository-base",
        "locator": { "source": "repository-base", "file": "Makefile",
                     "selector": { "parser": "make-target@1", "fragment": "lint" } },
        "canonicalization": "utf8-bytes@1", "fingerprint": "sha256:6f02…" },
      { "name": "chain:membership", "source": "chain-registry",
        "locator": { "source": "chain-registry", "chainId": "svc-hardening" },
        "canonicalization": "json-canonical@1", "fingerprint": "sha256:b7d9…" }
    ]
  },
  "entries": [
    {
      "entryId": "environment.prepare#1",
      "operationId": "environment.prepare",
      "family": "environment",
      "params": {},
      "authorization": "session-default",
      "origin": "session",
      "pinned": {
        "execution": { "kind": "pinned-command", "source": "session-config",
                       "commandRef": { "source": "session-config", "keyPath": ["environmentPrepare", "command"] },
                       "commandDigest": "sha256:c4a7…" },
        "cwd": "issue-worktree", "env": "session-mechanism", "network": "session-mechanism",
        "timeoutMs": 120000,
        "output": { "capture": "bounded-artifact", "publish": "redacted-summary" },
        "outcome": "report-only",
        "allowedEffects": { "worktreePaths": [] },
        "occurrence": "stamp-gated"
      },
      "assumptions": ["session:environmentPrepare"]
    },
    {
      "entryId": "verify.named#1",
      "operationId": "verify.named",
      "family": "verification",
      "params": { "name": "test" },
      "authorization": "session-default",
      "origin": "session",
      "pinned": {
        "execution": { "kind": "pinned-command", "source": "session-config",
                       "commandRef": { "source": "session-config", "keyPath": ["verification", "test"] },
                       "commandDigest": "sha256:31be…" },
        "cwd": "issue-worktree", "env": "session-mechanism", "network": "session-mechanism",
        "timeoutMs": 600000,
        "output": { "capture": "bounded-artifact", "publish": "redacted-summary" },
        "outcome": "report-only",
        "allowedEffects": { "worktreePaths": [] },
        "occurrence": "per-verification-cycle"
      },
      "assumptions": ["session:verification"]
    },
    {
      "entryId": "verify.make-target#1",
      "operationId": "verify.make-target",
      "family": "verification",
      "params": { "target": "lint" },
      "authorization": "plan-approval",
      "tier": "auto-grant",
      "origin": "repository",
      "pinned": {
        "execution": { "kind": "pinned-command", "source": "registry-template", "command": "make lint" },
        "cwd": "issue-worktree", "env": "stripped", "network": "none",
        "timeoutMs": 300000,
        "output": { "capture": "bounded-artifact", "publish": "redacted-summary" },
        "outcome": "report-only",
        "allowedEffects": { "worktreePaths": [] },
        "occurrence": "per-verification-cycle"
      },
      "assumptions": ["repo:Makefile#lint", "chain:membership"]
    }
  ],
  "assembledBy": "runner",
  "planFingerprint": "sha256:12e0…"
}
```

One approval covers `make lint` for both #210 and #211. When #210's PR
merges, `main` advances; `repo:Makefile#lint` is re-derived for #211's
occurrences and, unchanged, still matches — the approval carries. If #210
had rewritten the `lint` target, the evidence fingerprint changes, #211's
occurrence refuses `"assumption-failed"`, and the operator renews against
a fresh snapshot showing the new target. If someone edits the chain, the
`chain:membership` evidence fails the same way. The operation ids in both
examples other than `dependency.sync` (#697 §14) are illustrative registry
entries for the implementation issues to define under #697 §4's validation
discipline; the family shapes and constraints of §4 are the normative
part.

## 16. Compatibility

### 16.1 With `docs/tool-request-grant-tiers-contract.md` (#697)

- **Consumed whole, extended nowhere.** The typed-operation registry (§4),
  nomination discipline (§6 rule 2), tier resolution (§6), the enforcing
  execution boundary (§7), effect verification and patch-level adoption
  (§7–§8), tier ceilings (§9), notification (§10), and the audit record
  (§11) are used as specified. This contract adds no tier, no
  `TierRefusalReason` member, no registry policy value (the
  `"package-registry"` and `"session-mechanism"` values of §4 are plan
  vocabulary, explicitly excluded from #697's registry triple), no ledger
  or ChatOps change, and no new publication path.
- **The plan is a second authorization source for the same machinery.** In
  #697's terms, a `"plan-approval"` entry stands where a session allowlist
  entry stands — it names the same `(operationId, tier, allowedEffects)`
  triple a §5 entry names, fingerprint-bound and issue-scoped instead of
  standing and session-wide — and its verdict enters §7 in the allowlist
  verdict's place, with `resolveGrantTier` left to the fallthrough path
  (§9's handoff). Tier ceilings, containment attestation, effect
  verification, and the at-most-once rule apply identically via §9–§10.
- **Resolution order:** preflight authorization first, then — only on a
  preflight refusal other than `"occurrence-exhausted"` —
  `resolveGrantTier`, then the migration exception and the pre-#697
  flow; `"occurrence-exhausted"` parks as a direct human handoff (§9's
  carve-out, mirroring #697 §6's `"already-executed"`), so a consumed
  plan entry can never re-enter the legacy dependency route.
  With `preflight` disabled or absent, every #697 outcome is byte-for-byte
  unchanged, including the shipped dependency-update route's preservation
  through #697 §14's subsumption bar — the preflight layer only ever adds
  authorization; its refusals subtract nothing.

### 16.2 With the existing Tool Request resolution context

Against `docs/tool-request-and-dependency-sync.md` §2 and
`docs/guided-tool-request-flow.md`:

- **The emission contract is untouched.** Agents emit Tool Requests
  exactly as §2.1–§2.2 specify; the exact/redacted `command` /
  `displayCommand` split (§2.4), the task-context metadata record (§2.5),
  and the continuation-point machinery (§2.7) all still apply. A
  preflight-authorized request is one whose *disposition* changed: instead
  of the §2.3 `ready_for_human` handoff, the runner executes the planned
  typed operation under #697 §7 and the task continues; the request record
  and audit trail still capture what happened.
- **Scoped grants (§2.6) are unchanged and orthogonal.** A grant remains a
  per-occurrence, exact-command-hash, short-lived operator response; the
  plan neither creates grants nor consumes them. When a preflight refusal
  falls through to a human, the guided flow — grants included — is exactly
  the pre-#915 surface.
- **The guided flow is the human gate, unchanged.** Unresolved entries,
  refused occurrences, tainted report-only runs, and everything outside
  the plan land there precisely as today.
- **The shipped mechanisms keep their contracts.**
  `docs/environment-prepare-contract.md`'s prepare stamp, fail-closed
  prepare failure (a handler failure, never a `tool_request` handoff),
  runner-owned verification and its repair loop, and dependency sync's
  safe-mode rules are unchanged; `"session-default"` entries record them
  without gating them, and §2.1's non-derivation rule is preserved through
  §5's nomination-plus-approval discipline.

## 17. Open questions

1. **ChatOps approval.** Should a `preflight.approve` verb exist? It would
   need #784-table registration and #785 result mapping; this contract
   keeps `surface: "admin-cli"` closed and adds no verb.
2. **A strict gating mode.** Should a session be able to require an
   approved plan before write-capable implementation starts (fail-closed
   waiting instead of fallthrough)? Deliberately not a field yet (§11).
3. **Wall-clock expiry.** Content invalidation (§8) is the safety
   mechanism; is a TTL on approvals additionally wanted for hygiene?
4. **Refinement as an author.** Should the issue-refinement track
   (#866–#871) propose plan entries as part of its structured output, so
   plans inherit refined, human-reviewed metadata instead of raw Issue
   text?
5. **Session-default gating.** Recorded `"session-default"` entries are
   observational by design; is there a case for a session opting into plan
   review of changes to them (drift alarms rather than gates)?
6. **Cross-repo chains.** Scope is one repository; chain segments spanning
   repositories are out until the chain registry itself models them.

## 18. Invariants

1. Approval binds to a plan fingerprint over typed operation contracts —
   operation ids, typed params, tiers, pinned policy — never to
   command-text matching, and never to text an agent supplied.
2. Any change to a pinned command, a tier, a policy axis, a side-effect
   declaration, or a content-addressed baseline assumption — its locator,
   canonicalization, or bytes — changes the
   fingerprint or fails revalidation; stale approval is never silently
   reused (§6, §8, §9).
3. Free-form agent-proposed shell never gains automatic authorization:
   plan entries are registry-typed, unresolved entries are never
   authorizable, and `resolvePreflightAuthorization` never reads `command`
   or `reason` (§4, §9; #697 invariant 1 inherited).
4. The runner, not the implementation agent, decides whether a planned
   operation is authorized; agent output can nominate, never authorize
   (§9).
5. Preflight approval implies no trust in the code an operation executes:
   agent-edited repository code is contained by #697 §7's mandatory
   boundary, and a missing containment attestation refuses the occurrence
   (§7, §9 rule 8).
6. A preflight refusal falls through to the #697 and pre-#697 flows
   unchanged and subtracts nothing — except `"occurrence-exhausted"`,
   which parks as a direct human handoff because repeat protection
   outranks fallthrough (§9; #697 invariant 8 inherited) — and with
   `preflight` disabled the loop's behavior is byte-for-byte pre-#915
   (§9, §11).
7. `"session-default"` entries are observational: recording the shipped
   mechanisms changes none of their behavior, timing, or failure semantics
   (§3, §10, §16.2).
8. Report-only operations adopt nothing ever; adopt-changes operations
   adopt only through #697 §7 step 4's patch-level machinery at most once
   per task attempt, the occurrence reserved atomically before launch
   with ambiguous reservations counting as consumed (§10).
9. Snapshots are immutable and append-only; renewal is a new snapshot plus
   a new approval; there is no edge back into `approved`; supersession is
   keyed on the plan lineage with cover-bounded overlap retirement — a
   partial cross-lineage overlap refuses the snapshot instead of
   committing, so a new plan never withdraws authority from an issue
   outside its own scope and only a lineage's own renewal can shrink
   its coverage — so at most one
   active plan ever covers an issue and a chain-membership edit — or a
   membership that returns to an old value — never re-exposes a
   superseded approval; and revocation
   is honored at resolution and re-checked at the take — §9 rule 5 reads
   the plan's lifecycle state, and the reservation transaction
   re-verifies the active fingerprint and `approved` state, so the
   approval record surviving as history authorizes nothing after
   `revokePlanApproval`, and a revoke or supersede that commits before
   the reservation is never followed by a launch under the old approval
   (§6, §8, §9, §10, §11).
10. The plan and its approval evidence carry no secrets and no local
    absolute paths: session-config command bytes are unrepresentable in
    durable plan artifacts (`commandRef` plus `commandDigest` only, §4,
    §6), evidence locators name sources rather than values, exact pinned
    commands stay on local operator surfaces,
    and public text carries only the bounded, redacted summary (§6, §12).
11. No new chain scheduler: plans never order, trigger, block, or re-queue
    issues; chain scope only widens an approval's reach, bound at
    assembly to mandatory chain-registry membership evidence and
    revalidated per occurrence (§4, §13).
12. This contract adds no tier, no `TierRefusalReason` member, no change
    to #697's registry policy triple, no ChatOps verb, no ledger state,
    and no new publication path; the preflight refusal set and events are
    its own closed vocabulary (§9, §11, §16.1).

## 19. Test seams and matrix

Nothing in this document is implemented. When implementation begins, the
required coverage is:

| Area | Cases |
| --- | --- |
| Authorization resolution (§9) | pure-function tests over `resolvePreflightAuthorization`: each of the eight refusal reasons; a revoked plan refuses `"plan-unapproved"` at rule 5 while its `decision: "approved"` record survives as history; full-scope matching — an otherwise-covering snapshot for a different `sessionId` or `repo` refuses `"no-plan"` even on an equal issue number; typed-identity entry matching (params deep-equality over #783 §4.1 values — scalar, array, and zero-parameter `{}` forms; no text or glob matching; unresolved entries match no need); session-default passthrough; plan-approval happy path carrying the entry's `tier` and pinned effects, consumed by #697 §7's machinery with `resolveGrantTier` not called; adversarial `command`/`reason` text asserted unread; precedence — every refusal except `"occurrence-exhausted"` falls through to `resolveGrantTier` with unchanged inputs, while `"occurrence-exhausted"` parks as a direct human handoff, reaching neither `resolveGrantTier` nor the legacy dependency route. |
| Plan validation (§4) | assembly throws on duplicate `entryId`, a duplicate authorizable typed identity surviving the cross-layer merge — and the merge itself: a session-default contribution absorbs a same-identity plan-approval nomination, distinct-layer nominations collapse to one entry with the earliest-layer `origin` — unknown `operationId`, grammar-refused params, a resolved entry missing `params` or carrying a value outside #783 §4.1's `OperationParams` type, dangling assumption names, duplicate `baseline.evidence` names, a locator variant disagreeing with its evidence `source`, an unknown parser or canonicalization id, a `commandDigest` mismatching the bytes its `commandRef` resolves to, a multi-issue scope without a `chainId`, an empty issue list, a chain-scoped plan with no `chain-registry` membership evidence item or with that item's locator naming a `chainId` other than the scope's, a chain-scoped plan whose `scope.issues` differs from the evidenced membership, a plan-approval entry of a chain-scoped plan omitting the membership assumption, `"session-mechanism"` on a plan-approval entry, a plan-approval entry without a `tier` or with a `tier` above the operation's #697 §9 ceiling, a `tier` on a session-default entry, adopt-changes without once-per-attempt, empty `allowedEffects` on an adopt-changes entry, unknown closed-set values; a report-only entry with an empty effect set validates. |
| Fingerprint (§6) | canonical-form stability (key order, entry/evidence ordering); any single-byte change to a pinned command (rendered bytes or, for a session-config pin, its `commandDigest`), policy value, effect glob, evidence locator, canonicalization id, or evidence fingerprint changes `planFingerprint`; the fingerprint field itself is excluded from its own input. |
| Invalidation (§8) | approval does not carry across a superseding snapshot; a session-config edit yields `"plan-stale"`; a base-revision evidence change yields `"assumption-failed"`; a locator that no longer resolves, or an unknown parser or canonicalization id, yields `"assumption-failed"`; a base advance with byte-identical evidence still authorizes (the chain case). |
| Lifecycle and ports (§11) | the closed transition table; supersede-in-same-transaction; supersession is lineage-keyed — a chain-membership edit's new snapshot supersedes the prior chain plan through the shared `chainId` despite the changed `scope.issues`, and a membership reverted to its old value finds that plan `superseded`, never re-authorizing; cover-bounded overlap retirement — snapshotting a chain plan retires an active single-issue plan for a member issue with one `preflight_plan_superseded` per retired plan, while a single-issue snapshot against a live chain plan with other members — and a chain snapshot sharing an issue with another chain's plan it does not fully cover — refuses `"scope-conflict"` naming the conflicting plan, writing nothing, and leaving that plan and its approval untouched; the departed-member sequence — the stale chain plan renewed through its own lineage without the departed issue, then the retried single-issue insert committing cleanly — preserving at most one active plan per `(sessionId, repo, issueNumber)`; decision and revocation CAS; reservation committed before launch, with exactly one winner of a racing double-take; a revoke or superseding snapshot committing between a clean resolution and the take — the guarded reservation refuses without inserting, no reservation row exists for the dead fingerprint, and the re-consult refuses per §9 or authorizes under an already-approved superseding snapshot with the current fingerprint; settlement in the run's own audit transaction; an unsettled reservation counts as consumed across a simulated crash; a superseding snapshot does not refresh a spent occurrence window, while a new task attempt or verification cycle opens fresh capacity; two member issues of a chain-scoped plan reserving the same typed identity in their own windows take disjoint keys — the task scope in the key. |
| Family semantics (§10) | report-only runs adopt nothing and a tainted run stops unattended continuation with residue preserved; adopt-changes inherits #697's effect-verification and at-most-once behavior; `"package-registry"` pins refuse `"containment-unavailable"` absent the capability attestation. |
| Redaction (§6, §12) | no absolute path, no environment value, and no session-config command byte is representable in a snapshot; the Review display digest-verifies re-derived session-config command bytes before showing them; public summaries carry only ids, counts, states, and the fingerprint prefix; `displaySummary` obeys the `displayCommand` redaction rules. |
| Docs pin | `test/docs-preflight-execution-plan-contract.test.js` pins this document's status line, chain position, the closed refusal-reason set, the closed plan-state set and transition table shape, the seven-axis pinned contract, the nominate-never-authorize contribution rule, the approval non-implications (no code trust, no text matching, no standing grant, no schedule), the content-addressed baseline rule, the evidence-locator re-derivation rule, the session-config command-reference (no command bytes) rule, the subtracts-nothing fallthrough and its `"occurrence-exhausted"` carve-out, the reservation-before-launch consumption rule, the typed-identity uniqueness rule, the chain-scope membership-evidence rule, the cover-bounded retirement rule, the no-scheduler chain rule, both examples' presence, the §16 compatibility statements, and the delivery-note reconciliation in `docs/tool-request-grant-tiers-contract.md` §18 (and `docs/DOMAIN.md` §5 where present) against drift. |

## 20. Non-goals and forward pointers

This document defines the preflight authorization layer only. It does not
define, and nothing implementing it should assume:

- **Runtime execution and platform isolation** — the enforcing boundary's
  concrete mechanism, the `"package-registry"` containment capability, and
  the wiring that runs planned entries at their §10 moments are the
  chain's later issues (#916 onward; see the issue body for the
  authoritative GitHub Issue Relationships), per #697 §18's own deferral.
  **Delivered (#916)**: `docs/single-host-platform-sandbox-contract.md` —
  the supported single-host platform set (macOS, Linux, WSL2, EC2; native
  Windows and ECS/Fargate-style substrates rejected), the provider CLI
  sandbox capability matrix, and the fail-closed capability checks and
  degraded-mode policy under which containment-dependent entries keep
  refusing per §9. The enforcing boundary's concrete mechanism, the
  `"package-registry"` containment capability, and the §10 execution
  wiring remain with the chain's later issues (#917 onward).
  **Delivered (#917)**: `docs/single-host-execution-backend-contract.md` —
  the single-host isolated ExecutionBackend contract: the execution
  seam that runs `"plan-approval"` occurrences under an attested
  isolated backend (`local` is never admissible for them) while
  `"session-default"` occurrences pass through their shipped
  mechanism's own operation class unchanged, maps a backend refusal
  onto the existing `"containment-unavailable"` route, and keeps an
  unsettled occurrence reservation consumed across a crash.
  The backend engines, run registry, selection wiring, and packaging
  changes remain with the chain's later issues (#918 onward).
  **Delivered (#918)**: `docs/verification-execution-contract.md` —
  the runner-owned verification execution and continuation contract:
  defines the verification-cycle identity the
  `"per-verification-cycle"` occurrence window keys on, runs
  `"plan-approval"` verification entries inside implementation-lane
  and continuation-lane cycles under §10's report-only semantics
  unchanged (a tainted run still stops unattended continuation at the
  human gate), and resolves every cycle's results as one aggregate
  set. The execution wiring remains with the chain's later issues
  (#919 onward).
  **Delivered (#919)**: `docs/unattended-tool-request-contract.md` —
  the unattended Tool Request handling and human parking contract: the
  chain's final design issue. It adopts this contract's §9 consult
  precedence as the loop's single authority order, restates the
  `"occurrence-exhausted"` direct park, defines the derived request
  lifecycle, deterministic repeat rules, and parking contract around
  it, and carries the final dependency-ordered implementation
  decomposition (P1–P4 slices for this contract's ports, assembly,
  resolution wiring, and operator surfaces), awaiting human approval.
  Implementation of every slice remains with the tracker-assigned
  issues that decomposition proposes.
- **Implementation of the ports, resolver, session schema, store rows,
  events, or operator surfaces** — implementation slices over this
  contract.
- **Admin CLI grammar and registration** — governed by the admin-CLI
  contracts when the surface slice lands.
- **A ChatOps verb or any #784-table change** — deferred (§17).
- **A chain scheduler** — permanently out of scope here (§13); the chain
  registry remains the only chain authority.
- **Changes to the shipped `environmentPrepare`, `verification`,
  `dependencySync`, Tool Request, or guided-flow behavior** — all
  preserved (§3, §16.2).
- **Generic auto-grant of agent-proposed commands** — stays exactly as
  deferred as #697 §15 left it; a plan gives free-form text no new route.
