import createDebug from 'debug';

import { DomainError } from '../errors';
import { loadSecretValues } from './secrets';
import { TOOL_CONTEXT_KEY_CHARS } from './toolContext';

const log = createDebug('soat:toolTemplates');

/**
 * The `{{...}}` template grammar a tool definition may use, and its resolution
 * at the point of use.
 *
 * Two token kinds exist, and the difference between them is *when* the value is
 * known:
 *
 * | Token | Value comes from | Valid in |
 * |---|---|---|
 * | `{{secret:sec_...}}` | a project secret, decrypted server-side | anywhere in `execute` / `mcp` |
 * | `{{context:<key>}}` | the caller's `tool_context` for this call | `execute.headers` / `mcp.headers` only |
 *
 * `{{context:}}` exists because `tool_context` alone can only ever produce
 * `X-Soat-Context-*` headers — an invariant that must not be relaxed, since
 * caller context must never be able to overwrite a tool's configured credential
 * headers or the server-pinned identity headers (#843/#850/#851). The token
 * inverts the authority: the **tool** declares which header its credential goes
 * in (it is the party that knows the header shape), and the caller only supplies
 * the value.
 *
 * Headers-only is deliberate. A context value is caller-controlled data, so
 * letting it reach `execute.url` would let a caller steer the outbound request
 * to a host the tool's author never configured.
 */

// The inner alternation lets a `${...}` sub placeholder's own closing brace
// pass through without prematurely ending the `{{...}}` match — a plain
// `[^}]*` body would stop at the sub's inner `}` and leave a mangled,
// one-brace-short capture for `{{secret:${ApiSecret}}}`.
const DOUBLE_CURLY_RE = /\{\{((?:[^{}]|\$\{[^}]*\})*)\}\}/g;

// A resolved reference (`secret:sec_...`) or a formation `sub` placeholder
// still awaiting resolution (`secret:${LogicalIdOrParam}`) are both valid —
// a formation template is statically validated *before* `${...}` tokens
// resolve, so `{ "sub": "Bearer {{secret:${ApiSecret}}}" }` is legitimate
// template source, not an authoring mistake (see the "Composition" section
// of the expressions & templating reference doc).
const VALID_SECRET_TOKEN_RE = /^secret:(sec_[A-Za-z0-9]+|\$\{[^}]+\})$/;

// A context key reaches an outbound header name via `tool_context`, so the same
// key grammar applies here. `${...}` is accepted for the same formation reason
// as above.
const VALID_CONTEXT_TOKEN_RE = new RegExp(
  `^context:([${TOOL_CONTEXT_KEY_CHARS}]+|\\$\\{[^}]+\\})$`
);

/** The token shapes this module recognizes, for classifying a `{{...}}` match. */
type TokenKind = 'secret' | 'context' | 'invalid';

