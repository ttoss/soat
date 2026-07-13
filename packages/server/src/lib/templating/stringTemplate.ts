/**
 * The single string-interpolation engine for the server.
 *
 * One delimiter — `${<namespace>[.<path>]}` — replaces every hand-rolled
 * substitution mechanism that used to live in `agentToolResolver` (tool URL
 * `{param}` / `${body.x}`), `secrets` (`{{secret:...}}`), `formationsHelpers`
 * (`sub`'s `${Name}`), and `discussionEngine` (`{topic}` / `{steps.x}`).
 *
 * A token's first segment is its **namespace**; the remainder is a dotted
 * **path** handed to that namespace's resolver. Which namespaces a caller
 * supplies resolvers for is what scopes resolution to a stage: a token whose
 * namespace has **no resolver** is *deferred* (left verbatim, reported in
 * `deferred`) so a later stage can resolve it — this is how formation deploy
 * leaves `${arg.*}` / `${secret.*}` intact for tool-call time. A token whose
 * namespace **has** a resolver that returns `undefined` is *missing* and is
 * also left verbatim, but reported only in `referenced` (not `deferred`), so a
 * caller can tell "unresolved here on purpose" from "resolver had no value".
 *
 * `$${...}` is an escaped literal — it renders `${...}` and is never treated as
 * a token, for the rare target string that genuinely wants `${` in its output.
 */

// The namespace must start with a letter/underscore; each subsequent dotted
// segment allows word chars and hyphens (secret ids, logical ids). The leading
// optional `$` capture distinguishes an escaped `$${...}` from a real `${...}`.
const TOKEN_RE = /\$(\$)?\{([a-zA-Z_]\w*(?:\.[\w-]+)*)\}/g;

export type Resolver = (path: string) => string | undefined;

export type TokenRef = { namespace: string; path: string; raw: string };

export type RenderOptions = {
  /** Substitution resolvers keyed by token namespace. */
  resolvers: Record<string, Resolver>;
  /** URL-encode substituted values (on for tool URLs, off for headers/prompts). */
  encode?: boolean;
};

export type RenderResult = {
  output: string;
  /** Token contents (`namespace.path`) that a resolver substituted. */
  consumed: string[];
  /** Every token parsed, for validation / dependency collection. */
  referenced: TokenRef[];
  /** Token contents whose namespace had no resolver at this stage. */
  deferred: string[];
};

type Segment =
  | { kind: 'literal'; text: string }
  | { kind: 'escaped'; content: string }
  | { kind: 'token'; namespace: string; path: string; raw: string };

const tokenize = (template: string): Segment[] => {
  const segments: Segment[] = [];
  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null = TOKEN_RE.exec(template);
  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push({
        kind: 'literal',
        text: template.slice(lastIndex, match.index),
      });
    }
    const content = match[2] as string;
    if (match[1] === '$') {
      segments.push({ kind: 'escaped', content });
    } else {
      const dot = content.indexOf('.');
      segments.push({
        kind: 'token',
        namespace: dot === -1 ? content : content.slice(0, dot),
        path: dot === -1 ? '' : content.slice(dot + 1),
        raw: content,
      });
    }
    lastIndex = match.index + match[0].length;
    match = TOKEN_RE.exec(template);
  }
  if (lastIndex < template.length) {
    segments.push({ kind: 'literal', text: template.slice(lastIndex) });
  }
  return segments;
};

/**
 * Renders one template string. Unresolved tokens (deferred or missing) are left
 * verbatim; see the module header for the deferred-vs-missing distinction.
 */
export const renderTemplate = (
  template: string,
  opts: RenderOptions
): RenderResult => {
  const { resolvers, encode = false } = opts;
  const consumed: string[] = [];
  const referenced: TokenRef[] = [];
  const deferred: string[] = [];
  let output = '';

  for (const segment of tokenize(template)) {
    if (segment.kind === 'literal') {
      output += segment.text;
      continue;
    }
    if (segment.kind === 'escaped') {
      output += `\${${segment.content}}`;
      continue;
    }
    referenced.push({
      namespace: segment.namespace,
      path: segment.path,
      raw: segment.raw,
    });
    const resolver = resolvers[segment.namespace];
    if (!resolver) {
      deferred.push(segment.raw);
      output += `\${${segment.raw}}`;
      continue;
    }
    const value = resolver(segment.path);
    if (value === undefined) {
      output += `\${${segment.raw}}`; // missing → keep verbatim
      continue;
    }
    consumed.push(segment.raw);
    output += encode ? encodeURIComponent(value) : value;
  }

  return { output, consumed, referenced, deferred };
};

/**
 * Renders every string value of a record (e.g. HTTP headers), aggregating the
 * accounting arrays across values.
 */
export const renderRecord = (
  record: Record<string, string>,
  opts: RenderOptions
): { output: Record<string, string> } & Omit<RenderResult, 'output'> => {
  const output: Record<string, string> = {};
  const consumed: string[] = [];
  const referenced: TokenRef[] = [];
  const deferred: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const result = renderTemplate(value, opts);
    output[key] = result.output;
    consumed.push(...result.consumed);
    referenced.push(...result.referenced);
    deferred.push(...result.deferred);
  }
  return { output, consumed, referenced, deferred };
};

/**
 * Deep-walks any value (string / array / object) and returns every token it
 * references — the replacement for the old per-mechanism collectors
 * (`collectSecretRefs`, `collectSubTokens`, `collectParamRefs`). Escaped
 * literals are ignored.
 */
export const collectTokens = (value: unknown): TokenRef[] => {
  const refs: TokenRef[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const segment of tokenize(node)) {
        if (segment.kind === 'token') {
          refs.push({
            namespace: segment.namespace,
            path: segment.path,
            raw: segment.raw,
          });
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const item of Object.values(node)) walk(item);
    }
  };
  walk(value);
  return refs;
};
