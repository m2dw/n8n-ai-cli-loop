/**
 * Pure-core tests for the bounded Antigravity workspace permission profile
 * (issue #826, docs/antigravity-workspace-settings.md).
 *
 * These pin what the generated document *means*: which tools it grants, that
 * every path-bearing rule is scoped to the exact resolved workspace root, that
 * the write/command/network surface is denied by name, and that any drift from
 * the pinned schema or permission vocabulary fails closed rather than being
 * emitted anyway.
 */
import {
  ANTIGRAVITY_SETTINGS_SCHEMA_PIN,
  AntigravityWorkspaceSettingsError,
  COMMAND_CAPABLE_TOOL_NAMES,
  CONTENT_SURFACING_TOOLS,
  KNOWN_SETTINGS_KEYS,
  MAX_OPERATOR_GLOBS,
  RESEARCH_ALLOWED_TOOL_ALIASES,
  RESEARCH_ALLOWED_TOOLS,
  RESEARCH_DENIED_TOOL_ALIASES,
  RESEARCH_DENIED_TOOLS,
  RESEARCH_TOOL_SURFACE_CORE,
  RESEARCH_TOOL_SURFACE_EXCLUDE,
  SUPPORTED_CLI_VERSION_RANGE,
  SUSPENDED_GLOBAL_SURFACE_KEYS,
  WORKSPACE_SETTINGS_POLICY_VERSION,
  WORKSPACE_SETTINGS_RELATIVE_PATH,
  applyPermissionOverlay,
  assertSupportedCliVersion,
  buildGlobalPermissionOverlay,
  buildGlobalSurfaceOverlay,
  buildResearchWorkspaceSettings,
  canonicalJson,
  detectSurfaceHandoffDrift,
  evaluateWorkspaceTrust,
  findStaleTrustEntries,
  parseCliVersion,
  publicWorkspaceSettingsMessage,
  renderWorkspaceSettings,
  revertPermissionOverlay,
  validateWorkspaceSettingsDocument,
  withExactWorkspaceTrust,
  withoutTrustEntries,
  workspaceSettingsSha256,
} from '../dist/core/antigravity-workspace-settings.js';

const ROOT = '/tmp/workspace-fixture/repo';

const build = (overrides = {}) => buildResearchWorkspaceSettings({ workspaceRoot: ROOT, ...overrides });

function refusalReason(fn) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AntigravityWorkspaceSettingsError);
    return err.reason;
  }
  throw new Error('expected a refusal');
}

// ---------------------------------------------------------------------------
// Generated document
// ---------------------------------------------------------------------------

