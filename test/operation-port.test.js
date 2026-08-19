/**
 * Contract tests for the callable operation-dispatch port (issue #783) —
 * docs/operation-dispatch-port-contract.md.
 *
 * These pin the acceptance criteria: the port is callable without argv or a
 * subprocess, the trusted context is structurally separate from user-supplied
 * parameters, every failure mode comes back as a typed result, and no
 * invocation can leave the caller unable to say what happened.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  OPERATION_ID_PATTERN,
  OPERATION_RESERVED_PARAM_NAMES,
  OPERATION_SUMMARY_MAX_CHARS,
  OperationRegistrationError,
  boundOperationSummary,
  createOperationRegistry,
  invokeOperation,
  operationExecuted,
  operationFailed,
  operationRejected,
  validateOperationContext,
  validateOperationRequest,
} from '../dist/core/operation-port.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function context(overrides = {}) {
  return {
    surface: 'chatops',
    actor: { kind: 'human', id: 'alice' },
    sessionId: 'session-1',
    issueNumber: 783,
    requestId: 'req-1',
    confirmed: true,
    deadlineMs: null,
    ...overrides,
  };
}

/** A descriptor that records what the port handed it. */
function recorder(overrides = {}) {
  const seen = [];
  const descriptor = {
    id: 'tool-request.run',
    summary: 'Resolve a Tool Request',
    mutating: true,
    scope: 'issue',
    params: [
      { name: 'target', type: 'string' },
      { name: 'on-changes', type: 'string' },
    ],
    run: (invocation) => {
      seen.push(invocation);
      return operationExecuted('resolved');
    },
    ...overrides,
  };
  return { descriptor, seen };
}

