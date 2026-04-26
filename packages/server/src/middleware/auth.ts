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

      // Resolve the optional project scope to a publicId
      let apiKeyProjectId: string | undefined;
      if (row.projectId) {
        const proj = await ctx.db.Project.findOne({
          where: { id: row.projectId as number },
        });
        apiKeyProjectId = proj?.publicId as string | undefined;
      }

      const apiKeyIsAllowed = createApiKeyIsAllowed({
        apiKeyProjectId,
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
        isAllowed: apiKeyIsAllowed,
        resolveProjectIds: async ({
          projectPublicId: reqId,
          action,
        }: {
          projectPublicId?: string;
          action: string;
        }) => {
          // When the key is hard-scoped to one project
          if (apiKeyProjectId) {
            const targetId = reqId ?? apiKeyProjectId;
            if (reqId && reqId !== apiKeyProjectId) return null;
            const allowed = await apiKeyIsAllowed({
              projectPublicId: targetId,
              action,
            });
            if (!allowed) return null;
            const proj = await ctx.db.Project.findOne({
              where: { publicId: targetId },
            });
            if (!proj) return null;
            return [proj.id as number];
          }

          // Key is not project-scoped
          if (reqId) {
            const allowed = await apiKeyIsAllowed({
              projectPublicId: reqId,
              action,
            });
            if (!allowed) return null;
            const proj = await ctx.db.Project.findOne({
              where: { publicId: reqId },
            });
            if (!proj) return null;
            return [proj.id as number];
          }

          // No explicit project — enumerate from policy SRN patterns
          const effectivePolicyIds =
            apiKeyPolicyIds.length > 0 ? apiKeyPolicyIds : userPolicyIds;
          const effectivePolicies =
            effectivePolicyIds.length > 0
              ? await ctx.db.Policy.findAll({
                  where: { id: effectivePolicyIds },
                })
              : [];
          const effectiveDocs = effectivePolicies.map(
            (p: InstanceType<(typeof ctx.db)['Policy']>) => {
              return p.document as PolicyDocument;
            }
          );
          const projectPublicIds = extractProjectIdsFromPolicies(effectiveDocs);

          if (!projectPublicIds) {
            // Wildcard — all projects (filter by isAllowed)
            const allProjects = await ctx.db.Project.findAll();
            const accessible: number[] = [];
            for (const proj of allProjects) {
              const allowed = await apiKeyIsAllowed({
                projectPublicId: proj.publicId as string,
                action,
              });
              if (allowed) accessible.push(proj.id as number);
            }
            return accessible;
          }

          if (projectPublicIds.length === 0) return [];

          const projects = await ctx.db.Project.findAll({
            where: { publicId: projectPublicIds },
          });
          const accessible: number[] = [];
          for (const proj of projects) {
            const allowed = await apiKeyIsAllowed({
              projectPublicId: proj.publicId as string,
              action,
            });
            if (allowed) accessible.push(proj.id as number);
          }
          return accessible;
        },
        getPolicies: async (
          reqProjectPublicId: string
        ): Promise<PolicyDocument[]> => {
          // Reject if key is project-scoped and this is a different project
          if (apiKeyProjectId && reqProjectPublicId !== apiKeyProjectId) {
            return [];
          }

          if (apiKeyPolicyIds.length > 0) {
            // Key has explicit policies — use them as the SQL filter scope
            const keyPolicies = await ctx.db.Policy.findAll({
              where: { id: apiKeyPolicyIds },
            });
            return keyPolicies.map(
              (p: InstanceType<(typeof ctx.db)['Policy']>) => {
                return p.document as PolicyDocument;
              }
            );
          }

          // No key policies — inherit user policies
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
    if (projectPublicId) {
      const allowed = await args.jwtIsAllowed({ projectPublicId, action });
      if (!allowed) return null;
      const proj = await args.db.Project.findOne({
        where: { publicId: projectPublicId },
      });
      if (!proj) return null;
      return [proj.id as number];
    }

    if (args.role === 'admin') return undefined;

    // Enumerate accessible projects from policy SRN patterns
    if (args.userPolicyIds.length === 0) return [];

    const policies = await args.db.Policy.findAll({
      where: { id: args.userPolicyIds },
    });
    const policyDocs = policies.map(
      (p: InstanceType<(typeof args.db)['Policy']>) => {
        return p.document as PolicyDocument;
      }
    );
    const projectPublicIds = extractProjectIdsFromPolicies(policyDocs);

    if (!projectPublicIds) {
      // Wildcard patterns — check all projects
      const allProjects = await args.db.Project.findAll();
      const accessible: number[] = [];
      for (const proj of allProjects) {
        const allowed = await args.jwtIsAllowed({
          projectPublicId: proj.publicId as string,
          action,
        });
        if (allowed) accessible.push(proj.id as number);
      }
      return accessible;
    }

    if (projectPublicIds.length === 0) return [];

    const projects = await args.db.Project.findAll({
      where: { publicId: projectPublicIds },
    });
    const accessible: number[] = [];
    for (const proj of projects) {
      const allowed = await args.jwtIsAllowed({
        projectPublicId: proj.publicId as string,
        action,
      });
      if (allowed) accessible.push(proj.id as number);
    }
    return accessible;
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

export const authMiddleware =
  // eslint-disable-next-line max-lines-per-function, complexity
  async (ctx: Context, next: Next) => {
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
