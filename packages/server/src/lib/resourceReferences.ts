import { db } from '../db';
import { DomainError, type ErrorCode } from '../errors';

/**
 * Where a tool or agent named by id — in a stored field or in a request that
 * runs it — is resolved. Always in `projectId`, the project of the row or run
 * that holds the reference, never the caller's scope: a credential reaching
 * several projects must not let one project's row name another's resource.
 *
 * Every such lookup goes through here, pinned by
 * `tests/harness/resourceReferences.test.mjs`, so the rule is answered once.
 */
type ToolRow = InstanceType<(typeof db)['Tool']>;
type AgentRow = InstanceType<(typeof db)['Agent']>;

export type ReferenceResolver<Row> = {
  /** The referenced row, or `null` when it is not in `projectId`. */
  find: (args: { id: string; projectId: number }) => Promise<Row | null>;
  /** The referenced rows found in `projectId`, keyed by public id. */
  findMany: (args: {
    ids: string[];
    projectId: number;
  }) => Promise<Map<string, Row>>;
  /**
   * The referenced rows, keyed by public id; throws the type's
   * `*_NOT_FOUND` with `meta.missing` for every id not in `projectId`.
   */
  requireMany: (args: {
    ids: string[];
    projectId: number;
  }) => Promise<Map<string, Row>>;
};

const makeReferenceResolver = <Row extends { publicId: string }>(resolver: {
  findAll: (where: { publicId: string[]; projectId: number }) => Promise<Row[]>;
  notFoundCode: ErrorCode;
  label: string;
}): ReferenceResolver<Row> => {
  const findMany = async (args: {
    ids: string[];
    projectId: number;
  }): Promise<Map<string, Row>> => {
    if (args.ids.length === 0) return new Map();
    const rows = await resolver.findAll({
      publicId: [...new Set(args.ids)],
      projectId: args.projectId,
    });
    return new Map(
      rows.map((row) => {
        return [row.publicId, row];
      })
    );
  };

  return {
    find: async (args: {
      id: string;
      projectId: number;
    }): Promise<Row | null> => {
      const found = await findMany({
        ids: [args.id],
        projectId: args.projectId,
      });
      return found.get(args.id) ?? null;
    },

    findMany,

    requireMany: async (args: {
      ids: string[];
      projectId: number;
    }): Promise<Map<string, Row>> => {
      const found = await findMany(args);
      const missing = [...new Set(args.ids)].filter((id) => {
        return !found.has(id);
      });
      if (missing.length > 0) {
        throw new DomainError(
          resolver.notFoundCode,
          `${resolver.label}(s) not found in the project: ${missing.join(', ')}.`,
          { missing }
        );
      }
      return found;
    },
  };
};

export const toolReferences: ReferenceResolver<ToolRow> = makeReferenceResolver(
  {
    findAll: (where) => {
      return db.Tool.findAll({ where });
    },
    notFoundCode: 'TOOL_NOT_FOUND',
    label: 'Tool',
  }
);

export const agentReferences: ReferenceResolver<AgentRow> =
  makeReferenceResolver({
    findAll: (where) => {
      return db.Agent.findAll({ where });
    },
    notFoundCode: 'AGENT_NOT_FOUND',
    label: 'Agent',
  });
