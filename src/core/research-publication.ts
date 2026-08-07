/**
 * Research Publication stage (issue #834, docs/research-publication-contract.md).
 *
 * The research runner keeps the agent's complete raw output local
 * (`research-output.md`) and withholds it from GitHub whenever the Issue body,
 * the repository-evidence channel, or the Antigravity workspace profile was in
 * play — conditions that now cover the whole useful repository-backed path, so
 * the originating Issue used to receive only "Findings recorded locally."
 *
 * This module is the separately validated channel that replaces that fixed
 * status. It is NOT a weakening of raw-output withholding: raw stdout never
 * reaches a comment through here either. What reaches GitHub is a closed-schema
 * envelope the agent emitted deliberately, re-validated and re-sanitized by
 * trusted runner code, and rendered by the runner — never a slice of the
 * surrounding transcript.
 *
 * Design rules, mirroring the evidence transport (§1.3 of
 * docs/research-evidence-contract.md):
 *
 *  - Deterministic validation is authoritative. There is no second AI call.
 *  - Everything is fail-closed: a missing, duplicated, malformed, oversized, or
 *    schema-violating envelope publishes nothing, and never falls back to raw
 *    stdout/stderr.
 *  - Failure diagnostics carry closed-vocabulary reason literals and observed
 *    lengths only — never a fragment of the rejected content.
 */

import {
  boundedExcerpt,
  closeOpenMarkdownFences,
  escapeRawHtml,
  neutralizeClosingKeywords,
  redactApiKeys,
  redactTokens,
  sanitizeBody,
} from "./text-sanitize.js";
import type { ResearchPublicationConfig } from "./session.js";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * `local_only` is the default and preserves the pre-#834 behavior exactly: no
 * prompt section, no artifact, no context field, and the existing fixed-status
 * comment. `sanitized_summary` publishes the validated report instead.
 *
 * A raw-output publication mode is deliberately absent — publishing raw agent
 * stdout is out of scope for this contract.
 */
export type ResearchPublicationMode = "local_only" | "sanitized_summary";

export interface ResolvedPublicationPolicy {
  mode: ResearchPublicationMode;
  maxChars: number;
  /**
   * Whether the operator has explicitly accepted publishing a report derived
   * from a research run, whose inputs are untrusted by provenance. See
   * {@link ResearchPublicationConfig.allowUntrustedInputs}; defaults to `false`,
   * so an operator who only sets `mode` gets the fail-closed behavior.
   */
  allowUntrustedInputs: boolean;
}

/** Default size budget for the rendered public report. */
export const DEFAULT_PUBLICATION_MAX_CHARS = 12_000;

/** Hard ceiling on `maxChars`, independent of configuration. */
export const PUBLICATION_MAX_CHARS_CEILING = 60_000;

/** Floor below which a configured `maxChars` cannot render a useful report. */
export const PUBLICATION_MAX_CHARS_FLOOR = 500;

/**
 * Resolve the session publication policy, failing closed to `local_only`.
 *
 * An unrecognized `mode` (a typo, or a mode from a newer configuration) is not
 * an error that stops the research run — it resolves to the conservative
 * default, so a misconfiguration can never publish more than it was meant to.
 */
export function resolvePublicationPolicy(cfg: ResearchPublicationConfig | undefined): ResolvedPublicationPolicy {
  const mode: ResearchPublicationMode = cfg?.mode === "sanitized_summary" ? "sanitized_summary" : "local_only";
  const configured = cfg?.maxChars;
  const maxChars =
    typeof configured === "number" && Number.isFinite(configured) && Number.isInteger(configured)
      ? Math.max(PUBLICATION_MAX_CHARS_FLOOR, Math.min(PUBLICATION_MAX_CHARS_CEILING, configured))
      : DEFAULT_PUBLICATION_MAX_CHARS;
  // Strict `true` only: an absent, truthy-but-not-boolean, or misspelled value
  // is not an acknowledgment.
  const allowUntrustedInputs = cfg?.allowUntrustedInputs === true;
  return { mode, maxChars, allowUntrustedInputs };
}

