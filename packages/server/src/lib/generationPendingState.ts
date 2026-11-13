import { db } from '../db';
import { DomainError } from '../errors';
import { actedAsPrincipalColumns, principalOfAuthority } from './principals';
import { storedAuthority, type WorkAuthority } from './workAuthority';

/**
 * Reads the internal recovery state of a generation paused on a client tool.
 *
 * This lives apart from the generation mappers on purpose. `pendingState` holds
 * the full message history, tool context and agent config needed to resume a
 * `requires_action` generation after a restart, and must never reach an API
 * response — so it has no entry in `mapGeneration` at all, and the one consumer
 * that needs it asks for it here by name. There is no filtering step that a
 * future field could be forgotten from.
 *
 * Returns null when the generation does not exist or never paused.
 */
export const getGenerationPendingState = async (args: {
  publicId: string;
}): Promise<Record<string, unknown> | null> => {
  const gen = await db.Generation.findOne({
    where: { publicId: args.publicId },
    attributes: ['pendingState'],
  });
  return gen?.pendingState ?? null;
};

/**
 * Takes a paused generation off `requires_action`, atomically. True for exactly
 * one caller per pause, so two submissions of the same outputs cannot both
 * resume the turn. The resumed segment's tool calls run under `authority`,
 * which the row stores for the work that resumes it later.
 */
export const claimPausedGeneration = async (args: {
  publicId: string;
  projectId: number;
  authority: WorkAuthority | null;
  /** The agent, when the resumed segment runs under its own grant. */
  actsAsAgent: string | null;
}): Promise<boolean> => {
  const [claimed] = await db.Generation.update(
    {
      status: 'running',
      lastActivityAt: new Date(),
      ...actedAsPrincipalColumns({
        principal: principalOfAuthority(args.authority),
        agentId: args.actsAsAgent,
      }),
      authority: await storedAuthority({
        authority: args.authority,
        projectId: args.projectId,
      }),
    },
    { where: { publicId: args.publicId, status: 'requires_action' } }
  );
  return claimed > 0;
};

export const notAwaitingToolOutputs = (generationId: string): DomainError => {
  return new DomainError(
    'GENERATION_NOT_AWAITING_TOOL_OUTPUTS',
    `Generation '${generationId}' is not awaiting tool outputs.`,
    { generation_id: generationId }
  );
};
