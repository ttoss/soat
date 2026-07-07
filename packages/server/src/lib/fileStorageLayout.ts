import path from 'node:path';

import type { db } from '../db';
import type { FileStorageProvider } from './fileStorage';

/**
 * Backend-agnostic logical location for a file's bytes:
 * `{projectPublicId}/{category}/{fileId}{ext}`. The storage provider turns this
 * into a concrete `storagePath` (an on-disk path for local, an object key for
 * s3).
 */
const buildObjectPath = (args: {
  projectPublicId: string;
  category: string;
  fileId: string;
  filename?: string | null;
}): string => {
  const ext = args.filename ? path.extname(args.filename) : '';
  return `${args.projectPublicId}/${args.category}/${args.fileId}${ext}`;
};

/**
 * Writes a file record's bytes through `provider` and records the resulting
 * `storagePath` and `size` back onto the row. Shared by upload and upsert so
 * the storage-location convention lives in one place.
 */
export const persistFileBytes = async (args: {
  provider: FileStorageProvider;
  file: InstanceType<(typeof db)['File']>;
  projectPublicId: string;
  category: string;
  buffer: Buffer;
  contentType?: string;
}) => {
  const { storagePath } = await args.provider.write({
    objectPath: buildObjectPath({
      projectPublicId: args.projectPublicId,
      category: args.category,
      fileId: args.file.publicId,
      filename: args.file.filename,
    }),
    buffer: args.buffer,
    contentType: args.contentType,
  });
  await args.file.update({
    storagePath,
    size: args.buffer.length,
    ...(args.contentType !== undefined
      ? { contentType: args.contentType }
      : {}),
  });
};
