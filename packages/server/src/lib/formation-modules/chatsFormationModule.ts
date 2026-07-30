import createDebug from 'debug';

import { createChat, deleteChat, getChat } from '../chats';
import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  normalizePropertyKeys,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:chats');

const SCHEMA_NAME = 'ChatResourceProperties';
const RESOURCE_LABEL = 'chat';

// ── Property validation ──────────────────────────────────────────────────

const validateChatProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      {
        path: basePath,
        message: 'Chat `properties` must be an object',
      },
    ];
  }

  const properties = normalizePropertyKeys(args.properties);
  const spec = loadModuleSpec({ schemaName: SCHEMA_NAME });
  const errors: ValidationError[] = [];
  pushUnknownFieldErrors({
    spec,
    resourceLabel: RESOURCE_LABEL,
    properties,
    basePath,
    errors,
  });
  if (!forUpdate) {
    pushRequiredFieldErrors({ spec, properties, basePath, errors });
  }
  pushFieldTypeErrors({ spec, properties, basePath, errors });

  return errors;
};

// ── Module export ────────────────────────────────────────────────────────

export const chatsFormationModule: FormationModule = {
  resourceType: 'chat',

  validateProperties: ({ properties, basePath }) => {
    return validateChatProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateChatProperties({
      properties: rawProperties,
      basePath: 'resources.<chat>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    const result = await createChat({
      projectId,
      // Absent means the chat inherits the project's default model route.
      aiProviderId: toOptionalString(properties.ai_provider_id) ?? undefined,
      name: toOptionalString(properties.name) ?? undefined,
      systemMessage: toNullableString(properties.system_message) ?? undefined,
      model: toNullableString(properties.model) ?? undefined,
    });

    log(
      'created chat from formation: projectId=%d chatId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    // Chats do not support updates — validate properties but skip the operation.
    const errors = validateChatProperties({
      properties: rawProperties,
      basePath: 'resources.<chat>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    log('update chat from formation (no-op): id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteChat({ id: physicalResourceId });
    log('deleted chat from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    try {
      const chat = await getChat({ id: physicalResourceId });
      return {
        ai_provider_id: chat.ai_provider_id,
        name: chat.name,
        system_message: chat.system_message,
        model: chat.model,
      };
    } catch {
      return null;
    }
  },
};
