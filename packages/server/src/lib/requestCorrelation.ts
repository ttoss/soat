import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The `X-Request-Id` of the request whose work is executing, so an outbound
 * `mcp` tool request names it without every caller threading it through. Work
 * a request leaves running in the background keeps the id of that request.
 */
const requestIdStore = new AsyncLocalStorage<string>();

/** The request id in scope, or `undefined` outside any request. */
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
