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

/** The `actsFor*` column pair a record stores beside its principal. */
export const actsForColumns = (
  actsFor: ActsFor | null
): { actsForType: string | null; actsForId: string | null } => {
  return { actsForType: actsFor?.type ?? null, actsForId: actsFor?.id ?? null };
};

/** The `acts_for` a record serves from its stored pair; null unless both are set. */
export const servedActsFor = (args: {
  type: string | null | undefined;
  id: string | null | undefined;
}): ActsFor | null => {
  return args.type && args.id ? { type: args.type, id: args.id } : null;
};
