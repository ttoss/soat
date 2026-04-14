import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const storageDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'soat-convo-test-')
);

process.env.FILES_STORAGE_DIR = storageDir;
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.EMBEDDING_MODEL = 'qwen3-embedding:0.6b';
process.env.EMBEDDING_DIMENSIONS = '1024';
process.env.SECRETS_ENCRYPTION_KEY = '0'.repeat(64);
