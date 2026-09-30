/**
 * What happens to a share after it is created: a grantee accepts it, the
 * publisher suspends, resumes or revokes it, either side revokes an
 * acceptance.
 *
 * Suspend is reversible and keeps every acceptance; revoke is terminal. Every
 * publisher-side change that reaches a consumer writes a `share_*` activity
 * entry in that consumer's project, so a consumer learns why a resource it
 * accepted stopped answering.
 */
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { type ActivityKind, emitActivityEntry } from './activity';
import {
  acceptanceIncludes,
  findOwnAcceptance,
  getShare,
  type MappedShare,
  type MappedShareAcceptance,
  mapShareAcceptance,
  type ShareAcceptanceRow,
  shareResourceSrn,
  type ShareRow,
  shares,
} from './shares';
import { isUniqueViolation } from './uniqueViolation';

const log = createDebug('soat:shares');

type ShareKind = Extract<
  ActivityKind,
  'share_resumed' | 'share_revoked' | 'share_suspended'
>;

const VERB: Record<ShareKind, string> = {
  share_resumed: 'resumed',
  share_revoked: 'revoked',
  share_suspended: 'suspended',
};

const notifyConsumers = async (args: {
  share: ShareRow;
  kind: ShareKind;
  consumerProjectIds: number[];
}): Promise<void> => {
  const resource = shareResourceSrn(args.share);
  const publisherProjectId = args.share.project?.publicId ?? null;
  await Promise.all(
    args.consumerProjectIds.map((projectId) => {
      return emitActivityEntry({
        projectId,
        kind: args.kind,
        summary: `Share ${args.share.publicId} of ${resource} ${VERB[args.kind]} by project ${publisherProjectId ?? '(unknown)'}`,
        detail: { shareId: args.share.publicId, resource, publisherProjectId },
        refId: args.share.publicId,
      });
    })
  );
};

const activeConsumerProjectIds = async (shareId: number): Promise<number[]> => {
  const rows = await db.ShareAcceptance.findAll({
    where: { shareId, status: 'active' },
    attributes: ['projectId'],
  });
  return rows.map((row) => {
    return row.projectId;
  });
};

const shareRevoked = (share: ShareRow): DomainError => {
  return new DomainError(
    'SHARE_REVOKED',
    `Share '${share.publicId}' has been revoked by its publisher.`
  );
};

const acceptanceNotFound = (id: string): DomainError => {
  return new DomainError(
    'RESOURCE_NOT_FOUND',
    `Share acceptance '${id}' not found.`
  );
};

const reloadAcceptance = async (id: number): Promise<MappedShareAcceptance> => {
  const row = (await db.ShareAcceptance.findOne({
    where: { id },
    include: acceptanceIncludes(),
  })) as ShareAcceptanceRow;
  return mapShareAcceptance(row);
};

/**
 * Accepting is idempotent. A project that revoked its own acceptance may accept
 * again; one whose acceptance the publisher revoked may not until the publisher
 * deletes that acceptance. Accepting a suspended share records the acceptance,
 * which grants nothing until the share is resumed.
 */
export const acceptShare = async (args: {
  id: string;
  projectId: number;
}): Promise<MappedShareAcceptance> => {
  const share = await shares.getByPublicId({ id: args.id });
  if (share.revokedAt) throw shareRevoked(share);

  const existing = await findOwnAcceptance({
    shareId: share.id as number,
    projectId: args.projectId,
  });
  if (existing?.revokedBy === 'publisher') {
    throw new DomainError(
      'SHARE_REVOKED',
      `The publisher of share '${share.publicId}' revoked this project's acceptance.`
    );
  }
  if (existing) {
    if (existing.status === 'revoked') {
      await existing.update({
        status: 'active',
        revokedBy: null,
        revokedAt: null,
        acceptedAt: new Date(),
      });
    }
    return reloadAcceptance(existing.id as number);
  }

  try {
    const created = await db.ShareAcceptance.create({
      shareId: share.id,
      projectId: args.projectId,
      acceptedAt: new Date(),
    });
    log('acceptShare: share=%s acceptance=%s', args.id, created.publicId);
    return reloadAcceptance(created.id as number);
  } catch (error) {
    // A concurrent accept from the same project wrote the row first.
    if (!isUniqueViolation(error)) throw error;
    return acceptShare(args);
  }
};

const setSuspended = async (args: {
  id: string;
  suspended: boolean;
}): Promise<MappedShare> => {
  const share = await shares.getByPublicId({ id: args.id });
  if (share.revokedAt) throw shareRevoked(share);

  // Conditional on the current state, so a repeated or racing call changes
  // nothing and notifies nobody twice.
  const [changed] = await db.Share.update(
    { suspendedAt: args.suspended ? new Date() : null },
    {
      where: {
        id: share.id,
        revokedAt: null,
        suspendedAt: args.suspended ? null : { [Op.ne]: null },
      },
    }
  );
  if (changed > 0) {
    await notifyConsumers({
      share,
      kind: args.suspended ? 'share_suspended' : 'share_resumed',
      consumerProjectIds: await activeConsumerProjectIds(share.id as number),
    });
  }
  return getShare({ id: args.id });
};

export const suspendShare = (args: { id: string }): Promise<MappedShare> => {
  return setSuspended({ id: args.id, suspended: true });
};

