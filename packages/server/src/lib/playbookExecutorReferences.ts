import createDebug from 'debug';

import { db } from '../db';
import type { PlaybookExecutor } from './playbookDefinition';
import { agentReferences, toolReferences } from './resourceReferences';
import {
  isActionBound,
  type ServerSideToolProblem,
  serverSideToolProblem,
} from './toolsCallDispatch';

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

/** How each start refuses a tool a server-side caller cannot run. */
const UNSUPPORTED: Record<
  ToolStart,
  { code: ToolCallProblem['code']; label: string }
> = {
  executor: { code: 'EXECUTOR_TOOL_UNSUPPORTED', label: "a node's executor" },
  transformation: {
    code: 'TRANSFORMATION_TOOL_UNSUPPORTED',
    label: "a transformation's tool",
  },
};

/** An executor names its action in `operation_id`; a transformation cannot. */
const UNSUPPORTED_REASONS: Record<ServerSideToolProblem, string> = {
  runs_on_client: 'it runs only in the calling client',
  action_required: 'a transformation names no action to call',
};

type ToolRow = NonNullable<Awaited<ReturnType<typeof toolReferences.find>>>;

const unboundActionProblem = (args: {
  tool: ToolRow;
  executor: PlaybookExecutor;
}): ToolCallProblem | null => {
  const { tool, executor } = args;
  const action = executor.operation_id;
  if (tool.type !== 'mcp' || action === undefined) return null;
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
 * Why a run could not call the tool a node starts, or null: one a server-side
 * caller cannot run (`serverSideToolProblem`), or an `mcp` executor's action
 * its binding withholds.
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
  const problem = serverSideToolProblem({
    tool,
    action: start === 'executor' ? executor.operation_id : undefined,
    // A node's tool reads the case's records, which arrive with each run.
    input: 'open',
  });
  if (problem === 'action_required' && start === 'executor') {
    log('toolCallProblem: %s has no operation_id', executor.id);
    return {
      code: 'EXECUTOR_ACTION_REQUIRED',
      on: 'operation_id',
      message: `${tool.type} tool '${executor.id}' needs the action to call in operation_id.`,
    };
  }
  if (problem) {
    const unsupported = UNSUPPORTED[start];
    log('toolCallProblem: %s tool %s as %s', tool.type, executor.id, start);
    return {
      code: unsupported.code,
      on: 'tool',
      message: `${tool.type} tool '${executor.id}' cannot be ${unsupported.label}: ${UNSUPPORTED_REASONS[problem]}.`,
    };
  }
  return unboundActionProblem({ tool, executor });
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
