import type { MemorySource } from '@soat/postgresdb';
import { db } from 'src/db';

import { DomainError } from '../../errors';
import { lookupMemoryStoreInternalId } from '../formationLookups';
import {
  assertMemorySpendWithinQuota,
  assertMemoryStorageQuota,
  createMemory,
  deleteMemory,
  getMemory,
  updateMemory,
} from '../memories';
import {
  toNullableStringRecord,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { assertNoSystemTagKeys } from '../tags';
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

  create: async ({ properties, projectId, actor }) => {
    const memoryStoreId = await lookupMemoryStoreInternalId({
      publicId: properties.memory_store_id as string,
      projectId,
    });

    const content = properties.content as string;
    await assertMemoryStorageQuota({ memoryStoreId, content });
    await assertMemorySpendWithinQuota({ memoryStoreId });

    return createMemory({
      memoryStoreId,
      content,
      sourceType: toOptionalString(properties.source_type) as
        MemorySource | undefined,
      sourceId: toOptionalString(properties.source_id) ?? null,
      tags:
        assertNoSystemTagKeys(toNullableStringRecord(properties.tags)) ?? null,
      metadata: isObjectRecord(properties.metadata)
        ? properties.metadata
        : null,
      // The apply is the asserter here, under the credential that ran it: a
      // formation write has no generation and no agent behind it.
      assertion: { mechanism: 'formation', ...actor.author },
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    const entry = await db.Memory.findOne({
      where: { publicId: physicalResourceId },
    });

    if (!entry) {
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        `Memory not found: ${physicalResourceId}`
      );
    }

    const content = toOptionalString(properties.content);
    if (content !== undefined) {
      const memoryStoreId = entry.memoryStoreId as number;
      await assertMemoryStorageQuota({ memoryStoreId, content });
      await assertMemorySpendWithinQuota({ memoryStoreId });
    }

    // Through the lib rather than the row: a content change re-points the
    // memory at the store's shared row for the new text, which this module
    // must not reimplement.
    await updateMemory({
      id: physicalResourceId,
      content,
      tags:
        properties.tags === undefined
          ? undefined
          : (assertNoSystemTagKeys(toNullableStringRecord(properties.tags)) ??
            null),
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
