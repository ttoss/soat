import createDebug from 'debug';
import { db } from 'src/db';

import {
  lookupMemoryInternalId,
  lookupSecretInternalId,
} from './formationsHelpers';
import { getFormationModule } from './formationsRegistry';
import { createAgent, deleteAgent } from './agents';
import {
  createAgentTool,
  deleteAgentTool,
  updateAgentTool,
} from './agentToolsCrud';
import {
  createAiProvider,
  deleteAiProvider,
  updateAiProvider,
} from './aiProviders';
import { createDocument, deleteDocument } from './documents';
import { createMemory, deleteMemory, updateMemory } from './memories';
import { createMemoryEntry, deleteMemoryEntry } from './memoryEntries';
import { createWebhook, deleteWebhook, updateWebhook } from './webhooks';

const log = createDebug('soat:formations');

// ── Handler Types ─────────────────────────────────────────────────────────

type P = Record<string, unknown>;

type CreateHandlerArgs = { p: P; projectId: number };
type UpdateHandlerArgs = { p: P; physicalResourceId: string };
type DeleteHandlerArgs = { physicalResourceId: string };

type CreateHandler = (args: CreateHandlerArgs) => Promise<string>;
type UpdateHandler = (args: UpdateHandlerArgs) => Promise<void>;
type DeleteHandler = (args: DeleteHandlerArgs) => Promise<void>;

// ── Create Handlers ───────────────────────────────────────────────────────

const createAiProviderHandler: CreateHandler = async ({ p, projectId }) => {
  log(
    'createAiProviderHandler: creating ai_provider projectId=%d name=%s provider=%s secretId=%s',
    projectId,
    p.name,
    p.provider,
    p.secret_id
  );
  let secretId: number | undefined;
  if (p.secret_id && typeof p.secret_id === 'string') {
    log('createAiProviderHandler: resolving secret publicId=%s', p.secret_id);
    secretId = await lookupSecretInternalId(p.secret_id);
    log(
      'createAiProviderHandler: resolved secret publicId=%s to internalId=%d',
      p.secret_id,
      secretId
    );
  }
  const created = await createAiProvider({
    projectId,
    secretId,
    name: p.name as string,
    provider: p.provider as Parameters<typeof createAiProvider>[0]['provider'],
    defaultModel: p.default_model as string,
    baseUrl: p.base_url as string | undefined,
    config: p.config as Record<string, unknown> | undefined,
  });
  log(
    'createAiProviderHandler: created ai_provider id=%s publicId=%s',
    created.id,
    created.id
  );
  return created.id;
};

const createAgentToolHandler: CreateHandler = async ({ p, projectId }) => {
  const created = await createAgentTool({
    projectId,
    type: p.type as string | undefined,
    name: p.name as string,
    description: p.description as string | undefined,
    parameters: p.parameters as object | undefined,
    execute: p.execute as object | undefined,
    mcp: p.mcp as object | undefined,
    actions: p.actions as string[] | undefined,
    presetParameters: p.preset_parameters as object | undefined,
  });
  return created.id;
};

const createAgentHandler: CreateHandler = async ({ p, projectId }) => {
  const created = await createAgent({
    projectId,
    aiProviderId: p.ai_provider_id as string,
    name: p.name as string | undefined,
    instructions: p.instructions as string | undefined,
    model: p.model as string | undefined,
    toolIds: p.tool_ids as string[] | undefined,
    maxSteps: p.max_steps as number | undefined,
    toolChoice: p.tool_choice as object | undefined,
    stopConditions: p.stop_conditions as object[] | undefined,
    activeToolIds: p.active_tool_ids as string[] | undefined,
    stepRules: p.step_rules as object[] | undefined,
    boundaryPolicy: p.boundary_policy as object | undefined,
    temperature: p.temperature as number | undefined,
    knowledgeConfig: p.knowledge_config as object | undefined,
  });
  return created.id;
};

