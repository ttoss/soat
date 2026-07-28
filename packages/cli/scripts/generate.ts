/**
 * Reads all OpenAPI YAML specs and generates src/generated/routes.ts —
 * a typed manifest mapping kebab-case CLI command names to their SDK
 * service class, operationId, and parameter lists.
 *
 * Run via: pnpm generate
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import {
  generateCliRouteManifest,
  renderCliRoutesSource,
} from '@ttoss/openapi-codegen';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');
const OUT_FILE = path.resolve(__dirname, '../src/generated/routes.ts');
const MODULE_DOCS_BASE_URL = 'https://soat.ttoss.dev/docs/modules';

const routes = generateCliRouteManifest({
  specsDir: SPECS_DIR,
  moduleDocsUrl: (moduleSlug) => {
    return `${MODULE_DOCS_BASE_URL}/${moduleSlug}`;
  },
});

fs.writeFileSync(OUT_FILE, renderCliRoutesSource(routes));
// eslint-disable-next-line no-console
console.log(`Generated ${Object.keys(routes).length} routes → ${OUT_FILE}`);
