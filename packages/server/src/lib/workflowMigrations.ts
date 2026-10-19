import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { createSweep } from './scheduler';
import {
  INTERNAL_FAILURE,
  type StoredError,
  toStoredError,
} from './storedError';
import type { TaskPrincipal, TaskPrincipalKind } from './tasks';
import {
  assertStateMapTargets,
  loadVersionDefinition,
  migrateTask,
} from './tasksMigrate';

const log = createDebug('soat:workflowMigrations');

/**
 * Moving every open task of a workflow onto one of its versions.
 *
 * Each task goes through `migrateTask`, so it is refused for exactly the
 * reasons `POST /tasks/{id}/migrate` refuses it; a refusal settles that item,
 * never the run. The tasks and the caller's permission on each are fixed when
 * the run is recorded, before the request is answered.
 */

const LEASE_MS = 5 * 60_000;

/** Items settled between writes of the run's progress. */
const PROGRESS_EVERY = 25;

type MigrationRow = InstanceType<(typeof db)['WorkflowMigration']>;
type MigrationItem = MigrationRow['items'][number];

const FORBIDDEN_ITEM: StoredError = { code: 'FORBIDDEN', message: 'Forbidden' };

const leaseFromNow = () => {
  return new Date(Date.now() + LEASE_MS);
};

const countOf = (items: MigrationItem[], status: MigrationItem['status']) => {
  return items.filter((item) => {
    return item.status === status;
  }).length;
};

const mapWorkflowMigration = (args: {
  row: MigrationRow;
  workflowPublicId: string;
  projectPublicId: string;
}) => {
  const { row } = args;
  return {
    id: row.publicId,
    workflow_id: args.workflowPublicId,
    project_id: args.projectPublicId,
    to_version: row.toVersion,
    state_map: row.stateMap,
    status: row.status,
    task_count: row.items.length,
    migrated_count: countOf(row.items, 'migrated'),
    refused_count: countOf(row.items, 'refused'),
    tasks: row.items.map((item) => {
      return {
        task_id: item.taskPublicId,
        status: item.status,
        error: item.error,
      };
    }),
    created_by_principal_type: row.createdByPrincipalType,
    created_by_principal_id: row.createdByPrincipalId,
    created_at: row.createdAt,
    finished_at: row.finishedAt,
  };
};

const findWorkflowRow = async (args: { id: string }) => {
  const workflow = await db.Workflow.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Project, as: 'project', attributes: ['publicId'] }],
  });
  if (!workflow) {
    throw new DomainError(
      'WORKFLOW_NOT_FOUND',
      `Workflow '${args.id}' not found.`
    );
  }
  return workflow;
};

const readMigration = async (args: { workflowId: string; id: string }) => {
  const workflow = await findWorkflowRow({ id: args.workflowId });
  const row = await db.WorkflowMigration.findOne({
    where: { publicId: args.id, workflowId: workflow.id as number },
  });
  if (!row) {
    throw new DomainError(
      'WORKFLOW_MIGRATION_NOT_FOUND',
      `Workflow migration '${args.id}' not found.`
    );
  }
  return mapWorkflowMigration({
    row,
    workflowPublicId: workflow.publicId,
    projectPublicId: workflow.project.publicId,
  });
};

const settleItem = async (args: {
  row: MigrationRow;
  item: MigrationItem;
}): Promise<MigrationItem> => {
  const { row, item } = args;
  const task = await db.Task.findByPk(item.taskId, {
    attributes: ['workflowVersion'],
  });
  // A process that stopped after moving the task but before recording it.
  if (task?.workflowVersion === row.toVersion) {
    return { ...item, status: 'migrated', error: null };
  }
  try {
    await migrateTask({
      id: item.taskPublicId,
      toVersion: row.toVersion,
      stateMap: row.stateMap ?? undefined,
      principal: {
        kind: row.createdByPrincipalType as TaskPrincipalKind,
        id: row.createdByPrincipalId,
      },
    });
    return { ...item, status: 'migrated', error: null };
  } catch (error) {
    log('settleItem: %s refused %o', item.taskPublicId, error);
    return {
      ...item,
      status: 'refused',
      error: toStoredError({
        error,
        opaque: INTERNAL_FAILURE,
        label: 'workflow migration',
      }),
    };
  }
};

/**
 * Settles every `pending` item of a run, writing progress as it goes so a
 * stopped process leaves only the unsettled items for the next lease holder.
 */
