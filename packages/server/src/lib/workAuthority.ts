import type { AuthUser } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';
import type { AgentAuthority } from './agentAuthority';
import type { DeniedPrincipal } from './authorizationDenial';
import { type PolicyDocument, validatePolicyDocument } from './iam';
import { isPlainObject } from './plainObject';
import {
  parseBound,
  type PrincipalBound,
  serializeBound,
} from './principalBound';
import {
  isResourceGrantCarrier,
  RESOURCE_GRANT_PRINCIPAL_TYPES,
  RESOURCE_GRANT_PRINCIPALS,
  type ResourceGrantCarrier,
  type ResourceGrantPrincipalType,
} from './resourceGrantCarriers';

/**
 * Who holds an authority's grant: a user (a credential's owner), a trigger
 * acting under its own `policy_ids`, a `run_as: agent` agent under the
 * `policy_ids` its turn resolved (`null` grants nothing), or a resource of
 * `RESOURCE_GRANT_PRINCIPALS` under its own `policy_ids`, read live.
 */
export type AuthorityGrant =
  | { holder: 'user'; user: string }
  | { holder: 'trigger'; trigger: string }
  | { holder: 'agent'; agent: string; policy: PolicyDocument | null }
  | { holder: 'resource'; carrier: ResourceGrantCarrier; id: string };

/**
 * What narrows the grant, each read live at every check: another holder's
 * grant (`narrowAuthority`), an API key's own `policy_ids`, an OAuth consent,
 * or a bound (an IAM token's, an `On-Behalf-Of` assertion's).
 */
export type AuthorityCap =
  | { kind: 'grant'; grant: AuthorityGrant }
  | { kind: 'key'; key: string }
  | { kind: 'scope'; scope: string | null }
  | { kind: 'bound'; bound: PrincipalBound; by: DeniedPrincipal };

/** The principal that acts: what records credit and refusals name. */
export type ActingPrincipal = {
  type: 'user' | 'api_key' | 'trigger' | ResourceGrantPrincipalType;
  id: string;
};

/** What a credential states, in the form work stores. */
export type CredentialTerms = {
  pinned: string | null;
  grant: AuthorityGrant;
  caps: AuthorityCap[];
  principal: ActingPrincipal;
};

/**
 * The authority durable work runs under, stored on its row and passed
 * in-process as a value: the starter's terms pinned to the work's project
 * (`storedAuthority` pins it),
 * the trigger whose firing began the chain (a firing's work fires no trigger),
 * the work it drives (which it never writes back into), and the opaque
 * principal it acts for.
 */
export type WorkAuthority = Omit<CredentialTerms, 'pinned'> & {
  /** The project it is pinned to; null only until the row storing it pins it. */
  project: string | null;
  trigger: string | null;
  work: string | null;
  /** The opaque principal the starter acted for, carried into tool calls. */
  actsFor: { type: string; id: string } | null;
};

const serializeCap = (cap: AuthorityCap): object => {
  return cap.kind === 'bound'
    ? { kind: 'bound', bound: serializeBound(cap.bound), by: cap.by }
    : cap;
};

/** The stored form, as the `authority` column holds it. */
export const serializeWorkAuthority = (authority: WorkAuthority): object => {
  return {
    project: authority.project,
    grant: authority.grant,
    caps: authority.caps.map(serializeCap),
    principal: authority.principal,
    trigger: authority.trigger,
    work: authority.work,
    acts_for: authority.actsFor,
  };
};

const str = (value: unknown): value is string => {
  return typeof value === 'string' && value.length > 0;
};

const parseAgentGrant = (args: {
  agent: string;
  policy: unknown;
}): AuthorityGrant | null => {
  const { agent, policy } = args;
  if (policy === null) return { holder: 'agent', agent, policy };
  if (!validatePolicyDocument(policy).valid) return null;
  return { holder: 'agent', agent, policy: policy as PolicyDocument };
};

/** One reader per grant holder; a holder none reads is not a grant. */
const GRANT_READERS: Record<
  AuthorityGrant['holder'],
  (value: Record<string, unknown>) => AuthorityGrant | null
