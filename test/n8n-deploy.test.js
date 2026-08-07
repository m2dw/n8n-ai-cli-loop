import {
  GENERATE_TIMEOUT_MS,
  N8N_COMMAND_TIMEOUT_MS,
  N8N_DEPLOY_LOCK_SLACK_MS,
  N8N_DEPLOY_LOCK_STALE_TTL_MS,
  N8N_DEPLOY_MAX_N8N_COMMANDS,
  N8N_RESTART_NOTICE,
  collectN8nDeployLocalPaths,
  encodeSessionRefEnvValue,
  executeN8nDeploy,
  formatCommandLine,
  n8nDeployChildLockScope,
  n8nDeployLockScope,
  parseWorkflowList,
  planN8nDeploy,
  sanitizeDeployText,
  verifyImportedWorkflows,
  verifyParentWorkflowConfig,
} from '../dist/core/n8n-deploy.js';

// Issue #822 — `admin n8n deploy`. Every decision this command makes (step
// order, argument construction, verification, publish policy) is pure, so the
// whole thing is exercised here against a fake runner: no n8n installation, no
// filesystem, no subprocess.

const INSTALL_ROOT = '/opt/n8n-ai-cli-loop';
const ARTIFACT_DIR = `${INSTALL_ROOT}/.n8n-artifacts/workflows`;
const GENERATOR = `${INSTALL_ROOT}/scripts/build-parent-child-workflow.mjs`;

const PARENT_ID = 'ai-dev-loop-parent-my-project-0123456789abcdef';
const PARENT_NAME = 'AI Dev Loop — Parent (my-project)';
const PARENT_FILE = `${PARENT_ID}.json`;
const CHILD_ID = 'ai-dev-loop-thin-phase-runner';
const CHILD_NAME = 'AI Dev Loop — Phase Runner (Child)';
const CHILD_FILE = 'n8n-thin-child-workflow.json';

function makePlan(overrides = {}) {
  return planN8nDeploy({
    sessionId: 'my-project',
    installRoot: INSTALL_ROOT,
    cliBase: `${INSTALL_ROOT}/dist/cli`,
    sessionsPath: '/home/op/.config/n8n-ai-cli-loop/sessions.json',
    nodeBin: '/usr/bin/node',
    generatorScript: GENERATOR,
    n8nBin: 'n8n',
    publish: false,
    parent: {
      workflowId: PARENT_ID,
      workflowName: PARENT_NAME,
      artifactPath: `${ARTIFACT_DIR}/${PARENT_FILE}`,
      artifactFile: PARENT_FILE,
    },
    child: {
      workflowId: CHILD_ID,
      workflowName: CHILD_NAME,
      artifactPath: `${ARTIFACT_DIR}/${CHILD_FILE}`,
      artifactFile: CHILD_FILE,
    },
    ...overrides,
  });
}

/** The `n8n list:workflow` output a healthy deployment produces. */
function listOutputFor({ parentId = PARENT_ID, parentName = PARENT_NAME, extra = [] } = {}) {
  return [
    `${CHILD_ID}|${CHILD_NAME}`,
    `${parentId}|${parentName}`,
    ...extra,
  ].join('\n') + '\n';
}

function parentArtifact(overrides = {}) {
  return JSON.stringify({
    id: PARENT_ID,
    name: PARENT_NAME,
    nodes: [
      { name: 'Manual Trigger', parameters: {} },
      {
        name: 'Config',
        parameters: {
          assignments: {
            assignments: [
              { id: 'cfg-session-id', name: 'sessionId', value: 'my-project', type: 'string' },
              { id: 'cfg-repo-key-ref', name: 'repoKeyReference', value: '(resolved)', type: 'string' },
            ],
          },
        },
      },
      { name: 'Call Phase Runner', parameters: { workflowId: CHILD_ID } },
    ],
    ...overrides,
  });
}

/**
 * Records every command in order and answers with scripted results. `respond`
 * may return a partial result for the command it wants to override.
 *
 * `activeListOutput` answers `list:workflow --active=true` — the pre-import
 * activation probe — separately from the full listing, and defaults to an n8n
 * with nothing active.
 */
