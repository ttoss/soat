// `DocumentChunk` reads EMBEDDING_DIMENSIONS at module load to size its vector
// column, so it must be set before the models are imported. The value only has
// to be a positive integer — no test here depends on the dimension itself.
process.env.EMBEDDING_DIMENSIONS = process.env.EMBEDDING_DIMENSIONS || '1024';
