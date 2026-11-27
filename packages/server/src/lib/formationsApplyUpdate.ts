/**
 * The update half of a formation apply: the in-place update, the replacement it
 * may turn into, and the disposal of what a replacement superseded.
 *
 * Apart from `formationsApplyHelpers.ts` (create, delete) and
 * `formationsRollback.ts` (the failure unwind): the disposal is a phase of its
 * own, deferred to the end of the operation.
 */

import createDebug from 'debug';
import type { db } from 'src/db';

import {
  isResourceAlreadyGone,
  sanitizeAppliedProperties,
} from './formationsApplyHelpers';
import {
  type DeployedResource,
  propertyComparisonFor,
  writeOnlyAsDeployed,
} from './formationsComparison';
import { mergeWithPrevious } from './formationsProperties';
import { clearablePropertiesOf } from './formationsRegistry';
import {
  applyDeleteResource,
  applyUpdateResource,
} from './formationsResourceHandlers';
import type { AppliedUpdate } from './formationsRollback';
import {
  type FormationActor,
  type FormationEvent,
  formationFailure,
} from './formationsTypes';
import { loggableError } from './loggableError';
import type { StoredError } from './storedError';

const log = createDebug('soat:formations');

type ResourceRow = InstanceType<(typeof db)['FormationResource']>;

/**
 * A physical resource a replacement superseded and that is still to be
 * disposed of.
 */
export type PendingCleanup = {
  resourceRow: ResourceRow;
  logicalId: string;
  resourceType: string;
  physicalResourceId: string;
};

const pendingCleanupIds = (resource: ResourceRow): string[] => {
  const recorded = resource.pendingCleanupPhysicalResourceIds;
  return Array.isArray(recorded) ? recorded : [];
};

/**
 * Writes the superseded id to the ledger *before* the disposal is attempted.
 *
 * The row already points at the replacement, so an id only this operation
 * remembers is one nothing can name again — a crash, a later failure in the
 * same apply, or a handler that refuses the delete would each leave the
 * resource live and unowned. Recorded first, it is retried by the next
 * operation instead.
 */
export const recordPendingCleanup = async (args: {
  resourceRow: ResourceRow;
  physicalResourceId: string;
}): Promise<void> => {
  const recorded = pendingCleanupIds(args.resourceRow);
  if (recorded.includes(args.physicalResourceId)) return;
  await args.resourceRow.update({
    pendingCleanupPhysicalResourceIds: [...recorded, args.physicalResourceId],
  });
};

const clearPendingCleanup = async (args: {
  resourceRow: ResourceRow;
  physicalResourceId: string;
}): Promise<void> => {
  const remaining = pendingCleanupIds(args.resourceRow).filter((id) => {
    return id !== args.physicalResourceId;
  });
  await args.resourceRow.update({
    pendingCleanupPhysicalResourceIds: remaining.length > 0 ? remaining : null,
  });
};

/** The disposals a previous operation recorded and could not complete. */
export const collectRecordedPendingCleanups = (args: {
  existingResources: ResourceRow[];
}): PendingCleanup[] => {
  const pending: PendingCleanup[] = [];
  for (const resource of args.existingResources) {
    for (const physicalResourceId of pendingCleanupIds(resource)) {
      pending.push({
        resourceRow: resource,
        logicalId: resource.logicalId,
        resourceType: resource.resourceType,
        physicalResourceId,
      });
    }
  }
  return pending;
};

export type CleanupFailure = {
  logical_id: string;
  resource_type: string;
  physical_resource_id: string;
  error: StoredError;
};

