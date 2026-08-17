/**
 * Evals — an agent under test, the dataset to run it against, and the scorers
 * its outputs are judged by (the evaluations module doc).
 *
 * Datasets and their items live in `evaluationDatasets.ts`, run execution in
 * `evaluationRuns.ts`, and the pure scorer rules in `evaluationScorers.ts`.
 * What stays here is Eval CRUD plus the referential checks that keep an Eval
 * runnable.
 */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { validateScorers } from './evaluationScorers';
import { validateToolScorerRefs } from './evaluationToolScorer';
import {
  assertValid,
  requireName,
  validatePassThreshold,
} from './evaluationValidation';
import type { ResourceIncludes } from './modelIncludes';
import { paginatedList, type PaginatedResult } from './pagination';
import { isPlainObject } from './plainObject';
import { makeResourceAccessor } from './resourceAccessor';
import { rethrowAsConflict } from './uniqueViolation';

const log = createDebug('soat:evaluations');

export type EvalRow = InstanceType<(typeof db)['Eval']> & {
  project?: InstanceType<(typeof db)['Project']>;
  agent?: InstanceType<(typeof db)['Agent']>;
  dataset?: InstanceType<(typeof db)['Dataset']>;
};

export const mapEval = (evaluation: EvalRow) => {
  return {
    id: evaluation.publicId,
    project_id: evaluation.project?.publicId,
    name: evaluation.name,
    agent_id: evaluation.agent?.publicId,
    dataset_id: evaluation.dataset?.publicId,
    scorers: evaluation.scorers,
    pass_threshold:
      evaluation.passThreshold === null
        ? null
        : Number(evaluation.passThreshold),
    created_at: evaluation.createdAt,
    updated_at: evaluation.updatedAt,
  };
};

const evalIncludes = (): ResourceIncludes => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Agent, as: 'agent' },
    { model: db.Dataset, as: 'dataset' },
  ];
};

const evals = makeResourceAccessor<EvalRow>({
  model: () => {
    return db.Eval;
  },
  includes: evalIncludes,
  label: 'Eval',
});

/**
 * Loads an eval — with its agent and dataset attached — scoped to the caller's
 * projects. Exported for `evaluationRuns.ts` / `evaluationRunReads.ts`, which
 * authorize runs and results against their parent Eval.
 */
export const getEvalRow = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<EvalRow> => {
  return evals.getByPublicId(args);
};

/**
 * Resolves a referenced agent/dataset **within the eval's own project**.
 *
 * A cross-project reference is a `400` naming the field rather than a `404`:
 * the resource may well exist, it is the request that is wrong (see
 * `.claude/rules/errors.md` — referenced-entity codes are 400).
 */
const resolveReference = async (args: {
  model: 'Agent' | 'Dataset';
  field: string;
  publicId: string;
  projectId: number;
}): Promise<{ id: number; outputSchema?: unknown }> => {
  const where = { publicId: args.publicId, projectId: args.projectId };
  const row =
    args.model === 'Agent'
      ? await db.Agent.findOne({ where })
      : await db.Dataset.findOne({ where });

  if (!row) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${args.field} '${args.publicId}' does not reference a ${args.model.toLowerCase()} in this project.`
    );
  }

  return {
    id: row.id as number,
    outputSchema:
      args.model === 'Agent'
        ? (row as InstanceType<(typeof db)['Agent']>).outputSchema
        : undefined,
  };
};

const requireReferenceId = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value === '') {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${field} is required and must be a resource id.`
    );
  }
  return value;
};

