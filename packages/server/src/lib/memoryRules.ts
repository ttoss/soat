import type { MemoryRuleEvent } from '@soat/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { validateMemoryRule } from './memoryRuleValidation';
import { paginatedList, type PaginatedResult } from './pagination';
import { makeResourceAccessor } from './resourceAccessor';

const log = createDebug('soat:memoryRules');

export { validateMemoryRule } from './memoryRuleValidation';

export type MappedMemoryRule = {
  id: string;
  memory_store_id: string;
  project_id: string | undefined;
  on: string;
  source_agent_ids: string[] | null;
  agent_id: string | null;
  tool_id: string | null;
  action: string | null;
  preset_parameters: object | null;
  prompt: string | null;
  ai_provider_id: string | null;
  model: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

type MemoryStoreRow = InstanceType<typeof db.MemoryStore> & {
  project?: InstanceType<typeof db.Project>;
};

type MemoryRuleRow = InstanceType<typeof db.MemoryRule> & {
  memoryStore?: MemoryStoreRow;
  agent?: InstanceType<typeof db.Agent> | null;
  tool?: InstanceType<typeof db.Tool> | null;
  aiProvider?: InstanceType<typeof db.AiProvider> | null;
};

/**
 * A rule has no `project_id` column: its project is its store's, and a second
 * copy is a second thing to keep true. Every scoped read therefore joins the
 * store, which is why the include is `required`.
 */
const memoryRuleIncludes = (projectIds?: number[]) => {
  return [
    {
      model: db.MemoryStore,
      as: 'memoryStore',
      required: true,
      ...(projectIds === undefined ? {} : { where: { projectId: projectIds } }),
      include: [{ model: db.Project, as: 'project' }],
    },
    { model: db.Agent, as: 'agent' },
    { model: db.Tool, as: 'tool' },
    { model: db.AiProvider, as: 'aiProvider' },
  ];
};

/** A linked row's public id, or null when the link is absent. */
const linkedPublicId = (
  linked?: { publicId: string } | null
): string | null => {
  return linked?.publicId ?? null;
};

export const mapMemoryRule = (rule: MemoryRuleRow): MappedMemoryRule => {
  return {
    id: rule.publicId,
    memory_store_id: linkedPublicId(rule.memoryStore) ?? '',
    project_id: rule.memoryStore?.project?.publicId,
    on: rule.on,
    source_agent_ids: rule.sourceAgentIds,
    agent_id: linkedPublicId(rule.agent),
    tool_id: linkedPublicId(rule.tool),
    action: rule.action,
    preset_parameters: rule.presetParameters,
    prompt: rule.prompt,
    ai_provider_id: linkedPublicId(rule.aiProvider),
    model: rule.model,
    enabled: rule.enabled,
    created_at: rule.createdAt,
    updated_at: rule.updatedAt,
  };
};

/**
 * The accessor supplies the reload-after-write and the not-found throw. Its
 * `scopedWhere` is not usable here — it filters on the row's own `project_id`,
 * and a rule has none — so the scoped lookup below stays hand-written and puts
 * the project filter on the store join instead.
 */
const memoryRules = makeResourceAccessor<MemoryRuleRow>({
  model: () => {
    return db.MemoryRule;
  },
  includes: () => {
    return memoryRuleIncludes();
  },
  label: 'MemoryRule',
});

const loadRule = async (args: {
  id: string;
  projectIds?: number[];
}): Promise<MemoryRuleRow> => {
  const rule = (await db.MemoryRule.findOne({
    where: { publicId: args.id },
    include: memoryRuleIncludes(args.projectIds),
  })) as MemoryRuleRow | null;
  if (!rule) throw memoryRules.notFound(args.id);
  return rule;
};

export type MemoryRuleWriteArgs = {
  on?: MemoryRuleEvent;
  sourceAgentIds?: string[] | null;
  agentId?: number | null;
  toolId?: number | null;
  action?: string | null;
  presetParameters?: Record<string, unknown> | null;
  prompt?: string | null;
  aiProviderId?: number | null;
  model?: string | null;
  enabled?: boolean;
};

const assertValid = (shape: Parameters<typeof validateMemoryRule>[0]): void => {
  const message = validateMemoryRule(shape);
  if (message) {
    throw new DomainError('MEMORY_RULE_VALIDATION_FAILED', message);
  }
};

export const createMemoryRule = async (
  args: MemoryRuleWriteArgs & { memoryStoreId: number }
): Promise<MappedMemoryRule> => {
  log(
    'createMemoryRule: memoryStoreId=%d on=%s agentId=%s toolId=%s',
    args.memoryStoreId,
    args.on,
    args.agentId,
    args.toolId
  );

  assertValid(args);

  const rule = await db.MemoryRule.create({
    memoryStoreId: args.memoryStoreId,
    on: args.on,
    sourceAgentIds: args.sourceAgentIds ?? null,
    agentId: args.agentId ?? null,
    toolId: args.toolId ?? null,
    action: args.action ?? null,
    presetParameters: args.presetParameters ?? null,
    prompt: args.prompt ?? null,
    aiProviderId: args.aiProviderId ?? null,
    model: args.model ?? null,
    enabled: args.enabled ?? true,
  });

  return mapMemoryRule(await memoryRules.reload(rule));
};

export const listMemoryRules = async (args: {
  projectIds?: number[];
  memoryStoreId?: number;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedMemoryRule>> => {
  log(
    'listMemoryRules: projectIds=%o memoryStoreId=%s',
    args.projectIds,
    args.memoryStoreId
  );

  const where: Record<string, unknown> = {};
  if (args.memoryStoreId !== undefined) {
    where.memoryStoreId = args.memoryStoreId;
  }

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['createdAt', 'DESC']],
    query: ({ limit, offset, order }) => {
      return db.MemoryRule.findAndCountAll({
        where,
        include: memoryRuleIncludes(args.projectIds),
        distinct: true,
        order,
        limit,
        offset,
      });
    },
    map: (rule) => {
      return mapMemoryRule(rule as MemoryRuleRow);
    },
  });
};

