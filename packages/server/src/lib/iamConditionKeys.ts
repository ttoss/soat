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
