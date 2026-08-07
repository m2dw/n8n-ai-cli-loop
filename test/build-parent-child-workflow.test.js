import { jest } from '@jest/globals';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  buildParentWorkflow,
  buildChildWorkflow,
  buildPrivateNodeChildWorkflow,
  buildPrivateNodeParentWorkflow,
  deriveParentWorkflowId,
  deriveParentWorkflowName,
  ensureSessionResolverBuilt,
  loadSessionRefResolver,
  parentArtifactFileName,
  parseSessionRefs,
  requireCanonicalSessionId,
  resolveConfiguredSessionIds,
  resolveLocalCliBase,
  resolveSessionIds,
  CHILD_WORKFLOW_ID,
  CHILD_WORKFLOW_NAME,
  CHILD_ARTIFACT_FILE_NAME,
  LOCAL_WORKFLOW_ARTIFACT_DIR,
  PARENT_WORKFLOW_ID_PREFIX,
  PRIVATE_NODE_CHILD_WORKFLOW_ID,
  PRIVATE_NODE_PARENT_WORKFLOW_ID,
  PRIVATE_NODE_TYPE,
  CANONICAL_CLI_BASE,
  CANONICAL_SESSION_ID,
  GENERIC_PARENT_WORKFLOW_ID,
  GENERIC_PARENT_WORKFLOW_NAME,
} from '../scripts/build-parent-child-workflow.mjs';

// The tracked docs/ parent template stays generic review/onboarding output, so
// it is built with the generic identity instead of the per-session derived one.
const GENERIC_PARENT_OPTIONS = {
  cliBase: CANONICAL_CLI_BASE,
  sessionId: CANONICAL_SESSION_ID,
  workflowId: GENERIC_PARENT_WORKFLOW_ID,
  workflowName: GENERIC_PARENT_WORKFLOW_NAME,
};

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../docs');

const parentPath = resolve(docsDir, 'n8n-thin-parent-workflow.json');
const childPath = resolve(docsDir, 'n8n-thin-child-workflow.json');
const privateNodeChildPath = resolve(docsDir, 'n8n-thin-child-workflow-private-node.json');
const privateNodeParentPath = resolve(docsDir, 'n8n-thin-parent-workflow-private-node.json');

// ---------------------------------------------------------------------------
// Stability — checked-in docs/ JSONs are the canonical template (issue #391)
//
// The tracked docs/ files must match the generator output baked with
// CANONICAL_CLI_BASE, CANONICAL_SESSION_ID, and the generic parent identity so
// the committed JSON is stable and environment-independent.  Local CLI_BASE /
// SESSION_REF never affect them — that output goes to .n8n-artifacts/workflows/.
// ---------------------------------------------------------------------------

test('checked-in parent workflow JSON matches canonical generator output', () => {
  const checkedIn = readFileSync(parentPath, 'utf8');
  const generated = JSON.stringify(buildParentWorkflow(GENERIC_PARENT_OPTIONS), null, 2) + '\n';
  expect(checkedIn).toBe(generated);
});

// The checked-in template is deliberately NOT a machine-specific deployment
// artifact (issue #821): it keeps the generic identity so a reviewer reading
// docs/ never sees one operator's session baked into the repo.
test('checked-in parent workflow JSON keeps the generic identity, not a derived one', () => {
  const checkedIn = JSON.parse(readFileSync(parentPath, 'utf8'));
  expect(checkedIn.id).toBe(GENERIC_PARENT_WORKFLOW_ID);
  expect(checkedIn.name).toBe(GENERIC_PARENT_WORKFLOW_NAME);
  expect(checkedIn.id).not.toContain(PARENT_WORKFLOW_ID_PREFIX);
});

test('checked-in child workflow JSON matches canonical generator output', () => {
  const checkedIn = readFileSync(childPath, 'utf8');
  const generated =
    JSON.stringify(buildChildWorkflow({ cliBase: CANONICAL_CLI_BASE }), null, 2) + '\n';
  expect(checkedIn).toBe(generated);
});

