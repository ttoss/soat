import type {
  JsonObject,
  JsonValue,
  ModuleInfo,
  ModuleOp,
  OpenApiOperation,
  OpenApiSchema,
  OpenApiSpec,
  ViewDescriptor,
} from './types';

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

const SKIP_TAGS = new Set(['Generations', 'Actor Tags']);

const toLabel = (tag: string): string => {
  return tag.replace(/([a-z])([A-Z])/g, '$1 $2');
};

const isCollectionPath = (pathTemplate: string): boolean => {
  const segments = pathTemplate.split('/');
  const last = segments[segments.length - 1];
  return !last.startsWith('{');
};

export const buildUrl = (
  pathTemplate: string,
  params: Record<string, string>
): string => {
  let url = pathTemplate;
  for (const [key, value] of Object.entries(params)) {
    url = url.replace(`{${key}}`, encodeURIComponent(value));
  }
  return url;
};

// Appends query parameters to a URL, skipping empty/null/undefined values.
export const withQuery = (
  url: string,
  params: Record<string, string | null | undefined>
): string => {
  const search = Object.entries(params)
    .filter(([, value]) => {
      return value != null && value !== '';
    })
    .map(([key, value]) => {
      return `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
    })
    .join('&');
  if (!search) return url;
  return url.includes('?') ? `${url}&${search}` : `${url}?${search}`;
};

// True when an operation accepts a `project_id` query parameter — the API's
// mechanism for scoping a collection to a project.
export const opAcceptsProjectIdQuery = (op: ModuleOp | undefined): boolean => {
  return (op?.operation.parameters ?? []).some((param) => {
    return param.name === 'project_id' && param.in === 'query';
  });
};

// Builds a list request URL, scoping it to the active project when the
// operation supports the project_id query parameter.
export const buildListRequestUrl = (
  op: ModuleOp,
  pathParams: Record<string, string>,
  activeProjectId: string | null
): string => {
  return withQuery(buildUrl(op.pathTemplate, pathParams), {
    project_id: opAcceptsProjectIdQuery(op) ? activeProjectId : undefined,
  });
};

export const humanizeKey = (key: string): string => {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => {
    return c.toUpperCase();
  });
};

export const extractPathParams = (pathTemplate: string): string[] => {
  return Array.from(pathTemplate.matchAll(/\{([^}]+)\}/g)).map((m) => {
    return m[1];
  });
};

export const actionLabel = (op: ModuleOp): string => {
  const last = op.pathTemplate.split('/').filter(Boolean).pop();
  return humanizeKey(last ?? op.operation.operationId);
};

type OpKey = 'listOp' | 'getOp' | 'updateOp' | 'deleteOp';

const classifyNonPost = (method: HttpMethod, pathTemplate: string): OpKey => {
  if (method === 'get') {
    return isCollectionPath(pathTemplate) ? 'listOp' : 'getOp';
  }
  return method === 'delete' ? 'deleteOp' : 'updateOp';
};

const segmentCount = (pathTemplate: string): number => {
  return pathTemplate.split('/').filter(Boolean).length;
};

const isCreatePost = (pathTemplate: string, collection: string | undefined) => {
  if (collection) return pathTemplate === collection;
  return isCollectionPath(pathTemplate) && !pathTemplate.includes('{');
};

const pushAction = (module: ModuleInfo, op: ModuleOp): void => {
  module.actions = module.actions ?? [];
  module.actions.push(op);
};

const classifyInto = (
  module: ModuleInfo,
  op: ModuleOp,
  collection: string | undefined,
  detail: string | undefined
): void => {
  if (op.method === 'post') {
    if (isCreatePost(op.pathTemplate, collection)) {
      if (!module.createOp) module.createOp = op;
    } else {
      pushAction(module, op);
    }
    return;
  }
  // A PUT/PATCH/DELETE off the detail path (e.g. /users/{id}/policies) is an
  // action — otherwise it would shadow the edit form and break routing.
  if (op.method !== 'get' && op.pathTemplate !== detail) {
    pushAction(module, op);
    return;
  }
  const key = classifyNonPost(op.method, op.pathTemplate);
  if (!module[key]) module[key] = op;
};

const buildModule = (tag: string, ops: ModuleOp[]): ModuleInfo => {
  const module: ModuleInfo = {
    tag,
    label: toLabel(tag),
    isProjectScoped: ops.some((op) => {
      return op.pathTemplate.includes('{project_id}');
    }),
  };
  // Classify shallow paths first so list/detail/create win over sub-paths.
  const sorted = [...ops].sort((a, b) => {
    return segmentCount(a.pathTemplate) - segmentCount(b.pathTemplate);
  });
  // The collection path (shortest collection GET) is where items are
  // listed/created; the detail path (shortest item-scoped path) owns
  // get/update/delete. Writes on deeper sub-paths become actions.
  const collection = sorted.find((op) => {
    return op.method === 'get' && isCollectionPath(op.pathTemplate);
  })?.pathTemplate;
  const detail = sorted.find((op) => {
    return !isCollectionPath(op.pathTemplate);
  })?.pathTemplate;
  for (const op of sorted) {
    classifyInto(module, op, collection, detail);
  }
  return module;
};

type RawOp = OpenApiOperation & {
  operation_id?: string;
  request_body?: OpenApiOperation['requestBody'];
};

const collectTagOps = (
  pathTemplate: string,
  method: HttpMethod,
  pathItem: Record<string, unknown>,
  tagOps: Map<string, ModuleOp[]>
): void => {
  const raw = pathItem[method] as RawOp | undefined;
  if (!raw) return;
  // The server's caseTransform middleware snake_cases the whole served spec
  // (operationId → operation_id, requestBody → request_body). Normalise the
  // camelCase OpenAPI keys back so the rest of the engine can rely on them —
  // without this, form views can't find the create/edit body schema.
  const operation: OpenApiOperation = {
    ...raw,
    operationId: raw.operationId ?? raw.operation_id ?? '',
    requestBody: raw.requestBody ?? raw.request_body,
  };
  if (!operation.operationId) return;
  for (const tag of operation.tags ?? ['Other']) {
    if (SKIP_TAGS.has(tag)) continue;
    if (!tagOps.has(tag)) tagOps.set(tag, []);
    tagOps.get(tag)!.push({ method, pathTemplate, operation });
  }
};

export const parseModules = (spec: OpenApiSpec): ModuleInfo[] => {
  const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
  const tagOps = new Map<string, ModuleOp[]>();

  for (const [pathTemplate, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of methods) {
      collectTagOps(
        pathTemplate,
        method,
        pathItem as Record<string, unknown>,
        tagOps
      );
    }
  }

  return Array.from(tagOps.entries()).map(([tag, ops]) => {
    return buildModule(tag, ops);
  });
};

export const getIdParamName = (getPath: string, listPath: string): string => {
  const getParts = getPath.split('/');
  const listParts = listPath.split('/');
  const extra = getParts.find((p, i) => {
    return p !== listParts[i] && p.startsWith('{');
  });
  return extra ? extra.slice(1, -1) : 'id';
};

// Picks the right object key for a $ref segment. The server's caseTransform
// middleware snake_cases the served spec's component KEYS (ActorRecord →
// _actor_record) while leaving $ref strings pointing at the original name, so
// we fall back to the snake_cased key when the exact one is absent.
const lookupRefKey = (obj: Record<string, unknown>, part: string): string => {
  if (part in obj) return part;
  const snake = part.replace(/[A-Z]/g, (char) => {
    return `_${char.toLowerCase()}`;
  });
  return snake in obj ? snake : part;
};

const resolveRef = (
  ref: string,
  spec: OpenApiSpec
): OpenApiSchema | undefined => {
  const parts = ref.replace(/^#\//, '').split('/');
  let current: Record<string, unknown> = spec as Record<string, unknown>;
  for (const part of parts) {
    if (typeof current !== 'object') return undefined;
    current = current[lookupRefKey(current, part)] as Record<string, unknown>;
    if (!current) return undefined;
  }
  return current as OpenApiSchema;
};

export const resolveSchema = (
  schema: OpenApiSchema | undefined,
  spec: OpenApiSpec
): OpenApiSchema | undefined => {
  if (!schema) return undefined;
  if (schema.$ref) return resolveRef(schema.$ref, spec);
  return schema;
};

// ─── Cross-resource references (x-soat-ref) ─────────────────────────────────

// The trailing non-parameter segment of a path identifies the resource it
// addresses: /api/v1/projects/{project_id} → "projects".
const resourceSegment = (pathTemplate: string): string => {
  const segments = pathTemplate.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (!segments[i].startsWith('{')) return segments[i];
  }
  return '';
};

// The resolved schema of an operation's 2xx JSON response body.
const resolveOkResponseSchema = (
  op: ModuleOp | undefined,
  spec: OpenApiSpec
): OpenApiSchema | undefined => {
  if (!op) return undefined;
  const responses = op.operation.responses ?? {};
  const okKey = Object.keys(responses).find((code) => {
    return code.startsWith('2');
  });
  if (!okKey) return undefined;
  return resolveSchema(
    responses[okKey].content?.['application/json']?.schema,
    spec
  );
};

// Resolves the item schema described by an operation's 2xx JSON response.
// Array responses are unwrapped to their `items` schema; an object response is
// the record itself (a detail GET).
export const getResponseItemSchema = (
  op: ModuleOp | undefined,
  spec: OpenApiSpec
): OpenApiSchema | undefined => {
  const resolved = resolveOkResponseSchema(op, spec);
  if (resolved?.type === 'array') {
    return resolveSchema(resolved.items, spec);
  }
  return resolved;
};

// Unwraps a paginated wrapper object (`{ items: [...], total, ... }`) to the
// record schema held by its first array-typed property, or undefined.
const unwrapPaginatedItems = (
  schema: OpenApiSchema,
  spec: OpenApiSpec
): OpenApiSchema | undefined => {
  if (schema.type !== 'object' || !schema.properties) return undefined;
  const arrayProp = Object.values(schema.properties)
    .map((p) => {
      return resolveSchema(p, spec);
    })
    .find((p) => {
      return p?.type === 'array';
    });
  return arrayProp?.items ? resolveSchema(arrayProp.items, spec) : undefined;
};

// Resolves the per-record schema of a list/collection operation from its OUTER
// 2xx response. Handles both a bare `array` response and a paginated wrapper
// object — without this, refs on paginated lists (e.g. actors' project_id)
// never get their x-soat-ref annotation and so never link. (Operating on the
// outer schema avoids mistaking a record's own array field for the list.)
export const getListItemSchema = (
  op: ModuleOp | undefined,
  spec: OpenApiSpec
): OpenApiSchema | undefined => {
  const resolved = resolveOkResponseSchema(op, spec);
  if (resolved?.type === 'array') {
    return resolveSchema(resolved.items, spec);
  }
  if (resolved?.type === 'object') {
    return unwrapPaginatedItems(resolved, spec) ?? resolved;
  }
  return resolved;
};

// Maps each property carrying an `x-soat-ref` annotation to the resource it
// references, e.g. { project_id: 'projects', ai_provider_id: 'ai-providers' }.
export const extractRefFields = (
  schema: OpenApiSchema | undefined,
  spec: OpenApiSpec
): Record<string, string> => {
  const resolved = resolveSchema(schema, spec);
  const properties = resolved?.properties ?? {};
  const refs: Record<string, string> = {};
  for (const [name, fieldSchema] of Object.entries(properties)) {
    const ref = fieldSchema['x-soat-ref'];
    if (typeof ref === 'string' && ref) refs[name] = ref;
  }
  return refs;
};

// Finds the module that owns a given resource (matched by the trailing path
// segment of its list or detail operation).
export const findModuleByResource = (
  modules: ModuleInfo[],
  resource: string
): ModuleInfo | undefined => {
  return modules.find((module) => {
    const path = module.listOp?.pathTemplate ?? module.getOp?.pathTemplate;
    return path ? resourceSegment(path) === resource : false;
  });
};

// True when the target module has a detail route we could navigate to. Nested
// targets (more than one path parameter) qualify too; whether a given link can
// actually be built depends on the runtime context (see buildRefDescriptor).
const hasDetailRoute = (targetModule: ModuleInfo): boolean => {
  if (!targetModule.getOp) return false;
  return extractPathParams(targetModule.getOp.pathTemplate).length >= 1;
};

// Builds a detail-view descriptor that opens `id` in the target module. The
// trailing path parameter receives `id`; any preceding (parent) parameters are
// filled from `context` — the current path params plus the row's own fields.
// Returns null when a required parent id is absent, so callers can fall back to
// plain text instead of rendering a dead link.
export const buildRefDescriptor = (
  targetModule: ModuleInfo,
  id: string,
  context: Record<string, string> = {}
): ViewDescriptor | null => {
  if (!targetModule.getOp || !id) return null;
  const params = extractPathParams(targetModule.getOp.pathTemplate);
  if (params.length === 0) return null;
  const targetParam = params[params.length - 1];
  const pathParams: Record<string, string> = { [targetParam]: id };
  for (const parent of params.slice(0, -1)) {
    const value = context[parent];
    if (!value) return null;
    pathParams[parent] = value;
  }
  return {
    tag: targetModule.tag,
    operationId: targetModule.getOp.operation.operationId,
    pathParams,
    mode: 'detail',
  };
};

// Narrows a field→resource map to the references whose target is a known module
// exposing a detail route. References to skipped or unknown resources are
// dropped. Nested targets are kept as candidates here; per-row resolution then
// decides whether the parent ids are available to form a live link.
export const resolvableRefFields = (
  refFields: Record<string, string>,
  modules: ModuleInfo[]
): Record<string, string> => {
  const resolvable: Record<string, string> = {};
  for (const [field, resource] of Object.entries(refFields)) {
    const target = findModuleByResource(modules, resource);
    if (target && hasDetailRoute(target)) {
      resolvable[field] = resource;
    }
  }
  return resolvable;
};

// Builds the link context for a record: the current path params merged with the
// record's own string fields. A nested cross-ref (e.g. a session under an
// agent) recovers its parent id from either the surrounding scope or a
// foreign-key field on the record itself.
export const refLinkContext = (
  item: JsonObject,
  pathParams: Record<string, string>
): Record<string, string> => {
  const context: Record<string, string> = { ...pathParams };
  for (const [key, value] of Object.entries(item)) {
    if (typeof value === 'string') context[key] = value;
  }
  return context;
};

const isJsonObject = (v: unknown): v is JsonObject => {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
};

export const extractItems = (data: unknown): JsonObject[] => {
  if (Array.isArray(data)) return data.filter(isJsonObject);
  if (isJsonObject(data)) {
    for (const value of Object.values(data)) {
      if (Array.isArray(value)) return value.filter(isJsonObject);
    }
  }
  return [];
};

// The human label for a record, mirroring the detail view's heading choice:
// prefer `name`, then `title`, falling back to the id. Used wherever a resource
// must be shown as a single line (e.g. the project picker).
export const itemLabel = (item: JsonObject): string => {
  const label = item.name ?? item.title ?? item.id;
  return label === undefined || label === null ? '' : String(label);
};

const SENSITIVE_KEYS = /secret|password|key|token/i;

export const isSensitiveKey = (key: string): boolean => {
  return SENSITIVE_KEYS.test(key);
};

// `id` is shown (as a link to the item's detail). Nothing is hidden by name;
// sensitive fields are still filtered out separately in deriveColumns.
const HIDDEN_COLUMNS = new Set<string>();
const MAX_COLUMNS = 6;

export const deriveColumns = (items: JsonObject[]): string[] => {
  if (items.length === 0) return [];
  const allKeys = items.flatMap((item) => {
    return Object.keys(item);
  });
  const unique = Array.from(new Set(allKeys));
  return unique
    .filter((k) => {
      return !HIDDEN_COLUMNS.has(k) && !isSensitiveKey(k);
    })
    .slice(0, MAX_COLUMNS);
};

const DATE_KEYS = /created_at|updated_at|_at$/i;

const formatDateValue = (value: string): string => {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
};

export const formatValue = (key: string, value: JsonValue): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  if (DATE_KEYS.test(key) && typeof value === 'string') {
    return formatDateValue(value);
  }
  return String(value);
};
