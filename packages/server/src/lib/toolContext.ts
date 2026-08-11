import { DomainError } from '../errors';

/**
 * `tool_context` — the key/value map a caller injects so `http`, `mcp` and
 * `soat` tools can authorize against the caller's identity instead of trusting
 * data embedded in the prompt. Each entry is forwarded as one request header.
 *
 * Lives in its own module because both the tool resolver (which builds the
 * outbound headers) and the session/generation write paths (which validate
 * caller input) need it, and `agentToolResolver` cannot be imported from
 * `sessions` without a cycle.
 */

/**
 * RFC 7230 `token` characters — the grammar for a valid HTTP header name. A key
 * outside this set produces a header name that `fetch` rejects with a
 * `TypeError` at tool-call time, mid-generation. The same grammar constrains the
 * configurable prefix, since prefix + key must be one valid header name.
 */
const HEADER_TOKEN_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * The prefix a `tool_context` key is stamped with, when the deployment does not
 * configure one. Every SOAT deployment that has not set
 * `TOOL_CONTEXT_HEADER_PREFIX` keeps exactly this behavior.
 */
export const DEFAULT_TOOL_CONTEXT_HEADER_PREFIX = 'X-Soat-Context-';

/**
 * The prefix is deployment configuration, not a caller input: a platform
 * fronting SOAT must be able to keep the substrate's name out of the requests
 * its agents send to third-party tool providers (#945).
 *
 * Read per call rather than captured at module load, so the value a deployment
 * sets is the value used regardless of when the module graph was loaded — the
 * same shape as `getEncryptionKey` in `secrets.ts`.
 *
 * An empty or unset value means "not configured" and falls back to the default.
 * It deliberately cannot *remove* the prefix: an unprefixed key would let a
 * caller-supplied `tool_context` entry land on an arbitrary header name —
 * `Authorization` included — which is precisely the invariant the prefix exists
 * to hold (#843/#850/#851).
 */
const getContextHeaderPrefix = (): string => {
  const configured = process.env.TOOL_CONTEXT_HEADER_PREFIX;
  if (!configured) return DEFAULT_TOOL_CONTEXT_HEADER_PREFIX;

  // A prefix outside the header-name grammar fails inside `fetch`, on every
  // tool call the deployment makes, with a `TypeError` that names neither the
  // env var nor the prefix. Fail with something an operator can act on instead.
  if (!HEADER_TOKEN_RE.test(configured)) {
    throw new Error(
      `TOOL_CONTEXT_HEADER_PREFIX '${configured}' is not a valid HTTP header-name prefix — it may only contain letters, digits and the characters !#$%&'*+-.^_\`|~.`
    );
  }

  return configured;
};

/**
 * The key → header-name rule: prepend the configured context prefix
 * (`X-Soat-Context-` by default). That is the whole rule — the key is a
 * caller-owned identifier and reaches the header name with **no character
 * transformed**, so the header is a string concatenation the caller can compute
 * from the prefix alone.
 *
 * Deliberately not title-casing, and deliberately not uppercasing the first
 * character either. Normalizing separators would silently change which header
 * an existing caller's key lands on, and caller keys take precedence over the
 * session's auto-populated ones, so it could rewrite the identity an `http`
 * tool authorizes against. Uppercasing just the first character avoided that
 * but kept the shape of the transform — and this project has already paid for
 * key-rewriting four times (#651, #690, #729, #737). The casing was also never
 * observable: header names are case-insensitive (RFC 9110 §5.1) and HTTP/2
 * lowercases them on the wire (RFC 9113 §8.2.1), so it bought presentation
 * only, at the cost of a rule every reader had to be warned not to extend.
 */
export const buildContextHeaderName = (key: string): string => {
  return `${getContextHeaderPrefix()}${key}`;
};

