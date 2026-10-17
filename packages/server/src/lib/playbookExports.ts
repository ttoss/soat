import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';
import type { OnBehalfOf } from './onBehalfOf';
import { paginatedList } from './pagination';
import {
  assertCaseAcceptsWork,
  caseDefinition,
  caseNodeStates,
  type PlaybookCaseRow,
  playbookCases,
  withLockedCase,
} from './playbookCases';
import type {
  PlaybookDefinition,
  PlaybookNode,
  PlaybookTransformation,
} from './playbookDefinition';
import { EXECUTION_LEASE_MS } from './playbookExecutionLease';
import { readCaseNode } from './playbookExecutions';
import { resolveRunAs } from './playbookExecutionWork';
import { type ExportCase, renderPlaybookExport } from './playbookExportRender';
import type { PlaybookCaseSnapshot, PlaybookNodeView } from './playbookState';
import type { RequestPrincipal } from './principals';
import { assertProjectAcceptsWork } from './projectPause';

const log = createDebug('soat:playbookExports');

type ExportRow = InstanceType<(typeof db)['PlaybookExport']> & {
  createdBy?: { publicId: string } | null;
  file?: { publicId: string } | null;
};

/** Each node's output revision while the node is `done`. */
const currentRevisions = (args: {
  snapshot: PlaybookCaseSnapshot;
  views: Map<string, PlaybookNodeView>;
}): Map<string, number> => {
  const current = new Map<string, number>();
  for (const [key, view] of args.views) {
    const output = args.snapshot[key]?.output;
    if (view.state === 'done' && output) current.set(key, output.revision);
  }
  return current;
};

const caseCurrentRevisions = async (row: PlaybookCaseRow) => {
  return currentRevisions(
    await caseNodeStates({
      caseDbId: row.id as number,
      definition: await caseDefinition({ row }),
    })
  );
};

const mapPlaybookExport = (args: {
  row: ExportRow;
  casePublicId: string;
  current: Map<string, number>;
}) => {
  const { row } = args;
  return {
    id: row.publicId,
    case_id: args.casePublicId,
    node: row.node,
    revision: row.revision,
    playbook_version: row.playbookVersion,
    transformation: row.transformation,
    format: row.format,
    tool_id: row.toolId,
    status: row.status,
    stale: args.current.get(row.node) !== row.revision,
    file_id: row.file?.publicId ?? null,
    error: row.error,
    created_by: row.createdBy?.publicId ?? null,
    on_behalf_of: row.onBehalfOf ?? null,
    created_at: row.createdAt,
    finished_at: row.finishedAt,
  };
};

const EXPORT_INCLUDES = () => {
  return [
    { model: db.User, as: 'createdBy' },
    { model: db.File, as: 'file', attributes: ['publicId'] },
  ];
};

/** The transformations a call names, or every one the node declares. */
const selectTransformations = (args: {
  node: PlaybookNode;
  names: unknown;
}): PlaybookTransformation[] => {
  const declared = args.node.transformations ?? [];
  if (declared.length === 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Node '${args.node.key}' declares no transformations.`,
      { node: args.node.key }
    );
  }
  if (args.names === undefined) return declared;
  const names = Array.isArray(args.names) ? args.names : [];
  const selected = declared.filter((transformation) => {
    return names.includes(transformation.name);
  });
  const unknown = names.filter((name) => {
    return !declared.some((transformation) => {
      return transformation.name === name;
    });
  });
  if (selected.length === 0 || unknown.length > 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `transformations must name one or more of node '${args.node.key}''s transformations.`,
      {
        unknown,
        declared: declared.map((transformation) => {
          return transformation.name;
        }),
      }
    );
  }
  return selected;
};

/** The revision exported: the one named, or the latest of a `done` node. */
const resolveRevision = async (args: {
  row: PlaybookCaseRow;
  definition: PlaybookDefinition;
  node: PlaybookNode;
  revision: unknown;
  transaction: Transaction;
}): Promise<number> => {
  const { row, node, transaction } = args;
  if (args.revision === undefined) {
    const states = await caseNodeStates({
      caseDbId: row.id as number,
      definition: args.definition,
      transaction,
    });
    const latest = currentRevisions(states).get(node.key);
    if (latest === undefined) {
      throw new DomainError(
        'PLAYBOOK_NODE_NOT_EXPORTABLE',
        `Node '${node.key}' has no current output to export.`,
        { node: node.key, state: states.views.get(node.key)!.state }
      );
    }
    return latest;
  }
  const entry = Number.isInteger(args.revision)
    ? await db.PlaybookEntry.findOne({
        where: {
          caseId: row.id as number,
          node: node.key,
          revision: args.revision as number,
          kind: ['output', 'confirmation'],
        },
        attributes: ['revision'],
        transaction,
      })
    : null;
  if (!entry) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `revision must name an output of node '${node.key}'.`,
      { node: node.key, revision: args.revision }
    );
  }
  return entry.revision;
};

/** An export nothing awaits; a failure to settle is logged, never thrown. */
const renderInBackground = async (
  args: Parameters<typeof renderPlaybookExport>[0]
): Promise<void> => {
  try {
    await renderPlaybookExport(args);
  } catch (error) {
    log('renderInBackground: %d did not settle %o', args.exportId, error);
  }
};