const runWorkflowMigration = async (args: { id: number }): Promise<void> => {
  const row = (await db.WorkflowMigration.findByPk(args.id))!;
  log('runWorkflowMigration: %s', row.publicId);
  const items = [...row.items];
  await row.update({ status: 'running', leaseExpiresAt: leaseFromNow() });

  let unsaved = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].status !== 'pending') continue;
    items[index] = await settleItem({ row, item: items[index] });
    unsaved += 1;
    if (unsaved === PROGRESS_EVERY) {
      await row.update({ items: [...items], leaseExpiresAt: leaseFromNow() });
      unsaved = 0;
    }
  }
  await row.update({
    items,
    status: 'completed',
    leaseExpiresAt: null,
    finishedAt: new Date(),
  });
};

const runInBackground = async (args: { id: number }): Promise<void> => {
  try {
    await runWorkflowMigration(args);
  } catch (error) {
    log('runInBackground: %d did not settle %o', args.id, error);
  }
};

type MayMigrate = (task: { publicId: string }) => Promise<boolean>;

/** The open tasks behind `toVersion`, each pending or refused by permission. */
const selectItems = async (args: {
  workflowDbId: number;
  toVersion: number;
  mayMigrate: MayMigrate;
}): Promise<MigrationItem[]> => {
  const tasks = await db.Task.findAll({
    where: {
      workflowId: args.workflowDbId,
      status: 'open',
      [Op.or]: [
        { workflowVersion: null },
        { workflowVersion: { [Op.lt]: args.toVersion } },
      ],
    },
    attributes: ['id', 'publicId'],
    order: [['id', 'ASC']],
  });
  const items: MigrationItem[] = [];
  for (const task of tasks) {
    const allowed = await args.mayMigrate({ publicId: task.publicId });
    items.push({
      taskId: task.id as number,
      taskPublicId: task.publicId,
      status: allowed ? 'pending' : 'refused',
      error: allowed ? null : FORBIDDEN_ITEM,
    });
  }
  return items;
};

export const startWorkflowMigration = async (args: {
  workflowId: string;
  toVersion: number;
  stateMap?: Record<string, string>;
  wait: boolean;
  principal: TaskPrincipal;
  /** Whether the caller may migrate this task; one it may not is refused. */
  mayMigrate: MayMigrate;
}) => {
  log(
    'startWorkflowMigration: workflow=%s toVersion=%d wait=%s',
    args.workflowId,
    args.toVersion,
    args.wait
  );
  const workflow = await findWorkflowRow({ id: args.workflowId });
  const definition = await loadVersionDefinition({
    workflowDbId: workflow.id as number,
    version: args.toVersion,
  });
  assertStateMapTargets({ definition, stateMap: args.stateMap });

  const items = await selectItems({
    workflowDbId: workflow.id as number,
    toVersion: args.toVersion,
    mayMigrate: args.mayMigrate,
  });
  const settled = !items.some((item) => {
    return item.status === 'pending';
  });
  const row = await db.WorkflowMigration.create({
    workflowId: workflow.id as number,
    toVersion: args.toVersion,
    stateMap: args.stateMap ?? null,
    status: settled ? 'completed' : 'queued',
    items,
    createdByPrincipalType: args.principal.kind,
    createdByPrincipalId: args.principal.id,
    leaseExpiresAt: settled ? null : leaseFromNow(),
    finishedAt: settled ? new Date() : null,
  });
  const id = row.id as number;

  if (args.wait && !settled) await runWorkflowMigration({ id });
  const answer = await readMigration({
    workflowId: args.workflowId,
    id: row.publicId,
  });
  // Read before the run starts, so the answer is the one recorded.
  if (!args.wait && !settled) void runInBackground({ id });
  return answer;
};

export const getWorkflowMigration = async (args: {
  workflowId: string;
  id: string;
}) => {
  log('getWorkflowMigration: workflow=%s id=%s', args.workflowId, args.id);
  return readMigration(args);
};

/**
 * Resumes every run whose process stopped before it settled. Safe to repeat:
 * a settled item is never pending again, and a task already on the target
 * version settles as migrated without moving.
 */
export const resumeWorkflowMigrations = createSweep<MigrationRow>({
  log,
  name: 'resumeWorkflowMigrations',
  inFlight: new Set<number>(),
  findDue: ({ now, limit }) => {
    return db.WorkflowMigration.findAll({
      where: {
        status: ['queued', 'running'],
        leaseExpiresAt: { [Op.lt]: now },
      },
      order: [['leaseExpiresAt', 'ASC']],
      limit,
    });
  },
  idOf: (row) => {
    return row.id as number;
  },
  claim: async ({ row, now }) => {
    const [claimed] = await db.WorkflowMigration.update(
      { leaseExpiresAt: leaseFromNow() },
      {
        where: {
          id: row.id as number,
          status: ['queued', 'running'],
          leaseExpiresAt: { [Op.lt]: now },
        },
      }
    );
    return claimed > 0;
  },
  handle: ({ row }) => {
    return runWorkflowMigration({ id: row.id as number });
  },
});
