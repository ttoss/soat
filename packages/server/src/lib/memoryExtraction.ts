import createDebug from 'debug';

import { db } from '../db';
import type { ExtractionConfig, KnowledgeConfig } from './agentKnowledge';
import { updateGenerationRecord } from './generations';
import { writeMemoryEntry } from './memoryEntries';
import * as extractionCompletion from './memoryExtractionCompletion';

const log = createDebug('soat:memory-extraction');

const MAX_EXTRACTION_CANDIDATES = 20;

/**
 * Normalizes the `extraction` knowledge-config field: `true` means "enabled
 * with defaults", the object form is enabled unless `enabled: false`.
 * Returns null when extraction is disabled or not configured.
 */
export const resolveExtractionConfig = (
  extraction: KnowledgeConfig['extraction']
): ExtractionConfig | null => {
  if (extraction === true) return {};
  if (
    extraction &&
    typeof extraction === 'object' &&
    extraction.enabled !== false
  ) {
    return extraction;
  }
  return null;
};

export type ExtractionSummary = {
  candidates: number;
  created: number;
  updated: number;
  skipped: number;
};

export type ExtractionMessage = { role: string; content: unknown };

const DEFAULT_EXTRACTION_INSTRUCTIONS = [
  'Extract discrete, atomic facts from this conversation that are worth remembering long-term.',
  'Skip transient information such as greetings, acknowledgments, and small talk.',
  'Each fact must be a single, self-contained sentence.',
].join('\n');

const buildExtractionPrompt = (args: {
  transcript: string;
  instructions?: string;
}): string => {
  // A custom prompt replaces only the task instructions. The response
  // contract and the transcript are always engine-owned: the parser accepts
  // nothing but a JSON array, so letting a prompt change the output format
  // would only break extraction silently.
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

const buildTranscript = (args: {
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

const recordExtractionSummary = async (args: {
  generationId: string;
  summary: ExtractionSummary;
}): Promise<void> => {
  // Generation records are created by the real generation pipeline; merge so
  // existing metadata (e.g. pendingState) is preserved. Missing records are
  // tolerated — extraction must never fail because observability is missing.
  const generation = await db.Generation.findOne({
    where: { publicId: args.generationId },
  });
  if (!generation) {
    log(
      'recordExtractionSummary: generation not found generationId=%s',
      args.generationId
    );
    return;
  }

  await updateGenerationRecord({
    publicId: args.generationId,
    metadata: {
      ...(generation.metadata ?? {}),
      extraction: args.summary,
    },
  });
};

type ExtractionTarget = {
  memory: InstanceType<(typeof db)['Memory']>;
  extraction: ExtractionConfig;
};

/**
 * Resolves the extraction target memory and normalized extraction config.
 * Returns null (with a log line) unless the agent exists, its knowledge
 * config has extraction enabled and a `write_memory_id`, and the target
 * memory exists.
 */
const resolveExtractionTarget = async (args: {
  agentId: string;
  projectIds?: number[];
}): Promise<ExtractionTarget | null> => {
  const where: Record<string, unknown> = { publicId: args.agentId };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const agent = await db.Agent.findOne({ where });
  if (!agent) {
    log('resolveExtractionTarget: agent not found agentId=%s', args.agentId);
    return null;
  }

  const config = agent.knowledgeConfig as KnowledgeConfig | null | undefined;
  const extraction = resolveExtractionConfig(config?.extraction);
  if (!extraction || !config?.writeMemoryId) {
    log(
      'resolveExtractionTarget: extraction not enabled agentId=%s extraction=%o writeMemoryId=%s',
      args.agentId,
      config?.extraction,
      config?.writeMemoryId
    );
    return null;
  }

  const memory = await db.Memory.findOne({
    where: { publicId: config.writeMemoryId },
  });
  if (!memory) {
    log(
      'resolveExtractionTarget: write memory not found agentId=%s writeMemoryId=%s',
      args.agentId,
      config.writeMemoryId
    );
    return null;
  }
  return { memory, extraction };
};

const writeCandidates = async (args: {
  agentId: string;
  projectIds?: number[];
  memoryId: number;
  candidates: string[];
  aiProviderId?: string;
  model?: string;
}): Promise<ExtractionSummary> => {
  const summary: ExtractionSummary = {
    candidates: args.candidates.length,
    created: 0,
    updated: 0,
    skipped: 0,
  };

  for (const content of args.candidates) {
    try {
      const result = await writeMemoryEntry({
        memoryId: args.memoryId,
        content,
        sourceType: 'extraction',
        // Extraction has an agent context, so merges consolidate via the LLM
        // (reusing any extraction provider/model override).
        consolidation: {
          agentId: args.agentId,
          projectIds: args.projectIds,
          aiProviderId: args.aiProviderId,
          model: args.model,
        },
      });
      summary[result.action] += 1;
    } catch (error) {
      log(
        'writeCandidates: write failed agentId=%s error=%s',
        args.agentId,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  return summary;
};

/**
 * Extracts atomic facts from a completed conversation turn and writes them to
 * the agent's `knowledge_config.write_memory_id` memory through the standard
 * dedup/merge/skip write algorithm.
 *
 * Runs only when the agent's knowledge config has `extraction: true` and a
 * `write_memory_id`. Returns the summary, or null when extraction did not run.
 */
export const runMemoryExtraction = async (args: {
  agentId: string;
  projectIds?: number[];
  generationId?: string;
  messages: ExtractionMessage[];
  assistantContent: string;
}): Promise<ExtractionSummary | null> => {
  const target = await resolveExtractionTarget({
    agentId: args.agentId,
    projectIds: args.projectIds,
  });
  if (!target) return null;
  const { memory, extraction } = target;

  const transcript = buildTranscript({
    messages: args.messages,
    assistantContent: args.assistantContent,
  });
  if (transcript.length === 0) {
    log('runMemoryExtraction: empty transcript agentId=%s', args.agentId);
    return null;
  }

  let completionText: string;
  try {
    completionText = await extractionCompletion.runExtractionCompletion({
      agentId: args.agentId,
      projectIds: args.projectIds,
      prompt: buildExtractionPrompt({
        transcript,
        instructions: extraction.prompt,
      }),
      aiProviderId: extraction.aiProviderId,
      model: extraction.model,
    });
  } catch (error) {
    log(
      'runMemoryExtraction: completion failed agentId=%s error=%s',
      args.agentId,
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }

  const summary = await writeCandidates({
    agentId: args.agentId,
    projectIds: args.projectIds,
    memoryId: memory.id as number,
    candidates: parseFactCandidates(completionText),
    aiProviderId: extraction.aiProviderId,
    model: extraction.model,
  });

  log(
    'runMemoryExtraction: done agentId=%s candidates=%d created=%d updated=%d skipped=%d',
    args.agentId,
    summary.candidates,
    summary.created,
    summary.updated,
    summary.skipped
  );

  if (args.generationId) {
    await recordExtractionSummary({
      generationId: args.generationId,
      summary,
    });
  }

  return summary;
};

/**
 * Fire-and-forget wrapper for post-generation call sites. Never throws and
 * never blocks the response.
 */
export const fireMemoryExtraction = (args: {
  agentId: string;
  projectIds?: number[];
  generationId?: string;
  messages: ExtractionMessage[];
  assistantContent: string;
}): void => {
  void runMemoryExtraction(args).catch((error) => {
    log(
      'fireMemoryExtraction: failed agentId=%s error=%s',
      args.agentId,
      error instanceof Error ? error.message : String(error)
    );
  });
};
