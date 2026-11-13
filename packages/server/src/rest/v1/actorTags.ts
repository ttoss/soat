import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { getActor, getActorTags, updateActorTags } from 'src/lib/actors';
import { buildSrn } from 'src/lib/iam';
import { buildResourceTagContext } from 'src/lib/tags';

import type { AuthenticatedContext } from './helpers';
import { requireAllowed } from './resourceAccess';
import { registerTagRoutes, type TagAccess } from './tagRoutes';

const actorTagsRouter = new Router<Context>();

const resolveActor = async (args: {
  ctx: AuthenticatedContext;
  access: TagAccess;
}) => {
  const actor = await getActor({ id: args.ctx.params.actor_id });

  await requireAllowed({
    ctx: args.ctx,
    check: {
      projectPublicId: actor.project_id!,
      action: args.access === 'read' ? 'actors:GetActor' : 'actors:UpdateActor',
      resource: buildSrn({
        projectPublicId: actor.project_id!,
        resourceType: 'actor',
        resourceId: actor.id,
      }),
      context: buildResourceTagContext({
        resourceType: 'actor',
        tags: actor.tags,
      }),
    },
    notFound: new DomainError(
      'RESOURCE_NOT_FOUND',
      `Actor '${args.ctx.params.actor_id}' not found.`
    ),
  });

  return actor;
};

registerTagRoutes({
  router: actorTagsRouter,
  path: '/actors/:actor_id/tags',
  resolve: resolveActor,
  readTags: ({ resource }) => {
    return getActorTags({ id: resource.id });
  },
  writeTags: ({ resource, tags, merge }) => {
    return updateActorTags({ id: resource.id, tags, merge });
  },
});

export { actorTagsRouter };
