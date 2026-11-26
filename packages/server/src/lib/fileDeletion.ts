import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { INCLUDING_EXPIRED_FILES } from './expiredFiles';
import { removeFile } from './fileRemoval';
import { createScheduler } from './scheduler';

const log = createDebug('soat:file-deletion');

type FileRow = InstanceType<(typeof db)['File']>;

/** Each deletion stands alone: one that fails is retried by the expiry sweep. */
const removeEach = async (files: FileRow[]): Promise<number> => {
  const results = await Promise.allSettled(
    files.map((file) => {
      return removeFile({ file });
    })
  );
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      log(
        'removeEach: fileId=%s failed %o',
        files[index].publicId,
        result.reason
      );
    }
  }
  return results.filter((result) => {
    return result.status === 'fulfilled';
  }).length;
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

/** Files one tick deletes; a larger backlog drains over the next ticks. */
const SWEEP_BATCH = 500;

/** Deletes the files whose `expires_at` has passed by `now`, oldest first. */
export const sweepExpiredFiles = async (args?: {
  now?: Date;
}): Promise<number> => {
  const due = await db.File.findAll({
    where: { expiresAt: { [Op.lte]: args?.now ?? new Date() } },
    order: [['expiresAt', 'ASC']],
    limit: SWEEP_BATCH,
    ...INCLUDING_EXPIRED_FILES,
  });
  const removed = await removeEach(due);
  log('sweepExpiredFiles: due=%d removed=%d', due.length, removed);
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
