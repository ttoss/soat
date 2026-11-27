import { DomainError, isDeclaredDenialCode } from '../errors';
import type { PolicyDenial } from './iam';
import { isPlainObject } from './plainObject';
import { principalFromAuthUser } from './principals';
import type { ResourceGrantPrincipalType } from './resourceGrantCarriers';
import type { ActingPrincipal } from './workAuthority';

type DeniedPrincipalType =
  | 'user'
  | 'api_key'
  | 'caller'
  | 'iam_token'
  | 'on_behalf_of'
  | 'generation'
  | 'project'
  | 'group'
  | 'agent'
  | 'trigger'
  | ResourceGrantPrincipalType;

/** The caller's own principal an IAM token was minted for, opaque to the server. */
export type MintedPrincipal = { type: string; id: string };

/**
 * Whose policies refused: the request's credential (`user`, `api_key`, or
 * `caller` where the site holds its policies but not its id), what narrows it
 * (an `iam_token` bound, an `on_behalf_of` assertion's cap, a `generation`'s
 * execution identity, a `project`'s `agent_policy_ids`, a `group`'s attached
 * policies), or a resource acting
 * under its own `policy_ids` (`agent`, `trigger`, or a
 * `RESOURCE_GRANT_PRINCIPALS` type). `id` is `null` where the refusing site holds the policy
 * but not its owner's id. An `iam_token` minted for a `principal` carries it.
 */
export type DeniedPrincipal =
  | { type: Exclude<DeniedPrincipalType, 'iam_token'>; id: string | null }
  | { type: 'iam_token'; id: string | null; principal?: MintedPrincipal };

/**
 * Whose set refused a check, and the `denial` of the `Deny` statement that
 * decided it (`null` when none declares one, or nothing but a missing `Allow`
 * refused).
 */
export type Refusal = {
  principal: DeniedPrincipal;
  denial: PolicyDenial | null;
};

/**
 * The refusal of the last denied check of `action` (on `resource`), as the
 * authorizer that ran it recorded; `undefined` when none did.
 */
export type RefusedBy = (args: {
  action: string;
  resource: string | null;
}) => Refusal | undefined;

export type DeniedAction = { action: string; resource: string | null };

const PRINCIPAL_LABELS: Record<DeniedPrincipal['type'], string> = {
  user: 'user',
  api_key: 'API key',
  caller: 'caller',
  iam_token: 'IAM token',
  on_behalf_of: 'On-Behalf-Of assertion',
  generation: 'generation',
  project: 'project',
  group: 'group',
  agent: 'agent',
  trigger: 'trigger',
  eval: 'eval',
  decider: 'decider',
  ingestion_rule: 'ingestion rule',
  memory_rule: 'memory rule',
  playbook_version: 'playbook version',
};

const LABELS: Readonly<Record<string, string>> = PRINCIPAL_LABELS;

/**
 * Whom a refusal names: a token minted for a principal names that principal,
 * since its jti never reaches the minter's caller.
 */
const namedBy = (
  principal: DeniedPrincipal
): { type: string; id: string | null } => {
  if (principal.type === 'iam_token' && principal.principal) {
    return principal.principal;
  }
  return { type: principal.type, id: principal.id };
};

const owner = (named: { type: string; id: string | null }): string => {
  const label = Object.hasOwn(LABELS, named.type)
    ? LABELS[named.type]
    : named.type;
  return named.id === null ? `the ${label}'s` : `${label} ${named.id}'s`;
};

const describeAction = (denied: DeniedAction): string => {
  return denied.resource === null
    ? denied.action
    : `${denied.action} on ${denied.resource}`;
};

export const authorizationDenialMessage = (args: {
  principal: DeniedPrincipal;
  denied: DeniedAction[];
}): string => {
  return `Forbidden: ${owner(namedBy(args.principal))} policies deny ${args.denied
    .map(describeAction)
    .join(', ')}`;
};

/**
 * Every `FORBIDDEN` the server raises. `meta` names the first denied action
 * and resource and who denied it; `extra` adds a site's own fields beside them.
 * A policy's `denial` answers its own code and message and adds its `meta`.
 */
export const authorizationDenied = (args: {
  principal: DeniedPrincipal;
  denial: PolicyDenial | null;
  denied: [DeniedAction, ...DeniedAction[]];
  extra?: Record<string, unknown>;
}): DomainError => {
  const [first] = args.denied;
  const { denial } = args;
  return new DomainError(
    'FORBIDDEN',
    denial?.message ??
      authorizationDenialMessage({
        principal: args.principal,
        denied: args.denied,
      }),
    {
      ...denial?.meta,
      ...args.extra,
      action: first.action,
      resource: first.resource,
      denied_by: namedBy(args.principal),
    },
    denial ? { relayed: { code: denial.code, httpStatus: 403 } } : undefined
  );
};

