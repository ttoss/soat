import { db } from 'src/db';
import { evaluatePolicies, type PolicyDocument } from 'src/lib/iam';

import type { SoatEvent } from './eventBus';

/**
 * The subscription matcher shared by every bus subscriber that lets a caller
 * declare *which* events it wants: an exact name, a `prefix.*` namespace, or
 * `*` for everything.
 *
 * It lives here rather than in the webhook dispatcher because event triggers
 * subscribe with the same grammar. Two copies of a matcher is two places for a
 * pattern to start meaning something slightly different.
 */
export const matchesEvent = (args: {
  patterns: readonly string[];
  eventType: string;
}): boolean => {
  return args.patterns.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern === args.eventType) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return args.eventType.startsWith(prefix + '.');
    }
    return false;
  });
};

/**
 * Evaluates a subscription's optional boundary policy against one event: the
 * event name is the action and the event's resource is the SRN. Returns `false`
 * when the policy no longer exists, so a deleted policy fails closed rather
 * than silently widening the subscription.
 *
 * Shared by webhook subscriptions and event triggers — both attach a
 * `policy_id` with exactly these semantics.
 */
export const evaluateEventPolicy = async (args: {
  policyId: number;
  event: SoatEvent;
}): Promise<boolean> => {
  const policy = await db.Policy.findOne({
    where: { id: args.policyId },
  });
  if (!policy) return false;

  return evaluatePolicies({
    policies: [policy.document as PolicyDocument],
    action: args.event.type,
    resource: `srn:${args.event.projectPublicId}:${args.event.resourceType}:${args.event.resourceId}`,
  });
};
