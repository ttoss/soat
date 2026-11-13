import type { AuthUser } from '../Context';
import { isPlainObject } from '../lib/plainObject';
import { parseBound } from '../lib/principalBound';
import type { TokenType } from '../lib/signedTokens';

/** The claims that carry an IAM token bound: `bnd`, with its `jti` and optional `prn`. */
export type BoundClaims = {
  typ: TokenType;
  key?: string;
  prj?: string;
  bnd?: unknown;
  jti?: string;
  prn?: unknown;
};

/**
 * A bound claim that does not parse, or an IAM token missing its key, bound or
 * id, cannot be held to what it was minted with, so the token is refused.
 */
export const holdsItsBound = (claims: BoundClaims): boolean => {
  if (parseBound(claims.bnd) === null) return false;
  if (claims.typ !== 'iam') return true;
  return (
    typeof claims.prj === 'string' &&
    typeof claims.key === 'string' &&
    typeof claims.jti === 'string' &&
    parseBound(claims.bnd) !== undefined
  );
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

/** The `iamToken` an authenticated caller carries, if any. */
export const boundIdentityFields = (
  claims: BoundClaims
): Pick<AuthUser, 'iamToken'> => {
  const principal = readPrincipalClaim(claims.prn);
  return claims.typ === 'iam' && typeof claims.jti === 'string'
    ? { iamToken: { jti: claims.jti, ...(principal ? { principal } : {}) } }
    : {};
};
