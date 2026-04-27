import { tsupConfig } from '@ttoss/config';

export const tsup = {
  ...tsupConfig({
    entry: ['src/server.ts'],
  }),
  format: ['esm'],
};
