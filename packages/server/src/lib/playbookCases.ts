import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';
import { paginatedList, type PaginatedResult } from './pagination';
import { advancePlaybookCase } from './playbookCascade';
import { automationWhere, caseAutomation } from './playbookCaseAutomation';
import {
  conformsToInputSchema,
  snapshotFromRecords,
} from './playbookCaseState';
import type { JsonValue, PlaybookDefinition } from './playbookDefinition';
import { type PlaybookNodeRun, playbookNodeRuns } from './playbookNodeRuns';
import { playbooks } from './playbooks';
import {
  type PlaybookBasis,
  type PlaybookCaseSnapshot,
  playbookNodeStates,
  type PlaybookNodeView,
} from './playbookState';
import { playbookVersionStore } from './playbookVersionSnapshot';
import { parsePlaybookDefinition } from './playbookWire';
import { createdByColumns, type RequestPrincipal } from './principals';
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

/**
 * Every node's state in a case, with each input's schema deciding what counts
 * as set. The one read of node states, so no reader can count a value its
 * schema refuses.
 */
export const caseNodeStates = async (args: {
  caseDbId: number;
  definition: PlaybookDefinition;
  transaction?: Transaction;
}): Promise<{
  snapshot: PlaybookCaseSnapshot;
  views: Map<string, PlaybookNodeView>;
}> => {
  const snapshot = await caseSnapshot(args);
  return {
    snapshot,
    views: playbookNodeStates({
      definition: args.definition,
      snapshot,
      conforms: conformsToInputSchema,
    }),
  };
};

type CaseRow = InstanceType<(typeof db)['PlaybookCase']>;

/** The case row under its update lock; null once the case is deleted. */
export const lockCase = (args: {
  caseDbId: number;
  transaction: Transaction;
}): Promise<CaseRow | null> => {
  return db.PlaybookCase.findByPk(args.caseDbId, {
    lock: args.transaction.LOCK.UPDATE,
    transaction: args.transaction,
  });
};

/**
 * Runs `work` holding the case's lock. Every write to a case locks the case
 * before any of its rows, so the revision counter and every state check read
 * what the previous writer committed.
 */
export const withLockedCase = <T>(args: {
  row: { id?: unknown; publicId: string };
  work: (locked: { locked: CaseRow; transaction: Transaction }) => Promise<T>;
}): Promise<T> => {
  return db.sequelize.transaction(async (transaction) => {
    const locked = await lockCase({
      caseDbId: args.row.id as number,
      transaction,
    });
    if (!locked) throw playbookCases.notFound(args.row.publicId);
    return args.work({ locked, transaction });
  });
};

/** Refuses to start work in a paused case. */
export const assertCaseAcceptsWork = (args: {
  locked: CaseRow;
  publicId: string;
}): void => {
  if (args.locked.pauseRequestedAt) {
    throw new DomainError(
      'PLAYBOOK_CASE_PAUSED',
      `Case '${args.publicId}' is paused.`
    );
  }
};

export type PlaybookEntryWrite = {
  node: string;
  kind: 'input' | 'output' | 'confirmation' | 'rejection';
  field: string | null;
  value: JsonValue | Record<string, unknown>;
  basis: PlaybookBasis | null;
  playbookVersion: number;
  createdBy: RequestPrincipal | null;
};

/**
 * Appends entries to a locked case, each at the next revision of the case's
 * one counter; answers the revisions written.
 */
export const appendEntries = async (args: {
  locked: CaseRow;
  entries: PlaybookEntryWrite[];
  transaction: Transaction;
}): Promise<number[]> => {
  const { locked, transaction } = args;
  const revisions: number[] = [];
  for (const { createdBy, ...entry } of args.entries) {
    const revision = locked.revision + revisions.length + 1;
    await db.PlaybookEntry.create(
      {
        ...entry,
        ...createdByColumns(createdBy),
        caseId: locked.id as number,
        revision,
      },
      { transaction }
    );
    revisions.push(revision);
  }
  if (revisions.length > 0) {
    locked.revision += revisions.length;
    await locked.save({ transaction });
  }
  return revisions;
};

const mapNodes = (args: {
  definition: PlaybookDefinition;
  snapshot: PlaybookCaseSnapshot;
  views: Map<string, PlaybookNodeView>;
  runs: Map<string, PlaybookNodeRun>;
}) => {
  // One view per node, in definition order.
  const views = [...args.views.values()];

  return args.definition.nodes.map((node, index) => {
    const view = views[index];
    const output = args.snapshot[node.key]?.output;

    return {
      key: node.key,
      state: view.state,
      missing: view.missing,
      blocked_by: view.blockedBy,
      run: args.runs.get(node.key) ?? null,
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

export const mapPlaybookCase = async (row: PlaybookCaseRow) => {
  const definition = await caseDefinition({ row });
  const { snapshot, views } = await caseNodeStates({
    caseDbId: row.id as number,
    definition,
  });

  return {
    id: row.publicId,
    project_id: row.project.publicId,
    playbook_id: row.playbook.publicId,
    playbook_version: row.playbookVersion,
    subject: row.subject,
    revision: row.revision,
    ...(await caseAutomation({ rows: [row] }))(row),
    nodes: mapNodes({
      definition,
      snapshot,
      views,
      runs: await playbookNodeRuns({ snapshot }),
    }),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
};

export type MappedPlaybookCase = Awaited<ReturnType<typeof mapPlaybookCase>>;

/** A case outside a list: the listing carries no node states. */
const mapCaseSummary = (
  row: PlaybookCaseRow,
  automation: Awaited<ReturnType<typeof caseAutomation>>
) => {
  return {
    id: row.publicId,
    project_id: row.project.publicId,
    playbook_id: row.playbook.publicId,
    playbook_version: row.playbookVersion,
    subject: row.subject,
    revision: row.revision,
    ...automation(row),
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
  const where: Record<string | symbol, unknown> = automationWhere(
    args.automationStatus
  );
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
  const automation = await caseAutomation({ rows: page.data });
  return {
    ...page,
    data: page.data.map((row) => {
      return mapCaseSummary(row, automation);
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
