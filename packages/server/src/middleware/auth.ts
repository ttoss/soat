import { API_KEY_RAW_PREFIX } from '@soat/postgresdb';
import bcrypt from 'bcryptjs';

import type { AuthUser, Context } from '../Context';
import { AUTH_USER_ATTRIBUTES, verifyApiKey } from '../lib/apiKeyVerifier';
import { attachedWork } from '../lib/inProcessAuthority';
import { parseBound } from '../lib/principalBound';
import {
  BEARER_TOKEN_TYPES,
  type BearerTokenType,
  signToken,
  type VerifiedToken,
  verifyToken,
} from '../lib/signedTokens';
import type { CredentialTerms, WorkAuthority } from '../lib/workAuthority';
import {
  type BoundClaims,
  boundIdentityFields,
  holdsItsBound,
} from './authBound';
import { type ResolvedCredential, withOnBehalfOf } from './authOnBehalfOf';
import { buildAuthority } from './authority';
import { type PreloadedRows, resolveTerms, workTerms } from './authTerms';

export const BCRYPT_SALT_ROUNDS = 12;

export const hashPassword = (password: string) => {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
};

/**
 * Compared against when no user matches, so an unknown username costs the
 * same bcrypt work as a wrong password. Its preimage is discarded random.
 */
export const DUMMY_PASSWORD_HASH =
  '$2b$12$jKOsRv.DkYnzzOeUH1.Uj.dfC5.cJJqZpvjSx9DwlgNH.ekQW5cQK';

export const comparePassword = (password: string, hash: string) => {
  return bcrypt.compare(password, hash);
};

export const signUserToken = (payload: { publicId: string; role: string }) => {
  return signToken({ typ: 'login', claims: payload, expiresIn: '7d' });
};

type Next = () => Promise<void>;

/**
 * A resolved credential: who it is, its stated terms, and the rows read to
 * authenticate it.
 */
type Resolved = ResolvedCredential & { preloaded?: PreloadedRows };

const withAuthority = async (args: {
  resolved: Resolved | undefined;
  replayed: boolean;
  db: Context['db'];
}): Promise<AuthUser | undefined> => {
  if (!args.resolved) return undefined;
  const terms = await resolveTerms({
    terms: args.resolved.authUser.terms,
    replayed: args.replayed,
    db: args.db,
    preloaded: args.resolved.preloaded,
  });
  if (!terms) return undefined;
  return {
    ...args.resolved.authUser,
    ...buildAuthority({ terms, db: args.db }),
  };
};

/**
 * A raw `sk_` key, or undefined when it is not live: its owner's grant capped
 * by the key's own `policy_ids`, pinned to its project when it has one. A key
 * whose project is gone is not live.
 */
const resolveApiKey = async (args: {
  db: Context['db'];
  rawKey: string;
}): Promise<Resolved | undefined> => {
  const { db } = args;
  const verified = await verifyApiKey({ rawKey: args.rawKey });
  if (!verified) return;
  const { apiKey: row, user: keyUser } = verified;
  const apiKeyPolicyIds = row.policyIds;
  const apiKeyPublicId = row.publicId as string;

  const rawProjectId = row.projectId as number | null;
  const project =
    rawProjectId === null
      ? null
      : await db.Project.findOne({ where: { id: rawProjectId } });
  if (rawProjectId !== null && !project) return;

  return {
    authUser: {
      id: keyUser.id as number,
      publicId: keyUser.publicId as string,
      username: keyUser.username as string,
      role: keyUser.role as 'admin' | 'user',
      apiKeyPublicId,
      ...(project
        ? {
            apiKeyProjectId: project.id as number,
            apiKeyProjectPublicId: project.publicId as string,
          }
        : {}),
      ...(apiKeyPolicyIds.length > 0 ? { apiKeyPolicyIds } : {}),
      terms: {
        pinned: project ? (project.publicId as string) : null,
        grant: { holder: 'user', user: keyUser.publicId as string },
        caps: [{ kind: 'key', key: apiKeyPublicId }],
        principal: { type: 'api_key', id: apiKeyPublicId },
      },
    },
    preloaded: {
      user: {
        publicId: keyUser.publicId as string,
        role: keyUser.role as string,
        policyIds: keyUser.policyIds,
      },
      key: { publicId: apiKeyPublicId, policyIds: apiKeyPolicyIds },
    },
  };
};

