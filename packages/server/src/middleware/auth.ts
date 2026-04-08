import { API_KEY_RAW_PREFIX } from '@soat/postgresdb';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import type { Context } from '../Context';
import { createApiKeyIsAllowed, createJwtIsAllowed } from '../lib/permissions';

// eslint-disable-next-line turbo/no-undeclared-env-vars
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

const resolveApiKey = async (ctx: Context, rawKey: string) => {
  const keyPrefix = rawKey.substring(0, 8);

  const candidates = await ctx.db.ApiKey.findAll({
    where: { keyPrefix },
    include: [
      { model: ctx.db.Project },
      { model: ctx.db.ProjectPolicy },
      { model: ctx.db.User },
    ],
  });

  for (const row of candidates) {
    const match = await bcrypt.compare(rawKey, row.keyHash as string);
    if (match) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const projectPublicId = (row as any).project?.publicId as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const policyData = (row as any).policy;
      const keyPolicy = {
        permissions: policyData.permissions as string[],
        notPermissions: policyData.notPermissions as string[],
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const keyUser = (row as any).user;
      // Get user's project policy
      const project = await ctx.db.Project.findOne({
        where: { publicId: projectPublicId },
      });
      const membership = await ctx.db.UserProject.findOne({
        where: { userId: keyUser.id, projectId: project?.id },
        include: [{ model: ctx.db.ProjectPolicy }],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userPolicyData = (membership as any)?.policy;
      const userPolicy = userPolicyData
        ? {
            permissions: userPolicyData.permissions as string[],
            notPermissions: userPolicyData.notPermissions as string[],
          }
        : { permissions: [], notPermissions: [] };

      ctx.authUser = {
        id: keyUser.id as number,
        publicId: keyUser.publicId as string,
        username: keyUser.username as string,
        role: keyUser.role as 'admin' | 'user',
        isAllowed: createApiKeyIsAllowed({
          projectPublicId,
          userPolicy,
          apiKeyPolicy: keyPolicy,
        }),
      };
      break;
    }
  }
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

  ctx.authUser = {
    id: userId,
    publicId: user.publicId as string,
    username: user.username as string,
    role,
    isAllowed: createJwtIsAllowed({ role, userId, db: ctx.db }),
  };
};

export const authMiddleware = async (ctx: Context, next: Next) => {
  const authHeader: string | undefined = ctx.headers?.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    if (token.startsWith(API_KEY_RAW_PREFIX)) {
      await resolveApiKey(ctx, token);
    } else {
      await resolveJwt(ctx, token);
    }
  }

  await next();
};
