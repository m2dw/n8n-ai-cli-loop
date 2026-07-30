/**
 * metrics.mjs
 *
 * Generates project metrics reports (report-only, never blocks CI):
 *   docs/metrics/latest.md          — markdown summary
 *   docs/metrics/latest.json        — structured JSON
 *   docs/metrics/badges/coverage.json  (and .svg)
 *   docs/metrics/badges/ts-loc.json    (and .svg)
 *   docs/metrics/badges/tests.json     (and .svg)
 *   docs/metrics/badges/cycles.json    (and .svg)
 *
 * Run: npm run metrics
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Pure helpers — exported for testing
// ---------------------------------------------------------------------------

/** Recursively collect files whose name satisfies filter. */
export function walkFiles(dir, filter) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full, filter));
    else if (filter(entry.name)) results.push(full);
  }
  return results;
}

/** Count total lines and non-blank lines across a list of files. */
export function countLines(files) {
  let total = 0, nonBlank = 0;
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    total += lines.length;
    nonBlank += lines.filter(l => l.trim().length > 0).length;
  }
  return { total, nonBlank };
}

/** Count test-case calls (test/it/test.each/it.each) and describe blocks across a list of files. */
export function countTests(files) {
  let cases = 0, suites = 0;
  for (const f of files) {
    const content = readFileSync(f, 'utf8');
    cases += (content.match(/^\s*(?:test|it)(?:\.each)?\s*[(`]/gm) || []).length;
    suites += (content.match(/^\s*describe(?:\.each)?\s*[(`]/gm) || []).length;
  }
  return { cases, suites };
}

/**
 * Build a directed import graph from TypeScript source files.
 * Only relative imports (starting with '.') within baseDir are tracked.
 * Returns Map<moduleKey, Set<moduleKey>> where moduleKey is the path
 * relative to baseDir without the .ts extension.
 */
export function buildImportGraph(files, baseDir) {
  const fileKeys = new Set(
    files.map(f => relative(baseDir, f).replace(/\.ts$/, ''))
  );
  const graph = new Map();
  // Exclude `import type` — erased at compile time, not runtime edges.
  const importRe = /^import(?!\s+type[\s{*]).*from\s+['"](\.[^'"]+)['"]/gm;
  // Exclude `export type` — erased at compile time, not runtime edges.
  // Matches: export * from, export * as X from, export { … } from
  const reExportRe = /^export(?!\s+type[\s{*])(?:\s+\*(?:\s+as\s+\w+)?|\s*\{[^}]*\})\s+from\s+['"](\.[^'"]+)['"]/gm;

  for (const file of files) {
    const key = relative(baseDir, file).replace(/\.ts$/, '');
    const raw = readFileSync(file, 'utf8');
    // Collapse multiline imports/re-exports onto one line so the regexes can
    // match them. import/export type statements are collapsed too but still
    // excluded by the negative lookaheads below.
    const content = raw.replace(
      /^(?:import|export)\b[^;]*?from\s+['"][^'"]*['"][^;]*;/gms,
      match => match.replace(/\n\s*/g, ' ')
    );
    const deps = new Set();
    importRe.lastIndex = 0;
    let m;
    while ((m = importRe.exec(content)) !== null) {
      const resolved = resolve(dirname(file), m[1]);
      const depKey = relative(baseDir, resolved).replace(/\.[jt]s$/, '');
      if (fileKeys.has(depKey)) deps.add(depKey);
    }
    reExportRe.lastIndex = 0;
    while ((m = reExportRe.exec(content)) !== null) {
      const resolved = resolve(dirname(file), m[1]);
      const depKey = relative(baseDir, resolved).replace(/\.[jt]s$/, '');
      if (fileKeys.has(depKey)) deps.add(depKey);
    }
    graph.set(key, deps);
  }
  return graph;
}

/**
 * Find strongly-connected components of size > 1 (i.e. cycles) using
 * Tarjan's SCC algorithm.  Returns an array of SCCs; each SCC is an
 * array of module keys that participate in a cycle.
 */
export function findCircularDeps(graph) {
  const index = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  let counter = 0;
  const cycles = [];

  function visit(v) {
    index.set(v, counter);
    lowlink.set(v, counter++);
    stack.push(v);
    onStack.add(v);

    for (const w of (graph.get(v) || [])) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), index.get(w)));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); scc.push(w); } while (w !== v);
      if (scc.length > 1) cycles.push(scc);
    }
  }

  for (const v of graph.keys()) {
    if (!index.has(v)) visit(v);
  }
  return cycles;
}

/** Return a Shields.io badge color based on coverage percentage. */
export function coverageColor(pct) {
  if (pct >= 80) return 'brightgreen';
  if (pct >= 60) return 'yellow';
  return 'red';
}

/** Return a Shields.io custom-endpoint badge object. */
export function makeBadge(label, message, color) {
  return { schemaVersion: 1, label, message: String(message), color };
}

