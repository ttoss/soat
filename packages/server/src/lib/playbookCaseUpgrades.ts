import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';
import type { OnBehalfOf } from './onBehalfOf';
import { paginatedList } from './pagination';
import { advancePlaybookCase } from './playbookCascade';
import { conformsToInputSchema } from './playbookCaseState';
import {
  caseSnapshot,
  type PlaybookCaseRow,
  playbookCases,
  versionDefinition,
  withLockedCase,
} from './playbookCaseStore';
import { rebindCaseUpstreams } from './playbookCaseUpstreams';
import { answerPlaybookCase } from './playbookCaseWait';
import type { PlaybookDefinition } from './playbookDefinition';
import { assertNotOwnWork } from './playbookSelfWrite';
import type { PlaybookCaseSnapshot } from './playbookState';
import { playbookUpgradeDiff } from './playbookUpgrade';
import {
  createdByColumns,
  type RequestPrincipal,
  servedPrincipal,
} from './principals';

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
    ...servedPrincipal({
      row,
      prefix: 'createdBy',
      wire: 'created_by_',
    }),
    on_behalf_of: row.onBehalfOf ?? null,
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
 * Refused while an execution runs: it would settle against nodes the new
 * version may not have. One queued but not started settles `superseded`.
 */
const clearExecutions = async (args: {
  caseDbId: number;
  publicId: string;
  transaction: Transaction;
}): Promise<void> => {
  const running = await db.PlaybookExecution.findAll({
    where: { caseId: args.caseDbId, status: 'running' },
    attributes: ['publicId', 'node'],
    transaction: args.transaction,
  });
  if (running.length > 0) {
    throw new DomainError(
      'PLAYBOOK_CASE_BUSY',
      `Case '${args.publicId}' has ${running.length} execution(s) running.`,
      {
        executions: running.map((execution) => {
          return { id: execution.publicId, node_id: execution.node };
        }),
      }
    );
  }
  await db.PlaybookExecution.update(
    { status: 'completed', result: 'superseded', finishedAt: new Date() },
    {
      where: { caseId: args.caseDbId, status: 'queued' },
      transaction: args.transaction,
    }
  );
};

/**
 * The manual inputs whose stored value the version's schema refuses, read as
 * the node states read a value: through `conformsToInputSchema`.
 */
const nonconformingInputs = (args: {
  definition: PlaybookDefinition;
  snapshot: PlaybookCaseSnapshot;
}): { node_id: string; name: string }[] => {
  return args.definition.nodes.flatMap((node) => {
    return node.inputs
      .filter((input) => {
        const stored = args.snapshot[node.id]?.inputs?.[input.name];
        return (
          input.source === 'manual' &&
          stored !== undefined &&
          !conformsToInputSchema({ node, input, value: stored.value })
        );
      })
      .map((input) => {
        return { node_id: node.id, name: input.name };
      });
  });
};

const assertInputsConform = async (args: {
  caseDbId: number;
  definition: PlaybookDefinition;
  version: number;
  transaction: Transaction;
}): Promise<void> => {
  const inputs = nonconformingInputs({
    definition: args.definition,
    snapshot: await caseSnapshot(args),
  });
  if (inputs.length === 0) return;
  throw new DomainError(
    'PLAYBOOK_INPUT_INVALID',
    `Version ${args.version} refuses ${inputs.length} stored input value(s) of the case.`,
    { version: args.version, inputs }
  );
};

/**
 * Moves a case to `target` and records what moved; `false` when it is already
 * there. Values carry over by node id and the node states are read against the
 * new version, and the bindings are fitted to the upstreams it declares
 * (`rebindCaseUpstreams`). The caller cascades.
 */
export const moveCaseToVersion = async (args: {
  row: PlaybookCaseRow;
  target: number;
  /** The upstreams a caller names; `null` when no caller names any. */
  upstreams: {
    raw: unknown;
    canRead: (casePublicId: string) => Promise<boolean>;
  } | null;
  /** Refuse the move when the target's schemas refuse a stored manual input. */
  refuseNonconformingInputs: boolean;
  createdBy: RequestPrincipal | null;
  onBehalfOf: OnBehalfOf | null;
}): Promise<boolean> => {
  const { row, target } = args;
  const to = await versionDefinition({ row, version: target });

  return withLockedCase({
    row,
    work: async ({ locked, transaction }) => {
      const from = locked.playbookVersion;
      if (args.refuseNonconformingInputs && from !== target) {
        await assertInputsConform({
          caseDbId: locked.id as number,
          definition: to,
          version: target,
          transaction,
        });
      }
      const rebound = await rebindCaseUpstreams({
        caseRow: locked,
        definition: to,
        request: args.upstreams,
        transaction,
      });
      if (from === target) return rebound;

      await clearExecutions({
        caseDbId: locked.id as number,
        publicId: row.publicId,
        transaction,
      });

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
          onBehalfOf: args.onBehalfOf,
        },
        { transaction }
      );
      locked.playbookVersion = target;
      locked.upgradeError = null;
      await locked.save({ transaction });
      return true;
    },
  });
};

/**
 * Moves a case to another version of its playbook, its current one unless one
 * is named. The cascade then queues what the new version makes runnable.
 */
export const upgradePlaybookCase = async (args: {
  projectIds?: number[];
  id: string;
  version: unknown;
  upstreams?: unknown;
  /** Whether the caller may read a case it binds as an upstream. */
  canReadCase: (casePublicId: string) => Promise<boolean>;
  createdBy: RequestPrincipal | null;
  onBehalfOf: OnBehalfOf | null;
  runWorkPublicId?: string;
  wait?: boolean;
}) => {
  log('upgradePlaybookCase: id=%s version=%s', args.id, args.version);
  const row = await playbookCases.getByPublicId(args);
  await assertNotOwnWork({
    caseDbId: row.id as number,
    casePublicId: row.publicId,
    runWorkPublicId: args.runWorkPublicId,
    onBehalfOf: args.onBehalfOf,
  });
  const upgraded = await moveCaseToVersion({
    row,
    target: await readTargetVersion({
      playbookId: row.playbookId,
      current: row.playbook.version,
      version: args.version,
    }),
    upstreams: { raw: args.upstreams, canRead: args.canReadCase },
    refuseNonconformingInputs: false,
    createdBy: args.createdBy,
    onBehalfOf: args.onBehalfOf,
  });

  if (upgraded) await advancePlaybookCase({ caseDbId: row.id as number });
  return answerPlaybookCase({ row, wait: args.wait === true });
};

export const listPlaybookCaseUpgrades = async (args: {
  projectIds?: number[];
  caseId: string;
  limit?: number;
  cursor?: string;
}) => {
  log('listPlaybookCaseUpgrades: case=%s', args.caseId);
  const row = await playbookCases.getByPublicId({
    projectIds: args.projectIds,
    id: args.caseId,
  });

  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: { projectIds: args.projectIds, caseId: args.caseId },
    where: { caseId: row.id as number },
    order: [['createdAt', 'DESC']],
    query: ({ where, limit, order }) => {
      return db.PlaybookUpgrade.findAll({ where, order, limit });
    },
    map: (upgrade) => {
      return mapPlaybookUpgrade({
        row: upgrade as UpgradeRow,
        casePublicId: row.publicId,
      });
    },
  });
};
