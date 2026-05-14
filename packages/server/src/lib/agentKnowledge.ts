import type { Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { searchKnowledge } from './knowledge';
import { writeMemoryEntry } from './memoryEntries';

const log = createDebug('soat:knowledge');

export type KnowledgeConfig = {
  memoryIds?: string[];
  memoryTags?: string[];
  documentIds?: string[];
  documentPaths?: string[];
  minScore?: number;
  limit?: number;
  query?: string;
  writeMemoryId?: string;
};

const anyLength = (arr: unknown[] | undefined): boolean => {
  return (arr?.length ?? 0) > 0;
};

const hasKnowledgeFilters = (config: KnowledgeConfig): boolean => {
  return (
    anyLength(config.memoryIds) ||
    anyLength(config.memoryTags) ||
    anyLength(config.documentPaths) ||
    anyLength(config.documentIds)
  );
};

const formatResult = (
  r: Awaited<ReturnType<typeof searchKnowledge>>[0]
): string => {
  if (r.sourceType === 'document') {
    return `[Document: ${r.path ?? r.filename}]\n${r.content}`;
  }
  return `[Memory: ${r.memoryId}]\n${r.content}`;
};

export const buildKnowledgeMessages = async (args: {
  knowledgeConfig: unknown;
  projectIds?: number[];
  messages: Array<{ role: string; content: string }>;
}): Promise<Array<{ role: string; content: string }>> => {
  const config = args.knowledgeConfig as KnowledgeConfig | null | undefined;
  if (!config) return [];

  const lastUserMessage = [...args.messages].reverse().find((m) => {
    return m.role === 'user';
  });
  const query = lastUserMessage?.content ?? config.query;

  log(
    'buildKnowledgeMessages: query=%s memoryIds=%o documentPaths=%o',
    query,
    config.memoryIds,
    config.documentPaths
  );

  if (!query && !hasKnowledgeFilters(config)) return [];

  const results = await searchKnowledge({
    projectIds: args.projectIds,
    query,
    memoryIds: config.memoryIds,
    memoryTags: config.memoryTags,
    paths: config.documentPaths,
    documentIds: config.documentIds,
    minScore: config.minScore,
    limit: config.limit,
  });

  log('buildKnowledgeMessages: results count=%d', results.length);

  if (results.length === 0) return [];

  const knowledgeText = results.map(formatResult).join('\n\n');

  log('buildKnowledgeMessages: knowledge text=%s', knowledgeText);

  return [{ role: 'system', content: `Knowledge context:\n${knowledgeText}` }];
};

export const buildWriteMemoryTool = (args: { writeMemoryId: string }): Tool => {
  return tool({
    description:
      'Write a fact to memory. The system automatically deduplicates: creates new entries, merges with similar existing ones, or skips duplicates.',
    inputSchema: jsonSchema<{ content: string }>({
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The atomic fact to remember',
        },
      },
      required: ['content'],
    }),
    execute: async ({ content }: { content: string }) => {
      const memory = await db.Memory.findOne({
        where: { publicId: args.writeMemoryId },
      });
      if (!memory) {
        return { error: `Memory ${args.writeMemoryId} not found` };
      }
      const result = await writeMemoryEntry({
        memoryId: memory.id as number,
        content,
        source: 'agent',
      });
      return { action: result.action, entryId: result.entry.id };
    },
  });
};
