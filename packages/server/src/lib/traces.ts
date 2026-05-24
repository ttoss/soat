import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { upsertFileByPath } from './files';

const log = createDebug('soat:traces');

export type Trace = {
  id: string;
  projectId: string;
  agentId: string;
  fileId: string | null;
  stepCount: number;
  parentTraceId: string | null;
  rootTraceId: string | null;
  createdAt: Date;
};

export type TraceTreeNode = Trace & {
  children: TraceTreeNode[];
};

/**
 * Serializes trace steps so that Error objects (which serialize to `{}` by
 * default) are converted to plain objects with `message`, `name`, and any
 * enumerable properties (e.g. `status`, `body` from HttpToolError).
 */
export const serializeSteps = (steps: unknown[]): unknown[] => {
  return JSON.parse(
    JSON.stringify(steps, (_key, value: unknown) => {
      if (value instanceof Error) {
        return {
          message: value.message,
          name: value.name,
          ...(value as unknown as Record<string, unknown>),
        };
      }
      return value;
    })
  ) as unknown[];
};

const mapTrace = (
  row: InstanceType<(typeof db)['Trace']> & {
    project?: InstanceType<(typeof db)['Project']>;
  }
): Trace => {
  return {
    id: row.publicId,
    projectId: (row.project?.publicId ?? String(row.projectId)) as string,
    agentId: row.agentId,
    fileId: row.fileId ?? null,
    stepCount: row.stepCount,
    parentTraceId: row.parentTraceId ?? null,
    rootTraceId: row.rootTraceId ?? null,
    createdAt: row.createdAt,
  };
};

const findTraceDbId = async (
  publicId: string | null | undefined
): Promise<number | null> => {
  if (!publicId) return null;
  return ((await db.Trace.findOne({ where: { publicId } }))?.id ?? null) as
    | number
    | null;
};

const findFileDbId = async (
  publicId: string | null | undefined
): Promise<number | null> => {
  if (!publicId) return null;
  return ((await db.File.findOne({ where: { publicId } }))?.id ?? null) as
    | number
    | null;
};

const upsertTraceRecord = async (args: {
  traceId: string;
  projectId: number;
  agentId: string;
  agentDbId?: number | null;
  filePublicId: string | undefined | null;
  stepCount: number;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
}): Promise<void> => {
  log(
    'upsertTraceRecord: traceId=%s agentId=%s parentTraceId=%s rootTraceId=%s stepCount=%d',
    args.traceId,
    args.agentId,
    args.parentTraceId ?? 'null',
    args.rootTraceId ?? 'null',
    args.stepCount
  );

  const existing = await db.Trace.findOne({
    where: { publicId: args.traceId },
  });

  const fileDbId = await findFileDbId(args.filePublicId);
  const parentTraceDbId = await findTraceDbId(args.parentTraceId);
  const rootTraceDbId = await findTraceDbId(args.rootTraceId);

  if (existing) {
    log('upsertTraceRecord: updating existing trace traceId=%s', args.traceId);
    await existing.update({
      fileDbId,
      fileId: args.filePublicId ?? null,
      stepCount: args.stepCount,
    });
  } else {
    log('upsertTraceRecord: creating new trace traceId=%s', args.traceId);
    try {
      await db.Trace.create({
        publicId: args.traceId,
        projectId: args.projectId,
        agentId: args.agentId,
        agentDbId: args.agentDbId ?? null,
        fileDbId,
        fileId: args.filePublicId ?? null,
        stepCount: args.stepCount,
        parentTraceId: args.parentTraceId ?? null,
        parentTraceDbId,
        rootTraceId: args.rootTraceId ?? null,
        rootTraceDbId,
      });
    } catch (createError) {
      // Handle race condition: another process may have created the record concurrently.
      const concurrent = await db.Trace.findOne({
        where: { publicId: args.traceId },
      });
      if (concurrent) {
        log(
          'upsertTraceRecord: concurrent create detected, updating traceId=%s',
          args.traceId
        );
        await concurrent.update({
          fileDbId,
          fileId: args.filePublicId ?? null,
          stepCount: args.stepCount,
        });
      } else {
        throw createError;
      }
    }
  }
};

/**
 * Upserts a Trace row in the DB and writes trace content (steps) to disk
 * via the File system. The file is stored at `/traces/{traceId}.json` under
 * the project's storage directory.
 *
 * Fire-and-forget safe: callers may not await this.
 */