export const resumeShare = (args: { id: string }): Promise<MappedShare> => {
  return setSuspended({ id: args.id, suspended: false });
};

/**
 * Revokes the whole share, and with it every acceptance, as the publisher.
 * Terminal: the share accepts nothing afterwards.
 */
const revokeShareRow = async (share: ShareRow): Promise<void> => {
  if (share.revokedAt) return;
  const consumerProjectIds = await db.sequelize.transaction(
    async (transaction) => {
      const [changed] = await db.Share.update(
        { revokedAt: new Date() },
        { where: { id: share.id, revokedAt: null }, transaction }
      );
      if (changed === 0) return [];
      const active = await db.ShareAcceptance.findAll({
        where: { shareId: share.id, status: 'active' },
        attributes: ['id', 'projectId'],
        transaction,
      });
      await db.ShareAcceptance.update(
        { status: 'revoked', revokedBy: 'publisher', revokedAt: new Date() },
        { where: { shareId: share.id, status: 'active' }, transaction }
      );
      return active.map((row) => {
        return row.projectId;
      });
    }
  );
  await notifyConsumers({ share, kind: 'share_revoked', consumerProjectIds });
};

export const revokeShare = async (args: {
  id: string;
}): Promise<MappedShare> => {
  await revokeShareRow(await shares.getByPublicId({ id: args.id }));
  return getShare({ id: args.id });
};

/**
 * Live shares of one resource that some project has accepted: what a delete of
 * that resource refuses over until `force=true`.
 */
export const countAcceptedShares = async (args: {
  resourceType: string;
  resourceId: string;
}): Promise<number> => {
  return db.Share.count({
    where: {
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      revokedAt: null,
    },
    include: [
      {
        model: db.ShareAcceptance,
        as: 'acceptances',
        where: { status: 'active' },
        required: true,
        attributes: [],
      },
    ],
    distinct: true,
  });
};

/**
 * Every live share of one resource, revoked. A deleted resource leaves no live
 * offer behind, accepted or not.
 */
export const revokeResourceShares = async (args: {
  resourceType: string;
  resourceId: string;
}): Promise<void> => {
  const live = (await db.Share.findAll({
    where: {
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      revokedAt: null,
    },
    include: [{ model: db.Project, as: 'project' }],
  })) as ShareRow[];
  for (const share of live) {
    await revokeShareRow(share);
  }
};

/** A grantee withdrawing its own acceptance; it may accept again later. */
export const revokeOwnAcceptance = async (args: {
  id: string;
  projectId: number;
}): Promise<MappedShare> => {
  const share = await shares.getByPublicId({ id: args.id });
  const acceptance = await findOwnAcceptance({
    shareId: share.id as number,
    projectId: args.projectId,
  });
  if (!acceptance) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `This project has not accepted share '${share.publicId}'.`
    );
  }
  if (acceptance.status === 'active') {
    await acceptance.update({
      status: 'revoked',
      revokedBy: 'consumer',
      revokedAt: new Date(),
    });
  }
  return getShare({ id: args.id, granteeProjectId: args.projectId });
};

const getShareAcceptance = async (args: {
  shareId: string;
  acceptanceId: string;
}): Promise<{ share: ShareRow; acceptance: ShareAcceptanceRow }> => {
  const share = await shares.getByPublicId({ id: args.shareId });
  const acceptance = await db.ShareAcceptance.findOne({
    where: { publicId: args.acceptanceId, shareId: share.id },
  });
  if (!acceptance) throw acceptanceNotFound(args.acceptanceId);
  return { share, acceptance };
};

/**
 * The publisher cutting one consumer. The row stays, marked
 * `revoked_by: publisher`, so the same project cannot simply accept again.
 */
export const revokeShareAcceptance = async (args: {
  shareId: string;
  acceptanceId: string;
}): Promise<MappedShareAcceptance> => {
  const { share, acceptance } = await getShareAcceptance(args);
  const wasActive = acceptance.status === 'active';
  if (acceptance.revokedBy !== 'publisher') {
    await acceptance.update({
      status: 'revoked',
      revokedBy: 'publisher',
      revokedAt: acceptance.revokedAt ?? new Date(),
    });
  }
  if (wasActive) {
    await notifyConsumers({
      share,
      kind: 'share_revoked',
      consumerProjectIds: [acceptance.projectId],
    });
  }
  return reloadAcceptance(acceptance.id as number);
};

/** Removes an acceptance, which is what lets a cut-off project accept again. */
export const deleteShareAcceptance = async (args: {
  shareId: string;
  acceptanceId: string;
}): Promise<void> => {
  const { share, acceptance } = await getShareAcceptance(args);
  await acceptance.destroy();
  if (acceptance.status === 'active') {
    await notifyConsumers({
      share,
      kind: 'share_revoked',
      consumerProjectIds: [acceptance.projectId],
    });
  }
};

export const deleteShare = async (args: { id: string }): Promise<void> => {
  const share = await shares.getByPublicId({ id: args.id });
  const consumerProjectIds = await activeConsumerProjectIds(share.id as number);
  await share.destroy();
  log('deleteShare: id=%s consumers=%d', args.id, consumerProjectIds.length);
  await notifyConsumers({ share, kind: 'share_revoked', consumerProjectIds });
};
