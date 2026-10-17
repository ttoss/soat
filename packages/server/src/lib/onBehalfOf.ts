import createDebug from 'debug';

import { DomainError } from '../errors';
import { soatHeader } from './headerPrefix';
import { verifyOwnToolAssertion } from './toolAssertion';

const log = createDebug('soat:onBehalfOf');

/**
 * The tool call a request writes on behalf of, as recorded beside the
 * `createdBy` principal. Attribution only: it never widens what the credential
 * may do.
 */
export type OnBehalfOf = {
  tool_id: string | null;
  agent_id: string | null;
  generation_id: string | null;
  session_id: string | null;
  actor_id: string | null;
};

/** `<SOAT_HEADER_PREFIX>On-Behalf-Of`. */
export const onBehalfOfHeaderName = (): string => {
  return soatHeader('On-Behalf-Of');
};

const claim = (claims: Record<string, unknown>, key: string) => {
  const value = claims[key];
  return typeof value === 'string' ? value : null;
};

/**
 * Reads a tool assertion this deployment signed, sent back by a key scoped to
 * the assertion's project. Anything else is refused rather than dropped, so a
 * write never lands attributed to the key when its caller asked otherwise.
 */
const readOnBehalfOf = (args: {
  token: string;
  apiKeyProjectPublicId: string | undefined;
}): OnBehalfOf => {
  const claims = verifyOwnToolAssertion(args.token.trim());
  if (!claims) {
    throw new DomainError(
      'ON_BEHALF_OF_INVALID',
      `${onBehalfOfHeaderName()} must be an unexpired tool assertion this deployment signed.`,
      { reason: 'unverified' }
    );
  }
  if (
    !args.apiKeyProjectPublicId ||
    claims.project_id !== args.apiKeyProjectPublicId
  ) {
    throw new DomainError(
      'ON_BEHALF_OF_INVALID',
      `${onBehalfOfHeaderName()} is accepted only from an API key scoped to the assertion's project.`,
      { reason: 'project' }
    );
  }
  const onBehalfOf = {
    tool_id: claim(claims, 'tool_id'),
    agent_id: claim(claims, 'agent_id'),
    generation_id: claim(claims, 'generation_id'),
    session_id: claim(claims, 'session_id'),
    actor_id: claim(claims, 'actor_id'),
  };
  log('readOnBehalfOf: tool=%s', onBehalfOf.tool_id);
  return onBehalfOf;
};

/**
 * The request's verified `On-Behalf-Of`, if it sends one. The prefix is read
 * only then, so a misconfigured one fails the requests that name the header
 * rather than every request.
 */
export const requestOnBehalfOf = (args: {
  headers: Record<string, string | string[] | undefined>;
  apiKeyProjectPublicId: string | undefined;
}): OnBehalfOf | undefined => {
  const named = Object.keys(args.headers).some((name) => {
    return name.toLowerCase().endsWith('on-behalf-of');
  });
  if (!named) return undefined;
  const token = args.headers[onBehalfOfHeaderName().toLowerCase()];
  if (typeof token !== 'string') return undefined;
  return readOnBehalfOf({
    token,
    apiKeyProjectPublicId: args.apiKeyProjectPublicId,
  });
};
