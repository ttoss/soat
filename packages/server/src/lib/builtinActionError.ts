import { DomainError } from '../errors';
import type { InProcessApiResponse } from './inProcessApi';
import { isPlainObject } from './plainObject';

/**
 * A builtin action's non-2xx answer as `TOOL_HTTP_ERROR`. The message is what
 * the model reads, so it carries the status and the target's own code and
 * message, and names the action by operation id: a route path would name the
 * deployment's mount. `hint` and `docs_url` stay out of the message.
 */
export const builtinActionError = (args: {
  action: string;
  method: string;
  response: InProcessApiResponse;
}): DomainError => {
  const { status, body } = args.response;
  // `errorBody` shapes every in-process error answer; one without its envelope
  // (a redirect, an unmatched route) still fails, carrying its body.
  const error =
    isPlainObject(body) && isPlainObject(body.error)
      ? body.error
      : {
          code: 'REQUEST_REJECTED',
          message: 'The action answered without an error body.',
          body,
        };
  return new DomainError(
    'TOOL_HTTP_ERROR',
    `Builtin action '${args.action}' failed: HTTP ${status} ${String(error.code)}: ${String(error.message)}`,
    {
      tool_status_code: status,
      tool_action: args.action,
      tool_method: args.method,
      tool_error: error,
    }
  );
};