export const saveTrace = async (args: {
  traceId: string;
  projectId: number;
  projectPublicId: string;
  agentId: string;
  agentDbId?: number | null;
  steps: unknown[];
  parentTraceId?: string | null;
  rootTraceId?: string | null;
}): Promise<void> => {
  log(
    'saveTrace: traceId=%s agentId=%s parentTraceId=%s rootTraceId=%s steps=%d',
    args.traceId,
    args.agentId,
    args.parentTraceId ?? 'null',
    args.rootTraceId ?? 'null',
    args.steps.length
  );
  const serializedSteps = serializeSteps(args.steps);
  const content = Buffer.from(JSON.stringify(serializedSteps), 'utf8');
  const filePath = `/traces/${args.traceId}.json`;

  const fileRecord = await upsertFileByPath({
    projectId: args.projectId,
    projectPublicId: args.projectPublicId,
    path: filePath,
    fileBuffer: content,
    contentType: 'application/json',
    filename: `${args.traceId}.json`,
  });

  await upsertTraceRecord({
    traceId: args.traceId,
    projectId: args.projectId,
    agentId: args.agentId,
    agentDbId: args.agentDbId,
    filePublicId: fileRecord.id,
    stepCount: serializedSteps.length,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
  });
};

export const listTraces = async (args: {
  projectIds?: number[];
  limit?: number;
  offset?: number;
}): Promise<{
  data: Trace[];
  total: number;
  limit: number;
  offset: number;
}> => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};
  if (args.projectIds !== undefined) {
    if (args.projectIds.length === 0)
      return { data: [], total: 0, limit, offset };
    where.projectId = args.projectIds;
  }

  const { count, rows } = await db.Trace.findAndCountAll({
    where: Object.keys(where).length > 0 ? where : undefined,
    include: [{ model: db.Project, as: 'project' }],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });
  return { data: rows.map(mapTrace), total: count, limit, offset };
};

export const getTrace = async (args: {
  projectIds?: number[];
  traceId: string;
}): Promise<Trace> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { publicId: args.traceId };
  if (args.projectIds !== undefined) {
    if (args.projectIds.length === 0)
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        `Trace '${args.traceId}' not found.`
      );
    where.projectId = args.projectIds;
  }

  const row = await db.Trace.findOne({
    where,
    include: [{ model: db.Project, as: 'project' }],
  });
  if (!row)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Trace '${args.traceId}' not found.`
    );

  return mapTrace(row);
};

const buildTraceTree = (traces: Trace[]): TraceTreeNode | undefined => {
  const nodeMap = new Map<string, TraceTreeNode>();
  for (const trace of traces) {
    nodeMap.set(trace.id, { ...trace, children: [] });
  }

  let root: TraceTreeNode | undefined;
  for (const node of nodeMap.values()) {
    if (!node.parentTraceId) {
      root = node;
    } else {
      const parent = nodeMap.get(node.parentTraceId);
      if (parent) {
        parent.children.push(node);
      }
    }
  }
  return root;
};

/**
 * Returns the full trace tree rooted at the given trace.
 *
 * Strategy:
 * 1. Resolve the target trace.
 * 2. Determine the root: if `rootTraceId` is null, this trace is the root;
 *    otherwise fetch the root.
 * 3. Query all traces that share the same root (rootTraceId = rootPublicId)
 *    plus the root itself.
 * 4. Build the tree in memory from the flat list.
 */
export const getTraceTree = async (args: {
  projectIds?: number[];
  traceId: string;
}): Promise<TraceTreeNode> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { publicId: args.traceId };
  if (args.projectIds !== undefined) {
    if (args.projectIds.length === 0)
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        `Trace '${args.traceId}' not found.`
      );
    where.projectId = args.projectIds;
  }

  const targetRow = await db.Trace.findOne({
    where,
    include: [{ model: db.Project, as: 'project' }],
  });
  if (!targetRow)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Trace '${args.traceId}' not found.`
    );

  // Determine root publicId
  const rootPublicId = targetRow.rootTraceId ?? targetRow.publicId;

  // Query all traces in the tree (root + all descendants sharing rootTraceId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const treeWhere: Record<string, any> = {
    [Op.or]: [{ publicId: rootPublicId }, { rootTraceId: rootPublicId }],
  };
  if (args.projectIds !== undefined) {
    treeWhere.projectId = args.projectIds;
  }

  const allRows = await db.Trace.findAll({
    where: treeWhere,
    include: [{ model: db.Project, as: 'project' }],
    order: [['createdAt', 'ASC']],
  });

  const allTraces = allRows.map(mapTrace);
  const tree = buildTraceTree(allTraces);
  if (!tree)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Trace tree for '${args.traceId}' not found.`
    );
  return tree;
};
