import {
  GOLDEN_QUERY_KINDS,
  loadGoldenSet,
  parseGoldenSet,
  readDocumentSection,
  resolveDocumentContent,
} from 'tests/eval/knowledge/goldenSet';

const golden = loadGoldenSet();

describe('knowledge eval golden set', () => {
  test('carries at least 50 labeled pairs', () => {
    expect(golden.queries.length).toBeGreaterThanOrEqual(50);
  });

  test('covers every query kind', () => {
    const kinds = new Set(
      golden.queries.map((query) => {
        return query.kind;
      })
    );
    expect([...kinds].sort()).toEqual(GOLDEN_QUERY_KINDS);
  });

  test('includes exact_token, exact_name and entity queries', () => {
    for (const kind of ['exact_token', 'exact_name', 'entity']) {
      const matching = golden.queries.filter((query) => {
        return query.kind === kind;
      });
      expect(matching.length).toBeGreaterThan(0);
    }
  });

  test('resolves every document fixture to non-empty content', () => {
    for (const document of golden.corpus.documents) {
      expect(
        resolveDocumentContent({ document }).trim().length
      ).toBeGreaterThan(0);
    }
  });

  test('gives every exact_token query an identifier unique in the corpus', () => {
    // An identifier that occurs in a second fixture has more than one correct
    // answer, and the query silently stops measuring lexical precision.
    const corpus = [
      ...golden.corpus.documents.map((document) => {
        return resolveDocumentContent({ document });
      }),
      ...golden.corpus.memories.map((memory) => {
        return memory.content;
      }),
    ];

    for (const query of golden.queries) {
      if (query.kind !== 'exact_token') continue;
      const containing = corpus.filter((text) => {
        return text.includes(query.query);
      });
      expect({ id: query.id, containing: containing.length }).toEqual({
        id: query.id,
        containing: 1,
      });
    }
  });

  test('rejects an expectation naming a key the corpus does not seed', () => {
    expect(() => {
      return parseGoldenSet({
        raw: {
          version: 1,
          corpus: { documents: [], memories: [] },
          queries: [
            {
              id: 'q1',
              query: 'anything',
              kind: 'semantic',
              expected: [{ source_type: 'document', key: 'doc:missing' }],
            },
          ],
        },
      });
    }).toThrow(/does not seed/);
  });

  test('rejects a duplicate corpus key', () => {
    expect(() => {
      return parseGoldenSet({
        raw: {
          version: 1,
          corpus: {
            documents: [
              { key: 'doc:a', path: '/a.md', content: 'a' },
              { key: 'doc:a', path: '/b.md', content: 'b' },
            ],
            memories: [],
          },
          queries: [],
        },
      });
    }).toThrow(/duplicate corpus key/);
  });

  test('rejects a document that names both a source section and inline content', () => {
    expect(() => {
      return parseGoldenSet({
        raw: {
          version: 1,
          corpus: {
            documents: [
              {
                key: 'doc:a',
                path: '/a.md',
                source: 'packages/website/docs/modules/knowledge.md',
                section: 'Overview',
                content: 'a',
              },
            ],
            memories: [],
          },
          queries: [],
        },
      });
    }).toThrow(/not both and not neither/);
  });

  test('rejects an unknown query kind', () => {
    expect(() => {
      return parseGoldenSet({
        raw: {
          version: 1,
          corpus: {
            documents: [{ key: 'doc:a', path: '/a.md', content: 'a' }],
            memories: [],
          },
          queries: [
            {
              id: 'q1',
              query: 'anything',
              kind: 'lexical',
              expected: [{ source_type: 'document', key: 'doc:a' }],
            },
          ],
        },
      });
    }).toThrow(/must be one of/);
  });
});

describe('readDocumentSection', () => {
  test('returns the heading and its body', () => {
    const section = readDocumentSection({
      source: 'packages/website/docs/modules/knowledge.md',
      section: 'Relevance scoring',
    });
    expect(section.startsWith('### Relevance scoring')).toBe(true);
    expect(section.length).toBeGreaterThan(100);
  });

  test('stops at the next heading of the same or a higher level', () => {
    const section = readDocumentSection({
      source: 'packages/website/docs/modules/knowledge.md',
      section: 'Relevance scoring',
    });
    expect(section).not.toContain('### Ranking is approximate');
  });

  test('throws when the section names no heading', () => {
    expect(() => {
      return readDocumentSection({
        source: 'packages/website/docs/modules/knowledge.md',
        section: 'A Section That Does Not Exist',
      });
    }).toThrow(/expected exactly one/);
  });
});
