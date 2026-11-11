import type { PolicyDocument } from './iam';
import { ACTOR_ID_VARIABLE } from './iamConditionKeys';

/**
 * `${iam:ActorId}` in a condition value: the end user a generation runs for.
 * Bound only where the agent's `policy_ids` are resolved for a turn; anywhere
 * else it stays unbound, and an unbound variable matches nothing.
 */
export { ACTOR_ID_VARIABLE };

const POLICY_VARIABLES = new Set([ACTOR_ID_VARIABLE]);

const VARIABLE_PATTERN = /\$\{([^}]*)\}/g;

/** The variables a value names that the platform does not supply. */
export const unknownPolicyVariables = (value: string): string[] => {
  return [...value.matchAll(VARIABLE_PATTERN)]
    .filter((match) => {
      return !POLICY_VARIABLES.has(match[1]);
    })
    .map((match) => {
      return match[0];
    });
};

export const hasUnboundPolicyVariable = (value: string): boolean => {
  return value.includes('${');
};

/** `document` with each `${iam:ActorId}` replaced; `null` leaves it unbound. */
export const bindPolicyVariables = (args: {
  document: PolicyDocument;
  actorId: string | null | undefined;
}): PolicyDocument => {
  const { actorId } = args;
  if (!actorId) return args.document;
  return {
    statement: args.document.statement.map((statement) => {
      if (!statement.condition) return statement;
      const condition = Object.fromEntries(
        Object.entries(statement.condition).map(([operator, block]) => {
          return [
            operator,
            Object.fromEntries(
              Object.entries(block ?? {}).map(([key, value]) => {
                return [
                  key,
                  value.replaceAll(`\${${ACTOR_ID_VARIABLE}}`, actorId),
                ];
              })
            ),
          ];
        })
      );
      return { ...statement, condition };
    }),
  };
};
