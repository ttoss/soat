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

/**
 * Why a run could not call the action a `tool` executor names, or null: an
 * `mcp` tool takes no call without an action, nor one its binding withholds.
 */
export const executorActionProblem = async (args: {
  executor: PlaybookExecutor;
  projectId: number;
}): Promise<{
  code: 'EXECUTOR_ACTION_REQUIRED' | 'EXECUTOR_ACTION_UNAVAILABLE';
  message: string;
} | null> => {
  const { executor, projectId } = args;
  if (executor.type !== 'tool') return null;
  const tool = await toolReferences.find({
    id: executor.id,
    projectId,
    reach: 'shares',
  });
  if (tool?.type !== 'mcp') return null;
  const action = executor.operation_id;
  if (action === undefined) {
    log('executorActionProblem: %s has no operation_id', executor.id);
    return {
      code: 'EXECUTOR_ACTION_REQUIRED',
      message: `mcp tool '${executor.id}' needs the action to call in operation_id.`,
    };
  }
  if (!isActionBound({ tool, action })) {
    log('executorActionProblem: %s withholds %s', executor.id, action);
    return {
      code: 'EXECUTOR_ACTION_UNAVAILABLE',
      message: `action '${action}' is not available on tool '${executor.id}'.`,
    };
  }
  return null;
};

/**
 * Why a run could not call a transformation's tool, or null: an `mcp` tool
 * takes no call without an action, and a transformation names none.
 */
export const transformationToolProblem = async (args: {
  toolId: string;
  projectId: number;
}): Promise<{
  code: 'TRANSFORMATION_TOOL_UNSUPPORTED';
  message: string;
} | null> => {
  const tool = await toolReferences.find({
    id: args.toolId,
    projectId: args.projectId,
    reach: 'shares',
  });
  if (tool?.type !== 'mcp') return null;
  log('transformationToolProblem: %s is an mcp tool', args.toolId);
  return {
    code: 'TRANSFORMATION_TOOL_UNSUPPORTED',
    message: `mcp tool '${args.toolId}' cannot be a transformation's tool: a transformation names no action to call.`,
  };
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
