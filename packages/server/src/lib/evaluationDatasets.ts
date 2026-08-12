/**
 * Datasets and their items — the fixtures an eval runs an agent against
 * (docs/prd-evaluations.md, Phase 1).
 *
 * Items keep full CRUD on purpose. A run does not depend on them staying put:
 * each `EvalResult` freezes its own copy of the item's `input` and
 * `expected_output`, so editing or deleting a fixture can never rewrite the
 * history of a run that already scored it — and a baseline delta can never
 * report dataset drift as agent regression.
 */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  assertValid,
  requireName,
  requireOptionalText,
  validateDatasetItemInput,
  validateItemMetadata,
} from './evaluationValidation';
import type { ResourceIncludes } from './modelIncludes';
import { paginatedList, type PaginatedResult } from './pagination';
import { makeResourceAccessor } from './resourceAccessor';
import { rethrowAsConflict } from './uniqueViolation';

const log = createDebug('soat:evaluations');

export type DatasetRow = InstanceType<(typeof db)['Dataset']> & {
  project?: InstanceType<(typeof db)['Project']>;
};

type DatasetItemRow = InstanceType<(typeof db)['DatasetItem']> & {
  dataset?: InstanceType<(typeof db)['Dataset']>;
  sourceGeneration?: InstanceType<(typeof db)['Generation']> | null;
};

// ── Mapping ────────────────────────────────────────────────────────────────

export const mapDataset = (dataset: DatasetRow) => {
  return {
    id: dataset.publicId,
    project_id: dataset.project?.publicId,
    name: dataset.name,
    description: dataset.description,
    created_at: dataset.createdAt,
    updated_at: dataset.updatedAt,
  };
};

