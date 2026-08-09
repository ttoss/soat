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
import { makeResourceAccessor } from './resourceAccessor';
import { isUniqueViolation } from './uniqueViolation';

const log = createDebug('soat:ingestionRules');

export { validateIngestionRule } from './ingestionRuleValidation';

// ── Mapped Types ─────────────────────────────────────────────────────────────

export type NativeExtraction = 'first' | 'skip';
export type FileDelivery = 'base64' | 'download_url';

export type MappedIngestionRule = {
  id: string;
  project_id: string;
  content_type_glob: string;
  tool_id: string | null;
  agent_id: string | null;
  action: string | null;
  preset_parameters: object | null;
  native_extraction: string;
  file_delivery: string;
  chunk_strategy: string | null;
  chunk_size: number | null;
  chunk_overlap: number | null;
  metadata: object | null;
  created_at: Date;
  updated_at: Date;
};

// ── Map Helpers ───────────────────────────────────────────────────────────────

const ingestionRuleIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Tool, as: 'tool' },
    { model: db.Agent, as: 'agent' },
  ];
};

type IngestionRuleRow = InstanceType<typeof db.IngestionRule> & {
  project?: InstanceType<typeof db.Project>;
  tool?: InstanceType<typeof db.Tool> | null;
  agent?: InstanceType<typeof db.Agent> | null;
};

const ingestionRules = makeResourceAccessor<IngestionRuleRow>({
  model: () => {
    return db.IngestionRule;
  },
  includes: ingestionRuleIncludes,
  label: 'IngestionRule',
});

const mapIngestionRule = (rule: IngestionRuleRow): MappedIngestionRule => {
  return {
    id: rule.publicId,
    project_id: rule.project?.publicId ?? '',
    content_type_glob: rule.contentTypeGlob,
    tool_id: rule.tool?.publicId ?? null,
    agent_id: rule.agent?.publicId ?? null,
    action: rule.action,
    preset_parameters: rule.presetParameters,
    native_extraction: rule.nativeExtraction,
    file_delivery: rule.fileDelivery,
    chunk_strategy: rule.chunkStrategy,
    chunk_size: rule.chunkSize,
    chunk_overlap: rule.chunkOverlap,
    metadata: rule.metadata,
    created_at: rule.createdAt,
    updated_at: rule.updatedAt,
  };
};

const throwOnGlobConflict = (args: {
  error: unknown;
  contentTypeGlob: string;
}): never => {
  if (isUniqueViolation(args.error)) {
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

  const created = await ingestionRules.reload(rule);

  log('createIngestionRule: created rule id=%s', created.publicId);
  return mapIngestionRule(created);
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
  return mapIngestionRule(
    await ingestionRules.getByPublicId({
      id: args.id,
      projectIds: args.projectIds,
    })
  );
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

  // Lean lookup on purpose: this path reloads with includes after the write,
  // so attaching them here would join twice.
  const rule = await db.IngestionRule.findOne({
    where: ingestionRules.scopedWhere({
      id: args.id,
      projectIds: args.projectIds,
    }),
  });
  if (!rule) throw ingestionRules.notFound(args.id);

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

  return mapIngestionRule(await ingestionRules.reload(rule));
};

export const deleteIngestionRule = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<void> => {
  log('deleteIngestionRule: id=%s', args.id);

  const rule = await db.IngestionRule.findOne({
    where: ingestionRules.scopedWhere({
      id: args.id,
      projectIds: args.projectIds,
    }),
  });
  if (!rule) throw ingestionRules.notFound(args.id);

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
        glob: rule.content_type_glob,
        contentType: args.contentType,
      });
    })
    .sort((a, b) => {
      return compareGlobSpecificity(a.content_type_glob, b.content_type_glob);
    });

  return matches[0] ?? null;
};
