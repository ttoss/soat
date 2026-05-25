import createDebug from 'debug';
import { db } from 'src/db';

import {
  applyCreateChange,
  applyUpdateChange,
  failFormationOperation,
} from './formationsApplyHelpers';
import {
  buildDependencyGraph,
  buildResolvedParamsMap,
  isRefAttr,
  parseRefAttr,
  resolveParamExpressions,
  resolveRefs,
  topologicalSort,
} from './formationsHelpers';
import { getFormationModule } from './formationsRegistry';
import { applyDeleteResource } from './formationsResourceHandlers';
import type {
  FormationEvent,
  FormationTemplate,
  ResourceDeclaration,
} from './formationsTypes';

const log = createDebug('soat:formations');

const resolveRefAttrOutput = async (
  refAttrStr: string,
  template: FormationTemplate,
  resolvedIds: Map<string, string>
): Promise<string | undefined> => {
  const parsed = parseRefAttr(refAttrStr);
  if (!parsed) {
    log(
      'resolveFormationOutputs: skipping ref_attr "%s" — missing dot separator',
      refAttrStr
    );
    return undefined;
  }
  const { logicalId, attrName } = parsed;
  const physicalId = resolvedIds.get(logicalId);
  if (physicalId === undefined) {
    log(
      'resolveFormationOutputs: skipping ref_attr "%s" — no physical ID for "%s"',
      refAttrStr,
      logicalId
    );
    return undefined;
  }
  const resourceType = template.resources[logicalId]?.type;
  if (!resourceType) return undefined;
  const mod = getFormationModule({ resourceType });
  if (!mod?.getAttributes) {
    log(
      'resolveFormationOutputs: skipping ref_attr "%s" — resource type "%s" has no getAttributes',
      refAttrStr,
      resourceType
    );
    return undefined;
  }
  const attrs = await mod.getAttributes({
    physicalResourceId: physicalId,
  });
  if (typeof attrs[attrName] !== 'string') {
    log(
      'resolveFormationOutputs: skipping ref_attr "%s" — attribute "%s" not found in resource "%s"',
      refAttrStr,
      attrName,
      logicalId
    );
    return undefined;
  }
  return attrs[attrName];
};

export const resolveFormationOutputs = async (
  template: FormationTemplate,
  resolvedIds: Map<string, string>
): Promise<Record<string, string>> => {
  const outputs: Record<string, string> = {};
  if (!template.outputs) return outputs;
  for (const [outputName, outputValue] of Object.entries(template.outputs)) {
    try {
      if (isRefAttr(outputValue)) {
        const value = await resolveRefAttrOutput(
          outputValue.ref_attr,
          template,
          resolvedIds
        );
        if (value !== undefined) outputs[outputName] = value;
      } else {
        const resolved = resolveRefs(outputValue, resolvedIds);
        if (typeof resolved === 'string') outputs[outputName] = resolved;
      }
    } catch {
      // Skip unresolvable outputs
    }
  }
  return outputs;
};

export const handleOrphanedDeletes = async (args: {
  template: FormationTemplate;
  existingResources: InstanceType<(typeof db)['FormationResource']>[];
  events: FormationEvent[];
}): Promise<void> => {
  const { template, existingResources, events } = args;
  const newLogicalIds = new Set(Object.keys(template.resources));
  const toDelete = existingResources.filter((r) => {
    return !newLogicalIds.has(r.logicalId) && r.physicalResourceId;
  });
  for (const resource of toDelete) {
    try {
      if (resource.deletionPolicy === 'retain') {
        await resource.update({ status: 'deleted' });
        events.push({
          timestamp: new Date().toISOString(),
          logicalId: resource.logicalId,
          resourceType: resource.resourceType,
          action: 'delete',
          status: 'succeeded',
          physicalResourceId: resource.physicalResourceId ?? undefined,
        });
        continue;
      }
      await applyDeleteResource({
        resourceType: resource.resourceType,
        physicalResourceId: resource.physicalResourceId!,
      });
      await resource.update({ status: 'deleted' });
      events.push({
        timestamp: new Date().toISOString(),
        logicalId: resource.logicalId,
        resourceType: resource.resourceType,
        action: 'delete',
        status: 'succeeded',
        physicalResourceId: resource.physicalResourceId ?? undefined,
      });
    } catch (error) {
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
    if (!existing || !existing.physicalResourceId) {
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

/* eslint-disable-next-line max-lines-per-function */
export const applyFormationTemplate = async (args: {
  formation: InstanceType<(typeof db)['Formation']>;
  template: FormationTemplate;
  existingResources: InstanceType<(typeof db)['FormationResource']>[];
  projectId: number;
  operation: InstanceType<(typeof db)['FormationOperation']>;
  parameters?: Record<string, string>;
}): Promise<void> => {
  const {
    formation,
    template,
    existingResources,
    projectId,
    operation,
    parameters,
  } = args;
  const resolvedParamsMap = buildResolvedParamsMap(template, parameters);
  const workingTemplate =
    resolvedParamsMap.size > 0
      ? (resolveParamExpressions(
          template,
          resolvedParamsMap
        ) as FormationTemplate)
      : template;

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
    if (existing.physicalResourceId && workingTemplate.resources[lid])
      resolvedIds.set(lid, existing.physicalResourceId);

  const events: FormationEvent[] = [];
  log(
    'applyFormationTemplate: start formationId=%s resources=%d',
    formation.publicId,
    sortedOrder.length
  );

  for (const logicalId of sortedOrder) {
    const decl = workingTemplate.resources[logicalId];
    const existing = existingMap.get(logicalId);
    try {
      await processResourceChange({
        logicalId,
        decl,
        existing,
        resolvedIds,
        events,
        projectId,
        formationId,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(
        'applyFormationTemplate: failed logicalId=%s error=%s',
        logicalId,
        errorMsg
      );
      await failFormationOperation({
        operation,
        formation,
        events,
        logicalId,
        resourceType: decl.type,
        action: existing ? 'update' : 'create',
        errorMessage: errorMsg,
      });
      return;
    }
  }

  await handleOrphanedDeletes({
    template: workingTemplate,
    existingResources,
    events,
  });

  const outputs = await resolveFormationOutputs(workingTemplate, resolvedIds);
  await operation.update({ status: 'succeeded', events });
  await formation.update({ status: 'active', outputs, template });
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
      if (resource.deletionPolicy === 'retain') {
        await resource.update({ status: 'deleted' });
        events.push({
          timestamp: new Date().toISOString(),
          logicalId: resource.logicalId,
          resourceType: resource.resourceType,
          action: 'delete',
          status: 'succeeded',
          physicalResourceId: resource.physicalResourceId,
        });
        continue;
      }
      await applyDeleteResource({
        resourceType: resource.resourceType,
        physicalResourceId: resource.physicalResourceId,
      });
      await resource.update({ status: 'deleted' });
      events.push({
        timestamp: new Date().toISOString(),
        logicalId: resource.logicalId,
        resourceType: resource.resourceType,
        action: 'delete',
        status: 'succeeded',
        physicalResourceId: resource.physicalResourceId,
      });
    } catch (error) {
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
