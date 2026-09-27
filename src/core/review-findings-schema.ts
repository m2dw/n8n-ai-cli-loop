/**
 * Issue #1068: a JSON Schema for the §2.1 finding envelope, for CLIs that accept
 * one for their final message (`codex exec --output-schema`).
 *
 * The schema is DERIVED from the domain, never authored beside it. Every enum,
 * every bound and every field name here is read from `review-dispute.ts` and
 * `review-finding-envelope.ts`, so an envelope shape that changes there changes
 * this schema in the same commit. A hand-written copy would be a second schema
 * vocabulary, and the failure mode of a second vocabulary is not a broken build —
 * it is a reviewer being told to emit a field the runner will refuse.
 *
 * ## The schema is assistance, never admission
 *
 * `docs/review-dispute-contract.md` §17.2 grades a vendor-documented mechanism as
 * documentation, never as attestation, and §17.4 C6 (`--output-schema`) is exactly
 * that. So nothing downstream may treat a response as valid *because* a schema was
 * supplied: {@link parseReviewFindingsEnvelope} is still the only admission point,
 * and it runs on every response whether or not the CLI honored the schema, whether
 * or not it claims to have. This module's whole contribution is that a cooperating
 * model is more likely to emit something admissible on the first turn.
 *
 * ## Why the optional members are nullable-and-required
 *
 * The §2.1 envelope is a discriminated union — `findings` exists only for
 * `status: "findings"`, `blockedReason` only for `status: "blocked"` — and the
 * natural encoding is `oneOf`. Structured-output implementations commonly accept
 * only a restricted JSON Schema subset in which every property of an object is
 * required and `additionalProperties` is `false`, which makes an optional member
 * inexpressible except as an explicitly nullable one. This module emits the
 * nullable-and-required form, because it is the shape both kinds of build can
 * satisfy: a strict build fills the inapplicable member with `null`, a permissive
 * one omits it. {@link stripNullEnvelopeMembers} then removes exactly those nulls
 * before the domain parser sees the payload — the domain shape is unchanged, and
 * the strict encoding never reaches admission as an `unknown-field`.
 */

import {
  ABSOLUTE_MAX_VERSION,
  FINDING_SEVERITIES,
  MAX_AFFECTED_BOUNDARY_CHARS,
  MAX_DOC_SECTION_CHARS,
  MAX_EVIDENCE_LINE,
  MAX_EVIDENCE_PATH_CHARS,
  MAX_EVIDENCE_QUOTE_CHARS,
  MAX_EVIDENCE_REFS_PER_RECORD,
  MAX_FINDING_TEXT_CHARS,
  MAX_FINDINGS_PER_REVIEW,
  MAX_TEST_NAME_CHARS,
} from "./review-dispute.js";
import {
  REVIEW_BLOCKED_REASONS,
  REVIEW_ENVELOPE_STATUSES,
  REVIEW_FINDINGS_ENVELOPE_VERSION,
} from "./review-finding-envelope.js";

/**
 * The schema's name, for a CLI that wants one alongside the document.
 *
 * Snake case because that is what the structured-output APIs behind these CLIs
 * accept as a schema name; it is not a protocol identifier and nothing reads it
 * back.
 */
export const REVIEW_FINDINGS_SCHEMA_NAME = "review_findings_envelope";

/** A JSON Schema document, as a plain serializable value. */
export type JsonSchema = Record<string, unknown>;

export interface ReviewFindingsSchemaOptions {
  /**
   * §3.3 evidence kinds THIS run can resolve read-only, exactly as
   * `reviewResolvableEvidenceKinds` reports them.
   *
   * A kind absent here gets no variant in the schema at all, which is the same
   * rule `reviewFindingsInstructions` follows for the prose: a reference the
   * runner cannot resolve is refused at admission and takes the whole envelope
   * with it, so the reviewer must not be able to spell one.
   */
  resolvableEvidenceKinds?: readonly string[];
  /**
   * §2.2 lineage ids a re-raise may attach to — the open lineages of this task.
   *
   * With none (the first review of a task) the `lineageId` member is absent from
   * the schema entirely, so `additionalProperties: false` refuses it: the runner
   * mints lineage ids, and an agent-invented one is rejected at admission.
   */
  liveLineageIds?: readonly string[];
}

