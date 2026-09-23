import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { DomainError } from '../errors';
import { rethrowAsConflict } from './uniqueViolation';

/**
 * A path names one file per project (`files_project_id_path_unique`), and a
 * document is filed through its file, so the files API and every document write
 * that files or moves one answer a taken path the same way.
 */
const FILE_PATH_CONFLICT_MESSAGE =
  'A file already exists at that path in this project.';

/** For the `catch` of a write that sets a file's path; see `rethrowAsConflict`. */
export const rethrowAsPathConflict = (error: unknown): never => {
  return rethrowAsConflict(error, FILE_PATH_CONFLICT_MESSAGE);
};

/**
 * Refuses a path another file in the project holds, for a write that must be
 * refused before it has changed anything the constraint would not roll back.
 * The constraint still decides a race; this only answers the common case early.
 */
export const assertFilePathFree = async (args: {
  projectId: number;
  path: string | null;
  /** The file being moved or filed, which may already hold `path`. */
  exceptFileId?: number;
}): Promise<void> => {
  if (args.path === null) return;
  const taken = await db.File.findOne({
    where: {
      projectId: args.projectId,
      path: args.path,
      ...(args.exceptFileId === undefined
        ? {}
        : { id: { [Op.ne]: args.exceptFileId } }),
    },
    attributes: ['id'],
  });
  if (taken) {
    throw new DomainError('NAME_CONFLICT', FILE_PATH_CONFLICT_MESSAGE, {
      path: args.path,
    });
  }
};
