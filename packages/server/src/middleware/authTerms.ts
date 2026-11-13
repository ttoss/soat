import type { Context } from '../Context';
import type { DeniedPrincipal } from '../lib/authorizationDenial';
import type {
  AuthorityCap,
  CredentialTerms,
  WorkAuthority,
} from '../lib/workAuthority';
import { type AuthorityTerms, type Cap, NOTHING } from './authority';
import {
  keyBound,
  oauthScopeCap,
  principalBoundCap,
  triggerGrant,
  userBound,
  userGrant,
} from './authScopedBoundary';

type UserRow = { publicId: string; role: string; policyIds: string[] };
type KeyRow = { publicId: string; policyIds: string[] };

/** Rows the caller already loaded, so authenticating costs no second read. */
export type PreloadedRows = { user?: UserRow; key?: KeyRow };

const roleOf = (role: string): 'admin' | 'user' => {
  return role === 'admin' ? 'admin' : 'user';
};

const loadUser = async (args: {
  publicId: string;
  db: Context['db'];
  preloaded?: PreloadedRows;
}): Promise<UserRow | null> => {
  if (args.preloaded?.user?.publicId === args.publicId) {
    return args.preloaded.user;
  }
  const user = await args.db.User.findOne({
    where: { publicId: args.publicId },
    attributes: ['publicId', 'role', 'policyIds'],
  });
  return user
    ? {
        publicId: user.publicId as string,
        role: user.role as string,
        policyIds: user.policyIds,
      }
    : null;
};

const loadKey = async (args: {
  publicId: string;
  db: Context['db'];
  preloaded?: PreloadedRows;
}): Promise<KeyRow | null> => {
  if (args.preloaded?.key?.publicId === args.publicId) {
    return args.preloaded.key;
  }
  const key = await args.db.ApiKey.findOne({
    where: { publicId: args.publicId },
    attributes: ['publicId', 'policyIds'],
  });
  return key
    ? { publicId: key.publicId as string, policyIds: key.policyIds }
    : null;
};

const denied = (principal: CredentialTerms['principal']): DeniedPrincipal => {
  return { type: principal.type, id: principal.id };
};

type CapArgs<K extends AuthorityCap['kind']> = {
  cap: Extract<AuthorityCap, { kind: K }>;
  terms: CredentialTerms;
  replayed: boolean;
  db: Context['db'];
  preloaded?: PreloadedRows;
};

const userCap = async (args: CapArgs<'user'>): Promise<Cap> => {
  const user = await loadUser({ ...args, publicId: args.cap.user });
  return {
    principal: { type: 'user', id: args.cap.user },
    kind: 'other',
    bound: user
      ? userBound({ role: roleOf(user.role), policyIds: user.policyIds })
      : NOTHING,
  };
};

/**
 * Only the presenting key's own `policy_ids` on a live request narrow as
 * `key_policies`; on replayed work every cap is beyond the key.
 */
const keyCap = async (args: CapArgs<'key'>): Promise<Cap> => {
  const { cap, terms } = args;
  const key = await loadKey({ ...args, publicId: cap.key });
  const own =
    !args.replayed &&
    terms.principal.type === 'api_key' &&
    terms.principal.id === cap.key;
  return {
    principal: { type: 'api_key', id: cap.key },
    kind: own ? 'key_policies' : 'other',
    bound: keyBound({ policyIds: key ? key.policyIds : null }),
  };
};

const scopeCap = (args: CapArgs<'scope'>): Cap => {
  const { terms } = args;
  const credential = denied(terms.principal);
  if (terms.pinned === null) {
    return { principal: credential, kind: 'other', bound: NOTHING };
  }
  return oauthScopeCap({
    principal: credential,
    projectPublicId: terms.pinned,
    scopeClaim: args.cap.scope ?? undefined,
  });
};

/** One stated cap as the evaluator reads it. */
const capOf = (args: CapArgs<AuthorityCap['kind']>): Promise<Cap> | Cap => {
  const { cap } = args;
  switch (cap.kind) {
    case 'user':
      return userCap({ ...args, cap });
    case 'key':
      return keyCap({ ...args, cap });
    case 'scope':
      return scopeCap({ ...args, cap });
    case 'bound':
      return principalBoundCap({ principal: cap.by, bound: cap.bound });
  }
};

/**
 * The evaluator's terms for stated credential terms: the grant and every cap
 * read live. Null when the grant's user no longer exists: such terms hold no
 * authority.
 */
export const resolveTerms = async (args: {
  terms: CredentialTerms;
  replayed: boolean;
  db: Context['db'];
  preloaded?: PreloadedRows;
}): Promise<AuthorityTerms | null> => {
  const { terms, db } = args;
  const principal = denied(terms.principal);
  let grant: AuthorityTerms['grant'];
  if (terms.grant.holder === 'user') {
    const user = await loadUser({ ...args, publicId: terms.grant.user });
    if (!user) return null;
    grant = userGrant({
      principal,
      role: roleOf(user.role),
      policyIds: user.policyIds,
    });
  } else {
    grant = triggerGrant({
      principal,
      triggerPublicId: terms.grant.trigger,
      db,
    });
  }
  const caps = await Promise.all(
    terms.caps.map((cap) => {
      return capOf({ ...args, cap });
    })
  );
  return { pinned: terms.pinned, grant, caps, replayed: args.replayed };
};

/** A work authority's terms: its starter's, pinned to the work's project. */
export const workTerms = (authority: WorkAuthority): CredentialTerms => {
  return {
    pinned: authority.project,
    grant: authority.grant,
    caps: authority.caps,
    principal: authority.principal,
  };
};