/**
 * Disposes of every resource a replacement superseded, once the rest of the
 * operation has been applied.
 *
 * Deferred to the end on purpose: the dependents that reference the old
 * resource are re-pointed by their own update, and a type whose delete refuses
 * over live references (`ai_provider` answers `409` while an agent names it, and
 * `force` does not override that) could never be cleaned up while a reference
 * was still standing.
 *
 * A failure is reported and never thrown — the desired state is already
 * realised, so failing the deploy would roll back a replacement that worked. The
 * id stays on the ledger, so the next operation retries it.
 *
 * `deletion_policy: retain` is honoured exactly as on a teardown: the author
 * asked for the old resource to outlive the formation's control of it. It is
 * read from the row at disposal time, so a policy changed by this very operation
 * decides its own replacement.
 */
export const runPendingCleanups = async (args: {
  pendingCleanups: PendingCleanup[];
  projectId: number;
  actor: FormationActor;
  events: FormationEvent[];
}): Promise<CleanupFailure[]> => {
  const { events } = args;
  const failures: CleanupFailure[] = [];

  for (const cleanup of args.pendingCleanups) {
    const { resourceRow, logicalId, resourceType, physicalResourceId } =
      cleanup;

    if ((resourceRow.deletionPolicy ?? 'delete') === 'retain') {
      await clearPendingCleanup({ resourceRow, physicalResourceId });
      events.push({
        timestamp: new Date().toISOString(),
        logicalId,
        resourceType,
        action: 'replace-retained',
        status: 'completed',
        physicalResourceId,
      });
      continue;
    }

    try {
      await applyDeleteResource({
        resourceType,
        physicalResourceId,
        projectId: args.projectId,
        actor: args.actor,
        logicalId,
        resourceKey: resourceRow.publicId,
      });
    } catch (error) {
      if (!isResourceAlreadyGone(error)) {
        const failure = formationFailure(error);
        log(
          'runPendingCleanups: leaked %s id=%s error=%o',
          resourceType,
          physicalResourceId,
          loggableError(failure)
        );
        events.push({
          timestamp: new Date().toISOString(),
          logicalId,
          resourceType,
          action: 'replace-cleanup',
          status: 'failed',
          physicalResourceId,
          error: failure,
        });
        failures.push({
          logical_id: logicalId,
          resource_type: resourceType,
          physical_resource_id: physicalResourceId,
          error: failure,
        });
        continue;
      }
    }

    await clearPendingCleanup({ resourceRow, physicalResourceId });
    events.push({
      timestamp: new Date().toISOString(),
      logicalId,
      resourceType,
      action: 'replace-cleanup',
      status: 'completed',
      physicalResourceId,
    });
  }

  return failures;
};

/** Persists a successful update on the ledger row and records its event. */
const recordAppliedUpdate = async (args: {
  resourceRow: ResourceRow;
  resourceType: string;
  logicalId: string;
  mergedProperties: Record<string, unknown>;
  physicalResourceId: string;
  replaced: boolean;
  events: FormationEvent[];
}): Promise<void> => {
  const { resourceRow, resourceType, logicalId, replaced } = args;
  await resourceRow.update({
    status: 'updated',
    ...(replaced ? { physicalResourceId: args.physicalResourceId } : {}),
    lastAppliedProperties: sanitizeAppliedProperties(
      resourceType,
      args.mergedProperties
    ),
  });
  args.events.push({
    timestamp: new Date().toISOString(),
    logicalId,
    resourceType,
    action: replaced ? 'replace' : 'update',
    status: 'completed',
    physicalResourceId: args.physicalResourceId,
  });
};

// Shared with `plan-formation`, so the preview and the apply it previews
// never disagree about whether a resource changed.
const mergeWithLastApplied = (args: {
  existing: ResourceRow;
  resourceType: string;
  resolvedProperties: Record<string, unknown>;
  deployed: DeployedResource | undefined;
}): ReturnType<typeof mergeWithPrevious> & {
  lastApplied: Record<string, unknown>;
  /** The write-only properties `merged` sends, at the value the last deploy left. */
  previousWriteOnly: Record<string, unknown>;
} => {
  const lastApplied = (args.existing.lastAppliedProperties ?? {}) as Record<
    string,
    unknown
  >;
  const merge = mergeWithPrevious({
    resolved: args.resolvedProperties,
    previous: lastApplied,
    lastApplied,
    clearable: clearablePropertiesOf(args.resourceType),
    comparison: propertyComparisonFor({
      declared: {
        type: args.resourceType,
        properties: args.resolvedProperties,
      },
      deployed: args.deployed,
    }),
  });
  const asDeployed = writeOnlyAsDeployed({
    resourceType: args.resourceType,
    deployed: args.deployed,
  });
  const previousWriteOnly = Object.fromEntries(
    Object.entries(asDeployed).filter(([name]) => {
      return name in merge.merged;
    })
  );
  return { ...merge, lastApplied, previousWriteOnly };
};

