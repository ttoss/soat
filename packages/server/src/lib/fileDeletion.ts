import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { INCLUDING_EXPIRED_FILES } from './expiredFiles';
import { removeFile } from './files';
import { createScheduler } from './scheduler';

const log = createDebug('soat:file-deletion');

type FileRow = InstanceType<(typeof db)['File']>;

/** Each deletion stands alone: one that fails is retried by the expiry sweep. */
const removeEach = async (files: FileRow[]): Promise<number> => {
  let removed = 0;
  for (const file of files) {
    try {
      await removeFile({ file });
      removed += 1;
    } catch (error) {
      log('removeEach: fileId=%s failed %o', file.publicId, error);
    }
  }
  return removed;
};

/**
 * Deletes the single-use files `generationId` claimed. Called once, by the
 * settle that ends the generation; a pause keeps them.
 */
export const deleteConsumedFiles = async (args: {
  generationId: string;
}): Promise<number> => {
  // A claimed file that also expired is still this generation's.
  const files = await db.File.findAll({
    where: { consumedByGenerationId: args.generationId },
    ...INCLUDING_EXPIRED_FILES,
  });
  log(
    'deleteConsumedFiles: generationId=%s files=%d',
    args.generationId,
    files.length
  );
  return removeEach(files);
};

const SWEEP_BATCH = 100;

/** Deletes every file whose `expires_at` has passed by `now`. */
export const sweepExpiredFiles = async (args?: {
  now?: Date;
}): Promise<number> => {
  const now = args?.now ?? new Date();
  let removed = 0;
  for (;;) {
    const due = await db.File.findAll({
      where: { expiresAt: { [Op.lte]: now } },
      order: [['expiresAt', 'ASC']],
      limit: SWEEP_BATCH,
      ...INCLUDING_EXPIRED_FILES,
    });
    if (due.length === 0) break;
    const batch = await removeEach(due);
    removed += batch;
    // A batch that removed nothing would be read again unchanged.
    if (batch === 0) break;
  }
  log('sweepExpiredFiles: removed=%d', removed);
  return removed;
};

const scheduler = createScheduler({
  log,
  defaultIntervalMs: 60 * 1000,
  envVar: 'FILE_EXPIRY_SWEEP_INTERVAL_MS',
  disabledEnvVar: 'FILE_EXPIRY_SWEEP_DISABLED',
  sweeps: [sweepExpiredFiles],
});

/** Starts the expired-file sweep. Called once from `server.ts`. */
export const startFileExpiryScheduler = scheduler.start;
