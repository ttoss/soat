import { featureHashEmbedding } from 'tests/eval/knowledge/featureHashEmbedding';

const DIMENSIONS = 512;

const embed = (text: string): number[] => {
  return featureHashEmbedding({ text, dimensions: DIMENSIONS });
};

const cosine = (a: number[], b: number[]): number => {
  return a.reduce((total, value, index) => {
    return total + value * b[index];
  }, 0);
};

const norm = (vector: number[]): number => {
  return Math.sqrt(cosine(vector, vector));
};

describe('featureHashEmbedding', () => {
  test('returns a vector of the requested width', () => {
    expect(embed('the quick brown fox')).toHaveLength(DIMENSIONS);
    expect(
      featureHashEmbedding({ text: 'the quick brown fox', dimensions: 8 })
    ).toHaveLength(8);
  });

  test('is deterministic across calls', () => {
    expect(embed('relevance scoring')).toEqual(embed('relevance scoring'));
  });

  test('is deterministic across process-level ordering', () => {
    const first = embed('alpha beta gamma');
    embed('an unrelated text that must not perturb the hasher');
    expect(embed('alpha beta gamma')).toEqual(first);
  });

  test('produces a unit vector', () => {
    expect(norm(embed('knowledge search over documents'))).toBeCloseTo(1, 10);
  });

  test('produces a unit vector for text with no tokens at all', () => {
    // A zero vector would make every pgvector cosine distance NaN, which sorts
    // unpredictably — the one thing a ranking fixture may never do.
    const vector = featureHashEmbedding({
      text: '   ',
      dimensions: DIMENSIONS,
    });
    expect(norm(vector)).toBeCloseTo(1, 10);
    expect(
      vector.every((value) => {
        return Number.isFinite(value);
      })
    ).toBe(true);
  });

  test('gives different texts different vectors', () => {
    expect(embed('alpha')).not.toEqual(embed('beta'));
  });

  test('is insensitive to case', () => {
    expect(embed('Relevance Scoring')).toEqual(embed('relevance scoring'));
  });

  test('is insensitive to token order', () => {
    expect(embed('scoring relevance')).toEqual(embed('relevance scoring'));
  });

  test('keeps a hyphenated identifier as one token', () => {
    // `SKU-4711` split into `sku` and `4711` would match every other SKU in the
    // corpus, and the exact-token queries would stop discriminating.
    expect(embed('SKU-4711')).not.toEqual(embed('SKU-4712'));
  });

  test('scores a text against itself at 1', () => {
    const vector = embed('memory entries are deduplicated');
    expect(cosine(vector, vector)).toBeCloseTo(1, 10);
  });

  test('ranks term overlap above unrelated text', () => {
    const query = embed('recall and mean reciprocal rank');
    const overlapping = embed(
      'The harness reports recall and mean reciprocal rank for every query.'
    );
    const unrelated = embed(
      'Formations apply a declarative resource graph to a project.'
    );
    expect(cosine(query, overlapping)).toBeGreaterThan(
      cosine(query, unrelated)
    );
  });

  test('ranks a rare exact token above a topically similar text', () => {
    const query = embed('SKU-4711');
    const containing = embed(
      'The catalog entry for SKU-4711 ships from the Rotterdam warehouse.'
    );
    const topical = embed(
      'The catalog lists every warehouse entry with its shipping origin.'
    );
    expect(cosine(query, containing)).toBeGreaterThan(cosine(query, topical));
  });

  test('scores a near-miss identifier below an exact match', () => {
    const query = embed('INVOICE-90210');
    expect(cosine(query, embed('INVOICE-90210'))).toBeGreaterThan(
      cosine(query, embed('INVOICE-90211'))
    );
  });

  test('gives character-trigram credit to a morphological variant', () => {
    // Feature hashing has no stemmer; the trigram features are what keep
    // `chunking` from being orthogonal to `chunk`.
    const query = embed('chunk');
    expect(cosine(query, embed('chunking'))).toBeGreaterThan(0);
  });

  test('rejects a non-positive width', () => {
    expect(() => {
      return featureHashEmbedding({ text: 'alpha', dimensions: 0 });
    }).toThrow(/dimensions/i);
  });
});
