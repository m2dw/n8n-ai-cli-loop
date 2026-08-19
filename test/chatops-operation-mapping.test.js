/**
 * Contract tests for the ChatOps operation mapping and per-surface argument
 * policy (issue #784) — docs/chatops-operation-mapping-contract.md.
 *
 * Two layers are pinned here. First, table construction: a mapping that
 * declares a trusted-context name, a free-form-command-shaped name, or a
 * deprecated operation id must never produce a usable table at all. Second,
 * request mapping: a recognized `{ verb, argv }` command always produces
 * exactly one of `unsupported-operation`, `invalid-argument`, or `request` —
 * never a throw, never a partial result. Neither layer touches a comment, a
 * provider, a store, or an operation registry.
 */
import {
  CHATOPS_DEPRECATED_OPERATION_IDS,
  CHATOPS_FORBIDDEN_PARAM_NAMES,
  CHATOPS_OPERATION_MAPPINGS,
  CHATOPS_OPERATION_MAPPING_TABLE,
  ChatOpsOperationMappingError,
  createChatOpsOperationMappingTable,
  mapChatOpsCommandToOperationRequest,
} from '../dist/core/chatops-operation-mapping.js';
import { OPERATION_RESERVED_PARAM_NAMES } from '../dist/core/operation-port.js';
import { parseChatOpsCommandLine, recognizeChatOpsComment } from '../dist/core/chatops-command.js';
import { chatOpsOperationContext } from '../dist/core/chatops-operation-dispatch.js';

function grantMapping(overrides = {}) {
  return {
    verb: 'grant',
    operationId: 'tool-request.run',
    scope: 'issue',
    mutating: true,
    summary: 'test mapping',
    params: [{ name: 'disposition', type: 'string' }],
    ...overrides,
  };
}

describe('table construction refuses every declaration defect', () => {
  test('a forbidden parameter name is refused, for every reserved and chatops-specific name', () => {
    for (const name of [...OPERATION_RESERVED_PARAM_NAMES, 'command', 'repo-root', 'db-path']) {
      expect(() =>
        createChatOpsOperationMappingTable([
          grantMapping({ params: [{ name, type: 'string' }] }),
        ]),
      ).toThrow(ChatOpsOperationMappingError);
    }
  });

  test('a deprecated operation id is refused', () => {
    expect(() =>
      createChatOpsOperationMappingTable([grantMapping({ operationId: 'tool-request.grant' })]),
    ).toThrow(/deprecated alias/);
  });

  test('an invalid operation id shape is refused', () => {
    expect(() =>
      createChatOpsOperationMappingTable([grantMapping({ operationId: 'ToolRequest' })]),
    ).toThrow(ChatOpsOperationMappingError);
  });

  test('an invalid or single-character verb is refused', () => {
    expect(() => createChatOpsOperationMappingTable([grantMapping({ verb: 'x' })])).toThrow(
      ChatOpsOperationMappingError,
    );
    expect(() => createChatOpsOperationMappingTable([grantMapping({ verb: 'Grant' })])).toThrow(
      ChatOpsOperationMappingError,
    );
  });

  test('an unknown scope, a non-boolean mutating flag, and a blank summary are each refused', () => {
    expect(() => createChatOpsOperationMappingTable([grantMapping({ scope: 'repo' })])).toThrow(
      ChatOpsOperationMappingError,
    );
    expect(() => createChatOpsOperationMappingTable([grantMapping({ mutating: 'yes' })])).toThrow(
      ChatOpsOperationMappingError,
    );
    expect(() => createChatOpsOperationMappingTable([grantMapping({ summary: '   ' })])).toThrow(
      ChatOpsOperationMappingError,
    );
  });

  test('an unknown parameter type and a non-boolean required/repeated flag are refused', () => {
    expect(() =>
      createChatOpsOperationMappingTable([
        grantMapping({ params: [{ name: 'note', type: 'json' }] }),
      ]),
    ).toThrow(ChatOpsOperationMappingError);
    expect(() =>
      createChatOpsOperationMappingTable([
        grantMapping({ params: [{ name: 'note', type: 'string', required: 'yes' }] }),
      ]),
    ).toThrow(ChatOpsOperationMappingError);
  });

  test('a non-array params value is refused as a mapping error, not a raw TypeError', () => {
    for (const params of [null, undefined, 'note', {}]) {
      expect(() => createChatOpsOperationMappingTable([grantMapping({ params })])).toThrow(
        ChatOpsOperationMappingError,
      );
    }
  });

  test('a parameter declared twice on one verb is refused', () => {
    expect(() =>
      createChatOpsOperationMappingTable([
        grantMapping({
          params: [
            { name: 'note', type: 'string' },
            { name: 'note', type: 'number' },
          ],
        }),
      ]),
    ).toThrow(ChatOpsOperationMappingError);
  });

  test('a duplicate verb across mappings is refused', () => {
    expect(() =>
      createChatOpsOperationMappingTable([grantMapping(), grantMapping({ operationId: 'tool-request.run' })]),
    ).toThrow(/duplicate chatops verb/);
  });

  test('a valid table is built, and its data is frozen against later mutation', () => {
    const source = [grantMapping()];
    const table = createChatOpsOperationMappingTable(source);
    const mapping = table.get('grant');
    expect(mapping.operationId).toBe('tool-request.run');
    expect(() => {
      mapping.params[0].name = 'other';
    }).toThrow();
    source[0].verb = 'mutated';
    expect(table.get('grant')).toBeDefined();
    expect(table.get('mutated')).toBeUndefined();
  });

  test('supportedVerbs() is exactly the table\'s key set, as a fresh Set each call', () => {
    const table = createChatOpsOperationMappingTable([grantMapping(), grantMapping({ verb: 'resolve', operationId: 'tool-request.resolve' })]);
    expect(table.supportedVerbs()).toEqual(new Set(['grant', 'resolve']));
    expect(table.supportedVerbs()).not.toBe(table.supportedVerbs());
  });
});

