/**
 * Helper functions for formation application.
 * Handles resource creation, update, and deletion during formation application.
 */

import createDebug from 'debug';
import type { db } from 'src/db';
import { DomainError } from 'src/errors';

import { mergeWithPrevious } from './formationsProperties';
import { getFormationModule } from './formationsRegistry';
import {
  applyCreateResource,
  applyDeleteResource,
  applyUpdateResource,
} from './formationsResourceHandlers';
import { buildFormationError, type FormationEvent } from './formationsTypes';

const log = createDebug('soat:formations');

type ResourceRow = InstanceType<(typeof db)['FormationResource']>;

/**
 * Whether applying this logical id creates a resource rather than updating one.
 *
 * A previously deleted logical id keeps its row and a stale
 * `physicalResourceId`, so without this it would diff as an update against a
 * resource that is gone. Shared with the authorization pre-flight, which has to
 * ask for the same action the engine is about to perform.
 */
export const isCreateChange = (existing: ResourceRow | undefined): boolean => {
  return (
    !existing || existing.status === 'deleted' || !existing.physicalResourceId
  );
};

/**
 * A resource the platform was asked to remove but that is already gone counts
 * as removed — both teardown and the apply unwind treat it as an idempotent
 * success rather than a blocker.
 */
export const isResourceAlreadyGone = (error: unknown): boolean => {
  return error instanceof DomainError && error.code === 'RESOURCE_NOT_FOUND';
};

/**
 * Records one resource as removed. Shared by the two paths that remove
 * resources — a template update orphaning one, and a full teardown — so both
 * write the same ledger status and the same event.
 */
export const markResourceDeleted = async (args: {
  resource: InstanceType<(typeof db)['FormationResource']>;
  events: FormationEvent[];
}): Promise<void> => {
  const { resource, events } = args;
  await resource.update({ status: 'deleted' });
  events.push({
    timestamp: new Date().toISOString(),
    logicalId: resource.logicalId,
    resourceType: resource.resourceType,
    action: 'delete',
    status: 'succeeded',
    physicalResourceId: resource.physicalResourceId ?? undefined,
  });
};

const sanitize = (
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> => {
  const mod = getFormationModule({ resourceType });
  return mod?.sanitizeLastAppliedProperties
    ? mod.sanitizeLastAppliedProperties(properties)
    : properties;
};

export const applyCreateChange = async (args: {
  resourceRow: ResourceRow;
  resourceType: string;
  resolvedProperties: Record<string, unknown>;
  projectId: number;
  actingUserId: number;
  logicalId: string;
  resolvedIds: Map<string, string>;
  events: FormationEvent[];
}): Promise<void> => {
  const {
    resourceRow,
    resourceType,
    resolvedProperties,
    projectId,
    actingUserId,
    logicalId,
    resolvedIds,
    events,
  } = args;
  const physicalId = await applyCreateResource({
    resourceType,
    resolvedProperties,
    projectId,
    actingUserId,
    logicalId,
    resourceKey: resourceRow.publicId,
  });
  resolvedIds.set(logicalId, physicalId);
  await resourceRow.update({
    physicalResourceId: physicalId,
    status: 'created',
    lastAppliedProperties: sanitize(resourceType, resolvedProperties),
  });
  events.push({
    timestamp: new Date().toISOString(),
    logicalId,
    resourceType,
    action: 'create',
    status: 'succeeded',
    physicalResourceId: physicalId,
  });
};

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
    lastAppliedProperties: sanitize(resourceType, args.mergedProperties),
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

/**
 * Walks back the resources this operation created, newest first.
 *
 * An apply that stopped at the first failure left everything it had already
 * created live and unmanaged (#999), so a corrected re-apply could collide with
 * it. Reversing `sortedOrder` is the order `deleteFormation` uses, so a
 * dependency is only removed after its dependents.
 *
 * Only creates are unwound — an update has no prior state to restore without a
 * snapshot. A `deletion_policy: 'retain'` resource is skipped entirely rather
 * than tombstoned: keeping its row pointing at the surviving resource is what
 * lets a corrected re-apply adopt it instead of duplicating it.
 */
export const rollbackCreatedResources = async (args: {
  created: ResourceRow[];
  projectId: number;
  actingUserId: number;
}): Promise<FormationEvent[]> => {
  const events: FormationEvent[] = [];

  for (const resource of [...args.created].reverse()) {
    if (!resource.physicalResourceId) continue;
    if (resource.deletionPolicy === 'retain') {
      events.push({
        timestamp: new Date().toISOString(),
        logicalId: resource.logicalId,
        resourceType: resource.resourceType,
        action: 'rollback-skipped',
        status: 'succeeded',
        physicalResourceId: resource.physicalResourceId,
      });
      continue;
    }
    try {
      await applyDeleteResource({
        resourceType: resource.resourceType,
        physicalResourceId: resource.physicalResourceId,
        projectId: args.projectId,
        actingUserId: args.actingUserId,
        logicalId: resource.logicalId,
        resourceKey: resource.publicId,
      });
    } catch (error) {
      if (!isResourceAlreadyGone(error)) {
        // Reported, never thrown: the original failure is the one the operator
        // needs to see, and re-throwing here would bury it.
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(
          'rollbackCreatedResources: failed logicalId=%s error=%s',
          resource.logicalId,
          errorMsg
        );
        events.push({
          timestamp: new Date().toISOString(),
          logicalId: resource.logicalId,
          resourceType: resource.resourceType,
          action: 'rollback',
          status: 'failed',
          physicalResourceId: resource.physicalResourceId,
          error: errorMsg,
        });
        continue;
      }
    }
    // The row is tombstoned rather than dropped, so the failed operation's
    // history still names what was created and then walked back. A tombstone
    // also makes the next apply treat the logical id as a fresh create.
    await resource.update({ status: 'deleted' });
    events.push({
      timestamp: new Date().toISOString(),
      logicalId: resource.logicalId,
      resourceType: resource.resourceType,
      action: 'rollback',
      status: 'succeeded',
      physicalResourceId: resource.physicalResourceId,
    });
  }

  return events;
};

export const failFormationOperation = async (args: {
  operation: InstanceType<(typeof db)['FormationOperation']>;
  formation: InstanceType<(typeof db)['Formation']>;
  events: FormationEvent[];
  logicalId: string;
  resourceType: string;
  action: 'create' | 'update';
  errorMessage: string;
  /** `formationErrorCode(thrown)` — the code the failure is reported under. */
  errorCode: string;
  /**
   * Events produced by the unwind that this failure triggered. They are
   * appended *after* the failure event so the operation history reads in the
   * order it happened — the original error first, then what was walked back
   * because of it. The error the operator has to act on stays the one that
   * broke the apply.
   */
  rollbackEvents?: FormationEvent[];
}): Promise<void> => {
  args.events.push({
    timestamp: new Date().toISOString(),
    logicalId: args.logicalId,
    resourceType: args.resourceType,
    action: args.action,
    status: 'failed',
    error: args.errorMessage,
  });
  if (args.rollbackEvents) args.events.push(...args.rollbackEvents);
  // The same bag on both records: the operation is the history, the formation
  // is what the deploy response returns, and a caller reading either gets the
  // failure in the platform's `{ code, message, meta }` shape (#1028).
  const error = buildFormationError({
    code: args.errorCode,
    message: args.errorMessage,
    meta: { logical_id: args.logicalId, resource_type: args.resourceType },
  });
  await args.operation.update({
    status: 'failed',
    events: args.events,
    error,
  });
  await args.formation.update({ status: 'failed', error });
};
