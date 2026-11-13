import type { IncomingMessage } from 'node:http';

import type { WorkAuthority } from './workAuthority';

/**
 * The authority an in-process request runs under, keyed by the request
 * object itself: no header carries it, so nothing outside the process can
 * claim one.
 */
const AUTHORITIES = new WeakMap<IncomingMessage, WorkAuthority>();

export const attachWorkAuthority = (args: {
  req: IncomingMessage;
  authority: WorkAuthority;
}): void => {
  AUTHORITIES.set(args.req, args.authority);
};

export const attachedWorkAuthority = (
  req: IncomingMessage | undefined
): WorkAuthority | undefined => {
  return req ? AUTHORITIES.get(req) : undefined;
};
