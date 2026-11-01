import { assertProjectSpendWithinQuota } from './quotaEnforcement';
import { assertStorageQuota } from './quotaStorage';

/**
 * The caps a caller-driven corpus write answers to: it stores `addedBytes` and
 * embeds them, so it is refused over the storage cap or a token/cost budget.
 */
export const assertCorpusWriteQuotas = async (args: {
  projectId: number;
  addedBytes: number;
}): Promise<void> => {
  await assertStorageQuota(args);
  await assertProjectSpendWithinQuota({ projectId: args.projectId });
};
