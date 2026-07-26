import { jestUnitConfig } from '@ttoss/config';
import { getTransformIgnorePatterns } from '@ttoss/test-utils';

export default jestUnitConfig({
  setupFiles: ['<rootDir>/setupTests.ts'],
  transformIgnorePatterns: getTransformIgnorePatterns({
    // ESM-only dist outputs (no CJS `require` export condition).
    esmModules: ['@ttoss/postgresdb', 'nanoid'],
  }),
});
