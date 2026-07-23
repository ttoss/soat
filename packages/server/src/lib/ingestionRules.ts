import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  compareGlobSpecificity,
  matchesContentTypeGlob,
} from './ingestionRuleMatching';
import { resolveConverterToolType } from './ingestionRuleRefs';
import { validateIngestionRule } from './ingestionRuleValidation';
import { paginatedList, type PaginatedResult } from './pagination';

const log = createDebug('soat:ingestionRules');

export { validateIngestionRule } from './ingestionRuleValidation';

// ── Mapped Types ─────────────────────────────────────────────────────────────

export type NativeExtraction = 'first' | 'skip';
export type FileDelivery = 'base64' | 'download_url';

export type MappedIngestionRule = {
  id: string;
  projectId: string;
  contentTypeGlob: string;
  toolId: string | null;
  agentId: string | null;
  action: string | null;
  presetParameters: object | null;
  nativeExtraction: string;
  fileDelivery: string;
  chunkStrategy: string | null;
  chunkSize: number | null;
  chunkOverlap: number | null;
  metadata: object | null;
  createdAt: Date;
  updatedAt: Date;
};

// ── Map Helpers ───────────────────────────────────────────────────────────────

const ingestionRuleIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Tool, as: 'tool' },
    { model: db.Agent, as: 'agent' },
  ];
};

