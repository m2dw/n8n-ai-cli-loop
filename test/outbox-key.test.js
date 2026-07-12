import { makeOutboxKey } from '../dist/core/outbox.js';

describe('makeOutboxKey', () => {
  test('joins parts with colon', () => {
    expect(makeOutboxKey('session1', 42, 'run-abc', 'gh:comment')).toBe('session1:42:run-abc:gh:comment');
  });

  test('converts numbers to strings', () => {
    expect(makeOutboxKey('s', 0, 'r')).toBe('s:0:r');
  });

  test('single part', () => {
    expect(makeOutboxKey('only')).toBe('only');
  });

  test('all string parts', () => {
    expect(makeOutboxKey('a', 'b', 'c')).toBe('a:b:c');
  });

  test('produces same key for same inputs (stable)', () => {
    const k1 = makeOutboxKey('s', 1, 'run', 'gh:label:add', 'ai:active');
    const k2 = makeOutboxKey('s', 1, 'run', 'gh:label:add', 'ai:active');
    expect(k1).toBe(k2);
  });

  test('different inputs produce different keys', () => {
    const k1 = makeOutboxKey('s', 1, 'run', 'gh:comment', 'implementation', 'success');
    const k2 = makeOutboxKey('s', 1, 'run', 'gh:comment', 'review', 'success');
    expect(k1).not.toBe(k2);
  });
});
