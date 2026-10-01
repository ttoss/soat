/**
 * Shares: a project's grant of actions on one of its resources to another
 * project. The record and its reads live here; the accept / suspend / revoke
 * lifecycle is `shareLifecycle.ts`.
 */
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { buildSrn } from './iam';
import type { ResourceIncludes } from './modelIncludes';
import { paginatedList } from './pagination';
import { makeResourceAccessor, type ResourceScope } from './resourceAccessor';
import { findShareableType, type ShareProjection } from './shareableTypes';
import { parseShareCap } from './shareCapShape';

const log = createDebug('soat:shares');

/** The grantee that offers a share to every project. */
export const PUBLIC_GRANTEE = '*';

type ProjectRow = InstanceType<(typeof db)['Project']>;

export type ShareRow = InstanceType<(typeof db)['Share']> & {
  project?: ProjectRow;
};

export type ShareAcceptanceRow = InstanceType<
  (typeof db)['ShareAcceptance']
> & {
  project?: ProjectRow;
  share?: ShareRow;
};

export const shares = makeResourceAccessor<ShareRow>({
  model: () => {
    return db.Share;
  },
  includes: () => {
    return [{ model: db.Project, as: 'project' }];
  },
  label: 'Share',
});

export const shareResourceSrn = (share: ShareRow): string => {
  return buildSrn({
    projectPublicId: share.project?.publicId ?? '',
    resourceType: share.resourceType,
    resourceId: share.resourceId,
  });
};

export const mapShareAcceptance = (acceptance: ShareAcceptanceRow) => {
  return {
    id: acceptance.publicId,
    share_id: acceptance.share?.publicId,
    project_id: acceptance.project?.publicId,
    status: acceptance.status,
    revoked_by: acceptance.revokedBy,
    accepted_at: acceptance.acceptedAt,
    revoked_at: acceptance.revokedAt,
    created_at: acceptance.createdAt,
    updated_at: acceptance.updatedAt,
  };
};

export type MappedShareAcceptance = ReturnType<typeof mapShareAcceptance>;

/**
 * `acceptance` is set only on a grantee's read, where it is that project's
 * own row or `null`; `projection` only on a single-share read.
 */
export const mapShare = (
  share: ShareRow,
  extras: {
    acceptance?: ShareAcceptanceRow | null;
    projection?: ShareProjection | null;
  } = {}
) => {
  return {
    id: share.publicId,
    project_id: share.project?.publicId,
    resource: shareResourceSrn(share),
    actions: share.actions,
    grantee: share.grantee,
    cap: share.cap ?? null,
    suspended_at: share.suspendedAt,
    revoked_at: share.revokedAt,
    ...(extras.acceptance === undefined
      ? {}
      : {
          acceptance: extras.acceptance
            ? mapShareAcceptance(extras.acceptance)
            : null,
        }),
    ...(extras.projection === undefined
      ? {}
      : { projection: extras.projection }),
    created_at: share.createdAt,
    updated_at: share.updatedAt,
  };
};

export type MappedShare = ReturnType<typeof mapShare>;

export const acceptanceIncludes = (): ResourceIncludes => {
  return [
    { model: db.Project, as: 'project' },
    {
      model: db.Share,
      as: 'share',
      include: [{ model: db.Project, as: 'project' }],
    },
  ];
};

/** Whether `projectPublicId` may accept the share at all. */
export const isShareAddressedTo = (args: {
  share: ShareRow;
  projectPublicId: string;
}): boolean => {
  return (
    args.share.project?.publicId !== args.projectPublicId &&
    (args.share.grantee === PUBLIC_GRANTEE ||
      args.share.grantee === args.projectPublicId)
  );
};

const invalid = (message: string, field: string): DomainError => {
  return new DomainError('VALIDATION_FAILED', message, { field });
};

/**
 * `resource` is one concrete SRN in the publisher's own project. A wildcard
 * would grant resources that do not exist yet, so none is accepted.
 */
