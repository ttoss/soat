import createDebug from 'debug';

import {
  currentCausationChain,
  MAX_EVENT_CAUSATION_DEPTH,
  runWithCausationChain,
} from './eventCausation';
import { SOAT_TOOL_CALL_TIMEOUT_MS } from './externalToolCall';
import { soatHeader } from './headerPrefix';
import { withRequestIdHeader } from './requestCorrelation';
import { signToken, verifyToken } from './signedTokens';

const log = createDebug('soat:causationHeader');

/**
 * Carries the causal chain across a request soat's own outbound call causes:
 * a tool server writing back through the API, or a tool aimed at the API
 * itself. Signed, so a caller can neither forge a chain nor shorten one; a
 * missing or invalid header resets nothing. A system that drops the header
 * on its way back is outside the guard.
 */

/** `<SOAT_HEADER_PREFIX>Causation`. */
export const causationHeaderName = (): string => {
  return soatHeader('Causation');
};

/** As long as the call carrying it may run, so its write-backs still count. */
const CAUSATION_TTL_SECONDS = Math.ceil(SOAT_TOOL_CALL_TIMEOUT_MS / 1000);

/**
 * Adds the signed chain in scope to an outbound request, replacing any header
 * of that name the request defines. Unchanged outside a trigger's work.
 */
const withCausationHeader = (
  headers: Record<string, string>
): Record<string, string> => {
  const chain = currentCausationChain();
  if (chain.length === 0) return headers;
  const name = causationHeaderName();
  const kept = Object.fromEntries(
    Object.entries(headers).filter(([key]) => {
      return key.toLowerCase() !== name.toLowerCase();
    })
  );
  return {
    ...kept,
    [name]: signToken({
      typ: 'causation',
      claims: { chain: [...chain] },
      expiresIn: CAUSATION_TTL_SECONDS,
    }),
  };
};

/**
 * The headers every outbound request that may call back into the API
 * carries: its correlation id and its causal chain. Each request site goes
 * through it (`tests/harness/causationChain.test.mjs`).
 */
export const withOutboundToolHeaders = (
  headers: Record<string, string>
): Record<string, string> => {
  return withCausationHeader(withRequestIdHeader(headers));
};

const isChain = (value: unknown): value is string[] => {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_EVENT_CAUSATION_DEPTH &&
    value.every((id) => {
      return typeof id === 'string';
    })
  );
};

const verifiedChain = (header: unknown): string[] | null => {
  if (typeof header !== 'string') return null;
  const claims = verifyToken({ token: header, accept: ['causation'] });
  if (!claims || !isChain(claims.chain)) {
    log('verifiedChain: ignored an unverified chain');
    return null;
  }
  return claims.chain;
};

/**
 * Runs `fn` under the chain a request's verified causation header carries,
 * else under the chain already in scope (an in-process call's). The prefix is
 * read only when a header could be it, so a misconfigured one fails just the
 * requests that send one.
 */
export const runWithRequestCausation = <T>(args: {
  headers: Record<string, string | string[] | undefined>;
  fn: () => T;
}): T => {
  const named = Object.keys(args.headers).some((name) => {
    return name.toLowerCase().endsWith('causation');
  });
  const chain = named
    ? verifiedChain(args.headers[causationHeaderName().toLowerCase()])
    : null;
  return chain ? runWithCausationChain({ chain, fn: args.fn }) : args.fn();
};
