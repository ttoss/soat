import {
  type ActingPrincipal,
  storedAuthority,
  type WorkAuthority,
} from './workAuthority';

/**
 * Every kind of principal a record can name, `PrincipalType` in
 * `principals.yaml`; `principalFieldContract.test.ts` holds the two equal.
 */
export const PRINCIPAL_TYPES = [
  'user',
  'api_key',
  'agent',
  'automation',
  'approval',
  'trigger',
  'system',
] as const;

export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

/**
 * The principal to credit for an action: `user` names the acting user,
 * `api_key` the key itself (`key_…`) so a record says *which* key acted, and
 * `trigger` a trigger acting under its own grant.
 */
export type RequestPrincipal = {
  principalType: ActingPrincipal['type'];
  principalId: string;
};

/**
 * The one derivation of "who is acting" from an authenticated caller: the
 * principal its terms state. Every record naming who acted derives it here,
 * never from `authUser.id`, which is a key's owner.
 */
export const principalFromAuthUser = (authUser: {
  terms: { principal: ActingPrincipal };
}): RequestPrincipal => {
  return {
    principalType: authUser.terms.principal.type,
    principalId: authUser.terms.principal.id,
  };
};

/** The principal stored work acts as, or null for work that holds none. */
export const principalOfAuthority = (
  authority: WorkAuthority | null
): RequestPrincipal | null => {
  return authority
    ? {
        principalType: authority.principal.type,
        principalId: authority.principal.id,
      }
    : null;
};

/**
 * The `startedByPrincipal*` column pair for a principal, or nulls when the work
 * records none.
 */
export const startedByPrincipalColumns = (
  principal: RequestPrincipal | null
): {
  startedByPrincipalType: string | null;
  startedByPrincipalId: string | null;
} => {
  return {
    startedByPrincipalType: principal?.principalType ?? null,
    startedByPrincipalId: principal?.principalId ?? null,
  };
};

/** The `actedAsPrincipal*` column pair, the same mapping as `startedBy`. */
export const actedAsPrincipalColumns = (
  principal: RequestPrincipal | null
): {
  actedAsPrincipalType: string | null;
  actedAsPrincipalId: string | null;
} => {
  return {
    actedAsPrincipalType: principal?.principalType ?? null,
    actedAsPrincipalId: principal?.principalId ?? null,
  };
};

/** The `createdByPrincipal*` column pair, the same mapping as `startedBy`. */
export const createdByColumns = (
  principal: RequestPrincipal | null
): {
  createdByPrincipalType: string | null;
  createdByPrincipalId: string | null;
} => {
  return {
    createdByPrincipalType: principal?.principalType ?? null,
    createdByPrincipalId: principal?.principalId ?? null,
  };
};

/**
 * The columns of a generation its authority starts: who started it, who its
 * first segment's tool calls act as, and the authority itself.
 */
export const startedWorkColumns = async (args: {
  authority: WorkAuthority | null;
  projectId: number;
}) => {
  const principal = principalOfAuthority(args.authority);
  return {
    ...startedByPrincipalColumns(principal),
    ...actedAsPrincipalColumns(principal),
    authority: await storedAuthority(args),
  };
};
