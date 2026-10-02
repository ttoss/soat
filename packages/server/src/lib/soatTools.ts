/**
 * SOAT Tools - the platform actions agents and MCP clients can invoke, one per
 * REST operation, derived from the OpenAPI specs by
 * `@ttoss/http-server-mcp-openapi`. This module adds only what is SOAT's: the
 * IAM action, the resource an argument names, and the agent exclusion.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import type { JsonObjectSchema } from '@ttoss/http-server-mcp';
import {
  type OpenApiSpec,
  type ToolDefinition as OpenApiToolDefinition,
} from '@ttoss/http-server-mcp-openapi';
import createDebug from 'debug';
import { load } from 'js-yaml';

import { DomainError } from '../errors';
import { getActionForOperation } from './permissionCatalog';
import { deriveToolDefinitions } from './soatToolsDerivation';
import { readResourceRef, type SoatResourceRef } from './soatToolsResource';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const log = createDebug('soat:tools');

export { REST_PATH_PREFIX } from './soatToolsDerivation';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
  method: string;
  path: (args: Record<string, unknown>) => string;
  query?: (args: Record<string, unknown>) => string;
  body?: (args: Record<string, unknown>) => Record<string, unknown>;
  iamAction?: string;
  /** See `x-soat-resource` in `soatToolsResource.ts`. */
  resource?: SoatResourceRef;
  /** snake_case names of every top-level request body property this operation's schema declares, including server-managed ones. */
  acceptedBodyFields: string[];
  /** The operation's path, as the spec writes it (`/api/v1/agents/{agent_id}`). */
  pathTemplate: string;
  /**
   * `x-soat-agent-exclude`: kept in the catalog rather than dropped like an
   * MCP exclusion, because the operation is still an MCP tool and the
   * write-time refusal needs to tell an excluded action apart from one that
   * does not exist.
   */
  agentExcluded?: boolean;
}

/**
 * The request target an action is called with: its path with the path
 * parameters substituted, followed by the query string its `in: query`
 * parameters build.
 *
 * Both halves live here rather than at each call site: kept apart, one caller
 * builds the path alone and drops every query parameter the action advertises
 * while another appends both. One way to address an action means a new caller
 * cannot make that omission.
 */
export const buildSoatActionTarget = (args: {
  def: ToolDefinition;
  args: Record<string, unknown>;
}): string => {
  let target: string;
  try {
    // Building fails only on the caller's arguments — a missing path one —
    // so it is their 400, not this process's 500.
    target = args.def.path(args.args);
  } catch (error) {
    throw new DomainError(
      'VALIDATION_FAILED',
      error instanceof Error ? error.message : String(error)
    );
  }
  return target + (args.def.query ? args.def.query(args.args) : '');
};

const toSoatTool = (tool: OpenApiToolDefinition): ToolDefinition => {
  const { extensions } = tool;
  const iamAction = extensions['x-iam-action'];
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    method: tool.method,
    path: tool.path,
    query: tool.query,
    body: tool.body,
    // Resolved from the same operationId→action catalog the route handlers
    // enforce, so `boundary_policy` is evaluated against a name a policy
    // author may write. `x-iam-action` overrides per operation.
    iamAction:
      typeof iamAction === 'string'
        ? iamAction
        : getActionForOperation(tool.operationId),
    resource: readResourceRef(extensions['x-soat-resource']),
    acceptedBodyFields: tool.acceptedBodyFields,
    pathTemplate: tool.pathTemplate,
    ...(extensions['x-soat-agent-exclude'] ? { agentExcluded: true } : {}),
  };
};

const readSpec = (filePath: string): OpenApiSpec | null => {
  try {
    return load(fs.readFileSync(filePath, 'utf-8')) as OpenApiSpec;
  } catch (error) {
    log('readSpec: error reading %s error=%o', filePath, error);
    return null;
  }
};

const loadSpecs = (): Array<{ file: string; spec: OpenApiSpec }> => {
  const candidate1 = path.resolve(__dirname, '../rest/openapi/v1');
  const candidate2 = path.resolve(__dirname, 'rest/openapi/v1');
  const specDir = fs.existsSync(candidate1) ? candidate1 : candidate2;

  if (!fs.existsSync(specDir)) return [];

  const files = fs
    .readdirSync(specDir)
    .filter((f) => {
      return f.endsWith('.yaml');
    })
    .sort();

  return files.flatMap((file) => {
    const spec = readSpec(path.join(specDir, file));
    return spec ? [{ file, spec }] : [];
  });
};

const specs = loadSpecs();

export const soatTools = deriveToolDefinitions({ specs }).map(toSoatTool);

/**
 * `soatTools` with each input schema in full — bounds, enums, nested fields —
 * for MCP clients, which validate against it. Agents keep the compact form:
 * their tools go to every configured provider, whose tool-schema dialects
 * accept less than JSON Schema does.
 */
export const soatMcpTools = deriveToolDefinitions({
  specs,
  schemaDetail: 'full',
}).map(toSoatTool);
