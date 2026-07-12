import {
  walkFiles,
  countLines,
  countTests,
  buildImportGraph,
  findCircularDeps,
  makeBadge,
  coverageColor,
} from '../scripts/metrics.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TMP = join(tmpdir(), `metrics-test-${process.pid}`);

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// walkFiles
// ---------------------------------------------------------------------------

describe('walkFiles', () => {
  test('finds files matching filter and recurses into subdirectories', () => {
    const dir = join(TMP, 'walk');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a.ts'), '');
    writeFileSync(join(dir, 'b.js'), '');
    writeFileSync(join(dir, 'sub', 'c.ts'), '');

    const found = walkFiles(dir, n => n.endsWith('.ts')).map(p => p.replace(dir, ''));
    expect(found).toHaveLength(2);
    expect(found.some(p => p.endsWith('a.ts'))).toBe(true);
    expect(found.some(p => p.endsWith('c.ts'))).toBe(true);
    expect(found.some(p => p.endsWith('b.js'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// countLines
// ---------------------------------------------------------------------------

describe('countLines', () => {
  test('counts total and non-blank lines', () => {
    const f = join(TMP, 'lines.ts');
    writeFileSync(f, 'line1\n\nline3\n');
    const { total, nonBlank } = countLines([f]);
    // terminal newline must not add an extra LOC: ['line1', '', 'line3'] = 3
    expect(total).toBe(3);
    expect(nonBlank).toBe(2);
  });

  test('accumulates across multiple files', () => {
    const f1 = join(TMP, 'f1.ts');
    const f2 = join(TMP, 'f2.ts');
    writeFileSync(f1, 'a\nb\n');
    writeFileSync(f2, 'c\n\nd\n');
    const { total, nonBlank } = countLines([f1, f2]);
    expect(nonBlank).toBe(4); // a, b, c, d
  });
});

// ---------------------------------------------------------------------------
// countTests
// ---------------------------------------------------------------------------

describe('countTests', () => {
  test('counts test/it calls and describe blocks', () => {
    const f = join(TMP, 'sample.test.js');
    writeFileSync(
      f,
      [
        "describe('suite', () => {",
        "  test('case 1', () => {});",
        "  it('case 2', () => {});",
        '});',
      ].join('\n')
    );
    const { cases, suites } = countTests([f]);
    expect(cases).toBe(2);
    expect(suites).toBe(1);
  });

  test('returns zeros for empty file list', () => {
    const { cases, suites } = countTests([]);
    expect(cases).toBe(0);
    expect(suites).toBe(0);
  });

  test('counts test.each and it.each as additional cases', () => {
    const f = join(TMP, 'each.test.js');
    writeFileSync(
      f,
      [
        "describe('suite', () => {",
        "  test.each([[1], [2]])('case %i', (n) => {});",
        "  it.each`a`('case $a', ({a}) => {});",
        '});',
      ].join('\n')
    );
    const { cases, suites } = countTests([f]);
    expect(cases).toBe(2);
    expect(suites).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildImportGraph
// ---------------------------------------------------------------------------

describe('buildImportGraph', () => {
  test('maps relative imports to graph edges', () => {
    const dir = join(TMP, 'graph-basic');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.ts'), "import { b } from './b';\nexport const a = 1;\n");
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');

    const files = [join(dir, 'a.ts'), join(dir, 'b.ts')];
    const graph = buildImportGraph(files, dir);

    expect(graph.get('a').has('b')).toBe(true);
    expect(graph.get('b').size).toBe(0);
  });

  test('ignores non-relative (node_modules) imports', () => {
    const dir = join(TMP, 'graph-external');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.ts'), "import { x } from 'some-package';\n");

    const files = [join(dir, 'a.ts')];
    const graph = buildImportGraph(files, dir);

    expect(graph.get('a').size).toBe(0);
  });

  test('does not add edges for import type declarations', () => {
    const dir = join(TMP, 'graph-type-only');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.ts'), "import type { B } from './b';\nexport const a = 1;\n");
    writeFileSync(join(dir, 'b.ts'), 'export type B = string;\n');

    const files = [join(dir, 'a.ts'), join(dir, 'b.ts')];
    const graph = buildImportGraph(files, dir);

    expect(graph.get('a').size).toBe(0);
  });

  test('tracks edges from multiline imports', () => {
    const dir = join(TMP, 'graph-multiline');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'a.ts'),
      "import {\n  Foo,\n  Bar,\n} from './b';\nexport const a = 1;\n"
    );
    writeFileSync(join(dir, 'b.ts'), 'export class Foo {}\nexport class Bar {}\n');

    const files = [join(dir, 'a.ts'), join(dir, 'b.ts')];
    const graph = buildImportGraph(files, dir);

    expect(graph.get('a').has('b')).toBe(true);
  });

  test('does not add edges for multiline import type declarations', () => {
    const dir = join(TMP, 'graph-multiline-type');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'a.ts'),
      "import type {\n  Foo,\n  Bar,\n} from './b';\nexport const a = 1;\n"
    );
    writeFileSync(join(dir, 'b.ts'), 'export type Foo = string;\nexport type Bar = number;\n');

    const files = [join(dir, 'a.ts'), join(dir, 'b.ts')];
    const graph = buildImportGraph(files, dir);

    expect(graph.get('a').size).toBe(0);
  });

  test('tracks edges from named re-export (export { X } from)', () => {
    const dir = join(TMP, 'graph-reexport-named');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'barrel.ts'), "export { foo } from './impl';\n");
    writeFileSync(join(dir, 'impl.ts'), 'export const foo = 1;\n');

    const files = [join(dir, 'barrel.ts'), join(dir, 'impl.ts')];
    const graph = buildImportGraph(files, dir);

    expect(graph.get('barrel').has('impl')).toBe(true);
    expect(graph.get('impl').size).toBe(0);
  });

  test('tracks edges from wildcard re-export (export * from)', () => {
    const dir = join(TMP, 'graph-reexport-star');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'barrel.ts'), "export * from './impl';\n");
    writeFileSync(join(dir, 'impl.ts'), 'export const foo = 1;\n');

    const files = [join(dir, 'barrel.ts'), join(dir, 'impl.ts')];
    const graph = buildImportGraph(files, dir);

    expect(graph.get('barrel').has('impl')).toBe(true);
  });

  test('tracks edges from namespace re-export (export * as X from)', () => {
    const dir = join(TMP, 'graph-reexport-ns');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'barrel.ts'), "export * as impl from './impl';\n");
    writeFileSync(join(dir, 'impl.ts'), 'export const foo = 1;\n');

    const files = [join(dir, 'barrel.ts'), join(dir, 'impl.ts')];
    const graph = buildImportGraph(files, dir);

    expect(graph.get('barrel').has('impl')).toBe(true);
  });

  test('does not add edges for export type re-exports', () => {
    const dir = join(TMP, 'graph-reexport-type');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'barrel.ts'), "export type { Foo } from './types';\n");
    writeFileSync(join(dir, 'types.ts'), 'export type Foo = string;\n');

    const files = [join(dir, 'barrel.ts'), join(dir, 'types.ts')];
    const graph = buildImportGraph(files, dir);

    expect(graph.get('barrel').size).toBe(0);
  });

  test('detects cycle through barrel re-export', () => {
    const dir = join(TMP, 'graph-reexport-cycle');
    mkdirSync(dir, { recursive: true });
    // a imports from barrel, barrel re-exports from a — cycle
    writeFileSync(join(dir, 'a.ts'), "import { foo } from './barrel';\nexport const bar = 1;\n");
    writeFileSync(join(dir, 'barrel.ts'), "export { bar } from './a';\nexport const foo = 2;\n");

    const files = [join(dir, 'a.ts'), join(dir, 'barrel.ts')];
    const graph = buildImportGraph(files, dir);
    const cycles = findCircularDeps(graph);

    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// findCircularDeps
// ---------------------------------------------------------------------------

describe('findCircularDeps', () => {
  test('returns empty array for acyclic graph', () => {
    const dir = join(TMP, 'scc-acyclic');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.ts'), "import { b } from './b';\n");
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');

    const files = [join(dir, 'a.ts'), join(dir, 'b.ts')];
    const graph = buildImportGraph(files, dir);
    expect(findCircularDeps(graph)).toHaveLength(0);
  });

  test('detects mutual circular import as one SCC', () => {
    const dir = join(TMP, 'scc-mutual');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x.ts'), "import { y } from './y';\nexport const x = 1;\n");
    writeFileSync(join(dir, 'y.ts'), "import { x } from './x';\nexport const y = 1;\n");

    const files = [join(dir, 'x.ts'), join(dir, 'y.ts')];
    const graph = buildImportGraph(files, dir);
    const cycles = findCircularDeps(graph);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(2);
  });

  test('detects three-node cycle', () => {
    const dir = join(TMP, 'scc-three');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'p.ts'), "import { q } from './q';\n");
    writeFileSync(join(dir, 'q.ts'), "import { r } from './r';\n");
    writeFileSync(join(dir, 'r.ts'), "import { p } from './p';\n");

    const files = [join(dir, 'p.ts'), join(dir, 'q.ts'), join(dir, 'r.ts')];
    const graph = buildImportGraph(files, dir);
    const cycles = findCircularDeps(graph);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// makeBadge / coverageColor
// ---------------------------------------------------------------------------

describe('makeBadge', () => {
  test('returns Shields.io endpoint shape', () => {
    expect(makeBadge('coverage', '85%', 'green')).toEqual({
      schemaVersion: 1,
      label: 'coverage',
      message: '85%',
      color: 'green',
    });
  });

  test('coerces message to string', () => {
    const badge = makeBadge('loc', 12345, 'blue');
    expect(typeof badge.message).toBe('string');
    expect(badge.message).toBe('12345');
  });
});

describe('coverageColor', () => {
  test.each([
    [100, 'brightgreen'],
    [80, 'brightgreen'],
    [79, 'yellow'],
    [60, 'yellow'],
    [59, 'red'],
    [0, 'red'],
  ])('%i% → %s', (pct, expected) => {
    expect(coverageColor(pct)).toBe(expected);
  });
});
