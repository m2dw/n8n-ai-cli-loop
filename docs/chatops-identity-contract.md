# ChatOps provider identity and state namespace

Status: **approved design, implemented for identity derivation and key shape**
(`src/core/chatops-identity.ts`). This document specifies exactly one thing:
what tuple of values identifies "one session's view of one work item on one
provider," and what strings a durable cursor or ledger row for that view is
keyed by. It does not specify, and no implementation built against it may
assume, cursor advancement, pagination completeness, claim/dispatch/ack
behavior, restore semantics, or command dispatch — those are separate, later
contracts (§8).

This "implemented" status is component-level, not end-to-end: see
[feature-status.md](feature-status.md) for ChatOps's overall availability,
which stays `foundation-only` until comment ingestion, dispatch, and result
publication are connected.

Issue #696 / PR #776 attempted to specify the entire ChatOps surface —
grammar, identity, durable replay, provider behavior, dispatch, and
dependency planning — in one document. Ten review cycles kept surfacing new
boundary conditions because the scope was too broad to review coherently.
Issue #777 extracted the command grammar and trust boundary
(`docs/chatops-command-grammar-contract.md`). This document is issue #780,
the next link in that chain: it extracts only identity and key-space from
PR #776's draft (§6/§7.1 of the retained
`docs/chatops-command-surface-design.md` draft, as it stood at commit
`91b1e9c`, the last commit of the unmerged #696 branch — not present on
`main`) — the same review history vetted those decisions; where a decision
depended on cursor/ledger/dispatch machinery this document narrows it to what
identity alone needs.

## 1. Why identity needs its own contract

A durable cursor or ledger row means "everything up to here, for this scope,
is already handled." Two distinct sessions, or the same session repointed to
a different provider, must never be able to read or write each other's rows
— not because the row format is fragile, but because misreading one means
either replaying an already-executed command or silently skipping one that
was never seen. `docs/outbox-scan-cursor-contract.md` §4 established the same
principle for outbox dispatch identity; this document is the analogous
contract for ChatOps.

The review of PR #776 found two concrete ways the naive approach fails:

- Keying state by `session_id` and issue/comment number alone lets two
  sessions collide if their issue numbers happen to match, and lets a single
  session collide with its own past state after `workItemProvider` is
  repointed to a different provider, endpoint, or repo
  (`docs/retention-backup-contract.md` §8 already establishes that this
  codebase lets an operator repoint session config at any time — there,
  `artifactRoot` via `session_roots`; here, `workItemProvider`).
- Keying a Gitea endpoint by its raw configured `baseUrl` string lets two
  spellings of the *same* server (a trailing slash, a different letter case,
  an explicit default port) resolve to two different identities, which is
  wrong in the opposite direction: it makes a single provider look like two.

## 2. The canonical ChatOps provider identity tuple

```ts
export interface ChatOpsProviderIdentity {
  sessionId: string;
  provider: ChatOpsSupportedWorkItemProviderKind; // "github-issues" | "gitea-issues"
  providerEndpoint: string;
  providerOwner: string;
  providerRepo: string;
}
```

Every field is required; none is optional or defaulted by the derivation
function (§5). The five fields are:

| Field | Meaning | GitHub source | Gitea source |
| --- | --- | --- | --- |
| `sessionId` | The session's own canonical id (`ResolvedSession.sessionId` / `SessionConfig.sessionId`) — never `sessionNo` or an alias. `SessionRegistry.resolveSessionRef` (`src/core/session.ts`) is what resolves either of those to the canonical `sessionId`; this contract only ever consumes the resolved value, the same way `docs/outbox-scan-cursor-contract.md` §4 keys outbox ownership scope on `sessionId` alone, never a reference form. | `session.sessionId` | `session.sessionId` |
| `provider` | The **work-item tracker** provider kind (§3) — never a repo-host kind. | `"github-issues"` | `"gitea-issues"` |
| `providerEndpoint` | The canonical API endpoint (§4). GitHub's is a fixed constant because it is not session-configurable; Gitea's is derived from `baseUrl`. | fixed constant `github.com` | canonicalized `workItemProvider.gitea.baseUrl` |
| `providerOwner` | The owning org/user of the work-item container. | `session.githubOwner` | `workItemProvider.gitea.owner` |
| `providerRepo` | The repository name of the work-item container. | `session.githubName` | `workItemProvider.gitea.repo` |

This tuple identifies **a session's current view of one repository's issue
tracker on one provider**. It is not itself a cursor or ledger key — §6 layers
`issueNumber` and `commentId` on top of it for those.

