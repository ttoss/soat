import type { Tool } from 'ai';
import createDebug from 'debug';

import {
  CLIENT_TOOL_GATE,
  type ClientToolGate,
  type GatedClientTool,
} from './agentToolGuardrail';

const log = createDebug('soat:guardrails');

/** A client tool call the model proposed but the server did not execute. */
export type PendingClientToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

/** A call the gate released to the client — `input` is the justification-stripped args. */
export type ReleasedClientCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

/** A tool result the gate synthesized for a call it did NOT release (D / tripwire / pending_approval). */
export type SynthesizedClientResult = {
  toolCallId: string;
  toolName: string;
  output: Record<string, unknown>;
};

export type ClientToolGateOutcome = {
  released: ReleasedClientCall[];
  synthesizedResults: SynthesizedClientResult[];
};

const readGate = (tool: Tool | undefined): ClientToolGate | undefined => {
  if (!tool) return undefined;
  return (tool as GatedClientTool)[CLIENT_TOOL_GATE];
};

/**
 * The guardrail gate for the `requires_action` handoff. For each pending client
 * tool call, runs the gate the resolver attached (if any) and partitions the
 * batch:
 *
 * - **released** — class A or a passing class B: the call is handed to the
 *   client (as it always was), with the approval-justification fields stripped.
 * - **synthesizedResults** — class D (blocked), a class-B tripwire, or class C
 *   (`route_to_approval`, which files the approval item and returns
 *   `pending_approval`): the call is NOT released; a tool result is synthesized
 *   so the model loop can proceed. See [guardrails.md — Client Tools].
 *
 * A call whose tool carries no gate (no guardrail applies) is released untouched.
 */
export const gatePendingClientTools = async (args: {
  pendingToolCalls: PendingClientToolCall[];
  resolvedTools: Record<string, Tool>;
}): Promise<ClientToolGateOutcome> => {
  const released: ReleasedClientCall[] = [];
  const synthesizedResults: SynthesizedClientResult[] = [];

  for (const call of args.pendingToolCalls) {
    const gate = readGate(args.resolvedTools[call.toolName]);
    if (!gate) {
      released.push(call);
      continue;
    }
    const outcome = await gate({ input: call.input });
    if (outcome.decision === 'execute') {
      released.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: outcome.cleanArgs,
      });
      continue;
    }
    synthesizedResults.push({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      // `result` is always set for a non-execute decision; fall back defensively.
      output: outcome.result ?? { status: 'blocked' },
    });
  }

  log(
    'gatePendingClientTools: total=%d released=%d synthesized=%d',
    args.pendingToolCalls.length,
    released.length,
    synthesizedResults.length
  );
  return { released, synthesizedResults };
};
