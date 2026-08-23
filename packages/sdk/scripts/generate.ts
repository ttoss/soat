import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import { mergeOpenApiSpecs } from '@ttoss/openapi-codegen';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');
const MERGED_SPEC_FILE = path.resolve(__dirname, '../merged-spec.json');
const SDK_ROOT = path.resolve(__dirname, '..');

/**
 * The prefix every REST operation shares. `oauth.yaml` also describes the
 * OAuth 2.1 protocol endpoints, which are mounted at the root with paths the
 * RFCs fix; they belong in the published description so a client can find the
 * flow, but not in a generated client. `/authorize` is a browser redirect with
 * no body to return, and `/token` takes a form-encoded body this codegen would
 * emit as JSON — a generated function for either would be broken rather than
 * merely unused. The server applies the same rule to its MCP tool surface
 * (`REST_PATH_PREFIX` in `src/lib/soatTools.ts`).
 */
const REST_PATH_PREFIX = '/api/v1/';

const main = async () => {
  const merged = mergeOpenApiSpecs({
    specsDir: SPECS_DIR,
    info: {
      title: 'SOAT API',
      version: '1.0.0',
      description: 'SOAT unified API',
    },
  });

  const restPaths = Object.fromEntries(
    Object.entries(merged.paths ?? {}).filter(([specPath]) => {
      return specPath.startsWith(REST_PATH_PREFIX);
    })
  );

  const skipped =
    Object.keys(merged.paths ?? {}).length - Object.keys(restPaths).length;
  if (skipped > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `Skipped ${skipped} non-REST path(s) outside ${REST_PATH_PREFIX}`
    );
  }

  fs.writeFileSync(
    MERGED_SPEC_FILE,
    JSON.stringify({ ...merged, paths: restPaths }, null, 2)
  );

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
