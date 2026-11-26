/**
 * How `plan-formation` and apply decide whether a declared property differs
 * from what the resource holds: an empty (`null`) field and an absent one are
 * the same at every depth, the type's defaults fill both sides, and a write-only
 * property the resource cannot read back is settled when it resolves to the
 * value the formation last deployed.
 */

import { isDeepStrictEqual } from 'node:util';

import {
  holdsFormationExpression,
  isObjectRecord,
} from './formation-modules/formationSpecLoader';
import {
  collectParamRefs,
  resolveParamExpressions,
  resolveRefs,
} from './formationsHelpers';
import { resolveParameterValues } from './formationsParameters';
import { normalizeDeclaredProperties } from './formationsProperties';
import { getFormationModule } from './formationsRegistry';
import type { FormationTemplate, ResourceDeclaration } from './formationsTypes';

export type PropertyComparison = {
  /** Both sides of the comparison pass through this before they are compared. */
  comparable: (properties: Record<string, unknown>) => Record<string, unknown>;
  /** Properties that compare equal whatever the other side holds. */
  settled: ReadonlySet<string>;
};

/** One resource of the formation's last successful deploy, and what it resolved from. */
export type DeployedResource = {
  declaration: ResourceDeclaration;
  template: FormationTemplate;
  /** The deploy's `resolved_parameters`: `no_echo` values masked. */
  parameters: Record<string, string> | null;
  /** The physical id each resource held when that deploy ended. */
  physicalIds: ReadonlyMap<string, string>;
};

export const deployedResourceOf = (args: {
  formation: {
    template: unknown;
    resolvedParameters: Record<string, string> | null;
  };
  logicalId: string;
  physicalIds: ReadonlyMap<string, string>;
}): DeployedResource | undefined => {
  const template = args.formation.template as FormationTemplate | null;
  const declaration = template?.resources[args.logicalId];
  if (!template || !declaration) return undefined;
  return {
    declaration,
    template,
    parameters: args.formation.resolvedParameters,
    physicalIds: args.physicalIds,
  };
};

/**
 * `value`, from the deployed declaration, as that deploy resolved it; `undefined`
 * when a parameter it reads is masked or was not recorded, or a ref names a
 * resource the deploy did not leave.
 */
const resolvedAsDeployed = (args: {
  value: unknown;
  deployed: DeployedResource;
}): unknown => {
  const { template, parameters, physicalIds } = args.deployed;
  const logicalIds = new Set(Object.keys(template.resources));
  const used = collectParamRefs(args.value).filter((name) => {
    return !logicalIds.has(name);
  });
  const recorded = used.every((name) => {
    return (
      template.parameters?.[name] !== undefined &&
      template.parameters[name].no_echo !== true &&
      parameters?.[name] !== undefined
    );
  });
  if (!recorded) return undefined;
  try {
    const values = resolveParameterValues(
      template,
      Object.fromEntries(
        used.map((name) => {
          return [name, parameters?.[name] ?? ''];
        })
      )
    );
    return resolveRefs(
      resolveParamExpressions(args.value, values, logicalIds),
      new Map(physicalIds)
    );
  } catch {
    return undefined;
  }
};

/**
 * Each write-only property of `resourceType` the formation's last deploy
 * declared, as that deploy resolved it; one it cannot resolve is left out.
 * What the resource holds after that deploy, though no read returns it.
 */
export const writeOnlyAsDeployed = (args: {
  resourceType: string;
  deployed: DeployedResource | undefined;
}): Record<string, unknown> => {
  const { deployed } = args;
  const names =
    getFormationModule({ resourceType: args.resourceType })
      ?.writeOnlyProperties ?? [];
  if (names.length === 0 || deployed?.declaration.type !== args.resourceType) {
    return {};
  }
  const before = normalizeDeclaredProperties(
    deployed.declaration.properties ?? {}
  );
  return Object.fromEntries(
    names.flatMap((name) => {
      if (before[name] === undefined) return [];
      const value = resolvedAsDeployed({ value: before[name], deployed });
      return value === undefined ? [] : [[name, value]];
    })
  );
};

/**
 * The write-only properties whose resolved declaration equals the value the
 * formation last deployed. `declared` carries resolved values; one still
 * holding an expression is never settled.
 */
const settledWriteOnlyProperties = (args: {
  declared: ResourceDeclaration;
  deployed: DeployedResource | undefined;
}): ReadonlySet<string> => {
  const asDeployed = writeOnlyAsDeployed({
    resourceType: args.declared.type,
    deployed: args.deployed,
  });
  const now = normalizeDeclaredProperties(args.declared.properties ?? {});
  return new Set(
    Object.keys(asDeployed).filter((name) => {
      return (
        now[name] !== undefined &&
        !holdsFormationExpression(now[name]) &&
        isDeepStrictEqual(now[name], asDeployed[name])
      );
    })
  );
};

/** `value` with every `null` object field dropped, at every depth. */
const withoutNullFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutNullFields);
  if (!isObjectRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => {
        return field !== null;
      })
      .map(([key, field]) => {
        return [key, withoutNullFields(field)];
      })
  );
};

/**
 * A read may leave an empty field out or hold it `null`, at any depth, so a
 * `null` field compares as absent. Not a top-level write-only property: no read
 * returns it, so absent there says nothing about whether it holds a value.
 */
export const buildPropertyComparison = (args: {
  withSchemaDefaults: (
    properties: Record<string, unknown>
  ) => Record<string, unknown>;
  writeOnlyProperties: readonly string[];
  settled: ReadonlySet<string>;
}): PropertyComparison => {
  const writeOnly = new Set(args.writeOnlyProperties);
  return {
    comparable: (properties) => {
      return args.withSchemaDefaults(
        Object.fromEntries(
          Object.entries(properties)
            .filter(([key, value]) => {
              return value !== null || writeOnly.has(key);
            })
            .map(([key, value]) => {
              return [key, withoutNullFields(value)];
            })
        )
      );
    },
    settled: args.settled,
  };
};

/**
 * The comparison for one declared resource, whose `properties` are resolved.
 * `deployed` is the resource in the formation's last deploy, `undefined` when
 * there is none.
 */
export const propertyComparisonFor = (args: {
  declared: ResourceDeclaration;
  deployed: DeployedResource | undefined;
}): PropertyComparison => {
  const module = getFormationModule({ resourceType: args.declared.type });
  return buildPropertyComparison({
    withSchemaDefaults: (properties) => {
      return module ? module.withSchemaDefaults(properties) : properties;
    },
    writeOnlyProperties: module?.writeOnlyProperties ?? [],
    settled: settledWriteOnlyProperties(args),
  });
};
