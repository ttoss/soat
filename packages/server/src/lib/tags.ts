import { DomainError } from '../errors';
import { applyFilterWhere, containment } from './structuredFilter';

/**
 * The attribute every tagged model spells its bag as, so one containment
 * fragment serves a listing, a joined chunk scan and a memory selection alike.
 */
const TAGS_ATTRIBUTE = 'tags';

/**
 * The runtime's half of every tag bag.
 *
 * A `system.*` pair says which conversation, actor, agent and role a row came
 * from. It is what a knowledge search filters an actor's turns by and what an
 * IAM `soat:ResourceTag/system.actor` condition fences them with, so a caller
 * who could write one could make their own rows answer to another actor's
 * filter. Callers therefore read these keys and never write them.
 *
 * A dot rather than a colon: `parseTagPairs` splits a `?tags=` pair on the
 * first colon, so `system:actor:actor_1` would parse as the key `system`.
 */
export const SYSTEM_TAG_PREFIX = 'system.';

export const isSystemTagKey = (key: string): boolean => {
  return key.startsWith(SYSTEM_TAG_PREFIX);
};

/**
 * What a tag bag may hold.
 *
 * Every pair reaches the IAM evaluation context of every `isAllowed` call on
 * the resource, and every `soat:ResourceTag/<key>` condition compiled into a
 * listing, so the bag is a cost on the request path rather than a column that
 * merely grows. Bounding it where it is written is what keeps that cost
 * knowable; bounding it on a read would be too late for the write that already
 * landed.
 *
 * The counts are the caller's. A `system.*` key is written by the platform and
 * refused on a caller write, so a caller cannot shed one — counting them would
 * let a conversation's provenance decide whether a caller may still label
 * their own row.
 */
export const TAG_BAG_LIMITS = {
  keys: 50,
  keyLength: 128,
  valueLength: 256,
} as const;

const refuseTagLimit = (args: { message: string; limit: number }): never => {
  throw new DomainError('VALIDATION_FAILED', args.message, {
    limit: args.limit,
  });
};

/**
 * Holds a bag to {@link TAG_BAG_LIMITS}, returning it unchanged. Both the bag a
 * caller sends and the bag a merge produces go through here, because a bounded
 * incoming bag merged onto a full one is still an unbounded stored bag.
 */
export const assertTagBagLimits = <
  T extends Record<string, string> | null | undefined,
>(
  tags: T
): T => {
  const callerKeys = Object.keys(tags ?? {}).filter((key) => {
    return !isSystemTagKey(key);
  });

  if (callerKeys.length > TAG_BAG_LIMITS.keys) {
    refuseTagLimit({
      message: `a tag bag holds at most ${TAG_BAG_LIMITS.keys} keys; this one has ${callerKeys.length}`,
      limit: TAG_BAG_LIMITS.keys,
    });
  }

  for (const key of callerKeys) {
    if (key.length > TAG_BAG_LIMITS.keyLength) {
      refuseTagLimit({
        message: `a tag key is at most ${TAG_BAG_LIMITS.keyLength} characters: '${key.slice(0, 32)}…' is ${key.length}`,
        limit: TAG_BAG_LIMITS.keyLength,
      });
    }
    const value = tags?.[key] ?? '';
    if (value.length > TAG_BAG_LIMITS.valueLength) {
      refuseTagLimit({
        message: `a tag value is at most ${TAG_BAG_LIMITS.valueLength} characters: '${key}' holds ${value.length}`,
        limit: TAG_BAG_LIMITS.valueLength,
      });
    }
  }

  return tags;
};

/**
 * Resolves the new tag bag for a tag write: a shallow merge over the current
 * tags when `merge` is set, a full replacement otherwise.
 *
 * One expression for the five modules that write tags (actors, conversations,
 * documents, files, sessions).
 *
 * Both bags are treated as **opaque values** — the helper spreads them without
 * reading a single key, which is what `.claude/rules/case-convention.md`
 * prescribes for `tags` and why a `cost_center`/`costCenter` collapse cannot
 * happen here.
 */
export const mergeTags = (args: {
  current: Record<string, string> | null | undefined;
  incoming: Record<string, string>;
  merge?: boolean;
}): Record<string, string> => {
  return assertTagBagLimits(
    args.merge ? { ...(args.current ?? {}), ...args.incoming } : args.incoming
  );
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
  return assertTagBagLimits(value);
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
  raw: string | string[] | undefined
): Record<string, string> | undefined => {
  const tags = parseTagPairs(raw);
  if (tags === null) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'tags must be `key:value` pairs, e.g. tags=team:finance'
    );
  }
  return tags;
};

/**
 * The where-fragment that matches a tag bag: every requested pair present with
 * exactly that value.
 *
 * The one matching rule shared by `?tags=`, knowledge search and the
 * `soat:ResourceTag/<key>` fragments `policyCompiler` emits, and the same
 * containment a `metadata` equality compiles to — `?tags=key:value` is the
 * query-string spelling of that equality on the other bag, so both go through
 * `containment` rather than each spelling `@>` for itself.
 */
export const tagContainment = (tags: Record<string, string>) => {
  return containment({ attribute: TAGS_ATTRIBUTE, bag: tags });
};

/**
 * Narrows a list query by tags. A missing or empty bag leaves `where` alone:
 * containment against `{}` matches every row, so it must never reach a query
 * as though it were a filter.
 *
 * ANDed beside what the caller already has rather than assigned onto the bag's
 * attribute: a compiled IAM policy carries its own containment on the same
 * column, and a filter is a question about rows the caller may already see.
 */
export const applyTagFilter = (args: {
  where: Record<string, unknown>;
  tags: Record<string, string> | undefined;
}): void => {
  if (!hasTagFilter(args.tags)) return;
  applyFilterWhere({
    where: args.where,
    fragments: [tagContainment(args.tags)],
  });
};

/**
 * Gate for a caller-supplied tag bag on a write. Returns it unchanged, or
 * refuses the whole write naming the first reserved key it found — a bag
 * silently stripped would leave the caller believing they had labelled a row.
 */
export const assertNoSystemTagKeys = <
  T extends Record<string, string> | null | undefined,
>(
  tags: T
): T => {
  const reserved = Object.keys(tags ?? {}).find(isSystemTagKey);
  if (reserved) {
    throw new DomainError(
      'RESERVED_TAG_KEY',
      `'${reserved}' is reserved: tag keys starting with '${SYSTEM_TAG_PREFIX}' are written by the platform and cannot be set.`
    );
  }
  return tags;
};

/**
 * `assertNoSystemTagKeys` for a bag that was proposed rather than requested —
 * a memory rule's handler output. A handler is model-authored, so a reserved
 * key there is dropped rather than failing the firing around it.
 */
export const stripSystemTagKeys = <
  T extends Record<string, string> | null | undefined,
>(
  tags: T
): T => {
  if (!tags) return tags;
  return Object.fromEntries(
    Object.entries(tags).filter(([key]) => {
      return !isSystemTagKey(key);
    })
  ) as T;
};

/**
 * Whether a *filter* names a reserved key. A search that asks for an actor's
 * turns has said where it wants to look, so it reaches the reserved root that
 * a bare query is kept out of.
 */
export const hasSystemTagFilter = (
  tags: Record<string, string> | undefined
): boolean => {
  return Object.keys(tags ?? {}).some(isSystemTagKey);
};
