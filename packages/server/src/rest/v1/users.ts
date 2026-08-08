import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  attachUserPolicies,
  createFirstAdminUser,
  createUser,
  deleteUser,
  getUser,
  listUsers,
  loginUser,
} from 'src/lib/users';

import { parsePagination, requireAdmin, requireAuth } from './helpers';

const usersRouter = new Router<Context>();

usersRouter.get('/users/me', async (ctx: Context) => {
  requireAuth(ctx);

  ctx.body = {
    id: ctx.authUser.publicId,
    username: ctx.authUser.username,
    role: ctx.authUser.role,
  };
});

usersRouter.get('/users', async (ctx: Context) => {
  requireAdmin(ctx, 'users:ListUsers');
  ctx.body = await listUsers(parsePagination(ctx));
});

usersRouter.get('/users/:user_id', async (ctx: Context) => {
  requireAdmin(ctx, 'users:GetUser');
  const user = await getUser({ id: ctx.params.user_id });

  if (!user) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'User not found');
  }

  ctx.body = user;
});

usersRouter.post('/users', async (ctx: Context) => {
  requireAdmin(ctx, 'users:CreateUser');
  const body = ctx.request.body as {
    username: string;
    password: string;
    role?: 'admin' | 'user';
  };

  const user = await createUser(body);
  ctx.status = 201;
  ctx.body = user;
});

usersRouter.post('/users/bootstrap', async (ctx: Context) => {
  const body = ctx.request.body as {
    username: string;
    password: string;
  };

  const user = await createFirstAdminUser(body);

  if (!user) {
    throw new DomainError('BOOTSTRAP_ALREADY_COMPLETED', 'Users already exist');
  }

  ctx.status = 201;
  ctx.body = user;
});

usersRouter.post('/users/login', async (ctx: Context) => {
  const { username, password } = ctx.request.body as {
    username: string;
    password: string;
  };

  const result = await loginUser({ username, password });

  if (!result) {
    throw new DomainError('UNAUTHORIZED', 'Invalid credentials');
  }

  ctx.body = result;
});

usersRouter.delete('/users/:user_id', async (ctx: Context) => {
  requireAdmin(ctx, 'users:DeleteUser');
  const deleted = await deleteUser({ id: ctx.params.user_id });

  if (!deleted) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'User not found');
  }

  ctx.status = 204;
});

usersRouter.put('/users/:user_id/policies', async (ctx: Context) => {
  requireAdmin(ctx, 'users:AttachUserPolicies');
  const { policy_ids: policyIds } = ctx.request.body as {
    policy_ids: string[];
  };

  if (!Array.isArray(policyIds)) {
    throw new DomainError('VALIDATION_FAILED', 'policy_ids must be an array');
  }

  await attachUserPolicies({
    userId: ctx.params.user_id,
    policyIds,
  });

  ctx.status = 204;
});

export { usersRouter };
