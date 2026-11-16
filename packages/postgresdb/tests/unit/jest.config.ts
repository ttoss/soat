import { jestUnitConfig } from '@ttoss/config';
import { getTransformIgnorePatterns } from '@ttoss/test-utils';

export default jestUnitConfig({
  globalSetup: '<rootDir>/globalSetup.ts',
  globalTeardown: '<rootDir>/globalTeardown.ts',
  setupFiles: ['<rootDir>/setupTests.ts'],
  transformIgnorePatterns: getTransformIgnorePatterns({
    // ESM-only dist outputs (no CJS `require` export condition).
    esmModules: ['@ttoss/postgresdb', 'nanoid'],
  }),
});
