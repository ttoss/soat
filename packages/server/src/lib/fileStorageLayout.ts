import path from 'node:path';

import type { db } from '../db';
import type { FileStorageProvider } from './fileStorage';

declare const storageObjectPathBrand: unique symbol;

/**
 * A logical object location that has been through `buildObjectPath`.
 *
 * `FileStorageProvider.write` accepts nothing else, so the layout below is the
 * only shape any backend can ever be handed — a new provider (GCS, Azure) and a
 * new module inherit it without opting in. A hand-rolled key is a compile
 * error, which is what keeps a second convention from appearing the way one did
 * in the document writers.
 */
export type StorageObjectPath = string & {
  readonly [storageObjectPathBrand]: true;
};

/**
 * The category segment for a file at `normalizedPath`: its leading directory,
 * or `files` for a root-level file. Shared with the layout so a caller cannot
 * bucket its objects differently from the path it recorded on the row.
 */
export const categoryFromPath = (normalizedPath: string | null): string => {
  if (!normalizedPath) return 'files';
  const segments = normalizedPath.split('/').filter(Boolean);
  return segments.length > 1 ? segments[0] : 'files';
};

/**
 * Backend-agnostic logical location for a file's bytes:
 * `{projectPublicId}/{category}/{fileId}{ext}`. The storage provider turns this
 * into a concrete `storagePath` (an on-disk path for local, an object key for
 * s3).
 *
 * `extension` overrides the one derived from `filename` for a writer whose
 * bytes are not the file's download name — a document's stored object is always
 * UTF-8 text, even when the document is named after the binary it came from.
 */
export const buildObjectPath = (args: {
  projectPublicId: string;
  category: string;
  fileId: string;
  filename?: string | null;
  extension?: string;
}): StorageObjectPath => {
  const ext =
    args.extension ?? (args.filename ? path.extname(args.filename) : '');
  const objectPath = `${args.projectPublicId}/${args.category}/${args.fileId}${ext}`;
  return objectPath as StorageObjectPath;
};

/**
 * Writes a file record's bytes through `provider` and records the resulting
 * `storagePath` and `size` back onto the row. Every writer goes through here so
 * the row never disagrees with where the bytes actually landed.
 */
export const persistFileBytes = async (args: {
  provider: FileStorageProvider;
  file: InstanceType<(typeof db)['File']>;
  projectPublicId: string;
  category: string;
  buffer: Buffer;
  contentType?: string;
  extension?: string;
}) => {
  const { storagePath } = await args.provider.write({
    objectPath: buildObjectPath({
      projectPublicId: args.projectPublicId,
      category: args.category,
      fileId: args.file.publicId,
      filename: args.file.filename,
      extension: args.extension,
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
