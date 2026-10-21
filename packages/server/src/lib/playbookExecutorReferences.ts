import createDebug from 'debug';

import { db } from '../db';
import type { PlaybookExecutor } from './playbookDefinition';
import { agentReferences, toolReferences } from './resourceReferences';

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
