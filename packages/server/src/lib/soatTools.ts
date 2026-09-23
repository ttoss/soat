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
  type OpenApiDocuments,
  type OpenApiSpec,
  openApiToToolDefinitions,
  type ToolDefinition as OpenApiToolDefinition,
} from '@ttoss/http-server-mcp-openapi';
import createDebug from 'debug';
import { load } from 'js-yaml';

import { getActionForOperation } from './permissionCatalog';
import { readResourceRef, type SoatResourceRef } from './soatToolsResource';

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

/**
 * Markers that keep a value out of the tool schema, all meaning "the model may
 * not set this":
 *
 * - `x-soat-server-managed` — the platform supplies it (trace lineage, call
 *   depth); honored when the server injects it (`acceptedBodyFields`).
 * - `x-soat-tool-unsupported` — a response mode a tool call cannot receive,
 *   such as an SSE stream.
 * - `x-soat-tool-forced` — pinned to its string value for every tool call
 *   (`wait: 'true'` on endpoints a tool caller cannot poll).
 */
const SERVER_MANAGED_EXTENSIONS = [
  'x-soat-server-managed',
  'x-soat-tool-unsupported',
  'x-soat-tool-forced',
];

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
  return (
    args.def.path(args.args) + (args.def.query ? args.def.query(args.args) : '')
  );
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

/** Keeps only the REST operations; see {@link REST_PATH_PREFIX}. */
const restPathsOnly = (spec: OpenApiSpec): OpenApiSpec => {
  const paths = Object.fromEntries(
    Object.entries(spec.paths ?? {}).filter(([pathTemplate]) => {
      return pathTemplate.startsWith(REST_PATH_PREFIX);
    })
  );
  return { ...spec, paths };
};

const loadToolDefinitions = (): ToolDefinition[] => {
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

  // Every spec is also a `$ref` target: shared components (tags, filters) are
  // written once in a sibling file and referenced as `./tags.yaml#/…`.
  const documents: OpenApiDocuments = {};
  for (const file of files) {
    const spec = readSpec(path.join(specDir, file));
    if (spec) documents[`./${file}`] = spec;
  }

  return openApiToToolDefinitions({
    spec: Object.values(documents).map(restPathsOnly),
    options: {
      argumentNames: 'verbatim',
      excludeExtension: 'x-soat-mcp-exclude',
      serverManagedExtension: SERVER_MANAGED_EXTENSIONS,
      documents,
    },
  }).map(toSoatTool);
};

export const soatTools = loadToolDefinitions();
