import type { MemorySource } from '@soat/postgresdb';
import { db } from 'src/db';

import { lookupMemoryStoreInternalId } from '../formationsHelpers';
import {
  assertMemoryStorageQuota,
  createMemory,
  deleteMemory,
  getMemory,
} from '../memories';
import {
  toNullableStringRecord,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';
import { isObjectRecord } from './formationSpecLoader';

export const memoriesFormationModule = defineFormationModule({
  resourceType: 'memory',
  authorization: {
    srnResourceType: 'memory_store',
    create: 'memories:CreateMemory',
    update: 'memories:UpdateMemory',
    delete: 'memories:DeleteMemory',
  },
  propertiesLabel: 'Memory',

  create: async ({ properties, projectId }) => {
    const memoryStoreId = await lookupMemoryStoreInternalId({
      publicId: properties.memory_store_id as string,
      projectId,
    });

    const content = properties.content as string;
    await assertMemoryStorageQuota({ memoryStoreId, content });

    return createMemory({
      memoryStoreId,
      content,
      sourceType: toOptionalString(properties.source_type) as
        MemorySource | undefined,
      sourceId: toOptionalString(properties.source_id) ?? null,
      tags: toNullableStringRecord(properties.tags) ?? null,
      metadata: isObjectRecord(properties.metadata)
        ? properties.metadata
        : null,
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    const entry = await db.Memory.findOne({
      where: { publicId: physicalResourceId },
    });

    if (!entry) {
      throw new Error(`Memory not found: ${physicalResourceId}`);
    }

    const content = toOptionalString(properties.content);
    if (content !== undefined) {
      entry.content = content;
    }

    if (properties.tags !== undefined) {
      entry.tags = toNullableStringRecord(properties.tags) ?? null;
    }

    if (properties.metadata !== undefined) {
      entry.metadata = isObjectRecord(properties.metadata)
        ? properties.metadata
        : null;
    }

    await entry.save();
  },

  remove: ({ physicalResourceId }) => {
    return deleteMemory({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getMemory({ id: physicalResourceId });
  },
});
