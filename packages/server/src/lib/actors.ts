import { db } from '../db';

const mapActor = (
  actor: InstanceType<(typeof db)['Actor']> & {
    project?: InstanceType<(typeof db)['Project']>;
  }
) => {
  return {
    id: actor.publicId,
    projectId: actor.project?.publicId,
    name: actor.name,
    type: actor.type ?? undefined,
    externalId: actor.externalId ?? undefined,
    createdAt: actor.createdAt,
    updatedAt: actor.updatedAt,
  };
};

export const listActors = async (args: {
  projectIds?: number[];
  externalId?: string;
}) => {
  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return [];
  }

  const where: Record<string, unknown> = {};

  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  if (args.externalId !== undefined) {
    where.externalId = args.externalId;
  }

  const actors = await db.Actor.findAll({
    where: Object.keys(where).length > 0 ? where : undefined,
    include: [{ model: db.Project, as: 'project' }],
  });

  return actors.map(mapActor);
};

export const getActor = async (args: { id: string }) => {
  const actor = await db.Actor.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  if (!actor) {
    return null;
  }

  return mapActor(actor);
};

export const createActor = async (args: {
  projectId: number;
  name: string;
  type?: string;
  externalId?: string;
}) => {
  const actor = await db.Actor.create({
    projectId: args.projectId,
    name: args.name,
    type: args.type,
    externalId: args.externalId,
  });

  const actorWithProject = await db.Actor.findOne({
    where: { id: actor.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  return mapActor(actorWithProject!);
};

export const deleteActor = async (args: { id: string }) => {
  const actor = await db.Actor.findOne({ where: { publicId: args.id } });

  if (!actor) {
    return null;
  }

  await actor.destroy();

  return { id: args.id };
};

export const updateActor = async (args: {
  id: string;
  name?: string;
  type?: string;
  externalId?: string;
}) => {
  const actor = await db.Actor.findOne({ where: { publicId: args.id } });

  if (!actor) {
    return null;
  }

  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) {
    updates.name = args.name;
  }
  if (args.type !== undefined) {
    updates.type = args.type;
  }
  if (args.externalId !== undefined) {
    updates.externalId = args.externalId;
  }

  await actor.update(updates);

  const actorWithProject = await db.Actor.findOne({
    where: { id: actor.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  return mapActor(actorWithProject!);
};
