import {
  getTrace,
  listTraces,
  serializeSteps,
  traces,
} from 'src/lib/agentTraces';

beforeEach(() => {
  traces.clear();
});

describe('listTraces', () => {
  test('returns empty array when no traces', async () => {
    const result = await listTraces({});
    expect(result).toEqual([]);
  });

  test('returns all traces when projectIds is undefined', async () => {
    traces.set('trace-1', {
      id: 'trace-1',
      projectId: 1,
      agentId: 'agent-1',
      status: 'completed',
      createdAt: new Date(),
      steps: [],
    });
    traces.set('trace-2', {
      id: 'trace-2',
      projectId: 2,
      agentId: 'agent-2',
      status: 'completed',
      createdAt: new Date(),
      steps: [],
    });
    const result = await listTraces({});
    expect(result).toHaveLength(2);
  });

  test('filters traces by projectIds when provided', async () => {
    traces.set('trace-1', {
      id: 'trace-1',
      projectId: 1,
      agentId: 'agent-1',
      status: 'completed',
      createdAt: new Date(),
      steps: [],
    });
    traces.set('trace-2', {
      id: 'trace-2',
      projectId: 2,
      agentId: 'agent-2',
      status: 'completed',
      createdAt: new Date(),
      steps: [],
    });
    const result = await listTraces({ projectIds: [1] });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('trace-1');
  });

  test('returns empty array when no traces match projectIds filter', async () => {
    traces.set('trace-1', {
      id: 'trace-1',
      projectId: 1,
      agentId: 'agent-1',
      status: 'completed',
      createdAt: new Date(),
      steps: [],
    });
    const result = await listTraces({ projectIds: [99] });
    expect(result).toEqual([]);
  });

  test('returns multiple traces matching projectIds', async () => {
    traces.set('trace-1', {
      id: 'trace-1',
      projectId: 1,
      agentId: 'agent-1',
      status: 'completed',
      createdAt: new Date(),
      steps: [],
    });
    traces.set('trace-2', {
      id: 'trace-2',
      projectId: 1,
      agentId: 'agent-2',
      status: 'running',
      createdAt: new Date(),
      steps: [],
    });
    traces.set('trace-3', {
      id: 'trace-3',
      projectId: 2,
      agentId: 'agent-3',
      status: 'completed',
      createdAt: new Date(),
      steps: [],
    });
    const result = await listTraces({ projectIds: [1] });
    expect(result).toHaveLength(2);
    expect(
      result.map((t) => {
        return t.id;
      })
    ).toContain('trace-1');
    expect(
      result.map((t) => {
        return t.id;
      })
    ).toContain('trace-2');
  });
});

describe('getTrace', () => {
  test('returns not_found for non-existent trace', async () => {
    const result = await getTrace({ traceId: 'nonexistent' });
    expect(result).toBe('not_found');
  });

  test('returns trace when found and no projectIds filter', async () => {
    const trace = {
      id: 'trace-1',
      projectId: 1,
      agentId: 'agent-1',
      status: 'completed',
      createdAt: new Date(),
      steps: [],
    };
    traces.set('trace-1', trace);
    const result = await getTrace({ traceId: 'trace-1' });
    expect(result).toEqual(trace);
  });

  test('returns trace when found and projectIds matches', async () => {
    const trace = {
      id: 'trace-1',
      projectId: 1,
      agentId: 'agent-1',
      status: 'completed',
      createdAt: new Date(),
      steps: [],
    };
    traces.set('trace-1', trace);
    const result = await getTrace({ traceId: 'trace-1', projectIds: [1] });
    expect(result).toEqual(trace);
  });

  test('returns not_found when projectId does not match filter', async () => {
    traces.set('trace-1', {
      id: 'trace-1',
      projectId: 1,
      agentId: 'agent-1',
      status: 'completed',
      createdAt: new Date(),
      steps: [],
    });
    const result = await getTrace({ traceId: 'trace-1', projectIds: [2] });
    expect(result).toBe('not_found');
  });

  test('returns not_found when projectIds array is empty', async () => {
    traces.set('trace-1', {
      id: 'trace-1',
      projectId: 1,
      agentId: 'agent-1',
      status: 'completed',
      createdAt: new Date(),
      steps: [],
    });
    const result = await getTrace({ traceId: 'trace-1', projectIds: [] });
    expect(result).toBe('not_found');
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