/** Records one `running` export per transformation, under the case's lock. */
const recordExports = (args: {
  row: PlaybookCaseRow;
  definition: PlaybookDefinition;
  node: PlaybookNode;
  transformations: PlaybookTransformation[];
  revision: unknown;
  createdByUserId: number | null;
  onBehalfOf: OnBehalfOf | null;
}) => {
  const { row, node } = args;
  return withLockedCase({
    row,
    work: async ({ locked, transaction }) => {
      assertCaseAcceptsWork({ locked, publicId: row.publicId });
      const revision = await resolveRevision({ ...args, transaction });
      const rows = [];
      for (const transformation of args.transformations) {
        rows.push(
          await db.PlaybookExport.create(
            {
              caseId: row.id as number,
              node: node.key,
              revision,
              playbookVersion: row.playbookVersion,
              transformation: transformation.name,
              format: transformation.format,
              toolId: transformation.tool,
              status: 'running',
              leaseExpiresAt: new Date(Date.now() + EXECUTION_LEASE_MS),
              createdByUserId: args.createdByUserId,
              onBehalfOf: args.onBehalfOf,
            },
            { transaction }
          )
        );
      }
      return rows;
    },
  });
};

const readExports = async (args: {
  row: PlaybookCaseRow;
  created: Array<{ id?: unknown }>;
}) => {
  const current = await caseCurrentRevisions(args.row);
  const rows = await db.PlaybookExport.findAll({
    where: {
      id: args.created.map((exported) => {
        return exported.id as number;
      }),
    },
    include: EXPORT_INCLUDES(),
    order: [['id', 'ASC']],
  });
  return {
    data: rows.map((exported) => {
      return mapPlaybookExport({
        row: exported as ExportRow,
        casePublicId: args.row.publicId,
        current,
      });
    }),
  };
};

/**
 * Renders one revision of a final node with each transformation named, one
 * export per transformation. Everything a refusal depends on — the node, the
 * revision, the author and the author's permission to call each tool — is
 * checked before any export is recorded.
 */
export const exportPlaybookCaseNode = async (args: {
  projectIds?: number[];
  caseId: string;
  node: unknown;
  transformations: unknown;
  revision: unknown;
  wait: boolean;
  createdByUserId: number | null;
  onBehalfOf: OnBehalfOf | null;
}) => {
  log('exportPlaybookCaseNode: case=%s node=%s', args.caseId, args.node);
  const row = await playbookCases.getByPublicId({
    projectIds: args.projectIds,
    id: args.caseId,
  });
  const definition = await caseDefinition({ row });
  const node = readCaseNode({ definition, node: args.node });
  const transformations = selectTransformations({
    node,
    names: args.transformations,
  });
  await assertProjectAcceptsWork({ projectId: row.projectId });
  const runAs = await resolveRunAs({
    row,
    node: node.key,
    executors: transformations.map((transformation) => {
      return { type: 'tool', id: transformation.tool };
    }),
  });

  const created = await recordExports({
    row,
    definition,
    node,
    transformations,
    revision: args.revision,
    createdByUserId: args.createdByUserId,
    onBehalfOf: args.onBehalfOf,
  });

  const exportCase: ExportCase = {
    publicId: row.publicId,
    subject: row.subject,
    projectId: row.projectId,
    projectPublicId: row.project.publicId,
  };
  const principal: RequestPrincipal = runAs.principal;
  const render = () => {
    return Promise.all(
      created.map((exported) => {
        return renderInBackground({
          exportId: exported.id as number,
          exportCase,
          principal,
        });
      })
    );
  };
  if (args.wait) await render();

  const answer = await readExports({ row, created });
  // Read before the renders start, so the answer is the one recorded.
  if (!args.wait) void render();
  return answer;
};

export const listPlaybookCaseExports = async (args: {
  projectIds?: number[];
  caseId: string;
  node?: string;
  transformation?: string;
  limit?: number;
  offset?: number;
}) => {
  log('listPlaybookCaseExports: case=%s', args.caseId);
  const row = await playbookCases.getByPublicId({
    projectIds: args.projectIds,
    id: args.caseId,
  });
  const where: Record<string, unknown> = { caseId: row.id as number };
  if (args.node !== undefined) where.node = args.node;
  if (args.transformation !== undefined) {
    where.transformation = args.transformation;
  }
  const current = await caseCurrentRevisions(row);

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['id', 'DESC']],
    query: ({ limit, offset, order }) => {
      return db.PlaybookExport.findAndCountAll({
        where,
        include: EXPORT_INCLUDES(),
        distinct: true,
        order,
        limit,
        offset,
      });
    },
    map: (exported) => {
      return mapPlaybookExport({
        row: exported as ExportRow,
        casePublicId: row.publicId,
        current,
      });
    },
  });
};

export const getPlaybookCaseExport = async (args: {
  projectIds?: number[];
  caseId: string;
  id: string;
}) => {
  log('getPlaybookCaseExport: id=%s', args.id);
  const row = await playbookCases.getByPublicId({
    projectIds: args.projectIds,
    id: args.caseId,
  });
  const exported = await db.PlaybookExport.findOne({
    where: { publicId: args.id, caseId: row.id as number },
    include: EXPORT_INCLUDES(),
  });
  if (!exported) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Playbook export '${args.id}' not found.`
    );
  }
  return mapPlaybookExport({
    row: exported as ExportRow,
    casePublicId: row.publicId,
    current: await caseCurrentRevisions(row),
  });
};
