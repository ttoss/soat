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
      branches: 69,
      functions: 69,
      lines: 69,
      statements: 69,
    },
  },
  maxWorkers: 4,
  setupFiles: ['<rootDir>/setupTests.ts'],
  setupFilesAfterEnv: ['<rootDir>/setupTestsAfterEnv.ts'],
  transformIgnorePatterns: getTransformIgnorePatterns({
    esmModules: ['@ttoss/postgresdb', '@ttoss/http-server-mcp', 'nanoid'],
  }),
});
