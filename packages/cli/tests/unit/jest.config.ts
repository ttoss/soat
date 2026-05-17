import { jestUnitConfig } from '@ttoss/config';
import { getTransformIgnorePatterns } from '@ttoss/test-utils';

export default jestUnitConfig({
  coverageThreshold: {
    './src/**/*.ts': {
      branches: 65,
      functions: 65,
      lines: 65,
      statements: 65,
    },
  },
  setupFiles: ['<rootDir>/setupTests.ts'],
  setupFilesAfterEnv: ['<rootDir>/setupTestsAfterEnv.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: getTransformIgnorePatterns({
    esmModules: ['@soat/sdk', '@inquirer/input', '@inquirer/password'],
  }),
});
