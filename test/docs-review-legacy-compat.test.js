/**
 * Structural tests for docs/review-legacy-compat.md (issue #842).
 *
 * Pins the deployment/rollback claims a follow-up implementer must not have
 * to rediscover: the resolver is pure (no migration, no persisted "converted"
 * flag), the precedence rule is deterministic, and rollback/disable never
 * deletes existing task context.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8').replace(/\s+/g, ' ');
}

const doc = read('docs/review-legacy-compat.md');

describe('docs/review-legacy-compat.md — scope and authority', () => {
  test('defers to review-dispute-contract.md rather than redefining it', () => {
    expect(doc).toMatch(/does not redefine anything `review-dispute-contract\.md` §13 already specifies/);
  });

  test('names the exact boundary it implements', () => {
    expect(doc).toMatch(/src\/handlers\/implementation\.ts/);
    expect(doc).toMatch(/resolveReviewCompatContext/);
  });
});

describe('docs/review-legacy-compat.md — precedence and fail-closed rule', () => {
  test('states the one precedence rule is deterministic', () => {
    expect(doc).toMatch(/Precedence rule \(one, applied deterministically\)/);
  });

  test('states malformed structured state fails closed rather than being repaired', () => {
    expect(doc).toMatch(/never falls back to a partial or "best effort" reading of itself/);
    expect(doc).toMatch(/reject the whole block, keep whatever legacy prose exists/);
  });

  test('states a structured review is authoritative even with stale legacy text present', () => {
    expect(doc).toMatch(/no legacy finding is reported even if `reviewFeedback` still holds text/);
  });
});

describe('docs/review-legacy-compat.md — deployment and rollback', () => {
  test('states the resolver is pure with no persisted conversion flag or migration', () => {
    expect(doc).toMatch(/There is no persisted "converted" flag and no migration/);
  });

  test('covers old, mixed-version, and newly structured snapshots', () => {
    expect(doc).toMatch(/\*\*Old snapshots\*\*/);
    expect(doc).toMatch(/\*\*Mixed-version snapshots\*\*/);
    expect(doc).toMatch(/\*\*Newly structured snapshots\*\*/);
  });

  test('states rollback and disabling never delete existing task context', () => {
    expect(doc).toMatch(/no code path here ever deletes a field, migrates a record/);
  });
});

describe('docs/review-legacy-compat.md — out of scope', () => {
  test('disclaims envelope generation/parsing (#841), prompt disposition (#837), and transitions (#840)', () => {
    expect(doc).toMatch(/issue #841 owns that/);
    expect(doc).toMatch(/issue #837 owns that/);
    expect(doc).toMatch(/issue #840 and its upstream routing issues own that/);
  });

  test('states legacy prose is never eligible for a structured dispute', () => {
    expect(doc).toMatch(/never makes legacy prose eligible for a structured dispute/);
  });
});
