/**
 * Generates packages/website/docs/openapi-specs.md and copies OpenAPI specs to
 * packages/website/static/openapi.
 * Run with: pnpm tsx scripts/generateOpenApiSpecsPage.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');

const OUTPUT_FILE = path.resolve(__dirname, '../docs/openapi-specs.md');

const STATIC_OPENAPI_DIR = path.resolve(__dirname, '../static/openapi');

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

  fs.mkdirSync(STATIC_OPENAPI_DIR, { recursive: true });

  for (const file of files) {
    fs.copyFileSync(
      path.join(SPECS_DIR, file),
      path.join(STATIC_OPENAPI_DIR, file)
    );
  }

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
description: Machine-readable OpenAPI specifications for the SOAT REST API, as one merged bundle or one file per module.
---

# OpenAPI Specifications

The SOAT REST API is fully documented using OpenAPI 3.x specifications. They are
the source of truth for the [TypeScript SDK](./sdk/introduction.md), the
[\`soat\` CLI](./cli/introduction.md) and the [MCP tool surface](./mcp/introduction.md), and they
are published here for any OpenAPI-compatible tool — Postman, Swagger UI, code
generators, AI agents.

## Merged bundle

Every module in one document, with all \`$ref\`s resolved inside the bundle:

| Document | URL |
| -------- | --- |
| OpenAPI (JSON) | [/openapi.json](/openapi.json) |
| OpenAPI (YAML) | [/openapi.yaml](/openapi.yaml) |
| OpenAPI (YAML, \`/api\` path) | [/api/openapi.yaml](/api/openapi.yaml) |
| Error-code catalog (JSON) | [/errors.json](/errors.json) |

The bundle's \`servers\` entry is a \`baseUrl\` variable: SOAT is self-hosted, so
point it at your own deployment. A running deployment serves the same merged
document at \`/api/v1/openapi.json\` (authenticated).

Errors are documented twice over, for machines: the \`ErrorResponse\` schema
describes the envelope, and the \`x-error-codes\` extension — the same data as
[/errors.json](/errors.json) — lists every code with its HTTP status and
meaning. See [Error Responses](./api/index.md) for the contract in prose.

## Per-module specs

One YAML file per module, served at \`/openapi/<module>.yaml\`, for tools that
prefer a narrower surface.

| Module | URL |
| ------ | --- |
${rows}
`;

  fs.writeFileSync(OUTPUT_FILE, content, 'utf-8');
};

generate();
