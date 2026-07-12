/**
 * Unit tests for outbox-effects helpers.
 */
import { formatDuration } from '../dist/core/outbox-effects.js';

describe('formatDuration', () => {
  test('returns "unknown" when ms is undefined', () => {
    expect(formatDuration(undefined)).toBe('unknown');
  });

  test('formats 0ms as 0s', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  test('formats sub-minute duration in seconds', () => {
    expect(formatDuration(37000)).toBe('37s');
  });

  test('formats 59 seconds', () => {
    expect(formatDuration(59000)).toBe('59s');
  });

  test('formats exactly 60 seconds as 1m', () => {
    expect(formatDuration(60000)).toBe('1m');
  });

  test('formats exactly 2 minutes', () => {
    expect(formatDuration(120000)).toBe('2m');
  });

  test('formats 4 minutes 12 seconds', () => {
    expect(formatDuration(252000)).toBe('4m 12s');
  });

  test('rounds to nearest second', () => {
    expect(formatDuration(37499)).toBe('37s');
    expect(formatDuration(37500)).toBe('38s');
  });

  test('formats large durations', () => {
    expect(formatDuration(3661000)).toBe('61m 1s');
  });
});
