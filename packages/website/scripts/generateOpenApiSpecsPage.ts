/**
 * Generates packages/website/docs/openapi-specs.md listing all OpenAPI spec URLs.
 * Run with: pnpm tsx scripts/generateOpenApiSpecsPage.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');

const OUTPUT_FILE = path.resolve(__dirname, '../docs/openapi-specs.md');

const BASE_URL = '/openapi';

const formatTitle = (name: string): string => {
  return name
    .split('-')
    .map((word) => {
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
};

const generate = () => {
  const files = fs
    .readdirSync(SPECS_DIR)
    .filter((f) => {
      return f.endsWith('.yaml');
    })
    .sort();

  const rows = files
    .map((file) => {
      const name = path.basename(file, '.yaml');
      const title = formatTitle(name);
      const url = `${BASE_URL}/${file}`;
      return `| ${title} | [${url}](${url}) |`;
    })
    .join('\n');

  const content = `---
title: OpenAPI Specifications
description: Machine-readable OpenAPI YAML specifications for the SOAT REST API.
---

# OpenAPI Specifications

The SOAT REST API is fully documented using OpenAPI 3.x specifications. Each module has its own YAML file served at \`/openapi/<module>.yaml\`.

These specs can be used directly with any OpenAPI-compatible tool (Postman, Swagger UI, code generators, AI agents, etc.).

| Module | URL |
| ------ | --- |
${rows}
`;

  fs.writeFileSync(OUTPUT_FILE, content, 'utf-8');
};

generate();
