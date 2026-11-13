import type { IncomingMessage } from 'node:http';

import type { ResolvedCredential } from './authOnBehalfOf';

/**
 * A credential handed to an in-process request as a value, never as a
 * header: keyed by the request object itself, so nothing a client sends can
 * name or forge one.
 */
const CREDENTIALS = new WeakMap<IncomingMessage, ResolvedCredential>();

export const attachInProcessCredential = (args: {
  req: IncomingMessage;
  credential: ResolvedCredential;
}): void => {
  CREDENTIALS.set(args.req, args.credential);
};

export const inProcessCredentialOf = (
  req: IncomingMessage
): ResolvedCredential | undefined => {
  return CREDENTIALS.get(req);
};
