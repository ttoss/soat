/**
 * The refusal an agent reads when its `policy_ids` deny an action, on every
 * tool path that checks them.
 */
export const agentPolicyDenial = (args: { action: string }): string => {
  return `Forbidden: the agent's policies deny ${args.action}`;
};
