import createDebug from 'debug';

import {
  createConversation,
  deleteConversation,
  getConversation,
  updateConversation,
} from '../conversations';
import { lookupActorInternalId } from '../formationsHelpers';
import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:conversations');

const SCHEMA_NAME = 'ConversationResourceProperties';
const RESOURCE_LABEL = 'conversation';

// ── Key normalization ────────────────────────────────────────────────────

const camelToSnakeKey = (key: string): string => {
  return key.replace(/[A-Z]/g, (char) => {
    return `_${char.toLowerCase()}`;
  });
};

const normalizePropertyKeys = (
  properties: Record<string, unknown>
): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => {
      return [camelToSnakeKey(key), value];
    })
  );
};

// ── Property validation ──────────────────────────────────────────────────

const validateConversationProperties = (args: {
  properties: unknown;
  basePath: string;
}): ValidationError[] => {
  const { basePath } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      {
        path: basePath,
        message: 'Conversation `properties` must be an object',
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
  pushFieldTypeErrors({ spec, properties, basePath, errors });

  return errors;
};

// ── Module export ────────────────────────────────────────────────────────

export const conversationsFormationModule: FormationModule = {
  resourceType: 'conversation',

  validateProperties: ({ properties, basePath }) => {
    return validateConversationProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateConversationProperties({
      properties: rawProperties,
      basePath: 'resources.<conversation>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    const actorPublicId = toNullableString(properties.actor_id);
    let actorId: number | null = null;
    if (actorPublicId) {
      actorId = await lookupActorInternalId(actorPublicId);
    }

    const result = await createConversation({
      projectId,
      name: toNullableString(properties.name),
      status: toOptionalString(properties.status) ?? undefined,
      actorId,
    });

    log(
      'created conversation from formation: projectId=%d conversationId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateConversationProperties({
      properties: rawProperties,
      basePath: 'resources.<conversation>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    await updateConversation({
      id: physicalResourceId,
      name: toNullableString(properties.name),
      status: toOptionalString(properties.status) ?? undefined,
    });

    log('updated conversation from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteConversation({ id: physicalResourceId });
    log('deleted conversation from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    try {
      const conv = await getConversation({ id: physicalResourceId });
      if (!conv) return null;
      return {
        name: conv.name,
        status: conv.status,
        actor_id: conv.actorId,
      };
    } catch {
      return null;
    }
  },
};
