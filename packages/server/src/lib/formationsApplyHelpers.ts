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
import type { FormationEvent } from './formationsTypes';

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
  resolvedIds.set(logicalId, existing.physicalResourceId);
  if (propertiesChanged) {
    await applyUpdateResource({
      resourceType,
      physicalResourceId: existing.physicalResourceId,
      resolvedProperties: mergedProperties,
    });
    await resourceRow.update({
      status: 'updated',
      lastAppliedProperties: sanitize(resourceType, mergedProperties),
    });
    events.push({
      timestamp: new Date().toISOString(),
      logicalId,
      resourceType,
      action: 'update',
      status: 'succeeded',
      physicalResourceId: existing.physicalResourceId,
    });
  } else {
    events.push({
      timestamp: new Date().toISOString(),
      logicalId,
      resourceType,
      action: 'no-op',
      status: 'succeeded',
      physicalResourceId: existing.physicalResourceId,
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
  await args.operation.update({
    status: 'failed',
    events: args.events,
    error: { message: args.errorMessage, logicalId: args.logicalId },
  });
  await args.formation.update({ status: 'failed' });
};
