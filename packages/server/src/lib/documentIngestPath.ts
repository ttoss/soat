import createDebug from 'debug';

import { db } from '../db';
import { normalizeCallerPath } from './filePaths';

const log = createDebug('soat:documents');

export const sourceFilename = (file: { filename?: string | null }): string => {
  return file.filename ?? 'document';
};

/** Where an ingest files its document: the source's filename under `pathPrefix`. */
export const ingestedDocumentPath = (args: {
  pathPrefix?: string;
  filename: string;
}): string => {
  return normalizeCallerPath(
    args.pathPrefix
      ? `${args.pathPrefix.replace(/\/$/, '')}/${args.filename}`
      : `/${args.filename}`
  );
};

/**
 * The filename an ingest of `fileId` files its document under, or `null` when
 * no such file exists.
 */
export const findIngestSourceFilename = async (args: {
  fileId: string;
}): Promise<string | null> => {
  log('findIngestSourceFilename: fileId=%s', args.fileId);
  const file = await db.File.findOne({
    where: { publicId: args.fileId },
    attributes: ['filename'],
  });
  return file ? sourceFilename(file) : null;
};
