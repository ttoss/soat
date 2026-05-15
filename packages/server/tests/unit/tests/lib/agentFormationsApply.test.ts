import { db } from 'src/db';

import {
  buildDeleteOrder,
  handleOrphanedDeletes,
  performResourceDeletions,
  resolveFormationOutputs,
} from 'src/lib/agentFormationsApply';
import * as resourceHandlers from 'src/lib/agentFormationsResourceHandlers';
import type {
  FormationEvent,
  FormationTemplate,
} from 'src/lib/agentFormationsTypes';

const buildResource = (args: {
  logicalId: string;
  resourceType: string;
  physicalResourceId: string | null;
}) => {
  return db.AgentFormationResource.build({
    publicId: `afr_${args.logicalId}`,
    agentFormationId: 1,
    logicalId: args.logicalId,
    resourceType: args.resourceType,
    physicalResourceId: args.physicalResourceId,
    status: 'active',
  });
};

describe('agentFormationsApply', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('resolveFormationOutputs resolves valid refs and skips unresolvable values', () => {
    const template: FormationTemplate = {
      resources: {},
      outputs: {
        providerId: { ref: 'provider' },
        greeting: 'hello',
        unresolved: { ref: 'missing' },
      },
    };
    const resolvedIds = new Map<string, string>([['provider', 'aip_1']]);

    expect(resolveFormationOutputs(template, resolvedIds)).toEqual({
      providerId: 'aip_1',
      greeting: 'hello',
    });
  });

  test('buildDeleteOrder reverses dependency order and appends unknown resources', () => {
    const template: FormationTemplate = {
      resources: {
        provider: { type: 'ai_provider', properties: {} },
        agent: {
          type: 'agent',
          properties: { ai_provider_id: { ref: 'provider' } },
          depends_on: ['provider'],
        },
      },
    };
    const provider = buildResource({
      logicalId: 'provider',
      resourceType: 'ai_provider',
      physicalResourceId: 'aip_1',
    });
    const agent = buildResource({
      logicalId: 'agent',
      resourceType: 'agent',
      physicalResourceId: 'agt_1',
    });
    const orphan = buildResource({
      logicalId: 'orphan',
      resourceType: 'memory',
      physicalResourceId: 'mem_1',
    });

    const order = buildDeleteOrder(template, [provider, agent, orphan]);

    expect(order.map((r) => r.logicalId)).toEqual(['agent', 'provider', 'orphan']);
  });

  test('performResourceDeletions skips missing ids and records both success and failure events', async () => {
    const skipped = buildResource({
      logicalId: 'skip',
      resourceType: 'document',
      physicalResourceId: null,
    });
    const success = buildResource({
      logicalId: 'ok',
      resourceType: 'webhook',
      physicalResourceId: 'whk_1',
    });
    const failure = buildResource({
      logicalId: 'fail',
      resourceType: 'memory',
      physicalResourceId: 'mem_1',
    });

    const successUpdate = jest.spyOn(success, 'update').mockResolvedValue(success);
    const failureUpdate = jest.spyOn(failure, 'update').mockResolvedValue(failure);

    jest
      .spyOn(resourceHandlers, 'applyDeleteResource')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('delete failed'));

    const result = await performResourceDeletions([skipped, success, failure]);

    expect(successUpdate).toHaveBeenCalledWith({ status: 'deleted' });
    expect(failureUpdate).not.toHaveBeenCalled();
    expect(result.hasError).toBe(true);
    expect(result.events.map((event) => event.status)).toEqual([
      'succeeded',
      'failed',
    ]);
  });

  test('handleOrphanedDeletes records delete success and failure events', async () => {
    const retained = buildResource({
      logicalId: 'keep',
      resourceType: 'agent',
      physicalResourceId: 'agt_1',
    });
    const deleted = buildResource({
      logicalId: 'remove-ok',
      resourceType: 'memory',
      physicalResourceId: 'mem_1',
    });
    const failed = buildResource({
      logicalId: 'remove-fail',
      resourceType: 'webhook',
      physicalResourceId: 'whk_1',
    });
    const deleteUpdate = jest.spyOn(deleted, 'update').mockResolvedValue(deleted);
    const failedUpdate = jest.spyOn(failed, 'update').mockResolvedValue(failed);
    const events: FormationEvent[] = [];

    jest
      .spyOn(resourceHandlers, 'applyDeleteResource')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('cannot delete'));

    await handleOrphanedDeletes({
      template: {
        resources: {
          keep: { type: 'agent', properties: {} },
        },
      },
      existingResources: [retained, deleted, failed],
      events,
    });

    expect(deleteUpdate).toHaveBeenCalledWith({ status: 'deleted' });
    expect(failedUpdate).not.toHaveBeenCalled();
    expect(events.map((event) => event.status)).toEqual(['succeeded', 'failed']);
  });
});
