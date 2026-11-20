import type { IncomingMessage } from 'node:http';

import type { ParentToolCall } from './generationProgress';
import type { WorkAuthority } from './workAuthority';

/**
 * What an in-process request carries from the work making it: the authority
 * it runs under, the end user (actor) that work serves and, from a
 * generation's tool call, that call.
 */
export type AttachedWork = {
  authority: WorkAuthority;
  actor: string | null;
  call?: ParentToolCall | null;
};

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
