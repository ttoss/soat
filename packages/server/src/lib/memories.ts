import { db } from 'src/db';

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

export const listMemories = async (args: { projectIds: number[] }) => {
  const memories = await db.Memory.findAll({
    where: { projectId: args.projectIds },
    include: [{ model: db.Project, as: 'project' }],
    order: [['createdAt', 'ASC']],
  });
  return memories.map(mapMemory);
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
