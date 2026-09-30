import { db } from '../db';
import { DomainError, type ErrorCode } from '../errors';
import { findShareableType } from './shareableTypes';
import { PUBLIC_GRANTEE } from './shares';

/**
 * Where a tool or agent named by id — in a stored field or in a request that
 * runs it — is resolved: in `projectId`, the project of the row or run that
 * holds the reference, never the caller's scope, so a credential reaching
 * several projects cannot let one project's row name another's resource.
 *
 * `reach` is required so every site states whether the reference may also be
 * a resource another project shares with `projectId` (`'shares'`) or only one
 * of its own (`'project'`).
 *
 * Every such lookup goes through here, pinned by
 * `tests/harness/resourceReferences.test.mjs`, so the rule is answered once.
 */
type ToolRow = InstanceType<(typeof db)['Tool']>;
type AgentRow = InstanceType<(typeof db)['Agent']>;

/**
 * `'shares'` also resolves a resource another project shares with
 * `projectId` through an accepted, unsuspended, unrevoked share that grants
 * the type's action. The row returned is the owner's.
 */
export type ReferenceReach = 'project' | 'shares';

type ReferenceArgs = { projectId: number; reach: ReferenceReach };

export type ReferenceResolver<Row> = {
  /** The referenced row, or `null` when it does not resolve. */
  find: (args: ReferenceArgs & { id: string }) => Promise<Row | null>;
  /** The referenced rows that resolve, keyed by public id. */
  findMany: (
    args: ReferenceArgs & { ids: string[] }
  ) => Promise<Map<string, Row>>;
  /**
   * The referenced rows, keyed by public id; throws the type's
   * `*_NOT_FOUND` with `meta.missing` for every id that does not resolve.
   */
  requireMany: (
    args: ReferenceArgs & { ids: string[] }
  ) => Promise<Map<string, Row>>;
};

/**
 * The owner project of each id `projectId` may use through a share of type
 * `resourceType`, keyed by resource id.
 */
const findSharedOwners = async (args: {
  resourceType: string;
  ids: string[];
  projectId: number;
}): Promise<Map<string, number>> => {
  const grantable = findShareableType(args.resourceType)?.actions ?? [];
  const project = await db.Project.findByPk(args.projectId, {
    attributes: ['publicId'],
  });
  if (!project || grantable.length === 0) return new Map();

  const shares = await db.Share.findAll({
    where: {
      resourceType: args.resourceType,
      resourceId: args.ids,
      grantee: [project.publicId, PUBLIC_GRANTEE],
      suspendedAt: null,
      revokedAt: null,
    },
    include: [
      {
        model: db.ShareAcceptance,
        as: 'acceptances',
        required: true,
        where: { projectId: args.projectId, status: 'active' },
      },
    ],
  });

  const owners = new Map<string, number>();
  for (const share of shares) {
    const grantsAction = share.actions.some((action) => {
      return grantable.includes(action);
    });
    if (grantsAction && share.projectId !== args.projectId) {
      owners.set(share.resourceId, share.projectId);
    }
  }
  return owners;
};

const makeReferenceResolver = <Row extends { publicId: string }>(resolver: {
  findAll: (where: { publicId: string[]; projectId: number }) => Promise<Row[]>;
  resourceType: string;
  notFoundCode: ErrorCode;
  label: string;
}): ReferenceResolver<Row> => {
  const findMany = async (
    args: ReferenceArgs & { ids: string[] }
  ): Promise<Map<string, Row>> => {
    if (args.ids.length === 0) return new Map();
    const ids = [...new Set(args.ids)];
    const own = await resolver.findAll({
      publicId: ids,
      projectId: args.projectId,
    });
    const found = new Map(
      own.map((row) => {
        return [row.publicId, row];
      })
    );
    const missing = ids.filter((id) => {
      return !found.has(id);
    });
    if (args.reach === 'project' || missing.length === 0) return found;

    const owners = await findSharedOwners({
      resourceType: resolver.resourceType,
      ids: missing,
      projectId: args.projectId,
    });
    for (const [id, ownerProjectId] of owners) {
      const [row] = await resolver.findAll({
        publicId: [id],
        projectId: ownerProjectId,
      });
      if (row) found.set(id, row);
    }
    return found;
  };

  return {
    find: async (args) => {
      const found = await findMany({ ...args, ids: [args.id] });
      return found.get(args.id) ?? null;
    },

    findMany,

    requireMany: async (args) => {
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
    resourceType: 'tool',
    notFoundCode: 'TOOL_NOT_FOUND',
    label: 'Tool',
  }
);

export const agentReferences: ReferenceResolver<AgentRow> =
  makeReferenceResolver({
    findAll: (where) => {
      return db.Agent.findAll({ where });
    },
    resourceType: 'agent',
    notFoundCode: 'AGENT_NOT_FOUND',
    label: 'Agent',
  });