> = {
  user: (value) => {
    return str(value.user) ? { holder: 'user', user: value.user } : null;
  },
  trigger: (value) => {
    return str(value.trigger)
      ? { holder: 'trigger', trigger: value.trigger }
      : null;
  },
  agent: (value) => {
    return str(value.agent)
      ? parseAgentGrant({ agent: value.agent, policy: value.policy })
      : null;
  },
  resource: (value) => {
    return isResourceGrantCarrier(value.carrier) && str(value.id)
      ? { holder: 'resource', carrier: value.carrier, id: value.id }
      : null;
  },
};

const isGrantHolder = (holder: unknown): holder is AuthorityGrant['holder'] => {
  return typeof holder === 'string' && Object.hasOwn(GRANT_READERS, holder);
};

const parseGrant = (value: unknown): AuthorityGrant | null => {
  if (!isPlainObject(value) || !isGrantHolder(value.holder)) return null;
  return GRANT_READERS[value.holder](value);
};

const DENIED_TYPES = new Set<string>([
  'user',
  'api_key',
  'caller',
  'iam_token',
  'on_behalf_of',
  'generation',
  'agent',
  'trigger',
  ...RESOURCE_GRANT_PRINCIPAL_TYPES,
]);

const parseDenied = (value: unknown): DeniedPrincipal | null => {
  if (!isPlainObject(value) || typeof value.type !== 'string') return null;
  if (!DENIED_TYPES.has(value.type)) return null;
  if (value.id !== null && typeof value.id !== 'string') return null;
  return { type: value.type as DeniedPrincipal['type'], id: value.id };
};

/** One reader per cap kind; a kind none reads is not a cap. */
const CAP_READERS: Record<
  AuthorityCap['kind'],
  (value: Record<string, unknown>) => AuthorityCap | null
> = {
  grant: (value) => {
    const grant = parseGrant(value.grant);
    return grant ? { kind: 'grant', grant } : null;
  },
  key: (value) => {
    return str(value.key) ? { kind: 'key', key: value.key } : null;
  },
  scope: (value) => {
    return value.scope === null || typeof value.scope === 'string'
      ? { kind: 'scope', scope: value.scope }
      : null;
  },
  bound: (value) => {
    const bound = parseBound(value.bound);
    const by = parseDenied(value.by);
    return bound && by ? { kind: 'bound', bound, by } : null;
  },
};

const isCapKind = (kind: unknown): kind is AuthorityCap['kind'] => {
  return typeof kind === 'string' && Object.hasOwn(CAP_READERS, kind);
};

const parseCap = (value: unknown): AuthorityCap | null => {
  if (!isPlainObject(value) || !isCapKind(value.kind)) return null;
  return CAP_READERS[value.kind](value);
};

/** Every cap, or null when one does not read. */
const parseCaps = (value: unknown): AuthorityCap[] | null => {
  if (!Array.isArray(value)) return null;
  const caps: AuthorityCap[] = [];
  for (const raw of value) {
    const cap = parseCap(raw);
    if (!cap) return null;
    caps.push(cap);
  }
  return caps;
};

const ACTING_TYPES = new Set<string>([
  'user',
  'api_key',
  'trigger',
  ...RESOURCE_GRANT_PRINCIPAL_TYPES,
]);

const parsePrincipal = (value: unknown): ActingPrincipal | null => {
  if (!isPlainObject(value) || !str(value.id)) return null;
  if (typeof value.type !== 'string' || !ACTING_TYPES.has(value.type)) {
    return null;
  }
  return { type: value.type as ActingPrincipal['type'], id: value.id };
};

const parseActsFor = (value: unknown): WorkAuthority['actsFor'] | undefined => {
  if (value === null) return null;
  if (!isPlainObject(value) || !str(value.type) || !str(value.id)) {
    return undefined;
  }
  return { type: value.type, id: value.id };
};

const nullableStr = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  return str(value) ? value : undefined;
};

/**
 * Reads a stored authority back, or null for an absent or malformed one:
 * work that cannot read its authority holds none.
 */
