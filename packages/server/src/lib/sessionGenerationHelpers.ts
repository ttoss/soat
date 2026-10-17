import createDebug from 'debug';

import type { db } from '../db';
import type { GenerationResult } from './agentGenerationTypes';
import {
  pausedTurnSnapshotPosition,
  storeGeneratedTurn,
} from './conversationGeneration';
import { mapGeneratedTurn } from './generatedTurn';
import { emitSessionEvent } from './sessionEvents';

const log = createDebug('soat:session-generation');

export const emitGenerationStarted = (
  session: InstanceType<(typeof db)['Session']>
) => {
  void emitSessionEvent({ type: 'sessions.generation_started', session });
};

// A completed turn is stored even when it carries no text, as conversation
// generate stores it: the reply always names the record it produced.
export const processToolOutputResult = async (args: {
  result: GenerationResult;
  conversation: InstanceType<(typeof db)['Conversation']>;
  agentPublicId: string;
}) => {
  const { result } = args;
  log(
    'processToolOutputResult: generationId=%s status=%s',
    result.id,
    result.status
  );
  if (result.status === 'requires_action') {
    return mapGeneratedTurn({
      status: 'requires_action',
      generationId: result.id,
      traceId: result.traceId,
      requiredAction: result.requiredAction!,
    });
  }

  return mapGeneratedTurn(
    await storeGeneratedTurn({
      conversation: args.conversation,
      agentId: args.agentPublicId,
      snapshotPosition: await pausedTurnSnapshotPosition({
        generationId: result.id,
        conversation: args.conversation,
      }),
      generationId: result.id,
      traceId: result.traceId,
      output: result.output,
    })
  );
};
