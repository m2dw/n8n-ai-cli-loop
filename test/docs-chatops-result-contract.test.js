/**
 * Structural tests for docs/chatops-result-contract.md (issue #785).
 *
 * The document is the authoritative contract for how a dispatched (or
 * never-dispatched) ChatOps comment ends up with a deterministic, bounded,
 * sanitized outcome. Issue #785 is a pure specification: no production code
 * changes with it, so these tests pin the document's own claims — the
 * closed five-kind result vocabulary, the total mapping tables, the two
 * acknowledgement-post retry regimes, the visibility pipeline it reuses
 * rather than reinvents, and the admission criteria it hands #697 — against
 * drift. They are structural only, mirroring the doc-only pin pattern
 * already used for docs/issue-refinement-contract.md (#866).
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Assertions run against a whitespace-normalized copy: the document is
// hard-wrapped prose, so a claim can straddle a line break today and be
// reflowed tomorrow. Normalizing means these tests pin what the document
// says, not how it happens to be wrapped.
function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8').replace(/\s+/g, ' ');
}

const DOC_PATH = 'docs/chatops-result-contract.md';
const doc = read(DOC_PATH);
const mapping = read('docs/chatops-operation-mapping-contract.md');
const port = read('docs/operation-dispatch-port-contract.md');
const domain = read('docs/DOMAIN.md');

describe(`${DOC_PATH} — status and scope`, () => {
  test('is marked approved design, not yet implemented', () => {
    expect(doc).toMatch(/Status: \*\*approved design, not yet implemented\*\* \(issue #785\)/);
  });

  test('names itself split part 3 of #779 and what it supersedes', () => {
    expect(doc).toMatch(/This is issue #785, split part 3 of superseded #779/);
    expect(doc).toMatch(
      /It supersedes the result\/dependency portion of #779 and of #696 \/ PR #776/,
    );
  });

  test('names every predecessor and successor it defers to, and does not redefine', () => {
    expect(doc).toMatch(/chatops-command-grammar-contract\.md.*\(#777\)/);
    expect(doc).toMatch(/chatops-comment-cursor-contract\.md.*#781/);
    expect(doc).toMatch(/chatops-execution-ledger-contract\.md.*#782/);
    expect(doc).toMatch(/chatops-operation-mapping-contract\.md.*#784/);
    expect(doc).toMatch(/#697.*this document hands a precise, checkable prerequisite/);
  });
});

describe(`${DOC_PATH} — the five-kind result vocabulary (§3)`, () => {
  test('defines exactly five closed result kinds', () => {
    expect(doc).toMatch(
      /"success"\s*\|\s*"rejection"\s*\|\s*"retryable-failure"\s*\|\s*"ambiguous-execution"\s*\|\s*"human-handoff"/,
    );
  });

  test('states retryable-failure names a failure class, not an in-flight promise', () => {
    expect(doc).toMatch(
      /"Retryable" names the \*\*failure class\*\* \(operational, not a defect in the request\), not a promise that another attempt is in flight/,
    );
  });

  test('distinguishes ambiguous-execution from human-handoff by the open question', () => {
    expect(doc).toMatch(
      /`ambiguous-execution`.*Whether the operation ran is\s*the open question/,
    );
    expect(doc).toMatch(
      /`human-handoff`.*the local disposition is already known or explicitly\s*deferred/,
    );
  });
});

describe(`${DOC_PATH} — the total mapping (§4)`, () => {
  test('all nine never-dispatched reasons map to rejection with dispatched:false', () => {
    for (const reason of [
      'unauthorized-author',
      'malformed',
      'ambiguous-edit',
      'unsupported-command',
      'unsupported-operation',
      'invalid-argument',
      'bootstrap-backlog',
      'chatops-disabled',
      'marker-comment',
    ]) {
      expect(doc).toMatch(new RegExp(`\`${reason}\` \\| \`rejection\` \\| \`false\``));
    }
  });

  test('covers every cause of ledger row 2, not just recognition refusal', () => {
    expect(doc).toMatch(
      /§7 row 2's `refuse` event fires for exactly four causes/,
    );
    expect(doc).toMatch(/the nine-member `ChatOpsUndispatchedReason`/);
  });

  test('dispatched acknowledged rows map outcome to kind exactly', () => {
    expect(doc).toMatch(/outcome `executed`.*`success`.*`true`/);
    expect(doc).toMatch(/outcome `rejected`.*`rejection`.*`true`/);
    expect(doc).toMatch(/outcome `error`.*`retryable-failure`.*`true`/);
  });

  test('ackPublication abandoned overrides to human-handoff regardless of outcome, attempt-aware', () => {
    expect(doc).toMatch(
      /`ackPublication: "abandoned"` \(any outcome\), `attempts >= 1`\s*\|\s*`human-handoff`\s*\|\s*`true`/,
    );
    expect(doc).toMatch(
      /`ackPublication: "abandoned"` \(any outcome\), `attempts === 0`\s*\|\s*`human-handoff`\s*\|\s*`false`/,
    );
  });

  test('acknowledged outcome rows are attempt-aware, including a zero-attempt success', () => {
    expect(doc).toMatch(
      /outcome `executed`, `attempts === 0`\s*\|\s*`success`\s*\|\s*`false`/,
    );
    expect(doc).toMatch(
      /outcome `rejected`, `attempts === 0`\s*\|\s*`rejection`\s*\|\s*`false`/,
    );
    expect(doc).toMatch(
      /outcome `error`, `attempts === 0`\s*\|\s*`retryable-failure`\s*\|\s*`false`/,
    );
  });

  test('ambiguous rows split into two reason families across two kinds', () => {
    expect(doc).toMatch(
      /`ambiguous`, handoff reason ∈ `\{dispatch-crash-unresolved, reconcile-inconclusive, conflicting-evidence\}`\s*\|\s*`ambiguous-execution`\s*\|\s*`true`/,
    );
    expect(doc).toMatch(
      /`ambiguous`, handoff reason ∈ `\{ledger-regression, restore-detected, witness-missing\}`, `attempts >= 1`\s*\|\s*`ambiguous-execution`\s*\|\s*`true`/,
    );
    expect(doc).toMatch(
      /`ambiguous`, handoff reason ∈ `\{ledger-regression, restore-detected, witness-missing\}`, `attempts === 0`\s*\|\s*`human-handoff`\s*\|\s*`false`/,
    );
    expect(doc).toMatch(
      /`ambiguous`, handoff reason ∈ `\{operator-escalation, ack-publication-abandoned\}`, `attempts >= 1`\s*\|\s*`human-handoff`\s*\|\s*`true`/,
    );
    expect(doc).toMatch(
      /`ambiguous`, handoff reason ∈ `\{operator-escalation, ack-publication-abandoned\}`, `attempts === 0`\s*\|\s*`human-handoff`\s*\|\s*`false`/,
    );
  });

  test('the ambiguous-state mapping is total over all eight handoff reasons', () => {
    const HANDOFF_REASONS = [
      'dispatch-crash-unresolved',
      'reconcile-inconclusive',
      'ledger-regression',
      'restore-detected',
      'witness-missing',
      'conflicting-evidence',
      'ack-publication-abandoned',
      'operator-escalation',
    ];
    for (const reason of HANDOFF_REASONS) {
      expect(doc).toMatch(new RegExp(`\`${reason}\``));
    }
    // ack-publication-abandoned is covered by the same row as operator-escalation,
    // not left out of §4.2's ambiguous-state table as an uncovered ninth combination.
    expect(doc).toMatch(
      /`ambiguous`, handoff reason ∈ `\{operator-escalation, ack-publication-abandoned\}`/,
    );
  });

  test('states dispatched is preserved and never collapsed (§4.3)', () => {
    expect(doc).toMatch(
      /`dispatched: boolean` is not decorative\. It is the field that keeps this\s*document from doing what #782 §6 explicitly forbids/,
    );
  });

  test('mapping is resolved before T1, so a mapping failure is never claimed first', () => {
    expect(doc).toMatch(
      /\*\*Mapping is resolved before T1, never after a claim\.\*\*/,
    );
    expect(doc).toMatch(
      /there is no\s*`claimed → rejected` transition a mapping failure discovered after row 1\s*could ever use/,
    );
    expect(doc).toMatch(
      /a comment whose mapping fails is never\s*`claimed` in the first place/,
    );
  });

  test('both mapping causes are recorded on the ledger row as recognition-refused', () => {
    expect(doc).toMatch(
      /Both mapping causes are recorded\s*on the ledger row itself under the literal value `"recognition-refused"`/,
    );
    expect(doc).toMatch(
      /the same `ChatOpsRefusalReason` #777's four recognition refusals use/,
    );
  });
});

