import { resolveStopReason } from './generationStopReason';
import {
  type InvalidQuantity,
  type PricedResourceComponent,
  priceResource,
} from './usageResourcePricing';
import type { UsageTokens } from './usageTotals';

/** What one metered segment of a turn did, as its call site knows it. */
export type GenerationTurnFacts = {
  steps: readonly unknown[];
  finishReason: string;
  /** The agent's `max_steps`, which tells `max_steps` apart from a tool call. */
  maxSteps: unknown;
  outcome: 'ok' | 'error';
};

// Steps are the SDK's step results, carried untyped; a step without
// `toolCalls` counts none.
const countToolCalls = (steps: readonly unknown[]): number => {
  return steps.flatMap((step) => {
    return Object.values(Object(Reflect.get(Object(step), 'toolCalls')));
  }).length;
};

/**
 * The components an agent's resource rows add to one of its `llm_tokens`
 * events, read off the segment: its usage, the provider cost the event's own
 * rows produced, its steps, tool calls and stop reason. Never the prompt or
 * message content.
 */
export const priceAgentResource = (args: {
  agentId: string;
  ownerProjectId: number;
  tokens: UsageTokens;
  providerCostUsd: string | null;
  inputModalities: readonly string[];
  turn: GenerationTurnFacts;
}): Promise<{
  components: PricedResourceComponent[];
  invalid: InvalidQuantity[];
}> => {
  const { steps } = args.turn;
  return priceResource({
    type: 'agent',
    id: args.agentId,
    ownerProjectId: args.ownerProjectId,
    buildContext: () => {
      return Promise.resolve({
        response: {
          usage: {
            input_tokens: args.tokens.inputTokens,
            output_tokens: args.tokens.outputTokens,
            cached_tokens: args.tokens.cachedTokens,
            cache_write_tokens: args.tokens.cacheWriteTokens,
            reasoning_tokens: args.tokens.reasoningTokens,
            input_modalities: args.inputModalities,
          },
          cost_usd:
            args.providerCostUsd === null ? null : Number(args.providerCostUsd),
          steps: steps.length,
          tool_calls: countToolCalls(steps),
          stop_reason: resolveStopReason({
            finishReason: args.turn.finishReason,
            stepCount: steps.length,
            maxSteps: args.turn.maxSteps,
          }),
        },
        outcome: args.turn.outcome,
      });
    },
  });
};
