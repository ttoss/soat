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
import { defineFormationModule } from './defineFormationModule';

export const memoryStoresFormationModule = defineFormationModule({
  resourceType: 'memory_store',
  authorization: {
    srnResourceType: 'memory_store',
    create: 'memories:CreateMemoryStore',
    update: 'memories:UpdateMemoryStore',
    delete: 'memories:DeleteMemoryStore',
  },
  propertiesLabel: 'Memory store',

  create: ({ properties, projectId }) => {
    return createMemoryStore({
      projectId,
      name: properties.name as string,
      description: toOptionalString(properties.description) ?? undefined,
      tags: toNullableStringRecord(properties.tags) ?? undefined,
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    await updateMemoryStore({
      id: physicalResourceId,
      name: toOptionalString(properties.name) ?? undefined,
      description: toNullableString(properties.description),
      tags: toNullableStringRecord(properties.tags),
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteMemoryStore({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getMemoryStore({ id: physicalResourceId });
  },
});