describe('CHATOPS_FORBIDDEN_PARAM_NAMES and CHATOPS_DEPRECATED_OPERATION_IDS', () => {
  test('every port-reserved name is included', () => {
    for (const name of OPERATION_RESERVED_PARAM_NAMES) {
      expect(CHATOPS_FORBIDDEN_PARAM_NAMES).toContain(name);
    }
  });

  test('command is forbidden unconditionally', () => {
    expect(CHATOPS_FORBIDDEN_PARAM_NAMES).toContain('command');
  });

  test('tool-request.grant is the one deprecated id', () => {
    expect(CHATOPS_DEPRECATED_OPERATION_IDS).toEqual(['tool-request.grant']);
  });
});

describe('mapChatOpsCommandToOperationRequest: unsupported verbs', () => {
  const table = createChatOpsOperationMappingTable([grantMapping()]);

  test('a verb absent from the table is unsupported-operation', () => {
    expect(mapChatOpsCommandToOperationRequest({ verb: 'force-release', argv: [] }, table)).toEqual({
      kind: 'unsupported-operation',
      verb: 'force-release',
    });
  });
});

describe('mapChatOpsCommandToOperationRequest: argument shape', () => {
  const table = createChatOpsOperationMappingTable([
    grantMapping(),
    {
      verb: 'resolve',
      operationId: 'tool-request.resolve',
      scope: 'issue',
      mutating: true,
      summary: 'resolve',
      params: [
        { name: 'action', type: 'string', required: true },
        { name: 'message', type: 'string' },
      ],
    },
    {
      verb: 'tag',
      operationId: 'issue.tag',
      scope: 'issue',
      mutating: true,
      summary: 'repeatable tag test fixture',
      params: [{ name: 'label', type: 'string', repeated: true }],
    },
  ]);

  test('a bare positional token is invalid-argument', () => {
    const outcome = mapChatOpsCommandToOperationRequest({ verb: 'grant', argv: ['now'] }, table);
    expect(outcome).toMatchObject({ kind: 'invalid-argument', verb: 'grant' });
    expect(outcome.detail).toMatch(/positional/);
  });

  test('an unknown parameter is invalid-argument, including every forbidden trusted-context name', () => {
    for (const name of ['session-ref', 'session-id', 'issue-number', 'command', 'db-path']) {
      const outcome = mapChatOpsCommandToOperationRequest(
        { verb: 'grant', argv: [`--${name}`, 'other'] },
        table,
      );
      expect(outcome).toMatchObject({ kind: 'invalid-argument', verb: 'grant' });
      expect(outcome.detail).toMatch(new RegExp(`--${name}`));
    }
  });

  test('a flag with no following value is invalid-argument', () => {
    const outcome = mapChatOpsCommandToOperationRequest({ verb: 'grant', argv: ['--disposition'] }, table);
    expect(outcome).toMatchObject({ kind: 'invalid-argument', verb: 'grant' });
    expect(outcome.detail).toMatch(/requires a value/);
  });

  test('a value that looks like a flag is treated as a missing value, not consumed', () => {
    const outcome = mapChatOpsCommandToOperationRequest(
      { verb: 'grant', argv: ['--disposition', '--dry-run'] },
      table,
    );
    expect(outcome).toMatchObject({ kind: 'invalid-argument', verb: 'grant' });
  });

  test('a duplicate non-repeated parameter is refused regardless of which value came first', () => {
    const first = mapChatOpsCommandToOperationRequest(
      { verb: 'resolve', argv: ['--action', 'manual-done', '--action', 'reject'] },
      table,
    );
    const second = mapChatOpsCommandToOperationRequest(
      { verb: 'resolve', argv: ['--action', 'reject', '--action', 'manual-done'] },
      table,
    );
    expect(first).toEqual(second);
    expect(first).toMatchObject({ kind: 'invalid-argument', verb: 'resolve' });
    expect(first.detail).toMatch(/--action was supplied more than once/);
  });

  test('a repeated parameter collects every occurrence in argv order', () => {
    const outcome = mapChatOpsCommandToOperationRequest(
      { verb: 'tag', argv: ['--label', 'a', '--label', 'b'] },
      table,
    );
    expect(outcome).toEqual({
      kind: 'request',
      operationId: 'issue.tag',
      scope: 'issue',
      mutating: true,
      params: { label: ['a', 'b'] },
    });
  });

  test('a missing required parameter is invalid-argument', () => {
    const outcome = mapChatOpsCommandToOperationRequest({ verb: 'resolve', argv: [] }, table);
    expect(outcome).toMatchObject({ kind: 'invalid-argument', verb: 'resolve' });
    expect(outcome.detail).toMatch(/missing required parameter --action/);
  });

  test('a required parameter satisfied and an optional one omitted succeeds', () => {
    const outcome = mapChatOpsCommandToOperationRequest(
      { verb: 'resolve', argv: ['--action', 'reject'] },
      table,
    );
    expect(outcome).toEqual({
      kind: 'request',
      operationId: 'tool-request.resolve',
      scope: 'issue',
      mutating: true,
      params: { action: 'reject' },
    });
  });

  test('grant with no arguments succeeds with an empty params object', () => {
    expect(mapChatOpsCommandToOperationRequest({ verb: 'grant', argv: [] }, table)).toEqual({
      kind: 'request',
      operationId: 'tool-request.run',
      scope: 'issue',
      mutating: true,
      params: {},
    });
  });

  test('a boolean flag never consumes the following token', () => {
    const boolTable = createChatOpsOperationMappingTable([
      {
        verb: 'flagged',
        operationId: 'issue.flag',
        scope: 'issue',
        mutating: true,
        summary: 'boolean test fixture',
        params: [
          { name: 'urgent', type: 'boolean' },
          { name: 'note', type: 'string' },
        ],
      },
    ]);
    const outcome = mapChatOpsCommandToOperationRequest(
      { verb: 'flagged', argv: ['--urgent', '--note', 'hi'] },
      boolTable,
    );
    expect(outcome).toEqual({
      kind: 'request',
      operationId: 'issue.flag',
      scope: 'issue',
      mutating: true,
      params: { urgent: true, note: 'hi' },
    });
  });

  test('a number parameter is coerced, and a non-numeric value is invalid-argument', () => {
    const numberTable = createChatOpsOperationMappingTable([
      {
        verb: 'wait',
        operationId: 'issue.wait',
        scope: 'issue',
        mutating: true,
        summary: 'number test fixture',
        params: [{ name: 'minutes', type: 'number' }],
      },
    ]);
    expect(
      mapChatOpsCommandToOperationRequest({ verb: 'wait', argv: ['--minutes', '5'] }, numberTable),
    ).toEqual({
      kind: 'request',
      operationId: 'issue.wait',
      scope: 'issue',
      mutating: true,
      params: { minutes: 5 },
    });
    const outcome = mapChatOpsCommandToOperationRequest(
      { verb: 'wait', argv: ['--minutes', 'soon'] },
      numberTable,
    );
    expect(outcome).toMatchObject({ kind: 'invalid-argument', verb: 'wait' });
    expect(outcome.detail).toMatch(/--minutes expects a number value/);
  });
});

