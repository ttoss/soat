import type { AuthUser } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';
import { actsForOf } from './actsFor';
import {
  type DeniedPrincipal,
  readDeniedPrincipal,
} from './authorizationDenial';
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
import { readToolContextLayer } from './toolContextLayer';

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
 * a bound (an IAM token's, an `On-Behalf-Of` assertion's), or a project's
 * `agent_policy_ids` over an agent's work.
 */
export type AuthorityCap =
  | { kind: 'grant'; grant: AuthorityGrant }
  | { kind: 'key'; key: string }
  | { kind: 'project_agents'; project: string }
  | { kind: 'scope'; scope: string | null }
  | { kind: 'bound'; bound: PrincipalBound; by: DeniedPrincipal };

/**
 * Every type a credential or stored work acts as, `ActingPrincipalType` in
 * `principals.yaml`; `principalFieldContract.test.ts` holds the two equal.
 */
export const ACTING_PRINCIPAL_TYPES: readonly (
  'user' | 'api_key' | 'trigger' | ResourceGrantPrincipalType
)[] = ['user', 'api_key', 'trigger', ...RESOURCE_GRANT_PRINCIPAL_TYPES];

/** The principal that acts: what records credit and refusals name. */
export type ActingPrincipal = {
  type: (typeof ACTING_PRINCIPAL_TYPES)[number];
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
  /** The IAM token's `tool_context` layer, stamped over every tool call. */
  toolContext: Record<string, string> | null;
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
    ...(authority.toolContext ? { tool_context: authority.toolContext } : {}),
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
  project_agents: (value) => {
    return str(value.project)
      ? { kind: 'project_agents', project: value.project }
      : null;
  },
  scope: (value) => {
    return value.scope === null || typeof value.scope === 'string'
      ? { kind: 'scope', scope: value.scope }
      : null;
  },
  bound: (value) => {
    const bound = parseBound(value.bound);
    const by = readDeniedPrincipal(value.by);
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

const isActingPrincipalType = (
  value: unknown
): value is ActingPrincipal['type'] => {
  return ACTING_PRINCIPAL_TYPES.some((type) => {
    return type === value;
  });
};

const parsePrincipal = (value: unknown): ActingPrincipal | null => {
  if (!isPlainObject(value) || !str(value.id)) return null;
  if (!isActingPrincipalType(value.type)) return null;
  return { type: value.type, id: value.id };
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

type Chain = Pick<
  WorkAuthority,
  'project' | 'trigger' | 'work' | 'actsFor' | 'toolContext'
>;

/** A stored layer: absent is none, a malformed one does not read. */
const parseLayer = (value: unknown): Chain['toolContext'] | undefined => {
  const layer = readToolContextLayer(value);
  return layer === null ? undefined : (layer ?? null);
};

/** The chain fields of a stored authority, or null when one does not read. */
const parseChain = (value: Record<string, unknown>): Chain | null => {
  const chain = {
    project: nullableStr(value.project),
    trigger: nullableStr(value.trigger),
    work: nullableStr(value.work),
    actsFor: parseActsFor(value.acts_for),
    toolContext: parseLayer(value.tool_context),
  };
  const { project, trigger, work, actsFor, toolContext } = chain;
  if (
    project === undefined ||
    trigger === undefined ||
    work === undefined ||
    actsFor === undefined ||
    toolContext === undefined
  ) {
    return null;
  }
  return { project, trigger, work, actsFor, toolContext };
};

/**
 * Reads a stored authority back, or null for an absent or malformed one:
 * work that cannot read its authority holds none.
 */
export const parseWorkAuthority = (value: unknown): WorkAuthority | null => {
  if (!isPlainObject(value)) return null;
  const chain = parseChain(value);
  const grant = parseGrant(value.grant);
  const principal = parsePrincipal(value.principal);
  const caps = parseCaps(value.caps);
  if (!chain || !grant || !principal || !caps) return null;
  return { ...chain, grant, caps, principal };
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

/** The chain a request carries on into work it starts. */
const requestChain = (authUser: AuthUser): Omit<Chain, 'project'> => {
  return {
    trigger: authUser.work?.trigger ?? null,
    work: authUser.work?.work ?? null,
    actsFor: actsForOf(authUser),
    toolContext: authUser.toolContextLayer ?? null,
  };
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
    ...requestChain(authUser),
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
    toolContext: null,
  };
};

/** Agent `agent`'s grant: its resolved `policy_ids`; `null` grants nothing. */
export const agentHeldGrant = (args: {
  agent: string;
  policy: PolicyDocument | null;
}): AuthorityGrant => {
  return { holder: 'agent', agent: args.agent, policy: args.policy };
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
    toolContext: args.chain?.toolContext ?? null,
  };
};
