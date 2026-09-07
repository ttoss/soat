/**
 * The widest `vector` pgvector will build an HNSW index over. A column above
 * it needs `halfvec`, which `DataType.VECTOR` cannot express.
 */
export const HNSW_MAX_DIMENSIONS = 2000;

/**
 * Dimension count for both vector columns, read from the environment at model
 * load.
 *
 * The upper bound is checked here rather than left to Postgres because both
 * columns carry an HNSW index: past the limit the failure would otherwise be a
 * boot-time `sync({ alter: true })` dying on `CREATE INDEX`, naming neither the
 * variable that caused it nor the fix.
 */
export const getEmbeddingDimensions = (): number => {
  const dimensions = Number(process.env.EMBEDDING_DIMENSIONS);

  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(
      'EMBEDDING_DIMENSIONS environment variable must be set to a positive integer'
    );
  }

  if (dimensions > HNSW_MAX_DIMENSIONS) {
    throw new Error(
      `EMBEDDING_DIMENSIONS is ${dimensions}, above the ${HNSW_MAX_DIMENSIONS} dimensions pgvector can index with HNSW — configure an embedding model of at most ${HNSW_MAX_DIMENSIONS} dimensions`
    );
  }

  return dimensions;
};
