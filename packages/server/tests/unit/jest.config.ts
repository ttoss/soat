import { jestUnitConfig } from '@ttoss/config';
import { getTransformIgnorePatterns } from '@ttoss/test-utils';

export default jestUnitConfig({
  coverageThreshold: {
    global: {},
  },
  // setupFiles: ['<rootDir>/setupTests.ts'],
  setupFilesAfterEnv: ['<rootDir>/setupTestsAfterEnv.ts'],
  transformIgnorePatterns: getTransformIgnorePatterns({
    esmModules: ['@ttoss/postgresdb', '@ttoss/http-server-mcp', 'nanoid'],
  }),
});
