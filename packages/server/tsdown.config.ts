import * as fs from 'node:fs';
import * as path from 'node:path';

import { tsdownConfig } from '@ttoss/config';

/**
 * Copies OpenAPI YAML spec files to dist/rest/openapi/v1/ so that
 * the bundled server can resolve them at runtime via import.meta.url.
 *
 * In the ESM bundle, `__dirname` resolves to `dist/esm/`, so the code
 * in soatTools.ts looks for YAML files at `dist/rest/openapi/v1/`.
 */
const copyOpenApiFiles = () => {
  const srcDir = path.resolve('src/rest/openapi/v1');
  const destDir = path.resolve('dist/rest/openapi/v1');
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of fs.readdirSync(srcDir)) {
    if (file.endsWith('.yaml')) {
      fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
    }
  }
};

/**
 * Copies the permission definition JSON files to dist/permissions/ so the
 * bundled server can build the permission catalog at runtime. In the ESM bundle
 * `__dirname` is `dist/esm/`, so `permissionCatalog.ts` resolves the catalog via
 * `../permissions` → `dist/permissions`. Without this the catalog is empty and
 * catalog-backed action validation cannot recognize any action.
 */
const copyPermissionFiles = () => {
  const srcDir = path.resolve('src/permissions');
  const destDir = path.resolve('dist/permissions');
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of fs.readdirSync(srcDir)) {
    if (file.endsWith('.json')) {
      fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
    }
  }
};

export default {
  ...tsdownConfig(),
  entry: ['src/server.ts'],
  format: ['esm'],
  sourcemap: true,
  onSuccess: () => {
    copyOpenApiFiles();
    copyPermissionFiles();
  },
};
