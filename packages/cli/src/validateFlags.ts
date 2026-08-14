import { toCanonical, toKebab } from './naming.js';

type RouteFlags = {
  flags: readonly { name: string }[];
  pathParams: readonly string[];
  queryParams: readonly string[];
};

/** Accepted on any command: Commander globals plus the generic id alias. */
const ALWAYS_ALLOWED = new Set(['profile', 'id']);

/**
 * Every flag name this command accepts, canonicalized. Wrapper-added flags are
 * absent on purpose — a wrapper deletes the flags it consumed before this runs,
 * so anything left over really is unrecognized.
 */
const knownFlagsFor = (route: RouteFlags): Set<string> => {
  return new Set(
    [
      ...route.flags.map((f) => {
        return f.name;
      }),
      ...route.pathParams,
      ...route.queryParams,
    ].map(toCanonical)
  );
};

/**
 * Offer the closest known flag, so a typo is one line away from its fix rather
 * than a trip to `--help`. Prefix matching in either direction covers the real
 * cases (`limitt`/`limit`, `agent`/`agent_id`) without a full edit-distance pass.
 */
const suggestionFor = (args: { flag: string; known: Set<string> }): string => {
  const target = toCanonical(args.flag).toLowerCase();
  const near = [...args.known].find((known) => {
    const candidate = known.toLowerCase();
    return candidate.startsWith(target) || target.startsWith(candidate);
  });

  return near ? ` Did you mean --${toKebab(near)}?` : '';
};

/**
 * Reject a flag that matches no parameter of this command, rather than
 * forwarding it.
 *
 * An unknown flag in a request *body* would at least come back as a `400` from
 * the server's `strictFields` check, but an undeclared *query* param never
 * reaches a check — the server ignores what it does not know — so
 * `list-agents --limitt 1` returned every row instead of one. A mistyped filter
 * that fails open, with exit 0, is worse than one that fails: the caller acts on
 * a superset it never asked for. Only the client can catch that, because the
 * name never survives the request.
 *
 * Returns the error lines to print; empty when every flag is recognized.
 */
export const findUnknownFlags = (args: {
  commandName: string;
  route: RouteFlags;
  flagKeys: string[];
}): string[] => {
  const known = knownFlagsFor(args.route);
  const unknown = args.flagKeys.filter((flagKey) => {
    if (ALWAYS_ALLOWED.has(flagKey)) return false;
    return !known.has(toCanonical(flagKey));
  });

  if (unknown.length === 0) return [];

  return [
    ...unknown.map((flag) => {
      return `Unknown flag --${flag} for '${args.commandName}'.${suggestionFor({ flag, known })}`;
    }),
    `Run "soat ${args.commandName} --help" to see the flags this command accepts.`,
  ];
};
