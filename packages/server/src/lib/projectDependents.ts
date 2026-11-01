/**
 * What a project owns, and how it is taken apart.
 *
 * `deleteProject` (in `projects.ts`) needs two answers: does anything still
 * reference this project, and — under `force=true` — in what order do those rows
 * come off. Both live here, as lists of model names rather than as one
 * hand-written `count`/`destroy` line per model, because the hand-written form
 * is what silently omitted eight models and answered `500` for any project
 * holding one.
 */

import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { type Transaction } from './dbTransaction';
import { deleteStorageObjects } from './fileStorage';

const log = createDebug('soat:projects');

type RowFilter = Record<string | symbol, unknown>;

const collectIds = (rows: { id?: number }[]): number[] => {
  return rows.map((row) => {
    return (row as unknown as { id: number }).id;
  });
};

/**
 * Every model the force delete destroys by `projectId`, children first: each
 * entry runs only once the rows whose RESTRICT / NO ACTION foreign keys point
 * at it are gone.
 *
 * The single source of truth for the cascade — every counted model draws from
 * it, and `lib/projectDependentsContract.test.ts` checks both lists against the
 * live schema. A project-scoped table missing from both lists makes every
 * delete of a project holding one answer `500`.
 *
 * A model reached only through its parent is absent because the DB cascades it;
 * the few whose parent FK is RESTRICT are destroyed by parent id in
 * `PROJECT_CASCADE_PRE_STEPS`.
 */
export const PROJECT_CASCADE_ORDER = [
  // Records of things that happened, and the queues that produced them: they
  // reference the resources below and nothing references them.
  'ApprovalItem',
  'ExceptionItem',
  'ActivityEntry',
  'GuardrailEvaluation',
  // A chain references nothing (its agent and root generation are plain ids,
  // deliberately not foreign keys) and nothing references it.
  'GenerationChain',
  // A decision names its decider and generation by public id, not by key.
  'Decision',

  // Automation — a firing belongs to a trigger, a task to a workflow.
  'TriggerFiring',
  'Trigger',
  'Task',
  'Workflow',
  // A case's RESTRICT playbookId FK points at its playbook; entries and
  // versions cascade at the DB level.
  'PlaybookCase',
  'Playbook',

  // Evaluations — Eval carries the runs (and their results) that hang off it,
  // Dataset the items; both cascade at the DB level.
  'Eval',
  'Dataset',

  'Quota',
  'Guardrail',

  'OrchestrationRun',
  'Orchestration',

  // FormationOperation/FormationResource cascade at the DB level.
  'Formation',

  'IngestionRule',

  // Declarations govern writes, so nothing points at them.
  'MetadataSchema',

  'Generation',
  'Trace',

  'Conversation',
  'Session',
  'Actor',
  'Chat',

  // Must precede Agent, which its RESTRICT agentId FK points at.
  'Decider',
  'Agent',
  // Must follow Agent, whose modelRouteId FK points at it.
  'ModelRoute',
  // Prices belong to a provider (and cascade from it); destroyed before it so
  // the order reads child-first either way.
  'PriceBook',
  'AiProvider',
  'Tool',

  // Memory cascades at the DB level.
  'MemoryStore',

  // This project's acceptances of other projects' shares; the acceptances of
  // its own shares cascade from Share at the DB level.
  'ShareAcceptance',
  'Share',

  'Secret',
  'File',
  'UploadToken',

  // WebhookDelivery cascades from Webhook at the DB level; Webhook and ApiKey
  // themselves cascade from Project (onDelete: 'CASCADE'), but are destroyed
  // explicitly here for consistency with the rest of the graph.
  'Webhook',
  'ApiKey',

  // UsageComponent cascades from UsageEvent at the DB level; force=true is the
  // deliberate opt-in to erase billing history.
  'UsageThreshold',
  'UsageEvent',
] as const satisfies readonly (keyof typeof db)[];

type ProjectScopedModelName = (typeof PROJECT_CASCADE_ORDER)[number];

