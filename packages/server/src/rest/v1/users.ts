import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  attachUserPolicies,
  createFirstAdminUser,
  createUser,
  deleteUser,
  getUser,
  getUserPolicies,
  listUsers,
  loginUser,
} from 'src/lib/users';

const usersRouter = new Router<Context>();

usersRouter.get('/users', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listUsers();
});

usersRouter.get('/users/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const user = await getUser({ id: ctx.params.id });

  if (!user) {
    ctx.status = 404;
    ctx.body = { error: 'User not found' };
    return;
  }

  ctx.body = user;
});

usersRouter.post('/users', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

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
    ctx.status = 409;
    ctx.body = { error: 'Users already exist' };
    return;
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
    ctx.status = 401;
    ctx.body = { error: 'Invalid credentials' };
    return;
  }

  ctx.body = result;
});

usersRouter.delete('/users/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const deleted = await deleteUser({ id: ctx.params.id });

  if (!deleted) {
    ctx.status = 404;
    ctx.body = { error: 'User not found' };
    return;
  }

  ctx.status = 204;
});

usersRouter.put('/users/:user_id/policies', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const { policyIds } = ctx.request.body as { policyIds: string[] };

  if (!Array.isArray(policyIds)) {
    ctx.status = 400;
    ctx.body = { error: 'policyIds must be an array' };
    return;
  }

  const result = await attachUserPolicies({
    userId: ctx.params.user_id,
    policyIds,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'User or policy not found' };
    return;
  }

  ctx.status = 204;
});

usersRouter.get('/users/:user_id/policies', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const policies = await getUserPolicies({ userId: ctx.params.user_id });

  if (policies === null) {
    ctx.status = 404;
    ctx.body = { error: 'User not found' };
    return;
  }

  ctx.body = policies;
});

export { usersRouter };
