import { DomainError } from '../../errors';
import {
  createDatasetItem,
  deleteDatasetItem,
  findDatasetItemById,
  updateDatasetItem,
} from '../evaluationDatasets';
import { toNullableString } from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';
import { isObjectRecord } from './formationSpecLoader';

const toDeclaredMetadata = (value: unknown): object | null | undefined => {
  if (value === undefined) return undefined;
  return isObjectRecord(value) ? value : null;
};

/**
 * Resolves the item's parent dataset from the item itself, rejecting a template
 * that tries to move the item to another dataset.
 *
 * The item lib functions address an item through its dataset — that pairing is
 * what authorizes them — while apply hands a module only a physical resource id.
 * Reading the parent back off the row keeps the module on the same authorized
 * lib calls the REST routes use, instead of a second, unscoped write path. A
 * changed `dataset_id` is an error rather than a silent no-op: applying the rest
 * of the properties would report success while the item stayed in the dataset
 * the template no longer names.
 */
const resolveParentDatasetId = async (args: {
  itemId: string;
  declaredDatasetId?: unknown;
}): Promise<string> => {
  const item = await findDatasetItemById({ itemId: args.itemId });
  if (!item?.dataset_id) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Dataset item '${args.itemId}' not found.`
    );
  }
  if (
    typeof args.declaredDatasetId === 'string' &&
    args.declaredDatasetId !== item.dataset_id
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `dataset_id is immutable: item '${args.itemId}' belongs to '${item.dataset_id}'. Declare a new dataset_item instead.`
    );
  }
  return item.dataset_id;
};

export const datasetItemsFormationModule = defineFormationModule({
  resourceType: 'dataset_item',
  // Items are authorized as writes to their dataset, exactly as the
  // `/datasets/{id}/items` routes are.
  authorization: {
    srnResourceType: 'dataset',
    create: 'evaluations:CreateDataset',
    update: 'evaluations:CreateDataset',
    delete: 'evaluations:CreateDataset',
  },
  propertiesLabel: 'DatasetItem',

  create: ({ properties }) => {
    return createDatasetItem({
      datasetId: properties.dataset_id as string,
      input: properties.input,
      expectedOutput: toNullableString(properties.expected_output),
      metadata: isObjectRecord(properties.metadata)
        ? properties.metadata
        : null,
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    await updateDatasetItem({
      datasetId: await resolveParentDatasetId({
        itemId: physicalResourceId,
        declaredDatasetId: properties.dataset_id,
      }),
      itemId: physicalResourceId,
      input: properties.input,
      // Declared-only: an omitted nullable field is left alone rather than
      // cleared, so a template that only restates `input` keeps the reference
      // answer it never mentioned.
      expectedOutput:
        properties.expected_output === undefined
          ? undefined
          : toNullableString(properties.expected_output),
      metadata: toDeclaredMetadata(properties.metadata),
    });
  },

  // Tolerant of an already-gone item: deleting the parent dataset cascades to
  // its items, so a stack whose dataset went first must still tear down.
  remove: async ({ physicalResourceId }) => {
    const item = await findDatasetItemById({ itemId: physicalResourceId });
    if (!item?.dataset_id) return;
    await deleteDatasetItem({
      datasetId: item.dataset_id,
      itemId: physicalResourceId,
    });
  },

  fetch: ({ physicalResourceId }) => {
    return findDatasetItemById({ itemId: physicalResourceId });
  },
});
