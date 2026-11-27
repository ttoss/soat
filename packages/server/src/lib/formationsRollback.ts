/**
 * The unwind of a failed deploy: every change the operation applied is walked
 * back, newest first, so the stack ends as it was before the deploy.
 */

import createDebug from 'debug';
import type { db } from 'src/db';

import { isResourceAlreadyGone } from './formationsApplyHelpers';
import { propertyComparisonFor } from './formationsComparison';
import { mergeWithPrevious } from './formationsProperties';
import { clearablePropertiesOf } from './formationsRegistry';
import {
  applyDeleteResource,
  applyUpdateResource,
} from './formationsResourceHandlers';
import {
  type FormationActor,
  type FormationEvent,
  formationFailure,
} from './formationsTypes';
import { loggableError } from './loggableError';

const log = createDebug('soat:formations');

type ResourceRow = InstanceType<(typeof db)['FormationResource']>;

/** What an applied update overwrote, enough to put it back. */
export type AppliedUpdate = {
  previousPhysicalResourceId: string;
  previousStatus: string;
  previousProperties: Record<string, unknown>;
  /**
   * Each write-only property the update sent, at the value the last deploy
   * left; one that deploy cannot resolve is absent, so it is never settled.
   */
  previousWriteOnly: Record<string, unknown>;
  /** Set when the update replaced the resource instead of changing it. */
  replacementPhysicalResourceId?: string;
};

/** A change one operation made, in the order it made them. */
export type AppliedChange =
  | { kind: 'create'; resourceRow: ResourceRow }
  | { kind: 'update'; resourceRow: ResourceRow; update: AppliedUpdate };

type Unwind = {
  resourceRow: ResourceRow;
  projectId: number;
  actor: FormationActor;
};

const event = (
  resourceRow: ResourceRow,
  fields: Pick<FormationEvent, 'action' | 'status' | 'physicalResourceId'> &
    Partial<Pick<FormationEvent, 'error'>>
): FormationEvent => {
  return {
    timestamp: new Date().toISOString(),
    logicalId: resourceRow.logicalId,
    resourceType: resourceRow.resourceType,
    ...fields,
  };
};

const deleteTolerant = async (
  args: Unwind & { physicalResourceId: string }
): Promise<void> => {
  try {
    await applyDeleteResource({
      resourceType: args.resourceRow.resourceType,
      physicalResourceId: args.physicalResourceId,
      projectId: args.projectId,
      actor: args.actor,
      logicalId: args.resourceRow.logicalId,
      resourceKey: args.resourceRow.publicId,
    });
  } catch (error) {
    if (!isResourceAlreadyGone(error)) throw error;
  }
};

/**
 * A `deletion_policy: 'retain'` create is skipped rather than tombstoned:
 * keeping its row pointing at the surviving resource lets a corrected re-apply
 * adopt it instead of duplicating it. A walked-back create is tombstoned, so
 * the history still names it and the next apply treats it as a fresh create.
 */
const unwindCreate = async (args: Unwind): Promise<FormationEvent> => {
  const { resourceRow } = args;
  // A row joins the applied list only once its create returned.
  const physicalResourceId = resourceRow.physicalResourceId!;
  if (resourceRow.deletionPolicy === 'retain') {
    return event(resourceRow, {
      action: 'rollback-skipped',
      status: 'completed',
      physicalResourceId,
    });
  }
  await deleteTolerant({ ...args, physicalResourceId });
  await resourceRow.update({ status: 'deleted' });
  return event(resourceRow, {
    action: 'rollback',
    status: 'completed',
    physicalResourceId,
  });
};

/**
 * What re-applying the overwritten properties sends: a property the update set
 * and the previous state lacked is cleared by the same rule a template that
 * drops it follows, since an absent field leaves the stored value alone. A
 * write-only property is never stored, so it is re-sent from the last deploy.
 */
