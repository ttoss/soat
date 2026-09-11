import { Op } from '@ttoss/postgresdb';

import { DomainError } from '../errors';

/**
 * Resolves the new tag bag for a tag write: a shallow merge over the current
 * tags when `merge` is set, a full replacement otherwise.
 *
 * Five modules (actors, conversations, documents, files, sessions) wrote this
 * expression out by hand, four of them byte-identically.
 *
 * Both bags are treated as **opaque values** — the helper spreads them without
 * reading a single key, which is what `.claude/rules/case-convention.md`
 * prescribes for `tags` and why the `cost_center`/`costCenter` collapse of
 * #729 cannot recur here.
 */
export const mergeTags = (args: {
  current: Record<string, string> | null | undefined;
  incoming: Record<string, string>;
  merge?: boolean;
}): Record<string, string> => {
  return args.merge
    ? { ...(args.current ?? {}), ...args.incoming }
    : args.incoming;
};

/**
 * Whether a tag bag is actually a filter. An empty object narrows nothing —
 * JSONB containment against `{}` matches every row — so it must never reach a
 * query as though it did.
 */
export const hasTagFilter = (
  tags: Record<string, string> | undefined
): tags is Record<string, string> => {
  return tags !== undefined && Object.keys(tags).length > 0;
};

/**
 * Whether a value is a flat bag of string values — the shape every tagged
 * resource stores. Rejects arrays so a legacy `["a","b"]` body fails loudly
 * rather than being read as an object with numeric keys.
 */
export const isStringRecord = (
  value: unknown
): value is Record<string, string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((item) => {
    return typeof item === 'string';
  });
};

/**
 * Parses `key:value` query-string pairs into a tag bag, the query-string
 * spelling of the same object a JSON body carries. Splits on the FIRST colon
 * only, so a value may itself contain colons. Returns null for a malformed
 * pair, which the caller reports as a client error rather than silently
 * dropping a filter the caller believed narrowed the result.
 */
export const parseTagPairs = (
  raw: string | string[] | undefined
): Record<string, string> | null | undefined => {
  if (raw === undefined) return undefined;
  const values = Array.isArray(raw) ? raw : [raw];
  const tags: Record<string, string> = {};
  for (const pair of values) {
    const separator = pair.indexOf(':');
    if (separator <= 0) return null;
    tags[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return tags;
};

/**
 * IAM evaluation context for a tagged resource: `soat:ResourceType` plus one
 * `soat:ResourceTag/<key>` entry per tag, keys and values verbatim. Every
 * `isAllowed` call on a tagged resource passes this, so a policy condition
 * reads exactly the pairs `?tags=` and knowledge search filter on.
 */
export const buildResourceTagContext = (args: {
  resourceType: string;
  tags: Record<string, string> | null | undefined;
}): Record<string, string> => {
  const context: Record<string, string> = {
    'soat:ResourceType': args.resourceType,
  };
  for (const [key, value] of Object.entries(args.tags ?? {})) {
    context[`soat:ResourceTag/${key}`] = value;
  }
  return context;
};

/**
 * Reads a `tags` value from a request body. Anything that is not a flat bag
 * of string values — an array, a nested object, a number — is a client error,
 * never something to coerce: `String(["a","b"])` is `"a,b"`, and a policy
 * condition would then match a tag nobody wrote.
 */
export const readTagBag = (
  value: unknown
): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!isStringRecord(value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'tags must be an object of string values'
    );
  }
  return value;
};

/** `readTagBag` for update bodies where `null` means "clear the bag". */
export const readNullableTagBag = (
  value: unknown
): Record<string, string> | null | undefined => {
  if (value === null) return null;
  return readTagBag(value);
};

/**
 * Reads the `?tags=key:value` list filter from a query string: the same bag a
 * JSON body carries, spelled as repeatable `key:value` pairs. A pair without a
 * colon is rejected rather than dropped, which would widen the result set the
 * caller believed it had narrowed.
 */
export const readTagQuery = (
  raw: unknown
): Record<string, string> | undefined => {
  if (raw === undefined) return undefined;
  const values = Array.isArray(raw) ? raw : [raw];
  const pairs = values.filter((value): value is string => {
    return typeof value === 'string';
  });
  const tags = pairs.length === values.length ? parseTagPairs(pairs) : null;
  if (tags === null) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'tags must be `key:value` pairs, e.g. tags=team:finance'
    );
  }
  return tags;
};

/**
 * JSONB containment: every requested pair present with exactly that value.
 * The one matching rule shared by `?tags=`, knowledge search and the
 * `soat:ResourceTag/<key>` fragments `policyCompiler` emits.
 */
export const tagContainment = (
  tags: Record<string, string>
): Record<symbol, Record<string, string>> => {
  return { [Op.contains]: tags };
};

/**
 * Narrows a list query by tags. A missing or empty bag leaves `where` alone:
 * containment against `{}` matches every row, so it must never reach a query
 * as though it were a filter.
 */
export const applyTagFilter = (args: {
  where: Record<string, unknown>;
  tags: Record<string, string> | undefined;
}): void => {
  if (!hasTagFilter(args.tags)) return;
  args.where.tags = tagContainment(args.tags);
};
