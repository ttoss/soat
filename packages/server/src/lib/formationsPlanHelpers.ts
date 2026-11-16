import type { db } from 'src/db';

import { resolveParamExpressions, resolveRefs } from './formationsHelpers';
import {
  mergeWithPrevious,
  normalizeDeclaredProperties,
} from './formationsProperties';
import {
  clearablePropertiesOf,
  getFormationModule,
} from './formationsRegistry';
import type { PlanChange, ResourceDeclaration } from './formationsTypes';

// A ref to a not-yet-created resource is left unresolved rather than thrown, so
// the raw expression surfaces in the plan's `desired` payload instead of
// failing the whole call.
const resolveParamExpressionsForDiff = (args: {
  decl: ResourceDeclaration;
  resolvedParams: Map<string, string>;
  templateResourceKeys: Set<string>;
  existingMap: Map<string, string>;
}): Record<string, unknown> => {
  const { decl, resolvedParams, templateResourceKeys, existingMap } = args;
  const resolvedProperties = normalizeDeclaredProperties(
    resolveParamExpressions(
      decl.properties ?? {},
      resolvedParams,
      templateResourceKeys
    ) as Record<string, unknown>
  );
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
  lastApplied: Record<string, unknown>;
}): PlanChange => {
  const {
    logicalId,
    decl,
    physicalResourceId,
    resolvedParams,
    existingMap,
    templateResourceKeys,
    current,
    lastApplied,
  } = args;
  const resolvedProperties = resolveParamExpressionsForDiff({
    decl,
    resolvedParams,
    templateResourceKeys,
    existingMap,
  });
  // The same predicate apply runs, not a restatement of it: a plan that
  // decides "changed" differently from the apply it previews is a lie.
  const { merged: desired, changed } = mergeWithPrevious({
    resolved: resolvedProperties,
    previous: current,
    lastApplied,
    clearable: clearablePropertiesOf(decl.type),
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
  projectId: number;
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

  const compare = (current: Record<string, unknown>): PlanChange => {
    return buildComparedChange({
      ...args,
      physicalResourceId,
      current,
      lastApplied: lastAppliedProperties ?? {},
    });
  };

  // Attempt a property-level diff using the module's read method.
  const module = getFormationModule({ resourceType: decl.type });
  if (module?.read) {
    try {
      const liveProperties = await module.read({
        physicalResourceId,
        projectId: args.projectId,
      });
      if (liveProperties !== null) return compare(liveProperties);

      // For a write-only resource a null `read` is expected on every call, not
      // external deletion — diff against the last-applied snapshot instead,
      // the same source of truth `applyUpdateChange` uses.
      if (module.writeOnly && lastAppliedProperties) {
        return compare(lastAppliedProperties);
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

// Ledger resources the new template no longer declares are deleted on the next
// `update-formation`, so surfacing them keeps `plan` and `update` reporting the
// same set. Tombstoned rows are excluded, or a resource removed in a prior
// deploy would keep showing up as pending.
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
