import {
  createMemory,
  deleteMemory,
  getMemory,
  updateMemory,
} from '../memories';
import {
  toNullableArray,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

export const memoriesFormationModule = defineFormationModule({
  resourceType: 'memory',
  authorization: {
    srnResourceType: 'memory',
    create: 'memories:CreateMemory',
    update: 'memories:UpdateMemory',
    delete: 'memories:DeleteMemory',
  },

  create: ({ properties, projectId }) => {
    return createMemory({
      projectId,
      name: properties.name as string,
      description: toOptionalString(properties.description) ?? undefined,
      tags: toNullableArray(properties.tags) as string[] | undefined,
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    await updateMemory({
      id: physicalResourceId,
      name: toOptionalString(properties.name) ?? undefined,
      description: toNullableString(properties.description),
      tags: toNullableArray(properties.tags) as string[] | null | undefined,
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteMemory({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getMemory({ id: physicalResourceId });
  },
});
