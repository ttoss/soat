import { API_KEY_RAW_PREFIX } from '@soat/postgresdb';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import type { Context } from '../Context';
import type { PolicyDocument } from '../lib/iam';
import { createApiKeyIsAllowed, createJwtIsAllowed } from '../lib/permissions';
import type { IsAllowedFn } from './authProjectResolvers';
import {
  createApiKeyResolveProjectIds,
  createJwtResolveProjectIds,
  createUnscopedApiKeyResolveProjectIds,
} from './authProjectResolvers';
import { resolveScopedBoundaryDocs } from './authScopedBoundary';

const requireJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set');
  }
  return secret;
};

export const JWT_SECRET = requireJwtSecret();

export const BCRYPT_SALT_ROUNDS = 12;

export const hashPassword = (password: string) => {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
};

export const comparePassword = (password: string, hash: string) => {
  return bcrypt.compare(password, hash);
};

export const signUserToken = (payload: { publicId: string; role: string }) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
};

type Next = () => Promise<void>;

const USER_ATTRIBUTES = [
  'id',
  'publicId',
  'username',
  'role',
  'policyIds',
  'createdAt',
  'updatedAt',
];

const ADMIN_WILDCARD_POLICY: PolicyDocument = {
  statement: [{ effect: 'Allow', action: ['*'], resource: ['*'] }],
};

const createApiKeyGetPolicies = (args: {
  apiKeyProjectPublicId: string | undefined;
  apiKeyPolicyIds: number[];
  boundaryPolicyDocs?: PolicyDocument[];
  userPolicyIds: number[];
  role: 'admin' | 'user';
  db: Context['db'];
}) => {
  return async (reqProjectPublicId: string): Promise<PolicyDocument[]> => {
    if (
      args.apiKeyProjectPublicId &&
      reqProjectPublicId !== args.apiKeyProjectPublicId
    ) {
      return [];
    }
    // Inline boundary (OAuth consent) is the effective policy set, mirroring how
    // an API key's attached policies become the effective set below.
    if (args.boundaryPolicyDocs) {
      return args.boundaryPolicyDocs;
    }
    if (args.apiKeyPolicyIds.length > 0) {
      const keyPolicies = await args.db.Policy.findAll({
        where: { id: args.apiKeyPolicyIds },
      });
      return keyPolicies.map((p: InstanceType<(typeof args.db)['Policy']>) => {
        return p.document as PolicyDocument;
      });
    }
    if (args.role === 'admin') return [ADMIN_WILDCARD_POLICY];
    if (args.userPolicyIds.length === 0) return [];
    const userPolicies = await args.db.Policy.findAll({
      where: { id: args.userPolicyIds },
    });
    return userPolicies.map((p: InstanceType<(typeof args.db)['Policy']>) => {
      return p.document as PolicyDocument;
    });
  };
};

const resolveProjectKey = async (ctx: Context, rawKey: string) => {
  const keyPrefix = rawKey.substring(0, 8);

  const candidates = await ctx.db.ApiKey.findAll({
    where: { keyPrefix },
    include: [
      {
        model: ctx.db.User,
        attributes: USER_ATTRIBUTES,
      },
    ],
  });

  for (const row of candidates) {
    const match = await bcrypt.compare(rawKey, row.keyHash as string);
    if (match) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const keyUser = (row as any).user;
      const userPolicyIds = (keyUser.policyIds as number[]) ?? [];
      const apiKeyPolicyIds = (row.policyIds as number[]) ?? [];
      const role = keyUser.role as 'admin' | 'user';

      // `projectId` is nullable: a null value means the key is unscoped (spans
      // projects). Only resolve the project public ID when the key is scoped.
      const rawProjectId = row.projectId as number | null;
      let apiKeyProjectId: number | undefined;
      let apiKeyProjectPublicId: string | undefined;
      if (rawProjectId != null) {
        const proj = await ctx.db.Project.findOne({
          where: { id: rawProjectId },
        });
        if (proj) {
          apiKeyProjectId = rawProjectId;
          apiKeyProjectPublicId = proj.publicId as string;
        }
      }

      const apiKeyIsAllowed = createApiKeyIsAllowed({
        apiKeyProjectPublicId,
        userRole: role,
        userPolicyIds,
        apiKeyPolicyIds,
        db: ctx.db,
      });

      ctx.authUser = {
        id: keyUser.id as number,
        publicId: keyUser.publicId as string,
        username: keyUser.username as string,
        role,
        apiKeyProjectId,
        apiKeyProjectPublicId,
        isAllowed: apiKeyIsAllowed,
        resolveProjectIds: apiKeyProjectPublicId
          ? createApiKeyResolveProjectIds({
              apiKeyProjectPublicId,
              apiKeyIsAllowed,
              db: ctx.db,
            })
          : createUnscopedApiKeyResolveProjectIds({
              userRole: role,
              hasKeyBoundary: apiKeyPolicyIds.length > 0,
              apiKeyIsAllowed,
              db: ctx.db,
            }),
        getPolicies: createApiKeyGetPolicies({
          apiKeyProjectPublicId,
          apiKeyPolicyIds,
          userPolicyIds,
          role,
          db: ctx.db,
        }),
      };
      break;
    }
  }
};

