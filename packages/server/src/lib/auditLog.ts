import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';
import {
  camelToSnakeKey,
  convertKeysDeep,
} from 'src/lib/resource-inputs/normalizers';

import { DomainError } from '../errors';
import { emitEvent } from './eventBus';

const log = createDebug('soat:audit');

/**
 * The webhook event fired once per persisted audit entry, so external systems
 * (e.g. a SIEM) can subscribe to the log instead of polling the list endpoint.
 * Only project-scoped entries emit it — webhooks are project-scoped, so a
 * global entry (`projectId` null) has no possible subscriber.
 */
export const AUDIT_ENTRY_CREATED_EVENT = 'audit.entry_created';

export type AuditPrincipalType = 'user' | 'api_key';

/** One authorization decision recorded during a request. */
export type AuditCheck = {
  action: string;
  resource: string | null;
  allowed: boolean;
};

const mapAuditEntry = (
  instance: InstanceType<(typeof db)['AuditEntry']> & {
    project?: InstanceType<(typeof db)['Project']> | null;
  },
  // Overrides the eager-loaded association when the caller already knows the
  // project's public id (the write path, which never re-reads the row it just
  // created).
  projectPublicId?: string | null
) => {
  return {
    id: instance.publicId,
    project_id: projectPublicId ?? instance.project?.publicId ?? null,
    principal_type: instance.principalType,
    principal_id: instance.principalId,
    action: instance.action,
    resource_srn: instance.resourceSrn,
    resource_public_id: instance.resourcePublicId,
    status: instance.status,
    request_id: instance.requestId,
    ip: instance.ip,
    user_agent: instance.userAgent,
    detail: instance.detail,
    created_at: instance.createdAt,
  };
};

/**
 * Read auditing is a per-project opt-in, and reads are exactly the high-volume
 * traffic the fire-and-forget queue must not be flooded with. So the flag is
 * cached per project and consulted *before* enqueueing: a cached `false` drops
 * the read on the request path, leaving the queue's capacity for mutations.
 *
 * A cache miss is never treated as a decision — the middleware enqueues and
 * {@link writeAuditEntry} makes the authoritative call while resolving the
 * project it has to look up anyway, so no entry that should be recorded is ever
 * lost. Writes invalidate the entry (see {@link invalidateReadAuditCache}); the
 * TTL is the backstop that converges other instances after a flag flip.
 */
const READ_AUDIT_CACHE_TTL_MS = 30_000;

const readAuditCache = new Map<
  string,
  { enabled: boolean; expiresAt: number }
>();

/**
 * The cached read-auditing flag for a project, or `undefined` on a miss/expiry.
 * Synchronous by design — the caller is on the request path.
 */
export const peekReadAuditEnabled = (
  projectPublicId: string
): boolean | undefined => {
  const cached = readAuditCache.get(projectPublicId);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    readAuditCache.delete(projectPublicId);
    return undefined;
  }
  return cached.enabled;
};

/** Drops the cached flag for a project. Called whenever the project is updated. */
export const invalidateReadAuditCache = (projectPublicId: string): void => {
  readAuditCache.delete(projectPublicId);
};

// Resolves a project public id to the row the write needs (its internal FK and
// its read-auditing flag). A null/unknown project means the entry is global.
// Extracted so writeAuditEntry stays under the cyclomatic-complexity limit.
const resolveAuditProject = async (
  projectPublicId?: string | null
): Promise<{ id: number; auditReadsEnabled: boolean } | null> => {
  if (!projectPublicId) return null;
  const project = await db.Project.findOne({
    where: { publicId: projectPublicId },
  });
  if (!project) return null;

  const auditReadsEnabled = Boolean(project.auditReadsEnabled);
  readAuditCache.set(projectPublicId, {
    enabled: auditReadsEnabled,
    expiresAt: Date.now() + READ_AUDIT_CACHE_TTL_MS,
  });

  return { id: project.id as number, auditReadsEnabled };
};

/** The snake_case projection of an entry — the read contract, shared by the
 * export stream and the `audit.entry_created` webhook payload so all three
 * surfaces expose the same field names.
 *
 * `detail` is still written camelCase by its producers, so `convertKeysDeep`
 * snake-cases it here — the one place all three surfaces share, which is what
 * makes them agree on its inner key casing.
 *
 * This recursion is the last one left on a read path and is scheduled for
 * removal: the fix is to have `detail`'s producers write snake_case at the
 * source, so the projection can copy the bag as a value like every other. */
const toSnakeAuditEntry = (
  entry: ReturnType<typeof mapAuditEntry>
): Record<string, unknown> => {
  return {
    id: entry.id,
    project_id: entry.project_id,
    principal_type: entry.principal_type,
    principal_id: entry.principal_id,
    action: entry.action,
    resource_srn: entry.resource_srn,
    resource_public_id: entry.resource_public_id,
    status: entry.status,
    request_id: entry.request_id,
    ip: entry.ip,
    user_agent: entry.user_agent,
    detail: convertKeysDeep(entry.detail, camelToSnakeKey),
    created_at:
      entry.created_at instanceof Date
        ? entry.created_at.toISOString()
        : entry.created_at,
  };
};

/**
 * Fires {@link AUDIT_ENTRY_CREATED_EVENT} for a persisted entry. Extracted so
 * `writeAuditEntry` stays under the cyclomatic-complexity limit.
 */
