import { db } from 'src/db';
import {
  createGenerationRecord,
  updateGenerationRecord,
} from 'src/lib/generations';

describe('generations', () => {
  let projectId: number;
  let projectPublicId: string;
  let aiProviderId: number;
  const agentId = 'agt_gen_lib_test_001';

  const ensureAgent = async (publicId: string) => {
    const existing = await db.Agent.findOne({ where: { publicId, projectId } });
    if (existing) return existing;

    return db.Agent.create({
      publicId,
      projectId,
      aiProviderId,
      name: `Agent ${publicId}`,
    });
  };

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'Generations Lib Test' });
    projectId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Generations Provider',
      provider: 'openai',
      defaultModel: 'gpt-4o-mini',
      baseUrl: null,
      config: null,
      secretId: null,
    });
    aiProviderId = aiProvider.id;

    await ensureAgent(agentId);
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
      expect(gen.project_id).toBe(projectPublicId);
      expect(gen.agent_id).toBe(agentId);
      expect(gen.trace_id).toBe('trc_gen_create_001');
      expect(gen.completed_at).toBeNull();
      expect(gen.stop_reason).toBeNull();
      expect(gen.last_activity_at).toBeNull();
      expect(gen.initiator_generation_id).toBeNull();
    });

    test('creates a generation with optional initiatorGenerationId', async () => {
      await createGenerationRecord({
        publicId: 'gen_parent_001',
        projectId,
        agentId,
        traceId: 'trc_parent_001',
      });

      const gen = await createGenerationRecord({
        publicId: 'gen_create_test002',
        projectId,
        agentId,
        traceId: 'trc_gen_create_002',
        initiatorGenerationId: 'gen_parent_001',
        startedByPrincipalType: 'user',
        startedByPrincipalId: 'usr_test_001',
      });

      expect(gen.initiator_generation_id).toBe('gen_parent_001');
      expect(gen.started_by_principal_type).toBe('user');
      expect(gen.started_by_principal_id).toBe('usr_test_001');
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
      expect(result?.stop_reason).toBe('stop');
      expect(result?.completed_at).not.toBeNull();
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

      expect(result?.last_activity_at).not.toBeNull();
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
});
