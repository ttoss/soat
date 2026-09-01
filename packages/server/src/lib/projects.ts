import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';
import { invalidateReadAuditCache } from './auditLog';
import { assertGuardrailsExist } from './guardrails';
import {
  assertDefaultModelRouteInProject,
  assertProjectDefaultNotInherited,
} from './modelRouteDefaults';
import { emptyPage, paginatedList } from './pagination';
import {
  countProjectDependents,
  forceDeleteProjectWithDependents,
} from './projectDependents';
import {
  clearTraceContentModeCache,
  validateTraceContentMode,
  validateTraceContentRetentionDays,
} from './traceContentPolicy';

const log = createDebug('soat:projects');

const mapProject = (project: InstanceType<(typeof db)['Project']>) => {
  return {
    id: project.publicId,
    name: project.name,
    guardrail_ids: project.guardrailIds,
    default_model_route_id: project.defaultModelRouteId,
    max_concurrent_runs: project.maxConcurrentRuns,
    max_chain_generations: project.maxChainGenerations,
    audit_reads_enabled: project.auditReadsEnabled,
    trace_content_retention_days: project.traceContentRetentionDays,
    trace_content_mode: project.traceContentMode,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
};

/**
 * Validates a `maxConcurrentRuns` value. `null` clears the limit (unlimited);
 * otherwise it must be an integer ≥ 1. Returns an error message, or `null` when
 * valid. Pure — the single source of truth shared by every write path.
 */
const validateMaxConcurrentRuns = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return 'max_concurrent_runs must be an integer >= 1, or null to clear it.';
  }
  return null;
};

/**
 * Validates a `maxChainGenerations` value. `null` clears the project's ceiling
 * (the deployment-wide one still applies); otherwise it must be an integer ≥ 1.
 * Returns an error message, or `null` when valid.
 */
const validateMaxChainGenerations = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return 'max_chain_generations must be an integer >= 1, or null to clear it.';
  }
  return null;
};

const getProjectOrThrow = async (id: string) => {
  const project = await db.Project.findOne({ where: { publicId: id } });

  if (!project) {
    throw new DomainError('RESOURCE_NOT_FOUND', `Project '${id}' not found.`);
  }

  return project;
};

/**
 * The public id of a project held by its internal row id.
 *
 * The one direction the rest of the codebase never needs — everything else
 * resolves the other way, from the id a caller sent. A formation apply is the
 * exception: it carries the internal id through the pipeline, and an
 * operator-registered resource type has to name the project to its handler in
 * the id that handler's own callers use (`.claude/rules/server.md` — the
 * internal id must never leave the process).
 */
export const findProjectPublicId = async (args: {
  id: number;
}): Promise<string> => {
  const project = await db.Project.findOne({
    where: { id: args.id },
    attributes: ['publicId'],
  });
  if (!project) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Project '${args.id}' not found.`
    );
  }
  return project.publicId;
};

export const listProjects = async (args: {
  authUser: AuthUser;
  limit?: number;
  offset?: number;
}) => {
  const listWhere = async (): Promise<
    Record<string, unknown> | undefined | null
  > => {
    // Admin fast-path: skip when the request uses a project-scoped API key or a
    // project-scoped OAuth token so the restriction is enforced even for admins.
    if (
      args.authUser.role === 'admin' &&
      !args.authUser.apiKeyProjectPublicId &&
      !args.authUser.oauthProjectPublicId
    ) {
      return undefined;
    }

    const projectIds = await args.authUser.resolveProjectIds({
      action: 'projects:ListProjects',
    });

    if (projectIds === null) return null;
    if (projectIds === undefined) return undefined;
    if (projectIds.length === 0) return null;
    return { id: projectIds };
  };

  const where = await listWhere();
  if (where === null) return emptyPage(args);

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Project.findAndCountAll({ where, limit, offset });
    },
    map: mapProject,
  });
};

export const getProject = async (args: { id: string; authUser: AuthUser }) => {
  const project = await db.Project.findOne({ where: { publicId: args.id } });

  if (!project) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Project '${args.id}' not found.`
    );
  }

  if (args.authUser.role === 'admin' && !args.authUser.oauthProjectPublicId) {
    return mapProject(project);
  }

  const allowed = await args.authUser.isAllowed({
    projectPublicId: args.id,
    action: 'projects:GetProject',
    // Probe with the project's SRN (consistent with listProjects /
    // resolveProjectIds) so project-scoped policies grant access, not just
    // unscoped `*` policies.
    resource: `srn:${args.id}:*:*`,
  });

  if (!allowed) {
    throw new DomainError(
      'FORBIDDEN',
      `You do not have permission to access project '${args.id}'.`
    );
  }

  return mapProject(project);
};

export const createProject = async (args: { name: string }) => {
  const project = await db.Project.create({ name: args.name });
  return mapProject(project);
};

