/**
 * Structural tests for docs/antigravity-workspace-settings.md (issue #826).
 *
 * The document is the operator-facing contract for a layer that writes a
 * permission file into a real repository, so these pin the claims a reviewer or
 * an operator must not have to rediscover: runner ownership, the exact scope,
 * the fail-closed refusals, the trust rules including stale-entry cleanup, the
 * boundaries permission rules cannot express, and the reconciliation with the
 * evidence contract.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Assertions run against a whitespace-normalized copy: the documents are
// hard-wrapped prose, so a claim can straddle a line break today and be
// reflowed tomorrow.
function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8').replace(/\s+/g, ' ');
}

const doc = read('docs/antigravity-workspace-settings.md');
const evidenceContract = read('docs/research-evidence-contract.md');

describe('docs/antigravity-workspace-settings.md — runner ownership', () => {
  test('states the settings layers the CLI actually reads', () => {
    expect(doc).toMatch(/~\/\.gemini\/antigravity-cli\/settings\.json/);
    expect(doc).toMatch(/<workspace_root>\/\.gemini\/settings\.json/);
    expect(doc).toMatch(/no automatic `settings\.local\.json` layer/);
  });

  test('requires generation from trusted orchestration code, not a repository helper', () => {
    expect(doc).toMatch(/never produced by an npm lifecycle script, a repository-owned helper/);
  });

  test('forbids merging repository-provided settings', () => {
    expect(doc).toMatch(/Repository-provided settings are \*\*never\*\* read, merged, or consulted/);
    expect(doc).toMatch(/replaced whole/);
  });

  test('requires regeneration before every headless invocation', () => {
    expect(doc).toMatch(/regenerated before \*\*every\*\* headless invocation/);
  });
});

describe('docs/antigravity-workspace-settings.md — permission profile', () => {
  test('names the allowed read-only tools and the denied surface', () => {
    for (const tool of ['glob', 'list_directory', 'read_file', 'read_many_files', 'search_file_content']) {
      expect(doc).toContain(tool);
    }
    for (const tool of ['write_file', 'replace', 'run_shell_command', 'web_fetch', 'google_web_search', 'save_memory']) {
      expect(doc).toContain(tool);
    }
  });

  test('scopes path-bearing rules to the resolved workspace root', () => {
    expect(doc).toMatch(/every path-bearing rule is scoped to that resolved root/);
    expect(doc).toMatch(/Every allow rule is path-scoped/);
  });

  test('states that no dangerous flag or auto-approval is used', () => {
    expect(doc).toMatch(/`--dangerously-skip-permissions` is never passed/);
    expect(doc).toMatch(/`autoAccept` is always `false`/);
  });

  test('folds the evidence deny floor and operator globs into deny rules', () => {
    expect(doc).toMatch(/DEFAULT_DENY_GLOBS/);
    expect(doc).toMatch(/denyGlobs/);
    expect(doc).toMatch(/generatedGlobs/);
  });
});

describe('docs/antigravity-workspace-settings.md — accepted limitation', () => {
  test('documents what permission rules cannot express instead of granting a broader rule', () => {
    expect(doc).toMatch(/They cannot express/);
    expect(doc).toMatch(/tracked-only scope/);
    expect(doc).toMatch(/binary content/);
    expect(doc).toMatch(/content redaction/);
    expect(doc).toMatch(/stop and document it, not to grant a broader rule/);
  });

  test('keeps the evidence resolver authoritative over served and published content', () => {
    expect(doc).toMatch(/remains the \*\*authoritative\*\* bound/);
    expect(doc).toMatch(/withheld from every published comment and notification/);
  });

  test('makes enabling the profile its own publication-withholding condition', () => {
    expect(doc).toMatch(/\*\*enabling this profile is itself a withholding condition\*\*/);
    expect(doc).toMatch(/The three conditions are ORed and none may be narrowed/);
  });

  test('re-verifies the settings pathname at launch, not only the written descriptor', () => {
    expect(doc).toMatch(/pathname is re-verified at launch/);
    expect(doc).toMatch(/renamed away/);
    expect(doc).toMatch(/never repaired in place/);
  });
});

describe('docs/antigravity-workspace-settings.md — fail-closed behaviour', () => {
  test('lists the closed refusal vocabulary', () => {
    for (const reason of [
      'settings-tracked-by-git',
      'settings-symlink',
      'settings-path-escapes-workspace',
      'settings-not-ignored',
      'settings-replaced-before-launch',
      'workspace-dirty-after-write',
      'workspace-not-trusted',
      'unvetted-cli-binary',
      'schema-drift',
    ]) {
      expect(doc).toContain(reason);
    }
  });

  test('treats a permission-name or schema change as drift', () => {
    expect(doc).toMatch(/an unknown or renamed tool name/);
    expect(doc).toMatch(/Drift never degrades into "write it anyway"/);
  });

  test('refuses to write a profile for an operator-overridden binary', () => {
    expect(doc).toMatch(/ANTIGRAVITY_BIN/);
    expect(doc).toMatch(/cannot vouch for that dialect/);
  });
});