export const getMemoryRule = async (args: {
  id: string;
  projectIds?: number[];
}): Promise<MappedMemoryRule> => {
  return mapMemoryRule(await loadRule(args));
};

const WRITABLE_FIELDS = [
  'on',
  'sourceAgentIds',
  'agentId',
  'toolId',
  'action',
  'presetParameters',
  'prompt',
  'aiProviderId',
  'model',
  'enabled',
] as const;

/**
 * The rule as it *would* stand after the update, so the validation runs against
 * the effective shape. Checking the payload alone would let a one-field PATCH
 * pair a handler with a stored `prompt`, or move a handlerless rule onto the
 * message event, from the side.
 */
const effectiveShape = (args: {
  rule: MemoryRuleRow;
  updates: MemoryRuleWriteArgs;
}) => {
  const pick = <K extends keyof MemoryRuleWriteArgs>(
    key: K,
    stored: unknown
  ): unknown => {
    return args.updates[key] !== undefined ? args.updates[key] : stored;
  };

  return {
    on: pick('on', args.rule.on) as string,
    agentId: pick('agentId', args.rule.agentId) as number | null,
    toolId: pick('toolId', args.rule.toolId) as number | null,
    action: pick('action', args.rule.action) as string | null,
    presetParameters: pick('presetParameters', args.rule.presetParameters) as
      object | null,
    prompt: pick('prompt', args.rule.prompt) as string | null,
    aiProviderId: pick('aiProviderId', args.rule.aiProviderId) as number | null,
    model: pick('model', args.rule.model) as string | null,
    sourceAgentIds: pick('sourceAgentIds', args.rule.sourceAgentIds),
  };
};

export const updateMemoryRule = async (
  args: MemoryRuleWriteArgs & { id: string; projectIds?: number[] }
): Promise<MappedMemoryRule> => {
  log('updateMemoryRule: id=%s', args.id);

  const rule = await loadRule(args);

  assertValid(effectiveShape({ rule, updates: args }));

  const updates: Record<string, unknown> = {};
  for (const field of WRITABLE_FIELDS) {
    if (args[field] !== undefined) updates[field] = args[field];
  }
  await rule.update(updates);

  return mapMemoryRule(await memoryRules.reload(rule));
};

export const deleteMemoryRule = async (args: {
  id: string;
  projectIds?: number[];
}): Promise<void> => {
  log('deleteMemoryRule: id=%s', args.id);

  const rule = await loadRule(args);
  await rule.destroy();
};

/**
 * The enabled rules bound to one event whose selector admits this agent, with
 * their store and handler loaded — the dispatcher's only read of the table.
 *
 * `source_agent_ids: null` is every agent in the store's project, so the
 * project filter is the selector's outer bound and is applied in SQL; the
 * per-agent narrowing happens here because a JSONB array containment check
 * would not also express "null means all".
 */
export const findMemoryRulesForEvent = async (args: {
  on: MemoryRuleEvent;
  projectId: number;
  agentPublicId: string;
}): Promise<MemoryRuleRow[]> => {
  const rules = (await db.MemoryRule.findAll({
    where: { on: args.on, enabled: true },
    include: memoryRuleIncludes([args.projectId]),
    order: [['createdAt', 'ASC']],
  })) as MemoryRuleRow[];

  return rules.filter((rule) => {
    return (
      rule.sourceAgentIds === null ||
      rule.sourceAgentIds.includes(args.agentPublicId)
    );
  });
};

/** Every agent that handles a rule in this project — the loop guard's input. */
export const findHandlerAgentIds = async (args: {
  projectId: number;
}): Promise<number[]> => {
  const rules = (await db.MemoryRule.findAll({
    attributes: ['agentId'],
    where: { enabled: true },
    include: [
      {
        model: db.MemoryStore,
        as: 'memoryStore',
        required: true,
        attributes: [],
        where: { projectId: args.projectId },
      },
    ],
  })) as Array<{ agentId: number | null }>;

  return rules
    .map((rule) => {
      return rule.agentId;
    })
    .filter((agentId): agentId is number => {
      return agentId !== null;
    });
};
