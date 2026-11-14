import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';
import { principalFromAuthUser } from './principals';
import type { ActingPrincipal } from './workAuthority';

/**
 * Whose policies refused: the request's credential (`user`, `api_key`, or
 * `caller` where the site holds its policies but not its id), what narrows it
 * (an `iam_token` bound, an `on_behalf_of` assertion's cap, a `generation`'s
 * execution identity), or a resource acting under its own `policy_ids`
 * (`agent`, `trigger`). `id` is `null` where the refusing site holds the policy
 * but not its owner's id.
 */
export type DeniedPrincipal = {
  type:
    | 'user'
    | 'api_key'
    | 'caller'
    | 'iam_token'
    | 'on_behalf_of'
    | 'generation'
    | 'agent'
    | 'trigger';
  id: string | null;
};

/**
 * Whose set refused the last denied check of `action` (on `resource`), as the
 * authorizer that ran it recorded; `undefined` when none did.
 */
export type RefusedBy = (args: {
  action: string;
  resource: string | null;
}) => DeniedPrincipal | undefined;

export type DeniedAction = { action: string; resource: string | null };

const PRINCIPAL_LABELS: Record<DeniedPrincipal['type'], string> = {
  user: 'user',
  api_key: 'API key',
  caller: 'caller',
  iam_token: 'IAM token',
  on_behalf_of: 'On-Behalf-Of assertion',
  generation: 'generation',
  agent: 'agent',
  trigger: 'trigger',
};

const owner = (principal: DeniedPrincipal): string => {
  const label = PRINCIPAL_LABELS[principal.type];
  return principal.id === null
    ? `the ${label}'s`
    : `${label} ${principal.id}'s`;
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
  return `Forbidden: ${owner(args.principal)} policies deny ${args.denied
    .map(describeAction)
    .join(', ')}`;
};

/**
 * Every `FORBIDDEN` the server raises. `meta` names the first denied action
 * and resource and who denied it; `extra` adds a site's own fields beside them.
 */
export const authorizationDenied = (args: {
  principal: DeniedPrincipal;
  denied: [DeniedAction, ...DeniedAction[]];
  extra?: Record<string, unknown>;
}): DomainError => {
  const [first] = args.denied;
  return new DomainError(
    'FORBIDDEN',
    authorizationDenialMessage({
      principal: args.principal,
      denied: args.denied,
    }),
    {
      ...args.extra,
      action: first.action,
      resource: first.resource,
      denied_by: { type: args.principal.type, id: args.principal.id },
    }
  );
};

/** The request's credential, as the principal whose policies refused it. */
export const callerPrincipal = (authUser: {
  terms: { principal: ActingPrincipal };
}): DeniedPrincipal => {
  const { principalType, principalId } = principalFromAuthUser(authUser);
  return { type: principalType, id: principalId };
};

/**
 * A refusal of the request's authority: the set its authorizer recorded as
 * refusing, else the credential.
 */
export const callerDenied = (args: {
  authUser: {
    terms: { principal: ActingPrincipal };
    isAllowed?: { refusedBy?: RefusedBy };
  };
  action: string;
  resource: string | null;
  extra?: Record<string, unknown>;
}): DomainError => {
  const refusing = args.authUser.isAllowed?.refusedBy?.({
    action: args.action,
    resource: args.resource,
  });
  return authorizationDenied({
    principal: refusing ?? callerPrincipal(args.authUser),
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
    denied: [{ action: args.action, resource: args.resource }],
  });
};

export const isAuthorizationDenial = (error: unknown): error is DomainError => {
  return error instanceof DomainError && error.code === 'FORBIDDEN';
};

/**
 * A denial as a tool result the model reads: the error body a REST call
 * answers, without the request-only `hint` and `docs_url`.
 */
export const denialToolResult = (
  denial: DomainError
): { error: { code: string; message: string; meta?: unknown } } => {
  return {
    error: {
      code: denial.code,
      message: denial.message,
      ...(denial.meta === undefined ? {} : { meta: denial.meta }),
    },
  };
};

const PRINCIPAL_TYPES = Object.keys(PRINCIPAL_LABELS);

const isDeniedPrincipal = (value: unknown): value is DeniedPrincipal => {
  return (
    isPlainObject(value) &&
    typeof value.type === 'string' &&
    PRINCIPAL_TYPES.includes(value.type) &&
    (typeof value.id === 'string' || value.id === null)
  );
};

const parseJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

/**
 * The denial a forwarded answer carries — a REST error body or a tool result,
 * as an object or its JSON text — so a forwarder relays the same code, action,
 * resource, principal and message; `extra` adds the forwarder's own fields.
 * `null` for anything else.
 */
export const readForwardedDenial = (args: {
  body: unknown;
  extra?: Record<string, unknown>;
}): DomainError | null => {
  const body = parseJson(args.body);
  const error = isPlainObject(body) ? body.error : undefined;
  if (
    !isPlainObject(error) ||
    error.code !== 'FORBIDDEN' ||
    typeof error.message !== 'string'
  ) {
    return null;
  }
  const meta = error.meta;
  if (
    !isPlainObject(meta) ||
    typeof meta.action !== 'string' ||
    !(typeof meta.resource === 'string' || meta.resource === null) ||
    !isDeniedPrincipal(meta.denied_by)
  ) {
    return null;
  }
  return new DomainError('FORBIDDEN', error.message, {
    ...args.extra,
    ...meta,
  });
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
