import { type ActsFor, actsForColumns, actsForOf } from './actsFor';
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
  'eval',
  'decider',
  'ingestion_rule',
  'memory_rule',
  'playbook_version',
] as const;

export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

/** Every principal type a credential or stored work acts as. */
export type ActingPrincipalType = ActingPrincipal['type'];

/**
 * The principal to credit for an action: `user` names the acting user,
 * `api_key` the key itself (`key_…`) so a record says *which* key acted, and
 * `trigger` or a `RESOURCE_GRANT_PRINCIPALS` type a resource acting under its
 * own grant.
 */
export type RequestPrincipal = {
  principalType: ActingPrincipal['type'];
  principalId: string;
  /** Whom the principal acted for: `actsForOf` its request. */
  actsFor: ActsFor | null;
};

/**
 * The one derivation of "who is acting" from an authenticated caller: the
 * principal its terms state. Every record naming who acted derives it here,
 * never from `authUser.id`, which is a key's owner.
 */
export const principalFromAuthUser = (
  authUser: { terms: { principal: ActingPrincipal } } & Parameters<
    typeof actsForOf
  >[0]
): RequestPrincipal => {
  return {
    principalType: authUser.terms.principal.type,
    principalId: authUser.terms.principal.id,
    actsFor: actsForOf(authUser),
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
        actsFor: authority.actsFor,
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

/**
 * The `actedAsPrincipal*` columns: the agent when its turn runs under its own
 * grant (`run_as: agent`, `agentId` set), else the same mapping as `startedBy`.
 */
export const actedAsPrincipalColumns = (args: {
  principal: RequestPrincipal | null;
  agentId: string | null;
}): {
  actedAsPrincipalType: string | null;
  actedAsPrincipalId: string | null;
} => {
  if (args.agentId) {
    return { actedAsPrincipalType: 'agent', actedAsPrincipalId: args.agentId };
  }
  return {
    actedAsPrincipalType: args.principal?.principalType ?? null,
    actedAsPrincipalId: args.principal?.principalId ?? null,
  };
};

/** Any principal a record names, with whom it acted for. */
export type RecordedPrincipal = {
  principalType: PrincipalType;
  principalId: string | null;
  actsFor: ActsFor | null;
};

type PrincipalColumns<P extends string> = {
  [
    K in
      | `${P}PrincipalType`
      | `${P}PrincipalId`
      | `${P}ActsForType`
      | `${P}ActsForId`
  ]: string | null;
};

/**
 * The columns naming who did a thing as `prefix` (`createdBy`, `resolvedBy`):
 * the principal and whom it acted for, written together so no record stores
 * one without the other. All null when the write records no principal.
 */
export const principalColumns = <P extends string>(args: {
  prefix: P;
  principal: RecordedPrincipal | null;
}): PrincipalColumns<P> => {
  const { prefix, principal } = args;
  const { actsForType, actsForId } = actsForColumns(principal?.actsFor ?? null);
  return {
    [`${prefix}PrincipalType`]: principal?.principalType ?? null,
    [`${prefix}PrincipalId`]: principal?.principalId ?? null,
    [`${prefix}ActsForType`]: actsForType,
    [`${prefix}ActsForId`]: actsForId,
  } as PrincipalColumns<P>;
};

/** The `createdBy*` columns. */
export const createdByColumns = (principal: RecordedPrincipal | null) => {
  return principalColumns({ prefix: 'createdBy', principal });
};

/** What a turn starts under, and who its tool calls act as. */
export type StartedWork = {
  authority: WorkAuthority | null;
  /** The agent, when the turn runs under its own grant (`run_as: agent`). */
  actsAsAgent: string | null;
};

/**
 * The columns of a generation its authority starts: who started it, who its
 * first segment's tool calls act as, and the authority itself.
 */
export const startedWorkColumns = async (
  args: StartedWork & { projectId: number }
) => {
  const principal = principalOfAuthority(args.authority);
  return {
    ...startedByPrincipalColumns(principal),
    ...actedAsPrincipalColumns({ principal, agentId: args.actsAsAgent }),
    authority: await storedAuthority(args),
  };
};

type ServedPrincipal<W extends string> = {
  [K in `${W}principal_type` | `${W}principal_id`]: string | null;
} & { [K in `${W}acts_for`]: ActsFor | null };

/**
 * The wire fields of a stored principal (`wire` `created_by_` for `prefix`
 * `createdBy`): its type, its id and whom it acted for, served together.
 */
export const servedPrincipal = <P extends string, W extends string>(args: {
  row: PrincipalColumns<P>;
  prefix: P;
  wire: W;
}): ServedPrincipal<W> => {
  const { row, prefix, wire } = args;
  const type = row[`${prefix}ActsForType`];
  const id = row[`${prefix}ActsForId`];
  return {
    [`${wire}principal_type`]: row[`${prefix}PrincipalType`],
    [`${wire}principal_id`]: row[`${prefix}PrincipalId`],
    [`${wire}acts_for`]: type && id ? { type, id } : null,
  } as ServedPrincipal<W>;
};
