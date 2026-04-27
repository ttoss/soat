import { tsupConfig } from '@ttoss/config';

export const tsup = { ...tsupConfig(), format: ['esm'] as const, dts: false };
