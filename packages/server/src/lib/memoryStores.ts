import { db } from 'src/db';
import { emptyPage, paginatedList } from 'src/lib/pagination';
import { registerResourceFieldMap } from 'src/lib/policyCompiler';
import { hasPolicyConstraints } from 'src/lib/policyWhere';
import { makeResourceAccessor } from 'src/lib/resourceAccessor';
import { applyTagFilter, mergeTags } from 'src/lib/tags';

registerResourceFieldMap({
  resourceType: 'memory_store',
  publicIdColumn: { column: 'publicId' },
  tagsColumn: { column: 'tags' },
});

type MemoryStoreRow = InstanceType<(typeof db)['MemoryStore']> & {
  project?: InstanceType<(typeof db)['Project']>;
};

const memoryStoreIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

export const memoryStores = makeResourceAccessor<MemoryStoreRow>({
  model: () => {
    return db.MemoryStore;
  },
  includes: memoryStoreIncludes,
  label: 'Memory store',
});

const mapMemoryStore = (instance: MemoryStoreRow) => {
  return {
    id: instance.publicId,
    project_id: instance.project?.publicId,
    name: instance.name,
    description: instance.description ?? undefined,
    tags: instance.tags ?? undefined,
    // Null is "use the algorithm constant", and it is reported as null rather
    // than as the constant: a store that has never set a policy must read
    // differently from one pinned to today's default.
    duplicate_threshold: instance.duplicateThreshold ?? null,
    supersede_threshold: instance.supersedeThreshold ?? null,
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

export const createMemoryStore = async (args: {
  projectId: number;
  name: string;
  description?: string;
  tags?: Record<string, string>;
  duplicateThreshold?: number | null;
  supersedeThreshold?: number | null;
}) => {
  const memoryStore = await db.MemoryStore.create({
    projectId: args.projectId,
    name: args.name,
    description: args.description ?? null,
    tags: args.tags ?? null,
    duplicateThreshold: args.duplicateThreshold ?? null,
    supersedeThreshold: args.supersedeThreshold ?? null,
  });

  return mapMemoryStore(await memoryStores.reload(memoryStore));
};

export const listMemoryStores = async (args: {
  projectIds: number[];
  tags?: Record<string, string>;
  policyWhere?: Record<string, unknown>;
  limit?: number;
  offset?: number;
}) => {
  if (args.projectIds.length === 0) return emptyPage(args);

  const where: Record<string, unknown> = { projectId: args.projectIds };
  applyTagFilter({ where, tags: args.tags });
  if (hasPolicyConstraints(args.policyWhere)) {
    Object.assign(where, args.policyWhere);
  }
  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['createdAt', 'ASC']],
    query: ({ limit, offset, order }) => {
      return db.MemoryStore.findAndCountAll({
        where,
        include: [{ model: db.Project, as: 'project' }],
        distinct: true,
        order,
        limit,
        offset,
      });
    },
    map: mapMemoryStore,
  });
};

/**
 * The internal id and the store's stored dedup policy — what a write route
 * needs and the mapped view does not carry in internal form.
 */
export type MemoryStoreDedupPolicy = {
  id: number;
  duplicateThreshold: number | null;
  supersedeThreshold: number | null;
};

export const findMemoryStoreDedupPolicy = async (args: {
  id: string;
}): Promise<MemoryStoreDedupPolicy | null> => {
  const store = await db.MemoryStore.findOne({
    where: { publicId: args.id },
    attributes: ['id', 'duplicateThreshold', 'supersedeThreshold'],
  });
  if (!store) return null;
  return {
    id: store.id as number,
    duplicateThreshold: store.duplicateThreshold,
    supersedeThreshold: store.supersedeThreshold,
  };
};

/**
 * A store's internal id and owning project — what a write to one of its
 * sub-resources needs once the store itself has authorized the request.
 *
 * Its own reader rather than a second field on the dedup-policy one: the two
 * answer different questions, and widening that one would make every threshold
 * read carry a column it has no use for.
 */
export const findMemoryStoreScope = async (args: {
  id: string;
}): Promise<{ id: number; projectId: number } | null> => {
  const store = await db.MemoryStore.findOne({
    where: { publicId: args.id },
    attributes: ['id', 'projectId'],
  });
  if (!store) return null;
  return { id: store.id as number, projectId: store.projectId };
};

/**
 * What an IAM check on a store needs, alongside the internal id its writes
 * take: the owning project's **public** id (an SRN names public ids) and the
 * store's own tags (the `soat:ResourceTag/<key>` condition inputs).
 *
 * Separate from `findMemoryStoreScope`, which answers the numeric-project
 * question a sub-resource write asks *after* the store authorized the call.
 */
export const findMemoryStoreIamScope = async (args: {
  id: string;
}): Promise<{
  id: number;
  projectPublicId: string;
  tags: Record<string, string> | null;
} | null> => {
  const store = await memoryStores.findByPublicId({ id: args.id });
  if (!store) return null;
  return {
    id: store.id as number,
    projectPublicId: store.project!.publicId,
    tags: store.tags ?? null,
  };
};

export const getMemoryStore = async (args: { id: string }) => {
  const memoryStore = await memoryStores.findByPublicId({ id: args.id });
  if (!memoryStore) return null;
  return mapMemoryStore(memoryStore);
};

export const updateMemoryStore = async (args: {
  id: string;
  name?: string;
  description?: string | null;
  tags?: Record<string, string> | null;
  duplicateThreshold?: number | null;
  supersedeThreshold?: number | null;
}) => {
  const memoryStore = await db.MemoryStore.findOne({
    where: { publicId: args.id },
  });
  if (!memoryStore) return null;

  if (args.name !== undefined) memoryStore.name = args.name;
  if (args.description !== undefined)
    memoryStore.description = args.description ?? null;
  if (args.tags !== undefined) memoryStore.tags = args.tags ?? null;
  // `null` clears the override back to the algorithm constant, which is a
  // different request from leaving the field out.
  if (args.duplicateThreshold !== undefined)
    memoryStore.duplicateThreshold = args.duplicateThreshold;
  if (args.supersedeThreshold !== undefined)
    memoryStore.supersedeThreshold = args.supersedeThreshold;

  await memoryStore.save();

  return mapMemoryStore(await memoryStores.reload(memoryStore));
};

export const getMemoryStoreTags = async (args: { id: string }) => {
  const memoryStore = await db.MemoryStore.findOne({
    where: { publicId: args.id },
  });
  if (!memoryStore) return null;
  return memoryStore.tags ?? {};
};

export const updateMemoryStoreTags = async (args: {
  id: string;
  tags: Record<string, string>;
  merge?: boolean;
}) => {
  const memoryStore = await db.MemoryStore.findOne({
    where: { publicId: args.id },
  });
  if (!memoryStore) return null;

  const newTags = mergeTags({
    current: memoryStore.tags,
    incoming: args.tags,
    merge: args.merge,
  });
  await memoryStore.update({ tags: newTags });

  // The tag routes' contract is the tag map itself, not the memory store.
  return newTags;
};

export const deleteMemoryStore = async (args: {
  id: string;
}): Promise<'deleted' | null> => {
  const memoryStore = await db.MemoryStore.findOne({
    where: { publicId: args.id },
  });
  if (!memoryStore) return null;
  await memoryStore.destroy();
  return 'deleted';
};
