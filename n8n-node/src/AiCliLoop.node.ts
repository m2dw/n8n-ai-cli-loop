import type {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';

const execPromise = promisify(exec);

// ---------------------------------------------------------------------------
// CLI path resolution
//
// Resolution order:
//   1. CLI_BASE environment variable (operator-configured, same as Execute Command path)
//   2. Relative path from this file's compiled location, assuming the node
//      package is a sibling of the main project root (co-located install)
//
// This lets the shadow workflow omit any CLI path parameter — a key advantage
// over the Execute Command approach.  Operators who set CLI_BASE in their n8n
// environment get the same behaviour they already have.
// ---------------------------------------------------------------------------

function resolveCliBase(): string {
  if (process.env['CLI_BASE']) {
    return process.env['CLI_BASE'];
  }
  // Compiled to n8n-node/dist/AiCliLoop.node.js; main dist/cli is two levels up.
  // This works when the package is symlinked from ~/.n8n/custom/node_modules/
  // (Node resolves __dirname through the symlink to the real path).  Copy
  // installs land in a different directory tree, so they must set CLI_BASE.
  return resolve(__dirname, '../../dist/cli');
}

// Minimal POSIX single-quote escaping so contextId is safely embedded in a
// shell command even if it contains single quotes (unlikely but defensive).
function shellEscapeArg(s: string): string {
  return s.replace(/'/g, "'\\''");
}

export class AiCliLoop implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'AI CLI Loop',
    name: 'aiCliLoop',
    icon: 'fa:code-branch',
    group: ['transform'],
    version: 1,
    description:
      'Executes AI Dev Loop operations (Create Context, Acquire Repo Lock, Release Repo Lock, GitHub Intake, Run One Phase, Dispatch Outbox)',
    defaults: {
      name: 'AI CLI Loop',
    },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Create Context',
            value: 'createContext',
            description: 'Create an execution context in the context store',
            action: 'Create context',
          },
          {
            name: 'Acquire Repo Lock',
            value: 'acquireRepoLock',
            description: 'Acquire the per-session repo lock for this context',
            action: 'Acquire repo lock',
          },
          {
            name: 'Release Repo Lock',
            value: 'releaseRepoLock',
            description: 'Release the per-session repo lock for this context',
            action: 'Release repo lock',
          },
          {
            name: 'GitHub Intake',
            value: 'githubIntake',
            description: 'Discover GitHub issues by label and enqueue into the task store',
            action: 'GitHub intake',
          },
          {
            name: 'Run One Phase',
            value: 'runOnePhase',
            description: 'Execute the next pending phase for a task in the given context',
            action: 'Run one phase',
          },
          {
            name: 'Dispatch Outbox',
            value: 'dispatchOutbox',
            description: 'Flush pending outbox entries for the given context',
            action: 'Dispatch outbox',
          },
        ],
        default: 'dispatchOutbox',
      },
      {
        displayName: 'Execution ID',
        name: 'executionId',
        type: 'string',
        required: true,
        default: '',
        displayOptions: {
          show: {
            operation: ['createContext'],
          },
        },
        description: 'The n8n execution ID for this workflow run',
      },
      {
        displayName: 'Session Reference',
        name: 'sessionRef',
        type: 'string',
        required: true,
        default: '',
        displayOptions: {
          show: {
            operation: ['createContext'],
          },
        },
        description: 'Session reference (sessionId, sessionNo, or alias) resolved via sessions.json',
      },
      {
        displayName: 'Context ID',
        name: 'contextId',
        type: 'string',
        required: true,
        default: '',
        displayOptions: {
          show: {
            operation: ['acquireRepoLock', 'releaseRepoLock', 'githubIntake', 'runOnePhase', 'dispatchOutbox'],
          },
        },
        description: 'The context ID for this operation',
      },
      {
        displayName: 'Run ID',
        name: 'runId',
        type: 'string',
        required: true,
        default: '',
        displayOptions: {
          show: {
            operation: ['runOnePhase'],
          },
        },
        description: 'The run ID for this phase execution (used for deduplication and tracing)',
      },
      {
        displayName: 'Supported Phases',
        name: 'supportedPhases',
        type: 'string',
        required: true,
        default: 'implementation,review,conflict_resolution,research',
        displayOptions: {
          show: {
            operation: ['githubIntake', 'runOnePhase'],
          },
        },
        description: 'Comma-separated list of supported phases',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const operation = this.getNodeParameter('operation', 0) as string;

    if (operation === 'createContext') {
      const executionId = this.getNodeParameter('executionId', 0) as string;
      const sessionRef = this.getNodeParameter('sessionRef', 0) as string;

      if (!executionId) {
        throw new NodeOperationError(this.getNode(), 'Execution ID must not be empty');
      }
      if (!sessionRef) {
        throw new NodeOperationError(this.getNode(), 'Session reference must not be empty');
      }

      const cliBase = resolveCliBase();
      const script = resolve(cliBase, 'admin.js');

      let stdout: string;
      try {
        ({ stdout } = await execPromise(
          `node '${shellEscapeArg(script)}' context create --json --execution-id '${shellEscapeArg(executionId)}' --session-ref '${shellEscapeArg(sessionRef)}'`
        ));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new NodeOperationError(this.getNode(), `Create Context CLI failed: ${message}`);
      }

      let result: unknown;
      try {
        result = JSON.parse(stdout);
      } catch {
        throw new NodeOperationError(
          this.getNode(),
          `Create Context returned non-JSON output: ${stdout}`
        );
      }

      return [items.map(() => ({ json: result as IDataObject }))];
    }

    if (operation === 'acquireRepoLock') {
      const contextId = this.getNodeParameter('contextId', 0) as string;

      if (!contextId) {
        throw new NodeOperationError(this.getNode(), 'Context ID must not be empty');
      }

      const cliBase = resolveCliBase();
      const script = resolve(cliBase, 'admin.js');

      let stdout: string;
      try {
        ({ stdout } = await execPromise(
          `node '${shellEscapeArg(script)}' repo-lock acquire --json --context-id '${shellEscapeArg(contextId)}'`
        ));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new NodeOperationError(this.getNode(), `Acquire Repo Lock CLI failed: ${message}`);
      }

      let result: unknown;
      try {
        result = JSON.parse(stdout);
      } catch {
        throw new NodeOperationError(
          this.getNode(),
          `Acquire Repo Lock returned non-JSON output: ${stdout}`
        );
      }

      return [items.map(() => ({ json: result as IDataObject }))];
    }

    if (operation === 'releaseRepoLock') {
      const contextId = this.getNodeParameter('contextId', 0) as string;

      if (!contextId) {
        throw new NodeOperationError(this.getNode(), 'Context ID must not be empty');
      }

      const cliBase = resolveCliBase();
      const script = resolve(cliBase, 'admin.js');

      let stdout: string;
      try {
        ({ stdout } = await execPromise(
          `node '${shellEscapeArg(script)}' repo-lock release --json --context-id '${shellEscapeArg(contextId)}'`
        ));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new NodeOperationError(this.getNode(), `Release Repo Lock CLI failed: ${message}`);
      }

      let result: unknown;
      try {
        result = JSON.parse(stdout);
      } catch {
        throw new NodeOperationError(
          this.getNode(),
          `Release Repo Lock returned non-JSON output: ${stdout}`
        );
      }

      return [items.map(() => ({ json: result as IDataObject }))];
    }

    if (operation === 'githubIntake') {
      const contextId = this.getNodeParameter('contextId', 0) as string;
      const supportedPhases = this.getNodeParameter('supportedPhases', 0) as string;

      if (!contextId) {
        throw new NodeOperationError(this.getNode(), 'Context ID must not be empty');
      }

      const cliBase = resolveCliBase();
      const script = resolve(cliBase, 'github-intake.js');

      let stdout: string;
      try {
        ({ stdout } = await execPromise(
          `node '${shellEscapeArg(script)}' --context-id '${shellEscapeArg(contextId)}' --supported-phases '${shellEscapeArg(supportedPhases)}'`
        ));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new NodeOperationError(this.getNode(), `GitHub Intake CLI failed: ${message}`);
      }

      let result: unknown;
      try {
        result = JSON.parse(stdout);
      } catch {
        throw new NodeOperationError(
          this.getNode(),
          `GitHub Intake returned non-JSON output: ${stdout}`
        );
      }

      return [items.map(() => ({ json: result as IDataObject }))];
    }

    if (operation === 'runOnePhase') {
      const contextId = this.getNodeParameter('contextId', 0) as string;
      const runId = this.getNodeParameter('runId', 0) as string;
      const supportedPhases = this.getNodeParameter('supportedPhases', 0) as string;

      if (!contextId) {
        throw new NodeOperationError(this.getNode(), 'Context ID must not be empty');
      }
      if (!runId) {
        throw new NodeOperationError(this.getNode(), 'Run ID must not be empty');
      }

      const cliBase = resolveCliBase();
      const script = resolve(cliBase, 'run-one-phase.js');

      let stdout: string;
      try {
        ({ stdout } = await execPromise(
          `node '${shellEscapeArg(script)}' --context-id '${shellEscapeArg(contextId)}' --run-id '${shellEscapeArg(runId)}' --supported-phases '${shellEscapeArg(supportedPhases)}'`
        ));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new NodeOperationError(this.getNode(), `Run One Phase CLI failed: ${message}`);
      }

      let result: unknown;
      try {
        result = JSON.parse(stdout);
      } catch {
        throw new NodeOperationError(
          this.getNode(),
          `Run One Phase returned non-JSON output: ${stdout}`
        );
      }

      return [items.map(() => ({ json: result as IDataObject }))];
    }

    if (operation === 'dispatchOutbox') {
      const contextId = this.getNodeParameter('contextId', 0) as string;

      if (!contextId) {
        throw new NodeOperationError(this.getNode(), 'Context ID must not be empty');
      }

      const cliBase = resolveCliBase();
      const script = resolve(cliBase, 'dispatch-outbox.js');

      let stdout: string;
      try {
        ({ stdout } = await execPromise(
          `node '${shellEscapeArg(script)}' --context-id '${shellEscapeArg(contextId)}'`
        ));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new NodeOperationError(this.getNode(), `Dispatch Outbox CLI failed: ${message}`);
      }

      let result: unknown;
      try {
        result = JSON.parse(stdout);
      } catch {
        throw new NodeOperationError(
          this.getNode(),
          `Dispatch Outbox returned non-JSON output: ${stdout}`
        );
      }

      return [items.map(() => ({ json: result as IDataObject }))];
    }

    throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
  }
}