describe(`${DOC_PATH} — marker gating (§5)`, () => {
  test('dispatched success, rejection, and retryable-failure get the canonical marker', () => {
    expect(doc).toMatch(
      /\*\*Dispatched \(§4\.2\)\.\*\* `success`, `rejection` \(the `acknowledged`.*and\s*`retryable-failure`/,
    );
  });

  test('undispatched rejections never produce a marker or any other reply', () => {
    expect(doc).toMatch(
      /An undispatched `rejection` \(§4\.1\) never produces this marker, or any\s*other provider-visible reply, for any of its nine reasons/,
    );
    expect(doc).toMatch(/### 10\.2 Undispatched rejections \(§4\.1\) never publish/);
  });

  test('ambiguous-execution and human-handoff never get a marker at the moment reached', () => {
    expect(doc).toMatch(
      /\*\*never get an ack marker at the\s*moment they are reached\.\*\*/,
    );
  });

  test('ack-publication-abandoned routes via the ledger row\'s own populated handoff field, plus the audit record', () => {
    expect(doc).toMatch(/\*also\* carries a\s*populated `handoff` field/);
    expect(doc).toMatch(/row 19's implementation\s*\(`src\/core\/chatops-execution-ledger\.ts`\)/);
    expect(doc).toMatch(
      /sets\s*`handoff: \{ reason: "ack-publication-abandoned", detail, fenceScope: false \}`/,
    );
    expect(doc).toMatch(/chatops\.outcome\.human-handoff/);
  });
});

describe(`${DOC_PATH} — grammar-ineligible headers (§5.1, §7.1)`, () => {
  test('pins the exact summary comment header literal', () => {
    expect(doc).toMatch(
      /CHATOPS_SUMMARY_HEADER = "ChatOps automated comment — not a\s*command"/,
    );
  });

  test('pins the exact handoff correction comment header literal', () => {
    expect(doc).toMatch(
      /CHATOPS_HANDOFF_CORRECTION_HEADER = "ChatOps automated\s*correction — not a command"/,
    );
  });

  test('grounds grammar-ineligibility in the "/" requirement, not incidental resemblance', () => {
    expect(doc).toMatch(
      /its grammar-ineligibility is\s*structural, not incidental: §2's grammar requires a candidate line to\s*begin with `\/`/,
    );
  });

  test('neither header literal begins with a slash', () => {
    const summaryHeader = doc.match(/CHATOPS_SUMMARY_HEADER = "([^"]+)"/)?.[1];
    const handoffHeader = doc.match(
      /CHATOPS_HANDOFF_CORRECTION_HEADER = "([^"]+)"/,
    )?.[1];
    expect(summaryHeader).toBeTruthy();
    expect(handoffHeader).toBeTruthy();
    expect(summaryHeader.startsWith('/')).toBe(false);
    expect(handoffHeader.startsWith('/')).toBe(false);
  });
});

