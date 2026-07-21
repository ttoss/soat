import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';

const log = createDebug('soat:audit');

export type AuditActorType = 'user' | 'api_key';

/** One authorization decision recorded during a request. */
export type AuditCheck = {
  action: string;
  resource: string | null;
  allowed: boolean;
};

const mapAuditEntry = (
  instance: InstanceType<(typeof db)['AuditEntry']> & {
    project?: InstanceType<(typeof db)['Project']> | null;
  }
) => {
  return {
    id: instance.publicId,
    projectId: instance.project?.publicId ?? null,
    actorType: instance.actorType,
    actorId: instance.actorId,
    action: instance.action,
    resourceSrn: instance.resourceSrn,
    resourcePublicId: instance.resourcePublicId,
    status: instance.status,
    requestId: instance.requestId,
    ip: instance.ip,
    userAgent: instance.userAgent,
    detail: instance.detail,
    createdAt: instance.createdAt,
  };
};

/**
 * Persists a single audit entry. Called only from the async audit queue, off
 * the request path — a failure here must never affect the request being
 * described, so callers swallow rejections. Resolves the project public id to
 * its internal FK; a null/unknown project is stored as a global (`projectId`
 * null) entry.
 */
export const writeAuditEntry = async (args: {
  projectPublicId?: string | null;
  actorType: AuditActorType;
  actorId: string;
  action: string;
  resourceSrn?: string | null;
  resourcePublicId?: string | null;
  status: number;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown> | null;
}): Promise<void> => {
  let projectId: number | null = null;
  if (args.projectPublicId) {
    const project = await db.Project.findOne({
      where: { publicId: args.projectPublicId },
    });
    projectId = (project?.id as number | undefined) ?? null;
  }

  await db.AuditEntry.create({
    projectId,
    actorType: args.actorType,
    actorId: args.actorId,
    action: args.action,
    resourceSrn: args.resourceSrn ?? null,
    resourcePublicId: args.resourcePublicId ?? null,
    status: args.status,
    requestId: args.requestId ?? null,
    ip: args.ip ?? null,
    userAgent: args.userAgent ?? null,
    detail: args.detail ?? null,
  });

  log(
    'writeAuditEntry: action=%s status=%d resource=%s',
    args.action,
    args.status,
    args.resourceSrn
  );
};

// Escapes the LIKE metacharacters (`%`, `_`, `\`) so an SRN prefix — which
// contains underscores in project/resource ids — matches literally under a
// prefix scan rather than treating `_` as a single-char wildcard.
const escapeLikePrefix = (value: string): string => {
  return value.replace(/[\\%_]/g, '\\$&');
};

type AuditListFilters = {
  projectIds?: number[];
  action?: string;
  actorId?: string;
  resourcePublicId?: string;
  resourceSrn?: string;
  from?: Date;
  to?: Date;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildListWhere = (args: AuditListFilters): Record<string, any> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};

  if (args.projectIds) where.projectId = args.projectIds;
  if (args.action) where.action = args.action;
  if (args.actorId) where.actorId = args.actorId;
  if (args.resourcePublicId) where.resourcePublicId = args.resourcePublicId;
  if (args.resourceSrn) {
    where.resourceSrn = { [Op.like]: `${escapeLikePrefix(args.resourceSrn)}%` };
  }
  if (args.from || args.to) {
    where.createdAt = {
      ...(args.from ? { [Op.gte]: args.from } : {}),
      ...(args.to ? { [Op.lte]: args.to } : {}),
    };
  }

  return where;
};

/**
 * Lists audit entries visible to the caller (scoped to `projectIds`; `undefined`
 * means no project filter — every project, admin only), newest first. Filters
 * are all optional and combine with AND. `resourceSrn` is a prefix match (e.g.
 * `soat:{project}:secret:` for every secret action); every other filter is
 * exact. Offset/limit pagination; export-before-expiry is paginating this
 * endpoint into NDJSON.
 */
export const listAuditEntries = async (
  args: AuditListFilters & { limit?: number; offset?: number }
): Promise<{
  data: ReturnType<typeof mapAuditEntry>[];
  total: number;
  limit: number;
  offset: number;
}> => {
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 200);
  const offset = Math.max(args.offset ?? 0, 0);

  const where = buildListWhere(args);

  const { rows, count } = await db.AuditEntry.findAndCountAll({
    where,
    include: [{ model: db.Project, as: 'project' }],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  return { data: rows.map(mapAuditEntry), total: count, limit, offset };
};

/**
 * Fetches one entry by public id, scoped to the projects the caller may access
 * (`projectIds` undefined = no filter, admin only). Throws `RESOURCE_NOT_FOUND`
 * when the entry does not exist or falls outside the caller's scope.
 */
export const getAuditEntry = async (args: {
  id: string;
  projectIds?: number[];
}): Promise<ReturnType<typeof mapAuditEntry>> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { publicId: args.id };
  if (args.projectIds) {
    where.projectId = args.projectIds;
  }

  const entry = await db.AuditEntry.findOne({
    where,
    include: [{ model: db.Project, as: 'project' }],
  });

  if (!entry) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Audit entry '${args.id}' not found.`
    );
  }

  return mapAuditEntry(entry);
};

const DEFAULT_RETENTION_DAYS = 365;

/**
 * Resolves the configured retention window (`AUDIT_RETENTION_DAYS`, default
 * 365). A non-numeric or non-positive value falls back to the default.
 */
export const getAuditRetentionDays = (): number => {
  const raw = Number(process.env.AUDIT_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
};

/**
 * Deletes every entry older than the retention cutoff. This is the sole delete
 * path for the append-only table — the model rejects single-row deletes, so the
 * sweep uses a bulk `destroy({ where })`. Safe under overlapping ticks and
 * multiple workers: a re-run over an already-pruned range simply deletes zero
 * rows. Returns the number of rows removed.
 */
export const sweepExpiredAuditEntries = async (args?: {
  now?: Date;
}): Promise<number> => {
  const now = args?.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - getAuditRetentionDays() * 24 * 60 * 60 * 1000
  );

  const removed = await db.AuditEntry.destroy({
    where: { createdAt: { [Op.lt]: cutoff } },
  });

  if (removed > 0) {
    log('sweepExpiredAuditEntries: removed=%d cutoff=%s', removed, cutoff);
  }
  return removed;
};
