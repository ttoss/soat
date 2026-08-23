/**
 * SOAT Tools - Dynamically loads available tools from MCP tool definitions.
 * Each tool represents a platform action that can be invoked by agents.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import createDebug from 'debug';
import { load } from 'js-yaml';

import type {
  OpenApiSpec,
  OperationSpec,
  ToolDefinition,
} from './soatToolsHelpers';
import { processPath } from './soatToolsHelpers';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const log = createDebug('soat:tools');

/**
 * The prefix every REST operation shares. The specs also describe endpoints
 * mounted at the root — the OAuth 2.1 protocol endpoints in `oauth.yaml`, whose
 * paths the RFCs fix — and those are described for discovery, not for wrapping:
 * `/authorize` is a browser redirect, and `/token` takes a form-encoded body no
 * JSON-shaped generated caller can send. Pinned by
 * `tests/unit/tests/lib/soatToolsApiSurface.test.ts`, and mirrored by the SDK
 * and CLI generators, which draw their surface from the same specs.
 */
export const REST_PATH_PREFIX = '/api/v1/';

const loadToolDefinitions = (): ToolDefinition[] => {
  // In tests (ts-jest), __dirname is src/lib/ — specs are at ../rest/openapi/v1.
  // In the production bundle, __dirname is dist/ — specs are copied to rest/openapi/v1.
  const candidate1 = path.resolve(__dirname, '../rest/openapi/v1');
  const candidate2 = path.resolve(__dirname, 'rest/openapi/v1');
  const specDir = fs.existsSync(candidate1) ? candidate1 : candidate2;
  const tools: ToolDefinition[] = [];

  if (!fs.existsSync(specDir)) return tools;

  const files = fs
    .readdirSync(specDir)
    .filter((f) => {
      return f.endsWith('.yaml');
    })
    .sort();

  for (const file of files) {
    try {
      const filePath = path.join(specDir, file);
      const spec = load(fs.readFileSync(filePath, 'utf-8')) as OpenApiSpec;
      const paths = spec.paths || {};

      for (const [pathTemplate, pathItem] of Object.entries(paths)) {
        if (!pathTemplate.startsWith(REST_PATH_PREFIX)) {
          log('loadToolDefinitions: skipping non-REST path %s', pathTemplate);
          continue;
        }

        const pathTools = processPath({
          pathTemplate,
          pathItem: pathItem as Record<string, OperationSpec>,
          spec,
        });
        tools.push(...pathTools);
      }
    } catch (error) {
      log('loadToolDefinitions: error processing %s error=%o', file, error);
    }
  }

  return tools;
};

export const soatTools = loadToolDefinitions();
