/**
 * Process-wide environment the unit suite needs, applied by both entry points
 * that load `@soat/postgresdb`: `globalSetup` (which builds the template
 * schema once, in the Jest main process) and `setupTests` (which runs in every
 * worker before a test file is loaded).
 *
 * `EMBEDDING_DIMENSIONS` is the reason this is shared rather than set twice.
 * `@soat/postgresdb` reads it *at module load* to size every `vector` column,
 * so the value the template schema is built with and the value the workers run
 * with must be identical. If they diverged, every worker would clone a schema
 * whose vector width no test expects — and the failure would surface as
 * unrelated embedding assertions, far from the cause.
 */
export const applyTestEnv = () => {
  // Embeddings run through the AI SDK against an OpenAI-compatible endpoint.
  // The suite uses the `openai` provider pointed at a local stub server
  // (started in setupTestsAfterEnv, which sets EMBEDDING_BASE_URL); this
  // exercises the real request serialization without a live backend. `openai`
  // is chosen over `ollama` so OLLAMA_BASE_URL stays unset and `agentModel`'s
  // default-URL tests remain valid.
  process.env.EMBEDDING_PROVIDER = 'openai';
  process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
  process.env.EMBEDDING_API_KEY = 'test-embedding-key';
  process.env.EMBEDDING_DIMENSIONS = '1024';
  process.env.SECRETS_ENCRYPTION_KEY = '0'.repeat(64);
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
};
