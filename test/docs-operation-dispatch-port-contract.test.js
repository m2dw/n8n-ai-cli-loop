/**
 * Structural tests for docs/operation-dispatch-port-contract.md (issue #783).
 *
 * The document is the boundary contract between an adapter that received an
 * untrusted event and an operation that can change durable state. A rule that
 * drifts out of the document — or out of the modules implementing it — is how
 * a comment ends up supplying a trusted field, or how an adapter quietly goes
 * back to assembling a command line, so these tests pin the claims a reader
 * must be able to rely on: the reserved-name set, the result shapes, the
 * ledger mapping table, the prohibitions, and the prerequisite statement.
 *
 * Assertions run against a whitespace-normalized copy — the document is
 * hard-wrapped prose, so a claim can straddle a line break today and be
 * reflowed tomorrow. Tables are read from the raw text instead, because their
 * rows are line-oriented.
 *
 * Deliberately reads no private-only document (docs/DOMAIN.md,
 * docs/design/**): per copybara/copy.bara.sky, a test that loads one couples
 * this file to material the public mirror never receives (issue #811).
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OPERATION_RESERVED_PARAM_NAMES } from '../dist/core/operation-port.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function raw(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

function read(rel) {
  return raw(rel).replace(/\s+/g, ' ');
}

const DOC_PATH = 'docs/operation-dispatch-port-contract.md';
const doc = read(DOC_PATH);
const docLines = raw(DOC_PATH).split('\n');
const port = read('src/core/operation-port.ts');
const binding = read('src/core/chatops-operation-dispatch.ts');

describe(`${DOC_PATH} — status and scope`, () => {
  test('is marked implemented at the port layer and names both modules', () => {
    expect(doc).toMatch(/Status: \*\*approved design, implemented at the port layer\*\*/);
    expect(doc).toMatch(/src\/core\/operation-port\.ts/);
    expect(doc).toMatch(/src\/core\/chatops-operation-dispatch\.ts/);
  });

  test('states that no operation is registered by this issue', () => {
    expect(doc).toMatch(/No operation is registered yet/i);
  });

  test('supersedes the callable-dispatch portion of the earlier attempts', () => {
    expect(doc).toMatch(/supersedes the callable-dispatch portion of #779 and of #696 \/ PR #776/i);
  });

  test('builds on the ledger contract rather than re-deriving it', () => {
    expect(doc).toMatch(/docs\/chatops-execution-ledger-contract\.md/);
    expect(binding).toMatch(/chatops-execution-ledger\.js/);
  });

  test('the ledger contract points forward at this document', () => {
    expect(read('docs/chatops-execution-ledger-contract.md')).toMatch(
      /docs\/operation-dispatch-port-contract\.md/,
    );
  });

  test('names the failure it exists to prevent: a seam the cited prerequisite did not provide', () => {
    expect(doc).toMatch(
      /built its dispatch step on a seam its cited prerequisite did not provide/i,
    );
  });
});

