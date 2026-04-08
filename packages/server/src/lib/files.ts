import fs from 'node:fs';
import path from 'node:path';

import { db } from '../db';

const getStorageDir = () => {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const dir = process.env.FILES_STORAGE_DIR;
  if (!dir) {
    throw new Error('FILES_STORAGE_DIR environment variable is not set');
  }
  return dir;
};

const mapFile = (file: InstanceType<(typeof db)['File']>) => {
  return {
    id: file.publicId,
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

export const listFiles = async () => {
  const allFiles = await db.File.findAll();
  return allFiles.map(mapFile);
};

export const getFile = async (args: { id: string }) => {
  const file = await db.File.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  if (!file) {
    return null;
  }

  return {
    ...mapFile(file),
    projectId: file.project?.publicId,
  };
};

export const uploadFile = async (args: {
  projectId: number;
  fileBuffer: Buffer;
  filename?: string;
  contentType?: string;
  metadata?: string;
}) => {
  const storageDir = getStorageDir();
  fs.mkdirSync(storageDir, { recursive: true });

  // Create DB record first to get publicId for the filename
  const file = await db.File.create({
    projectId: args.projectId,
    filename: args.filename,
    contentType: args.contentType,
    size: args.fileBuffer.length,
    storageType: 'local' as const,
    storagePath: '', // filled in below after we know the publicId
    metadata: args.metadata,
  });

  const ext = args.filename ? path.extname(args.filename) : '';
  const storagePath = path.join(storageDir, `${file.publicId}${ext}`);
  fs.writeFileSync(storagePath, args.fileBuffer);

  await file.update({ storagePath, size: args.fileBuffer.length });

  return mapFile(file);
};

export const downloadFile = async (args: { id: string }) => {
  const file = await db.File.findOne({ where: { publicId: args.id } });

  if (!file) {
    return null;
  }

  if (file.storageType !== 'local') {
    throw new Error(
      `Storage type '${file.storageType}' download not supported`
    );
  }

  if (!fs.existsSync(file.storagePath)) {
    return null;
  }

  return {
    stream: fs.createReadStream(file.storagePath),
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
  };
};

export const updateFileMetadata = async (args: {
  id: string;
  metadata: string;
}) => {
  const file = await db.File.findOne({ where: { publicId: args.id } });

  if (!file) {
    return null;
  }

  await file.update({ metadata: args.metadata });
  return mapFile(file);
};

export const createFile = async (args: {
  projectId: number;
  filename?: string;
  contentType?: string;
  size?: number;
  storageType: 'local' | 's3' | 'gcs';
  storagePath: string;
  metadata?: string;
}) => {
  const file = await db.File.create(args);
  return mapFile(file);
};

export const deleteFile = async (args: { id: string }) => {
  const file = await db.File.findOne({ where: { publicId: args.id } });

  if (!file) {
    return null;
  }

  if (file.storageType === 'local' && file.storagePath) {
    try {
      fs.unlinkSync(file.storagePath);
    } catch {
      // Ignore missing file errors — record may still need to be cleaned up
    }
  }

  await file.destroy();
  return true;
};
