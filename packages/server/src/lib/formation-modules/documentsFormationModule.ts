import createDebug from 'debug';

import type { ChunkStrategy } from '../chunking';
import {
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentSourceContent,
  updateDocument,
} from '../documents';
import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  normalizePropertyKeys,
  toNullableNumber,
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

const CHUNK_STRATEGIES: readonly ChunkStrategy[] = ['page', 'whole', 'size'];

const toChunkStrategy = (value: unknown): ChunkStrategy | undefined => {
  return typeof value === 'string' &&
    (CHUNK_STRATEGIES as readonly string[]).includes(value)
    ? (value as ChunkStrategy)
    : undefined;
};

const log = createDebug('soat:formations:documents');

const SCHEMA_NAME = 'DocumentResourceProperties';
const RESOURCE_LABEL = 'document';

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
        Record<string, unknown> | undefined,
      tags: (toNullableObject(properties.tags) ?? undefined) as
        Record<string, string> | undefined,
      chunkStrategy: toChunkStrategy(properties.chunk_strategy),
      chunkSize: toNullableNumber(properties.chunk_size) ?? undefined,
      chunkOverlap: toNullableNumber(properties.chunk_overlap) ?? undefined,
    });

    log(
      'created document from formation: projectId=%d docId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateDocumentProperties({
      properties: rawProperties,
      basePath: 'resources.<document>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    // Re-chunk when the strategy (or content) changes so the deployed document
    // reflects the template instead of keeping its original chunking until an
    // out-of-band reingest.
    await updateDocument({
      id: physicalResourceId,
      content: toOptionalString(properties.content) ?? undefined,
      path: toOptionalString(properties.path) ?? undefined,
      title: toOptionalString(properties.title) ?? undefined,
      metadata: (toNullableObject(properties.metadata) ?? undefined) as
        Record<string, unknown> | undefined,
      tags: (toNullableObject(properties.tags) ?? undefined) as
        Record<string, string> | undefined,
      chunkStrategy: toChunkStrategy(properties.chunk_strategy),
      chunkSize: toNullableNumber(properties.chunk_size) ?? undefined,
      chunkOverlap: toNullableNumber(properties.chunk_overlap) ?? undefined,
    });

    log('updated document from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteDocument({ id: physicalResourceId });
    log('deleted document from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    try {
      const doc = await getDocument({ id: physicalResourceId });
      if (!doc) return null;
      // Read the original source text (not the chunk-reconstructed content) so
      // `content` round-trips even under the `size` strategy, which joins
      // overlapping windows with newlines.
      const sourceContent = await getDocumentSourceContent({
        id: physicalResourceId,
      });
      return {
        content: sourceContent ?? doc.content,
        path: doc.path,
        filename: doc.filename,
        title: doc.title,
        metadata: doc.metadata,
        tags: doc.tags,
        chunk_strategy: doc.chunkStrategy,
        chunk_size: doc.chunkSize,
        chunk_overlap: doc.chunkOverlap,
      };
    } catch {
      return null;
    }
  },
};
