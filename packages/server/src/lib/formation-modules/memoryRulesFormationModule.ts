import type { MemoryRuleEvent } from '@soat/postgresdb';

import { lookupMemoryStoreInternalId } from '../formationsHelpers';
import { assertSourceAgentIds, resolveMemoryRuleRefs } from '../memoryRuleRefs';
import {
  createMemoryRule,
  deleteMemoryRule,
  getMemoryRule,
  updateMemoryRule,
  validateMemoryRule,
} from '../memoryRules';
import {
  toNullableObject,
  toNullableString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

/**
 * A `{ "ref": … }` has not resolved yet during the pure pre-flight, so the
 * shared validator is handed a presence marker rather than an id — the
 * "mutually exclusive" and "no override with a handler" rules only need to know
 * *whether* a handler is named.
 */
const asRefPresence = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : 'unresolved-ref';
};

const asSourceAgentIds = (value: unknown): string[] | null | undefined => {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => {
    return typeof item === 'string';
  });
};

const asEvent = (value: unknown): MemoryRuleEvent | undefined => {
  return typeof value === 'string' ? (value as MemoryRuleEvent) : undefined;
};

/**
 * The handler and provider refs, through the same resolver the REST route uses.
 * By apply time a `{ "ref": … }` has become a plain public id, so there is
 * nothing here the route does not also do — and one resolver is what keeps the
 * two doors from disagreeing about what "not found in this project" means.
 */
const resolveHandlerRefs = (args: {
  properties: Record<string, unknown>;
  projectId: number;
}) => {
  return resolveMemoryRuleRefs({
    projectId: args.projectId,
    agentId: toNullableString(args.properties.agent_id),
    toolId: toNullableString(args.properties.tool_id),
    aiProviderId: toNullableString(args.properties.ai_provider_id),
  });
};

const writeArgs = (properties: Record<string, unknown>) => {
  return {
    on: asEvent(properties.on),
    sourceAgentIds: asSourceAgentIds(properties.source_agent_ids),
    action: toNullableString(properties.action),
    presetParameters: toNullableObject(properties.preset_parameters) as Record<
      string,
      unknown
    > | null,
    prompt: toNullableString(properties.prompt),
    model: toNullableString(properties.model),
    enabled:
      typeof properties.enabled === 'boolean' ? properties.enabled : undefined,
  };
};

export const memoryRulesFormationModule = defineFormationModule({
  resourceType: 'memory_rule',
  // A rule is its store's ingestion policy, so it is governed by the store's
  // SRN — the same resource the REST routes authorize against.
  authorization: {
    srnResourceType: 'memory_store',
    create: 'memories:CreateMemoryRule',
    update: 'memories:UpdateMemoryRule',
    delete: 'memories:DeleteMemoryRule',
  },
  resourceLabel: 'memory rule',

  extraChecks: ({ properties, basePath, forUpdate, errors }) => {
    const message = validateMemoryRule({
      on: toNullableString(properties.on),
      agentId: asRefPresence(properties.agent_id),
      toolId: asRefPresence(properties.tool_id),
      action: toNullableString(properties.action),
      presetParameters: toNullableObject(properties.preset_parameters),
      prompt: toNullableString(properties.prompt),
      aiProviderId: asRefPresence(properties.ai_provider_id),
      model: toNullableString(properties.model),
      sourceAgentIds: properties.source_agent_ids,
    });

    if (!message) return;
    // A PATCH-style update payload may omit `on` to mean "leave the event
    // unchanged"; only the rules about what the payload *does* say apply then.
    if (forUpdate && message === "'on' is required") return;
    errors.push({ path: basePath, message });
  },

  create: async ({ properties, projectId }) => {
    const memoryStoreId = await lookupMemoryStoreInternalId({
      publicId: properties.memory_store_id as string,
      projectId,
    });
    const refs = await resolveHandlerRefs({ properties, projectId });
    const args = writeArgs(properties);
    await assertSourceAgentIds({
      projectId,
      sourceAgentIds: args.sourceAgentIds,
    });

    return createMemoryRule({ memoryStoreId, ...args, ...refs });
  },

  update: async ({ properties, physicalResourceId, projectId }) => {
    const refs = await resolveHandlerRefs({ properties, projectId });
    const args = writeArgs(properties);
    await assertSourceAgentIds({
      projectId,
      sourceAgentIds: args.sourceAgentIds,
    });

    await updateMemoryRule({ id: physicalResourceId, ...args, ...refs });
  },

  remove: ({ physicalResourceId }) => {
    return deleteMemoryRule({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getMemoryRule({ id: physicalResourceId });
  },
});
