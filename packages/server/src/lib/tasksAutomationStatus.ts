import { Op } from '@ttoss/postgresdb';

import { PAUSED_AUTOMATION_STATUS } from './tasksPause';

/**
 * Every non-null `automation_status` a task can hold, in one list so the board
 * listing's filter and the dispatch recorder cannot describe different sets.
 */
export const TASK_AUTOMATION_STATUSES = [
  'running',
  'completed',
  'failed',
  'unrouted',
  PAUSED_AUTOMATION_STATUS,
] as const;

export type TaskAutomationStatus = (typeof TASK_AUTOMATION_STATUSES)[number];

/**
 * How a caller asks for the tasks carrying no automation status at all.
 *
 * Not the literal `null` the field holds: the CLI's flag parser reads the token
 * `null` as JSON null for every nullable field it has, so a filter spelled that
 * way would reach the server as an empty value from one of its own clients.
 * A word no layer sniffs keeps one spelling working everywhere.
 */
export const AUTOMATION_STATUS_NONE = 'none';

/**
 * The `automationStatus` predicate for a set of requested values, ORed.
 *
 * `null` is one of them — a task that never entered a state with an automation
 * holds it, so the half of a board carrying it would otherwise be unaskable.
 * `IN (…, NULL)` never matches a NULL row, so that half is its own predicate
 * rather than another element of the list (#1242).
 */
export const automationStatusWhere = (
  statuses: (TaskAutomationStatus | null)[]
): unknown => {
  const named = statuses.filter((status) => {
    return status !== null;
  });
  if (named.length === statuses.length) return named;
  return {
    [Op.or]: [
      ...(named.length > 0 ? [{ [Op.in]: named }] : []),
      { [Op.is]: null },
    ],
  };
};