/**
 * Why a validated report stays local even though `sanitized_summary` is on.
 *
 * There is exactly one reason, and it is a property of the run rather than of
 * any field inside it. A research run exists because a GitHub Issue asked for
 * it, and everything an Issue carries is written by whoever can file or edit it.
 * So the run is untrusted **by provenance**: the question is never which field
 * reached the prompt, it is that the work item defined the task at all.
 *
 * Publication is a channel for content the agent composed, and the agent is only
 * as trustworthy as what it was fed. The same steering that makes raw stdout
 * unpublishable reaches the envelope too: an Issue can simply tell the agent to
 * put a secret in `summary`, and no closed schema or shape-based redactor can
 * tell an unpatterned secret from prose. Deterministic validation bounds the
 * report's STRUCTURE; it cannot vouch for its PROVENANCE.
 *
 * Enumerating trusted fields is deliberately NOT how this gate works. A
 * field-by-field checklist has to be complete to be sound, and it silently
 * decays as the prompt grows — a newly interpolated work-item value would open
 * the channel without anyone editing the gate. The provenance rule has nothing
 * to keep in sync.
 *
 * The operator opens the channel explicitly with `allowUntrustedInputs`, which
 * is an acceptance that deterministic validation and known-pattern redaction
 * cannot guarantee the removal of arbitrary or unknown secrets from AI-authored
 * prose — not a claim that the inputs were safe.
 */
export type PublicationWithholdReason = "untrusted-provenance";

/**
 * `null` when the operator has accepted untrusted inputs for this session, and
 * the single provenance reason otherwise.
 *
 * There is no per-run input to inspect: every research run is Issue-originated,
 * so the acknowledgment is the only thing that can distinguish a publishable run
 * from a withheld one.
 */
export function publicationWithholdReason(
  policy: Pick<ResolvedPublicationPolicy, "allowUntrustedInputs">,
): PublicationWithholdReason | null {
  return policy.allowUntrustedInputs === true ? null : "untrusted-provenance";
}

/**
 * Public-safe phrasing for the withholding reason, used by the fixed
 * "recorded locally" comment.
 *
 * A fixed literal keyed by a closed vocabulary — no run detail, and nothing
 * derived from the untrusted work item that the run came from.
 */
export const PUBLICATION_WITHHOLD_PHRASES: Record<PublicationWithholdReason, string> = {
  "untrusted-provenance":
    "the run originated from a GitHub Issue, so its inputs are untrusted and publication was not "
    + "explicitly enabled for this session",
};

// ---------------------------------------------------------------------------
// Envelope markers and bounds
// ---------------------------------------------------------------------------

export const RESEARCH_PUBLICATION_MARKER = "<<<RESEARCH_PUBLICATION>>>";
export const RESEARCH_PUBLICATION_END_MARKER = "<<<END_RESEARCH_PUBLICATION>>>";

/**
 * The fixed public-safe status published when research succeeded but its
 * publication envelope could not be validated (§Failure behavior).
 *
 * Fixed literals only — no reason code, no field path, no observed length, and
 * above all no fragment of the rejected envelope. The reason vocabulary is
 * closed and content-free, but it names runner internals an Issue reader cannot
 * act on, so it stays in the local diagnostic beside the raw capture.
 */
export const RESEARCH_PUBLICATION_FAILED_STATUS =
  "The agent's publication result did not pass validation, so no report was published here. "
  + "The full findings were preserved in the local run artifacts for review.";

/** Maximum size of the JSON payload between the markers. */
export const PUBLICATION_ENVELOPE_MAX_BYTES = 64 * 1024;

export const MAX_TITLE_LENGTH = 160;
export const MAX_SUMMARY_LENGTH = 4_000;
export const MAX_RECOMMENDATION_LENGTH = 2_000;
export const MAX_FINDINGS = 12;
export const MAX_FINDING_TITLE_LENGTH = 160;
export const MAX_FINDING_DETAIL_LENGTH = 800;
export const MAX_REFERENCES = 20;
export const MAX_REFERENCE_LABEL_LENGTH = 160;
export const MAX_REFERENCE_LOCATION_LENGTH = 200;
export const MAX_OPEN_QUESTIONS = 12;
export const MAX_OPEN_QUESTION_LENGTH = 300;

// ---------------------------------------------------------------------------
// Report schema
// ---------------------------------------------------------------------------

export type FindingConfidence = "high" | "medium" | "low";

export interface PublicationFinding {
  title: string;
  detail: string;
  confidence?: FindingConfidence;
}

export interface PublicationReference {
  label: string;
  /** Repository-relative path (optionally `:line` / `:start-end`) or an https URL. */
  location: string;
}

export interface ResearchPublicationReport {
  title?: string;
  summary: string;
  findings: PublicationFinding[];
  recommendation?: string;
  openQuestions: string[];
  references: PublicationReference[];
}

/**
 * Closed failure vocabulary. Every literal is fixed text chosen by this module,
 * so a reason may be recorded locally and (in its rendered form) republished
 * without carrying agent content.
 */
export type PublicationFailureReason =
  | "missing-envelope"
  | "duplicate-envelope"
  | "malformed-envelope"
  | "envelope-too-large"
  | "unsupported-field"
  | "schema-invalid"
  | "field-too-long"
  | "malformed-encoding"
  | "invalid-location"
  | "empty-report";

