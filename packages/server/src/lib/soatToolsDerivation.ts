/**
 * Specs in, tool definitions out: the one derivation of the SOAT tool surface.
 * The server's `soatTools` wraps its result with SOAT metadata, and the
 * website's MCP tools reference reads it, so the two cannot list different
 * arguments. It depends only on the derivation library, never on the server.
 */

import {
  type OpenApiDocuments,
  type OpenApiSpec,
  openApiToToolDefinitions,
  type ToolDefinition,
} from '@ttoss/http-server-mcp-openapi';

import { prepareToolExtensions } from './soatToolsExtensions';

export type { ToolDefinition };

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
 * - `x-soat-tool-forced` — pinned for every tool call to its value, written as
 *   the field's own type (`wait: true` on endpoints a tool caller cannot
 *   poll). `soatToolsExtensions.ts` checks each spelling.
 */
const SERVER_MANAGED_EXTENSIONS = [
  'x-soat-server-managed',
  'x-soat-tool-unsupported',
  'x-soat-tool-forced',
];

/** Keeps only the REST operations; see {@link REST_PATH_PREFIX}. */
const restPathsOnly = (spec: OpenApiSpec): OpenApiSpec => {
  const paths = Object.fromEntries(
    Object.entries(spec.paths ?? {}).filter(([pathTemplate]) => {
      return pathTemplate.startsWith(REST_PATH_PREFIX);
    })
  );
  return { ...spec, paths };
};

/**
 * Every tool the specs describe. Each spec is also a `$ref` target: shared
 * components (tags, filters) are written once in a sibling file and
 * referenced as `./tags.yaml#/…`, so `specs` must hold all of them.
 */
export const deriveToolDefinitions = (args: {
  specs: Array<{ file: string; spec: OpenApiSpec }>;
  /** @default 'compact' — see `soatMcpTools` for why only MCP takes `full`. */
  schemaDetail?: 'compact' | 'full';
}): ToolDefinition[] => {
  const documents: OpenApiDocuments = {};
  for (const { file, spec } of args.specs) {
    documents[`./${file}`] = prepareToolExtensions({ spec, file });
  }

  return openApiToToolDefinitions({
    spec: Object.values(documents).map(restPathsOnly),
    options: {
      argumentNames: 'verbatim',
      excludeExtension: 'x-soat-mcp-exclude',
      serverManagedExtension: SERVER_MANAGED_EXTENSIONS,
      documents,
      schemaDetail: args.schemaDetail,
    },
  });
};
