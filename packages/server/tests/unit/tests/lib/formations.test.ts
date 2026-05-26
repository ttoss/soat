/* eslint-disable @typescript-eslint/no-explicit-any */
import { db } from 'src/db';
import {
  createFormation,
  deleteFormation,
  getFormation,
  listFormationEvents,
  listFormations,
  planFormation,
  updateFormation,
} from 'src/lib/formations';
import * as formationsApply from 'src/lib/formationsApply';
import * as formationsRegistry from 'src/lib/formationsRegistry';

const simpleTemplate = {
  resources: {
    MyMemory: { type: 'memory' as const, properties: { name: 'Test' } },
  },
};

describe('formations lib', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── planFormation ─────────────────────────────────────────────────────

  describe('planFormation', () => {
    test('returns create action when no formationId provided', async () => {
      const result = await planFormation({
        projectId: 1,
        template: simpleTemplate,
      });
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].action).toBe('create');
      expect(result.changes[0].logicalId).toBe('MyMemory');
    });

    test('returns update action when formationId matches existing resource', async () => {
      jest.spyOn(db.Formation, 'findOne').mockResolvedValue({ id: 1 } as any);
      jest
        .spyOn(db.FormationResource, 'findAll')
        .mockResolvedValue([
          { logicalId: 'MyMemory', physicalResourceId: 'mem_1' } as any,
        ]);

      const result = await planFormation({
        projectId: 1,
        template: simpleTemplate,
        formationId: 'form_exists',
      });
      expect(result.changes[0].action).toBe('update');
    });

    test('returns create action when formationId not found in DB', async () => {
      jest.spyOn(db.Formation, 'findOne').mockResolvedValue(null);

      const result = await planFormation({
        projectId: 1,
        template: simpleTemplate,
        formationId: 'form_missing',
      });
      expect(result.changes[0].action).toBe('create');
    });

    test('treats resource without physicalResourceId as create', async () => {
      jest.spyOn(db.Formation, 'findOne').mockResolvedValue({ id: 1 } as any);
      jest
        .spyOn(db.FormationResource, 'findAll')
        .mockResolvedValue([
          { logicalId: 'MyMemory', physicalResourceId: null } as any,
        ]);

      const result = await planFormation({
        projectId: 1,
        template: simpleTemplate,
        formationId: 'form_nophysical',
      });
      expect(result.changes[0].action).toBe('create');
    });

    test('returns no-op when module.read matches template properties', async () => {
      jest.spyOn(db.Formation, 'findOne').mockResolvedValue({ id: 1 } as any);
      jest
        .spyOn(db.FormationResource, 'findAll')
        .mockResolvedValue([
          { logicalId: 'MyMemory', physicalResourceId: 'mem_1' } as any,
        ]);
      jest.spyOn(formationsRegistry, 'getFormationModule').mockReturnValue({
        resourceType: 'memory',
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        read: jest.fn().mockResolvedValue({ name: 'Test' }),
      });

      const result = await planFormation({
        projectId: 1,
        template: simpleTemplate,
        formationId: 'form_noop',
      });
      expect(result.changes[0].action).toBe('no-op');
      expect(result.changes[0].physicalResourceId).toBe('mem_1');
    });

    test('returns update when module.read differs from template properties', async () => {
      jest.spyOn(db.Formation, 'findOne').mockResolvedValue({ id: 1 } as any);
      jest
        .spyOn(db.FormationResource, 'findAll')
        .mockResolvedValue([
          { logicalId: 'MyMemory', physicalResourceId: 'mem_1' } as any,
        ]);
      jest.spyOn(formationsRegistry, 'getFormationModule').mockReturnValue({
        resourceType: 'memory',
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        read: jest.fn().mockResolvedValue({ name: 'OldName' }),
      });

      const result = await planFormation({
        projectId: 1,
        template: simpleTemplate,
        formationId: 'form_diff',
      });
      expect(result.changes[0].action).toBe('update');
      expect(result.changes[0].physicalResourceId).toBe('mem_1');
    });

    test('returns update when module.read returns null (drift)', async () => {
      jest.spyOn(db.Formation, 'findOne').mockResolvedValue({ id: 1 } as any);
      jest
        .spyOn(db.FormationResource, 'findAll')
        .mockResolvedValue([
          { logicalId: 'MyMemory', physicalResourceId: 'mem_1' } as any,
        ]);
      jest.spyOn(formationsRegistry, 'getFormationModule').mockReturnValue({
        resourceType: 'memory',
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        read: jest.fn().mockResolvedValue(null),
      });

      const result = await planFormation({
        projectId: 1,
        template: simpleTemplate,
        formationId: 'form_drift',
      });
      expect(result.changes[0].action).toBe('update');
    });

    test('includes physicalResourceId on update when no read method', async () => {
      jest.spyOn(db.Formation, 'findOne').mockResolvedValue({ id: 1 } as any);
      jest
        .spyOn(db.FormationResource, 'findAll')
        .mockResolvedValue([
          { logicalId: 'MyMemory', physicalResourceId: 'mem_1' } as any,
        ]);

      const result = await planFormation({
        projectId: 1,
        template: simpleTemplate,
        formationId: 'form_exists',
      });
      expect(result.changes[0].physicalResourceId).toBe('mem_1');
    });
  });

  // ── createFormation ───────────────────────────────────────────────────

  describe('createFormation', () => {
    test('throws DomainError on name conflict', async () => {
      jest
        .spyOn(db.Formation, 'findOne')
        .mockResolvedValue({ id: 1, name: 'dupe' } as any);

      await expect(
        createFormation({
          projectId: 1,
          name: 'dupe',
          template: simpleTemplate,
        })
      ).rejects.toThrow('already exists');
    });
  });

  // ── listFormations ────────────────────────────────────────────────────

  describe('listFormations', () => {
    test('returns empty array when no formations exist', async () => {
      jest.spyOn(db.Formation, 'findAll').mockResolvedValue([]);
      const result = await listFormations({ projectIds: [9999] });
      expect(result).toEqual([]);
    });

    test('maps formation without resources when includeResources is false', async () => {
      jest.spyOn(db.Formation, 'findAll').mockResolvedValue([
        {
          publicId: 'form_1',
          project: { publicId: 'proj_1' },
          name: 'test',
          template: null,
          outputs: null,
          status: 'active',
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
      ]);

      const result = await listFormations({ projectIds: [1] });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('form_1');
      expect(result[0].resources).toBeUndefined();
    });
  });

  // ── getFormation ──────────────────────────────────────────────────────

  describe('getFormation', () => {
    test('throws DomainError when formation not found', async () => {
      jest.spyOn(db.Formation, 'findOne').mockResolvedValue(null);
      await expect(getFormation({ id: 'form_missing' })).rejects.toThrow(
        'not found'
      );
    });

    test('returns formation with resources when found', async () => {
      jest.spyOn(db.Formation, 'findOne').mockResolvedValue({
        publicId: 'form_1',
        project: { publicId: 'proj_1' },
        formationResources: [
          {
            publicId: 'fmr_1',
            logicalId: 'MyMemory',
            resourceType: 'memory',
            physicalResourceId: 'mem_1',
            status: 'created',
          },
        ],
        name: 'test',
        template: null,
        outputs: null,
        status: 'active',
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const result = await getFormation({ id: 'form_1' });
      expect(result).not.toBeNull();
      expect(result!.id).toBe('form_1');
      expect(result!.resources).toHaveLength(1);
      expect(result!.resources![0].logicalId).toBe('MyMemory');
    });
  });

  // ── updateFormation ───────────────────────────────────────────────────

  describe('updateFormation', () => {
    test('throws DomainError when formation not found', async () => {
      jest.spyOn(db.Formation, 'findOne').mockResolvedValue(null);
      await expect(
        updateFormation({
          id: 'form_missing',
          template: simpleTemplate,
        })
      ).rejects.toThrow('not found');
    });

    test('updates metadata when provided alongside template', async () => {
      const mockFormation = {
        id: 1,
        publicId: 'form_test',
        projectId: 1,
        template: simpleTemplate,
        update: jest.fn().mockResolvedValue(undefined),
      };
      const refreshed = {
        publicId: 'form_test',
        project: { publicId: 'proj_1' },
        formationResources: [],
        name: 'test',
        template: null,
        outputs: null,
        status: 'active',
        metadata: { env: 'test' },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(db.Formation, 'findOne')
        .mockResolvedValueOnce(mockFormation as any)
        .mockResolvedValueOnce(refreshed as any);
      jest.spyOn(db.FormationOperation, 'create').mockResolvedValue({
        id: 1,
        update: jest.fn().mockResolvedValue(undefined),
      } as any);
      jest.spyOn(db.FormationResource, 'findAll').mockResolvedValue([]);
      jest
        .spyOn(formationsApply, 'applyFormationTemplate')
        .mockResolvedValue(undefined);

      const result = await updateFormation({
        id: 'form_test',
        template: simpleTemplate,
        metadata: { env: 'test' },
      });

      expect(mockFormation.update).toHaveBeenCalledWith({
        metadata: { env: 'test' },
      });
      expect(result).not.toBeNull();
      expect(result!.metadata).toEqual({ env: 'test' });
    });

    test('does not update metadata when not provided', async () => {
      const mockFormation = {
        id: 1,
        publicId: 'form_test',
        projectId: 1,
        template: simpleTemplate,
        update: jest.fn().mockResolvedValue(undefined),
      };
      const refreshed = {
        publicId: 'form_test',
        project: { publicId: 'proj_1' },
        formationResources: [],
        name: 'test',
        template: null,
        outputs: null,
        status: 'active',
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(db.Formation, 'findOne')
        .mockResolvedValueOnce(mockFormation as any)
        .mockResolvedValueOnce(refreshed as any);
      jest.spyOn(db.FormationOperation, 'create').mockResolvedValue({
        id: 1,
        update: jest.fn().mockResolvedValue(undefined),
      } as any);
      jest.spyOn(db.FormationResource, 'findAll').mockResolvedValue([]);
      jest
        .spyOn(formationsApply, 'applyFormationTemplate')
        .mockResolvedValue(undefined);

      await updateFormation({ id: 'form_test', template: simpleTemplate });

      const metadataUpdateCalls = mockFormation.update.mock.calls.filter(
        (call: any[]) => {
          return 'metadata' in call[0];
        }
      );
      expect(metadataUpdateCalls).toHaveLength(0);
    });
  });

  // ── deleteFormation ───────────────────────────────────────────────────

  describe('deleteFormation', () => {
    test('throws DomainError when formation not found', async () => {
      jest.spyOn(db.Formation, 'findOne').mockResolvedValue(null);
      await expect(deleteFormation({ id: 'form_missing' })).rejects.toThrow(
        'not found'
      );
    });

    test('returns success: false and marks operation failed when deletion has errors', async () => {
      const mockOperation = { update: jest.fn().mockResolvedValue(undefined) };
      const mockFormation = {
        id: 1,
        publicId: 'form_test',
        template: null,
        update: jest.fn().mockResolvedValue(undefined),
      };

      jest
        .spyOn(db.Formation, 'findOne')
        .mockResolvedValue(mockFormation as any);
      jest
        .spyOn(db.FormationOperation, 'create')
        .mockResolvedValue(mockOperation as any);
      jest.spyOn(db.FormationResource, 'findAll').mockResolvedValue([]);
      jest
        .spyOn(formationsApply, 'performResourceDeletions')
        .mockResolvedValue({ events: [], hasError: true });

      const result = await deleteFormation({ id: 'form_test' });
      expect(result).toEqual({ success: false });
      expect(mockOperation.update).toHaveBeenCalledWith({
        status: 'failed',
        events: [],
      });
      expect(mockFormation.update).toHaveBeenCalledWith({
        status: 'delete_failed',
      });
    });

    test('returns success: true when all resources deleted without errors', async () => {
      const mockOperation = { update: jest.fn().mockResolvedValue(undefined) };
      const mockFormation = {
        id: 1,
        publicId: 'form_test',
        name: 'form_test',
        template: null,
        update: jest.fn().mockResolvedValue(undefined),
      };

      jest
        .spyOn(db.Formation, 'findOne')
        .mockResolvedValue(mockFormation as any);
      jest
        .spyOn(db.FormationOperation, 'create')
        .mockResolvedValue(mockOperation as any);
      jest.spyOn(db.FormationResource, 'findAll').mockResolvedValue([]);
      jest
        .spyOn(formationsApply, 'performResourceDeletions')
        .mockResolvedValue({ events: [], hasError: false });

      const result = await deleteFormation({ id: 'form_test' });
      expect(result).toEqual({ success: true });
      expect(mockOperation.update).toHaveBeenCalledWith({
        status: 'succeeded',
        events: [],
      });
      expect(mockFormation.update).toHaveBeenCalledWith({
        status: 'deleted',
        name: 'form_test__deleted__form_test',
      });
    });
  });

  // ── listFormationEvents ───────────────────────────────────────────────

  describe('listFormationEvents', () => {
    test('returns empty array when formation not found', async () => {
      jest.spyOn(db.Formation, 'findOne').mockResolvedValue(null);
      const result = await listFormationEvents({
        formationId: 'form_missing',
      });
      expect(result).toEqual([]);
    });

    test('returns mapped operations for existing formation', async () => {
      jest.spyOn(db.Formation, 'findOne').mockResolvedValue({ id: 1 } as any);
      jest.spyOn(db.FormationOperation, 'findAll').mockResolvedValue([
        {
          publicId: 'op_1',
          operationType: 'create',
          status: 'succeeded',
          events: [],
          plan: null,
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
      ]);

      const result = await listFormationEvents({ formationId: 'form_1' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('op_1');
      expect(result[0].operationType).toBe('create');
      expect(result[0].status).toBe('succeeded');
    });
  });
});
