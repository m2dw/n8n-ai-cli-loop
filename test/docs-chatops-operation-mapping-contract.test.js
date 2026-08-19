/**
 * Structural tests for docs/chatops-operation-mapping-contract.md (issue
 * #784).
 *
 * The document is the boundary contract between a recognized ChatOps command
 * and the untrusted half of an operation invocation. A rule that drifts out
 * of the document — or out of the module implementing it — is how a comment
 * ends up naming a trusted field, a free-form command, or a deprecated
 * operation id, so these tests pin the claims a reader must be able to rely
 * on: the forbidden-parameter set, the deprecated-id set, the supported
 * table, the outcome shapes, and the required scenarios.
 *
 * Assertions run against a whitespace-normalized copy — the document is
 * hard-wrapped prose, so a claim can straddle a line break today and be
 * reflowed tomorrow. The supported table is read from the raw text instead,
 * because its rows are line-oriented.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  CHATOPS_DEPRECATED_OPERATION_IDS,
  CHATOPS_FORBIDDEN_PARAM_NAMES,
  CHATOPS_OPERATION_MAPPING_TABLE,
} from '../dist/core/chatops-operation-mapping.js';
import { OPERATION_RESERVED_PARAM_NAMES } from '../dist/core/operation-port.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function raw(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

function read(rel) {
  return raw(rel).replace(/\s+/g, ' ');
}

const DOC_PATH = 'docs/chatops-operation-mapping-contract.md';
const doc = read(DOC_PATH);
const docLines = raw(DOC_PATH).split('\n');
const core = read('src/core/chatops-operation-mapping.ts');

function backtickList(text) {
  return text
    .split(',')
    .map((entry) => entry.replace(/[`\s]/g, '').replace(/^and/, ''))
    .filter((entry) => entry.length > 0);
}

describe(`${DOC_PATH} — status and scope`, () => {
  test('is marked implemented and names its module', () => {
    expect(doc).toMatch(/Status: \*\*approved design, implemented\*\*/);
    expect(doc).toMatch(/src\/core\/chatops-operation-mapping\.ts/);
  });

  test('names the issue it is and the issue it supersedes', () => {
    expect(doc).toMatch(/This is issue #784, split part 2 of superseded #779/);
    expect(doc).toMatch(/supersedes the mapping\/routing portion of #779 and of #696 \/ PR #776/);
  });

  test('states both PR #776 review findings this contract closes', () => {
    expect(doc).toMatch(/parsed comment arguments could override trusted session routing/);
    expect(doc).toMatch(/tool-request grant.*a deprecated CLI alias/);
  });
});

describe(`${DOC_PATH} — forbidden parameter names (§3)`, () => {
  test('the documented forbidden-name set is exactly what the module enforces', () => {
    const reservedMatch = [
      ...doc.matchAll(
        /every name in `OPERATION_RESERVED_PARAM_NAMES` \(contract §5\.1's ([^)]+)\)/g,
      ),
    ];
    expect(reservedMatch).toHaveLength(1);
    const documentedReserved = backtickList(reservedMatch[0][1]);
    expect(documentedReserved.sort()).toEqual([...OPERATION_RESERVED_PARAM_NAMES].sort());

    const customMatch = [
      ...doc.matchAll(
        /a routing override or a state-store location would take on an admin CLI flag today: ([^.]+)\./g,
      ),
    ];
    expect(customMatch).toHaveLength(1);
    const documentedCustom = backtickList(customMatch[0][1]);

    const documented = new Set([...documentedReserved, ...documentedCustom]);
    expect([...documented].sort()).toEqual([...CHATOPS_FORBIDDEN_PARAM_NAMES].sort());
  });

  test('command is refused unconditionally, not merely validated', () => {
    expect(doc).toMatch(
      /`command` sits in that list for a distinct reason.*No allowlist subset makes that safe to expose/,
    );
  });

  test('the forbidden set is checked at table-construction time', () => {
    expect(doc).toMatch(/checked \*\*at table-construction time\*\*/);
    expect(core).toMatch(/throw new ChatOpsOperationMappingError/);
  });
});

describe(`${DOC_PATH} — deprecated operation ids (§4)`, () => {
  test('the documented deprecated-id set is exactly what the module enforces', () => {
    expect(doc).toMatch(
      /`CHATOPS_DEPRECATED_OPERATION_IDS` currently holds exactly `tool-request\.grant`/,
    );
    expect(CHATOPS_DEPRECATED_OPERATION_IDS).toEqual(['tool-request.grant']);
  });

  test('the supported verb still exists, mapped to the canonical id', () => {
    expect(doc).toMatch(
      /The verb `\/grant` \*\*is\*\* supported.*it maps to `tool-request\.run`, the canonical, non-deprecated id/,
    );
  });
});

describe(`${DOC_PATH} — the supported table (§7)`, () => {
  test('every documented row matches the shipped table exactly', () => {
    const rows = docLines
      .filter((line) => /^\| `[a-z-]+` \|/.test(line))
      .map((line) => line.split('|').map((cell) => cell.trim()).filter((cell) => cell.length > 0));
    expect(rows.length).toBeGreaterThan(0);

    const documented = new Map(
      rows.map(([verb, operationId, scope, mutating]) => [
        verb.replace(/`/g, ''),
        {
          operationId: operationId.replace(/`/g, ''),
          scope,
          mutating: mutating === 'yes',
        },
      ]),
    );

    const shipped = CHATOPS_OPERATION_MAPPING_TABLE.list();
    expect(documented.size).toBe(shipped.length);
    for (const mapping of shipped) {
      expect(documented.get(mapping.verb)).toEqual({
        operationId: mapping.operationId,
        scope: mapping.scope,
        mutating: mapping.mutating,
      });
    }
  });

  test('both shipped verbs are issue-scoped and mutating', () => {
    for (const mapping of CHATOPS_OPERATION_MAPPING_TABLE.list()) {
      expect(mapping.scope).toBe('issue');
      expect(mapping.mutating).toBe(true);
    }
  });
});

describe(`${DOC_PATH} — outcomes (§8)`, () => {
  test('the three outcome kinds are documented', () => {
    expect(doc).toMatch(/"unsupported-operation"; verb: string/);
    expect(doc).toMatch(/"invalid-argument"; verb: string; detail: string/);
    expect(doc).toMatch(/"request"; operationId: string; scope: "session" \| "issue"; mutating: boolean/);
  });
});

describe(`${DOC_PATH} — required scenarios (§9)`, () => {
  const scenarios = [
    /`\/grant --session-ref other`, or a repeated trusted selector\./,
    /The same issue number in two sessions, or two repositories\./,
    /A deprecated alias supplied as a command\./,
    /An extra option accepted by the admin CLI but forbidden in ChatOps\./,
    /An operation with no safe ChatOps mapping\./,
  ];

  test.each(scenarios)('%s is documented', (pattern) => {
    expect(doc).toMatch(pattern);
  });
});

describe(`${DOC_PATH} — invariants (§11)`, () => {
  test('states the module never builds trusted context or invokes an operation', () => {
    expect(doc).toMatch(
      /This module never builds trusted context and never invokes an operation; both stay #783's/,
    );
  });
});
