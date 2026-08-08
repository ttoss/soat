import {
  createApiKey,
  deleteApiKey,
  getApiKey,
  updateApiKey,
} from '../apiKeys';
import {
  lookupPolicyInternalIds,
  lookupProjectOwnerUserId,
} from '../formationsHelpers';
import { toOptionalString } from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

export const apiKeysFormationModule = defineFormationModule({
  resourceType: 'api_key',
  propertiesLabel: 'API key',

  create: async ({ properties, projectId }) => {
    const userId = await lookupProjectOwnerUserId(projectId);

    const rawPolicyIds = properties.policy_ids;
    const policyPublicIds = Array.isArray(rawPolicyIds)
      ? (rawPolicyIds as string[])
      : [];
    const policyIds =
      policyPublicIds.length > 0
        ? await lookupPolicyInternalIds(policyPublicIds)
        : undefined;

    return createApiKey({
      userId,
      projectId,
      name: properties.name as string,
      policyIds,
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    let policyIds: number[] | undefined;
    const rawPolicyIds = properties.policy_ids;
    if (rawPolicyIds !== undefined) {
      const publicIds = Array.isArray(rawPolicyIds)
        ? (rawPolicyIds as string[])
        : [];
      policyIds = await lookupPolicyInternalIds(publicIds);
    }

    await updateApiKey({
      id: physicalResourceId,
      name: toOptionalString(properties.name),
      policyIds,
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteApiKey({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getApiKey({ id: physicalResourceId });
  },
});