const parseShareResource = (args: {
  resource: string;
  projectPublicId: string;
}): { resourceType: string; resourceId: string } => {
  const parts = args.resource.split(':');
  if (parts.length !== 4 || parts[0] !== 'srn' || parts.includes('*')) {
    throw invalid(
      `resource '${args.resource}' must be one resource SRN, srn:<project_id>:<type>:<id>, with no wildcard.`,
      'resource'
    );
  }
  const [, projectPublicId, resourceType, resourceId] = parts;
  if (projectPublicId !== args.projectPublicId) {
    throw invalid(
      `resource '${args.resource}' is not in project '${args.projectPublicId}': a project shares only its own resources.`,
      'resource'
    );
  }
  return { resourceType, resourceId };
};

const assertGrantee = (args: {
  grantee: string;
  projectPublicId: string;
}): void => {
  if (args.grantee === PUBLIC_GRANTEE) {
    if (process.env.SHARES_ALLOW_PUBLIC !== 'true') {
      throw new DomainError(
        'PUBLIC_SHARES_DISABLED',
        'Public shares (grantee "*") are disabled on this deployment.'
      );
    }
    return;
  }
  if (!/^proj_[A-Za-z0-9]+$/.test(args.grantee)) {
    throw invalid(
      `grantee '${args.grantee}' must be a project id or "*".`,
      'grantee'
    );
  }
  if (args.grantee === args.projectPublicId) {
    throw invalid('A project cannot share a resource with itself.', 'grantee');
  }
};

export const createShare = async (args: {
  projectId: number;
  projectPublicId: string;
  resource: string;
  actions: string[];
  grantee: string;
  cap?: unknown;
}): Promise<MappedShare> => {
  const { resourceType, resourceId } = parseShareResource(args);
  const cap = args.cap === undefined ? null : parseShareCap(args.cap);
  const shareable = findShareableType(resourceType);
  if (!shareable) {
    throw invalid(
      `Resource type '${resourceType}' cannot be shared.`,
      'resource'
    );
  }
  const refused = args.actions.filter((action) => {
    return !shareable.actions.includes(action);
  });
  if (args.actions.length === 0 || refused.length > 0) {
    throw invalid(
      `A ${resourceType} share grants only ${shareable.actions.join(', ')}; refused: ${refused.join(', ') || '(none given)'}.`,
      'actions'
    );
  }
  assertGrantee(args);

  const projection = await shareable.findProjection({
    projectId: args.projectId,
    id: resourceId,
  });
  if (!projection) {
    throw new DomainError(
      shareable.notFoundCode,
      `${resourceType} '${resourceId}' does not exist in project '${args.projectPublicId}'.`
    );
  }

  const share = await db.Share.create({
    projectId: args.projectId,
    resourceType,
    resourceId,
    actions: [...new Set(args.actions)],
    grantee: args.grantee,
    cap,
  });
  log('createShare: id=%s resource=%s', share.publicId, args.resource);
  return mapShare(await shares.reload(share), { projection });
};

/** The publisher changing a share's `cap`; the next call reads the new one. */
export const updateShare = async (args: {
  id: string;
  cap: unknown;
}): Promise<MappedShare> => {
  log('updateShare: id=%s', args.id);
  const share = await shares.getByPublicId({ id: args.id });
  if (args.cap !== undefined) {
    await share.update({ cap: parseShareCap(args.cap) });
  }
  return mapShare(await shares.reload(share));
};

const findProjection = async (
  share: ShareRow
): Promise<ShareProjection | null> => {
  const shareable = findShareableType(share.resourceType);
  if (!shareable) return null;
  return shareable.findProjection({
    projectId: share.projectId,
    id: share.resourceId,
  });
};

/**
 * Where a grantee's call on a share authorizes: the grantee's own project,
 * since that is the project the caller acts for. `null` when the share does
 * not exist or is not addressed to that project, which reads as absent.
 */
export const findGranteeScope = async (args: {
  shareId: string;
  projectPublicId: string;
}): Promise<ResourceScope | null> => {
  const share = await shares.findByPublicId({ id: args.shareId });
  if (!share || !isShareAddressedTo({ share, ...args })) return null;
  const project = await db.Project.findOne({
    where: { publicId: args.projectPublicId },
    attributes: ['id', 'publicId'],
  });
  if (!project) return null;
  return {
    projectId: project.id as number,
    projectPublicId: project.publicId,
    tags: null,
  };
};

