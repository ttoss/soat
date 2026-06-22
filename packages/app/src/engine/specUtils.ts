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

// The collection path is where new items are created and listed
// (e.g. /agents or /projects/{project_id}/webhooks). Pick the shortest
// collection-shaped GET so deeper sub-collections never win.
const collectionPath = (ops: ModuleOp[]): string | undefined => {
  return ops
    .filter((op) => {
      return op.method === 'get' && isCollectionPath(op.pathTemplate);
    })
    .sort((a, b) => {
      return segmentCount(a.pathTemplate) - segmentCount(b.pathTemplate);
    })[0]?.pathTemplate;
};

const isCreatePost = (pathTemplate: string, collection: string | undefined) => {
  if (collection) return pathTemplate === collection;
  return isCollectionPath(pathTemplate) && !pathTemplate.includes('{');
};

const classifyInto = (
  module: ModuleInfo,
  op: ModuleOp,
  collection: string | undefined
): void => {
  if (op.method === 'post') {
    if (isCreatePost(op.pathTemplate, collection)) {
      if (!module.createOp) module.createOp = op;
    } else {
      module.actions = module.actions ?? [];
      module.actions.push(op);
    }
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
  const collection = collectionPath(ops);
  // Classify shallow paths first so list/detail/create win over sub-paths.
  const sorted = [...ops].sort((a, b) => {
    return segmentCount(a.pathTemplate) - segmentCount(b.pathTemplate);
  });
  for (const op of sorted) {
    classifyInto(module, op, collection);
  }
  return module;
};

type RawOp = OpenApiOperation & { operation_id?: string };

const collectTagOps = (
  pathTemplate: string,
  method: HttpMethod,
  pathItem: Record<string, unknown>,
  tagOps: Map<string, ModuleOp[]>
): void => {
  const raw = pathItem[method] as RawOp | undefined;
  if (!raw) return;
  // The server's caseTransform middleware converts operationId → operation_id;
  // normalise back so the rest of the engine can rely on operationId.
  const operation: OpenApiOperation = raw.operationId
    ? raw
    : { ...raw, operationId: raw.operation_id ?? '' };
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

const resolveRef = (
  ref: string,
  spec: OpenApiSpec
): OpenApiSchema | undefined => {
  const parts = ref.replace(/^#\//, '').split('/');
  let current: Record<string, unknown> = spec as Record<string, unknown>;
  for (const part of parts) {
    current = current[part] as Record<string, unknown>;
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

// Resolves the item schema described by an operation's 2xx JSON response.
// Array responses are unwrapped to their `items` schema so list and detail
// operations both yield the per-record schema.
export const getResponseItemSchema = (
  op: ModuleOp | undefined,
  spec: OpenApiSpec
): OpenApiSchema | undefined => {
  if (!op) return undefined;
  const responses = op.operation.responses ?? {};
  const okKey = Object.keys(responses).find((code) => {
    return code.startsWith('2');
  });
  if (!okKey) return undefined;
  const schema = responses[okKey].content?.['application/json']?.schema;
  const resolved = resolveSchema(schema, spec);
  if (resolved?.type === 'array') {
    return resolveSchema(resolved.items, spec);
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

// Builds a detail-view descriptor that opens `id` in the target module. Only
// top-level resources (a single path parameter) are linkable; nested targets
// would need parent ids we do not have at the link site.
export const buildRefDescriptor = (
  targetModule: ModuleInfo,
  id: string
): ViewDescriptor | null => {
  if (!targetModule.getOp || !id) return null;
  const params = extractPathParams(targetModule.getOp.pathTemplate);
  if (params.length !== 1) return null;
  return {
    tag: targetModule.tag,
    operationId: targetModule.getOp.operation.operationId,
    pathParams: { [params[0]]: id },
    mode: 'detail',
  };
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

const SENSITIVE_KEYS = /secret|password|key|token/i;

export const isSensitiveKey = (key: string): boolean => {
  return SENSITIVE_KEYS.test(key);
};

const HIDDEN_COLUMNS = new Set(['id']);
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
