import { db } from 'src/db';
import {
  buildDeleteOrder,
  handleOrphanedDeletes,
  performResourceDeletions,
  processResourceChange,
  resolveFormationOutputs,
} from 'src/lib/formationsApply';
import * as resourceHandlers from 'src/lib/formationsResourceHandlers';
import type {
  FormationEvent,
  FormationTemplate,
} from 'src/lib/formationsTypes';

const buildResource = (args: {
  logicalId: string;
  resourceType: string;
  physicalResourceId: string | null;
  deletionPolicy?: string;
}) => {
  return db.FormationResource.build({
    publicId: `fmr_${args.logicalId}`,
    formationId: 1,
    logicalId: args.logicalId,
    resourceType: args.resourceType,
    physicalResourceId: args.physicalResourceId,
    status: 'active',
    deletionPolicy: args.deletionPolicy ?? 'delete',
  });
};

describe('formationsApply', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('resolveFormationOutputs resolves valid refs and skips unresolvable values', async () => {
    const template: FormationTemplate = {
      resources: {},
      outputs: {
        providerId: { ref: 'provider' },
        greeting: 'hello',
        unresolved: { ref: 'missing' },
      },
    };
    const resolvedIds = new Map<string, string>([['provider', 'aip_1']]);

    await expect(resolveFormationOutputs(template, resolvedIds)).resolves.toEqual({
      providerId: 'aip_1',
      greeting: 'hello',
    });
  });

  test('resolveFormationOutputs resolves ref_attr expressions using getAttributes', async () => {
    const template: FormationTemplate = {
      resources: {
        MyWebhook: { type: 'webhook', properties: { name: 'hook', url: 'https://example.com', events: ['*'] } },
      },
      outputs: {
        webhookSecret: { ref_attr: 'MyWebhook.secret' },
        unknownResource: { ref_attr: 'Unknown.secret' },
        noDot: { ref_attr: 'nodothere' } as unknown as { ref_attr: string },
      },
    };
    const resolvedIds = new Map<string, string>([['MyWebhook', 'whk_1']]);

    // getWebhookSecret returns null for a non-existent webhook, so webhookSecret is skipped
    const result = await resolveFormationOutputs(template, resolvedIds);
    // The ref_attr for an unknown resource should be skipped (physicalId not in resolvedIds)
    expect(result.unknownResource).toBeUndefined();
    // noDot ref_attr expression (no '.' separator) should be skipped
    expect(result.noDot).toBeUndefined();
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

    expect(
      order.map((r) => {
        return r.logicalId;
      })
    ).toEqual(['agent', 'provider', 'orphan']);
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

    const successUpdate = jest
      .spyOn(success, 'update')
      .mockResolvedValue(success);
    const failureUpdate = jest
      .spyOn(failure, 'update')
      .mockResolvedValue(failure);

    jest
      .spyOn(resourceHandlers, 'applyDeleteResource')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('delete failed'));

    const result = await performResourceDeletions([skipped, success, failure]);

    expect(successUpdate).toHaveBeenCalledWith({ status: 'deleted' });
    expect(failureUpdate).not.toHaveBeenCalled();
    expect(result.hasError).toBe(true);
    expect(
      result.events.map((event) => {
        return event.status;
      })
    ).toEqual(['succeeded', 'failed']);
  });

  test('performResourceDeletions skips physical deletion for retain resources', async () => {
    const retained = buildResource({
      logicalId: 'keep',
      resourceType: 'memory',
      physicalResourceId: 'mem_1',
      deletionPolicy: 'retain',
    });

    const retainedUpdate = jest
      .spyOn(retained, 'update')
      .mockResolvedValue(retained);
    const applyDeleteSpy = jest.spyOn(resourceHandlers, 'applyDeleteResource');

    const result = await performResourceDeletions([retained]);

    expect(applyDeleteSpy).not.toHaveBeenCalled();
    expect(retainedUpdate).toHaveBeenCalledWith({ status: 'deleted' });
    expect(result.hasError).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].status).toBe('succeeded');
    expect(result.events[0].physicalResourceId).toBe('mem_1');
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
    const deleteUpdate = jest
      .spyOn(deleted, 'update')
      .mockResolvedValue(deleted);
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
    expect(
      events.map((event) => {
        return event.status;
      })
    ).toEqual(['succeeded', 'failed']);
  });

  test('handleOrphanedDeletes skips physical deletion for retain resources', async () => {
    const retainedOrphan = buildResource({
      logicalId: 'orphan',
      resourceType: 'memory',
      physicalResourceId: 'mem_1',
      deletionPolicy: 'retain',
    });
    const retainedOrphanUpdate = jest
      .spyOn(retainedOrphan, 'update')
      .mockResolvedValue(retainedOrphan);
    const applyDeleteSpy = jest.spyOn(resourceHandlers, 'applyDeleteResource');
    const events: FormationEvent[] = [];

    await handleOrphanedDeletes({
      template: { resources: {} },
      existingResources: [retainedOrphan],
      events,
    });

    expect(applyDeleteSpy).not.toHaveBeenCalled();
    expect(retainedOrphanUpdate).toHaveBeenCalledWith({ status: 'deleted' });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('succeeded');
    expect(events[0].physicalResourceId).toBe('mem_1');
  });

  test('processResourceChange marks resource as failed when create handler throws', async () => {
    const resourceRow = db.FormationResource.build({
      publicId: 'fmr_failure',
      formationId: 1,
      logicalId: 'xaiProvider',
      resourceType: 'ai_provider',
      status: 'pending',
      physicalResourceId: null,
      lastAppliedProperties: null,
    });
    const updateSpy = jest
      .spyOn(resourceRow, 'update')
      .mockResolvedValue(resourceRow);
    jest
      .spyOn(db.FormationResource, 'create')
      .mockResolvedValue(resourceRow as never);
    jest
      .spyOn(resourceHandlers, 'applyCreateResource')
      .mockRejectedValueOnce(new Error('Secret not found'));

    await expect(
      processResourceChange({
        logicalId: 'xaiProvider',
        decl: {
          type: 'ai_provider',
          properties: {
            name: 'xai',
            provider: 'xai',
            secret_id: 'sec_missing',
            default_model: 'grok-4',
          },
        },
        existing: undefined,
        resolvedIds: new Map<string, string>(),
        events: [],
        projectId: 1,
        formationId: 1,
      })
    ).rejects.toThrow('Secret not found');

    expect(updateSpy).toHaveBeenCalledWith({ status: 'failed' });
  });
});
