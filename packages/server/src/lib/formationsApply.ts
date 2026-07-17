import createDebug from 'debug';
import { db } from 'src/db';
import { DomainError } from 'src/errors';

import {
  applyCreateChange,
  applyUpdateChange,
  failFormationOperation,
} from './formationsApplyHelpers';
import {
  buildAuditableParameters,
  buildDependencyGraph,
  resolveRefs,
  resolveWorkingTemplate,
  topologicalSort,
} from './formationsHelpers';
import {
  resolveFormationMetadata,
  resolveFormationOutputs,
} from './formationsResolve';
import { applyDeleteResource } from './formationsResourceHandlers';
import type {
  FormationEvent,
  FormationTemplate,
  ResourceDeclaration,
} from './formationsTypes';

const log = createDebug('soat:formations');

const isResourceAlreadyGone = (error: unknown): boolean => {
  return error instanceof DomainError && error.code === 'RESOURCE_NOT_FOUND';
};

const markResourceDeleted = async (args: {
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
}): Promise<void> => {
  const {
    logicalId,
    decl,
    existing,
    resolvedIds,
    events,
    projectId,
    formationId,
  } = args;
  const resolvedProperties = resolveRefs(
    decl.properties,
    resolvedIds
  ) as Record<string, unknown>;
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
};

// Applies each resource change in dependency order. Returns true on success;
// on the first failure it records the failed operation and returns false so the
// caller stops before finalizing.
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
  for (const logicalId of sortedOrder) {
    const decl = workingTemplate.resources[logicalId];
    const existing = existingMap.get(logicalId);
    try {
      await processResourceChange({
        logicalId,
        decl,
        existing,
        resolvedIds: args.resolvedIds,
        events,
        projectId: args.projectId,
        formationId: args.formationId,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(
        'applyFormationTemplate: failed logicalId=%s error=%s',
        logicalId,
        errorMsg
      );
      await failFormationOperation({
        operation: args.operation,
        formation: args.formation,
        events,
        logicalId,
        resourceType: decl.type,
        action: existing ? 'update' : 'create',
        errorMessage: errorMsg,
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

export const buildDeleteOrder = (
  template: FormationTemplate | null,
  existingResources: InstanceType<(typeof db)['FormationResource']>[]
): InstanceType<(typeof db)['FormationResource']>[] => {
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
  const ordered: InstanceType<(typeof db)['FormationResource']>[] = [];

  for (const logicalId of deleteOrder) {
    const r = resourceMap.get(logicalId);
    if (r) ordered.push(r);
  }
  for (const r of existingResources) {
    if (!deleteOrder.includes(r.logicalId)) ordered.push(r);
  }

  return ordered;
};

export const performResourceDeletions = async (
  orderedResources: InstanceType<(typeof db)['FormationResource']>[]
): Promise<{ events: FormationEvent[]; hasError: boolean }> => {
  const events: FormationEvent[] = [];
  let hasError = false;

  for (const resource of orderedResources) {
    if (!resource.physicalResourceId) continue;
    try {
      if (resource.deletionPolicy !== 'retain') {
        await applyDeleteResource({
          resourceType: resource.resourceType,
          physicalResourceId: resource.physicalResourceId,
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
