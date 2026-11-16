/**
 * A hint names a route as a token, `{{PATCH /agents/{agent_id}}}`, with the
 * path relative to the deployment's route prefix, so a deployment serving the
 * API under another prefix renders hints that name its own routes.
 */

export const ROUTE_PREFIX_ENV = 'SOAT_ROUTE_PREFIX';

const DEFAULT_ROUTE_PREFIX = '/api/v1';

/** Read per call, like `docsBaseUrl()`. */
export const routePrefix = (): string => {
  const value = process.env[ROUTE_PREFIX_ENV]?.trim();
  return value ? value.replace(/\/+$/, '') : DEFAULT_ROUTE_PREFIX;
};

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

/** A hint template with every route token rendered under `prefix`. */
export const renderHint = (args: {
  template: string;
  prefix?: string;
}): string => {
  const prefix = args.prefix ?? routePrefix();
  return args.template.replace(ROUTE_TOKEN, (_token, method, path) => {
    return `${method} ${prefix}${path}`;
  });
};
