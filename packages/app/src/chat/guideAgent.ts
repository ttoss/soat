import { apiFetch } from '@/api/client';
import type { ViewDescriptor } from '@/engine/types';

import type { GenerateResponse, GuideToolCall, ToolOutput } from './types';

const MAX_TOOL_ROUNDS = 8;

type ToolCallExecutor = (call: GuideToolCall) => {
  output: unknown;
  view?: ViewDescriptor;
};

export type GuideTurnResult =
  | { ok: true; text: string; view?: ViewDescriptor }
  | { ok: false; error: string };

const generate = (args: {
  token: string;
  agentId: string;
  messages: Array<{ role: string; content: string }>;
}) => {
  return apiFetch<GenerateResponse>({
    url: `/api/v1/agents/${encodeURIComponent(args.agentId)}/generate`,
    method: 'POST',
    token: args.token,
    body: { messages: args.messages },
  });
};

const submitToolOutputs = (args: {
  token: string;
  agentId: string;
  generationId: string;
  toolOutputs: ToolOutput[];
}) => {
  return apiFetch<GenerateResponse>({
    url: `/api/v1/agents/${encodeURIComponent(
      args.agentId
    )}/generate/${encodeURIComponent(args.generationId)}/tool-outputs`,
    method: 'POST',
    token: args.token,
    body: { tool_outputs: args.toolOutputs },
  });
};

// Run one guide turn: start a generation, resolve any render_page tool calls by
// mounting views, and resume until the agent produces its final text reply.
export const runGuideTurn = async (args: {
  token: string;
  agentId: string;
  messages: Array<{ role: string; content: string }>;
  executeToolCall: ToolCallExecutor;
}): Promise<GuideTurnResult> => {
  let result = await generate({
    token: args.token,
    agentId: args.agentId,
    messages: args.messages,
  });

  let lastView: ViewDescriptor | undefined;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (!result.ok) return { ok: false, error: result.error.message };
    if (result.data.status !== 'requires_action') break;

    const calls = result.data.tool_calls ?? [];
    const toolOutputs: ToolOutput[] = calls.map((call) => {
      const executed = args.executeToolCall(call);
      if (executed.view) lastView = executed.view;
      return { tool_call_id: call.tool_call_id, output: executed.output };
    });

    result = await submitToolOutputs({
      token: args.token,
      agentId: args.agentId,
      generationId: result.data.id,
      toolOutputs,
    });
  }

  if (!result.ok) return { ok: false, error: result.error.message };
  if (result.data.status === 'requires_action') {
    return { ok: false, error: 'The guide stopped before finishing.' };
  }

  return { ok: true, text: result.data.text ?? '', view: lastView };
};