const DEFAULT_RESOLVABLE_EVIDENCE_KINDS: readonly string[] = ["file", "doc_section"];

/**
 * One evidence-reference variant, keyed by §3.3 kind.
 *
 * Each is a closed object in its own right, so the `anyOf` below stays inside the
 * restricted subset a strict structured-output build accepts: every property
 * required, `additionalProperties` false, and the discriminator pinned by a
 * single-member enum rather than by `const` (the narrower keyword is the one more
 * builds implement).
 */
function evidenceRefVariant(kind: string): JsonSchema | null {
  switch (kind) {
    case "file":
      return {
        type: "object",
        additionalProperties: false,
        required: ["kind", "path", "startLine", "endLine"],
        properties: {
          kind: { type: "string", enum: ["file"] },
          path: {
            type: "string",
            maxLength: MAX_EVIDENCE_PATH_CHARS,
            description:
              `Repository-relative path of a tracked file, at most ${MAX_EVIDENCE_PATH_CHARS} characters. `
              + "Never absolute and never containing a `..` segment.",
          },
          startLine: {
            type: "integer",
            minimum: 1,
            maximum: MAX_EVIDENCE_LINE,
            description: "First line of the cited range, 1-based and inside the file.",
          },
          endLine: {
            type: "integer",
            minimum: 1,
            maximum: MAX_EVIDENCE_LINE,
            description: "Last line of the cited range; never before `startLine`.",
          },
        },
      };
    case "doc_section":
      return {
        type: "object",
        additionalProperties: false,
        required: ["kind", "path", "section"],
        properties: {
          kind: { type: "string", enum: ["doc_section"] },
          path: {
            type: "string",
            maxLength: MAX_EVIDENCE_PATH_CHARS,
            description:
              `Repository-relative path of a contract document under \`docs/\`, at most ${MAX_EVIDENCE_PATH_CHARS} characters.`,
          },
          section: {
            type: "string",
            maxLength: MAX_DOC_SECTION_CHARS,
            description:
              `A heading the document actually carries, at most ${MAX_DOC_SECTION_CHARS} characters.`,
          },
        },
      };
    case "issue_quote":
      return {
        type: "object",
        additionalProperties: false,
        required: ["kind", "quote"],
        properties: {
          kind: { type: "string", enum: ["issue_quote"] },
          quote: {
            type: "string",
            maxLength: MAX_EVIDENCE_QUOTE_CHARS,
            description:
              `A verbatim span of the Issue body, at most ${MAX_EVIDENCE_QUOTE_CHARS} characters.`,
          },
        },
      };
    case "test":
      return {
        type: "object",
        additionalProperties: false,
        required: ["kind", "name"],
        properties: {
          kind: { type: "string", enum: ["test"] },
          name: { type: "string", maxLength: MAX_TEST_NAME_CHARS },
        },
      };
    default:
      // An unknown kind names no §3.3 reference form, so it contributes no
      // variant rather than an empty one an agent could satisfy with anything.
      return null;
  }
}