/**
 * Compare two metrics payloads ignoring the `generated` timestamp field.
 * Used to keep metrics generation idempotent: re-running the generator
 * against unchanged source should not rewrite the timestamp (and therefore
 * should not dirty a worktree with a timestamp-only diff).
 */
export function metricsValuesEqual(a, b) {
  if (!a || !b) return false;
  const { generated: _ga, ...restA } = a;
  const { generated: _gb, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

// ---------------------------------------------------------------------------
// SVG badge generation
// ---------------------------------------------------------------------------

const BADGE_COLORS = {
  brightgreen: '#4c1',
  green: '#97ca00',
  yellow: '#dfb317',
  orange: '#fe7d37',
  red: '#e05d44',
  blue: '#007ec6',
  lightgrey: '#9f9f9f',
  informational: '#007ec6',
};

/** Approximate text width in px for Verdana 11px (used for SVG badge layout). */
export function measureText(text) {
  const widths = {
    f: 4.1, i: 2.9, j: 2.9, l: 2.9, r: 4.0, t: 5.0,
    ' ': 3.5, '.': 3.5, ',': 3.5, ':': 3.5, ';': 3.5, '|': 3.5,
    I: 3.0, '(': 4.0, ')': 4.0, '[': 4.0, ']': 4.0,
    m: 10.0, w: 9.5, M: 9.0, W: 10.0,
    '%': 7.5, '@': 11.0,
  };
  let total = 0;
  for (const ch of text) total += widths[ch] ?? 6.5;
  return total;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Generate a flat-style SVG badge without external dependencies. */
export function makeSvgBadge(label, message, color) {
  const hex = BADGE_COLORS[color] ?? '#9f9f9f';
  const pad = 10;
  const lTextW = measureText(label);
  const mTextW = measureText(String(message));
  const lw = Math.round(lTextW + pad);
  const mw = Math.round(mTextW + pad);
  const width = lw + mw;
  const lx = Math.round((lw / 2) * 10);
  const mx = Math.round((lw + mw / 2) * 10);
  const ltl = Math.round(lTextW * 10);
  const mtl = Math.round(mTextW * 10);
  const sl = escapeXml(label);
  const sm = escapeXml(String(message));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${sl}: ${sm}">`,
    `  <title>${sl}: ${sm}</title>`,
    `  <linearGradient id="s" x2="0" y2="100%">`,
    `    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>`,
    `    <stop offset="1" stop-opacity=".1"/>`,
    `  </linearGradient>`,
    `  <clipPath id="r">`,
    `    <rect width="${width}" height="20" rx="3" fill="#fff"/>`,
    `  </clipPath>`,
    `  <g clip-path="url(#r)">`,
    `    <rect width="${lw}" height="20" fill="#555"/>`,
    `    <rect x="${lw}" width="${mw}" height="20" fill="${hex}"/>`,
    `    <rect width="${width}" height="20" fill="url(#s)"/>`,
    `  </g>`,
    `  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="110">`,
    `    <text x="${lx}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${ltl}" lengthAdjust="spacing">${sl}</text>`,
    `    <text x="${lx}" y="140" transform="scale(.1)" textLength="${ltl}" lengthAdjust="spacing">${sl}</text>`,
    `    <text x="${mx}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${mtl}" lengthAdjust="spacing">${sm}</text>`,
    `    <text x="${mx}" y="140" transform="scale(.1)" textLength="${mtl}" lengthAdjust="spacing">${sm}</text>`,
    `  </g>`,
    `</svg>`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function main(rootDir) {
  const root = rootDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = join(root, 'docs', 'metrics');
  const badgesDir = join(outDir, 'badges');

  mkdirSync(outDir, { recursive: true });
  mkdirSync(badgesDir, { recursive: true });

  // 1. Source LOC
  const srcDir = join(root, 'src');
  const tsFiles = walkFiles(srcDir, n => n.endsWith('.ts'));
  const loc = countLines(tsFiles);

  // 2. Test suite / case counts
  const testDir = join(root, 'test');
  const testFiles = existsSync(testDir)
    ? walkFiles(testDir, n => n.endsWith('.test.js') || n.endsWith('.test.ts'))
    : [];
  const tests = countTests(testFiles);

  // 3. Jest coverage (failures are non-fatal — report-only)
  let coverage = null;
  const coverageSummaryPath = join(root, 'coverage', 'coverage-summary.json');
  try {
    execSync(
      'node --experimental-vm-modules node_modules/.bin/jest' +
        ' --coverage --coverageProvider=v8 --coverageReporters=json-summary --passWithNoTests' +
        " --collectCoverageFrom 'dist/**/*.js'",
      { cwd: root, stdio: 'ignore' }
    );
    if (existsSync(coverageSummaryPath)) {
      const t = JSON.parse(readFileSync(coverageSummaryPath, 'utf8')).total;
      coverage = {
        lines: t.lines.pct,
        statements: t.statements.pct,
        functions: t.functions.pct,
        branches: t.branches.pct,
      };
    }
  } catch {
    console.warn('Warning: Jest coverage run failed; coverage metrics omitted.');
  }

  // 4. Circular dependency detection (failures are non-fatal — report-only)
  let cycleCount = 0;
  let cycleFiles = [];
  try {
    const importGraph = buildImportGraph(tsFiles, srcDir);
    const cycleSCCs = findCircularDeps(importGraph);
    cycleCount = cycleSCCs.length;
    cycleFiles = cycleSCCs.flatMap(scc => scc).sort();
  } catch {
    console.warn('Warning: Circular dependency analysis failed; dependency metrics omitted.');
  }

  // 5. Assemble metrics object. Reuse the previous `generated` timestamp when
  // the underlying values haven't changed, so re-running the generator (e.g.
  // during CI or verification) against unchanged source is a no-op rather
  // than a timestamp-only dirty diff.
  const candidateMetrics = {
    generated: new Date().toISOString(),
    src: { files: tsFiles.length, lines: loc.total, nonBlankLines: loc.nonBlank },
    tests: { files: testFiles.length, suites: tests.suites, cases: tests.cases },
    coverage,
    dependencies: { circularCycles: cycleCount, filesInCycles: cycleFiles },
  };
  const previousMetricsPath = join(outDir, 'latest.json');
  let previousMetrics = null;
  if (existsSync(previousMetricsPath)) {
    try {
      previousMetrics = JSON.parse(readFileSync(previousMetricsPath, 'utf8'));
    } catch {
      previousMetrics = null;
    }
  }
  const unchanged = metricsValuesEqual(candidateMetrics, previousMetrics);
  const metrics = unchanged
    ? { ...candidateMetrics, generated: previousMetrics.generated }
    : candidateMetrics;

  // 6. Write latest.json
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify(metrics, null, 2) + '\n');

  // 7. Write badge JSONs
  const linePct = coverage?.lines ?? null;
  const writes = [
    [
      join(badgesDir, 'coverage.json'),
      makeBadge(
        'coverage',
        linePct != null ? `${linePct}%` : 'n/a',
        linePct != null ? coverageColor(linePct) : 'lightgrey'
      ),
    ],
    [
      join(badgesDir, 'ts-loc.json'),
      makeBadge('ts loc', `${loc.nonBlank}`, 'blue'),
    ],
    [
      join(badgesDir, 'tests.json'),
      makeBadge('tests', `${tests.cases} cases / ${testFiles.length} files`, 'informational'),
    ],
    [
      join(badgesDir, 'cycles.json'),
      makeBadge(
        'circular deps',
        `${cycleCount} cycle${cycleCount !== 1 ? 's' : ''}`,
        cycleCount === 0 ? 'brightgreen' : 'orange'
      ),
    ],
  ];
  for (const [path, badge] of writes) {
    writeFileSync(path, JSON.stringify(badge, null, 2) + '\n');
    writeFileSync(path.replace(/\.json$/, '.svg'), makeSvgBadge(badge.label, badge.message, badge.color) + '\n');
  }

  // 8. Write latest.md
  const pctOrNA = v => v != null ? `${v}%` : 'n/a';
  const lines = [
    '# Project Metrics',
    '',
    `Generated: ${metrics.generated}`,
    '',
    '## Source',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| TypeScript files | ${metrics.src.files} |`,
    `| Total lines | ${metrics.src.lines} |`,
    `| Non-blank lines | ${metrics.src.nonBlankLines} |`,
    '',
    '## Tests',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Test files | ${metrics.tests.files} |`,
    `| Suites (describe blocks) | ${metrics.tests.suites} |`,
    `| Cases (test/it calls) | ${metrics.tests.cases} |`,
    '',
    '## Coverage',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Lines | ${pctOrNA(metrics.coverage?.lines)} |`,
    `| Statements | ${pctOrNA(metrics.coverage?.statements)} |`,
    `| Functions | ${pctOrNA(metrics.coverage?.functions)} |`,
    `| Branches | ${pctOrNA(metrics.coverage?.branches)} |`,
    '',
    '## Dependencies',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Circular dependency cycles | ${metrics.dependencies.circularCycles} |`,
  ];
  if (cycleFiles.length > 0) {
    lines.push('', '### Files in Cycles', '');
    for (const f of cycleFiles) lines.push(`- \`${f}\``);
  }
  lines.push('');
  writeFileSync(join(outDir, 'latest.md'), lines.join('\n'));

  console.log(
    unchanged
      ? `Metrics unchanged; timestamp preserved (${outDir})`
      : `Metrics written to ${outDir}`
  );
  console.log(`  latest.json`);
  console.log(`  latest.md`);
  console.log(`  badges/coverage.json+svg  (${pctOrNA(linePct)})`);
  console.log(`  badges/ts-loc.json+svg    (${loc.nonBlank} non-blank lines)`);
  console.log(`  badges/tests.json+svg     (${tests.cases} cases)`);
  console.log(`  badges/cycles.json+svg    (${cycleCount} cycles)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
