import { db } from 'src/db';
import { emptyPage, paginatedList } from 'src/lib/pagination';
import { registerResourceFieldMap } from 'src/lib/policyCompiler';
import { hasPolicyConstraints } from 'src/lib/policyWhere';
import { makeResourceAccessor } from 'src/lib/resourceAccessor';
import { applyTagFilter, mergeTags } from 'src/lib/tags';

registerResourceFieldMap({
  resourceType: 'memory',
  publicIdColumn: { column: 'publicId' },
  tagsColumn: { column: 'tags' },
});

type MemoryRow = InstanceType<(typeof db)['Memory']> & {
  project?: InstanceType<(typeof db)['Project']>;
};

const memoryIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

const memories = makeResourceAccessor<MemoryRow>({
  model: () => {
    return db.Memory;
  },
  includes: memoryIncludes,
  label: 'Memory',
});

const mapMemory = (instance: MemoryRow) => {
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

export const createMemory = async (args: {
  projectId: number;
  name: string;
  description?: string;
  tags?: Record<string, string>;
}) => {
  const memory = await db.Memory.create({
    projectId: args.projectId,
    name: args.name,
    description: args.description ?? null,
    tags: args.tags ?? null,
  });

  return mapMemory(await memories.reload(memory));
};

export const listMemories = async (args: {
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
      return db.Memory.findAndCountAll({
        where,
        include: [{ model: db.Project, as: 'project' }],
        order: [['createdAt', 'ASC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: mapMemory,
  });
};

export const getMemory = async (args: { id: string }) => {
  const memory = await memories.findByPublicId({ id: args.id });
  if (!memory) return null;
  return mapMemory(memory);
};

export const updateMemory = async (args: {
  id: string;
  name?: string;
  description?: string | null;
  tags?: Record<string, string> | null;
}) => {
  const memory = await db.Memory.findOne({
    where: { publicId: args.id },
  });
  if (!memory) return null;

  if (args.name !== undefined) memory.name = args.name;
  if (args.description !== undefined)
    memory.description = args.description ?? null;
  if (args.tags !== undefined) memory.tags = args.tags ?? null;

  await memory.save();

  return mapMemory(await memories.reload(memory));
};

export const getMemoryTags = async (args: { id: string }) => {
  const memory = await db.Memory.findOne({ where: { publicId: args.id } });
  if (!memory) return null;
  return memory.tags ?? {};
};

export const updateMemoryTags = async (args: {
  id: string;
  tags: Record<string, string>;
  merge?: boolean;
}) => {
  const memory = await db.Memory.findOne({ where: { publicId: args.id } });
  if (!memory) return null;

  const newTags = mergeTags({
    current: memory.tags,
    incoming: args.tags,
    merge: args.merge,
  });
  await memory.update({ tags: newTags });

  // The tag routes' contract is the tag map itself, not the memory.
  return newTags;
};

export const deleteMemory = async (args: {
  id: string;
}): Promise<'deleted' | null> => {
  const memory = await db.Memory.findOne({
    where: { publicId: args.id },
  });
  if (!memory) return null;
  await memory.destroy();
  return 'deleted';
};
