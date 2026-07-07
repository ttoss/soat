import path from 'node:path';

import { db } from '../db';
import { DomainError } from '../errors';
import { emitEvent, resolveProjectPublicId } from './eventBus';
import {
  buildPath,
  filenameFromPath,
  normalizePath,
  prefixFromPath,
  rebuildKey,
} from './filePaths';
import { getActiveStorageProvider, getStorageProvider } from './fileStorage';
import { persistFileBytes } from './fileStorageLayout';
import {
  type CompiledPolicy,
  compilePolicy,
  registerResourceFieldMap,
} from './policyCompiler';

export type { CompiledPolicy };
// Re-export the path helpers so existing importers (`from './files'`) keep
// working; the definitions live in ./filePaths.
export { buildPath, filenameFromPath, normalizePath, prefixFromPath };

registerResourceFieldMap({
  resourceType: 'file',
  publicIdColumn: { column: 'publicId' },
  pathColumn: { column: 'path' },
  tagsColumn: { column: 'tags' },
});

const mapFile = (file: InstanceType<(typeof db)['File']>) => {
  return {
    id: file.publicId,
    // `path` is the full key (read-only): `prefix` + `/` + `filename`.
    // `prefix` is its directory, `filename` its leaf / download name.
    // storageType / storagePath are system-managed internals, not exposed.
    prefix: prefixFromPath(file.path),
    filename: file.filename ?? filenameFromPath(file.path),
    path: file.path ?? undefined,
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
  /** Directory prefix (defaults to `/`). The key is `prefix` + `/` + filename. */
  prefix?: string;
  /** The original filename (download name) and the key's leaf segment. */
  filename?: string;
  /** Internal: a pre-built full path (key), used by the upload-token flow.
   * Takes precedence over prefix/filename. */
  path?: string;
  contentType?: string;
  metadata?: string;
}) => {
  const provider = getActiveStorageProvider();

  const normalizedPath =
    args.path !== undefined
      ? normalizePath(args.path)
      : buildPath({ prefix: args.prefix, filename: args.filename });

  const filename = args.filename ?? filenameFromPath(normalizedPath);

  const projectPublicId =
    args.projectPublicId ??
    (await resolveProjectPublicId({ projectId: args.projectId }));

  const category = categoryFromPath(normalizedPath);

  // Create DB record first to get publicId for the storage location.
  let file;
  try {
    file = await db.File.create({
      projectId: args.projectId,
      path: normalizedPath,
      filename,
      contentType: args.contentType,
      size: args.fileBuffer.length,
      storageType: provider.storageType,
      storagePath: '', // filled in below after we know the publicId
      metadata: args.metadata,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'SequelizeUniqueConstraintError'
    ) {
      throw new DomainError(
        'NAME_CONFLICT',
        `A file already exists at that path in this project.`
      );
    }
    throw error;
  }

  await persistFileBytes({
    provider,
    file,
    projectPublicId,
    category,
    buffer: args.fileBuffer,
    contentType: args.contentType,
  });

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
  const normalizedPath = normalizePath(args.path);
  const category = categoryFromPath(normalizedPath);

  const existing = await db.File.findOne({
    where: { projectId: args.projectId, path: normalizedPath },
  });

  if (existing) {
    // Overwrite in place, on whichever backend already stores this file.
    await persistFileBytes({
      provider: getStorageProvider({ storageType: existing.storageType }),
      file: existing,
      projectPublicId: args.projectPublicId,
      category,
      buffer: args.fileBuffer,
      contentType: args.contentType,
    });
    return mapFile(existing);
  }

  // Create new record on the active backend.
  const provider = getActiveStorageProvider();
  const filename = args.filename ?? path.basename(normalizedPath);
  const file = await db.File.create({
    projectId: args.projectId,
    path: normalizedPath,
    filename,
    contentType: args.contentType,
    size: args.fileBuffer.length,
    storageType: provider.storageType,
    storagePath: '',
  });

  await persistFileBytes({
    provider,
    file,
    projectPublicId: args.projectPublicId,
    category,
    buffer: args.fileBuffer,
    contentType: args.contentType,
  });

  return mapFile(file);
};

export const downloadFile = async (args: { id: string }) => {
  const file = await db.File.findOne({ where: { publicId: args.id } });

  if (!file) {
    return null;
  }

  const provider = getStorageProvider({ storageType: file.storageType });
  const object = await provider.read({ storagePath: file.storagePath });

  if (!object) {
    return null;
  }

  return {
    stream: object.stream,
    filename: file.filename ?? filenameFromPath(file.path),
    contentType: file.contentType,
    size: file.size ?? object.size,
  };
};

export const updateFileMetadata = async (args: {
  id: string;
  metadata?: string;
  /** New directory prefix — moves the file (the key's directory changes). */
  prefix?: string;
  /** New filename — renames the key's leaf and the download name. */
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
  // `path` is the full key, rebuilt from prefix + filename. Changing either
  // recomputes it (and moves/renames the file accordingly).
  if (args.prefix !== undefined || args.filename !== undefined) {
    const rebuilt = rebuildKey({
      currentPath: file.path,
      currentFilename: file.filename,
      prefix: args.prefix,
      filename: args.filename,
    });
    updates.path = rebuilt.path;
    updates.filename = rebuilt.filename;
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
        `A file already exists at that path in this project.`
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
  prefix?: string;
  filename?: string;
  contentType?: string;
  size?: number;
  metadata?: string;
}) => {
  // The full key (`path`) is built from `prefix` (directory, defaults to `/`)
  // and `filename`. Storage backend is system-managed (see the active storage
  // provider); a metadata-only record records the active backend's storageType
  // with an empty storagePath, filled in when bytes are uploaded.
  const normalizedPath = buildPath({
    prefix: args.prefix,
    filename: args.filename,
  });
  const provider = getActiveStorageProvider();
  let file;
  try {
    file = await db.File.create({
      projectId: args.projectId,
      path: normalizedPath,
      filename: args.filename ?? filenameFromPath(normalizedPath),
      contentType: args.contentType,
      size: args.size,
      metadata: args.metadata,
      storageType: provider.storageType,
      storagePath: '',
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'SequelizeUniqueConstraintError'
    ) {
      throw new DomainError(
        'NAME_CONFLICT',
        `A file already exists at that path in this project.`
      );
    }
    throw error;
  }
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

  if (file.storagePath) {
    const provider = getStorageProvider({ storageType: file.storageType });
    await provider.delete({ storagePath: file.storagePath });
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
