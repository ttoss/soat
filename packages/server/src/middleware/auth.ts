import { API_KEY_RAW_PREFIX } from '@soat/postgresdb';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import type { Context } from '../Context';
import type { PolicyDocument } from '../lib/iam';
import { extractProjectIdsFromPolicies } from '../lib/iam';
import { createApiKeyIsAllowed, createJwtIsAllowed } from '../lib/permissions';

export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret';

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

type IsAllowedFn = (args: {
  projectPublicId: string;
  action: string;
}) => Promise<boolean>;

const filterAccessibleProjects = async (args: {
  projectPublicIds: string[] | null;
  action: string;
  isAllowed: IsAllowedFn;
  db: Context['db'];
}): Promise<number[]> => {
  const projects = args.projectPublicIds
    ? await args.db.Project.findAll({
        where: { publicId: args.projectPublicIds },
      })
    : await args.db.Project.findAll();

  const accessible: number[] = [];
  for (const proj of projects) {
    const allowed = await args.isAllowed({
      projectPublicId: proj.publicId as string,
      action: args.action,
    });
    if (allowed) accessible.push(proj.id as number);
  }
  return accessible;
};

const resolveProjectIdsByPublicIdAndPolicy = async (args: {
  reqProjectPublicId?: string;
  action: string;
  isAllowed: IsAllowedFn;
  policyIds: number[];
  db: Context['db'];
}): Promise<number[] | null> => {
  if (args.reqProjectPublicId) {
    const allowed = await args.isAllowed({
      projectPublicId: args.reqProjectPublicId,
      action: args.action,
    });
    if (!allowed) return null;
    const proj = await args.db.Project.findOne({
      where: { publicId: args.reqProjectPublicId },
    });
    if (!proj) return null;
    return [proj.id as number];
  }

  if (args.policyIds.length === 0) return [];

  const policies = await args.db.Policy.findAll({
    where: { id: args.policyIds },
  });
  const policyDocs = policies.map(
    (p: InstanceType<(typeof args.db)['Policy']>) => {
      return p.document as PolicyDocument;
    }
  );
  const projectPublicIds = extractProjectIdsFromPolicies(policyDocs);

  if (projectPublicIds != null && projectPublicIds.length === 0) return [];

  return filterAccessibleProjects({
    projectPublicIds: projectPublicIds ?? null,
    action: args.action,
    isAllowed: args.isAllowed,
    db: args.db,
  });
};

const resolveApiKeyScopedProjectIds = async (args: {
  apiKeyProjectPublicId: string;
  reqProjectPublicId?: string;
  action: string;
  apiKeyIsAllowed: (a: {
    projectPublicId: string;
    action: string;
  }) => Promise<boolean>;
  db: Context['db'];
}): Promise<number[] | null> => {
  const targetId = args.reqProjectPublicId ?? args.apiKeyProjectPublicId;
  if (
    args.reqProjectPublicId &&
    args.reqProjectPublicId !== args.apiKeyProjectPublicId
  )
    return null;
  const allowed = await args.apiKeyIsAllowed({
    projectPublicId: targetId,
    action: args.action,
  });
  if (!allowed) return null;
  const proj = await args.db.Project.findOne({ where: { publicId: targetId } });
  if (!proj) return null;
  return [proj.id as number];
};

const resolveApiKeyUnscopedProjectIds = async (args: {
  reqProjectPublicId?: string;
  action: string;
  apiKeyIsAllowed: IsAllowedFn;
  apiKeyPolicyIds: number[];
  userPolicyIds: number[];
  db: Context['db'];
}): Promise<number[] | null> => {
  const effectivePolicyIds =
    args.apiKeyPolicyIds.length > 0 ? args.apiKeyPolicyIds : args.userPolicyIds;

  return resolveProjectIdsByPublicIdAndPolicy({
    reqProjectPublicId: args.reqProjectPublicId,
    action: args.action,
    isAllowed: args.apiKeyIsAllowed,
    policyIds: effectivePolicyIds,
    db: args.db,
  });
};

const createApiKeyResolveProjectIds = (args: {
  apiKeyProjectPublicId?: string;
  apiKeyIsAllowed: IsAllowedFn;
  apiKeyPolicyIds: number[];
  userPolicyIds: number[];
  db: Context['db'];
}) => {
  return async ({
    projectPublicId: reqId,
    action,
  }: {
    projectPublicId?: string;
    action: string;
  }): Promise<number[] | null | undefined> => {
    if (args.apiKeyProjectPublicId) {
      return resolveApiKeyScopedProjectIds({
        apiKeyProjectPublicId: args.apiKeyProjectPublicId,
        reqProjectPublicId: reqId,
        action,
        apiKeyIsAllowed: args.apiKeyIsAllowed,
        db: args.db,
      });
    }
    return resolveApiKeyUnscopedProjectIds({
      reqProjectPublicId: reqId,
      action,
      apiKeyIsAllowed: args.apiKeyIsAllowed,
      apiKeyPolicyIds: args.apiKeyPolicyIds,
      userPolicyIds: args.userPolicyIds,
      db: args.db,
    });
  };
};

