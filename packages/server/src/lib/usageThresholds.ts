import { Op, Sequelize } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { emitEvent, resolveProjectPublicId } from './eventBus';
import {
  paginatedList,
  type PaginatedResult,
  resolvePagination,
} from './pagination';

const log = createDebug('soat:usage:thresholds');

export const USAGE_THRESHOLD_METRICS = ['cost_usd', 'tokens'] as const;
export const USAGE_THRESHOLD_WINDOWS = [
  'calendar_month',
  'rolling_24h',
] as const;

export type UsageThresholdMetric = (typeof USAGE_THRESHOLD_METRICS)[number];
export type UsageThresholdWindow = (typeof USAGE_THRESHOLD_WINDOWS)[number];

// The webhook event fired when a project's windowed usage crosses a threshold.
export const USAGE_THRESHOLD_CROSSED_EVENT = 'usage.threshold_crossed';

// The token components that count toward a `tokens` threshold: input + output +
// cached (the non-billable `reasoning_tokens` detail is excluded).
const TOKEN_COMPONENTS = ['input_tokens', 'output_tokens', 'cached_tokens'];

// A fired rolling_24h threshold re-arms only once the windowed value falls below
// this fraction of the threshold (10% hysteresis band), preventing flapping.
const REARM_FRACTION = 0.9;

export type PersistedUsageThreshold = {
  id: string;
  projectId: string;
  metric: string;
  window: string;
  threshold: number;
  lastFiredAt: Date | null;
  firedWindowKey: string | null;
  createdAt: Date;
};

const mapThreshold = (
  threshold: InstanceType<(typeof db)['UsageThreshold']> & {
    project?: InstanceType<(typeof db)['Project']> | null;
  }
): PersistedUsageThreshold => {
  return {
    id: threshold.publicId,
    projectId: threshold.project?.publicId ?? '',
    metric: threshold.metric,
    window: threshold.window,
    threshold: Number(threshold.threshold),
    lastFiredAt: threshold.lastFiredAt,
    firedWindowKey: threshold.firedWindowKey,
    createdAt: threshold.createdAt,
  };
};

const isMetric = (value: string): value is UsageThresholdMetric => {
  return (USAGE_THRESHOLD_METRICS as readonly string[]).includes(value);
};

const isWindow = (value: string): value is UsageThresholdWindow => {
  return (USAGE_THRESHOLD_WINDOWS as readonly string[]).includes(value);
};

/**
 * Lists a project's usage thresholds. `projectIds` is the set the caller may
 * access (undefined = admin, no filter); an explicit `projectId` narrows to one
 * project when it is in scope, else yields an empty list.
 */
export const listThresholds = async (args: {
  projectIds?: number[];
  projectId?: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<PersistedUsageThreshold>> => {
  const emptyPage = () => {
    const { limit, offset } = resolvePagination(args);
    return { data: [], total: 0, limit, offset };
  };

  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) {
    if (args.projectIds.length === 0) return emptyPage();
    where.projectId = args.projectIds;
  }

  if (args.projectId !== undefined) {
    const project = await db.Project.findOne({
      where: { publicId: args.projectId },
    });
    if (!project) return emptyPage();
    const internalId = project.id as number;
    if (
      args.projectIds !== undefined &&
      !args.projectIds.includes(internalId)
    ) {
      return emptyPage();
    }
    where.projectId = internalId;
  }

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.UsageThreshold.findAndCountAll({
        where,
        include: [{ model: db.Project, as: 'project' }],
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: mapThreshold,
  });
};

/**
 * Creates a usage threshold on a project. `projectId` is the internal id the
 * caller has already resolved (and authorized). Validates the metric, window,
 * and a strictly positive threshold.
 */
export const createThreshold = async (args: {
  projectId: number;
  metric: string;
  window: string;
  threshold: number;
}): Promise<PersistedUsageThreshold> => {
  if (!isMetric(args.metric)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `metric must be one of ${USAGE_THRESHOLD_METRICS.join(', ')} (got '${
        args.metric
      }').`
    );
  }
  if (!isWindow(args.window)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `window must be one of ${USAGE_THRESHOLD_WINDOWS.join(', ')} (got '${
        args.window
      }').`
    );
  }
  if (typeof args.threshold !== 'number' || !(args.threshold > 0)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `threshold must be a number greater than 0 (got '${args.threshold}').`
    );
  }

  log(
    'createThreshold: projectId=%d metric=%s window=%s threshold=%d',
    args.projectId,
    args.metric,
    args.window,
    args.threshold
  );

  const created = await db.UsageThreshold.create({
    projectId: args.projectId,
    metric: args.metric,
    window: args.window,
    threshold: String(args.threshold),
    lastFiredAt: null,
    firedWindowKey: null,
  });

  const withProject = await db.UsageThreshold.findOne({
    where: { id: created.id },
    include: [{ model: db.Project, as: 'project' }],
  });
  return mapThreshold(withProject!);
};

