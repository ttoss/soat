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
