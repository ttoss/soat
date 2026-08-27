/**
 * Builds a `FormationModule` for an operator-registered resource type (#1078).
 *
 * The counterpart to `defineFormationModule`: that factory backs a type with an
 * in-process lib call, this one with a signed HTTP round trip to the registered
 * handler. Everything either plugs into is identical — same validation seam,
 * same create/update/delete contract, same drift `read` — so a template author
 * cannot tell a registered type from a built-in one and the engine never
 * branches on it.
 *
 * Validation is the registration's JSON Schema fed through the same three
 * `push*Errors` helpers, plus a plan-time round trip when the registration
 * declares the `validate` capability.
 *
 * Nothing here rewrites a key: the properties bag travels to the handler as a
 * value and returns the same way (`.claude/rules/case-convention.md`).
 */

import createDebug from 'debug';

import {
  callFormationHandler,
  requirePhysicalResourceId,
} from '../formationHandlerClient';
import type { FormationResourceTypeRegistration } from '../formationResourceTypeConfig';
import { normalizeDeclaredProperties } from '../formationsProperties';
import type {
  FormationModule,
  UpdateOutcome,
  ValidationError,
} from '../formationsTypes';
import { isObjectRecord } from '../openapiSchemaFields';
import { findProjectPublicId } from '../projects';
import {
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

// ── Validation ────────────────────────────────────────────────────────────

const buildValidator = (args: {
  registration: FormationResourceTypeRegistration;
}) => {
  const { registration } = args;
  const label = registration.name;

  return (validateArgs: {
    properties: unknown;
    basePath: string;
    forUpdate: boolean;
  }): ValidationError[] => {
    if (!isObjectRecord(validateArgs.properties)) {
      return [
        {
          path: validateArgs.basePath,
          message: `${label} \`properties\` must be an object`,
        },
      ];
    }

    const properties = normalizeDeclaredProperties(validateArgs.properties);
    const spec = registration.schemaFields;
    const errors: ValidationError[] = [];
    pushUnknownFieldErrors({
      spec,
      resourceLabel: label,
      properties,
      basePath: validateArgs.basePath,
      errors,
    });
    // A template update is a patch, exactly as for a built-in type.
    if (!validateArgs.forUpdate) {
      pushRequiredFieldErrors({
        spec,
        properties,
        basePath: validateArgs.basePath,
        errors,
      });
    }
    pushFieldTypeErrors({
      spec,
      properties,
      basePath: validateArgs.basePath,
      errors,
    });
    return errors;
  };
};

/**
 * Reads the handler's `validate` answer. The handler owns the `path`/`message`
 * of each error it reports — this is its verdict on the template, relayed.
 */
const parseValidationErrors = (
  body: Record<string, unknown>
): ValidationError[] => {
  if (!Array.isArray(body.errors)) return [];
  const errors: ValidationError[] = [];
  for (const entry of body.errors) {
    if (!isObjectRecord(entry)) continue;
    if (typeof entry.message !== 'string') continue;
    errors.push({
      path: typeof entry.path === 'string' ? entry.path : '',
      message: entry.message,
    });
  }
  return errors;
};

// ── Read ──────────────────────────────────────────────────────────────────

const readLiveProperties = async (args: {
  registration: FormationResourceTypeRegistration;
  physicalResourceId: string;
}): Promise<Record<string, unknown> | null> => {
  const body = await callFormationHandler({
    registration: args.registration,
    request: {
      requestType: 'read',
      logicalId: '',
      resourceKey: args.physicalResourceId,
      physicalResourceId: args.physicalResourceId,
    },
  });

  if (body.exists !== true) return null;
  return isObjectRecord(body.properties) ? body.properties : null;
};

// ── Lifecycle operations ──────────────────────────────────────────────────

type AssertValid = (args: {
  properties: unknown;
  forUpdate: boolean;
}) => Record<string, unknown>;

const buildOperations = (args: {
  registration: FormationResourceTypeRegistration;
  assertValid: AssertValid;
  log: createDebug.Debugger;
}): Pick<FormationModule, 'create' | 'update' | 'delete'> => {
  const { registration, assertValid, log } = args;
  const resourceType = registration.name;

  return {
    create: async ({ properties: raw, projectId, logicalId, resourceKey }) => {
      const properties = assertValid({ properties: raw, forUpdate: false });
      // The handler is told which project in the id its own callers use; the
      // internal row id never leaves the process.
      const projectPublicId = await findProjectPublicId({ id: projectId });
      const body = await callFormationHandler({
        registration,
        request: {
          requestType: 'create',
          logicalId: logicalId ?? '',
          resourceKey: resourceKey ?? logicalId ?? '',
          projectPublicId,
          properties,
        },
      });
      const physicalResourceId = requirePhysicalResourceId({
        body,
        resourceType,
        requestType: 'create',
      });
      log(
        'created %s via handler: projectId=%d id=%s',
        resourceType,
        projectId,
        physicalResourceId
      );
      return physicalResourceId;
    },

    update: async ({
      properties: raw,
      physicalResourceId,
      logicalId,
      resourceKey,
    }): Promise<UpdateOutcome | void> => {
      const properties = assertValid({ properties: raw, forUpdate: true });
      const body = await callFormationHandler({
        registration,
        request: {
          requestType: 'update',
          logicalId: logicalId ?? '',
          resourceKey: resourceKey ?? physicalResourceId,
          physicalResourceId,
          properties,
        },
      });
      const returnedId = requirePhysicalResourceId({
        body,
        resourceType,
        requestType: 'update',
      });
      log('updated %s via handler: id=%s', resourceType, physicalResourceId);
      if (returnedId === physicalResourceId) return;

      // A different id back means the handler could not change this resource in
      // place and made a new one; the engine re-points the record and disposes
      // of the old resource under its `deletion_policy`.
      log(
        'handler replaced %s: %s -> %s',
        resourceType,
        physicalResourceId,
        returnedId
      );
      return { replacedWithPhysicalResourceId: returnedId };
    },

    delete: async ({ physicalResourceId, logicalId, resourceKey }) => {
      await callFormationHandler({
        registration,
        request: {
          requestType: 'delete',
          logicalId: logicalId ?? '',
          resourceKey: resourceKey ?? physicalResourceId,
          physicalResourceId,
        },
      });
      log('deleted %s via handler: id=%s', resourceType, physicalResourceId);
    },
  };
};

// ── Optional capabilities ─────────────────────────────────────────────────

/**
 * The members a registration only has when it declared the capability, present
 * as keys or absent entirely — the planner and `resolveFormationOutputs` branch
 * on `read` / `getAttributes` being undefined, which is how a type without the
 * `read` capability becomes drift-exempt rather than silently drift-free.
 */
const buildCapabilityMembers = (args: {
  registration: FormationResourceTypeRegistration;
}): Partial<FormationModule> => {
  const { registration } = args;

  const validateMember: Partial<FormationModule> =
    registration.capabilities.has('validate')
      ? {
          validatePropertiesAsync: async ({ properties, basePath }) => {
            const body = await callFormationHandler({
              registration,
              request: {
                requestType: 'validate',
                logicalId: '',
                resourceKey: basePath,
                properties: isObjectRecord(properties)
                  ? normalizeDeclaredProperties(properties)
                  : {},
              },
            });
            return parseValidationErrors(body);
          },
        }
      : {};

  const writeOnlyMember: Partial<FormationModule> =
    registration.writeOnlyProperties.size > 0
      ? {
          // The engine's own hook for this, and the same one every built-in
          // secret-bearing type uses. It runs on the way to storage only —
          // the handler has already been sent the full bag.
          sanitizeLastAppliedProperties: (properties) => {
            const kept: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(properties)) {
              if (!registration.writeOnlyProperties.has(key)) kept[key] = value;
            }
            return kept;
          },
        }
      : {};

  if (!registration.capabilities.has('read')) {
    return { ...validateMember, ...writeOnlyMember };
  }

  return {
    ...validateMember,
    ...writeOnlyMember,

    read: async ({ physicalResourceId }) => {
      try {
        return await readLiveProperties({ registration, physicalResourceId });
      } catch {
        // The drift contract every built-in `read` honours: a read that cannot
        // answer reports "gone", it does not fail the plan.
        return null;
      }
    },

    getAttributes: async ({ physicalResourceId }) => {
      const attributes: Record<string, string> = {};
      let body: Record<string, unknown>;
      try {
        body = await callFormationHandler({
          registration,
          request: {
            requestType: 'read',
            logicalId: '',
            resourceKey: physicalResourceId,
            physicalResourceId,
          },
        });
      } catch {
        return attributes;
      }
      if (!isObjectRecord(body.outputs)) return attributes;
      // `ref_attr` resolves to a string, so a non-string output is skipped
      // rather than coerced into one.
      for (const [key, value] of Object.entries(body.outputs)) {
        if (typeof value === 'string') attributes[key] = value;
      }
      return attributes;
    },
  };
};

// ── Factory ───────────────────────────────────────────────────────────────

export const buildRegisteredFormationModule = (args: {
  registration: FormationResourceTypeRegistration;
}): FormationModule => {
  const { registration } = args;
  const resourceType = registration.name;
  const log = createDebug(`soat:formations:${resourceType}`);
  const validate = buildValidator({ registration });

  const assertValid: AssertValid = (assertArgs) => {
    const errors = validate({
      properties: assertArgs.properties,
      basePath: `resources.<${resourceType}>.properties`,
      forUpdate: assertArgs.forUpdate,
    });
    if (errors.length > 0) throw new Error(errors[0].message);
    return normalizeDeclaredProperties(
      assertArgs.properties as Record<string, unknown>
    );
  };

  return {
    resourceType,

    validateProperties: ({ properties, basePath }) => {
      return validate({ properties, basePath, forUpdate: false });
    },

    ...buildOperations({ registration, assertValid, log }),

    ...buildCapabilityMembers({ registration }),
  };
};
