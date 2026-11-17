import createDebug from 'debug';
import { db } from 'src/db';

import { nullableInWhere } from './nullableFilter';
import { paginatedList } from './pagination';
import { type ProjectScope, projectScopeWhere } from './projectScope';
import {
  applyFilterWhere,
  compileStructuredWhere,
  type StructuredFilter,
} from './structuredFilter';
import { mapTask, taskIncludes } from './tasks';
import { type TaskAutomationStatus } from './tasksAutomationStatus';
import { type TaskPriority } from './tasksPriority';

const log = createDebug('soat:tasks');

/**
 * The task list roots its query at the `Task` alias; only the ordering
 * fragments spell the column, the containment halves Sequelize qualifies.
 */
const TASK_METADATA_COLUMN = '"Task"."metadata"';

export const listTasks = async (args: {
  projectIds: ProjectScope;
  workflowId?: string;
  state?: string;
  statuses?: readonly ('open' | 'closed')[];
  // ORed, `null` included. `status=open` narrows a board; it does not say which
  // of those cards has an automation still dispatching.
  automationStatuses?: (TaskAutomationStatus | null)[];
  // ORed, `null` included, as `automationStatuses`.
  priorities?: (TaskPriority | null)[];
  assignee?: string;
  /** Structured question about the bag; see {@link compileStructuredWhere}. */
  metadata?: StructuredFilter;
  limit?: number;
  cursor?: string;
}) => {
  log(
    'listTasks: projectIds=%o workflowId=%s state=%s statuses=%o metadata=%o',
    args.projectIds,
    args.workflowId,
    args.state,
    args.statuses,
    args.metadata
  );
  const where: Record<string, unknown> = projectScopeWhere({
    projectIds: args.projectIds,
  });
  if (args.state) where.state = args.state;
  if (args.statuses?.length) where.status = args.statuses;
  if (args.assignee) where.assignee = args.assignee;

  const nullableFilters = {
    automationStatus: args.automationStatuses,
    priority: args.priorities,
  };
  for (const [column, values] of Object.entries(nullableFilters)) {
    if (values?.length) where[column] = nullableInWhere(values);
  }

  applyFilterWhere({
    where,
    fragments: compileStructuredWhere({
      filter: args.metadata,
      attribute: 'metadata',
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
    cursor: args.cursor,
    filters: {
      projectIds: args.projectIds,
      workflowId: args.workflowId,
      state: args.state,
      statuses: args.statuses,
      automationStatuses: args.automationStatuses,
      priorities: args.priorities,
      assignee: args.assignee,
      metadata: args.metadata,
    },
    where,
    order: [['createdAt', 'DESC']],
    query: ({ where: pageWhere, limit, order }) => {
      return db.Task.findAll({
        where: pageWhere,
        include: taskIncludes(),
        order,
        limit,
      });
    },
    map: (t) => {
      return mapTask(t);
    },
  });
};
