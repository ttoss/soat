import {
  createApiKey,
  deleteApiKey,
  getApiKey,
  updateApiKey,
} from '../apiKeys';
import { lookupPolicyInternalIds } from '../formationsHelpers';
import { toOptionalString } from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

export const apiKeysFormationModule = defineFormationModule({
  resourceType: 'api_key',
  authorization: {
    srnResourceType: 'apiKey',
    create: 'api-keys:CreateApiKey',
    update: 'api-keys:UpdateApiKey',
    delete: 'api-keys:DeleteApiKey',
  },
  propertiesLabel: 'API key',

  // Minted under the caller, as `POST /api-keys` is: a key inherits its owner's
  // permissions as a ceiling, so one minted under the *project owner* would let
  // any caller who can deploy a formation escalate to the owner's access
  // (#1181). Owning it themselves, they gain nothing they did not already have.
  create: async ({ properties, projectId, actingUserId }) => {
    const rawPolicyIds = properties.policy_ids;
    const policyPublicIds = Array.isArray(rawPolicyIds)
      ? (rawPolicyIds as string[])
      : [];
    const policyIds =
      policyPublicIds.length > 0
        ? await lookupPolicyInternalIds(policyPublicIds)
        : undefined;

    return createApiKey({
      userId: actingUserId,
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
