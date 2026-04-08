import { db } from '../db';

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

  await file.destroy();
  return true;
};