export interface PublicationFailure {
  reason: PublicationFailureReason;
  /**
   * Content-free locator: a field path plus, where relevant, an observed length
   * or count. Never a fragment of the rejected value.
   */
  detail: string | null;
}

export type ResearchPublicationOutcome =
  | {
      ok: true;
      report: ResearchPublicationReport;
      /** The rendered, sanitized, bounded Markdown that may be published. */
      markdown: string;
      /** Whether rendering hit the policy `maxChars` bound. */
      truncated: boolean;
    }
  | { ok: false; failure: PublicationFailure };

// ---------------------------------------------------------------------------
// Envelope extraction
// ---------------------------------------------------------------------------

export type ExtractedEnvelope =
  | { kind: "payload"; payload: string }
  | { kind: "failure"; failure: PublicationFailure };

/** Markers are recognized only as whole lines; a CRLF-producing CLI is tolerated. */
function isMarkerLine(line: string, marker: string): boolean {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  return trimmed === marker;
}

/**
 * Extract the single publication envelope from agent output.
 *
 * Unlike the evidence request protocol (where the last well-formed block wins),
 * a second block is a hard failure: the two could disagree, and "publish the
 * last one" would let trailing chatter that merely looks like an envelope
 * displace the real report. Exactly one, or nothing is published.
 *
 * The whole output is scanned rather than a trailing window, so a duplicate
 * emitted early is still seen.
 */
export function extractPublicationEnvelope(stdout: string): ExtractedEnvelope {
  const lines = stdout.split("\n");
  const payloads: string[] = [];
  let open: string[] | null = null;
  for (const line of lines) {
    if (open === null) {
      if (isMarkerLine(line, RESEARCH_PUBLICATION_MARKER)) open = [];
      // A stray end marker outside a block is chatter, not a block.
      continue;
    }
    if (isMarkerLine(line, RESEARCH_PUBLICATION_END_MARKER)) {
      payloads.push(open.join("\n"));
      open = null;
      continue;
    }
    // A second opening marker inside an open block cannot be a nested block —
    // the first block was never terminated.
    if (isMarkerLine(line, RESEARCH_PUBLICATION_MARKER)) {
      return { kind: "failure", failure: { reason: "malformed-envelope", detail: "unterminated-block" } };
    }
    open.push(line);
  }
  if (open !== null) {
    return { kind: "failure", failure: { reason: "malformed-envelope", detail: "unterminated-block" } };
  }
  if (payloads.length === 0) {
    return { kind: "failure", failure: { reason: "missing-envelope", detail: null } };
  }
  if (payloads.length > 1) {
    return { kind: "failure", failure: { reason: "duplicate-envelope", detail: `blocks:${payloads.length}` } };
  }
  const payload = payloads[0]!;
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > PUBLICATION_ENVELOPE_MAX_BYTES) {
    return { kind: "failure", failure: { reason: "envelope-too-large", detail: `bytes:${bytes}` } };
  }
  return { kind: "payload", payload };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const ROOT_FIELDS = new Set(["publication"]);
const PUBLICATION_FIELDS = new Set([
  "version",
  "title",
  "summary",
  "findings",
  "recommendation",
  "openQuestions",
  "references",
]);
const FINDING_FIELDS = new Set(["title", "detail", "confidence"]);
const REFERENCE_FIELDS = new Set(["label", "location"]);

/**
 * Reject text the runner cannot safely re-encode: NUL and other C0/C1 control
 * characters (which can corrupt a stored payload or hide content from a human
 * reviewer) and lone surrogates (which do not survive a UTF-8 round trip).
 *
 * Written as a code-point scan rather than a character-class regex so no
 * control byte has to appear in this source file.
 */
function hasMalformedEncoding(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // C0 controls other than tab (0x09), LF (0x0a), and CR (0x0d).
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
    // DEL plus the C1 range.
    if (code >= 0x7f && code <= 0x9f) return true;
    // A high surrogate must be followed by a low one, and a low surrogate must
    // be preceded by a high one; anything else is an unpaired surrogate.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

class SchemaError extends Error {
  constructor(readonly failure: PublicationFailure) {
    super(failure.reason);
  }
}

function fail(reason: PublicationFailureReason, detail: string | null): never {
  throw new SchemaError({ reason, detail });
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("schema-invalid", `${path}:not-an-object`);
  return value as Record<string, unknown>;
}

function requireClosedFields(obj: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(obj)) {
    // The unknown key is agent-chosen text, so only its position is recorded.
    if (!allowed.has(key)) fail("unsupported-field", path);
  }
}

