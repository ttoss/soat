import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';
import { paginatedList, type PaginatedResult } from './pagination';
import {
  conformsToInputSchema,
  snapshotFromEntries,
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

/** The definition of the version a case is pinned to. */
export const caseDefinition = async (args: {
  row: PlaybookCaseRow;
}): Promise<PlaybookDefinition> => {
  const { row } = args;
  const version = await playbookVersionStore.findVersionRow({
    resource: toResourceRef(row.playbook),
    version: row.playbookVersion,
  });
  const config = playbookVersionStore.readArchivedConfig(version);
  return parsePlaybookDefinition({ definition: config.definition });
};

export const caseSnapshot = async (args: {
  caseDbId: number;
  transaction?: Transaction;
}): Promise<PlaybookCaseSnapshot> => {
  const entries = await db.PlaybookEntry.findAll({
    where: { caseId: args.caseDbId },
    order: [['revision', 'ASC']],
    transaction: args.transaction,
  });
  return snapshotFromEntries({ entries });
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
      output: null,
    };
  });
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
    nodes: mapNodes({ definition, snapshot }),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
};

export type MappedPlaybookCase = Awaited<ReturnType<typeof mapPlaybookCase>>;

/** A case outside a list: the listing carries no node states. */
const mapCaseSummary = (row: PlaybookCaseRow) => {
  return {
    id: row.publicId,
    project_id: row.project.publicId,
    playbook_id: row.playbook.publicId,
    playbook_version: row.playbookVersion,
    subject: row.subject,
    revision: row.revision,
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
  return mapPlaybookCase(await playbookCases.reload(created));
};

export const listPlaybookCases = async (args: {
  projectIds?: number[];
  playbookId?: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<ReturnType<typeof mapCaseSummary>>> => {
  log('listPlaybookCases: projectIds=%o', args.projectIds);
  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) where.projectId = args.projectIds;
  if (args.playbookId !== undefined) {
    const playbook = await playbooks.findByPublicId({
      projectIds: args.projectIds,
      id: args.playbookId,
    });
    // An unknown or unreachable playbook filters to nothing, never to all.
    where.playbookId = (playbook?.id as number | undefined) ?? -1;
  }

  return paginatedList({
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
      return mapCaseSummary(row as PlaybookCaseRow);
    },
  });
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
