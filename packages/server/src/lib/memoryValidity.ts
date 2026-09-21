/**
 * Which memories still hold.
 *
 * Validity is one column on the memory — a supersede sets it with a
 * replacement, a retraction sets it without one — and every read that must not
 * answer with a retired fact narrows itself here: the listing, knowledge
 * search, and the dedup candidate a write is resolved against. One helper
 * rather than one predicate per reader, because a reader that decides for
 * itself is how a retired fact stays reachable from whichever one was missed;
 * `memoryScopeContract.test.ts` fails when a new reader writes its own.
 *
 * Reads by id never come through here: an invalidated memory stays addressable,
 * which is what keeps its text and its assertions readable for audit.
 */
export const validMemoryWhere = (): Record<string, unknown> => {
  return { invalidatedAt: null };
};