describe('operation ids and parameter declarations', () => {
  test('an id is resource.action in lower-kebab, never a command string', () => {
    expect(OPERATION_ID_PATTERN.test('tool-request.run')).toBe(true);
    expect(OPERATION_ID_PATTERN.test('worktree.release-lock')).toBe(true);
    expect(OPERATION_ID_PATTERN.test('toolRequest.run')).toBe(false);
    expect(OPERATION_ID_PATTERN.test('tool-request run')).toBe(false);
    expect(OPERATION_ID_PATTERN.test('tool-request')).toBe(false);
    expect(OPERATION_ID_PATTERN.test('admin.js tool-request run')).toBe(false);
  });

  test('registration rejects a duplicate id', () => {
    const { descriptor } = recorder();
    expect(() => createOperationRegistry([descriptor, descriptor])).toThrow(OperationRegistrationError);
  });

  test('registration rejects a malformed id, a malformed parameter, and a blank summary', () => {
    const { descriptor } = recorder();
    expect(() => createOperationRegistry([{ ...descriptor, id: 'toolRequestRun' }])).toThrow(
      /invalid operation id/,
    );
    expect(() =>
      createOperationRegistry([{ ...descriptor, params: [{ name: 'onChanges', type: 'string' }] }]),
    ).toThrow(/invalid parameter name/);
    expect(() => createOperationRegistry([{ ...descriptor, summary: '   ' }])).toThrow(/blank summary/);
  });

  test('registration rejects a parameter that would shadow trusted context', () => {
    const { descriptor } = recorder();
    for (const reserved of ['session-id', 'issue-number', 'yes', 'surface']) {
      expect(() =>
        createOperationRegistry([{ ...descriptor, params: [{ name: reserved, type: 'string' }] }]),
      ).toThrow(/reserved parameter/);
    }
  });

  test('registration rejects the same parameter declared twice', () => {
    const { descriptor } = recorder();
    expect(() =>
      createOperationRegistry([
        {
          ...descriptor,
          params: [
            { name: 'on-changes', type: 'string' },
            { name: 'on-changes', type: 'string' },
          ],
        },
      ]),
    ).toThrow(/twice/);
  });

  test('registration rejects metadata the port would later check against', () => {
    const { descriptor } = recorder();
    expect(() => createOperationRegistry([{ ...descriptor, mutating: 'yes' }])).toThrow(
      /non-boolean mutating flag/,
    );
    expect(() => createOperationRegistry([{ ...descriptor, scope: 'repo' }])).toThrow(/unknown scope/);
    expect(() => createOperationRegistry([{ ...descriptor, run: 'admin tool-request run' }])).toThrow(
      /no run function/,
    );
    expect(() => createOperationRegistry([{ ...descriptor, params: { target: 'string' } }])).toThrow(
      /params that are not an array/,
    );
    expect(() => createOperationRegistry([null])).toThrow(/descriptor must be an object/);
  });

  test('registration rejects parameter metadata that decides how a value is validated', () => {
    // A descriptor may be built by unchecked JavaScript or from configuration.
    // An unknown `type` would fall through to the boolean check, and a truthy
    // but non-`true` `required`/`repeated` would quietly invert the semantics
    // the descriptor declared.
    const { descriptor } = recorder();
    expect(() =>
      createOperationRegistry([{ ...descriptor, params: [{ name: 'target', type: 'json' }] }]),
    ).toThrow(/unknown type/);
    expect(() =>
      createOperationRegistry([{ ...descriptor, params: [{ name: 'target' }] }]),
    ).toThrow(/unknown type/);
    expect(() =>
      createOperationRegistry([
        { ...descriptor, params: [{ name: 'target', type: 'string', required: 'yes' }] },
      ]),
    ).toThrow(/non-boolean required flag/);
    expect(() =>
      createOperationRegistry([
        { ...descriptor, params: [{ name: 'target', type: 'string', repeated: 1 }] },
      ]),
    ).toThrow(/non-boolean repeated flag/);
    expect(() =>
      createOperationRegistry([{ ...descriptor, params: ['target'] }]),
    ).toThrow(/parameter that is not an object/);
  });

  test('the registry lists what it was given and nothing else', () => {
    const { descriptor } = recorder();
    const registry = createOperationRegistry([descriptor]);
    expect(registry.list().map((d) => d.id)).toEqual(['tool-request.run']);
    expect(registry.get('tool-request.run')).toMatchObject({
      id: 'tool-request.run',
      mutating: true,
      scope: 'issue',
    });
    expect(registry.get('tool-request.run').run).toBe(descriptor.run);
    expect(registry.get('tool-request.grant')).toBeUndefined();
  });

  test('registered metadata is immutable, and not the caller\'s own object', () => {
    // The port checks §5.2's postcondition against registered metadata, so
    // anyone still holding the descriptor they handed in — the handler most of
    // all — must not be able to re-declare the operation after the fact.
    const { descriptor } = recorder({ mutating: false });
    const registry = createOperationRegistry([descriptor]);
    const registered = registry.get('tool-request.run');
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered.params)).toBe(true);
    expect(Object.isFrozen(registered.params[0])).toBe(true);
    descriptor.mutating = true;
    descriptor.params.push({ name: 'force', type: 'boolean' });
    expect(registry.get('tool-request.run').mutating).toBe(false);
    expect(registry.get('tool-request.run').params.map((p) => p.name)).toEqual([
      'target',
      'on-changes',
    ]);
  });
});

