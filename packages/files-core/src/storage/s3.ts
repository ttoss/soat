import { S3 } from 'aws-sdk';

import type { StorageConfig } from '../types';

export const save = async (args: {
  id: string;
  content: string | Buffer;
  config: StorageConfig;
}): Promise<void> => {
  const { id, content, config } = args;
  if (!config.s3) {
    throw new Error('S3 config not provided');
  }
  const s3 = new S3({
    region: config.s3.region,
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  });
  await s3
    .putObject({
      Bucket: config.s3.bucket,
      Key: id,
      Body: content,
    })
    .promise();
};

export const retrieve = async (args: {
  id: string;
  config: StorageConfig;
}): Promise<string | Buffer> => {
  const { id, config } = args;
  if (!config.s3) {
    throw new Error('S3 config not provided');
  }
  const s3 = new S3({
    region: config.s3.region,
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  });
  const data = await s3
    .getObject({
      Bucket: config.s3.bucket,
      Key: id,
    })
    .promise();
  return data.Body as Buffer;
};

export const delete = async (args: {
  id: string;
  config: StorageConfig;
}): Promise<void> => {
  const { id, config } = args;
  if (!config.s3) {
    throw new Error('S3 config not provided');
  }
  const s3 = new S3({
    region: config.s3.region,
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  });
  await s3
    .deleteObject({
      Bucket: config.s3.bucket,
      Key: id,
    })
    .promise();
};
