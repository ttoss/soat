import { API_KEY_RAW_PREFIX } from '@soat/postgresdb';
import bcrypt from 'bcryptjs';

import type { AuthUser, Context } from '../Context';
import { AUTH_USER_ATTRIBUTES, verifyApiKey } from '../lib/apiKeyVerifier';
import { resolveBoundSets } from '../lib/attachedPolicies';
import {
  callerPrincipal,
  type DeniedPrincipal,
} from '../lib/authorizationDenial';
import { issuingKeyProject, requestOnBehalfOf } from '../lib/onBehalfOf';
import { type LabeledPolicySets, resolvePolicySets } from '../lib/permissions';
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
import { narrowToOnBehalfOf } from './authOnBehalfOf';
import { type Authority, buildAuthority } from './authority';
import {
  resolveScopedBoundaryDocs,
  resolveTriggerPolicySets,
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

/**
 * An API key's authority: its owner's policies capped by the key's own, pinned
 * to the key's project when it has one.
 */
const apiKeyAuthority = (args: {
  apiKeyPublicId: string;
  projectPublicId: string | undefined;
  role: 'admin' | 'user';
  userPolicyIds: number[];
  apiKeyPolicyIds: number[];
  db: Context['db'];
}): Authority => {
  const { role, userPolicyIds, apiKeyPolicyIds, db } = args;
  return buildAuthority({
    reach: args.projectPublicId
      ? { pinned: args.projectPublicId }
      : {
          pinned: null,
          everyProject: role === 'admin' && apiKeyPolicyIds.length === 0,
          candidatePolicyIds: 'all',
        },
    getSets: async () => {
      return [
        {
          principal: { type: 'api_key', id: args.apiKeyPublicId },
          sets: await resolvePolicySets({
            userRole: role,
            userPolicyIds,
            apiKeyPolicyIds,
            db,
          }),
        },
      ];
    },
    db,
  });
};

/** The caller a raw `sk_` key resolves to, or undefined when it is not live. */
const resolveApiKeyAuthUser = async (args: {
  db: Context['db'];
  rawKey: string;
}): Promise<Context['authUser']> => {
  const { db } = args;
  const verified = await verifyApiKey({ rawKey: args.rawKey });
  if (!verified) return;
  const { apiKey: row, user: keyUser } = verified;
  const userPolicyIds = (keyUser.policyIds as number[]) ?? [];
  const apiKeyPolicyIds = (row.policyIds as number[]) ?? [];
  const role = keyUser.role as 'admin' | 'user';

  // `projectId` is nullable: a null value means the key is unscoped (spans
  // projects). Only resolve the project public ID when the key is scoped.
  const rawProjectId = row.projectId as number | null;
  let apiKeyProjectId: number | undefined;
  let apiKeyProjectPublicId: string | undefined;
  if (rawProjectId != null) {
    const proj = await db.Project.findOne({
      where: { id: rawProjectId },
    });
    if (proj) {
      apiKeyProjectId = rawProjectId;
      apiKeyProjectPublicId = proj.publicId as string;
    }
  }

  return {
    id: keyUser.id as number,
    publicId: keyUser.publicId as string,
    username: keyUser.username as string,
    role,
    apiKeyPublicId: row.publicId as string,
    apiKeyProjectId,
    apiKeyProjectPublicId,
    ...(apiKeyPolicyIds.length > 0 ? { apiKeyPolicyIds } : {}),
    isControlPlaneKey:
      role === 'admin' && rawProjectId == null && apiKeyPolicyIds.length === 0,
    ...apiKeyAuthority({
      apiKeyPublicId: row.publicId as string,
      projectPublicId: apiKeyProjectPublicId,
      role,
      userPolicyIds,
      apiKeyPolicyIds,
      db,
    }),
  };
};

/**
 * Project-scoping and credential-identity fields to spread onto a JWT-derived
 * `authUser`.
 *
 * `apiKeyPublicId` is set from a run token's `key` claim so a key-started run
 * *names the key* everywhere attribution is derived — task history, audit
 * entries, the principal an automation chain inherits. The claim already
 * decided the run's authorization boundary in `resolveScopedBoundaryDocs`; this
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
 * An IAM token's bound, or the one a run token carries for work a token
 * started: one more set, read per check, so it only narrows. Only an IAM
 * token's own claims carry the id that names it.
 */
const boundSets = async (payload: JwtClaims): Promise<LabeledPolicySets> => {
  const bound = parseBound(payload.bnd);
  if (!bound) return [];
  const id = payload.typ === 'iam' ? (payload.jti ?? null) : null;
  return [
    {
      principal: { type: 'iam_token', id },
      sets: await resolveBoundSets(bound),
    },
  ];
};

/**
 * What a JWT may do. A project-scoped credential is pinned to its project and
 * intersects the owning user's policies with its boundary; a trigger token
 * instead acts under the trigger's own policy sets. Every set but an IAM token
 * bound is the `credential`'s.
 */
const resolveJwtAuthority = async (args: {
  payload: JwtClaims;
  credential: DeniedPrincipal;
  role: 'admin' | 'user';
  userPolicyIds: number[];
  db: Context['db'];
}): Promise<Authority> => {
  const { payload, credential, role, userPolicyIds, db } = args;
  if (payload.typ === 'login') {
    return buildAuthority({
      reach: {
        pinned: null,
        everyProject: role === 'admin',
        candidatePolicyIds: userPolicyIds,
      },
      getSets: async () => {
        return [
          {
            principal: credential,
            sets: await resolvePolicySets({
              userRole: role,
              userPolicyIds,
              apiKeyPolicyIds: [],
              db,
            }),
          },
        ];
      },
      db,
    });
  }
  const scoped = payload.prj;
  if (payload.typ === 'trigger') {
    const triggerPublicId = payload.trg;
    return buildAuthority({
      reach: { pinned: scoped },
      getSets: async () => {
        const sets = await resolveTriggerPolicySets({
          triggerPublicId,
          projectPublicId: scoped,
          caller: payload.clr
            ? {
                role,
                userPolicyIds,
                apiKeyPublicId: payload.ckey,
                oauthScope: payload.cscope,
                bound: parseBound(payload.cbnd) ?? undefined,
              }
            : undefined,
          db,
        });
        return [{ principal: credential, sets }];
      },
      db,
    });
  }
  const boundaryPolicyDocs = await resolveScopedBoundaryDocs({
    scopedProjectPublicId: scoped,
    credential:
      payload.typ === 'oauth'
        ? { typ: payload.typ, scopeClaim: payload.scope }
        : { typ: payload.typ, apiKeyPublicId: actingKeyOf(payload) },
    db,
  });
  return buildAuthority({
    reach: { pinned: scoped },
    getSets: async () => {
      const sets = await resolvePolicySets({
        userRole: role,
        userPolicyIds,
        apiKeyPolicyIds: [],
        boundaryPolicyDocs,
        db,
      });
      return [{ principal: credential, sets }, ...(await boundSets(payload))];
    },
    db,
  });
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
  const { db, token } = args;
  const payload = verifyJwtClaims(token);
  if (!payload) return;

  const user = await db.User.findOne({
    where: { publicId: payload.publicId },
    attributes: AUTH_USER_ATTRIBUTES,
  });

  if (!user) return;
  const userId = user.id as number;
  const role = user.role as 'admin' | 'user';
  const userPolicyIds = (user.policyIds as number[]) ?? [];
  const scopedProjectPublicId = payload.prj;
  const isTriggerToken = payload.typ === 'trigger';
  const isRunToken = payload.typ === 'run';
  const runApiKeyPublicId = actingKeyOf(payload);

  const authority = await resolveJwtAuthority({
    payload,
    credential: callerPrincipal({
      publicId: user.publicId as string,
      apiKeyPublicId: runApiKeyPublicId,
    }),
    role,
    userPolicyIds,
    db,
  });

  return {
    id: userId,
    publicId: user.publicId as string,
    username: user.username as string,
    role,
    ...buildScopedIdentityFields({
      scopedProjectPublicId,
      isTriggerToken,
      isRunToken,
      runApiKeyPublicId,
      runWorkPublicId: payload.orn,
      oauthScope: payload.typ === 'oauth' ? payload.scope : undefined,
    }),
    ...boundIdentityFields(payload),
    ...authority,
  };
};

/**
 * The caller an `Authorization: Bearer` value resolves to, outside a request:
 * how a tool call evaluates the principal it runs for.
 */
export const resolveBearerAuthUser = async (args: {
  db: Context['db'];
  authHeader: string | undefined;
}): Promise<Context['authUser']> => {
  if (!args.authHeader?.startsWith('Bearer ')) return;
  const token = args.authHeader.slice(7);
  return token.startsWith(API_KEY_RAW_PREFIX)
    ? resolveApiKeyAuthUser({ db: args.db, rawKey: token })
    : resolveJwtAuthUser({ db: args.db, token });
};

const resolveProjectKey = async (ctx: Context, rawKey: string) => {
  const authUser = await resolveApiKeyAuthUser({ db: ctx.db, rawKey });
  if (authUser) ctx.authUser = authUser;
};

const resolveJwt = async (ctx: Context, token: string) => {
  const authUser = await resolveJwtAuthUser({ db: ctx.db, token });
  if (authUser) ctx.authUser = authUser;
};

/**
 * Admits a raw `sk_` key to the MCP endpoint's `verifyToken` gate, or null when
 * it is not a live key. Per-request authorization still runs in
 * `resolveProjectKey` when the tool handler forwards the same bearer to REST.
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

/** The caller capped by the `On-Behalf-Of` assertion it sends, if any. */
const applyOnBehalfOf = (args: {
  ctx: Context;
  authUser: AuthUser;
}): AuthUser => {
  const { authUser } = args;
  const projectPublicId = issuingKeyProject(authUser);
  const asserted = requestOnBehalfOf({
    headers: args.ctx.headers ?? {},
    keyProjectPublicId: projectPublicId,
  });
  if (!asserted || !projectPublicId) return authUser;
  return narrowToOnBehalfOf({
    authUser,
    asserted,
    projectPublicId,
    db: args.ctx.db,
  });
};

export const authMiddleware = async (ctx: Context, next: Next) => {
  const authHeader: string | undefined = ctx.headers?.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    if (token.startsWith(API_KEY_RAW_PREFIX)) {
      await resolveProjectKey(ctx, token);
    } else {
      await resolveJwt(ctx, token);
    }
  }

  if (ctx.authUser) {
    ctx.authUser = applyOnBehalfOf({ ctx, authUser: ctx.authUser });
  }

  await next();
};