function requireString(value: unknown, path: string, max: number, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) fail("schema-invalid", `${path}:required`);
    return undefined;
  }
  if (typeof value !== "string") fail("schema-invalid", `${path}:not-a-string`);
  if (hasMalformedEncoding(value)) fail("malformed-encoding", path);
  if (value.length > max) fail("field-too-long", `${path}:${value.length}`);
  return value;
}

function requireArray(value: unknown, path: string, max: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("schema-invalid", `${path}:not-an-array`);
  if (value.length > max) fail("field-too-long", `${path}:${value.length}`);
  return value;
}

/**
 * An https location, restricted to the characters RFC 3986 permits in a URI.
 *
 * The renderer wraps a location in a code span, so the character set has to
 * exclude every delimiter that could close that span early and let the rest of
 * the location be read as Markdown or HTML — a backtick above all, plus angle
 * brackets, quotes, braces, pipe, and backslash. None of them are legal URI
 * characters, so bounding the set to RFC 3986 rejects the breakout without
 * rejecting any real URL.
 *
 * `[` and `]` stay inside the set: credential redaction leaves `[redacted]` behind and
 * validation runs against that redacted form, so an https URL whose query
 * carried a token still has to validate afterwards.
 *
 * `@` is excluded from the authority — and only from the authority, since it is
 * an ordinary path character. Its sole use before the host is RFC 3986 userinfo
 * (`https://user:password@host/x`), which is a credential no redactor keyed on
 * token *shape* would recognise, so the form is rejected outright rather than
 * rewritten: a reference that needs a password to resolve is not a reference a
 * reader of the Issue can follow anyway.
 *
 * Everything after the authority is optional, so a root reference
 * (`https://example.com`, `https://example.com:8443`) is as publishable as a
 * deep link. One unpublishable reference rejects the whole envelope, so an
 * over-strict shape rule costs a real report, not just its citation.
 */
const HTTPS_LOCATION_RE =
  /^https:\/\/[A-Za-z0-9._~%!$&'()*+,;=:[\]-]+(?:[\/?#][A-Za-z0-9._~%!$&'()*+,;=:@[\]\/?#-]*)?$/;

/**
 * A source reference must be resolvable by a reader of the Issue without any
 * knowledge of this machine: a repository-relative path or an https URL.
 *
 * Absolute paths, drive letters, `~`, traversal segments, and every non-https
 * scheme (notably `file:`) are rejected rather than redacted — a reference the
 * runner had to rewrite is no longer a reference, and silently dropping it
 * would leave the report claiming support it cannot show.
 *
 * The caller passes the credential-redacted location (see
 * {@link redactLocationCredentials}), not the raw one: a location is
 * agent-authored text like every other field, so a credential shape inside it
 * must never be published verbatim. Redaction leaves `[redacted]` behind, whose
 * brackets are outside the repository-path character set, so a repo-relative
 * location carrying a token fails here instead of being published half-rewritten.
 */
function isPublishableLocation(location: string, deniedSegments: readonly string[]): boolean {
  if (location.length === 0) return false;
  if (/\s/.test(location)) return false;
  if (HTTPS_LOCATION_RE.test(location)) return true;
  // Any other scheme (http:, file:, javascript:, or a Windows drive letter).
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(location)) return false;
  if (location.startsWith("/") || location.startsWith("\\") || location.startsWith("~")) return false;
  if (!/^[A-Za-z0-9._/-]+(?::\d+(?:-\d+)?)?$/.test(location)) return false;
  const segments = location.replace(/:\d+(?:-\d+)?$/, "").split("/");
  if (segments.includes("..") || segments.includes(".")) return false;
  return !segments.some((segment) => deniedSegments.includes(segment));
}

interface ValidateOptions {
  /** Path segments that name an artifact/run directory and may never be cited. */
  deniedSegments: readonly string[];
}

/**
 * Validate the parsed envelope against the closed schema.
 *
 * Structure only: no sanitization happens here, so a caller can record exactly
 * what the agent claimed before the text transforms run.
 */
