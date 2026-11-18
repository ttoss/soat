import createDebug from 'debug';
import { db } from 'src/db';

import { nullableInWhere } from './nullableFilter';
import { firstPageOnly, paginatedList } from './pagination';
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
import { type TaskAutomationStatus } from './tasksAutomationStatus';
import { type TaskPriority } from './tasksPriority';
import { pullOrder, type TaskListOrder } from './tasksPullOrder';

const log = createDebug('soat:tasks');

/**
 * The task list roots its query at the `Task` alias; only the ordering
 * fragments spell the column, the containment halves Sequelize qualifies.
 */
const TASK_METADATA_COLUMN = '"Task"."metadata"';

type ListTasksArgs = Parameters<typeof listTasks>[0];
type TaskOrder = NonNullable<Parameters<typeof db.Task.findAll>[0]>['order'];

const listWhere = (args: ListTasksArgs): Record<string, unknown> => {
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

/** A page's rows and their readiness, in two queries rather than two per row. */
const pageReader = () => {
  let readiness = new Map<number, TaskReadiness>();
  const read = async (page: {
    where: Record<string, unknown> | undefined;
    limit: number;
    order: TaskOrder;
  }) => {
    const rows = (await db.Task.findAll({
      where: page.where,
      include: taskIncludes(),
      order: page.order,
      limit: page.limit,
    })) as TaskInstance[];
    readiness = await readinessOf({
      taskIds: rows.map((row) => {
        return row.id as number;
      }),
    });
    return rows;
  };
  const map = (task: TaskInstance) => {
    return mapTask({ task, readiness: readiness.get(task.id as number)! });
  };
  return { read, map };
};

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
  /** Only tasks with (`true`) or without (`false`) an open dependency. */
  blocked?: boolean;
  /** Structured question about the bag; see {@link compileStructuredWhere}. */
  metadata?: StructuredFilter;
  /** Absent: newest first, paged by cursor. `next`: pull order, one page. */
  order?: TaskListOrder;
  limit?: number;
  cursor?: string;
}) => {
  log(
    'listTasks: projectIds=%o workflowId=%s state=%s statuses=%o metadata=%o order=%s',
    args.projectIds,
    args.workflowId,
    args.state,
    args.statuses,
    args.metadata,
    args.order
  );
  const where = listWhere(args);

  if (args.workflowId) {
    const workflow = await db.Workflow.findOne({
      where: { publicId: args.workflowId },
    });
    // An unknown workflow filter yields an empty page rather than every task.
    where.workflowId = workflow ? (workflow.id as number) : -1;
  }

  const { read, map } = pageReader();
  if (args.order === 'next') {
    return firstPageOnly({
      limit: args.limit,
      cursor: args.cursor,
      reason: '`order=next` is computed on every read and answers one page',
      query: ({ limit }) => {
        return read({ where, limit, order: pullOrder() });
      },
      map,
    });
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
      blocked: args.blocked,
      metadata: args.metadata,
    },
    where,
    order: [['createdAt', 'DESC']],
    query: ({ where: pageWhere, limit, order }) => {
      return read({ where: pageWhere, limit, order });
    },
    map,
  });
};