describe('the shipped table (contract §7)', () => {
  test('grant maps to the canonical tool-request.run, never the deprecated grant alias', () => {
    const mapping = CHATOPS_OPERATION_MAPPING_TABLE.get('grant');
    expect(mapping.operationId).toBe('tool-request.run');
    expect(CHATOPS_DEPRECATED_OPERATION_IDS).not.toContain(mapping.operationId);
  });

  test('resolve maps to tool-request.resolve and requires action', () => {
    const mapping = CHATOPS_OPERATION_MAPPING_TABLE.get('resolve');
    expect(mapping.operationId).toBe('tool-request.resolve');
    expect(mapping.params.find((p) => p.name === 'action').required).toBe(true);
  });

  test('every shipped mapping is issue-scoped and none targets a deprecated id', () => {
    for (const mapping of CHATOPS_OPERATION_MAPPINGS) {
      expect(mapping.scope).toBe('issue');
      expect(CHATOPS_DEPRECATED_OPERATION_IDS).not.toContain(mapping.operationId);
    }
  });

  test('CHATOPS_OPERATION_MAPPING_TABLE.supportedVerbs() is exactly grant and resolve', () => {
    expect(CHATOPS_OPERATION_MAPPING_TABLE.supportedVerbs()).toEqual(new Set(['grant', 'resolve']));
  });

  test('an operation with no safe ChatOps mapping is unsupported-operation', () => {
    for (const verb of ['force-release', 'discard', 'list']) {
      expect(
        mapChatOpsCommandToOperationRequest({ verb, argv: [] }, CHATOPS_OPERATION_MAPPING_TABLE),
      ).toEqual({ kind: 'unsupported-operation', verb });
    }
  });

  test('command is refused for grant even though the admin CLI accepts it', () => {
    const outcome = mapChatOpsCommandToOperationRequest(
      { verb: 'grant', argv: ['--command', 'rm -rf /'] },
      CHATOPS_OPERATION_MAPPING_TABLE,
    );
    expect(outcome).toMatchObject({ kind: 'invalid-argument', verb: 'grant' });
  });
});

