import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  assertDeciderAgentToolLess,
  type DeciderAgentRow,
  findDeciderAgent,
} from './deciderAgent';
import {
  type DeciderQuestions,
  parseDeciderQuestions,
} from './deciderQuestions';
import {
  assertDeciderToolCallable,
  type DeciderToolRow,
  findDeciderTool,
} from './deciderTool';
import {
  buildDeciderConfigSnapshot,
  deciderVersionStore,
} from './deciderVersionSnapshot';
import { paginatedList, type PaginatedResult } from './pagination';
import { makeResourceAccessor } from './resourceAccessor';
import { toResourceRef } from './resourceVersions';
import type { VersionedWrite } from './writePrecondition';

const log = createDebug('soat:deciders');

export type DeciderRow = InstanceType<(typeof db)['Decider']> & {
  project: { publicId: string };
  agent: DeciderAgentRow | null;
  tool: DeciderToolRow | null;
};

const deciderIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Agent, as: 'agent' },
    { model: db.Tool, as: 'tool' },
  ];
};

export const deciders = makeResourceAccessor<DeciderRow>({
  model: () => {
    return db.Decider;
  },
  includes: deciderIncludes,
  label: 'Decider',
});

/** The stored question set, as it was validated on write. */
export const deciderQuestionsOf = (row: DeciderRow): DeciderQuestions => {
  return parseDeciderQuestions(row.questions);
};

export const mapDecider = (row: DeciderRow) => {
  return {
    id: row.publicId,
    project_id: row.project.publicId,
    name: row.name,
    description: row.description,
    agent_id: row.agent?.publicId ?? null,
    tool_id: row.tool?.publicId ?? null,
    version: row.version,
    questions: row.questions,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
};

export type MappedDecider = ReturnType<typeof mapDecider>;

const validateName = (name: unknown): string => {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'name is required and must be a non-empty string.'
    );
  }
  return name;
};

const validateDescription = (description: unknown): string | null => {
  if (description === undefined || description === null) return null;
  if (typeof description !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 'description must be a string.');
  }
  return description;
};

const assertNameAvailable = async (args: {
  projectId: number;
  name: string;
  excludeId?: number;
}): Promise<void> => {
  const existing = await db.Decider.findOne({
    where: { projectId: args.projectId, name: args.name },
    attributes: ['id'],
  });
  if (!existing || existing.id === args.excludeId) return;
  throw new DomainError(
    'NAME_CONFLICT',
    `A decider named '${args.name}' already exists in this project.`,
    { name: args.name }
  );
};

type DeciderBackend =
  | { agent: DeciderAgentRow; tool: null }
  | { agent: null; tool: DeciderToolRow };

/**
 * Why a write's backend fields are unusable, or null. Naming both is always
 * refused; naming neither only on a create, since an update that names no
 * backend keeps the current one. Shared by the route and the formation module.
 */
export const deciderBackendNamingError = (args: {
  namesAgent: boolean;
  namesTool: boolean;
  forUpdate: boolean;
}): string | null => {
  if (args.namesAgent && args.namesTool) {
    return 'A decider names exactly one of agent_id and tool_id, not both.';
  }
  if (!args.namesAgent && !args.namesTool && !args.forUpdate) {
    return 'A decider names exactly one of agent_id and tool_id.';
  }
  return null;
};

/**
 * The one backend a write names: a tool-less agent or a callable tool, in the
 * decider's project.
 */
const resolveBackend = async (args: {
  projectId: number;
  agentId?: unknown;
  toolId?: unknown;
}): Promise<DeciderBackend> => {
  const namesAgent = args.agentId !== undefined;
  const namingError = deciderBackendNamingError({
    namesAgent,
    namesTool: args.toolId !== undefined,
    forUpdate: false,
  });
  if (namingError) throw new DomainError('VALIDATION_FAILED', namingError);
  if (namesAgent) {
    const agent = await findDeciderAgent({
      projectId: args.projectId,
      agentPublicId: args.agentId,
    });
    assertDeciderAgentToolLess(agent);
    return { agent, tool: null };
  }
  const tool = await findDeciderTool({
    projectId: args.projectId,
    toolPublicId: args.toolId,
  });
  assertDeciderToolCallable(tool);
  return { agent: null, tool };
};