describe('request and context are structurally separate (contract §5)', () => {
  test('every reserved name is refused even when the operation declares nothing', async () => {
    const { descriptor, seen } = recorder({ params: [] });
    const registry = createOperationRegistry([descriptor]);
    for (const reserved of OPERATION_RESERVED_PARAM_NAMES) {
      const result = await invokeOperation(
        registry,
        { operationId: 'tool-request.run', params: { [reserved]: 'x' } },
        context(),
      );
      expect(result).toMatchObject({ status: 'rejected', reason: 'invalid-request', effect: 'none' });
      expect(result.summary).toMatch(/reserved for trusted context/);
    }
    expect(seen).toHaveLength(0);
  });

  test('a request naming another session never reaches the handler', async () => {
    const { descriptor, seen } = recorder();
    const registry = createOperationRegistry([descriptor]);
    const result = await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params: { 'session-id': 'someone-elses-session' } },
      context(),
    );
    expect(result.status).toBe('rejected');
    expect(seen).toHaveLength(0);
  });

  test('the handler receives the trusted context verbatim, alongside the request', async () => {
    const { descriptor, seen } = recorder();
    const registry = createOperationRegistry([descriptor]);
    const ctx = context({ actor: { kind: 'human', id: 'bob' }, confirmed: false });
    await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params: { 'on-changes': 'commit' } },
      ctx,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].context).toEqual(ctx);
    expect(seen[0].request).toEqual({
      operationId: 'tool-request.run',
      params: { 'on-changes': 'commit' },
    });
  });

  test('a parameter is read once, so a handler cannot act on a value that never passed validation', async () => {
    let reads = 0;
    const { descriptor, seen } = recorder({ params: [{ name: 'target', type: 'string' }] });
    const registry = createOperationRegistry([descriptor]);
    const params = {
      get target() {
        reads += 1;
        return reads === 1 ? 'safe' : 'other';
      },
    };
    const result = await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params },
      context(),
    );
    expect(result.status).toBe('executed');
    expect(reads).toBe(1);
    expect(seen[0].request.params.target).toBe('safe');
  });

  test('the handler is given a snapshot, so the caller cannot swap a validated value under it', async () => {
    // The request is the untrusted half and stays the caller's object; only a
    // copy taken at validation time can be the thing an operation acts on.
    const params = { target: 'safe', label: ['a'] };
    const request = { operationId: 'tool-request.run', params };
    const { descriptor } = recorder({
      params: [
        { name: 'target', type: 'string' },
        { name: 'label', type: 'string', repeated: true },
      ],
      run: (invocation) => {
        params.target = 'other';
        params.label.push('b');
        request.params = { target: 'other' };
        return operationExecuted(
          `resolved ${invocation.request.params.target} [${invocation.request.params.label.join(',')}]`,
        );
      },
    });
    const registry = createOperationRegistry([descriptor]);
    const result = await invokeOperation(registry, request, context());
    expect(result.summary).toBe('resolved safe [a]');
  });

  test('an own "__proto__" key cannot smuggle a parameter past validation', async () => {
    // JSON an adapter decoded can carry an own `__proto__` key. Copied into an
    // ordinary object it would hit the inherited setter instead of becoming an
    // own key: nothing would see it at validation time, and the handler would
    // then read a declared parameter it inherited from the polluted prototype.
    const { descriptor, seen } = recorder({ params: [{ name: 'target', type: 'string' }] });
    const registry = createOperationRegistry([descriptor]);
    const params = JSON.parse('{"__proto__": {"target": "pwned"}}');
    const result = await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params },
      context(),
    );
    expect(result).toMatchObject({ status: 'rejected', reason: 'invalid-request', effect: 'none' });
    expect(result.summary).toMatch(/unknown parameter/);
    expect(seen).toHaveLength(0);
    expect({}.target).toBeUndefined();
  });

  test('a snapshotted request inherits nothing a handler could read as a parameter', async () => {
    const { descriptor, seen } = recorder({ params: [{ name: 'target', type: 'string' }] });
    const registry = createOperationRegistry([descriptor]);
    const result = await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params: { target: 'safe' } },
      context(),
    );
    expect(result.status).toBe('executed');
    expect(Object.getPrototypeOf(seen[0].request.params)).toBeNull();
  });

  test('a malformed context is refused rather than defaulted', async () => {
    const { descriptor, seen } = recorder();
    const registry = createOperationRegistry([descriptor]);
    const bad = [
      context({ surface: 'slack' }),
      context({ actor: { kind: 'robot', id: 'x' } }),
      context({ actor: { kind: 'human', id: '  ' } }),
      context({ sessionId: '' }),
      context({ requestId: '' }),
      context({ confirmed: 'yes' }),
      context({ issueNumber: 0 }),
      context({ issueNumber: 1.5 }),
      context({ deadlineMs: -1 }),
      context({ deadlineMs: Number.POSITIVE_INFINITY }),
    ];
    for (const ctx of bad) {
      const result = await invokeOperation(
        registry,
        { operationId: 'tool-request.run', params: {} },
        ctx,
      );
      expect(result).toMatchObject({ status: 'rejected', reason: 'invalid-context' });
    }
    expect(seen).toHaveLength(0);
  });

  test('validateOperationContext accepts a well-formed context and a null issue', () => {
    expect(validateOperationContext(context())).toBeNull();
    expect(validateOperationContext(context({ issueNumber: null }))).toBeNull();
    expect(validateOperationContext(context({ deadlineMs: 30_000 }))).toBeNull();
  });
});