/**
 * Deletes a threshold by public id within the caller's scope, resetting its
 * fire state (the row is removed). Returns false when it is not visible.
 */
export const deleteThreshold = async (args: {
  id: string;
  projectIds?: number[];
}): Promise<boolean> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    if (args.projectIds.length === 0) return false;
    where.projectId = args.projectIds;
  }
  const threshold = await db.UsageThreshold.findOne({ where });
  if (!threshold) return false;
  await threshold.destroy();
  log('deleteThreshold: id=%s', args.id);
  return true;
};

// The UTC start of the window and its key (YYYY-MM for calendar_month, null for
// rolling_24h) given the evaluation instant.
const windowBounds = (
  window: UsageThresholdWindow,
  now: Date
): { start: Date; key: string | null } => {
  if (window === 'calendar_month') {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    );
    const key = `${now.getUTCFullYear()}-${String(
      now.getUTCMonth() + 1
    ).padStart(2, '0')}`;
    return { start, key };
  }
  return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), key: null };
};

// Reads a `total` aggregate off the first row (null/absent → 0). `getDataValue`
// returns the SUM alias without needing `raw`, avoiding a cast on the result.
const readTotal = (
  row: { getDataValue: (key: string) => unknown } | undefined
) => {
  const total = row?.getDataValue('total');
  return total === null || total === undefined ? 0 : Number(total);
};

// Sums the windowed cost across all meter types (nulls ignored by SUM).
// Exported for the guardrail `soat.usage.cost_usd_*` context providers, which
// sum the same events over their own rolling windows.
export const windowedCostUsd = async (args: {
  projectId: number;
  start: Date;
}): Promise<number> => {
  const rows = await db.UsageEvent.findAll({
    where: { projectId: args.projectId, createdAt: { [Op.gte]: args.start } },
    attributes: [[Sequelize.fn('SUM', Sequelize.col('cost_usd')), 'total']],
  });
  return readTotal(rows[0]);
};

// Sums the windowed billable token count (input + output + cached). Resolves the
// window's event ids first, then sums their token components — avoids a
// join+aggregate whose column alias is brittle across Sequelize versions.
// Exported for the guardrail `soat.usage.tokens_*` context providers.
export const windowedTokens = async (args: {
  projectId: number;
  start: Date;
}): Promise<number> => {
  const events = await db.UsageEvent.findAll({
    where: { projectId: args.projectId, createdAt: { [Op.gte]: args.start } },
    attributes: ['id'],
  });
  const eventIds = events.map((event) => {
    return event.id;
  });
  if (eventIds.length === 0) return 0;

  const rows = await db.UsageComponent.findAll({
    where: {
      usageEventId: { [Op.in]: eventIds },
      component: { [Op.in]: TOKEN_COMPONENTS },
    },
    attributes: [[Sequelize.fn('SUM', Sequelize.col('quantity')), 'total']],
  });
  return readTotal(rows[0]);
};

const windowedValue = (args: {
  metric: string;
  projectId: number;
  start: Date;
}): Promise<number> => {
  if (args.metric === 'cost_usd') {
    return windowedCostUsd({ projectId: args.projectId, start: args.start });
  }
  return windowedTokens({ projectId: args.projectId, start: args.start });
};

type ThresholdInstance = InstanceType<(typeof db)['UsageThreshold']>;

