/**
 * The one reading of a tool's structured error — the REST envelope a REST
 * answer or an MCP `structuredContent` carries — and what it becomes, by who
 * registered the tool.
 */
import { DomainError, errorBody } from '../errors';
import { denialCodeOf, isAuthorizationDenial } from './authorizationDenial';
import { isPlainObject } from './plainObject';
import { isErrorCode } from './storedError';

/**
 * `catalog`: the deployment's own actions, the in-process REST surface and the
 * actions it adds over MCP, whose errors are this API's and are relayed as
 * REST answers them. `stored`: a tool a project registered, whose error is
 * data: it never carries a code this server routes or retries on.
 */
export type ToolTrust = 'catalog' | 'stored';

export type ToolErrorEnvelope = {
  status: number;
  code: string;
  message: string;
  meta?: Record<string, unknown>;
};

const isErrorStatus = (value: unknown): value is number => {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 400 &&
    value <= 599
  );
};

/** `body` is `{ error: { code, message, meta? } }`; `null` when it is not. */
export const readToolErrorEnvelope = (args: {
  status: unknown;
  body: unknown;
}): ToolErrorEnvelope | null => {
  const error = isPlainObject(args.body) ? args.body.error : undefined;
  if (!isErrorStatus(args.status) || !isPlainObject(error)) return null;
  const { code, message, meta } = error;
  if (typeof code !== 'string' || code === '') return null;
  if (typeof message !== 'string') return null;
  if (meta !== undefined && !isPlainObject(meta)) return null;
  return {
    status: args.status,
    code,
    message,
    ...(meta === undefined ? {} : { meta }),
  };
};

/** The code a relayed one is under here, which picks its hint and docs. */
const localCode = (code: string) => {
  if (isErrorCode(code)) return code;
  return denialCodeOf(code) ?? 'BUILTIN_ACTION_FAILED';
};

/** A catalog action's error as REST answers it: status, code, message, meta. */
const relayed = (envelope: ToolErrorEnvelope): DomainError => {
  const { status, code, message, meta } = envelope;
  return new DomainError(localCode(code), message, meta, {
    relayed: { code, httpStatus: status },
  });
};

/** A stored tool's error under `meta.upstream_*`, beside the site's own meta. */
export const upstreamErrorMeta = (
  envelope: ToolErrorEnvelope | null
): Record<string, unknown> => {
  if (envelope === null) return {};
  return {
    upstream_status: envelope.status,
    upstream_code: envelope.code,
    upstream_message: envelope.message,
    ...(envelope.meta === undefined ? {} : { upstream_meta: envelope.meta }),
  };
};

/**
 * The error a failed tool call answers. `trust` is required so every site
 * states whose error it reads; a catalog envelope is relayed, and anything
 * else is the site's own `wrap`, given the envelope to carry as upstream meta.
 */
export const toolCallError = (args: {
  trust: ToolTrust;
  envelope: ToolErrorEnvelope | null;
  wrap: (envelope: ToolErrorEnvelope | null) => Error;
}): Error => {
  if (args.trust === 'catalog' && args.envelope !== null) {
    return relayed(args.envelope);
  }
  return args.wrap(args.envelope);
};

/**
 * An error as a tool result the model reads: what a REST call answers, its
 * status beside its body, the shape `/mcp` answers as `structuredContent`.
 */
export const errorToolResult = (error: DomainError) => {
  return {
    status: error.httpStatus,
    ...errorBody({
      code: error.code,
      wireCode: error.wireCode,
      message: error.message,
      meta: error.meta,
    }),
  };
};

/**
 * What a failed call answers the model in a turn: an error this API relays or
 * decides is the body REST answers, so the model keeps its code and meta.
 * `null` for any other error, which fails the call.
 */
export const toolErrorAnswer = (
  error: unknown
): {
  result: ReturnType<typeof errorToolResult>;
  status: 'denied' | 'failed';
} | null => {
  if (!(error instanceof DomainError)) return null;
  const { relayed } = error;
  const denied = isAuthorizationDenial(error);
  if (!denied && !relayed) return null;
  return {
    result: errorToolResult(error),
    status: denied ? 'denied' : 'failed',
  };
};