export const createEval = async (args: {
  projectId: number;
  name: unknown;
  agentId: unknown;
  datasetId: unknown;
  scorers: unknown;
  passThreshold?: unknown;
}): Promise<ReturnType<typeof mapEval>> => {
  const name = requireName(args.name);
  log('createEval: projectId=%d name=%s', args.projectId, name);

  const agent = await resolveReference({
    model: 'Agent',
    field: 'agent_id',
    publicId: requireReferenceId(args.agentId, 'agent_id'),
    projectId: args.projectId,
  });
  const dataset = await resolveReference({
    model: 'Dataset',
    field: 'dataset_id',
    publicId: requireReferenceId(args.datasetId, 'dataset_id'),
    projectId: args.projectId,
  });

  // Best-effort at create time — the agent's `output_schema` is mutable, so
  // `evaluationRuns.ts` re-checks this authoritatively at run start.
  assertValid(
    validateScorers({
      scorers: args.scorers,
      agentHasOutputSchema: isPlainObject(agent.outputSchema),
    })
  );
  await validateToolScorerRefs({
    scorers: args.scorers,
    projectId: args.projectId,
  });
  assertValid(validatePassThreshold(args.passThreshold));

  let evaluation;
  try {
    evaluation = await db.Eval.create({
      projectId: args.projectId,
      name,
      agentId: agent.id,
      datasetId: dataset.id,
      scorers: args.scorers,
      passThreshold:
        args.passThreshold === undefined || args.passThreshold === null
          ? null
          : String(args.passThreshold),
    });
  } catch (error) {
    throw rethrowAsConflict(
      error,
      `An eval named '${name}' already exists in this project.`
    );
  }

  return mapEval(await evals.reload(evaluation));
};

export const listEvals = async (args: {
  projectIds?: number[];
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<ReturnType<typeof mapEval>>> => {
  log('listEvals: projectIds=%o', args.projectIds);

  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Eval.findAndCountAll({
        where,
        include: evalIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (row) => {
      return mapEval(row as EvalRow);
    },
  });
};

export const getEval = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<ReturnType<typeof mapEval>> => {
  log('getEval: id=%s', args.id);
  return mapEval(await evals.getByPublicId(args));
};

/**
 * Resolves the reference updates, returning the `output_schema` the scorers
 * must be judged against — the incoming agent's when one is supplied, the
 * stored agent's otherwise.
 */
const applyEvalReferences = async (args: {
  evaluation: EvalRow;
  updates: Record<string, unknown>;
  agentId?: unknown;
  datasetId?: unknown;
}): Promise<unknown> => {
  const projectId = args.evaluation.projectId;
  let agentOutputSchema: unknown = args.evaluation.agent?.outputSchema;

  if (args.agentId !== undefined) {
    const agent = await resolveReference({
      model: 'Agent',
      field: 'agent_id',
      publicId: requireReferenceId(args.agentId, 'agent_id'),
      projectId,
    });
    args.updates.agentId = agent.id;
    agentOutputSchema = agent.outputSchema;
  }

  if (args.datasetId !== undefined) {
    const dataset = await resolveReference({
      model: 'Dataset',
      field: 'dataset_id',
      publicId: requireReferenceId(args.datasetId, 'dataset_id'),
      projectId,
    });
    args.updates.datasetId = dataset.id;
  }

  return agentOutputSchema;
};

export const updateEval = async (args: {
  projectIds?: number[];
  id: string;
  name?: unknown;
  agentId?: unknown;
  datasetId?: unknown;
  scorers?: unknown;
  passThreshold?: unknown;
}): Promise<ReturnType<typeof mapEval>> => {
  log('updateEval: id=%s', args.id);

  const evaluation = await evals.getByPublicId({
    id: args.id,
    projectIds: args.projectIds,
  });

  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) updates.name = requireName(args.name);

  const agentOutputSchema = await applyEvalReferences({
    evaluation,
    updates,
    agentId: args.agentId,
    datasetId: args.datasetId,
  });

  // Re-validated whenever either half of the pair moves: swapping the agent can
  // invalidate an `output_schema` scorer that was legal against the old one.
  if (args.scorers !== undefined || args.agentId !== undefined) {
    const scorers =
      args.scorers === undefined ? evaluation.scorers : args.scorers;
    assertValid(
      validateScorers({
        scorers,
        agentHasOutputSchema: isPlainObject(agentOutputSchema),
      })
    );
    await validateToolScorerRefs({
      scorers,
      projectId: evaluation.projectId as number,
    });
    updates.scorers = scorers;
  }

  if (args.passThreshold !== undefined) {
    assertValid(validatePassThreshold(args.passThreshold));
    updates.passThreshold =
      args.passThreshold === null ? null : String(args.passThreshold);
  }

  try {
    await evaluation.update(updates);
  } catch (error) {
    throw rethrowAsConflict(
      error,
      `An eval named '${String(updates.name)}' already exists in this project.`
    );
  }

  return mapEval(await evals.reload(evaluation));
};

export const deleteEval = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<void> => {
  log('deleteEval: id=%s', args.id);
  const evaluation = await evals.getByPublicId({
    id: args.id,
    projectIds: args.projectIds,
  });
  await evaluation.destroy();
};
