import { jestUnitConfig } from '@ttoss/config';
import { getTransformIgnorePatterns } from '@ttoss/test-utils';

export default jestUnitConfig({
  // pdf.ts uses unpdf (ESM-only dynamic imports) that can't run in Jest's CJS VM context.
  // extractPdfPages is mocked in integration tests; exclude pdf.ts from coverage collection.
  collectCoverageFrom: [
    '<rootDir>/../../src/**/*.{ts,tsx,js,jsx}',
    '!<rootDir>/../../src/**/*.d',
    '!<rootDir>/../../src/lib/pdf.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 100,
      lines: 98,
      statements: 97,
    },
    './src/**/*.ts': {
      branches: 75,
      lines: 75,
      statements: 75,
    },
  },
  maxWorkers: 4,
  // One PostgreSQL for the whole run, with a pre-built schema every test file
  // clones. See `testDatabase.ts`.
  globalSetup: '<rootDir>/globalSetup.ts',
  globalTeardown: '<rootDir>/globalTeardown.ts',
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