`sessionId` participates for the same reason `docs/outbox-scan-cursor-contract.md`
§4 includes it in dispatch identity: two sessions can be configured against
the same provider/endpoint/owner/repo (a shared-checkout or multi-session
setup is not excluded by anything in `docs/DOMAIN.md`), and each must track
its own independent view of that thread. This directly satisfies this
issue's acceptance criterion that two sessions cannot share ChatOps state
solely because their issue numbers match — the full identity tuple, not just
the issue number, is always the scope key, and `sessionId` alone already
splits any such pair apart before `providerOwner`/`providerRepo` are
considered at all.

## 3. `github-issues` is a work-item provider kind, not a repo-host kind

`src/core/session.ts` defines two **separate, non-interchangeable**
enumerations:

- `WorkItemProviderKind = "github-issues" | "gitea-issues" | "jira" | "azure-devops" | "bitbucket"`
  — what tracks *issues* (the ChatOps surface lives here).
- `RepoHostProviderKind = "github" | "gitea" | "azure-devops" | "bitbucket"`
  — what hosts *pull requests*.

The string `"github"` is a valid `RepoHostProviderKind` and is **never** a
valid `ChatOpsProviderIdentity.provider` value — that identifier belongs to
PR operations, not issue-comment ChatOps. The valid work-item provider kind
for GitHub is `"github-issues"`. A session's `workItemProvider.provider` and
`repoHostProvider.provider` are independent config values (a session can, in
principle, track issues on one provider and open PRs on another), so this
contract only ever reads `workItemProvider.provider`.

Of the five `WorkItemProviderKind` values, only two have a runtime
`WorkItemProvider` implementation today (`src/providers/github/gh-work-item-provider.ts`,
`src/providers/gitea/gitea-work-item-provider.ts`) and, as of this contract,
a defined canonical-endpoint rule (§4):

```ts
export type ChatOpsSupportedWorkItemProviderKind = "github-issues" | "gitea-issues";
```

`"jira"`, `"azure-devops"`, and `"bitbucket"` are reserved identifiers in
`WorkItemProviderKind` (session config accepts them so they can be declared
without a config-format change later) but have neither a runtime provider nor
an endpoint-canonicalization rule. Deriving a `ChatOpsProviderIdentity` for a
session configured with one of them is undefined by this contract (§5).

## 4. Canonical Gitea endpoint normalization

`GiteaWorkItemConfig.baseUrl` is validated at session load
(`giteaBaseUrl` in `src/registries/json-session-registry.ts`) but stored
**verbatim** — validation only rejects a non-http(s) scheme and embedded
`user:password@` credentials; it does not fold equivalent spellings together.
Two `baseUrl` values that address the same Gitea instance can therefore
differ as raw strings:

- `https://gitea.example.com` vs. `https://gitea.example.com/` (trailing
  slash),
- `https://gitea.example.com` vs. `https://GITEA.Example.COM` (host case —
  DNS names are case-insensitive),
- `https://gitea.example.com` vs. `HTTPS://gitea.example.com` (scheme case),
- `https://gitea.example.com` vs. `https://gitea.example.com:443` (explicit
  default port for the scheme),
- `https://gitea.example.com/base/` vs. `https://gitea.example.com/base`
  (trailing slash on a mounted sub-path).

`providerEndpoint` for `gitea-issues` is the output of
`canonicalizeGiteaEndpoint(baseUrl)`, defined as:

1. Parse with `new URL(baseUrl)`. A value that fails to parse is an
   **incomplete identity** (§5) — the function throws.
2. The scheme must be `http:` or `https:` (mirroring `giteaBaseUrl`'s own
   check); any other scheme throws.
3. The URL must carry no userinfo (`username`/`password`), no query string,
   and no fragment. `giteaBaseUrl` already rejects userinfo; this function
   additionally rejects a query string or fragment, because neither is
   meaningful for a REST API base and letting one silently ride along inside
   the canonical form would make two endpoints that "look equivalent" for
   every other reason still fail to collapse to one identity. This is a
   stricter check than session load performs today — deliberately: this
   contract's canonicalizer, not the raw stored `baseUrl`, is the value every
   successor cursor/ledger implementation must key on (§6).
4. The canonical form is `url.href` with trailing `/` characters stripped.
   `URL` parsing already lowercases the scheme and host and drops a port that
   equals the scheme's default port (WHATWG URL semantics), so steps 1–2
   alone collapse the case and default-port examples above; stripping the
   trailing slash from `href` (which is always present for a root path, e.g.
   `https://gitea.example.com/` → `https://gitea.example.com`) collapses the
   trailing-slash examples, including on a mounted sub-path. This mirrors,
   and subsumes, the trailing-slash stripping `gitea-client.ts` already
   applies to `baseUrl` and `apiPath` independently for request construction
   — that stripping is a request-building convenience and is not itself
   sufficient for identity, since it does nothing for case or port
   equivalence.

