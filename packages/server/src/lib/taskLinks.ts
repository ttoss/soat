import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';
import { paginatedList } from './pagination';
import { createdByColumns, servedPrincipal } from './principals';
import { appendTaskHistory } from './taskHistory';
import {
  findTaskInstance,
  recordedTaskPrincipal,
  type TaskInstance,
  type TaskPrincipal,
} from './tasks';

const log = createDebug('soat:tasks');

/** A link's kind is the caller's vocabulary; Soat only bounds its shape. */
export const TASK_LINK_KIND_PATTERN = /^[a-z_]{1,32}$/;

export type TaskLinkDirection = 'out' | 'in';

type TaskRow = InstanceType<(typeof db)['Task']>;
type LinkRow = InstanceType<(typeof db)['TaskLink']> & {
  fromTask?: TaskRow;
  toTask?: TaskRow;
};

const taskRef = (task: TaskRow) => {
  return {
    id: task.publicId,
    title: task.title,
    state: task.state,
    status: task.status,
  };
};

const mapLink = (row: LinkRow) => {
  return {
    kind: row.kind,
    from_task: taskRef(row.fromTask!),
    to_task: taskRef(row.toTask!),
    note: row.note,
    ...servedPrincipal({
      row,
      prefix: 'createdBy',
      wire: 'created_by_',
    }),
    created_at: row.createdAt,
  };
};

const linkIncludes = () => {
  return [
    { model: db.Task, as: 'fromTask' },
    { model: db.Task, as: 'toTask' },
  ];
};

export const assertTaskLinkKind = (kind: unknown): string => {
  if (typeof kind !== 'string' || !TASK_LINK_KIND_PATTERN.test(kind)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      '`kind` must match ^[a-z_]{1,32}$.',
      { field: 'kind' }
    );
  }
  return kind;
};

const requireTask = async (args: { id: string }): Promise<TaskInstance> => {
  const task = await findTaskInstance({ id: args.id });
  if (!task) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }
  return task;
};

/** One history row on each end, so either task's history shows the link. */
const recordLink = async (args: {
  action: 'added' | 'removed';
  kind: string;
  from: TaskRow;
  to: TaskRow;
  principal: TaskPrincipal;
  transaction: Transaction;
}) => {
  const link = {
    action: args.action,
    kind: args.kind,
    from_task_id: args.from.publicId,
    to_task_id: args.to.publicId,
  };
  for (const task of [args.from, args.to]) {
    await appendTaskHistory({
      row: {
        taskId: task.id as number,
        fromState: task.state,
        toState: task.state,
        transition: null,
        principalType: args.principal.kind,
        principalId: args.principal.id,
        generationId: null,
        orchestrationRunId: null,
        note: null,
        link,
      },
      actsFor: args.principal.actsFor,
      transaction: args.transaction,
    });
  }
};

/**
 * `created` is false when the link already held: the existing one answers,
 * unchanged. Either end may be closed: a link records provenance.
 */
export const addTaskLink = async (args: {
  taskId: string;
  toTaskId: string;
  kind: string;
  note?: string | null;
  principal: TaskPrincipal;
}) => {
  log('addTaskLink: %s -%s-> %s', args.taskId, args.kind, args.toTaskId);
  const kind = assertTaskLinkKind(args.kind);
  const from = await requireTask({ id: args.taskId });
  if (args.toTaskId === args.taskId) {
    throw new DomainError(
      'TASK_LINK_SELF',
      `Task '${args.taskId}' cannot link to itself.`
    );
  }
  const to = await db.Task.findOne({
    where: { publicId: args.toTaskId, projectId: from.projectId },
  });
  if (!to) {
    throw new DomainError(
      'TASK_LINK_TARGET_NOT_FOUND',
      `Task '${args.toTaskId}' not found in the project of '${args.taskId}'.`,
      { to_task_id: args.toTaskId }
    );
  }

  const { id, created } = await db.sequelize.transaction(async (t) => {
    const [row, isNew] = await db.TaskLink.findOrCreate({
      where: { fromTaskId: from.id as number, toTaskId: to.id as number, kind },
      defaults: {
        fromTaskId: from.id as number,
        toTaskId: to.id as number,
        kind,
        note: args.note ?? null,
        ...createdByColumns(recordedTaskPrincipal(args.principal)),
      },
      transaction: t,
    });
    if (isNew) {
      await recordLink({
        action: 'added',
        kind,
        from,
        to,
        principal: args.principal,
        transaction: t,
      });
    }
    return { id: row.id as number, created: isNew };
  });

  const row = await db.TaskLink.findByPk(id, { include: linkIncludes() });
  return { link: mapLink(row as LinkRow), created };
};

