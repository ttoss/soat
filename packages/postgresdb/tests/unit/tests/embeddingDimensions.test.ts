import {
  getEmbeddingDimensions,
  HNSW_MAX_DIMENSIONS,
} from '../../../dist/index.cjs';

/**
 * The vector columns are sized from `EMBEDDING_DIMENSIONS` at model load, and
 * both carry an HNSW index. pgvector refuses to build one over a `vector`
 * wider than 2000 dimensions, so a deployment configured past the limit has to
 * be refused here — otherwise the failure surfaces as a boot-time `sync` dying
 * mid-DDL on a Postgres error that names neither the variable nor the fix.
 */
describe('getEmbeddingDimensions', () => {
  const original = process.env.EMBEDDING_DIMENSIONS;

  afterEach(() => {
    process.env.EMBEDDING_DIMENSIONS = original;
  });

  test('returns the configured dimension count', () => {
    process.env.EMBEDDING_DIMENSIONS = '1024';

    expect(getEmbeddingDimensions()).toBe(1024);
  });

  test('accepts the largest dimension pgvector can index', () => {
    process.env.EMBEDDING_DIMENSIONS = String(HNSW_MAX_DIMENSIONS);

    expect(getEmbeddingDimensions()).toBe(HNSW_MAX_DIMENSIONS);
  });

  test('rejects a dimension count above the HNSW limit', () => {
    process.env.EMBEDDING_DIMENSIONS = String(HNSW_MAX_DIMENSIONS + 1);

    expect(() => {
      return getEmbeddingDimensions();
    }).toThrow(/2000/);
  });

  test.each(['', '0', 'many', '-1024', '1024.5'])(
    'rejects %p',
    (value: string) => {
      process.env.EMBEDDING_DIMENSIONS = value;

      expect(() => {
        return getEmbeddingDimensions();
      }).toThrow(/EMBEDDING_DIMENSIONS/);
    }
  );
});