function validateReport(parsed: unknown, opts: ValidateOptions): ResearchPublicationReport {
  const root = requireObject(parsed, "root");
  requireClosedFields(root, ROOT_FIELDS, "root");
  const publication = root["publication"];
  if (publication === undefined) fail("schema-invalid", "root.publication:required");
  const pub = requireObject(publication, "publication");
  requireClosedFields(pub, PUBLICATION_FIELDS, "publication");

  const version = pub["version"];
  if (version !== undefined && version !== 1) fail("schema-invalid", "publication.version:unsupported");

  const title = requireString(pub["title"], "publication.title", MAX_TITLE_LENGTH, false);
  const summary = requireString(pub["summary"], "publication.summary", MAX_SUMMARY_LENGTH, true)!;
  const recommendation = requireString(
    pub["recommendation"], "publication.recommendation", MAX_RECOMMENDATION_LENGTH, false,
  );

  const rawFindings = requireArray(pub["findings"], "publication.findings", MAX_FINDINGS);
  const findings: PublicationFinding[] = rawFindings.map((raw, i) => {
    const obj = requireObject(raw, `publication.findings[${i}]`);
    requireClosedFields(obj, FINDING_FIELDS, `publication.findings[${i}]`);
    const fTitle = requireString(obj["title"], `publication.findings[${i}].title`, MAX_FINDING_TITLE_LENGTH, true)!;
    const detail = requireString(obj["detail"], `publication.findings[${i}].detail`, MAX_FINDING_DETAIL_LENGTH, true)!;
    const confidence = obj["confidence"];
    if (confidence !== undefined && confidence !== "high" && confidence !== "medium" && confidence !== "low") {
      fail("schema-invalid", `publication.findings[${i}].confidence:unsupported`);
    }
    return {
      title: fTitle,
      detail,
      ...(confidence !== undefined ? { confidence: confidence as FindingConfidence } : {}),
    };
  });

  const rawQuestions = requireArray(pub["openQuestions"], "publication.openQuestions", MAX_OPEN_QUESTIONS);
  const openQuestions = rawQuestions.map(
    (raw, i) => requireString(raw, `publication.openQuestions[${i}]`, MAX_OPEN_QUESTION_LENGTH, true)!,
  );

  const rawReferences = requireArray(pub["references"], "publication.references", MAX_REFERENCES);
  const references: PublicationReference[] = rawReferences.map((raw, i) => {
    const obj = requireObject(raw, `publication.references[${i}]`);
    requireClosedFields(obj, REFERENCE_FIELDS, `publication.references[${i}]`);
    const label = requireString(obj["label"], `publication.references[${i}].label`, MAX_REFERENCE_LABEL_LENGTH, true)!;
    const location = requireString(
      obj["location"], `publication.references[${i}].location`, MAX_REFERENCE_LOCATION_LENGTH, true,
    )!;
    // Validated in its redacted form — the same form `sanitizeReport` renders —
    // so a location can never publish a credential shape or a named query
    // credential, and an https URL whose token was redacted still has to look
    // like an https URL afterwards.
    if (!isPublishableLocation(redactLocationCredentials(location), opts.deniedSegments)) {
      fail("invalid-location", `publication.references[${i}].location`);
    }
    return { label, location };
  });

  return {
    ...(title !== undefined ? { title } : {}),
    summary,
    findings,
    ...(recommendation !== undefined ? { recommendation } : {}),
    openQuestions,
    references,
  };
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Credential redaction for publishable text: the shared dispatch-error
 * redactor plus the standalone vendor key shapes it does not reach.
 *
 * `redactTokens` alone assumes a `token`/`Bearer` introducer or a GitHub-shaped
 * value, which fits CLI stderr. A publication field is prose the agent
 * *composed*, so a key it read out of a config file can appear bare in a
 * sentence; `redactApiKeys` covers those shapes.
 */
function redactCredentials(text: string): string {
  return redactApiKeys(redactTokens(text));
}

/**
 * Does a URL query/fragment parameter name a credential?
 *
 * Matched on the name rather than the value because a query token
 * (`?access_token=…`, `#id_token=…`, `?sig=…`) has no recognisable shape of its
 * own — it is opaque bytes, so the only reliable signal is what the parameter
 * is called. Punctuation is stripped first so `access_token`, `access-token`,
 * and `accessToken` normalise to one form.
 *
 * Deliberately eager, in both directions: any name *containing* a secret word
 * matches, and a name merely *ending* in a key-ish word does too. Over-redacting
 * a location costs one query parameter of a citation; under-redacting publishes
 * a live credential to a GitHub Issue.
 */
function isCredentialQueryKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  if (/(token|secret|password|passwd|credential|signature)/.test(normalized)) return true;
  return /(apikey|accesskey|authkey|privatekey|sessionkey|auth|sig|pwd)$/.test(normalized);
}

/** How many nested percent-decodings a parameter name is tested through. */
const MAX_PARAM_NAME_DECODES = 3;

/**
 * Every form a parameter name may be read in, so the credential test cannot be
 * evaded by encoding it.
 *
 * A raw name is percent-encodable byte by byte (`api%6Bey` is `apikey` to every
 * URL consumer, but not to a literal string test), and `+` is a space in form
 * encoding. Both are undone here, repeatedly — a doubly-encoded name decodes to
 * a singly-encoded one — and each intermediate form is returned, so a name that
 * looks like a credential at ANY decoding depth is caught. Decoding stops at the
 * first malformed escape rather than throwing: a name that cannot be decoded is
 * still tested in the forms reached so far.
 */
