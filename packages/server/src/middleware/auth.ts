import { API_KEY_RAW_PREFIX } from '@soat/postgresdb';
import bcrypt from 'bcryptjs';

import type { AuthUser, Context } from '../Context';
import { AUTH_USER_ATTRIBUTES, verifyApiKey } from '../lib/apiKeyVerifier';
import {
  callerPrincipal,
  type DeniedPrincipal,
} from '../lib/authorizationDenial';
import { parseBound } from '../lib/principalBound';
import {
  BEARER_TOKEN_TYPES,
  type BearerTokenType,
  signToken,
  type VerifiedToken,
  verifyToken,
} from '../lib/signedTokens';
import {
  actingKeyOf,
  type BoundClaims,
  boundIdentityFields,
  holdsItsBound,
} from './authBound';
import { type ResolvedCredential, withOnBehalfOf } from './authOnBehalfOf';
import { type AuthorityTerms, buildAuthority, type Cap } from './authority';
import {
  actingKeyCap,
  keyPoliciesCap,
  oauthScopeCap,
  principalBoundCap,
  triggerGrant,
  userBound,
  userGrant,
} from './authScopedBoundary';

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

/** A resolved credential: who it is, and its authority's terms. */
type Resolved = ResolvedCredential;

const withAuthority = (args: {
  resolved: Resolved | undefined;
  db: Context['db'];
}): Context['authUser'] => {
  if (!args.resolved) return undefined;
  return {
    ...args.resolved.authUser,
    ...buildAuthority({ terms: args.resolved.terms, db: args.db }),
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
  const role = keyUser.role as 'admin' | 'user';
  const apiKeyPublicId = row.publicId as string;
  const principal: DeniedPrincipal = { type: 'api_key', id: apiKeyPublicId };

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
      role,
      apiKeyPublicId,
      ...(project
        ? {
            apiKeyProjectId: project.id as number,
            apiKeyProjectPublicId: project.publicId as string,
          }
        : {}),
      ...(apiKeyPolicyIds.length > 0 ? { apiKeyPolicyIds } : {}),
    },
    terms: {
      pinned: project ? (project.publicId as string) : null,
      grant: userGrant({
        principal,
        role,
        policyIds: keyUser.policyIds,
      }),
      caps: [keyPoliciesCap({ principal, policyIds: apiKeyPolicyIds })],
    },
  };
};

/**
 * Project-scoping and credential-identity fields to spread onto a JWT-derived
 * `authUser`.
 *
 * `apiKeyPublicId` is set from a run token's `key` claim so a key-started run
 * *names the key* everywhere attribution is derived — task history, audit
 * entries, the principal an automation chain inherits. The claim already
 * caps the run (`actingKeyCap`); this
 * makes the identity match the authority.
 *
 * Deliberately *only* `apiKeyPublicId`, never the `apiKeyProject*` pair: those
 * drive write-project defaulting and scope enforcement, and a run token's
 * project already travels as `oauthProjectPublicId`, which every reader of the
 * pair falls back to — so setting them would only add a second source of truth.
 */
const buildScopedIdentityFields = (args: {
  scopedProjectPublicId?: string;
  isTriggerToken: boolean;
  isRunToken: boolean;
  runApiKeyPublicId?: string;
  runWorkPublicId?: string;
  oauthScope?: string;
}): Pick<
  AuthUser,
  | 'oauthProjectPublicId'
  | 'oauthScope'
  | 'isTriggerToken'
  | 'isRunToken'
  | 'runWorkPublicId'
  | 'apiKeyPublicId'
