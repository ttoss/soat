import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import createDebug from 'debug';

import { DomainError } from '../errors';

const log = createDebug('soat:file-storage');

/**
 * Physical storage backends a file can live on. `local` is the on-disk
 * filesystem; `s3` is any S3 / S3-compatible object store. The value is
 * recorded per file row so reads and deletes route to the backend that
 * actually stored the bytes, independent of the currently-active backend.
 */
export type StorageType = 'local' | 's3';

/**
 * A pluggable file storage backend. All physical I/O for files goes through a
 * provider so the rest of the codebase never touches `fs` or the S3 SDK
 * directly.
 *
 * - `objectPath` is the backend-agnostic logical location, e.g.
 *   `proj_ABC/traces/file_abc123.json`. The provider turns it into a concrete
 *   `storagePath` (an absolute filesystem path for local, an object key for s3)
 *   and returns it to be recorded on the file row.
 * - `read` / `delete` take that stored `storagePath` back and interpret it.
 */
export interface FileStorageProvider {
  readonly storageType: StorageType;
  write(args: {
    objectPath: string;
    buffer: Buffer;
    contentType?: string;
  }): Promise<{ storagePath: string }>;
  read(args: {
    storagePath: string;
  }): Promise<{ stream: Readable; size?: number } | null>;
  delete(args: { storagePath: string }): Promise<void>;
}

/** Collects a readable object body (from any provider) into a single Buffer. */
export const streamToBuffer = async (
  stream: AsyncIterable<unknown>
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
};

// ── Local filesystem provider ────────────────────────────────────────────────

/**
 * Filesystem-backed provider. `storagePath` is the absolute path on disk,
 * `storageDir` + `objectPath`.
 */
export const createLocalStorageProvider = (args: {
  storageDir: string;
}): FileStorageProvider => {
  return {
    storageType: 'local',
    write: async ({ objectPath, buffer }) => {
      const storagePath = path.join(args.storageDir, objectPath);
      fs.mkdirSync(path.dirname(storagePath), { recursive: true });
      fs.writeFileSync(storagePath, buffer);
      log('local write: storagePath=%s size=%d', storagePath, buffer.length);
      return { storagePath };
    },
    read: async ({ storagePath }) => {
      if (!storagePath || !fs.existsSync(storagePath)) {
        return null;
      }
      const { size } = fs.statSync(storagePath);
      return { stream: fs.createReadStream(storagePath), size };
    },
    delete: async ({ storagePath }) => {
      if (!storagePath) return;
      try {
        fs.unlinkSync(storagePath);
      } catch {
        // Missing file — nothing to remove; the DB record is authoritative.
      }
    },
  };
};

// ── S3 provider ──────────────────────────────────────────────────────────────

/**
 * The narrow slice of the S3 client the provider relies on. Structurally
 * satisfied by an `S3Client`; keeping it minimal lets tests supply an in-memory
 * fake without standing up a real bucket.
 */
export interface S3ClientLike {
  send(
    command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand
  ): Promise<{ Body?: unknown; ContentLength?: number }>;
}

const isS3NotFound = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    .$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
};

/**
 * S3-backed provider. `storagePath` is the object key (`keyPrefix` + the
 * logical `objectPath`); the bucket is fixed per provider instance.
 */
export const createS3StorageProvider = (args: {
  client: S3ClientLike;
  bucket: string;
  keyPrefix?: string;
}): FileStorageProvider => {
  const prefix = args.keyPrefix
    ? args.keyPrefix.replace(/^\/+|\/+$/g, '') + '/'
    : '';
  const toKey = (objectPath: string) => {
    return prefix + objectPath.replace(/^\/+/, '');
  };

  return {
    storageType: 's3',
    write: async ({ objectPath, buffer, contentType }) => {
      const key = toKey(objectPath);
      await args.client.send(
        new PutObjectCommand({
          Bucket: args.bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        })
      );
      log(
        's3 write: bucket=%s key=%s size=%d',
        args.bucket,
        key,
        buffer.length
      );
      return { storagePath: key };
    },
    read: async ({ storagePath }) => {
      if (!storagePath) return null;
      try {
        const res = await args.client.send(
          new GetObjectCommand({ Bucket: args.bucket, Key: storagePath })
        );
        // In the Node runtime the SDK returns a Readable stream for the body.
        if (res.Body instanceof Readable) {
          return { stream: res.Body, size: res.ContentLength };
        }
        return null;
      } catch (error) {
        if (isS3NotFound(error)) return null;
        throw error;
      }
    },
    delete: async ({ storagePath }) => {
      if (!storagePath) return;
      await args.client.send(
        new DeleteObjectCommand({ Bucket: args.bucket, Key: storagePath })
      );
    },
  };
};

