import {
  boundKeyPolicyIds,
  createApiKey,
  deleteApiKey,
  getApiKey,
  updateApiKey,
} from '../apiKeys';
import { lookupPolicyInternalIds } from '../formationLookups';
import { toOptionalString } from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

/** `undefined` when the template omits `policy_ids`. */
const readPolicyPublicIds = (
  properties: Record<string, unknown>
): string[] | undefined => {
  const raw = properties.policy_ids;
  if (raw === undefined) return undefined;
  return Array.isArray(raw)
    ? raw.filter((id): id is string => {
        return typeof id === 'string';
      })
    : [];
};

const lookupPolicyIds = async (
  publicIds: string[] | undefined
): Promise<number[] | undefined> => {
  return publicIds === undefined
    ? undefined
    : lookupPolicyInternalIds(publicIds);
};

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
  // any caller who can deploy a formation escalate to the owner's access.
  // Owning it themselves, they gain nothing they did not already have.
  create: async ({ properties, projectId, actor }) => {
    const policyPublicIds = readPolicyPublicIds(properties);
    const policyIds = await boundKeyPolicyIds({
      boundaryPolicyIds: actor.keyPolicyBoundary,
      requestedPolicyPublicIds: policyPublicIds,
      requestedPolicyIds: await lookupPolicyIds(policyPublicIds),
      inheritWhenOmitted: true,
      onRefused: () => {
        actor.recordRefusal('api-keys:CreateApiKey');
      },
    });

    return createApiKey({
      userId: actor.userId,
      projectId,
      name: properties.name as string,
      policyIds,
    });
  },

  update: async ({ properties, physicalResourceId, actor }) => {
    const policyPublicIds = readPolicyPublicIds(properties);
    const policyIds = await boundKeyPolicyIds({
      boundaryPolicyIds: actor.keyPolicyBoundary,
      requestedPolicyPublicIds: policyPublicIds,
      requestedPolicyIds: await lookupPolicyIds(policyPublicIds),
      inheritWhenOmitted: false,
      onRefused: () => {
        actor.recordRefusal('api-keys:UpdateApiKey');
      },
    });

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
