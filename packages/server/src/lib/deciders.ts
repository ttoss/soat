import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { validateQuestions } from './deciderQuestions';
import { DEFAULT_JEV_MODEL } from './jev';
import { paginatedList, type PaginatedResult } from './pagination';
import { makeResourceAccessor } from './resourceAccessor';

const log = createDebug('soat:deciders');

/**
 * The provider slug a decider may point at. A System One model answers typed
 * questions; it does not generate text, so an `openai` or `anthropic` record
 * would be a credential for an endpoint that cannot serve this call at all.
 * Refused on write rather than at evaluation time.
 */
const DECIDER_PROVIDER_SLUG = 'typesafe';

type DeciderInstance = InstanceType<(typeof db)['Decider']> & {
  project: InstanceType<(typeof db)['Project']>;
  aiProvider: InstanceType<(typeof db)['AiProvider']>;
};

const getDeciderIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.AiProvider, as: 'aiProvider' },
  ];
};

export const deciders = makeResourceAccessor<DeciderInstance>({
  model: () => {
    return db.Decider;
  },
  includes: getDeciderIncludes,
  label: 'Decider',
});

export type MappedDecider = ReturnType<typeof mapDecider>;

export const mapDecider = (decider: DeciderInstance) => {
  return {
    id: decider.publicId,
    project_id: decider.project.publicId,
    name: decider.name,
    description: decider.description,
    version: decider.version,
    ai_provider_id: decider.aiProvider.publicId,
    model:
      decider.model ?? decider.aiProvider.defaultModel ?? DEFAULT_JEV_MODEL,
    questions: decider.questions,
    created_at: decider.createdAt,
    updated_at: decider.updatedAt,
  };
};

/**
 * The provider row a decider names, checked to be one this project owns and one
 * a System One call can actually be made against.
 */
const resolveProvider = async (args: {
  aiProviderId: unknown;
  projectId: number;
}): Promise<InstanceType<(typeof db)['AiProvider']>> => {
  if (typeof args.aiProviderId !== 'string' || !args.aiProviderId) {
    throw new DomainError('VALIDATION_FAILED', 'ai_provider_id is required');
  }

  const provider = await db.AiProvider.findOne({
    where: { publicId: args.aiProviderId, projectId: args.projectId },
  });

  if (!provider) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `No AI provider \`${args.aiProviderId}\` in this project.`
    );
  }

  if (provider.provider !== DECIDER_PROVIDER_SLUG) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `A decider needs a \`${DECIDER_PROVIDER_SLUG}\` AI provider; \`${args.aiProviderId}\` is \`${provider.provider}\`. A System One model answers typed questions and cannot be reached through a text-generation provider.`
    );
  }

  return provider;
};

export const findDeciderInstance = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<DeciderInstance> => {
  return deciders.getByPublicId({ id: args.id, projectIds: args.projectIds });
};

export const createDecider = async (args: {
  projectId: number;
  name: string;
  description?: string;
  aiProviderId: unknown;
  model?: string | null;
  questions: unknown;
}): Promise<MappedDecider> => {
  log('createDecider: projectId=%d name=%s', args.projectId, args.name);

  const questions = validateQuestions(args.questions);
  const provider = await resolveProvider({
    aiProviderId: args.aiProviderId,
    projectId: args.projectId,
  });

  const decider = await db.Decider.create({
    projectId: args.projectId,
    name: args.name,
    description: args.description ?? null,
    version: 1,
    aiProviderId: provider.id as number,
    model: args.model ?? null,
    questions,
  });

  log('createDecider: created id=%s', decider.publicId);

  return mapDecider(await deciders.reload(decider));
};

export const listDeciders = async (args: {
  projectIds?: number[];
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedDecider>> => {
  log('listDeciders: projectIds=%o', args.projectIds);

  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Decider.findAndCountAll({
        where,
        include: getDeciderIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (decider) => {
      return mapDecider(decider as DeciderInstance);
    },
  });
};

export const getDecider = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedDecider> => {
  log('getDecider: id=%s', args.id);
  return mapDecider(await findDeciderInstance(args));
};

export const updateDecider = async (args: {
  projectIds?: number[];
  id: string;
  name?: string;
  description?: string | null;
  aiProviderId?: unknown;
  model?: string | null;
  questions?: unknown;
}): Promise<MappedDecider> => {
  log(
    'updateDecider: id=%s questionsWrite=%s',
    args.id,
    args.questions !== undefined
  );

  const decider = await findDeciderInstance({
    projectIds: args.projectIds,
    id: args.id,
  });

  if (args.name !== undefined) decider.name = args.name;
  if (args.description !== undefined) decider.description = args.description;
  if (args.model !== undefined) decider.model = args.model;

  if (args.aiProviderId !== undefined) {
    const provider = await resolveProvider({
      aiProviderId: args.aiProviderId,
      projectId: decider.projectId,
    });
    decider.aiProviderId = provider.id as number;
  }

  // Only the question set moves the version. A rename leaves every stored
  // decision's `decider_version` pointing at the same behaviour it did before,
  // which is the whole reason the version exists.
  if (args.questions !== undefined) {
    decider.questions = validateQuestions(args.questions);
    decider.version += 1;
  }

  await decider.save();

  return mapDecider(await deciders.reload(decider));
};

export const deleteDecider = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<void> => {
  log('deleteDecider: id=%s', args.id);

  const decider = await findDeciderInstance({
    projectIds: args.projectIds,
    id: args.id,
  });

  // Decisions outlive the decider that produced them: they record what the
  // system decided, and deleting the configuration must not erase the evidence.
  // Each keeps the decider's public id as a dangling reference, as a guardrail
  // evaluation does.
  await decider.destroy();
};
