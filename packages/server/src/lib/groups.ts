import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { paginatedList } from './pagination';
import { mapProject } from './projects';
import { assertWriterHolds, type Writer } from './writerRule';

const log = createDebug('soat:groups');

type GroupRow = InstanceType<(typeof db)['Group']>;

const mapGroup = async (group: GroupRow) => {
  const [owner, projects] = await Promise.all([
    db.User.findByPk(group.ownerUserId, { attributes: ['publicId'] }),
    db.Project.findAll({
      where: { groupId: group.id },
      attributes: ['publicId'],
      order: [['id', 'ASC']],
    }),
  ]);
  return {
    id: group.publicId,
    name: group.name,
    owner_id: owner?.publicId ?? null,
    policy_ids: group.policyIds,
    fixed_policy_ids: group.fixedPolicyIds,
    project_ids: projects.map((project) => {
      return project.publicId;
    }),
    created_at: group.createdAt,
    updated_at: group.updatedAt,
  };
};

export type GroupRecord = Awaited<ReturnType<typeof mapGroup>>;

const notFound = (): DomainError => {
  return new DomainError('RESOURCE_NOT_FOUND', 'Group not found');
};

/** The group named `publicId`, or `RESOURCE_NOT_FOUND`. */
export const findGroup = async (args: {
  publicId: string;
}): Promise<GroupRow> => {
  const group = await db.Group.findOne({ where: { publicId: args.publicId } });
  if (!group) throw notFound();
  return group;
};

const requireName = (name: unknown): string => {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new DomainError('VALIDATION_FAILED', 'name is required', {
      field: 'name',
    });
  }
  return name;
};

/**
 * The fixed policies stored as written once the writer holds them: global
 * ones only, so nobody but the operator edits them.
 */
const heldFixedPolicyIds = async (args: {
  fixedPolicyIds: unknown;
  writer: Writer;
}): Promise<string[]> => {
  const policies = await assertWriterHolds({
    carrier: 'groups',
    writer: args.writer,
    projectId: null,
    carried: { policyIds: args.fixedPolicyIds as string[] | undefined },
  });
  const rows = await db.Policy.findAll({
    where: {
      id: policies.map((policy) => {
        return policy.id;
      }),
    },
    attributes: ['publicId', 'projectId'],
  });
  const scoped = rows.find((row) => {
    return row.projectId !== null;
  });
  if (scoped) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `fixed_policy_ids names only global policies; '${scoped.publicId}' belongs to a project.`,
      { field: 'fixed_policy_ids' }
    );
  }
  return policies.map((policy) => {
    return policy.publicId;
  });
};

/**
 * The owner's policies once the writer holds them: global ones, or policies
 * of a project in the group.
 */
const heldPolicyIds = async (args: {
  group: GroupRow | null;
  policyIds: unknown;
  writer: Writer;
}): Promise<string[]> => {
  const policies = await assertWriterHolds({
    carrier: 'groups',
    writer: args.writer,
    projectId: null,
    carried: { policyIds: args.policyIds as string[] | undefined },
  });
  const rows = await db.Policy.findAll({
    where: {
      id: policies.map((policy) => {
        return policy.id;
      }),
    },
    attributes: ['publicId', 'projectId'],
    include: [{ model: db.Project, as: 'project', attributes: ['groupId'] }],
  });
  const outside = rows.find((row) => {
    return (
      row.projectId !== null &&
      (args.group === null || row.project?.groupId !== args.group.id)
    );
  });
  if (outside) {
    throw new DomainError(
      'POLICY_OUTSIDE_PROJECT',
      `Policy '${outside.publicId}' belongs to a project outside the group.`,
      { policy_id: outside.publicId }
    );
  }
  return policies.map((policy) => {
    return policy.publicId;
  });
};

