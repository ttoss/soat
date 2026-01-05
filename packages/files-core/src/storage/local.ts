import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { StorageConfig } from '../types';

export const save = async (args: {
  id: string;
  content: string | Buffer;
  config: StorageConfig;
}): Promise<void> => {
  const { id, content, config } = args;
  if (!config.local) {
    throw new Error('Local config not provided');
  }
  const filePath = path.join(config.local.path, id);
  await fs.writeFile(filePath, content);
};

export const retrieve = async (args: {
  id: string;
  config: StorageConfig;
}): Promise<string | Buffer> => {
  const { id, config } = args;
  if (!config.local) {
    throw new Error('Local config not provided');
  }
  const filePath = path.join(config.local.path, id);
  return fs.readFile(filePath);
};

export const delete = async (args: {
  id: string;
  config: StorageConfig;
}): Promise<void> => {
  const { id, config } = args;
  if (!config.local) {
    throw new Error('Local config not provided');
  }
  const filePath = path.join(config.local.path, id);
  await fs.unlink(filePath);
};
