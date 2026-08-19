/**
 * build-parent-child-workflow.mjs
 *
 * Generates two n8n workflow JSONs that replace the monolithic thin workflow
 * with a parent/child split.
 *
 * Two roles, two destinations (issue #391):
 *
 *   docs/                      — tracked, stable template/sample.  Always baked
 *                                with CANONICAL_CLI_BASE and the generic parent
 *                                identity so the committed JSON is
 *                                environment-independent and never dirties the
 *                                repo with a machine-specific path.
 *   .n8n-artifacts/workflows/  — gitignored local deployment artifact.  Baked
 *                                with the operator's resolved CLI_BASE (env var
 *                                or <cwd>/dist/cli) and one session-specific
 *                                parent per configured session reference — this
 *                                is what you import for a local deployment.
 *
 *   *-parent-workflow.json  — orchestrator
 *   *-child-workflow.json   — phase runner (called by parent)
 *
 * Parent identity is per session, child identity is shared (issue #821):
 * every parent is generated from a canonical `sessionId` (resolved from the
 * operator's SESSION_REF through sessions.json), which yields a deterministic,
 * collision-safe workflow ID and a human-readable name.  All parents call the
 * SAME child workflow through its stable ID (CHILD_WORKFLOW_ID), so a multi-session
 * deployment imports N parents and exactly one child.
 *
 * Parent (5 nodes):
 *   Triggers → Config → Create Context → Call Phase Runner
 *
 * Child (5 nodes):
 *   When Called by Parent → GitHub Intake → Run One Phase → Dispatch Outbox → Return Context
 *
 * The parent passes only contextId to the child trigger.  The child reads it
 * from the trigger payload via
 * $("When Called by Parent").first().json.contextId in all three Execute Command
 * nodes so $json overwrite after each command is never a problem.  runId is
 * inlined as $execution.id (with millisecond fallback) in the run-one-phase
 * command expression.
 *
 * The child workflow ID ('ai-dev-loop-thin-phase-runner') must match the
 * workflowId in the parent's Call Phase Runner node.  Import the child first
 * so n8n registers its ID before the parent resolves it.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolve, dirname } from 'path';

// ---------------------------------------------------------------------------
// Configuration — values baked into generated command strings at generation
// time.  Override with env vars and re-run to regenerate:
//
//   CLI_BASE=/path/to/dist/cli SESSION_REF=my-session npm run build:parent-child-workflow
//
// If CLI_BASE is omitted it defaults to path.resolve(process.cwd(), "dist/cli")
// at build time.  Run the build command from the tree n8n should execute so
// the baked-in path points at the correct installation.
// ---------------------------------------------------------------------------

// SESSION_REF selects which session(s) get a session-specific parent workflow in
// the local deployment artifacts.  It holds one or more compact, operator-facing
// references (comma-separated) — a sessionId, a numeric sessionNo (e.g. 2), or an
// alias (e.g. addon).  Each reference is resolved to its canonical sessionId
// through sessions.json AT GENERATION TIME, so the generated workflow only ever
// carries the canonical identifier (issue #821).  SESSION_ID is accepted as a
// backward-compatible fallback (a sessionId is itself a valid reference).  A
// reference that itself contains a comma (or leading/trailing spaces) is written
// with backslash escapes — see parseSessionRefs.
const SUPPORTED_PHASES = 'implementation,review,conflict_resolution,research,content_research,content_draft,content_review,refinement';
const SCHEDULE_MINUTES = 5;

// Repository root — used to locate the compiled session resolver in dist/.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Canonical, environment-independent sessionId baked into the tracked docs/
// template.  It is canonical by construction (never resolved through
// sessions.json), so the template builds on a machine with no session registry.
// Operator-supplied SESSION_REF / SESSION_ID seed only the local deployment
// artifacts; they must never dirty the checked-in template.
export const CANONICAL_SESSION_ID = 'ai-cli-loop';

// Identity of the tracked docs/ parent template.  The template is generic
// review/onboarding output, NOT a machine-specific deployment artifact, so it
// keeps a fixed ID/name instead of the per-session derived pair.  Deployment
// artifacts under .n8n-artifacts/workflows/ always use the derived identity.
export const GENERIC_PARENT_WORKFLOW_ID = 'ai-dev-loop-thin-parent';
export const GENERIC_PARENT_WORKFLOW_NAME = 'AI Dev Loop — Parent Workflow';

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
//
// The child is SHARED across every session: it is stateless with respect to the
// session (it receives only contextId and resolves everything else from the
// context store), so one import serves all parents.  This ID is therefore stable
// and never derived from a session.
export const CHILD_WORKFLOW_ID = 'ai-dev-loop-thin-phase-runner';

// The child's human-readable n8n workflow name, and the filename its deployment
// artifact is written under.  Both are exported because `admin n8n deploy`
// (issue #822) verifies the imported child by ID *and* name and has to locate
// its artifact — deriving either by hand there would let the deploy command and
// the generator drift apart silently.
export const CHILD_WORKFLOW_NAME = 'AI Dev Loop — Phase Runner (Child)';
export const CHILD_ARTIFACT_FILE_NAME = 'n8n-thin-child-workflow.json';

// Directory (relative to the repository root) the local, gitignored deployment
// artifacts are written to.  Exported for the same reason as the two constants
// above: `admin n8n deploy` imports the files from exactly this directory.
export const LOCAL_WORKFLOW_ARTIFACT_DIR = '.n8n-artifacts/workflows';

// ---------------------------------------------------------------------------
// Session-specific parent identity (issue #821)
//
// A deployment runs one parent workflow per session, so each parent needs its
// own n8n workflow ID and a name an operator can recognize in the workflow list.
// Both are derived from the CANONICAL sessionId — never from a sessionNo or an
// alias, which an operator can reassign in sessions.json without touching n8n
// (and which would silently repoint an already-imported workflow at another
// session).
//
// The derived ID is:
//
//   ai-dev-loop-parent-<slug>-<digest>
//
// `slug` keeps the ID readable; `digest` — the FULL sha256 of the exact
// canonical sessionId — keeps it collision-safe, because slugging is lossy:
// "team/api" and "team-api" produce the same slug but different digests.  Both
// halves are pure functions of the sessionId, so regenerating for the same
// session is byte-for-byte deterministic.
//
// The digest is deliberately untruncated.  A short prefix carries only a handful
// of bits, and the artifact filename is the workflow ID: two sessions colliding
// on the prefix would claim one n8n workflow AND one file, so the second build
// would silently overwrite the first and leave a session with no deployable
// parent.  A full sha256 makes that impossible rather than improbable, and the
// readable slug — not the digest — is what an operator reads.
//
// sessions.json accepts any non-empty sessionId, including one written in a
// non-Latin script (e.g. "開発").  n8n workflow IDs and artifact filenames stay
// ASCII, so such characters are transcribed to their code points before slugging
// rather than dropped — otherwise a registry-valid session would slug to nothing
// and could never be deployed.  ASCII sessionIds are untouched by that step, so
// their derived IDs are unchanged.
//
// sessions.json likewise accepts a sessionId with leading or trailing whitespace
// (its validator rejects only empty/whitespace-only values), so such a sessionId
// is carried through verbatim.  Trimming it would point the Config node at a
// DIFFERENT session than the registry resolved, and rejecting it would make a
// registry-valid session undeployable.  Padding survives every surface the ID
// reaches: the Config node is JSON, and the command quotes and escapes the value.
// ---------------------------------------------------------------------------

export const PARENT_WORKFLOW_ID_PREFIX = 'ai-dev-loop-parent-';

// Cap the readable half so a long sessionId cannot produce an unwieldy ID; the
// digest (computed from the FULL sessionId, not the truncated slug) preserves
// uniqueness past the cut.
const PARENT_SLUG_MAX_LENGTH = 32;

// Stand-in for the readable half when a sessionId slugs to nothing (it is made
// only of punctuation, e.g. `--__--`).  Such an ID is valid in sessions.json, so
// the build must still produce an artifact; the digest that follows the slug
// keeps two such sessions apart.
const PARENT_SLUG_FALLBACK = 'session';

// The shape every derived workflow ID must have: lowercase alphanumerics and
// single-purpose hyphens, starting with an alphanumeric.  Checked on the way out
// as a self-test so a future change to the derivation cannot quietly emit an
// identifier that n8n or a filename would have to sanitize.
const SAFE_WORKFLOW_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validate a canonical sessionId before it is baked into a workflow.
 *
 * The rule is deliberately the same one sessions.json enforces — a non-empty,
 * non-whitespace-only string — so no session the registry accepts becomes
 * undeployable here.  A padded sessionId is therefore kept verbatim rather than
 * trimmed or refused; see the derivation notes above.
 *
 * The one addition is control characters, which are refused because they cannot
 * make the trip at all: the sessionId is handed to `admin.js` as an argv entry,
 * and a NUL terminates an argument rather than travelling inside it.  Failing
 * here says so plainly instead of letting a truncated `--session-id` surface at
 * run time inside n8n.
 */
