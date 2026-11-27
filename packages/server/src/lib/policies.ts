import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { PolicyDocument } from './iam';
import { validatePolicyActions, validatePolicyDocument } from './iam';
import { emptyPage, paginatedList } from './pagination';
import { findPolicyDependents } from './policyCarriers';
import { assertMayWriteDenial } from './policyDenial';
import {
  assertWriterHoldsAttachedEdit,
  type GetWriterPolicies,
} from './policyGrantCoverage';
import {
  loadPolicyProjectGroups,
  validateProjectGroupPolicyDocument,
} from './projectGroupPolicies';
import { validateProjectPolicyDocument } from './projectPolicyValidation';
import { projectScopeWhere } from './projectScope';
import type { ResourceScope } from './resourceAccessor';

const log = createDebug('soat:policies');

const MAX_DEPENDENT_SAMPLE = 5;

type PolicyRow = InstanceType<(typeof db)['Policy']>;

/** The project a policy belongs to, or `null` for a global one. */
type PolicyProject = { id: number; publicId: string } | null;

/** A project group's database and public ids. */
type PolicyGroupRef = { id: number; publicId: string };

const projectInclude = () => {
  return [
    { model: db.Project, as: 'project', attributes: ['publicId'] },
    { model: db.ProjectGroup, as: 'projectGroup', attributes: ['publicId'] },
  ];
};

/**
 * A project policy grants only on its own project's resources, and a project
 * group policy only on its project group's and its projects', so attaching
 * either anywhere reaches no further.
 */
const validatePolicy = async (args: {
  document: PolicyDocument;
  project: PolicyProject;
  projectGroup: PolicyGroupRef | null;
}): Promise<{ valid: boolean; errors: string[] }> => {
  if (args.projectGroup) {
    const groups = await loadPolicyProjectGroups([args.projectGroup.id]);
    const errors = validateProjectGroupPolicyDocument({
      document: args.document,
      projectGroup: groups.get(args.projectGroup.id) ?? {
        publicId: args.projectGroup.publicId,
        projectPublicIds: [],
      },
    });
    return { valid: errors.length === 0, errors };
  }
  if (args.project) {
    const errors = validateProjectPolicyDocument({
      document: args.document,
      projectPublicId: args.project.publicId,
    });
    return { valid: errors.length === 0, errors };
  }
  const structural = validatePolicyDocument(args.document);
  if (!structural.valid) return structural;
  return validatePolicyActions(args.document);
};

/** The project or project group a stored policy belongs to. */
const ownerOf = (
  policy: PolicyRow
): { project: PolicyProject; projectGroup: PolicyGroupRef | null } => {
  return {
    project:
      policy.projectId !== null && policy.project
        ? { id: policy.projectId, publicId: policy.project.publicId }
        : null,
    projectGroup:
      policy.projectGroupId !== null && policy.projectGroup
        ? { id: policy.projectGroupId, publicId: policy.projectGroup.publicId }
        : null,
  };
};

export const mapPolicy = (policy: PolicyRow) => {
  return {
    id: policy.publicId,
    project_id: policy.project?.publicId ?? null,
    project_group_id: policy.projectGroup?.publicId ?? null,
    name: policy.name,
    description: policy.description,
    document: policy.document as PolicyDocument | undefined,
    created_at: policy.createdAt,
    updated_at: policy.updatedAt,
  };
};

/**
 * The listing's `where`, or `null` when a filter matches nothing. An unknown
 * user, or one with no policies, matches nothing. `projectIds` narrows it to
 * those projects' policies and `projectGroupId` to that project group's;
 * neither lists every policy.
 */
const listWhere = async (args: {
  userId?: string;
  projectIds?: number[];
  projectGroupId?: number;
}): Promise<Record<string, unknown> | null> => {
  if (args.projectIds?.length === 0) return null;
  const where: Record<string, unknown> =
    args.projectGroupId === undefined
      ? projectScopeWhere({ projectIds: args.projectIds })
      : { projectGroupId: args.projectGroupId };
  if (args.userId !== undefined) {
    const user = await db.User.findOne({ where: { publicId: args.userId } });
    const policyIds = user?.policyIds ?? [];
    if (policyIds.length === 0) return null;
    where.publicId = policyIds;
  }
  return where;
};

export const listPolicies = async (args: {
  userId?: string;
  projectIds?: number[];
  projectGroupId?: number;
  limit?: number;
  cursor?: string;
}) => {
  log('listPolicies: projectIds=%o', args.projectIds);
  const where = await listWhere(args);
  if (where === null) return emptyPage(args);

  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: {
      userId: args.userId,
      projectIds: args.projectIds,
      projectGroupId: args.projectGroupId,
    },
    where: Object.keys(where).length > 0 ? where : undefined,
    order: [['createdAt', 'ASC']],
    query: ({ where: pageWhere, limit, order }) => {
      return db.Policy.findAll({
        where: pageWhere,
        order,
        limit,
        include: projectInclude(),
      });
    },
    map: (p: PolicyRow) => {
      return mapPolicy(p);
    },
  });
};

