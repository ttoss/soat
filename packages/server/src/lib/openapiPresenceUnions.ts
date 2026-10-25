/**
 * OpenAPI 3.0 says "exactly one of `tool_id` / `agent_id`" with a `oneOf`
 * whose branches only carry `required`, written beside the level's own
 * `properties`. Such a union constrains which declared fields are present; it
 * adds no shape, so every reader of the field list treats the level as if the
 * union were not there. Pure: the server and the website's tool docs both load
 * it.
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

/**
 * Removes every presence-only union from `node` in place, at any depth. A
 * tool's input schema cannot carry one: the derivation library flattens a
 * union into its branches, which drops the level's `properties`, and tool
 * clients refuse a top-level `oneOf`. The server still enforces the
 * constraint, so the tool caller learns it from the `400`.
 */
export const stripPresenceUnions = (node: unknown): void => {
  if (Array.isArray(node)) {
    for (const item of node) stripPresenceUnions(item);
    return;
  }
  if (!isNode(node)) return;
  if (hasOnlyPresenceUnions(node)) {
    delete node.oneOf;
    delete node.anyOf;
  }
  for (const value of Object.values(node)) stripPresenceUnions(value);
};
