/**
 * The tool result a model reads when its agent's `policy_ids` refuse
 * `action`, whatever resource the call named.
 */
export const agentRefusal = (args: { action: string }) => {
  return {
    error: {
      code: 'FORBIDDEN',
      message: expect.stringMatching(
        new RegExp(
          `^Forbidden: the agent's policies deny ${args.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( on |$)`
        )
      ),
      meta: expect.objectContaining({
        action: args.action,
        denied_by: { type: 'agent', id: null },
      }),
    },
  };
};
