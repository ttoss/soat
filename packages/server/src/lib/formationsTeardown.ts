/**
 * Stack teardown: the delete order, the pre-flight, the deletions, and the
 * failure report.
 *
 * Split out of `formationsApply.ts` (which is about *applying* a template) and
 * `formations.ts` (CRUD and planning), both of which were at their line ceiling.
 * Teardown is a phase of its own with one entry point, `deleteFormation`, and the
 * pieces here exist only to serve it.
 */
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';
import { DomainError } from 'src/errors';

import {
  collectRecordedPendingCleanups,
  isResourceAlreadyGone,
  markResourceDeleted,
  runPendingCleanups,
} from './formationsApplyHelpers';
import {
  assertResourceActionsAuthorized,
  collectTeardownAuthorizationRequests,
} from './formationsAuthorization';
import { buildDependencyGraph, topologicalSort } from './formationsHelpers';
import {
  applyDeleteResource,
  findResourceDeletionBlocker,
} from './formationsResourceHandlers';
import {
  buildFormationError,
  type FormationAuthorizer,
  type FormationEvent,
  type FormationTemplate,
} from './formationsTypes';

const log = createDebug('soat:formations');

type ResourceRow = InstanceType<(typeof db)['FormationResource']>;

/**
 * Reverse dependency order, with anything the template no longer declares
 * appended — an orphaned resource still has to be torn down.
 */
export const buildDeleteOrder = (
  template: FormationTemplate | null,
  existingResources: ResourceRow[]
): ResourceRow[] => {
  let deleteOrder: string[] = [];
  if (template?.resources) {
    const graph = buildDependencyGraph(template);
    const sorted = topologicalSort(graph);
    if (sorted) deleteOrder = [...sorted].reverse();
  }

  const resourceMap = new Map(
    existingResources.map((r) => {
      return [r.logicalId, r];
    })
  );
  const ordered: ResourceRow[] = [];

  for (const logicalId of deleteOrder) {
    const r = resourceMap.get(logicalId);
    if (r) ordered.push(r);
  }
  for (const r of existingResources) {
    if (!deleteOrder.includes(r.logicalId)) ordered.push(r);
  }

  return ordered;
};

/**
 * Asks every resource due for deletion whether it would refuse, deleting
 * nothing.
 *
 * Teardown is ordered and not transactional, so a refusal discovered by
 * attempting a delete leaves everything ordered ahead of it destroyed — the
 * unrecoverable partial teardown #985 reported. Asking first turns that into a
 * teardown that fails having changed nothing.
 *
 * Only predictable refusals are reported: a `retain` resource is never deleted,
 * one with no physical id has nothing to delete, and a type declaring no
 * blocker contributes nothing. So this never invents a failure the delete would
 * not have hit — it can only miss one, which falls through as before.
 */
export const collectDeletionBlockers = async (
  orderedResources: ResourceRow[]
): Promise<FormationEvent[]> => {
  const blocked: FormationEvent[] = [];

  for (const resource of orderedResources) {
    if (!resource.physicalResourceId) continue;
    if (resource.deletionPolicy === 'retain') continue;

    const blocker = await findResourceDeletionBlocker({
      resourceType: resource.resourceType,
      physicalResourceId: resource.physicalResourceId,
    });
    if (blocker === null) continue;

    log(
      'collectDeletionBlockers: blocked logicalId=%s type=%s',
      resource.logicalId,
      resource.resourceType
    );
    blocked.push({
      timestamp: new Date().toISOString(),
      logicalId: resource.logicalId,
      resourceType: resource.resourceType,
      action: 'delete',
      status: 'failed',
      physicalResourceId: resource.physicalResourceId,
      error: blocker,
    });
  }

  return blocked;
};

export const performResourceDeletions = async (args: {
  orderedResources: ResourceRow[];
  projectId: number;
  actingUserId: number;
}): Promise<{ events: FormationEvent[]; hasError: boolean }> => {
  const events: FormationEvent[] = [];
  let hasError = false;

  // A replacement whose disposal failed earlier is swept with the stack (#1193)
  // — it is the last operation that will ever name it. Its failure is recorded
  // but never fails the teardown: the resource is already outside the ledger's
  // current state, and wedging the stack in `delete_failed` over one would
  // leave the caller unable to remove anything at all.
  await runPendingCleanups({
    pendingCleanups: collectRecordedPendingCleanups({
      existingResources: args.orderedResources,
    }),
    projectId: args.projectId,
    actingUserId: args.actingUserId,
    events,
  });

  for (const resource of args.orderedResources) {
    if (!resource.physicalResourceId) continue;
    try {
      if (resource.deletionPolicy !== 'retain') {
        await applyDeleteResource({
          resourceType: resource.resourceType,
          physicalResourceId: resource.physicalResourceId,
          projectId: args.projectId,
          actingUserId: args.actingUserId,
          logicalId: resource.logicalId,
          resourceKey: resource.publicId,
        });
      }
      await markResourceDeleted({ resource, events });
    } catch (error) {
      if (isResourceAlreadyGone(error)) {
        await markResourceDeleted({ resource, events });
        continue;
      }
      hasError = true;
      const errorMsg = error instanceof Error ? error.message : String(error);
      events.push({
        timestamp: new Date().toISOString(),
        logicalId: resource.logicalId,
        resourceType: resource.resourceType,
        action: 'delete',
        status: 'failed',
        error: errorMsg,
      });
    }
  }

  return { events, hasError };
};