export const parseWorkAuthority = (value: unknown): WorkAuthority | null => {
  if (!isPlainObject(value)) return null;
  const chain = {
    project: nullableStr(value.project),
    trigger: nullableStr(value.trigger),
    work: nullableStr(value.work),
    actsFor: parseActsFor(value.acts_for),
  };
  const grant = parseGrant(value.grant);
  const principal = parsePrincipal(value.principal);
  const caps = parseCaps(value.caps);
  if (!grant || !principal || !caps) return null;
  const { project, trigger, work, actsFor } = chain;
  if (
    project === undefined ||
    trigger === undefined ||
    work === undefined ||
    actsFor === undefined
  ) {
    return null;
  }
  return { project, grant, caps, principal, trigger, work, actsFor };
};

/** The serialized form of an authority, or null for none. */
const authorityColumn = (authority: WorkAuthority | null): object | null => {
  return authority ? serializeWorkAuthority(authority) : null;
};

/**
 * The `authority` column of a durable row in `projectId`: the authority pinned
 * to that project when the credential pinned none. Every durable row writes
 * its authority through here, so none is stored unpinned.
 */
export const storedAuthority = async (args: {
  authority: WorkAuthority | null;
  projectId: number;
}): Promise<object | null> => {
  const { authority } = args;
  if (!authority) return null;
  if (authority.project !== null) return serializeWorkAuthority(authority);
  const project = await db.Project.findByPk(args.projectId, {
    attributes: ['publicId'],
  });
  return project
    ? serializeWorkAuthority({
        ...authority,
        project: project.publicId as string,
      })
    : null;
};

/** The work an authority drives, signed into its tool calls' assertions. */
export const workOf = (authority: WorkAuthority | null): string | null => {
  return authority?.work ?? null;
};

/** The same authority, driving `work`. */
export const forWork = (args: {
  authority: WorkAuthority;
  work: string;
}): WorkAuthority => {
  return { ...args.authority, work: args.work };
};

/** The one refusal of work that holds no authority. */
export const workAuthorityMissing = (args: { work: string }): DomainError => {
  return new DomainError(
    'WORK_AUTHORITY_MISSING',
    `${args.work} has no stored authority to run under.`,
    { work: args.work }
  );
};

/** The authority, or the refusal of work that holds none. */
export const requireWorkAuthority = (args: {
  authority: WorkAuthority | null;
  work: string;
}): WorkAuthority => {
  if (!args.authority) throw workAuthorityMissing({ work: args.work });
  return args.authority;
};

/**
 * The authority work a request starts stores: the request's stated terms,
 * pinned to the work's project, carrying on the chain the request belongs to.
 * Null without a caller.
 */
export const captureAuthority = (args: {
  authUser: AuthUser | undefined;
  projectPublicId?: string;
}): WorkAuthority | null => {
  const { authUser } = args;
  if (!authUser) return null;
  const { terms } = authUser;
  return {
    project: args.projectPublicId ?? terms.pinned,
    grant: terms.grant,
    caps: terms.caps,
    principal: terms.principal,
    trigger: authUser.work?.trigger ?? null,
    work: authUser.work?.work ?? null,
    actsFor:
      authUser.iamToken?.principal ?? authUser.onBehalfOfPrincipal ?? null,
  };
};

/** Whether two authorities state the same terms and chain. */
export const sameWorkAuthority = (args: {
  a: WorkAuthority | null;
  b: WorkAuthority | null;
}): boolean => {
  return (
    JSON.stringify(authorityColumn(args.a)) ===
    JSON.stringify(authorityColumn(args.b))
  );
};

const sameJson = (a: unknown, b: unknown): boolean => {
  return JSON.stringify(a) === JSON.stringify(b);
};

/**
 * `authority` held to `by` as well: `by`'s grant and every cap of its joins
 * `authority`'s caps, so the result allows only what both allow. Who acts, the
 * chain and the project stay `authority`'s. A term `authority` already states
 * is not repeated, so an authority narrowed by itself is itself.
 */
