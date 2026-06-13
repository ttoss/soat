import { buildUrl } from './specUtils';
import type { ModuleInfo, OpenApiSpec, ViewDescriptor, ViewMode } from './types';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

// Match a concrete URL path against an API path template (e.g. /api/v1/agents/{agent_id}).
// Returns extracted path params on match, null otherwise.
export const matchTemplate = (
  urlPath: string,
  apiTemplate: string
): Record<string, string> | null => {
  const urlParts = urlPath.split('/').filter(Boolean);
  const templateParts = apiTemplate.split('/').filter(Boolean);
  if (urlParts.length !== templateParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < templateParts.length; i++) {
    const t = templateParts[i];
    const u = urlParts[i];
    if (t.startsWith('{') && t.endsWith('}')) {
      params[t.slice(1, -1)] = decodeURIComponent(u);
    } else if (t !== u) {
      return null;
    }
  }
  return params;
};

const appToApi = (appPath: string): string =>
  appPath.replace(/^\/app\//, '/api/');

const apiToApp = (apiPath: string): string =>
  apiPath.replace(/^\/api\//, '/app/');

// Find the path template for a given operationId. Handles both camelCase
// operationId and the snake_case operation_id the server emits.
const findPathTemplate = (
  operationId: string,
  spec: OpenApiSpec
): string | null => {
  for (const [template, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const raw = pathItem[method] as Record<string, unknown> | undefined;
      if (!raw) continue;
      const opId = (raw['operationId'] ?? raw['operation_id']) as
        | string
        | undefined;
      if (opId === operationId) return template;
    }
  }
  return null;
};

// Convert a ViewDescriptor to an app URL path like /app/v1/agents/agt_123.
export const viewToPath = (
  descriptor: ViewDescriptor,
  spec: OpenApiSpec
): string | null => {
  const template = findPathTemplate(descriptor.operationId, spec);
  if (!template) return null;

  const apiPath = buildUrl(template, descriptor.pathParams);
  const appPath = apiToApp(apiPath);

  if (descriptor.mode === 'create') return `${appPath}/new`;
  if (descriptor.mode === 'edit') return `${appPath}/edit`;
  return appPath;
};

// Derive a ViewDescriptor from the current app URL pathname + loaded spec.
export const pathToView = (
  pathname: string,
  spec: OpenApiSpec,
  modules: ModuleInfo[]
): ViewDescriptor | null => {
  // /new suffix → create mode
  if (pathname.endsWith('/new')) {
    const parentAppPath = pathname.slice(0, -4);
    const parentApiPath = appToApi(parentAppPath);
    for (const mod of modules) {
      if (!mod.createOp || !mod.listOp) continue;
      const params = matchTemplate(parentApiPath, mod.listOp.pathTemplate);
      if (params !== null) {
        return {
          tag: mod.tag,
          operationId: mod.createOp.operation.operationId,
          pathParams: params,
          mode: 'create',
        };
      }
    }
    return null;
  }

  // /edit suffix → edit mode
  if (pathname.endsWith('/edit')) {
    const itemAppPath = pathname.slice(0, -5);
    const itemApiPath = appToApi(itemAppPath);
    for (const mod of modules) {
      if (!mod.updateOp || !mod.getOp) continue;
      const params = matchTemplate(itemApiPath, mod.getOp.pathTemplate);
      if (params !== null) {
        return {
          tag: mod.tag,
          operationId: mod.updateOp.operation.operationId,
          pathParams: params,
          mode: 'edit',
        };
      }
    }
    return null;
  }

  const apiPath = appToApi(pathname);

  for (const [template, pathItem] of Object.entries(spec.paths ?? {})) {
    const params = matchTemplate(apiPath, template);
    if (params === null) continue;

    const raw = pathItem as Record<string, Record<string, unknown> | undefined>;
    const getOp = raw['get'];
    const postOp = raw['post'];

    if (getOp) {
      const opId = (getOp['operationId'] ?? getOp['operation_id']) as string;
      const tag = (getOp['tags'] as string[] | undefined)?.[0] ?? 'Other';
      const lastSegment = template.split('/').filter(Boolean).pop() ?? '';
      const mode: ViewMode = lastSegment.startsWith('{') ? 'detail' : 'list';
      return { tag, operationId: opId, pathParams: params, mode };
    }

    if (postOp) {
      const opId = (postOp['operationId'] ?? postOp['operation_id']) as string;
      const tag = (postOp['tags'] as string[] | undefined)?.[0] ?? 'Other';
      return { tag, operationId: opId, pathParams: params, mode: 'action' };
    }
  }

  return null;
};

// Extract project_id from the view's path params (if any).
export const extractProjectId = (view: ViewDescriptor | null): string | null =>
  view?.pathParams['project_id'] ?? null;
