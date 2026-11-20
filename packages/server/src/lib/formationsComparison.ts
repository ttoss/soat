/**
 * How `plan-formation` and apply decide whether a declared property differs
 * from what the resource holds: an empty (`null`) property and an absent one
 * are the same, the type's schema defaults fill both sides, and a write-only
 * property the resource cannot read back is settled when its declaration is the
 * one the formation last deployed.
 */

import { isDeepStrictEqual } from 'node:util';

import { holdsFormationExpression } from './formation-modules/formationSpecLoader';
import { normalizeDeclaredProperties } from './formationsProperties';
import { getFormationModule } from './formationsRegistry';
import type { ResourceDeclaration } from './formationsTypes';

export type PropertyComparison = {
  /** Both sides of the comparison pass through this before they are compared. */
  comparable: (properties: Record<string, unknown>) => Record<string, unknown>;
  /** Properties that compare equal whatever the other side holds. */
  settled: ReadonlySet<string>;
};

/**
 * The write-only properties whose declaration equals, as a literal, the one the
 * formation last deployed: the value the resource holds is that one, though no
 * read returns it. One holding an expression may resolve differently, so it is
 * never settled.
 */
const settledWriteOnlyProperties = (args: {
  declared: ResourceDeclaration;
  deployed: ResourceDeclaration | undefined;
}): ReadonlySet<string> => {
  const { declared, deployed } = args;
  const names =
    getFormationModule({ resourceType: declared.type })?.writeOnlyProperties ??
    [];
  if (names.length === 0 || deployed?.type !== declared.type) return new Set();

  const now = normalizeDeclaredProperties(declared.properties ?? {});
  const before = normalizeDeclaredProperties(deployed.properties ?? {});
  return new Set(
    names.filter((name) => {
      return (
        now[name] !== undefined &&
        !holdsFormationExpression(now[name]) &&
        isDeepStrictEqual(now[name], before[name])
      );
    })
  );
};

/**
 * A read leaves an empty property out, so a top-level `null` compares as
 * absent. Not for a write-only property: no read returns it, so absent there
 * says nothing about whether it holds a value.
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
          Object.entries(properties).filter(([key, value]) => {
            return value !== null || writeOnly.has(key);
          })
        )
      );
    },
    settled: args.settled,
  };
};

/**
 * The comparison for one declared resource. `deployed` is its declaration in
 * the template the formation last deployed, `undefined` when there is none.
 */
export const propertyComparisonFor = (args: {
  declared: ResourceDeclaration;
  deployed: ResourceDeclaration | undefined;
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