/**
 * A writer, or a resource's grant, missing an action the resource would
 * perform: the refusing `Deny`'s denial when it declares one, else
 * `ACTION_NOT_HELD` worded by `message`.
 */
export const actionNotHeld = (args: {
  refusedBy: RefusedBy | undefined;
  action: string;
  resource: string;
  message: string;
}): DomainError => {
  const denied = { action: args.action, resource: args.resource };
  const refusal = args.refusedBy?.(denied);
  if (refusal?.denial) {
    return authorizationDenied({ ...refusal, denied: [denied] });
  }
  return new DomainError('ACTION_NOT_HELD', args.message, denied);
};

/** The request's credential, as the principal whose policies refused it. */
export const callerPrincipal = (authUser: {
  terms: { principal: ActingPrincipal };
}): DeniedPrincipal => {
  const { principalType, principalId } = principalFromAuthUser(authUser);
  return { type: principalType, id: principalId };
};

type RefusableAuthUser = {
  terms: { principal: ActingPrincipal };
  isAllowed?: { refusedBy?: RefusedBy };
};

/**
 * The refusal of the request's check of `action` on `resource`: the one its
 * authorizer recorded, else the credential's with no denial.
 */
export const requestRefusal = (args: {
  authUser: RefusableAuthUser;
  action: string;
  resource: string | null;
}): Refusal => {
  return (
    args.authUser.isAllowed?.refusedBy?.({
      action: args.action,
      resource: args.resource,
    }) ?? { principal: callerPrincipal(args.authUser), denial: null }
  );
};

/** A refusal of the request's authority, naming the set that refused. */
export const callerDenied = (args: {
  authUser: RefusableAuthUser;
  action: string;
  resource: string | null;
  extra?: Record<string, unknown>;
}): DomainError => {
  return authorizationDenied({
    ...requestRefusal(args),
    denied: [{ action: args.action, resource: args.resource }],
    extra: args.extra,
  });
};

/** A refusal by an agent's `policy_ids`, on every tool path that checks them. */
export const agentDenied = (args: {
  agentId: string | null;
  action: string;
  resource: string | null;
}): DomainError => {
  return authorizationDenied({
    principal: { type: 'agent', id: args.agentId },
    denial: null,
    denied: [{ action: args.action, resource: args.resource }],
  });
};

/** A declared denial code relays as a `FORBIDDEN`; `null` for any other. */
export const denialCodeOf = (code: string): 'FORBIDDEN' | null => {
  return isDeclaredDenialCode(code) ? 'FORBIDDEN' : null;
};

export const isAuthorizationDenial = (error: unknown): error is DomainError => {
  return error instanceof DomainError && error.code === 'FORBIDDEN';
};

const isDeniedPrincipalType = (type: unknown): type is DeniedPrincipalType => {
  return typeof type === 'string' && Object.hasOwn(PRINCIPAL_LABELS, type);
};

const readMintedPrincipal = (value: unknown): MintedPrincipal | null => {
  return isPlainObject(value) &&
    typeof value.type === 'string' &&
    typeof value.id === 'string'
    ? { type: value.type, id: value.id }
    : null;
};

/** A stored or sealed refusing principal; null for one that does not read. */
export const readDeniedPrincipal = (value: unknown): DeniedPrincipal | null => {
  if (!isPlainObject(value) || !isDeniedPrincipalType(value.type)) return null;
  const { type, id } = value;
  if (id !== null && typeof id !== 'string') return null;
  if (value.principal === undefined) return { type, id };
  const principal = readMintedPrincipal(value.principal);
  return type === 'iam_token' && principal ? { type, id, principal } : null;
};

export const isDeniedPrincipal = (value: unknown): value is DeniedPrincipal => {
  return readDeniedPrincipal(value) !== null;
};

/**
 * A request narrowed beyond its credential's own grant writes no durable
 * credential: the credential would outlive the narrowing it was made under.
 */
export const credentialNarrowed = (args: { writing: string }): DomainError => {
  return new DomainError(
    'CREDENTIAL_NARROWED',
    `This request is narrowed beyond its credential's own grant and cannot write ${args.writing}.`
  );
};
