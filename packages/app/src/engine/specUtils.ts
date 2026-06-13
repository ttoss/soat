import type {
  JsonObject,
  JsonValue,
  ModuleInfo,
  ModuleOp,
  OpenApiOperation,
  OpenApiSchema,
  OpenApiSpec,
} from './types';

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

const SKIP_TAGS = new Set(['Sessions', 'Generations', 'Actor Tags']);

const toLabel = (tag: string): string => {
  return tag
    .replace(/([A-Z])/g, (_m, p1: string, offset: number) => {
      return offset > 0 ? ` ${p1}` : p1;
    })
    .trim();
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

type OpKey = 'listOp' | 'getOp' | 'createOp' | 'updateOp' | 'deleteOp';

const classifyOp = (method: string, pathTemplate: string): OpKey | null => {
  if (method === 'get') {
    return isCollectionPath(pathTemplate) ? 'listOp' : 'getOp';
  }
  if (method === 'post' && isCollectionPath(pathTemplate)) return 'createOp';
  if (method === 'put' || method === 'patch') return 'updateOp';
  if (method === 'delete') return 'deleteOp';
  return null;
};

const assignOp = (
  module: ModuleInfo,
  method: HttpMethod,
  op: ModuleOp
): void => {
  const key = classifyOp(method, op.pathTemplate);
  if (key && !module[key]) {
    module[key] = op;
  }
};

const processTag = (
  tag: string,
  method: HttpMethod,
  pathTemplate: string,
  operation: OpenApiOperation,
  tagMap: Map<string, ModuleInfo>
): void => {
  if (!tagMap.has(tag)) {
    tagMap.set(tag, { tag, label: toLabel(tag), isProjectScoped: false });
  }
  const module = tagMap.get(tag)!;
  if (pathTemplate.includes('{project_id}')) {
    module.isProjectScoped = true;
  }
  assignOp(module, method, { method, pathTemplate, operation });
};

const processOperation = (
  pathTemplate: string,
  method: HttpMethod,
  operation: OpenApiOperation | undefined,
  tagMap: Map<string, ModuleInfo>
): void => {
  if (!operation?.operationId) return;
  const tags = operation.tags ?? ['Other'];
  for (const tag of tags) {
    if (!SKIP_TAGS.has(tag)) {
      processTag(tag, method, pathTemplate, operation, tagMap);
    }
  }
};

export const parseModules = (spec: OpenApiSpec): ModuleInfo[] => {
  const tagMap = new Map<string, ModuleInfo>();
  const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;

  for (const [pathTemplate, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of methods) {
      processOperation(pathTemplate, method, pathItem[method], tagMap);
    }
  }

  return Array.from(tagMap.values());
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
