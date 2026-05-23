import createDebug from 'debug';

import { db } from '../../db';
import { lookupAgentInternalId } from '../formationsHelpers';
import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  toNullableObject,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { createSession, deleteSession, updateSession } from '../sessions';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:sessions');

const SCHEMA_NAME = 'SessionResourceProperties';
const RESOURCE_LABEL = 'session';

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

const validateSessionProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      {
        path: basePath,
        message: 'Session `properties` must be an object',
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

// ── Helpers ──────────────────────────────────────────────────────────────

const getSessionAgentInternalId = async (
  sessionPublicId: string
): Promise<number> => {
  const session = await db.Session.findOne({
    where: { publicId: sessionPublicId },
  });
  if (!session) {
    throw new Error(`Session not found: ${sessionPublicId}`);
  }
  return (session as unknown as { agentId: number }).agentId;
};

// ── Module export ────────────────────────────────────────────────────────

export const sessionsFormationModule: FormationModule = {
  resourceType: 'session',

  validateProperties: ({ properties, basePath }) => {
    return validateSessionProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateSessionProperties({
      properties: rawProperties,
      basePath: 'resources.<session>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    const agentId = await lookupAgentInternalId(properties.agent_id as string);

    const result = await createSession({
      projectId,
      agentId,
      name: toNullableString(properties.name),
      actorId: toNullableString(properties.actor_id),
      autoGenerate:
        typeof properties.auto_generate === 'boolean'
          ? properties.auto_generate
          : undefined,
      toolContext:
        (toNullableObject(properties.tool_context) as Record<
          string,
          string
        > | null) ?? undefined,
    });

    log(
      'created session from formation: projectId=%d sessionId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateSessionProperties({
      properties: rawProperties,
      basePath: 'resources.<session>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    const agentId = await getSessionAgentInternalId(physicalResourceId);

    await updateSession({
      agentId,
      sessionId: physicalResourceId,
      name: toNullableString(properties.name),
      status: toOptionalString(properties.status) ?? undefined,
      autoGenerate:
        typeof properties.auto_generate === 'boolean'
          ? properties.auto_generate
          : undefined,
      toolContext:
        (toNullableObject(properties.tool_context) as Record<
          string,
          string
        > | null) ?? undefined,
    });

    log('updated session from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    const agentId = await getSessionAgentInternalId(physicalResourceId);
    await deleteSession({ agentId, sessionId: physicalResourceId });
    log('deleted session from formation: id=%s', physicalResourceId);
  },
};
