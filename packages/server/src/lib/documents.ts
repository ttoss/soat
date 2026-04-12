import fs from 'node:fs';
import path from 'node:path';

import { Op } from '@ttoss/postgresdb';

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
    title: doc.title ?? undefined,
    metadata: doc.metadata
      ? (() => {
          try {
            return JSON.parse(doc.metadata!);
          } catch {
            return doc.metadata;
          }
        })()
      : undefined,
    tags: doc.tags ?? undefined,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

export const listDocuments = async (args: {
  projectIds?: number[];
  limit?: number;
  offset?: number;
}) => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return { data: [], total: 0, limit, offset };
  }

  const fileWhere =
    args.projectIds !== undefined ? { projectId: args.projectIds } : undefined;

  const { count, rows } = await db.Document.findAndCountAll({
    distinct: true,
    include: [
      {
        model: db.File,
        as: 'file',
        where: fileWhere,
        include: [{ model: db.Project, as: 'project' }],
      },
    ],
    limit,
    offset,
  });
  return { data: rows.map(mapDocument), total: count, limit, offset };
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
  title?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
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
    title: args.title ?? null,
    metadata: args.metadata ? JSON.stringify(args.metadata) : null,
    tags: args.tags ?? null,
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

export const updateDocument = async (args: {
  id: string;
  content?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}) => {
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

  if (args.content !== undefined && doc.file?.storagePath) {
    fs.writeFileSync(doc.file.storagePath, args.content, 'utf-8');
    await doc.file.update({
      size: Buffer.byteLength(args.content, 'utf-8'),
    });
    const embedding = await getEmbedding({ text: args.content });
    await doc.update({ embedding });
  }

  const updates: Record<string, unknown> = {};
  if (args.title !== undefined) updates.title = args.title;
  if (args.metadata !== undefined)
    updates.metadata = JSON.stringify(args.metadata);
  if (args.tags !== undefined) updates.tags = args.tags;
  if (Object.keys(updates).length > 0) {
    await doc.update(updates);
  }

  const refreshed = await db.Document.findOne({
    where: { id: doc.id },
    include: [
      {
        model: db.File,
        as: 'file',
        include: [{ model: db.Project, as: 'project' }],
      },
    ],
  });

  return mapDocument(refreshed!);
};

export const searchDocuments = async (args: {
  projectIds?: number[];
  query: string;
  limit?: number;
  threshold?: number;
  tags?: string[];
}) => {
  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return [];
  }

  const embedding = await getEmbedding({ text: args.query });
  const limit = args.limit ?? 10;
  const embeddingLiteral = `[${embedding.join(',')}]`;

  const fileWhere =
    args.projectIds !== undefined ? { projectId: args.projectIds } : undefined;

  const docWhere: Record<string, unknown> =
    args.tags && args.tags.length > 0
      ? { tags: { [Op.overlap]: args.tags } }
      : {};

  const documents = await db.Document.findAll({
    where: docWhere,
    attributes: {
      include: [
        [
          db.Document.sequelize!.literal(`embedding <=> '${embeddingLiteral}'`),
          'distance',
        ],
      ],
    },
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

  return documents
    .map((doc) => {
      const distance = parseFloat(
        (doc.getDataValue('distance') as string) ?? '1'
      );
      const score = 1 - distance;
      const mapped = mapDocument(doc);

      let content: string | null = null;
      if (doc.file?.storagePath && fs.existsSync(doc.file.storagePath)) {
        content = fs.readFileSync(doc.file.storagePath, 'utf-8');
      }

      return { ...mapped, content, score };
    })
    .filter((doc) => {
      if (args.threshold !== undefined) {
        return doc.score >= args.threshold;
      }
      return true;
    });
};
