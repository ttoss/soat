import { isDeepStrictEqual } from 'node:util';

import type { db } from 'src/db';

import { resolveParamExpressions, resolveRefs } from './formationsHelpers';
import { getFormationModule } from './formationsRegistry';
import type { PlanChange, ResourceDeclaration } from './formationsTypes';

export const planResourceChange = async (args: {
  logicalId: string;
  decl: ResourceDeclaration;
  physicalResourceId: string | undefined;
  resolvedParams: Map<string, string>;
  existingMap: Map<string, string>;
  templateResourceKeys: Set<string>;
}): Promise<PlanChange> => {
  const {
    logicalId,
    decl,
    physicalResourceId,
    resolvedParams,
    existingMap,
    templateResourceKeys,
  } = args;

  if (!physicalResourceId) {
    return { logicalId, resourceType: decl.type, action: 'create' };
  }

  // Attempt a property-level diff using the module's read method.
  const module = getFormationModule({ resourceType: decl.type });
  if (module?.read) {
    try {
      const liveProperties = await module.read({ physicalResourceId });
      if (liveProperties !== null) {
        let resolvedProperties = resolveParamExpressions(
          decl.properties ?? {},
          resolvedParams,
          templateResourceKeys
        ) as Record<string, unknown>;
        try {
          // Substitute physical ids of already-created resources so an
          // unchanged ref/sub property diffs as a no-op.
          resolvedProperties = resolveRefs(
            resolvedProperties,
            existingMap
          ) as Record<string, unknown>;
        } catch {
          // A ref to a not-yet-created resource stays unresolved — the raw
          // expression never equals the live value, so this reports 'update',
          // which is the conservative answer.
        }

        const needsUpdate = Object.entries(resolvedProperties).some(
          ([key, value]) => {
            // A `use_previous_value` param that was omitted resolves to
            // undefined; it never counts as a change since the stored value
            // is reused.
            if (value === undefined) return false;
            return !isDeepStrictEqual(liveProperties[key], value);
          }
        );

        return {
          logicalId,
          resourceType: decl.type,
          physicalResourceId,
          action: needsUpdate ? 'update' : 'no-op',
        };
      }
    } catch {
      // read failed — fall through to 'update'
    }
  }

  return {
    logicalId,
    resourceType: decl.type,
    physicalResourceId,
    action: 'update',
  };
};

// Resources tracked by the ledger that the new template no longer declares
// are about to be orphaned/deleted on the next `update-formation` — surfacing
// them as `delete` plan changes keeps `plan` and `update` reporting the same
// set. Rows already tombstoned (status 'deleted') are excluded so a resource
// removed in a prior deploy doesn't keep showing up as a pending delete.
export const computeOrphanedPlanChanges = (args: {
  templateResourceKeys: Set<string>;
  existingResources: InstanceType<(typeof db)['FormationResource']>[];
}): PlanChange[] => {
  const { templateResourceKeys, existingResources } = args;
  return existingResources
    .filter((r) => {
      return (
        !templateResourceKeys.has(r.logicalId) &&
        r.physicalResourceId &&
        r.status !== 'deleted'
      );
    })
    .map((r) => {
      return {
        logicalId: r.logicalId,
        resourceType: r.resourceType,
        physicalResourceId: r.physicalResourceId!,
        action: 'delete' as const,
      };
    });
};
