import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';

const log = createDebug('soat:projects');

const mapProject = (project: InstanceType<(typeof db)['Project']>) => {
  return {
    id: project.publicId,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
};

const getProjectOrThrow = async (id: string) => {
  const project = await db.Project.findOne({ where: { publicId: id } });

  if (!project) {
    throw new DomainError('RESOURCE_NOT_FOUND', `Project '${id}' not found.`);
  }

  return project;
};

export const listProjects = async (args: { authUser: AuthUser }) => {
  // Admin fast-path: skip when the request uses a project-scoped API key or a
  // project-scoped OAuth token so the restriction is enforced even for admins.
  if (
    args.authUser.role === 'admin' &&
    !args.authUser.apiKeyProjectPublicId &&
    !args.authUser.oauthProjectPublicId
  ) {
    const projects = await db.Project.findAll();
    return projects.map(mapProject);
  }

  const projectIds = await args.authUser.resolveProjectIds({
    action: 'projects:ListProjects',
  });

  if (projectIds === null) return [];

  if (projectIds === undefined) {
    const projects = await db.Project.findAll();
    return projects.map(mapProject);
  }

  if (projectIds.length === 0) return [];

  const projects = await db.Project.findAll({ where: { id: projectIds } });
  return projects.map(mapProject);
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

export const updateProject = async (args: { id: string; name: string }) => {
  log('updateProject: id=%s name=%s', args.id, args.name);

  const project = await getProjectOrThrow(args.id);

  await project.update({ name: args.name });

  return mapProject(project);
};

const collectIds = (rows: { id?: number }[]): number[] => {
  return rows.map((row) => {
    return (row as unknown as { id: number }).id;
  });
};

// Only counts models whose projectId FK is RESTRICT/NO ACTION, i.e. those
// that would actually block `project.destroy()`. Webhook and ApiKey have
// `onDelete: 'CASCADE'` straight to Project, so they never block deletion
// and are intentionally excluded here (they're still cleaned up, by the DB
// itself, whether or not force is used).
const countProjectDependents = async (args: {
  projectId: number;
}): Promise<number> => {
  const { projectId } = args;

  const counts = await Promise.all([
    db.Agent.count({ where: { projectId } }),
    db.AiProvider.count({ where: { projectId } }),
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
  ]);

  return counts.reduce((sum: number, count: number) => {
    return sum + count;
  }, 0);
};

const findProjectDependentIds = async (args: { projectId: number }) => {
  const { projectId } = args;

  const [orchestrationRunRows, generationRows, traceRows, fileRows] =
    await Promise.all([
      db.OrchestrationRun.findAll({
        where: { projectId },
        attributes: ['id'],
      }),
      db.Generation.findAll({ where: { projectId }, attributes: ['id'] }),
      db.Trace.findAll({ where: { projectId }, attributes: ['id'] }),
      db.File.findAll({ where: { projectId }, attributes: ['id'] }),
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
    documentIds: collectIds(documentRows),
  };
};

// Cascades every project-scoped resource inside a single transaction. Models
// with a direct `projectId` FK are destroyed in an order that respects the
// RESTRICT foreign keys between them (e.g. Chat before AiProvider, Actor
// before Chat, IngestionRule before Tool/Agent). Models without a direct
// `projectId` column (FormationOperation/FormationResource, MemoryEntry,
// ConversationMessage, WebhookDelivery, OrchestrationCheckpoint/
// NodeExecution) are either DB-cascaded from their immediate parent or, when
// the FK is RESTRICT, deleted explicitly by parent id (OrchestrationCheckpoint
// /NodeExecution by runId, ConversationMessage by documentId so that
// project-owned Documents can be removed).
const forceDeleteProjectWithDependents = async (args: {
  project: InstanceType<typeof db.Project>;
  projectId: number;
}): Promise<void> => {
  const { projectId } = args;

  const { orchestrationRunIds, generationIds, traceIds, documentIds } =
    await findProjectDependentIds({ projectId });

  await db.sequelize.transaction(async (transaction) => {
    // Null self-referencing FKs (RESTRICT) before destroying the rows they
    // may point at, mirroring the deleteAgent force-delete pattern.
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

    if (orchestrationRunIds.length > 0) {
      await db.OrchestrationCheckpoint.destroy({
        where: { runId: orchestrationRunIds },
        transaction,
      });
      await db.OrchestrationNodeExecution.destroy({
        where: { runId: orchestrationRunIds },
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

    await db.Agent.destroy({ where: { projectId }, transaction });
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

    await args.project.destroy({ transaction });
  });
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
