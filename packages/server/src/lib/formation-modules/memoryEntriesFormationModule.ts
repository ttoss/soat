import type { MemoryEntrySource } from '@soat/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';

import { lookupMemoryInternalId } from '../formationsHelpers';
import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  createMemoryEntry,
  deleteMemoryEntry,
  getMemoryEntry,
} from '../memoryEntries';
import {
  normalizePropertyKeys,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:memoryEntries');

const SCHEMA_NAME = 'MemoryEntryResourceProperties';
const RESOURCE_LABEL = 'memory_entry';

// ── Property validation ──────────────────────────────────────────────────

const validateMemoryEntryProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      {
        path: basePath,
        message: 'MemoryEntry `properties` must be an object',
      },
    ];
  }

  const properties = normalizePropertyKeys(args.properties);
  const spec = loadModuleSpec({ schemaName: SCHEMA_NAME });
  const errors: ValidationError[] = [];
  pushUnknownFieldErrors({
    spec,
    resourceLabel: RESOURCE_LABEL,
    properties,
    basePath,
    errors,
  });
  if (!forUpdate) {
    pushRequiredFieldErrors({ spec, properties, basePath, errors });
  }
  pushFieldTypeErrors({ spec, properties, basePath, errors });

  return errors;
};

// ── Module export ────────────────────────────────────────────────────────

export const memoryEntriesFormationModule: FormationModule = {
  resourceType: 'memory_entry',

  validateProperties: ({ properties, basePath }) => {
    return validateMemoryEntryProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties }) => {
    const errors = validateMemoryEntryProperties({
      properties: rawProperties,
      basePath: 'resources.<memory_entry>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    const memoryId = await lookupMemoryInternalId(
      properties.memory_id as string
    );

    const result = await createMemoryEntry({
      memoryId,
      content: properties.content as string,
      sourceType: toOptionalString(properties.source_type) as
        MemoryEntrySource | undefined,
      tags: Array.isArray(properties.tags)
        ? (properties.tags as string[])
        : null,
      metadata: isObjectRecord(properties.metadata)
        ? properties.metadata
        : null,
    });

    log(
      'created memory entry from formation: memoryId=%d entryId=%s',
      memoryId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateMemoryEntryProperties({
      properties: rawProperties,
      basePath: 'resources.<memory_entry>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

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
      entry.tags = Array.isArray(properties.tags)
        ? (properties.tags as string[])
        : null;
    }

    if (properties.metadata !== undefined) {
      entry.metadata = isObjectRecord(properties.metadata)
        ? properties.metadata
        : null;
    }

    await entry.save();

    log('updated memory entry from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteMemoryEntry({ id: physicalResourceId });
    log('deleted memory entry from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    try {
      const entry = await getMemoryEntry({ id: physicalResourceId });
      if (!entry) return null;
      return {
        memory_id: entry.memoryId,
        content: entry.content,
        source_type: entry.sourceType,
        tags: entry.tags,
        metadata: entry.metadata,
      };
    } catch {
      return null;
    }
  },
};
