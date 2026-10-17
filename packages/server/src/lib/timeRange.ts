import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

const log = createDebug('soat:timeRange');

/**
 * The column predicate for a `from`/`to` list filter, or `undefined` when
 * neither bound is given. Both bounds are inclusive, so a range whose `from`
 * and `to` are one row's own timestamp selects that row.
 */
export const timeRangeWhere = (args: {
  from?: Date;
  to?: Date;
}): Record<symbol, Date> | undefined => {
  if (!args.from && !args.to) return undefined;
  log('timeRangeWhere: from=%s to=%s', args.from, args.to);
  return {
    ...(args.from ? { [Op.gte]: args.from } : {}),
    ...(args.to ? { [Op.lte]: args.to } : {}),
  };
};