describe(`${DOC_PATH} — ownership`, () => {
  test('places the port in the Operation context, which owns no state of its own', () => {
    expect(doc).toMatch(/The owning context is Operation/);
    expect(doc).toMatch(/the ChatOps adapter #696 is a second entry point over the same ports/);
  });

  test('keeps operations out of the phase-handler path', () => {
    expect(doc).toMatch(/never phase handlers directly/);
    expect(doc).toMatch(/ChatOps gains no exception/i);
  });

  test('fixes the registration direction inward, as the command registry already does', () => {
    expect(doc).toMatch(/pulled inward/);
    expect(doc).toMatch(/never reaches back into a registry to register itself/);
    // Source phrases are matched within one line: the whitespace-normalized
    // copy keeps each JSDoc line's leading `*`, so a phrase that straddles a
    // comment line break would never match.
    expect(port).toMatch(/back into a registry to register itself/);
  });
});

describe(`${DOC_PATH} — request and context separation`, () => {
  test('the reserved-name set in the document is exactly the one the port enforces', () => {
    const documented = [
      ...doc.matchAll(/`OPERATION_RESERVED_PARAM_NAMES` is a closed set — ([^—]+) — refused/g),
    ];
    expect(documented).toHaveLength(1);
    const names = documented[0][1]
      .split(',')
      .map((entry) => entry.replace(/[`\s]/g, '').replace(/^and/, ''))
      .filter((entry) => entry.length > 0);
    expect(names.sort()).toEqual([...OPERATION_RESERVED_PARAM_NAMES].sort());
  });

  test('reserved names are refused at registration and at invocation', () => {
    expect(doc).toMatch(/refused in two places: at registration .* and at invocation/);
  });

  test('what the port validates is what the handler acts on, on both sides of the boundary', () => {
    // A check that inspects one object and an execution that reads another is
    // the same defect twice: once per invocation for a request, once per
    // registration for a descriptor.
    expect(doc).toMatch(/The validated request is a snapshot, not the caller's object/);
    expect(doc).toMatch(/The registry stores an immutable copy of each descriptor/);
    expect(port).toMatch(/never anything else/);
  });

  test('the request carries no argv, command, session, or issue field', () => {
    expect(doc).toMatch(
      /no `argv` field, no `command` field, and no free-form string that a downstream layer interprets/,
    );
  });

  test('the trusted-field table names a forbidden source for every context field', () => {
    const rows = docLines.filter((line) => /^\| `(surface|actor|sessionId|issueNumber|requestId|confirmed|deadlineMs)` \|/.test(line));
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      // Three columns: field, where an adapter gets it, where it may never come from.
      expect(row.split('|').filter((cell) => cell.trim().length > 0)).toHaveLength(3);
    }
  });

  test('confirmation is trusted context, and the port enforces its postcondition', () => {
    expect(doc).toMatch(/Confirmation is trusted context, not a parameter/);
    expect(doc).toMatch(/The port enforces that postcondition/);
    expect(doc).toMatch(/converted to `failed` \/ `internal` \/ `effect: "unknown"`/);
    // `mutating` is load-bearing, not descriptive: the same downgrade catches a
    // descriptor that declared itself non-mutating and then applied changes.
    expect(doc).toMatch(/a descriptor that declared itself non-`mutating`/);
    expect(doc).toMatch(/`mutating` is not decorative/);
  });
});

describe(`${DOC_PATH} — results`, () => {
  test('the three result shapes and their reason sets are stated', () => {
    expect(doc).toMatch(/status: "executed"/);
    expect(doc).toMatch(/status: "rejected"/);
    expect(doc).toMatch(/status: "failed"/);
    for (const reason of [
      'unknown-operation',
      'invalid-request',
      'invalid-context',
      'not-permitted',
      'precondition-failed',
      'conflict',
    ]) {
      expect(doc).toMatch(new RegExp(`\`${reason}\``));
      expect(port).toMatch(new RegExp(`"${reason}"`));
    }
    for (const reason of ['unavailable', 'timeout', 'internal']) {
      expect(doc).toMatch(new RegExp(`\`${reason}\``));
      expect(port).toMatch(new RegExp(`"${reason}"`));
    }
  });

  test('a rejection is effect-free by construction, and a failure must state its effect', () => {
    expect(doc).toMatch(/definite and effect-free/);
    expect(doc).toMatch(/a required field with no default/);
  });

  test('the port never throws, and a lost handler yields an indeterminate failure', () => {
    expect(doc).toMatch(/`invokeOperation` never throws/);
    expect(doc).toMatch(/a handler that lost control cannot vouch for what it had already done/i);
  });

  test('there is no exit code and no rendered output at this layer', () => {
    expect(doc).toMatch(/There is no exit code, no `ok: boolean`, and no rendered string/);
  });
});

describe(`${DOC_PATH} — prohibitions`, () => {
  test('the five adapter prohibitions are enumerated', () => {
    for (const rule of [
      /Never assemble argv or a command string to reach an operation/,
      /Never parse admin CLI argv to \*produce\* a request/,
      /Never construct a context field from request data/,
      /Never open a transaction around an operation/,
      /Never render inside an operation/,
    ]) {
      expect(doc).toMatch(rule);
    }
  });

  test('the greppable prohibitions are stated as comment-stripped source scans', () => {
    expect(doc).toMatch(/with comments stripped/);
    expect(doc).toMatch(/`spawn`\/`execFile`\/`child_process`\/`admin\.js`/);
  });
});

describe(`${DOC_PATH} — transaction and effect ownership`, () => {
  test('the operation owns its transaction and the adapter owns none', () => {
    expect(doc).toMatch(/\*\*The operation owns its transaction\.\*\*/);
    expect(doc).toMatch(/\*\*The adapter owns no transaction\.\*\*/);
    expect(doc).toMatch(/\*\*No transaction spans the port\.\*\*/);
  });

  test('deferred host writes stay in the outbox, dispatched by Delivery', () => {
    expect(doc).toMatch(/enqueues an effect in its own transaction; Delivery dispatches it/);
  });

  test('the port sits between the ledger write-ahead and the outcome commit', () => {
    expect(doc).toMatch(/the port is invoked, and only then does T3 record the outcome/);
    expect(doc).toMatch(/a given attempt is invoked at most once/);
  });

  test('no domain logic moves into the adapter', () => {
    expect(doc).toMatch(
      /The adapter's entire contribution is: build a context, build a request, call, and record what came back/,
    );
  });
});

describe(`${DOC_PATH} — the ledger mapping table`, () => {
  const mappingRows = docLines.filter((line) => /^\| `(executed|rejected|failed)`/.test(line));

  test('every result shape has exactly one row', () => {
    expect(mappingRows).toHaveLength(5);
    expect(mappingRows.filter((row) => /dispatch-result/.test(row))).toHaveLength(3);
    expect(mappingRows.filter((row) => /`reconciled` with verdict `no-effect`/.test(row))).toHaveLength(1);
    expect(mappingRows.filter((row) => /\*\*none\*\*/.test(row))).toHaveLength(1);
  });

  test('the rows cite the ledger row numbers they use', () => {
    expect(mappingRows.filter((row) => /row 8/.test(row))).toHaveLength(3);
    expect(mappingRows.filter((row) => /row 9/.test(row))).toHaveLength(1);
  });

  test('the mapping introduces no new ledger event, state, or row number', () => {
    expect(doc).toMatch(
      /The mapping introduces no new ledger event, no new state, and no new row number/,
    );
  });

  test('the binding module implements exactly the events the table names', () => {
    expect(binding).toMatch(/kind: "dispatch-result", outcome: "executed"/);
    expect(binding).toMatch(/kind: "dispatch-result", outcome: "rejected"/);
    expect(binding).toMatch(/kind: "dispatch-result", outcome: "error"/);
    expect(binding).toMatch(/kind: "reconciled", verdict: \{ kind: "no-effect" \}/);
  });
});

describe(`${DOC_PATH} — the prerequisite (§11)`, () => {
  test('names the extraction plan and why it does not supply a callable seam', () => {
    expect(doc).toMatch(/docs\/admin-extraction-plan\.md/);
    expect(doc).toMatch(/runXxx\(argv: string\[\]\): Promise<void>/);
    expect(doc).toMatch(/is a \*\*relocation\*\* plan, not a re-shaping one/);
    expect(doc).toMatch(/None of them is an operation port/);
  });

  test('states the three blockers a non-terminal adapter still faces', () => {
    expect(doc).toMatch(
      /it must synthesize argv, it must capture output from a process-global sink, and it must survive a callee that may exit the process/,
    );
  });

  test('the prerequisite is a six-point per-operation core extraction', () => {
    const start = docLines.findIndex((line) =>
      /^### 11\.2 The real prerequisite/.test(line),
    );
    const end = docLines.findIndex((line) => /^### 11\.3/.test(line));
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const numbered = docLines
      .slice(start, end)
      .filter((line) => /^\d+\. /.test(line))
      .map((line) => line.match(/^(\d+)\./)[1]);
    expect(numbered).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  test('the split is orthogonal to the extraction plan in both directions', () => {
    expect(doc).toMatch(/orthogonal to the admin extraction plan/);
    expect(doc).toMatch(/Nothing in this contract is blocked on #613, and #613 is not blocked on this/);
    expect(doc).toMatch(/adds no `P5`/);
  });

  test('records the design-dependency correction and where the work is charged', () => {
    expect(doc).toMatch(/`#613 → #696` edge is corrected/);
    expect(doc).toMatch(/at most one open blocker per issue/);
    expect(doc).toMatch(/Per-operation, to the issue that first needs that operation/);
  });
});

describe(`${DOC_PATH} — test seams and invariants`, () => {
  test('adapter-independent invocation is stated as a seam, not a byproduct', () => {
    expect(doc).toMatch(/no stdout capture, no exit-code assertions, no subprocess/);
    expect(doc).toMatch(/Adapters are tested against a fake registry/);
  });

  test('the named test files exist', () => {
    expect(doc).toMatch(/test\/operation-port\.test\.js/);
    expect(doc).toMatch(/test\/chatops-operation-dispatch\.test\.js/);
    for (const rel of ['test/operation-port.test.js', 'test/chatops-operation-dispatch.test.js']) {
      expect(() => raw(rel)).not.toThrow();
    }
  });

  test('the seven invariants are numbered and stable', () => {
    const start = docLines.findIndex((line) => /^## 15\. Invariants/.test(line));
    const end = docLines.findIndex((line) => /^## 16\./.test(line));
    const numbered = docLines
      .slice(start, end)
      .filter((line) => /^\d+\. /.test(line))
      .map((line) => line.match(/^(\d+)\./)[1]);
    expect(numbered).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  test('the non-goals hand the named successors their scope', () => {
    expect(doc).toMatch(/Which operations exist and how a ChatOps verb maps onto one\*\* — #784/);
    expect(doc).toMatch(/Routing protection\*\* — .*#785/);
    expect(doc).toMatch(/Tool Request grant tiers over typed operation ids\*\* — #697/);
  });

  test('the executable chain is stated as its predecessors state it', () => {
    expect(doc).toMatch(
      /#777 → #780 → #781 → #782 → #783 → #784 → #785 → #697 → #915 → #916 → #917 → #918 → #919 → #722/,
    );
  });
});