const createDocumentHandler: CreateHandler = async ({ p, projectId }) => {
  const created = await createDocument({
    projectId,
    content: p.content as string,
    path: p.path as string | undefined,
    filename: p.filename as string | undefined,
    title: p.title as string | undefined,
    metadata: p.metadata as Record<string, unknown> | undefined,
    tags: p.tags as Record<string, string> | undefined,
  });
  return created.id;
};

const createMemoryHandler: CreateHandler = async ({ p, projectId }) => {
  const created = await createMemory({
    projectId,
    name: p.name as string,
    description: p.description as string | undefined,
    tags: p.tags as string[] | undefined,
  });
  return created.id;
};

const createMemoryEntryHandler: CreateHandler = async ({ p }) => {
  const memoryInternalId = await lookupMemoryInternalId(p.memory_id as string);
  const created = await createMemoryEntry({
    memoryId: memoryInternalId,
    content: p.content as string,
    source: p.source as Parameters<typeof createMemoryEntry>[0]['source'],
  });
  return created.id;
};

const createWebhookHandler: CreateHandler = async ({ p, projectId }) => {
  const created = await createWebhook({
    projectId,
    name: p.name as string,
    description: p.description as string | undefined,
    url: p.url as string,
    events: p.events as string[],
  });
  return created.id;
};

const CREATE_HANDLERS: Record<string, CreateHandler> = {
  ai_provider: createAiProviderHandler,
  agent_tool: createAgentToolHandler,
  agent: createAgentHandler,
  document: createDocumentHandler,
  memory: createMemoryHandler,
  memory_entry: createMemoryEntryHandler,
  webhook: createWebhookHandler,
};

// ── Update Handlers ───────────────────────────────────────────────────────

const updateAiProviderHandler: UpdateHandler = async ({
  p,
  physicalResourceId,
}) => {
  let secretId: number | undefined;
  if (p.secret_id && typeof p.secret_id === 'string') {
    secretId = await lookupSecretInternalId(p.secret_id);
  }
  await updateAiProvider({
    id: physicalResourceId,
    secretId,
    name: p.name as string | undefined,
    provider: p.provider as Parameters<typeof updateAiProvider>[0]['provider'],
    defaultModel: p.default_model as string | undefined,
    baseUrl: p.base_url as string | null | undefined,
    config: p.config as Record<string, unknown> | null | undefined,
  });
};

const updateAgentToolHandler: UpdateHandler = async ({
  p,
  physicalResourceId,
}) => {
  await updateAgentTool({
    id: physicalResourceId,
    name: p.name as string | undefined,
    description: p.description as string | null | undefined,
    parameters: p.parameters as object | null | undefined,
    execute: p.execute as object | null | undefined,
    mcp: p.mcp as object | null | undefined,
    actions: p.actions as string[] | null | undefined,
    presetParameters: p.preset_parameters as object | null | undefined,
  });
};

const AGENT_PROP_MAP: Record<string, string> = {
  name: 'name',
  instructions: 'instructions',
  model: 'model',
  tool_ids: 'toolIds',
  max_steps: 'maxSteps',
  tool_choice: 'toolChoice',
  stop_conditions: 'stopConditions',
  active_tool_ids: 'activeToolIds',
  step_rules: 'stepRules',
  boundary_policy: 'boundaryPolicy',
  temperature: 'temperature',
  knowledge_config: 'knowledgeConfig',
};

const updateAgentHandler: UpdateHandler = async ({ p, physicalResourceId }) => {
  const instance = await db.Agent.findOne({
    where: { publicId: physicalResourceId },
  });
  if (!instance) throw new Error(`Agent not found: ${physicalResourceId}`);
  const updates: Record<string, unknown> = {};
  for (const [propKey, fieldName] of Object.entries(AGENT_PROP_MAP)) {
    if (p[propKey] !== undefined) updates[fieldName] = p[propKey];
  }
  await instance.update(updates);
};

const updateMemoryHandler: UpdateHandler = async ({
  p,
  physicalResourceId,
}) => {
  await updateMemory({
    id: physicalResourceId,
    name: p.name as string | undefined,
    description: p.description as string | null | undefined,
    tags: p.tags as string[] | null | undefined,
  });
};

