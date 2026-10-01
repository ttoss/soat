import { DomainError } from '../errors';
import { QUOTA_WINDOWS, type QuotaWindow } from './quotaWindows';

/** The calls each acceptance of a share may make per fixed window. */
export type ShareCap = { calls: number; window: QuotaWindow };

const isQuotaWindow = (value: unknown): value is QuotaWindow => {
  return QUOTA_WINDOWS.some((window) => {
    return window === value;
  });
};

/** A cap from a request body; `null` clears it. */
export const parseShareCap = (cap: unknown): ShareCap | null => {
  if (cap === null) return null;
  const calls =
    typeof cap === 'object' && 'calls' in cap ? cap.calls : undefined;
  const window =
    typeof cap === 'object' && 'window' in cap ? cap.window : undefined;
  if (
    typeof calls !== 'number' ||
    !Number.isInteger(calls) ||
    calls < 1 ||
    !isQuotaWindow(window)
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `cap must be { calls, window }: calls a positive integer, window one of ${QUOTA_WINDOWS.join(', ')}.`,
      { field: 'cap' }
    );
  }
  return { calls, window };
};
