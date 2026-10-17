import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { DomainError } from '../errors';

export const AUTOMATION_STATUSES = [
  'idle',
  'running',
  'waiting',
  'paused',
] as const;

type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

const isAutomationStatus = (value: string): value is AutomationStatus => {
  return (AUTOMATION_STATUSES as readonly string[]).includes(value);
};

// The case's own work: an execution queued, or running its executor itself.
// One running with a `run_id` is parked on the task or run it started, which
// is what spends and may wait on a person for as long as it takes.
const OWN_WORK = "status = 'queued' OR (status = 'running' AND run_id IS NULL)";
const PARKED = "status = 'running' AND run_id IS NOT NULL";

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
/** The listing filter that selects exactly the cases `caseAutomation` names `status`. */
export const automationWhere = (
  status: string | undefined
): Record<string | symbol, unknown> => {
  if (status === undefined) return {};
  if (!isAutomationStatus(status)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `automation_status must be one of ${AUTOMATION_STATUSES.join(', ')}.`
    );
  }
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
