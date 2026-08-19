# ChatOps command grammar and trust boundary

Status: **approved design, implemented at the recognition layer**
(`src/core/chatops-command.ts`). This document specifies exactly one thing:
how a work-item comment is recognized as an executable command and by whom.
It does not specify, and no implementation built against it may assume,
provider polling, a durable cursor/ledger, replay/restore handling, or
operation dispatch — those are separate, later contracts (§8).

This "implemented" status is component-level, not end-to-end: see
[feature-status.md](feature-status.md) for ChatOps's overall availability,
which stays `foundation-only` until comment ingestion, dispatch, and result
publication are connected.

Issue #696 / PR #776 attempted to specify the entire ChatOps surface —
grammar, identity, durable replay, provider behavior, dispatch, and
dependency planning — in one document. Ten review cycles kept surfacing new
boundary conditions because the scope was too broad to review coherently.
Issue #777 extracts only the grammar and trust boundary from that draft; PR
#776 is retained as reference material for the follow-up chain (§8), not as
an implementation branch. Where this document's decisions were already
vetted by that review history, it keeps them; where a decision depended on
cursor/ledger/dispatch machinery, it is deliberately narrowed to what the
recognition layer alone needs.

## 1. The author-channel invariant

`docs/DOMAIN.md` §3 revisits "issue authors may be untrusted" for a
private-only repo and concludes an issue-comment command surface is safe to
add **as an authenticated command channel**, never as free-text
interpretation:

> the author channel's *identity* is verifiable; its *content* is never
> instructions. The only text-to-action path is a fixed command grammar,
> structurally parsed — never LLM-interpreted free text — gated by an
> explicit author allowlist. No guard may depend on contributor count.

`docs/private-control-plane-security.md` §9 upholds the same rule. This
document is that invariant made concrete. It rules out:

- An LLM or agent reading a comment and deciding what it authorizes.
- Dispatch gated on GitHub's `author_association` (OWNER/COLLABORATOR) or any
  other repo-membership property — that changes scope the moment the repo
  gains a collaborator or crosses into the planned public mirror, without
  this document changing at all.
- Any free-form text taken from a comment and passed to a shell. A
  recognized command is a verb plus a normalized argv-style token array
  (§2), never a string a downstream layer interpolates.

## 2. Command grammar

A command is the comment's **first eligible line** (§3) matching:

```
command := "/" verb (" " token)*
verb     := [a-z][a-z0-9-]+
token    := flag | value
flag     := "--" [a-z][a-z0-9-]+ ("=" value)?
value    := "\"" [^"]* "\"" | [^\s"]+
```

Normalization rules, applied before a parsed command is handed to anything
else:

- The candidate line is trimmed of leading/trailing whitespace before
  matching; internal whitespace separates tokens.
- Matching is case-sensitive; `verb` and a flag's name are lower-kebab only.
  `/Grant` and `/GRANT` are not commands.
