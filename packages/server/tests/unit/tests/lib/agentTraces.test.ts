import { db } from 'src/db';
import {
  getTrace,
  listTraces,
  saveTrace,
  serializeSteps,
} from 'src/lib/traces';

describe('listTraces', () => {
  test('returns empty data when projectIds is empty array', async () => {
    const result = await listTraces({ projectIds: [] });
    expect(result).toEqual({ data: [], total: 0, limit: 50, offset: 0 });
  });

  test('returns all traces when no projectIds filter is provided', async () => {
    const result = await listTraces({});
    expect(typeof result.total).toBe('number');
    expect(Array.isArray(result.data)).toBe(true);
  });
});

describe('getTrace', () => {
  test('throws for non-existent trace', async () => {
    await expect(getTrace({ traceId: 'nonexistent' })).rejects.toThrow();
  });

  test('throws when projectIds array is empty', async () => {
    await expect(
      getTrace({ traceId: 'trace-1', projectIds: [] })
    ).rejects.toThrow();
  });
});

describe('saveTrace and upsertTraceRecord', () => {
  let projectId: number;
  let projectPublicId: string;
  let aiProviderId: number;

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
    const project = await db.Project.create({ name: 'Traces Lib Test' });
    projectId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Traces Provider',
      provider: 'openai',
      defaultModel: 'gpt-4o-mini',
      baseUrl: null,
      config: null,
      secretId: null,
    });
    aiProviderId = aiProvider.id;
  });

  test('creates a new Trace row on first save', async () => {
    const traceId = `trc_lib_create_${Date.now()}`;
    await ensureAgent('agt_trace_lib_001');

    await saveTrace({
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_trace_lib_001',
      steps: [{ type: 'tool-result', result: 'ok' }],
    });

    const result = await getTrace({ traceId });
    expect(result.id).toBe(traceId);
    expect(result.projectId).toBe(projectPublicId);
    expect(result.agentId).toBe('agt_trace_lib_001');
    expect(result.stepCount).toBe(1);
  });

  test('updates an existing Trace row on second save', async () => {
    const traceId = `trc_lib_update_${Date.now()}`;
    await ensureAgent('agt_trace_lib_002');

    await saveTrace({
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_trace_lib_002',
      steps: [{ type: 'step-1' }],
    });

    await saveTrace({
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_trace_lib_002',
      steps: [{ type: 'step-1' }, { type: 'step-2' }, { type: 'step-3' }],
    });

    const result = await getTrace({ traceId });
    expect(result.stepCount).toBe(3);
  });

  test('saves a trace with empty steps', async () => {
    const traceId = `trc_lib_empty_${Date.now()}`;
    await ensureAgent('agt_trace_lib_003');

    await saveTrace({
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_trace_lib_003',
      steps: [],
    });

    const result = await getTrace({ traceId });
    expect(result.stepCount).toBe(0);
  });

  test('listTraces returns created traces for a given projectId', async () => {
    const traceId = `trc_lib_list_${Date.now()}`;
    await ensureAgent('agt_trace_lib_004');

    await saveTrace({
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_trace_lib_004',
      steps: [{ type: 'step' }],
    });

    const result = await listTraces({ projectIds: [projectId] });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(
      result.data.some((t) => {
        return t.id === traceId;
      })
    ).toBe(true);
  });

  test('getTrace returns trace when projectIds includes the project', async () => {
    const traceId = `trc_lib_get_${Date.now()}`;
    await ensureAgent('agt_trace_lib_005');

    await saveTrace({
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_trace_lib_005',
      steps: [],
    });

    const result = await getTrace({ traceId, projectIds: [projectId] });
    expect(result.id).toBe(traceId);
    expect(result.fileId).toBeDefined();
  });

  test('getTrace returns not_found when projectIds excludes the project', async () => {
    const traceId = `trc_lib_excl_${Date.now()}`;
    await ensureAgent('agt_trace_lib_006');

    await saveTrace({
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_trace_lib_006',
      steps: [],
    });

    await expect(getTrace({ traceId, projectIds: [99999] })).rejects.toThrow();
  });
});

describe('serializeSteps', () => {
  test('returns steps unchanged when there are no Error objects', () => {
    const steps = [
      { type: 'tool-result', toolCallId: 'call_1', result: { ok: true } },
    ];
    expect(serializeSteps(steps)).toEqual(steps);
  });

  test('converts Error objects to plain objects with message and name', () => {
    const error = new Error('Something went wrong');
    const steps = [{ type: 'tool-error', error }];
    const serialized = serializeSteps(steps) as Array<{
      type: string;
      error: { message: string; name: string };
    }>;
    expect(serialized[0].error.message).toBe('Something went wrong');
    expect(serialized[0].error.name).toBe('Error');
  });

  test('preserves custom enumerable properties on Error subclasses', () => {
    class CustomError extends Error {
      status: number;
      body: string;
      constructor(message: string, status: number, body: string) {
        super(message);
        this.name = 'CustomError';
        this.status = status;
        this.body = body;
      }
    }
    const error = new CustomError('HTTP 401: Denied', 401, 'Denied');
    const steps = [{ type: 'tool-error', error }];
    const serialized = serializeSteps(steps) as Array<{
      type: string;
      error: { message: string; name: string; status: number; body: string };
    }>;
    expect(serialized[0].error.message).toBe('HTTP 401: Denied');
    expect(serialized[0].error.name).toBe('CustomError');
    expect(serialized[0].error.status).toBe(401);
    expect(serialized[0].error.body).toBe('Denied');
  });

  test('handles nested Error objects', () => {
    const error = new Error('nested error');
    const steps = [{ type: 'step', nested: { inner: error } }];
    const serialized = serializeSteps(steps) as Array<{
      type: string;
      nested: { inner: { message: string } };
    }>;
    expect(serialized[0].nested.inner.message).toBe('nested error');
  });

  test('returns empty array for empty input', () => {
    expect(serializeSteps([])).toEqual([]);
  });
});
