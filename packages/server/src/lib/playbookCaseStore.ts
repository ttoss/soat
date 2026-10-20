import { db } from '../db';
import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';
import type { ResourceIncludes } from './modelIncludes';
import type { OnBehalfOf } from './onBehalfOf';
import {
  conformsToInputSchema,
  snapshotFromRecords,
} from './playbookCaseState';
import {
  type PlaybookCaseStatesOf,
  upstreamPull,
} from './playbookCaseUpstreams';
import type { JsonValue, PlaybookDefinition } from './playbookDefinition';
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

/**
 * A case's row, its definition, its node states and the writes every case
 * operation shares. `playbookCases.ts` holds the operations themselves.
 */

export type PlaybookCaseRow = InstanceType<(typeof db)['PlaybookCase']> & {
  project: { publicId: string };
  playbook: InstanceType<(typeof db)['Playbook']>;
  actor: { publicId: string } | null;
};

export const caseIncludes = (): ResourceIncludes => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Playbook, as: 'playbook' },
    { model: db.Actor, as: 'actor', attributes: ['publicId'] },
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

type NodeStates = {
  snapshot: PlaybookCaseSnapshot;
  views: Map<string, PlaybookNodeView>;
};

/**
 * Node states against `definition`, reading bound upstream cases through
 * `statesOf`. A dependent case reads its upstream cases' states, which read
 * theirs: upstreams declare no cycle, so the recursion ends.
 */
const nodeStatesWith = async (args: {
  caseDbId: number;
  definition: PlaybookDefinition;
  transaction?: Transaction;
  statesOf: PlaybookCaseStatesOf;
}): Promise<NodeStates> => {
  const [snapshot, pull] = await Promise.all([
    caseSnapshot(args),
    upstreamPull(args),
  ]);
  return {
    snapshot,
    views: playbookNodeStates({
      definition: args.definition,
      snapshot,
      conforms: conformsToInputSchema,
      pull,
    }),
  };
};

/** A case's definition and node states by its db id. */
export const caseStates: PlaybookCaseStatesOf = async (args) => {
  const row = await playbookCases.reload(
    (await db.PlaybookCase.findByPk(args.caseDbId, {
      transaction: args.transaction,
    }))!
  );
  const definition = await caseDefinition({ row });
  return {
    caseDbId: args.caseDbId,
    publicId: row.publicId,
    definition,
    ...(await nodeStatesWith({ ...args, definition, statesOf: caseStates })),
  };
};

/**
 * Every node's state in a case, with each input's schema deciding what counts
 * as set. The one read of node states, so no reader can count a value its
 * schema refuses.
 */
export const caseNodeStates = (args: {
  caseDbId: number;
  definition: PlaybookDefinition;
  transaction?: Transaction;
}): Promise<NodeStates> => {
  return nodeStatesWith({ ...args, statesOf: caseStates });
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
  onBehalfOf: OnBehalfOf | null;
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
