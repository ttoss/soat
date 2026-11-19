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
  const error = isPlainObject(body) ? body.error : undefined;
  const relayed = isPlainObject(error) ? error : undefined;
  const code = typeof relayed?.code === 'string' ? relayed.code : null;
  const message = typeof relayed?.message === 'string' ? relayed.message : null;
  const answer = [`HTTP ${status}`, code].filter(Boolean).join(' ');
  return new DomainError(
    'TOOL_HTTP_ERROR',
    `Builtin action '${args.action}' failed: ${answer}${message ? `: ${message}` : ''}`,
    {
      tool_status_code: status,
      tool_action: args.action,
      tool_method: args.method,
      ...(relayed
        ? { tool_error: relayed }
        : { tool_response_body: JSON.stringify(body) ?? '' }),
    }
  );
};
