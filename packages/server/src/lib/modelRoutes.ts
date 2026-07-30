import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  mapModelRoute,
  type MappedModelRoute,
  MODEL_ROUTE_DEFAULT_RETRY_ON,
  type ModelRouteInstance,
} from './modelRouteMapper';
import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_FAILURE_THRESHOLD,
  type ModelRouteTarget,
  validateModelRouteBreakerConfig,
  validateModelRouteRetryOn,
  validateModelRouteTargets,
} from './modelRouteValidation';
import { paginatedList, type PaginatedResult } from './pagination';

const log = createDebug('soat:model-routes');

// The routing contract lives in dedicated modules; re-exported here so the
// module has a single public surface (consumers, REST handlers, the formation
// module and tests all import from `modelRoutes`).
export {
  type CompletionAttribution,
  meterCompletion,
  resolveCompletionAttribution,
} from './modelRouteAttribution';
export {
  assertDefaultModelRouteInProject,
  assertModelBindingResolvable,
  assertProjectDefaultNotInherited,
  findProjectDefaultInheritors,
  findProjectDefaultModelRouteId,
  resolveConsumerModelRoute,
} from './modelRouteDefaults';
export {
  MODEL_ROUTE_ERROR_CLASSES,
  type ModelRouteErrorClass,
} from './modelRouteErrors';
export {
  isRoutedModel,
  readRoutingMetadata,
  ROUTED_PROVIDER_LABEL,
  routedMaxRetries,
  type RoutingAttempt,
  type RoutingMetadata,
} from './modelRouteExecutor';
export {
  mapModelRoute,
  mapModelRouteConfig,
  type MappedModelRoute,
  MODEL_ROUTE_DEFAULT_RETRY_ON,
  type ModelRouteConfig,
} from './modelRouteMapper';
export {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_TARGET_MAX_RETRIES,
  hasModelBinding,
  MAX_MODEL_ROUTE_ATTEMPTS,
  type ModelRouteTarget,
  modelRouteTotalAttempts,
  validateModelRouteBreakerConfig,
  validateModelRouteExclusivity,
  validateModelRouteRetryOn,
  validateModelRouteTargets,
} from './modelRouteValidation';

const getModelRouteIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

// ── Validation ───────────────────────────────────────────────────────────

const assertValid = (message: string | null): void => {
  if (message) throw new DomainError('VALIDATION_FAILED', message);
};

/**
 * Every target must reference an AI provider in the **route's own project** —
 * mirroring the cross-project guard `resolveCompletionModel` already applies —
 * so a route can never borrow another project's provider secret.
 */
const assertTargetProvidersInProject = async (args: {
  projectId: number;
  targets: ModelRouteTarget[];
}): Promise<void> => {
  const publicIds = [
    ...new Set(
      args.targets.map((target) => {
        return target.ai_provider_id;
      })
    ),
  ];

  const found = await db.AiProvider.findAll({
    where: { publicId: publicIds, projectId: args.projectId },
    attributes: ['publicId'],
  });
  const foundIds = new Set(
    found.map((provider) => {
      return provider.publicId;
    })
  );

  for (const publicId of publicIds) {
    if (!foundIds.has(publicId)) {
      throw new DomainError(
        'AI_PROVIDER_NOT_FOUND',
        `AI provider '${publicId}' not found in this project.`
      );
    }
  }
};

const assertNameAvailable = async (args: {
  projectId: number;
  name: string;
  excludeId?: number;
}): Promise<void> => {
  const existing = await db.ModelRoute.findOne({
    where: { projectId: args.projectId, name: args.name },
    attributes: ['id'],
  });
  if (!existing) return;
  if (
    args.excludeId !== undefined &&
    (existing as unknown as { id: number }).id === args.excludeId
  ) {
    return;
  }
  throw new DomainError(
    'NAME_CONFLICT',
    `A model route named '${args.name}' already exists in this project.`
  );
};

const validateName = (name: unknown): string => {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'name is required and must be a non-empty string.'
    );
  }
  return name;
};

// ── CRUD ─────────────────────────────────────────────────────────────────

const reloadWithIncludes = async (id: number): Promise<MappedModelRoute> => {
  const reloaded = await db.ModelRoute.findOne({
    where: { id },
    include: getModelRouteIncludes(),
  });
  return mapModelRoute(reloaded as Parameters<typeof mapModelRoute>[0]);
};