/** The acceptance `projectId` holds for `shareId`, if any. */
export const findOwnAcceptance = async (args: {
  shareId: number;
  projectId: number;
}): Promise<ShareAcceptanceRow | null> => {
  return (await db.ShareAcceptance.findOne({
    where: { shareId: args.shareId, projectId: args.projectId },
    include: acceptanceIncludes(),
  })) as ShareAcceptanceRow | null;
};

/**
 * One share, as its publisher sees it — or, with `granteeProjectId`, as that
 * grantee sees it: the same record plus the grantee's own acceptance.
 */
export const getShare = async (args: {
  id: string;
  granteeProjectId?: number;
}): Promise<MappedShare> => {
  const share = await shares.getByPublicId({ id: args.id });
  const acceptance =
    args.granteeProjectId === undefined
      ? undefined
      : await findOwnAcceptance({
          shareId: share.id as number,
          projectId: args.granteeProjectId,
        });
  return mapShare(share, {
    acceptance,
    projection: await findProjection(share),
  });
};

export const listPublishedShares = async (args: {
  projectIds: number[];
  resource?: string;
  limit?: number;
  offset?: number;
}) => {
  const where: Record<string, unknown> = { projectId: args.projectIds };
  // The scope already confines the project, so the SRN's type and id are all
  // the filter reads; a malformed one matches nothing.
  if (args.resource) {
    const [, , resourceType, resourceId] = args.resource.split(':');
    where.resourceType = resourceType ?? '';
    where.resourceId = resourceId ?? '';
  }
  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['createdAt', 'ASC']],
    query: ({ limit, offset, order }) => {
      return db.Share.findAndCountAll({
        where,
        include: [{ model: db.Project, as: 'project' }],
        distinct: true,
        order,
        limit,
        offset,
      });
    },
    map: (row) => {
      return mapShare(row as ShareRow);
    },
  });
};

/**
 * The shares addressed to one project, and the public ones it has accepted.
 * A public share it never accepted is not listed: discovering offers is the
 * platform's job, not a cross-project read.
 */
export const listReceivedShares = async (args: {
  projectId: number;
  projectPublicId: string;
  limit?: number;
  offset?: number;
}) => {
  const accepted = await db.ShareAcceptance.findAll({
    where: { projectId: args.projectId },
    include: acceptanceIncludes(),
  });
  const acceptanceByShare = new Map(
    (accepted as ShareAcceptanceRow[]).map((row) => {
      return [row.shareId, row];
    })
  );
  const page = await paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['createdAt', 'ASC']],
    query: ({ limit, offset, order }) => {
      return db.Share.findAndCountAll({
        where: {
          projectId: { [Op.ne]: args.projectId },
          [Op.or]: [
            { grantee: args.projectPublicId },
            { id: [...acceptanceByShare.keys()] },
          ],
        },
        include: [{ model: db.Project, as: 'project' }],
        distinct: true,
        order,
        limit,
        offset,
      });
    },
    map: (row) => {
      return row as ShareRow;
    },
  });
  return {
    ...page,
    data: page.data.map((share) => {
      return mapShare(share, {
        acceptance: acceptanceByShare.get(share.id as number) ?? null,
      });
    }),
  };
};

export const listShareAcceptances = async (args: {
  shareId: string;
  status?: 'active' | 'revoked';
  limit?: number;
  offset?: number;
}) => {
  const share = await shares.getByPublicId({ id: args.shareId });
  const where: Record<string, unknown> = { shareId: share.id };
  if (args.status) where.status = args.status;
  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['createdAt', 'ASC']],
    query: ({ limit, offset, order }) => {
      return db.ShareAcceptance.findAndCountAll({
        where,
        include: acceptanceIncludes(),
        distinct: true,
        order,
        limit,
        offset,
      });
    },
    map: (row) => {
      return mapShareAcceptance(row as ShareAcceptanceRow);
    },
  });
};
