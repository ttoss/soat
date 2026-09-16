import type { MemorySource } from '@soat/postgresdb';
import { db } from 'src/db';

import { lookupMemoryStoreInternalId } from '../formationsHelpers';
import {
  assertMemoryStorageQuota,
  createMemory,
  deleteMemory,
  getMemory,
  updateMemory,
} from '../memories';
import { resolveFormationPrincipal } from '../memoryAssertionPrincipal';
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

  create: async ({ properties, projectId, actingUserId }) => {
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
      // The apply is the asserter here, under the identity that ran it: a
      // formation write has no generation and no agent behind it.
      assertion: {
        mechanism: 'formation',
        ...(await resolveFormationPrincipal({ actingUserId })),
      },
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    const entry = await db.Memory.findOne({
      where: { publicId: physicalResourceId },
    });

    if (!entry) {
      throw new Error(`Memory not found: ${physicalResourceId}`);
    }

    // Through the lib rather than the row: a content change re-points the
    // memory at the store's shared row for the new text, which this module
    // must not reimplement.
    await updateMemory({
      id: physicalResourceId,
      content: toOptionalString(properties.content),
      tags:
        properties.tags === undefined
          ? undefined
          : (toNullableStringRecord(properties.tags) ?? null),
      metadata:
        properties.metadata === undefined
          ? undefined
          : isObjectRecord(properties.metadata)
            ? properties.metadata
            : null,
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteMemory({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getMemory({ id: physicalResourceId });
  },
});
