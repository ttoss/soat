import { db } from 'src/db';
import {
  buildDeleteOrder,
  handleOrphanedDeletes,
  performResourceDeletions,
  processResourceChange,
} from 'src/lib/formationsApply';
import { resolveFormationOutputs } from 'src/lib/formationsResolve';
import type {
  FormationEvent,
  FormationTemplate,
} from 'src/lib/formationsTypes';
import { createMemory } from 'src/lib/memories';
import { createWebhook } from 'src/lib/webhooks';

// These tests drive the real formation-apply helpers against the real database
// and the real resource handlers — no `db.*` stubbing and no internal-module
// mocks. Each branch is exercised by choosing inputs that trigger it for real:
//   - a real physical resource (a Memory)        → clean delete / update / create
//   - a nonexistent agent id                      → `deleteAgent` throws
//                                                    RESOURCE_NOT_FOUND (already-gone)
//   - an unsupported resource type                → `applyDeleteResource` throws a
//                                                    plain Error (generic failure)

let projectId: number;
let formationId: number;
let memoryCounter = 0;

const uniqueName = (prefix: string) => {
  memoryCounter += 1;
  return `${prefix}-${memoryCounter}`;
};

const createMemoryResource = async (deletionPolicy = 'delete') => {
  const memory = await createMemory({
    projectId,
    name: uniqueName('formations-apply-mem'),
  });
  const row = await db.FormationResource.create({
    formationId,
    logicalId: uniqueName('mem-logical'),
    resourceType: 'memory',
    physicalResourceId: memory.id,
    status: 'active',
    deletionPolicy,
  });
  return { memory, row };
};

const memoryExists = async (id: string): Promise<boolean> => {
  const found = await db.Memory.findOne({ where: { publicId: id } });
  return found !== null;
};

// A lightweight in-memory row for the pure `buildDeleteOrder` test (no DB write
// needed — the function only reads `logicalId`).
const buildResource = (args: {
  logicalId: string;
  resourceType: string;
  physicalResourceId: string | null;
}) => {
  return db.FormationResource.build({
    publicId: `fmr_${args.logicalId}`,
    formationId,
    logicalId: args.logicalId,
    resourceType: args.resourceType,
    physicalResourceId: args.physicalResourceId,
    status: 'active',
    deletionPolicy: 'delete',
  });
};

