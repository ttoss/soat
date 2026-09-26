import { createHash } from 'node:crypto';

import createDebug from 'debug';
import { db } from 'src/db';
import { getEmbedding } from 'src/lib/embedding';

const log = createDebug('soat:memories');

/**
 * The dedup key for a store's text. Trimmed and whitespace-collapsed first, so
 * the same sentence typed with different spacing is the same content and costs
 * one embedding rather than two.
 *
 * The migration reproduces this exactly in SQL; changing the normalization
 * means rehashing `memory_contents`.
 */
export const hashMemoryContent = (args: { content: string }): string => {
  const normalized = args.content.trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
};

const embedOrNull = async (args: {
  content: string;
  memoryStoreId: number;
  projectId: number | null;
  generationId: string | null | undefined;
}): Promise<number[] | null> => {
  try {
    return await getEmbedding({
      text: args.content,
      billing:
        args.projectId === null
          ? null
          : {
              projectId: args.projectId,
              generationId: args.generationId ?? null,
            },
      subject: { memoryStoreId: args.memoryStoreId },
    });
  } catch {
    // An embedding is optional: a fact must never be lost because the embedder
    // was unavailable. The row is simply not a dedup or search candidate until
    // a later write fills it in (see `resolveMemoryContent`).
    return null;
  }
};

/**
 * The store's row for this text, created on first sight.
 *
 * A hash hit returns without reaching the embedder at all, which is what makes
 * an assertion restating known text free — the case the `tool` and `rule` doors
 * hit most, mid-turn.
 */
export const resolveMemoryContent = async (args: {
  memoryStoreId: number;
  content: string;
  projectId: number | null;
  /**
   * The public id of the generation writing it — an agent's or a rule's turn.
   * Required, though it may be undefined, so a caller has to pass it through.
   */
  generationId: string | null | undefined;
}): Promise<InstanceType<(typeof db)['MemoryContent']>> => {
  const contentHash = hashMemoryContent({ content: args.content });
  const existing = await db.MemoryContent.findOne({
    where: { memoryStoreId: args.memoryStoreId, contentHash },
  });

  log(
    'resolveMemoryContent: memoryStoreId=%d hash=%s hit=%s',
    args.memoryStoreId,
    contentHash,
    Boolean(existing)
  );

  if (existing) {
    // A row whose first write could not embed would otherwise stay invisible to
    // both dedup and search forever, because every later write of that text is
    // a hash hit that never reaches the embedder again.
    if (!existing.embedding) {
      const embedding = await embedOrNull({
        ...args,
        content: existing.content,
      });
      if (embedding) {
        existing.embedding = embedding;
        await existing.save();
      }
    }
    return existing;
  }

  const embedding = await embedOrNull(args);

  // `findOrCreate`, not `create`: two concurrent writes of the same new text
  // both miss the lookup above, and the unique index decides between them. The
  // loser reads the winner's row instead of failing a write whose content is
  // already stored. The fast path stays above it so a hash hit still costs no
  // embedding call — which is why this is not simply one `findOrCreate`.
  const [content] = await db.MemoryContent.findOrCreate({
    where: { memoryStoreId: args.memoryStoreId, contentHash },
    defaults: {
      memoryStoreId: args.memoryStoreId,
      content: args.content,
      contentHash,
      embedding,
    },
  });
  return content;
};
