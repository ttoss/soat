import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';
import { isPlainObject } from './plainObject';
import type {
  PlaybookDefinition,
  PlaybookUpstreamRef,
} from './playbookDefinition';
import type {
  PlaybookCaseSnapshot,
  PlaybookNodeView,
  PlaybookPull,
} from './playbookState';

const log = createDebug('soat:playbookCases');

export type PlaybookCaseBinding = { name: string; upstreamCaseId: number };

/** A case's states, as the case module computes them for any case by id. */
export type PlaybookCaseStatesOf = (args: {
  caseDbId: number;
  transaction?: Transaction;
}) => Promise<{
  caseDbId: number;
  publicId: string;
  definition: PlaybookDefinition;
  snapshot: PlaybookCaseSnapshot;
  views: Map<string, PlaybookNodeView>;
}>;

const invalid = (args: {
  message: string;
  name: string;
  caseId?: unknown;
}): DomainError => {
  return new DomainError('PLAYBOOK_CASE_UPSTREAM_INVALID', args.message, {
    upstream: args.name,
    ...(args.caseId !== undefined && { case_id: args.caseId }),
  });
};

/**
 * The names a write binds: every declared name the case does not already
 * bind, each once, and no other.
 */
const boundIds = (args: {
  definition: PlaybookDefinition;
  raw: unknown;
  bound: string[];
}): Map<string, unknown> => {
  const raw = args.raw ?? {};
  const declared = (args.definition.upstreams ?? []).map((upstream) => {
    return upstream.name;
  });
  if (!isPlainObject(raw)) {
    throw invalid({ message: 'upstreams must be an object.', name: '' });
  }
  for (const name of Object.keys(raw)) {
    if (!declared.includes(name)) {
      throw invalid({
        message: `The playbook declares no upstream '${name}'.`,
        name,
      });
    }
    if (args.bound.includes(name)) {
      throw invalid({
        message: `Upstream '${name}' is already bound; a binding is never replaced.`,
        name,
      });
    }
  }
  const unbound = declared.filter((name) => {
    return !args.bound.includes(name);
  });
  return new Map(
    unbound.map((name) => {
      if (!Object.hasOwn(raw, name)) {
        throw invalid({
          message: `Upstream '${name}' must be bound to a case.`,
          name,
        });
      }
      return [name, raw[name]];
    })
  );
};

/**
 * Reads the cases a case binds, one per upstream its playbook declares and
 * `bound` does not name: each a case of the declared playbook, in the
 * project, of the same actor, and readable by the caller. A case the caller
 * may not read is refused as one that does not exist.
 */
export const readCaseBindings = async (args: {
  definition: PlaybookDefinition;
  raw: unknown;
  /** The names the case already binds and keeps. */
  bound: string[];
  projectId: number;
  actorDbId: number | null;
  canRead: (casePublicId: string) => Promise<boolean>;
}): Promise<PlaybookCaseBinding[]> => {
  const ids = boundIds(args);
  const bindings: PlaybookCaseBinding[] = [];

  for (const upstream of args.definition.upstreams ?? []) {
    const { name } = upstream;
    if (!ids.has(name)) continue;
    const caseId = ids.get(name);
    const found =
      typeof caseId === 'string' && (await args.canRead(caseId))
        ? await db.PlaybookCase.findOne({
            where: { publicId: caseId, projectId: args.projectId },
            include: [{ model: db.Playbook, as: 'playbook' }],
          })
        : null;
    if (!found) {
      throw invalid({
        message: `Upstream '${name}' names case '${String(caseId)}', which was not found.`,
        name,
        caseId,
      });
    }
    if (found.playbook.publicId !== upstream.playbook_id) {
      throw invalid({
        message: `Upstream '${name}' must be a case of playbook '${upstream.playbook_id}'.`,
        name,
        caseId,
      });
    }
    if (found.actorId !== args.actorDbId) {
      throw invalid({
        message: `Upstream '${name}' must be a case of the same actor.`,
        name,
        caseId,
      });
    }
    bindings.push({ name, upstreamCaseId: found.id as number });
  }

  log('readCaseBindings: %d bound', bindings.length);
  return bindings;
};

export const writeCaseBindings = async (args: {
  caseDbId: number;
  bindings: PlaybookCaseBinding[];
  transaction: Transaction;
}): Promise<void> => {
  // One `create` each: `bulkCreate` skips the hook that stamps the public id.
  for (const binding of args.bindings) {
    await db.PlaybookCaseUpstream.create(
      { caseId: args.caseDbId, ...binding },
      { transaction: args.transaction }
    );
  }
};

/**
 * Fits a case's bindings to the version it moves to: a binding whose name
 * that version declares on the same playbook is kept, every other one is
 * dropped, and each declared name left unbound is bound from `raw` by the
 * rules of create. Answers whether a binding changed.
 */
