import { db } from 'src/db';
import { upsertFileByPath } from 'src/lib/files';
import { readFileBuffer } from 'src/lib/fileStorage';
import { createGenerationRecord } from 'src/lib/generations';
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
      generationId: 'gen_test_steps',
      steps: [{ type: 'tool-result', result: 'ok' }],
    });

    const result = await getTrace({ traceId });
    expect(result.id).toBe(traceId);
    expect(result.project_id).toBe(projectPublicId);
    expect(result.agent_id).toBe('agt_trace_lib_001');
    expect(result.step_count).toBe(1);
  });

  // The tool-outputs continuation re-sends every step of the same generation,
  // so its own segment is replaced rather than appended to.
  test('a second save from the same generation replaces its own steps', async () => {
    const traceId = `trc_lib_update_${Date.now()}`;
    await ensureAgent('agt_trace_lib_002');

    await saveTrace({
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_trace_lib_002',
      generationId: 'gen_test_steps',
      steps: [{ type: 'step-1' }],
    });

    await saveTrace({
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_trace_lib_002',
      generationId: 'gen_test_steps',
      steps: [{ type: 'step-1' }, { type: 'step-2' }, { type: 'step-3' }],
    });

    const result = await getTrace({ traceId });
    expect(result.step_count).toBe(3);
  });

  test('saves a trace with empty steps', async () => {
    const traceId = `trc_lib_empty_${Date.now()}`;
    await ensureAgent('agt_trace_lib_003');

    await saveTrace({
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_trace_lib_003',
      generationId: 'gen_test_steps',
      steps: [],
    });

    const result = await getTrace({ traceId });
    expect(result.step_count).toBe(0);
  });

  test('listTraces returns created traces for a given projectId', async () => {
    const traceId = `trc_lib_list_${Date.now()}`;
    await ensureAgent('agt_trace_lib_004');

    await saveTrace({
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_trace_lib_004',
      generationId: 'gen_test_steps',
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
      generationId: 'gen_test_steps',
      steps: [],
    });

    const result = await getTrace({ traceId, projectIds: [projectId] });
    expect(result.id).toBe(traceId);
    expect(result.file_id).toBeDefined();
  });

  test('getTrace returns not_found when projectIds excludes the project', async () => {
    const traceId = `trc_lib_excl_${Date.now()}`;
    await ensureAgent('agt_trace_lib_006');

    await saveTrace({
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_trace_lib_006',
      generationId: 'gen_test_steps',
      steps: [],
    });

    await expect(getTrace({ traceId, projectIds: [99999] })).rejects.toThrow();
  });
});

