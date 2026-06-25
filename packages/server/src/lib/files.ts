import fs from 'node:fs';
import path from 'node:path';

import { db } from '../db';
import { DomainError } from '../errors';
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

/**
 * Derives the filename (download name) from a logical path: its last segment.
 * `/temas/report.txt` → `report.txt`. Returns undefined for an empty/null path.
 */
export const filenameFromPath = (p: string | null): string | undefined => {
  if (!p) return undefined;
  const segments = p.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : undefined;
};

const mapFile = (file: InstanceType<(typeof db)['File']>) => {
  return {
    id: file.publicId,
    // `path` is the file's key (its identity). `filename` is derived from it
    // (the last path segment) and is read-only. storageType / storagePath are
    // system-managed internals and are not exposed through the API.
    path: file.path ?? undefined,
    filename: filenameFromPath(file.path) ?? file.filename,
    contentType: file.contentType,
    size: file.size,
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

/**
 * Derives the storage category from a normalized path.
 * The category is the first path segment (e.g., `/traces/foo.json` → `traces`).
 * Falls back to `files` when the path has no sub-directory.
 */
const categoryFromPath = (normalizedPath: string | null): string => {
  if (!normalizedPath) return 'files';
  const segments = normalizedPath.split('/').filter(Boolean);
  return segments.length > 1 ? segments[0] : 'files';
};

export const uploadFile = async (args: {
  projectId: number;
  projectPublicId?: string;
  fileBuffer: Buffer;
  path?: string;
  /** The uploaded file's original name — used only to default the path when
   * `path` is omitted. The stored filename is always derived from the path. */
  originalName?: string;
  contentType?: string;
  metadata?: string;
}) => {
  const storageDir = getStorageDir();

  const normalizedPath =
    args.path !== undefined
      ? normalizePath(args.path)
      : args.originalName
        ? normalizePath(args.originalName)
        : null;

  const filename = filenameFromPath(normalizedPath) ?? args.originalName;

  const projectPublicId =
    args.projectPublicId ??
    (await resolveProjectPublicId({ projectId: args.projectId }));

  const category = categoryFromPath(normalizedPath);
  const fileStorageDir = path.join(storageDir, projectPublicId, category);
  fs.mkdirSync(fileStorageDir, { recursive: true });

  // Create DB record first to get publicId for the filename
  const file = await db.File.create({
    projectId: args.projectId,
    path: normalizedPath,
    filename,
    contentType: args.contentType,
    size: args.fileBuffer.length,
    storageType: 'local' as const,
    storagePath: '', // filled in below after we know the publicId
    metadata: args.metadata,
  });

  const ext = filename ? path.extname(filename) : '';
  const storagePath = path.join(fileStorageDir, `${file.publicId}${ext}`);
  fs.writeFileSync(storagePath, args.fileBuffer);

  await file.update({ storagePath, size: args.fileBuffer.length });

  const mapped = mapFile(file);

  emitEvent({
    type: 'files.created',
    projectId: args.projectId,
    projectPublicId,
    resourceType: 'file',
    resourceId: file.publicId,
    data: mapped as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return mapped;
};

/**
 * Upserts a file by path: if a file with the given (projectId, path) already
 * exists, overwrites the disk content and updates the DB record; otherwise
 * creates a new File record and writes the file to disk.
 *
 * This is an internal helper used by trace persistence.
 */
export const upsertFileByPath = async (args: {
  projectId: number;
  projectPublicId: string;
  path: string;
  fileBuffer: Buffer;
  contentType: string;
  filename?: string;
}) => {
  const storageDir = getStorageDir();
  const normalizedPath = normalizePath(args.path);
  const category = categoryFromPath(normalizedPath);
  const fileStorageDir = path.join(storageDir, args.projectPublicId, category);
  fs.mkdirSync(fileStorageDir, { recursive: true });

  const existing = await db.File.findOne({
    where: { projectId: args.projectId, path: normalizedPath },
  });

  if (existing) {
    // Overwrite on disk
    fs.writeFileSync(existing.storagePath, args.fileBuffer);
    await existing.update({
      size: args.fileBuffer.length,
      contentType: args.contentType,
    });
    return mapFile(existing);
  }

  // Create new record
  const filename = args.filename ?? path.basename(normalizedPath);
  const file = await db.File.create({
    projectId: args.projectId,
    path: normalizedPath,
    filename,
    contentType: args.contentType,
    size: args.fileBuffer.length,
    storageType: 'local' as const,
    storagePath: '',
  });

  const ext = path.extname(filename);
  const storagePath = path.join(fileStorageDir, `${file.publicId}${ext}`);
  fs.writeFileSync(storagePath, args.fileBuffer);
  await file.update({ storagePath });

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
    filename: filenameFromPath(file.path) ?? file.filename,
    contentType: file.contentType,
    size: file.size,
  };
};

export const updateFileMetadata = async (args: {
  id: string;
  metadata?: string;
  /** New logical path (key). Renaming a file means moving its key; the
   * filename follows the new path's last segment. */
  path?: string;
}) => {
  const file = await db.File.findOne({ where: { publicId: args.id } });

  if (!file) {
    return null;
  }

  const updates: Record<string, unknown> = {};
  if (args.metadata !== undefined) {
    updates.metadata = args.metadata;
  }
  if (args.path !== undefined) {
    const normalizedPath = normalizePath(args.path);
    updates.path = normalizedPath;
    updates.filename = filenameFromPath(normalizedPath);
  }

  try {
    await file.update(updates);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'SequelizeUniqueConstraintError'
    ) {
      throw new DomainError(
        'NAME_CONFLICT',
        `A file already exists at path '${normalizePath(args.path!)}' in this project.`
      );
    }
    throw error;
  }
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
  contentType?: string;
  size?: number;
  metadata?: string;
}) => {
  const normalizedPath =
    args.path !== undefined ? normalizePath(args.path) : null;
  // `path` is the file's key; `filename` is derived from it (its last segment).
  // Storage backend is system-managed (see FILES_STORAGE_DIR), not chosen by
  // the caller. A metadata-only record defaults to local storage with an empty
  // storagePath; the path is filled in when bytes are uploaded.
  const file = await db.File.create({
    projectId: args.projectId,
    path: normalizedPath,
    filename: filenameFromPath(normalizedPath),
    contentType: args.contentType,
    size: args.size,
    metadata: args.metadata,
    storageType: 'local' as const,
    storagePath: '',
  });
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

  const [traceCount, documentCount] = await Promise.all([
    db.Trace.count({ where: { fileId: file.id } }),
    db.Document.count({ where: { fileId: file.id } }),
  ]);

  if (traceCount > 0 || documentCount > 0) {
    throw new DomainError(
      'FILE_HAS_DEPENDENTS',
      `File '${file.publicId}' is referenced and cannot be deleted.`
    );
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
