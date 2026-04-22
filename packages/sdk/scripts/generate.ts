import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import yaml from 'js-yaml';
import openapiTS, { astToString } from 'openapi-typescript';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');

const OUTPUT_FILE = path.resolve(__dirname, '../src/generated/openapi.ts');

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
  const ast = await openapiTS(merged as any);
  const output = astToString(ast);

  const outputDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(
    OUTPUT_FILE,
    `// THIS FILE IS AUTO-GENERATED. DO NOT EDIT MANUALLY.\n// Run \`pnpm generate\` to regenerate.\n\n${output}`
  );

  // eslint-disable-next-line no-console
  console.log(`Generated: ${OUTPUT_FILE}`);
};

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
