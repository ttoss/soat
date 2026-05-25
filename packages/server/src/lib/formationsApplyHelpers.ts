/**
 * Helper functions for formation application.
 * Handles resource creation, update, and deletion during formation application.
 */

import type { db } from 'src/db';

import { getFormationModule } from './formationsRegistry';
import {
  applyCreateResource,
  applyUpdateResource,
} from './formationsResourceHandlers';
import type { FormationEvent } from './formationsTypes';

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
      lastAppliedProperties: sanitize(resourceType, resolvedProperties),
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

export const failFormationOperation = async (args: {
  operation: InstanceType<(typeof db)['FormationOperation']>;
  formation: InstanceType<(typeof db)['Formation']>;
  events: FormationEvent[];
  logicalId: string;
  resourceType: string;
  action: 'create' | 'update';
  errorMessage: string;
}): Promise<void> => {
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
