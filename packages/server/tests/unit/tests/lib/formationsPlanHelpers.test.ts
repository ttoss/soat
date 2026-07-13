import { db } from 'src/db';
import * as memoriesFormationModule from 'src/lib/formation-modules/memoriesFormationModule';
import {
  computeOrphanedPlanChanges,
  planResourceChange,
} from 'src/lib/formationsPlanHelpers';
import { createMemory } from 'src/lib/memories';

// These tests drive the extracted plan-diffing helpers directly with real
// inputs (a real Memory row for the read-diff paths), following the
// pure-algorithm keep-list rule in tests.md: every resourceType's `read`
// swallows its own errors and returns null, so the outer "read failed"
// resilience branch in `planResourceChange` cannot be reached by any real
// entry point — a single `jest.spyOn` forces that one branch, matching the
// sanctioned "force-failure stub for a .catch() resilience branch" pattern.

let projectId: number;
let memoryCounter = 0;

const uniqueName = (prefix: string) => {
  memoryCounter += 1;
  return `${prefix}-${memoryCounter}`;
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
        logicalId: 'MyMemory',
        decl: { type: 'memory', properties: { name: 'unprovisioned' } },
        physicalResourceId: undefined,
        resolvedParams: new Map(),
        existingMap: new Map(),
      });

      expect(change).toEqual({
        logicalId: 'MyMemory',
        resourceType: 'memory',
        action: 'create',
      });
    });

    test('falls back to update when the resource type has no registered formation module', async () => {
      const change = await planResourceChange({
        logicalId: 'Ghost',
        decl: { type: 'nonexistent_type', properties: {} },
        physicalResourceId: 'ghost_1',
        resolvedParams: new Map(),
        existingMap: new Map(),
      });

      expect(change.action).toBe('update');
    });

    test('reports no-op when the live properties match the resolved template', async () => {
      const memory = await createMemory({
        projectId,
        name: uniqueName('plan-helpers-mem'),
      });

      const change = await planResourceChange({
        logicalId: 'MyMemory',
        decl: { type: 'memory', properties: { name: memory.name } },
        physicalResourceId: memory.id,
        resolvedParams: new Map(),
        existingMap: new Map(),
      });

      expect(change).toEqual({
        logicalId: 'MyMemory',
        resourceType: 'memory',
        physicalResourceId: memory.id,
        action: 'no-op',
      });
    });

    test('reports update when a resolved property differs from the live value', async () => {
      const memory = await createMemory({
        projectId,
        name: uniqueName('plan-helpers-mem'),
      });

      const change = await planResourceChange({
        logicalId: 'MyMemory',
        decl: { type: 'memory', properties: { name: 'a different name' } },
        physicalResourceId: memory.id,
        resolvedParams: new Map(),
        existingMap: new Map(),
      });

      expect(change.action).toBe('update');
    });

    test('reports update when a property ref cannot yet be resolved against existingMap', async () => {
      const memory = await createMemory({
        projectId,
        name: uniqueName('plan-helpers-mem'),
      });

      // `existingMap` intentionally omits `NotYetCreated` — resolveRefs throws
      // internally, is caught, and the unresolved ref object never equals the
      // live string value, so the conservative 'update' is reported.
      const change = await planResourceChange({
        logicalId: 'MyMemory',
        decl: {
          type: 'memory',
          properties: { name: { ref: 'NotYetCreated' } },
        },
        physicalResourceId: memory.id,
        resolvedParams: new Map(),
        existingMap: new Map(),
      });

      expect(change.action).toBe('update');
    });

    test('reports update when the underlying resource was deleted externally (read returns null)', async () => {
      const change = await planResourceChange({
        logicalId: 'MyMemory',
        decl: { type: 'memory', properties: { name: 'anything' } },
        physicalResourceId: 'mem_does_not_exist',
        resolvedParams: new Map(),
        existingMap: new Map(),
      });

      expect(change.action).toBe('update');
    });

    test('falls back to update when the module read throws', async () => {
      const memory = await createMemory({
        projectId,
        name: uniqueName('plan-helpers-mem'),
      });
      const readSpy = jest
        .spyOn(memoriesFormationModule.memoriesFormationModule, 'read')
        .mockRejectedValueOnce(new Error('unexpected read failure'));

      try {
        const change = await planResourceChange({
          logicalId: 'MyMemory',
          decl: { type: 'memory', properties: { name: memory.name } },
          physicalResourceId: memory.id,
          resolvedParams: new Map(),
          existingMap: new Map(),
        });

        expect(change.action).toBe('update');
      } finally {
        readSpy.mockRestore();
      }
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
        resourceType: 'memory',
        physicalResourceId: 'mem_1',
        status: 'created',
      });

      const changes = computeOrphanedPlanChanges({
        templateResourceKeys: new Set(),
        existingResources: [removed],
      });

      expect(changes).toEqual([
        {
          logicalId: 'RemoveMe',
          resourceType: 'memory',
          physicalResourceId: 'mem_1',
          action: 'delete',
        },
      ]);
    });

    test('excludes a resource the template still declares', () => {
      const kept = buildResource({
        logicalId: 'KeepMe',
        resourceType: 'memory',
        physicalResourceId: 'mem_2',
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
        resourceType: 'memory',
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
        resourceType: 'memory',
        physicalResourceId: 'mem_3',
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