/**
 * Where a policy lives, for the route to authorize against before acting on
 * it: a project group's, a project's (`scope`), or global (`scope` `null`);
 * `null` overall names nothing.
 */
export const findPolicyScope = async (args: {
  policyId: string;
}): Promise<
  { scope: ResourceScope | null } | { projectGroupPublicId: string } | null
> => {
  const policy = await db.Policy.findOne({
    where: { publicId: args.policyId },
    include: projectInclude(),
  });
  if (!policy) return null;
  if (policy.projectGroup) {
    return { projectGroupPublicId: policy.projectGroup.publicId };
  }
  if (policy.projectId === null || !policy.project) return { scope: null };
  return {
    scope: {
      projectId: policy.projectId,
      projectPublicId: policy.project.publicId,
      tags: null,
    },
  };
};

export const createPolicy = async (args: {
  name?: string;
  description?: string;
  document: PolicyDocument;
  /** Omit with `projectGroup` for a global policy. */
  project?: { id: number; publicId: string };
  /** The project group a project group policy belongs to; never with `project`. */
  projectGroup?: PolicyGroupRef;
  /** Whether the writer may write a statement `denial`. */
  writerUnrestricted: boolean;
}): Promise<
  ReturnType<typeof mapPolicy> | { invalid: true; errors: string[] }
> => {
  const owner = {
    project: args.project ?? null,
    projectGroup: args.projectGroup ?? null,
  };
  log('createPolicy: owner=%o', owner);
  assertMayWriteDenial(args);
  const validation = await validatePolicy({
    document: args.document,
    ...owner,
  });
  if (!validation.valid) {
    return { invalid: true, errors: validation.errors };
  }

  const policy = await db.Policy.create({
    publicId: generatePublicId(PUBLIC_ID_PREFIXES.policy),
    projectId: owner.project?.id ?? null,
    projectGroupId: owner.projectGroup?.id ?? null,
    name: args.name ?? null,
    description: args.description ?? null,
    document: args.document as object,
  });
  await policy.reload({ include: projectInclude() });

  return mapPolicy(policy);
};

export const updatePolicy = async (args: {
  policyId: string;
  name?: string;
  description?: string;
  document: PolicyDocument;
  /** The writer's policy sets, which must hold the edit where it is attached. */
  writerPolicies: GetWriterPolicies;
  /** Whether the writer may write a statement `denial`. */
  writerUnrestricted: boolean;
}): Promise<
  ReturnType<typeof mapPolicy> | { invalid: true; errors: string[] }
> => {
  assertMayWriteDenial(args);
  const structural = await validatePolicy({
    document: args.document,
    project: null,
    projectGroup: null,
  });
  if (!structural.valid) {
    return { invalid: true, errors: structural.errors };
  }

  const policy = await db.Policy.findOne({
    where: { publicId: args.policyId },
    include: projectInclude(),
  });
  if (!policy) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Policy '${args.policyId}' not found.`
    );
  }
  const owner = ownerOf(policy);
  const validation = await validatePolicy({
    document: args.document,
    ...owner,
  });
  if (!validation.valid) {
    return { invalid: true, errors: validation.errors };
  }
  await assertWriterHoldsAttachedEdit({
    getPolicies: args.writerPolicies,
    policy: {
      id: policy.id as number,
      publicId: args.policyId,
      projectPublicId: owner.project?.publicId ?? null,
      projectGroupId: owner.projectGroup?.id ?? null,
    },
    document: args.document,
  });

  await policy.update({
    name: args.name ?? policy.name,
    description: args.description ?? policy.description,
    document: args.document as object,
  });

  return mapPolicy(policy);
};

export const deletePolicy = async (args: {
  policyId: string;
}): Promise<void> => {
  const policy = await db.Policy.findOne({
    where: { publicId: args.policyId },
  });
  if (!policy) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Policy '${args.policyId}' not found.`
    );
  }

  const dependents = await findPolicyDependents({
    policyPublicId: args.policyId,
    limit: MAX_DEPENDENT_SAMPLE,
  });
  if (
    dependents.some((dependent) => {
      return dependent.count > 0;
    })
  ) {
    const counts = dependents.map((dependent) => {
      return `${dependent.count} ${dependent.noun}(s)`;
    });
    throw new DomainError(
      'POLICY_HAS_DEPENDENTS',
      `Policy '${args.policyId}' is attached to ${counts.join(', ')}; it cannot be deleted.`,
      Object.fromEntries(
        dependents.flatMap((dependent) => {
          return [
            [dependent.meta.count, dependent.count],
            [dependent.meta.sample, dependent.sample],
          ];
        })
      )
    );
  }

  await policy.destroy();
};

export const getPolicy = async (args: { policyId: string }) => {
  const policy = await db.Policy.findOne({
    where: { publicId: args.policyId },
    include: projectInclude(),
  });
  if (!policy) {
    return null;
  }

  return mapPolicy(policy);
};
