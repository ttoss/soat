import { jestUnitConfig } from '@ttoss/config';

export default jestUnitConfig({
  coverageThreshold: {
    global: {},
  },
  setupFiles: ['<rootDir>/setupTests.ts'],
});
