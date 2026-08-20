/**
 * The pure rewrites behind `renameSoatTokens.ts`, kept separate so they can be
 * tested without a database and without running the migration's entry point.
 */

export type Json = unknown;

/** The guardrail catalog's top-level segments (`src/lib/guardrailDocument.ts`). */
const CATALOG_ROOTS = [
  'action',
  'tool',
  'agent',
  'project',
  'run',
  'activity',
  'usage',
];

const NAMESPACE_PATH = new RegExp(`^soat\\.(?:${CATALOG_ROOTS.join('|')})\\b`);

/**
 * Rewrite `soat.<catalog-root>…` var paths to `runtime.…`.
 *
 * Only string **values** are considered — object keys are never touched, so a
 * caller-authored `guardrail_context` key, an IAM SRN (`soat:…`, a colon not a
 * dot), or any other bag the platform does not own passes through untouched
 * (`.claude/rules/case-convention.md`). A `soat.`-prefixed path outside the
 * catalog is left alone too: it was already invalid before the rename, so
 * rewriting it would only change which error the author sees.
 */
export const renameNamespace = (value: Json): Json => {
  if (typeof value === 'string') {
    return NAMESPACE_PATH.test(value)
      ? `runtime.${value.slice('soat.'.length)}`
      : value;
  }
  if (Array.isArray(value)) return value.map(renameNamespace);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, Json>).map(([key, entry]) => {
        return [key, renameNamespace(entry)];
      })
    );
  }
  return value;
};

/**
 * Rewrite a `type: 'soat'` tool discriminator to `'builtin'`, at any depth —
 * inline pipeline step tools, ephemeral tools on an agent binding, and tool
 * resources inside a formation template all nest one.
 *
 * Matching on the discriminator alone is unambiguous: no other resource in this
 * schema uses `soat` as a `type` value. A `soat` value under any other key (the
 * usage/pricing vendor slug, a tool literally named `soat`) is left alone.
 */
export const renameToolType = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(renameToolType);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, Json>).map(([key, entry]) => {
        if (key === 'type' && entry === 'soat') return [key, 'builtin'];
        return [key, renameToolType(entry)];
      })
    );
  }
  return value;
};

/** Both rewrites, for columns that can hold either token. */
export const renameBoth = (value: Json): Json => {
  return renameToolType(renameNamespace(value));
};
