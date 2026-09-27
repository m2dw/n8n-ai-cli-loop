#!/usr/bin/env node
/**
 * Issue #1111 — the sandbox build for the scoped StrykerJS harness (Test
 * Maintenance Pilot, slice 3/8). Stryker runs this as its `buildCommand`, with
 * the sandbox as the working directory; nothing else in the repository calls
 * it, and it is never part of `npm test`, `pretest`, `npm run package` or CI.
 *
 * It exists for two reasons, both of which a bare `tsc` command cannot cover.
 *
 * 1. **A non-zero `tsc` exit is expected here and must not fail the run.**
 *    Stryker's instrumentation is not valid TypeScript: it assigns to its own
 *    `stryNS_*` / `stryCov_*` / `stryMutAct_*` function declarations and calls
 *    them with arguments they do not declare, so the compiler reports TS2630,
 *    TS2554 and friends for a file it instrumented. `--noEmitOnError false`
 *    only decides whether JavaScript is *emitted*; `tsc` still exits 2, and
 *    Stryker fails the whole run before testing a single mutant.
 *    `disableTypeChecks` in `stryker.pilot.config.mjs` prepends `// @ts-nocheck`
 *    to the sandbox sources so the diagnostics do not arise in the first place;
 *    this wrapper is the second line of defence, because that preprocessing is
 *    best-effort — Stryker logs a warning and leaves the file type-checked if
 *    it cannot parse one.
 *
 * 2. **Accepting a non-zero exit is only safe if the emit is checked.** So the
 *    wrapper accepts one only when every mutated source emitted the JavaScript
 *    the tests actually import, AND that JavaScript carries the instrumentation
 *    marker. A missing or un-instrumented output is a hard failure with the
 *    file named, instead of a run in which every mutant quietly survives.
 *
 * That second check is also the harness's own evidence: the repository's tests
 * import `dist/`, never `src/`, so "the mutated source compiled into the `dist/`
 * file the tests import" is the link the pilot has to prove. The result is
 * written to `build.json` beside the run spec (bounded and path-free: counts of
 * diagnostic codes, never compiler output or source text) and is folded into
 * the run's sanitized summary by `scripts/mutation-pilot.mjs`.
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';

import { INSTRUMENTATION_MARKER, PILOT_MUTATE, TSC_ARGS, loadRunSpec, resolveTscEntry } from '../stryker.pilot.config.mjs';

/** How many distinct diagnostic codes and raw output lines ever reach a log or record. */
export const MAX_DIAGNOSTIC_CODES = 10;
export const MAX_OUTPUT_LINES = 20;

/**
 * The sources a run mutates, with any `:from-to` line range stripped. Falls
 * back to the pilot scope when no run spec is set, which is the case for a bare
 * `stryker run stryker.pilot.config.mjs`.
 */
export function mutatedSources(spec) {
  const entries = Array.isArray(spec?.mutate) && spec.mutate.length > 0 ? spec.mutate : PILOT_MUTATE;
  return [...new Set(entries.map((entry) => String(entry).split(':')[0]))];
}

/**
 * Where `tsc` puts its output, read from the project's own `tsconfig.json`
 * rather than assumed. Both settings are required: guessing `src`/`dist` would
 * let this check silently look at the wrong file if the layout ever changed.
 */
export function outputLayout(tsconfig) {
  const { rootDir, outDir } = tsconfig?.compilerOptions ?? {};
  if (!rootDir || !outDir) {
    throw new Error('tsconfig.json must declare compilerOptions.rootDir and compilerOptions.outDir for the sandbox build check');
  }
  return { rootDir: String(rootDir).replace(/\/+$/, ''), outDir: String(outDir).replace(/\/+$/, '') };
}

/** The compiled JavaScript a mutated TypeScript source becomes. */
export function distPathFor(source, { rootDir, outDir }) {
  const normalized = String(source).replace(/\\/g, '/');
  if (!normalized.startsWith(`${rootDir}/`)) throw new Error(`${source} is not under rootDir "${rootDir}"`);
  return `${outDir}/${normalized.slice(rootDir.length + 1).replace(/\.tsx?$/, '.js')}`;
}

/**
 * Compiler output reduced to what may be recorded: how many lines it was and
 * how many of each `TSxxxx` code. Never the messages themselves — they quote
 * source text and absolute sandbox paths.
 */
export function countDiagnostics(output) {
  const lines = String(output ?? '').split('\n').filter((line) => line.trim());
  const codes = {};
  for (const line of lines) {
    const match = /\b(TS\d+)\s*:/.exec(line);
    if (match) codes[match[1]] = (codes[match[1]] ?? 0) + 1;
  }
  const ordered = Object.entries(codes).sort((a, b) => b[1] - a[1]);
  return {
    lines: lines.length,
    codes: Object.fromEntries(ordered.slice(0, MAX_DIAGNOSTIC_CODES)),
    omittedCodes: Math.max(0, ordered.length - MAX_DIAGNOSTIC_CODES),
  };
}

