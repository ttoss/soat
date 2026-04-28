import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { getActor, getActorTags, updateActorTags } from 'src/lib/actors';
import { buildSrn } from 'src/lib/iam';

const actorTagsRouter = new Router<Context>();

const buildActorTagContext = (actor: {
  tags?: Record<string, unknown> | null;
}): Record<string, string> => {
  const context: Record<string, string> = { 'soat:ResourceType': 'actor' };
  if (actor.tags) {
    for (const [k, v] of Object.entries(actor.tags)) {
      context[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  return context;
};

actorTagsRouter.get('/actors/:actor_id/tags', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const actor = await getActor({ id: ctx.params.actor_id });
  if (!actor) {
    ctx.status = 404;
    ctx.body = { error: 'Actor not found' };
    return;
  }

  const srn = buildSrn({
    projectPublicId: actor.projectId!,
    resourceType: 'actor',
    resourceId: actor.id,
  });
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: actor.projectId!,
    action: 'actors:GetActor',
    resource: srn,
    context: buildActorTagContext(actor),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await getActorTags({ id: ctx.params.actor_id });
});

actorTagsRouter.put('/actors/:actor_id/tags', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const actor = await getActor({ id: ctx.params.actor_id });
  if (!actor) {
    ctx.status = 404;
    ctx.body = { error: 'Actor not found' };
    return;
  }

  const srn = buildSrn({
    projectPublicId: actor.projectId!,
    resourceType: 'actor',
    resourceId: actor.id,
  });
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: actor.projectId!,
    action: 'actors:UpdateActor',
    resource: srn,
    context: buildActorTagContext(actor),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const tags = ctx.request.body as Record<string, string>;
  ctx.body = await updateActorTags({
    id: ctx.params.actor_id,
    tags,
    merge: false,
  });
});

actorTagsRouter.patch('/actors/:actor_id/tags', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const actor = await getActor({ id: ctx.params.actor_id });
  if (!actor) {
    ctx.status = 404;
    ctx.body = { error: 'Actor not found' };
    return;
  }

  const srn = buildSrn({
    projectPublicId: actor.projectId!,
    resourceType: 'actor',
    resourceId: actor.id,
  });
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: actor.projectId!,
    action: 'actors:UpdateActor',
    resource: srn,
    context: buildActorTagContext(actor),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const tags = ctx.request.body as Record<string, string>;
  ctx.body = await updateActorTags({
    id: ctx.params.actor_id,
    tags,
    merge: true,
  });
});

export { actorTagsRouter };