describe('formationsApply', () => {
  beforeAll(async () => {
    const project = await db.Project.create({
      name: 'Formations Apply Test Project',
    });
    projectId = project.id as number;

    const formation = await db.Formation.create({
      projectId,
      name: 'formations-apply-test',
      status: 'creating',
    });
    formationId = formation.id as number;
  });

  test('resolveFormationOutputs resolves valid refs and skips unresolvable values', async () => {
    const template: FormationTemplate = {
      resources: {},
      outputs: {
        providerId: { ref: 'provider' },
        greeting: 'hello',
        unresolved: { ref: 'missing' },
        // A non-ref_attr output whose resolved value isn't a string (e.g. a
        // raw number in the template) is dropped rather than coerced.
        retries: 3,
      },
    };
    const resolvedIds = new Map<string, string>([['provider', 'aip_1']]);

    await expect(
      resolveFormationOutputs(template, resolvedIds)
    ).resolves.toEqual({
      providerId: 'aip_1',
      greeting: 'hello',
    });
  });

  test('resolveFormationOutputs skips a ref_attr whose logical id is absent from the template resources', async () => {
    // `resolvedIds` still has a stale entry for "Ghost" (e.g. left over from a
    // prior apply), but the current template no longer declares that
    // resource — there is no `type` to resolve a formation module from.
    const template: FormationTemplate = {
      resources: {},
      outputs: {
        ghostAttr: { ref_attr: 'Ghost.secret' },
      },
    };
    const resolvedIds = new Map<string, string>([['Ghost', 'whk_stale']]);

    await expect(
      resolveFormationOutputs(template, resolvedIds)
    ).resolves.toEqual({});
  });

  test('resolveFormationOutputs resolves a ref_attr for a real resource attribute', async () => {
    const webhook = await createWebhook({
      projectId,
      name: uniqueName('formations-apply-webhook'),
      url: 'https://example.com/hook',
      events: ['*'],
    });
    const template: FormationTemplate = {
      resources: {
        MyWebhook: {
          type: 'webhook',
          properties: {
            name: webhook.name,
            url: webhook.url,
            events: webhook.events,
          },
        },
      },
      outputs: {
        webhookSecret: { ref_attr: 'MyWebhook.secret' },
      },
    };
    const resolvedIds = new Map<string, string>([['MyWebhook', webhook.id]]);

    const result = await resolveFormationOutputs(template, resolvedIds);

    expect(result.webhookSecret).toBe(webhook.secret);
  });

  test('resolveFormationOutputs resolves ref_attr expressions using getAttributes', async () => {
    const template: FormationTemplate = {
      resources: {
        MyWebhook: {
          type: 'webhook',
          properties: {
            name: 'hook',
            url: 'https://example.com',
            events: ['*'],
          },
        },
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
    const skipped = await db.FormationResource.create({
      formationId,
      logicalId: uniqueName('skip'),
      resourceType: 'document',
      physicalResourceId: null,
      status: 'active',
      deletionPolicy: 'delete',
    });
    const { memory, row: success } = await createMemoryResource();
    // An unsupported resource type makes `applyDeleteResource` throw a plain
    // Error (not a RESOURCE_NOT_FOUND DomainError), driving the failure branch.
    const failure = await db.FormationResource.create({
      formationId,
      logicalId: uniqueName('fail'),
      resourceType: 'unsupported_type',
      physicalResourceId: 'phys_unsupported',
      status: 'active',
      deletionPolicy: 'delete',
    });

    const result = await performResourceDeletions([skipped, success, failure]);

    expect(
      result.events.map((event) => {
        return event.status;
      })
    ).toEqual(['succeeded', 'failed']);
    expect(result.hasError).toBe(true);

    // The successful delete really removed the memory and marked its row deleted.
    expect(await memoryExists(memory.id)).toBe(false);
    await success.reload();
    expect(success.status).toBe('deleted');
    // The failed delete did not mark its row deleted.
    await failure.reload();
    expect(failure.status).not.toBe('deleted');
  });

  test('performResourceDeletions skips physical deletion for retain resources', async () => {
    const { memory, row: retained } = await createMemoryResource('retain');

    const result = await performResourceDeletions([retained]);

    // The physical memory is preserved, but the tracking row is marked deleted.
    expect(await memoryExists(memory.id)).toBe(true);
    await retained.reload();
    expect(retained.status).toBe('deleted');
    expect(result.hasError).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].status).toBe('succeeded');
    expect(result.events[0].physicalResourceId).toBe(memory.id);
  });

  test('performResourceDeletions treats an already-gone resource as deleted', async () => {
    // `deleteAgent` throws RESOURCE_NOT_FOUND for a nonexistent agent id, which
    // the helper treats as an idempotent success.
    const alreadyGone = await db.FormationResource.create({
      formationId,
      logicalId: uniqueName('gone'),
      resourceType: 'agent',
      physicalResourceId: 'agt_does_not_exist',
      status: 'active',
      deletionPolicy: 'delete',
    });

    const result = await performResourceDeletions([alreadyGone]);

    await alreadyGone.reload();
    expect(alreadyGone.status).toBe('deleted');
    expect(result.hasError).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].status).toBe('succeeded');
  });

  test('performResourceDeletions treats an already-gone chat as deleted', async () => {
    // `deleteChat` throws RESOURCE_NOT_FOUND for a nonexistent chat id, which
    // the helper treats as an idempotent success — exercises the chat
    // module's own not-found guard (unreachable via REST, which pre-checks
    // existence with `getChat` before ever calling `deleteChat`).
    const alreadyGoneChat = await db.FormationResource.create({
      formationId,
      logicalId: uniqueName('gone-chat'),
      resourceType: 'chat',
      physicalResourceId: 'chat_does_not_exist',
      status: 'active',
      deletionPolicy: 'delete',
    });

    const result = await performResourceDeletions([alreadyGoneChat]);

    await alreadyGoneChat.reload();
    expect(alreadyGoneChat.status).toBe('deleted');
    expect(result.hasError).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].status).toBe('succeeded');
  });

  test('handleOrphanedDeletes records delete success and failure events', async () => {
    const keepLogicalId = uniqueName('keep');
    const retained = await db.FormationResource.create({
      formationId,
      logicalId: keepLogicalId,
      resourceType: 'agent',
      physicalResourceId: 'agt_keep',
      status: 'active',
      deletionPolicy: 'delete',
    });
    const { memory, row: deleted } = await createMemoryResource();
    const failed = await db.FormationResource.create({
      formationId,
      logicalId: uniqueName('remove-fail'),
      resourceType: 'unsupported_type',
      physicalResourceId: 'phys_unsupported',
      status: 'active',
      deletionPolicy: 'delete',
    });
    const events: FormationEvent[] = [];

    await handleOrphanedDeletes({
      // `retained` stays in the template, so it is not orphaned; the other two
      // are absent and therefore deleted.
      template: {
        resources: {
          [keepLogicalId]: { type: 'agent', properties: {} },
        },
      },
      existingResources: [retained, deleted, failed],
      events,
    });

    expect(await memoryExists(memory.id)).toBe(false);
    await deleted.reload();
    expect(deleted.status).toBe('deleted');
    await retained.reload();
    expect(retained.status).not.toBe('deleted');
    expect(
      events.map((event) => {
        return event.status;
      })
    ).toEqual(['succeeded', 'failed']);
  });

  test('handleOrphanedDeletes skips physical deletion for retain resources', async () => {
    const { memory, row: retainedOrphan } =
      await createMemoryResource('retain');
    const events: FormationEvent[] = [];

    await handleOrphanedDeletes({
      template: { resources: {} },
      existingResources: [retainedOrphan],
      events,
    });

    expect(await memoryExists(memory.id)).toBe(true);
    await retainedOrphan.reload();
    expect(retainedOrphan.status).toBe('deleted');
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('succeeded');
    expect(events[0].physicalResourceId).toBe(memory.id);
  });

  test('handleOrphanedDeletes treats an already-gone orphan as deleted', async () => {
    const alreadyGoneOrphan = await db.FormationResource.create({
      formationId,
      logicalId: uniqueName('orphan'),
      resourceType: 'agent',
      physicalResourceId: 'agt_does_not_exist',
      status: 'active',
      deletionPolicy: 'delete',
    });
    const events: FormationEvent[] = [];

    await handleOrphanedDeletes({
      template: { resources: {} },
      existingResources: [alreadyGoneOrphan],
      events,
    });

    await alreadyGoneOrphan.reload();
    expect(alreadyGoneOrphan.status).toBe('deleted');
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('succeeded');
  });

  test('handleOrphanedDeletes does not re-report a resource that is already tombstoned', async () => {
    // Simulates a resource deleted in a prior `update-formation` run: its row
    // still carries a stale `physicalResourceId` (never cleared) but its
    // status is already 'deleted'. A subsequent reconcile with the same
    // template must not re-attempt deletion or re-emit a delete event for it.
    const tombstoned = await db.FormationResource.create({
      formationId,
      logicalId: uniqueName('already-deleted'),
      resourceType: 'agent',
      physicalResourceId: 'agt_stale',
      status: 'deleted',
      deletionPolicy: 'delete',
    });
    const events: FormationEvent[] = [];

    await handleOrphanedDeletes({
      template: { resources: {} },
      existingResources: [tombstoned],
      events,
    });

    expect(events).toHaveLength(0);
  });

  test('processResourceChange marks resource as failed when create handler throws', async () => {
    const logicalId = uniqueName('CreateFails');

    // A memory declaration with no `name` fails validation inside the real
    // memories formation module, so `applyCreateResource` throws.
    await expect(
      processResourceChange({
        logicalId,
        decl: {
          type: 'memory',
          properties: {},
        },
        existing: undefined,
        resolvedIds: new Map<string, string>(),
        events: [],
        projectId,
        formationId,
      })
    ).rejects.toThrow();

    const row = await db.FormationResource.findOne({
      where: { formationId, logicalId },
    });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('failed');
  });

  test('processResourceChange treats a deleted logical id as a fresh create, not an update', async () => {
    const logicalId = uniqueName('CreateTheme');
    // A previously-deleted row with a stale physical id must be re-created, not
    // diffed as an update against the gone resource.
    const existing = await db.FormationResource.create({
      formationId,
      logicalId,
      resourceType: 'memory',
      status: 'deleted',
      physicalResourceId: 'mem_stale',
      deletionPolicy: 'delete',
    });

    const events: FormationEvent[] = [];

    await processResourceChange({
      logicalId,
      decl: {
        type: 'memory',
        properties: { name: uniqueName('theme') },
      },
      existing,
      resolvedIds: new Map<string, string>(),
      events,
      projectId,
      formationId,
    });

    expect(events[0].action).toBe('create');
    // A brand-new memory was created, replacing the stale physical id.
    expect(existing.physicalResourceId).not.toBe('mem_stale');
    expect(existing.physicalResourceId).toMatch(/^mem_/);
    expect(await memoryExists(existing.physicalResourceId!)).toBe(true);
  });
});
