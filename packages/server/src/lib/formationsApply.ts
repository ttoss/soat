import createDebug from 'debug';
import { db } from 'src/db';

import {
  applyCreateChange,
  applyUpdateChange,
  failFormationOperation,
  isCreateChange,
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
  projectId: number;
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
          projectId: args.projectId,
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
  // At the top of the pipeline, so the diff and the `lastAppliedProperties`
  // snapshot are keyed the way the module's `read()` reports them — a camelCase
  // template used to compare its own keys against a snake_case read (#901).
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
        projectId: args.projectId,
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

// In dependency order. On the first failure it unwinds what this operation
// created and returns false, so the caller stops before finalizing.
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
      const rollbackEvents = await rollbackCreatedResources({
        created,
        projectId: args.projectId,
      });
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
  projectId: number;
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
    args.resolvedIds,
    args.projectId
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
    projectId: args.projectId,
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
    projectId: args.projectId,
  });
  log('applyFormationTemplate: succeeded formationId=%s', formation.publicId);
};
