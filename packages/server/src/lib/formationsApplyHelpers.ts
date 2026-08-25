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

type ResourceRow = InstanceType<(typeof db)['FormationResource']>;

export const applyCreateChange = async (args: {
  resourceRow: ResourceRow;
  resourceType: string;
  resolvedProperties: Record<string, unknown>;
  projectId: number;
  logicalId: string;
  resolvedIds: Map<string, string>;
  events: FormationEvent[];
}): Promise<void> => {
  const {
    resourceRow,
    resourceType,
    resolvedProperties,
    projectId,
    logicalId,
    resolvedIds,
    events,
  } = args;
  const physicalId = await applyCreateResource({
    resourceType,
    resolvedProperties,
    projectId,
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
 * Removes the resource a replacement superseded.
 *
 * The replacement already succeeded and the row already points at the new
 * resource, so this is cleanup, not part of the update: a failure here is
 * recorded as a failed event and the deploy carries on. Throwing instead would
 * fail a deploy whose desired state is fully realised, and roll back a
 * replacement that worked — leaving the caller worse off than the leaked
 * resource does.
 *
 * `deletion_policy: retain` is honoured exactly as it is on a teardown: the
 * author asked for the old resource to outlive the formation's control of it.
 */
const disposeReplacedResource = async (args: {
  resourceType: string;
  logicalId: string;
  replacedPhysicalResourceId: string;
  resourceKey: string;
  deletionPolicy: string;
  events: FormationEvent[];
}): Promise<void> => {
  const { events } = args;
  const timestamp = () => {
    return new Date().toISOString();
  };

  if (args.deletionPolicy === 'retain') {
    events.push({
      timestamp: timestamp(),
      logicalId: args.logicalId,
      resourceType: args.resourceType,
      action: 'replace-retained',
      status: 'succeeded',
      physicalResourceId: args.replacedPhysicalResourceId,
    });
    return;
  }

  try {
    await applyDeleteResource({
      resourceType: args.resourceType,
      physicalResourceId: args.replacedPhysicalResourceId,
      logicalId: args.logicalId,
      resourceKey: args.resourceKey,
    });
    events.push({
      timestamp: timestamp(),
      logicalId: args.logicalId,
      resourceType: args.resourceType,
      action: 'replace-cleanup',
      status: 'succeeded',
      physicalResourceId: args.replacedPhysicalResourceId,
    });
  } catch (error) {
    if (isResourceAlreadyGone(error)) return;
    const message = error instanceof Error ? error.message : String(error);
    log(
      'disposeReplacedResource: leaked %s id=%s error=%s',
      args.resourceType,
      args.replacedPhysicalResourceId,
      message
    );
    events.push({
      timestamp: timestamp(),
      logicalId: args.logicalId,
      resourceType: args.resourceType,
      action: 'replace-cleanup',
      status: 'failed',
      physicalResourceId: args.replacedPhysicalResourceId,
      error: message,
    });
  }
};

export const applyUpdateChange = async (args: {
  resourceRow: ResourceRow;
  existing: ResourceRow & { physicalResourceId: string };
  resourceType: string;
  resolvedProperties: Record<string, unknown>;
  logicalId: string;
  resolvedIds: Map<string, string>;
  events: FormationEvent[];
}): Promise<void> => {
  const {
    resourceRow,
    existing,
    resourceType,
    resolvedProperties,
    logicalId,
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
  // Captured before the row is written: on this path `resourceRow` *is*
  // `existing`, so `resourceRow.update` below mutates the instance — reading
  // the previous id off it afterwards would hand the replacement's own id to
  // the disposal that is meant to remove the resource it superseded.
  const previousPhysicalResourceId = existing.physicalResourceId;

  resolvedIds.set(logicalId, previousPhysicalResourceId);
  if (propertiesChanged) {
    const outcome = await applyUpdateResource({
      resourceType,
      physicalResourceId: previousPhysicalResourceId,
      resolvedProperties: mergedProperties,
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

    await resourceRow.update({
      status: 'updated',
      ...(replaced ? { physicalResourceId } : {}),
      lastAppliedProperties: sanitize(resourceType, mergedProperties),
    });
    events.push({
      timestamp: new Date().toISOString(),
      logicalId,
      resourceType,
      action: replaced ? 'replace' : 'update',
      status: 'succeeded',
      physicalResourceId,
    });

    if (replaced) {
      await disposeReplacedResource({
        resourceType,
        logicalId,
        replacedPhysicalResourceId: previousPhysicalResourceId,
        resourceKey: resourceRow.publicId,
        deletionPolicy: resourceRow.deletionPolicy ?? 'delete',
        events,
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
 * An apply that stops at the first failure used to leave every resource it had
 * already created live and unmanaged (#999): the formation was `failed`, but
 * the provider, memory and tools it had provisioned were still there, and a
 * corrected re-apply could collide with them. Reversing `sortedOrder` is the
 * same order `deleteFormation` tears a stack down in, so a dependency is only
 * removed after its dependents.
 *
 * Only creates are unwound. An update that already succeeded has no prior state
 * to restore without a pre-update snapshot, so its resource is left as it is.
 *
 * A `deletion_policy: 'retain'` resource is skipped entirely — not tombstoned
 * the way `deleteFormation` does it. The physical resource survives either way,
 * and keeping its row pointing at it is what lets a corrected re-apply adopt it
 * instead of provisioning a duplicate alongside it.
 */
export const rollbackCreatedResources = async (args: {
  created: ResourceRow[];
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
