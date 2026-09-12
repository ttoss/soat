import { jestE2EConfig } from '@ttoss/config';
import { getTransformIgnorePatterns } from '@ttoss/test-utils';

/**
 * The retrieval eval runs as a Jest project of its own, alongside `tests/unit`
 * rather than inside it. `pr.yml` runs the unit suite as `--projects tests/unit`
 * with `--shard=N/4`, and `server-coverage` resolves its thresholds from the
 * same config — so a second project here is invisible to both, while the
 * testcontainer, `testDatabase.ts` and the embedding stub are reused verbatim.
 */
export default jestE2EConfig({
  displayName: 'Knowledge Eval',
  // One database, one seed, one ranking: the eval is a single whole run by
  // definition, and splitting it across workers or shards would score each
  // query against a different slice of the corpus.
  maxWorkers: 1,
  testMatch: ['<rootDir>/**/*.eval.ts'],
  globalSetup: '<rootDir>/../unit/globalSetup.ts',
  globalTeardown: '<rootDir>/../unit/globalTeardown.ts',
  setupFiles: ['<rootDir>/setupTests.ts'],
  setupFilesAfterEnv: ['<rootDir>/setupTestsAfterEnv.ts'],
  transformIgnorePatterns: getTransformIgnorePatterns({
    // AI SDK v7 packages (and their transitive deps) are ESM-only (no CJS
    // `require` export condition).
    esmModules: [
      '@ttoss/postgresdb',
      '@ttoss/http-server-mcp',
      'nanoid',
      'ai',
      '@ai-sdk/.+',
      '@workflow/.+',
      '@vercel/oidc',
    ],
  }),
});