describe('research workspace settings — generated document', () => {
  test('pins the policy version, schema, and workspace-relative location', () => {
    // Bumped by issue #830: the rules now also live in the global store and
    // trust is `trustedWorkspaces`, so an artifact from a #826 run must not
    // read as the current policy. Bumped again by issue #832: the tool
    // registration is installed there too, so an artifact from a #830 run —
    // whose agent could still select a command tool — must not read as this one
    // either.
    expect(WORKSPACE_SETTINGS_POLICY_VERSION).toBe('research-readonly/3');
    expect(ANTIGRAVITY_SETTINGS_SCHEMA_PIN).toBe('antigravity-cli/settings@3');
    expect(WORKSPACE_SETTINGS_RELATIVE_PATH).toBe('.gemini/settings.json');
  });

  test('contains only the pinned keys and never auto-approves', () => {
    const settings = build();
    expect(Object.keys(settings).sort()).toEqual([...KNOWN_SETTINGS_KEYS].sort());
    expect(settings.autoAccept).toBe(false);
    expect(settings.mcpServers).toEqual({});
  });

  test('allows exactly the read-only enumerate/read/search tools', () => {
    expect([...RESEARCH_ALLOWED_TOOLS].sort()).toEqual([
      'glob',
      'list_directory',
      'read_file',
      'read_many_files',
      'search_file_content',
    ]);
    // The registration list carries the same read-only tools under every
    // spelling the schema accepts (issue #832), so it is a superset of the tool
    // names and never names anything outside the read-only surface. The legacy
    // key spelling says the same thing.
    const settings = build();
    for (const tool of RESEARCH_ALLOWED_TOOLS) expect(settings.tools.core).toContain(tool);
    expect(settings.tools.core).toEqual([...RESEARCH_TOOL_SURFACE_CORE]);
    expect(settings.coreTools).toEqual(settings.tools.core);
    expect(settings.excludeTools).toEqual(settings.tools.exclude);
  });

  test('every allow rule is scoped to the exact workspace root', () => {
    const { allow } = build().permissions;
    expect(allow.length).toBe(RESEARCH_ALLOWED_TOOLS.length * 2);
    for (const rule of allow) {
      const path = /^[a-z_]+\((.*)\)$/.exec(rule)[1];
      expect(path === ROOT || path.startsWith(`${ROOT}/`)).toBe(true);
    }
    for (const tool of RESEARCH_ALLOWED_TOOLS) {
      expect(allow).toContain(`${tool}(${ROOT})`);
      expect(allow).toContain(`${tool}(${ROOT}/**)`);
    }
  });

  test('a sibling workspace with a shared path prefix is not in scope', () => {
    const { allow } = build().permissions;
    expect(allow.some((rule) => rule.includes(`${ROOT}-other`))).toBe(false);
    expect(allow.some((rule) => rule.includes('/tmp/workspace-fixture)'))).toBe(false);
    expect(allow.some((rule) => rule.includes('/tmp/workspace-fixture/**'))).toBe(false);
  });

  test('denies writes, edits, commands, network, and memory tools by name', () => {
    const { deny } = build().permissions;
    for (const tool of ['write_file', 'replace', 'run_shell_command', 'web_fetch', 'google_web_search', 'save_memory']) {
      expect(RESEARCH_DENIED_TOOLS).toContain(tool);
      expect(deny).toContain(tool);
      expect(RESEARCH_ALLOWED_TOOLS).not.toContain(tool);
    }
  });

  test('no allow rule grants a write, command, child-process, or network tool', () => {
    const { allow } = build().permissions;
    for (const tool of RESEARCH_DENIED_TOOLS) {
      expect(allow.some((rule) => rule.startsWith(`${tool}(`))).toBe(false);
    }
  });

  test('the evidence deny floor is expanded into workspace-scoped deny rules', () => {
    const { deny } = build().permissions;
    for (const tool of CONTENT_SURFACING_TOOLS) {
      // A recursive-prefix glob becomes both the root-level and the nested rule.
      expect(deny).toContain(`${tool}(${ROOT}/.env)`);
      expect(deny).toContain(`${tool}(${ROOT}/**/.env)`);
      expect(deny).toContain(`${tool}(${ROOT}/**/*.pem)`);
      expect(deny).toContain(`${tool}(${ROOT}/.n8n-artifacts/**)`);
    }
  });

  test('operator deny and generated globs are folded into the profile', () => {
    const { deny } = build({ denyGlobs: ['config/local.json'], generatedGlobs: ['dist/**'] }).permissions;
    expect(deny).toContain(`read_file(${ROOT}/config/local.json)`);
    expect(deny).toContain(`search_file_content(${ROOT}/dist/**)`);
  });

  test('too many operator globs fail closed instead of emitting an unreviewable profile', () => {
    const many = Array.from({ length: MAX_OPERATOR_GLOBS + 1 }, (_, i) => `generated-${i}/**`);
    expect(refusalReason(() => build({ denyGlobs: many }))).toBe('operator-glob-budget-exceeded');
  });

  test('renders deterministically with a trailing newline and a stable hash', () => {
    const first = renderWorkspaceSettings(build());
    const second = renderWorkspaceSettings(build());
    expect(first).toBe(second);
    expect(first.endsWith('\n')).toBe(true);
    expect(JSON.parse(first).permissions.allow).toEqual(build().permissions.allow);
    expect(workspaceSettingsSha256(first)).toBe(workspaceSettingsSha256(second));
    expect(workspaceSettingsSha256(first)).not.toBe(
      workspaceSettingsSha256(renderWorkspaceSettings(buildResearchWorkspaceSettings({ workspaceRoot: '/tmp/other/repo' }))),
    );
  });
});

// ---------------------------------------------------------------------------
// Workspace-root scoping refusals
// ---------------------------------------------------------------------------

describe('research workspace settings — workspace root scoping', () => {
  test('a relative root is refused', () => {
    expect(refusalReason(() => buildResearchWorkspaceSettings({ workspaceRoot: 'repo' })))
      .toBe('workspace-root-not-absolute');
  });

  test('a traversing or non-normalized root is refused', () => {
    expect(refusalReason(() => buildResearchWorkspaceSettings({ workspaceRoot: '/tmp/repo/../escape' })))
      .toBe('workspace-root-unrepresentable');
  });

  test('a filesystem root or a trailing separator is refused', () => {
    expect(refusalReason(() => buildResearchWorkspaceSettings({ workspaceRoot: '/' })))
      .toBe('workspace-root-unrepresentable');
    expect(refusalReason(() => buildResearchWorkspaceSettings({ workspaceRoot: '/tmp/repo/' })))
      .toBe('workspace-root-unrepresentable');
  });

  test('a root carrying glob metacharacters is refused rather than scoped approximately', () => {
    expect(refusalReason(() => buildResearchWorkspaceSettings({ workspaceRoot: '/tmp/re*po' })))
      .toBe('workspace-root-unrepresentable');
    expect(refusalReason(() => buildResearchWorkspaceSettings({ workspaceRoot: '/tmp/repo(1)' })))
      .toBe('workspace-root-unrepresentable');
  });
});

// ---------------------------------------------------------------------------
// Schema / permission-name drift
// ---------------------------------------------------------------------------

