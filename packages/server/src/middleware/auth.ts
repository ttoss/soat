import { PROJECT_KEY_RAW_PREFIX } from '@soat/postgresdb';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import type { Context } from '../Context';
import type { PolicyDocument } from '../lib/iam';
import {
  createJwtIsAllowed,
  createProjectKeyIsAllowed,
} from '../lib/permissions';

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

  const candidates = await ctx.db.ProjectKey.findAll({
    where: { keyPrefix },
    include: [{ model: ctx.db.Project }, { model: ctx.db.User }],
  });

  for (const row of candidates) {
    const match = await bcrypt.compare(rawKey, row.keyHash as string);
    if (match) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const projectPublicId = (row as any).project?.publicId as string;
      const projectKeyPolicyId = row.policyId as number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const keyUser = (row as any).user;
      // Get user's project memberships
      const project = await ctx.db.Project.findOne({
        where: { publicId: projectPublicId },
      });
      const membership = await ctx.db.UserProject.findOne({
        where: { userId: keyUser.id, projectId: project?.id },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userPolicyIds = ((membership as any)?.policyIds as number[]) ?? [];

      const projectKeyIsAllowed = createProjectKeyIsAllowed({
        projectPublicId,
        userPolicyIds,
        projectKeyPolicyId,
        db: ctx.db,
      });

      ctx.authUser = {
        id: keyUser.id as number,
        publicId: keyUser.publicId as string,
        username: keyUser.username as string,
        role: keyUser.role as 'admin' | 'user',
        projectKeyProjectId: projectPublicId,
        isAllowed: projectKeyIsAllowed,
        resolveProjectIds: async ({ projectPublicId: reqId, action }) => {
          const targetId = reqId ?? projectPublicId;
          const allowed = await projectKeyIsAllowed({
            projectPublicId: targetId,
            action,
          });
          if (!allowed) return null;
          const proj = await ctx.db.Project.findOne({
            where: { publicId: targetId },
          });
          if (!proj) return null;
          return [proj.id as number];
        },
        getPolicies: async (reqProjectPublicId: string) => {
          if (reqProjectPublicId !== projectPublicId) return [];
          const [userPolicies, keyPolicy] = await Promise.all([
            userPolicyIds.length > 0
              ? ctx.db.ProjectPolicy.findAll({
                  where: { id: userPolicyIds },
                })
              : Promise.resolve([]),
            ctx.db.ProjectPolicy.findOne({
              where: { id: projectKeyPolicyId },
            }),
          ]);
          const docs: PolicyDocument[] = [];
          for (const p of userPolicies) {
            docs.push(p.document as PolicyDocument);
          }
          if (keyPolicy) {
            docs.push(keyPolicy.document as PolicyDocument);
          }
          return docs;
        },
      };
      break;
    }
  }
};

const createJwtResolveProjectIds = (args: {
  userId: number;
  role: 'admin' | 'user';
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
    const memberships = await args.db.UserProject.findAll({
      where: { userId: args.userId },
      include: [{ model: args.db.Project }],
    });
    const accessible: number[] = [];
    for (const membership of memberships) {
      const proj = (
        membership as unknown as {
          project: InstanceType<(typeof args.db)['Project']>;
        }
      ).project;
      if (!proj) continue;
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
  userId: number;
  role: 'admin' | 'user';
  db: Context['db'];
}) => {
  return async (reqProjectPublicId: string): Promise<PolicyDocument[]> => {
    if (args.role === 'admin') {
      // Admin has unrestricted access — return a single allow-all policy
      return [
        {
          statement: [{ effect: 'Allow', action: ['*'], resource: ['*'] }],
        },
      ];
    }
    const project = await args.db.Project.findOne({
      where: { publicId: reqProjectPublicId },
    });
    if (!project) return [];
    const membership = await args.db.UserProject.findOne({
      where: { userId: args.userId, projectId: project.id as number },
    });
    if (!membership) return [];
    const policyIds = membership.policyIds as number[];
    if (policyIds.length === 0) return [];
    const policies = await args.db.ProjectPolicy.findAll({
      where: { id: policyIds },
    });
    return policies.map(
      (p: InstanceType<(typeof args.db)['ProjectPolicy']>) => {
        return p.document as PolicyDocument;
      }
    );
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
  const jwtIsAllowed = createJwtIsAllowed({ role, userId, db: ctx.db });

  ctx.authUser = {
    id: userId,
    publicId: user.publicId as string,
    username: user.username as string,
    role,
    isAllowed: jwtIsAllowed,
    resolveProjectIds: createJwtResolveProjectIds({
      userId,
      role,
      db: ctx.db,
      jwtIsAllowed,
    }),
    getPolicies: createJwtGetPolicies({ userId, role, db: ctx.db }),
  };
};

export const authMiddleware = async (ctx: Context, next: Next) => {
  const authHeader: string | undefined = ctx.headers?.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    if (token.startsWith(PROJECT_KEY_RAW_PREFIX)) {
      await resolveProjectKey(ctx, token);
    } else {
      await resolveJwt(ctx, token);
    }
  }

  await next();
};