const resolveProjectKey = async (ctx: Context, rawKey: string) => {
  const keyPrefix = rawKey.substring(0, 8);

  const candidates = await ctx.db.ApiKey.findAll({
    where: { keyPrefix },
    include: [{ model: ctx.db.User }],
  });

  for (const row of candidates) {
    const match = await bcrypt.compare(rawKey, row.keyHash as string);
    if (match) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const keyUser = (row as any).user;
      const userPolicyIds = (keyUser.policyIds as number[]) ?? [];
      const apiKeyPolicyIds = (row.policyIds as number[]) ?? [];

      let apiKeyProjectPublicId: string | undefined;
      let apiKeyProjectId: number | undefined;
      if (row.projectId) {
        apiKeyProjectId = row.projectId as number;
        const proj = await ctx.db.Project.findOne({
          where: { id: apiKeyProjectId },
        });
        apiKeyProjectPublicId = proj?.publicId as string | undefined;
      }

      const apiKeyIsAllowed = createApiKeyIsAllowed({
        apiKeyProjectPublicId,
        userPolicyIds,
        apiKeyPolicyIds,
        db: ctx.db,
      });

      ctx.authUser = {
        id: keyUser.id as number,
        publicId: keyUser.publicId as string,
        username: keyUser.username as string,
        role: keyUser.role as 'admin' | 'user',
        apiKeyProjectId,
        apiKeyProjectPublicId,
        isAllowed: apiKeyIsAllowed,
        resolveProjectIds: createApiKeyResolveProjectIds({
          apiKeyProjectPublicId,
          apiKeyIsAllowed,
          apiKeyPolicyIds,
          userPolicyIds,
          db: ctx.db,
        }),
        getPolicies: async (
          reqProjectPublicId: string
        ): Promise<PolicyDocument[]> => {
          if (
            apiKeyProjectPublicId &&
            reqProjectPublicId !== apiKeyProjectPublicId
          ) {
            return [];
          }
          if (apiKeyPolicyIds.length > 0) {
            const keyPolicies = await ctx.db.Policy.findAll({
              where: { id: apiKeyPolicyIds },
            });
            return keyPolicies.map(
              (p: InstanceType<(typeof ctx.db)['Policy']>) => {
                return p.document as PolicyDocument;
              }
            );
          }
          if (userPolicyIds.length === 0) return [];
          const userPolicies = await ctx.db.Policy.findAll({
            where: { id: userPolicyIds },
          });
          return userPolicies.map(
            (p: InstanceType<(typeof ctx.db)['Policy']>) => {
              return p.document as PolicyDocument;
            }
          );
        },
      };
      break;
    }
  }
};

const createJwtResolveProjectIds = (args: {
  userId: number;
  role: 'admin' | 'user';
  userPolicyIds: number[];
  db: Context['db'];
  jwtIsAllowed: ReturnType<typeof createJwtIsAllowed>;
}) => {
  return async ({
    projectPublicId,
    action,
  }: {
    projectPublicId?: string;
    action: string;
  }) => {
    if (args.role === 'admin' && !projectPublicId) return undefined;

    return resolveProjectIdsByPublicIdAndPolicy({
      reqProjectPublicId: projectPublicId,
      action,
      isAllowed: args.jwtIsAllowed,
      policyIds: args.userPolicyIds,
      db: args.db,
    });
  };
};

const createJwtGetPolicies = (args: {
  userPolicyIds: number[];
  role: 'admin' | 'user';
  db: Context['db'];
}) => {
  return async (_reqProjectPublicId: string): Promise<PolicyDocument[]> => {
    if (args.role === 'admin') {
      return [
        {
          statement: [{ effect: 'Allow', action: ['*'], resource: ['*'] }],
        },
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
  let payload: { publicId: string; role: string };

  try {
    payload = jwt.verify(token, JWT_SECRET) as typeof payload;
  } catch {
    return;
  }

  const user = await ctx.db.User.findOne({
    where: { publicId: payload.publicId },
  });

  if (!user) {
    return;
  }

  const userId = user.id as number;
  const role = user.role as 'admin' | 'user';
  const userPolicyIds = (user.policyIds as number[]) ?? [];
  const jwtIsAllowed = createJwtIsAllowed({ role, userPolicyIds, db: ctx.db });

  ctx.authUser = {
    id: userId,
    publicId: user.publicId as string,
    username: user.username as string,
    role,
    isAllowed: jwtIsAllowed,
    resolveProjectIds: createJwtResolveProjectIds({
      userId,
      role,
      userPolicyIds,
      db: ctx.db,
      jwtIsAllowed,
    }),
    getPolicies: createJwtGetPolicies({ userPolicyIds, role, db: ctx.db }),
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
