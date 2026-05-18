import createDebug from 'debug';
import { db } from 'src/db';

import {
  buildDependencyGraph,
  buildResolvedParamsMap,
  resolveParamExpressions,
  resolveRefs,
  topologicalSort,
} from './agentFormationsHelpers';
import {
  applyCreateResource,
  applyDeleteResource,
  applyUpdateResource,
} from './agentFormationsResourceHandlers';
import type {
  FormationEvent,
  FormationTemplate,
  ResourceDeclaration,
} from './agentFormationsTypes';

/* eslint-disable max-lines */

const log = createDebug('soat:formations');

export const resolveFormationOutputs = (
  template: FormationTemplate,
  resolvedIds: Map<string, string>
): Record<string, string> => {
  const outputs: Record<string, string> = {};
  if (!template.outputs) return outputs;
  for (const [outputName, outputValue] of Object.entries(template.outputs)) {
    try {
      const resolved = resolveRefs(outputValue, resolvedIds);
      if (typeof resolved === 'string') outputs[outputName] = resolved;
    } catch {
      // Skip unresolvable outputs
    }
  }
  return outputs;
};

export const handleOrphanedDeletes = async (args: {
  template: FormationTemplate;
  existingResources: InstanceType<(typeof db)['AgentFormationResource']>[];
  events: FormationEvent[];
}): Promise<void> => {
  const { template, existingResources, events } = args;
  const newLogicalIds = new Set(Object.keys(template.resources));
  const toDelete = existingResources.filter((r) => {
    return !newLogicalIds.has(r.logicalId) && r.physicalResourceId;
  });
  for (const resource of toDelete) {
    try {
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

type ResourceRow = InstanceType<(typeof db)['AgentFormationResource']>;

const applyCreateChange = async (args: {
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
    lastAppliedProperties: resolvedProperties,
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

const applyUpdateChange = async (args: {
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
  const propertiesChanged =
    JSON.stringify(lastProps) !== JSON.stringify(resolvedProperties);
  resolvedIds.set(logicalId, existing.physicalResourceId);
  if (propertiesChanged) {
    await applyUpdateResource({
      resourceType,
      physicalResourceId: existing.physicalResourceId,
      resolvedProperties,
    });
    await resourceRow.update({
      status: 'updated',
      lastAppliedProperties: resolvedProperties,
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

  let resourceRow: ResourceRow;
  if (!existing) {
    resourceRow = await db.AgentFormationResource.create({
      agentFormationId: formationId,
      logicalId,
      resourceType: decl.type,
      status: 'pending',
      physicalResourceId: null,
      lastAppliedProperties: null,
    });
  } else {
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

const failFormationOperation = async (args: {
  operation: InstanceType<(typeof db)['AgentFormationOperation']>;
  formation: InstanceType<(typeof db)['AgentFormation']>;
  events: FormationEvent[];
  logicalId: string;
  resourceType: string;
  action: 'create' | 'update';
  errorMessage: string;
}) => {
  args.events.push({
    timestamp: new Date().toISOString(),
    logicalId: args.logicalId,
    resourceType: args.resourceType,
    action: args.action,
    status: 'failed',
    error: args.errorMessage,
  });
  await args.operation.update({
    status: 'failed',
    events: args.events,
    error: { message: args.errorMessage, logicalId: args.logicalId },
  });
  await args.formation.update({ status: 'failed' });
};

/* eslint-disable-next-line max-lines-per-function */
export const applyFormationTemplate = async (args: {
  formation: InstanceType<(typeof db)['AgentFormation']>;
  template: FormationTemplate;
  existingResources: InstanceType<(typeof db)['AgentFormationResource']>[];
  projectId: number;
  operation: InstanceType<(typeof db)['AgentFormationOperation']>;
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

  const outputs = resolveFormationOutputs(workingTemplate, resolvedIds);
  await operation.update({ status: 'succeeded', events });
  await formation.update({ status: 'active', outputs, template });
  log('applyFormationTemplate: succeeded formationId=%s', formation.publicId);
};

export const buildDeleteOrder = (
  template: FormationTemplate | null,
  existingResources: InstanceType<(typeof db)['AgentFormationResource']>[]
): InstanceType<(typeof db)['AgentFormationResource']>[] => {
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
  const ordered: InstanceType<(typeof db)['AgentFormationResource']>[] = [];

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
  orderedResources: InstanceType<(typeof db)['AgentFormationResource']>[]
): Promise<{ events: FormationEvent[]; hasError: boolean }> => {
  const events: FormationEvent[] = [];
  let hasError = false;

  for (const resource of orderedResources) {
    if (!resource.physicalResourceId) continue;
    try {
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
