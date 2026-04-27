import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import yaml from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');
const MERGED_SPEC_FILE = path.resolve(__dirname, '../merged-spec.json');
const SDK_ROOT = path.resolve(__dirname, '..');

interface OpenApiSpec {
  openapi: string;
  info?: Record<string, unknown>;
  servers?: unknown[];
  paths?: Record<string, unknown>;
  components?: {
    schemas?: Record<string, unknown>;
    responses?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
  };
  security?: unknown[];
}

// eslint-disable-next-line complexity
const main = async () => {
  const specFiles = fs
    .readdirSync(SPECS_DIR)
    .filter((f) => {
      return f.endsWith('.yaml');
    })
    .sort()
    .map((f) => {
      return path.join(SPECS_DIR, f);
    });

  const merged: OpenApiSpec = {
    openapi: '3.0.3',
    info: {
      title: 'SOAT API',
      version: '1.0.0',
      description: 'SOAT unified API',
    },
    servers: [{ url: '/api/v1', description: 'API v1' }],
    paths: {},
    components: {
      schemas: {},
      responses: {},
      securitySchemes: {},
      parameters: {},
    },
  };

  for (const file of specFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const spec = yaml.load(content) as OpenApiSpec;

    if (spec.paths) {
      Object.assign(merged.paths!, spec.paths);
    }

    if (spec.components?.schemas) {
      for (const [name, schema] of Object.entries(spec.components.schemas)) {
        if (!(name in merged.components!.schemas!)) {
          merged.components!.schemas![name] = schema;
        }
      }
    }

    if (spec.components?.responses) {
      for (const [name, response] of Object.entries(
        spec.components.responses
      )) {
        if (!(name in merged.components!.responses!)) {
          merged.components!.responses![name] = response;
        }
      }
    }

    if (spec.components?.securitySchemes) {
      Object.assign(
        merged.components!.securitySchemes!,
        spec.components.securitySchemes
      );
    }

    if (spec.components?.parameters) {
      for (const [name, parameter] of Object.entries(
        spec.components.parameters
      )) {
        if (!(name in merged.components!.parameters!)) {
          merged.components!.parameters![name] = parameter;
        }
      }
    }
  }
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
