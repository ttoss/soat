import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import type { LanguageModel, Tool } from 'ai';
import createDebug from 'debug';
import type { AuthUser } from 'src/Context';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { DomainError } from '../errors';
import { buildAllMessages, type TypedAgent } from './agentGenerationHelpers';
import { resolveAgentForGeneration } from './agentGenerationRecovery';
import {
  buildKnowledgeMessages,
  buildKnowledgeTools,
  mergeKnowledgeConfig,
} from './agentKnowledge';
import { buildModel } from './agentModel';
import { resolveAgentTools } from './agentToolResolver';
import {
  type GenerationInputMessage,
  resolveGenerationInputMessages,
} from './generationInputMessages';
import type { InlineToolDefinition } from './tools';

const log = createDebug('soat:generation');

export type GenerationContext = {
  typedAgent: TypedAgent;
  model: LanguageModel;
  resolvedTools: Record<string, Tool>;
  allMessages: Array<{ role: string; content: unknown }>;
  generationId: string;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
};

const resolveGenerationModel = async (args: {
  agentId: string;
  typedAgent: TypedAgent;
}) => {
  const resolved = await resolveAiProviderSecret({
    aiProviderId: args.typedAgent.aiProvider.publicId,
  });

  // Defensive TOCTOU guard: the agent is loaded with its aiProvider join
  // (aiProviderId is a NOT NULL FK), so a consistent DB always resolves the
  // secret here. This branch only fires if the provider row is deleted
  // between the agent load and this lookup — unreachable through any entry
  // point without racing a concurrent delete or mocking an owned module.
  /* istanbul ignore next */
  if (!resolved) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider for agent '${args.agentId}' could not be resolved.`
    );
  }

  const model = await buildModel({
    provider: resolved.provider,
    secretValue: resolved.secretValue,
    model: args.typedAgent.model ?? resolved.defaultModel,
    baseUrl: resolved.baseUrl,
    config: resolved.config as Record<string, unknown> | undefined,
  });

  return { model, provider: resolved.provider };
};

const assembleContextMessages = async (args: {
  agentId: string;
  projectIds?: number[];
  typedAgent: TypedAgent;
  resolvedMessages: Array<{ role: string; content: unknown }>;
  knowledgeConfig?: object;
}): Promise<Array<{ role: string; content: unknown }>> => {
  const knowledgeMessages = await buildKnowledgeMessages({
    knowledgeConfig: mergeKnowledgeConfig({
      base: args.typedAgent.knowledgeConfig,
      override: args.knowledgeConfig,
    }),
    projectIds: args.projectIds,
    messages: args.resolvedMessages,
  });

  log(
    'assembleContextMessages: agentId=%s knowledgeMessages=%d userMessages=%d',
    args.agentId,
    knowledgeMessages.length,
    args.resolvedMessages.length
  );

  const allMessages = buildAllMessages(args.typedAgent.instructions, [
    ...knowledgeMessages,
    ...args.resolvedMessages,
  ]);

  log('assembleContextMessages: allMessages=%o', allMessages);

  return allMessages;
};

const resolveGenerationTools = async (args: {
  agentId: string;
  projectIds?: number[];
  typedAgent: TypedAgent;
  authHeader?: string;
  toolContext?: Record<string, string>;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  remainingDepth?: number;
}): Promise<Record<string, Tool>> => {
  // No branch on toolIds/tools presence — resolveAgentTools no-ops on empty
  // input, so this covers "no tools at all" the same way as either alone.
  const resolvedTools = await resolveAgentTools({
    toolIds: (args.typedAgent.toolIds as string[] | null) ?? [],
    tools: args.typedAgent.tools as InlineToolDefinition[] | null,
    projectId: args.typedAgent.project.id as number,
    projectIds: args.projectIds,
    boundaryPolicy: args.typedAgent.boundaryPolicy,
    authHeader: args.authHeader,
    toolContext: args.toolContext,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    remainingDepth: args.remainingDepth,
  });

  buildKnowledgeTools({
    agentId: args.agentId,
    projectIds: args.projectIds,
    typedAgent: args.typedAgent,
    resolvedTools,
  });

  return resolvedTools;
};

export const buildGenerationContext = async (args: {
  agentId: string;
  projectIds?: number[];
  messages: GenerationInputMessage[];
  authHeader?: string;
  authUser?: AuthUser;
  toolContext?: Record<string, string>;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  remainingDepth?: number;
  knowledgeConfig?: object;
}): Promise<GenerationContext> => {
  const typedAgent = await resolveAgentForGeneration({
    agentId: args.agentId,
    projectIds: args.projectIds,
  });

  if (!typedAgent)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.agentId}' not found.`
    );

  const resolvedMessages = await resolveGenerationInputMessages({
    projectIds: args.projectIds,
    messages: args.messages,
    authHeader: args.authHeader,
    authUser: args.authUser,
    allowedToolIds: Array.isArray(typedAgent.toolIds)
      ? (typedAgent.toolIds as string[])
      : undefined,
    agentBoundaryPolicy: typedAgent.boundaryPolicy,
  });
  const { model } = await resolveGenerationModel({
    agentId: args.agentId,
    typedAgent,
  });

  const resolvedTools = await resolveGenerationTools({
    agentId: args.agentId,
    projectIds: args.projectIds,
    typedAgent,
    authHeader: args.authHeader,
    toolContext: args.toolContext,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    remainingDepth: args.remainingDepth,
  });

  const allMessages = await assembleContextMessages({
    agentId: args.agentId,
    projectIds: args.projectIds,
    typedAgent,
    resolvedMessages,
    knowledgeConfig: args.knowledgeConfig,
  });

  return {
    typedAgent,
    model,
    resolvedTools,
    allMessages,
    generationId: generatePublicId(PUBLIC_ID_PREFIXES.generation),
    toolContext: args.toolContext ?? null,
    remainingDepth: args.remainingDepth ?? null,
  };
};
