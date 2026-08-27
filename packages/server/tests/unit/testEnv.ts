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
  // `openai` rather than `ollama`, so OLLAMA_BASE_URL stays unset and
  // `agentModel`'s default-URL tests remain valid.
  process.env.EMBEDDING_PROVIDER = 'openai';
  process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
  process.env.EMBEDDING_API_KEY = 'test-embedding-key';
  process.env.EMBEDDING_DIMENSIONS = '1024';
  process.env.SECRETS_ENCRYPTION_KEY = '0'.repeat(64);
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
  // Egress is default-deny for non-public destinations, and nearly every tool
  // test points at loopback — so the suite declares it, as the smoke stack does
  // its containers. Tests asserting the *block* pass their own allowlist.
  process.env.TOOL_EGRESS_ALLOWED_HOSTS = '127.0.0.1,localhost,::1';
};
