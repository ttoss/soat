import createDebug from 'debug';

import { createGeneration } from './agentGeneration';
import { agentReferences } from './resourceReferences';
import { sendSessionMessage } from './sessionOperations';
import type { WorkAuthority } from './workAuthority';

const log = createDebug('soat:agent-continuation');

/**
 * Feeds `message` back to an agent whose generation left work pending (an
 * approval, a sub-agent it stopped waiting for), as a turn that continues it:
 *
 * - **Session-backed**: the message is appended to the session's thread via
 *   `sendSessionMessage`, so the turn sees the whole conversation.
 * - **Standalone**: a new generation over the message alone.
 *
 * Either way `initiatorGenerationId` declares the chain, so the turn joins the
 * same bounded chain as the generation it continues.
 */
export const fireAgentContinuation = async (args: {
  agentPublicId: string;
  projectInternalId: number;
  sessionPublicId: string | null;
  initiatorGenerationId: string | null;
  message: string;
  authority: WorkAuthority | null;
  toolContext?: Record<string, string>;
}): Promise<void> => {
  if (args.sessionPublicId) {
    const agent = await agentReferences.find({
      id: args.agentPublicId,
      projectId: args.projectInternalId,
      reach: 'project',
    });
    if (!agent) return;
    log(
      'fireAgentContinuation: session=%s initiator=%s',
      args.sessionPublicId,
      args.initiatorGenerationId
    );
    await sendSessionMessage({
      agentId: agent.id as number,
      sessionId: args.sessionPublicId,
      message: args.message,
      authority: args.authority,
      // No request drives a continuation: it runs under `authority`.
      authUser: undefined,
      toolContext: args.toolContext,
      initiatorGenerationId: args.initiatorGenerationId,
    });
    return;
  }

  log(
    'fireAgentContinuation: standalone initiator=%s',
    args.initiatorGenerationId
  );
  await createGeneration({
    agentId: args.agentPublicId,
    projectIds: [args.projectInternalId],
    initiatorGenerationId: args.initiatorGenerationId,
    messages: [{ role: 'user', content: args.message }],
    // The chain's authority, which the continuation's generation stores, so a
    // further continuation in the same chain runs under it in turn.
    authority: args.authority,
    toolContext: args.toolContext,
  });
};
