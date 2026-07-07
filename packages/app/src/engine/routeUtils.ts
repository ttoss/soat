import { buildUrl } from './specUtils';
import type {
  ModuleInfo,
  OpenApiSpec,
  ViewDescriptor,
  ViewMode,
} from './types';

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

const appToApi = (appPath: string): string => {
  return appPath.replace(/^\/app\//, '/api/');
};

const apiToApp = (apiPath: string): string => {
  return apiPath.replace(/^\/api\//, '/app/');
};

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
        string | undefined;
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

const findCreateViewForPath = (
  apiPath: string,
  modules: ModuleInfo[]
): ViewDescriptor | null => {
  for (const mod of modules) {
    if (!mod.createOp || !mod.listOp) continue;
    const params = matchTemplate(apiPath, mod.listOp.pathTemplate);
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
};

const findEditViewForPath = (
  apiPath: string,
  modules: ModuleInfo[]
): ViewDescriptor | null => {
  for (const mod of modules) {
    if (!mod.updateOp || !mod.getOp) continue;
    const params = matchTemplate(apiPath, mod.getOp.pathTemplate);
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
};

type RawPathItem = Record<string, Record<string, unknown> | undefined>;

const extractOpId = (op: Record<string, unknown>): string => {
  return (op['operationId'] ?? op['operation_id']) as string;
};

const extractTag = (op: Record<string, unknown>): string => {
  return (op['tags'] as string[] | undefined)?.[0] ?? 'Other';
};

// Methods that, in the absence of a GET on the same path, identify a
// standalone action operation (e.g. PUT /users/{user_id}/policies).
const ACTION_METHODS = ['post', 'put', 'patch', 'delete'] as const;

const findViewFromSpecPath = (
  template: string,
  pathItem: RawPathItem,
  params: Record<string, string>
): ViewDescriptor | null => {
  const getOp = pathItem['get'];

  if (getOp) {
    const lastSegment = template.split('/').filter(Boolean).pop() ?? '';
    const mode: ViewMode = lastSegment.startsWith('{') ? 'detail' : 'list';
    return {
      tag: extractTag(getOp),
      operationId: extractOpId(getOp),
      pathParams: params,
      mode,
    };
  }

  // No GET on this path: a POST/PUT/PATCH/DELETE here is a standalone action.
  // Without covering PUT/PATCH/DELETE, action URLs like
  // /app/v1/users/{id}/policies resolve to a null view and drop the user out
  // of the page.
  for (const method of ACTION_METHODS) {
    const op = pathItem[method];
    if (op) {
      return {
        tag: extractTag(op),
        operationId: extractOpId(op),
        pathParams: params,
        mode: 'action',
      };
    }
  }

  return null;
};

// Derive a ViewDescriptor from the current app URL pathname + loaded spec.
export const pathToView = (
  pathname: string,
  spec: OpenApiSpec,
  modules: ModuleInfo[]
): ViewDescriptor | null => {
  if (pathname.endsWith('/new')) {
    return findCreateViewForPath(appToApi(pathname.slice(0, -4)), modules);
  }

  if (pathname.endsWith('/edit')) {
    return findEditViewForPath(appToApi(pathname.slice(0, -5)), modules);
  }

  const apiPath = appToApi(pathname);

  for (const [template, pathItem] of Object.entries(spec.paths ?? {})) {
    const params = matchTemplate(apiPath, template);
    if (params === null) continue;
    const view = findViewFromSpecPath(
      template,
      pathItem as RawPathItem,
      params
    );
    if (view) return view;
  }

  return null;
};

// Extract project_id from the view's path params (if any).
export const extractProjectId = (
  view: ViewDescriptor | null
): string | null => {
  return view?.pathParams['project_id'] ?? null;
};
