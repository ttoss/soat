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
 * Absent on callers with no agent in scope: the orchestration tool-node executor
 * emits `action_executed` at its own call site (it has a node, not an agent), so
 * it passes no context here and never double-records.
 */
export type ActivityCallContext = {
  projectId: number;
  agentId: string;
  generationId?: string | null;
  runId?: string | null;
};

/**
 * Wraps one resolved tool's `execute` so a **successful** call records an
 * `action_executed` entry. Applied innermost — inside the guardrail interceptor —
 * which is what makes the recording mean "the tool actually ran": a call the
 * guardrail blocks, trips, or routes to approval never reaches this wrapper, and
 * neither does one whose target throws.
 */
const buildRecordedExecute = (args: {
  originalExecute: NonNullable<Tool['execute']>;
  toolId: string | null;
  action: string;
  activity: ActivityCallContext;
}): NonNullable<Tool['execute']> => {
  return async (...executeArgs) => {
    const result = await args.originalExecute(...executeArgs);
    // Fire-and-forget, mirroring the orchestration executor: `emitActivityEntry`
    // swallows its own failures, so a recording hiccup can never fail or delay
    // the tool result the model is waiting on.
    void emitActivityEntry({
      projectId: args.activity.projectId,
      kind: 'action_executed',
      summary: `Tool '${args.action}' executed by agent '${args.activity.agentId}'`,
      detail: {
        action: args.action,
        toolId: args.toolId,
        generationId: args.activity.generationId ?? null,
      },
      runId: args.activity.runId ?? null,
      agentId: args.activity.agentId,
      refId: args.toolId,
    });
    return result;
  };
};

/**
 * Records every server-executed tool produced by one binding (one for most
 * types; many for `mcp` / `soat`) on the activity feed. A no-op when the caller
 * threaded no {@link ActivityCallContext}.
 *
 * Client tools are skipped: they have no server-side `execute` — the call is
 * handed to the client, so the platform never executed the action and cannot
 * attest that it happened.
 */
export const recordToolActivity = (args: {
  tools: Record<string, Tool>;
  toolId: string | null;
  toolType: string;
  toolName: string;
  activity?: ActivityCallContext;
}): Record<string, Tool> => {
  const { activity } = args;
  if (!activity) return args.tools;

  log(
    'recordToolActivity: agentId=%s toolName=%s tools=%d',
    activity.agentId,
    args.toolName,
    Object.keys(args.tools).length
  );

  const recorded: Record<string, Tool> = {};
  for (const [key, resolvedTool] of Object.entries(args.tools)) {
    if (!resolvedTool.execute) {
      recorded[key] = resolvedTool;
      continue;
    }
    recorded[key] = {
      ...resolvedTool,
      execute: buildRecordedExecute({
        originalExecute: resolvedTool.execute,
        // An inline (ephemeral) tool has no persisted id to reference.
        toolId: args.toolId || null,
        action: resolvedActionName({
          type: args.toolType,
          toolName: args.toolName,
          key,
        }),
        activity,
      }),
    };
  }
  return recorded;
};
