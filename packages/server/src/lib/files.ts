import { db } from '../db';

export const listFiles = async () => {
  const allFiles = await db.File.findAll();
  return allFiles.map((file) => {
    return {
      id: file.id,
      filename: file.filename,
      contentType: file.contentType,
      size: file.size,
      storageType: file.storageType,
      storagePath: file.storagePath,
      metadata: file.metadata,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    };
  });
};

export const getFile = async (args: { id: string }) => {
  const file = await db.File.findByPk(args.id);

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
    metadata: file.metadata,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
};

export const createFile = async (args: {
  filename?: string;
  contentType?: string;
  size?: number;
  storageType: 'local' | 's3' | 'gcs';
  storagePath: string;
  metadata?: string;
}) => {
  const file = await db.File.create(args);

  return {
    id: file.id,
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    storageType: file.storageType,
    storagePath: file.storagePath,
    metadata: file.metadata,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
};

export const deleteFile = async (args: { id: string }) => {
  const file = await db.File.findByPk(args.id);

  if (!file) {
    return null;
  }

  await file.destroy();
  return true;
};
