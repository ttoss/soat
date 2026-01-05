import {
  retrieveFileById,
  saveFile,
  uploadFile as uploadFileCore,
} from '@soat/files-core';

import type { Document, UploadOptions } from './types';

export const saveDocument = async (
  config: import('@soat/files-core').StorageConfig,
  content: string | Buffer,
  metadata?: Record<string, unknown>
): Promise<Document> => {
  const fileData = await saveFile(config, content);
  return { id: fileData.id, content: fileData.content, metadata };
};

export const uploadFile = async (
  config: import('@soat/files-core').StorageConfig,
  filePath: string,
  options?: UploadOptions
): Promise<Document> => {
  const fileData = await uploadFileCore(config, filePath, options);
  return {
    id: fileData.id,
    content: fileData.content,
    metadata: options?.metadata,
  };
};

export const retrieveDocumentById = async (
  config: import('@soat/files-core').StorageConfig,
  id: string
): Promise<Document | null> => {
  const fileData = await retrieveFileById(config, id);
  if (!fileData) return null;
  return { id: fileData.id, content: fileData.content };
};