/**
 * The models `deleteProject` counts before it decides between `409
 * PROJECT_HAS_DEPENDENTS` and a bare `project.destroy()`: every one whose
 * `projectId` FK is RESTRICT/NO ACTION, i.e. those that would actually block
 * the destroy, plus UsageEvent as a deliberate exception. UsageEvent's FK is
 * `onDelete: 'CASCADE'` like Webhook/ApiKey (which stay excluded, since they
 * carry no financial meaning), but a priced event is billing history: counting
 * it forces `force=true` before the cascade can erase spend.
 *
 * AuditEntry is absent for the opposite reason — its `projectId` is nullable
 * and `ON DELETE SET NULL`, so the audit trail deliberately outlives the
 * project rather than blocking or following its deletion.
 */
export const PROJECT_COUNTED_MODELS = [
  'ActivityEntry',
  'Actor',
  'Agent',
  'AiProvider',
  'ApprovalItem',
  'Chat',
  'Conversation',
  'Dataset',
  'Decider',
  'Decision',
  'Eval',
  'ExceptionItem',
  'File',
  'Formation',
  'Generation',
  'GenerationChain',
  'Guardrail',
  'GuardrailEvaluation',
  'IngestionRule',
  'MemoryStore',
  'MetadataSchema',
  'ModelRoute',
  'Orchestration',
  'OrchestrationRun',
  'Playbook',
  'PlaybookCase',
  'Quota',
  'Secret',
  'Session',
  'Share',
  'Tool',
  'Trace',
  'UploadToken',
  'UsageEvent',
] as const satisfies readonly ProjectScopedModelName[];

type ProjectCountedModelName = (typeof PROJECT_COUNTED_MODELS)[number];

/**
 * The rows of a counted model that are not dependents: the count skips them and
 * a plain delete removes them with the project. A deleted-but-kept formation is
 * history; a usage event carrying no cost holds no spend to protect.
 */
export const PROJECT_NON_DEPENDENT_ROWS: Partial<
  Record<ProjectCountedModelName, RowFilter>
> = {
  Formation: { status: 'deleted' },
  UsageEvent: {
    [Op.or]: [{ costUsd: null }, { costUsd: { [Op.lte]: 0 } }],
  },
};

/**
 * The models with no `projectId` of their own that the cascade removes by
 * parent id, because their FK to that parent is RESTRICT/NO ACTION rather than
 * a DB cascade. Exported alongside the order so the schema contract test can
 * tell "handled" from "forgotten".
 */
export const PROJECT_PARENT_SCOPED_MODELS = [
  'OrchestrationCheckpoint',
  'OrchestrationNodeExecution',
  'OrchestrationRunTask',
  'ConversationMessage',
  'AgentVersion',
  'DocumentVersion',
  'Document',
] as const satisfies readonly (keyof typeof db)[];

/**
 * The slice of a model's interface the cascade uses. Declaring it here lets
 * `PROJECT_CASCADE_ORDER` drive both the count and the destroy through a plain
 * `db[name]` lookup, instead of one hand-written line per model — the shape
 * that let eight models go missing from both.
 */
type ProjectScopedModel = {
  count: (options: { where: RowFilter }) => Promise<number>;
  destroy: (options: {
    where: RowFilter;
    transaction?: Transaction;
  }) => Promise<number>;
};

const projectScopedModel = (
  name: ProjectScopedModelName
): ProjectScopedModel => {
  return db[name];
};

export const countProjectDependents = async (args: {
  projectId: number;
}): Promise<number> => {
  const { projectId } = args;

  const counts = await Promise.all(
    PROJECT_COUNTED_MODELS.map((name) => {
      const nonDependent = PROJECT_NON_DEPENDENT_ROWS[name];
      return projectScopedModel(name).count({
        where:
          nonDependent === undefined
            ? { projectId }
            : { projectId, [Op.not]: nonDependent },
      });
    })
  );

  return counts.reduce((sum: number, count: number) => {
    return sum + count;
  }, 0);
};