const emitAuditEntryCreated = (args: {
  entry: InstanceType<(typeof db)['AuditEntry']>;
  projectId: number;
  projectPublicId: string;
}): void => {
  emitEvent({
    type: AUDIT_ENTRY_CREATED_EVENT,
    projectId: args.projectId,
    projectPublicId: args.projectPublicId,
    resourceType: 'audit',
    resourceId: args.entry.publicId,
    // The full entry, snake_cased to match the read contract, so a subscriber
    // never needs a follow-up GET to see what happened.
    data: toSnakeAuditEntry(mapAuditEntry(args.entry, args.projectPublicId)),
    timestamp: new Date().toISOString(),
  });
};

export type WriteAuditEntryArgs = {
  projectPublicId?: string | null;
  // A request entry sets `principalType`/`principalId`; a platform-originated
  // entry leaves them null and is identified by its `action`.
  principalType?: AuditPrincipalType | null;
  principalId?: string | null;
  action: string;
  resourceSrn?: string | null;
  resourcePublicId?: string | null;
  status: number;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown> | null;
  // Marks the entry as describing a read. Read entries are only persisted when
  // the project they name has opted in; a read with no project is never
  // persisted, since no project could opt it in.
  isRead?: boolean;
};

// Normalizes the optional write args into the row's non-optional columns.
// Extracted so writeAuditEntry stays under the cyclomatic-complexity limit —
// each `??` default is itself a branch.
const buildAuditEntryRow = (args: {
  args: WriteAuditEntryArgs;
  projectId: number | null;
}) => {
  const w = args.args;
  return {
    projectId: args.projectId,
    principalType: w.principalType ?? null,
    principalId: w.principalId ?? null,
    action: w.action,
    resourceSrn: w.resourceSrn ?? null,
    resourcePublicId: w.resourcePublicId ?? null,
    status: w.status,
    requestId: w.requestId ?? null,
    ip: w.ip ?? null,
    userAgent: w.userAgent ?? null,
    detail: w.detail ?? null,
  };
};

export const writeAuditEntry = async (
  args: WriteAuditEntryArgs
): Promise<void> => {
  const project = await resolveAuditProject(args.projectPublicId);

  if (args.isRead && !project?.auditReadsEnabled) {
    log('writeAuditEntry: read auditing off, skipped action=%s', args.action);
    return;
  }

  const entry = await db.AuditEntry.create(
    buildAuditEntryRow({ args, projectId: project?.id ?? null })
  );

  log(
    'writeAuditEntry: action=%s status=%d resource=%s',
    args.action,
    args.status,
    args.resourceSrn
  );

  // Only project-scoped entries emit: webhooks are project-scoped, so a global
  // entry has no possible subscriber.
  if (project && args.projectPublicId) {
    emitAuditEntryCreated({
      entry,
      projectId: project.id,
      projectPublicId: args.projectPublicId,
    });
  }
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
  principalId?: string;
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
  if (args.principalId) where.principalId = args.principalId;
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
  // A non-finite value should never reach here (the REST layer validates it),
  // but guarding here too keeps this shared clamp — also used by
  // streamAuditEntriesNdjson's paging loop — safe against any other caller.
  const rawLimit = Number.isFinite(args.limit) ? args.limit : undefined;
  const rawOffset = Number.isFinite(args.offset) ? args.offset : undefined;
  const limit = Math.min(Math.max(rawLimit ?? 25, 1), 200);
  const offset = Math.max(rawOffset ?? 0, 0);

  const where = buildListWhere(args);

  const { rows, count } = await db.AuditEntry.findAndCountAll({
    where,
    include: [{ model: db.Project, as: 'project' }],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  // Wrapped rather than passed by reference: `Array#map` supplies the index as
  // the second argument, which `mapAuditEntry` reads as a project override.
  const data = rows.map((row) => {
    return mapAuditEntry(row);
  });

  return { data, total: count, limit, offset };
};

/**
 * Number of rows fetched per round trip while streaming an export. Bounds the
 * exporter's memory to one batch regardless of how many entries a project has.
 */
const EXPORT_BATCH_SIZE = 500;

/**
 * Streams a project's audit entries as NDJSON — one snake_case JSON object per
 * line, oldest first. Ordering is ascending by `(created_at, id)` so a row that
 * arrives mid-export is appended after the cursor rather than shifting rows the
 * consumer already read (a `DESC` order would push every new row to the front
 * and duplicate a page boundary). Pages internally, so the whole log is never
 * held in memory. Filters mirror {@link listAuditEntries}.
 */
export async function* streamAuditEntriesNdjson(
  args: AuditListFilters
): AsyncGenerator<string> {
  const where = buildListWhere(args);
  let offset = 0;

  for (;;) {
    const rows = await db.AuditEntry.findAll({
      where,
      include: [{ model: db.Project, as: 'project' }],
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
      limit: EXPORT_BATCH_SIZE,
      offset,
    });

    if (rows.length === 0) return;

    for (const row of rows) {
      yield `${JSON.stringify(toSnakeAuditEntry(mapAuditEntry(row)))}\n`;
    }

    if (rows.length < EXPORT_BATCH_SIZE) return;
    offset += rows.length;
  }
}

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
