import type { MemoryEntrySource } from '@soat/postgresdb';
import { db } from 'src/db';

import { lookupMemoryInternalId } from '../formationsHelpers';
import {
  assertMemoryEntryStorageQuota,
  createMemoryEntry,
  deleteMemoryEntry,
  getMemoryEntry,
} from '../memoryEntries';
import {
  toNullableStringRecord,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';
import { isObjectRecord } from './formationSpecLoader';

export const memoryEntriesFormationModule = defineFormationModule({
  resourceType: 'memory_entry',
  authorization: {
    srnResourceType: 'memory',
    create: 'memories:CreateMemoryEntry',
    update: 'memories:UpdateMemoryEntry',
    delete: 'memories:DeleteMemoryEntry',
  },
  propertiesLabel: 'MemoryEntry',

  create: async ({ properties, projectId }) => {
    const memoryId = await lookupMemoryInternalId({
      publicId: properties.memory_id as string,
      projectId,
    });

    const content = properties.content as string;
    await assertMemoryEntryStorageQuota({ memoryId, content });

    return createMemoryEntry({
      memoryId,
      content,
      sourceType: toOptionalString(properties.source_type) as
        MemoryEntrySource | undefined,
      tags: toNullableStringRecord(properties.tags) ?? null,
      metadata: isObjectRecord(properties.metadata)
        ? properties.metadata
        : null,
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    const entry = await db.MemoryEntry.findOne({
      where: { publicId: physicalResourceId },
    });

    if (!entry) {
      throw new Error(`MemoryEntry not found: ${physicalResourceId}`);
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
    return deleteMemoryEntry({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getMemoryEntry({ id: physicalResourceId });
  },
});
