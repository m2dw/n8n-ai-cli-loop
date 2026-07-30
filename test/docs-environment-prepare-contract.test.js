/**
 * Structural tests for docs/environment-prepare-contract.md.
 *
 * These tests verify that the specification document contains the key contract
 * claims an implementer or operator needs to understand the environmentPrepare
 * and verification mechanisms.  They are not a substitute for runtime tests.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const doc = read('docs/environment-prepare-contract.md');

// ---------------------------------------------------------------------------
// Capability boundary table
// ---------------------------------------------------------------------------

describe('docs/environment-prepare-contract.md — capability boundaries', () => {
  test('explicitly separates dependency sync, environment prepare, verification, and Tool Request', () => {
    expect(doc).toMatch(/[Dd]ependency sync/);
    expect(doc).toMatch(/[Ee]nvironment prepare|environmentPrepare/);
    expect(doc).toMatch(/[Vv]erification/);
    expect(doc).toMatch(/[Tt]ool [Rr]equest/);
  });

  test('states commands are session/operator-owned', () => {
    expect(doc).toMatch(/session.*operator|operator.*session|session-defined|operator.*own/i);
  });

  test('states commands are never derived from issue text or agent output', () => {
    expect(doc).toMatch(/never.*derived.*issue|never.*inferred.*issue|not.*derive.*issue/i);
    expect(doc).toMatch(/never.*derived.*agent|never.*inferred.*agent|not.*derive.*agent/i);
  });

  test('states commands are not auto-detected from the repository', () => {
    expect(doc).toMatch(/auto.detect|auto detect|not.*detect|never.*inspect/i);
  });

  test('distinguishes environmentPrepare from dependency sync by purpose', () => {
    // env prepare materialises the full runtime tree; dep sync only regenerates lockfile
    expect(doc).toMatch(/lockfile/i);
    expect(doc).toMatch(/node_modules|runtime dep|runtime.*tree|materialise/i);
  });
});

// ---------------------------------------------------------------------------
// environmentPrepare contract
// ---------------------------------------------------------------------------

describe('docs/environment-prepare-contract.md — environmentPrepare contract', () => {
  test('defines enabled as the master switch, disabled by default', () => {
    expect(doc).toMatch(/"enabled"/);
    expect(doc).toMatch(/[Dd]efaults to.*off|disabled by default|default.*off/i);
  });

  test('defines command as the exact configured string', () => {
    expect(doc).toMatch(/"command"/);
    expect(doc).toMatch(/exact.*command|command.*exact/i);
  });

  test('defines cacheKeyFiles', () => {
    expect(doc).toMatch(/cacheKeyFiles/);
  });

  test('defines timeoutMs', () => {
    expect(doc).toMatch(/timeoutMs/);
  });

  test('defines allowLifecycleScripts with explicit operator acknowledgement semantics', () => {
    expect(doc).toMatch(/allowLifecycleScripts/);
    expect(doc).toMatch(/lifecycle.script/i);
    // Must mirror dependencySync and point to its safety rules
    expect(doc).toMatch(/dependencySync|tool-request-and-dependency-sync/i);
  });

  test('documents that it always runs in the issue worktree', () => {
    expect(doc).toMatch(/issue worktree/i);
    expect(doc).toMatch(/unconditionally/i);
  });

  test('defines the prepare stamp concept', () => {
    expect(doc).toMatch(/prepare stamp|stamp/i);
  });

  test('stamp is keyed by worktree identity', () => {
    expect(doc).toMatch(/worktree identity|worktreeId/);
  });

  test('stamp is keyed by command fingerprint', () => {
    expect(doc).toMatch(/[Cc]ommand fingerprint|hash.*command|command.*hash/i);
  });

  test('stamp is keyed by cacheKeyFiles content hash', () => {
    expect(doc).toMatch(/cacheKeyFiles.*hash|hash.*cacheKeyFiles|content hash/i);
  });

  test('documents skip behavior when stamp matches', () => {
    expect(doc).toMatch(/[Ss]kip.*stamp|stamp.*skip|stamp.*match/i);
  });

  test('defines runner timing: before agent execution', () => {
    expect(doc).toMatch(/[Bb]efore agent execution/);
  });

  test('defines runner timing: after worktree resolution', () => {
    expect(doc).toMatch(/worktree.*resolution|resolution.*worktree|worktree.*known/i);
  });

  test('defines runner timing: after dependency sync', () => {
    expect(doc).toMatch(/[Aa]fter.*dependency sync|dependency sync.*before/i);
  });

  test('fails closed on nonzero exit or timeout', () => {
    expect(doc).toMatch(/fails closed|fail.*closed/i);
    expect(doc).toMatch(/exits nonzero|exit.*nonzero|nonzero.*exit/i);
    expect(doc).toMatch(/exceeds.*timeoutMs|timeout/i);
  });

  test('records run/skip/failure in local artifacts', () => {
    expect(doc).toMatch(/environment-prepare-result\.json/);
    expect(doc).toMatch(/run.*skip.*failed|skip.*run.*failed|outcome/i);
  });

  test('emits a task event for failure', () => {
    expect(doc).toMatch(/task event|environment_prepare_failed/i);
  });

  test('states it is not a separate n8n node', () => {
    expect(doc).toMatch(/not.*n8n node|run-one-phase/i);
  });

  test('states agents cannot trigger preparation themselves', () => {
    expect(doc).toMatch(/[Aa]gents cannot|agent.*cannot.*trigger|agent.*not.*trigger/i);
  });

  test('states allowedTools are not widened', () => {
    expect(doc).toMatch(/allowedTools.*not.*widen|not.*widen.*allowedTools/i);
  });
});

// ---------------------------------------------------------------------------
// Non-derivation rule
// ---------------------------------------------------------------------------

describe('docs/environment-prepare-contract.md — non-derivation rule', () => {
  test('explicitly labels the non-derivation rule as normative', () => {
    expect(doc).toMatch(/[Nn]on.derivation rule.*normative|normative/i);
  });

  test('confirms the operator sets the command', () => {
    expect(doc).toMatch(/[Oo]perator sets the command|operator.*set.*command/i);
  });
});

// ---------------------------------------------------------------------------
// Verification contract
// ---------------------------------------------------------------------------

describe('docs/environment-prepare-contract.md — verification contract', () => {
  test('identifies session.verification as the configuration point', () => {
    expect(doc).toMatch(/session\.verification|session.*verification/i);
  });

  test('documents verification as a Record of named commands', () => {
    expect(doc).toMatch(/Record.*string.*string|Record<string.*string>/i);
  });

  test('recommends separate named commands over shell chains', () => {
    expect(doc).toMatch(/separate named commands|separate.*named|prefer.*separate/i);
    expect(doc).toMatch(/shell chain/i);
  });

  test('states commands are runner-owned, not agent-owned', () => {
    // Section heading "Commands are runner-owned, not agent-owned" is on one line
    expect(doc).toMatch(/runner.owned, not agent.owned/i);
  });

  test('states the runner iterates session.verification automatically', () => {
    expect(doc).toMatch(/runner.*iterates|run.*automatically|executes.*automatically/i);
  });

  test('states implementation prompts must tell agents not to request configured commands', () => {
    // Line: "Implementation prompts **must tell agents not to request configured verification"
    expect(doc).toMatch(/[Ii]mplementation prompts.*must tell/);
    // Line: "- Name the verification commands that are already configured."
    expect(doc).toMatch(/verification commands that are already configured/i);
  });

  test('allows agents to emit a Tool Request for unconfigured commands', () => {
    // Line: "still emit a Tool Request or explain the missing verification in its output."
    expect(doc).toMatch(/emit a Tool Request/);
    // The doc explains the agent surfaces the gap rather than being blocked silently
    expect(doc).toMatch(/agent surfaces the gap/i);
  });

  test('documents verification timing: after agent diff, after dep sync', () => {
    expect(doc).toMatch(/[Aa]fter agent diff/);
    expect(doc).toMatch(/[Aa]fter dependency sync|after.*dep.*sync/i);
  });

  test('documents verification timing: before agent in review lane', () => {
    expect(doc).toMatch(/[Bb]efore the review agent|[Aa]fter.*checkout.*review/i);
  });

  test('documents bounded repair loop in implementation lane', () => {
    expect(doc).toMatch(/repair loop|fix.*loop|loop.*cap/i);
  });
});

// ---------------------------------------------------------------------------
// Preset examples
// ---------------------------------------------------------------------------

describe('docs/environment-prepare-contract.md — preset examples', () => {
  test('includes javascript-npm preset example', () => {
    expect(doc).toMatch(/javascript-npm/);
    expect(doc).toMatch(/npm ci/);
  });

  test('includes javascript-pnpm preset example', () => {
    expect(doc).toMatch(/javascript-pnpm/);
    expect(doc).toMatch(/pnpm install.*frozen.lockfile|pnpm.*--frozen-lockfile/i);
  });

  test('includes php-composer preset example', () => {
    expect(doc).toMatch(/php-composer/);
    expect(doc).toMatch(/composer install/);
  });

  test('includes rust-cargo preset example', () => {
    expect(doc).toMatch(/rust-cargo/);
    expect(doc).toMatch(/cargo fetch/);
  });

  test('includes go-mod preset example', () => {
    expect(doc).toMatch(/go-mod/);
    expect(doc).toMatch(/go mod download/);
  });

  test('includes python-uv preset example', () => {
    expect(doc).toMatch(/python-uv/);
    expect(doc).toMatch(/uv sync.*frozen|uv sync/i);
  });

  test('states presets do not auto-detect or auto-execute', () => {
    expect(doc).toMatch(/[Pp]resets.*do not auto.detect|do not.*auto.detect|not.*automatic/i);
  });

  test('states the operator remains the source of truth for presets', () => {
    expect(doc).toMatch(/[Oo]perator remains the source of truth|operator.*source of truth/i);
  });

  test('labels examples as illustrative, not exhaustive', () => {
    expect(doc).toMatch(/illustrative only|not.*exhaustive|illustrative.*not/i);
  });

  test('distinguishes environmentPrepare command from dependencySync command in preset notes', () => {
    expect(doc).toMatch(/environmentPrepare.*command|dependencySync.*command/);
  });
});

// ---------------------------------------------------------------------------
// Non-goals
// ---------------------------------------------------------------------------

describe('docs/environment-prepare-contract.md — non-goals', () => {
  test('explicitly lists non-goals section', () => {
    expect(doc).toMatch(/## \d+\. Non.Goals|## Non.Goals/i);
  });

  test('states runtime runner is not implemented in this document', () => {
    expect(doc).toMatch(/not.*implement.*runtime|do not.*implement.*runner/i);
  });

  test('states no auto-detection is added', () => {
    expect(doc).toMatch(/no.*auto.detect|not.*add.*auto.detect|never.*auto/i);
  });
});