const mapIngestionRule = (
  rule: InstanceType<typeof db.IngestionRule> & {
    project?: InstanceType<typeof db.Project>;
    tool?: InstanceType<typeof db.Tool> | null;
    agent?: InstanceType<typeof db.Agent> | null;
  }
): MappedIngestionRule => {
  return {
    id: rule.publicId,
    projectId: rule.project?.publicId ?? '',
    contentTypeGlob: rule.contentTypeGlob,
    toolId: rule.tool?.publicId ?? null,
    agentId: rule.agent?.publicId ?? null,
    action: rule.action,
    presetParameters: rule.presetParameters,
    nativeExtraction: rule.nativeExtraction,
    fileDelivery: rule.fileDelivery,
    chunkStrategy: rule.chunkStrategy,
    chunkSize: rule.chunkSize,
    chunkOverlap: rule.chunkOverlap,
    metadata: rule.metadata,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
};

const throwOnGlobConflict = (args: {
  error: unknown;
  contentTypeGlob: string;
}): never => {
  if (
    args.error instanceof Error &&
    args.error.name === 'SequelizeUniqueConstraintError'
  ) {
    throw new DomainError(
      'INGESTION_RULE_GLOB_CONFLICT',
      `An ingestion rule for content_type_glob '${args.contentTypeGlob}' already exists in this project.`
    );
  }
  throw args.error;
};

const createIngestionRuleRow = async (
  values: Parameters<typeof db.IngestionRule.create>[0] & {
    contentTypeGlob: string;
  }
): Promise<InstanceType<typeof db.IngestionRule>> => {
  try {
    return await db.IngestionRule.create(values);
  } catch (error) {
    return throwOnGlobConflict({
      error,
      contentTypeGlob: values.contentTypeGlob,
    });
  }
};

const updateIngestionRuleRow = async (args: {
  rule: InstanceType<typeof db.IngestionRule>;
  updates: Record<string, unknown>;
  contentTypeGlob: string;
}): Promise<void> => {
  try {
    await args.rule.update(args.updates);
  } catch (error) {
    throwOnGlobConflict({ error, contentTypeGlob: args.contentTypeGlob });
  }
};

const buildConverterCreateFields = (args: {
  toolId?: number | null;
  agentId?: number | null;
  action?: string | null;
  presetParameters?: object | null;
}) => {
  return {
    toolId: args.toolId ?? null,
    agentId: args.agentId ?? null,
    action: args.action ?? null,
    presetParameters: args.presetParameters ?? null,
  };
};

const buildIngestionBehaviorCreateFields = (args: {
  nativeExtraction?: NativeExtraction;
  fileDelivery?: FileDelivery;
  chunkStrategy?: string | null;
  chunkSize?: number | null;
  chunkOverlap?: number | null;
  metadata?: object | null;
}) => {
  return {
    nativeExtraction: args.nativeExtraction ?? 'first',
    fileDelivery: args.fileDelivery ?? 'base64',
    chunkStrategy: args.chunkStrategy ?? null,
    chunkSize: args.chunkSize ?? null,
    chunkOverlap: args.chunkOverlap ?? null,
    metadata: args.metadata ?? null,
  };
};

const buildIngestionRuleCreateValues = (args: {
  projectId: number;
  contentTypeGlob: string;
  toolId?: number | null;
  agentId?: number | null;
  action?: string | null;
  presetParameters?: object | null;
  nativeExtraction?: NativeExtraction;
  fileDelivery?: FileDelivery;
  chunkStrategy?: string | null;
  chunkSize?: number | null;
  chunkOverlap?: number | null;
  metadata?: object | null;
}) => {
  return {
    projectId: args.projectId,
    contentTypeGlob: args.contentTypeGlob,
    ...buildConverterCreateFields(args),
    ...buildIngestionBehaviorCreateFields(args),
  };
};

// ── CRUD ──────────────────────────────────────────────────────────────────────

export const createIngestionRule = async (args: {
  projectId: number;
  contentTypeGlob: string;
  toolId?: number | null;
  agentId?: number | null;
  action?: string | null;
  presetParameters?: object | null;
  nativeExtraction?: NativeExtraction;
  fileDelivery?: FileDelivery;
  chunkStrategy?: string | null;
  chunkSize?: number | null;
  chunkOverlap?: number | null;
  metadata?: object | null;
}): Promise<MappedIngestionRule> => {
  log(
    'createIngestionRule: projectId=%d contentTypeGlob=%s toolId=%s agentId=%s',
    args.projectId,
    args.contentTypeGlob,
    args.toolId,
    args.agentId
  );

  const toolType = await resolveConverterToolType({
    projectId: args.projectId,
    toolId: args.toolId,
    agentId: args.agentId,
  });

  const validationError = validateIngestionRule({
    toolId: args.toolId,
    agentId: args.agentId,
    toolType,
    action: args.action,
    contentTypeGlob: args.contentTypeGlob,
    presetParameters: args.presetParameters,
    chunkStrategy: args.chunkStrategy,
  });
  if (validationError) {
    throw new DomainError('INGESTION_RULE_VALIDATION_FAILED', validationError);
  }

  const rule = await createIngestionRuleRow(
    buildIngestionRuleCreateValues(args)
  );

  const created = await db.IngestionRule.findOne({
    where: { id: rule.id },
    include: ingestionRuleIncludes(),
  });

  log('createIngestionRule: created rule id=%s', created!.publicId);
  return mapIngestionRule(created as Parameters<typeof mapIngestionRule>[0]);
};

export const listIngestionRules = async (args: {
  projectIds?: number[];
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedIngestionRule>> => {
  log('listIngestionRules: projectIds=%o', args.projectIds);

  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.IngestionRule.findAndCountAll({
        where,
        include: ingestionRuleIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (rule) => {
      return mapIngestionRule(rule as Parameters<typeof mapIngestionRule>[0]);
    },
  });
};

export const getIngestionRule = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedIngestionRule> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const rule = await db.IngestionRule.findOne({
    where,
    include: ingestionRuleIncludes(),
  });

  if (!rule) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `IngestionRule '${args.id}' not found.`
    );
  }

  return mapIngestionRule(rule as Parameters<typeof mapIngestionRule>[0]);
};

