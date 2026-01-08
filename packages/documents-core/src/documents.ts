import { generateEmbedding, type EmbeddingConfig } from '@soat/embeddings-core';
import {
  deleteFile,
  retrieveFileById,
  saveFile,
  type StorageConfig,
} from '@soat/files-core';
import { v4 as uuidv4 } from 'uuid';

import {
  deleteDocumentRecord,
  getDocumentRecord,
  getDocumentRecordByFileId,
  listDocumentRecords,
  saveDocumentRecord,
  updateDocumentRecord,
} from './database';
import type {
  CreateDocumentOptions,
  Document,
  DocumentRecord,
  SearchDocumentsOptions,
} from './types';

export const createDocument = async (args: {
  storageConfig: StorageConfig;
  embeddingConfig?: EmbeddingConfig;
  content: string;
  options?: CreateDocumentOptions;
}): Promise<Document> => {
  const { storageConfig, embeddingConfig, content, options } = args;
  const id = uuidv4();

  // Save content as markdown file
  const file = await saveFile({
    config: storageConfig,
    content,
    options: {
      contentType: 'text/markdown',
      metadata: {
        filename: `${id}.md`,
        documentId: id,
        ...options?.metadata,
      },
    },
  });

  let embeddingResult:
    | { embedding: number[]; model: string; provider: string }
    | undefined;

  // Generate embedding if config is provided and option is enabled (default: true)
  if (embeddingConfig && options?.generateEmbedding !== false) {
    const result = await generateEmbedding({
      config: embeddingConfig,
      text: content,
    });
    embeddingResult = {
      embedding: result.embedding,
      model: result.model,
      provider: result.provider,
    };
  }

  // Save document record
  const record = await saveDocumentRecord({
    id,
    title: options?.title,
    fileId: file.id,
    embeddingModel: embeddingResult?.model,
    embeddingProvider: embeddingResult?.provider,
    embedding: embeddingResult?.embedding,
    metadata: options?.metadata,
  });

  return {
    id: record.id,
    title: record.title,
    fileId: record.fileId,
    content,
    embeddingModel: record.embeddingModel,
    embeddingProvider: record.embeddingProvider,
    embedding: record.embedding,
    metadata: record.metadata,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
};

export const getDocument = async (args: {
  storageConfig: StorageConfig;
  id: string;
}): Promise<Document | null> => {
  const { storageConfig, id } = args;

  const record = await getDocumentRecord(id);
  if (!record) return null;

  const file = await retrieveFileById({
    config: storageConfig,
    id: record.fileId,
  });

  return {
    id: record.id,
    title: record.title,
    fileId: record.fileId,
    content: file?.content,
    embeddingModel: record.embeddingModel,
    embeddingProvider: record.embeddingProvider,
    embedding: record.embedding,
    metadata: record.metadata,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
};

export const updateDocument = async (args: {
  storageConfig: StorageConfig;
  embeddingConfig?: EmbeddingConfig;
  id: string;
  content?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  regenerateEmbedding?: boolean;
}): Promise<Document | null> => {
  const {
    storageConfig,
    embeddingConfig,
    id,
    content,
    title,
    metadata,
    regenerateEmbedding,
  } = args;

  const record = await getDocumentRecord(id);
  if (!record) return null;

  let newFileId = record.fileId;
  let embeddingResult:
    | { embedding: number[]; model: string; provider: string }
    | undefined;

  // Update content if provided
  if (content !== undefined) {
    // Delete old file
    await deleteFile({ config: storageConfig, id: record.fileId });

    // Save new file
    const newFile = await saveFile({
      config: storageConfig,
      content,
      options: {
        contentType: 'text/markdown',
        metadata: {
          filename: `${id}.md`,
          documentId: id,
          ...metadata,
        },
      },
    });
    newFileId = newFile.id;

    // Regenerate embedding if config is provided
    if (embeddingConfig && regenerateEmbedding !== false) {
      const result = await generateEmbedding({
        config: embeddingConfig,
        text: content,
      });
      embeddingResult = {
        embedding: result.embedding,
        model: result.model,
        provider: result.provider,
      };
    }
  }

  // Update document record
  const updatedRecord = await updateDocumentRecord(id, {
    title,
    embeddingModel: embeddingResult?.model,
    embeddingProvider: embeddingResult?.provider,
    embedding: embeddingResult?.embedding,
    metadata,
  });

  if (!updatedRecord) return null;

  // Get updated content
  const file = await retrieveFileById({
    config: storageConfig,
    id: newFileId,
  });

  return {
    id: updatedRecord.id,
    title: updatedRecord.title,
    fileId: newFileId,
    content: file?.content,
    embeddingModel: updatedRecord.embeddingModel,
    embeddingProvider: updatedRecord.embeddingProvider,
    embedding: updatedRecord.embedding,
    metadata: updatedRecord.metadata,
    createdAt: updatedRecord.createdAt,
    updatedAt: updatedRecord.updatedAt,
  };
};

export const deleteDocument = async (args: {
  storageConfig: StorageConfig;
  id: string;
}): Promise<boolean> => {
  const { storageConfig, id } = args;

  const record = await getDocumentRecord(id);
  if (!record) return false;

  // Delete file
  await deleteFile({ config: storageConfig, id: record.fileId });

  // Delete document record
  return deleteDocumentRecord(id);
};

export const listDocuments = async (): Promise<DocumentRecord[]> => {
  return listDocumentRecords();
};

export const searchDocumentsBySimilarity = async (args: {
  storageConfig: StorageConfig;
  embeddingConfig: EmbeddingConfig;
  query: string;
  options?: SearchDocumentsOptions;
}): Promise<Document[]> => {
  const { storageConfig, embeddingConfig, query, options } = args;
  const limit = options?.limit ?? 10;

  // Generate embedding for query
  const queryEmbedding = await generateEmbedding({
    config: embeddingConfig,
    text: query,
  });

  // Get all documents with embeddings
  const records = await listDocumentRecords();
  const documentsWithEmbeddings = records.filter(
    (r) => r.embedding && r.embedding.length > 0
  );

  // Calculate cosine similarity
  const similarities = documentsWithEmbeddings.map((record) => {
    const similarity = cosineSimilarity(
      queryEmbedding.embedding,
      record.embedding!
    );
    return { record, similarity };
  });

  // Sort by similarity and take top results
  similarities.sort((a, b) => b.similarity - a.similarity);
  const topResults = similarities.slice(0, limit);

  // Filter by threshold if provided
  const filteredResults = options?.threshold
    ? topResults.filter((r) => r.similarity >= options.threshold!)
    : topResults;

  // Fetch content for each document
  const documents: Document[] = [];
  for (const { record } of filteredResults) {
    const file = await retrieveFileById({
      config: storageConfig,
      id: record.fileId,
    });

    documents.push({
      id: record.id,
      title: record.title,
      fileId: record.fileId,
      content: file?.content,
      embeddingModel: record.embeddingModel,
      embeddingProvider: record.embeddingProvider,
      embedding: record.embedding,
      metadata: record.metadata,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  return documents;
};

const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (normA * normB);
};
