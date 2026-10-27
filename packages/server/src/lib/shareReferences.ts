import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { type Page, pageOf } from './pagination';
import { shares } from './shares';

const log = createDebug('soat:shares');

/** A resource of the grantee project that reaches a shared resource. */
export type ShareReference = {
  type:
    | 'agent'
    | 'tool'
    | 'decider'
    | 'ingestion_rule'
    | 'orchestration'
    | 'workflow'
    | 'playbook'
    | 'eval'
    | 'trigger'
    | 'formation';
  id: string;
};

type Where = ReturnType<typeof db.sequelize.where>;
type Condition = Where | Record<string, unknown>;

// A public id is only ever stored as a JSON string, so its quoted form found in
// the column's text is the id itself and never a prefix of another.
const jsonNames = (columns: string[], ids: string[]): Condition[] => {
  return columns.flatMap((column) => {
    return ids.map((id) => {
      return db.sequelize.where(
        db.sequelize.fn(
          'strpos',
          db.sequelize.cast(db.sequelize.col(column), 'text'),
          JSON.stringify(id)
        ),
        Op.gt,
        0
      );
    });
  });
};

/** A foreign-key match, or none when there is no row id to match. */
const rowIdIn = (field: string, rowIds: number[]): Condition[] => {
  return rowIds.length > 0 ? [{ [field]: rowIds }] : [];
};

/** The public ids found in the last round, and the row ids of its agents and tools. */
type Frontier = { ids: string[]; agentRowIds: number[]; toolRowIds: number[] };

type Row = { id?: number; publicId: string };

const ROW = {
  attributes: ['id', 'publicId'],
  order: [['id', 'ASC']] as [string, string][],
};

type HolderWhere = { projectId: number; [Op.or]: Condition[] };

type Holder = {
  type: ShareReference['type'];
  find: (where: HolderWhere) => Promise<Row[]>;
  /** Where a row of this type names something in the frontier. */
  names: (frontier: Frontier) => Condition[];
};

/**
 * Every type of grantee resource that names another, and the fields it names
 * it in. The order is the order a listing returns them in.
 */
const HOLDERS: Holder[] = [
  {
    type: 'agent',
    find: (where) => {
      return db.Agent.findAll({ where, ...ROW });
    },
    names: ({ ids }) => {
      return jsonNames(['tool_bindings', 'active_tool_ids', 'step_rules'], ids);
    },
  },
  {
    type: 'tool',
    find: (where) => {
      return db.Tool.findAll({ where, ...ROW });
    },
    names: ({ ids }) => {
      return jsonNames(['pipeline'], ids);
    },
  },
  {
    type: 'decider',
    find: (where) => {
      return db.Decider.findAll({ where, ...ROW });
    },
    names: ({ agentRowIds, toolRowIds }) => {
      return [
        ...rowIdIn('agentId', agentRowIds),
        ...rowIdIn('toolId', toolRowIds),
      ];
    },
  },
  {
    type: 'ingestion_rule',
    find: (where) => {
      return db.IngestionRule.findAll({ where, ...ROW });
    },
    names: ({ ids }) => {
      return [{ toolPublicId: ids }, { agentPublicId: ids }];
    },
  },
  {
    type: 'orchestration',
    find: (where) => {
      return db.Orchestration.findAll({ where, ...ROW });
    },
    names: ({ ids }) => {
      return jsonNames(['nodes'], ids);
    },
  },
  {
    type: 'workflow',
    find: (where) => {
      return db.Workflow.findAll({ where, ...ROW });
    },
    names: ({ ids }) => {
      return jsonNames(['states'], ids);
    },
  },
  {
    type: 'playbook',
    find: (where) => {
      return db.Playbook.findAll({ where, ...ROW });
    },
    names: ({ ids }) => {
      return jsonNames(['definition'], ids);
    },
  },
  {
    type: 'eval',
    find: (where) => {
      return db.Eval.findAll({ where, ...ROW });
    },
    names: ({ ids, agentRowIds }) => {
      return [
        ...rowIdIn('agentId', agentRowIds),
        ...jsonNames(['scorers'], ids),
      ];
    },
  },
  {
    type: 'trigger',
    find: (where) => {
      return db.Trigger.findAll({ where, ...ROW });
    },
    names: ({ ids }) => {
      return [{ targetId: ids }];
    },
  },
  {
    type: 'formation',
    find: (where) => {
      return db.Formation.findAll({ where, ...ROW });
    },
    names: ({ ids }) => {
      return jsonNames(['template'], ids);
    },
  },
];

