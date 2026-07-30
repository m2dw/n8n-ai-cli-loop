/**
 * `admin session-audit` (issue #533): loop design readiness audit.
 *
 * Two layers are covered:
 *   - the pure rule engine (`buildSessionAudit`), exercised with synthetic
 *     sessions + facts so every severity path is deterministic; and
 *   - the CLI surface, which must stay read-only (no project command, no GitHub
 *     or SQLite mutation), exit 0 even when the verdict is `not-ready`, and offer
 *     both human and `--json` output.
 */
import { execFileSync } from 'child_process';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { createServer } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSessionAudit, createGiteaHttp, requiredWorkItemLabels } from '../dist/index.js';
import {
  collectSessionAuditFacts,
  createProbeDeadline,
  defaultAuditGiteaHttp,
  withGiteaProbeBudget,
} from '../dist/cli/session-audit.js';

const CLI = new URL('../dist/cli/admin.js', import.meta.url).pathname;
const NOW = '2026-07-28T10:00:00.000Z';

// ---------------------------------------------------------------------------
// Pure rule engine
// ---------------------------------------------------------------------------

/**
 * Resolved-session-shaped object. `buildSessionAudit` reads only configuration,
 * so a plain object is sufficient; `repoRoot` is a literal absolute path because
 * every repo-derived rule here is pure path math (no filesystem access).
 */
function session(overrides = {}) {
  return {
    sessionId: 'addon-dev',
    repoKey: 'addon',
    repoRoot: '/srv/addon',
    githubRepo: 'm2dw/addon',
    artifactDir: '.n8n-artifacts',
    defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
    verification: { test: 'npm test' },
    labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
    notifications: { slack: { enabled: true, webhookUrlEnv: 'SLACK_INCOMING_WEBHOOK' } },
    workItemProvider: { provider: 'github-issues', auth: { mode: 'gh' } },
    repoHostProvider: { provider: 'github', auth: { mode: 'gh' } },
    repoHostProviderConfigured: false,
    artifactRoot: '/srv/addon/.n8n-artifacts',
    githubOwner: 'm2dw',
    githubName: 'addon',
    ...overrides,
  };
}

/**
 * Every label the default `session()` above requires: the fixed routing names
 * intake matches literally, the defaulted names the runtime writes
 * (`status:stack-ready`, `status:conflict-resolution-failed`), and the session's
 * own `labels` values.
 */
const ALL_LABELS = [
  'agent:claude',
  'agent:codex',
  'agent:gemini',
  'status:needs-implementation',
  'status:needs-fix',
  'status:needs-review',
  'status:research-needed',
  'status:content-needed',
  'status:needs-conflict-resolution',
  'status:backlog',
  'status:stack-ready',
  'status:conflict-resolution-failed',
  'ai:active',
  'ai:blocked',
  'ai:ready-for-human',
];

function facts(overrides = {}) {
  return {
    repoRootExists: true,
    artifactDirIgnored: 'ignored',
    detectedEcosystems: [],
    workItemLabels: { status: 'ok', names: ALL_LABELS },
    workItemRepoVisibility: { status: 'known', visibility: 'private' },
    ...overrides,
  };
}

/** Session overrides that move work items onto a Gitea tracker (split-provider mode). */
const GITEA_SESSION = {
  workItemProvider: {
    provider: 'gitea-issues',
    auth: { mode: 'api-token', tokenEnv: 'GITEA_TOKEN' },
    gitea: { baseUrl: 'https://git.example', owner: 'm2dw', repo: 'addon-private' },
  },
};

const HEALTHY_ENV = { SLACK_INCOMING_WEBHOOK: 'https://hooks.example/abc' };

function audit(sessionOverrides = {}, factOverrides = {}, env = HEALTHY_ENV) {
  return buildSessionAudit(session(sessionOverrides), facts(factOverrides), env, NOW);
}

