import { db } from '../db';
import { isPlainObject } from './plainObject';
import type { ResourceGrantCarrier } from './resourceGrantCarriers';

const ownPolicyIds = async (
  row: Promise<{ policyIds: string[] | null } | null>
): Promise<string[] | null> => {
  return (await row)?.policyIds ?? null;
};

/**
 * The `policy_ids` each carrier's row named by public id holds now, `null`
 * for a row that is gone or names none: such a grant allows nothing.
 */
const POLICY_IDS_OF: Record<
  ResourceGrantCarrier,
  (publicId: string) => Promise<string[] | null>
> = {
  evals: (publicId) => {
    return ownPolicyIds(
      db.Eval.findOne({ where: { publicId }, attributes: ['policyIds'] })
    );
  },
  deciders: (publicId) => {
    return ownPolicyIds(
      db.Decider.findOne({ where: { publicId }, attributes: ['policyIds'] })
    );
  },
  ingestionRules: (publicId) => {
    return ownPolicyIds(
      db.IngestionRule.findOne({
        where: { publicId },
        attributes: ['policyIds'],
      })
    );
  },
  memoryRules: (publicId) => {
    return ownPolicyIds(
      db.MemoryRule.findOne({ where: { publicId }, attributes: ['policyIds'] })
    );
  },
  // A version's grant is the one it archived, so it never moves under a case
  // pinned to it.
  playbookVersions: async (publicId) => {
    const version = await db.PlaybookVersion.findOne({
      where: { publicId },
      attributes: ['config'],
    });
    const ids = isPlainObject(version?.config)
      ? version.config.policy_ids
      : null;
    return Array.isArray(ids) ? ids.map(String) : null;
  },
};

/** What the resource's grant names now. */
export const resourcePolicyIds = (args: {
  carrier: ResourceGrantCarrier;
  id: string;
}): Promise<string[] | null> => {
  return POLICY_IDS_OF[args.carrier](args.id);
};
