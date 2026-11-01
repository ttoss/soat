import createDebug from 'debug';

import { db } from '../db';
import type { PlaybookExecutor } from './playbookDefinition';
import { agentReferences, toolReferences } from './resourceReferences';
import { isActionBound } from './toolsCallDispatch';

const log = createDebug('soat:playbooks');

type Lookup = { id: string; projectId: number };

/**
 * Where each executor type resolves when a node starts it, so authoring
 * answers what the run would: an agent or tool may be one shared with the
 * project, the rest are the project's own.
 */
const RESOLVES: Record<
  PlaybookExecutor['type'],
  (args: Lookup) => Promise<boolean>
> = {
  agent: async (args) => {
    return (await agentReferences.find({ ...args, reach: 'shares' })) !== null;
  },
  tool: async (args) => {
    return (await toolReferences.find({ ...args, reach: 'shares' })) !== null;
  },
  decider: async ({ id, projectId }) => {
    return (await db.Decider.count({ where: { publicId: id, projectId } })) > 0;
  },
  workflow: async ({ id, projectId }) => {
    return (
      (await db.Workflow.count({ where: { publicId: id, projectId } })) > 0
    );
  },
  orchestration: async ({ id, projectId }) => {
    return (
      (await db.Orchestration.count({ where: { publicId: id, projectId } })) > 0
    );
  },
};

/** What names the tool a node starts: its executor, or a transformation. */
export type ToolStart = 'executor' | 'transformation';

export type ToolCallProblem = {
  code:
    | 'EXECUTOR_TOOL_UNSUPPORTED'
    | 'TRANSFORMATION_TOOL_UNSUPPORTED'
    | 'EXECUTOR_ACTION_REQUIRED'
    | 'EXECUTOR_ACTION_UNAVAILABLE';
  /** The field at fault: the one naming the tool, or the executor's action. */
  on: 'tool' | 'operation_id';
  message: string;
};

/**
 * The tool types a run cannot call from each start, with why. A `client` tool
 * runs only in the calling client; an `mcp` tool needs an action, which only
 * an executor names.
 */
const UNSUPPORTED: Record<
  ToolStart,
  {
    code: ToolCallProblem['code'];
    label: string;
    types: Record<string, string>;
  }
> = {
  executor: {
    code: 'EXECUTOR_TOOL_UNSUPPORTED',
    label: "a node's executor",
    types: { client: 'it runs only in the calling client' },
  },
  transformation: {
    code: 'TRANSFORMATION_TOOL_UNSUPPORTED',
    label: "a transformation's tool",
    types: {
      client: 'it runs only in the calling client',
      mcp: 'a transformation names no action to call',
    },
  },
};

type ToolRow = NonNullable<Awaited<ReturnType<typeof toolReferences.find>>>;

const mcpActionProblem = (args: {
  tool: ToolRow;
  executor: PlaybookExecutor;
}): ToolCallProblem | null => {
  const { tool, executor } = args;
  const action = executor.operation_id;
  if (action === undefined) {
    log('toolCallProblem: %s has no operation_id', executor.id);
    return {
      code: 'EXECUTOR_ACTION_REQUIRED',
      on: 'operation_id',
      message: `mcp tool '${executor.id}' needs the action to call in operation_id.`,
    };
  }
  if (!isActionBound({ tool, action })) {
    log('toolCallProblem: %s withholds %s', executor.id, action);
    return {
      code: 'EXECUTOR_ACTION_UNAVAILABLE',
      on: 'operation_id',
      message: `action '${action}' is not available on tool '${executor.id}'.`,
    };
  }
  return null;
};

/**
 * Why a run could not call the tool a node starts, or null: a tool type the
 * start cannot call (`UNSUPPORTED`), or an `mcp` executor without an action
 * its binding allows.
 */
export const toolCallProblem = async (args: {
  executor: PlaybookExecutor;
  start: ToolStart;
  projectId: number;
}): Promise<ToolCallProblem | null> => {
  const { executor, start, projectId } = args;
  if (executor.type !== 'tool') return null;
  const tool = await toolReferences.find({
    id: executor.id,
    projectId,
    reach: 'shares',
  });
  if (!tool) return null;
  const unsupported = UNSUPPORTED[start];
  const reason = Object.hasOwn(unsupported.types, tool.type)
    ? unsupported.types[tool.type]
    : undefined;
  if (reason !== undefined) {
    log('toolCallProblem: %s tool %s as %s', tool.type, executor.id, start);
    return {
      code: unsupported.code,
      on: 'tool',
      message: `${tool.type} tool '${executor.id}' cannot be ${unsupported.label}: ${reason}.`,
    };
  }
  return tool.type === 'mcp' ? mcpActionProblem({ tool, executor }) : null;
};

/** Whether `executor` names something a run in `projectId` could start. */
export const executorResolves = async (args: {
  executor: PlaybookExecutor;
  projectId: number;
}): Promise<boolean> => {
  const { executor, projectId } = args;
  const found = await RESOLVES[executor.type]({ id: executor.id, projectId });
  if (!found) {
    log('executorResolves: %s %s not found', executor.type, executor.id);
  }
  return found;
};
