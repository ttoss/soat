import { Storage } from '@google-cloud/storage';

import type { StorageConfig } from '../types';

export const save = async (args: {
  id: string;
  content: string | Buffer;
  config: StorageConfig;
}): Promise<void> => {
  const { id, content, config } = args;
  if (!config.gcs) {
    throw new Error('GCS config not provided');
  }
  const storage = new Storage({
    keyFilename: config.gcs.keyFilename,
    projectId: config.gcs.projectId,
  });
  const bucket = storage.bucket(config.gcs.bucket);
  const file = bucket.file(id);
  await file.save(content);
};

export const retrieve = async (args: {
  id: string;
  config: StorageConfig;
}): Promise<string | Buffer> => {
  const { id, config } = args;
  if (!config.gcs) {
    throw new Error('GCS config not provided');
  }
  const storage = new Storage({
    keyFilename: config.gcs.keyFilename,
    projectId: config.gcs.projectId,
  });
  const bucket = storage.bucket(config.gcs.bucket);
  const file = bucket.file(id);
  const [buffer] = await file.download();
  return buffer;
};

export const deleteFile = async (args: {
  id: string;
  config: StorageConfig;
}): Promise<void> => {
  const { id, config } = args;
  if (!config.gcs) {
    throw new Error('GCS config not provided');
  }
  const storage = new Storage({
    keyFilename: config.gcs.keyFilename,
    projectId: config.gcs.projectId,
  });
  const bucket = storage.bucket(config.gcs.bucket);
  const file = bucket.file(id);
  await file.delete();
};
