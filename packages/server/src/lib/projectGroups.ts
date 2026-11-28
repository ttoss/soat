import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { paginatedList } from './pagination';
import { mapProject } from './projects';
import { assertWriterHolds, type Writer } from './writerRule';

const log = createDebug('soat:project-groups');

type ProjectGroupRow = InstanceType<(typeof db)['ProjectGroup']>;

const mapProjectGroup = async (group: ProjectGroupRow) => {
  const [owner, projects] = await Promise.all([
    db.User.findByPk(group.ownerUserId, { attributes: ['publicId'] }),
    db.Project.findAll({
      where: { projectGroupId: group.id },
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

export type ProjectGroupRecord = Awaited<ReturnType<typeof mapProjectGroup>>;

export const projectGroupNotFound = (): DomainError => {
  return new DomainError('RESOURCE_NOT_FOUND', 'Project group not found');
};

/** The project group named `publicId`, or `RESOURCE_NOT_FOUND`. */
export const findProjectGroup = async (args: {
  publicId: string;
}): Promise<ProjectGroupRow> => {
  const group = await db.ProjectGroup.findOne({
    where: { publicId: args.publicId },
  });
  if (!group) throw projectGroupNotFound();
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
    carrier: 'projectGroups',
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
    attributes: ['publicId', 'projectId', 'projectGroupId'],
  });
  const scoped = rows.find((row) => {
    return row.projectId !== null || row.projectGroupId !== null;
  });
  if (scoped) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `fixed_policy_ids names only global policies; '${scoped.publicId}' belongs to a project or a project group.`,
      { field: 'fixed_policy_ids' }
    );
  }
  return policies.map((policy) => {
    return policy.publicId;
  });
};

/**
 * The owner's policies once the writer holds them: global ones, the project
 * group's own, or policies of a project in the project group.
 */
const heldPolicyIds = async (args: {
  group: ProjectGroupRow | null;
  policyIds: unknown;
  writer: Writer;
}): Promise<string[]> => {
  const policies = await assertWriterHolds({
    carrier: 'projectGroups',
    writer: args.writer,
    projectId: null,
    projectGroupId: args.group?.id ?? null,
    carried: { policyIds: args.policyIds as string[] | undefined },
  });
  // A project group being created has no projects yet.
  const outside =
    args.group === null &&
    (await db.Policy.findOne({
      where: {
        id: policies.map((policy) => {
          return policy.id;
        }),
        projectId: { [Op.ne]: null },
      },
      attributes: ['publicId'],
    }));
  if (outside) {
    throw new DomainError(
      'POLICY_OUTSIDE_PROJECT',
      `Policy '${outside.publicId}' belongs to a project outside the project group.`,
      { policy_id: outside.publicId }
    );
  }
  return policies.map((policy) => {
    return policy.publicId;
  });
};

export const createProjectGroup = async (args: {
  name: unknown;
  ownerId: unknown;
  policyIds: unknown;
  fixedPolicyIds: unknown;
  writer: Writer;
}): Promise<ProjectGroupRecord> => {
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
  const group = await db.ProjectGroup.create({
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
  log('createProjectGroup: %s owner=%s', group.publicId, owner.publicId);
  return mapProjectGroup(group);
};

export const getProjectGroup = async (args: {
  publicId: string;
}): Promise<ProjectGroupRecord> => {
  return mapProjectGroup(await findProjectGroup(args));
};

/** Every group, or the project groups `ownerUserId` owns. */
export const listProjectGroups = async (args: {
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
      return db.ProjectGroup.findAll({ where: pageWhere, order, limit });
    },
    map: mapProjectGroup,
  });
};

/**
 * Writes what the body names: `fixedPolicyIds` only when the caller is the
 * operator, which the route decides.
 */
export const updateProjectGroup = async (args: {
  group: ProjectGroupRow;
  name?: unknown;
  policyIds?: unknown;
  fixedPolicyIds?: unknown;
  writer: Writer;
}): Promise<ProjectGroupRecord> => {
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
  return mapProjectGroup(args.group);
};

/** Deletes a project group holding no project. */
export const deleteProjectGroup = async (args: {
  group: ProjectGroupRow;
}): Promise<void> => {
  const projects = await db.Project.count({
    where: { projectGroupId: args.group.id },
  });
  if (projects > 0) {
    throw new DomainError(
      'PROJECT_GROUP_HAS_PROJECTS',
      'The project group holds projects.',
      {
        projects,
      }
    );
  }
  await args.group.destroy();
};

const findProject = async (publicId: string) => {
  const project = await db.Project.findOne({ where: { publicId } });
  if (!project)
    throw new DomainError('RESOURCE_NOT_FOUND', 'Project not found');
  return project;
};

/** Creates a project in the project group. */
export const createProjectGroupProject = async (args: {
  group: ProjectGroupRow;
  name: unknown;
}) => {
  const project = await db.Project.create({
    name: requireName(args.name),
    projectGroupId: args.group.id,
  });
  return mapProject(project);
};

/** Puts a project in the project group, out of any other it was in. */
export const addProjectGroupProject = async (args: {
  group: ProjectGroupRow;
  projectPublicId: string;
}): Promise<void> => {
  const project = await findProject(args.projectPublicId);
  await project.update({ projectGroupId: args.group.id });
};

/** Takes a project of the project group out of it. */
export const removeProjectGroupProject = async (args: {
  group: ProjectGroupRow;
  projectPublicId: string;
}): Promise<void> => {
  const project = await findProject(args.projectPublicId);
  if (project.projectGroupId !== args.group.id) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      'Project not found in project group'
    );
  }
  await project.update({ projectGroupId: null });
};