export const rebindCaseUpstreams = async (args: {
  caseRow: { id?: unknown; projectId: number; actorId: number | null };
  definition: PlaybookDefinition;
  raw: unknown;
  canRead: (casePublicId: string) => Promise<boolean>;
  transaction: Transaction;
}): Promise<boolean> => {
  const caseDbId = args.caseRow.id as number;
  const existing = await db.PlaybookCaseUpstream.findAll({
    where: { caseId: caseDbId },
    include: [
      {
        model: db.PlaybookCase,
        as: 'upstreamCase',
        attributes: ['id'],
        include: [
          { model: db.Playbook, as: 'playbook', attributes: ['publicId'] },
        ],
      },
    ],
    transaction: args.transaction,
  });
  const declared = args.definition.upstreams ?? [];
  const kept = existing.filter((row) => {
    return declared.some((upstream) => {
      return (
        upstream.name === row.name &&
        upstream.playbook_id === row.upstreamCase.playbook.publicId
      );
    });
  });
  const bindings = await readCaseBindings({
    definition: args.definition,
    raw: args.raw,
    bound: kept.map((row) => {
      return row.name;
    }),
    projectId: args.caseRow.projectId,
    actorDbId: args.caseRow.actorId,
    canRead: args.canRead,
  });
  const dropped = existing.filter((row) => {
    return !kept.includes(row);
  });
  log(
    'rebindCaseUpstreams: case=%d kept=%d dropped=%d bound=%d',
    caseDbId,
    kept.length,
    dropped.length,
    bindings.length
  );
  for (const row of dropped) {
    await row.destroy({ transaction: args.transaction });
  }
  await writeCaseBindings({
    caseDbId,
    bindings,
    transaction: args.transaction,
  });
  return dropped.length > 0 || bindings.length > 0;
};

/** Each case's bindings as the wire names them: upstream name to case id. */
export const caseUpstreamIds = async (args: {
  caseDbIds: number[];
}): Promise<(caseDbId: number) => Record<string, string>> => {
  const rows =
    args.caseDbIds.length === 0
      ? []
      : await db.PlaybookCaseUpstream.findAll({
          where: { caseId: args.caseDbIds },
          include: [
            {
              model: db.PlaybookCase,
              as: 'upstreamCase',
              attributes: ['publicId'],
            },
          ],
          order: [['name', 'ASC']],
        });
  return (caseDbId) => {
    return Object.fromEntries(
      rows
        .filter((row) => {
          return row.caseId === caseDbId;
        })
        .map((row) => {
          return [row.name, row.upstreamCase.publicId];
        })
    );
  };
};

/** The cases bound to `caseDbId` as their upstream. */
export const dependentCases = async (args: {
  caseDbId: number;
}): Promise<{ id: number; publicId: string }[]> => {
  const rows = await db.PlaybookCaseUpstream.findAll({
    where: { upstreamCaseId: args.caseDbId },
    include: [
      { model: db.PlaybookCase, as: 'case', attributes: ['id', 'publicId'] },
    ],
    order: [['id', 'ASC']],
  });
  return rows.map((row) => {
    return { id: row.case.id as number, publicId: row.case.publicId };
  });
};

/** `caseDbIds` and every case upstream of one of them, at any depth. */
export const casesWithUpstreams = async (args: {
  caseDbIds: number[];
}): Promise<Set<number>> => {
  const seen = new Set<number>();
  let frontier = args.caseDbIds;
  while (frontier.length > 0) {
    for (const id of frontier) seen.add(id);
    const bindings = await db.PlaybookCaseUpstream.findAll({
      where: { caseId: frontier },
      attributes: ['upstreamCaseId'],
    });
    frontier = bindings
      .map((binding) => {
        return binding.upstreamCaseId;
      })
      .filter((id) => {
        return !seen.has(id);
      });
  }
  return seen;
};

/** Refuses deleting a case another case reads as its upstream. */
export const assertNoDependentCases = async (args: {
  caseDbId: number;
  publicId: string;
}): Promise<void> => {
  const dependents = await dependentCases(args);
  if (dependents.length === 0) return;
  throw new DomainError(
    'PLAYBOOK_CASE_HAS_DEPENDENTS',
    `Case '${args.publicId}' is the upstream of ${dependents.length} case(s) and cannot be deleted.`,
    {
      cases: dependents.map((dependent) => {
        return dependent.publicId;
      }),
    }
  );
};

/** Each bound upstream case's states, by upstream name. */
export const upstreamCaseStates = async (args: {
  caseDbId: number;
  transaction?: Transaction;
  statesOf: PlaybookCaseStatesOf;
}): Promise<Map<string, Awaited<ReturnType<PlaybookCaseStatesOf>>>> => {
  const bindings = await db.PlaybookCaseUpstream.findAll({
    where: { caseId: args.caseDbId },
    transaction: args.transaction,
  });
  const states = new Map<string, Awaited<ReturnType<PlaybookCaseStatesOf>>>();
  for (const binding of bindings) {
    states.set(
      binding.name,
      await args.statesOf({
        caseDbId: binding.upstreamCaseId,
        transaction: args.transaction,
      })
    );
  }
  return states;
};

/**
 * What each upstream node of a case reads of the node it pulls: that node's
 * state and output in the bound case, as the upstream case's own version
 * declares it. An unbound name or a node the bound case's version lacks reads
 * nothing.
 */
export const upstreamPull = async (args: {
  caseDbId: number;
  transaction?: Transaction;
  statesOf: PlaybookCaseStatesOf;
}): Promise<PlaybookPull> => {
  const states = await upstreamCaseStates(args);
  return (ref: PlaybookUpstreamRef) => {
    const upstream = states.get(ref.name);
    const view = upstream?.views.get(ref.node_id);
    if (!upstream || !view) return undefined;
    return {
      state: view.state,
      settling: view.settling,
      output: upstream.snapshot[ref.node_id]?.output,
    };
  };
};
