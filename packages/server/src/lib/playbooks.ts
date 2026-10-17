import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { paginatedList, type PaginatedResult } from './pagination';
import {
  assertAuthorCanRun,
  authorColumns,
  type PlaybookAuthor,
} from './playbookAuthor';
import type { PlaybookDefinition } from './playbookDefinition';
import {
  type PlaybookDefinitionProblem,
  validatePlaybookDefinition,
} from './playbookValidation';
import {
  buildPlaybookConfigSnapshot,
  playbookVersionStore,
} from './playbookVersionSnapshot';
import {
  assertPlaybookDefinitionValid,
  parsePlaybookDefinition,
} from './playbookWire';
import { makeResourceAccessor } from './resourceAccessor';
import { toResourceRef } from './resourceVersions';
import type { VersionedWrite } from './writePrecondition';

const log = createDebug('soat:playbooks');

export type PlaybookRow = InstanceType<(typeof db)['Playbook']> & {
  project: { publicId: string };
};

const playbookIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

export const playbooks = makeResourceAccessor<PlaybookRow>({
  model: () => {
    return db.Playbook;
  },
  includes: playbookIncludes,
  label: 'Playbook',
});

export const mapPlaybook = (row: PlaybookRow) => {
  return {
    id: row.publicId,
    project_id: row.project.publicId,
    name: row.name,
    description: row.description,
    version: row.version,
    definition: row.definition,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
};

export type MappedPlaybook = ReturnType<typeof mapPlaybook>;

const validateName = (name: unknown): string => {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'name is required and must be a non-empty string.'
    );
  }
  return name;
};

/** The spec's type check has already refused anything but a string or null. */
const readDescription = (description: unknown): string | null => {
  return typeof description === 'string' ? description : null;
};

const assertNameAvailable = async (args: {
  projectId: number;
  name: string;
  excludeId?: number;
}): Promise<void> => {
  const existing = await db.Playbook.findOne({
    where: { projectId: args.projectId, name: args.name },
    attributes: ['id'],
  });
  if (!existing || existing.id === args.excludeId) return;
  throw new DomainError(
    'NAME_CONFLICT',
    `A playbook named '${args.name}' already exists in this project.`,
    { name: args.name }
  );
};

/** Parses and validates a definition from the wire; throws on any problem. */
const readDefinition = (definition: unknown): PlaybookDefinition => {
  const parsed = parsePlaybookDefinition({ definition });
  assertPlaybookDefinitionValid({ definition: parsed });
  return parsed;
};

/**
 * What a write of `definition` would be told, without writing. A shape error
 * still throws: there is no graph to report on until the shape is read.
 */
export const validatePlaybook = (args: {
  definition: unknown;
}): { valid: boolean; problems: PlaybookDefinitionProblem[] } => {
  const problems = validatePlaybookDefinition({
    definition: parsePlaybookDefinition({ definition: args.definition }),
  });
  return { valid: problems.length === 0, problems };
};

export const createPlaybook = async (
  args: {
    projectId: number;
    name: unknown;
    description?: unknown;
    definition: unknown;
    author: PlaybookAuthor;
  } & VersionedWrite
): Promise<MappedPlaybook> => {
  log('createPlaybook: projectId=%d', args.projectId);

  const name = validateName(args.name);
  const description = readDescription(args.description);
  const definition = readDefinition(args.definition);
  await assertNameAvailable({ projectId: args.projectId, name });
  const project = await db.Project.findByPk(args.projectId, {
    attributes: ['publicId'],
  });
  await assertAuthorCanRun({
    definition,
    projectPublicId: project!.publicId as string,
    author: args.author,
  });

  const playbook = await db.Playbook.create({
    projectId: args.projectId,
    name,
    description,
    version: 1,
    definition,
  });
  const mapped = mapPlaybook(await playbooks.reload(playbook));

  // Version 1 is archived on create, so the first case has a pinned
  // definition to resolve.
  await playbookVersionStore.writeVersion({
    resourceDbId: playbook.id as number,
    version: 1,
    config: buildPlaybookConfigSnapshot(mapped),
    label: args.versionLabel,
    createdBy: args.createdBy,
    columns: authorColumns(args.author.principal),
  });

  log('createPlaybook: created id=%s', playbook.publicId);
  return mapped;
};

