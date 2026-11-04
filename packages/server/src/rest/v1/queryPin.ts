import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';

/**
 * A query parameter that confines a call. A repeated one is refused rather
 * than read as absent, which would drop the pin.
 */
export const readQueryPin = (
  ctx: Context,
  name: string
): string | undefined => {
  const value = ctx.query[name];
  if (value === undefined || typeof value === 'string') return value;
  throw new DomainError(
    'VALIDATION_FAILED',
    `${name} must be given at most once.`
  );
};

/** The directory a document write or by-id call is pinned to. */
export const readPathPin = (ctx: Context): string | undefined => {
  return readQueryPin(ctx, 'path_prefix');
};
