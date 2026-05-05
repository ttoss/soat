import { jestUnitConfig } from '@ttoss/config';
import { getTransformIgnorePatterns } from '@ttoss/test-utils';

export default jestUnitConfig({
  coverageThreshold: {
    './src/**/*.ts': {
      branches: 57,
      functions: 57,
      lines: 57,
      statements: 57,
    },
  },
  maxWorkers: 2,
  setupFiles: ['<rootDir>/setupTests.ts'],
  setupFilesAfterEnv: ['<rootDir>/setupTestsAfterEnv.ts'],
  transformIgnorePatterns: getTransformIgnorePatterns({
    esmModules: ['@ttoss/postgresdb', '@ttoss/http-server-mcp', 'nanoid'],
  }),
});
