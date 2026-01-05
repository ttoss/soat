import { models } from './db';
import type { FileRecord, StorageConfig, UploadOptions } from './types';

export const saveFileRecord = async (args: {
  id: string;
  filename?: string;
  contentType?: string;
  size?: number;
  storageType: StorageConfig['type'];
  storagePath: string;
  metadata?: Record<string, unknown>;
}): Promise<FileRecord> => {
  const file = await models.File.create(args as any);

  return {
    id: file.id,
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    storageType: file.storageType,
    storagePath: file.storagePath,
    metadata: file.metadata ? JSON.parse(file.metadata) : undefined,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
};

export const getFileRecord = async (id: string): Promise<FileRecord | null> => {
  const file = await models.File.findByPk(id);

  if (!file) {
    return null;
  }

  return {
    id: file.id,
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    storageType: file.storageType,
    storagePath: file.storagePath,
    metadata: file.metadata ? JSON.parse(file.metadata) : undefined,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
};

export const updateFileRecord = async (
  id: string,
  updates: Partial<
    Pick<FileRecord, 'filename' | 'contentType' | 'size' | 'metadata'>
  >
): Promise<FileRecord | null> => {
  const file = await models.File.findByPk(id);

  if (!file) {
    return null;
  }

  const updateData: any = {};
  if (updates.filename !== undefined) updateData.filename = updates.filename;
  if (updates.contentType !== undefined)
    updateData.contentType = updates.contentType;
  if (updates.size !== undefined) updateData.size = updates.size;
  if (updates.metadata !== undefined) {
    updateData.metadata = updates.metadata
      ? JSON.stringify(updates.metadata)
      : null;
  }

  await file.update(updateData);

  return getFileRecord(id);
};

export const deleteFileRecord = async (id: string): Promise<boolean> => {
  const file = await models.File.findByPk(id);

  if (!file) {
    return false;
  }

  await file.destroy();
  return true;
};

export const listFileRecords = async (): Promise<FileRecord[]> => {
  const files = await models.File.findAll();

  return files.map((file) => {
    return {
      id: file.id,
      filename: file.filename,
      contentType: file.contentType,
      size: file.size,
      storageType: file.storageType,
      storagePath: file.storagePath,
      metadata: file.metadata ? JSON.parse(file.metadata) : undefined,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    };
  });
};