const updateMemoryEntryHandler: UpdateHandler = async ({
  p,
  physicalResourceId,
}) => {
  const entry = await db.MemoryEntry.findOne({
    where: { publicId: physicalResourceId },
  });
  if (!entry) throw new Error(`MemoryEntry not found: ${physicalResourceId}`);
  if (p.content !== undefined) {
    entry.content = p.content as string;
    await entry.save();
  }
};

const updateWebhookHandler: UpdateHandler = async ({
  p,
  physicalResourceId,
}) => {
  await updateWebhook({
    id: physicalResourceId,
    name: p.name as string | undefined,
    description: p.description as string | undefined,
    url: p.url as string | undefined,
    events: p.events as string[] | undefined,
  });
};

const UPDATE_HANDLERS: Record<string, UpdateHandler> = {
  ai_provider: updateAiProviderHandler,
  agent_tool: updateAgentToolHandler,
  agent: updateAgentHandler,
  memory: updateMemoryHandler,
  memory_entry: updateMemoryEntryHandler,
  webhook: updateWebhookHandler,
  // documents are no-op for update
  document: async () => {
    return undefined;
  },
};

// ── Delete Handler ────────────────────────────────────────────────────────

const DELETE_HANDLERS: Record<string, DeleteHandler> = {
  ai_provider: async ({ physicalResourceId }) => {
    await deleteAiProvider({ id: physicalResourceId });
  },
  agent_tool: async ({ physicalResourceId }) => {
    await deleteAgentTool({ id: physicalResourceId });
  },
  agent: async ({ physicalResourceId }) => {
    await deleteAgent({ id: physicalResourceId });
  },
  document: async ({ physicalResourceId }) => {
    await deleteDocument({ id: physicalResourceId });
  },
  memory: async ({ physicalResourceId }) => {
    await deleteMemory({ id: physicalResourceId });
  },
  memory_entry: async ({ physicalResourceId }) => {
    await deleteMemoryEntry({ id: physicalResourceId });
  },
  webhook: async ({ physicalResourceId }) => {
    await deleteWebhook({ id: physicalResourceId });
  },
};

// ── Public API ────────────────────────────────────────────────────────────

export type ApplyArgs = {
  resourceType: string;
  resolvedProperties: Record<string, unknown>;
  projectId: number;
};

export const applyCreateResource = async (args: ApplyArgs): Promise<string> => {
  const formationModule = getFormationModule({
    resourceType: args.resourceType,
  });
  if (formationModule) {
    return formationModule.create({
      properties: args.resolvedProperties,
      projectId: args.projectId,
    });
  }

  const handler = CREATE_HANDLERS[args.resourceType];
  if (!handler)
    throw new Error(`Unsupported resource type: ${args.resourceType}`);
  return handler({ p: args.resolvedProperties, projectId: args.projectId });
};

export const applyUpdateResource = async (args: {
  resourceType: string;
  physicalResourceId: string;
  resolvedProperties: Record<string, unknown>;
}): Promise<void> => {
  const formationModule = getFormationModule({
    resourceType: args.resourceType,
  });
  if (formationModule) {
    return formationModule.update({
      physicalResourceId: args.physicalResourceId,
      properties: args.resolvedProperties,
    });
  }

  const handler = UPDATE_HANDLERS[args.resourceType];
  if (!handler)
    throw new Error(
      `Unsupported resource type for update: ${args.resourceType}`
    );
  return handler({
    p: args.resolvedProperties,
    physicalResourceId: args.physicalResourceId,
  });
};

export const applyDeleteResource = async (args: {
  resourceType: string;
  physicalResourceId: string;
}): Promise<void> => {
  const formationModule = getFormationModule({
    resourceType: args.resourceType,
  });
  if (formationModule) {
    return formationModule.delete({
      physicalResourceId: args.physicalResourceId,
    });
  }

  const handler = DELETE_HANDLERS[args.resourceType];
  if (!handler)
    throw new Error(
      `Unsupported resource type for delete: ${args.resourceType}`
    );
  return handler({ physicalResourceId: args.physicalResourceId });
};