const buildIngestionRuleUpdates = (args: {
  contentTypeGlob?: string;
  toolId?: number | null;
  agentId?: number | null;
  action?: string | null;
  presetParameters?: object | null;
  nativeExtraction?: NativeExtraction;
  fileDelivery?: FileDelivery;
  chunkStrategy?: string | null;
  chunkSize?: number | null;
  chunkOverlap?: number | null;
  metadata?: object | null;
}): Record<string, unknown> => {
  const updates: Record<string, unknown> = {};
  const fields = [
    'contentTypeGlob',
    'toolId',
    'agentId',
    'action',
    'presetParameters',
    'nativeExtraction',
    'fileDelivery',
    'chunkStrategy',
    'chunkSize',
    'chunkOverlap',
    'metadata',
  ] as const;
  for (const field of fields) {
    if (args[field] !== undefined) updates[field] = args[field];
  }
  return updates;
};

export const updateIngestionRule = async (args: {
  id: string;
  projectIds?: number[];
  contentTypeGlob?: string;
  toolId?: number | null;
  agentId?: number | null;
  action?: string | null;
  presetParameters?: object | null;
  nativeExtraction?: NativeExtraction;
  fileDelivery?: FileDelivery;
  chunkStrategy?: string | null;
  chunkSize?: number | null;
  chunkOverlap?: number | null;
  metadata?: object | null;
}): Promise<MappedIngestionRule> => {
  log('updateIngestionRule: id=%s', args.id);

  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const rule = await db.IngestionRule.findOne({ where });
  if (!rule) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `IngestionRule '${args.id}' not found.`
    );
  }

  const finalToolId = args.toolId !== undefined ? args.toolId : rule.toolId;
  const finalAgentId = args.agentId !== undefined ? args.agentId : rule.agentId;
  const finalAction = args.action !== undefined ? args.action : rule.action;
  const finalContentTypeGlob = args.contentTypeGlob ?? rule.contentTypeGlob;
  const finalPresetParameters =
    args.presetParameters !== undefined
      ? args.presetParameters
      : (rule.presetParameters as object | null);
  const finalChunkStrategy =
    args.chunkStrategy !== undefined ? args.chunkStrategy : rule.chunkStrategy;

  const toolType = await resolveConverterToolType({
    projectId: rule.projectId,
    toolId: finalToolId,
    agentId: finalAgentId,
  });

  const validationError = validateIngestionRule({
    toolId: finalToolId,
    agentId: finalAgentId,
    toolType,
    action: finalAction,
    contentTypeGlob: finalContentTypeGlob,
    presetParameters: finalPresetParameters,
    chunkStrategy: finalChunkStrategy,
  });
  if (validationError) {
    throw new DomainError('INGESTION_RULE_VALIDATION_FAILED', validationError);
  }

  await updateIngestionRuleRow({
    rule,
    updates: buildIngestionRuleUpdates(args),
    contentTypeGlob: finalContentTypeGlob,
  });

  const updated = await db.IngestionRule.findOne({
    where: { id: rule.id },
    include: ingestionRuleIncludes(),
  });

  return mapIngestionRule(updated as Parameters<typeof mapIngestionRule>[0]);
};

export const deleteIngestionRule = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<void> => {
  log('deleteIngestionRule: id=%s', args.id);

  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const rule = await db.IngestionRule.findOne({ where });
  if (!rule) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `IngestionRule '${args.id}' not found.`
    );
  }

  await rule.destroy();
};

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * Picks the most-specific ingestion rule matching a file's content type,
 * for use by the ingestion pipeline (documentIngestion.ts, Phase 3). Called
 * for non-native content types and, for native types (PDF), as a fallback
 * when native extraction yields no text.
 */
export const resolveIngestionRule = async (args: {
  projectId: number;
  contentType: string;
}): Promise<MappedIngestionRule | null> => {
  const rules = await db.IngestionRule.findAll({
    where: { projectId: args.projectId },
    include: ingestionRuleIncludes(),
  });

  const matches = rules
    .map((rule) => {
      return mapIngestionRule(rule as Parameters<typeof mapIngestionRule>[0]);
    })
    .filter((rule) => {
      return matchesContentTypeGlob({
        glob: rule.contentTypeGlob,
        contentType: args.contentType,
      });
    })
    .sort((a, b) => {
      return compareGlobSpecificity(a.contentTypeGlob, b.contentTypeGlob);
    });

  return matches[0] ?? null;
};
