import { isDeepStrictEqual } from 'node:util';

import type { db } from 'src/db';

import { resolveParamExpressions, resolveRefs } from './formationsHelpers';
import { getFormationModule } from './formationsRegistry';
import type { PlanChange, ResourceDeclaration } from './formationsTypes';

// Resolves a resource's template properties (parameter substitution, then
// ref/sub substitution against already-known physical ids) for use in a plan
// diff. A ref to a not-yet-created resource is left unresolved rather than
// thrown, so the raw expression surfaces in the plan's `desired` payload
// instead of failing the whole plan call.
const resolveParamExpressionsForDiff = (args: {
  decl: ResourceDeclaration;
  resolvedParams: Map<string, string>;
  templateResourceKeys: Set<string>;
  existingMap: Map<string, string>;
}): Record<string, unknown> => {
  const { decl, resolvedParams, templateResourceKeys, existingMap } = args;
  const resolvedProperties = resolveParamExpressions(
    decl.properties ?? {},
    resolvedParams,
    templateResourceKeys
  ) as Record<string, unknown>;
  try {
    return resolveRefs(resolvedProperties, existingMap) as Record<
      string,
      unknown
    >;
  } catch {
    // A ref to a not-yet-created resource stays unresolved — surfacing the
    // raw expression in the diff is more informative than failing the plan.
    return resolvedProperties;
  }
};

// Compares resolved desired-state properties against a known current-state
// snapshot the same way `applyUpdateChange` does at apply time: a property
// resolving to `undefined` (an omitted `use_previous_value` param) is not a
// change, and is filled in from `current` for the returned `desired` diff so
// the plan reflects what will actually be applied.
const diffAgainstCurrent = (args: {
  resolvedProperties: Record<string, unknown>;
  current: Record<string, unknown>;
}): { desired: Record<string, unknown>; changed: boolean } => {
  const { resolvedProperties, current } = args;
  const desired: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resolvedProperties)) {
    if (value === undefined) {
      if (key in current) desired[key] = current[key];
    } else {
      desired[key] = value;
    }
  }
  const changed = Object.entries(desired).some(([key, value]) => {
    return !isDeepStrictEqual(current[key], value);
  });
  return { desired, changed };
};

// Builds the `update` / `no-op` change result for an existing resource by
// diffing its resolved template properties against a known current-state
// snapshot (either a live `read()` or a persisted `lastAppliedProperties`).
const buildComparedChange = (args: {
  logicalId: string;
  decl: ResourceDeclaration;
  physicalResourceId: string;
  resolvedParams: Map<string, string>;
  existingMap: Map<string, string>;
  templateResourceKeys: Set<string>;
  current: Record<string, unknown>;
}): PlanChange => {
  const {
    logicalId,
    decl,
    physicalResourceId,
    resolvedParams,
    existingMap,
    templateResourceKeys,
    current,
  } = args;
  const resolvedProperties = resolveParamExpressionsForDiff({
    decl,
    resolvedParams,
    templateResourceKeys,
    existingMap,
  });
  const { desired, changed } = diffAgainstCurrent({
    resolvedProperties,
    current,
  });
  return {
    logicalId,
    resourceType: decl.type,
    physicalResourceId,
    action: changed ? 'update' : 'no-op',
    diff: { desired, current },
  };
};

export const planResourceChange = async (args: {
  logicalId: string;
  decl: ResourceDeclaration;
  physicalResourceId: string | undefined;
  resolvedParams: Map<string, string>;
  existingMap: Map<string, string>;
  templateResourceKeys: Set<string>;
  lastAppliedProperties?: Record<string, unknown> | null;
}): Promise<PlanChange> => {
  const {
    logicalId,
    decl,
    physicalResourceId,
    resolvedParams,
    existingMap,
    templateResourceKeys,
    lastAppliedProperties,
  } = args;

  if (!physicalResourceId) {
    const desired = resolveParamExpressionsForDiff({
      decl,
      resolvedParams,
      templateResourceKeys,
      existingMap,
    });
    return {
      logicalId,
      resourceType: decl.type,
      action: 'create',
      diff: { desired, current: null },
    };
  }

  // Attempt a property-level diff using the module's read method.
  const module = getFormationModule({ resourceType: decl.type });
  if (module?.read) {
    try {
      const liveProperties = await module.read({ physicalResourceId });
      if (liveProperties !== null) {
        return buildComparedChange({
          logicalId,
          decl,
          physicalResourceId,
          resolvedParams,
          existingMap,
          templateResourceKeys,
          current: liveProperties,
        });
      }

      // `read` returned null. For write-only resources (e.g. secrets, whose
      // value is encrypted at rest) this is expected on every call, not a
      // sign of external deletion — diff against the last-applied snapshot
      // instead, the same source of truth `applyUpdateChange` uses.
      if (module.writeOnly && lastAppliedProperties) {
        return buildComparedChange({
          logicalId,
          decl,
          physicalResourceId,
          resolvedParams,
          existingMap,
          templateResourceKeys,
          current: lastAppliedProperties,
        });
      }
    } catch {
      // read failed — fall through to 'update'
    }
  }

  const desired = resolveParamExpressionsForDiff({
    decl,
    resolvedParams,
    templateResourceKeys,
    existingMap,
  });
  return {
    logicalId,
    resourceType: decl.type,
    physicalResourceId,
    action: 'update',
    diff: { desired, current: null },
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
