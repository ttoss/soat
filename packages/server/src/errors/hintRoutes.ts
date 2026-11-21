/**
 * A hint names a route as a token, `{{PATCH /agents/{agent_id}}}`, with the
 * path relative to the deployment's route prefix, so a deployment serving the
 * API under another prefix renders hints that name its own routes. The OpenAPI
 * document is `{{openapi_document}}`, at a path set apart from the prefix.
 */

export const ROUTE_PREFIX_ENV = 'SOAT_ROUTE_PREFIX';

const DEFAULT_ROUTE_PREFIX = '/api/v1';

/** Read per call, like `docsBaseUrl()`. */
export const routePrefix = (): string => {
  const value = process.env[ROUTE_PREFIX_ENV]?.trim();
  return value ? value.replace(/\/+$/, '') : DEFAULT_ROUTE_PREFIX;
};

export const OPENAPI_DOCUMENT_ENV = 'SOAT_OPENAPI_DOCUMENT_PATH';

export const DEFAULT_OPENAPI_DOCUMENT = '/api/v1/openapi.json';

/** Read per call, like `routePrefix()`. */
export const openapiDocumentPath = (): string => {
  return process.env[OPENAPI_DOCUMENT_ENV]?.trim() || DEFAULT_OPENAPI_DOCUMENT;
};

const OPENAPI_DOCUMENT_TOKEN = '{{openapi_document}}';

export type HintRoute = { method: string; path: string };

// The lookahead lets a path end in a parameter: `{agent_id}}}` closes on the
// last two braces.
const ROUTE_TOKEN = /\{\{(GET|POST|PUT|PATCH|DELETE) (\/[^\s]*?)\}\}(?!\})/g;

/** The routes a hint template names, in order. */
export const hintRoutes = (args: { template: string }): HintRoute[] => {
  return [...args.template.matchAll(ROUTE_TOKEN)].map((match) => {
    return { method: match[1], path: match[2] };
  });
};

/**
 * A hint template with every route token rendered under `prefix` and the
 * OpenAPI document token as `openapiDocument`.
 */
export const renderHint = (args: {
  template: string;
  prefix?: string;
  openapiDocument?: string;
}): string => {
  const prefix = args.prefix ?? routePrefix();
  return args.template
    .replace(ROUTE_TOKEN, (_token, method, path) => {
      return `${method} ${prefix}${path}`;
    })
    .replaceAll(
      OPENAPI_DOCUMENT_TOKEN,
      args.openapiDocument ?? openapiDocumentPath()
    );
};
