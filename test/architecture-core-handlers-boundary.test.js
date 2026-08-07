/**
 * Architecture/dependency test for issue #883 (follow-up to #745).
 *
 * `src/core/` is the Orchestration layer (DOMAIN.md §2 — "pure policy
 * functions", "Depends on: nothing"); `src/handlers/` is the Execution layer.
 * A *value* import from `core/` into `handlers/` reverses that direction —
 * before #883, `core/transitions.ts` imported the runtime constant
 * `ARTIFACT_DIR_PENDING_CONTEXT_FIELD` from `handlers/artifact-dir.ts`
 * (DOMAIN.md §1.2's fifth, runtime-only boundary leak). #883 moved the
 * constant into `core/artifact-dir-contract.ts`, which `handlers/artifact-dir.ts`
 * now re-exports for its own existing consumers.
 *
 * This file scans every `src/core/*.ts` module for imports whose specifier
 * points at `handlers/` and fails the build if any of them pulls a runtime
 * value rather than a type. `import type { ... }` and `import { type X }`
 * are exempt: a type-only import erases at compile time and creates no
 * runtime dependency, so it does not violate the layering rule DOMAIN.md
 * §2.3's Orchestration row states ("Depends on: nothing" is about runtime
 * coupling, not type shapes — see DOMAIN.md §1.2's own four *type-only*
 * leaks, which are recorded as accepted debt, not repaired here).
 *
 * One pre-existing runtime leak is out of this issue's scope (introduced by
 * #839, unrelated to artifact directories) and is carried forward via an
 * explicit allowlist rather than silently ignored — the same
 * recorded-but-not-repaired pattern DOMAIN.md §1.2 and
 * docs/handlers-extraction-plan.md §1.4/§10.5 already use for the leaks they
 * do not fix. Fixing it would be the "broad handler extraction or
 * repository-wide module restructuring" issue #883 explicitly puts out of
 * scope.
 */
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIR = resolve(ROOT, 'src/core');

// key: "<core-file>:<import-specifier>" — every entry here is a runtime
// (non-type) import from a src/core/*.ts file into src/handlers/ that this
// test would otherwise reject. Adding an entry here is a scope decision, not
// a way to silence the test: it must be justified the same way the existing
// entry is, in a PR description or an issue, not merely to make CI pass.
const ALLOWED_RUNTIME_HANDLER_IMPORTS = new Set([
  // core/review-arbiter-profile.ts (#839) — codex model/effort resolution,
  // unrelated to the artifact-dir contract #883 repairs. Pre-existing at the
  // time #883 was filed; repairing it is repository-wide restructuring
  // outside this issue's scope.
  'review-arbiter-profile.ts:../handlers/codex-context-mode.js',
]);

