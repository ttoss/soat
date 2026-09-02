import type { AiProviderSlug } from '@soat/postgresdb';

import {
  createAiProvider,
  deleteAiProvider,
  getAiProvider,
  updateAiProvider,
} from '../aiProviders';
import { lookupSecretInternalId } from '../formationsHelpers';
import {
  toNullableObject,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

export const aiProvidersFormationModule = defineFormationModule({
  resourceType: 'ai_provider',
  authorization: {
    srnResourceType: 'aiProvider',
    create: 'ai-providers:CreateAiProvider',
    update: 'ai-providers:UpdateAiProvider',
    delete: 'ai-providers:DeleteAiProvider',
  },
  propertiesLabel: 'AI provider',

  create: async ({ properties, projectId }) => {
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
    });
  },

  update: async ({ properties, physicalResourceId, projectId }) => {
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
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteAiProvider({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getAiProvider({ id: physicalResourceId });
  },
});
