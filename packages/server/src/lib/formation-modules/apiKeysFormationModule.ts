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
  // `POST /api-keys` is self-service: a caller mints a key for *themselves*.
  // A formation has no request user, so the key is minted under the project
  // owner — an identity no route lets a non-admin borrow. Hence the role gate
  // rather than the action alone (#1181).
  authorization: {
    srnResourceType: 'apiKey',
    create: 'api-keys:CreateApiKey',
    update: 'api-keys:UpdateApiKey',
    delete: 'api-keys:DeleteApiKey',
    adminOnly: true,
  },
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