describe('parameter validation (contract §4.1)', () => {
  const { descriptor } = recorder({
    params: [
      { name: 'reason', type: 'string', required: true },
      { name: 'attempts', type: 'number' },
      { name: 'force', type: 'boolean' },
      { name: 'label', type: 'string', repeated: true },
    ],
  });
  const registry = createOperationRegistry([descriptor]);

  async function run(params) {
    return invokeOperation(registry, { operationId: 'tool-request.run', params }, context());
  }

  test('an unknown parameter is refused, never ignored', async () => {
    const result = await run({ reason: 'ok', bogus: 'x' });
    expect(result).toMatchObject({ status: 'rejected', reason: 'invalid-request' });
    expect(result.summary).toMatch(/unknown parameter "bogus"/);
  });

  test('a missing required parameter is refused', async () => {
    const result = await run({ attempts: 1 });
    expect(result.summary).toMatch(/missing required parameter "reason"/);
  });

  test('a wrong type is refused', async () => {
    expect((await run({ reason: 5 })).summary).toMatch(/expects a string/);
    expect((await run({ reason: 'ok', attempts: '1' })).summary).toMatch(/expects a number/);
    expect((await run({ reason: 'ok', attempts: Number.NaN })).summary).toMatch(/expects a number/);
    expect((await run({ reason: 'ok', force: 'true' })).summary).toMatch(/expects a boolean/);
  });

  test('an array is refused for a non-repeatable parameter and accepted for a repeatable one', async () => {
    expect((await run({ reason: ['a', 'b'] })).summary).toMatch(/not repeatable/);
    expect((await run({ reason: 'ok', label: ['a', 'b'] })).status).toBe('executed');
    expect((await run({ reason: 'ok', label: [] })).summary).toMatch(/no values/);
    expect((await run({ reason: 'ok', label: ['a', 2] })).summary).toMatch(/expects string values/);
  });

  test('params must be an object, not an argv array', async () => {
    const result = await run(['--reason', 'ok']);
    expect(result).toMatchObject({ status: 'rejected', reason: 'invalid-request' });
    expect(result.summary).toMatch(/params must be an object/);
  });

  test('validateOperationRequest reports the same defects directly', () => {
    expect(validateOperationRequest(descriptor, { operationId: descriptor.id, params: { reason: 'ok' } })).toBeNull();
    expect(
      validateOperationRequest(descriptor, { operationId: descriptor.id, params: {} }),
    ).toMatch(/missing required parameter/);
  });
});

describe('scope is checked by the port (contract §4.2)', () => {
  test('an issue-scoped operation requires a work item', async () => {
    const { descriptor, seen } = recorder({ scope: 'issue' });
    const registry = createOperationRegistry([descriptor]);
    const result = await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params: {} },
      context({ issueNumber: null }),
    );
    expect(result).toMatchObject({ status: 'rejected', reason: 'invalid-context' });
    expect(result.summary).toMatch(/issue-scoped/);
    expect(seen).toHaveLength(0);
  });

  test('a session-scoped operation refuses a work item it would silently ignore', async () => {
    const { descriptor, seen } = recorder({ scope: 'session' });
    const registry = createOperationRegistry([descriptor]);
    const result = await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params: {} },
      context({ issueNumber: 783 }),
    );
    expect(result).toMatchObject({ status: 'rejected', reason: 'invalid-context' });
    expect(result.summary).toMatch(/session-scoped/);
    expect(seen).toHaveLength(0);
  });
});