function check(payload, id) {
  const found = payload.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check with id ${id}; got ${payload.checks.map((c) => c.id).join(', ')}`);
  return found;
}

describe('buildSessionAudit — healthy session', () => {
  test('a fully configured session is ready with no findings', () => {
    const payload = audit();
    expect(payload.ok).toBe(true);
    expect(payload.sessionId).toBe('addon-dev');
    expect(payload.generatedAt).toBe(NOW);
    expect(payload.verdict).toBe('ready');
    expect(payload.summary).toMatchObject({ error: 0, warning: 0, suggestion: 0, acknowledged: 0 });
    // No finding-severity check survives, and every reported check carries detail.
    expect(payload.checks.filter((c) => ['error', 'warning', 'suggestion'].includes(c.status))).toEqual([]);
    expect(payload.checks.every((c) => typeof c.detail === 'string' && c.detail.length > 0)).toBe(true);
    expect(check(payload, 'work-item-labels').status).toBe('ok');
    expect(check(payload, 'verification-commands').status).toBe('ok');
    expect(check(payload, 'artifact-dir-ignored').status).toBe('ok');
    expect(check(payload, 'circuit-breaker').status).toBe('ok');
  });

  test('every non-ok, non-skipped check carries an actionable remedy', () => {
    const payload = audit(
      { verification: {}, notifications: undefined },
      { artifactDirIgnored: 'not-ignored', workItemLabels: { status: 'ok', names: [] } },
      {},
    );
    const findings = payload.checks.filter((c) => !['ok', 'skipped'].includes(c.status));
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(typeof f.remedy).toBe('string');
      expect(f.remedy.length).toBeGreaterThan(0);
    }
  });
});

describe('buildSessionAudit — missing labels', () => {
  test('missing routing labels are an error naming each label and its gh command', () => {
    const present = ALL_LABELS.filter((l) => l !== 'status:needs-review' && l !== 'ai:blocked');
    const payload = audit({}, { workItemLabels: { status: 'ok', names: present } });
    const labels = check(payload, 'work-item-labels');
    expect(labels.status).toBe('error');
    expect(labels.detail).toContain('status:needs-review');
    expect(labels.detail).toContain('ai:blocked');
    expect(labels.remedy).toContain('gh label create "status:needs-review" --repo m2dw/addon');
    expect(payload.verdict).toBe('not-ready');
  });

  test('the required set covers the runtime labels beyond the intake literals', () => {
    // `status:stack-ready` is applied on every passing review and read back by the
    // dependency resolver; `status:content-needed` is a lane intake routes on;
    // `status:conflict-resolution-failed` is added when resolution gives up. A
    // tracker missing any of them cannot complete those transitions, so none may
    // be certified `ready` by omission from the check.
    for (const label of [
      'status:stack-ready',
      'status:content-needed',
      'status:conflict-resolution-failed',
    ]) {
      const payload = audit({}, { workItemLabels: { status: 'ok', names: ALL_LABELS.filter((l) => l !== label) } });
      const labels = check(payload, 'work-item-labels');
      expect(labels.status).toBe('error');
      expect(labels.detail).toContain(label);
      expect(payload.verdict).toBe('not-ready');
    }
  });

  test('the required set is the effective session labels, not fixed defaults', () => {
    // A session that renames its state labels writes the renamed names on every
    // transition. Requiring the defaults instead would certify a tracker on which
    // every outbound write of `loop:handoff` fails at dispatch time.
    const renamed = {
      labels: {
        active: 'loop:running',
        blocked: 'loop:blocked',
        readyForHuman: 'loop:handoff',
        stackReady: 'loop:stack-ready',
      },
    };
    const withDefaults = audit(renamed, { workItemLabels: { status: 'ok', names: ALL_LABELS } });
    const missing = check(withDefaults, 'work-item-labels');
    expect(missing.status).toBe('error');
    expect(missing.detail).toContain('loop:handoff');
    expect(missing.detail).toContain('loop:stack-ready');

    // The overridden names satisfy the check; the defaults they replaced —
    // `ai:*` and `status:stack-ready` — are no longer required of this session,
    // because nothing in its runtime writes them.
    const renamedNames = [
      ...ALL_LABELS.filter(
        (l) => !l.startsWith('ai:') && l !== 'status:stack-ready',
      ),
      'loop:running',
      'loop:blocked',
      'loop:handoff',
      'loop:stack-ready',
    ];
    const payload = audit(renamed, { workItemLabels: { status: 'ok', names: renamedNames } });
    expect(check(payload, 'work-item-labels').status).toBe('ok');
  });

  test('requiredWorkItemLabels is the set the check reports against', () => {
    expect(requiredWorkItemLabels(session())).toEqual(ALL_LABELS);
    // The literal intake names stay required even when a session renames the
    // label its own transitions write: intake keeps matching `status:needs-review`.
    const renamed = requiredWorkItemLabels(session({
      labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human', needsReview: 'loop:review' },
    }));
    expect(renamed).toContain('status:needs-review');
    expect(renamed).toContain('loop:review');
    // A blank name is `session-state-labels`' finding, not an unfixable
    // "missing label ``" line here.
    expect(
      requiredWorkItemLabels(session({
        labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human', needsReview: '  ' },
      })),
    ).not.toContain('');
  });

  test('an unreadable tracker is a warning, not a missing-label error', () => {
    const payload = audit({}, { workItemLabels: { status: 'unavailable', error: 'gh: not authenticated' } });
    const labels = check(payload, 'work-item-labels');
    expect(labels.status).toBe('warning');
    expect(labels.detail).toContain('gh: not authenticated');
    expect(payload.verdict).toBe('needs-attention');
  });

  test('a provider with no wired backend skips the label lookup', () => {
    const payload = audit({}, { workItemLabels: { status: 'skipped', reason: 'work-item provider is jira' } });
    expect(check(payload, 'work-item-labels').status).toBe('skipped');
  });

  test('a Gitea tracker missing routing labels is an error naming the Gitea repo', () => {
    const present = ALL_LABELS.filter((l) => l !== 'status:needs-implementation');
    const payload = audit(GITEA_SESSION, { workItemLabels: { status: 'ok', names: present } });
    const labels = check(payload, 'work-item-labels');
    expect(labels.status).toBe('error');
    expect(labels.detail).toContain('https://git.example/m2dw/addon-private');
    expect(labels.detail).toContain('status:needs-implementation');
    // The remedy must target Gitea: a `gh label create` line here would silently
    // point the operator at a different repository.
    expect(labels.remedy).toContain('/api/v1/repos/m2dw/addon-private/labels');
    expect(labels.remedy).not.toContain('gh label create');
    expect(payload.verdict).toBe('not-ready');
  });

  test('a fully labelled Gitea tracker passes, reported against the Gitea repo', () => {
    const payload = audit(GITEA_SESSION, {
      workItemLabels: { status: 'ok', names: ALL_LABELS },
      workItemRepoVisibility: { status: 'known', visibility: 'private' },
    });
    const labels = check(payload, 'work-item-labels');
    expect(labels.status).toBe('ok');
    expect(labels.detail).toContain('https://git.example/m2dw/addon-private');
  });

  test('session state labels that collide are an error', () => {
    const payload = audit({
      labels: { active: 'ai:busy', blocked: 'ai:busy', readyForHuman: 'ai:ready-for-human' },
    });
    const labels = check(payload, 'session-state-labels');
    expect(labels.status).toBe('error');
    expect(labels.detail).toContain('ai:busy');
  });
});

describe('buildSessionAudit — artifact hygiene', () => {
  test('an unignored artifactDir is an error with a gitignore fix', () => {
    const payload = audit({}, { artifactDirIgnored: 'not-ignored' });
    const artifacts = check(payload, 'artifact-dir-ignored');
    expect(artifacts.status).toBe('error');
    expect(artifacts.detail).toContain('.n8n-artifacts');
    expect(artifacts.remedy).toContain(".gitignore");
    expect(payload.verdict).toBe('not-ready');
  });

  test('an indeterminate ignore lookup is a warning, never a silent pass', () => {
    const payload = audit({}, { artifactDirIgnored: 'unknown' });
    expect(check(payload, 'artifact-dir-ignored').status).toBe('warning');
  });

  test('a missing repoRoot downgrades the ignore check to a warning', () => {
    const payload = audit({}, { repoRootExists: false, artifactDirIgnored: 'unknown' });
    const artifacts = check(payload, 'artifact-dir-ignored');
    expect(artifacts.status).toBe('warning');
    expect(artifacts.detail).toContain('repoRoot does not exist');
  });

  test('an artifactDir that escapes the checkout is an error', () => {
    const payload = audit({ artifactDir: '../outside-artifacts' });
    const location = check(payload, 'artifact-location');
    expect(location.status).toBe('error');
    expect(location.detail).toContain('outside /srv/addon');
  });
});

describe('buildSessionAudit — verification', () => {
  test('no verification commands is an error that points at the presets', () => {
    const payload = audit({ verification: {} });
    const verification = check(payload, 'verification-commands');
    expect(verification.status).toBe('error');
    expect(verification.remedy).toContain('admin session preset show');
    expect(verification.remedy).toContain('audit.acknowledge');
    expect(payload.verdict).toBe('not-ready');
  });

  test('a configured-but-empty verification command is an error', () => {
    const payload = audit({ verification: { test: '   ' } });
    const verification = check(payload, 'verification-commands');
    expect(verification.status).toBe('error');
    expect(verification.detail).toContain('test');
  });
});

describe('buildSessionAudit — acknowledgements', () => {
  test('a documented reason downgrades a finding but keeps its severity visible', () => {
    const payload = audit({
      verification: {},
      audit: { acknowledge: { 'verification-commands': 'docs-only repo; nothing to run' } },
    });
    const verification = check(payload, 'verification-commands');
    expect(verification.status).toBe('acknowledged');
    expect(verification.acknowledged).toEqual({
      severity: 'error',
      reason: 'docs-only repo; nothing to run',
    });
    // The remedy stays attached, and the accepted finding no longer blocks.
    expect(verification.remedy).toBeDefined();
    expect(payload.summary.acknowledged).toBe(1);
    expect(payload.verdict).toBe('ready');
  });

  test('an acknowledgement for an unknown check id is reported as suppressing nothing', () => {
    const payload = audit({ audit: { acknowledge: { 'verificaton-commands': 'typo' } } });
    const ack = check(payload, 'audit-acknowledgements');
    expect(ack.status).toBe('suggestion');
    expect(ack.detail).toContain('verificaton-commands');
    expect(ack.remedy).toContain('verification-commands');
  });

  test('an acknowledgement of the acknowledgement check itself suppresses nothing', () => {
    // Self-referential entry + a typo: the validator must still report the typo.
    // If the entry could downgrade the validator's own finding, the invalid key
    // would silently disappear and the verdict would read as clean.
    const payload = audit({
      audit: {
        acknowledge: {
          'audit-acknowledgements': 'we know',
          'verificaton-commands': 'typo',
        },
      },
    });
    const ack = check(payload, 'audit-acknowledgements');
    expect(ack.status).toBe('suggestion');
    expect(ack.acknowledged).toBeUndefined();
    expect(ack.detail).toContain('verificaton-commands');
    expect(ack.detail).toContain('audit-acknowledgements');
    expect(payload.summary.suggestion).toBe(1);
  });

  test('a self-referential acknowledgement is reported even on its own', () => {
    const payload = audit({ audit: { acknowledge: { 'audit-acknowledgements': 'quiet, please' } } });
    const ack = check(payload, 'audit-acknowledgements');
    expect(ack.status).toBe('suggestion');
    expect(ack.remedy).toContain('validates the acknowledgement block itself');
    // Valid ids never advertise the validator as an acknowledgeable target.
    expect(ack.remedy).not.toContain('Valid ids: audit-acknowledgements');
  });

  test('an acknowledgement for a passing check is flagged as no longer needed', () => {
    const payload = audit({ audit: { acknowledge: { 'verification-commands': 'stale note' } } });
    expect(check(payload, 'verification-commands').status).toBe('ok');
    const ack = check(payload, 'audit-acknowledgements');
    expect(ack.status).toBe('suggestion');
    expect(ack.detail).toContain('no longer needed');
  });
});

describe('buildSessionAudit — notifications and kill switch', () => {
  test('no notification channel is a warning about the recovery path', () => {
    const payload = audit({ notifications: undefined });
    const notify = check(payload, 'handoff-notifications');
    expect(notify.status).toBe('warning');
    expect(notify.remedy).toContain('admin status');
    // With no channel enabled there is no secret to resolve.
    expect(check(payload, 'notification-secret').status).toBe('skipped');
  });

  test('an enabled channel whose secret env var is unset is an error', () => {
    const payload = audit({}, {}, {});
    const secret = check(payload, 'notification-secret');
    expect(secret.status).toBe('error');
    expect(secret.detail).toContain('SLACK_INCOMING_WEBHOOK');
    expect(secret.remedy).toContain('dispatch-outbox');
  });

  test('both circuit-breaker rules disabled is an error', () => {
    const payload = audit({}, {}, {
      ...HEALTHY_ENV,
      CIRCUIT_BREAKER_SESSION_FAILURES: '0',
      CIRCUIT_BREAKER_ISSUE_PHASE_FAILURES: '0',
    });
    const breaker = check(payload, 'circuit-breaker');
    expect(breaker.status).toBe('error');
    expect(payload.verdict).toBe('not-ready');
  });

  test('one circuit-breaker rule disabled is a warning naming the variable', () => {
    const payload = audit({}, {}, { ...HEALTHY_ENV, CIRCUIT_BREAKER_SESSION_FAILURES: '0' });
    const breaker = check(payload, 'circuit-breaker');
    expect(breaker.status).toBe('warning');
    expect(breaker.remedy).toContain('CIRCUIT_BREAKER_SESSION_FAILURES');
  });
});

describe('buildSessionAudit — worktrees, environment, assignment, visibility', () => {
  test('a worktree root inside the checkout is an error', () => {
    const payload = audit({ worktrees: { root: '/srv/addon/.worktrees' } });
    const worktree = check(payload, 'worktree-root');
    expect(worktree.status).toBe('error');
    expect(worktree.detail).toContain('inside the checkout');
  });

  test('a session root that shadows the env override is a warning', () => {
    const payload = audit({ worktrees: { root: '/var/state/worktrees' } }, {}, {
      ...HEALTHY_ENV,
      N8N_AI_WORKTREE_ROOT: '/other/state/worktrees',
    });
    const worktree = check(payload, 'worktree-root');
    expect(worktree.status).toBe('warning');
    expect(worktree.detail).toContain('/other/state/worktrees');
  });

  test('a detected ecosystem without environmentPrepare warns and names the preset', () => {
    const payload = audit({}, { detectedEcosystems: ['javascript-npm'] });
    const prepare = check(payload, 'environment-prepare');
    expect(prepare.status).toBe('warning');
    expect(prepare.remedy).toContain('admin session preset show javascript-npm');
    // Dependency sync is only a suggestion: manifest edits still work, they just
    // detour through a Tool Request handoff.
    expect(check(payload, 'dependency-sync').status).toBe('suggestion');
    expect(payload.verdict).toBe('needs-attention');
  });

  test('an enabled dependencySync without triggerPaths can never fire', () => {
    const payload = audit(
      { dependencySync: { enabled: true, command: 'npm install --package-lock-only', triggerPaths: [], expectedOutputs: [] } },
      { detectedEcosystems: ['javascript-npm'] },
    );
    expect(check(payload, 'dependency-sync').status).toBe('warning');
  });

  test('no ecosystem detected skips the environment checks instead of guessing', () => {
    const payload = audit();
    expect(check(payload, 'environment-prepare').status).toBe('skipped');
    expect(check(payload, 'dependency-sync').status).toBe('skipped');
  });

  test('an unresolvable assignment is an error', () => {
    const payload = audit({
      assignmentProfiles: { code: { implementation: 'claude', review: 'codex', conflict_resolution: 'codex' } },
      flowRules: [{ flow: 'code', default: true }],
      defaultFlow: 'code',
    });
    expect(check(payload, 'assignment-defaults').status).toBe('error');
  });

  test('a non-default flow that cannot resolve is an error, even when the default flow is fine', () => {
    // Intake resolves the assignment from the issue's labels, so a broken
    // `flow:docs` rule fails task creation for every docs-labelled issue while
    // the empty-label (default) resolution still succeeds.
    const payload = audit({
      assignmentProfiles: {
        code: { implementation: 'claude', review: 'codex' },
        docs: { implementation: 'claude', review: 'codex', conflict_resolution: 'codex' },
      },
      flowRules: [
        { flow: 'docs', labels: ['flow:docs'] },
        { flow: 'code', default: true },
      ],
      defaultFlow: 'code',
    });
    const assignment = check(payload, 'assignment-defaults');
    expect(assignment.status).toBe('error');
    expect(assignment.detail).toContain('flow:docs');
    expect(assignment.detail).toContain('conflict_resolution');
  });

  test('a multi-flow session that resolves everywhere is ok and describes each flow', () => {
    const payload = audit({
      assignmentProfiles: {
        code: { implementation: 'claude', review: 'codex' },
        docs: { implementation: 'claude', review: 'claude' },
      },
      flowRules: [
        { flow: 'docs', labels: ['flow:docs'] },
        { flow: 'code', default: true },
      ],
      defaultFlow: 'code',
    });
    const assignment = check(payload, 'assignment-defaults');
    expect(assignment.status).toBe('ok');
    expect(assignment.detail).toContain('flow=code');
    expect(assignment.detail).toContain('flow=docs');
  });

  test('a missing research agent is only a suggestion', () => {
    const payload = audit({ defaults: { implementationAgent: 'claude', reviewAgent: 'codex' } });
    const assignment = check(payload, 'assignment-defaults');
    expect(assignment.status).toBe('suggestion');
    expect(payload.verdict).toBe('ready');
  });

  test('a public work-item tracker warns about world-readable internal detail', () => {
    const payload = audit({}, { workItemRepoVisibility: { status: 'known', visibility: 'public' } });
    const boundary = check(payload, 'public-private-boundary');
    expect(boundary.status).toBe('warning');
    expect(boundary.remedy).toContain('audit.acknowledge');
  });

  test('a public Gitea work-item repo warns, even though it is not the code host', () => {
    const payload = audit(GITEA_SESSION, {
      workItemRepoVisibility: { status: 'known', visibility: 'public' },
    });
    const boundary = check(payload, 'public-private-boundary');
    expect(boundary.status).toBe('warning');
    expect(boundary.detail).toContain('https://git.example/m2dw/addon-private');
    expect(boundary.remedy).toContain('audit.acknowledge');
    expect(payload.verdict).toBe('needs-attention');
  });

  test('a private Gitea work-item repo passes, reported against the Gitea repo', () => {
    const payload = audit(GITEA_SESSION, {
      workItemRepoVisibility: { status: 'known', visibility: 'private' },
    });
    const boundary = check(payload, 'public-private-boundary');
    expect(boundary.status).toBe('ok');
    expect(boundary.detail).toContain('https://git.example/m2dw/addon-private');
  });

  test('an unprobeable tracker is reported unknown, never certified private', () => {
    const payload = audit(
      { workItemProvider: { provider: 'jira', auth: { mode: 'api-token', tokenEnv: 'JIRA_TOKEN' } } },
      {
        workItemLabels: { status: 'skipped', reason: 'work-item provider is jira' },
        workItemRepoVisibility: {
          status: 'unknown',
          reason: 'no visibility probe is implemented for work-item provider jira',
        },
      },
    );
    const boundary = check(payload, 'public-private-boundary');
    expect(boundary.status).toBe('warning');
    expect(boundary.detail).toContain('unknown');
    expect(boundary.remedy).toContain('audit.acknowledge');
    expect(payload.verdict).toBe('needs-attention');
  });

  test('an unknown boundary can be accepted in writing, like any other finding', () => {
    const payload = audit(
      {
        workItemProvider: { provider: 'jira', auth: { mode: 'api-token', tokenEnv: 'JIRA_TOKEN' } },
        audit: { acknowledge: { 'public-private-boundary': 'tracker is on the internal network only' } },
      },
      {
        workItemLabels: { status: 'skipped', reason: 'work-item provider is jira' },
        workItemRepoVisibility: { status: 'unknown', reason: 'no visibility probe for jira' },
      },
    );
    const boundary = check(payload, 'public-private-boundary');
    expect(boundary.status).toBe('acknowledged');
    expect(boundary.acknowledged.severity).toBe('warning');
    expect(payload.verdict).toBe('ready');
  });

  test('a failed visibility probe is a warning, not an assumed-private pass', () => {
    const payload = audit(GITEA_SESSION, {
      workItemRepoVisibility: { status: 'unavailable', error: 'Gitea GET (HTTP 401): unauthorized' },
    });
    const boundary = check(payload, 'public-private-boundary');
    expect(boundary.status).toBe('warning');
    expect(boundary.detail).toContain('HTTP 401');
  });
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

describe('admin session-audit CLI', () => {
  let tmpDir;
  let repoRoot;
  let sessionsPath;

  /**
   * Run the CLI with a pinned environment: the audit reads the notification
   * secret, the worktree-root override and the circuit-breaker thresholds from
   * the environment, so the host's own values must not leak into the assertions.
   */
  function run(...args) {
    const env = { ...process.env, SLACK_INCOMING_WEBHOOK: 'https://hooks.example/abc' };
    delete env.N8N_AI_WORKTREE_ROOT;
    delete env.CIRCUIT_BREAKER_SESSION_FAILURES;
    delete env.CIRCUIT_BREAKER_ISSUE_PHASE_FAILURES;
    try {
      const stdout = execFileSync(process.execPath, [CLI, 'session-audit', ...args], {
        encoding: 'utf8',
        env,
      });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }

  function writeSessions(extra = {}) {
    writeFileSync(
      sessionsPath,
      JSON.stringify({
        sessions: [
          {
            sessionId: 'addon-dev',
            repoKey: 'addon',
            repoRoot,
            githubRepo: 'm2dw/addon',
            artifactDir: '.n8n-artifacts',
            defaults: { implementationAgent: 'claude', reviewAgent: 'codex', researchAgent: 'gemini' },
            verification: { test: 'npm test' },
            labels: { active: 'ai:active', blocked: 'ai:blocked', readyForHuman: 'ai:ready-for-human' },
            notifications: { slack: { enabled: true, webhookUrlEnv: 'SLACK_INCOMING_WEBHOOK' } },
            worktrees: { root: join(tmpDir, 'state', 'worktrees') },
            ...extra,
          },
        ],
      }),
      'utf8',
    );
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'admin-session-audit-'));
    repoRoot = join(tmpDir, 'repo');
    sessionsPath = join(tmpDir, 'sessions.json');
    execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
    writeFileSync(join(repoRoot, '.gitignore'), '.n8n-artifacts/\n');
    writeSessions();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const base = () => ['--session-id', 'addon-dev', '--sessions-path', sessionsPath, '--offline'];

  test('--json emits the audit payload and exits 0 even when not ready', () => {
    writeFileSync(join(repoRoot, '.gitignore'), '# nothing ignored\n');
    const result = run(...base(), '--json');
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.sessionId).toBe('addon-dev');
    expect(payload.verdict).toBe('not-ready');
    const artifacts = payload.checks.find((c) => c.id === 'artifact-dir-ignored');
    expect(artifacts.status).toBe('error');
    expect(payload.summary.total).toBe(payload.checks.length);
  });

  test('a gitignored artifactDir passes the real git check-ignore probe', () => {
    const payload = JSON.parse(run(...base(), '--json').stdout.trim());
    expect(payload.checks.find((c) => c.id === 'artifact-dir-ignored').status).toBe('ok');
  });

  test('--offline reports the tracker checks as skipped instead of failing them', () => {
    const payload = JSON.parse(run(...base(), '--json').stdout.trim());
    expect(payload.checks.find((c) => c.id === 'work-item-labels').status).toBe('skipped');
    expect(payload.checks.find((c) => c.id === 'public-private-boundary').status).toBe('skipped');
  });

  test('human output is the default and shows the verdict and remedies', () => {
    writeSessions({ verification: {} });
    const result = run(...base());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Loop design audit for session "addon-dev"');
    expect(result.stdout).toContain('NOT READY');
    expect(result.stdout).toContain('verification-commands');
    expect(result.stdout).toContain('->');
    // Human mode must not emit JSON.
    expect(result.stdout.trimStart().startsWith('{')).toBe(false);
  });

  test('the audit is read-only: it creates no files and opens no database', () => {
    const before = readdirSync(tmpDir).sort();
    const sessionsBefore = readFileSync(sessionsPath, 'utf8');
    expect(run(...base(), '--json').code).toBe(0);
    expect(readdirSync(tmpDir).sort()).toEqual(before);
    expect(readFileSync(sessionsPath, 'utf8')).toBe(sessionsBefore);
    expect(existsSync(join(tmpDir, 'dev_loop.db'))).toBe(false);
    // No --db-path option exists at all: the audit never opens the store, so it
    // cannot materialise the DB file/schema as a side effect of inspection.
    const rejected = run(...base(), '--db-path', join(tmpDir, 'dev_loop.db'));
    expect(rejected.code).toBe(1);
  });

  test('an unknown session fails with an actionable error', () => {
    const result = run('--session-id', 'nope', '--sessions-path', sessionsPath, '--offline');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown sessionId: nope');
  });

  test('an acknowledged finding is reported as accepted with its reason', () => {
    writeSessions({
      verification: {},
      audit: { acknowledge: { 'verification-commands': 'docs-only repo' } },
    });
    const payload = JSON.parse(run(...base(), '--json').stdout.trim());
    const verification = payload.checks.find((c) => c.id === 'verification-commands');
    expect(verification.status).toBe('acknowledged');
    expect(verification.acknowledged).toEqual({ severity: 'error', reason: 'docs-only repo' });
  });

  test('a blank acknowledgement reason is rejected by session validation', () => {
    writeSessions({ audit: { acknowledge: { 'verification-commands': '' } } });
    const result = run(...base(), '--json');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('audit.acknowledge');
  });

  test('admin help lists the command', () => {
    const stdout = execFileSync(process.execPath, [CLI, 'help', 'session-audit'], { encoding: 'utf8' });
    expect(stdout).toContain('session-audit');
    expect(stdout).toContain('--offline');
  });
});

// ---------------------------------------------------------------------------
// Gitea tracker probes (fact collection)
//
// A `gitea-issues` session is a wired runtime provider: intake routes its
// candidates through the same literal labels, and a state transition fails when
// its label is absent. The audit therefore probes Gitea for real instead of
// skipping the tracker checks — over read-only GETs, with an injected transport
// so no network (and no subprocess) is involved here.
// ---------------------------------------------------------------------------

describe('collectSessionAuditFacts — Gitea tracker probes', () => {
  const TOKEN = 'a'.repeat(40);
  const GITEA_ENV = { GITEA_TOKEN: TOKEN };

  function giteaSession(overrides = {}) {
    return session({
      // A path that does not exist: fact collection must still probe the tracker,
      // and the repo-derived facts are not what these tests assert.
      repoRoot: '/nonexistent/addon',
      ...GITEA_SESSION,
      repoHostProvider: { provider: 'gitea', auth: { mode: 'api-token', tokenEnv: 'GITEA_TOKEN' } },
      ...overrides,
    });
  }

  /** Fake transport that records every request and answers from a route table. */
  function transport(routes) {
    const seen = [];
    const http = (req) => {
      seen.push(req);
      for (const [match, respond] of routes) {
        if (req.url.includes(match)) return respond(req);
      }
      return { status: 404, statusText: 'Not Found', body: '{}' };
    };
    return { http, seen };
  }

  const labelPage = (names) => JSON.stringify(names.map((name, i) => ({ id: i + 1, name })));

  test('label names are read from the paginated Gitea labels endpoint', () => {
    const { http, seen } = transport([
      ['/labels', (req) => ({ status: 200, statusText: 'OK', body: req.url.includes('page=1') ? labelPage(ALL_LABELS) : '[]' })],
      ['/repos/m2dw/addon-private', () => ({ status: 200, statusText: 'OK', body: JSON.stringify({ private: true }) })],
    ]);
    const collected = collectSessionAuditFacts(giteaSession(), false, { giteaHttp: http, env: GITEA_ENV });
    expect(collected.workItemLabels).toEqual({ status: 'ok', names: ALL_LABELS });
    expect(collected.workItemRepoVisibility).toEqual({ status: 'known', visibility: 'private' });
    // Read-only, and authenticated by header only.
    expect(seen.every((r) => r.method === 'GET')).toBe(true);
    expect(seen.every((r) => r.body === undefined)).toBe(true);
    expect(seen[0].headers.Authorization).toBe(`token ${TOKEN}`);
    expect(seen[0].url).toBe('https://git.example/api/v1/repos/m2dw/addon-private/labels?limit=50&page=1');
  });

  test('a missing label on Gitea reaches the audit as a missing-label error', () => {
    const present = ALL_LABELS.filter((l) => l !== 'ai:blocked');
    const { http } = transport([
      ['/labels', (req) => ({ status: 200, statusText: 'OK', body: req.url.includes('page=1') ? labelPage(present) : '[]' })],
      ['/repos/m2dw/addon-private', () => ({ status: 200, statusText: 'OK', body: JSON.stringify({ private: true }) })],
    ]);
    const session = giteaSession();
    const payload = buildSessionAudit(
      session,
      collectSessionAuditFacts(session, false, { giteaHttp: http, env: GITEA_ENV }),
      HEALTHY_ENV,
      NOW,
    );
    const labels = payload.checks.find((c) => c.id === 'work-item-labels');
    expect(labels.status).toBe('error');
    expect(labels.detail).toContain('ai:blocked');
    expect(payload.verdict).toBe('not-ready');
  });

  test('a public Gitea work-item repo is observed, not assumed private', () => {
    const { http } = transport([
      ['/labels', () => ({ status: 200, statusText: 'OK', body: '[]' })],
      ['/repos/m2dw/addon-private', () => ({ status: 200, statusText: 'OK', body: JSON.stringify({ private: false }) })],
    ]);
    const collected = collectSessionAuditFacts(giteaSession(), false, { giteaHttp: http, env: GITEA_ENV });
    expect(collected.workItemRepoVisibility).toEqual({ status: 'known', visibility: 'public' });
  });

  test('a failed Gitea probe is unavailable, with the token redacted', () => {
    const { http } = transport([
      ['', () => ({ status: 401, statusText: 'Unauthorized', body: `token ${TOKEN} is invalid` })],
    ]);
    const collected = collectSessionAuditFacts(giteaSession(), false, { giteaHttp: http, env: GITEA_ENV });
    expect(collected.workItemLabels.status).toBe('unavailable');
    expect(collected.workItemLabels.error).toContain('HTTP 401');
    expect(collected.workItemLabels.error).not.toContain(TOKEN);
    expect(collected.workItemRepoVisibility.status).toBe('unavailable');
  });

  test('an unresolvable API token is unavailable, never a silent skip', () => {
    const { http, seen } = transport([['', () => ({ status: 200, statusText: 'OK', body: '[]' })]]);
    const collected = collectSessionAuditFacts(giteaSession(), false, { giteaHttp: http, env: {} });
    expect(collected.workItemLabels.status).toBe('unavailable');
    expect(collected.workItemLabels.error).toContain('GITEA_TOKEN');
    expect(collected.workItemRepoVisibility.status).toBe('unavailable');
    expect(seen).toEqual([]);
  });

  test('a label list that never terminates fails closed instead of reporting labels missing', () => {
    // Every page comes back full: the list is truncated, so "missing" cannot be
    // concluded from it.
    const { http } = transport([
      ['/labels', () => ({ status: 200, statusText: 'OK', body: labelPage(['x']) })],
      ['/repos/m2dw/addon-private', () => ({ status: 200, statusText: 'OK', body: JSON.stringify({ private: true }) })],
    ]);
    const collected = collectSessionAuditFacts(giteaSession(), false, { giteaHttp: http, env: GITEA_ENV });
    expect(collected.workItemLabels.status).toBe('unavailable');
    expect(collected.workItemLabels.error).toContain('pages');
  });

  test('an unresponsive instance ends on the shared probe budget instead of hanging', () => {
    // A server that answers every page but never runs out of them: without a
    // wall-clock bound the audit would keep issuing requests (per-request
    // timeouts alone only bound one page). The budget is shared by the label and
    // visibility probes, so both end as `unavailable` rather than blocking.
    let clock = 0;
    const slow = () => {
      clock += 20_000;
      return { status: 200, statusText: 'OK', body: labelPage(['x']) };
    };
    const http = withGiteaProbeBudget(slow, () => clock, 60_000);
    const collected = collectSessionAuditFacts(giteaSession(), false, { giteaHttp: http, env: GITEA_ENV });
    expect(collected.workItemLabels.status).toBe('unavailable');
    expect(collected.workItemLabels.error).toContain('budget');
    expect(collected.workItemRepoVisibility.status).toBe('unavailable');
    expect(collected.workItemRepoVisibility.error).toContain('budget');
  });

  test('a request started late is capped at what is left of the budget, not the full per-request timeout', () => {
    // The pre-call budget check alone would still let the last page start a
    // fresh 15s wait and run past the advertised 60s bound, so the per-request
    // timeout is built from the deadline's remaining time.
    let clock = 0;
    const timeouts = [];
    const http = defaultAuditGiteaHttp(createProbeDeadline(() => clock, 60_000), (timeoutMs) => {
      timeouts.push(timeoutMs);
      return () => {
        clock += 50_000;
        return { status: 200, statusText: 'OK', body: '[]' };
      };
    });
    const get = () => http({ method: 'GET', url: 'https://git.example/api/v1/repos/m2dw/x/labels', headers: {} });
    get(); // 60s left: the per-request cap is the smaller bound.
    get(); // 10s left: the budget is.
    expect(timeouts).toEqual([15_000, 10_000]);
    expect(get).toThrow(/budget/);
  });

  test('a transport-level failure is reported, not thrown', () => {
    const http = () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3000');
    };
    const collected = collectSessionAuditFacts(giteaSession(), false, { giteaHttp: http, env: GITEA_ENV });
    expect(collected.workItemLabels.status).toBe('unavailable');
    expect(collected.workItemLabels.error).toContain('ECONNREFUSED');
  });

  test('--offline skips the Gitea probes entirely', () => {
    const { http, seen } = transport([['', () => ({ status: 200, statusText: 'OK', body: '[]' })]]);
    const collected = collectSessionAuditFacts(giteaSession(), true, { giteaHttp: http, env: GITEA_ENV });
    expect(collected.workItemLabels.status).toBe('skipped');
    expect(collected.workItemRepoVisibility.status).toBe('skipped');
    expect(seen).toEqual([]);
  });

  test('a provider with no wired backend leaves the boundary unknown, not ok', () => {
    const session = giteaSession({
      workItemProvider: { provider: 'jira', auth: { mode: 'api-token', tokenEnv: 'JIRA_TOKEN' } },
    });
    const collected = collectSessionAuditFacts(session, false, { env: {} });
    expect(collected.workItemLabels.status).toBe('skipped');
    expect(collected.workItemRepoVisibility.status).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// The audit's default Gitea transport
//
// The injected-transport tests above cannot observe the real one. This is the
// bound that keeps `session-audit` from hanging on an instance that accepts the
// connection and then says nothing, so it is exercised against a real socket.
// ---------------------------------------------------------------------------

describe('createGiteaHttp — request timeout', () => {
  test('a server that never answers ends as a transport failure, not a hang', async () => {
    const server = createServer(() => {
      /* accept the request, never respond */
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      const http = createGiteaHttp({ timeoutMs: 1_000 });
      expect(() =>
        http({ method: 'GET', url: `http://127.0.0.1:${port}/api/v1/repos/m2dw/x/labels`, headers: {} }),
      ).toThrow(/timed out after 1000ms/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// GitHub label completeness (fact collection)
//
// `gh label list` pages internally but stops at `--limit`, so a full-size result
// may be truncated. The audit reports labels as *missing*, so it must never draw
// that conclusion from a list it cannot prove is complete — a repository with
// more labels than the cap would otherwise get a bogus `not-ready` verdict.
// ---------------------------------------------------------------------------

describe('collectSessionAuditFacts — GitHub label completeness', () => {
  let tmpDir;
  let binDir;

  /** Fake `gh` on PATH that answers `label list` from a file and `repo view` inline. */
  function fakeGh(labels) {
    const labelsPath = join(binDir, 'labels.json');
    writeFileSync(labelsPath, JSON.stringify(labels.map((name) => ({ name }))), 'utf8');
    const shim = join(binDir, 'gh');
    writeFileSync(
      shim,
      `#!/bin/sh\n` +
        `if [ "$1" = "label" ]; then cat "${labelsPath}"; exit 0; fi\n` +
        `if [ "$1" = "repo" ]; then echo '{"visibility":"PRIVATE"}'; exit 0; fi\n` +
        `exit 1\n`,
      'utf8',
    );
    chmodSync(shim, 0o755);
  }

  /** Collect facts with the fake `gh` first on PATH (repoRoot deliberately absent). */
  function collect(deps = {}) {
    const realPath = process.env.PATH;
    process.env.PATH = `${binDir}:${realPath}`;
    try {
      return collectSessionAuditFacts(session({ repoRoot: join(tmpDir, 'nonexistent') }), false, deps);
    } finally {
      process.env.PATH = realPath;
    }
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'session-audit-gh-'));
    binDir = join(tmpDir, 'bin');
    mkdirSync(binDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a complete label list is read as ok', () => {
    fakeGh(ALL_LABELS);
    const collected = collect();
    expect(collected.workItemLabels).toEqual({ status: 'ok', names: ALL_LABELS });
  });

  test('a full-size result is unavailable, not a missing-label error', () => {
    // 1000 labels, none of them the routing labels: pre-fix this reported every
    // required label as missing (and a `not-ready` verdict) off a truncated list.
    fakeGh(Array.from({ length: 1000 }, (_, i) => `topic:${i}`));
    const collected = collect();
    expect(collected.workItemLabels.status).toBe('unavailable');
    expect(collected.workItemLabels.error).toContain('truncated');
    const payload = buildSessionAudit(
      session(),
      facts({ workItemLabels: collected.workItemLabels }),
      HEALTHY_ENV,
      NOW,
    );
    const labels = check(payload, 'work-item-labels');
    expect(labels.status).toBe('warning');
    expect(labels.detail).toContain('Could not read labels');
    expect(payload.verdict).not.toBe('not-ready');
  });

  test('the two gh probes share one budget instead of waiting it out twice', () => {
    // A slow `gh` that spends most of the run's budget on the label read must not
    // let the visibility read start another full-length wait: the documented bound
    // is per audit run, so an unresponsive GitHub ends the command in one budget,
    // not two. The clock is injected, so no real waiting happens here.
    fakeGh(ALL_LABELS);
    let clock = 0;
    const tick = () => {
      const value = clock;
      clock += 40_000;
      return value;
    };
    const collected = collect({ deadline: createProbeDeadline(tick, 60_000) });
    // First probe: 20s of budget left, so it still runs and succeeds.
    expect(collected.workItemLabels).toEqual({ status: 'ok', names: ALL_LABELS });
    // Second probe: budget spent — reported, not re-waited.
    expect(collected.workItemRepoVisibility.status).toBe('unavailable');
    expect(collected.workItemRepoVisibility.error).toContain('budget');
    // ...and an unavailable visibility is a warning the operator can act on,
    // never a silent "private" certification.
    const payload = buildSessionAudit(
      session(),
      facts({ workItemRepoVisibility: collected.workItemRepoVisibility }),
      HEALTHY_ENV,
      NOW,
    );
    expect(check(payload, 'public-private-boundary').status).toBe('warning');
  });

  test('a genuinely missing label in a short list is still an error', () => {
    fakeGh(ALL_LABELS.filter((l) => l !== 'ai:blocked'));
    const collected = collect();
    expect(collected.workItemLabels.status).toBe('ok');
    const payload = buildSessionAudit(
      session(),
      facts({ workItemLabels: collected.workItemLabels }),
      HEALTHY_ENV,
      NOW,
    );
    const labels = check(payload, 'work-item-labels');
    expect(labels.status).toBe('error');
    expect(labels.detail).toContain('ai:blocked');
  });
});