/** Project-scoping identity fields to spread onto a JWT-derived `authUser`. */
const buildScopedIdentityFields = (args: {
  scopedProjectPublicId?: string;
  isTriggerToken: boolean;
}): { oauthProjectPublicId?: string; isTriggerToken?: boolean } => {
  return {
    ...(args.scopedProjectPublicId
      ? { oauthProjectPublicId: args.scopedProjectPublicId }
      : {}),
    ...(args.isTriggerToken ? { isTriggerToken: true } : {}),
  };
};

/** Builds the `getPolicies` implementation for a plain (unscoped) user JWT. */
const createJwtGetPolicies = (args: {
  role: 'admin' | 'user';
  userPolicyIds: number[];
  db: Context['db'];
}) => {
  return async (_: string): Promise<PolicyDocument[]> => {
    if (args.role === 'admin') {
      return [
        { statement: [{ effect: 'Allow', action: ['*'], resource: ['*'] }] },
      ];
    }
    if (args.userPolicyIds.length === 0) return [];
    const policies = await args.db.Policy.findAll({
      where: { id: args.userPolicyIds },
    });
    return policies.map((p: InstanceType<(typeof args.db)['Policy']>) => {
      return p.document as PolicyDocument;
    });
  };
};

const resolveJwt = async (ctx: Context, token: string) => {
  let payload: {
    publicId: string;
    role: string;
    prj?: string;
    scope?: string;
    trg?: string;
  };

  try {
    payload = jwt.verify(token, JWT_SECRET) as typeof payload;
  } catch {
    return;
  }

  if (typeof payload.publicId !== 'string') return;

  const user = await ctx.db.User.findOne({
    where: { publicId: payload.publicId },
    attributes: USER_ATTRIBUTES,
  });

  if (!user) return;
  const userId = user.id as number;
  const role = user.role as 'admin' | 'user';
  const userPolicyIds = (user.policyIds as number[]) ?? [];
  const jwtIsAllowed = createJwtIsAllowed({ role, userPolicyIds, db: ctx.db });
  const scopedProjectPublicId = payload.prj;
  const isTriggerToken = typeof payload.trg === 'string';

  // Both OAuth access tokens and trigger run-as tokens are project-scoped
  // credentials: they intersect the owning user's policies with a boundary
  // through the same evaluator used for API keys, hard-confined to the project.
  const boundaryPolicyDocs = await resolveScopedBoundaryDocs({
    scopedProjectPublicId,
    triggerPublicId: isTriggerToken ? payload.trg : undefined,
    scopeClaim: payload.scope,
    db: ctx.db,
  });

  const isAllowed: IsAllowedFn = scopedProjectPublicId
    ? createApiKeyIsAllowed({
        apiKeyProjectPublicId: scopedProjectPublicId,
        userRole: role,
        userPolicyIds,
        apiKeyPolicyIds: [],
        boundaryPolicyDocs,
        db: ctx.db,
      })
    : jwtIsAllowed;

  ctx.authUser = {
    id: userId,
    publicId: user.publicId as string,
    username: user.username as string,
    role,
    ...buildScopedIdentityFields({ scopedProjectPublicId, isTriggerToken }),
    isAllowed,
    resolveProjectIds: scopedProjectPublicId
      ? createApiKeyResolveProjectIds({
          apiKeyProjectPublicId: scopedProjectPublicId,
          apiKeyIsAllowed: isAllowed,
          db: ctx.db,
        })
      : createJwtResolveProjectIds({
          role,
          userPolicyIds,
          jwtIsAllowed,
          db: ctx.db,
        }),
    getPolicies: scopedProjectPublicId
      ? createApiKeyGetPolicies({
          apiKeyProjectPublicId: scopedProjectPublicId,
          apiKeyPolicyIds: [],
          boundaryPolicyDocs,
          userPolicyIds,
          role,
          db: ctx.db,
        })
      : createJwtGetPolicies({ role, userPolicyIds, db: ctx.db }),
  };
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

  await next();
};
