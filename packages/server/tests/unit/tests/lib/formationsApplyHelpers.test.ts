import { db } from 'src/db';
import {
  applyCreateChange,
  applyUpdateChange,
  failFormationOperation,
} from 'src/lib/formationsApplyHelpers';
import * as resourceHandlers from 'src/lib/formationsResourceHandlers';
import type { FormationEvent } from 'src/lib/formationsTypes';

describe('formationsApplyHelpers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('applyCreateChange creates resource, updates row, and tracks event', async () => {
    const resourceRow = db.FormationResource.build({
      publicId: 'afr_create',
      agentFormationId: 1,
      logicalId: 'provider',
      resourceType: 'ai_provider',
      status: 'pending',
      physicalResourceId: null,
      lastAppliedProperties: null,
    });

    const resourceUpdate = jest
      .spyOn(resourceRow, 'update')
      .mockResolvedValue(resourceRow);
    jest
      .spyOn(resourceHandlers, 'applyCreateResource')
      .mockResolvedValue('aip_1');

    const resolvedIds = new Map<string, string>();
    const events: FormationEvent[] = [];

    await applyCreateChange({
      resourceRow,
      resourceType: 'ai_provider',
      resolvedProperties: { name: 'Provider 1' },
      projectId: 1,
      logicalId: 'provider',
      resolvedIds,
      events,
    });

    expect(resolvedIds.get('provider')).toBe('aip_1');
    expect(resourceUpdate).toHaveBeenCalledWith({
      physicalResourceId: 'aip_1',
      status: 'created',
      lastAppliedProperties: { name: 'Provider 1' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      logicalId: 'provider',
      resourceType: 'ai_provider',
      action: 'create',
      status: 'succeeded',
      physicalResourceId: 'aip_1',
    });
  });

  test('applyUpdateChange updates resource when properties changed', async () => {
    const existing = db.FormationResource.build({
      publicId: 'afr_existing',
      agentFormationId: 1,
      logicalId: 'memory',
      resourceType: 'memory',
      status: 'active',
      physicalResourceId: 'mem_1',
      lastAppliedProperties: { name: 'Old Name' },
    });

    const resourceRow = existing;
    const resourceUpdate = jest
      .spyOn(resourceRow, 'update')
      .mockResolvedValue(resourceRow);
    const updateResource = jest
      .spyOn(resourceHandlers, 'applyUpdateResource')
      .mockResolvedValue(undefined);

    const resolvedIds = new Map<string, string>();
    const events: FormationEvent[] = [];

    await applyUpdateChange({
      resourceRow,
      existing: existing as InstanceType<
        (typeof db)['FormationResource']
      > & { physicalResourceId: string },
      resourceType: 'memory',
      resolvedProperties: { name: 'New Name' },
      logicalId: 'memory',
      resolvedIds,
      events,
    });

    expect(resolvedIds.get('memory')).toBe('mem_1');
    expect(updateResource).toHaveBeenCalledWith({
      resourceType: 'memory',
      physicalResourceId: 'mem_1',
      resolvedProperties: { name: 'New Name' },
    });
    expect(resourceUpdate).toHaveBeenCalledWith({
      status: 'updated',
      lastAppliedProperties: { name: 'New Name' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'update',
      status: 'succeeded',
      physicalResourceId: 'mem_1',
    });
  });

  test('applyUpdateChange records no-op when properties did not change', async () => {
    const existing = db.FormationResource.build({
      publicId: 'afr_noop',
      agentFormationId: 1,
      logicalId: 'agent',
      resourceType: 'agent',
      status: 'active',
      physicalResourceId: 'agt_1',
      lastAppliedProperties: { name: 'Agent' },
    });

    const updateResource = jest.spyOn(resourceHandlers, 'applyUpdateResource');
    const resourceUpdate = jest.spyOn(existing, 'update');

    const resolvedIds = new Map<string, string>();
    const events: FormationEvent[] = [];

    await applyUpdateChange({
      resourceRow: existing,
      existing: existing as InstanceType<
        (typeof db)['FormationResource']
      > & { physicalResourceId: string },
      resourceType: 'agent',
      resolvedProperties: { name: 'Agent' },
      logicalId: 'agent',
      resolvedIds,
      events,
    });

    expect(resolvedIds.get('agent')).toBe('agt_1');
    expect(updateResource).not.toHaveBeenCalled();
    expect(resourceUpdate).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'no-op',
      status: 'succeeded',
      physicalResourceId: 'agt_1',
    });
  });

  test('failFormationOperation records event and marks operation/formation as failed', async () => {
    const operation = {
      update: jest.fn().mockResolvedValue(undefined),
    } as unknown as InstanceType<(typeof db)['FormationOperation']>;
    const formation = {
      update: jest.fn().mockResolvedValue(undefined),
    } as unknown as InstanceType<(typeof db)['Formation']>;
    const events: FormationEvent[] = [];

    await failFormationOperation({
      operation,
      formation,
      events,
      logicalId: 'provider',
      resourceType: 'ai_provider',
      action: 'create',
      errorMessage: 'creation failed',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      logicalId: 'provider',
      resourceType: 'ai_provider',
      action: 'create',
      status: 'failed',
      error: 'creation failed',
    });
    expect(operation.update).toHaveBeenCalledWith({
      status: 'failed',
      events,
      error: { message: 'creation failed', logicalId: 'provider' },
    });
    expect(formation.update).toHaveBeenCalledWith({ status: 'failed' });
  });
});
