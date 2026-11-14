import type { PolicySets } from './iam';

/**
 * The keys the platform supplies to a policy condition and the variables a
 * condition value may name. Generic, so a policy reads the same in every
 * deployment.
 */
const NAMESPACE = 'iam';

export const RESOURCE_TYPE_KEY = `${NAMESPACE}:ResourceType`;

/** Followed by a tag name, verbatim. */
export const RESOURCE_TAG_KEY_PREFIX = `${NAMESPACE}:ResourceTag/`;

/** `${iam:ActorId}`: the end user a generation runs for. */
export const ACTOR_ID_VARIABLE = `${NAMESPACE}:ActorId`;

export const resourceTagKey = (tag: string): string => {
  return `${RESOURCE_TAG_KEY_PREFIX}${tag}`;
};

/**
 * Followed by a tag name, verbatim: the value the request writes for that tag.
 * Absent from a request that writes no such tag, reads included.
 */
export const REQUEST_TAG_KEY_PREFIX = `${NAMESPACE}:RequestTag/`;

export const requestTagKey = (tag: string): string => {
  return `${REQUEST_TAG_KEY_PREFIX}${tag}`;
};

/**
 * Whether a statement in `sets` conditions on `iam:RequestTag/<key>` for one of
 * `keys`: the question to ask before authorizing a write whose value for such a
 * key is not known yet, which no evaluation can answer.
 */
export const namesRequestTag = (args: {
  sets: PolicySets;
  keys: readonly string[];
}): boolean => {
  const named = new Set(args.keys.map(requestTagKey));
  return args.sets
    .flat()
    .flatMap((doc) => {
      return doc.statement;
    })
    .flatMap((statement) => {
      return Object.values(statement.condition ?? {});
    })
    .some((block) => {
      return Object.keys(block ?? {}).some((key) => {
        return named.has(key);
      });
    });
};
