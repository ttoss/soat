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
 * The key → header-name rule: uppercase the first character and append the rest
 * of the key **verbatim**. This is deliberately not title-casing —
 * `actor_external_id` becomes `X-Soat-Context-Actor_external_id`, not
 * `X-Soat-Context-ActorExternalId`. Normalizing separators would silently
 * change which header an existing caller's key lands on, and caller-supplied
 * keys take precedence over the session's auto-populated ones, so it could
 * rewrite the identity an `http` tool authorizes against.
 */
export const buildContextHeaderName = (key: string): string => {
  return `X-Soat-Context-${key.charAt(0).toUpperCase()}${key.slice(1)}`;
};

/**
 * RFC 7230 `token` characters — the grammar for a valid HTTP header name. A key
 * outside this set produces a header name that `fetch` rejects with a
 * `TypeError` at tool-call time, mid-generation.
 */
const HEADER_TOKEN_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

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
