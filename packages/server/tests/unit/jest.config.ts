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
  // Target thresholds (tracked goal, not all met yet):
  //   global:    { branches: 90, functions: 95, lines: 90, statements: 90 }
  //   per-file:  { branches: 75, functions: 85, lines: 80, statements: 80 }
  // Global branches and several files (mostly formation-module `functions`
  // coverage) are still short of the targets above. Metrics that already met
  // the target keep that value; the rest stay at their last passing number
  // until coverage is added to close the gap.
  coverageThreshold: {
    global: {
      branches: 84,
      functions: 95,
      lines: 90,
      statements: 90,
    },
    './src/**/*.ts': {
      branches: 75,
      functions: 70,
      lines: 76,
      statements: 76,
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
