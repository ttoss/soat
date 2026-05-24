import { jestUnitConfig } from '@ttoss/config';
import { getTransformIgnorePatterns } from '@ttoss/test-utils';

export default jestUnitConfig({
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
    './src/**/*.ts': {
      branches: 65,
      functions: 65,
      lines: 65,
      statements: 65,
    },
  },
  maxWorkers: 4,
  setupFiles: ['<rootDir>/setupTests.ts'],
  setupFilesAfterEnv: ['<rootDir>/setupTestsAfterEnv.ts'],
  transformIgnorePatterns: getTransformIgnorePatterns({
    esmModules: ['@ttoss/postgresdb', '@ttoss/http-server-mcp', 'nanoid'],
  }),
});