function findingSchema(opts: Required<Pick<ReviewFindingsSchemaOptions, "resolvableEvidenceKinds" | "liveLineageIds">>): JsonSchema {
  const named = opts.resolvableEvidenceKinds
    .map((kind) => evidenceRefVariant(kind))
    .filter((variant): variant is JsonSchema => variant !== null);
  // A caller whose kinds name no §3.3 reference form would otherwise produce an
  // empty `anyOf`, which is not a valid schema in any draft. The default pair is
  // what `reviewResolvableEvidenceKinds` reports for every run, so falling back
  // to it describes a narrower envelope than the caller asked for rather than an
  // unusable one — and admission still refuses whatever the run cannot resolve.
  const variants = named.length > 0
    ? named
    : DEFAULT_RESOLVABLE_EVIDENCE_KINDS.map((kind) => evidenceRefVariant(kind)).filter(
        (variant): variant is JsonSchema => variant !== null,
      );
  const text = (description: string): JsonSchema => ({
    type: "string",
    maxLength: MAX_FINDING_TEXT_CHARS,
    description: `${description} At most ${MAX_FINDING_TEXT_CHARS} characters.`,
  });
  const attachable = opts.liveLineageIds.length > 0;
  return {
    type: "object",
    additionalProperties: false,
    required: [
      ...(attachable ? ["lineageId"] : []),
      "version",
      "severity",
      "violatedContract",
      "preconditions",
      "failureScenario",
      "affectedBoundary",
      "requiredOutcome",
      "evidenceRefs",
    ],
    properties: {
      ...(attachable
        ? {
            lineageId: {
              // Nullable rather than optional, for the reason in this module's
              // header; a `null` is stripped before admission and means "this is
              // a new finding". The enum is closed over the OPEN lineages, so an
              // id this task has no lineage for cannot be spelled at all.
              type: ["string", "null"],
              enum: [...opts.liveLineageIds, null],
              description:
                "Set ONLY when this finding is the same defect as one of the open findings listed in the "
                + "instructions, in which case `version` must be the version shown for it. `null` otherwise.",
            },
          }
        : {}),
      version: {
        type: "integer",
        minimum: 1,
        maximum: ABSOLUTE_MAX_VERSION,
        description: attachable
          ? "The number 1 for a new finding, or the recorded version of the lineage named by `lineageId`."
          : "The number 1.",
      },
      severity: {
        type: "string",
        enum: [...FINDING_SEVERITIES],
        description: "Blocking severity only; a cosmetic nit is not a finding.",
      },
      violatedContract: text(
        "The invariant, issue requirement, or acceptance criterion the diff violates, quoted or precisely named.",
      ),
      preconditions: text("The state or input assumptions under which the violation occurs."),
      failureScenario: text("Concrete inputs/state to wrong output, crash, or contract breach."),
      affectedBoundary: {
        type: "string",
        maxLength: MAX_AFFECTED_BOUNDARY_CHARS,
        description:
          "The file, module, or API surface, named repository-relative — never an absolute path. "
          + `At most ${MAX_AFFECTED_BOUNDARY_CHARS} characters.`,
      },
      requiredOutcome: text("What a correct implementation must observably do."),
      evidenceRefs: {
        type: "array",
        minItems: 1,
        maxItems: MAX_EVIDENCE_REFS_PER_RECORD,
        items: variants.length === 1 ? variants[0]! : { anyOf: variants },
        description:
          `1 to ${MAX_EVIDENCE_REFS_PER_RECORD} references. Every one is resolved against this checkout `
          + "before the finding is accepted, and a finding carrying one that does not resolve is discarded "
          + "along with the rest of the envelope.",
      },
    },
  };
}

/**
 * Build the JSON Schema for one review run's finding envelope.
 *
 * The document is freshly constructed on every call — a shared frozen constant
 * would be cheaper, but the schema depends on this run's resolvable evidence
 * kinds and open lineages, and a cached document handed to a second run would
 * offer a reviewer an evidence form that run cannot resolve.
 */
