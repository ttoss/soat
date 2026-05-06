import { db } from 'src/db';
import {
  createGenerationRecord,
  getGeneration,
  listGenerations,
  updateGenerationRecord,
} from 'src/lib/generations';

describe('generations', () => {
  let projectId: number;
  const agentId = 'agt_gen_lib_test_001';

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'Generations Lib Test' });
    projectId = project.id;
  });

  // ── createGenerationRecord ────────────────────────────────────────────────

  describe('createGenerationRecord', () => {
    test('creates a generation with in_progress status', async () => {
      const gen = await createGenerationRecord({
        publicId: 'gen_create_test001',
        projectId,
        agentId,
        traceId: 'trc_gen_create_001',
      });

      expect(gen.id).toBe('gen_create_test001');
      expect(gen.status).toBe('in_progress');
      expect(gen.projectId).toBe(projectId);
      expect(gen.agentId).toBe(agentId);
      expect(gen.traceId).toBe('trc_gen_create_001');
      expect(gen.completedAt).toBeNull();
      expect(gen.stopReason).toBeNull();
      expect(gen.lastActivityAt).toBeNull();
      expect(gen.initiatorGenerationId).toBeNull();
    });

    test('creates a generation with optional initiatorGenerationId', async () => {
      const gen = await createGenerationRecord({
        publicId: 'gen_create_test002',
        projectId,
        agentId,
        traceId: 'trc_gen_create_002',
        initiatorGenerationId: 'gen_parent_001',
        startedByPrincipalType: 'user',
        startedByPrincipalId: 'usr_test_001',
      });

      expect(gen.initiatorGenerationId).toBe('gen_parent_001');
      expect(gen.startedByPrincipalType).toBe('user');
      expect(gen.startedByPrincipalId).toBe('usr_test_001');
    });
  });

  // ── updateGenerationRecord ────────────────────────────────────────────────

  describe('updateGenerationRecord', () => {
    test('returns null when generation does not exist', async () => {
      const result = await updateGenerationRecord({
        publicId: 'gen_nonexistent_update',
        status: 'completed',
      });

      expect(result).toBeNull();
    });

    test('updates status and completedAt', async () => {
      await createGenerationRecord({
        publicId: 'gen_update_test001',
        projectId,
        agentId,
        traceId: 'trc_gen_update_001',
      });

      const completedAt = new Date();
      const result = await updateGenerationRecord({
        publicId: 'gen_update_test001',
        status: 'completed',
        completedAt,
        stopReason: 'stop',
      });

      expect(result).not.toBeNull();
      expect(result?.status).toBe('completed');
      expect(result?.stopReason).toBe('stop');
      expect(result?.completedAt).not.toBeNull();
    });

    test('updates lastActivityAt and metadata', async () => {
      await createGenerationRecord({
        publicId: 'gen_update_test002',
        projectId,
        agentId,
        traceId: 'trc_gen_update_002',
      });

      const result = await updateGenerationRecord({
        publicId: 'gen_update_test002',
        lastActivityAt: new Date(),
        metadata: { key: 'value' },
      });

      expect(result?.lastActivityAt).not.toBeNull();
      expect(result?.metadata).toEqual({ key: 'value' });
    });

    test('updates status to requires_action', async () => {
      await createGenerationRecord({
        publicId: 'gen_update_test003',
        projectId,
        agentId,
        traceId: 'trc_gen_update_003',
      });

      const result = await updateGenerationRecord({
        publicId: 'gen_update_test003',
        status: 'requires_action',
      });

      expect(result?.status).toBe('requires_action');
    });
  });

  // ── listGenerations ───────────────────────────────────────────────────────

  describe('listGenerations', () => {
    beforeAll(async () => {
      await createGenerationRecord({
        publicId: 'gen_list_test001',
        projectId,
        agentId: 'agt_list_001',
        traceId: 'trc_list_001',
      });

      await createGenerationRecord({
        publicId: 'gen_list_test002',
        projectId,
        agentId: 'agt_list_002',
        traceId: 'trc_list_002',
      });

      await updateGenerationRecord({
        publicId: 'gen_list_test002',
        status: 'completed',
        completedAt: new Date(),
      });
    });

    test('returns empty when projectIds is an empty array', async () => {
      const result = await listGenerations({ projectIds: [] });

      expect(result).toEqual({ data: [], total: 0, limit: 50, offset: 0 });
    });

    test('returns generations for given projectIds', async () => {
      const result = await listGenerations({ projectIds: [projectId] });

      expect(result.data.length).toBeGreaterThanOrEqual(2);
      expect(result.total).toBeGreaterThanOrEqual(2);
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
      expect(result.data[0].id).toBeDefined();
    });

    test('returns all generations when no filters provided', async () => {
      const result = await listGenerations({});

      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    test('filters by agentId', async () => {
      const result = await listGenerations({ agentId: 'agt_list_001' });

      expect(
        result.data.every((g) => {
          return g.agentId === 'agt_list_001';
        })
      ).toBe(true);
    });

    test('filters by status', async () => {
      const result = await listGenerations({
        status: 'completed',
        projectIds: [projectId],
      });

      expect(
        result.data.every((g) => {
          return g.status === 'completed';
        })
      ).toBe(true);
    });

    test('applies limit and offset', async () => {
      const result = await listGenerations({
        projectIds: [projectId],
        limit: 1,
        offset: 0,
      });

      expect(result.data).toHaveLength(1);
      expect(result.limit).toBe(1);
      expect(result.offset).toBe(0);
    });

    test('maps generation fields correctly', async () => {
      const result = await listGenerations({
        projectIds: [projectId],
        agentId: 'agt_list_001',
      });

      const gen = result.data[0];
      expect(gen.id).toBeDefined();
      expect(gen.projectId).toBe(projectId);
      expect(gen.agentId).toBe('agt_list_001');
      expect(gen.traceId).toBeDefined();
      expect(gen.status).toBe('in_progress');
      expect(gen.startedAt).toBeDefined();
      expect(gen.createdAt).toBeDefined();
      expect(gen.updatedAt).toBeDefined();
    });
  });

  // ── getGeneration ─────────────────────────────────────────────────────────

  describe('getGeneration', () => {
    beforeAll(async () => {
      await createGenerationRecord({
        publicId: 'gen_get_test001',
        projectId,
        agentId,
        traceId: 'trc_get_001',
      });
    });

    test('returns null for non-existent generation', async () => {
      const result = await getGeneration({ publicId: 'gen_nonexistent_0000' });

      expect(result).toBeNull();
    });

    test('returns generation by publicId', async () => {
      const result = await getGeneration({ publicId: 'gen_get_test001' });

      expect(result).not.toBeNull();
      expect(result?.id).toBe('gen_get_test001');
      expect(result?.projectId).toBe(projectId);
    });

    test('returns null when projectIds does not include the project', async () => {
      const result = await getGeneration({
        publicId: 'gen_get_test001',
        projectIds: [99999],
      });

      expect(result).toBeNull();
    });

    test('returns generation when projectIds includes the project', async () => {
      const result = await getGeneration({
        publicId: 'gen_get_test001',
        projectIds: [projectId],
      });

      expect(result?.id).toBe('gen_get_test001');
    });
  });
});
