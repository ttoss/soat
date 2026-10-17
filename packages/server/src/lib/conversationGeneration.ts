import { db } from '../db';
import { DomainError } from '../errors';
import { createGeneration } from './agentGeneration';
import type { GenerationResult } from './agentGenerationTypes';
import { addConversationMessage } from './conversationMessages';
import { emitResourceEvent } from './eventBus';
import { readFileBuffer } from './fileStorage';
import { agentReferences } from './resourceReferences';

type ConversationMessage = InstanceType<(typeof db)['ConversationMessage']> & {
  document?: InstanceType<(typeof db)['Document']> & {
    file?: InstanceType<(typeof db)['File']>;
  };
  actor?: InstanceType<(typeof db)['Actor']> | null;
};

type ConversationAndAgent = {
  conversation: InstanceType<(typeof db)['Conversation']>;
  generatingAgent: InstanceType<(typeof db)['Agent']>;
};

type GenerationContext = ConversationAndAgent & {
  messages: Array<ConversationMessage>;
  snapshotPosition: number;
};

const readMessageContent = async (
  msg: ConversationMessage
): Promise<string> => {
  const file = msg.document?.file;
  if (!file?.storagePath) {
    return '';
  }
  const buffer = await readFileBuffer({
    storageType: file.storageType,
    storagePath: file.storagePath,
  });
  return buffer ? buffer.toString('utf-8') : '';
};

const buildMessageEntry = async (args: {
  msg: ConversationMessage;
}): Promise<{ role: string; content: string }> => {
  const content = await readMessageContent(args.msg);
  if (args.msg.role === 'assistant') {
    return { role: 'assistant', content };
  }
  // The speaker's name is the only thing prefixed onto a turn. A message's
  // `metadata` is a caller-owned bag the platform stores and does not read, so
  // it does not reach the model: a caller who wants the model to see a field
  // writes it into the message.
  const speakerName = args.msg.actor?.name ?? 'participant';
  return {
    role: 'user',
    content: `[${speakerName}]: ${content}`,
  };
};

const buildConversationHistory = async (args: {
  messages: Array<ConversationMessage>;
}): Promise<Array<{ role: string; content: unknown }>> => {
  const entries = await Promise.all(
    args.messages.map(async (msg) => {
      const responseMessages = msg.responseMessages;
      // Expand stored AI SDK response messages (tool calls, tool results, final
      // text) so the LLM sees the full tool-use chain on subsequent turns.
      if (Array.isArray(responseMessages) && responseMessages.length > 0) {
        return responseMessages as Array<{ role: string; content: unknown }>;
      }
      return [await buildMessageEntry({ msg })];
    })
  );
  return entries.flat();
};

type InternalGenerationResult =
  | {
      status: 'completed';
      generationId: string;
      traceId: string;
      output?: GenerationResult['output'];
    }
  | {
      status: 'requires_action';
      generationId: string;
      traceId: string;
      requiredAction: NonNullable<GenerationResult['requiredAction']>;
    };

const runAgentGeneration = async (args: {
  agent: InstanceType<(typeof db)['Agent']>;
  conversationId: string;
  snapshotPosition: number;
  // The conversation's project, where the turn runs and is recorded.
  runProjectId: number;
  messagesForModel: Array<{ role: string; content: unknown }>;
  toolContext?: Record<string, string>;
  abortSignal?: AbortSignal;
  sessionId?: string;
  authHeader?: string;
  initiatorGenerationId?: string | null;
}): Promise<InternalGenerationResult> => {
  const result = await createGeneration({
    agentId: args.agent.publicId,
    runProjectId: args.runProjectId,
    messages: args.messagesForModel,
    toolContext: args.toolContext,
    abortSignal: args.abortSignal,
    sessionId: args.sessionId,
    // Persisted on the generation: a `write_memory` call mid-turn records its
    // generation, which the id walks up to its conversation, and a turn resumed
    // from a client-tool pause is stored after the snapshot it read.
    conversation: {
      id: args.conversationId,
      snapshotPosition: args.snapshotPosition,
    },
    authHeader: args.authHeader,
    initiatorGenerationId: args.initiatorGenerationId,
  });

  if (result instanceof ReadableStream) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      'Unexpected streaming response'
    );
  }

  if (result.status === 'requires_action') {
    return {
      status: 'requires_action',
      generationId: result.id,
      traceId: result.traceId,
      requiredAction: result.requiredAction!,
    };
  }

  return {
    status: 'completed',
    generationId: result.id,
    traceId: result.traceId,
    output: result.output,
  };
};

