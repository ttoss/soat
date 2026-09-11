/**
 * Resolves the new tag bag for a tag write: a shallow merge over the current
 * tags when `merge` is set, a full replacement otherwise.
 *
 * Five modules (actors, conversations, documents, files, sessions) wrote this
 * expression out by hand, four of them byte-identically.
 *
 * Both bags are treated as **opaque values** — the helper spreads them without
 * reading a single key, which is what `.claude/rules/case-convention.md`
 * prescribes for `tags` and why the `cost_center`/`costCenter` collapse of
 * #729 cannot recur here.
 */
export const mergeTags = (args: {
  current: Record<string, string> | null | undefined;
  incoming: Record<string, string>;
  merge?: boolean;
}): Record<string, string> => {
  return args.merge
    ? { ...(args.current ?? {}), ...args.incoming }
    : args.incoming;
};

/**
 * Whether a tag bag is actually a filter. An empty object narrows nothing —
 * JSONB containment against `{}` matches every row — so it must never reach a
 * query as though it did.
 */
export const hasTagFilter = (
  tags: Record<string, string> | undefined
): tags is Record<string, string> => {
  return tags !== undefined && Object.keys(tags).length > 0;
};

/**
 * Whether a value is a flat bag of string values — the shape every tagged
 * resource stores. Rejects arrays so a legacy `["a","b"]` body fails loudly
 * rather than being read as an object with numeric keys.
 */
export const isStringRecord = (
  value: unknown
): value is Record<string, string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((item) => {
    return typeof item === 'string';
  });
};

/**
 * Parses `key:value` query-string pairs into a tag bag, the query-string
 * spelling of the same object a JSON body carries. Splits on the FIRST colon
 * only, so a value may itself contain colons. Returns null for a malformed
 * pair, which the caller reports as a client error rather than silently
 * dropping a filter the caller believed narrowed the result.
 */
export const parseTagPairs = (
  raw: string | string[] | undefined
): Record<string, string> | null | undefined => {
  if (raw === undefined) return undefined;
  const values = Array.isArray(raw) ? raw : [raw];
  const tags: Record<string, string> = {};
  for (const pair of values) {
    const separator = pair.indexOf(':');
    if (separator <= 0) return null;
    tags[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return tags;
};
