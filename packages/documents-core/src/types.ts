import type { StorageConfig, UploadOptions } from '@soat/files-core';

export interface Document {
  id: string;
  content: string | Buffer;
  metadata?: Record<string, unknown>;
}

export type { StorageConfig, UploadOptions };
