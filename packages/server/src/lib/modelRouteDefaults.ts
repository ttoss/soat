import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { ModelRouteConfig } from './modelRouteMapper';
import { loadModelRouteConfig } from './modelRouteResolution';
import { hasModelBinding } from './modelRouteValidation';

const log = createDebug('soat:model-routes');

/**
 * The project's inherited route, as its public id. `null` means the project has
 * no default, so every consumer in it must bind explicitly.
 */
export const findProjectDefaultModelRouteId = async (args: {
  projectId: number;
}): Promise<string | null> => {
  const project = await db.Project.findOne({
    where: { id: args.projectId },
    attributes: ['defaultModelRouteId'],
  });
  return project?.defaultModelRouteId ?? null;
};

/**
 * The route a consumer resolves through, following the chain
 * *consumer route → consumer pin → project default*. `null` means the consumer
 * pins a provider and resolves as it always has.
 *
 * `aiProviderId` short-circuits the chain: an explicit pin always wins, so a
 * project-wide default can never override a deliberate binding.
 */
export const resolveConsumerModelRoute = async (args: {
  projectId: number;
  modelRouteId?: string | null;
  aiProviderId?: string | null;
}): Promise<ModelRouteConfig | null> => {
  if (hasModelBinding(args.aiProviderId)) return null;

  const routeId = hasModelBinding(args.modelRouteId)
    ? (args.modelRouteId as string)
    : await findProjectDefaultModelRouteId({ projectId: args.projectId });

  if (!routeId) return null;

  log(
    'resolveConsumerModelRoute: projectId=%d routeId=%s inherited=%s',
    args.projectId,
    routeId,
    !hasModelBinding(args.modelRouteId)
  );

  return loadModelRouteConfig({ modelRouteId: routeId });
};

/**
 * First write-time guard of the project-default amendment: a consumer that binds
 * neither a provider nor a route is only representable while its project has a
 * default to inherit. Without this, relaxing "exactly one binding" to "at most
 * one" would turn a missing model into a runtime failure.
 */
export const assertModelBindingResolvable = async (args: {
  projectId: number;
  aiProviderId: unknown;
  modelRouteId: unknown;
  /** Consumer name used in the message, e.g. `agent`. */
  resourceLabel: string;
}): Promise<void> => {
  if (
    hasModelBinding(args.aiProviderId) ||
    hasModelBinding(args.modelRouteId)
  ) {
    return;
  }

  const defaultRouteId = await findProjectDefaultModelRouteId({
    projectId: args.projectId,
  });
  if (defaultRouteId) return;

  throw new DomainError(
    'VALIDATION_FAILED',
    `This ${args.resourceLabel} binds neither ai_provider_id nor model_route_id, and its project has no default_model_route_id to inherit; set one of them.`
  );
};

const MAX_INHERITOR_SAMPLE = 5;

/**
 * Consumers in the project that resolve their model through the project default
 * — i.e. that bind neither a provider nor a route. Chats have no
 * `model_route_id` column (the amendment routes them through the default
 * instead), so for them "binds nothing" is simply a null `aiProviderId`.
 */
export const findProjectDefaultInheritors = async (args: {
  projectId: number;
}): Promise<{ total: number; sample: string[] }> => {
  const { projectId } = args;

  const [agents, chats] = await Promise.all([
    db.Agent.findAll({
      where: { projectId, aiProviderId: null, modelRouteId: null },
      attributes: ['publicId'],
    }),
    db.Chat.findAll({
      where: { projectId, aiProviderId: null },
      attributes: ['publicId'],
    }),
  ]);

  const publicIds = [...agents, ...chats].map((row) => {
    return row.publicId;
  });

  return {
    total: publicIds.length,
    sample: publicIds.slice(0, MAX_INHERITOR_SAMPLE),
  };
};

/**
 * Second write-time guard: clearing a project's default while consumers inherit
 * it would leave them with no resolvable model. *Repointing* the default from
 * one route to another stays free — that is the switch the feature exists for.
 */
export const assertProjectDefaultNotInherited = async (args: {
  projectId: number;
  projectPublicId: string;
}): Promise<void> => {
  const { total, sample } = await findProjectDefaultInheritors({
    projectId: args.projectId,
  });
  if (total === 0) return;

  throw new DomainError(
    'PROJECT_DEFAULT_ROUTE_INHERITED',
    `default_model_route_id cannot be cleared: ${total} consumer(s) in project '${args.projectPublicId}' inherit it. Bind them explicitly first, or repoint the default to another route.`,
    { inheritors: total, sample }
  );
};

/**
 * Validates a `default_model_route_id` write. `null` clears it; otherwise the
 * route must belong to the project, mirroring the same-project guard on route
 * targets so a project cannot default to another project's route.
 */
export const assertDefaultModelRouteInProject = async (args: {
  projectId: number;
  defaultModelRouteId: string;
}): Promise<void> => {
  const route = await db.ModelRoute.findOne({
    where: { publicId: args.defaultModelRouteId, projectId: args.projectId },
    attributes: ['id'],
  });
  if (!route) {
    throw new DomainError(
      'MODEL_ROUTE_NOT_FOUND',
      `Model route '${args.defaultModelRouteId}' not found in this project.`
    );
  }
};
