import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { PersistedGeneration } from './generations';
import { listGenerationsByTraceIds } from './generations';
import { emptyPage, paginatedList } from './pagination';
import { makeResourceAccessor } from './resourceAccessor';

// The write path lives in its own module; re-exported here so `saveTrace` and
// friends keep their long-standing import site.
export { recordTraceError, saveTrace, serializeSteps } from './traceWrite';

const log = createDebug('soat:traces');

export type Trace = {
  id: string;
  project_id: string;
  agent_id: string;
  file_id: string | null;
  step_count: number;
  parent_trace_id: string | null;
  root_trace_id: string | null;
  error: Record<string, unknown> | null;
  content_redacted_at: Date | null;
  content_redacted_by_principal_type: string | null;
  content_redacted_by_principal_id: string | null;
  created_at: Date;
};

export type TraceTreeNode = Trace & {
  children: TraceTreeNode[];
  generations?: PersistedGeneration[];
};

type TraceRow = InstanceType<(typeof db)['Trace']> & {
  project?: InstanceType<(typeof db)['Project']>;
  agent?: InstanceType<(typeof db)['Agent']>;
  file?: InstanceType<(typeof db)['File']> | null;
  parentTrace?: InstanceType<(typeof db)['Trace']> | null;
  rootTrace?: InstanceType<(typeof db)['Trace']> | null;
};

const traceRows = makeResourceAccessor<TraceRow>({
  model: () => {
    return db.Trace;
  },
  includes: () => {
    return [
      { model: db.Project, as: 'project' },
      { model: db.Agent, as: 'agent' },
      { model: db.File, as: 'file' },
      { model: db.Trace, as: 'parentTrace' },
      { model: db.Trace, as: 'rootTrace' },
    ];
  },
  label: 'Trace',
});

export const mapTrace = (row: TraceRow): Trace => {
  if (!row.agent) {
    throw new Error('Trace agent association is required for serialization.');
  }

  return {
    id: row.publicId,
    project_id: (row.project?.publicId ?? String(row.projectId)) as string,
    agent_id: row.agent.publicId,
    file_id: row.file?.publicId ?? null,
    step_count: row.stepCount,
    parent_trace_id: row.parentTrace?.publicId ?? null,
    root_trace_id: row.rootTrace?.publicId ?? null,
    error: row.error,
    // Redaction marker. A purged trace still reads back as a skeleton — with
    // `file_id` null and this timestamp set — rather than as a 404, so the
    // erasure is provable instead of indistinguishable from a resource that
    // never existed (#836).
    content_redacted_at: row.contentRedactedAt,
    content_redacted_by_principal_type: row.contentRedactedByPrincipalType,
    content_redacted_by_principal_id: row.contentRedactedByPrincipalId,
    created_at: row.createdAt,
  };
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};
  if (args.projectIds !== undefined) {
    if (args.projectIds.length === 0) return emptyPage(args);
    where.projectId = args.projectIds;
  }

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Trace.findAndCountAll({
        where: Object.keys(where).length > 0 ? where : undefined,
        include: [
          { model: db.Project, as: 'project' },
          { model: db.Agent, as: 'agent' },
          { model: db.File, as: 'file' },
          { model: db.Trace, as: 'parentTrace' },
          { model: db.Trace, as: 'rootTrace' },
        ],
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: mapTrace,
  });
};

export const getTrace = async (args: {
  projectIds?: number[];
  traceId: string;
}): Promise<Trace> => {
  return mapTrace(
    await traceRows.getByPublicId({
      id: args.traceId,
      projectIds: args.projectIds,
    })
  );
};

const buildTraceTree = (traces: Trace[]): TraceTreeNode | undefined => {
  const nodeMap = new Map<string, TraceTreeNode>();
  for (const trace of traces) {
    nodeMap.set(trace.id, { ...trace, children: [] });
  }

  let root: TraceTreeNode | undefined;
  for (const node of nodeMap.values()) {
    if (!node.parent_trace_id) {
      root = node;
    } else {
      const parent = nodeMap.get(node.parent_trace_id);
      if (parent) {
        parent.children.push(node);
      }
    }
  }
  return root;
};

const attachNodeGenerations = (
  node: TraceTreeNode,
  byTraceId: Map<string, PersistedGeneration[]>
): void => {
  node.generations = byTraceId.get(node.id) ?? [];
  for (const child of node.children) {
    attachNodeGenerations(child, byTraceId);
  }
};

const attachGenerationsToTree = async (
  tree: TraceTreeNode,
  allTraces: Trace[],
  projectIds: number[] | undefined
): Promise<void> => {
  const allGens = await listGenerationsByTraceIds({
    tracePublicIds: allTraces.map((t) => {
      return t.id;
    }),
    projectIds,
  });

  const byTraceId = new Map<string, PersistedGeneration[]>();
  for (const gen of allGens) {
    const list = byTraceId.get(gen.trace_id) ?? [];
    list.push(gen);
    byTraceId.set(gen.trace_id, list);
  }

  attachNodeGenerations(tree, byTraceId);
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
  include?: string[];
}): Promise<TraceTreeNode> => {
  log('getTraceTree: traceId=%s projectIds=%o', args.traceId, args.projectIds);

  const targetRow = await traceRows.getByPublicId({
    id: args.traceId,
    projectIds: args.projectIds,
  });

  // Determine root publicId
  const rootTraceDbId = (targetRow.rootTraceId ??
    (targetRow.id as number)) as number;

  // Query all traces in the tree (root + all descendants sharing rootTraceId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const treeWhere: Record<string, any> = {
    [Op.or]: [{ id: rootTraceDbId }, { rootTraceId: rootTraceDbId }],
  };
  if (args.projectIds !== undefined) {
    treeWhere.projectId = args.projectIds;
  }

  const allRows = await db.Trace.findAll({
    where: treeWhere,
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Agent, as: 'agent' },
      { model: db.File, as: 'file' },
      { model: db.Trace, as: 'parentTrace' },
      { model: db.Trace, as: 'rootTrace' },
    ],
    order: [['createdAt', 'ASC']],
  });

  const allTraces = allRows.map(mapTrace);
  const tree = buildTraceTree(allTraces);
  if (!tree)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Trace tree for '${args.traceId}' not found.`
    );

  if (args.include?.includes('generations')) {
    await attachGenerationsToTree(tree, allTraces, args.projectIds);
  }

  return tree;
};
