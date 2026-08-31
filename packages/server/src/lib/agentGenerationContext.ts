import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import type { LanguageModel, Tool } from 'ai';
import createDebug from 'debug';
import type { AuthUser } from 'src/Context';

import { DomainError } from '../errors';
import { buildAllMessages } from './agentGenerationHelpers';
import { resolveAgentForGeneration } from './agentGenerationRecovery';
import type { TypedAgent } from './agentGenerationTypes';
import {
  buildKnowledgeMessages,
  mergeKnowledgeConfig,
  readKnowledgeConfig,
} from './agentKnowledge';
import { resolveAgentModel } from './agentModelResolution';
import { resolveServedAgentVersion } from './agentServedVersion';
import { normalizeToolChoice, type TurnToolChoice } from './agentStepRules';
import { readAgentToolBindings, splitToolBindings } from './agentToolBindings';
import { resolveAgentToolSurface } from './agentToolSurface';
import { resolveServerToolContextIdentity } from './generationAttribution';
import {
  type GenerationInputMessage,
  resolveGenerationInputMessages,
} from './generationInputMessages';
import { pinServerIdentityToolContext } from './toolContext';

const log = createDebug('soat:generation');

export type GenerationContext = {
  typedAgent: TypedAgent;
  model: LanguageModel;
  resolvedTools: Record<string, Tool>;
  allMessages: Array<{ role: string; content: unknown }>;
  /**
   * The caller's messages after content resolution, without the agent's
   * instructions or its knowledge injections — the replayable half of
   * {@link GenerationContext.allMessages}.
   *
   * This is what gets persisted on the generation, so a promoted dataset item
   * replays the turn's real input against whichever agent it is later run on,
   * and picks up that agent's own instructions and knowledge rather than a copy
   * of the original's.
   */
  inputMessages: Array<{ role: string; content: unknown }>;
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
  /**
   * The tool choice this turn runs under — the agent's own, on a continuation
   * as much as on the turn that started the chain. Resolved once here so the
   * stream and non-stream paths cannot disagree about it.
   */
  toolChoice: TurnToolChoice;
};

/**
 * A fresh generation cannot proceed without a model, so this path turns
 * {@link resolveAgentModel}'s reported failure into the `AI_PROVIDER_NOT_FOUND`
 * the API answers with. (The resumed path reports it as an unrecoverable
 * pending generation instead — the one thing the two chains never shared.)
 */
const resolveGenerationModel = async (args: {
  agentId: string;
  typedAgent: TypedAgent;
}): Promise<{ model: LanguageModel }> => {
  const resolution = await resolveAgentModel(args.typedAgent);

  /* istanbul ignore next -- see the failure docs on resolveAgentModel */
  if (resolution.failure) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      resolution.failure === 'no_binding'
        ? `Agent '${args.agentId}' has neither an AI provider nor a model route.`
        : `AI provider for agent '${args.agentId}' could not be resolved.`
    );
  }

  return { model: resolution.model };
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
      base: readKnowledgeConfig(args.typedAgent.knowledgeConfig),
      override: readKnowledgeConfig(args.knowledgeConfig),
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

// The identity chokepoint (#850): every fresh generation builds its context
// here, so pinning once makes the reserved `tool_context` keys unforgeable on
// every path, with no per-entry-point pin left to forget. The pinned bag is
// what `pendingState` persists, so a recovered generation resumes trusted.
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

export type BuildGenerationContextArgs = {
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
  /** Forces one archived agent version — see `resolveServedAgentVersion`. */
  pinnedAgentVersion?: number | null;
};

export const buildGenerationContext = async (
  args: BuildGenerationContextArgs
): Promise<GenerationContext> => {
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

  // Before anything reads the config: under a staged rollout everything below
  // must come from the assigned archived version, not the live row.
  const { typedAgent, agentVersion } = await resolveServedAgentVersion({
    agent: liveAgent,
    sessionId: args.sessionId,
    pinnedVersion: args.pinnedAgentVersion,
  });

  const resolvedMessages = await resolveGenerationInputMessages({
    projectIds: args.projectIds,
    messages: args.messages,
    authHeader: args.authHeader,
    authUser: args.authUser,
    allowedToolIds: splitToolBindings(readAgentToolBindings(typedAgent))
      .toolIds,
    agentBoundaryPolicy: typedAgent.boundaryPolicy,
    toolContext, // identity-pinned, not the raw caller bag (#345)
  });
  const { model } = await resolveGenerationModel({
    agentId: args.agentId,
    typedAgent,
  });

  // Generated up front (before tool resolution) so the approval gate can freeze
  // it onto any item it files — a tool-call approval's continuation is linked
  // back to this generation via `initiator_generation_id`.
  const generationId = generatePublicId(PUBLIC_ID_PREFIXES.generation);

  const resolvedTools = await resolveAgentToolSurface({
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
    inputMessages: resolvedMessages,
    generationId,
    toolContext: toolContext ?? null,
    remainingDepth: args.remainingDepth ?? null,
    agentVersion,
    toolChoice: normalizeToolChoice(typedAgent.toolChoice),
  };
};