export const createDecider = async (
  args: {
    projectId: number;
    name: unknown;
    description?: unknown;
    agentId?: unknown;
    toolId?: unknown;
    questions: unknown;
  } & VersionedWrite
): Promise<MappedDecider> => {
  log('createDecider: projectId=%d', args.projectId);

  const name = validateName(args.name);
  const description = validateDescription(args.description);
  const questions = parseDeciderQuestions(args.questions);
  const backend = await resolveBackend(args);
  await assertNameAvailable({ projectId: args.projectId, name });

  const decider = await db.Decider.create({
    projectId: args.projectId,
    name,
    description,
    agentId: backend.agent?.id ?? null,
    toolId: backend.tool?.id ?? null,
    version: 1,
    questions,
  });
  const mapped = mapDecider(await deciders.reload(decider));

  // Version 1 is archived on create, so the criteria behind the first decision
  // are as readable as those behind any later one.
  await deciderVersionStore.writeVersion({
    resourceDbId: decider.id as number,
    version: 1,
    config: buildDeciderConfigSnapshot(mapped),
    label: args.versionLabel,
    createdByUserId: args.createdByUserId,
  });

  log('createDecider: created id=%s', decider.publicId);
  return mapped;
};

export const listDeciders = async (args: {
  projectIds?: number[];
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedDecider>> => {
  log('listDeciders: projectIds=%o', args.projectIds);
  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['createdAt', 'DESC']],
    query: ({ limit, offset, order }) => {
      return db.Decider.findAndCountAll({
        where,
        include: deciderIncludes(),
        distinct: true,
        order,
        limit,
        offset,
      });
    },
    map: (row) => {
      return mapDecider(row as DeciderRow);
    },
  });
};

export const getDecider = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedDecider> => {
  log('getDecider: id=%s', args.id);
  return mapDecider(await deciders.getByPublicId(args));
};

/** Applies the metadata fields of an update to the row, validating each. */
const applyMetadata = async (args: {
  decider: DeciderRow;
  name?: unknown;
  description?: unknown;
  agentId?: unknown;
  toolId?: unknown;
}): Promise<void> => {
  const { decider } = args;
  if (args.name !== undefined) {
    const name = validateName(args.name);
    await assertNameAvailable({
      projectId: decider.projectId,
      name,
      excludeId: decider.id as number,
    });
    decider.name = name;
  }
  if (args.description !== undefined) {
    decider.description = validateDescription(args.description);
  }
  if (args.agentId !== undefined || args.toolId !== undefined) {
    // Naming one backend replaces the other.
    const backend = await resolveBackend({
      projectId: decider.projectId,
      agentId: args.agentId,
      toolId: args.toolId,
    });
    decider.agentId = (backend.agent?.id as number | undefined) ?? null;
    decider.agent = backend.agent;
    decider.toolId = (backend.tool?.id as number | undefined) ?? null;
    decider.tool = backend.tool;
  }
};

export const updateDecider = async (
  args: {
    projectIds?: number[];
    id: string;
    name?: unknown;
    description?: unknown;
    agentId?: unknown;
    toolId?: unknown;
    questions?: unknown;
  } & VersionedWrite
): Promise<MappedDecider> => {
  log('updateDecider: id=%s', args.id);

  const decider = await deciders.getByPublicId({
    projectIds: args.projectIds,
    id: args.id,
  });
  const questions =
    args.questions === undefined
      ? undefined
      : parseDeciderQuestions(args.questions);

  // `save` mutates the instance in place, so this one reference yields both the
  // pre- and post-write question set.
  const before = buildDeciderConfigSnapshot(mapDecider(decider));
  await applyMetadata({ decider, ...args });
  if (questions !== undefined) decider.questions = questions;

  // Only a changed question set bumps the version; a rename, a repoint or an
  // identical rewrite leaves it where it is.
  await deciderVersionStore.commitConfigChange({
    resource: toResourceRef(decider),
    expectedVersion: args.expectedVersion,
    before,
    label: args.versionLabel,
    createdByUserId: args.createdByUserId,
    applyWrite: async ({ transaction }) => {
      await decider.save({ transaction });
      return {
        row: decider,
        after: buildDeciderConfigSnapshot(mapDecider(decider)),
      };
    },
  });

  return mapDecider(await deciders.reload(decider));
};

export const deleteDecider = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<void> => {
  log('deleteDecider: id=%s', args.id);
  const decider = await deciders.getByPublicId(args);

  // Decisions name the decider by public id and outlive it.
  await db.sequelize.transaction(async (transaction) => {
    await deciderVersionStore.deleteVersions({
      resourceDbId: decider.id as number,
      transaction,
    });
    await decider.destroy({ transaction });
  });
};
