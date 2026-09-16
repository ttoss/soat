import type { DB } from 'src/db';
import { db } from 'src/db';
import { makeResourceAccessor } from 'src/lib/resourceAccessor';

export type MemoryRow = InstanceType<(typeof db)['Memory']> & {
  memoryStore?: InstanceType<(typeof db)['MemoryStore']>;
  content?: InstanceType<(typeof db)['MemoryContent']>;
  supersededByMemory?: InstanceType<(typeof db)['Memory']> | null;
};

/**
 * Every read path that feeds `mapMemory` must use these includes: the
 * mapper reports the text, the store and the supersede link from the loaded
 * associations, so a query that omits one would silently return `null` for a
 * link that exists (the #801 failure shape) — or, for `content`, fail outright.
 */
export type MemoryInclude = {
  model: DB['MemoryStore'] | DB['MemoryContent'] | DB['Memory'];
  as: string;
};

export const memoryIncludes = (): MemoryInclude[] => {
  return [
    { model: db.MemoryStore, as: 'memoryStore' },
    { model: db.MemoryContent, as: 'content' },
    { model: db.Memory, as: 'supersededByMemory' },
  ];
};

export const memories = makeResourceAccessor<MemoryRow>({
  model: () => {
    return db.Memory;
  },
  includes: memoryIncludes,
  label: 'Memory',
});

const linkedPublicId = (
  linked?: { publicId: string } | null
): string | null => {
  return linked?.publicId ?? null;
};

export const mapMemory = (instance: MemoryRow) => {
  return {
    id: instance.publicId,
    memory_store_id: instance.memoryStore?.publicId,
    // The shared row's text. A memory holds no copy of its own, so an include
    // that skipped `content` would throw here rather than report a wrong value.
    content: instance.content!.content,
    source_type: instance.sourceType,
    source_id: instance.sourceId ?? null,
    tags: instance.tags ?? null,
    metadata: instance.metadata ?? null,
    invalidated_at: instance.invalidatedAt ?? null,
    superseded_by_memory_id: linkedPublicId(instance.supersededByMemory),
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

export type MappedMemory = ReturnType<typeof mapMemory>;