describe('results are typed and total (contract §7)', () => {
  test('an unregistered or malformed id is rejected, not thrown', async () => {
    const { descriptor } = recorder();
    const registry = createOperationRegistry([descriptor]);
    expect(
      await invokeOperation(registry, { operationId: 'worktree.discard', params: {} }, context()),
    ).toMatchObject({ status: 'rejected', reason: 'unknown-operation', effect: 'none' });
    expect(
      await invokeOperation(registry, { operationId: 'rm -rf /', params: {} }, context()),
    ).toMatchObject({ status: 'rejected', reason: 'unknown-operation' });
    expect(
      await invokeOperation(registry, { operationId: undefined, params: {} }, context()),
    ).toMatchObject({ status: 'rejected', reason: 'unknown-operation' });
  });

  test('a throwing handler yields an indeterminate failure, never an exception', async () => {
    const { descriptor } = recorder({
      run: () => {
        throw new Error('sqlite is busy');
      },
    });
    const registry = createOperationRegistry([descriptor]);
    const result = await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params: {} },
      context(),
    );
    expect(result).toMatchObject({ status: 'failed', reason: 'internal', effect: 'unknown' });
    expect(result.summary).toMatch(/sqlite is busy/);
  });

  test('a rejecting async handler yields the same indeterminate failure', async () => {
    const { descriptor } = recorder({ run: async () => Promise.reject(new Error('boom')) });
    const registry = createOperationRegistry([descriptor]);
    expect(
      await invokeOperation(registry, { operationId: 'tool-request.run', params: {} }, context()),
    ).toMatchObject({ status: 'failed', reason: 'internal', effect: 'unknown' });
  });

  test('a handler that returns a non-result yields an indeterminate failure', async () => {
    const bogusResults = [
      undefined,
      null,
      'ok',
      { ok: true },
      { status: 'executed' },
      { status: 'weird', summary: 'x', effect: 'none' },
      // A reason outside its own closed set: the ChatOps mapping has no row
      // for it, so it must never reach the mapping.
      { status: 'rejected', effect: 'none', summary: 'x', reason: 'made-up' },
      { status: 'failed', effect: 'unknown', summary: 'x', reason: 'precondition-failed' },
      { status: 'failed', effect: 'unknown', summary: 'x' },
    ];
    for (const bogus of bogusResults) {
      const { descriptor } = recorder({ run: () => bogus });
      const registry = createOperationRegistry([descriptor]);
      expect(
        await invokeOperation(registry, { operationId: 'tool-request.run', params: {} }, context()),
      ).toMatchObject({ status: 'failed', reason: 'internal', effect: 'unknown' });
    }
  });

  test('a returned result whose accessors throw yields an indeterminate failure', async () => {
    // Recognising a result means reading fields off an object the port did not
    // build. A handler that has already had its effect must still leave the
    // caller a disposition to record, never an exception.
    const throwingField = (field) => ({
      status: 'executed',
      effect: 'applied',
      summary: 'resolved 1 request',
      get [field]() {
        throw new Error(`${field} accessor exploded`);
      },
    });
    for (const field of ['status', 'summary', 'effect', 'data']) {
      const { descriptor } = recorder({ run: () => throwingField(field) });
      const registry = createOperationRegistry([descriptor]);
      const result = await invokeOperation(
        registry,
        { operationId: 'tool-request.run', params: {} },
        context(),
      );
      expect(result).toMatchObject({ status: 'failed', reason: 'internal', effect: 'unknown' });
      expect(result.summary).toMatch(/accessor exploded/);
    }
  });

  test('a result is read once, so a field cannot answer differently after validation', async () => {
    let reads = 0;
    const { descriptor } = recorder({
      run: () => ({
        status: 'executed',
        effect: 'none',
        get summary() {
          reads += 1;
          return reads === 1 ? 'first read' : 'second read';
        },
      }),
    });
    const registry = createOperationRegistry([descriptor]);
    const result = await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params: {} },
      context(),
    );
    expect(result.summary).toBe('first read');
    expect(reads).toBe(1);
  });

  test('a rejection is effect-free by construction and a failure states its effect', () => {
    expect(operationRejected('precondition-failed', 'no such request')).toEqual({
      status: 'rejected',
      reason: 'precondition-failed',
      summary: 'no such request',
      effect: 'none',
    });
    expect(operationFailed('unavailable', 'none', 'provider is down')).toEqual({
      status: 'failed',
      reason: 'unavailable',
      effect: 'none',
      summary: 'provider is down',
    });
  });

  test('an executed result defaults to an applied effect and carries optional data', () => {
    expect(operationExecuted('done')).toEqual({ status: 'executed', effect: 'applied', summary: 'done' });
    expect(operationExecuted('would do', { effect: 'none', data: { n: 1 } })).toEqual({
      status: 'executed',
      effect: 'none',
      summary: 'would do',
      data: { n: 1 },
    });
  });

  test('summaries are bounded with a visible marker, in and out of the port', async () => {
    const long = 'x'.repeat(OPERATION_SUMMARY_MAX_CHARS + 50);
    expect(boundOperationSummary('short')).toBe('short');
    expect(boundOperationSummary(long)).toMatch(/… \(truncated\)$/);
    expect(boundOperationSummary(long).length).toBeLessThan(long.length);
    // The marker counts against the bound, so a bounded summary fits a column
    // sized from OPERATION_SUMMARY_MAX_CHARS (contract §12).
    expect(boundOperationSummary(long).length).toBeLessThanOrEqual(OPERATION_SUMMARY_MAX_CHARS);
    for (const overBy of [1, 2, 20]) {
      const over = 'y'.repeat(OPERATION_SUMMARY_MAX_CHARS + overBy);
      expect(boundOperationSummary(over).length).toBeLessThanOrEqual(OPERATION_SUMMARY_MAX_CHARS);
    }
    expect(boundOperationSummary('z'.repeat(OPERATION_SUMMARY_MAX_CHARS))).toHaveLength(
      OPERATION_SUMMARY_MAX_CHARS,
    );

    const { descriptor } = recorder({ run: () => ({ status: 'executed', effect: 'applied', summary: long }) });
    const registry = createOperationRegistry([descriptor]);
    const result = await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params: {} },
      context(),
    );
    expect(result.summary).toMatch(/… \(truncated\)$/);
    expect(result.summary.length).toBeLessThanOrEqual(OPERATION_SUMMARY_MAX_CHARS);
  });

  test('a non-object context is rejected rather than dereferenced', async () => {
    const { descriptor, seen } = recorder();
    const registry = createOperationRegistry([descriptor]);
    for (const bogus of [null, undefined, 'admin-cli', 42, ['admin-cli']]) {
      const result = await invokeOperation(
        registry,
        { operationId: 'tool-request.run', params: {} },
        bogus,
      );
      expect(result).toMatchObject({ status: 'rejected', reason: 'invalid-context', effect: 'none' });
    }
    expect(seen).toHaveLength(0);
  });

  test('a malformed value that cannot be JSON-serialized is still described, not thrown on', async () => {
    const { descriptor, seen } = recorder();
    const registry = createOperationRegistry([descriptor]);
    const circular = { self: null };
    circular.self = circular;
    const hostile = {
      toJSON() {
        throw new Error('no serialization for you');
      },
    };
    // Every one of these is ordinary JavaScript an adapter can hand the port,
    // and every one of them makes JSON.stringify throw.
    for (const id of [1n, circular, hostile, Symbol('worktree.discard'), Number.NaN]) {
      const result = await invokeOperation(registry, { operationId: id, params: {} }, context());
      expect(result).toMatchObject({ status: 'rejected', reason: 'unknown-operation', effect: 'none' });
      expect(typeof result.summary).toBe('string');
    }
    for (const surface of [1n, circular, hostile]) {
      expect(
        await invokeOperation(
          registry,
          { operationId: 'tool-request.run', params: {} },
          context({ surface }),
        ),
      ).toMatchObject({ status: 'rejected', reason: 'invalid-context' });
    }
    for (const issueNumber of [1n, circular, hostile]) {
      expect(
        await invokeOperation(
          registry,
          { operationId: 'tool-request.run', params: {} },
          context({ issueNumber }),
        ),
      ).toMatchObject({ status: 'rejected', reason: 'invalid-context' });
    }
    expect(seen).toHaveLength(0);
  });

  test('a handler that throws a value with no usable string form still yields a failure', async () => {
    const { descriptor } = recorder({
      run: () => {
        throw {
          toString() {
            throw new Error('not even a message');
          },
        };
      },
    });
    const registry = createOperationRegistry([descriptor]);
    const result = await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params: {} },
      context(),
    );
    expect(result).toMatchObject({ status: 'failed', reason: 'internal', effect: 'unknown' });
    expect(typeof result.summary).toBe('string');
  });

  test('a non-object request is rejected rather than dereferenced', async () => {
    const { descriptor, seen } = recorder();
    const registry = createOperationRegistry([descriptor]);
    for (const bogus of [null, undefined, 'tool-request.run', 7, ['tool-request', 'run']]) {
      const result = await invokeOperation(registry, bogus, context());
      expect(result).toMatchObject({ status: 'rejected', reason: 'invalid-request', effect: 'none' });
    }
    expect(seen).toHaveLength(0);
  });

  test('a request field that throws while being read is rejected, not thrown', async () => {
    // The adapter's half is an object the port did not build, so any field on it
    // may be an accessor that explodes. A dispatch attempt that threw here would
    // leave the ChatOps ledger's T2→T3 window with no disposition at all.
    const { descriptor, seen } = recorder();
    const registry = createOperationRegistry([descriptor]);
    for (const field of ['operationId', 'params']) {
      const request = { operationId: 'tool-request.run', params: {} };
      delete request[field];
      Object.defineProperty(request, field, {
        enumerable: true,
        get() {
          throw new Error(`${field} accessor exploded`);
        },
      });
      const result = await invokeOperation(registry, request, context());
      expect(result).toMatchObject({ status: 'rejected', reason: 'invalid-request', effect: 'none' });
      expect(result.summary).toMatch(/accessor exploded/);
    }
    expect(seen).toHaveLength(0);
  });

  test('a context field that throws while being read is rejected, not thrown', async () => {
    const { descriptor, seen } = recorder();
    const registry = createOperationRegistry([descriptor]);
    for (const field of ['surface', 'actor', 'sessionId', 'requestId', 'issueNumber', 'confirmed']) {
      const ctx = context();
      delete ctx[field];
      Object.defineProperty(ctx, field, {
        enumerable: true,
        get() {
          throw new Error(`${field} accessor exploded`);
        },
      });
      const result = await invokeOperation(
        registry,
        { operationId: 'tool-request.run', params: {} },
        ctx,
      );
      expect(result).toMatchObject({ status: 'rejected', reason: 'invalid-context', effect: 'none' });
      expect(result.summary).toMatch(/accessor exploded/);
    }
    expect(seen).toHaveLength(0);
  });

  test('a proxy whose get trap throws is rejected on either half', async () => {
    const { descriptor, seen } = recorder();
    const registry = createOperationRegistry([descriptor]);
    const hostile = (target) =>
      new Proxy(target, {
        get() {
          throw new Error('trap exploded');
        },
      });
    expect(
      await invokeOperation(
        registry,
        hostile({ operationId: 'tool-request.run', params: {} }),
        context(),
      ),
    ).toMatchObject({ status: 'rejected', reason: 'invalid-request', effect: 'none' });
    expect(
      await invokeOperation(
        registry,
        { operationId: 'tool-request.run', params: {} },
        hostile(context()),
      ),
    ).toMatchObject({ status: 'rejected', reason: 'invalid-context', effect: 'none' });
    expect(seen).toHaveLength(0);
  });

  test('the operation id is read once, so a second read cannot redirect dispatch', async () => {
    let reads = 0;
    const { descriptor, seen } = recorder();
    const registry = createOperationRegistry([descriptor]);
    const request = {
      params: {},
      get operationId() {
        reads += 1;
        return reads === 1 ? 'tool-request.run' : 'worktree.discard';
      },
    };
    const result = await invokeOperation(registry, request, context());
    expect(result).toMatchObject({ status: 'executed' });
    expect(reads).toBe(1);
    expect(seen).toHaveLength(1);
  });
});