/**
 * The claims a bearer JWT carries, by its `typ`. Every kind but a login token
 * is pinned to a project (`prj`).
 */
type JwtClaims = {
  publicId: string;
  role: string;
  prj?: string;
  scope?: string;
  key?: string;
} & BoundClaims &
  (
    | { typ: 'login' }
    | { typ: 'oauth'; prj: string }
    | { typ: 'iam'; prj: string; key: string }
  );

const isJwtClaims = (
  claims: VerifiedToken<BearerTokenType>
): claims is VerifiedToken<BearerTokenType> & JwtClaims => {
  if (typeof claims.publicId !== 'string') return false;
  if (claims.typ === 'login') return claims.prj === undefined;
  if (typeof claims.prj !== 'string') return false;
  if (claims.typ === 'iam') return typeof claims.key === 'string';
  return true;
};

/** Verifies a bearer JWT, or null when it is not a valid bearer token of ours. */
const verifyJwtClaims = (token: string): JwtClaims | null => {
  const claims = verifyToken({ token, accept: BEARER_TOKEN_TYPES });
  if (!claims || !isJwtClaims(claims)) return null;
  return holdsItsBound(claims) ? claims : null;
};

/**
 * What a JWT states, by its kind: a login token its user's grant; an OAuth
 * token that grant capped by its consented scope; an IAM token its issuing
 * key's terms capped by its bound.
 */
const jwtTerms = (args: { payload: JwtClaims }): CredentialTerms => {
  const { payload } = args;
  const grant = { holder: 'user' as const, user: payload.publicId };
  if (payload.typ === 'login') {
    return {
      pinned: null,
      grant,
      caps: [],
      principal: { type: 'user', id: payload.publicId },
    };
  }
  if (payload.typ === 'oauth') {
    return {
      pinned: payload.prj,
      grant,
      caps: [{ kind: 'scope', scope: payload.scope ?? null }],
      principal: { type: 'user', id: payload.publicId },
    };
  }
  const bound = parseBound(payload.bnd);
  return {
    pinned: payload.prj,
    grant,
    caps: [
      { kind: 'key', key: payload.key },
      ...(bound
        ? [
            {
              kind: 'bound' as const,
              bound,
              by: { type: 'iam_token' as const, id: payload.jti ?? null },
            },
          ]
        : []),
    ],
    principal: { type: 'api_key', id: payload.key },
  };
};

const resolveJwt = async (args: {
  db: Context['db'];
  token: string;
}): Promise<Resolved | undefined> => {
  const { db, token } = args;
  const payload = verifyJwtClaims(token);
  if (!payload) return;

  const user = await db.User.findOne({
    where: { publicId: payload.publicId },
    attributes: AUTH_USER_ATTRIBUTES,
  });

  if (!user) return;

  return {
    authUser: {
      id: user.id as number,
      publicId: user.publicId as string,
      username: user.username as string,
      role: user.role as 'admin' | 'user',
      ...(payload.prj ? { oauthProjectPublicId: payload.prj } : {}),
      ...(payload.typ === 'oauth' && payload.scope !== undefined
        ? { oauthScope: payload.scope }
        : {}),
      ...(payload.typ === 'iam' ? { apiKeyPublicId: payload.key } : {}),
      ...boundIdentityFields(payload),
      terms: jwtTerms({ payload }),
    },
    preloaded: {
      user: {
        publicId: user.publicId as string,
        role: user.role as string,
        policyIds: user.policyIds,
      },
    },
  };
};

