import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { paginatedList, type PaginatedResult } from './pagination';
import { advancePlaybookCase } from './playbookCascade';
import { automationWhere, caseAutomation } from './playbookCaseAutomation';
import {
  caseDefinition,
  caseIncludes,
  caseNodeStates,
  type PlaybookCaseRow,
  playbookCases,
} from './playbookCaseStore';
import {
  assertNoDependentCases,
  caseUpstreamIds,
  readCaseBindings,
  writeCaseBindings,
} from './playbookCaseUpstreams';
import type { PlaybookDefinition } from './playbookDefinition';
import { type PlaybookNodeRun, playbookNodeRuns } from './playbookNodeRuns';
import { playbooks } from './playbooks';
import type { PlaybookCaseSnapshot, PlaybookNodeView } from './playbookState';
import { parsePlaybookDefinition } from './playbookWire';

export {
  appendEntries,
  assertCaseAcceptsWork,
  caseDefinition,
  caseNodeStates,
  caseSnapshot,
  caseStates,
  lockCase,
  type PlaybookCaseRow,
  playbookCases,
  type PlaybookEntryWrite,
  versionDefinition,
  withLockedCase,
} from './playbookCaseStore';

const log = createDebug('soat:playbookCases');

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
    const output = args.snapshot[node.id]?.output;

    return {
      id: node.id,
      state: view.state,
      missing: view.missing,
      blocked_by: view.blockedBy,
      run: args.runs.get(node.id) ?? null,
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
    actor_id: row.actor?.publicId ?? null,
    upstreams: (await caseUpstreamIds({ caseDbIds: [row.id as number] }))(
      row.id as number
    ),
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
const mapCaseSummary = (args: {
  row: PlaybookCaseRow;
  automation: Awaited<ReturnType<typeof caseAutomation>>;
  upstreams: Awaited<ReturnType<typeof caseUpstreamIds>>;
}) => {
  const { row, automation } = args;
  return {
    id: row.publicId,
    project_id: row.project.publicId,
    playbook_id: row.playbook.publicId,
    playbook_version: row.playbookVersion,
    subject: row.subject,
    actor_id: row.actor?.publicId ?? null,
    upstreams: args.upstreams(row.id as number),
    revision: row.revision,
    ...automation(row),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
};

/** The actor a case is created for, held to the playbook's project. */
const resolveCaseActorDbId = async (args: {
  actorId: unknown;
  projectId: number;
}): Promise<number | null> => {
  if (args.actorId === undefined || args.actorId === null) return null;
  const actor =
    typeof args.actorId === 'string'
      ? await db.Actor.findOne({
          where: { publicId: args.actorId, projectId: args.projectId },
        })
      : null;
  if (!actor) {
    throw new DomainError(
      'ACTOR_NOT_FOUND',
      `Actor '${String(args.actorId)}' not found in the playbook's project.`
    );
  }
  return actor.id as number;
};

export const createPlaybookCase = async (args: {
  projectIds?: number[];
  playbookId: string;
  subject: unknown;
  actorId?: unknown;
  upstreams?: unknown;
  /** Whether the caller may read a case it binds as an upstream. */
  canReadCase: (casePublicId: string) => Promise<boolean>;
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
  const actorDbId = await resolveCaseActorDbId({
    actorId: args.actorId,
    projectId: playbook.projectId,
  });
  const bindings = await readCaseBindings({
    definition: parsePlaybookDefinition({ definition: playbook.definition }),
    raw: args.upstreams,
    bound: [],
    projectId: playbook.projectId,
    actorDbId,
    canRead: args.canReadCase,
  });
  const subject = args.subject;
  // A case runs on the version it was created on; editing the playbook later
  // never reshapes it.
  const created = await db.sequelize.transaction(async (transaction) => {
    const row = await db.PlaybookCase.create(
      {
        projectId: playbook.projectId,
        playbookId: playbook.id as number,
        playbookVersion: playbook.version,
        subject,
        actorId: actorDbId,
      },
      { transaction }
    );
    await writeCaseBindings({
      caseDbId: row.id as number,
      bindings,
      transaction,
    });
    return row;
  });

  log('createPlaybookCase: created id=%s', created.publicId);
  await advancePlaybookCase({ caseDbId: created.id as number });
  return mapPlaybookCase(await playbookCases.reload(created));
};

export const listPlaybookCases = async (args: {
  projectIds?: number[];
  playbookId?: string;
  actorId?: string;
  subject?: string;
  automationStatuses?: Parameters<typeof automationWhere>[0];
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<ReturnType<typeof mapCaseSummary>>> => {
  log('listPlaybookCases: projectIds=%o', args.projectIds);
  const where: Record<string | symbol, unknown> = automationWhere(
    args.automationStatuses
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
  if (args.actorId !== undefined) {
    const actor = await db.Actor.findOne({
      where: {
        publicId: args.actorId,
        ...(args.projectIds !== undefined && { projectId: args.projectIds }),
      },
    });
    // An unknown or unreachable actor filters to nothing, never to all.
    where.actorId = (actor?.id as number | undefined) ?? -1;
  }
  if (args.subject !== undefined) where.subject = args.subject;

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
  const upstreams = await caseUpstreamIds({
    caseDbIds: page.data.map((row) => {
      return row.id as number;
    }),
  });
  return {
    ...page,
    data: page.data.map((row) => {
      return mapCaseSummary({ row, automation, upstreams });
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

/**
 * Refuses a call pinned to an actor on a case that is not that actor's, as if
 * the case did not exist, so a pinned caller learns nothing of other actors'
 * cases.
 */
export const assertCaseActorPin = async (args: {
  id: string;
  actorId: string;
}): Promise<void> => {
  log('assertCaseActorPin: id=%s actorId=%s', args.id, args.actorId);
  const row = await playbookCases.findByPublicId({ id: args.id });
  if (row?.actor?.publicId !== args.actorId) {
    throw playbookCases.notFound(args.id);
  }
};

export const deletePlaybookCase = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<void> => {
  log('deletePlaybookCase: id=%s', args.id);
  const row = await playbookCases.getByPublicId(args);
  await assertNoDependentCases({
    caseDbId: row.id as number,
    publicId: row.publicId,
  });
  // Entries and the case's own bindings cascade with the case.
  await row.destroy();
};
