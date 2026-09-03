import { db } from 'src/db';
import {
  applyCreateChange,
  failFormationOperation,
  rollbackCreatedResources,
} from 'src/lib/formationsApplyHelpers';
import { applyUpdateChange } from 'src/lib/formationsApplyUpdate';
import { planResourceChange } from 'src/lib/formationsPlanHelpers';
import type { FormationEvent } from 'src/lib/formationsTypes';
import { createMemory, getMemory } from 'src/lib/memories';

// `memory` carries these because its create/update surface is minimal, letting
// the merge/no-op decision be asserted through real resource state.

type ResourceRowWithId = InstanceType<(typeof db)['FormationResource']> & {
  physicalResourceId: string;
};

let projectId: number;
let actingUserId: number;
let formationId: number;
let counter = 0;

const uniqueName = (prefix: string) => {
  counter += 1;
  return `${prefix}-${counter}`;
};

const memoryExists = async (id: string): Promise<boolean> => {
  const found = await db.Memory.findOne({ where: { publicId: id } });
  return found !== null;
};

describe('formationsApplyHelpers', () => {
  beforeAll(async () => {
    const project = await db.Project.create({
      name: 'Formations Apply Helpers Test Project',
    });
    projectId = project.id as number;

    const user = await db.User.create({
      username: 'formations-apply-helpers-actor',
      passwordHash: 'not-a-real-hash',
    });
    actingUserId = user.id as number;

    const formation = await db.Formation.create({
      projectId,
      name: 'formations-apply-helpers-test',
      status: 'creating',
    });
    formationId = formation.id as number;
  });

  test('applyCreateChange creates the real resource, updates the row, and tracks the event', async () => {
    const resourceRow = await db.FormationResource.create({
      formationId,
      logicalId: uniqueName('create-logical'),
      resourceType: 'memory',
      status: 'pending',
      physicalResourceId: null,
      lastAppliedProperties: null,
      deletionPolicy: 'delete',
    });

    const memoryName = uniqueName('created-mem');
    const resolvedIds = new Map<string, string>();
    const events: FormationEvent[] = [];

    await applyCreateChange({
      actingUserId,
      resourceRow,
      resourceType: 'memory',
      resolvedProperties: { name: memoryName },
      projectId,
      logicalId: 'provider',
      resolvedIds,
      events,
    });

    const physicalId = resolvedIds.get('provider');
    expect(physicalId).toMatch(/^mem_/);
    expect(await memoryExists(physicalId as string)).toBe(true);

    await resourceRow.reload();
    expect(resourceRow.physicalResourceId).toBe(physicalId);
    expect(resourceRow.status).toBe('created');
    expect(resourceRow.lastAppliedProperties).toEqual({ name: memoryName });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      logicalId: 'provider',
      resourceType: 'memory',
      action: 'create',
      status: 'succeeded',
      physicalResourceId: physicalId,
    });
  });

  test('applyUpdateChange updates the real resource when properties changed', async () => {
    const memory = await createMemory({ projectId, name: 'Old Name' });
    const resourceRow = await db.FormationResource.create({
      formationId,
      logicalId: uniqueName('update-logical'),
      resourceType: 'memory',
      status: 'active',
      physicalResourceId: memory.id,
      lastAppliedProperties: { name: 'Old Name' },
      deletionPolicy: 'delete',
    });

    const resolvedIds = new Map<string, string>();
    const events: FormationEvent[] = [];

    await applyUpdateChange({
      actingUserId,
      projectId,
      resourceRow,
      existing: resourceRow as ResourceRowWithId,
      resourceType: 'memory',
      resolvedProperties: { name: 'New Name' },
      logicalId: 'memory',
      resolvedIds,
      events,
      pendingCleanups: [],
    });

    expect(resolvedIds.get('memory')).toBe(memory.id);
    const updated = await getMemory({ id: memory.id });
    expect(updated?.name).toBe('New Name');

    await resourceRow.reload();
    expect(resourceRow.status).toBe('updated');
    expect(resourceRow.lastAppliedProperties).toEqual({ name: 'New Name' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'update',
      status: 'succeeded',
      physicalResourceId: memory.id,
    });
  });

  test('applyUpdateChange records a no-op when properties did not change', async () => {
    const memory = await createMemory({ projectId, name: 'No-op Mem' });
    // An unsaved instance is enough: the no-op branch never persists the row.
    const resourceRow = db.FormationResource.build({
      publicId: 'fmr_noop',
      formationId,
      logicalId: 'noop',
      resourceType: 'memory',
      status: 'active',
      physicalResourceId: memory.id,
      lastAppliedProperties: { name: 'No-op Mem' },
    });

    const resolvedIds = new Map<string, string>();
    const events: FormationEvent[] = [];

    await applyUpdateChange({
      actingUserId,
      projectId,
      resourceRow,
      existing: resourceRow as ResourceRowWithId,
      resourceType: 'memory',
      resolvedProperties: { name: 'No-op Mem' },
      logicalId: 'noop',
      resolvedIds,
      events,
      pendingCleanups: [],
    });

    expect(resolvedIds.get('noop')).toBe(memory.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'no-op',
      status: 'succeeded',
      physicalResourceId: memory.id,
    });
    // The resource is untouched by a no-op.
    expect((await getMemory({ id: memory.id }))?.name).toBe('No-op Mem');
  });

  // #902: `plan-formation` previews `update-formation`, so the two must reach
  // the same verdict. Both divergences below used to make apply see a change
  // that plan reported as a no-op.
  describe.each([
    [
      'a stored key the template no longer declares',
      { name: 'Agreed Mem', description: 'set out of band' },
    ],
    ['a different key order', { description: null, name: 'Agreed Mem' }],
  ])('plan and apply agree on %s', (_label, lastApplied) => {
    test('both report no change', async () => {
      const memory = await createMemory({ projectId, name: 'Agreed Mem' });
      const resourceRow = db.FormationResource.build({
        publicId: uniqueName('fmr_agree'),
        formationId,
        logicalId: 'agree',
        resourceType: 'memory',
        status: 'active',
        physicalResourceId: memory.id,
        lastAppliedProperties: lastApplied,
      });

      const decl = {
        type: 'memory',
        properties: { name: 'Agreed Mem' },
      } as const;

      const plan = await planResourceChange({
        projectId,
        logicalId: 'agree',
        decl,
        physicalResourceId: memory.id,
        resolvedParams: new Map(),
        existingMap: new Map(),
        templateResourceKeys: new Set(['agree']),
        lastAppliedProperties: lastApplied,
      });

      const events: FormationEvent[] = [];
      await applyUpdateChange({
        actingUserId,
        projectId,
        resourceRow,
        existing: resourceRow as ResourceRowWithId,
        resourceType: 'memory',
        resolvedProperties: { name: 'Agreed Mem' },
        logicalId: 'agree',
        resolvedIds: new Map<string, string>(),
        events,
        pendingCleanups: [],
      });

      expect(plan.action).toBe('no-op');
      expect(events[0]).toMatchObject({ action: 'no-op' });
    });
  });

  test('applyUpdateChange treats a dropped (use-previous) field as a no-op', async () => {
    // A kept field resolves to `undefined`; when it is also absent from
    // lastApplied it is dropped entirely, so the merged props equal lastApplied.
    const resourceRow = db.FormationResource.build({
      publicId: 'fmr_dropped',
      formationId,
      logicalId: 'dropped',
      resourceType: 'memory',
      status: 'active',
      physicalResourceId: 'mem_dropped',
      lastAppliedProperties: { name: 'kept' },
    });

    const events: FormationEvent[] = [];
    await applyUpdateChange({
      actingUserId,
      projectId,
      resourceRow,
      existing: resourceRow as ResourceRowWithId,
      resourceType: 'memory',
      resolvedProperties: { name: 'kept', description: undefined },
      logicalId: 'dropped',
      resolvedIds: new Map<string, string>(),
      events,
      pendingCleanups: [],
    });

    expect(events[0]).toMatchObject({ action: 'no-op' });
  });

  test('applyUpdateChange reuses the last-applied value for a kept field when another field changes', async () => {
    const memory = await createMemory({
      projectId,
      name: 'old-name',
      description: 'kept-desc',
    });
    const resourceRow = await db.FormationResource.create({
      formationId,
      logicalId: uniqueName('merge-logical'),
      resourceType: 'memory',
      status: 'active',
      physicalResourceId: memory.id,
      lastAppliedProperties: { name: 'old-name', description: 'kept-desc' },
      deletionPolicy: 'delete',
    });

    const events: FormationEvent[] = [];
    await applyUpdateChange({
      actingUserId,
      projectId,
      resourceRow,
      existing: resourceRow as ResourceRowWithId,
      resourceType: 'memory',
      // name changed; description's param was kept (resolves to undefined) and
      // must be reused from lastApplied rather than dropped.
      resolvedProperties: { name: 'new-name', description: undefined },
      logicalId: 'merge',
      resolvedIds: new Map<string, string>(),
      events,
      pendingCleanups: [],
    });

    const updated = await getMemory({ id: memory.id });
    expect(updated?.name).toBe('new-name');
    expect(updated?.description).toBe('kept-desc');

    await resourceRow.reload();
    expect(resourceRow.lastAppliedProperties).toEqual({
      name: 'new-name',
      description: 'kept-desc',
    });
    expect(events[0]).toMatchObject({ action: 'update' });
  });

  // The rollback branches below have no entry point of their own: a template
  // that reaches apply has already been validated, so no resource it created
  // can be of an unsupported type, and a physical resource cannot vanish
  // mid-apply. Both are driven here directly against the real handlers.
  test('rollbackCreatedResources reports an unwind failure instead of throwing over the original error', async () => {
    const memory = await createMemory({
      projectId,
      name: uniqueName('rollback-mem'),
    });
    const deletable = await db.FormationResource.create({
      formationId,
      logicalId: uniqueName('rollback-deletable'),
      resourceType: 'memory',
      status: 'created',
      physicalResourceId: memory.id,
      deletionPolicy: 'delete',
    });
    const blocked = await db.FormationResource.create({
      formationId,
      logicalId: uniqueName('rollback-blocked'),
      resourceType: 'unsupported_type',
      status: 'created',
      physicalResourceId: 'phys_unsupported',
      deletionPolicy: 'delete',
    });

    const events = await rollbackCreatedResources({
      actingUserId,
      projectId,
      created: [deletable, blocked],
    });

    // Reverse order: the blocked resource was created last, so it is unwound
    // first — and its failure does not stop the rest of the unwind.
    expect(
      events.map((event) => {
        return [event.logicalId, event.action, event.status];
      })
    ).toEqual([
      [blocked.logicalId, 'rollback', 'failed'],
      [deletable.logicalId, 'rollback', 'succeeded'],
    ]);
    expect(events[0].error).toMatch(/unsupported_type/i);
    expect(await memoryExists(memory.id)).toBe(false);
    await deletable.reload();
    expect(deletable.status).toBe('deleted');
    await blocked.reload();
    // The row still points at the resource that could not be removed, so the
    // operator can find it.
    expect(blocked.status).toBe('created');
  });

  test('rollbackCreatedResources treats an already-gone resource as unwound', async () => {
    // `deleteAgent` throws RESOURCE_NOT_FOUND for a nonexistent agent id.
    const alreadyGone = await db.FormationResource.create({
      formationId,
      logicalId: uniqueName('rollback-gone'),
      resourceType: 'agent',
      status: 'created',
      physicalResourceId: 'agt_does_not_exist',
      deletionPolicy: 'delete',
    });
    const noPhysicalId = await db.FormationResource.create({
      formationId,
      logicalId: uniqueName('rollback-no-id'),
      resourceType: 'memory',
      status: 'failed',
      physicalResourceId: null,
      deletionPolicy: 'delete',
    });

    const events = await rollbackCreatedResources({
      actingUserId,
      projectId,
      created: [alreadyGone, noPhysicalId],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      logicalId: alreadyGone.logicalId,
      action: 'rollback',
      status: 'succeeded',
    });
    await alreadyGone.reload();
    expect(alreadyGone.status).toBe('deleted');
  });

  test('failFormationOperation records the event and marks operation/formation as failed', async () => {
    const formation = await db.Formation.create({
      projectId,
      name: uniqueName('fail-formation'),
      status: 'creating',
    });
    const operation = await db.FormationOperation.create({
      formationId: formation.id as number,
      operationType: 'create',
      status: 'running',
      events: null,
      plan: null,
      error: null,
    });

    const events: FormationEvent[] = [];
    await failFormationOperation({
      operation,
      formation,
      events,
      logicalId: 'provider',
      resourceType: 'memory',
      action: 'create',
      errorMessage: 'creation failed',
      errorCode: 'VALIDATION_FAILED',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      logicalId: 'provider',
      resourceType: 'memory',
      action: 'create',
      status: 'failed',
      error: 'creation failed',
    });

    await operation.reload();
    await formation.reload();
    expect(operation.status).toBe('failed');
    const error = {
      code: 'VALIDATION_FAILED',
      message: 'creation failed',
      meta: { logical_id: 'provider', resource_type: 'memory' },
    };
    expect(operation.error).toEqual(error);
    expect(operation.events).toEqual(events);
    expect(formation.status).toBe('failed');
    // The same bag lands on the formation, so the deploy response explains its
    // own `status: 'failed'` without a second call (#1028).
    expect(formation.error).toEqual(error);
  });
});
