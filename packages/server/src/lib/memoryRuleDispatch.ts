import type { MemoryRuleEvent } from '@soat/postgresdb';
import { MEMORY_RULE_EVENTS } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { readGeneratedMessageContent } from './conversationMessages';
import { conversationProvenanceTags } from './conversationSystemTags';
import type { SoatEvent } from './eventBus';
import { onEvent, recordDroppedEvent } from './eventBus';
import { updateGenerationRecord } from './generations';
import { assertMemoryStorageQuota, writeMemory } from './memories';
import { buildTranscript, type ExtractionMessage } from './memoryExtraction';
import type { HandlerTurn, MemoryFact } from './memoryRuleHandlers';
import {
  MEMORY_RULE_GENERATION_SOURCE,
  runRuleHandler,
} from './memoryRuleHandlers';
import { findHandlerAgentIds, findMemoryRulesForEvent } from './memoryRules';
import { isPlainObject } from './plainObject';
import { stripSystemTagKeys } from './tags';

const log = createDebug('soat:memoryRules');

type MemoryRuleRow = InstanceType<typeof db.MemoryRule> & {
  memoryStore?: InstanceType<typeof db.MemoryStore>;
  agent?: InstanceType<typeof db.Agent> | null;
  tool?: InstanceType<typeof db.Tool> | null;
  aiProvider?: InstanceType<typeof db.AiProvider> | null;
};

type GenerationRow = InstanceType<typeof db.Generation> & {
  agent?: InstanceType<typeof db.Agent>;
  conversation?: InstanceType<typeof db.Conversation> | null;
};

export type RuleFiringSummary = {
  candidates: number;
  created: number;
  superseded: number;
  skipped: number;
};

const emptySummary = (candidates: number): RuleFiringSummary => {
  return { candidates, created: 0, superseded: 0, skipped: 0 };
};

/**
 * The generation a firing reads. `agents.generation.completed` names it
 * directly; `conversations.message.generated` names the message and carries the
 * generation's id in its payload.
 */
const resolveGenerationPublicId = (event: SoatEvent): string | undefined => {
  if (event.type === 'agents.generation.completed') return event.resourceId;
  // `data` is the envelope's own `Record<string, unknown>`, so only the value
  // needs narrowing, not the bag.
  const { generationId } = event.data;
  return typeof generationId === 'string' ? generationId : undefined;
};

/**
 * The turn's assistant reply. It is not a column on the generation — the text
 * lives in the trace for a bare turn and in the message document for a
 * conversation one — so each event supplies it from what it already has.
 */
const resolveAssistantContent = async (event: SoatEvent): Promise<string> => {
  if (event.type === 'agents.generation.completed') {
    const output = event.data.output;
    const content = isPlainObject(output) ? output.content : undefined;
    return typeof content === 'string' ? content : '';
  }
  const content = await readGeneratedMessageContent({
    documentPublicId: event.resourceId,
  });
  return content ?? '';
};

const readInputMessages = (generation: GenerationRow): ExtractionMessage[] => {
  const messages = generation.inputMessages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(isPlainObject) as ExtractionMessage[];
};

/**
 * Whether this generation may feed a rule at all.
 *
 * Two independent guards, because a handler agent can reach the bus two ways:
 * the generation this module started carries the marker `source`, and a
 * generation started by any other path — a direct API call to the same agent,
 * an orchestration node — is caught by the agent itself being a handler
 * somewhere in the project. Without the second, "test the handler by hand" is
 * an infinite mill.
 */
const isRuleDriven = async (generation: GenerationRow): Promise<boolean> => {
  if (generation.source === MEMORY_RULE_GENERATION_SOURCE) return true;
  const handlerAgentIds = await findHandlerAgentIds({
    projectId: generation.projectId,
  });
  return handlerAgentIds.includes(generation.agentId);
};

const handlerFor = (
  rule: MemoryRuleRow
): Parameters<typeof runRuleHandler>[0]['handler'] => {
  if (rule.agent) {
    return { kind: 'agent', agentId: rule.agent.publicId };
  }
  if (rule.tool) {
    return {
      kind: 'tool',
      toolId: rule.tool.publicId,
      action: rule.action,
      presetParameters: rule.presetParameters,
    };
  }
  return {
    kind: 'extractor',
    prompt: rule.prompt,
    aiProviderId: rule.aiProvider?.publicId,
    model: rule.model ?? undefined,
  };
};

/**
 * Puts each proposed fact through the one write funnel. A handler can propose
 * garbage and cannot corrupt the store: the thresholds, the storage quota and
 * the assertion row are the server's, not the handler's.
 *
 * The quota is checked per candidate and ends the firing when it is spent —
 * unlike the in-turn `write_memory` door, a rule runs after the turn, so a
 * refusal here fails nothing that is still in flight.
 */
