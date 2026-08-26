import createDebug from 'debug';

import { DomainError } from '../errors';
import { loadSecretValues } from './secrets';
import { TOOL_CONTEXT_KEY_CHARS } from './toolContext';
import { coercePresetParametersToSchema } from './toolPresetParameters';

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
 * | `{{context:<key>}}` | the caller's `tool_context` for this call | `execute.headers`, `mcp.headers`, `preset_parameters` |
 *
 * `{{context:}}` exists because `tool_context` alone can only ever produce
 * headers under the deployment's context prefix (`X-Soat-Context-` by default,
 * see `buildContextHeaderName`) — an invariant that must not be relaxed, since
 * caller context must never be able to overwrite a tool's configured credential
 * headers or the server-pinned identity headers (#843/#850/#851). The token
 * inverts the authority: the **tool** declares which header its credential goes
 * in (it is the party that knows the header shape), and the caller only supplies
 * the value.
 *
 * The two places it is allowed are the two the tool's author controls the shape
 * of. A header is one the tool declares; a preset parameter is a value the tool
 * pins **over** whatever the model supplies (#345), which is what lets a
 * per-run boundary — the one account this run may act on — be expressed at all.
 * `execute.url` stays off-limits: a context value is caller-controlled data, and
 * letting it reach the URL would let a caller steer the outbound request to a
 * host the tool's author never configured.
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
  'a {{context:<key>}} token may appear only in execute.headers, mcp.headers or preset_parameters — a context value is caller-supplied, so it may not steer a URL or a request body';

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
  presetParameters?: unknown;
}): void => {
  const problems = [args.execute, args.mcp].reduce<ToolTemplateTokenProblems>(
    (acc, value) => {
      const found = findToolTemplateTokenProblems(value);
      return {
        invalid: [...acc.invalid, ...found.invalid],
        misplacedContext: [...acc.misplacedContext, ...found.misplacedContext],
      };
    },
    {
      // A preset is a context *sink*, so only the shape rule applies to it —
      // there is no "misplaced" here. Checking it at write time is what keeps a
      // typo'd `{{ocaAdAccountId}}` from reaching the target as the literal
      // parameter value, which comes back as an opaque `not found`.
      invalid: findInvalidTemplateTokens(args.presetParameters),
      misplacedContext: [],
    }
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
  /**
   * What the value is, for the error a missing key produces — `Tool header
   * 'Authorization'`, `Preset parameter 'adAccountId' on tool 'oca'`. Passed in
   * rather than derived here so one substitution routine serves every field
   * that may carry a token, and each names itself the way its author would.
   */
  location: { description: string; meta: Record<string, unknown> };
}): { value: string; resolvedContext: boolean } => {
  let resolvedContext = false;
  const value = args.value.replace(
    RESOLVABLE_TOKEN_RE,
    (original, inner: string) => {
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
            ? `${args.location.description} references '${original}', but the key '${key}' is not present in the tool_context for this call.`
            : `${args.location.description} references '${original}', but this call carries no tool_context. Supply one, or call the tool through an entry point that forwards it.`,
          { key, ...args.location.meta }
        );
      }
      resolvedContext = true;
      return resolved;
    }
  );
  return { value, resolvedContext };
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
          location: {
            description: `Tool header '${headerName}'`,
            meta: { header: headerName },
          },
        }).value,
      ];
    })
  );
};

/**
 * A tool's `preset_parameters` with every `{{context:<key>}}` token resolved
 * from this call's `tool_context` (#345), plus the top-level keys that carried
 * at least one — the input {@link coercePresetParametersToSchema} needs to know
 * which values came from a caller-supplied string rather than from the
 * operator's own literal.
 */
export type ResolvedPresetParameters = {
  values: Record<string, unknown> | null;
  contextResolvedKeys: string[];
};

