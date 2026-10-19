import createDebug from 'debug';
import { db } from 'src/db';

import { paginatedList } from './pagination';
import {
  applyFilterWhere,
  compileMetadataWhere,
  type MetadataFilter,
} from './structuredFilter';
import { mapTask, taskIncludes } from './tasks';
import {
  automationStatusWhere,
  type TaskAutomationStatus,
} from './tasksAutomationStatus';

const log = createDebug('soat:tasks');

/**
 * The task list roots its query at the `Task` alias; only the ordering
 * fragments spell the column, the containment halves Sequelize qualifies.
 */
const TASK_METADATA_COLUMN = '"Task"."metadata"';

export const listTasks = async (args: {
  projectIds: number[];
  workflowId?: string;
  state?: string;
  statuses?: readonly ('open' | 'closed')[];
  // ORed, `null` included. `status=open` narrows a board; it does not say which
  // of those cards has an automation still dispatching.
  automationStatuses?: (TaskAutomationStatus | null)[];
  assignee?: string;
  /** Structured question about the bag; see {@link compileMetadataWhere}. */
  metadata?: MetadataFilter;
  limit?: number;
  offset?: number;
}) => {
  log(
    'listTasks: projectIds=%o workflowId=%s state=%s statuses=%o metadata=%o',
    args.projectIds,
    args.workflowId,
    args.state,
    args.statuses,
    args.metadata
  );
  const where: Record<string, unknown> = { projectId: args.projectIds };
  if (args.state) where.state = args.state;
  if (args.statuses?.length) where.status = args.statuses;
  if (args.assignee) where.assignee = args.assignee;

  if (args.automationStatuses?.length) {
    where.automationStatus = automationStatusWhere(args.automationStatuses);
  }

  applyFilterWhere({
    where,
    fragments: compileMetadataWhere({
      filter: args.metadata,
      column: TASK_METADATA_COLUMN,
    }),
  });

  if (args.workflowId) {
    const workflow = await db.Workflow.findOne({
      where: { publicId: args.workflowId },
    });
    // An unknown workflow filter yields an empty page rather than every task.
    where.workflowId = workflow ? (workflow.id as number) : -1;
  }

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['createdAt', 'DESC']],
    query: ({ limit, offset, order }) => {
      return db.Task.findAndCountAll({
        where,
        include: taskIncludes(),
        distinct: true,
        order,
        limit,
        offset,
      });
    },
    map: (t) => {
      return mapTask(t);
    },
  });
};