export function requireCanonicalSessionId(sessionId) {
  if (typeof sessionId !== 'string') {
    throw new Error(
      `sessionId must be a non-empty string, got ${sessionId === null ? 'null' : typeof sessionId}`,
    );
  }
  if (sessionId.trim() === '') {
    throw new Error('sessionId must be a non-empty string (got an empty or whitespace-only value)');
  }
  // Control characters are checked by code point rather than by a regex range so
  // the rule stays readable and cannot be misread as an escaping accident.
  const hasControlChar = [...sessionId].some((ch) => {
    const code = ch.codePointAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (hasControlChar) {
    throw new Error(
      `sessionId must not contain control characters: ${JSON.stringify(sessionId)}`,
    );
  }
  return sessionId;
}

/**
 * Rewrite every non-ASCII code point as its lowercase hex code point, fenced by
 * hyphens so adjacent transcriptions stay distinguishable.  Pure ASCII input is
 * returned unchanged, so IDs derived before this step existed keep their value.
 */
function transcribeNonAsciiForSlug(sessionId) {
  return [...sessionId]
    .map((ch) => {
      const code = ch.codePointAt(0);
      return code < 0x80 ? ch : `-${code.toString(16)}-`;
    })
    .join('');
}

/**
 * Deterministic, collision-safe n8n workflow ID for a session's parent workflow.
 * Same canonical sessionId in → same ID out, on every machine and every run.
 */
export function deriveParentWorkflowId(sessionId) {
  const canonical = requireCanonicalSessionId(sessionId);
  // Full digest, never a prefix: this value is the only thing keeping two
  // sessions from claiming one workflow ID and one artifact filename.
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  const readableSlug = transcribeNonAsciiForSlug(canonical)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PARENT_SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  // `sessions.json` accepts any non-empty sessionId, including one made only of
  // punctuation (`--__--`), which slugs to nothing.  Those sessions are still
  // deployable, so fall back to a fixed token instead of refusing to build:
  // the digest is what makes the ID unique, and it is derived from the full
  // canonical sessionId either way.
  const slug = readableSlug === '' ? PARENT_SLUG_FALLBACK : readableSlug;
  const id = `${PARENT_WORKFLOW_ID_PREFIX}${slug}-${digest}`;
  if (!SAFE_WORKFLOW_ID.test(id)) {
    throw new Error(
      `Derived parent workflow ID ${JSON.stringify(id)} for sessionId ` +
        `${JSON.stringify(sessionId)} is not a safe identifier (expected ${SAFE_WORKFLOW_ID}).`,
    );
  }
  return id;
}

/** Human-readable n8n workflow name for a session's parent workflow. */
export function deriveParentWorkflowName(sessionId) {
  return `AI Dev Loop — Parent (${requireCanonicalSessionId(sessionId)})`;
}

/**
 * Filename of a session's parent deployment artifact under
 * `.n8n-artifacts/workflows/`.  Named after the derived workflow ID so two
 * sessions can never overwrite each other's artifact and the file an operator
 * imports states the ID it will register in n8n.
 */
export function parentArtifactFileName(sessionId) {
  return `${deriveParentWorkflowId(sessionId)}.json`;
}

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
// `options.sessionId` is the CANONICAL sessionId this parent drives (issue #821).
// It is baked into the Config node and drives the derived workflow identity, so
// the value must already be resolved through sessions.json — the builder is pure
// and never resolves a sessionNo or alias itself.  It defaults to
// CANONICAL_SESSION_ID, which is canonical by construction, so a no-argument
// build works with no session registry present.
//
// `options.workflowId` / `options.workflowName` override the derived identity.
// Only the tracked docs/ template uses them (to stay generic review/onboarding
// output); deployment artifacts always take the per-session derived pair.
export function buildParentWorkflow(options = {}) {
  const cliBase = options.cliBase ?? resolveLocalCliBase();
  const cliBaseEsc = shellescape(cliBase);
  const sessionId = requireCanonicalSessionId(options.sessionId ?? CANONICAL_SESSION_ID);
  const workflowId = options.workflowId ?? deriveParentWorkflowId(sessionId);
  const workflowName = options.workflowName ?? deriveParentWorkflowName(sessionId);
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
    // Config holds the CANONICAL sessionId this parent drives (issue #821).
    // It is resolved from the operator's session reference at generation time,
    // so the deployed workflow never carries a mutable alias or sessionNo that
    // could be repointed at a different session by an edit to sessions.json.
    // The child workflow only ever receives --context-id, so no sessionId is
    // forwarded across the workflow boundary.
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
              id: 'cfg-session-id',
              name: 'sessionId',
              value: sessionId,
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
        // sessionId is read from Config, which an operator can still edit in the
        // n8n UI, so it may contain whitespace or shell metacharacters. It is
        // single-quoted in the runtime shell command (with embedded single quotes
        // escaped) before admin.js consumes it; without this the shell would
        // split/interpret the value first.
        // --session-id (not --session-ref) because Config holds the canonical
        // identifier already resolved at generation time (issue #821).
        // --json explicitly requests the machine-readable stdout contract
        // (issue #308). context create defaults to JSON today, but requesting it
        // explicitly keeps the downstream JSON.parse() stable if defaults ever
        // change.
        command: `={{ "node '${cliBaseEsc}/admin.js' context create --json --execution-id " + $execution.id + " --session-id '" + String($("Config").first().json.sessionId).replace(/'/g, "'\\\\''") + "'" }}`,
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
    // Every session's parent calls the SAME child through the stable
    // CHILD_WORKFLOW_ID — the child is shared, never generated per session.
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
    name: workflowName,
    nodes,
    pinData: {},
    connections,
    active: false,
    settings: { executionOrder: 'v1' },
    versionId: 'parent-v1',
    meta: { templateCredsSetupCompleted: true },
    id: workflowId,
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
    name: CHILD_WORKFLOW_NAME,
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
// The shadow pair keeps the fixed PRIVATE_NODE_PARENT_WORKFLOW_ID identity and a
// `sessionRef`-shaped Config field: its Create Context operation invokes
// `admin.js context create --session-ref`, so it consumes a reference rather than
// a canonical sessionId.  Session-specific identity (issue #821) applies to the
// Execute Command parent that is actually deployed; the shadow pair follows when
// the private-node path leaves shadow testing.  A canonical sessionId is itself a
// valid reference, so callers may pass one here.
export function buildPrivateNodeParentWorkflow(options = {}) {
  const sessionRef = options.sessionRef ?? CANONICAL_SESSION_ID;
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
    // Config holds the compact sessionRef as an editable field.  The
    // private-node Create Context operation reads sessionRef from this node via
    // an n8n expression parameter and resolves it with --session-ref, unlike the
    // Execute Command parent whose Config already holds a canonical sessionId.
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
// Session reference resolution (issue #821)
//
// SESSION_REF holds operator-facing references, which may be sessionNos or
// aliases.  Those are mutable, so they are resolved to canonical sessionIds HERE,
// at generation time, and only the canonical value reaches the workflow.
//
// Resolution reuses the compiled registry resolver (dist/) rather than
// re-reading sessions.json, so alias/sessionNo collision handling has exactly one
// implementation and an ambiguous registry fails closed here too.
// ---------------------------------------------------------------------------

/**
 * Split the SESSION_REF / SESSION_ID env value into individual references.
 *
 * The list separator is a comma and the surrounding whitespace of each entry is
 * dropped, so `" addon , 2 "` names two sessions.  But sessions.json accepts any
 * non-empty string as a sessionId or alias — including one that CONTAINS a comma
 * or is padded with spaces — and such a session would otherwise be impossible to
 * name here (`team,a` would be read as two unknown references).  A backslash
 * therefore escapes the character after it, which is then taken literally and is
 * neither a separator nor trimmable whitespace:
 *
 *   SESSION_REF='team\,a'        → one reference, "team,a"
 *   SESSION_REF='\ padded\ '     → one reference, " padded "
 *   SESSION_REF='back\\slash'    → one reference, "back\slash"
 *
 * A trailing lone backslash is an error rather than a silently dropped character,
 * because it is always a truncated escape.
 */
export function parseSessionRefs(raw) {
  const text = String(raw);
  // Each character is carried with a flag saying whether an escape produced it,
  // so the trim below can tell " " (a separator-adjacent space to drop) from
  // "\ " (part of the reference itself).
  const segments = [[]];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      const escaped = text[i + 1];
      if (escaped === undefined) {
        throw new Error(
          `SESSION_REF/SESSION_ID ends with a lone backslash: ${JSON.stringify(raw)}. ` +
            'A backslash escapes the character after it; write "\\\\" for a literal backslash.',
        );
      }
      segments[segments.length - 1].push({ ch: escaped, literal: true });
      i += 1;
      continue;
    }
    if (ch === ',') {
      segments.push([]);
      continue;
    }
    segments[segments.length - 1].push({ ch, literal: false });
  }
  const refs = segments
    .map((segment) => {
      const isTrimmable = (entry) => !entry.literal && /\s/.test(entry.ch);
      let start = 0;
      let end = segment.length;
      while (start < end && isTrimmable(segment[start])) start += 1;
      while (end > start && isTrimmable(segment[end - 1])) end -= 1;
      return segment
        .slice(start, end)
        .map((entry) => entry.ch)
        .join('');
    })
    .filter((ref) => ref !== '');
  if (refs.length === 0) {
    throw new Error(
      `SESSION_REF/SESSION_ID is set but contains no session reference: ${JSON.stringify(raw)}. ` +
        'Provide one reference, or a comma-separated list, or unset it to build for the default session.',
    );
  }
  return refs;
}

/**
 * Resolve references to canonical sessionIds with `resolveRef`, preserving order
 * and dropping duplicates (two references may name the same session — that must
 * produce one parent workflow, not two identical ones).
 */
export function resolveSessionIds(refs, resolveRef) {
  const sessionIds = [];
  for (const ref of refs) {
    let sessionId;
    try {
      sessionId = resolveRef(ref);
    } catch (err) {
      throw new Error(
        `Cannot resolve session reference ${JSON.stringify(ref)} to a canonical sessionId: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    requireCanonicalSessionId(sessionId);
    if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId);
  }
  return sessionIds;
}

/** Path of the compiled session registry the resolver is imported from. */
const SESSION_REGISTRY_DIST = resolve(REPO_ROOT, 'dist/registries/json-session-registry.js');

/**
 * Default library compiler: the same `tsc -p tsconfig.json` that `build:lib`
 * runs, invoked directly through the local TypeScript so no shell, npm binary
 * or PATH lookup is involved.
 */
function compileLibrary() {
  const tsc = resolve(REPO_ROOT, 'node_modules/typescript/bin/tsc');
  const project = resolve(REPO_ROOT, 'tsconfig.json');
  return spawnSync(process.execPath, [tsc, '-p', project], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

/**
 * Make sure the compiled session resolver exists before it is imported.
 *
 * `build:parent-child-workflow` deliberately does not depend on `build:lib` —
 * the common build needs no session registry at all, and `npm run build` has
 * already compiled the library by the time it gets here.  But `dist/` is
 * gitignored, so an operator who runs the workflow-only command with SESSION_REF
 * set on a fresh checkout would otherwise fail before any artifact is written.
 * Compile on demand instead, and only in that case.
 */
export function ensureSessionResolverBuilt({
  modulePath = SESSION_REGISTRY_DIST,
  compile = compileLibrary,
} = {}) {
  if (existsSync(modulePath)) return;
  const result = compile();
  if (result?.error) {
    throw new Error(
      `Cannot compile the session resolver — running the TypeScript compiler failed: ` +
        `${result.error.message}. Build the library first (npm run build:lib).`,
    );
  }
  if (result?.status !== 0) {
    throw new Error(
      `Cannot compile the session resolver — the TypeScript compiler exited with ` +
        `${result?.status ?? 'no status'}. Fix the compile errors above, or build the ` +
        'library first (npm run build:lib).',
    );
  }
  if (!existsSync(modulePath)) {
    throw new Error(
      `The TypeScript compiler succeeded but ${modulePath} is still missing. ` +
        'Build the library first (npm run build:lib).',
    );
  }
}

/**
 * Load the compiled session-reference resolver from `dist/`, compiling the
 * library first when it is not there yet. Returns a `(ref) => sessionId`
 * function bound to the sessions file (SESSIONS_PATH env var or the registry
 * default).
 */
export async function loadSessionRefResolver({
  sessionsPath,
  ensureBuilt = ensureSessionResolverBuilt,
} = {}) {
  const modulePath = SESSION_REGISTRY_DIST;
  ensureBuilt({ modulePath });
  let registry;
  try {
    registry = await import(pathToFileURL(modulePath).href);
  } catch (err) {
    throw new Error(
      `Cannot load the session resolver from ${modulePath} — build the library first ` +
        `(npm run build:lib). Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const path = sessionsPath ?? process.env['SESSIONS_PATH'] ?? registry.DEFAULT_SESSIONS_PATH;
  return (ref) => registry.resolveSessionRef(path, ref);
}

/**
 * The canonical sessionIds to generate parent deployment artifacts for.
 *
 * With SESSION_REF (or the legacy SESSION_ID) unset, this is CANONICAL_SESSION_ID
 * — canonical by construction — so a plain `npm run build` needs no session
 * registry at all. When the operator DOES name references, they are resolved
 * through sessions.json and an unknown or ambiguous one fails the build rather
 * than baking an unresolved reference into a workflow.
 */
export async function resolveConfiguredSessionIds(env = process.env) {
  const raw = env['SESSION_REF'] ?? env['SESSION_ID'];
  if (raw === undefined || raw.trim() === '') return [CANONICAL_SESSION_ID];
  return resolveSessionIds(parseSessionRefs(raw), await loadSessionRefResolver());
}

// ---------------------------------------------------------------------------
// CLI entrypoint — write tracked templates + local deployment artifacts
//
//   docs/                      stable template baked with CANONICAL_CLI_BASE and
//                              the generic parent identity (tracked;
//                              environment-independent; never dirtied by a local
//                              CLI_BASE or SESSION_REF)
//   .n8n-artifacts/workflows/  local deployment artifacts baked with the resolved
//                              local CLI_BASE (gitignored; this is what you import
//                              for a local deployment): ONE parent per configured
//                              session plus the single shared child
//
// WORKFLOW_ARTIFACTS_ONLY=1 writes only the second group.  A *deployment*
// (`admin n8n deploy`, issue #822) generates artifacts as a step of importing
// them, and it has no business rewriting tracked files on the way: the templates
// are canonical and would be rewritten with identical bytes in the normal case,
// but silently reverting an operator's local edit to a tracked template is a
// mutation nobody asked a deploy command for.
// ---------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const docsDir = resolve(REPO_ROOT, 'docs');
  const localDir = resolve(REPO_ROOT, LOCAL_WORKFLOW_ARTIFACT_DIR);
  const artifactsOnly = process.env['WORKFLOW_ARTIFACTS_ONLY'] === '1';

  const PARENT = 'n8n-thin-parent-workflow.json';
  const CHILD = CHILD_ARTIFACT_FILE_NAME;
  const PRIVATE_NODE_CHILD = 'n8n-thin-child-workflow-private-node.json';
  const PRIVATE_NODE_PARENT = 'n8n-thin-parent-workflow-private-node.json';

  // Resolve first: an unknown or ambiguous SESSION_REF must fail the build before
  // anything is written, not halfway through it.
  const sessionIds = await resolveConfiguredSessionIds();

  // Tracked template — always canonical so the committed JSON is stable and
  // never carries the operator's CLI_BASE or session references.  The template
  // keeps the generic parent identity: it is review/onboarding output, not a
  // machine-specific deployment artifact.
  if (!artifactsOnly) {
    const parentTemplate = buildParentWorkflow({
      cliBase: CANONICAL_CLI_BASE,
      sessionId: CANONICAL_SESSION_ID,
      workflowId: GENERIC_PARENT_WORKFLOW_ID,
      workflowName: GENERIC_PARENT_WORKFLOW_NAME,
    });
    const childTemplate = buildChildWorkflow({ cliBase: CANONICAL_CLI_BASE });
    const privateNodeChildTemplate = buildPrivateNodeChildWorkflow({ cliBase: CANONICAL_CLI_BASE });
    const privateNodeParentTemplate = buildPrivateNodeParentWorkflow({
      sessionRef: CANONICAL_SESSION_ID,
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
  }

  // Local deployment artifacts — baked with the operator's resolved CLI_BASE.
  // One parent per configured session (session-specific ID, name, and filename);
  // the child is shared, so exactly one is written no matter how many sessions
  // are configured.
  const localCliBase = resolveLocalCliBase();
  mkdirSync(localDir, { recursive: true });
  const childLocal = buildChildWorkflow({ cliBase: localCliBase });
  const privateNodeChildLocal = buildPrivateNodeChildWorkflow({ cliBase: localCliBase });
  const privateNodeParentLocal = buildPrivateNodeParentWorkflow({ sessionRef: sessionIds[0] });
  const localFiles = [
    ...sessionIds.map((sessionId) => [
      parentArtifactFileName(sessionId),
      buildParentWorkflow({ cliBase: localCliBase, sessionId }),
    ]),
    [CHILD, childLocal],
    [PRIVATE_NODE_CHILD, privateNodeChildLocal],
    [PRIVATE_NODE_PARENT, privateNodeParentLocal],
  ];
  for (const [name, wf] of localFiles) {
    const path = resolve(localDir, name);
    writeFileSync(path, JSON.stringify(wf, null, 2) + '\n');
    console.log(`Written (local, CLI_BASE=${localCliBase}): ${path}`);
  }
  console.log(
    `Parent workflows generated for session(s): ${sessionIds.join(', ')} ` +
      `(shared child workflow ID: ${CHILD_WORKFLOW_ID})`,
  );
}
