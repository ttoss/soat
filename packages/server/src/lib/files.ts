import fs from 'node:fs';
import path from 'node:path';

import { db } from '../db';
import { emitEvent, resolveProjectPublicId } from './eventBus';
import {
  type CompiledPolicy,
  compilePolicy,
  registerResourceFieldMap,
} from './policyCompiler';

export type { CompiledPolicy };

registerResourceFieldMap({
  resourceType: 'file',
  publicIdColumn: { column: 'publicId' },
  pathColumn: { column: 'path' },
  tagsColumn: { column: 'tags' },
});

const getStorageDir = () => {
  const dir = process.env.FILES_STORAGE_DIR;
  if (!dir) {
    throw new Error('FILES_STORAGE_DIR environment variable is not set');
  }
  return dir;
};

export const normalizePath = (p: string): string => {
  let normalized = p.trim();
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }
  // Collapse multiple slashes
  normalized = normalized.replace(/\/+/g, '/');
  // Resolve . and ..
  const parts = normalized.split('/').filter(Boolean);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      if (resolved.length === 0) {
        throw new Error('Path traversal above root is not allowed');
      }
      resolved.pop();
    } else if (part !== '.') {
      resolved.push(part);
    }
  }
  // Strip trailing slash (but keep root /)
  const result = '/' + resolved.join('/');
  return result;
};

const mapFile = (file: InstanceType<(typeof db)['File']>) => {
  return {
    id: file.publicId,
    path: file.path ?? undefined,
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    storageType: file.storageType,
    storagePath: file.storagePath,
    metadata: file.metadata,
    tags: file.tags ?? undefined,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
};

export const listFiles = async (args: {
  projectIds?: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyWhere?: Record<string, any>;
  limit?: number;
  offset?: number;
}) => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return { data: [], total: 0, limit, offset };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};

  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  if (args.policyWhere && Object.keys(args.policyWhere).length > 0) {
    Object.assign(where, args.policyWhere);
  }

  const { count, rows } = await db.File.findAndCountAll({
    where: Object.keys(where).length > 0 ? where : undefined,
    limit,
    offset,
  });
  return { data: rows.map(mapFile), total: count, limit, offset };
};

export { compilePolicy };

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
  path?: string;
  filename?: string;
  contentType?: string;
  metadata?: string;
}) => {
  const storageDir = getStorageDir();
  fs.mkdirSync(storageDir, { recursive: true });

  const normalizedPath =
    args.path !== undefined
      ? normalizePath(args.path)
      : args.filename
        ? normalizePath(args.filename)
        : null;

  // Create DB record first to get publicId for the filename
  const file = await db.File.create({
    projectId: args.projectId,
    path: normalizedPath,
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

  const mapped = mapFile(file);

  resolveProjectPublicId({ projectId: args.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'files.created',
        projectId: args.projectId,
        projectPublicId,
        resourceType: 'file',
        resourceId: file.publicId,
        data: mapped as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      });
    }
  );

  return mapped;
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
  metadata?: string;
  filename?: string;
}) => {
  const file = await db.File.findOne({ where: { publicId: args.id } });

  if (!file) {
    return null;
  }

  const updates: Record<string, unknown> = {};
  if (args.metadata !== undefined) {
    updates.metadata = args.metadata;
  }
  if (args.filename !== undefined) {
    updates.filename = args.filename;
  }

  await file.update(updates);
  const mapped = mapFile(file);

  resolveProjectPublicId({ projectId: file.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'files.updated',
        projectId: file.projectId,
        projectPublicId,
        resourceType: 'file',
        resourceId: file.publicId,
        data: mapped as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      });
    }
  );

  return mapped;
};

export const createFile = async (args: {
  projectId: number;
  path?: string;
  filename?: string;
  contentType?: string;
  size?: number;
  storageType: 'local' | 's3' | 'gcs';
  storagePath: string;
  metadata?: string;
}) => {
  const normalizedPath =
    args.path !== undefined
      ? normalizePath(args.path)
      : args.filename
        ? normalizePath(args.filename)
        : null;
  const file = await db.File.create({ ...args, path: normalizedPath });
  const mapped = mapFile(file);

  resolveProjectPublicId({ projectId: args.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'files.created',
        projectId: args.projectId,
        projectPublicId,
        resourceType: 'file',
        resourceId: file.publicId,
        data: mapped as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      });
    }
  );

  return mapped;
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

  const filePublicId = file.publicId;
  const fileProjectId = file.projectId;

  await file.destroy();

  resolveProjectPublicId({ projectId: fileProjectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'files.deleted',
        projectId: fileProjectId,
        projectPublicId,
        resourceType: 'file',
        resourceId: filePublicId,
        data: { id: filePublicId },
        timestamp: new Date().toISOString(),
      });
    }
  );

  return true;
};

export const getFileTags = async (args: { id: string }) => {
  const file = await db.File.findOne({ where: { publicId: args.id } });

  if (!file) {
    return null;
  }

  return file.tags ?? {};
};

export const updateFileTags = async (args: {
  id: string;
  tags: Record<string, string>;
  merge?: boolean;
}) => {
  const file = await db.File.findOne({ where: { publicId: args.id } });

  if (!file) {
    return null;
  }

  const newTags = args.merge
    ? { ...(file.tags ?? {}), ...args.tags }
    : args.tags;
  await file.update({ tags: newTags });

  const mapped = { ...mapFile(file), tags: newTags };

  resolveProjectPublicId({ projectId: file.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'files.updated',
        projectId: file.projectId,
        projectPublicId,
        resourceType: 'file',
        resourceId: file.publicId,
        data: mapped as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      });
    }
  );

  return mapped;
};
