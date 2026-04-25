import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createSecret,
  deleteSecret,
  getSecret,
  listSecrets,
  updateSecret,
} from 'src/lib/secrets';

const secretsRouter = new Router<Context>();

secretsRouter.get('/secrets', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'secrets:ListSecrets',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listSecrets({ projectIds: projectIds ?? [] });
});

secretsRouter.get('/secrets/:secretId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const secret = await getSecret({ id: ctx.params.secretId });

  if (!secret) {
    ctx.status = 404;
    ctx.body = { error: 'Secret not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: secret.projectId!,
    action: 'secrets:GetSecret',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = secret;
});

secretsRouter.post('/secrets', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId?: string;
    name?: string;
    value?: string;
  };

  if (!body.name) {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

  let resolvedProjectPublicId = body.projectId;
  if (!resolvedProjectPublicId) {
    if (ctx.authUser.apiKeyProjectId) {
      resolvedProjectPublicId = ctx.authUser.apiKeyProjectId;
    } else {
      ctx.status = 400;
      ctx.body = { error: 'projectId is required' };
      return;
    }
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: resolvedProjectPublicId,
    action: 'secrets:CreateSecret',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const project = await db.Project.findOne({
    where: { publicId: resolvedProjectPublicId },
  });
  if (!project) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid project ID' };
    return;
  }

  const secret = await createSecret({
    projectId: project.id,
    name: body.name,
    value: body.value,
  });

  ctx.status = 201;
  ctx.body = secret;
});

secretsRouter.patch('/secrets/:secretId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const secret = await getSecret({ id: ctx.params.secretId });
  if (!secret) {
    ctx.status = 404;
    ctx.body = { error: 'Secret not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: secret.projectId!,
    action: 'secrets:UpdateSecret',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as { name?: string; value?: string };

  const updated = await updateSecret({
    id: ctx.params.secretId,
    name: body.name,
    value: body.value,
  });

  ctx.body = updated;
});

secretsRouter.delete('/secrets/:secretId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const secret = await getSecret({ id: ctx.params.secretId });
  if (!secret) {
    ctx.status = 404;
    ctx.body = { error: 'Secret not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: secret.projectId!,
    action: 'secrets:DeleteSecret',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const force = ctx.query.force === 'true';
  const result = await deleteSecret({ id: ctx.params.secretId, force });

  if (result === 'conflict') {
    ctx.status = 409;
    ctx.body = {
      error:
        'Secret is referenced by one or more AI providers. Use force=true to delete them as well.',
    };
    return;
  }

  ctx.status = 204;
});

export { secretsRouter };
