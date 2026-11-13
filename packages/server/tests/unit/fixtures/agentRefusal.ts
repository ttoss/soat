const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * The tool result a model reads when agent `agentId`'s `policy_ids` refuse
 * `action`, whatever resource the call named.
 */
export const agentRefusal = (args: { agentId: string; action: string }) => {
  return {
    error: {
      code: 'FORBIDDEN',
      message: expect.stringMatching(
        new RegExp(
          `^Forbidden: agent ${escapeRegExp(args.agentId)}'s policies deny ${escapeRegExp(args.action)}( on |$)`
        )
      ),
      meta: expect.objectContaining({
        action: args.action,
        denied_by: { type: 'agent', id: args.agentId },
      }),
    },
  };
};
