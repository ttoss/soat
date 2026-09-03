/**
 * The update half of a formation apply: the in-place update, the replacement it
 * may turn into, and the disposal of what a replacement superseded.
 *
 * Split from `formationsApplyHelpers.ts`, which owns create, delete and the
 * failure unwind — the disposal is a phase of its own, deferred to the end of
 * the operation (#1194), and the two halves share only the ledger predicates.
 */

import createDebug from 'debug';
import type { db } from 'src/db';

import {
  isResourceAlreadyGone,
  sanitizeAppliedProperties,
} from './formationsApplyHelpers';
import { mergeWithPrevious } from './formationsProperties';
import {
  applyDeleteResource,
  applyUpdateResource,
} from './formationsResourceHandlers';
import type { FormationEvent } from './formationsTypes';

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
 * resource live and unowned (#1193). Recorded first, it is retried by the next
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
  error: string;
};

/**
 * Disposes of every resource a replacement superseded, once the rest of the
 * operation has been applied.
 *
 * Deferred to the end on purpose (#1194): the dependents that reference the old
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
  actingUserId: number;
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
        status: 'succeeded',
        physicalResourceId,
      });
      continue;
    }

    try {
      await applyDeleteResource({
        resourceType,
        physicalResourceId,
        projectId: args.projectId,
        actingUserId: args.actingUserId,
        logicalId,
        resourceKey: resourceRow.publicId,
      });
    } catch (error) {
      if (!isResourceAlreadyGone(error)) {
        const message = error instanceof Error ? error.message : String(error);
        log(
          'runPendingCleanups: leaked %s id=%s error=%s',
          resourceType,
          physicalResourceId,
          message
        );
        events.push({
          timestamp: new Date().toISOString(),
          logicalId,
          resourceType,
          action: 'replace-cleanup',
          status: 'failed',
          physicalResourceId,
          error: message,
        });
        failures.push({
          logical_id: logicalId,
          resource_type: resourceType,
          physical_resource_id: physicalResourceId,
          error: message,
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
      status: 'succeeded',
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
    status: 'succeeded',
    physicalResourceId: args.physicalResourceId,
  });
};

export const applyUpdateChange = async (args: {
  resourceRow: ResourceRow;
  existing: ResourceRow & { physicalResourceId: string };
  resourceType: string;
  resolvedProperties: Record<string, unknown>;
  logicalId: string;
  projectId: number;
  actingUserId: number;
  resolvedIds: Map<string, string>;
  events: FormationEvent[];
  /** Collects the disposal a replacement here defers to the end of the apply. */
  pendingCleanups: PendingCleanup[];
}): Promise<void> => {
  const {
    resourceRow,
    existing,
    resourceType,
    resolvedProperties,
    logicalId,
    projectId,
    actingUserId,
    resolvedIds,
    events,
  } = args;
  const lastProps = (existing.lastAppliedProperties ?? {}) as Record<
    string,
    unknown
  >;
  // Shared with `plan-formation`, so the preview and the apply it previews can
  // no longer disagree about whether a resource changed (#902).
  const { merged: mergedProperties, changed: propertiesChanged } =
    mergeWithPrevious({ resolved: resolvedProperties, previous: lastProps });
  // `resourceRow` is `existing` here, so the update below mutates it — reading
  // the previous id afterwards would hand the replacement's own id to the
  // disposal meant to remove what it superseded.
  const previousPhysicalResourceId = existing.physicalResourceId;

  resolvedIds.set(logicalId, previousPhysicalResourceId);
  if (propertiesChanged) {
    const outcome = await applyUpdateResource({
      resourceType,
      physicalResourceId: previousPhysicalResourceId,
      resolvedProperties: mergedProperties,
      projectId,
      actingUserId,
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
      mergedProperties,
      physicalResourceId,
      replaced,
      events,
    });

    if (replaced) {
      await recordPendingCleanup({
        resourceRow,
        physicalResourceId: previousPhysicalResourceId,
      });
      args.pendingCleanups.push({
        resourceRow,
        logicalId,
        resourceType,
        physicalResourceId: previousPhysicalResourceId,
      });
    }
  } else {
    events.push({
      timestamp: new Date().toISOString(),
      logicalId,
      resourceType,
      action: 'no-op',
      status: 'succeeded',
      physicalResourceId: previousPhysicalResourceId,
    });
  }
};
