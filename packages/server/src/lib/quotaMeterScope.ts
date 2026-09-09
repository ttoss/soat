/**
 * The meter a `cost_usd` quota answers for — its `meter_type` scope.
 *
 * Kept in its own module (like `quotaPricingPosture.ts`) so the rule has one
 * home and `quotas.ts` can re-export it: the REST route, the formation module,
 * and the enforcement check must never drift apart on what the scope means.
 *
 * The aggregate spans every priced meter when no scope is declared, which is
 * right for a deployment that bills its platform meters to the same tenant —
 * and is why the scope exists: a quota is unique per scope × metric × window,
 * so pricing a platform meter would otherwise re-point every tenant's one
 * project-wide spend cap at a quantity they never agreed it would measure.
 */

import { isUsageMeterType, USAGE_METER_TYPES } from './usageMeterTypes';

export { USAGE_METER_TYPES, type UsageMeterType } from './usageMeterTypes';

/**
 * `meter_type` is storable only where it can act, and only naming a meter that
 * is recorded. A scope on a metric with no cost dimension would be
 * accepted-but-inert; one naming an unrecorded meter would match no event, so
 * the cap would aggregate 0 forever — the silent no-op `SCOPES_BY_METRIC`
 * exists to make unrepresentable.
 */
export const validateMeterType = (args: {
  metric: string;
  meterType: unknown;
}): string | null => {
  if (args.meterType === undefined || args.meterType === null) return null;
  if (args.metric !== 'cost_usd') {
    return 'meter_type only applies to metric "cost_usd".';
  }
  if (!isUsageMeterType(args.meterType)) {
    return `meter_type must be one of ${USAGE_METER_TYPES.join(' / ')}.`;
  }
  return null;
};
