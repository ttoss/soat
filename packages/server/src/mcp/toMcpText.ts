const snakeToCamel = (str: string): string => {
  return str.replace(/_([a-z])/g, (_, char) => {
    return char.toUpperCase();
  });
};

/**
 * Keys whose values are free-form / JSON-Logic-bearing bags: their inner keys
 * are author-authored data or fixed contract paths — a guardrail `document`'s
 * `default_class` / `expires_in`, a `context_snapshot`'s fully-qualified var
 * paths (`soat.usage.cost_usd_24h`, `context.max_daily_budget`), a JSON Logic
 * `guard` / `expression` body — NOT SOAT field names. The REST caseTransform
 * middleware preserves these verbatim on the way out (see its skip lists); the
 * MCP surface must match, or a read mangles them to `defaultClass` /
 * `costUsd_24h`, which breaks read→write round-trips (the mangled field is
 * rejected as an unknown field on write) and the audit-key contract (#651).
 *
 * Mirrors caseTransform's GLOBAL outbound skip set, plus the guardrail
 * `document` / `context_snapshot` bags. Path-scoped bags (`input`, `output`,
 * `state`, `artifacts`, `args`, `payload`) are intentionally omitted: the MCP
 * layer has no request path to scope them by, and some collide with genuine
 * camelCase fields (e.g. a generation's `output`), so they stay transformed.
 * Keys are the camelCased (post-transform) form, matching the check below.
 */
const VERBATIM_KEYS: ReadonlySet<string> = new Set([
  'document',
  'contextSnapshot',
  'template',
  'parameters',
  'execute',
  'mcp',
  'presetParameters',
  'stateMapping',
  'expression',
  'exitCondition',
  'guard',
  'when',
  'headers',
]);

export const snakeToCamelDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => {
      return snakeToCamelDeep(item);
    });
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
        const newKey = snakeToCamel(key);
        // A verbatim bag: camelCase the key itself (it is a SOAT field) but do
        // not recurse into its value, so its author-authored / contract inner
        // keys survive unchanged — exactly as the REST caseTransform does.
        if (VERBATIM_KEYS.has(newKey)) {
          return [newKey, nested];
        }
        return [newKey, snakeToCamelDeep(nested)];
      })
    );
  }

  return value;
};

export const toMcpText = (value: unknown): string => {
  if (value == null) {
    return 'Deleted successfully.';
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return JSON.stringify(snakeToCamelDeep(parsed));
    } catch {
      return value;
    }
  }

  return JSON.stringify(snakeToCamelDeep(value));
};
