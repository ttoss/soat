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
      branches: 81,
      functions: 81,
      lines: 81,
      statements: 81,
    },
    './src/**/*.ts': {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
  maxWorkers: 4,
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
