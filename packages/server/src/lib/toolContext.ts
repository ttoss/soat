import { DomainError } from '../errors';
import { HEADER_TOKEN_CHARS, soatHeader } from './headerPrefix';
import { readStringBag } from './stringBag';

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
 * The header-name grammar a `tool_context` key must fit, since a key becomes
 * a header. Re-exported because `toolTemplates.ts` composes it into the
 * `{{context:<key>}}` token grammar: key, prefix and token must not be able to
 * disagree about which characters exist.
 */
export const TOOL_CONTEXT_KEY_CHARS = HEADER_TOKEN_CHARS;

const HEADER_TOKEN_RE = new RegExp(`^[${TOOL_CONTEXT_KEY_CHARS}]+$`);

/**
 * `<SOAT_HEADER_PREFIX>Context-`, so a platform fronting SOAT keeps the
 * substrate's name out of the requests its agents send to third-party tool
 * providers. Never empty: an unprefixed key would let a caller-supplied entry
 * land on an arbitrary header name, `Authorization` included.
 */
const getContextHeaderPrefix = (): string => {
  return soatHeader('Context-');
};

/**
 * The key → header-name rule: prepend the configured context prefix
 * (`X-Soat-Context-` by default) and transform **no character**, so the header
 * is a concatenation the caller can compute from the prefix alone.
 *
 * Deliberately neither title-casing nor uppercasing the first character.
 * Normalizing separators would change which header an existing caller's key
 * lands on, and caller keys take precedence over the session's, so it could
 * rewrite the identity an `http` tool authorizes against; uppercasing one
 * character avoided that but kept the shape of a transform this project has
 * already paid for four times. It was never observable
 * either — header names are case-insensitive (RFC 9110 §5.1) and HTTP/2
 * lowercases them (RFC 9113 §8.2.1).
 */
export const buildContextHeaderName = (key: string): string => {
  return `${getContextHeaderPrefix()}${key}`;
};

/**
 * Throws `VALIDATION_FAILED` (400) when a `tool_context` value is not a
 * string, the rule a tag bag follows (`readStringBag`), and
 * `INVALID_TOOL_CONTEXT_KEY` (400) when a key cannot survive the trip to an
 * outbound header. Two key failure modes, both silent without this guard:
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
export const assertValidToolContext = (
  // `unknown` values because a generation body reaches here untyped; the
  // value check below is what establishes them as strings.
  toolContext?: Record<string, unknown> | null
): void => {
  if (!toolContext) return;

  const keys = Object.keys(
    readStringBag({ field: 'tool_context', value: toolContext })
  );

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
 * Throws `INVALID_TOOL_CONTEXT_KEY` (400) when a tool's `context_keys`
 * allowlist contains something that could never be a `tool_context` key. An
 * entry names the same thing a key does — one outbound header — so it is held to
 * the same grammar. Validating here means a typo'd entry is a rejected write
 * rather than a key that silently never matches, which would present as the
 * tool mysteriously not receiving its credential at call time.
 */
export const assertValidToolContextAllowlist = (
  // `unknown` because both callers pass an untyped body or template property
  // and the check below is what establishes the type — a cast at the call site
  // would assert exactly what is not yet verified.
  contextKeys?: unknown
): void => {
  if (contextKeys === undefined || contextKeys === null) return;

  // The value arrives from an untyped request body, and a malformed allowlist
  // must never degrade to "no allowlist" — that would fail open, forwarding
  // every key to a tool whose author asked for the opposite.
  if (!Array.isArray(contextKeys)) {
    throw new DomainError(
      'INVALID_TOOL_CONTEXT_KEY',
      'context_keys must be an array of tool_context key names, or null to forward every key.'
    );
  }

  const invalid = contextKeys.filter((key) => {
    return typeof key !== 'string' || !HEADER_TOKEN_RE.test(key);
  });
  if (invalid.length === 0) return;

  throw new DomainError(
    'INVALID_TOOL_CONTEXT_KEY',
    `Invalid context_keys entry/entries ${invalid
      .map((key) => {
        return `'${String(key)}'`;
      })
      .join(
        ', '
      )} — an entry names a tool_context key, which becomes an HTTP header name, so it may only contain letters, digits and the characters !#$%&'*+-.^_\`|~.`,
    { keys: invalid }
  );
};

/**
 * The identity keys the server owns. They are derived from trusted state (the
 * session record and its actor) and stamped at the generation chokepoint
 * (`buildGenerationContext`), so a caller cannot address them from any
 * generation entry point — direct agent, conversation, session, trigger,
 * orchestration or nested `soat` tool call.
 */
export const RESERVED_TOOL_CONTEXT_KEYS = [
  'session_id',
  'actor_id',
  'actor_external_id',
  'calling_project_id',
] as const;

export type ServerToolContextIdentity = {
  sessionId?: string;
  actorId?: string;
  actorExternalId?: string;
};

// Header names are case-insensitive (RFC 9110 §5.1), so `Session_ID` lands on
// the same outbound header as `session_id` — the strip must match by lowercased
// key or a casing variant smuggles the forged header through.
const RESERVED_LOWER = new Set(
  RESERVED_TOOL_CONTEXT_KEYS.map((key) => {
    return key.toLowerCase();
  })
);

