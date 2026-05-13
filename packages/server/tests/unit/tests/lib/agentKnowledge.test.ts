import * as knowledgeModule from 'src/lib/knowledge';
import { buildKnowledgeMessages } from 'src/lib/agentKnowledge';

const mockSearchKnowledge = jest.spyOn(knowledgeModule, 'searchKnowledge');

afterEach(() => {
  jest.clearAllMocks();
});

describe('buildKnowledgeMessages', () => {
  test('returns [] when config is null', async () => {
    const result = await buildKnowledgeMessages({
      knowledgeConfig: null,
      messages: [],
    });
    expect(result).toEqual([]);
    expect(mockSearchKnowledge).not.toHaveBeenCalled();
  });

  test('returns [] when config is undefined', async () => {
    const result = await buildKnowledgeMessages({
      knowledgeConfig: undefined,
      messages: [],
    });
    expect(result).toEqual([]);
    expect(mockSearchKnowledge).not.toHaveBeenCalled();
  });

  test('returns [] when no query and no knowledge filters', async () => {
    const result = await buildKnowledgeMessages({
      knowledgeConfig: {},
      messages: [],
    });
    expect(result).toEqual([]);
    expect(mockSearchKnowledge).not.toHaveBeenCalled();
  });

  test('returns [] when searchKnowledge returns empty results', async () => {
    mockSearchKnowledge.mockResolvedValueOnce([]);
    const result = await buildKnowledgeMessages({
      knowledgeConfig: { query: 'hello' },
      messages: [],
    });
    expect(result).toEqual([]);
    expect(mockSearchKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'hello' })
    );
  });

  test('uses last user message content as query', async () => {
    mockSearchKnowledge.mockResolvedValueOnce([]);
    const messages = [
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'latest question' },
    ];
    await buildKnowledgeMessages({
      knowledgeConfig: {},
      messages,
    });
    expect(mockSearchKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'latest question' })
    );
  });

  test('falls back to config.query when no user message exists', async () => {
    mockSearchKnowledge.mockResolvedValueOnce([]);
    await buildKnowledgeMessages({
      knowledgeConfig: { query: 'config query' },
      messages: [{ role: 'assistant', content: 'hi' }],
    });
    expect(mockSearchKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'config query' })
    );
  });

  test('returns system message with document result formatted correctly', async () => {
    mockSearchKnowledge.mockResolvedValueOnce([
      {
        sourceType: 'document',
        documentId: 'doc_1',
        fileId: 'fil_1',
        projectId: 'prj_1',
        path: 'docs/guide.md',
        filename: 'guide.md',
        size: 100,
        title: 'Guide',
        content: 'Document content here',
        score: 0.9,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as Awaited<ReturnType<typeof knowledgeModule.searchKnowledge>>);

    const result = await buildKnowledgeMessages({
      knowledgeConfig: { query: 'guide' },
      messages: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('system');
    expect(result[0].content).toContain('[Document: docs/guide.md]');
    expect(result[0].content).toContain('Document content here');
  });

  test('formats document result using filename when path is null', async () => {
    mockSearchKnowledge.mockResolvedValueOnce([
      {
        sourceType: 'document',
        documentId: 'doc_1',
        fileId: 'fil_1',
        projectId: 'prj_1',
        path: undefined,
        filename: 'guide.md',
        size: 100,
        title: 'Guide',
        content: 'Document content here',
        score: 0.9,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as Awaited<ReturnType<typeof knowledgeModule.searchKnowledge>>);

    const result = await buildKnowledgeMessages({
      knowledgeConfig: { query: 'guide' },
      messages: [],
    });

    expect(result[0].content).toContain('[Document: guide.md]');
  });

  test('returns system message with memory result formatted correctly', async () => {
    mockSearchKnowledge.mockResolvedValueOnce([
      {
        sourceType: 'memory',
        entryId: 'mne_001',
        memoryId: 'mem_001',
        content: 'Memory content here',
        score: 0.8,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as Awaited<ReturnType<typeof knowledgeModule.searchKnowledge>>);

    const result = await buildKnowledgeMessages({
      knowledgeConfig: { query: 'remember' },
      messages: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('system');
    expect(result[0].content).toContain('[Memory: mem_001]');
    expect(result[0].content).toContain('Memory content here');
  });

  test('calls searchKnowledge when knowledge filters are set even without query', async () => {
    mockSearchKnowledge.mockResolvedValueOnce([]);
    await buildKnowledgeMessages({
      knowledgeConfig: { memoryIds: ['mem_1'] },
      messages: [],
    });
    expect(mockSearchKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ memoryIds: ['mem_1'] })
    );
  });

  test('passes projectIds and config options to searchKnowledge', async () => {
    mockSearchKnowledge.mockResolvedValueOnce([]);
    await buildKnowledgeMessages({
      knowledgeConfig: {
        query: 'test',
        memoryTags: ['tag1'],
        documentIds: [42],
        documentPaths: ['path/to/doc'],
        minScore: 0.5,
        limit: 5,
      },
      projectIds: [1, 2],
      messages: [],
    });
    expect(mockSearchKnowledge).toHaveBeenCalledWith({
      projectIds: [1, 2],
      query: 'test',
      memoryIds: undefined,
      memoryTags: ['tag1'],
      paths: ['path/to/doc'],
      documentIds: [42],
      minScore: 0.5,
      limit: 5,
    });
  });

  test('combines multiple results into single system message', async () => {
    mockSearchKnowledge.mockResolvedValueOnce([
      {
        sourceType: 'document',
        documentId: 'doc_2',
        fileId: 'fil_2',
        projectId: 'prj_1',
        path: 'a.md',
        filename: 'a.md',
        size: 50,
        title: 'A',
        content: 'Content A',
        score: 0.9,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        sourceType: 'memory',
        entryId: 'mne_002',
        memoryId: 'mem_002',
        content: 'Memory B',
        score: 0.7,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as Awaited<ReturnType<typeof knowledgeModule.searchKnowledge>>);

    const result = await buildKnowledgeMessages({
      knowledgeConfig: { query: 'combined' },
      messages: [{ role: 'user', content: 'combined' }],
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('Content A');
    expect(result[0].content).toContain('Memory B');
  });
});
