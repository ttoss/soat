import type { AiProviderSlug } from '@soat/postgresdb';

import {
  configCredentialError,
  redactAiProviderSecrets,
} from '../aiProviderConfigSecrets';
import {
  createAiProvider,
  deleteAiProvider,
  getAiProvider,
  updateAiProvider,
} from '../aiProviders';
import { lookupSecretInternalId } from '../formationLookups';
import {
  toNullableObject,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { SECRET_USE_ACTION } from '../secretUse';
import { defineFormationModule } from './defineFormationModule';
import { isObjectRecord } from './formationSpecLoader';

export const aiProvidersFormationModule = defineFormationModule({
  resourceType: 'ai_provider',
  authorization: {
    srnResourceType: 'aiProvider',
    create: 'ai-providers:CreateAiProvider',
    update: 'ai-providers:UpdateAiProvider',
    delete: 'ai-providers:DeleteAiProvider',
    references: (properties) => {
      if (!isObjectRecord(properties)) return [];
      const { secret_id: secretId, base_url: baseUrl } = properties;
      if (typeof secretId !== 'string' || typeof baseUrl !== 'string') {
        return [];
      }
      if (secretId === '' || baseUrl === '') return [];
      return [
        {
          action: SECRET_USE_ACTION,
          srnResourceType: 'secret',
          resourceId: secretId,
        },
      ];
    },
  },
  propertiesLabel: 'AI provider',

  // Refused at validation so neither a plan nor `lastAppliedProperties` ever
  // holds the credential.
  extraChecks: ({ properties, basePath, errors }) => {
    const error = configCredentialError(properties.config);
    if (error) {
      errors.push({
        path: `${basePath}.${error.field}`,
        message: error.message,
      });
    }
  },

  create: async ({ properties, projectId, actor }) => {
    const secretPublicId = toNullableString(properties.secret_id);
    const secretId = secretPublicId
      ? await lookupSecretInternalId({ publicId: secretPublicId, projectId })
      : undefined;

    return createAiProvider({
      projectId,
      secretId,
      name: properties.name as string,
      provider: properties.provider as AiProviderSlug,
      defaultModel: properties.default_model as string,
      baseUrl: toOptionalString(properties.base_url),
      config:
        (toNullableObject(properties.config) as Record<string, unknown>) ??
        undefined,
      isAllowed: actor.isAllowed,
    });
  },

  update: async ({ properties, physicalResourceId, projectId, actor }) => {
    let secretId: number | undefined;
    const rawSecretId = properties.secret_id;
    if (rawSecretId !== undefined) {
      const secretPublicId = toNullableString(rawSecretId);
      if (secretPublicId) {
        secretId = await lookupSecretInternalId({
          publicId: secretPublicId,
          projectId,
        });
      }
    }

    await updateAiProvider({
      id: physicalResourceId,
      secretId,
      name: toOptionalString(properties.name),
      provider: toOptionalString(properties.provider) as
        AiProviderSlug | undefined,
      defaultModel: toOptionalString(properties.default_model),
      baseUrl: toNullableString(properties.base_url),
      config: toNullableObject(properties.config) as
        Record<string, unknown> | null | undefined,
      isAllowed: actor.isAllowed,
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteAiProvider({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getAiProvider({ id: physicalResourceId });
  },

  maskCredentials: redactAiProviderSecrets,
});