describe(`${DOC_PATH} — visibility and redaction (§6)`, () => {
  test('names the reused pipeline functions rather than inventing new ones', () => {
    for (const fn of [
      'sanitizeBody',
      'redactTokens',
      'redactApiKeys',
      'neutralizeClosingKeywords',
      'escapeRawHtml',
      'enforceCommentVisibility',
    ]) {
      expect(doc).toMatch(new RegExp(fn));
    }
  });

  test('forbids OperationResult.data from ever reaching a public summary', () => {
    expect(doc).toMatch(
      /`OperationResult\.data`.*is \*\*never\*\* included in a public outcome's `summary`/,
    );
  });

  test('closes the detail-publication question #784 left open', () => {
    expect(doc).toMatch(/`invalid-argument`'s `detail` is not exempt/);
  });
});

describe(`${DOC_PATH} — event and audit metadata (§9)`, () => {
  test('reserves operationId null for any §4.1 undispatched reason, pre-recognition included', () => {
    expect(doc).toMatch(
      /operationId: string \| null; \/\/ null for any of §4\.1's nine undispatched reasons —/,
    );
    expect(doc).toMatch(
      /known whenever mapping succeeded, even if never dispatched/,
    );
    // Pre-recognition refusals never reach recognition at all, so they must be
    // covered by the null condition alongside recognition/mapping refusals —
    // not carved out as if they were required to carry an operation id.
    expect(doc).toMatch(
      /`bootstrap-backlog`, `chatops-disabled`, and `marker-comment` \(§4\.1\) never\s*even reach recognition/,
    );
  });

  test('preserves the mapped operationId for a valid pre-dispatch human-handoff', () => {
    expect(doc).toMatch(
      /every `human-handoff` at `dispatched: false` reached from a `claimed` row\s*\(§4\.2's `attempts === 0` rows\) already has a known `operationId`/,
    );
  });
});

describe(`${DOC_PATH} — acknowledgement-post retry (§10)`, () => {
  test('dispatched outcomes stay governed entirely by ledger rows 17-19', () => {
    expect(doc).toMatch(
      /Governed \*\*entirely\*\* and \*\*unchanged\*\* by\s*`docs\/chatops-execution-ledger-contract\.md` rows 17–19/,
    );
  });

  test('requires byte-identical retry content derived from the frozen T3 outcome', () => {
    expect(doc).toMatch(
      /the marker body and the `summary`\s*text \(§7\) posted on attempt \*N\+1\* are byte-identical to attempt\s*\*N\*/,
    );
  });

  test('undispatched rejections never publish, unlike dispatched rows 17-19', () => {
    expect(doc).toMatch(
      /A `rejected` row created under any of the nine §4\.1 reasons is terminal at\s*T1 with no external effect ever attempted/,
    );
    expect(doc).toMatch(/no marker \(§5\), no summary comment \(§5\.1\), and no\s*other provider-visible reply/);
  });

  test('states the rejected-row ackPublication fix is a value assignment, not a state-machine change', () => {
    expect(doc).toMatch(
      /This is a value assignment for an already-declared field,\s*fixed once in the same transaction that creates the row, not a state-machine\s*change/,
    );
  });

  test('forbids mutating ackPublication on a rejected row after creation (ledger row 23)', () => {
    expect(doc).toMatch(
      /#782 §7 row 23 refuses every event a fully terminal\s*row receives, `rejected` included, so no later transition may carry\s*`ackPublication` away from that value on the ledger row itself/,
    );
  });
});

describe(`${DOC_PATH} — row-10 crash-recovery summary (§7.1, §10.1)`, () => {
  test('names row 10 as a third ledger-synthesized summary source alongside rows 16 and 21', () => {
    expect(doc).toMatch(
      /Ledger-synthesized, no `OperationResult` ever produced \(rows 10, 16, and\s*21\)/,
    );
    expect(doc).toMatch(/Three ledger transitions commit a publishable outcome/);
  });

  test('fixes the row-10 summary sentence and reason literal', () => {
    expect(doc).toMatch(
      /"This command's outcome was\s*recovered from a provider-visible marker after an interruption; no\s*operation result was ever retained locally\."/,
    );
    expect(doc).toMatch(/the fixed literal\s*`"reconciled-from-marker"`/);
  });

  test('row 10 is always dispatched:true and never reads OperationResult', () => {
    expect(doc).toMatch(
      /dispatched.*is always `true`\s*for a row-10 disposition/,
    );
  });

  test('row 10 sets ackPublication published directly and never runs rows 17-19 for the marker', () => {
    expect(doc).toMatch(
      /Row 10 is not part\s*of this retry path at all/,
    );
    expect(doc).toMatch(
      /rows 17–19 never run for a\s*row-10 disposition/,
    );
  });

  test('row-10 summary is enqueued in the same transaction as the row-10 reconciliation write', () => {
    expect(doc).toMatch(
      /row 10's\s*`dispatching → acknowledged`/,
    );
    expect(doc).toMatch(
      /the outbox enqueue for row 10's,\s*row 16's, and row 21's fixed summary/,
    );
  });

  test('reason domains add reconciled-from-marker to rejection and retryable-failure at dispatched:true', () => {
    expect(doc).toMatch(
      /`"reconciled-from-marker"` \(row 10, fixed, always `dispatched: true` — §7\.1\)/,
    );
  });

  test('test matrix pins row-10 crash recovery coverage', () => {
    expect(doc).toMatch(/Row-10 crash recovery \(§3, §4\.2, §7\.1, §10\.1\)/);
  });
});

describe(`${DOC_PATH} — admission criteria for #697 (§12)`, () => {
  test('lists six numbered admission criteria', () => {
    for (let i = 1; i <= 6; i++) {
      expect(doc).toMatch(new RegExp(`${i}\\. \\*\\*`));
    }
  });

  test('reserves no slot for a pending/awaiting-approval status', () => {
    expect(doc).toMatch(
      /This document reserves no slot for a pending\/awaiting-approval status/,
    );
  });

  test('routes tier-gated refusals through the existing not-permitted reason', () => {
    expect(doc).toMatch(/`reason: "not-permitted"`/);
  });
});

describe(`${DOC_PATH} — reconciliation (§11)`, () => {
  test('describes all three editorial corrections it lands alongside', () => {
    expect(doc).toMatch(/docs\/DOMAIN\.md` §5 item 3\*\* gains the #784 and #785 paragraphs/);
    expect(doc).toMatch(/is corrected to "Delivered \(#784\),"/);
    expect(doc).toMatch(/is marked "Delivered \(#785\)\."/);
  });

  test('makes no GitHub Issue Relationship changes', () => {
    expect(doc).toMatch(/No GitHub Issue Relationship changes/);
  });
});

describe('cross-document reconciliation actually landed', () => {
  test('operation-dispatch-port-contract.md marks routing protection delivered by #784', () => {
    expect(port).toMatch(/\*\*Routing protection\*\*.*\*\*Delivered \(#784\)\*\*/);
    expect(port).toMatch(/chatops-operation-mapping-contract\.md.*binds each supported verb/);
  });

  test('operation-dispatch-port-contract.md marks acknowledgement publication delivered by #785', () => {
    expect(port).toMatch(
      /Acknowledgement and result publication.*\*\*Delivered \(#785\)\*\*.*chatops-result-contract\.md/,
    );
  });

  test('chatops-operation-mapping-contract.md points at the shipped filename for its successor', () => {
    expect(mapping).toMatch(/\*\*Delivered \(#785\)\*\*: `docs\/chatops-result-contract\.md`/);
  });

  test('DOMAIN.md §5 item 3 narrates both #784 and #785 as delivered', () => {
    expect(domain).toMatch(/\*\*Delivered \(#784\)\*\*: the\s*operation mapping and routing-protection layer/);
    expect(domain).toMatch(
      /\*\*Delivered \(#785\)\*\*: the result, acknowledgement, and\s*dependency contract/,
    );
    expect(domain).toMatch(/`docs\/chatops-result-contract\.md`/);
  });
});
