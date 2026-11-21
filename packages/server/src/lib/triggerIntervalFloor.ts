import { Cron } from 'croner';
import { db } from 'src/db';

import { DomainError } from '../errors';

/**
 * Firings sampled for the tightest pair: enough that a monthly pattern spans
 * two years, so a short February and a 30-versus-31-day pair are both seen.
 * The sample starts at a fixed instant so one cron always measures the same.
 */
const SAMPLED_FIRINGS = 25;

const SAMPLE_FROM = new Date('2000-01-01T00:00:00Z');

/**
 * Seconds between a cron's two closest firings, read with the parser the
 * scheduler fires with. `null` when it has fewer than two firings.
 */
export const cronIntervalSeconds = (cron: string): number | null => {
  const firings = new Cron(cron, { timezone: 'UTC' }).nextRuns(
    SAMPLED_FIRINGS,
    SAMPLE_FROM
  );
  let smallest: number | null = null;
  for (let i = 1; i < firings.length; i += 1) {
    const gap = (firings[i].getTime() - firings[i - 1].getTime()) / 1000;
    if (smallest === null || gap < smallest) smallest = gap;
  }
  return smallest;
};

/**
 * Refuses a schedule `cron` that fires more often than its project's
 * `minTriggerIntervalSeconds`. Expects a cron `validateCronExpression` passed.
 */
export const assertCronMeetsIntervalFloor = async (args: {
  projectId: number;
  cron: string;
}): Promise<void> => {
  const project = await db.Project.findByPk(args.projectId, {
    attributes: ['minTriggerIntervalSeconds'],
  });
  const floor = project?.minTriggerIntervalSeconds ?? null;
  if (floor === null) return;

  const interval = cronIntervalSeconds(args.cron);
  if (interval === null || interval >= floor) return;

  throw new DomainError(
    'TRIGGER_INTERVAL_BELOW_FLOOR',
    `The cron fires every ${interval}s; this project's floor is ${floor}s.`,
    {
      min_trigger_interval_seconds: floor,
      interval_seconds: interval,
      cron: args.cron,
    }
  );
};
