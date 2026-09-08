/**
 * Every meter type the runtime records, in one place so a rule keyed on one —
 * a quota's meter scope, today — cannot admit a value no event will ever
 * carry. Each entry is written by exactly one recorder: `usageTokenEvent.ts`,
 * `usageComputeRecording.ts`, `usageRequests.ts` and `usageStorage.ts`.
 *
 * The price book's `meter_type` stays free-form: a price row names a SKU, and
 * refusing an unrecognised one would refuse pricing a meter added upstream
 * before this list heard of it.
 */

import { DEFAULT_METER_TYPE } from './priceCompute';

export const USAGE_METER_TYPES = [
  DEFAULT_METER_TYPE,
  'compute_execution',
  'api_request',
  'storage',
] as const;

export type UsageMeterType = (typeof USAGE_METER_TYPES)[number];

export const isUsageMeterType = (value: unknown): value is UsageMeterType => {
  return (
    typeof value === 'string' &&
    (USAGE_METER_TYPES as readonly string[]).includes(value)
  );
};
