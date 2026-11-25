import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';
import { createGeneration, type CreateGenerationArgs } from './agentGeneration';
import type { GenerationResult } from './agentGenerationTypes';
import { addConversationMessage } from './conversationMessages';
import { emitResourceEvent } from './eventBus';
import { readFileBuffer } from './fileStorage';
import {
  readGenerationProvenance,
  storedProvenance,
  sumProvenance,
} from './generationProvenance';
import { agentReferences } from './resourceReferences';
import { readVendorOptions, replayStoredTurn } from './vendorOptions';
import type { WorkAuthority } from './workAuthority';

const log = createDebug('soat:generation');

type GenerationRecorded = CreateGenerationArgs['onRecorded'];

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
}): Promise<{ role: string; content: unknown }> => {
  const content = await readMessageContent(args.msg);
  if (args.msg.role === 'assistant') {
    return { role: 'assistant', content };
  }
  // The speaker's name is the only thing prefixed onto a turn. A message's
  // `metadata` is a caller-owned bag the platform stores and does not read, so
  // it does not reach the model: a caller who wants the model to see a field
  // writes it into the message.
  const speakerName = args.msg.actor?.name ?? 'participant';
  const text = `[${speakerName}]: ${content}`;
  const fileIds = args.msg.fileIds ?? [];
  if (fileIds.length === 0) return { role: 'user', content: text };
  // Each file goes to the model natively; the generation resolves and gates
  // the parts as it does a caller's own (`generationInputMessages.ts`).
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...fileIds.map((fileId) => {
        return { type: 'file', file_id: fileId };
      }),
    ],
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
        return replayStoredTurn({
          messages: responseMessages,
          vendorOptions: readVendorOptions(msg.vendorOptions),
        }) as Array<{ role: string; content: unknown }>;
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
  // The messages the turn is sent, whose stamped counts it starts from.
  replayed: Array<ConversationMessage>;
  // The conversation's project, where the turn runs and is recorded.
  runProjectId: number;
  messagesForModel: Array<{ role: string; content: unknown }>;
  toolContext?: Record<string, string>;
  abortSignal?: AbortSignal;
  sessionId?: string;
  authority: WorkAuthority | null;
  authUser: AuthUser | undefined;
  initiatorGenerationId?: string | null;
  onRecorded?: GenerationRecorded;
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
      firstPosition: args.replayed[0]?.position ?? args.snapshotPosition,
      snapshotPosition: args.snapshotPosition,
      replayed: sumProvenance(...args.replayed.map(storedProvenance)),
    },
    authority: args.authority,
    authUser: args.authUser,
    initiatorGenerationId: args.initiatorGenerationId,
    onRecorded: args.onRecorded,
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

// The agent's own instructions are the system prompt every generation builds
// (`agentGenerationContext.ts`); this adds only the participant framing.
// Other turns arrive labelled `[<speaker>]: …` (`buildMessageEntry`), and a
// model left alone answers in the same shape.
const buildPersonaSystem = (agent: { name?: string | null }) => {
  return `You are ${
    agent.name ?? 'Assistant'
  }. Reply as this participant only — do not speak for any other actor. Do not prefix your reply with a \`[name]:\` speaker label.`;
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

/** What a completed turn's output stores on its reply beside the text. */
const replyContent = (output: GenerationResult['output']) => {
  const responseMessages = output?.responseMessages;
  return {
    responseMessages:
      responseMessages && responseMessages.length > 0
        ? responseMessages
        : undefined,
    vendorOptions: output?.vendorOptions,
    citations: output?.citations?.citations,
  };
};

/**
 * Stores a completed turn and announces it as
 * `conversation_messages.generated`. Every route that completes a conversation
 * turn — generate, and either tool-outputs route after a client-tool pause —
 * stores it here, so a turn lands and is announced the same way whichever
 * route finished it.
 *
 * The reply goes right after the last message the turn read, so a message that
 * arrived while it ran stays after the reply it did not see. Extraction is a
 * `memory_rules` subscriber on the event, so a conversation turn feeds a store
 * through the store's policy, not this agent's.
 */
const storeGeneratedTurn = async (args: {
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
  const message = await addConversationMessage({
    conversationId: args.conversation.publicId,
    message: content,
    role: 'assistant',
    agentId: args.agentId,
    position:
      args.snapshotPosition === null ? undefined : args.snapshotPosition + 1,
    ...replyContent(args.output),
    provenance: await readGenerationProvenance({
      generationId: args.generationId,
      withoutReplayed: true,
    }),
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
 * Refuses a generation that did not run in `conversation`, so a conversation's
 * own route never resumes, or stores the reply of, a turn that answers another
 * conversation or none.
 */
export const assertGenerationAnswersConversation = async (args: {
  generationId: string;
  conversationId: number;
}): Promise<void> => {
  log(
    'assertGenerationAnswersConversation: generationId=%s conversationId=%d',
    args.generationId,
    args.conversationId
  );
  const generation = await db.Generation.findOne({
    where: {
      publicId: args.generationId,
      conversationId: args.conversationId,
    },
    attributes: ['id'],
  });
  if (generation) return;
  throw new DomainError(
    'GENERATION_NOT_FOUND',
    `Generation '${args.generationId}' not found in this conversation.`
  );
};

/**
 * The turn a tool-outputs submission resumed, with a completed one stored in
 * the conversation its generation answers, after the snapshot it recorded.
 * `null` when the generation answers no conversation: nothing is stored.
 */
export const storeResumedConversationTurn = async (args: {
  result: GenerationResult;
  agentId: string;
}): Promise<GenerateConversationMessageResult | null> => {
  const { result } = args;
  log(
    'storeResumedConversationTurn: generationId=%s status=%s',
    result.id,
    result.status
  );
  if (result.status === 'requires_action') {
    return {
      status: 'requires_action',
      generationId: result.id,
      traceId: result.traceId,
      requiredAction: result.requiredAction!,
    };
  }
  const generation = await db.Generation.findOne({
    where: { publicId: result.id },
    attributes: ['conversationSnapshotPosition'],
    include: [{ model: db.Conversation, as: 'conversation' }],
  });
  if (!generation?.conversation) return null;

  return storeGeneratedTurn({
    conversation: generation.conversation,
    agentId: args.agentId,
    snapshotPosition: generation.conversationSnapshotPosition,
    generationId: result.id,
    traceId: result.traceId,
    output: result.output,
  });
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
  // The authority the turn's calls run under: the driving request's, or the
  // one a request-less continuation stores.
  authority: WorkAuthority | null;
  // The caller recorded as the generation's `acted_as`; required so every
  // entry point states it (`undefined` when no request drove the turn).
  authUser: AuthUser | undefined;
  // The generation this turn continues, when a resumption drove it (an
  // approval's continuation). Declares the chain so it is bounded and linked;
  // a person's own message leaves it unset.
  initiatorGenerationId?: string | null;
  maxContextMessages?: number | null;
  // Called once the turn's generation record exists, before the provider is.
  onRecorded?: GenerationRecorded;
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

  const genResult = await runAgentGeneration({
    agent: generatingAgent,
    conversationId: args.conversationId,
    snapshotPosition,
    replayed: messages,
    runProjectId: conversation.projectId,
    messagesForModel,
    toolContext: args.toolContext,
    abortSignal: args.abortSignal,
    sessionId: args.sessionId,
    authority: args.authority,
    authUser: args.authUser,
    initiatorGenerationId: args.initiatorGenerationId,
    onRecorded: args.onRecorded,
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
