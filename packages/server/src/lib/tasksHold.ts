import createDebug from 'debug';

import { DomainError } from '../errors';
import { findTaskInstance, presentTask } from './tasks';

const log = createDebug('soat:tasks');

export type TaskHold = { until: Date; reason: string | null } | null;

const invalid = (field: string, message: string) => {
  return new DomainError('VALIDATION_FAILED', message, {
    invalid_fields: [field],
  });
};

const parseReason = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  throw invalid('hold_reason', '`hold_reason` must be a string or null');
};

const parseUntil = (args: { value: unknown; now: Date }): Date => {
  const until = typeof args.value === 'string' ? new Date(args.value) : null;
  if (!until || Number.isNaN(until.getTime())) {
    throw invalid('hold_until', '`hold_until` must be a date-time or null');
  }
  if (until.getTime() <= args.now.getTime()) {
    throw invalid('hold_until', '`hold_until` must be in the future');
  }
  return until;
};

/**
 * A body's hold: a future `hold_until` with an optional `hold_reason`, or
 * `null` to clear it. A past date is refused rather than cleared at once.
 */
export const parseTaskHold = (args: {
  until: unknown;
  reason: unknown;
}): TaskHold => {
  const reason = parseReason(args.reason);
  if (args.until === undefined || args.until === null) {
    if (reason !== null) {
      throw invalid('hold_reason', '`hold_reason` needs a `hold_until`');
    }
    return null;
  }
  return { until: parseUntil({ value: args.until, now: new Date() }), reason };
};

export const setTaskHold = async (args: { id: string; hold: TaskHold }) => {
  log('setTaskHold: id=%s until=%s', args.id, args.hold?.until);
  const task = await findTaskInstance({ id: args.id });
  if (!task) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }
  task.holdUntil = args.hold?.until ?? null;
  task.holdReason = args.hold?.reason ?? null;
  await task.save();
  return presentTask({ task });
};
