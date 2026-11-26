import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { INCLUDING_EXPIRED_FILES } from './expiredFiles';
import { emitFileEvent } from './fileEvents';
import { getStorageProvider } from './fileStorage';

/**
 * Deletes a file's bytes and row and announces it. Every deletion of a file a
 * caller wrote ends here: `DELETE`, an expiry and a generation settling.
 */
export const removeFile = async (args: {
  file: InstanceType<(typeof db)['File']>;
}): Promise<void> => {
  const { file } = args;
  if (file.storagePath) {
    const provider = getStorageProvider({ storageType: file.storageType });
    await provider.delete({ storagePath: file.storagePath });
  }

  await file.destroy();

  void emitFileEvent({ type: 'files.deleted', file });
};

/**
 * Deletes the file past `expires_at` that still holds `path`, so a new file
 * can take a path every read already treats as free.
 */
export const freeExpiredPath = async (args: {
  projectId: number;
  path: string | null;
}): Promise<void> => {
  if (args.path === null) return;
  const holder = await db.File.findOne({
    where: {
      projectId: args.projectId,
      path: args.path,
      expiresAt: { [Op.lte]: new Date() },
    },
    ...INCLUDING_EXPIRED_FILES,
  });
  if (holder) await removeFile({ file: holder });
};
