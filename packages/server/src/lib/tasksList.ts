import createDebug from 'debug';
import { db } from 'src/db';

import { paginatedList } from './pagination';
import { type ProjectScope, projectScopeWhere } from './projectScope';
import {
  applyFilterWhere,
  compileStructuredWhere,
  type StructuredFilter,
} from './structuredFilter';
import {
  blockedWhereSql,
  readinessOf,
  type TaskReadiness,
} from './taskReadiness';
import { mapTask, taskIncludes, type TaskInstance } from './tasks';
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

type ListTasksArgs = Parameters<typeof listTasks>[0];

const listWhere = (args: ListTasksArgs): Record<string, unknown> => {
  const where: Record<string, unknown> = projectScopeWhere({
    projectIds: args.projectIds,
  });
  if (args.state) where.state = args.state;
  if (args.statuses?.length) where.status = args.statuses;
  if (args.assignee) where.assignee = args.assignee;

  if (args.automationStatuses?.length) {
    where.automationStatus = automationStatusWhere(args.automationStatuses);
  }

  applyFilterWhere({
    where,
    fragments: [
      ...compileStructuredWhere({
        filter: args.metadata,
        attribute: 'metadata',
        column: TASK_METADATA_COLUMN,
      }),
      ...(args.blocked === undefined
        ? []
        : [db.sequelize.literal(blockedWhereSql(args.blocked))]),
    ],
  });
  return where;
};

export const listTasks = async (args: {
  projectIds: ProjectScope;
  workflowId?: string;
  state?: string;
  statuses?: readonly ('open' | 'closed')[];
  // ORed, `null` included. `status=open` narrows a board; it does not say which
  // of those cards has an automation still dispatching.
  automationStatuses?: (TaskAutomationStatus | null)[];
  assignee?: string;
  /** Only tasks with (`true`) or without (`false`) an open dependency. */
  blocked?: boolean;
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
  const where = listWhere(args);

  if (args.workflowId) {
    const workflow = await db.Workflow.findOne({
      where: { publicId: args.workflowId },
    });
    // An unknown workflow filter yields an empty page rather than every task.
    where.workflowId = workflow ? (workflow.id as number) : -1;
  }

  let readiness = new Map<number, TaskReadiness>();
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: {
      projectIds: args.projectIds,
      workflowId: args.workflowId,
      state: args.state,
      statuses: args.statuses,
      automationStatuses: args.automationStatuses,
      assignee: args.assignee,
      blocked: args.blocked,
      metadata: args.metadata,
    },
    where,
    order: [['createdAt', 'DESC']],
    // A page's readiness in two queries rather than two per row.
    query: async ({ where: pageWhere, limit, order }) => {
      const rows = (await db.Task.findAll({
        where: pageWhere,
        include: taskIncludes(),
        order,
        limit,
      })) as TaskInstance[];
      readiness = await readinessOf({
        taskIds: rows.map((row) => {
          return row.id as number;
        }),
      });
      return rows;
    },
    map: (task) => {
      return mapTask({ task, readiness: readiness.get(task.id as number)! });
    },
  });
};