function paramNameForms(rawName: string): readonly string[] {
  const forms = [rawName];
  let current = rawName;
  for (let depth = 0; depth < MAX_PARAM_NAME_DECODES; depth += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current.replace(/\+/g, " "));
    } catch {
      break;
    }
    if (next === current) break;
    forms.push(next);
    current = next;
  }
  return forms;
}

/**
 * Does a single `&`-delimited parameter carry a credential?
 *
 * Detection is deliberately looser than the value boundary used to redact it.
 * `&` and the query/fragment boundary are the only delimiters a URL guarantees,
 * but a server may still split on `;` or `,`, so a `;access_token=…` sitting
 * *inside* another parameter's value is treated as a credential name too. Being
 * loose here only ever redacts more of one citation URL; being loose about
 * where the value ENDS would publish the tail of a live credential, which is
 * exactly the failure this split avoids.
 */
function partNamesCredential(part: string): boolean {
  for (const candidate of part.split(/[;,]/)) {
    const eq = candidate.indexOf("=");
    if (eq <= 0) continue;
    const name = candidate.slice(0, eq);
    if (paramNameForms(name).some(isCredentialQueryKey)) return true;
  }
  return false;
}

/**
 * Redact credential parameters in one query or fragment section (the leading
 * `?`/`#` already stripped).
 *
 * Splitting on `&` alone is what makes the redaction complete: a recognized
 * credential value is replaced through to the next `&`, so no unrecognized
 * suffix of it (`?access_token=first;second`) survives into the published URL.
 */
function redactCredentialParams(section: string): string {
  return section
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) return part;
      if (part.length === eq + 1) return part; // `name=` — nothing to redact
      return partNamesCredential(part) ? `${part.slice(0, eq)}=[redacted]` : part;
    })
    .join("&");
}

/**
 * Credential redaction for a reference location.
 *
 * A location is a URL, so it carries two credential channels that prose does
 * not, and neither is keyed on the value's shape:
 *
 *  - userinfo (`https://user:password@host`) — rejected by
 *    {@link HTTPS_LOCATION_RE}, not rewritten, so nothing to do here;
 *  - query/fragment parameters (`?access_token=…`) — redacted by name here,
 *    before {@link redactCredentials} gets its shape-based pass at the rest.
 *
 * Redaction runs before validation, so the `[redacted]` placeholder — whose
 * brackets are inside the https character set but outside the repository-path
 * one — is what {@link isPublishableLocation} judges, exactly as it is for the
 * shape-based redactors.
 */
