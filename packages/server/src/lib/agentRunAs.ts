import { DomainError } from '../errors';

/**
 * What an agent's `policy_ids` are: a cap on the caller (`caller`), or the
 * agent's own grant (`agent`).
 */
export const AGENT_RUN_AS = ['caller', 'agent'] as const;

export type AgentRunAs = (typeof AGENT_RUN_AS)[number];

/**
 * A stored value read back: anything but `agent` runs as the caller, so an
 * unrecognised value never acts beyond whoever called.
 */
export const readAgentRunAs = (value: unknown): AgentRunAs => {
  return value === 'agent' ? 'agent' : 'caller';
};

/** A written value: absent leaves it unchanged, anything outside the enum is refused. */
export const parseAgentRunAs = (value: unknown): AgentRunAs | undefined => {
  if (value === undefined) return undefined;
  if (value === 'caller' || value === 'agent') return value;
  throw new DomainError(
    'VALIDATION_FAILED',
    "`run_as` must be 'caller' or 'agent'.",
    { field: 'run_as' }
  );
};

/** A `run_as: agent` agent with no policy would act under nothing. */
export const assertRunAsHasPolicies = (args: {
  runAs: unknown;
  policyIds: unknown;
}): void => {
  if (readAgentRunAs(args.runAs) !== 'agent') return;
  if (Array.isArray(args.policyIds) && args.policyIds.length > 0) return;
  throw new DomainError(
    'AGENT_RUN_AS_REQUIRES_POLICIES',
    'An agent with `run_as: agent` needs a non-empty `policy_ids`.'
  );
};
