import type { PrincipalBound } from './principalBound';
import { serializeBound } from './principalBound';

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
 * The principal to credit for an action: `user` names the acting user, and
 * `api_key` names the key itself (`key_…`) so a record says *which* key acted.
 *
 * It lives in `lib` rather than beside `requestPrincipalFromCtx` (the REST
 * helper that derives one from an auth context) because a principal now
 * outlives a request: an orchestration run persists the principal that started
 * it and re-establishes it when a background worker drives the run later.
 */
export type RequestPrincipal = {
  principalType: 'user' | 'api_key';
  principalId: string;
};

declare const startingPrincipalBrand: unique symbol;

/**
 * The principal durable work records as having started it, which a later drive
 * re-mints a run token from. Only `orchestrationRunToken.ts` produces one, so
 * every writer of a starting principal is held to `resolveStartingPrincipal`.
 */
export type StartingPrincipal = RequestPrincipal & {
  /** The IAM token bound the principal acted under, kept with it. */
  bound?: PrincipalBound;
  readonly [startingPrincipalBrand]: true;
};

const boundColumn = (principal: StartingPrincipal | null): object | null => {
  return principal?.bound ? serializeBound(principal.bound) : null;
};

/**
 * The one derivation of "who is acting" from an authenticated caller.
 *
 * `apiKeyPublicId` decides the kind, and it is set for every credential shape
 * through which a key acts: a raw `sk_` key (scoped or unscoped) and a run-as
 * token carrying a `key` claim. So a record names *which* key acted
 * rather than merely that a key did — including when the actor is a background
 * drive that re-minted the key's identity.
 *
 * Every record naming who acted derives it here, never from `authUser.id`,
 * which is a key's owner. Hand-synced copies, each with its own paraphrase of
 * the rule, drift: one goes quietly wrong while every test still passes.
 */
export const principalFromAuthUser = (authUser: {
  publicId: string;
  apiKeyPublicId?: string;
}): RequestPrincipal => {
  if (authUser.apiKeyPublicId) {
    return { principalType: 'api_key', principalId: authUser.apiKeyPublicId };
  }
  return { principalType: 'user', principalId: authUser.publicId };
};

/**
 * The `startedByPrincipal*` column pair for a principal, or nulls when the work
 * records none. Every writer of those two columns spells the mapping the same
 * way, and each new one is a spread rather than two more `?? null` branches in
 * an already-long record literal.
 */
export const startedByPrincipalColumns = (
  principal: StartingPrincipal | null
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
  principal: StartingPrincipal | null;
  agentId: string | null;
}): {
  actedAsPrincipalType: string | null;
  actedAsPrincipalId: string | null;
  actedAsPrincipalBound: object | null;
} => {
  if (args.agentId) {
    return {
      actedAsPrincipalType: 'agent',
      actedAsPrincipalId: args.agentId,
      actedAsPrincipalBound: null,
    };
  }
  return {
    actedAsPrincipalType: args.principal?.principalType ?? null,
    actedAsPrincipalId: args.principal?.principalId ?? null,
    actedAsPrincipalBound: boundColumn(args.principal),
  };
};

/** A fresh turn's `startedByPrincipal*` and `actedAsPrincipal*` columns. */
export const turnPrincipalColumns = (args: {
  startedBy?: StartingPrincipal | null;
  actsAsAgent: string | null;
}) => {
  const principal = args.startedBy ?? null;
  return {
    ...startedByPrincipalColumns(principal),
    ...actedAsPrincipalColumns({ principal, agentId: args.actsAsAgent }),
  };
};

/**
 * The `principal*` columns of work a background drive re-mints a credential
 * from (an orchestration run, a playbook version's author).
 */
export const runPrincipalColumns = (
  principal: StartingPrincipal | null
): {
  principalKind: string | null;
  principalId: string | null;
  principalBound: object | null;
} => {
  return {
    principalKind: principal?.principalType ?? null,
    principalId: principal?.principalId ?? null,
    principalBound: boundColumn(principal),
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