- `--flag=value` and `--flag value` are equivalent and produce the same
  normalized output: two argv entries, `["--flag", "value"]`. A downstream
  option parser that only understands space-separated flag/value pairs (as
  this codebase's admin CLI parser does) never has to special-case the `=`
  form — the expansion happens here, once.
- A value (quoted or bare) that itself starts with `--` is rejected —
  `--message=--yes` and `--message="--yes"` are both malformed, not a
  command with a value of `--yes`. Once flattened to `["--message",
  "--yes"]`, that pair is indistinguishable from two standalone flags, and
  this codebase's option parser (`tokenizeArgs`) explicitly refuses a value
  flag whose next token starts with `--`. Accepting the value here and
  failing it at dispatch would mean a comment that passes recognition can
  still change meaning or be unusable downstream; rejecting it at
  recognition keeps "recognized" and "dispatchable" the same set.
- A flag's value may be quoted (`--on-changes="commit and push"`) or bare
  (`--on-changes=commit`); a bare value cannot contain whitespace or a `"`.
  A quoted value may contain whitespace but supports no escape sequence —
  there is no way to put a literal `"` inside a quoted value.
- A command has no notion of a distinguished second "resource" token in this
  contract. Every token after the verb — quoted or bare, flag or plain
  value — is emitted as an ordered argv entry. Assigning positional meaning
  to a particular token (e.g. treating a bare second token as a sub-resource
  the way `admin tool-request run` does) is the dispatch layer's job and is
  out of scope here (§8).
- No shell metacharacter (`` $ ` | ; & < > ( ) { } ``) is meaningful
  anywhere in a candidate line. A line containing one is not stripped,
  escaped, or partially accepted — the **whole comment is rejected** as
  malformed. This holds even though a recognized command is never passed to
  a shell (§1): rejecting outright removes any doubt about what a stray
  metacharacter in a comment could ever do, and keeps the grammar's
  behavior independent of whatever a future dispatch layer does with argv.
- Any other structural violation — an unterminated quote, a token glued to
  a flag or a closing quote with no separating whitespace, an empty value
  after `--flag=`, junk immediately after the verb with no separating
  whitespace — rejects the whole comment (§4). There is no partial match:
  either the full candidate line parses as one command, or the comment is
  not a command at all.
- The issue/work item the comment lives on is a command's only implicit
  scope. This grammar has no field for "target a different issue" — a
  future dispatch layer that fills an issue-number argument from context
  must do so unconditionally, never by trusting a comment-supplied value
  (that is a dispatch-layer decision and is out of scope here, but the
  grammar deliberately gives a comment no token shape reserved for it).

## 3. Parsing exclusions

Before scanning for a command line, the parser strips regions a reasonable
reader (and GitHub's own Markdown renderer) would never read as a live
instruction, plus blank lines (which carry no content), then evaluates
**only the first surviving non-blank line** as the candidate. If that line
does not match §2's grammar, the whole comment is not a command; the parser
never looks at a later surviving line for a candidate that would have
matched — skipping a *blank* line while searching for the candidate is not
the same as continuing past a *non-matching* one, and only the former
happens. A comment reading `context or explanation\n/grant` is therefore
not a command: `/grant` is the second surviving line, not the first, even
though it is the only line that would match the grammar in isolation. This
keeps "does this comment carry a
command" a yes/no answer with exactly one candidate, never a search.

The strips, applied in order, per line:

1. **Fenced code blocks.** An opening fence — 0–3 leading spaces, then three
   or more consecutive `` ` `` or `~` characters — starts an excluded region
   that runs through the matching closing fence (0–3 leading spaces, the
   same character, a run at least as long as the opener's, nothing but
   trailing whitespace after it) or through the end of the comment if no
   closing fence appears. Everything between the fences is excluded
   regardless of its own indentation, including a fence indented by up to
   three spaces — GitHub renders that as code, so a scanner that only
   recognizes column-0 fences would leave a command inside
   `` "  ```\n/grant\n  ```" `` visible.
2. **Indented code blocks.** Any line indented by four or more columns
   (spaces, or a tab counted as advancing to the next multiple of four) is
   excluded, independent of rule 1.
3. **Block-quoted lines and their lazy continuations.** A line starting with
   `>` (0–3 leading spaces, nesting allowed) is excluded, and so is every
   immediately following non-blank line that does not itself start a new
   block — per CommonMark's lazy-continuation rule, such a line is still
   part of the quote paragraph even without its own `>` prefix. The
   exclusion ends at the first blank line. `"> quoted explanation"`
   immediately followed by `/grant` on the next line excludes `/grant` too.
4. **Inline-code-span-only lines.** A candidate line fully wrapped in a
   single inline code span (`` `...` ``) is excluded.

A command string that appears solely inside a quote, a code fence, or an
inline code span is never a command. This is what makes pasting someone
else's ChatOps command as an example — in backticks, in a quote reply, or
in an indented fence — safe: it can never re-trigger the command it quotes.

## 4. Outcomes

Recognizing one comment always produces exactly one of:

| Outcome | Meaning |
|---|---|
| `unauthorized-author` | The author is not in `chatOps.authorAllowlist` (§5). No parsing is attempted. |
| `malformed` | The author is allowlisted, but the first surviving line (§3) does not match the grammar (§2) at all — there is no partial-match case. |
| `ambiguous-edit` | The first surviving line matches the grammar, but the comment was edited before it could be evaluated (§6) — which body reflects author intent is undecidable. |
| `unsupported-command` | The first surviving line matches the grammar and the comment was never edited, but its verb is not in the fixed set of verbs a given ChatOps deployment recognizes. Which verbs are recognized, and what each one does, is dispatch-layer scope (§8) — this contract only guarantees an unrecognized verb never silently falls through to something else. |
| `command` | A structurally valid command from an allowlisted, unedited comment, ready to be handed to a dispatch layer. |

`unauthorized-author` is checked **before** any parsing runs, and a
non-allowlisted author's comment produces no observable reaction (no error
reply, no reaction emoji) — reacting at all would turn the surface into an
oracle a non-allowlisted commenter could use to discover the grammar by
trial and error.

**Duplicate observation** is a fifth condition this document deliberately
does not turn into a sixth outcome: it is not a property of one comment in
isolation, it is a property of a comment being *observed more than once*
(poller re-delivery, a process restart, a restore to an earlier database
snapshot). Recognition as specified here is a pure function of a comment's
identity and its immutable first-seen fields (author, body,
`createdAt`/`updatedAt` as first observed) — recomputing it for the same
comment always yields the same outcome. That determinism is precisely what
lets a later, stateful layer detect and short-circuit a duplicate by
memoizing on comment identity alone, without this document having to
specify *how* — the durable memo (a cursor, a ledger, or both) is exactly
the "cursor/ledger behavior" issue #777 keeps out of scope, tracked by the
follow-up chain in §8.

## 5. Author allowlist and automation identity

New optional session config:

```ts
chatOps?: {
  enabled: boolean;
  /** Provider logins allowed to issue commands. Non-empty when enabled. */
  authorAllowlist: string[];
  /**
   * Provider logins the session's own automation has posted acknowledgement
   * markers as, across every credential rotation. Non-empty when enabled.
   * Never pruned: removing an entry would retroactively de-authenticate
   * every marker that identity already posted.
   */
  automationLogins: string[];
}
```

Both lists are static and explicit — never repo collaborator/role state,
never sized by "how many people currently have write access." This is what
lets the gate survive the planned public mirror unchanged: mirroring the
repo does not change who is in `authorAllowlist`.

Gate order, per comment:

1. If `chatOps.enabled` is not true, this whole recognition pass does not
   run for the session.
2. Author allowlist check (§4's `unauthorized-author`), before any parsing.
3. Grammar parse (§2, §3).
4. Edited-comment check (§6).
5. Verb-support check.

`authorAllowlist` governs who may *issue* a command. `automationLogins` is a
separate identity used only to authenticate the acknowledgement markers
this system itself posts (§7) — an allowlisted human author is never, by
that fact alone, trusted to post an authentic marker.

## 6. Comment-edit semantics

A comment's `createdAt`/`updatedAt` timestamps (as reported by the
provider) make edits detectable. The rule: a comment is eligible to execute
**only if `updatedAt === createdAt` at the moment it is first observed**
(i.e., as far as this system has ever seen it, it was never edited).

- If, on first observation, `updatedAt !== createdAt` — it was edited
  before any poll ever saw it, a poll-gap race — the comment is rejected as
  `ambiguous-edit`. Which body reflects author intent is undecidable, so it
  is never executed.
- This is a decision about *first observation*, not about "the current
  body": once a comment has been assigned a terminal outcome
  (`command`, `unsupported-command`, or `ambiguous-edit`) on first
  observation, that outcome is final. A later edit to that comment — before
  or after any resulting execution — is never re-read as a new command.
  (Enforcing "terminal outcomes are never re-evaluated" across restarts is
  itself a durable-state concern and therefore belongs to the follow-up
  ledger design in §8, same as duplicate detection in §4; this document
  only fixes the *rule* the ledger must implement, not the ledger.)

Immutable first-seen input is preferred over editable input by construction:
there is no code path anywhere in this contract that re-reads a comment's
current body for a decision already made from its first-seen body.

## 7. Acknowledgement markers

A downstream layer (§8) posts acknowledgement markers back to the issue —
a claim marker before a command executes, an outcome marker after. This
document does not specify when or how those posts happen (that is durable
delivery, §8); it specifies the marker format and, critically, how a marker
is told apart from an untrusted look-alike, because an unauthenticated
marker must never be able to suppress a trusted command.

Canonical marker bodies:

- `<!-- chatops-claimed:<id> -->`
- `<!-- chatops-ack:<id>:<outcome> -->`, `outcome` one of `executed`,
  `rejected`, `error`.

`<id>` is the provider's comment identifier, as the canonical decimal digit
string (no leading zeros) — see §8's compatibility note on why this is the
identifier shape this contract standardizes on.

A comment is an **authenticated** marker only when **both** hold:

- Its body, trimmed, is *exactly* one of the canonical forms above — not
  merely a body that contains a matching substring. A marker embedded
  inside a longer comment, or with extra or garbled text around it, does
  not count.
- Its author is a member of `chatOps.automationLogins` (§5), current or
  historical.

A comment that merely looks like a marker — right shape, wrong author, or
an inexact body — is treated as an ordinary comment. It does not suppress
anything, and if it also happens to be a well-formed, author-allowlisted
command it is evaluated normally under §2–§6. Since a non-automation
commenter can never satisfy the author check, no commenter can forge a
marker to suppress someone else's command — this is what satisfies "an
untrusted acknowledgement marker cannot suppress a trusted command."

## 8. Explicit non-goals and forward pointers

This document defines recognition only. It does not define, and nothing
that implements it should assume:

- **Provider polling** — how or how often comments are fetched.
- **Durable cursor/ledger behavior** — how "already observed", "already
  claimed", or "already acknowledged" is made to survive a restart or a
  database restore. §4 and §6 above state the *rules* such a ledger must
  enforce (determinism, first-seen-is-final); they do not design the
  ledger.
- **Operation dispatch** — what a recognized `command` (§4) actually does,
  which verbs exist at all beyond "a fixed set some deployment supports",
  and how a comment's argv reaches an operation implementation.
- **Dependency/typed-operation trust tiers** — grant-tier policy for what a
  dispatched operation is allowed to touch.

That work is tracked by the executable chain this issue heads:
`#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917
→ #918 → #919 → #722` (see the issue body for the authoritative GitHub
Issue Relationships). In particular:

- **Compatibility note for future providers.** `ChatOpsCommentInput` (this
  module) intentionally mirrors the shape the eventual `WorkItemProvider`
  read path will need — `author`, `body`, `createdAt`, `updatedAt`, plus a
  comment identifier not modeled here because recognition never needs to
  compare or order identifiers, only a durable ledger does (§8, next
  issue). GitHub's numeric comment ID already satisfies "canonical decimal
  digit string, no leading zeros" (§7); a future Gitea work-item provider
  must produce the same shape (Gitea's comment IDs are also decimal
  integers) so this recognition layer, and the marker format in §7, need no
  provider-specific branch. Numeric-vs-lexical comparison of that
  identifier, incremental retrieval, and cursor bootstrap are all cursor
  design (§8, out of scope here).

## 9. Examples

Accepted (author allowlisted, never edited):

- `/grant` → `{ verb: "grant", argv: [] }`
- `/grant --on-changes commit` → `{ verb: "grant", argv: ["--on-changes", "commit"] }`
- `/grant --on-changes=commit` → identical argv to the previous line.
- `/grant --confirm-discard --allow-unexpected` → three-token argv, order
  preserved: `["--confirm-discard", "--allow-unexpected"]` (both bare
  flags).

Rejected:

- `context or explanation`\
  `/grant` → `malformed`. `/grant` is the second surviving line, not the
  first (§3); the parser never looks past the first.
- `` "> please run /grant for me" `` → `malformed`. The whole line is a
  block quote (§3, rule 3); nothing survives to match.
- `` "  ```" `` / `` "  /grant" `` / `` "  ```" `` (a fence indented by two
  spaces) → `malformed`. Still recognized as a fence per §3's fenced-code
  rule (0–3-space tolerance), so `/grant` inside it is excluded.
- `` "`/grant`" `` (inline code span) → `malformed` (§3, rule 4).
- `/grant --session-ref other-session` → parses structurally (`{ verb:
  "grant", argv: ["--session-ref", "other-session"] }`); whether a
  particular flag is one a given operation accepts from a comment at all is
  a dispatch-layer allowlist decision, out of scope here (§2, §8) — this
  grammar does not reject it, a future dispatch layer must.
- `/grant $(rm -rf /)` → `malformed`. Shell metacharacters reject the whole
  comment (§2).
- A comment edited one second after posting, before any poll observed it →
  `ambiguous-edit` (§6), even if its body is a perfectly well-formed
  `/grant`.
- `/nonexistent-verb` → `unsupported-command` (verb `nonexistent-verb`),
  once past the author and edit gates.

## 10. Bounded input and public response requirements

**Bounded input.** A comment body longer than
`MAX_CHATOPS_COMMENT_BODY_CHARS` (4000 characters —
`src/core/chatops-command.ts`) is rejected as `malformed` before any
exclusion scanning or grammar parsing runs. Because the author-allowlist
gate (§5) always runs first, this never creates a size-based oracle for a
non-allowlisted author — they get `unauthorized-author` regardless of body
length. Every command this contract actually supports is a handful of
tokens (`/grant --on-changes commit` is 27 characters), so the bound costs
nothing for a real command while keeping one comment's recognition cost
independent of how large an attacker-controlled body can be — the same
"bounded scan" posture `docs/DOMAIN.md` §3 already commits this codebase to
for other attacker-controllable text.

**Public response requirements.** Which recognition outcomes (§4) may ever
produce a visible reaction to the comment, and which must stay silent, is a
policy decision independent of *how* a reply is delivered (durable
delivery is §8, out of scope):

| Outcome | Public response allowed? |
|---|---|
| `unauthorized-author` | Never (§5 — avoids an oracle for discovering the grammar). |
| `malformed`, candidate line does not start with `/` | Never. Most comments on an issue are ordinary discussion, not attempted commands; reacting to every one that simply isn't a command would be noise, not a response. |
| `malformed`, candidate line starts with `/` (a clear command attempt that broke a grammar rule) | Allowed — this is the one case where telling the author something looked wrong is worth a reply. |
| `ambiguous-edit` | Allowed. §7's `chatops-ack:<id>:rejected`-shaped marker is the intended vehicle. |
| `unsupported-command` | Allowed. |
| `command` | Allowed — §7's claim/ack markers are exactly this. |

`looksLikeCommandAttempt` and `isPubliclyRespondable`
(`src/core/chatops-command.ts`) implement this table as pure functions over
an outcome (§4) and the comment body; they decide *whether* a reply is
warranted, never *what* it says or *how* it is sent.