`apiPath` (`GiteaWorkItemConfig.apiPath`, default `/api/v1`) does **not**
participate in `providerEndpoint` or anywhere else in the identity tuple. It
selects how the *same* instance's API is reached (a mount-path or version
prefix), not a different instance or a different issue tracker — two configs
that differ only in `apiPath` are the same work-item container and must
resolve to the same identity.

`github-issues` has no configurable endpoint (GitHub's API host is fixed),
so its `providerEndpoint` is the fixed constant `github.com` for every
session, regardless of configuration.

## 5. Ambiguous or incomplete provider identity

Deriving a `ChatOpsProviderIdentity` from a session is a **pure, fail-closed**
function: it either returns a complete tuple or throws. It never returns a
tuple with an empty string, a placeholder, or a guessed value in any field.

Cases that must fail closed:

- **Unsupported provider kind.** `workItemProvider.provider` is not in
  `ChatOpsSupportedWorkItemProviderKind` (§3) — includes the three reserved
  `WorkItemProviderKind` values and any future addition not yet extended into
  this contract. There is no partial identity for an unsupported provider;
  a caller must not fall back to treating it as `github-issues` or emitting
  an empty `providerEndpoint`.
- **Malformed or disallowed Gitea endpoint.** Anything `canonicalizeGiteaEndpoint`
  (§4) rejects: unparseable URL, non-http(s) scheme, embedded credentials, a
  query string, or a fragment.
- **Missing Gitea connection block.** `provider === "gitea-issues"` but
  `workItemProvider.gitea` is absent. Session validation already requires
  this block for `gitea-issues` (`json-session-registry.ts`), so a
  `ResolvedSession` cannot exhibit this — but the identity derivation checks
  it independently rather than trusting an already-validated caller, because
  a successor cursor/ledger implementation may construct the input from a
  narrower or hand-built object (mirroring why `deriveScanCursorKey`
  (`docs/outbox-scan-cursor-contract.md` §4) validates its own input instead
  of trusting callers).
- **Missing GitHub owner/repo.** `provider === "github-issues"` but
  `githubOwner`/`githubName` resolve empty. `ResolvedSession` always
  populates these from `githubRepo`, so this is a defensive check, not a
  reachable production path.
- **Empty Gitea owner/repo.** `provider === "gitea-issues"` and
  `workItemProvider.gitea` is present but its `owner`/`repo` resolve empty.
  Same defensive-check rationale as the missing-connection-block case above:
  a narrower or hand-built `ChatOpsIdentitySource` must not be able to smuggle
  an empty required field through to a "complete" tuple.
- **Missing `sessionId`.** `session.sessionId` resolves empty, regardless of
  provider kind. `ResolvedSession.sessionId` is always populated, so this is
  also a defensive check against a narrower or hand-built input shape, not a
  reachable production path.

What is explicitly **not** an identity-derivation failure, and is out of
scope for this contract:

- **Two sessions independently resolving to identities that share
  `providerOwner`/`providerRepo`/`issueNumber` but differ in `sessionId`.**
  Each session still gets its own complete, distinct
  `ChatOpsProviderIdentity` — the tuple never collapses two sessions into
  one. What a successor cursor/ledger layer *does* when two sessions
  legitimately track the same issue (whether to serialize, warn, or exclude
  intake for both) is cursor/dispatch-progression behavior, tracked by the
  successor chain in §8 — not an identity concern, because identity
  derivation for either session in isolation always succeeds.
- **A session repointed to a new `workItemProvider` after cursor/ledger rows
  already exist under the old identity.** The new identity is simply a
  different tuple; §6 states that this orphans the old rows rather than
  reusing them. Deriving the new identity does not fail — it is a complete,
  independent tuple from the moment the config changes.

## 6. Cursor and ledger key shapes

This section defines what a persisted cursor row and a persisted execution
(ledger) row are keyed by — the **shape**, not how either advances, claims,
or acknowledges anything. That state machine is successor scope (§7).

Both shapes extend the identity tuple (§2) with the work item it applies to,
never replace or narrow it:

- **Cursor scope** — one per `(identity, issueNumber)`. Represents "how far
  this session has processed comments on this issue, under this provider
  identity." Column shape (mirroring the table sketched in the superseded
  `docs/chatops-command-surface-design.md` §6, adopted here as the column
  set, not the behavior):
  `(session_id, provider, provider_endpoint, provider_owner, provider_repo, issue_number)`.
- **Ledger (execution) scope** — one per `(identity, issueNumber, commentId)`.
  Represents "has this specific comment already been claimed/executed by
  this session, under this provider identity." Column shape:
  `(session_id, provider, provider_endpoint, provider_owner, provider_repo, issue_number, comment_id)`.

`src/core/chatops-identity.ts` exposes pure derivation for both shapes as
opaque string keys, for callers that need a single-value key (e.g. an
in-memory map, a test fixture) rather than individual columns:

