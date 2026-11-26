import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { nullableInWhere } from './nullableFilter';
import { firstPageOnly, paginatedList } from './pagination';
import { type ProjectScope, projectScopeWhere } from './projectScope';
import {
  applyFilterWhere,
  compileStructuredWhere,
  type StructuredFilter,
} from './structuredFilter';
import { linkWhereSql } from './taskLinks';
import {
  blockedWhereSql,
  readinessOf,
  type TaskReadiness,
  upstreamWhereSql,
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

/** The filters `listTasks` and `getTaskGraph` share. */
export type TaskListFilters = {
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
  /** Only the transitive dependencies of this task, not the task itself. */
  upstreamOf?: string;
  /**
   * Only the tasks this task links to; `any` / `none`: those some task links
   * to, or none does. `linkKind` narrows both link filters to one kind.
   */
  linkedFrom?: string;
  /** Only the tasks linking to this task; `any` / `none` as `linkedFrom`. */
  linkedTo?: string;
  linkKind?: string;
  /** Structured question about the bag; see {@link compileStructuredWhere}. */
  metadata?: StructuredFilter;
};

type TaskOrder = NonNullable<Parameters<typeof db.Task.findAll>[0]>['order'];

type ResolvedIds = {
  upstreamOfId?: number;
  linkedFromId?: number;
  linkedToId?: number;
};

const linkFragments = (args: TaskListFilters & ResolvedIds) => {
  const ends = [
    { side: 'from' as const, end: args.linkedFrom, endId: args.linkedFromId },
    { side: 'to' as const, end: args.linkedTo, endId: args.linkedToId },
  ];
  return ends.flatMap(({ side, end, endId }) => {
    if (end === undefined) return [];
    return [
      db.sequelize.literal(
        linkWhereSql({ side, end, endId, kind: args.linkKind })
      ),
    ];
  });
};

const listWhere = (
  args: TaskListFilters & ResolvedIds
): Record<string, unknown> => {
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
      ...(args.upstreamOfId === undefined
        ? []
        : [db.sequelize.literal(upstreamWhereSql(args.upstreamOfId))]),
      ...linkFragments(args),
    ],
  });
  return where;
};

/** An unknown id resolves to `-1`, so its filter yields nothing, not everything. */
const internalIdOf = (row: { id?: unknown } | null): number => {
  return row ? (row.id as number) : -1;
};

const byPublicId = (publicId: string) => {
  return { where: { publicId }, attributes: ['id'] };
};

const taskIdOf = async (publicId: string | undefined) => {
  if (publicId === undefined) return undefined;
  return internalIdOf(await db.Task.findOne(byPublicId(publicId)));
};

/** A link end's internal id; `any` and `none` name no task. */
const linkEndId = (end: string | undefined) => {
  return end === 'any' || end === 'none' ? undefined : taskIdOf(end);
};

/** The `where` every task-list read applies, over the `Task` alias. */
export const taskListWhere = async (
  args: TaskListFilters
): Promise<Record<string, unknown>> => {
  if (args.linkKind !== undefined && !args.linkedFrom && !args.linkedTo) {
    throw new DomainError(
      'VALIDATION_FAILED',
      '`link_kind` narrows `linked_from` or `linked_to`, and neither was given.',
      { parameter: 'link_kind' }
    );
  }
  const where = listWhere({
    ...args,
    upstreamOfId: await taskIdOf(args.upstreamOf),
    linkedFromId: await linkEndId(args.linkedFrom),
    linkedToId: await linkEndId(args.linkedTo),
  });
  if (args.workflowId) {
    where.workflowId = internalIdOf(
      await db.Workflow.findOne(byPublicId(args.workflowId))
    );
  }
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

export const listTasks = async (
  args: TaskListFilters & {
    /** Absent: newest first, paged by cursor. `next`: pull order, one page. */
    order?: TaskListOrder;
    limit?: number;
    cursor?: string;
  }
) => {
  log(
    'listTasks: projectIds=%o workflowId=%s state=%s statuses=%o upstreamOf=%s metadata=%o order=%s',
    args.projectIds,
    args.workflowId,
    args.state,
    args.statuses,
    args.upstreamOf,
    args.metadata,
    args.order
  );
  const where = await taskListWhere(args);

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
      upstreamOf: args.upstreamOf,
      linkedFrom: args.linkedFrom,
      linkedTo: args.linkedTo,
      linkKind: args.linkKind,
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
