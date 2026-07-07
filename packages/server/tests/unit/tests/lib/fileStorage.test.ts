import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  createLocalStorageProvider,
  createS3StorageProvider,
  getActiveStorageProvider,
  getStorageProvider,
  readFileBuffer,
  resetStorageProviders,
  type S3ClientLike,
  streamToBuffer,
} from 'src/lib/fileStorage';

const drain = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
};

/**
 * An in-memory stand-in for the S3 client. Not a mock of code we own — it
 * fakes the external S3 boundary (which cannot run in CI) by interpreting the
 * real command objects the provider constructs.
 */
const createFakeS3 = () => {
  const store = new Map<string, { body: Buffer; contentType?: string }>();
  let missing = false;
  const client: S3ClientLike = {
    send: async (command) => {
      if (command instanceof PutObjectCommand) {
        store.set(command.input.Key as string, {
          body: Buffer.from(command.input.Body as Buffer),
          contentType: command.input.ContentType,
        });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        if (missing) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        const entry = store.get(command.input.Key as string);
        if (!entry) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        return {
          Body: Readable.from(entry.body),
          ContentLength: entry.body.length,
        };
      }
      if (command instanceof DeleteObjectCommand) {
        store.delete(command.input.Key as string);
        return {};
      }
      throw new Error('unexpected command');
    },
  };
  return {
    client,
    store,
    setMissing: (value: boolean) => {
      missing = value;
    },
  };
};

