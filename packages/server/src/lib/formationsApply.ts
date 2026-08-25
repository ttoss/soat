import createDebug from 'debug';
import { db } from 'src/db';

import {
  applyCreateChange,
  applyUpdateChange,
  failFormationOperation,
  isResourceAlreadyGone,
  markResourceDeleted,
  rollbackCreatedResources,
} from './formationsApplyHelpers';
import {
  buildAuditableParameters,
  buildDependencyGraph,
  resolveRefs,
  resolveWorkingTemplate,
  topologicalSort,
} from './formationsHelpers';
import { normalizeDeclaredProperties } from './formationsProperties';
import {
  resolveFormationMetadata,
  resolveFormationOutputs,
} from './formationsResolve';
import { applyDeleteResource } from './formationsResourceHandlers';
import {
  formationErrorCode,
  type FormationEvent,
  type FormationTemplate,
  type ResourceDeclaration,
} from './formationsTypes';

const log = createDebug('soat:formations');

export const handleOrphanedDeletes = async (args: {
  template: FormationTemplate;
  existingResources: InstanceType<(typeof db)['FormationResource']>[];
  events: FormationEvent[];
}): Promise<void> => {
  const { template, existingResources, events } = args;
  const newLogicalIds = new Set(Object.keys(template.resources));
  const toDelete = existingResources.filter((r) => {
    return (
      !newLogicalIds.has(r.logicalId) &&
      r.physicalResourceId &&
      r.status !== 'deleted'
    );
  });
  for (const resource of toDelete) {
    try {
      if (resource.deletionPolicy !== 'retain') {
        await applyDeleteResource({
          resourceType: resource.resourceType,
          physicalResourceId: resource.physicalResourceId!,
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
};

type ResourceRow = InstanceType<(typeof db)['FormationResource']>;

// A logical id that was previously deleted must be treated as a fresh
// create, even though its FormationResource row (and stale
// physicalResourceId) still exists — otherwise it would be diffed as an
// update against a physical resource that no longer exists.
const isCreateChange = (existing: ResourceRow | undefined): boolean => {
  return (
    !existing || existing.status === 'deleted' || !existing.physicalResourceId
  );
};

export const processResourceChange = async (args: {
  logicalId: string;
  decl: ResourceDeclaration;
  existing: ResourceRow | undefined;
  resolvedIds: Map<string, string>;
  events: FormationEvent[];
  projectId: number;
  formationId: number;
}): Promise<ResourceRow> => {
  const {
    logicalId,
    decl,
    existing,
    resolvedIds,
    events,
    projectId,
    formationId,
  } = args;
  // Normalized here, at the top of the apply pipeline, so the merge diff and
  // the `lastAppliedProperties` snapshot below are keyed the same way the
  // module's `read()` reports them — a camelCase template used to store camel
  // keys and then compare them against a snake_case read forever after (#901).
  const resolvedProperties = normalizeDeclaredProperties(
    resolveRefs(decl.properties, resolvedIds) as Record<string, unknown>
  );
  log('processResourceChange: logicalId=%s type=%s', logicalId, decl.type);

  const deletionPolicy = decl.deletion_policy ?? 'delete';

  let resourceRow: ResourceRow;
  if (!existing) {
    resourceRow = await db.FormationResource.create({
      formationId,
      logicalId,
      resourceType: decl.type,
      status: 'pending',
      physicalResourceId: null,
      lastAppliedProperties: null,
      deletionPolicy,
    });
  } else {
    if ((existing.deletionPolicy ?? 'delete') !== deletionPolicy) {
      await existing.update({ deletionPolicy });
    }
    resourceRow = existing;
  }

  try {
    if (isCreateChange(existing)) {
      await applyCreateChange({
        resourceRow,
        resourceType: decl.type,
        resolvedProperties,
        projectId,
        logicalId,
        resolvedIds,
        events,
      });
    } else {
      const existingWithId = existing as ResourceRow & {
        physicalResourceId: string;
      };
      await applyUpdateChange({
        resourceRow,
        existing: existingWithId,
        resourceType: decl.type,
        resolvedProperties,
        logicalId,
        resolvedIds,
        events,
      });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(
      'processResourceChange: error for logicalId=%s error=%s',
      logicalId,
      errorMsg
    );
    await resourceRow.update({
      status: 'failed',
    });
    throw error;
  }

  return resourceRow;
};

// Applies each resource change in dependency order. Returns true on success;
// on the first failure it unwinds the resources it created in this operation,
// records the failed operation and returns false so the caller stops before
// finalizing.
const runResourceChanges = async (args: {
  sortedOrder: string[];
  workingTemplate: FormationTemplate;
  existingMap: Map<string, ResourceRow>;
  resolvedIds: Map<string, string>;
  events: FormationEvent[];
  projectId: number;
  formationId: number;
  formation: InstanceType<(typeof db)['Formation']>;
  operation: InstanceType<(typeof db)['FormationOperation']>;
}): Promise<boolean> => {
  const { sortedOrder, workingTemplate, existingMap, events } = args;
  const created: ResourceRow[] = [];
  for (const logicalId of sortedOrder) {
    const decl = workingTemplate.resources[logicalId];
    const existing = existingMap.get(logicalId);
    const isCreate = isCreateChange(existing);
    try {
      const resourceRow = await processResourceChange({
        logicalId,
        decl,
        existing,
        resolvedIds: args.resolvedIds,
        events,
        projectId: args.projectId,
        formationId: args.formationId,
      });
      if (isCreate) created.push(resourceRow);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(
        'applyFormationTemplate: failed logicalId=%s error=%s',
        logicalId,
        errorMsg
      );
      const rollbackEvents = await rollbackCreatedResources({ created });
      await failFormationOperation({
        operation: args.operation,
        formation: args.formation,
        events,
        logicalId,
        resourceType: decl.type,
        action: existing ? 'update' : 'create',
        errorMessage: errorMsg,
        errorCode: formationErrorCode(error),
        rollbackEvents,
      });
      return false;
    }
  }
  return true;
};

// Persists a successful apply: resolves outputs, top-level metadata, and the
// auditable parameter set, then flips the formation to `active`.
const finalizeSucceededFormation = async (args: {
  formation: InstanceType<(typeof db)['Formation']>;
  template: FormationTemplate;
  workingTemplate: FormationTemplate;
  parameters?: Record<string, string>;
  operation: InstanceType<(typeof db)['FormationOperation']>;
  events: FormationEvent[];
  resolvedIds: Map<string, string>;
}): Promise<void> => {
  const {
    formation,
    template,
    workingTemplate,
    parameters,
    operation,
    events,
  } = args;
  const outputs = await resolveFormationOutputs(
    workingTemplate,
    args.resolvedIds
  );
  await operation.update({ status: 'succeeded', events });
  await formation.update({
    status: 'active',
    // A deploy that succeeds retires the previous failure: `error` describes
    // the current status, not the stack's history (that is what the operation
    // list is for).
    error: null,
    outputs,
    template,
    resolvedMetadata: resolveFormationMetadata(
      workingTemplate,
      args.resolvedIds
    ),
    resolvedParameters: buildAuditableParameters(template, parameters),
  });
};

export const applyFormationTemplate = async (args: {
  formation: InstanceType<(typeof db)['Formation']>;
  template: FormationTemplate;
  existingResources: InstanceType<(typeof db)['FormationResource']>[];
  projectId: number;
  operation: InstanceType<(typeof db)['FormationOperation']>;
  parameters?: Record<string, string>;
}): Promise<void> => {
  const { formation, template, existingResources, operation, parameters } =
    args;
  const workingTemplate = resolveWorkingTemplate({ template, parameters });

  const graph = buildDependencyGraph(workingTemplate);
  const sortedOrder = topologicalSort(graph)!;
  const existingMap = new Map(
    existingResources.map((r) => {
      return [r.logicalId, r];
    })
  );
  const resolvedIds = new Map<string, string>();
  const formationId = (formation as unknown as { id: number }).id;

  for (const [lid, existing] of existingMap.entries())
    if (!isCreateChange(existing) && workingTemplate.resources[lid])
      resolvedIds.set(lid, existing.physicalResourceId!);

  const events: FormationEvent[] = [];
  log(
    'applyFormationTemplate: start formationId=%s resources=%d',
    formation.publicId,
    sortedOrder.length
  );

  const ok = await runResourceChanges({
    sortedOrder,
    workingTemplate,
    existingMap,
    resolvedIds,
    events,
    projectId: args.projectId,
    formationId,
    formation,
    operation,
  });
  if (!ok) return;

  await handleOrphanedDeletes({
    template: workingTemplate,
    existingResources,
    events,
  });

  await finalizeSucceededFormation({
    formation,
    template,
    workingTemplate,
    parameters,
    operation,
    events,
    resolvedIds,
  });
  log('applyFormationTemplate: succeeded formationId=%s', formation.publicId);
};
