import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import { mergeOpenApiSpecs } from '@ttoss/openapi-codegen';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');
const MERGED_SPEC_FILE = path.resolve(__dirname, '../merged-spec.json');
const SDK_ROOT = path.resolve(__dirname, '..');

const main = async () => {
  const merged = mergeOpenApiSpecs({
    specsDir: SPECS_DIR,
    info: {
      title: 'SOAT API',
      version: '1.0.0',
      description: 'SOAT unified API',
    },
  });

  fs.writeFileSync(MERGED_SPEC_FILE, JSON.stringify(merged, null, 2));

  // eslint-disable-next-line no-console
  console.log(`Merged spec written to: ${MERGED_SPEC_FILE}`);

  try {
    execSync('pnpm exec openapi-ts --file openapi-ts.config.ts', {
      cwd: SDK_ROOT,
      stdio: 'inherit',
    });
  } finally {
    fs.unlinkSync(MERGED_SPEC_FILE);
  }

  // eslint-disable-next-line no-console
  console.log('SDK generation complete.');
};

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