describe('docs/antigravity-workspace-settings.md — reconciliation with agy 1.1.9 (issue #830)', () => {
  test('records that the workspace layer alone did not carry the grants', () => {
    expect(doc).toMatch(/Correction \(issue #830\)/);
    expect(doc).toMatch(/that layer is not consulted for a headless tool request/);
    expect(doc).toMatch(/permission-denied\/read/);
  });

  test('states where the bounded rules are installed and what is deliberately left out', () => {
    expect(doc).toMatch(/installed into the \*\*global\*\* settings file/);
    expect(doc).toMatch(/Only \*path-scoped\* rules/);
    expect(doc).toMatch(/unscoped, tool-name-only deny rules.{0,80}stay in the workspace document/);
    expect(doc).toMatch(/change the CLI's behaviour for \*every other workspace on the machine\*/);
  });

  test('requires unrelated global settings to survive the overlay unchanged', () => {
    expect(doc).toMatch(/Every unrelated key, every unrelated rule, and their order/);
    expect(doc).toMatch(/comes back byte-for-byte once the entries are released/);
    // Formatting a serialiser cannot reproduce is restored from a recorded copy,
    // and a minified store is not expanded for the run (issue #830 review).
    expect(doc).toMatch(/a store written on one line stays\s+minified/);
    expect(doc).toMatch(/records the store's original bytes in its\s+journal/);
    expect(doc).toMatch(/Nothing is recorded when the store renders back to itself/);
  });

  test('requires the operator’s own grants to be suspended for the run', () => {
    expect(doc).toMatch(/\*\*What is suspended\.\*\*/);
    expect(doc).toMatch(/a capability \*of the research invocation\*/);
    expect(doc).toMatch(/restored verbatim/);
    expect(doc).toMatch(/sees \*fewer\* grants while a research run is in flight, never more/);
  });

  test('documents the concurrency and crash-safety guarantees of the lifecycle', () => {
    expect(doc).toMatch(/advisory lock beside the store/);
    expect(doc).toMatch(/atomic rename/);
    expect(doc).toMatch(/journal/);
    expect(doc).toMatch(/reclaims any journal whose owning process is gone/);
    // Age never retires a live overlay; it only makes a refusal actionable.
    expect(doc).toMatch(/\*\*Age is not\s+liveness\*\*/);
    expect(doc).toMatch(/The 12-hour\s+TTL only \*reports\*/);
    expect(doc).toMatch(/removed again on every exit path|Removal happens on every exit path/);
    // A live holder is waited on, and a journal outlives the state it describes.
    expect(doc).toMatch(/A live holder keeps the lock however long its critical section runs/);
    expect(doc).toMatch(/only ever deleted once the state it describes is gone/);
    // A rule the operator adds mid-run is theirs: removal is by count, and a
    // reclaimed claim is settled only once its revert is on disk (issue #830
    // review).
    expect(doc).toMatch(/Removal is\s+\*\*counted, not matched by identity\*\*/);
    expect(doc).toMatch(/settled only \*after\* the store update carrying its revert commits/);
  });

  test('holds the global permission set for one workspace at a time', () => {
    expect(doc).toMatch(/\*\*One workspace at a time\.\*\*/);
    expect(doc).toContain('global-overlay-contended');
    expect(doc).toMatch(/read B's tree by absolute path/);
    expect(doc).toMatch(/Two runs on the \*same\* workspace\s+are co-tenants/);
    expect(doc).toMatch(/an `allow` entry no journal \*for this\s+workspace\* claims fails the run closed/);
  });

  test('fails the phase when the runner-owned entries cannot be removed', () => {
    expect(doc).toContain('global-overlay-release-failed');
    expect(doc).toMatch(/It is not a local footnote/);
    expect(doc).toMatch(/recorded in the local\s+artifact as `releaseFailure`/);
  });

  test('never treats a journal it cannot parse as absent', () => {
    expect(doc).toContain('global-overlay-journal-damaged');
    expect(doc).toMatch(/is \*\*never\*\* treated as absent/);
    expect(doc).toMatch(/the 12-hour TTL is read \*from\* the journal/);
    expect(doc).toMatch(/leaves the file on disk for the operator/);
  });

  test('writes the journal durably before the store update it describes', () => {
    expect(doc).toMatch(/atomic rename of a temp file/);
    expect(doc).toMatch(/`fsync`ed\s+first/);
  });

  test('preserves a symlinked global store instead of replacing the link', () => {
    expect(doc).toMatch(/\*\*Symlinked stores\.\*\*/);
    expect(doc).toMatch(/would replace the\s+\*link\*/);
    expect(doc).toMatch(/the write goes to its\s+target/);
    expect(doc).toMatch(/A link to anything but a regular file/);
  });

  test('ties a stale-lock takeover to the file that was inspected', () => {
    expect(doc).toMatch(/lock\.takeover/);
    expect(doc).toMatch(/the loser's unlink\s+would otherwise delete the lock the winner had already replaced it with/);
    expect(doc).toMatch(/unless it still names the inspected dev\/ino/);
  });

  test('gates the run on the installed CLI version and says how to widen it', () => {
    expect(doc).toContain('unsupported-cli-version');
    expect(doc).toContain('cli-version-unreadable');
    expect(doc).toMatch(/>=1\.1\.9 <2\.0\.0/);
    expect(doc).toMatch(/running §11\.1's real-CLI smoke test against the new version/);
  });

  test('probes the binary that will run instead of accepting an answer from the environment', () => {
    // The gate is worth nothing if a value left set from an earlier session can
    // answer it for a binary nobody probed (issue #830 review).
    expect(doc).toMatch(/The probe always executes the binary the run is about to launch/);
    expect(doc).toMatch(/there is no\s+environment override/);
    expect(doc).toMatch(/that injection is test-only/);
  });

  test('requires one resolved store, and the one the CLI actually loads', () => {
    expect(doc).toContain('global-settings-not-canonical');
    expect(doc).toMatch(/resolved to the file it designates \*\*once\*\*/);
    expect(doc).toMatch(/serialising against \*different\* locks/);
    expect(doc).toMatch(/Neither `globalSettingsPath` nor\s+`ANTIGRAVITY_CLI_SETTINGS` redirects `agy`/);
    expect(doc).toMatch(/Only a fixture run\s+may point elsewhere/);
    // And the pathname the CLI resolves is derived again at launch, so a symlink
    // repointed after preparation cannot hand the agent another store's
    // permissions (issue #830 review).
    expect(doc).toMatch(/re-derived at launch/);
  });

  test('describes the opt-in real-CLI smoke test and what it proves', () => {
    expect(doc).toMatch(/ANTIGRAVITY_CLI_SMOKE=1/);
    expect(doc).toMatch(/drives the \*\*installed\*\* `agy`, not a stand-in/);
    expect(doc).toMatch(/a path outside the approved workspace is not readable/);
    expect(doc).toMatch(/write, shell, and network capabilities remain denied/);
    expect(doc).toMatch(/without `ANTIGRAVITY_CLI_SMOKE=1` it skips/);
    // Issue #832: a single-file read passing is what let the real acceptance
    // run fail anyway, so the smoke has to run a research-shaped turn.
    expect(doc).toMatch(/\*\*representative research task\*\*/);
    expect(doc).toMatch(/without requesting a command permission/);
  });

  test('states that the tool registration, not only the rules, is installed where the CLI reads it', () => {
    // Issue #832: the #830 overlay carried the grants and the run still
    // produced nothing, because the tool set was decided elsewhere.
    expect(doc).toMatch(/## 2\.6 The read-only tool surface/);
    expect(doc).toMatch(/which tools exist to be chosen/);
    expect(doc).toContain('tools.core');
    expect(doc).toContain('tools.exclude');
    expect(doc).toMatch(/a tool not named here is not registered/);
    expect(doc).toMatch(/`mcpServers` \| `\{\}`/);
    expect(doc).toMatch(/`autoAccept` \| `false`/);
  });

  test('names the command-capable spellings it refuses to register, and why both forms', () => {
    expect(doc).toContain('run_shell_command');
    expect(doc).toContain('ShellTool');
    expect(doc).toMatch(/an `exclude` entry matching no tool is inert/);
    expect(doc).toMatch(/a `core` entry matching no tool registers nothing/);
    expect(doc).toMatch(/COMMAND_CAPABLE_TOOL_NAMES/);
  });

  test('accepts the narrowing side effect of a shared store explicitly', () => {
    expect(doc).toMatch(/restored, verbatim, by the last overlay to release/);
    expect(doc).toMatch(/the change is strictly \*narrowing\*/);
    expect(doc).toMatch(/left exactly as it stands rather than overwritten/);
  });

  test('refuses the co-tenant handoff rather than discarding a surface edit', () => {
    // Issue #832 review: the later overlay inherits the operator's values from
    // the earlier one's journal, so a key edited in between is recorded nowhere
    // and would be restored stale by whichever run releases last.
    expect(doc).toMatch(/\*\*And not handed over when it no longer matches\.\*\*/);
    expect(doc).toMatch(/Such an installation is \*refused\*, and waits/);
    expect(doc).toMatch(/the retry\s+after it records the operator's real values/);
    expect(doc).toContain('global-overlay-contended');
  });

  test('keeps the research prompt guidance runner-owned and separate from enforcement', () => {
    expect(doc).toMatch(/untrusted Issue text never defines this boundary/);
    expect(doc).toMatch(/The prompt is guidance; the registration above is the enforcement/);
  });

  test('makes an unhonoured tool surface an actionable diagnostic, never a grant', () => {
    expect(doc).toContain('research-tool-surface-violation.json');
    expect(doc).toMatch(/the pin has to be re-verified against the installed CLI/);
    expect(doc).toMatch(/is never the remedy/);
    expect(doc).toMatch(/--dangerously-skip-permissions/);
  });

  test('keeps the current and legacy trust representations explicit', () => {
    expect(doc).toContain('trustedWorkspaces');
    expect(doc).toContain('trustedFolders');
    expect(doc).toMatch(/An \*\*ancestor\*\* entry in `trustedWorkspaces` is deliberately \*not\* read as trust/);
  });
});

describe('docs/antigravity-workspace-settings.md — trust and git hygiene', () => {
  test('requires exact-workspace trust registration and forbids broad parent grants', () => {
    expect(doc).toMatch(/writes \*\*only\*\* the exact workspace path/);
    expect(doc).toMatch(/never writes a parent-directory entry/);
    expect(doc).toMatch(/preserves every unrelated key and every unrelated trust entry/);
  });

  test('documents how stale trust entries are identified and removed', () => {
    expect(doc).toMatch(/A trust entry is \*\*stale\*\* when its recorded path no longer resolves/);
    expect(doc).toMatch(/findStaleTrustEntries/);
    expect(doc).toMatch(/withoutTrustEntries/);
    expect(doc).toMatch(/never automatic/);
  });

  test('requires the global trust store to live outside the read-enabled workspace', () => {
    expect(doc).toContain('trust-store-inside-workspace');
    expect(doc).toMatch(/must point outside the research workspace/);
    expect(doc).toMatch(/checked before the store is read|runs before the store is read/);
  });

  test('requires the generated file to be ignored without dirtying the worktree', () => {
    expect(doc).toMatch(/tracked.{0,40}`\.gemini\/settings\.json` refuses the run/);
    expect(doc).toMatch(/info\/exclude/);
    expect(doc).toMatch(/A committed `\.gitignore` is never edited/);
    expect(doc).toMatch(/must be empty/);
  });
});

describe('docs/antigravity-workspace-settings.md — reporting and configuration', () => {
  test('separates the bounded local artifact from the public failure string', () => {
    expect(doc).toMatch(/research-workspace-settings\.json/);
    expect(doc).toMatch(/never records an absolute path/);
    expect(doc).toMatch(/fixed reason literal/);
  });

  test('states that the layer is disabled by default and how to enable it', () => {
    expect(doc).toMatch(/"enabled": true, \/\/ default false/);
    expect(doc).toMatch(/registerTrust/);
    expect(doc).toMatch(/ANTIGRAVITY_CLI_SETTINGS/);
  });
});

describe('reconciliation with the evidence contract (#805/#806)', () => {
  test('the evidence contract scopes its permission prohibition to the evidence boundary', () => {
    expect(evidenceContract).toMatch(/Scope note \(issue #826\)/);
    expect(evidenceContract).toMatch(/docs\/antigravity-workspace-settings\.md/);
  });

  test('the evidence contract still forbids widening within the evidence boundary', () => {
    expect(evidenceContract).toMatch(/MUST NOT add or expand a tool allowlist/);
    expect(evidenceContract).toMatch(/MUST NOT pass\s+`--dangerously-skip-permissions`/);
  });

  test('the defense-in-depth alternative points at this document', () => {
    expect(evidenceContract).toMatch(/Issue #826 takes exactly that option/);
  });

  test('the evidence contract records the profile as a third withholding condition', () => {
    expect(evidenceContract).toMatch(/Issue #826 adds a third condition on the same OR/);
    expect(evidenceContract).toMatch(/session\.research\.antigravity\.workspaceSettings\.enabled/);
  });
});