/**
 * Decide the build. A type error in the instrumented tree is a warning; a
 * mutated source that did not reach the executed JavaScript is a failure,
 * because every mutant in it would then survive for a reason that has nothing
 * to do with the tests.
 */
export function buildVerdict({ exitCode, signal, spawnError, outputs }) {
  const reasons = [];
  const warnings = [];
  if (spawnError) reasons.push(`the compiler could not be started: ${spawnError}`);
  if (signal) reasons.push(`the compiler was terminated by signal ${signal}`);
  if (!spawnError && !signal && outputs.length === 0) {
    reasons.push('no mutated source was named, so this build proves nothing about the executed code');
  }
  for (const output of outputs) {
    if (!output.present) {
      reasons.push(`${output.source} emitted no JavaScript at ${output.dist} — the tests import the compiled output, so no mutant could reach them`);
    } else if (!output.instrumented) {
      reasons.push(
        `${output.dist} carries no Stryker instrumentation (${INSTRUMENTATION_MARKER}) — the compiled code the tests import is not the mutated code`,
      );
    }
  }
  if (reasons.length === 0 && exitCode !== 0) {
    warnings.push(
      `tsc exited ${exitCode}: the instrumented sources do not type-check. Every mutated source still emitted instrumented JavaScript, so the build is accepted.`,
    );
  }
  return { ok: reasons.length === 0, reasons, warnings };
}

/** Keep a raw compiler dump short enough to read in a log. */
export function boundOutput(output, limit = MAX_OUTPUT_LINES) {
  const lines = String(output ?? '').split('\n').filter((line) => line.trim());
  if (lines.length <= limit) return lines.join('\n');
  return [...lines.slice(0, limit), `… ${lines.length - limit} more line(s) omitted`].join('\n');
}

function main() {
  const sandbox = process.cwd();
  const spec = loadRunSpec();
  const sources = mutatedSources(spec);
  const layout = outputLayout(JSON.parse(readFileSync(join(sandbox, 'tsconfig.json'), 'utf8')));
  const compiler = resolveTscEntry();

  const started = Date.now();
  const compiled = spawnSync(process.execPath, [compiler, ...TSC_ARGS], { cwd: sandbox, encoding: 'utf8' });
  const rawOutput = `${compiled.stdout ?? ''}\n${compiled.stderr ?? ''}`;
  const diagnostics = countDiagnostics(rawOutput);

  const outputs = sources.map((source) => {
    const dist = distPathFor(source, layout);
    const absolute = join(sandbox, dist);
    const present = existsSync(absolute);
    const content = present ? readFileSync(absolute, 'utf8') : '';
    return { source, dist, present, instrumented: content.includes(INSTRUMENTATION_MARKER), bytes: Buffer.byteLength(content) };
  });

  const verdict = buildVerdict({
    exitCode: compiled.status,
    signal: compiled.signal,
    spawnError: compiled.error?.message,
    outputs,
  });
  const record = {
    ranAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    tsc: { exitCode: compiled.status, signal: compiled.signal ?? null, diagnostics },
    outputs,
    ok: verdict.ok,
    reasons: verdict.reasons,
    warnings: verdict.warnings,
  };

  // Beside the run spec, which is the run's own report directory in the
  // checkout — the sandbox is deleted when the run ends.
  const specPath = process.env.MUTATION_PILOT_SPEC;
  if (specPath) writeFileSync(join(dirname(specPath), 'build.json'), `${JSON.stringify(record, null, 2)}\n`);

  for (const output of outputs) {
    const state = !output.present ? 'MISSING' : output.instrumented ? 'instrumented' : 'NOT INSTRUMENTED';
    process.stdout.write(`build: ${output.source} -> ${output.dist} (${state}, ${output.bytes} bytes)\n`);
  }
  for (const warning of verdict.warnings) process.stdout.write(`build warning: ${warning}\n`);
  if (!verdict.ok) {
    for (const reason of verdict.reasons) process.stderr.write(`build failed: ${reason}\n`);
    if (diagnostics.lines > 0) process.stderr.write(`${boundOutput(rawOutput)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`build ok: ${sources.length} mutated source(s) compiled into ${layout.outDir}/ in ${record.durationMs} ms\n`);
}

// `realpathSync` because Node resolves an entry point's symlinks before it
// sets `import.meta.url`, and this script is invoked by an absolute path that
// may run through a worktree symlink. Getting this wrong would make the script
// a silent no-op: exit 0, no compiler run, no `dist/` for the tests to import.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
