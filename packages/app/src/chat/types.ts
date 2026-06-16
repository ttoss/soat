import type { ViewDescriptor } from '@/engine/types';

// An AI provider as returned by GET /api/v1/ai-providers (snake_case contract).
export type AiProvider = {
  id: string;
  name: string;
  provider: string;
  default_model?: string;
};

// A single pending tool call from a `requires_action` generation response.
// The Agents module returns tool calls as { tool_call_id, tool_name, args }.
export type GuideToolCall = {
  tool_call_id: string;
  tool_name: string;
  args: Record<string, unknown>;
};

// Response shape of POST /agents/{id}/generate and the tool-outputs endpoint.
export type GenerateResponse = {
  id: string;
  status: 'completed' | 'requires_action';
  text?: string | null;
  tool_calls?: GuideToolCall[] | null;
};

// A tool output submitted back to resume a paused generation.
export type ToolOutput = {
  tool_call_id: string;
  output: unknown;
};

// A message rendered in the chat transcript. Assistant messages that mounted a
// view carry the descriptor so the user can re-mount it from the transcript.
export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  view?: ViewDescriptor;
};
