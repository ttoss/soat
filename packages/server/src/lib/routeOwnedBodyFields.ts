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
  // `role: "system"` answers `SYSTEM_MESSAGE_NOT_ALLOWED`.
  'POST /api/v1/agents/{agent_id}/generate': ['messages.*.role'],
  'POST /api/v1/conversations/{conversation_id}/messages': ['role'],
  // `INVALID_OUTPUT_SCHEMA`.
  'POST /api/v1/agents': ['output_schema'],
  'PUT /api/v1/agents/{agent_id}': ['output_schema'],
  'PATCH /api/v1/agents/{agent_id}': ['output_schema'],
  // `parameters` may be a JSON-encoded object; `context_keys` answers
  // `INVALID_TOOL_CONTEXT_KEY`.
  'POST /api/v1/tools': ['parameters', 'context_keys'],
  'PATCH /api/v1/tools/{tool_id}': ['parameters', 'context_keys'],
  // `APPROVAL_INVALID_EDIT`; `null` approves without an edit.
  'POST /api/v1/approvals/{approval_id}/approve': ['arguments'],
  // The `message` / `document_id` union names the field the caller missed.
  'POST /api/v1/sessions/{session_id}/messages': [''],
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
  // The validator judges the bag and answers its verdict at 200.
  'POST /api/v1/metadata-schemas/validate': ['metadata'],
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