// The project has no dependents, so only non-dependent rows can hold a RESTRICT
// FK on it.
export const deleteProjectWithNonDependents = async (args: {
  project: InstanceType<typeof db.Project>;
  projectId: number;
}): Promise<void> => {
  const { projectId } = args;

  await db.sequelize.transaction(async (transaction) => {
    for (const name of PROJECT_COUNTED_MODELS) {
      const nonDependent = PROJECT_NON_DEPENDENT_ROWS[name];
      if (nonDependent === undefined) continue;
      await projectScopedModel(name).destroy({
        where: { [Op.and]: [{ projectId }, nonDependent] },
        transaction,
      });
    }

    await args.project.destroy({ transaction });
  });
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

type ProjectDependentIds = Awaited<ReturnType<typeof findProjectDependentIds>>;

type CascadePreStep = (args: {
  ids: ProjectDependentIds;
  transaction: Transaction;
}) => Promise<void>;

/**
 * Runs immediately before the named model is destroyed by `projectId`, for the
 * rows that carry no `projectId` of their own and whose FK to that model is
 * RESTRICT/NO ACTION — the ones the DB will not take with it.
 */
const PROJECT_CASCADE_PRE_STEPS: Partial<
  Record<ProjectScopedModelName, CascadePreStep>
> = {
  // A run's queue task, checkpoints and node executions all point at it with
  // NO ACTION.
  OrchestrationRun: async ({ ids, transaction }) => {
    if (ids.orchestrationRunIds.length === 0) return;

    const where = { orchestrationRunId: ids.orchestrationRunIds };

    await db.OrchestrationCheckpoint.destroy({ where, transaction });
    await db.OrchestrationNodeExecution.destroy({ where, transaction });
    await db.OrchestrationRunTask.destroy({ where, transaction });
  },

  // `ConversationMessage.documentId` is RESTRICT, so such messages must go
  // before the document itself; those tied to this project's conversations
  // cascade automatically.
  Conversation: async ({ ids, transaction }) => {
    if (ids.documentIds.length === 0) return;

    await db.ConversationMessage.destroy({
      where: { documentId: ids.documentIds },
      transaction,
    });
  },

  // AgentVersion has no projectId of its own and its FK to Agent is RESTRICT,
  // so archived configs are removed by parent agent id before the agents go.
  Agent: async ({ ids, transaction }) => {
    if (ids.agentIds.length === 0) return;

    await db.AgentVersion.destroy({
      where: { agentId: ids.agentIds },
      transaction,
    });
  },

  // Document.fileId is RESTRICT; DocumentChunk cascades from Document.
  // DocumentVersion has no projectId of its own and its FK to Document is
  // RESTRICT, so archived states go by parent document id before the
  // documents do.
  File: async ({ ids, transaction }) => {
    if (ids.documentIds.length === 0) return;

    await db.DocumentVersion.destroy({
      where: { documentId: ids.documentIds },
      transaction,
    });

    await db.Document.destroy({
      where: { id: ids.documentIds },
      transaction,
    });
  },
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

// Cascades every project-scoped resource inside a single transaction, in the
// order `PROJECT_CASCADE_ORDER` declares.
export const forceDeleteProjectWithDependents = async (args: {
  project: InstanceType<typeof db.Project>;
  projectId: number;
}): Promise<void> => {
  const { projectId } = args;

  const ids = await findProjectDependentIds({ projectId });

  log(
    'forceDeleteProjectWithDependents: projectId=%d agents=%d files=%d generations=%d traces=%d',
    projectId,
    ids.agentIds.length,
    ids.files.length,
    ids.generationIds.length,
    ids.traceIds.length
  );

  await db.sequelize.transaction(async (transaction) => {
    await nullifyProjectSelfReferences({
      generationIds: ids.generationIds,
      traceIds: ids.traceIds,
      transaction,
    });

    for (const name of PROJECT_CASCADE_ORDER) {
      await PROJECT_CASCADE_PRE_STEPS[name]?.({ ids, transaction });
      await projectScopedModel(name).destroy({
        where: { projectId },
        transaction,
      });
    }

    await args.project.destroy({ transaction });
  });

  // Storage cleanup happens after the transaction commits, once the File rows
  // are truly gone — a failed object delete is logged and retryable, never a
  // reason to roll back the DB.
  await deleteStorageObjects(ids.files);
};
