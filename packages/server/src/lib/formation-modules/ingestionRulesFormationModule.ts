import createDebug from 'debug';

import {
  lookupAgentInternalId,
  lookupToolInternalId,
} from '../formationsHelpers';
import type { FormationModule, ValidationError } from '../formationsTypes';
import type { FileDelivery, NativeExtraction } from '../ingestionRules';
import {
  createIngestionRule,
  deleteIngestionRule,
  getIngestionRule,
  updateIngestionRule,
  validateIngestionRule,
} from '../ingestionRules';
import {
  toNullableNumber,
  toNullableObject,
  toNullableString,
} from '../resource-inputs/normalizers';
import {
  isFormationExpression,
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:ingestionRules');

const SCHEMA_NAME = 'IngestionRuleResourceProperties';
const RESOURCE_LABEL = 'ingestion rule';

// ── Business rule validation ─────────────────────────────────────────────
// `validateIngestionRule` needs the converter's tool type to enforce the
// client-tool-forbidden and soat/mcp-action-required rules, and that type is
// only knowable after a DB lookup. At this pure, template-validation stage we
// pass `toolType: null` so those two checks are skipped here and left to the
// authoritative check inside `createIngestionRule`/`updateIngestionRule`
// (called from `create`/`update` below, once refs are resolved).

const asRefPresence = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : 'unresolved-ref';
};

const pushBusinessRuleErrors = (args: {
  properties: Record<string, unknown>;
  basePath: string;
  errors: ValidationError[];
  forUpdate?: boolean;
}): void => {
  const { properties, basePath, errors, forUpdate } = args;
  const rawGlob = properties.content_type_glob;

  const msg = validateIngestionRule({
    toolId: asRefPresence(properties.tool_id),
    agentId: asRefPresence(properties.agent_id),
    toolType: null,
    action: toNullableString(properties.action) ?? undefined,
    contentTypeGlob:
      typeof rawGlob === 'string' && !isFormationExpression(rawGlob)
        ? rawGlob
        : '*/*',
    presetParameters:
      toNullableObject(properties.preset_parameters) ?? undefined,
    chunkStrategy: toNullableString(properties.chunk_strategy) ?? undefined,
  });

  if (!msg) return;
  // A PATCH-style update payload may omit both tool_id and agent_id to mean
  // "leave the converter unchanged" — only the "not both" half of the rule
  // applies on update, not "exactly one is required".
  if (forUpdate && msg === 'exactly one of tool_id or agent_id is required') {
    return;
  }
  errors.push({ path: basePath, message: msg });
};

// ── Property validation ──────────────────────────────────────────────────

const validateIngestionRuleProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { properties, basePath, forUpdate } = args;
  if (!isObjectRecord(properties)) {
    return [
      {
        path: basePath,
        message: 'Ingestion rule `properties` must be an object',
      },
    ];
  }

  const spec = loadModuleSpec({ schemaName: SCHEMA_NAME });
  const errors: ValidationError[] = [];
  pushUnknownFieldErrors({
    spec,
    resourceLabel: RESOURCE_LABEL,
    properties,
    basePath,
    errors,
  });
  if (!forUpdate) {
    pushRequiredFieldErrors({ spec, properties, basePath, errors });
  }
  pushFieldTypeErrors({ spec, properties, basePath, errors });
  pushBusinessRuleErrors({ properties, basePath, errors, forUpdate });

  return errors;
};

// ── Ref resolution ────────────────────────────────────────────────────────

const resolveToolId = async (
  value: unknown
): Promise<number | null | undefined> => {
  if (value === null) return null;
  const publicId = toNullableString(value);
  if (!publicId) return undefined;
  return lookupToolInternalId(publicId);
};

const resolveAgentId = async (
  value: unknown
): Promise<number | null | undefined> => {
  if (value === null) return null;
  const publicId = toNullableString(value);
  if (!publicId) return undefined;
  return lookupAgentInternalId(publicId);
};

