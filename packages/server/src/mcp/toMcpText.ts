/**
 * Renders a REST response as the text payload of an MCP tool result.
 *
 * The MCP surface speaks the same contract as REST/SDK/CLI/docs: snake_case,
 * exactly as the route produced it. Nothing here rewrites keys — a response is
 * either already a string (passed through) or JSON-stringified verbatim — so
 * author-authored and contract-fixed keys inside opaque bags (a guardrail
 * `document`'s `default_class`, a `tool_context` header name, a `tags` key an
 * IAM condition selects on) reach the client as themselves. This is the property
 * a recursive key transform with a hand-curated skip list could never hold:
 * every historical incident was a bag somebody forgot to exempt.
 */
export const toMcpText = (value: unknown): string => {
  if (value == null) {
    return 'Deleted successfully.';
  }

  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value);
};