const deferDisposal = async (args: {
  pendingCleanups: PendingCleanup[];
  cleanup: PendingCleanup;
}): Promise<void> => {
  await recordPendingCleanup({
    resourceRow: args.cleanup.resourceRow,
    physicalResourceId: args.cleanup.physicalResourceId,
  });
  args.pendingCleanups.push(args.cleanup);
};

export const applyUpdateChange = async (args: {
  resourceRow: ResourceRow;
  existing: ResourceRow & { physicalResourceId: string };
  resourceType: string;
  resolvedProperties: Record<string, unknown>;
  logicalId: string;
  projectId: number;
  actor: FormationActor;
  resolvedIds: Map<string, string>;
  events: FormationEvent[];
  /** Collects the disposal a replacement here defers to the end of the apply. */
  pendingCleanups: PendingCleanup[];
  /** This resource in the formation's last deploy. */
  deployed: DeployedResource | undefined;
}): Promise<AppliedUpdate | null> => {
  const { resourceRow, existing, resourceType, logicalId } = args;
  const { resolvedProperties, projectId, actor, resolvedIds, events } = args;
  const { merged: mergedProperties, ...merge } = mergeWithLastApplied({
    existing,
    resourceType,
    resolvedProperties,
    deployed: args.deployed,
  });
  // `resourceRow` is `existing` here, so the update below mutates it — reading
  // the previous id afterwards would hand the replacement's own id to the
  // disposal meant to remove what it superseded.
  const previousPhysicalResourceId = existing.physicalResourceId;
  const previousStatus = existing.status;

  resolvedIds.set(logicalId, previousPhysicalResourceId);
  if (merge.changed) {
    const outcome = await applyUpdateResource({
      resourceType,
      physicalResourceId: previousPhysicalResourceId,
      resolvedProperties: mergedProperties,
      projectId,
      actor,
      logicalId,
      resourceKey: resourceRow.publicId,
    });

    const physicalResourceId =
      outcome?.replacedWithPhysicalResourceId ?? previousPhysicalResourceId;
    const replaced = physicalResourceId !== previousPhysicalResourceId;

    if (replaced) {
      // Every `{ref}` to this resource, and the output resolution that follows,
      // must see the replacement — the old id is about to stop existing.
      resolvedIds.set(logicalId, physicalResourceId);
    }

    await recordAppliedUpdate({
      resourceRow,
      resourceType,
      logicalId,
      mergedProperties: merge.snapshot,
      physicalResourceId,
      replaced,
      events,
    });

    if (replaced) {
      await deferDisposal({
        pendingCleanups: args.pendingCleanups,
        cleanup: {
          resourceRow,
          logicalId,
          resourceType,
          physicalResourceId: previousPhysicalResourceId,
        },
      });
    }
    return {
      previousPhysicalResourceId,
      previousStatus,
      previousProperties: merge.lastApplied,
      previousWriteOnly: merge.previousWriteOnly,
      ...(replaced
        ? { replacementPhysicalResourceId: physicalResourceId }
        : {}),
    };
  }
  events.push({
    timestamp: new Date().toISOString(),
    logicalId,
    resourceType,
    action: 'no-op',
    status: 'completed',
    physicalResourceId: previousPhysicalResourceId,
  });
  return null;
};
