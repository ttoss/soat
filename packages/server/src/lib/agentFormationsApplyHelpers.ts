/**
 * Helper functions for agent formation application.
 * Handles resource creation, update, and deletion during formation application.
 */

import { db } from 'src/db';

import {
  applyCreateResource,
  applyDeleteResource,
  applyUpdateResource,
} from './agentFormationsResourceHandlers';
import type { FormationEvent } from './agentFormationsTypes';

type ResourceRow = InstanceType<(typeof db)['AgentFormationResource']>;

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

export const failFormationOperation = async (args: {
  operation: InstanceType<(typeof db)['AgentFormationOperation']>;
  formation: InstanceType<(typeof db)['AgentFormation']>;
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