/** Both directions unless `direction` names one; oldest first. */
export const listTaskLinks = async (args: {
  taskId: string;
  direction?: TaskLinkDirection;
  kind?: string;
  limit?: number;
  cursor?: string;
}) => {
  log('listTaskLinks: task=%s %s %s', args.taskId, args.direction, args.kind);
  const kind =
    args.kind === undefined ? undefined : assertTaskLinkKind(args.kind);
  const task = await requireTask({ id: args.taskId });
  const id = task.id as number;
  const ends = {
    out: { fromTaskId: id },
    in: { toTaskId: id },
  };
  const where: Record<string | symbol, unknown> = args.direction
    ? { ...ends[args.direction] }
    : { [Op.or]: [ends.out, ends.in] };
  if (kind) where.kind = kind;
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: { id: args.taskId, direction: args.direction, kind },
    where,
    order: [['createdAt', 'ASC']],
    // A link's identity is its triple; the internal id only orders the page.
    tiebreak: ['id'],
    query: ({ where: pageWhere, limit, order }) => {
      return db.TaskLink.findAll({
        where: pageWhere,
        limit,
        order,
        include: linkIncludes(),
      });
    },
    map: (row) => {
      return mapLink(row as LinkRow);
    },
  });
};

/** Idempotent: a link already gone, or a task it named, removes nothing. */
export const removeTaskLink = async (args: {
  taskId: string;
  toTaskId: string;
  kind: string;
  principal: TaskPrincipal;
}): Promise<void> => {
  log('removeTaskLink: %s -%s-> %s', args.taskId, args.kind, args.toTaskId);
  const kind = assertTaskLinkKind(args.kind);
  const from = await requireTask({ id: args.taskId });
  await db.sequelize.transaction(async (t) => {
    const row = (await db.TaskLink.findOne({
      where: { fromTaskId: from.id as number, kind },
      include: [
        { model: db.Task, as: 'toTask', where: { publicId: args.toTaskId } },
      ],
      transaction: t,
    })) as LinkRow | null;
    if (!row) return;
    await row.destroy({ transaction: t });
    await recordLink({
      action: 'removed',
      kind,
      from,
      to: row.toTask!,
      principal: args.principal,
      transaction: t,
    });
  });
};

/**
 * The `listTasks` link filter's SQL, over the list's `Task` alias. `endId` is
 * the internal id a task end resolved to, `-1` when it names none.
 */
export const linkWhereSql = (args: {
  /** `from`: the end the links start at; the listed tasks are their targets. */
  side: 'from' | 'to';
  /** A task's public id, or `any` / `none` task. */
  end: string;
  endId?: number;
  kind?: string;
}): string => {
  const [given, listed] =
    args.side === 'from'
      ? ['from_task_id', 'to_task_id']
      : ['to_task_id', 'from_task_id'];
  const kind = args.kind
    ? ` AND l.kind = ${db.sequelize.escape(assertTaskLinkKind(args.kind))}`
    : '';
  if (args.end === 'any' || args.end === 'none') {
    return `${args.end === 'none' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM task_links l
       WHERE l.${listed} = "Task"."id"${kind})`;
  }
  return `"Task"."id" IN (SELECT l.${listed} FROM task_links l
     WHERE l.${given} = ${Math.trunc(args.endId ?? -1)}${kind})`;
};
