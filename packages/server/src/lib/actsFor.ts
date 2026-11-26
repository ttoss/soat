import type { AuthUser } from '../Context';

/** An opaque principal a caller acts for: an IAM token's `principal`. */
export type ActsFor = { type: string; id: string };

/**
 * Whom a request acts for: its IAM token's `principal`, else the one the
 * `On-Behalf-Of` assertion it carries sealed. Null when it names none.
 */
export const actsForOf = (
  authUser: Pick<AuthUser, 'iamToken' | 'onBehalfOfPrincipal'>
): ActsFor | null => {
  return authUser.iamToken?.principal ?? authUser.onBehalfOfPrincipal ?? null;
};