// ── Backend selection (env-driven) ───────────────────────────────────────────

let cachedS3Client: S3ClientLike | undefined;

const getS3Client = (): S3ClientLike => {
  if (!cachedS3Client) {
    const region = process.env.FILES_S3_REGION ?? process.env.AWS_REGION;
    const endpoint = process.env.FILES_S3_ENDPOINT;
    const forcePathStyle = process.env.FILES_S3_FORCE_PATH_STYLE === 'true';
    cachedS3Client = new S3Client({
      ...(region ? { region } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(forcePathStyle ? { forcePathStyle: true } : {}),
    });
  }
  return cachedS3Client;
};

/**
 * Clears the memoized S3 client so a later call re-reads the environment.
 * Intended for tests that toggle `FILES_S3_*` variables between cases.
 */
export const resetStorageProviders = () => {
  cachedS3Client = undefined;
};

const buildLocalProvider = (): FileStorageProvider => {
  const storageDir = process.env.FILES_STORAGE_DIR;
  if (!storageDir) {
    throw new DomainError(
      'FILE_STORAGE_MISCONFIGURED',
      'FILES_STORAGE_DIR must be set for the local storage backend.'
    );
  }
  return createLocalStorageProvider({ storageDir });
};

const buildS3Provider = (): FileStorageProvider => {
  const bucket = process.env.FILES_S3_BUCKET;
  if (!bucket) {
    throw new DomainError(
      'FILE_STORAGE_MISCONFIGURED',
      'FILES_S3_BUCKET must be set for the s3 storage backend.'
    );
  }
  return createS3StorageProvider({
    client: getS3Client(),
    bucket,
    keyPrefix: process.env.FILES_S3_KEY_PREFIX,
  });
};

/**
 * The provider new writes should use, selected by `FILES_STORAGE_PROVIDER`
 * (default `local`). Its `storageType` is recorded on each file so future
 * reads route back to the same backend.
 */
export const getActiveStorageProvider = (): FileStorageProvider => {
  const provider = (
    process.env.FILES_STORAGE_PROVIDER ?? 'local'
  ).toLowerCase();
  if (provider === 'local') return buildLocalProvider();
  if (provider === 's3') return buildS3Provider();
  throw new DomainError(
    'FILE_STORAGE_MISCONFIGURED',
    `Unknown FILES_STORAGE_PROVIDER '${provider}'. Use 'local' or 's3'.`
  );
};

/**
 * The provider that owns an already-stored file, chosen by the row's recorded
 * `storageType` rather than the active backend — so a file written to one
 * backend still reads/deletes correctly after the active backend changes.
 */
export const getStorageProvider = (args: {
  storageType: string;
}): FileStorageProvider => {
  if (args.storageType === 'local') return buildLocalProvider();
  if (args.storageType === 's3') return buildS3Provider();
  throw new DomainError(
    'FILE_STORAGE_MISCONFIGURED',
    `Storage type '${args.storageType}' is not supported.`
  );
};

/**
 * Reads a stored file's bytes into a Buffer through the provider that owns it,
 * routing by the recorded `storageType`. Returns `null` when the object is
 * absent. Use for consumers that need the whole file in memory (base64
 * encoding, PDF extraction); prefer streaming via `getStorageProvider` for
 * large downloads.
 */
export const readFileBuffer = async (args: {
  storageType: string;
  storagePath: string;
}): Promise<Buffer | null> => {
  const provider = getStorageProvider({ storageType: args.storageType });
  const object = await provider.read({ storagePath: args.storagePath });
  if (!object) return null;
  return streamToBuffer(object.stream);
};
