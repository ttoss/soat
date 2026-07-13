/**
 * Pure old→new syntax transforms for the string-template unification migration.
 *
 * These rewrite the four legacy delimiters into the single `${namespace.path}`
 * grammar (see `src/lib/templating/stringTemplate.ts`):
 *
 *   {{secret:X}}   → ${secret.X}
 *   ${body.field}  → ${arg.field}
 *   {param}        → ${arg.param}     (URL path params; URL fields only)
 *   ${Name} in sub → ${ref.Name} | ${param.Name} | ${arg.field}   (formation)
 *   {topic} etc.   → ${topic} etc.    (discussion prompts)
 *
 * Every transform is idempotent: the new-syntax output never re-matches the
 * old-syntax patterns (a dot or the `${`/`}}` shape breaks each old regex), so
 * running the migration twice is a no-op on already-migrated data.
 */

const SECRET_RE = /\{\{secret:(.+?)\}\}/g;
const BODY_RE = /\$\{body\.(\w+)\}/g;
const PATH_PARAM_RE = /\{(\w+)\}/g;
const DISCUSSION_RE = /\{(topic|transcript|steps\.[\w.]+)\}/g;
// A bare `${Name}` token inside a formation `sub` string. `[^${}]` excludes `$`
// so a nested `${ref.X}` produced mid-rewrite is not re-matched, and excludes
// braces so it never spans a `}`.
const SUB_TOKEN_RE = /\$\{([^${}]+)\}/g;

/** `{{secret:X}}` → `${secret.X}` (X is a literal id or a nested `${ref.X}`). */
export const migrateSecretRefs = (value: string): string => {
  return value.replace(SECRET_RE, '${secret.$1}');
};

/** `${body.field}` → `${arg.field}`. */
export const migrateBodyRefs = (value: string): string => {
  return value.replace(BODY_RE, '${arg.$1}');
};

/** `{param}` → `${arg.param}`. URL fields only — never apply to free text. */
export const migratePathParams = (value: string): string => {
  return value.replace(PATH_PARAM_RE, '${arg.$1}');
};

/**
 * A tool `execute.url`: body refs, then secret refs, then path params. Order
 * matters — body/secret produce dotted `${…}` tokens that the bare-brace path
 * rule can no longer match, so path params only ever hit genuine `{word}`.
 */
export const migrateToolUrl = (value: string): string => {
  return migratePathParams(migrateSecretRefs(migrateBodyRefs(value)));
};

/**
 * A tool/mcp header value or `mcp.url` — only ever carried `{{secret:…}}`
 * (never arg/path interpolation), so only secret refs are rewritten.
 */
export const migrateSecretsOnly = (value: string): string => {
  return migrateSecretRefs(value);
};

/** A discussion prompt: `{topic}` / `{transcript}` / `{steps.X}` → `${…}`. */
export const migrateDiscussionString = (value: string): string => {
  return value.replace(DISCUSSION_RE, '${$1}');
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * Rewrites the `${Name}` tokens inside one formation `sub` string, then the
 * `{{secret:…}}` wrappers. Each bare token is classified by the template's own
 * resource and parameter key sets:
 *   - `body.x`         → `${arg.x}`     (runtime tool-call token)
 *   - a resource id    → `${ref.Name}`  (resolved to a physical id at apply)
 *   - a parameter      → `${param.Name}`
 *   - anything else    → `${param.Name}` (the pre-migration default for a
 *                        non-resource sub token)
 * Already-namespaced tokens are left untouched so the pass is idempotent.
 */
export const migrateSubString = (args: {
  sub: string;
  resourceKeys: Set<string>;
  paramKeys: Set<string>;
}): string => {
  const rewritten = args.sub.replace(SUB_TOKEN_RE, (original, name: string) => {
    if (/^(arg|secret|ref|param|topic|transcript|steps)\b/.test(name)) {
      return original; // already namespaced (or a discussion token)
    }
    if (name.startsWith('body.')) {
      return `\${arg.${name.slice('body.'.length)}}`;
    }
    if (args.resourceKeys.has(name)) return `\${ref.${name}}`;
    return `\${param.${name}}`;
  });
  return migrateSecretRefs(rewritten);
};

/**
 * Deep-migrates a formation template. `{ sub: … }` strings are rewritten with
 * {@link migrateSubString} using the template's resource/param keys; every
 * other string leaf gets the safe, delimiter-specific secret + body rewrites
 * (path-param rewriting is intentionally not applied to free-form formation
 * strings — express those via `sub`).
 */
export const migrateFormationTemplate = (template: unknown): unknown => {
  if (!isRecord(template)) return template;
  const resourceKeys = new Set(
    isRecord(template.resources) ? Object.keys(template.resources) : []
  );
  const paramKeys = new Set(
    isRecord(template.parameters) ? Object.keys(template.parameters) : []
  );

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return migrateSecretRefs(migrateBodyRefs(node));
    }
    if (Array.isArray(node)) return node.map(walk);
    if (isRecord(node)) {
      const keys = Object.keys(node);
      if (
        keys.length === 1 &&
        keys[0] === 'sub' &&
        typeof node.sub === 'string'
      ) {
        return {
          sub: migrateSubString({ sub: node.sub, resourceKeys, paramKeys }),
        };
      }
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        result[key] = walk(child);
      }
      return result;
    }
    return node;
  };

  return walk(template);
};

const migrateRecordValues = (
  record: Record<string, unknown>
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = typeof value === 'string' ? migrateSecretsOnly(value) : value;
  }
  return result;
};

/**
 * Migrates a tool's `execute` JSON (an http tool's `url` + `headers`). The
 * `url` gets the full URL rewrite; header values only ever held secret refs.
 */
export const migrateToolExecute = (execute: unknown): unknown => {
  if (!isRecord(execute)) return execute;
  const result: Record<string, unknown> = { ...execute };
  if (typeof result.url === 'string') {
    result.url = migrateToolUrl(result.url);
  }
  if (isRecord(result.headers)) {
    result.headers = migrateRecordValues(result.headers);
  }
  return result;
};

/** Migrates a tool's `mcp` JSON (`url` + `headers`) — secret refs only. */
export const migrateToolMcp = (mcp: unknown): unknown => {
  if (!isRecord(mcp)) return mcp;
  const result: Record<string, unknown> = { ...mcp };
  if (typeof result.url === 'string') {
    result.url = migrateSecretsOnly(result.url);
  }
  if (isRecord(result.headers)) {
    result.headers = migrateRecordValues(result.headers);
  }
  return result;
};
