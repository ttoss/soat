import type { ChunkStrategy } from '../chunking';
import {
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentSourceContent,
  updateDocument,
} from '../documents';
import {
  toNullableNumber,
  toNullableObject,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

const CHUNK_STRATEGIES: readonly ChunkStrategy[] = ['page', 'whole', 'size'];

const toChunkStrategy = (value: unknown): ChunkStrategy | undefined => {
  return typeof value === 'string' &&
    (CHUNK_STRATEGIES as readonly string[]).includes(value)
    ? (value as ChunkStrategy)
    : undefined;
};

export const documentsFormationModule = defineFormationModule({
  resourceType: 'document',
  authorization: {
    srnResourceType: 'document',
    create: 'documents:CreateDocument',
    update: 'documents:UpdateDocument',
    delete: 'documents:DeleteDocument',
  },

  create: ({ properties, projectId }) => {
    return createDocument({
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
  },

  // Re-chunk when the strategy (or content) changes so the deployed document
  // reflects the template instead of keeping its original chunking until an
  // out-of-band reingest.
  update: async ({ properties, physicalResourceId }) => {
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
  },

  remove: ({ physicalResourceId }) => {
    return deleteDocument({ id: physicalResourceId });
  },

  // Read the original source text (not the chunk-reconstructed content) so
  // `content` round-trips even under the `size` strategy, which joins
  // overlapping windows with newlines.
  fetch: async ({ physicalResourceId }) => {
    const doc = await getDocument({ id: physicalResourceId });
    if (!doc) return null;
    const sourceContent = await getDocumentSourceContent({
      id: physicalResourceId,
    });
    return { doc, sourceContent };
  },

  read: ({ doc, sourceContent }) => {
    return {
      content: sourceContent ?? doc.content,
      path: doc.path,
      filename: doc.filename,
      title: doc.title,
      metadata: doc.metadata,
      tags: doc.tags,
      chunk_strategy: doc.chunk_strategy,
      chunk_size: doc.chunk_size,
      chunk_overlap: doc.chunk_overlap,
    };
  },
});