export const createGroup = async (args: {
  name: unknown;
  ownerId: unknown;
  policyIds: unknown;
  fixedPolicyIds: unknown;
  writer: Writer;
}): Promise<GroupRecord> => {
  const name = requireName(args.name);
  const owner =
    typeof args.ownerId === 'string'
      ? await db.User.findOne({ where: { publicId: args.ownerId } })
      : null;
  if (!owner) {
    throw new DomainError('VALIDATION_FAILED', 'owner_id must name a user', {
      field: 'owner_id',
    });
  }
  const group = await db.Group.create({
    name,
    ownerUserId: owner.id,
    policyIds: await heldPolicyIds({
      group: null,
      policyIds: args.policyIds,
      writer: args.writer,
    }),
    fixedPolicyIds: await heldFixedPolicyIds({
      fixedPolicyIds: args.fixedPolicyIds,
      writer: args.writer,
    }),
  });
  log('createGroup: %s owner=%s', group.publicId, owner.publicId);
  return mapGroup(group);
};

export const getGroup = async (args: {
  publicId: string;
}): Promise<GroupRecord> => {
  return mapGroup(await findGroup(args));
};

/** Every group, or the groups `ownerUserId` owns. */
export const listGroups = async (args: {
  ownerUserId?: number;
  limit?: number;
  cursor?: string;
}) => {
  const where =
    args.ownerUserId === undefined
      ? undefined
      : { ownerUserId: args.ownerUserId };
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: { ownerUserId: args.ownerUserId },
    where,
    order: [['createdAt', 'DESC']],
    query: ({ where: pageWhere, limit, order }) => {
      return db.Group.findAll({ where: pageWhere, order, limit });
    },
    map: mapGroup,
  });
};

/**
 * Writes what the body names: `fixedPolicyIds` only when the caller is the
 * operator, which the route decides.
 */
export const updateGroup = async (args: {
  group: GroupRow;
  name?: unknown;
  policyIds?: unknown;
  fixedPolicyIds?: unknown;
  writer: Writer;
}): Promise<GroupRecord> => {
  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) updates.name = requireName(args.name);
  if (args.policyIds !== undefined) {
    updates.policyIds = await heldPolicyIds({
      group: args.group,
      policyIds: args.policyIds,
      writer: args.writer,
    });
  }
  if (args.fixedPolicyIds !== undefined) {
    updates.fixedPolicyIds = await heldFixedPolicyIds({
      fixedPolicyIds: args.fixedPolicyIds,
      writer: args.writer,
    });
  }
  await args.group.update(updates);
  return mapGroup(args.group);
};

/** Deletes a group holding no project. */
export const deleteGroup = async (args: { group: GroupRow }): Promise<void> => {
  const projects = await db.Project.count({
    where: { groupId: args.group.id },
  });
  if (projects > 0) {
    throw new DomainError('GROUP_HAS_PROJECTS', 'The group holds projects.', {
      projects,
    });
  }
  await args.group.destroy();
};

const findProject = async (publicId: string) => {
  const project = await db.Project.findOne({ where: { publicId } });
  if (!project)
    throw new DomainError('RESOURCE_NOT_FOUND', 'Project not found');
  return project;
};

/** Creates a project in the group. */
export const createGroupProject = async (args: {
  group: GroupRow;
  name: unknown;
}) => {
  const project = await db.Project.create({
    name: requireName(args.name),
    groupId: args.group.id,
  });
  return mapProject(project);
};

/** Puts a project in the group, out of any other it was in. */
export const addGroupProject = async (args: {
  group: GroupRow;
  projectPublicId: string;
}): Promise<void> => {
  const project = await findProject(args.projectPublicId);
  await project.update({ groupId: args.group.id });
};

/** Takes a project of the group out of it. */
export const removeGroupProject = async (args: {
  group: GroupRow;
  projectPublicId: string;
}): Promise<void> => {
  const project = await findProject(args.projectPublicId);
  if (project.groupId !== args.group.id) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Project not found in group');
  }
  await project.update({ groupId: null });
};