// Applies the hysteresis state machine to one threshold, mutating its fire
// state in the DB. Returns the window key to report when it fires this round,
// or null when it does not fire (either not crossed, already fired this window,
// or a rolling window re-arming).
const applyFireDecision = async (args: {
  threshold: ThresholdInstance;
  value: number;
  windowKey: string | null;
  now: Date;
}): Promise<{ fired: boolean; windowKey: string | null }> => {
  const { threshold, value, windowKey, now } = args;
  const limit = Number(threshold.threshold);

  if (threshold.window === 'calendar_month') {
    // Usage only grows within a calendar window, so fire at most once per key.
    const alreadyFired = threshold.firedWindowKey === windowKey;
    if (!alreadyFired && value >= limit) {
      await threshold.update({ lastFiredAt: now, firedWindowKey: windowKey });
      return { fired: true, windowKey };
    }
    return { fired: false, windowKey: null };
  }

  // rolling_24h — the windowed value can fall, so a fired threshold re-arms only
  // once it drops below 90% of the limit; `lastFiredAt` marks the fired state.
  const fired = threshold.lastFiredAt !== null;
  if (fired) {
    if (value < REARM_FRACTION * limit) {
      await threshold.update({ lastFiredAt: null });
    }
    return { fired: false, windowKey: null };
  }
  if (value >= limit) {
    await threshold.update({ lastFiredAt: now });
    return { fired: true, windowKey: null };
  }
  return { fired: false, windowKey: null };
};

// Emits the `usage.threshold_crossed` webhook event. The payload data uses
// snake_case keys to match the documented webhook contract.
const emitThresholdCrossed = (args: {
  threshold: ThresholdInstance;
  projectId: number;
  projectPublicId: string;
  windowKey: string | null;
  observedValue: number;
  now: Date;
}): void => {
  const { threshold } = args;
  emitEvent({
    type: USAGE_THRESHOLD_CROSSED_EVENT,
    projectId: args.projectId,
    projectPublicId: args.projectPublicId,
    resourceType: 'usage_threshold',
    resourceId: threshold.publicId,
    data: {
      threshold_id: threshold.publicId,
      project_id: args.projectPublicId,
      metric: threshold.metric,
      window: threshold.window,
      window_key: args.windowKey,
      threshold: Number(threshold.threshold),
      observed_value: args.observedValue,
    },
    timestamp: args.now.toISOString(),
  });
};

/**
 * Evaluates every threshold on a project against its windowed usage and fires
 * the `usage.threshold_crossed` webhook for any that cross, honoring the
 * once-per-window (calendar) / 10% re-arm (rolling) hysteresis. Called
 * synchronously after each usage-event write — the single metering choke point.
 * Never throws: threshold evaluation must not fail the write it follows.
 */
export const evaluateProjectThresholds = async (args: {
  projectId: number;
}): Promise<void> => {
  try {
    const thresholds = await db.UsageThreshold.findAll({
      where: { projectId: args.projectId },
      order: [['id', 'ASC']],
    });
    if (thresholds.length === 0) return;

    const now = new Date();
    let projectPublicId: string | null = null;

    for (const threshold of thresholds) {
      const window = threshold.window as UsageThresholdWindow;
      const { start, key } = windowBounds(window, now);
      const value = await windowedValue({
        metric: threshold.metric,
        projectId: args.projectId,
        start,
      });

      const decision = await applyFireDecision({
        threshold,
        value,
        windowKey: key,
        now,
      });

      if (!decision.fired) continue;

      if (projectPublicId === null) {
        projectPublicId = await resolveProjectPublicId({
          projectId: args.projectId,
        });
      }

      log(
        'evaluateProjectThresholds: fired id=%s metric=%s window=%s value=%d',
        threshold.publicId,
        threshold.metric,
        threshold.window,
        value
      );

      emitThresholdCrossed({
        threshold,
        projectId: args.projectId,
        projectPublicId,
        windowKey: decision.windowKey,
        observedValue: value,
        now,
      });
    }
  } catch (error) {
    log(
      'evaluateProjectThresholds: failed projectId=%d error=%s',
      args.projectId,
      error instanceof Error ? error.message : String(error)
    );
  }
};