function fakeRunner({
  listOutput = listOutputFor(),
  activeListOutput = '',
  respond = () => undefined,
} = {}) {
  const calls = [];
  return {
    calls,
    run(command) {
      calls.push({
        file: command.file,
        args: [...command.args],
        env: command.env,
        cwd: command.cwd,
        timeoutMs: command.timeoutMs,
      });
      const override = respond(command, calls.length - 1);
      if (override) return { status: 0, stdout: '', stderr: '', ...override };
      if (command.args[0] === 'list:workflow') {
        const active = command.args.includes('--active=true');
        return { status: 0, stdout: active ? activeListOutput : listOutput, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

/**
 * A deployment lock, faked. `held` simulates a concurrent deploy holding it;
 * otherwise the lock is granted and the `events` list records when it was taken
 * and released relative to the commands.
 *
 * Both locks share one `events` list (the caller passes the same `events` to
 * each), so a single ordered trace shows the whole-run parent lock and the
 * shorter shared-child lock nesting around the commands. Events are prefixed with
 * the lock's name for that reason.
 */
function fakeLock({ held = undefined, name = 'parent', events = [] } = {}) {
  return {
    name,
    events,
    acquire() {
      if (held !== undefined) {
        events.push(`${name}:denied`);
        return { acquired: false, detail: held };
      }
      events.push(`${name}:acquired`);
      return {
        acquired: true,
        release: () => {
          events.push(`${name}:released`);
        },
      };
    },
  };
}

function deploy(
  plan,
  { runner = fakeRunner(), artifact = parentArtifact(), lock = undefined, childLock = undefined } = {},
) {
  const events = lock?.events ?? childLock?.events ?? [];
  const parentLock = lock ?? fakeLock({ events });
  const sharedChildLock = childLock ?? fakeLock({ name: 'child', events });
  const reads = [];
  const execution = executeN8nDeploy(plan, {
    run: (command) => {
      events.push(`run:${command.args[0]}`);
      return runner.run(command);
    },
    readArtifact: (path) => {
      reads.push(path);
      if (artifact instanceof Error) throw artifact;
      return artifact;
    },
    acquireLock: parentLock.acquire,
    acquireChildLock: sharedChildLock.acquire,
    localPaths: [INSTALL_ROOT, ARTIFACT_DIR],
  });
  return { execution, calls: runner.calls, reads, lockEvents: events };
}

const stepIds = (execution) => execution.steps.map((step) => step.id);
const outcomeOf = (execution, id) => execution.steps.find((step) => step.id === id)?.outcome;

// ---------------------------------------------------------------------------
// Plan shape and ordering
// ---------------------------------------------------------------------------

describe('planN8nDeploy — step order', () => {
  test('generates, then imports child before parent, then verifies', () => {
    expect(makePlan().steps.map((step) => step.id)).toEqual([
      'generate',
      'check-parent-active',
      'import-child',
      'import-parent',
      'verify-workflows',
      'verify-parent-config',
      'restore-parent-active',
    ]);
  });

  test('the publish step exists only when publishing was requested, and is last', () => {
    expect(makePlan().steps.some((step) => step.id === 'publish-parent')).toBe(false);
    const published = makePlan({ publish: true }).steps;
    expect(published[published.length - 1].id).toBe('publish-parent');
  });

  test('the activation probe runs before the imports that would overwrite it', () => {
    // `import:workflow` upserts the artifact's `active: false`, so the prior
    // activation is unreadable once the parent has landed.
    const ids = makePlan().steps.map((step) => step.id);
    expect(ids.indexOf('check-parent-active')).toBeLessThan(ids.indexOf('import-parent'));
    expect(makePlan().steps.find((s) => s.id === 'check-parent-active').command.args).toEqual([
      'list:workflow',
      '--active=true',
    ]);
  });

  test('publishing replaces the restore step — it would activate the parent anyway', () => {
    const published = makePlan({ publish: true }).steps.map((step) => step.id);
    expect(published).not.toContain('check-parent-active');
    expect(published).not.toContain('restore-parent-active');
  });

  test('the restore step is last, so a failed deploy never re-activates an unverified parent', () => {
    const steps = makePlan().steps;
    expect(steps[steps.length - 1].id).toBe('restore-parent-active');
    expect(steps[steps.length - 1].command.args).toEqual([
      'update:workflow',
      `--id=${PARENT_ID}`,
      '--active=true',
    ]);
  });

  test('verify-parent-config is a local check that runs no command', () => {
    const step = makePlan().steps.find((s) => s.id === 'verify-parent-config');
    expect(step.command).toBeUndefined();
  });

  test('the child is imported before the parent because the parent references it by ID', () => {
    const { calls } = deploy(makePlan());
    const imports = calls.filter((call) => call.args[0] === 'import:workflow');
    expect(imports[0].args[1]).toBe(`--input=${ARTIFACT_DIR}/${CHILD_FILE}`);
    expect(imports[1].args[1]).toBe(`--input=${ARTIFACT_DIR}/${PARENT_FILE}`);
  });
});

// ---------------------------------------------------------------------------
// Command construction and argument quoting
// ---------------------------------------------------------------------------

describe('planN8nDeploy — command construction', () => {
  test('generation runs the generator with node, in the install root', () => {
    const step = makePlan().steps[0];
    expect(step.command.file).toBe('/usr/bin/node');
    expect(step.command.args).toEqual([GENERATOR]);
    expect(step.command.cwd).toBe(INSTALL_ROOT);
    expect(step.command.timeoutMs).toBe(GENERATE_TIMEOUT_MS);
  });

  test('generation selects this session and bakes in the resolved CLI base', () => {
    const step = makePlan().steps[0];
    expect(step.command.env).toEqual({
      SESSION_REF: 'my-project',
      CLI_BASE: `${INSTALL_ROOT}/dist/cli`,
      SESSIONS_PATH: '/home/op/.config/n8n-ai-cli-loop/sessions.json',
      // Deploying must not rewrite the tracked docs/ templates.
      WORKFLOW_ARTIFACTS_ONLY: '1',
    });
  });

  test('a sessionId the generator would otherwise split or trim is escaped', () => {
    const plan = makePlan({ sessionId: 'team,a' });
    expect(plan.steps[0].command.env.SESSION_REF).toBe('team\\,a');
  });

  test('the generator resolves against the same sessions.json the command did', () => {
    const plan = makePlan({ sessionsPath: '/tmp/custom/sessions.json' });
    expect(plan.steps[0].command.env.SESSIONS_PATH).toBe('/tmp/custom/sessions.json');
  });

  test('the n8n binary is whatever --n8n-bin resolved to', () => {
    const plan = makePlan({ n8nBin: '/opt/node/bin/n8n', publish: true });
    for (const step of plan.steps.slice(1)) {
      if (step.command) expect(step.command.file).toBe('/opt/node/bin/n8n');
    }
  });

  test('n8n calls get the shorter timeout', () => {
    const step = makePlan().steps.find((s) => s.id === 'import-child');
    expect(step.command.timeoutMs).toBe(N8N_COMMAND_TIMEOUT_MS);
  });

  test('verification lists workflows and publication activates only the parent', () => {
    const plan = makePlan({ publish: true });
    expect(plan.steps.find((s) => s.id === 'verify-workflows').command.args).toEqual(['list:workflow']);
    expect(plan.steps.find((s) => s.id === 'publish-parent').command.args).toEqual([
      'update:workflow',
      `--id=${PARENT_ID}`,
      '--active=true',
    ]);
  });

  test('--projectId is passed to both imports only when a project was selected', () => {
    const without = makePlan();
    for (const id of ['import-child', 'import-parent']) {
      expect(without.steps.find((s) => s.id === id).command.args).toEqual([
        'import:workflow',
        expect.stringContaining('--input='),
      ]);
    }
    const withProject = makePlan({ projectId: 'proj-42' });
    expect(withProject.projectId).toBe('proj-42');
    for (const id of ['import-child', 'import-parent']) {
      expect(withProject.steps.find((s) => s.id === id).command.args[2]).toBe('--projectId=proj-42');
    }
    // The publish step targets a workflow by ID, so it needs no project.
    expect(makePlan({ projectId: 'proj-42', publish: true }).steps.find((s) => s.id === 'publish-parent').command.args)
      .not.toContain('--projectId=proj-42');
  });

  test('a value with spaces or shell metacharacters stays exactly one argument', () => {
    const plan = makePlan({
      projectId: "a b'c;rm -rf /",
      parent: {
        workflowId: PARENT_ID,
        workflowName: PARENT_NAME,
        artifactPath: '/opt/my loop/artifacts/parent.json',
        artifactFile: 'parent.json',
      },
    });
    const args = plan.steps.find((s) => s.id === 'import-parent').command.args;
    expect(args).toEqual([
      'import:workflow',
      '--input=/opt/my loop/artifacts/parent.json',
      "--projectId=a b'c;rm -rf /",
    ]);
  });
});

describe('formatCommandLine — display only', () => {
  test('quotes arguments that a shell would otherwise split or interpret', () => {
    const line = formatCommandLine({
      file: 'n8n',
      args: ['import:workflow', '--input=/opt/my loop/p.json', "--projectId=a'b"],
      timeoutMs: 1,
    });
    expect(line).toBe("n8n import:workflow '--input=/opt/my loop/p.json' '--projectId=a'\\''b'");
  });

  test('renders environment overrides as an assignment prefix', () => {
    const line = formatCommandLine({
      file: '/usr/bin/node',
      args: ['/opt/gen.mjs'],
      env: { SESSION_REF: encodeSessionRefEnvValue('team,a'), CLI_BASE: '/opt/cli' },
      timeoutMs: 1,
    });
    expect(line).toBe("SESSION_REF='team\\,a' CLI_BASE=/opt/cli /usr/bin/node /opt/gen.mjs");
  });
});

// ---------------------------------------------------------------------------
// SESSION_REF encoding
// ---------------------------------------------------------------------------

describe('encodeSessionRefEnvValue', () => {
  test('leaves an ordinary sessionId untouched', () => {
    expect(encodeSessionRefEnvValue('my-project')).toBe('my-project');
  });

  test('escapes a comma so a sessionId containing one is not read as two references', () => {
    expect(encodeSessionRefEnvValue('team,a')).toBe('team\\,a');
  });

  test('escapes backslashes', () => {
    expect(encodeSessionRefEnvValue('back\\slash')).toBe('back\\\\slash');
  });

  test('escapes leading and trailing whitespace so the generator does not trim it away', () => {
    expect(encodeSessionRefEnvValue(' padded ')).toBe('\\ padded\\ ');
  });

  test('leaves interior whitespace alone', () => {
    expect(encodeSessionRefEnvValue('two words')).toBe('two words');
  });
});

// ---------------------------------------------------------------------------
// list:workflow parsing and verification
// ---------------------------------------------------------------------------

describe('parseWorkflowList', () => {
  test('reads id|name rows', () => {
    expect(parseWorkflowList('a|Alpha\nb|Beta\n')).toEqual([
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
    ]);
  });

  test('splits on the first separator only, so a name may contain one', () => {
    expect(parseWorkflowList('a|Alpha | Beta\n')).toEqual([{ id: 'a', name: 'Alpha | Beta' }]);
  });

  test('skips blank and separator-free banner lines', () => {
    expect(parseWorkflowList('\nLoading n8n...\n\na|Alpha\n')).toEqual([{ id: 'a', name: 'Alpha' }]);
  });
});

describe('verifyImportedWorkflows', () => {
  const expected = {
    parent: { workflowId: PARENT_ID, workflowName: PARENT_NAME },
    child: { workflowId: CHILD_ID, workflowName: CHILD_NAME },
  };

  test('passes when both workflows are registered under their stable IDs', () => {
    const result = verifyImportedWorkflows(parseWorkflowList(listOutputFor()), expected);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.matched.parent).toEqual({ id: PARENT_ID, name: PARENT_NAME });
    expect(result.matched.child).toEqual({ id: CHILD_ID, name: CHILD_NAME });
  });

  test('fails when a workflow is missing after import', () => {
    const result = verifyImportedWorkflows([{ id: CHILD_ID, name: CHILD_NAME }], expected);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain(`parent workflow ${PARENT_ID} is not registered`);
  });

  test('fails when an imported workflow carries the wrong name', () => {
    const result = verifyImportedWorkflows(
      [{ id: CHILD_ID, name: CHILD_NAME }, { id: PARENT_ID, name: 'Something else' }],
      expected,
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('is named "Something else"');
  });

  test('fails when a second workflow with the same name exists under another ID', () => {
    const result = verifyImportedWorkflows(
      parseWorkflowList(listOutputFor({ extra: [`some-other-id|${PARENT_NAME}`] })),
      expected,
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('a duplicate parent workflow named');
    expect(result.problems.join(' ')).toContain('some-other-id');
  });

  test('fails closed when the listing produced nothing readable', () => {
    const result = verifyImportedWorkflows([], expected);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('no readable');
  });
});

describe('verifyParentWorkflowConfig', () => {
  const expected = {
    sessionId: 'my-project',
    workflowId: PARENT_ID,
    workflowName: PARENT_NAME,
    childWorkflowId: CHILD_ID,
  };

  test('passes for the artifact the generator produces', () => {
    expect(verifyParentWorkflowConfig(JSON.parse(parentArtifact()), expected)).toEqual({
      ok: true,
      problems: [],
    });
  });

  test('fails when the Config node names a different session', () => {
    const workflow = JSON.parse(parentArtifact());
    workflow.nodes[1].parameters.assignments.assignments[0].value = 'other-project';
    const result = verifyParentWorkflowConfig(workflow, expected);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('Config sessionId is "other-project"');
  });

  test('fails when the parent calls a different child workflow', () => {
    const workflow = JSON.parse(parentArtifact());
    workflow.nodes[2].parameters.workflowId = 'ai-dev-loop-private-node-phase-runner';
    const result = verifyParentWorkflowConfig(workflow, expected);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('expected the shared');
  });

  test('fails when the Config or Call Phase Runner node is missing entirely', () => {
    const workflow = JSON.parse(parentArtifact());
    workflow.nodes = [];
    const result = verifyParentWorkflowConfig(workflow, expected);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(2);
  });

  test('fails when the artifact declares another workflow identity', () => {
    const workflow = JSON.parse(parentArtifact());
    workflow.id = 'ai-dev-loop-thin-parent';
    const result = verifyParentWorkflowConfig(workflow, expected);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('declares workflow ID "ai-dev-loop-thin-parent"');
  });

  test('rejects a non-object artifact', () => {
    expect(verifyParentWorkflowConfig([], expected).ok).toBe(false);
    expect(verifyParentWorkflowConfig(null, expected).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

describe('executeN8nDeploy — happy path', () => {
  test('runs every step, verifies, and leaves the parent unpublished by default', () => {
    const { execution, calls, reads } = deploy(makePlan());
    expect(execution.ok).toBe(true);
    expect(execution.published).toBe(false);
    expect(stepIds(execution)).toEqual([
      'generate',
      'check-parent-active',
      'import-child',
      'import-parent',
      'verify-workflows',
      'verify-parent-config',
      'restore-parent-active',
    ]);
    // Nothing was active beforehand, so there is nothing to restore.
    expect(execution.parentWasActive).toBe(false);
    expect(execution.parentActiveRestored).toBe(false);
    expect(outcomeOf(execution, 'restore-parent-active')).toBe('skipped');
    expect(execution.steps.filter((step) => step.outcome !== 'ok').map((step) => step.id)).toEqual([
      'restore-parent-active',
    ]);
    expect(execution.verification.ok).toBe(true);
    expect(calls).toHaveLength(5);
    expect(reads).toEqual([`${ARTIFACT_DIR}/${PARENT_FILE}`]);
    expect(calls.some((call) => call.args[0] === 'update:workflow')).toBe(false);
  });

  test('publishes the parent last, after both verifications passed', () => {
    const { execution, calls } = deploy(makePlan({ publish: true }));
    expect(execution.ok).toBe(true);
    expect(execution.published).toBe(true);
    expect(calls[calls.length - 1].args).toEqual([
      'update:workflow',
      `--id=${PARENT_ID}`,
      '--active=true',
    ]);
  });

  test('a repeat deploy issues the same two imports and stays a single workflow each', () => {
    // The stable IDs are the upsert mechanism: importing the same ID twice
    // updates the existing workflow, so the second deploy must not produce (or
    // tolerate) a second copy.
    const first = deploy(makePlan());
    const second = deploy(makePlan());
    expect(second.calls.map((call) => call.args)).toEqual(first.calls.map((call) => call.args));
    expect(second.execution.ok).toBe(true);
    expect(second.execution.verification.matched.parent).toEqual({ id: PARENT_ID, name: PARENT_NAME });
    expect(second.calls.filter((call) => call.args[0] === 'import:workflow')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// A re-deploy must not deactivate a running parent
// ---------------------------------------------------------------------------

describe('executeN8nDeploy — an already active parent survives a re-deploy', () => {
  /** An n8n where the parent workflow is currently active. */
  const activeParent = (extra = []) =>
    fakeRunner({ activeListOutput: [`${PARENT_ID}|${PARENT_NAME}`, ...extra].join('\n') + '\n' });

  test('re-activates the parent after the import that reset it to inactive', () => {
    const { execution, calls } = deploy(makePlan(), { runner: activeParent() });
    expect(execution.ok).toBe(true);
    expect(execution.parentWasActive).toBe(true);
    expect(execution.parentActiveRestored).toBe(true);
    expect(outcomeOf(execution, 'restore-parent-active')).toBe('ok');
    // The restore is the last call, after both verifications passed.
    expect(calls[calls.length - 1].args).toEqual([
      'update:workflow',
      `--id=${PARENT_ID}`,
      '--active=true',
    ]);
    // `published` stays false: this run restored a state it found, it did not
    // publish anything the operator had not already published.
    expect(execution.published).toBe(false);
  });

  test('the probe reads only the parent, not any other active workflow', () => {
    const runner = activeParent();
    const { execution } = deploy(makePlan(), { runner });
    expect(runner.calls[1].args).toEqual(['list:workflow', '--active=true']);
    expect(execution.parentWasActive).toBe(true);

    const others = fakeRunner({ activeListOutput: `${CHILD_ID}|${CHILD_NAME}\nsome-other|Other\n` });
    const inactive = deploy(makePlan(), { runner: others });
    expect(inactive.execution.parentWasActive).toBe(false);
    expect(inactive.execution.parentActiveRestored).toBe(false);
    expect(others.calls.some((call) => call.args[0] === 'update:workflow')).toBe(false);
  });

  test('a failed activation probe stops the deploy before anything is imported', () => {
    // Without the prior state the deploy cannot promise to restore it, and
    // nothing has been overwritten yet.
    const runner = fakeRunner({
      respond: (command) =>
        command.args.includes('--active=true') && command.args[0] === 'list:workflow'
          ? { status: 1, stderr: 'database is locked' }
          : undefined,
    });
    const { execution, calls } = deploy(makePlan(), { runner });
    expect(execution.ok).toBe(false);
    expect(execution.failure.step).toBe('check-parent-active');
    expect(execution.parentWasActive).toBeUndefined();
    expect(calls.some((call) => call.args[0] === 'import:workflow')).toBe(false);
  });

  test('a failed deploy leaves the previously active parent down rather than restoring it unverified', () => {
    const runner = fakeRunner({
      activeListOutput: `${PARENT_ID}|${PARENT_NAME}\n`,
      listOutput: `${CHILD_ID}|${CHILD_NAME}\n`,
    });
    const { execution, calls } = deploy(makePlan(), { runner });
    expect(execution.ok).toBe(false);
    expect(execution.failure.step).toBe('verify-workflows');
    // Reported, so the caller knows the deployment is now down.
    expect(execution.parentWasActive).toBe(true);
    expect(execution.parentActiveRestored).toBe(false);
    expect(outcomeOf(execution, 'restore-parent-active')).toBe('skipped');
    expect(calls.some((call) => call.args[0] === 'update:workflow')).toBe(false);
  });

  test('a failed restore is reported rather than passed off as a successful deploy', () => {
    const runner = fakeRunner({
      activeListOutput: `${PARENT_ID}|${PARENT_NAME}\n`,
      respond: (command) =>
        command.args[0] === 'update:workflow' ? { status: 1, stderr: 'boom' } : undefined,
    });
    const { execution } = deploy(makePlan(), { runner });
    expect(execution.ok).toBe(false);
    expect(execution.parentActiveRestored).toBe(false);
    expect(execution.failure.step).toBe('restore-parent-active');
  });

  test('--publish activates regardless, so it neither probes nor restores', () => {
    const { execution, calls } = deploy(makePlan({ publish: true }), { runner: activeParent() });
    expect(execution.ok).toBe(true);
    expect(execution.published).toBe(true);
    expect(execution.parentWasActive).toBeUndefined();
    expect(execution.parentActiveRestored).toBe(false);
    expect(calls.some((call) => call.args.includes('--active=true') && call.args[0] === 'list:workflow')).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Concurrent deploys of the same parent are serialized
// ---------------------------------------------------------------------------

describe('executeN8nDeploy — the per-parent deployment lock', () => {
  test('is held across the whole check/import/restore sequence', () => {
    // The activation restored at the end was read before the import, so no other
    // deploy of this parent may run in between: a --publish deploy landing in
    // that window would be undone by this run's `active: false` artifact.
    const lock = fakeLock();
    const { execution, lockEvents } = deploy(makePlan(), {
      lock,
      runner: fakeRunner({ activeListOutput: `${PARENT_ID}|${PARENT_NAME}\n` }),
    });
    expect(execution.ok).toBe(true);
    expect(execution.parentActiveRestored).toBe(true);
    expect(lockEvents[0]).toBe('parent:acquired');
    expect(lockEvents[lockEvents.length - 1]).toBe('parent:released');
    // Every command — generate, the probe, both imports, the verification
    // listing, and the restore — ran inside it.
    expect(lockEvents.filter((event) => event.startsWith('run:'))).toHaveLength(6);
    expect(lockEvents.filter((event) => event.startsWith('parent:'))).toEqual([
      'parent:acquired',
      'parent:released',
    ]);
  });

  test('a contended lock stops the deploy before it runs or writes anything', () => {
    const lock = fakeLock({ held: 'held by n8n-deploy-4242 since 2026-08-07T00:00:00.000Z' });
    const { execution, calls, reads, lockEvents } = deploy(makePlan({ publish: true }), { lock });
    expect(execution.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(reads).toEqual([]);
    // Refused before the shared-child lock was even reached, so a same-session
    // collision never blocks other sessions on its way out.
    expect(lockEvents).toEqual(['parent:denied']);
    // Nothing ran, so nothing was written and no restart is owed.
    expect(execution.restartRequired).toBe(false);
    expect(execution.published).toBe(false);
    expect(execution.parentActiveRestored).toBe(false);
    expect(execution.parentWasActive).toBeUndefined();
    // No step failed, because no step started.
    expect(execution.steps.every((step) => step.outcome === 'skipped')).toBe(true);
    expect(execution.failure.step).toBeUndefined();
    expect(execution.failure.reason).toContain(PARENT_ID);
    expect(execution.failure.detail).toBe('held by n8n-deploy-4242 since 2026-08-07T00:00:00.000Z');
  });

  test('is released on a failed deploy too, so one failure does not block the retry', () => {
    const runner = fakeRunner({
      respond: (command) =>
        command.args[0] === 'import:workflow' ? { status: 1, stderr: 'import failed' } : undefined,
    });
    const lock = fakeLock();
    const { execution, lockEvents } = deploy(makePlan(), { lock, runner });
    expect(execution.ok).toBe(false);
    expect(lockEvents[lockEvents.length - 1]).toBe('parent:released');
    expect(lockEvents).toContain('child:released');
  });

  test('is released when the runner throws', () => {
    // The runner is host code: a throw from it must not leave the lock behind
    // for its whole TTL, which would refuse the operator's retry for nothing.
    const lock = fakeLock();
    const thrower = {
      calls: [],
      run() {
        throw new Error('spawn exploded');
      },
    };
    expect(() => deploy(makePlan(), { lock, runner: thrower })).toThrow('spawn exploded');
    // Both of them: the throw comes from `generate`, inside the shared-child
    // window, so the child lock is released by its `finally` and not by the loop.
    expect(lock.events).toContain('child:released');
    expect(lock.events[lock.events.length - 1]).toBe('parent:released');
  });

  test('the lock scope is the parent workflow, so other sessions deploy concurrently', () => {
    expect(n8nDeployLockScope(PARENT_ID)).toBe(`n8n-deploy:${PARENT_ID}`);
    expect(n8nDeployLockScope('other-parent')).not.toBe(n8nDeployLockScope(PARENT_ID));
    // Short enough that a crashed deploy does not hold the session for a day,
    // long enough to cover every step's own timeout.
    expect(N8N_DEPLOY_LOCK_STALE_TTL_MS).toBeGreaterThanOrEqual(
      GENERATE_TIMEOUT_MS + N8N_COMMAND_TIMEOUT_MS,
    );
    expect(N8N_DEPLOY_LOCK_STALE_TTL_MS).toBeLessThan(24 * 60 * 60 * 1000);
  });

  test('the stale TTL exceeds the worst-case command budget with room to spare', () => {
    // No plan runs more timed n8n calls than the constant claims — the
    // non-publish plan is the longest, since it alone carries the probe.
    const n8nCommands = (plan) =>
      plan.steps.filter((step) => step.command !== undefined && step.command.file === 'n8n').length;
    expect(n8nCommands(makePlan())).toBe(N8N_DEPLOY_MAX_N8N_COMMANDS);
    expect(n8nCommands(makePlan({ publish: true }))).toBeLessThanOrEqual(
      N8N_DEPLOY_MAX_N8N_COMMANDS,
    );

    // The point of the slack: a deploy whose every step finishes just under its
    // own limit is still healthy, so the TTL must be strictly greater than the
    // exact sum of those limits — process spawn, the untimed local verification
    // work, and host scheduling all happen outside the timed commands.
    const commandBudget =
      GENERATE_TIMEOUT_MS + N8N_DEPLOY_MAX_N8N_COMMANDS * N8N_COMMAND_TIMEOUT_MS;
    expect(N8N_DEPLOY_LOCK_SLACK_MS).toBeGreaterThan(0);
    expect(N8N_DEPLOY_LOCK_STALE_TTL_MS).toBe(commandBudget + N8N_DEPLOY_LOCK_SLACK_MS);
    expect(N8N_DEPLOY_LOCK_STALE_TTL_MS).toBeGreaterThan(commandBudget);
  });
});

// ---------------------------------------------------------------------------
// Concurrent deploys of *different* sessions are serialized through the one
// thing they share: the child artifact and the child workflow record.
// ---------------------------------------------------------------------------

describe('executeN8nDeploy — the shared-child deployment lock', () => {
  test('is held from before generation until the child import is done, and no longer', () => {
    // `generate` rewrites the one shared child artifact with this run's CLI_BASE
    // baked in, and `import-child` reads it back. Another session's deploy
    // running in that window would have this run import its child — or read the
    // file mid-write — so the two are one serialized sequence. Everything after
    // the child import touches this session's parent alone.
    const { execution, lockEvents } = deploy(makePlan());
    expect(execution.ok).toBe(true);
    expect(lockEvents).toEqual([
      'parent:acquired',
      'child:acquired',
      `run:${GENERATOR}`,
      'run:list:workflow', // the activation probe, inside the window by position
      'run:import:workflow', // the child
      'child:released',
      'run:import:workflow', // the parent
      'run:list:workflow', // verification
      'parent:released',
    ]);
  });

  test('a contended child lock stops the deploy before it runs or writes anything', () => {
    const childLock = fakeLock({
      name: 'child',
      held: 'held by n8n-deploy-99 since 2026-08-07T00:00:00.000Z',
    });
    const { execution, calls, reads, lockEvents } = deploy(makePlan({ publish: true }), {
      childLock,
    });
    expect(execution.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(reads).toEqual([]);
    // The parent lock was taken first and is handed back on the way out, so a
    // deploy refused here does not leave its own session locked.
    expect(lockEvents).toEqual(['parent:acquired', 'child:denied', 'parent:released']);
    expect(execution.restartRequired).toBe(false);
    expect(execution.published).toBe(false);
    expect(execution.parentActiveRestored).toBe(false);
    expect(execution.parentWasActive).toBeUndefined();
    expect(execution.steps.every((step) => step.outcome === 'skipped')).toBe(true);
    // No step failed, because no step started.
    expect(execution.failure.step).toBeUndefined();
    expect(execution.failure.reason).toContain(CHILD_ID);
    expect(execution.failure.detail).toBe('held by n8n-deploy-99 since 2026-08-07T00:00:00.000Z');
  });

  test('is released when the run fails inside its window, not held for the rest of the plan', () => {
    // A generate that fails is done with the shared child; holding its lock
    // through the skipped remainder would refuse every other session for nothing.
    const runner = fakeRunner({
      respond: (command, index) => (index === 0 ? { status: 1, stderr: 'no such session' } : undefined),
    });
    const { execution, lockEvents } = deploy(makePlan(), { runner });
    expect(execution.ok).toBe(false);
    expect(lockEvents).toEqual([
      'parent:acquired',
      'child:acquired',
      `run:${GENERATOR}`,
      'child:released',
      'parent:released',
    ]);
  });

  test('is released exactly once, though both the step loop and the finally ask', () => {
    const { execution, lockEvents } = deploy(makePlan({ publish: true }));
    expect(execution.ok).toBe(true);
    expect(lockEvents.filter((event) => event === 'child:acquired')).toHaveLength(1);
    expect(lockEvents.filter((event) => event === 'child:released')).toHaveLength(1);
  });

  test('the scope is the child workflow, so it is install-wide and cannot collide with a parent scope', () => {
    expect(n8nDeployChildLockScope(CHILD_ID)).toBe(`n8n-deploy-child:${CHILD_ID}`);
    // The two locks are held at once, so their scopes must never name one lock —
    // including the degenerate case of an install whose IDs happen to line up.
    expect(n8nDeployChildLockScope(CHILD_ID)).not.toBe(n8nDeployLockScope(CHILD_ID));
    expect(n8nDeployChildLockScope(PARENT_ID)).not.toBe(n8nDeployLockScope(PARENT_ID));
  });
});

describe('executeN8nDeploy — failures stop the deployment before publication', () => {
  test('a failed import skips every later step, including publish', () => {
    const runner = fakeRunner({
      respond: (command) =>
        command.args[1] === `--input=${ARTIFACT_DIR}/${CHILD_FILE}`
          ? { status: 2, stderr: 'import failed' }
          : undefined,
    });
    const { execution, calls } = deploy(makePlan({ publish: true }), { runner });
    expect(execution.ok).toBe(false);
    expect(execution.published).toBe(false);
    expect(execution.failure).toEqual({
      step: 'import-child',
      reason: 'import-child failed with exit code 2',
      detail: 'import failed',
    });
    expect(outcomeOf(execution, 'import-parent')).toBe('skipped');
    expect(outcomeOf(execution, 'publish-parent')).toBe('skipped');
    expect(calls.some((call) => call.args[0] === 'update:workflow')).toBe(false);
  });

  test('a failed generation stops before anything is imported', () => {
    const runner = fakeRunner({
      respond: (command, index) => (index === 0 ? { status: 1, stderr: 'no such session' } : undefined),
    });
    const { execution, calls } = deploy(makePlan(), { runner });
    expect(execution.ok).toBe(false);
    expect(execution.failure.step).toBe('generate');
    expect(calls).toHaveLength(1);
  });

  test('failed list verification blocks publication', () => {
    const runner = fakeRunner({ listOutput: `${CHILD_ID}|${CHILD_NAME}\n` });
    const { execution, calls } = deploy(makePlan({ publish: true }), { runner });
    expect(execution.ok).toBe(false);
    expect(execution.published).toBe(false);
    expect(outcomeOf(execution, 'verify-workflows')).toBe('failed');
    expect(execution.failure.reason).toBe('imported workflow verification failed');
    expect(execution.verification.ok).toBe(false);
    // The config check never runs either — the deployment is already known bad.
    expect(outcomeOf(execution, 'verify-parent-config')).toBe('skipped');
    expect(calls.some((call) => call.args[0] === 'update:workflow')).toBe(false);
  });

  test('a duplicated workflow name blocks publication', () => {
    const runner = fakeRunner({ listOutput: listOutputFor({ extra: [`stale-copy|${PARENT_NAME}`] }) });
    const { execution } = deploy(makePlan({ publish: true }), { runner });
    expect(execution.ok).toBe(false);
    expect(execution.published).toBe(false);
    expect(execution.failure.detail).toContain('a duplicate parent workflow named');
  });

  test('failed Config verification blocks publication', () => {
    const workflow = JSON.parse(parentArtifact());
    workflow.nodes[1].parameters.assignments.assignments[0].value = 'other-project';
    const { execution, calls } = deploy(makePlan({ publish: true }), {
      artifact: JSON.stringify(workflow),
    });
    expect(execution.ok).toBe(false);
    expect(execution.published).toBe(false);
    expect(execution.failure.step).toBe('verify-parent-config');
    expect(execution.failure.detail).toContain('Config sessionId is "other-project"');
    expect(outcomeOf(execution, 'publish-parent')).toBe('skipped');
    expect(calls.some((call) => call.args[0] === 'update:workflow')).toBe(false);
  });

  test('an unreadable parent artifact fails rather than publishing unverified', () => {
    const { execution } = deploy(makePlan({ publish: true }), {
      artifact: new Error('ENOENT: no such file'),
    });
    expect(execution.ok).toBe(false);
    expect(execution.failure.step).toBe('verify-parent-config');
    expect(execution.failure.reason).toContain('could not be read');
  });

  test('a malformed parent artifact fails rather than publishing unverified', () => {
    const { execution } = deploy(makePlan({ publish: true }), { artifact: 'not json' });
    expect(execution.ok).toBe(false);
    expect(execution.failure.reason).toContain('not valid JSON');
    expect(outcomeOf(execution, 'publish-parent')).toBe('skipped');
  });

  test('a publish that itself fails is reported and leaves published false', () => {
    const runner = fakeRunner({
      respond: (command) => (command.args[0] === 'update:workflow' ? { status: 1, stderr: 'boom' } : undefined),
    });
    const { execution } = deploy(makePlan({ publish: true }), { runner });
    expect(execution.ok).toBe(false);
    expect(execution.published).toBe(false);
    expect(execution.failure.step).toBe('publish-parent');
  });
});

// ---------------------------------------------------------------------------
// Path sanitization
// ---------------------------------------------------------------------------

describe('local paths are redacted from user-facing output', () => {
  test('reported command lines carry no absolute path', () => {
    const { execution } = deploy(makePlan({ publish: true }));
    for (const step of execution.steps) {
      if (step.commandLine === undefined) continue;
      expect(step.commandLine).not.toContain(INSTALL_ROOT);
    }
    expect(execution.steps.find((s) => s.id === 'import-child').commandLine).toBe(
      'n8n import:workflow --input=<path>',
    );
    expect(execution.steps.find((s) => s.id === 'generate').commandLine).toBe(
      'SESSION_REF=my-project CLI_BASE=<path> SESSIONS_PATH=<path> WORKFLOW_ARTIFACTS_ONLY=1 <path> <path>',
    );
  });

  test('a failing command\'s output is redacted too', () => {
    const runner = fakeRunner({
      respond: (command, index) =>
        index === 0 ? { status: 1, stderr: `cannot write ${ARTIFACT_DIR}/${PARENT_FILE}` } : undefined,
    });
    const { execution } = deploy(makePlan(), { runner });
    expect(execution.failure.detail).toBe('cannot write <path>');
  });

  test('sanitizeDeployText keeps workflow identifiers and filenames readable', () => {
    const text = `imported ${PARENT_ID} from ${ARTIFACT_DIR}/${PARENT_FILE}`;
    const cleaned = sanitizeDeployText(text, [INSTALL_ROOT]);
    expect(cleaned).toContain(PARENT_ID);
    expect(cleaned).not.toContain(ARTIFACT_DIR);
  });
});

describe('collectN8nDeployLocalPaths', () => {
  const base = {
    installRoot: INSTALL_ROOT,
    artifactDir: ARTIFACT_DIR,
    cliBase: `${INSTALL_ROOT}/dist/cli`,
    nodeBin: '/usr/bin/node',
    sessionsPath: '/home/op/.config/n8n-ai-cli-loop/sessions.json',
    n8nBin: 'n8n',
  };

  test('lists every local path the command can print', () => {
    expect(collectN8nDeployLocalPaths(base)).toEqual([
      INSTALL_ROOT,
      ARTIFACT_DIR,
      `${INSTALL_ROOT}/dist/cli`,
      '/usr/bin/node',
      '/home/op/.config/n8n-ai-cli-loop/sessions.json',
    ]);
  });

  test('a --n8n-bin outside the sanitizer\'s built-in roots is still redacted', () => {
    // `/secret-install` is not one of sanitizeBody's known roots, so it is
    // redacted only because it is named explicitly here.
    const paths = collectN8nDeployLocalPaths({ ...base, n8nBin: '/secret-install/bin/n8n' });
    expect(paths).toContain('/secret-install/bin/n8n');
    const plan = makePlan({ n8nBin: '/secret-install/bin/n8n' });
    const line = formatCommandLine(plan.steps.find((step) => step.id === 'import-child').command);
    expect(sanitizeDeployText(line, paths)).toBe('<path> import:workflow --input=<path>');
  });

  test('a bare command name is a PATH lookup, not a path to redact', () => {
    // Redacting the literal string `n8n` would turn every printed command line
    // into `<path>`.
    expect(collectN8nDeployLocalPaths(base)).not.toContain('n8n');
    expect(sanitizeDeployText('n8n list:workflow', collectN8nDeployLocalPaths(base))).toBe(
      'n8n list:workflow',
    );
  });
});

// ---------------------------------------------------------------------------
// A running n8n does not observe what the CLI wrote
// ---------------------------------------------------------------------------

describe('executeN8nDeploy — restartRequired', () => {
  test('a deploy that imported anything needs a running n8n restarted', () => {
    const { execution } = deploy(makePlan());
    expect(execution.ok).toBe(true);
    expect(execution.restartRequired).toBe(true);
  });

  test('publication is reported as needing a restart to take effect', () => {
    // `update:workflow --active=true` writes the database from a separate
    // process; a live n8n keeps running what it loaded at startup, so the
    // Schedule Trigger is not firing yet.
    const { execution } = deploy(makePlan({ publish: true }));
    expect(execution.published).toBe(true);
    expect(execution.restartRequired).toBe(true);
  });

  test('restoring an already active parent needs the same restart', () => {
    const runner = fakeRunner({ activeListOutput: `${PARENT_ID}|${PARENT_NAME}\n` });
    const { execution } = deploy(makePlan(), { runner });
    expect(execution.parentActiveRestored).toBe(true);
    expect(execution.restartRequired).toBe(true);
  });

  test('a run that never reached an import wrote nothing to restart for', () => {
    const runner = fakeRunner({
      respond: (command, index) => (index === 0 ? { status: 1, stderr: 'generate failed' } : undefined),
    });
    const { execution } = deploy(makePlan(), { runner });
    expect(execution.ok).toBe(false);
    expect(execution.restartRequired).toBe(false);
  });

  test('an import that failed partway still leaves a running n8n out of date', () => {
    const runner = fakeRunner({
      respond: (command) =>
        command.args[0] === 'import:workflow' ? { status: 1, stderr: 'import failed' } : undefined,
    });
    const { execution } = deploy(makePlan(), { runner });
    expect(execution.ok).toBe(false);
    expect(execution.restartRequired).toBe(true);
  });

  test('an n8n binary that never started wrote nothing to restart for', () => {
    // `--n8n-bin /missing/n8n`: spawnSync never starts a process, so the import
    // reports a negative status having touched no database. Telling the operator
    // to restart n8n over that would describe a write that never happened.
    const runner = fakeRunner({
      respond: (command) =>
        command.args[0] === 'import:workflow'
          ? { status: -1, started: false, stderr: 'spawnSync /missing/n8n ENOENT' }
          : undefined,
    });
    const { execution } = deploy(makePlan({ publish: true }), { runner });
    expect(execution.ok).toBe(false);
    expect(execution.failure.step).toBe('import-child');
    expect(execution.restartRequired).toBe(false);
  });

  test('a first import killed by its timeout still counts as a write', () => {
    // Started and killed: it may have written half the database, so the
    // conservative answer is the one that keeps the operator informed.
    const runner = fakeRunner({
      respond: (command) =>
        command.args[0] === 'import:workflow'
          ? { status: -1, started: true, stderr: 'ETIMEDOUT' }
          : undefined,
    });
    const { execution } = deploy(makePlan(), { runner });
    expect(execution.ok).toBe(false);
    expect(execution.restartRequired).toBe(true);
  });

  test('a runner that reports no `started` field is read from its exit code', () => {
    // Backwards-compatible: a real exit code only comes from a process that ran.
    const runner = fakeRunner({
      respond: (command) =>
        command.args[0] === 'import:workflow' ? { status: 3, stderr: 'import failed' } : undefined,
    });
    const { execution } = deploy(makePlan(), { runner });
    expect(execution.restartRequired).toBe(true);
  });

  test('the notice names the restart, not a completed activation', () => {
    expect(N8N_RESTART_NOTICE).toContain('restart');
    expect(N8N_RESTART_NOTICE).toContain('Schedule Trigger');
  });
});