/**
 * Throws `INVALID_TOOL_CONTEXT_KEY` (400) when a `tool_context` key cannot
 * survive the trip to an outbound header. Two failure modes, both silent
 * without this guard:
 *
 * - a key outside the header-name grammar only fails inside `fetch`, so the
 *   caller sees a failed tool call rather than a rejected write;
 * - two keys that differ only in the casing of a later character collapse into
 *   one header (header names are case-insensitive) and the last value wins,
 *   dropping the other without a trace.
 *
 * Accepts every key shape that already works — snake_case, kebab-case and
 * dotted keys are all valid header names and keep their current behavior.
 */
export const assertValidToolContextKeys = (
  toolContext?: Record<string, string> | null
): void => {
  if (!toolContext) return;

  const keys = Object.keys(toolContext);

  const invalid = keys.filter((key) => {
    return !HEADER_TOKEN_RE.test(key);
  });
  if (invalid.length > 0) {
    throw new DomainError(
      'INVALID_TOOL_CONTEXT_KEY',
      `Invalid tool_context key(s) ${invalid
        .map((key) => {
          return `'${key}'`;
        })
        .join(
          ', '
        )} — a key becomes an HTTP header name, so it may only contain letters, digits and the characters !#$%&'*+-.^_\`|~.`,
      { keys: invalid }
    );
  }

  const byHeader = new Map<string, string>();
  for (const key of keys) {
    const header = buildContextHeaderName(key);
    const existing = byHeader.get(header.toLowerCase());
    if (existing !== undefined) {
      throw new DomainError(
        'INVALID_TOOL_CONTEXT_KEY',
        `tool_context keys '${existing}' and '${key}' both map to the header ${header}; header names are case-insensitive, so one value would be silently dropped. Use a single key.`,
        { keys: [existing, key], header }
      );
    }
    byHeader.set(header.toLowerCase(), key);
  }
};

/**
 * The identity keys the server owns. They are derived from trusted state (the
 * session record and its actor) and stamped at the generation chokepoint
 * (`buildGenerationContext`), so a caller cannot address them from any
 * generation entry point — direct agent, conversation, session, trigger,
 * orchestration or nested `soat` tool call (#843, #850, #851).
 */
export const RESERVED_TOOL_CONTEXT_KEYS = [
  'sessionId',
  'actorId',
  'actorExternalId',
] as const;

export type ServerToolContextIdentity = {
  sessionId: string;
  actorId?: string;
  actorExternalId?: string;
};

// Header names are case-insensitive (RFC 9110 §5.1), so `sessionID` lands on
// the same outbound header as `sessionId` — the strip must match by lowercased
// key or a casing variant smuggles the forged header through.
const RESERVED_LOWER = new Set(
  RESERVED_TOOL_CONTEXT_KEYS.map((key) => {
    return key.toLowerCase();
  })
);

/**
 * Makes the reserved identity keys unaddressable by a caller: every reserved
 * key (in any casing) is dropped from the caller bag, then the server-derived
 * identity — when the generation runs for a session — is stamped on top. A
 * generation with no session carries no identity keys at all, so a downstream
 * tool can trust that a `<prefix>sessionId` context header is always
 * server-derived.
 */
export const pinServerIdentityToolContext = (args: {
  toolContext?: Record<string, string>;
  identity: ServerToolContextIdentity | null;
}): Record<string, string> | undefined => {
  if (!args.toolContext && !args.identity) return undefined;

  const stripped = Object.fromEntries(
    Object.entries(args.toolContext ?? {}).filter(([key]) => {
      return !RESERVED_LOWER.has(key.toLowerCase());
    })
  );

  if (!args.identity) return stripped;

  const identity: Record<string, string> = {
    sessionId: args.identity.sessionId,
  };
  if (args.identity.actorId) {
    identity.actorId = args.identity.actorId;
  }
  if (args.identity.actorExternalId) {
    identity.actorExternalId = args.identity.actorExternalId;
  }

  return { ...stripped, ...identity };
};

export const buildContextHeaders = (
  toolContext?: Record<string, string>
): Record<string, string> => {
  if (!toolContext) return {};
  return Object.fromEntries(
    Object.entries(toolContext).map(([key, value]) => {
      return [buildContextHeaderName(key), value];
    })
  );
};
