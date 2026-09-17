import { featureHashEmbedding } from 'tests/eval/knowledge/featureHashEmbedding';
import {
  GOLDEN_QUERY_KINDS,
  loadGoldenSet,
  parseGoldenSet,
} from 'tests/eval/knowledge/goldenSet';
import {
  CORPUS_DUPLICATE_THRESHOLD,
  CORPUS_SUPERSEDE_THRESHOLD,
} from 'tests/eval/knowledge/seedCorpus';

const golden = loadGoldenSet();

const DIMENSIONS = 1024;

/**
 * How far under the store's supersede threshold every twin pair must sit. A
 * pair that merely clears it is one wording tweak from crossing, and the
 * failure on the other side is a seeder throw in a job that takes minutes to
 * reach it.
 */
const SUPERSEDE_MARGIN = 0.03;

/**
 * How far apart the query may score two twins before relevance, not age, is
 * what separates them. The shipped pairs all sit under 0.005; the lexically
 * divergent rewrites #1333 measured move it by 0.10–0.27 and fail this.
 */
const AMBIGUITY_MAX = 0.02;

const embed = (text: string): number[] => {
  return featureHashEmbedding({ text, dimensions: DIMENSIONS });
};

/** Cosine of two L2-normalised vectors is their dot product. */
const cosine = (a: number[], b: number[]): number => {
  return a.reduce((total, value, index) => {
    return total + value * b[index];
  }, 0);
};

const similarity = (a: string, b: string): number => {
  return cosine(embed(a), embed(b));
};

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
      text: query.query,
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

  test('carries frozen, non-empty content on every document fixture', () => {
    // The corpus is static text, never a pointer into the module docs: a
    // fixture read at seed time makes the baseline a function of
    // documentation prose as well as ranking code (#1345).
    for (const document of golden.corpus.documents) {
      expect({
        key: document.key,
        empty: document.content.trim().length === 0,
      }).toEqual({ key: document.key, empty: false });
    }
  });

  test('gives every exact_token query an identifier unique in the corpus', () => {
    // An identifier that occurs in a second fixture has more than one correct
    // answer, and the query silently stops measuring lexical precision.
    const corpus = [
      ...golden.corpus.documents.map((document) => {
        return document.content;
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

  test('rejects a document that points at a module doc section', () => {
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
    }).toThrow(/must carry inline `content`/);
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

  test('pairs every freshness query with an older twin in the same container', () => {
    // The blend only ever demotes, so a freshness query measures nothing
    // without an aged near-twin for the decay to overtake.
    //
    // Both twins share one container. They used to be split across two on the
    // premise that `writeMemory` would dedup them — measured false in #1333,
    // and the split was not free: a twin parked in a second store measures an
    // unscoped search across a current/archive pair, which `memory_store_ids`
    // already answers, rather than what the write path itself produces.
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
        // `undefined` on both sides is the corpus's default container.
        sameStore: twin.superseded?.memory_store === twin.fresh.memory_store,
        older: twin.gapDays > 0,
      }).toEqual({
        id: twin.id,
        expected: 1,
        superseded: true,
        sameStore: true,
        older: true,
      });
    }
  });

  test('keeps every freshness twin under the store supersede threshold', () => {
    // Over it, `writeMemory` invalidates the older twin and the seeder throws:
    // the pair never reaches the corpus and the query scores zero. The corpus
    // store raises its own band for exactly this, so the check is against that
    // value rather than the product default.
    for (const twin of freshnessTwins) {
      const score = similarity(twin.fresh.content, twin.superseded!.content);

      expect({
        id: twin.id,
        clear: score < CORPUS_SUPERSEDE_THRESHOLD - SUPERSEDE_MARGIN,
      }).toEqual({ id: twin.id, clear: true });
    }
  });

  test('leaves every freshness pair unseparable by relevance', () => {
    // If the query prefers the fresher twin on its own, ranking answers it
    // without reading age and the kind scores 1.0 with every recency mechanism
    // switched off — measuring nothing. Age has to be the only thing that
    // separates them.
    for (const twin of freshnessTwins) {
      const gap =
        similarity(twin.text, twin.fresh.content) -
        similarity(twin.text, twin.superseded!.content);

      expect({ id: twin.id, ambiguous: Math.abs(gap) < AMBIGUITY_MAX }).toEqual(
        {
          id: twin.id,
          ambiguous: true,
        }
      );
    }
  });

  test('seeds no two memories that collide on the write path', () => {
    // The seeder writes every fixture naming no store of its own into one
    // container and throws unless each lands as `created`. Checked across the
    // whole corpus rather than within the pairs, because a fixture's nearest
    // neighbour is not necessarily its twin.
    const shared = golden.corpus.memories.filter((memory) => {
      return memory.memory_store === undefined;
    });
    const vectors = shared.map((memory) => {
      return { key: memory.key, vector: embed(memory.content) };
    });

    const collisions: string[] = [];
    for (let i = 0; i < vectors.length; i += 1) {
      for (let j = i + 1; j < vectors.length; j += 1) {
        const score = cosine(vectors[i].vector, vectors[j].vector);
        if (score >= CORPUS_SUPERSEDE_THRESHOLD) {
          collisions.push(
            `${vectors[i].key} ~ ${vectors[j].key} = ${score.toFixed(4)}`
          );
        }
      }
    }

    expect(collisions).toEqual([]);
  });

  test('keeps superseding reachable below deduplication in the corpus store', () => {
    expect(CORPUS_SUPERSEDE_THRESHOLD).toBeLessThan(CORPUS_DUPLICATE_THRESHOLD);
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
