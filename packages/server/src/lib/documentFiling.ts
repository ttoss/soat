import { assertCallerPath, normalizePath, systemPath } from './filePaths';

/**
 * Where a document is filed.
 *
 * A module writing on the caller's behalf names itself and, optionally, a
 * directory to group by; the leaf is always the document's own id, so the key
 * is stable under a reorder — a conversation message cannot be keyed by
 * position, because inserting between two messages shifts every one after it.
 *
 * Everything else is a caller path, and goes through the reserved-root gate.
 */
export type DocumentFiling = { module: string; dir?: string };

export const resolveDocumentFiling = (args: {
  system?: DocumentFiling;
  path?: string;
  filename?: string;
  publicId: string;
}): { normalizedPath: string | null; filename?: string } => {
  if (args.system) {
    const leaf = args.system.dir
      ? `${args.system.dir}/${args.publicId}.txt`
      : `${args.publicId}.txt`;
    return {
      normalizedPath: systemPath({ module: args.system.module, leaf }),
      filename: `${args.publicId}.txt`,
    };
  }
  const rawPath = assertCallerPath(args.path ?? args.filename ?? null);
  if (rawPath === null) {
    // A document with no path is reachable only by its id, because every
    // prefix read is a `LIKE` and `LIKE` never matches null — so listing `/`
    // would not be the whole project. Its own id is the one leaf that is
    // unique without asking the caller for a name, which `project_id + path`
    // requires.
    return {
      normalizedPath: `/${args.publicId}.txt`,
      filename: `${args.publicId}.txt`,
    };
  }
  return {
    normalizedPath: normalizePath(rawPath),
    filename: args.filename,
  };
};