describe('confirmation is trusted context (contract §5.2)', () => {
  test('an unconfirmed invocation reaches the handler unchanged', async () => {
    const { descriptor, seen } = recorder({
      run: (invocation) => {
        seen.push(invocation);
        return operationExecuted('would resolve 1 request', { effect: 'none' });
      },
    });
    const registry = createOperationRegistry([descriptor]);
    const result = await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params: {} },
      context({ confirmed: false }),
    );
    expect(result).toMatchObject({ status: 'executed', effect: 'none' });
    expect(seen[0].context.confirmed).toBe(false);
  });

  test('applied effects under an unconfirmed invocation are downgraded to indeterminate', async () => {
    const { descriptor } = recorder({
      run: () => operationExecuted('resolved 1 request', { effect: 'applied' }),
    });
    const registry = createOperationRegistry([descriptor]);
    const result = await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params: {} },
      context({ confirmed: false }),
    );
    expect(result).toMatchObject({ status: 'failed', reason: 'internal', effect: 'unknown' });
    expect(result.summary).toMatch(/resolved 1 request/);
  });

  test('a non-mutating operation that reports applied effects is downgraded too', async () => {
    const { descriptor } = recorder({
      mutating: false,
      run: () => operationExecuted('rewrote the session file', { effect: 'applied' }),
    });
    const registry = createOperationRegistry([descriptor]);
    const result = await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params: {} },
      context({ confirmed: true }),
    );
    expect(result).toMatchObject({ status: 'failed', reason: 'internal', effect: 'unknown' });
    expect(result.summary).toMatch(/non-mutating operation/);
  });

  test('a handler cannot confirm itself by mutating the context it was handed', async () => {
    // The handler holds the caller's context object. If the postcondition were
    // re-read after the run, writing `confirmed = true` from inside the handler
    // would launder unauthorized effects into an acknowledged success.
    const { descriptor } = recorder({
      run: (invocation) => {
        invocation.context.confirmed = true;
        return operationExecuted('resolved 1 request', { effect: 'applied' });
      },
    });
    const registry = createOperationRegistry([descriptor]);
    const result = await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params: {} },
      context({ confirmed: false }),
    );
    expect(result).toMatchObject({ status: 'failed', reason: 'internal', effect: 'unknown' });
    expect(result.summary).toMatch(/unconfirmed invocation/);
  });

  test('a handler cannot declare itself mutating by rewriting its own descriptor', async () => {
    const { descriptor } = recorder({
      mutating: false,
      run: () => {
        descriptor.mutating = true;
        return operationExecuted('rewrote the session file', { effect: 'applied' });
      },
    });
    const registry = createOperationRegistry([descriptor]);
    const result = await invokeOperation(
      registry,
      { operationId: 'tool-request.run', params: {} },
      context({ confirmed: true }),
    );
    expect(result).toMatchObject({ status: 'failed', reason: 'internal', effect: 'unknown' });
    expect(result.summary).toMatch(/non-mutating operation/);
  });

  test('a descriptor rewritten during one run does not authorize the next one', async () => {
    // The downgrade above must not depend on the snapshot alone: if the
    // registry handed out the caller's descriptor, the write would survive the
    // call and the *second* invocation would read metadata nobody registered.
    const { descriptor } = recorder({
      mutating: false,
      run: () => {
        descriptor.mutating = true;
        return operationExecuted('rewrote the session file', { effect: 'applied' });
      },
    });
    const registry = createOperationRegistry([descriptor]);
    const request = { operationId: 'tool-request.run', params: {} };
    await invokeOperation(registry, request, context({ confirmed: true }));
    expect(descriptor.mutating).toBe(true);
    const second = await invokeOperation(registry, request, context({ confirmed: true }));
    expect(second).toMatchObject({ status: 'failed', reason: 'internal', effect: 'unknown' });
    expect(second.summary).toMatch(/non-mutating operation/);
  });

  test('a non-mutating operation reporting no effect is left alone', async () => {
    const { descriptor } = recorder({
      mutating: false,
      run: () => operationExecuted('3 locks held', { effect: 'none', data: { count: 3 } }),
    });
    const registry = createOperationRegistry([descriptor]);
    expect(
      await invokeOperation(registry, { operationId: 'tool-request.run', params: {} }, context()),
    ).toMatchObject({ status: 'executed', effect: 'none', data: { count: 3 } });
  });
});

describe('the port never becomes a subprocess (contract §6)', () => {
  /** Source with comments removed, so the rules may still be written down in the code they govern. */
  function code(rel) {
    return readFileSync(resolve(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  for (const rel of ['src/core/operation-port.ts', 'src/core/chatops-operation-dispatch.ts']) {
    test(`${rel} spawns nothing, exits nothing, prints nothing`, () => {
      const source = code(rel);
      expect(source).not.toMatch(/child_process/);
      expect(source).not.toMatch(/\bspawn\w*\(/);
      expect(source).not.toMatch(/\bexecFile\w*\(/);
      expect(source).not.toMatch(/\bexecSync\(/);
      expect(source).not.toMatch(/admin\.js/);
      expect(source).not.toMatch(/process\.exit/);
      expect(source).not.toMatch(/console\./);
      // The port carries no argv-shaped field: an adapter has nothing to fill.
      expect(source).not.toMatch(/\bargv\b/);
    });
  }
});
