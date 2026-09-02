/**
 * The one implementation of a formation module's mechanical half — the
 * `isObjectRecord` guard, the spec load, the three `push*Errors` calls, the
 * re-validate + `throw errors[0].message` preamble, the `read` try/catch, and
 * the log lines.
 *
 * It lives here once because a rule restated in twenty-four modules is a rule
 * twenty-four places can skip — a missed camelCase normalization or a missing
 * allowlist entry in any one of them. Each module declares only the
 * property→lib-arg mapping, its own checks, and the read view.
 *
 * Nothing here rewrites a key (`.claude/rules/case-convention.md`):
 * `normalizeDeclaredProperties` is the shared shallow declaration normalizer,
 * and `pickSpecFields` selects declared keys out of an already-snake_case
 * source without emitting a name of its own.
 */

import createDebug from 'debug';

import { normalizeDeclaredProperties } from '../formationsProperties';
import type {
  FormationModule,
  FormationModuleAuthorization,
  ValidationError,
} from '../formationsTypes';
import type { ModuleOpenApiSpec } from './formationSpecLoader';
import {
  isObjectRecord,
  loadModuleSpec,
  pickSpecFields,
  pushFieldEnumErrors,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

// ── Derived names ─────────────────────────────────────────────────────────

/**
 * `model_route` → `ModelRouteResourceProperties`. Derived rather than declared
 * per module, so a module and its schema cannot drift apart; the rule is
 * asserted for every registered type in
 * `tests/unit/tests/lib/formationsResourceTypeContract.test.ts`.
 */
export const schemaNameForResourceType = (resourceType: string): string => {
  const pascal = resourceType
    .split('_')
    .map((part) => {
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('');
  return `${pascal}ResourceProperties`;
};

const capitalize = (value: string): string => {
  return value.charAt(0).toUpperCase() + value.slice(1);
};

// ── Definition ────────────────────────────────────────────────────────────

export type FormationModuleDefinition<TResource> = {
  /** The type a template declares, e.g. `model_route`. */
  resourceType: string;
  /**
   * The action each operation is authorized as, before the module runs. Required
   * so a new module cannot be reachable from a template without saying what
   * permission applying it needs (#1181).
   */
  authorization: FormationModuleAuthorization;
  /**
   * Noun used in the "Unknown <label> field" message. Defaults to
   * `resourceType`; declare it only where the prose differs (`ingestion rule`).
   */
  resourceLabel?: string;
  /**
   * Noun used in the "<label> `properties` must be an object" message. Defaults
   * to the capitalized `resourceLabel`; declare it only where that is wrong
   * (`AI provider`, `API key`).
   */
  propertiesLabel?: string;
  /**
   * Whether required fields are enforced on update too. Default `false`: a
   * template update is a patch, so only a create must carry every required
   * field.
   */
  requiredOnUpdate?: boolean;
  /** The resource-specific checks — the only per-module validation left. */
  extraChecks?: (args: {
    properties: Record<string, unknown>;
    basePath: string;
    forUpdate: boolean;
    errors: ValidationError[];
  }) => void;
  /** Non-fatal checks surfaced as `ValidationResult.warnings`. */
  warnChecks?: (args: {
    properties: Record<string, unknown>;
    basePath: string;
  }) => ValidationError[];
  create: (args: {
    properties: Record<string, unknown>;
    projectId: number;
    actingUserId: number;
  }) => Promise<{ id: string }>;
  /**
   * Omit for a resource that cannot be updated — the apply becomes a no-op.
   * Resolves to `unknown` so a module can hand back the lib call directly; the
   * factory discards whatever it resolves to.
   */
  update?: (args: {
    properties: Record<string, unknown>;
    physicalResourceId: string;
    projectId: number;
    actingUserId: number;
  }) => Promise<unknown>;
  remove: (args: { physicalResourceId: string }) => Promise<unknown>;
  /**
   * Why `remove` would refuse, or `null` when it would succeed. Declare it only
   * where the refusal is predictable and worth pre-flighting — see
   * `FormationModule.findDeletionBlocker`.
   */
  deletionBlocker?: (args: {
    physicalResourceId: string;
  }) => Promise<string | null>;
  /**
   * Loads the live resource. Any throw, and a `null`/`undefined` result, mean
   * "gone" — the factory reports drift rather than failing the plan.
   */
  fetch?: (args: {
    physicalResourceId: string;
  }) => Promise<TResource | null | undefined>;
  /**
   * Maps the fetched resource to its template-shaped (snake_case) view. Omit
   * when that view is exactly the schema's declared fields taken verbatim from
   * an already-snake_case source — `pickSpecFields` then selects them.
   */
  read?: (resource: TResource) => Record<string, unknown>;
  writeOnly?: boolean;
  sanitizeLastAppliedProperties?: (
    properties: Record<string, unknown>
  ) => Record<string, unknown>;
  getAttributes?: (args: {
    physicalResourceId: string;
  }) => Promise<Record<string, string>>;
};

// ── Factory ───────────────────────────────────────────────────────────────

type Validator = (args: {
  properties: unknown;
  basePath: string;
  forUpdate: boolean;
}) => ValidationError[];

/**
 * The validation core: the object guard, the schema-derived unknown/required/
 * type checks, and finally the module's own `extraChecks` — the sequence every
 * module shares instead of transcribing.
 */
const buildValidator = <TResource>(args: {
  definition: FormationModuleDefinition<TResource>;
  resourceLabel: string;
  propertiesLabel: string;
  schemaName: string;
}): Validator => {
  const { definition, resourceLabel, propertiesLabel, schemaName } = args;
  return ({ properties: raw, basePath, forUpdate }) => {
    if (!isObjectRecord(raw)) {
      return [
        {
          path: basePath,
          message: `${propertiesLabel} \`properties\` must be an object`,
        },
      ];
    }

    const properties = normalizeDeclaredProperties(raw);
    const spec: ModuleOpenApiSpec = loadModuleSpec({ schemaName });
    const errors: ValidationError[] = [];
    pushUnknownFieldErrors({
      spec,
      resourceLabel,
      properties,
      basePath,
      errors,
    });
    if (!forUpdate || definition.requiredOnUpdate) {
      pushRequiredFieldErrors({ spec, properties, basePath, errors });
    }
    const typeErrored = pushFieldTypeErrors({
      spec,
      properties,
      basePath,
      errors,
    });
    pushFieldEnumErrors({
      spec,
      properties,
      basePath,
      errors,
      skipFields: typeErrored,
    });
    definition.extraChecks?.({ properties, basePath, forUpdate, errors });

    return errors;
  };
};

/**
 * The drift contract: a resource that cannot be loaded — gone, unreadable, or
 * write-only — reads as `null` rather than failing the plan.
 */
const buildReader = <TResource>(args: {
  definition: FormationModuleDefinition<TResource>;
  schemaName: string;
}): ((restArgs: {
  physicalResourceId: string;
}) => Promise<Record<string, unknown> | null>) => {
  const { definition, schemaName } = args;
  return async (readArgs) => {
    const fetchResource = definition.fetch;
    /* istanbul ignore next — a write-only module declares no `fetch`. */
    if (!fetchResource) return null;
    try {
      const resource = await fetchResource(readArgs);
      if (resource === null || resource === undefined) return null;
      if (definition.read) return definition.read(resource);
      /* istanbul ignore next — `read` is omitted only for record-shaped rows. */
      if (!isObjectRecord(resource)) return null;
      return pickSpecFields({
        spec: loadModuleSpec({ schemaName }),
        resource,
      });
    } catch {
      return null;
    }
  };
};

/**
 * The three write operations. Each re-validates first — `create`/`update` are
 * public entry points of their own, so a bad bag surfaces as the plain `Error`
 * `formationsApply` records against the failing resource — then delegates to the
 * module and logs. A module that declares no `update` validates and no-ops.
 */
const buildOperations = <TResource>(args: {
  definition: FormationModuleDefinition<TResource>;
  assertValid: (assertArgs: {
    properties: unknown;
    forUpdate: boolean;
  }) => Record<string, unknown>;
  log: createDebug.Debugger;
}): Pick<FormationModule, 'create' | 'update' | 'delete'> => {
  const { definition, assertValid, log } = args;
  const type = definition.resourceType;

  return {
    create: async ({ properties: raw, projectId, actingUserId }) => {
      const properties = assertValid({ properties: raw, forUpdate: false });
      const created = await definition.create({
        properties,
        projectId,
        actingUserId,
      });
      log(
        'created %s from formation: projectId=%d id=%s',
        type,
        projectId,
        created.id
      );
      return created.id;
    },

    update: async ({
      properties: raw,
      physicalResourceId,
      projectId,
      actingUserId,
    }) => {
      const properties = assertValid({ properties: raw, forUpdate: true });
      if (!definition.update) {
        log(
          'update %s from formation (no-op): id=%s',
          type,
          physicalResourceId
        );
        return;
      }
      await definition.update({
        properties,
        physicalResourceId,
        projectId,
        actingUserId,
      });
      log('updated %s from formation: id=%s', type, physicalResourceId);
    },

    delete: async ({ physicalResourceId }) => {
      await definition.remove({ physicalResourceId });
      log('deleted %s from formation: id=%s', type, physicalResourceId);
    },
  };
};

/**
 * The members a module only has when it declares them — present as keys or
 * absent entirely, because the planner and the apply pipeline branch on
 * `module.writeOnly` / `module.getAttributes` being undefined.
 */
const buildOptionalMembers = <TResource>(
  definition: FormationModuleDefinition<TResource>
): Partial<FormationModule> => {
  const {
    warnChecks,
    sanitizeLastAppliedProperties,
    getAttributes,
    deletionBlocker,
  } = definition;
  return {
    ...(deletionBlocker ? { findDeletionBlocker: deletionBlocker } : {}),
    ...(warnChecks
      ? {
          warnProperties: ({ properties, basePath }) => {
            return isObjectRecord(properties)
              ? warnChecks({
                  properties: normalizeDeclaredProperties(properties),
                  basePath,
                })
              : [];
          },
        }
      : {}),
    ...(definition.writeOnly ? { writeOnly: true } : {}),
    ...(sanitizeLastAppliedProperties ? { sanitizeLastAppliedProperties } : {}),
    ...(getAttributes ? { getAttributes } : {}),
  };
};

/**
 * An `update` operation and an `update` action have to exist together: a module
 * that mutates without a declared action would apply an update no permission was
 * ever checked for, and a declared action with nothing to update would refuse a
 * request that changes nothing. Neither is expressible in the type — the
 * operation and the action are separate fields — so it is asserted at
 * definition time, which makes it a boot failure rather than a runtime surprise.
 */
const assertAuthorizationMatchesOperations = <TResource>(
  definition: FormationModuleDefinition<TResource>
): void => {
  const { authorization, resourceType } = definition;
  if ('operatorRegistered' in authorization) return;

  const hasUpdateAction = authorization.update !== undefined;
  const hasUpdateOperation = definition.update !== undefined;
  if (hasUpdateAction === hasUpdateOperation) return;

  throw new Error(
    hasUpdateOperation
      ? `Formation module '${resourceType}' declares an update operation but no authorization.update action`
      : `Formation module '${resourceType}' declares an authorization.update action but no update operation`
  );
};

export const defineFormationModule = <TResource>(
  definition: FormationModuleDefinition<TResource>
): FormationModule => {
  const { resourceType } = definition;
  const resourceLabel = definition.resourceLabel ?? resourceType;
  const schemaName = schemaNameForResourceType(resourceType);
  const basePath = `resources.<${resourceType}>.properties`;
  const log = createDebug(`soat:formations:${resourceType}`);

  const validate = buildValidator({
    definition,
    resourceLabel,
    propertiesLabel: definition.propertiesLabel ?? capitalize(resourceLabel),
    schemaName,
  });

  const assertValid = (args: {
    properties: unknown;
    forUpdate: boolean;
  }): Record<string, unknown> => {
    const errors = validate({
      properties: args.properties,
      basePath,
      forUpdate: args.forUpdate,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }
    return normalizeDeclaredProperties(
      args.properties as Record<string, unknown>
    );
  };

  assertAuthorizationMatchesOperations(definition);

  return {
    resourceType,
    authorization: definition.authorization,

    validateProperties: ({ properties, basePath: hookBasePath }) => {
      return validate({ properties, basePath: hookBasePath, forUpdate: false });
    },

    ...buildOperations({ definition, assertValid, log }),

    read: buildReader({ definition, schemaName }),

    ...buildOptionalMembers(definition),
  };
};
