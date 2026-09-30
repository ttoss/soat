import { db } from '../db';
import type { TokenEventAttribution } from './usageTokenEvent';

/**
 * The attribution a usage event takes from the generation it was spent for.
 * Every column is read off the generation's own typed columns, so a caller
 * cannot bill another run, trigger or end user. The token and embedding meters
 * both read it, so the events of one turn are attributed alike.
 */
export type GenerationEventAttribution = Pick<
  TokenEventAttribution,
  | 'orchestrationRunId'
  | 'nodeId'
  | 'agentId'
  | 'generationId'
  | 'generationPublicId'
  | 'traceId'
  | 'actorId'
  | 'sessionId'
  | 'triggerId'
  | 'actionId'
  | 'publisherProjectId'
>;

// Resolves the run's public id to its internal FK. Returns null when absent or
// the run no longer exists — the event is still recorded, just without the run
// association.
const resolveOrchestrationRunId = async (
  runPublicId: string | null
): Promise<number | null> => {
  if (!runPublicId) return null;
  const run = await db.OrchestrationRun.findOne({
    where: { publicId: runPublicId },
  });
  return (run?.id as number | undefined) ?? null;
};

// The agent's own project when it is not the generation's: the turn ran a
// shared agent, recorded in the grantee.
const resolvePublisherProjectId = async (
  generation: InstanceType<(typeof db)['Generation']>
): Promise<number | null> => {
  if (!generation.agentId) return null;
  const agent = await db.Agent.findByPk(generation.agentId, {
    attributes: ['projectId'],
  });
  if (!agent || agent.projectId === generation.projectId) return null;
  return agent.projectId;
};

export const readGenerationEventAttribution = async (
  generation: InstanceType<(typeof db)['Generation']>
): Promise<GenerationEventAttribution> => {
  return {
    publisherProjectId: await resolvePublisherProjectId(generation),
    orchestrationRunId: await resolveOrchestrationRunId(
      generation.orchestrationRunId
    ),
    nodeId: generation.nodeId,
    agentId: generation.agentId,
    generationId: generation.id,
    generationPublicId: generation.publicId,
    traceId: generation.traceId,
    // End-user attribution, copied from the generation's own FK columns.
    actorId: generation.startedByActorId,
    sessionId: generation.sessionId,
    triggerId: generation.triggerId,
    actionId: generation.actionId,
  };
};
