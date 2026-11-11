/**
 * OpenAPI 3.0 says "exactly one of `tool_id` / `agent_id`" with a `oneOf`
 * whose branches only carry `required`, written beside the level's own
 * `properties`. Such a union constrains which declared fields are present; it
 * adds no shape, so every reader of the field list treats the level as if the
 * union were not there.
 */

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isRequiredOnlyBranch = (branch: unknown): boolean => {
  if (!isNode(branch) || Object.keys(branch).length !== 1) return false;
  return (
    Array.isArray(branch.required) &&
    branch.required.every((name) => {
      return typeof name === 'string';
    })
  );
};

/**
 * `oneOf`/`anyOf` present, no `allOf`, and every branch of each union carries
 * only `required`.
 */
export const hasOnlyPresenceUnions = (schema: Node): boolean => {
  if ('allOf' in schema) return false;
  const unions = [schema.oneOf, schema.anyOf].filter((branches) => {
    return branches !== undefined;
  });
  return (
    unions.length > 0 &&
    unions.every((branches) => {
      return (
        Array.isArray(branches) &&
        branches.length > 0 &&
        branches.every(isRequiredOnlyBranch)
      );
    })
  );
};