// ── Normalizers ──────────────────────────────────────────────────────────

const requireString = (args: { value: unknown; fieldName: string }): string => {
  if (typeof args.value !== 'string' || args.value.trim().length === 0) {
    throw new Error(
      `Ingestion rule field '${args.fieldName}' must be a non-empty string`
    );
  }
  return args.value;
};

const asNativeExtraction = (value: unknown): NativeExtraction | undefined => {
  if (value === 'first' || value === 'skip') return value;
  return undefined;
};

const asFileDelivery = (value: unknown): FileDelivery | undefined => {
  if (value === 'base64' || value === 'download_url') return value;
  return undefined;
};

// ── Module export ────────────────────────────────────────────────────────

export const ingestionRulesFormationModule: FormationModule = {
  resourceType: 'ingestion_rule',

  validateProperties: ({ properties, basePath }) => {
    return validateIngestionRuleProperties({ properties, basePath });
  },

  create: async ({ properties, projectId }) => {
    const errors = validateIngestionRuleProperties({
      properties,
      basePath: 'resources.<ingestion_rule>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const contentTypeGlob = requireString({
      value: properties.content_type_glob,
      fieldName: 'content_type_glob',
    });

    const [toolId, agentId] = await Promise.all([
      resolveToolId(properties.tool_id),
      resolveAgentId(properties.agent_id),
    ]);

    const created = await createIngestionRule({
      projectId,
      contentTypeGlob,
      toolId,
      agentId,
      action: toNullableString(properties.action),
      presetParameters: toNullableObject(properties.preset_parameters),
      nativeExtraction: asNativeExtraction(properties.native_extraction),
      fileDelivery: asFileDelivery(properties.file_delivery),
      chunkStrategy: toNullableString(properties.chunk_strategy),
      chunkSize: toNullableNumber(properties.chunk_size),
      chunkOverlap: toNullableNumber(properties.chunk_overlap),
      metadata: toNullableObject(properties.metadata),
    });

    log(
      'created ingestion rule from formation: projectId=%d id=%s',
      projectId,
      created.id
    );
    return created.id;
  },

  update: async ({ properties, physicalResourceId }) => {
    const errors = validateIngestionRuleProperties({
      properties,
      basePath: 'resources.<ingestion_rule>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const [toolId, agentId] = await Promise.all([
      resolveToolId(properties.tool_id),
      resolveAgentId(properties.agent_id),
    ]);

    await updateIngestionRule({
      id: physicalResourceId,
      contentTypeGlob:
        toNullableString(properties.content_type_glob) ?? undefined,
      toolId,
      agentId,
      action: toNullableString(properties.action),
      presetParameters: toNullableObject(properties.preset_parameters),
      nativeExtraction: asNativeExtraction(properties.native_extraction),
      fileDelivery: asFileDelivery(properties.file_delivery),
      chunkStrategy: toNullableString(properties.chunk_strategy),
      chunkSize: toNullableNumber(properties.chunk_size),
      chunkOverlap: toNullableNumber(properties.chunk_overlap),
      metadata: toNullableObject(properties.metadata),
    });

    log('updated ingestion rule from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteIngestionRule({ id: physicalResourceId });
    log('deleted ingestion rule from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    try {
      const rule = await getIngestionRule({ id: physicalResourceId });
      return {
        content_type_glob: rule.contentTypeGlob,
        tool_id: rule.toolId,
        agent_id: rule.agentId,
        action: rule.action,
        preset_parameters: rule.presetParameters,
        native_extraction: rule.nativeExtraction,
        file_delivery: rule.fileDelivery,
        chunk_strategy: rule.chunkStrategy,
        chunk_size: rule.chunkSize,
        chunk_overlap: rule.chunkOverlap,
        metadata: rule.metadata,
      };
    } catch {
      return null;
    }
  },
};