/**
 * Validates a `default_model_route_id` write. Setting it requires a route in the
 * same project; clearing it is refused while consumers inherit it — the two
 * write-time guards that keep "this consumer has no model at all"
 * unrepresentable once a consumer may bind neither field.
 *
 * Repointing from one route to another is deliberately unguarded: that is the
 * project-wide switch the feature exists for.
 */
const assertDefaultModelRouteWritable = async (args: {
  projectId: number;
  projectPublicId: string;
  defaultModelRouteId: string | null;
}): Promise<void> => {
  if (args.defaultModelRouteId === null) {
    await assertProjectDefaultNotInherited({
      projectId: args.projectId,
      projectPublicId: args.projectPublicId,
    });
    return;
  }

  await assertDefaultModelRouteInProject({
    projectId: args.projectId,
    defaultModelRouteId: args.defaultModelRouteId,
  });
};

/** Every column a project update may set. Listed once so "provided means
 * write it, absent means leave it" is one rule rather than one branch per
 * field. */
const PROJECT_UPDATABLE_FIELDS = [
  'name',
  'guardrailIds',
  'defaultModelRouteId',
  'maxConcurrentRuns',
  'maxChainGenerations',
  'auditReadsEnabled',
  'traceContentRetentionDays',
  'traceContentMode',
] as const;

type ProjectUpdatableField = (typeof PROJECT_UPDATABLE_FIELDS)[number];

type ProjectUpdateFields = Partial<Record<ProjectUpdatableField, unknown>>;

const buildProjectUpdates = (
  args: ProjectUpdateFields
): Record<string, unknown> => {
  const updates: Record<string, unknown> = {};
  for (const field of PROJECT_UPDATABLE_FIELDS) {
    if (args[field] !== undefined) updates[field] = args[field];
  }
  return updates;
};

/** Pure per-field validators, applied only to the fields a write provides. */
const PROJECT_SCALAR_VALIDATORS: Partial<
  Record<ProjectUpdatableField, (value: unknown) => string | null>
> = {
  maxConcurrentRuns: validateMaxConcurrentRuns,
  maxChainGenerations: validateMaxChainGenerations,
  traceContentRetentionDays: validateTraceContentRetentionDays,
  traceContentMode: validateTraceContentMode,
};

const assertProjectScalarsValid = (args: ProjectUpdateFields): void => {
  for (const [field, validate] of Object.entries(PROJECT_SCALAR_VALIDATORS)) {
    const value = args[field as ProjectUpdatableField];
    if (value === undefined) continue;
    const error = validate(value);
    if (error) throw new DomainError('VALIDATION_FAILED', error);
  }
};

export const updateProject = async (args: {
  id: string;
  name?: string;
  guardrailIds?: string[] | null;
  defaultModelRouteId?: string | null;
  maxConcurrentRuns?: number | null;
  maxChainGenerations?: number | null;
  auditReadsEnabled?: boolean;
  traceContentRetentionDays?: number | null;
  traceContentMode?: string;
}) => {
  log('updateProject: id=%s name=%s', args.id, args.name);

  const project = await getProjectOrThrow(args.id);

  if (args.guardrailIds !== undefined) {
    await assertGuardrailsExist({
      guardrailIds: args.guardrailIds,
      projectId: (project as unknown as { id: number }).id,
    });
  }

  if (args.defaultModelRouteId !== undefined) {
    await assertDefaultModelRouteWritable({
      projectId: (project as unknown as { id: number }).id,
      projectPublicId: args.id,
      defaultModelRouteId: args.defaultModelRouteId,
    });
  }

  assertProjectScalarsValid(args);

  await project.update(buildProjectUpdates(args));

  // The audit middleware caches this flag to keep reads off its queue, so a
  // flip must take effect on the next request rather than after the TTL.
  invalidateReadAuditCache(args.id);

  // The cache is keyed by agent and a project flip changes every agent's
  // effective mode, so there is no narrower key to drop — and `none` must stop
  // content writes on the next generation, not 30 seconds later.
  if (args.traceContentMode !== undefined) {
    clearTraceContentModeCache();
  }

  return mapProject(project);
};

export const deleteProject = async (args: {
  id: string;
  force?: boolean;
}): Promise<void> => {
  log('deleteProject: id=%s force=%s', args.id, Boolean(args.force));

  const project = await db.Project.findOne({ where: { publicId: args.id } });

  if (!project) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Project '${args.id}' not found.`
    );
  }

  const projectId = (project as unknown as { id: number }).id;

  const dependentCount = await countProjectDependents({ projectId });

  if (dependentCount > 0) {
    if (!args.force) {
      throw new DomainError(
        'PROJECT_HAS_DEPENDENTS',
        `Project '${args.id}' has dependent resources and cannot be deleted.`
      );
    }

    log(
      'deleteProject: force-cascading id=%s dependents=%d',
      args.id,
      dependentCount
    );

    await forceDeleteProjectWithDependents({ project, projectId });
  } else {
    await project.destroy();
  }
};