const classifyToken = (token: string): TokenKind => {
  const inner = token.slice(2, -2);
  if (VALID_SECRET_TOKEN_RE.test(inner)) return 'secret';
  if (VALID_CONTEXT_TOKEN_RE.test(inner)) return 'context';
  return 'invalid';
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * Every `{{...}}` token inside a value (deep-walks strings, arrays and objects),
 * paired with its kind. A shape check only — whether a referenced secret exists
 * is `assertSecretRefsExist`'s job and whether a context key is supplied is
 * decided at call time — so it needs no DB access and is safe to call from pure,
 * static validation (e.g. `validate-formation`).
 */
export const collectTemplateTokens = (
  value: unknown
): Array<{ token: string; kind: TokenKind }> => {
  if (typeof value === 'string') {
    return [...value.matchAll(DOUBLE_CURLY_RE)].map((match) => {
      return { token: match[0], kind: classifyToken(match[0]) };
    });
  }
  if (Array.isArray(value)) return value.flatMap(collectTemplateTokens);
  if (isPlainObject(value)) {
    return Object.values(value).flatMap(collectTemplateTokens);
  }
  return [];
};

/**
 * Collects every `{{...}}` token in a value that is not well-formed. `context:`
 * tokens count as well-formed here — position is checked separately by
 * {@link assertValidToolTemplateTokens}, since this function has no idea which
 * field it is looking at. Used by the formation validator, which reports per
 * field.
 */
export const findInvalidTemplateTokens = (value: unknown): string[] => {
  return collectTemplateTokens(value)
    .filter((entry) => {
      return entry.kind === 'invalid';
    })
    .map((entry) => {
      return entry.token;
    });
};

/**
 * Hints shared by every surface that reports a bad token, so the REST write path
 * and the formation validator cannot describe the same rule differently.
 */
export const MISPLACED_CONTEXT_HINT =
  'a {{context:<key>}} token may appear only in execute.headers or mcp.headers — a context value is caller-supplied, so it may not steer a URL or a request body';

export const INVALID_TOKEN_HINT =
  'double curly braces are reserved for {{secret:sec_...}} and {{context:<key>}} references; use single braces ({param}) for URL path parameters';

const quoteAll = (tokens: string[]): string => {
  return [...new Set(tokens)]
    .map((token) => {
      return `'${token}'`;
    })
    .join(', ');
};

/**
 * Splits one tool config field (`execute` or `mcp`) into its headers record and
 * everything else. `headers` is stripped only at the top level, so a nested
 * `auth.headers` stays in `elsewhere` — context tokens are rejected there, which
 * is the conservative direction.
 */
const splitHeaders = (
  value: unknown
): { headers: unknown; elsewhere: unknown } => {
  if (!isPlainObject(value)) return { headers: undefined, elsewhere: value };
  const { headers, ...elsewhere } = value;
  return { headers, elsewhere };
};

export type ToolTemplateTokenProblems = {
  /** Tokens that are not a well-formed reference of either kind. */
  invalid: string[];
  /** Well-formed `{{context:...}}` tokens sitting outside a headers record. */
  misplacedContext: string[];
};

/**
 * The token rules for one tool config field. Reported rather than thrown so the
 * formation validator can attribute each problem to the field that carries it;
 * {@link assertValidToolTemplateTokens} is the throwing wrapper the REST write
 * path uses.
 */
export const findToolTemplateTokenProblems = (
  value: unknown
): ToolTemplateTokenProblems => {
  const { headers, elsewhere } = splitHeaders(value);
  return {
    invalid: [
      ...findInvalidTemplateTokens(headers),
      ...findInvalidTemplateTokens(elsewhere),
    ],
    misplacedContext: collectTemplateTokens(elsewhere)
      .filter((entry) => {
        return entry.kind === 'context';
      })
      .map((entry) => {
        return entry.token;
      }),
  };
};

/** The message a caller sees for a set of problems, or null when there are none. */
export const describeToolTemplateTokenProblems = (
  problems: ToolTemplateTokenProblems
): string | null => {
  const parts: string[] = [];
  if (problems.misplacedContext.length > 0) {
    parts.push(
      `Invalid template token(s) ${quoteAll(
        problems.misplacedContext
      )} — ${MISPLACED_CONTEXT_HINT}.`
    );
  }
  if (problems.invalid.length > 0) {
    parts.push(
      `Invalid template token(s) ${quoteAll(
        problems.invalid
      )} — ${INVALID_TOKEN_HINT}.`
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
};

/**
 * The headers-only rule for `{{context:...}}`, and the shape rule for every
 * `{{...}}` token, over a tool's `execute` and `mcp` config. Throws
 * `INVALID_TEMPLATE_TOKEN` (400).
 *
 * Both rules live behind one call on purpose: "which token kinds are legal
 * where" is a single fact about the tool contract, and splitting it across the
 * write path and the formation validator is how the two would drift.
 */
export const assertValidToolTemplateTokens = (args: {
  execute?: unknown;
  mcp?: unknown;
}): void => {
  const problems = [args.execute, args.mcp].reduce<ToolTemplateTokenProblems>(
    (acc, value) => {
      const found = findToolTemplateTokenProblems(value);
      return {
        invalid: [...acc.invalid, ...found.invalid],
        misplacedContext: [...acc.misplacedContext, ...found.misplacedContext],
      };
    },
    { invalid: [], misplacedContext: [] }
  );

  const message = describeToolTemplateTokenProblems(problems);
  if (!message) return;

  throw new DomainError('INVALID_TEMPLATE_TOKEN', message, {
    tokens: [...new Set([...problems.misplacedContext, ...problems.invalid])],
  });
};

/**
 * The token shapes that can still be resolved at call time. A `${...}` sub
 * placeholder cannot appear here — a formation resolves those before the tool
 * row is written — so this grammar is the strict one.
 */
const RESOLVABLE_TOKEN_RE = new RegExp(
  `\\{\\{(secret:sec_[A-Za-z0-9]+|context:[${TOOL_CONTEXT_KEY_CHARS}]+)\\}\\}`,
  'g'
);

const CONTEXT_PREFIX = 'context:';
const SECRET_PREFIX = 'secret:';

/**
 * Substitutes both token kinds in **one** pass, so a substituted value is never
 * re-examined as template source.
 *
 * That is a security property, not a micro-optimization. Resolving secrets and
 * then context would make a secret whose plaintext contains `{{context:x}}`
 * interpolate caller data; resolving context and then secrets would let a caller
 * put `{{secret:sec_...}}` in a `tool_context` value and read a project secret
 * back out of the outbound header. `String#replace` never rescans replacement
 * text, so a single pass makes both unrepresentable.
 */
const substituteTokens = (args: {
  value: string;
  secretValues: Map<string, string>;
  toolContext?: Record<string, string>;
  headerName: string;
}): string => {
  return args.value.replace(RESOLVABLE_TOKEN_RE, (original, inner: string) => {
    if (inner.startsWith(SECRET_PREFIX)) {
      // A referenced-but-valueless secret leaves the token in place, matching
      // `resolveSecretRefsInString`.
      return (
        args.secretValues.get(inner.slice(SECRET_PREFIX.length)) ?? original
      );
    }

    const key = inner.slice(CONTEXT_PREFIX.length);
    // `Object.hasOwn`, not a truthiness check: an empty-string context value is
    // a value the caller chose, while an inherited `Object.prototype` member is
    // not a key at all.
    const resolved =
      args.toolContext && Object.hasOwn(args.toolContext, key)
        ? args.toolContext[key]
        : undefined;
    if (resolved === undefined) {
      // The two messages are worth distinguishing: "no tool_context at all"
      // usually means the tool was reached through a path that carries none
      // (`/tools/{id}/call`, an orchestration `tool` node), which is a different
      // fix from adding one key.
      throw new DomainError(
        'MISSING_TOOL_CONTEXT_KEY',
        args.toolContext
          ? `Tool header '${args.headerName}' references '${original}', but the key '${key}' is not present in the tool_context for this call.`
          : `Tool header '${args.headerName}' references '${original}', but this call carries no tool_context. Supply one, or call the tool through an entry point that forwards it.`,
        { key, header: args.headerName }
      );
    }
    return resolved;
  });
};

/**
 * Resolves `{{secret:...}}` and `{{context:...}}` tokens in every value of a
 * tool's headers record, at the point of use — the stored config (and anything
 * echoed back by GET/LIST) keeps the tokens.
 *
 * Throws `MISSING_TOOL_CONTEXT_KEY` (400) when a `{{context:...}}` key is not
 * supplied. Failing the call is deliberate: an `Authorization: Bearer ` with an
 * empty value would reach the tool's endpoint and come back as an opaque
 * upstream 401, several steps away from the actual mistake.
 */
export const resolveToolHeaderTemplates = async (args: {
  record: Record<string, string> | undefined;
  projectId: number;
  toolContext?: Record<string, string>;
}): Promise<Record<string, string> | undefined> => {
  if (!args.record) return args.record;

  const secretValues = await loadSecretValues({
    value: args.record,
    projectId: args.projectId,
  });
  log(
    'resolveToolHeaderTemplates: projectId=%d headers=%d secrets=%d contextKeys=%d',
    args.projectId,
    Object.keys(args.record).length,
    secretValues.size,
    Object.keys(args.toolContext ?? {}).length
  );

  return Object.fromEntries(
    Object.entries(args.record).map(([headerName, value]) => {
      if (typeof value !== 'string') return [headerName, value];
      return [
        headerName,
        substituteTokens({
          value,
          secretValues,
          toolContext: args.toolContext,
          headerName,
        }),
      ];
    })
  );
};
