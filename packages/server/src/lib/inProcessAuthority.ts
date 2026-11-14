import type { IncomingMessage } from 'node:http';

import type { WorkAuthority } from './workAuthority';

/**
 * What an in-process request carries from the work making it: the authority
 * it runs under and the end user (actor) that work serves.
 */
export type AttachedWork = { authority: WorkAuthority; actor: string | null };

/**
 * Keyed by the request object itself: no header carries it, so nothing
 * outside the process can claim one.
 */
const ATTACHED = new WeakMap<IncomingMessage, AttachedWork>();

export const attachWork = (args: {
  req: IncomingMessage;
  work: AttachedWork;
}): void => {
  ATTACHED.set(args.req, args.work);
};

export const attachedWork = (
  req: IncomingMessage
): AttachedWork | undefined => {
  return ATTACHED.get(req);
};
