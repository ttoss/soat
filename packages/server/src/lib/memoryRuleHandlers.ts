import createDebug from 'debug';

import { createGeneration } from './agentGeneration';
import { runBuiltInExtractor } from './memoryExtraction';
import { isPlainObject } from './plainObject';
import { callTool } from './tools';

const log = createDebug('soat:memoryRules');

/**
 * The `source` a handler agent's own generation is stamped with, and the first
 * half of the loop guard: without it a handler agent's turn emits
 * `agents.generation.completed`, matches the rule that invoked it, and the mill
 * never stops.
 */
export const MEMORY_RULE_GENERATION_SOURCE = 'memory_rule';

/** What a handler proposes. It never writes; the server does. */
export type MemoryFact = {
  content: string;
  tags?: Record<string, string> | null;
};

const MAX_HANDLER_FACTS = 20;

const HANDLER_INSTRUCTIONS = [
  'Extract the facts from this conversation that are worth remembering long-term.',
  'Respond with JSON of the shape {"facts":[{"content":"…","tags":{"key":"value"}}]} and nothing else.',
  'Respond with {"facts":[]} when there is nothing worth remembering.',
].join('\n');

const readTags = (value: unknown): Record<string, string> | null => {
  if (!isPlainObject(value)) return null;
  const tags: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') tags[key] = item;
  }
  return Object.keys(tags).length > 0 ? tags : null;
};

/** The first `{…}` or `[…]` span in a reply, parsed, or `null`. */
const parseEmbeddedJson = (text: string): unknown => {
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
  }
  return null;
};

/**
 * Reads a handler's reply into candidates, leniently and without ever throwing:
 * a handler that answers with garbage contributes nothing, which is the same
 * outcome as answering with no facts. Accepts the documented
 * `{ "facts": [{ content, tags }] }` and, because a model reaches for it, a
 * bare array of the same items.
 *
 * A string reply is scanned for the first JSON value in it, so a handler that
 * wraps its answer in prose or a fenced block is still read.
 */
export const parseHandlerFacts = (raw: unknown): MemoryFact[] => {
  const value = typeof raw === 'string' ? parseEmbeddedJson(raw) : raw;
  const items = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.facts)
      ? value.facts
      : [];

  return items
    .map((item) => {
      if (typeof item === 'string') {
        return { content: item.trim(), tags: null };
      }
      if (isPlainObject(item) && typeof item.content === 'string') {
        return { content: item.content.trim(), tags: readTags(item.tags) };
      }
      return { content: '', tags: null };
    })
    .filter((fact) => {
      return fact.content.length > 0;
    })
    .slice(0, MAX_HANDLER_FACTS);
};

/**
 * What a handler is told about the turn. Snake_case because it crosses the wire
 * to a tool, and named rather than spread so a handler cannot be handed a field
 * the rule did not mean to give it.
 */
export type HandlerTurn = {
  event: string;
  ruleId: string;
  agentPublicId: string;
  generationPublicId: string;
  conversationPublicId?: string;
  transcript: string;
  projectId: number;
};

const runAgentHandler = async (args: {
  handlerAgentId: string;
  turn: HandlerTurn;
}): Promise<MemoryFact[]> => {
  const result = await createGeneration({
    projectIds: [args.turn.projectId],
    agentId: args.handlerAgentId,
    messages: [
      {
        role: 'user',
        content: `${HANDLER_INSTRUCTIONS}\n\nConversation:\n${args.turn.transcript}`,
      },
    ],
    // The turn this firing read. It is a continuation, not a root: declaring it
    // gives the handler's own turn the source turn's trace lineage, and puts it
    // under the same chain budget — a second, generic bound beneath the loop
    // guard rather than a replacement for it.
    initiatorGenerationId: args.turn.generationPublicId,
    // The loop guard's marker. A handler agent's own turn completes and emits
    // like any other; this is what keeps the rule that invoked it from reading
    // its own output back.
    source: MEMORY_RULE_GENERATION_SOURCE,
  });

  if (!('output' in result) || typeof result.output?.content !== 'string') {
    log('runAgentHandler: agent %s returned no text', args.handlerAgentId);
    return [];
  }
  return parseHandlerFacts(result.output.content);
};

const runToolHandler = async (args: {
  toolId: string;
  action: string | null;
  presetParameters: Record<string, unknown> | null;
  turn: HandlerTurn;
}): Promise<MemoryFact[]> => {
  const raw = await callTool({
    guardrails: 'apply',
    projectIds: [args.turn.projectId],
    id: args.toolId,
    action: args.action ?? undefined,
    input: {
      // `preset_parameters` merge at the top level; the turn's own fields are
      // reserved and win, so a preset cannot rewrite what the handler is told
      // it is reading.
      ...(args.presetParameters ?? {}),
      event: args.turn.event,
      rule_id: args.turn.ruleId,
      agent_id: args.turn.agentPublicId,
      generation_id: args.turn.generationPublicId,
      conversation_id: args.turn.conversationPublicId ?? null,
      transcript: args.turn.transcript,
    },
    attribution: {
      generationId: args.turn.generationPublicId,
      agentId: args.turn.agentPublicId,
    },
  });

  return parseHandlerFacts(raw);
};

/**
 * Runs a rule's handler and returns the facts it proposes.
 *
 * Total by construction: a handler that throws, times out, or answers with
 * nonsense yields no candidates. A rule reads a turn that has already
 * completed, so there is no request left to fail — and a store's ingestion
 * policy must never be able to break the agent it reads.
 *
 * With no LLM merge, an agent handler and a tool handler are identical once
 * they return: there is no consolidation step needing an agent context, so a
 * tool handler is not a degraded path.
 */
export const runRuleHandler = async (args: {
  handler:
    | {
        kind: 'extractor';
        prompt: string | null;
        aiProviderId?: string;
        model?: string;
      }
    | { kind: 'agent'; agentId: string }
    | {
        kind: 'tool';
        toolId: string;
        action: string | null;
        presetParameters: Record<string, unknown> | null;
      };
  turn: HandlerTurn;
}): Promise<MemoryFact[]> => {
  try {
    if (args.handler.kind === 'agent') {
      return await runAgentHandler({
        handlerAgentId: args.handler.agentId,
        turn: args.turn,
      });
    }
    if (args.handler.kind === 'tool') {
      return await runToolHandler({ ...args.handler, turn: args.turn });
    }
    const candidates = await runBuiltInExtractor({
      agentId: args.turn.agentPublicId,
      projectIds: [args.turn.projectId],
      transcript: args.turn.transcript,
      prompt: args.handler.prompt,
      aiProviderId: args.handler.aiProviderId,
      model: args.handler.model,
    });
    return candidates.map((content) => {
      return { content, tags: null };
    });
  } catch (error) {
    log(
      'runRuleHandler: rule=%s handler failed error=%s',
      args.turn.ruleId,
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
};
