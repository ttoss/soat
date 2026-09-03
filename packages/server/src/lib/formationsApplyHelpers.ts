/**
 * Helper functions for formation application.
 * Handles resource creation, update, and deletion during formation application.
 */

import createDebug from 'debug';
import type { db } from 'src/db';
import { DomainError } from 'src/errors';

import { getFormationModule } from './formationsRegistry';
import {
  applyCreateResource,
  applyDeleteResource,
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

/** The snapshot shape a module wants persisted, when it narrows it. */
export const sanitizeAppliedProperties = (
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
    lastAppliedProperties: sanitizeAppliedProperties(
      resourceType,
      resolvedProperties
    ),
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
