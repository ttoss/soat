import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';
import { paginatedList, type PaginatedResult } from './pagination';
import { advancePlaybookCase } from './playbookCascade';
import {
  conformsToInputSchema,
  snapshotFromRecords,
} from './playbookCaseState';
import type { PlaybookDefinition } from './playbookDefinition';
import { playbooks } from './playbooks';
import { type PlaybookCaseSnapshot, playbookNodeStates } from './playbookState';
import { playbookVersionStore } from './playbookVersionSnapshot';
import { parsePlaybookDefinition } from './playbookWire';
import { makeResourceAccessor } from './resourceAccessor';
import { toResourceRef } from './resourceVersions';

const log = createDebug('soat:playbookCases');

export type PlaybookCaseRow = InstanceType<(typeof db)['PlaybookCase']> & {
  project: { publicId: string };
  playbook: InstanceType<(typeof db)['Playbook']>;
};

const caseIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Playbook, as: 'playbook' },
  ];
};

export const playbookCases = makeResourceAccessor<PlaybookCaseRow>({
  model: () => {
    return db.PlaybookCase;
  },
  includes: caseIncludes,
  label: 'Playbook case',
});

/** The definition a version of the case's playbook holds. */
export const versionDefinition = async (args: {
  row: PlaybookCaseRow;
  version: number;
}): Promise<PlaybookDefinition> => {
  const version = await playbookVersionStore.findVersionRow({
    resource: toResourceRef(args.row.playbook),
    version: args.version,
  });
  const config = playbookVersionStore.readArchivedConfig(version);
  return parsePlaybookDefinition({ definition: config.definition });
};

/** The definition of the version a case is pinned to. */
export const caseDefinition = (args: {
  row: PlaybookCaseRow;
}): Promise<PlaybookDefinition> => {
  return versionDefinition({
    row: args.row,
    version: args.row.playbookVersion,
  });
};

export const caseSnapshot = async (args: {
  caseDbId: number;
  transaction?: Transaction;
}): Promise<PlaybookCaseSnapshot> => {
  const [entries, executions] = await Promise.all([
    db.PlaybookEntry.findAll({
      where: { caseId: args.caseDbId },
      order: [['revision', 'ASC']],
      transaction: args.transaction,
    }),
    db.PlaybookExecution.findAll({
      where: { caseId: args.caseDbId },
      order: [['id', 'ASC']],
      transaction: args.transaction,
    }),
  ]);
  return snapshotFromRecords({ entries, executions });
};

const mapNodes = (args: {
  definition: PlaybookDefinition;
  snapshot: PlaybookCaseSnapshot;
}) => {
  // One view per node, in definition order.
  const views = [
    ...playbookNodeStates({
      ...args,
      conforms: conformsToInputSchema,
    }).values(),
  ];

  return args.definition.nodes.map((node, index) => {
    const view = views[index];
    const output = args.snapshot[node.key]?.output;

    return {
      key: node.key,
      state: view.state,
      missing: view.missing,
      waiting: view.waiting,
      inputs: node.inputs.map((input) => {
        return {
          name: input.name,
          value: view.values[input.name] ?? null,
          revision: view.basis[input.name]?.revision ?? null,
        };
      }),
      output: output
        ? { value: output.value, revision: output.revision }
        : null,
    };
  });
};

export const AUTOMATION_STATUSES = ['idle', 'running', 'paused'] as const;

/**
 * `paused` while a pause stands, else `running` while any execution is
 * pending or running, else `idle`: what a spend stop lists to find a case
 * with work in flight.
 */
const automationFields = (args: {
  row: PlaybookCaseRow;
  inFlight: boolean;
}) => {
  const { row } = args;
  const status: (typeof AUTOMATION_STATUSES)[number] = row.pauseRequestedAt
    ? 'paused'
    : args.inFlight
      ? 'running'
      : 'idle';
  return {
    automation_status: status,
    pause_requested_at: row.pauseRequestedAt,
  };
};

/** Every case holding a `pending` or `running` execution. */
const inFlightCaseIds = () => {
  return db.sequelize.literal(
    "(SELECT case_id FROM playbook_executions WHERE status IN ('pending', 'running'))"
  );
};

