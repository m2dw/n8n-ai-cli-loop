import {
  walkFiles,
  countLines,
  countTests,
  buildImportGraph,
  findCircularDeps,
  makeBadge,
  coverageColor,
  measureText,
  makeSvgBadge,
  metricsValuesEqual,
  main,
} from '../scripts/metrics.mjs';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
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

// ---------------------------------------------------------------------------
// measureText
// ---------------------------------------------------------------------------

describe('measureText', () => {
  test('returns a positive number for non-empty text', () => {
    expect(measureText('hello')).toBeGreaterThan(0);
  });

  test('narrow characters produce smaller width than wide ones', () => {
    expect(measureText('iii')).toBeLessThan(measureText('mmm'));
  });

  test('width scales with text length', () => {
    expect(measureText('aa')).toBeGreaterThan(measureText('a'));
  });
});

// ---------------------------------------------------------------------------
// makeSvgBadge
// ---------------------------------------------------------------------------

describe('makeSvgBadge', () => {
  test('returns a string containing an svg element', () => {
    const svg = makeSvgBadge('coverage', '85%', 'brightgreen');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  test('embeds label and message in svg content', () => {
    const svg = makeSvgBadge('tests', '42', 'blue');
    expect(svg).toContain('tests');
    expect(svg).toContain('42');
  });

  test('uses the correct hex color for known color names', () => {
    expect(makeSvgBadge('x', 'y', 'brightgreen')).toContain('#4c1');
    expect(makeSvgBadge('x', 'y', 'yellow')).toContain('#dfb317');
    expect(makeSvgBadge('x', 'y', 'orange')).toContain('#fe7d37');
    expect(makeSvgBadge('x', 'y', 'informational')).toContain('#007ec6');
  });

  test('falls back to grey hex for unknown color names', () => {
    expect(makeSvgBadge('x', 'y', 'unknown-color')).toContain('#9f9f9f');
  });

  test('longer messages produce a wider overall badge width', () => {
    const short = makeSvgBadge('label', 'x', 'blue');
    const long = makeSvgBadge('label', 'a much longer message', 'blue');
    const parseWidth = svg => parseInt(svg.match(/width="(\d+)"/)[1]);
    expect(parseWidth(long)).toBeGreaterThan(parseWidth(short));
  });

  test('escapes XML special characters in label and message', () => {
    const svg = makeSvgBadge('a&b', '<val>', 'blue');
    expect(svg).toContain('&amp;b');
    expect(svg).toContain('&lt;val&gt;');
    expect(svg).not.toMatch(/a&b/);
    expect(svg).not.toContain('<val>');
  });
});

// ---------------------------------------------------------------------------
// metricsValuesEqual
// ---------------------------------------------------------------------------

describe('metricsValuesEqual', () => {
  test('returns true when only the generated timestamp differs', () => {
    const a = { generated: '2026-01-01T00:00:00.000Z', src: { files: 1 } };
    const b = { generated: '2026-06-01T00:00:00.000Z', src: { files: 1 } };
    expect(metricsValuesEqual(a, b)).toBe(true);
  });

  test('returns false when a metric value differs', () => {
    const a = { generated: '2026-01-01T00:00:00.000Z', src: { files: 1 } };
    const b = { generated: '2026-01-01T00:00:00.000Z', src: { files: 2 } };
    expect(metricsValuesEqual(a, b)).toBe(false);
  });

  test('returns false when either side is missing', () => {
    expect(metricsValuesEqual(null, { generated: 'x' })).toBe(false);
    expect(metricsValuesEqual({ generated: 'x' }, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// main — idempotent generation (issue #739)
// ---------------------------------------------------------------------------

describe('main', () => {
  function makeProjectRoot(name) {
    const root = join(TMP, name);
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    return root;
  }

  function readLatest(root) {
    return {
      json: JSON.parse(readFileSync(join(root, 'docs', 'metrics', 'latest.json'), 'utf8')),
      md: readFileSync(join(root, 'docs', 'metrics', 'latest.md'), 'utf8'),
    };
  }

  test('re-running against unchanged source leaves latest.json/.md byte-identical', () => {
    const root = makeProjectRoot('idempotent');
    main(root);
    const first = readLatest(root);

    main(root);
    const second = readLatest(root);

    expect(second.json).toEqual(first.json);
    expect(second.md).toBe(first.md);
  });

  test('a genuine metric change still produces a fresh timestamp and updated values', () => {
    const root = makeProjectRoot('changed');
    main(root);
    const first = readLatest(root);

    writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2;\n');
    main(root);
    const second = readLatest(root);

    expect(second.json.src.files).toBe(first.json.src.files + 1);
    expect(second.json.generated).not.toBe(first.json.generated);
  });
});
