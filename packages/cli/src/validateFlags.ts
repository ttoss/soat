import { toCanonical, toKebab } from './naming.js';

type RouteFlags = {
  flags: readonly { name: string }[];
  pathParams: readonly string[];
  queryParams: readonly string[];
  httpMethod: string;
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
 * Reject an unrecognized flag **only where the server cannot catch it** — a flag
 * the CLI would otherwise append to the query string.
 *
 * An undeclared query param never reaches a check: the server ignores what it
 * does not know, so `list-agents --limitt 1` returned every row instead of one.
 * The filter failed **open**, with exit 0 and no warning, and the caller acted on
 * a superset it never asked for. The name does not survive the request, so only
 * the client can catch it.
 *
 * An unrecognized flag on a **write** is deliberately still forwarded. The server
 * already answers `400 VALIDATION_FAILED` naming the field (`strictFields`), and
 * that check is the authority on what a body may contain — rejecting locally
 * would front-run it, hide the real error, and make an older CLI refuse a field a
 * newer server accepts. It would also make the behavior untestable through the
 * CLI: `tests/smoke-tests.sh` asserts precisely that the server rejects
 * `update-agent --reasoning` with a 400, which a client-side refusal turns into a
 * usage error the assertion cannot read.
 *
 * Returns the error lines to print; empty when every flag is recognized.
 */
export const findUnknownFlags = (args: {
  commandName: string;
  route: RouteFlags;
  flagKeys: string[];
}): string[] => {
  // Mirrors the routing below in `index.ts`: on a GET an unmatched flag becomes a
  // query param (GETs carry no body), and that is the case with no server-side
  // check behind it. Anything else lands in the body, where `strictFields` rules.
  if (args.route.httpMethod !== 'get') return [];

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
