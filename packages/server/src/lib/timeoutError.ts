// Every timeout a primitive can raise: `AbortSignal.timeout`, `withCallTimeout`
// (builtin tools), and undici's connect/headers/body timeouts, which arrive as
// the `cause` of a `fetch failed` TypeError. Checked by name, not
// `instanceof`: an abort's DOMException can come from another realm.
const isTimeoutNode = (node: object): boolean => {
  if ('name' in node && node.name === 'TimeoutError') return true;
  if ('cause' in node && node.cause === 'SOAT_TOOL_CALL_TIMEOUT_MS') {
    return true;
  }
  return (
    'code' in node &&
    typeof node.code === 'string' &&
    node.code.startsWith('UND_ERR_') &&
    node.code.endsWith('TIMEOUT')
  );
};

export const isTimeoutError = (args: { error: unknown }): boolean => {
  let current: unknown = args.error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if (isTimeoutNode(current)) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
};