/**
 * Reports a teardown that could not finish, naming every resource that blocked.
 *
 * A partial teardown is the case that most needs an explanation: the resources
 * already deleted are gone, so a bare `success: false` left the operator with no
 * way to learn which resource blocked — nor that resolving it and deleting again
 * is all that stands between them and a clean stack.
 */
export const buildDeletionFailure = (args: {
  formationId: string;
  events: FormationEvent[];
  /**
   * True when the blockers were found by the pre-flight, so no resource was
   * touched. The failure list and error code are identical either way — a client
   * reads one shape — but the operator needs to know whether the stack they are
   * about to retry is still whole.
   */
  intact?: boolean;
}): DomainError => {
  const failures = args.events
    .filter((event) => {
      return event.status === 'failed';
    })
    .map((event) => {
      return {
        logical_id: event.logicalId,
        resource_type: event.resourceType,
        error: event.error ?? null,
      };
    });

  const named = failures
    .map((failure) => {
      return `${failure.logical_id} (${failure.resource_type})`;
    })
    .join(', ');

  const outcome = args.intact
    ? `No resource was deleted — the formation is unchanged and still 'active'. Resolve these and delete it again.`
    : `The formation is left in 'delete_failed'; resolve these and delete it again.`;

  return new DomainError(
    'FORMATION_DELETE_FAILED',
    `Formation '${args.formationId}' could not be fully deleted; ${String(failures.length)} resource(s) could not be removed: ${named}. ${outcome}`,
    { failures }
  );
};

/** `buildDeletionFailure`, for the callers that have nothing left to record. */
export const throwDeletionFailure = (args: {
  formationId: string;
  events: FormationEvent[];
  intact?: boolean;
}): never => {
  throw buildDeletionFailure(args);
};

/**
 * Tears the stack down in reverse dependency order.
 *
 * Resolves only when every resource is gone. A blocker throws
 * `FORMATION_DELETE_FAILED` naming it; whether the stack survives depends on when
 * the blocker was found:
 *
 * - A **predictable** refusal (an agent with generation history) is caught by the
 *   pre-flight, which deletes nothing — the formation stays `active` and the
 *   whole stack is intact to retry.
 * - Anything else surfaces mid-teardown, where the resources already removed stay
 *   removed and the formation is left in `delete_failed`.
 */
export const deleteFormation = async (args: {
  id: string;
  authorize: FormationAuthorizer;
  actingUserId: number;
}): Promise<{ success: true }> => {
  const formation = await db.Formation.findOne({
    where: { publicId: args.id, status: { [Op.ne]: 'deleted' } },
  });
  if (!formation)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Formation '${args.id}' not found.`
    );

  const existingResources = await db.FormationResource.findAll({
    where: { formationId: formation.id as number },
  });

  const orderedResources = buildDeleteOrder(
    formation.template as FormationTemplate | null,
    existingResources
  );

  // A teardown is a delete per resource, so it needs the delete action for each
  // — the same per-resource check an apply runs (#1181). Ahead of the deletion
  // pre-flight, since a refusal here is about the caller, not the stack.
  await assertResourceActionsAuthorized({
    authorize: args.authorize,
    requests: collectTeardownAuthorizationRequests({ existingResources }),
  });

  // Before anything is destroyed: teardown is ordered and not transactional, so
  // a blocker found mid-way leaves the resources ahead of it gone for good.
  const blockers = await collectDeletionBlockers(orderedResources);
  if (blockers.length > 0) {
    throwDeletionFailure({
      formationId: args.id,
      events: blockers,
      intact: true,
    });
  }

  await formation.update({ status: 'deleting' });

  const operation = await db.FormationOperation.create({
    formationId: formation.id as number,
    operationType: 'delete',
    status: 'running',
    events: null,
    plan: null,
    error: null,
  });

  const { events, hasError } = await performResourceDeletions({
    orderedResources,
    projectId: formation.projectId,
    actingUserId: args.actingUserId,
  });

  if (hasError) {
    // A wedged stack answers `409` here, but the row survives the request — so
    // the same failure is stored, and a later `get-formation` explains the
    // `delete_failed` it reports instead of just naming it (#1028).
    const failure = buildDeletionFailure({ formationId: args.id, events });
    const error = buildFormationError({
      code: failure.code,
      message: failure.message,
      ...(failure.meta !== undefined ? { meta: failure.meta } : {}),
    });
    await operation.update({ status: 'failed', events, error });
    await formation.update({ status: 'delete_failed', error });
    throw failure;
  }

  await operation.update({ status: 'succeeded', events });
  await formation.update({
    status: 'deleted',
    name: `${formation.name}__deleted__${formation.publicId}`,
  });
  return { success: true };
};