/**
 * Makes the reserved identity keys unaddressable by a caller: every reserved
 * key (in any casing) is dropped from the caller bag, then the server-derived
 * identity — when the generation runs for a session or a named actor — is
 * stamped on top. A generation with no end user carries no identity keys at
 * all, so a downstream tool can trust that a `<prefix>session_id` or
 * `<prefix>actor_id` context header is always server-derived.
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

  const identity: Record<string, string> = {};
  if (args.identity.sessionId) {
    identity.session_id = args.identity.sessionId;
  }
  if (args.identity.actorId) {
    identity.actor_id = args.identity.actorId;
  }
  if (args.identity.actorExternalId) {
    identity.actor_external_id = args.identity.actorExternalId;
  }

  return { ...stripped, ...identity };
};

/**
 * The bag a call forwards once its calling project is settled: any
 * `calling_project_id` already in it is dropped in every casing, and the
 * calling project is stamped when the call runs through a share, so the
 * owner's tool can tell grantees apart and no caller can claim to be one.
 */
export const pinCallingProject = (args: {
  toolContext?: Record<string, string>;
  callingProjectPublicId: string | null;
}): Record<string, string> | undefined => {
  if (!args.toolContext && !args.callingProjectPublicId) return undefined;
  const stripped = Object.fromEntries(
    Object.entries(args.toolContext ?? {}).filter(([key]) => {
      return key.toLowerCase() !== 'calling_project_id';
    })
  );
  if (args.callingProjectPublicId) {
    stripped.calling_project_id = args.callingProjectPublicId;
  }
  return stripped;
};

/**
 * A caller-supplied bag on an entry point that has **no session**, turned into
 * the bag to forward: keys validated against the header-name grammar, and the
 * reserved identity keys stripped in any casing.
 *
 * The strip is the whole point. Where a generation runs, `buildGenerationContext`
 * stamps the trusted identity over the caller's; where nothing does — a task row,
 * a direct `POST /tools/{id}/call` — there is nothing to overwrite a forged
 * `session_id` with, so it must be removed rather than trusted.
 * That is also why this cannot live inside `callTool`: a generation-driven call
 * arrives with identity already pinned, and stripping it there would delete the
 * server's own keys.
 *
 * Returns `undefined` when nothing survives, so "no context" has one
 * representation.
 */
export const sanitizeCallerToolContext = (
  toolContext?: Record<string, string> | null
): Record<string, string> | undefined => {
  if (!toolContext) return undefined;
  assertValidToolContext(toolContext);
  const stripped = pinServerIdentityToolContext({
    toolContext,
    identity: null,
  });
  if (!stripped || Object.keys(stripped).length === 0) return undefined;
  return stripped;
};

/**
 * Narrows an arbitrary `tool_context` value — a request body field or a
 * formation template property, neither typed by its source — to the shape
 * every carrier accepts: `null` clears the stored bag, `undefined` means "no
 * value given, leave it as is", and anything else must be a bag of string
 * values (`readStringBag`), refused with `400` otherwise.
 *
 * One implementation because a caller-supplied bag and a template-declared one
 * answer "what does null mean" and "what does a number value become"
 * independently otherwise, and a formation module that gets either question
 * wrong turns an explicit clear into a silent no-op.
 */
export const toStoredToolContext = (
  value: unknown
): Record<string, string> | null | undefined => {
  if (value === null || value === undefined) return value;
  return readStringBag({ field: 'tool_context', value });
};

/**
 * Narrows a `tool_context` bag to what one tool may receive.
 * `undefined`/`null` `contextKeys` forwards everything, so a tool that declares
 * no allowlist is unrestricted; an empty list forwards nothing but the identity
 * keys.
 *
 * Matching is case-insensitive because an entry names an outbound header (RFC
 * 9110 §5.1) — `assertValidToolContext` refuses two keys differing only in
 * case for the same reason — so a header cannot be allowed or denied depending
 * on how the entry was typed.
 *
 * The reserved identity keys survive any allowlist: they are derived from the
 * session, not supplied by the caller, and are how a downstream tool knows who
 * it acts for. The containment this provides is over *caller* data.
 */
export const filterToolContext = (args: {
  toolContext?: Record<string, string>;
  contextKeys?: string[] | null;
}): Record<string, string> | undefined => {
  if (!args.toolContext || !args.contextKeys) return args.toolContext;

  const allowed = new Set(
    args.contextKeys.map((key) => {
      return key.toLowerCase();
    })
  );

  return Object.fromEntries(
    Object.entries(args.toolContext).filter(([key]) => {
      const lower = key.toLowerCase();
      return allowed.has(lower) || RESERVED_LOWER.has(lower);
    })
  );
};

/**
 * The bag → headers step. Takes the tool's allowlist rather than a pre-filtered
 * bag so that the type system, not a convention, forces every forwarding site to
 * state which keys it may forward — a new egress path cannot be added without
 * answering the question.
 */
export const buildContextHeaders = (args: {
  toolContext?: Record<string, string>;
  contextKeys?: string[] | null;
}): Record<string, string> => {
  const toolContext = filterToolContext(args);
  if (!toolContext) return {};
  return Object.fromEntries(
    Object.entries(toolContext).map(([key, value]) => {
      return [buildContextHeaderName(key), value];
    })
  );
};