/**
 * Resolves `{{context:<key>}}` inside `preset_parameters`, deep-walking strings,
 * arrays and objects, at the point of use — the stored config keeps the tokens.
 *
 * This is what makes a pin express a **per-run** boundary. A pin already wins
 * over whatever the model supplies for the same key (see
 * {@link mergePresetParameters}), so it is the one place a value can be put
 * genuinely out of the model's hands; without token resolution that value had to
 * be fixed when the tool was created, which forced one tool per tenant for the
 * exact scope — an ad account, a workspace — that the run already knows.
 *
 * Two rules are inherited from headers rather than re-decided here:
 *
 * - **A missing key fails the call** with `MISSING_TOOL_CONTEXT_KEY`, never a
 *   literal `{{context:...}}` on the wire. The literal reaches the target as a
 *   resource id and comes back as an opaque `Not found`, several steps from the
 *   mistake.
 * - **`context_keys` does not gate it.** That allowlist governs which keys are
 *   *forwarded* as `X-Soat-Context-*` headers to a tool that never asked for
 *   them; a token is the tool naming the key it consumes, which is the opposite
 *   direction. `resolveToolHeaderTemplates` already works this way and
 *   `agentToolResolver.test.ts` pins it.
 *
 * `{{secret:...}}` is deliberately **not** resolved here: a preset value travels
 * into the tool's request body, into guardrail evaluation input and into the
 * activity record, so putting secret plaintext there is a decision of its own
 * rather than a side effect of this one. The token stays literal, exactly as it
 * does today. Passing an empty secret map (rather than skipping secrets) keeps
 * the single-pass guarantee `substituteTokens` documents: a substituted context
 * value is never rescanned, so a caller cannot read a project secret back out by
 * putting a secret token in `tool_context`.
 */
export const resolvePresetParameterTemplates = (args: {
  presetParameters?: object | null;
  toolContext?: Record<string, string>;
  toolName: string;
}): ResolvedPresetParameters => {
  if (!args.presetParameters || !isPlainObject(args.presetParameters)) {
    return { values: null, contextResolvedKeys: [] };
  }

  const noSecrets = new Map<string, string>();
  const contextResolvedKeys: string[] = [];

  const walk = (value: unknown, parameter: string): unknown => {
    if (typeof value === 'string') {
      const substituted = substituteTokens({
        value,
        secretValues: noSecrets,
        toolContext: args.toolContext,
        location: {
          description: `Preset parameter '${parameter}' on tool '${args.toolName}'`,
          meta: { parameter, tool: args.toolName },
        },
      });
      if (
        substituted.resolvedContext &&
        !contextResolvedKeys.includes(parameter)
      ) {
        contextResolvedKeys.push(parameter);
      }
      return substituted.value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => {
        return walk(entry, parameter);
      });
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
          return [key, walk(entry, parameter)];
        })
      );
    }
    return value;
  };

  const values = Object.fromEntries(
    Object.entries(args.presetParameters).map(([parameter, value]) => {
      return [parameter, walk(value, parameter)];
    })
  );

  return { values, contextResolvedKeys };
};

/**
 * The one call every dispatch site makes: `preset_parameters` with its context
 * tokens resolved and the resolved values retyped to what `schema` declares.
 * Throws `MISSING_TOOL_CONTEXT_KEY` (400) when a token names a key this call
 * does not carry.
 *
 * `schema` is the parameter schema of whatever is about to be called — the
 * tool's own `parameters` for `http`/`client`/`pipeline`, the listed tool's
 * `inputSchema` for `mcp`, the action's for `builtin`. Omitting it resolves
 * tokens without retyping, which is the right answer when no schema is known.
 */
export const resolvePresetParametersForCall = (args: {
  presetParameters?: object | null;
  toolContext?: Record<string, string>;
  toolName: string;
  schema?: unknown;
}): Record<string, unknown> | null => {
  const resolved = resolvePresetParameterTemplates({
    presetParameters: args.presetParameters,
    toolContext: args.toolContext,
    toolName: args.toolName,
  });
  return coercePresetParametersToSchema({
    presetParameters: resolved.values,
    contextResolvedKeys: resolved.contextResolvedKeys,
    schema: args.schema,
  });
};

/**
 * {@link resolvePresetParametersForCall} for the **guardrail gate only**, where a
 * missing key falls back to the unresolved presets instead of throwing.
 *
 * The gate classifies a call that has not been dispatched yet, and the dispatch
 * site resolves the same presets a moment later — so a missing key still fails
 * the call there, with the same error, before any request goes out. Throwing
 * here as well would move that failure from the tool call to *tool resolution*,
 * taking down the whole generation (every other tool included) over one tool's
 * missing key. What matters at the gate is that a guardrail reading the pinned
 * value sees the run's real value whenever there is one, rather than the literal
 * `{{context:...}}` text.
 */
export const resolvePresetParametersForGate = (args: {
  presetParameters?: Record<string, unknown> | null;
  toolContext?: Record<string, string>;
  toolName: string;
  schema?: unknown;
}): Record<string, unknown> | null => {
  try {
    return resolvePresetParametersForCall(args);
  } catch (error) {
    if (
      error instanceof DomainError &&
      error.code === 'MISSING_TOOL_CONTEXT_KEY'
    ) {
      return args.presetParameters ?? null;
    }
    throw error;
  }
};
