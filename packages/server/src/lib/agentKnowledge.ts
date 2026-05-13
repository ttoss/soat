import { searchKnowledge } from './knowledge';

type KnowledgeConfig = {
  memoryIds?: string[];
  memoryTags?: string[];
  documentIds?: string[];
  documentPaths?: string[];
  minScore?: number;
  limit?: number;
  query?: string;
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

  if (results.length === 0) return [];

  const knowledgeText = results.map(formatResult).join('\n\n');

  return [{ role: 'system', content: `Knowledge context:\n${knowledgeText}` }];
};