function listCoreFiles() {
  return readdirSync(CORE_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
}

/**
 * Classifies an `import`/`export` clause (the text between the keyword and
 * `from`) as type-only or not. A whole-clause `type { ... }` / `type * as ns`
 * is type-only; a brace clause where every individual specifier is itself
 * `type`-prefixed is also type-only; anything else (a default/namespace
 * import, `* from`, `* as ns from`, or a brace clause with at least one
 * non-`type` specifier) is a runtime import.
 */
function isTypeOnlyClause(clause) {
  const trimmed = clause.trim();
  if (/^type\s/.test(trimmed)) return true;
  if (/^\{[\s\S]*\}$/.test(trimmed)) {
    const specifiers = trimmed
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return specifiers.length > 0 && specifiers.every((s) => /^type\s/.test(s));
  }
  return false;
}

/**
 * Finds every runtime module-loading form in `source` whose specifier
 * references `handlers/`, and classifies each as type-only or not:
 *   - `import <clause> from "<specifier>"` (default/namespace/named, incl.
 *     `import type ...`) — type-only per `isTypeOnlyClause`.
 *   - `import "<specifier>"` (side-effect import) — always runtime.
 *   - `import("<specifier>")` (dynamic import) — always runtime; a dynamic
 *     import erases nothing at compile time, so it can never be type-only.
 *   - `export <clause> from "<specifier>"` (re-export, incl. `export * from`,
 *     `export * as ns from`, `export type { ... } from`) — type-only per
 *     `isTypeOnlyClause`.
 */
function findHandlerImports(source) {
  const results = [];
  const push = (specifier, isTypeOnly) => {
    if (specifier.includes('/handlers/')) results.push({ specifier, isTypeOnly });
  };

  const staticImportRe = /import\s+([^;]+?)\s+from\s*["']([^"']+)["']/g;
  let match;
  while ((match = staticImportRe.exec(source))) {
    push(match[2], isTypeOnlyClause(match[1]));
  }

  const sideEffectImportRe = /import\s*["']([^"']+)["']\s*;/g;
  while ((match = sideEffectImportRe.exec(source))) {
    push(match[1], false);
  }

  const dynamicImportRe = /import\s*\(\s*["']([^"']+)["']/g;
  while ((match = dynamicImportRe.exec(source))) {
    push(match[1], false);
  }

  const reExportRe = /export\s+([^;]+?)\s+from\s*["']([^"']+)["']/g;
  while ((match = reExportRe.exec(source))) {
    push(match[2], isTypeOnlyClause(match[1]));
  }

  return results;
}

describe('architecture: src/core must not runtime-depend on src/handlers', () => {
  test('every src/core/*.ts import from handlers/ is either type-only or explicitly allowlisted', () => {
    const violations = [];
    for (const file of listCoreFiles()) {
      const source = readFileSync(join(CORE_DIR, file), 'utf8');
      for (const imp of findHandlerImports(source)) {
        if (imp.isTypeOnly) continue;
        const key = `${file}:${imp.specifier}`;
        if (ALLOWED_RUNTIME_HANDLER_IMPORTS.has(key)) continue;
        violations.push(key);
      }
    }
    expect(violations).toEqual([]);
  });

  test.each([
    ['side-effect import', 'import "../handlers/foo.js";'],
    ['dynamic import', 'const m = await import("../handlers/foo.js");'],
    ['dynamic import with space before paren', 'await import ("../handlers/foo.js");'],
    ['named re-export', 'export { X } from "../handlers/foo.js";'],
    ['wildcard re-export', 'export * from "../handlers/foo.js";'],
    ['namespaced wildcard re-export', 'export * as ns from "../handlers/foo.js";'],
  ])('findHandlerImports detects %s as a runtime handlers/ import', (_label, snippet) => {
    const found = findHandlerImports(snippet);
    expect(found).toEqual([{ specifier: '../handlers/foo.js', isTypeOnly: false }]);
  });

  test('findHandlerImports still recognizes type-only re-exports as type-only', () => {
    const found = findHandlerImports('export type { X } from "../handlers/foo.js";');
    expect(found).toEqual([{ specifier: '../handlers/foo.js', isTypeOnly: true }]);
  });

  test('the allowlist does not include the artifact-dir leak #883 repairs', () => {
    for (const key of ALLOWED_RUNTIME_HANDLER_IMPORTS) {
      expect(key).not.toMatch(/artifact-dir/);
    }
  });

  test('core/transitions.ts no longer imports ARTIFACT_DIR_PENDING_CONTEXT_FIELD from handlers/artifact-dir.ts', () => {
    const source = readFileSync(join(CORE_DIR, 'transitions.ts'), 'utf8');
    expect(source).not.toMatch(/from\s*["']\.\.\/handlers\/artifact-dir\.js["']/);
    expect(source).toMatch(
      /import\s*\{\s*ARTIFACT_DIR_PENDING_CONTEXT_FIELD\s*\}\s*from\s*["']\.\/artifact-dir-contract\.js["']/,
    );
  });

  test('core/artifact-dir-contract.ts declares the constant and handlers/artifact-dir.ts re-exports it unchanged', () => {
    const contract = readFileSync(join(CORE_DIR, 'artifact-dir-contract.ts'), 'utf8');
    expect(contract).toMatch(/export const ARTIFACT_DIR_PENDING_CONTEXT_FIELD = "artifactDirPending";/);

    const handler = readFileSync(resolve(ROOT, 'src/handlers/artifact-dir.ts'), 'utf8');
    expect(handler).toMatch(
      /export\s*\{\s*ARTIFACT_DIR_PENDING_CONTEXT_FIELD\s*\}\s*from\s*["']\.\.\/core\/artifact-dir-contract\.js["']/,
    );
    expect(handler).not.toMatch(/export const ARTIFACT_DIR_PENDING_CONTEXT_FIELD/);
  });
});