const findNaming = async (args: {
  holder: Holder;
  projectId: number;
  frontier: Frontier;
}): Promise<Row[]> => {
  const names = args.holder.names(args.frontier);
  if (names.length === 0) return [];
  return args.holder.find({ projectId: args.projectId, [Op.or]: names });
};

const rowIdsOf = (rows: Row[]): number[] => {
  return rows.flatMap((row) => {
    return row.id === undefined ? [] : [row.id];
  });
};

const frontierOf = (
  added: Array<{ type: ShareReference['type']; rows: Row[] }>
): Frontier => {
  const rowsOf = (type: ShareReference['type']): Row[] => {
    return added.flatMap((entry) => {
      return entry.type === type ? entry.rows : [];
    });
  };
  return {
    ids: added.flatMap(({ rows }) => {
      return rows.map((row) => {
        return row.publicId;
      });
    }),
    agentRowIds: rowIdsOf(rowsOf('agent')),
    toolRowIds: rowIdsOf(rowsOf('tool')),
  };
};

/**
 * Every resource in `projectId` a run reaches the shared tool or agent
 * `resourceId` from — naming it, or naming one of the project's own resources
 * that does: what degrades if the project's acceptance is revoked. Answers
 * both `GET /shares/{id}/references` and the grantee's revoke refusal, so the
 * two cannot disagree.
 */
export const findShareReferences = async (args: {
  resourceType: string;
  resourceId: string;
  projectId: number;
}): Promise<ShareReference[]> => {
  log(
    'findShareReferences: %s %s projectId=%d',
    args.resourceType,
    args.resourceId,
    args.projectId
  );
  const seen = new Set<string>([args.resourceId]);
  const found = new Map<ShareReference['type'], Row[]>();
  let frontier: Frontier = {
    ids: [args.resourceId],
    agentRowIds: [],
    toolRowIds: [],
  };

  while (frontier.ids.length > 0) {
    const current = frontier;
    const rounds = await Promise.all(
      HOLDERS.map(async (holder) => {
        const rows = await findNaming({
          holder,
          projectId: args.projectId,
          frontier: current,
        });
        return { holder, rows };
      })
    );
    const added = rounds.map(({ holder, rows }) => {
      const fresh = rows.filter((row) => {
        return !seen.has(row.publicId);
      });
      for (const row of fresh) seen.add(row.publicId);
      found.set(holder.type, [...(found.get(holder.type) ?? []), ...fresh]);
      return { type: holder.type, rows: fresh };
    });
    frontier = frontierOf(added);
  }

  return HOLDERS.flatMap((holder) => {
    return (found.get(holder.type) ?? []).map((row) => {
      return { type: holder.type, id: row.publicId };
    });
  });
};

/** What `projectId` names of the resource share `id` grants it. */
export const listShareReferences = async (args: {
  id: string;
  projectId: number;
  limit?: number;
  cursor?: string;
}): Promise<Page<ShareReference>> => {
  const share = await shares.getByPublicId({ id: args.id });
  return pageOf({
    items: await findShareReferences({
      resourceType: share.resourceType,
      resourceId: share.resourceId,
      projectId: args.projectId,
    }),
    limit: args.limit,
    cursor: args.cursor,
    filters: { id: args.id, projectId: args.projectId },
  });
};
