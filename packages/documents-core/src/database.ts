import { models } from '@soat/postgresdb';

import type { DocumentRecord } from './types';

const parseMetadata = (
  metadata?: string
): Record<string, unknown> | undefined => {
  if (!metadata) return undefined;
  try {
    return JSON.parse(metadata);
  } catch {
    return undefined;
  }
};

const toDocumentRecord = (
  doc: InstanceType<typeof models.Document>
): DocumentRecord => {
  return {
    id: doc.id,
    title: doc.title,
    fileId: doc.fileId,
    embeddingModel: doc.embeddingModel,
    embeddingProvider: doc.embeddingProvider,
    embedding: doc.embedding,
    metadata: parseMetadata(doc.metadata),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

export const saveDocumentRecord = async (args: {
  id: string;
  title?: string;
  fileId: string;
  embeddingModel?: string;
  embeddingProvider?: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
}): Promise<DocumentRecord> => {
  const doc = await models.Document.create({
    ...args,
    metadata: args.metadata ? JSON.stringify(args.metadata) : undefined,
  } as Parameters<typeof models.Document.create>[0]);

  return toDocumentRecord(doc);
};

export const getDocumentRecord = async (
  id: string
): Promise<DocumentRecord | null> => {
  const doc = await models.Document.findByPk(id);
  if (!doc) return null;
  return toDocumentRecord(doc);
};

export const updateDocumentRecord = async (
  id: string,
  updates: Partial<
    Pick<
      DocumentRecord,
      | 'title'
      | 'embeddingModel'
      | 'embeddingProvider'
      | 'embedding'
      | 'metadata'
    >
  >
): Promise<DocumentRecord | null> => {
  const doc = await models.Document.findByPk(id);
  if (!doc) return null;

  const updateData: Partial<{
    title: string;
    embeddingModel: string;
    embeddingProvider: string;
    embedding: number[];
    metadata: string | null;
  }> = {};
  if (updates.title !== undefined) updateData.title = updates.title;
  if (updates.embeddingModel !== undefined)
    updateData.embeddingModel = updates.embeddingModel;
  if (updates.embeddingProvider !== undefined)
    updateData.embeddingProvider = updates.embeddingProvider;
  if (updates.embedding !== undefined) updateData.embedding = updates.embedding;
  if (updates.metadata !== undefined) {
    updateData.metadata = updates.metadata
      ? JSON.stringify(updates.metadata)
      : null;
  }

  await doc.update(updateData);
  return getDocumentRecord(id);
};

export const deleteDocumentRecord = async (id: string): Promise<boolean> => {
  const doc = await models.Document.findByPk(id);
  if (!doc) return false;
  await doc.destroy();
  return true;
};

export const listDocumentRecords = async (): Promise<DocumentRecord[]> => {
  const docs = await models.Document.findAll();
  return docs.map(toDocumentRecord);
};

export const getDocumentRecordByFileId = async (
  fileId: string
): Promise<DocumentRecord | null> => {
  const doc = await models.Document.findOne({ where: { fileId } });
  if (!doc) return null;
  return toDocumentRecord(doc);
};
