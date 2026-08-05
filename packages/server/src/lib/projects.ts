import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';
import { invalidateReadAuditCache } from './auditLog';
import { type Transaction } from './dbTransaction';
import { deleteStorageObjects } from './fileStorage';
import { assertGuardrailsExist } from './guardrails';
import {
  assertDefaultModelRouteInProject,
  assertProjectDefaultNotInherited,
} from './modelRouteDefaults';
import { paginatedList, resolvePagination } from './pagination';

const log = createDebug('soat:projects');

const mapProject = (project: InstanceType<(typeof db)['Project']>) => {
  return {
    id: project.publicId,
    name: project.name,
    guardrail_ids: project.guardrailIds,
    default_model_route_id: project.defaultModelRouteId,
    max_concurrent_runs: project.maxConcurrentRuns,
    audit_reads_enabled: project.auditReadsEnabled,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
};

/**
 * Validates a `maxConcurrentRuns` value. `null` clears the limit (unlimited);
 * otherwise it must be an integer ≥ 1. Returns an error message, or `null` when
 * valid. Pure — the single source of truth shared by every write path.
 */
export const validateMaxConcurrentRuns = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return 'max_concurrent_runs must be an integer >= 1, or null to clear it.';
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

export const listProjects = async (args: {
  authUser: AuthUser;
  limit?: number;
  offset?: number;
}) => {
  const emptyPage = () => {
    const { limit, offset } = resolvePagination(args);
    return { data: [], total: 0, limit, offset };
  };

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
  if (where === null) return emptyPage();

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
    resource: `soat:${args.id}:*:*`,
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

export const updateProject = async (args: {
  id: string;
  name?: string;
  guardrailIds?: string[] | null;
  defaultModelRouteId?: string | null;
  maxConcurrentRuns?: number | null;
  auditReadsEnabled?: boolean;
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

  if (args.maxConcurrentRuns !== undefined) {
    const error = validateMaxConcurrentRuns(args.maxConcurrentRuns);
    if (error) {
      throw new DomainError('VALIDATION_FAILED', error);
    }
  }

  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) updates.name = args.name;
  if (args.guardrailIds !== undefined) updates.guardrailIds = args.guardrailIds;
  if (args.defaultModelRouteId !== undefined) {
    updates.defaultModelRouteId = args.defaultModelRouteId;
  }
  if (args.maxConcurrentRuns !== undefined) {
    updates.maxConcurrentRuns = args.maxConcurrentRuns;
  }
  if (args.auditReadsEnabled !== undefined) {
    updates.auditReadsEnabled = args.auditReadsEnabled;
  }

  await project.update(updates);

  // The audit middleware caches this flag to keep reads off its queue, so a
  // flip must take effect on the next request rather than after the TTL.
  invalidateReadAuditCache(args.id);

  return mapProject(project);
};

const collectIds = (rows: { id?: number }[]): number[] => {
  return rows.map((row) => {
    return (row as unknown as { id: number }).id;
  });
};

// Counts models whose projectId FK is RESTRICT/NO ACTION, i.e. those that
// would actually block `project.destroy()`, plus UsageEvent as a deliberate
// exception: its FK is `onDelete: 'CASCADE'` like Webhook/ApiKey (which stay
// excluded, since they carry no financial meaning), but UsageEvent is the
// project's billing history. Counting it here forces `force=true` before a
// project with usage history can be deleted, so the cascade can no longer
// happen invisibly (see #834).

const countProjectDependents = async (args: {
  projectId: number;
}): Promise<number> => {
  const { projectId } = args;

  const counts = await Promise.all([
    db.Agent.count({ where: { projectId } }),
    db.AiProvider.count({ where: { projectId } }),
    db.ModelRoute.count({ where: { projectId } }),
    db.Tool.count({ where: { projectId } }),
    db.Actor.count({ where: { projectId } }),
    db.Chat.count({ where: { projectId } }),
    db.Conversation.count({ where: { projectId } }),
    db.Formation.count({ where: { projectId } }),
    db.Memory.count({ where: { projectId } }),
    db.Secret.count({ where: { projectId } }),
    db.Session.count({ where: { projectId } }),
    db.File.count({ where: { projectId } }),
    db.Trace.count({ where: { projectId } }),
    db.Generation.count({ where: { projectId } }),
    db.Orchestration.count({ where: { projectId } }),
    db.OrchestrationRun.count({ where: { projectId } }),
    db.UploadToken.count({ where: { projectId } }),
    db.IngestionRule.count({ where: { projectId } }),
    db.UsageEvent.count({ where: { projectId } }),
  ]);

  return counts.reduce((sum: number, count: number) => {
    return sum + count;
  }, 0);
};

const findProjectDependentIds = async (args: { projectId: number }) => {
  const { projectId } = args;

  const [orchestrationRunRows, generationRows, traceRows, fileRows, agentRows] =
    await Promise.all([
      db.OrchestrationRun.findAll({
        where: { projectId },
        attributes: ['id'],
      }),
      db.Generation.findAll({ where: { projectId }, attributes: ['id'] }),
      db.Trace.findAll({ where: { projectId }, attributes: ['id'] }),
      db.File.findAll({
        where: { projectId },
        attributes: ['id', 'storagePath', 'storageType'],
      }),
      db.Agent.findAll({ where: { projectId }, attributes: ['id'] }),
    ]);

  const fileIds = collectIds(fileRows);

  const documentRows =
    fileIds.length > 0
      ? await db.Document.findAll({
          where: { fileId: fileIds },
          attributes: ['id'],
        })
      : [];

  return {
    orchestrationRunIds: collectIds(orchestrationRunRows),
    generationIds: collectIds(generationRows),
    traceIds: collectIds(traceRows),
    fileIds,
    files: fileRows.map((row) => {
      return {
        storagePath: (row as unknown as { storagePath: string }).storagePath,
        storageType: (row as unknown as { storageType: string }).storageType,
      };
    }),
    documentIds: collectIds(documentRows),
    agentIds: collectIds(agentRows),
  };
};

// Nulls self-referencing RESTRICT FKs before the rows they may point at are
// destroyed, mirroring the deleteAgent force-delete pattern.
const nullifyProjectSelfReferences = async (args: {
  generationIds: number[];
  traceIds: number[];
  transaction: Transaction;
}): Promise<void> => {
  const { generationIds, traceIds, transaction } = args;

  if (generationIds.length > 0) {
    await db.Generation.update(
      { initiatorGenerationId: null },
      { where: { initiatorGenerationId: generationIds }, transaction }
    );
  }
  if (traceIds.length > 0) {
    await db.Trace.update(
      { parentTraceId: null },
      { where: { parentTraceId: traceIds }, transaction }
    );
    await db.Trace.update(
      { rootTraceId: null },
      { where: { rootTraceId: traceIds }, transaction }
    );
  }
};

// Cascades every project-scoped resource inside a single transaction. Models
// with a direct `projectId` FK are destroyed in an order that respects the
// RESTRICT foreign keys between them (e.g. Chat before AiProvider, Actor
// before Chat, IngestionRule before Tool/Agent). Models without a direct
// `projectId` column (FormationOperation/FormationResource, MemoryEntry,
// ConversationMessage, WebhookDelivery, OrchestrationCheckpoint/
// NodeExecution, AgentVersion) are either DB-cascaded from their immediate
// parent or, when the FK is RESTRICT, deleted explicitly by parent id
// (OrchestrationCheckpoint/NodeExecution by orchestrationRunId,
// ConversationMessage by documentId so that project-owned Documents can be
// removed, AgentVersion by agentId).
const forceDeleteProjectWithDependents = async (args: {
  project: InstanceType<typeof db.Project>;
  projectId: number;
}): Promise<void> => {
  const { projectId } = args;

  const {
    orchestrationRunIds,
    generationIds,
    traceIds,
    documentIds,
    agentIds,
    files,
  } = await findProjectDependentIds({ projectId });

  await db.sequelize.transaction(async (transaction) => {
    await nullifyProjectSelfReferences({
      generationIds,
      traceIds,
      transaction,
    });

    if (orchestrationRunIds.length > 0) {
      await db.OrchestrationCheckpoint.destroy({
        where: { orchestrationRunId: orchestrationRunIds },
        transaction,
      });
      await db.OrchestrationNodeExecution.destroy({
        where: { orchestrationRunId: orchestrationRunIds },
        transaction,
      });
    }
    await db.OrchestrationRun.destroy({ where: { projectId }, transaction });
    await db.Orchestration.destroy({ where: { projectId }, transaction });

    // FormationOperation/FormationResource cascade at the DB level.
    await db.Formation.destroy({ where: { projectId }, transaction });

    // Must precede Tool/Agent, which its FKs point to.
    await db.IngestionRule.destroy({ where: { projectId }, transaction });

    await db.Generation.destroy({ where: { projectId }, transaction });
    await db.Trace.destroy({ where: { projectId }, transaction });

    // ConversationMessage.documentId is RESTRICT, so messages referencing a
    // document owned by this project's files must be removed before the
    // document itself; messages tied to this project's own conversations
    // cascade automatically when the conversation is destroyed below.
    if (documentIds.length > 0) {
      await db.ConversationMessage.destroy({
        where: { documentId: documentIds },
        transaction,
      });
    }
    await db.Conversation.destroy({ where: { projectId }, transaction });

    await db.Session.destroy({ where: { projectId }, transaction });
    await db.Actor.destroy({ where: { projectId }, transaction });
    await db.Chat.destroy({ where: { projectId }, transaction });

    // AgentVersion has no projectId of its own and its FK to Agent is RESTRICT,
    // so archived configs are removed by parent agent id before the agents go.
    if (agentIds.length > 0) {
      await db.AgentVersion.destroy({
        where: { agentId: agentIds },
        transaction,
      });
    }
    await db.Agent.destroy({ where: { projectId }, transaction });
    // Must follow Agent, whose modelRouteId FK points at it.
    await db.ModelRoute.destroy({ where: { projectId }, transaction });
    await db.AiProvider.destroy({ where: { projectId }, transaction });
    await db.Tool.destroy({ where: { projectId }, transaction });

    // MemoryEntry cascades at the DB level.
    await db.Memory.destroy({ where: { projectId }, transaction });

    await db.Secret.destroy({ where: { projectId }, transaction });

    if (documentIds.length > 0) {
      await db.Document.destroy({
        where: { id: documentIds },
        transaction,
      });
    }
    await db.File.destroy({ where: { projectId }, transaction });
    await db.UploadToken.destroy({ where: { projectId }, transaction });

    // WebhookDelivery cascades from Webhook at the DB level; Webhook and
    // ApiKey themselves cascade from Project (onDelete: 'CASCADE'), but are
    // destroyed explicitly here for consistency with the rest of the graph.
    await db.Webhook.destroy({ where: { projectId }, transaction });
    await db.ApiKey.destroy({ where: { projectId }, transaction });
    // UsageComponent cascades from UsageEvent at the DB level; force=true is
    // the deliberate opt-in to erase billing history (see #834).
    await db.UsageEvent.destroy({ where: { projectId }, transaction });

    await args.project.destroy({ transaction });
  });

  // Storage cleanup happens after the transaction commits, once the File rows
  // are truly gone — a failed object delete is logged and retryable, never a
  // reason to roll back the DB (see #835).
  await deleteStorageObjects(files);
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
