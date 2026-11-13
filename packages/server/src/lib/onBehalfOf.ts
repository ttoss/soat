import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { DomainError } from '../errors';
import {
  type AssertionAuthority,
  openAssertionAuthority,
} from './assertionAuthority';
import { soatHeader } from './headerPrefix';
import { verifyOwnToolAssertion } from './toolAssertion';

const log = createDebug('soat:onBehalfOf');

/**
 * The tool call a request writes on behalf of, as recorded beside the
 * `createdBy` principal. The authority the call carries caps the request
 * (`authOnBehalfOf.ts`); this record names the call and never widens it.
 */
export type OnBehalfOf = {
  tool_id: string | null;
  agent_id: string | null;
  generation_id: string | null;
  work_id: string | null;
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

/** A verified assertion: the call it names and the authority it carries. */
export type AssertedCall = {
  onBehalfOf: OnBehalfOf;
  authority: AssertionAuthority;
};

/**
 * The project of the key a caller acts as: a project-scoped API key's, or for
 * an IAM token, the project of the key that issued it.
 */
export const issuingKeyProject = (
  authUser: Pick<
    AuthUser,
    'apiKeyProjectPublicId' | 'iamToken' | 'oauthProjectPublicId'
  >
): string | undefined => {
  if (authUser.apiKeyProjectPublicId) return authUser.apiKeyProjectPublicId;
  return authUser.iamToken ? authUser.oauthProjectPublicId : undefined;
};

/**
 * Reads a tool assertion this deployment signed, sent back by a key scoped to
 * the assertion's project, or an IAM token that key issued. Anything else is refused rather than dropped, so a
 * write never lands attributed to the key when its caller asked otherwise, and
 * never runs uncapped when its authority cannot be read.
 */
const readOnBehalfOf = (args: {
  token: string;
  keyProjectPublicId: string | undefined;
}): AssertedCall => {
  const claims = verifyOwnToolAssertion(args.token.trim());
  if (!claims) {
    throw new DomainError(
      'ON_BEHALF_OF_INVALID',
      `${onBehalfOfHeaderName()} must be an unexpired tool assertion this deployment signed.`,
      { reason: 'unverified' }
    );
  }
  if (
    !args.keyProjectPublicId ||
    claims.project_id !== args.keyProjectPublicId
  ) {
    throw new DomainError(
      'ON_BEHALF_OF_INVALID',
      `${onBehalfOfHeaderName()} is accepted only from an API key scoped to the assertion's project, or an IAM token that key issued.`,
      { reason: 'project' }
    );
  }
  const authority = openAssertionAuthority({ value: claims.ath });
  if (!authority) {
    throw new DomainError(
      'ON_BEHALF_OF_INVALID',
      `${onBehalfOfHeaderName()} carries no authority this deployment can read.`,
      { reason: 'bound' }
    );
  }
  const onBehalfOf = {
    tool_id: claim(claims, 'tool_id'),
    agent_id: claim(claims, 'agent_id'),
    generation_id: claim(claims, 'generation_id'),
    work_id: claim(claims, 'work_id'),
    session_id: claim(claims, 'session_id'),
    actor_id: claim(claims, 'actor_id'),
  };
  log('readOnBehalfOf: tool=%s', onBehalfOf.tool_id);
  return { onBehalfOf, authority };
};

/**
 * The request's verified `On-Behalf-Of`, if it sends one. The prefix is read
 * only then, so a misconfigured one fails the requests that name the header
 * rather than every request.
 */
export const requestOnBehalfOf = (args: {
  headers: Record<string, string | string[] | undefined>;
  keyProjectPublicId: string | undefined;
}): AssertedCall | undefined => {
  const named = Object.keys(args.headers).some((name) => {
    return name.toLowerCase().endsWith('on-behalf-of');
  });
  if (!named) return undefined;
  const token = args.headers[onBehalfOfHeaderName().toLowerCase()];
  if (typeof token !== 'string') return undefined;
  return readOnBehalfOf({
    token,
    keyProjectPublicId: args.keyProjectPublicId,
  });
};
