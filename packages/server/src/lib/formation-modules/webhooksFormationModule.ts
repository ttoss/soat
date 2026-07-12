import createDebug from 'debug';

import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  normalizePropertyKeys,
  toNullableArray,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  createWebhook,
  deleteWebhook,
  findWebhookSecret,
  getWebhook,
  updateWebhook,
} from '../webhooks';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:webhooks');

const SCHEMA_NAME = 'WebhookResourceProperties';
const RESOURCE_LABEL = 'webhook';

// ── Property validation ──────────────────────────────────────────────────

const validateWebhookProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      {
        path: basePath,
        message: 'Webhook `properties` must be an object',
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

export const webhooksFormationModule: FormationModule = {
  resourceType: 'webhook',

  validateProperties: ({ properties, basePath }) => {
    return validateWebhookProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateWebhookProperties({
      properties: rawProperties,
      basePath: 'resources.<webhook>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    const result = await createWebhook({
      projectId,
      name: properties.name as string,
      url: properties.url as string,
      events: properties.events as string[],
      description: toOptionalString(properties.description) ?? undefined,
    });

    log(
      'created webhook from formation: projectId=%d webhookId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateWebhookProperties({
      properties: rawProperties,
      basePath: 'resources.<webhook>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    await updateWebhook({
      id: physicalResourceId,
      name: toOptionalString(properties.name) ?? undefined,
      description: toNullableString(properties.description) ?? undefined,
      url: toOptionalString(properties.url) ?? undefined,
      events: (toNullableArray(properties.events) ?? undefined) as
        string[] | undefined,
    });

    log('updated webhook from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteWebhook({ id: physicalResourceId });
    log('deleted webhook from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    try {
      const webhook = await getWebhook({ id: physicalResourceId });
      if (!webhook) return null;
      return {
        name: webhook.name,
        url: webhook.url,
        events: webhook.events,
        description: webhook.description,
      };
    } catch {
      return null;
    }
  },

  getAttributes: async ({ physicalResourceId }) => {
    const result = await findWebhookSecret({ id: physicalResourceId });
    const attrs: Record<string, string> = {};
    if (result) attrs.secret = result.secret;
    return attrs;
  },
};
