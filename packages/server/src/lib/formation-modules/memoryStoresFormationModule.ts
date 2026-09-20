import { findThresholdOrderError, resolveMemoryThresholds } from '../memories';
import {
  createMemoryStore,
  deleteMemoryStore,
  getMemoryStore,
  updateMemoryStore,
} from '../memoryStores';
import {
  toNullableString,
  toNullableStringRecord,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { assertNoSystemTagKeys } from '../tags';
import { defineFormationModule } from './defineFormationModule';

/**
 * A declared threshold, or `null` where the template states the field as null —
 * which clears the override back to the algorithm constant. `undefined` is the
 * field being absent, which leaves the stored value alone.
 */
const readThreshold = (value: unknown): number | null | undefined => {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? value : null;
};

export const memoryStoresFormationModule = defineFormationModule({
  resourceType: 'memory_store',
  authorization: {
    srnResourceType: 'memory_store',
    create: 'memories:CreateMemoryStore',
    update: 'memories:UpdateMemoryStore',
    delete: 'memories:DeleteMemoryStore',
  },
  propertiesLabel: 'Memory store',

  // The schema already rejects a non-number and a value outside [0, 1]; what it
  // cannot express is the relation between the two, which decides whether all
  // three write outcomes stay reachable.
  extraChecks: ({ properties, basePath, errors }) => {
    const error = findThresholdOrderError(
      resolveMemoryThresholds({
        duplicateThreshold:
          readThreshold(properties.duplicate_threshold) ?? undefined,
        supersedeThreshold:
          readThreshold(properties.supersede_threshold) ?? undefined,
      })
    );
    if (error) {
      errors.push({ path: `${basePath}.supersede_threshold`, message: error });
    }
  },

  create: ({ properties, projectId }) => {
    return createMemoryStore({
      projectId,
      name: properties.name as string,
      description: toOptionalString(properties.description) ?? undefined,
      tags:
        assertNoSystemTagKeys(toNullableStringRecord(properties.tags)) ??
        undefined,
      duplicateThreshold: readThreshold(properties.duplicate_threshold),
      supersedeThreshold: readThreshold(properties.supersede_threshold),
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    await updateMemoryStore({
      id: physicalResourceId,
      name: toOptionalString(properties.name) ?? undefined,
      description: toNullableString(properties.description),
      tags: assertNoSystemTagKeys(toNullableStringRecord(properties.tags)),
      duplicateThreshold: readThreshold(properties.duplicate_threshold),
      supersedeThreshold: readThreshold(properties.supersede_threshold),
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteMemoryStore({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getMemoryStore({ id: physicalResourceId });
  },
});
