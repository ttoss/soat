import type { AuthUser } from '../Context';
import { isPlainObject } from '../lib/plainObject';
import { parseBound } from '../lib/principalBound';
import type { TokenType } from '../lib/signedTokens';

/**
 * The claims that carry an IAM token bound: `bnd` on an IAM token (with its
 * `jti` and optional `prn`) and on a run token re-minted for work one started;
 * `cbnd` on a trigger token fired by one.
 */
export type BoundClaims = {
  typ: TokenType;
  key?: string;
  prj?: string;
  bnd?: unknown;
  cbnd?: unknown;
  jti?: string;
  prn?: unknown;
};

/**
 * A bound claim that does not parse, or an IAM token missing its key, bound or
 * id, cannot be held to what it was minted with, so the token is refused.
 */
export const holdsItsBound = (claims: BoundClaims): boolean => {
  if (parseBound(claims.bnd) === null || parseBound(claims.cbnd) === null) {
    return false;
  }
  if (claims.typ !== 'iam') return true;
  return (
    typeof claims.prj === 'string' &&
    typeof claims.key === 'string' &&
    typeof claims.jti === 'string' &&
    parseBound(claims.bnd) !== undefined
  );
};

/** The key a run token or an IAM token acts as, from its `key` claim. */
export const actingKeyOf = (claims: BoundClaims): string | undefined => {
  const actsAsKey = claims.typ === 'run' || claims.typ === 'iam';
  return actsAsKey && typeof claims.key === 'string' ? claims.key : undefined;
};

const readPrincipalClaim = (
  prn: unknown
): { type: string; id: string } | undefined => {
  if (!isPlainObject(prn)) return undefined;
  const { type, id } = prn;
  return typeof type === 'string' && typeof id === 'string'
    ? { type, id }
    : undefined;
};

/** The `bound` and `iamToken` an authenticated caller carries, if any. */
export const boundIdentityFields = (
  claims: BoundClaims
): Pick<AuthUser, 'bound' | 'iamToken'> => {
  const bound = parseBound(claims.bnd) ?? undefined;
  const principal = readPrincipalClaim(claims.prn);
  return {
    ...(bound ? { bound } : {}),
    ...(claims.typ === 'iam' && typeof claims.jti === 'string'
      ? {
          iamToken: { jti: claims.jti, ...(principal ? { principal } : {}) },
        }
      : {}),
  };
};
