import {
  GOLDEN_QUERY_KINDS,
  loadGoldenSet,
  parseGoldenSet,
  readDocumentSection,
  resolveDocumentContent,
} from 'tests/eval/knowledge/goldenSet';

const golden = loadGoldenSet();

const memoryStoresByKey = new Map(
  golden.corpus.memories.map((memoryStore) => {
    return [memoryStore.key, memoryStore];
  })
);

/** Each `freshness` query's answer paired with the aged twin it must outrank. */
const freshnessTwins = golden.queries
  .filter((query) => {
    return query.kind === 'freshness';
  })
  .map((query) => {
    const fresh = memoryStoresByKey.get(query.expected[0].key)!;
    const superseded = memoryStoresByKey.get(`${fresh.key}-superseded`);
    return {
      id: query.id,
      expected: query.expected.length,
      fresh,
      superseded,
      gapDays: (superseded?.age_days ?? 0) - (fresh.age_days ?? 0),
    };
  });

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
      ...golden.corpus.memories.map((memoryStore) => {
        return memoryStore.content;
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

  test('reads a memoryStore fixture age and the container it belongs to', () => {
    const golden = parseGoldenSet({
      raw: {
        version: 1,
        corpus: {
          documents: [],
          memories: [
            { key: 'mem:a', content: 'a' },
            {
              key: 'mem:b',
              content: 'b',
              age_days: 180.5,
              memory_store: 'Prior quarter',
            },
          ],
        },
        queries: [],
      },
    });

    expect(golden.corpus.memories).toEqual([
      {
        key: 'mem:a',
        content: 'a',
        tags: undefined,
        age_days: undefined,
        memory_store: undefined,
      },
      {
        key: 'mem:b',
        content: 'b',
        tags: undefined,
        age_days: 180.5,
        memory_store: 'Prior quarter',
      },
    ]);
  });

  test('rejects a negative or non-finite memoryStore age', () => {
    const withAge = (age_days: unknown) => {
      return () => {
        return parseGoldenSet({
          raw: {
            version: 1,
            corpus: {
              documents: [],
              memories: [{ key: 'mem:a', content: 'a', age_days }],
            },
            queries: [],
          },
        });
      };
    };

    expect(withAge(-1)).toThrow(/age_days/);
    expect(withAge('180')).toThrow(/age_days/);
  });

  test('pairs every freshness query with an older twin in another container', () => {
    // The blend only ever demotes, so a freshness query measures nothing
    // without an aged near-twin for the decay to overtake — and it has to sit
    // in another container, since `writeMemory` dedups twins sharing one
    // at 0.95 and the seeder refuses anything but a `created` write.
    //
    // The twin is the answer's key suffixed `-superseded`: pairing them by name
    // is what lets the gap be asserted per query, rather than the corpus merely
    // holding some aged entry somewhere.
    expect(freshnessTwins).not.toHaveLength(0);

    for (const twin of freshnessTwins) {
      expect({
        id: twin.id,
        // More than one expected key and the query stops measuring the twin.
        expected: twin.expected,
        superseded: twin.superseded !== undefined,
        elsewhere: twin.superseded?.memory_store !== twin.fresh.memory_store,
        older: twin.gapDays > 0,
      }).toEqual({
        id: twin.id,
        expected: 1,
        superseded: true,
        elsewhere: true,
        older: true,
      });
    }
  });

  test('exercises twin age gaps a bounded decay cannot all reach', () => {
    // A multiplicative blend demotes a twin by a factor of its age, so a corpus
    // of far-apart twins is the easy case: every gap here was 240 days or more
    // until #1298 measured that a 40-day one flips at no setting that leaves
    // the other kinds intact. Keeping a small gap labeled is what stops a
    // ranking change from reading as a win on the easy half alone.
    const gaps = freshnessTwins.map((twin) => {
      return twin.gapDays;
    });

    expect(Math.min(...gaps)).toBeLessThanOrEqual(60);
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(240);
  });

  test('labels a freshness answer that is itself aged', () => {
    // Every answer sat at age zero until #1298: decay factors there are exactly
    // `1`, so the corpus never covered the ordinary case where both twins have
    // aged and the blend has to separate two decayed scores rather than one.
    const aged = freshnessTwins.filter((twin) => {
      return (twin.fresh.age_days ?? 0) > 0;
    });

    expect(aged.length).toBeGreaterThan(0);
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
