import {
  boundKeyPolicyIds,
  createApiKey,
  deleteApiKey,
  getApiKey,
  updateApiKey,
} from '../apiKeys';
import { toOptionalString } from '../resource-inputs/normalizers';
import { assertWriterHolds, type Writer } from '../writerRule';
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

const lookupPolicyIds = async (args: {
  publicIds: string[] | undefined;
  writer: Writer;
  projectId: number;
}): Promise<number[] | undefined> => {
  if (args.publicIds === undefined) return undefined;
  const policies = await assertWriterHolds({
    carrier: 'apiKeys',
    writer: args.writer,
    projectId: args.projectId,
    carried: { policyIds: args.publicIds },
  });
  return policies.map((policy) => {
    return policy.id;
  });
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
      scopedToken: actor.scopedToken,
      boundaryPolicyIds: actor.keyPolicyBoundary,
      requestedPolicyPublicIds: policyPublicIds,
      requestedPolicyIds: await lookupPolicyIds({
        publicIds: policyPublicIds,
        writer: actor,
        projectId,
      }),
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

  update: async ({ properties, physicalResourceId, projectId, actor }) => {
    const policyPublicIds = readPolicyPublicIds(properties);
    const policyIds = await boundKeyPolicyIds({
      scopedToken: actor.scopedToken,
      boundaryPolicyIds: actor.keyPolicyBoundary,
      requestedPolicyPublicIds: policyPublicIds,
      requestedPolicyIds: await lookupPolicyIds({
        publicIds: policyPublicIds,
        writer: actor,
        projectId,
      }),
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
