import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';
import { readInputParts } from './inputModalities';
import { fileIdOfReference } from './modelInputBoundary';

const log = createDebug('soat:file-lifetime');

export const FILE_DELETE_AFTER_VALUES = ['generation'] as const;

export type FileDeleteAfter = (typeof FILE_DELETE_AFTER_VALUES)[number];

/** When a file is deleted, and whether a generation deletes it sooner. */
export type FileLifetime = {
  expiresAt: Date | null;
  deleteAfter: FileDeleteAfter | null;
};

export const NO_LIFETIME: FileLifetime = { expiresAt: null, deleteAfter: null };

const DEFAULT_SINGLE_USE_LIFETIME_SECONDS = 24 * 60 * 60;

/**
 * The lifetime a single-use file gets when its writer names none, so a file
 * no generation ever reads is still deleted. `FILE_SINGLE_USE_LIFETIME_SECONDS`
 * overrides it, read per call so a test or an operator can change it live.
 */
export const singleUseLifetimeSeconds = (): number => {
  const parsed = Number(process.env.FILE_SINGLE_USE_LIFETIME_SECONDS);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_SINGLE_USE_LIFETIME_SECONDS;
};

const invalid = (message: string): DomainError => {
  return new DomainError('VALIDATION_FAILED', message);
};

/** A count of seconds; a multipart field arrives as its decimal text. */
const readSeconds = (value: unknown): number => {
  const seconds =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (
    typeof seconds !== 'number' ||
    !Number.isSafeInteger(seconds) ||
    seconds < 1
  ) {
    throw invalid('`expires_in` is a whole number of seconds, at least 1.');
  }
  return seconds;
};

const readInstant = (value: unknown): Date => {
  const instant = typeof value === 'string' ? new Date(value) : null;
  if (!instant || Number.isNaN(instant.getTime())) {
    throw invalid('`expires_at` is an ISO 8601 date-time.');
  }
  return instant;
};

const readFutureInstant = (args: { value: unknown; now: Date }): Date => {
  const instant = readInstant(args.value);
  if (instant.getTime() <= args.now.getTime()) {
    throw invalid('`expires_at` is in the future.');
  }
  return instant;
};

const readDeleteAfter = (value: unknown): FileDeleteAfter | null => {
  if (value === undefined || value === null || value === '') return null;
  const known = FILE_DELETE_AFTER_VALUES.find((candidate) => {
    return candidate === value;
  });
  if (!known) {
    throw invalid(
      `\`delete_after\` is one of: ${FILE_DELETE_AFTER_VALUES.join(', ')}.`
    );
  }
  return known;
};

const secondsFrom = (now: Date, seconds: number): Date => {
  return new Date(now.getTime() + seconds * 1000);
};

/**
 * The lifetime a new file is written with. `expires_in` and `expires_at` are
 * one choice; a single-use file without either gets
 * {@link singleUseLifetimeSeconds}, so it always expires.
 */
export const readFileLifetime = (args: {
  expiresIn?: unknown;
  expiresAt?: unknown;
  deleteAfter?: unknown;
  now?: Date;
}): FileLifetime => {
  const now = args.now ?? new Date();
  const hasIn = args.expiresIn !== undefined && args.expiresIn !== '';
  const hasAt = args.expiresAt !== undefined && args.expiresAt !== null;
  if (hasIn && hasAt) {
    throw invalid('Give `expires_in` or `expires_at`, not both.');
  }
  const deleteAfter = readDeleteAfter(args.deleteAfter);
  const named = hasIn
    ? secondsFrom(now, readSeconds(args.expiresIn))
    : hasAt
      ? readFutureInstant({ value: args.expiresAt, now })
      : null;
  const expiresAt =
    named ??
    (deleteAfter ? secondsFrom(now, singleUseLifetimeSeconds()) : null);
  return { expiresAt, deleteAfter };
};

/**
 * What a `PATCH` changes in a file's lifetime. A lifetime only tightens:
 * `expires_at` may be set or moved earlier (a past instant expires the file at
 * once), `delete_after` may be set; neither is extended or cleared.
 */
export const readFileLifetimeUpdate = (args: {
  current: FileLifetime;
  expiresAt?: unknown;
  deleteAfter?: unknown;
  now?: Date;
}): Partial<FileLifetime> => {
  const now = args.now ?? new Date();
  const updates: Partial<FileLifetime> = {};
  if (args.expiresAt !== undefined) {
    if (args.expiresAt === null) {
      throw invalid('`expires_at` cannot be cleared.');
    }
    const expiresAt = readInstant(args.expiresAt);
    const current = args.current.expiresAt;
    if (current && expiresAt.getTime() > current.getTime()) {
      throw invalid('`expires_at` can only move earlier.');
    }
    updates.expiresAt = expiresAt;
  }
  if (args.deleteAfter !== undefined) {
    const deleteAfter = readDeleteAfter(args.deleteAfter);
    if (!deleteAfter) {
      throw invalid('`delete_after` cannot be cleared.');
    }
    updates.deleteAfter = deleteAfter;
    if (!args.current.expiresAt && updates.expiresAt === undefined) {
      updates.expiresAt = secondsFrom(now, singleUseLifetimeSeconds());
    }
  }
  return updates;
};

