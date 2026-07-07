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
