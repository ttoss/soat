/**
 * Every resource whose work runs under its own `policy_ids`, by its
 * `WRITER_RULE_CARRIERS` name, with the principal type a record or a refusal
 * names it by. `lib/resourceGrants.ts` reads each one's policies.
 */
export const RESOURCE_GRANT_PRINCIPALS = {
  evals: 'eval',
  deciders: 'decider',
  ingestionRules: 'ingestion_rule',
  memoryRules: 'memory_rule',
  playbookVersions: 'playbook_version',
} as const;

export type ResourceGrantCarrier = keyof typeof RESOURCE_GRANT_PRINCIPALS;

export type ResourceGrantPrincipalType =
  (typeof RESOURCE_GRANT_PRINCIPALS)[ResourceGrantCarrier];

export const isResourceGrantCarrier = (
  value: unknown
): value is ResourceGrantCarrier => {
  return (
    typeof value === 'string' && Object.hasOwn(RESOURCE_GRANT_PRINCIPALS, value)
  );
};

export const RESOURCE_GRANT_PRINCIPAL_TYPES: readonly ResourceGrantPrincipalType[] =
  Object.values(RESOURCE_GRANT_PRINCIPALS);
