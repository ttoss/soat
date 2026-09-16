import { db } from 'src/db';
import type { MemoryAssertionSource } from 'src/lib/memoryAssertions';
import { hashMemoryContent } from 'src/lib/memoryContents';

/**
 * The asserter for memories a suite seeds to have something to read or search.
 *
 * `writeMemory` requires one on every call by design — an assertion with no
 * principal would be an audit row that cannot say who acted — and a suite whose
 * subject is retrieval has no real door behind its writes, so it declares the
 * same one every time rather than inventing a different fiction per file.
 */
export const SEED_ASSERTION: MemoryAssertionSource = {
  mechanism: 'api',
  principalType: 'user',
  principalId: 'user_seed',
};

/**
 * Moves a stored memory to a chosen cosine from whatever is written next.
 *
 * The stub embedder answers every input with the same vector, so two memories
 * in one store would otherwise always score 1.0 against each other and only the
 * duplicate band would ever be reachable. Rewriting the stored vector is what
 * puts a write in a chosen band while the algorithm runs for real, on its own
 * thresholds. Moving the thresholds instead cannot do it: a value above 1 is
 * refused as out of range, and one inside `[0, 1]` never falls below a
 * similarity that is exactly 1.
 *
 * Construction: the stub's vector is one constant in every component, so
 * negating `k` of them gives `cos = (n - 2k) / n`.
 */
export const setMemorySimilarity = async (args: {
  memoryId: string;
  similarity: number;
}): Promise<void> => {
  const memory = await db.Memory.findOne({
    where: { publicId: args.memoryId },
  });
  const content = await db.MemoryContent.findByPk(memory!.contentId);
  const dimensions = Number(process.env.EMBEDDING_DIMENSIONS);
  const flipped = Math.round((dimensions * (1 - args.similarity)) / 2);
  content!.embedding = Array.from({ length: dimensions }, (_, index) => {
    return index < flipped ? -0.1 : 0.1;
  });
  await content!.save();
};

/**
 * Pushes a memory far enough away that the next write lands as its own entry.
 * What a suite holding several independent memories in one store needs.
 */
export const isolateMemory = async (args: {
  memoryId: string;
}): Promise<void> => {
  return setMemorySimilarity({ memoryId: args.memoryId, similarity: 0 });
};

/**
 * A memory and the content row it points at, seeded directly.
 *
 * For suites that need a specific stored vector (a crowded ANN index, a byte
 * measurement) rather than whatever the stub embedder returns. `db.Memory` on
 * its own can no longer express one: the text and the vector live on the shared
 * content row, and `content_id` is `NOT NULL`.
 */
export const seedMemory = async (args: {
  memoryStoreId: number;
  content: string;
  embedding: number[] | null;
  tags?: Record<string, string> | null;
}): Promise<{ id?: unknown; publicId: string }> => {
  const content = await db.MemoryContent.create({
    memoryStoreId: args.memoryStoreId,
    content: args.content,
    contentHash: hashMemoryContent({ content: args.content }),
    embedding: args.embedding,
  });

  return db.Memory.create({
    memoryStoreId: args.memoryStoreId,
    contentId: content.id as number,
    tags: args.tags ?? null,
  });
};
