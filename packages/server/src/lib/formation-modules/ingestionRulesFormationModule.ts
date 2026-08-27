import {
  lookupAgentInternalId,
  lookupToolInternalId,
} from '../formationsHelpers';
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
import { defineFormationModule } from './defineFormationModule';
import { isFormationExpression } from './formationSpecLoader';

// Two of `validateIngestionRule`'s rules need the converter's tool type, which
// is only knowable after a DB lookup — so this pure stage passes
// `toolType: null` and leaves them to the lib's authoritative check.

const asRefPresence = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : 'unresolved-ref';
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

export const ingestionRulesFormationModule = defineFormationModule({
  resourceType: 'ingestion_rule',
  resourceLabel: 'ingestion rule',

  extraChecks: ({ properties, basePath, forUpdate, errors }) => {
    const rawGlob = properties.content_type_glob;

    const message = validateIngestionRule({
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

    if (!message) return;
    // A PATCH-style update payload may omit both tool_id and agent_id to mean
    // "leave the converter unchanged" — only the "not both" half of the rule
    // applies on update, not "exactly one is required".
    if (
      forUpdate &&
      message === 'exactly one of tool_id or agent_id is required'
    ) {
      return;
    }
    errors.push({ path: basePath, message });
  },

  create: async ({ properties, projectId }) => {
    const contentTypeGlob = requireString({
      value: properties.content_type_glob,
      fieldName: 'content_type_glob',
    });

    const [toolId, agentId] = await Promise.all([
      resolveToolId(properties.tool_id),
      resolveAgentId(properties.agent_id),
    ]);

    return createIngestionRule({
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
  },

  update: async ({ properties, physicalResourceId }) => {
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
  },

  remove: ({ physicalResourceId }) => {
    return deleteIngestionRule({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getIngestionRule({ id: physicalResourceId });
  },
});
