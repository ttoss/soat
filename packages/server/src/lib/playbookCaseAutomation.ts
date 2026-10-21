import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import type { Transaction } from './dbTransaction';

export const AUTOMATION_STATUSES = [
  'idle',
  'running',
  'waiting',
  'paused',
] as const;

type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

/**
 * The executors whose execution, once it names its `run_id`, waits on the task
 * or orchestration run it started. An agent names its generation while the
 * turn runs, so its `run_id` is the work itself, not a park.
 */
export const PARKING_EXECUTOR_TYPES = ['workflow', 'orchestration'] as const;

// A parked execution may wait on a person for as long as it takes; every other
// execution queued or running is the case's own work, the work that spends.
const PARKED = `status = 'running' AND run_id IS NOT NULL AND COALESCE(executor_type IN (${PARKING_EXECUTOR_TYPES.map(
  (type) => {
    return `'${type}'`;
  }
).join(', ')}), false)`;
const OWN_WORK = `status = 'queued' OR (status = 'running' AND NOT (${PARKED}))`;

const PAUSED_PROJECTS = () => {
  return db.sequelize.literal(
    '(SELECT id FROM projects WHERE paused_at IS NOT NULL)'
  );
};

const casesWhere = (condition: string) => {
  return db.sequelize.literal(
    `(SELECT case_id FROM playbook_executions WHERE ${condition})`
  );
};

/** Whether the case has work of its own in flight, read in `transaction`. */
export const caseHasOwnWork = async (args: {
  caseDbId: number;
  transaction: Transaction;
}): Promise<boolean> => {
  const found = await db.PlaybookExecution.findOne({
    where: {
      caseId: args.caseDbId,
      [Op.and]: [db.sequelize.literal(`(${OWN_WORK})`)],
    },
    attributes: ['id'],
    transaction: args.transaction,
  });
  return found !== null;
};

/**
 * `paused` while the case's pause or its project's stands, `running` while the
 * case has work of its own in flight, `waiting` while it only waits on tasks or
 * runs it started, else `idle`. What a spend stop lists to find a case doing
 * work.
 */
type CaseRow = {
  id?: unknown;
  pauseRequestedAt: Date | null;
  project: { pausedAt: Date | null };
};

export const caseAutomation = async (args: {
  rows: CaseRow[];
}): Promise<
  (row: CaseRow) => {
    automation_status: AutomationStatus;
    pause_requested_at: Date | null;
  }
> => {
  const [own, parked] = await Promise.all(
    [OWN_WORK, PARKED].map(async (condition) => {
      const found = await db.PlaybookExecution.findAll({
        where: {
          caseId: args.rows.map((row) => {
            return row.id as number;
          }),
          [Op.and]: [db.sequelize.literal(`(${condition})`)],
        },
        attributes: ['caseId'],
      });
      return new Set(
        found.map((execution) => {
          return execution.caseId;
        })
      );
    })
  );
  return (row) => {
    const id = row.id as number;
    const status: AutomationStatus =
      row.pauseRequestedAt || row.project.pausedAt
        ? 'paused'
        : own.has(id)
          ? 'running'
          : parked.has(id)
            ? 'waiting'
            : 'idle';
    return {
      automation_status: status,
      pause_requested_at: row.pauseRequestedAt,
    };
  };
};

const automationStatusWhere = (
  status: AutomationStatus
): Record<string | symbol, unknown> => {
  const projectPaused = {
    projectId: { [Op.in]: PAUSED_PROJECTS() },
  };
  if (status === 'paused') {
    return {
      [Op.or]: [{ pauseRequestedAt: { [Op.ne]: null } }, projectPaused],
    };
  }
  const has = (condition: string) => {
    return { id: { [Op.in]: casesWhere(condition) } };
  };
  const lacks = (condition: string) => {
    return { id: { [Op.notIn]: casesWhere(condition) } };
  };
  const conditions = {
    running: [has(OWN_WORK)],
    waiting: [lacks(OWN_WORK), has(PARKED)],
    idle: [lacks(OWN_WORK), lacks(PARKED)],
  }[status];
  return {
    pauseRequestedAt: null,
    [Op.and]: [{ projectId: { [Op.notIn]: PAUSED_PROJECTS() } }, ...conditions],
  };
};

/** The listing filter that selects exactly the cases `caseAutomation` names one of `statuses`. */
export const automationWhere = (
  statuses: readonly AutomationStatus[] | undefined
): Record<string | symbol, unknown> => {
  if (!statuses?.length) return {};
  return { [Op.or]: statuses.map(automationStatusWhere) };
};
