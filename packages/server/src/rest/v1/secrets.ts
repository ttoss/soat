import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  createSecret,
  deleteSecret,
  getSecret,
  listSecrets,
  secrets,
  updateSecret,
} from 'src/lib/secrets';

import {
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';
import { makeItemRouteAuthorizer } from './resourceAccess';

const secretsRouter = new Router<Context>();

/**
 * These routes name the secret's own SRN; the shared preamble adds the
 * tenant-boundary half, so a credential pinned to another project gets its own
 * `API_KEY_PROJECT_SCOPE` with the remedy in the message rather than an opaque
 * `Forbidden`.
 *
 * `refuse` on the read too. Whether a denied read should hide the secret
 * instead — as tools and agents do — is a contract change of its own, not a
 * side effect of sharing a preamble.
 */
const secretAccess = makeItemRouteAuthorizer({
  findScope: secrets.findScope,
  resourceType: 'secret',
  param: 'secret_id',
  label: 'Secret',
});

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
  await secretAccess.authorize({
    ctx,
    action: 'secrets:GetSecret',
    onDenied: 'refuse',
  });

  const secret = await getSecret({ id: ctx.params.secret_id });

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
  await secretAccess.authorizeWrite({ ctx, action: 'secrets:UpdateSecret' });

  const body = ctx.request.body as { name?: string; value?: string };

  const updated = await updateSecret({
    id: ctx.params.secret_id,
    name: body.name,
    value: body.value,
  });

  ctx.body = updated;
});

secretsRouter.delete('/secrets/:secret_id', async (ctx: Context) => {
  await secretAccess.authorizeWrite({ ctx, action: 'secrets:DeleteSecret' });

  const force = ctx.query.force === 'true';
  await deleteSecret({ id: ctx.params.secret_id, force });

  ctx.status = 204;
});

export { secretsRouter };
