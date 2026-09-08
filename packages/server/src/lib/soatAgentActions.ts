import createDebug from 'debug';

import { soatTools } from './soatTools';

const log = createDebug('soat:tools');

/**
 * The platform actions an agent's `builtin` tool may not be bound to, declared
 * per operation in the OpenAPI specs as `x-soat-agent-exclude` so the exclusion
 * lives beside the route it protects rather than in a list that drifts from it.
 *
 * Derived from the same catalog the tool surface is built from, so an action
 * added to a spec is either excluded there or available everywhere — there is
 * no second place to remember.
 */
export const AGENT_EXCLUDED_ACTIONS: ReadonlySet<string> = new Set(
  soatTools
    .filter((tool) => {
      return tool.agentExcluded;
    })
    .map((tool) => {
      return tool.name;
    })
);

export const isAgentExcludedAction = (action: string): boolean => {
  return AGENT_EXCLUDED_ACTIONS.has(action);
};

/**
 * Drops the excluded actions from a stored binding, so a tool row written
 * before the exclusion existed loses them at resolution rather than handing an
 * agent an action the write would now refuse. Logged: dropped silently, it
 * reads as "the agent ignored my tool".
 */
export const withoutAgentExcludedActions = (args: {
  actions: string[];
  toolName: string;
}): string[] => {
  return args.actions.filter((action) => {
    if (!isAgentExcludedAction(action)) return true;
    log(
      'resolveSoatTools: dropping excluded action %s from tool %s',
      action,
      args.toolName
    );
    return false;
  });
};