const runGenerationForAgent = async (args: {
  generatingAgent: GenerationContext['generatingAgent'];
  conversationId: string;
  snapshotPosition: number;
  runProjectId: number;
  messagesForModel: Array<{ role: string; content: unknown }>;
  model?: string;
  toolContext?: Record<string, string>;
  abortSignal?: AbortSignal;
  sessionId?: string;
  authHeader?: string;
  initiatorGenerationId?: string | null;
}): Promise<InternalGenerationResult> => {
  return runAgentGeneration({
    agent: args.generatingAgent,
    conversationId: args.conversationId,
    snapshotPosition: args.snapshotPosition,
    runProjectId: args.runProjectId,
    messagesForModel: args.messagesForModel,
    toolContext: args.toolContext,
    abortSignal: args.abortSignal,
    sessionId: args.sessionId,
    authHeader: args.authHeader,
    initiatorGenerationId: args.initiatorGenerationId,
  });
};

/**
 * Resolves the conversation and the agent that must generate in it, throwing
 * `RESOURCE_NOT_FOUND` for either. Exported because a background generation
 * has to run these same two checks *before* answering `202` — otherwise an
 * unknown agent would turn from a synchronous `404` into a failure the caller
 * could only discover by polling.
 */
export const resolveConversationAndAgent = async (args: {
  conversationId: string;
  agentId: string;
}): Promise<ConversationAndAgent> => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.conversationId },
  });

  if (!conversation) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found');
  }

  const generatingAgent = await agentReferences.find({
    id: args.agentId,
    projectId: conversation.projectId,
    reach: 'shares',
  });

  if (!generatingAgent) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Agent not found');
  }

  return { conversation, generatingAgent };
};

const loadGenerationContext = async (args: {
  conversationId: string;
  agentId: string;
  /** The session's window; `null` or absent defers to the agent's. */
  maxContextMessages?: number | null;
}): Promise<GenerationContext> => {
  const { conversation, generatingAgent } = await resolveConversationAndAgent({
    conversationId: args.conversationId,
    agentId: args.agentId,
  });

  const maxContextMessages =
    args.maxContextMessages ??
    (generatingAgent as unknown as { maxContextMessages: number | null })
      .maxContextMessages;

  const allMessages = await db.ConversationMessage.findAll({
    where: { conversationId: conversation.id },
    include: [
      {
        model: db.Document,
        as: 'document',
        include: [{ model: db.File, as: 'file' }],
      },
      { model: db.Actor, as: 'actor' },
    ],
    order: [['position', 'ASC']],
  });

  const messages =
    maxContextMessages != null && allMessages.length > maxContextMessages
      ? allMessages.slice(-maxContextMessages)
      : allMessages;

  const snapshotPosition =
    messages.length > 0 ? messages[messages.length - 1].position : -1;

  return {
    conversation,
    generatingAgent,
    messages: messages as ConversationMessage[],
    snapshotPosition,
  };
};

const buildPersonaSystem = (agent: {
  instructions?: string | null;
  name?: string | null;
}) => {
  const lines = agent.instructions ? [agent.instructions] : [];
  // Other turns arrive labelled `[<speaker>]: …` (`buildMessageEntry`), and a
  // model left alone answers in the same shape.
  lines.push(
    `You are ${
      agent.name ?? 'Assistant'
    }. Reply as this participant only — do not speak for any other actor. Do not prefix your reply with a \`[name]:\` speaker label.`
  );
  return lines.join('\n\n');
};

export type GenerateConversationMessageResult =
  | {
      status: 'completed';
      content: string;
      message: Awaited<ReturnType<typeof addConversationMessage>>;
      generationId: string;
      traceId: string;
      model?: string;
    }
  | {
      status: 'requires_action';
      generationId: string;
      traceId: string;
      requiredAction: NonNullable<GenerationResult['requiredAction']>;
    };

