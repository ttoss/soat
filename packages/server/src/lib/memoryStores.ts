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

const memoryStores = makeResourceAccessor<MemoryStoreRow>({
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
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

export const createMemoryStore = async (args: {
  projectId: number;
  name: string;
  description?: string;
  tags?: Record<string, string>;
}) => {
  const memoryStore = await db.MemoryStore.create({
    projectId: args.projectId,
    name: args.name,
    description: args.description ?? null,
    tags: args.tags ?? null,
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
    query: ({ limit, offset }) => {
      return db.MemoryStore.findAndCountAll({
        where,
        include: [{ model: db.Project, as: 'project' }],
        order: [['createdAt', 'ASC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: mapMemoryStore,
  });
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
}) => {
  const memoryStore = await db.MemoryStore.findOne({
    where: { publicId: args.id },
  });
  if (!memoryStore) return null;

  if (args.name !== undefined) memoryStore.name = args.name;
  if (args.description !== undefined)
    memoryStore.description = args.description ?? null;
  if (args.tags !== undefined) memoryStore.tags = args.tags ?? null;

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