describe('fileStorage', () => {
  describe('local provider', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soat-storage-test-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('write persists bytes under storageDir + objectPath and returns absolute path', async () => {
      const provider = createLocalStorageProvider({ storageDir: dir });
      const { storagePath } = await provider.write({
        objectPath: 'proj_1/files/file_abc.txt',
        buffer: Buffer.from('hello'),
      });

      expect(storagePath).toBe(path.join(dir, 'proj_1/files/file_abc.txt'));
      expect(fs.readFileSync(storagePath, 'utf-8')).toBe('hello');
    });

    test('read streams stored bytes with size', async () => {
      const provider = createLocalStorageProvider({ storageDir: dir });
      const { storagePath } = await provider.write({
        objectPath: 'a/b.txt',
        buffer: Buffer.from('content'),
      });

      const result = await provider.read({ storagePath });
      expect(result).not.toBeNull();
      expect(result!.size).toBe(7);
      expect((await drain(result!.stream)).toString()).toBe('content');
    });

    test('read returns null when the file is absent', async () => {
      const provider = createLocalStorageProvider({ storageDir: dir });
      const result = await provider.read({
        storagePath: path.join(dir, 'nope.txt'),
      });
      expect(result).toBeNull();
    });

    test('delete removes the file and is a no-op when already gone', async () => {
      const provider = createLocalStorageProvider({ storageDir: dir });
      const { storagePath } = await provider.write({
        objectPath: 'x.txt',
        buffer: Buffer.from('bye'),
      });

      await provider.delete({ storagePath });
      expect(fs.existsSync(storagePath)).toBe(false);
      // second delete does not throw
      await expect(provider.delete({ storagePath })).resolves.toBeUndefined();
    });
  });

  describe('s3 provider', () => {
    test('write uploads under the bucket and returns the object key', async () => {
      const fake = createFakeS3();
      const provider = createS3StorageProvider({
        client: fake.client,
        bucket: 'my-bucket',
      });

      const { storagePath } = await provider.write({
        objectPath: 'proj_1/files/file_abc.txt',
        buffer: Buffer.from('hello'),
        contentType: 'text/plain',
      });

      expect(storagePath).toBe('proj_1/files/file_abc.txt');
      expect(fake.store.get('proj_1/files/file_abc.txt')?.body.toString()).toBe(
        'hello'
      );
      expect(fake.store.get('proj_1/files/file_abc.txt')?.contentType).toBe(
        'text/plain'
      );
    });

    test('keyPrefix namespaces keys within the bucket', async () => {
      const fake = createFakeS3();
      const provider = createS3StorageProvider({
        client: fake.client,
        bucket: 'my-bucket',
        keyPrefix: '/soat/',
      });

      const { storagePath } = await provider.write({
        objectPath: '/proj_1/files/f.txt',
        buffer: Buffer.from('x'),
      });

      expect(storagePath).toBe('soat/proj_1/files/f.txt');
    });

    test('read streams the object body with size', async () => {
      const fake = createFakeS3();
      const provider = createS3StorageProvider({
        client: fake.client,
        bucket: 'b',
      });
      const { storagePath } = await provider.write({
        objectPath: 'k.txt',
        buffer: Buffer.from('payload'),
      });

      const result = await provider.read({ storagePath });
      expect(result).not.toBeNull();
      expect(result!.size).toBe(7);
      expect((await drain(result!.stream)).toString()).toBe('payload');
    });

    test('read returns null on a NoSuchKey error', async () => {
      const fake = createFakeS3();
      fake.setMissing(true);
      const provider = createS3StorageProvider({
        client: fake.client,
        bucket: 'b',
      });

      const result = await provider.read({ storagePath: 'missing.txt' });
      expect(result).toBeNull();
    });

    test('delete removes the object', async () => {
      const fake = createFakeS3();
      const provider = createS3StorageProvider({
        client: fake.client,
        bucket: 'b',
      });
      const { storagePath } = await provider.write({
        objectPath: 'k.txt',
        buffer: Buffer.from('x'),
      });

      await provider.delete({ storagePath });
      expect(fake.store.has('k.txt')).toBe(false);
    });
  });

  describe('backend selection', () => {
    const OLD_ENV = { ...process.env };

    afterEach(() => {
      process.env = { ...OLD_ENV };
      resetStorageProviders();
    });

    test('defaults to the local backend', () => {
      delete process.env.FILES_STORAGE_PROVIDER;
      process.env.FILES_STORAGE_DIR = '/tmp/soat-files';
      expect(getActiveStorageProvider().storageType).toBe('local');
    });

    test('selects s3 when FILES_STORAGE_PROVIDER=s3', () => {
      process.env.FILES_STORAGE_PROVIDER = 's3';
      process.env.FILES_S3_BUCKET = 'my-bucket';
      expect(getActiveStorageProvider().storageType).toBe('s3');
    });

    test('throws when the local backend is missing FILES_STORAGE_DIR', () => {
      process.env.FILES_STORAGE_PROVIDER = 'local';
      delete process.env.FILES_STORAGE_DIR;
      expect(() => {
        return getActiveStorageProvider();
      }).toThrow(/FILES_STORAGE_DIR/);
    });

    test('throws when the s3 backend is missing FILES_S3_BUCKET', () => {
      process.env.FILES_STORAGE_PROVIDER = 's3';
      delete process.env.FILES_S3_BUCKET;
      expect(() => {
        return getActiveStorageProvider();
      }).toThrow(/FILES_S3_BUCKET/);
    });

    test('throws on an unknown provider', () => {
      process.env.FILES_STORAGE_PROVIDER = 'ftp';
      expect(() => {
        return getActiveStorageProvider();
      }).toThrow(/Unknown FILES_STORAGE_PROVIDER/);
    });

    test('getStorageProvider routes by the record storage type', () => {
      process.env.FILES_STORAGE_DIR = '/tmp/soat-files';
      process.env.FILES_S3_BUCKET = 'my-bucket';
      expect(getStorageProvider({ storageType: 'local' }).storageType).toBe(
        'local'
      );
      expect(getStorageProvider({ storageType: 's3' }).storageType).toBe('s3');
    });

    test('getStorageProvider throws on an unsupported storage type', () => {
      expect(() => {
        return getStorageProvider({ storageType: 'gcs' });
      }).toThrow(/not supported/);
    });

    test('readFileBuffer reads bytes via the routed backend', async () => {
      const storageDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'soat-readbuf-')
      );
      process.env.FILES_STORAGE_DIR = storageDir;
      const { storagePath } = await createLocalStorageProvider({
        storageDir,
      }).write({ objectPath: 'a/b.txt', buffer: Buffer.from('hi there') });

      const buffer = await readFileBuffer({
        storageType: 'local',
        storagePath,
      });
      expect(buffer?.toString()).toBe('hi there');

      fs.rmSync(storageDir, { recursive: true, force: true });
    });

    test('readFileBuffer returns null when the object is absent', async () => {
      process.env.FILES_STORAGE_DIR = '/tmp/soat-files';
      const buffer = await readFileBuffer({
        storageType: 'local',
        storagePath: '/tmp/soat-files/does-not-exist.txt',
      });
      expect(buffer).toBeNull();
    });

    test('s3 client honors region / endpoint / path-style env vars', () => {
      process.env.FILES_STORAGE_PROVIDER = 's3';
      process.env.FILES_S3_BUCKET = 'my-bucket';
      process.env.FILES_S3_REGION = 'eu-west-1';
      process.env.FILES_S3_ENDPOINT = 'http://localhost:9000';
      process.env.FILES_S3_FORCE_PATH_STYLE = 'true';
      // Exercises the env-driven S3Client construction branches.
      expect(getActiveStorageProvider().storageType).toBe('s3');
    });
  });

  describe('edge cases', () => {
    test('s3 read returns null when the response has no readable body', async () => {
      const client: S3ClientLike = {
        send: async () => {
          return {};
        },
      };
      const provider = createS3StorageProvider({ client, bucket: 'b' });
      expect(await provider.read({ storagePath: 'k' })).toBeNull();
    });

    test('s3 read treats a NotFound / 404 error as absent', async () => {
      const client: S3ClientLike = {
        send: async () => {
          throw { $metadata: { httpStatusCode: 404 } };
        },
      };
      const provider = createS3StorageProvider({ client, bucket: 'b' });
      expect(await provider.read({ storagePath: 'k' })).toBeNull();
    });

    test('s3 read rethrows a non-not-found error', async () => {
      const client: S3ClientLike = {
        send: async () => {
          const err = new Error('AccessDenied');
          err.name = 'AccessDenied';
          throw err;
        },
      };
      const provider = createS3StorageProvider({ client, bucket: 'b' });
      await expect(provider.read({ storagePath: 'k' })).rejects.toThrow(
        /AccessDenied/
      );
    });

    test('empty storagePath is a no-op / null across providers', async () => {
      const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soat-empty-'));
      const local = createLocalStorageProvider({ storageDir: localDir });
      expect(await local.read({ storagePath: '' })).toBeNull();
      await expect(local.delete({ storagePath: '' })).resolves.toBeUndefined();
      fs.rmSync(localDir, { recursive: true, force: true });

      const client: S3ClientLike = {
        send: async () => {
          throw new Error('should not be called');
        },
      };
      const s3 = createS3StorageProvider({ client, bucket: 'b' });
      expect(await s3.read({ storagePath: '' })).toBeNull();
      await expect(s3.delete({ storagePath: '' })).resolves.toBeUndefined();
    });

    test('streamToBuffer coerces non-Buffer chunks', async () => {
      const buffer = await streamToBuffer(Readable.from(['a', 'b', 'c']));
      expect(buffer.toString()).toBe('abc');
    });
  });
});