export function buildReviewFindingsJsonSchema(opts: ReviewFindingsSchemaOptions = {}): JsonSchema {
  const resolvableEvidenceKinds = opts.resolvableEvidenceKinds ?? DEFAULT_RESOLVABLE_EVIDENCE_KINDS;
  const liveLineageIds = opts.liveLineageIds ?? [];
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: REVIEW_FINDINGS_SCHEMA_NAME,
    type: "object",
    additionalProperties: false,
    // Every member is required and the two conditional ones are nullable; see
    // this module's header. The domain rule — `findings` exactly for the
    // `findings` status, `blockedReason` exactly for `blocked` — is stated in the
    // descriptions and ENFORCED by `parseReviewFindingsEnvelope`, never by this
    // document: a schema cannot be the thing that decides admission when the CLI
    // is free to ignore it.
    required: ["version", "status", "blockedReason", "findings"],
    properties: {
      version: {
        type: "integer",
        enum: [REVIEW_FINDINGS_ENVELOPE_VERSION],
        description: `The envelope schema version; the number ${REVIEW_FINDINGS_ENVELOPE_VERSION}.`,
      },
      status: {
        type: "string",
        enum: [...REVIEW_ENVELOPE_STATUSES],
        description:
          "`success` for no blocking finding, `blocked` when the review could not be completed, "
          + "`findings` for one or more blocking findings.",
      },
      blockedReason: {
        type: ["string", "null"],
        enum: [...REVIEW_BLOCKED_REASONS, null],
        description: "Required when `status` is `blocked`; `null` for every other status.",
      },
      findings: {
        type: ["array", "null"],
        minItems: 1,
        maxItems: MAX_FINDINGS_PER_REVIEW,
        items: findingSchema({ resolvableEvidenceKinds, liveLineageIds }),
        description:
          `1 to ${MAX_FINDINGS_PER_REVIEW} findings when \`status\` is \`findings\`; \`null\` for every other status.`,
      },
    },
  };
}

/** The envelope members a strict build fills with `null` rather than omitting. */
const NULLABLE_ENVELOPE_MEMBERS: readonly string[] = ["blockedReason", "findings"];

/** The finding member a strict build fills with `null` rather than omitting. */
const NULLABLE_FINDING_MEMBER = "lineageId";

/**
 * Drop the explicit `null`s a strict structured-output encoding uses where the
 * §2.1 envelope simply omits a member.
 *
 * Deliberately narrow: only the three positions this module's own schema declares
 * nullable, and only when the value is exactly `null`. Everything else — an
 * unknown key, a `null` where the domain expects a value, a `findings: null` on a
 * `findings` status — is left exactly as the agent wrote it, so
 * {@link parseReviewFindingsEnvelope} produces the authoritative §12 failure
 * rather than being handed a payload this function quietly repaired.
 *
 * A payload that is not a JSON object, that is not parseable at all, or that
 * cannot be re-serialized, is returned unchanged for the same reason: this
 * function has no failure vocabulary and must never become a second admission
 * gate — nor a way for a response to leave its caller by an exception.
 */
export function stripNullEnvelopeMembers(payload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return payload;
  const obj = parsed as Record<string, unknown>;
  let changed = false;
  for (const member of NULLABLE_ENVELOPE_MEMBERS) {
    if (Object.prototype.hasOwnProperty.call(obj, member) && obj[member] === null) {
      delete obj[member];
      changed = true;
    }
  }
  const findings = obj["findings"];
  if (Array.isArray(findings)) {
    for (const finding of findings) {
      if (finding === null || typeof finding !== "object" || Array.isArray(finding)) continue;
      const entry = finding as Record<string, unknown>;
      if (
        Object.prototype.hasOwnProperty.call(entry, NULLABLE_FINDING_MEMBER)
        && entry[NULLABLE_FINDING_MEMBER] === null
      ) {
        delete entry[NULLABLE_FINDING_MEMBER];
        changed = true;
      }
    }
  }
  // Re-serializing an unchanged payload would rewrite the agent's own bytes for
  // nothing — key order, spacing, number formatting — and the raw response
  // artifact is what an operator diffs against.
  if (!changed) return payload;
  try {
    return JSON.stringify(obj);
  } catch {
    // `JSON.parse` accepts nesting depths `JSON.stringify` cannot re-emit (it
    // recurses and can exhaust the stack), so a payload can survive the parse
    // above and still throw here. This function has no failure vocabulary, so
    // the only correct answer is the agent's own bytes: the caller's parser
    // then produces the authoritative §12 failure instead of this throwing
    // through it.
    return payload;
  }
}