export const listPlaybooks = async (args: {
  projectIds?: number[];
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedPlaybook>> => {
  log('listPlaybooks: projectIds=%o', args.projectIds);
  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['createdAt', 'DESC']],
    query: ({ limit, offset, order }) => {
      return db.Playbook.findAndCountAll({
        where,
        include: playbookIncludes(),
        distinct: true,
        order,
        limit,
        offset,
      });
    },
    map: (row) => {
      return mapPlaybook(row as PlaybookRow);
    },
  });
};

export const getPlaybook = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedPlaybook> => {
  log('getPlaybook: id=%s', args.id);
  return mapPlaybook(await playbooks.getByPublicId(args));
};

export const updatePlaybook = async (
  args: {
    projectIds?: number[];
    id: string;
    name?: unknown;
    description?: unknown;
    definition?: unknown;
    author: PlaybookAuthor;
  } & VersionedWrite
): Promise<MappedPlaybook> => {
  log('updatePlaybook: id=%s', args.id);

  const playbook = await playbooks.getByPublicId({
    projectIds: args.projectIds,
    id: args.id,
  });
  const definition =
    args.definition === undefined ? undefined : readDefinition(args.definition);
  if (definition !== undefined) {
    await assertAuthorCanRun({
      definition,
      projectPublicId: playbook.project.publicId,
      author: args.author,
    });
  }

  // `save` mutates the instance in place, so this one reference yields both the
  // pre- and post-write definition.
  const before = buildPlaybookConfigSnapshot(mapPlaybook(playbook));
  if (args.name !== undefined) {
    const name = validateName(args.name);
    await assertNameAvailable({
      projectId: playbook.projectId,
      name,
      excludeId: playbook.id as number,
    });
    playbook.name = name;
  }
  if (args.description !== undefined) {
    playbook.description = readDescription(args.description);
  }
  if (definition !== undefined) playbook.definition = definition;

  // Only a changed definition bumps the version; a rename or an identical
  // rewrite leaves it where it is.
  await playbookVersionStore.commitConfigChange({
    resource: toResourceRef(playbook),
    expectedVersion: args.expectedVersion,
    before,
    label: args.versionLabel,
    createdBy: args.createdBy,
    columns: authorColumns(args.author.principal),
    applyWrite: async ({ transaction }) => {
      await playbook.save({ transaction });
      return {
        row: playbook,
        after: buildPlaybookConfigSnapshot(mapPlaybook(playbook)),
      };
    },
  });

  return mapPlaybook(await playbooks.reload(playbook));
};

const casesOf = (playbook: PlaybookRow): Promise<number> => {
  return db.PlaybookCase.count({
    where: { playbookId: playbook.id as number },
  });
};

const hasCasesMessage = (args: { id: string; cases: number }): string => {
  return `Playbook '${args.id}' has ${args.cases} case(s) and cannot be deleted.`;
};

/** Why deleting the playbook would refuse, or `null` when it would not. */
export const findPlaybookDeletionBlocker = async (args: {
  id: string;
}): Promise<string | null> => {
  log('findPlaybookDeletionBlocker: id=%s', args.id);
  const cases = await casesOf(await playbooks.getByPublicId(args));
  return cases > 0 ? hasCasesMessage({ id: args.id, cases }) : null;
};

export const deletePlaybook = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<void> => {
  log('deletePlaybook: id=%s', args.id);
  const playbook = await playbooks.getByPublicId(args);

  const cases = await casesOf(playbook);
  if (cases > 0) {
    throw new DomainError(
      'PLAYBOOK_HAS_CASES',
      hasCasesMessage({ id: args.id, cases }),
      { cases }
    );
  }

  await db.sequelize.transaction(async (transaction) => {
    await playbookVersionStore.deleteVersions({
      resourceDbId: playbook.id as number,
      transaction,
    });
    await playbook.destroy({ transaction });
  });
};
