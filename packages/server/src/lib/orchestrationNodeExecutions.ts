import createDebug from 'debug';

import { db } from '../db';
import { paginatedList, type PaginatedResult } from './pagination';

const log = createDebug('soat:orchestrations');

export type MappedNodeExecution = {
  node_id: string;
  node_type: string | null;
  attempt: number;
  dispatches: number;
  status: 'running' | 'completed' | 'failed' | 'requires_action' | 'skipped';
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: object | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
};

const mapNodeExecution = (
  exec: InstanceType<typeof db.OrchestrationNodeExecution>
): MappedNodeExecution => {
  return {
    node_id: exec.nodeId,
    node_type: exec.nodeType,
    attempt: exec.attempt,
    dispatches: exec.dispatches,
    status: exec.status,
    input: exec.input as Record<string, unknown> | null,
    output: exec.output as Record<string, unknown> | null,
    error: exec.error,
    started_at: exec.startedAt,
    completed_at: exec.completedAt,
    created_at: exec.createdAt,
  };
};

/**
 * A run's node executions, oldest first: one row per node attempt, retries and
 * skipped nodes included. The caller has already been authorized for the run.
 */
export const listOrchestrationRunNodeExecutions = async (args: {
  runId: string;
  projectIds?: number[];
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedNodeExecution>> => {
  log('listOrchestrationRunNodeExecutions: run=%s', args.runId);
  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['createdAt', 'ASC']],
    query: ({ limit, offset, order }) => {
      return db.OrchestrationNodeExecution.findAndCountAll({
        include: [
          {
            model: db.OrchestrationRun,
            as: 'run',
            attributes: [],
            required: true,
            where: {
              publicId: args.runId,
              ...(args.projectIds ? { projectId: args.projectIds } : {}),
            },
          },
        ],
        limit,
        offset,
        order,
      });
    },
    map: mapNodeExecution,
  });
};
