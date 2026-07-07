import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const storageDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'soat-convo-test-')
);

process.env.FILES_STORAGE_DIR = storageDir;
// Embeddings run through the AI SDK against an OpenAI-compatible endpoint. The
// suite uses the `openai` provider pointed at a local stub server (started in
// setupTestsAfterEnv, which sets EMBEDDING_BASE_URL); this exercises the real
// request serialization without a live backend. `openai` is chosen over
// `ollama` so OLLAMA_BASE_URL stays unset and `agentModel`'s default-URL tests
// remain valid.
process.env.EMBEDDING_PROVIDER = 'openai';
process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
process.env.EMBEDDING_API_KEY = 'test-embedding-key';
process.env.EMBEDDING_DIMENSIONS = '1024';
process.env.SECRETS_ENCRYPTION_KEY = '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.PORT = process.env.PORT || '15047';