const automationWhere = (status: string | undefined) => {
  if (status === undefined) return {};
  if (!(AUTOMATION_STATUSES as readonly string[]).includes(status)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `automation_status must be one of ${AUTOMATION_STATUSES.join(', ')}.`
    );
  }
  if (status === 'paused') return { pauseRequestedAt: { [Op.ne]: null } };
  return {
    pauseRequestedAt: null,
    id: { [status === 'running' ? Op.in : Op.notIn]: inFlightCaseIds() },
  };
};

export const mapPlaybookCase = async (row: PlaybookCaseRow) => {
  const [definition, snapshot] = await Promise.all([
    caseDefinition({ row }),
    caseSnapshot({ caseDbId: row.id as number }),
  ]);

  return {
    id: row.publicId,
    project_id: row.project.publicId,
    playbook_id: row.playbook.publicId,
    playbook_version: row.playbookVersion,
    subject: row.subject,
    revision: row.revision,
    ...automationFields({
      row,
      inFlight: Object.values(snapshot).some((record) => {
        return record.execution
          ? ['pending', 'running'].includes(record.execution.status)
          : false;
      }),
    }),
    nodes: mapNodes({ definition, snapshot }),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
};

export type MappedPlaybookCase = Awaited<ReturnType<typeof mapPlaybookCase>>;

/** A case outside a list: the listing carries no node states. */
const mapCaseSummary = (row: PlaybookCaseRow, inFlight: boolean) => {
  return {
    id: row.publicId,
    project_id: row.project.publicId,
    playbook_id: row.playbook.publicId,
    playbook_version: row.playbookVersion,
    subject: row.subject,
    revision: row.revision,
    ...automationFields({ row, inFlight }),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
};

export const createPlaybookCase = async (args: {
  projectIds?: number[];
  playbookId: string;
  subject: unknown;
}): Promise<MappedPlaybookCase> => {
  log('createPlaybookCase: playbookId=%s', args.playbookId);
  if (typeof args.subject !== 'string' || args.subject.trim() === '') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'subject is required and must be a non-empty string.'
    );
  }

  const playbook = await playbooks.getByPublicId({
    projectIds: args.projectIds,
    id: args.playbookId,
  });
  // A case runs on the version it was created on; editing the playbook later
  // never reshapes it.
  const created = await db.PlaybookCase.create({
    projectId: playbook.projectId,
    playbookId: playbook.id as number,
    playbookVersion: playbook.version,
    subject: args.subject,
  });

  log('createPlaybookCase: created id=%s', created.publicId);
  await advancePlaybookCase({ caseDbId: created.id as number });
  return mapPlaybookCase(await playbookCases.reload(created));
};

export const listPlaybookCases = async (args: {
  projectIds?: number[];
  playbookId?: string;
  automationStatus?: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<ReturnType<typeof mapCaseSummary>>> => {
  log('listPlaybookCases: projectIds=%o', args.projectIds);
  const where: Record<string, unknown> = automationWhere(args.automationStatus);
  if (args.projectIds !== undefined) where.projectId = args.projectIds;
  if (args.playbookId !== undefined) {
    const playbook = await playbooks.findByPublicId({
      projectIds: args.projectIds,
      id: args.playbookId,
    });
    // An unknown or unreachable playbook filters to nothing, never to all.
    where.playbookId = (playbook?.id as number | undefined) ?? -1;
  }

  const page = await paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['createdAt', 'DESC']],
    query: ({ limit, offset, order }) => {
      return db.PlaybookCase.findAndCountAll({
        where,
        include: caseIncludes(),
        distinct: true,
        order,
        limit,
        offset,
      });
    },
    map: (row) => {
      return row as PlaybookCaseRow;
    },
  });
  const inFlight = await db.PlaybookExecution.findAll({
    where: {
      caseId: page.data.map((row) => {
        return row.id as number;
      }),
      status: ['pending', 'running'],
    },
    attributes: ['caseId'],
  });
  const flying = new Set(
    inFlight.map((execution) => {
      return execution.caseId;
    })
  );
  return {
    ...page,
    data: page.data.map((row) => {
      return mapCaseSummary(row, flying.has(row.id as number));
    }),
  };
};

export const getPlaybookCase = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedPlaybookCase> => {
  log('getPlaybookCase: id=%s', args.id);
  return mapPlaybookCase(await playbookCases.getByPublicId(args));
};

export const deletePlaybookCase = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<void> => {
  log('deletePlaybookCase: id=%s', args.id);
  const row = await playbookCases.getByPublicId(args);
  // Entries cascade with the case.
  await row.destroy();
};
