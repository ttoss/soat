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
  normalizeKnowledgeConfig,
} from './agentKnowledge';
import { buildModel } from './agentModel';
import { narrowToActiveTools } from './agents';
import { resolveServedAgentVersion } from './agentServedVersion';
import {
  deriveLegacyToolFields,
  readAgentToolBindings,
} from './agentToolBindings';
import { buildResolverGuardrailContext } from './agentToolGuardrail';
import { resolveAgentTools } from './agentToolResolver';
import { resolveServerToolContextIdentity } from './generationAttribution';
import {
  type GenerationInputMessage,
  resolveGenerationInputMessages,
} from './generationInputMessages';
import {
  buildRoutedModel,
  resolveConsumerModelRoute,
  ROUTED_PROVIDER_LABEL,
} from './modelRoutes';
import { pinServerIdentityToolContext } from './toolContext';

const log = createDebug('soat:generation');

export type GenerationContext = {
  typedAgent: TypedAgent;
  model: LanguageModel;
  resolvedTools: Record<string, Tool>;
  allMessages: Array<{ role: string; content: unknown }>;
  generationId: string;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
  /**
   * The agent config version this generation actually ran against — the live
   * row's version, or the version a staged rollout assigned to this request.
   * Stamped on the generation record so traces and evals can compare versions
   * after the fact.
   */
  agentVersion: number;
};

const resolveGenerationModel = async (args: {
  agentId: string;
  typedAgent: TypedAgent;
}) => {
  // Chain: the agent's own route → its pinned provider → the project default
  // (`resolveConsumerModelRoute` returns null as soon as a pin is present, so a
  // project-wide default can never override a deliberate binding).
  const route = await resolveConsumerModelRoute({
    projectId: args.typedAgent.project.id as number,
    modelRouteId: args.typedAgent.modelRoute?.publicId,
    aiProviderId: args.typedAgent.aiProvider?.publicId,
  });
  if (route) {
    return {
      model: await buildRoutedModel({ route }),
      provider: ROUTED_PROVIDER_LABEL,
    };
  }

  // The write-time guards guarantee a pinned provider once neither a route nor a
  // project default resolves; this only fires if a row violates them (never
  // reachable through a write path).
  /* istanbul ignore next */
  if (!args.typedAgent.aiProvider) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `Agent '${args.agentId}' has neither an AI provider nor a model route.`
    );
  }

  const resolved = await resolveAiProviderSecret({
    aiProviderId: args.typedAgent.aiProvider.publicId,
  });

  // Defensive TOCTOU guard: the agent is loaded with its aiProvider join and
  // the guard above proved it is set, so a consistent DB always resolves the
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
      base: normalizeKnowledgeConfig(args.typedAgent.knowledgeConfig),
      override: normalizeKnowledgeConfig(args.knowledgeConfig),
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
  sessionId?: string | null;
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
    // #851 — the typed argument, never the `tool_context` bag: guard
    // decisions and their audit records must attribute to a session id the
    // server derived, not one a caller typed.
    sessionId: args.sessionId ?? null,
    authHeader: args.authHeader,
    guardrailContext: args.guardrailContext,
  });
  const resolvedTools = await resolveAgentTools({
    // `active_tool_ids` narrows the bound set before resolution — filtering ids
    // here rather than resolved tools afterwards avoids needing an id→name map
    // on this path.
    toolIds: narrowToActiveTools({
      toolIds: legacyViews.toolIds ?? [],
      activeToolIds: args.typedAgent.activeToolIds,
    }),
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
    // Guardrails are the single tool-call gating mechanism.
    guardrail,
    // Attributes a successful tool call to this agent/generation on the activity
    // feed (approvals PRD Phase 4).
    activity: {
      projectId: args.typedAgent.project.id as number,
      agentId: args.agentId,
      generationId: args.generationId,
    },
  });

  buildKnowledgeTools({
    agentId: args.agentId,
    projectIds: args.projectIds,
    typedAgent: args.typedAgent,
    resolvedTools,
  });

  return resolvedTools;
};

// #850 — the identity chokepoint. Every fresh generation (direct agent,
// conversation, session, trigger, orchestration node, nested `soat` tool
// call) builds its context in buildGenerationContext, so pinning once here
// makes the reserved `tool_context` identity keys unforgeable on every path —
// there is no per-entry-point pin left to forget. The pinned bag is what gets
// persisted into `pendingState`, so a recovered generation resumes with the
// same trusted identity.
const resolvePinnedToolContext = async (args: {
  toolContext?: Record<string, string>;
  sessionId?: string | null;
}): Promise<Record<string, string> | undefined> => {
  return pinServerIdentityToolContext({
    toolContext: args.toolContext,
    identity: await resolveServerToolContextIdentity({
      sessionId: args.sessionId,
    }),
  });
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
  sessionId?: string | null;
}): Promise<GenerationContext> => {
  const toolContext = await resolvePinnedToolContext(args);

  const liveAgent = await resolveAgentForGeneration({
    agentId: args.agentId,
    projectIds: args.projectIds,
  });

  if (!liveAgent)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.agentId}' not found.`
    );

  // Resolved before anything reads the config: while a staged rollout is active
  // this request is assigned one of its two archived versions, and everything
  // below — instructions, model, tools, guardrails — must come from that
  // version rather than from the live row.
  const { typedAgent, agentVersion } = await resolveServedAgentVersion({
    agent: liveAgent,
    sessionId: args.sessionId,
  });

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
    toolContext,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    remainingDepth: args.remainingDepth,
    guardrailContext: args.guardrailContext,
    sessionId: args.sessionId,
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
    toolContext: toolContext ?? null,
    remainingDepth: args.remainingDepth ?? null,
    agentVersion,
  };
};