// #1024: `POST /agents/{agent_id}/generate` accepts a caller-supplied
// `trace_id` to group generations. Each generation owns a segment of the
// trace's steps object, so grouping keeps every turn instead of leaving the
// last writer's steps as the whole trace.
describe('saveTrace groups generations under one trace_id', () => {
  let projectId: number;
  let projectPublicId: string;
  let agentPublicId: string;

  const readSteps = async (traceId: string): Promise<string> => {
    const trace = await db.Trace.findOne({ where: { publicId: traceId } });
    const file = await db.File.findOne({ where: { id: trace?.fileId } });
    const buffer = await readFileBuffer({
      storagePath: file?.storagePath ?? '',
      storageType: file?.storageType ?? 'local',
    });
    return buffer?.toString('utf8') ?? '';
  };

  const generate = async (args: { traceId: string; generationId: string }) => {
    await createGenerationRecord({
      publicId: args.generationId,
      projectId,
      agentId: agentPublicId,
      traceId: args.traceId,
    });
  };

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'Trace Grouping' });
    projectId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Grouping Provider',
      provider: 'openai',
      defaultModel: 'gpt-4o-mini',
      baseUrl: null,
      config: null,
      secretId: null,
    });

    const agent = await db.Agent.create({
      publicId: 'agt_grouping',
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Grouping Agent',
    });
    agentPublicId = agent.publicId;
  });

  test('keeps the first generation steps when a second one reuses the trace', async () => {
    const traceId = `trc_group_${Date.now()}`;
    const common = {
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_grouping',
    };

    await generate({ traceId, generationId: 'gen_group_a' });
    await saveTrace({
      ...common,
      generationId: 'gen_group_a',
      steps: [
        { content: [{ type: 'text', text: 'GEN_A_STEP_1' }] },
        { content: [{ type: 'text', text: 'GEN_A_STEP_2' }] },
      ],
    });

    await generate({ traceId, generationId: 'gen_group_b' });
    await saveTrace({
      ...common,
      generationId: 'gen_group_b',
      steps: [{ content: [{ type: 'text', text: 'GEN_B_STEP_1' }] }],
    });

    const trace = await getTrace({ traceId });
    const content = await readSteps(traceId);

    expect(trace.step_count).toBe(3);
    expect(content).toContain('GEN_A_STEP_1');
    expect(content).toContain('GEN_A_STEP_2');
    expect(content).toContain('GEN_B_STEP_1');
    expect(content.indexOf('GEN_A_STEP_1')).toBeLessThan(
      content.indexOf('GEN_B_STEP_1')
    );
  });

  test('a resumed generation rewrites its own segment, in place', async () => {
    const traceId = `trc_group_resume_${Date.now()}`;
    const common = {
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_grouping',
    };

    await generate({ traceId, generationId: 'gen_resume_a' });
    await saveTrace({
      ...common,
      generationId: 'gen_resume_a',
      steps: [{ content: [{ type: 'text', text: 'A_1' }] }],
    });

    await generate({ traceId, generationId: 'gen_resume_b' });
    await saveTrace({
      ...common,
      generationId: 'gen_resume_b',
      steps: [{ content: [{ type: 'text', text: 'B_1' }] }],
    });

    // A resumes after its client tool: it re-sends A_1 plus the new step.
    await saveTrace({
      ...common,
      generationId: 'gen_resume_a',
      steps: [
        { content: [{ type: 'text', text: 'A_1' }] },
        { content: [{ type: 'text', text: 'A_2' }] },
      ],
    });

    const trace = await getTrace({ traceId });
    const steps = JSON.parse(await readSteps(traceId)) as Array<{
      content: Array<{ text: string }>;
    }>;

    expect(trace.step_count).toBe(3);
    expect(
      steps.map((step) => {
        return step.content[0].text;
      })
    ).toEqual(['A_1', 'A_2', 'B_1']);
  });

  // A trace whose object predates the segment index cannot have its steps
  // attributed, so the next write replaces them — the behaviour before this
  // change — and indexes the trace from there.
  test('replaces an unindexed steps object, then groups normally', async () => {
    const traceId = `trc_group_legacy_${Date.now()}`;
    const common = {
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_grouping',
    };

    await generate({ traceId, generationId: 'gen_legacy_a' });
    await saveTrace({
      ...common,
      generationId: 'gen_legacy_a',
      steps: [{ content: [{ type: 'text', text: 'LEGACY_1' }] }],
    });

    // Drop the index the way an upgrade from a pre-segment release leaves it.
    await db.Trace.update(
      { stepSegments: [] },
      { where: { publicId: traceId } }
    );

    await generate({ traceId, generationId: 'gen_legacy_b' });
    await saveTrace({
      ...common,
      generationId: 'gen_legacy_b',
      steps: [{ content: [{ type: 'text', text: 'AFTER_1' }] }],
    });

    expect((await getTrace({ traceId })).step_count).toBe(1);
    expect(await readSteps(traceId)).not.toContain('LEGACY_1');

    // Indexed again: a third generation now groups instead of replacing.
    await generate({ traceId, generationId: 'gen_legacy_c' });
    await saveTrace({
      ...common,
      generationId: 'gen_legacy_c',
      steps: [{ content: [{ type: 'text', text: 'AFTER_2' }] }],
    });

    expect((await getTrace({ traceId })).step_count).toBe(2);
    expect(await readSteps(traceId)).toContain('AFTER_1');
  });

  test('starts the object over when the stored bytes are not a steps array', async () => {
    const traceId = `trc_group_corrupt_${Date.now()}`;
    const common = {
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_grouping',
    };

    await generate({ traceId, generationId: 'gen_corrupt_a' });
    await saveTrace({
      ...common,
      generationId: 'gen_corrupt_a',
      steps: [{ content: [{ type: 'text', text: 'CORRUPT_1' }] }],
    });

    await upsertFileByPath({
      projectId,
      projectPublicId,
      path: `/traces/${traceId}.json`,
      fileBuffer: Buffer.from('{ not json', 'utf8'),
      contentType: 'application/json',
    });

    await generate({ traceId, generationId: 'gen_corrupt_b' });
    await saveTrace({
      ...common,
      generationId: 'gen_corrupt_b',
      steps: [{ content: [{ type: 'text', text: 'CORRUPT_2' }] }],
    });

    expect((await getTrace({ traceId })).step_count).toBe(1);
    expect(await readSteps(traceId)).toContain('CORRUPT_2');
  });

  test('concurrent saves on one trace keep both generations', async () => {
    const traceId = `trc_group_race_${Date.now()}`;
    const common = {
      traceId,
      projectId,
      projectPublicId,
      agentId: 'agt_grouping',
    };

    await generate({ traceId, generationId: 'gen_race_a' });
    await generate({ traceId, generationId: 'gen_race_b' });

    await Promise.all([
      saveTrace({
        ...common,
        generationId: 'gen_race_a',
        steps: [{ content: [{ type: 'text', text: 'RACE_A' }] }],
      }),
      saveTrace({
        ...common,
        generationId: 'gen_race_b',
        steps: [{ content: [{ type: 'text', text: 'RACE_B' }] }],
      }),
    ]);

    const trace = await getTrace({ traceId });
    const content = await readSteps(traceId);

    expect(trace.step_count).toBe(2);
    expect(content).toContain('RACE_A');
    expect(content).toContain('RACE_B');
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
      url: string;
      method: string;
      constructor(
        message: string,
        status: number,
        body: string,
        url: string,
        method: string
      ) {
        super(message);
        this.name = 'CustomError';
        this.status = status;
        this.body = body;
        this.url = url;
        this.method = method;
      }
    }
    const error = new CustomError(
      'HTTP 401 PATCH https://example.com/items/1: Denied',
      401,
      'Denied',
      'https://example.com/items/1',
      'PATCH'
    );
    const steps = [{ type: 'tool-error', error }];
    const serialized = serializeSteps(steps) as Array<{
      type: string;
      error: {
        message: string;
        name: string;
        status: number;
        body: string;
        url: string;
        method: string;
      };
    }>;
    expect(serialized[0].error.message).toContain('HTTP 401');
    expect(serialized[0].error.name).toBe('CustomError');
    expect(serialized[0].error.status).toBe(401);
    expect(serialized[0].error.body).toBe('Denied');
    expect(serialized[0].error.url).toBe('https://example.com/items/1');
    expect(serialized[0].error.method).toBe('PATCH');
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