describe('required scenarios (contract §9), driven end to end from a comment', () => {
  const TRUST = { authorAllowlist: ['alice'], automationLogins: ['bot'] };
  const supportedVerbs = CHATOPS_OPERATION_MAPPING_TABLE.supportedVerbs();

  function recognizeAndMap(body) {
    const outcome = recognizeChatOpsComment(
      { author: 'alice', body, createdAt: 't0', updatedAt: 't0' },
      TRUST,
      supportedVerbs,
    );
    expect(outcome.kind).toBe('command');
    return mapChatOpsCommandToOperationRequest(outcome.command, CHATOPS_OPERATION_MAPPING_TABLE);
  }

  test('/grant --session-ref other is invalid-argument, not a session override', () => {
    const outcome = recognizeAndMap('/grant --session-ref other');
    expect(outcome).toMatchObject({ kind: 'invalid-argument', verb: 'grant' });
  });

  test('the same issue number in two sessions never merges into one invocation', () => {
    const request = recognizeAndMap('/grant --disposition commit');
    const identityA = {
      sessionId: 'session-a',
      provider: 'github-issues',
      providerEndpoint: 'github.com',
      providerOwner: 'm2dw',
      providerRepo: 'repo-a',
    };
    const identityB = { ...identityA, sessionId: 'session-b', providerRepo: 'repo-b' };
    const contextA = chatOpsOperationContext({
      identity: identityA,
      issueNumber: 784,
      commentId: 'c-1',
      authorLogin: 'alice',
      attempt: 1,
      confirmed: true,
    });
    const contextB = chatOpsOperationContext({
      identity: identityB,
      issueNumber: 784,
      commentId: 'c-1',
      authorLogin: 'alice',
      attempt: 1,
      confirmed: true,
    });
    expect(contextA.issueNumber).toBe(contextB.issueNumber);
    expect(contextA.sessionId).not.toBe(contextB.sessionId);
    expect(contextA.requestId).not.toBe(contextB.requestId);
    // The request half (operationId/params) is identical for both — only the
    // trusted half distinguishes them, and the two never share one object.
    expect(request.operationId).toBe('tool-request.run');
    expect(request.params).toEqual({ disposition: 'commit' });
  });

  test('a deprecated alias spelled out as its own verb is simply unsupported', () => {
    const outcome = recognizeChatOpsComment(
      { author: 'alice', body: '/tool-request-grant', createdAt: 't0', updatedAt: 't0' },
      TRUST,
      supportedVerbs,
    );
    expect(outcome).toEqual({ kind: 'unsupported-command', verb: 'tool-request-grant' });
  });

  test('/grant with no arguments still parses as a well-formed command', () => {
    expect(parseChatOpsCommandLine('/grant')).toEqual({ verb: 'grant', argv: [] });
  });
});
