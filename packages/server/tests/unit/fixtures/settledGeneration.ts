import { settleGeneration } from '../../../src/lib/generationSettle';

/**
 * Settles a generation this process just created, through the same chokepoint
 * the runtime uses, so a fixture holds the state a real turn leaves.
 */
export const settleTestGeneration = async (args: {
  publicId: string;
  status: 'completed' | 'failed' | 'requires_action';
  pendingState?: Record<string, unknown>;
}): Promise<void> => {
  const outcome =
    args.status === 'requires_action'
      ? {
          status: args.status,
          pendingState: args.pendingState ?? {},
          requiredAction: { type: 'submit_tool_outputs', tool_calls: [] },
        }
      : args.status === 'failed'
        ? {
            status: args.status,
            error: { code: 'GENERATION_FAILED', message: 'failed' },
          }
        : {
            status: args.status,
            stopReason: 'stop',
            assistantContent: '',
            citations: null,
          };
  const settled = await settleGeneration({
    generationId: args.publicId,
    fence: 'lease',
    outcome,
  });
  if (!settled) throw new Error(`could not settle ${args.publicId}`);
};
