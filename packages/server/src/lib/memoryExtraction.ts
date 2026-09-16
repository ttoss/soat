import createDebug from 'debug';

import * as extractionCompletion from './memoryExtractionCompletion';

const log = createDebug('soat:memory-extraction');

const MAX_EXTRACTION_CANDIDATES = 20;

export type ExtractionMessage = { role: string; content: unknown };

const DEFAULT_EXTRACTION_INSTRUCTIONS = [
  'Extract discrete, atomic facts from this conversation that are worth remembering long-term.',
  'Skip transient information such as greetings, acknowledgments, and small talk.',
  'Each fact must be a single, self-contained sentence.',
].join('\n');

const buildExtractionPrompt = (args: {
  transcript: string;
  instructions?: string | null;
}): string => {
  // A custom prompt replaces only the task instructions: the parser accepts
  // nothing but a JSON array, so letting a prompt change the output format
  // would break extraction silently.
  return [
    args.instructions ?? DEFAULT_EXTRACTION_INSTRUCTIONS,
    'Respond with a JSON array of strings and nothing else. Respond with [] when there is nothing worth remembering.',
    '',
    'Conversation:',
    args.transcript,
  ].join('\n');
};

/**
 * Leniently parses fact candidates from an LLM reply: takes the first JSON
 * array found in the text, accepts plain strings or `{ content }` objects,
 * and drops everything else. Returns at most MAX_EXTRACTION_CANDIDATES facts.
 */
export const parseFactCandidates = (text: string): string[] => {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as { content?: unknown }).content === 'string'
      ) {
        return ((item as { content: string }).content as string).trim();
      }
      return '';
    })
    .filter((content) => {
      return content.length > 0;
    })
    .slice(0, MAX_EXTRACTION_CANDIDATES);
};

export const buildTranscript = (args: {
  messages: ExtractionMessage[];
  assistantContent: string;
}): string => {
  const lines = args.messages
    .filter((message) => {
      return (
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        (message.content as string).trim().length > 0
      );
    })
    .map((message) => {
      return `${message.role}: ${message.content as string}`;
    });

  if (args.assistantContent.trim().length > 0) {
    lines.push(`assistant: ${args.assistantContent}`);
  }

  return lines.join('\n');
};

/**
 * The handler a `memory_rules` row with neither an `agent_id` nor a `tool_id`
 * runs: a tool-less completion over one turn's transcript that proposes atomic
 * facts. The rule's `prompt` / `ai_provider_id` / `model` are its only knobs.
 *
 * It proposes and never writes, exactly like a custom handler — the dispatcher
 * puts every candidate through `writeMemory`. A failed completion yields no
 * candidates rather than throwing: a rule must never be able to fail the turn
 * it read.
 */
export const runBuiltInExtractor = async (args: {
  /** The *source* agent, whose provider and model the completion resolves from. */
  agentId: string;
  projectIds?: number[];
  transcript: string;
  prompt?: string | null;
  aiProviderId?: string;
  model?: string;
}): Promise<string[]> => {
  if (args.transcript.trim().length === 0) {
    log('runBuiltInExtractor: empty transcript agentId=%s', args.agentId);
    return [];
  }

  try {
    const text = await extractionCompletion.runExtractionCompletion({
      agentId: args.agentId,
      projectIds: args.projectIds,
      prompt: buildExtractionPrompt({
        transcript: args.transcript,
        instructions: args.prompt,
      }),
      aiProviderId: args.aiProviderId,
      model: args.model,
    });
    return parseFactCandidates(text);
  } catch (error) {
    log(
      'runBuiltInExtractor: completion failed agentId=%s error=%s',
      args.agentId,
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
};