const findModelRouteInstance = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<ModelRouteInstance> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const route = await db.ModelRoute.findOne({
    where,
    include: getModelRouteIncludes(),
  });

  if (!route) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Model route '${args.id}' not found.`
    );
  }

  return route as ModelRouteInstance;
};

export const createModelRoute = async (args: {
  projectId: number;
  name: unknown;
  targets: unknown;
  retryOn?: unknown;
  failureThreshold?: unknown;
  cooldownSeconds?: unknown;
}): Promise<MappedModelRoute> => {
  const name = validateName(args.name);
  const retryOn = args.retryOn ?? [...MODEL_ROUTE_DEFAULT_RETRY_ON];
  const failureThreshold = args.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const cooldownSeconds = args.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;

  assertValid(validateModelRouteTargets(args.targets));
  assertValid(validateModelRouteRetryOn(retryOn));
  assertValid(
    validateModelRouteBreakerConfig({ failureThreshold, cooldownSeconds })
  );

  const targets = args.targets as ModelRouteTarget[];
  await assertTargetProvidersInProject({ projectId: args.projectId, targets });
  await assertNameAvailable({ projectId: args.projectId, name });

  const route = await db.ModelRoute.create({
    projectId: args.projectId,
    name,
    targets,
    retryOn,
    failureThreshold,
    cooldownSeconds,
  });

  log(
    'createModelRoute: created id=%s targets=%d',
    route.publicId,
    targets.length
  );

  return reloadWithIncludes((route as unknown as { id: number }).id);
};

export const listModelRoutes = async (args: {
  projectIds?: number[];
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedModelRoute>> => {
  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.ModelRoute.findAndCountAll({
        where,
        include: getModelRouteIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (route) => {
      return mapModelRoute(route as Parameters<typeof mapModelRoute>[0]);
    },
  });
};

export const getModelRoute = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedModelRoute> => {
  const route = await findModelRouteInstance(args);
  return mapModelRoute(route as Parameters<typeof mapModelRoute>[0]);
};

export const updateModelRoute = async (args: {
  projectIds?: number[];
  id: string;
  name?: unknown;
  targets?: unknown;
  retryOn?: unknown;
  failureThreshold?: unknown;
  cooldownSeconds?: unknown;
}): Promise<MappedModelRoute> => {
  const route = await findModelRouteInstance({
    projectIds: args.projectIds,
    id: args.id,
  });
  const routeDbId = (route as unknown as { id: number }).id;
  const projectId = (route as unknown as { projectId: number }).projectId;

  const updates: Record<string, unknown> = {};

  if (args.name !== undefined) {
    const name = validateName(args.name);
    await assertNameAvailable({ projectId, name, excludeId: routeDbId });
    updates.name = name;
  }

  if (args.targets !== undefined) {
    assertValid(validateModelRouteTargets(args.targets));
    const targets = args.targets as ModelRouteTarget[];
    await assertTargetProvidersInProject({ projectId, targets });
    updates.targets = targets;
  }

  if (args.retryOn !== undefined) {
    assertValid(validateModelRouteRetryOn(args.retryOn));
    updates.retryOn = args.retryOn;
  }

  if (
    args.failureThreshold !== undefined ||
    args.cooldownSeconds !== undefined
  ) {
    const failureThreshold = args.failureThreshold ?? route.failureThreshold;
    const cooldownSeconds = args.cooldownSeconds ?? route.cooldownSeconds;
    assertValid(
      validateModelRouteBreakerConfig({ failureThreshold, cooldownSeconds })
    );
    updates.failureThreshold = failureThreshold;
    updates.cooldownSeconds = cooldownSeconds;
  }

  await route.update(updates);

  log('updateModelRoute: id=%s fields=%o', args.id, Object.keys(updates));

  return reloadWithIncludes(routeDbId);
};

const MAX_DEPENDENT_SAMPLE = 5;

/**
 * A referenced route cannot be dropped. An agent referencing it has no pinned
 * provider to fall back on (exclusivity), so a dangling reference would break
 * every one of its generations; a project defaulting to it would strand every
 * consumer inheriting the default. Agents reference routes from day one, so this
 * guard ships with them; the project reference was added by the project-default
 * amendment.
 */
const assertNoDependents = async (args: {
  routeDbId: number;
  routePublicId: string;
}): Promise<void> => {
  const [agents, agentCount, projects] = await Promise.all([
    db.Agent.findAll({
      where: { modelRouteId: args.routeDbId },
      attributes: ['publicId'],
      limit: MAX_DEPENDENT_SAMPLE,
    }),
    db.Agent.count({ where: { modelRouteId: args.routeDbId } }),
    db.Project.findAll({
      where: { defaultModelRouteId: args.routePublicId },
      attributes: ['publicId'],
      limit: MAX_DEPENDENT_SAMPLE,
    }),
  ]);

  if (agentCount === 0 && projects.length === 0) return;

  const projectIds = projects.map((project) => {
    return project.publicId;
  });

  throw new DomainError(
    'MODEL_ROUTE_HAS_DEPENDENTS',
    `The model route is referenced by ${agentCount} agent(s) and is the default_model_route_id of ${projectIds.length} project(s); it cannot be deleted.`,
    {
      agents: agentCount,
      projects: projectIds.length,
      sample: [
        ...agents.map((agent) => {
          return agent.publicId;
        }),
        ...projectIds,
      ],
    }
  );
};

export const deleteModelRoute = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<void> => {
  const route = await findModelRouteInstance({
    projectIds: args.projectIds,
    id: args.id,
  });
  await assertNoDependents({
    routeDbId: (route as unknown as { id: number }).id,
    routePublicId: route.publicId,
  });
  await route.destroy();
  log('deleteModelRoute: id=%s', args.id);
};

// ── Resolution ───────────────────────────────────────────────────────────

// The composite-model construction and route lookup used by consumers live in
// `modelRouteResolution`; re-exported so `modelRoutes` stays the module's single
// public surface.
export {
  buildRoutedModel,
  loadModelRouteConfig,
  resolveModelRouteDbId,
} from './modelRouteResolution';