```ts
chatOpsIdentityKey(identity: ChatOpsProviderIdentity): string;
chatOpsCursorKey(identity: ChatOpsProviderIdentity, issueNumber: number): string;
chatOpsLedgerKey(identity: ChatOpsProviderIdentity, issueNumber: number, commentId: string): string;
```

Each is `JSON.stringify` of the ordered field array. `JSON.stringify` of an
array of primitive strings/numbers is injective — distinct tuples always
produce distinct strings, because the encoding escapes every quote and never
lets one field's content be mistaken for the delimiter — which is the same
argument `deriveOwnershipScanCursorKey`
(`src/core/outbox-scan-cursor.ts`) already relies on for the outbox's
ownership-scope key, and it needs no separate collision proof here.

That injectivity argument holds only for finite numbers: `JSON.stringify`
serializes `NaN`, `Infinity`, and `-Infinity` — all valid TypeScript `number`
values — to `null`, which would collapse distinct `issueNumber`s onto the
same key. `chatOpsCursorKey` and `chatOpsLedgerKey` therefore validate
`issueNumber` is a finite integer and throw otherwise, before it ever reaches
`JSON.stringify`.

These string-key helpers are for in-memory/test use. A successor persisted
schema (§7) must use **separate typed columns**, not one opaque joined
string, as its primary key — see §7 for why.

## 7. Migration and versioning requirements for a future schema

No `chatops_*` table exists yet; the successor issue that adds one (next in
the chain: durable comment cursor, `#781`) is the first implementation of
this identity contract. This section states what that first schema — and
any later revision of it — must satisfy. It does not create a schema.

- **Columns, not an opaque key, as the persisted primary key.** §6's
  string-key helpers are convenient for in-memory scopes, but a persisted
  table must store `session_id`, `provider`, `provider_endpoint`,
  `provider_owner`, `provider_repo` (plus `issue_number` / `comment_id` where
  applicable) as separate `TEXT`/`INTEGER` columns, composing the primary
  key. A future revision that needs to add, rename, or drop a field can then
  do so with an explicit `ALTER TABLE`/backfill against a named column,
  the same way `docs/retention-backup-contract.md` §8's `session_roots`
  table keeps a session's repointed roots distinguishable by column rather
  than by parsing an opaque blob. An opaque joined string as the actual
  `PRIMARY KEY` would make that impossible without an application-level
  parse-rewrite migration of every row.
- **A field-set change orphans, never reinterprets, existing rows.** If a
  later revision changes which fields compose the identity tuple (for
  example, adding an API-version discriminator), existing rows keep their
  old column set and are treated as a distinct, older identity — exactly the
  "changing any component intentionally orphans the previous key's rows"
  rule `docs/outbox-scan-cursor-contract.md` §4.1 already establishes for
  outbox ownership scope. An implicit reinterpretation of an existing column
  to mean something new is never acceptable; a genuine schema change is an
  explicit migration (new columns with a backfill, or a new table), never a
  silent redefinition of what an existing column's value means.
- **This contract has exactly one revision as of issue #780.** A successor
  schema built against it does not need a runtime schema-version column for
  that reason alone. If a future issue revises this contract's tuple shape
  (§2) or key shapes (§6), that issue must state, in its own document,
  which fields changed and what happens to rows persisted under the prior
  shape (orphan, per the rule above, unless that issue defines an explicit
  backfill) — the same discipline this document is itself following for
  PR #776's draft.

## 8. Explicit non-goals and forward pointers

This document defines identity and key-space only. It does not define, and
nothing that implements it should assume:

- **Cursor ordering, advancement, or pagination completeness** — how a
  cursor's `issue_number` scope moves forward, or how a provider's comment
  list is paginated to fill it. `docs/chatops-command-surface-design.md`
  (superseded) §6 sketches this; it is re-specified, not inherited wholesale,
  by the successor cursor issue.
- **Claim/dispatch/ack and restore behavior** — how an execution ledger row
  moves from claimed to acknowledged, and what makes that survive a DB
  restore. `docs/chatops-command-surface-design.md` (superseded) §7 sketches
  this; likewise re-specified by a later issue in the chain.
- **Command grammar** — `docs/chatops-command-grammar-contract.md` (issue
  #777), already implemented.
- **Operation dispatch and Tool Request trust tiers** — what a recognized
  command actually does, and what it may touch.

That work is tracked by the executable chain this issue's predecessor heads:
`#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917
→ #918 → #919 → #722` (see the issue body for the authoritative GitHub Issue
Relationships). The immediate successor, the durable comment cursor contract,
is expected to consume `ChatOpsProviderIdentity` and §6's key shapes exactly
as defined here rather than re-deriving them.