> => {
  return {
    ...(args.scopedProjectPublicId
      ? { oauthProjectPublicId: args.scopedProjectPublicId }
      : {}),
    ...(args.oauthScope !== undefined ? { oauthScope: args.oauthScope } : {}),
    ...(args.isTriggerToken ? { isTriggerToken: true } : {}),
    ...(args.isRunToken ? { isRunToken: true } : {}),
    ...(args.isRunToken && args.runWorkPublicId
      ? { runWorkPublicId: args.runWorkPublicId }
      : {}),
    // Set only from a run token's or an IAM token's `key` claim.
    ...(args.runApiKeyPublicId
      ? { apiKeyPublicId: args.runApiKeyPublicId }
      : {}),
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
  trg?: string;
  orn?: string;
  key?: string;
  clr?: boolean;
  ckey?: string;
  cscope?: string;
} & BoundClaims &
  (
    | { typ: 'login' }
    | { typ: 'oauth'; prj: string }
    | { typ: 'trigger'; prj: string; trg: string }
    | { typ: 'run'; prj: string; orn: string }
    | { typ: 'iam'; prj: string }
  );

const isJwtClaims = (
  claims: VerifiedToken<BearerTokenType>
): claims is VerifiedToken<BearerTokenType> & JwtClaims => {
  if (typeof claims.publicId !== 'string') return false;
  if (claims.typ === 'login') return claims.prj === undefined;
  if (typeof claims.prj !== 'string') return false;
  if (claims.typ === 'trigger') return typeof claims.trg === 'string';
  if (claims.typ === 'run') return typeof claims.orn === 'string';
  return true;
};

/** Verifies a bearer JWT, or null when it is not a valid bearer token of ours. */
const verifyJwtClaims = (token: string): JwtClaims | null => {
  const claims = verifyToken({ token, accept: BEARER_TOKEN_TYPES });
  if (!claims || !isJwtClaims(claims)) return null;
  return holdsItsBound(claims) ? claims : null;
};

/**
 * The caps a project-scoped JWT adds to its user's grant: an OAuth token's
 * consented scope, or the key a run or IAM token acts as; then an IAM token
 * bound it carries. Only an IAM token's own claims carry the id that names it.
 */
const scopedTokenCaps = async (args: {
  payload: Exclude<JwtClaims, { typ: 'login' } | { typ: 'trigger' }>;
  credential: DeniedPrincipal;
  db: Context['db'];
}): Promise<Cap[]> => {
  const { payload, credential } = args;
  const bound = parseBound(payload.bnd);
  return [
    payload.typ === 'oauth'
      ? oauthScopeCap({
          principal: credential,
          projectPublicId: payload.prj,
          scopeClaim: payload.scope,
        })
      : await actingKeyCap({
          principal: credential,
          apiKeyPublicId: actingKeyOf(payload),
          db: args.db,
        }),
    ...(bound
      ? [
          principalBoundCap({
            principal: {
              type: 'iam_token',
              id: payload.typ === 'iam' ? (payload.jti ?? null) : null,
            },
            bound,
          }),
        ]
      : []),
  ];
};

/**
 * A trigger token acts under the trigger's grant; a manual fire is also capped
 * by its caller's own authority.
 */
const triggerTerms = async (args: {
  payload: Extract<JwtClaims, { typ: 'trigger' }>;
  credential: DeniedPrincipal;
  user: { role: 'admin' | 'user'; policyIds: string[] };
  db: Context['db'];
}): Promise<AuthorityTerms> => {
  const { payload, credential, db } = args;
  const grant = triggerGrant({
    principal: credential,
    triggerPublicId: payload.trg,
    db,
  });
  if (!payload.clr) return { pinned: payload.prj, grant, caps: [] };
  const callerBound = parseBound(payload.cbnd);
  return {
    pinned: payload.prj,
    grant,
    caps: [
      {
        principal: credential,
        kind: 'other',
        bound: userBound(args.user),
      },
      payload.cscope !== undefined
        ? oauthScopeCap({
            principal: credential,
            projectPublicId: payload.prj,
            scopeClaim: payload.cscope,
          })
        : await actingKeyCap({
            principal: credential,
            apiKeyPublicId: payload.ckey,
            db,
          }),
      ...(callerBound
        ? [principalBoundCap({ principal: credential, bound: callerBound })]
        : []),
    ],
  };
};

/** The terms of a JWT's authority, by its kind. */
const jwtTerms = async (args: {
  payload: JwtClaims;
  credential: DeniedPrincipal;
  user: { role: 'admin' | 'user'; policyIds: string[] };
  db: Context['db'];
}): Promise<AuthorityTerms> => {
  const { payload, credential, user, db } = args;
  if (payload.typ === 'trigger') return triggerTerms({ ...args, payload });
  const grant = userGrant({ principal: credential, ...user });
  if (payload.typ === 'login') return { pinned: null, grant, caps: [] };
  return {
    pinned: payload.prj,
    grant,
    caps: await scopedTokenCaps({ payload, credential, db }),
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
  const role = user.role as 'admin' | 'user';
  const runApiKeyPublicId = actingKeyOf(payload);

  return {
    authUser: {
      id: user.id as number,
      publicId: user.publicId as string,
      username: user.username as string,
      role,
      ...buildScopedIdentityFields({
        scopedProjectPublicId: payload.prj,
        isTriggerToken: payload.typ === 'trigger',
        isRunToken: payload.typ === 'run',
        runApiKeyPublicId,
        runWorkPublicId: payload.orn,
        oauthScope: payload.typ === 'oauth' ? payload.scope : undefined,
      }),
      ...boundIdentityFields(payload),
    },
    terms: await jwtTerms({
      payload,
      credential: callerPrincipal({
        publicId: user.publicId as string,
        apiKeyPublicId: runApiKeyPublicId,
      }),
      user: { role, policyIds: user.policyIds },
      db,
    }),
  };
};

/**
 * The caller one of our own JWTs resolves to, or undefined when it is not a
 * valid token of ours. Also how request-less work evaluates the run-as token
 * it minted, so it is authorized by the same evaluator a request is.
 */
export const resolveJwtAuthUser = async (args: {
  db: Context['db'];
  token: string;
}): Promise<Context['authUser']> => {
  return withAuthority({ resolved: await resolveJwt(args), db: args.db });
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
 * The caller an `Authorization: Bearer` value resolves to, outside a request:
 * how a tool call evaluates the principal it runs for.
 */
export const resolveBearerAuthUser = async (args: {
  db: Context['db'];
  authHeader: string | undefined;
}): Promise<Context['authUser']> => {
  return withAuthority({ resolved: await resolveBearer(args), db: args.db });
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
  const resolved = await resolveBearer({
    db: ctx.db,
    authHeader: ctx.headers?.authorization,
  });
  ctx.authUser = withAuthority({
    resolved:
      resolved && withOnBehalfOf({ headers: ctx.headers ?? {}, resolved }),
    db: ctx.db,
  });

  await next();
};
