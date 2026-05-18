/* eslint-disable @typescript-eslint/no-explicit-any */
import { db } from 'src/db';
import {
  createAgentFormation,
  deleteAgentFormation,
  getAgentFormation,
  listAgentFormationEvents,
  listAgentFormations,
  planAgentFormation,
  updateAgentFormation,
} from 'src/lib/agentFormations';
import * as agentFormationsApply from 'src/lib/agentFormationsApply';

const simpleTemplate = {
  resources: {
    MyMemory: { type: 'memory' as const, properties: { name: 'Test' } },
  },
};

describe('agentFormations lib', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── planAgentFormation ─────────────────────────────────────────────────────

  describe('planAgentFormation', () => {
    test('returns create action when no formationId provided', async () => {
      const result = await planAgentFormation({
        projectId: 1,
        template: simpleTemplate,
      });
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].action).toBe('create');
      expect(result.changes[0].logicalId).toBe('MyMemory');
    });

    test('returns update action when formationId matches existing resource', async () => {
      jest
        .spyOn(db.AgentFormation, 'findOne')
        .mockResolvedValue({ id: 1 } as any);
      jest
        .spyOn(db.AgentFormationResource, 'findAll')
        .mockResolvedValue([
          { logicalId: 'MyMemory', physicalResourceId: 'mem_1' } as any,
        ]);

      const result = await planAgentFormation({
        projectId: 1,
        template: simpleTemplate,
        formationId: 'af_exists',
      });
      expect(result.changes[0].action).toBe('update');
    });

    test('returns create action when formationId not found in DB', async () => {
      jest.spyOn(db.AgentFormation, 'findOne').mockResolvedValue(null);

      const result = await planAgentFormation({
        projectId: 1,
        template: simpleTemplate,
        formationId: 'af_missing',
      });
      expect(result.changes[0].action).toBe('create');
    });

    test('treats resource without physicalResourceId as create', async () => {
      jest
        .spyOn(db.AgentFormation, 'findOne')
        .mockResolvedValue({ id: 1 } as any);
      jest
        .spyOn(db.AgentFormationResource, 'findAll')
        .mockResolvedValue([
          { logicalId: 'MyMemory', physicalResourceId: null } as any,
        ]);

      const result = await planAgentFormation({
        projectId: 1,
        template: simpleTemplate,
        formationId: 'af_nophysical',
      });
      expect(result.changes[0].action).toBe('create');
    });
  });

  // ── createAgentFormation ───────────────────────────────────────────────────

  describe('createAgentFormation', () => {
    test('returns name_conflict when a formation with the same name exists', async () => {
      jest
        .spyOn(db.AgentFormation, 'findOne')
        .mockResolvedValue({ id: 1, name: 'dupe' } as any);

      const result = await createAgentFormation({
        projectId: 1,
        name: 'dupe',
        template: simpleTemplate,
      });
      expect(result).toBe('name_conflict');
    });
  });

  // ── listAgentFormations ────────────────────────────────────────────────────

  describe('listAgentFormations', () => {
    test('returns empty array when no formations exist', async () => {
      jest.spyOn(db.AgentFormation, 'findAll').mockResolvedValue([]);
      const result = await listAgentFormations({ projectIds: [9999] });
      expect(result).toEqual([]);
    });

    test('maps formation without resources when includeResources is false', async () => {
      jest.spyOn(db.AgentFormation, 'findAll').mockResolvedValue([
        {
          publicId: 'af_1',
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

      const result = await listAgentFormations({ projectIds: [1] });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('af_1');
      expect(result[0].resources).toBeUndefined();
    });
  });

  // ── getAgentFormation ──────────────────────────────────────────────────────

  describe('getAgentFormation', () => {
    test('returns null when formation not found', async () => {
      jest.spyOn(db.AgentFormation, 'findOne').mockResolvedValue(null);
      const result = await getAgentFormation({ id: 'af_missing' });
      expect(result).toBeNull();
    });

    test('returns formation with resources when found', async () => {
      jest.spyOn(db.AgentFormation, 'findOne').mockResolvedValue({
        publicId: 'af_1',
        project: { publicId: 'proj_1' },
        agentFormationResources: [
          {
            publicId: 'afr_1',
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

      const result = await getAgentFormation({ id: 'af_1' });
      expect(result).not.toBeNull();
      expect(result!.id).toBe('af_1');
      expect(result!.resources).toHaveLength(1);
      expect(result!.resources![0].logicalId).toBe('MyMemory');
    });
  });

  // ── updateAgentFormation ───────────────────────────────────────────────────

  describe('updateAgentFormation', () => {
    test('returns null when formation not found', async () => {
      jest.spyOn(db.AgentFormation, 'findOne').mockResolvedValue(null);
      const result = await updateAgentFormation({
        id: 'af_missing',
        template: simpleTemplate,
      });
      expect(result).toBeNull();
    });

    test('updates metadata when provided alongside template', async () => {
      const mockFormation = {
        id: 1,
        publicId: 'af_test',
        projectId: 1,
        template: simpleTemplate,
        update: jest.fn().mockResolvedValue(undefined),
      };
      const refreshed = {
        publicId: 'af_test',
        project: { publicId: 'proj_1' },
        agentFormationResources: [],
        name: 'test',
        template: null,
        outputs: null,
        status: 'active',
        metadata: { env: 'test' },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(db.AgentFormation, 'findOne')
        .mockResolvedValueOnce(mockFormation as any)
        .mockResolvedValueOnce(refreshed as any);
      jest.spyOn(db.AgentFormationOperation, 'create').mockResolvedValue({
        id: 1,
        update: jest.fn().mockResolvedValue(undefined),
      } as any);
      jest.spyOn(db.AgentFormationResource, 'findAll').mockResolvedValue([]);
      jest
        .spyOn(agentFormationsApply, 'applyFormationTemplate')
        .mockResolvedValue(undefined);

      const result = await updateAgentFormation({
        id: 'af_test',
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
        publicId: 'af_test',
        projectId: 1,
        template: simpleTemplate,
        update: jest.fn().mockResolvedValue(undefined),
      };
      const refreshed = {
        publicId: 'af_test',
        project: { publicId: 'proj_1' },
        agentFormationResources: [],
        name: 'test',
        template: null,
        outputs: null,
        status: 'active',
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(db.AgentFormation, 'findOne')
        .mockResolvedValueOnce(mockFormation as any)
        .mockResolvedValueOnce(refreshed as any);
      jest.spyOn(db.AgentFormationOperation, 'create').mockResolvedValue({
        id: 1,
        update: jest.fn().mockResolvedValue(undefined),
      } as any);
      jest.spyOn(db.AgentFormationResource, 'findAll').mockResolvedValue([]);
      jest
        .spyOn(agentFormationsApply, 'applyFormationTemplate')
        .mockResolvedValue(undefined);

      await updateAgentFormation({ id: 'af_test', template: simpleTemplate });

      const metadataUpdateCalls = mockFormation.update.mock.calls.filter(
        (call: any[]) => {
          return 'metadata' in call[0];
        }
      );
      expect(metadataUpdateCalls).toHaveLength(0);
    });
  });

  // ── deleteAgentFormation ───────────────────────────────────────────────────

  describe('deleteAgentFormation', () => {
    test('returns null when formation not found', async () => {
      jest.spyOn(db.AgentFormation, 'findOne').mockResolvedValue(null);
      const result = await deleteAgentFormation({ id: 'af_missing' });
      expect(result).toBeNull();
    });

    test('returns success: false and marks operation failed when deletion has errors', async () => {
      const mockOperation = { update: jest.fn().mockResolvedValue(undefined) };
      const mockFormation = {
        id: 1,
        publicId: 'af_test',
        template: null,
        update: jest.fn().mockResolvedValue(undefined),
      };

      jest
        .spyOn(db.AgentFormation, 'findOne')
        .mockResolvedValue(mockFormation as any);
      jest
        .spyOn(db.AgentFormationOperation, 'create')
        .mockResolvedValue(mockOperation as any);
      jest.spyOn(db.AgentFormationResource, 'findAll').mockResolvedValue([]);
      jest
        .spyOn(agentFormationsApply, 'performResourceDeletions')
        .mockResolvedValue({ events: [], hasError: true });

      const result = await deleteAgentFormation({ id: 'af_test' });
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
        publicId: 'af_test',
        name: 'af_test',
        template: null,
        update: jest.fn().mockResolvedValue(undefined),
      };

      jest
        .spyOn(db.AgentFormation, 'findOne')
        .mockResolvedValue(mockFormation as any);
      jest
        .spyOn(db.AgentFormationOperation, 'create')
        .mockResolvedValue(mockOperation as any);
      jest.spyOn(db.AgentFormationResource, 'findAll').mockResolvedValue([]);
      jest
        .spyOn(agentFormationsApply, 'performResourceDeletions')
        .mockResolvedValue({ events: [], hasError: false });

      const result = await deleteAgentFormation({ id: 'af_test' });
      expect(result).toEqual({ success: true });
      expect(mockOperation.update).toHaveBeenCalledWith({
        status: 'succeeded',
        events: [],
      });
      expect(mockFormation.update).toHaveBeenCalledWith({
        status: 'deleted',
        name: 'af_test__deleted__af_test',
      });
    });
  });

  // ── listAgentFormationEvents ───────────────────────────────────────────────

  describe('listAgentFormationEvents', () => {
    test('returns empty array when formation not found', async () => {
      jest.spyOn(db.AgentFormation, 'findOne').mockResolvedValue(null);
      const result = await listAgentFormationEvents({
        formationId: 'af_missing',
      });
      expect(result).toEqual([]);
    });

    test('returns mapped operations for existing formation', async () => {
      jest
        .spyOn(db.AgentFormation, 'findOne')
        .mockResolvedValue({ id: 1 } as any);
      jest.spyOn(db.AgentFormationOperation, 'findAll').mockResolvedValue([
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

      const result = await listAgentFormationEvents({ formationId: 'af_1' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('op_1');
      expect(result[0].operationType).toBe('create');
      expect(result[0].status).toBe('succeeded');
    });
  });
});
