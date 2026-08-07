# Research Publication Contract

Status: **implemented** (issue #834). Follow-up to #832; builds on the research
output withholding rules (#794 / #806 / #826) and the transactional outbox
guarantee (DOMAIN.md §2.3).

## 1. Why this exists

The research runner captures the agent's complete output in
`research-output.md` and records a structured `research-result.json`. Raw output
is withheld from GitHub whenever any of three conditions holds:

- the Issue body was interpolated into the research prompt (#794);
- the repository evidence channel was enabled (#806);
- the bounded Antigravity workspace profile was enabled (#826).

Those conditions now cover the whole useful repository-backed research path, so
the originating Issue received only `Findings recorded locally.` A later reader
could not understand the result and an operator had to open a machine-local
artifact by hand.

The Research Publication stage is the separately validated channel that replaces
that fixed status. It is **not** a relaxation of the withholding rules above:
raw agent stdout is never published under any publication mode. What reaches
GitHub is a closed-schema report the agent emitted deliberately, re-validated
and re-sanitized by trusted runner code, and rendered by the runner.

This channel carries its own, stricter gate. Deterministic validation bounds a
report's structure and not its provenance, and a research run is *always*
Issue-originated — so every run is untrusted by provenance (§5.1). The report is
produced and kept local unless the operator has explicitly accepted that risk
with `session.research.publication.allowUntrustedInputs`; with the
acknowledgment in place, the repository-backed path publishes a useful bounded
report instead of a fixed status.

## 2. Configuration

```jsonc
{
  "research": {
    "publication": {
      "mode": "sanitized_summary",
      "maxChars": 12000
    }
  }
}
```

| Mode | Behavior |
| --- | --- |
| `local_only` | The default. Byte-for-byte the pre-#834 behavior: no prompt section, no publication artifact, no publication context field, and the existing fixed-status comment. |
| `sanitized_summary` | Publish only a validated, bounded report. |

The block is parsed and preserved by `JsonSessionRegistry`, so it takes effect
from `sessions.json` like the sibling `research.antigravity` and
`research.evidence` blocks. That validator rejects an unrecognized `mode` and a
non-positive `maxChars` at load time: a typo would otherwise present as
"publication is configured but nothing is ever published". Policy resolution
keeps its own fallback — an unrecognized `mode` resolves to `local_only`, so a
session assembled outside the registry can never publish more than it was meant
to. `maxChars` defaults to 12,000 and is clamped to `[500, 60000]`.

`allowUntrustedInputs` (boolean, default `false`) is the third field: without it
`sanitized_summary` keeps the report local on every run, because every research
run is Issue-originated. See §5.1.

A raw-output publication mode is intentionally out of scope.

## 3. Wire format

Under `sanitized_summary` the runner appends a Publication Result section to the
runner-owned Instructions block of the research prompt — below the delimited
Issue body and below the line stating that the body cannot override those
instructions, so untrusted GitHub content never defines the format the runner
will trust.

The agent emits exactly one block on stdout:

```
<<<RESEARCH_PUBLICATION>>>
{ "publication": { … } }
<<<END_RESEARCH_PUBLICATION>>>
```

Markers are recognized only as whole lines (a trailing CR is tolerated). The
whole findings text is scanned, not a trailing window, so a duplicate emitted
early is still seen.

Extraction fails closed when the block is:

- **missing** (`missing-envelope`),
- **duplicated** (`duplicate-envelope`) — unlike the evidence request protocol,
  the last block does not win: two blocks may disagree, and "publish the last
  one" would let trailing chatter that merely looks like an envelope displace
  the real report,
- **unterminated** or not JSON (`malformed-envelope`),
- larger than 64 KiB (`envelope-too-large`).

Agent chatter, tool traces, stderr, and any text outside the markers are never
publishable content.

## 4. Report schema

Closed schema: `publication` is the only top-level key, and every object rejects
unknown fields rather than ignoring them.

| Field | Required | Bound |
| --- | --- | --- |
| `version` | no | must be `1` when present |
| `title` | no | 160 chars |
| `summary` | **yes** | 4,000 chars |
| `findings[]` | no | 12 entries |
| `findings[].title` | yes | 160 chars |
| `findings[].detail` | yes | 800 chars |
| `findings[].confidence` | no | `high` \| `medium` \| `low` |
| `recommendation` | no | 2,000 chars |
| `openQuestions[]` | no | 12 entries × 300 chars |
| `references[]` | no | 20 entries |
| `references[].label` | yes | 160 chars |
| `references[].location` | yes | 200 chars, see §5 |

The schema deliberately has no field for a local artifact path: a report must be
readable without any knowledge of the machine that produced it.

## 5. Reference locations

`location` must be either a repository-relative path (optionally `:line` or
`:start-end`) or an `https` URL. Rejected — not rewritten — are absolute paths,
Windows drive letters, `~`, traversal (`..`) or `.` segments, every non-`https`
scheme (notably `file:`), whitespace, and any path segment naming the session
artifact directory or the artifact root's own directory name.

An `https` location is additionally bounded to the characters RFC 3986 permits in
a URI. The renderer publishes a location inside a code span, so a character that
could close that span early — a backtick above all, plus angle brackets, quotes,
braces, pipe, and backslash — would let the remainder of the location be read as
Markdown or HTML and restructure the comment. None of those are legal URI
characters, so the bound rejects the breakout without rejecting any real URL.
Everything after the authority is optional, so `https://example.com`,
`https://example.com:8443`, and `https://example.com?source=x` are as
publishable as a deep link.

`@` is excluded from the authority — and only from the authority, since it is an
ordinary path character (`https://example.com/@scope/pkg` is fine). Its one use
before the host is RFC 3986 userinfo (`https://user:password@host/x`), a
credential no shape-based redactor recognises, so that form is rejected outright:
a reference that needs a password to resolve is not one a reader of the Issue can
follow anyway.

Rejection rather than redaction is deliberate for those forms: a reference whose
*structure* the runner had to rewrite is no longer a reference, and silently
dropping it would leave the report claiming support it cannot show.

A location is nevertheless agent-authored text, so credential redaction (§6
step 2) applies to it like to every other field, and the location is both
validated and published in its redacted form. A repository-relative location
containing a credential shape therefore fails closed — `[redacted]` introduces
brackets a repository path may not contain — while an `https` URL carrying a
token is published with the token redacted.

A URL query or fragment parameter carries one credential channel the shape-based
redactors cannot see: `?access_token=…`, `?api-key=…`, `#id_token=…`, and `?sig=…`
are opaque values with no recognisable form, so they are redacted by *parameter
name* before validation, leaving the rest of the location intact. The name test is
deliberately eager in both directions — any name containing `token`, `secret`,
`password`, `credential`, or `signature`, and any name ending in a key-ish word
(`apikey`, `accesskey`, `auth`, `sig`, `pwd`, …). Over-redacting costs one query
parameter of a citation; under-redacting publishes a live credential.

Both halves of that redaction are chosen so a credential cannot be split out of
its own parameter:

- **Names are tested after decoding.** A name is percent-decoded (and `+`
  un-escaped) repeatedly, to a bounded depth, and tested at every decoding
  stage, so `?api%6Bey=…` is recognised exactly like `?api-key=…`.
- **Values are cut at guaranteed boundaries only.** A credential value is
  redacted through to the next `&` or the query/fragment boundary. A later `?`,
  a `;`, or a `,` is ordinary value data, so ending a value there would publish
  its tail as an unrecognised suffix (`?access_token=first;second`). Those same
  characters *are* used for detection — a `;name=` inside a value is treated as
  a credential name candidate — which can only redact more of one URL, never
  less.

## 5.1 Publication requires an explicit operator acknowledgment

**Every research run is untrusted by provenance.** A research run exists because
a GitHub Issue asked for it, and everything an Issue carries is written by
whoever can file or edit it. The gate is therefore a property of *where the run
came from*, not of which fields reached the prompt: there is no trusted shape of
Issue-originated run.

So under `sanitized_summary` the report is built, sanitized, and written to
`research-publication.json`, but it stays **local** and the Issue receives the
same fixed "recorded locally" status as under `local_only` — unless
`allowUntrustedInputs` is literally `true`.

The reason is a bound on what deterministic validation can prove. It bounds the
report's *structure* — closed schema, field lengths, path and credential shapes,
Markdown safety. It cannot establish its *provenance*. An Issue can steer the
agent into placing a repository or local secret inside a perfectly well-formed
`summary`, and known-pattern redaction only recognizes the shapes it knows: an
arbitrary or unknown secret in AI-authored prose is indistinguishable from the
prose around it.

This is deliberately **not** a field-by-field trust checklist. Enumerating which
work-item fields (title, body, labels, comments, …) count as untrusted has to be
exhaustive to be sound, and it decays silently: the next value interpolated into
the prompt would open the channel without anyone touching the gate. The
provenance rule has nothing to keep in sync, and the checklist must not be
reintroduced or extended.

Turning the flag on is an **acceptance**, not a safety claim. The operator is
stating that, for this session, a bounded validated report may be published even
though deterministic validation and known-pattern redaction cannot guarantee the
removal of arbitrary or unknown secrets from AI-authored prose. Every other
protection stays in force: raw output is still never published, and absolute
local paths, known credential shapes, closing keywords, malformed Markdown,
unsupported fields, and the size limits are still redacted or rejected (§4, §6).

An operator who accepts that risk for a session says so explicitly:

```jsonc
{
  "research": {
    "publication": {
      "mode": "sanitized_summary",
      "allowUntrustedInputs": true
    }
  }
}
```

Only a literal `true` counts. `session.research.publication.allowUntrustedInputs`
is the trusted approval the publication channel needs; without it, the useful
repository-backed path produces a locally reviewable report rather than a
published one, and the single withheld reason (`untrusted-provenance`) is
recorded in `research-publication.json` and in `research-result.json`. The fixed
comment names that reason in public-safe wording from a closed table — a fixed
literal, never an echo of the Issue that caused it.

## 6. Sanitization

Every agent-authored string passes through a fixed pipeline before it can be
rendered:

1. **HTML escaping** (`escapeRawHtml`) — every `<` outside a code span or fenced
   block becomes `&lt;`, which renders as a literal `<`, so agent text cannot
   open a tag or an HTML comment. It runs first, before any runner-owned
   placeholder has been substituted in, so only agent-authored angle brackets
   are escaped;
2. **credential redaction** (`redactTokens` + `redactApiKeys`) — credential
   shapes go before path redaction, so the latter cannot split a credential into
   an unrecognizable remnant. `redactTokens` alone assumes a `token`/`Bearer`
   introducer or a GitHub-shaped value, which fits CLI stderr; a publication
   field is prose the agent *composed*, so `redactApiKeys` additionally covers
   the standalone vendor shapes (`sk-…`, `AKIA…`, `AIza…`, `xox?-…`, `glpat-…`,
   `npm_…`, JWTs) and `secret = value` assignment forms an agent can name in a
   sentence with no introducer at all;
3. **path redaction** (`sanitizeBody`) — absolute local paths, using the
   built-in heuristics plus `session.repoRoot`, `session.artifactRoot`, and the
   run directory, become `<path>`;
4. **closing-keyword neutralization** (`neutralizeClosingKeywords`) —
   `fixes #12` becomes `fixes (see #12)`, so a published report can never close
   a work item as a side effect;
5. **fence repair** (`closeOpenMarkdownFences`) — an unterminated code fence is
   closed, applied per field so an unbalanced fence inside one finding cannot
   fence off the sections after it.

Steps 1 and 5 are the two halves of the same guarantee — that runner-owned
structure stays visible and stays trusted — for the HTML and the code-fence
channel respectively. Without step 1 a single unclosed `<!--` in a summary would
comment out the Findings, References, truncation note, and run-metadata blocks
the renderer appends after it, and a reader would see a report that looks
complete while the trusted structure is gone.

Single-line fields (titles, labels) additionally have newlines collapsed so they
cannot introduce structure of their own.

Rendering is runner-owned: every heading, bullet, and separator is fixed text
and agent content only ever occupies leaf positions. If the rendered report
exceeds `maxChars` it is bounded and the fence repair runs again on the bounded
text, because the per-field repair cannot know where the cut will land. The
bound covers the finished text: the truncation marker and any closing fence the
cut made necessary are counted against `maxChars`, so a published report never
exceeds the configured budget.

A report whose `summary` is empty after sanitization fails closed
(`empty-report`) rather than publishing a bare heading.

Deterministic validation is authoritative. There is no second AI reviewer or
summarizer call.

## 7. Delivery

- `research-output.md` keeps the complete raw capture, unchanged.
- `research-publication.json` holds the validated, sanitized report and the
  rendered Markdown — the same text the outbox payload carries.
- Only the rendered report enters the phase result context
  (`context.researchPublication.report`), and only when §5.1 allows publication.
  When the report is withheld, the context carries the fixed enum
  `context.researchPublicationWithheld.reason` instead — no report text — and no
  comment effect derived from it is enqueued.
- `runNextPhase` collects the comment effect and commits it together with the
  research phase transition through `completePhaseWithEffects`, so the report is
  enqueued in the same transaction as the successful transition.
- The dispatcher posts from the outbox payload. It never reopens a run artifact,
  an artifact directory, or any filesystem location at dispatch time.
- The comment's idempotency key is the existing
  `session:issue:runId:gh:comment:research:success` scheme, so a retried
  delivery cannot duplicate the public report.

Under `sanitized_summary` the raw `researchOutput` excerpt is withheld from the
result context alongside the three pre-#834 conditions: the publication path is
an explicit replacement, so once it is on, unvetted stdout has no publishing
route left and none is kept in task context.

## 8. Failure behavior

When extraction, validation, or sanitization fails:

- there is **no** fallback to raw stdout or stderr;
- the raw local artifact is preserved;
- a bounded local diagnostic is written to
  `research-publication-failure.json`, carrying a closed-vocabulary
  `failure.reason` and a content-free `failure.detail` (a field path plus an
  observed length or count) — never a fragment of the rejected envelope;
- the Issue receives a fixed public-safe status stating that research completed
  but publication validation failed;
- the phase still reports `success`, so the existing research →
  `ready_for_human` handoff runs and the completed research is not silently
  lost.

The closed failure vocabulary is: `missing-envelope`, `duplicate-envelope`,
`malformed-envelope`, `envelope-too-large`, `unsupported-field`,
`schema-invalid`, `field-too-long`, `malformed-encoding`, `invalid-location`,
`empty-report`.

## 9. Compatibility

- `local_only` preserves the current fixed-status comment and the current prompt.
- The Issue-body, evidence, and workspace-profile withholding conditions remain
  in force for raw output and are unchanged; none of them is narrowed. The
  publication channel is gated more strictly still — on the run's provenance
  (§5.1) — so enabling `sanitized_summary` alone cannot publish anything a
  `local_only` session would have withheld.
- Slack notifications receive only the same fixed safe status they received
  before — research success carries no agent-derived reason string in either
  mode.

## 10. Out of scope

- Publishing raw research stdout/stderr.
- Public-repository safety guarantees beyond the configured visibility policy.
- A second AI reviewer/summarizer call.
- Replacing the research evidence boundary (docs/research-evidence-contract.md
  remains the authoritative bound on served repository content).
