import createDebug from 'debug';

import { createDocument, deleteDocument } from '../documents';
import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  toNullableObject,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:documents');

const SCHEMA_NAME = 'DocumentResourceProperties';
const RESOURCE_LABEL = 'document';

// ── Key normalization ────────────────────────────────────────────────────

const camelToSnakeKey = (key: string): string => {
  return key.replace(/[A-Z]/g, (char) => {
    return `_${char.toLowerCase()}`;
  });
};

const normalizePropertyKeys = (
  properties: Record<string, unknown>
): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => {
      return [camelToSnakeKey(key), value];
    })
  );
};

// ── Property validation ──────────────────────────────────────────────────

const validateDocumentProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      {
        path: basePath,
        message: 'Document `properties` must be an object',
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

export const documentsFormationModule: FormationModule = {
  resourceType: 'document',

  validateProperties: ({ properties, basePath }) => {
    return validateDocumentProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateDocumentProperties({
      properties: rawProperties,
      basePath: 'resources.<document>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    const result = await createDocument({
      projectId,
      content: properties.content as string,
      path: toOptionalString(properties.path) ?? undefined,
      filename: toOptionalString(properties.filename) ?? undefined,
      title: toOptionalString(properties.title) ?? undefined,
      metadata: (toNullableObject(properties.metadata) ?? undefined) as
        | Record<string, unknown>
        | undefined,
      tags: (toNullableObject(properties.tags) ?? undefined) as
        | Record<string, string>
        | undefined,
    });

    log(
      'created document from formation: projectId=%d docId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  // Documents are immutable once created — update is a no-op.
  update: async () => {
    return;
  },

  delete: async ({ physicalResourceId }) => {
    await deleteDocument({ id: physicalResourceId });
    log('deleted document from formation: id=%s', physicalResourceId);
  },
};