const writeCandidates = async (args: {
  rule: MemoryRuleRow;
  facts: MemoryFact[];
  turn: HandlerTurn;
}): Promise<RuleFiringSummary> => {
  const summary = emptySummary(args.facts.length);
  const memoryStoreId = args.rule.memoryStoreId;
  // Stamped once for the firing, not per fact: a fact learned in an actor's
  // conversation answers to the same `system.actor` filter its raw turns do,
  // so one request returns both.
  const provenance = await conversationProvenanceTags({
    conversationPublicId: args.turn.conversationPublicId,
  });

  for (const fact of args.facts) {
    try {
      await assertMemoryStorageQuota({ memoryStoreId, content: fact.content });
      const result = await writeMemory({
        memoryStoreId,
        content: fact.content,
        // A handler is model-authored, so a `system.*` key it proposed is
        // dropped rather than trusted; the runtime's own stamp wins.
        tags: { ...stripSystemTagKeys(fact.tags ?? {}), ...provenance },
        sourceConversationPublicId: args.turn.conversationPublicId,
        // No thresholds: the rule door always uses the store's effective pair.
        assertion: {
          mechanism: 'rule',
          ruleId: args.rule.id as number,
          generationId: args.turn.generationPublicId,
          // The source agent is the asserter, as on the tool door: the rule
          // decides what the corpus accepts, the agent is whose turn said it.
          principalType: 'agent',
          principalId: args.turn.agentPublicId,
        },
      });
      summary[result.action] += 1;
    } catch (error) {
      log(
        'writeCandidates: rule=%s write failed error=%s',
        args.rule.publicId,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  return summary;
};

/**
 * The per-rule counts for one turn, recorded on the generation.
 *
 * Keyed by rule, because a store can have several and a flat pair of counts
 * cannot say which one produced them. Written once, after every rule for this
 * event has run, so there is no read-modify-write to race. Only the turn-level
 * event records it; a `conversations.message.generated` firing is visible in
 * the assertion ledger, which is where every firing lands either way.
 *
 * Only ever called with at least one rule's counts: the dispatcher returns
 * before the loop when nothing matched.
 */
const recordFiringSummary = async (args: {
  generationPublicId: string;
  summaries: Record<string, RuleFiringSummary>;
}): Promise<void> => {
  const updated = await updateGenerationRecord({
    publicId: args.generationPublicId,
    extraction: args.summaries,
  });
  if (!updated) {
    log(
      'recordFiringSummary: generation not found generationId=%s',
      args.generationPublicId
    );
  }
};

const loadGeneration = async (
  publicId: string
): Promise<GenerationRow | null> => {
  return (await db.Generation.findOne({
    where: { publicId },
    include: [
      { model: db.Agent, as: 'agent' },
      { model: db.Conversation, as: 'conversation' },
    ],
  })) as GenerationRow | null;
};

/**
 * Runs every memory rule a completed turn matches.
 *
 * Exported separately from the subscription so a caller can drive one event
 * through the whole path with no live bus listener, and so a test can await the
 * firing rather than poll for it.
 */
export const dispatchMemoryRules = async (event: SoatEvent): Promise<void> => {
  if (!MEMORY_RULE_EVENTS.includes(event.type as MemoryRuleEvent)) return;

  const generationPublicId = resolveGenerationPublicId(event);
  if (!generationPublicId) return;

  const generation = await loadGeneration(generationPublicId);
  if (!generation?.agent) {
    log('dispatchMemoryRules: generation not found id=%s', generationPublicId);
    return;
  }

  const agentPublicId = generation.agent.publicId;
  const rules = await findMemoryRulesForEvent({
    on: event.type as MemoryRuleEvent,
    projectId: generation.projectId,
    agentPublicId,
  });
  // Before the guard, so a project with no rules — every project, until one is
  // written — pays one query for this event rather than two.
  if (rules.length === 0) return;

  if (await isRuleDriven(generation)) {
    log(
      'dispatchMemoryRules: skipping rule-driven generation id=%s',
      generationPublicId
    );
    return;
  }

  const transcript = buildTranscript({
    messages: readInputMessages(generation),
    assistantContent: await resolveAssistantContent(event),
  });

  const summaries: Record<string, RuleFiringSummary> = {};

  for (const rule of rules) {
    const turn: HandlerTurn = {
      event: event.type,
      ruleId: rule.publicId,
      agentPublicId,
      generationPublicId,
      conversationPublicId: generation.conversation?.publicId,
      transcript,
      projectId: generation.projectId,
    };

    const facts = await runRuleHandler({ handler: handlerFor(rule), turn });
    summaries[rule.publicId] = await writeCandidates({ rule, facts, turn });

    log(
      'dispatchMemoryRules: rule=%s candidates=%d created=%d superseded=%d skipped=%d',
      rule.publicId,
      summaries[rule.publicId].candidates,
      summaries[rule.publicId].created,
      summaries[rule.publicId].superseded,
      summaries[rule.publicId].skipped
    );
  }

  if (event.type === 'agents.generation.completed') {
    await recordFiringSummary({ generationPublicId, summaries });
  }
};

/**
 * Subscribes the memory module to the platform event bus, the way the ingestion
 * pipeline dispatches an `IngestionRule`.
 *
 * Not through `Trigger`: `Trigger.type` is `schedule | webhook`, and adding an
 * internal `event` type is a general feature that should not be built to ship
 * this one.
 *
 * Deliberately **not** `retryOrRecordDrop`, which every other subscriber uses:
 * that retries its whole operation, and this one contains a provider call. A
 * replay would re-bill the handler and re-propose what it already wrote. A
 * handler failure is swallowed by `runRuleHandler` already, so what reaches
 * here is a database or storage failure — recorded and printed, like any other
 * event the pipeline could not recover.
 */
export const initializeMemoryRuleListener = (): void => {
  onEvent({
    types: [...MEMORY_RULE_EVENTS],
    handler: (event) => {
      void dispatchMemoryRules(event).catch((error: unknown) => {
        recordDroppedEvent({
          stage: 'memory_rule_dispatch',
          type: event.type,
          resourceId: event.resourceId,
          error,
        });
      });
    },
  });
};
