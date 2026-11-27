import type { Tool } from 'ai';
import createDebug from 'debug';

import { emitActivityEntry } from './activity';
import { resolvedActionName } from './agentToolApproval';

const log = createDebug('soat:activity');

/**
 * The identity an agent-generation-time tool call is attributed to on the
 * activity feed, threaded from the generation entry point (where agent,
 * generation and project are all known) into the resolver — the same threading
 * the guardrail context does, kept separate so the feed does not depend on a
 * guardrail applying.
 *
 * The orchestration tool-node executor emits `action_executed` at its own call
 * site: a tool node has a node, not an agent, and runs in no generation.
 */
export type ActivityCallContext = {
  projectId: number;
  agentId: string;
  generationId?: string | null;
  orchestrationRunId?: string | null;
};

/** What a tool's executed call is recorded as on the activity feed. */
export type ToolActivity = {
  toolId: string | null;
  action: string;
  activity: ActivityCallContext;
};

const TOOL_ACTIVITY: unique symbol = Symbol('soat.toolActivity');

type MarkedTool = Tool & { [TOOL_ACTIVITY]?: ToolActivity };

export const toolActivityOf = (resolved: Tool): ToolActivity | undefined => {
  const marked: MarkedTool = resolved;
  return marked[TOOL_ACTIVITY];
};

/**
 * Marks every server-executed tool produced by one binding (one for most
 * types; many for `mcp` / `builtin`) with what its executed call records on the
 * activity feed. The mark survives every wrapper (each spreads the tool);
 * `recordToolCall` (`generationInstrumentation.ts`) reads it.
 *
 * Client tools are skipped: the call is handed to the client, so the platform
 * never executed the action and cannot attest that it happened.
 */
export const markToolActivity = (args: {
  tools: Record<string, Tool>;
  toolId: string | null;
  toolType: string;
  toolName: string;
  activity: ActivityCallContext;
}): Record<string, Tool> => {
  const marked: Record<string, Tool> = {};
  for (const [key, resolvedTool] of Object.entries(args.tools)) {
    if (!resolvedTool.execute) {
      marked[key] = resolvedTool;
      continue;
    }
    const mark: ToolActivity = {
      // An inline (ephemeral) tool has no persisted id to reference.
      toolId: args.toolId || null,
      action: resolvedActionName({
        type: args.toolType,
        toolName: args.toolName,
        key,
      }),
      activity: args.activity,
    };
    const markedTool: MarkedTool = { ...resolvedTool, [TOOL_ACTIVITY]: mark };
    marked[key] = markedTool;
  }
  return marked;
};

/**
 * Records an `action_executed` entry for a call that reached its tool and
 * returned. Fire-and-forget: `emitActivityEntry` swallows its own failures,
 * so a recording hiccup never fails or delays the tool result.
 */
export const recordToolExecuted = (mark: ToolActivity): void => {
  log(
    'recordToolExecuted: agentId=%s action=%s',
    mark.activity.agentId,
    mark.action
  );
  void emitActivityEntry({
    projectId: mark.activity.projectId,
    kind: 'action_executed',
    summary: `Tool '${mark.action}' executed by agent '${mark.activity.agentId}'`,
    detail: { action: mark.action, toolId: mark.toolId },
    orchestrationRunId: mark.activity.orchestrationRunId ?? null,
    agentId: mark.activity.agentId,
    generationId: mark.activity.generationId ?? null,
    refId: mark.toolId,
  });
};

/**
 * Records that a tool binding resolved to nothing because its source could not
 * be reached — an unreachable MCP server, most often.
 *
 * The resolver drops such a binding rather than failing the turn, which is the
 * right call — one flaky server must not take an agent down. Unrecorded, that
 * is indistinguishable from an agent that simply has no tools: the generation
 * completes, carries no warning and no error, and answers without the tools it
 * was configured to have. That is a correctness problem, not a cost one, and it
 * is only visible here — the prompt is the one place the absence shows, and
 * nobody reads the prompt.
 *
 * Fire-and-forget like the execution recording beside it: a feed hiccup must
 * not fail a turn that is otherwise fine.
 */
export const recordToolResolutionFailure = (args: {
  toolId: string | null;
  toolType: string;
  toolName: string;
  reason: string;
  activity: ActivityCallContext;
}): void => {
  const { activity } = args;

  log(
    'recordToolResolutionFailure: agentId=%s toolName=%s',
    activity.agentId,
    args.toolName
  );

  void emitActivityEntry({
    projectId: activity.projectId,
    kind: 'tool_resolution_failed',
    summary: `Tool '${args.toolName}' could not be resolved for agent '${activity.agentId}' and was left out of the turn`,
    detail: {
      toolId: args.toolId,
      toolType: args.toolType,
      toolName: args.toolName,
      reason: args.reason,
    },
    orchestrationRunId: activity.orchestrationRunId ?? null,
    agentId: activity.agentId,
    generationId: activity.generationId ?? null,
    refId: args.toolId,
  });
};
