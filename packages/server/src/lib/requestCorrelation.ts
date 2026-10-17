import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * The `X-Request-Id` of the work executing, so an outbound tool request names
 * it without every caller threading it through. A request's own id, kept by
 * what it leaves running in the background; else the id of the job run.
 */
const requestIdStore = new AsyncLocalStorage<string>();

/** The request id in scope, or `undefined` outside any request or job. */
export const currentRequestId = (): string | undefined => {
  return requestIdStore.getStore();
};

/** Runs `fn` with `requestId` in scope for everything it awaits. */
export const runWithRequestId = <T>(args: {
  requestId: string;
  fn: () => T;
}): T => {
  return requestIdStore.run(args.requestId, args.fn);
};

/**
 * Runs one unit of background work (a sweep, a claimed row, a queue task)
 * under a fresh id: a drain kicked by a request also drives other runs' work.
 */
export const runAsJob = <T>(fn: () => T): T => {
  return runWithRequestId({ requestId: randomUUID(), fn });
};

/**
 * Adds `X-Request-Id` to an outbound tool request. A header of that name the
 * tool defines, in any casing, is kept.
 */
export const withRequestIdHeader = (
  headers: Record<string, string>
): Record<string, string> => {
  const requestId = currentRequestId();
  const defined = Object.keys(headers).some((key) => {
    return key.toLowerCase() === 'x-request-id';
  });
  return requestId && !defined
    ? { ...headers, 'X-Request-Id': requestId }
    : headers;
};
