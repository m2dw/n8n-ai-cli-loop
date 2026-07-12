/**
 * metrics.mjs
 *
 * Generates project metrics reports (report-only, never blocks CI):
 *   docs/metrics/latest.md          — markdown summary
 *   docs/metrics/latest.json        — structured JSON
 *   docs/metrics/badges/coverage.json
 *   docs/metrics/badges/ts-loc.json
 *   docs/metrics/badges/tests.json
 *   docs/metrics/badges/cycles.json
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

  // 5. Assemble metrics object
  const generated = new Date().toISOString();
  const metrics = {
    generated,
    src: { files: tsFiles.length, lines: loc.total, nonBlankLines: loc.nonBlank },
    tests: { files: testFiles.length, suites: tests.suites, cases: tests.cases },
    coverage,
    dependencies: { circularCycles: cycleCount, filesInCycles: cycleFiles },
  };

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
  }

  // 8. Write latest.md
  const pctOrNA = v => v != null ? `${v}%` : 'n/a';
  const lines = [
    '# Project Metrics',
    '',
    `Generated: ${generated}`,
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

  console.log(`Metrics written to ${outDir}`);
  console.log(`  latest.json`);
  console.log(`  latest.md`);
  console.log(`  badges/coverage.json  (${pctOrNA(linePct)})`);
  console.log(`  badges/ts-loc.json    (${loc.nonBlank} non-blank lines)`);
  console.log(`  badges/tests.json     (${tests.cases} cases)`);
  console.log(`  badges/cycles.json    (${cycleCount} cycles)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