test('checked-in docs JSON is environment-independent (no local CLI_BASE leakage)', () => {
  // A deliberately distinct local path — never equal to CANONICAL_CLI_BASE even
  // when the checkout itself lives under /opt/n8n-ai-cli-loop (the canonical path).
  const MOCK_LOCAL_CLI_BASE = '/home/operator/local-checkout/dist/cli';
  expect(MOCK_LOCAL_CLI_BASE).not.toBe(CANONICAL_CLI_BASE);
  for (const path of [parentPath, childPath]) {
    const checkedIn = readFileSync(path, 'utf8');
    // Canonical path is present; no machine-specific local path is committed.
    expect(checkedIn).toContain(CANONICAL_CLI_BASE);
    expect(checkedIn).not.toContain(MOCK_LOCAL_CLI_BASE);
    expect(checkedIn).not.toMatch(/\/(?:Users|home)\/[^"']*\/dist\/cli/);
  }
});

// ---------------------------------------------------------------------------
// Parent workflow structure
// ---------------------------------------------------------------------------

describe('buildParentWorkflow structure', () => {
  const wf = buildParentWorkflow();

  test('has a non-empty name', () => {
    expect(typeof wf.name).toBe('string');
    expect(wf.name.length).toBeGreaterThan(0);
  });

  test('has exactly 10 nodes: 2 triggers + Config + Create Context + Acquire Repo Lock + IF Locked + Call Phase Runner + Release Repo Lock + Release Repo Lock on Error + Stop and Error', () => {
    expect(wf.nodes).toHaveLength(10);
  });

  test('has a Manual Trigger node', () => {
    const node = wf.nodes.find((n) => n.type === 'n8n-nodes-base.manualTrigger');
    expect(node).toBeDefined();
  });

  test('has a Schedule Trigger node', () => {
    const node = wf.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger');
    expect(node).toBeDefined();
  });

  test('has a Config (Set) node', () => {
    const node = wf.nodes.find((n) => n.id === 'workflow-config');
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.set');
    expect(node.name).toBe('Config');
  });

  test('has exactly 4 Execute Command nodes (Create Context, Acquire Repo Lock, Release Repo Lock, Release Repo Lock on Error)', () => {
    const nodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeCommand');
    expect(nodes).toHaveLength(4);
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain('create-context');
    expect(ids).toContain('acquire-repo-lock');
    expect(ids).toContain('release-repo-lock');
    expect(ids).toContain('release-repo-lock-err');
  });

  test('has an IF node (IF Locked)', () => {
    const node = wf.nodes.find((n) => n.type === 'n8n-nodes-base.if');
    expect(node).toBeDefined();
    expect(node.id).toBe('if-locked');
    expect(node.name).toBe('IF Locked');
  });

  test('has an Execute Workflow node (Call Phase Runner)', () => {
    const node = wf.nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflow');
    expect(node).toBeDefined();
    expect(node.id).toBe('call-phase-runner');
    expect(node.name).toBe('Call Phase Runner');
  });

  test('each node has an id, name, type, and position', () => {
    for (const node of wf.nodes) {
      expect(typeof node.id).toBe('string');
      expect(node.id.length).toBeGreaterThan(0);
      expect(typeof node.name).toBe('string');
      expect(typeof node.type).toBe('string');
      expect(Array.isArray(node.position)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Parent — Config node
// ---------------------------------------------------------------------------

describe('buildParentWorkflow — Config node', () => {
  const wf = buildParentWorkflow();
  const configNode = wf.nodes.find((n) => n.id === 'workflow-config');
  const assignments = configNode.parameters.assignments.assignments;

  function assignment(name) {
    return assignments.find((a) => a.name === name);
  }

  test('sessionId defaults to the canonical default session', () => {
    const a = assignment('sessionId');
    expect(a).toBeDefined();
    expect(a.value).toBe(CANONICAL_SESSION_ID);
    expect(a.type).toBe('string');
  });

  // The deployed Config must hold the canonical identifier, not a sessionNo or
  // alias an operator can repoint in sessions.json (issue #821).
  test('no sessionRef field remains in Config', () => {
    expect(assignment('sessionRef')).toBeUndefined();
  });

  test('has reference-only fields', () => {
    expect(assignment('repoKeyReference')).toBeDefined();
    expect(assignment('repoRootReference')).toBeDefined();
    expect(assignment('githubRepoReference')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Parent — Create Context node
// ---------------------------------------------------------------------------

describe('buildParentWorkflow — Create Context node', () => {
  const wf = buildParentWorkflow();
  const node = wf.nodes.find((n) => n.id === 'create-context');
  const cmd = node.parameters.command;

  test('has a Create Context Execute Command node', () => {
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.executeCommand');
    expect(node.name).toBe('Create Context');
  });

  test('command is an n8n expression', () => {
    expect(cmd.startsWith('=')).toBe(true);
  });

  test('uses $execution.id for contextId', () => {
    expect(cmd).toContain('$execution.id');
  });

  test('invokes admin.js context create subcommand', () => {
    expect(cmd).toContain('context create');
  });

  test('requests JSON output explicitly with --json (issue #308)', () => {
    expect(cmd).toContain('context create --json');
  });

  // Config already holds the canonical sessionId (resolved at generation time),
  // so the runtime call passes --session-id and never re-resolves a reference.
  test('passes the Config sessionId with --session-id, not --session-ref', () => {
    expect(cmd).toContain('--session-id');
    expect(cmd).not.toContain('--session-ref');
    expect(cmd).toContain('$("Config").first().json.sessionId');
  });

  test('single-quotes the sessionId and escapes embedded single quotes', () => {
    expect(cmd).toContain(`--session-id '`);
    expect(cmd).toContain(`.replace(/'/g, "'\\\\''")`);
  });

  test('does not contain a newline character', () => {
    expect(cmd).not.toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// Parent — Acquire Repo Lock node
// ---------------------------------------------------------------------------

describe('buildParentWorkflow — Acquire Repo Lock node', () => {
  const wf = buildParentWorkflow();
  const node = wf.nodes.find((n) => n.id === 'acquire-repo-lock');
  const cmd = node.parameters.command;

  test('has an Acquire Repo Lock Execute Command node', () => {
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.executeCommand');
    expect(node.name).toBe('Acquire Repo Lock');
  });

  test('command is an n8n expression', () => {
    expect(cmd.startsWith('=')).toBe(true);
  });

  test('invokes admin.js repo-lock acquire subcommand', () => {
    expect(cmd).toContain('repo-lock acquire');
  });

  test('requests JSON output explicitly with --json (issue #308)', () => {
    expect(cmd).toContain('repo-lock acquire --json');
  });

  test('uses --context-id referencing Create Context stdout', () => {
    expect(cmd).toContain('--context-id');
    expect(cmd).toContain('JSON.parse($("Create Context").first().json.stdout).contextId');
  });

  test('does not contain a newline character', () => {
    expect(cmd).not.toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// Parent — IF Locked node
// ---------------------------------------------------------------------------

describe('buildParentWorkflow — IF Locked node', () => {
  const wf = buildParentWorkflow();
  const node = wf.nodes.find((n) => n.id === 'if-locked');

  test('has an IF Locked node of type n8n-nodes-base.if', () => {
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.if');
    expect(node.name).toBe('IF Locked');
  });

  test('uses typeVersion 2', () => {
    expect(node.typeVersion).toBe(2);
  });

  test('has a single condition checking the locked field from Acquire Repo Lock', () => {
    const conditions = node.parameters.conditions.conditions;
    expect(conditions).toHaveLength(1);
    expect(conditions[0].leftValue).toContain('$("Acquire Repo Lock").first().json.stdout');
    expect(conditions[0].leftValue).toContain('locked');
  });

  test('condition uses boolean true operator', () => {
    const op = node.parameters.conditions.conditions[0].operator;
    expect(op).toMatchObject({ type: 'boolean', operation: 'true' });
  });
});

// ---------------------------------------------------------------------------
// Parent — Call Phase Runner node
// ---------------------------------------------------------------------------

describe('buildParentWorkflow — Call Phase Runner node', () => {
  const wf = buildParentWorkflow();
  const node = wf.nodes.find((n) => n.id === 'call-phase-runner');

  test('uses supported typeVersion 1.3 for explicit workflowInputs support', () => {
    expect(node.typeVersion).toBe(1.3);
  });

  test('has onError:continueErrorOutput so error path releases lock then fails parent', () => {
    expect(node.onError).toBe('continueErrorOutput');
  });

  test('has workflowInputs with defineBelow mapping mode', () => {
    expect(node.parameters.workflowInputs).toBeDefined();
    expect(node.parameters.workflowInputs.mappingMode).toBe('defineBelow');
  });

  test('does not pass sessionId to child (contextId-only forwarding)', () => {
    expect(node.parameters.workflowInputs.value.sessionId).toBeUndefined();
  });

  test('passes contextId via workflowInputs referencing Create Context node by name', () => {
    const expr = node.parameters.workflowInputs.value.contextId;
    expect(expr).toBeDefined();
    expect(expr).toContain('JSON.parse($("Create Context").first().json.stdout).contextId');
  });

  test('does not use implicit database source (replaced by explicit workflowInputs)', () => {
    expect(node.parameters.source).toBeUndefined();
  });

  test('references the child workflow ID', () => {
    expect(node.parameters.workflowId).toBe(CHILD_WORKFLOW_ID);
  });

  test('child workflow ID matches the constant', () => {
    expect(CHILD_WORKFLOW_ID).toBe('ai-dev-loop-thin-phase-runner');
  });
});

// ---------------------------------------------------------------------------
// Parent — Release Repo Lock node
// ---------------------------------------------------------------------------

describe('buildParentWorkflow — Release Repo Lock node', () => {
  const wf = buildParentWorkflow();
  const node = wf.nodes.find((n) => n.id === 'release-repo-lock');
  const cmd = node.parameters.command;

  test('has a Release Repo Lock Execute Command node', () => {
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.executeCommand');
    expect(node.name).toBe('Release Repo Lock');
  });

  test('command is an n8n expression', () => {
    expect(cmd.startsWith('=')).toBe(true);
  });

  test('invokes admin.js repo-lock release subcommand', () => {
    expect(cmd).toContain('repo-lock release');
  });

  test('requests JSON output explicitly with --json (issue #308)', () => {
    expect(cmd).toContain('repo-lock release --json');
  });

  test('uses --context-id referencing Create Context stdout (stable upstream reference)', () => {
    expect(cmd).toContain('--context-id');
    expect(cmd).toContain('JSON.parse($("Create Context").first().json.stdout).contextId');
  });

  test('does not depend on Call Phase Runner output', () => {
    expect(cmd).not.toContain('Call Phase Runner');
  });

  test('does not contain a newline character', () => {
    expect(cmd).not.toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// Parent — Release Repo Lock on Error node
// ---------------------------------------------------------------------------

describe('buildParentWorkflow — Release Repo Lock on Error node', () => {
  const wf = buildParentWorkflow();
  const node = wf.nodes.find((n) => n.id === 'release-repo-lock-err');
  const cmd = node?.parameters.command;

  test('has a Release Repo Lock on Error Execute Command node', () => {
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.executeCommand');
    expect(node.name).toBe('Release Repo Lock on Error');
  });

  test('invokes admin.js repo-lock release subcommand', () => {
    expect(cmd).toContain('repo-lock release');
  });

  test('requests JSON output explicitly with --json (issue #308)', () => {
    expect(cmd).toContain('repo-lock release --json');
  });

  test('uses --context-id referencing Create Context stdout', () => {
    expect(cmd).toContain('--context-id');
    expect(cmd).toContain('JSON.parse($("Create Context").first().json.stdout).contextId');
  });

  test('does not contain a newline character', () => {
    expect(cmd).not.toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// Parent — Stop and Error node
// ---------------------------------------------------------------------------

describe('buildParentWorkflow — Stop and Error node', () => {
  const wf = buildParentWorkflow();
  const node = wf.nodes.find((n) => n.id === 'stop-and-error');

  test('has a Stop and Error node', () => {
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.stopAndError');
    expect(node.name).toBe('Stop and Error');
  });

  test('has an errorMessage parameter', () => {
    expect(typeof node.parameters.errorMessage).toBe('string');
    expect(node.parameters.errorMessage.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Parent — connections
// ---------------------------------------------------------------------------

describe('buildParentWorkflow connections', () => {
  const wf = buildParentWorkflow();

  test('Manual Trigger connects to Config', () => {
    expect(wf.connections['Manual Trigger'].main[0][0].node).toBe('Config');
  });

  test('Schedule Trigger connects to Config', () => {
    expect(wf.connections['Schedule Trigger'].main[0][0].node).toBe('Config');
  });

  test('Config connects to Create Context', () => {
    expect(wf.connections['Config'].main[0][0].node).toBe('Create Context');
  });

  test('Create Context connects to Acquire Repo Lock', () => {
    expect(wf.connections['Create Context'].main[0][0].node).toBe('Acquire Repo Lock');
  });

  test('Acquire Repo Lock connects to IF Locked', () => {
    expect(wf.connections['Acquire Repo Lock'].main[0][0].node).toBe('IF Locked');
  });

  test('IF Locked true-branch (index 0) connects to Call Phase Runner', () => {
    expect(wf.connections['IF Locked'].main[0][0].node).toBe('Call Phase Runner');
  });

  test('IF Locked false-branch (index 1) has no connections (no-op end)', () => {
    expect(wf.connections['IF Locked'].main[1]).toEqual([]);
  });

  test('Call Phase Runner success-path (output 0) connects to Release Repo Lock', () => {
    expect(wf.connections['Call Phase Runner'].main[0][0].node).toBe('Release Repo Lock');
  });

  test('Call Phase Runner error-path (output 1) connects to Release Repo Lock on Error', () => {
    expect(wf.connections['Call Phase Runner'].main[1][0].node).toBe('Release Repo Lock on Error');
  });

  test('Release Repo Lock on Error connects to Stop and Error', () => {
    expect(wf.connections['Release Repo Lock on Error'].main[0][0].node).toBe('Stop and Error');
  });

  test('Release Repo Lock has no outgoing connections', () => {
    expect(wf.connections['Release Repo Lock']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Child workflow structure
// ---------------------------------------------------------------------------

describe('buildChildWorkflow structure', () => {
  const wf = buildChildWorkflow();

  test('has a non-empty name', () => {
    expect(typeof wf.name).toBe('string');
    expect(wf.name.length).toBeGreaterThan(0);
  });

  test('has exactly 5 nodes: trigger + GitHub Intake + Run One Phase + Dispatch Outbox + Return Context', () => {
    expect(wf.nodes).toHaveLength(5);
  });

  test('has an Execute Workflow Trigger node', () => {
    const node = wf.nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger');
    expect(node).toBeDefined();
    expect(node.id).toBe('phase-runner-trigger');
    expect(node.name).toBe('When Called by Parent');
  });

  test('has no Child Config (Set) node', () => {
    const node = wf.nodes.find((n) => n.id === 'child-config');
    expect(node).toBeUndefined();
  });

  test('has exactly 3 Execute Command nodes (GitHub Intake, Run One Phase, Dispatch Outbox)', () => {
    const nodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeCommand');
    expect(nodes).toHaveLength(3);
  });

  test('has a GitHub Intake Execute Command node', () => {
    const node = wf.nodes.find((n) => n.id === 'github-intake');
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.executeCommand');
    expect(node.name).toBe('GitHub Intake');
  });

  test('has a Run One Phase Execute Command node', () => {
    const node = wf.nodes.find((n) => n.id === 'run-one-phase');
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.executeCommand');
    expect(node.name).toBe('Run One Phase');
  });

  test('has a Dispatch Outbox Execute Command node', () => {
    const node = wf.nodes.find((n) => n.id === 'dispatch-outbox');
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.executeCommand');
    expect(node.name).toBe('Dispatch Outbox');
  });

  test('has a Return Context (Set) node', () => {
    const node = wf.nodes.find((n) => n.id === 'return-context');
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.set');
    expect(node.name).toBe('Return Context');
  });

  test('workflow id matches CHILD_WORKFLOW_ID', () => {
    expect(wf.id).toBe(CHILD_WORKFLOW_ID);
  });

  // Issue #822: `admin n8n deploy` verifies the imported child by ID *and*
  // name, and locates its artifact by filename. Both come from these exports,
  // so the generated workflow and the deploy command cannot drift apart.
  test('workflow name matches CHILD_WORKFLOW_NAME', () => {
    expect(wf.name).toBe(CHILD_WORKFLOW_NAME);
    expect(CHILD_WORKFLOW_NAME).toBe('AI Dev Loop — Phase Runner (Child)');
  });

  test('the child artifact filename and local artifact directory are exported', () => {
    expect(CHILD_ARTIFACT_FILE_NAME).toBe('n8n-thin-child-workflow.json');
    expect(LOCAL_WORKFLOW_ARTIFACT_DIR).toBe('.n8n-artifacts/workflows');
  });

  test('each node has an id, name, type, and position', () => {
    for (const node of wf.nodes) {
      expect(typeof node.id).toBe('string');
      expect(node.id.length).toBeGreaterThan(0);
      expect(typeof node.name).toBe('string');
      expect(typeof node.type).toBe('string');
      expect(Array.isArray(node.position)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Child — GitHub Intake command
// ---------------------------------------------------------------------------

describe('buildChildWorkflow — GitHub Intake command', () => {
  const wf = buildChildWorkflow();
  const node = wf.nodes.find((n) => n.id === 'github-intake');
  const cmd = node.parameters.command;

  test('command is an n8n expression', () => {
    expect(cmd.startsWith('=')).toBe(true);
  });

  test('uses only --context-id for session lookup (no --session-id)', () => {
    expect(cmd).toContain('--context-id');
    expect(cmd).toContain('$("When Called by Parent").first().json.contextId');
    expect(cmd).not.toContain('--session-id');
    expect(cmd).not.toContain('sessionId');
  });

  test('has baked-in --supported-phases', () => {
    expect(cmd).toContain('--supported-phases');
    expect(cmd).toContain('implementation');
    expect(cmd).toContain('review');
    expect(cmd).toContain('conflict_resolution');
    expect(cmd).toContain('research');
  });

  test('does not contain a newline character', () => {
    expect(cmd).not.toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// Child — Run One Phase command
// ---------------------------------------------------------------------------

describe('buildChildWorkflow — Run One Phase command', () => {
  const wf = buildChildWorkflow();
  const node = wf.nodes.find((n) => n.id === 'run-one-phase');
  const cmd = node.parameters.command;

  test('command is an n8n expression', () => {
    expect(cmd.startsWith('=')).toBe(true);
  });

  test('uses only --context-id for session lookup (no --session-id)', () => {
    expect(cmd).toContain('--context-id');
    expect(cmd).toContain('$("When Called by Parent").first().json.contextId');
    expect(cmd).not.toContain('--session-id');
    expect(cmd).not.toContain('sessionId');
  });

  test('inlines $execution.id for --run-id with millisecond fallback', () => {
    expect(cmd).toContain('--run-id');
    expect(cmd).toContain('$execution.id');
    expect(cmd).toContain('$now.toMillis()');
  });

  test('passes parent contextId for --context-id without fallback', () => {
    expect(cmd).toContain('--context-id');
    expect(cmd).toContain('$("When Called by Parent").first().json.contextId');
    expect(cmd).not.toContain('|| rid');
  });

  test('has baked-in --supported-phases with all phases', () => {
    expect(cmd).toContain('--supported-phases');
    expect(cmd).toContain('implementation');
    expect(cmd).toContain('review');
    expect(cmd).toContain('conflict_resolution');
    expect(cmd).toContain('research');
  });

  test('does not contain a newline character', () => {
    expect(cmd).not.toContain('\n');
  });

  test('does not reference the parent Config node', () => {
    expect(cmd).not.toContain('$("Config")');
  });
});

// ---------------------------------------------------------------------------
// Child — Dispatch Outbox command
// ---------------------------------------------------------------------------

describe('buildChildWorkflow — Dispatch Outbox command', () => {
  const wf = buildChildWorkflow();
  const node = wf.nodes.find((n) => n.id === 'dispatch-outbox');
  const cmd = node.parameters.command;

  test('command is an n8n expression', () => {
    expect(cmd.startsWith('=')).toBe(true);
  });

  test('uses only --context-id for session lookup (no --session-id)', () => {
    expect(cmd).toContain('--context-id');
    expect(cmd).toContain('$("When Called by Parent").first().json.contextId');
    expect(cmd).not.toContain('--session-id');
    expect(cmd).not.toContain('sessionId');
  });

  test('does not contain a newline character', () => {
    expect(cmd).not.toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// Child — Return Context node
// ---------------------------------------------------------------------------

describe('buildChildWorkflow — Return Context node', () => {
  const wf = buildChildWorkflow();
  const node = wf.nodes.find((n) => n.id === 'return-context');

  test('is a Set node', () => {
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.set');
  });

  test('has exactly one assignment: contextId', () => {
    const assignments = node.parameters.assignments.assignments;
    expect(assignments).toHaveLength(1);
    expect(assignments[0].name).toBe('contextId');
  });

  test('reads contextId from trigger (not from $json)', () => {
    const assignments = node.parameters.assignments.assignments;
    const contextIdAssignment = assignments[0];
    expect(contextIdAssignment.value).toContain('$("When Called by Parent").first().json.contextId');
    expect(contextIdAssignment.value).not.toContain('$json.contextId');
  });

  test('uses typeVersion 3', () => {
    expect(node.typeVersion).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Child — no Execute Command uses $json.sessionId (avoids $json overwrite pitfall)
// ---------------------------------------------------------------------------

describe('buildChildWorkflow — $json safety', () => {
  const wf = buildChildWorkflow();

  test('no Execute Command in child uses $json.sessionId directly', () => {
    const execNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeCommand');
    for (const node of execNodes) {
      expect(node.parameters.command).not.toContain('$json.sessionId');
    }
  });

  test('no Execute Command in child uses $json.runId directly', () => {
    const execNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeCommand');
    for (const node of execNodes) {
      expect(node.parameters.command).not.toContain('$json.runId');
    }
  });

  test('no Execute Command in child uses $json.contextId directly', () => {
    const execNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeCommand');
    for (const node of execNodes) {
      expect(node.parameters.command).not.toContain('$json.contextId');
    }
  });

  test('no Execute Command in child references Child Config node', () => {
    const execNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeCommand');
    for (const node of execNodes) {
      expect(node.parameters.command).not.toContain('$("Child Config")');
    }
  });
});

// ---------------------------------------------------------------------------
// Child — connections
// ---------------------------------------------------------------------------

describe('buildChildWorkflow connections', () => {
  const wf = buildChildWorkflow();

  test('When Called by Parent connects directly to GitHub Intake', () => {
    expect(wf.connections['When Called by Parent'].main[0][0].node).toBe('GitHub Intake');
  });

  test('there is no Child Config connection', () => {
    expect(wf.connections['Child Config']).toBeUndefined();
  });

  test('GitHub Intake connects to Run One Phase', () => {
    expect(wf.connections['GitHub Intake'].main[0][0].node).toBe('Run One Phase');
  });

  test('Run One Phase connects to Dispatch Outbox', () => {
    expect(wf.connections['Run One Phase'].main[0][0].node).toBe('Dispatch Outbox');
  });

  test('Dispatch Outbox connects to Return Context', () => {
    expect(wf.connections['Dispatch Outbox'].main[0][0].node).toBe('Return Context');
  });

  test('Return Context has no outgoing connections', () => {
    expect(wf.connections['Return Context']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CLI_BASE resolution — env var vs cwd default (parent and child)
// ---------------------------------------------------------------------------

describe('CLI_BASE resolution — parent and child', () => {
  function execCommands(wf) {
    return wf.nodes
      .filter((n) => n.type === 'n8n-nodes-base.executeCommand')
      .map((n) => n.parameters.command);
  }

  test('parent: with CLI_BASE set, Execute Command nodes use the explicit override path', () => {
    const saved = process.env['CLI_BASE'];
    process.env['CLI_BASE'] = '/ops/n8n-ai-cli-loop/dist/cli';
    const cmds = execCommands(buildParentWorkflow());
    if (saved !== undefined) process.env['CLI_BASE'] = saved;
    else delete process.env['CLI_BASE'];
    for (const cmd of cmds) {
      expect(cmd).toContain('/ops/n8n-ai-cli-loop/dist/cli');
    }
  });

  test('parent: with CLI_BASE unset and process.cwd() mocked, commands use <cwd>/dist/cli', () => {
    const saved = process.env['CLI_BASE'];
    delete process.env['CLI_BASE'];
    const mockCwd = jest.spyOn(process, 'cwd').mockReturnValue('/tmp/build-tree-parent');
    const cmds = execCommands(buildParentWorkflow());
    mockCwd.mockRestore();
    if (saved !== undefined) process.env['CLI_BASE'] = saved;
    for (const cmd of cmds) {
      expect(cmd).toContain('/tmp/build-tree-parent/dist/cli');
    }
  });

  test('child: with CLI_BASE set, Execute Command nodes use the explicit override path', () => {
    const saved = process.env['CLI_BASE'];
    process.env['CLI_BASE'] = '/ops/n8n-ai-cli-loop/dist/cli';
    const cmds = execCommands(buildChildWorkflow());
    if (saved !== undefined) process.env['CLI_BASE'] = saved;
    else delete process.env['CLI_BASE'];
    for (const cmd of cmds) {
      expect(cmd).toContain('/ops/n8n-ai-cli-loop/dist/cli');
    }
  });

  test('child: with CLI_BASE unset and process.cwd() mocked, commands use <cwd>/dist/cli', () => {
    const saved = process.env['CLI_BASE'];
    delete process.env['CLI_BASE'];
    const mockCwd = jest.spyOn(process, 'cwd').mockReturnValue('/tmp/build-tree-child');
    const cmds = execCommands(buildChildWorkflow());
    mockCwd.mockRestore();
    if (saved !== undefined) process.env['CLI_BASE'] = saved;
    for (const cmd of cmds) {
      expect(cmd).toContain('/tmp/build-tree-child/dist/cli');
    }
  });

  test('child Execute Command nodes do not use --session-id (contextId-only design)', () => {
    const saved = process.env['CLI_BASE'];
    delete process.env['CLI_BASE'];
    const cmds = execCommands(buildChildWorkflow());
    if (saved !== undefined) process.env['CLI_BASE'] = saved;
    for (const cmd of cmds) {
      expect(cmd).not.toContain('--session-id');
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical template vs local deployment split (issue #391)
// ---------------------------------------------------------------------------

describe('canonical template vs local deployment cliBase', () => {
  function execCommands(wf) {
    return wf.nodes
      .filter((n) => n.type === 'n8n-nodes-base.executeCommand')
      .map((n) => n.parameters.command);
  }

  test('explicit cliBase option overrides the env/cwd default', () => {
    const saved = process.env['CLI_BASE'];
    process.env['CLI_BASE'] = '/env/should/be/ignored/dist/cli';
    const cmds = [
      ...execCommands(buildParentWorkflow({ cliBase: CANONICAL_CLI_BASE })),
      ...execCommands(buildChildWorkflow({ cliBase: CANONICAL_CLI_BASE })),
    ];
    if (saved !== undefined) process.env['CLI_BASE'] = saved;
    else delete process.env['CLI_BASE'];
    for (const cmd of cmds) {
      expect(cmd).toContain(CANONICAL_CLI_BASE);
      expect(cmd).not.toContain('/env/should/be/ignored/dist/cli');
    }
  });

  test('canonical template path is environment-independent (no home/cwd path)', () => {
    const cmds = [
      ...execCommands(buildParentWorkflow({ cliBase: CANONICAL_CLI_BASE })),
      ...execCommands(buildChildWorkflow({ cliBase: CANONICAL_CLI_BASE })),
    ];
    for (const cmd of cmds) {
      expect(cmd).not.toMatch(/\/(?:Users|home)\//);
    }
  });

  test('resolveLocalCliBase returns explicit CLI_BASE when set', () => {
    const saved = process.env['CLI_BASE'];
    process.env['CLI_BASE'] = '/ops/local/dist/cli';
    expect(resolveLocalCliBase()).toBe('/ops/local/dist/cli');
    if (saved !== undefined) process.env['CLI_BASE'] = saved;
    else delete process.env['CLI_BASE'];
  });

  test('resolveLocalCliBase falls back to <cwd>/dist/cli when CLI_BASE unset', () => {
    const saved = process.env['CLI_BASE'];
    delete process.env['CLI_BASE'];
    const mockCwd = jest.spyOn(process, 'cwd').mockReturnValue('/tmp/local-build-tree');
    expect(resolveLocalCliBase()).toBe('/tmp/local-build-tree/dist/cli');
    mockCwd.mockRestore();
    if (saved !== undefined) process.env['CLI_BASE'] = saved;
  });

  function sessionIdValue(wf) {
    const cfg = wf.nodes.find((n) => n.id === 'workflow-config');
    return cfg.parameters.assignments.assignments.find((a) => a.name === 'sessionId').value;
  }

  // The docs/ template build passes sessionId explicitly so the operator's
  // SESSION_REF / SESSION_ID never dirties the tracked Config node (issue #391).
  test('explicit sessionId option is baked into the Config node', () => {
    const wf = buildParentWorkflow({ sessionId: CANONICAL_SESSION_ID });
    expect(sessionIdValue(wf)).toBe(CANONICAL_SESSION_ID);
  });

  test('explicit sessionId option overrides the no-arg default', () => {
    const localId = 'operator-local-session';
    expect(sessionIdValue(buildParentWorkflow({ sessionId: localId }))).toBe(localId);
    expect(sessionIdValue(buildParentWorkflow({ sessionId: localId }))).not.toBe(
      CANONICAL_SESSION_ID
    );
  });

  // SESSION_REF holds a mutable reference that only the CLI entrypoint may
  // resolve; the pure builder must never pick it up from the environment.
  test('SESSION_REF in the environment does not leak into the built Config node', () => {
    const saved = process.env['SESSION_REF'];
    process.env['SESSION_REF'] = 'some-operator-alias';
    const value = sessionIdValue(buildParentWorkflow());
    if (saved !== undefined) process.env['SESSION_REF'] = saved;
    else delete process.env['SESSION_REF'];
    expect(value).toBe(CANONICAL_SESSION_ID);
  });

  test('local deployment build bakes the resolved local CLI_BASE into commands', () => {
    const saved = process.env['CLI_BASE'];
    process.env['CLI_BASE'] = '/ops/local/dist/cli';
    const localCliBase = resolveLocalCliBase();
    const cmds = [
      ...execCommands(buildParentWorkflow({ cliBase: localCliBase })),
      ...execCommands(buildChildWorkflow({ cliBase: localCliBase })),
    ];
    if (saved !== undefined) process.env['CLI_BASE'] = saved;
    else delete process.env['CLI_BASE'];
    for (const cmd of cmds) {
      expect(cmd).toContain('/ops/local/dist/cli');
    }
  });
});

// ---------------------------------------------------------------------------
// Shell-escaping — single quotes in CLI_BASE path are escaped
// ---------------------------------------------------------------------------

describe("shell-escaping CLI path — parent and child", () => {
  function execCommands(wf) {
    return wf.nodes
      .filter((n) => n.type === "n8n-nodes-base.executeCommand")
      .map((n) => n.parameters.command);
  }

  test("parent: single quote in CLI_BASE is escaped as '\\''", () => {
    const saved = process.env["CLI_BASE"];
    process.env["CLI_BASE"] = "/tmp/O'Connor/dist/cli";
    const cmds = execCommands(buildParentWorkflow());
    if (saved !== undefined) process.env["CLI_BASE"] = saved;
    else delete process.env["CLI_BASE"];
    for (const cmd of cmds) {
      expect(cmd).toContain("/tmp/O'\\\\''Connor/dist/cli");
    }
  });

  test("child: single quote in CLI_BASE is escaped as '\\''", () => {
    const saved = process.env["CLI_BASE"];
    process.env["CLI_BASE"] = "/tmp/O'Connor/dist/cli";
    const cmds = execCommands(buildChildWorkflow());
    if (saved !== undefined) process.env["CLI_BASE"] = saved;
    else delete process.env["CLI_BASE"];
    for (const cmd of cmds) {
      expect(cmd).toContain("/tmp/O'\\\\''Connor/dist/cli");
    }
  });

  test("parent: CLI_BASE without single quotes passes through unchanged", () => {
    const saved = process.env["CLI_BASE"];
    process.env["CLI_BASE"] = "/ops/n8n-ai-cli-loop/dist/cli";
    const cmds = execCommands(buildParentWorkflow());
    if (saved !== undefined) process.env["CLI_BASE"] = saved;
    else delete process.env["CLI_BASE"];
    for (const cmd of cmds) {
      expect(cmd).toContain("/ops/n8n-ai-cli-loop/dist/cli");
    }
  });

  test("child: CLI_BASE without single quotes passes through unchanged", () => {
    const saved = process.env["CLI_BASE"];
    process.env["CLI_BASE"] = "/ops/n8n-ai-cli-loop/dist/cli";
    const cmds = execCommands(buildChildWorkflow());
    if (saved !== undefined) process.env["CLI_BASE"] = saved;
    else delete process.env["CLI_BASE"];
    for (const cmd of cmds) {
      expect(cmd).toContain("/ops/n8n-ai-cli-loop/dist/cli");
    }
  });

  test("parent: double quote in CLI_BASE is escaped as \\\" for the n8n JS string layer", () => {
    const saved = process.env["CLI_BASE"];
    process.env["CLI_BASE"] = '/tmp/a"b/dist/cli';
    const cmds = execCommands(buildParentWorkflow());
    if (saved !== undefined) process.env["CLI_BASE"] = saved;
    else delete process.env["CLI_BASE"];
    for (const cmd of cmds) {
      expect(cmd).toContain('/tmp/a\\"b/dist/cli');
    }
  });

  test("child: double quote in CLI_BASE is escaped as \\\" for the n8n JS string layer", () => {
    const saved = process.env["CLI_BASE"];
    process.env["CLI_BASE"] = '/tmp/a"b/dist/cli';
    const cmds = execCommands(buildChildWorkflow());
    if (saved !== undefined) process.env["CLI_BASE"] = saved;
    else delete process.env["CLI_BASE"];
    for (const cmd of cmds) {
      expect(cmd).toContain('/tmp/a\\"b/dist/cli');
    }
  });
});

// ---------------------------------------------------------------------------
// Parent/child ID consistency
// ---------------------------------------------------------------------------

describe('parent/child workflow ID consistency', () => {
  const parent = buildParentWorkflow();
  const child = buildChildWorkflow();

  test('parent Call Phase Runner references the child workflow ID', () => {
    const callNode = parent.nodes.find((n) => n.id === 'call-phase-runner');
    expect(callNode.parameters.workflowId).toBe(child.id);
  });

  test('parent and child have distinct workflow IDs', () => {
    expect(parent.id).not.toBe(child.id);
  });
});

// ---------------------------------------------------------------------------
// Session-specific parent identity (issue #821)
//
// A multi-session deployment imports one parent per session and exactly one
// shared child.  Parent identity must therefore be derived from the canonical
// sessionId: deterministic (so regenerating does not churn the deployment),
// collision-safe (so two sessions can never claim the same n8n workflow), and
// human-readable (so an operator can tell the parents apart in the list).
// ---------------------------------------------------------------------------

describe('deriveParentWorkflowId', () => {
  test('is deterministic for the same sessionId', () => {
    expect(deriveParentWorkflowId('team-alpha')).toBe(deriveParentWorkflowId('team-alpha'));
  });

  test('is distinct for different sessionIds', () => {
    expect(deriveParentWorkflowId('team-alpha')).not.toBe(deriveParentWorkflowId('team-beta'));
  });

  test('starts with the parent prefix and is a safe identifier', () => {
    const id = deriveParentWorkflowId('Team Alpha/API');
    expect(id.startsWith(PARENT_WORKFLOW_ID_PREFIX)).toBe(true);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  test('keeps a readable slug of the sessionId', () => {
    expect(deriveParentWorkflowId('team-alpha')).toContain('team-alpha');
  });

  // Slugging is lossy, so the digest — not the slug — carries uniqueness.
  test('sessionIds that slug identically still get distinct IDs', () => {
    const a = deriveParentWorkflowId('team/api');
    const b = deriveParentWorkflowId('team-api');
    expect(a).not.toBe(b);
    expect(a.startsWith(`${PARENT_WORKFLOW_ID_PREFIX}team-api-`)).toBe(true);
    expect(b.startsWith(`${PARENT_WORKFLOW_ID_PREFIX}team-api-`)).toBe(true);
  });

  test('long sessionIds have a truncated slug but stay distinct', () => {
    const long = 'a'.repeat(80);
    const longer = `${long}b`;
    // The readable half is capped; the ID as a whole is therefore bounded by the
    // cap plus the prefix and the fixed-width digest, however long the sessionId.
    expect(deriveParentWorkflowId(long).length).toBeLessThan(120);
    expect(deriveParentWorkflowId(long)).not.toBe(deriveParentWorkflowId(longer));
  });

  // The digest is the whole of the collision safety — the slug is lossy and the
  // artifact filename IS the workflow ID, so two sessions that share a digest
  // claim one workflow and one file, and the second build silently overwrites
  // the first.  A truncated digest made that reachable by search (a review found
  // the pair below for an eight-character prefix); the full sha256 does not.
  test('the ID carries the full sha256 of the sessionId, never a prefix of it', () => {
    const full = createHash('sha256').update('team-alpha', 'utf8').digest('hex');
    expect(full).toHaveLength(64);
    expect(deriveParentWorkflowId('team-alpha')).toBe(
      `${PARENT_WORKFLOW_ID_PREFIX}team-alpha-${full}`,
    );
  });

  test('sessionIds that differ only in punctuation get distinct IDs and filenames', () => {
    const a = 'team@@!@@!!!!@!@';
    const b = 'team@@@@!@!@!!!@@@';
    expect(deriveParentWorkflowId(a)).not.toBe(deriveParentWorkflowId(b));
    expect(parentArtifactFileName(a)).not.toBe(parentArtifactFileName(b));
    // Both slug to the same readable half, so only the digest tells them apart.
    expect(deriveParentWorkflowId(a).replace(/-[0-9a-f]{64}$/, '')).toBe(
      deriveParentWorkflowId(b).replace(/-[0-9a-f]{64}$/, ''),
    );
  });

  // sessions.json accepts any non-empty sessionId, so a session named in a
  // non-Latin script must still be deployable: the slug transcribes those code
  // points instead of dropping them and leaving nothing to build an ID from.
  test('derives a safe ID for a non-ASCII sessionId', () => {
    const id = deriveParentWorkflowId('開発');
    expect(id.startsWith(PARENT_WORKFLOW_ID_PREFIX)).toBe(true);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(deriveParentWorkflowId('開発')).toBe(id);
  });

  test('distinct non-ASCII sessionIds get distinct IDs', () => {
    expect(deriveParentWorkflowId('開発')).not.toBe(deriveParentWorkflowId('本番'));
  });

  test('a mixed-script sessionId keeps its ASCII half readable', () => {
    expect(deriveParentWorkflowId('team-開発')).toContain('team-');
  });

  // The transcription must not perturb IDs that never needed it.
  test('ASCII sessionIds are unaffected by non-ASCII transcription', () => {
    expect(deriveParentWorkflowId('team-alpha')).toBe(
      `${PARENT_WORKFLOW_ID_PREFIX}team-alpha-${createHash('sha256')
        .update('team-alpha', 'utf8')
        .digest('hex')}`,
    );
  });

  // sessions.json accepts a sessionId made only of punctuation, so it resolves
  // through the registry like any other and must still yield an artifact — the
  // digest, not the slug, is what identifies it.
  test('derives a safe ID for a sessionId with no slug-able characters', () => {
    const id = deriveParentWorkflowId('--__--');
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(id.startsWith(PARENT_WORKFLOW_ID_PREFIX)).toBe(true);
    expect(id).toBe(deriveParentWorkflowId('--__--'));
  });

  test('punctuation-only sessionIds that slug to nothing stay distinct', () => {
    expect(deriveParentWorkflowId('--__--')).not.toBe(deriveParentWorkflowId('__--__'));
  });

  test('does not end with a hyphen when truncation lands on a separator', () => {
    // The 32-char cut lands exactly on the separator here, so the slug would end
    // with a hyphen and the ID would read "…a--<digest>" without the trim.
    const id = deriveParentWorkflowId(`${'a'.repeat(31)}-tail`);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(id).not.toContain('--');
  });
});

describe('derived identifiers fail clearly on unsafe or empty input', () => {
  test.each([
    ['an empty sessionId', ''],
    ['a whitespace-only sessionId', '   '],
  ])('rejects %s', (_label, sessionId) => {
    expect(() => deriveParentWorkflowId(sessionId)).toThrow(/non-empty string/);
  });

  test('rejects a non-string sessionId', () => {
    expect(() => deriveParentWorkflowId(undefined)).toThrow(/non-empty string/);
    expect(() => deriveParentWorkflowId(42)).toThrow(/non-empty string/);
  });

  test('rejects a sessionId containing a control character', () => {
    expect(() => deriveParentWorkflowId('team\nalpha')).toThrow(/control characters/);
  });

  test('requireCanonicalSessionId returns the value unchanged when it is usable', () => {
    expect(requireCanonicalSessionId('team-alpha')).toBe('team-alpha');
  });

  test('buildParentWorkflow refuses an empty sessionId', () => {
    expect(() => buildParentWorkflow({ sessionId: '' })).toThrow(/non-empty string/);
  });
});

// sessions.json validates a sessionId as "a non-empty, non-whitespace-only
// string", so one padded with spaces is a legitimate registry entry that
// resolveSessionRef will hand back verbatim.  The generator must accept exactly
// what the registry accepts: refusing a padded sessionId would make a valid
// session undeployable, and trimming it would point the Config node — and the
// `--session-id` argument built from it — at a DIFFERENT session.
describe('a padded sessionId stays deployable and keeps its exact value', () => {
  const padded = ' padded ';

  test('requireCanonicalSessionId returns it unchanged', () => {
    expect(requireCanonicalSessionId(padded)).toBe(padded);
  });

  test('derives a safe, deterministic workflow ID for it', () => {
    const id = deriveParentWorkflowId(padded);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(id).toBe(deriveParentWorkflowId(padded));
    expect(parentArtifactFileName(padded)).toMatch(/^[a-z0-9][a-z0-9-]*\.json$/);
  });

  // The padding is part of the identity, so it must not collapse onto the
  // unpadded session — they are two registry entries and two deployments.
  test('is a different session from its unpadded namesake', () => {
    expect(deriveParentWorkflowId(padded)).not.toBe(deriveParentWorkflowId('padded'));
    expect(parentArtifactFileName(padded)).not.toBe(parentArtifactFileName('padded'));
    expect(deriveParentWorkflowName(padded)).not.toBe(deriveParentWorkflowName('padded'));
  });

  test('Config carries the padded sessionId byte-for-byte', () => {
    const wf = buildParentWorkflow({ cliBase: CANONICAL_CLI_BASE, sessionId: padded });
    const cfg = wf.nodes.find((n) => n.id === 'workflow-config');
    expect(cfg.parameters.assignments.assignments.find((a) => a.name === 'sessionId').value).toBe(
      padded,
    );
  });

  test('resolveSessionIds accepts a padded sessionId from the registry', () => {
    expect(resolveSessionIds(['alias'], () => padded)).toEqual([padded]);
  });
});

describe('deriveParentWorkflowName', () => {
  test('is human-readable and names the session', () => {
    expect(deriveParentWorkflowName('team-alpha')).toBe('AI Dev Loop — Parent (team-alpha)');
  });

  test('is distinct for different sessions', () => {
    expect(deriveParentWorkflowName('team-alpha')).not.toBe(deriveParentWorkflowName('team-beta'));
  });

  test('rejects an unusable sessionId', () => {
    expect(() => deriveParentWorkflowName('')).toThrow(/non-empty string/);
  });
});

describe('parentArtifactFileName', () => {
  test('is named after the derived workflow ID', () => {
    expect(parentArtifactFileName('team-alpha')).toBe(`${deriveParentWorkflowId('team-alpha')}.json`);
  });

  test('two sessions cannot overwrite each other artifact', () => {
    expect(parentArtifactFileName('team-alpha')).not.toBe(parentArtifactFileName('team-beta'));
  });

  test('a non-ASCII sessionId still yields an ASCII filename', () => {
    expect(parentArtifactFileName('開発')).toMatch(/^[a-z0-9][a-z0-9-]*\.json$/);
  });
});

describe('multi-session parent generation', () => {
  const alpha = buildParentWorkflow({ cliBase: CANONICAL_CLI_BASE, sessionId: 'team-alpha' });
  const beta = buildParentWorkflow({ cliBase: CANONICAL_CLI_BASE, sessionId: 'team-beta' });

  function sessionIdValue(wf) {
    const cfg = wf.nodes.find((n) => n.id === 'workflow-config');
    return cfg.parameters.assignments.assignments.find((a) => a.name === 'sessionId').value;
  }

  test('two configured sessions get distinct parent workflow IDs', () => {
    expect(alpha.id).toBe(deriveParentWorkflowId('team-alpha'));
    expect(beta.id).toBe(deriveParentWorkflowId('team-beta'));
    expect(alpha.id).not.toBe(beta.id);
  });

  test('two configured sessions get distinct human-readable names', () => {
    expect(alpha.name).toBe('AI Dev Loop — Parent (team-alpha)');
    expect(beta.name).toBe('AI Dev Loop — Parent (team-beta)');
    expect(alpha.name).not.toBe(beta.name);
  });

  test('each Config node holds its own canonical sessionId', () => {
    expect(sessionIdValue(alpha)).toBe('team-alpha');
    expect(sessionIdValue(beta)).toBe('team-beta');
  });

  test('both parents call the SAME shared child workflow ID', () => {
    for (const wf of [alpha, beta]) {
      const call = wf.nodes.find((n) => n.id === 'call-phase-runner');
      expect(call.parameters.workflowId).toBe(CHILD_WORKFLOW_ID);
    }
  });

  test('the parent-to-child payload still carries only contextId', () => {
    for (const wf of [alpha, beta]) {
      const call = wf.nodes.find((n) => n.id === 'call-phase-runner');
      expect(Object.keys(call.parameters.workflowInputs.value)).toEqual(['contextId']);
    }
  });

  test('repeated generation for the same session is byte-for-byte deterministic', () => {
    const again = buildParentWorkflow({ cliBase: CANONICAL_CLI_BASE, sessionId: 'team-alpha' });
    expect(JSON.stringify(again, null, 2)).toBe(JSON.stringify(alpha, null, 2));
  });

  test('a session-specific parent carries no absolute path other than its CLI base', () => {
    const serialized = JSON.stringify(alpha);
    expect(serialized).toContain(CANONICAL_CLI_BASE);
    // No home/checkout path, no sessions.json path, no artifact/worktree root.
    // The registry is named in the read-only Config hints as prose ("resolved
    // from sessions.json by sessionId"), which is why this pins the absence of
    // a sessions.json *path* rather than of the bare file name.
    expect(serialized).not.toMatch(/\/(?:Users|home)\//);
    expect(serialized).not.toMatch(/[\\/]sessions\.json/);
    expect(serialized).not.toContain(process.cwd());
  });

  // The deployment artifact intentionally carries ONE absolute path — the CLI
  // base it must invoke. Nothing else about the operator's machine (checkout
  // path, sessions.json location, artifact root) may ride along with it.
  test('a local deployment parent carries only the CLI base path', () => {
    const localCliBase = '/ops/deployment-tree/dist/cli';
    const wf = buildParentWorkflow({ cliBase: localCliBase, sessionId: 'team-alpha' });
    const withoutCliBase = JSON.stringify(wf).split(localCliBase).join('');
    expect(JSON.stringify(wf)).toContain(localCliBase);
    // Any remaining multi-segment path would be a second absolute path. (The
    // single-segment "/admin.js" left behind by the removal, and the "/'/g"
    // of the escaping regex, are deliberately not matched by this pattern.)
    expect(withoutCliBase).not.toMatch(/\/[\w.-]+\/[\w.-]+/);
    expect(withoutCliBase).not.toContain(process.cwd());
  });

  test('the shared child is identical no matter which session is generated', () => {
    const first = buildChildWorkflow({ cliBase: CANONICAL_CLI_BASE });
    const second = buildChildWorkflow({ cliBase: CANONICAL_CLI_BASE });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.id).toBe(CHILD_WORKFLOW_ID);
  });
});

// ---------------------------------------------------------------------------
// Session reference resolution (issue #821)
//
// References (sessionNo, alias) are mutable, so they are resolved to canonical
// sessionIds at GENERATION time.  The resolver itself lives in the compiled
// registry; these tests inject a stub so they pin the generator's contract with
// it (ordering, dedupe, failure reporting) without depending on dist/.
// ---------------------------------------------------------------------------

describe('parseSessionRefs', () => {
  test('accepts a single reference', () => {
    expect(parseSessionRefs('addon')).toEqual(['addon']);
  });

  test('splits and trims a comma-separated list', () => {
    expect(parseSessionRefs(' addon , 2 ,tar ')).toEqual(['addon', '2', 'tar']);
  });

  test('drops empty entries from a trailing or doubled comma', () => {
    expect(parseSessionRefs('addon,,tar,')).toEqual(['addon', 'tar']);
  });

  test('throws when the value contains no reference at all', () => {
    expect(() => parseSessionRefs(' , ')).toThrow(/no session reference/);
  });

  // sessions.json accepts any non-empty string as a sessionId or alias, so a
  // reference may legitimately contain the list separator itself, or the padding
  // the splitter would otherwise trim.  Without an escape those sessions could
  // not be named here at all: "team,a" read as two unknown references.
  test('a backslash escapes a comma so it is part of the reference', () => {
    expect(parseSessionRefs(String.raw`team\,a`)).toEqual(['team,a']);
  });

  test('an escaped comma does not stop the rest of the list from splitting', () => {
    expect(parseSessionRefs(String.raw`team\,a,addon`)).toEqual(['team,a', 'addon']);
  });

  test('escaped whitespace is kept while unescaped whitespace is still trimmed', () => {
    expect(parseSessionRefs(String.raw`\ padded\ , addon `)).toEqual([' padded ', 'addon']);
  });

  test('a doubled backslash is one literal backslash in the reference', () => {
    expect(parseSessionRefs(String.raw`back\\slash`)).toEqual([String.raw`back\slash`]);
  });

  // A truncated escape is always a typo (a shell that ate the quoting, say);
  // dropping it silently would resolve some other session.
  test('rejects a value ending in a lone backslash', () => {
    expect(() => parseSessionRefs('team\\')).toThrow(/lone backslash/);
  });

  // Escaping is opt-in: values that never use a backslash keep their old parse.
  test('leaves unescaped values parsing exactly as before', () => {
    expect(parseSessionRefs(' addon , 2 ,tar ')).toEqual(['addon', '2', 'tar']);
    expect(parseSessionRefs('addon')).toEqual(['addon']);
  });
});

describe('resolveSessionIds', () => {
  const registry = { addon: 'team-alpha', 2: 'team-alpha', tar: 'team-beta' };
  const resolveRef = (ref) => {
    if (!(ref in registry)) throw new Error(`Unknown session reference: "${ref}".`);
    return registry[ref];
  };

  test('resolves references to canonical sessionIds in order', () => {
    expect(resolveSessionIds(['tar', 'addon'], resolveRef)).toEqual(['team-beta', 'team-alpha']);
  });

  // Two references naming one session must yield one parent, not two identical ones.
  test('deduplicates references that resolve to the same session', () => {
    expect(resolveSessionIds(['addon', '2'], resolveRef)).toEqual(['team-alpha']);
  });

  test('reports which reference could not be resolved', () => {
    expect(() => resolveSessionIds(['nope'], resolveRef)).toThrow(/"nope"/);
    expect(() => resolveSessionIds(['nope'], resolveRef)).toThrow(/Unknown session reference/);
  });

  test('rejects a resolver result that is not a usable sessionId', () => {
    expect(() => resolveSessionIds(['addon'], () => '')).toThrow(/non-empty string/);
  });
});

describe('resolveConfiguredSessionIds', () => {
  test('falls back to the canonical default session when no reference is configured', async () => {
    await expect(resolveConfiguredSessionIds({})).resolves.toEqual([CANONICAL_SESSION_ID]);
  });

  // The default must not need a session registry: `npm run build` has to work on
  // a machine (or CI runner) with no sessions.json at all.
  test('treats a blank SESSION_REF as unconfigured rather than failing the build', async () => {
    await expect(resolveConfiguredSessionIds({ SESSION_REF: '   ' })).resolves.toEqual([
      CANONICAL_SESSION_ID,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Session resolver availability — `build:parent-child-workflow` does not depend
// on `build:lib`, and dist/ is gitignored, so a fresh checkout must compile the
// resolver on demand instead of failing before any artifact is written.
// ---------------------------------------------------------------------------

describe('ensureSessionResolverBuilt', () => {
  const missing = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/__does-not-exist__.js');

  test('compiles the library when the resolver module is missing', () => {
    const compile = jest.fn(() => ({ status: 0 }));
    // Compile "succeeds" but the module still is not there, so this also pins
    // that a silent no-op compiler is reported rather than swallowed.
    expect(() => ensureSessionResolverBuilt({ modulePath: missing, compile })).toThrow(
      /still missing/,
    );
    expect(compile).toHaveBeenCalledTimes(1);
  });

  test('does not compile when the resolver module is already built', () => {
    const compile = jest.fn(() => ({ status: 0 }));
    const present = fileURLToPath(import.meta.url);
    expect(() => ensureSessionResolverBuilt({ modulePath: present, compile })).not.toThrow();
    expect(compile).not.toHaveBeenCalled();
  });

  test('reports a failing compile with its exit status', () => {
    expect(() =>
      ensureSessionResolverBuilt({ modulePath: missing, compile: () => ({ status: 2 }) }),
    ).toThrow(/exited with 2/);
  });

  test('reports a compiler that could not be spawned at all', () => {
    expect(() =>
      ensureSessionResolverBuilt({
        modulePath: missing,
        compile: () => ({ error: new Error('spawn ENOENT') }),
      }),
    ).toThrow(/spawn ENOENT/);
  });
});

describe('loadSessionRefResolver', () => {
  test('builds the resolver before importing it', async () => {
    const ensureBuilt = jest.fn();
    const resolveRef = await loadSessionRefResolver({ ensureBuilt });
    expect(ensureBuilt).toHaveBeenCalledTimes(1);
    expect(ensureBuilt.mock.calls[0][0].modulePath).toMatch(
      /dist[/\\]registries[/\\]json-session-registry\.js$/,
    );
    expect(typeof resolveRef).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow child workflow — stability
// ---------------------------------------------------------------------------

test('checked-in private-node child workflow JSON matches canonical generator output', () => {
  const checkedIn = readFileSync(privateNodeChildPath, 'utf8');
  const generated =
    JSON.stringify(buildPrivateNodeChildWorkflow({ cliBase: CANONICAL_CLI_BASE }), null, 2) + '\n';
  expect(checkedIn).toBe(generated);
});

test('checked-in private-node child workflow JSON is environment-independent (no CLI_BASE leakage — all operations are private node)', () => {
  const MOCK_LOCAL_CLI_BASE = '/home/operator/local-checkout/dist/cli';
  expect(MOCK_LOCAL_CLI_BASE).not.toBe(CANONICAL_CLI_BASE);
  const checkedIn = readFileSync(privateNodeChildPath, 'utf8');
  // After Slice 4 (runOnePhase), no Execute Command nodes remain — no CLI path baked in.
  expect(checkedIn).not.toContain(CANONICAL_CLI_BASE);
  expect(checkedIn).not.toContain(MOCK_LOCAL_CLI_BASE);
  expect(checkedIn).not.toMatch(/\/(?:Users|home)\/[^"']*\/dist\/cli/);
});

// ---------------------------------------------------------------------------
// Private-node shadow child workflow — structure
// ---------------------------------------------------------------------------

describe('buildPrivateNodeChildWorkflow structure', () => {
  const wf = buildPrivateNodeChildWorkflow();

  test('has a non-empty name', () => {
    expect(typeof wf.name).toBe('string');
    expect(wf.name.length).toBeGreaterThan(0);
  });

  test('name indicates shadow/test-only status', () => {
    expect(wf.name).toContain('SHADOW TEST');
  });

  test('has exactly 5 nodes: trigger + GitHub Intake + Run One Phase + Dispatch Outbox + Return Context', () => {
    expect(wf.nodes).toHaveLength(5);
  });

  test('workflow ID matches PRIVATE_NODE_CHILD_WORKFLOW_ID constant', () => {
    expect(wf.id).toBe(PRIVATE_NODE_CHILD_WORKFLOW_ID);
  });

  test('PRIVATE_NODE_CHILD_WORKFLOW_ID differs from CHILD_WORKFLOW_ID (coexistence)', () => {
    expect(PRIVATE_NODE_CHILD_WORKFLOW_ID).not.toBe(CHILD_WORKFLOW_ID);
  });

  test('has an Execute Workflow Trigger node', () => {
    const node = wf.nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger');
    expect(node).toBeDefined();
    expect(node.id).toBe('phase-runner-trigger');
    expect(node.name).toBe('When Called by Parent');
  });

  test('has exactly 0 Execute Command nodes (all operations are private node after Slice 4)', () => {
    const nodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeCommand');
    expect(nodes).toHaveLength(0);
  });

  test('has a Return Context (Set) node', () => {
    const node = wf.nodes.find((n) => n.id === 'return-context');
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.set');
  });

  test('each node has an id, name, type, and position', () => {
    for (const node of wf.nodes) {
      expect(typeof node.id).toBe('string');
      expect(node.id.length).toBeGreaterThan(0);
      expect(typeof node.name).toBe('string');
      expect(typeof node.type).toBe('string');
      expect(Array.isArray(node.position)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow child — Dispatch Outbox operation wiring
// ---------------------------------------------------------------------------

describe('buildPrivateNodeChildWorkflow — Dispatch Outbox operation wiring', () => {
  const wf = buildPrivateNodeChildWorkflow();
  const node = wf.nodes.find((n) => n.id === 'dispatch-outbox');

  test('Dispatch Outbox node exists', () => {
    expect(node).toBeDefined();
    expect(node.name).toBe('Dispatch Outbox');
  });

  test('Dispatch Outbox uses the private node type, not executeCommand', () => {
    expect(node.type).toBe(PRIVATE_NODE_TYPE);
    expect(node.type).not.toBe('n8n-nodes-base.executeCommand');
  });

  test('PRIVATE_NODE_TYPE constant is the expected CUSTOM-prefix identifier (N8N_CUSTOM_EXTENSIONS loading)', () => {
    expect(PRIVATE_NODE_TYPE).toBe('CUSTOM.aiCliLoop');
  });

  test('Dispatch Outbox operation parameter is dispatchOutbox', () => {
    expect(node.parameters.operation).toBe('dispatchOutbox');
  });

  test('Dispatch Outbox contextId references the trigger node', () => {
    expect(node.parameters.contextId).toContain('$("When Called by Parent").first().json.contextId');
  });

  test('Dispatch Outbox contextId is an n8n expression', () => {
    expect(node.parameters.contextId.startsWith('=')).toBe(true);
  });

  test('Dispatch Outbox node has no command parameter (not an Execute Command node)', () => {
    expect(node.parameters.command).toBeUndefined();
  });

  test('Dispatch Outbox uses typeVersion 1', () => {
    expect(node.typeVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow child — GitHub Intake operation wiring
// ---------------------------------------------------------------------------

describe('buildPrivateNodeChildWorkflow — GitHub Intake operation wiring', () => {
  const wf = buildPrivateNodeChildWorkflow();
  const node = wf.nodes.find((n) => n.id === 'github-intake');

  test('GitHub Intake node exists', () => {
    expect(node).toBeDefined();
    expect(node.name).toBe('GitHub Intake');
  });

  test('GitHub Intake uses the private node type, not executeCommand', () => {
    expect(node.type).toBe(PRIVATE_NODE_TYPE);
    expect(node.type).not.toBe('n8n-nodes-base.executeCommand');
  });

  test('GitHub Intake operation parameter is githubIntake', () => {
    expect(node.parameters.operation).toBe('githubIntake');
  });

  test('GitHub Intake contextId references the trigger node', () => {
    expect(node.parameters.contextId).toContain('$("When Called by Parent").first().json.contextId');
  });

  test('GitHub Intake contextId is an n8n expression', () => {
    expect(node.parameters.contextId.startsWith('=')).toBe(true);
  });

  test('GitHub Intake has baked-in supportedPhases covering all phases', () => {
    expect(node.parameters.supportedPhases).toBeDefined();
    expect(node.parameters.supportedPhases).toContain('implementation');
    expect(node.parameters.supportedPhases).toContain('review');
    expect(node.parameters.supportedPhases).toContain('conflict_resolution');
    expect(node.parameters.supportedPhases).toContain('research');
  });

  test('GitHub Intake node has no command parameter (not an Execute Command node)', () => {
    expect(node.parameters.command).toBeUndefined();
  });

  test('GitHub Intake node has no CLI path in parameters', () => {
    const paramValues = JSON.stringify(node.parameters);
    expect(paramValues).not.toContain(CANONICAL_CLI_BASE);
  });

  test('GitHub Intake uses typeVersion 1', () => {
    expect(node.typeVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow child — Run One Phase operation wiring (Slice 4)
// ---------------------------------------------------------------------------

describe('buildPrivateNodeChildWorkflow — Run One Phase operation wiring', () => {
  const wf = buildPrivateNodeChildWorkflow();
  const node = wf.nodes.find((n) => n.id === 'run-one-phase');

  test('Run One Phase node exists', () => {
    expect(node).toBeDefined();
    expect(node.name).toBe('Run One Phase');
  });

  test('Run One Phase uses the private node type, not executeCommand', () => {
    expect(node.type).toBe(PRIVATE_NODE_TYPE);
    expect(node.type).not.toBe('n8n-nodes-base.executeCommand');
  });

  test('Run One Phase operation parameter is runOnePhase', () => {
    expect(node.parameters.operation).toBe('runOnePhase');
  });

  test('Run One Phase contextId references the trigger node', () => {
    expect(node.parameters.contextId).toContain('$("When Called by Parent").first().json.contextId');
  });

  test('Run One Phase contextId is an n8n expression', () => {
    expect(node.parameters.contextId.startsWith('=')).toBe(true);
  });

  test('Run One Phase runId includes $execution.id with millisecond fallback', () => {
    expect(node.parameters.runId).toBeDefined();
    expect(node.parameters.runId.startsWith('=')).toBe(true);
    expect(node.parameters.runId).toContain('$execution.id');
    expect(node.parameters.runId).toContain('$now.toMillis()');
  });

  test('Run One Phase has baked-in supportedPhases covering all phases', () => {
    expect(node.parameters.supportedPhases).toBeDefined();
    expect(node.parameters.supportedPhases).toContain('implementation');
    expect(node.parameters.supportedPhases).toContain('review');
    expect(node.parameters.supportedPhases).toContain('conflict_resolution');
    expect(node.parameters.supportedPhases).toContain('research');
  });

  test('Run One Phase node has no command parameter (not an Execute Command node)', () => {
    expect(node.parameters.command).toBeUndefined();
  });

  test('Run One Phase node has no CLI path in parameters', () => {
    const paramValues = JSON.stringify(node.parameters);
    expect(paramValues).not.toContain(CANONICAL_CLI_BASE);
  });

  test('Run One Phase uses typeVersion 1', () => {
    expect(node.typeVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow child — connections
// ---------------------------------------------------------------------------

describe('buildPrivateNodeChildWorkflow connections', () => {
  const wf = buildPrivateNodeChildWorkflow();

  test('When Called by Parent connects to GitHub Intake', () => {
    expect(wf.connections['When Called by Parent'].main[0][0].node).toBe('GitHub Intake');
  });

  test('GitHub Intake connects to Run One Phase', () => {
    expect(wf.connections['GitHub Intake'].main[0][0].node).toBe('Run One Phase');
  });

  test('Run One Phase connects to Dispatch Outbox', () => {
    expect(wf.connections['Run One Phase'].main[0][0].node).toBe('Dispatch Outbox');
  });

  test('Dispatch Outbox connects to Return Context', () => {
    expect(wf.connections['Dispatch Outbox'].main[0][0].node).toBe('Return Context');
  });

  test('Return Context has no outgoing connections', () => {
    expect(wf.connections['Return Context']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow child — no Execute Command nodes remain (Slice 4 complete)
// ---------------------------------------------------------------------------

describe('buildPrivateNodeChildWorkflow — no Execute Command nodes after Slice 4', () => {
  test('no Execute Command nodes exist (cliBase option is silently accepted but unused)', () => {
    const wf = buildPrivateNodeChildWorkflow({ cliBase: CANONICAL_CLI_BASE });
    const execNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeCommand');
    expect(execNodes).toHaveLength(0);
  });

  test('no private-node operation parameters contain any CLI path', () => {
    const wf = buildPrivateNodeChildWorkflow({ cliBase: CANONICAL_CLI_BASE });
    const privateNodes = wf.nodes.filter((n) => n.type === PRIVATE_NODE_TYPE);
    for (const node of privateNodes) {
      const paramValues = JSON.stringify(node.parameters);
      expect(paramValues).not.toContain(CANONICAL_CLI_BASE);
    }
  });

  test('private-node Dispatch Outbox node has no CLI path in parameters', () => {
    const wf = buildPrivateNodeChildWorkflow({ cliBase: CANONICAL_CLI_BASE });
    const node = wf.nodes.find((n) => n.id === 'dispatch-outbox');
    const paramValues = JSON.stringify(node.parameters);
    expect(paramValues).not.toContain(CANONICAL_CLI_BASE);
  });

  test('private-node Run One Phase node has no CLI path in parameters', () => {
    const wf = buildPrivateNodeChildWorkflow({ cliBase: CANONICAL_CLI_BASE });
    const node = wf.nodes.find((n) => n.id === 'run-one-phase');
    const paramValues = JSON.stringify(node.parameters);
    expect(paramValues).not.toContain(CANONICAL_CLI_BASE);
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow parent workflow — stability
// ---------------------------------------------------------------------------

test('checked-in private-node parent workflow JSON matches canonical generator output', () => {
  const checkedIn = readFileSync(privateNodeParentPath, 'utf8');
  const generated =
    JSON.stringify(buildPrivateNodeParentWorkflow({ sessionRef: CANONICAL_SESSION_ID }), null, 2) +
    '\n';
  expect(checkedIn).toBe(generated);
});

test('checked-in private-node parent workflow JSON is environment-independent (no CLI_BASE in workflow)', () => {
  const MOCK_LOCAL_CLI_BASE = '/home/operator/local-checkout/dist/cli';
  expect(MOCK_LOCAL_CLI_BASE).not.toBe(CANONICAL_CLI_BASE);
  const checkedIn = readFileSync(privateNodeParentPath, 'utf8');
  // Private node operations resolve CLI path at runtime — no CLI_BASE in workflow JSON.
  expect(checkedIn).not.toContain(CANONICAL_CLI_BASE);
  expect(checkedIn).not.toContain(MOCK_LOCAL_CLI_BASE);
  expect(checkedIn).not.toMatch(/\/(?:Users|home)\/[^"']*\/dist\/cli/);
});

// ---------------------------------------------------------------------------
// Private-node shadow parent workflow — structure
// ---------------------------------------------------------------------------

describe('buildPrivateNodeParentWorkflow structure', () => {
  const wf = buildPrivateNodeParentWorkflow();

  test('has a non-empty name', () => {
    expect(typeof wf.name).toBe('string');
    expect(wf.name.length).toBeGreaterThan(0);
  });

  test('name indicates shadow/test-only status', () => {
    expect(wf.name).toContain('SHADOW TEST');
  });

  test('has exactly 10 nodes: 2 triggers + Config + Create Context + Acquire Repo Lock + IF Locked + Call Phase Runner + Release Repo Lock + Release Repo Lock on Error + Stop and Error', () => {
    expect(wf.nodes).toHaveLength(10);
  });

  test('workflow ID matches PRIVATE_NODE_PARENT_WORKFLOW_ID constant', () => {
    expect(wf.id).toBe(PRIVATE_NODE_PARENT_WORKFLOW_ID);
  });

  test('PRIVATE_NODE_PARENT_WORKFLOW_ID differs from the Execute Command parent ID (coexistence)', () => {
    const execParent = buildParentWorkflow();
    expect(PRIVATE_NODE_PARENT_WORKFLOW_ID).not.toBe(execParent.id);
  });

  test('has a Manual Trigger node', () => {
    const node = wf.nodes.find((n) => n.type === 'n8n-nodes-base.manualTrigger');
    expect(node).toBeDefined();
  });

  test('has a Schedule Trigger node', () => {
    const node = wf.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger');
    expect(node).toBeDefined();
  });

  test('has a Config (Set) node', () => {
    const node = wf.nodes.find((n) => n.id === 'workflow-config');
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.set');
    expect(node.name).toBe('Config');
  });

  test('has no Execute Command nodes (all 4 parent operations are private node)', () => {
    const nodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeCommand');
    expect(nodes).toHaveLength(0);
  });

  test('has exactly 4 private node operations (Create Context, Acquire Repo Lock, Release Repo Lock, Release Repo Lock on Error)', () => {
    const nodes = wf.nodes.filter((n) => n.type === PRIVATE_NODE_TYPE);
    expect(nodes).toHaveLength(4);
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain('create-context');
    expect(ids).toContain('acquire-repo-lock');
    expect(ids).toContain('release-repo-lock');
    expect(ids).toContain('release-repo-lock-err');
  });

  test('has an IF Locked node', () => {
    const node = wf.nodes.find((n) => n.id === 'if-locked');
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.if');
    expect(node.name).toBe('IF Locked');
  });

  test('has a Call Phase Runner node', () => {
    const node = wf.nodes.find((n) => n.id === 'call-phase-runner');
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.executeWorkflow');
  });

  test('has a Stop and Error node', () => {
    const node = wf.nodes.find((n) => n.id === 'stop-and-error');
    expect(node).toBeDefined();
    expect(node.type).toBe('n8n-nodes-base.stopAndError');
  });

  test('each node has an id, name, type, and position', () => {
    for (const node of wf.nodes) {
      expect(typeof node.id).toBe('string');
      expect(node.id.length).toBeGreaterThan(0);
      expect(typeof node.name).toBe('string');
      expect(typeof node.type).toBe('string');
      expect(Array.isArray(node.position)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow parent — Create Context operation wiring
// ---------------------------------------------------------------------------

describe('buildPrivateNodeParentWorkflow — Create Context operation wiring', () => {
  const wf = buildPrivateNodeParentWorkflow();
  const node = wf.nodes.find((n) => n.id === 'create-context');

  test('Create Context node exists and uses the private node type', () => {
    expect(node).toBeDefined();
    expect(node.name).toBe('Create Context');
    expect(node.type).toBe(PRIVATE_NODE_TYPE);
    expect(node.type).not.toBe('n8n-nodes-base.executeCommand');
  });

  test('operation parameter is createContext', () => {
    expect(node.parameters.operation).toBe('createContext');
  });

  test('executionId parameter is an n8n expression using $execution.id', () => {
    expect(node.parameters.executionId).toBeDefined();
    expect(node.parameters.executionId.startsWith('=')).toBe(true);
    expect(node.parameters.executionId).toContain('$execution.id');
  });

  test('sessionRef parameter reads from Config node', () => {
    expect(node.parameters.sessionRef).toBeDefined();
    expect(node.parameters.sessionRef.startsWith('=')).toBe(true);
    expect(node.parameters.sessionRef).toContain('$("Config").first().json.sessionRef');
  });

  test('has no command parameter (not an Execute Command node)', () => {
    expect(node.parameters.command).toBeUndefined();
  });

  test('has no CLI path in parameters (runtime resolution, not baked in)', () => {
    const paramValues = JSON.stringify(node.parameters);
    expect(paramValues).not.toContain(CANONICAL_CLI_BASE);
  });

  test('uses typeVersion 1', () => {
    expect(node.typeVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow parent — Acquire Repo Lock operation wiring
// ---------------------------------------------------------------------------

describe('buildPrivateNodeParentWorkflow — Acquire Repo Lock operation wiring', () => {
  const wf = buildPrivateNodeParentWorkflow();
  const node = wf.nodes.find((n) => n.id === 'acquire-repo-lock');

  test('Acquire Repo Lock node exists and uses the private node type', () => {
    expect(node).toBeDefined();
    expect(node.name).toBe('Acquire Repo Lock');
    expect(node.type).toBe(PRIVATE_NODE_TYPE);
    expect(node.type).not.toBe('n8n-nodes-base.executeCommand');
  });

  test('operation parameter is acquireRepoLock', () => {
    expect(node.parameters.operation).toBe('acquireRepoLock');
  });

  test('contextId reads directly from Create Context output (no JSON.parse of stdout)', () => {
    expect(node.parameters.contextId).toBeDefined();
    expect(node.parameters.contextId.startsWith('=')).toBe(true);
    expect(node.parameters.contextId).toContain('$("Create Context").first().json.contextId');
    expect(node.parameters.contextId).not.toContain('JSON.parse');
    expect(node.parameters.contextId).not.toContain('.stdout');
  });

  test('has no command parameter (not an Execute Command node)', () => {
    expect(node.parameters.command).toBeUndefined();
  });

  test('uses typeVersion 1', () => {
    expect(node.typeVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow parent — IF Locked node (reads private node output)
// ---------------------------------------------------------------------------

describe('buildPrivateNodeParentWorkflow — IF Locked node', () => {
  const wf = buildPrivateNodeParentWorkflow();
  const node = wf.nodes.find((n) => n.id === 'if-locked');

  test('IF Locked condition checks json.locked directly (no JSON.parse of stdout)', () => {
    const conditions = node.parameters.conditions.conditions;
    expect(conditions).toHaveLength(1);
    expect(conditions[0].leftValue).toContain('$("Acquire Repo Lock").first().json.locked');
    expect(conditions[0].leftValue).not.toContain('JSON.parse');
    expect(conditions[0].leftValue).not.toContain('.stdout');
  });

  test('condition uses boolean true operator', () => {
    const op = node.parameters.conditions.conditions[0].operator;
    expect(op).toMatchObject({ type: 'boolean', operation: 'true' });
  });

  test('uses typeVersion 2', () => {
    expect(node.typeVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow parent — Call Phase Runner node
// ---------------------------------------------------------------------------

describe('buildPrivateNodeParentWorkflow — Call Phase Runner node', () => {
  const wf = buildPrivateNodeParentWorkflow();
  const node = wf.nodes.find((n) => n.id === 'call-phase-runner');

  test('references the private-node child workflow ID', () => {
    expect(node.parameters.workflowId).toBe(PRIVATE_NODE_CHILD_WORKFLOW_ID);
  });

  test('does not reference the Execute Command child workflow ID', () => {
    expect(node.parameters.workflowId).not.toBe(CHILD_WORKFLOW_ID);
  });

  test('passes contextId via direct json.contextId (no JSON.parse of stdout)', () => {
    const expr = node.parameters.workflowInputs.value.contextId;
    expect(expr).toBeDefined();
    expect(expr).toContain('$("Create Context").first().json.contextId');
    expect(expr).not.toContain('JSON.parse');
    expect(expr).not.toContain('.stdout');
  });

  test('has onError:continueErrorOutput so error path releases lock then fails parent', () => {
    expect(node.onError).toBe('continueErrorOutput');
  });

  test('uses typeVersion 1.3', () => {
    expect(node.typeVersion).toBe(1.3);
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow parent — Release Repo Lock (success path)
// ---------------------------------------------------------------------------

describe('buildPrivateNodeParentWorkflow — Release Repo Lock operation wiring', () => {
  const wf = buildPrivateNodeParentWorkflow();
  const node = wf.nodes.find((n) => n.id === 'release-repo-lock');

  test('Release Repo Lock node exists and uses the private node type', () => {
    expect(node).toBeDefined();
    expect(node.name).toBe('Release Repo Lock');
    expect(node.type).toBe(PRIVATE_NODE_TYPE);
    expect(node.type).not.toBe('n8n-nodes-base.executeCommand');
  });

  test('operation parameter is releaseRepoLock', () => {
    expect(node.parameters.operation).toBe('releaseRepoLock');
  });

  test('contextId reads directly from Create Context output (no JSON.parse of stdout)', () => {
    expect(node.parameters.contextId).toBeDefined();
    expect(node.parameters.contextId.startsWith('=')).toBe(true);
    expect(node.parameters.contextId).toContain('$("Create Context").first().json.contextId');
    expect(node.parameters.contextId).not.toContain('JSON.parse');
    expect(node.parameters.contextId).not.toContain('.stdout');
  });

  test('has no command parameter (not an Execute Command node)', () => {
    expect(node.parameters.command).toBeUndefined();
  });

  test('uses typeVersion 1', () => {
    expect(node.typeVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow parent — Release Repo Lock on Error (error path)
// ---------------------------------------------------------------------------

describe('buildPrivateNodeParentWorkflow — Release Repo Lock on Error operation wiring', () => {
  const wf = buildPrivateNodeParentWorkflow();
  const node = wf.nodes.find((n) => n.id === 'release-repo-lock-err');

  test('Release Repo Lock on Error node exists and uses the private node type', () => {
    expect(node).toBeDefined();
    expect(node.name).toBe('Release Repo Lock on Error');
    expect(node.type).toBe(PRIVATE_NODE_TYPE);
    expect(node.type).not.toBe('n8n-nodes-base.executeCommand');
  });

  test('operation parameter is releaseRepoLock (same operation as success path)', () => {
    expect(node.parameters.operation).toBe('releaseRepoLock');
  });

  test('contextId reads directly from Create Context output (no JSON.parse of stdout)', () => {
    expect(node.parameters.contextId).toBeDefined();
    expect(node.parameters.contextId.startsWith('=')).toBe(true);
    expect(node.parameters.contextId).toContain('$("Create Context").first().json.contextId');
    expect(node.parameters.contextId).not.toContain('JSON.parse');
    expect(node.parameters.contextId).not.toContain('.stdout');
  });

  test('has no command parameter (not an Execute Command node)', () => {
    expect(node.parameters.command).toBeUndefined();
  });

  test('uses typeVersion 1', () => {
    expect(node.typeVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow parent — both lock-release paths are private node
// (constraint: do not leave Release Repo Lock on Error as Execute Command)
// ---------------------------------------------------------------------------

describe('buildPrivateNodeParentWorkflow — both lock-release paths use private node', () => {
  const wf = buildPrivateNodeParentWorkflow();

  test('success-path Release Repo Lock is not an Execute Command node', () => {
    const node = wf.nodes.find((n) => n.id === 'release-repo-lock');
    expect(node.type).toBe(PRIVATE_NODE_TYPE);
    expect(node.type).not.toBe('n8n-nodes-base.executeCommand');
  });

  test('error-path Release Repo Lock on Error is not an Execute Command node', () => {
    const node = wf.nodes.find((n) => n.id === 'release-repo-lock-err');
    expect(node.type).toBe(PRIVATE_NODE_TYPE);
    expect(node.type).not.toBe('n8n-nodes-base.executeCommand');
  });

  test('both lock-release nodes have the same releaseRepoLock operation', () => {
    const successNode = wf.nodes.find((n) => n.id === 'release-repo-lock');
    const errorNode = wf.nodes.find((n) => n.id === 'release-repo-lock-err');
    expect(successNode.parameters.operation).toBe('releaseRepoLock');
    expect(errorNode.parameters.operation).toBe('releaseRepoLock');
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow parent — connections
// ---------------------------------------------------------------------------

describe('buildPrivateNodeParentWorkflow connections', () => {
  const wf = buildPrivateNodeParentWorkflow();

  test('Manual Trigger connects to Config', () => {
    expect(wf.connections['Manual Trigger'].main[0][0].node).toBe('Config');
  });

  test('Schedule Trigger connects to Config', () => {
    expect(wf.connections['Schedule Trigger'].main[0][0].node).toBe('Config');
  });

  test('Config connects to Create Context', () => {
    expect(wf.connections['Config'].main[0][0].node).toBe('Create Context');
  });

  test('Create Context connects to Acquire Repo Lock', () => {
    expect(wf.connections['Create Context'].main[0][0].node).toBe('Acquire Repo Lock');
  });

  test('Acquire Repo Lock connects to IF Locked', () => {
    expect(wf.connections['Acquire Repo Lock'].main[0][0].node).toBe('IF Locked');
  });

  test('IF Locked true-branch (index 0) connects to Call Phase Runner', () => {
    expect(wf.connections['IF Locked'].main[0][0].node).toBe('Call Phase Runner');
  });

  test('IF Locked false-branch (index 1) has no connections (no-op end)', () => {
    expect(wf.connections['IF Locked'].main[1]).toEqual([]);
  });

  test('Call Phase Runner success-path (output 0) connects to Release Repo Lock', () => {
    expect(wf.connections['Call Phase Runner'].main[0][0].node).toBe('Release Repo Lock');
  });

  test('Call Phase Runner error-path (output 1) connects to Release Repo Lock on Error', () => {
    expect(wf.connections['Call Phase Runner'].main[1][0].node).toBe('Release Repo Lock on Error');
  });

  test('Release Repo Lock on Error connects to Stop and Error', () => {
    expect(wf.connections['Release Repo Lock on Error'].main[0][0].node).toBe('Stop and Error');
  });

  test('Release Repo Lock has no outgoing connections', () => {
    expect(wf.connections['Release Repo Lock']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Private-node shadow parent — sessionRef config
// ---------------------------------------------------------------------------

describe('buildPrivateNodeParentWorkflow — Config node sessionRef', () => {
  function sessionRefValue(wf) {
    const cfg = wf.nodes.find((n) => n.id === 'workflow-config');
    return cfg.parameters.assignments.assignments.find((a) => a.name === 'sessionRef').value;
  }

  test('sessionRef defaults to ai-cli-loop', () => {
    expect(sessionRefValue(buildPrivateNodeParentWorkflow())).toBe('ai-cli-loop');
  });

  test('explicit sessionRef option is baked into the Config node', () => {
    expect(sessionRefValue(buildPrivateNodeParentWorkflow({ sessionRef: CANONICAL_SESSION_ID }))).toBe(
      CANONICAL_SESSION_ID
    );
  });

  test('explicit sessionRef option overrides the no-arg default', () => {
    const customRef = 'operator-session';
    expect(sessionRefValue(buildPrivateNodeParentWorkflow({ sessionRef: customRef }))).toBe(customRef);
  });
});

// ---------------------------------------------------------------------------
// n8n-node package skeleton — structure verification
// ---------------------------------------------------------------------------

describe('n8n-node package skeleton', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'n8n-node/package.json'), 'utf8'));

  test('package name is n8n-nodes-ai-cli-loop', () => {
    expect(pkg.name).toBe('n8n-nodes-ai-cli-loop');
  });

  test('package registers the AiCliLoop node in the n8n field', () => {
    expect(Array.isArray(pkg.n8n?.nodes)).toBe(true);
    expect(pkg.n8n.nodes).toContain('dist/AiCliLoop.node.js');
  });

  test('package has n8n-workflow peer dependency', () => {
    expect(pkg.peerDependencies?.['n8n-workflow']).toBeDefined();
  });

  test('package has n8n-workflow dev dependency for compilation', () => {
    expect(pkg.devDependencies?.['n8n-workflow']).toBeDefined();
  });

  test('n8nNodesApiVersion is 1', () => {
    expect(pkg.n8n?.n8nNodesApiVersion).toBe(1);
  });

  test('n8n-node TypeScript compiles — dist/AiCliLoop.node.js exists after build', () => {
    // pretest runs `npm run build` which includes `build:n8n-node` (tsc in n8n-node/).
    // If the TypeScript has a type or syntax error this file will not be present.
    const distFile = resolve(repoRoot, 'n8n-node/dist/AiCliLoop.node.js');
    expect(existsSync(distFile)).toBe(true);
  });
});
