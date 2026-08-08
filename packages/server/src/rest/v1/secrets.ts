import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import {
  createSecret,
  deleteSecret,
  getSecret,
  listSecrets,
  updateSecret,
} from 'src/lib/secrets';

import {
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';

const secretsRouter = new Router<Context>();

secretsRouter.get('/secrets', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'secrets:ListSecrets',
    resourceType: 'secret',
  });

  ctx.body = await listSecrets({
    projectIds: projectIds ?? [],
    ...parsePagination(ctx),
  });
});

secretsRouter.get('/secrets/:secret_id', async (ctx: Context) => {
  requireAuth(ctx);

  const secret = await getSecret({ id: ctx.params.secret_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: secret.project_id!,
    action: 'secrets:GetSecret',
    resource: buildSrn({
      projectPublicId: secret.project_id!,
      resourceType: 'secret',
      resourceId: secret.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  ctx.body = secret;
});

secretsRouter.post('/secrets', async (ctx: Context) => {
  requireAuth(ctx);
  // `name` and `value` are guaranteed present by the strict-field middleware
  // (both are `required` in the OpenAPI request schema).
  const body = ctx.request.body as {
    project_id?: string;
    name: string;
    value: string;
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'secrets:CreateSecret',
    resourceType: 'secret',
  });
  const secret = await createSecret({
    projectId: Number(targetProjectId),
    name: body.name,
    value: body.value,
  });

  ctx.status = 201;
  ctx.body = secret;
});

secretsRouter.patch('/secrets/:secret_id', async (ctx: Context) => {
  requireAuth(ctx);

  const secret = await getSecret({ id: ctx.params.secret_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: secret.project_id!,
    action: 'secrets:UpdateSecret',
    resource: buildSrn({
      projectPublicId: secret.project_id!,
      resourceType: 'secret',
      resourceId: secret.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const body = ctx.request.body as { name?: string; value?: string };

  const updated = await updateSecret({
    id: ctx.params.secret_id,
    name: body.name,
    value: body.value,
  });

  ctx.body = updated;
});

secretsRouter.delete('/secrets/:secret_id', async (ctx: Context) => {
  requireAuth(ctx);

  const secret = await getSecret({ id: ctx.params.secret_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: secret.project_id!,
    action: 'secrets:DeleteSecret',
    resource: buildSrn({
      projectPublicId: secret.project_id!,
      resourceType: 'secret',
      resourceId: secret.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const force = ctx.query.force === 'true';
  await deleteSecret({ id: ctx.params.secret_id, force });

  ctx.status = 204;
});

export { secretsRouter };
