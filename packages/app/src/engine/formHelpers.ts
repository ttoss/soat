import { resolveSchema } from './specUtils';
import type {
  JsonObject,
  JsonValue,
  ModuleOp,
  OpenApiSchema,
  OpenApiSpec,
} from './types';

export const getOpRequestSchema = (
  op: ModuleOp | undefined,
  spec: OpenApiSpec
): OpenApiSchema | undefined => {
  const rawSchema =
    op?.operation?.requestBody?.content?.['application/json']?.schema;
  return resolveSchema(rawSchema, spec);
};

export const initFormData = (
  schema: OpenApiSchema | undefined,
  prefill: JsonObject
): Record<string, string> => {
  const properties = schema?.properties ?? {};
  const result: Record<string, string> = {};
  for (const key of Object.keys(properties)) {
    const prefillValue = prefill[key];
    result[key] =
      prefillValue !== undefined && prefillValue !== null
        ? String(prefillValue)
        : '';
  }
  return result;
};

export type BodyBuildResult =
  | { ok: true; body: JsonObject }
  | { ok: false; error: string };

type FieldConvertResult = { value: JsonValue } | { error: string };

const convertFieldValue = (
  fieldType: string | undefined,
  rawValue: string,
  fieldKey: string
): FieldConvertResult => {
  if (fieldType === 'boolean') return { value: rawValue === 'true' };
  if (fieldType === 'integer' || fieldType === 'number') {
    return { value: rawValue ? Number(rawValue) : null };
  }
  if (fieldType === 'object' || fieldType === 'array') {
    try {
      return { value: JSON.parse(rawValue) as JsonValue };
    } catch {
      return { error: `Invalid JSON in field "${fieldKey}"` };
    }
  }
  return { value: rawValue };
};

export const buildRequestBody = (
  formData: Record<string, string>,
  schema: OpenApiSchema | undefined
): BodyBuildResult => {
  const body: JsonObject = {};
  const properties = schema?.properties ?? {};
  const requiredFields = schema?.required ?? [];
  for (const [key, rawValue] of Object.entries(formData)) {
    if (!rawValue && !requiredFields.includes(key)) continue;
    const result = convertFieldValue(properties[key]?.type, rawValue, key);
    if ('error' in result) {
      return { ok: false, error: result.error };
    }
    body[key] = result.value;
  }
  return { ok: true, body };
};
