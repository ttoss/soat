import createDebug from 'debug';

import { createFile, deleteFile, getFile, updateFileMetadata } from '../files';
import type { FormationModule, ValidationError } from '../formationsTypes';
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

const log = createDebug('soat:formations:files');

const SCHEMA_NAME = 'FileResourceProperties';
const RESOURCE_LABEL = 'file';

// ── Property validation ──────────────────────────────────────────────────

const validateFileProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      {
        path: basePath,
        message: 'File `properties` must be an object',
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

export const filesFormationModule: FormationModule = {
  resourceType: 'file',

  validateProperties: ({ properties, basePath }) => {
    return validateFileProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateFileProperties({
      properties: rawProperties,
      basePath: 'resources.<file>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    // storage_type / storage_path are not part of the file resource schema —
    // storage is system-managed (see FILES_STORAGE_DIR).
    const result = await createFile({
      projectId,
      prefix: toOptionalString(properties.prefix) ?? undefined,
      filename: toOptionalString(properties.filename) ?? undefined,
      contentType: toOptionalString(properties.content_type) ?? undefined,
      size: typeof properties.size === 'number' ? properties.size : undefined,
      metadata: toOptionalString(properties.metadata) ?? undefined,
    });

    log(
      'created file from formation: projectId=%d fileId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateFileProperties({
      properties: rawProperties,
      basePath: 'resources.<file>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    await updateFileMetadata({
      id: physicalResourceId,
      prefix: toOptionalString(properties.prefix) ?? undefined,
      filename: toOptionalString(properties.filename) ?? undefined,
      metadata: toOptionalString(properties.metadata) ?? undefined,
    });

    log('updated file from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteFile({ id: physicalResourceId });
    log('deleted file from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    try {
      const file = await getFile({ id: physicalResourceId });
      if (!file) return null;
      return {
        prefix: file.prefix,
        filename: file.filename,
        content_type: file.contentType,
        size: file.size,
        metadata: file.metadata,
      };
    } catch {
      return null;
    }
  },
};