/**
 * Stores a completed turn and announces it as
 * `conversation_messages.generated`. Every route that completes a conversation
 * turn — generate, and a session's tool-outputs after a client-tool pause —
 * stores it here, so a turn lands and is announced the same way whichever
 * route finished it.
 *
 * The reply goes right after the last message the turn read, so a message that
 * arrived while it ran stays after the reply it did not see. Extraction is a
 * `memory_rules` subscriber on the event, so a conversation turn feeds a store
 * through the store's policy, not this agent's.
 */
export const storeGeneratedTurn = async (args: {
  conversation: InstanceType<(typeof db)['Conversation']>;
  agentId: string;
  // `null` when the generation recorded no snapshot: the reply is appended.
  snapshotPosition: number | null;
  generationId: string;
  traceId: string;
  output?: GenerationResult['output'];
}): Promise<
  Extract<GenerateConversationMessageResult, { status: 'completed' }>
> => {
  const content = args.output?.content ?? '';
  const responseMessages = args.output?.responseMessages;
  const message = await addConversationMessage({
    conversationId: args.conversation.publicId,
    message: content,
    role: 'assistant',
    agentId: args.agentId,
    position:
      args.snapshotPosition === null ? undefined : args.snapshotPosition + 1,
    responseMessages:
      responseMessages && responseMessages.length > 0
        ? responseMessages
        : undefined,
  });

  if (!message) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found');
  }

  emitResourceEvent({
    type: 'conversation_messages.generated',
    projectId: args.conversation.projectId,
    resourceType: 'conversation_message',
    resourceId: message.document_id,
    data: {
      ...message,
      conversation_id: args.conversation.publicId,
      generation_id: args.generationId,
      trace_id: args.traceId,
    },
  });

  return {
    status: 'completed',
    content,
    message,
    generationId: args.generationId,
    traceId: args.traceId,
    model: args.output?.model,
  };
};

/**
 * The snapshot a paused turn recorded in `conversation`, or `null` when the
 * generation recorded none there.
 */
export const pausedTurnSnapshotPosition = async (args: {
  generationId: string;
  conversation: InstanceType<(typeof db)['Conversation']>;
}): Promise<number | null> => {
  const generation = await db.Generation.findOne({
    where: {
      publicId: args.generationId,
      conversationId: args.conversation.id,
    },
    attributes: ['conversationSnapshotPosition'],
  });
  return generation?.conversationSnapshotPosition ?? null;
};

export const generateConversationMessage = async (args: {
  conversationId: string;
  agentId: string;
  model?: string;
  toolContext?: Record<string, string>;
  abortSignal?: AbortSignal;
  // End-user attribution supplied by the session layer, which is the only
  // caller that knows the session behind the turn (the actor is derived from
  // it). Plain conversation generations leave it unset.
  sessionId?: string;
  // The credential the turn's tools run with. Set only by request-less callers
  // that re-minted one for durable work (an approved tool call's
  // continuation); a request-driven turn leaves it unset.
  authHeader?: string;
  // The generation this turn continues, when a resumption drove it (an
  // approval's continuation). Declares the chain so it is bounded and linked;
  // a person's own message leaves it unset.
  initiatorGenerationId?: string | null;
  maxContextMessages?: number | null;
}): Promise<GenerateConversationMessageResult> => {
  const ctx = await loadGenerationContext({
    conversationId: args.conversationId,
    agentId: args.agentId,
    maxContextMessages: args.maxContextMessages,
  });

  const { conversation, generatingAgent, messages, snapshotPosition } = ctx;

  const history = await buildConversationHistory({ messages });
  const personaSystem = buildPersonaSystem(generatingAgent);
  const messagesForModel: Array<{ role: string; content: unknown }> = [
    { role: 'system', content: personaSystem },
    ...history,
  ];

  const genResult = await runGenerationForAgent({
    generatingAgent,
    conversationId: args.conversationId,
    snapshotPosition,
    runProjectId: conversation.projectId,
    messagesForModel,
    model: args.model,
    toolContext: args.toolContext,
    abortSignal: args.abortSignal,
    sessionId: args.sessionId,
    authHeader: args.authHeader,
    initiatorGenerationId: args.initiatorGenerationId,
  });

  if (genResult.status !== 'completed') {
    return genResult;
  }

  return storeGeneratedTurn({
    conversation,
    agentId: args.agentId,
    snapshotPosition,
    generationId: genResult.generationId,
    traceId: genResult.traceId,
    output: genResult.output,
  });
};
