import { promises as fs } from 'node:fs';

import { v4 as uuidv4 } from 'uuid';

import { deleteFileRecord, getFileRecord, saveFileRecord } from './database';
import * as gcs from './storage/gcs';
import * as local from './storage/local';
import * as s3 from './storage/s3';
import type { FileData, StorageConfig, UploadOptions } from './types';

const getStorage = (args: { config: StorageConfig }) => {
  const { config } = args;
  switch (config.type) {
    case 'local':
      return local;
    case 's3':
      return s3;
    case 'gcs':
      return gcs;
    default:
      throw new Error(`Unsupported storage type: ${config.type}`);
  }
};

export const saveFile = async (args: {
  config: StorageConfig;
  content: string | Buffer;
  options?: UploadOptions;
}): Promise<FileData> => {
  const { config, content, options } = args;
  const id = uuidv4();
  const storage = getStorage({ config });
  await storage.save({ id, content, config });

  // Save file record to database
  await saveFileRecord({
    id,
    contentType: options?.contentType,
    size: Buffer.isBuffer(content)
      ? content.length
      : Buffer.byteLength(content),
    storageType: config.type,
    storagePath: id,
    metadata: options?.metadata,
  });

  return { id, content };
};

export const uploadFile = async (args: {
  config: StorageConfig;
  filePath: string;
  options?: UploadOptions;
}): Promise<FileData> => {
  const { config, filePath, options } = args;
  const content = await fs.readFile(filePath);
  const filename =
    (options?.metadata?.filename as string) || filePath.split('/').pop();
  return saveFile({
    config,
    content,
    options: { ...options, metadata: { ...options?.metadata, filename } },
  });
};

export const retrieveFileById = async (args: {
  config: StorageConfig;
  id: string;
}): Promise<FileData | null> => {
  const { config, id } = args;
  try {
    const storage = getStorage({ config });
    const content = await storage.retrieve({ id, config });
    return { id, content };
  } catch {
    return null;
  }
};

export const deleteFile = async (args: {
  config: StorageConfig;
  id: string;
}): Promise<boolean> => {
  const { config, id } = args;

  // Delete from storage
  const storage = getStorage({ config });
  await storage.deleteFile({ id, config });

  // Delete from database
  return deleteFileRecord(id);
};
