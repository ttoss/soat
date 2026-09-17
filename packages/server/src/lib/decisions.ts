import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { resolveAiProviderSecret } from './aiProviders';
import { findDeciderInstance } from './deciders';
import { askSystemOne, DEFAULT_JEV_MODEL } from './jev';
import { paginatedList, type PaginatedResult } from './pagination';
import { makeResourceAccessor } from './resourceAccessor';

const log = createDebug('soat:decisions');

type DecisionInstance = InstanceType<(typeof db)['Decision']> & {
  project: InstanceType<(typeof db)['Project']>;
};

const getDecisionIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

export const decisions = makeResourceAccessor<DecisionInstance>({
  model: () => {
    return db.Decision;
  },
  includes: getDecisionIncludes,
  label: 'Decision',
});

export type MappedDecision = ReturnType<typeof mapDecision>;

export const mapDecision = (decision: DecisionInstance) => {
  return {
    id: decision.publicId,
    project_id: decision.project.publicId,
    decider_id: decision.deciderId,
    decider_version: decision.deciderVersion,
    model: decision.model,
    answers: decision.answers,
    usage: decision.usage,
    created_at: decision.createdAt,
  };
};

/**
 * Evaluate a decider's question set against one state and record the answers.
 *
 * The caller supplies only the state. The questions come from the stored
 * decider, so every decision is reproducible from the version it names, and no
 * caller can widen a decider's judgment at call time.
 */
export const evaluateDecider = async (args: {
  projectIds?: number[];
  id: string;
  state: unknown;
}): Promise<MappedDecision> => {
  if (args.state === undefined || args.state === null || args.state === '') {
    throw new DomainError(
      'VALIDATION_FAILED',
      '`state` is required: it is the content the decider judges.'
    );
  }

  const decider = await findDeciderInstance({
    projectIds: args.projectIds,
    id: args.id,
  });

  const provider = await resolveAiProviderSecret({
    aiProviderId: decider.aiProvider.publicId,
    projectId: decider.projectId,
  });

  if (!provider?.secretValue) {
    throw new DomainError(
      'AI_PROVIDER_MISCONFIGURED',
      `AI provider \`${decider.aiProvider.publicId}\` links no secret, so there is no API key to call the System One endpoint with.`
    );
  }

  const model = decider.model ?? provider.defaultModel ?? DEFAULT_JEV_MODEL;

  log(
    'evaluateDecider: id=%s version=%d model=%s',
    decider.publicId,
    decider.version,
    model
  );

  const response = await askSystemOne({
    state: args.state,
    questions: decider.questions,
    model,
    apiKey: provider.secretValue,
    baseUrl: provider.baseUrl,
  });

  const decision = await db.Decision.create({
    projectId: decider.projectId,
    deciderId: decider.publicId,
    deciderVersion: decider.version,
    model: response.model,
    answers: response.answers,
    usage: response.usage,
  });

  log('evaluateDecider: recorded id=%s', decision.publicId);

  return mapDecision(await decisions.reload(decision));
};

export const listDecisions = async (args: {
  projectIds?: number[];
  deciderId?: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedDecision>> => {
  log(
    'listDecisions: projectIds=%o deciderId=%s',
    args.projectIds,
    args.deciderId
  );

  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }
  if (args.deciderId) {
    where.deciderId = args.deciderId;
  }

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Decision.findAndCountAll({
        where,
        include: getDecisionIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (decision) => {
      return mapDecision(decision as DecisionInstance);
    },
  });
};

export const getDecision = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedDecision> => {
  log('getDecision: id=%s', args.id);
  const decision = await decisions.getByPublicId({
    id: args.id,
    projectIds: args.projectIds,
  });
  return mapDecision(decision);
};
