import { db } from 'src/db';
import {
  applyCreateChange,
  applyUpdateChange,
  failFormationOperation,
} from 'src/lib/formationsApplyHelpers';
import type { FormationEvent } from 'src/lib/formationsTypes';
import { createMemory, getMemory } from 'src/lib/memories';

// These tests drive the real formation-apply helpers against the real database
// and the real resource handlers — no `db.*` stubbing and no internal-module
// mocks. `memory` is used as the physical resource because its create/update
// surface is minimal (`name` + `description`), which lets the merge/no-op
// decision logic be asserted through the real resource state it produces.

type ResourceRowWithId = InstanceType<(typeof db)['FormationResource']> & {
  physicalResourceId: string;
};

let projectId: number;
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
      resourceRow,
      existing: resourceRow as ResourceRowWithId,
      resourceType: 'memory',
      resolvedProperties: { name: 'New Name' },
      logicalId: 'memory',
      resolvedIds,
      events,
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
      resourceRow,
      existing: resourceRow as ResourceRowWithId,
      resourceType: 'memory',
      resolvedProperties: { name: 'No-op Mem' },
      logicalId: 'noop',
      resolvedIds,
      events,
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
      resourceRow,
      existing: resourceRow as ResourceRowWithId,
      resourceType: 'memory',
      resolvedProperties: { name: 'kept', description: undefined },
      logicalId: 'dropped',
      resolvedIds: new Map<string, string>(),
      events,
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
      resourceRow,
      existing: resourceRow as ResourceRowWithId,
      resourceType: 'memory',
      // name changed; description's param was kept (resolves to undefined) and
      // must be reused from lastApplied rather than dropped.
      resolvedProperties: { name: 'new-name', description: undefined },
      logicalId: 'merge',
      resolvedIds: new Map<string, string>(),
      events,
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
    expect(operation.error).toEqual({
      message: 'creation failed',
      logicalId: 'provider',
    });
    expect(operation.events).toEqual(events);
    expect(formation.status).toBe('failed');
  });
});