/** The user stored work's principal names: a key's owner, none for a trigger. */
const workUser = async (args: {
  db: Context['db'];
  principal: WorkAuthority['principal'];
}): Promise<InstanceType<Context['db']['User']> | null | undefined> => {
  const { db, principal } = args;
  if (principal.type === 'trigger') return null;
  if (principal.type === 'user') {
    const user = await db.User.findOne({
      where: { publicId: principal.id },
      attributes: AUTH_USER_ATTRIBUTES,
    });
    return user ?? undefined;
  }
  const key = await db.ApiKey.findOne({
    where: { publicId: principal.id },
    include: [{ model: db.User, attributes: AUTH_USER_ATTRIBUTES }],
  });
  return key?.user ?? undefined;
};

/**
 * Stored work's authority as the caller it acts as. Undefined when it no
 * longer resolves: the user or key its principal names is gone.
 */
const resolveWork = async (args: {
  db: Context['db'];
  authority: WorkAuthority;
}): Promise<Resolved | undefined> => {
  const { authority } = args;
  const { principal } = authority;
  const user = await workUser({ db: args.db, principal });
  if (user === undefined) return;
  return {
    authUser: {
      ...(user
        ? {
            id: user.id as number,
            publicId: user.publicId as string,
            username: user.username as string,
            // Under an agent's grant, the user names who started the work only.
            role:
              authority.grant.holder === 'agent'
                ? 'user'
                : (user.role as 'admin' | 'user'),
          }
        : {}),
      ...(principal.type === 'api_key' ? { apiKeyPublicId: principal.id } : {}),
      ...(authority.project ? { oauthProjectPublicId: authority.project } : {}),
      ...(authority.actsFor ? { onBehalfOfPrincipal: authority.actsFor } : {}),
      work: { trigger: authority.trigger, work: authority.work },
      terms: workTerms(authority),
    },
  };
};

/**
 * The caller stored work acts as, evaluated by the same evaluator a request
 * is; undefined when its authority no longer resolves.
 */
export const authUserOfWork = async (args: {
  db: Context['db'];
  authority: WorkAuthority;
}): Promise<AuthUser | undefined> => {
  return withAuthority({
    resolved: await resolveWork(args),
    replayed: true,
    db: args.db,
  });
};

const resolveBearer = async (args: {
  db: Context['db'];
  authHeader: string | undefined;
}): Promise<Resolved | undefined> => {
  if (!args.authHeader?.startsWith('Bearer ')) return;
  const token = args.authHeader.slice(7);
  return token.startsWith(API_KEY_RAW_PREFIX)
    ? resolveApiKey({ db: args.db, rawKey: token })
    : resolveJwt({ db: args.db, token });
};

/**
 * Admits a raw `sk_` key to the MCP endpoint's `verifyToken` gate, or null when
 * it is not a live key. Per-request authorization still runs in
 * `resolveApiKey` when the tool handler forwards the same bearer to REST.
 */
export const verifyApiKeyToken = async (
  token: string
): Promise<{ sub: string; apiKeyPublicId: string } | null> => {
  const verified = await verifyApiKey({ rawKey: token });
  if (!verified) return null;
  return {
    sub: verified.user.publicId as string,
    apiKeyPublicId: verified.apiKey.publicId as string,
  };
};

export const authMiddleware = async (ctx: Context, next: Next) => {
  const work = attachedWork(ctx.req);
  if (work) {
    const authUser = await authUserOfWork({
      db: ctx.db,
      authority: work.authority,
    });
    ctx.authUser = authUser && {
      ...authUser,
      work: {
        trigger: work.authority.trigger,
        work: work.authority.work,
        actor: work.actor,
      },
    };
    await next();
    return;
  }
  const resolved = await resolveBearer({
    db: ctx.db,
    authHeader: ctx.headers?.authorization,
  });
  ctx.authUser = await withAuthority({
    resolved: resolved && {
      ...withOnBehalfOf({ headers: ctx.headers ?? {}, resolved }),
      preloaded: resolved.preloaded,
    },
    replayed: false,
    db: ctx.db,
  });

  await next();
};