export const mapDatasetItem = (item: DatasetItemRow) => {
  return {
    id: item.publicId,
    dataset_id: item.dataset?.publicId,
    input: item.input,
    expected_output: item.expectedOutput,
    metadata: item.metadata,
    // Always null in Phase 1 — the `from-generation` curation route that sets
    // it ships with Phase 2. Declared now so neither the column nor the wire
    // shape has to change when it does.
    source_generation_id: item.sourceGeneration?.publicId ?? null,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
};

const datasetIncludes = (): ResourceIncludes => {
  return [{ model: db.Project, as: 'project' }];
};

const datasetItemIncludes = (): ResourceIncludes => {
  return [
    { model: db.Dataset, as: 'dataset' },
    { model: db.Generation, as: 'sourceGeneration' },
  ];
};

const datasets = makeResourceAccessor<DatasetRow>({
  model: () => {
    return db.Dataset;
  },
  includes: datasetIncludes,
  label: 'Dataset',
});

// ── Datasets ───────────────────────────────────────────────────────────────

export const createDataset = async (args: {
  projectId: number;
  name: unknown;
  description?: unknown;
}): Promise<ReturnType<typeof mapDataset>> => {
  const name = requireName(args.name);
  log('createDataset: projectId=%d name=%s', args.projectId, name);

  let dataset;
  try {
    dataset = await db.Dataset.create({
      projectId: args.projectId,
      name,
      description: requireOptionalText(args.description, 'description') ?? null,
    });
  } catch (error) {
    throw rethrowAsConflict(
      error,
      `A dataset named '${name}' already exists in this project.`
    );
  }

  return mapDataset(await datasets.reload(dataset));
};

export const listDatasets = async (args: {
  projectIds?: number[];
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<ReturnType<typeof mapDataset>>> => {
  log('listDatasets: projectIds=%o', args.projectIds);

  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Dataset.findAndCountAll({
        where,
        include: datasetIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (row) => {
      return mapDataset(row as DatasetRow);
    },
  });
};

export const getDataset = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<ReturnType<typeof mapDataset>> => {
  log('getDataset: id=%s', args.id);
  return mapDataset(await datasets.getByPublicId(args));
};

export const updateDataset = async (args: {
  projectIds?: number[];
  id: string;
  name?: unknown;
  description?: unknown;
}): Promise<ReturnType<typeof mapDataset>> => {
  log('updateDataset: id=%s', args.id);

  const dataset = await datasets.getByPublicId({
    id: args.id,
    projectIds: args.projectIds,
  });

  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) updates.name = requireName(args.name);
  if (args.description !== undefined) {
    updates.description = requireOptionalText(args.description, 'description');
  }

  try {
    await dataset.update(updates);
  } catch (error) {
    throw rethrowAsConflict(
      error,
      `A dataset named '${String(updates.name)}' already exists in this project.`
    );
  }

  return mapDataset(await datasets.reload(dataset));
};

/**
 * Deletes a dataset and its items. Evals bound to it go too (FK CASCADE) — an
 * Eval whose dataset is gone has nothing to run, and leaving it behind would
 * only fail at the next run start.
 */
export const deleteDataset = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<void> => {
  log('deleteDataset: id=%s', args.id);
  const dataset = await datasets.getByPublicId({
    id: args.id,
    projectIds: args.projectIds,
  });
  await dataset.destroy();
};

// ── Items ──────────────────────────────────────────────────────────────────

/**
 * Loads one item, authorized against its **parent dataset** — the item row
 * carries no project column of its own.
 */
const findItem = async (args: {
  projectIds?: number[];
  datasetId: string;
  itemId: string;
}): Promise<DatasetItemRow> => {
  const dataset = await datasets.getByPublicId({
    id: args.datasetId,
    projectIds: args.projectIds,
  });

  const item = (await db.DatasetItem.findOne({
    where: { publicId: args.itemId, datasetId: dataset.id as number },
    include: datasetItemIncludes(),
  })) as DatasetItemRow | null;

  if (!item) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Dataset item '${args.itemId}' not found.`
    );
  }
  return item;
};

export const createDatasetItem = async (args: {
  projectIds?: number[];
  datasetId: string;
  input: unknown;
  expectedOutput?: unknown;
  metadata?: unknown;
}): Promise<ReturnType<typeof mapDatasetItem>> => {
  log('createDatasetItem: datasetId=%s', args.datasetId);

  const dataset = await datasets.getByPublicId({
    id: args.datasetId,
    projectIds: args.projectIds,
  });

  assertValid(validateDatasetItemInput(args.input));
  assertValid(validateItemMetadata(args.metadata));

  const item = await db.DatasetItem.create({
    datasetId: dataset.id as number,
    input: args.input,
    expectedOutput:
      requireOptionalText(args.expectedOutput, 'expected_output') ?? null,
    metadata: (args.metadata as object | null | undefined) ?? null,
  });

  return mapDatasetItem(
    await findItem({
      projectIds: args.projectIds,
      datasetId: args.datasetId,
      itemId: item.publicId,
    })
  );
};

export const listDatasetItems = async (args: {
  projectIds?: number[];
  datasetId: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<ReturnType<typeof mapDatasetItem>>> => {
  log('listDatasetItems: datasetId=%s', args.datasetId);

  const dataset = await datasets.getByPublicId({
    id: args.datasetId,
    projectIds: args.projectIds,
  });

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.DatasetItem.findAndCountAll({
        where: { datasetId: dataset.id as number },
        include: datasetItemIncludes(),
        order: [['createdAt', 'ASC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (row) => {
      return mapDatasetItem(row as DatasetItemRow);
    },
  });
};

export const updateDatasetItem = async (args: {
  projectIds?: number[];
  datasetId: string;
  itemId: string;
  input?: unknown;
  expectedOutput?: unknown;
  metadata?: unknown;
}): Promise<ReturnType<typeof mapDatasetItem>> => {
  log('updateDatasetItem: datasetId=%s itemId=%s', args.datasetId, args.itemId);

  const item = await findItem({
    projectIds: args.projectIds,
    datasetId: args.datasetId,
    itemId: args.itemId,
  });

  const updates: Record<string, unknown> = {};
  if (args.input !== undefined) {
    assertValid(validateDatasetItemInput(args.input));
    updates.input = args.input;
  }
  if (args.expectedOutput !== undefined) {
    updates.expectedOutput = requireOptionalText(
      args.expectedOutput,
      'expected_output'
    );
  }
  if (args.metadata !== undefined) {
    assertValid(validateItemMetadata(args.metadata));
    updates.metadata = args.metadata as object | null;
  }

  await item.update(updates);

  return mapDatasetItem(
    await findItem({
      projectIds: args.projectIds,
      datasetId: args.datasetId,
      itemId: args.itemId,
    })
  );
};

/**
 * Deletes an item. Results of runs that already scored it stay intact — they
 * carry their own frozen copies and only lose the `dataset_item_id` link.
 */
export const deleteDatasetItem = async (args: {
  projectIds?: number[];
  datasetId: string;
  itemId: string;
}): Promise<void> => {
  log('deleteDatasetItem: datasetId=%s itemId=%s', args.datasetId, args.itemId);
  const item = await findItem(args);
  await item.destroy();
};
