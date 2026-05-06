import { getTrace, listTraces, serializeSteps } from 'src/lib/agentTraces';

describe('listTraces', () => {
  test('returns empty data when projectIds is empty array', async () => {
    const result = await listTraces({ projectIds: [] });
    expect(result).toEqual({ data: [], total: 0, limit: 50, offset: 0 });
  });
});

describe('getTrace', () => {
  test('returns not_found for non-existent trace', async () => {
    const result = await getTrace({ traceId: 'nonexistent' });
    expect(result).toBe('not_found');
  });

  test('returns not_found when projectIds array is empty', async () => {
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