export const narrowAuthority = (args: {
  authority: WorkAuthority;
  by: Pick<WorkAuthority, 'grant' | 'caps'>;
}): WorkAuthority => {
  const { authority, by } = args;
  const caps = [...authority.caps];
  const candidates: AuthorityCap[] = [
    ...(sameJson(by.grant, authority.grant)
      ? []
      : [{ kind: 'grant' as const, grant: by.grant }]),
    ...by.caps,
  ];
  for (const cap of candidates) {
    const serialized = serializeCap(cap);
    if (
      !caps.some((held) => {
        return sameJson(serializeCap(held), serialized);
      })
    ) {
      caps.push(cap);
    }
  }
  return { ...authority, caps };
};

/**
 * The authority stored work resumes under: what it stores, held to whoever
 * resumes it, so a resume never widens it. Work storing none resumes under
 * none; a resume nobody requested (a project's own) narrows nothing.
 */
export const resumedAuthority = (args: {
  stored: WorkAuthority | null;
  resumer: WorkAuthority | null;
}): WorkAuthority | null => {
  const { stored, resumer } = args;
  if (!stored || !resumer) return stored;
  return narrowAuthority({ authority: stored, by: resumer });
};

/**
 * The authority a firing nobody called runs under: the trigger's own grant,
 * pinned to its project, beginning a chain no firing's work may fire from.
 */
export const triggerAuthority = (args: {
  triggerPublicId: string;
  projectPublicId: string;
}): WorkAuthority => {
  return {
    project: args.projectPublicId,
    grant: { holder: 'trigger', trigger: args.triggerPublicId },
    caps: [],
    principal: { type: 'trigger', id: args.triggerPublicId },
    trigger: args.triggerPublicId,
    work: null,
    actsFor: null,
  };
};

/**
 * The authority of a user, or of an API key on its owner's grant, pinned to
 * `project` and held to `bound` when one is given.
 */
export const principalAuthority = (args: {
  principal:
    | { type: 'user'; id: string }
    | { type: 'api_key'; id: string; owner: string };
  bound: PrincipalBound | undefined;
  project: string;
}): WorkAuthority => {
  const { principal } = args;
  const bound: AuthorityCap[] = args.bound
    ? [
        {
          kind: 'bound',
          bound: args.bound,
          by: { type: 'iam_token', id: null },
        },
      ]
    : [];
  return {
    project: args.project,
    grant: {
      holder: 'user',
      user: principal.type === 'user' ? principal.id : principal.owner,
    },
    caps:
      principal.type === 'user'
        ? bound
        : [{ kind: 'key', key: principal.id }, ...bound],
    principal: { type: principal.type, id: principal.id },
    trigger: null,
    work: null,
    actsFor: null,
  };
};

/**
 * The authority a `run_as: agent` turn's builtin calls run under: the agent's
 * grant alone, pinned to the turn's project, in place of the work's grant and
 * caps. The work's principal, chain and work id carry on.
 */
export const agentWorkAuthority = (args: {
  authority: WorkAuthority;
  agent: Extract<AgentAuthority, { runAs: 'agent' }>;
}): WorkAuthority => {
  const { agent } = args;
  return {
    ...args.authority,
    project: agent.projectPublicId,
    grant: { holder: 'agent', agent: agent.agentId, policy: agent.policy },
    caps: [],
  };
};

/**
 * A resource's grant alone, acting as the resource on `chain`'s behalf: its
 * trigger, work id and the principal it acts for.
 */
export const resourceGrantAuthority = (args: {
  carrier: ResourceGrantCarrier;
  id: string;
  projectPublicId: string;
  chain?: WorkAuthority | null;
}): WorkAuthority => {
  return {
    project: args.projectPublicId,
    grant: { holder: 'resource', carrier: args.carrier, id: args.id },
    caps: [],
    principal: { type: RESOURCE_GRANT_PRINCIPALS[args.carrier], id: args.id },
    trigger: args.chain?.trigger ?? null,
    work: args.chain?.work ?? null,
    actsFor: args.chain?.actsFor ?? null,
  };
};
