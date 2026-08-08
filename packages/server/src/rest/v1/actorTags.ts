import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { getActor, getActorTags, updateActorTags } from 'src/lib/actors';
import { buildSrn } from 'src/lib/iam';

import { requireAuth } from './helpers';

const actorTagsRouter = new Router<Context>();

const buildActorTagContext = (actor: {
  tags?: Record<string, unknown> | null;
}): Record<string, string> => {
  const context: Record<string, string> = { 'soat:ResourceType': 'actor' };
  for (const [k, v] of Object.entries(actor.tags!)) {
    context[`soat:ResourceTag/${k}`] = v as string;
  }
  return context;
};

actorTagsRouter.get('/actors/:actor_id/tags', async (ctx: Context) => {
  requireAuth(ctx);

  const actor = await getActor({ id: ctx.params.actor_id });

  const srn = buildSrn({
    projectPublicId: actor.project_id!,
    resourceType: 'actor',
    resourceId: actor.id,
  });
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: actor.project_id!,
    action: 'actors:GetActor',
    resource: srn,
    context: buildActorTagContext(actor),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  ctx.body = await getActorTags({ id: ctx.params.actor_id });
});

actorTagsRouter.put('/actors/:actor_id/tags', async (ctx: Context) => {
  requireAuth(ctx);

  const actor = await getActor({ id: ctx.params.actor_id });

  const srn = buildSrn({
    projectPublicId: actor.project_id!,
    resourceType: 'actor',
    resourceId: actor.id,
  });
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: actor.project_id!,
    action: 'actors:UpdateActor',
    resource: srn,
    context: buildActorTagContext(actor),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const tags = ctx.request.body as Record<string, string>;
  ctx.body = await updateActorTags({
    id: ctx.params.actor_id,
    tags,
    merge: false,
  });
});

actorTagsRouter.patch('/actors/:actor_id/tags', async (ctx: Context) => {
  requireAuth(ctx);

  const actor = await getActor({ id: ctx.params.actor_id });

  const srn = buildSrn({
    projectPublicId: actor.project_id!,
    resourceType: 'actor',
    resourceId: actor.id,
  });
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: actor.project_id!,
    action: 'actors:UpdateActor',
    resource: srn,
    context: buildActorTagContext(actor),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const tags = ctx.request.body as Record<string, string>;
  ctx.body = await updateActorTags({
    id: ctx.params.actor_id,
    tags,
    merge: true,
  });
});

export { actorTagsRouter };
