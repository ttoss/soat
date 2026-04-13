import { Op } from '@ttoss/postgresdb';

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
    tags: actor.tags ?? undefined,
    createdAt: actor.createdAt,
    updatedAt: actor.updatedAt,
  };
};

export const listActors = async (args: {
  projectIds?: number[];
  externalId?: string;
  name?: string;
  type?: string;
  limit?: number;
  offset?: number;
}) => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return { data: [], total: 0, limit, offset };
  }

  const where: Record<string, unknown> = {};

  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  if (args.externalId !== undefined) {
    where.externalId = args.externalId;
  }

  if (args.name !== undefined) {
    where.name = { [Op.iLike]: `%${args.name}%` };
  }

  if (args.type !== undefined) {
    where.type = args.type;
  }

  const { count, rows } = await db.Actor.findAndCountAll({
    where: Object.keys(where).length > 0 ? where : undefined,
    include: [{ model: db.Project, as: 'project' }],
    limit,
    offset,
  });

  return { data: rows.map(mapActor), total: count, limit, offset };
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

export const getActorTags = async (args: { id: string }) => {
  const actor = await db.Actor.findOne({ where: { publicId: args.id } });

  if (!actor) {
    return null;
  }

  return actor.tags ?? {};
};

export const updateActorTags = async (args: {
  id: string;
  tags: Record<string, string>;
  merge?: boolean;
}) => {
  const actor = await db.Actor.findOne({ where: { publicId: args.id } });

  if (!actor) {
    return null;
  }

  const newTags = args.merge
    ? { ...(actor.tags ?? {}), ...args.tags }
    : args.tags;
  await actor.update({ tags: newTags });

  const actorWithProject = await db.Actor.findOne({
    where: { id: actor.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  return mapActor(actorWithProject!);
};
