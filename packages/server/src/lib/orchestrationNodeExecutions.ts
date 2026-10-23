import createDebug from 'debug';

import { db } from '../db';
import { type Page, paginatedList } from './pagination';

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
  projectIds: number[];
  limit?: number;
  cursor?: string;
}): Promise<Page<MappedNodeExecution>> => {
  log('listOrchestrationRunNodeExecutions: run=%s', args.runId);
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: { runId: args.runId, projectIds: args.projectIds },
    where: undefined,
    order: [['createdAt', 'ASC']],
    // No public id on this model. Two records of one node attempt in a run come
    // from two dispatches, which never share a `createdAt`.
    tiebreak: ['nodeId', 'attempt'],
    query: ({ where, limit, order }) => {
      return db.OrchestrationNodeExecution.findAll({
        where,
        include: [
          {
            model: db.OrchestrationRun,
            as: 'run',
            attributes: [],
            required: true,
            where: {
              publicId: args.runId,
              projectId: args.projectIds,
            },
          },
        ],
        limit,
        order,
      });
    },
    map: mapNodeExecution,
  });
};
