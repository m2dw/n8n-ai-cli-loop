/**
 * build-parent-child-workflow.mjs
 *
 * Generates two n8n workflow JSONs that replace the monolithic thin workflow
 * with a parent/child split.
 *
 * Two roles, two destinations (issue #391):
 *
 *   docs/                      — tracked, stable template/sample.  Always baked
 *                                with CANONICAL_CLI_BASE so the committed JSON is
 *                                environment-independent and never dirties the
 *                                repo with a machine-specific path.
 *   .n8n-artifacts/workflows/  — gitignored local deployment artifact.  Baked
 *                                with the operator's resolved CLI_BASE (env var
 *                                or <cwd>/dist/cli) — this is what you import for
 *                                a local deployment.
 *
 *   *-parent-workflow.json  — orchestrator
 *   *-child-workflow.json   — phase runner (called by parent)
 *
 * Parent (5 nodes):
 *   Triggers → Config → Create Context → Call Phase Runner
 *
 * Child (5 nodes):
 *   When Called by Parent → GitHub Intake → Run One Phase → Dispatch Outbox → Return Context
 *
 * The parent passes the Config item (containing sessionId) to the child trigger.
 * The child reads sessionId directly from the trigger payload via
 * $("When Called by Parent").first().json.sessionId in all three Execute Command
 * nodes so $json overwrite after each command is never a problem.  runId is
 * inlined as $execution.id (with millisecond fallback) in the run-one-phase
 * command expression.
 *
 * The child workflow ID ('ai-dev-loop-thin-phase-runner') must match the
 * workflowId in the parent's Call Phase Runner node.  Import the child first
 * so n8n registers its ID before the parent resolves it.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

// ---------------------------------------------------------------------------
// Configuration — values baked into generated command strings at generation
// time.  Override with env vars and re-run to regenerate:
//
//   CLI_BASE=/path/to/dist/cli SESSION_ID=my-session npm run build:parent-child-workflow
//
// If CLI_BASE is omitted it defaults to path.resolve(process.cwd(), "dist/cli")
// at build time.  Run the build command from the tree n8n should execute so
// the baked-in path points at the correct installation.
// ---------------------------------------------------------------------------

// SESSION_REF is the compact, operator-facing reference baked into the parent
// Config node — an n8n tag / Config value such as a sessionId, a numeric
// sessionNo (e.g. 2), or an alias (e.g. addon).  `admin.js context create`
// resolves it to the canonical sessionId via sessions.json, so only the short
// value lives in the workflow.  SESSION_ID is accepted as a backward-compatible
// fallback (a sessionId is itself a valid reference).
const SESSION_REF = process.env['SESSION_REF'] ?? process.env['SESSION_ID'] ?? 'ai-cli-loop';
const SUPPORTED_PHASES = 'implementation,review,conflict_resolution,research';
const SCHEDULE_MINUTES = 5;

// Canonical, environment-independent sessionRef baked into the tracked docs/
// template.  Operator-supplied SESSION_REF / SESSION_ID seed only the local
// deployment artifact; they must never dirty the checked-in template.
export const CANONICAL_SESSION_REF = 'ai-cli-loop';

// Canonical CLI_BASE baked into the tracked docs/ workflow JSONs.
// The CLI entrypoint always uses this for the docs/ template so the checked-in
// artifacts are environment-independent and never carry a machine-specific path.
// The local deployment artifacts under .n8n-artifacts/workflows/ use the
// operator's resolved CLI_BASE (env var or <cwd>/dist/cli) instead.
export const CANONICAL_CLI_BASE = '/opt/n8n-ai-cli-loop/dist/cli';

// Resolve the CLI_BASE for the local deployment artifacts: an explicit CLI_BASE
// env var, otherwise <cwd>/dist/cli.  Run the build from the tree n8n should
// execute so the baked-in path points at the correct installation.
export function resolveLocalCliBase() {
  return process.env['CLI_BASE'] ?? resolve(process.cwd(), 'dist/cli');
}

// The child workflow's n8n ID.  The parent's Call Phase Runner node references
// this exact string.  Import the child workflow first when setting up n8n so
// the ID is registered before the parent resolves it.
export const CHILD_WORKFLOW_ID = 'ai-dev-loop-thin-phase-runner';

// The private-node shadow child workflow ID.  Distinct from CHILD_WORKFLOW_ID
// so both workflows can coexist in the same n8n instance during shadow testing.
// Switch production to the private-node path by updating the workflowId in the
// parent's Call Phase Runner node — a single-field edit, not a re-import.
export const PRIVATE_NODE_CHILD_WORKFLOW_ID = 'ai-dev-loop-private-node-phase-runner';

// The private-node shadow parent workflow ID.  Distinct from the Execute Command
// parent so both can coexist during shadow testing.  The private-node parent
// pairs with the private-node child: its Call Phase Runner references
// PRIVATE_NODE_CHILD_WORKFLOW_ID and its context/lock operations are all
// private-node typed — no executeCommand nodes.
export const PRIVATE_NODE_PARENT_WORKFLOW_ID = 'ai-dev-loop-private-node-parent';

// The n8n node type identifier used in workflows for the private node.
// n8n assigns the 'CUSTOM.' prefix when a node is loaded via N8N_CUSTOM_EXTENSIONS;
// the implementation's description.name ('aiCliLoop') becomes the suffix.
// Loading via ~/.n8n/custom/node_modules would use 'n8n-nodes-ai-cli-loop.aiCliLoop'
// instead — a different type string that causes n8n to show '?' for the node.
export const PRIVATE_NODE_TYPE = 'CUSTOM.aiCliLoop';

// ---------------------------------------------------------------------------
// Node positions
// ---------------------------------------------------------------------------

const Y = 240;
const Y_MANUAL = 160;
const Y_SCHEDULE = 320;

// Parent x-positions (left to right) — 8-node chain
// Triggers → Config → Create Context → Acquire Repo Lock → IF Locked
//   true → Call Phase Runner → Release Repo Lock
//   false → (end)
const PX_TRIGGER = -1000;
const PX_CONFIG = -720;
const PX_CREATE_CONTEXT = -440;
const PX_ACQUIRE_LOCK = -160;
const PX_IF_LOCKED = 120;
const PX_CALL_CHILD = 400;
const PX_RELEASE_LOCK = 680;
const PX_STOP_ERROR = 960;

// Y for the error-path nodes (below the main path at Y=240)
const Y_ERROR = 400;

// Child x-positions — 5-node chain
const CX_TRIGGER = -560;
const CX_INTAKE = -280;
const CX_RUN = 0;
const CX_DISPATCH = 280;
const CX_RETURN = 560;

// ---------------------------------------------------------------------------
// Shell-escape helper
// ---------------------------------------------------------------------------

// Escape a filesystem path for safe embedding in an n8n Execute Command expression.
//
// n8n expressions are double-quoted JavaScript strings; the result of JS evaluation
// is then executed as a POSIX shell command.  Two escaping layers are needed:
//
//   JS string layer (applied first):
//     \  →  \\   so the JS evaluator passes a single backslash to the shell
//     "  →  \"   so the double quote doesn't terminate the JS string early
//
//   Shell single-quote layer (applied second, to the JS-escaped value):
//     '  →  '\''  end-quote, literal-quote, reopen-quote
//     Because the result is still inside the JS double-quoted string, the
//     backslash in '\'' must be doubled: '\\'' in the stored expression
//     → '\'' after JS evaluation → correct POSIX escape for the shell.
function shellescape(s) {
  return s
    .replace(/\\/g, '\\\\')    // \ → \\  (JS string layer)
    .replace(/"/g, '\\"')      // " → \"  (JS string layer)
    .replace(/'/g, "'\\\\''"); // ' → '\'' (POSIX shell single-quote layer)
}

// ---------------------------------------------------------------------------
// Parent workflow
// ---------------------------------------------------------------------------

// `options.cliBase` selects the path baked into the Execute Command nodes.
// When omitted it falls back to the operator's resolved local CLI_BASE so
// existing no-arg callers keep their behaviour; the docs/ template build passes
// CANONICAL_CLI_BASE explicitly for an environment-independent artifact.
//
// `options.sessionRef` selects the value baked into the Config node.  When
// omitted it falls back to the operator's SESSION_REF; the docs/ template build
// passes CANONICAL_SESSION_REF so session env vars never dirty the template.
export function buildParentWorkflow(options = {}) {
  const cliBase = options.cliBase ?? resolveLocalCliBase();
  const cliBaseEsc = shellescape(cliBase);
  const sessionRef = options.sessionRef ?? SESSION_REF;
  const nodes = [
    {
      id: 'manual-trigger',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      position: [PX_TRIGGER, Y_MANUAL],
      parameters: {},
      typeVersion: 1,
    },
    {
      id: 'schedule-trigger',
      name: 'Schedule Trigger',
      type: 'n8n-nodes-base.scheduleTrigger',
      position: [PX_TRIGGER, Y_SCHEDULE],
      parameters: {
        rule: {
          interval: [{ field: 'minutes', minutesInterval: SCHEDULE_MINUTES }],
        },
      },
      typeVersion: 1,
    },
    // Config holds the compact sessionRef as an editable field — a short n8n
    // tag / Config value (sessionId, sessionNo, or alias).  Create Context
    // resolves it to the canonical sessionId; the child workflow only ever
    // receives --context-id, so no sessionId/sessionRef is forwarded downstream.
    {
      id: 'workflow-config',
      name: 'Config',
      type: 'n8n-nodes-base.set',
      position: [PX_CONFIG, Y],
      parameters: {
        mode: 'manual',
        duplicateItem: false,
        assignments: {
          assignments: [
            {
              id: 'cfg-session-ref',
              name: 'sessionRef',
              value: sessionRef,
              type: 'string',
            },
            {
              id: 'cfg-repo-key-ref',
              name: 'repoKeyReference',
              value: '(resolved from sessions.json by sessionId)',
              type: 'string',
            },
            {
              id: 'cfg-repo-root-ref',
              name: 'repoRootReference',
              value: '(resolved from sessions.json by sessionId)',
              type: 'string',
            },
            {
              id: 'cfg-github-repo-ref',
              name: 'githubRepoReference',
              value: '(resolved from sessions.json by sessionId)',
              type: 'string',
            },
          ],
        },
        options: {},
      },
      typeVersion: 3,
    },
    // Create Context captures the parent execution ID as contextId so the child
    // can use it for --context-id tracing.  Using a dedicated Execute Command
    // node ensures $execution.id is evaluated in a well-defined node context
    // rather than inside workflowInputs value mapping.
    {
      id: 'create-context',
      name: 'Create Context',
      type: 'n8n-nodes-base.executeCommand',
      position: [PX_CREATE_CONTEXT, Y],
      parameters: {
        // sessionRef is operator-configured (Config) and may contain whitespace
        // or shell metacharacters, so it is single-quoted in the runtime shell
        // command (with embedded single quotes escaped) before admin.js resolves
        // it. Without this the shell would split/interpret the value first.
        // --json explicitly requests the machine-readable stdout contract
        // (issue #308). context create defaults to JSON today, but requesting it
        // explicitly keeps the downstream JSON.parse() stable if defaults ever
        // change.
        command: `={{ "node '${cliBaseEsc}/admin.js' context create --json --execution-id " + $execution.id + " --session-ref '" + String($("Config").first().json.sessionRef).replace(/'/g, "'\\\\''") + "'" }}`,
      },
      typeVersion: 1,
    },
    // Acquire Repo Lock prevents two concurrent parent executions from running
    // the child workflow against the same repo checkout at the same time.
    // The lock is scoped by session (resolved from contextId via the context store).
    // A contention result (locked:false) is a normal skip — not a workflow error.
    {
      id: 'acquire-repo-lock',
      name: 'Acquire Repo Lock',
      type: 'n8n-nodes-base.executeCommand',
      position: [PX_ACQUIRE_LOCK, Y],
      parameters: {
        command: `={{ "node '${cliBaseEsc}/admin.js' repo-lock acquire --json --context-id " + JSON.parse($("Create Context").first().json.stdout).contextId }}`,
      },
      typeVersion: 1,
    },
    // IF Locked branches on whether we actually acquired the lock.
    // true  (output 0) → proceed to Call Phase Runner
    // false (output 1) → end successfully as a no-op
    {
      id: 'if-locked',
      name: 'IF Locked',
      type: 'n8n-nodes-base.if',
      position: [PX_IF_LOCKED, Y],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [
            {
              id: 'lock-check',
              leftValue: `={{ JSON.parse($("Acquire Repo Lock").first().json.stdout).locked }}`,
              operator: { type: 'boolean', operation: 'true' },
            },
          ],
          combinator: 'and',
        },
      },
      typeVersion: 2,
    },
    // Call Phase Runner invokes the child workflow synchronously. n8n 2.8.x
    // exposes Execute Sub-workflow versions 1, 1.1, 1.2, and 1.3; version 1.3
    // supports workflowInputs without importing as an unknown custom node.
    // Only contextId is passed to the child; the child CLIs resolve sessionId
    // from the context store using contextId, so no sessionId forwarding is needed.
    // onError:continueErrorOutput routes child failures to output 1 (error path)
    // so the lock is still released but the parent is then failed by Stop and Error.
    {
      id: 'call-phase-runner',
      name: 'Call Phase Runner',
      type: 'n8n-nodes-base.executeWorkflow',
      position: [PX_CALL_CHILD, Y],
      onError: 'continueErrorOutput',
      parameters: {
        workflowId: CHILD_WORKFLOW_ID,
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            contextId: '={{ JSON.parse($("Create Context").first().json.stdout).contextId }}',
          },
        },
        options: {},
      },
      typeVersion: 1.3,
    },
    // Release Repo Lock runs on the success path (output 0 of Call Phase Runner).
    // contextId is read from Create Context (stable upstream reference).
    {
      id: 'release-repo-lock',
      name: 'Release Repo Lock',
      type: 'n8n-nodes-base.executeCommand',
      position: [PX_RELEASE_LOCK, Y],
      parameters: {
        command: `={{ "node '${cliBaseEsc}/admin.js' repo-lock release --json --context-id " + JSON.parse($("Create Context").first().json.stdout).contextId }}`,
      },
      typeVersion: 1,
    },
    // Release Repo Lock on Error runs on the error path (output 1 of Call Phase Runner)
    // so the lock is freed even when the child workflow fails.
    {
      id: 'release-repo-lock-err',
      name: 'Release Repo Lock on Error',
      type: 'n8n-nodes-base.executeCommand',
      position: [PX_RELEASE_LOCK, Y_ERROR],
      parameters: {
        command: `={{ "node '${cliBaseEsc}/admin.js' repo-lock release --json --context-id " + JSON.parse($("Create Context").first().json.stdout).contextId }}`,
      },
      typeVersion: 1,
    },
    // Stop and Error re-raises the child failure so n8n marks the parent execution
    // as failed rather than silently succeeding after lock release.
    {
      id: 'stop-and-error',
      name: 'Stop and Error',
      type: 'n8n-nodes-base.stopAndError',
      position: [PX_STOP_ERROR, Y_ERROR],
      parameters: {
        errorMessage: 'Child workflow (Phase Runner) reported a failure.',
      },
      typeVersion: 1,
    },
  ];

  const connections = {
    'Manual Trigger': {
      main: [[{ node: 'Config', type: 'main', index: 0 }]],
    },
    'Schedule Trigger': {
      main: [[{ node: 'Config', type: 'main', index: 0 }]],
    },
    'Config': {
      main: [[{ node: 'Create Context', type: 'main', index: 0 }]],
    },
    'Create Context': {
      main: [[{ node: 'Acquire Repo Lock', type: 'main', index: 0 }]],
    },
    'Acquire Repo Lock': {
      main: [[{ node: 'IF Locked', type: 'main', index: 0 }]],
    },
    // IF Locked true-branch (index 0) → Call Phase Runner
    // IF Locked false-branch (index 1) → (no connections, ends as no-op)
    'IF Locked': {
      main: [
        [{ node: 'Call Phase Runner', type: 'main', index: 0 }],
        [],
      ],
    },
    // Call Phase Runner output 0 (success) → Release Repo Lock
    // Call Phase Runner output 1 (error)   → Release Repo Lock on Error → Stop and Error
    'Call Phase Runner': {
      main: [
        [{ node: 'Release Repo Lock', type: 'main', index: 0 }],
        [{ node: 'Release Repo Lock on Error', type: 'main', index: 0 }],
      ],
    },
    'Release Repo Lock on Error': {
      main: [[{ node: 'Stop and Error', type: 'main', index: 0 }]],
    },
  };

  return {
    name: 'AI Dev Loop — Parent Workflow',
    nodes,
    pinData: {},
    connections,
    active: false,
    settings: { executionOrder: 'v1' },
    versionId: 'parent-v1',
    meta: { templateCredsSetupCompleted: true },
    id: 'ai-dev-loop-thin-parent',
    tags: [],
  };
}

// ---------------------------------------------------------------------------
// Child workflow
// ---------------------------------------------------------------------------

// See buildParentWorkflow for the `options.cliBase` contract.
export function buildChildWorkflow(options = {}) {
  const cliBase = options.cliBase ?? resolveLocalCliBase();
  const cliBaseEsc = shellescape(cliBase);
  const nodes = [
    // Receives contextId from the parent's Call Phase Runner node via the
    // explicit workflowInputs mapping defined in the parent (typeVersion 1.3).
    // All downstream commands use --context-id only; CLIs resolve sessionId
    // from the context store so sessionId never needs to cross the workflow boundary.
    {
      id: 'phase-runner-trigger',
      name: 'When Called by Parent',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      position: [CX_TRIGGER, Y],
      parameters: {},
      typeVersion: 1,
    },
    {
      id: 'github-intake',
      name: 'GitHub Intake',
      type: 'n8n-nodes-base.executeCommand',
      position: [CX_INTAKE, Y],
      parameters: {
        command: `={{ "node '${cliBaseEsc}/github-intake.js' --context-id " + $("When Called by Parent").first().json.contextId + " --supported-phases ${SUPPORTED_PHASES}" }}`,
      },
      typeVersion: 1,
    },
    {
      id: 'run-one-phase',
      name: 'Run One Phase',
      type: 'n8n-nodes-base.executeCommand',
      position: [CX_RUN, Y],
      parameters: {
        command: `={{ (function() { var rid = $execution.id || ("run-" + $now.toMillis()); return "node '${cliBaseEsc}/run-one-phase.js' --context-id " + $("When Called by Parent").first().json.contextId + " --run-id " + rid + " --supported-phases ${SUPPORTED_PHASES}"; })() }}`,
      },
      typeVersion: 1,
    },
    {
      id: 'dispatch-outbox',
      name: 'Dispatch Outbox',
      type: 'n8n-nodes-base.executeCommand',
      position: [CX_DISPATCH, Y],
      parameters: {
        command: `={{ "node '${cliBaseEsc}/dispatch-outbox.js' --context-id " + $("When Called by Parent").first().json.contextId }}`,
      },
      typeVersion: 1,
    },
    // Return Context passes only contextId back to the parent workflow so the
    // Execute Workflow node output is contextId-only.  Reading from the trigger
    // (not from $json) avoids inheriting Dispatch Outbox's stdout payload.
    {
      id: 'return-context',
      name: 'Return Context',
      type: 'n8n-nodes-base.set',
      position: [CX_RETURN, Y],
      parameters: {
        mode: 'manual',
        duplicateItem: false,
        assignments: {
          assignments: [
            {
              id: 'ret-context-id',
              name: 'contextId',
              value: '={{ $("When Called by Parent").first().json.contextId }}',
              type: 'string',
            },
          ],
        },
        options: {},
      },
      typeVersion: 3,
    },
  ];

  const connections = {
    'When Called by Parent': {
      main: [[{ node: 'GitHub Intake', type: 'main', index: 0 }]],
    },
    'GitHub Intake': {
      main: [[{ node: 'Run One Phase', type: 'main', index: 0 }]],
    },
    'Run One Phase': {
      main: [[{ node: 'Dispatch Outbox', type: 'main', index: 0 }]],
    },
    'Dispatch Outbox': {
      main: [[{ node: 'Return Context', type: 'main', index: 0 }]],
    },
  };

  return {
    name: 'AI Dev Loop — Phase Runner (Child)',
    nodes,
    pinData: {},
    connections,
    active: false,
    settings: { executionOrder: 'v1' },
    versionId: 'child-v1',
    meta: { templateCredsSetupCompleted: true },
    id: CHILD_WORKFLOW_ID,
    tags: [],
  };
}

// ---------------------------------------------------------------------------
// Private-node shadow child workflow
// ---------------------------------------------------------------------------

// Shadow child workflow that replaces all three Execute Command operations
// (GitHub Intake, Run One Phase, and Dispatch Outbox) with private
// n8n-nodes-ai-cli-loop operations.  No Execute Command nodes remain.
//
// The workflow is named "SHADOW TEST" and has a distinct ID so it can coexist
// with the Execute Command child in the same n8n instance.  It is NOT for
// production use until the shadow test checklist is complete.
//
// See `docs/private-node-distribution.md` for migration continuity rules and
// the shadow testing guide.
export function buildPrivateNodeChildWorkflow(options = {}) {
  const nodes = [
    // Same trigger as the Execute Command child — receives contextId from parent.
    {
      id: 'phase-runner-trigger',
      name: 'When Called by Parent',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      position: [CX_TRIGGER, Y],
      parameters: {},
      typeVersion: 1,
    },
    // GitHub Intake — private node operation (Slice 2 replacement).
    // contextId and supportedPhases are typed parameters; no shell-quoting or
    // CLI_BASE path needed in the workflow JSON.  The node resolves its CLI path
    // from the CLI_BASE environment variable or its own install location.
    {
      id: 'github-intake',
      name: 'GitHub Intake',
      type: PRIVATE_NODE_TYPE,
      position: [CX_INTAKE, Y],
      parameters: {
        operation: 'githubIntake',
        contextId: `={{ $("When Called by Parent").first().json.contextId }}`,
        supportedPhases: SUPPORTED_PHASES,
      },
      typeVersion: 1,
    },
    // Run One Phase — private node operation (Slice 4 replacement).
    // contextId, runId, and supportedPhases are typed parameters; no shell-quoting or
    // CLI_BASE path needed in the workflow JSON.  The node resolves its CLI path
    // from the CLI_BASE environment variable or its own install location.
    {
      id: 'run-one-phase',
      name: 'Run One Phase',
      type: PRIVATE_NODE_TYPE,
      position: [CX_RUN, Y],
      parameters: {
        operation: 'runOnePhase',
        contextId: `={{ $("When Called by Parent").first().json.contextId }}`,
        runId: `={{ $execution.id || ("run-" + $now.toMillis()) }}`,
        supportedPhases: SUPPORTED_PHASES,
      },
      typeVersion: 1,
    },
    // Dispatch Outbox — private node operation (Slice 1 replacement).
    // contextId is a typed parameter; no shell-quoting or CLI_BASE path needed
    // in the workflow JSON.  The node resolves its CLI path from the CLI_BASE
    // environment variable or its own install location.
    {
      id: 'dispatch-outbox',
      name: 'Dispatch Outbox',
      type: PRIVATE_NODE_TYPE,
      position: [CX_DISPATCH, Y],
      parameters: {
        operation: 'dispatchOutbox',
        contextId: `={{ $("When Called by Parent").first().json.contextId }}`,
      },
      typeVersion: 1,
    },
    // Return Context — same as Execute Command child.
    {
      id: 'return-context',
      name: 'Return Context',
      type: 'n8n-nodes-base.set',
      position: [CX_RETURN, Y],
      parameters: {
        mode: 'manual',
        duplicateItem: false,
        assignments: {
          assignments: [
            {
              id: 'ret-context-id',
              name: 'contextId',
              value: '={{ $("When Called by Parent").first().json.contextId }}',
              type: 'string',
            },
          ],
        },
        options: {},
      },
      typeVersion: 3,
    },
  ];

  const connections = {
    'When Called by Parent': {
      main: [[{ node: 'GitHub Intake', type: 'main', index: 0 }]],
    },
    'GitHub Intake': {
      main: [[{ node: 'Run One Phase', type: 'main', index: 0 }]],
    },
    'Run One Phase': {
      main: [[{ node: 'Dispatch Outbox', type: 'main', index: 0 }]],
    },
    'Dispatch Outbox': {
      main: [[{ node: 'Return Context', type: 'main', index: 0 }]],
    },
  };

  return {
    name: 'AI Dev Loop — Phase Runner (Private Node — SHADOW TEST)',
    nodes,
    pinData: {},
    connections,
    active: false,
    settings: { executionOrder: 'v1' },
    versionId: 'private-node-child-v1',
    meta: { templateCredsSetupCompleted: true },
    id: PRIVATE_NODE_CHILD_WORKFLOW_ID,
    tags: [],
  };
}

// ---------------------------------------------------------------------------
// Private-node shadow parent workflow
// ---------------------------------------------------------------------------

// Shadow parent workflow that replaces all four Execute Command nodes
// (Create Context, Acquire Repo Lock, Release Repo Lock, Release Repo Lock on
// Error) with private n8n-nodes-ai-cli-loop operations.  Config, IF Locked,
// Call Phase Runner, and Stop and Error remain standard n8n nodes.
//
// Key differences from the Execute Command parent:
//   - No cliBase option: private-node operations resolve the CLI path at runtime
//     via CLI_BASE env var or the node's install location.  The workflow JSON is
//     therefore fully environment-independent with no CLI path baked in.
//   - IF Locked reads json.locked directly (no JSON.parse of .stdout).
//   - Call Phase Runner reads contextId from json.contextId directly.
//   - Call Phase Runner references PRIVATE_NODE_CHILD_WORKFLOW_ID so the
//     private-node parent pairs with the private-node child.
//
// The workflow is named "SHADOW TEST" and uses a distinct ID so it can coexist
// with the Execute Command parent in the same n8n instance.  It is NOT for
// production use until the shadow test checklist is complete.
//
// See `docs/private-node-distribution.md` for migration continuity rules and
// the shadow testing guide.
export function buildPrivateNodeParentWorkflow(options = {}) {
  const sessionRef = options.sessionRef ?? SESSION_REF;
  const nodes = [
    {
      id: 'manual-trigger',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      position: [PX_TRIGGER, Y_MANUAL],
      parameters: {},
      typeVersion: 1,
    },
    {
      id: 'schedule-trigger',
      name: 'Schedule Trigger',
      type: 'n8n-nodes-base.scheduleTrigger',
      position: [PX_TRIGGER, Y_SCHEDULE],
      parameters: {
        rule: {
          interval: [{ field: 'minutes', minutesInterval: SCHEDULE_MINUTES }],
        },
      },
      typeVersion: 1,
    },
    // Config holds the compact sessionRef as an editable field — same as the
    // Execute Command parent.  The private-node Create Context operation reads
    // sessionRef from this node via an n8n expression parameter.
    {
      id: 'workflow-config',
      name: 'Config',
      type: 'n8n-nodes-base.set',
      position: [PX_CONFIG, Y],
      parameters: {
        mode: 'manual',
        duplicateItem: false,
        assignments: {
          assignments: [
            {
              id: 'cfg-session-ref',
              name: 'sessionRef',
              value: sessionRef,
              type: 'string',
            },
            {
              id: 'cfg-repo-key-ref',
              name: 'repoKeyReference',
              value: '(resolved from sessions.json by sessionId)',
              type: 'string',
            },
            {
              id: 'cfg-repo-root-ref',
              name: 'repoRootReference',
              value: '(resolved from sessions.json by sessionId)',
              type: 'string',
            },
            {
              id: 'cfg-github-repo-ref',
              name: 'githubRepoReference',
              value: '(resolved from sessions.json by sessionId)',
              type: 'string',
            },
          ],
        },
        options: {},
      },
      typeVersion: 3,
    },
    // Create Context — private node operation.
    // executionId and sessionRef are typed parameters; the node calls
    // admin.js context create internally with safe argument handling.
    // Returns { contextId: "..." } directly (no .stdout intermediary).
    {
      id: 'create-context',
      name: 'Create Context',
      type: PRIVATE_NODE_TYPE,
      position: [PX_CREATE_CONTEXT, Y],
      parameters: {
        operation: 'createContext',
        executionId: `={{ $execution.id }}`,
        sessionRef: `={{ $("Config").first().json.sessionRef }}`,
      },
      typeVersion: 1,
    },
    // Acquire Repo Lock — private node operation.
    // contextId is a typed parameter read directly from Create Context output.
    // Returns { locked: true/false } directly (no .stdout intermediary).
    {
      id: 'acquire-repo-lock',
      name: 'Acquire Repo Lock',
      type: PRIVATE_NODE_TYPE,
      position: [PX_ACQUIRE_LOCK, Y],
      parameters: {
        operation: 'acquireRepoLock',
        contextId: `={{ $("Create Context").first().json.contextId }}`,
      },
      typeVersion: 1,
    },
    // IF Locked branches on the locked field returned directly by the
    // private-node Acquire Repo Lock operation (no JSON.parse needed).
    {
      id: 'if-locked',
      name: 'IF Locked',
      type: 'n8n-nodes-base.if',
      position: [PX_IF_LOCKED, Y],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [
            {
              id: 'lock-check',
              leftValue: `={{ $("Acquire Repo Lock").first().json.locked }}`,
              operator: { type: 'boolean', operation: 'true' },
            },
          ],
          combinator: 'and',
        },
      },
      typeVersion: 2,
    },
    // Call Phase Runner — invokes the private-node child workflow.
    // contextId is read directly from Create Context output (no JSON.parse).
    {
      id: 'call-phase-runner',
      name: 'Call Phase Runner',
      type: 'n8n-nodes-base.executeWorkflow',
      position: [PX_CALL_CHILD, Y],
      onError: 'continueErrorOutput',
      parameters: {
        workflowId: PRIVATE_NODE_CHILD_WORKFLOW_ID,
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            contextId: `={{ $("Create Context").first().json.contextId }}`,
          },
        },
        options: {},
      },
      typeVersion: 1.3,
    },
    // Release Repo Lock — private node operation (success path).
    {
      id: 'release-repo-lock',
      name: 'Release Repo Lock',
      type: PRIVATE_NODE_TYPE,
      position: [PX_RELEASE_LOCK, Y],
      parameters: {
        operation: 'releaseRepoLock',
        contextId: `={{ $("Create Context").first().json.contextId }}`,
      },
      typeVersion: 1,
    },
    // Release Repo Lock on Error — private node operation (error path).
    // Ensures the lock is freed when the child workflow fails, without
    // requiring executeCommand to be enabled.
    {
      id: 'release-repo-lock-err',
      name: 'Release Repo Lock on Error',
      type: PRIVATE_NODE_TYPE,
      position: [PX_RELEASE_LOCK, Y_ERROR],
      parameters: {
        operation: 'releaseRepoLock',
        contextId: `={{ $("Create Context").first().json.contextId }}`,
      },
      typeVersion: 1,
    },
    // Stop and Error re-raises the child failure — same as Execute Command parent.
    {
      id: 'stop-and-error',
      name: 'Stop and Error',
      type: 'n8n-nodes-base.stopAndError',
      position: [PX_STOP_ERROR, Y_ERROR],
      parameters: {
        errorMessage: 'Child workflow (Phase Runner) reported a failure.',
      },
      typeVersion: 1,
    },
  ];

  const connections = {
    'Manual Trigger': {
      main: [[{ node: 'Config', type: 'main', index: 0 }]],
    },
    'Schedule Trigger': {
      main: [[{ node: 'Config', type: 'main', index: 0 }]],
    },
    'Config': {
      main: [[{ node: 'Create Context', type: 'main', index: 0 }]],
    },
    'Create Context': {
      main: [[{ node: 'Acquire Repo Lock', type: 'main', index: 0 }]],
    },
    'Acquire Repo Lock': {
      main: [[{ node: 'IF Locked', type: 'main', index: 0 }]],
    },
    'IF Locked': {
      main: [
        [{ node: 'Call Phase Runner', type: 'main', index: 0 }],
        [],
      ],
    },
    'Call Phase Runner': {
      main: [
        [{ node: 'Release Repo Lock', type: 'main', index: 0 }],
        [{ node: 'Release Repo Lock on Error', type: 'main', index: 0 }],
      ],
    },
    'Release Repo Lock on Error': {
      main: [[{ node: 'Stop and Error', type: 'main', index: 0 }]],
    },
  };

  return {
    name: 'AI Dev Loop — Parent Workflow (Private Node — SHADOW TEST)',
    nodes,
    pinData: {},
    connections,
    active: false,
    settings: { executionOrder: 'v1' },
    versionId: 'private-node-parent-v1',
    meta: { templateCredsSetupCompleted: true },
    id: PRIVATE_NODE_PARENT_WORKFLOW_ID,
    tags: [],
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint — write tracked templates + local deployment artifacts
//
//   docs/                      stable template baked with CANONICAL_CLI_BASE
//                              (tracked; environment-independent; never dirtied
//                              by a local CLI_BASE)
//   .n8n-artifacts/workflows/  local deployment artifact baked with the resolved
//                              local CLI_BASE (gitignored; this is what you import
//                              for a local deployment)
// ---------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const docsDir = resolve(repoRoot, 'docs');
  const localDir = resolve(repoRoot, '.n8n-artifacts/workflows');

  const PARENT = 'n8n-thin-parent-workflow.json';
  const CHILD = 'n8n-thin-child-workflow.json';
  const PRIVATE_NODE_CHILD = 'n8n-thin-child-workflow-private-node.json';
  const PRIVATE_NODE_PARENT = 'n8n-thin-parent-workflow-private-node.json';

  // Tracked template — always canonical so the committed JSON is stable and
  // never carries the operator's CLI_BASE or SESSION_REF.
  const parentTemplate = buildParentWorkflow({
    cliBase: CANONICAL_CLI_BASE,
    sessionRef: CANONICAL_SESSION_REF,
  });
  const childTemplate = buildChildWorkflow({ cliBase: CANONICAL_CLI_BASE });
  const privateNodeChildTemplate = buildPrivateNodeChildWorkflow({ cliBase: CANONICAL_CLI_BASE });
  const privateNodeParentTemplate = buildPrivateNodeParentWorkflow({
    sessionRef: CANONICAL_SESSION_REF,
  });
  for (const [name, wf] of [
    [PARENT, parentTemplate],
    [CHILD, childTemplate],
    [PRIVATE_NODE_CHILD, privateNodeChildTemplate],
    [PRIVATE_NODE_PARENT, privateNodeParentTemplate],
  ]) {
    const path = resolve(docsDir, name);
    writeFileSync(path, JSON.stringify(wf, null, 2) + '\n');
    console.log(`Written (template, canonical CLI_BASE): ${path}`);
  }

  // Local deployment artifact — baked with the operator's resolved CLI_BASE and
  // SESSION_REF (the module-level default of buildParentWorkflow).
  const localCliBase = resolveLocalCliBase();
  mkdirSync(localDir, { recursive: true });
  const parentLocal = buildParentWorkflow({ cliBase: localCliBase });
  const childLocal = buildChildWorkflow({ cliBase: localCliBase });
  const privateNodeChildLocal = buildPrivateNodeChildWorkflow({ cliBase: localCliBase });
  const privateNodeParentLocal = buildPrivateNodeParentWorkflow();
  for (const [name, wf] of [
    [PARENT, parentLocal],
    [CHILD, childLocal],
    [PRIVATE_NODE_CHILD, privateNodeChildLocal],
    [PRIVATE_NODE_PARENT, privateNodeParentLocal],
  ]) {
    const path = resolve(localDir, name);
    writeFileSync(path, JSON.stringify(wf, null, 2) + '\n');
    console.log(`Written (local, CLI_BASE=${localCliBase}): ${path}`);
  }
}