const restoreProperties = (args: {
  resourceRow: ResourceRow;
  update: AppliedUpdate;
}): Record<string, unknown> => {
  return mergeWithPrevious({
    resolved: {
      ...args.update.previousProperties,
      ...args.update.previousWriteOnly,
    },
    previous: {},
    lastApplied: args.resourceRow.lastAppliedProperties ?? {},
    clearable: clearablePropertiesOf(args.resourceRow.resourceType),
    comparison: propertyComparisonFor({
      declared: {
        type: args.resourceRow.resourceType,
        properties: args.update.previousProperties,
      },
      deployed: undefined,
    }),
  }).merged;
};

/**
 * A replacement is deleted and the row pointed back at what it superseded,
 * which a failed deploy never disposes of. An in-place update is re-applied
 * with the properties it overwrote.
 */
const unwindUpdate = async (
  args: Unwind & { update: AppliedUpdate }
): Promise<FormationEvent> => {
  const { resourceRow, update } = args;
  const previousId = update.previousPhysicalResourceId;
  const replacement = update.replacementPhysicalResourceId;
  if (replacement !== undefined) {
    if (resourceRow.deletionPolicy === 'retain') {
      return event(resourceRow, {
        action: 'rollback-skipped',
        status: 'completed',
        physicalResourceId: replacement,
      });
    }
    await deleteTolerant({ ...args, physicalResourceId: replacement });
  } else {
    const outcome = await applyUpdateResource({
      resourceType: resourceRow.resourceType,
      physicalResourceId: previousId,
      resolvedProperties: restoreProperties({ resourceRow, update }),
      projectId: args.projectId,
      actor: args.actor,
      logicalId: resourceRow.logicalId,
      resourceKey: resourceRow.publicId,
    });
    const restoredAs = outcome?.replacedWithPhysicalResourceId;
    if (restoredAs !== undefined && restoredAs !== previousId) {
      // The restore itself replaced the resource: the row follows it, and the
      // id it superseded is left for the next operation to dispose of.
      await resourceRow.update({
        status: update.previousStatus,
        physicalResourceId: restoredAs,
        lastAppliedProperties: update.previousProperties,
        pendingCleanupPhysicalResourceIds: [
          ...(resourceRow.pendingCleanupPhysicalResourceIds ?? []),
          previousId,
        ],
      });
      return event(resourceRow, {
        action: 'rollback',
        status: 'completed',
        physicalResourceId: restoredAs,
      });
    }
  }
  const pending = (resourceRow.pendingCleanupPhysicalResourceIds ?? []).filter(
    (id) => {
      return id !== previousId;
    }
  );
  await resourceRow.update({
    status: update.previousStatus,
    physicalResourceId: previousId,
    lastAppliedProperties: update.previousProperties,
    pendingCleanupPhysicalResourceIds: pending.length > 0 ? pending : null,
  });
  return event(resourceRow, {
    action: 'rollback',
    status: 'completed',
    physicalResourceId: previousId,
  });
};

/**
 * Walks back every change this operation applied, newest first.
 *
 * Reversing the apply order removes or restores a dependent before what it
 * references, so no restored resource is left pointing at a removed one. A
 * failed unwind is reported, never thrown: the original failure is the one the
 * operator needs to see, and the row keeps naming the live resource.
 */
export const rollbackAppliedChanges = async (args: {
  applied: AppliedChange[];
  projectId: number;
  actor: FormationActor;
}): Promise<FormationEvent[]> => {
  const events: FormationEvent[] = [];
  for (const change of [...args.applied].reverse()) {
    const unwind = {
      resourceRow: change.resourceRow,
      projectId: args.projectId,
      actor: args.actor,
    };
    try {
      events.push(
        change.kind === 'create'
          ? await unwindCreate(unwind)
          : await unwindUpdate({ ...unwind, update: change.update })
      );
    } catch (error) {
      const failure = formationFailure(error);
      log(
        'rollbackAppliedChanges: failed logicalId=%s error=%o',
        change.resourceRow.logicalId,
        loggableError(failure)
      );
      events.push(
        event(change.resourceRow, {
          action: 'rollback',
          status: 'failed',
          physicalResourceId:
            change.resourceRow.physicalResourceId ?? undefined,
          error: failure,
        })
      );
    }
  }
  return events;
};
