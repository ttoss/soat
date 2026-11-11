import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { findPolicyCarriers } from './attachedPolicies';
import type { PolicyDocument } from './iam';
import { validatePolicyActions, validatePolicyDocument } from './iam';
import { emptyPage, paginatedList } from './pagination';
import {
  assertWriterHoldsAttachedEdit,
  type GetWriterPolicies,
} from './policyGrantCoverage';
import { findAllowResourcesOutsideProject } from './policyProjectIds';
import { projectScopeWhere } from './projectScope';
import type { ResourceScope } from './resourceAccessor';

const log = createDebug('soat:policies');

const MAX_DEPENDENT_SAMPLE = 5;

type PolicyRow = InstanceType<(typeof db)['Policy']>;

/** The project a policy belongs to, or `null` for a global one. */
type PolicyProject = { id: number; publicId: string } | null;

const projectInclude = () => {
  return [{ model: db.Project, as: 'project', attributes: ['publicId'] }];
};

/**
 * A project policy grants only on its own project's resources, so attaching
 * it anywhere reaches no further than that project.
 */
const validatePolicy = (args: {
  document: PolicyDocument;
  project: PolicyProject;
}): { valid: boolean; errors: string[] } => {
  const structural = validatePolicyDocument(args.document);
  if (!structural.valid) return structural;
  const actions = validatePolicyActions(args.document);
  if (!actions.valid || !args.project) return actions;
  const projectPublicId = args.project.publicId;
  const outside = findAllowResourcesOutsideProject({
    document: args.document,
    projectPublicId,
  });
  return {
    valid: outside.length === 0,
    errors: outside.map((resource) => {
      return `Allow resource '${resource}' is outside the policy's project '${projectPublicId}'; name srn:${projectPublicId}:<type>:<id>.`;
    }),
  };
};

export const mapPolicy = (policy: PolicyRow) => {
  return {
    id: policy.publicId,
    project_id: policy.project?.publicId ?? null,
    name: policy.name,
    description: policy.description,
    document: policy.document as PolicyDocument | undefined,
    created_at: policy.createdAt,
    updated_at: policy.updatedAt,
  };
};

/**
 * `projectIds` narrows the listing to those projects' policies; `undefined`
 * lists every policy, global ones included.
 */
/**
 * The listing's `where`, or `null` when a filter matches nothing. An unknown
 * user, or one with no policies, matches nothing.
 */
const listWhere = async (args: {
  userId?: string;
  projectIds?: number[];
}): Promise<Record<string, unknown> | null> => {
  if (args.projectIds?.length === 0) return null;
  const where: Record<string, unknown> = projectScopeWhere({
    projectIds: args.projectIds,
  });
  if (args.userId !== undefined) {
    const user = await db.User.findOne({ where: { publicId: args.userId } });
    const policyIds = (user?.policyIds as number[] | undefined) ?? [];
    if (policyIds.length === 0) return null;
    where.id = policyIds;
  }
  return where;
};

export const listPolicies = async (args: {
  userId?: string;
  projectIds?: number[];
  limit?: number;
  cursor?: string;
}) => {
  log('listPolicies: projectIds=%o', args.projectIds);
  const where = await listWhere(args);
  if (where === null) return emptyPage(args);

  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: { userId: args.userId, projectIds: args.projectIds },
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
 * it: `scope` `null` is a global policy, and `null` overall names nothing.
 */
export const findPolicyScope = async (args: {
  policyId: string;
}): Promise<{ scope: ResourceScope | null } | null> => {
  const policy = await db.Policy.findOne({
    where: { publicId: args.policyId },
    include: projectInclude(),
  });
  if (!policy) return null;
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
  /** Omit for a global policy. */
  project?: { id: number; publicId: string };
}): Promise<
  ReturnType<typeof mapPolicy> | { invalid: true; errors: string[] }
> => {
  log('createPolicy: project=%s', args.project?.publicId);
  const validation = validatePolicy({
    document: args.document,
    project: args.project ?? null,
  });
  if (!validation.valid) {
    return { invalid: true, errors: validation.errors };
  }

  const policy = await db.Policy.create({
    publicId: generatePublicId(PUBLIC_ID_PREFIXES.policy),
    projectId: args.project?.id ?? null,
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
}): Promise<
  ReturnType<typeof mapPolicy> | { invalid: true; errors: string[] }
> => {
  const structural = validatePolicy({ document: args.document, project: null });
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
  const project =
    policy.projectId !== null && policy.project
      ? { id: policy.projectId, publicId: policy.project.publicId }
      : null;
  const validation = validatePolicy({ document: args.document, project });
  if (!validation.valid) {
    return { invalid: true, errors: validation.errors };
  }
  await assertWriterHoldsAttachedEdit({
    getPolicies: args.writerPolicies,
    policy: {
      id: policy.id as number,
      publicId: args.policyId,
      projectPublicId: project?.publicId ?? null,
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

  const { agents, triggers, webhooks } = await findPolicyCarriers({
    policyPublicId: args.policyId,
    limit: MAX_DEPENDENT_SAMPLE,
  });
  if (triggers.count > 0 || agents.count > 0 || webhooks.count > 0) {
    throw new DomainError(
      'POLICY_HAS_DEPENDENTS',
      `Policy '${args.policyId}' is attached to ${triggers.count} trigger(s), ${agents.count} agent(s) and ${webhooks.count} webhook(s); it cannot be deleted.`,
      {
        triggers: triggers.count,
        sample: triggers.sample,
        agents: agents.count,
        agent_sample: agents.sample,
        webhooks: webhooks.count,
        webhook_sample: webhooks.sample,
      }
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
