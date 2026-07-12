import createDebug from 'debug';

import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  createMemory,
  deleteMemory,
  getMemory,
  updateMemory,
} from '../memories';
import {
  normalizePropertyKeys,
  toNullableArray,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:memories');

const SCHEMA_NAME = 'MemoryResourceProperties';
const RESOURCE_LABEL = 'memory';

// ── Property validation ──────────────────────────────────────────────────

const validateMemoryProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      {
        path: basePath,
        message: 'Memory `properties` must be an object',
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

export const memoriesFormationModule: FormationModule = {
  resourceType: 'memory',

  validateProperties: ({ properties, basePath }) => {
    return validateMemoryProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateMemoryProperties({
      properties: rawProperties,
      basePath: 'resources.<memory>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    const result = await createMemory({
      projectId,
      name: properties.name as string,
      description: toOptionalString(properties.description) ?? undefined,
      tags: toNullableArray(properties.tags) as string[] | undefined,
    });

    log(
      'created memory from formation: projectId=%d memoryId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateMemoryProperties({
      properties: rawProperties,
      basePath: 'resources.<memory>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    await updateMemory({
      id: physicalResourceId,
      name: toOptionalString(properties.name) ?? undefined,
      description: toNullableString(properties.description),
      tags: toNullableArray(properties.tags) as string[] | null | undefined,
    });

    log('updated memory from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteMemory({ id: physicalResourceId });
    log('deleted memory from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    try {
      const memory = await getMemory({ id: physicalResourceId });
      if (!memory) return null;
      return {
        name: memory.name,
        description: memory.description,
        tags: memory.tags,
      };
    } catch {
      return null;
    }
  },
};
