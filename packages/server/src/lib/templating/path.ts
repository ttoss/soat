/**
 * Dotted-path lookup into an arbitrary value, mirroring the JSON Logic `var`
 * operator's semantics so the string-template engine and the JSON Logic engine
 * resolve `a.b.0.c` the same way. Walks objects and arrays, returning
 * `undefined` as soon as a segment is missing or the cursor is not indexable.
 * An empty path returns the context itself (the root).
 */
export const getPath = (context: unknown, dottedKey: string): unknown => {
  if (dottedKey === '') return context;
  const segments = dottedKey.split('.');
  let cursor: unknown = context;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};
