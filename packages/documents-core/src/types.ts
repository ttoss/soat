import type { EmbeddingConfig } from '@soat/embeddings-core';
import type { StorageConfig, UploadOptions } from '@soat/files-core';

export interface Document {
  id: string;
  title?: string;
  fileId: string;
  content?: string | Buffer;
  embeddingModel?: string;
  embeddingProvider?: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface DocumentRecord {
  id: string;
  title?: string;
  fileId: string;
  embeddingModel?: string;
  embeddingProvider?: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDocumentOptions {
  title?: string;
  metadata?: Record<string, unknown>;
  generateEmbedding?: boolean;
}

export interface SearchDocumentsOptions {
  limit?: number;
  threshold?: number;
}

export type { EmbeddingConfig, StorageConfig, UploadOptions };