/**
 * {@link readFileLifetimeUpdate} for a stored file. A lifetime is never given
 * to a file a document is made from.
 */
export const readStoredFileLifetimeUpdate = async (args: {
  file: InstanceType<(typeof db)['File']>;
  expiresAt?: unknown;
  deleteAfter?: unknown;
}): Promise<Partial<FileLifetime>> => {
  if (args.expiresAt === undefined && args.deleteAfter === undefined) {
    return {};
  }
  const updates = readFileLifetimeUpdate({
    current: {
      expiresAt: args.file.expiresAt,
      deleteAfter: args.file.deleteAfter,
    },
    expiresAt: args.expiresAt,
    deleteAfter: args.deleteAfter,
  });
  const documents = await db.Document.count({
    where: { fileId: args.file.id },
  });
  if (documents > 0) {
    throw new DomainError(
      'FILE_HAS_DEPENDENTS',
      `File '${args.file.publicId}' backs a document and cannot be given a lifetime.`
    );
  }
  return updates;
};

export const hasLifetime = (file: {
  expiresAt?: Date | null;
  deleteAfter?: string | null;
}): boolean => {
  return Boolean(file.expiresAt || file.deleteAfter);
};

/** A file with a lifetime never becomes a document. */
export const assertIngestible = (file: {
  publicId: string;
  expiresAt?: Date | null;
  deleteAfter?: string | null;
}): void => {
  if (!hasLifetime(file)) return;
  throw new DomainError(
    'FILE_NOT_INGESTIBLE',
    `File '${file.publicId}' has a lifetime and is never ingested.`,
    { file_id: file.publicId }
  );
};

/** A single-use file is read by one generation, so it is never a turn's file. */
export const assertNotSingleUse = (file: {
  publicId: string;
  deleteAfter?: string | null;
}): void => {
  if (!file.deleteAfter) return;
  throw invalid(
    `File '${file.publicId}' is single use (\`delete_after\`) and cannot be a turn's file; send it as a \`file\` part of one generation.`
  );
};

/** The stored files resolved `messages` reference, in order, deduplicated. */
export const readReferencedFileIds = (
  messages: readonly unknown[] | null | undefined
): string[] => {
  const ids = readInputParts(messages).flatMap((part) => {
    const data: unknown = Reflect.get(Object(part), 'data');
    const fileId =
      Reflect.get(Object(part), 'type') === 'file' && typeof data === 'string'
        ? fileIdOfReference(data)
        : null;
    return fileId === null ? [] : [fileId];
  });
  return [...new Set(ids)];
};

/** The refusal {@link claimSingleUseFiles} throws. */
export const isFileClaimRefusal = (error: unknown): boolean => {
  return error instanceof DomainError && error.code === 'FILE_CONSUMED';
};

/**
 * Claims, for `generationId`, every single-use file among `fileIds`, in the
 * transaction that creates the generation: two generations naming one file
 * cannot both commit. One another generation holds refuses the whole turn.
 */
export const claimSingleUseFiles = async (args: {
  fileIds: readonly string[];
  projectId: number;
  generationId: string;
  transaction: Transaction;
}): Promise<void> => {
  if (args.fileIds.length === 0) return;
  const singleUse = await db.File.findAll({
    where: {
      publicId: [...new Set(args.fileIds)],
      projectId: args.projectId,
      deleteAfter: { [Op.ne]: null },
    },
    attributes: ['id', 'publicId', 'consumedByGenerationId'],
    lock: args.transaction.LOCK.UPDATE,
    transaction: args.transaction,
  });
  const taken = singleUse.find((file) => {
    return (
      file.consumedByGenerationId !== null &&
      file.consumedByGenerationId !== args.generationId
    );
  });
  if (taken) {
    throw new DomainError(
      'FILE_CONSUMED',
      `File '${taken.publicId}' is single use and another generation claimed it.`,
      { file_id: taken.publicId, generation_id: taken.consumedByGenerationId }
    );
  }
  if (singleUse.length === 0) return;
  log(
    'claimSingleUseFiles: generationId=%s files=%d',
    args.generationId,
    singleUse.length
  );
  await db.File.update(
    { consumedByGenerationId: args.generationId },
    {
      where: {
        id: singleUse.map((file) => {
          return file.id as number;
        }),
      },
      transaction: args.transaction,
    }
  );
};

/**
 * Claims the single-use files a new generation's resolved input references,
 * in the transaction that creates its row.
 */
export const claimTurnFiles = (args: {
  generation: {
    publicId: string;
    projectId: number;
    inputMessages?: readonly unknown[] | null;
  };
  transaction: Transaction;
}): Promise<void> => {
  return claimSingleUseFiles({
    fileIds: readReferencedFileIds(args.generation.inputMessages),
    projectId: args.generation.projectId,
    generationId: args.generation.publicId,
    transaction: args.transaction,
  });
};
