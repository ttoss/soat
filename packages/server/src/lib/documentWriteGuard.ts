import type { LoadedDoc } from './documentLoaders';
import { documentVersionStore } from './documentVersionSnapshot';
import { assertFilePathFree } from './filePathConflict';
import { assertCallerPath, normalizePath } from './filePaths';
import { assertUpdatedDocumentMetadataValid } from './metadataSchemas';
import { toResourceRef } from './resourceVersions';

/** A stated `path`, normalized and refused when it names the reserved root. */
export const normalizeStatedPath = (path: string | null): string | null => {
  return assertCallerPath(path === null ? null : normalizePath(path));
};

/**
 * Every refusal a document update can meet, checked before it embeds
 * anything: a refused update should not have paid for its vectors. The
 * transaction re-checks the version and the path constraint decides a race.
 */
export const assertDocumentUpdatable = async (args: {
  doc: LoadedDoc;
  path?: string | null;
  metadata?: Record<string, unknown> | null;
  expectedVersion?: number | null;
}): Promise<void> => {
  const { doc } = args;

  // Runtime-written documents are read-only for callers: their content is the
  // record another module keeps, and editing it would rewrite that module's
  // history behind its back.
  assertCallerPath(doc.file?.path);

  /* istanbul ignore else -- the backing file is optional in the loaded type and
     always present in practice; without one there is no project to judge
     against and no path to judge under. */
  if (doc.file) {
    await assertUpdatedDocumentMetadataValid({
      projectId: doc.file.projectId,
      currentPath: doc.file.path ?? null,
      path:
        args.path === undefined ? undefined : normalizeStatedPath(args.path),
      metadata: args.metadata,
      currentMetadata: doc.metadata ?? null,
    });
  }

  documentVersionStore.assertWritable({
    resource: toResourceRef(doc),
    expectedVersion: args.expectedVersion,
  });

  if (args.path !== undefined && doc.file) {
    await assertFilePathFree({
      projectId: doc.file.projectId,
      path: normalizeStatedPath(args.path),
      exceptFileId: doc.file.id as number,
    });
  }
};