describe('research workspace settings — drift fails closed', () => {
  test('an unknown settings key is drift', () => {
    const settings = { ...build(), sandbox: true };
    expect(refusalReason(() => validateWorkspaceSettingsDocument(settings, ROOT))).toBe('schema-drift');
  });

  test('a renamed permission tool name is drift', () => {
    const settings = build();
    settings.permissions.allow.push(`read_file_v2(${ROOT}/**)`);
    expect(refusalReason(() => validateWorkspaceSettingsDocument(settings, ROOT))).toBe('schema-drift');
  });

  test('a denied tool appearing in the allow list is drift', () => {
    const settings = build();
    settings.permissions.allow.push(`run_shell_command(${ROOT}/**)`);
    expect(refusalReason(() => validateWorkspaceSettingsDocument(settings, ROOT))).toBe('schema-drift');
  });

  test('an unscoped allow rule is drift', () => {
    const settings = build();
    settings.permissions.allow.push('read_file');
    expect(refusalReason(() => validateWorkspaceSettingsDocument(settings, ROOT))).toBe('schema-drift');
  });

  test('a rule escaping the workspace is drift', () => {
    const settings = build();
    settings.permissions.allow.push('read_file(/etc/**)');
    expect(refusalReason(() => validateWorkspaceSettingsDocument(settings, ROOT))).toBe('schema-drift');
  });

  test('auto-approval or an MCP server entry is drift', () => {
    expect(refusalReason(() => validateWorkspaceSettingsDocument({ ...build(), autoAccept: true }, ROOT)))
      .toBe('schema-drift');
    expect(refusalReason(() =>
      validateWorkspaceSettingsDocument({ ...build(), mcpServers: { local: {} } }, ROOT),
    )).toBe('schema-drift');
  });

  test('a generated document validates against its own pins', () => {
    expect(() => validateWorkspaceSettingsDocument(build(), ROOT)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

describe('research workspace settings — trust evaluation', () => {
  test('an exact trustedWorkspaces entry is trusted — the representation agy 1.1.9 writes', () => {
    const trust = evaluateWorkspaceTrust({ trustedWorkspaces: [ROOT] }, ROOT);
    expect(trust.status).toBe('trusted-exact');
    expect(trust.containerPresent).toBe(true);
    expect(trust.entryCount).toBe(1);
    expect(trust.representation).toBe('trustedWorkspaces');
  });

  test('an ancestor trustedWorkspaces entry does not grant trust', () => {
    // The array form carries no "and everything below" status, so inferring one
    // would be the broad parent grant this layer refuses to rely on.
    const trust = evaluateWorkspaceTrust({ trustedWorkspaces: ['/tmp/workspace-fixture'] }, ROOT);
    expect(trust.status).toBe('untrusted');
    expect(trust.containerPresent).toBe(true);
  });

  test('a trustedWorkspaces container that is not an array of paths fails closed', () => {
    expect(refusalReason(() => evaluateWorkspaceTrust({ trustedWorkspaces: { [ROOT]: true } }, ROOT)))
      .toBe('schema-drift');
    expect(refusalReason(() => evaluateWorkspaceTrust({ trustedWorkspaces: [ROOT, 7] }, ROOT)))
      .toBe('schema-drift');
  });

  test('the legacy trustedFolders map is still read, and both containers are reported', () => {
    const trust = evaluateWorkspaceTrust(
      { trustedWorkspaces: ['/tmp/other/repo'], trustedFolders: { [ROOT]: 'TRUST_FOLDER' } },
      ROOT,
    );
    expect(trust.status).toBe('trusted-exact');
    expect(trust.representation).toBe('both');
    expect(trust.entryCount).toBe(2);
  });

  test('a legacy distrust entry outranks a current trust entry', () => {
    const trust = evaluateWorkspaceTrust(
      { trustedWorkspaces: [ROOT], trustedFolders: { [ROOT]: 'DO_NOT_TRUST' } },
      ROOT,
    );
    expect(trust.status).toBe('distrusted');
  });

  test('an ancestor TRUST_PARENT entry is recognized as trust', () => {
    const trust = evaluateWorkspaceTrust({ trustedFolders: { '/tmp/workspace-fixture': 'TRUST_PARENT' } }, ROOT);
    expect(trust.status).toBe('trusted-parent');
  });

  test('an unrelated entry sharing a path prefix does not grant trust', () => {
    const trust = evaluateWorkspaceTrust({ trustedFolders: { [`${ROOT}-other`]: 'TRUST_PARENT' } }, ROOT);
    expect(trust.status).toBe('untrusted');
  });

  test('an explicit DO_NOT_TRUST entry is distrust, not absence', () => {
    expect(evaluateWorkspaceTrust({ trustedFolders: { [ROOT]: 'DO_NOT_TRUST' } }, ROOT).status).toBe('distrusted');
  });

  test('a missing trust container is untrusted, not drift', () => {
    const trust = evaluateWorkspaceTrust({ theme: 'dark' }, ROOT);
    expect(trust.status).toBe('untrusted');
    expect(trust.containerPresent).toBe(false);
    expect(trust.representation).toBe('none');
  });

  test('an unknown trust status value fails closed', () => {
    expect(refusalReason(() => evaluateWorkspaceTrust({ trustedFolders: { [ROOT]: 'MAYBE' } }, ROOT)))
      .toBe('schema-drift');
    expect(refusalReason(() => evaluateWorkspaceTrust({ trustedFolders: [ROOT] }, ROOT)))
      .toBe('schema-drift');
  });

  test('registration writes trustedWorkspaces only and preserves unrelated settings', () => {
    const before = {
      theme: 'dark',
      mcpServers: { local: { command: 'x' } },
      trustedWorkspaces: ['/tmp/other/repo'],
      trustedFolders: { '/tmp/legacy/repo': 'TRUST_FOLDER' },
    };
    const after = withExactWorkspaceTrust(before, ROOT);
    expect(after.theme).toBe('dark');
    expect(after.mcpServers).toEqual({ local: { command: 'x' } });
    expect(after.trustedWorkspaces).toEqual(['/tmp/other/repo', ROOT]);
    // The legacy container is read but never written.
    expect(after.trustedFolders).toEqual({ '/tmp/legacy/repo': 'TRUST_FOLDER' });
    // No parent-directory grant is ever introduced.
    expect(after.trustedWorkspaces).not.toContain('/tmp/workspace-fixture');
    // The input document is untouched.
    expect(before.trustedWorkspaces).toEqual(['/tmp/other/repo']);
  });

  test('registering an already-listed workspace does not duplicate it', () => {
    const before = { trustedWorkspaces: [ROOT] };
    expect(withExactWorkspaceTrust(before, ROOT).trustedWorkspaces).toEqual([ROOT]);
  });

  test('registration creates the container when the store has none', () => {
    expect(withExactWorkspaceTrust({ theme: 'dark' }, ROOT)).toEqual({
      theme: 'dark',
      trustedWorkspaces: [ROOT],
    });
  });

  test('stale entries are the recorded paths whose directory no longer exists', () => {
    const doc = {
      trustedWorkspaces: ['/tmp/gone/repo', ROOT],
      trustedFolders: { '/tmp/also-gone': 'TRUST_PARENT', [ROOT]: 'TRUST_FOLDER' },
    };
    const stale = findStaleTrustEntries(doc, (path) => path === ROOT);
    expect(stale).toEqual(['/tmp/also-gone', '/tmp/gone/repo']);
    const cleaned = withoutTrustEntries(doc, stale);
    expect(cleaned.trustedWorkspaces).toEqual([ROOT]);
    expect(cleaned.trustedFolders).toEqual({ [ROOT]: 'TRUST_FOLDER' });
  });

  test('removing stale entries preserves every unrelated setting', () => {
    const doc = { theme: 'dark', trustedWorkspaces: ['/tmp/gone'] };
    expect(withoutTrustEntries(doc, ['/tmp/gone'])).toEqual({ theme: 'dark', trustedWorkspaces: [] });
  });
});

// ---------------------------------------------------------------------------
// Installed-CLI version gate (issue #830 §6.3)
// ---------------------------------------------------------------------------

describe('research workspace settings — installed-CLI version gate', () => {
  test('the reconciled range starts at the version this schema was verified against', () => {
    expect(SUPPORTED_CLI_VERSION_RANGE.minInclusive).toBe('1.1.9');
    expect(SUPPORTED_CLI_VERSION_RANGE.maxExclusive).toBe('2.0.0');
  });

  test('accepts the versions inside the range and returns the normalized literal', () => {
    expect(assertSupportedCliVersion('1.1.9')).toBe('1.1.9');
    expect(assertSupportedCliVersion('agy version 1.2.0 (build abc)')).toBe('1.2.0');
    expect(assertSupportedCliVersion('1.9.12\n')).toBe('1.9.12');
  });

  test('a version below or above the range fails closed with an actionable detail', () => {
    for (const output of ['1.1.8', '0.9.0', '2.0.0', '3.1.4']) {
      let error;
      try {
        assertSupportedCliVersion(output);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(AntigravityWorkspaceSettingsError);
      expect(error.reason).toBe('unsupported-cli-version');
      // The operator is told what was found, what is supported, and where to look.
      expect(error.detail).toContain('>=1.1.9 <2.0.0');
      expect(error.detail).toContain('§6.3');
    }
  });

  test('an unparseable version answer fails closed rather than being assumed compatible', () => {
    expect(refusalReason(() => assertSupportedCliVersion(''))).toBe('cli-version-unreadable');
    expect(refusalReason(() => assertSupportedCliVersion('agy (unknown build)'))).toBe('cli-version-unreadable');
    expect(parseCliVersion('no version here')).toBeNull();
    expect(parseCliVersion('1.1.9')).toEqual([1, 1, 9]);
  });
});

// ---------------------------------------------------------------------------
// The runner-owned global overlay (issue #830 §2.5)
// ---------------------------------------------------------------------------

describe('research workspace settings — global permission overlay', () => {
  const overlay = () => buildGlobalPermissionOverlay(build(), ROOT);

  test('carries every allow rule and only workspace-scoped deny rules', () => {
    const { allow, deny } = overlay();
    expect(allow).toEqual(build().permissions.allow);
    for (const rule of [...allow, ...deny]) {
      const path = /^[a-z_]+\((.*)\)$/.exec(rule)[1];
      expect(path === ROOT || path.startsWith(`${ROOT}/`)).toBe(true);
    }
    // The unscoped tool-name denies stay out of a file shared with unrelated
    // user configuration: a global `run_shell_command` deny would change the
    // CLI's behaviour for every other workspace on the machine.
    for (const tool of RESEARCH_DENIED_TOOLS) {
      expect(deny).not.toContain(tool);
      expect(allow.some((rule) => rule.startsWith(`${tool}(`))).toBe(false);
    }
    expect(deny).toContain(`read_file(${ROOT}/**/.env)`);
  });

  test('installs into an empty store and releases it back to exactly what it was', () => {
    const before = { theme: 'dark', trustedWorkspaces: [ROOT] };
    const applied = applyPermissionOverlay(before, overlay());
    expect(applied.document.permissions.allow).toContain(`read_file(${ROOT}/**)`);
    expect(applied.document.theme).toBe('dark');
    expect(applied.document.trustedWorkspaces).toEqual([ROOT]);

    const after = revertPermissionOverlay(applied.document, applied.journal);
    // The `permissions` container did not exist before, so it does not survive.
    expect(after).toEqual(before);
  });

  test('suspends the operator’s own allow rules and restores them on release', () => {
    const before = {
      permissions: {
        allow: ['run_shell_command', 'read_file(/home/dev/notes)', `read_file(${ROOT}/**)`],
        deny: ['run_shell_command'],
        ask: ['web_fetch'],
      },
    };
    const applied = applyPermissionOverlay(before, overlay());
    const { allow } = applied.document.permissions;
    // Nothing the operator granted is inherited by the research process: the
    // global layer is the one `agy` applies, so an inherited command grant or a
    // read outside the workspace could not be taken back by the workspace file.
    expect(allow).toEqual(overlay().allow);
    expect(applied.journal.suspended.allow).toEqual(before.permissions.allow);
    // Only `allow` is suspended. Unrelated lists are left exactly as found:
    // denies and asks can only narrow what the run may do.
    expect(applied.document.permissions.deny[0]).toBe('run_shell_command');
    expect(applied.document.permissions.ask).toEqual(['web_fetch']);

    const after = revertPermissionOverlay(applied.document, applied.journal);
    // Restored verbatim, in the order they were found.
    expect(after).toEqual(before);
  });

  test('a rule the operator listed twice is restored with both copies', () => {
    // A store may legally carry the same grant more than once. Journalling one
    // copy would rewrite the operator's configuration on release — and a
    // document that no longer matches its baseline is not eligible for
    // byte-for-byte restoration either, so the rewrite would be silent
    // (issue #830 review).
    const before = { permissions: { allow: ['run_shell_command', 'run_shell_command'] } };
    const applied = applyPermissionOverlay(before, overlay());
    expect(applied.journal.suspended.allow).toEqual(['run_shell_command', 'run_shell_command']);
    expect(revertPermissionOverlay(applied.document, applied.journal)).toEqual(before);
  });

  test('the operator’s rules stay suspended until the last overlay releases', () => {
    const OTHER = '/tmp/workspace-fixture/other';
    const before = { permissions: { allow: ['run_shell_command'] } };
    const first = applyPermissionOverlay(before, overlay());
    const second = applyPermissionOverlay(
      first.document,
      buildGlobalPermissionOverlay(buildResearchWorkspaceSettings({ workspaceRoot: OTHER }), OTHER),
      [first.journal],
    );
    // The suspension is inherited, so the second run cannot re-admit it either.
    expect(second.document.permissions.allow).not.toContain('run_shell_command');
    expect(second.journal.suspended.allow).toEqual(['run_shell_command']);

    // The second run releases first: its own rules go, the suspension holds.
    const afterSecond = revertPermissionOverlay(second.document, second.journal, [first.journal.claim]);
    expect(afterSecond.permissions.allow).toContain(`read_file(${ROOT}/**)`);
    expect(afterSecond.permissions.allow).not.toContain('run_shell_command');

    // The last one out restores the operator's rule and the original shape.
    expect(revertPermissionOverlay(afterSecond, first.journal, [])).toEqual(before);
  });

  test('a journal written without a suspended list still reverts', () => {
    // Forward compatibility of the crash-safe half: an overlay installed before
    // suspension existed is still released, it simply restores nothing.
    const applied = applyPermissionOverlay({}, overlay());
    const legacy = { ...applied.journal };
    delete legacy.suspended;
    expect(revertPermissionOverlay(applied.document, legacy)).toEqual({});
  });

  test('a rule another live overlay claims survives the first release', () => {
    const OTHER = '/tmp/workspace-fixture/other';
    const first = applyPermissionOverlay({}, overlay());
    const second = applyPermissionOverlay(
      first.document,
      buildGlobalPermissionOverlay(buildResearchWorkspaceSettings({ workspaceRoot: OTHER }), OTHER),
      [first.journal],
    );

    // The second run releases first: only its own rules go.
    const afterSecond = revertPermissionOverlay(second.document, second.journal, [first.journal.claim]);
    expect(afterSecond.permissions.allow).toContain(`read_file(${ROOT}/**)`);
    expect(afterSecond.permissions.allow).not.toContain(`read_file(${OTHER}/**)`);

    // The last one out restores the original shape.
    expect(revertPermissionOverlay(afterSecond, first.journal, [])).toEqual({});
  });

  test('two overlays claiming the same rule release it only with the last claim', () => {
    const first = applyPermissionOverlay({}, overlay());
    const second = applyPermissionOverlay(first.document, overlay(), [first.journal]);
    // The rule was installed by the first run, so it is not the operator's.
    expect(second.journal.foreign.allow).toEqual([]);

    const afterFirst = revertPermissionOverlay(second.document, first.journal, [second.journal.claim]);
    expect(afterFirst.permissions.allow).toContain(`read_file(${ROOT}/**)`);
    expect(revertPermissionOverlay(afterFirst, second.journal, [])).toEqual({});
  });

  test('a global store whose permission container is not the pinned shape is drift', () => {
    expect(refusalReason(() => applyPermissionOverlay({ permissions: ['read_file'] }, overlay())))
      .toBe('schema-drift');
    expect(refusalReason(() => applyPermissionOverlay({ permissions: { allow: 'read_file' } }, overlay())))
      .toBe('schema-drift');
    expect(refusalReason(() => applyPermissionOverlay({ permissions: { deny: [7] } }, overlay())))
      .toBe('schema-drift');
  });
});

// ---------------------------------------------------------------------------
// The read-only tool surface (issue #832 §2.6)
//
// #830 got the grants into the layer the CLI reads, and the run still produced
// nothing: `agy` registered its full tool set, the model picked a command tool,
// and headless mode auto-denied it. These pin the registration that keeps a
// command-capable tool from being offered at all — including the naming, which
// is where the working diagnosis said the mismatch might be.
// ---------------------------------------------------------------------------

describe('research workspace settings — read-only tool surface', () => {
  test('pins every command-capable tool spelling the profile refuses to register', () => {
    // The regression guard for the reported failure: a spelling dropped from
    // this list is one the CLI could register and the model could select.
    expect([...COMMAND_CAPABLE_TOOL_NAMES]).toEqual(['run_shell_command', 'ShellTool']);
    for (const tool of COMMAND_CAPABLE_TOOL_NAMES) {
      expect(RESEARCH_TOOL_SURFACE_CORE).not.toContain(tool);
      expect(RESEARCH_TOOL_SURFACE_EXCLUDE).toContain(tool);
      expect(RESEARCH_ALLOWED_TOOLS).not.toContain(tool);
    }
  });

  test('the exclusion list keeps every denied tool under both spellings', () => {
    for (const tool of [...RESEARCH_DENIED_TOOLS, ...RESEARCH_DENIED_TOOL_ALIASES]) {
      expect(RESEARCH_TOOL_SURFACE_EXCLUDE).toContain(tool);
    }
    // The class-name spellings are additions, never replacements: the tool
    // names stay exactly what the permission rules and the prompt state.
    for (const tool of RESEARCH_DENIED_TOOLS) expect(tool).toMatch(/^[a-z_]+$/);
    for (const alias of RESEARCH_DENIED_TOOL_ALIASES) expect(alias).toMatch(/^[A-Z][A-Za-z]+$/);
    for (const alias of RESEARCH_ALLOWED_TOOL_ALIASES) expect(alias).toMatch(/^[A-Z][A-Za-z]+$/);
    // No spelling appears on both sides of the registration.
    for (const tool of RESEARCH_TOOL_SURFACE_CORE) {
      expect(RESEARCH_TOOL_SURFACE_EXCLUDE).not.toContain(tool);
    }
  });

  test('a command tool smuggled into the registration is drift, not a profile', () => {
    const registered = build();
    registered.tools.core.push('run_shell_command');
    expect(refusalReason(() => validateWorkspaceSettingsDocument(registered, ROOT))).toBe('schema-drift');

    const unexcluded = build();
    unexcluded.tools.exclude = unexcluded.tools.exclude.filter((tool) => tool !== 'ShellTool');
    expect(refusalReason(() => validateWorkspaceSettingsDocument(unexcluded, ROOT))).toBe('schema-drift');

    const aliased = build();
    aliased.tools.core.push('ShellTool');
    expect(refusalReason(() => validateWorkspaceSettingsDocument(aliased, ROOT))).toBe('schema-drift');

    // The legacy spelling is checked as its own registration, not assumed to
    // follow from the nested one.
    const legacy = build();
    legacy.coreTools = [...legacy.coreTools, 'run_shell_command'];
    expect(refusalReason(() => validateWorkspaceSettingsDocument(legacy, ROOT))).toBe('schema-drift');
  });

  test('two registrations that disagree are drift', () => {
    // A build reading one pair and a build reading the other must never be told
    // different things by the same document.
    const settings = build();
    settings.coreTools = settings.coreTools.filter((tool) => tool !== 'glob');
    expect(refusalReason(() => validateWorkspaceSettingsDocument(settings, ROOT))).toBe('schema-drift');
  });

  test('the surface installed globally is the profile’s own, with nothing auto-approved', () => {
    const settings = build();
    const surface = buildGlobalSurfaceOverlay(settings);
    expect(Object.keys(surface).sort()).toEqual([...SUSPENDED_GLOBAL_SURFACE_KEYS].sort());
    expect(surface.tools).toEqual({ core: settings.tools.core, exclude: settings.tools.exclude });
    expect(surface.coreTools).toEqual(settings.tools.core);
    expect(surface.excludeTools).toEqual(settings.tools.exclude);
    expect(surface.mcpServers).toEqual({});
    expect(surface.autoAccept).toBe(false);
  });

  test('installing the overlay registers the read-only surface in the store the CLI reads', () => {
    // The whole point of #832: under #830 these keys stayed in the workspace
    // document, which `agy` 1.1.9 ignores.
    const before = {
      theme: 'dark',
      autoAccept: true,
      mcpServers: { shellish: { command: '/usr/local/bin/tool-server' } },
      tools: { core: ['run_shell_command'], discoveryCommand: 'list-tools.sh' },
      excludeTools: [],
    };
    const applied = applyPermissionOverlay(before, buildGlobalPermissionOverlay(build(), ROOT));

    // Both key spellings, so whichever pair the installed build reads carries
    // the read-only registration rather than the operator's.
    expect(applied.document.coreTools).toEqual([...RESEARCH_TOOL_SURFACE_CORE]);
    expect(applied.document.excludeTools).toEqual([...RESEARCH_TOOL_SURFACE_EXCLUDE]);
    expect(applied.document.tools.core).not.toContain('run_shell_command');
    expect(applied.document.tools.core).toEqual([...RESEARCH_TOOL_SURFACE_CORE]);
    expect(applied.document.tools.exclude).toEqual([...RESEARCH_TOOL_SURFACE_EXCLUDE]);
    // An operator's command-backed tool discovery and MCP tool source are both
    // suspended: a `tools.core` allow-list does not reach either of them.
    expect(applied.document.tools.discoveryCommand).toBeUndefined();
    expect(applied.document.mcpServers).toEqual({});
    expect(applied.document.autoAccept).toBe(false);
    expect(applied.document.theme).toBe('dark');

    // Restored verbatim on release, unrelated keys untouched.
    expect(revertPermissionOverlay(applied.document, applied.journal)).toEqual(before);
  });

  test('a store with no tool configuration gets none back', () => {
    const applied = applyPermissionOverlay({ theme: 'dark' }, buildGlobalPermissionOverlay(build(), ROOT));
    expect(applied.document.tools).toBeDefined();
    // Restoring a key the operator never had means removing it again, not
    // leaving an empty container or a null behind.
    expect(revertPermissionOverlay(applied.document, applied.journal)).toEqual({ theme: 'dark' });
  });

  test('the surface stays installed until the last overlay releases', () => {
    const before = { autoAccept: true };
    const first = applyPermissionOverlay(before, buildGlobalPermissionOverlay(build(), ROOT));
    const second = applyPermissionOverlay(first.document, buildGlobalPermissionOverlay(build(), ROOT), [first.journal]);
    // The second run inherits what the operator had rather than re-recording
    // the runner's own registration as if it were theirs.
    expect(second.journal.surface.suspended).toEqual(first.journal.surface.suspended);

    const afterSecond = revertPermissionOverlay(second.document, second.journal, [first.journal.claim]);
    expect(afterSecond.tools.core).toEqual([...RESEARCH_TOOL_SURFACE_CORE]);
    expect(afterSecond.autoAccept).toBe(false);
    expect(revertPermissionOverlay(afterSecond, first.journal, [])).toEqual(before);
  });

  test('a key something else rewrote during the run is left alone', () => {
    const before = { tools: { core: ['run_shell_command'] } };
    const applied = applyPermissionOverlay(before, buildGlobalPermissionOverlay(build(), ROOT));
    const edited = { ...applied.document, tools: { core: ['glob'], exclude: [] } };
    // Not the registration this overlay installed, so it is an edit somebody
    // else made — restoring over it would silently undo their change.
    expect(revertPermissionOverlay(edited, applied.journal).tools).toEqual({ core: ['glob'], exclude: [] });
  });

  test('a journal written before the surface existed still reverts what it claimed', () => {
    const applied = applyPermissionOverlay({ autoAccept: true }, buildGlobalPermissionOverlay(build(), ROOT));
    const legacy = { ...applied.journal };
    delete legacy.surface;
    // Nothing to restore, and nothing widened: the registration simply stays.
    expect(revertPermissionOverlay(applied.document, legacy).autoAccept).toBe(false);
  });

  test('a live pre-surface co-tenant does not strand the registration installed', () => {
    // Rolling upgrade (issue #832 review): a journal from before the surface
    // existed is still live when a new run releases. It holds no surface and its
    // own release can restore none, so deferring to it — which counting
    // permission claims does — would leave the read-only registration in the
    // operator's global store with nothing able to take it back out, and later
    // runs would read it as configuration they must preserve.
    const before = { autoAccept: true, tools: { core: ['run_shell_command'] } };
    const legacyRun = applyPermissionOverlay(before, buildGlobalPermissionOverlay(build(), ROOT));
    const legacyJournal = { ...legacyRun.journal };
    delete legacyJournal.surface;
    // What that build actually left: its rules installed, the surface untouched.
    const legacyDocument = { ...legacyRun.document };
    for (const key of SUSPENDED_GLOBAL_SURFACE_KEYS) delete legacyDocument[key];
    Object.assign(legacyDocument, before);

    // The new run has a faithful handoff — no live overlay installed a surface —
    // so it records the operator's real values and registers the read-only set.
    expect(detectSurfaceHandoffDrift(legacyDocument, [legacyJournal])).toEqual([]);
    const fresh = applyPermissionOverlay(
      legacyDocument,
      buildGlobalPermissionOverlay(build(), ROOT),
      [legacyJournal],
    );
    expect(fresh.document.tools.core).toEqual([...RESEARCH_TOOL_SURFACE_CORE]);

    const after = revertPermissionOverlay(
      fresh.document,
      fresh.journal,
      [{ ...legacyJournal.claim, holdsSurface: false }],
    );
    // The operator's keys are back, including the ones they never had.
    expect(after.autoAccept).toBe(true);
    expect(after.tools).toEqual({ core: ['run_shell_command'] });
    expect(after.mcpServers).toBeUndefined();
    expect(after.coreTools).toBeUndefined();
    // ...while the live co-tenant's own rules stay exactly where they were.
    expect(after.permissions.allow).toEqual(legacyRun.document.permissions.allow);

    // A co-tenant that *is* holding the surface still defers, unchanged.
    const held = revertPermissionOverlay(
      fresh.document,
      fresh.journal,
      [{ ...legacyJournal.claim, holdsSurface: true }],
    );
    expect(held.tools.core).toEqual([...RESEARCH_TOOL_SURFACE_CORE]);
    expect(held.autoAccept).toBe(false);
  });

  test('a key the operator changed under a co-tenant overlay is not handed over', () => {
    // The inheritance in `installSurface` assumes the document still holds what
    // the live overlay installed. An operator editing one of these keys while
    // that overlay is in flight breaks the assumption: their value is in the
    // document and in no journal, so a second overlay that wrote over it would
    // leave the last release restoring what the key held before their edit.
    const before = { autoAccept: true, mcpServers: { theirs: { command: '/usr/local/bin/tool-server' } } };
    const first = applyPermissionOverlay(before, buildGlobalPermissionOverlay(build(), ROOT));
    expect(detectSurfaceHandoffDrift(first.document, [first.journal])).toEqual([]);

    const edited = { ...first.document, mcpServers: { added: { command: '/usr/local/bin/other' } } };
    expect(detectSurfaceHandoffDrift(edited, [first.journal])).toEqual(['mcpServers']);
    // Removing the key entirely is the same kind of change, and the co-tenant's
    // own release still leaves whatever it finds there alone.
    const removed = { ...first.document };
    delete removed.autoAccept;
    expect(detectSurfaceHandoffDrift(removed, [first.journal])).toEqual(['autoAccept']);
    expect(revertPermissionOverlay(edited, first.journal).mcpServers)
      .toEqual({ added: { command: '/usr/local/bin/other' } });
  });

  test('a co-tenant that installed a different surface still accounts for the document', () => {
    // Live runs from different builds may have registered different surfaces;
    // the document carries whichever went in last, and that is a registration
    // some live overlay owns, not an operator edit.
    const applied = applyPermissionOverlay({}, buildGlobalPermissionOverlay(build(), ROOT));
    const older = {
      ...applied.journal,
      surface: {
        installed: { ...applied.journal.surface.installed, excludeTools: ['run_shell_command'] },
        suspended: applied.journal.surface.suspended,
      },
    };
    expect(detectSurfaceHandoffDrift(applied.document, [older, applied.journal])).toEqual([]);
    // Only what a live overlay installed counts: a value neither of them wrote
    // is still an edit nobody can put back.
    expect(detectSurfaceHandoffDrift({ ...applied.document, excludeTools: ['glob'] }, [older, applied.journal]))
      .toEqual(['excludeTools']);
  });

  test('no live overlay and a pre-surface journal hand nothing over', () => {
    const applied = applyPermissionOverlay({ autoAccept: true }, buildGlobalPermissionOverlay(build(), ROOT));
    // Nothing installed: the document's own values are the operator's.
    expect(detectSurfaceHandoffDrift(applied.document, [])).toEqual([]);
    const legacy = { ...applied.journal };
    delete legacy.surface;
    // A journal from before the surface existed installed none of these keys, so
    // there is no handoff to protect...
    expect(detectSurfaceHandoffDrift(applied.document, [legacy])).toEqual([]);
    // ...but it cannot vouch for a *newer* overlay's registration either, and
    // inheritance reads the oldest, so that combination fails closed.
    expect(detectSurfaceHandoffDrift(applied.document, [legacy, applied.journal]))
      .toEqual([...SUSPENDED_GLOBAL_SURFACE_KEYS]);
  });

  test('surface identity ignores key order but not list order', () => {
    expect(canonicalJson({ b: 1, a: [1, 2] })).toBe(canonicalJson({ a: [1, 2], b: 1 }));
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson(undefined)).toBe('null');
  });
});

// ---------------------------------------------------------------------------
// Public reporting
// ---------------------------------------------------------------------------

describe('research workspace settings — public failure strings', () => {
  test('name the reason literal without any path or content', () => {
    const message = publicWorkspaceSettingsMessage('settings-tracked-by-git');
    expect(message).toContain('settings-tracked-by-git');
    expect(message).toContain('tracked by Git');
    expect(message).not.toContain('/');
    expect(message).toMatch(/local run artifacts/);
  });

  test('every refusal reason has a fixed, path-free description', () => {
    for (const reason of [
      'workspace-root-not-absolute',
      'workspace-root-unrepresentable',
      'workspace-root-unresolvable',
      'settings-path-escapes-workspace',
      'settings-dir-symlink',
      'settings-symlink',
      'settings-tracked-by-git',
      'settings-not-ignored',
      'settings-write-verification-failed',
      'workspace-dirty-after-write',
      'workspace-not-trusted',
      'workspace-distrusted',
      'trust-store-unreadable',
      'trust-store-inside-workspace',
      'git-probe-failed',
      'rule-budget-exceeded',
      'operator-glob-budget-exceeded',
      'unvetted-cli-binary',
      'schema-drift',
      'cli-version-unreadable',
      'unsupported-cli-version',
      'global-settings-not-canonical',
      'global-settings-locked',
      'global-overlay-contended',
      'global-overlay-journal-damaged',
      'global-overlay-release-failed',
      'global-settings-write-failed',
    ]) {
      const message = publicWorkspaceSettingsMessage(reason);
      expect(message).toContain(`reason: ${reason}`);
      expect(message).not.toContain('undefined');
    }
  });
});
