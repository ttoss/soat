import type { MemorySource } from '@soat/postgresdb';
import { db } from 'src/db';
import {
  contentBoundTagKeysOfStore,
  withoutContentBoundTags,
} from 'src/lib/contentBoundTags';
import type { Transaction } from 'src/lib/dbTransaction';
import type { MemoryRow } from 'src/lib/memoryMapper';
import type {
  EffectiveThresholds,
  MemoryWriteAction,
} from 'src/lib/memoryWrite';
import { mergeTags } from 'src/lib/tags';

/**
 * The outcome a write resolved to, and how it stores the memory it resolved
 * into, inside the transaction that appends its assertion.
 */
export type SettledWrite = {
  action: MemoryWriteAction;
  store: (options: { transaction: Transaction }) => Promise<MemoryRow>;
};

/**
 * Tags and metadata for the memory replacing a superseded one: the retired
 * memory's bags, with the incoming keys winning.
 *
 * Carried forward rather than dropped because a supersede states the *same
 * fact, changed* — a replacement that lost the original's `role` tag would
 * silently fall out of every tag-scoped search and policy the original
 * satisfied, which is precisely the invisible loss this design removes
 * elsewhere.
 */
const inheritBags = (args: {
  retired: MemoryRow;
  tags?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
  /** Judged the retired text, not the replacement's (`contentBoundTags.ts`). */
  contentBoundKeys: readonly string[];
}) => {
  const inherited = withoutContentBoundTags({
    keys: args.contentBoundKeys,
    tags: args.retired.tags,
  });
  return {
    tags:
      args.tags && Object.keys(args.tags).length > 0
        ? mergeTags({
            current: inherited,
            incoming: args.tags,
            merge: true,
          })
        : inherited,
    metadata:
      args.metadata || args.retired.metadata
        ? { ...(args.retired.metadata ?? {}), ...(args.metadata ?? {}) }
        : null,
  };
};

export type MemoryRowArgs = {
  memoryStoreId: number;
  actorId: number | null;
  contentId: number;
  sourceType?: MemorySource;
  sourceConversationPublicId?: string | null;
  tags?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
};

const createMemoryRow = async (
  args: MemoryRowArgs & { transaction: Transaction }
): Promise<MemoryRow> => {
  const conversationPublicId = args.sourceConversationPublicId ?? null;
  return db.Memory.create(
    {
      memoryStoreId: args.memoryStoreId,
      actorId: args.actorId,
      contentId: args.contentId,
      sourceType: conversationPublicId
        ? 'conversation'
        : (args.sourceType ?? 'manual'),
      sourceId: conversationPublicId,
      tags: args.tags ?? null,
      metadata: args.metadata ?? null,
    },
    { transaction: args.transaction }
  );
};

/**
 * Retires the matched memory and creates its replacement.
 *
 * Lossless at the audit level: the old memory stays readable by id (with
 * `include_invalidated`), its text intact on the content row it still points
 * at, and its own assertions attached. What changes is retrieval — only the
 * newest statement of a fact is searchable, which is what temporal invalidation
 * is for.
 */
const supersedeMemory = async (
  args: MemoryRowArgs & { match: MemoryRow; transaction: Transaction }
): Promise<MemoryRow> => {
  const replacement = await createMemoryRow({
    memoryStoreId: args.memoryStoreId,
    actorId: args.actorId,
    contentId: args.contentId,
    sourceType: args.sourceType,
    sourceConversationPublicId: args.sourceConversationPublicId,
    transaction: args.transaction,
    ...inheritBags({
      retired: args.match,
      tags: args.tags,
      metadata: args.metadata,
      contentBoundKeys: await contentBoundTagKeysOfStore({
        memoryStoreId: args.memoryStoreId,
      }),
    }),
  });

  args.match.invalidatedAt = new Date();
  args.match.supersededByMemoryId = replacement.id as number;
  await args.match.save({ transaction: args.transaction });

  return replacement;
};

/** The outcome `writeMemory`'s table resolves a measured write to. */
export const resolveOutcome = (args: {
  declaredTarget: MemoryRow | null;
  match: MemoryRow | null;
  similarity: number | null;
  thresholds: EffectiveThresholds;
  rowArgs: MemoryRowArgs;
}): SettledWrite => {
  const replacementFor = (retired: MemoryRow): SettledWrite => {
    return {
      action: 'superseded',
      store: ({ transaction }) => {
        return supersedeMemory({
          match: retired,
          ...args.rowArgs,
          transaction,
        });
      },
    };
  };

  if (args.declaredTarget) return replacementFor(args.declaredTarget);

  const { match, similarity } = args;
  if (match && similarity !== null) {
    if (similarity >= args.thresholds.duplicateThreshold) {
      return {
        action: 'skipped',
        store: async () => {
          return match;
        },
      };
    }
    if (similarity >= args.thresholds.supersedeThreshold) {
      return replacementFor(match);
    }
  }

  return {
    action: 'created',
    store: ({ transaction }) => {
      return createMemoryRow({ ...args.rowArgs, transaction });
    },
  };
};
