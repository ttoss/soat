import { db } from 'src/db';
import * as memoryStoresFormationModule from 'src/lib/formation-modules/memoryStoresFormationModule';
import {
  computeOrphanedPlanChanges,
  planResourceChange,
} from 'src/lib/formationsPlanHelpers';
import { createMemoryStore } from 'src/lib/memoryStores';
import { createSecret } from 'src/lib/secrets';

// Every resourceType's `read` swallows its own errors and returns null, so
// `planResourceChange`'s "read failed" branch is unreachable from any entry
// point — one `jest.spyOn` forces it, the sanctioned force-failure pattern.

let projectId: number;
let memoryStoreCounter = 0;

const uniqueName = (prefix: string) => {
  memoryStoreCounter += 1;
  return `${prefix}-${memoryStoreCounter}`;
};

describe('formationsPlanHelpers', () => {
  beforeAll(async () => {
    const project = await db.Project.create({
      name: 'Formations Plan Helpers Test Project',
    });
    projectId = project.id as number;
  });

  describe('planResourceChange', () => {
    test('reports create when there is no physical resource yet', async () => {
      const change = await planResourceChange({
        projectId,
        logicalId: 'MyMemoryStore',
        decl: { type: 'memory_store', properties: { name: 'unprovisioned' } },
        physicalResourceId: undefined,
        resolvedParams: new Map(),
        existingMap: new Map(),
        templateResourceKeys: new Set(['MyMemoryStore']),
      });

      expect(change).toEqual({
        logicalId: 'MyMemoryStore',
        resourceType: 'memory_store',
        action: 'create',
        diff: { desired: { name: 'unprovisioned' }, current: null },
      });
    });

    test('falls back to update when the resource type has no registered formation module', async () => {
      const change = await planResourceChange({
        projectId,
        logicalId: 'Ghost',
        decl: { type: 'nonexistent_type', properties: {} },
        physicalResourceId: 'ghost_1',
        resolvedParams: new Map(),
        existingMap: new Map(),
        templateResourceKeys: new Set(['Ghost']),
      });

      expect(change.action).toBe('update');
    });

    test('reports no-op when the live properties match the resolved template', async () => {
      const memoryStore = await createMemoryStore({
        projectId,
        name: uniqueName('plan-helpers-mem'),
      });

      const change = await planResourceChange({
        projectId,
        logicalId: 'MyMemoryStore',
        decl: { type: 'memory_store', properties: { name: memoryStore.name } },
        physicalResourceId: memoryStore.id,
        resolvedParams: new Map(),
        existingMap: new Map(),
        templateResourceKeys: new Set(['MyMemoryStore']),
      });

      expect(change).toEqual({
        logicalId: 'MyMemoryStore',
        resourceType: 'memory_store',
        physicalResourceId: memoryStore.id,
        action: 'no-op',
        diff: {
          desired: { name: memoryStore.name },
          current: expect.objectContaining({ name: memoryStore.name }),
        },
      });
    });

    test('reports update when a resolved property differs from the live value', async () => {
      const memoryStore = await createMemoryStore({
        projectId,
        name: uniqueName('plan-helpers-mem'),
      });

      const change = await planResourceChange({
        projectId,
        logicalId: 'MyMemoryStore',
        decl: {
          type: 'memory_store',
          properties: { name: 'a different name' },
        },
        physicalResourceId: memoryStore.id,
        resolvedParams: new Map(),
        existingMap: new Map(),
        templateResourceKeys: new Set(['MyMemoryStore']),
      });

      expect(change.action).toBe('update');
    });

    test('reports update when a property ref cannot yet be resolved against existingMap', async () => {
      const memoryStore = await createMemoryStore({
        projectId,
        name: uniqueName('plan-helpers-mem'),
      });

      // `existingMap` intentionally omits `NotYetCreated` — resolveRefs throws
      // internally, is caught, and the unresolved ref object never equals the
      // live string value, so the conservative 'update' is reported.
      const change = await planResourceChange({
        projectId,
        logicalId: 'MyMemoryStore',
        decl: {
          type: 'memory_store',
          properties: { name: { ref: 'NotYetCreated' } },
        },
        physicalResourceId: memoryStore.id,
        resolvedParams: new Map(),
        existingMap: new Map(),
        templateResourceKeys: new Set(['MyMemoryStore']),
      });

      expect(change.action).toBe('update');
    });

    test('reports update when the underlying resource was deleted externally (read returns null)', async () => {
      const change = await planResourceChange({
        projectId,
        logicalId: 'MyMemoryStore',
        decl: { type: 'memory_store', properties: { name: 'anything' } },
        physicalResourceId: 'mstore_does_not_exist',
        resolvedParams: new Map(),
        existingMap: new Map(),
        templateResourceKeys: new Set(['MyMemoryStore']),
      });

      expect(change.action).toBe('update');
    });

    test('falls back to update when the module read throws', async () => {
      const memoryStore = await createMemoryStore({
        projectId,
        name: uniqueName('plan-helpers-mem'),
      });
      const readSpy = jest
        .spyOn(memoryStoresFormationModule.memoryStoresFormationModule, 'read')
        .mockRejectedValueOnce(new Error('unexpected read failure'));

      try {
        const change = await planResourceChange({
          projectId,
          logicalId: 'MyMemoryStore',
          decl: {
            type: 'memory_store',
            properties: { name: memoryStore.name },
          },
          physicalResourceId: memoryStore.id,
          resolvedParams: new Map(),
          existingMap: new Map(),
          templateResourceKeys: new Set(['MyMemoryStore']),
        });

        expect(change.action).toBe('update');
      } finally {
        readSpy.mockRestore();
      }
    });
  });

  describe('planResourceChange for write-only resources (secrets)', () => {
    test('reports no-op for an unchanged secret compared against lastAppliedProperties', async () => {
      const secretName = uniqueName('plan-helpers-secret');
      const secret = await createSecret({
        projectId,
        name: secretName,
        value: 'super-secret-value',
      });

      // `value` is omitted (use_previous_value) so it resolves to undefined;
      // lastAppliedProperties mirrors what sanitizeLastAppliedProperties
      // persists — the value is stripped, only `name` remains.
      const change = await planResourceChange({
        projectId,
        logicalId: 'MySecret',
        decl: { type: 'secret', properties: { name: secretName } },
        physicalResourceId: secret.id,
        resolvedParams: new Map(),
        existingMap: new Map(),
        templateResourceKeys: new Set(['MySecret']),
        lastAppliedProperties: { name: secretName },
      });

      expect(change.action).toBe('no-op');
    });

    test('reports update for a secret whose resolved name differs from lastAppliedProperties', async () => {
      const secretName = uniqueName('plan-helpers-secret');
      const secret = await createSecret({
        projectId,
        name: secretName,
        value: 'super-secret-value',
      });

      const change = await planResourceChange({
        projectId,
        logicalId: 'MySecret',
        decl: { type: 'secret', properties: { name: 'a different name' } },
        physicalResourceId: secret.id,
        resolvedParams: new Map(),
        existingMap: new Map(),
        templateResourceKeys: new Set(['MySecret']),
        lastAppliedProperties: { name: secretName },
      });

      expect(change.action).toBe('update');
    });

    test('falls back to update for a secret with no lastAppliedProperties snapshot', async () => {
      const secretName = uniqueName('plan-helpers-secret');
      const secret = await createSecret({
        projectId,
        name: secretName,
        value: 'super-secret-value',
      });

      const change = await planResourceChange({
        projectId,
        logicalId: 'MySecret',
        decl: { type: 'secret', properties: { name: secretName } },
        physicalResourceId: secret.id,
        resolvedParams: new Map(),
        existingMap: new Map(),
        templateResourceKeys: new Set(['MySecret']),
      });

      expect(change.action).toBe('update');
    });
  });

  describe('computeOrphanedPlanChanges', () => {
    const buildResource = (args: {
      logicalId: string;
      resourceType: string;
      physicalResourceId: string | null;
      status: string;
    }) => {
      return db.FormationResource.build({
        publicId: `fmr_${args.logicalId}`,
        formationId: 1,
        logicalId: args.logicalId,
        resourceType: args.resourceType,
        physicalResourceId: args.physicalResourceId,
        status: args.status,
        deletionPolicy: 'delete',
      });
    };

    test('reports a delete change for a resource the template no longer declares', () => {
      const removed = buildResource({
        logicalId: 'RemoveMe',
        resourceType: 'memory_store',
        physicalResourceId: 'mstore_1',
        status: 'created',
      });

      const changes = computeOrphanedPlanChanges({
        templateResourceKeys: new Set(),
        existingResources: [removed],
      });

      expect(changes).toEqual([
        {
          logicalId: 'RemoveMe',
          resourceType: 'memory_store',
          physicalResourceId: 'mstore_1',
          action: 'delete',
        },
      ]);
    });

    test('excludes a resource the template still declares', () => {
      const kept = buildResource({
        logicalId: 'KeepMe',
        resourceType: 'memory_store',
        physicalResourceId: 'mstore_2',
        status: 'created',
      });

      const changes = computeOrphanedPlanChanges({
        templateResourceKeys: new Set(['KeepMe']),
        existingResources: [kept],
      });

      expect(changes).toEqual([]);
    });

    test('excludes a row with no physical resource id yet', () => {
      const pending = buildResource({
        logicalId: 'Pending',
        resourceType: 'memory_store',
        physicalResourceId: null,
        status: 'pending',
      });

      const changes = computeOrphanedPlanChanges({
        templateResourceKeys: new Set(),
        existingResources: [pending],
      });

      expect(changes).toEqual([]);
    });

    test('excludes a resource already tombstoned from a prior deploy', () => {
      const tombstoned = buildResource({
        logicalId: 'AlreadyGone',
        resourceType: 'memory_store',
        physicalResourceId: 'mstore_3',
        status: 'deleted',
      });

      const changes = computeOrphanedPlanChanges({
        templateResourceKeys: new Set(),
        existingResources: [tombstoned],
      });

      expect(changes).toEqual([]);
    });
  });
});
