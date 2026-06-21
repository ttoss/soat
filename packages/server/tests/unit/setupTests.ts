import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const storageDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'soat-convo-test-')
);

export const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soat-docs-test-'));

fs.mkdirSync(path.join(docsDir, 'modules'), { recursive: true });
fs.writeFileSync(
  path.join(docsDir, 'introduction.md'),
  '# Introduction\n\nSOAT is an infrastructure platform for AI apps.\n'
);
fs.writeFileSync(
  path.join(docsDir, 'modules', 'agents.md'),
  '# Agents\n\nAgents are the core reasoning units that run LLM inference loops.\n'
);

process.env.FILES_STORAGE_DIR = storageDir;
process.env.DOCS_PATH = docsDir;
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.EMBEDDING_MODEL = 'qwen3-embedding:0.6b';
process.env.EMBEDDING_DIMENSIONS = '1024';
process.env.SECRETS_ENCRYPTION_KEY = '0'.repeat(64);
process.env.PORT = process.env.PORT || '15047';
