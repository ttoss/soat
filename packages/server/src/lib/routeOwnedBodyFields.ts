/**
 * Body fields whose schema violations the route answers itself, keyed by
 * `METHOD /api/v1/...` template, each a dotted path (`*` matches any one
 * segment; `''` is the whole body). Every other value in a JSON body is held
 * to the full request schema by `validateRequestBody`; an entry here only
 * moves the refusal to the route, which owns a code, a coercion or a 200
 * verdict the schema cannot express.
 */
export const ROUTE_OWNED_BODY_FIELDS: Readonly<
  Record<string, readonly string[]>
> = {
  // `PLAYBOOK_CASE_UPSTREAM_INVALID`.
  'POST /api/v1/playbooks/{playbook_id}/cases': ['upstreams'],
  'POST /api/v1/playbook-cases/{case_id}/upgrade': ['upstreams'],
  // Per-scorer messages name the scorer's own missing field.
  'POST /api/v1/evals': ['scorers'],
  'PUT /api/v1/evals/{eval_id}': ['scorers'],
  // The template validator answers with `problems`, at 200 on `validate`.
  'POST /api/v1/formations/validate': ['template'],
  'POST /api/v1/formations/plan': ['template'],
  'POST /api/v1/formations': ['template'],
  'PUT /api/v1/formations/{formation_id}': ['template'],
};

/** Whether a violation at `path` (its segments) is the route's to answer. */
export const isRouteOwnedField = (args: {
  operation: string;
  path: readonly string[];
}): boolean => {
  const patterns = ROUTE_OWNED_BODY_FIELDS[args.operation] ?? [];
  return patterns.some((pattern) => {
    const segments = pattern === '' ? [] : pattern.split('.');
    return (
      segments.length <= args.path.length &&
      segments.every((segment, index) => {
        return segment === '*' || segment === args.path[index];
      })
    );
  });
};
