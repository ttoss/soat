import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { paginatedList } from './pagination';
import { advancePlaybookCase } from './playbookCascade';
import {
  mapPlaybookCase,
  playbookCases,
  versionDefinition,
  withLockedCase,
} from './playbookCases';
import { assertNotOwnWork } from './playbookSelfWrite';
import { playbookUpgradeDiff } from './playbookUpgrade';
import { createdByColumns, type RequestPrincipal } from './principals';

const log = createDebug('soat:playbookCases');

type UpgradeRow = InstanceType<(typeof db)['PlaybookUpgrade']>;

const mapPlaybookUpgrade = (args: {
  row: UpgradeRow;
  casePublicId: string;
}) => {
  const { row } = args;
  return {
    id: row.publicId,
    case_id: args.casePublicId,
    from_version: row.fromVersion,
    to_version: row.toVersion,
    diff: row.diff,
    created_by_principal_type: row.createdByPrincipalType,
    created_by_principal_id: row.createdByPrincipalId,
    created_at: row.createdAt,
  };
};

/** The version named, which the playbook must have; else its current one. */
const readTargetVersion = async (args: {
  playbookId: number;
  current: number;
  version: unknown;
}): Promise<number> => {
  if (args.version === undefined) return args.current;
  const exists =
    Number.isInteger(args.version) &&
    (await db.PlaybookVersion.count({
      where: { playbookId: args.playbookId, version: args.version as number },
    })) > 0;
  if (!exists) {
    throw new DomainError(
      'VALIDATION_FAILED',
      "version must name a version of the case's playbook.",
      { version: args.version }
    );
  }
  return args.version as number;
};

/**
 * Moves a case to another version of its playbook, its current one unless one
 * is named, and records what moved. Values carry over by node key and the node
 * states are read against the new version. Refused while an execution runs: it
 * would settle against nodes the new version may not have. An execution queued
 * but not started settles `superseded`, and the cascade then queues what the
 * new version makes runnable.
 */
export const upgradePlaybookCase = async (args: {
  projectIds?: number[];
  id: string;
  version: unknown;
  createdBy: RequestPrincipal | null;
  runWorkPublicId?: string;
}) => {
  log('upgradePlaybookCase: id=%s version=%s', args.id, args.version);
  const row = await playbookCases.getByPublicId(args);
  await assertNotOwnWork({
    caseDbId: row.id as number,
    casePublicId: row.publicId,
    runWorkPublicId: args.runWorkPublicId,
  });
  const target = await readTargetVersion({
    playbookId: row.playbookId,
    current: row.playbook.version,
    version: args.version,
  });
  const to = await versionDefinition({ row, version: target });

  const upgraded = await withLockedCase({
    row,
    work: async ({ locked, transaction }) => {
      const from = locked.playbookVersion;
      if (from === target) return false;

      const running = await db.PlaybookExecution.findAll({
        where: { caseId: locked.id as number, status: 'running' },
        attributes: ['publicId', 'node'],
        transaction,
      });
      if (running.length > 0) {
        throw new DomainError(
          'PLAYBOOK_CASE_BUSY',
          `Case '${row.publicId}' has ${running.length} execution(s) running.`,
          {
            executions: running.map((execution) => {
              return { id: execution.publicId, node: execution.node };
            }),
          }
        );
      }
      await db.PlaybookExecution.update(
        { status: 'succeeded', result: 'superseded', finishedAt: new Date() },
        {
          where: { caseId: locked.id as number, status: 'pending' },
          transaction,
        }
      );

      await db.PlaybookUpgrade.create(
        {
          caseId: locked.id as number,
          fromVersion: from,
          toVersion: target,
          diff: playbookUpgradeDiff({
            from: await versionDefinition({ row, version: from }),
            to,
          }),
          ...createdByColumns(args.createdBy),
        },
        { transaction }
      );
      locked.playbookVersion = target;
      await locked.save({ transaction });
      return true;
    },
  });

  if (upgraded) await advancePlaybookCase({ caseDbId: row.id as number });
  return mapPlaybookCase(await playbookCases.reload(row));
};

export const listPlaybookCaseUpgrades = async (args: {
  projectIds?: number[];
  caseId: string;
  limit?: number;
  offset?: number;
}) => {
  log('listPlaybookCaseUpgrades: case=%s', args.caseId);
  const row = await playbookCases.getByPublicId({
    projectIds: args.projectIds,
    id: args.caseId,
  });

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['id', 'DESC']],
    query: ({ limit, offset, order }) => {
      return db.PlaybookUpgrade.findAndCountAll({
        where: { caseId: row.id as number },
        order,
        limit,
        offset,
      });
    },
    map: (upgrade) => {
      return mapPlaybookUpgrade({
        row: upgrade as UpgradeRow,
        casePublicId: row.publicId,
      });
    },
  });
};
