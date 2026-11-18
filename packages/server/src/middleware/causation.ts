import type { Context } from '../Context';
import { runWithRequestCausation } from '../lib/causationHeader';

type Next = () => Promise<void>;

/** Restores the causal chain a request's signed causation header carries. */
export const causationMiddleware = (ctx: Context, next: Next) => {
  return runWithRequestCausation({ headers: ctx.headers ?? {}, fn: next });
};