function redactLocationCredentials(location: string): string {
  const marker = location.search(/[?#]/);
  if (marker < 0) return redactCredentials(location);
  const head = location.slice(0, marker);
  const rest = location.slice(marker);

  // The query runs from its `?` to the FIRST `#`, and the fragment runs from
  // that `#` to the end. Those two boundaries plus `&` are the only delimiters
  // a URL actually guarantees: a later `?`, a `;`, or a `,` is ordinary value
  // data, so treating one as a separator would end a credential value early and
  // publish the remainder of it as an unrecognized suffix.
  const fragmentStart = rest.indexOf("#");
  const query = fragmentStart < 0 ? rest : rest.slice(0, fragmentStart);
  const fragment = fragmentStart < 0 ? "" : rest.slice(fragmentStart);
  // A non-empty `query` always starts with `?` here: `rest` begins at the first
  // `?`-or-`#`, and a leading `#` puts the whole of `rest` in the fragment.
  const redactedQuery = query.length > 0 ? "?" + redactCredentialParams(query.slice(1)) : "";
  const redactedFragment = fragment.length > 0 ? "#" + redactCredentialParams(fragment.slice(1)) : "";

  return redactCredentials(head + redactedQuery + redactedFragment);
}

/**
 * The transform every agent-authored string passes through before it can be
 * rendered, in a fixed order:
 *
 *  1. HTML escaping — `<` outside code becomes `&lt;`, so agent text cannot
 *     open a tag or an HTML comment. It runs first, before any runner-owned
 *     placeholder (`<path>`) has been substituted in, so only agent-authored
 *     angle brackets are escaped;
 *  2. credential redaction — token and API-key shapes go before path redaction,
 *     so the latter cannot split a credential into an unrecognizable remnant;
 *  3. path redaction — absolute local paths (built-in heuristics plus the
 *     session's configured roots) become `<path>`;
 *  4. closing-keyword neutralization — quoted `fixes #12` never closes an Issue;
 *  5. fence repair — an unterminated code fence cannot fence off the rest of
 *     the comment.
 *
 * Steps 1 and 5 are the two halves of the same guarantee — that runner-owned
 * structure stays visible and stays trusted — for the HTML and the code-fence
 * channel respectively. Both are applied per field rather than once at the end,
 * so an unbalanced fence or an unclosed comment inside one finding cannot
 * swallow the sections after it.
 */
function sanitizeField(text: string, configuredPaths: readonly string[]): string {
  const redacted = neutralizeClosingKeywords(
    sanitizeBody(redactCredentials(escapeRawHtml(text)), [...configuredPaths]),
  );
  return closeOpenMarkdownFences(redacted).trim();
}

/** Single-line fields (titles, labels) must not introduce structure of their own. */
function sanitizeInline(text: string, configuredPaths: readonly string[]): string {
  return neutralizeClosingKeywords(sanitizeBody(redactCredentials(escapeRawHtml(text)), [...configuredPaths]))
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function sanitizeReport(
  report: ResearchPublicationReport,
  configuredPaths: readonly string[],
): ResearchPublicationReport {
  const title = report.title !== undefined ? sanitizeInline(report.title, configuredPaths) : undefined;
  const recommendation =
    report.recommendation !== undefined ? sanitizeField(report.recommendation, configuredPaths) : undefined;
  return {
    ...(title ? { title } : {}),
    summary: sanitizeField(report.summary, configuredPaths),
    findings: report.findings.map((f) => ({
      title: sanitizeInline(f.title, configuredPaths),
      detail: sanitizeField(f.detail, configuredPaths),
      ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
    })),
    ...(recommendation ? { recommendation } : {}),
    openQuestions: report.openQuestions.map((q) => sanitizeInline(q, configuredPaths)).filter((q) => q.length > 0),
    // A location's structure is validated, never rewritten (see
    // isPublishableLocation), but its text is agent-authored, so it still goes
    // through credential redaction — validation already ran against this same
    // redacted form, so nothing unpublishable can survive the rewrite.
    references: report.references.map((r) => ({
      label: sanitizeInline(r.label, configuredPaths),
      location: redactLocationCredentials(r.location),
    })),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the sanitized report as the Markdown body published to the Issue.
 *
 * Every heading, bullet, and separator is fixed runner-owned text; agent
 * content only ever occupies leaf positions. Reference locations are rendered
 * as code spans so a repo-relative path cannot be mistaken for a link.
 */
export function renderPublicationMarkdown(report: ResearchPublicationReport): string {
  const parts: string[] = [];
  if (report.title) parts.push(`### ${report.title}`);
  parts.push(report.summary);
  if (report.findings.length > 0) {
    const rendered = report.findings.map((f) => {
      const confidence = f.confidence ? ` _(confidence: ${f.confidence})_` : "";
      return `- **${f.title}**${confidence}\n\n  ${f.detail.split("\n").join("\n  ")}`;
    });
    parts.push(`#### Findings\n\n${rendered.join("\n\n")}`);
  }
  if (report.recommendation) parts.push(`#### Recommendation\n\n${report.recommendation}`);
  if (report.openQuestions.length > 0) {
    parts.push(`#### Open questions\n\n${report.openQuestions.map((q) => `- ${q}`).join("\n")}`);
  }
  if (report.references.length > 0) {
    parts.push(
      `#### References\n\n${report.references.map((r) => `- ${r.label} — \`${r.location}\``).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

/**
 * Bound the rendered report to `maxChars` including everything bounding itself
 * adds.
 *
 * `maxChars` is a size budget the operator configured, so the published text
 * has to honour it after the transforms, not before: `boundedExcerpt` appends
 * its `…(truncated)` marker after slicing, and the fence repair below can append
 * a closing fence on top of that. Cutting at exactly `maxChars` therefore
 * overshoots. The slice point is pulled back by whatever the finished text
 * overflowed by and re-checked, which converges in a couple of passes and
 * terminates at a zero-length slice in the worst case.
 *
 * Bounding can cut inside a fenced block, so the fence repair runs on the
 * bounded text — the per-field repair in `sanitizeReport` cannot know where the
 * cut will land.
 */
function boundToMaxChars(rendered: string, maxChars: number): string {
  let slice = maxChars;
  for (;;) {
    const candidate = closeOpenMarkdownFences(boundedExcerpt(rendered, slice));
    if (candidate.length <= maxChars || slice <= 0) return candidate;
    slice = Math.max(0, slice - (candidate.length - maxChars));
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface BuildPublicationInput {
  /** The agent's findings text (evidence request blocks already stripped). */
  findingsText: string;
  maxChars: number;
  /** Absolute roots to redact, as `sessionRedactionPaths` produces them. */
  configuredPaths: readonly string[];
  /** Path segments naming artifact/run directories that may never be cited. */
  deniedLocationSegments: readonly string[];
}

/**
 * Extract, validate, sanitize, and render the publication report.
 *
 * The one function the handler calls: every failure mode returns `ok: false`
 * with a closed-vocabulary reason, and there is no path through it that yields
 * publishable text derived from anything but a well-formed envelope.
 */
export function buildResearchPublication(input: BuildPublicationInput): ResearchPublicationOutcome {
  const extracted = extractPublicationEnvelope(input.findingsText);
  if (extracted.kind === "failure") return { ok: false, failure: extracted.failure };

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.payload);
  } catch {
    return { ok: false, failure: { reason: "malformed-envelope", detail: "not-json" } };
  }

  let validated: ResearchPublicationReport;
  try {
    validated = validateReport(parsed, { deniedSegments: input.deniedLocationSegments });
  } catch (err) {
    if (err instanceof SchemaError) return { ok: false, failure: err.failure };
    throw err;
  }

  const report = sanitizeReport(validated, input.configuredPaths);
  // Sanitization can empty a field that was non-empty before it (e.g. a summary
  // that was nothing but an absolute path). A report with no summary left is
  // not a report, so it fails closed rather than publishing a bare heading.
  if (report.summary.length === 0) {
    return { ok: false, failure: { reason: "empty-report", detail: "publication.summary" } };
  }

  const rendered = renderPublicationMarkdown(report);
  const truncated = rendered.length > input.maxChars;
  const markdown = truncated ? boundToMaxChars(rendered, input.maxChars) : rendered;
  return { ok: true, report, markdown, truncated };
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

/**
 * The runner-owned prompt section that asks for the envelope.
 *
 * It lives in the Instructions section, below the delimited Issue body and the
 * statement that the body cannot override these instructions, so nothing in
 * untrusted GitHub content defines this format. Emitted only when the session
 * policy is `sanitized_summary`; under `local_only` the prompt is unchanged.
 */
export function publicationInstructions(): string {
  return [
    "",
    "## Publication Result",
    "",
    "After your normal findings, emit EXACTLY ONE publication block. Its contents are",
    "the only part of your output that may be posted to the GitHub Issue; everything",
    "else stays on the machine that ran you, and the block itself is published only",
    "when the session policy allows it. Write it for a reader who has none of your",
    "other output.",
    "",
    RESEARCH_PUBLICATION_MARKER,
    "{",
    '  "publication": {',
    '    "version": 1,',
    '    "title": "short report title",',
    '    "summary": "Markdown summary of what you established.",',
    '    "findings": [',
    '      { "title": "short finding title", "detail": "what it is and why it matters", "confidence": "high" }',
    "    ],",
    '    "recommendation": "Markdown recommendation.",',
    '    "openQuestions": ["what remains unverified"],',
    '    "references": [{ "label": "what this shows", "location": "src/example.ts:42" }]',
    "  }",
    "}",
    RESEARCH_PUBLICATION_END_MARKER,
    "",
    "Rules — a block that breaks any of them is discarded and nothing is published:",
    "- Emit the block exactly once, in your final response. Two blocks publish neither.",
    "- The payload must be valid JSON with `publication` as its only top-level key.",
    "- Use only the fields shown. An unrecognized field discards the whole block.",
    `- \`summary\` is required (at most ${MAX_SUMMARY_LENGTH} characters); \`confidence\` is one of high, medium, low.`,
    `- At most ${MAX_FINDINGS} findings, ${MAX_OPEN_QUESTIONS} open questions, and ${MAX_REFERENCES} references.`,
    "- `location` must be a repository-relative path (optionally `:line` or `:start-end`)"
    + " or an https URL — never an absolute path, a run/artifact directory, or a `file:` URL.",
    "- An https `location` must carry no credentials: no `user:password@` before the host"
    + " (that discards the block) and no token-bearing query parameter (its value is redacted).",
    "- Never include credentials, API keys, absolute filesystem paths, or local run"
    + " directories in any field; state the finding without them instead.",
    "- Write Markdown only. Raw HTML and HTML comments are escaped, so `<` outside a"
    + " code span or code block is published as literal text.",
    "- Do not write GitHub closing keywords (`fixes`, `closes`, `resolves`) before an"
    + " issue reference — this report must not close anything.",
    "- Restate what a reader needs inside the block; do not refer to local files by path.",
  ].join("\n");
}
