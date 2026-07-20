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
import {
  deriveLegacyToolFields,
  readAgentToolBindings,
} from './agentToolBindings';
import { buildResolverGuardrailContext } from './agentToolGuardrail';
import { resolveAgentTools } from './agentToolResolver';
import {
  type GenerationInputMessage,
  resolveGenerationInputMessages,
} from './generationInputMessages';

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
  generationId: string;
  projectIds?: number[];
  typedAgent: TypedAgent;
  authHeader?: string;
  toolContext?: Record<string, string>;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  remainingDepth?: number;
  guardrailContext?: Record<string, unknown> | null;
}): Promise<Record<string, Tool>> => {
  // Canonical bindings (legacy rows normalize lazily); no branch on presence —
  // resolveAgentTools no-ops on empty input, so this covers "no tools at all".
  const bindings = readAgentToolBindings(args.typedAgent);
  const legacyViews = deriveLegacyToolFields(bindings);
  const guardrail = await buildResolverGuardrailContext({
    agentId: args.agentId,
    generationId: args.generationId,
    projectId: args.typedAgent.project.id as number,
    projectPublicId: args.typedAgent.project.publicId,
    projectGuardrailIds: args.typedAgent.project.guardrailIds,
    agentGuardrailIds: args.typedAgent.guardrailIds,
    sessionId: args.toolContext?.sessionId ?? null,
    authHeader: args.authHeader,
    guardrailContext: args.guardrailContext,
  });
  const resolvedTools = await resolveAgentTools({
    toolIds: legacyViews.toolIds ?? [],
    tools: legacyViews.tools,
    projectId: args.typedAgent.project.id as number,
    projectIds: args.projectIds,
    boundaryPolicy: args.typedAgent.boundaryPolicy,
    authHeader: args.authHeader,
    toolContext: args.toolContext,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    remainingDepth: args.remainingDepth,
    // The per-binding `approval_policy` is deprecated and no longer honoured as
    // a routing source (task 2.7): guardrails are the single tool-call gating
    // mechanism. The field stays readable/writable for the deprecation window
    // but never builds an approval-gate context here.
    guardrail,
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
  guardrailContext?: Record<string, unknown> | null;
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

  const boundToolIds = deriveLegacyToolFields(
    readAgentToolBindings(typedAgent)
  ).toolIds;
  const resolvedMessages = await resolveGenerationInputMessages({
    projectIds: args.projectIds,
    messages: args.messages,
    authHeader: args.authHeader,
    authUser: args.authUser,
    allowedToolIds: boundToolIds ?? undefined,
    agentBoundaryPolicy: typedAgent.boundaryPolicy,
  });
  const { model } = await resolveGenerationModel({
    agentId: args.agentId,
    typedAgent,
  });

  // Generated up front (before tool resolution) so the approval gate can freeze
  // it onto any item it files — a tool-call approval's continuation is linked
  // back to this generation via `initiator_generation_id`.
  const generationId = generatePublicId(PUBLIC_ID_PREFIXES.generation);

  const resolvedTools = await resolveGenerationTools({
    agentId: args.agentId,
    generationId,
    projectIds: args.projectIds,
    typedAgent,
    authHeader: args.authHeader,
    toolContext: args.toolContext,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    remainingDepth: args.remainingDepth,
    guardrailContext: args.guardrailContext,
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
    generationId,
    toolContext: args.toolContext ?? null,
    remainingDepth: args.remainingDepth ?? null,
  };
};
