import fs from 'node:fs';
import path from 'node:path';

import { db } from '../db';
import { getEmbedding } from './embedding';

const getStorageDir = () => {
  const dir = process.env.FILES_STORAGE_DIR;
  if (!dir) {
    throw new Error('FILES_STORAGE_DIR environment variable is not set');
  }
  return dir;
};

const mapDocument = (
  doc: InstanceType<(typeof db)['Document']> & {
    file?: InstanceType<(typeof db)['File']> & {
      project?: InstanceType<(typeof db)['Project']>;
    };
  }
) => {
  return {
    id: doc.publicId,
    fileId: doc.file?.publicId,
    projectId: doc.file?.project?.publicId,
    filename: doc.file?.filename,
    size: doc.file?.size,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

export const listDocuments = async (args: { projectIds?: number[] }) => {
  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return [];
  }

  const fileWhere =
    args.projectIds !== undefined ? { projectId: args.projectIds } : undefined;

  const documents = await db.Document.findAll({
    include: [
      {
        model: db.File,
        as: 'file',
        where: fileWhere,
        include: [{ model: db.Project, as: 'project' }],
      },
    ],
  });
  return documents.map(mapDocument);
};

export const getDocument = async (args: { id: string }) => {
  const doc = await db.Document.findOne({
    where: { publicId: args.id },
    include: [
      {
        model: db.File,
        as: 'file',
        include: [{ model: db.Project, as: 'project' }],
      },
    ],
  });

  if (!doc) {
    return null;
  }

  const mapped = mapDocument(doc);

  if (doc.file?.storagePath && fs.existsSync(doc.file.storagePath)) {
    const content = fs.readFileSync(doc.file.storagePath, 'utf-8');
    return { ...mapped, content };
  }

  return { ...mapped, content: null };
};

export const createDocument = async (args: {
  projectId: number;
  content: string;
  filename?: string;
}) => {
  const storageDir = getStorageDir();
  fs.mkdirSync(storageDir, { recursive: true });

  const file = await db.File.create({
    projectId: args.projectId,
    filename: args.filename ?? 'document.txt',
    contentType: 'text/plain',
    size: Buffer.byteLength(args.content, 'utf-8'),
    storageType: 'local' as const,
    storagePath: '',
  });

  const storagePath = path.join(storageDir, `${file.publicId}.txt`);
  fs.writeFileSync(storagePath, args.content, 'utf-8');
  await file.update({
    storagePath,
    size: Buffer.byteLength(args.content, 'utf-8'),
  });

  const embedding = await getEmbedding({ text: args.content });

  const doc = await db.Document.create({
    fileId: file.id,
    embedding,
  });

  const created = await db.Document.findOne({
    where: { id: doc.id },
    include: [
      {
        model: db.File,
        as: 'file',
        include: [{ model: db.Project, as: 'project' }],
      },
    ],
  });

  return mapDocument(created!);
};

export const deleteDocument = async (args: { id: string }) => {
  const doc = await db.Document.findOne({
    where: { publicId: args.id },
    include: [{ model: db.File, as: 'file' }],
  });

  if (!doc) {
    return null;
  }

  if (doc.file?.storagePath) {
    try {
      fs.unlinkSync(doc.file.storagePath);
    } catch {
      // Ignore missing file errors
    }
  }

  await doc.destroy();
  if (doc.file) {
    await doc.file.destroy();
  }

  return true;
};

export const searchDocuments = async (args: {
  projectIds?: number[];
  query: string;
  limit?: number;
}) => {
  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return [];
  }

  const embedding = await getEmbedding({ text: args.query });
  const limit = args.limit ?? 10;
  const embeddingLiteral = `[${embedding.join(',')}]`;

  const fileWhere =
    args.projectIds !== undefined ? { projectId: args.projectIds } : undefined;

  const documents = await db.Document.findAll({
    include: [
      {
        model: db.File,
        as: 'file',
        where: fileWhere,
        include: [{ model: db.Project, as: 'project' }],
      },
    ],
    order: db.Document.sequelize!.literal(
      `embedding <=> '${embeddingLiteral}'`
    ),
    limit,
  });

  return documents.map(mapDocument);
};
