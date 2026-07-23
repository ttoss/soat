import { Op } from '@ttoss/postgresdb';
import { db } from 'src/db';
import { paginatedList } from 'src/lib/pagination';

const buildTagsGlobLiteral = (args: { tags: string[] }) => {
  const sequelize = db.Memory.sequelize!;
  const patterns = args.tags.map((tag) => {
    return tag.replace(/\*/g, '%').replace(/\?/g, '_');
  });
  const conditions = patterns
    .map((p) => {
      return `tag ILIKE ${sequelize.escape(p)}`;
    })
    .join(' OR ');
  return sequelize.literal(
    `EXISTS (SELECT 1 FROM unnest("Memory"."tags") AS t(tag) WHERE ${conditions})`
  );
};

const mapMemory = (
  instance: InstanceType<(typeof db)['Memory']> & {
    project?: InstanceType<(typeof db)['Project']>;
  }
) => {
  return {
    id: instance.publicId,
    projectId: instance.project?.publicId,
    name: instance.name,
    description: instance.description ?? undefined,
    tags: instance.tags ?? undefined,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
};

export const createMemory = async (args: {
  projectId: number;
  name: string;
  description?: string;
  tags?: string[];
}) => {
  const memory = await db.Memory.create({
    projectId: args.projectId,
    name: args.name,
    description: args.description ?? null,
    tags: args.tags ?? null,
  });

  const withProject = await db.Memory.findOne({
    where: { id: memory.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  return mapMemory(withProject!);
};

export const listMemories = async (args: {
  projectIds: number[];
  tags?: string[];
  limit?: number;
  offset?: number;
}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { projectId: args.projectIds };
  if (args.tags && args.tags.length > 0) {
    where[Op.and] = buildTagsGlobLiteral({ tags: args.tags });
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
  const memory = await db.Memory.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Project, as: 'project' }],
  });
  if (!memory) return null;
  return mapMemory(memory);
};

export const updateMemory = async (args: {
  id: string;
  name?: string;
  description?: string | null;
  tags?: string[] | null;
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

  const withProject = await db.Memory.findOne({
    where: { id: memory.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  return mapMemory(withProject!);
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
